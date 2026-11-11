// tests/first-touch.test.ts
//
// What Creator Campaigns actually says to a creator.
//
// Four separate defects are pinned here, all of them found by reading the sent
// copy rather than the code:
//
//   1. THE FIRST TOUCH WAS UNANSWERABLE. "We're promoting "Track" from Ada
//      Sample... Would you be open to a paid post? If that sounds interesting,
//      just reply and we'll sort the details." — no label named in the body, no
//      deliverable, no money, no sign-off, and a closing clause that is among
//      the most common scam phrasings in creator DMs. Every mandatory element
//      of the replacement is asserted below, so a future edit cannot quietly
//      drop one.
//   2. THE LABEL'S CONFIGURED VOICE WAS 90% DISCARDED. firms.outreach_prefs
//      carries tone, dos, donts and signoff; the prompt received only
//      `op.voice ?? op.tone`. Worse, a label's signoff can be the literal string
//      "— Example Records", and em dashes are a HARD ban in checkDraftCopy —
//      so honouring that field verbatim would have failed every draft, every
//      retry and the fallback too, and generateOutreachDraft throws at that
//      point. sanitizeSignoff is the thing standing between the label's own
//      sign-off and zero drafts, so it gets its own case.
//   3. `[Creator Campaigns]` LEAKED TO CREATORS IN LIVE MODE. No strip function existed, the
//      counter/acceptance schedulers tagged at insert time unconditionally, and
//      threadSubject() reused the stored subject for every later round.
//   4. NO MESSAGE HAD AN OPT-OUT.
//
// All hermetic: pure functions only, no DB, no model, no env beyond the mock
// provider flag.
//
// Run: npx tsx tests/first-touch.test.ts

process.env.MODEL_PROVIDER = 'mock';

import {
  buildFirstTouchFallback,
  checkDraftCopy,
  firstTouchAsk,
  resolveOutreachVoicePrefs,
  resolveSignoff,
  sanitizeSignoff,
  type DraftPersonalizationInput,
} from '../src/lib/openai';
import { checkOutreachCopy, isOptOutReply } from '../src/lib/outreach';
import {
  appendOptOut,
  buildOutboundEnvelope,
  listUnsubscribeHeaders,
  optOutLine,
} from '../src/lib/channels/outbound-envelope';
import {
  applySubjectTag,
  ensureSubjectTagPrefix,
  stripSubjectTag,
} from '../src/lib/channels/subject-tag';
import { nextStepSentence } from '../src/lib/payment-copy';

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

// ── A label's outreach_prefs row, verbatim shape ───────────────────────────
// `voice` holds the label's own NAME (a leftover slot nothing writes any more),
// `tone` holds the actual tone, and `signoff` carries an em dash.
const LABEL_PREFS = {
  voice: 'Example Records',
  tone: 'warm, direct, no fluff',
  dos: ["reference 2-3 of the creator's actual posts by hook"],
  donts: ['no exclamation points'],
  signoff: '— Example Records',
};

// ── 1. outreach_prefs reaches the prompt, in the right precedence ───────────

const prefs = resolveOutreachVoicePrefs(LABEL_PREFS, null, 'Example Records');

assert(
  prefs.tone === 'warm, direct, no fluff',
  'prefs: tone wins over voice (voice has no writer; preferring it shadows the field the label filled in)',
);
assert(prefs.dos?.length === 1, 'prefs: dos survive to the prompt layer');
assert(prefs.donts?.[0] === 'no exclamation points', 'prefs: donts survive to the prompt layer');
assert(prefs.signoff === '— Example Records', 'prefs: signoff is carried verbatim');

assert(
  resolveOutreachVoicePrefs({ voice: 'Example Records' }, null, 'Example Records').tone === null,
  'prefs: a tone that is only the label\'s own name is discarded, not fed to the model as a voice',
);
assert(
  resolveOutreachVoicePrefs({ voice: 'dry and unfussy' }, null, 'Example Records').tone ===
    'dry and unfussy',
  'prefs: a real legacy `voice` is still used when `tone` is empty',
);
assert(
  resolveOutreachVoicePrefs({}, { tone: 'legacy tone' }).tone === 'legacy tone',
  'prefs: legacy firms.voice_profile.tone is the last resort',
);
assert(
  resolveOutreachVoicePrefs(null).tone === null &&
    resolveOutreachVoicePrefs('garbage').dos?.length === 0,
  'prefs: a malformed or null row yields empty prefs rather than throwing',
);
assert(
  resolveOutreachVoicePrefs({ dos: 'one\ntwo\nthree' }).dos?.length === 3,
  'prefs: a hand-edited newline blob in `dos` is tolerated (the form writes an array, the DB does not enforce it)',
);

