/* Shared helpers for the isolated-world content scripts. */
(() => {
  'use strict';

  const YD = (globalThis.YD = globalThis.YD || {});
  if (YD.util) return;

  const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Wait until `fn()` returns something truthy, or give up. */
  const waitFor = async (fn, { timeout = 20000, interval = 150 } = {}) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      let value;
      try {
        value = fn();
      } catch (_) {
        value = null;
      }
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(interval);
    }
  };

  /** Index of the last element whose `start` is <= t, or -1. */
  const lastIndexBefore = (cues, t) => {
    let lo = 0;
    let hi = cues.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };

  /** Cheap, stable, non-cryptographic hash used for cache keys. */
  const hash = (str) => {
    let h1 = 0x811c9dc5;
    let h2 = 0x1000193;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
    }
    return (h1.toString(36) + h2.toString(36)).slice(0, 14);
  };

  const normalizeSpace = (str) => String(str || '').replace(/\s+/g, ' ').trim();

  /**
   * Characters that actually cost time to pronounce. Persian short vowels are
   * usually unwritten, so raw length over-counts Latin text and under-counts
   * Persian -- close enough for scheduling once `charsPerSecond` is calibrated.
   */
  const spokenLength = (text) =>
    normalizeSpace(text).replace(/[^\p{L}\p{N}]/gu, '').length;

  /**
   * Is this text actually written in the target language's script?
   *
   * The dub pipeline has several places where a failure degrades to "return
   * the source text": a rate-limited endpoint, a rejected batch, a caption
   * track that was never translated. Each is survivable on its own, but the
   * end result is English being read aloud by a Persian voice over English
   * audio, which is worse than saying nothing. Checking the script is a crude
   * test, and that is exactly why it is reliable.
   */
  const SCRIPTS = {
    fa: /[؀-ۿ]/, // Arabic block, which Persian is written in
    ar: /[؀-ۿ]/,
    ru: /[Ѐ-ӿ]/,
    el: /[Ͱ-Ͽ]/,
    he: /[֐-׿]/,
    hi: /[ऀ-ॿ]/,
  };

  /** Fraction of letters that belong to the target script (1 if unknown). */
  const scriptRatio = (text, lang) => {
    const pattern = SCRIPTS[String(lang || '').slice(0, 2)];
    if (!pattern) return 1;

    const letters = String(text || '').match(/\p{L}/gu);
    if (!letters || !letters.length) return 1; // digits or symbols only
    let hits = 0;
    for (const ch of letters) if (pattern.test(ch)) hits++;
    return hits / letters.length;
  };

  /** A line counts as translated when most of its letters are in-script. */
  const isInLanguage = (text, lang) => scriptRatio(text, lang) >= 0.5;

  const log = (...args) => {
    if (YD.debug) console.log('%c[dub]', 'color:#7c5cff', ...args);
  };
  const warn = (...args) => console.warn('[dub]', ...args);

  /** Run `tasks` with bounded concurrency, preserving result order. */
  const pooled = async (items, limit, worker) => {
    const results = new Array(items.length);
    let cursor = 0;
    const runners = new Array(Math.min(limit, items.length))
      .fill(0)
      .map(async () => {
        for (;;) {
          const index = cursor++;
          if (index >= items.length) return;
          results[index] = await worker(items[index], index);
        }
      });
    await Promise.all(runners);
    return results;
  };

  YD.util = {
    clamp,
    sleep,
    waitFor,
    lastIndexBefore,
    hash,
    normalizeSpace,
    spokenLength,
    scriptRatio,
    isInLanguage,
    pooled,
    log,
    warn,
  };
})();
