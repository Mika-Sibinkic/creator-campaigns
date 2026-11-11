// tests/learning-log.test.ts
//
// The learning_logs prediction→actual spine (src/lib/learning-log.ts) — the
// writers that did not exist before. Hermetic: in-memory harness store,
// mock model provider, no network, no DB.
//
// Proves:
//   1. logLearning writes the migration-007 shape and NEVER throws;
//   2. the [SAMPLE]-synthetic exclusion holds (synthetic OR unprovable → skip);
//   3. createOffer emits the opening_offer prediction (pct × ceiling);
//   4. an autonomous acceptance emits the paired opening_offer_outcome;
//   5. logReplyPrediction freezes scoring's response_likelihood at send;
//   6. logReplyOutcome records the first-reply actual;
//   7. logDealCpm persists the full dealCpmFeatures record with predicted vs
//      actual streams-per-dollar and a label CPM that is null (never
//      fabricated) when no verified reach exists.
//
// Run: npx tsx tests/learning-log.test.ts

import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + mock provider
import { registerProvider } from '../src/lib/model-provider';
import {
  LEARNING_EVENTS,
  isSyntheticCampaign,
  logDealCpm,
  logLearning,
  logReplyOutcome,
  logReplyPrediction,
} from '../src/lib/learning-log';
import { autoNegotiateInbound, createOffer, type CreatorOfferRow } from '../src/lib/negotiation';
import { makeStore } from './negotiation-harness/store';
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

// Mock provider: a plain acceptance for the finalizeAgreement scenario.
registerProvider('mock', async ({ user }) => {
  if (user.includes('works for me')) {
    return JSON.stringify({
      intent: 'accept',
      counter_usd: null,
      sentiment: 'positive',
      confidence: 0.95,
    });
  }
  return JSON.stringify({ intent: 'unclear', counter_usd: null, sentiment: 'neutral', confidence: 0.9 });
});

function rows(store: ReturnType<typeof makeStore>, event?: string) {
  const all = store.all('learning_logs');
  return event ? all.filter((r) => r.event_type === event) : all;
}

// ── 1+2. logLearning basics + synthetic exclusion ───────────────────────────

async function scenarioBasicsAndSyntheticExclusion() {
  const store = makeStore();
  store.seed('campaigns', { id: 'camp-real', firm_id: 'firm-1', synthetic: false });
  store.seed('campaigns', { id: 'camp-sample', firm_id: 'firm-1', synthetic: true });

  await logLearning(store.sb, {
    event_type: LEARNING_EVENTS.REPLY_OUTCOME,
    campaign_id: 'camp-real',
    influencer_id: 'inf-1',
    input_data: { k: 'v' },
    predicted_value: { p: 1 },
    actual_value: { a: 2 },
  });
  const written = rows(store);
  assert(written.length === 1, `real campaign: one row written (got ${written.length})`);
  const row = written[0];
  assert(row.event_type === 'reply_outcome', 'row carries event_type');
  assert(JSON.stringify(row.input_data) === '{"k":"v"}', 'row carries input_data');
  assert(JSON.stringify(row.predicted_value) === '{"p":1}', 'row carries predicted_value');
  assert(JSON.stringify(row.actual_value) === '{"a":2}', 'row carries actual_value');
  assert(row.campaign_id === 'camp-real' && row.influencer_id === 'inf-1', 'row carries fk columns');

  // Synthetic campaign → skipped.
  await logLearning(store.sb, {
    event_type: LEARNING_EVENTS.REPLY_OUTCOME,
    campaign_id: 'camp-sample',
    actual_value: { a: 1 },
  });
  assert(rows(store).length === 1, 'synthetic campaign: row NOT written');

  // Unknown campaign (unprovable) → skipped, fail closed.
  await logLearning(store.sb, {
    event_type: LEARNING_EVENTS.REPLY_OUTCOME,
    campaign_id: 'camp-ghost',
    actual_value: { a: 1 },
  });
  assert(rows(store).length === 1, 'unprovable campaign: row NOT written (fail closed)');

  // No campaign_id → system-scoped, writes.
  await logLearning(store.sb, {
    event_type: LEARNING_EVENTS.REPLY_OUTCOME,
    actual_value: { a: 1 },
  });
  assert(rows(store).length === 2, 'campaign-less entry writes (system-scoped)');

  // isSyntheticCampaign tri-state.
  assert((await isSyntheticCampaign(store.sb, 'camp-real')) === false, 'tri-state: real → false');
  assert((await isSyntheticCampaign(store.sb, 'camp-sample')) === true, 'tri-state: synthetic → true');
  assert((await isSyntheticCampaign(store.sb, 'camp-ghost')) === null, 'tri-state: unknown → null');
  assert((await isSyntheticCampaign(store.sb, null)) === null, 'tri-state: no id → null');
}

