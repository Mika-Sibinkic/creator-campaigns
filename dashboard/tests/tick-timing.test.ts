import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
//
// tests/tick-timing.test.ts
//
// Integration tests for the DB SHELL around issues #79 and #78 — the ~400
// lines of negotiation-tick.ts that the two pure-unit suites cannot reach.
//
// tests/campaign-window.test.ts and tests/escalation.test.ts both test pure
// DECISION functions. A review pointed out that the shell wiring them to the
// database had no tests at all, and that this is exactly where the expensive
// mistakes live: the first version of the window gate would have killed open
// negotiations on deploy, and a shell bug that pinned escalation_count at 1
// shipped because nothing exercised the query against its own writer.
//
// What is asserted here, and why each one is load-bearing:
//
//   1. GRANDFATHERING, END TO END. A campaign created before the feature
//      shipped, whose window closed two months ago, still dispatches its
//      counter. This is the defect the review caught, tested
//      through the real tick rather than through the pure clamp.
//   2. A gated campaign really does close a message out, and the row lands
//      as 'window_closed' with send_after cleared — the actual DB write.
//   3. sendModeFor stamps human_queue on a DM escalation, and dispatchDue
//      never hands it to the emailer. This is the single thing keeping an
//      email-shaped body out of an Instagram DM.
//   4. The contact cap counts REAL outbound rows, so max_follow_ups binds.
//   5. contact_blocked wiring: a blocklisted creator is not escalated to.
//   6. MAX_ESCALATIONS_PER_TICK bounds one pass.
//   7. A replied lead is never escalated.
//
// Run: npx tsx tests/tick-timing.test.ts

import { makeStore, type Row } from './negotiation-harness/store';
import {
  runNegotiationTick,
  MAX_ESCALATIONS_PER_TICK,
  type DispatchFn,
  type DueOutbound,
} from '../src/lib/negotiation-tick';
import { WINDOW_ENFORCEMENT_EPOCH } from '../src/lib/campaign-window';

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

const noopPoll = async () => ({ skipped: 'gmail_not_configured' as const });
const HALF_RAND = () => 0.5;

/**
 * 2026-09-20T00:00:00Z is 19:00 at the default -5 outreach offset — inside the
 * 9am-9pm send window, so quiet hours never defers and `send_after` is
 * deterministic. It is also after WINDOW_ENFORCEMENT_EPOCH (2026-09-18), so
 * campaigns created "now" are genuinely window-gated.
 */
const NOW = Date.parse('2026-09-20T00:00:00.000Z');
const DAY = 86_400_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

type Store = ReturnType<typeof makeStore>;

/** A lead that was contacted and went silent 10 days ago. */
function seedSilentLead(store: Store, over: Partial<Row> = {}): Row {
  return store.seed('campaign_influencers', {
    id: 'ci-1',
    campaign_id: 'camp-1',
    influencer_id: 'inf-1',
    outreach_status: 'sent',
    status: 'contacted',
    primary_channel: 'email',
    channels_tried: ['email'],
    next_attempt_at: null,
    last_outreach_at: iso(NOW - 10 * DAY),
    message_count: 0,
    escalation_count: 0,
    qualification_status: 'qualified',
    qualification_reason: null,
    bot_flagged: false,
    score_breakdown: { audience_fit: 0.8 },
    ...over,
  });
}

function seedCreator(store: Store, over: Partial<Row> = {}): Row {
  return store.seed('influencers', {
    id: 'inf-1',
    platform: 'tiktok',
    contact_email: 'creator@example.com',
    follower_count: 50_000,
    bot_flagged: false,
    blocklisted: false,
    ...over,
  });
}

function seedFirmAndCampaign(store: Store, campaign: Partial<Row> = {}): void {
  store.seed('firms', { id: 'firm-1', outreach_prefs: {}, scraping_prefs: {} });
  store.seed('campaigns', {
    id: 'camp-1',
    firm_id: 'firm-1',
    release_date: null,
    created_at: iso(NOW - 2 * DAY),
    total_budget_usd: 1_000_000,
    ...campaign,
  });
}

/** The first touch that already went out — what escalation re-delivers. */
function seedPriorOutbound(store: Store, over: Partial<Row> = {}): Row {
  return store.seed('outreach_messages', {
    id: 'msg-first',
    campaign_influencer_id: 'ci-1',
    message_type: 'initial',
    direction: 'outbound',
    channel: 'email',
    subject: 'Collab on the new single?',
    body: 'Hey — we think this track would land well with your audience.',
    status: 'sent',
    sent_at: iso(NOW - 10 * DAY),
    send_after: null,
    created_at: iso(NOW - 10 * DAY),
    ...over,
  });
}

