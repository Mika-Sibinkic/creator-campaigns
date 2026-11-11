// src/app/api/campaigns/[id]/deals/[offer_id]/post/route.ts
//
// USER PATH — a label user logs the URL where the paid creator actually posted.
// Advances creator_offers state-machine: 'paid' → 'posted'.
//
// Defensive double-check: even though RLS firm-scopes the offer row, we
// also verify offer.campaign_id matches the URL path AND offer.firm_id
// matches session.firm_id before writing — consistent with the rest of
// the state-machine-advancing routes under /api/payments/*.
//
// NOTE on naming: Next.js disallows two different dynamic-segment names
// at the same path depth, so this route reuses the parent's `[id]`
// (the campaign id) and adds `[offer_id]` for the offer.

import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { audit } from '@/lib/audit';
import { LogOfferPostBody } from '@/lib/zod-schemas';
import { mintBalanceAfterPost } from '@/lib/authorize-payment';

export const runtime = 'nodejs';

interface Ctx {
  params: Promise<{ id: string; offer_id: string }>;
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  const { id: campaign_id, offer_id } = await ctx.params;

  let session, sb;
  try {
    ({ session, sb } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }

  const body = await readJson(req, LogOfferPostBody);
  if (body instanceof NextResponse) return body;

  // Load offer + verify URL path + firm scope.
  const { data: offer, error: oErr } = await sb
    .from('creator_offers')
    .select('id, campaign_id, firm_id, status, deposit_paid_usd, balance_paid_usd')
    .eq('id', offer_id)
    .single();
  if (oErr || !offer) {
    return NextResponse.json({ error: 'creator_offer_not_found' }, { status: 404 });
  }
  const o = offer as {
    id: string;
    campaign_id: string;
    firm_id: string;
    status: string;
    deposit_paid_usd: number | null;
    balance_paid_usd: number | null;
  };
  if (o.campaign_id !== campaign_id) {
    return NextResponse.json({ error: 'campaign_mismatch' }, { status: 400 });
  }
  if (o.firm_id !== session.firm_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  // 'deposit_paid' is accepted alongside 'paid' because under split settlement
  // that is the state a deal sits in while it is waiting for exactly this event.
  // Requiring 'paid' made the split unreachable: nothing could ever advance a
  // deposit_paid deal to 'posted', so the balance leg could never be owed.
  const POSTABLE = ['paid', 'deposit_paid'] as const;
  if (!(POSTABLE as readonly string[]).includes(o.status)) {
    return NextResponse.json(
      { error: 'invalid_state', status: o.status, expected: POSTABLE.join('|') },
      { status: 409 }
    );
  }

  const postedAt = body.posted_at ?? new Date().toISOString();
  const { data: updated, error: uErr } = await sb
    .from('creator_offers')
    .update({
      status: 'posted',
      post_url: body.post_url,
      posted_at: postedAt,
    } as never)
    .eq('id', offer_id)
    .select()
    .single();
  if (uErr) {
    return NextResponse.json({ error: uErr.message }, { status: 500 });
  }

  await audit(
    {
      action: 'offer.posted',
      target_type: 'creator_offer',
      target_id: offer_id,
      firm_id: o.firm_id,
      metadata: {
        campaign_id,
        post_url: body.post_url,
        posted_at: postedAt,
      },
    },
    req
  );

  // The balance leg. This is the second half of the split, and it is minted here
  // rather than paid here: the authorization lands in /approvals at
  // pending_human_review, so a human sees the post before the remaining money
  // moves. That separation is the point — migration 009's
  // human_approval_required_for_execute CHECK means each leg executes only under
  // its OWN approval, which is why two rows exist instead of one mutated amount.
  //
  // Never throws into the caller's path: the post IS logged at this point, and
  // failing the request would make the operator re-submit an event that already
  // happened. But a missed mint is never silent: any non-2xx or throw is audited
  // as payment.balance_authorization_failed, which /anomalies shows with a
  // "Create payment for approval" action (src/lib/authorize-payment.ts).
  const mint = await mintBalanceAfterPost(
    sb,
    { offer: o, callerFirmId: session.firm_id, actorUserId: session.user.id },
    { audit: async (entry) => { await audit(entry, req); } }
  );
  const balanceAuthorization: unknown = mint.skipped ? null : (mint.body ?? { error: 'balance_authorization_failed' });

  return NextResponse.json(
    balanceAuthorization ? { ...(updated as object), balance_authorization: balanceAuthorization } : updated
  );
}
