// tests/analytics.test.ts
//
// Unit tests for src/lib/analytics.ts — the money/outcome metric functions and
// the RL opening-offer estimator. Pure + hermetic: no env, no DB, no network.
// Every metric formula (conversion, spend, ROI, CPM, per-creator) and the RL
// estimator (cold-start, learned-equilibrium, gap correction, determinism) is
// exercised on synthetic fixtures with hand-computed expected values.
//
// Run: npx tsx tests/analytics.test.ts

import {
  computeConversion,
  computeDeals,
  computeSpend,
  computeOutputPerDollar,
  computeCpm,
  computePerCreator,
  computeCampaignAnalytics,
  computeFirmRollup,
  estimateOpeningPct,
  marginalOutputPerDollar,
  chooseSweetSpot,
  offerSpend,
  type AnalyticsOfferRow,
  type AnalyticsOutcomeRow,
  type AnalyticsOutreachRow,
  type AnalyticsInboundRow,
} from '../src/lib/analytics';
import type { MarketDataPoint } from '../src/lib/pricing-engine';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

const EPS = 1e-6;
const close = (a: number | null, b: number, eps = EPS): boolean =>
  a != null && Math.abs(a - b) < eps;

// Offer factory (fills the fields the analytics reads).
function offer(o: Partial<AnalyticsOfferRow> & { id: string; status: string }): AnalyticsOfferRow {
  return {
    campaign_id: 'c1',
    campaign_influencer_id: null,
    agreed_amount_usd: null,
    current_offer_usd: null,
    initial_offer_usd: null,
    ceiling_usd: 500,
    opening_pct: null,
    ...o,
  };
}

// ── 1. Response-conversion rate = replies ÷ sent ─────────────────────────────
{
  const outreach: AnalyticsOutreachRow[] = [
    { campaign_influencer_id: 'a', direction: 'outbound', status: 'sent' },
    { campaign_influencer_id: 'b', direction: 'outbound', status: 'sent' },
    { campaign_influencer_id: 'c', direction: 'outbound', status: 'draft' }, // not sent
    { campaign_influencer_id: 'a', direction: 'inbound', status: null }, // legacy reply
  ];
  const inbound: AnalyticsInboundRow[] = [
    { campaign_influencer_id: 'b' },
    { campaign_influencer_id: 'b' }, // dedupes to one replier
  ];
  const c = computeConversion(outreach, inbound);
  assert(c.creators_sent === 2, `conversion: creators_sent=2 (got ${c.creators_sent})`);
  assert(c.messages_sent === 2, `conversion: messages_sent=2 (got ${c.messages_sent})`);
  assert(
    c.creators_replied === 2,
    `conversion: creators_replied=2 across both sources (got ${c.creators_replied})`,
  );
  assert(close(c.response_conversion_rate, 1), `conversion: rate=1.0 (got ${c.response_conversion_rate})`);

  const empty = computeConversion([], []);
  assert(empty.response_conversion_rate === null, 'conversion: divide-by-zero → null');
}

// ── 2. Deals closed ──────────────────────────────────────────────────────────
{
  const offers = [
    offer({ id: 'o1', status: 'offered' }),
    offer({ id: 'o2', status: 'agreed', agreed_amount_usd: 100 }),
    offer({ id: 'o3', status: 'paid', agreed_amount_usd: 200 }),
    offer({ id: 'o4', status: 'posted', agreed_amount_usd: 50 }),
    offer({ id: 'o5', status: 'measured', agreed_amount_usd: 75 }),
    offer({ id: 'o6', status: 'rejected' }),
    offer({ id: 'o7', status: 'failed' }),
    offer({ id: 'o8', status: 'counter_offered' }),
  ];
  const d = computeDeals(offers);
  assert(d.offers_total === 8, `deals: offers_total=8 (got ${d.offers_total})`);
  assert(d.deals_closed === 4, `deals: deals_closed=4 (got ${d.deals_closed})`);
  assert(d.paid_count === 3, `deals: paid_count=3 (got ${d.paid_count})`);
  assert(d.delivered_count === 2, `deals: delivered_count=2 (got ${d.delivered_count})`);
  assert(d.rejected_count === 2, `deals: rejected_count=2 (got ${d.rejected_count})`);
}

