(function (TV) {
  'use strict';

  var P = TV.Player = {
    video: null, hls: null, ch: null,
    mode: 'live',         // 'live' | 'archive'
    originUtc: 0,         // момент, с которого запрошен архивный поток
    baseCT: null,         // currentTime первого фрагмента
    pendingTarget: null, pendingTimer: null,
    pausedAt: 0, pausedPos: 0, userPaused: false,
    errors: 0, onError: null, onChange: null,

    init: function (video) {
      this.video = video;
      var self = this;
      // громкость хранится на устройстве
      video.volume = Math.max(0, Math.min(1, TV.store.get('volume', 1)));
      video.muted = !!TV.store.get('muted', false);
      video.addEventListener('ended', function () {
        if (!self.ch) return;
        if (self.mode === 'vod') { self.userPaused = true; self._changed(); if (self.onEnded) self.onEnded(); return; } // фильм закончился
        // архив дошёл до момента запроса — продолжаем с этой точки
        var pos = self.position();
        if (TV.now() - pos < 20) self.goLive(); else self.load(pos);
      });
      video.addEventListener('playing', function () { self.errors = 0; self._changed(); });
      video.addEventListener('waiting', function () { self._changed(); });
      video.addEventListener('pause', function () { self._changed(); });
    },

    _changed: function () { if (this.onChange) this.onChange(); },

    canArchive: function () { return TV.Catchup.available(this.ch); },

    // Можно ли перематывать: есть архив, либо сам поток держит окно перемотки ≥ 2 минут
    canSeek: function () {
      if (this.mode === 'vod') return true;
      if (this.canArchive()) return true;
      var v = this.video;
      if (v && v.seekable && v.seekable.length) {
        var w = v.seekable.end(v.seekable.length - 1) - v.seekable.start(0);
        if (isFinite(w) && w >= 120) return true;
      }
      return false;
    },

    // Открыть канал с момента startUtc (null — прямой эфир)
    open: function (ch, startUtc) {
      this.ch = ch;
      this.mode = 'live';
      this.userPaused = false;
      this.errors = 0;
      if (startUtc != null && this.canArchive() && startUtc < TV.now() - 20) this.load(startUtc);
      else this.goLive();
    },

    load: function (utc) {
      utc = Math.max(Math.floor(utc), Math.floor(TV.Catchup.earliest(this.ch)));
      this.mode = 'archive';
      this.originUtc = utc;
      this._attach(TV.Catchup.url(this.ch, utc), true);
    },

    // Фильм/серия из медиатеки: обычная перемотка по времени файла
    openVod: function (ch, url, start) {
      this.ch = ch;
      this._vodStart = start > 0 ? start : 0;
      this.userPaused = false;
      this.errors = 0;
      this.mode = 'vod';
      this.originUtc = 0;
      if (/\.(mp4|m4v|webm|mov|mkv)(\?|$)/i.test(url)) this._attachNative(url);
      else this._attach(url, true);
    },
    _attachNative: function (url) {
      var self = this, v = this.video;
      this._destroyHls();
      this.url = url;
      this.diag = { codecs: {}, unsupported: [], lastError: '', startedAt: Date.now() };
      var st = this._vodStart;
      v.onloadedmetadata = function () { v.onloadedmetadata = null; if (st > 0 && (!v.duration || st < v.duration - 5)) v.currentTime = st; };
      v.src = url;
      v.onerror = function () { if (self.onError) self.onError(TV.t('open_vod_fail') + (v.error ? ' (' + v.error.code + ')' : '')); };
      var p = v.play(); if (p && p.catch) p.catch(function () {});
    },
    duration: function () { var d = this.video.duration; return isFinite(d) ? d : 0; },

    goLive: function () {
      if (this.mode === 'vod') return;
      this.mode = 'live';
      this.originUtc = TV.now();
      this._attach(this.ch.url, false);
    },

    _attach: function (url, fromStart) {
      var self = this, v = this.video;
      this._destroyHls();
      this.baseCT = null;
      this.pendingTarget = null;
      this.url = url;
      this.diag = { codecs: {}, unsupported: [], lastError: '', startedAt: Date.now() };
      this._changed();
      if (window.Hls && Hls.isSupported()) {
        var hls = this.hls = new Hls({
          startPosition: this.mode === 'vod' ? (this._vodStart || 0) : (fromStart ? 0 : -1),
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: Infinity,
          // слабые устройства: качество не выше размера экрана, буфер меньше (память, декодер)
          capLevelToPlayerSize: TV.lite(),
          maxBufferLength: TV.lite() ? 20 : 40,
          maxMaxBufferLength: TV.lite() ? 30 : 600,
          backBufferLength: TV.lite() ? 15 : 120,
          manifestLoadingMaxRetry: 3,
          levelLoadingMaxRetry: 4,
          fragLoadingMaxRetry: 6,
          enableWorker: true
        });
        hls.on(Hls.Events.MANIFEST_PARSED, function () {
          if (!self.userPaused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
        });
        hls.on(Hls.Events.FRAG_CHANGED, function (e, d) {
          if (self.baseCT == null) self.baseCT = d.frag.start;
        });
        // какие кодеки в потоке и поддерживает ли их устройство
        hls.on(Hls.Events.BUFFER_CODECS, function (e, d) {
          ['video', 'audio'].forEach(function (k) {
            var t = d[k]; if (!t) return;
            var codec = t.codec || t.levelCodec || '';
            var mime = (t.container || (k + '/mp4')) + (codec ? '; codecs="' + codec + '"' : '');
            var ok = true;
            try { ok = !codec || MediaSource.isTypeSupported(mime); } catch (er) { /* */ }
            self.diag.codecs[k] = { codec: codec, ok: ok };
            if (!ok) self.diag.unsupported.push(P.codecName(codec));
          });
          if (self.diag.unsupported.length && self.onCodec) self.onCodec(self.diag.unsupported);
        });
        hls.on(Hls.Events.ERROR, function (e, d) {
          self.diag.lastError = d.details + (d.response && d.response.code ? ' (' + d.response.code + ')' : '') + (d.fatal ? ' [fatal]' : '');
          // сервер отвечает пустым плейлистом (ни одного фрагмента) — после двух таких ответов подряд сообщаем
          if (d.details === 'levelEmptyError') self.diag.empty = (self.diag.empty || 0) + 1;
          if ((d.details === 'levelEmptyError' && (d.fatal || self.diag.empty >= 2) && !self.diag.emptyShown) ||
              (d.fatal && d.details === 'manifestParsingError' && /no.*(segment|fragment)/i.test(String(d.reason || '')))) {
            self.diag.emptyShown = true;
            if (self.hls === hls) hls.stopLoad();
            if (self.onError) self.onError(TV.t(self.mode === 'archive' ? 'arch_empty' : 'live_empty'), d.details, self.mode === 'archive' ? 'archive-empty' : 'empty');
            return;
          }
          if (!d.fatal) return;
          // несовместимый кодек — повторять бессмысленно
          if (/IncompatibleCodecs|bufferAddCodecError|bufferIncompatibleCodecsError/.test(d.details) ||
              (self.diag.unsupported.length && /buffer/i.test(d.details))) {
            if (self.onCodec) self.onCodec(self.diag.unsupported.length ? self.diag.unsupported : [TV.t('unknown_codec')]);
            return;
          }
          self.errors++;
          if (d.type === Hls.ErrorTypes.MEDIA_ERROR && self.errors < 4) { hls.recoverMediaError(); return; }
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR && self.errors < 4 &&
              d.details !== 'manifestLoadError' && d.details !== 'manifestParsingError') {
            setTimeout(function () { if (self.hls === hls) hls.startLoad(); }, 1500);
            return;
          }
          var msg = TV.t(self.mode === 'archive' ? 'open_arch_fail' : 'open_ch_fail');
          if (d.response && d.response.code) msg += TV.t('code', { c: d.response.code });
          if (self.onError) self.onError(msg, d.details);
        });
        hls.loadSource(url);
        hls.attachMedia(v);
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = url;
        v.addEventListener('loadedmetadata', function once() {
          v.removeEventListener('loadedmetadata', once);
          self.baseCT = fromStart ? (v.seekable.length ? v.seekable.start(0) : 0) : null;
          if (fromStart && self.baseCT) v.currentTime = self.baseCT;
          if (!self.userPaused) v.play().catch(function () {});
        });
      } else if (this.onError) {
        this.onError(TV.t('no_hls'));
      }
    },

    _destroyHls: function () {
      if (this.hls) { try { this.hls.destroy(); } catch (e) { /* */ } this.hls = null; }
    },

    stop: function () {
      clearTimeout(this.pendingTimer);
      this._destroyHls();
      var v = this.video;
      v.pause(); v.removeAttribute('src'); try { v.load(); } catch (e) { /* */ }
      this.ch = null;
    },

    // Человекочитаемое название кодека
    codecName: function (c) {
      c = String(c || '').toLowerCase();
      if (/^(hev1|hvc1)/.test(c)) return 'HEVC (H.265)';
      if (/^avc/.test(c)) return 'H.264';
      if (/^(ac-3|ac3)/.test(c)) return 'Dolby Digital (AC-3)';
      if (/^(ec-3|eac3)/.test(c)) return 'Dolby Digital Plus (E-AC-3)';
      if (/^mp4a\.40/.test(c)) return 'AAC';
      if (/^mp4a\.6b|^mp3/.test(c)) return 'MP3';
      if (/^(vp09|vp9)/.test(c)) return 'VP9';
      if (/^av01/.test(c)) return 'AV1';
      if (/^mp4v|^mpeg2/.test(c)) return 'MPEG-2';
      return c || '?';
    },

    // Сведения для панели «ℹ»
    info: function () {
      var v = this.video, q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null, h = this.hls;
      var lvl = h && h.levels && h.levels[h.currentLevel >= 0 ? h.currentLevel : 0];
      var dg = this.diag || { codecs: {} };
      function cd(k) { var c = dg.codecs[k]; return c ? P.codecName(c.codec) + ' (' + c.codec + ')' + (c.ok ? '' : ' ✗') : '—'; }
      return {
        mode: this.mode, url: this.url,
        size: v.videoWidth ? v.videoWidth + '×' + v.videoHeight : '—',
        video: cd('video'), audio: cd('audio'),
        frames: q ? q.totalVideoFrames + ' / ' + q.droppedVideoFrames : '—',
        bitrate: lvl && lvl.bitrate ? Math.round(lvl.bitrate / 1000) + ' kbit/s' : '—',
        buffer: (function () { var b = v.buffered; for (var i = 0; i < b.length; i++) if (v.currentTime >= b.start(i) - .5 && v.currentTime <= b.end(i)) return (b.end(i) - v.currentTime).toFixed(1) + ' s'; return '0 s'; })(),
        state: 'readyState ' + v.readyState + (v.paused ? ', paused' : '') + (v.seeking ? ', seeking' : ''),
        error: dg.lastError || '—'
      };
    },

    // Видео есть, а звуковой дорожки нет (часто это AC-3/E-AC-3, которые встроенный плеер не воспроизводит)
    noAudio: function () {
      var v = this.video;
      if (!this.diag || Date.now() - this.diag.startedAt < 8000) return false;
      return v.readyState >= 3 && v.videoWidth > 0 && !!this.diag.codecs.video && !this.diag.codecs.audio;
    },

    // Есть звук/время идёт, а кадров нет — видео не декодируется
    noVideo: function () {
      var v = this.video;
      if (!this.diag || this.userPaused || Date.now() - this.diag.startedAt < 8000) return false;
      var q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      return v.readyState >= 2 && !v.videoWidth && (!q || q.totalVideoFrames === 0) && !!this.diag.codecs.video;
    },

    // Текущий момент воспроизведения в «эфирном» времени (сек UTC)
    position: function () {
      var v = this.video, now = TV.now();
      if (this.mode === 'vod') return v.currentTime || 0;
      var est;
      if (this.mode === 'live') {
        var lat = this.hls && isFinite(this.hls.latency) ? this.hls.latency : 0;
        if (!lat && v.seekable.length) lat = Math.max(0, v.seekable.end(v.seekable.length - 1) - v.currentTime);
        est = now - lat;
        if (this.userPaused && this.pausedAt) est = this.pausedPos;
      } else {
        est = this.baseCT == null ? this.originUtc : this.originUtc + (v.currentTime - this.baseCT);
      }
      var pd = this.hls && this.hls.playingDate;
      if (pd) {
        var t = pd.getTime() / 1000;
        if (Math.abs(t - est) < 3 * 3600) est = t; // доверяем PROGRAM-DATE-TIME, если он правдоподобен
      }
      return Math.min(est, now);
    },

    // Цель перемотки, если пользователь сейчас «крутит» (для отображения)
    displayPosition: function () { return this.pendingTarget != null ? this.pendingTarget : this.position(); },

    isPaused: function () { return this.userPaused; },
    isBuffering: function () { var v = this.video; return !this.userPaused && (v.readyState < 3 || v.seeking); },

    // Относительная перемотка с накоплением нажатий
    skip: function (delta) {
      var self = this;
      if (!this.canSeek()) return;
      var base = this.pendingTarget != null ? this.pendingTarget : this.position();
      this.pendingTarget = this._clamp(base + delta);
      this._changed();
      clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(function () {
        var t = self.pendingTarget; self.pendingTarget = null;
        if (t != null) self.seek(t);
      }, 700);
    },

    _clamp: function (t) {
      if (this.mode === 'vod') return Math.max(0, Math.min(this.duration() || t, t));
      var now = TV.now();
      var lo = this.canArchive() ? TV.Catchup.earliest(this.ch) : this._seekableStartUtc();
      return Math.max(lo, Math.min(now, t));
    },

    _seekableStartUtc: function () {
      var v = this.video;
      if (!v.seekable.length) return this.position();
      return this.position() - (v.currentTime - v.seekable.start(0));
    },

    // Абсолютная перемотка к моменту t (сек UTC)
    seek: function (t) {
      var v = this.video, now = TV.now();
      t = this._clamp(t);
      if (this.mode === 'vod') { clearTimeout(this.pendingTimer); this.pendingTarget = null; v.currentTime = t; this._changed(); return; }
      clearTimeout(this.pendingTimer); this.pendingTarget = null;
      var ct = v.currentTime + (t - this.position());
      var inWindow = false;
      for (var i = 0; i < v.seekable.length; i++) {
        if (ct >= v.seekable.start(i) + 1 && ct <= v.seekable.end(i) - 1) inWindow = true;
      }
      if (t > now - 15) {
        if (this.mode === 'live' && inWindow) v.currentTime = ct; else this.goLive();
      } else if (inWindow) {
        v.currentTime = ct;
      } else if (this.canArchive()) {
        this.load(t);
      } else if (v.seekable.length) {
        v.currentTime = Math.max(v.seekable.start(0), Math.min(v.seekable.end(v.seekable.length - 1), ct));
      }
      if (this.userPaused) { this.pausedPos = t; }
      this._changed();
    },

    pause: function () {
      if (this.userPaused) return;
      this.pausedPos = this.position();
      this.pausedAt = TV.now();
      this.userPaused = true;
      this.video.pause();
      this._changed();
    },

    play: function () {
      if (!this.userPaused) return;
      this.userPaused = false;
      var long = TV.now() - this.pausedAt > 45;
      if (long && this.canArchive() && this.mode !== 'vod') {
        this.load(this.pausedPos); // окно потока могло уйти вперёд — продолжаем ровно с места паузы
      } else {
        var p = this.video.play(); if (p && p.catch) p.catch(function () {});
      }
      this.pausedAt = 0;
      this._changed();
    },

    toggle: function () { if (this.userPaused) this.play(); else this.pause(); },

    // ---------- громкость ----------
    volume: function () { return this.video.muted ? 0 : Math.round(this.video.volume * 100); },
    setVolume: function (pct) {
      pct = Math.max(0, Math.min(100, Math.round(pct)));
      this.video.volume = pct / 100;
      this.video.muted = pct === 0;
      TV.store.set('volume', pct / 100); TV.store.set('muted', this.video.muted);
      this._changed();
      return pct;
    },
    changeVolume: function (delta) {
      var v = this.video;
      var base = v.muted ? 0 : Math.round(v.volume * 100);
      return this.setVolume(base + delta);
    },
    toggleMute: function () {
      var v = this.video;
      if (v.muted || v.volume === 0) { if (v.volume === 0) v.volume = 0.5; v.muted = false; }
      else v.muted = true;
      TV.store.set('volume', v.volume); TV.store.set('muted', v.muted);
      this._changed();
    }
  };
})(window.TV);
