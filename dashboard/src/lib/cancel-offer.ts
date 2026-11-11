// src/lib/cancel-offer.ts
//
// The core of POST /api/campaigns/[id]/quick-offer/[ci_id]/cancel — "undo" for
// a deal, from any pre-paid offer state. Extracted so it is testable without
// Clerk or Next; the route keeps rate limiting and the session.
//
// What it used to do, and why that was wrong:
//   * It flipped the offer's authorization to 'failed' unless it was
//     'completed' — so an 'executing' row, mid-transfer, was relabelled failed
//     while the money was still moving (and became re-claimable by Retry).
//   * It read the authorization with .maybeSingle(). Since migration 055 an
//     offer can carry two legs (deposit + balance); PostgREST errors on two
//     rows, the error was ignored, and the legs were silently left live.
//   * It wrote 'failed' onto a 'pending_human_review' row, which migration
//     009's human_approval_required_for_execute CHECK rejects (failed needs an
//     approval stamp) — so that cancel half-applied.
//
// What it does now:
//   1. Offer past the safe-rollback line (any paid / posted / closed status)
//      → 409 too_late. Nothing written.
//   2. Read EVERY leg of the offer.
//   3. Any leg 'executing' → 409 payout_in_progress. Nothing written: the
//      transfer is in flight and the claim holder owns the row.
//   4. Any leg that moved money ('completed', or a transfer id on file) → 409
//      too_late. Undoing that is a refund, not a cancel. A pending leg of such
//      a deal is stopped with Stop payment (reject-payment.ts) on its own.
//   5. Otherwise: flip the offer to 'rejected' FIRST (compare-and-set on the
//      status just read), so a claim racing this cancel sees a closed deal at
//      its post-claim re-check (payment-claim.checkOfferPayable) and refuses.
//      Then stop each live leg through rejectPaymentAuthorization — the same
//      reject/revoke logic as the Reject and Stop payment buttons, so the 009
//      CHECK, the compare-and-set and the audit trail are all shared.

import type { SupabaseClient } from '@supabase/supabase-js';
import { rejectPaymentAuthorization, type RejectPaymentHooks } from './reject-payment';

export interface CancelOfferInput {
  campaignId: string;
  /** campaign_influencers.id from the route path. */
  ciId: string;
  /** Firm of the authenticated caller. */
  callerFirmId: string;
  actorUserId: string;
}

export interface CancelOfferOutcome {
  httpStatus: number;
  body: Record<string, unknown>;
}

/** failure_reason written on every leg a cancel stops. Mapped to copy in
 *  statuses.ts / deal-errors.ts, and non-retryable (payment-claim.ts). */
export const CANCELLED_REASON = 'cancelled_by_operator';

/**
 * Offer statuses past the point of safe rollback: money has moved (paid,
 * deposit_paid, balance_paid), the creator has published (posted), the outcome
 * is attributed (measured), or the deal already closed on a paid deposit
 * (undelivered). Migration 052 added the three split statuses.
 */
export const TERMINAL_OR_POST_PAID: ReadonlySet<string> = new Set([
  'paid',
  'deposit_paid',
  'posted',
  'balance_paid',
  'measured',
  'undelivered',
]);

/** Leg statuses a cancel stops. 'failed' only without a transfer id — the
 *  reject lib enforces that again in its own compare-and-set. */
const STOPPABLE = new Set(['pending_human_review', 'approved', 'failed']);

interface Leg {
  id: string;
  status: string;
  leg: string | null;
  payment_provider_id: string | null;
}

