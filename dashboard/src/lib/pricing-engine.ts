// src/lib/pricing-engine.ts
//
// Pricing engine that converts a creator profile + campaign caps into
// an initial-offer dollar amount + rationale. Designed to be swapped out
// for an RL model once outcome data accumulates — for now it's a
// deterministic, transparent, easy-to-debug formula.
//
// Tiers:
//   - micro/nano-influencers (sub-50k) — emphasize value, $50-$100 range
//   - mid-tier (50k-250k) — sweet spot, ~$250
//   - large (250k-1M+) — $500+ but discouraged for micro-creator campaigns
// Per-creator cap is the hard ceiling set at campaign-create. Initial
// offer is always min(formula, cap).

import {
  PROMO_WEIGHT,
  TIME_BASED_DEFAULT_SECONDS,
  checkPackageAgainstSpec,
  describeSpecViolations,
  type Deliverable,
  type DeliverableSpec,
  type SpecViolation,
} from './deliverables';
import { DEFAULT_GENRE_PREMIUMS, genrePremium } from './genre-config';

export type CreatorTier = 'nano' | 'micro' | 'mid' | 'large';

export interface PricingInputs {
  follower_count: number;
  engagement_rate: number;          // 0-1, e.g. 0.045 = 4.5%
  genre?: string | null;            // for genre premium
  /**
   * Per-firm genre premium table (firms.scraping_prefs.genre_premiums).
   * Omitted → DEFAULT_GENRE_PREMIUMS, which is empty, i.e. genre-neutral.
   * Never hardcode genres here; see src/lib/genre-config.ts.
   */
  genre_premiums?: Readonly<Record<string, number>>;
  per_creator_cap_usd: number;      // hard ceiling
  market_data?: MarketDataPoint[];  // optional historical signals (RL hook)
  /** Selects the engagement calibration. Omitted = TikTok (see engagementMultiplier). */
  platform?: string | null;
}

export interface MarketDataPoint {
  follower_count: number;
  engagement_rate: number;
  payment_usd: number;
  streams_attributed: number | null;
  genre?: string | null;
}

export interface PricingResult {
  initial_offer_usd: number;
  ceiling_usd: number;
  tier: CreatorTier;
  rationale: string;
  inputs_snapshot: PricingInputs;   // persisted alongside the offer
}

interface TierConfig {
  name: CreatorTier;
  follower_max: number;             // strict <
  base_usd: number;
}

const TIER_TABLE: TierConfig[] = [
  { name: 'nano',  follower_max: 10_000,    base_usd: 50 },
  { name: 'micro', follower_max: 50_000,    base_usd: 100 },
  { name: 'mid',   follower_max: 250_000,   base_usd: 250 },
  { name: 'large', follower_max: Infinity,  base_usd: 500 },
];

// Clamp helper — defensive against weird engagement values from scraped data.
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// ── Engagement multiplier ───────────────────────────────────────────────────
//
// WHAT IT WAS: clamp(0.7 + ER/0.05, 0.7, 1.5). The comment above it said
// "5% → 1.0x", but the code gives 0.7 + 1.0 = 1.7 → 1.5x at 5%. It hit the
// 1.5x ceiling at 4% ER, while a typical TikTok median is around 8%, so most
// TikTok creators got the maximum. Offers barely varied with engagement.
//
// WHAT IT IS: a monotonic curve, piecewise-linear in log(ER), anchored to an
// engagement distribution:
//   p10 → 0.75x · p50 → 1.0x · p90 → 1.4x
// Below p10 it continues the same slope down to a 0.7x floor. At and above
// p90 it holds at 1.4x. It is still clamped, and the result is still
// × tier base × genre and then min()'d against the per-creator cap. No
// ceiling, trigger, or pacing rule is touched.
//
// CALIBRATION: illustrative default percentiles for a micro-creator TikTok
// pool, not tuned to any particular deployment:
//   tiktok  p10=0.02214  p50=0.0813  p90=0.17711
// No other platform ships with anchors. A platform with no
// calibration keeps the linear curve below rather than borrowing
// TikTok's anchors: Instagram ER usually runs lower, and pricing an unmeasured
// platform off TikTok's distribution would be a guess. An UNKNOWN platform
// (callers that don't carry one) uses TikTok's anchors, because TikTok is the
// only calibrated platform. Compute these percentiles from your own
// influencers.engagement_rate (synthetic = false) and update the constants.
export const ENGAGEMENT_MULTIPLIER_FLOOR = 0.7;
export const ENGAGEMENT_MULTIPLIER_CAP = 1.4;

