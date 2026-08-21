/**
 * Service worker.
 *
 * Every cross-origin request lives here. Content scripts on youtube.com are
 * bound by the page's Content Security Policy, so a `fetch` to a translation
 * endpoint or to 127.0.0.1 from the content script would be refused; requests
 * made from the extension's own worker are not.
 */

'use strict';

/* -------------------------------------------------------------------- *
 * Small helpers
 * -------------------------------------------------------------------- */

const withTimeout = async (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** Run `worker` over `items` with bounded concurrency, order preserved. */
const pooled = async (items, limit, worker) => {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    })
  );
  return results;
};

const toBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

const fromBase64 = (value) => {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/** Wrap Gemini's raw 24 kHz mono PCM in a browser-decodable WAV container. */
const pcmToWav = (pcm, sampleRate = 24000) => {
  const channels = 1;
  const bitsPerSample = 16;
  const headerSize = 44;
  const wav = new Uint8Array(headerSize + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const ascii = (offset, value) => {
    for (let i = 0; i < value.length; i++) wav[offset + i] = value.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  view.setUint32(4, wav.byteLength - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // linear PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, headerSize);
  return wav;
};

const normaliseEndpoint = (value, fallback) =>
  String(value || fallback || '').trim().replace(/\/+$/, '');

/* -------------------------------------------------------------------- *
 * Translation providers
 * -------------------------------------------------------------------- */

/**
 * The endpoint behind the Google Translate widget. It needs no key and no
 * account, but it is not a documented API: it is rate limited per IP and can
 * change without notice. Failures here fall back to leaving the text as-is so
 * one bad sentence never kills a whole video.
 */
const translateGoogle = async (texts, from, to) => {
  const request = async (text) => {
    const url =
      'https://translate.googleapis.com/translate_a/single' +
      `?client=gtx&sl=${encodeURIComponent(from || 'auto')}` +
      `&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;

    const res = await withTimeout(fetch(url, { method: 'GET' }), 15000, 'translate');
    if (res.status === 429) throw new Error('rate-limited');
    if (!res.ok) throw new Error(`translate http ${res.status}`);

    const data = await res.json();
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('bad payload');
    return data[0].map((part) => (part && part[0]) || '').join('');
  };

  // Three attempts with a widening pause: a burst of parallel requests will
  // occasionally trip the rate limiter even at low concurrency.
  const attempt = async (text) => {
    let lastError;
    for (let i = 0; i < 3; i++) {
      try {
        return await request(text);
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 400 * (i + 1) + Math.random() * 300));
      }
    }
    console.warn('[dub] translation failed, keeping source text:', lastError);
    return text;
  };

  return pooled(texts, 4, attempt);
};

/* -------------------------------------------------------------------- *
 * Gemini
 * -------------------------------------------------------------------- */

const GEMINI_HOST = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * The key travels in a header, never in the query string: URLs end up in
 * browser history, proxy logs and error reports in a way headers do not.
 */
const geminiRequest = async (path, apiKey, body, timeout = 120000) => {
  const res = await withTimeout(
    fetch(`${GEMINI_HOST}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'x-goog-api-key': apiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    timeout,
    'gemini'
  );

  if (!res.ok) {
    let detail = '';
    try {
      const err = await res.json();
      detail = (err && err.error && err.error.message) || '';
    } catch (_) {
      /* not json */
    }
    if (
      [400, 401, 403].includes(res.status) &&
      /API key|authentication|credential|permission denied|reported as leaked/i.test(detail)
    ) {
      throw new Error('کلید API نامعتبر، مسدود یا فاقد دسترسی لازم است');
    }
    if (res.status === 429) throw new Error('rate-limited');
    throw new Error(`gemini http ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return res.json();
};

const LANGUAGE_NAMES = { fa: 'Persian (Farsi)', en: 'English' };

/**
 * The performance vocabulary shared by the translation pass (which chooses a
 * value per line) and the speech pass (which turns it into direction). Keeping
 * it a closed set is what makes it safe to interpolate into a TTS prompt: an
 * open string field would let model output steer the synthesiser.
 */
const EMOTIONS = [
  'neutral', 'warm', 'excited', 'serious', 'somber',
  'urgent', 'wry', 'tender', 'tense',
];

const EMOTION_DIRECTION = {
  neutral: 'an even, unforced delivery',
  warm: 'a warm, friendly delivery',
  excited: 'bright, energetic delivery with lifted pitch',
  serious: 'measured, weighty delivery',
  somber: 'quiet, subdued delivery',
  urgent: 'pressing, forward-leaning delivery',
  wry: 'dry, lightly amused delivery',
  tender: 'soft, gentle delivery',
  tense: 'tight, restrained delivery',
};

const normaliseEmotion = (value) => {
  const found = String(value || '').trim().toLowerCase();
  return EMOTIONS.includes(found) ? found : 'neutral';
};

/**
 * Keep only emphasis words that genuinely occur in the line.
 *
 * The model is asked to copy them verbatim, but a paraphrase slips through
 * often enough to matter -- and a stress instruction naming a word the voice
 * cannot find is worse than no instruction, because the synthesiser hunts for
 * it and distorts the surrounding phrase.
 */
const cleanEmphasis = (value, spoken) => {
  if (!Array.isArray(value)) return [];
  const haystack = String(spoken || '');
  const out = [];
  for (const item of value) {
    const word = String(item || '').trim();
    if (!word || word.length > 40) continue;
    if (!haystack.includes(word)) continue;
    if (out.includes(word)) continue;
    out.push(word);
    if (out.length === 3) break;
  }
  return out;
};

/**
 * Which models can this key actually call, best first.
 *
 * Google renames and retires model ids faster than a hard-coded default can
 * keep up, and a stale id fails with a 404 that reads like a network problem.
 * Asking the API is the only answer that stays correct.
 */
const fetchGeminiModels = async (apiKey) => {
  const data = await geminiRequest('models?pageSize=200', apiKey, null, 15000);
  return ((data && data.models) || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({
      id: String(m.name || '').replace(/^models\//, ''),
      label: m.displayName || '',
    }));
};

const sortGeminiModels = (models) => {
  const sorted = [...models];

  // Cheap and fast beats clever for sentence-level translation, so surface
  // the flash tier first, newest first.
  const score = (m) =>
    (/flash/i.test(m.id) ? 0 : /pro/i.test(m.id) ? 1 : 2) * 100 -
    parseFloat((m.id.match(/(\d+\.?\d*)/) || [])[1] || '0') * 10;
  sorted.sort((a, b) => score(a) - score(b));
  return sorted;
};

const listGeminiModels = async (apiKey) =>
  sortGeminiModels(
    (await fetchGeminiModels(apiKey)).filter(
      (m) => !/tts|embedding|imagen|image-generation|aqa/i.test(m.id)
    )
  );

const listGeminiTtsModels = async (apiKey) =>
  sortGeminiModels(
    (await fetchGeminiModels(apiKey)).filter((m) => /(?:^|-)tts(?:-|$)/i.test(m.id))
  );

const MODEL_MISSING = /not found|not supported|NOT_FOUND|is not available|404/i;

/**
 * Translate as a dubbing adapter rather than a translator.
 *
 * This is the one thing an LLM can do here that no translation API can: a dub
 * has to be *sayable in the time available*. A literal translation of an
 * English line is typically 20-30% longer in Persian, which is why everything
 * downstream has to compress speech and slow the picture. Given the number of
 * seconds each line actually has, the model can shorten the line itself --
 * which is exactly what human dubbing scripts do, and it fixes the problem at
 * the source instead of papering over it.
 */
const translateGemini = async (texts, from, to, { apiKey, model, durations, adapt }) => {
  if (!apiKey) throw new Error('کلید API جمینای وارد نشده است');

  const sourceName = LANGUAGE_NAMES[from] || from || 'the source language';
  const targetName = LANGUAGE_NAMES[to] || to;

  const persian = String(to || '').startsWith('fa');

  /**
   * The "spoken" field is the interesting half.
   *
   * Persian omits short vowels, so the speech engine has to guess: مرد is read
   * as either "mard" (man) or "mord" (died) from identical letters. Worse, and
   * far more common, is ezafe -- the linking -e in "کتابِ من" -- which is
   * almost never written and which espeak therefore drops from nearly every
   * noun phrase in the language. Measured on this voice, "این کتاب من است"
   * phonemises as "ketɑb man" without the mark and "ketɑbe man" with it.
   *
   * Only something that understands the sentence can place those marks, which
   * is why this is asked of the model rather than done with rules afterwards.
   * The unmarked translation is kept separately for display, because marked-up
   * text is unpleasant to read on screen.
   */
  /**
   * Persian-specific grammar.
   *
   * Machine translation of English into Persian tends to survive as English
   * wearing Persian words: the verb stranded in the middle of the clause where
   * English put it, subject pronouns spelled out that Persian carries in the
   * verb ending, "توسط" passives that no one says aloud, and idioms rendered
   * word by word. None of that is wrong enough to look like an error on the
   * page, but read out loud it is immediately foreign. Spelling the rules out
   * is worth the tokens.
   */
  const grammar = persian
    ? `\n\nPersian is not English with Persian words. Follow its grammar:\n` +
      `- Use natural contemporary Iranian Persian syntax. The neutral order is ` +
      `normally subject-object-verb, but do not force it where focus, dialogue ` +
      `or a subordinate clause calls for another natural order. Never mirror ` +
      `English syntax mechanically.\n` +
      `- Mark a specific direct object with را in standard register (or رو only ` +
      `when the speaker is consistently colloquial): «کتاب را خواندم», not ` +
      `«خواندم کتاب را». Do not add را to indefinite objects.\n` +
      `- Persian verbs already carry the person, so drop subject pronouns ` +
      `unless they are emphatic. «رفتم», not «من رفتم» every time.\n` +
      `- Prefer the active voice. The «توسطِ ...» passive is a translation ` +
      `artefact and sounds wrong spoken aloud.\n` +
      `- Translate idioms into Persian idioms, never word by word. If there ` +
      `is no equivalent, say the meaning plainly.\n` +
      `- Do not calque English function words. English "it is", "there is", ` +
      `"you can" usually disappear in natural Persian.\n` +
      `- Use Persian punctuation: ، ؛ ؟ and Persian quotation marks.\n` +
      `- Prefer concise, idiomatic Iranian Persian suitable for subtitles and ` +
      `speech. Match the speaker: conversational dialogue may be colloquial; ` +
      `technical or formal narration should remain standard and clear.\n` +
      `- Keep terminology consistent: once a term has a Persian rendering, ` +
      `use the same one for the rest of the passage.`
    : '';

  const pronunciation = persian
    ? `\n\nFor each line also give a "spoken" field: the same Persian, ` +
      `prepared to be read aloud by a speech synthesiser.\n` +
      `- Mark every ezafe with an explicit kasre: کتابِ من, خانهٔ بزرگ, ` +
      `مردمِ شهر. After ه use خانهٔ (or خانه‌ی), never an unmarked خانه بزرگ. ` +
      `This is the single most important item here; without it the ` +
      `synthesiser runs the words together with no linking vowel.\n` +
      `- Use a zero-width non-joiner in the right places: می‌رود, نمی‌دانم, ` +
      `کتاب‌ها, بزرگ‌تر. A plain space there is read as two separate words.\n` +
      `- Add short vowels (َ ِ ُ) only on words that would otherwise be ` +
      `ambiguous in this context, such as مُرد, شُکر, گِل, کِرم. Do not ` +
      `vocalise text that is already unambiguous; it does not help and makes ` +
      `mistakes more likely.\n` +
      `- Write numbers, dates and times out as Persian words.\n` +
      `- Write foreign names and unavoidable loanwords in Persian script as ` +
      `they are pronounced ` +
      `(software becomes نرم‌افزار or سافت‌وِر, never left in Latin letters).\n` +
      `- Expand abbreviations and acronyms into how they are said aloud.\n` +
      `- Do not add stage directions or bracketed emotion tags.\n` +
      `- Keep the lexical wording and meaning identical to the translation; ` +
      `only spelling, number expansion, diacritics and spacing may differ.`
    : '';

  /**
   * Direction: the half a translator never supplies and a dub cannot do without.
   *
   * A neural voice reads whatever it is given at one register for an entire
   * video, because nothing in the text tells it otherwise. That flatness is
   * what listeners hear as "machine", far more than any artefact in the voice
   * itself -- and it is the model reading the *source* line, in context, that
   * knows whether it was a joke, a warning or an aside.
   *
   * `speaker` is asked for on the same pass because the caption stream carries
   * the turn markers (">>", dashes, name prefixes) that get stripped before
   * speech, and once they are gone nothing downstream can recover who was
   * talking.
   */
  const direction =
    `\n\nAlso direct each line for the voice actor:\n` +
    `- "emotion": exactly one of neutral, warm, excited, serious, somber, ` +
    `urgent, wry, tender, tense. Judge it from the source line and what ` +
    `surrounds it. Most narration is neutral or warm; do not reach for a ` +
    `strong emotion unless the line genuinely carries one.\n` +
    `- "emphasis": zero to three words copied EXACTLY as they appear in your ` +
    `"spoken" field, which carry the sentence's stress. Leave the list empty ` +
    `when the line is evenly weighted. Never invent a word that is not there.\n` +
    `- "speaker": an integer turn id. Use 0 throughout for single-voice ` +
    `narration. Only when the source clearly alternates between people ` +
    `(">>" markers, dashes, interview question/answer, named prefixes) give ` +
    `each person a stable id: the same person must keep the same id for the ` +
    `whole passage, and the main narrator or interviewer stays 0.\n` +
    `- Strip any speaker name or ">>" marker out of the spoken text itself; ` +
    `it belongs in the id, not in what is read aloud.`;

  const system =
    `You are adapting a subtitle track into ${targetName} for a dub that is ` +
    `spoken over the original video.\n\n` +
    `Rules:\n` +
    `- Translate meaning, not words. Write ${targetName} that a native speaker ` +
    `would actually say out loud, not written prose.\n` +
    `- Keep the speaker's register and tone. Casual stays casual.\n` +
    `- Use the surrounding lines for context: pronouns, tense and terminology ` +
    `must stay consistent across the whole passage.\n` +
    (adapt
      ? `- Each line has a "seconds" budget: the time before the next line ` +
        `starts. Your ${targetName} must be sayable, unhurried, within that ` +
        `budget. Assume about 13 characters per second. If a literal ` +
        `translation would not fit, tighten it: drop filler, use a shorter ` +
        `synonym, merge clauses. Never drop information that matters.\n`
      : '') +
    `- Never add commentary, notes, transliteration or quotation marks.\n` +
    `- Return one entry per input id, with the same ids.` +
    grammar +
    pronunciation +
    direction;

  // The configured id is a starting guess. If the API says it does not exist,
  // find one that does and carry on with it rather than failing the whole
  // video over a name.
  let activeModel = model;
  let repaired = false;

  const repairModel = async (err) => {
    if (repaired || !MODEL_MISSING.test(err.message || '')) return false;
    repaired = true;
    let available;
    try {
      available = await listGeminiModels(apiKey);
    } catch (_) {
      return false;
    }
    if (!available.length) return false;
    console.warn(`[dub] model "${activeModel}" unavailable, switching to "${available[0].id}"`);
    activeModel = available[0].id;
    return true;
  };

  const translateBatch = async (batch, offset, previousContext = []) => {
    const payload = batch.map((text, i) => {
      const entry = { id: offset + i, text };
      if (adapt && durations && durations[offset + i] > 0) {
        entry.seconds = Math.round(durations[offset + i] * 10) / 10;
      }
      return entry;
    });

    // The current REST shape calls this responseFormat. Older Gemini models
    // used responseMimeType/responseSchema; retain a compatibility retry so a
    // user's still-valid older model choice does not break the entire video.
    const schema = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'The unchanged input id.' },
          translation: {
            type: 'string',
            description: 'Natural subtitle text for display, without pronunciation marks.',
          },
          ...(persian
            ? {
                spoken: {
                  type: 'string',
                  description:
                    'The same Persian wording prepared for TTS, with ezafe, necessary diacritics, correct ZWNJ and spoken-out numbers.',
                },
              }
            : {}),
          emotion: {
            type: 'string',
            enum: [...EMOTIONS],
            description: 'How this line should be performed.',
          },
          emphasis: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Up to three words, copied exactly from the spoken text, that carry the stress.',
          },
          speaker: {
            type: 'integer',
            description: 'Stable turn id; 0 for single-voice narration.',
          },
        },
        required: persian ? ['id', 'translation', 'spoken'] : ['id', 'translation'],
      },
    };
    const upperCaseTypes = (value) => {
      if (Array.isArray(value)) return value.map(upperCaseTypes);
      if (!value || typeof value !== 'object') return value;
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = key === 'type' && typeof item === 'string' ? item.toUpperCase() : upperCaseTypes(item);
      }
      return out;
    };
    const makeBody = (legacy = false) => ({
      systemInstruction: { parts: [{ text: system }] },
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                (previousContext.length
                  ? `Previous translated lines are context only. Keep terminology ` +
                    `and references consistent, but DO NOT return them:\n` +
                    JSON.stringify(previousContext, null, 1) +
                    `\n\n`
                  : '') +
                `Adapt these ${sourceName} subtitle lines into ${targetName}.\n\n` +
                JSON.stringify(payload, null, 1),
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        ...(legacy
          ? {
              responseMimeType: 'application/json',
              responseSchema: upperCaseTypes(schema),
            }
          : {
              responseFormat: {
                text: { mimeType: 'application/json', schema },
              },
            }),
      },
    });

    const request = (legacy) =>
      geminiRequest(
        `models/${encodeURIComponent(activeModel)}:generateContent`,
        apiKey,
        makeBody(legacy)
      );
    let data;
    let legacy = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        data = await request(legacy);
        break;
      } catch (err) {
        if (!legacy && /responseFormat|response_format/i.test(err.message || '')) {
          legacy = true;
          continue;
        }
        if (await repairModel(err)) continue;
        throw err;
      }
    }
    if (!data) throw new Error('gemini request failed');

    const candidate = data && data.candidates && data.candidates[0];
    if (!candidate) {
      const reason =
        (data && data.promptFeedback && data.promptFeedback.blockReason) || 'no candidate';
      throw new Error(`gemini returned nothing (${reason})`);
    }

    const raw =
      (candidate.content &&
        candidate.content.parts &&
        candidate.content.parts.map((p) => p.text || '').join('')) ||
      '';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      throw new Error('gemini response was not valid json');
    }
    if (!Array.isArray(parsed)) throw new Error('gemini response was not a list');

    const byId = new Map();
    for (const item of parsed) {
      if (item && Number.isInteger(item.id) && typeof item.translation === 'string') {
        const written = item.translation.trim();
        const spoken = typeof item.spoken === 'string' ? item.spoken.trim() : '';
        const speech = spoken || written;
        byId.set(item.id, {
          text: written,
          // Fall back to the written form if the model skipped this field, so
          // a missing pronunciation is never a missing line.
          spoken: speech,
          emotion: normaliseEmotion(item.emotion),
          emphasis: cleanEmphasis(item.emphasis, speech),
          speaker: Number.isInteger(item.speaker) ? Math.max(0, Math.min(3, item.speaker)) : 0,
        });
      }
    }

    return batch.map((_, i) => byId.get(offset + i) || null);
  };

  // Small enough that one rejected batch costs little, large enough that the
  // model still sees context around each line.
  const BATCH = 25;
  const out = new Array(texts.length);

  let batches = 0;
  let failedBatches = 0;
  let lastError = null;
  let previousContext = [];

  for (let start = 0; start < texts.length; start += BATCH) {
    const batch = texts.slice(start, start + BATCH);
    let done = null;
    batches++;

    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      try {
        done = await translateBatch(batch, start, previousContext);
      } catch (err) {
        lastError = err;
        const waitFor = /rate-limited/.test(err.message) ? 6000 : 1200;
        if (attempt === 2) {
          failedBatches++;
          console.warn('[dub] gemini batch failed:', err);
          done = batch.map(() => null);
          break;
        }
        await new Promise((r) => setTimeout(r, waitFor * (attempt + 1)));
      }
    }

    done.forEach((entry, i) => {
      out[start + i] =
        entry || {
          text: batch[i],
          spoken: batch[i],
          emotion: 'neutral',
          emphasis: [],
          speaker: 0,
        };
    });
    previousContext = batch
      .map((source, i) => ({ source, translation: done[i] && done[i].text }))
      .filter((entry) => entry.translation)
      .slice(-3);
  }

  // Returning the English quietly would leave the caller to guess. When
  // nothing at all came back, the reason is the useful thing to report -- and
  // this worker's console is a different console from the page's, so an error
  // logged here alone is effectively invisible.
  if (failedBatches === batches && lastError) {
    throw new Error(`Gemini: ${lastError.message}`);
  }
  if (failedBatches) {
    console.warn(`[dub] ${failedBatches}/${batches} gemini batches failed`);
  }

  return out.map((entry) => ({
    ...entry,
    provider: 'gemini',
    model: activeModel,
  }));
};

