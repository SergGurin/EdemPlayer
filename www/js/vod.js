(function (TV) {
  'use strict';
  /*
   * Медиатека Edem (VPortal). Строка из кабинета: portal::[key:<ключ>]http://<сервер>/api/v1/
   * Протокол (как в открытых плагинах ProIPTV/ottplay): JSON POST на адрес API с полями key/mac/app
   * плюс параметры запроса. Ответ: { type, title, items:[…], controls:{ filters:[…], search } }.
   *  • корень (без cmd)            — разделы (items с request.fid) и фильтры (жанры, годы);
   *  • cmd:"flicks", fid, offset   — содержимое раздела; в конце страницы элемент { type:"next", request:{offset} };
   *  • cmd:"flick", fid            — карточка: { type:"stream", url, variants } или { type:"multistream", items:[серии/сезоны] };
   *  • cmd:"search", query         — поиск;  { genre|years, filter:"on" } — фильтр.
   * Элементы: category — папка, stream — фильм/серия, multistream — сериал, next — следующая страница.
   */
  var PAGE = 200;

  var V = TV.Vod = {
    cache: {},       // ключ запроса → { items, done, loading, title }
    root: null,

    parse: function (s) {
      var m = /^\s*portal::(?:\[|%5b)key:([^\]]*?)(?:\]|%5d)\s*(https?:\/\/\S+)\s*$/i.exec(String(s || ''));
      return m ? { key: m[1].trim(), url: m[2] } : null;
    },
    config: function () { return V.parse(TV.store.get('vportal', '')); },
    enabled: function () { return !!V.config(); },
    reset: function () { V.cache = {}; V.root = null; V._eps = {}; V._prev = {}; V.bg.queue = []; },

    // Запрос к API — только POST (GET сервер отклоняет), через основной процесс программы,
    // с заголовками как у OTT Navigator и ключом в X-Api-Key. Вариант тела, на который сервер
    // ответил без ошибки, запоминается (vodProto).
    UA: 'OTT Navigator/1.6.9.4 (Linux; Android 11)',
    PROTOS: ['json', 'jsonkey', 'jsonott', 'form'],
    _fields: function (proto, cfg, params) {
      var f = {};
      Object.keys(params || {}).forEach(function (k) { f[k] = params[k]; });
      f.key = cfg.key;
      if (proto === 'json' || proto === 'form') { f.mac = '000000000000'; f.app = 'EdemPlayer'; }
      if (proto === 'jsonott') { f.mac = '000000000000'; f.app = 'OTT Navigator'; }
      return f;
    },
    _qs: function (f) {
      return Object.keys(f).map(function (k) { var v = f[k]; return encodeURIComponent(k) + '=' + encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : v); }).join('&');
    },
    _send: function (proto, cfg, params, opt) {
      var f = V._fields(proto, cfg, params);
      var o = { url: cfg.url, method: 'POST', timeout: (opt && opt.timeout) || 25000, engine: opt && opt.engine, headers: { 'User-Agent': V.UA, 'X-Api-Key': cfg.key, Accept: 'application/json' } };
      if (proto === 'form') { o.headers['Content-Type'] = 'application/x-www-form-urlencoded'; o.body = V._qs(f); }
      else { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(f); }
      return TV.http(o).then(function (r) {
        var snip = V._clean(String(r.text || '').replace(/\s+/g, ' ').slice(0, 160), cfg);
        var j = V._json(r.text);
        if (j && j.type === 'error') { var e3 = new Error(TV.t('vod_server_says', { e: j.description || j.message || 'error' })); e3.apiErr = true; e3.ms = r.ms; throw e3; }
        if (r.status >= 400) { var e = new Error('HTTP ' + r.status + (snip ? ': ' + snip : '')); e.http = r.status; e.ms = r.ms; throw e; }
        if (!j || typeof j !== 'object') {
          var e2 = new Error(TV.t('vod_notjson', { s: snip || '—' }) + V._oddChars(r.text)); e2.notJson = true; e2.ms = r.ms; throw e2;
        }
        Object.defineProperty(j, '_ms', { value: r.ms, enumerable: false });
        return j;
      });
    },
    // JSON с «мусором»: BOM, нулевые/управляющие символы, текст до или после объекта
    _json: function (t) {
      t = String(t == null ? '' : t);
      try { return JSON.parse(t); } catch (e) { /* дальше — очистка */ }
      var c = t.replace(/^\uFEFF/, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
      try { return JSON.parse(c); } catch (e) { /* */ }
      // невидимые «пробелы», недопустимые в JSON (неразрывный, нулевой ширины и т. п.), и табуляции/переводы строк внутри строк
      c = c.replace(/[\t\r\n\u00A0\u1680\u2000-\u200F\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]/g, ' ');
      try { return JSON.parse(c); } catch (e) { /* */ }
      // лишние запятые сервера: «[,{…}]», «{…},,{…}», «…,]» — убираем (внутри строк не трогаем)
      c = V._fixCommas(c);
      try { return JSON.parse(c); } catch (e) { /* */ }
      var a = c.indexOf('{'), b = c.lastIndexOf('}');
      if (a >= 0 && b > a) { try { return JSON.parse(c.slice(a, b + 1)); } catch (e) { /* */ } }
      // несколько объектов подряд — берём первый целый
      if (a >= 0) {
        var depth = 0, inStr = false, esc = false;
        for (var i = a; i < c.length; i++) {
          var ch = c[i];
          if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
          if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}' && --depth === 0) { try { return JSON.parse(c.slice(a, i + 1)); } catch (e) { break; } }
        }
      }
      return null;
    },
    _fixCommas: function (c) {
      var out = '', inStr = false, esc = false, last = '';
      for (var i = 0; i < c.length; i++) {
        var ch = c[i];
        if (inStr) { out += ch; if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') { inStr = false; last = '"'; } continue; }
        if (ch === '"') { inStr = true; out += ch; continue; }
        if (/\s/.test(ch)) { out += ch; continue; }
        if (ch === ',' && (last === '[' || last === ',' || last === '{')) continue;     // пустой элемент
        if ((ch === ']' || ch === '}') && last === ',') out = out.replace(/,(\s*)$/, '$1'); // запятая перед закрытием
        out += ch; last = ch;
      }
      return out;
    },
    // какие необычные символы в ответе (для сообщения об ошибке): «U+00A0×3, U+0009×1»
    _oddChars: function (t) {
      var m = {}, n = 0;
      String(t || '').replace(/[^\x20-\x7E\u0400-\u04FF]/g, function (ch) { var k = 'U+' + ('000' + ch.charCodeAt(0).toString(16).toUpperCase()).slice(-4); if (!m[k]) n++; m[k] = (m[k] || 0) + 1; return ch; });
      var keys = Object.keys(m).sort(function (a, b) { return m[b] - m[a]; }).slice(0, 6);
      return keys.length ? ' [' + keys.map(function (k) { return k + '×' + m[k]; }).join(', ') + '; ' + String(t || '').length + ' симв.]' : ' [' + String(t || '').length + ' симв.]';
    },
    // ключ не показываем нигде
    _clean: function (s, cfg) { return cfg && cfg.key ? String(s).split(cfg.key).join('***') : String(s); },
    request: function (params) {
      var cfg = V.config();
      if (!cfg) return Promise.reject(new Error(TV.t('vod_not_set')));
      var first = TV.store.get('vodProto', 'json');
      if (V.PROTOS.indexOf(first) < 0) first = 'json';
      // формат уже подтверждён — не перебираем (ошибка сервера показывается как есть)
      var order = TV.store.get('vodProtoOk', false) ? [first] : [first].concat(V.PROTOS.filter(function (x) { return x !== first; }));
      function attempt(i, firstErr) {
        if (i >= order.length) return Promise.reject(firstErr);
        return V._send(order[i], cfg, params).then(function (j) {
          TV.store.set('vodProto', order[i]); TV.store.set('vodProtoOk', true);
          return j;
        }).catch(function (e) {
          e.message = V._clean(e.message, cfg);
          if (e.code) throw e; // сеть недоступна — другие варианты не помогут
          return attempt(i + 1, firstErr || e);
        });
      }
      return attempt(0, null);
    },
    // Подробная проверка: сеть по шагам (DNS, прокси, TCP), затем варианты запроса. Ключ не показывается.
    diagnose: function (onLine) {
      var cfg = V.config();
      if (!cfg) return Promise.resolve([TV.t('vod_not_set')]);
      var lines = [];
      function add(l) { lines.push(l); if (onLine) onLine(lines); }
      var host = '';
      try { var u = new URL(cfg.url); host = u.protocol + '//' + u.host + u.pathname; } catch (e) { host = '?'; }
      add(TV.t('vod_diag_head', { host: host, n: cfg.key.length }));
      var names = { json: 'JSON key+mac+app', jsonkey: 'JSON key', jsonott: 'JSON key+mac (OTT)', form: 'form key+mac+app' };
      var netStep = window.native && window.native.netDiag ? window.native.netDiag(cfg.url) : Promise.resolve(null);
      var netBad = false;
      return netStep.then(function (d) {
        if (!d) return;
        add((d.proxy && d.proxy !== 'DIRECT' ? '• ' + TV.t('diag_proxy', { p: d.proxy }) : '• ' + TV.t('diag_direct')));
        if (!d.dns) return;
        if (!d.dns.ok) { netBad = true; add('✖ DNS: ' + TV.t('diag_dns_fail', { host: d.host, code: d.dns.code })); return; }
        add('✔ DNS: ' + d.host + ' → ' + d.dns.ips.slice(0, 3).join(', ') + ' (' + d.dns.ms + ' ms)');
        // подставной локальный адрес: его выдаёт VPN/прокси-программа (Proxifier, Amnezia, Clash…) и сама же перехватывает
        if (/^127\./.test(d.dns.ips[0]) && !/^127\.0\.0\.1$/.test(d.dns.ips[0]) && d.host !== 'localhost') add('⚠ ' + TV.t('diag_fakeip', { ip: d.dns.ips[0] }));
        if (d.tcp && d.tcp.ok) add('✔ TCP ' + d.dns.ips[0] + ':' + d.port + ' (' + d.tcp.ms + ' ms)');
        else if (d.tcp) { add('✖ TCP ' + d.dns.ips[0] + ':' + d.port + ': ' + d.tcp.code + ' (' + d.tcp.ms + ' ms) — ' + TV.t('diag_tcp_fail')); if (!d.proxy || d.proxy === 'DIRECT') netBad = true; }
      }).then(function () {
        var p = Promise.resolve(), ok = null;
        if (netBad) { add(TV.t('diag_blocked')); return lines; }
        V.PROTOS.forEach(function (pr) {
          p = p.then(function () {
            if (ok) return;
            return V._send(pr, cfg, { limit: 5 }, { timeout: 15000 }).then(function (j) {
              ok = pr;
              var secs = (j.items || []).filter(function (it) { return it && it.request && it.request.vc == null; }).length;
              add('✔ ' + names[pr] + ': ' + TV.t('vod_diag_ok', { ms: j._ms || 0, type: j.type || '—', n: secs, f: ((j.controls || {}).filters || []).length }));
            }).catch(function (e) {
              add('✖ ' + names[pr] + ': ' + V._clean(e.message || String(e), cfg) + (e.code ? ' [' + e.code + ']' : '') + (e.ms != null ? ' (' + e.ms + ' ms)' : ''));
              if (e.code) {
                ok = 'net';
                // для сравнения — тот же запрос напрямую (Node, без системного прокси)
                if (window.native && window.native.http) return V._send(pr, cfg, { limit: 5 }, { timeout: 15000, engine: 'node' }).then(function () {
                  add('✔ ' + TV.t('diag_node_ok'));
                }).catch(function (e2) { add('✖ ' + TV.t('diag_node_fail', { e: V._clean(e2.message || String(e2), cfg) })); });
              }
            });
          });
        });
        return p.then(function () {
          if (ok && ok !== 'net') { TV.store.set('vodProto', ok); TV.store.set('vodProtoOk', true); V.reset(); }
          if (ok === 'net') add(TV.t('diag_blocked'));
          return lines;
        });
      });
    },

    // Параметры запроса для элемента (как в ProIPTV: у раздела — flicks, у фильма/сериала — flick)
    reqFor: function (item, kind) {
      var r = {}, src = item.request || {};
      Object.keys(src).forEach(function (k) { r[k] = src[k]; });
      if (!r.cmd && r.fid != null && !r.filter) r.cmd = kind === 'list' ? 'flicks' : 'flick';
      return r;
    },

    // ---------- кэш списков на устройстве и фоновое обновление ----------
    // Первый раз список заполняется постранично на глазах; дальше он показывается из кэша сразу,
    // а свежая версия грузится фоном (по одному списку, без перерисовок) и подменяет старую целиком.
    TTL: 3 * 3600 * 1000,      // список в памяти старше — обновить фоном при открытии
    STALE: 10 * 60 * 1000,     // список из кэша устройства старше — обновить фоном
    bg: { queue: [], running: null },
    onBg: null,
    _host: function () { var c = V.config(); try { return c ? new URL(c.url).host : ''; } catch (e) { return ''; } },
    _dbKey: function (id) { return 'vod:' + V._host() + ':' + id; },
    _keyItem: function (it) { return it.request && (it.request.fid != null ? 'f' + it.request.fid : JSON.stringify(it.request)) || it.url || it.title; },
    _bgEmit: function () { if (V.onBg) try { V.onBg(V.bg.running, V.bg.queue.length); } catch (e) { /* */ } },
    // все страницы списка; onPage(n) — сколько уже получено; между страницами — пауза, чтобы не мешать интерфейсу
    _fetchAll: function (baseReq, onPage, gap) {
      var items = [], seen = {}, meta = null, total = 0, empty = 0, pages = 0;
      function page(offset) {
        pages++;
        var req = {}; Object.keys(baseReq).forEach(function (k) { req[k] = baseReq[k]; });
        req.limit = PAGE; if (offset) req.offset = offset;
        return V.request(req).then(function (j) {
          if (!meta) meta = { title: j.title, img: j.img, description: j.description, year: j.year, type: j.type };
          if (j.count) total = j.count;
          var next = null;
          (j.items || []).forEach(function (it) {
            if (!it || !it.type) return;
            if (it.type === 'next') { next = it.request && it.request.offset != null ? it.request.offset : (offset || 0) + PAGE; return; }
            var k = V._keyItem(it);
            if (seen[k]) return;
            seen[k] = 1; items.push(it);
          });
          // страница без фильмов (только «дальше») — считаем подряд идущие
          empty = (j.items || []).some(function (it) { return it && it.type && it.type !== 'next'; }) ? 0 : empty + 1;
          // конец: нет следующей страницы, указатель не продвинулся, 8 пустых страниц подряд или предел
          var more = next != null && next > (offset || 0) && items.length < 20000 && empty < 8 && pages < 400;
          if (onPage) onPage(items, !more, meta, total);
          if (!more) return { items: items, meta: meta, total: total };
          return new Promise(function (r) { setTimeout(r, gap || 0); }).then(function () { return page(next); });
        });
      }
      return page(0);
    },
    _save: function (id, c) {
      TV.idb.set(V._dbKey(id), { t: c.t, items: c.items, total: c.total, meta: c.meta, title: c.title });
    },
    _setItems: function (c, items) {
      c.items = items; c.seen = {};
      items.forEach(function (it) { c.seen[V._keyItem(it)] = 1; });
    },
    // поставить список в очередь фонового обновления
    refresh: function (id) {
      var c = V.cache[id];
      if (!c || !c.req || c.refreshing || V.bg.queue.indexOf(id) >= 0) return;
      V.bg.queue.push(id); V._bgEmit(); V._pump();
    },
    _pump: function () {
      if (V.bg.running || !V.bg.queue.length) return;
      var id = V.bg.queue.shift(), c = V.cache[id];
      if (!c) { V._pump(); return; }
      c.refreshing = true;
      var st = V.bg.running = { id: id, title: c.title || '', n: 0 };
      V._bgEmit();
      V._fetchAll(c.req, function (items) { st.n = items.length; V._bgEmit(); }, 150).then(function (r) {
        if (r.items.length || !c.items.length) {
          V._setItems(c, r.items); c.total = r.total; if (r.meta) c.meta = r.meta;
          c.t = Date.now(); c.error = null; c.done = true;
          V._save(id, c);
          c.emit(); // одна перерисовка — подмена списка целиком
        }
      }).catch(function (e) { c.bgError = String(e && e.message || e); }).then(function () {
        c.refreshing = false; V.bg.running = null; V._bgEmit();
        setTimeout(V._pump, 500);
      });
    },

    // Фильмы и сериалы из уже загруженных разделов (память или устройство) — для картинок на плитках
    // фильмы для постеров: сохранённые списки разделов, иначе — превью разделов
    sampleAny: function () {
      return V.sample().then(function (items) {
        if (items.length) return items;
        var secs = (V.root && V.root.sections) || [];
        return Promise.all(secs.map(function (sc) { return V.preview(sc).catch(function () { return null; }); }))
          .then(function (l) { return [].concat.apply([], l.map(function (pv) { return pv ? pv.items : []; })); });
      });
    },
    sample: function () {
      if (V._sample && Date.now() - V._sampleT < 60000) return V._sample;
      var secs = (V.root && V.root.sections) || [];
      V._sampleT = Date.now();
      V._sample = Promise.all(secs.map(function (sc) {
        var id = 'sec:' + JSON.stringify(sc.request), mem = V.cache[id];
        if (mem && mem.items.length) return mem.items;
        return TV.idb.get(V._dbKey(id)).then(function (sv) { return (sv && sv.items) || []; });
      })).then(function (lists) { return [].concat.apply([], lists); });
      return V._sample;
    },

    // Корень: разделы и фильтры (из кэша сразу, свежий — фоном)
    _parseRoot: function (j) {
      var sections = [], filters = [];
      (j.items || []).forEach(function (it) {
        if (!it || !it.request || it.request.vc != null) return;
        if (it.type && it.type !== 'category' && it.type !== 'videoportal') return;
        sections.push({ title: it.title || '—', request: it.request, img: it.img });
      });
      ((j.controls || {}).filters || []).forEach(function (f) {
        var items = (f.items || []).filter(function (x) { return x && x.request; });
        if (!items.length) return;
        var key = Object.keys(items[0].request).filter(function (k) { return k !== 'filter'; })[0] || '';
        filters.push({ title: f.title || key, key: key, items: items.map(function (x) { return { title: x.title, request: x.request }; }) });
      });
      return { title: j.title, sections: sections, filters: filters, search: !(j.controls && j.controls.search === false) };
    },
    loadRoot: function () {
      if (V.root) return Promise.resolve(V.root);
      var key = 'vodroot:' + V._host();
      function fresh() {
        return V.request({ limit: PAGE }).then(function (j) {
          var r = V._parseRoot(j); r.t = Date.now();
          TV.idb.set(key, r);
          return r;
        });
      }
      return TV.idb.get(key).then(function (saved) {
        if (saved && saved.sections && (saved.sections.length || saved.filters.length)) {
          V.root = saved;
          fresh().then(function (r) { V.root = r; }).catch(function () { /* остаётся кэш */ });
          return V.root;
        }
        return fresh().then(function (r) { V.root = r; return r; });
      });
    },
    genreFilter: function () {
      if (!V.root) return null;
      return V.root.filters.filter(function (f) { return /genre|жанр/i.test(f.key + ' ' + f.title); })[0] || null;
    },

    // Список (раздел, фильтр, сезон). onUpdate вызывается при изменениях.
    list: function (id, baseReq, onUpdate, title) {
      var c = V.cache[id];
      if (c) {
        if (onUpdate) { c.listeners.push(onUpdate); onUpdate(c); }
        if (c.done && !c.error && c.t && Date.now() - c.t > V.TTL) V.refresh(id);
        return c;
      }
      c = V.cache[id] = { items: [], seen: {}, done: false, error: null, total: 0, listeners: onUpdate ? [onUpdate] : [], meta: null, req: baseReq, title: title || '', t: 0 };
      c.emit = function () { c.listeners.forEach(function (f) { try { f(c); } catch (e) { console.error(e); } }); };
      TV.idb.get(V._dbKey(id)).then(function (saved) {
        if (saved && saved.items && saved.items.length) {
          // из кэша — сразу, затем фоновое обновление
          V._setItems(c, saved.items); c.total = saved.total || 0; c.meta = saved.meta; c.t = saved.t; c.done = true; c.cached = true;
          if (!c.title) c.title = saved.title || '';
          c.emit();
          if (Date.now() - (saved.t || 0) > V.STALE) V.refresh(id);
          return;
        }
        // первый раз — постранично, с показом по мере загрузки
        V._fetchAll(baseReq, function (items, last, meta, total) {
          V._setItems(c, items.slice()); c.total = total; if (meta && !c.meta) c.meta = meta;
          if (!last) c.emit();
        }).then(function () {
          c.done = true; c.t = Date.now(); c.emit();
          if (c.items.length) V._save(id, c);
        }).catch(function (e) { c.error = String(e && e.message || e); c.done = true; c.emit(); });
      });
      return c;
    },


    // Пересечение двух списков (год ∩ жанр): элементы первого, которые есть во втором
    listInter: function (id, parts, onUpdate) {
      var c = V.cache[id];
      if (c) { c.listeners.push(onUpdate); onUpdate(c); return c; }
      c = V.cache[id] = { items: [], seen: {}, done: false, error: null, listeners: [onUpdate], meta: null };
      c.emit = function () { c.listeners.forEach(function (f) { try { f(c); } catch (e) { /* */ } }); };
      function rebuild() {
        var a = V.cache[parts[0].id], b = V.cache[parts[1].id];
        if (!a || !b) return;
        var items = a.items.filter(function (it) { return b.seen[V._keyItem(it)]; });
        V._setItems(c, items);
        c.done = a.done && b.done; c.error = a.error || b.error; c.t = Math.min(a.t || 0, b.t || 0) || 0;
        c.emit();
      }
      parts.forEach(function (pt) { V.list(pt.id, pt.req, rebuild, pt.title); });
      return c;
    },

    // «Все жанры»: все разделы вместе (пересобирается при обновлении любого раздела)
    listAll: function (onUpdate) {
      var id = '__all__', c = V.cache[id];
      if (c) { c.listeners.push(onUpdate); onUpdate(c); return c; }
      c = V.cache[id] = { items: [], seen: {}, done: false, error: null, listeners: [onUpdate], meta: null };
      c.emit = function () { c.listeners.forEach(function (f) { try { f(c); } catch (e) { /* */ } }); };
      var secs = (V.root && V.root.sections) || [];
      var ids = secs.map(function (s) { return 'sec:' + JSON.stringify(s.request); });
      function rebuild() {
        var seen = {}, items = [], done = true, err = null;
        ids.forEach(function (sid) {
          var sc = V.cache[sid];
          if (!sc || !sc.done) done = false;
          if (sc && sc.error) err = sc.error;
          (sc ? sc.items : []).forEach(function (it) { var k = V._keyItem(it); if (!seen[k]) { seen[k] = 1; items.push(it); } });
        });
        c.items = items; c.seen = seen; c.done = done; c.error = err;
        c.emit();
      }
      if (!ids.length) { c.done = true; c.emit(); return c; }
      secs.forEach(function (s, i) { V.list(ids[i], V.reqFor(s, 'list'), rebuild, s.title); });
      return c;
    },

    // Карточка фильма/сериала
    item: function (it) {
      if (it.url && it.type === 'stream') return Promise.resolve(it);
      return V.request(V.reqFor(it, 'item'));
    },

    search: function (q) {
      return V.request({ cmd: 'search', query: q, limit: 100, offset: 0 }).then(function (j) {
        return (j.items || []).filter(function (it) { return it && (it.type === 'stream' || it.type === 'multistream'); });
      });
    },


    // ---------- серии сериала одним списком (с учётом сезонов) ----------
    _eps: {},
    episodes: function (series) {
      var k = V.keyOf(series);
      if (V._eps[k]) return V._eps[k];
      function seasonItems(it) {
        return new Promise(function (res) {
          var doneOnce = false;
          V.list('sea:' + JSON.stringify(it.request), V.reqFor(it, 'list'), function (c) { if (c.done && !doneOnce) { doneOnce = true; res(c.items); } });
        });
      }
      function walk(items, season, depth, out) {
        var p = Promise.resolve();
        items.forEach(function (it) {
          if (!it || it.type === 'next') return;
          if (it.type === 'category' && depth < 2) p = p.then(function () { return seasonItems(it).then(function (sub) { return walk(sub, it.title || season, depth + 1, out); }); });
          else if (it.type === 'stream') out.push({ type: 'stream', title: it.title, request: it.request, url: it.url, season: season || '' });
        });
        return p.then(function () { return out; });
      }
      var pr = V._eps[k] = V.item(series).then(function (card) { return walk((card && card.items) || [], '', 0, []); });
      pr.catch(function () { delete V._eps[k]; });
      return pr;
    },


    // ---------- сезоны, пришедшие отдельными элементами: «Сериал (1 сезон)», «Сериал. Сезон 2», «Сериал S03» ----------
    SEASON_RES: [
      /^(.*?)[\s.,:;\-–—(\[]*(\d{1,2})\s*(?:-?(?:й|ый|ий|th|nd|rd|st))?\s*(?:сезон|сез\.?|season)(?![a-zа-яё]).*$/i,
      /^(.*?)[\s.,:;\-–—(\[]*(?:сезон|сез\.?|season|staffel|saison|temporada)\s*(\d{1,2})\b.*$/i,
      /^(.*?)[\s.,:;\-–—(\[]*\bS(\d{1,2})(?:\s*E\d{1,3})?\b.*$/i
    ],
    seasonOf: function (title) {
      var t = String(title || '');
      for (var i = 0; i < V.SEASON_RES.length; i++) {
        var m = V.SEASON_RES[i].exec(t);
        if (m && m[1] && m[1].replace(/[\s.,:;\-–—(\[]+$/, '').length >= 2) {
          var base = m[1].replace(/[\s.,:;\-–—(\[/|]+$/, '').trim();
          return { base: base, n: parseInt(m[2], 10), key: V.normTitle(base) };
        }
      }
      return null;
    },
    normTitle: function (s) { return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\(\d{4}\)/g, '').replace(/[^a-zа-я0-9]+/gi, ' ').trim(); },
    // объединить сезоны одного сериала в папку { type:'group', title, seasons:[{n, item}] } (если сезонов ≥ 2)
    group: function (items) {
      var groups = {}, order = [];
      items.forEach(function (it) {
        if (!it || it.type === 'category' || it.type === 'group') { order.push(it); return; }
        var so = V.seasonOf(it.title);
        if (!so) { order.push(it); return; }
        var g = groups[so.key];
        if (!g) { g = groups[so.key] = { type: 'group', gk: 'g:' + so.key, title: so.base, seasons: [], year: '', img: '', imglr: '' }; order.push(g); }
        g.seasons.push({ n: so.n, item: it });
      });
      return order.map(function (x) {
        if (!x || x.type !== 'group') return x;
        if (x.seasons.length < 2) return x.seasons[0].item; // один сезон — как обычный элемент
        x.seasons.sort(function (a, b) { return a.n - b.n; });
        x.seasons.forEach(function (sn) {
          var y = parseInt(sn.item.year, 10) || 0;
          if (y > (parseInt(x.year, 10) || 0)) x.year = String(y);
          if (!x.img) x.img = sn.item.img || ''; if (!x.imglr) x.imglr = sn.item.imglr || '';
        });
        return x;
      });
    },

    // ---------- франшиза: сериалы с общим началом названия до «:» / « — » / «. » ----------
    // «Звёздный путь: Академия…», «Звёздный путь: Странные новые миры» → папка «Звёздный путь»
    FR_SEP: /^(.{2,}?)\s*(?::|\s[-–—]\s|\.\s)\s*(\S.*)$/,
    // дата в названии выпуска → число ГГГГММДД (для сортировки «новые сверху»)
    DATE_RE: /(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})|(\d{4})-(\d{2})-(\d{2})/,
    dateOf: function (t) {
      var m = V.DATE_RE.exec(String(t || ''));
      if (!m) return 0;
      if (m[4]) return +(m[4] + m[5] + m[6]);
      var y = +m[3]; if (y < 100) y += 2000;
      return y * 10000 + (+m[2]) * 100 + (+m[1]);
    },
    // «общее имя» элемента: без сезона, даты выпуска, «выпуск N», «эфир от …», «часть N»; подзаголовок — остаток
    showParts: function (x) {
      var t = String(x.title || '').trim(), rest = '';
      if (x.type !== 'group') { var so = V.seasonOf(t); if (so) t = so.base; }
      var m1 = /^(.{2,}?)[\s.,:;(\[–—-]*((?:выпуск|эфир|программа|эпизод|часть|ч\.|issue|episode|part)(?![a-zа-яё]).*|от\s+\d.*|\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}.*|\d{4}-\d{2}-\d{2}.*)$/i.exec(t);
      if (m1 && V.normTitle(m1[1])) { t = m1[1].replace(/[\s.,:;(\[–—-]+$/, ''); rest = m1[2].replace(/[)\]]+$/, '').trim(); }
      var m = V.FR_SEP.exec(t);
      if (m) return { base: m[1].trim(), short: (m[2].trim() + (rest ? ' · ' + rest : '')).trim() };
      return { base: t, short: rest };
    },
    franchise: function (items) {
      var buckets = {}, order = [];
      items.forEach(function (x) {
        if (!x || x.type === 'category' || x.type === 'franchise' || x.type === 'next') { order.push(x); return; }
        var sp = V.showParts(x), fk = V.normTitle(sp.base);
        if (!fk) { order.push(x); return; }
        var b = buckets[fk];
        if (!b) { b = buckets[fk] = { type: 'franchise', fk: 'fr:' + fk, title: sp.base, members: [], subs: 0, year: '', img: '', imglr: '' }; order.push(b); }
        x._short = sp.short; x._date = V.dateOf(x.title);
        if (sp.short) b.subs++; else b.title = sp.base;
        b.members.push(x);
      });
      var loc = TV.locale();
      return order.reduce(function (acc, b) {
        if (!b || b.type !== 'franchise') { acc.push(b); return acc; }
        // одиночки и ведра без подзаголовков — обратно как есть
        if (b.members.length < 2 || !b.subs) { b.members.forEach(function (x) { delete x._short; }); return acc.concat(b.members); }
        b.members.forEach(function (x) {
          x._fr = b.title;
          var y = parseInt(x.year, 10) || 0;
          if (y > (parseInt(b.year, 10) || 0)) b.year = String(y);
          if (!b.img) b.img = x.img || ''; if (!b.imglr) b.imglr = x.imglr || '';
        });
        b.members.sort(function (a, c) { if (!a._short !== !c._short) return a._short ? 1 : -1; return String(a._short).localeCompare(String(c._short), loc, { numeric: true }); });
        acc.push(b); return acc;
      }, []);
    },
    // сезоны + франшизы
    arrange: function (items) { return V.franchise(V.group(items)); },

    // серии для перехода ⏮ ⏭: при нескольких сезонах-элементах — все сезоны подряд
    episodesFor: function (ctx) {
      if (!ctx.seasons || ctx.seasons.length < 2) return V.episodes(ctx.item);
      var out = [], p = Promise.resolve();
      ctx.seasons.forEach(function (sn) {
        p = p.then(function () {
          return V.episodes(sn.item).then(function (eps) {
            var lbl = TV.t('vod_season_n', { n: sn.n });
            eps.forEach(function (e) { var c = {}; Object.keys(e).forEach(function (k) { c[k] = e[k]; }); c.season = e.season ? lbl + ' · ' + e.season : lbl; c._parent = sn.item; out.push(c); });
          }).catch(function () { /* сезон не загрузился — пропускаем */ });
        });
      });
      return p.then(function () { return out; });
    },

    // ---------- история просмотра и место остановки ----------
    keyOf: function (it) {
      if (!it) return '';
      if (it.request && it.request.fid != null) return 'f' + it.request.fid;
      return it.request ? JSON.stringify(it.request) : (it.url || it.title || '');
    },
    slim: function (it) {
      var o = {}; ['type', 'title', 'year', 'img', 'imglr', 'request', 'season'].forEach(function (k) { if (it[k] != null && it[k] !== '') o[k] = it[k]; });
      return o;
    },
    posOf: function (key) { return (TV.store.get('vodPos', {}) || {})[key] || null; },
    isDone: function (p) { return !!(p && p.dur && (p.dur - p.pos < 90 || p.pos / p.dur > 0.97)); },
    // с какого места продолжать: 0 — с начала (не смотрели или досмотрели)
    resumeAt: function (key) {
      var p = V.posOf(key);
      if (!p || p.pos < 15 || V.isDone(p)) return 0;
      return Math.max(0, p.pos - 3);
    },
    savePos: function (key, pos, dur) {
      if (!key || !(pos >= 0)) return;
      var m = TV.store.get('vodPos', {}) || {};
      m[key] = { pos: Math.round(pos), dur: Math.round(dur || 0), ts: Date.now() };
      var ks = Object.keys(m);
      if (ks.length > 400) ks.sort(function (a, b) { return m[a].ts - m[b].ts; }).slice(0, ks.length - 400).forEach(function (x) { delete m[x]; });
      TV.store.set('vodPos', m);
    },
    history: function (sec) {
      var h = TV.store.get('vodHistory', []) || [];
      return h.filter(function (e) { return !sec || e.sec === sec; }).sort(function (a, b) { return b.ts - a.ts; });
    },
    // фильм/сериал просмотрен: в истории одна запись на фильм или сериал (у сериала — последняя серия)
    touch: function (item, ep, extra) {
      var k = (extra && extra.gk) || V.keyOf(item), h = TV.store.get('vodHistory', []) || [];
      var old = h.filter(function (e) { return e.k === k; })[0];
      h = h.filter(function (e) { return e.k !== k; });
      var e = { k: k, sec: (old && old.sec) || V.secOf(item), item: V.slim(item), ts: Date.now() };
      if (extra && extra.title) e.item.title = extra.title;
      if (extra && extra.img && !e.item.img) e.item.img = extra.img;
      if (ep) e.ep = V.slim(ep);
      if (extra && extra.gk) { e.gk = extra.gk; e.seasons = (extra.seasons || []).map(function (sn) { return { n: sn.n, item: V.slim(sn.item) }; }); }
      h.unshift(e);
      TV.store.set('vodHistory', h.slice(0, 150));
    },
    forget: function (k) { TV.store.set('vodHistory', (TV.store.get('vodHistory', []) || []).filter(function (e) { return e.k !== k; })); },
    clearHistory: function () { TV.store.set('vodHistory', []); TV.store.set('vodPos', {}); },
    // в каком разделе фильм: по уже загруженным спискам разделов, иначе по типу
    secOf: function (item) {
      var k = V.keyOf(item), secs = (V.root && V.root.sections) || [];
      for (var i = 0; i < secs.length; i++) {
        var id = 'sec:' + JSON.stringify(secs[i].request), c = V.cache[id];
        if (c && c.seen[k]) return id;
      }
      var re = item.type === 'multistream' ? /сериал|serial|series|серіал|serie/i : /фильм|кино|movie|film|фільм|película/i;
      for (var j = 0; j < secs.length; j++) if (re.test(secs[j].title)) return 'sec:' + JSON.stringify(secs[j].request);
      return null;
    },


    // ---------- превью раздела для плитки: постеры и количество ----------
    // Полный список (из памяти или с устройства), иначе — одна короткая страница с сервера (хранится сутки)
    _prev: {},
    preview: function (sec) {
      var req = V.reqFor(sec, 'list');
      return V.previewReq('sec:' + JSON.stringify(sec.request), req);
    },
    // превью любого списка (раздел, жанр, год): id — ключ списка, req — запрос его первой страницы
    previewReq: function (sid, baseReq) {
      if (V._prev[sid]) return V._prev[sid];
      var mem = V.cache[sid];
      var fromItems = function (items, count) { return { items: items.filter(function (x) { return x && (x.imglr || x.img); }).slice(0, 40), count: count }; };
      if (mem && mem.done && mem.items.length) return Promise.resolve(fromItems(mem.items, mem.items.length));
      var key = 'vodprev:' + V._host() + ':' + sid;
      var pr = V._prev[sid] = TV.idb.get(V._dbKey(sid)).then(function (full) {
        if (full && full.items && full.items.length) return fromItems(full.items, full.items.length);
        return TV.idb.get(key).then(function (pv) {
          if (pv && Date.now() - pv.t < 24 * 3600 * 1000) return pv;
          // запросы превью — по очереди (не нагружать сервер); сбой одного не останавливает остальные
          var job = (V._prevQ || Promise.resolve()).then(function () {
            var req = {}; Object.keys(baseReq).forEach(function (k) { req[k] = baseReq[k]; }); req.limit = 24;
            return V.request(req).then(function (j) {
              var items = (j.items || []).filter(function (x) { return x && x.type && x.type !== 'next' && x.type !== 'category'; });
              var r = fromItems(items, j.count || 0); r.t = Date.now();
              TV.idb.set(key, r);
              return r;
            });
          });
          V._prevQ = job.catch(function () { /* следующий в очереди всё равно пойдёт */ });
          return job;
        });
      });
      pr.catch(function () { delete V._prev[sid]; });
      return pr;
    },
    // постеры для плитки: свежие (по году) или по одному из разных разделов
    posters: function (items, n, newest) {
      var l = items.filter(function (x) { return x && (x.imglr || x.img); });
      if (newest) l = l.slice().sort(function (a, b) { return (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0); });
      return l.slice(0, n || 3).map(function (x) { return x.imglr || x.img; });
    },

    // Сортировка: по алфавиту или «новые сверху» (год, затем название)
    sorted: function (items, mode) {
      var loc = TV.locale();
      return items.slice().sort(function (a, b) {
        if (mode === 'new') {
          var ya = parseInt(a.year, 10) || 0, yb = parseInt(b.year, 10) || 0;
          if (ya !== yb) return yb - ya;
        }
        return String(a.title || '').localeCompare(String(b.title || ''), loc, { numeric: true });
      });
    }
  };
})(window.TV);
