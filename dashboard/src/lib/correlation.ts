// src/lib/correlation.ts
//
// Correlation + confidence engine for the /analytics page.
//
// PURE module — no I/O, no Supabase, no clock, no randomness (the
// analytics.ts contract verbatim). The API route
// (src/app/api/analytics/correlations/route.ts) does all reads, assembles
// DealFactorRow[]s via buildDealFactorRows(), and hands them in.
//
// 100% deterministic math, no AI anywhere in this loop:
// Spearman rank correlation + quantile-bucket means + bucketed group means
// + an n-tiered confidence model are fully expressible as rules. Every
// claim carries a Confidence (tier + n + score + reason); below n = 5 the
// engine refuses to state a trend rather than invent one.
//
// Real and synthetic (sample) campaigns are NEVER pooled in one report —
// computeCorrelationReport THROWS on mixed input.

// ── Input row (assembled by the route, §5.1) ─────────────────────────────────

export interface DealFactorRow {
  offer_id: string;
  campaign_id: string;
  synthetic: boolean; // from campaigns.synthetic
  // outcome
  streams_attributed: number | null; // campaign_outcomes
  payment_usd: number | null; // payment_usd_amount ?? agreed_amount_usd
  // numeric factors
  follower_count: number | null; // follower_count_at_post ?? influencers.follower_count
  engagement_rate: number | null; // engagement_at_post ?? influencers.engagement_rate
  price_usd: number | null; // = payment_usd
  perceived_generosity: number | null; // persisted column (migration 021)
  price_give_pct: number | null; // persisted column (migration 021)
  // categorical factors
  genre: string | null; // influencers.content_genres[0], lowercased
  channel: string | null; // first sent outbound channel ?? ci.primary_channel
  send_window: string | null; // UTC hour bucket of first sent outbound
  promo_activity: string | null; // post_url hostname → '<platform> post'; null when no post_url
}

// ── Factor registry — the full factor list, none silently dropped ──────────

export type FactorId =
  | 'follower_count'
  | 'engagement_rate'
  | 'genre'
  | 'price_usd'
  | 'perceived_generosity'
  | 'price_give_pct'
  | 'channel'
  | 'send_window'
  | 'promo_activity';

export type OutcomeMetric = 'streams' | 'streams_per_dollar';

export interface FactorDef {
  id: FactorId;
  label: string;
  kind: 'numeric' | 'categorical';
  outcome: OutcomeMetric;
  question: string;
}

// Outcome-metric rationale: price_usd correlates against RAW streams because
// streams-per-dollar has price in its denominator — that correlation would be
// mechanically negative and meaningless. Generosity/price-give keep the
// efficiency framing deliberately: "was the extra generosity worth it per
// dollar" is exactly the label's question, and a mechanical efficiency
// decline from overpaying without proportional output is the true answer,
// not an artifact.
export const FACTORS: ReadonlyArray<FactorDef> = [
  { id: 'follower_count',       label: 'Follower count',       kind: 'numeric',     outcome: 'streams_per_dollar', question: 'Which creator size is most efficient?' },
  { id: 'engagement_rate',      label: 'Engagement rate',      kind: 'numeric',     outcome: 'streams_per_dollar', question: 'Does engagement predict efficiency?' },
  { id: 'genre',                label: 'Creator genre',        kind: 'categorical', outcome: 'streams_per_dollar', question: 'Which genres convert for this artist?' },
  { id: 'price_usd',            label: 'Deal price',           kind: 'numeric',     outcome: 'streams',            question: 'Does paying more buy more output?' },
  { id: 'perceived_generosity', label: 'Perceived generosity', kind: 'numeric',     outcome: 'streams_per_dollar', question: 'How generous vs the tier norm is most efficient?' },
  { id: 'price_give_pct',       label: 'Price-give',           kind: 'numeric',     outcome: 'streams_per_dollar', question: 'Do deals where we conceded more end up less efficient?' },
  { id: 'channel',              label: 'Outreach channel',     kind: 'categorical', outcome: 'streams_per_dollar', question: 'Which channel produces the best deals?' },
  { id: 'send_window',          label: 'Send window (UTC)',    kind: 'categorical', outcome: 'streams_per_dollar', question: 'Does outreach timing matter?' },
  { id: 'promo_activity',       label: 'Promo activity',       kind: 'categorical', outcome: 'streams_per_dollar', question: 'Which post type performed?' },
] as const;

