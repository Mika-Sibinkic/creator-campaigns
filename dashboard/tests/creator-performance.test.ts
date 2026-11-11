// tests/creator-performance.test.ts
//
// Unit tests for src/lib/creator-performance.ts. Pure + hermetic: no env,
// no DB, no network, no clock — fixtures only (the deal-economics.test.ts
// harness style). The route is a thin fetch-and-hand-in wrapper; everything
// that decides a number lives in the lib and is exercised here.
//
// Run: npx tsx tests/creator-performance.test.ts

import {
  computeCreatorPerformance,
  computePriceTrend,
  replyLatencyByCi,
  promisedLineCount,
  median,
  PERF_MIN_SAMPLE,
  type CreatorPerformanceInput,
  type PerfOfferRow,
} from '../src/lib/creator-performance';

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

const EPS = 1e-9;
const close = (a: number | null | undefined, b: number, eps = EPS): boolean =>
  a != null && Math.abs(a - b) < eps;

// ── Fixture factories ────────────────────────────────────────────────────────

function offer(o: Partial<PerfOfferRow> & { id: string }): PerfOfferRow {
  return {
    campaign_id: 'camp-1',
    campaign_influencer_id: `ci-${o.id}`,
    status: 'agreed',
    initial_offer_usd: null,
    agreed_amount_usd: null,
    ceiling_usd: 200,
    opening_pct: null,
    rounds: null,
    perceived_generosity: null,
    price_give_pct: null,
    agreed_deliverables: null,
    created_at: '2026-01-01T00:00:00Z',
    ...o,
  };
}

function baseInput(over: Partial<CreatorPerformanceInput>): CreatorPerformanceInput {
  return {
    influencer_id: 'inf-1',
    campaigns: [{ id: 'camp-1', artist_name: 'Artist One', synthetic: false }],
    cis: [],
    offers: [],
    outreach: [],
    inbound: [],
    deliveries: [],
    snapshots: [],
    outcomes: [],
    ...over,
  };
}

// ── 1. median ────────────────────────────────────────────────────────────────
{
  assert(median([]) === null, 'median: empty → null');
  assert(close(median([3]), 3), 'median: single value');
  assert(close(median([1, 9, 5]), 5), 'median: odd count → middle');
  assert(close(median([1, 3, 5, 7]), 4), 'median: even count → mean of middle two');
}

// ── 2. promisedLineCount ─────────────────────────────────────────────────────
{
  assert(promisedLineCount(null) === null, 'promised: null jsonb → null');
  assert(promisedLineCount({ a: 1 }) === null, 'promised: non-array jsonb → null');
  assert(promisedLineCount([]) === 0, 'promised: empty array → 0');
  assert(promisedLineCount([{ promo_type: 'post' }, { promo_type: 'story' }]) === 2, 'promised: 2 lines → 2');
}

// ── 3. reply latency: first sent outbound → first inbound after it ───────────
{
  const lat = replyLatencyByCi(
    [
      // draft never counts
      { campaign_influencer_id: 'ci-a', direction: 'outbound', status: 'draft', sent_at: '2026-01-01T00:00:00Z' },
      // the real first send
      { campaign_influencer_id: 'ci-a', direction: 'outbound', status: 'sent', sent_at: '2026-01-02T00:00:00Z' },
      // later send must not shift the origin
      { campaign_influencer_id: 'ci-a', direction: 'outbound', status: 'sent', sent_at: '2026-01-05T00:00:00Z' },
      // inbound rows in outreach_messages are ignored by latency
      { campaign_influencer_id: 'ci-a', direction: 'inbound', status: null, sent_at: '2026-01-02T01:00:00Z' },
    ],
    [
      // reply BEFORE the first send — imported history, ignored
      { campaign_influencer_id: 'ci-a', received_at: '2026-01-01T12:00:00Z' },
      // first genuine reply: 36h after the first send
      { campaign_influencer_id: 'ci-a', received_at: '2026-01-03T12:00:00Z' },
      // later reply must not win
      { campaign_influencer_id: 'ci-a', received_at: '2026-01-04T00:00:00Z' },
    ],
  );
  assert(close(lat.get('ci-a') ?? null, 36 * 3600 * 1000), `latency: 36h (got ${lat.get('ci-a')})`);

  const none = replyLatencyByCi(
    [{ campaign_influencer_id: 'ci-b', direction: 'outbound', status: 'sent', sent_at: '2026-01-02T00:00:00Z' }],
    [],
  );
  assert(!none.has('ci-b'), 'latency: no reply → absent (null downstream)');

  const noSend = replyLatencyByCi(
    [],
    [{ campaign_influencer_id: 'ci-c', received_at: '2026-01-03T00:00:00Z' }],
  );
  assert(!noSend.has('ci-c'), 'latency: reply with no send → absent');
}

