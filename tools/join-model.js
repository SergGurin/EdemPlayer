// Склеивает модель Vosk из частей (www/models/*.part*), если цельного файла ещё нет.
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'www', 'models');
const name = 'vosk-model-small-ru-0.4.tar.gz';
const target = path.join(dir, name);
if (fs.existsSync(target)) process.exit(0);
const parts = fs.readdirSync(dir).filter(f => f.startsWith(name + '.part')).sort();
if (!parts.length) { console.warn('Модель распознавания речи не найдена — голосовой поиск будет недоступен'); process.exit(0); }
fs.writeFileSync(target, Buffer.concat(parts.map(p => fs.readFileSync(path.join(dir, p)))));
console.log('Модель распознавания речи собрана: ' + name);
