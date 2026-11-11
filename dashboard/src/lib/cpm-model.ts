// src/lib/cpm-model.ts
//
// Label-side CPM + the RL feature record for a deal (measure everything and
// optimize for label-side CPM). Pure functions
// over the deal + performance data already captured (amount, negotiation
// rounds/delta, deliverables, verified reach). No DB access — the analytics /
// RL layer supplies the rows; this module turns them into the optimization
// signal so CPM can be compared across deals and campaigns.

import { bundleWeight, type Deliverable } from './deliverables';

export interface PerformanceSnapshot {
  captured_at: string;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
}

/** Latest snapshot by captured_at (the current known reach for a post). */
export function latestSnapshot(snaps: PerformanceSnapshot[]): PerformanceSnapshot | null {
  if (!snaps.length) return null;
  return [...snaps].sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at))[0];
}

/** Total verified reach (views) across a deal's delivered posts. */
export function totalReach(latestPerPost: PerformanceSnapshot[]): number {
  return latestPerPost.reduce((sum, s) => sum + Math.max(0, Number(s?.views ?? 0)), 0);
}

/**
 * Label-side CPM = spend per 1,000 delivered impressions. The core metric the
 * RL loop optimizes DOWN (lower cost per reach = better). Null when reach is
 * unknown/zero (can't divide) so callers don't fabricate a CPM.
 */
export function labelCpm(spendUsd: number, reach: number): number | null {
  if (!reach || reach <= 0) return null;
  return Math.round(((spendUsd / (reach / 1000)) + Number.EPSILON) * 100) / 100;
}

export interface DealCpmFeatures {
  // Cost side
  agreed_amount_usd: number;
  outreach_to_agreement_delta_usd: number | null; // opening vs agreed — negotiation efficiency
  rounds: number;                                   // negotiation rounds
  deliverable_weight: number;                       // Σ promo weight × qty (effort priced)
  // Value side
  reach: number;                                    // verified impressions
  label_cpm: number | null;                         // the optimization target
  // Context (for cross-campaign comparison)
  campaign_size: number | null;                     // creators in the campaign
  scrape_quality: number | null;                    // avg composite score of the pool
}

/**
 * Assemble the RL feature record for one deal — the row the CPM optimizer
 * compares across individual deals and across campaigns with different
 * conversion rates. Everything here is already captured by the deal flow;
 * this is the read-model that turns it into the optimization signal.
 */
export function dealCpmFeatures(input: {
  agreedAmountUsd: number;
  openingOfferUsd?: number | null;
  rounds: number;
  deliverables: Deliverable[];
  reach: number;
  campaignSize?: number | null;
  scrapeQuality?: number | null;
}): DealCpmFeatures {
  const delta =
    input.openingOfferUsd == null
      ? null
      : Math.round((input.agreedAmountUsd - input.openingOfferUsd) * 100) / 100;
  return {
    agreed_amount_usd: input.agreedAmountUsd,
    outreach_to_agreement_delta_usd: delta,
    rounds: input.rounds,
    deliverable_weight: Math.round(bundleWeight(input.deliverables) * 100) / 100,
    reach: input.reach,
    label_cpm: labelCpm(input.agreedAmountUsd, input.reach),
    campaign_size: input.campaignSize ?? null,
    scrape_quality: input.scrapeQuality ?? null,
  };
}
