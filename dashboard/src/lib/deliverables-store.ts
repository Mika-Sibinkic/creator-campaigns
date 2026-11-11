// src/lib/deliverables-store.ts
//
// DB-backed resolution + snapshotting of promo deliverables.
// Kept separate from deliverables.ts (which is pure logic) because this layer
// touches Supabase. Used by the negotiator (freeze on agreement) and the tick
// copy generator (state the promo ask in the counter email).

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  PROMO_MAX_SECONDS,
  TERMS_MIN_SECONDS,
  TIME_BASED_DEFAULT_SECONDS,
  isPromoType,
  maxWindowDays,
  normalizeDeliverables,
  specFromPackage,
  type Deliverable,
  type DeliverableSpec,
  type SpecLine,
} from './deliverables';

// Sensible default package when a firm/campaign hasn't configured deliverables
// yet (no UI to set them until T8). One reel + one story inside two weeks — a
// light, realistic micro-influencer ask. Platforms (IG/TikTok/YouTube) are a
// separate per-deal dimension tracked in the contract-template item (T13).
export const DEFAULT_DELIVERABLES: Deliverable[] = [
  { promo_type: 'reel', quantity: 1, delivery_window_days: 14, min_seconds: 30 },
  { promo_type: 'story', quantity: 1, delivery_window_days: 14, min_seconds: 15 },
];

const SELECT = 'promo_type, quantity, delivery_window_days, min_seconds, unit_price_usd';

// Migration 040 added the bound columns. Selected separately from SELECT so a
// database that has not had 040 applied still resolves PACKAGES normally — the
// spec read degrades to the derived spec rather than the negotiation path
// breaking on an unknown column.
const SPEC_SELECT =
  'promo_type, quantity, delivery_window_days, min_seconds, min_quantity, max_quantity, max_seconds';

/**
 * Resolve the deliverable package for an offer: offer-level line items first,
 * then the campaign template, then the default. Never throws — a DB hiccup
 * degrades to the campaign/default so the negotiation path stays live.
 */
export async function resolveOfferDeliverables(
  sb: SupabaseClient,
  opts: { creatorOfferId?: string | null; campaignId?: string | null },
): Promise<Deliverable[]> {
  try {
    if (opts.creatorOfferId) {
      const { data } = await sb
        .from('promo_deliverables')
        .select(SELECT)
        .eq('creator_offer_id', opts.creatorOfferId);
      const norm = normalizeDeliverables(data);
      if (norm.length) return norm;
    }
    if (opts.campaignId) {
      const { data } = await sb
        .from('promo_deliverables')
        .select(SELECT)
        .eq('campaign_id', opts.campaignId);
      const norm = normalizeDeliverables(data);
      if (norm.length) return norm;
    }
  } catch {
    // fall through to default
  }
  // Returned as declared, NOT re-normalized: normalizeDeliverables() imposes
  // the canonical PROMO_TYPES order (story before reel), and this constant's
  // order is the reading order of every counter and acceptance email today.
  // Re-ordering it here would silently rewrite live outbound copy.
  return DEFAULT_DELIVERABLES;
}

/**
 * THE question every path that quotes a price has to answer: what package is
 * this price for? One answer, one function — the negotiator, the copy layer,
 * the agreement freeze and the manual "lock in deal" path must not each
 * resolve it differently, or the offer record and the creator's email drift.
 *
 * Precedence: a package already frozen on the offer by a term trade wins (it
 * IS what was negotiated), then offer-level line items, then the campaign
 * template, then the default bundle. Never empty, never throws.
 */
export async function resolveStandingDeliverables(
  sb: SupabaseClient,
  offer: {
    id?: string | null;
    campaign_id?: string | null;
    /** creator_offers.agreed_deliverables (jsonb) — unknown until normalized. */
    agreed_deliverables?: unknown;
  },
): Promise<Deliverable[]> {
  const frozen = normalizeDeliverables(offer.agreed_deliverables);
  if (frozen.length) return frozen;
  return resolveOfferDeliverables(sb, {
    creatorOfferId: offer.id ?? null,
    campaignId: offer.campaign_id ?? null,
  });
}

// ── Tamper-evidence on the frozen package ─────────────────────────────────────
//
// creator_offers.agreed_deliverables is bare jsonb with no CHECK (migration
// 025). normalizeDeliverables() is deliberately lenient — it DROPS malformed
// lines rather than throwing, so a bad line never breaks the negotiation path.
// Compose the two and you get a silent failure with a legal consequence:
// corrupt the frozen package and resolveStandingDeliverables quietly falls back
// to DEFAULT_DELIVERABLES, so a deal that was frozen as three reels re-reads as
// "1 reel and 1 story" in the acceptance email AND in the generated contract,
// and nothing anywhere says a package was lost.
//
// Leniency is right for PARSING a creator reply. It is wrong for READING BACK
// our own frozen contract state: there, a line we cannot read is evidence the
// row changed under us. This function is the difference — it reports rather
// than repairs. Migration 040 adds the matching DB CHECK so a malformed freeze
// cannot be written in the first place; this catches rows written before it.

export type FrozenCheck =
  | { ok: true; frozen: Deliverable[] | null }
  | { ok: false; reason: string };

