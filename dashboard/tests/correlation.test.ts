// tests/correlation.test.ts
//
// Unit tests for src/lib/correlation.ts — the correlation + confidence
// engine. Pure + hermetic: no env, no DB, no network. Covers:
// spearman (hand-computed, ties, degenerate n), confidenceForN tiers/score,
// numeric factor end-to-end (known monotone fixture → known direction +
// tier; truncation → insufficient, no invented trend), sweet-spot hump,
// constant factor / constant outcomes, categorical leader rule (§5.3),
// quantile bucketing with heavy ties, the mixed real/synthetic throw, and
// buildDealFactorRows join/fallback/bucketing behavior.
//
// Run: npx tsx tests/correlation.test.ts

import {
  spearman,
  confidenceForN,
  computeCorrelationReport,
  buildDealFactorRows,
  FACTORS,
  type DealFactorRow,
  type CorrelationScope,
  type NumericFactorResult,
  type CategoricalFactorResult,
} from '../src/lib/correlation';

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

// Row factory: a measured deal with every factor null unless overridden.
function row(over: Partial<DealFactorRow> & { offer_id: string }): DealFactorRow {
  return {
    campaign_id: 'c1',
    synthetic: false,
    streams_attributed: null,
    payment_usd: null,
    follower_count: null,
    engagement_rate: null,
    price_usd: null,
    perceived_generosity: null,
    price_give_pct: null,
    genre: null,
    channel: null,
    send_window: null,
    promo_activity: null,
    ...over,
  };
}

const SCOPE: CorrelationScope = { kind: 'pool', campaign_ids: ['c1'], synthetic: false };

function numericFactor(rows: DealFactorRow[], id: string): NumericFactorResult {
  const f = computeCorrelationReport(rows, SCOPE).factors.find((x) => x.factor === id);
  if (!f || f.kind !== 'numeric') throw new Error(`expected numeric factor ${id}`);
  return f;
}
function categoricalFactor(rows: DealFactorRow[], id: string): CategoricalFactorResult {
  const f = computeCorrelationReport(rows, SCOPE).factors.find((x) => x.factor === id);
  if (!f || f.kind !== 'categorical') throw new Error(`expected categorical factor ${id}`);
  return f;
}

// ── 1. spearman — hand-computed vectors ──────────────────────────────────────
{
  // Hand-worked 5-pair vector: ranks x = 1..5, ranks y = [2,1,4,3,5],
  // Σd² = 4 → ρ = 1 − 6·4/(5·24) = 0.8.
  const rho = spearman([1, 2, 3, 4, 5], [2, 1, 4, 3, 5]);
  assert(close(rho, 0.8), `spearman hand-computed 5-pair = 0.8 (got ${rho})`);

  // Perfect monotone (nonlinear) → 1; inverse → −1.
  assert(close(spearman([1, 2, 3, 4, 5], [1, 4, 9, 16, 25]), 1), 'spearman perfect monotone → 1');
  assert(close(spearman([1, 2, 3, 4, 5], [25, 16, 9, 4, 1]), -1), 'spearman inverse monotone → −1');

  // Ties averaged — hand-worked: xs [1,2,2,3] → ranks [1, 2.5, 2.5, 4];
  // ys [1,2,3,4] → ranks 1..4. Pearson on ranks = 4.5/√(4.5·5) = √0.9.
  const tied = spearman([1, 2, 2, 3], [1, 2, 3, 4]);
  assert(close(tied, Math.sqrt(0.9)), `spearman ties averaged → √0.9 ≈ 0.948683 (got ${tied})`);

  // Degenerate inputs.
  assert(spearman([1, 2], [3, 4]) === null, 'spearman n=2 → null');
  assert(spearman([5, 5, 5, 5], [1, 2, 3, 4]) === null, 'spearman constant xs → null');
  assert(spearman([1, 2, 3, 4], [7, 7, 7, 7]) === null, 'spearman constant ys → null');
}

