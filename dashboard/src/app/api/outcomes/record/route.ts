// src/app/api/outcomes/record/route.ts
//
// SECURITY-OK: supabaseAdmin — system path that records a streams
// measurement against a creator_offer. campaign_outcomes is a system
// audit table with no INSERT policy for authed users. Session check
// + firm ownership verified explicitly before write.
//
// This is the feedback hook for the RL pricing engine. Once a
// campaign settles and streams are measured (manually for v1; a Spotify-
// for-Artists integration is not built), we POST here to record the outcome.
// Subsequent calls to /api/campaigns/[id]/run (or its successor) read
// these rows back to fit the linear regression in src/lib/rl-pricing.ts.
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { requireSession } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { persistDealEconomicsForOffer } from '@/lib/deal-economics';
import { logDealCpm } from '@/lib/learning-log';
import { markOfferMeasured } from '@/lib/record-outcome';
import { z } from 'zod';

export const runtime = 'nodejs';

const Body = z.object({
  creator_offer_id: z.string().uuid(),
  streams_attributed: z.number().int().nonnegative(),
  attribution_method: z.enum([
    'manual',
    'spotify_for_artists',
    'estimated_from_views',
    'unknown',
  ]),
  follower_count_at_post: z.number().int().nonnegative().optional(),
  engagement_at_post: z.number().min(0).max(1).optional(),
  payment_usd_amount: z.number().nonnegative().optional(),
  notes: z.string().max(2000).optional(),
});

export async function POST(req: NextRequest) {
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
  const body = await readJson(req, Body);
  if (body instanceof NextResponse) return body;

  const sb = supabaseAdmin();

  // Verify firm ownership of the creator_offer.
  const { data: offer, error: oErr } = await sb
    .from('creator_offers')
    .select('id, campaign_id, firm_id, agreed_amount_usd')
    .eq('id', body.creator_offer_id)
    .single();
  if (oErr || !offer) {
    return NextResponse.json({ error: 'creator_offer_not_found' }, { status: 404 });
  }
  const o = offer as { id: string; campaign_id: string; firm_id: string; agreed_amount_usd: number | null };
  if (o.firm_id !== session.firm_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Snapshot payment_usd_amount from creator_offer if not supplied.
  const paymentSnapshot = body.payment_usd_amount ?? o.agreed_amount_usd ?? 0;

  // Upsert by creator_offer_id so re-measurements over time replace the
  // prior estimate (typical: post 1-week stream count → 30-day count).
  const now = new Date().toISOString();
  const { data: outcome, error: uErr } = await sb
    .from('campaign_outcomes')
    .upsert(
      {
        campaign_id: o.campaign_id,
        creator_offer_id: o.id,
        streams_attributed: body.streams_attributed,
        streams_attribution_method: body.attribution_method,
        follower_count_at_post: body.follower_count_at_post ?? null,
        engagement_at_post: body.engagement_at_post ?? null,
        payment_usd_amount: paymentSnapshot,
        measured_at: now,
      } as never,
      { onConflict: 'creator_offer_id' }
    )
    .select()
    .single();
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });

  // Mark the deal measured — but only from a state that may become measured,
  // and never while a payment leg is unsettled. An unconditional write here
  // made a posted deal's pending balance unpayable (the balance is payable only
  // from 'posted'). The measurement above is recorded either way; the deal
  // moves on a later re-measure once its money has settled.
  const measured = await markOfferMeasured(sb, o.id);

  // Stamp the frozen deal-economics snapshot (perceived_generosity /
  // price_give_pct) now — the fresh follower_count_at_post just upserted is
  // the preferred snapshot source, and re-measures re-stamp with it. Never
  // throws; on failure the tick sweeper is the backstop.
  await persistDealEconomicsForOffer(sb, o.id);

  // Learning spine: the deal_cpm event — the full
  // dealCpmFeatures() record plus predicted vs actual streams-per-dollar and
  // label CPM. This is the (state, action, CPM outcome) row the learning
  // log records at every decision point. Never throws; synthetic
  // campaigns excluded inside.
  await logDealCpm(sb, {
    creatorOfferId: o.id,
    campaignId: o.campaign_id,
    firmId: o.firm_id,
    streamsAttributed: body.streams_attributed,
    paymentUsd: paymentSnapshot,
    attributionMethod: body.attribution_method,
    followerCountAtPost: body.follower_count_at_post ?? null,
  });

  await audit(
    {
      action: 'outcome.recorded',
      target_type: 'campaign_outcome',
      target_id: (outcome as { id: string }).id,
      firm_id: o.firm_id,
      metadata: {
        creator_offer_id: o.id,
        streams_attributed: body.streams_attributed,
        payment_usd_amount: paymentSnapshot,
        attribution_method: body.attribution_method,
        streams_per_dollar:
          paymentSnapshot > 0 ? body.streams_attributed / paymentSnapshot : 0,
        // The Body accepts free-text notes but campaign_outcomes has no
        // column for them — the audit trail is their home (design §9.4).
        notes: body.notes ?? null,
        deal_marked_measured: measured.written,
        deal_status_kept_reason: measured.written ? null : measured.reason,
      },
    },
    req
  );
  return NextResponse.json({
    ...(outcome as Record<string, unknown>),
    deal_marked_measured: measured.written,
    ...(measured.written ? {} : { deal_status_kept_reason: measured.reason }),
  });
}