export interface EngagementCalibration {
  p10: number;
  p50: number;
  p90: number;
}

export const ENGAGEMENT_CALIBRATION: Readonly<Record<string, EngagementCalibration>> = {
  tiktok: { p10: 0.02214, p50: 0.0813, p90: 0.17711 },
};

/** The anchors for a platform. undefined = no measured sample (legacy curve). */
export function engagementCalibrationFor(
  platform?: string | null,
): EngagementCalibration | undefined {
  const key = (platform ?? '').trim().toLowerCase();
  if (key === '') return ENGAGEMENT_CALIBRATION.tiktok;
  return ENGAGEMENT_CALIBRATION[key];
}

/** The linear curve. Only for platforms with no measured sample. */
function legacyEngagementMultiplier(engagement_rate: number): number {
  return clamp(0.7 + engagement_rate / 0.05, 0.7, 1.5);
}

export function engagementMultiplier(
  engagement_rate: number,
  platform?: string | null,
): number {
  const cal = engagementCalibrationFor(platform);
  const er = Number(engagement_rate);
  if (!cal) return legacyEngagementMultiplier(Number.isFinite(er) ? er : 0);
  if (!Number.isFinite(er) || er <= 0) return ENGAGEMENT_MULTIPLIER_FLOOR;
  const x = Math.log(er);
  const l10 = Math.log(cal.p10);
  const l50 = Math.log(cal.p50);
  const l90 = Math.log(cal.p90);
  const m =
    x <= l50
      ? 0.75 + (0.25 * (x - l10)) / (l50 - l10)
      : 1.0 + (0.4 * (x - l50)) / (l90 - l50);
  return clamp(m, ENGAGEMENT_MULTIPLIER_FLOOR, ENGAGEMENT_MULTIPLIER_CAP);
}

// Genre premium: CONFIGURATION, not a literal.
//
// A hardcoded genre list here would apply one label's genres to every tenant.
// The table arrives from the firm (`firms.scraping_prefs.genre_premiums`) and
// defaults to EMPTY, i.e. genre-neutral. See src/lib/genre-config.ts.
function genreMultiplier(
  genre?: string | null,
  premiums: Readonly<Record<string, number>> = DEFAULT_GENRE_PREMIUMS
): number {
  return genrePremium(genre, premiums);
}

export function pickTier(follower_count: number): CreatorTier {
  for (const t of TIER_TABLE) {
    if (follower_count < t.follower_max) return t.name;
  }
  return 'large';
}

/** Tier base dollars for a follower count (TIER_TABLE lookup). The norm that
 *  perceived_generosity is measured against. */
export function tierBaseUsd(follower_count: number): number {
  return TIER_TABLE.find((t) => follower_count < t.follower_max)!.base_usd;
}

export function calculateInitialOffer(input: PricingInputs): PricingResult {
  const tier = TIER_TABLE.find((t) => input.follower_count < t.follower_max)!;
  const eng = engagementMultiplier(input.engagement_rate, input.platform);
  const gen = genreMultiplier(input.genre, input.genre_premiums ?? DEFAULT_GENRE_PREMIUMS);

  // Round to the nearest dollar — clean numbers in proposals build trust
  // more than fake-precision $173.42 offers.
  const formulaOffer = Math.round(tier.base_usd * eng * gen);
  const cappedOffer = Math.min(formulaOffer, input.per_creator_cap_usd);

  const rationale = [
    `Tier=${tier.name} (${input.follower_count.toLocaleString()} followers, base $${tier.base_usd})`,
    `engagement=${(input.engagement_rate * 100).toFixed(2)}% → ${eng.toFixed(2)}x`,
    `genre=${input.genre ?? 'unspecified'} → ${gen.toFixed(2)}x`,
    `formula=$${formulaOffer}, capped at $${input.per_creator_cap_usd} → $${cappedOffer}`,
  ].join('; ');

  return {
    initial_offer_usd: cappedOffer,
    ceiling_usd: input.per_creator_cap_usd,
    tier: tier.name,
    rationale,
    inputs_snapshot: input,
  };
}

// Decision returned by the counter-offer evaluator. The caller (negotiation
// state machine) uses this to decide which transition to fire.
export type CounterDecision =
  | { action: 'accept'; agreed_amount_usd: number; reason: string }
  | { action: 'counter'; new_offer_usd: number; reason: string }
  | { action: 'reject'; reason: string };

