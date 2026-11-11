// tests/channel-priors.test.ts
//
// The ATOMIC channel-prior increment (migration 043 + the RPC-first path in
// src/lib/channel-priors.ts), and the funnel semantics that decide which
// senders may touch the counters at all. Hermetic: in-memory Supabase mock,
// no network, no DB.
//
// tests/channel-routing.test.ts already covers the legacy read-modify-write
// path end to end (the harness store has no .rpc, so every assertion there
// exercises the fallback). This suite covers what that one structurally
// cannot: the branch taken once 043 is applied.
//
// Proves:
//   1. With a client that has .rpc, bumpPrior calls bump_channel_prior exactly
//      once with the right args and does NOT fall back — no read, no write.
//   2. The RPC path loses no counts under concurrency: N concurrent bumps of
//      the same (firm, channel) land exactly N increments. This is the whole
//      reason 043 exists.
//   3. Pre-apply (the RPC returns "function does not exist") bumpPrior falls
//      back to the legacy path and the counter still moves exactly once —
//      behavior before the migration is byte-identical to today.
//   4. An RPC that THROWS degrades the same way, and a client with no .rpc at
//      all (the harness store) still works.
//   5. The cheap guards run BEFORE the RPC: unknown channel, unmapped channel
//      and a missing firm never reach the database at all.
//   6. dispatchDue does NOT bump 'sent'. Every row it can send is a follow-up
//      inside an already-open thread, and `replies` is first-reply-only, so
//      counting them would inflate the denominator and make a channel score
//      worse the more rounds it negotiates.
//
// Run: npx tsx tests/channel-priors.test.ts

import './negotiation-harness/setup-env'; // FIRST — dummy env, no network
import { bumpPrior } from '../src/lib/channel-priors';
import { runNegotiationTick, type DispatchFn } from '../src/lib/negotiation-tick';
import { makeStore, type MockStore, type Row } from './negotiation-harness/store';
import type { SupabaseClient } from '@supabase/supabase-js';

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

// 18:00Z is 13:00 in the outreach timezone (OUTREACH_TZ_OFFSET_HOURS,
// default -5), i.e. INSIDE the 9am-9pm quiet-hours send window that
// src/lib/quiet-hours.ts applies to dispatchDue. This used to be 12:00Z,
// which is 07:00 local: outside the window, so every due row in the
// follow-up scenario below was deferred to the next opening instead of
// sent, and tally.sent was 0. The scenario is about dispatchDue NOT
// bumping the 'sent' prior, not about quiet hours, so it has to run at a
// time when sending is actually allowed. Quiet-hours behaviour itself is
// covered by tests/quiet-hours.test.ts and tests/negotiation-tick.test.ts.
const NOW0 = Date.parse('2026-09-17T18:00:00.000Z');
const HALF_RAND = () => 0.5;
const noopPoll = async () => ({ skipped: 'gmail_not_configured' as const });

type RpcCall = { fn: string; args: Record<string, unknown> };

interface RpcHarness {
  sb: SupabaseClient;
  store: MockStore;
  calls: RpcCall[];
  /** Rows the LEGACY path would have gone through, to prove it was skipped. */
  priors(): Row[];
}

/**
 * The harness store plus a faithful stand-in for migration 043's
 * bump_channel_prior: it validates its inputs exactly as the SQL does
 * (RAISE EXCEPTION on an unknown event/channel) and performs the
 * INSERT … ON CONFLICT DO UPDATE as one indivisible step, which is what makes
 * the counter atomic.
 *
 * `mode` picks the failure being simulated:
 *   'live'      — 043 applied.
 *   'absent'    — pre-apply: PostgREST cannot find the function.
 *   'ambiguous' — a statement timeout: the increment may or may not have
 *                 committed server-side.
 *   'throws'    — the client itself blows up (network, aborted fetch).
 */
