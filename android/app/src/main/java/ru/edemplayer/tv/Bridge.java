package ru.edemplayer.tv;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NoRouteToHostException;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.SSLException;

/**
 * Мост JS → Android (объект AndroidNative). Асинхронные методы получают id и отвечают через MainActivity.reply.
 * Обёртка js/native-android.js превращает его в window.native с тем же API, что у Electron.
 */
public class Bridge {
    final MainActivity a;
    final ExecutorService pool = Executors.newCachedThreadPool();

    Bridge(MainActivity a) { this.a = a; }

    static String err(String msg) {
        try { return new JSONObject().put("__err", msg).toString(); } catch (Exception e) { return "{\"__err\":\"error\"}"; }
    }

    void toast(final String s) {
        a.ui.post(new Runnable() { @Override public void run() { Toast.makeText(a, s, Toast.LENGTH_LONG).show(); } });
    }

    @JavascriptInterface public String platform() { return "android"; }

    @JavascriptInterface public void quit() { a.ui.post(new Runnable() { @Override public void run() { a.finish(); } }); }

    // Внешний плеер (VLC, MX Player…) — системный выбор приложения для видео
    @JavascriptInterface
    public boolean openExternal(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(Uri.parse(url), "video/*");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (i.resolveActivity(a.getPackageManager()) == null) return false;
            a.startActivity(Intent.createChooser(i, "Открыть в плеере").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return true;
        } catch (Exception e) { return false; }
    }

