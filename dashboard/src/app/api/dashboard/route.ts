// src/app/api/dashboard/route.ts
//
// USER PATH — single aggregate endpoint behind the landing page at `/`. The
// page polls this every 30s; the activity feed polls /api/audit separately.
//
// TWO UNITS, NEVER THE SAME WORD. This endpoint used to return a per-campaign
// progress object whose `sent` counted CREATORS with an outbound message at
// status 'sent', alongside a funnel whose `sent` counted creator_offers in
// offered|counter_offered|agreed. Two different populations, one word, rendered
// ~300px apart on the same screen. They are now separated by name and by unit:
//
//   creator_progress — counts CREATORS moving through outreach
//   deal_stages      — counts DEALS (creator_offers) moving through the money path
//
// No key appears in both, and no metric is emitted twice.
//
// Response shape:
//   {
//     active_campaign:
//       | { id, artist_name, status, track_name, last_activity_at,
//           creator_progress: { found, drafted, contacted } }
//       | null
//     deal_stages: {                            // for the active campaign
//       offer_out, agreed, awaiting_approval, approved,
//       paid, posted, measured, declined
//     }
//     approvals_pending_count: number
//   }
//
// Scoping: `requireSessionAndClient()` returns the service-role client, which
// is RLS-inert — the `.eq('firm_id', …)` below is the tenancy boundary.

import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';

export const runtime = 'nodejs';

// Status values considered "live" — i.e. worthy of the hero. Defensive
// superset: production currently uses draft/discovering/discovered/outreach/
// active/completed/paused, but the spec mentions running/running_discovery/
// sending/negotiating so we accept them too. Whichever matches first wins.
const ACTIVE_STATUSES = new Set([
  'active',
  'running',
  'running_discovery',
  'discovering',
  'outreach',
  'sending',
  'negotiating',
]);

/** DEALS. One creator_offers row = one deal, counted in exactly one stage. */
interface DealStages {
  /** Offer made, creator has not agreed yet (incl. an open counter). */
  offer_out: number;
  /** Price agreed, not yet approved or paid. */
  agreed: number;
  awaiting_approval: number;
  approved: number;
  paid: number;
  posted: number;
  measured: number;
  /** Rejected by either side, or failed. */
  declined: number;
}

const EMPTY_DEAL_STAGES: DealStages = {
  offer_out: 0,
  agreed: 0,
  awaiting_approval: 0,
  approved: 0,
  paid: 0,
  posted: 0,
  measured: 0,
  declined: 0,
};

