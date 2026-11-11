// src/lib/approvals-query.ts
//
// SEC: the firm-scoped read behind /approvals. Extracted from the page for the
// same reason src/lib/authorize-payment.ts was extracted from its route — a
// server component that calls requireSessionAndClient() internally cannot be
// driven hermetically, so the authorization decision it makes cannot be tested.
//
// The bug this closes: src/app/approvals/page.tsx selected
// payment_authorizations filtered ONLY by status='pending_human_review'. Post-
// Clerk, requireSessionAndClient() hands back the SERVICE-ROLE client
// (src/lib/auth.ts:160), which is RLS-inert — the
// `payment_auth_select_own_firm` policy in migration 009 never runs for it. So
// the page rendered every firm's pending payouts (creator handles, contact
// emails, amounts, campaigns) to any authenticated member of any firm. The
// page's own header comment claimed it was "RLS-scoped to firm via
// firm_members"; that comment was stale, not a description of the query.
//
// Fail-closed by construction, per src/lib/firm-scope.ts: a blank/missing
// caller firm (getSession() returns firm_id '' for an authenticated but
// unprovisioned Clerk user, auth.ts:111) yields NOTHING, never everything. We
// refuse before issuing the query rather than relying on Postgres rejecting
// '' as a uuid.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isOfferPayable } from './payment-claim';
import { normalizeLeg } from './payment-legs';
import { readDoNotContactFlags } from './firm-blocks';
import type { DoNotContactDisplay } from './do-not-contact-copy';
import { readLastSentOffers } from './last-sent-offer';

/** Why the approvals read was refused. Stable strings — safe to assert on. */
export type ApprovalsDenial = 'caller_unscoped' | 'query_failed';

export interface PendingApprovalRow {
  id: string;
  amount_usd: number;
  currency: string;
  created_at: string;
  status: string;
  /** Settlement leg (migration 055). Absent on the pre-055 fallback — read it
   *  through payment-legs.normalizeLeg, which treats absent as 'full'. */
  leg?: string | null;
  creator_offer_id: string;
  /**
   * False when the deal is closed for this leg (cancelled, rejected, already
   * paid…) — the approve route refuses such a leg with 409, so the page must
   * not offer an Approve button for it. Computed with the same allowlist the
   * approve and execute paths use (payment-claim.isOfferPayable).
   */
  payable: boolean;
  /** Label-readable reason when `payable` is false; null otherwise. */
  blocked_reason: string | null;
  creator_offers: {
    id: string;
    /** The deal's status — what `payable` is decided from. */
    status: string;
    rounds: number;
    /** The opening offer: the last price sent when no counter went out. */
    initial_offer_usd?: number | null;
    /** The lead this deal is on (for the last-sent-price read). */
    campaign_influencer_id?: string | null;
    current_offer_usd: number | null;
    agreed_amount_usd: number | null;
    ceiling_usd: number;
    agreed_deliverables: unknown;
    contract_generated_at: string | null;
    campaigns: { id: string; artist_name: string } | null;
    campaign_influencers: {
      influencer_id: string;
      influencer: {
        username: string;
        display_name: string | null;
        follower_count: number | null;
        engagement_rate: number | null;
        contact_email: string | null;
        profile_url: string | null;
      };
    };
  };
}

export type ApprovalsResult =
  | { ok: true; rows: PendingApprovalRow[] }
  | { ok: false; reason: ApprovalsDenial; message: string };

