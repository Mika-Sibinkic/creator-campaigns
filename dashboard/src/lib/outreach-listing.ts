// src/lib/outreach-listing.ts
//
// The core of GET /api/outreach/list, extracted so the TENANT BOUNDARY is
// executable-testable rather than grep-testable.
//
// Why this file exists: the first version of this fix left the scoping inline
// in the route and guarded it with `String.includes()` assertions over the
// route's source text. Those assertions passed while two mutations fully
// reopened the leak — folding the `.in('campaign_id', …)` into the optional
// `if (campaign_id)` branch, and dropping the scope verdict on the floor. A
// source grep cannot tell the difference between a filter that is present and
// a filter that is applied. Running the code can.
//
// Same seam convention as src/lib/authorize-payment.ts: the route handler
// keeps auth, rate limiting and response shaping; everything that decides
// WHICH ROWS a caller sees lives here, behind one function, against an
// injected Supabase client.

import type { SupabaseClient } from '@supabase/supabase-js';
import { checkFirmScope, firmScopeErrorBody } from './firm-scope';
import { applyOutreachStatusTabFilter } from './outreach-status';
import { doNotContactVerdict, readFirmBlocks } from './firm-blocks';
import { awaitsFirstTouchSlot } from './dm-reservation';

export interface OutreachListFilters {
  campaign_id?: string | null;
  /** An /outreach TAB, not a raw column value. */
  status?: string | null;
  search?: string | null;
}

export type OutreachListResult =
  | { ok: true; rows: Record<string, unknown>[] }
  | { ok: false; httpStatus: number; body: Record<string, unknown> };

// qualification_status/_reason and influencers.blocklisted ride along so the
// /outreach UI can label a row the send path will refuse. They are
// surfaced, NOT filtered out: an excluded creator staying visible with its
// reason is the point — hiding the row would hide the exclusion. That gating
// work landed on main while this extraction was in flight; the columns move
// here unchanged.
/** Keeps each `.in()` request URL well under proxy limits (same bound as firm-blocks). */
export const MESSAGE_ID_CHUNK = 200;

const CI_SELECT = `
      id,
      campaign_id,
      composite_score,
      tier,
      outreach_priority,
      outreach_angle,
      outreach_status,
      message_count,
      last_outreach_at,
      last_response_at,
      response_classification,
      status,
      price_estimate_mid,
      bot_flagged,
      qualification_status,
      qualification_reason,
      influencer:influencers(id, username, display_name, platform, follower_count, engagement_rate, bio, contact_email, profile_url, blocklisted),
      campaign:campaigns(id, artist_name, status)
    `;

/**
 * List outreach rows for ONE firm.
 *
 * Every read is constrained to campaigns owned by `callerFirmId`. The
 * constraint is applied unconditionally, before any optional filter, so no
 * combination of query parameters can widen it:
 *
 *   - caller with no firm (firm_id '' for an unprovisioned Clerk user,
 *     src/lib/auth.ts:111)          → 403, never "all campaigns"
 *   - firm owns no campaigns yet    → [], never "all campaigns"
 *   - ?campaign_id= belonging to
 *     another firm                  → 403, not a silent empty
 *
 * `sb` is the SERVICE-ROLE client in production (requireSessionAndClient,
 * src/lib/auth.ts:155-161) and post-Clerk `auth.uid()` is NULL, so RLS
 * contributes nothing here. This function IS the boundary.
 */