/**
 * Validate a raw `creator_offers.agreed_deliverables` value as a package that
 * was frozen by us. Null/undefined is fine (nothing frozen yet). Anything
 * present that does not round-trip through normalizeDeliverables with every
 * line intact is corruption, and the caller must surface it rather than
 * silently negotiating against the default bundle.
 */
export function checkFrozenDeliverables(raw: unknown): FrozenCheck {
  if (raw === null || raw === undefined) return { ok: true, frozen: null };
  if (!Array.isArray(raw)) {
    return { ok: false, reason: `agreed_deliverables is ${typeof raw}, expected a jsonb array` };
  }
  if (raw.length === 0) {
    return { ok: false, reason: 'agreed_deliverables is an empty array — a frozen deal always has at least one line' };
  }
  const norm = normalizeDeliverables(raw);
  if (norm.length === 0) {
    return { ok: false, reason: `agreed_deliverables has ${raw.length} line(s) and none of them are readable` };
  }
  // normalizeDeliverables collapses duplicate promo_types (last wins), so the
  // honest comparison is against the number of DISTINCT valid types present,
  // not the raw length.
  const distinctValid = new Set(
    raw
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map((r) => r.promo_type)
      .filter((t) => isPromoType(t)),
  ).size;
  if (distinctValid !== norm.length || distinctValid === 0) {
    return { ok: false, reason: `agreed_deliverables lost lines on read (${raw.length} stored, ${norm.length} readable)` };
  }
  const unreadable = raw.filter(
    (r) => !r || typeof r !== 'object' || !isPromoType((r as Record<string, unknown>).promo_type),
  ).length;
  if (unreadable > 0) {
    return { ok: false, reason: `agreed_deliverables contains ${unreadable} unreadable line(s)` };
  }
  return { ok: true, frozen: norm };
}

// ── Campaign deal-scope resolution ──────────────────────────────────────────

/** One campaign-parent promo_deliverables row, bounds included. */
interface SpecRow {
  promo_type: unknown;
  quantity: unknown;
  delivery_window_days: unknown;
  min_seconds: unknown;
  min_quantity: unknown;
  max_quantity: unknown;
  max_seconds: unknown;
}

function toInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * THE question every path that agrees to a package has to answer: what is this
 * campaign actually buying? One answer, one function.
 *
 * Precedence: campaign-parent `promo_deliverables` rows (the label set it) →
 * a spec derived from the standing package (they have not). NEVER unbounded,
 * and never throws: a DB hiccup degrades to the derived spec, which is the
 * conservative direction — it bounds the negotiator to what the creator has
 * already been told, rather than opening the scope because a read failed.
 *
 * Nulls in the bound columns are not "no bound": min_quantity → 1,
 * max_quantity → the quantity the label asked for, max_seconds → the platform
 * cap for that type.
 */
export async function resolveCampaignSpec(
  sb: SupabaseClient,
  opts: { campaignId?: string | null; standing: Deliverable[] },
): Promise<DeliverableSpec> {
  const derived = specFromPackage(
    opts.standing.length ? opts.standing : DEFAULT_DELIVERABLES,
  );
  if (!opts.campaignId) return derived;

  try {
    const { data, error } = await sb
      .from('promo_deliverables')
      .select(SPEC_SELECT)
      .eq('campaign_id', opts.campaignId);
    // An error here is most likely migration 040 not being applied yet. Degrade
    // to the derived spec — guarded, just not label-authored.
    if (error) return derived;

    const rows = (data ?? []) as unknown as SpecRow[];
    const lines: SpecLine[] = [];
    let windowDays = 0;
    for (const r of rows) {
      if (!isPromoType(r.promo_type)) continue;
      const promo_type = r.promo_type;
      const quantity = Math.max(1, toInt(r.quantity) ?? 1);
      const maxQ = toInt(r.max_quantity);
      const minQ = toInt(r.min_quantity);
      const timeBased = TIME_BASED_DEFAULT_SECONDS[promo_type] != null;
      const minS = toInt(r.min_seconds);
      const maxS = toInt(r.max_seconds);
      lines.push({
        promo_type,
        min_quantity: minQ != null && minQ > 0 ? Math.min(minQ, quantity) : 1,
        max_quantity: maxQ != null && maxQ > 0 ? Math.max(maxQ, quantity) : quantity,
        // On a label-authored row min_seconds IS the floor: they stated the
        // shortest video they will take. (In the DERIVED spec the same column
        // is only the target length, so the floor there stays the parser's
        // TERMS_MIN_SECONDS and a shorter video keeps repricing instead of
        // escalating.)
        min_seconds: timeBased ? (minS != null && minS > 0 ? minS : TERMS_MIN_SECONDS) : null,
        max_seconds: maxS != null && maxS > 0 ? maxS : PROMO_MAX_SECONDS[promo_type],
      });
      const w = toInt(r.delivery_window_days) ?? 0;
      if (w > windowDays) windowDays = w;
    }
    if (lines.length === 0) return derived;
    return {
      lines,
      max_delivery_window_days: windowDays || maxWindowDays(opts.standing) || 14,
      source: 'campaign',
    };
  } catch {
    return derived;
  }
}
