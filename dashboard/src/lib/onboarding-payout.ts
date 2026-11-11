// src/lib/onboarding-payout.ts
//
// Pay ONE approved authorization whose creator just finished Stripe Connect
// onboarding. Called once per matching row by the account.updated branch of
// src/app/api/webhooks/stripe/route.ts, which verifies, dedupes and looks the
// rows up; everything that decides whether money moves lives here, with every
// side effect injected, so it is testable without the route.
//
// Order is deliberate, and each step refuses rather than guesses:
//   1. CLAIM approved → executing, stamping executing_at (payment-claim.ts), so
//      a process that dies mid-transfer leaves a row payment-reclaim.ts can find.
//   2. RE-READ THE DEAL. The human approval happened when the operator clicked
//      Approve; this runs whenever the creator gets round to onboarding, which
//      can be days later. A deal cancelled, closed or marked undelivered in
//      between must not be paid. Read AFTER the claim, so a cancel racing this
//      webhook is seen.
//   3. READ THE AMOUNT, refusing null/garbage.
//   4. SPEND CAPS, same three as the execute path (spend-caps.webhookCapGate).
//   5. TRANSFER under the shared idempotency key, so a row reclaimed and retried
//      by the execute path cannot be transferred a second time.
//
// Every refusal and failure is audited — those audit rows are what the
// payment_anomaly lane in /anomalies reads (statuses.MONEY_ANOMALY_AUDIT_ACTIONS).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { StripeTransferInput, StripeTransferResult } from './stripe-isolated';
import { resolvePaymentMode } from './stripe-isolated';
import type { SpendCapsInput, WebhookCapGateHooks, WebhookCapGateResult } from './spend-caps';
import {
  readPayoutAmountUsd,
  refuseUnreadableAmount,
  type SettlementHooks,
} from './settlement-failure';
import {
  claimForExecution,
  checkOfferPayable,
  payoutIdempotencyKey,
  OFFER_NOT_PAYABLE_REASON,
  offerSettlementUpdate,
  checkLegsWithinAgreed,
  LEGS_EXCEED_AGREED_REASON,
  OUTCOME_UNKNOWN_REASON,
  writeClaimOutcome,
  COMPLETION_NOT_RECORDED_ACTION,
  refuseModeMismatch,
  type SettlementLeg,
} from './payment-claim';

/** One row the webhook found awaiting this connected account's onboarding. */
export interface AwaitingAuthorization {
  id: string;
  firm_id: string | null;
  campaign_id: string | null;
  amount_usd: number | null;
  creator_offer_id: string | null;
  /** Null only on the pre-055 fallback lookup — keyed as 'full', which is
   *  055's default. */
  leg: SettlementLeg | null;
  influencer_id: string | null;
}

export interface OnboardingPayoutDeps extends SettlementHooks {
  executePayout: (input: StripeTransferInput) => Promise<StripeTransferResult>;
  capGate: (
    sb: SupabaseClient,
    input: SpendCapsInput & { creatorOfferId?: string | null },
    hooks: WebhookCapGateHooks
  ) => Promise<WebhookCapGateResult>;
  sendPromoMaterials: (sb: SupabaseClient, opts: { creatorOfferId: string }) => Promise<unknown>;
  now?: () => Date;
  /** The rail this attempt sends on, stamped with the claim. Default: the
   *  env ceiling (resolvePaymentMode), which is the pre-064 behaviour. The
   *  webhook route passes the resolved active mode. */
  paymentMode?: () => string;
  /**
   * Migration 064 is in force: the claim is pinned to approved_mode =
   * paymentMode(), and a mismatch is refused (refuseModeMismatch). The webhook
   * route sets it from resolveActivePaymentMode().pinned.
   */
  pinMode?: boolean;
}

export type OnboardingPayoutOutcome =
  | { outcome: 'skipped_no_offer' }
  | { outcome: 'not_claimed' }
  /** Approved in another payments mode: refused, marked failed, audited. */
  | { outcome: 'mode_mismatch'; approvedMode: string | null; currentMode: string }
  | { outcome: 'offer_not_payable'; offerStatus: string | null }
  | { outcome: 'offer_check_failed' }
  | { outcome: 'legs_exceed_agreed' }
  | { outcome: 'amount_refused' }
  | { outcome: 'cap_refused' }
  /** recorded false: the transfer went out but the row write did not land. */
  | { outcome: 'paid'; providerId: string | null; recorded: boolean }
  | { outcome: 'outcome_unknown' }
  | { outcome: 'transfer_failed' };

