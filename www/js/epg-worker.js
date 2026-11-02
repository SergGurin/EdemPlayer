/* Фоновый разбор XMLTV: потоково, с распаковкой gzip, только нужные каналы и дни */
'use strict';

function exact(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim(); }
function norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/\b(hd|fhd|uhd|4k|sd|hevc|orig|original)\b/g, ' ')
    .replace(/[^a-z0-9а-я+]/g, '');
}

var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x?[0-9a-f]+|\w+);/gi, function (all, e) {
    if (e.charAt(0) === '#') {
      var n = e.charAt(1).toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return isNaN(n) ? all : String.fromCodePoint(n);
    }
    return ENT[e.toLowerCase()] != null ? ENT[e.toLowerCase()] : all;
  }).trim();
}
function attr(tag, name) {
  var m = new RegExp('\\s' + name + '\\s*=\\s*"([^"]*)"').exec(tag) || new RegExp('\\s' + name + "\\s*=\\s*'([^']*)'").exec(tag);
  return m ? decode(m[1]) : '';
}
function firstText(block, tag) {
  var m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>').exec(block);
  return m ? decode(m[1]) : '';
}
// "20261102120000 +0300" → секунды UTC
function parseTime(s) {
  var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2}):?(\d{2})?/.exec(s.trim());
  if (!m) return NaN;
  var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  if (m[7]) {
    var sign = m[7].charAt(0) === '-' ? -1 : 1;
    t -= sign * (Math.abs(+m[7]) * 3600 + (+(m[8] || 0)) * 60);
  }
  return t;
}

// Поток текста XMLTV: fetch → (gzip → распаковка) → UTF-8. Возвращает { read() → { done, value: строка } }.
// Новые браузеры — DecompressionStream; старые (WebView Android 9) — встроенный pako и TextDecoder.
async function openStream(url) {
  var res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  var reader = res.body.getReader();
  var first = await reader.read();
  var head = first.value || new Uint8Array(0);
  var gz = head.length > 1 && head[0] === 0x1f && head[1] === 0x8b;
  var td = new TextDecoder('utf-8');
  var out = [], pending = head.length ? head : null, ended = !!first.done, inf = null;
  if (gz && typeof DecompressionStream !== 'undefined') {
    // быстрый путь: распаковка средствами браузера
    var src = reader; // сжатые данные (не путать с reader распакованного потока ниже)
    var stream = new ReadableStream({
      start: function (c) { if (pending) c.enqueue(pending); pending = null; if (ended) c.close(); },
      pull: async function (c) { var r = await src.read(); if (r.done) c.close(); else c.enqueue(r.value); },
      cancel: function () { src.cancel(); }
    }).pipeThrough(new DecompressionStream('gzip'));
    reader = stream.getReader(); ended = false; gz = false;
  } else if (gz) {
    if (!self.pako) importScripts('../vendor/pako_inflate.min.js');
    inf = new pako.Inflate();
    inf.onData = function (c) { out.push(td.decode(c, { stream: true })); };
  }
  return {
    read: async function () {
      for (;;) {
        if (out.length) return { done: false, value: out.shift() };
        if (ended) return { done: true, value: undefined };
        var chunk;
        if (pending) { chunk = pending; pending = null; }
        else {
          var r = await reader.read();
          if (r.done) {
            ended = true;
            if (inf) { inf.push(new Uint8Array(0), true); if (inf.err) throw new Error('gzip: ' + inf.msg); }
            var tail = td.decode(); if (tail) out.push(tail);
            continue;
          }
          chunk = r.value;
        }
        if (inf) { inf.push(chunk, false); if (inf.err) throw new Error('gzip: ' + inf.msg); }
        else { var t = td.decode(chunk, { stream: true }); if (t) out.push(t); }
      }
    },
    cancel: function () { try { reader.cancel(); } catch (e) { /* */ } }
  };
}

/*
 * Один источник XMLTV. Для каждого канала плейлиста собираются ВСЕ подходящие каналы EPG
 * (кандидаты) с их передачами; выбор делается в конце: лучшее совпадение названия,
 * затем наличие передач на сегодня, затем их количество. Так одноимённые «пустые»
 * или региональные записи не перекрывают нужную.
 */
