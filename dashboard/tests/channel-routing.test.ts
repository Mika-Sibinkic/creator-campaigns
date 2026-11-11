// tests/channel-routing.test.ts
//
// Channel routing beyond email + priors that learn. Hermetic:
// in-memory Supabase mock (the negotiation-harness store) + deterministic mock
// model provider + injected dispatch/clock/rng. No network, no DB, no send.
//
// Proves:
//   1. A DM-channel creator's scheduled counter is stamped
//      send_mode='human_queue' and dispatchDue NEVER auto-sends it.
//   2. An email creator's counter is stamped 'auto_email' and dispatches
//      exactly as before (behavior-preserving for the email path).
//   3. bumpPrior increments the right channel_conversion_priors counter for
//      each event type ('sent'→sent, 'reply'→replies, 'deal'→deals), creates
//      a missing row, and no-ops on unknown channels / missing firm.
//   4. The tick bumps the 'deal' prior when an offer flips agreed, and the
//      acceptance note for a DM thread is ALSO routed human_queue.
//   5. markHumanQueueSent (the DM queue's "Mark sent") flips the message,
//      advances the campaign_influencer, logs a social_send_events audit row,
//      and bumps the 'sent' prior.
//
// Run: npx tsx tests/channel-routing.test.ts

import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
import { registerProvider } from '../src/lib/model-provider';
import { runNegotiationTick, type DispatchFn, type DueOutbound } from '../src/lib/negotiation-tick';
import {
  bumpPrior,
  isDmPrimaryChannel,
  markHumanQueueSent,
  toPriorChannel,
} from '../src/lib/channel-priors';
import { makeStore, type Row } from './negotiation-harness/store';

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

// ── Deterministic mock model provider ───────────────────────────────────────
// "$300" over-ask → midpoint COUNTER (over ceiling, rounds < max).
// "$60 flat is my rate" → $60 counter, at-or-below our $100 offer → ACCEPT
// (parked at the human gate). Everything else → safe unclear no-op.
registerProvider('mock', async ({ user }) => {
  if (user.includes('$300')) {
    return JSON.stringify({ intent: 'counter', counter_usd: 300, sentiment: 'neutral', confidence: 0.9 });
  }
  if (user.includes('$60 flat is my rate')) {
    return JSON.stringify({ intent: 'counter', counter_usd: 60, sentiment: 'positive', confidence: 0.9 });
  }
  return JSON.stringify({ intent: 'unclear', counter_usd: null, sentiment: 'neutral', confidence: 0.9 });
});

const NOW0 = Date.parse('2026-09-14T00:00:00.000Z');
const HALF_RAND = () => 0.5;
const noopPoll = async () => ({ skipped: 'gmail_not_configured' as const });

function seedOffer(store: ReturnType<typeof makeStore>, id: string, ci: string, campaignId: string): Row {
  return store.seed('creator_offers', {
    id,
    campaign_influencer_id: ci,
    campaign_id: campaignId,
    firm_id: 'firm-1',
    status: 'offered',
    initial_offer_usd: 100,
    current_offer_usd: 100,
    agreed_amount_usd: null,
    ceiling_usd: 200,
    rounds: 0,
    last_message_id: null,
    approved_at: null,
    approved_by_user_id: null,
    paid_at: null,
    posted_at: null,
    post_url: null,
    autonomy_mode: 'auto',
    opening_pct: null,
    injection_flagged: false,
    created_at: '2026-09-14T00:00:00.000Z',
    updated_at: '2026-09-14T00:00:00.000Z',
  });
}

function seedInbound(
  store: ReturnType<typeof makeStore>,
  id: string,
  ci: string,
  body: string,
  channel: string,
): Row {
  return store.seed('inbound_messages', {
    id,
    channel,
    external_id: `sim:${id}`,
    creator_offer_id: null,
    campaign_influencer_id: ci,
    from_identity: 'simulator',
    body,
    received_at: '2026-09-14T00:00:00.000Z',
    status: 'classified',
    classification: { classification: 'negotiating', confidence: 0.8 },
  });
}

