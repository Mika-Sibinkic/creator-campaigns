// tests/outreach-send.test.ts
//
// Unit tests for the two pure modules the outreach send path depends on for
// TRUTHFUL operator-facing reporting:
//
//   src/lib/channels/outbound-envelope.ts — what subject + Reply-To a send
//     actually puts on the wire, in BOTH testing and live mode. The live-mode
//     Reply-To is the only durable correlation anchor (live sends carry no
//     `[Creator Campaigns]` subject tag), so a null there silently kills the reply
//     loop.
//   src/lib/outreach-send-copy.ts — the bulk-send confirm copy and the result
//     summary. Both used to assert things that were not true: the dialogs
//     hardcoded "in testing mode / to your test inbox" with zero reads of
//     firms.testing_mode, and the bulk loops counted HTTP 409 (already sent /
//     dm_queue / stale_draft) as "sent".
//
// Hermetic: both modules are dependency-free (no env, no SDK, no network).
//
// Run: npx tsx tests/outreach-send.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOutboundEnvelope } from '../src/lib/channels/outbound-envelope';
import {
  classifySendResponse,
  emptyTally,
  tallyOutcome,
  bulkSendConfirmCopy,
  sendModeFromTestingMode,
  summarizeSendTally,
  type SendTally,
} from '../src/lib/outreach-send-copy';

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

const CI = '3f9c2a1e-7b4d-4e0a-9c66-2d8f5b1a0c3e';

// ── 1. Outbound envelope: the subject tag is a TESTING-mode nicety ──────────
{
  const testing = buildOutboundEnvelope({
    testingMode: true,
    subject: 'Collab on "Sample Single"',
    campaignInfluencerId: CI,
    negotiationInboxEmail: null,
    fromEmail: 'hello@examplerecords.example',
  });
  assert(
    testing.subject === '[Creator Campaigns] Collab on "Sample Single"',
    'envelope: testing mode prefixes the [Creator Campaigns] subject tag',
  );

  const live = buildOutboundEnvelope({
    testingMode: false,
    subject: 'Collab on "Sample Single"',
    campaignInfluencerId: CI,
    negotiationInboxEmail: null,
    fromEmail: 'hello@examplerecords.example',
  });
  assert(
    live.subject === 'Collab on "Sample Single"',
    'envelope: live mode ships the subject untouched (creators never see the tag)',
  );
}

// ── 2. Envelope: the correlated Reply-To is stamped in BOTH modes ───────────
// This is the invariant the whole reply loop rests on. Live mode has no
// subject tag, so if the Reply-To is missing there is nothing to correlate on.
{
  for (const testingMode of [true, false]) {
    const e = buildOutboundEnvelope({
      testingMode,
      subject: 'Collab',
      campaignInfluencerId: CI,
      negotiationInboxEmail: null,
      fromEmail: 'hello@examplerecords.example',
    });
    assert(
      e.replyTo === `hello+lead-${CI}@examplerecords.example`,
      `envelope: testing_mode=${testingMode} still stamps the correlated Reply-To`,
    );
    assert(e.correlated === true, `envelope: testing_mode=${testingMode} reports correlated=true`);
  }

  // Per-firm negotiation inbox wins over the sender when it is set.
  const withInbox = buildOutboundEnvelope({
    testingMode: false,
    subject: 'Collab',
    campaignInfluencerId: CI,
    negotiationInboxEmail: 'replies@examplerecords.example',
    fromEmail: 'hello@examplerecords.example',
  });
  assert(
    withInbox.replyTo === `replies+lead-${CI}@examplerecords.example`,
    'envelope: negotiation_inbox_email wins over the sender address',
  );

  // An explicit caller Reply-To wins, but correlation must not be silently
  // lost — the envelope reports that it dropped the correlation anchor.
  const explicit = buildOutboundEnvelope({
    testingMode: false,
    subject: 'Collab',
    campaignInfluencerId: CI,
    explicitReplyTo: 'someone-else@example.com',
    negotiationInboxEmail: null,
    fromEmail: 'hello@examplerecords.example',
  });
  assert(explicit.replyTo === 'someone-else@example.com', 'envelope: explicit reply_to wins');
  assert(explicit.correlated === false, 'envelope: explicit reply_to reports correlated=false');

  // No campaign_influencer_id (e.g. a promo-material send) → no correlation.
  const noCi = buildOutboundEnvelope({
    testingMode: false,
    subject: 'Collab',
    negotiationInboxEmail: null,
    fromEmail: 'hello@examplerecords.example',
  });
  assert(noCi.replyTo === undefined, 'envelope: no ci id → no reply-to invented');
  assert(noCi.correlated === false, 'envelope: no ci id → correlated=false');

  // Unusable base addresses → undefined, never a guessed address.
  const junk = buildOutboundEnvelope({
    testingMode: false,
    subject: 'Collab',
    campaignInfluencerId: CI,
    negotiationInboxEmail: 'not-an-email',
    fromEmail: 'also-not-an-email',
  });
  assert(junk.replyTo === undefined, 'envelope: unusable base → undefined, never guessed');
  assert(junk.correlated === false, 'envelope: unusable base → correlated=false');
}