async function tick(store: Store, now: number, dispatch: DispatchFn) {
  return runNegotiationTick(store.sb, {
    now,
    rand: HALF_RAND,
    dispatch,
    pollGmail: noopPoll,
  });
}

// ── 1. Grandfathering, through the real tick ────────────────────────────────
//
// The failing shape: release 2026-07-04, campaign created before the
// feature epoch, "now" 62 days past window_end. A queued counter MUST send.
async function scenarioGrandfatheredCampaignStillDispatches() {
  const store = makeStore();
  seedFirmAndCampaign(store, {
    release_date: '2026-07-04',
    created_at: '2026-06-20T12:00:00.000Z', // predates WINDOW_ENFORCEMENT_EPOCH
  });
  seedCreator(store);
  seedSilentLead(store, { outreach_status: 'responded' }); // replied → no escalation noise
  // A counter the negotiator queued, due now.
  store.seed('outreach_messages', {
    id: 'msg-counter',
    campaign_influencer_id: 'ci-1',
    message_type: 'counter',
    direction: 'outbound',
    channel: 'email',
    subject: 'Re: Collab',
    body: 'Could we meet at $250?',
    status: 'queued',
    sent_at: null,
    send_after: iso(NOW - 60_000),
    send_mode: 'auto_email',
    created_at: iso(NOW - 60_000),
  });

  const calls: DueOutbound[] = [];
  const t = await tick(store, NOW, async (_sb, m) => {
    calls.push(m);
    return { ok: true, provider_message_id: 'prov-1', resolved_to: 'creator@example.com' };
  });

  assert(
    t.sent === 1,
    `grandfathered: the counter SENDS despite a window that closed 62 days ago (got sent=${t.sent})`,
  );
  assert(
    t.window_closed === 0,
    `grandfathered: nothing is closed by the window (got window_closed=${t.window_closed})`,
  );
  assert(calls.length === 1, 'grandfathered: the dispatcher really was invoked');
  const row = store.all('outreach_messages').find((r) => r.id === 'msg-counter');
  assert(
    row?.status === 'sent',
    `grandfathered: the row reaches 'sent', not 'window_closed' (got ${row?.status})`,
  );
  assert(
    WINDOW_ENFORCEMENT_EPOCH === '2026-09-18T00:00:00.000Z',
    'grandfathered: the epoch this scenario depends on is the shipped one',
  );
}

// ── 2. A genuinely gated campaign does close a message out ──────────────────
async function scenarioGatedCampaignClosesTheMessage() {
  const store = makeStore();
  // Created after the epoch and inside its own window, so it IS gated. Its
  // window then closes well before `now`.
  seedFirmAndCampaign(store, {
    release_date: '2026-09-19',
    created_at: '2026-09-18T06:00:00.000Z',
  });
  seedCreator(store);
  seedSilentLead(store, { outreach_status: 'responded' });
  store.seed('outreach_messages', {
    id: 'msg-late',
    campaign_influencer_id: 'ci-1',
    message_type: 'counter',
    direction: 'outbound',
    channel: 'email',
    subject: 'Re: Collab',
    body: 'Could we meet at $250?',
    status: 'queued',
    sent_at: null,
    send_after: iso(NOW - 60_000),
    send_mode: 'auto_email',
    created_at: iso(NOW - 60_000),
  });

  const calls: DueOutbound[] = [];
  // Far past window_end (2026-10-03) + the 7-day in-thread grace.
  const LATE = Date.parse('2026-11-20T00:00:00.000Z');
  const t = await tick(store, LATE, async (_sb, m) => {
    calls.push(m);
    return { ok: true };
  });

  assert(
    t.window_closed === 1,
    `gated: the expired counter is closed out (got window_closed=${t.window_closed})`,
  );
  assert(t.sent === 0, `gated: nothing was sent (got sent=${t.sent})`);
  assert(calls.length === 0, 'gated: the dispatcher was never invoked');

  const row = store.all('outreach_messages').find((r) => r.id === 'msg-late');
  assert(
    row?.status === 'window_closed',
    `gated: the DB row really carries status='window_closed' (got ${row?.status})`,
  );
  assert(
    row?.send_after == null,
    'gated: send_after is cleared so the due-scan can never pick it up again',
  );
  assert(
    row?.body === 'Could we meet at $250?',
    'gated: the body stays inspectable — the message is closed, not deleted',
  );

  // Idempotent: a second tick must not re-close or resurrect it.
  const t2 = await tick(store, LATE + 60_000, async () => ({ ok: true }));
  assert(
    t2.window_closed === 0 && t2.sent === 0,
    'gated: a closed row is terminal — the next tick does nothing with it',
  );
}

