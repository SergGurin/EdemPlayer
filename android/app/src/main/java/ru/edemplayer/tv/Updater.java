package ru.edemplayer.tv;

import android.content.res.AssetManager;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * Обновление интерфейса с GitHub (как в Windows-версии, тот же update/manifest.json):
 *  • установленная копия — assets/www из APK; обновлённая — files/app/www;
 *  • новая версия собирается в files/app-next (неизменные файлы копируются, изменённые скачиваются
 *    с проверкой SHA-256) и подменяет прежнюю при перезагрузке интерфейса;
 *  • адреса — по номеру последнего коммита (raw.githubusercontent.com, запасной — jsDelivr), без кэша ветки.
 */
public class Updater {
    static final int SHELL = 1;

    final MainActivity a;
    final File dir, next;
    final String bundled, repo, branch;
    JSONObject status = new JSONObject();
    volatile boolean busy;

    Updater(MainActivity a) {
        this.a = a;
        dir = new File(a.getFilesDir(), "app");
        next = new File(a.getFilesDir(), "app-next");
        String v = "0", r = "", b = "main";
        try {
            JSONObject p = new JSONObject(asset("app.json"));
            v = p.optString("version", "0");
            JSONObject u = p.optJSONObject("edemUpdate");
            if (u != null) { r = u.optString("repo", ""); b = u.optString("branch", "main"); }
        } catch (Exception e) { /* */ }
        bundled = v;
        repo = r.isEmpty() ? "SergGurin/EdemPlayer" : r;
        branch = b;
        try { status.put("state", "idle"); } catch (Exception e) { /* */ }
    }

    // ---------- версии и активная копия ----------
    static int cmp(String x, String y) {
        String[] a = x.split("\\."), b = y.split("\\.");
        for (int i = 0; i < Math.max(a.length, b.length); i++) {
            int p = i < a.length ? toInt(a[i]) : 0, q = i < b.length ? toInt(b[i]) : 0;
            if (p != q) return p > q ? 1 : -1;
        }
        return 0;
    }
    static int toInt(String s) { try { return Integer.parseInt(s.trim()); } catch (Exception e) { return 0; } }

    JSONObject readJson(File f) { try { return new JSONObject(new String(readFile(f), StandardCharsets.UTF_8)); } catch (Exception e) { return null; } }

    boolean updatedActive() {
        JSONObject v = readJson(new File(dir, "version.json"));
        return v != null && v.optBoolean("ready") && v.optInt("shell", 1) <= SHELL
                && cmp(v.optString("version", "0"), bundled) > 0 && new File(dir, "www/index.html").exists();
    }

    String activeVersion() {
        if (!updatedActive()) return bundled;
        JSONObject v = readJson(new File(dir, "version.json"));
        return v == null ? bundled : v.optString("version", bundled);
    }

    /** При запуске: готовая новая копия → подменить прежнюю. */
    void prepare() {
        JSONObject nv = readJson(new File(next, "version.json"));
        if (nv != null && nv.optBoolean("ready") && nv.optInt("shell", 1) <= SHELL) {
            File old = new File(a.getFilesDir(), "app-old");
            rm(old);
            if (dir.exists()) dir.renameTo(old);
            if (!next.renameTo(dir)) old.renameTo(dir);
            rm(old);
        } else if (next.exists()) rm(next);
    }

    String rootUrl() {
        return updatedActive() ? "file://" + new File(dir, "www/index.html").getAbsolutePath() : "file:///android_asset/www/index.html";
    }

    String info() {
        try {
            return new JSONObject().put("app", bundled).put("ui", activeVersion()).put("shell", SHELL)
                    .put("repo", repo).put("status", status).toString();
        } catch (Exception e) { return "{}"; }
    }

    void emit(JSONObject st) {
        status = st;
        a.js("window.__nativeUpd&&window.__nativeUpd(" + JSONObject.quote(st.toString()) + ")");
    }

