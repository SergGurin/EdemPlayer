'use strict';
const { app, BrowserWindow, protocol, net, ipcMain, Menu, globalShortcut, shell, clipboard, dialog } = require('electron');
const http = require('http');
const https = require('https');
const dns = require('dns');
const tcp = require('net');
const fs = require('fs');
const { spawn } = require('child_process');

// Внешний плеер для форматов, которые не воспроизводятся встроенным (VLC, PotPlayer, mpv)
function findPlayer() {
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  const rel = [['VideoLAN', 'VLC', 'vlc.exe'], ['DAUM', 'PotPlayer', 'PotPlayerMini64.exe'], ['DAUM', 'PotPlayer', 'PotPlayerMini.exe'], ['mpv', 'mpv.exe']];
  for (const base of pf) for (const r of rel) { const f = path.join(base, ...r); if (fs.existsSync(f)) return f; }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const n of ['vlc.exe', 'mpv.exe', 'vlc', 'mpv']) { const f = path.join(dir, n); try { if (fs.existsSync(f)) return f; } catch (e) { /* */ } }
  }
  return null;
}

// ---------- Защищённый DNS (DNS-over-HTTPS) ----------
// Провайдер может блокировать домен только на своём DNS. Тогда адрес узнаём у Cloudflare/Google по HTTPS
// (серверы указаны IP-адресами, сам их DNS не нужен). Режим: auto — DoH при неудаче системного DNS, on — всегда, off — никогда.
const DOH = ['https://1.1.1.1/dns-query?name={h}&type=A', 'https://8.8.8.8/resolve?name={h}&type=A', 'https://9.9.9.9:5053/dns-query?name={h}&type=A'];
const DOH_TPL = ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'];
let dnsMode = 'auto';
const dohCache = new Map();
function dohGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/dns-json' }, timeout: 6000 }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString('utf8'))); } catch (e) { reject(e); } });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', reject);
  });
}
async function dohResolve(host) {
  const c = dohCache.get(host);
  if (c && Date.now() - c.t < 600000) return c;
  let last = null;
  for (const tpl of DOH) {
    try {
      const j = await dohGet(tpl.replace('{h}', encodeURIComponent(host)));
      const ips = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
      if (ips.length) { const r = { ips, via: new URL(tpl).hostname, t: Date.now() }; dohCache.set(host, r); return r; }
      last = Object.assign(new Error('no A record'), { code: j.Status === 3 ? 'NXDOMAIN' : 'NOANSWER' });
    } catch (e) { last = e; }
  }
  throw last || new Error('DoH failed');
}
function dnsLookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  opts = opts || {};
  const ret = (ips) => (opts.all ? cb(null, ips.map((a) => ({ address: a, family: 4 }))) : cb(null, ips[0], 4));
  const viaDoh = (err) => dohResolve(host).then((r) => ret(r.ips), () => cb(err || Object.assign(new Error('getaddrinfo ENOTFOUND ' + host), { code: 'ENOTFOUND' })));
  if (tcp.isIP(host) || dnsMode === 'off') return dns.lookup(host, opts, cb);
  if (dnsMode === 'on') return viaDoh(null);
  dns.lookup(host, opts, (err, a, f) => (err ? viaDoh(err) : cb(null, a, f)));
}
function applyDns(mode) {
  dnsMode = ['on', 'off'].includes(mode) ? mode : 'auto';
  try {
    app.configureHostResolver({ enableBuiltInResolver: true, secureDnsMode: dnsMode === 'on' ? 'secure' : dnsMode === 'off' ? 'off' : 'automatic', secureDnsServers: dnsMode === 'off' ? [] : DOH_TPL });
  } catch (e) { /* старый Electron */ }
}
function tcpTest(host, port) {
  const t0 = Date.now();
  return new Promise((res) => {
    const sock = tcp.connect({ host, port, timeout: 8000 });
    sock.on('connect', () => { sock.destroy(); res({ ok: true, ms: Date.now() - t0 }); });
    sock.on('timeout', () => { sock.destroy(); res({ ok: false, code: 'TIMEOUT', ms: Date.now() - t0 }); });
    sock.on('error', (e) => res({ ok: false, code: e.code || 'ERR', ms: Date.now() - t0 }));
  });
}

