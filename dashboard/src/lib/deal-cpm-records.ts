// src/lib/deal-cpm-records.ts
//
// CPM slice S4 (data capture): one deal_cpm_records row per measured deal —
// what we paid, what views we expected, what the post actually got at ~7 days
// and since. This is the dataset that will calibrate k and the target CPM in
// later slices; nothing
// reads it to decide anything today.
//
// Called by the measurement tick right after a performance snapshot lands, so
// it only ever sees deals the tick already chose to measure: synthetic
// ([SAMPLE]) campaigns are excluded in that query, and excluded again here.
//
// RULES
//   - The row is CREATED at the first snapshot taken once the post is ≥7 days
//     old; views_7d / cpm_7d are set then and never rewritten. They come from
//     a snapshot taken no later than day 8 after the post: this one when it is
//     inside days 7–8, else the latest earlier snapshot of the delivery taken
//     by day 8, else NULL (only latest is filled). isSnapshotDue
//     (measurement.ts) keys on the delivery's detection time, not the post
//     time, and deals measured before 062 is applied are first recorded weeks
//     late — today's views are not a 7-day reading. Existence of the row is
//     the "7-day captured" marker, which keeps a null 7-day reading (an image
//     post, or a late first record) from being back-filled by a later month.
//   - Every later snapshot refreshes views_latest / cpm_latest.
//   - CPM = agreed_usd / (views / 1000) via labelCpm. No views, zero views or no
//     agreed amount → cpm NULL. Never invented.
//   - pricing_method is 'formula' unless the offer's pricing_basis says a CPM
//     price was actually applied (slice S2; never true today).
//   - Never throws. Pre-062 (table missing) it skips silently, logged once.

import type { SupabaseClient } from '@supabase/supabase-js';
import { labelCpm } from './cpm-model';
import { isMissingSchemaError, logOnce } from './cpm-shadow';
import { createLogger } from './logger';

const log = createLogger('deal-cpm-records');

/** A post this many days old has its 7-day CPM captured. */
export const DEAL_CPM_7D_AGE_DAYS = 7;
/** The latest post age (days) a snapshot may have and still be the 7-day reading. */
export const DEAL_CPM_7D_WINDOW_END_DAYS = 8;
const DAY_MS = 86_400_000;

export type DealCpmWriteOutcome = 'created' | 'updated' | 'skipped' | 'unavailable' | 'failed';

export interface DealCpmWriteInput {
  offer_id: string;
  firm_id: string;
  campaign_id: string | null;
  /** The platform the snapshot was measured on ('tiktok' for the Apify TikTok scrape). */
  platform: string;
  /** Views from this snapshot; null for an image post or an unreadable count. */
  views: number | null;
  /** When the post went up (creator_offers.posted_at), ms. */
  posted_at_ms: number | null;
  /** The delivery this snapshot measured: its earlier deal_performance_snapshots
   *  can supply the 7-day reading when this snapshot is past day 8. */
  deal_delivery_id?: string | null;
  now_ms: number;
  /** Campaigns that must never produce a record (synthetic / [SAMPLE]). */
  synthetic_campaign_ids?: ReadonlySet<string> | readonly string[];
}

const numOrNull = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const usableViews = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n != null && n >= 0 ? n : null;
};

/**
 * Views from the latest earlier snapshot of this delivery taken no later than
 * day 8 after the post (inside the 7–8 day window when one exists, since that
 * is the latest such snapshot). null = none, or unreadable.
 */
async function earlySnapshotViews(
  sb: SupabaseClient,
  dealDeliveryId: string,
  postedAtMs: number,
): Promise<number | null> {
  const { data, error } = await sb
    .from('deal_performance_snapshots')
    .select('views, captured_at')
    .eq('deal_delivery_id', dealDeliveryId);
  if (error) return null;
  let best: { at: number; views: unknown } | null = null;
  for (const s of (data ?? []) as Array<{ views: unknown; captured_at: string | null }>) {
    const at = Date.parse(s.captured_at ?? '');
    if (!Number.isFinite(at) || at < postedAtMs) continue;
    if ((at - postedAtMs) / DAY_MS > DEAL_CPM_7D_WINDOW_END_DAYS) continue;
    if (!best || at > best.at) best = { at, views: s.views };
  }
  return best ? usableViews(best.views) : null;
}

