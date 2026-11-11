// src/lib/stream-lift.ts
//
// Campaign streaming lift. Pure math, zero I/O: everything here is
// a function of a confirm-time baseline, the artist_metric_snapshots series,
// and the campaign's posted deals. The route handler does the reading.
//
// ── What the metric actually is, and what that forbids ─────────────────────
//
// The only artist-side number available on a basic Soundcharts plan is
// Spotify **monthly listeners** (`/api/v2/artist/{uuid}/streaming/spotify/
// listening`). That is a rolling 28-day count of distinct listeners. It is a
// stock, not a flow. Three consequences drive every design choice below:
//
//   1. It is NOT a stream count. Nothing here writes to a column called
//      `streams_*`, and no label in this file says "streams".
//   2. Consecutive values must never be summed — the windows overlap almost
//      entirely. Only differences of two readings mean anything.
//   3. It has ~28 days of memory, so a post's effect smears across four weeks
//      and then falls out. There is no sharp per-post impulse to isolate.
//
// ── What we can honestly claim ─────────────────────────────────────────────
//
// Campaign level, two rungs, in increasing order of assumption:
//
//   observed_window_delta      The artist's monthly listeners moved by N over
//                              the campaign window. Pure observation. Zero
//                              causal content — it is true no matter what
//                              caused it.
//
//   baseline_trend_projection  The artist was already on a trend before the
//                              campaign. Extrapolate that pre-campaign line
//                              forward and report observed-minus-projected.
//                              This is a single-series counterfactual with no
//                              control group: it is CORRELATION over the
//                              window, never causation. It is only offered
//                              when the pre-window is thick enough to fit a
//                              line AND to estimate that line's own noise, and
//                              any excess inside that noise band is reported
//                              as "within normal variation" rather than as a
//                              number.
//
// Deal level: per-creator causation is NOT identifiable from an artist-level
// rolling metric when posts overlap, and we do not fake it. No deal ever
// receives a share of the campaign delta. The single narrow claim available is
// the *sole-post window*: an interval in which exactly one campaign post went
// live and no other did. Even then the label is correlation, and external
// causes (a playlist add, radio, the artist's own posting) are not excluded.
// Every other deal renders as unknown — never as zero, never as a split.

/** The only metric this module understands today. */
export type LiftMetric = 'spotify_listeners';

/** One reading. `date` is a calendar day, `YYYY-MM-DD` — never a poll timestamp. */
export interface SeriesPoint {
  date: string;
  value: number;
}

export interface LiftBaselineInput {
  /** Monthly listeners at campaign confirm; null when the capture failed. */
  value: number | null;
  /** Series date the baseline value is for (not the poll time). */
  date: string | null;
  /** ISO timestamp of the confirm that captured it. */
  captured_at: string | null;
  /** Pre-campaign history captured alongside the baseline. May be empty. */
  pre_window: SeriesPoint[];
}

export interface LiftDealInput {
  id: string;
  /** Display label for the surface — creator handle or name. */
  creator_label: string | null;
  /** ISO timestamp the post went live; null when it hasn't. */
  posted_at: string | null;
}

export interface LiftInput {
  metric: LiftMetric;
  baseline: LiftBaselineInput;
  /** Post-baseline readings, any order, duplicates tolerated. */
  snapshots: SeriesPoint[];
  deals: LiftDealInput[];
}

export type LiftStatus =
  | 'ok'
  | 'no_baseline'
  | 'no_readings'
  | 'awaiting_window';

export type LiftMethod =
  | 'none'
  | 'observed_window_delta'
  | 'baseline_trend_projection';

export interface TrendProjection {
  method: 'baseline_trend_projection';
  /** Where the pre-campaign line says the latest reading would have landed. */
  expected: number;
  /** observed − expected. Correlational; not an attributed listener count. */
  excess: number;
  /** ± band the pre-campaign line was already bouncing inside (2 residual SDs). */
  noise_band: number;
  /** True when |excess| <= noise_band — report "no distinguishable move". */
  within_normal_variation: boolean;
  slope_per_day: number;
  pre_points: number;
  pre_span_days: number;
}

