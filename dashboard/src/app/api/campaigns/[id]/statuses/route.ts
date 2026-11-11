// src/app/api/campaigns/[id]/statuses/route.ts
//
// USER PATH — statuses dashboard, campaign-scoped half.
//
// Two read-only modes on one route (the statuses surface is one feature and
// the firm gate + campaign gate are identical for both):
//
//   GET /api/campaigns/[id]/statuses            → campaign state header
//       budget consumed vs total, deals by stage, response rate,
//       CPM-to-date (omitted when there is no verified reach — never faked),
//       qualification split.
//
//   GET /api/campaigns/[id]/statuses?ci=<uuid>  → full conversation thread
//       for one campaign_influencer: outbound outreach_messages, inbound
//       replies (flag state + classification), audit_log system events for
//       the CI's offer/payment rows, and delivery facts synthesized from
//       deal_deliveries (deliveries write no audit rows).
//
// All assembly logic lives in src/lib/statuses.ts (pure, hermetically
// tested); this file only queries and gates. Post-Clerk the client is
// service-role (RLS-inert), so the .eq('firm_id', session.firm_id) on the
// campaign lookup is the authorization boundary — every query below keys
// off the gated campaign id. Read-only: no audit writes.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSessionAndClient } from '@/lib/auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { describeDeliverables, normalizeDeliverables } from '@/lib/deliverables';
import { isHumanTakeover } from '@/lib/takeover-state';
import { readLastSentOffers } from '@/lib/last-sent-offer';
import {
  assembleThread,
  computeCampaignState,
  type ThreadAuditRow,
  type ThreadDeliveryRow,
  type ThreadInboundRow,
  type ThreadOutboundRow,
} from '@/lib/statuses';

export const runtime = 'nodejs';