function makeRpcHarness(mode: 'live' | 'absent' | 'throws' | 'ambiguous' = 'live'): RpcHarness {
  const store = makeStore();
  const calls: RpcCall[] = [];

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (mode === 'throws') throw new Error('network: connection reset');
    if (mode === 'absent') {
      return {
        data: null,
        error: {
          code: 'PGRST202',
          message: 'Could not find the function public.bump_channel_prior in the schema cache',
        },
      };
    }
    if (mode === 'ambiguous') {
      // A failure that says NOTHING about whether the increment committed.
      return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
    }
    const firmId = args.p_firm_id as string | null;
    const channel = args.p_channel as string;
    const event = args.p_event as string;
    if (firmId == null) return { data: null, error: null }; // SQL: RETURN
    if (!['sent', 'reply', 'deal'].includes(event)) {
      return { data: null, error: { message: `bump_channel_prior: unknown event ${event}` } };
    }
    if (!['email', 'instagram_dm', 'tiktok_dm'].includes(channel)) {
      return { data: null, error: { message: `bump_channel_prior: unknown channel ${channel}` } };
    }
    // INSERT … ON CONFLICT (firm_id, channel) DO UPDATE with relative
    // increments. Synchronous here on purpose: one indivisible step is exactly
    // the property the SQL buys and the read-modify-write lacks.
    const rows = store.all('channel_conversion_priors');
    const existing = rows.find((r) => r.firm_id === firmId && r.channel === channel);
    const col = { sent: 'sent', reply: 'replies', deal: 'deals' }[event] as string;
    const obs = { sent: 'observed_sent', reply: 'observed_replies', deal: 'observed_deals' }[
      event
    ] as string;
    if (existing) {
      existing[col] = Number(existing[col] ?? 0) + 1;
      existing[obs] = Number(existing[obs] ?? 0) + 1;
    } else {
      store.seed('channel_conversion_priors', {
        id: `rpc-${channel}`,
        firm_id: firmId,
        channel,
        sent: event === 'sent' ? 1 : 0,
        replies: event === 'reply' ? 1 : 0,
        deals: event === 'deal' ? 1 : 0,
        observed_sent: event === 'sent' ? 1 : 0,
        observed_replies: event === 'reply' ? 1 : 0,
        observed_deals: event === 'deal' ? 1 : 0,
      });
    }
    return { data: null, error: null };
  };

  const base = store.sb as unknown as Record<string, unknown>;
  const sb = {
    from: (t: string) => (base.from as (x: string) => unknown)(t),
    rpc,
  } as unknown as SupabaseClient;

  return { sb, store, calls, priors: () => store.all('channel_conversion_priors') };
}

const priorRow = (h: RpcHarness, channel: string): Row | undefined =>
  h.priors().find((r) => r.channel === channel);

// ── 1. The RPC is preferred, called once, with the right arguments ───────────

async function scenarioRpcPreferred() {
  const h = makeRpcHarness('live');

  await bumpPrior(h.sb, { firmId: 'firm-1', channel: 'email', event: 'sent' });

  assert(h.calls.length === 1, `rpc: called exactly once (got ${h.calls.length})`);
  assert(h.calls[0]?.fn === 'bump_channel_prior', `rpc: function name (got ${h.calls[0]?.fn})`);
  assert(
    h.calls[0]?.args.p_firm_id === 'firm-1' &&
      h.calls[0]?.args.p_channel === 'email' &&
      h.calls[0]?.args.p_event === 'sent',
    `rpc: args passed through verbatim (got ${JSON.stringify(h.calls[0]?.args)})`,
  );
  assert(priorRow(h, 'email')?.sent === 1, 'rpc: cold row created with sent=1');
  assert(
    priorRow(h, 'email')?.observed_sent === 1,
    'rpc: the OBSERVED counter moves too (043) — the one the scoring blend reads',
  );

  // A platform name still normalizes BEFORE the call — the SQL only accepts
  // the three real channels and would otherwise raise.
  await bumpPrior(h.sb, { firmId: 'firm-1', channel: 'tiktok', event: 'reply' });
  assert(
    h.calls[1]?.args.p_channel === 'tiktok_dm',
    `rpc: platform "tiktok" normalized to tiktok_dm before the call (got ${h.calls[1]?.args.p_channel})`,
  );
  assert(priorRow(h, 'tiktok_dm')?.replies === 1, 'rpc: reply lands on the replies column');

  // Existing row increments in place, no duplicate.
  await bumpPrior(h.sb, { firmId: 'firm-1', channel: 'email', event: 'sent' });
  await bumpPrior(h.sb, { firmId: 'firm-1', channel: 'email', event: 'deal' });
  const emailRows = h.priors().filter((r) => r.channel === 'email');
  assert(emailRows.length === 1, `rpc: one row per (firm, channel) (got ${emailRows.length})`);
  assert(emailRows[0].sent === 2, `rpc: sent 1→2 in place (got ${emailRows[0].sent})`);
  assert(emailRows[0].deals === 1, `rpc: deals 0→1 (got ${emailRows[0].deals})`);
  assert(emailRows[0].replies === 0, 'rpc: untouched counters stay put');
}

