(function (TV) {
  'use strict';

  // Числа словами → цифрами (для голосового ввода: «россия один» → «россия 1»)
  var UNITS = { 'ноль': 0, 'один': 1, 'одна': 1, 'первый': 1, 'два': 2, 'две': 2, 'второй': 2, 'три': 3, 'третий': 3, 'четыре': 4, 'пять': 5, 'пятый': 5,
    'шесть': 6, 'семь': 7, 'восемь': 8, 'девять': 9, 'десять': 10, 'одиннадцать': 11, 'двенадцать': 12, 'тринадцать': 13,
    'четырнадцать': 14, 'пятнадцать': 15, 'шестнадцать': 16, 'семнадцать': 17, 'восемнадцать': 18, 'девятнадцать': 19 };
  var TENS = { 'двадцать': 20, 'тридцать': 30, 'сорок': 40, 'пятьдесят': 50, 'шестьдесят': 60, 'семьдесят': 70, 'восемьдесят': 80, 'девяносто': 90, 'сто': 100 };
  // Названия букв → буквы (для аббревиатур: «тэ эн тэ» → «тнт»)
  var LETTERS = { 'а': 'а', 'бэ': 'б', 'бе': 'б', 'вэ': 'в', 'ве': 'в', 'гэ': 'г', 'гe': 'г', 'дэ': 'д', 'де': 'д', 'е': 'е', 'жэ': 'ж', 'зэ': 'з', 'зе': 'з',
    'и': 'и', 'ка': 'к', 'эль': 'л', 'эл': 'л', 'эм': 'м', 'эн': 'н', 'о': 'о', 'пэ': 'п', 'пе': 'п', 'эр': 'р', 'эс': 'с', 'тэ': 'т', 'те': 'т',
    'у': 'у', 'эф': 'ф', 'ха': 'х', 'цэ': 'ц', 'це': 'ц', 'че': 'ч', 'ша': 'ш', 'э': 'э', 'ю': 'ю', 'я': 'я',
    'би': 'b', 'си': 'c', 'ди': 'd', 'эйч': 'h', 'джей': 'j', 'кей': 'k', 'ви': 'v', 'экс': 'x' };

  function clean(s) {
    return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"'`!?.,:;()\[\]{}|\/\\_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Приведение фразы: числа словами → цифры, цепочки названий букв → аббревиатура
  function speechNorm(q) {
    var w = clean(q).split(' '), out = [];
    for (var i = 0; i < w.length; i++) {
      var t = w[i];
      if (TENS[t] != null) {
        var n = TENS[t];
        if (UNITS[w[i + 1]] != null && UNITS[w[i + 1]] < 10) { n += UNITS[w[i + 1]]; i++; }
        out.push(String(n)); continue;
      }
      if (UNITS[t] != null && !(t === 'первый' || t === 'пятый' || t === 'второй' || t === 'третий')) { out.push(String(UNITS[t])); continue; }
      if (LETTERS[t] && LETTERS[w[i + 1]]) {
        var ab = '';
        while (i < w.length && LETTERS[w[i]]) { ab += LETTERS[w[i]]; i++; }
        i--; out.push(ab); continue;
      }
      out.push(t);
    }
    return out.join(' ');
  }

  // Транслитерация и «фонетический скелет»: дискавери ≈ discovery, нэшнл ≈ national
  var TR = { 'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'i', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya' };
  function translit(s) { return s.replace(/[а-я]/g, function (c) { return TR[c] != null ? TR[c] : c; }); }
  function skel(w) {
    return translit(w).replace(/^eu/, 'ev').replace(/tion/g, 'shn').replace(/g(?=[eiy])/g, 'z').replace(/ph/g, 'f').replace(/ck|q|c(?=[aouklrt]|$)/g, 'k').replace(/c/g, 's').replace(/x/g, 'ks').replace(/(?<=[aeiou])w/g, 'u').replace(/w/g, 'v')
      .replace(/dzh|zh|j/g, 'z').replace(/th/g, 't').replace(/[aeiouy]+/g, '').replace(/(.)\1+/g, '$1');
  }
  function compact(s) { return clean(s).replace(/\s+/g, ''); }

  function lev(a, b) {
    if (a === b) return 0;
    var m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    var prev = new Array(n + 1), cur = new Array(n + 1), i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
      var t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }

  // Оценка совпадения названия с запросом (0 — не подходит)
  function score(name, variants) {
    var nm = clean(name), nc = nm.replace(/\s+/g, '');
    var best = 0;
    variants.forEach(function (q) {
      if (!q) return;
      var qc = q.replace(/\s+/g, '');
      if (nm === q || nc === qc) { best = Math.max(best, 100); return; }
      if (nm.indexOf(q) === 0 || nc.indexOf(qc) === 0) { best = Math.max(best, 90); return; }
      var words = q.split(' ');
      if (words.every(function (x) { return nm.indexOf(x) >= 0; })) { best = Math.max(best, 75); return; }
      if (nc.indexOf(qc) >= 0) { best = Math.max(best, 70); return; }
      // нечёткое: слова запроса близки к словам названия (ошибки распознавания/опечатки)
      var nw = nm.split(' '), hits = 0;
      words.forEach(function (x) {
        if (x.length < 3) { if (nw.indexOf(x) >= 0) hits++; return; }
        for (var k = 0; k < nw.length; k++) {
          var y = nw[k].slice(0, x.length + 1);
          if (lev(x, y) <= (x.length > 5 ? 2 : 1)) { hits++; return; }
        }
      });
      if (hits === words.length) { best = Math.max(best, 55); return; }
      // по звучанию (кириллица ↔ латиница)
      var ns = nw.map(skel), sh = 0;
      words.forEach(function (x) {
        var sx = skel(x); if (sx.length < 2) { if (nw.indexOf(x) >= 0 || ns.indexOf(sx) >= 0) sh++; return; }
        for (var k = 0; k < ns.length; k++) { var y = ns[k].slice(0, sx.length + 1); if (y && lev(sx, y) <= (sx.length > 4 ? 1 : 0)) { sh++; return; } }
      });
      if (sh === words.length) best = Math.max(best, 52);
      else if (qc.length >= 4 && lev(qc, nc.slice(0, qc.length + 1)) <= Math.max(1, Math.floor(qc.length / 4))) best = Math.max(best, 50);
    });
    return best;
  }

  TV.Search = {
    speechNorm: speechNorm,

    run: function (query, channels) {
      var q1 = clean(query);
      if (!q1) return { channels: [], progs: [] };
      var variants = [q1];
      var q2 = speechNorm(query); if (q2 && q2 !== q1) variants.push(q2);
      var q3 = compact(q2); if (q3 && variants.indexOf(q3) < 0 && q3.length <= 6) variants.push(q3);

      var chs = channels.map(function (c) { return { ch: c, s: score(c.name, variants) }; })
        .filter(function (x) { return x.s > 0; })
        .sort(function (a, b) { return b.s - a.s || a.ch.name.localeCompare(b.ch.name, 'ru'); })
        .slice(0, 40).map(function (x) { return x.ch; });

      var progs = [];
      if (q1.length >= 3) {
        var now = TV.now(), from = TV.dayStart(now) - (TV_CONFIG.scheduleDays - 1) * 86400, to = now + 86400;
        channels.forEach(function (c) {
          var list = TV.EPG.list(c.key);
          for (var i = 0; i < list.length; i++) {
            var p = list[i];
            if (p[0] < from || p[0] > to) continue;
            var t = clean(p[2]);
            var ok = variants.some(function (v) { return v.length >= 3 && t.indexOf(v) >= 0; });
            if (ok) progs.push({ ch: c, start: p[0], stop: p[1], title: p[2], desc: p[3] });
          }
        });
        // сначала идущие сейчас, затем недавние, потом будущие
        progs.sort(function (a, b) {
          var ra = a.start > now ? 2 : (a.stop > now ? 0 : 1), rb = b.start > now ? 2 : (b.stop > now ? 0 : 1);
          if (ra !== rb) return ra - rb;
          return ra === 2 ? a.start - b.start : b.start - a.start;
        });
        progs = progs.slice(0, 60);
      }
      return { channels: chs, progs: progs };
    }
  };
})(window.TV);
