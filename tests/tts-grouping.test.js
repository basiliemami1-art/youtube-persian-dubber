/**
 * Grouping: which sentences get rendered together.
 *
 * The passage boundaries decide how the dub sounds. Group too eagerly and the
 * model reads straight through a silence that was meant to be there, or gives
 * two people one voice; group too timidly and every line restarts its
 * intonation from neutral, which is the flatness grouping exists to fix.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SAMPLE_RATE = 24000;

/**
 * A real Gemini-shaped WAV: two seconds of tone per line, separated by half a
 * second of silence, so the splitter has something genuine to cut.
 */
const makeWav = (parts) => {
  const spans = [];
  parts.forEach((_, i) => {
    if (i) spans.push(0.5);
    spans.push(1.0);
  });
  const total = spans.reduce((a, b) => a + b, 0);
  const samples = Math.round(total * SAMPLE_RATE);
  const pcm = Buffer.alloc(samples * 2);

  let cursor = 0;
  spans.forEach((seconds, index) => {
    const n = Math.round(seconds * SAMPLE_RATE);
    const speech = index % 2 === 0;
    for (let i = 0; i < n && cursor < samples; i++, cursor++) {
      const value = speech
        ? Math.round(Math.sin((2 * Math.PI * 180 * cursor) / SAMPLE_RATE) * 12000)
        : 0;
      pcm.writeInt16LE(value, cursor * 2);
    }
  });
  return pcm;
};

/* ------------------------------------------------------------------ *
 * Browser stand-ins
 * ------------------------------------------------------------------ */

const decodedBuffers = [];

/** Decode our synthetic WAV/PCM into the AudioBuffer shape tts.js expects. */
const decodePcm = (arrayBuffer) => {
  const view = Buffer.from(arrayBuffer);
  // Skip the WAV header the worker would normally have added.
  const body = view.length > 44 ? view.subarray(44) : view;
  const length = Math.floor(body.length / 2);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = body.readInt16LE(i * 2) / 32768;
  const buffer = {
    sampleRate: SAMPLE_RATE,
    length,
    duration: length / SAMPLE_RATE,
    numberOfChannels: 1,
    getChannelData: () => data,
  };
  decodedBuffers.push(buffer);
  return buffer;
};

const makeContext = () => {
  const requests = [];

  const audioContext = {
    state: 'running',
    currentTime: 0,
    destination: {},
    decodeAudioData: async (arrayBuffer) => decodePcm(arrayBuffer),
    createBuffer: (channels, length, sampleRate) => {
      const data = new Float32Array(length);
      return {
        sampleRate,
        length,
        duration: length / sampleRate,
        numberOfChannels: channels,
        getChannelData: () => data,
      };
    },
    createGain: () => ({ gain: { value: 1 }, connect: (n) => n, disconnect() {} }),
    createBiquadFilter: () => ({
      type: '',
      frequency: { value: 0 },
      Q: { value: 0 },
      connect: (n) => n,
      disconnect() {},
    }),
    createDynamicsCompressor: () => ({
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
      connect: (n) => n,
      disconnect() {},
    }),
    createBufferSource: () => ({
      buffer: null,
      connect: (n) => n,
      disconnect() {},
      start() {},
      stop() {},
    }),
    resume: async () => {},
    suspend: async () => {},
  };

  const context = {
    console,
    setTimeout,
    clearTimeout,
    performance,
    Float32Array,
    Uint8Array,
    Promise,
    Map,
    Set,
    Math,
    JSON,
    Number,
    String,
    Array,
    Object,
    Error,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
    Blob: function Blob(parts) {
      this.parts = parts;
    },
    Audio: function Audio() {},
    AudioContext: function AudioContext() {
      return audioContext;
    },
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    speechSynthesis: {
      getVoices: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      cancel: () => {},
    },
    SpeechSynthesisUtterance: function SpeechSynthesisUtterance() {},
    __requests: requests,
  };
  context.globalThis = context;
  vm.createContext(context);

  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'util.js'), 'utf8'),
    context
  );

  // A bridge that records what the engine asked the worker for, and answers
  // with audio matching the number of lines requested.
  vm.runInContext(
    `globalThis.YD.bridge = {
       send: async (type, payload) => {
         globalThis.__requests.push({ type, payload });
         if (type === 'geminiTtsModels') {
           return { models: [{ id: 'gemini-3.1-flash-tts-preview' }] };
         }
         const count = payload.lines ? payload.lines.length : 1;
         return { audio: globalThis.__makeAudio(count), mime: 'audio/wav' };
       },
     };`,
    context
  );
  context.__makeAudio = (count) => makeWav(new Array(count).fill(0)).toString('base64');

  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'tts.js'), 'utf8'),
    context
  );

  return { context, requests };
};

