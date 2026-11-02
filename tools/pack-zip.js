// Упаковать собранную папку dist/win-unpacked в dist/EdemPlayer-<версия>-win-x64.zip (папка EdemPlayer внутри)
'use strict';
const { execSync } = require('child_process'), path = require('path'), fs = require('fs');
const root = path.join(__dirname, '..'), v = require(path.join(root, 'package.json')).version;
const out = path.join(root, 'dist', 'EdemPlayer-' + v + '-win-x64.zip');
const stage = path.join(root, 'dist', 'stage');
fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
fs.renameSync(path.join(root, 'dist', 'win-unpacked'), path.join(stage, 'EdemPlayer'));
fs.rmSync(out, { force: true });
execSync('cd "' + stage + '" && zip -qr -9 "' + out + '" EdemPlayer');
fs.renameSync(path.join(stage, 'EdemPlayer'), path.join(root, 'dist', 'win-unpacked'));
fs.rmSync(stage, { recursive: true, force: true });
console.log(out, (fs.statSync(out).size / 1048576).toFixed(1) + ' MB');
