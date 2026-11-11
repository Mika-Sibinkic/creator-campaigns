// tests/dispatch-idempotency.test.ts
//
// WHAT THIS GUARDS: /api/negotiation/dispatch now runs EVERY MINUTE against
// maxDuration = 300, and pg_net fires the request without waiting for a
// response — so up to five runs can legitimately be in flight at once. The
// pass had no test of any kind (nothing in tests/ called runDispatchPass), and
// under that cadence it sent to Resend FIRST and then flipped the status with
// `.eq('id', …)` alone. Two overlapping runs both saw the row as `queued` in
// their SELECT, both called Resend, and the same message landed in a creator's
// inbox twice.
//
// The four things pinned here, and how each fails if it regresses:
//   1. One due row, two sequential runs → exactly one send. A read-then-write
//      guard passes this one, so it is necessary but not sufficient.
//   2. One due row, two OVERLAPPING runs → exactly one send. This is the test
//      the old code fails. Both passes read the row as queued before either
//      claims it, which is precisely the production interleaving.
//   3. A failed send RELEASES the claim. Claiming before sending means a
//      transient Resend failure must put the row back to `queued`, or it sits
//      at `sent` having never been sent and nothing ever retries it.
//   4. The per-run ceiling holds. Without it a bad send_after backfill drains
//      the whole queue into creators' inboxes in one minute.
//
// Hermetic: in-memory store, injected clock/rng/dispatch. No network, no DB,
// no real send.
//
// Run: npx tsx tests/dispatch-idempotency.test.ts

import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode
import {
  runDispatchPass,
  MAX_DISPATCH_PER_TICK,
  type DispatchFn,
} from '../src/lib/negotiation-tick';
import { makeStore, type Row } from './negotiation-harness/store';
import { inSendWindow } from '../src/lib/quiet-hours';

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

// 18:00Z is 13:00 at the default OUTREACH_TZ_OFFSET_HOURS of -5, so the 9am-9pm
// quiet-hours window is open and a due row is genuinely sendable. Asserted
// rather than assumed — if the window logic changes, every case below would
// otherwise silently start testing the deferral path instead.
const NOW = Date.parse('2026-09-24T18:00:00Z');
const rand = () => 0.5;

function seedDue(store: ReturnType<typeof makeStore>, id: string): Row {
  return store.seed('outreach_messages', {
    id,
    campaign_influencer_id: null,
    subject: 'Re: your rate',
    body: 'Following up on the package.',
    channel: 'email',
    direction: 'outbound',
    status: 'queued',
    send_mode: null,
    send_after: new Date(NOW - 60_000).toISOString(),
    sent_at: null,
    sent_to: null,
    provider_message_id: null,
  });
}

