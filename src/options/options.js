/* Options page controller. Reuses the shared settings store from content/. */
(() => {
  'use strict';

  const { DEFAULTS, get, set } = globalThis.YD.settings;

  const $ = (id) => document.getElementById(id);

  /**
   * Call the service worker, turning its three failure modes into three
   * different messages.
   *
   * `sendMessage` resolving with `undefined` is the interesting one: it means
   * the message arrived but no handler matched, which in practice means the
   * worker is running older code than this page. Reporting that as a generic
   * failure sends people looking for a network problem that does not exist.
   */
  const callWorker = async (type, payload) => {
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type, payload });
    } catch (err) {
      throw new Error(
        `ارتباط با افزونه برقرار نشد (${err.message}). در chrome://extensions یک بار Reload بزنید.`
      );
    }

    if (res === undefined) {
      throw new Error(
        `این نسخه از افزونه «${type}» را نمی‌شناسد. ` +
          'در chrome://extensions روی این افزونه Reload بزنید و دوباره امتحان کنید.'
      );
    }
    if (!res.ok) throw new Error(res.error || 'خطای ناشناخته');
    return res.data;
  };

  const BOOLEANS = [
    'autoStart',
    'showPanel',
    'hotkey',
    'preferManualCaptions',
    'cacheEnabled',
    'adaptToDuration',
    'geminiFallback',
    'condensePass',
    'multiSpeaker',
    'debug',
  ];
  const TEXTS = ['libreEndpoint', 'libreApiKey', 'localEndpoint', 'geminiApiKey'];
  const SELECTS = [
    'translator',
    'ttsEngine',
    'voiceURI',
    'piperVoice',
    'overrunPolicy',
    'geminiModel',
    'geminiTtsModel',
    'geminiVoice',
    'geminiTtsStyle',
  ];
  const NUMBERS = [
    'baseRate',
    'maxRate',
    'charsPerSecond',
    'duckVolume',
    'maxLead',
    'maxLag',
    'minPlaybackRate',
    'pauseMaxSeconds',
    'groupSentences',
    'duckAttackMs',
    'duckReleaseMs',
    'duckHoldSeconds',
  ];

  const POLICY_HINTS = {
    stretch:
      'وقتی جمله‌ای حتی با تندخوانی جا نشود، تصویر برای همان چند ثانیه چند درصد آرام‌تر می‌شود. پیوسته است و توقف ندارد، و ارتفاع صدا هم حفظ می‌شود.',
    compress:
      'هیچ دستکاری‌ای روی تصویر انجام نمی‌شود. جمله‌های سنگین کمی دیر تمام می‌شوند و اولین سکوت بعدی عقب‌افتادگی را جبران می‌کند.',
    pause:
      'دقیق‌ترین همگامی، ولی توقف‌های کوتاه تصویر معمولاً بیشتر از خودِ ناهمگامی آزاردهنده است.',
  };

  const TRANSLATOR_HINTS = {
    gemini:
      'کلید را از aistudio.google.com/apikey بگیرید. ترجمه به‌صورت دسته‌ای انجام می‌شود (یک ویدیوی ۳۰۰ جمله‌ای حدود ۱۲ درخواست ترجمه دارد). کلید در storage محلی همین افزونه نگه‌داری و فقط در هدر درخواست API گوگل فرستاده می‌شود؛ برای کاهش ریسک، کلید را در AI Studio فقط به Gemini API محدود کنید. حالت Gemini پیش‌فرض سخت‌گیرانه است: اگر API جواب ندهد خطا می‌بینید، نه ترجمهٔ پنهانی از موتور دیگر.',
    youtube:
      'زیرنویس فارسی را مستقیم از خود یوتیوب می‌گیرد؛ رسمی و بدون محدودیت. ولی یوتیوب هر خط زیرنویس را جدا و بدون بافت ترجمه می‌کند، پس فارسی‌اش تکه‌تکه‌تر است.',
    google:
      'اول تکه‌های زیرنویس به جمله‌های کامل بازسازی می‌شوند و بعد هر جمله یکجا ترجمه می‌شود — تفاوتش در روانی فارسی محسوس است. این endpoint رسمی نیست؛ اگر محدود شود خودکار به یوتیوب برمی‌گردد.',
    libre:
      'به یک نمونه LibreTranslate وصل می‌شود. برای نمونه‌های عمومی معمولاً کلید لازم است؛ اجرای محلی محدودیت ندارد.',
    local:
      'از server/server.py استفاده می‌کند. اگر Ollama نصب باشد کیفیت فارسی محسوس بهتر از ترجمه ماشینی معمولی است.',
  };

  const formatValue = (id, value) => {
    switch (id) {
      case 'duckVolume':
        return `${Math.round(value * 100)}٪`;
      case 'maxLead':
      case 'maxLag':
        return `${value.toFixed(2)} ث`;
      case 'pauseMaxSeconds':
        return `${value} ث`;
      case 'charsPerSecond':
        return `${value}`;
      case 'groupSentences':
        return value <= 1 ? 'خاموش' : `${value} جمله`;
      case 'duckAttackMs':
      case 'duckReleaseMs':
        return `${Math.round(value)} م‌ث`;
      case 'duckHoldSeconds':
        return `${Number(value).toFixed(1)} ث`;
      case 'minPlaybackRate':
        return value >= 0.999 ? 'خاموش' : `${value}×`;
      default:
        return `${value}×`;
    }
  };

  /* ------------------------------------------------------------------ *
   * Conditional sections
   * ------------------------------------------------------------------ */

  const applyVisibility = () => {
    const active = new Set([
      $('translator').value,
      $('ttsEngine').value,
      $('overrunPolicy').value,
    ]);
    document.querySelectorAll('.conditional').forEach((el) => {
      const visible =
        (el.dataset.when && active.has(el.dataset.when)) ||
        (el.dataset.whenTranslator && el.dataset.whenTranslator === $('translator').value) ||
        (el.dataset.whenTts && el.dataset.whenTts === $('ttsEngine').value);
      el.hidden = !visible;
    });
    $('translatorHint').textContent = TRANSLATOR_HINTS[$('translator').value] || '';
    $('policyHint').textContent = POLICY_HINTS[$('overrunPolicy').value] || '';
  };

  /* ------------------------------------------------------------------ *
   * Voice lists
   * ------------------------------------------------------------------ */

  const loadSystemVoices = async (selected) => {
    const select = $('voiceURI');
    const hint = $('voiceHint');

    let voices = speechSynthesis.getVoices();
    if (!voices.length) {
      await new Promise((resolve) => {
        const done = () => {
          speechSynthesis.removeEventListener('voiceschanged', done);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, 4000);
        speechSynthesis.addEventListener('voiceschanged', done);
      });
      voices = speechSynthesis.getVoices();
    }

    const persian = voices.filter((v) =>
      String(v.lang || '').toLowerCase().replace('_', '-').startsWith('fa')
    );

    select.innerHTML = '';
    if (!persian.length) {
      select.innerHTML = '<option value="">— صدای فارسی پیدا نشد —</option>';
      hint.className = 'hint error conditional';
      hint.dataset.when = 'webspeech';
      hint.textContent =
        'ویندوز: Settings ◂ Time & language ◂ Speech ◂ Manage voices ◂ Add voices ◂ Persian (Farsi) را نصب کنید و کروم را دوباره باز کنید. بدون این کار فقط موتور Piper کار می‌کند.';
      return;
    }

    select.append(new Option('خودکار (اولین صدای فارسی)', ''));
    for (const voice of persian) {
      select.append(
        new Option(
          `${voice.name}${voice.localService ? '' : ' (آنلاین)'}`,
          voice.voiceURI
        )
      );
    }
    select.value = persian.some((v) => v.voiceURI === selected) ? selected : '';
    hint.className = 'hint ok conditional';
    hint.dataset.when = 'webspeech';
    hint.textContent = `${persian.length} صدای فارسی پیدا شد.`;
  };

  /**
   * Verify the key and populate the model list from the API itself.
   *
   * The key is read straight from the field and handed to the service worker;
   * it is never written anywhere else, never logged, and never put in a URL.
   */
  const loadGeminiModels = async (selected) => {
    const select = $('geminiModel');
    const ttsSelect = $('geminiTtsModel');
    const hint = $('geminiHint');
    const apiKey = $('geminiApiKey').value.trim();

    if (!apiKey) {
      select.innerHTML = '<option value="">— اول کلید را وارد کنید —</option>';
      ttsSelect.innerHTML = '<option value="">— اول کلید را وارد کنید —</option>';
      hint.className = 'hint conditional';
      hint.dataset.when = 'gemini';
      hint.textContent = '';
      return;
    }

    hint.className = 'hint conditional';
    hint.dataset.when = 'gemini';
    hint.textContent = 'در حال بررسی…';

    try {
      const [data, ttsData] = await Promise.all([
        callWorker('geminiModels', { apiKey }),
        callWorker('geminiTtsModels', { apiKey }).catch(() => ({ models: [] })),
      ]);
      const models = (data && data.models) || [];
      if (!models.length) throw new Error('این کلید به هیچ مدلی دسترسی ندارد');

      select.innerHTML = '';
      for (const model of models) {
        select.append(new Option(model.label ? `${model.id} — ${model.label}` : model.id, model.id));
      }
      select.value = models.some((m) => m.id === selected) ? selected : models[0].id;

      const ttsModels = (ttsData && ttsData.models) || [];
      ttsSelect.innerHTML = '';
      if (ttsModels.length) {
        for (const model of ttsModels) {
          ttsSelect.append(
            new Option(model.label ? `${model.id} — ${model.label}` : model.id, model.id)
          );
        }
        const savedTts = (await get()).geminiTtsModel;
        ttsSelect.value = ttsModels.some((m) => m.id === savedTts)
          ? savedTts
          : ttsModels[0].id;
      } else {
        ttsSelect.append(new Option('— مدل گفتاری در دسترس نیست —', ''));
      }

      // Do not confuse model enumeration with a working generation endpoint.
      // This real request verifies quota, permissions and the response schema.
      hint.textContent = 'مدل‌ها دریافت شد؛ در حال انجام ترجمهٔ زنده…';
      const probe = await callWorker('geminiProbe', {
        apiKey,
        model: select.value,
      });

      hint.className = 'hint ok conditional';
      hint.textContent =
        `اتصال واقعی موفق بود — ${probe.model} · ${Math.max(1, Math.round(probe.elapsedMs / 100) / 10)} ثانیه` +
        ` · «${probe.text}»` +
        (ttsModels.length ? ` · ${ttsModels.length} مدل گفتار` : ' · مدل گفتار در دسترس نیست');
      await set({
        geminiModel: select.value,
        ...(ttsSelect.value ? { geminiTtsModel: ttsSelect.value } : {}),
      });
    } catch (err) {
      select.innerHTML = '<option value="">— در دسترس نیست —</option>';
      ttsSelect.innerHTML = '<option value="">— در دسترس نیست —</option>';
      hint.className = 'hint error conditional';
      hint.textContent = String(err.message || err);
    }
  };

  /**
   * Run a handful of lines through whichever engine is configured and show
   * exactly what came back.
   *
   * Without this the only way to judge a translation setting is to dub a whole
   * video and listen, and a silent fallback to a different engine is
   * indistinguishable from a setting that did nothing.
   */
  const SAMPLE_LINES = [
    // Chosen to expose the usual failure modes: SOV word order, the را
    // object marker, ezafe chains, a word that is ambiguous unvocalised,
    // an idiom, and a number.
    'The people of this city read many books every year.',
    'He died in 1995, and everyone was upset.',
    "Let's cut to the chase and look at the results.",
    'You can find the big house of my father in the north of the city.',
  ];

  const runTranslationSample = async () => {
    const box = $('translateSample');
    const button = $('testTranslate');
    const current = await get();

    box.hidden = false;
    box.textContent = 'در حال ترجمه…';
    button.disabled = true;

    try {
      const provider = current.translator === 'youtube' ? 'google' : current.translator;
      const result = await callWorker('translate', {
        texts: SAMPLE_LINES,
        durations: [3.5, 2.5, 2.5, 4],
        from: current.sourceLang,
        to: current.targetLang,
        provider,
        libreEndpoint: current.libreEndpoint,
        libreApiKey: current.libreApiKey,
        localEndpoint: current.localEndpoint,
        geminiApiKey: current.geminiApiKey,
        geminiModel: current.geminiModel,
        adaptToDuration: current.adaptToDuration,
      });

      box.textContent = '';
      const header = document.createElement('div');
      header.className = 'note';
      header.textContent =
        current.translator === 'youtube'
          ? 'موتور «یوتیوب» فقط روی ویدیوی واقعی کار می‌کند؛ این نمونه با Google گرفته شد.'
          : `موتور: ${provider}`;
      box.append(header);

      result.forEach((item, i) => {
        const text = typeof item === 'object' ? item.text : item;
        const spoken = typeof item === 'object' ? item.spoken : '';

        const wrap = document.createElement('div');
        wrap.className = 'item';

        const en = document.createElement('div');
        en.className = 'en';
        en.textContent = SAMPLE_LINES[i];

        const fa = document.createElement('div');
        fa.className = 'fa';
        fa.textContent = text || '—';

        wrap.append(en, fa);

        if (spoken && spoken !== text) {
          const say = document.createElement('div');
          say.className = 'say';
          say.textContent = `🔊 ${spoken}`;
          wrap.append(say);
        }
        box.append(wrap);
      });

      const marked = result.filter(
        (r) => typeof r === 'object' && r.spoken && r.spoken !== r.text
      ).length;
      const footer = document.createElement('div');
      footer.className = 'note';
      footer.style.marginTop = '9px';
      footer.textContent = marked
        ? `${marked} از ${result.length} جمله متن گفتاری جداگانه دارد (اعراب و اضافه).`
        : 'این موتور متن گفتاری جداگانه نمی‌دهد — فقط Gemini این را می‌دهد.';
      box.append(footer);
    } catch (err) {
      box.textContent = `ناموفق: ${err.message}`;
    } finally {
      button.disabled = false;
    }
  };

  const loadPiperVoices = async (selected, { quiet = false } = {}) => {
    const select = $('piperVoice');
    const hint = $('serverHint');
    const endpoint = $('localEndpoint').value || DEFAULTS.localEndpoint;

    if (!quiet) {
      hint.className = 'hint conditional';
      hint.textContent = 'در حال بررسی…';
    }

    try {
      const data = await callWorker('localHealth', { endpoint });
      const voices = (data && data.voices) || [];
      select.innerHTML = '';
      if (!voices.length) {
        select.append(new Option('— سرور صدایی ندارد —', ''));
        hint.className = 'hint error conditional';
        hint.textContent =
          'سرور در دسترس است ولی هیچ مدلی بارگذاری نشده. python server/download_models.py را اجرا کنید.';
        return;
      }
      select.append(new Option('خودکار (اولین صدا)', ''));
      for (const voice of voices) {
        select.append(new Option(voice.name || voice.id, voice.id));
      }
      select.value = voices.some((v) => v.id === selected) ? selected : '';
      hint.className = 'hint ok conditional';
      hint.textContent = `سرور متصل است — ${voices.length} صدا.`;
    } catch (err) {
      select.innerHTML = '<option value="">— سرور در دسترس نیست —</option>';
      hint.className = 'hint error conditional';
      hint.textContent = `اتصال ناموفق: ${err.message}. سرور را با server/run.ps1 اجرا کنید.`;
    }
  };

  /* ------------------------------------------------------------------ *
   * Load / save
   * ------------------------------------------------------------------ */

  let saveTimer = null;
  const flashSaved = () => {
    const el = $('saved');
    el.textContent = 'ذخیره شد';
    el.style.color = ''; // clear the stale-worker warning colour
    el.classList.add('show');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => el.classList.remove('show'), 1200);
  };

  const collect = () => {
    const patch = {};
    BOOLEANS.forEach((id) => (patch[id] = $(id).checked));
    TEXTS.forEach((id) => (patch[id] = $(id).value.trim()));
    SELECTS.forEach((id) => {
      const value = $(id).value;
      // A select still showing a placeholder ("— enter a key first —") has an
      // empty value. Saving that would wipe a perfectly good stored choice
      // just because the list had not loaded yet.
      if (value === '' && ['geminiModel', 'geminiTtsModel', 'piperVoice'].includes(id)) return;
      patch[id] = value;
    });
    NUMBERS.forEach((id) => (patch[id] = Number($(id).value)));
    return patch;
  };

  const save = async () => {
    await set(collect());
    flashSaved();
  };

  const fill = (settings) => {
    BOOLEANS.forEach((id) => ($(id).checked = !!settings[id]));
    TEXTS.forEach((id) => ($(id).value = settings[id] || ''));
    NUMBERS.forEach((id) => {
      $(id).value = settings[id];
      const out = document.querySelector(`output[data-for="${id}"]`);
      if (out) out.textContent = formatValue(id, Number(settings[id]));
    });
    $('translator').value = settings.translator;
    $('ttsEngine').value = settings.ttsEngine;
    $('overrunPolicy').value = settings.overrunPolicy;
    $('geminiVoice').value = settings.geminiVoice;
    $('geminiTtsStyle').value = settings.geminiTtsStyle;
    applyVisibility();
  };

  /* ------------------------------------------------------------------ *
   * Optional host permission for user-supplied endpoints
   * ------------------------------------------------------------------ */

  const ensurePermission = async (rawUrl) => {
    let origin;
    try {
      const url = new URL(rawUrl);
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return true;
      origin = `${url.protocol}//${url.hostname}/*`;
    } catch (_) {
      return false;
    }
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return chrome.permissions.request({ origins: [origin] });
  };

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  /**
   * Warn up front if the worker predates this page, rather than letting the
   * user discover it one failed button at a time.
   */
  const checkWorkerIsCurrent = async () => {
    const banner = $('saved');
    try {
      const info = await callWorker('ping');
      const expected = [
        'translate',
        'tts',
        'geminiTts',
        'localHealth',
        'geminiModels',
        'geminiProbe',
        'geminiTtsModels',
        'condense',
      ];
      const missing = expected.filter((h) => !(info.handlers || []).includes(h));
      if (!missing.length) return true;
      throw new Error(`نبود: ${missing.join('، ')}`);
    } catch (err) {
      banner.textContent =
        'افزونه به‌روز نیست — در chrome://extensions روی آن Reload بزنید.';
      banner.style.color = 'var(--danger)';
      banner.classList.add('show');
      console.warn('[dub] stale service worker:', err.message);
      return false;
    }
  };

  const init = async () => {
    const settings = await get();
    fill(settings);

    if (settings.geminiApiKey) {
      // Show saved models without a round trip; verify only on demand.
      $('geminiModel').innerHTML = '';
      $('geminiModel').append(new Option(settings.geminiModel, settings.geminiModel));
      $('geminiTtsModel').innerHTML = '';
      $('geminiTtsModel').append(
        new Option(settings.geminiTtsModel, settings.geminiTtsModel)
      );
    } else {
      loadGeminiModels(settings.geminiModel);
    }

    // Wire every control before anything slow runs. Enumerating the system
    // voices can block for seconds waiting on `voiceschanged`, and awaiting it
    // first left the whole page inert for that long -- clicks in that window
    // simply did nothing, with no indication why.
    [...BOOLEANS, ...SELECTS].forEach((id) =>
      $(id).addEventListener('change', () => {
        applyVisibility();
        save();
      })
    );

    NUMBERS.forEach((id) =>
      $(id).addEventListener('input', () => {
        const out = document.querySelector(`output[data-for="${id}"]`);
        if (out) out.textContent = formatValue(id, Number($(id).value));
        save();
      })
    );

    TEXTS.forEach((id) =>
      $(id).addEventListener('change', async () => {
        const value = $(id).value.trim();
        if (value && (id === 'libreEndpoint' || id === 'localEndpoint')) {
          const granted = await ensurePermission(value);
          if (!granted) {
            $('serverHint').className = 'hint error conditional';
            $('serverHint').textContent =
              'دسترسی به این دامنه داده نشد؛ درخواست‌ها مسدود خواهند شد.';
          }
        }
        save();
      })
    );

    $('ttsEngine').addEventListener('change', () => {
      if ($('ttsEngine').value === 'piper') loadPiperVoices($('piperVoice').value);
      if ($('ttsEngine').value === 'gemini' && $('geminiApiKey').value.trim()) {
        loadGeminiModels($('geminiModel').value);
      }
    });

    $('checkServer').addEventListener('click', () =>
      loadPiperVoices($('piperVoice').value)
    );

    $('checkGemini').addEventListener('click', () =>
      loadGeminiModels($('geminiModel').value)
    );

    $('testTranslate').addEventListener('click', runTranslationSample);

    // Pasting a key should just work, without hunting for the verify button.
    $('geminiApiKey').addEventListener('change', () => {
      if ($('geminiApiKey').value.trim()) loadGeminiModels($('geminiModel').value);
    });

    $('testVoice').addEventListener('click', async () => {
      const current = await get();
      const sample =
        'این یک نمونه از دوبله فارسی است. اگر این جمله را می‌شنوید، همه چیز درست کار می‌کند.';

      if (current.ttsEngine === 'gemini') {
        try {
          const data = await callWorker('geminiTts', {
            text: sample,
            rate: current.baseRate,
            geminiApiKey: current.geminiApiKey,
            geminiTtsModel: current.geminiTtsModel,
            geminiVoice: current.geminiVoice,
            geminiTtsStyle: current.geminiTtsStyle,
          });
          const bytes = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: data.mime || 'audio/wav' }));
          const audio = new Audio(url);
          audio.onended = audio.onerror = () => URL.revokeObjectURL(url);
          await audio.play();
        } catch (err) {
          $('geminiHint').className = 'hint error conditional';
          $('geminiHint').textContent = `پخش نمونه ناموفق: ${err.message}`;
        }
        return;
      }

      if (current.ttsEngine === 'piper') {
        try {
          const data = await callWorker('tts', {
            endpoint: current.localEndpoint,
            text: sample,
            voice: current.piperVoice,
            lengthScale: 1 / current.baseRate,
          });
          const bytes = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: data.mime }));
          const audio = new Audio(url);
          audio.onended = () => URL.revokeObjectURL(url);
          await audio.play();
        } catch (err) {
          $('serverHint').className = 'hint error conditional';
          $('serverHint').textContent = `پخش نمونه ناموفق: ${err.message}`;
        }
        return;
      }

      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(sample);
      const voices = speechSynthesis.getVoices();
      const voice =
        voices.find((v) => v.voiceURI === current.voiceURI) ||
        voices.find((v) =>
          String(v.lang || '').toLowerCase().replace('_', '-').startsWith('fa')
        );
      if (voice) utterance.voice = voice;
      utterance.lang = (voice && voice.lang) || 'fa-IR';
      utterance.rate = current.baseRate;
      utterance.pitch = current.pitch;
      setTimeout(() => speechSynthesis.speak(utterance), 60);
    });

    $('reset').addEventListener('click', async () => {
      await chrome.storage.local.set({ settings: { ...DEFAULTS } });
      fill(DEFAULTS);
      await loadGeminiModels(DEFAULTS.geminiModel);
      await loadSystemVoices('');
      flashSaved();
    });

    speechSynthesis.addEventListener('voiceschanged', () =>
      loadSystemVoices($('voiceURI').value)
    );

    // Everything below is slow and optional; the page is already usable.
    checkWorkerIsCurrent();
    loadSystemVoices(settings.voiceURI);
    if (settings.ttsEngine === 'piper') loadPiperVoices(settings.piperVoice);
  };

  init();
})();
