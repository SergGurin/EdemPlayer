package ru.edemplayer.tv;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognizerIntent;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;

/**
 * Окно EdemPlayer для Android TV / проекторов: полноэкранный WebView с интерфейсом из папки www
 * (общий с Windows-версией) и мостом AndroidNative → window.native.
 */
public class MainActivity extends Activity {
    static final String TAG = "EdemPlayer";
    static final int REQ_SPEECH = 101, REQ_FILE = 102, REQ_SAVE = 103;

    WebView web;
    Updater updater;
    Bridge bridge;
    final Handler ui = new Handler(Looper.getMainLooper());

    // ожидающие ответы системных окон
    String speechCb;
    ValueCallback<Uri[]> fileCb;
    String saveCb, saveText;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // удалённая отладка (chrome://inspect) — только в отладочной сборке: в рабочей не должно быть доступа к данным
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        updater = new Updater(this);
        updater.prepare(); // готовое обновление интерфейса — подменить до загрузки

        web = new WebView(this);
        web.setBackgroundColor(0xFF070A12);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // страница с file://: доступ к любым адресам без CORS (потоки, EPG, медиатека)
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setTextZoom(100);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        bridge = new Bridge(this);
        web.addJavascriptInterface(bridge, "AndroidNative");

        web.setWebViewClient(new WebViewClient() {
            // запросы фонового загрузчика (программа передач): https://edp.local/proxy?u=<адрес> → сеть приложения, без CORS
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("edp.local".equals(u.getHost()) && "/proxy".equals(u.getPath())) return Bridge.proxy(u.getQueryParameter("u"));
                return null;
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("file".equals(u.getScheme())) return false;
                // внешние ссылки — в системный браузер
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* */ }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // сообщения консоли в журнал устройства не пишем: там могут оказаться адреса с личными ключами
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) { return true; }
            // <input type=file>: файл плейлиста, импорт настроек
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try { startActivityForResult(Intent.createChooser(i, "EdemPlayer"), REQ_FILE); }
                catch (ActivityNotFoundException e) { fileCb = null; cb.onReceiveValue(null); bridge.toast("Нет приложения для выбора файлов"); }
                return true;
            }
        });

        web.loadUrl(updater.rootUrl());
        web.requestFocus();

        // проверка обновлений интерфейса: через 20 с после запуска и раз в 6 часов
        ui.postDelayed(new Runnable() {
            @Override public void run() { updater.check(false); ui.postDelayed(this, 6L * 3600 * 1000); }
        }, 20000);
    }

    /** Ответ на асинхронный вызов из JS. */
    void reply(final String id, final String json) {
        ui.post(new Runnable() {
            @Override public void run() {
                if (web != null) web.evaluateJavascript("window.__nativeCb&&window.__nativeCb(" + JSONObject.quote(id) + "," + JSONObject.quote(json) + ")", null);
            }
        });
    }

    void js(final String code) {
        ui.post(new Runnable() { @Override public void run() { if (web != null) web.evaluateJavascript(code, null); } });
    }

    /** Перезагрузить интерфейс из новой копии (после обновления). */
    void reloadUi() {
        ui.post(new Runnable() { @Override public void run() { updater.prepare(); web.loadUrl(updater.rootUrl()); } });
    }

    // «Назад» на пульте — в интерфейс (там стек экранов и вопрос о выходе)
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        if (k == KeyEvent.KEYCODE_BACK || k == KeyEvent.KEYCODE_ESCAPE) {
            if (e.getAction() == KeyEvent.ACTION_UP && e.getRepeatCount() == 0) {
                web.evaluateJavascript("(function(){try{return window.__nativeBack?window.__nativeBack():false}catch(e){return true}})()", new ValueCallback<String>() {
                    // интерфейс не ответил — спросить здесь, не закрывать молча
                    @Override public void onReceiveValue(String v) { if (!"true".equals(v)) askExit(); }
                });
            }
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    void askExit() {
        new android.app.AlertDialog.Builder(this)
                .setMessage("Выйти из EdemPlayer?")
                .setPositiveButton("Выйти", new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface d, int w) { finish(); }
                })
                .setNegativeButton("Остаться", null)
                .show();
    }

    @Override
    public void onWindowFocusChanged(boolean has) {
        super.onWindowFocusChanged(has);
        if (has) immersive();
    }

    void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override protected void onPause() { super.onPause(); if (web != null) web.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); immersive(); }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }

    // ---------- системные окна: голос, выбор файла, сохранение файла ----------
    void startSpeech(String id, String lang) {
        if (speechCb != null) reply(speechCb, "{\"text\":\"\"}");
        speechCb = id;
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        i.putExtra(RecognizerIntent.EXTRA_PROMPT, "Скажите название канала или передачи");
        try { startActivityForResult(i, REQ_SPEECH); }
        catch (ActivityNotFoundException e) { speechCb = null; reply(id, Bridge.err("на устройстве нет распознавания речи")); }
    }

    void stopSpeech() {
        try { finishActivity(REQ_SPEECH); } catch (Exception e) { /* */ }
    }

    void saveFile(String id, String name, String text) {
        saveCb = id; saveText = text;
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("application/json");
        i.putExtra(Intent.EXTRA_TITLE, name);
        try { startActivityForResult(i, REQ_SAVE); }
        catch (ActivityNotFoundException e) { saveCb = null; saveText = null; reply(id, Bridge.err("нет приложения для сохранения файлов")); }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_SPEECH) {
            String id = speechCb; speechCb = null;
            if (id == null) return;
            String text = "";
            if (res == RESULT_OK && data != null) {
                ArrayList<String> l = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
                if (l != null && !l.isEmpty()) text = l.get(0);
            }
            try { reply(id, new JSONObject().put("text", text).toString()); } catch (Exception e) { reply(id, "{\"text\":\"\"}"); }
        } else if (req == REQ_FILE) {
            ValueCallback<Uri[]> cb = fileCb; fileCb = null;
            if (cb == null) return;
            Uri u = (res == RESULT_OK && data != null) ? data.getData() : null;
            cb.onReceiveValue(u != null ? new Uri[]{u} : null);
        } else if (req == REQ_SAVE) {
            String id = saveCb, text = saveText; saveCb = null; saveText = null;
            if (id == null) return;
            Uri u = (res == RESULT_OK && data != null) ? data.getData() : null;
            if (u == null) { reply(id, Bridge.err("отменено")); return; }
            try {
                OutputStream os = getContentResolver().openOutputStream(u);
                os.write(text.getBytes(StandardCharsets.UTF_8));
                os.close();
                reply(id, new JSONObject().put("ok", true).put("name", String.valueOf(u.getLastPathSegment())).toString());
            } catch (Exception e) { reply(id, Bridge.err(String.valueOf(e.getMessage()))); }
        }
    }
}