// ── 2. No count is lost under concurrency (the point of 043) ─────────────────

async function scenarioAtomicUnderConcurrency() {
  const h = makeRpcHarness('live');
  const N = 25;

  await Promise.all(
    Array.from({ length: N }, () =>
      bumpPrior(h.sb, { firmId: 'firm-1', channel: 'instagram_dm', event: 'sent' }),
    ),
  );

  assert(h.calls.length === N, `atomic: ${N} calls issued (got ${h.calls.length})`);
  assert(
    priorRow(h, 'instagram_dm')?.sent === N,
    `atomic: ${N} concurrent bumps land ${N} counts, none lost (got ${priorRow(h, 'instagram_dm')?.sent})`,
  );
  assert(
    h.priors().filter((r) => r.channel === 'instagram_dm').length === 1,
    'atomic: concurrent cold-row bumps never double-insert',
  );
}

// ── 3-4. Every degraded client still increments exactly once ────────────────

async function scenarioDegradesToLegacy() {
  // 3. Pre-apply: the function does not exist yet.
  const absent = makeRpcHarness('absent');
  absent.store.seed('channel_conversion_priors', {
    id: 'p-email',
    firm_id: 'firm-1',
    channel: 'email',
    sent: 100,
    replies: 7,
    deals: 1,
  });
  await bumpPrior(absent.sb, { firmId: 'firm-1', channel: 'email', event: 'reply' });
  assert(absent.calls.length === 1, 'pre-apply: the RPC was attempted');
  assert(
    priorRow(absent, 'email')?.replies === 8,
    `pre-apply: legacy path still incremented 7→8 (got ${priorRow(absent, 'email')?.replies})`,
  );
  assert(priorRow(absent, 'email')?.sent === 100, 'pre-apply: no other counter moved');
  assert(
    absent.priors().length === 1,
    `pre-apply: no duplicate row created by the fallback (got ${absent.priors().length})`,
  );

  // 4a. AMBIGUOUS failures must NOT fall back (review finding N4). A statement
  //     timeout can arrive after the server already committed, so retrying
  //     through the legacy path would double-count a funnel event that
  //     happened once. Dropping one advisory, Laplace-smoothed count is noise;
  //     fabricating one is not.
  const ambiguous = makeRpcHarness('ambiguous');
  ambiguous.store.seed('channel_conversion_priors', {
    id: 'p-amb',
    firm_id: 'firm-1',
    channel: 'email',
    sent: 100,
    replies: 7,
    deals: 1,
    observed_sent: 4,
    observed_replies: 1,
    observed_deals: 0,
  });
  await bumpPrior(ambiguous.sb, { firmId: 'firm-1', channel: 'email', event: 'sent' });
  assert(ambiguous.calls.length === 1, 'ambiguous: the RPC was attempted');
  assert(
    priorRow(ambiguous, 'email')?.sent === 100,
    `ambiguous: no legacy double-apply (sent stayed 100, got ${priorRow(ambiguous, 'email')?.sent})`,
  );
  assert(
    priorRow(ambiguous, 'email')?.observed_sent === 4,
    'ambiguous: the observed counter is not double-applied either',
  );

  // 4b. A client whose rpc throws outright — same reasoning, same posture.
  const thrown = makeRpcHarness('throws');
  await bumpPrior(thrown.sb, { firmId: 'firm-1', channel: 'email', event: 'sent' });
  assert(thrown.calls.length === 1, 'rpc-throws: the RPC was attempted');
  assert(
    thrown.priors().length === 0,
    `rpc-throws: a transport failure drops rather than risking a double-apply (got ${JSON.stringify(thrown.priors())})`,
  );

  // 4c. A client with no .rpc member at all (the plain harness store).
  const plain = makeStore();
  await bumpPrior(plain.sb, { firmId: 'firm-1', channel: 'email', event: 'deal' });
  const plainRows = plain.all('channel_conversion_priors');
  assert(plainRows.length === 1 && plainRows[0].deals === 1, 'no-rpc client: legacy path still works');

  // And the whole thing still never throws, whatever the client does.
  let threw = false;
  try {
    const hostile = { from: () => { throw new Error('boom'); }, rpc: () => { throw new Error('boom'); } };
    await bumpPrior(hostile as unknown as SupabaseClient, {
      firmId: 'firm-1',
      channel: 'email',
      event: 'sent',
    });
  } catch {
    threw = true;
  }
  assert(!threw, 'a totally broken client never takes down the caller');
}