// ── 3. Escalation: DM is stamped human_queue and never emailed ──────────────
async function scenarioDmEscalationGoesToHumanQueueNotEmail() {
  const store = makeStore();
  seedFirmAndCampaign(store); // no release_date → ungated
  seedCreator(store); // platform tiktok + an email, email already tried
  seedSilentLead(store);
  seedPriorOutbound(store);

  const calls: DueOutbound[] = [];
  const t = await tick(store, NOW, async (_sb, m) => {
    calls.push(m);
    return { ok: true };
  });

  assert(t.escalated === 1, `escalate: one silent lead escalated (got ${t.escalated})`);

  const created = store
    .all('outreach_messages')
    .find((r) => r.id !== 'msg-first' && r.direction === 'outbound');
  assert(created != null, 'escalate: a new outbound row was actually inserted');
  assert(
    created?.channel === 'tiktok_dm',
    `escalate: it went to the untried DM channel (got ${created?.channel})`,
  );
  assert(
    created?.send_mode === 'human_queue',
    `escalate: sendModeFor stamped human_queue — the one thing keeping email-shaped copy out of a DM (got ${created?.send_mode})`,
  );
  assert(created?.needs_human === true, 'escalate: it is flagged as needing a human');
  assert(
    created?.body === 'Hey — we think this track would land well with your audience.',
    'escalate: the existing pitch is re-delivered rather than a fresh model call',
  );
  assert(
    calls.length === 0,
    'escalate: dispatchDue NEVER handed the DM to the emailer, on this tick or any other',
  );

  const lead = store.all('campaign_influencers').find((r) => r.id === 'ci-1');
  assert(
    Array.isArray(lead?.channels_tried) &&
      (lead?.channels_tried as string[]).includes('tiktok_dm'),
    'escalate: channels_tried records the new channel',
  );
  assert(
    (lead?.channels_tried as string[]).includes('email'),
    'escalate: and still records the original one',
  );
  assert(
    lead?.escalation_count === 1,
    `escalate: escalation_count incremented from its real prior value (got ${lead?.escalation_count})`,
  );
  assert(lead?.next_attempt_at != null, 'escalate: next_attempt_at was stamped');

  // Second tick: the silence window has NOT elapsed, so no double-tap.
  const t2 = await tick(store, NOW + 60_000, async () => ({ ok: true }));
  assert(
    t2.escalated === 0,
    `escalate: the next tick does not escalate again (got ${t2.escalated})`,
  );
}

// ── 4. The contact cap counts REAL outbound rows ────────────────────────────
//
// The previous implementation read campaign_influencers.message_count, which
// is 0 on every lead (nothing writes it), so the cap never bound for ANY configuration.
async function scenarioContactCapCountsRealMessages() {
  const store = makeStore();
  store.seed('firms', { id: 'firm-1', outreach_prefs: { max_follow_ups: 1 }, scraping_prefs: {} });
  store.seed('campaigns', {
    id: 'camp-1',
    firm_id: 'firm-1',
    release_date: null,
    created_at: iso(NOW - 2 * DAY),
    total_budget_usd: 1_000_000,
  });
  seedCreator(store);
  // message_count stays 0, as it does on every lead. Two REAL outbound rows
  // means 1 + max_follow_ups = 2 is already reached.
  seedSilentLead(store, { message_count: 0 });
  seedPriorOutbound(store);
  store.seed('outreach_messages', {
    id: 'msg-second',
    campaign_influencer_id: 'ci-1',
    message_type: 'follow_up',
    direction: 'outbound',
    channel: 'email',
    subject: 'Re: Collab',
    body: 'Just floating this back up.',
    status: 'sent',
    sent_at: iso(NOW - 5 * DAY),
    send_after: null,
    created_at: iso(NOW - 5 * DAY),
  });

  const t = await tick(store, NOW, async () => ({ ok: true }));
  assert(
    t.escalated === 0,
    `cap: two real outbound messages with max_follow_ups=1 blocks escalation, even though message_count is 0 (got ${t.escalated})`,
  );
  assert(
    store.all('outreach_messages').length === 2,
    'cap: no third message was written',
  );

  // An inbound reply must NOT inflate the count — the old column did exactly
  // that, so a chatty creator hit the ceiling faster than a silent one.
  const store2 = makeStore();
  store2.seed('firms', {
    id: 'firm-1',
    outreach_prefs: { max_follow_ups: 1 },
    scraping_prefs: {},
  });
  store2.seed('campaigns', {
    id: 'camp-1',
    firm_id: 'firm-1',
    release_date: null,
    created_at: iso(NOW - 2 * DAY),
    total_budget_usd: 1_000_000,
  });
  seedCreator(store2);
  seedSilentLead(store2);
  seedPriorOutbound(store2);
  store2.seed('outreach_messages', {
    id: 'msg-inbound',
    campaign_influencer_id: 'ci-1',
    message_type: 'response',
    direction: 'inbound',
    channel: 'email',
    subject: null,
    body: 'who is this',
    status: 'sent',
    created_at: iso(NOW - 6 * DAY),
  });
  const t2 = await tick(store2, NOW, async () => ({ ok: true }));
  assert(
    t2.escalated === 1,
    `cap: an INBOUND row does not count against the outbound contact cap (got ${t2.escalated})`,
  );
}

