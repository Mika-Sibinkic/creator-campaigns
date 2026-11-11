// src/lib/cpm-shadow.ts
//
// CPM slices S1 + S4, the writes.
// Everything here RECORDS; nothing here decides, and nothing here is read back
// by a path that decides or sends. tests/cpm-shadow-equivalence.test.ts pins
// that: with firms.pricing_mode='formula' every sent price, offer amount and
// status is byte-identical to the code before these slices existed.
//
//   recordShadowPricingBasis  S1 — computes the CPM price of a freshly created
//                             offer and stores it in creator_offers.pricing_basis
//                             beside the unchanged formula price.
//   recordFirstAsk            S4 — the creator's first validated counter number,
//                             into creator_offers.first_ask_usd, once.
//
// CONTRACT, both functions
//   - Never throw. They run inside the money path (createOffer, the negotiator);
//     a shadow write must never cost a real one.
//   - Pre-migration safe. Until 061 (pricing_basis, campaign CPM targets) or 062
//     (first_ask_usd) is applied the write is refused (PGRST204 / 42703); that
//     is an expected state, skipped silently and logged once per process.
//   - Separate statements. The offer insert and the negotiator's own writes are
//     not touched; the shadow value goes in its own UPDATE afterwards, so a
//     refused shadow write cannot refuse the real one.

import type { SupabaseClient } from '@supabase/supabase-js';
import { calculateInitialOffer } from './pricing-engine';
import { expectedViews } from './expected-views';
import { computeCpmPricing, poolTargetCpm, type PricingBasis } from './cpm-pricing';
import { createLogger } from './logger';

const log = createLogger('cpm-shadow');

export type ShadowWriteOutcome = 'written' | 'unavailable' | 'skipped' | 'failed';

/**
 * The database does not have this column/table yet: PostgREST schema-cache
 * misses (PGRST204 column, PGRST205 table) or Postgres undefined_column /
 * undefined_table (42703 / 42P01). Same test the 056/057/059 fallbacks use.
 */
export function isMissingSchemaError(error: unknown): boolean {
  if (!error) return false;
  const e = error as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  if (code === 'PGRST204' || code === 'PGRST205' || code === '42703' || code === '42P01') return true;
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  return (
    msg.includes('could not find the') ||
    msg.includes('schema cache') ||
    ((msg.includes('column') || msg.includes('relation')) && msg.includes('does not exist'))
  );
}

const warned = new Set<string>();
/** Log an expected pre-migration skip once per process, not once per offer. */
export function logOnce(key: string, msg: string, meta?: Record<string, unknown>): void {
  if (warned.has(key)) return;
  warned.add(key);
  log.info(msg, meta);
}

export interface CreatorProfile {
  platform: string | null;
  raw_data: unknown;
}

/** The creator's platform + stored post history. Never throws; null when unreadable. */
export async function loadCreatorProfile(
  sb: SupabaseClient,
  campaign_influencer_id: string,
): Promise<CreatorProfile | null> {
  try {
    const { data: ci } = await sb
      .from('campaign_influencers')
      .select('influencer_id')
      .eq('id', campaign_influencer_id)
      .maybeSingle();
    const influencerId = (ci as { influencer_id?: string | null } | null)?.influencer_id;
    if (!influencerId) return null;
    const { data: inf } = await sb
      .from('influencers')
      .select('platform, raw_data')
      .eq('id', influencerId)
      .maybeSingle();
    if (!inf) return null;
    const r = inf as { platform?: string | null; raw_data?: unknown };
    return { platform: r.platform ?? null, raw_data: r.raw_data ?? null };
  } catch {
    return null;
  }
}

// ── Cold-start target: the CPM the formula already pays across the pool ─────

/** Upper bound on pool rows read for the cold-start target. */
export const POOL_TARGET_MAX_ROWS = 200;
/** One pool read per campaign per window, not one per offer: the read carries every creator's raw_data. */
export const POOL_TARGET_CACHE_MS = 10 * 60_000;
const poolCache = new Map<string, { at: number; value: { cpm: number; n: number } | null }>();