// ── 5. The guards run before the database ───────────────────────────────────

async function scenarioGuardsShortCircuit() {
  const h = makeRpcHarness('live');

  await bumpPrior(h.sb, { firmId: null, channel: 'email', event: 'sent' });
  await bumpPrior(h.sb, { firmId: undefined, channel: 'email', event: 'sent' });
  await bumpPrior(h.sb, { firmId: 'firm-1', channel: 'carrier_pigeon', event: 'sent' });
  await bumpPrior(h.sb, { firmId: 'firm-1', channel: 'linkedin_dm', event: 'sent' });
  await bumpPrior(h.sb, { firmId: 'firm-1', channel: 'dm', event: 'sent' });
  await bumpPrior(h.sb, { firmId: 'firm-1', channel: null, event: 'sent' });

  assert(h.calls.length === 0, `guards: nothing unmapped reaches the RPC (got ${h.calls.length} calls)`);
  assert(h.priors().length === 0, 'guards: nothing unmapped reaches the table either');
}

// ── 6. dispatchDue must NOT bump 'sent' ─────────────────────────────────────

async function scenarioFollowUpSendsDoNotBump() {
  const h = makeRpcHarness('live');
  const store = h.store;

  store.seed('campaign_influencers', {
    id: 'ci-D',
    campaign_id: 'camp-D',
    influencer_id: 'inf-D',
    primary_channel: 'email',
  });
  store.seed('influencers', { id: 'inf-D', display_name: 'Rae', username: 'rae', platform: 'tiktok' });

  // The three inserts that actually set send_after — i.e. the complete set of
  // rows dispatchDue can ever pick up.
  for (const [id, type] of [
    ['msg-counter', 'counter'],
    ['msg-accept', 'agreement_confirmation'],
    ['msg-payout', 'payout_onboarding'],
  ] as const) {
    store.seed('outreach_messages', {
      id,
      campaign_influencer_id: 'ci-D',
      direction: 'outbound',
      status: 'queued',
      message_type: type,
      channel: 'email',
      subject: 's',
      body: 'b',
      send_after: new Date(NOW0 - 60_000).toISOString(),
      send_mode: null,
    });
  }

  const dispatch: DispatchFn = async () => ({ ok: true, resolved_to: 'x@example.com' });
  const tally = await runNegotiationTick(h.sb, {
    now: NOW0,
    rand: HALF_RAND,
    dispatch,
    pollGmail: noopPoll,
  });

  assert(tally.sent === 3, `follow-ups: all three due rows dispatched (got ${tally.sent})`);
  assert(
    store.all('outreach_messages').every((r) => r.status === 'sent'),
    'follow-ups: every due row flipped to sent',
  );
  assert(
    h.calls.length === 0,
    `follow-ups: dispatchDue issues no prior bump (got ${h.calls.length} RPC calls)`,
  );
  assert(
    h.priors().length === 0,
    `follow-ups: the sent denominator is untouched by follow-up sends (got ${JSON.stringify(h.priors())})`,
  );
}

async function main() {
  const quiet = !process.env.DEBUG;
  const realWarn = console.warn;
  const realError = console.error;
  if (quiet) {
    console.warn = () => {};
    console.error = (...a: unknown[]) => {
      if (String(a[0] ?? '').includes('FAIL')) realError(...(a as []));
    };
  }

  await scenarioRpcPreferred();
  await scenarioAtomicUnderConcurrency();
  await scenarioDegradesToLegacy();
  await scenarioGuardsShortCircuit();
  await scenarioFollowUpSendsDoNotBump();

  console.warn = realWarn;
  console.error = realError;

  console.log(`channel-priors test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
