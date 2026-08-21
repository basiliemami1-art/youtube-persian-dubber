const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const context = { console };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'speechtext.js'), 'utf8'),
  context
);

const { foldCharacters, forSpeech, looksInterrogative, numberToWords } =
  context.YD.speechtext;

test('normalises Arabic glyphs and Persian numeric separators', () => {
  assert.equal(foldCharacters('عربي ك ۀ ۱۲٬۳۴۵٫۶'), 'عربی ک هٔ 12,345.6');
});

test('preserves explicit ezafe after heh', () => {
  assert.match(forSpeech('این خانۀ بزرگ است'), /خانهٔ بزرگ/);
});

test('spells quantities, temperatures and percentages for Persian speech', () => {
  const spoken = forSpeech('دما ۲۵°C و بازده ۱۲٫۵٪ است.');
  assert.match(spoken, /بیست و پنج درجه سانتی‌گراد/);
  assert.match(spoken, /دوازده ممیز پنج درصد/);
});

test('does not send production noise to the speech engine', () => {
  assert.equal(forSpeech('[Music] ♪'), '');
  assert.equal(forSpeech('مترجم: شخص نمونه'), '');
});

test('handles diacritics when recognising a question', () => {
  assert.equal(looksInterrogative('کِی می‌آیی'), true);
  assert.match(forSpeech('کِی می‌آیی.'), /؟$/);
});

test('converts common Latin technical terms to pronounceable Persian', () => {
  const spoken = forSpeech('Gemini API و YouTube');
  assert.match(spoken, /جِمِنای/);
  assert.match(spoken, /اِی‌پی‌آی/);
  assert.match(spoken, /یوتیوب/);
});

test('reads identifiers digit-by-digit and ordinary years as quantities', () => {
  assert.equal(numberToWords('0912'), 'صفر نه یک دو');
  assert.equal(numberToWords('1995'), 'هزار و نهصد و نود و پنج');
});