export interface CounterEvalInputs {
  current_offer_usd: number;        // what we last offered
  counter_offer_usd: number;        // what the creator counter-proposed
  ceiling_usd: number;              // hard cap
  rounds: number;                   // how many round-trips so far
  max_rounds?: number;              // default 3
  /**
   * RATCHET FLOOR — the HIGHEST amount already communicated to this creator.
   * Defaults to current_offer_usd (the last offer) when the caller doesn't
   * track a high-water mark. See applyCounterRatchet.
   */
  standing_offer_usd?: number;
}

// ── The ratchet invariant ───────────────────────────────────────────────────
//
// A COUNTER MUST NEVER QUOTE LESS THAN THE HIGHEST AMOUNT WE HAVE ALREADY PUT
// IN FRONT OF THAT CREATOR.
//
// Example of the failure: we offer $165, the creator asks $240 while
// narrowing the package to one TikTok, and the term-trade value model re-prices
// the smaller package down to $126 and quotes it. Every individual step is
// defensible; the composite reads as a mistake or as bad faith, and anyone
// reading the thread catches it instantly.
//
// THE ONE EXCEPTION — a genuine scope reduction the creator has not repriced
// upward. If the package strictly shrank AND the creator is not asking for MORE
// than our standing number, the number may come down with it (the counter copy
// then has to name what was removed; see negotiation-tick.ts). A creator who
// narrows the scope while asking for more money is not proposing a smaller
// deal: the scope change is their justification for a HIGHER number, not a
// discount we get to bank. So our standing number stays the floor.
//
// Consequence worth stating plainly: asking $170 against our $165 gets a $165
// counter while asking $150 can get the value-fair $126. That asymmetry is
// deliberate, not an oversight — it is the difference between a creator
// conceding scope and a creator repricing upward, and it is the behavior a
// human negotiator would show. No creator ever observes both branches.
//
// THE RATCHET IS A FLOOR; THE CEILING IS A CEILING. When they cross, the
// ceiling wins and the engine REFUSES — it never quotes a number it cannot
// honor. The per-creator ceiling, the effective ceiling (which subtracts
// committed campaign budget), the DB CHECKs current_within_ceiling /
// agreed_within_ceiling and spend-caps.ts are all untouched by this.

export interface RatchetInputs {
  /** Highest amount already communicated to this creator (0 = nothing yet). */
  standing_offer_usd: number;
  /** EFFECTIVE ceiling: per-creator ceiling ∧ remaining campaign budget. */
  ceiling_usd: number;
  /** The creator's own named price this round; null when they named none. */
  asked_usd: number | null;
  /** True when the package this counter is for is strictly smaller in effort
   *  units than the package the standing number was quoted for. */
  package_reduced: boolean;
}

/**
 * The lowest whole-dollar amount a counter is allowed to quote. 0 means "no
 * floor" — either nothing has been communicated yet, or the scope-reduction
 * exception applies and the value model may price the smaller package freely.
 */
export function counterFloorUsd(input: RatchetInputs): number {
  const standing = Math.round(Number(input.standing_offer_usd) || 0);
  if (!(standing > 0)) return 0;
  const askingMore = input.asked_usd != null && Number(input.asked_usd) > standing;
  if (input.package_reduced && !askingMore) return 0;
  return standing;
}

export type RatchetResult =
  | { ok: true; amount: number }
  | { ok: false; floor_usd: number; ceiling_usd: number; reason: string };

/**
 * Bring a computed counter amount inside [floor, ceiling]. Raises a backwards
 * quote up to the ratchet floor and preserves the existing downward ceiling
 * clamp verbatim. When the floor sits above the ceiling there is no honest
 * number to send, so this REFUSES and the caller must reject the negotiation
 * rather than quote the ceiling (which would be below our standing offer) or
 * the floor (which would breach the cap).
 */
export function applyCounterRatchet(quoted: number, input: RatchetInputs): RatchetResult {
  const floor = counterFloorUsd(input);
  const ceiling = Math.floor(Number(input.ceiling_usd) || 0);
  if (floor > ceiling) {
    return {
      ok: false,
      floor_usd: floor,
      ceiling_usd: ceiling,
      reason:
        `cannot counter: our standing offer of $${floor} is already above the ` +
        `effective ceiling $${ceiling}, and quoting below $${floor} would go ` +
        `backwards on a number this creator has already seen`,
    };
  }
  return { ok: true, amount: Math.min(Math.max(Math.round(quoted), floor), ceiling) };
}

