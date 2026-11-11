// src/lib/deal-economics.ts
//
// Analytics: per-deal economics snapshots.
//
// Two latent quantities become persisted columns on
// creator_offers (migration 021):
//
//   perceived_generosity — agreed_amount_usd ÷ tierBaseUsd(follower_count).
//     How generous the close felt vs the pricing-engine norm (1.0 = exactly
//     the tier base). Falls back to agreed ÷ ceiling_usd when the follower
//     count is unknown; null when neither is derivable.
//   price_give_pct — (agreed_amount_usd − initial_offer_usd) ÷ ceiling_usd.
//     How far the price moved during negotiation, normalized to the
//     per-creator ceiling. Signed and NEVER clamped — a below-opening close
//     is real information. Same formula as the meanGap term in analytics.ts
//     estimateOpeningPct, persisted per-deal.
//
// These are SNAPSHOTS, written once and frozen — follower counts drift and
// the tier base is a function of follower count, so deriving at read time
// would silently rewrite history. economics_computed_at marks a row done
// (the sweeper's convergence key: stamped even when both values are null, so
// a row is never re-scanned forever).
//
// Writers (design §4.3) — the ONLY writers; negotiation.ts and the
// quick-offer route never touch these columns:
//   * sweepDealEconomics()          — called from /api/negotiation/tick after
//                                     the tick body. Doubles as the historical
//                                     backfill (§4.4): any pre-existing closed
//                                     offer gets stamped on the first tick.
//   * persistDealEconomicsForOffer() — targeted write from
//                                     /api/outcomes/record so economics exist
//                                     the moment streams are recorded.
//
// SECURITY: the caller injects the Supabase client (service-role admin from
// the cron route / outcomes route) — same visible-blast-radius pattern as
// negotiation-tick.ts.

import type { SupabaseClient } from '@supabase/supabase-js';
import { tierBaseUsd } from './pricing-engine';

export interface DealEconomicsInput {
  agreed_amount_usd: number | null;
  initial_offer_usd: number | null;
  ceiling_usd: number | null;
  /** Best follower snapshot: campaign_outcomes.follower_count_at_post ?? influencers.follower_count. */
  follower_count: number | null;
}

export interface DealEconomics {
  /** agreed ÷ tierBase(fc); fallback agreed ÷ ceiling; null if neither derivable. */
  perceived_generosity: number | null;
  /** (agreed − initial) ÷ ceiling; null if agreed/initial missing or ceiling ≤ 0. */
  price_give_pct: number | null;
}

/** Pure math — no I/O, no clock. Tolerant of every null combination. */
export function computeDealEconomics(input: DealEconomicsInput): DealEconomics {
  const agreed = input.agreed_amount_usd;
  const initial = input.initial_offer_usd;
  const ceiling = input.ceiling_usd;
  const fc = input.follower_count;

  // perceived_generosity = agreed / tierBaseUsd(follower_count) when
  // agreed > 0 && follower_count is a known non-negative number; else
  // agreed / ceiling when ceiling > 0; else null.
  let perceived_generosity: number | null = null;
  if (agreed != null) {
    if (agreed > 0 && fc != null && fc >= 0) {
      perceived_generosity = agreed / tierBaseUsd(fc);
    } else if (ceiling != null && ceiling > 0) {
      perceived_generosity = agreed / ceiling;
    }
  }

  // price_give_pct = (agreed − initial) / ceiling when agreed and initial are
  // both known and ceiling > 0; else null. Signed; do NOT clamp — a
  // below-opening close (negative give) is real information.
  let price_give_pct: number | null = null;
  if (agreed != null && initial != null && ceiling != null && ceiling > 0) {
    price_give_pct = (agreed - initial) / ceiling;
  }

  return { perceived_generosity, price_give_pct };
}

// ────────────────────────────────────────────────────────────────────────────
// Persistence
// ────────────────────────────────────────────────────────────────────────────