function priorRow(store: ReturnType<typeof makeStore>, channel: string): Row | undefined {
  return store
    .all('channel_conversion_priors')
    .find((r) => r.firm_id === 'firm-1' && r.channel === channel);
}

// ── 1 + 2. Routed dispatch: DM → human_queue (skipped), email → auto ────────

async function scenarioDmCounterRoutedAndSkipped() {
  const store = makeStore();
  store.seedCampaign('camp-A', null);
  seedOffer(store, 'offer-A', 'ci-A', 'camp-A');
  seedInbound(store, 'inb-A', 'ci-A', 'Can you come up to $300? I get more usually.', 'instagram_dm');

  const dispatchCalls: DueOutbound[] = [];
  const dispatch: DispatchFn = async (_sb, msg) => {
    dispatchCalls.push(msg);
    return { ok: true, provider_message_id: 'prov-dm', resolved_to: 'tester@example.com' };
  };

  // Tick 1: process the DM reply → schedule the counter.
  const t1 = await runNegotiationTick(store.sb, { now: NOW0, rand: HALF_RAND, dispatch, pollGmail: noopPoll });
  assert(t1.processed === 1, `dm: processed=1 (got ${t1.processed})`);

  const outbound = store.all('outreach_messages');
  assert(outbound.length === 1, `dm: one scheduled counter (got ${outbound.length})`);
  const counter = outbound[0];
  assert(counter.channel === 'instagram_dm', `dm: counter keeps the thread channel (got ${counter.channel})`);
  assert(counter.send_mode === 'human_queue', `dm: counter stamped human_queue (got ${counter.send_mode})`);
  assert(counter.needs_human === true, 'dm: counter flagged needs_human');
  assert(counter.status === 'queued', `dm: counter queued (got ${counter.status})`);

  // Tick 2, well past send_after: the auto-sender must SKIP the human_queue row.
  const t2 = await runNegotiationTick(store.sb, { now: NOW0 + 30 * 60_000, rand: HALF_RAND, dispatch, pollGmail: noopPoll });
  assert(t2.sent === 0, `dm: nothing auto-sent (got ${t2.sent})`);
  assert(dispatchCalls.length === 0, 'dm: dispatcher never called for a human_queue row');
  const after = store.all('outreach_messages')[0];
  assert(after.status === 'queued', `dm: row still queued for the human surface (got ${after.status})`);
  assert(after.sent_at == null, 'dm: sent_at never stamped by the auto path');
}

async function scenarioEmailCounterUnchanged() {
  const store = makeStore();
  store.seedCampaign('camp-B', null);
  seedOffer(store, 'offer-B', 'ci-B', 'camp-B');
  seedInbound(store, 'inb-B', 'ci-B', 'Can you come up to $300? I get more usually.', 'email');

  const dispatchCalls: DueOutbound[] = [];
  const dispatch: DispatchFn = async (_sb, msg) => {
    dispatchCalls.push(msg);
    return { ok: true, provider_message_id: 'prov-em', resolved_to: 'tester@example.com' };
  };

  await runNegotiationTick(store.sb, { now: NOW0, rand: HALF_RAND, dispatch, pollGmail: noopPoll });
  const counter = store.all('outreach_messages')[0];
  assert(counter.send_mode === 'auto_email', `email: counter stamped auto_email (got ${counter.send_mode})`);
  assert(counter.needs_human === false, 'email: counter not flagged needs_human');

  const t2 = await runNegotiationTick(store.sb, { now: NOW0 + 30 * 60_000, rand: HALF_RAND, dispatch, pollGmail: noopPoll });
  assert(t2.sent === 1, `email: dispatched once due (got ${t2.sent})`);
  assert(dispatchCalls.length === 1, 'email: dispatcher called exactly once');
  assert(store.all('outreach_messages')[0].status === 'sent', 'email: row flipped to sent');
}

// ── 3. bumpPrior unit behavior ───────────────────────────────────────────────

