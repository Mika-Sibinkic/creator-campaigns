// src/lib/approve-payment.ts
//
// The approve-route core: the human "yes" on one payment_authorizations leg.
// Extracted from src/app/api/payments/[id]/approve/route.ts so the decision is
// testable without Clerk or Next — same (sb, input, hooks) shape as
// reject-payment.ts and authorize-payment.ts. The route keeps rate limiting,
// the session and the auto-execute call.
//
// THE DEFECT THIS CLOSES:
//   The route mirrored `creator_offers.status = 'approved'` UNCONDITIONALLY after
//   approving the leg. So
//     * approving a pending leg on a cancelled/rejected deal REOPENED it, and
//       execute's post-claim re-check (payment-claim.checkOfferPayable) then read
//       'approved' and paid — /approvals listed such legs with a live button;
//     * an approve racing the quick-offer cancel reopened the deal the cancel
//       had just closed, and the payout went out;
//     * on a balance leg it overwrote 'posted' with 'approved'.
//
// What it does now:
//   1. Load the leg; firm scope (fail closed); must be pending_human_review.
//   2. The deal must be payable FOR THIS LEG (payment-claim.isOfferPayable, the
//      same allowlist execute re-checks after its claim) → else 409, no write.
//   3. Deal write FIRST, and guarded:
//        full / deposit → UPDATE creator_offers SET status='approved'
//                         WHERE id=… AND status IN (payable statuses for the leg)
//                         — a compare-and-set Postgres arbitrates against the
//                         cancel's own CAS (cancel-offer.ts). If the cancel won,
//                         0 rows match and the approval is refused with nothing
//                         written; if this won, the cancel's CAS misses instead.
//        balance        → no deal write at all. The deal stays 'posted' until the
//                         leg settles (offerSettlementUpdate → 'balance_paid').
//   4. THEN the leg's own compare-and-set pending_human_review → approved.
//      Order matters: approving the leg first and then failing the deal write
//      would leave an 'approved' leg on a closed deal for the onboarding webhook
//      to claim. A deal write that lands and a leg CAS that then loses (double
//      click) leaves the deal in the state the winning approve already put it in.

import type { SupabaseClient } from '@supabase/supabase-js';
import { checkFirmScope, firmScopeErrorBody } from './firm-scope';
import { isOfferPayable, PAYABLE_OFFER_STATUSES, type SettlementLeg } from './payment-claim';

export interface ApprovePaymentInput {
  id: string;
  /** Firm of the authenticated caller. '' / null are refusals, never wildcards. */
  callerFirmId: string | null | undefined;
  actorUserId: string;
  /**
   * The payments mode in force at this approval (resolveActivePaymentMode),
   * recorded as approved_mode with the approval itself. Every claim is then
   * pinned to it, so this approval can only ever pay in this mode. Omitted
   * pre-064, where the column does not exist.
   */
  approvedMode?: string;
}