// ── Spend consumed / remaining ───────────────────────────────────────────────
{
  const offers = [
    offer({ id: 'o1', status: 'agreed', agreed_amount_usd: 100 }),
    offer({ id: 'o2', status: 'paid', agreed_amount_usd: 200 }),
    offer({ id: 'o3', status: 'posted', agreed_amount_usd: 50 }),
    offer({ id: 'o4', status: 'offered', current_offer_usd: 80 }), // not committed
    offer({ id: 'o5', status: 'counter_offered', current_offer_usd: 90 }), // not committed
  ];
  const s = computeSpend(offers, { total_budget_usd: 1000, budget: null });
  assert(s.spend_committed_usd === 350, `spend: committed=350 (got ${s.spend_committed_usd})`);
  assert(s.spend_paid_usd === 250, `spend: paid=250 (got ${s.spend_paid_usd})`);
  assert(s.budget_usd === 1000, `spend: budget=1000 (got ${s.budget_usd})`);
  assert(s.remaining_usd === 650, `spend: remaining=650 (got ${s.remaining_usd})`);
  assert(close(s.consumed_pct, 0.35), `spend: consumed_pct=0.35 (got ${s.consumed_pct})`);

  const fb = computeSpend(offers, { total_budget_usd: null, budget: 500 });
  assert(fb.budget_usd === 500, `spend: falls back to legacy budget column (got ${fb.budget_usd})`);

  const none = computeSpend(offers, { total_budget_usd: null, budget: null });
  assert(none.budget_usd === null, 'spend: no budget → budget null');
  assert(none.remaining_usd === null, 'spend: no budget → remaining null');
  assert(none.consumed_pct === null, 'spend: no budget → consumed_pct null');
}

// offerSpend prefers agreed over current.
{
  assert(offerSpend(offer({ id: 'x', status: 'agreed', agreed_amount_usd: 120, current_offer_usd: 90 })) === 120, 'offerSpend: agreed wins');
  assert(offerSpend(offer({ id: 'x', status: 'offered', current_offer_usd: 90 })) === 90, 'offerSpend: falls back to current');
}

// ── 2b. Output-per-dollar (ROI) ──────────────────────────────────────────────
{
  const offers = [
    offer({ id: 'o1', status: 'measured', agreed_amount_usd: 100 }),
    offer({ id: 'o2', status: 'measured', agreed_amount_usd: 50 }),
  ];
  const outcomes: AnalyticsOutcomeRow[] = [
    { creator_offer_id: 'o1', streams_attributed: 10000, payment_usd_amount: 100, follower_count_at_post: null },
    { creator_offer_id: 'o2', streams_attributed: 6000, payment_usd_amount: null, follower_count_at_post: null }, // spend falls back to offer
  ];
  const r = computeOutputPerDollar(offers, outcomes);
  assert(r.total_output === 16000, `roi: total_output=16000 (got ${r.total_output})`);
  assert(r.output_spend_usd === 150, `roi: output_spend=150 (payment ?? offer spend) (got ${r.output_spend_usd})`);
  assert(close(r.output_per_dollar, 16000 / 150), `roi: output_per_dollar=106.67 (got ${r.output_per_dollar})`);

  const zero = computeOutputPerDollar(
    [offer({ id: 'x', status: 'offered' })],
    [{ creator_offer_id: 'x', streams_attributed: 100, payment_usd_amount: 0, follower_count_at_post: null }],
  );
  assert(zero.output_per_dollar === null, 'roi: divide-by-zero (no spend) → null');
}