// ── 2. the em-dash sign-off, the regression that would zero out all drafts ──

assert(
  sanitizeSignoff('— Example Records') === 'Example Records',
  'signoff: the leading em dash marker is dropped, the label\'s name is kept',
);
assert(
  !/—/.test(sanitizeSignoff(LABEL_PREFS.signoff) ?? ''),
  'signoff: the sanitised sign-off contains NO em dash (an em dash here fails every draft AND the fallback, and generateOutreachDraft then throws)',
);
assert(sanitizeSignoff('  ') === null, 'signoff: whitespace-only is null, not an empty sign-off line');
assert(
  sanitizeSignoff('Alex — Example Records') === 'Alex, Example Records',
  'signoff: an internal em dash becomes a comma rather than being deleted',
);
assert(
  resolveSignoff({ prefsSignoff: null, senderName: 'Alex', labelName: 'Example Records' }) === 'Alex',
  'signoff: a configured human name is used when there is no prefs signoff',
);
assert(
  resolveSignoff({ prefsSignoff: null, senderName: null, labelName: 'Example Records' }) === 'Example Records',
  'signoff: with no human configured we sign as the label, never an invented person',
);
assert(
  resolveSignoff({ prefsSignoff: null, senderName: null, labelName: null }) === null,
  'signoff: nothing configured → no sign-off at all, rather than a made-up one',
);

// ── 3. the first touch is answerable without replying ──────────────────────

const draftInput: DraftPersonalizationInput = {
  firmVoice: '',
  artistName: 'Ada Sample',
  trackName: 'Sample Single',
  labelName: 'Example Records',
  senderName: null,
  prefs,
  platform: 'tiktok',
  channel: 'email',
  creator: { handle: 'rowanmusic_example', bio: 'singer-songwriter', recentPosts: [] },
};

const checkBase = {
  artistName: 'Ada Sample',
  trackName: 'Sample Single' as string | null,
  creatorBio: 'singer-songwriter',
  creatorIsAuthor: true,
  releasePast: false,
  requiredSignoff: 'Example Records',
  allowedNames: ['Example Records', 'Ada Sample'],
};

for (const channel of ['email', 'dm'] as const) {
  const fb = buildFirstTouchFallback({ ...draftInput, channel });
  const label = `first touch (${channel})`;

  assert(
    checkDraftCopy({ body: fb.body, subject: fb.subject, ...checkBase }).length === 0,
    `${label}: clears the same validator the model copy has to clear`,
  );
  assert(
    checkOutreachCopy({
      subject: fb.subject,
      body: fb.body,
      artistName: 'Ada Sample',
      trackName: 'Sample Single',
      creatorBio: 'singer-songwriter',
      creatorIsAuthor: true,
      releasePast: false,
      priceUsd: null,
      confidentialAmounts: [5000, 250],
    }).length === 0,
    `${label}: clears the money layer too, and names no figure`,
  );

  // The four things a creator triages on.
  assert(fb.body.includes('Example Records'), `${label}: names the LABEL in the body, not just "we"`);
  assert(fb.body.includes('Ada Sample'), `${label}: names the artist`);
  assert(
    fb.body.includes('30-second reel') && fb.body.includes('15-second story'),
    `${label}: names the concrete deliverable, not "a paid post"`,
  );
  assert(/\bpaid\b|\bWe pay\b/i.test(fb.body), `${label}: says plainly that it is paid`);
  assert(
    /rate|what you charge/i.test(fb.body),
    `${label}: asks for their rate, which is what replaces naming a price`,
  );
  assert(
    /a no is a fine answer|say so and that's the end of it/i.test(fb.body),
    `${label}: gives an explicit way to decline`,
  );

  // The scam tells that were in the old copy.
  assert(
    !/sort the details/i.test(fb.body),
    `${label}: no "we'll sort the details" (a top scam phrasing, and it asks for a reply in exchange for nothing)`,
  );
  assert(
    !/a paid post\b/i.test(fb.body),
    `${label}: the phrase "a paid post" is gone entirely`,
  );

  // Identity.
  assert(
    fb.body.trimEnd().endsWith('Example Records'),
    `${label}: signs off with the label's configured sign-off`,
  );
  assert(
    checkDraftCopy({
      body: fb.body.replace('Hi @rowanmusic_example', "Hi @rowanmusic_example, I'm Dana"),
      subject: fb.subject,
      ...checkBase,
    }).some((v) => v.includes('Dana')),
    `${label}: an invented human name is caught by the validator`,
  );
}