// ── 3. 409 is NOT "sent" ────────────────────────────────────────────────────
{
  assert(classifySendResponse(200, {}) === 'sent', '409-split: 200 → sent');
  assert(
    classifySendResponse(409, { error: 'already sent' }) === 'already_sent',
    '409-split: 409 already sent → already_sent (NOT sent)',
  );
  assert(
    classifySendResponse(409, { error: 'dm_queue' }) === 'dm_queue',
    '409-split: 409 dm_queue → dm_queue (NOT sent)',
  );
  assert(
    classifySendResponse(409, { error: 'stale_draft' }) === 'stale_draft',
    '409-split: 409 stale_draft → stale_draft (NOT sent)',
  );
  assert(
    classifySendResponse(409, { error: 'window_closed' }) === 'window_closed',
    '409-split: 409 window_closed → window_closed (NOT already_sent)',
  );
  assert(
    classifySendResponse(409, null) === 'already_sent',
    '409-split: unparseable 409 → already_sent',
  );
  assert(classifySendResponse(500, { error: 'boom' }) === 'failed', '409-split: 500 → failed');
  assert(classifySendResponse(403, null) === 'failed', '409-split: 403 → failed');
}

// A window-closed batch must not be reported as "already sent (skipped)".
// Without its own bucket the 409 fell through the classifier's catch-all and
// the operator was told the messages had already gone out, when in fact the
// campaign window had stopped them.
function windowClosedIsReportedAsItsOwnOutcome() {
  const tally = emptyTally();
  tallyOutcome(tally, 'window_closed');
  tallyOutcome(tally, 'window_closed');
  const summary = summarizeSendTally(tally, 'live');
  assert(
    summary.message.includes('campaign window has closed'),
    `window_closed: the summary names the window as the reason (got "${summary.message}")`,
  );
  assert(
    !summary.message.includes('already sent'),
    'window_closed: it is never reported as "already sent" — nothing was sent',
  );
  assert(
    summary.level === 'warning',
    `window_closed: a blocked batch is a warning, not a success (got ${summary.level})`,
  );
}
windowClosedIsReportedAsItsOwnOutcome();

