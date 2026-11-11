// src/lib/stated-price.ts
//
// THE PRICE A MESSAGE STATES.
//
// Two callers need the same answer to "what dollar figure does this text
// name?", and both need to know when the answer is not certain:
//
//   - an acceptance ("ok deal at 1.2k") is agreed at the number the creator
//     wrote, never at our last price when they wrote a different one;
//   - a human-edited counter draft records the price its edited body quotes,
//     so the thread's record, "Last price sent" and a later "deal" all read
//     the number the creator was actually shown.
//
// The parser is deliberately conservative. Anything that looks like a price
// but cannot be read with certainty (European "1.200", "1,20", "150ish",
// "two hundred", a figure glued to "=" or ":") makes the whole message
// UNCLEAR, and more than one distinct price is UNCLEAR too. An unclear read is
// never guessed at: the acceptance path hands it to a human, and the edit path
// asks the editor to confirm the price.
//
// What is NOT a price, and is ignored: quantities and durations ("1 reel",
// "30-second", "2 weeks", "30s", "2x"), reach metrics ("10k followers"),
// single-digit bare integers (almost always a count), percentages, times,
// slash dates, ISO dates, full phone numbers, URLs, email addresses, @handles
// and #hashtags, quoted history ("> …", "On … wrote:") and a signature after
// "--" / "Sent from my …".
//
// Pure and dependency-free: the client edit form imports it to prefill the
// price field, and the server re-runs it on save.

export type StatedPrice =
  /** The text names no price at all. */
  | { kind: 'none' }
  /** Exactly one price, read with certainty. */
  | { kind: 'one'; usd: number }
  /** Something price-like that cannot be read with certainty, or more than
   *  one distinct price. `candidates` lists the prices that WERE certain. */
  | { kind: 'unclear'; reason: string; candidates: number[] };

/** Words that name a number a figure-only parser cannot read. Single-digit
 *  words ("one reel", "this one") are excluded on purpose: they are counts
 *  far more often than prices, and "one-fifty" still trips on "fifty". */
const NUMBER_WORDS =
  /\b(?:eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)\b/i;

/** A number directly followed by one of these is a count, a duration or a
 *  reach metric, not a price. Hyphen or space allowed between ("30-second"). */
const NON_PRICE_UNIT =
  /^\s?-?\s?(?:reels?|stor(?:y|ies)|posts?|videos?|vids?|tiktoks?|shorts?|clips?|lives?|streams?|slides?|photos?|pics?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|minutes?|mins?|seconds?|secs?|times|followers|views|subs|subscribers|likes|plays|impressions|people|pieces?|pcs|percent)\b/i;
/** Short units only count when glued on ("30s", "2x", "48h", "2nd"): with a
 *  space, "150 w/ a reel" is a price followed by a word, not 150 weeks. */
const NON_PRICE_UNIT_GLUED = /^(?:s|x|h|hr|hrs|d|w|wk|wks|mo|sec|min|st|nd|rd|th)\b|^%/i;

const MONEY_AFTER = /^\s?(?:usd|dollars?|bucks)\b/i;
const MONEY_BEFORE = /(?:\$|usd|us\$)\s?$/i;
/** A k suffix counts as thousands, unless it is a reach metric ("10k followers"). */
const K_SUFFIX = /^\s?[kK](?![a-zA-Z])/;
const K_REACH = /^\s?[kK]\s*(?:followers|views|subs|subscribers|likes|plays|streams|impressions)\b/i;
const M_SUFFIX = /^\s?[mM](?![a-zA-Z])/;

/** Cut quoted history and a trailing signature: the price the writer states
 *  is in what they wrote, not in what they quoted. */
function ownWords(text: string): string {
  const out: string[] = [];
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim();
    if (/^on\b.*\bwrote:$/i.test(t)) break;
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(t)) break;
    if (/^--\s*$/.test(t)) break;
    if (/^sent from my\b/i.test(t)) break;
    if (t.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n');
}

/** Blank out spans that carry digits but are never a price. */
function scrubNonPrices(s: string): string {
  const blank = (m: string) => ' '.repeat(m.length);
  return s
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, blank)
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, blank)
    .replace(/[@#][\w.]+/g, blank)
    // Full phone numbers only (3-3-4 with separators, optional +1). A shorter
    // hyphenated pair is left alone, so "$150-2000" is still read as two prices.
    .replace(/(?<![$\d])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g, blank)
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, blank)
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, blank)
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?)?/gi, blank)
    .replace(/\b\d{1,2}\s?[ap]\.?m\.?(?![a-z])/gi, blank);
}