export async function GET(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }

  let session;
  let sb;
  try {
    ({ session, sb } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }

  // 1. Campaigns for this firm. Synthetic (labeled-sample) campaigns are
  //    excluded so fabricated rows never hijack the active-campaign pick.
  const { data: campaignRows, error: cErr } = await sb
    .from('campaigns')
    .select('id, artist_name, status, track_name, created_at')
    .eq('firm_id', session.firm_id)
    .eq('synthetic', false)
    .order('created_at', { ascending: false })
    .limit(12);
  if (cErr) {
    return NextResponse.json({ error: cErr.message }, { status: 500 });
  }
  type CampaignRow = {
    id: string;
    artist_name: string;
    status: string;
    track_name: string | null;
    created_at: string;
  };
  const campaigns = (campaignRows ?? []) as CampaignRow[];

  // 2. Approvals badge (cheap count head query, same shape as the dedicated
  //    /api/approvals/count endpoint).
  const { count: approvalsPendingCount } = await sb
    .from('payment_authorizations')
    .select('id', { count: 'exact', head: true })
    .eq('firm_id', session.firm_id)
    .eq('status', 'pending_human_review');

  // 3. Pick the active campaign — first one whose status is in ACTIVE_STATUSES.
  const activeCampaign = campaigns.find((c) => ACTIVE_STATUSES.has(c.status)) ?? null;

  // 4. Creator progress + deal stages for the active campaign. If there is
  //    none, return zeros and skip the joins entirely.
  const dealStages: DealStages = { ...EMPTY_DEAL_STAGES };
  const creatorProgress = { found: 0, drafted: 0, contacted: 0 };
  let lastActivityAt: string | null = null;

  if (activeCampaign) {
    // 4a. campaign_influencers — creators discovered for this campaign.
    const { data: ciRows } = await sb
      .from('campaign_influencers')
      .select('id')
      .eq('campaign_id', activeCampaign.id);
    type CIRow = { id: string };
    const cis = (ciRows ?? []) as CIRow[];
    creatorProgress.found = cis.length;
    const ciIds = cis.map((r) => r.id);

    // 4b. outreach_messages — drafted (any outbound row) and contacted
    //     (outbound status='sent'). Both count DISTINCT CREATORS, not messages:
    //     three follow-ups to one creator is one creator contacted.
    if (ciIds.length > 0) {
      const { data: msgRows } = await sb
        .from('outreach_messages')
        .select('campaign_influencer_id, direction, status')
        .in('campaign_influencer_id', ciIds);
      type MsgRow = {
        campaign_influencer_id: string;
        direction: string | null;
        status: string | null;
      };
      const msgs = (msgRows ?? []) as MsgRow[];
      const draftedCis = new Set<string>();
      const contactedCis = new Set<string>();
      for (const m of msgs) {
        if (m.direction === 'outbound') {
          draftedCis.add(m.campaign_influencer_id);
          if (m.status === 'sent') contactedCis.add(m.campaign_influencer_id);
        }
      }
      creatorProgress.drafted = draftedCis.size;
      creatorProgress.contacted = contactedCis.size;
    }

    // 4c. creator_offers — bucket each DEAL into exactly one stage.
    const { data: offerRows } = await sb
      .from('creator_offers')
      .select('status')
      .eq('campaign_id', activeCampaign.id);
    type OfferRow = { status: string };
    const offers = (offerRows ?? []) as OfferRow[];
    for (const o of offers) {
      switch (o.status) {
        case 'offered':
        case 'counter_offered':
          dealStages.offer_out += 1;
          break;
        case 'agreed':
          dealStages.agreed += 1;
          break;
        case 'human_approval_required':
          dealStages.awaiting_approval += 1;
          break;
        case 'approved':
          dealStages.approved += 1;
          break;
        case 'paid':
          dealStages.paid += 1;
          break;
        case 'posted':
          dealStages.posted += 1;
          break;
        case 'measured':
          dealStages.measured += 1;
          break;
        case 'rejected':
        case 'failed':
          dealStages.declined += 1;
          break;
        default:
          break; // queued / unknown → not a stage yet
      }
    }

    // 5. Last activity on the active campaign. The only reason this survives
    //    the removal of the "Recent campaigns" block: a campaign that says
    //    "Active" while nothing has happened for a week is the one fact the
    //    hero must not hide. Scoped to one campaign — the old version scanned
    //    200 audit rows for six campaigns on every 30s poll.
    const { data: auditRows } = await sb
      .from('audit_log')
      .select('occurred_at')
      .eq('target_type', 'campaign')
      .eq('target_id', activeCampaign.id)
      .order('occurred_at', { ascending: false })
      .limit(1);
    const latest = (auditRows ?? []) as Array<{ occurred_at: string }>;
    lastActivityAt = latest[0]?.occurred_at ?? null;
  }

  return NextResponse.json({
    active_campaign: activeCampaign
      ? {
          id: activeCampaign.id,
          artist_name: activeCampaign.artist_name,
          status: activeCampaign.status,
          track_name: activeCampaign.track_name,
          last_activity_at: lastActivityAt,
          creator_progress: creatorProgress,
        }
      : null,
    deal_stages: dealStages,
    approvals_pending_count: approvalsPendingCount ?? 0,
  });
}
