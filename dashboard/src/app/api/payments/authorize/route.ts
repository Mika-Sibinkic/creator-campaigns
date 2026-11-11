// src/app/api/payments/authorize/route.ts
//
// SECURITY-OK: supabaseAdmin — creates the payment_authorizations row in
// 'pending_human_review' for a creator_offer that has reached
// 'human_approval_required'. RLS gives authenticated users no INSERT policy
// on payment_authorizations by design (service-role only), so the write goes
// through the admin client AFTER the route has authenticated the caller and
// verified firm ownership — exactly like the approve/reject routes.
//
// The DB CHECK constraint (human_approval_required_for_execute, migration
// 009) still guarantees this row cannot reach approved/executing/completed
// without human_approved_at + human_approved_by_user_id, so nothing here can
// self-approve. That gate is unchanged.
//
// SEC (this file's history): until now this route had NO in-route auth. It
// was not open to the internet — src/middleware.ts matches every path and
// 401s an unauthenticated request (middleware.ts:338-343), and the POST also
// has to clear the same-origin CSRF gate (middleware.ts:245-255). But the
// edge gate only proves the caller is a member of SOME firm
// (middleware.ts:297-300 probes firm_members by clerk_user_id with no firm
// filter); it cannot prove membership of the firm that owns this offer.
// So any authenticated member of firm A could POST firm B's
// creator_offer_id and mint an authorization row into firm B's approval
// queue — and, with no session, the audit row naming who did it was blank.
// Both are closed here: requireSession() + checkFirmScope() inside
// src/lib/authorize-payment.ts, which is where the decision table is tested.
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { requireSession } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { authorizePaymentForOffer } from '@/lib/authorize-payment';
import { z } from 'zod';

export const runtime = 'nodejs';

const Body = z.object({
  creator_offer_id: z.string().uuid(),
});

export async function POST(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  // SEC: money-path head — authenticate before touching the admin client.
  let session;
  try {
    session = await requireSession();
  } catch (r) {
    return r as Response;
  }
  const body = await readJson(req, Body);
  if (body instanceof NextResponse) return body;

  const outcome = await authorizePaymentForOffer(
    supabaseAdmin(),
    {
      creatorOfferId: body.creator_offer_id,
      callerFirmId: session.firm_id,
      actorUserId: session.user.id,
    },
    { audit: (entry) => audit(entry, req) }
  );
  return NextResponse.json(outcome.body, { status: outcome.httpStatus });
}