/**
 * Read the price a message states. See the file header for the rules.
 */
export function readStatedPrice(text: string | null | undefined): StatedPrice {
  const s = scrubNonPrices(ownWords(String(text ?? '')));
  const certain: number[] = [];
  let unclear: string | null = null;

  if (NUMBER_WORDS.test(s)) unclear = 'a number written in words';
  if (/\d\s*grand\b/i.test(s)) unclear = 'a price written as "grand"';

  const re = /\d[\d,.]*/g;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    const start = m.index;
    let core = m[0];
    // Sentence punctuation after a figure ("$180." / "1,200,") is not part of it.
    while (core.length > 1 && /[.,]$/.test(core)) core = core.slice(0, -1);
    const end = start + core.length;
    const before = s.slice(Math.max(0, start - 5), start);
    const after = s.slice(end, end + 40);
    const prev = start > 0 ? s[start - 1] : '';

    // Glued to a word or to code-like punctuation: "mp3", "x2", "=199", ":199".
    if (/[A-Za-z_]/.test(prev) && !/(?:us|usd)$/i.test(before)) {
      if (/[=:]/.test(prev)) unclear = `a figure glued to "${prev}"`;
      continue;
    }
    if (/[=:]/.test(prev)) {
      unclear = `a figure glued to "${prev}"`;
      continue;
    }

    const moneyMarked = MONEY_BEFORE.test(before) || MONEY_AFTER.test(after);
    const kSuffix = K_SUFFIX.test(after) && !K_REACH.test(after);

    if (!moneyMarked && K_REACH.test(after)) continue; // "10k followers"
    if (M_SUFFIX.test(after)) {
      // "$1m" is a price nobody quotes; "2m" is minutes or a reach. Neither is
      // a number this path should act on, and a money-marked one is suspect.
      if (moneyMarked) unclear = 'a figure with an "m" suffix';
      continue;
    }
    if (!moneyMarked && !kSuffix && (NON_PRICE_UNIT.test(after) || NON_PRICE_UNIT_GLUED.test(after))) continue;
    // Anything else glued on after ("150ish", "150k3") is not a clean figure.
    if (!kSuffix && /^[A-Za-z]/.test(after) && !MONEY_AFTER.test(after)) {
      unclear = `"${core}${after.match(/^[A-Za-z]+/)?.[0] ?? ''}" is not a clean figure`;
      continue;
    }

    // The figure itself must be well formed.
    let value: number;
    if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(core)) {
      value = Number(core.replace(/,/g, ''));
    } else if (/^\d+(?:\.\d{1,2})?$/.test(core)) {
      value = Number(core);
    } else if (kSuffix && /^\d+\.\d{3}$/.test(core)) {
      value = Number(core); // "1.250k"
    } else {
      unclear = `"${core}" is not a figure that can be read with certainty`;
      continue;
    }
    if (kSuffix) value = Math.round(value * 1000 * 100) / 100;

    if (!moneyMarked && !kSuffix) {
      const isInteger = /^[\d,]+$/.test(core);
      if (!isInteger) {
        unclear = `"${core}" has no currency and is not a whole number`;
        continue;
      }
      if (value < 10) continue; // a count, not a price
      if (value >= 1900 && value <= 2099 && /^\d{4}$/.test(core)) {
        unclear = `"${core}" could be a year`;
        continue;
      }
    }
    if (!Number.isFinite(value) || value <= 0) {
      unclear = `"${core}" is not a positive amount`;
      continue;
    }
    certain.push(value);
  }

  const distinct = [...new Set(certain.map((v) => Math.round(v * 100) / 100))];
  if (unclear) return { kind: 'unclear', reason: unclear, candidates: distinct };
  if (distinct.length > 1) {
    return {
      kind: 'unclear',
      reason: `more than one price is named (${distinct.map((v) => `$${v}`).join(', ')})`,
      candidates: distinct,
    };
  }
  if (distinct.length === 1) return { kind: 'one', usd: distinct[0] };
  return { kind: 'none' };
}

