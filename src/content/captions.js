/**
 * Caption acquisition and cue building.
 *
 * YouTube gives us caption files in two shapes:
 *   json3 -- events with millisecond timings and, for auto-captions, per-word
 *            offsets inside `segs`
 *   XML   -- legacy `<text start dur>` elements
 *
 * Auto-generated tracks arrive as a stream of word fragments with no
 * punctuation, which is unusable for speech: a dub that speaks three words at a
 * time sounds like a stutter and translates terribly. So everything is
 * flattened into a token stream first, then re-grouped into sentence-sized
 * chunks using punctuation when it exists and pause/length heuristics when it
 * does not.
 */
(() => {
  'use strict';

  const YD = (globalThis.YD = globalThis.YD || {});
  if (YD.captions) return;

  const { normalizeSpace, log, warn } = YD.util;

  /* ------------------------------------------------------------------ *
   * Parsing
   * ------------------------------------------------------------------ */

  /**
   * @returns {{t:number, text:string, d?:number}[]} absolute-time tokens
   *
   * A token is one word for auto-generated tracks (which carry per-word
   * `tOffsetMs`) but a whole line for anything YouTube has translated, since
   * those come back as one segment per caption. `d` is only set in the second
   * case, where the event duration really describes the token.
   */
  const parseJson3 = (raw) => {
    const data = JSON.parse(raw);
    const events = Array.isArray(data && data.events) ? data.events : [];
    const tokens = [];

    for (const ev of events) {
      if (!ev || !Array.isArray(ev.segs)) continue;
      const base = Number(ev.tStartMs) || 0;
      const duration = (Number(ev.dDurationMs) || 0) / 1000;

      const filled = ev.segs.filter((seg) => String((seg && seg.utf8) || '').trim());
      // Newline-only segments are the rolling-window artifacts of auto
      // captions; they carry no words.
      if (!filled.length) continue;
      const lineBased = filled.length === 1;

      for (const seg of filled) {
        const token = {
          t: (base + (Number(seg.tOffsetMs) || 0)) / 1000,
          text: String(seg.utf8).trim(),
        };
        if (lineBased && duration > 0) token.d = duration;
        tokens.push(token);
      }
    }
    return tokens;
  };

  const parseXml = (raw) => {
    const doc = new DOMParser().parseFromString(raw, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('bad caption xml');

    const decoder = document.createElement('textarea');
    const tokens = [];

    for (const node of doc.querySelectorAll('text')) {
      const start = parseFloat(node.getAttribute('start') || '0') || 0;
      const dur = parseFloat(node.getAttribute('dur') || '0') || 0;
      decoder.innerHTML = node.textContent || '';
      const line = normalizeSpace(decoder.value).replace(/\n/g, ' ');
      if (!line) continue;

      // XML tracks are line-timed, so spread the words evenly across the line
      // to recover something close to word timings.
      const words = line.split(' ');
      const step = words.length > 1 ? dur / words.length : 0;
      words.forEach((word, i) => tokens.push({ t: start + step * i, text: word }));
    }
    return tokens;
  };

  const parse = (raw) => {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return [];
    if (trimmed[0] === '{') return parseJson3(trimmed);
    if (trimmed[0] === '<') return parseXml(trimmed);
    throw new Error('unrecognised caption format');
  };

  /* ------------------------------------------------------------------ *
   * Token stream -> sentences
   * ------------------------------------------------------------------ */

  const TERMINAL = /[.!?…؟!]["'”’)\]]*$/;
  const SOFT_BREAK = /[,;:،؛]["'”’)\]]*$/;

  const GROUPING = {
    maxGap: 0.8, // a pause this long ends a sentence
    softGap: 0.45, // ... but only after a comma, this is enough
    maxWords: 18,
    softMaxWords: 12, // allowed to break at a comma past this point
    maxDuration: 7.5,
    minDuration: 0.35,
  };

  /**
   * @param {{t:number,text:string}[]} tokens
   * @param {number} mediaDuration used to bound the final cue
   * @returns {{start:number,end:number,text:string}[]}
   */
  const wordsIn = (text) => {
    const trimmed = normalizeSpace(text);
    return trimmed ? trimmed.split(' ').length : 0;
  };

  const groupIntoSentences = (tokens, mediaDuration = 0) => {
    const cues = [];
    let buffer = [];
    let bufferWords = 0;

    const flush = (nextStart) => {
      if (!buffer.length) return;
      const text = normalizeSpace(buffer.map((tk) => tk.text).join(' '));
      if (text) {
        const start = buffer[0].t;
        const last = buffer[buffer.length - 1];
        // Line-based tracks state their own duration; for word-level tracks
        // estimate where the final word stops, so the cue still has a real end
        // when a long silence follows.
        const tail = last.d || Math.min(0.6, 0.12 + last.text.length * 0.055);
        let end = last.t + tail;
        if (Number.isFinite(nextStart)) end = Math.min(end, nextStart);
        end = Math.max(end, start + GROUPING.minDuration);
        cues.push({ start, end, text });
      }
      buffer = [];
      bufferWords = 0;
    };

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      buffer.push(token);
      // Count words, not tokens: a token is a single word on auto-generated
      // tracks but an entire line on translated ones, and a limit of "18
      // tokens" would mean two very different things.
      bufferWords += wordsIn(token.text);

      const next = tokens[i + 1];
      if (!next) break;

      const gap = next.t - token.t;
      const words = bufferWords;
      const span = next.t - buffer[0].t;

      let shouldBreak = false;
      if (TERMINAL.test(token.text)) shouldBreak = true;
      else if (gap >= GROUPING.maxGap) shouldBreak = true;
      else if (words >= GROUPING.maxWords) shouldBreak = true;
      else if (span >= GROUPING.maxDuration) shouldBreak = true;
      else if (
        words >= GROUPING.softMaxWords &&
        (SOFT_BREAK.test(token.text) || gap >= GROUPING.softGap)
      ) {
        shouldBreak = true;
      }

      if (shouldBreak) flush(next.t);
    }
    flush(mediaDuration || Infinity);

    return cues;
  };

  /* ------------------------------------------------------------------ *
   * Track selection
   * ------------------------------------------------------------------ */

  /**
   * Prefer a human-written track in the source language, then the
   * auto-generated one, then anything translatable.
   */
  const pickTrack = (tracks, settings) => {
    if (!tracks.length) return null;
    const want = String(settings.sourceLang || 'en').toLowerCase();
    const isAsr = (t) => t.kind === 'asr' || /^a\./.test(t.vssId || '');

    const inLang = tracks.filter((t) =>
      String(t.languageCode || '').toLowerCase().startsWith(want)
    );
    const pool = inLang.length ? inLang : tracks;

    const manual = pool.filter((t) => !isAsr(t));
    const auto = pool.filter(isAsr);

    if (settings.preferManualCaptions && manual.length) return manual[0];
    if (auto.length && !manual.length) return auto[0];
    return manual[0] || auto[0] || pool[0];
  };

  const canAutoTranslateTo = (translationLanguages, lang) =>
    (translationLanguages || []).some((l) =>
      String(l.code || '').toLowerCase().startsWith(String(lang).toLowerCase())
    );

  /**
   * Get the caption body, trying each acquisition route until one yields
   * actual tokens.
   *
   * The order matters. A body passively captured from this exact video/track
   * is free and instantaneous, so it goes first. Otherwise the reliable route
   * is to drive the player into loading the track and read the body off its own
   * request. YouTube's advertised `baseUrl` often answers 200 with an *empty
   * body* because these URLs are effectively single-use, but direct fetch
   * remains a cheap final try because it still works on some videos.
   *
   * @returns {Promise<{tokens:Array, translated:boolean, via:string}>}
   */
  const acquire = async ({ track, tlang, videoId, onProgress }) => {
    const attempts = [];

    // If the player already fetched this exact track after our document_start
    // hook was installed, use it immediately. Matching the track parameters
    // makes this safe; the old "latest capture" fallback could return a stale
    // language or even the previous SPA video's captions.
    attempts.push({
      name: 'captured',
      translated: !!tlang,
      run: async () => {
        const capture = YD.bridge.findCapture({
          languageCode: track.languageCode,
          kind: track.kind,
          vssId: track.vssId,
          videoId,
          tlang: tlang || '',
        });
        return capture && capture.body;
      },
    });

    attempts.push({
      name: 'prime',
      translated: !!tlang,
      run: () =>
        YD.bridge
          .call('primeTrack', {
            languageCode: track.languageCode,
            kind: track.kind,
            vssId: track.vssId,
            videoId,
            tlang: tlang || '',
            timeout: 12000,
          })
          .then((res) => res && res.body),
    });

    // Same trick without the translation, in case the target language is what
    // the player choked on.
    if (tlang) {
      attempts.push({
        name: 'captured-untranslated',
        translated: false,
        run: async () => {
          const capture = YD.bridge.findCapture({
            languageCode: track.languageCode,
            kind: track.kind,
            vssId: track.vssId,
            videoId,
            tlang: '',
          });
          return capture && capture.body;
        },
      });
      attempts.push({
        name: 'prime-untranslated',
        translated: false,
        run: () =>
          YD.bridge
            .call('primeTrack', {
              languageCode: track.languageCode,
              kind: track.kind,
              vssId: track.vssId,
              videoId,
              tlang: '',
              timeout: 12000,
            })
            .then((res) => res && res.body),
      });
    }

    attempts.push({
      name: 'fetch',
      translated: !!tlang,
      run: () =>
        YD.bridge
          .call('fetchTrack', { url: track.baseUrl, tlang: tlang || undefined })
          .then((res) => res && res.body),
    });

    const failures = [];
    for (const attempt of attempts) {
      onProgress && onProgress({ phase: 'captions', message: 'خواندن زیرنویس…' });
      let body;
      try {
        body = await attempt.run();
      } catch (err) {
        failures.push(`${attempt.name}: ${(err && err.message) || err}`);
        continue;
      }
      if (!body || !body.trim()) {
        failures.push(`${attempt.name}: پاسخ خالی`);
        continue;
      }

      let tokens;
      try {
        tokens = parse(body);
      } catch (err) {
        failures.push(`${attempt.name}: ${(err && err.message) || err}`);
        continue;
      }
      if (!tokens.length) {
        failures.push(`${attempt.name}: بدون متن`);
        continue;
      }

      log(`captions acquired via ${attempt.name} (${tokens.length} tokens)`);
      return { tokens, translated: attempt.translated, via: attempt.name };
    }

    warn('all caption routes failed', failures);
    throw new Error('زیرنویس در دسترس نیست — ' + failures.join(' · '));
  };

  /* ------------------------------------------------------------------ *
   * Public entry point
   * ------------------------------------------------------------------ */

  /**
   * Fetch and build cues for the current video.
   *
   * @returns {Promise<{cues:Array, lang:string, translated:boolean, track:Object}>}
   */
  const build = async ({ settings, onProgress = () => {} }) => {
    onProgress({ phase: 'captions', message: 'خواندن زیرنویس…' });

    const info = await YD.bridge.call('tracks');
    if (!info || !info.tracks || !info.tracks.length) {
      throw new Error('این ویدیو زیرنویس ندارد');
    }

    const track = pickTrack(info.tracks, settings);
    if (!track || !track.baseUrl) throw new Error('زیرنویس مناسبی پیدا نشد');

    log('selected caption track', track);

    const target = settings.targetLang;

    // The tracklist in the player response is not always populated, so ask the
    // live captions module too before deciding auto-translation is impossible.
    let translationLanguages = info.translationLanguages || [];
    if (!translationLanguages.length) {
      translationLanguages = await YD.bridge.call('translationLanguages').catch(() => []);
    }

    const useYouTubeTranslation =
      settings.translator === 'youtube' &&
      track.isTranslatable !== false &&
      !String(track.languageCode || '').toLowerCase().startsWith(target) &&
      canAutoTranslateTo(translationLanguages, target);

    if (settings.translator === 'youtube' && !useYouTubeTranslation) {
      warn('youtube auto-translation unavailable for this track');
    }

    const { tokens, translated, via } = await acquire({
      track,
      tlang: useYouTubeTranslation ? target : '',
      videoId: info.videoId,
      onProgress,
    });

    const cues = groupIntoSentences(tokens, info.durationSeconds);
    if (!cues.length) throw new Error('ساخت جمله‌ها از زیرنویس ناموفق بود');

    log(`built ${cues.length} cues from ${tokens.length} tokens (via ${via})`);

    return {
      cues,
      videoId: info.videoId,
      title: info.title,
      durationSeconds: info.durationSeconds,
      lang: translated ? target : track.languageCode,
      translated,
      via,
      track,
    };
  };

  YD.captions = { build, acquire, parse, groupIntoSentences, pickTrack, GROUPING };
})();