// ── 3. CPM ───────────────────────────────────────────────────────────────────
{
  const offers = [
    offer({ id: 'o1', campaign_influencer_id: 'a', status: 'measured', agreed_amount_usd: 100 }),
    offer({ id: 'o2', campaign_influencer_id: 'b', status: 'posted', agreed_amount_usd: 50 }),
    offer({ id: 'o3', campaign_influencer_id: 'c', status: 'paid', agreed_amount_usd: 40 }), // paid, not delivered → excluded
  ];
  // Reach = REAL verified post impressions per offer (deal_performance_snapshots).
  const reachByOffer = new Map<string, number>([
    ['o1', 20000],
    ['o2', 3000],
    ['o3', 9999], // paid-not-delivered → excluded regardless of reach
  ]);
  const cpm = computeCpm(offers, reachByOffer);
  assert(cpm.delivered_reach === 23000, `cpm: delivered_reach=23000 (verified impressions o1+o2) (got ${cpm.delivered_reach})`);
  assert(cpm.spend_usd === 150, `cpm: spend=150 (delivered offers only) (got ${cpm.spend_usd})`);
  assert(cpm.cpm_usd === 6.52, `cpm: cpm=6.52 (labelCpm rounds to cents) (got ${cpm.cpm_usd})`);

  // An unmeasured delivered offer contributes spend but ZERO reach — no
  // follower/stream substitution. Total reach 0 → cpm null (not fabricated).
  const cpmUnmeasured = computeCpm(
    [offer({ id: 'o4', status: 'posted', agreed_amount_usd: 10 })],
    new Map(),
  );
  assert(cpmUnmeasured.delivered_reach === 0, `cpm: unmeasured → 0 reach (got ${cpmUnmeasured.delivered_reach})`);
  assert(cpmUnmeasured.cpm_usd === null, 'cpm: unmeasured delivered → null (no follower substitution)');

  const cpm0 = computeCpm([offer({ id: 'x', status: 'offered' })], new Map());
  assert(cpm0.cpm_usd === null, 'cpm: no delivered reach → null');
}

// ── 4. Per-creator perceived outcome = output ÷ paid ─────────────────────────
{
  const offers = [
    offer({ id: 'o1', campaign_influencer_id: 'a', status: 'measured', agreed_amount_usd: 100 }),
    offer({ id: 'o2', campaign_influencer_id: 'b', status: 'paid', agreed_amount_usd: 50 }),
    offer({ id: 'o3', campaign_influencer_id: 'c', status: 'offered', current_offer_usd: 30 }), // not paid → excluded
  ];
  const outcomes: AnalyticsOutcomeRow[] = [
    { creator_offer_id: 'o1', streams_attributed: 20000, payment_usd_amount: null, follower_count_at_post: null },
  ];
  const rows = computePerCreator(offers, outcomes);
  assert(rows.length === 2, `per-creator: 2 paid rows (got ${rows.length})`);
  assert(rows[0].offer_id === 'o1', 'per-creator: sorted best output-per-dollar first');
  assert(close(rows[0].output_per_dollar, 200), `per-creator: o1 output/paid=200 (got ${rows[0].output_per_dollar})`);
  assert(rows[0].has_outcome === true, 'per-creator: o1 has outcome');
  assert(rows[1].output === 0 && rows[1].has_outcome === false, 'per-creator: o2 paid but unmeasured → output 0');
  assert(close(rows[1].output_per_dollar, 0), 'per-creator: o2 output-per-dollar 0');
}

// ── Marginal-output helpers (parity with negotiation harness) ────────────────
{
  assert(marginalOutputPerDollar({ cost_usd: 20, expected_output: 100 }, { cost_usd: 25, expected_output: 145 }) === 9, 'marginal: +45/+$5 = 9');
  assert(chooseSweetSpot([{ cost_usd: 20, expected_output: 100 }, { cost_usd: 25, expected_output: 145 }]) === 1, 'sweetspot: rides up when marginal clears bar');
  assert(chooseSweetSpot([{ cost_usd: 20, expected_output: 100 }, { cost_usd: 25, expected_output: 145 }, { cost_usd: 60, expected_output: 150 }]) === 1, 'sweetspot: stops at diminishing returns');
  assert(chooseSweetSpot([]) === -1, 'sweetspot: empty → -1');
}