// ─── The counter edit form's price check ──────────────────────────
//
// The edit forms used to send the PREFILLED price field with every save, and
// the server takes a sent price as the editor's confirmation. So an edit whose
// text no longer named a price (or named two) was saved at the prefilled
// number without anyone choosing it. The forms now ask this first:
//
//   'ok'        the text states exactly the field's price: save, no question.
//   'confirm'   the text names no price, or one that can't be read for
//               certain: the editor must explicitly confirm the field's price.
//   'mismatch'  the text states a different price: fix one of them first.
//   'missing'   the field is empty or not a positive number.

export type EditPriceCheck =
  | { kind: 'ok'; usd: number }
  | { kind: 'confirm'; usd: number; message: string }
  | { kind: 'mismatch'; usd: number; stated: number; message: string }
  | { kind: 'missing'; message: string };

export function checkCounterEditPrice(body: string, field: string | number | null | undefined): EditPriceCheck {
  const usd = Number(field);
  if (field == null || String(field).trim() === '' || !Number.isFinite(usd) || usd <= 0) {
    return { kind: 'missing', message: 'Enter the price this counter offers.' };
  }
  const stated = readStatedPrice(body);
  const fmt = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  if (stated.kind === 'one') {
    if (Math.abs(stated.usd - usd) < 0.005) return { kind: 'ok', usd };
    return {
      kind: 'mismatch',
      usd,
      stated: stated.usd,
      message: `The message says ${fmt(stated.usd)} but the price field says ${fmt(usd)}. Make them match.`,
    };
  }
  return {
    kind: 'confirm',
    usd,
    message:
      stated.kind === 'none'
        ? `The message names no price. Confirm this counter offers ${fmt(usd)}.`
        : `The price in the message can't be read for certain (${stated.reason}). Confirm this counter offers ${fmt(usd)}.`,
  };
}

// ─── Fail-safe gates ────────────────
//
// readStatedPrice GUESSES which numbers are money, and every
// guess can be wrong in a way that sends "Deal, $X works" at a price nobody
// agreed ("posting Oct 15", "500 saves", "€300", "300 per video, 2 videos").
// The gates below do not guess. The rule they enforce:
//
//   The AI may only auto-agree at a price WE SENT.
//
// An acceptance goes through only when the creator's own words contain NO
// number at all, or when every number in them is exactly the last price we
// sent. Any other number (a date, a count, a follower figure, a zip code, a
// price) sends the reply to a human. Human time is cheap; a wrong agreement
// email is not.
//
// A counter (intent 'counter', never 'accept') is still read by
// readStatedPrice, because a counter is a new ask, not an agreement to one of
// ours: it goes through only when the reply states exactly one unambiguous USD
// price and it is the one the model read. Non-USD currency, per-unit or
// multiplier wording and ranges/alternatives go to a human.

export type PriceGate = { ok: true } | { ok: false; reason: string };

/** Invisible characters that can split or hide a digit ("150​0"). */
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ﻿ﾠ]/g;

/** Strip ONLY the other side's words: "> quoted" lines and everything from an
 *  "On … wrote:" / "Original Message" header down. A signature is kept: a
 *  number in it ("Rates from 500") is still a number the creator sent. */
function withoutQuotedHistory(text: string): string {
  const out: string[] = [];
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim();
    if (/^on\b.*\bwrote:$/i.test(t)) break;
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(t)) break;
    if (t.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n');
}

/** Normalised so look-alike digits read as digits: NFKC turns full-width
 *  "１５０", circled and superscript digits into ASCII, and invisible
 *  characters are removed so they cannot split one number into two. */
function normaliseForGate(text: string): string {
  return withoutQuotedHistory(text).normalize('NFKC').replace(INVISIBLE, '');
}

/** Any run of digits in any script (Arabic-Indic, Devanagari, keycap-emoji
 *  base digits, …), with the separators a figure can carry. */
const ANY_NUMBER = /\p{N}+(?:[.,]\p{N}+)*/gu;

/** Number words. "one" alone is left out on purpose ("this one", "no one");
 *  "one fifty" still trips on "fifty". */
const NUMBER_WORD =
  /\b(?:zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|grand|dozen|half|couple)\b/i;

/** Any currency that is not US dollars. "$" alone and USD are ours; a
 *  prefixed dollar ("C$", "AU$") is somebody else's. */
