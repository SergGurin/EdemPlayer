// Манифест обновления интерфейса: update/manifest.json = { version, shell, files: { "www/…": sha256 } }
// Запуск: node tools/make-manifest.js  (после изменения файлов в www и номера версии в package.json)
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const files = {};
(function walk(dir) {
  for (const n of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, n), rel = path.relative(root, f).split(path.sep).join('/');
    if (fs.statSync(f).isDirectory()) { if (rel !== 'www/models') walk(f); continue; }  // голосовая модель не обновляется
    files[rel] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  }
})(path.join(root, 'www'));
const m = { app: 'EdemPlayer', version: pkg.version, shell: pkg.edemShell || 1, date: new Date().toISOString(), files };
fs.mkdirSync(path.join(root, 'update'), { recursive: true });
fs.writeFileSync(path.join(root, 'update', 'manifest.json'), JSON.stringify(m, null, 1) + '\n');
console.log('update/manifest.json:', m.version, Object.keys(files).length, 'файлов');
