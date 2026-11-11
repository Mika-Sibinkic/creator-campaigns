// src/app/api/payments/[id]/reject/route.ts
//
// SECURITY-OK: supabaseAdmin — symmetrical to /approve: same rate limit, same
// requireSession(), same fail-closed firm scope (checkFirmScope, inside
// src/lib/reject-payment.ts). Service role because authenticated users have no
// UPDATE policy on payment_authorizations.
//
// The human stop on the money path. Two cases, one endpoint:
//   * pending_human_review → rejected (the inbox Reject button)
//   * approved, payout not started (not executing, no provider id) → rejected
//     — "Stop this payment" on an approval waiting for the creator to finish
//     payout setup, which the Stripe onboarding webhook would otherwise pay
//     automatically. Anything already executing or paid answers 409.
// The linked creator_offer goes to 'rejected'. No payment is attempted.
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { requireSession } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { rejectPaymentAuthorization } from '@/lib/reject-payment';
import { z } from 'zod';

export const runtime = 'nodejs';

const Body = z.object({
  reason: z.string().max(500).optional(),
});

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx) {
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
  const { id } = await ctx.params;

  const { httpStatus, body: out } = await rejectPaymentAuthorization(
    supabaseAdmin(),
    {
      id,
      callerFirmId: session.firm_id,
      actorUserId: session.user.id,
      reason: body.reason ?? null,
    },
    { audit: (entry) => audit(entry, req) }
  );
  return NextResponse.json(out, { status: httpStatus });
}