const NON_USD =
  /[€£¥₹₩₽₺₱฿₦₫₪₴₡₲₵₸₭₮₼₾¢]|\b(?:eur|gbp|cad|aud|nzd|jpy|inr|mxn|brl|chf|sek|nok|dkk|pln|zar|sgd|hkd|cny|rmb|krw|php|thb|idr|myr|ngn|kes|aed|sar|ils|czk|huf|clp|ars)\b|\b(?:euros?|pounds?|quid|yen|yuan|rupees?|pesos?|reais|francs?|kron[aeor]r?|zloty|rubles?|roubles?|lira|dirhams?|shekels?)\b|\b(?:c|ca|can|a|au|nz|hk|s|r|mx|nt)\$/i;

/** Per-unit, multiplier and add-on wording: the number may not be the total. */
const PER_UNIT =
  /\bper\b|\beach\b|\bapiece\b|\ba piece\b|\/\s*(?:video|vid|post|reel|story|stories|tiktok|clip|piece|item|deliverable|one|hr|hour|day|week|month)\b|\p{N}\s*(?:x\b|[×*])|(?:\bx|[×*])\s*\p{N}|×|\btimes\b|\btwice\b|\bdouble\b|\btriple\b|\bplus\b|\+|\btax(?:es)?\b|\bvat\b|\bfees?\b|\bextra\b|\badditional\b|\bon top\b|\bsurcharge\b|\bdeposit\b|\bupfront\b|\bup front\b|%/iu;

/** Two or more of a deliverable ("2 videos", "three reels"): the price may be
 *  per piece, or for a package nobody quoted. */
const MULTI_DELIVERABLE =
  /(?:\b(?:[2-9]|\d{2,})|\b(?:two|three|four|five|six|seven|eight|nine|ten|several|multiple|a few|a couple of))\s*(?:x\s*)?(?:videos?|vids?|posts?|reels?|stor(?:y|ies)|tiktoks?|clips?|shorts?|pieces?|deliverables?|slides?|photos?)\b/i;

/** Range / alternative / approximate wording. */
const RANGE_OR_ALT =
  /\p{N}\s*(?:-|–|—|to|or|\/)\s*\$?\s*\p{N}|(?:\bbetween|(?<!\b(?:how|what)\s+)\babout|\baround|\broughly|\bapprox\w*|~|\bat least|\bminimum|\bmin|\bupwards of)\s*(?:of\s*)?\$?\s*\p{N}|\p{N}[\p{N},.]*\s*[kK]?\s*(?:-?ish\b|or so\b|obo\b|or best\b|and up\b|or more\b|or less\b|negotiable\b)/iu;

/** A figure written the one way the acceptance gate compares: plain ASCII
 *  digits with optional US thousands commas and cents, optionally a "k". */
function exactValue(token: string, after: string): number | null {
  if (!/^[0-9.,]+$/.test(token)) return null; // not ASCII digits: never equal
  let v: number;
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(token)) v = Number(token.replace(/,/g, ''));
  else if (/^\d+(?:\.\d{1,2})?$/.test(token)) v = Number(token);
  else return null; // "1.200", "150,00", "1,20": not one figure for certain
  if (/^\s?[kK](?![A-Za-z])/.test(after)) v = Math.round(v * 1000 * 100) / 100;
  else if (/^[A-Za-z]/.test(after)) return null; // "150ish", "2nd", "15th"
  return Number.isFinite(v) ? v : null;
}

/** Every number-like thing in the text, as written. */
function numbersIn(s: string): Array<{ token: string; after: string }> {
  const out: Array<{ token: string; after: string }> = [];
  const re = new RegExp(ANY_NUMBER.source, ANY_NUMBER.flags);
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    out.push({ token: m[0], after: s.slice(m.index + m[0].length, m.index + m[0].length + 8) });
  }
  return out;
}

/**
 * May an ACCEPTANCE be agreed automatically at `lastSentUsd`, the last price
 * the creator was actually sent? Only if their own words name no number, or
 * name only that one, AND the yes is clean: no per-unit / multiplier / add-on
 * wording, no condition or qualifier, no question. Anything else,
 * including numbers that are obviously not prices, is a human's call. An
 * unknown last price is never agreed.
 */
export function acceptanceGate(text: string | null | undefined, lastSentUsd: number | null | undefined): PriceGate {
  const nums = acceptanceNumberGate(text, lastSentUsd);
  return nums.ok ? acceptanceWordingGate(text) : nums;
}