// ── 2. confidenceForN — tier boundaries + score ramp ─────────────────────────
{
  assert(confidenceForN(0).tier === 'insufficient', 'confidence n=0 → insufficient');
  assert(confidenceForN(4).tier === 'insufficient', 'confidence n=4 → insufficient');
  assert(confidenceForN(5).tier === 'low', 'confidence n=5 → low');
  assert(confidenceForN(14).tier === 'low', 'confidence n=14 → low');
  assert(confidenceForN(15).tier === 'medium', 'confidence n=15 → medium');
  assert(confidenceForN(39).tier === 'medium', 'confidence n=39 → medium');
  assert(confidenceForN(40).tier === 'high', 'confidence n=40 → high');
  assert(close(confidenceForN(15).score, 0.5), 'confidence score n=15 → 0.5');
  assert(close(confidenceForN(30).score, 1), 'confidence score n=30 → 1');
  assert(close(confidenceForN(45).score, 1), 'confidence score n=45 → capped at 1');
  assert(confidenceForN(8).reason.includes('8 measured deals'), 'confidence reason carries n');
  assert(confidenceForN(8).reason.startsWith('low:'), 'confidence reason carries tier');
}

// ── 3. Report shape — all 9 factors, in registry order, + totals ─────────────
{
  const rows = [
    row({ offer_id: 'o1', streams_attributed: 100, payment_usd: 10, price_usd: 10 }),
    row({ offer_id: 'o2', streams_attributed: 200, payment_usd: 20, price_usd: 20 }),
    row({ offer_id: 'o3' }), // unmeasured — excluded from analysis
  ];
  const report = computeCorrelationReport(rows, SCOPE);
  assert(report.factors.length === 9, `report always carries all 9 factors (got ${report.factors.length})`);
  assert(
    report.factors.every((f, i) => f.factor === FACTORS[i].id && f.kind === FACTORS[i].kind),
    'factors follow FACTORS registry order and kind',
  );
  assert(report.deals_measured === 2, `deals_measured counts measured rows only (got ${report.deals_measured})`);
  assert(report.totals.streams === 300, `totals.streams = 300 (got ${report.totals.streams})`);
  assert(report.totals.spend_usd === 30, `totals.spend_usd = 30 (got ${report.totals.spend_usd})`);
  assert(close(report.totals.streams_per_dollar, 10), 'totals.streams_per_dollar = 10');
  assert(report.scope === SCOPE, 'report echoes the scope it was computed for');
}

// ── 4. n=0 and n=1 — insufficient, refuses to state anything ─────────────────
{
  const empty = computeCorrelationReport([], SCOPE);
  assert(empty.deals_measured === 0, 'empty input → 0 measured deals');
  assert(empty.totals.streams_per_dollar === null, 'empty input → null streams/$');
  assert(
    empty.factors.every((f) => f.confidence.tier === 'insufficient' && f.notes.includes('no measured deals')),
    "n=0 → every factor insufficient with note 'no measured deals'",
  );
  assert(
    empty.factors.every((f) =>
      f.kind === 'numeric' ? f.buckets.length === 0 && f.direction === 'none' : f.groups.length === 0 && f.leader === null,
    ),
    'n=0 → empty buckets/groups, no direction, no leader',
  );

  const one = [row({ offer_id: 'o1', streams_attributed: 100, payment_usd: 10, follower_count: 5000 })];
  const f = numericFactor(one, 'follower_count');
  assert(f.n === 1 && f.confidence.tier === 'insufficient', 'n=1 → insufficient');
  assert(f.notes.includes('fewer than 3 measured deals'), "n=1 → note 'fewer than 3 measured deals'");
  assert(f.direction === 'none' && f.spearman_rho === null && f.buckets.length === 0, 'n=1 → no trend, no buckets');
  // The same rows have NO genre → genre factor n=0 even though a deal is measured.
  const g = categoricalFactor(one, 'genre');
  assert(g.n === 0 && g.notes.includes('no measured deals'), 'per-factor n: factor-null rows do not count');
}

