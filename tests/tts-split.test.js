/**
 * The grouped-render splitter.
 *
 * Rendering several sentences in one request is what keeps the intonation
 * continuous across them, but the scheduler still places sentences one at a
 * time, so the audio has to come back apart on the silences between them. A
 * bad split is the worst failure this pipeline has -- every later sentence
 * lands in the wrong place -- so the splitter is required to *refuse* far more
 * often than it is required to succeed.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

/* ------------------------------------------------------------------ *
 * Enough of a browser for tts.js to load
 * ------------------------------------------------------------------ */

const SAMPLE_RATE = 24000;

/** A minimal stand-in for the AudioBuffer interface the splitter touches. */
const makeBuffer = (channelData, sampleRate = SAMPLE_RATE) => ({
  sampleRate,
  length: channelData.length,
  duration: channelData.length / sampleRate,
  numberOfChannels: 1,
  getChannelData: () => channelData,
});

/**
 * Build a render: alternating speech and silence.
 *
 * @param {number[]} spans seconds, speech first, then alternating
 */
const makeRender = (spans, { amplitude = 0.5, noise = 0.001 } = {}) => {
  const total = spans.reduce((sum, s) => sum + s, 0);
  const data = new Float32Array(Math.round(total * SAMPLE_RATE));
  let cursor = 0;
  spans.forEach((seconds, index) => {
    const samples = Math.round(seconds * SAMPLE_RATE);
    const speech = index % 2 === 0;
    for (let i = 0; i < samples && cursor < data.length; i++, cursor++) {
      data[cursor] = speech
        ? Math.sin((2 * Math.PI * 180 * cursor) / SAMPLE_RATE) * amplitude
        : (Math.random() - 0.5) * noise;
    }
  });
  return makeBuffer(data);
};

const context = {
  console,
  setTimeout,
  clearTimeout,
  performance,
  Float32Array,
  Uint8Array,
  Math,
  URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
  Blob: function Blob() {},
  Audio: function Audio() {},
  atob: (value) => Buffer.from(value, 'base64').toString('binary'),
  btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  speechSynthesis: {
    getVoices: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    cancel: () => {},
  },
  SpeechSynthesisUtterance: function SpeechSynthesisUtterance() {},
};
context.globalThis = context;
vm.createContext(context);

// tts.js expects the shared helpers to already be on YD.
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'util.js'), 'utf8'),
  context
);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'tts.js'), 'utf8'),
  context
);

const { splitOnSilence } = context.YD.tts;

/* ------------------------------------------------------------------ *
 * Splitting
 * ------------------------------------------------------------------ */

test('splits a clean three-sentence render on its pauses', () => {
  // speech, pause, speech, pause, speech
  const buffer = makeRender([1.2, 0.5, 1.0, 0.5, 1.4]);
  const spans = splitOnSilence(buffer, 3, [12, 10, 14]);

  assert.ok(spans, 'expected a split');
  assert.equal(spans.length, 3);

  // Each span should cover its own speech and stop inside the pause.
  assert.ok(spans[0].start < 0.05, 'first span starts at the first sample of speech');
  assert.ok(Math.abs(spans[0].end - 1.45) < 0.2, 'first cut lands mid-pause');
  assert.ok(Math.abs(spans[1].start - 1.45) < 0.2);
  assert.ok(Math.abs(spans[2].end - 4.6) < 0.2, 'last span ends where speech ends');

  // Spans must be ordered and non-overlapping, or sentences would collide.
  for (let i = 0; i < spans.length; i++) {
    assert.ok(spans[i].end > spans[i].start, `span ${i} has positive length`);
    if (i) assert.ok(spans[i].start >= spans[i - 1].end - 1e-6, `span ${i} follows ${i - 1}`);
  }
});

test('trims leading and trailing silence rather than charging it to a sentence', () => {
  const buffer = makeRender([0.4, 0.4, 1.0, 0.4, 1.0, 0.4]);
  // The render opens with 0.4s of speech; prepend true silence instead.
  const padded = new Float32Array(Math.round(0.6 * SAMPLE_RATE) + buffer.length);
  padded.set(buffer.getChannelData(), Math.round(0.6 * SAMPLE_RATE));
  const spans = splitOnSilence(makeBuffer(padded), 3, [4, 10, 10]);

  assert.ok(spans, 'expected a split');
  assert.ok(spans[0].start >= 0.5, 'leading silence is not part of the first sentence');
});

/* ------------------------------------------------------------------ *
 * Refusing
 *
 * Every case below must return null so the caller falls back to rendering the
 * sentences individually. Guessing here is worse than the flatness grouping
 * was meant to fix.
 * ------------------------------------------------------------------ */

test('refuses when the model ran two sentences together', () => {
  // Three sentences were asked for, but only one pause exists.
  const buffer = makeRender([1.2, 0.5, 2.4]);
  assert.equal(splitOnSilence(buffer, 3, [12, 12, 12]), null);
});

test('refuses when a span is wildly out of proportion to its text', () => {
  // Two pauses, so the split itself succeeds -- but the first sentence is
  // three times the length its text calls for, which means the boundary is in
  // the wrong place.
  const buffer = makeRender([3.0, 0.4, 0.5, 0.4, 0.5]);
  assert.equal(splitOnSilence(buffer, 3, [10, 10, 10]), null);
});

test('refuses a render with no silence in it at all', () => {
  const buffer = makeRender([3.0]);
  assert.equal(splitOnSilence(buffer, 2, [10, 10]), null);
});

test('refuses silence too short to be a sentence boundary', () => {
  // 60 ms is a gap inside a word, not a pause between sentences.
  const buffer = makeRender([1.0, 0.06, 1.0]);
  assert.equal(splitOnSilence(buffer, 2, [10, 10]), null);
});

test('refuses degenerate input instead of dividing by zero', () => {
  assert.equal(splitOnSilence(null, 2, [1, 1]), null);
  assert.equal(splitOnSilence(makeRender([1.0, 0.4, 1.0]), 1, [1]), null);
  assert.equal(splitOnSilence(makeBuffer(new Float32Array(0)), 2, [1, 1]), null);
  // Pure digital silence: no peak to measure a floor against.
  assert.equal(splitOnSilence(makeBuffer(new Float32Array(SAMPLE_RATE * 3)), 2, [1, 1]), null);
});

test('never returns spans that would read past the end of the buffer', () => {
  const buffer = makeRender([1.0, 0.5, 1.0, 0.5, 1.0]);
  const spans = splitOnSilence(buffer, 3, [10, 10, 10]);
  assert.ok(spans);
  for (const span of spans) {
    assert.ok(span.start >= 0, 'span starts inside the buffer');
    assert.ok(span.end <= buffer.duration + 1e-6, 'span ends inside the buffer');
  }
});