/** Test seam: forget cached pool targets. */
export function resetCpmShadowCaches(): void {
  poolCache.clear();
}

async function loadPoolTarget(
  sb: SupabaseClient,
  input: {
    campaign_id: string;
    genre: string | null;
    genre_premiums: Readonly<Record<string, number>> | undefined;
    cap: number;
    nowMs: number;
  },
): Promise<{ cpm: number; n: number } | null> {
  const key = `${input.campaign_id}|${input.cap}|${input.genre ?? ''}`;
  const hit = poolCache.get(key);
  if (hit && input.nowMs - hit.at < POOL_TARGET_CACHE_MS) return hit.value;

  const { data: ciRows, error: ciErr } = await sb
    .from('campaign_influencers')
    .select('influencer_id')
    .eq('campaign_id', input.campaign_id)
    .not('composite_score', 'is', null)
    .limit(POOL_TARGET_MAX_ROWS);
  if (ciErr) return null; // unreadable is not "empty" — don't cache it
  const ids = [
    ...new Set(
      ((ciRows ?? []) as Array<{ influencer_id: string | null }>)
        .map((r) => r.influencer_id)
        .filter((x): x is string => !!x),
    ),
  ];
  let value: { cpm: number; n: number } | null = null;
  if (ids.length > 0) {
    const { data: infRows, error: infErr } = await sb
      .from('influencers')
      .select('id, platform, follower_count, engagement_rate, raw_data')
      .in('id', ids);
    if (infErr) return null;
    const pool = (
      (infRows ?? []) as Array<{
        platform: string | null;
        follower_count: number | null;
        engagement_rate: number | null;
        raw_data: unknown;
      }>
    ).map((r) => ({
      formula_price: calculateInitialOffer({
        follower_count: Number(r.follower_count ?? 0) || 0,
        engagement_rate: Number(r.engagement_rate ?? 0) || 0,
        platform: r.platform,
        genre: input.genre,
        genre_premiums: input.genre_premiums,
        per_creator_cap_usd: input.cap,
      }).initial_offer_usd,
      views: expectedViews({ platform: r.platform, raw_data: r.raw_data, nowMs: input.nowMs })?.views ?? null,
    }));
    value = poolTargetCpm(pool);
  }
  poolCache.set(key, { at: input.nowMs, value });
  return value;
}

// ── S1: pricing_basis ───────────────────────────────────────────────────────

export interface ShadowPricingInput {
  offer_id: string;
  campaign_id: string;
  campaign_influencer_id: string;
  genre?: string | null;
  genre_premiums?: Readonly<Record<string, number>>;
  per_creator_cap_usd: number;
  /** The formula price createOffer actually stored. */
  formula_price_usd: number;
  /** Supplied by a caller that already holds it; loaded here otherwise. */
  creator_profile?: CreatorProfile | null;
  now_ms?: number;
}

/**
 * Compute the CPM price for a just-created offer and store it in
 * creator_offers.pricing_basis. Returns the basis written (or null) and why.
 * Never throws.
 */