// ── 4. The summary reports every outcome, separately and truthfully ─────────
{
  const t: SendTally = {
    ...emptyTally(),
    sent: 2,
    dm_queue: 1,
    stale_draft: 1,
    already_sent: 1,
    failed: 1,
  };
  const s = summarizeSendTally(t, 'testing');
  assert(/\b2 sent\b/.test(s.message), 'summary: names the sent count');
  assert(/DM queue/i.test(s.message), 'summary: names the DM-queue outcome');
  assert(/stale/i.test(s.message), 'summary: names the stale-draft outcome');
  assert(/already sent/i.test(s.message), 'summary: names the already-sent outcome');
  assert(/1 failed/.test(s.message), 'summary: names the failed count');
  assert(s.level === 'error', 'summary: any failure → error level');

  // A pure DM-queue batch must NOT read as a clean success.
  const dmOnly = summarizeSendTally({ ...emptyTally(), dm_queue: 3 }, 'testing');
  assert(dmOnly.level !== 'success', 'summary: 0 sent + 3 dm_queue is not a success');
  assert(!/\b3 sent\b/.test(dmOnly.message), 'summary: dm_queue is never counted as sent');

  const clean = summarizeSendTally({ ...emptyTally(), sent: 4 }, 'testing');
  assert(clean.level === 'success', 'summary: all-sent → success');
  assert(/testing mode/i.test(clean.message), 'summary: testing-mode batch is labelled testing');

  const live = summarizeSendTally({ ...emptyTally(), sent: 4 }, 'live');
  assert(/live/i.test(live.message), 'summary: live batch is labelled live');
  assert(!/testing mode/i.test(live.message), 'summary: live batch never claims testing mode');

  const nothing = summarizeSendTally(emptyTally(), 'testing');
  assert(nothing.level === 'info', 'summary: empty tally → info');
}

// ── 5. Confirm copy DERIVES from testing_mode — never hardcoded ─────────────
{
  assert(sendModeFromTestingMode(true) === 'testing', 'mode: testing_mode=true → testing');
  assert(sendModeFromTestingMode(false) === 'live', 'mode: testing_mode=false → live');
  assert(sendModeFromTestingMode(null) === 'unknown', 'mode: unreadable testing_mode → unknown');

  const testing = bulkSendConfirmCopy({
    mode: 'testing',
    count: 5,
    testRecipient: 'operator@operator.example',
  });
  assert(/testing/i.test(testing.title), 'copy: testing title names testing mode');
  assert(
    testing.body.includes('operator@operator.example'),
    'copy: testing body names the resolved test recipient',
  );
  assert(!/real creator/i.test(testing.body), 'copy: testing body does not threaten real creators');

  // THE BUG: live mode must never say "testing mode" or "your test inbox".
  const live = bulkSendConfirmCopy({
    mode: 'live',
    count: 5,
    testRecipient: 'operator@operator.example',
  });
  assert(
    !/testing mode/i.test(live.title + live.body),
    'copy: LIVE copy never says "testing mode"',
  );
  assert(!/test inbox/i.test(live.title + live.body), 'copy: LIVE copy never says "test inbox"');
  assert(/live/i.test(live.title), 'copy: live title says LIVE');
  assert(/real/i.test(live.body), 'copy: live body says the messages go to real creators');
  assert(live.destructive === true, 'copy: live confirm is marked destructive');
  assert(testing.destructive === false, 'copy: testing confirm is not destructive');

  const unknown = bulkSendConfirmCopy({ mode: 'unknown', count: 5, testRecipient: null });
  assert(!/testing mode is on/i.test(unknown.body), 'copy: unknown mode never asserts testing mode');
  assert(/unknown|could not/i.test(unknown.body), 'copy: unknown mode says so plainly');

  // Testing mode with no recipient configured: say it will fail, do not lie.
  const noRecipient = bulkSendConfirmCopy({ mode: 'testing', count: 1, testRecipient: null });
  assert(/not set|fail/i.test(noRecipient.body), 'copy: testing with no recipient warns it will fail');

  // Pluralization.
  assert(
    /\b1 draft\b/.test(bulkSendConfirmCopy({ mode: 'testing', count: 1, testRecipient: 'a@b.test' }).title),
    'copy: singular draft',
  );
  assert(
    /\b2 drafts\b/.test(bulkSendConfirmCopy({ mode: 'testing', count: 2, testRecipient: 'a@b.test' }).title),
    'copy: plural drafts',
  );
}