/* -------------------------------------------------------------------- *
 * Gemini speech generation
 * -------------------------------------------------------------------- */

const GEMINI_TTS_VOICES = new Set([
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
]);

/**
 * Voices for the secondary speakers in a multi-voice passage.
 *
 * Chosen to be clearly distinguishable from each other and from the default
 * narrator: an interview dubbed in one voice is intelligible but immediately
 * reads as machine output, and two voices that merely differ slightly are
 * worse than one, because the listener keeps trying to tell them apart.
 */
const SPEAKER_VOICES = ['Puck', 'Charon', 'Aoede'];

/** Pick a distinct voice per speaker id, keeping id 0 on the chosen voice. */
const voiceForSpeaker = (speaker, primary) => {
  if (!speaker) return primary;
  const pool = SPEAKER_VOICES.filter((name) => name !== primary);
  return pool[(speaker - 1) % pool.length] || primary;
};

/**
 * Turn one line's direction into a sentence a TTS model will act on.
 *
 * Everything interpolated here is either a closed-set value or a substring of
 * the line itself, so model output can never become an instruction.
 */
const performanceNote = (line) => {
  const parts = [];
  const emotion = normaliseEmotion(line && line.emotion);
  if (emotion !== 'neutral') parts.push(EMOTION_DIRECTION[emotion]);
  const emphasis = cleanEmphasis(line && line.emphasis, (line && line.text) || '');
  if (emphasis.length) {
    parts.push(`stress ${emphasis.map((word) => `«${word}»`).join(' and ')}`);
  }
  return parts.join('; ');
};

