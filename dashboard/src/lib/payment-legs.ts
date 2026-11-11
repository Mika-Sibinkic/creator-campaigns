// src/lib/payment-legs.ts
//
// Every settlement leg of a deal, as the deals page shows and acts on it.
//
// Since migration 055 one creator_offer carries up to two payment_authorizations
// (leg = deposit + balance, or a single 'full'), each with its own human
// approval. The deals route used to build `new Map(rows.map(p =>
// [p.creator_offer_id, p]))`, which kept whichever row came back LAST and hid
// the other leg; DealRow then decided the money buttons from the offer's status,
// so a failed balance leg on a 'posted' deal had no Retry at all.
//
// The action rules here are the server's rules, imported rather than restated:
//   - retry: payment-claim.retryRefusal (failed, approved, no transfer id, not
//     stopped) AND payment-claim.isOfferPayable — execute-payment.ts re-checks
//     the deal after the claim, so a retry on an unpayable deal is refused.
//   - stop:  reject-payment.ts revokes approved|failed rows with no transfer id.
//     A failed row that was already stopped is not offered again.
//   - approve: the approve route auto-executes, which runs the same
//     offer-payable check, so Approve is offered only while it can pay.
//
// Pure module: no React, no I/O. Safe to import from a client component.

import { isOfferPayable, retryRefusal, OUTCOME_UNKNOWN_REASON, type SettlementLeg } from './payment-claim';

export type { SettlementLeg };

export interface DealPaymentLeg {
  id: string;
  leg: SettlementLeg;
  status: string;
  /** Reserved amount for THIS leg (migration 055), not the whole deal. */
  amount_usd: number;
  failure_reason: string | null;
  /** Migration 015 — paper | stripe_test | stripe_live, stamped at execute. */
  payment_mode: string | null;
  /** Transfer id on file. Any value means money may have moved: no retry, no stop. */
  payment_provider_id: string | null;
  human_approved_at: string | null;
}

const LEG_ORDER: Record<SettlementLeg, number> = { deposit: 0, full: 1, balance: 2 };

const LEG_LABELS: Record<SettlementLeg, string> = {
  deposit: 'Deposit',
  full: 'Full payment',
  balance: 'Balance',
};

/** A missing or unknown leg is 'full' — 055's column default for every old row. */
export function normalizeLeg(v: unknown): SettlementLeg {
  return v === 'deposit' || v === 'balance' ? v : 'full';
}

export function legLabel(leg: SettlementLeg | string | null | undefined): string {
  return LEG_LABELS[normalizeLeg(leg)];
}

/** Raw payment_authorizations row as selected by the deals route. */
export interface RawLegRow {
  id: string;
  creator_offer_id: string;
  /** Absent on the pre-055 select. */
  leg?: string | null;
  status: string;
  amount_usd: number | string;
  failure_reason?: string | null;
  payment_mode?: string | null;
  payment_provider_id?: string | null;
  human_approved_at?: string | null;
}