async function parseUrl(url, ctx) {
  var reader = await openStream(url);
  var buf = '', total = 0, progs = 0;
  var cand = {};      // key → { id: score }
  var idKeys = {};    // id EPG → [key]
  var byId = {};      // id EPG → [передачи]
  var icons = {};     // id EPG → логотип
  function want(k) { return !ctx.final[k]; }
  function addCand(id, k, sc) {
    if (!want(k)) return;
    var c = cand[k] || (cand[k] = {});
    if (!c[id] || c[id] < sc) c[id] = sc;
    var l = idKeys[id] || (idKeys[id] = []);
    if (l.indexOf(k) < 0) l.push(k);
  }
  for (;;) {
    var r = await reader.read();
    if (r.value) { buf += r.value; total += r.value.length; }
    var pos = 0;
    for (;;) {
      var pc = buf.indexOf('<programme', pos);
      var cc = buf.indexOf('<channel', pos);
      var isProg = pc >= 0 && (cc < 0 || pc < cc);
      var s0 = isProg ? pc : cc;
      if (s0 < 0) { pos = Math.max(pos, buf.length - 12); break; }
      var endTag = isProg ? '</programme>' : '</channel>';
      var e = buf.indexOf(endTag, s0);
      if (e < 0) {
        var gt = buf.indexOf('>', s0);
        if (gt > 0 && buf.charAt(gt - 1) === '/') { pos = gt + 1; continue; }
        pos = s0; break;
      }
      var block = buf.slice(s0, e + endTag.length);
      pos = e + endTag.length;
      var openTag = block.slice(0, block.indexOf('>'));
      if (isProg) {
        var cid = attr(openTag, 'channel');
        if (!idKeys[cid]) {
          // канал не описан в <channel> — допускаем только точный tvg-id
          var tk = ctx.byTvgId[cid];
          if (!tk) continue;
          tk.forEach(function (k) { addCand(cid, k, 3); });
          if (!idKeys[cid]) continue;
        }
        var st = parseTime(attr(openTag, 'start')), sp = parseTime(attr(openTag, 'stop'));
        if (!(st < ctx.to) || !(sp > ctx.from) || !(sp > st)) continue;
        var desc = firstText(block, 'desc');
        if (desc.length > 700) desc = desc.slice(0, 700) + '…';
        (byId[cid] || (byId[cid] = [])).push([st, sp, firstText(block, 'title'), desc]);
        progs++;
      } else {
        var id = attr(openTag, 'id');
        var names = [], re = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g, m;
        while ((m = re.exec(block))) names.push(decode(m[1]));
        // 3 — tvg-id, 2 — точное название, 1 — нормализованное
        (ctx.byTvgId[id] || []).forEach(function (k) { addCand(id, k, 3); });
        for (var j = 0; j < names.length; j++) {
          (ctx.byExact[exact(names[j])] || []).forEach(function (k) { addCand(id, k, 2); });
          (ctx.byName[norm(names[j])] || []).forEach(function (k) { addCand(id, k, 1); });
        }
        if (idKeys[id]) {
          var icon = /<icon[^>]*src\s*=\s*"([^"]+)"/.exec(block);
          if (icon) icons[id] = decode(icon[1]);
        }
      }
    }
    buf = buf.slice(pos);
    if (r.done) break;
    if (total > ctx.reportAt) {
      ctx.reportAt = total + 20e6;
      postMessage({ type: 'progress', mb: Math.round(total / 1e6), programmes: progs });
    }
  }
  // выбор лучшего кандидата для каждого канала
  var now = ctx.now, dayFrom = ctx.todayStart, dayTo = ctx.todayStart + 86400;
  Object.keys(cand).forEach(function (k) {
    var best = null;
    Object.keys(cand[k]).forEach(function (id) {
      var list = byId[id] || [];
      if (!list.length) return;
      // главное — есть ли передача прямо сейчас; затем качество совпадения названия,
      // затем докуда известна программа и сколько передач сегодня
      var today = 0, nowOk = 0, lastStop = 0;
      for (var i = 0; i < list.length; i++) {
        if (list[i][1] > dayFrom && list[i][0] < dayTo) today++;
        if (list[i][0] <= now && list[i][1] > now) nowOk = 1;
        if (list[i][1] > lastStop) lastStop = list[i][1];
      }
      var rank = [nowOk, cand[k][id], Math.min(lastStop, now + 86400), today, list.length];
      if (!best || cmp(rank, best.rank) > 0) best = { id: id, rank: rank, list: list };
    });
    if (!best) return;
    var prev = ctx.pick[k];
    // данные из более приоритетного источника заменяем, только если там не было «сегодня»
    if (prev && (prev.rank[0] > best.rank[0] || (prev.rank[0] === best.rank[0] && prev.rank[2] >= best.rank[2]))) return;
    ctx.pick[k] = best;
    ctx.data[k] = best.list.slice();
    if (icons[best.id]) ctx.icons[k] = icons[best.id];
    if (best.rank[0]) ctx.final[k] = true;
  });
  return progs;
}

function cmp(a, b) { for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

onmessage = async function (ev) {
  var msg = ev.data;
  if (msg.type !== 'load') return;
  var ctx = {
    byTvgId: {}, byName: {}, byExact: {}, data: {}, icons: {}, pick: {}, final: {},
    from: msg.from, to: msg.to, todayStart: msg.todayStart, now: msg.now || Date.now() / 1000, reportAt: 20e6
  };
  msg.channels.forEach(function (c) {
    function add(map, k) { if (!k) return; (map[k] || (map[k] = [])).indexOf(c.key) < 0 && map[k].push(c.key); }
    add(ctx.byTvgId, c.tvgId);
    add(ctx.byExact, exact(c.name));
    add(ctx.byExact, exact(c.tvgName));
    add(ctx.byName, norm(c.name));
    add(ctx.byName, norm(c.tvgName));
    add(ctx.byName, norm(c.tvgId));
  });
  var errors = [];
  for (var i = 0; i < msg.urls.length; i++) {
    // у всех каналов уже есть программа на сегодня — запасные источники не скачиваем
    if (i > 0 && msg.channels.every(function (c) { return ctx.final[c.key]; })) break;
    try { await parseUrl(msg.urls[i], ctx); }
    catch (e) { errors.push(msg.urls[i] + ': ' + String(e && e.message || e)); }
  }
  for (var k in ctx.data) {
    var arr = ctx.data[k].sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    for (var j = 0; j < arr.length; j++) {
      var p = arr[j], last = out[out.length - 1];
      if (last && p[0] < last[1] - 30) { if (p[0] === last[0]) continue; last[1] = p[0]; }
      out.push(p);
    }
    ctx.data[k] = out;
  }
  var missing = msg.channels.filter(function (c) { return !ctx.data[c.key]; }).map(function (c) { return c.name; });
  var stale = msg.channels.filter(function (c) { return ctx.data[c.key] && !ctx.final[c.key]; }).map(function (c) { return c.name; });
  postMessage({ type: 'done', data: ctx.data, icons: ctx.icons, errors: errors, missing: missing, stale: stale });
};
