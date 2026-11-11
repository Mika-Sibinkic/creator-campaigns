// src/lib/payment-claim.ts
//
// The three primitives every money-moving path must share, so the paths cannot
// drift apart again. There are two such paths today:
//
//   - src/lib/execute-payment.ts           (approve auto-execute + manual execute)
//   - src/lib/onboarding-payout.ts         (Stripe account.updated → transfer)
//
// Before this module each path had its own copy of each primitive, and they had
// already diverged in three ways that matter:
//
//   1. IDEMPOTENCY KEY. execute sent `${id}.${leg}`, the webhook sent `${id}`.
//      A row reclaimed from 'executing' (payment-reclaim.ts) can be retried by
//      EITHER path, and Stripe only dedupes an identical key — so the same
//      authorization could be transferred twice under two keys. The reclaimer's
//      safety argument ("a blind retry is fine because every provider call is
//      idempotency-keyed") was only true within one path.
//
//   2. THE CLAIM. execute stamped `executing_at` with the claim; the webhook did
//      not. payment-reclaim.ts only finds rows with a non-null `executing_at`,
//      so a webhook payout that died mid-transfer stayed 'executing' forever,
//      counted as spent by every cap.
//
//   3. THE OFFER. Neither path re-read the deal before paying. The human
//      approval is on the authorization row, but the deal can be cancelled,
//      closed or marked undelivered after that approval — and the webhook can
//      fire days later, when the creator finishes Stripe onboarding.
//
// Pre-055 compatibility: migration 055 adds `payment_authorizations.leg` and
// `executing_at`. On a database with 055 applied the fallback below never
// fires; it stays for any database that predates 055.
// Everything here degrades the same way authorize-payment.ts does — try the 055
// shape, and on a query ERROR (never on an empty result) retry the legacy shape
// and say so in the log.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MODE_MISMATCH_ACTION,
  MODE_MISMATCH_PREFIX,
  modeMismatchGuidance,
  modeMismatchReason,
} from './payment-mode-copy';

export type SettlementLeg = 'full' | 'deposit' | 'balance';

/**
 * The provider idempotency key for one authorization.
 *
 * Leg-scoped (`<id>.<leg>`), which is the format execute-payment.ts already
 * shipped with 1df778f; the webhook converges on it rather than the other way
 * round. A row with no leg (pre-055) is a 'full' leg by definition — that is
 * the column default 055 gives every existing row — so both paths produce the
 * same key for it before AND after the migration.
 */
export function payoutIdempotencyKey(pa: { id: string; leg?: SettlementLeg | string | null }): string {
  return `${pa.id}.${pa.leg ?? 'full'}`;
}

export interface ClaimResult {
  /** True iff THIS call moved the row into 'executing'. */
  claimed: boolean;
  /** False when the table has no `executing_at` column yet (pre-055). */
  executingAtStamped: boolean;
  /**
   * Set when the claim was refused because the row was approved in a different
   * payment mode than the one this attempt would pay in (migration 064). The
   * caller must not move money; refuseModeMismatch records it.
   */
  modeMismatch?: { approvedMode: string | null };
}

/**
 * Atomically claim an authorization for execution: `<from> → executing`, with
 * `executing_at` stamped in the same statement so a claim stranded by a dead
 * process is findable by payment-reclaim.ts.
 *
 * Compare-and-set: 0 rows updated means another caller already claimed it (or
 * it is no longer in a claimable state) → `claimed: false`, and the caller must
 * not move money. The legacy retry happens ONLY on a query error — an empty
 * result is a lost race and retrying it would be a second claim attempt.
 */
export interface ClaimGuard {
  /** Only claim while `payment_provider_id IS NULL` — no transfer on file. */
  noTransfer?: boolean;
  /**
   * Only claim while `failure_reason` still equals this value (null = IS NULL).
   * Omit to not care. The retry path passes the value the human was shown, so
   * a row whose failure changed between the read and the click loses the claim.
   */
  failureReason?: string | null;
}