// ── 4. price trend gating + direction ────────────────────────────────────────
{
  const few = computePriceTrend([100, 120, 140, 160]);
  assert(few.status === 'insufficient_data' && few.n === 4 && few.needed === PERF_MIN_SAMPLE,
    'trend: n=4 → insufficient_data');

  const rising = computePriceTrend([100, 120, 140, 160, 180]);
  assert(rising.status === 'ok' && rising.direction === 'rising',
    `trend: monotone up n=5 → rising (got ${JSON.stringify(rising)})`);

  const falling = computePriceTrend([180, 160, 140, 120, 100]);
  assert(falling.status === 'ok' && falling.direction === 'falling',
    'trend: monotone down n=5 → falling');

  const flat = computePriceTrend([100, 100, 100, 100, 100]);
  assert(flat.status === 'ok' && flat.direction === 'flat' && flat.spearman_rho === null,
    'trend: constant prices → flat with null rho');

  // Weak signal must not clear the t ≥ 2.0 gate.
  const noisy = computePriceTrend([100, 140, 90, 150, 110]);
  assert(noisy.status === 'ok' && noisy.direction === 'flat',
    `trend: noisy n=5 stays flat (got ${JSON.stringify(noisy)})`);
}

// ── 5. per-deal record: verified metrics, cpv, streams gating ────────────────
{
  const input = baseInput({
    cis: [{ id: 'ci-1', campaign_id: 'camp-1' }, { id: 'ci-2', campaign_id: 'camp-1' }],
    offers: [
      offer({
        id: 'off-1',
        campaign_influencer_id: 'ci-1',
        status: 'measured',
        agreed_amount_usd: 100,
        rounds: 3,
        agreed_deliverables: [{ promo_type: 'post' }, { promo_type: 'story' }],
      }),
      offer({
        id: 'off-2',
        campaign_influencer_id: 'ci-2',
        status: 'offered',
        created_at: '2026-01-02T00:00:00Z',
      }),
    ],
    outreach: [
      { campaign_influencer_id: 'ci-1', direction: 'outbound', status: 'sent', sent_at: '2026-01-01T00:00:00Z' },
      { campaign_influencer_id: 'ci-2', direction: 'outbound', status: 'sent', sent_at: '2026-01-01T00:00:00Z' },
    ],
    inbound: [{ campaign_influencer_id: 'ci-1', received_at: '2026-01-01T06:00:00Z' }],
    deliveries: [
      { id: 'del-1', creator_offer_id: 'off-1', status: 'verified', spec_check: 'pass' },
      { id: 'del-2', creator_offer_id: 'off-1', status: 'pending', spec_check: null },
    ],
    snapshots: [
      // stale snapshot must lose to the newer one
      { deal_delivery_id: 'del-1', captured_at: '2026-01-10T00:00:00Z', views: 1000, likes: 50, comments: 5, shares: 1 },
      { deal_delivery_id: 'del-1', captured_at: '2026-02-10T00:00:00Z', views: 5000, likes: 200, comments: 20, shares: 4 },
      // snapshot on a PENDING delivery must not count as verified reach
      { deal_delivery_id: 'del-2', captured_at: '2026-02-10T00:00:00Z', views: 999999, likes: 1, comments: 1, shares: 1 },
    ],
    outcomes: [
      {
        creator_offer_id: 'off-1',
        streams_attributed: 4000,
        streams_attribution_method: 'manual',
        payment_usd_amount: 80,
        measured_at: '2026-02-15T00:00:00Z',
      },
    ],
  });
  const perf = computeCreatorPerformance(input);
  assert(perf.deals.length === 2, `deals: 2 records (got ${perf.deals.length})`);

  // Newest first → off-2 (2026-01-02) before off-1 (2026-01-01).
  assert(perf.deals[0].offer_id === 'off-2' && perf.deals[1].offer_id === 'off-1',
    'deals: sorted newest first');

  const d1 = perf.deals[1];
  assert(d1.campaign_name === 'Artist One', 'deal: campaign name joined');
  assert(close(d1.agreed_amount_usd, 100), 'deal: agreed price carried');
  assert(d1.rounds === 3, 'deal: rounds carried');
  assert(close(d1.reply_latency_ms, 6 * 3600 * 1000), 'deal: 6h reply latency');
  assert(d1.delivery.promised === 2 && d1.delivery.deliveries_total === 2, 'deal: promised 2, observed 2');
  assert(d1.delivery.verified === 1 && d1.delivery.pending === 1 && d1.delivery.missing === 0,
    'deal: 1 verified / 1 pending');
  assert(d1.delivery.spec.pass === 1 && d1.delivery.spec.unchecked === 1, 'deal: spec pass counted');
  assert(close(d1.verified.views, 5000), `deal: latest snapshot wins, pending excluded (got ${d1.verified.views})`);
  assert(close(d1.verified.likes, 200), 'deal: verified likes from latest snapshot');
  // spend = payment_usd_amount (80) beats agreed (100); cpv = 80/5000
  assert(close(d1.spend_usd, 80), 'deal: outcome payment snapshot beats agreed');
  assert(close(d1.cost_per_verified_view_usd, 80 / 5000), `deal: cpv 0.016 (got ${d1.cost_per_verified_view_usd})`);
  assert(d1.streams != null && close(d1.streams.streams_attributed, 4000), 'deal: streams present with outcome row');
  assert(d1.streams?.attribution_method === 'manual', 'deal: attribution method labeled');
  assert(close(d1.streams?.streams_per_dollar ?? null, 4000 / 80), 'deal: streams/$ = 50');

  const d2 = perf.deals[0];
  assert(d2.reply_latency_ms === null, 'deal: no reply → null latency');
  assert(d2.verified.views === null, 'deal: no verified delivery → null views (never 0)');
  assert(d2.cost_per_verified_view_usd === null, 'deal: no verified views → null cpv');
  assert(d2.streams === null, 'deal: no outcome row → streams block null');
  assert(d2.delivery.promised === null, 'deal: no frozen package → promised null');
}