// A DM's subject is thrown away by the queue, so the DM body must stand alone.
const dmFb = buildFirstTouchFallback({ ...draftInput, channel: 'dm' });
const emailFb = buildFirstTouchFallback({ ...draftInput, channel: 'email' });
assert(
  dmFb.body.length < emailFb.body.length,
  'first touch: the DM variant is shorter than the email variant (the initial path had no DM variant at all, while ~97% of the pool is DM)',
);
assert(dmFb.body.length < 400, 'first touch: the DM body stays inside a sane DM length');
assert(
  dmFb.body.includes('Example Records') &&
    dmFb.body.includes('Ada Sample') &&
    dmFb.body.includes('30-second reel'),
  'first touch: the DM body carries every fact on its own, because nothing else is shown',
);

// A sender name, when the label configures one, is allowed to appear.
assert(
  checkDraftCopy({
    body: "Hi @rowanmusic_example, I'm Alex from Example Records. Paid collab.\n\nAlex",
    subject: 'x',
    ...checkBase,
    requiredSignoff: 'Alex',
    allowedNames: ['Alex', 'Example Records', 'Ada Sample'],
  }).length === 0,
  'identity: a CONFIGURED sender name may introduce themselves',
);
assert(
  checkDraftCopy({ body: 'Hi. Sarah here. Paid collab.\n\nExample Records', subject: 'x', ...checkBase })
    .length > 0,
  'identity: "<Name> here" for an unconfigured person is caught',
);
assert(
  checkDraftCopy({ body: "Hi. I'm writing about a collab.\n\nExample Records", subject: 'x', ...checkBase })
    .length === 0,
  'identity: "I\'m writing" is not a name and must not false-positive',
);

// The ask can never degrade to nothing.
assert(
  firstTouchAsk().length > 0 && /reel|story|post/i.test(firstTouchAsk()),
  'ask: with no deliverables supplied the ask still defaults to the concrete standing package',
);
assert(firstTouchAsk('2 reels in a week') === '2 reels in a week', 'ask: a supplied package wins');

// ── 4. opt-out on every creator-facing message ─────────────────────────────

for (const channel of ['email', 'dm'] as const) {
  const line = optOutLine({ channel });
  assert(line.length > 0, `opt-out (${channel}): a line exists`);
  assert(
    checkDraftCopy({
      body: `Hi.\n\n${line}`,
      subject: 'x',
      artistName: 'Ada Sample',
      creatorIsAuthor: true,
      releasePast: false,
    }).length === 0,
    `opt-out (${channel}): the line is itself validator-clean (it is appended AFTER validation, so this is the only thing checking it)`,
  );
  assert(
    /unsubscribe|stop/i.test(line),
    `opt-out (${channel}): names the keyword the reply matcher recognises`,
  );
}
assert(
  optOutLine({ channel: 'email', unsubscribeUrl: 'https://x.test/u/abc' }).includes('https://x.test/u/abc'),
  'opt-out: a hosted URL is used when one exists',
);
{
  const once = appendOptOut('Body.', { channel: 'email' });
  assert(appendOptOut(once, { channel: 'email' }) === once, 'opt-out: appending twice does not duplicate the line');
}