// ── 5. Pool gates / blocklist wiring ────────────────────────────────────────
async function scenarioBlocklistedCreatorIsNeverEscalated() {
  const store = makeStore();
  seedFirmAndCampaign(store);
  seedCreator(store, { blocklisted: true });
  seedSilentLead(store);
  seedPriorOutbound(store);

  const t = await tick(store, NOW, async () => ({ ok: true }));
  assert(
    t.escalated === 0,
    `blocklist: a blocklisted creator is never escalated to (got ${t.escalated})`,
  );
  assert(
    store.all('outreach_messages').length === 1,
    'blocklist: no new message row was written',
  );
}

// ── 6. One tick is bounded ──────────────────────────────────────────────────
async function scenarioEscalationIsBoundedPerTick() {
  const store = makeStore();
  seedFirmAndCampaign(store);
  const n = MAX_ESCALATIONS_PER_TICK + 5;
  for (let i = 0; i < n; i++) {
    store.seed('influencers', {
      id: `inf-${i}`,
      platform: 'tiktok',
      contact_email: `c${i}@example.com`,
      follower_count: 50_000,
      bot_flagged: false,
      blocklisted: false,
    });
    store.seed('campaign_influencers', {
      id: `ci-${i}`,
      campaign_id: 'camp-1',
      influencer_id: `inf-${i}`,
      outreach_status: 'sent',
      status: 'contacted',
      primary_channel: 'email',
      channels_tried: ['email'],
      next_attempt_at: null,
      last_outreach_at: iso(NOW - 10 * DAY),
      message_count: 0,
      escalation_count: 0,
      qualification_status: 'qualified',
      qualification_reason: null,
      bot_flagged: false,
      score_breakdown: { audience_fit: 0.8 },
    });
    store.seed('outreach_messages', {
      id: `m-${i}`,
      campaign_influencer_id: `ci-${i}`,
      message_type: 'initial',
      direction: 'outbound',
      channel: 'email',
      subject: 'Collab?',
      body: 'Hey there.',
      status: 'sent',
      sent_at: iso(NOW - 10 * DAY),
      send_after: null,
      created_at: iso(NOW - 10 * DAY),
    });
  }

  const t = await tick(store, NOW, async () => ({ ok: true }));
  assert(
    t.escalated === MAX_ESCALATIONS_PER_TICK,
    `bound: one tick escalates at most MAX_ESCALATIONS_PER_TICK (got ${t.escalated}, cap ${MAX_ESCALATIONS_PER_TICK})`,
  );
}

// ── 7. A replied lead is never escalated ────────────────────────────────────
async function scenarioRepliedLeadIsNeverEscalated() {
  for (const status of ['responded', 'negotiating', 'deal_closed', 'rejected']) {
    const store = makeStore();
    seedFirmAndCampaign(store);
    seedCreator(store);
    seedSilentLead(store, { outreach_status: status });
    seedPriorOutbound(store);

    const t = await tick(store, NOW, async () => ({ ok: true }));
    assert(
      t.escalated === 0,
      `replied: a lead at '${status}' is never escalated (got ${t.escalated})`,
    );
    assert(
      store.all('outreach_messages').length === 1,
      `replied: no new message written for a '${status}' lead`,
    );
  }
}

async function main() {
  const origWarn = console.warn;
  if (!process.env.DEBUG) console.warn = () => {};

  await scenarioGrandfatheredCampaignStillDispatches();
  await scenarioGatedCampaignClosesTheMessage();
  await scenarioDmEscalationGoesToHumanQueueNotEmail();
  await scenarioContactCapCountsRealMessages();
  await scenarioBlocklistedCreatorIsNeverEscalated();
  await scenarioEscalationIsBoundedPerTick();
  await scenarioRepliedLeadIsNeverEscalated();

  console.warn = origWarn;

  console.log(`tick-timing test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