async function main() {
  assert(inSendWindow(NOW), 'the fixed clock sits inside the send window (otherwise every case below tests deferral)');

  // ── 1. Two sequential runs send once ──────────────────────────────────────
  {
    const store = makeStore();
    seedDue(store, 'm1');
    const calls: string[] = [];
    const dispatch: DispatchFn = async (_sb, msg) => {
      calls.push(msg.id);
      return { ok: true, resolved_to: 'creator@example.com', provider_message_id: 'prov-1' };
    };

    const first = await runDispatchPass(store.sb, { now: NOW, rand, dispatch });
    const second = await runDispatchPass(store.sb, { now: NOW + 1000, rand, dispatch });

    assert(first.sent === 1, `first run sends the due row (sent=${first.sent})`);
    assert(second.sent === 0, `second run sends nothing (sent=${second.sent})`);
    assert(calls.length === 1, `dispatch called exactly once across two runs (got ${calls.length})`);

    const row = store.all('outreach_messages').find((r) => r.id === 'm1');
    assert(row?.status === 'sent', `row ends at 'sent' (got '${String(row?.status)}')`);
    assert(row?.send_after === null, 'send_after is cleared so the due-scan cannot pick it up again');
    assert(
      row?.provider_message_id === 'prov-1' && row?.sent_to === 'creator@example.com',
      'the provider receipt is recorded after the send, not guessed before it'
    );
  }

  // ── 2. Two OVERLAPPING runs send once — the case the old code failed ─────
  {
    const store = makeStore();
    seedDue(store, 'm2');
    const calls: string[] = [];
    let release: (() => void) | null = null;
    const bothInFlight = new Promise<void>((r) => {
      release = r;
    });
    const dispatch: DispatchFn = async (_sb, msg) => {
      calls.push(msg.id);
      // Hold the first send open so the second pass is definitely running
      // while this one is mid-flight — the production shape, where a 300s
      // maxDuration overlaps four later minute-ticks.
      release?.();
      await bothInFlight;
      return { ok: true, resolved_to: 'creator@example.com', provider_message_id: 'prov-2' };
    };

    const tallies = await Promise.all([
      runDispatchPass(store.sb, { now: NOW, rand, dispatch }),
      runDispatchPass(store.sb, { now: NOW, rand, dispatch }),
    ]);

    assert(
      calls.length === 1,
      `two overlapping runs call dispatch exactly once (got ${calls.length}) — ` +
        `more than one means the same message reached a creator twice`
    );
    const totalSent = tallies[0].sent + tallies[1].sent;
    assert(totalSent === 1, `exactly one run claims the send (total sent=${totalSent})`);
    assert(
      tallies[0].skipped + tallies[1].skipped === 1,
      'the losing run reports skipped rather than an error — losing the race is not a failure'
    );
    const rows = store.all('outreach_messages').filter((r) => r.id === 'm2');
    assert(rows.length === 1 && rows[0].status === 'sent', 'the row is sent exactly once');
  }

  // ── 3. A failed send releases the claim ───────────────────────────────────
  {
    const store = makeStore();
    seedDue(store, 'm3');
    let attempt = 0;
    const dispatch: DispatchFn = async () => {
      attempt += 1;
      return attempt === 1
        ? { ok: false, error: 'resend 503' }
        : { ok: true, resolved_to: 'creator@example.com', provider_message_id: 'prov-3' };
    };

    const firstTally = await runDispatchPass(store.sb, { now: NOW, rand, dispatch });
    const afterFail = store.all('outreach_messages').find((r) => r.id === 'm3');
    assert(firstTally.sent === 0 && firstTally.skipped === 1, 'a failed send counts as skipped, not sent');
    assert(
      afterFail?.status === 'queued',
      `a failed send returns the row to 'queued' (got '${String(afterFail?.status)}') — ` +
        `left at 'sent' it would never be retried and the message is lost`
    );
    assert(afterFail?.sent_at === null, 'sent_at is cleared too, so the row is not half-sent');
    assert(
      typeof afterFail?.send_after === 'string' && Date.parse(afterFail.send_after as string) > NOW,
      'the retry is backed off into the future rather than hammering the next tick'
    );

    // And it really is retryable: once the backoff passes, the row sends.
    const retry = await runDispatchPass(store.sb, { now: NOW + 200_000, rand, dispatch });
    assert(retry.sent === 1, `the released row sends on a later run (sent=${retry.sent})`);
    assert(attempt === 2, 'exactly two dispatch attempts total — one failed, one succeeded');
  }

  // ── 4. The per-run ceiling bounds the blast radius ────────────────────────
  {
    const store = makeStore();
    const total = MAX_DISPATCH_PER_TICK + 5;
    for (let i = 0; i < total; i++) seedDue(store, `bulk-${i}`);
    const calls: string[] = [];
    const dispatch: DispatchFn = async (_sb, msg) => {
      calls.push(msg.id);
      return { ok: true, resolved_to: 'creator@example.com', provider_message_id: `p-${msg.id}` };
    };

    const tally = await runDispatchPass(store.sb, { now: NOW, rand, dispatch });
    assert(
      tally.sent === MAX_DISPATCH_PER_TICK,
      `one run sends at most MAX_DISPATCH_PER_TICK (${MAX_DISPATCH_PER_TICK}); got ${tally.sent}`
    );
    assert(calls.length === MAX_DISPATCH_PER_TICK, `and calls Resend exactly that many times (got ${calls.length})`);
    const stillQueued = store
      .all('outreach_messages')
      .filter((r) => String(r.id).startsWith('bulk-') && r.status === 'queued');
    assert(stillQueued.length === 5, `the remainder stays queued for the next minute (got ${stillQueued.length})`);
    assert(MAX_DISPATCH_PER_TICK > 0 && MAX_DISPATCH_PER_TICK <= 100, 'the ceiling is a real bound, not effectively infinite');
  }

  if (failures.length > 0) console.error('\nFailures:\n - ' + failures.join('\n - '));
  console.log(`dispatch-idempotency test: ${passed}/${passed + failed} pass`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
