// src/app/api/campaigns/[id]/quick-offer/[ci_id]/route.ts
//
// SECURITY-OK: supabaseAdmin — creator_offers has SELECT/UPDATE policies
// only (writes flow through system paths to match the negotiation lib's
// contract that the AI cannot self-approve). This route gates with
// requireSessionAndClient (verifies firm membership) then writes via
// service role. Mirrors /api/payments/authorize.
//
// USER PATH — "lock in a deal" shortcut. Used when the creator and the
// label have already agreed on a number via email (or any off-platform
// channel) and we just need Creator Campaigns to record it so the approval +
// payment + post-verification + outcome-measurement flow can run.
//
// Skips the multi-round negotiation walk because for v1 the negotiation
// happens in the inbox, not on the platform. Effect:
//
//   (no offer)
//        │  POST quick-offer { agreed_amount_usd }
//        ▼
//   creator_offers INSERT (status='agreed', initial=current=agreed=X,
//                          ceiling=campaign.per_creator_cap_usd, rounds=1,
//                          last_message_id=<latest outbound>)
//        │  auto-promote
//        ▼
//   status='human_approval_required'
//
// From there the existing /api/payments/authorize → approve → execute
// chain takes over and the deals UI exposes those buttons inline.
//
// Defensive checks (mirrors /api/payments/[id]/approve pattern):
// - campaign_influencer must belong to this campaign
// - campaign_influencer.outreach_status must be ≥ sent (don't skip the funnel)
// - campaign_influencer.qualification_status must not be 'excluded' (same gate
//   draft-all already applies — a creator a human ruled out must not become a
//   deal through the side door)
// - agreed_amount_usd must be > 0 and ≤ campaign.per_creator_cap_usd
// - one offer per campaign_influencer (DB unique constraint + this explicit
//   guard provides the cleaner 409 error)
// - audit('offer.quick_agreed') on success
//
// The offer is recorded WITH its deliverable package, not just an amount. This
// path skips the negotiator entirely, so nothing else would ever write one:
// the deal would sit at the approval gate as a number with no statement of
// what was bought. Callers may pass the package explicitly (the off-platform
// negotiation is the source of truth); otherwise the campaign's standing
// package is recorded, which is what the rest of the app assumes anyway.

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { audit } from '@/lib/audit';
import { LEARNING_EVENTS, logLearning } from '@/lib/learning-log';
import { normalizeDeliverables, PROMO_TYPES } from '@/lib/deliverables';
import { resolveStandingDeliverables } from '@/lib/deliverables-store';
import { deliverByMs } from '@/lib/split-settlement';
import { z } from 'zod';

export const runtime = 'nodejs';

const Body = z.object({
  agreed_amount_usd: z.number().positive().max(100_000),
  /** Optional explicit package. Omitted → the campaign's standing package. */
  deliverables: z
    .array(
      z.object({
        promo_type: z.enum(PROMO_TYPES),
        quantity: z.number().int().positive().max(50),
        delivery_window_days: z.number().int().positive().max(365),
        min_seconds: z.number().int().positive().max(3600).nullable().optional(),
      }),
    )
    .min(1)
    .max(10)
    .optional(),
});

