/**
 * Translation client.
 *
 * All network work happens in the service worker: YouTube's Content Security
 * Policy governs `fetch` calls made from content scripts, so a direct request
 * to a translation endpoint from this world would be blocked.
 *
 * Results are cached per video so re-watching (or reloading) is instant.
 */
(() => {
  'use strict';

  const YD = (globalThis.YD = globalThis.YD || {});
  if (YD.translate) return;

  const { hash, log, isInLanguage } = YD.util;
  let lastMeta = null;

  // Bumped whenever the shape or the content of a translation changes, so old
  // entries cannot be served for a pipeline that now asks for something else.
  // Without this, enabling a better provider appears to do nothing at all:
  // the cache answers first and the new code never runs.
  const CACHE_VERSION = 6;

  const cacheKey = (videoId, settings, cues) =>
    [
      'tr',
      `v${CACHE_VERSION}`,
      videoId || 'unknown',
      settings.translator,
      settings.translator === 'gemini' ? settings.geminiModel : '',
      settings.adaptToDuration ? 'adapt' : 'literal',
      settings.sourceLang,
      settings.targetLang,
      hash(cues.map((c) => c.text).join('␟')),
    ].join(':');

  const readCache = async (key) => {
    try {
      const stored = await chrome.storage.local.get(key);
      const entry = stored[key];
      if (!entry || !Array.isArray(entry.texts)) return null;
      // Touch the entry so the LRU sweep keeps recently used videos.
      chrome.storage.local.set({ [key]: { ...entry, at: Date.now() } });
      return entry.texts;
    } catch (_) {
      return null;
    }
  };

  const writeCache = async (key, texts) => {
    try {
      await chrome.storage.local.set({ [key]: { texts, at: Date.now() } });
      await sweepCache();
    } catch (_) {
      /* quota -- not fatal */
    }
  };

  /** Keep the 25 most recent translations and drop the rest. */
  const sweepCache = async () => {
    const all = await chrome.storage.local.get(null);
    const entries = Object.keys(all)
      .filter((k) => k.startsWith('tr:'))
      .map((k) => ({ k, at: (all[k] && all[k].at) || 0 }))
      .sort((a, b) => b.at - a.at);
    if (entries.length <= 25) return;
    await chrome.storage.local.remove(entries.slice(25).map((e) => e.k));
  };

  /**
   * Translate the text of every cue in place (returns a new array).
   *
   * @param {{cues:Array, videoId:string, settings:Object, onProgress:Function}} args
   */
  const cues = async ({ cues, videoId, settings, onProgress = () => {} }) => {
    lastMeta = { provider: settings.translator, model: '' };
    const key = cacheKey(videoId, settings, cues);

    if (settings.cacheEnabled) {
      const cached = await readCache(key);
      if (cached && cached.length === cues.length) {
        log('translation cache hit');
        const cachedMeta = cached.find((entry) => entry && typeof entry === 'object');
        lastMeta = {
          provider: (cachedMeta && cachedMeta.provider) || settings.translator,
          model: (cachedMeta && cachedMeta.model) || '',
          cached: true,
        };
        onProgress({ phase: 'translate', done: cues.length, total: cues.length });
        // Entries written before the pronunciation field existed are plain
        // strings; treat them as their own spoken form.
        return cues.map((cue, i) => {
          const entry = cached[i];
          const text = (entry && entry.text) || (typeof entry === 'string' ? entry : cue.text);
          return {
            ...cue,
            source: cue.text,
            text,
            spoken: (entry && entry.spoken) || text,
            emotion: (entry && entry.emotion) || 'neutral',
            emphasis: (entry && Array.isArray(entry.emphasis) && entry.emphasis) || [],
            speaker: (entry && Number.isInteger(entry.speaker) && entry.speaker) || 0,
          };
        });
      }
    }

    const texts = cues.map((c) => c.text);
    // The budget for a line is the time until the *next* line starts, not how
    // long its own caption was shown. A short caption followed by two seconds
    // of silence has all of that time to be said in, and pretending otherwise
    // makes the model shorten lines that never needed it.
    const durations = cues.map((cue, i) => {
      const next = cues[i + 1];
      const window = (next ? Number(next.start) : Number(cue.end) + 2) - Number(cue.start);
      return Math.max(0.4, Math.round(window * 10) / 10);
    });
    const total = texts.length;
    let done = 0;

    onProgress({ phase: 'translate', done: 0, total });

    // Split into batches so progress moves and one failure costs little.
    const BATCH = 40;
    const batches = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      batches.push({
        index: i,
        texts: texts.slice(i, i + BATCH),
        durations: durations.slice(i, i + BATCH),
      });
    }

    const out = new Array(total);
    for (const batch of batches) {
      const translated = await YD.bridge.send('translate', {
        texts: batch.texts,
        durations: batch.durations,
        from: settings.sourceLang,
        to: settings.targetLang,
        provider: settings.translator === 'youtube' ? 'google' : settings.translator,
        libreEndpoint: settings.libreEndpoint,
        libreApiKey: settings.libreApiKey,
        localEndpoint: settings.localEndpoint,
        geminiApiKey: settings.geminiApiKey,
        geminiModel: settings.geminiModel,
        adaptToDuration: settings.adaptToDuration,
      });
      // Most providers answer with plain strings. Gemini answers with an
      // object carrying a second, pronunciation-ready form of the same line.
      translated.forEach((item, i) => {
        out[batch.index + i] =
          item && typeof item === 'object'
            ? {
                text: item.text || '',
                spoken: item.spoken || item.text || '',
                // Performance direction, when the provider supplies it. These
                // ride along with the text through the cache so a re-watch
                // sounds identical to the first run.
                emotion: item.emotion || 'neutral',
                emphasis: Array.isArray(item.emphasis) ? item.emphasis : [],
                speaker: Number.isInteger(item.speaker) ? item.speaker : 0,
                provider: item.provider || settings.translator,
                model: item.model || '',
              }
            : { text: item || '', spoken: item || '', emotion: 'neutral', emphasis: [], speaker: 0 };
      });
      done += batch.texts.length;
      onProgress({ phase: 'translate', done, total });
    }

    // A failed sentence comes back as its own source text. A few of those are
    // survivable; a lot of them means the endpoint is rate limiting us, and
    // half an English dub is worse than no dub -- so say so and let the caller
    // fall back to a provider that is still answering.
    //
    // The test is what share of the *letters* are in the target script. An
    // earlier version only asked whether the line contained a Persian
    // character anywhere, which let "The Amazon rainforest دارد" count as a
    // successful translation and put English into the dub.
    let failed = 0;
    for (let i = 0; i < total; i++) {
      const text = out[i] && out[i].text;
      if (!text || text === texts[i] || !isInLanguage(text, settings.targetLang)) {
        failed++;
      }
    }

    // Speech is unforgiving: even one line in ten being the wrong language is
    // obvious to a listener, so this is far stricter than a subtitle would need.
    if (failed / total > 0.1) {
      throw Object.assign(
        new Error(`ترجمه ناموفق بود (${failed} از ${total} جمله)`),
        { partial: true }
      );
    }
    if (failed) log(`${failed}/${total} sentences kept their source text`);

    if (settings.cacheEnabled) writeCache(key, out);

    const withDiacritics = out.filter((e) => e && e.spoken && e.spoken !== e.text).length;
    const responseMeta = out.find((entry) => entry && (entry.provider || entry.model));
    lastMeta = {
      provider: (responseMeta && responseMeta.provider) || settings.translator,
      model: (responseMeta && responseMeta.model) || '',
      cached: false,
    };
    log(
      `translated ${total} via ${settings.translator}` +
        (withDiacritics ? `, ${withDiacritics} with pronunciation marks` : '')
    );

    return cues.map((cue, i) => ({
      ...cue,
      source: cue.text,
      text: (out[i] && out[i].text) || cue.text,
      spoken: (out[i] && out[i].spoken) || (out[i] && out[i].text) || cue.text,
      emotion: (out[i] && out[i].emotion) || 'neutral',
      emphasis: (out[i] && out[i].emphasis) || [],
      speaker: (out[i] && out[i].speaker) || 0,
    }));
  };

  YD.translate = {
    cues,
    get lastMeta() {
      return lastMeta;
    },
  };
})();
