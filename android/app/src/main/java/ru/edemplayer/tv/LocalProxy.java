package ru.edemplayer.tv;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Локальный прокси для видео (только 127.0.0.1): плеер страницы берёт файл или плейлист отсюда,
 * а прокси скачивает его с сервера по адресу из защищённого DNS. Нужен, когда домен медиатеки
 * заблокирован на DNS провайдера: запросы самого видеоэлемента страница не перехватывает.
 * Адрес: http://127.0.0.1:порт/d/<http|https>/<хост[:порт]>/<путь>?<запрос> — относительные ссылки
 * в плейлистах сами указывают сюда же.
 */
final class LocalProxy {
    private static ServerSocket server;
    private static final ExecutorService pool = Executors.newCachedThreadPool();

    private LocalProxy() {}

    static synchronized int port() {
        if (server != null && !server.isClosed()) return server.getLocalPort();
        try {
            server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
            final ServerSocket ss = server;
            pool.execute(new Runnable() { @Override public void run() {
                while (!ss.isClosed()) {
                    try { final Socket s = ss.accept(); pool.execute(new Runnable() { @Override public void run() { serve(s); } }); }
                    catch (Exception e) { /* закрыт */ }
                }
            } });
            return server.getLocalPort();
        } catch (Exception e) { return -1; }
    }

    /** Адрес для плеера: через прокси, если домен идёт через защищённый DNS, иначе исходный. */
    static String wrap(String url) {
        try {
            URL u = new URL(url);
            if (!Doh.use(u.getHost())) return url;
            int p = port();
            if (p < 0) return url;
            String hp = u.getPort() > 0 ? u.getHost() + ":" + u.getPort() : u.getHost();
            return "http://127.0.0.1:" + p + "/d/" + u.getProtocol() + "/" + hp + u.getFile();
        } catch (Exception e) { return url; }
    }

    private static void serve(Socket s) {
        try {
            s.setSoTimeout(60000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();
            String line = readLine(in);
            if (line == null) { s.close(); return; }
            String[] rl = line.split(" ");
            Map<String, String> hdr = new LinkedHashMap<>();
            for (String h; (h = readLine(in)) != null && !h.isEmpty(); ) {
                int i = h.indexOf(':');
                if (i > 0) hdr.put(h.substring(0, i).trim(), h.substring(i + 1).trim());
            }
            String method = rl[0], path = rl.length > 1 ? rl[1] : "/";
            if ("OPTIONS".equals(method)) { head(out, 204, "No Content", null, 0); s.close(); return; }
            if (!path.startsWith("/d/")) { head(out, 404, "Not Found", null, 0); s.close(); return; }
            String rest = path.substring(3);
            int a = rest.indexOf('/');
            String scheme = rest.substring(0, a);
            String target = scheme + "://" + rest.substring(a + 1);
            if (!"http".equals(scheme) && !"https".equals(scheme)) { head(out, 400, "Bad Request", null, 0); s.close(); return; }

            HttpURLConnection c = null;
            String url = target;
            int st = 0;
            for (int hop = 0; hop < 6; hop++) {
                try {
                    c = Doh.open(url);
                    c.setInstanceFollowRedirects(false);
                    c.setConnectTimeout(20000); c.setReadTimeout(60000);
                    c.setRequestMethod("HEAD".equals(method) ? "HEAD" : "GET");
                    c.setRequestProperty("Accept-Encoding", "identity");
                    for (Map.Entry<String, String> e : hdr.entrySet()) {
                        String k = e.getKey().toLowerCase();
                        if (k.equals("range") || k.equals("user-agent") || k.equals("accept") || k.equals("if-range") || k.equals("referer"))
                            c.setRequestProperty(e.getKey(), e.getValue());
                    }
                    st = c.getResponseCode();
                } catch (UnknownHostException e) {
                    if (Doh.mark(new URL(url).getHost())) { hop--; continue; }
                    throw e;
                }
                if (st >= 300 && st < 400 && c.getHeaderField("Location") != null) {
                    url = new URL(new URL(url), c.getHeaderField("Location")).toString();
                    c.disconnect(); c = null;
                    continue;
                }
                break;
            }
            if (c == null) { head(out, 508, "Loop", null, 0); s.close(); return; }
            Map<String, List<String>> rh = c.getHeaderFields();
            StringBuilder sb = new StringBuilder();
            long len = -1;
            for (Map.Entry<String, List<String>> e : rh.entrySet()) {
                String k = e.getKey();
                if (k == null || e.getValue() == null || e.getValue().isEmpty()) continue;
                String kl = k.toLowerCase();
                if (kl.equals("connection") || kl.equals("transfer-encoding") || kl.equals("content-encoding") || kl.startsWith("access-control") || kl.equals("keep-alive")) continue;
                if (kl.equals("content-length")) { try { len = Long.parseLong(e.getValue().get(0)); } catch (Exception x) { /* */ } }
                sb.append(k).append(": ").append(e.getValue().get(0)).append("\r\n");
            }
            String reason = c.getResponseMessage();
            String h = "HTTP/1.1 " + st + " " + (reason == null || reason.isEmpty() ? "OK" : reason) + "\r\n" + sb
                    + "Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n";
            out.write(h.getBytes(StandardCharsets.ISO_8859_1));
            if (!"HEAD".equals(method)) {
                InputStream is = st >= 400 ? c.getErrorStream() : c.getInputStream();
                if (is != null) {
                    byte[] buf = new byte[65536];
                    for (int n; (n = is.read(buf)) > 0; ) out.write(buf, 0, n);
                    is.close();
                }
            }
            out.flush();
            c.disconnect();
        } catch (Exception e) { /* соединение закрыто плеером или ошибка сети */ }
        finally { try { s.close(); } catch (Exception e) { /* */ } }
    }

    private static void head(OutputStream out, int st, String reason, String type, long len) throws java.io.IOException {
        String h = "HTTP/1.1 " + st + " " + reason + "\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nContent-Length: " + len + "\r\nConnection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
    }

    private static String readLine(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int ch;
        while ((ch = in.read()) >= 0) {
            if (ch == '\n') break;
            if (ch != '\r') b.write(ch);
            if (b.size() > 16384) break;
        }
        if (ch < 0 && b.size() == 0) return null;
        return new String(b.toByteArray(), StandardCharsets.ISO_8859_1);
    }
}