    // ---------- сеть ----------
    static byte[] get(String url, String accept) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000); c.setReadTimeout(60000);
        c.setRequestProperty("User-Agent", "EdemPlayer-updater");
        c.setRequestProperty("Cache-Control", "no-cache");
        if (accept != null) c.setRequestProperty("Accept", accept);
        int st = c.getResponseCode();
        if (st != 200) { c.disconnect(); throw new Exception("HTTP " + st + " " + new URL(url).getHost()); }
        InputStream is = c.getInputStream();
        byte[] b = readStream(is);
        c.disconnect();
        return b;
    }

    String sha() {
        try {
            String t = new String(get("https://api.github.com/repos/" + repo + "/commits/" + branch, "application/vnd.github.sha"), StandardCharsets.UTF_8).trim();
            return t.matches("[0-9a-f]{40}") ? t : null;
        } catch (Exception e) { return null; }
    }

    List<String> bases(String sha) {
        String ref = sha != null ? sha : branch;
        List<String> l = new ArrayList<>();
        l.add("https://raw.githubusercontent.com/" + repo + "/" + ref);
        l.add("https://cdn.jsdelivr.net/gh/" + repo + "@" + ref);
        return l;
    }

    /** Проверить и скачать обновление. Возвращает состояние (JSON). */
    String check(boolean manual) {
        if (busy) return status.toString();
        busy = true;
        JSONObject st = new JSONObject();
        try {
            emit(new JSONObject().put("state", "checking"));
            String sha = sha();
            JSONObject m = null; String base = null, src = null;
            StringBuilder errs = new StringBuilder();
            for (String b : bases(sha)) {
                try {
                    JSONObject j = new JSONObject(new String(get(b + "/update/manifest.json" + (sha == null ? "?t=" + System.currentTimeMillis() : ""), null), StandardCharsets.UTF_8));
                    if (j.has("version") && j.has("files")) { m = j; base = b; src = new URL(b).getHost() + (sha != null ? " @" + sha.substring(0, 7) : ""); break; }
                } catch (Exception e) { if (errs.length() > 0) errs.append("; "); errs.append(new URL(b).getHost()).append(": ").append(e.getMessage()); }
            }
            if (m == null) throw new Exception(errs.length() > 0 ? errs.toString() : "no update source");
            String ver = m.getString("version");
            st.put("src", src);
            if (errs.length() > 0) st.put("srcErr", errs.toString());
            JSONObject pending = readJson(new File(next, "version.json"));
            if (pending != null && pending.optBoolean("ready") && ver.equals(pending.optString("version"))) {
                emit(st.put("state", "ready").put("version", ver)); return st.toString();
            }
            if (cmp(ver, activeVersion()) <= 0) { emit(st.put("state", "latest").put("version", activeVersion())); return st.toString(); }
            if (m.optInt("shell", 1) > SHELL) { emit(st.put("state", "shell").put("version", ver)); return st.toString(); }

            rm(next);
            JSONObject files = m.getJSONObject("files");
            boolean upd = updatedActive();
            int total = files.length(), done = 0, got = 0;
            for (Iterator<String> it = files.keys(); it.hasNext(); ) {
                String rel = it.next(), want = files.getString(rel);
                if (!rel.startsWith("www/") || rel.contains("..") || rel.startsWith("www/models/")) { done++; continue; }
                File dst = new File(next, rel);
                dst.getParentFile().mkdirs();
                byte[] data = null;
                if (upd) { File f = new File(dir, rel); if (f.exists()) { byte[] b = readFile(f); if (want.equals(hex(b))) data = b; } }
                if (data == null) { try { byte[] b = readStream(a.getAssets().open(rel)); if (want.equals(hex(b))) data = b; } catch (Exception e) { /* нет в APK */ } }
                if (data == null) {
                    StringBuilder path = new StringBuilder();
                    for (String part : rel.split("/")) { if (path.length() > 0) path.append('/'); path.append(java.net.URLEncoder.encode(part, "UTF-8").replace("+", "%20")); }
                    data = get(base + "/" + path, null);
                    if (!want.equals(hex(data))) throw new Exception("checksum " + rel);
                    got++;
                }
                FileOutputStream fo = new FileOutputStream(dst); fo.write(data); fo.close();
                done++;
                if (done % 10 == 0) emit(new JSONObject(st.toString()).put("state", "downloading").put("version", ver).put("progress", done * 100 / total));
            }
            JSONObject vj = new JSONObject().put("version", ver).put("shell", m.optInt("shell", 1)).put("ready", true).put("files", got);
            FileOutputStream fo = new FileOutputStream(new File(next, "version.json")); fo.write(vj.toString().getBytes(StandardCharsets.UTF_8)); fo.close();
            emit(st.put("state", "ready").put("version", ver).put("files", got));
        } catch (Exception e) {
            rm(next);
            try { st.put("state", "error").put("error", String.valueOf(e.getMessage())); } catch (Exception x) { /* */ }
            emit(st);
        } finally { busy = false; }
        return st.toString();
    }

    // ---------- файлы ----------
    String asset(String name) throws Exception {
        AssetManager am = a.getAssets();
        return new String(readStream(am.open(name)), StandardCharsets.UTF_8);
    }

    static byte[] readStream(InputStream is) throws java.io.IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[32768];
        for (int n; (n = is.read(buf)) > 0; ) bo.write(buf, 0, n);
        is.close();
        return bo.toByteArray();
    }

    static byte[] readFile(File f) throws java.io.IOException { return readStream(new FileInputStream(f)); }

    static String hex(byte[] b) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(b);
            StringBuilder s = new StringBuilder();
            for (byte x : d) s.append(String.format("%02x", x));
            return s.toString();
        } catch (Exception e) { return ""; }
    }

    static void rm(File f) {
        if (f == null || !f.exists()) return;
        File[] l = f.listFiles();
        if (l != null) for (File c : l) rm(c);
        f.delete();
    }
}
