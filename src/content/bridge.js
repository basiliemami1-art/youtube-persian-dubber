/* Request/response bridge to the MAIN-world hook, plus the service worker. */
(() => {
  'use strict';

  const YD = (globalThis.YD = globalThis.YD || {});
  if (YD.bridge) return;

  const OUT = 'ytdub-iso';
  const IN = 'ytdub-main';

  const pending = new Map();
  let nextId = 1;

  /** Passive caption files the player fetched by itself, newest last. */
  const captures = [];
  const captureListeners = new Set();

  const captureMatches = (capture, wanted = {}) => {
    if (!capture || !capture.body) return false;
    let url;
    try {
      url = new URL(capture.url, location.origin);
    } catch (_) {
      return false;
    }

    const got = {
      languageCode: url.searchParams.get('lang') || '',
      kind: url.searchParams.get('kind') || '',
      tlang: url.searchParams.get('tlang') || '',
      videoId: url.searchParams.get('v') || '',
      vssId: url.searchParams.get('vssId') || '',
    };
    const same = (field) =>
      !wanted[field] ||
      !got[field] ||
      String(wanted[field]).toLowerCase() === String(got[field]).toLowerCase();

    // `tlang` is special: an absent value means the source track, so it must
    // match exactly or an English capture can masquerade as a Persian one.
    if (String(wanted.tlang || '').toLowerCase() !== got.tlang.toLowerCase()) return false;
    return (
      same('languageCode') &&
      same('kind') &&
      same('videoId') &&
      same('vssId')
    );
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== IN) return;

    if (msg.kind === 'reply') {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || 'main-world error'));
      return;
    }

    if (msg.kind === 'capture') {
      captures.push({ url: msg.url, body: msg.body, at: Date.now() });
      if (captures.length > 8) captures.shift();
      captureListeners.forEach((fn) => {
        try {
          fn(captures[captures.length - 1]);
        } catch (_) {
          /* listener must not break the bridge */
        }
      });
    }
  });

  const call = (kind, payload, timeout = 20000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`main-world call "${kind}" timed out`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ source: OUT, kind, id, payload }, location.origin);
    });

  /**
   * The MAIN hook posts `ready` at document_start, but we may miss it, so we
   * just retry `state` until the player object exists.
   */
  const waitForPlayer = async (timeout = 25000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        const state = await call('state', null, 3000);
        if (state && state.ready) return state;
      } catch (_) {
        /* hook not installed yet */
      }
      if (Date.now() > deadline) return null;
      await YD.util.sleep(300);
    }
  };

  /** Send a message to the service worker and unwrap the `{ok, ...}` envelope. */
  const send = async (type, payload) => {
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type, payload });
    } catch (err) {
      throw new Error(
        `ارتباط با افزونه قطع است (${err.message}). صفحه را تازه‌سازی کنید.`
      );
    }
    // An empty reply means no handler matched: the worker is running older
    // code than this page, which needs a reload rather than a retry.
    if (res === undefined) {
      throw new Error(
        `این نسخه از افزونه «${type}» را نمی‌شناسد. در chrome://extensions روی افزونه Reload بزنید.`
      );
    }
    if (!res.ok) throw new Error(res.error || 'background error');
    return res.data;
  };

  YD.bridge = {
    call,
    send,
    waitForPlayer,
    latestCapture: () => captures[captures.length - 1] || null,
    findCapture: (wanted) => {
      for (let i = captures.length - 1; i >= 0; i--) {
        if (captureMatches(captures[i], wanted)) return captures[i];
      }
      return null;
    },
    onCapture: (fn) => {
      captureListeners.add(fn);
      return () => captureListeners.delete(fn);
    },
  };
})();
