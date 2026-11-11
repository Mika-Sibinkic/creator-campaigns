// src/app/api/analytics/route.ts
//
// USER PATH — money/outcome analytics for the firm (spec: negotiation-analytics
// "RL + measurement"). Firm-scoped via the cookie-bound Supabase client (RLS),
// auth-gated + rate-limited exactly like /api/dashboard and /api/campaigns/[id]/
// deals. Returns per-campaign metrics + a firm rollup:
//
//   {
//     firm: FirmAnalytics,                 // additive rollup across campaigns
//     campaigns: CampaignAnalytics[]       // per-campaign breakdown
//   }
//
// All computation is delegated to the pure functions in src/lib/analytics.ts;
// this route only does the RLS-scoped reads and merges them in JS (PostgREST
// embedded-filter grammar across 5 optional joins is brittle — mirror the deals
// route and fetch each table independently).

import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import {
  computeCampaignAnalytics,
  computeFirmRollup,
  type AnalyticsOfferRow,
  type AnalyticsOutcomeRow,
  type AnalyticsOutreachRow,
  type AnalyticsInboundRow,
  type AnalyticsCampaignRow,
  type CampaignAnalytics,
} from '@/lib/analytics';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }

  let sb, session;
  try {
    ({ sb, session } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }

  // 1. This firm's campaigns. Post-Clerk the client is service-role (RLS-inert),
  //    so the firm_id filter here is the authorization boundary — every step
  //    below scopes to these campaign ids, so scoping step 1 scopes the whole
  //    rollup. Synthetic (labeled-sample) campaigns are excluded so fabricated
  //    numbers never mix into the firm money rollup.
  const { data: campaignRows, error: cErr } = await sb
    .from('campaigns')
    .select('id, artist_name, status, total_budget_usd, budget')
    .eq('firm_id', session.firm_id)
    .eq('synthetic', false)
    .order('created_at', { ascending: false })
    .limit(200);
  if (cErr) {
    return NextResponse.json({ error: cErr.message }, { status: 500 });
  }
  const campaigns = (campaignRows ?? []) as AnalyticsCampaignRow[];
  if (campaigns.length === 0) {
    return NextResponse.json({ firm: computeFirmRollup([]), campaigns: [] });
  }
  const campaignIds = campaigns.map((c) => c.id);

  // 2. Offers for those campaigns (RLS-scoped by campaign → firm).
  const { data: offerRows, error: oErr } = await sb
    .from('creator_offers')
    .select(
      'id, campaign_id, campaign_influencer_id, status, agreed_amount_usd, current_offer_usd, initial_offer_usd, ceiling_usd, opening_pct',
    )
    .in('campaign_id', campaignIds);
  if (oErr) {
    return NextResponse.json({ error: oErr.message }, { status: 500 });
  }
  const offers = (offerRows ?? []) as AnalyticsOfferRow[];

  // 2b. Verified post impressions per offer, from the measurement tick's
  //     deal_performance_snapshots (latest snapshot per delivery). This is the
  //     ONLY reach signal CPM uses — real impressions, never streams/followers.
  const offerIds = offers.map((o) => o.id);
  const reachByOffer = new Map<string, number>();
  if (offerIds.length > 0) {
    const { data: delRows } = await sb
      .from('deal_deliveries')
      .select('id, creator_offer_id')
      .in('creator_offer_id', offerIds);
    const deliveries = (delRows ?? []) as Array<{ id: string; creator_offer_id: string }>;
    const delToOffer = new Map(deliveries.map((d) => [d.id, d.creator_offer_id]));
    const delIds = deliveries.map((d) => d.id);
    if (delIds.length > 0) {
      const { data: snapRows } = await sb
        .from('deal_performance_snapshots')
        .select('deal_delivery_id, views, captured_at')
        .in('deal_delivery_id', delIds);
      const latest = new Map<string, { views: number; at: number }>();
      for (const s of (snapRows ?? []) as Array<{
        deal_delivery_id: string;
        views: number | null;
        captured_at: string;
      }>) {
        const at = Date.parse(s.captured_at);
        const cur = latest.get(s.deal_delivery_id);
        if (!cur || at > cur.at) latest.set(s.deal_delivery_id, { views: Number(s.views) || 0, at });
      }
      for (const [delId, { views }] of latest) {
        const offerId = delToOffer.get(delId);
        if (offerId) reachByOffer.set(offerId, (reachByOffer.get(offerId) ?? 0) + views);
      }
    }
  }

  // 3. campaign_influencers (for CI→campaign mapping of outreach/inbound).
  const { data: ciRows, error: ciErr } = await sb
    .from('campaign_influencers')
    .select('id, campaign_id, influencer:influencers(follower_count)')
    .in('campaign_id', campaignIds);
  if (ciErr) {
    return NextResponse.json({ error: ciErr.message }, { status: 500 });
  }
  type CIRow = {
    id: string;
    campaign_id: string;
    influencer:
      | { follower_count: number | null }
      | Array<{ follower_count: number | null }>
      | null;
  };
  const cis = (ciRows ?? []) as unknown as CIRow[];
  const ciIds = cis.map((c) => c.id);
  const ciToCampaign = new Map<string, string>();
  for (const ci of cis) {
    ciToCampaign.set(ci.id, ci.campaign_id);
  }

  // 4. Outreach messages (direction/status) + inbound replies for those CIs.
  let outreach: (AnalyticsOutreachRow & { campaign_id: string | null })[] = [];
  let inbound: (AnalyticsInboundRow & { campaign_id: string | null })[] = [];
  if (ciIds.length > 0) {
    const { data: msgRows, error: mErr } = await sb
      .from('outreach_messages')
      .select('campaign_influencer_id, direction, status')
      .in('campaign_influencer_id', ciIds);
    if (mErr) {
      return NextResponse.json({ error: mErr.message }, { status: 500 });
    }
    outreach = ((msgRows ?? []) as AnalyticsOutreachRow[]).map((m) => ({
      ...m,
      campaign_id: m.campaign_influencer_id
        ? ciToCampaign.get(m.campaign_influencer_id) ?? null
        : null,
    }));

    const { data: inRows, error: inErr } = await sb
      .from('inbound_messages')
      .select('campaign_influencer_id')
      .in('campaign_influencer_id', ciIds);
    if (inErr) {
      return NextResponse.json({ error: inErr.message }, { status: 500 });
    }
    inbound = ((inRows ?? []) as AnalyticsInboundRow[]).map((r) => ({
      ...r,
      campaign_id: r.campaign_influencer_id
        ? ciToCampaign.get(r.campaign_influencer_id) ?? null
        : null,
    }));
  }

  // 5. Per-offer outcome measurements (creator_offer_id set; skip report rows).
  let outcomes: (AnalyticsOutcomeRow & { campaign_id: string })[] = [];
  const { data: ocRows, error: ocErr } = await sb
    .from('campaign_outcomes')
    .select(
      'campaign_id, creator_offer_id, streams_attributed, payment_usd_amount, follower_count_at_post',
    )
    .in('campaign_id', campaignIds);
  if (ocErr) {
    return NextResponse.json({ error: ocErr.message }, { status: 500 });
  }
  outcomes = ((ocRows ?? []) as Array<AnalyticsOutcomeRow & { campaign_id: string }>).filter(
    (o) => o.creator_offer_id != null,
  );

  // 6. Group by campaign + compute.
  const byCampaign = <T extends { campaign_id: string | null }>(
    rows: T[],
    campaignId: string,
  ): T[] => rows.filter((r) => r.campaign_id === campaignId);

  const results: CampaignAnalytics[] = campaigns.map((campaign) =>
    computeCampaignAnalytics({
      campaign,
      offers: offers.filter((o) => o.campaign_id === campaign.id),
      outcomes: byCampaign(outcomes, campaign.id),
      outreach: byCampaign(outreach, campaign.id),
      inbound: byCampaign(inbound, campaign.id),
      reachByOffer,
    }),
  );

  return NextResponse.json({
    firm: computeFirmRollup(results),
    campaigns: results,
  });
}
