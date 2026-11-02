(function (TV) {
  'use strict';
  /*
   * Резервная копия настроек: Яндекс.Диск (OAuth-токен) или свой сервер / TextDB.online.
   *  • Привязка — к коду синхронизации (12 символов), который создаётся при первом сохранении
   *    и запоминается на устройстве; на другом устройстве его вводят, чтобы загрузить настройки.
   *  • Имя записи: «edp-» + SHA-256 от кода (одностороннее). Содержимое зашифровано AES-GCM
   *    ключом, выведенным из кода (PBKDF2): без кода запись не прочитать.
   *  • Удаление — запись пустого значения.
   */
  var enc = new TextEncoder(), dec = new TextDecoder();

  function b64(buf) {
    var s = '', a = new Uint8Array(buf);
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s);
  }
  function unb64(str) {
    var s = atob(str), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  function b64url(buf) { return b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

  // Ключи, которые попадают в облако
  var KEYS = ['syncCode', 'srcMode', 'playlistUrl', 'accessKey', 'channelDomain', 'epgUrls', 'hiddenLangs', 'langOverrides', 'uiLang', 'favs', 'volume', 'muted', 'fileName', 'recent', 'cloudUrl', 'vportal', 'vodSort', 'vodProto', 'vodHistory', 'vodPos', 'searchHist', 'chanView'];
  // параметры доступа к самому облаку — только в файл (в облаке они не нужны)
  var FILE_KEYS = ['cloudProvider', 'yaToken', 'yaFolder'];
  var YA = 'https://cloud-api.yandex.net/v1/disk';

  var C = TV.Cloud = {
    // где хранить: 'yadisk' — Яндекс.Диск, 'url' — свой сервер / textdb.online
    provider: function () { return TV.store.get('cloudProvider', 'yadisk'); },
    yaApi: function () { return (TV_CONFIG.yaApi || YA).replace(/\/+$/, ''); },
    yaFolder: function () { return (String(TV.store.get('yaFolder', '') || 'EdemPlayer').trim().replace(/[\\:*?"<>|]+/g, '').replace(/^\/+|\/+$/g, '') || 'EdemPlayer'); },
    yaPath: function (id) { return 'disk:/' + C.yaFolder() + '/' + id + '.json'; },
    _ya: function (method, rel, body) {
      var tok = String(TV.store.get('yaToken', '') || '').trim();
      if (!tok) { var e0 = new Error(TV.t('ya_need_token')); e0.plain = true; return Promise.reject(e0); }
      return TV.http({ url: C.yaApi() + rel, method: method, headers: { Authorization: 'OAuth ' + tok, Accept: 'application/json' }, body: body, timeout: 30000 }).then(function (r) {
        var j = null; try { j = r.text ? JSON.parse(r.text) : null; } catch (x) { /* */ }
        if (r.status === 401) { var e1 = new Error(TV.t('ya_bad_token')); e1.plain = true; throw e1; }
        r.json = j;
        return r;
      });
    },
    _yaErr: function (r) {
      var j = r.json || {};
      var e = new Error(TV.t('ya_err', { e: 'HTTP ' + r.status + (j.message || j.description ? ' — ' + (j.message || j.description) : '') }));
      e.plain = true; return e;
    },
    // проверка токена: логин и свободное место
    yaCheck: function () {
      return C._ya('GET', '/').then(function (r) {
        if (r.status !== 200 || !r.json) throw C._yaErr(r);
        var u = r.json.user || {};
        return { login: u.display_name || u.login || '?', free: (r.json.total_space || 0) - (r.json.used_space || 0) };
      });
    },
    _yaEnsureFolder: function () {
      return C._ya('PUT', '/resources?path=' + encodeURIComponent('disk:/' + C.yaFolder())).then(function (r) {
        if (r.status === 201 || r.status === 409 || r.status === 200) return true;
        throw C._yaErr(r);
      });
    },
    _yaPut: function (id, text) {
      return C._yaEnsureFolder().then(function () {
        return C._ya('GET', '/resources/upload?overwrite=true&path=' + encodeURIComponent(C.yaPath(id)));
      }).then(function (r) {
        if (r.status !== 200 || !r.json || !r.json.href) throw C._yaErr(r);
        return TV.http({ url: r.json.href, method: r.json.method || 'PUT', headers: { 'Content-Type': 'application/json' }, body: text, timeout: 60000 });
      }).then(function (r) {
        if (r.status !== 201 && r.status !== 202 && r.status !== 200) throw C._yaErr(r);
        return true;
      });
    },
    _yaGet: function (id) {
      return C._ya('GET', '/resources/download?path=' + encodeURIComponent(C.yaPath(id))).then(function (r) {
        if (r.status === 404) return null;
        if (r.status !== 200 || !r.json || !r.json.href) throw C._yaErr(r);
        return TV.http({ url: r.json.href, method: 'GET', timeout: 60000 }).then(function (d) {
          if (d.status === 404) return null;
          if (d.status >= 400) throw C._yaErr(d);
          return d.text;
        });
      });
    },
    _yaDel: function (id) {
      return C._ya('DELETE', '/resources?permanently=true&path=' + encodeURIComponent(C.yaPath(id))).then(function (r) {
        if (r.status === 204 || r.status === 202 || r.status === 404 || r.status === 200) return true;
        throw C._yaErr(r);
      });
    },

    // Адрес хранилища: из настроек (свой сервер) или textdb.online по умолчанию
    base: function () { return (TV.store.get('cloudUrl', '') || TV_CONFIG.cloudUrl || 'https://textdb.online').replace(/\/+$/, ''); },
    // свой сервер (edp-cloud.php): ?key=… ; textdb.online: /<key> и /update/
    isPhp: function () { return /\.php$/i.test(C.base()); },
    readUrl: function (id) { return C.isPhp() ? C.base() + '?key=' + encodeURIComponent(id) : C.base() + '/' + id; },
    writeUrl: function () { return C.isPhp() ? C.base() : C.base() + '/update/'; },
    host: function () { if (C.provider() === 'yadisk') return 'disk.yandex.ru'; try { return new URL(C.base()).host; } catch (e) { return C.base(); } },
    // сетевые ошибки — понятным текстом
    _net: function (p) {
      return p.catch(function (e) {
        if (e && e.plain) throw e;
        if (e && (e.name === 'TypeError' || /fetch|network/i.test(String(e.message)))) { var er = new Error(TV.t('cloud_unreachable', { host: C.host() })); er.plain = true; throw er; }
        throw e;
      });
    },

    // Имя записи — односторонний хэш ключа доступа
    recordId: function (secret) {
      return crypto.subtle.digest('SHA-256', enc.encode('EdemPlayer/id/v1:' + secret)).then(function (h) { return 'edp-' + b64url(h); });
    },

    _aesKey: function (secret) {
      return crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']).then(function (base) {
        return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode('EdemPlayer/cloud/v1'), iterations: 150000, hash: 'SHA-256' },
          base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
    },

    // ---------- код синхронизации (если ключа Edem нет) ----------
    ALPH: '23456789ABCDEFGHJKLMNPQRSTUVWXYZ', // без похожих 0/O, 1/I
    genCode: function () {
      var a = crypto.getRandomValues(new Uint8Array(12)), s = '';
      for (var i = 0; i < 12; i++) s += C.ALPH[a[i] % 32];
      return s;
    },
    fmtCode: function (c) { return c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8, 12); },
    // Введённая строка → { secret, kind: 'code'|'key', label }
    parseInput: function (s) {
      var raw = String(s || '').trim();
      if (!raw) return null;
      // код синхронизации: 12 символов из алфавита (с дефисами или без)
      var c2 = raw.toUpperCase().replace(/[\s-]/g, '');
      if (/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/.test(c2) && (raw.indexOf('-') > 0 || c2.length === 12)) {
        return { secret: 'sync:' + c2, kind: 'code', label: C.fmtCode(c2), code: c2 };
      }
      return null; // не код синхронизации
    },
    // Что использовать на этом устройстве: ключ Edem, иначе код синхронизации (создаётся при необходимости)
    // Код синхронизации этого устройства (создаётся при первом сохранении)
    current: function (create) {
      var code = TV.store.get('syncCode', '');
      if (!code && create) { code = C.genCode(); TV.store.set('syncCode', code); }
      return Promise.resolve(code ? { secret: 'sync:' + code, kind: 'code', label: C.fmtCode(code), code: code } : null);
    },

    collect: function () {
      var o = {};
      KEYS.forEach(function (k) { var v = TV.store.get(k, undefined); if (v !== undefined) o[k] = v; });
      return TV.idb.get('file').then(function (f) {
        // файл плейлиста — только если небольшой (лимит записи 200 000 символов)
        if (f && f.text && f.text.length < 90000) o.__file = f;
        return o;
      });
    },

    _post: function (id, value) {
      if (C.provider() === 'yadisk') return C._net(value ? C._yaPut(id, value) : C._yaDel(id));
      return C._net(fetch(C.writeUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'key=' + encodeURIComponent(id) + '&value=' + encodeURIComponent(value),
        cache: 'no-store'
      })).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text().then(function (t) {
          try { var j = JSON.parse(t); if (j && (j.status === 0 || j.status === false)) throw new Error(j.message || 'error'); } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
          return true;
        });
      });
    },

    save: function (secret) {
      return Promise.all([C.recordId(secret), C._aesKey(secret), C.collect()]).then(function (r) {
        var iv = crypto.getRandomValues(new Uint8Array(12));
        var plain = enc.encode(JSON.stringify(r[2]));
        return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, r[1], plain).then(function (ct) {
          var payload = JSON.stringify({ v: 1, t: Date.now(), iv: b64(iv), d: b64(ct) });
          return C._post(r[0], payload).then(function () { return r[0]; });
        });
      });
    },

    // Прочитать запись: null — записи нет
    fetchRecord: function (secret) {
      return C.recordId(secret).then(function (id) {
        var get = C.provider() === 'yadisk' ? C._net(C._yaGet(id)) : C._net(fetch(C.readUrl(id), { cache: 'no-store' })).then(function (r) {
          if (r.status === 404) return null;
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        });
        return get.then(function (t) {
          if (!t || !t.trim()) return null;
          var j; try { j = JSON.parse(t); } catch (e) { return null; }
          return j && j.d ? j : null;
        });
      });
    },

    load: function (secret) {
      return Promise.all([C.fetchRecord(secret), C._aesKey(secret)]).then(function (r) {
        var rec = r[0];
        if (!rec) return null;
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, r[1], unb64(rec.d)).catch(function () {
          throw new Error('decrypt');
        }).then(function (plain) {
          var o = JSON.parse(dec.decode(plain));
          return C.apply(o).then(function () {
            // чем открыли копию — запоминаем: код синхронизации или ключ Edem
            if (secret.indexOf('sync:') === 0) TV.store.set('syncCode', secret.slice(5));
            return { time: rec.t, data: o };
          });
        });
      });
    },

    // Применить набор настроек (из облака или из файла)
    apply: function (o) {
      var file = o.__file; delete o.__file;
      Object.keys(o).forEach(function (k) { if (KEYS.indexOf(k) >= 0 || FILE_KEYS.indexOf(k) >= 0) TV.store.set(k, o[k]); });
      return file && file.text ? TV.idb.set('file', file) : Promise.resolve();
    },

    // ---------- перенос через файл ----------
    exportFile: function () {
      return C.collect().then(function (o) {
        FILE_KEYS.forEach(function (k) { var v = TV.store.get(k, undefined); if (v !== undefined) o[k] = v; });
        var data = JSON.stringify({ app: 'EdemPlayer', type: 'settings', v: 1, t: Date.now(), settings: o }, null, 2);
        var blob = new Blob([data], { type: 'application/json' });
        var d = new Date(), pad = TV.pad;
        var name = 'EdemPlayer-settings-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.json';
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name;
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
        return name;
      });
    },
    importText: function (text) {
      var j = JSON.parse(text);
      if (!j || j.app !== 'EdemPlayer' || !j.settings) throw new Error('format');
      return C.apply(j.settings).then(function () { return j; });
    },

    remove: function (secret) {
      return C.recordId(secret).then(function (id) { return C._post(id, ''); });
    }
  };
})(window.TV);
