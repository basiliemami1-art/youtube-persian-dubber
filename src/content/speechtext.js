/**
 * Turning subtitle text into something worth reading aloud.
 *
 * Caption text and machine translation both carry a lot that a human dubber
 * would never say out loud, and a lot that quietly breaks the phonemiser:
 *
 *   - production markers -- [Music], (applause), ♪, the ">>" speaker arrows
 *   - transcript credits that ride along on the first line of TED-style videos
 *   - Arabic ك and ي, which machine translation emits constantly; Persian
 *     phonemisers do not recognise them and mispronounce or skip the word
 *   - digits and symbols, which get read as the wrong language or not at all
 *   - missing final punctuation, which leaves the sentence hanging on a rising
 *     tone instead of closing
 *
 * Everything here is text-in, text-out and engine independent, so the browser
 * voice benefits from it as much as Piper does.
 */
(() => {
  'use strict';

  const YD = (globalThis.YD = globalThis.YD || {});
  if (YD.speechtext) return;

  /* ------------------------------------------------------------------ *
   * Character-level repair
   * ------------------------------------------------------------------ */

  /*
   * Note on diacritics: the short vowels (َ ِ ُ ّ ْ) and the ezafe kasre are
   * deliberately left alone by everything in this file. espeak reads them, and
   * they are the only way to tell مرد (mard, a man) from مُرد (mord, he died)
   * -- or, far more often, to get the linking vowel in کتابِ من at all. Any
   * cleanup added here must keep combining marks intact.
   */
  const CHAR_MAP = {
    'ي': 'ی', // Arabic yeh -> Persian yeh
    'ى': 'ی', // alef maksura -> Persian yeh
    'ك': 'ک', // Arabic kaf -> Persian keheh
    'ۀ': 'هٔ', // preserve the written ezafe instead of silently dropping it
    'ة': 'ه', // teh marbuta -> heh
    '‌': '‌', // keep ZWNJ
    '‘': "'",
    '’': "'",
    '“': '"',
    '”': '"',
    '–': '-',
    '—': '-',
    ' ': ' ',
    '٫': '.', // Arabic decimal separator
    '٬': ',', // Arabic thousands separator
  };

  // Arabic-Indic and Persian digit forms, folded to ASCII before spelling out.
  const DIGIT_MAP = {};
  '٠١٢٣٤٥٦٧٨٩'.split('').forEach((c, i) => (DIGIT_MAP[c] = String(i)));
  '۰۱۲۳۴۵۶۷۸۹'.split('').forEach((c, i) => (DIGIT_MAP[c] = String(i)));

  const foldCharacters = (text) =>
    String(text || '').normalize('NFC').replace(/[يىكۀة‘’“”–— ٫٬]/g,
      (c) => CHAR_MAP[c] || c
    ).replace(/[٠-٩۰-۹]/g, (c) => DIGIT_MAP[c] || c)
      // Directional controls are useful for display but can confuse a
      // phonemiser and have no audible meaning. Keep the Persian ZWNJ (200C).
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');

  /* ------------------------------------------------------------------ *
   * Numbers to Persian words
   * ------------------------------------------------------------------ */

  const ONES = ['', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه'];
  const TEENS = [
    'ده', 'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده',
    'شانزده', 'هفده', 'هجده', 'نوزده',
  ];
  const TENS = [
    '', '', 'بیست', 'سی', 'چهل', 'پنجاه',
    'شصت', 'هفتاد', 'هشتاد', 'نود',
  ];
  const HUNDREDS = [
    '', 'صد', 'دویست', 'سیصد', 'چهارصد', 'پانصد',
    'ششصد', 'هفتصد', 'هشتصد', 'نهصد',
  ];
  const SCALES = [
    [1e9, 'میلیارد'],
    [1e6, 'میلیون'],
    [1e3, 'هزار'],
  ];

  /** 0-999 as Persian words. */
  const underThousand = (n) => {
    const parts = [];
    const h = Math.floor(n / 100);
    const rest = n % 100;
    if (h) parts.push(HUNDREDS[h]);
    if (rest >= 10 && rest < 20) parts.push(TEENS[rest - 10]);
    else {
      const t = Math.floor(rest / 10);
      const o = rest % 10;
      if (t) parts.push(TENS[t]);
      if (o) parts.push(ONES[o]);
    }
    return parts.join(' و ');
  };

  const wholeToWords = (n) => {
    if (n === 0) return 'صفر';
    const parts = [];
    let remaining = n;
    for (const [value, name] of SCALES) {
      const count = Math.floor(remaining / value);
      if (count) {
        // "one thousand" is just "هزار" in Persian, not "یک هزار".
        parts.push(count === 1 && value === 1e3 ? name : `${underThousand(count)} ${name}`);
        remaining %= value;
      }
    }
    if (remaining) parts.push(underThousand(remaining));
    return parts.join(' و ');
  };

  const numberToWords = (raw) => {
    const negative = raw.startsWith('-');
    const body = negative ? raw.slice(1) : raw;
    const [whole, fraction] = body.split('.');

    const digits = whole.replace(/\D/g, '');
    if (!digits) return raw;

    const spellOut = () =>
      digits.split('').map((d) => (d === '0' ? 'صفر' : ONES[+d])).join(' ');

    // A leading zero means this is an identifier, not a quantity -- phone
    // numbers, account numbers, room numbers. Reading 09121234567 as "nine
    // billion, one hundred and twenty-one million..." is worse than useless.
    if (digits.length > 1 && digits[0] === '0') return spellOut();
    // Long unseparated runs are the same story; four-digit years and prices
    // written with separators stay as real numbers.
    if (digits.length > 9) return spellOut();

    let out = wholeToWords(Number(digits));
    if (fraction) {
      out += ' ممیز ' + fraction.split('').map((d) => ONES[+d] || 'صفر').join(' ');
    }
    return (negative ? 'منفی ' : '') + out;
  };

  /* ------------------------------------------------------------------ *
   * Noise removal
   * ------------------------------------------------------------------ */

  const STRIP_PATTERNS = [
    /\[[^\]]{0,40}\]/g, // [Music], [Applause], [صدای موسیقی]
    /\([^)]{0,24}\)\s*$/g, // trailing (laughs)
    /[♪♫🎵🎶]/g,
    /^\s*>>+\s*/gm, // speaker arrows
    // Dialogue dash at the start of a line -- but not a minus sign, or
    // "-12 degrees" silently loses its sign and becomes twelve above zero.
    /^\s*-\s*(?=[^\d\s])/gm,
  ];

  // The first caption of a translated TED-style talk is the transcriber and
  // reviewer credit. It is not part of the talk and reads as gibberish.
  const CREDIT_LINE =
    /^\s*(رونوشت|مترجم|ترجمه|بازبین|منتقد|Translator|Reviewer|Transcriber)\s*[::].*/i;

  const SYMBOLS = [
    [/[%٪]/g, ' درصد '],
    [/\$/g, ' دلار '],
    [/€/g, ' یورو '],
    [/£/g, ' پوند '],
    [/&/g, ' و '],
    [/\+/g, ' به علاوه '],
    [/=/g, ' مساوی '],
    [/@/g, ' at '],
  ];

  // Google-style translation occasionally keeps familiar product names and
  // technical abbreviations in Latin script. Persian voices either spell
  // those with an English accent or skip them, so provide their spoken forms.
  const LATIN_TERMS = [
    [/\bGemini\b/gi, 'جِمِنای'],
    [/\bYouTube\b/gi, 'یوتیوب'],
    [/\bJavaScript\b/gi, 'جاوااِسکریپت'],
    [/\bAPI\b/g, 'اِی‌پی‌آی'],
    [/\bAI\b/g, 'اِی‌آی'],
    [/\bURL\b/g, 'یوآراِل'],
    [/\bCPU\b/g, 'سی‌پی‌یو'],
    [/\bGPU\b/g, 'جی‌پی‌یو'],
    [/\bUSB\b/g, 'یو‌اِس‌بی'],
    [/\bHTML\b/g, 'اِچ‌تی‌اِم‌اِل'],
    [/\bCSS\b/g, 'سی‌اِس‌اِس'],
  ];

  /* ------------------------------------------------------------------ *
   * Question detection
   *
   * Caption fragments routinely lose their final punctuation, and machine
   * translation drops the question mark often enough to matter. Persian marks
   * questions lexically far more than English does, so the interrogative words
   * are a reliable signal even when the punctuation is gone.
   * ------------------------------------------------------------------ */

  const QUESTION_WORDS = [
    'آیا', 'چرا', 'چگونه', 'چطور', 'چه', 'چی', 'چند', 'چقدر',
    'کجا', 'کدام', 'کی', 'مگر', 'مگه',
  ];

  // "کی" and "چه" also appear inside ordinary statements, so a bare match is
  // not enough -- they only count near the start or the end of the clause.
  const AMBIGUOUS = new Set(['کی', 'چه', 'چی']);

  const looksInterrogative = (text) => {
    const words = String(text || '')
      .replace(/[\u064b-\u065f\u0670]/gi, '')
      .replace(/[^\p{L}\p{N}\s‌]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length) return false;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (!QUESTION_WORDS.includes(word)) continue;
      if (!AMBIGUOUS.has(word)) return true;
      // Ambiguous ones need to sit at an edge of the sentence.
      if (i === 0 || i >= words.length - 3) return true;
    }
    return false;
  };

  /* ------------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------------ */

  /**
   * @param {string} input raw cue text
   * @param {{lang?: string}} [options]
   * @returns {string} text ready to hand to a speech engine ('' if nothing
   *                   speakable is left, in which case the cue is skipped)
   */
  const forSpeech = (input, options = {}) => {
    let text = String(input || '');
    if (!text.trim()) return '';

    if (CREDIT_LINE.test(text)) return '';

    text = foldCharacters(text);
    for (const pattern of STRIP_PATTERNS) text = text.replace(pattern, ' ');
    for (const [pattern, replacement] of SYMBOLS) text = text.replace(pattern, replacement);
    for (const [pattern, replacement] of LATIN_TERMS) text = text.replace(pattern, replacement);

    // Temperatures and dates need to be handled before the generic number
    // pass consumes their digits one component at a time.
    text = text.replace(/(-?\d+(?:\.\d+)?)\s*°\s*C\b/gi, '$1 درجه سانتی‌گراد');
    text = text.replace(/(-?\d+(?:\.\d+)?)\s*°\s*F\b/gi, '$1 درجه فارنهایت');
    text = text.replace(/(\d{1,4})\s*[\/-]\s*(\d{1,2})\s*[\/-]\s*(\d{1,4})/g, '$1، $2، $3');

    // Times and ranges read better as words than as punctuation.
    text = text.replace(/(\d+)\s*:\s*(\d+)/g, 'ساعت $1 و $2 دقیقه');
    text = text.replace(/(\d)\s*[-–]\s*(\d)/g, '$1 تا $2');

    // Thousands separators would otherwise split one number into several.
    text = text.replace(/(\d),(?=\d{3}\b)/g, '$1');

    if ((options.lang || 'fa').startsWith('fa')) {
      text = text.replace(/-?\d[\d.]*/g, (match) => ` ${numberToWords(match)} `);
    }

    // Ellipses become a real pause instead of three spoken dots.
    text = text.replace(/\.{3,}|…/g, '، ');

    // Collapse punctuation runs the strippers may have left behind.
    text = text
      .replace(/\s+/g, ' ')
      .replace(/\s+([،؛,;.!?؟])/g, '$1')
      .replace(/([،؛,;])\1+/g, '$1')
      .replace(/^[\s،؛,;.\-–—]+/, '')
      .trim();

    if (!text) return '';
    // A cue with no letters left is punctuation debris.
    if (!/[\p{L}\p{N}]/u.test(text)) return '';

    // Close the sentence, because an unterminated one is read with the pitch
    // still rising, as though the speaker were interrupted. Which mark matters:
    // a question given a full stop lands flat, and nothing gives away a machine
    // reading text faster than a question that does not sound like one.
    if (!/[.!?؟…،؛:]$/.test(text)) {
      text += looksInterrogative(text) ? '؟' : '.';
    } else if (/[.،؛:]$/.test(text) && looksInterrogative(text)) {
      text = text.slice(0, -1) + '؟';
    }

    return text;
  };

  YD.speechtext = { forSpeech, numberToWords, foldCharacters, looksInterrogative };
})();