// ── RL opening-pct estimator ─────────────────────────────────────────────────
{
  // Cold-start (no history) → deterministic pricing-engine prior.
  const cold = estimateOpeningPct({ follower_count: 5000, engagement_rate: 0.05, genre: 'pop', ceiling_usd: 500 });
  assert(cold.method === 'cold_start', `rl: no history → cold_start (got ${cold.method})`);
  assert(cold.equilibrium_pct === null, 'rl: cold-start has no equilibrium');
  // 75, not 83. The cold-start prior is `tierBaseUsd * engagement * genre` =
  // 50 * clamp(0.7 + 0.05/0.05) * genre = 50 * 1.5 * genre. That last factor
  // would be 1.1 for 'pop' if any genre premium were hardcoded. The premium
  // table is per-firm configuration
  // defaulting to EMPTY (src/lib/genre-config.ts), so an unconfigured firm
  // gets the neutral 1.0 and 50 * 1.5 * 1.0 = 75.
  //
  // A firm that wants the old behaviour sets
  // firms.scraping_prefs.genre_premiums = {"pop": 1.1} and gets 83 back;
  // tests/genre-config.test.ts asserts exactly that round-trip.
  //
  // The engagement multiplier is now calibrated to a TikTok
  // distribution (pricing-engine.ts). 5% ER sits below the 8.13% median, so it
  // is 0.907x, not the old saturated 1.5x: 50 * 0.907 * 1.0 = 45.
  assert(close(cold.opening_pct, 45 / 500), `rl: cold-start prior = pricing/ceiling = 0.09 (got ${cold.opening_pct})`);
  assert(cold.opening_pct > 0 && cold.opening_pct < 1, 'rl: cold-start opening in (0,1)');

  // Ceiling 0 → 0.
  const z = estimateOpeningPct({ follower_count: 5000, engagement_rate: 0.05, ceiling_usd: 0 });
  assert(z.opening_pct === 0 && z.method === 'cold_start', 'rl: ceiling 0 → 0');

  // Learned path: ≥5 (cost, output) points with a clear sweet spot at $150.
  const mkPoint = (payment_usd: number, streams: number): MarketDataPoint => ({
    follower_count: 5000,
    engagement_rate: 0.05,
    payment_usd,
    streams_attributed: streams,
    genre: 'pop',
  });
  const history: MarketDataPoint[] = [
    mkPoint(50, 5000), // baseline avg 100/$
    mkPoint(100, 12000), // marginal 140/$ ≥ 100 → ride
    mkPoint(150, 20000), // marginal 160/$ ≥ 100 → ride
    mkPoint(200, 22000), // marginal 40/$ < 100 → stop (sweet spot = $150)
    mkPoint(250, 22500),
    mkPoint(300, 23000),
  ];
  const ctxRl = { follower_count: 5000, engagement_rate: 0.05, genre: 'pop', ceiling_usd: 500, market_data: history };
  const rl = estimateOpeningPct(ctxRl);
  assert(rl.method === 'rl', `rl: ≥N history → rl method (got ${rl.method})`);
  assert(rl.sample_size === 6, `rl: sample_size=6 (got ${rl.sample_size})`);
  assert(close(rl.equilibrium_pct ?? -1, 0.3), `rl: equilibrium = $150/$500 = 0.3 (got ${rl.equilibrium_pct})`);
  assert(close(rl.confidence, 0.2), `rl: fallback confidence 0.2 for n<8 (got ${rl.confidence})`);
  // pct = (1-0.2)*prior + 0.2*equilibrium = 0.8*0.09 + 0.2*0.3
  // Prior is 45/500 — see the cold-start note above.
  const expectedRl = 0.8 * (45 / 500) + 0.2 * 0.3;
  assert(close(rl.opening_pct, expectedRl), `rl: blended opening (got ${rl.opening_pct}, want ${expectedRl})`);
  assert(rl.opening_pct >= 0 && rl.opening_pct <= 1, 'rl: opening in [0,1]');

  // Gap correction UP: deals close above where we opened → raise opening.
  const up = estimateOpeningPct({ ...ctxRl, negotiation_history: [{ opening_usd: 100, agreed_usd: 200, ceiling_usd: 500 }] });
  assert(close(up.gap_adjustment_pct, 0.1), `rl: gap up = 0.5 * (100/500) = 0.1 (got ${up.gap_adjustment_pct})`);
  assert(up.opening_pct > rl.opening_pct, 'rl: positive gap raises opening');
  assert(close(up.opening_pct, expectedRl + 0.1), 'rl: opening = blended + gap');

  // Gap correction DOWN: deals close below opening → lower opening.
  const down = estimateOpeningPct({ ...ctxRl, negotiation_history: [{ opening_usd: 200, agreed_usd: 100, ceiling_usd: 500 }] });
  assert(down.opening_pct < rl.opening_pct, 'rl: negative gap lowers opening');

  // Determinism: identical inputs → identical output.
  const a = estimateOpeningPct(ctxRl);
  const b = estimateOpeningPct(ctxRl);
  assert(a.opening_pct === b.opening_pct && a.method === b.method, 'rl: deterministic');
}

