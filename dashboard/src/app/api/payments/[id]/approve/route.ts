// src/app/api/payments/[id]/approve/route.ts
//
// SECURITY-OK: supabaseAdmin — a person clicks "Approve" in the inbox. We
// need to write human_approved_at + human_approved_by_user_id, which the
// payment_authorizations CHECK constraint requires before the row's
// status can move to 'approved'. RLS would reject the write because
// authenticated users have no UPDATE policy on payment_authorizations
// (by design — service-role only path). We still gate the route with
// requireSession() and explicitly verify firm ownership before writing.
//
// The human-approval gate, and the ONLY human
// gate: approval immediately triggers the payout server-side (via
// src/lib/execute-payment.ts, the same core the execute route runs), so
// "Approve & pay" is one click. Every execute-path guard still applies:
// atomic claim, all three spend caps, recipient checks, audit. A failed
// auto-execute leaves the row retryable from DealRow's Execute button.
//
// Response contract (src/lib/payout-surfacing.ts):
//   200 — approved AND the payout went out (or is legitimately pending)
//   207 — approved, payout did NOT go out; `payout.ok === false` with a reason
//         and operator-facing guidance. Still 2xx because the approval really
//         did commit; a 5xx would claim otherwise and invite a retry that can
//         only 409.
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { requireSession } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { executeAuthorizedPayment } from '@/lib/execute-payment';
import { buildApproveResponse } from '@/lib/payout-surfacing';
import { approvePaymentAuthorization } from '@/lib/approve-payment';
import { resolveActivePaymentMode } from '@/lib/stripe-isolated';

export const runtime = 'nodejs';

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
  const { id } = await ctx.params;

  const sb = supabaseAdmin();

  // Scope, state, the deal-payable check and both guarded writes live in
  // src/lib/approve-payment.ts (executed by tests/money-path-adversarial.test.ts).
  // The deal is written BEFORE the leg and only through a compare-and-set, so
  // an approval can no longer reopen a cancelled/rejected deal, race the
  // quick-offer cancel into a payout, or overwrite a balance leg's 'posted'.
  // The approval records the payments mode it was given in (migration 064);
  // the execute claim below is pinned to that same mode.
  const active = await resolveActivePaymentMode(sb);
  const approved = await approvePaymentAuthorization(
    sb,
    {
      id,
      callerFirmId: session.firm_id,
      actorUserId: session.user.id,
      ...(active.pinned ? { approvedMode: active.mode } : {}),
    },
    { audit: async (entry) => { await audit(entry, req); } }
  );
  if (!approved.ok) {
    return NextResponse.json(approved.body, { status: approved.httpStatus });
  }
  const p = { firm_id: approved.firmId, creator_offer_id: approved.creatorOfferId, amount_usd: approved.amountUsd };
  const updated = approved.updated;

  await audit(
    {
      action: 'payment.approved',
      target_type: 'payment_authorization',
      target_id: id,
      firm_id: p.firm_id,
      metadata: {
        creator_offer_id: p.creator_offer_id,
        amount_usd: p.amount_usd,
        leg: approved.leg,
        approved_by_user_id: session.user.id,
        approved_mode: active.pinned ? active.mode : null,
      },
    },
    req
  );

  // Auto-execute: approval is the single human gate — fire the payout
  // now instead of waiting for a second click. executeAuthorizedPayment
  // re-verifies everything (atomic approved → executing claim, all three
  // spend caps, recipient email) and never throws HTTP responses; a refusal
  // or provider failure comes back as a summary.
  const executed = await executeAuthorizedPayment(sb, id, {
    expectedFirmId: session.firm_id,
    req,
  });

  // The approval is durable and already committed, so this response must never
  // claim the approval failed — but it must never let a FAILED payout read as a
  // success either. buildApproveResponse answers 200 when the payout went out
  // and 207 Multi-Status when it did not, always with an explicit
  // `payout: { ok, reason, guidance, raw_error }` the UI renders in place.
  // See src/lib/payout-surfacing.ts for the contract and why 207, not 502.
  const { httpStatus, body } = buildApproveResponse(updated, executed);
  if (!(body.payout as { ok: boolean }).ok) {
    const payout = body.payout as { reason: string | null; raw_error: string | null };
    // Audit the approve-time payout refusal separately from the execute core's
    // own payment.failed record: this is the click the operator made, and the
    // raw provider prose is preserved here verbatim.
    await audit(
      {
        action: 'payment.approved_payout_failed',
        target_type: 'payment_authorization',
        target_id: id,
        firm_id: p.firm_id,
        metadata: {
          creator_offer_id: p.creator_offer_id,
          amount_usd: p.amount_usd,
          reason: payout.reason,
          raw_error: payout.raw_error,
          execute_http_status: executed.httpStatus,
        },
      },
      req
    );
  }
  return NextResponse.json(body, { status: httpStatus });
}