// Counter-offer logic — intentionally simple + rule-based for v1:
//   1. Counter ≤ current → accept (creator going down, fine)
//   2. Counter ≤ ceiling → accept
//   3. Counter > ceiling AND rounds < max_rounds → counter at midpoint
//      between current and ceiling
//   4. Counter > ceiling AND rounds >= max_rounds → reject
// Future: replace rule (3) with an RL policy that uses follower_count +
// genre + historical reply→close rate to decide whether to push.
export function evaluateCounter(input: CounterEvalInputs): CounterDecision {
  const max = input.max_rounds ?? 3;

  if (input.counter_offer_usd <= input.current_offer_usd) {
    return {
      action: 'accept',
      agreed_amount_usd: input.counter_offer_usd,
      reason: `creator counter ($${input.counter_offer_usd}) is at or below our last offer ($${input.current_offer_usd}); accepting`,
    };
  }
  if (input.counter_offer_usd <= input.ceiling_usd) {
    return {
      action: 'accept',
      agreed_amount_usd: input.counter_offer_usd,
      reason: `creator counter ($${input.counter_offer_usd}) within ceiling ($${input.ceiling_usd}); accepting`,
    };
  }
  if (input.rounds >= max) {
    return {
      action: 'reject',
      reason: `creator counter ($${input.counter_offer_usd}) exceeds ceiling ($${input.ceiling_usd}); reached max rounds (${max})`,
    };
  }
  // Midpoint between our last offer and the ceiling — "best and final"
  // posture without conceding the cap.
  //
  // The midpoint goes BACKWARDS whenever the effective ceiling has fallen below
  // our own last offer (committed campaign budget eats the headroom):
  // (165 + 50) / 2 = $108 after we had already offered $165. The ratchet
  // catches it on the price-only branch too — this is not a term-trade-only
  // bug. A price-only round never changes the package, so there is no scope
  // reduction to license a lower number.
  const midpoint = Math.round((input.current_offer_usd + input.ceiling_usd) / 2);
  const ratchet = applyCounterRatchet(midpoint, {
    standing_offer_usd: input.standing_offer_usd ?? input.current_offer_usd,
    ceiling_usd: input.ceiling_usd,
    asked_usd: input.counter_offer_usd,
    package_reduced: false,
  });
  if (!ratchet.ok) return { action: 'reject', reason: ratchet.reason };
  return {
    action: 'counter',
    new_offer_usd: ratchet.amount,
    reason:
      ratchet.amount === midpoint
        ? `creator counter ($${input.counter_offer_usd}) above ceiling ($${input.ceiling_usd}); counter at midpoint ($${midpoint}), round ${input.rounds + 1}/${max}`
        : `creator counter ($${input.counter_offer_usd}) above ceiling ($${input.ceiling_usd}); midpoint $${midpoint} would go below our standing offer, holding at $${ratchet.amount}, round ${input.rounds + 1}/${max}`,
  };
}

// ── Term-trade value model ──────────────────────────────────────────────────
//
// When a reply renegotiates the PACKAGE ("one 30s reel but no story"), price
// alone can't judge the trade. This deterministic model values a bundle in
// effort units — Σ PROMO_WEIGHT × quantity × length-factor — and prices the
// proposed package proportionally against what we're paying for the current
// one:
//
//   fair  = round(current_offer × value(proposed) / value(current))
//   limit = min(fair, floor(effective ceiling))
//
// A REDUCED package therefore reduces the acceptable price proportionally; an
// INCREASED package may justify more, but never above the ceiling (per-creator
// ∧ remaining campaign budget — the caller passes the effective ceiling, and
// the DB CHECK backs it structurally). Transparent and easy to debug, same
// philosophy as calculateInitialOffer; an RL policy can replace it later.

/** Video length scales value linearly vs the type's default length, clamped so
 *  an extreme stated length can't distort the trade more than 2x either way. */
export const LENGTH_FACTOR_MIN = 0.5;
export const LENGTH_FACTOR_MAX = 2.0;

/** Effort-units value of one deliverable line: weight × quantity × length factor. */
export function deliverableValueUnits(d: Deliverable): number {
  const base = PROMO_WEIGHT[d.promo_type] * d.quantity;
  const defaultSeconds = TIME_BASED_DEFAULT_SECONDS[d.promo_type];
  if (!defaultSeconds || d.min_seconds == null) return base;
  return base * clamp(d.min_seconds / defaultSeconds, LENGTH_FACTOR_MIN, LENGTH_FACTOR_MAX);
}

