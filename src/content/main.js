/**
 * Orchestrator: watches YouTube navigation, runs the caption ▸ translate ▸
 * speak pipeline, and owns the panel.
 */
(() => {
  'use strict';

  const YD = (globalThis.YD = globalThis.YD || {});
  if (YD.main) return;
  YD.main = true;

  const { waitFor, log, warn } = YD.util;

  const state = {
    settings: null,
    videoId: null,
    video: null,
    engine: null,
    scheduler: null,
    cues: null,
    cuesVideoId: null,
    condensedFor: null,
    panel: null,
    busy: false,
    sessionRate: 1,
    translatedBy: '',
    translationModel: '',
    translationFellBack: false,
    translationError: '',
  };

  const videoIdFromUrl = () => {
    try {
      const url = new URL(location.href);
      if (url.pathname === '/watch') return url.searchParams.get('v') || null;
      const short = url.pathname.match(/^\/(?:shorts|embed)\/([\w-]{6,})/);
      return short ? short[1] : null;
    } catch (_) {
      return null;
    }
  };

  const findVideo = () => document.querySelector('#movie_player video');
  const findPlayer = () => document.getElementById('movie_player');

  /* ------------------------------------------------------------------ *
   * Panel wiring
   * ------------------------------------------------------------------ */

  const ensurePanel = () => {
    if (!state.settings || !state.settings.showPanel) {
      if (state.panel) state.panel.remove();
      return;
    }
    const player = findPlayer();
    if (!player) return;

    if (!state.panel) {
      state.panel = YD.panel.create({
        onToggle: () => toggle(),
        onOpenOptions: () => YD.bridge.send('openOptions').catch(() => {}),
        onRateChange: (value) => {
          state.sessionRate = value;
          if (state.scheduler && state.scheduler.running) restartScheduler();
        },
      });
      state.panel.setRate(state.sessionRate);
    }
    state.panel.mount(player);
  };

  const setIdlePanel = () => {
    if (!state.panel) return;
    state.panel.setState('');
    state.panel.setButton('شروع');
    state.panel.setStatus('آماده');
    state.panel.setProgress(0);
    state.panel.setCue('');
    state.panel.setEasing(1);
  };

  /* ------------------------------------------------------------------ *
   * Pipeline
   * ------------------------------------------------------------------ */

  const effectiveSettings = () => ({
    ...state.settings,
    baseRate: state.settings.baseRate * state.sessionRate,
    maxRate: state.settings.maxRate * state.sessionRate,
    minRate: state.settings.minRate * state.sessionRate,
  });

  const buildCues = async () => {
    const settings = state.settings;
    const panel = state.panel;

    const built = await YD.captions.build({
      settings,
      onProgress: ({ message }) => panel && panel.setStatus(message || ''),
    });

    let cues = built.cues;

    const alreadyPersian =
      built.translated ||
      String(built.lang || '').toLowerCase().startsWith(settings.targetLang);

    if (!alreadyPersian) {
      // Gemini is strict by default: substituting another provider makes it
      // look as if Gemini worked when it did not. Fallback remains an explicit
      // option for users who value uninterrupted playback over diagnostics.
      const chain = [];
      const first = settings.translator === 'youtube' ? 'google' : settings.translator;
      chain.push(first);
      const allowFallback = first !== 'gemini' || settings.geminiFallback;
      if (first === 'gemini' && allowFallback) chain.push('google');
      if (allowFallback) chain.push('youtube');

      let translated = null;
      let lastError = null;
      let usedProvider = null;

      for (const provider of chain) {
        if (provider === 'youtube') {
          warn('falling back to YouTube auto-translation', lastError);
          panel && panel.setStatus('ترجمه جایگزین از یوتیوب…');
          const viaYouTube = await YD.captions.build({
            settings: { ...settings, translator: 'youtube' },
            onProgress: () => {},
          });
          if (!viaYouTube.translated) continue;
          translated = viaYouTube.cues;
          usedProvider = 'youtube';
          break;
        }

        log('translating via', provider);
        try {
          translated = await YD.translate.cues({
            cues,
            videoId: built.videoId,
            settings: { ...settings, translator: provider },
            onProgress: ({ done, total }) => {
              if (!panel) return;
              panel.setStatus(`ترجمه ${done} از ${total} جمله…`);
              panel.setProgress(total ? done / total : 0);
            },
          });
          usedProvider = provider;
          const meta = YD.translate.lastMeta || {};
          state.translationModel = provider === 'gemini' ? meta.model || '' : '';
          break;
        } catch (err) {
          lastError = err;
          // A missing or rejected key is the user's own to fix, and quietly
          // working around it would hide that from them.
          if (/کلید API/.test(err.message || '')) throw err;
          // Everything else is an outage of some kind. Earlier this only fell
          // through for "partial" failures, so a hard error from the first
          // provider aborted the run instead of trying the next one -- no dub
          // at all, when a slightly worse dub was available.
          warn(`${provider} translation failed, trying the next provider:`, err);
        }
      }

      if (!translated) throw lastError || new Error('هیچ موتور ترجمه‌ای جواب نداد');
      cues = translated;

      // Falling back quietly is how "I turned on the good translator and
      // nothing changed" happens: the result looks identical because it was
      // produced by the same engine as before. Say which one actually ran.
      state.translatedBy = usedProvider;
      state.translationFellBack = usedProvider !== first;
      state.translationError = state.translationFellBack
        ? (lastError && lastError.message) || 'دلیل نامشخص'
        : '';
      if (state.translationFellBack) {
        warn(`requested ${first} but used ${usedProvider}:`, lastError);
      }
    } else {
      state.translatedBy = built.translated ? 'youtube' : 'original';
      state.translationModel = '';
      panel && panel.setProgress(1);
    }

    // Clean the text before anything measures or speaks it. Doing this here
    // rather than at speak time matters: the planner times each sentence from
    // what will actually be said, and cues that turn out to be nothing but a
    // production marker disappear instead of becoming an awkward silence.
    // Last line of defence. Every translation path degrades to "keep the
    // source text" when it fails, and several of them can fail partially, so
    // untranslated lines can reach this point through more than one route.
    // Reading English aloud, in a Persian voice, over the English original is
    // worse than staying quiet -- so nothing that is not in the target script
    // gets spoken, whatever produced it.
    const untranslated = cues.filter(
      (cue) => !YD.util.isInLanguage(cue.spoken || cue.text, settings.targetLang)
    ).length;

    if (untranslated) {
      const share = untranslated / cues.length;
      warn(`${untranslated}/${cues.length} cues are not in ${settings.targetLang}`);
      if (share > 0.4) {
        throw new Error(
          `ترجمه انجام نشد — ${untranslated} از ${cues.length} جمله هنوز انگلیسی است` +
            (state.translationError ? ` (${state.translationError})` : '')
        );
      }
    }

    const speakable = [];
    let removed = 0;
    for (const cue of cues) {
      // `spoken` is the pronunciation-ready form when the provider gave one:
      // ezafe marked, joiners fixed, ambiguous words vocalised. It is what
      // gets said; `display` is the plain translation, which is what a reader
      // wants to see.
      const source = cue.spoken || cue.text;
      // A stray untranslated line is dropped rather than read out in the
      // wrong language; a short silence is far less jarring.
      if (!YD.util.isInLanguage(source, settings.targetLang)) {
        removed++;
        continue;
      }
      const text = YD.speechtext.forSpeech(source, { lang: settings.targetLang });
      if (!text) {
        removed++;
        continue;
      }
      speakable.push({ ...cue, text, display: cue.text });
    }
    if (removed) log(`dropped ${removed} cue(s) with nothing to say`);
    if (!speakable.length) throw new Error('بعد از پاک‌سازی، متنی برای خواندن نماند');

    return { cues: speakable, meta: built };
  };

  /**
   * Bring up a speech engine, falling back to the other one if the preferred
   * engine cannot run here.
   *
   * Neither engine is guaranteed: Windows does not ship a Persian voice on
   * every build, so `webspeech` is simply unavailable for many users, and
   * `piper` needs the local server to be running. Trying both means a working
   * setup is found without the user having to diagnose which half is missing.
   */
  const prepareEngine = async (settings, probeText = '') => {
    const preferred = YD.tts.forSettings(settings);
    // Do not unexpectedly spend Gemini quota when another engine was chosen.
    // Gemini may fall back to both free engines, but the reverse never happens.
    const candidates =
      preferred === YD.tts.gemini
        ? [YD.tts.gemini, YD.tts.piper, YD.tts.webSpeech]
        : preferred === YD.tts.piper
          ? [YD.tts.piper, YD.tts.webSpeech]
          : [YD.tts.webSpeech, YD.tts.piper];
    const errors = [];

    for (const engine of candidates) {
      try {
        const info = await engine.ready(settings);
        // Listing the model proves the key can see it, not that audio quota is
        // available. Render the first upcoming line before playback resumes so
        // a quota/model error can still fall back cleanly instead of creating
        // a silent first sentence several seconds into the video.
        if (engine === YD.tts.gemini && probeText && typeof engine.warmup === 'function') {
          await engine.warmup(probeText, { rate: settings.baseRate });
        }
        if (engine !== preferred) log(`fell back to ${engine.id}`);
        return {
          engine,
          info: {
            ...info,
            fallback: engine !== preferred,
            fallbackReason: engine !== preferred ? errors.join(' — ') : '',
          },
        };
      } catch (error) {
        errors.push(`${engine.id}: ${error.message}`);
        warn(`${engine.id} unavailable`, error);
      }
    }

    throw new Error(errors.join(' — '));
  };

  /**
   * Second pass: rewrite the lines that still do not fit.
   *
   * The translation pass sized every line against an assumed speaking rate.
   * Now the chosen voice has actually rendered the opening of the video, so
   * the real rate is known -- and the lines that overrun are known one by one.
   *
   * The order matters, and it is the order a dubbing studio works in. Speeding
   * a line up is what a listener hears as "rushed", and easing the picture is
   * what they see as a stutter; rewriting the line so it simply fits costs the
   * viewer nothing at all. So compression is tried first, and the technical
   * fixes are left to handle only what wording could not.
   *
   * Failure here is never fatal: the original lines are already correct, just
   * long, and everything downstream still handles them exactly as before.
   */
  const condenseOverruns = async (cues, engine, settings) => {
    if (!settings.condensePass) return cues;
    if (settings.translator !== 'gemini' || !settings.geminiApiKey) return cues;
    if (typeof engine.prepare !== 'function' || !engine.exact) return cues;

    // Measure a sample rather than the whole video: the point is only to learn
    // this voice's speaking rate, and a dozen sentences settle that to well
    // within the precision the planner needs.
    //
    // These renders are not wasted work. They are the opening sentences, they
    // are cached, and playback reaches them within seconds -- so for an engine
    // that bills per request this costs little beyond bringing that work
    // forward. Lines the pass then rewrites do have to be rendered again,
    // which is why the threshold below only selects lines that genuinely
    // overrun rather than every line that is slightly long.
    const SAMPLE = 12;
    const sample = cues.slice(0, SAMPLE);
    const measured = await Promise.all(
      sample.map((cue, i) =>
        engine.prepare(cue.text, { rate: settings.baseRate, cueIndex: i }).catch(() => null)
      )
    );

    let chars = 0;
    let seconds = 0;
    measured.forEach((duration, i) => {
      if (!duration || duration <= 0.2) return;
      chars += YD.util.spokenLength(sample[i].text);
      seconds += duration * settings.baseRate; // back out to rate 1
    });
    if (!seconds || chars < 100) return cues;

    const cps = chars / seconds;
    log(`measured ${cps.toFixed(1)} chars/sec for ${engine.id}`);

    // Every line's real budget is the time until the next one starts.
    const items = [];
    cues.forEach((cue, i) => {
      const next = cues[i + 1];
      const window = (next ? Number(next.start) : Number(cue.end) + 2) - Number(cue.start);
      const budget = Math.max(0.4, window);
      const needs = YD.util.spokenLength(cue.text) / cps;
      // Only lines that the rate ceiling alone cannot rescue are worth a
      // rewrite; anything a few percent over is absorbed comfortably.
      if (needs > budget * settings.maxRate * 0.98) {
        items.push({
          id: i,
          text: cue.spoken || cue.text,
          seconds: budget,
          currently: needs,
        });
      }
    });

    if (!items.length) {
      log('no lines need condensing');
      return cues;
    }
    log(`condensing ${items.length}/${cues.length} overrunning lines`);

    const out = cues.slice();
    const BATCH = 40;
    for (let start = 0; start < items.length; start += BATCH) {
      let response;
      try {
        response = await YD.bridge.send('condense', {
          items: items.slice(start, start + BATCH),
          to: settings.targetLang,
          geminiApiKey: settings.geminiApiKey,
          geminiModel: settings.geminiModel,
        });
      } catch (err) {
        warn('condense pass failed; keeping the original lines', err);
        break;
      }

      for (const line of (response && response.lines) || []) {
        const cue = out[line.id];
        if (!cue) continue;
        const spoken = YD.speechtext.forSpeech(line.spoken || line.text, {
          lang: settings.targetLang,
        });
        // A rewrite that came back longer, empty, or in the wrong language is
        // not an improvement -- keep what we had.
        if (!spoken) continue;
        if (!YD.util.isInLanguage(spoken, settings.targetLang)) continue;
        if (YD.util.spokenLength(spoken) >= YD.util.spokenLength(cue.text)) continue;
        out[line.id] = { ...cue, text: spoken, display: line.text || cue.display };
      }
    }

    return out;
  };

  const onSchedulerEvent = (event) => {
    const panel = state.panel;
    if (!panel) return;
    switch (event.type) {
      case 'cue':
        // Show the caption as written; the spoken form has numbers spelled
        // out and would read oddly on screen.
        panel.setCue(event.cue.display || event.cue.text);
        break;
      case 'easing':
        panel.setEasing(event.factor);
        break;
      case 'stopped':
        panel.setCue('');
        panel.setEasing(1);
        break;
    }
  };

  const restartScheduler = () => {
    if (!state.scheduler) return;
    const wasRunning = state.scheduler.running;
    state.scheduler.stop();
    state.scheduler = YD.scheduler.create({
      video: state.video,
      cues: state.cues,
      engine: state.engine,
      settings: effectiveSettings(),
      onEvent: onSchedulerEvent,
    });
    if (wasRunning) state.scheduler.start();
  };

  const start = async () => {
    if (state.busy) return;
    state.busy = true;
    const panel = state.panel;

    try {
      state.settings = await YD.settings.get();
      YD.debug = state.settings.debug;

      panel && panel.open();
      panel && panel.setState('busy');
      panel && panel.setButton('آماده‌سازی…', { disabled: true });
      panel && panel.setStatus('اتصال به پلیر…');

      const player = await YD.bridge.waitForPlayer();
      if (!player) throw new Error('پلیر یوتیوب پیدا نشد');

      state.video = await waitFor(findVideo, { timeout: 15000 });
      if (!state.video) throw new Error('عنصر ویدیو پیدا نشد');

      const videoId = player.videoId || videoIdFromUrl();

      if (!state.cues || state.cuesVideoId !== videoId) {
        const { cues } = await buildCues();
        state.cues = cues;
        state.cuesVideoId = videoId;
        state.condensedFor = null;
      }

      panel && panel.setStatus('آماده‌سازی موتور گفتار…');
      const now = state.video.currentTime || 0;
      const probe = state.cues.find((cue) => cue.start >= now - 0.25) || state.cues[0];
      const pauseForGemini =
        state.settings.ttsEngine === 'gemini' && !state.video.paused && !state.video.ended;
      if (pauseForGemini) state.video.pause();
      let prepared;
      try {
        prepared = await prepareEngine(state.settings, probe && probe.text);
      } finally {
        if (pauseForGemini) state.video.play().catch(() => {});
      }
      const { engine, info } = prepared;
      state.engine = engine;

      // Rewrite what does not fit before falling back to speeding it up.
      if (state.condensedFor !== videoId) {
        panel && panel.setStatus('تنظیم طول جمله‌ها…');
        try {
          state.cues = await condenseOverruns(state.cues, engine, effectiveSettings());
          state.condensedFor = videoId;
        } catch (err) {
          warn('condense pass skipped', err);
        }
      }

      state.scheduler = YD.scheduler.create({
        video: state.video,
        cues: state.cues,
        engine: state.engine,
        settings: effectiveSettings(),
        onEvent: onSchedulerEvent,
      });
      state.scheduler.start();

      const stats = state.scheduler.stats;
      const PROVIDER_NAMES = {
        gemini: 'Gemini',
        google: 'Google',
        youtube: 'یوتیوب',
        libre: 'Libre',
        local: 'محلی',
        original: 'زبان اصلی',
      };
      const providerName = PROVIDER_NAMES[state.translatedBy] || state.translatedBy || '';
      const via = state.translationModel
        ? `${providerName} (${state.translationModel})`
        : providerName;

      panel && panel.setState('on');
      panel && panel.setButton('توقف', { stop: true });
      panel &&
        panel.setStatus(
          `${stats.total} جمله · ترجمه: ${via}` +
            (state.translationFellBack ? ' ⚠' : '') +
            ` · ${info.name}` +
            (info.fallback ? ' · صدای جایگزین ⚠' : '') +
            (stats.stretched ? ` · ${stats.stretched} فشرده` : '')
        );
      if (state.translationFellBack && panel) {
        // The reason lives in the service worker's own console, which is a
        // different console from this page's -- so carry it here instead of
        // sending the user looking for it.
        panel.setStatus(
          `⚠ ${PROVIDER_NAMES[state.settings.translator] || state.settings.translator} ` +
            `جواب نداد (${state.translationError})، از ${via} استفاده شد`,
          true
        );
      } else if (info.fallback && panel) {
        panel.setStatus(
          `⚠ موتور صدای انتخابی آماده نشد (${info.fallbackReason})؛ از ${info.name} استفاده شد`,
          true
        );
      }
      panel && panel.setProgress(1);
    } catch (err) {
      warn('start failed', err);
      if (panel) {
        panel.setState('err');
        panel.setButton('تلاش دوباره');
        panel.setStatus(String((err && err.message) || err), true);
        panel.setProgress(0);
      }
      stop({ keepMessage: true });
    } finally {
      state.busy = false;
    }
  };

  const stop = ({ keepMessage = false } = {}) => {
    // Priming the caption track is how the translated subtitles get captured,
    // so a run can end with YouTube still displaying them -- a different
    // translation from the one that was spoken, which reads like a bug.
    YD.bridge.call('restoreCaptions').catch(() => {});
    if (state.scheduler) {
      state.scheduler.stop();
      state.scheduler = null;
    }
    if (state.engine) state.engine.cancelAll();
    if (state.panel && !keepMessage) setIdlePanel();
    else if (state.panel) {
      state.panel.setButton('تلاش دوباره');
      state.panel.setCue('');
      state.panel.setHold(false);
    }
  };

  const toggle = () => {
    if (state.scheduler && state.scheduler.running) stop();
    else start();
  };

  /* ------------------------------------------------------------------ *
   * Navigation
   * ------------------------------------------------------------------ */

  const onNavigate = async () => {
    const videoId = videoIdFromUrl();
    if (videoId === state.videoId) {
      ensurePanel();
      return;
    }

    stop();
    state.videoId = videoId;
    state.cues = null;
    state.cuesVideoId = null;
    state.condensedFor = null;
    state.video = null;

    if (!videoId) {
      if (state.panel) state.panel.remove();
      return;
    }

    await waitFor(findPlayer, { timeout: 20000 });
    ensurePanel();
    setIdlePanel();

    if (state.settings && state.settings.autoStart) {
      // Give the player a moment to settle before touching its volume.
      setTimeout(() => {
        if (state.videoId === videoId) start();
      }, 1200);
    }
  };

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  const boot = async () => {
    state.settings = await YD.settings.get();
    YD.debug = state.settings.debug;

    YD.settings.onChange((next) => {
      const previous = state.settings;
      state.settings = next;
      YD.debug = next.debug;
      ensurePanel();
      // Changes that alter the audio pipeline need a rebuild.
      const translationKeys = [
        'translator',
        'targetLang',
        'sourceLang',
        'geminiApiKey',
        'geminiModel',
        'adaptToDuration',
        'geminiFallback',
        'libreEndpoint',
        'libreApiKey',
        'localEndpoint',
      ];
      const voiceKeys = [
        'ttsEngine',
        'voiceURI',
        'piperVoice',
        'localEndpoint',
        'geminiApiKey',
        'geminiTtsModel',
        'geminiVoice',
        'geminiTtsStyle',
      ];
      const translationChanged =
        previous && translationKeys.some((key) => previous[key] !== next[key]);
      const voiceChanged = previous && voiceKeys.some((key) => previous[key] !== next[key]);
      if (translationChanged) {
        state.cues = null;
        state.cuesVideoId = null;
        state.condensedFor = null;
      }
      if ((translationChanged || voiceChanged) && state.scheduler && state.scheduler.running) {
        stop();
        start();
      } else if (state.scheduler && state.scheduler.running) {
        restartScheduler();
      }
    });

    document.addEventListener('yt-navigate-finish', onNavigate);
    // The custom event does not fire on a cold load or on some transitions.
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        onNavigate();
      } else if (state.videoId && state.settings && state.settings.showPanel) {
        // YouTube rebuilds the player on theatre/fullscreen changes.
        const player = findPlayer();
        if (player && state.panel && state.panel.host.parentElement !== player) {
          state.panel.mount(player);
        }
      }
    }, 1000);

    document.addEventListener(
      'keydown',
      (e) => {
        if (!state.settings || !state.settings.hotkey) return;
        if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.code !== 'KeyD') return;
        const el = document.activeElement;
        const tag = el && el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return;
        if (!videoIdFromUrl()) return;
        e.preventDefault();
        e.stopPropagation();
        toggle();
      },
      true
    );

    chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
      if (!msg || msg.type !== 'command') return;
      if (msg.payload === 'toggle') toggle();
      respond({ ok: true, data: { running: !!(state.scheduler && state.scheduler.running) } });
      return true;
    });

    onNavigate();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
