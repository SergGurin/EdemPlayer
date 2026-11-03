(function () {
  'use strict';
  /*
   * Мост Android-оболочки: объект AndroidNative (Java) → window.native (тот же API, что в Electron).
   * Асинхронные вызовы возвращают Promise: Java отвечает через window.__nativeCb(id, json).
   * В Windows-версии и в браузере AndroidNative нет — файл ничего не делает.
   */
  var A = window.AndroidNative;
  if (!A) return;
  var seq = 0, cbs = {}, backCb = null, exitCb = null, updCb = null;
  window.__nativeCb = function (id, json) {
    var c = cbs[id]; if (!c) return; delete cbs[id];
    var r = null; try { r = JSON.parse(json); } catch (e) { /* */ }
    if (r && r.__err) c.rej(new Error(r.__err)); else c.res(r);
  };
  function call(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (res, rej) {
      var id = 'c' + (++seq); cbs[id] = { res: res, rej: rej };
      try { A[fn].apply(A, [id].concat(args)); } catch (e) { delete cbs[id]; rej(e); }
    });
  }
  // «Назад» на пульте: Java вызывает __nativeBack(); true — обработано
  window.__nativeBack = function () { if (backCb) { backCb(); return true; } return false; };
  window.__nativeUpd = function (json) { try { if (updCb) updCb(JSON.parse(json)); } catch (e) { /* */ } };
  window.native = {
    platform: 'android',
    onBack: function (cb) { backCb = cb; },
    onAskExit: function (cb) { exitCb = cb; },
    toggleFullscreen: function () { /* на ТВ всегда весь экран */ },
    quit: function () { A.quit(); },
    openExternal: function (url) { return Promise.resolve({ ok: !!A.openExternal(String(url)) }); },
    openUrl: function (url) { A.openUrl(String(url)); return Promise.resolve(true); },
    http: function (o) { return call('http', JSON.stringify(o || {})); },
    netDiag: function (url) { return call('netDiag', String(url)); },
    mediaUrl: typeof A.mediaUrl === 'function' ? function (u) { return call('mediaUrl', String(u)).then(function (r) { return r && r.url || u; }, function () { return u; }); } : undefined,
    setDns: typeof A.setDns === 'function' ? function (m) { A.setDns(String(m)); } : undefined,
    speech: function (lang) { return call('speech', lang || 'ru-RU').then(function (r) { return r && r.text || ''; }); },
    speechStop: function () { A.speechStop(); },
    saveFile: function (name, text) { return call('saveFile', String(name), String(text)); },
    clipboard: {
      read: function () { return call('clipRead').then(function (r) { return r && r.text || ''; }); },
      write: function (t) { A.clipWrite(String(t == null ? '' : t)); return Promise.resolve(true); }
    },
    update: {
      info: function () { return Promise.resolve(JSON.parse(A.updInfo())); },
      check: function () { return call('updCheck'); },
      restart: function () { A.updRestart(); },
      onEvent: function (cb) { updCb = cb; }
    }
  };
})();
