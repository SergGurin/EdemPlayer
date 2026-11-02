'use strict';
/*
 * Обновление интерфейса EdemPlayer с GitHub без перекачки Electron.
 *
 * Оболочка (Electron + electron/*.js) ставится один раз. Интерфейс (папка www) обновляется отдельно:
 *  • в репозитории лежит update/manifest.json: { version, shell, files: { "www/js/app.js": "<sha256>", … } };
 *  • программа сравнивает версию, скачивает только изменившиеся файлы (сверяя SHA-256),
 *    собирает новую копию в <userData>/app-next и при следующем запуске подменяет ею <userData>/app;
 *  • если для новой версии нужна более новая оболочка (manifest.shell > SHELL), предлагается скачать полный пакет;
 *  • большие неизменные файлы (голосовая модель) не обновляются — берутся из установленной программы.
 * Источники: raw.githubusercontent.com, при недоступности — зеркало jsDelivr.
 */
const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHELL = 1; // версия оболочки (main.js/preload.js); растёт, когда интерфейсу нужны новые возможности оболочки

const pkg = (() => { try { return require(path.join(__dirname, '..', 'package.json')); } catch (e) { return {}; } })();
const CFG = Object.assign({ branch: 'main' }, pkg.edemUpdate || {});
if (!CFG.repo) CFG.repo = 'SergGurin/EdemPlayer'; // источник по умолчанию

const BUNDLED = path.join(__dirname, '..');                 // установленная копия: <..>/www
const UDIR = () => path.join(app.getPath('userData'), 'app');
const NDIR = () => path.join(app.getPath('userData'), 'app-next');

function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map(Number), pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function fileHash(f) { try { return sha256(fs.readFileSync(f)); } catch (e) { return null; } }
function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* */ } }

// Адреса источников обновления (можно переопределить переменной EDP_UPDATE_BASE — для проверки)
function bases() {
  if (process.env.EDP_UPDATE_BASE) return [process.env.EDP_UPDATE_BASE.replace(/\/+$/, '')];
  if (!CFG.repo) return [];
  return [
    'https://raw.githubusercontent.com/' + CFG.repo + '/' + CFG.branch,
    'https://cdn.jsdelivr.net/gh/' + CFG.repo + '@' + CFG.branch
  ];
}

const U = {
  SHELL,
  repo: () => CFG.repo,
  releasesUrl: () => CFG.repo ? 'https://github.com/' + CFG.repo + '/releases' : '',
  status: { state: 'idle', version: null, error: null },
  onEvent: null,
  emit(ev) { Object.assign(U.status, ev); if (U.onEvent) try { U.onEvent(Object.assign({}, U.status)); } catch (e) { /* */ } },

  // При запуске: если готова новая копия — подменить; вернуть папку, откуда грузить интерфейс
  prepare() {
    const next = NDIR(), cur = UDIR();
    const nv = readJson(path.join(next, 'version.json'));
    if (nv && nv.ready && nv.shell <= SHELL) {
      rmrf(cur + '-old');
      try { if (fs.existsSync(cur)) fs.renameSync(cur, cur + '-old'); fs.renameSync(next, cur); rmrf(cur + '-old'); }
      catch (e) { /* не вышло — останемся на прежней */ }
    } else if (fs.existsSync(next)) rmrf(next);
    U._act = U.active(); // до перезапуска активная копия не меняется
    return U._act;
  },
  // Какая копия интерфейса активна: обновлённая (если новее установленной и подходит оболочке) или установленная
  active() {
    const v = readJson(path.join(UDIR(), 'version.json'));
    if (v && v.ready && v.shell <= SHELL && cmpVer(v.version, app.getVersion()) > 0 && fs.existsSync(path.join(UDIR(), 'www', 'index.html'))) {
      return { root: UDIR(), version: v.version, updated: true };
    }
    return { root: BUNDLED, version: app.getVersion(), updated: false };
  },
  // Файл интерфейса: из активной копии, иначе из установленной (большие файлы не обновляются)
  resolve(rel) {
    const a = U._act || U.active();
    const roots = a.root === BUNDLED ? [BUNDLED] : [a.root, BUNDLED];
    for (const r of roots) {
      const www = path.join(r, 'www'), f = path.normalize(path.join(www, rel));
      if (!f.startsWith(www)) return null;
      if (fs.existsSync(f)) return f;
    }
    return null;
  },

  async _get(url, binary) {
    const r = await net.fetch(url, { cache: 'no-store', headers: { 'User-Agent': 'EdemPlayer-updater' } });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url.replace(/^https?:\/\/([^/]+).*$/, '$1'));
    return binary ? Buffer.from(await r.arrayBuffer()) : r.text();
  },
  async _manifest() {
    let lastErr = null;
    for (const b of bases()) {
      try {
        const m = JSON.parse(await U._get(b + '/update/manifest.json?t=' + Date.now()));
        if (m && m.version && m.files) return { m, base: b };
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('no update source');
  },

  // Проверить и скачать. manual — пользователь нажал «Проверить»: сообщаем и об отсутствии обновлений
  async check(manual) {
    if (U.busy) return U.status;
    if (!bases().length) { U.emit({ state: 'off', error: null }); return U.status; }
    U.busy = true;
    try {
      U.emit({ state: 'checking', error: null });
      const { m, base } = await U._manifest();
      const cur = U.active();
      const pending = readJson(path.join(NDIR(), 'version.json'));
      if (pending && pending.ready && pending.version === m.version) { U.emit({ state: 'ready', version: m.version }); return U.status; }
      if (cmpVer(m.version, cur.version) <= 0) { U.emit({ state: 'latest', version: cur.version }); return U.status; }
      if ((m.shell || 1) > SHELL) { U.emit({ state: 'shell', version: m.version, url: U.releasesUrl() }); return U.status; }
      // собираем новую копию: неизменные файлы копируем, изменённые скачиваем с проверкой SHA-256
      const next = NDIR(); rmrf(next);
      const files = Object.keys(m.files);
      let done = 0, got = 0;
      for (const rel of files) {
        const want = m.files[rel];
        if (!/^www\//.test(rel) || rel.indexOf('..') >= 0) continue;
        const dst = path.join(next, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        const local = [path.join(cur.root, rel), path.join(BUNDLED, rel)].find((f) => fileHash(f) === want);
        if (local) fs.copyFileSync(local, dst);
        else {
          const buf = await U._get(base + '/' + rel.split('/').map(encodeURIComponent).join('/'), true);
          if (sha256(buf) !== want) throw new Error('checksum ' + rel);
          fs.writeFileSync(dst, buf); got++;
        }
        done++;
        if (done % 10 === 0) U.emit({ state: 'downloading', version: m.version, progress: Math.round(done / files.length * 100) });
      }
      fs.writeFileSync(path.join(next, 'version.json'), JSON.stringify({ version: m.version, shell: m.shell || 1, ready: true, files: got, t: Date.now() }));
      U.emit({ state: 'ready', version: m.version, files: got });
    } catch (e) {
      rmrf(NDIR());
      U.emit({ state: 'error', error: String(e && e.message || e) });
    } finally { U.busy = false; }
    return U.status;
  }
};

module.exports = U;
