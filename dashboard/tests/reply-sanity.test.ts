// tests/reply-sanity.test.ts
//
// Unit tests for src/lib/reply-sanity.ts. Fully hermetic
// (pure functions — no network, no DB, no LLM).
//
// Covers: AI/bot speculation flags, out-of-context flags, and — critically —
// that ordinary negotiation / decline / garbled replies (including every reply
// used by the negotiation harness) are NOT flagged, so the auto-loop's existing
// behavior is preserved.
//
// Run: npx tsx tests/reply-sanity.test.ts

import { checkReplySanity } from '../src/lib/reply-sanity';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

const flags = (t: string) => checkReplySanity(t).fishy_flags;
const has = (t: string, f: string) => flags(t).includes(f);
const clean = (t: string) => flags(t).length === 0;

// ── 1. AI / bot speculation is flagged ──────────────────────────────────────
assert(has('Are you a bot or a real person?', 'ai_speculation'), 'ai: "are you a bot"');
assert(has('wait, is this an automated message?', 'ai_speculation'), 'ai: "is this automated"');
assert(has('honestly this feels AI-generated, is a human even reading these?', 'ai_speculation'), 'ai: "feels AI-generated"');
assert(has('am I talking to a real person here or a chatbot?', 'ai_speculation'), 'ai: "am I talking to a real person"');
assert(has("you're just a bot right", 'ai_speculation'), 'ai: "you\'re just a bot"');
assert(has('is this ChatGPT lol', 'ai_speculation'), 'ai: "is this chatgpt"');

// ── 2. Out-of-context / non-sequitur is flagged ─────────────────────────────
assert(
  has('Hey did the plumber ever come fix your sink? also my netflix password stopped working', 'out_of_context'),
  'ooc: unrelated household/netflix reply',
);
assert(
  has('Wrong number, who is this? I never signed up for anything', 'out_of_context'),
  'ooc: wrong-number / who-is-this',
);
assert(
  has('is my amazon order shipped yet, the tracking number still isnt working', 'out_of_context'),
  'ooc: amazon order / shipping non-sequitur',
);

// ── 3. Normal negotiation replies are NOT flagged (behavior preserved) ──────
assert(clean('Yeah $150 works for me, send the track over.'), 'clean: accept with dollar amount');
assert(clean('Can you come up to $300? I usually get more than that.'), 'clean: harness counter reply');
assert(clean('Ok how about $180 and we call it a deal?'), 'clean: harness converge reply');
assert(clean("I'll do it for $60, that's my usual rate for a quick post."), 'clean: harness lowball');
assert(clean('I need $5000 minimum, take it or leave it.'), 'clean: harness over-ask');
assert(clean('Not interested, please stop contacting me about this.'), 'clean: decline (not flagged as out-of-context)');
assert(clean("What's your rate range and what genre is the artist?"), 'clean: on-topic question');
assert(clean('what even is this campaign lol idk what you want from me'), 'clean: garbled-but-on-topic (mentions campaign)');
assert(clean('asdf qwerty zxcv lorem ipsum ??? 000'), 'clean: pure garble stays unflagged (negotiator handles it)');
assert(clean('sounds good, count me in for a reel next week'), 'clean: enthusiastic accept');
assert(clean('I only work with real brands, send me the media kit'), 'clean: "real brands" is not AI-speculation');

// ── 4. Both lanes can fire together ─────────────────────────────────────────
{
  const f = flags('who is this?? are you a bot? my landlord is asking about rent');
  assert(f.includes('ai_speculation') && f.includes('out_of_context'), 'both: ai + out_of_context on one reply');
}

// ── 5. Empty / junk inputs are safe ─────────────────────────────────────────
assert(clean(''), 'clean: empty string');
assert(clean('   '), 'clean: whitespace');
assert(checkReplySanity(null).fishy_flags.length === 0, 'clean: null coerces safely');

// ── 6. domainTerms widen the on-topic allowlist ─────────────────────────────
{
  // A reply that would otherwise be unrelated becomes on-topic when the artist
  // name is a known domain term.
  const withoutTerm = checkReplySanity('does the amazon order come with the nova').fishy_flags;
  const withTerm = checkReplySanity('does the amazon order come with the nova', { domainTerms: ['Nova'] }).fishy_flags;
  assert(withoutTerm.includes('out_of_context'), 'domainTerms: flagged without the term');
  assert(!withTerm.includes('out_of_context'), 'domainTerms: cleared when artist name present');
}

console.log(`reply-sanity test: ${passed} passed, ${failed} failed`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
