(function (TV) {
  'use strict';

  /*
   * Источник списка каналов. Три способа:
   *  url  — прямая ссылка на плейлист;
   *  key  — ключ доступа + домен каналов: адреса вида http://<домен>/iptv/<ключ>/<номер>/index.m3u8
   *         строятся по шаблону — последнему загруженному списку каналов (или файлу);
   *  file — файл .m3u/.m3u8 с устройства (хранится на устройстве).
   */
  var RE = /^(https?:\/\/)([^\/\s]+)\/iptv\/([^\/\s]+)\/([^\/\s]+)\/(.*)$/i;

  var S = TV.Source = {
    mode: function () { return TV.store.get('srcMode', 'url'); },

    // Задан ли источник для выбранного способа
    configured: function () {
      var m = S.mode();
      if (m === 'key') return !!TV.store.get('accessKey', '');
      if (m === 'file') return !!TV.store.get('fileName', '');
      return !!TV.store.get('playlistUrl', '');
    },

    // Подстановка ключа и домена в адреса каналов
    applyKey: function (text, key, domain) {
      var n = 0;
      var out = String(text).split(/\r?\n/).map(function (line) {
        var l = line.trim();
        if (!l || l.charAt(0) === '#') return line;
        var m = RE.exec(l);
        if (!m) return line;
        n++;
        return m[1] + (domain || m[2]) + '/iptv/' + key + '/' + m[4] + '/' + m[5];
      }).join('\n');
      return { text: out, count: n };
    },

    hasKeyFormat: function (text) {
      return String(text).split(/\r?\n/).some(function (l) { l = l.trim(); return l && l.charAt(0) !== '#' && RE.test(l); });
    },

    saveTemplate: function (text, origin) {
      if (S.hasKeyFormat(text)) return TV.idb.set('template', { text: text, origin: origin, time: Date.now() });
      return Promise.resolve(false);
    },

    // Текст плейлиста по текущим настройкам
    load: function () {
      var mode = S.mode();
      if (mode === 'file') {
        return TV.idb.get('file').then(function (f) {
          if (!f || !f.text) throw new Error(TV.t('src_no_file'));
          S.saveTemplate(f.text, 'file');
          return f.text;
        });
      }
      if (mode === 'key') {
        var key = TV.store.get('accessKey', ''), domain = TV.store.get('channelDomain', '');
        if (!key) return Promise.reject(new Error(TV.t('src_no_key')));
        return TV.idb.get('template').then(function (t) {
          if (t && t.text) return t;
          // шаблона нет (например, настройки только что загружены из облака) — берём список по сохранённой ссылке
          var u = TV.store.get('playlistUrl', '');
          if (!u) return t;
          return TV.fetchText(u, 25000).then(function (text) { return S.saveTemplate(text, 'url').then(function () { return { text: text }; }); }).catch(function () { return t; });
        }).then(function (t) {
          if (!t || !t.text) throw new Error(TV.t('src_no_tpl'));
          var r = S.applyKey(t.text, key, domain);
          if (!r.count) throw new Error(TV.t('src_tpl_bad'));
          return r.text;
        });
      }
      var url = TV.playlistUrl();
      return TV.fetchText(url, 25000).then(function (text) {
        if (text.indexOf('#EXT') < 0) throw new Error(TV.t('src_bad_format'));
        TV.store.set('playlistCache', { url: url, text: text });
        S.saveTemplate(text, 'url');
        return text;
      }).catch(function (err) {
        var cached = TV.store.get('playlistCache', null);
        if (cached && cached.url === url) { TV.toast(TV.t('offline_cached')); return cached.text; }
        throw err;
      });
    },

    // Ключ и домен, которые сейчас стоят в шаблоне (для подсказки в настройках)
    templateInfo: function () {
      return TV.idb.get('template').then(function (t) {
        if (!t || !t.text) return null;
        var lines = t.text.split(/\r?\n/), m = null;
        for (var i = 0; i < lines.length && !m; i++) { var l = lines[i].trim(); if (l && l.charAt(0) !== '#') m = RE.exec(l); }
        var count = lines.filter(function (l) { l = l.trim(); return l && l.charAt(0) !== '#' && RE.test(l); }).length;
        return { count: count, domain: m ? m[2] : '', time: t.time, origin: t.origin };
      });
    }
  };
})(window.TV);