// ── REGRESSION GUARD: a Resend API error must not report success ──────────
//
// The Resend SDK does NOT throw on API-level failures — it RESOLVES with
// `{ data: null, error }`. sendOutreach() read only `r.data?.id` and returned
// `{ ok: true, message_id: undefined }`, so on daily_quota_exceeded or
// rate_limit_exceeded the caller marked the row 'sent', the audit trail said
// ok, and NO EMAIL EXISTED. It fails in bursts — a quota ceiling hits every
// remaining send in the run — so the quiet version of this is a whole
// campaign's outreach silently evaporating.
//
// It is also what capped the delivery-correlation work: a send with no
// message_id stamps provider_message_id NULL, and the webhook can never
// match it.
//
// This is a SOURCE guard, not a behavioral one, and deliberately so:
// src/lib/resend.ts is the testing-mode recipient fork ("a bug here emails
// real creators"), and adding a runtime client seam to swap the SDK is a
// bigger change to that file than this fix warrants. It proves the check is
// present and that success is gated on a real id — which is the thing a
// future refactor would remove.
function testResendErrorIsNotReportedAsSuccess() {
  const src = readFileSync(join(process.cwd(), 'src/lib/resend.ts'), 'utf8');
  assert(
    /if\s*\(\s*r\.error\s*\|\|\s*!r\.data\?\.id\s*\)/.test(src),
    'sendOutreach inspects r.error and a missing message id before claiming success',
  );
  assert(
    /return \{ ok: true, resolved_to, message_id: r\.data\.id/.test(src),
    'the success return reads r.data.id non-optionally — reachable only past the guard',
  );
  assert(
    !/return \{ ok: true, resolved_to, message_id: r\.data\?\.id/.test(src),
    'the old optional-chained success return is gone (it was the bug: undefined id, ok:true)',
  );
  const guardAt = src.indexOf('r.error ||');
  const successAt = src.indexOf('return { ok: true, resolved_to, message_id: r.data.id');
  assert(
    guardAt > -1 && successAt > -1 && guardAt < successAt,
    'the guard precedes the success return',
  );
}
testResendErrorIsNotReportedAsSuccess();
// ── Pool-gate refusals are reported as refusals, not as "already sent" ──────
//
// The send route now returns 409 {error:'excluded'} for a creator the pool
// gates rule out — blocklisted, over the firm's follower cap, outside its
// audience-fit band, or already excluded in qualification. Every other 409
// falls into the already_sent catch-all, and landing there would have told
// the operator a message went out at some point. It did not, and the row is
// not sendable at all: that is a different fact needing a different action.
{
  assert(
    classifySendResponse(409, { error: 'excluded' }) === 'excluded',
    'excluded: a pool-gate refusal is its own outcome',
  );
  assert(
    classifySendResponse(409, { error: 'excluded' }) !== 'already_sent',
    'excluded: NOT reported as already sent — nothing was ever sent to this creator',
  );
  assert(
    classifySendResponse(409, { error: 'already sent' }) === 'already_sent',
    'excluded: the other 409s are untouched',
  );
  assert(
    classifySendResponse(409, null) === 'already_sent',
    'excluded: an unparseable 409 still uses the conservative catch-all',
  );

  const t = emptyTally();
  assert(t.excluded === 0, 'excluded: the tally starts the new bucket at zero');
  t.sent = 2;
  t.excluded = 3;
  const sum = summarizeSendTally(t, 'live');
  assert(
    /3 not contacted/.test(sum.message),
    `excluded: the summary counts them as not contacted (got "${sum.message}")`,
  );
  assert(
    !/already sent/.test(sum.message),
    'excluded: the summary never calls a gated creator already sent',
  );
  assert(
    /creator pool/.test(sum.message),
    'excluded: the summary says WHY, so the operator can act on it',
  );
  assert(sum.level === 'warning', 'excluded: a partial send with refusals is a warning, not a success');

  const clean = emptyTally();
  clean.sent = 2;
  assert(
    summarizeSendTally(clean, 'live').level === 'success',
    'excluded: a run with no refusals is still a clean success',
  );
}

console.log(`outreach-send test: ${passed} passed, ${failed} failed`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