// ── 5. Numeric end-to-end — known monotone fixture → known correlation+tier ──
{
  // 20 rows: follower i·1000, payment 100, streams i·1000 → streams/$ = 10·i.
  // Perfectly monotone: ρ = 1, t = ∞, tier medium (n=20), direction positive.
  const rows = Array.from({ length: 20 }, (_, i) =>
    row({
      offer_id: `o${i + 1}`,
      streams_attributed: (i + 1) * 1000,
      payment_usd: 100,
      follower_count: (i + 1) * 1000,
    }),
  );
  const f = numericFactor(rows, 'follower_count');
  assert(f.n === 20, `monotone fixture n=20 (got ${f.n})`);
  assert(close(f.spearman_rho, 1), `monotone fixture ρ=1 (got ${f.spearman_rho})`);
  assert((f.t_stat ?? 0) >= 2, `monotone fixture t ≥ 2 (got ${f.t_stat})`);
  assert(f.direction === 'positive', `monotone fixture direction positive (got ${f.direction})`);
  assert(f.confidence.tier === 'medium', `n=20 → medium tier (got ${f.confidence.tier})`);
  assert(f.buckets.length === 4, `n=20 → k=4 buckets (got ${f.buckets.length})`);
  assert(
    f.buckets.every((b, i) => i === 0 || b.mean_outcome > f.buckets[i - 1].mean_outcome),
    'monotone fixture → bucket means strictly ascending',
  );
  assert(f.buckets.reduce((s, b) => s + b.n, 0) === 20, 'buckets partition all 20 rows');

  // Same data truncated to n=4 → insufficient; the engine refuses the trend.
  const t = numericFactor(rows.slice(0, 4), 'follower_count');
  assert(t.confidence.tier === 'insufficient', 'n=4 → insufficient tier');
  assert(t.direction === 'none', 'n=4 → direction none even though data is perfectly monotone');
}

// ── 6. Sweet-spot hump — buckets carry what ρ cannot ─────────────────────────
{
  // Symmetric hump: ρ = 0 (no monotone trend) but the middle bucket mean is
  // strictly greatest — the chart shows the sweet spot.
  const ys = [1, 2, 3, 9, 10, 9, 3, 2, 1];
  const rows = ys.map((y, i) =>
    row({
      offer_id: `o${i + 1}`,
      streams_attributed: y,
      payment_usd: 1,
      follower_count: (i + 1) * 1000,
    }),
  );
  const f = numericFactor(rows, 'follower_count');
  assert(f.spearman_rho != null && Math.abs(f.spearman_rho) < 0.2, `hump → ρ ≈ 0 (got ${f.spearman_rho})`);
  assert(f.direction === 'none', 'hump → direction none');
  assert(f.buckets.length === 3, `n=9 → k=3 buckets (got ${f.buckets.length})`);
  assert(
    f.buckets[1].mean_outcome > f.buckets[0].mean_outcome &&
      f.buckets[1].mean_outcome > f.buckets[2].mean_outcome,
    'hump → middle bucket mean strictly greatest',
  );
}

// ── 7. Constant factor / constant outcomes — notes, no NaN ───────────────────
{
  const constFactor = Array.from({ length: 5 }, (_, i) =>
    row({
      offer_id: `o${i + 1}`,
      streams_attributed: (i + 1) * 10,
      payment_usd: 1,
      follower_count: 5000, // no variation
    }),
  );
  const f = numericFactor(constFactor, 'follower_count');
  assert(f.spearman_rho === null, 'constant factor → ρ null');
  assert(f.notes.includes('no variation in this factor yet'), "constant factor → note 'no variation in this factor yet'");
  assert(f.direction === 'none', 'constant factor → direction none');
  assert(f.buckets.length === 0, 'constant factor → no buckets (single merged edge)');

  const constOutcome = Array.from({ length: 5 }, (_, i) =>
    row({
      offer_id: `o${i + 1}`,
      streams_attributed: 100, // identical outcomes
      payment_usd: 1,
      follower_count: (i + 1) * 1000,
    }),
  );
  const g = numericFactor(constOutcome, 'follower_count');
  assert(g.spearman_rho === null, 'all-same outcomes → ρ null');
  assert(g.notes.includes('no variation in outcomes yet'), "all-same outcomes → note 'no variation in outcomes yet'");
  assert(g.t_stat === null, 'all-same outcomes → t null');
  assert(
    g.buckets.every((b) => Number.isFinite(b.mean_outcome)),
    'all-same outcomes → bucket means finite, no NaN',
  );
}