async function scenarioBumpPriorCounters() {
  const store = makeStore();

  // Missing row → created with exactly one count on the right column.
  await bumpPrior(store.sb, { firmId: 'firm-1', channel: 'instagram_dm', event: 'sent' });
  let row = priorRow(store, 'instagram_dm');
  assert(row != null, 'bump: missing (firm, channel) row auto-created');
  assert(row?.sent === 1 && row?.replies === 0 && row?.deals === 0, `bump: sent=1/replies=0/deals=0 on create (got ${JSON.stringify(row)})`);

  // Each event type increments its own column, independently.
  await bumpPrior(store.sb, { firmId: 'firm-1', channel: 'instagram_dm', event: 'sent' });
  await bumpPrior(store.sb, { firmId: 'firm-1', channel: 'instagram_dm', event: 'reply' });
  await bumpPrior(store.sb, { firmId: 'firm-1', channel: 'instagram_dm', event: 'deal' });
  row = priorRow(store, 'instagram_dm');
  assert(row?.sent === 2, `bump: sent incremented to 2 (got ${row?.sent})`);
  assert(row?.replies === 1, `bump: replies incremented to 1 (got ${row?.replies})`);
  assert(row?.deals === 1, `bump: deals incremented to 1 (got ${row?.deals})`);

  // A seeded row (migration 020 shape) increments in place, no duplicate row.
  store.seed('channel_conversion_priors', { id: 'p-email', firm_id: 'firm-1', channel: 'email', sent: 100, replies: 7, deals: 0 });
  await bumpPrior(store.sb, { firmId: 'firm-1', channel: 'email', event: 'reply' });
  const emailRows = store.all('channel_conversion_priors').filter((r) => r.channel === 'email');
  assert(emailRows.length === 1, `bump: no duplicate row for a seeded channel (got ${emailRows.length})`);
  assert(emailRows[0].replies === 8, `bump: seeded replies 7→8 (got ${emailRows[0].replies})`);
  assert(emailRows[0].sent === 100, 'bump: other counters untouched');

  // Platform names normalize onto DM channels; junk no-ops.
  await bumpPrior(store.sb, { firmId: 'firm-1', channel: 'tiktok', event: 'sent' });
  assert(priorRow(store, 'tiktok_dm')?.sent === 1, 'bump: platform "tiktok" normalizes to tiktok_dm');
  const before = store.all('channel_conversion_priors').length;
  await bumpPrior(store.sb, { firmId: 'firm-1', channel: 'dm', event: 'sent' });
  await bumpPrior(store.sb, { firmId: 'firm-1', channel: 'carrier_pigeon', event: 'sent' });
  await bumpPrior(store.sb, { firmId: null, channel: 'email', event: 'sent' });
  assert(store.all('channel_conversion_priors').length === before, 'bump: unknown channel / missing firm are no-ops');

  // Helper sanity.
  assert(toPriorChannel('instagram') === 'instagram_dm' && toPriorChannel('linkedin_dm') === null, 'toPriorChannel mapping');
  assert(isDmPrimaryChannel('dm') && isDmPrimaryChannel('tiktok_dm') && !isDmPrimaryChannel('email'), 'isDmPrimaryChannel mapping');
}

// ── 4. Deal bump on accepted + DM acceptance note routed human ──────────────

