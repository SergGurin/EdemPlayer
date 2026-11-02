(function (TV) {
  'use strict';
  var pad = TV.pad;

  function fill(tpl, start, end, now) {
    var d = new Date(start * 1000);
    var map = {
      utc: start, start: start, timestamp: now, lutc: now, now: now,
      utcend: end, end: end, duration: Math.max(1, end - start), offset: Math.max(0, now - start),
      Y: d.getUTCFullYear(), m: pad(d.getUTCMonth() + 1), d: pad(d.getUTCDate()),
      H: pad(d.getUTCHours()), M: pad(d.getUTCMinutes()), S: pad(d.getUTCSeconds())
    };
    return tpl.replace(/\$?\{(\w+)\}/g, function (all, k) {
      return Object.prototype.hasOwnProperty.call(map, k) ? String(map[k]) : all;
    });
  }

  function appendQuery(url, part) {
    if (part.charAt(0) === '?' || part.charAt(0) === '&') {
      return url + (url.indexOf('?') >= 0 ? '&' : '?') + part.slice(1);
    }
    return url + part;
  }

  TV.Catchup = {
    available: function (ch) { return !!(ch && ch.catchup && ch.catchup.enabled !== false); },
    days: function (ch) {
      return (ch.catchup && ch.catchup.days) || TV_CONFIG.defaultArchiveDays;
    },
    // Самое раннее доступное время архива
    earliest: function (ch) { return TV.now() - TV.Catchup.days(ch) * 86400 + 120; },

    // Адрес архивного потока с момента start (сек) до «сейчас»
    url: function (ch, start, end) {
      var now = Math.floor(TV.now());
      start = Math.floor(start);
      end = Math.floor(end || now);
      var c = ch.catchup || {}, url = ch.url, type = c.type;
      if (c.source) {
        return /^https?:\/\//i.test(c.source) ? fill(c.source, start, end, now) : appendQuery(url, fill(c.source, start, end, now));
      }
      if (type === 'flussonic' || type === 'flussonic-hls' || type === 'fs') {
        // http://host/ch/index.m3u8 → http://host/ch/index-START-now.m3u8
        return url.replace(/\/(index|video|mono|playlist)\.m3u8/, '/$1-' + start + '-now.m3u8');
      }
      if (type === 'xc') {
        return url; // формат Xtream Codes требует отдельной настройки
      }
      // default / append / shift и случай «есть только глубина архива» — шаблон провайдера
      return appendQuery(url, fill(TV_CONFIG.defaultCatchupSource, start, end, now));
    }
  };
})(window.TV);
