/**
 * Speech engines.
 *
 * Three backends behind one interface:
 *
 *   webspeech -- the browser's speechSynthesis. Free and dependency-free, but
 *                only as good as the Persian voice installed in Windows, and
 *                it cannot be pre-rendered, so there is a variable start delay.
 *
 *   piper     -- neural voices rendered by the local server. Audio comes back
 *                as a WAV buffer, which means we can synthesise sentences
 *                ahead of time and start them with sample-accurate timing.
 *
 *   gemini    -- controllable online neural TTS. The worker converts Gemini's
 *                raw PCM response to WAV; playback and timing then share the
 *                same pre-rendered path as Piper.
 *
 * Both expose:
 *   ready()                 -> resolves when usable, throws with a readable reason
 *   speak(text, opts)       -> { promise, cancel() }  promise settles on end
 *   cancelAll()
 *   prefetch(text, opts)    -> optional warm-up (no-op for webspeech)
 */
(() => {
  'use strict';

  const YD = (globalThis.YD = globalThis.YD || {});
  if (YD.tts) return;

  const { clamp, sleep, spokenLength, log, warn } = YD.util;

  /* ================================================================== *
   * Web Speech API
   * ================================================================== */

  const webSpeech = (() => {
    let keepAlive = null;
    let currentUtterance = null;

    /**
     * speechSynthesis cannot tell us how long an utterance will take before it
     * runs, so the planner starts from a characters-per-second constant. Every
     * completed sentence is a free measurement of the real value, which varies
     * a lot between voices -- so learn it as we go and let the planner replan
     * against the corrected figure.
     */
    let observedCps = null;
    let samples = 0;
    const ALPHA = 0.25;

    const record = (text, rate, elapsedSeconds) => {
      // Very short utterances are dominated by engine start-up latency and
      // would drag the average down.
      if (!(elapsedSeconds > 0.4)) return;
      const chars = spokenLength(text);
      if (chars < 8) return;

      const cps = chars / (elapsedSeconds * rate);
      if (!Number.isFinite(cps) || cps <= 0) return;

      observedCps = observedCps === null ? cps : observedCps * (1 - ALPHA) + cps * ALPHA;
      samples++;
    };

    const listVoices = () =>
      typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices();

    /** getVoices() is empty until the engine enumerates; wait for it once. */
    const loadVoices = async (timeout = 5000) => {
      let voices = listVoices();
      if (voices.length) return voices;

      await new Promise((resolve) => {
        const done = () => {
          speechSynthesis.removeEventListener('voiceschanged', done);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, timeout);
        speechSynthesis.addEventListener('voiceschanged', done);
      });
      return listVoices();
    };

    const pickVoice = (voices, settings) => {
      const lang = String(settings.targetLang || 'fa').toLowerCase();
      if (settings.voiceURI) {
        const exact = voices.find((v) => v.voiceURI === settings.voiceURI);
        if (exact) return exact;
      }
      const inLang = voices.filter((v) =>
        String(v.lang || '').toLowerCase().replace('_', '-').startsWith(lang)
      );
      if (!inLang.length) return null;
      // Prefer a local (offline) voice: no network hiccups mid-sentence.
      return inLang.find((v) => v.localService) || inLang[0];
    };

    let voice = null;

    const ready = async (settings) => {
      if (typeof speechSynthesis === 'undefined') {
        throw new Error('این مرورگر از speechSynthesis پشتیبانی نمی‌کند');
      }
      const voices = await loadVoices();
      voice = pickVoice(voices, settings);
      if (!voice) {
        throw new Error(
          'هیچ صدای فارسی روی ویندوز نصب نیست. Settings ▸ Time & language ▸ Speech ▸ Manage voices ▸ Add voices ▸ Persian'
        );
      }
      log('web speech voice:', voice.name, voice.lang, voice.localService);
      return { name: voice.name, lang: voice.lang };
    };

    /**
     * Chrome silently stops long utterances after ~15s unless the synthesiser
     * is nudged. Our sentences are short, but a slow rate on a long cue can
     * cross the line, so keep it awake while anything is speaking.
     */
    const startKeepAlive = () => {
      if (keepAlive) return;
      keepAlive = setInterval(() => {
        if (speechSynthesis.speaking && !speechSynthesis.paused) {
          speechSynthesis.resume();
        }
      }, 5000);
    };
    const stopKeepAlive = () => {
      if (!keepAlive) return;
      clearInterval(keepAlive);
      keepAlive = null;
    };

    const cancelAll = () => {
      currentUtterance = null;
      stopKeepAlive();
      try {
        speechSynthesis.cancel();
      } catch (_) {
        /* ignore */
      }
    };

    const speak = (text, { rate = 1, pitch = 1, lang = 'fa-IR' } = {}) => {
      let settle;
      let cancelled = false;
      const promise = new Promise((resolve) => {
        settle = resolve;
      });

      // cancel() followed immediately by speak() drops the new utterance in
      // Chrome, so always leave a beat between them.
      const run = async () => {
        if (speechSynthesis.speaking || speechSynthesis.pending) {
          speechSynthesis.cancel();
          await sleep(40);
        }
        if (cancelled) return settle({ reason: 'cancelled' });

        const utterance = new SpeechSynthesisUtterance(text);
        if (voice) utterance.voice = voice;
        utterance.lang = (voice && voice.lang) || lang;
        utterance.rate = clamp(rate, 0.1, 10);
        utterance.pitch = clamp(pitch, 0, 2);
        utterance.volume = 1;

        const startedAt = performance.now();
        const finish = (reason) => {
          if (currentUtterance === utterance) currentUtterance = null;
          if (!speechSynthesis.speaking) stopKeepAlive();
          if (reason === 'end') {
            record(text, utterance.rate, (performance.now() - startedAt) / 1000);
          }
          settle({ reason });
        };
        utterance.onend = () => finish('end');
        utterance.onerror = (e) => {
          if (e.error !== 'interrupted' && e.error !== 'canceled') {
            warn('speech error', e.error);
          }
          finish('error');
        };

        currentUtterance = utterance;
        startKeepAlive();
        speechSynthesis.speak(utterance);
      };

      run();

      return {
        promise,
        cancel() {
          cancelled = true;
          cancelAll();
          settle({ reason: 'cancelled' });
        },
      };
    };

    return {
      id: 'webspeech',
      exact: false,
      ready,
      speak,
      cancelAll,
      prefetch: async () => {},
      /** Nothing can be rendered ahead of time here. */
      prepare: async () => null,
      /** No grouped rendering: speechSynthesis speaks one utterance at a time. */
      setScript: () => {},
      /** Learned characters-per-second, once enough sentences have run. */
      calibration: () => (samples >= 3 && observedCps ? { charsPerSecond: observedCps } : null),
      listVoices,
      pause: () => {
        try {
          speechSynthesis.pause();
        } catch (_) {}
      },
      resume: () => {
        try {
          speechSynthesis.resume();
        } catch (_) {}
      },
    };
  })();

  /* ================================================================== *
   * Splitting a grouped render back into its sentences
   * ================================================================== */

  /**
   * Find the silences in a rendered passage and cut it there.
   *
   * Rendering several sentences in one request is what stops each line from
   * restarting its intonation from neutral -- but the scheduler still places
   * sentences individually, so the passage has to come back apart. The model
   * is asked to leave a clear pause between lines, and those pauses are real
   * silence, so they are findable.
   *
   * This is deliberately suspicious of its own result. A dub built from a
   * mis-split render would put half a sentence in the wrong place for the rest
   * of the video, which is far worse than the flatness grouping was meant to
   * fix -- so anything that does not look like a clean N-way split returns
   * null and the caller falls back to rendering the lines one at a time.
   *
   * @param {AudioBuffer} buffer
   * @param {number} parts how many sentences went in
   * @param {number[]} weights relative expected length of each sentence
   * @returns {{start:number,end:number}[]|null} one span per sentence
   */
  const splitOnSilence = (buffer, parts, weights) => {
    if (!buffer || parts < 2) return null;
    if (buffer.duration < 0.5 * parts) return null;

    const sampleRate = buffer.sampleRate;
    const samples = buffer.getChannelData(0);
    const FRAME = Math.max(1, Math.round(sampleRate * 0.01)); // 10 ms
    const frames = Math.floor(samples.length / FRAME);
    if (frames < parts * 10) return null;

    // Frame energy, and the loudest frame as the reference for "quiet".
    const energy = new Float32Array(frames);
    let peak = 0;
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      const from = f * FRAME;
      for (let i = from; i < from + FRAME; i++) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / FRAME);
      energy[f] = rms;
      if (rms > peak) peak = rms;
    }
    if (peak <= 0) return null;

    // Speech sits far above the noise floor of a synthesised render, so a
    // fixed ratio below the peak separates the two cleanly.
    const floor = peak * 0.06;

    // Runs of quiet frames, long enough to be a deliberate pause rather than
    // the gap inside a word.
    const MIN_PAUSE_FRAMES = 18; // 180 ms
    const gaps = [];
    let runStart = -1;
    for (let f = 0; f <= frames; f++) {
      const quiet = f < frames && energy[f] < floor;
      if (quiet) {
        if (runStart < 0) runStart = f;
        continue;
      }
      if (runStart >= 0) {
        const length = f - runStart;
        // Leading and trailing silence is trimmed separately, not a boundary.
        if (length >= MIN_PAUSE_FRAMES && runStart > 0 && f < frames) {
          gaps.push({ start: runStart, end: f, length });
        }
        runStart = -1;
      }
    }

    if (gaps.length < parts - 1) return null;

    // Where speech actually begins and ends, so leading/trailing padding is
    // not charged to the first and last sentences.
    let first = 0;
    while (first < frames && energy[first] < floor) first++;
    let last = frames - 1;
    while (last > first && energy[last] < floor) last--;
    if (last <= first) return null;

    // The longest pauses are the sentence boundaries; keep them in time order.
    const chosen = gaps
      .slice()
      .sort((a, b) => b.length - a.length)
      .slice(0, parts - 1)
      .sort((a, b) => a.start - b.start);

    // Cut in the middle of each pause so neither neighbour loses its release.
    const cuts = chosen.map((gap) => Math.round((gap.start + gap.end) / 2));

    const bounds = [first, ...cuts, last + 1];
    const spans = [];
    for (let i = 0; i < parts; i++) {
      const from = bounds[i];
      const to = bounds[i + 1];
      if (!(to > from)) return null;
      spans.push({ start: (from * FRAME) / sampleRate, end: (to * FRAME) / sampleRate });
    }

    /*
     * Verification. The split above is only a guess about which pauses were
     * sentence boundaries; if the model ran two lines together, the longest
     * remaining pause is somewhere arbitrary and every span after it is wrong.
     *
     * Comparing each span against how long that sentence was expected to take
     * catches exactly that: a span carrying two sentences is roughly twice its
     * share, and the one it stole from is roughly nothing.
     */
    const totalWeight = weights.reduce((sum, value) => sum + Math.max(0.1, value), 0);
    const speech = spans.reduce((sum, span) => sum + (span.end - span.start), 0);
    if (speech <= 0) return null;

    for (let i = 0; i < parts; i++) {
      const span = spans[i];
      const length = span.end - span.start;
      if (length < 0.15) return null; // nothing worth calling a sentence
      const expected = (Math.max(0.1, weights[i]) / totalWeight) * speech;
      const ratio = length / expected;
      if (ratio < 0.45 || ratio > 2.2) return null;
    }

    return spans;
  };

  /** Copy one span of a decoded buffer into a buffer of its own. */
  const sliceBuffer = (context, buffer, span) => {
    const sampleRate = buffer.sampleRate;
    const from = Math.max(0, Math.floor(span.start * sampleRate));
    const to = Math.min(buffer.length, Math.ceil(span.end * sampleRate));
    const length = Math.max(1, to - from);
    const out = context.createBuffer(buffer.numberOfChannels, length, sampleRate);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      out.getChannelData(channel).set(buffer.getChannelData(channel).subarray(from, to));
    }
    return out;
  };

  /* ================================================================== *
   * Pre-rendered audio engines (Piper and Gemini TTS)
   * ================================================================== */

  const createRenderedEngine = ({ id, configure, request, requestGroup }) => {
    const cache = new Map(); // engine configuration + text + rate -> audio entry
    let configuration = null;
    let configurationKey = '';
    let playing = null;
    let audioContext = null;
    let bus = null;

    /*
     * Grouping state.
     *
     * The scheduler still asks for one sentence at a time, but an engine that
     * can render a whole passage in one request produces markedly better
     * intonation, so it needs to know what surrounds the sentence it was
     * asked for. `script` is the full cue list; `groups` maps each cue index
     * to the passage it belongs to.
     */
    let script = null;
    let groups = null;
    let grouping = false;
    let scriptSignature = '';
    const groupRenders = new Map(); // group key -> in-flight render
    const soloOnly = new Set(); // groups whose split could not be trusted

    const key = (text, rate) => `${id}|${configurationKey}|${rate.toFixed(2)}|${text}`;

    const getAudioContext = () => {
      if (audioContext && audioContext.state !== 'closed') return audioContext;
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) return null;
      audioContext = new AudioContextClass({ latencyHint: 'interactive' });
      bus = null;
      return audioContext;
    };

    /**
     * The dub bus.
     *
     * A raw TTS render dropped straight onto the destination sits at whatever
     * level the model happened to produce, which drifts sentence to sentence
     * and leaves the dub either buried under the original track or jumping out
     * in front of it. Mixing it the way a dub stem is actually mixed fixes
     * that, and each stage earns its place:
     *
     *   highpass    neural voices carry rumble below the voice band that adds
     *               nothing but eats headroom under the original audio
     *   compressor  evens out the sentence-to-sentence level swing, so the
     *               ducking depth means the same thing every time
     *   limiter     a fast, hard ceiling: nothing downstream ever clips, no
     *               matter what a single render does
     *
     * Built once and reused, so consecutive sentences share the compressor's
     * state instead of each starting from rest.
     */
    const getBus = () => {
      const context = getAudioContext();
      if (!context) return null;
      if (bus) return bus;

      const input = context.createGain();

      const highpass = context.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 80;
      highpass.Q.value = 0.7;

      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -20;
      compressor.knee.value = 12;
      compressor.ratio.value = 3;
      compressor.attack.value = 0.006;
      compressor.release.value = 0.18;

      // Make up the level the compressor took off, so the dub still sits
      // above the ducked original.
      const makeup = context.createGain();
      makeup.gain.value = 1.6;

      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -2;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.06;

      input
        .connect(highpass)
        .connect(compressor)
        .connect(makeup)
        .connect(limiter)
        .connect(context.destination);

      bus = { input };
      return bus;
    };

    const decode = async (bytes) => {
      const context = getAudioContext();
      if (!context) return null;
      try {
        // decodeAudioData may detach its input, so give it a private copy.
        return await context.decodeAudioData(bytes.buffer.slice(0));
      } catch (err) {
        warn(`Web Audio could not decode ${id} output; using HTML audio`, err);
        return null;
      }
    };

    /** Metadata fallback for browsers where Web Audio decoding is unavailable. */
    const measureUrl = (url) =>
      new Promise((resolve) => {
        const probe = new Audio();
        probe.preload = 'metadata';
        const done = (value) => {
          probe.onloadedmetadata = probe.onerror = null;
          resolve(value);
        };
        probe.onloadedmetadata = () =>
          done(Number.isFinite(probe.duration) ? probe.duration : 0);
        probe.onerror = () => done(0);
        probe.src = url;
      });

    const evictOldest = async () => {
      while (cache.size > 32) {
        const oldest = cache.keys().next().value;
        const task = cache.get(oldest);
        cache.delete(oldest);
        const entry = await task.catch(() => null);
        if (entry && entry.url) URL.revokeObjectURL(entry.url);
      }
    };

    /* ---------------------------------------------------------------- *
     * Grouped rendering
     * ---------------------------------------------------------------- */

    /** The passage index `cueIndex` belongs to, or null when not grouping. */
    const groupFor = (cueIndex) => {
      if (!grouping || !groups || !Number.isInteger(cueIndex)) return null;
      const group = groups.get(cueIndex);
      if (!group || group.members.length < 2) return null;
      if (soloOnly.has(group.id)) return null;
      return group;
    };

    /**
     * Render a whole passage, split it, and seed the per-sentence cache.
     *
     * Every member is cached under the same key a solo render would have used,
     * so a failure here costs nothing: the caller simply misses the cache and
     * renders that one sentence on its own.
     */
    const renderGroup = async (group, rate) => {
      const context = getAudioContext();
      if (!context) throw new Error('no audio context');

      const lines = group.members.map((member) => ({
        text: member.text,
        emotion: member.emotion,
        emphasis: member.emphasis,
        speaker: member.speaker,
      }));

      const data = await requestGroup(configuration, lines, rate);
      const bytes = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
      const buffer = await decode(bytes);
      if (!buffer) throw new Error('grouped render could not be decoded');

      const weights = group.members.map((member) => spokenLength(member.text) || 1);
      const spans = splitOnSilence(buffer, group.members.length, weights);
      if (!spans) {
        // Not a clean split. Never guess: fall back to solo renders for this
        // passage permanently, so we do not pay for the same bad group twice.
        soloOnly.add(group.id);
        throw new Error('grouped render did not split cleanly');
      }

      group.members.forEach((member, i) => {
        const piece = sliceBuffer(context, buffer, spans[i]);
        const entry = { url: '', buffer: piece, duration: piece.duration };
        cache.set(key(member.text, rate), Promise.resolve(entry));
      });
      evictOldest();
      log(`${id}: grouped ${group.members.length} sentences into one render`);
    };

    /** Render the passage containing this sentence, at most once at a time. */
    const ensureGroup = (group, rate) => {
      const k = `${group.id}|${rate.toFixed(2)}`;
      if (groupRenders.has(k)) return groupRenders.get(k);
      const task = renderGroup(group, rate)
        .catch((err) => {
          warn(`${id}: grouped render failed, falling back to single sentences`, err);
        })
        .finally(() => groupRenders.delete(k));
      groupRenders.set(k, task);
      return task;
    };

    const synthesise = async (text, rate, cueIndex) => {
      const k = key(text, rate);
      if (cache.has(k)) {
        const hit = cache.get(k);
        // Map insertion order doubles as a tiny LRU.
        cache.delete(k);
        cache.set(k, hit);
        return hit;
      }

      // Try to get this sentence as part of its passage first: one request
      // covering several lines keeps the intonation continuous across them.
      const group = groupFor(cueIndex);
      if (group) {
        await ensureGroup(group, rate);
        if (cache.has(k)) return cache.get(k);
      }

      const task = (async () => {
        const data = await request(configuration, text, rate);
        const bytes = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(
          new Blob([bytes], { type: data.mime || 'audio/wav' })
        );
        const buffer = await decode(bytes);
        // Knowing the real length is the whole point of rendering ahead: the
        // planner can then place the sentence exactly instead of guessing
        // from a characters-per-second constant.
        return {
          url,
          buffer,
          duration: buffer ? buffer.duration : await measureUrl(url),
        };
      })().catch((err) => {
        // A transient server/network failure must be retryable. Keeping the
        // rejected promise here would permanently mute this sentence.
        cache.delete(k);
        throw err;
      });

      cache.set(k, task);
      // Keep the cache small; decoded buffers and blobs are a few hundred KB
      // each. Eviction is deliberately off the critical render path.
      evictOldest();
      return task;
    };

    const ready = async (settings) => {
      const prepared = await configure(settings);
      configuration = prepared.configuration;
      configurationKey = prepared.key;
      log(`${id} ready:`, prepared.info.name);
      return prepared.info;
    };

    const cancelAll = () => {
      if (playing) {
        try {
          if (playing.source) playing.source.stop();
          if (playing.audio) {
            playing.audio.pause();
            playing.audio.currentTime = 0;
          }
        } catch (_) {}
        playing = null;
      }
    };

    const playWithHtmlAudio = (entry, settle) => {
      const audio = new Audio(entry.url);
      audio.preservesPitch = true;
      audio.volume = 1;
      playing = { audio };

      let finished = false;
      const finish = (reason) => {
        if (finished) return;
        finished = true;
        if (playing && playing.audio === audio) playing = null;
        settle({ reason });
      };
      audio.onended = () => finish('end');
      audio.onerror = () => finish('error');
      audio.play().catch(() => finish('error'));
    };

    /**
     * A fresh HTMLAudioElement has a variable start-up delay. Decoded Web
     * Audio buffers start on the audio clock instead, which removes most of
     * the sentence-to-sentence jitter and permits tiny anti-click fades.
     */
    const playWithWebAudio = async (entry, settle, isCancelled) => {
      const context = getAudioContext();
      if (!context || !entry.buffer) return false;
      let source = null;
      let gain = null;
      try {
        if (context.state === 'suspended') await context.resume();
        if (isCancelled()) return true;
        if (context.state !== 'running') return false;

        source = context.createBufferSource();
        gain = context.createGain();
        source.buffer = entry.buffer;
        // Through the dub bus rather than straight to the destination, so
        // every sentence lands at the same perceived level.
        const target = getBus();
        source.connect(gain).connect(target ? target.input : context.destination);

        const now = context.currentTime;
        const startAt = now + 0.005;
        const endAt = startAt + entry.buffer.duration;
        const attack = Math.min(0.008, entry.buffer.duration / 4);
        const release = Math.min(0.012, entry.buffer.duration / 4);
        gain.gain.setValueAtTime(0, startAt);
        gain.gain.linearRampToValueAtTime(1, startAt + attack);
        gain.gain.setValueAtTime(1, Math.max(startAt + attack, endAt - release));
        gain.gain.linearRampToValueAtTime(0, endAt);

        let finished = false;
        const finish = (reason) => {
          if (finished) return;
          finished = true;
          if (playing && playing.source === source) playing = null;
          try {
            source.disconnect();
            gain.disconnect();
          } catch (_) {}
          settle({ reason });
        };
        source.onended = () => finish('end');
        playing = { source, gain };
        source.start(startAt);
        return true;
      } catch (err) {
        try {
          if (source) source.disconnect();
          if (gain) gain.disconnect();
        } catch (_) {}
        if (playing && playing.source === source) playing = null;
        warn('Web Audio playback failed; using HTML audio', err);
        return false;
      }
    };

    const speak = (text, { rate = 1, cueIndex } = {}) => {
      let settle;
      let cancelled = false;
      const promise = new Promise((resolve) => {
        settle = resolve;
      });

      (async () => {
        let entry;
        try {
          entry = await synthesise(text, rate, cueIndex);
        } catch (err) {
          warn(`${id} synthesis failed`, err);
          return settle({ reason: 'error', error: err });
        }
        if (cancelled) return settle({ reason: 'cancelled' });

        cancelAll();
        if (!(await playWithWebAudio(entry, settle, () => cancelled))) {
          if (cancelled) return settle({ reason: 'cancelled' });
          // A slice of a grouped render only ever exists as a decoded buffer,
          // so there is no blob URL to fall back to.
          if (!entry.url) return settle({ reason: 'error' });
          playWithHtmlAudio(entry, settle);
        }
      })();

      return {
        promise,
        cancel() {
          cancelled = true;
          cancelAll();
          settle({ reason: 'cancelled' });
        },
      };
    };

    return {
      id,
      exact: true, // durations are measured, not estimated
      ready,
      speak,
      cancelAll,
      /**
       * Hand the engine the whole cue list so it can render passages instead
       * of isolated sentences. Only engines that accept a grouped request use
       * it; the rest keep working exactly as before.
       */
      setScript: (cues, options = {}) => {
        const size = Math.max(1, Math.min(6, Number(options.groupSize) || 1));
        const maxGap = Number(options.maxGap) || 2.0;

        // The scheduler is rebuilt whenever the viewer changes speed, which
        // calls this again with the same script. Re-rendering the passages
        // then would cost real quota for no change at all.
        const signature = Array.isArray(cues)
          ? `${size}|${maxGap}|${cues.length}|${cues.map((cue) => cue.text).join('␟')}`
          : '';
        if (signature && signature === scriptSignature) return;
        scriptSignature = signature;

        groupRenders.clear();
        soloOnly.clear();
        grouping = false;
        script = null;
        groups = null;

        // Anything already rendered was rendered under the previous grouping
        // decision -- typically as isolated sentences, before the script was
        // known. Keeping those would silently exempt the opening of the video
        // from grouping, which is exactly where the listener forms their
        // impression, so drop them and let the passages be rendered properly.
        for (const task of cache.values()) {
          Promise.resolve(task)
            .then((entry) => {
              if (entry && entry.url) URL.revokeObjectURL(entry.url);
            })
            .catch(() => {});
        }
        cache.clear();

        if (typeof requestGroup !== 'function' || size < 2 || !Array.isArray(cues)) return;

        script = cues;
        groups = new Map();

        // Passages break where the dub itself would: a long silence in the
        // video, or a change of speaker. Grouping across either would make the
        // model read straight through a gap that is meant to be there.
        let members = [];
        let groupId = 0;

        const flush = () => {
          if (members.length > 1) {
            const group = { id: groupId++, members };
            for (const member of members) groups.set(member.index, group);
          }
          members = [];
        };

        cues.forEach((cue, index) => {
          const previous = members[members.length - 1];
          const gap = previous ? Number(cue.start) - Number(previous.end) : 0;
          const speakerChanged = previous && (previous.speaker || 0) !== (cue.speaker || 0);
          if (previous && (gap > maxGap || speakerChanged || members.length >= size)) flush();
          members.push({
            index,
            text: cue.text,
            start: Number(cue.start) || 0,
            end: Number(cue.end) || 0,
            emotion: cue.emotion || 'neutral',
            emphasis: Array.isArray(cue.emphasis) ? cue.emphasis : [],
            speaker: Number(cue.speaker) || 0,
          });
        });
        flush();

        grouping = groups.size > 0;
        if (grouping) log(`${id}: grouped ${groups.size} sentences into passages`);
      },
      prefetch: (text, { rate = 1, cueIndex } = {}) =>
        synthesise(text, rate, cueIndex).catch(() => {}),
      /** Preflight one sentence and surface failures to the engine selector. */
      warmup: (text, { rate = 1 } = {}) => synthesise(text, rate),
      /** Render ahead and report the exact playing time, or null on failure. */
      prepare: (text, { rate = 1, cueIndex } = {}) =>
        synthesise(text, rate, cueIndex).then(
          (entry) => (entry && entry.duration > 0 ? entry.duration : null),
          () => null
        ),
      pause: () => {
        if (playing && playing.audio) playing.audio.pause();
        if (playing && playing.source && audioContext) audioContext.suspend().catch(() => {});
      },
      resume: () => {
        if (playing && playing.audio) playing.audio.play().catch(() => {});
        if (playing && playing.source && audioContext) audioContext.resume().catch(() => {});
      },
    };
  };

  const piper = createRenderedEngine({
    id: 'piper',
    configure: async (settings) => {
      const endpoint = String(settings.localEndpoint || '').replace(/\/+$/, '');
      if (!endpoint) throw new Error('آدرس سرور محلی تنظیم نشده است');

      const health = await YD.bridge.send('localHealth', { endpoint });
      if (!health || !health.voices || !health.voices.length) {
        throw new Error('سرور محلی هیچ صدایی بارگذاری نکرده است');
      }
      const voice =
        (settings.piperVoice &&
          health.voices.find((item) => item.id === settings.piperVoice) &&
          settings.piperVoice) ||
        health.voices[0].id;
      return {
        configuration: { endpoint, voice },
        key: `${endpoint}|${voice}`,
        info: { name: `Piper · ${voice}`, lang: 'fa-IR' },
      };
    },
    request: (configuration, text, rate) =>
      YD.bridge.send('tts', {
        endpoint: configuration.endpoint,
        text,
        voice: configuration.voice,
        // Piper renders at the target tempo, which sounds better than
        // resampling the finished audio in the browser.
        lengthScale: 1 / clamp(rate, 0.5, 2),
      }),
  });

  const gemini = createRenderedEngine({
    id: 'gemini',
    configure: async (settings) => {
      const apiKey = String(settings.geminiApiKey || '').trim();
      if (!apiKey) throw new Error('برای صدای Gemini ابتدا کلید API را وارد کنید');

      const response = await YD.bridge.send('geminiTtsModels', { apiKey });
      const models = (response && response.models) || [];
      if (!models.length) throw new Error('این کلید به هیچ مدل گفتاری Gemini دسترسی ندارد');
      const requested = String(settings.geminiTtsModel || '');
      const model = models.some((item) => item.id === requested) ? requested : models[0].id;
      const voice = String(settings.geminiVoice || 'Kore');
      const style = String(settings.geminiTtsStyle || 'natural professional video dubbing');
      const multiSpeaker = settings.multiSpeaker !== false;
      return {
        configuration: { apiKey, model, voice, style, multiSpeaker },
        // Never put the secret itself in an in-memory cache key.
        key: `${model}|${voice}|${style}`,
        info: { name: `Gemini · ${voice}`, lang: 'fa-IR', model },
      };
    },
    request: (configuration, text, rate) =>
      YD.bridge.send('geminiTts', {
        text,
        rate,
        geminiApiKey: configuration.apiKey,
        geminiTtsModel: configuration.model,
        geminiVoice: configuration.voice,
        geminiTtsStyle: configuration.style,
      }),
    /**
     * One request for a whole passage. This is where the dub stops sounding
     * like a queue of separate sentences: read together, the model carries
     * the intonation across the line boundaries.
     */
    requestGroup: (configuration, lines, rate) =>
      YD.bridge.send('geminiTts', {
        lines,
        rate,
        multiSpeaker: configuration.multiSpeaker,
        geminiApiKey: configuration.apiKey,
        geminiTtsModel: configuration.model,
        geminiVoice: configuration.voice,
        geminiTtsStyle: configuration.style,
      }),
  });

  YD.tts = {
    webSpeech,
    piper,
    gemini,
    // Pure, and the riskiest logic in this file: exported so it can be tested
    // directly against synthetic renders.
    splitOnSilence,
    forSettings: (settings) =>
      settings.ttsEngine === 'gemini'
        ? gemini
        : settings.ttsEngine === 'piper'
          ? piper
          : webSpeech,
  };
})();
