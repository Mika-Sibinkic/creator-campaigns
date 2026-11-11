// src/app/api/analytics/correlations/route.ts
//
// GET /api/analytics/correlations?scope=real|sample|campaign[&campaign_id=<uuid>]
//
// Correlation report for the /analytics page. Deliberately a NEW
// route — /api/analytics is polled every 30s by AnalyticsCard; correlations
// are heavier and differently scoped.
//
// SECURITY-OK: supabaseAdmin. requireSession() runs
// first, and every campaigns read is explicitly scoped to session.firm_id;
// all downstream reads are keyed off those firm-owned campaign ids. The
// service-role client is REQUIRED here (not convenience): the influencers
// RLS SELECT policy is USING (synthetic = false) (migration
// 007_auth_rls.sql:162), so sample creators are invisible to the
// cookie-bound client — and the sample scope of this report is built
// entirely from them. Same session-then-admin pattern as
// /api/outcomes/record and the quick-offer route.
//
// Scope kinds: real → pool of synthetic=false campaigns; sample → pool of
// synthetic=true; campaign → that one campaign (its own flag). There is
// deliberately NO scope that unions both — and computeCorrelationReport
// throws if handed mixed rows anyway.

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { requireSession } from '@/lib/auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import {
  buildDealFactorRows,
  computeCorrelationReport,
  type BuildDealFactorRowsInput,
  type CorrelationReport,
  type CorrelationScope,
} from '@/lib/correlation';

export const runtime = 'nodejs';

type CampaignRow = { id: string; artist_name: string; status: string | null; synthetic: boolean };
type OfferRow = BuildDealFactorRowsInput['offers'][number];
type OutcomeRow = BuildDealFactorRowsInput['outcomes'][number] & { campaign_id: string | null };
type CiRow = BuildDealFactorRowsInput['cis'][number];
type InfluencerRow = BuildDealFactorRowsInput['influencers'][number];
type SendRow = BuildDealFactorRowsInput['firstSends'][number];