    @JavascriptInterface
    public void openUrl(String url) {
        try { a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
        catch (ActivityNotFoundException e) { toast("Откройте в браузере: " + url); }
    }

    // ---------- HTTP без CORS: { url, method, headers, body, timeout } → { status, type, text, ms } | { error, message } ----------
    @JavascriptInterface
    public void http(final String id, final String json) {
        pool.execute(new Runnable() { @Override public void run() { a.reply(id, request(json)); } });
    }

    static String request(String json) {
        long t0 = System.currentTimeMillis();
        try {
            JSONObject o = new JSONObject(json);
            String url = o.getString("url"), method = o.optString("method", "GET");
            String body = o.has("body") && !o.isNull("body") ? o.getString("body") : null;
            int timeout = o.optInt("timeout", 25000);
            JSONObject hdr = o.optJSONObject("headers");
            for (int hop = 0; hop < 6; hop++) {
              try {
                HttpURLConnection c = Doh.open(url);
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(Math.min(timeout, 15000));
                c.setReadTimeout(timeout);
                c.setRequestMethod(method);
                c.setRequestProperty("Accept", "*/*");
                if (hdr != null) for (Iterator<String> it = hdr.keys(); it.hasNext(); ) { String k = it.next(); c.setRequestProperty(k, hdr.getString(k)); }
                if (body != null && !"GET".equals(method)) {
                    c.setDoOutput(true);
                    byte[] b = body.getBytes(StandardCharsets.UTF_8);
                    c.setFixedLengthStreamingMode(b.length);
                    OutputStream os = c.getOutputStream(); os.write(b); os.close();
                }
                int st = c.getResponseCode();
                if (st >= 300 && st < 400 && c.getHeaderField("Location") != null) {
                    url = new URL(new URL(url), c.getHeaderField("Location")).toString();
                    if (st != 307 && st != 308) { method = "GET"; body = null; }
                    c.disconnect();
                    continue;
                }
                InputStream is = st >= 400 ? c.getErrorStream() : c.getInputStream();
                String text = is == null ? "" : readAll(is);
                String type = c.getContentType();
                c.disconnect();
                return new JSONObject().put("status", st).put("type", type == null ? "" : type).put("text", text)
                        .put("ms", System.currentTimeMillis() - t0).toString();
              } catch (UnknownHostException e) {
                // системный DNS не нашёл сервер — повторить через защищённый DNS
                if (Doh.mark(new URL(url).getHost())) { hop--; continue; }
                throw e;
              }
            }
            return fail("ERR", "too many redirects", t0);
        } catch (UnknownHostException e) { return fail("ENOTFOUND", e.getMessage(), t0); }
        catch (ConnectException e) { return fail(String.valueOf(e.getMessage()).contains("refused") ? "ECONNREFUSED" : "ECONNRESET", e.getMessage(), t0); }
        catch (SocketTimeoutException e) { return fail("TIMEOUT", e.getMessage(), t0); }
        catch (NoRouteToHostException e) { return fail("EHOSTUNREACH", e.getMessage(), t0); }
        catch (SSLException e) { return fail("TLS", e.getMessage(), t0); }
        catch (Exception e) { return fail("ERR", e.getClass().getSimpleName() + ": " + e.getMessage(), t0); }
    }

    /** Прокси для фонового загрузчика: GET с переходами, ответ потоком и с разрешающими CORS-заголовками. */
    static android.webkit.WebResourceResponse proxy(String url) { return proxy(url, null); }

    /** То же для запросов страницы к доменам, которые идут через защищённый DNS (видео, плейлисты): с их заголовками. */
    static android.webkit.WebResourceResponse proxy(String url, java.util.Map<String, String> rq) {
        java.util.Map<String, String> h = new java.util.HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Cache-Control", "no-store");
        try {
            for (int hop = 0; hop < 6; hop++) {
                HttpURLConnection c;
                try { c = Doh.open(url); } catch (UnknownHostException e) { if (Doh.mark(new URL(url).getHost())) { hop--; continue; } throw e; }
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(20000); c.setReadTimeout(60000);
                c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) EdemPlayer");
                c.setRequestProperty("Accept-Encoding", "identity"); // gzip-файлы распаковывает сам загрузчик
                if (rq != null) for (java.util.Map.Entry<String, String> e : rq.entrySet()) {
                    String k = e.getKey();
                    if (k == null || k.equalsIgnoreCase("Host") || k.equalsIgnoreCase("Accept-Encoding") || k.equalsIgnoreCase("Origin")) continue;
                    c.setRequestProperty(k, e.getValue());
                }
                int st;
                try { st = c.getResponseCode(); } catch (UnknownHostException e) { if (Doh.mark(new URL(url).getHost())) { hop--; continue; } throw e; }
                if (rq != null) for (java.util.Map.Entry<String, java.util.List<String>> e : c.getHeaderFields().entrySet()) {
                    String k = e.getKey();
                    if (k == null || e.getValue() == null || e.getValue().isEmpty() || k.equalsIgnoreCase("Content-Encoding") || k.equalsIgnoreCase("Transfer-Encoding") || k.toLowerCase().startsWith("access-control")) continue;
                    h.put(k, e.getValue().get(0));
                }
                if (st >= 300 && st < 400 && c.getHeaderField("Location") != null) {
                    url = new URL(new URL(url), c.getHeaderField("Location")).toString(); c.disconnect(); continue;
                }
                InputStream is = st >= 400 ? c.getErrorStream() : c.getInputStream();
                if (is == null) is = new java.io.ByteArrayInputStream(new byte[0]);
                String ct = c.getContentType();
                String mime = ct == null ? "application/octet-stream" : ct.split(";")[0].trim();
                String reason = c.getResponseMessage();
                return new android.webkit.WebResourceResponse(mime, null, st, reason == null || reason.isEmpty() ? "OK" : reason, h, is);
            }
            return new android.webkit.WebResourceResponse("text/plain", "utf-8", 508, "Loop", h, new java.io.ByteArrayInputStream("too many redirects".getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            String m = e.getClass().getSimpleName() + ": " + e.getMessage();
            return new android.webkit.WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway", h, new java.io.ByteArrayInputStream(m.getBytes(StandardCharsets.UTF_8)));
        }
    }

    static String fail(String code, String msg, long t0) {
        try { return new JSONObject().put("error", code).put("message", msg == null ? "" : msg).put("ms", System.currentTimeMillis() - t0).toString(); }
        catch (Exception e) { return "{\"error\":\"ERR\"}"; }
    }

    static String readAll(InputStream is) throws java.io.IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        for (int n; (n = is.read(buf)) > 0; ) bo.write(buf, 0, n);
        is.close();
        return new String(bo.toByteArray(), StandardCharsets.UTF_8);
    }

    // ---------- проверка сети по шагам: прокси, DNS, TCP ----------
    @JavascriptInterface
    public void netDiag(final String id, final String url) {
        pool.execute(new Runnable() { @Override public void run() {
            JSONObject o = new JSONObject();
            try {
                URL u = new URL(url);
                int port = u.getPort() > 0 ? u.getPort() : u.getDefaultPort();
                o.put("host", u.getHost()).put("port", port);
                String ph = System.getProperty("http.proxyHost");
                o.put("proxy", ph == null || ph.isEmpty() ? "DIRECT" : "PROXY " + ph + ":" + System.getProperty("http.proxyPort"));
                o.put("mode", Doh.mode);
                String host = u.getHost();
                long t0 = System.currentTimeMillis();
                InetAddress[] ips = null;
                JSONObject tcp = null;
                try { ips = InetAddress.getAllByName(host); }
                catch (UnknownHostException e) {
                    o.put("dns", new JSONObject().put("ok", false).put("code", "ENOTFOUND").put("ms", System.currentTimeMillis() - t0));
                }
                if (ips != null) {
                    org.json.JSONArray arr = new org.json.JSONArray();
                    for (InetAddress ip : ips) arr.put(ip.getHostAddress());
                    o.put("dns", new JSONObject().put("ok", true).put("ips", arr).put("ms", System.currentTimeMillis() - t0));
                    tcp = tcpTest(ips[0].getHostAddress(), port);
                    o.put("tcp", tcp);
                }
                // системный DNS не нашёл адрес или сервер не отвечает — спросить защищённый DNS
                if (!Doh.isIp(host) && (ips == null || !tcp.optBoolean("ok"))) {
                    t0 = System.currentTimeMillis();
                    try {
                        Doh.forget(host);
                        Object[] r = Doh.resolve(host);
                        @SuppressWarnings("unchecked") java.util.List<String> l = (java.util.List<String>) r[0];
                        JSONObject d = new JSONObject().put("ok", true).put("ips", new org.json.JSONArray(l)).put("via", r[1]).put("ms", System.currentTimeMillis() - t0);
                        if (ips == null || !l.get(0).equals(ips[0].getHostAddress())) {
                            JSONObject t2 = tcpTest(l.get(0), port);
                            d.put("tcp", t2);
                            if (ips == null && t2.optBoolean("ok")) Doh.mark(host);
                        }
                        o.put("doh", d);
                    } catch (Exception e) {
                        o.put("doh", new JSONObject().put("ok", false).put("code", String.valueOf(e.getMessage())).put("ms", System.currentTimeMillis() - t0));
                    }
                }
                a.reply(id, o.toString());
            } catch (Exception e) { a.reply(id, err(String.valueOf(e.getMessage()))); }
        } });
    }

    static JSONObject tcpTest(String ip, int port) throws org.json.JSONException {
        long t0 = System.currentTimeMillis();
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress(ip, port), 8000);
            return new JSONObject().put("ok", true).put("ms", System.currentTimeMillis() - t0);
        } catch (SocketTimeoutException e) {
            return new JSONObject().put("ok", false).put("code", "TIMEOUT").put("ms", System.currentTimeMillis() - t0);
        } catch (Exception e) {
            return new JSONObject().put("ok", false).put("code", e.getClass().getSimpleName()).put("ms", System.currentTimeMillis() - t0);
        } finally { try { s.close(); } catch (Exception e) { /* */ } }
    }

    // режим защищённого DNS: auto | on | off
    @JavascriptInterface
    public void setDns(String m) { Doh.mode = "on".equals(m) || "off".equals(m) ? m : "auto"; }

    // ---------- голосовой ввод (системное распознавание) ----------
    @JavascriptInterface
    public void speech(final String id, final String lang) {
        a.ui.post(new Runnable() { @Override public void run() { a.startSpeech(id, lang); } });
    }

    @JavascriptInterface
    public void speechStop() { a.ui.post(new Runnable() { @Override public void run() { a.stopSpeech(); } }); }

    // ---------- сохранение файла настроек (системный диалог «Сохранить как») ----------
    @JavascriptInterface
    public void saveFile(final String id, final String name, final String text) {
        a.ui.post(new Runnable() { @Override public void run() { a.saveFile(id, name, text); } });
    }

    // ---------- буфер обмена ----------
    @JavascriptInterface
    public void clipRead(final String id) {
        a.ui.post(new Runnable() { @Override public void run() {
            String t = "";
            try {
                android.content.ClipboardManager cm = (android.content.ClipboardManager) a.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
                if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip().getItemCount() > 0) {
                    CharSequence cs = cm.getPrimaryClip().getItemAt(0).coerceToText(a);
                    if (cs != null) t = cs.toString();
                }
            } catch (Exception e) { /* */ }
            try { a.reply(id, new JSONObject().put("text", t).toString()); } catch (Exception e) { a.reply(id, "{\"text\":\"\"}"); }
        } });
    }

    @JavascriptInterface
    public void clipWrite(final String text) {
        a.ui.post(new Runnable() { @Override public void run() {
            try {
                android.content.ClipboardManager cm = (android.content.ClipboardManager) a.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(android.content.ClipData.newPlainText("EdemPlayer", text));
            } catch (Exception e) { /* */ }
        } });
    }

    // ---------- обновления интерфейса ----------
    @JavascriptInterface public String updInfo() { return a.updater.info(); }

    @JavascriptInterface
    public void updCheck(final String id) {
        pool.execute(new Runnable() { @Override public void run() { a.reply(id, a.updater.check(true)); } });
    }

    @JavascriptInterface public void updRestart() { a.reloadUi(); }
}