/** The number half of acceptanceGate: the last sent price is known, and the
 *  reply names no number, no number word and no other currency, or names only
 *  that price. */
export function acceptanceNumberGate(text: string | null | undefined, lastSentUsd: number | null | undefined): PriceGate {
  const s = normaliseForGate(String(text ?? ''));
  const sent = lastSentUsd == null ? Number.NaN : Number(lastSentUsd);
  if (!Number.isFinite(sent) || sent <= 0) {
    return { ok: false, reason: 'the last price this creator was sent cannot be read back' };
  }
  if (NON_USD.test(s)) return { ok: false, reason: 'the reply mentions a currency other than US dollars' };
  const word = s.match(NUMBER_WORD)?.[0];
  if (word) return { ok: false, reason: `the reply has a number written as a word ("${word}")` };
  const nums = numbersIn(s);
  for (const n of nums) {
    const v = exactValue(n.token, n.after);
    if (v == null || Math.abs(v - sent) >= 0.005) {
      return { ok: false, reason: `the reply contains "${n.token}", which is not the $${sent} we last sent` };
    }
  }
  return { ok: true };
}

/**
 * Is this a CLEAN, unconditional yes? Runs whether or not the reply
 * has a digit: "Deal if you double it", "ok deal, plus tax and fees on top" and
 * "Deal, per video right?" name no number and were agreed at our last price.
 * Per-unit / multiplier / add-on wording, conditional or qualifying wording,
 * and a question all fail it. Part of acceptanceGate; exported so the
 * negotiator can let a term-trade COUNTER through while still refusing to
 * auto-close a qualified yes.
 */
export function acceptanceWordingGate(text: string | null | undefined): PriceGate {
  const s = normaliseForGate(String(text ?? ''));
  const unit = s.match(PER_UNIT)?.[0];
  if (unit) {
    return { ok: false, reason: `the reply has per-unit, multiplier or add-on wording ("${unit.trim()}")` };
  }
  const condition = s.match(CONDITIONAL)?.[0];
  if (condition) {
    return { ok: false, reason: `the reply has conditional or qualifying wording ("${condition}")` };
  }
  if (/[?？¿]/.test(s)) {
    return { ok: false, reason: 'the reply asks a question, so it is not a clean yes' };
  }
  return { ok: true };
}

/** Wording that makes a yes conditional, qualified or a different deal. Checked
 *  on every acceptance, digit or not. "would"/"could" are left out on
 *  purpose: "I would love to" is the commonest clean yes there is. */
const CONDITIONAL =
  /\b(?:if|unless|only|but|except|every|excluding|assuming|provided|providing|as long as|so long as|on condition|conditional(?:ly)?|depend(?:s|ing)?|subject to|contingent|given that|however|though|although|instead|rather|minus|discount|bonus|more|less|higher|lower|bump|raise|increase|reduce|maybe|perhaps|might|possibly|probably)\b/i;

/**
 * May a COUNTER at `modelUsd` go through the normal counter path? Only when
 * the reply states exactly one unambiguous USD price and it is that number.
 */
export function counterGate(text: string | null | undefined, modelUsd: number): PriceGate {
  const s = normaliseForGate(String(text ?? ''));
  if (NON_USD.test(s)) return { ok: false, reason: 'the reply mentions a currency other than US dollars' };
  if (numbersIn(s).some((n) => !/^[0-9.,]+$/.test(n.token))) {
    return { ok: false, reason: 'the reply writes a number in non-ASCII digits' };
  }
  if (PER_UNIT.test(s) || MULTI_DELIVERABLE.test(s)) {
    return { ok: false, reason: 'the reply prices per unit, with a multiplier or an add-on, or for several pieces' };
  }
  if (RANGE_OR_ALT.test(s)) return { ok: false, reason: 'the reply gives a range, an alternative or an approximate figure' };
  const read = readStatedPrice(s);
  if (read.kind === 'unclear') return { ok: false, reason: read.reason };
  if (read.kind === 'none') {
    return { ok: false, reason: `the counter was read as $${modelUsd}, but the reply states no price` };
  }
  if (Math.abs(read.usd - modelUsd) >= 0.005) {
    return { ok: false, reason: `the reply states $${read.usd} but was read as $${modelUsd}` };
  }
  return { ok: true };
}