export type DealWindowStatus =
  | 'sole_post_window'
  | 'overlapping_posts'
  | 'insufficient_readings'
  | 'not_posted';

export interface DealWindow {
  deal_id: string;
  creator_label: string | null;
  posted_at: string | null;
  window_start: string | null;
  window_end: string | null;
  window_days: number | null;
  /** Observed movement across the window. Null unless `sole_post_window`. */
  observed_delta: number | null;
  status: DealWindowStatus;
  /** Plain-English sentence for the surface. Always set. */
  reason: string;
  /** Other campaign posts that went live inside this window. */
  concurrent_posts: number;
}

export interface CampaignLift {
  metric: LiftMetric;
  status: LiftStatus;
  method: LiftMethod;
  /** Plain-English sentence for the surface. Always set. */
  reason: string;
  baseline: SeriesPoint | null;
  latest: SeriesPoint | null;
  window_days: number | null;
  observed_delta: number | null;
  /** Fraction, not percent: 0.25 means +25%. Null when the baseline is 0. */
  observed_pct: number | null;
  trend: TrendProjection | null;
  /** Baseline + readings, ascending, deduped by date — the chart series. */
  points: SeriesPoint[];
  deals: DealWindow[];
}

// ── Tunables, all of them stated rather than buried ─────────────────────────

/** Fewer pre-campaign readings than this and no line gets fitted. */
export const MIN_PRE_POINTS = 4;
/** A pre-window shorter than this many days can't establish a trend. */
export const MIN_PRE_SPAN_DAYS = 10;
/**
 * Floor on the noise band, as a fraction of the baseline. Soundcharts monthly
 * listeners are themselves estimates, so a sub-0.5% move is not a finding even
 * when the pre-campaign line happens to be arithmetically perfect. This is a
 * declared minimum detectable effect, not a statistical result.
 */
export const MIN_BAND_FRACTION = 0.005;

const DAY_MS = 86_400_000;

// ── Date helpers — calendar days, UTC, no local-timezone drift ──────────────

/** `YYYY-MM-DD` from an ISO timestamp or date. Null when unparseable. */
export function toDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/** Whole days between two `YYYY-MM-DD` days. */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayMs(to) - dayMs(from)) / DAY_MS);
}

/** Clean, sort ascending, and drop duplicate dates (first wins). */
export function normalizeSeries(
  raw: Array<{ date?: string | null; value?: number | null }> | null | undefined,
): SeriesPoint[] {
  const seen = new Map<string, number>();
  for (const p of raw ?? []) {
    const date = toDay(p?.date ?? null);
    const value = Number(p?.value);
    if (!date || !Number.isFinite(value)) continue;
    if (!seen.has(date)) seen.set(date, value);
  }
  return [...seen.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Last point on or before `day`. Assumes `points` ascending. */
function pointAtOrBefore(points: SeriesPoint[], day: string): SeriesPoint | null {
  let best: SeriesPoint | null = null;
  for (const p of points) {
    if (p.date <= day) best = p;
    else break;
  }
  return best;
}

// ── Ordinary least squares over a pre-campaign window ───────────────────────

export interface TrendFit {
  slopePerDay: number;
  /** Fitted value at day offset 0 (the first pre-window point). */
  intercept: number;
  /** Residual standard deviation, sqrt(SSE / (n - 2)). */
  sigma: number;
  n: number;
  spanDays: number;
  originDay: string;
}

/**
 * Fit a line to a pre-campaign series. Returns null when the window is too
 * thin to fit a line AND estimate its residual spread — two points fit any
 * line perfectly and tell you nothing about noise, so they are refused.
 */
export function fitTrend(points: SeriesPoint[]): TrendFit | null {
  const series = normalizeSeries(points);
  if (series.length < MIN_PRE_POINTS) return null;
  const originDay = series[0].date;
  const spanDays = daysBetween(originDay, series[series.length - 1].date);
  if (spanDays < MIN_PRE_SPAN_DAYS) return null;

  const n = series.length;
  const xs = series.map((p) => daysBetween(originDay, p.date));
  const ys = series.map((p) => p.value);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - meanX) ** 2;
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
  }
  if (sxx === 0) return null; // every reading on the same day

  const slopePerDay = sxy / sxx;
  const intercept = meanY - slopePerDay * meanX;

  let sse = 0;
  for (let i = 0; i < n; i++) {
    sse += (ys[i] - (intercept + slopePerDay * xs[i])) ** 2;
  }
  const sigma = Math.sqrt(sse / (n - 2));

  return { slopePerDay, intercept, sigma, n, spanDays, originDay };
}

