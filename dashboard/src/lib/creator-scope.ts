// src/lib/creator-scope.ts
//
// May this firm mutate this creator's SHARED columns?
//
// `influencers` is deliberately cross-firm: the row is keyed
// `unique (platform, username)` (supabase/migrations/003_base_schema.sql) and migration 007
// documents creators as "SHARED across firms". Two labels discovering the
// same TikToker get the same row, which is correct — a creator is one person.
//
// The problem is that two columns on that shared row are per-firm decisions
// wearing global clothing:
//
//   * `blocklisted` — /influencers tells the user "They'll be removed from
//     YOUR creator list" (src/app/influencers/page.tsx:89-91). It is not
//     their list. One label blocking a creator removes that creator from
//     every other label's roster, and the UI told them it was theirs.
//   * `contact_email` — a scraped address any authenticated user could
//     overwrite for everyone.
//
// The complete fix is a per-firm `influencer_blocklists` table — the exact
// table this route's own header has named as deferred since migration time.
// That needs a migration, which is deliberately NOT created here.
//
// What IS closable without a migration is the write gate. A firm that has
// never discovered a creator has no business mutating that creator's shared
// state, and today any authenticated user can mutate any creator. Requiring a
// campaign relationship shrinks the blast radius from "every creator in the
// database" to "creators this firm actually worked" — which for the existing
// single-tenant deployment is a no-op, and for a second tenant is the
// difference between a full cross-tenant write and none.
//
// UPDATE (migration 056): the table landed as `firm_influencer_blocks`
// (src/lib/firm-blocks.ts). A label's Block and a creator's STOP are now
// per-firm rows, so blocking a shared creator no longer blocks them for the
// other label. `blocklisted` survives as an operator-only, platform-level
// block. `contact_email` is still a shared column, and this gate still guards
// it.

import type { SupabaseClient } from '@supabase/supabase-js';

/** Why a creator mutation was refused. Stable strings — safe to assert on. */
export type CreatorScopeDenial =
  /** Caller carries no firm (unprovisioned member). */
  | 'caller_unscoped'
  /** This firm has never worked this creator. */
  | 'no_creator_relationship';

export type CreatorScopeVerdict =
  | { ok: true }
  | { ok: false; httpStatus: 403; error: 'forbidden'; reason: CreatorScopeDenial };

/**
 * The pure decision: given the caller's firm and how many campaign rows link
 * that firm to the creator, may they write?
 *
 * Fail-closed on both inputs. A blank firm id is a denial, and a negative or
 * non-finite count is treated as zero rather than as "probably fine" — an
 * unreadable relationship count must not become an authorization.
 */
export function checkCreatorScope(
  callerFirmId: string | null | undefined,
  relationshipCount: number
): CreatorScopeVerdict {
  if (typeof callerFirmId !== 'string' || callerFirmId.trim().length === 0) {
    return { ok: false, httpStatus: 403, error: 'forbidden', reason: 'caller_unscoped' };
  }
  const count =
    typeof relationshipCount === 'number' && Number.isFinite(relationshipCount)
      ? relationshipCount
      : 0;
  if (count <= 0) {
    return {
      ok: false,
      httpStatus: 403,
      error: 'forbidden',
      reason: 'no_creator_relationship',
    };
  }
  return { ok: true };
}

/** The JSON body a denied verdict should be returned as. */
export function creatorScopeErrorBody(
  verdict: Extract<CreatorScopeVerdict, { ok: false }>
): { error: string; reason: CreatorScopeDenial } {
  return { error: verdict.error, reason: verdict.reason };
}

/**
 * Creator columns that are SCRAPED CONTACT DETAIL rather than public profile.
 *
 * The influencer row is shared across firms by design, and a public handle,
 * follower count or bio is fine to share — two labels discovering the same
 * TikToker should see the same person. A scraped email address and a payout
 * account id are a different category: they are the work product of one
 * firm's (paid) discovery run, and handing them to a competing label is the
 * thing the isolation work exists to stop.
 *
 * Redacted to null rather than omitted, so response shape is stable and the
 * UI renders "no contact on file" instead of breaking.
 */