export async function payOnboardedAuthorization(
  sb: SupabaseClient,
  r: AwaitingAuthorization,
  connectAccountId: string,
  deps: OnboardingPayoutDeps
): Promise<OnboardingPayoutOutcome> {
  if (!r.creator_offer_id) return { outcome: 'skipped_no_offer' };
  const now = deps.now ?? (() => new Date());
  const hooks: SettlementHooks = { audit: deps.audit, alertOnce: deps.alertOnce };
  const leg: SettlementLeg = r.leg ?? 'full';

  // 1. Claim. Only 'approved' — a 'failed' row is retried by a human from the
  //    deal row, never by a webhook. claimedAt identifies THIS claim for the
  //    terminal write (payment-claim.writeClaimOutcome). The payment mode is
  //    stamped WITH the claim, exactly as the execute path does: a claim that
  //    dies mid-transfer must record which rail it was sent on, because
  //    payment-reclaim.ts acts on the row's recorded mode, never the current
  //    env's. Without it the row kept the column default ('paper') or an
  //    earlier attempt's mode.
  const claimedAt = now();
  //    Mode pin (migration 064): only a row approved in the mode we pay in.
  const claimMode = (deps.paymentMode ?? resolvePaymentMode)();
  const claim = await claimForExecution(sb, r.id, ['approved'], {
    now: claimedAt,
    paymentMode: claimMode,
    ...(deps.pinMode ? { approvedMode: claimMode } : {}),
  });
  if (!claim.claimed && claim.modeMismatch) {
    await refuseModeMismatch(
      sb,
      {
        id: r.id,
        firmId: r.firm_id,
        creatorOfferId: r.creator_offer_id,
        campaignId: r.campaign_id,
        leg,
        amountUsd: r.amount_usd,
        fromStatuses: ['approved'],
        approvedMode: claim.modeMismatch.approvedMode,
        currentMode: claimMode,
        path: 'stripe_onboarding_webhook',
      },
      deps.audit
    );
    return { outcome: 'mode_mismatch', approvedMode: claim.modeMismatch.approvedMode, currentMode: claimMode };
  }
  if (!claim.claimed) return { outcome: 'not_claimed' };

  // 2. Is the deal still payable?
  const offer = await checkOfferPayable(sb, r.creator_offer_id, leg);
  if (!offer.ok) {
    if (offer.reason === 'offer_lookup_failed') {
      // Could not tell. Put it back exactly as it was so the next event (or a
      // manual execute, which runs the same check) decides — and say so.
      await sb
        .from('payment_authorizations')
        .update({ status: 'approved', failure_reason: 'offer_check_failed' } as never)
        .eq('id', r.id)
        .eq('status', 'executing');
      await deps.audit({
        action: 'payment.offer_check_failed',
        target_type: 'payment_authorization',
        target_id: r.id,
        firm_id: r.firm_id ?? undefined,
        metadata: {
          path: 'stripe_onboarding_webhook',
          creator_offer_id: r.creator_offer_id,
          campaign_id: r.campaign_id,
          leg,
          error: offer.error,
        },
      });
      return { outcome: 'offer_check_failed' };
    }
    // The deal moved on. 'failed' (not back to 'approved'): the webhook must
    // not reconsider it on every future account.updated, and execute-payment
    // re-runs this same check before any retry, so it stays unpayable while
    // the deal is. It lands in the label-visible payment_failed lane.
    await sb
      .from('payment_authorizations')
      .update({ status: 'failed', failure_reason: OFFER_NOT_PAYABLE_REASON } as never)
      .eq('id', r.id)
      .eq('status', 'executing');
    await deps.audit({
      action: 'payment.offer_not_payable',
      target_type: 'payment_authorization',
      target_id: r.id,
      firm_id: r.firm_id ?? undefined,
      metadata: {
        path: 'stripe_onboarding_webhook',
        creator_offer_id: r.creator_offer_id,
        campaign_id: r.campaign_id,
        offer_status: offer.offerStatus,
        leg,
        amount_usd: r.amount_usd,
      },
    });
    deps.alertOnce(
      `payment_block:offer_not_payable:${r.id}`,
      'warning',
      'Approved payout refused: the deal is no longer payable',
      { firm_id: r.firm_id, payment_authorization_id: r.id, offer_status: offer.offerStatus }
    );
    return { outcome: 'offer_not_payable', offerStatus: offer.offerStatus };
  }

  // 2b. Never pay past the deal's agreed amount across its legs — the same
  //     assertion execute-payment runs (payment-claim.checkLegsWithinAgreed).
  //     An unreadable deal is treated like the offer check above: put back.
  const legsCheck = await checkLegsWithinAgreed(sb, {
    id: r.id,
    creator_offer_id: r.creator_offer_id,
    amount_usd: Number(r.amount_usd),
    leg,
  });
  if (!legsCheck.ok) {
    const lookupFailed = legsCheck.reason === 'legs_lookup_failed';
    await sb
      .from('payment_authorizations')
      .update(
        (lookupFailed
          ? { status: 'approved', failure_reason: 'offer_check_failed' }
          : { status: 'failed', failure_reason: LEGS_EXCEED_AGREED_REASON }) as never
      )
      .eq('id', r.id)
      .eq('status', 'executing');
    await deps.audit({
      action: lookupFailed ? 'payment.offer_check_failed' : 'payment.legs_exceed_agreed',
      target_type: 'payment_authorization',
      target_id: r.id,
      firm_id: r.firm_id ?? undefined,
      metadata: { path: 'stripe_onboarding_webhook', creator_offer_id: r.creator_offer_id, campaign_id: r.campaign_id, leg, ...legsCheck },
    });
    if (lookupFailed) return { outcome: 'offer_check_failed' };
    deps.alertOnce(`payment_block:legs_exceed_agreed:${r.id}`, 'error', 'Payout refused: legs would exceed the agreed amount', {
      firm_id: r.firm_id,
      payment_authorization_id: r.id,
    });
    return { outcome: 'legs_exceed_agreed' };
  }

  // 3. Amount — refuse, never coerce.
  const amount = readPayoutAmountUsd(r.amount_usd);
  if (!amount.ok) {
    await refuseUnreadableAmount(
      sb,
      {
        paymentAuthorizationId: r.id,
        firmId: r.firm_id,
        campaignId: r.campaign_id,
        creatorOfferId: r.creator_offer_id,
        verdict: amount,
        rawAmount: r.amount_usd,
      },
      hooks
    );
    return { outcome: 'amount_refused' };
  }

  // 4. Spend caps. On refusal the gate reverts executing → approved, audits
  //    payment.webhook_cap_refused and alerts; we skip the transfer.
  const gate = await deps.capGate(
    sb,
    {
      paymentAuthorizationId: r.id,
      firmId: r.firm_id ?? '',
      campaignId: r.campaign_id ?? '',
      creatorInfluencerId: r.influencer_id,
      amountUsd: amount.amountUsd,
      creatorOfferId: r.creator_offer_id,
    },
    hooks
  );
  if (!gate.allowed) return { outcome: 'cap_refused' };

  // 5. Transfer.
  const payout = await deps.executePayout({
    mode: claimMode as StripeTransferInput['mode'],
    amount_usd: amount.amountUsd,
    destination_email: '',
    description: `Creator Campaigns payout — offer ${r.creator_offer_id}`,
    idempotency_key: payoutIdempotencyKey({ id: r.id, leg }),
    connect_account_id: connectAccountId,
  });
  const nowIso = now().toISOString();
  if (payout.ok && payout.settled) {
    // Compare-and-set on THIS claim (payment-claim.writeClaimOutcome); it used
    // to be `.eq('id', r.id)` with the error ignored.
    const written = await writeClaimOutcome(
      sb,
      r.id,
      { status: 'completed', payment_provider_id: payout.provider_id || null, executed_at: nowIso },
      { claimedAtIso: claimedAt.toISOString(), executingAtStamped: claim.executingAtStamped }
    );
    if (!written.recorded) {
      // Money moved and the row does not say so — /anomalies money lane.
      await deps.audit({
        action: COMPLETION_NOT_RECORDED_ACTION,
        target_type: 'payment_authorization',
        target_id: r.id,
        firm_id: r.firm_id ?? undefined,
        metadata: {
          path: 'stripe_onboarding_webhook',
          creator_offer_id: r.creator_offer_id,
          campaign_id: r.campaign_id,
          leg,
          amount_usd: amount.amountUsd,
          transfer_id: payout.provider_id || null,
          payment_mode: claimMode,
          write_error: written.error,
        },
      });
      deps.alertOnce(`payment_completion_not_recorded:${r.id}`, 'error', 'Transfer sent but not recorded on the payment row', {
        firm_id: r.firm_id,
        payment_authorization_id: r.id,
        transfer_id: payout.provider_id || null,
      });
    }
    // Leg-aware, and identical to the execute path (offerSettlementUpdate):
    // a deposit becomes 'deposit_paid' without stamping paid_at, so its
    // balance leg stays payable. Once-only per leg via that leg's own column.
    const settle = offerSettlementUpdate(leg, amount.amountUsd, nowIso);
    await sb
      .from('creator_offers')
      .update(settle.patch as never)
      .eq('id', r.creator_offer_id)
      .is(settle.onceOnlyColumn, null);
    await deps.audit({
      action: 'deal.paid',
      target_type: 'creator_offer',
      target_id: r.creator_offer_id,
      firm_id: r.firm_id ?? undefined,
      metadata: {
        provider: 'stripe_connect',
        transfer_id: payout.provider_id,
        amount_usd: amount.amountUsd,
        leg,
        binding: 'creator_onboarded_and_paid',
      },
    });
    if (settle.sendMaterials) {
      await deps.sendPromoMaterials(sb, { creatorOfferId: r.creator_offer_id });
    }
    return { outcome: 'paid', providerId: payout.provider_id || null, recorded: written.recorded };
  }

  // AMBIGUOUS outcome: the transfer may exist. Reverting to 'approved' (below)
  // is exactly what let the NEXT account.updated re-send it with no human
  // click, possibly days later and outside Stripe's idempotency window. Stay
  // 'executing' + marked; payment-reconcile.ts resolves it by asking Stripe.
  if (!payout.ok && payout.outcome_unknown) {
    await sb
      .from('payment_authorizations')
      .update({ failure_reason: OUTCOME_UNKNOWN_REASON } as never)
      .eq('id', r.id)
      .eq('status', 'executing');
    await deps.audit({
      action: 'payment.outcome_unknown',
      target_type: 'payment_authorization',
      target_id: r.id,
      firm_id: r.firm_id ?? undefined,
      metadata: {
        path: 'stripe_onboarding_webhook',
        creator_offer_id: r.creator_offer_id,
        campaign_id: r.campaign_id,
        amount_usd: amount.amountUsd,
        leg,
        error: payout.error ?? null,
        idempotency_key: payoutIdempotencyKey({ id: r.id, leg }),
      },
    });
    deps.alertOnce(`payment_outcome_unknown:${r.id}`, 'error', 'Payout outcome unknown after creator onboarding — check with Stripe', {
      firm_id: r.firm_id,
      payment_authorization_id: r.id,
    });
    return { outcome: 'outcome_unknown' };
  }

  // Transfer failed (e.g. insufficient platform balance) — revert to approved
  // so it can retry; failure_reason is human-facing, so prefer the mapped
  // guidance. This used to be a silent column write: now it is audited and
  // alerted, because an approved payout that did not go out is exactly what
  // an operator needs to see.
  await sb
    .from('payment_authorizations')
    .update({
      status: 'approved',
      failure_reason: payout.guidance ?? payout.error ?? 'transfer_failed',
    } as never)
    .eq('id', r.id);
  await deps.audit({
    action: 'payment.webhook_transfer_failed',
    target_type: 'payment_authorization',
    target_id: r.id,
    firm_id: r.firm_id ?? undefined,
    metadata: {
      creator_offer_id: r.creator_offer_id,
      campaign_id: r.campaign_id,
      amount_usd: amount.amountUsd,
      leg,
      error: payout.error ?? null,
      error_code: payout.error_code ?? null,
      reason: payout.reason ?? null,
      guidance: payout.guidance ?? null,
    },
  });
  deps.alertOnce(
    `payment_block:webhook_transfer_failed:${r.id}`,
    'error',
    'Transfer failed after creator onboarding — approved payout did not go out',
    { firm_id: r.firm_id, payment_authorization_id: r.id, reason: payout.reason ?? null }
  );
  return { outcome: 'transfer_failed' };
}