const synthesizeGeminiTts = async (
  text,
  { apiKey, model, voice, style, rate, lines, multiSpeaker }
) => {
  if (!apiKey) throw new Error('کلید API جمینای وارد نشده است');

  // A grouped render arrives as `lines`; a single sentence still arrives as
  // `text`. Normalising to one shape here keeps the request builder simple.
  const script = Array.isArray(lines) && lines.length
    ? lines
        .map((line, i) => ({
          index: i,
          text: String((line && line.text) || '').trim(),
          emotion: normaliseEmotion(line && line.emotion),
          emphasis: cleanEmphasis(line && line.emphasis, (line && line.text) || ''),
          speaker: Number.isInteger(line && line.speaker) ? line.speaker : 0,
        }))
        .filter((line) => line.text)
    : [{ index: 0, text: String(text || '').trim(), emotion: 'neutral', emphasis: [], speaker: 0 }];

  if (!script.length || !script[0].text) throw new Error('متن گفتار خالی است');

  let activeModel = String(model || 'gemini-3.1-flash-tts-preview');
  const activeVoice = GEMINI_TTS_VOICES.has(voice) ? voice : 'Kore';
  const safeStyle = String(style || 'natural')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 180);
  const speed = Math.max(0.7, Math.min(1.8, Number(rate) || 1));
  const pace =
    speed > 1.08
      ? `Speak about ${Math.round((speed - 1) * 100)} percent faster than a normal conversational pace, while remaining clear.`
      : speed < 0.92
        ? `Speak about ${Math.round((1 - speed) * 100)} percent slower than a normal conversational pace.`
        : 'Use a natural conversational pace.';

  // Only worth splitting voices when the passage actually alternates.
  const speakers = [...new Set(script.map((line) => line.speaker))].sort((a, b) => a - b);
  const useMultiSpeaker = multiSpeaker !== false && speakers.length > 1 && speakers.length <= 2;

  const speakerLabel = (id) => (id ? `GUEST${id}` : 'NARRATOR');

  /*
   * A grouped render is the point at which a dub stops sounding like a list of
   * sentences. Read one at a time, every line restarts its intonation from
   * neutral and dies away at the end, because the model has no idea another
   * one is coming. Given the whole passage it carries the contour across the
   * boundaries -- and the boundaries are still recoverable afterwards, because
   * the pause markers below are audible silence.
   */
  const grouped = script.length > 1;
  const transcript = grouped
    ? script
        .map((line) => {
          const note = performanceNote(line);
          const prefix = useMultiSpeaker ? `${speakerLabel(line.speaker)}: ` : '';
          return `${prefix}${note ? `(${note}) ` : ''}${line.text}`;
        })
        .join('\n\n')
    : (() => {
        const note = performanceNote(script[0]);
        return `${note ? `(${note}) ` : ''}${script[0].text}`;
      })();

  const prompt =
    `### DIRECTOR'S NOTES\n` +
    `Language and accent: Standard Iranian Persian (fa-IR), with native Iranian ` +
    `pronunciation; never use an Arabic or Tajik accent.\n` +
    `Performance: ${safeStyle || 'natural, warm and unobtrusive video dubbing'}.\n` +
    `Pacing: ${pace}\n` +
    (grouped
      ? `Continuity: this is one continuous passage. Carry the intonation ` +
        `across the lines instead of resetting on each one, and leave a clear ` +
        `pause of roughly half a second between them.\n`
      : '') +
    (useMultiSpeaker
      ? `Voices: lines are labelled by speaker. Give each speaker a consistent ` +
        `voice throughout and do not read the labels aloud.\n`
      : '') +
    `Direction: a note in parentheses before a line describes how to perform ` +
    `it. Follow it, and never read it aloud.\n` +
    `Accuracy: Read the transcript exactly. Respect Persian ezafe, short-vowel ` +
    `diacritics, half-spaces and punctuation. Do not translate, paraphrase, add ` +
    `an introduction, or speak these directions.\n\n` +
    `### TRANSCRIPT\n${transcript}`;

  const makeBody = () => ({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: useMultiSpeaker
        ? {
            multiSpeakerVoiceConfig: {
              speakerVoiceConfigs: speakers.map((id) => ({
                speaker: speakerLabel(id),
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: voiceForSpeaker(id, activeVoice) },
                },
              })),
            },
          }
        : {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: activeVoice },
            },
          },
    },
  });

  let data;
  try {
    data = await geminiRequest(
      `models/${encodeURIComponent(activeModel)}:generateContent`,
      apiKey,
      makeBody(),
      120000
    );
  } catch (err) {
    if (!MODEL_MISSING.test(err.message || '')) throw err;
    const available = await listGeminiTtsModels(apiKey);
    if (!available.length) throw new Error('این کلید به مدل گفتاری Gemini دسترسی ندارد');
    activeModel = available[0].id;
    data = await geminiRequest(
      `models/${encodeURIComponent(activeModel)}:generateContent`,
      apiKey,
      makeBody(),
      120000
    );
  }

  const candidate = data && data.candidates && data.candidates[0];
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  const audioPart = parts.find(
    (part) => part && part.inlineData && typeof part.inlineData.data === 'string'
  );
  if (!audioPart) {
    const reason =
      (data && data.promptFeedback && data.promptFeedback.blockReason) ||
      (candidate && candidate.finishReason) ||
      'no audio';
    throw new Error(`Gemini صدایی برنگرداند (${reason})`);
  }

  const mime = String(audioPart.inlineData.mimeType || 'audio/L16;rate=24000');
  const rateMatch = mime.match(/rate=(\d+)/i);
  const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
  const raw = fromBase64(audioPart.inlineData.data);

  // generateContent currently returns raw signed 16-bit mono PCM. A WAV
  // header makes it decodable by both Web Audio and HTMLAudioElement.
  const wav = /wav/i.test(mime) ? raw : pcmToWav(raw, sampleRate);
  return { audio: toBase64(wav.buffer), mime: 'audio/wav', model: activeModel };
};

