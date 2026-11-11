// src/app/api/payments/[id]/execute/route.ts
//
// SECURITY-OK: supabaseAdmin — system path. Thin HTTP shell over
// src/lib/execute-payment.ts (the extracted execute core, shared with the
// approve route's auto-execute). Dispatches a Stripe transfer for an
// APPROVED payment_authorizations row.
//
// Refuses to run if:
//   - row.status !== 'approved' (except 'failed' → retry, see the lib)
//   - human_approved_at IS NULL (defense-in-depth on top of CHECK constraint)
//   - already executed (idempotent via Stripe Idempotency-Key = pa.id)
//   - any spend cap would be breached (src/lib/spend-caps.ts)
//
// Run trigger: since auto-execute-on-approve landed, this is the RETRY /
// manual path (DealRow's Execute button) — e.g. after a cap block or a
// provider failure. Either way the AI agent isn't in the loop — the
// human-approval gate is the only path that ever produces 'approved'.
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { requireSession } from '@/lib/auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { executeAuthorizedPayment } from '@/lib/execute-payment';

export const runtime = 'nodejs';

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const limit = tieredLimit(req, 'expensive');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  // SEC: money-out path — authenticate and verify firm ownership (mirrors the
  // approve route). Without this a firm-A user could POST firm-B's approved
  // authorization id and force a cross-firm payout.
  let session;
  try {
    session = await requireSession();
  } catch (r) {
    return r as Response;
  }
  const { id } = await ctx.params;
  const sb = supabaseAdmin();
  // Optional body. `resend_onboarding_email: true` comes only from DealRow's
  // "Re-send payout setup email"; it is the one way to queue a second payout
  // setup email for a leg (src/lib/payout-email.ts decideOnboardingEmail).
  // No body, or anything else, is an ordinary execute/retry.
  const body: unknown = await req.json().catch(() => null);
  const resendOnboardingEmail =
    !!body && typeof body === 'object' && (body as { resend_onboarding_email?: unknown }).resend_onboarding_email === true;

  const outcome = await executeAuthorizedPayment(sb, id, {
    expectedFirmId: session.firm_id,
    req,
    resendOnboardingEmail,
  });
  return NextResponse.json(outcome.body, { status: outcome.httpStatus });
}