/** One page of pending rows per sweep — the cron fires every tick, so a large
 *  historical backlog drains across a few ticks instead of one giant pass. */
const DEFAULT_SWEEP_LIMIT = 200;

interface OfferEconRow {
  id: string;
  agreed_amount_usd: number | null;
  initial_offer_usd: number | null;
  ceiling_usd: number | null;
  campaign_influencer_id: string | null;
}

/** Defensive numeric coercion — PostgREST numeric columns and scraped counts
 *  can arrive as strings; anything non-finite is treated as unknown. */
function asFiniteNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Batch-resolve the best follower snapshot per offer:
 * campaign_outcomes.follower_count_at_post (frozen at post time) beats
 * influencers.follower_count (current profile, drifts).
 *
 * Throws on fetch failure rather than degrading: these values are stamped as
 * FROZEN snapshots, so writing a ceiling-fallback number because a lookup
 * errored would persist wrong history. Rows stay pending and retry next tick.
 */
async function resolveFollowerSnapshots(
  sb: SupabaseClient,
  offers: OfferEconRow[],
): Promise<Map<string, number>> {
  const followerByOffer = new Map<string, number>();
  const offerIds = offers.map((o) => o.id);

  // 1. Preferred: at-post capture on the outcome row (unique per offer, 012).
  const { data: outcomeRows, error: ocErr } = await sb
    .from('campaign_outcomes')
    .select('creator_offer_id, follower_count_at_post')
    .in('creator_offer_id', offerIds);
  if (ocErr) throw new Error(`deal-economics: outcome snapshot fetch failed: ${ocErr.message}`);
  for (const r of (outcomeRows ?? []) as Array<{
    creator_offer_id: string | null;
    follower_count_at_post: number | null;
  }>) {
    const fc = asFiniteNumber(r.follower_count_at_post);
    if (r.creator_offer_id && fc != null) followerByOffer.set(r.creator_offer_id, fc);
  }

  // 2. Fallback: campaign_influencers → influencers.follower_count.
  const needCi = offers.filter(
    (o) => !followerByOffer.has(o.id) && o.campaign_influencer_id != null,
  );
  const ciIds = [...new Set(needCi.map((o) => o.campaign_influencer_id as string))];
  if (ciIds.length === 0) return followerByOffer;

  const { data: ciRows, error: ciErr } = await sb
    .from('campaign_influencers')
    .select('id, influencer_id')
    .in('id', ciIds);
  if (ciErr) throw new Error(`deal-economics: campaign_influencers fetch failed: ${ciErr.message}`);
  const ciToInfluencer = new Map<string, string>();
  for (const r of (ciRows ?? []) as Array<{ id: string; influencer_id: string | null }>) {
    if (r.influencer_id) ciToInfluencer.set(r.id, r.influencer_id);
  }

  const infIds = [...new Set(ciToInfluencer.values())];
  const followerByInfluencer = new Map<string, number>();
  if (infIds.length > 0) {
    const { data: infRows, error: infErr } = await sb
      .from('influencers')
      .select('id, follower_count')
      .in('id', infIds);
    if (infErr) throw new Error(`deal-economics: influencers fetch failed: ${infErr.message}`);
    for (const r of (infRows ?? []) as Array<{ id: string; follower_count: number | null }>) {
      const fc = asFiniteNumber(r.follower_count);
      if (fc != null) followerByInfluencer.set(r.id, fc);
    }
  }

  for (const o of needCi) {
    const infId = ciToInfluencer.get(o.campaign_influencer_id as string);
    const fc = infId != null ? followerByInfluencer.get(infId) : undefined;
    if (fc != null) followerByOffer.set(o.id, fc);
  }
  return followerByOffer;
}