export async function claimForExecution(
  sb: SupabaseClient,
  id: string,
  fromStatuses: readonly string[],
  opts: {
    now?: Date;
    guard?: ClaimGuard;
    /**
     * The payment mode this attempt will send in, stamped WITH the claim. Without
     * it a claim that dies mid-transfer keeps the column default ('paper') or a
     * previous attempt's mode, and the reclaimer — which acts on the row's
     * recorded mode, never the current env's — cannot tell where it was sent.
     */
    paymentMode?: string;
    /**
     * Migration 064 mode pin: only claim while `approved_mode` equals this, the
     * mode the attempt will pay in. Passed by every money path once the
     * platform setting exists (resolveActivePaymentMode().pinned); omitted
     * pre-064, where the column does not exist. A row approved in Test is then
     * unclaimable while the platform pays in Live, and vice versa.
     */
    approvedMode?: string;
  } = {}
): Promise<ClaimResult> {
  const nowIso = (opts.now ?? new Date()).toISOString();
  const modeStamp = opts.paymentMode ? { payment_mode: opts.paymentMode } : {};
  const guard = opts.guard ?? {};
  // Every condition lives in the UPDATE's WHERE, so Postgres arbitrates it
  // against any concurrent writer — never a read-then-write check.
  const guarded = <Q extends { is: (c: string, v: null) => Q; eq: (c: string, v: string) => Q }>(q: Q): Q => {
    let out = q;
    if (guard.noTransfer) out = out.is('payment_provider_id', null);
    if ('failureReason' in guard) {
      out = guard.failureReason == null ? out.is('failure_reason', null) : out.eq('failure_reason', guard.failureReason);
    }
    if (opts.approvedMode) out = out.eq('approved_mode', opts.approvedMode);
    return out;
  };
  // A pinned claim that matched nothing: was it the mode? Read the row once.
  // Only a row still in a claimable state whose approved_mode differs is a
  // mismatch; anything else is an ordinary lost race.
  const mismatch = async (): Promise<ClaimResult['modeMismatch']> => {
    if (!opts.approvedMode) return undefined;
    const { data, error } = await sb
      .from('payment_authorizations')
      .select('id, status, approved_mode')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return undefined;
    const row = data as { status?: string; approved_mode?: string | null };
    if (!row.status || !fromStatuses.includes(row.status)) return undefined;
    if ((row.approved_mode ?? null) === opts.approvedMode) return undefined;
    return { approvedMode: row.approved_mode ?? null };
  };
  const stamped = await guarded(
    sb
      .from('payment_authorizations')
      .update({ status: 'executing', executing_at: nowIso, ...modeStamp } as never)
      .eq('id', id)
      .in('status', [...fromStatuses])
  )
    .select('id')
    .maybeSingle();
  if (!stamped.error) {
    if (stamped.data != null) return { claimed: true, executingAtStamped: true };
    const mm = await mismatch();
    return { claimed: false, executingAtStamped: true, ...(mm ? { modeMismatch: mm } : {}) };
  }

  // Pre-055: the column does not exist, so the whole UPDATE was rejected and
  // nothing changed. Claim without the timestamp — the row is then invisible to
  // the reclaimer, exactly as every execute claim was before 055, and the
  // stuck-executing anomaly lane still shows it (statuses.ts).
  console.warn(
    '[payment-claim] executing_at claim failed; claimed without it (pre-055 shape). ' +
      'Apply supabase/migrations/055_settlement_authorization_legs.sql so stranded claims are reclaimable.',
    { authorization_id: id, error: stamped.error.message }
  );
  const legacy = await guarded(
    sb
      .from('payment_authorizations')
      .update({ status: 'executing', ...modeStamp } as never)
      .eq('id', id)
      .in('status', [...fromStatuses])
  )
    .select('id')
    .maybeSingle();
  if (!legacy.error && legacy.data != null) return { claimed: true, executingAtStamped: false };
  const mm = legacy.error ? undefined : await mismatch();
  return { claimed: false, executingAtStamped: false, ...(mm ? { modeMismatch: mm } : {}) };
}

export interface ModeMismatchInput {
  id: string;
  firmId: string | null;
  creatorOfferId: string | null;
  campaignId?: string | null;
  leg?: SettlementLeg | string | null;
  amountUsd?: number | null;
  /** The statuses the refused claim was made from. */
  fromStatuses: readonly string[];
  approvedMode: string | null;
  currentMode: string;
  /** Which money path refused ('execute' | 'stripe_onboarding_webhook'). */
  path: string;
}

