(function (TV) {
  'use strict';

  var EPG = TV.EPG = {
    data: {}, icons: {}, ready: false, loading: false, listeners: [],

    onUpdate: function (fn) { this.listeners.push(fn); },
    _emit: function () { this.listeners.forEach(function (f) { try { f(); } catch (e) { console.error(e); } }); },

    init: function (channels, urls) {
      var self = this;
      var sig = 'v4|' + urls.join('|') + '#' + channels.length;
      return TV.idb.get('epg').then(function (cache) {
        var fresh = cache && cache.sig === sig &&
          (Date.now() - cache.time) < TV_CONFIG.epgRefreshHours * 3600e3;
        if (cache && cache.data) {
          self.data = cache.data; self.icons = cache.icons || {}; self.missing = cache.missing || []; self.stale = cache.stale || []; self.errors = cache.errors || []; self.ready = true; self._emit();
        }
        if (!fresh) self._load(channels, urls, sig);
      });
    },

    _load: function (channels, urls, sig) {
      var self = this;
      if (!urls.length || typeof Worker === 'undefined') return;
      self.loading = true;
      if (self.worker) try { self.worker.terminate(); } catch (e) { /* */ }
      var w = self.worker = EPG._worker();
      if (!w) { self.loading = false; self.errors = [TV.t('epg_noworker')]; self._emit(); return; }
      var now = TV.now();
      w.onmessage = function (ev) {
        var m = ev.data;
        if (m.type === 'progress') return;
        if (m.type === 'done') {
          w.terminate(); self.worker = null;
          self.loading = false;
          var n = Object.keys(m.data).length;
          if (m.errors.length) console.warn('EPG: ошибки загрузки', m.errors);
          self.errors = m.errors; self.missing = m.missing || []; self.stale = m.stale || [];
          if (!n && self.ready) return; // не затираем кэш пустым результатом
          self.data = m.data; self.icons = m.icons; self.ready = true;
          TV.idb.set('epg', { sig: sig, time: Date.now(), data: m.data, icons: m.icons, missing: self.missing, stale: self.stale, errors: self.errors });
          self._emit();
        }
      };
      // сбой загрузчика — причина видна во вкладке «Программа передач»
      w.onerror = function (e) { self.loading = false; self.errors = [TV.t('epg_worker_err', { e: (e && e.message) || '?' })]; self._emit(); };
      w.postMessage({
        type: 'load', urls: urls, proxy: EPG.proxy(),
        todayStart: TV.dayStart(now), now: now,
        from: TV.dayStart(now) - (TV_CONFIG.scheduleDays + 1) * 86400,
        to: now + 2 * 86400,
        channels: channels.map(function (c) { return { key: c.key, name: c.name, tvgId: c.tvgId, tvgName: c.tvgName }; })
      });
    },

    // Android: сеть загрузчика — через приложение (https://edp.local/proxy?u=…)
    proxy: function () { return window.native && window.native.platform === 'android' ? 'https://edp.local/proxy?u=' : ''; },
    // Фоновый загрузчик. На Android (страница из file://) — из Blob с уже встроенным pako: так WebView его точно разрешает
    _worker: function () {
      if (!(window.native && window.native.platform === 'android')) { try { return new Worker('js/epg-worker.js'); } catch (e) { return null; } }
      try {
        var get = function (u) { var x = new XMLHttpRequest(); x.open('GET', u, false); x.send(); return x.responseText; };
        var code = get('vendor/pako_inflate.min.js') + '\n;' + get('js/epg-worker.js');
        return new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
      } catch (e) {
        try { return new Worker('js/epg-worker.js'); } catch (e2) { return null; }
      }
    },

    list: function (key) { return this.data[key] || []; },

    // Индекс передачи, идущей в момент t (или -1)
    indexAt: function (key, t) {
      var a = this.list(key), lo = 0, hi = a.length - 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (a[mid][1] <= t) lo = mid + 1;
        else if (a[mid][0] > t) hi = mid - 1;
        else return mid;
      }
      return -1;
    },

    // Передача в момент t; если программы нет — часовой «слот»
    at: function (key, t) {
      var i = this.indexAt(key, t);
      if (i >= 0) { var p = this.list(key)[i]; return { start: p[0], stop: p[1], title: p[2], desc: p[3], idx: i }; }
      var hs = Math.floor(t / 3600) * 3600;
      return { start: hs, stop: hs + 3600, title: '', desc: '', idx: -1, slot: true };
    }
  };
})(window.TV);
