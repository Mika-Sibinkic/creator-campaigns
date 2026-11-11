// src/app/api/campaigns/[id]/lift/route.ts
//
// USER PATH — campaign streaming lift.
//
//   GET /api/campaigns/[id]/lift → CampaignLift
//
// Reads three things and hands them to a pure function:
//   campaigns.artist_baseline          the confirm-time anchor + pre-campaign
//                                      trend window
//   artist_metric_snapshots            the daily readings the measurement tick
//                                      backfills
//   creator_offers.posted_at           when each deal's post went live
//
// All the arithmetic — and, more importantly, every decision about what we
// refuse to claim — lives in src/lib/stream-lift.ts, which is pure and
// hermetically tested. This file only queries and gates.
//
// Deliberately NOT persisted. The lift is a derivation of rows we already
// store, so computing it on read means it can never drift from its inputs and
// no cached number can outlive the data that justified it.
//
// Post-Clerk the client is service-role (RLS-inert), so the
// .eq('firm_id', session.firm_id) on the campaign lookup is the authorization
// boundary — every query below keys off the gated campaign id. Read-only: no
// audit writes, no outbound API calls (the Soundcharts fetch belongs to the
// measurement tick, not to a page load).

import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import {
  computeCampaignLift,
  type LiftDealInput,
  type SeriesPoint,
} from '@/lib/stream-lift';

export const runtime = 'nodejs';

interface BaselineJson {
  spotify_listeners?: number | null;
  listeners_date?: string | null;
  captured_at?: string | null;
  artist?: { name?: string | null; image_url?: string | null } | null;
  pre_window?: { start?: string; end?: string; points?: SeriesPoint[] } | null;
  errors?: string[];
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  const { id: campaignId } = await params;

  let sb, session;
  try {
    ({ sb, session } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }

  // Firm ownership GATE for the whole route (see header comment).
  const { data: campaign, error: cErr } = await sb
    .from('campaigns')
    .select('id, artist_name, artist_soundcharts_uuid, artist_baseline, confirmed_at')
    .eq('id', campaignId)
    .eq('firm_id', session.firm_id)
    .single();
  if (cErr || !campaign) {
    return NextResponse.json({ error: 'campaign_not_found' }, { status: 404 });
  }
  const c = campaign as {
    id: string;
    artist_name: string;
    artist_soundcharts_uuid: string | null;
    artist_baseline: unknown;
    confirmed_at: string | null;
  };

  const baseline = (c.artist_baseline ?? null) as BaselineJson | null;

  // Readings. Rows written before migration 038 carry no metric_date; they are
  // dropped rather than back-dated from captured_at, which is a poll time and
  // would invent a data point. `.order` keeps the newest first if the column
  // is missing entirely (pre-038), where the select itself errors out.
  const { data: snapRows } = await sb
    .from('artist_metric_snapshots')
    .select('value, metric_date, captured_at')
    .eq('campaign_id', c.id)
    .eq('metric', 'spotify_listeners');
  const snapshots: SeriesPoint[] = ((snapRows ?? []) as Array<{
    value: number | string | null;
    metric_date: string | null;
  }>)
    .filter((r) => r.metric_date != null && r.value != null)
    .map((r) => ({ date: String(r.metric_date), value: Number(r.value) }))
    .filter((p) => Number.isFinite(p.value));

  // Deals. `posted_at` is the only timestamp that marks a post going live.
  const { data: offerRows } = await sb
    .from('creator_offers')
    .select('id, posted_at, campaign_influencer_id')
    .eq('campaign_id', c.id)
    .not('posted_at', 'is', null);
  const offers = (offerRows ?? []) as Array<{
    id: string;
    posted_at: string | null;
    campaign_influencer_id: string | null;
  }>;

  // Creator handles for display, resolved in two hops (creator_offers has no
  // direct influencer_id). Best-effort: a missing handle degrades the label,
  // never the number.
  const labels = new Map<string, string>();
  const ciIds = offers.map((o) => o.campaign_influencer_id).filter((x): x is string => !!x);
  if (ciIds.length > 0) {
    const { data: ciRows } = await sb
      .from('campaign_influencers')
      .select('id, influencer_id')
      .in('id', ciIds);
    const cis = (ciRows ?? []) as Array<{ id: string; influencer_id: string | null }>;
    const infIds = cis.map((x) => x.influencer_id).filter((x): x is string => !!x);
    if (infIds.length > 0) {
      const { data: infRows } = await sb
        .from('influencers')
        .select('id, username')
        .in('id', infIds);
      const byInf = new Map(
        ((infRows ?? []) as Array<{ id: string; username: string | null }>).map((i) => [
          i.id,
          i.username,
        ]),
      );
      for (const ci of cis) {
        const u = ci.influencer_id ? byInf.get(ci.influencer_id) : null;
        if (u) labels.set(ci.id, u);
      }
    }
  }

  const deals: LiftDealInput[] = offers.map((o) => ({
    id: o.id,
    creator_label: o.campaign_influencer_id
      ? (labels.get(o.campaign_influencer_id) ?? null)
      : null,
    posted_at: o.posted_at,
  }));

  const lift = computeCampaignLift({
    metric: 'spotify_listeners',
    baseline: {
      value: baseline?.spotify_listeners ?? null,
      date: baseline?.listeners_date ?? null,
      captured_at: baseline?.captured_at ?? c.confirmed_at ?? null,
      pre_window: baseline?.pre_window?.points ?? [],
    },
    snapshots,
    deals,
  });

  return NextResponse.json({
    campaign_id: c.id,
    artist_name: baseline?.artist?.name ?? c.artist_name,
    artist_confirmed: !!c.artist_soundcharts_uuid,
    lift,
  });
}