// HTTP-запрос из основного процесса (Node): без Origin/CORS, с точной причиной ошибки
function nodeRequest(o, hops) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let u;
    try { u = new URL(o.url); } catch (e) { return resolve({ error: 'BAD_URL', message: String(e.message) }); }
    const mod = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({ 'User-Agent': app.userAgentFallback, 'Accept': '*/*' }, o.headers || {});
    const body = o.body != null ? Buffer.from(String(o.body), 'utf8') : null;
    if (body) headers['Content-Length'] = body.length;
    const req = mod.request(u, { method: o.method || 'GET', headers, timeout: o.timeout || 25000, lookup: dnsLookup }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && (hops || 0) < 5) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        const keep = res.statusCode === 307 || res.statusCode === 308;
        return resolve(nodeRequest(Object.assign({}, o, { url: next, method: keep ? o.method : 'GET', body: keep ? o.body : null }), (hops || 0) + 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', text: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - t0 }));
      res.on('error', (e) => resolve({ error: e.code || 'ERR', message: e.message, ms: Date.now() - t0 }));
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })); });
    req.on('error', (e) => resolve({ error: e.code || 'ERR', message: e.message, ms: Date.now() - t0 }));
    if (body) req.write(body);
    req.end();
  });
}

// HTTP-запрос сетевым модулем Chromium из основного процесса: системный прокси/VPN как в браузере,
// без CORS и предварительных OPTIONS-запросов
const CR_ERR = { ERR_NAME_NOT_RESOLVED: 'ENOTFOUND', ERR_NAME_RESOLUTION_FAILED: 'ENOTFOUND', ERR_CONNECTION_REFUSED: 'ECONNREFUSED',
  ERR_CONNECTION_TIMED_OUT: 'TIMEOUT', ERR_TIMED_OUT: 'TIMEOUT', ERR_CONNECTION_RESET: 'ECONNRESET', ERR_CONNECTION_CLOSED: 'ECONNRESET',
  ERR_EMPTY_RESPONSE: 'ECONNRESET', ERR_ADDRESS_UNREACHABLE: 'EHOSTUNREACH', ERR_INTERNET_DISCONNECTED: 'ENETUNREACH', ERR_NETWORK_CHANGED: 'ECONNRESET' };
function chromiumRequest(o) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const fin = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(Object.assign({ ms: Date.now() - t0, engine: 'chromium' }, r)); } };
    let req;
    try { req = net.request({ method: o.method || 'GET', url: o.url, redirect: 'follow', useSessionCookies: false, cache: 'no-store' }); }
    catch (e) { return resolve({ error: 'BAD_URL', message: String(e.message) }); }
    const timer = setTimeout(() => { try { req.abort(); } catch (e) { /* */ } fin({ error: 'TIMEOUT', message: 'no answer in ' + Math.round((o.timeout || 25000) / 1000) + ' s' }); }, o.timeout || 25000);
    const headers = Object.assign({ 'User-Agent': app.userAgentFallback, 'Accept': '*/*' }, o.headers || {});
    for (const k of Object.keys(headers)) { try { req.setHeader(k, String(headers[k])); } catch (e) { /* */ } }
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const ct = res.headers['content-type'];
        fin({ status: res.statusCode, type: Array.isArray(ct) ? ct[0] : (ct || ''), text: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', (e) => fin({ error: 'ECONNRESET', message: String(e && e.message || e) }));
    });
    req.on('error', (e) => {
      const m = /net::(ERR_[A-Z_]+)/.exec(String(e && e.message || e));
      fin({ error: (m && CR_ERR[m[1]]) || (m ? m[1] : 'ERR'), message: m ? m[1] : String(e && e.message || e) });
    });
    if (o.body != null) req.write(String(o.body));
    req.end();
  });
}
// Пошаговая проверка сети до сервера: DNS → прокси → TCP
async function netDiag(url) {
  const out = {};
  let u; try { u = new URL(url); } catch (e) { return { error: 'BAD_URL' }; }
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  out.host = u.hostname; out.port = port;
  try { out.proxy = await (win ? win.webContents.session : require('electron').session.defaultSession).resolveProxy(url); } catch (e) { out.proxy = '?'; }
  out.mode = dnsMode;
  let t0 = Date.now();
  try { const a = await dns.promises.lookup(u.hostname, { all: true }); out.dns = { ok: true, ips: a.map((x) => x.address), ms: Date.now() - t0 }; }
  catch (e) { out.dns = { ok: false, code: e.code || 'ERR', ms: Date.now() - t0 }; }
  if (out.dns.ok) out.tcp = await tcpTest(out.dns.ips[0], port);
  // системный DNS не нашёл адрес, выдал подставной или сервер не отвечает — спросить защищённый DNS
  const fake = out.dns.ok && /^127\./.test(out.dns.ips[0]) && out.dns.ips[0] !== '127.0.0.1';
  if (!tcp.isIP(u.hostname) && (!out.dns.ok || fake || !out.tcp.ok)) {
    t0 = Date.now();
    try {
      dohCache.delete(u.hostname);
      const r = await dohResolve(u.hostname);
      out.doh = { ok: true, ips: r.ips, via: r.via, ms: Date.now() - t0 };
      if (!out.dns.ok || r.ips[0] !== out.dns.ips[0]) out.doh.tcp = await tcpTest(r.ips[0], port);
    } catch (e) { out.doh = { ok: false, code: e.code || String(e.message || e), ms: Date.now() - t0 }; }
  }
  return out;
}
const path = require('path');
const { pathToFileURL } = require('url');

