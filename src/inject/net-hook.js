/**
 * MAIN-world bridge.
 *
 * Runs inside YouTube's own JavaScript context (not the isolated content-script
 * world), which buys us three things the isolated world cannot do:
 *   1. read `ytInitialPlayerResponse` / `movie_player.getPlayerResponse()`
 *   2. fetch the `/api/timedtext` caption URLs with the page's own credentials
 *      and referrer, so YouTube accepts them
 *   3. passively observe the caption tracks the player loads by itself
 *
 * It talks to the isolated world over `window.postMessage` only. It never
 * touches the network on its own initiative and never evaluates anything it
 * receives -- the only accepted commands are the fixed verbs in `handlers`.
 */
(() => {
  'use strict';

  const FLAG = '__YTDUB_MAIN_HOOK__';
  if (window[FLAG]) return;
  window[FLAG] = true;

  const OUT = 'ytdub-main';
  const IN = 'ytdub-iso';

  const post = (msg) => {
    try {
      window.postMessage(Object.assign({ source: OUT }, msg), location.origin);
    } catch (_) {
      /* ignore */
    }
  };

  /* ------------------------------------------------------------------ *
   * Passive capture of caption files the player fetches on its own.
   * Useful as a fallback when getPlayerResponse() is unavailable, and as
   * a signal that the user just switched the caption track.
   * ------------------------------------------------------------------ */

  const isTimedText = (url) =>
    typeof url === 'string' && url.indexOf('/api/timedtext') !== -1;

  const seenUrls = new Set();
  /** In-process listeners waiting for a specific track to arrive. */
  const captureWaiters = new Set();
  /** The viewer's own caption choice, remembered before we ever touch it. */
  let lastCaptionSelection;

  const reportCapture = (url, body) => {
    if (!body) return;

    captureWaiters.forEach((waiter) => {
      try {
        waiter(url, body);
      } catch (_) {
        /* a waiter must not break capture */
      }
    });

    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    if (seenUrls.size > 40) seenUrls.clear();
    post({ kind: 'capture', url, body });
  };

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      let url = '';
      try {
        const first = args[0];
        url = typeof first === 'string' ? first : (first && first.url) || '';
      } catch (_) {
        url = '';
      }
      const promise = nativeFetch.apply(this, args);
      if (isTimedText(url)) {
        promise
          .then((res) => {
            try {
              res
                .clone()
                .text()
                .then((body) => reportCapture(url, body))
                .catch(() => {});
            } catch (_) {
              /* body already consumed elsewhere */
            }
          })
          .catch(() => {});
      }
      return promise;
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (isTimedText(url)) {
        this.addEventListener('load', () => {
          try {
            if (typeof this.responseText === 'string') {
              reportCapture(String(url), this.responseText);
            }
          } catch (_) {
            /* responseType !== text */
          }
        });
      }
    } catch (_) {
      /* ignore */
    }
    return nativeOpen.call(this, method, url, ...rest);
  };

  /* ------------------------------------------------------------------ *
   * Player introspection
   * ------------------------------------------------------------------ */

  const getPlayer = () => {
    const el = document.getElementById('movie_player');
    return el && typeof el.getPlayerResponse === 'function' ? el : null;
  };

  const getPlayerResponse = () => {
    const player = getPlayer();
    if (player) {
      try {
        const res = player.getPlayerResponse();
        if (res && res.captions) return res;
        if (res) return res;
      } catch (_) {
        /* player not ready yet */
      }
    }
    if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
    return null;
  };

  const currentVideoId = () => {
    const player = getPlayer();
    if (player && typeof player.getVideoData === 'function') {
      try {
        const data = player.getVideoData();
        if (data && data.video_id) return data.video_id;
      } catch (_) {
        /* ignore */
      }
    }
    try {
      return new URL(location.href).searchParams.get('v') || '';
    } catch (_) {
      return '';
    }
  };

  /* ------------------------------------------------------------------ *
   * Command handlers. Every reply carries back the request id.
   * ------------------------------------------------------------------ */

  const handlers = {
    /** List the caption tracks and the languages YouTube can auto-translate to. */
    tracks() {
      const response = getPlayerResponse();
      const renderer =
        (response &&
          response.captions &&
          response.captions.playerCaptionsTracklistRenderer) ||
        null;

      const tracks = ((renderer && renderer.captionTracks) || []).map((t) => ({
        baseUrl: t.baseUrl || '',
        languageCode: t.languageCode || '',
        name: (t.name && (t.name.simpleText || textFromRuns(t.name))) || '',
        kind: t.kind || '', // 'asr' for auto-generated
        vssId: t.vssId || '',
        isTranslatable: t.isTranslatable !== false,
      }));

      const translationLanguages = (
        (renderer && renderer.translationLanguages) ||
        []
      ).map((l) => ({
        code: l.languageCode || '',
        name:
          (l.languageName &&
            (l.languageName.simpleText || textFromRuns(l.languageName))) ||
          '',
      }));

      return {
        videoId: currentVideoId(),
        tracks,
        translationLanguages,
        durationSeconds: Number(
          (response &&
            response.videoDetails &&
            response.videoDetails.lengthSeconds) ||
            0
        ),
        title:
          (response && response.videoDetails && response.videoDetails.title) ||
          '',
      };
    },

    /**
     * Fetch a caption track from the page context.
     * Only URLs on youtube.com/api/timedtext are allowed, so a compromised
     * isolated world cannot turn this into a generic SSRF-style proxy.
     */
    async fetchTrack(payload) {
      const raw = String((payload && payload.url) || '');
      let url;
      try {
        url = new URL(raw, location.origin);
      } catch (_) {
        throw new Error('invalid url');
      }
      if (
        !/(^|\.)youtube\.com$/.test(url.hostname) ||
        url.pathname !== '/api/timedtext'
      ) {
        throw new Error('url not allowed');
      }

      if (payload && payload.tlang) url.searchParams.set('tlang', String(payload.tlang));
      url.searchParams.set('fmt', 'json3');

      const res = await fetch(url.toString(), {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('http ' + res.status);
      const body = await res.text();
      return { url: url.toString(), body };
    },

    /**
     * Make the player load a caption track and hand back the body it receives.
     *
     * This exists because YouTube's caption URLs are effectively single-use:
     * refetching the exact `baseUrl` the player response advertises -- even the
     * one the player itself just used -- answers 200 with an empty body. The
     * data can only be read by listening to the player's own request.
     *
     * Setting `translationLanguage` on the track is also how YouTube's own
     * auto-translate works, so this doubles as the free translation path: the
     * captured body comes back already in the target language.
     *
     * The user's caption selection is restored once the body is in hand.
     */
    primeTrack(payload) {
      const player = getPlayer();
      if (!player || typeof player.setOption !== 'function') {
        return Promise.reject(new Error('player has no caption API'));
      }

      const languageCode = String((payload && payload.languageCode) || 'en');
      const kind = String((payload && payload.kind) || '');
      const vssId = String((payload && payload.vssId) || '');
      const videoId = String((payload && payload.videoId) || currentVideoId());
      const tlang = payload && payload.tlang ? String(payload.tlang) : '';
      const timeout = Number((payload && payload.timeout) || 12000);

      let previous = null;
      try {
        previous = player.getOption('captions', 'track');
      } catch (_) {
        previous = null;
      }
      // Remember it outside this call so a later teardown can still undo the
      // change even if this promise never settles.
      if (lastCaptionSelection === undefined) lastCaptionSelection = previous;

      const track = { languageCode, kind };
      if (tlang) track.translationLanguage = { languageCode: tlang };

      return new Promise((resolve, reject) => {
        let settled = false;

        /**
         * Put the viewer's captions back the way they were.
         *
         * Restoring once is not enough. The body arrives while the player is
         * still finishing the track switch we asked for, so a single restore
         * lands mid-flight and the player then re-applies the track it was
         * loading -- leaving translated subtitles burnt across the picture,
         * showing a *different* translation from the one being spoken. Re-assert
         * a few times over the next second so the last word is ours.
         */
        const restoreCaptions = () => {
          const apply = () => {
            try {
              player.setOption('captions', 'track', previous || {});
            } catch (_) {
              /* player torn down */
            }
          };
          apply();
          setTimeout(apply, 250);
          setTimeout(apply, 800);
          setTimeout(apply, 1800);
        };

        const cleanup = () => {
          captureWaiters.delete(waiter);
          clearTimeout(timer);
          restoreCaptions();
        };

        const waiter = (url, body) => {
          if (settled) return;
          let params;
          try {
            params = new URL(url, location.origin).searchParams;
          } catch (_) {
            return;
          }
          const gotTlang = params.get('tlang') || '';
          const gotLanguage = params.get('lang') || '';
          const gotKind = params.get('kind') || '';
          const gotVssId = params.get('vssId') || '';
          const gotVideoId = params.get('v') || '';
          const same = (wanted, got) =>
            !wanted || !got || wanted.toLowerCase() === got.toLowerCase();

          // Make sure this is the exact track we asked for and not another
          // subtitle request still in flight. `tlang` is intentionally strict:
          // an absent value is the source track, never a translated one.
          if (gotTlang.toLowerCase() !== tlang.toLowerCase()) return;
          if (!same(languageCode, gotLanguage)) return;
          if (!same(kind, gotKind)) return;
          if (!same(vssId, gotVssId)) return;
          if (!same(videoId, gotVideoId)) return;
          if (!body || !body.trim()) return;

          settled = true;
          cleanup();
          resolve({ url, body });
        };

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error('player did not load the caption track in time'));
        }, timeout);

        captureWaiters.add(waiter);

        try {
          if (typeof player.loadModule === 'function') player.loadModule('captions');
        } catch (_) {
          /* already loaded */
        }

        // Clearing the selection first is not optional: asking for the track
        // that is already active is a no-op, the player answers from its own
        // cache and no request ever reaches the network -- so nothing would be
        // captured and this would sit here until it timed out.
        try {
          player.setOption('captions', 'track', {});
        } catch (_) {
          /* ignore */
        }

        setTimeout(() => {
          if (settled) return;
          try {
            player.setOption('captions', 'track', track);
          } catch (err) {
            settled = true;
            cleanup();
            reject(err);
          }
        }, 350);
      });
    },

    /**
     * Force the caption display back to whatever it was before priming.
     *
     * A belt to the braces above: if a run is stopped, errors out, or the
     * player rebuilds itself mid-switch, this guarantees the viewer is not
     * left with subtitles they did not ask for.
     */
    restoreCaptions() {
      const player = getPlayer();
      if (!player || typeof player.setOption !== 'function') return false;
      if (lastCaptionSelection === undefined) return false;
      try {
        player.setOption('captions', 'track', lastCaptionSelection || {});
      } catch (_) {
        return false;
      }
      return true;
    },

    /** Languages YouTube will auto-translate this video's captions into. */
    translationLanguages() {
      const player = getPlayer();
      try {
        return (player.getOption('captions', 'translationLanguages') || []).map((l) => ({
          code: l.languageCode || '',
          name:
            (l.languageName && (l.languageName.simpleText || l.languageName)) || '',
        }));
      } catch (_) {
        return [];
      }
    },

    /** Current playback state, used to detect ads and player readiness. */
    state() {
      const player = getPlayer();
      let adPlaying = false;
      try {
        adPlaying = !!(
          document.querySelector('.ad-showing') ||
          document.querySelector('.ytp-ad-player-overlay')
        );
      } catch (_) {
        /* ignore */
      }
      return {
        videoId: currentVideoId(),
        ready: !!player,
        adPlaying,
        state:
          player && typeof player.getPlayerState === 'function'
            ? player.getPlayerState()
            : -1,
      };
    },
  };

  function textFromRuns(node) {
    if (!node || !Array.isArray(node.runs)) return '';
    return node.runs.map((r) => r.text || '').join('');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== IN || typeof msg.kind !== 'string') return;

    const handler = Object.prototype.hasOwnProperty.call(handlers, msg.kind)
      ? handlers[msg.kind]
      : null;
    if (!handler) return;

    Promise.resolve()
      .then(() => handler(msg.payload))
      .then((result) => post({ kind: 'reply', id: msg.id, ok: true, result }))
      .catch((err) =>
        post({
          kind: 'reply',
          id: msg.id,
          ok: false,
          error: String((err && err.message) || err),
        })
      );
  });

  post({ kind: 'ready' });
})();