export async function writeDealCpmRecord(
  sb: SupabaseClient,
  input: DealCpmWriteInput,
): Promise<DealCpmWriteOutcome> {
  try {
    const synthetic = input.synthetic_campaign_ids;
    if (
      input.campaign_id &&
      synthetic &&
      (Array.isArray(synthetic)
        ? (synthetic as readonly string[]).includes(input.campaign_id)
        : (synthetic as ReadonlySet<string>).has(input.campaign_id))
    ) {
      return 'skipped';
    }
    if (input.posted_at_ms == null || !Number.isFinite(input.posted_at_ms)) return 'skipped';

    const { data: existing, error: exErr } = await sb
      .from('deal_cpm_records')
      .select('id')
      .eq('offer_id', input.offer_id)
      .maybeSingle();
    if (exErr) {
      if (isMissingSchemaError(exErr)) {
        logOnce('pre-062-deal-cpm', 'deal_cpm_records missing (062 not applied) — deal CPM not recorded');
        return 'unavailable';
      }
      log.warn('deal_cpm_records unreadable', { offer_id: input.offer_id });
      return 'failed';
    }

    const ageDays = (input.now_ms - input.posted_at_ms) / DAY_MS;
    if (!existing && ageDays < DEAL_CPM_7D_AGE_DAYS) return 'skipped';

    const { data: offerRow } = await sb
      .from('creator_offers')
      .select('agreed_amount_usd, last_message_id')
      .eq('id', input.offer_id)
      .maybeSingle();
    const offer = (offerRow ?? {}) as { agreed_amount_usd?: unknown; last_message_id?: string | null };
    const agreed = numOrNull(offer.agreed_amount_usd);
    const agreedUsable = agreed != null && agreed > 0 ? agreed : null;

    const views = usableViews(input.views);
    const cpmOf = (v: number | null) => (agreedUsable != null && v != null ? labelCpm(agreedUsable, v) : null);
    const cpm = cpmOf(views);
    const nowIso = new Date(input.now_ms).toISOString();

    if (existing) {
      const { error } = await sb
        .from('deal_cpm_records')
        .update({ agreed_usd: agreedUsable, views_latest: views, cpm_latest: cpm, updated_at: nowIso } as never)
        .eq('offer_id', input.offer_id);
      if (error) {
        log.warn('deal_cpm_records update failed', { offer_id: input.offer_id, error: String((error as { message?: unknown }).message ?? '') });
        return 'failed';
      }
      return 'updated';
    }

    // First record: pull the shadow basis (061; absent → null) and the channel
    // the deal was struck on (the outbound the offer last pointed at).
    type BasisRead = { views?: unknown; method?: unknown; applied?: unknown };
    let basis: BasisRead | null = null;
    {
      const { data, error } = await sb
        .from('creator_offers')
        .select('pricing_basis')
        .eq('id', input.offer_id)
        .maybeSingle();
      if (!error && data) {
        const b = (data as { pricing_basis?: unknown }).pricing_basis;
        if (b && typeof b === 'object') basis = b as BasisRead;
      }
    }
    let channel: string | null = null;
    if (offer.last_message_id) {
      const { data } = await sb
        .from('outreach_messages')
        .select('channel')
        .eq('id', offer.last_message_id)
        .maybeSingle();
      channel = ((data as { channel?: string | null } | null)?.channel ?? null) || null;
    }
    const pricingMethod = basis?.applied === true && basis?.method === 'cpm' ? 'cpm' : 'formula';

    // The 7-day reading: this snapshot when it is inside days 7–8, else the
    // latest earlier one taken by day 8. A deal first recorded long after its
    // post (062 applied to deals already measured) otherwise had today's views
    // stored as its 7-day reading.
    const views7d =
      ageDays <= DEAL_CPM_7D_WINDOW_END_DAYS
        ? views
        : input.deal_delivery_id
          ? await earlySnapshotViews(sb, input.deal_delivery_id, input.posted_at_ms)
          : null;

    const { error } = await sb.from('deal_cpm_records').upsert(
      {
        offer_id: input.offer_id,
        firm_id: input.firm_id,
        campaign_id: input.campaign_id,
        platform: input.platform,
        channel,
        agreed_usd: agreedUsable,
        expected_views: numOrNull(basis?.views),
        views_7d: views7d,
        cpm_7d: cpmOf(views7d),
        views_latest: views,
        cpm_latest: cpm,
        pricing_method: pricingMethod,
        created_at: nowIso,
        updated_at: nowIso,
      } as never,
      { onConflict: 'offer_id' },
    );
    if (error) {
      if (isMissingSchemaError(error)) {
        logOnce('pre-062-deal-cpm', 'deal_cpm_records missing (062 not applied) — deal CPM not recorded');
        return 'unavailable';
      }
      log.warn('deal_cpm_records insert failed', { offer_id: input.offer_id, error: String((error as { message?: unknown }).message ?? '') });
      return 'failed';
    }
    return 'created';
  } catch (e) {
    log.warn('deal CPM record failed', { offer_id: input.offer_id, error: (e as Error)?.message ?? String(e) });
    return 'failed';
  }
}
