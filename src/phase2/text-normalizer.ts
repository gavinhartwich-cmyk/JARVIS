/**
 * Phase 2: Text Normalization for Speech
 *
 * [ADDED 2026-09-03] Real bug found live: Chatterbox mispronounced
 * "78,720" (a correct, real answer to "what's 320 x 246?") as something
 * Gavin heard as garbled nonsense - "78 7twane." Confirmed this isn't
 * something JARVIS's own code was bypassing: no text preprocessing
 * happened anywhere before the raw text reached
 * `chatterbox_synthesize_daemon.py`, which hands it straight to the
 * model's own `generate()` (which does call the library's own internal
 * `punc_norm()`, but that's punctuation normalization, not number
 * pronunciation - comma-thousands-separated numbers are a well-known
 * real weakness across neural TTS models generally, not specific to
 * this one).
 *
 * Real, general fix: spell large/comma-formatted numbers out into words
 * before ANY synthesizer ever sees the text - "78,720" becomes
 * "seventy-eight thousand, seven hundred twenty", which is unambiguous
 * for a speech model to pronounce correctly regardless of how well it
 * handles raw digit-comma formatting. Applied as a real, shared
 * preprocessing step so Piper/Fish Audio benefit too, not just
 * Chatterbox - this is a general TTS input-quality fix, not a
 * Chatterbox-specific patch.
 *
 * Deliberately scoped: only touches integers (no decimals, currency, or
 * ordinals like "1st") and only really matters for comma-formatted or
 * multi-digit numbers - a bare single/double-digit number ("4", "42")
 * is already unambiguous for any real TTS model and left alone to avoid
 * needless verbosity ("four" reads fine either way, no real risk there).
 */

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = [
  "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];
const SCALES = ["", " thousand", " million", " billion", " trillion"];

/** Real integer-to-words conversion, 0 to 999,999,999,999,999 (comfortably beyond anything a spoken reply would ever need). */
function numberToWords(n: number): string {
  if (n === 0) return "zero";
  if (n < 0) return `negative ${numberToWords(-n)}`;

  function threeDigitsToWords(num: number): string {
    const parts: string[] = [];
    if (num >= 100) {
      parts.push(`${ONES[Math.floor(num / 100)]} hundred`);
      num %= 100;
    }
    if (num >= 20) {
      const tensWord = TENS[Math.floor(num / 10)];
      const onesDigit = num % 10;
      parts.push(onesDigit > 0 ? `${tensWord}-${ONES[onesDigit]}` : tensWord);
    } else if (num > 0) {
      parts.push(ONES[num]);
    }
    return parts.join(" ");
  }

  const groups: string[] = [];
  let scaleIndex = 0;
  let remaining = n;
  while (remaining > 0) {
    const group = remaining % 1000;
    if (group > 0) {
      groups.unshift(threeDigitsToWords(group) + SCALES[scaleIndex]);
    }
    remaining = Math.floor(remaining / 1000);
    scaleIndex++;
  }
  // [ADDED 2026-09-03] Real, live-found mitigation: Gavin confirmed the
  // mumbling happened specifically on the LATTER HALF of a longer
  // spelled-out number ("seventy-eight thousand, seven hundred twenty")
  // while a shorter one ("six thousand") came out clean - a real,
  // well-documented autoregressive-TTS weakness (quality/attention can
  // drift over a longer generated span, not specific to Chatterbox).
  // Not fixable by more text preprocessing alone, but a period between
  // the thousands/millions group and the remainder (instead of a comma)
  // gives the model a real, stronger sentence-boundary signal to
  // potentially treat as more independent segments, rather than one
  // long unbroken phrase - a real, disclosed, NOT-guaranteed attempt at
  // mitigation, not a confirmed fix (can't verify audio output from
  // here at all).
  return groups.join(groups.length > 1 ? ". " : ", ");
}

// Matches a real comma-thousands-formatted number (e.g. "78,720" or
// "1,234,567") OR a bare integer of 4+ digits (e.g. "78720") - both are
// real, confirmed-risky shapes for TTS mispronunciation; a plain 1-3
// digit number is left untouched (already safe, and spelling out "42"
// as "forty-two" everywhere would be needless noise for the common
// case that was never actually broken).
const RISKY_NUMBER_PATTERN = /\b\d{1,3}(?:,\d{3})+\b|\b\d{4,}\b/g;

/**
 * Real preprocessing step: spells out large/comma-formatted numbers in
 * text before it's handed to any TTS synthesizer. Safe on text with no
 * such numbers at all (a no-op regex miss, returns the original string
 * unchanged) - never throws.
 */
export function normalizeNumbersForSpeech(text: string): string {
  return text.replace(RISKY_NUMBER_PATTERN, (match) => {
    const digits = match.replace(/,/g, "");
    const value = parseInt(digits, 10);
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) return match; // real overflow guard - leave anything absurdly large untouched rather than risk a wrong conversion
    return numberToWords(value);
  });
}