export const CREATOR_PRIVATE_FIELDS = [
  'contact_email',
  'stripe_connect_account_id',
] as const;

/**
 * Null out the private fields on a creator row the caller's firm has no
 * relationship with. Pure — `relatedIds` is resolved by the caller.
 *
 * Returns the row unchanged when the firm HAS worked this creator, so the
 * existing single-tenant experience is untouched.
 */
export function redactUnrelatedCreator<T extends { id?: unknown }>(
  row: T,
  relatedIds: ReadonlySet<string>
): T {
  const id = typeof row?.id === 'string' ? row.id : null;
  if (id !== null && relatedIds.has(id)) return row;
  const out = { ...row } as Record<string, unknown>;
  for (const field of CREATOR_PRIVATE_FIELDS) {
    if (field in out) out[field] = null;
  }
  return out as T;
}

/**
 * The set of influencer ids this firm has a campaign relationship with.
 *
 * Returns an EMPTY set on any error — fail-closed, so a DB hiccup redacts
 * everything rather than exposing everything.
 */
export async function firmRelatedInfluencerIds(
  sb: SupabaseClient,
  firmId: string
): Promise<Set<string>> {
  const empty = new Set<string>();
  if (typeof firmId !== 'string' || firmId.trim().length === 0) return empty;

  const { data: ownCampaigns, error: campErr } = await sb
    .from('campaigns')
    .select('id')
    .eq('firm_id', firmId);
  if (campErr || !ownCampaigns || ownCampaigns.length === 0) return empty;

  const ids = ownCampaigns.map((c) => (c as { id: string }).id);
  const { data, error } = await sb
    .from('campaign_influencers')
    .select('influencer_id')
    .in('campaign_id', ids);
  if (error || !data) return empty;

  const out = new Set<string>();
  for (const row of data) {
    const v = (row as { influencer_id?: unknown }).influencer_id;
    if (typeof v === 'string') out.add(v);
  }
  return out;
}

/**
 * How many campaign_influencers rows link `firmId` to `influencerId`.
 *
 * `campaign_influencers` has no firm_id column, so ownership resolves through
 * `campaign_id → campaigns.firm_id` — the same chain migration 007's policies
 * use (007:169-213) and the same one api/campaigns/[id]/influencers uses.
 *
 * Returns 0 on any error. That is the fail-closed direction: a DB hiccup
 * denies a write rather than permitting one.
 */
export async function countFirmCreatorRelationships(
  sb: SupabaseClient,
  firmId: string,
  influencerId: string
): Promise<number> {
  const { data: ownCampaigns, error: campErr } = await sb
    .from('campaigns')
    .select('id')
    .eq('firm_id', firmId);
  if (campErr || !ownCampaigns || ownCampaigns.length === 0) return 0;

  const ids = ownCampaigns.map((c) => (c as { id: string }).id);
  const { count, error } = await sb
    .from('campaign_influencers')
    .select('id', { count: 'exact', head: true })
    .eq('influencer_id', influencerId)
    .in('campaign_id', ids);
  if (error) return 0;
  return count ?? 0;
}

// ─── The shared contact column ──────────────────────────────────────────────
//
// `influencers.contact_email` is where EVERY label's outreach, counter-offers
// and payout mail to this creator goes. Having "some relationship" with the
// creator (checkCreatorScope) was the only gate on writing it, so label A could
// redirect label B's mail for a creator they both work. A per-firm contact
// override needs a migration; not built. Until then, the rule is: a label may
// change the shared address only while it is the ONLY label working the
// creator. Otherwise a platform operator changes it.

/** Which firms have a campaign relationship with a creator. */
export type CreatorFirmsRead =
  | {
      ok: true;
      firmIds: Set<string>;
      /** Linked campaigns whose firm is null or unreadable — unknown owners. */
      unscopedCampaigns: number;
    }
  | { ok: false; message: string };

const CAMPAIGN_CHUNK = 100;