// ── Deal windows ────────────────────────────────────────────────────────────

/**
 * Split the campaign window by post date. A deal's window runs from its own
 * post to the next *distinct* post date (or the last reading). A window in
 * which no other post went live is a "sole-post window" — the one interval
 * where an observed move is at least temporally exclusive to this deal. Every
 * other deal gets a status and a reason, never a fabricated share.
 */
export function dealWindows(
  deals: LiftDealInput[],
  points: SeriesPoint[],
): DealWindow[] {
  const lastDay = points.length > 0 ? points[points.length - 1].date : null;

  const posted = deals
    .map((d) => ({ deal: d, day: toDay(d.posted_at) }))
    .filter((d): d is { deal: LiftDealInput; day: string } => d.day !== null)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const distinctDays = [...new Set(posted.map((p) => p.day))];

  const out: DealWindow[] = [];

  for (const d of deals) {
    const day = toDay(d.posted_at);
    const base = {
      deal_id: d.id,
      creator_label: d.creator_label,
      posted_at: d.posted_at,
    };

    if (!day) {
      out.push({
        ...base,
        window_start: null,
        window_end: null,
        window_days: null,
        observed_delta: null,
        status: 'not_posted',
        concurrent_posts: 0,
        reason: 'No post is live for this deal yet, so there is no window to measure.',
      });
      continue;
    }

    const nextDay = distinctDays.find((x) => x > day) ?? null;
    const windowEnd =
      nextDay && lastDay ? (nextDay < lastDay ? nextDay : lastDay) : (nextDay ?? lastDay);

    if (!windowEnd || windowEnd <= day) {
      out.push({
        ...base,
        window_start: day,
        window_end: windowEnd,
        window_days: windowEnd ? daysBetween(day, windowEnd) : null,
        observed_delta: null,
        status: 'insufficient_readings',
        concurrent_posts: 0,
        reason: 'No listener reading has landed since this post went live.',
      });
      continue;
    }

    const concurrent = posted.filter(
      (p) => p.deal.id !== d.id && p.day >= day && p.day < windowEnd,
    ).length;

    const windowDays = daysBetween(day, windowEnd);

    if (concurrent > 0) {
      out.push({
        ...base,
        window_start: day,
        window_end: windowEnd,
        window_days: windowDays,
        observed_delta: null,
        status: 'overlapping_posts',
        concurrent_posts: concurrent,
        reason:
          `${concurrent} other campaign ${concurrent === 1 ? 'post' : 'posts'} went live in the same window, ` +
          'so the movement cannot be separated out for this creator.',
      });
      continue;
    }

    const from = pointAtOrBefore(points, day);
    const to = pointAtOrBefore(points, windowEnd);
    if (!from || !to || to.date <= from.date) {
      out.push({
        ...base,
        window_start: day,
        window_end: windowEnd,
        window_days: windowDays,
        observed_delta: null,
        status: 'insufficient_readings',
        concurrent_posts: 0,
        reason: 'Not enough listener readings bracket this window to measure a change.',
      });
      continue;
    }

    out.push({
      ...base,
      window_start: from.date,
      window_end: to.date,
      window_days: daysBetween(from.date, to.date),
      observed_delta: to.value - from.value,
      status: 'sole_post_window',
      concurrent_posts: 0,
      reason:
        'This was the only campaign post live in this window. The movement is correlated with it, ' +
        'not proven to be caused by it: a playlist add or radio play in the same days would look identical.',
    });
  }

  return out;
}

// ── The top-level calculation ───────────────────────────────────────────────

