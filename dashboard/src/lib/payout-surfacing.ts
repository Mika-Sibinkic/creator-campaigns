// src/lib/payout-surfacing.ts
//
// The approve-route response contract: make a FAILED payout impossible to
// mistake for a successful one.
//
// Background. /api/payments/[id]/approve records the human approval and then
// auto-executes the payout (#25 — approval IS payment, one human gate). It used
// to answer HTTP 200 unconditionally with the outcome buried in
// `{ executed: { ok: false } }`. Both callers (approvals/ApprovalActions.tsx and
// campaigns/[id]/deals/DealRow.tsx) only checked `response.ok`, so on failure the
// UI reloaded, the row dropped out of the approvals inbox (it no longer matches
// `status = 'pending_human_review'`), and the operator was shown nothing at all.
//
// Contract:
//   200 Multi-nothing — approved AND the payout went out (or is legitimately
//                       pending a creator onboarding step we told the operator about)
//   207 Multi-Status  — approved, but the payout did NOT go out
//
// Why 207 and not 502: the approval is a durable, committed state change
// (human_approved_at is written, audited, and the row has left
// pending_human_review). A 5xx would claim the whole request failed, inviting a
// retry that can only ever 409, and would make the clients skip the refresh they
// legitimately need. 207 is still 2xx, so `response.ok` stays true and existing
// refresh-on-ok behavior is preserved — but `status !== 200` is an unambiguous
// machine signal, and `payout.ok === false` is the explicit one the UI renders.
//
// Pure module: no env, no I/O, no Supabase. Tested by tests/payout-approval.test.ts.

import { HTTP_STATUS_GUIDANCE, PAYOUT_REASON_GUIDANCE } from './payout-guidance';

/** Structurally satisfied by ExecutePaymentOutcome (src/lib/execute-payment.ts).
 *  Declared locally so this module stays dependency-free and hermetic. */
export interface ExecutedOutcome {
  httpStatus: number;
  body: Record<string, unknown>;
}

export type PayoutStatus = 'paid' | 'awaiting_onboarding' | 'pending' | 'failed';

export interface PayoutSummary {
  /** false === no money moved. The single field a client must branch on. */
  ok: boolean;
  status: PayoutStatus;
  /** HTTP status the underlying execute core produced (forensics). */
  http_status: number;
  /** Stable slug for logs/branching. null only when ok === true and settled. */
  reason: string | null;
  /** One operator-facing sentence: what happened and what to do next. */
  guidance: string | null;
  /** The provider's verbatim prose, preserved for the audit trail. Never the
   *  only thing shown to an operator, but never discarded either. */
  raw_error: string | null;
  /** Provider reference when the dispatch succeeded (tr_*, paper_*, batch id). */
  provider_id: string | null;
  /** Resolved PAYMENTS_MODE at dispatch time, when the core reported one. */
  payment_mode: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Collapse an execute-core outcome into the one shape the API and both UIs read.
 * Deliberately fails closed: anything that is not an unambiguous success is
 * reported as a payout failure.
 */
export function summarizePayout(executed: ExecutedOutcome): PayoutSummary {
  const body = executed.body ?? {};
  const httpStatus = executed.httpStatus;

  // Same success test the approve route has always used, kept explicit:
  // a non-4xx/5xx status AND no `ok: false` in the body.
  const ok = httpStatus < 400 && (body.ok ?? true) === true;

  const provider_id = str(body.provider_id);
  const payment_mode = str(body.payment_mode);

  if (ok) {
    // Dispatched, but the creator still has to finish Stripe onboarding before
    // the transfer runs. Money has NOT moved — say so rather than implying paid.
    if (body.needs_onboarding === true || body.status === 'awaiting_onboarding') {
      return {
        ok: true,
        status: 'awaiting_onboarding',
        http_status: httpStatus,
        reason: str(body.reason) ?? 'awaiting_creator_onboarding',
        guidance:
          str(body.guidance) ??
          'Approved, but no money has moved yet: the creator still has to finish their payout onboarding. We emailed them the link; the payment sends automatically once they complete it.',
        raw_error: null,
        provider_id,
        payment_mode,
      };
    }
    // Deferred settlement (PayPal): dispatched, not final until the creator claims.
    if (body.settled === false) {
      return {
        ok: true,
        status: 'pending',
        http_status: httpStatus,
        reason: 'awaiting_provider_settlement',
        guidance:
          'Approved and the payout was dispatched. It settles once the creator claims it, and the deal flips to paid on the provider webhook.',
        raw_error: null,
        provider_id,
        payment_mode,
      };
    }
    return {
      ok: true,
      status: 'paid',
      http_status: httpStatus,
      // Sent but the payment row could not be updated (execute-payment.ts):
      // paid, but say so — the row is on /anomalies for a manual check.
      reason: body.recorded === false ? 'transfer_not_recorded' : null,
      guidance: body.recorded === false ? str(body.guidance) : null,
      raw_error: null,
      provider_id,
      payment_mode,
    };
  }

  // ── Failure. Never return without both a reason and a guidance line. ──
  // `reason` / `guidance` are set by the Stripe error mapper when the failure
  // came from Stripe; otherwise fall back to the core's machine error code.
  const raw_error = str(body.raw_error) ?? str(body.error);
  const reason =
    str(body.reason) ?? str(body.error) ?? (raw_error || `http_${httpStatus}`);
  const guidance =
    str(body.guidance) ??
    PAYOUT_REASON_GUIDANCE[reason] ??
    (raw_error
      ? `The payout was refused: ${raw_error}`
      : HTTP_STATUS_GUIDANCE[httpStatus] ??
        `The payout did not go out (HTTP ${httpStatus}). Retry it from the campaign's Deals page.`);

  return {
    ok: false,
    status: 'failed',
    http_status: httpStatus,
    reason,
    guidance,
    raw_error,
    provider_id,
    payment_mode,
  };
}

/**
 * Build the full approve-route response: the approval row, the payout summary,
 * and the HTTP status that matches them.
 *
 * `executed` is kept alongside `payout` for back-compat with anything already
 * reading the old envelope.
 */
export function buildApproveResponse(
  approvalRow: Record<string, unknown>,
  executed: ExecutedOutcome
): { httpStatus: number; body: Record<string, unknown> } {
  const payout = summarizePayout(executed);
  return {
    // 207 Multi-Status: the approval sub-operation succeeded, the payout
    // sub-operation did not. Still 2xx — the approval really did commit.
    httpStatus: payout.ok ? 200 : 207,
    body: {
      ...approvalRow,
      approved: true,
      payout,
      executed: {
        ok: payout.ok,
        http_status: executed.httpStatus,
        ...(executed.body ?? {}),
      },
    },
  };
}