interface Ctx {
  params: Promise<{ id: string; ci_id: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  const { id: campaign_id, ci_id } = await ctx.params;
  let session;
  try {
    session = await requireSession();
  } catch (r) {
    return r as Response;
  }
  const sb = supabaseAdmin();
  const body = await readJson(req, Body);
  if (body instanceof NextResponse) return body;

  // Load the campaign for the per-creator cap.
  const { data: campaign, error: cErr } = await sb
    .from('campaigns')
    .select('id, firm_id, per_creator_cap_usd')
    .eq('id', campaign_id)
    .single();
  if (cErr || !campaign) {
    return NextResponse.json({ error: 'campaign_not_found' }, { status: 404 });
  }
  const c = campaign as { id: string; firm_id: string; per_creator_cap_usd: number | null };
  // Defensive firm check (service-role bypasses RLS).
  if (c.firm_id !== session.firm_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const ceiling = c.per_creator_cap_usd ?? 250;
  if (body.agreed_amount_usd > ceiling) {
    return NextResponse.json(
      { error: 'over_cap', message: `agreed_amount_usd $${body.agreed_amount_usd} exceeds per_creator_cap_usd $${ceiling}` },
      { status: 422 }
    );
  }

  // Load the campaign_influencer + verify it's in the funnel.
  const { data: ciRow, error: ciErr } = await sb
    .from('campaign_influencers')
    .select('id, campaign_id, influencer_id, outreach_status, qualification_status')
    .eq('id', ci_id)
    .single();
  if (ciErr || !ciRow) {
    return NextResponse.json({ error: 'campaign_influencer_not_found' }, { status: 404 });
  }
  const ci = ciRow as {
    id: string;
    campaign_id: string;
    influencer_id: string;
    outreach_status: string | null;
    qualification_status: string | null;
  };
  if (ci.campaign_id !== campaign_id) {
    return NextResponse.json({ error: 'campaign_mismatch' }, { status: 400 });
  }
  // Qualification is a human/LLM verdict that this creator should not be
  // worked. draft-all honors it; this path is the same funnel and must too,
  // or "exclude" means nothing as soon as someone uses the manual shortcut.
  if (ci.qualification_status === 'excluded') {
    return NextResponse.json(
      {
        error: 'creator_excluded',
        message: 'This creator was excluded during qualification. Re-qualify them before recording a deal.',
      },
      { status: 422 },
    );
  }

  // Find most-recent outbound message for last_message_id breadcrumb.
  const { data: latestMsg } = await sb
    .from('outreach_messages')
    .select('id, status')
    .eq('campaign_influencer_id', ci_id)
    .eq('direction', 'outbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Guard: an offer already exists for this ci.
  const { data: existing } = await sb
    .from('creator_offers')
    .select('id, status')
    .eq('campaign_influencer_id', ci_id)
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      { error: 'offer_exists', offer_id: (existing as { id: string }).id, status: (existing as { status: string }).status },
      { status: 409 }
    );
  }

  const amount = body.agreed_amount_usd;
  const nowIso = new Date().toISOString();

  // What the money buys. An explicit package from the caller wins (the deal
  // was struck off-platform, so the caller knows); otherwise the campaign's
  // standing package — the same package every other path would have quoted.
  // Resolution never throws and never returns empty.
  const explicit = normalizeDeliverables(body.deliverables);
  const deliverables = explicit.length
    ? explicit
    : await resolveStandingDeliverables(sb, { id: null, campaign_id });

  // Insert as 'agreed' with everything stamped, then promote to
  // human_approval_required as a second write so the audit row + ordering
  // matches the normal negotiation flow.
  const { data: inserted, error: insErr } = await sb
    .from('creator_offers')
    .insert({
      campaign_influencer_id: ci_id,
      campaign_id,
      firm_id: c.firm_id,
      status: 'agreed',
      initial_offer_usd: amount,
      current_offer_usd: amount,
      agreed_amount_usd: amount,
      ceiling_usd: ceiling,
      rounds: 1,
      agreed_deliverables: deliverables,
      // The outside date, stamped from the package the creator agreed to — the
      // same derivation finalizeAgreement uses. It was missing here, and this is
      // the route the negotiation module itself calls "how deals actually get
      // created", so no deal made here carried one. Without it
      // evaluateExpiry returns 'wait' forever and the self-resolving half of the
      // split can never fire, no matter what the firm's flag says.
      deliver_by: new Date(deliverByMs(Date.now(), deliverables)).toISOString(),
      last_message_id: (latestMsg as { id: string } | null)?.id ?? null,
    } as never)
    .select('id')
    .single();
  if (insErr || !inserted) {
    return NextResponse.json({ error: insErr?.message ?? 'insert_failed' }, { status: 500 });
  }
  const offerId = (inserted as { id: string }).id;

  const { data: promoted, error: pErr } = await sb
    .from('creator_offers')
    .update({ status: 'human_approval_required' } as never)
    .eq('id', offerId)
    .select()
    .single();
  if (pErr) {
    return NextResponse.json({ error: pErr.message }, { status: 500 });
  }

  // Learning spine (review finding N3). createOffer's opening_offer pair has
  // ZERO production callers — this route is how deals actually get created, and
  // it wrote no learning row at all, so every real closed deal was invisible to
  // the loop. predicted_value is deliberately null: a human typed this number,
  // there was no model prediction to score it against, and inventing one would
  // be fabricating a prediction after the fact. The ACTUAL is real and is what
  // the estimator's gap correction needs. Never throws; synthetic campaigns are
  // excluded inside logLearning.
  await logLearning(sb, {
    event_type: LEARNING_EVENTS.OPENING_OFFER_OUTCOME,
    campaign_id,
    input_data: {
      creator_offer_id: offerId,
      campaign_influencer_id: ci_id,
      ceiling_usd: ceiling,
      initial_offer_usd: amount,
      rounds: 1,
      source: 'quick_offer_human_set',
      deliverables_source: explicit.length ? 'request' : 'campaign_standing',
    },
    predicted_value: null,
    actual_value: { agreed_amount_usd: amount },
  });

  await audit(
    {
      action: 'offer.quick_agreed',
      target_type: 'creator_offer',
      target_id: offerId,
      firm_id: c.firm_id,
      metadata: {
        campaign_id,
        campaign_influencer_id: ci_id,
        agreed_amount_usd: amount,
        ceiling_usd: ceiling,
        agreed_deliverables: deliverables,
        deliverables_source: explicit.length ? 'request' : 'campaign_standing',
        promoted_to: 'human_approval_required',
        last_message_id: (latestMsg as { id: string } | null)?.id ?? null,
        created_at: nowIso,
        actor_user_id: session.user.id,
      },
    },
    req
  );

  return NextResponse.json(promoted);
}