// ── never-throws on a broken client ─────────────────────────────────────────

async function scenarioNeverThrows() {
  const broken = {
    from() {
      throw new Error('db is down');
    },
  } as unknown as SupabaseClient;
  let threw = false;
  try {
    await logLearning(broken, { event_type: LEARNING_EVENTS.DEAL_CPM, actual_value: { a: 1 } });
    await logReplyPrediction(broken, { campaignInfluencerId: 'ci-1', channel: 'email' });
    await logReplyOutcome(broken, { campaignInfluencerId: 'ci-1', channel: 'email' });
    await logDealCpm(broken, {
      creatorOfferId: 'o-1',
      campaignId: 'c-1',
      firmId: 'f-1',
      streamsAttributed: 10,
      paymentUsd: 5,
      attributionMethod: 'manual',
    });
  } catch {
    threw = true;
  }
  assert(!threw, 'no learning writer ever throws, even with a dead DB client');
}

// ── 3. createOffer emits the opening_offer prediction ───────────────────────

async function scenarioCreateOfferPrediction() {
  const store = makeStore();
  store.seed('campaigns', { id: 'camp-o', firm_id: 'firm-o', synthetic: false, total_budget_usd: 1000 });

  const offer = await createOffer(store.sb, {
    campaign_influencer_id: 'ci-o',
    campaign_id: 'camp-o',
    firm_id: 'firm-o',
    follower_count: 12_000,
    engagement_rate: 0.05,
    per_creator_cap_usd: 200,
  });

  const preds = rows(store, LEARNING_EVENTS.OPENING_OFFER);
  assert(preds.length === 1, `createOffer: one opening_offer row (got ${preds.length})`);
  const p = preds[0];
  const input = p.input_data as Record<string, unknown>;
  const predicted = p.predicted_value as Record<string, unknown>;
  assert(input.creator_offer_id === offer.id, 'prediction keyed to the created offer');
  assert(input.follower_count === 12_000 && input.engagement_rate === 0.05, 'estimator inputs recorded');
  assert(input.method === 'cold_start', `cold start recorded (got ${input.method})`);
  assert(
    Math.abs(Number(predicted.agreed_amount_usd) - Number(predicted.opening_pct) * 200) < 0.01,
    'predicted agreed amount = opening_pct × ceiling',
  );
  assert(
    Number(predicted.opening_pct) === Number(offer.opening_pct),
    'logged opening_pct matches the persisted offer column',
  );
}

// ── 4. acceptance emits the paired opening_offer_outcome ────────────────────

async function scenarioAcceptanceOutcome() {
  const store = makeStore();
  store.seed('campaigns', { id: 'camp-a', firm_id: 'firm-1', synthetic: false, total_budget_usd: 1000 });
  const offer = store.seed('creator_offers', {
    id: 'offer-a',
    campaign_influencer_id: 'ci-a',
    campaign_id: 'camp-a',
    firm_id: 'firm-1',
    status: 'offered',
    initial_offer_usd: 100,
    current_offer_usd: 100,
    agreed_amount_usd: null,
    ceiling_usd: 200,
    rounds: 1,
    autonomy_mode: 'auto',
    opening_pct: 0.5,
    injection_flagged: false,
    created_at: '2026-09-17T00:00:00.000Z',
    updated_at: '2026-09-17T00:00:00.000Z',
  }) as unknown as CreatorOfferRow;

  const res = await autoNegotiateInbound(store.sb, offer, {
    inbound_text: 'Sounds good, $100 works for me.',
    inbound_message_id: 'inb-a',
  });
  // The human-gate change (made after this suite was written) removed
  // 'accepted_paid': no autonomy/payment-mode combination may skip the human
  // approval gate, so an acceptance now lands on accepted_pending_approval.
  // The learning pair is written when the PRICE is agreed, which is upstream of
  // the gate, so the assertions below are unaffected by where it parks.
  assert(
    res.outcome === 'accepted_pending_approval',
    `acceptance path ran (got ${res.outcome})`,
  );

  const outs = rows(store, LEARNING_EVENTS.OPENING_OFFER_OUTCOME);
  assert(outs.length === 1, `one opening_offer_outcome row (got ${outs.length})`);
  const o = outs[0];
  const input = o.input_data as Record<string, unknown>;
  const predicted = o.predicted_value as Record<string, unknown>;
  const actual = o.actual_value as Record<string, unknown>;
  assert(input.creator_offer_id === 'offer-a', 'outcome keyed to the offer (the pair join key)');
  assert(Number(predicted.agreed_amount_usd) === 100, 'predicted = opening_pct 0.5 × ceiling 200 = 100');
  assert(Number(actual.agreed_amount_usd) === 100, 'actual agreed amount recorded');
}