/**
 * Every firm that works `influencerId`, via campaign_influencers →
 * campaigns.firm_id (the same chain as countFirmCreatorRelationships).
 *
 * Fail-closed in both directions that matter: an unreadable table is
 * `ok: false`, and a linked campaign with no firm (or one that cannot be read
 * back) is counted in `unscopedCampaigns` rather than dropped, so an unknown
 * co-owner can never make a label look like the sole owner.
 */
export async function firmsRelatedToCreator(
  sb: SupabaseClient,
  influencerId: string
): Promise<CreatorFirmsRead> {
  try {
    const { data: links, error } = await sb
      .from('campaign_influencers')
      .select('campaign_id')
      .eq('influencer_id', influencerId);
    if (error || !links) return { ok: false, message: error?.message ?? 'no data' };

    const campaignIds = [
      ...new Set(
        (links as Array<{ campaign_id?: unknown }>)
          .map((r) => r.campaign_id)
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
      ),
    ];
    const firmIds = new Set<string>();
    let unscopedCampaigns = 0;
    for (let i = 0; i < campaignIds.length; i += CAMPAIGN_CHUNK) {
      const part = campaignIds.slice(i, i + CAMPAIGN_CHUNK);
      const { data, error: campErr } = await sb
        .from('campaigns')
        .select('id, firm_id')
        .in('id', part);
      if (campErr || !data) return { ok: false, message: campErr?.message ?? 'no data' };
      const seen = new Set<string>();
      for (const c of data as Array<{ id?: unknown; firm_id?: unknown }>) {
        if (typeof c.id === 'string') seen.add(c.id);
        if (typeof c.firm_id === 'string' && c.firm_id.trim().length > 0) firmIds.add(c.firm_id);
        else unscopedCampaigns += 1;
      }
      for (const id of part) if (!seen.has(id)) unscopedCampaigns += 1;
    }
    return { ok: true, firmIds, unscopedCampaigns };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export const SHARED_CONTACT_MESSAGE =
  "Another label also works with this creator, so their contact email is shared with that label's outreach and payments. " +
  'It can’t be changed from here. Ask a platform operator to change it.';

export type SharedContactVerdict =
  | { ok: true; basis: 'operator' | 'sole_firm' }
  | { ok: false; httpStatus: 403; error: 'forbidden'; reason: CreatorScopeDenial }
  | { ok: false; httpStatus: 409; error: 'shared_creator_contact'; message: string }
  | { ok: false; httpStatus: 503; error: 'relationships_unreadable'; message: string };

/**
 * May this caller change the creator's SHARED contact_email?
 *
 *   - a platform operator: yes (the 409 below routes the change to them, so
 *     their path must not depend on their own label's relationships);
 *   - an unscoped caller, or a label that does not work the creator: 403;
 *   - relationships unread or unreadable: 503 — never an authorization;
 *   - any other label (or an unknown owner) also works the creator: 409;
 *   - otherwise the caller's label is the sole owner: yes.
 */
export function checkSharedContactWrite(input: {
  callerFirmId: string | null | undefined;
  isOperator: boolean;
  related: CreatorFirmsRead | null;
}): SharedContactVerdict {
  if (input.isOperator === true) return { ok: true, basis: 'operator' };
  const caller = input.callerFirmId;
  if (typeof caller !== 'string' || caller.trim().length === 0) {
    return { ok: false, httpStatus: 403, error: 'forbidden', reason: 'caller_unscoped' };
  }
  const related = input.related;
  if (!related || !related.ok) {
    return {
      ok: false,
      httpStatus: 503,
      error: 'relationships_unreadable',
      message: "Couldn't confirm which labels work with this creator, so nothing was changed. Try again in a minute.",
    };
  }
  if (!related.firmIds.has(caller)) {
    return { ok: false, httpStatus: 403, error: 'forbidden', reason: 'no_creator_relationship' };
  }
  if (related.firmIds.size > 1 || related.unscopedCampaigns > 0) {
    return {
      ok: false,
      httpStatus: 409,
      error: 'shared_creator_contact',
      message: SHARED_CONTACT_MESSAGE,
    };
  }
  return { ok: true, basis: 'sole_firm' };
}