const StatusesQuery = z.object({
  ci: z.string().uuid().optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  const { id: campaignId } = await params;

  const parsed = StatusesQuery.safeParse(
    Object.fromEntries(req.nextUrl.searchParams)
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_failed', issues: z.treeifyError(parsed.error) },
      { status: 422 }
    );
  }

  let sb, session;
  try {
    ({ sb, session } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }

  // Firm ownership GATE for the whole route (see header comment).
  const { data: campaign, error: cErr } = await sb
    .from('campaigns')
    .select('id, artist_name, track_name, status, total_budget_usd, budget')
    .eq('id', campaignId)
    .eq('firm_id', session.firm_id)
    .single();
  if (cErr || !campaign) {
    return NextResponse.json({ error: 'campaign_not_found' }, { status: 404 });
  }

  if (parsed.data.ci) {
    return threadResponse(sb, campaignId, parsed.data.ci);
  }
  return stateResponse(sb, campaign as CampaignRow);
}

interface CampaignRow {
  id: string;
  artist_name: string;
  track_name: string | null;
  status: string;
  total_budget_usd: number | null;
  budget: number | null;
}

type Sb = Awaited<
  ReturnType<typeof requireSessionAndClient>
>['sb'];

// ─── mode 1: campaign state header ───────────────────────────────────────────

async function stateResponse(sb: Sb, campaign: CampaignRow) {
  const { data: ciRows, error: ciErr } = await sb
    .from('campaign_influencers')
    .select('id, qualification_status, qualification_reason')
    .eq('campaign_id', campaign.id);
  if (ciErr) {
    return NextResponse.json({ error: ciErr.message }, { status: 500 });
  }
  const cis = (ciRows ?? []) as {
    id: string;
    qualification_status: string | null;
    qualification_reason: string | null;
  }[];
  const ciIds = cis.map((c) => c.id);

  const { data: offerRows, error: oErr } = await sb
    .from('creator_offers')
    .select('id, status')
    .eq('campaign_id', campaign.id);
  if (oErr) {
    return NextResponse.json({ error: oErr.message }, { status: 500 });
  }
  const offers = (offerRows ?? []) as { id: string; status: string }[];
  const offerIds = offers.map((o) => o.id);

  const { data: payRows, error: pErr } = await sb
    .from('payment_authorizations')
    .select('status, amount_usd')
    .eq('campaign_id', campaign.id);
  if (pErr) {
    return NextResponse.json({ error: pErr.message }, { status: 500 });
  }

  let outreach: { campaign_influencer_id: string; status: string | null }[] = [];
  let inbound: { campaign_influencer_id: string | null }[] = [];
  if (ciIds.length > 0) {
    const { data: omRows, error: omErr } = await sb
      .from('outreach_messages')
      .select('campaign_influencer_id, status')
      .in('campaign_influencer_id', ciIds)
      .eq('direction', 'outbound');
    if (omErr) {
      return NextResponse.json({ error: omErr.message }, { status: 500 });
    }
    outreach = (omRows ?? []) as typeof outreach;

    const { data: inRows, error: inErr } = await sb
      .from('inbound_messages')
      .select('campaign_influencer_id')
      .in('campaign_influencer_id', ciIds);
    if (inErr) {
      return NextResponse.json({ error: inErr.message }, { status: 500 });
    }
    inbound = (inRows ?? []) as typeof inbound;
  }

  // Verified reach: latest performance snapshot per verified delivery,
  // summed. No snapshots → reachViews stays null and CPM is omitted.
  let reachViews: number | null = null;
  if (offerIds.length > 0) {
    const { data: delRows } = await sb
      .from('deal_deliveries')
      .select('id, status')
      .in('creator_offer_id', offerIds)
      .eq('status', 'verified');
    const deliveryIds = ((delRows ?? []) as { id: string }[]).map((d) => d.id);
    if (deliveryIds.length > 0) {
      const { data: snapRows } = await sb
        .from('deal_performance_snapshots')
        .select('deal_delivery_id, views, captured_at')
        .in('deal_delivery_id', deliveryIds)
        .order('captured_at', { ascending: false });
      const latestByDelivery = new Map<string, number>();
      for (const s of (snapRows ?? []) as {
        deal_delivery_id: string;
        views: number | null;
      }[]) {
        if (!latestByDelivery.has(s.deal_delivery_id)) {
          latestByDelivery.set(s.deal_delivery_id, Number(s.views) || 0);
        }
      }
      if (latestByDelivery.size > 0) {
        reachViews = [...latestByDelivery.values()].reduce((a, b) => a + b, 0);
      }
    }
  }

  const state = computeCampaignState({
    budgetUsd:
      campaign.total_budget_usd != null
        ? Number(campaign.total_budget_usd)
        : campaign.budget != null
          ? Number(campaign.budget)
          : null,
    authorizations: ((payRows ?? []) as { status: string; amount_usd: number }[]).map(
      (p) => ({ status: p.status, amount_usd: Number(p.amount_usd) })
    ),
    offers,
    outreach,
    inbound,
    cis,
    reachViews,
  });

  return NextResponse.json({ state });
}

// ─── mode 2: per-creator conversation thread ─────────────────────────────────

async function threadResponse(sb: Sb, campaignId: string, ciId: string) {
  // The CI must belong to the gated campaign — a valid uuid from another
  // firm's campaign 404s here.
  const { data: ciRow, error: ciErr } = await sb
    .from('campaign_influencers')
    .select('id, campaign_id, influencer:influencers(id, username, display_name)')
    .eq('id', ciId)
    .eq('campaign_id', campaignId)
    .single();
  if (ciErr || !ciRow) {
    return NextResponse.json({ error: 'creator_not_found' }, { status: 404 });
  }
  const infRaw = (ciRow as { influencer: unknown }).influencer;
  const influencer = (Array.isArray(infRaw) ? (infRaw[0] ?? null) : infRaw) as {
    id: string;
    username: string;
    display_name: string | null;
  } | null;

  const { data: omRows, error: omErr } = await sb
    .from('outreach_messages')
    .select(
      'id, message_type, status, subject, body, sent_to, send_mode, channel, sent_at, send_after, created_at'
    )
    .eq('campaign_influencer_id', ciId)
    .eq('direction', 'outbound');
  if (omErr) {
    return NextResponse.json({ error: omErr.message }, { status: 500 });
  }

  const { data: inRows, error: inErr } = await sb
    .from('inbound_messages')
    .select('id, channel, from_identity, body, received_at, status, classification')
    .eq('campaign_influencer_id', ciId);
  if (inErr) {
    return NextResponse.json({ error: inErr.message }, { status: 500 });
  }

  const { data: offerRows, error: oErr } = await sb
    .from('creator_offers')
    .select(
      'id, status, injection_flagged, autonomy_mode, agreed_amount_usd, current_offer_usd, ceiling_usd, rounds, updated_at, agreed_deliverables, contract_generated_at'
    )
    .eq('campaign_influencer_id', ciId);
  if (oErr) {
    return NextResponse.json({ error: oErr.message }, { status: 500 });
  }
  const offers = (offerRows ?? []) as {
    id: string;
    status: string;
    injection_flagged: boolean;
    autonomy_mode: string | null;
    agreed_amount_usd: number | null;
    current_offer_usd: number | null;
    ceiling_usd: number;
    rounds: number;
    updated_at: string;
    agreed_deliverables: unknown;
    contract_generated_at: string | null;
  }[];
  const offerIds = offers.map((o) => o.id);

  let auditTargetIds = [...offerIds];
  let deliveries: ThreadDeliveryRow[] = [];
  if (offerIds.length > 0) {
    const { data: payRows } = await sb
      .from('payment_authorizations')
      .select('id')
      .in('creator_offer_id', offerIds);
    auditTargetIds = auditTargetIds.concat(
      ((payRows ?? []) as { id: string }[]).map((p) => p.id)
    );

    const { data: delRows } = await sb
      .from('deal_deliveries')
      .select('id, status, spec_check, spec_check_detail, post_url, detected_at, created_at')
      .in('creator_offer_id', offerIds);
    deliveries = (delRows ?? []) as ThreadDeliveryRow[];
  }

  let audit: ThreadAuditRow[] = [];
  if (auditTargetIds.length > 0) {
    const { data: auditRows, error: aErr } = await sb
      .from('audit_log')
      .select('id, occurred_at, action, target_type, target_id, metadata')
      .in('target_id', auditTargetIds)
      .order('occurred_at', { ascending: true })
      .limit(500);
    if (aErr) {
      return NextResponse.json({ error: aErr.message }, { status: 500 });
    }
    audit = (auditRows ?? []) as ThreadAuditRow[];
  }

  const events = assembleThread({
    outbound: (omRows ?? []) as ThreadOutboundRow[],
    inbound: (inRows ?? []) as ThreadInboundRow[],
    audit,
    deliveries,
  });

  const offer = offers[0] ?? null;
  // The last STRUCTURED price sent (offer_usd), for the resume panel.
  // Omitted (null) when nothing on record quoted one; never parsed text.
  const lastSent = offer ? (await readLastSentOffers(sb, [{ campaign_influencer_id: ciId }])).get(ciId) ?? null : null;
  return NextResponse.json({
    ci: {
      id: ciId,
      username: influencer?.username ?? null,
      display_name: influencer?.display_name ?? null,
    },
    offer: offer
      ? {
          id: offer.id,
          status: offer.status,
          injection_flagged: offer.injection_flagged,
          // A human has taken this negotiation over (manual mode),
          // or a reply on it is still held for one. Either way nothing is
          // agreed or countered automatically until it is resumed.
          manual:
            isHumanTakeover(offer) ||
            ((inRows ?? []) as Array<{ status?: string | null }>).some((r) => r.status === 'flagged'),
          agreed_amount_usd:
            offer.agreed_amount_usd != null ? Number(offer.agreed_amount_usd) : null,
          current_offer_usd:
            offer.current_offer_usd != null ? Number(offer.current_offer_usd) : null,
          last_sent_offer_usd: lastSent,
          ceiling_usd: Number(offer.ceiling_usd),
          rounds: offer.rounds,
          // The thread is the record of what was agreed, so it has to state
          // the package, not just the number. Empty array = the offer predates
          // the agreement-time freeze; nothing is invented to fill the gap.
          deliverables: normalizeDeliverables(offer.agreed_deliverables),
          deliverables_text: describeDeliverables(
            normalizeDeliverables(offer.agreed_deliverables),
          ),
          contract_sent: offer.contract_generated_at != null,
        }
      : null,
    events,
  });
}
