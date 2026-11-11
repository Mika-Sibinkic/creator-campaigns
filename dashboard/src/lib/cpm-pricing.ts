// src/lib/cpm-pricing.ts
//
// The CPM price of a deal: what we would open at and walk away at if the
// objective were the label's cost per thousand views rather than the
// follower-tier formula (CPM slice S1).
//
// SHADOW ONLY. Today this is computed and stored in creator_offers.pricing_basis
// next to the formula price and read by nothing that decides or sends. Using it
// is slice S2, which needs an explicit decision; until then `applied` is always false.
//
// Pure. No I/O.
//
//   opening   = expectedViews × k × targetCpm / 1000
//   walk-away = expectedViews × k × maxCpm    / 1000
//   both ≤ the per-creator cap, and opening ≤ walk-away.
//
// k — sponsored views as a fraction of a creator's organic median. DEFAULT 0.75
//   is uncalibrated; deal_cpm_records is the data that will calibrate it.
//
// target CPM, in order of preference:
//   'campaign' — campaigns.target_cpm_usd, when a human set one;
//   'pool'     — cold start: the median CPM the CURRENT FORMULA implicitly pays
//                across the campaign's scored pool (formula price over expected
//                sponsored views). Neutral by construction: a median creator's
//                CPM price equals their formula price, so turning CPM on later
//                re-distributes spend across creators rather than silently
//                raising or cutting it;
//   'default'  — COLD_START_TARGET_CPM_USD, an unvalidated constant, when the
//                pool has fewer than POOL_TARGET_MIN_CREATORS priced creators.
// max CPM: campaigns.max_cpm_usd, else target × DEFAULT_MAX_OVER_TARGET
//   (unvalidated). A target above the max is pulled down to it.

import type { ExpectedViewsEstimate } from './expected-views';

/** Sponsored-vs-organic view factor. UNVALIDATED default — see header. */
export const DEFAULT_VIEW_FACTOR_K = 0.75;
/** Target CPM (USD per 1,000 expected sponsored views) when nothing better exists. UNVALIDATED. */
export const COLD_START_TARGET_CPM_USD = 10;
/** Walk-away CPM as a multiple of target when the campaign sets no max. UNVALIDATED. */
export const DEFAULT_MAX_OVER_TARGET = 1.5;
/** Fewer priced creators than this in the pool → no pool target. */
export const POOL_TARGET_MIN_CREATORS = 3;
/** Bump when the shape or arithmetic of PricingBasis changes. */
export const PRICING_BASIS_VERSION = 1;

export type CpmTargetSource = 'campaign' | 'pool' | 'default';

/** What creator_offers.pricing_basis holds. */
export interface PricingBasis {
  /** 'cpm' when the creator had a view estimate; 'formula' when it fell back. */
  method: 'cpm' | 'formula';
  /** Expected organic views per post (median), or null when unknown. */
  views: number | null;
  k: number;
  k_source: 'default';
  /** Target CPM used (USD per 1,000 sponsored views). */
  target: number;
  target_source: CpmTargetSource;
  /** Creators behind a pool target; 0 otherwise. */
  target_n: number;
  /** Walk-away CPM used. */
  max: number;
  /** Posts behind the view estimate; 0 when there was none. */
  n: number;
  /** CPM opening price (USD, whole dollars), or the formula price on fallback. */
  price: number;
  /** CPM walk-away (USD, whole dollars); null on fallback — never invented. */
  walkaway: number | null;
  /** The formula price that was actually used for this offer. */
  formula_price: number;
  /** The per-creator cap both numbers were held under. */
  cap: number;
  /** False until slice S2: this price decided nothing. */
  applied: false;
  version: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const positive = (n: unknown): number | null => {
  const v = typeof n === 'number' ? n : Number(n);
  return n != null && Number.isFinite(v) && v > 0 ? v : null;
};

/** CPM the formula price implies on expected sponsored views; null without views. */
export function impliedFormulaCpm(
  formulaPriceUsd: number,
  views: number | null,
  k: number = DEFAULT_VIEW_FACTOR_K,
): number | null {
  if (views == null || !(views > 0) || !(k > 0) || !Number.isFinite(formulaPriceUsd)) return null;
  return round2(formulaPriceUsd / ((views * k) / 1000));
}

/** Median formula-implied CPM over a pool; null below POOL_TARGET_MIN_CREATORS. */
export function poolTargetCpm(
  pool: ReadonlyArray<{ formula_price: number; views: number | null }>,
  k: number = DEFAULT_VIEW_FACTOR_K,
): { cpm: number; n: number } | null {
  const cpms = pool
    .map((c) => impliedFormulaCpm(c.formula_price, c.views, k))
    .filter((c): c is number => c != null && c > 0)
    .sort((a, b) => a - b);
  if (cpms.length < POOL_TARGET_MIN_CREATORS) return null;
  const mid = Math.floor(cpms.length / 2);
  const med = cpms.length % 2 === 1 ? cpms[mid] : (cpms[mid - 1] + cpms[mid]) / 2;
  return { cpm: round2(med), n: cpms.length };
}

export function computeCpmPricing(input: {
  views: ExpectedViewsEstimate | null;
  formulaPriceUsd: number;
  perCreatorCapUsd: number;
  campaignTargetCpmUsd?: number | null;
  campaignMaxCpmUsd?: number | null;
  poolTarget?: { cpm: number; n: number } | null;
  k?: number;
}): PricingBasis {
  const k = positive(input.k) ?? DEFAULT_VIEW_FACTOR_K;
  const cap = Number(input.perCreatorCapUsd);
  const formula = Number(input.formulaPriceUsd);

  const campaignTarget = positive(input.campaignTargetCpmUsd);
  const campaignMax = positive(input.campaignMaxCpmUsd);
  const pool = input.poolTarget && positive(input.poolTarget.cpm) ? input.poolTarget : null;

  let target: number;
  let target_source: CpmTargetSource;
  let target_n = 0;
  if (campaignTarget != null) {
    target = campaignTarget;
    target_source = 'campaign';
  } else if (pool) {
    target = pool.cpm;
    target_source = 'pool';
    target_n = pool.n;
  } else {
    target = COLD_START_TARGET_CPM_USD;
    target_source = 'default';
  }
  const max = campaignMax ?? round2(target * DEFAULT_MAX_OVER_TARGET);
  if (target > max) target = max;

  const base = {
    k,
    k_source: 'default' as const,
    target,
    target_source,
    target_n,
    max,
    formula_price: formula,
    cap,
    applied: false as const,
    version: PRICING_BASIS_VERSION,
  };

  if (!input.views || !(input.views.views > 0)) {
    return { ...base, method: 'formula', views: null, n: 0, price: formula, walkaway: null };
  }

  const sponsoredThousands = (input.views.views * k) / 1000;
  const walkaway = Math.min(Math.round(sponsoredThousands * max), cap);
  const price = Math.min(Math.round(sponsoredThousands * target), cap, walkaway);
  return { ...base, method: 'cpm', views: input.views.views, n: input.views.n, price, walkaway };
}