export async function GET(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }

  let session;
  try {
    session = await requireSession();
  } catch (r) {
    return r as Response;
  }

  const params = req.nextUrl.searchParams;
  const scopeParam = params.get('scope') ?? 'real';
  if (scopeParam !== 'real' && scopeParam !== 'sample' && scopeParam !== 'campaign') {
    return NextResponse.json(
      { error: 'invalid_scope', detail: "scope must be 'real', 'sample', or 'campaign'" },
      { status: 400 },
    );
  }
  const campaignIdParam = params.get('campaign_id');
  if (scopeParam === 'campaign' && !campaignIdParam) {
    return NextResponse.json(
      { error: 'campaign_id_required', detail: "campaign_id is required when scope='campaign'" },
      { status: 400 },
    );
  }

  const sb = supabaseAdmin();

  // 1. All firm campaigns — drives the page selector AND the scope filter.
  //    Every downstream read is keyed off these firm-owned ids.
  const { data: campaignRows, error: cErr } = await sb
    .from('campaigns')
    .select('id, artist_name, status, synthetic')
    .eq('firm_id', session.firm_id)
    .order('created_at', { ascending: false })
    .limit(200);
  if (cErr) {
    return NextResponse.json({ error: cErr.message }, { status: 500 });
  }
  const campaigns = (campaignRows ?? []) as unknown as CampaignRow[];

  // 2. Resolve the scope to a campaign set + synthetic flag.
  let scopeCampaigns: CampaignRow[];
  let scope: CorrelationScope;
  if (scopeParam === 'campaign') {
    const target = campaigns.find((c) => c.id === campaignIdParam);
    if (!target) {
      return NextResponse.json({ error: 'campaign_not_found' }, { status: 404 });
    }
    scopeCampaigns = [target];
    scope = { kind: 'campaign', campaign_ids: [target.id], synthetic: target.synthetic };
  } else {
    const wantSynthetic = scopeParam === 'sample';
    scopeCampaigns = campaigns.filter((c) => c.synthetic === wantSynthetic);
    scope = {
      kind: 'pool',
      campaign_ids: scopeCampaigns.map((c) => c.id),
      synthetic: wantSynthetic,
    };
  }

  const allCampaignIds = campaigns.map((c) => c.id);
  const scopeIds = scope.campaign_ids;

  // 3. Outcomes across ALL firm campaigns — one query serves both the
  //    per-campaign deals_measured selector counts and the report join
  //    (buildDealFactorRows matches on creator_offer_id, so out-of-scope
  //    outcome rows never leak into the report).
  let outcomes: OutcomeRow[] = [];
  if (allCampaignIds.length > 0) {
    const { data: ocRows, error: ocErr } = await sb
      .from('campaign_outcomes')
      .select(
        'campaign_id, creator_offer_id, streams_attributed, payment_usd_amount, follower_count_at_post, engagement_at_post',
      )
      .in('campaign_id', allCampaignIds);
    if (ocErr) {
      return NextResponse.json({ error: ocErr.message }, { status: 500 });
    }
    outcomes = (ocRows ?? []) as unknown as OutcomeRow[];
  }

  // 4. Scope-only reads: offers, CIs, influencers, earliest sent outbound.
  //    Mirror /api/analytics: fetch each table independently, merge in JS.
  let offers: OfferRow[] = [];
  let cis: CiRow[] = [];
  let influencers: InfluencerRow[] = [];
  let firstSends: SendRow[] = [];
  if (scopeIds.length > 0) {
    const { data: offerRows, error: oErr } = await sb
      .from('creator_offers')
      .select(
        'id, campaign_id, campaign_influencer_id, agreed_amount_usd, initial_offer_usd, ceiling_usd, perceived_generosity, price_give_pct, post_url',
      )
      .in('campaign_id', scopeIds);
    if (oErr) {
      return NextResponse.json({ error: oErr.message }, { status: 500 });
    }
    offers = (offerRows ?? []) as unknown as OfferRow[];

    const { data: ciRows, error: ciErr } = await sb
      .from('campaign_influencers')
      .select('id, campaign_id, influencer_id, primary_channel')
      .in('campaign_id', scopeIds);
    if (ciErr) {
      return NextResponse.json({ error: ciErr.message }, { status: 500 });
    }
    cis = (ciRows ?? []) as unknown as CiRow[];

    const infIds = [...new Set(cis.map((c) => c.influencer_id).filter((id): id is string => id != null))];
    if (infIds.length > 0) {
      const { data: infRows, error: infErr } = await sb
        .from('influencers')
        .select('id, follower_count, engagement_rate, content_genres')
        .in('id', infIds);
      if (infErr) {
        return NextResponse.json({ error: infErr.message }, { status: 500 });
      }
      influencers = (infRows ?? []) as unknown as InfluencerRow[];
    }

    const ciIds = cis.map((c) => c.id);
    if (ciIds.length > 0) {
      const { data: msgRows, error: mErr } = await sb
        .from('outreach_messages')
        .select('campaign_influencer_id, channel, sent_at')
        .eq('direction', 'outbound')
        .eq('status', 'sent')
        .in('campaign_influencer_id', ciIds);
      if (mErr) {
        return NextResponse.json({ error: mErr.message }, { status: 500 });
      }
      // Reduce to the earliest send per CI (send-window/channel factors).
      const earliest = new Map<string, SendRow>();
      for (const m of (msgRows ?? []) as unknown as SendRow[]) {
        if (!m.campaign_influencer_id) continue;
        const prev = earliest.get(m.campaign_influencer_id);
        const tNew = m.sent_at != null ? Date.parse(m.sent_at) : NaN;
        const tPrev = prev?.sent_at != null ? Date.parse(prev.sent_at) : NaN;
        if (!prev || (!Number.isNaN(tNew) && (Number.isNaN(tPrev) || tNew < tPrev))) {
          earliest.set(m.campaign_influencer_id, m);
        }
      }
      firstSends = [...earliest.values()];
    }
  }

  // 5. Assemble rows + compute the report (pure — src/lib/correlation.ts).
  const rows = buildDealFactorRows({
    campaigns: scopeCampaigns.map((c) => ({ id: c.id, synthetic: c.synthetic })),
    offers,
    outcomes,
    cis,
    influencers,
    firstSends,
  });

  let report: CorrelationReport;
  try {
    report = computeCorrelationReport(rows, scope);
  } catch (e) {
    // The engine throws on mixed real/synthetic rows. Reaching this
    // from the scoping above would mean a data-integrity failure — surface
    // it loudly instead of serving a blended report.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'correlation_failed' },
      { status: 500 },
    );
  }

  // 6. Selector metadata: measured-deal counts per firm campaign.
  const measuredByCampaign = new Map<string, number>();
  for (const o of outcomes) {
    if (o.campaign_id == null || o.creator_offer_id == null || o.streams_attributed == null) continue;
    measuredByCampaign.set(o.campaign_id, (measuredByCampaign.get(o.campaign_id) ?? 0) + 1);
  }

  return NextResponse.json({
    campaigns: campaigns.map((c) => ({
      id: c.id,
      artist_name: c.artist_name,
      synthetic: c.synthetic,
      deals_measured: measuredByCampaign.get(c.id) ?? 0,
    })),
    report,
  });
}
