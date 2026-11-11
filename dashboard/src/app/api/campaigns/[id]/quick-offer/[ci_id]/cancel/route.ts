// src/app/api/campaigns/[id]/quick-offer/[ci_id]/cancel/route.ts
//
// SECURITY-OK: supabaseAdmin — symmetrical to the sibling quick-offer
// route. Verifies firm membership via requireSession() then writes via
// service role (firm check inside src/lib/cancel-offer.ts).
//
// USER PATH — "undo" for an offer (DealRow's Cancel). Label staff occasionally
// misclick "Lock in deal" or change their mind before the payout runs. Walks
// the offer back to terminal `rejected` and stops every payment leg that has
// not moved money, through the same reject/revoke logic as the Reject and
// Stop payment buttons. Refuses (409) while any leg is mid-transfer, and once
// any money has moved — that is a refund flow, not a cancel.
//
// All decision logic lives in src/lib/cancel-offer.ts so it is testable
// without Clerk or Next (tests/payment-gate.test.ts, follow-up C).

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { audit } from '@/lib/audit';
import { cancelOffer } from '@/lib/cancel-offer';

export const runtime = 'nodejs';

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

  const { httpStatus, body } = await cancelOffer(
    supabaseAdmin(),
    {
      campaignId: campaign_id,
      ciId: ci_id,
      callerFirmId: session.firm_id,
      actorUserId: session.user.id,
    },
    { audit: (entry) => audit(entry, req) }
  );
  return NextResponse.json(body, { status: httpStatus });
}
