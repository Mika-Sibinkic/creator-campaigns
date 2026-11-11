// tests/stream-lift.test.ts
//
// The campaign lift math. Hermetic: pure functions only, no
// network, no DB, no env. Every expected value below is hand-computed from the
// inputs, not copied back out of the implementation.
//
// The assertions that matter most are the ones about what we REFUSE to claim:
//   - a rise the artist was already trending toward is NOT lift
//   - overlapping deals get `null`, never a proportional share
//   - a thin pre-window downgrades the method instead of guessing a trend
//
// Run: npx tsx tests/stream-lift.test.ts

import {
  computeCampaignLift,
  dealWindows,
  fitTrend,
  normalizeSeries,
  toDay,
  daysBetween,
  MIN_BAND_FRACTION,
  type LiftDealInput,
  type SeriesPoint,
} from '../src/lib/stream-lift';

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
function close(a: number | null | undefined, b: number, tol = 1e-6): boolean {
  return a != null && Math.abs(a - b) <= tol;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Perfect line: +2 listeners/day, day 0 = 100. Residual sigma is exactly 0. */
const PRE_LINEAR: SeriesPoint[] = [
  { date: '2026-06-01', value: 100 },
  { date: '2026-06-03', value: 104 },
  { date: '2026-06-05', value: 108 },
  { date: '2026-06-07', value: 112 },
  { date: '2026-06-09', value: 116 },
  { date: '2026-06-11', value: 120 },
];

/** Same span, with noise. Hand-computed: slope 136/70, intercept 110 - 5*slope. */
const PRE_NOISY: SeriesPoint[] = [
  { date: '2026-06-01', value: 100 },
  { date: '2026-06-03', value: 105 },
  { date: '2026-06-05', value: 107 },
  { date: '2026-06-07', value: 113 },
  { date: '2026-06-09', value: 115 },
  { date: '2026-06-11', value: 120 },
];

const BASE = { value: 120, date: '2026-06-11', captured_at: '2026-06-11T12:00:00.000Z' };

// ── 1. Date + series helpers ────────────────────────────────────────────────

function helpers() {
  assert(toDay('2026-09-14T00:00:00+00:00') === '2026-09-14', 'toDay: ISO offset → day');
  assert(toDay('2026-09-14') === '2026-09-14', 'toDay: bare day passes through');
  assert(toDay(null) === null, 'toDay: null → null');
  assert(toDay('not-a-date') === null, 'toDay: garbage → null');
  // 23:30Z must stay on its own UTC day, not roll into the next one.
  assert(toDay('2026-09-14T23:30:00Z') === '2026-09-14', 'toDay: late UTC stays on the day');

  assert(daysBetween('2026-06-01', '2026-06-11') === 10, 'daysBetween: 10 days');
  assert(daysBetween('2026-06-11', '2026-06-01') === -10, 'daysBetween: signed');
  // Spans a DST boundary in local time; UTC math must not drop or add an hour.
  assert(daysBetween('2026-03-01', '2026-04-01') === 31, 'daysBetween: DST-proof');

  const n = normalizeSeries([
    { date: '2026-06-05T00:00:00+00:00', value: 3 },
    { date: '2026-06-01', value: 1 },
    { date: '2026-06-05', value: 999 }, // duplicate day, first wins
    { date: '2026-06-03', value: 2 },
    { date: 'bad', value: 7 }, // unparseable date
    { date: '2026-06-07' }, // no value
    { value: 4 }, // no date
  ]);
  assert(n.length === 3, `normalizeSeries: drops malformed + dupes (got ${n.length})`);
  assert(n[0].date === '2026-06-01' && n[2].date === '2026-06-05', 'normalizeSeries: ascending');
  assert(n[2].value === 3, 'normalizeSeries: first value wins a duplicate day');
  assert(normalizeSeries(null).length === 0, 'normalizeSeries: null → []');
}

// ── 2. Trend fitting ────────────────────────────────────────────────────────

function trendFit() {
  const f = fitTrend(PRE_LINEAR);
  assert(f !== null, 'fit: linear window fits');
  assert(close(f?.slopePerDay, 2), `fit: slope 2/day (got ${f?.slopePerDay})`);
  assert(close(f?.intercept, 100), `fit: intercept 100 (got ${f?.intercept})`);
  assert(close(f?.sigma, 0), `fit: zero residual on a perfect line (got ${f?.sigma})`);
  assert(f?.n === 6 && f?.spanDays === 10, 'fit: n and span reported');
  assert(f?.originDay === '2026-06-01', 'fit: origin is the first pre point');

  const g = fitTrend(PRE_NOISY);
  // slope = Sxy/Sxx = 136/70; intercept = 110 - slope*5; sigma = sqrt(SSE/(n-2))
  assert(close(g?.slopePerDay, 136 / 70, 1e-9), `fit: noisy slope 136/70 (got ${g?.slopePerDay})`);
  assert(close(g?.intercept, 110 - (136 / 70) * 5, 1e-9), 'fit: noisy intercept');
  assert(close(g?.sigma, Math.sqrt(3.7714285714285714 / 4), 1e-6), `fit: sigma (got ${g?.sigma})`);

  // Refusals — a line you can't check is a line you don't draw.
  assert(fitTrend(PRE_LINEAR.slice(0, 3)) === null, 'fit: 3 points refused');
  assert(fitTrend([]) === null, 'fit: empty refused');
  assert(
    fitTrend([
      { date: '2026-06-01', value: 1 },
      { date: '2026-06-02', value: 2 },
      { date: '2026-06-03', value: 3 },
      { date: '2026-06-04', value: 4 },
    ]) === null,
    'fit: 4 points over 3 days refused (span floor)',
  );
  assert(
    fitTrend([
      { date: '2026-06-01', value: 1 },
      { date: '2026-06-01', value: 2 },
      { date: '2026-06-01', value: 3 },
      { date: '2026-06-01', value: 4 },
    ]) === null,
    'fit: all readings on one day refused (zero variance in x)',
  );
}

// ── 3. Campaign lift, happy path ────────────────────────────────────────────

function liftWithTrend() {
  const r = computeCampaignLift({
    metric: 'spotify_listeners',
    baseline: { ...BASE, pre_window: PRE_LINEAR },
    snapshots: [
      { date: '2026-06-16', value: 135 },
      { date: '2026-06-21', value: 150 },
    ],
    deals: [],
  });

  assert(r.status === 'ok', `lift: status ok (got ${r.status})`);
  assert(r.method === 'baseline_trend_projection', `lift: method (got ${r.method})`);
  assert(r.observed_delta === 30, `lift: observed 150-120=30 (got ${r.observed_delta})`);
  assert(close(r.observed_pct, 0.25), `lift: +25% (got ${r.observed_pct})`);
  assert(r.window_days === 10, `lift: 10-day window (got ${r.window_days})`);
  assert(r.latest?.date === '2026-06-21', 'lift: latest point picked');
  assert(r.points.length === 3, `lift: baseline + 2 readings = 3 points (got ${r.points.length})`);

  // Pre-trend is +2/day from day 0 = 100; 2026-06-21 is day 20 → 140 expected.
  assert(close(r.trend?.expected, 140), `lift: projection 140 (got ${r.trend?.expected})`);
  assert(close(r.trend?.excess, 10), `lift: excess 10 (got ${r.trend?.excess})`);
  // sigma is 0, so the band is the declared floor, not zero.
  assert(
    close(r.trend?.noise_band, 120 * MIN_BAND_FRACTION),
    `lift: band falls back to the floor (got ${r.trend?.noise_band})`,
  );
  assert(r.trend?.within_normal_variation === false, 'lift: 10 > 0.6 band → a real excess');
  assert(/correlation/i.test(r.reason), `lift: reason disclaims causation (got "${r.reason}")`);
}

// ── 4. The honesty case: listeners rose, and that is NOT lift ───────────────

function riseThatIsNotLift() {
  const r = computeCampaignLift({
    metric: 'spotify_listeners',
    baseline: { ...BASE, pre_window: PRE_LINEAR },
    snapshots: [
      { date: '2026-06-16', value: 130 },
      { date: '2026-06-21', value: 140 }, // exactly on the pre-campaign line
    ],
    deals: [],
  });

  assert(r.observed_delta === 20, `rise: listeners genuinely up 20 (got ${r.observed_delta})`);
  assert(close(r.trend?.excess, 0), `rise: but excess is 0 (got ${r.trend?.excess})`);
  assert(
    r.trend?.within_normal_variation === true,
    'rise: +20 that matches the pre-trend is NOT a campaign effect',
  );
  assert(
    /already moving in|not produced a distinguishable change/i.test(r.reason),
    `rise: reason says so in plain English (got "${r.reason}")`,
  );
}

// ── 5. Degraded inputs render as unknown, never as zero ─────────────────────

function degraded() {
  const noBase = computeCampaignLift({
    metric: 'spotify_listeners',
    baseline: { value: null, date: null, captured_at: null, pre_window: [] },
    snapshots: [{ date: '2026-06-21', value: 150 }],
    deals: [],
  });
  assert(noBase.status === 'no_baseline', `degraded: no_baseline (got ${noBase.status})`);
  assert(noBase.observed_delta === null, 'degraded: delta is null, NOT 0');
  assert(noBase.method === 'none', 'degraded: no method claimed');
  assert(noBase.reason.length > 0, 'degraded: still explains itself');

  const noReadings = computeCampaignLift({
    metric: 'spotify_listeners',
    baseline: { ...BASE, pre_window: PRE_LINEAR },
    snapshots: [],
    deals: [],
  });
  assert(noReadings.status === 'no_readings', `degraded: no_readings (got ${noReadings.status})`);
  assert(noReadings.observed_delta === null, 'degraded: no reading → null delta');
  assert(noReadings.baseline?.value === 120, 'degraded: baseline still reported');
  assert(noReadings.trend === null, 'degraded: no trend without a reading to project to');

  // A reading on the baseline day itself is not a second observation.
  const sameDay = computeCampaignLift({
    metric: 'spotify_listeners',
    baseline: { ...BASE, pre_window: PRE_LINEAR },
    snapshots: [{ date: '2026-06-11', value: 121 }],
    deals: [],
  });
  assert(
    sameDay.status === 'awaiting_window',
    `degraded: same-day reading → awaiting_window (got ${sameDay.status})`,
  );
  assert(sameDay.observed_delta === null, 'degraded: same-day reading yields no delta');

  // Thin pre-window: still report the observation, drop the counterfactual.
  const thin = computeCampaignLift({
    metric: 'spotify_listeners',
    baseline: { ...BASE, pre_window: PRE_LINEAR.slice(0, 2) },
    snapshots: [{ date: '2026-06-21', value: 150 }],
    deals: [],
  });
  assert(thin.status === 'ok', 'thin: observation survives');
  assert(thin.method === 'observed_window_delta', `thin: method downgraded (got ${thin.method})`);
  assert(thin.observed_delta === 30, 'thin: observed delta still 30');
  assert(thin.trend === null, 'thin: no trend invented from 2 points');
  assert(
    /not enough pre-campaign history/i.test(thin.reason),
    `thin: reason names the gap (got "${thin.reason}")`,
  );

  // Downward movement must read as down, not as absent.
  const down = computeCampaignLift({
    metric: 'spotify_listeners',
    baseline: { ...BASE, pre_window: [] },
    snapshots: [{ date: '2026-06-21', value: 90 }],
    deals: [],
  });
  assert(down.observed_delta === -30, `down: -30 (got ${down.observed_delta})`);
  assert(close(down.observed_pct, -0.25), 'down: -25%');
  assert(/down 30/.test(down.reason), `down: reason says down (got "${down.reason}")`);

  // Zero baseline must not divide by zero.
  const zero = computeCampaignLift({
    metric: 'spotify_listeners',
    baseline: { value: 0, date: '2026-06-11', captured_at: null, pre_window: [] },
    snapshots: [{ date: '2026-06-21', value: 50 }],
    deals: [],
  });
  assert(zero.observed_delta === 50, 'zero-baseline: absolute delta still works');
  assert(zero.observed_pct === null, 'zero-baseline: percent is null, not Infinity');
}

// ── 6. Deal windows ─────────────────────────────────────────────────────────

const POINTS: SeriesPoint[] = [
  { date: '2026-06-11', value: 120 },
  { date: '2026-06-13', value: 122 },
  { date: '2026-06-15', value: 130 },
  { date: '2026-06-18', value: 140 },
  { date: '2026-06-21', value: 150 },
];

function windowsSequential() {
  const deals: LiftDealInput[] = [
    { id: 'a', creator_label: '@ava', posted_at: '2026-06-13T10:00:00Z' },
    { id: 'b', creator_label: '@ben', posted_at: '2026-06-18T10:00:00Z' },
  ];
  const w = dealWindows(deals, POINTS);
  const a = w.find((x) => x.deal_id === 'a');
  const b = w.find((x) => x.deal_id === 'b');

  assert(a?.status === 'sole_post_window', `window: A sole (got ${a?.status})`);
  assert(a?.window_start === '2026-06-13' && a?.window_end === '2026-06-18', 'window: A bounds');
  assert(a?.observed_delta === 18, `window: A 140-122=18 (got ${a?.observed_delta})`);
  assert(a?.window_days === 5, `window: A spans 5 days (got ${a?.window_days})`);
  assert(a?.concurrent_posts === 0, 'window: A has no concurrent post');
  assert(/not proven to be caused/i.test(a?.reason ?? ''), 'window: A disclaims causation');

  assert(b?.status === 'sole_post_window', `window: B sole (got ${b?.status})`);
  assert(b?.observed_delta === 10, `window: B 150-140=10 (got ${b?.observed_delta})`);
  assert(b?.window_end === '2026-06-21', 'window: B runs to the last reading');

  // The two sole windows must not add up to a claim about the whole campaign.
  assert((a?.observed_delta ?? 0) + (b?.observed_delta ?? 0) === 28, 'window: parts sum to 28');
  assert(POINTS[4].value - POINTS[0].value === 30, 'window: whole window moved 30, not 28');
}

function windowsOverlapping() {
  const deals: LiftDealInput[] = [
    { id: 'a', creator_label: '@ava', posted_at: '2026-06-13T10:00:00Z' },
    { id: 'b', creator_label: '@ben', posted_at: '2026-06-13T18:00:00Z' },
  ];
  const w = dealWindows(deals, POINTS);
  assert(w.length === 2, 'overlap: both deals reported');
  for (const d of w) {
    assert(d.status === 'overlapping_posts', `overlap: ${d.deal_id} overlapping (got ${d.status})`);
    assert(d.observed_delta === null, `overlap: ${d.deal_id} delta null, NOT a split of 28`);
    assert(d.concurrent_posts === 1, `overlap: ${d.deal_id} counts the other post`);
    assert(/cannot be separated out/i.test(d.reason), `overlap: ${d.deal_id} explains why`);
  }
}

function windowsEdges() {
  const w = dealWindows(
    [
      { id: 'never', creator_label: '@nil', posted_at: null },
      { id: 'future', creator_label: '@fut', posted_at: '2026-06-25T10:00:00Z' },
    ],
    POINTS,
  );
  const never = w.find((x) => x.deal_id === 'never');
  const future = w.find((x) => x.deal_id === 'future');

  assert(never?.status === 'not_posted', `edge: unposted deal (got ${never?.status})`);
  assert(never?.observed_delta === null, 'edge: unposted delta null');
  assert(never?.window_start === null, 'edge: unposted has no window');

  assert(
    future?.status === 'insufficient_readings',
    `edge: post after the last reading (got ${future?.status})`,
  );
  assert(future?.observed_delta === null, 'edge: no reading after the post → null');

  assert(dealWindows([], POINTS).length === 0, 'edge: no deals → no windows');
  const noPoints = dealWindows(
    [{ id: 'a', creator_label: null, posted_at: '2026-06-13T10:00:00Z' }],
    [],
  );
  assert(
    noPoints[0].status === 'insufficient_readings',
    `edge: no readings at all (got ${noPoints[0].status})`,
  );
}

function windowsThroughLift() {
  // Deals arrive through the top-level call and see the baseline-inclusive series.
  const r = computeCampaignLift({
    metric: 'spotify_listeners',
    baseline: { ...BASE, pre_window: PRE_LINEAR },
    snapshots: POINTS.slice(1),
    deals: [{ id: 'a', creator_label: '@ava', posted_at: '2026-06-13T10:00:00Z' }],
  });
  assert(r.deals.length === 1, 'lift: deal windows returned');
  assert(r.deals[0].status === 'sole_post_window', 'lift: single deal is a sole window');
  // One deal, so its window runs post → last reading: 150 - 122 = 28.
  assert(r.deals[0].observed_delta === 28, `lift: 150-122=28 (got ${r.deals[0].observed_delta})`);
  assert(
    r.deals[0].observed_delta !== r.observed_delta,
    'lift: the deal window is NOT silently equated to the campaign delta',
  );
}

// ── Run ─────────────────────────────────────────────────────────────────────

function main() {
  helpers();
  trendFit();
  liftWithTrend();
  riseThatIsNotLift();
  degraded();
  windowsSequential();
  windowsOverlapping();
  windowsEdges();
  windowsThroughLift();

  console.log(`stream-lift test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main();