// List-Unsubscribe: one-click ONLY over https, never over a bare mailto.
{
  const mailtoOnly = listUnsubscribeHeaders({ channel: 'email', replyAddress: 'hi@label-one.test' });
  assert(
    mailtoOnly['List-Unsubscribe'] === '<mailto:hi@label-one.test?subject=unsubscribe>',
    'List-Unsubscribe: a mailto header is built from the reply address',
  );
  assert(
    mailtoOnly['List-Unsubscribe-Post'] === undefined,
    'List-Unsubscribe: NO one-click POST advertised over a bare mailto (RFC 8058 one-click is an HTTP POST; advertising it makes Gmail attempt a POST that cannot work)',
  );
  const withUrl = listUnsubscribeHeaders({
    channel: 'email',
    replyAddress: 'hi@label-one.test',
    unsubscribeUrl: 'https://x.test/u/abc',
  });
  assert(
    withUrl['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click',
    'List-Unsubscribe: one-click IS advertised once an https endpoint exists',
  );
  assert(
    withUrl['List-Unsubscribe'].startsWith('<https://x.test/u/abc>'),
    'List-Unsubscribe: the URL is listed first, as clients prefer',
  );
  assert(
    Object.keys(listUnsubscribeHeaders({ channel: 'email' })).length === 0,
    'List-Unsubscribe: no address and no URL → no header at all, rather than asserting a mechanism we cannot honour',
  );
}

// The reply side of the promise. Destructive, so precision matters more than recall.
for (const yes of [
  'unsubscribe',
  'UNSUBSCRIBE',
  'stop',
  'STOP',
  'Stop.',
  'please stop',
  'remove me',
  'take me off your list',
  'do not contact me again',
  "don't email me",
  'opt out',
  'opt-out please',
  'stop contacting me',
]) {
  assert(isOptOutReply(yes), `opt-out reply: "${yes}" is an opt-out`);
}
for (const no of [
  "i can't stop listening to this",
  'nonstop requests lately',
  'my password manager broke',
  'not interested, thanks',
  'too busy this month',
  'stopped by the studio today',
  '',
]) {
  assert(
    !isOptOutReply(no),
    `opt-out reply: "${no}" is NOT an opt-out (blocklisting is global and permanent, so a false positive deletes a willing creator forever)`,
  );
}

// ── 5. the `[Creator Campaigns]` tag never reaches a live creator ─────────────────

assert(
  stripSubjectTag('[Creator Campaigns] Terms for the collab') === 'Terms for the collab',
  'tag: a leading tag is stripped',
);
assert(
  stripSubjectTag('Re: [Creator Campaigns] Terms for the collab') === 'Re: Terms for the collab',
  'tag: the reply marker survives the strip (threading must not break)',
);
assert(
  stripSubjectTag('[Creator Campaigns] Re: [Creator Campaigns] Terms') === 'Re: Terms',
  'tag: every occurrence goes, not just the first (a round-trip through a client can double it)',
);
assert(stripSubjectTag('Clean subject') === 'Clean subject', 'tag: a clean subject is untouched');
assert(stripSubjectTag(null) === '', 'tag: null is empty, not "null"');
assert(
  applySubjectTag('Terms', true) === '[Creator Campaigns] Terms',
  'tag: testing mode still tags, so testers can still filter their own inbox',
);
assert(
  applySubjectTag('[Creator Campaigns] Terms', false) === 'Terms',
  'tag: LIVE mode strips a tag that is already there',
);
assert(
  applySubjectTag(applySubjectTag('Terms', true), true) === '[Creator Campaigns] Terms',
  'tag: idempotent in both directions',
);

// The actual leak: the schedulers persisted the tag into outreach_messages, and
// threadSubject() then reused that stored subject for every later round. The
// send path only declined to ADD the tag, so the stored one went out verbatim.
assert(
  buildOutboundEnvelope({
    testingMode: false,
    subject: '[Creator Campaigns] Terms for the Ada Sample collab',
    campaignInfluencerId: 'ci-1',
    negotiationInboxEmail: 'deals@label-one.test',
  }).subject === 'Terms for the Ada Sample collab',
  'tag: a live send STRIPS an already-persisted tag, which is what the old "decline to add" could not do',
);
assert(
  buildOutboundEnvelope({ testingMode: true, subject: 'Terms' }).subject === '[Creator Campaigns] Terms',
  'tag: testing-mode envelope behaviour is unchanged',
);
assert(
  ensureSubjectTagPrefix('Terms') === '[Creator Campaigns] Terms',
  'tag: the original one-way helper still behaves for the Gmail intake filter',
);

// ── 6. the acceptance note stops promising an email to a pool without email ──

assert(
  !/email/i.test(nextStepSentence({ channel: 'dm', emailReachable: false }).split('If you')[0]),
  'next step: a DM creator with no address on file is not promised a "payment-setup email"',
);
assert(
  /send me the address|reply with the best email/i.test(nextStepSentence({ channel: 'dm', emailReachable: false })),
  'next step: instead it ASKS for the address, which is the only thing that makes the money path work for 97% of the pool',
);
assert(
  /payment details/i.test(nextStepSentence({ channel: 'email', emailReachable: true })),
  'next step: an email-reachable creator is told what is coming',
);
assert(
  !/\bquick\b|\bnext\b/i.test(nextStepSentence({ channel: 'email', emailReachable: true })),
  'next step: no unbacked clock ("quick", "next") in front of a human approval step and a randomised send window',
);

console.log(`first-touch test: ${passed} passed, ${failed} failed`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