/** Effort-units value of a bundle — the term-trade comparison currency. */
export function bundleValueUnits(deliverables: Deliverable[]): number {
  return deliverables.reduce((sum, d) => sum + deliverableValueUnits(d), 0);
}

export interface TermTradeInputs {
  current_offer_usd: number;          // what we last offered, for the CURRENT package
  counter_usd: number | null;         // creator's asked price for the proposed package (null = unnamed)
  ceiling_usd: number;                // EFFECTIVE ceiling (per-creator ∧ remaining budget)
  rounds: number;                     // round-trips so far
  max_rounds?: number;                // default 3
  current_deliverables: Deliverable[];  // the standing package
  proposed_deliverables: Deliverable[]; // the creator's proposed package
  /** RATCHET FLOOR — highest amount already communicated to this creator.
   *  Defaults to current_offer_usd. See applyCounterRatchet. */
  standing_offer_usd?: number;
  /**
   * THE LABEL'S DEAL SCOPE. When supplied, a proposal outside it
   * ESCALATES — it is never repriced into an acceptance. Optional because this
   * function cannot invent a label's intent: a caller with no campaign context
   * has no spec to enforce, and inventing one here would be a guess dressed up
   * as a guardrail. The negotiation path always resolves one
   * (resolveCampaignSpec, which is never unbounded), and checks it a second
   * time before this call so an escalation costs no negotiation round.
   */
  spec?: DeliverableSpec | null;
}

// Structurally a superset of CounterDecision, so callers can carry it through
// the existing decision plumbing unchanged.
export type TermTradeDecision =
  | { action: 'accept'; agreed_amount_usd: number; deliverables: Deliverable[]; value_ratio: number; fair_price_usd: number; reason: string }
  | { action: 'counter'; new_offer_usd: number; deliverables: Deliverable[]; value_ratio: number; fair_price_usd: number; reason: string }
  | { action: 'reject'; value_ratio: number; fair_price_usd: number; reason: string }
  // Out of the label's scope. Carries NO price, deliberately: the whole point
  // is that there is no number we are entitled to put on this, and a decision
  // object with a field called new_offer_usd invites a caller to send it.
  | { action: 'escalate'; value_ratio: number; violations: SpecViolation[]; deliverables: Deliverable[]; reason: string };

/**
 * Evaluate a package + price trade. Decision table:
 *   asked ≤ min(fair, ceiling)            → accept at asked, on the new package
 *   asked > limit, rounds < max           → counter at limit (value-adjusted,
 *                                            ceiling-clamped), on the new package
 *   asked > limit, rounds ≥ max           → reject
 *   no asked price                        → NEVER auto-accept (the creator has
 *                                            not seen a number for this package);
 *                                            counter at the value-fair price —
 *                                            for an enlarged package, at most our
 *                                            standing offer (never volunteer more
 *                                            money than they asked for).
 */