// ── 8. Categorical — §5.3 leader rule ────────────────────────────────────────
{
  const mk = (channel: string, count: number, streams: number, offset = 0) =>
    Array.from({ length: count }, (_, i) =>
      row({ offer_id: `${channel}${offset + i}`, streams_attributed: streams, payment_usd: 1, channel }),
    );

  // email n=6 mean 300 vs instagram_dm n=6 mean 100 → 300 ≥ 1.2·100 → leader.
  const clear = categoricalFactor([...mk('email', 6, 300), ...mk('instagram_dm', 6, 100)], 'channel');
  assert(clear.leader === 'email', `clear winner → leader 'email' (got ${clear.leader})`);
  assert(clear.groups[0].value === 'email' && close(clear.groups[0].mean_outcome, 300), 'groups sorted by mean desc');
  assert(clear.groups.every((g) => !g.small_sample), 'n=6 groups not flagged small_sample');

  // 300 vs 260 → below the 1.2× bar → no leader.
  const tight = categoricalFactor([...mk('email', 6, 300), ...mk('instagram_dm', 6, 260)], 'channel');
  assert(tight.leader === null, '300 vs 260 (< 1.2×) → leader null');
  assert(tight.notes.some((n) => n.includes('no group stands out')), 'sub-1.2× gap → explanatory note');

  // Top group n=2 → small-sample gate blocks the leader claim.
  const smallTop = categoricalFactor([...mk('email', 2, 400), ...mk('instagram_dm', 6, 100)], 'channel');
  assert(smallTop.leader === null, 'top group n=2 → leader null');
  assert(smallTop.groups[0].value === 'email' && smallTop.groups[0].small_sample, 'n=2 group flagged small_sample');
  assert(smallTop.notes.some((n) => n.includes('need 3+')), 'small-sample gate → explanatory note');

  // Single group → nothing to compare against.
  const single = categoricalFactor(mk('email', 6, 300), 'channel');
  assert(single.leader === null, 'single group → leader null');
  assert(single.notes.includes('only one group observed'), 'single group → explanatory note');
}

// ── 9. Bucketing — duplicate quantile edges merge; k=3 under n=20 ────────────
{
  // Heavy ties: 15 rows at 1000, 5 at 10000. Quantile edges at 0/.25/.5 all
  // equal 1000 → merged → 2 buckets instead of 4.
  const tied = [
    ...Array.from({ length: 15 }, (_, i) =>
      row({ offer_id: `a${i}`, streams_attributed: i + 1, payment_usd: 1, follower_count: 1000 }),
    ),
    ...Array.from({ length: 5 }, (_, i) =>
      row({ offer_id: `b${i}`, streams_attributed: 100 + i, payment_usd: 1, follower_count: 10000 }),
    ),
  ];
  const f = numericFactor(tied, 'follower_count');
  assert(f.buckets.length === 2, `heavy ties collapse buckets (got ${f.buckets.length})`);
  assert(f.buckets[0].n === 15 && f.buckets[1].n === 5, `collapsed buckets keep counts 15/5 (got ${f.buckets.map((b) => b.n)})`);

  // n=19 (< 20) → k=3.
  const nineteen = Array.from({ length: 19 }, (_, i) =>
    row({ offer_id: `o${i}`, streams_attributed: (i + 1) * 7, payment_usd: 1, follower_count: (i + 1) * 1000 }),
  );
  const g = numericFactor(nineteen, 'follower_count');
  assert(g.buckets.length === 3, `n=19 → k=3 buckets (got ${g.buckets.length})`);
}

