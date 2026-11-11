// src/lib/creator-performance.ts
//
// Per-creator per-deal quantification + cross-campaign rollup profile.
//
// PURE, DETERMINISTIC, TESTABLE — no DB, no I/O, no clock, no rng (the
// analytics.ts / stream-lift.ts contract verbatim). The route
// (/api/influencers/[id]/performance) does the firm-scoped reads and hands
// the rows in; tests/creator-performance.test.ts drives this with fixtures.
//
// What this module is allowed to claim, and what it refuses:
//
//   - Per-deal numbers are OBSERVATIONS of that deal: agreed price, rounds
//     to close, reply latency, delivered-vs-promised, verified post metrics
//     from deal_performance_snapshots, and cost-per-verified-view.
//   - streams/$ appears ONLY where campaign_outcomes carries a row for the
//     offer, and it always carries its attribution_method label. This module
//     never splits a campaign-level lift across creators — stream-lift.ts
//     establishes that per-creator causal stream attribution is not
//     identifiable, and nothing here re-derives it. An outcome row is a
//     recorded per-deal measurement (manual / Spotify-for-Artists / estimated
//     from views), not a causal inference made here.
//   - A missing number stays missing: cost-per-verified-view is null when no
//     verified views exist; verified metrics are null (never 0) when no
//     snapshot landed. Nulls are honest, zeros are claims.
//   - Cross-deal aggregates that would be trends are confidence-gated the
//     way correlation.ts gates factors: below PERF_MIN_SAMPLE (= 5, the
//     house RL_OPENING_MIN_SAMPLE / TIER_LOW constant) the rollup emits an
//     explicit `insufficient_data` status rather than a number.
//   - Synthetic ([SAMPLE]) campaigns are excluded here defensively even
//     though the route already excludes them at query time (fabricated
//     numbers never mix into a real profile).

import { DEALS_CLOSED_STATES } from './analytics';
import { spearman, confidenceForN, type Confidence } from './correlation';

/** Widened view of the analytics closed-deal set for plain-string checks. */
const CLOSED: readonly string[] = DEALS_CLOSED_STATES;

// ── Input row shapes (subsets of the live tables the route reads) ────────────

export interface PerfCampaignRow {
  id: string;
  artist_name: string | null;
  synthetic: boolean;
}

/** campaign_influencers rows for THIS influencer. */
export interface PerfCiRow {
  id: string;
  campaign_id: string;
}

export interface PerfOfferRow {
  id: string;
  campaign_id: string;
  campaign_influencer_id: string | null;
  status: string;
  initial_offer_usd: number | null;
  agreed_amount_usd: number | null;
  ceiling_usd: number | null;
  opening_pct: number | null;
  rounds: number | null;
  perceived_generosity: number | null;
  price_give_pct: number | null;
  /** jsonb — array of deliverable lines when a package was frozen. */
  agreed_deliverables: unknown;
  created_at: string;
}

export interface PerfOutreachRow {
  campaign_influencer_id: string | null;
  direction: string | null;
  status: string | null;
  sent_at: string | null;
}

export interface PerfInboundRow {
  campaign_influencer_id: string | null;
  received_at: string | null;
}

export interface PerfDeliveryRow {
  id: string;
  creator_offer_id: string;
  status: string; // pending | verified | missing
  spec_check: string | null; // pass | fail | partial | null
}

