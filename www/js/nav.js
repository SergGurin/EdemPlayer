(function (TV) {
  'use strict';

  // Коды пультов: Android TV, webOS, Tizen, клавиатура, медиаклавиши
  TV.keyAction = function (e) {
    var k = e.key, c = e.keyCode;
    switch (k) {
      case 'ArrowUp': case 'Up': return 'up';
      case 'ArrowDown': case 'Down': return 'down';
      case 'ArrowLeft': case 'Left': return 'left';
      case 'ArrowRight': case 'Right': return 'right';
      case 'Enter': case 'Select': case 'Accept': return 'ok';
      case 'Escape': case 'Esc': case 'Backspace': case 'BrowserBack': case 'GoBack': case 'XF86Back': return 'back';
      case 'MediaPlayPause': case 'PlayPause': return 'playpause';
      case 'MediaPlay': case 'Play': return 'play';
      case 'MediaPause': case 'Pause': return 'pause';
      case 'MediaStop': case 'Stop': return 'stop';
      case 'MediaFastForward': case 'FastFwd': return 'ff';
      case 'MediaRewind': case 'Rewind': return 'rw';
      case 'MediaTrackNext': case 'ChannelUp': case 'PageUp': return 'next';
      case 'MediaTrackPrevious': case 'ChannelDown': case 'PageDown': return 'prev';
      case 'ContextMenu': case 'ColorF2Yellow': case 'f': case 'F': case 'а': case 'А': return 'fav';
      case ' ': case 'Spacebar': return 'space';
      case 'F11': return 'fullscreen';
      case 'BrowserSearch': case 'Search': return 'search';
      case '+': case '=': return 'volup';
      case '-': case '_': return 'voldown';
      case 'm': case 'M': case 'ь': case 'Ь': return 'mute';
      case 'i': case 'I': case 'ш': case 'Ш': case 'Info': return 'info';
      case 'v': case 'V': case 'м': case 'М': return 'ext';
    }
    switch (c) {
      case 38: return 'up'; case 40: return 'down'; case 37: return 'left'; case 39: return 'right';
      case 13: return 'ok';
      case 27: case 8: case 461: case 10009: return 'back';
      case 179: case 10252: return 'playpause';
      case 415: return 'play';
      case 19: return 'pause';
      case 413: return 'stop';
      case 417: return 'ff';
      case 412: return 'rw';
      case 427: case 33: case 176: return 'next';
      case 428: case 34: case 177: return 'prev';
      case 405: case 93: return 'fav';
      case 457: return 'info';
      case 107: case 187: return 'volup';
      case 109: case 189: return 'voldown';
    }
    return null;
  };

  function visible(el) {
    if (!el.isConnected || el.offsetParent === null) return false;
    return !el.closest('.hidden');
  }
  function rect(el) { return el.getBoundingClientRect(); }

  var Nav = TV.Nav = {
    root: null,
    current: null,

    setRoot: function (root) { this.root = root; },

    items: function () {
      return Array.prototype.filter.call(this.root.querySelectorAll('[data-nav]'), visible);
    },

    focus: function (el, opts) {
      if (!el) return;
      if (this.current && this.current !== el) this.current.classList.remove('focused');
      this.current = el;
      el.classList.add('focused');
      var zone = el.closest('[data-zone]');
      if (zone) zone._last = el;
      if (!(opts && opts.noScroll)) {
        var block = zone && zone.getAttribute('data-scroll') === 'center' ? 'center' : 'nearest';
        try { el.scrollIntoView({ block: block, inline: 'nearest' }); } catch (e) { el.scrollIntoView(false); }
      }
      if (el.tvFocus) el.tvFocus(el);
    },

    focusFirst: function () { var a = this.items(); if (a.length) this.focus(a[0]); },

    move: function (dir) {
      var cur = this.current;
      var all = this.items();
      if (!cur || all.indexOf(cur) < 0) { if (all.length) this.focus(all[0]); return; }
      var r0 = rect(cur);
      var cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
      var zone = cur.closest('[data-zone]');
      var best = null, bestScore = Infinity, bestSame = null, bestSameScore = Infinity;
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el === cur) continue;
        var r = rect(el);
        var ex = r.left + r.width / 2, ey = r.top + r.height / 2;
        var primary, secondary, overlap;
        if (dir === 'down') { if (r.top < r0.bottom - 2 && ey <= cy + 1) continue; primary = Math.max(0, r.top - r0.bottom); overlap = Math.min(r.right, r0.right) - Math.max(r.left, r0.left); secondary = Math.abs(ex - cx); }
        else if (dir === 'up') { if (r.bottom > r0.top + 2 && ey >= cy - 1) continue; primary = Math.max(0, r0.top - r.bottom); overlap = Math.min(r.right, r0.right) - Math.max(r.left, r0.left); secondary = Math.abs(ex - cx); }
        else if (dir === 'right') { if (r.left < r0.right - 2 && ex <= cx + 1) continue; primary = Math.max(0, r.left - r0.right); overlap = Math.min(r.bottom, r0.bottom) - Math.max(r.top, r0.top); secondary = Math.abs(ey - cy); }
        else { if (r.right > r0.left + 2 && ex >= cx - 1) continue; primary = Math.max(0, r0.left - r.right); overlap = Math.min(r.bottom, r0.bottom) - Math.max(r.top, r0.top); secondary = Math.abs(ey - cy); }
        var score = primary + (overlap > 0 ? secondary * 0.1 : secondary * 2 + 1000);
        if (el.closest('[data-zone]') === zone) {
          if (score < bestSameScore) { bestSameScore = score; bestSame = el; }
        }
        if (score < bestScore) { bestScore = score; best = el; }
      }
      // Внутри зоны (список, сетка) — только если кандидат реально по направлению с перекрытием
      var target = bestSame && bestSameScore < 1000 ? bestSame : best;
      if (!target) return false;
      var tz = target.closest('[data-zone]');
      if (tz && tz !== zone && tz._last && visible(tz._last)) target = tz._last;
      this.focus(target);
      return true;
    },

    ok: function () { if (this.current && this.current.tvOk) this.current.tvOk(this.current); },
    long: function () { if (this.current && this.current.tvLong) this.current.tvLong(this.current); }
  };

  // Делегирование мыши: наведение = фокус, клик = OK, правая кнопка = долгое нажатие
  TV.bindMouse = function (root) {
    root.addEventListener('mousemove', function (e) {
      var el = e.target.closest && e.target.closest('[data-nav]');
      if (el && el !== Nav.current && visible(el)) Nav.focus(el, { noScroll: true });
    });
    root.addEventListener('click', function (e) {
      var el = e.target.closest && e.target.closest('[data-nav]');
      if (!el) return;
      if (e.target.closest('[data-star]') && (el.tvStar || el.tvLong)) { Nav.focus(el, { noScroll: true }); (el.tvStar || el.tvLong)(el); return; }
      Nav.focus(el, { noScroll: true });
      if (el.tvOk) el.tvOk(el);
    });
    root.addEventListener('contextmenu', function (e) {
      var el = e.target.closest && e.target.closest('[data-nav]');
      // в полях ввода — обычное меню правки (Вырезать / Копировать / Вставить)
      if (/INPUT|TEXTAREA/.test(e.target.tagName)) return;
      e.preventDefault();
      if (el && el.tvLong) { Nav.focus(el, { noScroll: true }); el.tvLong(el); }
    });
  };
})(window.TV);