const cue = (index, text, extra = {}) => ({
  index,
  text,
  start: index * 3,
  end: index * 3 + 2,
  emotion: 'neutral',
  emphasis: [],
  speaker: 0,
  ...extra,
});

const readySettings = {
  geminiApiKey: 'k',
  geminiTtsModel: 'gemini-3.1-flash-tts-preview',
  geminiVoice: 'Kore',
  geminiTtsStyle: 'natural',
  multiSpeaker: true,
};

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test('one request covers a whole passage instead of one per sentence', async () => {
  const { context, requests } = makeContext();
  const gemini = context.YD.tts.gemini;
  await gemini.ready(readySettings);

  const cues = [cue(0, 'جملهٔ اول.'), cue(1, 'جملهٔ دوم.'), cue(2, 'جملهٔ سوم.')];
  gemini.setScript(cues, { groupSize: 3, maxGap: 2.0 });

  requests.length = 0;
  await gemini.prepare(cues[0].text, { rate: 1, cueIndex: 0 });

  const tts = requests.filter((r) => r.type === 'geminiTts');
  assert.equal(tts.length, 1, 'a single grouped request');
  assert.equal(tts[0].payload.lines.length, 3, 'carrying all three sentences');

  // The other two sentences are now already rendered: asking for them must
  // not produce further requests.
  requests.length = 0;
  await gemini.prepare(cues[1].text, { rate: 1, cueIndex: 1 });
  await gemini.prepare(cues[2].text, { rate: 1, cueIndex: 2 });
  assert.equal(
    requests.filter((r) => r.type === 'geminiTts').length,
    0,
    'the rest of the passage came from the same render'
  );
});

test('measured durations come from the split, not the whole passage', async () => {
  const { context } = makeContext();
  const gemini = context.YD.tts.gemini;
  await gemini.ready(readySettings);

  const cues = [cue(0, 'یک.'), cue(1, 'دو.')];
  gemini.setScript(cues, { groupSize: 2, maxGap: 2.0 });

  const first = await gemini.prepare(cues[0].text, { rate: 1, cueIndex: 0 });
  const second = await gemini.prepare(cues[1].text, { rate: 1, cueIndex: 1 });

  // The render is 2 x 1.0s of speech plus 0.5s of silence. Each sentence must
  // report about its own second, not the 2.5s total -- otherwise the planner
  // would place every sentence far too late.
  assert.ok(first > 0.5 && first < 1.6, `first sentence measured ${first}`);
  assert.ok(second > 0.5 && second < 1.6, `second sentence measured ${second}`);
});

test('never groups across a long silence in the video', async () => {
  const { context, requests } = makeContext();
  const gemini = context.YD.tts.gemini;
  await gemini.ready(readySettings);

  // A ten-second gap between cue 0 and cue 1: reading through it would put
  // the second sentence far ahead of where it belongs.
  const cues = [
    { ...cue(0, 'قبل از مکث.'), start: 0, end: 2 },
    { ...cue(1, 'بعد از مکث.'), start: 12, end: 14 },
  ];
  gemini.setScript(cues, { groupSize: 3, maxGap: 2.0 });

  requests.length = 0;
  await gemini.prepare(cues[0].text, { rate: 1, cueIndex: 0 });
  const tts = requests.filter((r) => r.type === 'geminiTts');
  assert.equal(tts.length, 1);
  assert.ok(!tts[0].payload.lines, 'rendered on its own, not as a passage');
});