// ── 6. never fabricate: views without spend, spend without views ─────────────
{
  const input = baseInput({
    cis: [{ id: 'ci-1', campaign_id: 'camp-1' }],
    offers: [offer({ id: 'off-1', campaign_influencer_id: 'ci-1', status: 'posted', agreed_amount_usd: null })],
    deliveries: [{ id: 'del-1', creator_offer_id: 'off-1', status: 'verified', spec_check: null }],
    snapshots: [{ deal_delivery_id: 'del-1', captured_at: '2026-02-01T00:00:00Z', views: 1200, likes: null, comments: null, shares: null }],
  });
  const d = computeCreatorPerformance(input).deals[0];
  assert(close(d.verified.views, 1200), 'honest: views present');
  assert(d.verified.likes === null, 'honest: unmeasured likes stay null');
  assert(d.spend_usd === null && d.cost_per_verified_view_usd === null,
    'honest: views with no spend figure → cpv null, not 0');
}

// ── 7. synthetic campaigns are excluded ──────────────────────────────────────
{
  const input = baseInput({
    campaigns: [
      { id: 'camp-1', artist_name: 'Artist One', synthetic: false },
      { id: 'camp-syn', artist_name: '[SAMPLE] Fake Artist', synthetic: true },
    ],
    cis: [
      { id: 'ci-1', campaign_id: 'camp-1' },
      { id: 'ci-syn', campaign_id: 'camp-syn' },
    ],
    offers: [
      offer({ id: 'off-1', campaign_influencer_id: 'ci-1', status: 'agreed', agreed_amount_usd: 100 }),
      offer({ id: 'off-syn', campaign_id: 'camp-syn', campaign_influencer_id: 'ci-syn', status: 'measured', agreed_amount_usd: 999 }),
    ],
    outreach: [
      { campaign_influencer_id: 'ci-1', direction: 'outbound', status: 'sent', sent_at: '2026-01-01T00:00:00Z' },
      { campaign_influencer_id: 'ci-syn', direction: 'outbound', status: 'sent', sent_at: '2026-01-01T00:00:00Z' },
    ],
  });
  const perf = computeCreatorPerformance(input);
  assert(perf.deals.length === 1 && perf.deals[0].offer_id === 'off-1',
    'synthetic: sample campaign deal excluded');
  assert(perf.rollup.contacted === 1, 'synthetic: sample CI not counted as contacted');
  assert(perf.rollup.campaigns_count === 1, 'synthetic: campaigns_count excludes sample');
}

