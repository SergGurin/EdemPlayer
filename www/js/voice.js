(function (TV) {
  'use strict';

  /*
   * Голосовой ввод.
   *  1) native.speech — системное распознавание (Android-сборка);
   *  2) Web Speech API — в обычных браузерах (в Electron не работает, там пропускаем);
   *  3) Vosk (WebAssembly) со встроенной русской моделью — полностью офлайн.
   */
  var MODEL = 'models/vosk-model-small-ru-0.4.tar.gz';
  var isElectron = !!(window.native && window.native.platform === 'electron');

  var V = TV.Voice = {
    model: null, modelLoading: null, session: null,

    available: function () {
      return !!((window.native && window.native.speech) ||
        (!isElectron && (window.SpeechRecognition || window.webkitSpeechRecognition)) ||
        (window.Vosk && navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
    },

    listening: function () { return !!V.session; },

    // cb: { onState(text), onPartial(text), onResult(text), onEnd() }
    listen: function (cb) {
      V.stop();
      if (window.native && window.native.speech) return V._native(cb);
      if (!isElectron && (window.SpeechRecognition || window.webkitSpeechRecognition)) return V._web(cb);
      return V._vosk(cb);
    },

    stop: function () {
      var s = V.session; V.session = null;
      if (s && s.stop) try { s.stop(); } catch (e) { /* */ }
    },

    _native: function (cb) {
      var s = V.session = { stop: function () { if (window.native.speechStop) window.native.speechStop(); } };
      cb.onState(TV.t('speak'));
      window.native.speech('ru-RU').then(function (text) {
        if (V.session !== s) return; V.session = null;
        cb.onResult(text || ''); cb.onEnd();
      }).catch(function (e) { V.session = null; cb.onState(TV.t('voice_err', { e: (e && e.message || e) })); cb.onEnd(); });
    },

    _web: function (cb) {
      var R = window.SpeechRecognition || window.webkitSpeechRecognition;
      var r = new R(); r.lang = 'ru-RU'; r.interimResults = true; r.maxAlternatives = 1;
      var s = V.session = { stop: function () { try { r.abort(); } catch (e) { /* */ } } };
      var finalText = '';
      r.onresult = function (ev) {
        var t = '', fin = false;
        for (var i = ev.resultIndex; i < ev.results.length; i++) { t += ev.results[i][0].transcript; if (ev.results[i].isFinal) fin = true; }
        if (fin) finalText = t; else cb.onPartial(t);
      };
      r.onerror = function (ev) {
        if (V.session !== s) return;
        V.session = null;
        // браузер не умеет — переключаемся на офлайн-распознавание
        if (ev.error === 'network' || ev.error === 'service-not-allowed' || ev.error === 'language-not-supported') { V._vosk(cb); return; }
        cb.onState(ev.error === 'no-speech' ? TV.t('not_heard_short') : TV.t('err', { e: ev.error })); cb.onEnd();
      };
      r.onend = function () { if (V.session !== s) return; V.session = null; cb.onResult(finalText); cb.onEnd(); };
      cb.onState(TV.t('speak'));
      // браузер может молча не отвечать — через 12 с переходим на офлайн-распознавание
      var guard = setTimeout(function () {
        if (V.session !== s || finalText) return;
        V.session = null; try { r.abort(); } catch (e) { /* */ }
        V._vosk(cb);
      }, 12000);
      r.onaudiostart = r.onresult ? r.onaudiostart : null;
      var origEnd = r.onend; r.onend = function () { clearTimeout(guard); origEnd(); };
      try { r.start(); } catch (e) { clearTimeout(guard); V.session = null; V._vosk(cb); }
    },

    _loadModel: function (cb) {
      if (V.model) return Promise.resolve(V.model);
      if (!V.modelLoading) {
        cb.onState(TV.t('voice_prep'));
        var url = new URL(MODEL, location.href).href;
        V.modelLoading = Vosk.createModel(url).then(function (m) { m.setLogLevel(-2); V.model = m; return m; })
          .catch(function (e) { V.modelLoading = null; throw e; });
      }
      return V.modelLoading;
    },

    _vosk: function (cb) {
      if (!window.Vosk) { cb.onState(TV.t('voice_na')); cb.onEnd(); return; }
      var s = V.session = { stop: null };
      var stream, ctx, node, src, rec, timer, silenceTimer, lastText = '', finished = false;
      function cleanup() {
        clearTimeout(timer); clearTimeout(silenceTimer);
        try { if (node) node.disconnect(); if (src) src.disconnect(); } catch (e) { /* */ }
        try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* */ }
        try { if (ctx) ctx.close(); } catch (e) { /* */ }
        try { if (rec) rec.remove(); } catch (e) { /* */ }
      }
      function finish(text) {
        if (finished) return; finished = true;
        if (V.session === s) V.session = null;
        cleanup();
        cb.onResult((text || lastText || '').trim());
        cb.onEnd();
      }
      s.stop = function () { if (!finished) { finished = true; cleanup(); cb.onEnd(); } };

      Promise.all([
        V._loadModel(cb),
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false })
      ]).then(function (r) {
        if (finished) { r[1].getTracks().forEach(function (t) { t.stop(); }); return; }
        var model = r[0]; stream = r[1];
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        rec = new model.KaldiRecognizer(ctx.sampleRate);
        rec.on('partialresult', function (m) {
          var t = m.result && m.result.partial || '';
          if (t && t !== lastText) {
            lastText = t; cb.onPartial(t);
            // пауза в речи 1.2 с — считаем фразу законченной
            clearTimeout(silenceTimer);
            silenceTimer = setTimeout(function () { try { rec.retrieveFinalResult(); } catch (e) { /* */ } setTimeout(function () { finish(lastText); }, 900); }, 1200);
          }
        });
        rec.on('result', function (m) {
          var t = m.result && m.result.text || '';
          if (t) finish(t);
        });
        src = ctx.createMediaStreamSource(stream);
        node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = function (ev) { if (!finished) try { rec.acceptWaveform(ev.inputBuffer); } catch (e) { /* */ } };
        src.connect(node); node.connect(ctx.destination);
        cb.onState(TV.t('speak'));
        timer = setTimeout(function () { finish(lastText); }, 9000);
      }).catch(function (e) {
        var msg = String(e && (e.name || e.message) || e);
        if (/NotAllowed|Permission/i.test(msg)) msg = TV.t('no_mic_access');
        else if (/NotFound|DevicesNotFound/i.test(msg)) msg = TV.t('no_mic');
        if (V.session === s) V.session = null;
        finished = true; cleanup();
        cb.onState(TV.t('voice_prefix', { e: msg })); cb.onEnd();
      });
    }
  };
})(window.TV);