export interface PerfSnapshotRow {
  deal_delivery_id: string;
  captured_at: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

export interface PerfOutcomeRow {
  creator_offer_id: string | null;
  streams_attributed: number | null;
  streams_attribution_method: string | null;
  payment_usd_amount: number | null;
  measured_at: string | null;
}

export interface CreatorPerformanceInput {
  influencer_id: string;
  campaigns: PerfCampaignRow[];
  cis: PerfCiRow[];
  offers: PerfOfferRow[];
  outreach: PerfOutreachRow[];
  inbound: PerfInboundRow[];
  deliveries: PerfDeliveryRow[];
  snapshots: PerfSnapshotRow[];
  outcomes: PerfOutcomeRow[];
}

// ── Output shapes ────────────────────────────────────────────────────────────

export interface DealDeliverySummary {
  /** Lines in the frozen agreed_deliverables package; null when none agreed. */
  promised: number | null;
  deliveries_total: number;
  verified: number;
  pending: number;
  missing: number;
  spec: { pass: number; fail: number; partial: number; unchecked: number };
}

/** Sums of the latest snapshot per VERIFIED delivery. Null = never measured. */
export interface DealVerifiedMetrics {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

/** Present ONLY when campaign_outcomes has a row for this offer. */
export interface DealStreamOutcome {
  streams_attributed: number | null;
  /** manual | spotify_for_artists | estimated_from_views | unknown | … */
  attribution_method: string | null;
  /** streams ÷ spend. Null when either side is missing or spend ≤ 0. */
  streams_per_dollar: number | null;
  measured_at: string | null;
}

export interface CreatorDealRecord {
  offer_id: string;
  campaign_id: string;
  campaign_name: string | null;
  status: string;
  created_at: string;
  agreed_amount_usd: number | null;
  ceiling_usd: number | null;
  rounds: number | null;
  opening_pct: number | null;
  perceived_generosity: number | null;
  price_give_pct: number | null;
  /** First outbound send → first inbound reply on the deal's CI. Null until both exist. */
  reply_latency_ms: number | null;
  delivery: DealDeliverySummary;
  verified: DealVerifiedMetrics;
  /** outcome.payment_usd_amount ?? agreed_amount_usd (correlation.ts §5.1 precedence). */
  spend_usd: number | null;
  /** spend ÷ verified views. Null when no verified views or no spend figure — never fabricated. */
  cost_per_verified_view_usd: number | null;
  streams: DealStreamOutcome | null;
}

/** Below this many samples an aggregate refuses to state a number (house
 *  constant: RL_OPENING_MIN_SAMPLE in analytics.ts, TIER_LOW in correlation.ts). */
export const PERF_MIN_SAMPLE = 5;

export type GatedMetric =
  | { status: 'insufficient_data'; n: number; needed: number }
  | { status: 'ok'; n: number; value: number };

export type PriceTrend =
  | { status: 'insufficient_data'; n: number; needed: number }
  | {
      status: 'ok';
      n: number;
      direction: 'rising' | 'falling' | 'flat';
      spearman_rho: number | null;
    };

export interface CreatorRollup {
  deals_count: number;
  campaigns_count: number;
  /** CIs with ≥1 delivered outbound (status='sent'). Raw count — a fact. */
  contacted: number;
  /** Offers at/after 'agreed' (analytics DEALS_CLOSED_STATES). Raw count. */
  closed: number;
  /** Unique CIs with ≥1 closed offer — the close-rate numerator population. */
  closed_cis: number;
  /**
   * closed_cis ÷ engaged CIs, where engaged = contacted ∪ closed_cis. Both
   * sides count CIs (creator_offers.campaign_influencer_id is NOT unique, so
   * a re-negotiated CI with two closed offers must not read as 200%), and a
   * closed offer on a never-contacted CI joins the denominator too, so the
   * value is bounded [0,1] by construction. Gated at PERF_MIN_SAMPLE engaged
   * CIs like every other rollup aggregate; the raw counts above stay facts.
   */
  close_rate: GatedMetric;
  delivery: {
    /** Σ promised lines (falls back to deliveries_total when no package frozen). */
    expected: number;
    verified: number;
    /** verified ÷ expected, gated at PERF_MIN_SAMPLE expected lines. */
    reliability: GatedMetric;
  };
  median_reply_latency_ms: GatedMetric;
  median_cost_per_verified_view_usd: GatedMetric;
  /** Direction of agreed price over successive closed deals (offer-creation
   *  order — per-state close timestamps aren't persisted, so created_at is
   *  the deterministic proxy for deal sequence). */
  price_trend: PriceTrend;
  /** correlation.ts n-tier over the deal count — the profile's overall trust. */
  confidence: Confidence;
}

export interface CreatorPerformance {
  influencer_id: string;
  deals: CreatorDealRecord[];
  rollup: CreatorRollup;
}

// ── Small helpers ────────────────────────────────────────────────────────────

/** PostgREST numerics can arrive as strings; non-finite → unknown (null). */
function asNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Standard median. Callers gate on n themselves. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function gate(values: number[]): GatedMetric {
  const n = values.length;
  if (n < PERF_MIN_SAMPLE) {
    return { status: 'insufficient_data', n, needed: PERF_MIN_SAMPLE };
  }
  // n ≥ 5 > 0, so median() cannot return null here.
  return { status: 'ok', n, value: median(values) as number };
}

/** A ratio whose sample size is its denominator; refused below the gate. */
function gateRatio(numerator: number, denominator: number): GatedMetric {
  if (denominator < PERF_MIN_SAMPLE) {
    return { status: 'insufficient_data', n: denominator, needed: PERF_MIN_SAMPLE };
  }
  return { status: 'ok', n: denominator, value: numerator / denominator };
}

/** agreed_deliverables jsonb → line count; null when absent/not an array. */
export function promisedLineCount(agreed: unknown): number | null {
  return Array.isArray(agreed) ? agreed.length : null;
}

// ── Reply latency: first outbound send → first inbound reply, per CI ─────────

/**
 * Latency from the first DELIVERED outbound (status='sent' with a parseable
 * sent_at) to the first inbound received at-or-after it. Null when either
 * side is missing. A reply that predates the first send (imported history)
 * does not count — the question is "how fast do they answer us".
 */
export function replyLatencyByCi(
  outreach: PerfOutreachRow[],
  inbound: PerfInboundRow[],
): Map<string, number> {
  const firstSent = new Map<string, number>();
  for (const m of outreach) {
    if (m.direction !== 'outbound' || m.status !== 'sent' || !m.campaign_influencer_id) continue;
    const t = parseMs(m.sent_at);
    if (t == null) continue;
    const cur = firstSent.get(m.campaign_influencer_id);
    if (cur == null || t < cur) firstSent.set(m.campaign_influencer_id, t);
  }

  const firstReplyAfter = new Map<string, number>();
  for (const r of inbound) {
    if (!r.campaign_influencer_id) continue;
    const sent = firstSent.get(r.campaign_influencer_id);
    if (sent == null) continue;
    const t = parseMs(r.received_at);
    if (t == null || t < sent) continue;
    const cur = firstReplyAfter.get(r.campaign_influencer_id);
    if (cur == null || t < cur) firstReplyAfter.set(r.campaign_influencer_id, t);
  }

  const out = new Map<string, number>();
  for (const [ci, replyAt] of firstReplyAfter) {
    out.set(ci, replyAt - (firstSent.get(ci) as number));
  }
  return out;
}

// ── Latest snapshot per delivery ─────────────────────────────────────────────

/** deal_delivery_id → its newest snapshot (max captured_at; ties → later id order irrelevant, first max wins). */
function latestSnapshotByDelivery(
  snapshots: PerfSnapshotRow[],
): Map<string, PerfSnapshotRow> {
  const latest = new Map<string, { at: number; row: PerfSnapshotRow }>();
  for (const s of snapshots) {
    const at = parseMs(s.captured_at) ?? 0;
    const cur = latest.get(s.deal_delivery_id);
    if (!cur || at > cur.at) latest.set(s.deal_delivery_id, { at, row: s });
  }
  return new Map([...latest.entries()].map(([k, v]) => [k, v.row]));
}

/** Sum nullable metrics: null only when EVERY contributing value is null. */
function sumNullable(values: Array<number | null>): number | null {
  let sum = 0;
  let seen = false;
  for (const v of values) {
    if (v == null) continue;
    sum += v;
    seen = true;
  }
  return seen ? sum : null;
}

// ── Price trend over closed deals ────────────────────────────────────────────

/**
 * Direction of the agreed price across successive closed deals, in
 * offer-creation order (created_at ascending — per-state close timestamps
 * are not persisted, so creation order is the deterministic proxy for deal
 * sequence). Spearman ρ of (sequence index, price) with
 * the same t ≥ 2.0 gate correlation.ts uses; below PERF_MIN_SAMPLE closed
 * deals the trend is refused outright. ρ null (constant prices) → 'flat'.
 */
export function computePriceTrend(
  closedPricesInOrder: number[],
): PriceTrend {
  const n = closedPricesInOrder.length;
  if (n < PERF_MIN_SAMPLE) {
    return { status: 'insufficient_data', n, needed: PERF_MIN_SAMPLE };
  }
  const xs = closedPricesInOrder.map((_, i) => i);
  const rho = spearman(xs, closedPricesInOrder);
  let direction: 'rising' | 'falling' | 'flat' = 'flat';
  if (rho != null && rho !== 0) {
    const r2 = rho * rho;
    const t = r2 >= 1 ? Infinity : Math.abs(rho) * Math.sqrt((n - 2) / (1 - r2));
    if (t >= 2.0) direction = rho > 0 ? 'rising' : 'falling';
  }
  return { status: 'ok', n, direction, spearman_rho: rho };
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function computeCreatorPerformance(
  input: CreatorPerformanceInput,
): CreatorPerformance {
  // Synthetic campaigns never enter a real profile (defense in depth — the
  // route already filters .eq('synthetic', false)).
  const realCampaigns = input.campaigns.filter((c) => !c.synthetic);
  const campaignById = new Map(realCampaigns.map((c) => [c.id, c]));

  const cis = input.cis.filter((ci) => campaignById.has(ci.campaign_id));
  const ciIds = new Set(cis.map((ci) => ci.id));

  const offers = input.offers.filter(
    (o) =>
      campaignById.has(o.campaign_id) &&
      (o.campaign_influencer_id == null || ciIds.has(o.campaign_influencer_id)),
  );

  const latencyByCi = replyLatencyByCi(
    input.outreach.filter((m) => m.campaign_influencer_id != null && ciIds.has(m.campaign_influencer_id)),
    input.inbound.filter((m) => m.campaign_influencer_id != null && ciIds.has(m.campaign_influencer_id)),
  );

  const offerIds = new Set(offers.map((o) => o.id));
  const deliveriesByOffer = new Map<string, PerfDeliveryRow[]>();
  for (const d of input.deliveries) {
    if (!offerIds.has(d.creator_offer_id)) continue;
    const list = deliveriesByOffer.get(d.creator_offer_id) ?? [];
    list.push(d);
    deliveriesByOffer.set(d.creator_offer_id, list);
  }
  const snapByDelivery = latestSnapshotByDelivery(input.snapshots);

  const outcomeByOffer = new Map<string, PerfOutcomeRow>();
  for (const oc of input.outcomes) {
    if (oc.creator_offer_id != null && offerIds.has(oc.creator_offer_id)) {
      outcomeByOffer.set(oc.creator_offer_id, oc);
    }
  }

  // ── Per-deal records ───────────────────────────────────────────────────────
  const deals: CreatorDealRecord[] = offers.map((o) => {
    const campaign = campaignById.get(o.campaign_id);
    const dels = deliveriesByOffer.get(o.id) ?? [];

    const spec = { pass: 0, fail: 0, partial: 0, unchecked: 0 };
    let verifiedCount = 0;
    let pendingCount = 0;
    let missingCount = 0;
    const verifiedSnaps: PerfSnapshotRow[] = [];
    for (const d of dels) {
      if (d.status === 'verified') {
        verifiedCount += 1;
        const snap = snapByDelivery.get(d.id);
        if (snap) verifiedSnaps.push(snap);
      } else if (d.status === 'missing') {
        missingCount += 1;
      } else {
        pendingCount += 1;
      }
      if (d.spec_check === 'pass') spec.pass += 1;
      else if (d.spec_check === 'fail') spec.fail += 1;
      else if (d.spec_check === 'partial') spec.partial += 1;
      else spec.unchecked += 1;
    }

    const verified: DealVerifiedMetrics = {
      views: sumNullable(verifiedSnaps.map((s) => asNum(s.views))),
      likes: sumNullable(verifiedSnaps.map((s) => asNum(s.likes))),
      comments: sumNullable(verifiedSnaps.map((s) => asNum(s.comments))),
      shares: sumNullable(verifiedSnaps.map((s) => asNum(s.shares))),
    };

    const outcome = outcomeByOffer.get(o.id) ?? null;
    const agreed = asNum(o.agreed_amount_usd);
    const spend = asNum(outcome?.payment_usd_amount) ?? agreed;

    // Cost per verified view: only when verified views exist AND a spend
    // figure exists. spend 0 with real views → honest $0.00 per view.
    const cost_per_verified_view_usd =
      verified.views != null && verified.views > 0 && spend != null
        ? spend / verified.views
        : null;

    let streams: DealStreamOutcome | null = null;
    if (outcome) {
      const attributed = asNum(outcome.streams_attributed);
      streams = {
        streams_attributed: attributed,
        attribution_method: outcome.streams_attribution_method ?? null,
        streams_per_dollar:
          attributed != null && spend != null && spend > 0 ? attributed / spend : null,
        measured_at: outcome.measured_at ?? null,
      };
    }

    return {
      offer_id: o.id,
      campaign_id: o.campaign_id,
      campaign_name: campaign?.artist_name ?? null,
      status: o.status,
      created_at: o.created_at,
      agreed_amount_usd: agreed,
      ceiling_usd: asNum(o.ceiling_usd),
      rounds: asNum(o.rounds),
      opening_pct: asNum(o.opening_pct),
      perceived_generosity: asNum(o.perceived_generosity),
      price_give_pct: asNum(o.price_give_pct),
      reply_latency_ms:
        o.campaign_influencer_id != null
          ? latencyByCi.get(o.campaign_influencer_id) ?? null
          : null,
      delivery: {
        promised: promisedLineCount(o.agreed_deliverables),
        deliveries_total: dels.length,
        verified: verifiedCount,
        pending: pendingCount,
        missing: missingCount,
        spec,
      },
      verified,
      spend_usd: spend,
      cost_per_verified_view_usd,
      streams,
    };
  });

  // Newest first, deterministic tiebreak on offer id.
  deals.sort((a, b) =>
    a.created_at === b.created_at
      ? a.offer_id < b.offer_id
        ? -1
        : 1
      : a.created_at < b.created_at
        ? 1
        : -1,
  );

  // ── Cross-deal rollup ──────────────────────────────────────────────────────
  const contactedCis = new Set<string>();
  for (const m of input.outreach) {
    if (
      m.direction === 'outbound' &&
      m.status === 'sent' &&
      m.campaign_influencer_id != null &&
      ciIds.has(m.campaign_influencer_id)
    ) {
      contactedCis.add(m.campaign_influencer_id);
    }
  }
  // Closed as an offer count (a fact) AND as unique CIs (the rate's
  // numerator population — one creator re-negotiated twice is one close).
  let closed = 0;
  const closedCis = new Set<string>();
  for (const o of offers) {
    if (!CLOSED.includes(o.status)) continue;
    closed += 1;
    if (o.campaign_influencer_id != null) closedCis.add(o.campaign_influencer_id);
  }
  // Engaged = contacted ∪ closed: a closed offer on a never-contacted CI
  // (manual quick-offer path) enters BOTH sides, so the rate stays in [0,1].
  const engagedCis = new Set([...contactedCis, ...closedCis]);

  let deliveryExpected = 0;
  let deliveryVerified = 0;
  for (const d of deals) {
    // The promised package is the contract; deliveries observed is the
    // fallback denominator when no package was frozen on the offer.
    const expected = d.delivery.promised ?? d.delivery.deliveries_total;
    if (expected <= 0) continue;
    deliveryExpected += expected;
    deliveryVerified += Math.min(d.delivery.verified, expected);
  }

  const latencies = deals
    .map((d) => d.reply_latency_ms)
    .filter((v): v is number => v != null);
  const cpvs = deals
    .map((d) => d.cost_per_verified_view_usd)
    .filter((v): v is number => v != null);

  // Closed deals with a price, in offer-creation order (created_at ascending).
  const closedPrices = [...deals]
    .filter(
      (d) => d.agreed_amount_usd != null && CLOSED.includes(d.status),
    )
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    .map((d) => d.agreed_amount_usd as number);

  const rollup: CreatorRollup = {
    deals_count: deals.length,
    campaigns_count: new Set(deals.map((d) => d.campaign_id)).size,
    contacted: contactedCis.size,
    closed,
    closed_cis: closedCis.size,
    close_rate: gateRatio(closedCis.size, engagedCis.size),
    delivery: {
      expected: deliveryExpected,
      verified: deliveryVerified,
      reliability: gateRatio(deliveryVerified, deliveryExpected),
    },
    median_reply_latency_ms: gate(latencies),
    median_cost_per_verified_view_usd: gate(cpvs),
    price_trend: computePriceTrend(closedPrices),
    confidence: confidenceForN(deals.length),
  };

  return { influencer_id: input.influencer_id, deals, rollup };
}