// ── 8. rollup: close rate, delivery reliability, gated medians ───────────────
{
  // 6 CIs contacted, 6 offers: 3 closed (agreed+), 3 open. Each closed deal
  // has 1 promised line and a verified delivery on two of them.
  const cis = Array.from({ length: 6 }, (_, i) => ({ id: `ci-${i}`, campaign_id: 'camp-1' }));
  const statuses = ['agreed', 'paid', 'measured', 'offered', 'queued', 'rejected'];
  const offers = statuses.map((status, i) =>
    offer({
      id: `off-${i}`,
      campaign_influencer_id: `ci-${i}`,
      status,
      agreed_amount_usd: status === 'offered' || status === 'queued' || status === 'rejected' ? null : 100 + i,
      agreed_deliverables: i < 3 ? [{ promo_type: 'post' }] : null,
      created_at: `2026-01-0${i + 1}T00:00:00Z`,
    }),
  );
  const input = baseInput({
    cis,
    offers,
    outreach: cis.map((c) => ({
      campaign_influencer_id: c.id,
      direction: 'outbound',
      status: 'sent',
      sent_at: '2026-01-01T00:00:00Z',
    })),
    inbound: [
      { campaign_influencer_id: 'ci-0', received_at: '2026-01-01T02:00:00Z' },
      { campaign_influencer_id: 'ci-1', received_at: '2026-01-01T04:00:00Z' },
      { campaign_influencer_id: 'ci-2', received_at: '2026-01-01T06:00:00Z' },
    ],
    deliveries: [
      { id: 'del-0', creator_offer_id: 'off-0', status: 'verified', spec_check: 'pass' },
      { id: 'del-1', creator_offer_id: 'off-1', status: 'verified', spec_check: 'partial' },
      { id: 'del-2', creator_offer_id: 'off-2', status: 'missing', spec_check: null },
    ],
  });
  const { rollup } = computeCreatorPerformance(input);

  assert(rollup.deals_count === 6, 'rollup: 6 deals');
  assert(rollup.contacted === 6, 'rollup: 6 contacted');
  assert(rollup.closed === 3, `rollup: 3 closed (got ${rollup.closed})`);
  assert(rollup.closed_cis === 3, `rollup: 3 unique closed CIs (got ${rollup.closed_cis})`);
  assert(rollup.close_rate.status === 'ok' && rollup.close_rate.n === 6 &&
    close(rollup.close_rate.value, 0.5),
    `rollup: close rate 3 closed CIs / 6 engaged CIs (got ${JSON.stringify(rollup.close_rate)})`);
  assert(rollup.delivery.expected === 3 && rollup.delivery.verified === 2,
    `rollup: delivery 2/3 (got ${rollup.delivery.verified}/${rollup.delivery.expected})`);
  // 3 promised lines is below the gate: the counts are facts, the rate is not.
  assert(rollup.delivery.reliability.status === 'insufficient_data' &&
    rollup.delivery.reliability.n === 3,
    `rollup: 3 promised lines -> reliability gated, not 0.667 (got ${JSON.stringify(rollup.delivery.reliability)})`);

  // Only 3 latencies → gated.
  assert(rollup.median_reply_latency_ms.status === 'insufficient_data' && rollup.median_reply_latency_ms.n === 3,
    'rollup: 3 latencies → insufficient_data, not a number');
  // No cpv at all → gated at n=0.
  assert(rollup.median_cost_per_verified_view_usd.status === 'insufficient_data',
    'rollup: no cpv → insufficient_data');
  // Only 3 closed prices → trend refused.
  assert(rollup.price_trend.status === 'insufficient_data', 'rollup: 3 closed prices → trend refused');
  assert(rollup.confidence.tier === 'low' && rollup.confidence.n === 6,
    `rollup: confidence tier low at n=6 (got ${rollup.confidence.tier})`);
}

