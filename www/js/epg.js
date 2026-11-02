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
      var w = self.worker = new Worker('js/epg-worker.js');
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
      w.onerror = function (e) { self.loading = false; console.warn('EPG worker', e.message); };
      w.postMessage({
        type: 'load', urls: urls,
        todayStart: TV.dayStart(now), now: now,
        from: TV.dayStart(now) - (TV_CONFIG.scheduleDays + 1) * 86400,
        to: now + 2 * 86400,
        channels: channels.map(function (c) { return { key: c.key, name: c.name, tvgId: c.tvgId, tvgName: c.tvgName }; })
      });
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
