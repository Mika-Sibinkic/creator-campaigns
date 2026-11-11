// tests/budget-fail-closed.test.ts
//
// negotiation.ts must never fail open on an unset campaign budget.
// Hermetic: in-memory harness store, deterministic mock provider. No network.
//
// The payout path (spend-caps.ts) refuses to move money when a campaign
// budget is not configured: no configured budget means no enforceable ceiling,
// and an unenforceable cap is not the same thing as an absent one. The
// negotiation path did the opposite. It
// treated an unset budget as "no campaign cap, per-creator ceiling governs",
// and it never even destructured `error`, so a PostgREST failure, an RLS denial
// and a zero-row read all collapsed to the same silent "no cap".
//
// Proves:
//   1. An UNSET budget (null) escalates instead of negotiating.
//   2. A ZERO / negative / non-numeric budget does too — !(x > 0) semantics,
//      resolved through spend-caps' own resolveCampaignBudget so the two
//      modules can never disagree about what a usable budget is.
//   3. A FAILED campaign read fails closed AND RETRIES — a budget we cannot
//      READ is not a budget we may ignore, but it is also not a durable config
//      gap, so it goes to the tick's poison-row lane and the inbound row stays
//      pending. Covers a query error and a missing row.
//   4. A FAILED committed-spend read does the same. This is the third fail-open
//      in the function and the one the issue does not mention: it swallowed its
//      error and read as $0 committed, i.e. FULL budget headroom.
//   5. The posture matches spend-caps: a GATE, not a dead end. The offer is
//      untouched — not rejected, not advanced, no round burned — so it
//      negotiates normally the moment someone sets a budget. A 'rejected'
//      transition is terminal and would record the creator as having declined
//      something they never saw.
//   6. The refusal carries a readable reason, under an escalation kind mapped
//      to an audit action that statuses.ts actually surfaces on /anomalies —
//      a fail-closed gate nobody can see is just an outage.
//   7. No regression: a configured budget still negotiates, and a budget that
//      genuinely binds still clamps what may be agreed.
//
// Run: npx tsx tests/budget-fail-closed.test.ts

import './negotiation-harness/setup-env'; // FIRST — dummy env, no network
import { registerProvider } from '../src/lib/model-provider';
import {
  autoNegotiateInbound,
  ESCALATION_AUDIT_ACTIONS,
  type CreatorOfferRow,
} from '../src/lib/negotiation';
import { ESCALATION_AUDIT_ACTIONS as SURFACED_ACTIONS } from '../src/lib/statuses';
import { CAMPAIGN_BUDGET_NOT_SET } from '../src/lib/spend-caps';
import { runNegotiationTick } from '../src/lib/negotiation-tick';
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

const REPLY = 'Could you do $150? That works on my end.';

registerProvider('mock', async () =>
  JSON.stringify({ intent: 'counter', counter_usd: 150, sentiment: 'positive', confidence: 0.95 }),
);

function seedOffer(store: MockStore, id = 'offer-47', campaignId = 'camp-47'): CreatorOfferRow {
  return store.seed('creator_offers', {
    id,
    campaign_influencer_id: 'ci-47',
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
    agreed_deliverables: null,
    created_at: '2026-09-17T00:00:00.000Z',
    updated_at: '2026-09-17T00:00:00.000Z',
  }) as unknown as CreatorOfferRow;
}

/** Seed a campaign row with an explicit budget value (including null). */
function seedCampaignRaw(store: MockStore, budget: unknown, id = 'camp-47') {
  store.seed('campaigns', { id, firm_id: 'firm-1', total_budget_usd: budget });
}