export async function listOutreachForFirm(
  sb: SupabaseClient,
  callerFirmId: string | null | undefined,
  filters: OutreachListFilters = {}
): Promise<OutreachListResult> {
  const scope = checkFirmScope(callerFirmId, callerFirmId);
  if (!scope.ok) {
    return {
      ok: false,
      httpStatus: scope.httpStatus,
      body: firmScopeErrorBody(scope),
    };
  }

  const { data: ownCampaigns, error: campErr } = await sb
    .from('campaigns')
    .select('id')
    .eq('firm_id', scope.firmId);
  if (campErr) {
    return { ok: false, httpStatus: 500, body: { error: campErr.message } };
  }
  const ownCampaignIds = (ownCampaigns ?? []).map((c) => (c as { id: string }).id);

  const requested = filters.campaign_id;
  if (requested && !ownCampaignIds.includes(requested)) {
    return { ok: false, httpStatus: 403, body: { error: 'forbidden' } };
  }
  if (ownCampaignIds.length === 0) return { ok: true, rows: [] };

  let ciQuery = sb
    .from('campaign_influencers')
    .select(CI_SELECT)
    .eq('bot_flagged', false)
    // THE TENANT BOUNDARY. Unconditional, and before every optional filter.
    .in('campaign_id', ownCampaignIds)
    .order('composite_score', { ascending: false });

  if (requested) {
    ciQuery = ciQuery.eq('campaign_id', requested);
  }
  if (filters.status) {
    ciQuery = applyOutreachStatusTabFilter(ciQuery, filters.status);
  }

  const { data: campaignInfluencers, error: ciError } = await ciQuery;
  if (ciError) {
    return { ok: false, httpStatus: 500, body: { error: ciError.message } };
  }

  const ciIds = (campaignInfluencers ?? []).map((ci) => (ci as { id: string }).id);

  // Chunked: `.in()` goes in the URL, and ~450 UUIDs overflow it. The request
  // then fails, and because the error used to be ignored the all-campaigns
  // view silently showed every lead with zero messages — an empty DM queue.
  const messages: Record<string, unknown>[] = [];
  for (let i = 0; i < ciIds.length; i += MESSAGE_ID_CHUNK) {
    const { data: msgs, error: msgError } = await sb
      .from('outreach_messages')
      .select('*')
      .in('campaign_influencer_id', ciIds.slice(i, i + MESSAGE_ID_CHUNK))
      .order('created_at', { ascending: false });
    if (msgError) {
      return { ok: false, httpStatus: 500, body: { error: msgError.message } };
    }
    messages.push(...((msgs ?? []) as Record<string, unknown>[]));
  }
  messages.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));

  const messageMap = new Map<string, Record<string, unknown>[]>();
  for (const msg of messages) {
    const ciId = msg.campaign_influencer_id as string;
    if (!messageMap.has(ciId)) messageMap.set(ciId, []);
    messageMap.get(ciId)!.push(msg);
  }

  // Per-label do-not-contact (src/lib/firm-blocks.ts), stamped on every row as
  // `do_not_contact: 'blocked' | 'clear' | 'unknown'`. STAMPED, not filtered:
  // the email tabs keep showing an excluded creator with its reason (issue
  // #71). The DM queue is the consumer that HIDES — it is a list of things to
  // send by hand, so a do-not-contact row there is an invitation to break an
  // opt-out, and 'unknown' (list unreadable) is held rather than shown.
  const influencerOf = (row: Record<string, unknown>) =>
    row.influencer as { id?: string | null; blocklisted?: boolean | null } | null;
  const blocks = await readFirmBlocks(
    sb,
    scope.firmId,
    (campaignInfluencers ?? []).map((ci) => influencerOf(ci as Record<string, unknown>)?.id),
  );
  if (blocks.state === 'unreadable') {
    console.error('[outreach-listing] firm block list unreadable — DM queue rows held', blocks.message);
  }

  let rows: Record<string, unknown>[] = (campaignInfluencers ?? []).map((ci) => {
    const row = ci as Record<string, unknown>;
    const inf = influencerOf(row);
    return {
      ...row,
      do_not_contact: doNotContactVerdict(inf?.blocklisted, inf?.id, blocks),
      messages: messageMap.get(row.id as string) ?? [],
    };
  });

  if (filters.search) {
    const q = filters.search.toLowerCase();
    rows = rows.filter((r) => {
      const inf = r.influencer as Record<string, string> | null;
      if (!inf) return false;
      return (
        inf.username?.toLowerCase().includes(q) ||
        inf.display_name?.toLowerCase().includes(q)
      );
    });
  }

  // "Limit reached" before anyone copies a DM opener (src/lib/dm-reserve.ts).
  // Only leads with a waiting post-060 DM opener cost anything. Lazy: the gate
  // pulls in negotiation.ts, which this module's importers must not load
  // unless there is something to stamp.
  const nowMs = Date.now();
  if (rows.some((r) => awaitsFirstTouchSlot(r, nowMs))) {
    const { stampFirstTouchSlots } = await import('./dm-reserve');
    await stampFirstTouchSlots(sb, rows, nowMs);
  }

  return { ok: true, rows };
}
