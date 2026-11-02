window.TV = window.TV || {};
(function (TV) {
  'use strict';

  TV.el = function (tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  TV.now = function () { return Date.now() / 1000; };
  var pad = TV.pad = function (n) { return (n < 10 ? '0' : '') + n; };

  TV.fmtTime = function (t) {
    var d = new Date(t * 1000);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  TV.fmtClock = function (sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(s);
  };
  TV.dayStart = function (t) {
    var d = new Date(t * 1000); d.setHours(0, 0, 0, 0); return d.getTime() / 1000;
  };
  TV.addDays = function (dayStartSec, n) {
    var d = new Date(dayStartSec * 1000); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0);
    return d.getTime() / 1000;
  };
  // Дни и месяцы — на языке интерфейса (Intl)
  TV.fmtDay = function (dayStartSec) {
    var loc = TV.locale ? TV.locale() : 'ru';
    var today = TV.dayStart(TV.now());
    var d = new Date(dayStartSec * 1000);
    var dm = d.toLocaleDateString(loc, { day: 'numeric', month: 'short' });
    var wdS = d.toLocaleDateString(loc, { weekday: 'short' });
    var wdL = d.toLocaleDateString(loc, { weekday: 'long' });
    wdL = wdL.charAt(0).toUpperCase() + wdL.slice(1);
    if (dayStartSec === today) return { title: TV.t('today'), sub: dm + ', ' + wdS };
    if (dayStartSec === TV.addDays(today, -1)) return { title: TV.t('yesterday'), sub: dm + ', ' + wdS };
    if (dayStartSec === TV.addDays(today, 1)) return { title: TV.t('tomorrow'), sub: dm + ', ' + wdS };
    return { title: wdL, sub: dm };
  };

  TV.store = {
    get: function (k, def) {
      try { var v = localStorage.getItem('edemplayer.' + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; }
    },
    set: function (k, v) {
      try { localStorage.setItem('edemplayer.' + k, JSON.stringify(v)); } catch (e) { /* переполнение — не критично */ }
    }
  };

  var toastTimer = null;
  TV.toast = function (msg, ms) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 2500);
  };

  // Нормализация названия для сопоставления с программой передач
  TV.normName = function (s) {
    return String(s || '').toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/\b(hd|fhd|uhd|4k|sd|hevc|orig|original)\b/g, ' ')
      .replace(/[^a-z0-9а-я+]/g, '');
  };

  TV.initials = function (name) {
    var w = String(name).replace(/[^\wа-яё0-9 ]/gi, ' ').trim().split(/\s+/);
    return ((w[0] || '?').charAt(0) + (w[1] ? w[1].charAt(0) : (w[0] || '').charAt(1) || '')).toUpperCase();
  };

  TV.fetchText = function (url, timeoutMs) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 20000) : null;
    return fetch(url, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).finally(function () { clearTimeout(timer); });
  };

  // Мини-обёртка IndexedDB (ключ → значение)
  TV.idb = (function () {
    var dbp = null;
    function db() {
      if (!dbp) dbp = new Promise(function (res, rej) {
        var r = indexedDB.open('edemplayer', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
      return dbp;
    }
    return {
      get: function (k) {
        return db().then(function (d) {
          return new Promise(function (res) {
            var q = d.transaction('kv').objectStore('kv').get(k);
            q.onsuccess = function () { res(q.result); };
            q.onerror = function () { res(undefined); };
          });
        }).catch(function () { return undefined; });
      },
      set: function (k, v) {
        return db().then(function (d) {
          return new Promise(function (res) {
            var tx = d.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(v, k);
            tx.oncomplete = function () { res(true); };
            tx.onerror = function () { res(false); };
          });
        }).catch(function () { return false; });
      }
    };
  })();

  // HTTP-запрос: в программе — через основной процесс (точная причина ошибки, без CORS),
  // в браузере — обычный fetch. Ответ: { status, type, text, ms }; ошибка — Error с .code и понятным текстом.
  TV.http = function (o) {
    var host = ''; try { host = new URL(o.url).host; } catch (e) { /* */ }
    function fail(code, msg) {
      var key = { ENOTFOUND: 'net_dns', EAI_AGAIN: 'net_dns', ECONNREFUSED: 'net_refused', TIMEOUT: 'net_timeout', ETIMEDOUT: 'net_timeout',
        ECONNRESET: 'net_reset', EPIPE: 'net_reset', EHOSTUNREACH: 'net_unreach', ENETUNREACH: 'net_unreach' }[code];
      if (!key && /CERT|SSL|TLS/i.test(code + ' ' + msg)) key = 'net_tls';
      var e = new Error(key ? TV.t(key, { host: host }) : TV.t('net_other', { host: host, e: code + (msg ? ' ' + msg : '') }));
      e.code = code; e.plain = true; e.host = host;
      return e;
    }
    if (window.native && window.native.http) {
      return window.native.http({ url: o.url, method: o.method || 'GET', headers: o.headers || {}, body: o.body, timeout: o.timeout || 25000, engine: o.engine }).then(function (r) {
        if (r && r.error) throw fail(r.error, r.message);
        return r;
      });
    }
    var t0 = Date.now(), ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, o.timeout || 25000) : null;
    return fetch(o.url, { method: o.method || 'GET', headers: o.headers || {}, body: o.body, cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }).then(function (r) {
      return r.text().then(function (t) { return { status: r.status, type: r.headers.get('content-type') || '', text: t, ms: Date.now() - t0 }; });
    }).catch(function (e) {
      if (e && e.name === 'AbortError') throw fail('TIMEOUT');
      throw fail(e && e.name === 'TypeError' ? 'NETWORK' : String(e && e.name || 'ERR'), String(e && e.message || ''));
    }).finally(function () { clearTimeout(timer); });
  };
})(window.TV);