// ── 8b. close rate counts unique CIs, never offers (bounded at 1) ────────────
{
  // 5 CIs contacted, every one closed, and ci-0 was re-negotiated into a
  // SECOND closed offer. creator_offers.campaign_influencer_id has no unique
  // constraint, so counting offers over CIs would read 6/5 = "120%".
  const cis = Array.from({ length: 5 }, (_, i) => ({ id: `ci-${i}`, campaign_id: 'camp-1' }));
  const offers = [
    ...cis.map((c, i) =>
      offer({ id: `off-${i}`, campaign_influencer_id: c.id, status: 'agreed', agreed_amount_usd: 100 + i }),
    ),
    offer({ id: 'off-0b', campaign_influencer_id: 'ci-0', status: 'paid', agreed_amount_usd: 150 }),
  ];
  const { rollup } = computeCreatorPerformance(
    baseInput({
      cis,
      offers,
      outreach: cis.map((c) => ({
        campaign_influencer_id: c.id,
        direction: 'outbound',
        status: 'sent',
        sent_at: '2026-01-01T00:00:00Z',
      })),
    }),
  );

  assert(rollup.closed === 6, `re-negotiated: 6 closed offers is still a fact (got ${rollup.closed})`);
  assert(rollup.closed_cis === 5, `re-negotiated: 5 unique closed CIs (got ${rollup.closed_cis})`);
  assert(rollup.close_rate.status === 'ok' && close(rollup.close_rate.value, 1),
    `re-negotiated: close rate is exactly 1, never 1.2 (got ${JSON.stringify(rollup.close_rate)})`);
  assert(rollup.close_rate.status === 'ok' && rollup.close_rate.value <= 1,
    're-negotiated: close rate bounded at 1');
}

// ── 8c. a closed offer on a never-contacted CI joins the denominator ─────────
{
  // ci-4 was never sent an outbound (manual quick-offer path) but closed.
  // Counting it in the numerator only would inflate the rate to 2/4.
  const cis = Array.from({ length: 5 }, (_, i) => ({ id: `ci-${i}`, campaign_id: 'camp-1' }));
  const { rollup } = computeCreatorPerformance(
    baseInput({
      cis,
      offers: [
        offer({ id: 'off-0', campaign_influencer_id: 'ci-0', status: 'agreed', agreed_amount_usd: 100 }),
        offer({ id: 'off-4', campaign_influencer_id: 'ci-4', status: 'paid', agreed_amount_usd: 120 }),
        offer({ id: 'off-1', campaign_influencer_id: 'ci-1', status: 'offered' }),
      ],
      outreach: cis.slice(0, 4).map((c) => ({
        campaign_influencer_id: c.id,
        direction: 'outbound',
        status: 'sent',
        sent_at: '2026-01-01T00:00:00Z',
      })),
    }),
  );

  assert(rollup.contacted === 4, `quick-offer: 4 contacted (got ${rollup.contacted})`);
  assert(rollup.closed_cis === 2, `quick-offer: 2 closed CIs (got ${rollup.closed_cis})`);
  assert(rollup.close_rate.status === 'ok' && rollup.close_rate.n === 5,
    `quick-offer: never-contacted closer joins the denominator, n=5 (got ${JSON.stringify(rollup.close_rate)})`);
  assert(rollup.close_rate.status === 'ok' && close(rollup.close_rate.value, 0.4),
    `quick-offer: close rate 2/5, not 2/4 (got ${JSON.stringify(rollup.close_rate)})`);
}

