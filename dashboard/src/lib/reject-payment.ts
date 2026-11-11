// src/lib/reject-payment.ts
//
// The core of POST /api/payments/[id]/reject — the human "stop" on the money
// path. Extracted so it is testable without Clerk or Next; the route keeps auth,
// rate limiting and body parsing, exactly as the approve route does.
//
// Two stops, one endpoint:
//   * REJECT   pending_human_review → rejected. Nobody approved it; nothing
//              was ever going to move. (Unchanged behaviour.)
//   * REVOKE   approved → rejected, ONLY while the payout has not started:
//              not 'executing', and no provider id on the row. This is the
//              state an approved payment sits in while the creator has not
//              finished Stripe onboarding — the account.updated webhook will
//              pay it the moment they do, possibly days after the approval.
//              Before this, nothing could stop it short of cancelling the
//              whole deal.
//              Also failed → rejected under the same no-transfer rule: a failed
//              row that never moved money is retryable (payment-claim.ts
//              retryRefusal), so it is still a payment a human can stop. The
//              quick-offer cancel (cancel-offer.ts) relies on this to close
//              every unmoved leg of a deal.
//
// Why 'rejected' and the approval stamp cleared: migration 009's
// `human_approval_required_for_execute` CHECK only admits 'rejected' with
// human_approved_at IS NULL. 'failed' would keep the stamp but is a state that
// reads as "the provider refused" and is re-claimable for Retry — the wrong
// meaning for a human's deliberate stop. Who approved, and when, is preserved
// in this action's append-only audit row (and in the original payment.approved
// row), so nothing is lost.
//
// Both writes are compare-and-set, so a revoke racing a claim cannot both
// "succeed": Postgres lets exactly one of them move the row.

import type { SupabaseClient } from '@supabase/supabase-js';
import { checkFirmScope, firmScopeErrorBody } from './firm-scope';

export interface RejectPaymentInput {
  id: string;
  /** Firm of the authenticated caller. Same fail-closed scope as approve. */
  callerFirmId: string;
  actorUserId: string;
  reason?: string | null;
}