async function scenarioAcceptedBumpsDealPrior() {
  const store = makeStore();
  store.seedCampaign('camp-C', null);
  seedOffer(store, 'offer-C', 'ci-C', 'camp-C');
  seedInbound(store, 'inb-C', 'ci-C', 'Honestly $60 flat is my rate for this.', 'tiktok_dm');
  store.seed('channel_conversion_priors', { id: 'p-tt', firm_id: 'firm-1', channel: 'tiktok_dm', sent: 100, replies: 2, deals: 0 });

  const t = await runNegotiationTick(store.sb, { now: NOW0, rand: HALF_RAND, dispatch: async () => ({ ok: true }), pollGmail: noopPoll });
  assert(t.processed === 1, `deal: processed=1 (got ${t.processed})`);

  const offer = store.getOffer('offer-C');
  assert(
    offer?.status === 'human_approval_required',
    `deal: $60 ≤ our $100 → accepted + parked at human gate (got ${offer?.status})`,
  );
  assert(Number(offer?.agreed_amount_usd) === 60, `deal: agreed $60 (got ${offer?.agreed_amount_usd})`);

  const prior = priorRow(store, 'tiktok_dm');
  assert(prior?.deals === 1, `deal: tiktok_dm deals prior 0→1 (got ${prior?.deals})`);
  assert(prior?.sent === 100 && prior?.replies === 2, 'deal: other counters untouched');

  // The acceptance note for a DM thread is ALSO a human send.
  const notes = store.all('outreach_messages');
  assert(notes.length === 1, `deal: one acceptance note scheduled (got ${notes.length})`);
  assert(notes[0].send_mode === 'human_queue', `deal: acceptance note routed human_queue (got ${notes[0].send_mode})`);
}

// ── 5. markHumanQueueSent — the DM queue's "Mark sent" ──────────────────────

async function scenarioMarkSentLogsLedgerAndPrior() {
  const store = makeStore();
  store.seed('campaign_influencers', { id: 'ci-E', status: 'draft_ready', last_outreach_at: null });
  store.seed('outreach_messages', {
    id: 'om-E',
    campaign_influencer_id: 'ci-E',
    channel: 'instagram_dm',
    direction: 'outbound',
    status: 'queued',
    send_mode: 'human_queue',
    sent_at: null,
    send_after: '2026-09-14T00:05:00.000Z',
    body: 'hey!',
  });

  const res = await markHumanQueueSent(store.sb, {
    messageId: 'om-E',
    campaignInfluencerId: 'ci-E',
    firmId: 'firm-1',
    channel: 'instagram_dm',
    nowMs: NOW0,
  });
  assert(res.ok, 'mark_sent: succeeds');

  const msg = store.all('outreach_messages').find((r) => r.id === 'om-E');
  assert(msg?.status === 'sent', `mark_sent: message flipped to sent (got ${msg?.status})`);
  assert(msg?.sent_at === new Date(NOW0).toISOString(), 'mark_sent: sent_at stamped from the injected clock');
  assert(msg?.send_after == null, 'mark_sent: send_after cleared');

  const ci = store.all('campaign_influencers').find((r) => r.id === 'ci-E');
  assert(ci?.status === 'contacted', `mark_sent: campaign_influencer advanced to contacted (got ${ci?.status})`);
  assert(ci?.last_outreach_at != null, 'mark_sent: last_outreach_at stamped');

  const events = store.all('social_send_events');
  assert(events.length === 1, `mark_sent: one social_send_events audit row (got ${events.length})`);
  assert(events[0].channel === 'instagram_dm', `mark_sent: ledger channel instagram_dm (got ${events[0].channel})`);
  assert(events[0].status === 'sent', 'mark_sent: ledger status sent');
  assert(events[0].outreach_message_id === 'om-E', 'mark_sent: ledger links the message');
  assert(events[0].campaign_influencer_id === 'ci-E', 'mark_sent: ledger links the campaign_influencer');
  assert(events[0].firm_id === 'firm-1', 'mark_sent: ledger carries the firm');

  const prior = priorRow(store, 'instagram_dm');
  assert(prior?.sent === 1, `mark_sent: 'sent' prior bumped (got ${prior?.sent})`);
}

async function main() {
  const origWarn = console.warn;
  if (!process.env.DEBUG) console.warn = () => {};

  await scenarioDmCounterRoutedAndSkipped();
  await scenarioEmailCounterUnchanged();
  await scenarioBumpPriorCounters();
  await scenarioAcceptedBumpsDealPrior();
  await scenarioMarkSentLogsLedgerAndPrior();

  console.warn = origWarn;

  console.log(`channel-routing test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
