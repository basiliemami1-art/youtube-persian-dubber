/* Settings store, shared by the content script, popup and options page. */
(() => {
  'use strict';

  const YD = (globalThis.YD = globalThis.YD || {});
  if (YD.settings) return;

  const DEFAULTS = {
    /* --- general ------------------------------------------------------ */
    autoStart: false, // start dubbing as soon as a video opens
    sourceLang: 'en',
    targetLang: 'fa',
    showPanel: true,
    hotkey: true, // Shift+D toggles dubbing

    /* --- captions ----------------------------------------------------- */
    preferManualCaptions: true, // human captions beat auto-generated ones

    /* --- translation --------------------------------------------------
     * google  : rebuild whole sentences from the caption fragments first,
     *           then translate each complete sentence -- the default, because
     *           YouTube translates each fragment on its own with no context,
     *           and fragment-by-fragment Persian reads visibly choppier
     * youtube : the caption track YouTube translates itself. Official and
     *           never rate limited, and used automatically if the above fails
     * libre   : a LibreTranslate instance
     * local   : the bundled server/server.py (Ollama gives the best Persian
     *           of any of these, because it translates with context)
     */
    translator: 'gemini',

    // Gemini is the only provider here that can adapt a line to the time it
    // has instead of translating it literally. The key is stored in this
    // browser profile only and is sent to Google's API and nowhere else.
    geminiApiKey: '',
    geminiModel: 'gemini-3.6-flash',
    // Give the model each line's time budget and let it shorten what will not
    // fit. Turn off for a faithful, literal translation.
    adaptToDuration: true,
    // When Gemini is explicitly selected, do not disguise an API failure as
    // a successful run from another provider. The user may opt into fallback.
    geminiFallback: false,
    libreEndpoint: 'http://127.0.0.1:5000/translate',
    libreApiKey: '',
    localEndpoint: 'http://127.0.0.1:8760',
    cacheEnabled: true,

    /* --- speech -------------------------------------------------------
     * gemini    : Gemini's controllable neural TTS, using the same API key
     * piper     : neural offline voice served by server/server.py -- the
     *             default, because Windows does not ship a Persian voice on
     *             every build and speechSynthesis then has nothing to use
     * webspeech : the browser's own speechSynthesis
     *
     * Whichever is chosen, the other is tried automatically if it cannot
     * start, so a missing server or a missing system voice is not fatal.
     */
    ttsEngine: 'piper',
    voiceURI: '', // empty -> pick the first Persian voice
    piperVoice: '', // empty -> whatever the server loaded first
    geminiTtsModel: 'gemini-3.1-flash-tts-preview',
    geminiVoice: 'Kore',
    geminiTtsStyle: 'natural, warm, clear and unobtrusive professional video dubbing',
    pitch: 1.0,

    // Give secondary speakers their own voice when the translator reports a
    // change of speaker. Only used by the Gemini engine, and only where the
    // source actually alternates -- narration stays on one voice.
    multiSpeaker: true,

    // How many consecutive sentences to render in a single request. Reading a
    // passage as one piece is what keeps intonation continuous across the line
    // boundaries; the audio is split back apart on the silences between them.
    // 1 disables grouping. Above ~4 a mis-split costs too much to be worth it.
    groupSentences: 3,
    groupMaxGap: 2.0, // never group across a silence longer than this

    /* --- timing -------------------------------------------------------- */
    baseRate: 1.0, // speaking rate when there is room to spare
    minRate: 0.85,
    // Rate is the *last* resort, not the first. A line that does not fit is
    // rewritten shorter by the condense pass, and what remains is absorbed by
    // easing the picture; only what neither could handle is spoken faster.
    // Past roughly 1.2 Persian audibly stops sounding like someone talking.
    maxRate: 1.2,
    charsPerSecond: 12.5, // starting guess; measured or learned at runtime

    // Rewrite the lines that still overrun, using the speaking rate actually
    // measured from the chosen voice. Costs one extra Gemini call per video
    // and removes most of the need for the mechanisms below it.
    condensePass: true,

    // How far a sentence may sit from its caption time. This give is what lets
    // a long sentence borrow room from the pause around it instead of being
    // sped up, and it is the single biggest lever on how natural it feels.
    maxLead: 0.35, // may begin this early
    maxLag: 0.8, // may begin this late

    // How hard a late sentence works to give the delay back. 0 lets lag sit at
    // the ceiling for a whole dense passage; 1 tries to erase it in a single
    // sentence, which sounds rushed. Somewhere in the middle recovers within
    // two or three sentences without being noticeable.
    lagRecovery: 0.6,

    // Hard limit on how far behind a sentence may be before it is skipped
    // instead. Only reached where speech is so dense that no combination of
    // speed and easing can keep up; without it the backlog grows for the rest
    // of the video and every later sentence is wrong too.
    maxDrift: 2.5,

    /* --- mixing --------------------------------------------------------- */
    duckVolume: 0.15, // original audio level while the dub speaks

    // Asymmetric by design. The original must be out of the way before the
    // first syllable lands, so the attack is quick; bringing it back quickly
    // is what makes a dub sound switched on and off, so the release is slow.
    duckAttackMs: 60,
    duckReleaseMs: 260,

    // Do not restore the original for a gap shorter than this. Between two
    // sentences of a dense passage there is nothing worth hearing under it,
    // and ducking in and out across every gap pumps audibly.
    duckHoldSeconds: 1.2,

    /* --- overrun -------------------------------------------------------
     * When a sentence still does not fit after being sped up to `maxRate`:
     *
     * stretch  : ease the picture down a few percent for the length of that
     *            sentence -- continuous, and much less intrusive than a stop
     * compress : change nothing else; let the dub run a little late and let
     *            the next pause absorb it
     * pause    : freeze the picture until the sentence ends (exact sync, but
     *            the stutter is hard to ignore)
     */
    overrunPolicy: 'stretch',
    minPlaybackRate: 0.88, // floor for easing; 1 disables it entirely
    pauseMaxSeconds: 4, // only used by the 'pause' policy

    debug: false,
  };

  const get = async () => {
    const stored = await chrome.storage.local.get('settings');
    return Object.assign({}, DEFAULTS, stored.settings || {});
  };

  const set = async (patch) => {
    const current = await get();
    const next = Object.assign({}, current, patch);
    await chrome.storage.local.set({ settings: next });
    return next;
  };

  const onChange = (callback) => {
    const listener = (changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      callback(Object.assign({}, DEFAULTS, changes.settings.newValue || {}));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  };

  YD.settings = { DEFAULTS, get, set, onChange };
})();
