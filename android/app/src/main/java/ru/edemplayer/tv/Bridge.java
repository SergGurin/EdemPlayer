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
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
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
            }
            return fail("ERR", "too many redirects", t0);
        } catch (UnknownHostException e) { return fail("ENOTFOUND", e.getMessage(), t0); }
        catch (ConnectException e) { return fail(String.valueOf(e.getMessage()).contains("refused") ? "ECONNREFUSED" : "ECONNRESET", e.getMessage(), t0); }
        catch (SocketTimeoutException e) { return fail("TIMEOUT", e.getMessage(), t0); }
        catch (NoRouteToHostException e) { return fail("EHOSTUNREACH", e.getMessage(), t0); }
        catch (SSLException e) { return fail("TLS", e.getMessage(), t0); }
        catch (Exception e) { return fail("ERR", e.getClass().getSimpleName() + ": " + e.getMessage(), t0); }
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
                long t0 = System.currentTimeMillis();
                InetAddress[] ips;
                try { ips = InetAddress.getAllByName(u.getHost()); }
                catch (UnknownHostException e) {
                    o.put("dns", new JSONObject().put("ok", false).put("code", "ENOTFOUND").put("ms", System.currentTimeMillis() - t0));
                    a.reply(id, o.toString()); return;
                }
                org.json.JSONArray arr = new org.json.JSONArray();
                for (InetAddress ip : ips) arr.put(ip.getHostAddress());
                o.put("dns", new JSONObject().put("ok", true).put("ips", arr).put("ms", System.currentTimeMillis() - t0));
                t0 = System.currentTimeMillis();
                Socket s = new Socket();
                try {
                    s.connect(new InetSocketAddress(ips[0], port), 8000);
                    o.put("tcp", new JSONObject().put("ok", true).put("ms", System.currentTimeMillis() - t0));
                } catch (SocketTimeoutException e) {
                    o.put("tcp", new JSONObject().put("ok", false).put("code", "TIMEOUT").put("ms", System.currentTimeMillis() - t0));
                } catch (Exception e) {
                    o.put("tcp", new JSONObject().put("ok", false).put("code", e.getClass().getSimpleName()).put("ms", System.currentTimeMillis() - t0));
                } finally { try { s.close(); } catch (Exception e) { /* */ } }
                a.reply(id, o.toString());
            } catch (Exception e) { a.reply(id, err(String.valueOf(e.getMessage()))); }
        } });
    }

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

    // ---------- обновления интерфейса ----------
    @JavascriptInterface public String updInfo() { return a.updater.info(); }

    @JavascriptInterface
    public void updCheck(final String id) {
        pool.execute(new Runnable() { @Override public void run() { a.reply(id, a.updater.check(true)); } });
    }

    @JavascriptInterface public void updRestart() { a.reloadUi(); }
}
