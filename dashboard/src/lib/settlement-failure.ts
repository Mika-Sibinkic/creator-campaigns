// src/lib/settlement-failure.ts
//
// What to do when money that already left the platform turns out not to have
// landed. Kept here (with injected audit/alert hooks) so the refusal behavior
// is testable without importing the whole webhook route — same doctrine as
// src/lib/spend-caps.ts `webhookCapGate` and src/lib/payout-surfacing.ts.
//
// ── Which Stripe events actually exist ───────────────────────────────────────
// `transfer.failed` DOES NOT EXIST. It, and `transfer.paid`, were deleted in
// the 2017-04-06 API version split; the modern Transfer object has no `status`,
// no `failure_code` and no `failure_message` at all. A platform→connected-
// account transfer is synchronous: it succeeds, or the API call throws and
// src/lib/stripe-isolated.ts maps it at call time. Do not add a handler for a
// string Stripe never sends.
//   https://docs.stripe.com/api/events/types  (complete current enumeration)
//   https://docs.stripe.com/transfer-payout-split  ("Transfers no longer
//   generate these events: transfer.paid and transfer.failed.")
//
// The two real async signals, and they mean different things:
//
//   transfer.reversed — the platform clawed the money back out of the
//     creator's Stripe balance. THE CREATOR IS NOT PAID. Reverse the payout.
//     data.object is the Transfer (never the reversal; there is no
//     `transfer_reversal.*` event). `reversed` is true only on a FULL
//     reversal, so partials must be detected with amount_reversed vs amount.
//
//   payout.failed — the creator's own bank rejected the payout from their
//     Stripe balance to their account. The label's money DID leave; it is
//     sitting in the creator's Stripe balance. This is NOT a reversal and must
//     not un-pay the deal — it is the creator's bank details to fix. Arrives
//     on the Connect endpoint with a top-level `account`, and the Payout
//     object DOES carry failure_code / failure_message.
//
// ── Where a reverted deal lands ──────────────────────────────────────────────
// `creator_offers.status` is NOT touched. 'failed' is TERMINAL in
// negotiation.ts VALID_TRANSITIONS, so writing it would strand a deal that is
// still legitimately retryable, and there is no 'paid' → 'approved' edge to
// go back along. Instead we follow the PayPal reversal precedent
// (webhooks/paypal/route.ts:196-224): mark `payout_status`, and put the
// payment_authorization into 'failed'. That is the state an operator can act
// on — it is what /anomalies filters for (statuses.ts payment_failed lane,
// `.eq('status','failed')`) and what execute-payment.ts re-claims from
// (`.in('status', ['approved','failed'])`), which gives the deal row its
// "Retry payment" button back.

import type { SupabaseClient } from '@supabase/supabase-js';
import { mapStripeError } from './stripe-errors';

/** Injected side effects, so the decision table is testable. Mirrors
 *  spend-caps.WebhookCapGateHooks exactly. */
