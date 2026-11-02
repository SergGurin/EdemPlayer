(function (TV) {
  'use strict';

  // Разбор атрибутов вида key="value" key2=value2
  function parseAttrs(s) {
    var out = {}, re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g, m;
    while ((m = re.exec(s))) out[m[1].toLowerCase()] = m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]);
    return out;
  }

  // Делит строку #EXTINF на атрибуты и название по первой запятой вне кавычек
  function splitExtinf(line) {
    var body = line.slice(line.indexOf(':') + 1), q = null;
    for (var i = 0; i < body.length; i++) {
      var c = body[i];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === ',') return { attrs: body.slice(0, i), name: body.slice(i + 1).trim() };
    }
    return { attrs: body, name: '' };
  }

  TV.parseM3U = function (text) {
    var lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
    var header = {}, channels = [], cur = null, lastGroup = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf('#EXTM3U') === 0) {
        var h = parseAttrs(line.slice(7));
        for (var k in h) header[k] = h[k];
      } else if (line.indexOf('#EXTINF') === 0) {
        var p = splitExtinf(line);
        cur = { attrs: parseAttrs(p.attrs), name: p.name, group: null };
      } else if (line.indexOf('#EXTGRP:') === 0) {
        if (cur) cur.group = line.slice(8).trim();
        lastGroup = line.slice(8).trim();
      } else if (line.charAt(0) === '#') {
        continue;
      } else if (cur) {
        var a = cur.attrs;
        var group = a['group-title'] || cur.group || lastGroup || TV.t('no_group');
        var name = cur.name || a['tvg-name'] || TV.t('channel_num', { n: channels.length + 1 });
        var days = parseFloat(a['catchup-days'] || a['tvg-rec'] || a['timeshift'] || a['archive'] ||
          header['catchup-days'] || header['tvg-rec'] || 0) || 0;
        var type = (a['catchup'] || a['catchup-type'] || header['catchup'] || header['catchup-type'] || '').toLowerCase();
        var source = a['catchup-source'] || header['catchup-source'] || '';
        channels.push({
          idx: channels.length,
          key: 'n:' + name.toLowerCase(),
          name: name,
          group: group.trim(),
          url: line,
          lang: TV.detectLang(a['tvg-language'] || a['tvg-lang'] || a['language'] || '', group, name),
          tvgId: a['tvg-id'] || '',
          tvgName: a['tvg-name'] || '',
          logo: a['tvg-logo'] || a['logo'] || '',
          catchup: {
            type: type,
            days: days,
            source: source,
            // архив есть, если указана глубина или тип
            enabled: days > 0 || (!!type && type !== 'none' && type !== 'disabled')
          }
        });
        cur = null;
      }
    }
    var epg = (header['url-tvg'] || header['x-tvg-url'] || header['tvg-url'] || '')
      .split(/[,\s]+/).filter(function (u) { return /^https?:\/\//i.test(u); });
    return { header: header, channels: channels, epgUrls: epg };
  };

  /*
   * Язык канала (код ISO 639-1). Название группы (и метки в названии канала вида «(UA)», «[AM]»)
   * разбивается на слова; слово подходит, если начинается с одной из основ (армян…, армени…, armenia…)
   * или совпадает с кодом (am, arm, hy). Так ловятся «Армения», «армянские», «Армянский», «Armenian», «ARM».
   * Что не распознано — русский. Ручная разметка (TV.chLang) имеет приоритет.
   */
  var LANGS = [
    ['ru', ['русск', 'россия', 'российск', 'russia', 'russian', 'rossi'], ['ru', 'rus', 'рф']],
    ['en', ['англ', 'британ', 'великобрит', 'америк', 'english', 'britain', 'british', 'america'], ['en', 'eng', 'usa', 'us', 'uk', 'gb', 'сша']],
    ['uk', ['украин', 'україн', 'ukrain'], ['ua', 'ukr']],
    ['be', ['белорус', 'беларус', 'беларуск', 'belarus'], ['by', 'bel', 'blr']],
    ['hy', ['армян', 'армени', 'armenia', 'հայ'], ['am', 'arm', 'hy', 'hye']],
    ['ka', ['грузи', 'georgia', 'ქართ'], ['ge', 'geo']],
    ['az', ['азербайдж', 'азерб', 'azerbaij', 'azeri', 'azərb'], ['az', 'aze']],
    ['kk', ['казах', 'kazakh', 'қазақ'], ['kz', 'kaz']],
    ['uz', ['узбек', 'uzbek', 'o‘zbek', 'ozbek'], ['uz', 'uzb']],
    ['tg', ['таджик', 'tajik', 'тоҷик'], ['tj', 'tjk']],
    ['ky', ['кыргыз', 'киргиз', 'kyrgyz', 'кыргыз'], ['kg', 'kgz']],
    ['tk', ['туркмен', 'turkmen'], ['tm', 'tkm']],
    ['ro', ['молдав', 'молдов', 'румын', 'moldov', 'romania', 'român'], ['md', 'mda', 'ro', 'rou']],
    ['lv', ['латыш', 'латви', 'latvia', 'latvi'], ['lv', 'lva']],
    ['lt', ['литов', 'литв', 'lithuan', 'lietuv'], ['lt', 'ltu']],
    ['et', ['эстон', 'eston', 'eesti'], ['ee', 'est']],
    ['he', ['израил', 'иврит', 'еврейск', 'israel', 'hebrew'], ['il', 'isr', 'heb']],
    ['tr', ['турец', 'турци', 'turkey', 'turkish', 'türk', 'turkiye'], ['tr', 'tur']],
    ['de', ['немец', 'немецк', 'герман', 'german', 'deutsch'], ['de', 'ger', 'deu']],
    ['fr', ['франц', 'france', 'french', 'franç'], ['fr', 'fra']],
    ['it', ['итальян', 'итали', 'italia', 'italian'], ['ita']],
    ['es', ['испан', 'spain', 'spanish', 'españ', 'espan'], ['es', 'esp', 'spa']],
    ['pt', ['португал', 'бразил', 'portug', 'brasil', 'brazil'], ['pt', 'por', 'br']],
    ['pl', ['польск', 'польш', 'poland', 'polish', 'polsk', 'polska'], ['pl', 'pol']],
    ['cs', ['чешск', 'чехи', 'czech', 'česk'], ['cz', 'cze', 'ces']],
    ['sk', ['словацк', 'словаки', 'slovak'], ['sk', 'svk']],
    ['bg', ['болгар', 'bulgar'], ['bg', 'bgr', 'bul']],
    ['sr', ['сербск', 'серби', 'serbia', 'serbian', 'srpsk'], ['rs', 'srb']],
    ['hr', ['хорват', 'croat', 'hrvat'], ['hr', 'hrv']],
    ['hu', ['венгер', 'венгри', 'hungar', 'magyar'], ['hu', 'hun']],
    ['el', ['греческ', 'греци', 'greek', 'greece', 'ελλ'], ['gr', 'grc', 'gre']],
    ['fi', ['финск', 'финлянд', 'finnish', 'finland', 'suomi'], ['fi', 'fin']],
    ['sv', ['шведск', 'швеци', 'swed', 'svensk', 'sverige'], ['se', 'swe']],
    ['nl', ['нидерланд', 'голланд', 'dutch', 'netherland', 'holland'], ['nl', 'nld']],
    ['ar', ['араб', 'arab', 'عرب'], ['ar', 'ara']],
    ['fa', ['иран', 'персид', 'фарси', 'iran', 'persian', 'farsi'], ['ir', 'irn', 'fa']],
    ['zh', ['китай', 'china', 'chinese', '中'], ['cn', 'chn', 'zh']],
    ['ja', ['японск', 'япони', 'japan'], ['jp', 'jpn']],
    ['ko', ['корейск', 'корея', 'korea'], ['kr', 'kor']],
    ['hi', ['хинди', 'hindi'], ['hi']]
  ];
  var STEMS = [], TOKENS = {};
  LANGS.forEach(function (l) {
    l[1].forEach(function (st) { STEMS.push([st.toLowerCase(), l[0]]); });
    l[2].forEach(function (t) { TOKENS[t.toLowerCase()] = l[0]; });
  });
  STEMS.sort(function (a, b) { return b[0].length - a[0].length; }); // длинные основы — первыми
  TV.LANG_CODES = LANGS.map(function (l) { return l[0]; });
  // коды стран, допустимые только как суффикс названия заглавными («Rai 1 IT»)
  var SUFFIX_EXTRA = { it: 'it', at: 'de', ch: 'de', au: 'en', ie: 'en', nz: 'en', ca: 'en', mx: 'es', cl: 'es', co: 'es', dk: 'da', no: 'no' };

  function words(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е').split(/[^0-9a-zа-яіїєґЀ-ӿԱ-֏Ⴀ-ჿͰ-Ͽ֐-ۿ一-鿿'‘ʻ]+/i).filter(Boolean); }
  function matchWords(ws, allowTokens) {
    for (var i = 0; i < ws.length; i++) {
      var w = ws[i];
      for (var k = 0; k < STEMS.length; k++) if (w.indexOf(STEMS[k][0]) === 0) return STEMS[k][1];
      if (allowTokens && TOKENS[w]) return TOKENS[w];
    }
    return null;
  }
  TV.detectLang = function (attr, group, name) {
    var a = String(attr || '').split(/[;,]/)[0].trim().toLowerCase();
    if (a) return TOKENS[a] || matchWords([a], false) || (a.length <= 3 ? a.slice(0, 2) : 'ru');
    // суффикс страны/языка в названии: «RFM TV HD FR», «Das Erste DE», «BBC One UK HD»
    var nw = String(name || '').trim().split(/\s+/);
    for (var k = nw.length - 1; k >= Math.max(1, nw.length - 3); k--) {
      var w = nw[k];
      if (/^(HD|FHD|UHD|SD|4K|8K|HEVC|ORIG|\+\d+|-\d+|\d+)$/i.test(w)) continue; // пропускаем «HD», «+2» и т. п.
      var wl = w.toLowerCase().replace(/[^a-z]/g, '');
      var sl = TOKENS[wl] || SUFFIX_EXTRA[wl];
      if (/^[A-Z]{2,3}$/.test(w) && sl && wl !== 'tv') return sl;
      break;
    }
    var g = matchWords(words(group), true);
    if (g) return g;
    // метки в скобках в названии канала: «Канал (UA)», «[AM] Канал»
    var m = String(name || '').match(/[\(\[]([^\)\]]{2,12})[\)\]]/);
    if (m) { var t = matchWords(words(m[1]), true); if (t) return t; }
    return 'ru';
  };

  // Порядок групп-букв: цифры, кириллица, латиница, прочее
  TV.letterOf = function (name) {
    var c = String(name).trim().charAt(0).toUpperCase();
    if (c === 'Ё') c = 'Е';
    if (/[0-9]/.test(c)) return c;
    if (/[А-Я]/.test(c) || /[A-Z]/.test(c)) return c;
    return '#';
  };
  TV.letterRank = function (c) {
    if (/[0-9]/.test(c)) return 0;
    if (/[А-Я]/.test(c)) return 1;
    if (/[A-Z]/.test(c)) return 2;
    return 3;
  };
  TV.compareLetters = function (a, b) {
    var ra = TV.letterRank(a), rb = TV.letterRank(b);
    return ra !== rb ? ra - rb : a.localeCompare(b, 'ru');
  };
})(window.TV);
