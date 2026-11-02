package ru.edemplayer.tv;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.Socket;
import java.net.URL;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Защищённый DNS (DNS-over-HTTPS). Провайдер может блокировать домен только на своём DNS:
 * тогда адрес узнаём у Cloudflare/Google по HTTPS (серверы заданы IP-адресами) и подключаемся к нему напрямую,
 * сохраняя настоящее имя сервера в заголовке Host и в TLS (SNI, проверка сертификата).
 * Режимы: auto — при неудаче системного DNS, on — всегда, off — никогда.
 */
final class Doh {
    static volatile String mode = "auto";
    /** Домены, которые системный DNS не нашёл: дальше они идут через DoH. */
    static final Set<String> hosts = Collections.synchronizedSet(new HashSet<String>());
    private static final Map<String, Object[]> cache = new ConcurrentHashMap<>();
    private static final String[] SERVERS = {
            "https://1.1.1.1/dns-query?type=A&name=",
            "https://8.8.8.8/resolve?type=A&name=",
            "https://9.9.9.9:5053/dns-query?type=A&name="
    };

    private Doh() {}

    static boolean isIp(String h) { return h.matches("[0-9.]+") || h.indexOf(':') >= 0; }

    /** Нужно ли идти к этому домену через DoH. */
    static boolean use(String host) {
        if (host == null || isIp(host) || "off".equals(mode)) return false;
        return "on".equals(mode) || hosts.contains(host);
    }

    /** Отметить домен после неудачи системного DNS (в режиме auto). true — стоит повторить запрос. */
    static boolean mark(String host) {
        if (host == null || isIp(host) || !"auto".equals(mode) || hosts.contains(host)) return false;
        hosts.add(host);
        return true;
    }

    static void forget(String host) { cache.remove(host); }

    /** [List<String> адреса, String сервер] */
    static Object[] resolve(String host) throws UnknownHostException {
        Object[] c = cache.get(host);
        if (c != null && System.currentTimeMillis() - (Long) c[2] < 600000) return c;
        String last = "no answer";
        for (String s : SERVERS) {
            HttpURLConnection con = null;
            try {
                con = (HttpURLConnection) new URL(s + java.net.URLEncoder.encode(host, "UTF-8")).openConnection();
                con.setConnectTimeout(6000); con.setReadTimeout(6000);
                con.setRequestProperty("Accept", "application/dns-json");
                InputStream is = con.getInputStream();
                JSONObject j = new JSONObject(Bridge.readAll(is));
                JSONArray ans = j.optJSONArray("Answer");
                List<String> ips = new ArrayList<>();
                if (ans != null) for (int i = 0; i < ans.length(); i++) {
                    JSONObject a = ans.getJSONObject(i);
                    if (a.optInt("type") == 1) ips.add(a.getString("data"));
                }
                if (!ips.isEmpty()) {
                    Object[] r = new Object[]{ips, new URL(s).getHost(), System.currentTimeMillis()};
                    cache.put(host, r);
                    return r;
                }
                last = j.optInt("Status") == 3 ? "NXDOMAIN" : "NOANSWER";
            } catch (Exception e) { last = e.getClass().getSimpleName(); }
            finally { if (con != null) con.disconnect(); }
        }
        throw new UnknownHostException(host + " (DoH: " + last + ")");
    }

    @SuppressWarnings("unchecked")
    static String first(String host) throws UnknownHostException { return ((List<String>) resolve(host)[0]).get(0); }

    /** Открыть соединение: обычное или к адресу из DoH с сохранением имени сервера. */
    static HttpURLConnection open(String url) throws IOException {
        URL u = new URL(url);
        final String h = u.getHost();
        if (!use(h)) return (HttpURLConnection) u.openConnection();
        String ip = first(h);
        URL iu = new URL(u.getProtocol(), ip, u.getPort(), u.getFile());
        HttpURLConnection c = (HttpURLConnection) iu.openConnection();
        c.setRequestProperty("Host", u.getPort() > 0 ? h + ":" + u.getPort() : h);
        if (c instanceof HttpsURLConnection) {
            HttpsURLConnection hc = (HttpsURLConnection) c;
            hc.setSSLSocketFactory(new Sni(HttpsURLConnection.getDefaultSSLSocketFactory(), h));
            final HostnameVerifier def = HttpsURLConnection.getDefaultHostnameVerifier();
            hc.setHostnameVerifier(new HostnameVerifier() {
                @Override public boolean verify(String s, SSLSession ss) { return def.verify(h, ss); }
            });
        }
        return c;
    }

    /** TLS с настоящим именем сервера (SNI); рукопожатие сразу, чтобы имя не подменилось IP-адресом. */
    static final class Sni extends SSLSocketFactory {
        final SSLSocketFactory d; final String host;
        Sni(SSLSocketFactory d, String host) { this.d = d; this.host = host; }
        private Socket hs(Socket s) throws IOException { if (s instanceof SSLSocket) ((SSLSocket) s).startHandshake(); return s; }
        @Override public String[] getDefaultCipherSuites() { return d.getDefaultCipherSuites(); }
        @Override public String[] getSupportedCipherSuites() { return d.getSupportedCipherSuites(); }
        @Override public Socket createSocket(Socket s, String h, int p, boolean ac) throws IOException { return hs(d.createSocket(s, host, p, ac)); }
        @Override public Socket createSocket(String h, int p) throws IOException { return d.createSocket(h, p); }
        @Override public Socket createSocket(String h, int p, InetAddress la, int lp) throws IOException { return d.createSocket(h, p, la, lp); }
        @Override public Socket createSocket(InetAddress h, int p) throws IOException { return d.createSocket(h, p); }
        @Override public Socket createSocket(InetAddress h, int p, InetAddress la, int lp) throws IOException { return d.createSocket(h, p, la, lp); }
    }
}