// для проверки: отдельная папка данных (EDP_USERDATA)
if (process.env.EDP_USERDATA) app.setPath('userData', process.env.EDP_USERDATA);
const updater = require('./updater');

// Собственная схема app:// — нормальное происхождение страницы (воркеры, IndexedDB, localStorage)
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

// Один экземпляр приложения
if (!app.requestSingleInstanceLock()) app.quit();

// Пользовательский агент без «Electron» — некоторые IPTV-серверы его не любят
app.userAgentFallback = app.userAgentFallback.replace(/\s*Electron\/\S+/, '').replace(/\s*edemplayer\/\S+/i, '');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// аппаратное декодирование HEVC (H.265) — часть HD-каналов идёт в этом формате
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

let win;
let allowClose = false;
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 760, minWidth: 800, minHeight: 480,
    backgroundColor: '#0b0e14',
    title: 'EdemPlayer',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // поток и программа передач приходят с чужих http-серверов без CORS-заголовков
      webSecurity: false,
      backgroundThrottling: false
    }
  });
  Menu.setApplicationMenu(null);
  win.loadURL('app://tv/index.html');
  // Боковая кнопка мыши «назад» и клавиша «Назад» на мультимедийных клавиатурах
  win.on('app-command', (e, cmd) => { if (cmd === 'browser-backward') win.webContents.send('back'); });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' && input.control && input.shift) { win.webContents.toggleDevTools(); return; }
    // меню окна отключено — правку текста (Ctrl+C/V/X/A/Z/Y) выполняем сами
    if ((input.control || input.meta) && !input.alt) {
      const k = String(input.key).toLowerCase(), wc = win.webContents;
      const act = { c: 'copy', 'с': 'copy', v: 'paste', 'м': 'paste', x: 'cut', 'ч': 'cut', a: 'selectAll', 'ф': 'selectAll', z: input.shift ? 'redo' : 'undo', 'я': input.shift ? 'redo' : 'undo', y: 'redo', 'н': 'redo' }[k];
      if (act) { e.preventDefault(); wc[act](); }
      else if (input.key === 'Insert') { e.preventDefault(); wc.copy(); }
    } else if (input.shift && input.key === 'Insert') { e.preventDefault(); win.webContents.paste(); }
  });
  // правый щелчок по полю ввода или выделенному тексту — меню правки
  win.webContents.on('context-menu', (e, p) => {
    const items = [];
    if (p.isEditable) items.push({ role: 'cut', label: 'Вырезать', enabled: p.editFlags.canCut }, { role: 'copy', label: 'Копировать', enabled: p.editFlags.canCopy },
      { role: 'paste', label: 'Вставить', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll', label: 'Выделить всё' });
    else if (p.selectionText) items.push({ role: 'copy', label: 'Копировать' });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  // закрытие окна — сначала спрашиваем пользователя (ответ придёт через ipc 'quit')
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    win.webContents.send('ask-exit');
  });
  // микрофон для голосового поиска
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' || permission === 'fullscreen'));
  ses.setPermissionCheckHandler((wc, permission) => permission === 'media' || permission === 'fullscreen');
  // файл настроек — сразу в «Загрузки», без диалога (удобно с пульта)
  ses.on('will-download', (e, item) => {
    item.setSavePath(path.join(app.getPath('downloads'), item.getFilename()));
  });
  // не открываем новые окна
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (process.argv.includes('--fullscreen')) win.setFullScreen(true);
}

app.whenReady().then(() => {
  applyDns('auto'); // интерфейс затем передаст выбранный режим
  updater.prepare(); // готовое обновление интерфейса — подменить до открытия окна
  updater.onEvent = (st) => { if (win && !win.isDestroyed()) win.webContents.send('upd', st); };
  ipcMain.handle('upd-info', () => ({ app: app.getVersion(), ui: updater.active().version, shell: updater.SHELL, repo: updater.repo(), status: updater.status }));
  ipcMain.handle('upd-check', () => updater.check(true));
  ipcMain.on('upd-restart', () => { allowClose = true; app.relaunch(); app.exit(0); });
  // проверка обновлений: через 20 с после запуска и раз в 6 часов
  // самопроверка механизма обновления (EDP_UPDATE_TEST=1): проверить, вывести состояние и выйти
  if (process.env.EDP_UPDATE_TEST) { updater.check(true).then((st) => { console.log('UPD ' + JSON.stringify(st) + ' ACTIVE ' + JSON.stringify(updater.active()) + ' RESOLVE ' + updater.resolve('js/app.js')); app.exit(0); }); return; }
  setTimeout(() => updater.check(false), 20000);
  setInterval(() => updater.check(false), 6 * 3600 * 1000);
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    // файл интерфейса: из обновлённой копии (если есть), иначе из установленной
    const file = updater.resolve(rel);
    if (!file) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  ipcMain.on('fullscreen', () => win && win.setFullScreen(!win.isFullScreen()));
  ipcMain.on('quit', () => { allowClose = true; app.quit(); });
  ipcMain.handle('open-external', (e, url) => {
    if (!/^https?:\/\//i.test(String(url))) return { ok: false };
    const exe = findPlayer();
    if (!exe) return { ok: false };
    try { spawn(exe, [url], { detached: true, stdio: 'ignore' }).unref(); return { ok: true, player: path.basename(exe) }; }
    catch (err) { return { ok: false, error: String(err) }; }
  });
  ipcMain.handle('http', (e, o) => {
    if (!o || !/^https?:\/\//i.test(String(o.url))) return { error: 'BAD_URL', message: 'bad url' };
    if (o.engine === 'node') return nodeRequest(o, 0);
    // Chromium не нашёл адрес — повторить через Node с защищённым DNS
    return chromiumRequest(o).then((r) => (r.error === 'ENOTFOUND' && dnsMode !== 'off' ? nodeRequest(o, 0).then((r2) => (r2.error ? r : r2)) : r));
  });
  // буфер обмена и сохранение файла (окно «Сохранить как»)
  ipcMain.handle('clip-read', () => clipboard.readText());
  ipcMain.handle('clip-write', (e, t) => { clipboard.writeText(String(t == null ? '' : t)); return true; });
  ipcMain.handle('save-file', async (e, name, text) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), String(name || 'EdemPlayer.json')), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return { __err: 'cancel' };
    fs.writeFileSync(r.filePath, String(text), 'utf8');
    return { ok: true, name: r.filePath };
  });
  ipcMain.on('dns-mode', (e, m) => applyDns(String(m || 'auto')));
  ipcMain.handle('net-diag', (e, url) => netDiag(String(url || '')));
  // открыть страницу в системном браузере (получение токена Яндекс.Диска)
  ipcMain.handle('open-url', (e, url) => { if (/^https:\/\//i.test(String(url))) { shell.openExternal(String(url)); return true; } return false; });
  createWindow();
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