/** Compute + UPDATE one offer's economics columns. Returns true on success. */
async function stampOffer(
  sb: SupabaseClient,
  offer: OfferEconRow,
  follower_count: number | null,
  nowIso: string,
): Promise<boolean> {
  const econ = computeDealEconomics({
    agreed_amount_usd: asFiniteNumber(offer.agreed_amount_usd),
    initial_offer_usd: asFiniteNumber(offer.initial_offer_usd),
    ceiling_usd: asFiniteNumber(offer.ceiling_usd),
    follower_count,
  });
  const { error } = await sb
    .from('creator_offers')
    .update({
      perceived_generosity: econ.perceived_generosity,
      price_give_pct: econ.price_give_pct,
      economics_computed_at: nowIso,
    } as never)
    .eq('id', offer.id);
  return !error;
}

/**
 * Sweep: stamp economics on every closed offer still pending. Idempotent;
 * converges (economics_computed_at set even when a value is null, so a row is
 * never re-scanned forever). Returns { scanned, updated }.
 *
 * May throw on read failure (nothing wrong is ever persisted) — the tick
 * route wraps the call so a sweeper failure can never break the heartbeat
 * (design §4.3). Per-row UPDATE failures degrade: counted as scanned-not-
 * updated and retried next tick (the row keeps economics_computed_at NULL).
 */
export async function sweepDealEconomics(
  sb: SupabaseClient,
  opts?: { limit?: number },
): Promise<{ scanned: number; updated: number }> {
  const limit = opts?.limit ?? DEFAULT_SWEEP_LIMIT;

  // Pending = closed with a number, not yet stamped (matches the partial
  // index creator_offers_econ_pending_idx from migration 021).
  const { data: offerRows, error: oErr } = await sb
    .from('creator_offers')
    .select('id, agreed_amount_usd, initial_offer_usd, ceiling_usd, campaign_influencer_id')
    .not('agreed_amount_usd', 'is', null)
    .is('economics_computed_at', null)
    .limit(limit);
  if (oErr) throw new Error(`deal-economics sweep: pending scan failed: ${oErr.message}`);

  const offers = (offerRows ?? []) as OfferEconRow[];
  if (offers.length === 0) return { scanned: 0, updated: 0 };

  const followerByOffer = await resolveFollowerSnapshots(sb, offers);

  const nowIso = new Date().toISOString();
  let updated = 0;
  for (const offer of offers) {
    const ok = await stampOffer(sb, offer, followerByOffer.get(offer.id) ?? null, nowIso);
    if (ok) updated += 1;
  }
  return { scanned: offers.length, updated };
}

/**
 * Targeted variant for one offer (used by /api/outcomes/record so a deal's
 * economics exist the moment someone records streams). Re-stamps even
 * if already computed — a re-measure may carry a fresher follower snapshot.
 *
 * Never throws: economics are a bonus on the record path — the outcome row
 * itself must never fail because of them. On any failure the row is left
 * as-is; if it is still unstamped the tick sweeper is the backstop.
 */
export async function persistDealEconomicsForOffer(
  sb: SupabaseClient,
  offerId: string,
): Promise<void> {
  try {
    const { data: offerRow, error: oErr } = await sb
      .from('creator_offers')
      .select('id, agreed_amount_usd, initial_offer_usd, ceiling_usd, campaign_influencer_id')
      .eq('id', offerId)
      .maybeSingle();
    if (oErr || !offerRow) return;
    const offer = offerRow as OfferEconRow;

    // No agreed amount yet → nothing to compute. Deliberately do NOT stamp
    // economics_computed_at here: stamping a null-economics row would strand
    // it (the sweeper only rescans unstamped rows), whereas leaving it
    // pending lets the sweeper stamp it once the deal closes.
    if (offer.agreed_amount_usd == null) return;

    const followerByOffer = await resolveFollowerSnapshots(sb, [offer]);
    await stampOffer(sb, offer, followerByOffer.get(offer.id) ?? null, new Date().toISOString());
  } catch (e) {
    console.error(
      `deal-economics: targeted persist for offer ${offerId} failed (sweeper will retry):`,
      (e as Error).message,
    );
  }
}