/** A firm id is usable only if it is a non-blank string. Mirrors firm-scope.ts. */
function isScoped(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** The columns the approvals card needs. Kept here so the firm filter and the
 *  projection can never drift apart in two files. */
const approvalsSelect = (withLeg: boolean) => `id, amount_usd, currency, created_at, status,${withLeg ? ' leg,' : ''}
       creator_offer_id,
       creator_offers!inner(
         id, status, rounds, initial_offer_usd, current_offer_usd, agreed_amount_usd, ceiling_usd,
         agreed_deliverables, contract_generated_at,
         campaign_influencer_id,
         campaigns(id, artist_name),
         campaign_influencers!inner(
           influencer_id,
           influencer:influencers(username, display_name, follower_count, engagement_rate, contact_email, profile_url)
         )
       )`;

/**
 * Pending payment authorizations for ONE firm.
 *
 * `callerFirmId` is the authorization boundary, not a display filter: the
 * client passed in is service-role, so this `.eq('firm_id', ...)` is the only
 * thing standing between firm A and firm B's payout queue.
 */
export async function fetchPendingApprovals(
  sb: SupabaseClient,
  callerFirmId: string | null | undefined
): Promise<ApprovalsResult> {
  if (!isScoped(callerFirmId)) {
    return {
      ok: false,
      reason: 'caller_unscoped',
      message: 'Your account is not linked to a firm yet, so there is nothing to approve.',
    };
  }

  const query = (withLeg: boolean) =>
    sb
      .from('payment_authorizations')
      .select(approvalsSelect(withLeg))
      .eq('firm_id', callerFirmId)
      .eq('status', 'pending_human_review')
      .order('created_at', { ascending: true });

  // The leg says WHICH payment the human is approving (a deal can carry a
  // deposit and a balance). Same degrade as authorize-payment.ts: on a query
  // ERROR retry the pre-055 shape, where every row is a 'full' leg.
  let { data, error } = await query(true);
  if (error) {
    console.warn('[approvals-query] leg-aware select failed; retrying pre-055 shape:', error.message);
    ({ data, error } = await query(false));
  }

  if (error) {
    return { ok: false, reason: 'query_failed', message: error.message };
  }

  // A pending leg on a deal that is no longer payable for it (the deal was
  // cancelled or rejected after the leg was minted) is listed BLOCKED, not
  // hidden: hidden, it would sit in pending_human_review forever with nothing
  // to clear it; listed with an Approve button, it was the adversarial
  // review's "approve reopens a closed deal and pays" path.
  const rows = ((data ?? []) as unknown as Omit<PendingApprovalRow, 'payable' | 'blocked_reason'>[]).map(
    (r) => {
      const offerStatus = r.creator_offers?.status ?? null;
      const payable = isOfferPayable(offerStatus, normalizeLeg(r.leg));
      return {
        ...r,
        payable,
        blocked_reason: payable ? null : blockedReasonFor(offerStatus),
      } as PendingApprovalRow;
    }
  );
  return { ok: true, rows };
}

/**
 * Each pending row's creator, checked against the caller firm's do-not-contact
 * list: "Creator opted out" has to be on the card
 * BEFORE the human approves a payment to someone who told the label to stop.
 *
 * DISPLAY ONLY. Nothing here feeds `payable`, the Approve button, or any
 * payment path — whether to pay an opted-out creator for work already agreed
 * is the human's call, and this makes sure it is an informed one. Kept out of
 * fetchPendingApprovals so the firm-scoped read stays exactly one query.
 *
 * An unreadable list marks every row without a known flag 'unknown' — absent
 * is not clear.
 */
export async function doNotContactForApprovals(
  sb: SupabaseClient,
  callerFirmId: string,
  rows: PendingApprovalRow[],
): Promise<Map<string, DoNotContactDisplay>> {
  const out = new Map<string, DoNotContactDisplay>();
  const infOf = (r: PendingApprovalRow) => r.creator_offers?.campaign_influencers?.influencer_id ?? null;
  const read = await readDoNotContactFlags(sb, callerFirmId, rows.map(infOf));
  for (const r of rows) {
    const inf = infOf(r);
    const flag = inf ? read.flags.get(inf) : undefined;
    if (flag) out.set(r.id, flag);
    else if (read.state === 'unreadable' || !inf) out.set(r.id, 'unknown');
  }
  return out;
}

/**
 * The last price each row's creator was actually SENT, keyed by payment authorization id, for "Last price sent to
 * creator: $X" beside the agreed amount. Omitted when it cannot be known.
 *
 * DISPLAY ONLY, like doNotContactForApprovals: nothing here feeds `payable`,
 * the Approve button, or any payment path.
 */
export async function lastSentForApprovals(
  sb: SupabaseClient,
  rows: PendingApprovalRow[],
): Promise<Map<string, number>> {
  const byCi = await readLastSentOffers(
    sb,
    rows.map((r) => ({
      campaign_influencer_id: r.creator_offers?.campaign_influencer_id ?? null,
      initial_offer_usd: r.creator_offers?.initial_offer_usd ?? null,
    })),
  );
  const out = new Map<string, number>();
  for (const r of rows) {
    const ci = r.creator_offers?.campaign_influencer_id;
    const usd = ci ? byCi.get(ci) : undefined;
    if (usd != null) out.set(r.id, usd);
  }
  return out;
}

/** Why a pending leg cannot be approved, for the label. */
function blockedReasonFor(offerStatus: string | null): string {
  switch (offerStatus) {
    case 'rejected':
      return 'This deal was cancelled or rejected, so this payment can no longer be approved. Reject it to clear it.';
    case 'failed':
    case 'undelivered':
      return 'This deal is closed, so this payment can no longer be approved. Reject it to clear it.';
    case 'paid':
    case 'deposit_paid':
    case 'balance_paid':
    case 'measured':
      return 'This part of the deal is already paid, so approving it again could pay twice. Reject it to clear it.';
    default:
      return 'This deal is not in a state that can be paid right now, so this payment cannot be approved. Reject it to clear it.';
  }
}
