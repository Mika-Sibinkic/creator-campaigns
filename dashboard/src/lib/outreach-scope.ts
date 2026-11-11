// src/lib/outreach-scope.ts
//
// Tenant gates for the /api/outreach/** routes that take a row id from the
// caller.
//
// Every one of those routes runs on the SERVICE-ROLE client
// (requireSessionAndClient, src/lib/auth.ts): Clerk sessions carry no Supabase
// JWT, so RLS never evaluates and the only tenant boundary is the one the
// route draws itself. A route that loads `outreach_messages` / a lead / a
// campaign by id without resolving its firm hands any signed-in user of any
// label another label's row.
//
// Each gate resolves the row's owning firm and compares it to the caller's
// with checkFirmScope (src/lib/firm-scope.ts) — fail-closed on a blank firm on
// either side. A miss is reported as NOT FOUND, not forbidden: a 403 would
// confirm to another tenant that the id exists.
//
// Operators get no bypass. Every other tenant-scoped route (campaigns list,
// simulate-reply, audit) pins even a platform operator to session.firm_id;
// operator status only widens WHAT they see inside their own firm.

import type { SupabaseClient } from '@supabase/supabase-js';
import { firmIdForCampaignInfluencer } from './channel-priors';
import { checkFirmScope } from './firm-scope';

export const OUTREACH_NOT_FOUND = { error: 'Message not found' } as const;

/** Does this outreach message belong to the caller's firm? False when the row
 *  is missing, unreadable, unowned, or another label's. Never throws. */
export async function outreachMessageInFirm(
  sb: SupabaseClient,
  messageId: string,
  callerFirmId: string | null | undefined,
): Promise<boolean> {
  try {
    const { data, error } = await sb
      .from('outreach_messages')
      .select('campaign_influencer_id')
      .eq('id', messageId)
      .maybeSingle();
    if (error || !data) return false;
    const ciId = (data as { campaign_influencer_id: string | null }).campaign_influencer_id;
    const owner = await firmIdForCampaignInfluencer(sb, ciId);
    return checkFirmScope(callerFirmId, owner).ok;
  } catch {
    return false;
  }
}

/** Does this lead (campaign_influencers row) belong to the caller's firm? */
export async function leadInFirm(
  sb: SupabaseClient,
  campaignInfluencerId: string,
  callerFirmId: string | null | undefined,
): Promise<boolean> {
  const owner = await firmIdForCampaignInfluencer(sb, campaignInfluencerId);
  return checkFirmScope(callerFirmId, owner).ok;
}

/** Does this campaign belong to the caller's firm? Never throws. */
export async function campaignInFirm(
  sb: SupabaseClient,
  campaignId: string,
  callerFirmId: string | null | undefined,
): Promise<boolean> {
  try {
    const { data, error } = await sb
      .from('campaigns')
      .select('firm_id')
      .eq('id', campaignId)
      .maybeSingle();
    if (error || !data) return false;
    return checkFirmScope(callerFirmId, (data as { firm_id: string | null }).firm_id).ok;
  } catch {
    return false;
  }
}
