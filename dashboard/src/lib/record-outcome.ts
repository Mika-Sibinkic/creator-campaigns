// src/lib/record-outcome.ts
//
// The deal-status half of POST /api/outcomes/record, extracted so it is
// testable without Clerk or Next.
//
// THE DEFECT THIS CLOSES: the route
// wrote creator_offers.status = 'measured' unconditionally after upserting the
// measurement. On the split path a deal is 'posted' while its balance leg waits
// in /approvals — and payment-claim.PAYABLE_OFFER_STATUSES only lets a balance
// be paid from 'posted' (or legacy 'approved'). Recording streams early made
// the owed balance unpayable: approve refused it, and execute's post-claim
// re-check failed it with offer_not_payable. It could also overwrite any
// other state (human_approval_required, deposit_paid, rejected…) with
// 'measured'.
//
// Now the measurement is always recorded (the route's campaign_outcomes
// upsert), but the deal only moves to 'measured':
//   - from a state that may reach it (negotiation.ts VALID_TRANSITIONS:
//     posted, balance_paid), as a compare-and-set FROM those states, and
//   - when no payment leg is unsettled: nothing pending, approved, executing,
//     retryable-failed or with a transfer on file but not completed, and no
//     balance owed with nothing minted (payment-legs.approvalQueueGap).
//   - when the balance is not one a PERSON stopped with nothing paid
//     (reject / revoke / cancel, no transfer on file, balance_paid_usd null).
// Otherwise the deal keeps its state; a later re-measure, once the money has
// settled, moves it.
//
// THE STOPPED-BALANCE RULE: a rejected
// balance used to count as settled, so recording streams moved the deal to
// 'measured' — which is TERMINAL (negotiation.ts VALID_TRANSITIONS: measured →
// nothing) and not a state a balance may be minted or paid from
// (LEG_REQUIRED_OFFER_STATUS / PAYABLE_OFFER_STATUSES: 'posted'). The explicit
// "Re-create stopped payment" then answered 409 nothing_to_mint for good.
// Keeping the deal 'posted' is the coherent choice: the measurement is still
// recorded (the route upserts campaign_outcomes first), 'posted' and 'measured'
// contribute the same agreed amount to the 054 budget guard (both committed,
// neither 'undelivered'), no transition out of a terminal state is invented,
// and the re-create path stays open. Once the operator re-creates and pays it
// (balance_paid) the next measurement moves it to 'measured' as usual.

import type { SupabaseClient } from '@supabase/supabase-js';
import { retryRefusal } from './payment-claim';
import { approvalQueueGap, legStoppedByHuman, normalizeLeg } from './payment-legs';

/** Deal states that may become 'measured' (negotiation.ts VALID_TRANSITIONS). */
export const MEASURABLE_OFFER_STATUSES: readonly string[] = ['posted', 'balance_paid'];

export type MarkMeasuredResult =
  | { written: true }
  | {
      written: false;
      reason: 'already_measured' | 'status_not_measurable' | 'payment_unsettled' | 'balance_stopped' | 'lookup_failed';
      status: string | null;
    };

interface LegRow {
  leg?: string | null;
  status: string;
  failure_reason: string | null;
  payment_provider_id: string | null;
  human_approved_at: string | null;
}

/** Is this leg's money still open — something a human or the provider has yet
 *  to finish? A completed leg, a rejected one, and a dead non-retryable
 *  failure with nothing sent are closed. */
export function legUnsettled(l: LegRow): boolean {
  if (['pending_human_review', 'approved', 'executing'].includes(l.status)) return true;
  if (l.status !== 'failed') return false;
  if (l.payment_provider_id) return true;
  return retryRefusal(l) === null;
}

export async function markOfferMeasured(sb: SupabaseClient, offerId: string): Promise<MarkMeasuredResult> {
  const { data: offer, error: oErr } = await sb
    .from('creator_offers')
    .select('id, status, deposit_paid_usd, balance_paid_usd')
    .eq('id', offerId)
    .maybeSingle();
  if (oErr || !offer) return { written: false, reason: 'lookup_failed', status: null };
  const o = offer as { status: string; deposit_paid_usd: number | null; balance_paid_usd: number | null };
  if (o.status === 'measured') return { written: false, reason: 'already_measured', status: o.status };
  if (!MEASURABLE_OFFER_STATUSES.includes(o.status)) {
    return { written: false, reason: 'status_not_measurable', status: o.status };
  }

  const legsQ = (withLeg: boolean) =>
    sb
      .from('payment_authorizations')
      .select(`status, failure_reason, payment_provider_id, human_approved_at${withLeg ? ', leg' : ''}`)
      .eq('creator_offer_id', offerId);
  let { data: legRows, error: lErr } = await legsQ(true);
  if (lErr) ({ data: legRows, error: lErr } = await legsQ(false));
  // Fail closed: if the legs cannot be read, the deal keeps its state.
  if (lErr) return { written: false, reason: 'lookup_failed', status: o.status };
  const legs = (legRows ?? []) as unknown as LegRow[];
  if (legs.some(legUnsettled) || approvalQueueGap(o, legs) !== null) {
    return { written: false, reason: 'payment_unsettled', status: o.status };
  }
  // A balance a person stopped, nothing paid: keep 'posted' so the operator's
  // explicit re-create stays possible (see THE STOPPED-BALANCE RULE above).
  if (
    o.status === 'posted' &&
    o.balance_paid_usd == null &&
    legs.some((l) => normalizeLeg(l.leg) === 'balance' && legStoppedByHuman(l))
  ) {
    return { written: false, reason: 'balance_stopped', status: o.status };
  }

  const { data: moved } = await sb
    .from('creator_offers')
    .update({ status: 'measured' } as never)
    .eq('id', offerId)
    .in('status', [...MEASURABLE_OFFER_STATUSES])
    .select('id')
    .maybeSingle();
  return moved ? { written: true } : { written: false, reason: 'status_not_measurable', status: null };
}