export async function cancelOffer(
  sb: SupabaseClient,
  input: CancelOfferInput,
  hooks: RejectPaymentHooks
): Promise<CancelOfferOutcome> {
  const { data: offer, error: offerErr } = await sb
    .from('creator_offers')
    .select('id, status, firm_id, campaign_id, campaign_influencer_id')
    .eq('campaign_influencer_id', input.ciId)
    .maybeSingle();
  if (offerErr) return { httpStatus: 500, body: { error: offerErr.message } };
  if (!offer) return { httpStatus: 404, body: { error: 'offer_not_found' } };
  const o = offer as { id: string; status: string; firm_id: string; campaign_id: string };
  if (!input.callerFirmId || o.firm_id !== input.callerFirmId) {
    return { httpStatus: 403, body: { error: 'forbidden' } };
  }
  if (o.campaign_id !== input.campaignId) {
    return { httpStatus: 400, body: { error: 'campaign_mismatch' } };
  }
  if (TERMINAL_OR_POST_PAID.has(o.status)) {
    return { httpStatus: 409, body: { error: 'too_late', status: o.status } };
  }
  // Already closed → idempotent ok (don't audit a no-op).
  if (o.status === 'rejected' || o.status === 'failed') {
    return { httpStatus: 200, body: { ok: true, already: o.status } };
  }

  // Every leg, not one: an offer carries up to two since migration 055.
  const { data: legRows, error: legErr } = await sb
    .from('payment_authorizations')
    .select('id, status, leg, payment_provider_id')
    .eq('creator_offer_id', o.id);
  if (legErr) {
    // Fail closed: without the legs we cannot know whether money is moving.
    return { httpStatus: 500, body: { error: legErr.message } };
  }
  const legs = (legRows ?? []) as Leg[];

  const inFlight = legs.filter((l) => l.status === 'executing');
  if (inFlight.length > 0) {
    return {
      httpStatus: 409,
      body: { error: 'payout_in_progress', in_flight: inFlight.map((l) => l.id) },
    };
  }
  const moved = legs.filter((l) => l.status === 'completed' || l.payment_provider_id);
  if (moved.length > 0) {
    return {
      httpStatus: 409,
      body: { error: 'too_late', reason: 'payment_already_sent', sent: moved.map((l) => l.id) },
    };
  }

  // Close the deal first, compare-and-set on the status we just read.
  const { data: closed, error: uErr } = await sb
    .from('creator_offers')
    .update({ status: 'rejected' } as never)
    .eq('id', o.id)
    .eq('status', o.status)
    .select('id')
    .maybeSingle();
  if (uErr) return { httpStatus: 500, body: { error: uErr.message } };
  if (!closed) return { httpStatus: 409, body: { error: 'invalid_state' } };

  const revoked: string[] = [];
  const notRevoked: { id: string; error: unknown }[] = [];
  for (const l of legs) {
    if (!STOPPABLE.has(l.status)) continue;
    const r = await rejectPaymentAuthorization(
      sb,
      { id: l.id, callerFirmId: input.callerFirmId, actorUserId: input.actorUserId, reason: CANCELLED_REASON },
      hooks
    );
    if (r.httpStatus === 200) revoked.push(l.id);
    else notRevoked.push({ id: l.id, error: r.body.error });
  }

  await hooks.audit({
    action: 'offer.cancelled',
    target_type: 'creator_offer',
    target_id: o.id,
    firm_id: o.firm_id,
    metadata: {
      campaign_id: input.campaignId,
      campaign_influencer_id: input.ciId,
      prior_status: o.status,
      had_payment_auth: legs.length > 0,
      legs: legs.map((l) => ({ id: l.id, leg: l.leg ?? 'full', prior_status: l.status })),
      revoked,
      not_revoked: notRevoked,
      actor_user_id: input.actorUserId,
    },
  });

  if (notRevoked.length > 0) {
    // A leg changed state between the read and its revoke — almost always a
    // claim to 'executing'. The deal is already closed, so that claim's
    // post-claim offer re-check refuses it unless it had already passed.
    return {
      httpStatus: 409,
      body: { error: 'payout_in_progress', offer_cancelled: true, revoked, not_revoked: notRevoked },
    };
  }
  return { httpStatus: 200, body: { ok: true, prior_status: o.status, revoked } };
}