export function evaluateTermTrade(input: TermTradeInputs): TermTradeDecision {
  const max = input.max_rounds ?? 3;
  const currentValue = bundleValueUnits(input.current_deliverables);
  const proposedValue = bundleValueUnits(input.proposed_deliverables);
  if (!(currentValue > 0) || !(proposedValue > 0)) {
    return {
      action: 'reject',
      value_ratio: 0,
      fair_price_usd: 0,
      reason: 'term trade unpriceable (empty or zero-value package)',
    };
  }

  const ratio = proposedValue / currentValue;

  // SCOPE IS JUDGED BEFORE PRICE. Until this branch existed every
  // reject here was about money or rounds, so "that is not what we sell" had no
  // way to be said and the value model priced it anyway: ten 600-second dance
  // videos at a value_ratio of 21.18 came back as accept-at-$150 because $150
  // is under both the fair price and the ceiling. Both of those checks were
  // working correctly. They were answering the wrong question.
  //
  // The outcome is ESCALATE, not a counter at a cleverly-adjusted number. A
  // counter is an offer: quoting one says we would do this deal at the right
  // price, and for a package the label never authorized we do not know that and
  // are not entitled to imply it. The human decides, then the negotiation
  // resumes inside whatever scope they set.
  if (input.spec) {
    const violations = checkPackageAgainstSpec(input.proposed_deliverables, input.spec);
    if (violations.length > 0) {
      return {
        action: 'escalate',
        value_ratio: ratio,
        violations,
        deliverables: input.proposed_deliverables,
        reason:
          `proposed package is outside the campaign's deal scope ` +
          `(${input.spec.source === 'campaign' ? 'set by the label' : 'implied by the standing offer'}): ` +
          `${describeSpecViolations(violations)}; holding for human review`,
      };
    }
  }

  const fair = Math.round(input.current_offer_usd * ratio);

  // RATCHET. A smaller package prices lower only when the creator
  // has not repriced it upward; otherwise our standing number is the floor and
  // `fair` is not allowed to drag the quote backwards.
  const ratchetInputs: RatchetInputs = {
    standing_offer_usd: input.standing_offer_usd ?? input.current_offer_usd,
    ceiling_usd: input.ceiling_usd,
    asked_usd: input.counter_usd,
    package_reduced: proposedValue < currentValue - 1e-9,
  };
  const floor = counterFloorUsd(ratchetInputs);
  const ceilingInt = Math.floor(input.ceiling_usd);
  if (floor > ceilingInt) {
    // Ceiling wins. Refuse rather than quote an impossible number.
    const refusal = applyCounterRatchet(fair, ratchetInputs);
    return {
      action: 'reject',
      value_ratio: ratio,
      fair_price_usd: fair,
      reason: refusal.ok ? 'ratchet floor above ceiling' : refusal.reason,
    };
  }
  // Floor the ceiling clamp to whole dollars — clean numbers, never a breach.
  // `limit` is now bounded below by the ratchet floor as well as above by the
  // ceiling. The accept branch below is unaffected: the floor only binds when
  // the creator asked MORE than our standing number, and in that case
  // asked > floor = limit, so a raised floor can never turn an over-ask into
  // an acceptance.
  const limit = Math.min(Math.max(fair, floor), ceilingInt);

  if (limit < 1) {
    return {
      action: 'reject',
      value_ratio: ratio,
      fair_price_usd: fair,
      reason: `proposed package too small to price a viable deal (fair $${fair})`,
    };
  }

  const pkg = input.proposed_deliverables;
  const pct = (ratio * 100).toFixed(0);

  if (input.counter_usd != null) {
    if (input.counter_usd <= limit) {
      return {
        action: 'accept',
        agreed_amount_usd: input.counter_usd,
        deliverables: pkg,
        value_ratio: ratio,
        fair_price_usd: fair,
        reason: `asked $${input.counter_usd} ≤ value-fair $${fair} (package at ${pct}% of current value) and ≤ ceiling; accepting on the proposed package`,
      };
    }
    if (input.rounds >= max) {
      return {
        action: 'reject',
        value_ratio: ratio,
        fair_price_usd: fair,
        reason: `asked $${input.counter_usd} exceeds value-adjusted limit $${limit} (package at ${pct}% of current value); reached max rounds (${max})`,
      };
    }
    return {
      action: 'counter',
      new_offer_usd: limit,
      deliverables: pkg,
      value_ratio: ratio,
      fair_price_usd: fair,
      reason:
        limit > fair
          ? `asked $${input.counter_usd} for a package at ${pct}% of current value; value-fair is $${fair} but that is below our standing offer, holding at $${limit}, round ${input.rounds + 1}/${max}`
          : `asked $${input.counter_usd} for a package at ${pct}% of current value; counter at value-adjusted $${limit} (ceiling-clamped), round ${input.rounds + 1}/${max}`,
    };
  }

  // No asked price for the changed package — never auto-accept on their behalf.
  if (input.rounds >= max) {
    return {
      action: 'reject',
      value_ratio: ratio,
      fair_price_usd: fair,
      reason: `package change without a price at max rounds (${max}); rejecting`,
    };
  }
  // Never volunteer more money than they asked for on an enlarged package, but
  // never dip below the ratchet floor either (a corrupted current_offer_usd
  // must not drag the quote under a number the creator has already seen).
  const unnamed = Math.max(
    ratio >= 1 ? Math.min(Math.round(input.current_offer_usd), limit) : limit,
    Math.min(floor, ceilingInt),
  );
  if (unnamed < 1) {
    return {
      action: 'reject',
      value_ratio: ratio,
      fair_price_usd: fair,
      reason: 'no viable price for the proposed package',
    };
  }
  return {
    action: 'counter',
    new_offer_usd: unnamed,
    deliverables: pkg,
    value_ratio: ratio,
    fair_price_usd: fair,
    reason: `package change (at ${pct}% of current value) with no asked price; counter at $${unnamed} so the creator confirms a number, round ${input.rounds + 1}/${max}`,
  };
}