/**
 * Record a mode-mismatch refusal: the row becomes 'failed' with
 * failure_reason `mode_mismatch:<approved>:<current>` (no transfer on file, so
 * it is not retryable and a re-mint plus a fresh approval replaces it), the
 * refusal is audited as payment.mode_mismatch for the /anomalies money lane,
 * and the one operator sentence comes back. Compare-and-set on the claimable
 * state, so it never lands on a row another writer moved.
 */
export async function refuseModeMismatch(
  sb: SupabaseClient,
  input: ModeMismatchInput,
  audit: (e: {
    action: string;
    target_type: string;
    target_id: string;
    firm_id?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>
): Promise<{ guidance: string; failureReason: string }> {
  const failureReason = modeMismatchReason(input.approvedMode, input.currentMode);
  const guidance = modeMismatchGuidance(input.approvedMode, input.currentMode);
  await sb
    .from('payment_authorizations')
    .update({ status: 'failed', failure_reason: failureReason } as never)
    .eq('id', input.id)
    .in('status', [...input.fromStatuses])
    .is('payment_provider_id', null);
  await audit({
    action: MODE_MISMATCH_ACTION,
    target_type: 'payment_authorization',
    target_id: input.id,
    firm_id: input.firmId ?? undefined,
    metadata: {
      path: input.path,
      creator_offer_id: input.creatorOfferId,
      campaign_id: input.campaignId ?? null,
      leg: input.leg ?? 'full',
      amount_usd: input.amountUsd ?? null,
      approved_mode: input.approvedMode,
      current_mode: input.currentMode,
      guidance,
    },
  });
  return { guidance, failureReason };
}

/**
 * Offer (deal) statuses under which each leg may still be paid.
 *
 * An allowlist, not a denylist: any status nobody thought about — including a
 * future one — refuses. The approve path (approve-payment.ts) checks this list
 * BEFORE approving and writes 'approved' onto the deal only for a full/deposit
 * leg, as a compare-and-set FROM this list — so an approval can no longer
 * reopen a closed deal. A balance leg leaves the deal 'posted'; 'approved'
 * stays admitted for balance only because an older approve route wrote
 * 'approved' over 'posted' on balance legs, and such rows may exist.
 *
 * Everything else refuses: rejected (cancelled / reviewer-rejected), failed,
 * undelivered, and every already-paid state — the last one also stops a leg
 * that was already settled from being paid a second time.
 */
export const PAYABLE_OFFER_STATUSES: Record<SettlementLeg, readonly string[]> = {
  full: ['human_approval_required', 'approved'],
  deposit: ['human_approval_required', 'approved'],
  balance: ['posted', 'approved'],
};

export function isOfferPayable(
  offerStatus: string | null | undefined,
  leg: SettlementLeg | string | null | undefined
): boolean {
  if (!offerStatus) return false;
  const allowed = PAYABLE_OFFER_STATUSES[(leg ?? 'full') as SettlementLeg];
  if (!allowed) return false;
  return allowed.includes(offerStatus);
}

export type OfferPayableVerdict =
  | { ok: true; offerStatus: string }
  | { ok: false; reason: 'offer_not_payable'; offerStatus: string | null }
  | { ok: false; reason: 'offer_lookup_failed'; offerStatus: null; error: string };

/**
 * Fresh read of the deal, taken AFTER the claim so a cancel that lands between
 * the approval and the transfer is seen. Fails closed: an unreadable offer is
 * not payable.
 */
export async function checkOfferPayable(
  sb: SupabaseClient,
  creatorOfferId: string,
  leg: SettlementLeg | string | null | undefined
): Promise<OfferPayableVerdict> {
  const { data, error } = await sb
    .from('creator_offers')
    .select('id, status')
    .eq('id', creatorOfferId)
    .maybeSingle();
  if (error) {
    return { ok: false, reason: 'offer_lookup_failed', offerStatus: null, error: error.message };
  }
  const status = (data as { status?: string | null } | null)?.status ?? null;
  if (!isOfferPayable(status, leg)) {
    return { ok: false, reason: 'offer_not_payable', offerStatus: status };
  }
  return { ok: true, offerStatus: status as string };
}

/** failure_reason written when a claimed payout is refused because the deal is
 *  no longer payable. Mapped to copy in statuses.ts and deal-errors.ts. */
export const OFFER_NOT_PAYABLE_REASON = 'offer_not_payable';

/** failure_reason written when paying this leg would take the deal's legs past
 *  its agreed amount. Non-retryable: the amount on the row is wrong, and a
 *  retry would re-send the same wrong amount. Re-mint the leg instead. */
export const LEGS_EXCEED_AGREED_REASON = 'legs_exceed_agreed';

/**
 * failure_reason on a row whose transfer call came back AMBIGUOUS — a network
 * error, timeout, Stripe 5xx or idempotency conflict, where the transfer may or
 * may not exist (stripe-isolated.ts classifies it). The row is left in
 * 'executing' with this marker: counted as spent by every cap, unclaimable by
 * Retry, the webhook and cancel, and resolved ONLY by asking Stripe
 * (payment-reconcile.ts — the "Check with Stripe" anomaly action and the
 * reclaimer). Never re-sent blind: past Stripe's idempotency window a re-send
 * is a second transfer.
 */
export const OUTCOME_UNKNOWN_REASON = 'stripe_outcome_unknown';

/**
 * failure_reason written when reconciliation asked Stripe and found NO transfer
 * for this row's transfer_group. The row is then an ordinary retryable 'failed'
 * row: a human Retry click may re-send. Deliberately not auto-resent.
 */
export const CONFIRMED_NOT_SENT_REASON = 'stripe_confirmed_not_sent';

/**
 * Audit action for a transfer that WENT OUT but whose terminal write did not
 * land on the authorization row — the write errored, or matched zero rows
 * because the row was no longer this claim's (reclaimed to 'approved', or
 * re-claimed by a later attempt). Money moved and the row does not say so; the
 * /anomalies money lane shows it with the transfer id (statuses.ts).
 */
export const COMPLETION_NOT_RECORDED_ACTION = 'payment.completion_not_recorded';

/**
 * The terminal write after a provider call, compare-and-set on THIS claim:
 * still 'executing', and — when the claim stamped one (post-055) — the same
 * executing_at. Before this the execute and onboarding paths wrote
 * `.eq('id', id)` and ignored the error, so a row the reclaimer had returned to
 * 'approved' (or a later attempt had re-claimed) was silently overwritten, and
 * a failed write after money moved was silent.
 *
 * `recorded: false` means the patch did NOT land; the caller decides what that
 * means (after a successful transfer: audit COMPLETION_NOT_RECORDED_ACTION).
 */
export async function writeClaimOutcome(
  sb: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
  claim: { claimedAtIso: string; executingAtStamped: boolean }
): Promise<{ recorded: boolean; error: string | null }> {
  let q = sb.from('payment_authorizations').update(patch as never).eq('id', id).eq('status', 'executing');
  if (claim.executingAtStamped) q = q.eq('executing_at', claim.claimedAtIso);
  const { data, error } = await q.select('id').maybeSingle();
  if (error) return { recorded: false, error: error.message ?? 'update_failed' };
  return { recorded: data != null, error: data != null ? null : 'no_matching_claim' };
}

/** Statuses of a sibling leg whose money has left (or is leaving). */
const MONEY_MOVED_LEG_STATUSES = ['completed', 'executing'];

export type LegsWithinAgreedVerdict =
  | { ok: true; agreedUsd: number; alreadyPaidUsd: number }
  | {
      ok: false;
      reason: 'legs_exceed_agreed';
      agreedUsd: number | null;
      alreadyPaidUsd: number;
      thisLegUsd: number;
    }
  | { ok: false; reason: 'legs_lookup_failed'; error: string };

/**
 * The last line before money moves: this leg plus every leg of the same deal
 * that has already moved money must not exceed the deal's agreed amount.
 *
 * authorize-payment.ts sizes the balance as agreed − deposit_paid, so this
 * should never fire; it exists because the balance used to be sized from the
 * firm's CURRENT deposit_pct and overpaid, and a
 * row minted by that code — or by any future bug — must not pay.
 *
 * "Already paid" is the larger of (a) sibling legs that are completed,
 * executing or carry a transfer id, and (b) what the deal RECORDS as paid on the
 * other legs (deposit_paid_usd / balance_paid_usd) — either alone can be
 * missing. Fails closed: an unreadable deal, or one with no agreed amount, is
 * not payable.
 */
export async function checkLegsWithinAgreed(
  sb: SupabaseClient,
  pa: { id: string; creator_offer_id: string; amount_usd: number; leg?: SettlementLeg | string | null }
): Promise<LegsWithinAgreedVerdict> {
  const thisLegUsd = Number(pa.amount_usd);
  const { data: offer, error: oErr } = await sb
    .from('creator_offers')
    .select('id, agreed_amount_usd, deposit_paid_usd, balance_paid_usd')
    .eq('id', pa.creator_offer_id)
    .maybeSingle();
  if (oErr) return { ok: false, reason: 'legs_lookup_failed', error: oErr.message };
  const o = (offer ?? {}) as {
    agreed_amount_usd?: number | string | null;
    deposit_paid_usd?: number | string | null;
    balance_paid_usd?: number | string | null;
  };
  const { data: siblings, error: sErr } = await sb
    .from('payment_authorizations')
    .select('id, status, amount_usd, payment_provider_id')
    .eq('creator_offer_id', pa.creator_offer_id);
  if (sErr) return { ok: false, reason: 'legs_lookup_failed', error: sErr.message };

  const cents = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  };
  const movedCents = ((siblings ?? []) as { id: string; status: string; amount_usd: unknown; payment_provider_id: string | null }[])
    .filter((r) => r.id !== pa.id && (MONEY_MOVED_LEG_STATUSES.includes(r.status) || !!r.payment_provider_id))
    .reduce((sum, r) => sum + cents(r.amount_usd), 0);
  const leg = pa.leg ?? 'full';
  const recordedCents =
    (leg !== 'deposit' ? cents(o.deposit_paid_usd) : 0) + (leg !== 'balance' ? cents(o.balance_paid_usd) : 0);
  const alreadyCents = Math.max(movedCents, recordedCents);
  const agreed = o.agreed_amount_usd == null ? null : Number(o.agreed_amount_usd);
  if (agreed == null || !Number.isFinite(agreed) || agreed <= 0 || !Number.isFinite(thisLegUsd)) {
    return { ok: false, reason: 'legs_exceed_agreed', agreedUsd: agreed, alreadyPaidUsd: alreadyCents / 100, thisLegUsd };
  }
  if (alreadyCents + cents(thisLegUsd) > cents(agreed)) {
    return { ok: false, reason: 'legs_exceed_agreed', agreedUsd: agreed, alreadyPaidUsd: alreadyCents / 100, thisLegUsd };
  }
  return { ok: true, agreedUsd: agreed, alreadyPaidUsd: alreadyCents / 100 };
}

/**
 * failure_reason values that mean a HUMAN (or the deal) said no. A failed row
 * carrying one of these is never retryable: retrying would overturn a stop.
 *   - offer_not_payable      the deal was closed after the approval
 *   - legs_exceed_agreed     the leg's amount would overpay the deal
 *   - stripe_outcome_unknown the transfer may exist; only reconciliation may
 *                            resolve it (defensive — the marker lives on an
 *                            'executing' row, never a 'failed' one)
 *   - cancelled_by_operator  the quick-offer cancel route (older rows)
 *   - revoked_before_payout  reject-payment.ts REVOKED_REASON (defensive: a
 *                            revoke writes 'rejected', not 'failed')
 */
export const NON_RETRYABLE_FAILURE_REASONS: readonly string[] = [
  OFFER_NOT_PAYABLE_REASON,
  LEGS_EXCEED_AGREED_REASON,
  OUTCOME_UNKNOWN_REASON,
  'cancelled_by_operator',
  'revoked_before_payout',
];

export type RetryRefusal = 'not_failed' | 'no_approval' | 'transfer_on_file' | 'stopped' | 'mode_mismatch';

/** Operator copy per refusal, returned as `guidance` by execute-payment.ts. */
export const RETRY_REFUSAL_GUIDANCE: Record<RetryRefusal, string> = {
  not_failed: 'No money moved from this click: this payment is not in a failed state. Reload the page to see where it is now.',
  no_approval: 'No money moved: this payment has no human approval on it, so it cannot be retried. It needs a fresh approval.',
  transfer_on_file:
    'No money moved from this click: this payment already reached the payment provider, so a retry could return the old transfer or pay twice. Check the provider dashboard before doing anything else.',
  stopped:
    'No money moved: this payment was stopped (the deal was closed, cancelled or the payment revoked), so it cannot be retried.',
  mode_mismatch:
    'No money moved. This payment was approved in a different payments mode (Test or Live), so it cannot be retried. Set it up again and approve it to pay in the current mode.',
};

/**
 * May a human click on "Retry payment" re-run this failed authorization?
 * Returns null when it may, else why not.
 *
 * Retry is allowed ONLY for a failed row that never transferred money: the
 * provider refused, a cap blocked it, or the recipient was missing. The click
 * is the human action; the original approval stays on the row (migration 009's
 * human_approval_required_for_execute admits 'failed' → 'executing' only with
 * human_approved_at set, and neither this nor the claim touches it). A row with
 * a transfer id on file is refused because the idempotency key is per
 * authorization — Stripe would hand back the ORIGINAL (e.g. reversed) transfer
 * inside its 24h window and the retry would record it as a fresh success.
 */
export function retryRefusal(pa: {
  status: string;
  payment_provider_id: string | null;
  failure_reason: string | null;
  human_approved_at: string | null;
}): RetryRefusal | null {
  if (pa.status !== 'failed') return 'not_failed';
  if (!pa.human_approved_at) return 'no_approval';
  if (pa.payment_provider_id) return 'transfer_on_file';
  if (pa.failure_reason && NON_RETRYABLE_FAILURE_REASONS.includes(pa.failure_reason)) return 'stopped';
  // Approved in another payments mode (migration 064): a retry rides the old
  // approval, which is exactly what the mode pin forbids. Re-mint + approve.
  if (pa.failure_reason && pa.failure_reason.startsWith(MODE_MISMATCH_PREFIX)) return 'mode_mismatch';
  return null;
}

/**
 * The creator_offers write for a leg that just settled, plus whether promo
 * materials go out with it. Shared by execute-payment.ts and
 * onboarding-payout.ts so the two money paths settle a leg identically — the
 * webhook used to write 'paid' + paid_at for every leg, which turned a deposit
 * into a finished deal and made its balance leg unpayable.
 *
 *   deposit  → 'deposit_paid' + deposit_paid_usd. NO paid_at: webhooks/stripe
 *              and webhooks/paypal use `paid_at IS NULL` as their once-only
 *              gate, so stamping it here would mark the balance as handled.
 *              Materials ship now — the creator needs the track to make the
 *              post the balance is contingent on.
 *   balance  → 'balance_paid' + balance_paid_usd + paid_at. No materials
 *              (already sent with the deposit).
 *   full     → 'paid' + paid_at, materials. A row with no leg (pre-055) is
 *              'full', 055's column default.
 *
 * Statuses are migration 052's creator_offers_status_check values.
 */
export function offerSettlementUpdate(
  leg: SettlementLeg | string | null | undefined,
  amountUsd: number,
  nowIso: string
): {
  leg: SettlementLeg;
  patch: Record<string, unknown>;
  /** Column that is NULL until this leg settles — the webhook's once-only gate. */
  onceOnlyColumn: 'paid_at' | 'deposit_paid_usd' | 'balance_paid_usd';
  sendMaterials: boolean;
} {
  if (leg === 'deposit') {
    return {
      leg,
      patch: { status: 'deposit_paid', deposit_paid_usd: amountUsd, payout_status: 'paid' },
      onceOnlyColumn: 'deposit_paid_usd',
      sendMaterials: true,
    };
  }
  if (leg === 'balance') {
    return {
      leg,
      patch: { status: 'balance_paid', balance_paid_usd: amountUsd, paid_at: nowIso, payout_status: 'paid' },
      onceOnlyColumn: 'balance_paid_usd',
      sendMaterials: false,
    };
  }
  return {
    leg: 'full',
    patch: { status: 'paid', paid_at: nowIso, payout_status: 'paid' },
    onceOnlyColumn: 'paid_at',
    sendMaterials: true,
  };
}
