// src/lib/analytics.ts
//
// Analytics + RL measurement layer.
//
// PURE, DETERMINISTIC, TESTABLE. No DB, no I/O, no clock, no rng. The
// /api/analytics route does the RLS-scoped reads and hands the rows to these
// functions; the negotiation core delegates its `getOpeningPct` seam to
// `estimateOpeningPct` here. Everything below is a plain function of its
// inputs so it can be unit-tested with synthetic fixtures (tests/analytics.test.ts).
//
// The four money/outcome metrics:
//
//   1. RESPONSE-CONVERSION RATE = replies ÷ sent.
//   2. DEALS CLOSED + OUTPUT-PER-DOLLAR (ROI) — agreed/paid offers vs spend,
//      under the marginal-output-per-dollar framing.
//   3. CPM = campaign_spend_usd / (delivered_reach_or_views / 1000).
//   4. PER-CREATOR perceived outcome = output ÷ paid; SPEND consumed / remaining
//      vs the campaign budget.
//
// Plus the RL opening-offer estimator (`estimateOpeningPct`): the opening offer
// as a fraction of the per-creator ceiling, nudged from history toward the
// learned price↔output equilibrium (marginal-output sweet spot) + the
// desired-vs-negotiated-price gap. Cold-start = the deterministic pricing-engine
// prior when there is too little history. No fixed % is hardcoded — it falls
// out of pricing, then RL.

import {
  calculateInitialOffer,
  type MarketDataPoint,
} from './pricing-engine';
import { predict, type OutcomeDatum } from './rl-pricing';
import { labelCpm } from './cpm-model';

// ── Offer-status state sets (kept local — no import cycle with negotiation.ts) ─
//
// Mirrors negotiation.ts COMMITTED_STATES: an offer at/after 'agreed' has money
// committed against the campaign budget. PAID = money actually out the door;
// DELIVERED = the creator posted (reach is live) or streams are measured.
export const DEALS_CLOSED_STATES = [
  'agreed',
  'human_approval_required',
  'approved',
  'paid',
  'posted',
  'measured',
] as const;
export const PAID_STATES = ['paid', 'posted', 'measured'] as const;
export const DELIVERED_STATES = ['posted', 'measured'] as const;

const clampUnit = (n: number): number =>
  Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;

// ── Input row shapes (subsets of the live tables the analytics reads) ────────

export interface AnalyticsOfferRow {
  id: string;
  campaign_id: string;
  campaign_influencer_id: string | null;
  status: string;
  agreed_amount_usd: number | null;
  current_offer_usd: number | null;
  initial_offer_usd: number | null;
  ceiling_usd: number | null;
  opening_pct: number | null;
}

export interface AnalyticsOutcomeRow {
  creator_offer_id: string | null;
  streams_attributed: number | null;
  payment_usd_amount: number | null;
  follower_count_at_post: number | null;
}

export interface AnalyticsOutreachRow {
  campaign_influencer_id: string | null;
  direction: string | null;
  status: string | null;
}

export interface AnalyticsInboundRow {
  campaign_influencer_id: string | null;
}

export interface AnalyticsCampaignRow {
  id: string;
  artist_name?: string | null;
  status?: string | null;
  /** Migration 009 hard campaign cap. Primary budget for spend-remaining. */
  total_budget_usd: number | null;
  /** Legacy base column. Fallback when total_budget_usd is null. */
  budget: number | null;
}

/** campaign_influencer_id → the creator's follower_count (reach proxy). */
export interface AnalyticsReachRow {
  campaign_influencer_id: string;
  follower_count: number | null;
}

// ── Small helpers ────────────────────────────────────────────────────────────