/** A client whose `total_budget_usd` read errors; every other read is real. */
function clientFailingBudgetRead(store: MockStore): SupabaseClient {
  const base = store.sb as unknown as { from: (t: string) => Record<string, unknown> };
  return {
    from(t: string) {
      const q = base.from(t);
      if (t !== 'campaigns') return q;
      const origSelect = (q.select as (c?: string) => unknown).bind(q);
      q.select = (cols?: string) => {
        const real = origSelect(cols);
        if (!cols || !cols.includes('total_budget_usd')) return real;
        return {
          eq: () => ({
            single: async () => ({ data: null, error: { message: 'connection reset' } }),
          }),
        };
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

/** A client whose committed-spend read (the only .in('status', …) on
 *  creator_offers) errors; every other read is real. */
function clientFailingCommittedRead(store: MockStore): SupabaseClient {
  const base = store.sb as unknown as { from: (t: string) => Record<string, unknown> };
  return {
    from(t: string) {
      const q = base.from(t);
      if (t !== 'creator_offers') return q;
      const origIn = (q.in as (c: string, v: unknown[]) => unknown).bind(q);
      q.in = (col: string, vals: unknown[]) => {
        const real = origIn(col, vals);
        if (col !== 'status') return real;
        return {
          neq: () => ({
            then: (resolve: (r: unknown) => void) =>
              resolve({ data: null, error: { message: 'statement timeout' } }),
          }),
        };
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

async function negotiate(sb: SupabaseClient, offer: CreatorOfferRow) {
  return autoNegotiateInbound(sb, offer, {
    inbound_text: REPLY,
    inbound_message_id: 'inb-47',
  });
}

/** Every fail-closed case asserts the same posture. */
async function assertFailsClosed(
  label: string,
  sb: SupabaseClient,
  store: MockStore,
  offer: CreatorOfferRow,
) {
  const res = await negotiate(sb, offer);

  assert(res.outcome === 'needs_human', `${label}: escalates (got ${res.outcome}: ${res.reason})`);
  assert(
    res.escalation?.kind === 'budget_unverifiable',
    `${label}: labelled budget_unverifiable (got ${JSON.stringify(res.escalation?.kind)})`,
  );

  // 5. A gate, not a dead end — the offer is completely untouched.
  const after = store.getOffer(String(offer.id));
  assert(after?.status === 'offered', `${label}: never advances the state machine (got ${after?.status})`);
  assert(
    after?.status !== 'rejected',
    `${label}: never RECORDS the creator as having declined (spend-caps stays retryable)`,
  );
  assert(after?.agreed_amount_usd == null, `${label}: nothing is agreed`);
  assert(
    Number(after?.current_offer_usd) === 100,
    `${label}: our standing number is not moved (got ${after?.current_offer_usd})`,
  );
  assert(Number(after?.rounds) === 0, `${label}: no negotiation round is burned`);

  // 6. The refusal carries a readable reason for the operator. (audit() writes
  //    through its own admin client, not the injected one, so the audit ROW is
  //    not observable here — the action mapping is asserted separately below.)
  assert(
    typeof res.escalation?.detail === 'string' && res.escalation.detail.length > 0,
    `${label}: the escalation carries a readable reason (got "${res.escalation?.detail}")`,
  );
  assert(
    res.reason === res.escalation?.detail,
    `${label}: the reason surfaced to the caller is the same one recorded`,
  );

  // No outbound copy is generated for a config gap.
  assert(store.all('outreach_messages').length === 0, `${label}: no counter is written`);
}

// ── 1-2. An unusable budget value ───────────────────────────────────────────

async function scenarioUnsetBudget() {
  for (const [label, budget] of [
    ['null budget', null],
    ['undefined budget', undefined],
    ['zero budget', 0],
    ['negative budget', -500],
    ['empty-string budget', ''],
    ['non-numeric budget', 'plenty'],
  ] as Array<[string, unknown]>) {
    const store = makeStore();
    seedCampaignRaw(store, budget);
    const offer = seedOffer(store);
    await assertFailsClosed(label, store.sb, store, offer);
  }

  // The reason is spend-caps' own constant, not a second opinion about what
  // counts as a usable budget.
  const store = makeStore();
  seedCampaignRaw(store, null);
  const res = await negotiate(store.sb, seedOffer(store));
  assert(
    res.escalation?.detail.includes(CAMPAIGN_BUDGET_NOT_SET) === true,
    `the refusal reuses spend-caps' CAMPAIGN_BUDGET_NOT_SET (got "${res.escalation?.detail}")`,
  );
}

// ── 3-4. A budget we cannot READ retries; it does not park ──────────────────
//
// Review finding N1. Escalating a transient read failure sets the inbound row
// to 'flagged', which is NOT in PENDING_INBOUND_STATUSES, and no requeue path
// exists anywhere — so a one-off PostgREST blip would strand a real creator
// reply permanently. Read failures now throw, landing in negotiation-tick's
// poison-row catch, which leaves the row pending for the next tick. Only the
// durable config gap (an unset budget) belongs in the escalation lane.

async function assertRetries(
  label: string,
  sb: SupabaseClient,
  store: MockStore,
  offer: CreatorOfferRow,
) {
  let threw: Error | null = null;
  try {
    await negotiate(sb, offer);
  } catch (e) {
    threw = e as Error;
  }
  assert(threw != null, `${label}: throws into the tick's retry lane`);
  assert(
    (threw?.message ?? '').startsWith('budget_read_failed:'),
    `${label}: the throw is identifiable (got "${threw?.message}")`,
  );
  // Still fails CLOSED — nothing is agreed, nothing advances, no copy written.
  const after = store.getOffer(String(offer.id));
  assert(after?.status === 'offered', `${label}: state machine untouched`);
  assert(after?.agreed_amount_usd == null, `${label}: nothing agreed`);
  assert(Number(after?.rounds) === 0, `${label}: no round burned`);
  assert(store.all('outreach_messages').length === 0, `${label}: no counter written`);
}

async function scenarioUnreadableBudget() {
  // A query error against a PERFECTLY GOOD budget we simply cannot read.
  const errStore = makeStore();
  seedCampaignRaw(errStore, 5000);
  await assertRetries(
    'failed campaign read',
    clientFailingBudgetRead(errStore),
    errStore,
    seedOffer(errStore),
  );

  // A missing row — no campaign seeded at all.
  const missStore = makeStore();
  await assertRetries('missing campaign row', missStore.sb, missStore, seedOffer(missStore));
}

async function scenarioUnreadableCommittedSpend() {
  const store = makeStore();
  seedCampaignRaw(store, 5000);
  await assertRetries(
    'failed committed-spend read',
    clientFailingCommittedRead(store),
    store,
    seedOffer(store),
  );
}

// The retry actually happens: a tick over a failing client leaves the inbound
// row pending, and the NEXT tick against a healthy client negotiates it.
async function scenarioReadFailureIsReprocessed() {
  const store = makeStore();
  seedCampaignRaw(store, 5000);
  seedOffer(store);
  store.seed('campaign_influencers', {
    id: 'ci-47',
    campaign_id: 'camp-47',
    influencer_id: 'inf-47',
    primary_channel: 'email',
  });
  store.seed('influencers', { id: 'inf-47', display_name: 'Rae', username: 'rae' });
  store.seed('inbound_messages', {
    id: 'inb-retry',
    channel: 'email',
    external_id: 'sim:inb-retry',
    creator_offer_id: null,
    campaign_influencer_id: 'ci-47',
    from_identity: 'simulator',
    body: REPLY,
    received_at: '2026-09-17T00:00:00.000Z',
    status: 'classified',
    classification: { classification: 'negotiating', confidence: 0.8 },
  });

  const deps = {
    now: Date.parse('2026-09-17T12:00:00.000Z'),
    rand: () => 0.5,
    dispatch: async () => ({ ok: true }),
    pollGmail: async () => ({ skipped: 'gmail_not_configured' as const }),
  };

  const bad = await runNegotiationTick(clientFailingBudgetRead(store), deps);
  assert(bad.skipped === 1, `retry: the failing tick skips the row (got ${bad.skipped})`);
  assert(bad.flagged === 0, 'retry: a transient read failure is NOT flagged');
  const parked = store.all('inbound_messages').find((r) => r.id === 'inb-retry');
  assert(
    parked?.status === 'classified',
    `retry: the row stays PENDING, not parked on 'flagged' (got ${parked?.status})`,
  );

  const good = await runNegotiationTick(store.sb, deps);
  assert(
    good.processed + good.flagged === 1,
    `retry: the next healthy tick actually handles it (processed=${good.processed}, flagged=${good.flagged})`,
  );
  assert(
    store.all('inbound_messages').find((r) => r.id === 'inb-retry')?.status !== 'classified',
    'retry: and it leaves the pending set once handled',
  );
}

// ── 6. The refusal reaches the operator ─────────────────────────────────────

function scenarioSurfacedOnAnomalies() {
  assert(
    ESCALATION_AUDIT_ACTIONS.budget_unverifiable === 'negotiation.budget_unverifiable',
    'the escalation kind maps to an audit action',
  );
  assert(
    SURFACED_ACTIONS.includes('negotiation.budget_unverifiable'),
    'statuses.ts lists the action, so the refusal actually surfaces on /anomalies',
  );
  // The two lists are documented as needing to stay in step — check it.
  for (const action of Object.values(ESCALATION_AUDIT_ACTIONS)) {
    assert(SURFACED_ACTIONS.includes(action), `every escalation action is surfaced: ${action}`);
  }
}

// ── 7. No regression on a configured budget ─────────────────────────────────

async function scenarioConfiguredBudgetStillNegotiates() {
  const store = makeStore();
  seedCampaignRaw(store, 5000);
  const offer = seedOffer(store);
  const res = await negotiate(store.sb, offer);

  assert(
    res.outcome !== 'needs_human' || res.escalation?.kind !== 'budget_unverifiable',
    `a configured budget negotiates normally (got ${res.outcome}: ${res.reason})`,
  );
  assert(
    store.all('audit_log').every((r) => r.action !== 'negotiation.budget_unverifiable'),
    'a configured budget produces no budget escalation',
  );
  assert(Number(store.getOffer('offer-47')?.rounds) === 1, 'a configured budget advances the round');

  // A budget that genuinely BINDS still clamps below the per-creator ceiling:
  // $120 budget, $60 already committed elsewhere, $200 per-creator ceiling
  // → $60 of headroom, so the creator's $150 ask cannot be met at $150.
  const tight = makeStore();
  seedCampaignRaw(tight, 120, 'camp-tight');
  tight.seed('creator_offers', {
    id: 'sibling',
    campaign_id: 'camp-tight',
    firm_id: 'firm-1',
    status: 'agreed',
    agreed_amount_usd: 60,
    current_offer_usd: 60,
    ceiling_usd: 200,
  });
  const tightOffer = seedOffer(tight, 'offer-tight', 'camp-tight');
  await negotiate(tight.sb, tightOffer);
  const afterTight = tight.getOffer('offer-tight');
  // $120 budget minus $60 already committed = $60 of headroom against a $200
  // per-creator ceiling. Nothing may be AGREED above that headroom. (Our
  // standing $100 is already above it, so the ratchet refuses to quote at all
  // rather than walking our own number backwards — which is the correct
  // outcome, and exactly the behavior the fail-open path used to skip.)
  assert(
    afterTight?.agreed_amount_usd == null || Number(afterTight.agreed_amount_usd) <= 60,
    `a binding budget still clamps what may be agreed (agreed=${afterTight?.agreed_amount_usd})`,
  );
  assert(
    tight.all('audit_log').every((r) => r.action !== 'negotiation.budget_unverifiable'),
    'a binding budget is enforced, not escalated — it IS establishable',
  );
}

async function main() {
  const quiet = !process.env.DEBUG;
  const realError = console.error;
  const realWarn = console.warn;
  if (quiet) {
    console.warn = () => {};
    console.error = (...a: unknown[]) => {
      if (String(a[0] ?? '').includes('FAIL')) realError(...(a as []));
    };
  }

  await scenarioUnsetBudget();
  await scenarioUnreadableBudget();
  await scenarioUnreadableCommittedSpend();
  await scenarioReadFailureIsReprocessed();
  scenarioSurfacedOnAnomalies();
  await scenarioConfiguredBudgetStillNegotiates();

  console.warn = realWarn;
  console.error = realError;

  console.log(`budget-fail-closed test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