// ── Integration: campaign analytics + firm rollup ────────────────────────────
{
  const offers = [
    offer({ id: 'o1', campaign_id: 'C1', campaign_influencer_id: 'a', status: 'measured', agreed_amount_usd: 100, opening_pct: 0.2 }),
    offer({ id: 'o2', campaign_id: 'C1', campaign_influencer_id: 'b', status: 'paid', agreed_amount_usd: 50, opening_pct: 0.4 }),
  ];
  const outcomes: AnalyticsOutcomeRow[] = [
    { creator_offer_id: 'o1', streams_attributed: 20000, payment_usd_amount: 100, follower_count_at_post: null },
  ];
  const outreach: AnalyticsOutreachRow[] = [
    { campaign_influencer_id: 'a', direction: 'outbound', status: 'sent' },
    { campaign_influencer_id: 'b', direction: 'outbound', status: 'sent' },
    { campaign_influencer_id: 'a', direction: 'inbound', status: null },
  ];
  const reach = new Map<string, number>([['a', 5000], ['b', 3000]]);

  const c1 = computeCampaignAnalytics({
    campaign: { id: 'C1', artist_name: 'Example Records', status: 'active', total_budget_usd: 1000, budget: null },
    offers,
    outcomes,
    outreach,
    inbound: [],
    reachByOffer: reach,
  });
  assert(c1.spend.spend_committed_usd === 150, `campaign: committed=150 (got ${c1.spend.spend_committed_usd})`);
  assert(c1.deals.deals_closed === 2, `campaign: 2 deals closed (got ${c1.deals.deals_closed})`);
  assert(close(c1.rl.opening_pct_avg ?? -1, 0.3), `campaign: opening_pct_avg=(0.2+0.4)/2=0.3 (got ${c1.rl.opening_pct_avg})`);
  assert(c1.rl.outcomes_sample === 1, 'campaign: 1 outcome feeds RL');
  assert(close(c1.conversion.response_conversion_rate, 0.5), `campaign: conversion=1/2 (got ${c1.conversion.response_conversion_rate})`);

  // Empty second campaign contributes zeros; rollup ratios recompute from sums.
  const c2 = computeCampaignAnalytics({
    campaign: { id: 'C2', artist_name: 'Empty', status: 'draft', total_budget_usd: 500, budget: null },
    offers: [],
    outcomes: [],
    outreach: [],
    inbound: [],
    reachByOffer: new Map(),
  });
  const firm = computeFirmRollup([c1, c2]);
  assert(firm.campaigns_count === 2, 'firm: 2 campaigns');
  assert(firm.spend.spend_committed_usd === 150, `firm: committed sums to 150 (got ${firm.spend.spend_committed_usd})`);
  assert(firm.spend.budget_usd === 1500, `firm: budgets sum to 1500 (got ${firm.spend.budget_usd})`);
  assert(close(firm.roi.output_per_dollar, 20000 / 100), `firm: ROI recomputed from sums = 200 (got ${firm.roi.output_per_dollar})`);
  assert(close(firm.conversion.response_conversion_rate, 0.5), 'firm: conversion recomputed from summed sent/replied');
}