const num = (v: number | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The dollar amount an offer has on the table. agreed wins (a closed deal),
 * else the current standing offer. Matches the negotiation guardrail's
 * committed-spend accounting exactly (agreed_amount_usd ?? current_offer_usd).
 */
export function offerSpend(o: AnalyticsOfferRow): number {
  return num(o.agreed_amount_usd ?? o.current_offer_usd ?? 0);
}

const inSet = (states: readonly string[], status: string): boolean =>
  states.includes(status);

// ── 1. Response-conversion rate = replies ÷ sent ─────────────────────────────

export interface ConversionMetrics {
  /** Distinct creators with ≥1 delivered (status='sent') outbound message. */
  creators_sent: number;
  /** Distinct creators who replied (inbound_messages ∪ inbound outreach_messages). */
  creators_replied: number;
  /** Count of delivered outbound messages (message-level denominator). */
  messages_sent: number;
  /** replies ÷ sent, at the creator level. null when nothing has been sent. */
  response_conversion_rate: number | null;
}

/**
 * Response-conversion rate. Denominator = creators we actually reached (an
 * outbound outreach_messages row with status='sent'). Numerator = creators who
 * replied at least once. Replies are counted from BOTH the normalized
 * inbound_messages queue (migration 018) AND legacy inbound outreach_messages
 * rows (simulator / respond / ingest paths), de-duplicated per creator so a
 * multi-message thread is one conversion — matching the funnel's per-creator
 * unit and common email baselines (recruiting 1-2%, "good" 6-8%).
 */
export function computeConversion(
  outreach: AnalyticsOutreachRow[],
  inbound: AnalyticsInboundRow[],
): ConversionMetrics {
  const sentCreators = new Set<string>();
  let messagesSent = 0;
  const repliers = new Set<string>();

  for (const m of outreach) {
    const isOutbound = m.direction === 'outbound';
    if (isOutbound && m.status === 'sent') {
      messagesSent += 1;
      if (m.campaign_influencer_id) sentCreators.add(m.campaign_influencer_id);
    }
    // Legacy inbound replies also live in outreach_messages (direction='inbound').
    if (m.direction === 'inbound' && m.campaign_influencer_id) {
      repliers.add(m.campaign_influencer_id);
    }
  }
  for (const r of inbound) {
    if (r.campaign_influencer_id) repliers.add(r.campaign_influencer_id);
  }

  const creators_sent = sentCreators.size;
  const creators_replied = repliers.size;
  return {
    creators_sent,
    creators_replied,
    messages_sent: messagesSent,
    response_conversion_rate:
      creators_sent > 0 ? creators_replied / creators_sent : null,
  };
}

// ── 2. Deals closed ──────────────────────────────────────────────────────────

export interface DealMetrics {
  offers_total: number;
  deals_closed: number; // reached ≥ 'agreed'
  paid_count: number; // paid / posted / measured
  delivered_count: number; // posted / measured
  rejected_count: number; // rejected / failed
}

export function computeDeals(offers: AnalyticsOfferRow[]): DealMetrics {
  let deals_closed = 0;
  let paid_count = 0;
  let delivered_count = 0;
  let rejected_count = 0;
  for (const o of offers) {
    if (inSet(DEALS_CLOSED_STATES, o.status)) deals_closed += 1;
    if (inSet(PAID_STATES, o.status)) paid_count += 1;
    if (inSet(DELIVERED_STATES, o.status)) delivered_count += 1;
    if (o.status === 'rejected' || o.status === 'failed') rejected_count += 1;
  }
  return {
    offers_total: offers.length,
    deals_closed,
    paid_count,
    delivered_count,
    rejected_count,
  };
}

// ── Spend consumed / remaining vs campaign budget ────────────────────────────

export interface SpendMetrics {
  budget_usd: number | null;
  /** Σ committed (agreed onward) — what the negotiation guardrail deducts. */
  spend_committed_usd: number;
  /** Σ paid (paid/posted/measured) — money actually out the door. */
  spend_paid_usd: number;
  /** budget − committed. null when the campaign has no budget cap. */
  remaining_usd: number | null;
  /** committed ÷ budget, in [0,1]. null when no/zero budget. */
  consumed_pct: number | null;
}

/**
 * Spend consumed / remaining. `budget` = total_budget_usd (the hard cap the
 * negotiation loop respects), falling back to the legacy `budget` column.
 * Committed spend mirrors negotiation.ts exactly so the dashboard number equals
 * what the auto-negotiator will refuse to exceed.
 */
export function computeSpend(
  offers: AnalyticsOfferRow[],
  campaign: Pick<AnalyticsCampaignRow, 'total_budget_usd' | 'budget'>,
): SpendMetrics {
  let committed = 0;
  let paid = 0;
  for (const o of offers) {
    if (inSet(DEALS_CLOSED_STATES, o.status)) committed += offerSpend(o);
    if (inSet(PAID_STATES, o.status)) paid += offerSpend(o);
  }
  const rawBudget = campaign.total_budget_usd ?? campaign.budget ?? null;
  const budget_usd = rawBudget != null ? num(rawBudget) : null;
  return {
    budget_usd,
    spend_committed_usd: round2(committed),
    spend_paid_usd: round2(paid),
    remaining_usd: budget_usd != null ? round2(budget_usd - committed) : null,
    consumed_pct:
      budget_usd != null && budget_usd > 0 ? clampUnit(committed / budget_usd) : null,
  };
}

// ── 2b. Output-per-dollar (ROI) ──────────────────────────────────────────────

export interface RoiMetrics {
  /** Σ streams_attributed across measured outcomes. */
  total_output: number;
  /** Spend that bought that output (outcome.payment_usd_amount ?? offer spend). */
  output_spend_usd: number;
  /** total_output ÷ output_spend_usd. null when no spend. */
  output_per_dollar: number | null;
}

/**
 * Output-per-dollar (campaign ROI), in the marginal-output framing: total
 * measured output over the money that produced it. Pairs each outcome's
 * streams with its payment snapshot (falls back to the offer's committed
 * amount). Divide-by-zero → null.
 */
export function computeOutputPerDollar(
  offers: AnalyticsOfferRow[],
  outcomes: AnalyticsOutcomeRow[],
): RoiMetrics {
  const offerById = new Map(offers.map((o) => [o.id, o]));
  let total_output = 0;
  let output_spend = 0;
  for (const oc of outcomes) {
    const output = Math.max(0, num(oc.streams_attributed));
    total_output += output;
    const offer = oc.creator_offer_id ? offerById.get(oc.creator_offer_id) : undefined;
    const spend =
      oc.payment_usd_amount != null
        ? num(oc.payment_usd_amount)
        : offer
          ? offerSpend(offer)
          : 0;
    output_spend += spend;
  }
  return {
    total_output,
    output_spend_usd: round2(output_spend),
    output_per_dollar: output_spend > 0 ? total_output / output_spend : null,
  };
}

// ── 3. CPM = spend / (delivered_reach / 1000) ────────────────────────────────

export interface CpmMetrics {
  /** Σ reach for creators who reached posted/measured (views ?? followers). */
  delivered_reach: number;
  /** campaign_spend_usd used in the numerator (= paid spend). */
  spend_usd: number;
  /** cost per 1,000 delivered. null on divide-by-zero (no reach yet). */
  cpm_usd: number | null;
}

/**
 * Label-side CPM = paid spend per 1,000 REAL delivered impressions. reachByOffer
 * carries verified post views from deal_performance_snapshots (the measurement
 * tick) keyed by creator_offer_id — the only coherent reach signal. We do NOT
 * substitute streams (a stream is not an impression) or follower_count (audience
 * size is not reach): an unmeasured deal contributes spend but zero reach, and
 * when total delivered reach is 0 the CPM is null (not a fabricated number).
 * Cost-per-stream lives separately in output-per-dollar.
 */
export function computeCpm(
  offers: AnalyticsOfferRow[],
  reachByOffer: Map<string, number>,
): CpmMetrics {
  let delivered_reach = 0;
  let spend_usd = 0;
  for (const o of offers) {
    if (!inSet(DELIVERED_STATES, o.status)) continue;
    spend_usd += offerSpend(o);
    delivered_reach += Math.max(0, num(reachByOffer.get(o.id)));
  }
  return {
    delivered_reach,
    spend_usd: round2(spend_usd),
    cpm_usd: labelCpm(round2(spend_usd), delivered_reach),
  };
}

// ── 4. Per-creator perceived outcome = output ÷ paid ─────────────────────────

export interface PerCreatorRow {
  offer_id: string;
  campaign_influencer_id: string | null;
  status: string;
  paid_usd: number;
  output: number;
  /** output ÷ paid. null when paid is 0. */
  output_per_dollar: number | null;
  has_outcome: boolean;
}

/**
 * Per-creator perceived outcome. One row per offer that has money committed
 * (paid onward), pairing its spend with its measured output. output_per_dollar
 * = output ÷ paid (null when paid is 0). Sorted best-value first.
 */
export function computePerCreator(
  offers: AnalyticsOfferRow[],
  outcomes: AnalyticsOutcomeRow[],
): PerCreatorRow[] {
  const outcomeByOffer = new Map<string, AnalyticsOutcomeRow>();
  for (const oc of outcomes) {
    if (oc.creator_offer_id) outcomeByOffer.set(oc.creator_offer_id, oc);
  }
  const rows: PerCreatorRow[] = [];
  for (const o of offers) {
    if (!inSet(PAID_STATES, o.status)) continue;
    const oc = outcomeByOffer.get(o.id);
    const paid = offerSpend(o);
    const output = oc ? Math.max(0, num(oc.streams_attributed)) : 0;
    rows.push({
      offer_id: o.id,
      campaign_influencer_id: o.campaign_influencer_id,
      status: o.status,
      paid_usd: round2(paid),
      output,
      output_per_dollar: paid > 0 ? output / paid : null,
      has_outcome: !!oc,
    });
  }
  rows.sort((a, b) => (b.output_per_dollar ?? -1) - (a.output_per_dollar ?? -1));
  return rows;
}

// ── RL opening-offer % estimator (the real getOpeningPct body) ───────────────

export interface OutputPoint {
  cost_usd: number;
  /** Unit-agnostic expected output (reach / views / streams). */
  expected_output: number;
}

/** Marginal output bought per extra dollar moving from `cheaper` → `dearer`. */
export function marginalOutputPerDollar(
  cheaper: OutputPoint,
  dearer: OutputPoint,
): number {
  const dCost = dearer.cost_usd - cheaper.cost_usd;
  if (dCost <= 0) return 0;
  return (dearer.expected_output - cheaper.expected_output) / dCost;
}

/**
 * Spec heuristic: "optimize marginal output per marginal dollar; ride up the
 * cost curve until diminishing returns; settle at the sweet spot." Keep stepping
 * up while each extra dollar still buys at least `minMarginalRatio`× the baseline
 * (cheapest) point's average output-per-dollar. Returns the sweet-spot index
 * into `points` (-1 if empty). Pure; the RL loop refines minMarginalRatio.
 *
 * Example: 1,500-follower @ $20 vs 5,000-follower @ $25 → +25% cost but
 * +45% output → the marginal ratio still clears the bar, so ride up to $25.
 */
export function chooseSweetSpot(
  points: OutputPoint[],
  minMarginalRatio = 1.0,
): number {
  if (points.length === 0) return -1;
  const sorted = [...points].sort((a, b) => a.cost_usd - b.cost_usd);
  const baseline = sorted[0];
  const baseAvg =
    baseline.cost_usd > 0 ? baseline.expected_output / baseline.cost_usd : Infinity;

  let bestSorted = 0;
  for (let i = 1; i < sorted.length; i++) {
    const marg = marginalOutputPerDollar(sorted[i - 1], sorted[i]);
    if (marg >= baseAvg * minMarginalRatio) bestSorted = i;
    else break; // diminishing returns — stop riding up
  }
  return points.indexOf(sorted[bestSorted]);
}

export interface OpeningPctContext {
  follower_count: number;
  engagement_rate: number;
  genre?: string | null;
  /**
   * Per-firm genre premium table (firms.scraping_prefs.genre_premiums).
   * Threaded through from createOffer so a label's configured premium
   * actually reaches the pricing engine. Omitted -> the empty default, i.e.
   * genre-neutral. See src/lib/genre-config.ts.
   */
  genre_premiums?: Readonly<Record<string, number>>;
  ceiling_usd: number;
  /** (cost, output) history — the price↔output equilibrium signal. */
  market_data?: MarketDataPoint[];
  /** Realized (opening, agreed) pairs — the desired-vs-negotiated gap signal. */
  negotiation_history?: NegotiationOutcome[];
}

export interface NegotiationOutcome {
  opening_usd: number;
  agreed_usd: number;
  ceiling_usd: number;
}

export interface OpeningPctEstimate {
  /** Opening offer as a fraction of ceiling, clamped to [0,1]. */
  opening_pct: number;
  method: 'cold_start' | 'rl';
  /** 0-1 trust in the learned signal (rl-pricing sample-size confidence). */
  confidence: number;
  /** Learned price↔output equilibrium as a fraction of ceiling. null cold-start. */
  equilibrium_pct: number | null;
  /** Deterministic pricing-engine prior fraction (cold-start baseline). */
  prior_pct: number;
  /** Signed nudge applied from the desired-vs-negotiated-price gap. */
  gap_adjustment_pct: number;
  sample_size: number;
  reason: string;
}

/** Below this many usable (cost, output) points, stay on the cold-start prior. */
export const RL_OPENING_MIN_SAMPLE = 5;
/** How far to move the opening toward where deals historically actually close. */
const GAP_LEARNING_RATE = 0.5;

/**
 * RL opening-offer estimator. Targets the price↔output equilibrium:
 *
 *   1. PRIOR (cold-start): the deterministic pricing-engine opening ÷ ceiling.
 *   2. EQUILIBRIUM (from history): the marginal-output sweet-spot cost ÷ ceiling
 *      — ride up the cost curve until output-per-dollar stops beating baseline.
 *   3. BLEND prior → equilibrium by rl-pricing's sample-size confidence (more
 *      outcome data ⇒ trust the learned equilibrium more).
 *   4. GAP CORRECTION: if deals historically CLOSE above where we OPENED, we've
 *      been opening too low → nudge up (and vice-versa), normalized to ceiling.
 *
 * Deterministic (no rng/clock). Cold-start when < RL_OPENING_MIN_SAMPLE points.
 * No fixed % is hardcoded; it falls out of pricing + RL.
 */
export function estimateOpeningPct(ctx: OpeningPctContext): OpeningPctEstimate {
  const ceiling = ctx.ceiling_usd;
  if (!(ceiling > 0)) {
    return {
      opening_pct: 0,
      method: 'cold_start',
      confidence: 0,
      equilibrium_pct: null,
      prior_pct: 0,
      gap_adjustment_pct: 0,
      sample_size: 0,
      reason: 'ceiling <= 0',
    };
  }

  // 1. Deterministic pricing-engine prior.
  const pricing = calculateInitialOffer({
    follower_count: ctx.follower_count,
    engagement_rate: ctx.engagement_rate,
    genre: ctx.genre,
    genre_premiums: ctx.genre_premiums,
    per_creator_cap_usd: ceiling,
    market_data: ctx.market_data,
  });
  const prior_pct = clampUnit(pricing.initial_offer_usd / ceiling);

  // Usable (cost, output) history for the equilibrium signal.
  const points: OutputPoint[] = (ctx.market_data ?? [])
    .filter(
      (m) =>
        m.payment_usd > 0 &&
        typeof m.streams_attributed === 'number' &&
        (m.streams_attributed as number) >= 0,
    )
    .map((m) => ({
      cost_usd: m.payment_usd,
      expected_output: m.streams_attributed as number,
    }));
  const sample_size = points.length;

  // Cold-start: too little history to learn → the prior stands.
  if (sample_size < RL_OPENING_MIN_SAMPLE) {
    return {
      opening_pct: prior_pct,
      method: 'cold_start',
      confidence: 0,
      equilibrium_pct: null,
      prior_pct,
      gap_adjustment_pct: 0,
      sample_size,
      reason: `cold_start: ${sample_size} < ${RL_OPENING_MIN_SAMPLE} history points`,
    };
  }

  // 2. Learned equilibrium = marginal-output sweet-spot cost ÷ ceiling.
  const idx = chooseSweetSpot(points);
  const equilibrium_pct =
    idx >= 0 ? clampUnit(points[idx].cost_usd / ceiling) : prior_pct;

  // 3. Blend prior → equilibrium by rl-pricing sample-size confidence.
  const confidence = predict(
    {
      follower_count: ctx.follower_count,
      payment_usd: pricing.initial_offer_usd,
      genre: ctx.genre,
      engagement_rate: ctx.engagement_rate ?? null,
    },
    points.map<OutcomeDatum>((p) => ({
      follower_count: ctx.follower_count,
      payment_usd: p.cost_usd,
      streams_attributed: p.expected_output,
    })),
  ).confidence;
  let pct = (1 - confidence) * prior_pct + confidence * equilibrium_pct;

  // 4. Desired-vs-negotiated-price gap correction.
  let gap_adjustment_pct = 0;
  const hist = (ctx.negotiation_history ?? []).filter((h) => h.ceiling_usd > 0);
  if (hist.length > 0) {
    const meanGap =
      hist.reduce(
        (s, h) => s + (h.agreed_usd - h.opening_usd) / h.ceiling_usd,
        0,
      ) / hist.length;
    gap_adjustment_pct = GAP_LEARNING_RATE * meanGap;
    pct += gap_adjustment_pct;
  }

  return {
    opening_pct: clampUnit(pct),
    method: 'rl',
    confidence,
    equilibrium_pct,
    prior_pct,
    gap_adjustment_pct,
    sample_size,
    reason: `rl: prior ${prior_pct.toFixed(3)} → equilibrium ${equilibrium_pct.toFixed(
      3,
    )} @ conf ${confidence.toFixed(2)}${
      hist.length
        ? `; gap ${gap_adjustment_pct >= 0 ? '+' : ''}${gap_adjustment_pct.toFixed(3)}`
        : ''
    }`,
  };
}

// ── Per-campaign + firm rollup ───────────────────────────────────────────────

export interface CampaignAnalyticsInput {
  campaign: AnalyticsCampaignRow;
  offers: AnalyticsOfferRow[];
  outcomes: AnalyticsOutcomeRow[];
  outreach: AnalyticsOutreachRow[];
  inbound: AnalyticsInboundRow[];
  /** creator_offer_id → verified post impressions (deal_performance_snapshots). */
  reachByOffer: Map<string, number>;
}

export interface CampaignAnalytics {
  campaign_id: string;
  artist_name: string | null;
  status: string | null;
  conversion: ConversionMetrics;
  deals: DealMetrics;
  spend: SpendMetrics;
  roi: RoiMetrics;
  cpm: CpmMetrics;
  rl: {
    /** Mean of the RL-set opening_pct persisted on this campaign's offers. */
    opening_pct_avg: number | null;
    /** How many measured outcomes feed the RL loop for this campaign. */
    outcomes_sample: number;
  };
  per_creator: PerCreatorRow[];
}

export function computeCampaignAnalytics(
  input: CampaignAnalyticsInput,
): CampaignAnalytics {
  const { campaign, offers, outcomes, outreach, inbound, reachByOffer } = input;

  const openingPcts = offers
    .map((o) => o.opening_pct)
    .filter((p): p is number => p != null && Number.isFinite(p));
  const opening_pct_avg =
    openingPcts.length > 0
      ? openingPcts.reduce((s, p) => s + p, 0) / openingPcts.length
      : null;

  return {
    campaign_id: campaign.id,
    artist_name: campaign.artist_name ?? null,
    status: campaign.status ?? null,
    conversion: computeConversion(outreach, inbound),
    deals: computeDeals(offers),
    spend: computeSpend(offers, campaign),
    roi: computeOutputPerDollar(offers, outcomes),
    cpm: computeCpm(offers, reachByOffer),
    rl: {
      opening_pct_avg,
      outcomes_sample: outcomes.filter((o) => o.creator_offer_id != null).length,
    },
    per_creator: computePerCreator(offers, outcomes),
  };
}

export interface FirmAnalytics {
  campaigns_count: number;
  conversion: ConversionMetrics;
  deals: DealMetrics;
  spend: {
    budget_usd: number | null;
    spend_committed_usd: number;
    spend_paid_usd: number;
    remaining_usd: number | null;
    consumed_pct: number | null;
  };
  roi: RoiMetrics;
  cpm: CpmMetrics;
}

/**
 * Firm-level rollup: additive over all the firm's campaigns, with the ratio
 * metrics (conversion, ROI, CPM, consumed %) recomputed from the summed
 * numerators/denominators — never averaged-of-averages.
 */
export function computeFirmRollup(campaigns: CampaignAnalytics[]): FirmAnalytics {
  const sum = (f: (c: CampaignAnalytics) => number) =>
    campaigns.reduce((s, c) => s + f(c), 0);

  const creators_sent = sum((c) => c.conversion.creators_sent);
  const creators_replied = sum((c) => c.conversion.creators_replied);
  const messages_sent = sum((c) => c.conversion.messages_sent);

  const total_output = sum((c) => c.roi.total_output);
  const output_spend_usd = round2(sum((c) => c.roi.output_spend_usd));

  const delivered_reach = sum((c) => c.cpm.delivered_reach);
  const cpm_spend = round2(sum((c) => c.cpm.spend_usd));

  const spend_committed_usd = round2(sum((c) => c.spend.spend_committed_usd));
  const spend_paid_usd = round2(sum((c) => c.spend.spend_paid_usd));
  const hasBudget = campaigns.some((c) => c.spend.budget_usd != null);
  const budget_usd = hasBudget
    ? round2(sum((c) => c.spend.budget_usd ?? 0))
    : null;
  const remaining_usd = budget_usd != null ? round2(budget_usd - spend_committed_usd) : null;

  return {
    campaigns_count: campaigns.length,
    conversion: {
      creators_sent,
      creators_replied,
      messages_sent,
      response_conversion_rate:
        creators_sent > 0 ? creators_replied / creators_sent : null,
    },
    deals: {
      offers_total: sum((c) => c.deals.offers_total),
      deals_closed: sum((c) => c.deals.deals_closed),
      paid_count: sum((c) => c.deals.paid_count),
      delivered_count: sum((c) => c.deals.delivered_count),
      rejected_count: sum((c) => c.deals.rejected_count),
    },
    spend: {
      budget_usd,
      spend_committed_usd,
      spend_paid_usd,
      remaining_usd,
      consumed_pct:
        budget_usd != null && budget_usd > 0
          ? clampUnit(spend_committed_usd / budget_usd)
          : null,
    },
    roi: {
      total_output,
      output_spend_usd,
      output_per_dollar: output_spend_usd > 0 ? total_output / output_spend_usd : null,
    },
    cpm: {
      delivered_reach,
      spend_usd: cpm_spend,
      cpm_usd: delivered_reach > 0 ? cpm_spend / (delivered_reach / 1000) : null,
    },
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
