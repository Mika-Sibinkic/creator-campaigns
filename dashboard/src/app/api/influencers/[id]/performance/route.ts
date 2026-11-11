// src/app/api/influencers/[id]/performance/route.ts
//
// USER PATH — per-creator per-deal performance + cross-campaign rollup.
// All math lives in src/lib/creator-performance.ts (pure, fixture-tested);
// this route only does the scoped reads and hands rows in — the exact
// arrangement /api/analytics has with src/lib/analytics.ts.
//
// Scoping: post-Clerk the cookie client is service-role (RLS-inert), so the
// campaigns .eq('firm_id', session.firm_id) filter in step 1 is the
// authorization boundary — every later read is keyed off those campaign ids,
// so scoping step 1 scopes the whole profile (mirrors /api/analytics).
// Synthetic ([SAMPLE]) campaigns are excluded at the query, and
// computeCreatorPerformance excludes them again defensively.

import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import {
  computeCreatorPerformance,
  type PerfCampaignRow,
  type PerfCiRow,
  type PerfOfferRow,
  type PerfOutreachRow,
  type PerfInboundRow,
  type PerfDeliveryRow,
  type PerfSnapshotRow,
  type PerfOutcomeRow,
} from '@/lib/creator-performance';

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  const { id } = await params;

  let sb, session;
  try {
    ({ sb, session } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }

  const emptyBody = () =>
    NextResponse.json(
      computeCreatorPerformance({
        influencer_id: id,
        campaigns: [],
        cis: [],
        offers: [],
        outreach: [],
        inbound: [],
        deliveries: [],
        snapshots: [],
        outcomes: [],
      }),
    );

  // 1. This firm's real campaigns — the authorization boundary.
  const { data: campaignRows, error: cErr } = await sb
    .from('campaigns')
    .select('id, artist_name, synthetic')
    .eq('firm_id', session.firm_id)
    .eq('synthetic', false)
    .limit(500);
  if (cErr) {
    return NextResponse.json({ error: cErr.message }, { status: 500 });
  }
  const campaigns = (campaignRows ?? []) as PerfCampaignRow[];
  if (campaigns.length === 0) return emptyBody();
  const campaignIds = campaigns.map((c) => c.id);

  // 2. This influencer's appearances inside those campaigns.
  const { data: ciRows, error: ciErr } = await sb
    .from('campaign_influencers')
    .select('id, campaign_id')
    .eq('influencer_id', id)
    .in('campaign_id', campaignIds);
  if (ciErr) {
    return NextResponse.json({ error: ciErr.message }, { status: 500 });
  }
  const cis = (ciRows ?? []) as PerfCiRow[];
  if (cis.length === 0) return emptyBody();
  const ciIds = cis.map((c) => c.id);

  // 3. Offers on those appearances.
  const { data: offerRows, error: oErr } = await sb
    .from('creator_offers')
    .select(
      'id, campaign_id, campaign_influencer_id, status, initial_offer_usd, agreed_amount_usd, ceiling_usd, opening_pct, rounds, perceived_generosity, price_give_pct, agreed_deliverables, created_at',
    )
    .in('campaign_influencer_id', ciIds);
  if (oErr) {
    return NextResponse.json({ error: oErr.message }, { status: 500 });
  }
  const offers = (offerRows ?? []) as PerfOfferRow[];
  const offerIds = offers.map((o) => o.id);

  // 4. Outreach + replies (reply-latency + contacted).
  const { data: msgRows, error: mErr } = await sb
    .from('outreach_messages')
    .select('campaign_influencer_id, direction, status, sent_at')
    .in('campaign_influencer_id', ciIds);
  if (mErr) {
    return NextResponse.json({ error: mErr.message }, { status: 500 });
  }
  const { data: inRows, error: inErr } = await sb
    .from('inbound_messages')
    .select('campaign_influencer_id, received_at')
    .in('campaign_influencer_id', ciIds);
  if (inErr) {
    return NextResponse.json({ error: inErr.message }, { status: 500 });
  }

  // 5. Deliveries + their performance snapshots.
  let deliveries: PerfDeliveryRow[] = [];
  let snapshots: PerfSnapshotRow[] = [];
  if (offerIds.length > 0) {
    const { data: delRows, error: dErr } = await sb
      .from('deal_deliveries')
      .select('id, creator_offer_id, status, spec_check')
      .in('creator_offer_id', offerIds);
    if (dErr) {
      return NextResponse.json({ error: dErr.message }, { status: 500 });
    }
    deliveries = (delRows ?? []) as PerfDeliveryRow[];
    const delIds = deliveries.map((d) => d.id);
    if (delIds.length > 0) {
      const { data: snapRows, error: sErr } = await sb
        .from('deal_performance_snapshots')
        .select('deal_delivery_id, captured_at, views, likes, comments, shares')
        .in('deal_delivery_id', delIds);
      if (sErr) {
        return NextResponse.json({ error: sErr.message }, { status: 500 });
      }
      snapshots = (snapRows ?? []) as PerfSnapshotRow[];
    }
  }

  // 6. Recorded per-deal outcomes (streams + attribution label).
  let outcomes: PerfOutcomeRow[] = [];
  if (offerIds.length > 0) {
    const { data: ocRows, error: ocErr } = await sb
      .from('campaign_outcomes')
      .select(
        'creator_offer_id, streams_attributed, streams_attribution_method, payment_usd_amount, measured_at',
      )
      .in('creator_offer_id', offerIds);
    if (ocErr) {
      return NextResponse.json({ error: ocErr.message }, { status: 500 });
    }
    outcomes = (ocRows ?? []) as PerfOutcomeRow[];
  }

  return NextResponse.json(
    computeCreatorPerformance({
      influencer_id: id,
      campaigns,
      cis,
      offers,
      outreach: (msgRows ?? []) as PerfOutreachRow[],
      inbound: (inRows ?? []) as PerfInboundRow[],
      deliveries,
      snapshots,
      outcomes,
    }),
  );
}