function empty(
  metric: LiftMetric,
  status: LiftStatus,
  reason: string,
  points: SeriesPoint[],
  deals: DealWindow[],
): CampaignLift {
  return {
    metric,
    status,
    method: 'none',
    reason,
    baseline: null,
    latest: null,
    window_days: null,
    observed_delta: null,
    observed_pct: null,
    trend: null,
    points,
    deals,
  };
}

export function computeCampaignLift(input: LiftInput): CampaignLift {
  const metric = input.metric;
  const baselineDay = toDay(input.baseline.date ?? input.baseline.captured_at ?? null);
  const baselineValue = Number(input.baseline.value);
  const hasBaseline = baselineDay !== null && Number.isFinite(baselineValue);

  const readings = normalizeSeries(input.snapshots);

  if (!hasBaseline) {
    return empty(
      metric,
      'no_baseline',
      'No starting point was recorded for this artist, so there is nothing to measure against. ' +
        'Confirm the campaign with a matched artist to capture one.',
      readings,
      dealWindows(input.deals, readings),
    );
  }

  const baselinePoint: SeriesPoint = { date: baselineDay, value: baselineValue };
  // Baseline first so it wins a date collision with a later re-reading.
  const points = normalizeSeries([baselinePoint, ...readings]);
  const deals = dealWindows(input.deals, points);

  const after = points.filter((p) => p.date > baselineDay);
  if (after.length === 0) {
    return {
      ...empty(
        metric,
        readings.length === 0 ? 'no_readings' : 'awaiting_window',
        readings.length === 0
          ? 'Monthly listeners were recorded at the start of this campaign. The first follow-up reading has not landed yet.'
          : 'Every reading so far is from the campaign start date. A change needs at least one later reading.',
        points,
        deals,
      ),
      baseline: baselinePoint,
    };
  }

  const latest = after[after.length - 1];
  const observedDelta = latest.value - baselinePoint.value;
  const observedPct =
    baselinePoint.value !== 0 ? observedDelta / baselinePoint.value : null;
  const windowDays = daysBetween(baselinePoint.date, latest.date);

  // Counterfactual, only when the pre-window can carry it.
  let trend: TrendProjection | null = null;
  const fit = fitTrend(input.baseline.pre_window ?? []);
  if (fit) {
    const horizon = daysBetween(fit.originDay, latest.date);
    const expected = fit.intercept + fit.slopePerDay * horizon;
    const excess = latest.value - expected;
    const band = Math.max(
      2 * fit.sigma,
      Math.abs(baselinePoint.value) * MIN_BAND_FRACTION,
    );
    trend = {
      method: 'baseline_trend_projection',
      expected,
      excess,
      noise_band: band,
      within_normal_variation: Math.abs(excess) <= band,
      slope_per_day: fit.slopePerDay,
      pre_points: fit.n,
      pre_span_days: fit.spanDays,
    };
  }

  const dir = observedDelta >= 0 ? 'up' : 'down';
  const magnitude = Math.abs(observedDelta).toLocaleString('en-US');
  let reason =
    `Monthly listeners are ${dir} ${magnitude} over the ${windowDays} ${windowDays === 1 ? 'day' : 'days'} since this campaign started.`;

  if (trend) {
    reason += trend.within_normal_variation
      ? ' That is inside the range this artist was already moving in before the campaign, so the campaign has not produced a distinguishable change yet.'
      : ` Projecting the artist's pre-campaign trend forward, that is ${
          trend.excess >= 0 ? 'ahead of' : 'behind'
        } where they were heading by ${Math.abs(Math.round(trend.excess)).toLocaleString('en-US')}. Correlation over this window, not proof of cause.`;
  } else {
    reason +=
      ' There is not enough pre-campaign history to say how much of that the artist was heading for anyway.';
  }

  return {
    metric,
    status: 'ok',
    method: trend ? 'baseline_trend_projection' : 'observed_window_delta',
    reason,
    baseline: baselinePoint,
    latest,
    window_days: windowDays,
    observed_delta: observedDelta,
    observed_pct: observedPct,
    trend,
    points,
    deals,
  };
}