// ── REGRESSION: delivery events must never reach `status` ─
//
// The Resend delivery webhook had never once matched a row (it compared
// Resend's email_id against our internal outreach_messages.id — different id
// spaces). The moment that was fixed, it began writing 'delivered' / 'opened'
// / 'bounced' into outreach_messages.status, which is free-text and would have
// accepted them silently.
//
// computeConversion counts `creators_sent` as status==='sent' but
// `creators_replied` as ANY inbound regardless of outbound status. So an
// engaged creator leaves the DENOMINATOR the moment a delivery event lands
// while staying in the NUMERATOR. The bias is systematic, not noisy: the
// creators most likely to reply are exactly the ones an `email.opened`
// removes first.
//
// Migration 046 moves delivery state to its own column, so `status` stays
// terminal at 'sent'. This test pins the invariant AND demonstrates the
// failure it prevents, so nobody "simplifies" the two columns back into one.
function testDeliveryEventsCannotInflateConversion() {
  const outreach: AnalyticsOutreachRow[] = [
    { campaign_influencer_id: 'ci-1', direction: 'outbound', status: 'sent' },
    { campaign_influencer_id: 'ci-2', direction: 'outbound', status: 'sent' },
    { campaign_influencer_id: 'ci-3', direction: 'outbound', status: 'sent' },
  ];
  const inbound: AnalyticsInboundRow[] = [
    { campaign_influencer_id: 'ci-1' },
    { campaign_influencer_id: 'ci-2' },
  ];

  const base = computeConversion(outreach, inbound);
  assert(base.creators_sent === 3, `delivery-regression: 3 creators contacted (got ${base.creators_sent})`);
  assert(base.creators_replied === 2, `delivery-regression: 2 replied (got ${base.creators_replied})`);
  assert(close(base.response_conversion_rate, 2 / 3), 'delivery-regression: baseline rate is 2/3');

  // Post-046 the webhook writes delivery_status, an orthogonal column this
  // reader does not read. Every delivery event in the vocabulary lands and
  // the funnel is bit-identical.
  for (const ev of ['delivered', 'opened', 'clicked', 'bounced', 'complained']) {
    const withDelivery = outreach.map((m) => ({ ...m, delivery_status: ev })) as AnalyticsOutreachRow[];
    const after = computeConversion(withDelivery, inbound);
    assert(
      after.creators_sent === 3,
      `delivery-regression: '${ev}' on delivery_status leaves creators_sent at 3 (got ${after.creators_sent})`,
    );
    assert(
      close(after.response_conversion_rate, 2 / 3),
      `delivery-regression: '${ev}' does not move the conversion rate`,
    );
    assert(
      (after.response_conversion_rate ?? 0) <= 1,
      `delivery-regression: rate stays <= 1.0 after '${ev}' — a rate above 1 is arithmetically impossible and means the denominator was eaten`,
    );
  }

  // The failure being prevented, stated explicitly. If delivery events were
  // written into `status` (pre-046 behavior), the two creators who ENGAGED
  // drop out of the denominator and the rate goes impossible.
  const ifWrittenToStatus: AnalyticsOutreachRow[] = [
    { campaign_influencer_id: 'ci-1', direction: 'outbound', status: 'opened' },
    { campaign_influencer_id: 'ci-2', direction: 'outbound', status: 'opened' },
    { campaign_influencer_id: 'ci-3', direction: 'outbound', status: 'sent' },
  ];
  const broken = computeConversion(ifWrittenToStatus, inbound);
  assert(
    broken.creators_sent === 1,
    `delivery-regression: overloading status would shrink the denominator to 1 (got ${broken.creators_sent})`,
  );
  assert(
    (broken.response_conversion_rate ?? 0) > 1,
    'delivery-regression: overloading status would push the rate above 1.0 — the symptom to recognize',
  );

  // And at full delivery coverage it reports "nothing was ever sent" while
  // replies keep arriving — the silent end state.
  const allDelivered: AnalyticsOutreachRow[] = outreach.map((m) => ({ ...m, status: 'delivered' }));
  const erased = computeConversion(allDelivered, inbound);
  assert(
    erased.creators_sent === 0 && erased.response_conversion_rate === null,
    'delivery-regression: full coverage would zero the denominator and null the rate',
  );
}
testDeliveryEventsCannotInflateConversion();

console.log(`analytics test: ${passed} passed, ${failed} failed`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