const translateLibre = async (texts, from, to, { endpoint, apiKey }) => {
  const url = normaliseEndpoint(endpoint, 'http://127.0.0.1:5000/translate');
  const body = {
    q: texts,
    source: from || 'auto',
    target: to,
    format: 'text',
  };
  if (apiKey) body.api_key = apiKey;

  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    120000,
    'libretranslate'
  );
  if (!res.ok) throw new Error(`libretranslate http ${res.status}`);

  const data = await res.json();
  const out = data && data.translatedText;
  if (Array.isArray(out)) return out;
  // Some builds ignore array input and return a single string.
  if (typeof out === 'string' && texts.length === 1) return [out];
  throw new Error('unexpected libretranslate response');
};

const translateLocal = async (texts, from, to, { endpoint, durations }) => {
  const base = normaliseEndpoint(endpoint, 'http://127.0.0.1:8760');
  const res = await withTimeout(
    fetch(`${base}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts, durations, source: from, target: to }),
    }),
    180000,
    'local translate'
  );
  if (!res.ok) throw new Error(`local translate http ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data && data.translations)) throw new Error('bad local response');
  return data.translations;
};

/* -------------------------------------------------------------------- *
 * Message handlers
 * -------------------------------------------------------------------- */

const handlers = {
  async translate(payload) {
    const { texts, from, to, provider } = payload;
    if (!Array.isArray(texts) || !texts.length) return [];

    switch (provider) {
      case 'gemini':
        return translateGemini(texts, from, to, {
          apiKey: payload.geminiApiKey,
          model: payload.geminiModel || 'gemini-3.6-flash',
          durations: Array.isArray(payload.durations) ? payload.durations : null,
          adapt: payload.adaptToDuration !== false,
        });
      case 'libre':
        return translateLibre(texts, from, to, {
          endpoint: payload.libreEndpoint,
          apiKey: payload.libreApiKey,
        });
      case 'local':
        return translateLocal(texts, from, to, {
          endpoint: payload.localEndpoint,
          durations: Array.isArray(payload.durations) ? payload.durations : [],
        });
      case 'google':
      default:
        return translateGoogle(texts, from, to);
    }
  },

  async tts(payload) {
    const base = normaliseEndpoint(payload.endpoint, 'http://127.0.0.1:8760');
    const res = await withTimeout(
      fetch(`${base}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: payload.text,
          voice: payload.voice || '',
          length_scale: payload.lengthScale || 1,
        }),
      }),
      60000,
      'tts'
    );
    if (!res.ok) throw new Error(`tts http ${res.status}`);
    const buffer = await res.arrayBuffer();
    return {
      audio: toBase64(buffer),
      mime: res.headers.get('content-type') || 'audio/wav',
    };
  },

  async geminiTts(payload) {
    return synthesizeGeminiTts(payload.text, {
      apiKey: String(payload.geminiApiKey || ''),
      model: payload.geminiTtsModel,
      voice: payload.geminiVoice,
      style: payload.geminiTtsStyle,
      rate: payload.rate,
      lines: payload.lines,
      multiSpeaker: payload.multiSpeaker,
    });
  },

  /**
   * Second-pass compression.
   *
   * The first translation pass sizes each line against an assumed speaking
   * rate. Once the voice has actually rendered the passage we know the real
   * one, and the lines that still overrun are known individually -- so rather
   * than speeding those up (which is what a listener hears as "rushed"), ask
   * for a shorter wording of exactly those lines against their measured
   * budget. This is the order a dubbing studio works in: rewrite first, and
   * only then reach for the technical fixes.
   */
  async condense(payload) {
    const apiKey = String((payload && payload.geminiApiKey) || '');
    if (!apiKey) throw new Error('کلید API جمینای وارد نشده است');

    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) return { lines: [] };

    const target = String(payload.to || 'fa');
    const targetName = LANGUAGE_NAMES[target] || target;
    const persian = target.startsWith('fa');

    const system =
      `You are tightening lines of a ${targetName} dubbing script that run ` +
      `long. Each line comes with the seconds it has and roughly how many ` +
      `seconds it currently takes to say.\n\n` +
      `Rules:\n` +
      `- Shorten the wording so it fits the budget when spoken unhurried. ` +
      `Aim to lose about the stated overrun, no more.\n` +
      `- Keep every piece of information that matters. Cut filler, redundant ` +
      `qualifiers and repeated subjects; merge clauses; choose shorter ` +
      `synonyms. Never drop a fact, a number or a name.\n` +
      `- Keep the register, tone and terminology of the original line.\n` +
      `- It is better to return the line unchanged than to mangle it. If it ` +
      `cannot be shortened without losing meaning, return it as it is.\n` +
      (persian
        ? `- Natural spoken Iranian Persian. Drop subject pronouns the verb ` +
          `already carries, avoid «توسط» passives, keep Persian punctuation.\n` +
          `- Also return "spoken": the same shortened wording prepared for a ` +
          `speech synthesiser, with every ezafe marked by an explicit kasre ` +
          `(کتابِ من, خانهٔ بزرگ), correct zero-width non-joiners (می‌رود, ` +
          `کتاب‌ها), numbers written out as words, and short vowels only on ` +
          `genuinely ambiguous words.\n`
        : '') +
      `- Return one entry per input id, with the same ids.`;

    const schema = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'The unchanged input id.' },
          translation: { type: 'string', description: 'The shortened line for display.' },
          ...(persian
            ? { spoken: { type: 'string', description: 'The shortened line prepared for TTS.' } }
            : {}),
        },
        required: persian ? ['id', 'translation', 'spoken'] : ['id', 'translation'],
      },
    };

    const payloadItems = items.slice(0, 120).map((item, i) => ({
      id: Number.isInteger(item && item.id) ? item.id : i,
      text: String((item && item.text) || ''),
      seconds: Math.round(Number((item && item.seconds) || 0) * 10) / 10,
      currently: Math.round(Number((item && item.currently) || 0) * 10) / 10,
    }));

    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [
        {
          role: 'user',
          parts: [{ text: `Tighten these lines.\n\n${JSON.stringify(payloadItems, null, 1)}` }],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        responseFormat: { text: { mimeType: 'application/json', schema } },
      },
    };

    const model = String(payload.geminiModel || 'gemini-3.6-flash');
    const data = await geminiRequest(
      `models/${encodeURIComponent(model)}:generateContent`,
      apiKey,
      body
    );

    const candidate = data && data.candidates && data.candidates[0];
    const raw =
      (candidate &&
        candidate.content &&
        candidate.content.parts &&
        candidate.content.parts.map((p) => p.text || '').join('')) ||
      '';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      throw new Error('gemini response was not valid json');
    }
    if (!Array.isArray(parsed)) throw new Error('gemini response was not a list');

    return {
      lines: parsed
        .filter((item) => item && Number.isInteger(item.id) && typeof item.translation === 'string')
        .map((item) => ({
          id: item.id,
          text: item.translation.trim(),
          spoken:
            (typeof item.spoken === 'string' && item.spoken.trim()) || item.translation.trim(),
        })),
    };
  },

  async localHealth(payload) {
    const base = normaliseEndpoint(payload && payload.endpoint, 'http://127.0.0.1:8760');
    const res = await withTimeout(fetch(`${base}/health`), 6000, 'health');
    if (!res.ok) throw new Error(`health http ${res.status}`);
    return res.json();
  },

  /**
   * Ask the API which models this key can actually use.
   *
   * Model names churn faster than this extension will be updated, so the list
   * is fetched rather than hard-coded -- a stale hard-coded id fails with a
   * confusing 404 long after the code was written.
   */
  async geminiModels(payload) {
    const apiKey = String((payload && payload.apiKey) || '');
    if (!apiKey) throw new Error('کلید API وارد نشده است');
    return { models: await listGeminiModels(apiKey) };
  },

  /**
   * A model listing only proves that the key can enumerate models. Make one
   * real generateContent call so the options page can prove translation works
   * (quota, permissions, structured output and all) before a video starts.
   */
  async geminiProbe(payload) {
    const apiKey = String((payload && payload.apiKey) || '');
    if (!apiKey) throw new Error('کلید API وارد نشده است');
    const started = Date.now();
    const result = await translateGemini(
      ['This is a live Gemini API test.'],
      'en',
      'fa',
      {
        apiKey,
        model: String(payload.model || 'gemini-3.6-flash'),
        durations: [3],
        adapt: false,
      }
    );
    const item = result[0];
    if (!item || !item.text || item.text === 'This is a live Gemini API test.') {
      throw new Error('Gemini پاسخ ترجمهٔ معتبر برنگرداند');
    }
    return {
      provider: 'gemini',
      model: item.model,
      text: item.text,
      spoken: item.spoken,
      elapsedMs: Date.now() - started,
    };
  },

  async geminiTtsModels(payload) {
    const apiKey = String((payload && payload.apiKey) || '');
    if (!apiKey) throw new Error('کلید API وارد نشده است');
    return { models: await listGeminiTtsModels(apiKey) };
  },

  /**
   * Identify this worker so callers can tell a stale one from a broken one.
   *
   * An extension page is re-read from disk every time it opens, but the
   * service worker keeps running the code it was loaded with until the
   * extension is reloaded. So a freshly edited options page can be talking to
   * a worker that has never heard of the handler it is calling -- which
   * surfaces as an empty reply and looks, misleadingly, like a network fault.
   */
  async ping() {
    return {
      version: chrome.runtime.getManifest().version,
      handlers: Object.keys(handlers),
    };
  },

  async openOptions() {
    await chrome.runtime.openOptionsPage();
    return true;
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler =
    message && typeof message.type === 'string'
      ? Object.prototype.hasOwnProperty.call(handlers, message.type)
        ? handlers[message.type]
        : null
      : null;

  if (!handler) return false;

  Promise.resolve()
    .then(() => handler(message.payload || {}))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));

  return true; // keep the channel open for the async reply
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
