(function (TV) {
  'use strict';
  var el = TV.el, Nav = TV.Nav, EPG = TV.EPG, P = TV.Player;
  var FAV = '__fav__';
  var ALL = '__all__';
  // отображаемое имя группы (служебные — переводятся)
  function groupLabel(g) { return g === FAV ? TV.t('favorites') : g === ALL ? TV.t('all_channels') : g; }

  // Адреса с учётом настроек, сохранённых на устройстве
  // Скрытые языки (хранятся на устройстве); пусто — показываются все
  TV.hiddenLangs = function () {
    var h = TV.store.get('hiddenLangs', []);
    // старый формат (названия по-русски) — сбрасываем
    if (h.some(function (x) { return /[^a-z-]/.test(x); })) { h = []; TV.store.set('hiddenLangs', h); }
    return h;
  };
  // Ручная разметка языков: { ch: { ключ канала: код }, grp: { категория: код } } — хранится на устройстве
  var ovCache = null;
  TV.langOv = function () { if (!ovCache) { ovCache = TV.store.get('langOverrides', null) || { ch: {}, grp: {} }; ovCache.ch = ovCache.ch || {}; ovCache.grp = ovCache.grp || {}; } return ovCache; };
  TV.setLangOv = function (kind, id, code) {
    var o = TV.langOv();
    if (code) o[kind][id] = code; else delete o[kind][id];
    TV.store.set('langOverrides', o);
    TV.updateLangState();
  };
  TV.resetLangOvCache = function () { ovCache = null; };
  TV.groupLang = function (g) { return TV.langOv().grp[g] || TV.detectLang('', g, ''); };
  TV.chLang = function (c) { var o = TV.langOv(); return o.ch[c.key] || o.grp[c.group] || c.lang; };
  // Состояние фильтра пересчитывается при изменениях: если не отмечен ни один язык — фильтр не действует
  TV._noFilter = true;
  TV.updateLangState = function () {
    var h = TV.hiddenLangs();
    var present = TV.App && TV.App.channels.length ? TV.App.languages().map(function (l) { return l.name; }) : [];
    TV._noFilter = !h.length || !present.length || present.every(function (p) { return h.indexOf(p) >= 0; });
  };
  TV.langVisible = function (c) { if (TV._noFilter) return true; return TV.hiddenLangs().indexOf(TV.chLang(c)) < 0; };
  // Недавно просмотренные: { ключ канала: время последнего просмотра (мс) } — хранится на устройстве
  TV.recent = function () { return TV.store.get('recent', {}) || {}; };
  TV.markWatched = function (key) {
    var r = TV.recent(); r[key] = Date.now();
    var keys = Object.keys(r).sort(function (a, b) { return r[b] - r[a]; });
    if (keys.length > 200) keys.slice(200).forEach(function (k) { delete r[k]; });
    TV.store.set('recent', r);
  };
  // Отметки неудачного воспроизведения: { ключ: { l: время ошибки прямого эфира, a: архива/фильма } }
  TV.playErrs = function () { return TV.store.get('playErr', {}) || {}; };
  TV.markErr = function (key, kind) {
    if (!key) return;
    var m = TV.playErrs(), e = m[key] || {};
    if (e[kind]) return;
    e[kind] = Date.now(); m[key] = e;
    var ks = Object.keys(m);
    if (ks.length > 500) ks.sort(function (a, b) { return Math.max(m[a].l || 0, m[a].a || 0) - Math.max(m[b].l || 0, m[b].a || 0); }).slice(0, ks.length - 500).forEach(function (k) { delete m[k]; });
    TV.store.set('playErr', m);
  };
  TV.clearErr = function (key, kind) {
    var m = TV.playErrs(), e = m[key];
    if (!e || !e[kind]) return;
    delete e[kind];
    if (!e.l && !e.a) delete m[key];
    TV.store.set('playErr', m);
  };
  // класс для названия: прямой эфир не работал — светло-красный, архив/фильм — жёлтый
  TV.errClass = function (key) {
    var e = TV.playErrs()[key];
    return !e ? '' : e.l ? ' errlive' : e.a ? ' errplay' : '';
  };
  TV.errTitle = function (key) {
    var e = TV.playErrs()[key]; if (!e) return '';
    var t = function (ms) { return new Date(ms).toLocaleString(TV.locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
    return [e.l ? TV.t('err_live_at', { t: t(e.l) }) : '', e.a ? TV.t('err_play_at', { t: t(e.a) }) : ''].filter(Boolean).join('\n');
  };
  // История поиска: последние запросы первыми, без повторов (регистр не важен)
  TV.searchHist = function () { return TV.store.get('searchHist', []) || []; };
  TV.rememberSearch = function (q) {
    q = String(q || '').trim(); if (q.length < 2) return;
    var l = TV.searchHist().filter(function (x) { return x.toLowerCase() !== q.toLowerCase(); });
    l.unshift(q); TV.store.set('searchHist', l.slice(0, 30));
  };
  TV.forgetSearch = function (q) { TV.store.set('searchHist', TV.searchHist().filter(function (x) { return x !== q; })); };
  TV.playlistUrl = function () { return TV.store.get('playlistUrl', ''); };
  // Адреса программы передач, добавленные пользователем (в порядке приоритета)
  TV.epgUserUrls = function () {
    var list = TV.store.get('epgUrls', null);
    if (!list) { var old = TV.store.get('epgUrl', ''); list = old ? [old] : []; }
    return list;
  };
  TV.epgAllUrls = function (playlistEpg) {
    var all = TV.epgUserUrls().concat(playlistEpg || [], TV_CONFIG.epgDefaults);
    return all.filter(function (u, i) { return u && all.indexOf(u) === i; });
  };

  var App = TV.App = {
    channels: [], groups: [], byKey: {}, favs: [],
    stack: [], playing: false,

    // ---------- запуск ----------
    start: function () {
      // обновление интерфейса с GitHub: готово — предлагаем перезапуск (один раз на версию)
      if (window.native && window.native.update) window.native.update.onEvent(function (st) { App.onUpdate(st); });
      // фоновое обновление медиатеки — маленький индикатор рядом с часами
      TV.Vod.onBg = function (run, queued) {
        var b = document.getElementById('bgind'); if (!b) return;
        if (!run) { b.classList.add('hidden'); return; }
        b.innerHTML = '';
        b.appendChild(el('span', 'bgspin', '⟳'));
        b.appendChild(el('span', '', TV.t('vod_bg', { title: run.title || TV.t('vod'), n: run.n.toLocaleString(TV.locale()) }) + (queued ? ' +' + queued : '')));
        b.title = TV.t('vod_bg_hint');
        b.classList.remove('hidden');
      };
      var self = this;
      TV.I18n.init();
      this.screen = document.getElementById('screen');
      this.crumbs = document.getElementById('crumbs');
      Nav.setRoot(document.getElementById('app'));
      TV.bindMouse(document.getElementById('app'));
      P.init(document.getElementById('video'));
      PlayerUI.init();
      this.favs = TV.store.get('favs', []);
      document.addEventListener('keydown', function (e) { self.onKey(e, true); }, true);
      document.addEventListener('keyup', function (e) { self.onKey(e, false); }, true);
      // боковая кнопка мыши «назад»
      window.addEventListener('mouseup', function (e) { if (e.button === 3) { e.preventDefault(); self.back(); } });
      if (window.native && window.native.onBack) window.native.onBack(function () { self.back(); });
      // закрытие окна (крестик, Alt+F4) — тоже с вопросом
      if (window.native && window.native.onAskExit) window.native.onAskExit(function () { if (!Dialog.open) self.askExit(); });
      setInterval(function () { self.tickClock(); }, 15000); this.tickClock();
      this.loadPlaylist();
    },

    loadPlaylist: function () {
      var self = this;
      if (!TV.Source.configured()) {
        // первый запуск: источник не задан — сразу в настройки
        this.hideLoading();
        if (this._errorRoot) { this._errorRoot = null; Nav.setRoot(document.getElementById('app')); }
        this.channels = []; this.groups = []; this.byKey = {};
        this.stack = [{ name: 'categories', params: {} }];
        this.push('settings', { welcome: true });
        return;
      }
      this.showLoading(TV.t('loading_playlist'));
      TV.Source.load().then(function (text) {
        self.applyPlaylist(TV.parseM3U(text));
      }).catch(function (err) {
        self.showError(TV.t('load_failed', { err: (err && err.message || err) }));
      });
    },

    applyPlaylist: function (pl) {
      var self = this;
      this.channels = pl.channels;
      this.byKey = {};
      var gmap = {};
      this.groups = [];
      pl.channels.forEach(function (c) {
        if (!self.byKey[c.key]) self.byKey[c.key] = c;
        var g = gmap[c.group];
        if (!g) { g = gmap[c.group] = { name: c.group, list: [] }; self.groups.push(g); }
        g.list.push(c);
      });
      this.hideLoading();
      if (this._errorRoot) { this._errorRoot = null; Nav.setRoot(document.getElementById('app')); }
      this.playlistEpg = pl.epgUrls;
      TV.updateLangState();
      var urls = TV.epgAllUrls(pl.epgUrls);
      if (!this._epgBound) { this._epgBound = true; EPG.onUpdate(function () { self.refreshOnEpg(); }); }
      EPG.init(this.allUnique(), urls);
      this.stack = [];
      this.push('categories', {});
    },

    groupList: function (name) {
      if (name === ALL) {
        return this.uniqueChannels().sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });
      }
      var g = this.groups.filter(function (x) { return x.name === name; })[0];
      return g ? g.list.filter(TV.langVisible) : [];
    },

    // все каналы без повторов (для программы передач — без учёта фильтра языков)
    allUnique: function () {
      var seen = {}, out = [];
      this.channels.forEach(function (c) { if (!seen[c.key]) { seen[c.key] = 1; out.push(c); } });
      return out;
    },
    // видимые каналы — с учётом выбранных языков
    uniqueChannels: function () { return this.allUnique().filter(TV.langVisible); },

    // языки в плейлисте: [{ name, count }], русский — первым
    languages: function () {
      var m = {};
      this.allUnique().forEach(function (c) { var l = TV.chLang(c); m[l] = (m[l] || 0) + 1; });
      return Object.keys(m).map(function (k) { return { name: k, count: m[k] }; })
        .sort(function (a, b) { return (b.name === 'ru') - (a.name === 'ru') || b.count - a.count || a.name.localeCompare(b.name); });
    },

    showLoading: function (msg) {
      var l = document.getElementById('loading');
      l.innerHTML = ''; l.appendChild(el('div', 'spin')); l.appendChild(el('div', '', msg));
      l.classList.remove('hidden');
    },
    hideLoading: function () { document.getElementById('loading').classList.add('hidden'); },
    showError: function (msg) {
      var self = this, l = document.getElementById('loading');
      l.innerHTML = '';
      l.appendChild(el('div', 'err', msg));
      var b = el('div', 'btn', TV.t('retry')); b.setAttribute('data-nav', '');
      b.tvOk = function () { self.loadPlaylist(); };
      var row = el('div', 'errbtns'); row.appendChild(b);
      var b2 = el('div', 'btn', TV.t('settings')); b2.setAttribute('data-nav', '');
      b2.tvOk = function () {
        self.hideLoading(); self._errorRoot = null;
        Nav.setRoot(document.getElementById('app'));
        self.stack = [{ name: 'categories', params: {} }];
        self.push('settings', {});
      };
      row.appendChild(b2);
      l.appendChild(row);
      l.classList.remove('hidden');
      Nav.setRoot(l); if (!l._mouse) { l._mouse = true; TV.bindMouse(l); } Nav.focus(b);
      this._errorRoot = l;
    },

    tickClock: function () {
      var c = document.getElementById('clock');
      if (c) c.textContent = TV.fmtTime(TV.now());
    },

    // Вкладка «Облако»: резервная копия настроек

    onUpdate: function (st) {
      this._upd = st;
      var top = this.stack[this.stack.length - 1];
      if (top && top.name === 'settings' && top.params.tab === 'sys' && !this.playing && !Dialog.open) { top.focus = Nav.current && Nav.current.getAttribute('data-key'); this.render(); }
      if (st.state === 'ready' && this._askedUpd !== st.version) {
        this._askedUpd = st.version;
        if (this.playing || Dialog.open) { TV.toast(TV.t('upd_ready_later', { v: st.version }), 6000); return; }
        Dialog.show(TV.t('upd_ready_q', { v: st.version }), [[TV.t('upd_restart'), true], [TV.t('upd_later'), false]], 0, function (yes) {
          if (yes) window.native.update.restart(); else TV.toast(TV.t('upd_ready_later', { v: st.version }), 5000);
        });
      } else if (st.state === 'shell' && this._askedShell !== st.version) {
        this._askedShell = st.version;
        TV.toast(TV.t('upd_shell', { v: st.version }), 8000);
      }
    },
    // Раздел «Обновления» (вкладка «Вид»)
    updSection: function (wrap, section, btnRow, button, rerender) {
      var self = this, U = window.native && window.native.update;
      section(TV.t('upd_title'));
      if (!U) { wrap.appendChild(el('div', 'shint', TV.t('upd_na'))); return; }
      var info = el('div', 'sinfo updinfo', ''); wrap.appendChild(info);
      var st = el('div', 'shint updst', ''); wrap.appendChild(st);
      function show(i) {
        info.textContent = TV.t('upd_ver', { ui: i.ui, shell: i.app }) + (i.ui !== i.app ? ' · ' + TV.t('upd_from_gh') : '') + (i.repo ? ' · GitHub: ' + i.repo : '');
        var s2 = self._upd || i.status || {};
        st.classList.toggle('warnt', s2.state === 'error' || s2.state === 'shell');
        st.textContent = !i.repo ? TV.t('upd_norepo') : s2.state ? TV.t('upd_st_' + s2.state, { v: s2.version || '', e: s2.error || '', p: s2.progress || 0 }) : '';
        // откуда пришёл ответ и какой адрес не сработал (новые оболочки сообщают это)
        if (s2.src) st.textContent += ' · ' + TV.t('upd_src', { s: s2.src });
        if (s2.srcErr && s2.state !== 'error') st.textContent += ' · ' + TV.t('upd_src_err', { e: s2.srcErr });
      }
      U.info().then(show);
      var row = btnRow('updbtns');
      button(row, TV.t('upd_check'), 'updchk', function () {
        st.classList.remove('warnt'); st.textContent = TV.t('upd_st_checking');
        U.check().then(function (s3) { self._upd = s3; U.info().then(show); if (s3.state === 'ready') self.onUpdate(s3); });
      });
      if ((self._upd || {}).state === 'ready') button(row, TV.t('upd_restart'), 'updrst', function () { U.restart(); });
    },

    // Вкладка «Медиатека»: ссылка VPortal (отдельно от способа подключения ТВ), проверка, история
    vodTab: function (wrap, d, section, field, btnRow, button, rerender) {
      var self = this;
      section(TV.t('vod_section'));
      var inp = field(TV.t('vod_field'), 'vportal', 'portal::[key:…]http://…/api/v1/', TV.t('vod_field_hint'));
      inp.type = 'password'; // ключ не светим на экране
      var out = el('div', 'sinfo vdiag', ''); 
      function store() {
        var vp = (d.vportal || '').trim();
        if (vp && !TV.Vod.parse(vp)) { TV.toast(TV.t('vod_bad')); return false; }
        if (vp !== TV.store.get('vportal', '')) { TV.store.set('vportal', vp); TV.store.set('vodProtoOk', false); TV.Vod.reset(); }
        return true;
      }
      var row = btnRow('vodbtns');
      var sv = button(row, TV.t('save'), 'vsave', function () { if (store()) { TV.toast(TV.t('vod_saved')); self.render(); } });
      button(row, TV.t('vod_check'), 'vcheck', function () {
        if (!store()) return;
        out.classList.remove('warnt');
        out.textContent = TV.t('vod_checking');
        function show(lines) {
          out.innerHTML = '';
          lines.forEach(function (l) { out.appendChild(el('div', /^[✖⚠]/.test(l) ? 'warnt' : '', l)); });
        }
        TV.Vod.diagnose(show).then(show);
      });
      row._last = sv;
      wrap.appendChild(out);
      section(TV.t('vod_hist'));
      var hr = btnRow('vodhist');
      button(hr, TV.t('vod_hist_clear') + ' (' + TV.Vod.history().length + ')', 'vhclear', function () {
        Dialog.show(TV.t('vod_hist_q'), [[TV.t('yes'), true], [TV.t('no'), false]], 1, function (yes) {
          if (!yes) return;
          TV.Vod.clearHistory(); TV.toast(TV.t('vod_hist_cleared')); rerender('vhclear');
        });
      });
    },

    cloudTab: function (wrap, d, section, field, btnRow, button, rerender) {
      var self = this;
      section(TV.t('cloud_title'));
      wrap.appendChild(el('div', 'shint', TV.t('cloud_hint')));
      // код синхронизации этого устройства
      var mine = el('div', 'cloudid'); wrap.appendChild(mine);
      function showMine() {
        TV.Cloud.current(false).then(function (cur) {
          mine.innerHTML = '';
          if (!cur) { mine.appendChild(el('div', 'shint', TV.t('cloud_code_new'))); return; }
          mine.appendChild(el('div', 'shint', TV.t('cloud_uses_code')));
          mine.appendChild(el('div', 'synccode', cur.label));
          mine.appendChild(el('div', 'shint', TV.t('cloud_code_info')));
        });
      }
      showMine();
      if (d.cloudKey == null) d.cloudKey = '';
      field(TV.t('cloud_key'), 'cloudKey', TV.t('cloud_key_ph'), TV.t('cloud_key_hint'));
      // где хранить: Яндекс.Диск или свой сервер
      section(TV.t('cloud_store'));
      var prov = TV.Cloud.provider();
      var prow = btnRow('cprov');
      [['yadisk', TV.t('cloud_p_yadisk')], ['url', TV.t('cloud_p_url')]].forEach(function (m) {
        button(prow, (prov === m[0] ? '◉ ' : '○ ') + m[1], 'cprov:' + m[0], function () { TV.store.set('cloudProvider', m[0]); rerender('cprov:' + m[0]); }, prov === m[0] ? 'sel' : '');
      });
      var status = el('div', 'sinfo cstatus', '');
      if (prov === 'yadisk') {
        if (d.yaToken == null) d.yaToken = TV.store.get('yaToken', '');
        if (d.yaFolder == null) d.yaFolder = TV.store.get('yaFolder', '') || 'EdemPlayer';
        var tk = field(TV.t('ya_token'), 'yaToken', TV.t('ya_token_ph'), TV.t('ya_token_hint'));
        tk.type = 'password';
        tk.addEventListener('change', function () { TV.store.set('yaToken', (d.yaToken || '').trim()); });
        var fd = field(TV.t('ya_folder'), 'yaFolder', 'EdemPlayer', TV.t('ya_folder_hint'));
        fd.addEventListener('change', function () { TV.store.set('yaFolder', (d.yaFolder || '').trim()); });
        var yr = btnRow('yabtns');
        button(yr, TV.t('ya_get_token'), 'yatok', function () {
          var url = 'https://yandex.ru/dev/disk/poligon/';
          if (window.native && window.native.openUrl) window.native.openUrl(url);
          else window.open(url, '_blank');
          TV.toast(TV.t('ya_open_hint', { url: url }), 6000);
        });
        button(yr, TV.t('ya_check'), 'yacheck', function () {
          TV.store.set('yaToken', (d.yaToken || '').trim()); TV.store.set('yaFolder', (d.yaFolder || '').trim());
          status.classList.remove('warnt'); status.textContent = TV.t('cloud_busy');
          TV.Cloud.yaCheck().then(function (r) {
            status.textContent = TV.t('ya_ok', { login: r.login, free: r.free > 0 ? (r.free / 1073741824).toFixed(1) + ' GB' : '—' });
          }).catch(function (e) { status.textContent = e.message || String(e); status.classList.add('warnt'); });
        });
      } else {
        // адрес хранилища: textdb.online по умолчанию или свой сервер
        if (d.cloudUrl == null) d.cloudUrl = TV.store.get('cloudUrl', '');
        var cu = field(TV.t('cloud_url'), 'cloudUrl', 'https://textdb.online', TV.t('cloud_url_hint'), 'url');
        cu.addEventListener('change', function () {
          var u = (d.cloudUrl || '').trim();
          if (u && !/^https?:\/\/\S+$/i.test(u)) { TV.toast(TV.t('url_bad')); return; }
          TV.store.set('cloudUrl', u); TV.toast(TV.t('cloud_url_saved', { host: TV.Cloud.host() }));
        });
      }
      wrap.appendChild(status);
      // введённый код важнее; без него — код этого устройства (при сохранении создаётся)
      function secret(create) {
        if ((d.cloudKey || '').trim()) {
          var p = TV.Cloud.parseInput(d.cloudKey);
          if (!p) { TV.toast(TV.t('cloud_bad_code')); status.textContent = TV.t('cloud_bad_code'); return Promise.resolve(null); }
          return Promise.resolve(p);
        }
        return TV.Cloud.current(create);
      }
      function busy(on) { wrap.classList.toggle('busy', on); if (on) status.textContent = TV.t('cloud_busy'); }
      function fail(e) {
        busy(false);
        var m = String(e && e.message || e);
        status.textContent = m === 'decrypt' ? TV.t('cloud_badkey') : (e && e.plain ? m : TV.t('cloud_err', { e: m }));
        status.classList.add('warnt');
      }
      function withSecret(create, fn) {
        if (prov === 'url') {
          var u = (d.cloudUrl || '').trim();
          if (!u || /^https?:\/\/\S+$/i.test(u)) TV.store.set('cloudUrl', u);
        } else {
          TV.store.set('yaToken', (d.yaToken || '').trim()); TV.store.set('yaFolder', (d.yaFolder || '').trim());
        }
        secret(create).then(function (s) {
          if (!s) { if (!status.textContent) { status.textContent = TV.t('cloud_need_key'); TV.toast(TV.t('cloud_need_key')); } return; }
          status.classList.remove('warnt');
          fn(s);
        });
      }
      var row = btnRow('cloudbtns');
      button(row, TV.t('cloud_save'), 'csave', function () {
        withSecret(true, function (s) {
          busy(true);
          TV.store.set('syncCode', s.code);
          TV.Cloud.save(s.secret).then(function () {
            busy(false); status.textContent = TV.t('cloud_saved'); TV.toast(TV.t('cloud_saved'));
            showMine();
          }).catch(fail);
        });
      });
      button(row, TV.t('cloud_load'), 'cload', function () {
        withSecret(false, function (s) {
          Dialog.show(TV.t('cloud_q_load'), [[TV.t('yes'), true], [TV.t('no'), false]], 1, function (yes) {
            if (!yes) return;
            busy(true);
            TV.Cloud.load(s.secret).then(function (r) {
              busy(false);
              if (!r) { status.textContent = TV.t('cloud_none'); return; }
              TV.resetLangOvCache();
              self.favs = TV.store.get('favs', []);
              TV.I18n.init();
              var v = document.getElementById('video');
              v.volume = Math.max(0, Math.min(1, TV.store.get('volume', 1))); v.muted = !!TV.store.get('muted', false);
              TV.toast(TV.t('cloud_loaded'));
              self.loadPlaylist();
            }).catch(fail);
          });
        });
      });
      button(row, TV.t('cloud_delete'), 'cdel', function () {
        withSecret(false, function (s) {
          Dialog.show(TV.t('cloud_q_delete'), [[TV.t('yes'), true], [TV.t('no'), false]], 1, function (yes) {
            if (!yes) return;
            busy(true);
            TV.Cloud.remove(s.secret).then(function () { busy(false); status.textContent = TV.t('cloud_deleted'); TV.toast(TV.t('cloud_deleted')); }).catch(fail);
          });
        });
      });
      button(row, TV.t('cloud_check'), 'ccheck', function () {
        withSecret(false, function (s) {
          busy(true);
          TV.Cloud.fetchRecord(s.secret).then(function (rec) {
            busy(false);
            status.textContent = rec ? TV.t('cloud_found', { date: new Date(rec.t).toLocaleString(TV.locale()) }) : TV.t('cloud_none');
          }).catch(fail);
        });
      });

      // ---------- перенос через файл ----------
      section(TV.t('file_title'));
      wrap.appendChild(el('div', 'shint', TV.t('file_hint2')));
      var fstat = el('div', 'sinfo', ''); 
      var frow = btnRow('filebtns');
      button(frow, TV.t('file_export'), 'fexp', function () {
        TV.Cloud.exportFile().then(function (name) { fstat.textContent = TV.t('file_exported', { name: name }); }).catch(function (e) { fstat.textContent = TV.t('cloud_err', { e: e.message || e }); });
      });
      var fpick = el('input'); fpick.type = 'file'; fpick.accept = '.json,application/json'; fpick.style.display = 'none';
      fpick.addEventListener('change', function () {
        var f = fpick.files && fpick.files[0]; if (!f) return;
        var rd = new FileReader();
        rd.onload = function () {
          Dialog.show(TV.t('file_q_import'), [[TV.t('yes'), true], [TV.t('no'), false]], 1, function (yes) {
            if (!yes) return;
            try {
              TV.Cloud.importText(String(rd.result || '')).then(function () {
                TV.resetLangOvCache(); self.favs = TV.store.get('favs', []); TV.I18n.init();
                var v = document.getElementById('video');
                v.volume = Math.max(0, Math.min(1, TV.store.get('volume', 1))); v.muted = !!TV.store.get('muted', false);
                TV.toast(TV.t('file_imported'));
                self.loadPlaylist();
              });
            } catch (e) { fstat.textContent = TV.t('file_bad'); fstat.classList.add('warnt'); }
          });
        };
        rd.readAsText(f, 'utf-8');
        fpick.value = '';
      });
      wrap.appendChild(fpick);
      button(frow, TV.t('file_import'), 'fimp', function () { fpick.click(); });
      wrap.appendChild(fstat);

    },

    // Медиатека: открыть элемент списка (папка → список, фильм/сериал → карточка)
    openVodItem: function (it) {
      if (it.type === 'franchise') { this.push('vodfranchise', { fr: it }); return; }
      if (it.type === 'group') { this.push('vodseasons', { group: it }); return; }
      if (it.type === 'category') this.push('vodlist', { id: 'cat:' + JSON.stringify(it.request), req: TV.Vod.reqFor(it, 'list'), title: it.title });
      else this.push('vodmovie', { item: it });
    },
    // Запуск фильма или серии: ctx = { item (фильм или сериал), ep (серия), url, meta, fromStart }
    // Продолжает с места остановки; если не смотрели или досмотрели — с начала.
    vodPlay: function (ctx) {
      var V = TV.Vod, series = !!ctx.ep, target = series ? ctx.ep : ctx.item, key = V.keyOf(target);
      var getUrl = ctx.url ? Promise.resolve({ url: ctx.url }) : V.item(target);
      if (!ctx.url && !target.url) TV.toast(TV.t('vod_loading'), 1500);
      getUrl.then(function (j) {
        var url = j && (j.url || (j.variants && (j.variants.auto || j.variants[Object.keys(j.variants)[0]])));
        if (!url) { TV.toast(TV.t('vod_noplay')); return; }
        var m = ctx.meta || {};
        var base = m.title || ctx.item.title || '';
        var epName = series ? [ctx.ep.season, ctx.ep.title].filter(Boolean).join(' · ') : '';
        var meta = { title: series ? base + ' — ' + epName : base, img: m.img || ctx.item.img || ctx.item.imglr, desc: m.desc || (j && j.description) || '', key: key, ctx: ctx, series: series };
        V.touch(ctx.item, ctx.ep, { title: base, img: meta.img, gk: ctx.gk, seasons: ctx.seasons });
        PlayerUI.openVod(meta, url, ctx.fromStart ? 0 : V.resumeAt(key));
        if (series) V.episodesFor(ctx).then(function (list) { PlayerUI.setEpisodes(meta, list); }).catch(function () { /* */ });
      }).catch(function (e) { TV.toast(TV.t('vod_error', { e: e.message || e })); });
    },
    // кнопки сортировки медиатеки (общая настройка vodSort)
    vodSortBar: function (entry) {
      var self = this, bar = el('div', 'sbtns vbar'); bar.setAttribute('data-zone', 'vsort');
      var mode = TV.store.get('vodSort', 'abc');
      [['abc', TV.t('vod_sort_abc')], ['new', TV.t('vod_sort_new')]].forEach(function (m) {
        var b = navItem('div', 'btn' + (mode === m[0] ? ' sel' : ''), 'vsort:' + m[0]);
        b.textContent = (mode === m[0] ? '◉ ' : '○ ') + m[1];
        b.tvOk = function () { TV.store.set('vodSort', m[0]); entry.focus = 'vsort:' + m[0]; self.render(); };
        bar.appendChild(b);
      });
      return bar;
    },
    // подпись вида: «3 сезона», «сериал», «2 сериала», «📁»
    vodKind: function (it) {
      if (it.type === 'franchise') return '📁 ' + TV.tn('vod_series_n', it.members.length);
      if (it.type === 'group') return TV.tn('vod_seasons_n', it.seasons.length);
      if (it.type === 'multistream') return TV.t('vod_series');
      return it.type === 'category' ? '📁' : '';
    },
    // Подпись прогресса просмотра: «⟲ 12:34» / «✓ просмотрено»
    vodProg: function (key) {
      var p = TV.Vod.posOf(key);
      if (!p || p.pos < 15) return null;
      if (TV.Vod.isDone(p)) return { txt: TV.t('vod_watched'), f: 1, done: true };
      return { txt: '⟲ ' + TV.fmtClock(p.pos) + (p.dur ? ' / ' + TV.fmtClock(p.dur) : ''), f: p.dur ? p.pos / p.dur : 0 };
    },
    vodTile: function (key, title, sub, img, prog) {
      var t = navItem('div', 'tile vtile', key);
      var pic = el('div', 'poster');
      if (img) { var im = new Image(); im.loading = 'lazy'; im.alt = ''; im.src = img; im.onerror = function () { im.remove(); }; pic.appendChild(im); }
      else pic.appendChild(el('span', 'ini', TV.initials(title || '?')));
      if (prog && prog.f) { var bar = el('div', 'vprog'); var fill = el('div', 'vprogf'); fill.style.width = Math.round(prog.f * 100) + '%'; bar.appendChild(fill); pic.appendChild(bar); }
      t.appendChild(pic);
      var ek = 'vod:' + String(key).replace(/^v[ih]:/, '');
      var nm = el('div', 'vname' + TV.errClass(ek), title || '—'); nm.title = TV.errTitle(ek);
      t.appendChild(nm);
      t.appendChild(el('div', 'sub', [sub, prog ? prog.txt : ''].filter(Boolean).join(' · ')));
      return t;
    },

    // Меню канала (долгое OK / правая кнопка): избранное и язык
    channelMenu: function (ch, after) {
      var self = this;
      Dialog.show(ch.name, [
        [TV.t(self.isFav(ch.key) ? 'in_fav' : 'to_fav'), 'fav'],
        [TV.t('ch_menu_lang', { lang: TV.langName(TV.chLang(ch)) }), 'lang'],
        [TV.t('cancel'), null]
      ], 0, function (v) {
        if (v === 'fav') {
          self.toggleFav(ch);
          if (after) after();
          var top = self.stack[self.stack.length - 1];
          if (top.name === 'channels' && top.params.fav && !self.isFav(ch.key)) {
            top.focus = null;
            if (!self.favChannels().length) { self.back(); return; }
            self.render();
          }
        } else if (v === 'lang') {
          self.pickLang(TV.t('pick_lang', { name: ch.name }), TV.langOv().ch[ch.key] || '',
            TV.langOv().grp[ch.group] || ch.lang, function (code) {
              TV.setLangOv('ch', ch.key, code);
              TV.toast(TV.t('lang_set', { name: ch.name, lang: TV.langName(TV.chLang(ch)) }));
              var top = self.stack[self.stack.length - 1];
              top.focus = Nav.current && Nav.current.getAttribute('data-key');
              self.render();
            });
        }
      });
    },

    // Выбор языка: '' — автоматически (autoCode — что будет при «авто»)
    pickLang: function (title, current, autoCode, cb) {
      var codes = TV.LANG_CODES.slice().sort(function (a, b) {
        var pa = ['ru', 'en', 'uk', 'hy', 'be', 'kk'].indexOf(a), pb = ['ru', 'en', 'uk', 'hy', 'be', 'kk'].indexOf(b);
        if (pa >= 0 || pb >= 0) return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
        return TV.langName(a).localeCompare(TV.langName(b), TV.locale());
      });
      var btns = [[(current ? '' : '◉ ') + TV.t('auto_lang', { lang: TV.langName(autoCode) }), '']].concat(codes.map(function (c) {
        return [(current === c ? '◉ ' : '') + TV.langName(c), c];
      }));
      var idx = current ? 1 + codes.indexOf(current) : 0;
      Dialog.show(title, btns, idx, function (v) { if (v !== undefined && v !== false) cb(v); }, 'grid');
    },

    // Канал без архива — сразу прямой эфир; с архивом — программа передач
    // Канал всегда открывается с программой передач (без архива — смотреть можно только прямой эфир)
    openChannel: function (ch) {
      this.push('schedule', { key: ch.key });
    },

    // ---------- избранное ----------
    isFav: function (key) { return this.favs.indexOf(key) >= 0; },
    toggleFav: function (ch) {
      var i = this.favs.indexOf(ch.key);
      if (i >= 0) { this.favs.splice(i, 1); TV.toast(TV.t('fav_removed', { name: ch.name })); }
      else { this.favs.push(ch.key); TV.toast(TV.t('fav_added', { name: ch.name })); }
      TV.store.set('favs', this.favs);
    },
    favChannels: function () {
      var self = this;
      // избранное фильтром языков не скрывается
      return this.favs.map(function (k) { return self.byKey[k]; }).filter(Boolean);
    },

    // ---------- стек экранов ----------
    push: function (name, params) {
      var top = this.stack[this.stack.length - 1];
      if (top) top.focus = Nav.current && Nav.current.getAttribute('data-key');
      this.stack.push({ name: name, params: params || {} });
      this.render();
    },

    back: function () {
      if (Dialog.open) { Dialog.close(false); return; }
      if (this._errorRoot) { this.askExit(); return; }
      if (this.playing) { PlayerUI.close(); return; }
      if (this.stack.length > 1) {
        TV.Voice.stop();
        this.stack.pop();
        this.render();
        return;
      }
      this.askExit();
    },

    askExit: function () {
      Dialog.show(TV.t('exit_q', { app: TV_CONFIG.appName }), [[TV.t('exit'), true], [TV.t('stay'), false]], 1, function (yes) {
        if (!yes) return;
        if (window.native && window.native.quit) window.native.quit(); else window.close();
      });
    },

    render: function () {
      var top = this.stack[this.stack.length - 1];
      var fn = Screens[top.name];
      // тот же экран перерисовывается (например, отметка в настройках) — сохраняем прокрутку
      var isNew = this._lastTop !== top;
      var keep = this._lastTop === top ? Array.prototype.map.call(this.screen.querySelectorAll('.settings, .grid, .search, .progs, .days'), function (e) { return [e.className, e.scrollTop]; }) : null;
      this._lastTop = top;
      this.screen.innerHTML = '';
      this.screen.className = 'screen-' + top.name;
      // вид «списком» — для всех экранов (каналы, категории, медиатека, поиск)
      document.body.classList.toggle('listmode', TV.store.get('chanView', 'tiles') === 'list');
      var r = fn.call(this, top.params, top);
      if (isNew) r.node.classList.add('enter');
      this.screen.appendChild(r.node);
      if (keep) {
        var self2 = this;
        keep.forEach(function (k) { var e2 = self2.screen.getElementsByClassName(k[0].split(' ')[0])[0]; if (e2) e2.scrollTop = k[1]; });
      }
      this.setCrumbs(r.crumbs || []);
      var f = top.focus && this.screen.querySelector('[data-key="' + cssEsc(top.focus) + '"]');
      Nav.current = null;
      Nav.focus(f || r.focus || this.screen.querySelector('[data-nav]'));
    },

    // Строка навигации: каждый пункт (кроме текущего) — переход на свой уровень, мышью и пультом
    setCrumbs: function (list) {
      var self = this, c = this.crumbs; c.innerHTML = '';
      c.setAttribute('data-zone', 'crumbs');
      var n = list.length, len = this.stack.length;
      function go(idx) { return function () { self.popTo(idx); }; }
      var logo = el('span', 'logo-mark', TV_CONFIG.appName);
      if (len > 1) { logo.setAttribute('data-nav', ''); logo.setAttribute('data-key', 'crumb:0'); logo.classList.add('crumb'); logo.tvOk = go(0); }
      c.appendChild(logo);
      list.forEach(function (t, i) {
        c.appendChild(el('span', 'sep', '›'));
        var label = typeof t === 'object' ? t.label : t;
        var isLast = i === n - 1;
        var e = el('span', isLast ? 'cur' : '', label);
        var action = typeof t === 'object' && t.go ? t.go : null;
        var idx = len - 1 - (n - 1 - i);
        if (!isLast && (action || (idx >= 0 && idx < len - 1))) {
          e.setAttribute('data-nav', ''); e.setAttribute('data-key', 'crumb:' + (i + 1)); e.classList.add('crumb');
          e.tvOk = action || go(idx);
        }
        c.appendChild(e);
      });
    },

    popTo: function (idx) {
      if (idx < 0 || idx >= this.stack.length) return;
      TV.Voice.stop();
      this.stack.length = idx + 1;
      this.render();
    },

    refreshOnEpg: function () {
      if (this.playing) return;
      var top = this.stack[this.stack.length - 1];
      var typing = document.activeElement && /INPUT/.test(document.activeElement.tagName);
      if (top && (top.name === 'schedule' || top.name === 'channels' || (top.name === 'settings' && top.params.tab === 'epg' && !typing))) {
        top.focus = Nav.current && Nav.current.getAttribute('data-key');
        if (top.name === 'schedule') top.params.keepDay = true;
        this.render();
      }
    },

    // ---------- клавиши ----------
    onKey: function (e, down) {
      var top0 = this.stack[this.stack.length - 1];
      // на экране поиска любая буква сразу попадает в строку поиска
      if (down && !this.playing && !Dialog.open && top0 && top0.name === 'search' && e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        var si = document.getElementById('search-input');
        if (si && document.activeElement !== si) { si.focus(); Nav.focus(si, { noScroll: true }); }
        return;
      }
      var a = TV.keyAction(e);
      if (down && !this.playing && !Dialog.open && (a === 'search' || ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А')))) {
        e.preventDefault();
        if (!top0 || top0.name !== 'search') this.push('search', {});
        return;
      }
      if (!a || a === 'search') return;
      if (Dialog.open) {
        e.preventDefault(); e.stopPropagation();
        if (!down) return;
        if (a === 'left' || a === 'right') Nav.move(a);
        else if (a === 'ok') Nav.ok();
        else if (a === 'back') Dialog.close(false);
        return;
      }
      if (a === 'fullscreen') { if (down && window.native && window.native.toggleFullscreen) window.native.toggleFullscreen(); e.preventDefault(); return; }
      // Backspace в поле ввода не трогаем (полей нет, но на будущее)
      var ae = document.activeElement;
      if (ae && /INPUT|TEXTAREA/.test(ae.tagName)) {
        // в поле ввода: стрелки вверх/вниз и Enter выходят из поля, Esc — тоже, остальное печатается
        if (a === 'up' || a === 'down' || (a === 'ok' && down) || (a === 'back' && e.key !== 'Backspace')) {
          if (!down) return;
          ae.blur(); e.preventDefault(); e.stopPropagation();
          if (a === 'up' || a === 'down') Nav.move(a);
          else if (a === 'ok') Nav.move('down');
          return;
        }
        return;
      }
      if (this._swallowOkUp && a === 'ok' && !down) { this._swallowOkUp = false; e.preventDefault(); return; }
      e.preventDefault();
      e.stopPropagation();
      if (this.playing) { if (down) PlayerUI.key(a, e); return; }
      if (a === 'search') return;
      if (a === 'ok') {
        // короткое нажатие — по отпусканию; удержание — «долгое» действие (избранное)
        if (down) {
          if (!e.repeat) { this._okDown = Date.now(); this._okLong = false; }
          else if (!this._okLong && Date.now() - this._okDown > 650) { this._okLong = true; Nav.long(); }
        } else {
          if (this._okDown && !this._okLong) Nav.ok();
          this._okDown = 0;
        }
        return;
      }
      if (!down) return;
      if (a === 'back') { if (!e.repeat) this.back(); return; }
      if (a === 'fav') { if (Nav.current && Nav.current.tvStar) Nav.current.tvStar(Nav.current); else Nav.long(); return; }
      if (a === 'up' || a === 'down' || a === 'left' || a === 'right') { Nav.move(a); return; }
      if (a === 'next' || a === 'prev') { Nav.move(a === 'next' ? 'up' : 'down'); }
    }
  };

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function navItem(tag, cls, key) {
    var e = el(tag, cls);
    e.setAttribute('data-nav', '');
    if (key != null) e.setAttribute('data-key', key);
    return e;
  }

  // Оформление плитки категории: свой оттенок, крупный полупрозрачный значок, логотипы каналов или постеры
  function hueOf(name) { var h = 0; name = String(name || ''); for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h; }
  var GROUP_ICONS = [[/новост|news|info/i, '📰'], [/спорт|sport|футбол|match/i, '⚽'], [/детск|мульт|kids|child|cartoon/i, '🧸'], [/кино|фильм|movie|cinema|film|сериал/i, '🎞'],
    [/музык|music|муз/i, '🎵'], [/познав|науч|doc|discovery|природ|nature|истор/i, '🔭'], [/развлек|entertain|юмор|comedy|шоу/i, '🎭'], [/общ|федерал|эфир|основн|general/i, '📡'],
    [/регион|город|local|област/i, '🏙'], [/hd|uhd|4k/i, '✨'], [/религ|relig/i, '🕊'], [/кулин|еда|food|cook/i, '🍳'], [/авто|auto|car|техн/i, '🚗'], [/охот|рыб|hunt|fish/i, '🎣'],
    [/путеш|travel|туризм/i, '🧭'], [/бизнес|эконом|business|финанс/i, '💼'], [/мод|fashion|стиль|lifestyle/i, '👗'], [/игр|game|esport/i, '🎮']];
  var GENRE_ICONS = [[/фантаст|sci-?fi|science/i, '🚀'], [/фэнтез|fantasy/i, '🐉'], [/комед|comedy|юмор/i, '😂'], [/ужас|horror/i, '👻'], [/триллер|thriller/i, '🔪'],
    [/детектив|detective|mystery/i, '🕵'], [/криминал|crime/i, '🚔'], [/боевик|action/i, '💥'], [/мелодрам|романт|romance/i, '❤'], [/драм|drama/i, '🎭'],
    [/мульт|анимац|animation|cartoon/i, '🧸'], [/аниме|anime/i, '🌸'], [/документ|docu/i, '🎥'], [/приключ|adventure/i, '🧭'], [/семей|family|детск|kids/i, '👨‍👩‍👧'],
    [/воен|war/i, '🎖'], [/истор|history/i, '🏛'], [/вестерн|western/i, '🤠'], [/музык|мюзикл|music/i, '🎵'], [/спорт|sport/i, '⚽'], [/биограф|biograph/i, '📜'],
    [/короткометр|short/i, '⏱'], [/концерт|concert/i, '🎤'], [/реалити|reality|шоу|show/i, '📺'], [/новогод|рождеств|christmas/i, '🎄'], [/эротик|18\+/i, '🔞']];
  function genreIcon(name) { for (var i = 0; i < GENRE_ICONS.length; i++) if (GENRE_ICONS[i][0].test(name)) return GENRE_ICONS[i][1]; return null; }
  function groupIcon(name) { for (var i = 0; i < GROUP_ICONS.length; i++) if (GROUP_ICONS[i][0].test(name)) return GROUP_ICONS[i][1]; return null; }
  function catDecor(t, o) {
    t.style.setProperty('--h', o.hue);
    if (o.ico) { var ic = el('div', 'ico' + (o.letter ? ' letter' : ''), o.ico); t.appendChild(ic); }
    if (o.logos && o.logos.length) {
      var lg = el('div', 'logos');
      o.logos.slice(0, 5).forEach(function (src) {
        var b = el('span', 'lg'), im = new Image(); im.loading = 'lazy'; im.alt = ''; im.src = src;
        im.onerror = function () { b.remove(); }; b.appendChild(im); lg.appendChild(b);
      });
      t.appendChild(lg);
    }
  }
  function posterFan(t, urls) {
    if (!urls || !urls.length) return;
    var f = el('div', 'fan');
    urls.slice(0, 3).forEach(function (u, i) {
      var im = new Image(); im.alt = ''; im.loading = 'lazy'; im.src = u; im.style.setProperty('--i', i);
      im.onerror = function () { im.remove(); }; f.appendChild(im);
    });
    t.appendChild(f); t.classList.add('hasfan');
  }
  function logosOf(list) {
    var out = [];
    for (var i = 0; i < list.length && out.length < 5; i++) { var src = list[i].logo || EPG.icons[list[i].key]; if (src && out.indexOf(src) < 0) out.push(src); }
    return out;
  }

  function logoBox(ch, cls) {
    var box = el('div', cls || 'logo');
    var src = ch.logo || EPG.icons[ch.key];
    if (src) {
      var img = new Image();
      img.loading = 'lazy'; img.alt = '';
      img.onerror = function () { box.innerHTML = ''; box.appendChild(el('span', 'ini', TV.initials(ch.name))); };
      img.src = src;
      box.appendChild(img);
    } else {
      box.appendChild(el('span', 'ini', TV.initials(ch.name)));
    }
    return box;
  }

  // ---------- экраны ----------
  var Screens = {
    categories: function () {
      var self = this, wrap = el('div', 'grid cats'), favTile = null;
      wrap.setAttribute('data-zone', 'cats');
      var favList = this.favChannels();
      var items = [{ name: 'settings', label: TV.t('t_settings'), settings: true }, { name: 'search', label: TV.t('t_search'), search: true },
        { name: FAV, label: TV.t('favorites'), count: favList.length, fav: true },
        { name: ALL, label: TV.t('all_channels'), count: this.uniqueChannels().length, all: true }].concat(
        TV.Vod.enabled() ? [{ name: 'vod', label: TV.t('vod'), vod: true }] : []).concat(this.groups.map(function (g) {
        return { name: g.name, count: g.list.filter(TV.langVisible).length, list: g.list };
      }).filter(function (g) { return g.count > 0; }));
      var hidden = TV.hiddenLangs().length;
      items.forEach(function (it) {
        var t = navItem('div', 'tile cat' + (it.fav ? ' fav' : '') + (it.all ? ' all' : '') + (it.settings ? ' set' : '') + (it.search ? ' srch' : '') + (it.vod ? ' vodt' : ''), 'cat:' + it.name);
        // значок уже есть крупно на фоне — из подписи убираем
        t.appendChild(el('div', 'name', String(it.label || it.name).replace(/^[^\p{L}\p{N}]+/u, '')));
        t.appendChild(el('div', 'sub', it.vod ? TV.t('vod_sub') : it.search ? TV.t('search_sub') : it.settings ? (hidden ? TV.t('settings_sub_langs') : TV.t('settings_sub')) : TV.tn('channels_n', it.count)));
        var gi = it.list ? groupIcon(it.name) : null;
        catDecor(t, {
          hue: it.settings ? 222 : it.search ? 262 : it.fav ? 40 : it.all ? 205 : it.vod ? 318 : hueOf(it.name),
          ico: it.settings ? '⚙' : it.search ? '🔍' : it.fav ? '★' : it.all ? '📺' : it.vod ? '🎬' : (gi || TV.initials(it.name).charAt(0)),
          letter: !!it.list && !gi,
          logos: it.fav ? logosOf(favList) : it.all ? logosOf(self.uniqueChannels()) : it.list ? logosOf(it.list.filter(TV.langVisible)) : null
        });
        t.tvOk = function () {
          if (it.settings) { self.push('settings', {}); return; }
          if (it.search) { self.push('search', {}); return; }
          if (it.vod) { self.push('vod', {}); return; }
          if (it.fav) {
            if (!self.favChannels().length) { TV.toast(TV.t('fav_empty')); return; }
            self.push('channels', { group: FAV, fav: true });
          } else {
            self.push('letters', { group: it.name });
          }
        };
        wrap.appendChild(t);
        if (it.fav) favTile = t;
      });
      // по умолчанию фокус на «Избранном»
      return { node: wrap, crumbs: [TV.t('categories')], focus: favTile };
    },

    letters: function (p) {
      var self = this;
      var map = {};
      this.groupList(p.group).forEach(function (c) { var l = TV.letterOf(c.name); (map[l] || (map[l] = [])).push(c); });
      var letters = Object.keys(map).sort(TV.compareLetters);
      var wrap = el('div', 'grid letters');
      wrap.setAttribute('data-zone', 'letters');
      var allList = this.groupList(p.group);
      // первая плитка — все каналы раздела без разбивки по буквам
      var total = letters.reduce(function (n, l) { return n + map[l].length; }, 0);
      var all = navItem('div', 'tile letter allg', 'l:*');
      all.appendChild(el('div', 'name', TV.t('all_in_group')));
      all.appendChild(el('div', 'sub', TV.tn('channels_n', total)));
      catDecor(all, { hue: 215, ico: '📺', logos: logosOf(allList) });
      all.tvOk = function () { self.push('channels', { group: p.group, letter: '*' }); };
      wrap.appendChild(all);
      letters.forEach(function (l) {
        var t = navItem('div', 'tile letter', 'l:' + l);
        t.style.setProperty('--h', hueOf(l + l + l));
        t.appendChild(el('div', 'big', l));
        t.appendChild(el('div', 'sub', TV.tn('channels_n', map[l].length)));
        var lg = logosOf(map[l]);
        if (lg.length) catDecor(t, { hue: hueOf(l + l + l), logos: lg.slice(0, 3) });
        t.tvOk = function () { self.push('channels', { group: p.group, letter: l }); };
        wrap.appendChild(t);
      });
      return { node: wrap, crumbs: [groupLabel(p.group)] };
    },

    channels: function (p) {
      var self = this, list;
      if (p.fav) list = this.favChannels();
      else list = this.groupList(p.group).filter(function (c) { return p.letter === '*' || TV.letterOf(c.name) === p.letter; });
      // сначала недавно просмотренные (последний — первым), затем остальные по алфавиту
      var rec = TV.recent();
      list = list.slice().sort(function (a, b) {
        var ra = rec[a.key] || 0, rb = rec[b.key] || 0;
        if (ra !== rb) return rb - ra;
        return a.name.localeCompare(b.name, TV.locale());
      });
      var wrap = el('div', 'grid chans' + (TV.store.get('chanView', 'tiles') === 'list' ? ' list' : ''));
      wrap.setAttribute('data-zone', 'chans');
      var now = TV.now();
      list.forEach(function (ch) {
        var t = navItem('div', 'tile chan', 'ch:' + ch.key);
        t.appendChild(logoBox(ch));
        var info = el('div', 'info');
        var nm = el('div', 'name' + TV.errClass(ch.key), ch.name); nm.title = TV.errTitle(ch.key);
        info.appendChild(nm);
        var i = EPG.indexAt(ch.key, now);
        if (i >= 0) {
          var pr = EPG.list(ch.key)[i];
          info.appendChild(el('div', 'sub', TV.fmtTime(pr[0]) + '  ' + pr[2]));
          var bar = el('div', 'mini'), fill = el('i');
          fill.style.width = Math.round((now - pr[0]) / (pr[1] - pr[0]) * 100) + '%';
          bar.appendChild(fill); info.appendChild(bar);
        } else {
          info.appendChild(el('div', 'sub dim', TV.Catchup.available(ch) ? TV.t('archive_days', { n: TV.Catchup.days(ch) }) : TV.t('no_archive_live')));
        }
        t.appendChild(info);
        if (rec[ch.key]) {
          t.classList.add('recent');
          var rb = el('div', 'rbadge', '⟲'); rb.title = TV.t('watched_at', { time: new Date(rec[ch.key]).toLocaleString(TV.locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) });
          t.appendChild(rb);
        }
        var star = el('div', 'star' + (self.isFav(ch.key) ? ' on' : ''), '★');
        star.setAttribute('data-star', '');
        t.appendChild(star);
        t.tvOk = function () { self.openChannel(ch); };
        t.tvLong = function () { self.channelMenu(ch, function () { star.classList.toggle('on', self.isFav(ch.key)); }); };
        t.tvStar = function () {
          self.toggleFav(ch);
          star.classList.toggle('on', self.isFav(ch.key));
          if (p.fav && !self.isFav(ch.key)) {
            var top = self.stack[self.stack.length - 1]; top.focus = null;
            if (!self.favChannels().length) { self.back(); return; }
            self.render();
          }
        };
        wrap.appendChild(t);
      });
      if (!list.length) wrap.appendChild(el('div', 'empty', TV.t('no_channels')));
      return { node: wrap, crumbs: p.fav ? [groupLabel(FAV)] : [groupLabel(p.group), p.letter === '*' ? TV.t('all_in_group') : p.letter] };
    },

    settings: function (p) {
      var self = this, wrap = el('div', 'settings');
      // черновик настроек живёт в параметрах экрана до «Сохранить»
      var d = p.draft || (p.draft = {
        mode: TV.Source.mode(),
        url: TV.store.get('playlistUrl', ''),
        key: TV.store.get('accessKey', ''),
        domain: TV.store.get('channelDomain', ''),
        epgList: TV.epgUserUrls().slice(), epgNew: '',
        vportal: TV.store.get('vportal', ''),
        file: null
      });
      function rerender(focusKey) {
        var top = self.stack[self.stack.length - 1];
        top.focus = focusKey || (Nav.current && Nav.current.getAttribute('data-key'));
        self.render();
      }
      function section(title) { var h = el('div', 'shead', title); wrap.appendChild(h); }
      function field(label, prop, placeholder, hint, type) {
        var row = el('div', 'srow');
        row.appendChild(el('div', 'slabel', label));
        var inp = el('input', 'sinput');
        inp.type = type || 'text'; inp.spellcheck = false; inp.autocomplete = 'off';
        inp.placeholder = placeholder; inp.value = d[prop] || '';
        inp.setAttribute('data-nav', ''); inp.setAttribute('data-key', 'in:' + prop);
        inp.addEventListener('input', function () { d[prop] = inp.value; });
        inp.tvOk = function () { inp.focus(); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) { /* */ } };
        row.appendChild(inp);
        if (hint) row.appendChild(el('div', 'shint', hint));
        wrap.appendChild(row);
        return inp;
      }
      function btnRow(zone) { var r = el('div', 'sbtns'); r.setAttribute('data-zone', zone); wrap.appendChild(r); return r; }
      function button(row, text, key, fn, cls) {
        var b = navItem('div', 'btn' + (cls ? ' ' + cls : ''), key); b.textContent = text; b.tvOk = fn; row.appendChild(b); return b;
      }

      if (p.welcome || !TV.Source.configured()) {
        wrap.appendChild(el('div', 'welcome', TV.t('welcome', { app: TV_CONFIG.appName })));
        var wr = btnRow('welcomebtn');
        button(wr, TV.t('welcome_cloud'), 'wcloud', function () { p.tab = 'cloud'; rerender('in:cloudKey'); });
      }
      // три независимые вкладки: настройки общие и не зависят от способа подключения
      var tab = p.tab || 'conn';
      var trow = btnRow('stabs'); trow.classList.add('tabs');
      [['conn', TV.t('tab_conn')], ['vod', TV.t('tab_vod')], ['view', TV.t('tab_view')], ['lang', TV.t('tab_lang')], ['epg', TV.t('tab_epg')], ['cloud', TV.t('tab_cloud')], ['sys', TV.t('tab_sys')]].forEach(function (t) {
        button(trow, t[1], 'tab:' + t[0], function () { p.tab = t[0]; rerender('tab:' + t[0]); }, tab === t[0] ? 'sel tab' : 'tab');
      });
      if (tab === 'conn') {
      section(TV.t('src_section'));
      var modes = btnRow('modes');
      [['url', TV.t('mode_url')], ['key', TV.t('mode_key')], ['file', TV.t('mode_file')]].forEach(function (m) {
        button(modes, (d.mode === m[0] ? '◉ ' : '○ ') + m[1], 'mode:' + m[0], function () { d.mode = m[0]; rerender('mode:' + m[0]); }, d.mode === m[0] ? 'sel' : '');
      });

      if (d.mode === 'url') {
        field(TV.t('f_url'), 'url', 'http://…/playlist.m3u8', TV.t('f_url_hint'), 'url');
      } else if (d.mode === 'key') {
        field(TV.t('f_key'), 'key', TV.t('f_key_ph'), TV.t('f_key_hint'));
        field(TV.t('f_domain'), 'domain', TV.t('f_domain_ph'), TV.t('f_domain_hint'));
        var tinfo = el('div', 'shint tinfo', TV.t('tpl_checking'));
        wrap.appendChild(tinfo);
        TV.Source.templateInfo().then(function (t) {
          tinfo.textContent = t
            ? TV.t('tpl_info', { n: t.count, date: new Date(t.time).toLocaleString(TV.locale()), from: TV.t(t.origin === 'file' ? 'tpl_from_file' : 'tpl_from_url') })
            : TV.t('tpl_none');
          tinfo.classList.toggle('warn', !t);
        });
      } else {
        var row = el('div', 'srow');
        row.appendChild(el('div', 'slabel', TV.t('f_file')));
        var fileName = d.file ? d.file.name : (TV.store.get('fileName', '') || TV.t('file_none'));
        row.appendChild(el('div', 'sfile', TV.t('file_label', { name: fileName })));
        var picker = el('input'); picker.type = 'file'; picker.accept = '.m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain';
        picker.style.display = 'none';
        picker.addEventListener('change', function () {
          var f = picker.files && picker.files[0]; if (!f) return;
          var rd = new FileReader();
          rd.onload = function () {
            var text = String(rd.result || '');
            if (text.indexOf('#EXT') < 0) { TV.toast(TV.t('not_m3u')); return; }
            d.file = { name: f.name, text: text };
            TV.toast(TV.t('file_read', { ch: TV.tn('channels_n', TV.parseM3U(text).channels.length) }));
            rerender('save');
          };
          rd.onerror = function () { TV.toast(TV.t('file_read_err')); };
          rd.readAsText(f, 'utf-8');
        });
        row.appendChild(picker);
        var fr = el('div', 'sbtns'); fr.setAttribute('data-zone', 'filebtn');
        button(fr, TV.t('pick_file'), 'pick', function () { picker.click(); });
        row.appendChild(fr);
        row.appendChild(el('div', 'shint', TV.t('file_hint')));
        wrap.appendChild(row);
      }

      var btns = btnRow('sbtns');
      function validUrl(u) { return !u || /^https?:\/\/\S+$/i.test(u); }
      var save = button(btns, TV.t('save'), 'save', function () {
        var url = (d.url || '').trim();
        var key = (d.key || '').trim(), domain = (d.domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
        if (!validUrl(url)) { TV.toast(TV.t('url_bad')); return; }
        if (d.mode === 'url' && !url) { TV.toast(TV.t('url_need')); return; }
        if (d.mode === 'key') {
          if (!/^[A-Za-z0-9_-]{4,}$/.test(key)) { TV.toast(TV.t('key_bad')); return; }
          if (domain && !/^[a-z0-9.-]+(:\d+)?$/i.test(domain)) { TV.toast(TV.t('domain_bad')); return; }
        }
        var go = function () {
          TV.store.set('srcMode', d.mode); TV.store.set('playlistUrl', url);
          TV.store.set('accessKey', key); TV.store.set('channelDomain', domain);
          TV.toast(TV.t('saved_loading')); self.loadPlaylist();
        };
        if (d.mode === 'file') {
          if (!d.file) {
            TV.idb.get('file').then(function (f) { if (f && f.text) go(); else TV.toast(TV.t('pick_first')); });
            return;
          }
          TV.store.set('fileName', d.file.name);
          TV.idb.set('file', { name: d.file.name, text: d.file.text }).then(go);
          return;
        }
        go();
      });
      button(btns, TV.t('clear'), 'reset', function () {
        p.draft = { mode: d.mode, url: '', key: '', domain: '', epgList: d.epgList, epgNew: '', file: null };
        TV.toast(TV.t('cleared'));
        rerender('save');
      });
      btns._last = save; // из полей ввода вниз — сразу на «Сохранить»
      } else if (tab === 'lang') {
      section(TV.t('ui_lang'));
      var urow = btnRow('uilang'); urow.classList.add('wrap');
      var cur = TV.I18n.setting();
      var sysName = (TV.I18n.DICT[TV.I18n.system()] || {})._name || TV.I18n.system();
      button(urow, (!cur ? '◉ ' : '○ ') + TV.t('ui_lang_auto') + ' (' + sysName + ')', 'ui:auto', function () {
        TV.I18n.set(''); rerender('ui:auto');
      }, !cur ? 'sel' : '');
      TV.I18n.available().forEach(function (l) {
        button(urow, (cur === l.code ? '◉ ' : '○ ') + l.name, 'ui:' + l.code, function () {
          TV.I18n.set(l.code); rerender('ui:' + l.code);
        }, cur === l.code ? 'sel' : '');
      });
      wrap.appendChild(el('div', 'shint', TV.t('ui_lang_hint') + ' ' + TV.t('voice_ru_only') + '.'));

      section(TV.t('ch_langs'));
      var langs = self.languages();
      if (!langs.length) {
        wrap.appendChild(el('div', 'shint', TV.t('langs_later')));
      } else {
        var lrow = btnRow('langs'); lrow.classList.add('wrap');
        var hiddenL = TV.hiddenLangs();
        var setHidden = function (h, key) { TV.store.set('hiddenLangs', h); TV.updateLangState(); rerender(key); };
        var allNames = langs.map(function (x) { return x.name; });
        var allOn = !hiddenL.length;
        var noneOn = allNames.every(function (n) { return hiddenL.indexOf(n) >= 0; });
        button(lrow, (allOn ? '☑ ' : '☐ ') + TV.t('all_langs'), 'lang:*', function () {
          if (allOn) { TV.toast(TV.t('all_langs_shown')); return; }
          setHidden([], 'lang:*'); TV.toast(TV.t('all_langs_set'));
        }, allOn ? 'sel' : '');
        // снять все отметки, чтобы затем отметить только нужные языки
        button(lrow, TV.t('langs_none'), 'lang:-', function () {
          setHidden(allNames.slice(), 'lang:-'); TV.toast(TV.t('langs_none_toast'));
        }, noneOn ? 'sel' : '');
        langs.forEach(function (l) {
          var on = hiddenL.indexOf(l.name) < 0;
          button(lrow, (on ? '☑ ' : '☐ ') + TV.langName(l.name) + ' (' + l.count + ')', 'lang:' + l.name, function () {
            var h = TV.hiddenLangs().slice();
            if (on) h.push(l.name); else h = h.filter(function (x) { return x !== l.name; });
            // отмечены все — то же, что «Все языки»
            if (!allNames.some(function (n) { return h.indexOf(n) < 0; }) && !on) h = [];
            if (allNames.every(function (n) { return h.indexOf(n) < 0; })) h = [];
            setHidden(h, 'lang:' + l.name);
          }, on ? 'sel' : '');
        });
        if (noneOn) wrap.appendChild(el('div', 'shint warnt', TV.t('langs_none_hint')));
        wrap.appendChild(el('div', 'shint', TV.t('langs_hint')));
      }

      section(TV.t('grp_langs'));
      if (self.groups.length) {
        var glist = el('div', 'glist');
        self.groups.forEach(function (g, gi) {
          var r = el('div', 'grow');
          r.appendChild(el('span', 'gname', g.name));
          r.appendChild(el('span', 'gcount', TV.tn('channels_n', g.list.length)));
          var manual = !!TV.langOv().grp[g.name];
          var zb = el('span', 'ebtns'); zb.setAttribute('data-zone', 'g' + gi);
          var b = navItem('span', 'btn small' + (manual ? ' sel' : ''), 'grp:' + g.name);
          b.textContent = TV.langName(TV.groupLang(g.name)) + ' · ' + TV.t(manual ? 'manual' : 'auto');
          b.tvOk = function () {
            self.pickLang(TV.t('pick_grp_lang', { name: g.name }), TV.langOv().grp[g.name] || '', TV.detectLang('', g.name, ''), function (code) {
              TV.setLangOv('grp', g.name, code);
              rerender('grp:' + g.name);
            });
          };
          zb.appendChild(b); r.appendChild(zb);
          glist.appendChild(r);
        });
        wrap.appendChild(glist);
      }
      wrap.appendChild(el('div', 'shint', TV.t('grp_langs_hint')));

      } else if (tab === 'cloud') {
        self.cloudTab(wrap, d, section, field, btnRow, button, rerender);
      } else if (tab === 'vod') {
        self.vodTab(wrap, d, section, field, btnRow, button, rerender);
      } else if (tab === 'view') {
        section(TV.t('view_chans'));
        var cv = TV.store.get('chanView', 'tiles');
        var vr = btnRow('chview');
        [['tiles', TV.t('view_tiles')], ['list', TV.t('view_list')]].forEach(function (m) {
          button(vr, (cv === m[0] ? '◉ ' : '○ ') + m[1], 'chv:' + m[0], function () { TV.store.set('chanView', m[0]); rerender('chv:' + m[0]); }, cv === m[0] ? 'sel' : '');
        });
        wrap.appendChild(el('div', 'shint', TV.t('view_hint')));
        section(TV.t('err_marks'));
        var em = el('div', 'shint');
        em.appendChild(el('span', 'errlive', TV.t('err_mark_live'))); em.appendChild(document.createTextNode(' · '));
        em.appendChild(el('span', 'errplay', TV.t('err_mark_play')));
        wrap.appendChild(em);
        var er = btnRow('errbtn');
        button(er, TV.t('err_clear') + ' (' + Object.keys(TV.playErrs()).length + ')', 'errclr', function () { TV.store.set('playErr', {}); TV.toast(TV.t('err_cleared')); rerender('errclr'); });
      } else if (tab === 'sys') {
        self.updSection(wrap, section, btnRow, button, rerender);
      } else {
      section(TV.t('epg_sources'));
      // свои адреса (приоритет, сверху вниз), затем из плейлиста и встроенные — их удалить нельзя
      var elist = el('div', 'epglist');
      d.epgList.forEach(function (u, i) {
        var r = el('div', 'erow');
        r.appendChild(el('span', 'enum', String(i + 1)));
        r.appendChild(el('span', 'eurl', u));
        var z = el('span', 'ebtns'); z.setAttribute('data-zone', 'e' + i);
        if (i > 0) { var up = navItem('span', 'btn small', 'eup:' + i); up.textContent = '↑'; up.title = TV.t('up'); up.tvOk = function () { var t = d.epgList[i - 1]; d.epgList[i - 1] = u; d.epgList[i] = t; rerender('eup:' + (i - 1 || 1)); }; z.appendChild(up); }
        var del = navItem('span', 'btn small', 'edel:' + i); del.textContent = TV.t('del');
        del.tvOk = function () { d.epgList.splice(i, 1); rerender(d.epgList.length ? 'edel:' + Math.min(i, d.epgList.length - 1) : 'in:epgNew'); };
        z.appendChild(del); r.appendChild(z);
        elist.appendChild(r);
      });
      var fixed = (self.playlistEpg || []).map(function (u) { return [u, TV.t('from_playlist')]; })
        .concat(TV_CONFIG.epgDefaults.map(function (u) { return [u, TV.t('builtin')]; }))
        .filter(function (x) { return d.epgList.indexOf(x[0]) < 0; });
      fixed.forEach(function (x, i) {
        var r = el('div', 'erow fixed');
        r.appendChild(el('span', 'enum', String(d.epgList.length + i + 1)));
        r.appendChild(el('span', 'eurl', x[0]));
        r.appendChild(el('span', 'etag', x[1]));
        elist.appendChild(r);
      });
      wrap.appendChild(elist);
      wrap.appendChild(el('div', 'shint', TV.t('epg_hint')));
      var addInp = field(TV.t('epg_add_label'), 'epgNew', 'http://…/epg.xml.gz', null, 'url');
      var addRow = btnRow('eadd');
      var addEpg = function () {
        var u = (d.epgNew || '').trim();
        if (!/^https?:\/\/\S+$/i.test(u)) { TV.toast(TV.t('url_bad')); return; }
        if (d.epgList.indexOf(u) >= 0) { TV.toast(TV.t('epg_exists')); return; }
        d.epgList.push(u); d.epgNew = '';
        TV.toast(TV.t('epg_added'));
        rerender('eadd');
      };
      button(addRow, TV.t('epg_add_btn'), 'eadd', addEpg);
      addInp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && addInp.value.trim()) { e.stopPropagation(); e.preventDefault(); d.epgNew = addInp.value; addEpg(); } }, true);

      var ebtns = btnRow('ebtns');
      var esave = button(ebtns, TV.t('save'), 'esave', function () {
        TV.store.set('epgUrls', d.epgList.slice()); TV.store.set('epgUrl', '');
        TV.toast(TV.t('epg_saved'));
        var urls = TV.epgAllUrls(self.playlistEpg);
        EPG.init(self.allUnique(), urls).then(function () { rerender('esave'); });
      });
      button(ebtns, TV.t('epg_reload'), 'epgreload', function () {
        TV.idb.set('epg', null).then(function () {
          TV.toast(TV.t('epg_reloading'));
          EPG.init(self.allUnique(), TV.epgAllUrls(self.playlistEpg));
        });
      });
      ebtns._last = esave;
      var n = this.allUnique().length, e = Object.keys(EPG.data).length;
      wrap.appendChild(el('div', 'sinfo', TV.t('stats', { n: n, e: e }) + (EPG.loading ? TV.t('loading_suffix') : '')));
      if (EPG.missing && EPG.missing.length && !EPG.loading) {
        wrap.appendChild(el('div', 'shint', TV.t('epg_missing', { n: EPG.missing.length, list: EPG.missing.slice(0, 40).join(', ') + (EPG.missing.length > 40 ? '…' : '') })));
      }
      if (EPG.stale && EPG.stale.length && !EPG.loading) {
        wrap.appendChild(el('div', 'shint warnt', TV.t('epg_stale', { n: EPG.stale.length, list: EPG.stale.slice(0, 40).join(', ') + (EPG.stale.length > 40 ? '…' : '') })));
      }
      if (EPG.errors && EPG.errors.length && !EPG.loading) {
        wrap.appendChild(el('div', 'shint warnt', TV.t('epg_errors', { list: EPG.errors.join('; ') })));
      }
      }
      return { node: wrap, crumbs: [{ label: TV.t('settings'), go: function () { p.tab = 'conn'; rerender('tab:conn'); } }, TV.t('tab_' + tab)] };
    },

    // ---------- медиатека ----------
    vod: function (p, entry) {
      var self = this, wrap = el('div', 'grid cats');
      wrap.setAttribute('data-zone', 'vod');
      function reload() { if (self.stack[self.stack.length - 1] === entry && !self.playing) self.render(); }
      if (!TV.Vod.root) {
        if (p.err) {
          wrap.appendChild(el('div', 'empty warnt', TV.t('vod_error', { e: p.err })));
          var rb = navItem('div', 'btn', 'vretry'); rb.textContent = TV.t('retry');
          rb.tvOk = function () { p.err = null; reload(); };
          wrap.appendChild(rb);
        } else {
          wrap.appendChild(el('div', 'empty', TV.t('vod_loading')));
          TV.Vod.loadRoot().then(reload).catch(function (e) { p.err = e.message || String(e); reload(); });
        }
        return { node: wrap, crumbs: [TV.t('vod')] };
      }
      var root = TV.Vod.root;
      var hn = TV.Vod.history().length;
      if (hn) {
        var ht = navItem('div', 'tile cat all', 'vhist');
        ht.appendChild(el('div', 'name', TV.t('vod_hist')));
        catDecor(ht, { hue: 28, ico: '⟲' });
        posterFan(ht, TV.Vod.history().map(function (h) { return h.item.imglr || h.item.img; }).filter(Boolean).slice(0, 3));
        ht.appendChild(el('div', 'sub', String(hn)));
        ht.tvOk = function () { self.push('vodhist', {}); };
        wrap.appendChild(ht);
      }
      root.sections.forEach(function (sct, i) {
        var t = navItem('div', 'tile cat', 'vs:' + i);
        t.appendChild(el('div', 'name', sct.title));
        var sid = 'sec:' + JSON.stringify(sct.request);
        catDecor(t, { hue: hueOf(sct.title) });
        (function (t2) {
          var mem = TV.Vod.cache[sid];
          var pick = function (items) { return items.filter(function (x) { return x && (x.imglr || x.img); }).slice(0, 12).sort(function (a, b) { return (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0); }).slice(0, 3).map(function (x) { return x.imglr || x.img; }); };
          var subOf = function (n) { var sb = el('div', 'sub', TV.t('vod_count', { n: n.toLocaleString(TV.locale()) })); t2.insertBefore(sb, t2.children[1] || null); };
          if (mem && mem.items.length) { posterFan(t2, pick(mem.items)); subOf(mem.items.length); }
          else TV.idb.get(TV.Vod._dbKey(sid)).then(function (sv) { if (sv && sv.items) { posterFan(t2, pick(sv.items)); subOf(sv.items.length); } });
        })(t);
        t.tvOk = function () { self.push('vodlist', { id: 'sec:' + JSON.stringify(sct.request), req: TV.Vod.reqFor(sct, 'list'), title: sct.title }); };
        wrap.appendChild(t);
      });
      root.filters.forEach(function (f, i) {
        var isGenre = TV.Vod.genreFilter() === f;
        var t = navItem('div', 'tile cat srch', 'vf:' + i);
        catDecor(t, { hue: TV.Vod.genreFilter() === f ? 285 : 170, ico: TV.Vod.genreFilter() === f ? '🎭' : '📂' });
        t.appendChild(el('div', 'name', (isGenre ? TV.t('vod_genres') : f.title)));
        t.appendChild(el('div', 'sub', String(f.items.length)));
        t.tvOk = function () { self.push('vodfilter', { fi: i }); };
        wrap.appendChild(t);
      });
      if (!root.sections.length && !root.filters.length) wrap.appendChild(el('div', 'empty', TV.t('vod_empty')));
      return { node: wrap, crumbs: [TV.t('vod')] };
    },

    vodfilter: function (p) {
      var self = this, f = TV.Vod.root.filters[p.fi], isGenre = TV.Vod.genreFilter() === f;
      var wrap = el('div', 'grid cats'); wrap.setAttribute('data-zone', 'vodf');
      if (isGenre) {
        var all = navItem('div', 'tile cat all', 'vg:*');
        all.appendChild(el('div', 'name', TV.t('vod_all_genres')));
        catDecor(all, { hue: 300, ico: '🎬' });
        all.tvOk = function () { self.push('vodlist', { id: '__all__', all: true, title: TV.t('vod_all_genres') }); };
        wrap.appendChild(all);
      }
      f.items.forEach(function (it, i) {
        var t = navItem('div', 'tile cat', 'vg:' + i);
        t.appendChild(el('div', 'name', it.title));
        var yr = /^\s*(\d{4})\s*$/.exec(it.title || '');
        var rq = {}; Object.keys(it.request).forEach(function (k) { rq[k] = it.request[k]; }); if (rq.filter == null) rq.filter = 'on';
        if (yr) catDecor(t, { hue: (parseInt(yr[1], 10) * 23) % 360, ico: yr[1].slice(2), letter: true });
        else catDecor(t, { hue: hueOf(it.title), ico: genreIcon(it.title) || TV.initials(it.title).charAt(0), letter: !genreIcon(it.title) });
        // постеры: жанр — из сохранённого списка жанра; год — из сохранённых разделов
        (function (t2, y, fid) {
          var pick = function (items) {
            return items.filter(function (x) { return x && (x.imglr || x.img) && (!y || String(x.year) === y); }).slice(0, 40)
              .sort(function (a, b) { return (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0); }).slice(0, 3).map(function (x) { return x.imglr || x.img; });
          };
          var mem = TV.Vod.cache[fid];
          if (mem && mem.items.length) { posterFan(t2, pick(mem.items)); return; }
          TV.idb.get(TV.Vod._dbKey(fid)).then(function (sv) {
            if (sv && sv.items && sv.items.length) { posterFan(t2, pick(sv.items)); return; }
            if (y) TV.Vod.sample().then(function (items) { posterFan(t2, pick(items)); });
          });
        })(t, yr && yr[1], 'flt:' + JSON.stringify(rq));
        t.tvOk = function () {
          var req = {}; Object.keys(it.request).forEach(function (k) { req[k] = it.request[k]; });
          if (req.filter == null) req.filter = 'on';
          self.push('vodlist', { id: 'flt:' + JSON.stringify(req), req: req, title: it.title });
        };
        wrap.appendChild(t);
      });
      return { node: wrap, crumbs: [TV.t('vod'), isGenre ? TV.t('vod_genres') : f.title] };
    },

    vodlist: function (p, entry) {
      var self = this, wrap = el('div', 'vodwrap');
      var bar = el('div', 'sbtns vbar'); bar.setAttribute('data-zone', 'vsort');
      var mode = p.series ? 'server' : TV.store.get('vodSort', 'abc');
      if (!p.series) [['abc', TV.t('vod_sort_abc')], ['new', TV.t('vod_sort_new')]].forEach(function (m) {
        var b = navItem('div', 'btn' + (mode === m[0] ? ' sel' : ''), 'vsort:' + m[0]);
        b.textContent = (mode === m[0] ? '◉ ' : '○ ') + m[1];
        b.tvOk = function () { TV.store.set('vodSort', m[0]); entry.focus = 'vsort:' + m[0]; self.render(); };
        bar.appendChild(b);
      });
      var stat = el('div', 'vstat', ''); bar.appendChild(stat);
      wrap.appendChild(bar);
      var grid = el('div', 'grid vgrid'); grid.setAttribute('data-zone', 'vitems');
      wrap.appendChild(grid);
      // данные: раздел/фильтр/все жанры; перерисовка по мере загрузки страниц (не чаще раза в 0,8 с)
      var c = p.all ? TV.Vod.cache.__all__ : TV.Vod.cache[p.id];
      if (!c || !entry._sub) {
        entry._sub = true;
        var pending = false;
        var onUp = function (cc) {
          // нечего перерисовывать — список не изменился
          var sig = cc ? cc.items.length + ':' + cc.done + ':' + (cc.t || 0) + ':' + (cc.error || '') : '';
          if (sig && sig === entry._sig) return;
          if (pending) return; pending = true;
          // готовый список (из кэша или после фонового обновления) — сразу; при первой загрузке — не чаще раза в 0,8 с
          setTimeout(function () { pending = false; if (self.stack[self.stack.length - 1] === entry && !self.playing && !Dialog.open && !(document.activeElement && /INPUT/.test(document.activeElement.tagName))) { entry.focus = Nav.current && Nav.current.getAttribute('data-key'); self.render(); } }, cc && cc.done ? 30 : 800);
        };
        c = p.all ? TV.Vod.listAll(onUp) : TV.Vod.list(p.id, p.req, onUp, p.title);
      }
      entry._sig = c.items.length + ':' + c.done + ':' + (c.t || 0) + ':' + (c.error || '');
      var items = mode === 'server' ? c.items.filter(function (x) { return x && x.type !== 'next'; }) : TV.Vod.sorted(TV.Vod.arrange(c.items), mode);
      // «Просмотренные ранее» этого раздела — первым пунктом
      var hist = /^sec:/.test(p.id || '') ? TV.Vod.history(p.id) : [];
      if (hist.length) {
        var ht = navItem('div', 'tile vtile vhist', 'vhist');
        var hp = el('div', 'poster'); hp.appendChild(el('span', 'ini', '⟲')); ht.appendChild(hp);
        ht.appendChild(el('div', 'vname', TV.t('vod_hist')));
        ht.appendChild(el('div', 'sub', String(hist.length)));
        ht.tvOk = function () { self.push('vodhist', { sec: p.id, title: p.title }); };
        grid.appendChild(ht);
      }
      stat.textContent = (c.done ? TV.t('vod_count', { n: items.length }) : TV.t('vod_loading_n', { n: items.length })) +
        (c.t ? ' · ' + TV.t('vod_updated', { t: new Date(c.t).toLocaleString(TV.locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }) : '') +
        (c.error ? ' · ' + TV.t('vod_error', { e: c.error }) : '');
      items.forEach(function (it) {
        var k = it.type === 'group' ? it.gk : it.type === 'franchise' ? it.fk : TV.Vod.keyOf(it);
        var isSeries = it.type === 'multistream' || it.type === 'group' || it.type === 'franchise';
        var t = self.vodTile('vi:' + k, it.title, [it.year, self.vodKind(it)].filter(Boolean).join(' · '),
          it.imglr || it.img, isSeries || it.type === 'category' ? null : self.vodProg(k));
        t.tvOk = function () {
          // серия сезона — сразу воспроизведение (с переходами между сериями)
          var sl = [p.seasonLabel, p.title].filter(Boolean).join(' · ');
          if (p.series && it.type === 'stream') self.vodPlay({ item: p.series, ep: Object.assign({ season: sl }, it), meta: p.seriesMeta, seasons: p.seasons, gk: p.gk });
          else if (p.series && it.type === 'category') self.push('vodlist', { id: 'sea:' + JSON.stringify(it.request), req: TV.Vod.reqFor(it, 'list'), title: it.title, parentTitle: p.parentTitle, series: p.series, seriesMeta: p.seriesMeta, seasons: p.seasons, gk: p.gk, seasonLabel: p.seasonLabel });
          else self.openVodItem(it);
        };
        grid.appendChild(t);
      });
      if (c.done && !items.length) grid.appendChild(el('div', 'empty', TV.t('vod_empty')));
      var crumbs = [TV.t('vod')];
      if (p.parentTitle) crumbs.push(p.parentTitle);
      crumbs.push(p.title);
      return { node: wrap, crumbs: crumbs, focus: grid.querySelector('[data-nav]') };
    },

    // Просмотренные ранее: по убыванию даты; у сериала — последняя серия; OK — продолжить
    vodhist: function (p, entry) {
      var self = this, wrap = el('div', 'vodwrap');
      var grid = el('div', 'grid vgrid'); grid.setAttribute('data-zone', 'vhitems');
      wrap.appendChild(grid);
      var list = TV.Vod.history(p.sec);
      list.forEach(function (e) {
        var series = !!e.ep, key = TV.Vod.keyOf(series ? e.ep : e.item);
        var sub = series ? [e.ep.season, e.ep.title].filter(Boolean).join(' · ') : (e.item.year || '');
        var t = self.vodTile('vh:' + e.k, e.item.title, sub, e.item.imglr || e.item.img, self.vodProg(key));
        t.tvOk = function () { self.vodPlay({ item: e.item, ep: e.ep, seasons: e.seasons, gk: e.gk, meta: { title: e.item.title } }); };
        t.tvLong = function () {
          Dialog.show(e.item.title || '', [[TV.t('vod_hist_open'), 'open'], [TV.t('vod_hist_del'), 'del'], [TV.t('cancel'), null]], 0, function (v) {
            if (v === 'open') {
              if (e.gk && e.seasons && e.seasons.length > 1) self.push('vodseasons', { group: { type: 'group', gk: e.gk, title: e.item.title, seasons: e.seasons, img: e.item.img, imglr: e.item.imglr } });
              else self.push('vodmovie', { item: e.item });
            }
            else if (v === 'del') { TV.Vod.forget(e.k); entry.focus = null; self.render(); }
          });
        };
        grid.appendChild(t);
      });
      if (!list.length) grid.appendChild(el('div', 'empty', TV.t('vod_empty')));
      var crumbs = [TV.t('vod')];
      if (p.title) crumbs.push(p.title);
      crumbs.push(TV.t('vod_hist'));
      return { node: wrap, crumbs: crumbs, focus: grid.querySelector('[data-nav]') };
    },

    // Франшиза: сериалы одного сюжета
    vodfranchise: function (p, entry) {
      var self = this, fr = p.fr, outer = el('div', 'vodwrap'), wrap = el('div', 'grid vgrid');
      outer.appendChild(self.vodSortBar(entry)); outer.appendChild(wrap);
      wrap.setAttribute('data-zone', 'vfr');
      var loc = TV.locale(), mode = TV.store.get('vodSort', 'abc');
      var members = fr.members.slice().sort(function (a, b) {
        if (mode === 'new') {
          // выпуски передач — по дате в названии, остальное — по году
          if ((a._date || b._date) && a._date !== b._date) return (b._date || 0) - (a._date || 0);
          var ya = parseInt(a.year, 10) || 0, yb = parseInt(b.year, 10) || 0; if (ya !== yb) return yb - ya;
        }
        return String(a._short || a.title || '').localeCompare(String(b._short || b.title || ''), loc, { numeric: true });
      });
      members.forEach(function (x) {
        var k = x.type === 'group' ? x.gk : TV.Vod.keyOf(x);
        var t = self.vodTile('vfm:' + k, x._short || x.title, [x.year, self.vodKind(x)].filter(Boolean).join(' · '), x.imglr || x.img, x.type === 'stream' ? self.vodProg(k) : null);
        t.tvOk = function () { self.openVodItem(x); };
        wrap.appendChild(t);
      });
      return { node: outer, crumbs: [TV.t('vod'), fr.title], focus: wrap.querySelector('[data-nav]') };
    },

    // Сериал из нескольких сезонов-элементов: выбор сезона (и «продолжить» последнюю серию)
    vodseasons: function (p, entry) {
      var self = this, g = p.group, outer = el('div', 'vodwrap'), wrap = el('div', 'grid cats');
      outer.appendChild(self.vodSortBar(entry)); outer.appendChild(wrap);
      var newFirst = TV.store.get('vodSort', 'abc') === 'new';
      wrap.setAttribute('data-zone', 'vseas');
      var focus = null;
      var last = TV.Vod.history().filter(function (h) { return h.k === g.gk && h.ep; })[0];
      if (last) {
        var lp = self.vodProg(TV.Vod.keyOf(last.ep));
        var ct = navItem('div', 'tile cat all', 'vscont');
        ct.appendChild(el('div', 'name', '▶ ' + [last.ep.season, last.ep.title].filter(Boolean).join(' · ')));
        ct.appendChild(el('div', 'sub', TV.t('vod_continue') + (lp && !lp.done ? ' · ' + lp.txt.replace('⟲ ', '') : '')));
        ct.tvOk = function () { self.vodPlay({ item: last.item, ep: last.ep, meta: { title: g.title }, seasons: g.seasons, gk: g.gk }); };
        wrap.appendChild(ct); focus = ct;
      }
      // «новые сверху» — последний сезон первым (по номеру: год у сезонов бывает указан неверно)
      g.seasons.slice().sort(function (a, b) { return newFirst ? b.n - a.n : a.n - b.n; }).forEach(function (sn) {
        var lbl = TV.t('vod_season_n', { n: sn.n });
        var t = navItem('div', 'tile cat', 'vsn:' + sn.n + ':' + TV.Vod.keyOf(sn.item));
        t.appendChild(el('div', 'name', lbl));
        t.appendChild(el('div', 'sub', [sn.item.year, sn.item.title].filter(Boolean).join(' · ')));
        if (last && TV.Vod.keyOf(last.item) === TV.Vod.keyOf(sn.item)) t.classList.add('recent');
        t.tvOk = function () { self.push('vodmovie', { item: sn.item, seasons: g.seasons, gk: g.gk, base: g.title, seasonLabel: lbl, fr: g._fr, short: g._short }); };
        wrap.appendChild(t);
        if (!focus) focus = t;
      });
      return { node: outer, crumbs: g._fr ? [TV.t('vod'), g._fr, g._short || g.title] : [TV.t('vod'), g.title], focus: focus };
    },

    vodmovie: function (p, entry) {
      var self = this, it = p.item, wrap = el('div', 'vmovie');
      function reload() { if (self.stack[self.stack.length - 1] === entry && !self.playing) self.render(); }
      var card = p.card;
      if (!card && !p.err) {
        TV.Vod.item(it).then(function (j) { p.card = j; reload(); }).catch(function (e) { p.err = e.message || String(e); reload(); });
      }
      var d = {}; ['title', 'img', 'imglr', 'year', 'description', 'duration', 'agelimit'].forEach(function (k) { d[k] = (card && card[k]) || it[k]; });
      var left = el('div', 'vposter'); var src = d.img || d.imglr;
      if (src) { var im = new Image(); im.src = src; im.alt = ''; im.onerror = function () { left.remove(); }; left.appendChild(im); wrap.appendChild(left); }
      var right = el('div', 'vinfo');
      right.appendChild(el('div', 'vtitle', d.title || ''));
      var facts = [d.year, d.duration ? TV.t('min', { n: Math.round(d.duration) }) : '', d.agelimit ? d.agelimit + '+' : ''].filter(Boolean).join(' · ');
      if (facts) right.appendChild(el('div', 'vfacts', facts));
      var btns = el('div', 'sbtns'); btns.setAttribute('data-zone', 'vplay'); right.appendChild(btns);
      if (d.description) right.appendChild(el('div', 'desc', d.description));
      var eps = el('div', 'veps'); eps.setAttribute('data-zone', 'veps'); eps.setAttribute('data-scroll', 'center'); right.appendChild(eps);
      wrap.appendChild(right);
      var focus = null;
      if (p.err) right.appendChild(el('div', 'warnt', TV.t('vod_error', { e: p.err })));
      else if (!card) right.appendChild(el('div', 'shint', TV.t('vod_loading')));
      else if (card.type === 'multistream' || (card.items && card.items.length && !card.url)) {
        // сериал: «продолжить» последнюю серию, затем сезоны (папки) и серии
        var smeta = { title: p.base || d.title, img: d.img || d.imglr, desc: d.description };
        var hk = p.gk || TV.Vod.keyOf(it);
        var last = TV.Vod.history().filter(function (h) { return h.k === hk && h.ep; })[0];
        if (last) {
          var lp = self.vodProg(TV.Vod.keyOf(last.ep));
          var cb = navItem('div', 'btn big', 'vcont');
          cb.textContent = TV.t('vod_cont_ep', { ep: [last.ep.season, last.ep.title].filter(Boolean).join(' · ') }) + (lp && !lp.done ? ' (' + lp.txt.replace('⟲ ', '') + ')' : '');
          cb.tvOk = function () { self.vodPlay({ item: last.item || it, ep: last.ep, meta: smeta, seasons: p.seasons, gk: p.gk }); };
          btns.appendChild(cb); focus = cb;
        }
        var list = (card.items || []).filter(function (x) { return x && x.type !== 'next'; });
        var onlySeason = null;
        // единственный сезон-папка — сразу его серии, без лишнего уровня
        if (list.length === 1 && list[0].type === 'category') {
          onlySeason = list[0];
          var sc = TV.Vod.list('sea:' + JSON.stringify(onlySeason.request), TV.Vod.reqFor(onlySeason, 'list'), function (c) { if (c.done && !p._seaDone) { p._seaDone = true; setTimeout(reload, 0); } }, onlySeason.title);
          list = sc.items.filter(function (x) { return x && x.type !== 'next'; });
          if (!sc.done) eps.appendChild(el('div', 'shint', TV.t('vod_loading')));
        }
        list.forEach(function (e2, i) {
          if (!e2 || e2.type === 'next') return;
          if (onlySeason && e2.type === 'stream' && !e2.season) e2 = Object.assign({ season: [p.seasonLabel, onlySeason.title].filter(Boolean).join(' · ') }, e2);
          var r = navItem('div', 'prog arch', 've:' + i);
          var pr = e2.type === 'category' ? null : self.vodProg(TV.Vod.keyOf(e2));
          r.appendChild(el('div', 'pn', (e2.type === 'category' ? '📁 ' : '▶ ') + (e2.title || TV.t('vod_episode_n', { n: i + 1 })) + (pr ? '   ' + pr.txt : '')));
          r.tvOk = function () {
            if (e2.type === 'category') self.push('vodlist', { id: 'sea:' + JSON.stringify(e2.request), req: TV.Vod.reqFor(e2, 'list'), title: e2.title, parentTitle: p.base || d.title, series: it, seriesMeta: smeta, seasons: p.seasons, gk: p.gk, seasonLabel: p.seasonLabel });
            else self.vodPlay({ item: it, ep: p.seasonLabel ? Object.assign({ season: p.seasonLabel }, e2) : e2, meta: smeta, seasons: p.seasons, gk: p.gk });
          };
          eps.appendChild(r);
          if (!focus) focus = r;
        });
        if (!eps.children.length && (!onlySeason || p._seaDone)) eps.appendChild(el('div', 'empty', TV.t('vod_empty')));
      } else if (card.url) {
        var meta = { title: d.title, img: d.img || d.imglr, desc: d.description };
        var rs = TV.Vod.resumeAt(TV.Vod.keyOf(it)), mp = self.vodProg(TV.Vod.keyOf(it));
        var play = navItem('div', 'btn big', 'vplay');
        play.textContent = '▶ ' + (rs ? TV.t('vod_resume', { t: TV.fmtClock(rs) }) : TV.t('vod_play'));
        play.tvOk = function () { self.vodPlay({ item: it, url: card.url, meta: meta }); };
        btns.appendChild(play); focus = play;
        if (rs) {
          var fs = navItem('div', 'btn', 'vstart'); fs.textContent = TV.t('vod_from_start');
          fs.tvOk = function () { self.vodPlay({ item: it, url: card.url, meta: meta, fromStart: true }); };
          btns.appendChild(fs);
        }
        // варианты качества (тоже продолжают с места остановки)
        Object.keys(card.variants || {}).filter(function (q) { return q !== 'auto'; }).forEach(function (q) {
          var b = navItem('div', 'btn', 'vq:' + q); b.textContent = q;
          b.tvOk = function () { self.vodPlay({ item: it, url: card.variants[q], meta: meta }); };
          btns.appendChild(b);
        });
        if (mp && mp.done) right.insertBefore(el('div', 'vfacts', mp.txt), btns);
      } else right.appendChild(el('div', 'warnt', TV.t('vod_noplay')));
      var mc = [TV.t('vod')];
      var fr = p.fr || it._fr, sh = p.fr ? p.short : it._short;
      if (fr) mc.push(fr);
      if (p.base) mc.push(fr ? (sh || p.base) : p.base, p.seasonLabel || d.title || '');
      else mc.push(fr ? (sh || d.title || '') : (d.title || ''));
      return { node: wrap, crumbs: mc, focus: focus };
    },

    search: function (p) {
      var self = this, wrap = el('div', 'search');
      var bar = el('div', 'sbar'); bar.setAttribute('data-zone', 'sbar');
      var inp = el('input', 'sinput big'); inp.id = 'search-input';
      inp.type = 'search'; inp.placeholder = TV.t('search_ph'); inp.spellcheck = false; inp.autocomplete = 'off';
      inp.value = p.q || '';
      inp.setAttribute('data-nav', ''); inp.setAttribute('data-key', 'sq');
      inp.tvOk = function () { inp.focus(); };
      var mic = navItem('div', 'btn mic', 'mic'); mic.textContent = TV.t('voice');
      bar.appendChild(el('span', 'sico')); bar.appendChild(inp); bar.appendChild(mic);
      wrap.appendChild(bar);
      var status = el('div', 'sstatus'); wrap.appendChild(status);
      var res = el('div', 'sres'); wrap.appendChild(res);
      var timer = null, histTimer = null;
      // Enter в поле — тоже запомнить
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') TV.rememberSearch(inp.value); }, true);
      // ушли из поля к результатам (стрелкой, Enter, мышью) — запрос нужный, запоминаем
      inp.addEventListener('blur', function () {
        var q = inp.value.trim(); if (q.length < 2) return;
        var r = TV.Search.run(q, self.uniqueChannels());
        if (r.channels.length || r.progs.length || (TV.Vod.enabled() && q.length >= 3)) TV.rememberSearch(q);
      });
      // заголовок раздела результатов: значок, название, количество
      function head(ico, title, n) {
        var h = el('div', 'shead rhead');
        h.appendChild(el('span', 'rico', ico)); h.appendChild(document.createTextNode(title));
        if (n != null) h.appendChild(el('span', 'rcount', String(n)));
        return h;
      }
      // пустой запрос: заставка и подборки — недавние каналы и «продолжить просмотр»
      function suggest() {
        var hist = TV.searchHist();
        if (hist.length) {
          var hh = head('🕘', TV.t('s_history'), hist.length); res.appendChild(hh);
          var chips = el('div', 'sbtns chips'); chips.setAttribute('data-zone', 'shist');
          hist.forEach(function (q) {
            var c = navItem('div', 'btn chip', 'sh:' + q); c.textContent = q; c.title = TV.t('s_hist_tip');
            c.tvOk = function () { inp.value = q; TV.rememberSearch(q); show(); searchVod(); };
            c.tvLong = function () { TV.forgetSearch(q); show(); Nav.focus(res.querySelector('.chip') || inp, { noScroll: true }); };
            chips.appendChild(c);
          });
          var clr = navItem('div', 'btn chip clr', 'shclr'); clr.textContent = TV.t('s_hist_clear');
          clr.tvOk = function () { TV.store.set('searchHist', []); show(); Nav.focus(inp, { noScroll: true }); };
          chips.appendChild(clr);
          res.appendChild(chips);
        }
        var hero = el('div', 'shero' + (hist.length ? ' small' : ''));
        hero.appendChild(el('div', 'sheroico', '🔍'));
        hero.appendChild(el('div', 'sherot', TV.t('search_hint')));
        res.appendChild(hero);
        var rec = TV.recent(), keys = Object.keys(rec).sort(function (a, b) { return rec[b] - rec[a]; });
        var chs = keys.map(function (k) { return self.byKey[k]; }).filter(Boolean).slice(0, 9);
        if (chs.length) {
          res.appendChild(head('⟲', TV.t('s_recent')));
          var g = el('div', 'grid chans inline'); g.setAttribute('data-zone', 'rrec');
          chs.forEach(function (ch) {
            var t = navItem('div', 'tile chan', 'rr:' + ch.key);
            t.appendChild(logoBox(ch));
            var info = el('div', 'info');
            info.appendChild(el('div', 'name' + TV.errClass(ch.key), ch.name));
            var pr = EPG.at(ch.key, TV.now());
            info.appendChild(el('div', 'sub', pr && pr.title ? pr.title : ch.group));
            t.appendChild(info);
            t.tvOk = function () { self.openChannel(ch); };
            g.appendChild(t);
          });
          res.appendChild(g);
        }
        var hist = TV.Vod.enabled() ? TV.Vod.history().slice(0, 12) : [];
        if (hist.length) {
          res.appendChild(head('🎬', TV.t('s_continue')));
          var vg = el('div', 'grid vgrid inline'); vg.setAttribute('data-zone', 'rhist');
          hist.forEach(function (e) {
            var series = !!e.ep, key = TV.Vod.keyOf(series ? e.ep : e.item);
            var sub = series ? [e.ep.season, e.ep.title].filter(Boolean).join(' · ') : (e.item.year || '');
            var t = self.vodTile('rh:' + e.k, e.item.title, sub, e.item.imglr || e.item.img, self.vodProg(key));
            t.tvOk = function () { self.vodPlay({ item: e.item, ep: e.ep, seasons: e.seasons, gk: e.gk, meta: { title: e.item.title } }); };
            vg.appendChild(t);
          });
          res.appendChild(vg);
        }
      }

      function show() {
        p.q = inp.value;
        res.innerHTML = '';
        var q = inp.value.trim();
        if (!q) { status.textContent = TV.Voice.listening() ? status.textContent : ''; suggest(); return; }
        var r = TV.Search.run(q, self.uniqueChannels());
        // запрос, на котором остановились (2,5 с без изменений) и что-то нашлось, — в историю
        clearTimeout(histTimer);
        if (r.channels.length || r.progs.length || (TV.Vod.enabled() && q.length >= 3)) histTimer = setTimeout(function () { if (inp.value.trim() === q) TV.rememberSearch(q); }, 2500);
        // «ничего не найдено» — только если и медиатека искать не будет
        var vodWill = TV.Vod.enabled() && q.length >= 3;
        if (!TV.Voice.listening()) status.textContent = r.channels.length || r.progs.length
          ? TV.t('found', { c: r.channels.length }) + (q.length >= 3 ? TV.t('found_progs', { p: r.progs.length }) : '')
          : (vodWill ? '' : TV.t('nothing'));
        if (r.channels.length) {
          res.appendChild(head('📺', TV.t('h_channels'), r.channels.length));
          var g = el('div', 'grid chans inline' + (TV.store.get('chanView', 'tiles') === 'list' ? ' list' : '')); g.setAttribute('data-zone', 'rch');
          r.channels.forEach(function (ch) {
            var t = navItem('div', 'tile chan', 'rc:' + ch.key);
            t.appendChild(logoBox(ch));
            var info = el('div', 'info');
            var nm = el('div', 'name' + TV.errClass(ch.key), ch.name); nm.title = TV.errTitle(ch.key);
            info.appendChild(nm);
            info.appendChild(el('div', 'sub', ch.group));
            t.appendChild(info);
            t.tvOk = function () { self.openChannel(ch); };
            t.tvLong = function () { self.channelMenu(ch); };
            t.tvStar = function () { self.toggleFav(ch); };
            g.appendChild(t);
          });
          res.appendChild(g);
        }
        if (r.progs.length) {
          res.appendChild(head('🗓', TV.t('h_progs'), r.progs.length));
          var l = el('div', 'plist'); l.setAttribute('data-zone', 'rpr');
          var now = TV.now(), today = TV.dayStart(now);
          r.progs.forEach(function (it) {
            var st = it.start > now ? 'future' : (it.stop > now ? 'live' : (TV.Catchup.available(it.ch) && it.start >= TV.Catchup.earliest(it.ch) - 60 ? 'arch' : 'gone'));
            var row = navItem('div', 'prog ' + st, 'rp:' + it.ch.key + ':' + it.start);
            var day = TV.dayStart(it.start) === today ? '' : TV.fmtDay(TV.dayStart(it.start)).sub.replace(/,.*$/, '') + ' ';
            row.appendChild(logoBox(it.ch, 'logo sm'));
            row.appendChild(el('div', 'pt wide', day + TV.fmtTime(it.start)));
            row.appendChild(el('div', 'pn', it.title));
            row.appendChild(el('div', 'pch', it.ch.name));
            if (st === 'live') row.appendChild(el('div', 'badge', TV.t('now')));
            row.tvOk = function () {
              if (st === 'future') { TV.toast(TV.t('not_started')); return; }
              if (st === 'gone') { TV.toast(TV.t('gone_toast')); return; }
              PlayerUI.open(it.ch, TV.Catchup.available(it.ch) ? it.start : null);
            };
            l.appendChild(row);
          });
          res.appendChild(l);
        }
      }
      // поиск по медиатеке (с задержкой, от 3 символов)
      var vodBox = el('div', 'vodres'); wrap.appendChild(vodBox);
      var vodTimer = null, vodSeq = 0;
      function searchVod() {
        vodBox.innerHTML = '';
        var q = inp.value.trim();
        if (!TV.Vod.enabled() || q.length < 3) return;
        var my = ++vodSeq;
        clearTimeout(vodTimer);
        vodTimer = setTimeout(function () {
          vodBox.appendChild(el('div', 'shint', TV.t('vod_searching')));
          TV.Vod.search(q).then(function (items) {
            if (my !== vodSeq) return;
            items = TV.Vod.arrange(items);
            vodBox.innerHTML = '';
            if (!items.length) return;
            vodBox.appendChild(head('🎬', TV.t('vod'), items.length));
            var g = el('div', 'grid vgrid inline'); g.setAttribute('data-zone', 'rvod');
            items.slice(0, 60).forEach(function (it, i) {
              var t = navItem('div', 'tile vtile', 'rv:' + i);
              var pic = el('div', 'poster'); var src = it.imglr || it.img;
              if (src) { var im = new Image(); im.loading = 'lazy'; im.src = src; im.alt = ''; im.onerror = function () { im.remove(); }; pic.appendChild(im); }
              t.appendChild(pic);
              t.appendChild(el('div', 'vname', it.title || '—'));
              t.appendChild(el('div', 'sub', [it.year, self.vodKind(it)].filter(Boolean).join(' · ')));
              t.tvOk = function () { self.openVodItem(it); };
              g.appendChild(t);
            });
            vodBox.appendChild(g);
          }).catch(function (e) { if (my === vodSeq) { vodBox.innerHTML = ''; vodBox.appendChild(el('div', 'shint warnt', TV.t('vod_error', { e: e.message || e }))); } });
        }, 600);
      }
      inp.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(show, 200); searchVod(); });

      mic.tvOk = function () {
        if (TV.Voice.listening()) { TV.Voice.stop(); mic.classList.remove('rec'); status.textContent = TV.t('stopped'); return; }
        if (!TV.Voice.available()) { TV.toast(TV.t('voice_na')); return; }
        mic.classList.add('rec'); mic.textContent = TV.t('stop'); var heard = false;
        TV.Voice.listen({
          onState: function (t) { status.textContent = '🎤 ' + t; },
          onPartial: function (t) { heard = true; inp.value = t; status.textContent = '🎤 ' + t + '…'; },
          onResult: function (t) { if (t) { inp.value = t; TV.rememberSearch(t); status.textContent = ''; show(); searchVod(); } },
          onEnd: function () {
            mic.classList.remove('rec'); mic.textContent = TV.t('voice');
            if (!inp.value.trim() && !heard && status.textContent.indexOf(TV.t('speak')) >= 0) status.textContent = TV.t('not_heard');
            // после голосового поиска — сразу на первый результат
            var first = res.querySelector('[data-nav]');
            if (first && inp.value.trim()) Nav.focus(first);
          }
        });
      };
      show(); searchVod();
      if (p.voice) setTimeout(function () { mic.tvOk(); }, 50);
      return { node: wrap, crumbs: [TV.t('search')], focus: p.q ? null : inp };
    },

    schedule: function (p, entry) {
      var self = this, ch = this.byKey[p.key], now = TV.now();
      var today = TV.dayStart(now);
      var nDays = TV_CONFIG.scheduleDays;
      if (!p.keepDay || p.day == null) p.day = p.day != null && p.keepDay ? p.day : today;
      p.keepDay = false;

      var root = el('div', 'sched');
      // шапка канала
      var head = el('div', 'chhead');
      head.appendChild(logoBox(ch, 'logo big'));
      var hn = el('div', 'hn');
      hn.appendChild(el('div', 'name', ch.name));
      hn.appendChild(el('div', 'sub', TV.Catchup.available(ch) ? TV.t('archive_days', { n: TV.Catchup.days(ch) }) : TV.t('no_archive')));
      head.appendChild(hn);
      var hb = el('div', 'hbtns'); hb.setAttribute('data-zone', 'hbtns');
      var live = navItem('div', 'btn', 'live');
      live.textContent = TV.t('live_btn');
      live.tvOk = function () { PlayerUI.open(ch, null); };
      var fav = navItem('div', 'btn', 'fav');
      var favLabel = function () { fav.textContent = TV.t(self.isFav(ch.key) ? 'in_fav' : 'to_fav'); };
      favLabel();
      fav.tvOk = fav.tvLong = function () { self.toggleFav(ch); favLabel(); };
      var lng = navItem('div', 'btn', 'chlang');
      lng.textContent = TV.t('lang_btn', { lang: TV.langName(TV.chLang(ch)) });
      lng.tvOk = function () {
        self.pickLang(TV.t('pick_lang', { name: ch.name }), TV.langOv().ch[ch.key] || '', TV.langOv().grp[ch.group] || ch.lang, function (code) {
          TV.setLangOv('ch', ch.key, code);
          lng.textContent = TV.t('lang_btn', { lang: TV.langName(TV.chLang(ch)) });
          TV.toast(TV.t('lang_set', { name: ch.name, lang: TV.langName(TV.chLang(ch)) }));
        });
      };
      hb.appendChild(live); hb.appendChild(fav); hb.appendChild(lng);
      head.appendChild(hb);
      root.appendChild(head);

      var body = el('div', 'sbody');
      var days = el('div', 'days'); days.setAttribute('data-zone', 'days'); days.setAttribute('data-scroll', 'center');
      var progs = el('div', 'progs'); progs.setAttribute('data-zone', 'progs'); progs.setAttribute('data-scroll', 'center');
      var info = el('div', 'pinfo');
      body.appendChild(days); body.appendChild(progs); body.appendChild(info);
      root.appendChild(body);

      var dayEls = {};
      for (var d = nDays - 1; d >= 0; d--) {
        (function (ds) {
          var f = TV.fmtDay(ds);
          var t = navItem('div', 'day', 'd:' + ds);
          t.appendChild(el('div', 'name', f.title));
          t.appendChild(el('div', 'sub', f.sub));
          t.tvFocus = function () { if (p.day !== ds) { p.day = ds; fillProgs(false); } markDay(); };
          t.tvOk = function () { var x = progs._last || progs.querySelector('[data-nav]'); if (x) Nav.focus(x); };
          dayEls[ds] = t;
          days.appendChild(t);
        })(TV.addDays(today, -d));
      }
      function markDay() {
        for (var k in dayEls) dayEls[k].classList.toggle('sel', +k === p.day);
      }

      function showInfo(it) {
        info.innerHTML = '';
        info.appendChild(el('div', 'time', TV.fmtTime(it.start) + ' – ' + TV.fmtTime(it.stop) + '  ·  ' + TV.t('min', { n: Math.round((it.stop - it.start) / 60) })));
        info.appendChild(el('div', 'title', it.title));
        var st = el('div', 'state ' + it.state, {
          live: TV.t(TV.Catchup.available(ch) ? 'st_live_arch' : 'st_live'),
          arch: TV.t('st_arch'),
          gone: TV.t(TV.Catchup.available(ch) ? 'st_gone' : 'st_noarch'),
          future: TV.t('st_future')
        }[it.state]);
        info.appendChild(st);
        if (it.desc) info.appendChild(el('div', 'desc', it.desc));
      }

      function items(ds) {
        var de = TV.addDays(ds, 1);
        var arr = EPG.list(ch.key).filter(function (x) { return x[0] < de && x[1] > ds && x[0] >= ds - 3 * 3600; })
          .filter(function (x) { return x[0] >= ds || x[1] > ds + 60; })
          .map(function (x) { return { start: x[0], stop: x[1], title: x[2], desc: x[3] }; });
        // где программы нет (вообще или она оборвалась) — часовые отрезки эфира, чтобы архив был доступен
        var noEpg = TV.t(EPG.loading ? 'epg_loading' : 'no_epg_time');
        function slots(from, to) {
          var outS = [];
          for (var h = from; h < to; h = Math.floor(h / 3600) * 3600 + 3600) {
            // последний отрезок (текущий час) — до конца часа, чтобы он считался «идущим сейчас»
            var e2 = Math.floor(h / 3600) * 3600 + 3600;
            if (to < limit || e2 > de) e2 = Math.min(e2, to < limit ? to : de);
            if (e2 - h < 300) continue;
            outS.push({ start: h, stop: e2, title: TV.t('slot', { a: TV.fmtTime(h), b: TV.fmtTime(e2) }), desc: noEpg, slot: true });
          }
          return outS;
        }
        var limit = Math.min(de, now);
        var filled = [], cursor = ds;
        arr.forEach(function (it) {
          if (it.start > cursor + 300 && cursor < limit) filled = filled.concat(slots(cursor, Math.min(it.start, limit)));
          filled.push(it);
          cursor = Math.max(cursor, it.stop);
        });
        if (cursor < limit) filled = filled.concat(slots(cursor, limit));
        if (!TV.Catchup.available(ch)) {
          var hourNow = Math.floor(now / 3600) * 3600;
          filled = filled.filter(function (it) { return !it.slot || it.stop > hourNow; });
        }
        arr = filled;
        var earliest = TV.Catchup.available(ch) ? TV.Catchup.earliest(ch) : now;
        arr.forEach(function (it) {
          it.state = it.start > now ? 'future' : (it.stop > now ? 'live' : (it.start >= earliest - 60 ? 'arch' : 'gone'));
        });
        return arr;
      }

      function fillProgs(focusCurrent) {
        progs.innerHTML = '';
        progs._last = null;
        var arr = items(p.day), cur = null, focusKey = entry.focus;
        arr.forEach(function (it) {
          var r = navItem('div', 'prog ' + it.state, 'p:' + it.start);
          r.appendChild(el('div', 'pt', TV.fmtTime(it.start)));
          r.appendChild(el('div', 'pn', it.title));
          if (it.state === 'live') r.appendChild(el('div', 'badge', TV.t('now')));
          r.tvFocus = function () { showInfo(it); };
          r.tvOk = function () {
            if (it.state === 'future') { TV.toast(TV.t('not_started')); return; }
            if (it.state === 'gone') { TV.toast(TV.t(TV.Catchup.available(ch) ? 'gone_toast' : 'noarch_toast')); return; }
            PlayerUI.open(ch, TV.Catchup.available(ch) ? it.start : null);
          };
          progs.appendChild(r);
          if (it.state === 'live') cur = r;
        });
        if (!arr.length) progs.appendChild(el('div', 'empty', TV.t('no_progs')));
        var target = (focusKey && progs.querySelector('[data-key="' + focusKey + '"]')) || cur ||
          progs.querySelector('[data-nav]');
        progs._last = target;
        if (target) {
          showInfo(arr[Array.prototype.indexOf.call(progs.children, target)]);
          setTimeout(function () { try { target.scrollIntoView({ block: 'center' }); } catch (e) { /* */ } }, 0);
        }
        if (focusCurrent && target) return target;
        return null;
      }
      days._last = dayEls[p.day];
      markDay();
      var first = fillProgs(true);
      entry.focus = null;
      return { node: root, crumbs: [ch.name, TV.t('schedule')], focus: first || dayEls[p.day] };
    }
  };

  // ---------- модальный диалог ----------
  var Dialog = TV.Dialog = {
    open: false,
    show: function (title, buttons, focusIdx, cb, cls) {
      var d = document.getElementById('dialog');
      d.innerHTML = '';
      var box = el('div', 'dbox' + (cls ? ' ' + cls : ''));
      box.appendChild(el('div', 'dtitle', title));
      var row = el('div', 'dbtns'); row.setAttribute('data-zone', 'dlg'); row.setAttribute('data-scroll', 'center');
      var els = buttons.map(function (b) {
        var x = el('div', 'btn', b[0]); x.setAttribute('data-nav', '');
        x.tvOk = function () { Dialog.close(b[1]); };
        row.appendChild(x); return x;
      });
      box.appendChild(row); d.appendChild(box);
      d.classList.remove('hidden');
      if (!d._mouse) { d._mouse = true; TV.bindMouse(d); d.addEventListener('click', function (e) { if (e.target === d) Dialog.close(false); }); }
      this.open = true; this.cb = cb;
      this.prevRoot = Nav.root; this.prevCur = Nav.current;
      Nav.setRoot(d); Nav.current = null; Nav.focus(els[focusIdx || 0], { noScroll: true });
    },
    close: function (val) {
      if (!this.open) return;
      this.open = false;
      document.getElementById('dialog').classList.add('hidden');
      Nav.setRoot(this.prevRoot);
      Nav.current = null;
      if (this.prevCur && this.prevCur.isConnected) Nav.focus(this.prevCur, { noScroll: true });
      var cb = this.cb; this.cb = null;
      if (cb) cb(val);
    }
  };

  function plural(n, a, b, c) {
    var m = n % 10, h = n % 100;
    if (m === 1 && h !== 11) return a;
    if (m >= 2 && m <= 4 && (h < 10 || h >= 20)) return b;
    return c;
  }

  // ---------- экранное меню плеера ----------
  var PlayerUI = TV.PlayerUI = {
    init: function () {
      var self = this;
      this.root = document.getElementById('player');
      this.osd = document.getElementById('osd');
      this.ctrls = document.getElementById('ctrls');
      this.bar = document.getElementById('bar');
      this.err = document.getElementById('perr');
      P.onChange = function () { self.update(); };
      // фильм/серия закончились: отмечаем просмотренным; у сериала — следующая серия
      P.onEnded = function () {
        var m = self.vod; if (!m) return;
        var d = P.duration(); TV.Vod.savePos(m.key, d, d);
        if (self.eps && self.epIdx >= 0 && self.epIdx < self.eps.length - 1) {
          TV.toast(TV.t('vod_next_ep', { t: [self.eps[self.epIdx + 1].season, self.eps[self.epIdx + 1].title].filter(Boolean).join(' · ') }), 3000);
          setTimeout(function () { if (self.vod === m && App.playing) self.goEp(1); }, 2500);
        }
      };
      P.onError = function (msg, details, kind) { self.showErr(msg, true, kind); };
      P.onCodec = function (list) { self.showErr(TV.t('codec_unsupported', { codec: list.join(', ') }), true); };
      var acts = {
        rwbig: function () { P.skip(-TV_CONFIG.seekBig); },
        rw: function () { P.skip(-TV_CONFIG.seekSmall); },
        play: function () { P.toggle(); },
        ff: function () { P.skip(TV_CONFIG.seekSmall); },
        ffbig: function () { P.skip(TV_CONFIG.seekBig); },
        prevp: function () { if (P.mode === 'vod') self.goEp(-1); else self.prevProg(); },
        nextp: function () { if (P.mode === 'vod') self.goEp(1); else self.nextProg(); },
        live: function () { P.goLive(); },
        info: function () { self.toggleInfo(); },
        volup: function () { P.changeVolume(10); self.volHud(); },
        voldown: function () { P.changeVolume(-10); self.volHud(); },
        mute: function () { P.toggleMute(); self.volHud(); }
      };
      Array.prototype.forEach.call(this.ctrls.querySelectorAll('[data-act]'), function (b) {
        b.setAttribute('data-nav', '');
        b.tvOk = function () { acts[b.getAttribute('data-act')](); self.poke(); };
        b.addEventListener('click', function (e) { e.stopPropagation(); Nav.focus(b, { noScroll: true }); b.tvOk(); });
      });
      this.root.addEventListener('mousemove', function () { self.poke(); });
      // колесо мыши — громкость
      this.root.addEventListener('wheel', function (e) {
        e.preventDefault();
        P.changeVolume(e.deltaY < 0 ? 5 : -5); self.volHud(); self.poke();
      }, { passive: false });
      document.getElementById('video').addEventListener('click', function () { P.toggle(); self.poke(); });
      document.getElementById('video').addEventListener('dblclick', function () { if (window.native && window.native.toggleFullscreen) window.native.toggleFullscreen(); });
      this.bar.addEventListener('click', function (e) {
        e.stopPropagation();
        var r = self.bar.getBoundingClientRect(), pr = self.prog;
        if (P.mode === 'vod') { P.seek((e.clientX - r.left) / r.width * P.duration()); self.poke(); return; }
        if (!pr || !P.canSeek()) return;
        var t = pr.start + (e.clientX - r.left) / r.width * (pr.stop - pr.start);
        P.seek(t); self.poke();
      });
      this.root.addEventListener('mouseup', function (e) { if (e.button === 3) { e.preventDefault(); App.back(); } });
      setInterval(function () { if (App.playing) self.update(); }, 500);
    },

    open: function (ch, startUtc) {
      this.osd.classList.remove('vod', 'hasprev', 'hasnext'); this.vod = null; this.eps = null;
      this.epTitles(false);
      App.playing = true;
      this._okMode = null;
      TV.markWatched(ch.key);
      this.errShown = false; this.audioWarned = false; this._okMode = null;
      document.getElementById('pnote').classList.add('hidden');
      this.osd.classList.remove('noseek');
      var top = App.stack[App.stack.length - 1];
      top.focus = Nav.current && Nav.current.getAttribute('data-key');
      this.ch = ch;
      this.btnMode = false;
      this.err.classList.add('hidden');
      document.getElementById('app').classList.add('hidden');
      this.root.classList.remove('hidden');
      document.getElementById('osd-name').textContent = ch.name;
      var lg = document.getElementById('osd-logo'); lg.innerHTML = ''; lg.appendChild(logoBox(ch, 'logo'));
      P.open(ch, startUtc);
      this.poke();
      this.update();
    },

    // Фильм/серия из медиатеки (start — с какой секунды продолжить)
    openVod: function (meta, url, start) {
      if (App.playing && this.vod) this.saveProgress(); // переход на другую серию из плеера
      else {
        var top = App.stack[App.stack.length - 1];
        top.focus = Nav.current && Nav.current.getAttribute('data-key');
      }
      App.playing = true;
      this.errShown = false; this.audioWarned = false; this._okMode = null;
      document.getElementById('pnote').classList.add('hidden');
      this.osd.classList.remove('noseek', 'hasprev', 'hasnext');
      this.osd.classList.add('vod');
      var ch = { key: 'vod:' + (meta.key || meta.title), name: meta.title, logo: meta.img || '', group: '', catchup: { enabled: false } };
      this.ch = ch; this.vod = meta; this.eps = null; this.epIdx = -1; this._saveT = Date.now(); this._okMode = null;
      this.epTitles(true);
      this.err.classList.add('hidden');
      document.getElementById('app').classList.add('hidden');
      this.root.classList.remove('hidden');
      document.getElementById('osd-name').textContent = TV.t('vod');
      var lg = document.getElementById('osd-logo'); lg.innerHTML = ''; lg.appendChild(logoBox(ch, 'logo'));
      P.openVod(ch, url, start);
      if (start > 0) TV.toast(TV.t('vod_resume', { t: TV.fmtClock(start) }), 2500);
      this.poke();
      this.update();
    },
    // подсказки кнопок ⏮ ⏭: серии в медиатеке, передачи на каналах
    epTitles: function (vod) {
      var a = this.ctrls.querySelector('[data-act="prevp"]'), b = this.ctrls.querySelector('[data-act="nextp"]');
      if (a) a.title = TV.t(vod ? 'c_prev_ep' : 'c_prev');
      if (b) b.title = TV.t(vod ? 'c_next_ep' : 'c_next');
    },
    // список серий сериала пришёл — включаем ⏮ ⏭ если есть куда переходить
    setEpisodes: function (meta, list) {
      if (this.vod !== meta) return;
      var idx = -1;
      for (var i = 0; i < list.length; i++) if (TV.Vod.keyOf(list[i]) === meta.key) { idx = i; break; }
      this.eps = list; this.epIdx = idx;
      this.osd.classList.toggle('hasprev', idx > 0);
      this.osd.classList.toggle('hasnext', idx >= 0 && idx < list.length - 1);
    },
    goEp: function (d) {
      if (!this.vod || !this.eps || this.epIdx < 0) return;
      var i = this.epIdx + d;
      if (i < 0 || i >= this.eps.length) { TV.toast(TV.t('vod_no_more')); return; }
      var c = this.vod.ctx;
      var ep = this.eps[i];
      App.vodPlay({ item: ep._parent || c.item, ep: ep, meta: c.meta, seasons: c.seasons, gk: c.gk });
    },
    // место остановки фильма/серии
    saveProgress: function () {
      if (P.mode !== 'vod' || !this.vod || !this.vod.key) return;
      var pos = P.position(), dur = P.duration();
      if (pos > 0 && (dur > 0 || pos > 15)) TV.Vod.savePos(this.vod.key, pos, dur);
      this._saveT = Date.now();
    },

    close: function () {
      this.saveProgress();
      this.osd.classList.remove('vod', 'hasprev', 'hasnext'); this.vod = null; this.eps = null;
      var pos = P.position(), ch = this.ch;
      P.stop();
      App.playing = false;
      this.root.classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      Nav.setRoot(document.getElementById('app'));
      // возвращаемся к программе на передаче, которую смотрели последней
      var top = App.stack[App.stack.length - 1];
      if (top.name === 'schedule' && ch) {
        var pr = EPG.at(ch.key, pos);
        top.params.day = TV.dayStart(Math.max(pr.start, TV.dayStart(pos)));
        top.params.keepDay = true;
        top.focus = 'p:' + pr.start;
      }
      App.render();
    },

    showErr: function (msg, offerExternal, kind) {
      var self = this;
      // отметить в списках: прямой эфир и фильм — светло-красным, архив — жёлтым
      if (this.ch) {
        var ek = P.mode === 'archive' ? 'a' : 'l';
        TV.markErr(this.ch.key, ek);
        if (this.vod && this.vod.ctx && this.vod.ctx.ep) TV.markErr('vod:' + TV.Vod.keyOf(this.vod.ctx.item), 'l');
        this._okMode = null;
      }
      this.err.innerHTML = '';
      this.err.appendChild(el('div', '', TV.t('player_err_back', { msg: msg })));
      // архив пуст — сразу предлагаем прямой эфир
      if (kind === 'archive-empty') {
        var lb = el('div', 'btn ext', TV.t('live_btn'));
        lb.addEventListener('click', function (e) { e.stopPropagation(); self.err.classList.add('hidden'); self.errShown = false; P.goLive(); });
        this.err.appendChild(lb);
      }
      // запасной путь — внешний плеер (VLC), туда передаётся тот же поток (в т. ч. архив)
      if (window.native && window.native.openExternal) {
        var b = el('div', 'btn ext', TV.t('open_vlc'));
        b.addEventListener('click', function (e) { e.stopPropagation(); self.openExternal(); });
        this.err.appendChild(b);
        this.err.appendChild(el('div', 'shint', TV.t('open_vlc_hint')));
      }
      this.err.classList.remove('hidden');
      this.errShown = true;
    },

    openExternal: function () {
      if (!window.native || !window.native.openExternal || !P.url) return;
      var url = P.url;
      window.native.openExternal(url).then(function (r) {
        if (r && r.ok) { TV.toast(TV.t('vlc_started')); P.pause(); }
        else TV.toast(TV.t('vlc_missing'), 5000);
      });
    },

    toggleInfo: function () {
      var box = document.getElementById('pinfo');
      this.infoOn = !this.infoOn;
      box.classList.toggle('hidden', !this.infoOn);
      this.renderInfo();
    },
    renderInfo: function () {
      if (!this.infoOn) return;
      var i = P.info(), box = document.getElementById('pinfo');
      var rows = [['mode', i.mode === 'live' ? TV.t('live') : TV.t('archive')], ['i_size', i.size], ['i_video', i.video], ['i_audio', i.audio],
        ['i_frames', i.frames], ['i_bitrate', i.bitrate], ['i_buffer', i.buffer], ['i_state', i.state], ['i_error', i.error]];
      box.innerHTML = '';
      box.appendChild(el('div', 'ptitle', TV.t('i_title')));
      rows.forEach(function (r) {
        var d = el('div', 'prow'); d.appendChild(el('span', 'pk', r[0] === 'mode' ? TV.t('i_mode') : TV.t(r[0]))); d.appendChild(el('span', 'pv', r[1])); box.appendChild(d);
      });
    },

    poke: function () {
      var self = this;
      this.osd.classList.add('show');
      this.root.classList.remove('nocursor');
      clearTimeout(this.hideT);
      this.hideT = setTimeout(function () {
        if (P.isPaused() || self.btnMode) return;
        self.osd.classList.remove('show');
        self.root.classList.add('nocursor');
      }, 4000);
    },

    volHud: function () {
      var h = document.getElementById('volhud'), v = P.volume();
      document.getElementById('volhud-ico').textContent = v === 0 ? '🔇' : v < 40 ? '🔈' : v < 75 ? '🔉' : '🔊';
      document.getElementById('volhud-val').textContent = v === 0 ? TV.t('muted') : v + '%';
      document.getElementById('volhud-fill').style.width = v + '%';
      h.classList.remove('hidden');
      clearTimeout(this.volT);
      this.volT = setTimeout(function () { h.classList.add('hidden'); }, 1500);
      this.update();
    },

    prevProg: function () {
      var pos = P.displayPosition(), pr = EPG.at(this.ch.key, pos);
      var t = pos - pr.start > 15 ? pr.start : EPG.at(this.ch.key, pr.start - 1).start;
      P.seek(t);
    },
    nextProg: function () {
      var pr = EPG.at(this.ch.key, P.displayPosition());
      if (pr.stop >= TV.now() - 15) P.goLive(); else P.seek(pr.stop + 1);
    },

    key: function (a, e) {
      this.poke();
      if (this.btnMode) {
        if (a === 'left' || a === 'right') { Nav.move(a); return; }
        if (a === 'ok') { Nav.ok(); return; }
        if (a === 'up' || a === 'back') { this.setBtnMode(false); return; }
      }
      var n = this._rep = e.repeat ? (this._rep || 0) + 1 : 0;
      // без архива и без окна перемотки — перемотка и переходы между передачами недоступны
      if (!P.canSeek() && ['left', 'right', 'rw', 'ff', 'next', 'prev'].indexOf(a) >= 0) return;
      var mult = 1 + Math.min(9, Math.floor(n / 4));
      switch (a) {
        case 'left': P.skip(-TV_CONFIG.seekSmall * mult); break;
        case 'right': P.skip(TV_CONFIG.seekSmall * mult); break;
        case 'rw': P.skip(-TV_CONFIG.seekBig); break;
        case 'ff': P.skip(TV_CONFIG.seekBig); break;
        case 'space': if (!e.repeat) P.toggle(); break;
        case 'play': P.play(); break;
        case 'pause': P.pause(); break;
        case 'down': this.setBtnMode(true); break;
        case 'info': this.toggleInfo(); break;
        case 'ok': case 'playpause':
          // на экране ошибки «пустой архив» OK — перейти в прямой эфир
          if (this.errShown && P.mode === 'archive' && !e.repeat && P.diag && /levelEmpty/.test(P.diag.lastError)) {
            this.err.classList.add('hidden'); this.errShown = false; P.goLive(); return;
          }
          if (!e.repeat) P.toggle(); break;
        case 'ext': this.openExternal(); break;
        case 'volup': P.changeVolume(e.repeat ? 5 : 10); this.volHud(); break;
        case 'voldown': P.changeVolume(e.repeat ? -5 : -10); this.volHud(); break;
        case 'mute': if (!e.repeat) { P.toggleMute(); this.volHud(); } break;
        case 'up': break;
        case 'next': if (!e.repeat) { if (P.mode === 'vod') this.goEp(1); else this.nextProg(); } break;
        case 'prev': if (!e.repeat) { if (P.mode === 'vod') this.goEp(-1); else this.prevProg(); } break;
        case 'stop': case 'back': if (!e.repeat) this.close(); break;
      }
      this.update();
    },

    setBtnMode: function (on) {
      this.btnMode = on;
      this.osd.classList.toggle('btnmode', on);
      if (on) {
        Nav.setRoot(this.ctrls);
        Nav.focus(this.ctrls.querySelector('[data-act="play"]'), { noScroll: true });
      } else {
        if (Nav.current) Nav.current.classList.remove('focused');
        Nav.current = null;
        Nav.setRoot(document.getElementById('app'));
      }
      this.poke();
    },

    update: function () {
      if (!App.playing || !this.ch) return;
      if (P.mode === 'vod') { this.updateVod(); this.updateCommon(); return; }
      var now = TV.now(), pos = P.displayPosition();
      var pr = this.prog = EPG.at(this.ch.key, pos);
      var title = pr.title || TV.t(P.mode === 'live' ? 'live' : 'archive');
      document.getElementById('osd-title').textContent = title;
      document.getElementById('osd-desc').textContent = pr.desc || '';
      document.getElementById('t-start').textContent = TV.fmtTime(pr.start);
      document.getElementById('t-stop').textContent = TV.fmtTime(pr.stop);
      var d = new Date(pos * 1000);
      var behind = now - pos;
      var isLive = P.mode === 'live' && behind < 40 && !P.isPaused();
      document.getElementById('t-pos').textContent =
        TV.pad(d.getHours()) + ':' + TV.pad(d.getMinutes()) + ':' + TV.pad(d.getSeconds()) +
        (isLive ? '' : '   ' + TV.t('behind', { t: behind >= 86400 ? TV.t('days_short', { n: Math.floor(behind / 86400) }) + ' ' + TV.fmtClock(behind % 86400) : TV.fmtClock(behind) }));
      var badge = document.getElementById('osd-badge');
      badge.textContent = TV.t(isLive ? 'badge_live' : 'badge_arch');
      badge.className = 'badge ' + (isLive ? 'live' : 'arch');
      var span = pr.stop - pr.start;
      var f = Math.max(0, Math.min(1, (pos - pr.start) / span));
      var avail = Math.max(0, Math.min(1, (now - pr.start) / span));
      document.getElementById('bar-fill').style.width = (f * 100) + '%';
      document.getElementById('bar-avail').style.width = (avail * 100) + '%';
      document.getElementById('bar-head').style.left = (f * 100) + '%';
      this.bar.classList.toggle('pending', P.pendingTarget != null);
      this.updateCommon();
    },

    // Фильм: время от начала, длительность, полоса по файлу
    updateVod: function () {
      var m = this.vod || {}, pos = P.displayPosition(), dur = P.duration();
      if (Date.now() - (this._saveT || 0) > 5000 && !P.pendingTarget) this.saveProgress();
      document.getElementById('osd-title').textContent = m.title || '';
      document.getElementById('osd-desc').textContent = m.desc || '';
      document.getElementById('t-start').textContent = '0:00';
      document.getElementById('t-stop').textContent = dur ? TV.fmtClock(dur) : '';
      document.getElementById('t-pos').textContent = TV.fmtClock(pos) + (dur ? ' / ' + TV.fmtClock(dur) : '');
      var badge = document.getElementById('osd-badge');
      badge.textContent = TV.t(m.series ? 'badge_ep' : 'badge_vod'); badge.className = 'badge arch';
      var f = dur ? Math.max(0, Math.min(1, pos / dur)) : 0;
      document.getElementById('bar-fill').style.width = (f * 100) + '%';
      document.getElementById('bar-avail').style.width = '100%';
      document.getElementById('bar-head').style.left = (f * 100) + '%';
      this.bar.classList.toggle('pending', P.pendingTarget != null);
    },

    updateCommon: function () {
      this.renderInfo();
      // 5 секунд нормального воспроизведения — снимаем отметку об ошибке для этого режима
      var v = P.video, mode = P.mode === 'archive' ? 'a' : 'l';
      if (!this.errShown && !P.isPaused() && v.readyState >= 3 && !v.seeking && v.currentTime > 0) {
        if (this._okMode !== mode) { this._okMode = mode; this._okSince = Date.now(); this._okDone = false; }
        else if (!this._okDone && Date.now() - this._okSince > 5000) {
          this._okDone = true;
          TV.clearErr(this.ch.key, mode);
          if (this.vod && this.vod.ctx && this.vod.ctx.ep) TV.clearErr('vod:' + TV.Vod.keyOf(this.vod.ctx.item), 'l');
        }
      } else if (this.errShown) this._okMode = null;
      // видео не декодируется (кадров нет) — сообщаем, какой кодек
      if (!this.errShown && P.noVideo()) {
        var vc = P.diag && P.diag.codecs.video;
        this.showErr(TV.t('no_video', { codec: vc ? P.codecName(vc.codec) : '?' }), true);
      }
      if (!this.audioWarned && P.noAudio()) {
        this.audioWarned = true;
        var note = document.getElementById('pnote');
        note.textContent = TV.t('no_audio') + (window.native && window.native.openExternal ? ' ' + TV.t('no_audio_vlc') : '');
        note.classList.remove('hidden');
        setTimeout(function () { note.classList.add('hidden'); }, 12000);
      }
      var noseek = !P.canSeek();
      if (this.osd.classList.contains('noseek') !== noseek) {
        this.osd.classList.toggle('noseek', noseek);
        document.querySelector('.phint').textContent = TV.t(noseek ? 'hint_player_live' : 'hint_player');
        // если фокус был на скрытой кнопке — переводим на паузу
        if (noseek && this.btnMode && Nav.current && Nav.current.classList.contains('seekbtn')) Nav.focus(this.ctrls.querySelector('[data-act="play"]'), { noScroll: true });
      }
      var vv = P.volume();
      document.getElementById('vol-ico').textContent = vv === 0 ? '🔇' : vv < 40 ? '🔈' : vv < 75 ? '🔉' : '🔊';
      document.getElementById('vol-val').textContent = vv + '%';
      var pb = this.ctrls.querySelector('[data-act="play"]');
      pb.textContent = P.isPaused() ? '▶' : '❚❚';
      document.getElementById('pspin').classList.toggle('hidden', !P.isBuffering() || P.pendingTarget != null);
      document.getElementById('pausemark').classList.toggle('hidden', !P.isPaused());
      if (P.isPaused()) this.osd.classList.add('show');
    }
  };

  document.addEventListener('DOMContentLoaded', function () { App.start(); });
})(window.TV);