// ── Confidence model (§5.4) ──────────────────────────────────────────────────

export type ConfidenceTier = 'insufficient' | 'low' | 'medium' | 'high';

export interface Confidence {
  /** n<5 insufficient | 5–14 low | 15–39 medium | ≥40 high (n = rows usable for THIS factor). */
  tier: ConfidenceTier;
  n: number;
  /** min(1, n/30) — the rl-pricing.ts:106 confidence-ramp idiom. */
  score: number;
  reason: string;
}

// Tier thresholds align with the two existing house constants:
// RL_OPENING_MIN_SAMPLE = 5 (analytics.ts) and the n/30 ramp (rl-pricing.ts).
const TIER_LOW = 5;
const TIER_MEDIUM = 15;
const TIER_HIGH = 40;

export function confidenceForN(n: number): Confidence {
  const deals = `${n} measured deal${n === 1 ? '' : 's'} with this factor`;
  if (n < TIER_LOW) {
    return { tier: 'insufficient', n, score: Math.min(1, n / 30), reason: `insufficient: ${deals} (need ${TIER_LOW} for low)` };
  }
  if (n < TIER_MEDIUM) {
    return { tier: 'low', n, score: Math.min(1, n / 30), reason: `low: ${deals} (need ${TIER_MEDIUM} for medium)` };
  }
  if (n < TIER_HIGH) {
    return { tier: 'medium', n, score: Math.min(1, n / 30), reason: `medium: ${deals} (need ${TIER_HIGH} for high)` };
  }
  return { tier: 'high', n, score: 1, reason: `high: ${deals}` };
}

// ── Report types (§5.5) ──────────────────────────────────────────────────────

export interface FactorBucket {
  label: string;
  lo: number;
  hi: number;
  n: number;
  mean_outcome: number;
}

export interface NumericFactorResult {
  kind: 'numeric';
  factor: FactorId;
  label: string;
  question: string;
  outcome: OutcomeMetric;
  n: number;
  spearman_rho: number | null;
  t_stat: number | null;
  direction: 'positive' | 'negative' | 'none';
  buckets: FactorBucket[];
  confidence: Confidence;
  notes: string[];
}

export interface FactorGroup {
  value: string;
  n: number;
  mean_outcome: number;
  small_sample: boolean;
}

export interface CategoricalFactorResult {
  kind: 'categorical';
  factor: FactorId;
  label: string;
  question: string;
  outcome: OutcomeMetric;
  n: number;
  groups: FactorGroup[];
  leader: string | null;
  confidence: Confidence;
  notes: string[];
}

export type FactorResult = NumericFactorResult | CategoricalFactorResult;

export interface CorrelationScope {
  kind: 'campaign' | 'pool';
  campaign_ids: string[];
  synthetic: boolean;
}

export interface CorrelationReport {
  scope: CorrelationScope;
  deals_measured: number;
  totals: { streams: number; spend_usd: number; streams_per_dollar: number | null };
  factors: FactorResult[]; // always all 9, in FACTORS order
}

// ── Spearman rank correlation (§5.3) ─────────────────────────────────────────

/** Average ranks (1-based); ties share the mean of the ranks they span. */
function averageRanks(values: number[]): number[] {
  const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && values[idx[j + 1]] === values[idx[i]]) j++;
    const avg = (i + j) / 2 + 1; // mean of 1-based ranks i+1 … j+1
    for (let k = i; k <= j; k++) ranks[idx[k]] = avg;
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman rank correlation: average-rank ties, Pearson on ranks. Robust to
 * the heavy-tailed streams distribution; monotone-not-linear friendly.
 * Returns null when n < 3 or either side has zero variance.
 */