export interface SettlementHooks {
  audit: (entry: {
    action: string;
    target_type: string;
    target_id: string;
    firm_id?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  alertOnce: (
    key: string,
    level: 'warning' | 'error',
    message: string,
    context: Record<string, unknown>
  ) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The authorized amount — refuse, never coerce
// ─────────────────────────────────────────────────────────────────────────────

export type AmountVerdict =
  | { ok: true; amountUsd: number }
  | { ok: false; reason: 'missing_amount' | 'invalid_amount' };

/**
 * Read `payment_authorizations.amount_usd` for a transfer that is about to be
 * sent.
 *
 * The webhook used to do `Number(r.amount_usd ?? 0)` for the
 * cap check and `r.amount_usd ?? 0` for the transfer itself. Every other money
 * fallback in this codebase refuses; that one silently paid a DIFFERENT, lower
 * amount — and $0 trivially passes every spend cap, so the guard that exists to
 * stop an overpayment would wave the broken row straight through.
 *
 * Unreachable through the DB today (migration 009: `amount_usd NUMERIC(10,2)
 * NOT NULL` + `CONSTRAINT positive_amount CHECK (amount_usd > 0)`) — but the
 * selected type is `number | null`, and the fallback is the one spot on the
 * money-out path whose failure mode is "pay less" rather than "refuse".
 */
export function readPayoutAmountUsd(raw: unknown): AmountVerdict {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, reason: 'missing_amount' };
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return { ok: false, reason: 'invalid_amount' };
  if (n <= 0) return { ok: false, reason: 'invalid_amount' };
  return { ok: true, amountUsd: n };
}

/** failure_reason slugs this module writes. Stable — asserted on in tests and
 *  given operator copy in src/lib/deal-errors.ts. */
export const SETTLEMENT_FAILURE_REASON = {
  missing_amount: 'invalid_payout_amount',
  invalid_amount: 'invalid_payout_amount',
  transfer_reversed: 'stripe_transfer_reversed',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 2. Shared refusal write
// ─────────────────────────────────────────────────────────────────────────────

interface RefuseInput {
  paymentAuthorizationId: string;
  firmId: string | null;
  creatorOfferId: string | null;
  /** Only claim the row if it is still in this status — idempotency. */
  expectStatus: string;
  failureReason: string;
  /** creator_offers.payout_status to write, or null to leave it alone. */
  payoutStatus: string | null;
  auditMetadata: Record<string, unknown>;
  alertKey: string;
  alertMessage: string;
}

/**
 * Move one authorization into 'failed' and surface it, exactly once.
 *
 * The `.eq('status', expectStatus)` on the claim is the idempotency gate: a
 * redelivered event finds the row already moved and writes nothing, so no
 * duplicate audit rows and no duplicate alerts. That matters because the
 * `processed_stripe_events` dedupe is read-then-insert and two concurrent
 * deliveries of the same event can both pass it.
 *
 * Safe under migration 009's `human_approval_required_for_execute` CHECK:
 * 'completed'/'executing' and 'failed' are both in the branch that requires
 * human_approved_at, so the row already satisfies it.
 */
async function refuseAuthorization(
  sb: SupabaseClient,
  input: RefuseInput,
  hooks: SettlementHooks
): Promise<boolean> {
  const { data: claimed, error: claimErr } = await sb
    .from('payment_authorizations')
    .update({ status: 'failed', failure_reason: input.failureReason } as never)
    .eq('id', input.paymentAuthorizationId)
    .eq('status', input.expectStatus)
    .select('id')
    .maybeSingle();

  if (claimErr || !claimed) return false;

  if (input.creatorOfferId && input.payoutStatus) {
    await sb
      .from('creator_offers')
      .update({ payout_status: input.payoutStatus } as never)
      .eq('id', input.creatorOfferId);
  }

  await hooks.audit({
    action: 'payment.failed',
    target_type: 'payment_authorization',
    target_id: input.paymentAuthorizationId,
    firm_id: input.firmId ?? undefined,
    metadata: {
      creator_offer_id: input.creatorOfferId,
      provider: 'stripe_connect',
      failure_reason: input.failureReason,
      ...input.auditMetadata,
    },
  });

  hooks.alertOnce(input.alertKey, 'error', input.alertMessage, {
    firm_id: input.firmId,
    payment_authorization_id: input.paymentAuthorizationId,
    creator_offer_id: input.creatorOfferId,
    ...input.auditMetadata,
  });

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Refuse a transfer whose amount is unreadable
// ─────────────────────────────────────────────────────────────────────────────

export interface RefuseAmountInput {
  paymentAuthorizationId: string;
  firmId: string | null;
  campaignId: string | null;
  creatorOfferId: string | null;
  verdict: Extract<AmountVerdict, { ok: false }>;
  rawAmount: unknown;
}

/**
 * The row was claimed 'approved' → 'executing' and then turned out to carry no
 * usable amount. Refuse: no transfer, row to 'failed', operator notified. A
 * retry cannot fix a broken amount, so this does NOT revert to 'approved' the
 * way a cap refusal does (spend-caps.ts:436 — "the transfer can retry once
 * there's room"); it needs a human to look at the row.
 */
export async function refuseUnreadableAmount(
  sb: SupabaseClient,
  input: RefuseAmountInput,
  hooks: SettlementHooks
): Promise<boolean> {
  return refuseAuthorization(
    sb,
    {
      paymentAuthorizationId: input.paymentAuthorizationId,
      firmId: input.firmId,
      creatorOfferId: input.creatorOfferId,
      expectStatus: 'executing',
      failureReason: SETTLEMENT_FAILURE_REASON[input.verdict.reason],
      payoutStatus: null,
      auditMetadata: {
        campaign_id: input.campaignId,
        amount_verdict: input.verdict.reason,
        raw_amount: input.rawAmount === undefined ? null : input.rawAmount,
      },
      alertKey: `payment_block:invalid_amount:${input.paymentAuthorizationId}`,
      alertMessage: 'Stripe payout refused: authorization carries no usable amount',
    },
    hooks
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. transfer.reversed — the creator is not paid
// ─────────────────────────────────────────────────────────────────────────────

export interface TransferReversedInput {
  /** data.object.id — `tr_…`, matched against payment_authorizations.payment_provider_id. */
  transferId: string | null | undefined;
  /** data.object.amount, minor units. */
  amountMinor: number | null;
  /** data.object.amount_reversed, minor units. */
  amountReversedMinor: number | null;
  /** data.object.reversed — true only on a FULL reversal. */
  reversed: boolean;
  eventId: string;
  /** The event's Stripe mode (the signing secret that verified it). When set,
   *  only a payment sent in that mode (payment_mode) is touched. */
  mode?: 'stripe_test' | 'stripe_live';
}

export type SettlementOutcome =
  | { handled: true; paymentAuthorizationId: string; fullyReversed: boolean }
  | {
      handled: false;
      reason: 'no_transfer_id' | 'unknown_transfer' | 'already_recorded' | 'no_account_id' | 'no_matching_deals';
    }
  | { handled: false; reason: 'lookup_failed'; retryable: true };

interface PaRow {
  id: string;
  firm_id: string | null;
  campaign_id: string | null;
  creator_offer_id: string | null;
  amount_usd: number | null;
  status: string;
}

export async function handleTransferReversed(
  sb: SupabaseClient,
  input: TransferReversedInput,
  hooks: SettlementHooks
): Promise<SettlementOutcome> {
  if (!input.transferId) return { handled: false, reason: 'no_transfer_id' };

  let q = sb
    .from('payment_authorizations')
    .select('id, firm_id, campaign_id, creator_offer_id, amount_usd, status')
    .eq('payment_provider_id', input.transferId);
  if (input.mode) q = q.eq('payment_mode', input.mode);
  const { data, error } = await q.maybeSingle();

  // A lookup we cannot complete is not "nothing to do" — 5xx so Stripe retries
  // rather than silently dropping a reversal.
  if (error) return { handled: false, reason: 'lookup_failed', retryable: true };
  if (!data) return { handled: false, reason: 'unknown_transfer' };

  const row = data as unknown as PaRow;

  // Partial reversals leave `reversed` false, so never trust it alone.
  const fullyReversed =
    input.reversed ||
    (input.amountMinor != null &&
      input.amountReversedMinor != null &&
      input.amountReversedMinor >= input.amountMinor);

  const did = await refuseAuthorization(
    sb,
    {
      paymentAuthorizationId: row.id,
      firmId: row.firm_id,
      creatorOfferId: row.creator_offer_id,
      expectStatus: 'completed',
      failureReason: SETTLEMENT_FAILURE_REASON.transfer_reversed,
      payoutStatus: 'returned',
      auditMetadata: {
        campaign_id: row.campaign_id,
        transfer_id: input.transferId,
        stripe_event_id: input.eventId,
        amount_usd: row.amount_usd,
        amount_reversed_minor: input.amountReversedMinor,
        fully_reversed: fullyReversed,
      },
      alertKey: `payment_reversed:${row.id}`,
      alertMessage: fullyReversed
        ? 'Stripe transfer fully reversed: creator was not paid'
        : 'Stripe transfer partially reversed: creator received less than agreed',
    },
    hooks
  );

  if (!did) return { handled: false, reason: 'already_recorded' };
  return { handled: true, paymentAuthorizationId: row.id, fullyReversed };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. payout.failed — the money left, the creator's bank bounced it
// ─────────────────────────────────────────────────────────────────────────────

export interface PayoutFailedInput {
  /** Top-level `account` on the Connect event — `acct_…`. */
  connectAccountId: string | null | undefined;
  /** data.object.failure_code, e.g. 'no_account', 'account_closed'. */
  failureCode: string | null;
  /** data.object.failure_message — Stripe's verbatim prose. */
  failureMessage: string | null;
  payoutId: string | null;
  eventId: string;
  /** The event's Stripe mode. When set (migration 064 in force), only
   *  creators whose Connect account is of that mode are touched. */
  connectAccountMode?: 'stripe_test' | 'stripe_live';
}

/**
 * The creator's bank rejected the payout. The label's money already left the
 * platform and is sitting in the creator's Stripe balance, so this deliberately
 * does NOT un-pay the deal or touch payment_authorizations — reversing a deal
 * whose money did move would be a lie. It records the fact against every deal
 * settled to that connected account and alerts, so an operator can chase the
 * creator's bank details.
 *
 * The reason is mapped through the existing src/lib/stripe-errors.ts mapper,
 * which yields operator guidance for the codes it knows and a framed,
 * verbatim-carrying sentence for the ones it does not.
 */
export async function handlePayoutFailed(
  sb: SupabaseClient,
  input: PayoutFailedInput,
  hooks: SettlementHooks
): Promise<SettlementOutcome> {
  if (!input.connectAccountId) return { handled: false, reason: 'no_account_id' };

  const mapped = mapStripeError(
    { code: input.failureCode ?? undefined, message: input.failureMessage ?? undefined },
    input.failureMessage ?? undefined
  );

  let q = sb
    .from('creator_offers')
    .select(
      `id, firm_id, campaign_id, payout_status,
       campaign_influencers!inner(
         influencer_id,
         influencer:influencers!inner(stripe_connect_account_id)
       )`
    )
    .eq('payout_status', 'paid')
    .eq('campaign_influencers.influencer.stripe_connect_account_id', input.connectAccountId);
  if (input.connectAccountMode) {
    q = q.eq('campaign_influencers.influencer.stripe_connect_account_mode', input.connectAccountMode);
  }
  const { data, error } = await q;

  if (error) return { handled: false, reason: 'lookup_failed', retryable: true };

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    firm_id: string | null;
    campaign_id: string | null;
  }>;
  if (rows.length === 0) return { handled: false, reason: 'no_matching_deals' };

  for (const r of rows) {
    await sb
      .from('creator_offers')
      .update({ payout_status: 'failed' } as never)
      .eq('id', r.id)
      .eq('payout_status', 'paid');
  }

  await hooks.audit({
    action: 'payment.failed',
    target_type: 'creator_offer',
    target_id: rows[0].id,
    firm_id: rows[0].firm_id ?? undefined,
    metadata: {
      provider: 'stripe_connect',
      stage: 'bank_payout',
      connect_account_id: input.connectAccountId,
      payout_id: input.payoutId,
      stripe_event_id: input.eventId,
      failure_code: input.failureCode,
      reason: mapped.reason,
      guidance: mapped.guidance,
      affected_creator_offer_ids: rows.map((r) => r.id),
    },
  });

  hooks.alertOnce(
    `payout_failed:${input.connectAccountId}:${input.payoutId ?? input.eventId}`,
    'error',
    'Creator bank payout failed: funds are stuck in the creator Stripe balance',
    {
      firm_id: rows[0].firm_id,
      connect_account_id: input.connectAccountId,
      failure_code: input.failureCode,
      guidance: mapped.guidance,
      affected_creator_offer_ids: rows.map((r) => r.id),
    }
  );

  return { handled: true, paymentAuthorizationId: '', fullyReversed: false };
}