// ── 5+6. reply prediction ↔ outcome pair ────────────────────────────────────

async function scenarioReplyPair() {
  const store = makeStore();
  store.seed('campaigns', { id: 'camp-r', firm_id: 'firm-1', synthetic: false });
  store.seed('campaign_influencers', {
    id: 'ci-r',
    campaign_id: 'camp-r',
    influencer_id: 'inf-r',
    score_breakdown: { response_likelihood: 72, engagement_quality: 90 },
  });

  await logReplyPrediction(store.sb, {
    campaignInfluencerId: 'ci-r',
    channel: 'email',
    outreachMessageId: 'msg-r',
  });
  const preds = rows(store, LEARNING_EVENTS.REPLY_PREDICTION);
  assert(preds.length === 1, `one reply_prediction row (got ${preds.length})`);
  const p = preds[0];
  assert(
    (p.predicted_value as Record<string, unknown>).response_likelihood === 72,
    'prediction is the frozen scoring response_likelihood component',
  );
  assert(p.influencer_id === 'inf-r' && p.campaign_id === 'camp-r', 'prediction carries fk scope');
  assert(
    (p.input_data as Record<string, unknown>).channel === 'email',
    'prediction records the send channel',
  );

  await logReplyOutcome(store.sb, {
    campaignInfluencerId: 'ci-r',
    channel: 'email',
    classification: 'interested',
  });
  const outs = rows(store, LEARNING_EVENTS.REPLY_OUTCOME);
  assert(outs.length === 1, `one reply_outcome row (got ${outs.length})`);
  const a = outs[0].actual_value as Record<string, unknown>;
  assert(a.replied === true && a.classification === 'interested', 'outcome records the reply actual');

  // A CI with no score_breakdown still logs (predicted null, honest).
  store.seed('campaign_influencers', { id: 'ci-bare', campaign_id: 'camp-r', influencer_id: 'inf-b' });
  await logReplyPrediction(store.sb, { campaignInfluencerId: 'ci-bare', channel: 'tiktok_dm' });
  const bare = rows(store, LEARNING_EVENTS.REPLY_PREDICTION).find(
    (r) => (r.input_data as Record<string, unknown>).campaign_influencer_id === 'ci-bare',
  );
  assert(bare != null, 'bare CI still logs a prediction row');
  assert(
    (bare?.predicted_value as Record<string, unknown>).response_likelihood === null,
    'missing breakdown → predicted null, never fabricated',
  );
}

// ── 7. deal_cpm ─────────────────────────────────────────────────────────────