export interface RejectPaymentHooks {
  audit: (entry: {
    action: string;
    target_type: string;
    target_id: string;
    firm_id?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
}

export interface RejectPaymentOutcome {
  httpStatus: number;
  body: Record<string, unknown>;
}

/** failure_reason stored on a revoke with no typed reason. Mapped to copy in
 *  statuses.ts / deal-errors.ts. */
export const REVOKED_REASON = 'revoked_before_payout';

/**
 * Deal statuses a stop may close to 'rejected': nothing has been paid on them.
 * Anything else — a paid, posted or measured deal — keeps its status.
 */
const CLOSABLE_DEAL_STATUSES = ['agreed', 'human_approval_required', 'approved', 'rejected'];

/** What a stop did to the deal. */
export type DealAfterStop = 'closed' | 'kept_money_moved' | 'kept';

/**
 * Close the deal after one of its legs was stopped — unless money already left
 * on it.
 *
 * THE DEFECT THIS CLOSES: stopping
 * the BALANCE leg of a deal whose deposit was paid wrote the deal 'rejected'.
 * 'rejected' is not in migration 054's committed_states, so the deposit that
 * really left dropped out of the structural campaign-budget guard and the
 * campaign read cheaper than it was.
 *
 * Now a deal with money moved on it (deposit_paid_usd / balance_paid_usd
 * recorded, or a sibling leg completed / executing / carrying a transfer id)
 * keeps its status. For the only real case — a posted deal whose balance a
 * human stopped — that is 'posted': in committed_states, so the paid deposit
 * stays counted (at the agreed amount, i.e. the stopped balance is held too;
 * over-counting is the safe direction, and 'posted' is still true — the creator
 * did post). 'undelivered' would count exactly the deposit but says "never
 * posted" about a creator who did, and ends measurement of a real post.
 *
 * A deal with nothing paid is closed as before, but only FROM a pre-payment
 * status (compare-and-set), so a stop can never regress a paid deal either.
 * An unreadable deal is left open: the leg is already stopped, so leaving the
 * deal's label alone moves no money.
 */
export async function closeDealAfterStop(
  sb: SupabaseClient,
  creatorOfferId: string,
  stoppedAuthorizationId: string
): Promise<DealAfterStop> {
  const { data: offer, error: oErr } = await sb
    .from('creator_offers')
    .select('id, status, deposit_paid_usd, balance_paid_usd')
    .eq('id', creatorOfferId)
    .maybeSingle();
  const { data: legs, error: lErr } = await sb
    .from('payment_authorizations')
    .select('id, status, payment_provider_id')
    .eq('creator_offer_id', creatorOfferId);
  if (oErr || lErr || !offer) return 'kept';
  const o = offer as { deposit_paid_usd?: number | string | null; balance_paid_usd?: number | string | null };
  const moneyMoved =
    Number(o.deposit_paid_usd ?? 0) > 0 ||
    Number(o.balance_paid_usd ?? 0) > 0 ||
    ((legs ?? []) as { id: string; status: string; payment_provider_id: string | null }[]).some(
      (l) => l.id !== stoppedAuthorizationId && (l.status === 'completed' || l.status === 'executing' || !!l.payment_provider_id)
    );
  if (moneyMoved) return 'kept_money_moved';
  const { data: closed } = await sb
    .from('creator_offers')
    .update({ status: 'rejected' } as never)
    .eq('id', creatorOfferId)
    .in('status', CLOSABLE_DEAL_STATUSES)
    .select('id')
    .maybeSingle();
  return closed ? 'closed' : 'kept';
}

interface PaRow {
  id: string;
  firm_id: string;
  status: string;
  creator_offer_id: string;
  amount_usd: number;
  payment_provider_id: string | null;
  failure_reason: string | null;
  human_approved_at: string | null;
  human_approved_by_user_id: string | null;
}

export async function rejectPaymentAuthorization(
  sb: SupabaseClient,
  input: RejectPaymentInput,
  hooks: RejectPaymentHooks
): Promise<RejectPaymentOutcome> {
  const { data: pa, error: pErr } = await sb
    .from('payment_authorizations')
    .select(
      'id, firm_id, status, creator_offer_id, amount_usd, payment_provider_id, failure_reason, human_approved_at, human_approved_by_user_id'
    )
    .eq('id', input.id)
    .single();
  if (pErr || !pa) {
    return { httpStatus: 404, body: { error: 'payment_authorization_not_found' } };
  }
  const p = pa as unknown as PaRow;
  const scope = checkFirmScope(input.callerFirmId, p.firm_id);
  if (!scope.ok) {
    return { httpStatus: scope.httpStatus, body: firmScopeErrorBody(scope) };
  }
  const reason = input.reason?.trim() ? input.reason.trim() : null;

  // ── Reject: nobody has approved it yet ──────────────────────────────────
  if (p.status === 'pending_human_review') {
    const { data: moved, error: uErr } = await sb
      .from('payment_authorizations')
      .update({ status: 'rejected', failure_reason: reason ?? 'rejected by reviewer' } as never)
      .eq('id', p.id)
      // An approve can land between the read above and this write.
      .eq('status', 'pending_human_review')
      .select('id')
      .maybeSingle();
    if (uErr) return { httpStatus: 500, body: { error: uErr.message } };
    if (!moved) {
      return { httpStatus: 409, body: { error: 'invalid_state', expected: 'pending_human_review' } };
    }
    const deal = await closeDealAfterStop(sb, p.creator_offer_id, p.id);
    await hooks.audit({
      action: 'payment.rejected',
      target_type: 'payment_authorization',
      target_id: p.id,
      firm_id: p.firm_id,
      metadata: {
        creator_offer_id: p.creator_offer_id,
        amount_usd: p.amount_usd,
        reason,
        rejected_by_user_id: input.actorUserId,
        deal_after_stop: deal,
      },
    });
    return { httpStatus: 200, body: { ok: true, action: 'rejected', deal_after_stop: deal } };
  }

  // ── Revoke: approved (or failed), payout never sent ─────────────────────
  if ((p.status === 'approved' || p.status === 'failed') && !p.payment_provider_id) {
    const { data: moved, error: uErr } = await sb
      .from('payment_authorizations')
      .update({
        status: 'rejected',
        failure_reason: reason ?? REVOKED_REASON,
        human_approved_at: null,
        human_approved_by_user_id: null,
      } as never)
      .eq('id', p.id)
      // Both conditions again, in the write: a claim to 'executing' (approve
      // auto-execute, manual execute, onboarding webhook) wins or loses here.
      .eq('status', p.status)
      .is('payment_provider_id', null)
      .select('id')
      .maybeSingle();
    if (uErr) return { httpStatus: 500, body: { error: uErr.message } };
    if (!moved) {
      return { httpStatus: 409, body: { error: 'payout_already_started' } };
    }
    const deal = await closeDealAfterStop(sb, p.creator_offer_id, p.id);
    await hooks.audit({
      action: 'payment.revoked',
      target_type: 'payment_authorization',
      target_id: p.id,
      firm_id: p.firm_id,
      metadata: {
        creator_offer_id: p.creator_offer_id,
        amount_usd: p.amount_usd,
        reason,
        revoked_by_user_id: input.actorUserId,
        deal_after_stop: deal,
        prior_status: p.status,
        prior_failure_reason: p.failure_reason,
        // Cleared on the row by the 009 CHECK; kept here, append-only.
        revoked_approval: {
          human_approved_at: p.human_approved_at,
          human_approved_by_user_id: p.human_approved_by_user_id,
        },
      },
    });
    return { httpStatus: 200, body: { ok: true, action: 'revoked', deal_after_stop: deal } };
  }

  // ── Too late (or never stoppable) ───────────────────────────────────────
  if (p.status === 'executing') {
    return { httpStatus: 409, body: { error: 'payout_in_progress', status: p.status } };
  }
  if (p.status === 'approved' || p.status === 'completed' || p.status === 'failed') {
    return { httpStatus: 409, body: { error: 'payout_already_started', status: p.status } };
  }
  return {
    httpStatus: 409,
    body: { error: 'invalid_state', status: p.status, expected: 'pending_human_review|approved' },
  };
}