export async function recordShadowPricingBasis(
  sb: SupabaseClient,
  input: ShadowPricingInput,
): Promise<{ outcome: ShadowWriteOutcome; basis: PricingBasis | null }> {
  try {
    // Campaign CPM targets are 061 columns: their absence is the cheapest
    // pre-061 probe, and it comes before any heavier read.
    const { data: camp, error: campErr } = await sb
      .from('campaigns')
      .select('target_cpm_usd, max_cpm_usd')
      .eq('id', input.campaign_id)
      .maybeSingle();
    if (campErr) {
      if (isMissingSchemaError(campErr)) {
        logOnce('pre-061', 'migration 061 not applied — CPM shadow pricing skipped', { error: String((campErr as { message?: unknown }).message ?? '') });
        return { outcome: 'unavailable', basis: null };
      }
      log.warn('campaign CPM targets unreadable — shadow pricing skipped', { campaign_id: input.campaign_id });
      return { outcome: 'failed', basis: null };
    }
    const c = (camp ?? {}) as { target_cpm_usd?: number | string | null; max_cpm_usd?: number | string | null };
    const target = c.target_cpm_usd == null ? null : Number(c.target_cpm_usd);
    const max = c.max_cpm_usd == null ? null : Number(c.max_cpm_usd);

    const nowMs = input.now_ms ?? Date.now();
    const profile =
      input.creator_profile !== undefined
        ? input.creator_profile
        : await loadCreatorProfile(sb, input.campaign_influencer_id);
    const views = profile
      ? expectedViews({ platform: profile.platform, raw_data: profile.raw_data, nowMs })
      : null;

    // The pool read is only worth its weight when it can matter: the creator
    // has a view estimate and the campaign has not set its own target.
    const poolTarget =
      views && !(target != null && target > 0)
        ? await loadPoolTarget(sb, {
            campaign_id: input.campaign_id,
            genre: input.genre ?? null,
            genre_premiums: input.genre_premiums,
            cap: input.per_creator_cap_usd,
            nowMs,
          })
        : null;

    const basis = computeCpmPricing({
      views,
      formulaPriceUsd: input.formula_price_usd,
      perCreatorCapUsd: input.per_creator_cap_usd,
      campaignTargetCpmUsd: target,
      campaignMaxCpmUsd: max,
      poolTarget,
    });

    const { error: upErr } = await sb
      .from('creator_offers')
      .update({ pricing_basis: basis } as never)
      .eq('id', input.offer_id);
    if (upErr) {
      if (isMissingSchemaError(upErr)) {
        logOnce('pre-061-basis', 'creator_offers.pricing_basis missing (061 not applied) — CPM shadow pricing skipped');
        return { outcome: 'unavailable', basis: null };
      }
      log.warn('pricing_basis write failed', { offer_id: input.offer_id, error: String((upErr as { message?: unknown }).message ?? '') });
      return { outcome: 'failed', basis: null };
    }
    return { outcome: 'written', basis };
  } catch (e) {
    log.warn('CPM shadow pricing failed', { offer_id: input.offer_id, error: (e as Error)?.message ?? String(e) });
    return { outcome: 'failed', basis: null };
  }
}

// ── S4: first_ask_usd ───────────────────────────────────────────────────────

/**
 * Record the creator's first asking price, once.
 *
 * `usd` must be the structured counter_usd the negotiator already validated
 * against the creator's own words (stated-price.ts counterGate) — never a
 * number parsed out of text, and never one of our own messages. The write is
 * conditional on the column still being NULL, so a later ask can never
 * overwrite the first. Never throws.
 */
export async function recordFirstAsk(
  sb: SupabaseClient,
  offer: { id: string; first_ask_usd?: unknown },
  usd: number,
): Promise<ShadowWriteOutcome> {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return 'skipped';
  if (offer.first_ask_usd != null) return 'skipped';
  try {
    const { error } = await sb
      .from('creator_offers')
      .update({ first_ask_usd: usd } as never)
      .eq('id', offer.id)
      .is('first_ask_usd', null);
    if (error) {
      if (isMissingSchemaError(error)) {
        logOnce('pre-062-first-ask', 'creator_offers.first_ask_usd missing (062 not applied) — first ask not recorded');
        return 'unavailable';
      }
      log.warn('first_ask_usd write failed', { offer_id: offer.id, error: String((error as { message?: unknown }).message ?? '') });
      return 'failed';
    }
    return 'written';
  } catch (e) {
    log.warn('first_ask_usd write threw', { offer_id: offer.id, error: (e as Error)?.message ?? String(e) });
    return 'failed';
  }
}