export interface ApprovePaymentHooks {
  audit: (entry: {
    action: string;
    target_type: string;
    target_id: string;
    firm_id?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
}

export type ApprovePaymentOutcome =
  | {
      ok: true;
      httpStatus: 200;
      /** The approved payment_authorizations row, as written. */
      updated: Record<string, unknown>;
      firmId: string;
      creatorOfferId: string;
      amountUsd: number;
      leg: SettlementLeg;
    }
  | { ok: false; httpStatus: number; body: Record<string, unknown> };

/** Error slug for an approval refused because the deal is closed for this leg. */
export const APPROVE_OFFER_NOT_PAYABLE = 'offer_not_payable';

function refuse(httpStatus: number, body: Record<string, unknown>): ApprovePaymentOutcome {
  return { ok: false, httpStatus, body };
}

export async function approvePaymentAuthorization(
  sb: SupabaseClient,
  input: ApprovePaymentInput,
  hooks: ApprovePaymentHooks
): Promise<ApprovePaymentOutcome> {
  const load = (withLeg: boolean) =>
    sb
      .from('payment_authorizations')
      .select(`id, firm_id, status, creator_offer_id, amount_usd${withLeg ? ', leg' : ''}`)
      .eq('id', input.id)
      .single();
  // Same pre-055 degrade as execute-payment.ts: a row without a leg is 'full'.
  let { data: pa, error: pErr } = await load(true);
  if (pErr) {
    const legacy = await load(false);
    if (!legacy.error && legacy.data) {
      pa = legacy.data;
      pErr = null;
    }
  }
  if (pErr || !pa) return refuse(404, { error: 'payment_authorization_not_found' });
  const p = pa as unknown as {
    id: string;
    firm_id: string;
    status: string;
    creator_offer_id: string;
    amount_usd: number;
    leg?: SettlementLeg | null;
  };
  const scope = checkFirmScope(input.callerFirmId, p.firm_id);
  if (!scope.ok) return refuse(scope.httpStatus, firmScopeErrorBody(scope));
  if (p.status !== 'pending_human_review') {
    return refuse(409, { error: 'invalid_state', status: p.status, expected: 'pending_human_review' });
  }
  const leg: SettlementLeg = p.leg ?? 'full';

  // 2. Is the deal payable for this leg? Fail closed on an unreadable deal.
  const { data: offer, error: oErr } = await sb
    .from('creator_offers')
    .select('id, status')
    .eq('id', p.creator_offer_id)
    .maybeSingle();
  if (oErr) return refuse(503, { error: 'offer_check_failed', detail: oErr.message });
  const offerStatus = (offer as { status?: string | null } | null)?.status ?? null;
  if (!isOfferPayable(offerStatus, leg)) {
    await hooks.audit({
      action: 'payment.approve_refused_offer_not_payable',
      target_type: 'payment_authorization',
      target_id: p.id,
      firm_id: p.firm_id,
      metadata: { creator_offer_id: p.creator_offer_id, offer_status: offerStatus, leg, actor_user_id: input.actorUserId },
    });
    return refuse(409, {
      error: APPROVE_OFFER_NOT_PAYABLE,
      offer_status: offerStatus,
      leg,
      guidance:
        'No money moved: this deal is closed (or already paid for this leg), so this payment cannot be approved. Reject it to clear it from the queue.',
    });
  }

  const now = new Date().toISOString();

  // 3. Guarded deal write, first. Balance legs never touch the deal here.
  if (leg !== 'balance') {
    const { data: mirrored, error: mErr } = await sb
      .from('creator_offers')
      .update({ status: 'approved', approved_at: now, approved_by_user_id: input.actorUserId } as never)
      .eq('id', p.creator_offer_id)
      .in('status', [...PAYABLE_OFFER_STATUSES[leg]])
      .select('id')
      .maybeSingle();
    if (mErr) return refuse(500, { error: mErr.message });
    if (!mirrored) {
      // The deal changed between the read above and this write — a cancel won.
      return refuse(409, {
        error: APPROVE_OFFER_NOT_PAYABLE,
        leg,
        guidance: 'No money moved: the deal was closed while you were approving. Reload the page.',
      });
    }
  }

  // 4. The leg's own compare-and-set. Two concurrent approves (double click,
  //    retried request, two operators) both pass the read above; Postgres
  //    arbitrates here. human_approved_at is what migration 009's
  //    human_approval_required_for_execute checks before money moves.
  const { data: updated, error: uErr } = await sb
    .from('payment_authorizations')
    .update({
      status: 'approved',
      human_approved_at: now,
      human_approved_by_user_id: input.actorUserId,
      ...(input.approvedMode ? { approved_mode: input.approvedMode } : {}),
    } as never)
    .eq('id', p.id)
    .eq('status', 'pending_human_review')
    .select()
    .maybeSingle();
  if (uErr) return refuse(500, { error: uErr.message });
  if (!updated) return refuse(409, { error: 'invalid_state', expected: 'pending_human_review' });

  return {
    ok: true,
    httpStatus: 200,
    updated: updated as Record<string, unknown>,
    firmId: p.firm_id,
    creatorOfferId: p.creator_offer_id,
    amountUsd: p.amount_usd,
    leg,
  };
}