/** Every leg per offer, ordered deposit → full → balance. */
export function groupLegsByOffer(rows: readonly RawLegRow[]): Map<string, DealPaymentLeg[]> {
  const out = new Map<string, DealPaymentLeg[]>();
  for (const r of rows) {
    const list = out.get(r.creator_offer_id) ?? [];
    list.push({
      id: r.id,
      leg: normalizeLeg(r.leg),
      status: r.status,
      amount_usd: Number(r.amount_usd),
      failure_reason: r.failure_reason ?? null,
      payment_mode: r.payment_mode ?? null,
      payment_provider_id: r.payment_provider_id ?? null,
      human_approved_at: r.human_approved_at ?? null,
    });
    out.set(r.creator_offer_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => LEG_ORDER[a.leg] - LEG_ORDER[b.leg]);
  return out;
}

export interface LegActions {
  approve: boolean;
  reject: boolean;
  execute: boolean;
  retry: boolean;
  stop: boolean;
  /** Claimed for execution — no action is safe until it lands. */
  inFlight: boolean;
}

export function legActions(l: DealPaymentLeg, offerStatus: string | null | undefined): LegActions {
  const payable = isOfferPayable(offerStatus, l.leg);
  const pending = l.status === 'pending_human_review';
  const approved = l.status === 'approved';
  const retryable = l.status === 'failed' && retryRefusal(l) === null;
  return {
    approve: pending && payable,
    reject: pending,
    execute: approved && !!l.human_approved_at && payable,
    retry: retryable && payable,
    stop: (approved && !l.payment_provider_id) || retryable,
    inFlight: l.status === 'executing',
  };
}

const STOP_REASONS = new Set(['revoked_before_payout', 'cancelled_by_operator']);

/** What state this leg is in, in the words a label manager reads. */
export function legStatusText(l: DealPaymentLeg, payoutStatus: string | null | undefined): string {
  switch (l.status) {
    case 'pending_human_review':
      return 'Awaiting approval';
    case 'approved':
      return payoutStatus === 'awaiting_onboarding'
        ? 'Approved, sends when the creator finishes payout setup'
        : 'Approved, not sent';
    case 'executing':
      // An ambiguous transfer outcome stays 'executing' (payment-claim
      // OUTCOME_UNKNOWN_REASON) — "Sending…" would claim it is in flight.
      return l.failure_reason === OUTCOME_UNKNOWN_REASON
        ? 'Not confirmed by Stripe. Do not retry; being checked'
        : 'Sending…';
    case 'completed':
      return l.payment_mode === 'paper' ? 'Recorded, no money moved' : 'Paid';
    case 'failed':
      return 'Failed';
    case 'rejected':
      return l.failure_reason && STOP_REASONS.has(l.failure_reason) ? 'Stopped' : 'Rejected';
    default: {
      const s = l.status.replace(/_/g, ' ');
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
  }
}

/**
 * failure_reasons that mean a PERSON stopped the leg on purpose (as opposed to
 * the system refusing it). A 'failed' row carrying one is an older
 * cancel/revoke; today both write 'rejected'.
 */
const HUMAN_STOP_FAILURE_REASONS: ReadonlySet<string> = STOP_REASONS;

/**
 * Was this leg stopped by a person — reviewer reject, revoke, cancel — with no
 * transfer on file? Such a leg stays closed: nothing automatic may re-create
 * it, and the gap below does not nag about it. Only the operator's explicit
 * re-create (remint with reopenStopped) may replace it.
 */
export function legStoppedByHuman(l: { status: string; failure_reason?: string | null; payment_provider_id?: string | null }): boolean {
  if (l.payment_provider_id) return false;
  if (l.status === 'rejected') return true;
  return l.status === 'failed' && !!l.failure_reason && HUMAN_STOP_FAILURE_REASONS.has(l.failure_reason);
}

export interface GapOptions {
  /**
   * The operator explicitly asked to re-create a payment a person stopped.
   * Then a human-stopped leg with no transfer on file no longer accounts for
   * the payment. Never set by an automatic path.
   */
  reopenStopped?: boolean;
}

/**
 * Does this leg mean the deal's payment IS accounted for — so a re-mint would
 * be a duplicate (or would overturn a human)? True for anything queued, moving
 * or moved (pending, approved, executing, completed, a retryable failure, any
 * row with a transfer id) and for anything a person stopped (rejected, or a
 * legacy failed cancel/revoke) — unless `reopenStopped`, the operator's
 * explicit re-create. False for a dead, unsent system failure (e.g.
 * legs_exceed_agreed, offer_not_payable): nothing is queued and nobody said no.
 */
export function legAccountsForPayment(
  l: {
    status: string;
    failure_reason?: string | null;
    payment_provider_id?: string | null;
    human_approved_at?: string | null;
  },
  opts: GapOptions = {}
): boolean {
  if (l.payment_provider_id) return true;
  if (legStoppedByHuman(l)) return !opts.reopenStopped;
  if (l.status !== 'failed') return true;
  return retryRefusal({
    status: l.status,
    payment_provider_id: l.payment_provider_id ?? null,
    failure_reason: l.failure_reason ?? null,
    human_approved_at: l.human_approved_at ?? 'approved',
  }) === null;
}

/**
 * The deal is waiting on a payment that does not exist: nothing is in
 * /approvals for it, and nothing will be paid until one is created.
 *
 *   'first'    agreed + awaiting approval, but no deposit/full leg was ever
 *              minted (negotiation's automint failed) — the deal used to read
 *              "waiting on your approval" with an empty /approvals.
 *   'balance'  posted on the split path with the deposit paid and no balance
 *              leg (the post route's mint failed) — the remainder is owed and
 *              nothing would ever mint it.
 *   null       otherwise.
 * A leg a person stopped counts as accounted (the deal is not "waiting" — a
 * human said no) unless opts.reopenStopped: the operator's explicit re-create.
 * Shared by the deals API, DealRow and remintPaymentForOffer, so the button and
 * the server's refusal can never disagree.
 */
export function approvalQueueGap(
  offer: { status: string | null | undefined; deposit_paid_usd?: number | string | null; balance_paid_usd?: number | string | null },
  legs: readonly { leg?: string | null; status: string; failure_reason?: string | null; payment_provider_id?: string | null; human_approved_at?: string | null }[],
  opts: GapOptions = {}
): 'first' | 'balance' | null {
  if (offer.status === 'human_approval_required') {
    const accounted = legs.some((l) => normalizeLeg(l.leg) !== 'balance' && legAccountsForPayment(l, opts));
    return accounted ? null : 'first';
  }
  if (offer.status === 'posted' && offer.deposit_paid_usd != null && offer.balance_paid_usd == null) {
    const accounted = legs.some((l) => normalizeLeg(l.leg) === 'balance' && legAccountsForPayment(l, opts));
    return accounted ? null : 'balance';
  }
  return null;
}