export function spearman(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n !== ys.length || n < 3) return null;
  const rx = averageRanks(xs);
  const ry = averageRanks(ys);
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - mx;
    const dy = ry[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null; // zero variance on either side
  return cov / Math.sqrt(vx * vy);
}

// ── Quantile buckets (§5.3 sweet-spot visualization) ─────────────────────────

/** Type-7 (linear interpolation) empirical quantile over a sorted array. */
function quantileSorted(sorted: number[], p: number): number {
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

/** Compact deterministic edge label: 25000 → '25k', 1.256 → '1.26'. */
function fmtEdge(v: number): string {
  const trim = (x: number) => String(Math.round(x * 100) / 100);
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${trim(v / 1_000_000)}m`;
  if (abs >= 1_000) return `${trim(v / 1_000)}k`;
  return trim(v);
}

/**
 * Quantile buckets: k = n ≥ 20 ? 4 : 3, edges at empirical quantiles with
 * duplicate-edge merging (heavy ties collapse buckets). A hump across bucket
 * means shows a sweet spot even when monotone ρ ≈ 0 — the buckets are the
 * chart, ρ is the number.
 */
function quantileBuckets(pairs: Array<{ x: number; y: number }>): FactorBucket[] {
  const n = pairs.length;
  if (n < 3) return [];
  const k = n >= 20 ? 4 : 3;
  const sorted = pairs.map((p) => p.x).sort((a, b) => a - b);
  const edges: number[] = [];
  for (let i = 0; i <= k; i++) edges.push(quantileSorted(sorted, i / k));
  const merged = edges.filter((e, i) => i === 0 || e !== edges[i - 1]);
  if (merged.length < 2) return []; // constant factor → nothing to bucket

  const acc = merged.slice(0, -1).map((lo, j) => ({ lo, hi: merged[j + 1], n: 0, sum: 0 }));
  for (const { x, y } of pairs) {
    let j = acc.length - 1; // last bucket is hi-inclusive
    for (let b = 0; b < acc.length; b++) {
      if (x < acc[b].hi) {
        j = b;
        break;
      }
    }
    acc[j].n += 1;
    acc[j].sum += y;
  }
  return acc
    .filter((b) => b.n > 0)
    .map((b) => ({
      label: `${fmtEdge(b.lo)}–${fmtEdge(b.hi)}`,
      lo: b.lo,
      hi: b.hi,
      n: b.n,
      mean_outcome: b.sum / b.n,
    }));
}

// ── Per-row factor/outcome extraction ────────────────────────────────────────

const NUMERIC_FIELD: Record<string, (r: DealFactorRow) => number | null> = {
  follower_count: (r) => r.follower_count,
  engagement_rate: (r) => r.engagement_rate,
  price_usd: (r) => r.price_usd,
  perceived_generosity: (r) => r.perceived_generosity,
  price_give_pct: (r) => r.price_give_pct,
};

const CATEGORICAL_FIELD: Record<string, (r: DealFactorRow) => string | null> = {
  genre: (r) => r.genre,
  channel: (r) => r.channel,
  send_window: (r) => r.send_window,
  promo_activity: (r) => r.promo_activity,
};

/**
 * Outcome value for a measured row. streams_per_dollar needs a positive
 * payment; rows without one are unusable for efficiency factors (they still
 * count toward deals_measured and raw-streams factors).
 */
function outcomeValue(row: DealFactorRow, metric: OutcomeMetric): number | null {
  if (row.streams_attributed == null) return null;
  if (metric === 'streams') return row.streams_attributed;
  if (row.payment_usd == null || row.payment_usd <= 0) return null;
  return row.streams_attributed / row.payment_usd;
}

/** Small-n notes shared by both factor kinds (§5.3 edge cases, verbatim). */
function smallNNotes(n: number): string[] {
  if (n === 0) return ['no measured deals'];
  if (n < 3) return ['fewer than 3 measured deals'];
  return [];
}

// ── Numeric factor (§5.3) ────────────────────────────────────────────────────

function computeNumericFactor(def: FactorDef, measured: DealFactorRow[]): NumericFactorResult {
  const getter = NUMERIC_FIELD[def.id];
  const pairs: Array<{ x: number; y: number }> = [];
  for (const r of measured) {
    const x = getter(r);
    const y = outcomeValue(r, def.outcome);
    if (x != null && y != null) pairs.push({ x, y });
  }
  const n = pairs.length;
  const confidence = confidenceForN(n);
  const notes = smallNNotes(n);

  let rho: number | null = null;
  let tStat: number | null = null;
  let direction: NumericFactorResult['direction'] = 'none';
  let buckets: FactorBucket[] = [];

  if (n >= 3) {
    const xs = pairs.map((p) => p.x);
    const ys = pairs.map((p) => p.y);
    const xConst = xs.every((v) => v === xs[0]);
    const yConst = ys.every((v) => v === ys[0]);
    if (xConst) notes.push('no variation in this factor yet');
    if (yConst) notes.push('no variation in outcomes yet');
    rho = spearman(xs, ys); // null on constant sides — handled by the notes above
    if (rho != null) {
      // Trend gate: t = |ρ|·sqrt((n−2)/(1−ρ²)); ρ² ≥ 1 → t = Infinity.
      // t ≥ 2.0 ≈ two-sided p < 0.05 at these n — a fixed, auditable
      // threshold, not a p-value library. A trend is only stated when the
      // gate passes AND the confidence tier is at least 'low' (n ≥ 5):
      // below that the engine refuses to state a trend.
      const r2 = rho * rho;
      tStat = r2 >= 1 ? Infinity : Math.abs(rho) * Math.sqrt((n - 2) / (1 - r2));
      if (tStat >= 2.0 && confidence.tier !== 'insufficient' && rho !== 0) {
        direction = rho > 0 ? 'positive' : 'negative';
      }
    }
    buckets = quantileBuckets(pairs);
  }

  return {
    kind: 'numeric',
    factor: def.id,
    label: def.label,
    question: def.question,
    outcome: def.outcome,
    n,
    spearman_rho: rho,
    t_stat: tStat,
    direction,
    buckets,
    confidence,
    notes,
  };
}

// ── Categorical factor (§5.3) ────────────────────────────────────────────────

function computeCategoricalFactor(def: FactorDef, measured: DealFactorRow[]): CategoricalFactorResult {
  const getter = CATEGORICAL_FIELD[def.id];
  const pairs: Array<{ v: string; y: number }> = [];
  for (const r of measured) {
    const v = getter(r);
    const y = outcomeValue(r, def.outcome);
    if (v != null && y != null) pairs.push({ v, y });
  }
  const n = pairs.length;
  const confidence = confidenceForN(n);
  const notes = smallNNotes(n);

  let groups: FactorGroup[] = [];
  let leader: string | null = null;

  if (n >= 3) {
    const byValue = new Map<string, { n: number; sum: number }>();
    for (const { v, y } of pairs) {
      const g = byValue.get(v) ?? { n: 0, sum: 0 };
      g.n += 1;
      g.sum += y;
      byValue.set(v, g);
    }
    groups = [...byValue.entries()]
      .map(([value, g]) => ({
        value,
        n: g.n,
        mean_outcome: g.sum / g.n,
        small_sample: g.n < 3, // UI mutes these
      }))
      // Deterministic order: mean desc, then n desc, then value asc.
      .sort(
        (a, b) =>
          b.mean_outcome - a.mean_outcome || b.n - a.n || a.value.localeCompare(b.value),
      );

    // Leader rule (§5.3): top group only if the top-2 groups each have n ≥ 3
    // AND top.mean ≥ 1.2 × second.mean. Arithmetic note: both-n≥3 means a
    // leader can never be named below overall n = 6, so 'insufficient'
    // factors can never carry a leader claim.
    if (groups.length >= 2) {
      const [top, second] = groups;
      if (top.n >= 3 && second.n >= 3) {
        // top.mean_outcome > 0 guard: with all-zero outcomes 0 ≥ 1.2×0 holds
        // vacuously — refuse to name a leader on zero signal.
        if (top.mean_outcome > 0 && top.mean_outcome >= 1.2 * second.mean_outcome) {
          leader = top.value;
        } else {
          notes.push('no group stands out yet (top mean < 1.2× runner-up)');
        }
      } else {
        notes.push('not enough deals per group to name a leader (need 3+ in the top two groups)');
      }
    } else if (groups.length === 1) {
      notes.push('only one group observed');
    }
  }

  return {
    kind: 'categorical',
    factor: def.id,
    label: def.label,
    question: def.question,
    outcome: def.outcome,
    n,
    groups,
    leader,
    confidence,
    notes,
  };
}

// ── Report entry point (§5.5) ────────────────────────────────────────────────

export function computeCorrelationReport(
  rows: DealFactorRow[],
  scope: CorrelationScope,
): CorrelationReport {
  // D5–D7: real data and sample data never blend in one report. A mixed
  // input is a caller bug or a data-integrity failure — refuse loudly.
  const hasSynthetic = rows.some((r) => r.synthetic);
  const hasReal = rows.some((r) => !r.synthetic);
  if (hasSynthetic && hasReal) {
    throw new Error('refusing to mix synthetic and real campaigns in one report');
  }

  const measured = rows.filter((r) => r.streams_attributed != null);

  let streams = 0;
  let spend = 0;
  for (const r of measured) {
    streams += r.streams_attributed ?? 0;
    spend += r.payment_usd ?? 0;
  }

  const factors: FactorResult[] = FACTORS.map((def) =>
    def.kind === 'numeric'
      ? computeNumericFactor(def, measured)
      : computeCategoricalFactor(def, measured),
  );

  return {
    scope,
    deals_measured: measured.length,
    totals: {
      streams,
      spend_usd: spend,
      streams_per_dollar: spend > 0 ? streams / spend : null,
    },
    factors,
  };
}

// ── Row assembly (§5.1/§5.5) — pure join over route-fetched tables ───────────

export interface BuildDealFactorRowsInput {
  campaigns: Array<{ id: string; synthetic: boolean }>;
  offers: Array<{
    id: string;
    campaign_id: string;
    campaign_influencer_id: string | null;
    agreed_amount_usd: number | null;
    initial_offer_usd: number | null;
    ceiling_usd: number | null;
    perceived_generosity: number | null;
    price_give_pct: number | null;
    post_url: string | null;
  }>;
  outcomes: Array<{
    creator_offer_id: string | null;
    streams_attributed: number | null;
    payment_usd_amount: number | null;
    follower_count_at_post: number | null;
    engagement_at_post: number | null;
  }>;
  cis: Array<{
    id: string;
    campaign_id: string;
    influencer_id: string | null;
    primary_channel: string | null;
  }>;
  influencers: Array<{
    id: string;
    follower_count: number | null;
    engagement_rate: number | null;
    content_genres: string[] | null;
  }>;
  /** Earliest outbound status='sent' per CI (route reduces; reduced again here defensively). */
  firstSends: Array<{ campaign_influencer_id: string; channel: string | null; sent_at: string | null }>;
}

/** UTC-hour send window: 'night 0–5' | 'morning 6–11' | 'afternoon 12–17' | 'evening 18–23'. */
function sendWindowUtc(sentAt: string | null): string | null {
  if (!sentAt) return null;
  const t = Date.parse(sentAt);
  if (Number.isNaN(t)) return null;
  const h = new Date(t).getUTCHours();
  if (h < 6) return 'night 0–5';
  if (h < 12) return 'morning 6–11';
  if (h < 18) return 'afternoon 12–17';
  return 'evening 18–23';
}

/** post_url hostname → 'tiktok post' | 'instagram post' | 'youtube post' | 'other post'; null when no post_url. */
function promoActivity(postUrl: string | null): string | null {
  if (!postUrl) return null;
  let host: string;
  try {
    host = new URL(postUrl).hostname.toLowerCase();
  } catch {
    return 'other post';
  }
  if (host.includes('tiktok')) return 'tiktok post';
  if (host.includes('instagram')) return 'instagram post';
  if (host.includes('youtube') || host === 'youtu.be') return 'youtube post';
  return 'other post';
}

export function buildDealFactorRows(input: BuildDealFactorRowsInput): DealFactorRow[] {
  const syntheticByCampaign = new Map<string, boolean>();
  for (const c of input.campaigns) syntheticByCampaign.set(c.id, c.synthetic);

  const outcomeByOffer = new Map<string, BuildDealFactorRowsInput['outcomes'][number]>();
  for (const o of input.outcomes) {
    if (o.creator_offer_id != null) outcomeByOffer.set(o.creator_offer_id, o);
  }

  const ciById = new Map<string, BuildDealFactorRowsInput['cis'][number]>();
  for (const ci of input.cis) ciById.set(ci.id, ci);

  const infById = new Map<string, BuildDealFactorRowsInput['influencers'][number]>();
  for (const inf of input.influencers) infById.set(inf.id, inf);

  // Earliest sent outbound per CI (defensive reduce; null sent_at loses).
  const firstSendByCi = new Map<string, { channel: string | null; sent_at: string | null }>();
  for (const fs of input.firstSends) {
    const prev = firstSendByCi.get(fs.campaign_influencer_id);
    if (!prev) {
      firstSendByCi.set(fs.campaign_influencer_id, fs);
      continue;
    }
    const tNew = fs.sent_at != null ? Date.parse(fs.sent_at) : NaN;
    const tPrev = prev.sent_at != null ? Date.parse(prev.sent_at) : NaN;
    if (!Number.isNaN(tNew) && (Number.isNaN(tPrev) || tNew < tPrev)) {
      firstSendByCi.set(fs.campaign_influencer_id, fs);
    }
  }

  const rows: DealFactorRow[] = [];
  for (const offer of input.offers) {
    const synthetic = syntheticByCampaign.get(offer.campaign_id);
    if (synthetic == null) continue; // offer outside the provided campaign set

    const outcome = outcomeByOffer.get(offer.id) ?? null;
    const ci = offer.campaign_influencer_id != null ? ciById.get(offer.campaign_influencer_id) ?? null : null;
    const inf = ci?.influencer_id != null ? infById.get(ci.influencer_id) ?? null : null;
    const firstSend = ci != null ? firstSendByCi.get(ci.id) ?? null : null;

    // payment_usd_amount ?? agreed_amount_usd (§5.1).
    const payment = outcome?.payment_usd_amount ?? offer.agreed_amount_usd ?? null;

    const rawGenre = inf?.content_genres?.[0];
    const genre = rawGenre != null && rawGenre.trim() !== '' ? rawGenre.trim().toLowerCase() : null;

    rows.push({
      offer_id: offer.id,
      campaign_id: offer.campaign_id,
      synthetic,
      streams_attributed: outcome?.streams_attributed ?? null,
      payment_usd: payment,
      // Snapshot-at-post beats the drifting live value (§5.1).
      follower_count: outcome?.follower_count_at_post ?? inf?.follower_count ?? null,
      engagement_rate: outcome?.engagement_at_post ?? inf?.engagement_rate ?? null,
      price_usd: payment,
      perceived_generosity: offer.perceived_generosity,
      price_give_pct: offer.price_give_pct,
      genre,
      channel: firstSend?.channel ?? ci?.primary_channel ?? null,
      send_window: sendWindowUtc(firstSend?.sent_at ?? null),
      promo_activity: promoActivity(offer.post_url),
    });
  }
  return rows;
}