async function scenarioDealCpm() {
  const store = makeStore();
  store.seed('campaigns', { id: 'camp-d', firm_id: 'firm-d', synthetic: false });
  store.seed('campaigns', { id: 'camp-synth', firm_id: 'firm-d', synthetic: true });
  store.seed('campaign_influencers', { id: 'ci-d', campaign_id: 'camp-d', influencer_id: 'inf-d', composite_score: 80 });
  store.seed('campaign_influencers', { id: 'ci-d2', campaign_id: 'camp-d', influencer_id: 'inf-d2', composite_score: 60 });
  store.seed('creator_offers', {
    id: 'offer-d',
    campaign_influencer_id: 'ci-d',
    campaign_id: 'camp-d',
    firm_id: 'firm-d',
    status: 'measured',
    initial_offer_usd: 80,
    agreed_amount_usd: 100,
    rounds: 2,
    agreed_deliverables: [
      { promo_type: 'reel', quantity: 1, delivery_window_days: 14, min_seconds: 30 },
    ],
  });
  // Verified reach: one delivery, latest snapshot wins.
  store.seed('deal_deliveries', { id: 'del-d', creator_offer_id: 'offer-d' });
  store.seed('deal_performance_snapshots', {
    id: 'snap-1',
    deal_delivery_id: 'del-d',
    captured_at: '2026-09-10T00:00:00.000Z',
    views: 10_000,
  });
  store.seed('deal_performance_snapshots', {
    id: 'snap-2',
    deal_delivery_id: 'del-d',
    captured_at: '2026-09-16T00:00:00.000Z',
    views: 25_000,
  });
  // History: one prior real outcome + one synthetic-campaign outcome that must
  // be excluded from the prediction basis.
  store.seed('campaign_outcomes', {
    id: 'oc-prior',
    creator_offer_id: 'offer-prior',
    campaign_id: 'camp-d',
    streams_attributed: 5_000,
    payment_usd_amount: 50,
    follower_count_at_post: 10_000,
  });
  store.seed('campaign_outcomes', {
    id: 'oc-synth',
    creator_offer_id: 'offer-synth',
    campaign_id: 'camp-synth',
    streams_attributed: 999_999,
    payment_usd_amount: 1,
    follower_count_at_post: 10_000,
  });

  await logDealCpm(store.sb, {
    creatorOfferId: 'offer-d',
    campaignId: 'camp-d',
    firmId: 'firm-d',
    streamsAttributed: 20_000,
    paymentUsd: 100,
    attributionMethod: 'manual',
    followerCountAtPost: 12_000,
  });

  const rowsD = rows(store, LEARNING_EVENTS.DEAL_CPM);
  assert(rowsD.length === 1, `one deal_cpm row (got ${rowsD.length})`);
  const r = rowsD[0];
  const input = r.input_data as Record<string, unknown>;
  const features = input.features as Record<string, unknown>;
  const predicted = r.predicted_value as Record<string, unknown>;
  const actual = r.actual_value as Record<string, unknown>;

  assert(input.creator_offer_id === 'offer-d', 'deal_cpm keyed to the offer');
  assert(r.influencer_id === 'inf-d', 'deal_cpm resolves influencer_id');
  // The full dealCpmFeatures record.
  assert(Number(features.agreed_amount_usd) === 100, 'features: agreed amount');
  assert(Number(features.outreach_to_agreement_delta_usd) === 20, 'features: opening→agreed delta (100−80)');
  assert(Number(features.rounds) === 2, 'features: rounds');
  assert(Number(features.reach) === 25_000, 'features: reach = LATEST snapshot views, not the stale one');
  assert(Number(features.label_cpm) === 4, 'features: label CPM = 100 / 25 = $4.00');
  assert(Number(features.campaign_size) === 2, 'features: campaign size from the pool');
  assert(Number(features.scrape_quality) === 70, 'features: avg composite score of the pool');
  // Predicted from PRIOR history only — fallback tier at 1 usable point, and
  // the synthetic outcome (999999 streams for $1) must not have leaked in.
  assert(predicted.method === 'fallback', `predicted method fallback at n=1 (got ${predicted.method})`);
  assert(Number(predicted.sample_size) === 1, `synthetic outcome excluded from history (got n=${predicted.sample_size})`);
  // Actuals.
  assert(Number(actual.streams_per_dollar) === 200, 'actual streams/dollar = 20000/100');
  assert(Number(actual.label_cpm) === 4, 'actual label CPM from verified reach');

  // No verified reach → label_cpm NULL, never fabricated.
  store.seed('creator_offers', {
    id: 'offer-noreach',
    campaign_influencer_id: 'ci-d2',
    campaign_id: 'camp-d',
    firm_id: 'firm-d',
    status: 'measured',
    initial_offer_usd: 50,
    agreed_amount_usd: 50,
    rounds: 1,
    agreed_deliverables: null,
  });
  await logDealCpm(store.sb, {
    creatorOfferId: 'offer-noreach',
    campaignId: 'camp-d',
    firmId: 'firm-d',
    streamsAttributed: 1000,
    paymentUsd: 50,
    attributionMethod: 'manual',
  });
  const noReach = rows(store, LEARNING_EVENTS.DEAL_CPM).find(
    (x) => (x.input_data as Record<string, unknown>).creator_offer_id === 'offer-noreach',
  );
  assert(noReach != null, 'no-reach deal still logs');
  assert(
    (noReach?.actual_value as Record<string, unknown>).label_cpm === null,
    'no verified reach → label_cpm null (never fabricated)',
  );

  // A synthetic campaign's deal_cpm is refused wholesale.
  await logDealCpm(store.sb, {
    creatorOfferId: 'offer-synth',
    campaignId: 'camp-synth',
    firmId: 'firm-d',
    streamsAttributed: 1,
    paymentUsd: 1,
    attributionMethod: 'manual',
  });
  assert(
    rows(store, LEARNING_EVENTS.DEAL_CPM).length === 2,
    'synthetic campaign deal_cpm not written',
  );
}

async function main() {
  const origError = console.error;
  if (!process.env.DEBUG) console.error = () => {};

  await scenarioBasicsAndSyntheticExclusion();
  await scenarioNeverThrows();
  await scenarioCreateOfferPrediction();
  await scenarioAcceptanceOutcome();
  await scenarioReplyPair();
  await scenarioDealCpm();

  console.error = origError;
  console.log(`learning-log test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