// ── 10. Mixing guard — real + synthetic in one report throws ─────────────────
{
  const mixed = [
    row({ offer_id: 'r1', synthetic: false, streams_attributed: 100, payment_usd: 10 }),
    row({ offer_id: 's1', synthetic: true, streams_attributed: 100, payment_usd: 10 }),
  ];
  let threw: string | null = null;
  try {
    computeCorrelationReport(mixed, SCOPE);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assert(threw !== null, 'mixed real+synthetic rows → throws');
  assert((threw ?? '').includes('refusing to mix'), `throw names the refusal (got '${threw}')`);

  // All-synthetic is fine (the sample scope) — no throw.
  const allSynthetic = [
    row({ offer_id: 's1', synthetic: true, streams_attributed: 100, payment_usd: 10 }),
    row({ offer_id: 's2', synthetic: true, streams_attributed: 200, payment_usd: 10 }),
  ];
  const report = computeCorrelationReport(allSynthetic, { kind: 'pool', campaign_ids: ['c1'], synthetic: true });
  assert(report.deals_measured === 2, 'all-synthetic pool computes normally');
}

// ── 11. buildDealFactorRows — joins, snapshot preference, fallback chains ────
{
  const built = buildDealFactorRows({
    campaigns: [{ id: 'c1', synthetic: false }],
    offers: [
      { id: 'o1', campaign_id: 'c1', campaign_influencer_id: 'ci1', agreed_amount_usd: 100, initial_offer_usd: 80, ceiling_usd: 250, perceived_generosity: 1.2, price_give_pct: 0.1, post_url: 'https://www.tiktok.com/@x/video/7123456789' },
      { id: 'o2', campaign_id: 'c1', campaign_influencer_id: 'ci2', agreed_amount_usd: 150, initial_offer_usd: null, ceiling_usd: null, perceived_generosity: null, price_give_pct: null, post_url: 'https://www.instagram.com/p/abc' },
      { id: 'o3', campaign_id: 'c1', campaign_influencer_id: 'ci3', agreed_amount_usd: null, initial_offer_usd: null, ceiling_usd: null, perceived_generosity: null, price_give_pct: null, post_url: 'https://youtube.com/watch?v=1' },
      { id: 'o4', campaign_id: 'c1', campaign_influencer_id: 'ci4', agreed_amount_usd: null, initial_offer_usd: null, ceiling_usd: null, perceived_generosity: null, price_give_pct: null, post_url: 'https://example.com/x' },
      { id: 'o5', campaign_id: 'c1', campaign_influencer_id: 'ci5', agreed_amount_usd: null, initial_offer_usd: null, ceiling_usd: null, perceived_generosity: null, price_give_pct: null, post_url: null },
      { id: 'o6', campaign_id: 'c1', campaign_influencer_id: null, agreed_amount_usd: null, initial_offer_usd: null, ceiling_usd: null, perceived_generosity: null, price_give_pct: null, post_url: null },
      { id: 'o7', campaign_id: 'cX', campaign_influencer_id: null, agreed_amount_usd: null, initial_offer_usd: null, ceiling_usd: null, perceived_generosity: null, price_give_pct: null, post_url: null }, // outside campaign set
    ],
    outcomes: [
      { creator_offer_id: 'o1', streams_attributed: 5000, payment_usd_amount: 120, follower_count_at_post: 50000, engagement_at_post: 0.05 },
      { creator_offer_id: 'o2', streams_attributed: 1000, payment_usd_amount: null, follower_count_at_post: null, engagement_at_post: null },
    ],
    cis: [
      { id: 'ci1', campaign_id: 'c1', influencer_id: 'i1', primary_channel: 'tiktok_dm' },
      { id: 'ci2', campaign_id: 'c1', influencer_id: 'i2', primary_channel: 'instagram_dm' },
      { id: 'ci3', campaign_id: 'c1', influencer_id: 'i3', primary_channel: 'email' },
      { id: 'ci4', campaign_id: 'c1', influencer_id: null, primary_channel: 'email' },
      { id: 'ci5', campaign_id: 'c1', influencer_id: 'i5', primary_channel: null },
    ],
    influencers: [
      { id: 'i1', follower_count: 10000, engagement_rate: 0.02, content_genres: ['Country', 'pop'] },
      { id: 'i2', follower_count: 20000, engagement_rate: 0.03, content_genres: [] },
      { id: 'i3', follower_count: 30000, engagement_rate: 0.04, content_genres: null },
      { id: 'i5', follower_count: null, engagement_rate: null, content_genres: ['  '] },
    ],
    firstSends: [
      { campaign_influencer_id: 'ci1', channel: 'email', sent_at: '2026-07-01T05:59:00Z' },
      { campaign_influencer_id: 'ci3', channel: 'tiktok_dm', sent_at: '2026-07-01T20:00:00Z' }, // later — must lose
      { campaign_influencer_id: 'ci3', channel: 'email', sent_at: '2026-07-01T06:00:00Z' }, // earliest wins
      { campaign_influencer_id: 'ci4', channel: null, sent_at: '2026-07-01T12:00:00Z' },
      { campaign_influencer_id: 'ci5', channel: null, sent_at: '2026-07-01T18:00:00Z' },
    ],
  });

  const by = new Map(built.map((r) => [r.offer_id, r]));
  assert(built.length === 6 && !by.has('o7'), 'offers outside the campaign set are skipped');

  const r1 = by.get('o1')!;
  assert(r1.follower_count === 50000, 'follower_count_at_post beats influencers.follower_count');
  assert(r1.engagement_rate === 0.05, 'engagement_at_post beats influencers.engagement_rate');
  assert(r1.payment_usd === 120 && r1.price_usd === 120, 'payment_usd_amount preferred for payment/price');
  assert(r1.genre === 'country', 'genre = first content_genre, lowercased');
  assert(r1.channel === 'email', 'first-send channel beats primary_channel');
  assert(r1.send_window === 'night 0–5', "05:59 UTC → 'night 0–5'");
  assert(r1.promo_activity === 'tiktok post', 'tiktok URL → tiktok post');
  assert(r1.perceived_generosity === 1.2 && r1.price_give_pct === 0.1, 'persisted economics pass through');
  assert(r1.synthetic === false, 'synthetic flag comes from the campaign');

  const r2 = by.get('o2')!;
  assert(r2.follower_count === 20000, 'no snapshot → falls back to influencers.follower_count');
  assert(r2.engagement_rate === 0.03, 'no snapshot → falls back to influencers.engagement_rate');
  assert(r2.payment_usd === 150, 'payment_usd_amount null → falls back to agreed_amount_usd');
  assert(r2.genre === null, 'empty content_genres → genre null');
  assert(r2.channel === 'instagram_dm', 'no first send → falls back to primary_channel');
  assert(r2.send_window === null, 'no first send → send_window null');
  assert(r2.promo_activity === 'instagram post', 'instagram URL → instagram post');

  const r3 = by.get('o3')!;
  assert(r3.streams_attributed === null, 'no outcome row → unmeasured');
  assert(r3.channel === 'email' && r3.send_window === 'morning 6–11', 'earliest send wins; 06:00 UTC → morning');
  assert(r3.promo_activity === 'youtube post', 'youtube URL → youtube post');

  const r4 = by.get('o4')!;
  assert(r4.channel === 'email', 'null first-send channel → falls back to primary_channel');
  assert(r4.send_window === 'afternoon 12–17', "12:00 UTC → 'afternoon 12–17'");
  assert(r4.promo_activity === 'other post', 'unknown host → other post');
  assert(r4.follower_count === null && r4.genre === null, 'no influencer → null factors');

  const r5 = by.get('o5')!;
  assert(r5.channel === null, 'no send channel + no primary_channel → null');
  assert(r5.send_window === 'evening 18–23', "18:00 UTC → 'evening 18–23'");
  assert(r5.promo_activity === null, 'no post_url → promo_activity null');
  assert(r5.genre === null, 'whitespace-only genre → null');

  const r6 = by.get('o6')!;
  assert(r6.channel === null && r6.send_window === null && r6.follower_count === null, 'offer without CI → null CI-derived factors');
  assert(r6.payment_usd === null, 'no outcome + no agreed amount → payment null');
}

// ── 12. price_usd correlates against RAW streams (not streams/$) ─────────────
{
  // 20 rows where paying more buys proportionally more streams. Against
  // streams/$ this would be flat; against raw streams it is a clean trend.
  const rows = Array.from({ length: 20 }, (_, i) =>
    row({
      offer_id: `o${i + 1}`,
      streams_attributed: (i + 1) * 500,
      payment_usd: (i + 1) * 10,
      price_usd: (i + 1) * 10,
    }),
  );
  const f = numericFactor(rows, 'price_usd');
  assert(f.outcome === 'streams', 'price_usd factor measured against raw streams');
  assert(close(f.spearman_rho, 1) && f.direction === 'positive', 'proportional spend → positive raw-streams trend');
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('');
console.log(`correlation.test.ts: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
