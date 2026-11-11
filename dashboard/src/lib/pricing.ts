/**
 * Creator Campaigns Price Estimation Module
 * v1.0 — Formula-based influencer pricing
 *
 * Estimates what a micro-influencer would charge for a sponsored post
 * based on follower count, engagement rate, platform, and genre.
 */

import { normalizeGenre } from "./genre-config";

export interface PriceEstimate {
  low: number;
  mid: number;
  high: number;
  confidence: "high" | "medium" | "low";
  formula_inputs: {
    base_rate: number;
    engagement_multiplier: number;
    genre_multiplier: number;
    urgency_multiplier: number;
  };
}

// Platform CPM benchmarks for micro-influencers (per 1K followers)
const PLATFORM_CPM: Record<string, number> = {
  tiktok: 12, // $10-15 range, mid = $12
  instagram: 18, // $15-25 range, mid = $18
  youtube: 20, // $15-25 range, mid = $20
};

// Market rates by vertical — what creators in each genre actually charge.
// This table stays a constant on purpose: it is a MARKET observation, not a
// per-label preference. The label-specific premium is separate and lives in
// src/lib/genre-config.ts.
//
// `default` is the neutral rate for an unspecified genre. It must stay
// reachable: giving `estimatePrice` a default `genre` parameter would mean
// `default` never fires and every unspecified campaign prices as that genre.
const GENRE_MULTIPLIERS: Record<string, number> = {
  country: 1.2,
  pop: 1.3,
  "hip hop": 1.4,
  "r&b": 1.3,
  rock: 1.1,
  indie: 1.0,
  electronic: 1.2,
  default: 1.15,
};

const URGENCY_MULTIPLIERS: Record<string, number> = {
  low: 0.9,
  normal: 1.0,
  high: 1.15,
  urgent: 1.3,
};

export function estimatePrice(
  followers: number,
  engagementRate: number,
  platform: string,
  // No default. An unknown genre resolves to GENRE_MULTIPLIERS.default (the
  // neutral rate), never to a guessed one.
  genre?: string | null,
  urgency: string = "normal",
  /**
   * The campaign's per-creator ceiling (`campaigns.per_creator_cap_usd`).
   *
   * This output is NOT just an internal estimate. `price_estimate_mid` is
   * persisted to campaign_influencers and then handed to the negotiation
   * copy generator as the one figure it may quote to a creator
   * (src/lib/outreach.ts:751 -> priceRules: "The ONLY money figure you may
   * write is $X"). It was bounded only by the [25, 2000] sanity clamp below,
   * so it could name a number above the campaign's own ceiling.
   *
   * `calculateInitialOffer` has always applied `min(formula, cap)`. This is
   * the same ceiling, on the other money path. Omit it and behaviour is
   * exactly as before — the clamp only ever lowers.
   */
  capUsd?: number | null
): PriceEstimate {
  const cpm = PLATFORM_CPM[platform.toLowerCase()] || PLATFORM_CPM.tiktok;
  const base_rate = (followers / 1000) * cpm;

  // Engagement multiplier: benchmark is 3-8% for TikTok micro
  // Higher engagement = higher value, but diminishing returns
  let engagement_multiplier = 1.0;
  if (engagementRate > 0.08) {
    engagement_multiplier = 1.5 + Math.min((engagementRate - 0.08) * 2, 0.5);
  } else if (engagementRate > 0.03) {
    engagement_multiplier = 1.0 + (engagementRate - 0.03) * 10;
  } else if (engagementRate > 0.01) {
    engagement_multiplier = 0.7 + (engagementRate - 0.01) * 15;
  } else {
    engagement_multiplier = 0.5;
  }

  const genre_multiplier =
    GENRE_MULTIPLIERS[normalizeGenre(genre) ?? ''] ?? GENRE_MULTIPLIERS.default;
  const urgency_multiplier =
    URGENCY_MULTIPLIERS[urgency.toLowerCase()] || URGENCY_MULTIPLIERS.normal;

  const mid = Math.round(
    base_rate * engagement_multiplier * genre_multiplier * urgency_multiplier
  );

  // Floor at $25 (nobody works for less), cap at $2000 for micro-influencers
  const sanity_clamped = Math.max(25, Math.min(2000, mid));

  // The campaign ceiling wins over the $25 floor. A ceiling below the floor
  // means we cannot afford this creator at all, and the honest figure is the
  // ceiling — never a number we are not authorized to pay.
  const usableCap =
    typeof capUsd === "number" && Number.isFinite(capUsd) && capUsd > 0
      ? capUsd
      : null;
  const adjusted_mid =
    usableCap === null ? sanity_clamped : Math.min(sanity_clamped, usableCap);

  // Confidence based on how much data we have
  let confidence: "high" | "medium" | "low" = "medium";
  if (followers > 10000 && engagementRate > 0.01 && engagementRate < 0.5) {
    confidence = "high";
  } else if (followers < 5000 || engagementRate > 0.5) {
    confidence = "low";
  }

  // `high` is mid * 1.4, so it breaches the ceiling even when mid does not.
  // It is displayed as a range endpoint, so bound it too.
  const high = Math.round(adjusted_mid * 1.4);
  return {
    low: Math.round(adjusted_mid * 0.7),
    mid: adjusted_mid,
    high: usableCap === null ? high : Math.min(high, usableCap),
    confidence,
    formula_inputs: {
      base_rate: Math.round(base_rate),
      engagement_multiplier: Math.round(engagement_multiplier * 100) / 100,
      genre_multiplier,
      urgency_multiplier,
    },
  };
}