test('never groups across a change of speaker', async () => {
  const { context, requests } = makeContext();
  const gemini = context.YD.tts.gemini;
  await gemini.ready(readySettings);

  const cues = [cue(0, 'سؤال؟', { speaker: 0 }), cue(1, 'جواب.', { speaker: 1 })];
  gemini.setScript(cues, { groupSize: 3, maxGap: 2.0 });

  requests.length = 0;
  await gemini.prepare(cues[0].text, { rate: 1, cueIndex: 0 });
  const tts = requests.filter((r) => r.type === 'geminiTts');
  assert.ok(!tts[0].payload.lines, 'each speaker is rendered separately');
});

test('grouping off renders one sentence at a time', async () => {
  const { context, requests } = makeContext();
  const gemini = context.YD.tts.gemini;
  await gemini.ready(readySettings);

  const cues = [cue(0, 'یک.'), cue(1, 'دو.')];
  gemini.setScript(cues, { groupSize: 1, maxGap: 2.0 });

  requests.length = 0;
  await gemini.prepare(cues[0].text, { rate: 1, cueIndex: 0 });
  await gemini.prepare(cues[1].text, { rate: 1, cueIndex: 1 });

  const tts = requests.filter((r) => r.type === 'geminiTts');
  assert.equal(tts.length, 2);
  assert.ok(tts.every((r) => !r.payload.lines));
});

test('re-applying the same script does not re-render it', async () => {
  const { context, requests } = makeContext();
  const gemini = context.YD.tts.gemini;
  await gemini.ready(readySettings);

  const cues = [cue(0, 'یک.'), cue(1, 'دو.')];
  gemini.setScript(cues, { groupSize: 2, maxGap: 2.0 });
  await gemini.prepare(cues[0].text, { rate: 1, cueIndex: 0 });

  // The scheduler is rebuilt on every speed change and re-applies the script.
  requests.length = 0;
  gemini.setScript(cues, { groupSize: 2, maxGap: 2.0 });
  await gemini.prepare(cues[0].text, { rate: 1, cueIndex: 0 });

  assert.equal(
    requests.filter((r) => r.type === 'geminiTts').length,
    0,
    'the cached passage survived an identical re-apply'
  );
});

test('a genuinely different script does re-render', async () => {
  const { context, requests } = makeContext();
  const gemini = context.YD.tts.gemini;
  await gemini.ready(readySettings);

  const first = [cue(0, 'یک.'), cue(1, 'دو.')];
  gemini.setScript(first, { groupSize: 2, maxGap: 2.0 });
  await gemini.prepare(first[0].text, { rate: 1, cueIndex: 0 });

  // The condense pass rewrites lines; that new script must not be served from
  // audio rendered for the old wording.
  const second = [cue(0, 'یک کوتاه‌تر.'), cue(1, 'دو.')];
  requests.length = 0;
  gemini.setScript(second, { groupSize: 2, maxGap: 2.0 });
  await gemini.prepare(second[0].text, { rate: 1, cueIndex: 0 });

  assert.ok(
    requests.filter((r) => r.type === 'geminiTts').length > 0,
    'rewritten lines are rendered again'
  );
});

test('falls back to single sentences when a passage will not split', async () => {
  const { context, requests } = makeContext();
  const gemini = context.YD.tts.gemini;
  await gemini.ready(readySettings);

  // Answer a 3-line request with audio containing only one block of speech,
  // as though the model ran the sentences together.
  context.__makeAudio = () => makeWav([0]).toString('base64');

  const cues = [cue(0, 'یک.'), cue(1, 'دو.'), cue(2, 'سه.')];
  gemini.setScript(cues, { groupSize: 3, maxGap: 2.0 });

  requests.length = 0;
  const duration = await gemini.prepare(cues[0].text, { rate: 1, cueIndex: 0 });

  const tts = requests.filter((r) => r.type === 'geminiTts');
  assert.ok(tts.length >= 2, 'the grouped attempt was followed by a solo render');
  assert.ok(!tts[tts.length - 1].payload.lines, 'the retry was for one sentence');
  assert.ok(duration > 0, 'the sentence still ends up with usable audio');

  // And the passage is not retried for its other members.
  requests.length = 0;
  await gemini.prepare(cues[1].text, { rate: 1, cueIndex: 1 });
  const retry = requests.filter((r) => r.type === 'geminiTts');
  assert.equal(retry.length, 1);
  assert.ok(!retry[0].payload.lines, 'the bad passage is not attempted again');
});