// ── 8d. rates refuse to speak at n = 1 (the "200%" case) ───────────────────
{
  // One CI contacted, two closed offers on it, one promised line delivered.
  // Ungated this rendered "200%" close rate and "100%" delivery off n=1.
  const { rollup } = computeCreatorPerformance(
    baseInput({
      cis: [{ id: 'ci-0', campaign_id: 'camp-1' }],
      offers: [
        offer({
          id: 'off-a',
          campaign_influencer_id: 'ci-0',
          status: 'agreed',
          agreed_amount_usd: 100,
          agreed_deliverables: [{ promo_type: 'post' }],
        }),
        offer({ id: 'off-b', campaign_influencer_id: 'ci-0', status: 'paid', agreed_amount_usd: 140 }),
      ],
      outreach: [
        {
          campaign_influencer_id: 'ci-0',
          direction: 'outbound',
          status: 'sent',
          sent_at: '2026-01-01T00:00:00Z',
        },
      ],
      deliveries: [
        { id: 'del-a', creator_offer_id: 'off-a', status: 'verified', spec_check: 'pass' },
      ],
    }),
  );

  assert(rollup.closed === 2 && rollup.closed_cis === 1 && rollup.contacted === 1,
    `n=1: raw counts survive (got closed=${rollup.closed}, cis=${rollup.closed_cis})`);
  assert(rollup.close_rate.status === 'insufficient_data' && rollup.close_rate.n === 1 &&
    rollup.close_rate.needed === PERF_MIN_SAMPLE,
    `n=1: close rate refused, never 200% (got ${JSON.stringify(rollup.close_rate)})`);
  assert(rollup.delivery.expected === 1 && rollup.delivery.verified === 1,
    `n=1: delivery counts are facts (got ${rollup.delivery.verified}/${rollup.delivery.expected})`);
  assert(rollup.delivery.reliability.status === 'insufficient_data' &&
    rollup.delivery.reliability.needed === PERF_MIN_SAMPLE,
    `n=1: delivery reliability refused, never 100% (got ${JSON.stringify(rollup.delivery.reliability)})`);
}

// ── 9. rollup medians compute at n ≥ 5 ───────────────────────────────────────
{
  const n = 5;
  const cis = Array.from({ length: n }, (_, i) => ({ id: `ci-${i}`, campaign_id: 'camp-1' }));
  const offers = Array.from({ length: n }, (_, i) =>
    offer({
      id: `off-${i}`,
      campaign_influencer_id: `ci-${i}`,
      status: 'measured',
      agreed_amount_usd: 100 + i * 10, // 100..140 rising
      created_at: `2026-01-0${i + 1}T00:00:00Z`,
    }),
  );
  const input = baseInput({
    cis,
    offers,
    outreach: cis.map((c) => ({
      campaign_influencer_id: c.id,
      direction: 'outbound',
      status: 'sent',
      sent_at: '2026-01-01T00:00:00Z',
    })),
    // latencies 1h, 2h, 3h, 4h, 5h → median 3h
    inbound: cis.map((c, i) => ({
      campaign_influencer_id: c.id,
      received_at: `2026-01-01T0${i + 1}:00:00Z`,
    })),
    deliveries: offers.map((o, i) => ({
      id: `del-${i}`,
      creator_offer_id: o.id,
      status: 'verified',
      spec_check: 'pass',
    })),
    // views 1000 each → cpv = price/1000: 0.10, 0.11, ..., 0.14 → median 0.12
    snapshots: offers.map((o, i) => ({
      deal_delivery_id: `del-${i}`,
      captured_at: '2026-02-01T00:00:00Z',
      views: 1000,
      likes: null,
      comments: null,
      shares: null,
    })),
  });
  const { rollup } = computeCreatorPerformance(input);

  assert(rollup.median_reply_latency_ms.status === 'ok' &&
    close(rollup.median_reply_latency_ms.value, 3 * 3600 * 1000),
    `rollup: median latency 3h (got ${JSON.stringify(rollup.median_reply_latency_ms)})`);
  assert(rollup.median_cost_per_verified_view_usd.status === 'ok' &&
    close(rollup.median_cost_per_verified_view_usd.value, 0.12),
    `rollup: median cpv 0.12 (got ${JSON.stringify(rollup.median_cost_per_verified_view_usd)})`);
  assert(rollup.price_trend.status === 'ok' && rollup.price_trend.direction === 'rising',
    `rollup: rising price trend (got ${JSON.stringify(rollup.price_trend)})`);
}

// ── 10. empty input degrades cleanly ─────────────────────────────────────────
{
  const perf = computeCreatorPerformance(baseInput({ campaigns: [] }));
  assert(perf.deals.length === 0, 'empty: no deals');
  assert(perf.rollup.close_rate.status === 'insufficient_data' && perf.rollup.close_rate.n === 0,
    'empty: close rate gated at n=0, not NaN');
  assert(perf.rollup.delivery.reliability.status === 'insufficient_data' &&
    perf.rollup.delivery.reliability.n === 0, 'empty: reliability gated at n=0');
  assert(perf.rollup.median_reply_latency_ms.status === 'insufficient_data', 'empty: latency gated');
  assert(perf.rollup.confidence.tier === 'insufficient', 'empty: confidence insufficient');
}

// ── Result ───────────────────────────────────────────────────────────────────

console.log(`\ncreator-performance: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
