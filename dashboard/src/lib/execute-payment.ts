// src/lib/execute-payment.ts
//
// The execute-route core, extracted so BOTH callers run the identical flow:
//   - POST /api/payments/[id]/execute  (manual retry path — unchanged behavior)
//   - POST /api/payments/[id]/approve  (auto-execute on approval: the spec's
//     "secure automatic payouts upon approval" — ONE human gate, then money
//     moves without a second click)
//
// Every guard from the route is preserved verbatim:
//   - status must be 'approved' with human_approved_at set (defense-in-depth
//     on top of the CHECK constraint)
//   - atomic claim approved|failed → executing BEFORE the cap reads (closes
//     the cap TOCTOU; 'failed' claimable so a failed dispatch can retry)
//   - the three spend caps (src/lib/spend-caps.ts) — breach marks the row
//     'failed' so it can't slip through on a retry
//   - recipient checks, Stripe Connect onboarding-email path, paper ledger,
//     deal mirroring, audit
//
// Returns { httpStatus, body } so the execute route keeps its existing contract
// (200/502 + `error` as the provider's raw prose) and the approve route can turn
// the same summary into its `payout` envelope via src/lib/payout-surfacing.ts.
//
// The body additionally carries `settled`, `reason`, `guidance`, `error_code`
// and `error_type` — additive fields, so nothing that read the old shape breaks.
// `guidance` is the operator-facing sentence; `error` stays verbatim provider
// prose for the audit trail.

import type { SupabaseClient } from '@supabase/supabase-js';
import { audit } from '@/lib/audit';
import { appBaseUrl } from '@/lib/env';
import { executePayout, isStripeMode, resolveActivePaymentMode } from '@/lib/stripe-isolated';
import { sendPromoMaterials } from '@/lib/promo-materials';
import { alertOnce } from '@/lib/sentry-alerts';
import { checkSpendCaps, CAP_FAILURE_REASON, type CapName } from '@/lib/spend-caps';
import { checkFirmScope, firmScopeErrorBody } from '@/lib/firm-scope';
import { agreementTermsSentence, contractSentAt } from '@/lib/payment-copy';
import {
  decideOnboardingEmail,
  onboardPathFor,
  PAYOUT_ONBOARDING_MESSAGE_TYPE,
  payoutOnboardingSubject,
  payoutOnboardingText,
  type OnboardingEmailDecision,
} from '@/lib/payout-email';
import {
  claimForExecution,
  checkOfferPayable,
  payoutIdempotencyKey,
  retryRefusal,
  RETRY_REFUSAL_GUIDANCE,
  offerSettlementUpdate,
  OFFER_NOT_PAYABLE_REASON,
  checkLegsWithinAgreed,
  LEGS_EXCEED_AGREED_REASON,
  OUTCOME_UNKNOWN_REASON,
  writeClaimOutcome,
  COMPLETION_NOT_RECORDED_ACTION,
  refuseModeMismatch,
} from '@/lib/payment-claim';

export interface ExecutePaymentOutcome {
  httpStatus: number;
  body: Record<string, unknown>;
}

export interface ExecutePaymentOpts {
  /**
   * Firm of the authenticated caller — REQUIRED, and fail-closed.
   *
   * This was `expectedFirmId?: string` guarded by
   * `if (opts.expectedFirmId && p.firm_id !== opts.expectedFirmId)`, which
   * skipped the comparison entirely for any falsy value. `getSession()`
   * returns firm_id '' for an authenticated-but-unprovisioned Clerk user
   * (src/lib/auth.ts:111), so '' meant "execute any firm's authorization".
   * Now mandatory in the type (tsc enforces every call site supplies it) and
   * checked via checkFirmScope, where '' is a denial rather than a wildcard.
   */
  expectedFirmId: string;
  /** Inbound request, forwarded to audit for IP/user-agent forensics. */
  req?: Request;
  /**
   * The operator clicked "Re-send payout setup email". The only caller that
   * may queue a second onboarding email for a leg, and only once the previous
   * one has gone out (payout-email.decideOnboardingEmail). Never set by the
   * approve route's auto-execute.
   */
  resendOnboardingEmail?: boolean;
}

/** Per-cap breach consequences — exactly what the execute route always did. */
const CAP_BREACH: Record<
  CapName,
  { auditAction: string; alertKey: (p: { firm_id: string; campaign_id: string; creator_offer_id: string }) => string; alertMessage: string }
> = {
  campaign: {
    auditAction: 'payment.blocked_over_budget',
    // N7: Sentry — campaign-budget block. Dedupes per firm+campaign so a
    // cron sweeper draining 20 rows against a maxed-out budget doesn't
    // create 20 issues.
    alertKey: (p) => `payment_block:over_budget:${p.firm_id}:${p.campaign_id}`,
    alertMessage: 'Payment blocked: campaign total budget exceeded',
  },
  firm_monthly: {
    auditAction: 'payment.blocked_over_firm_monthly_cap',
    alertKey: (p) => `payment_block:over_firm_monthly:${p.firm_id}`,
    alertMessage: 'Payment blocked: firm monthly cap exceeded',
  },
  creator_monthly: {
    auditAction: 'payment.blocked_over_creator_monthly_cap',
    alertKey: (p) => `payment_block:over_creator_monthly:${p.firm_id}:${p.creator_offer_id}`,
    alertMessage: 'Payment blocked: creator monthly cap exceeded',
  },
};

export async function executeAuthorizedPayment(
  sb: SupabaseClient,
  id: string,
  opts: ExecutePaymentOpts
): Promise<ExecutePaymentOutcome> {
  const { req } = opts;

  // The mode this attempt pays in, resolved ONCE: the platform setting under
  // the env ceiling (migration 064). Every stamp below and the claim's mode pin
  // use this same value, so a switch mid-request cannot split one payment
  // across two modes. `pinned` is false only pre-064.
  const active = await resolveActivePaymentMode(sb);
  const mode = active.mode;
  const pinned = active.pinned;

  // Load + verify state. The 064 columns are named only when 064 is in force:
  // naming a missing column fails the whole select.
  const load = (withLeg: boolean) =>
    sb
      .from('payment_authorizations')
      .select(
        `id, firm_id, status, creator_offer_id, campaign_id, amount_usd,${withLeg ? ' leg,' : ''}${pinned ? ' approved_mode,' : ''}
         human_approved_at, human_approved_by_user_id,
         payment_provider_id, failure_reason,
         creator_offers!inner(
           id,
           payout_email,
           contract_text,
           contract_generated_at,
           campaign_influencer_id,
           campaign_influencers!inner(
             influencer_id,
             influencer:influencers(contact_email, username, stripe_connect_account_id${pinned ? ', stripe_connect_account_mode' : ''})
           )
         )`
      )
      .eq('id', id)
      .single();
  // `leg` arrives with migration 055. On a
  // database without it, naming the column fails the whole select — and this
  // used to answer 404 for EVERY payment. Same degrade as authorize-payment.ts:
  // retry the pre-055 shape on an error; a row without a leg is a 'full' leg.
  let { data: pa, error } = await load(true);
  if (error) {
    const legacy = await load(false);
    if (!legacy.error && legacy.data) {
      console.warn(
        '[execute-payment] leg-aware select failed; fell back to the pre-055 shape. ' +
          'Apply supabase/migrations/055_settlement_authorization_legs.sql.',
        { authorization_id: id, error: error.message }
      );
      pa = legacy.data;
      error = null;
    }
  }
  if (error || !pa) {
    return { httpStatus: 404, body: { error: 'not_found' } };
  }
  const p = pa as unknown as {
    id: string;
    firm_id: string;
    status: string;
    creator_offer_id: string;
    campaign_id: string;
    amount_usd: number;
    /** Which settlement leg this row reserves. Null on rows predating 055. */
    leg: 'full' | 'deposit' | 'balance' | null;
    human_approved_at: string | null;
    human_approved_by_user_id: string | null;
    payment_provider_id: string | null;
    failure_reason: string | null;
    creator_offers: {
      id: string;
      payout_email: string | null;
      contract_text: string | null;
      contract_generated_at: string | null;
      campaign_influencer_id: string | null;
      campaign_influencers: {
        influencer_id: string;
        influencer: {
          contact_email: string | null;
          username: string;
          stripe_connect_account_id: string | null;
          /** Migration 064; absent pre-064. */
          stripe_connect_account_mode?: string | null;
        };
      };
    };
  };
  // SEC: cross-firm payout guard. Fail-closed via checkFirmScope — a blank
  // caller firm is a denial, not a bypass. See ExecutePaymentOpts above.
  const scope = checkFirmScope(opts.expectedFirmId, p.firm_id);
  if (!scope.ok) {
    return { httpStatus: scope.httpStatus, body: firmScopeErrorBody(scope) };
  }
  const creatorInfluencerId = p.creator_offers.campaign_influencers.influencer_id;

  // Retry ("Retry payment" on DealRow → POST /api/payments/[id]/execute) is a
  // 'failed' row. This used to be refused here with not_approved, which made
  // the claim's 'failed' branch below dead code. A failed row is retryable
  // only if it never transferred money and was not stopped by a human or a
  // closed deal — see retryRefusal in payment-claim.ts.
  const isRetry = p.status === 'failed';
  if (isRetry) {
    const refusal = retryRefusal(p);
    if (refusal) {
      return {
        httpStatus: 409,
        body: {
          error: 'retry_not_allowed',
          reason: refusal,
          status: p.status,
          failure_reason: p.failure_reason,
          guidance: RETRY_REFUSAL_GUIDANCE[refusal],
        },
      };
    }
  } else if (p.status !== 'approved' || !p.human_approved_at) {
    return { httpStatus: 409, body: { error: 'not_approved', status: p.status } };
  }

  // SEC (money-out concurrency): atomically claim this authorization by moving
  // approved → executing in a single compare-and-set BEFORE the spend-cap reads.
  // Because the cap checks count 'executing' as spent and exclude this row, no
  // two concurrent executes can both read $0: each thread marks-then-reads, so
  // the second read always sees the first's committed 'executing' row (the
  // read-then-read-before-either-marks interleave is impossible). This closes
  // the cap TOCTOU without a DB lock. A lost race (0 rows updated) means another
  // call already claimed this authorization → 409, no double dispatch.
  // 'failed' is also claimable: a failed dispatch (e.g. unfunded test balance,
  // provider blip) previously stranded the deal — the button needed 'approved',
  // re-authorize needed 'human_approval_required', so recovery meant SQL. The
  // human approval already happened and every cap re-runs below on each
  // attempt, so a retry from 'failed' is safe and audited.
  //
  // The retry claim is additionally compare-and-set on what was just read:
  // still no transfer id, and the same failure_reason. A row that picked up a
  // transfer id or a stop between the read and this write is not claimed.
  //
  // executing_at is stamped WITH the claim, in the same statement, because it
  // is the only way a stranded claim becomes findable. The up-to-four provider
  // calls below are not transactional: if this function dies between here and
  // the terminal write, nothing can move the row out of 'executing' — and
  // spend-caps.ts counts 'executing' as spent, so it burns campaign and
  // monthly budget permanently. claimForExecution is shared with the Stripe
  // onboarding webhook so both claims are reclaimable, and degrades pre-055.
  // The mode is stamped with the claim so a claim stranded mid-transfer records
  // which rail it was sent on (payment-reclaim.ts acts on the row's mode).
  // The claim's timestamp identifies THIS claim: the terminal write below is
  // conditioned on it, so it can never land on a row the reclaimer returned to
  // 'approved' (executing_at cleared) or that a later execute re-claimed.
  //
  // Mode pin (migration 064): the claim also requires approved_mode = the mode
  // this attempt pays in, so a payment approved in Test can never execute with
  // the Live key. A mismatch is refused, recorded and surfaced; it needs a
  // fresh approval in the current mode.
  const claimedAt = new Date();
  const fromStatuses = isRetry ? ['failed'] : ['approved'];
  const pin = pinned ? { approvedMode: mode } : {};
  const claim = isRetry
    ? await claimForExecution(sb, id, fromStatuses, {
        now: claimedAt,
        guard: { noTransfer: true, failureReason: p.failure_reason },
        paymentMode: mode,
        ...pin,
      })
    : await claimForExecution(sb, id, fromStatuses, { now: claimedAt, paymentMode: mode, ...pin });
  if (!claim.claimed && claim.modeMismatch) {
    const refused = await refuseModeMismatch(
      sb,
      {
        id: p.id,
        firmId: p.firm_id,
        creatorOfferId: p.creator_offer_id,
        campaignId: p.campaign_id,
        leg: p.leg,
        amountUsd: p.amount_usd,
        fromStatuses,
        approvedMode: claim.modeMismatch.approvedMode,
        currentMode: mode,
        path: 'execute',
      },
      (e) => audit(e, req)
    );
    return {
      httpStatus: 409,
      body: {
        error: 'mode_mismatch',
        reason: 'mode_mismatch',
        approved_mode: claim.modeMismatch.approvedMode,
        payment_mode: mode,
        guidance: refused.guidance,
      },
    };
  }
  if (!claim.claimed) {
    return { httpStatus: 409, body: { error: 'already_executing_or_not_approved' } };
  }
  if (isRetry) {
    // The click is the human action on a retry; record who clicked against
    // the approval it is riding on.
    await audit(
      {
        action: 'payment.retry_claimed',
        target_type: 'payment_authorization',
        target_id: p.id,
        firm_id: p.firm_id,
        metadata: {
          creator_offer_id: p.creator_offer_id,
          campaign_id: p.campaign_id,
          amount_usd: p.amount_usd,
          leg: p.leg ?? 'full',
          prior_failure_reason: p.failure_reason,
          original_approval: {
            human_approved_at: p.human_approved_at,
            human_approved_by_user_id: p.human_approved_by_user_id,
          },
        },
      },
      req
    );
  }

  // Re-read the deal AFTER the claim. The human approval is on this row; the
  // deal can still have been cancelled, closed or marked undelivered since
  // (a manual Execute can come long after the approval). Read after the claim
  // so a cancel racing this call is seen. Fail closed on an unreadable offer.
  const offerCheck = await checkOfferPayable(sb, p.creator_offer_id, p.leg ?? 'full');
  if (!offerCheck.ok) {
    const notPayable = offerCheck.reason === 'offer_not_payable';
    await sb
      .from('payment_authorizations')
      .update(
        (notPayable
          ? { status: 'failed', failure_reason: OFFER_NOT_PAYABLE_REASON }
          : { status: 'approved', failure_reason: 'offer_check_failed' }) as never
      )
      .eq('id', p.id)
      .eq('status', 'executing');
    await audit(
      {
        action: notPayable ? 'payment.offer_not_payable' : 'payment.offer_check_failed',
        target_type: 'payment_authorization',
        target_id: p.id,
        firm_id: p.firm_id,
        metadata: {
          path: 'execute',
          creator_offer_id: p.creator_offer_id,
          campaign_id: p.campaign_id,
          offer_status: offerCheck.offerStatus,
          leg: p.leg ?? 'full',
          amount_usd: p.amount_usd,
        },
      },
      req
    );
    return {
      httpStatus: notPayable ? 409 : 503,
      body: {
        error: notPayable ? OFFER_NOT_PAYABLE_REASON : 'offer_check_failed',
        offer_status: offerCheck.offerStatus,
      },
    };
  }

  // Never pay past the agreed amount across the deal's legs (see
  // payment-claim.checkLegsWithinAgreed). Read after the claim, like the deal
  // check above, so a sibling leg that started moving money is counted.
  const legsCheck = await checkLegsWithinAgreed(sb, p);
  if (!legsCheck.ok) {
    const lookupFailed = legsCheck.reason === 'legs_lookup_failed';
    await sb
      .from('payment_authorizations')
      .update(
        (lookupFailed
          ? { status: 'approved', failure_reason: 'legs_check_failed' }
          : { status: 'failed', failure_reason: LEGS_EXCEED_AGREED_REASON }) as never
      )
      .eq('id', p.id)
      .eq('status', 'executing');
    await audit(
      {
        action: lookupFailed ? 'payment.legs_check_failed' : 'payment.legs_exceed_agreed',
        target_type: 'payment_authorization',
        target_id: p.id,
        firm_id: p.firm_id,
        metadata: { path: 'execute', creator_offer_id: p.creator_offer_id, leg: p.leg ?? 'full', ...legsCheck },
      },
      req
    );
    if (!lookupFailed) {
      alertOnce(`payment_block:legs_exceed_agreed:${p.id}`, 'error', 'Payout refused: legs would exceed the agreed amount', {
        firm_id: p.firm_id,
        payment_authorization_id: p.id,
        ...legsCheck,
      });
    }
    return {
      httpStatus: lookupFailed ? 503 : 409,
      body: {
        error: lookupFailed ? 'legs_check_failed' : LEGS_EXCEED_AGREED_REASON,
        guidance: lookupFailed
          ? 'No money moved: the deal could not be read to confirm the amount. Try again in a moment.'
          : 'No money moved: paying this would take the deal past its agreed amount. Do not reject it: on the deal, use “Create balance payment” (or “Set up payment”) to replace it with one sized from what was already paid. The replacement needs a fresh approval.',
      },
    };
  }

  // SEC: the three spend caps (campaign total, firm monthly, per-creator
  // monthly) — see src/lib/spend-caps.ts for the exact semantics. On breach,
  // refuse to execute and mark this row failed so it can't slip through on a
  // retry.
  const capResult = await checkSpendCaps(sb, {
    paymentAuthorizationId: p.id,
    firmId: p.firm_id,
    campaignId: p.campaign_id,
    creatorInfluencerId,
    amountUsd: Number(p.amount_usd),
  });
  if (!capResult.ok && capResult.cap === 'lookup_failed') {
    // Unverifiable caps fail closed — but this used to return with the row
    // still 'executing', which stranded it (counted as spent by every cap,
    // DealRow stuck on "Payment in progress…"). Put it back to 'approved',
    // exactly as the webhook's cap gate does, and make the refusal visible.
    await sb
      .from('payment_authorizations')
      .update({ status: 'approved', failure_reason: `cap_check_failed:${capResult.detail.error}` } as never)
      .eq('id', p.id)
      .eq('status', 'executing');
    await audit(
      {
        action: 'payment.cap_check_failed',
        target_type: 'payment_authorization',
        target_id: p.id,
        firm_id: p.firm_id,
        metadata: {
          campaign_id: p.campaign_id,
          creator_offer_id: p.creator_offer_id,
          amount_usd: p.amount_usd,
          ...capResult.detail,
        },
      },
      req
    );
    return { httpStatus: capResult.detail.status, body: { error: capResult.detail.error } };
  }
  if (!capResult.ok) {
    const breach = CAP_BREACH[capResult.cap];
    await sb
      .from('payment_authorizations')
      .update({
        status: 'failed',
        failure_reason: CAP_FAILURE_REASON[capResult.cap],
      } as never)
      .eq('id', p.id);
    const auditMetadata: Record<string, unknown> = {
      campaign_id: p.campaign_id,
      creator_offer_id: p.creator_offer_id,
      ...(capResult.cap === 'creator_monthly' ? { influencer_id: creatorInfluencerId } : {}),
      ...capResult.detail,
    };
    await audit(
      {
        action: breach.auditAction,
        target_type: 'payment_authorization',
        target_id: p.id,
        firm_id: p.firm_id,
        metadata: auditMetadata,
      },
      req
    );
    alertOnce(
      breach.alertKey({ firm_id: p.firm_id, campaign_id: p.campaign_id, creator_offer_id: p.creator_offer_id }),
      'warning',
      breach.alertMessage,
      {
        firm_id: p.firm_id,
        payment_authorization_id: p.id,
        ...(capResult.cap === 'campaign' ? { campaign_id: p.campaign_id } : {}),
        ...(capResult.cap === 'creator_monthly'
          ? { creator_offer_id: p.creator_offer_id, influencer_id: creatorInfluencerId }
          : {}),
        ...capResult.detail,
      }
    );
    return {
      httpStatus: 409,
      body: { error: CAP_FAILURE_REASON[capResult.cap], ...capResult.detail },
    };
  }
  const { artistName, senderName } = capResult;

  // Prefer the creator-confirmed payout email (typo guard); fall back to the
  // address they corresponded from. For PayPal this is where the money lands.
  const recipientEmail =
    p.creator_offers.payout_email ??
    p.creator_offers.campaign_influencers.influencer.contact_email;
  if (!recipientEmail) {
    await sb
      .from('payment_authorizations')
      .update({ status: 'failed', failure_reason: 'no_creator_email' } as never)
      .eq('id', id);
    return { httpStatus: 400, body: { error: 'no_creator_email' } };
  }

  // (Already atomically marked 'executing' above, before the cap checks.)

  // Dispatch the payout. For PayPal these strings are the creator-facing
  // notification PayPal emails them. The legal-meaning sentence
  // comes from payment-copy.ts: it references the frozen contract when one
  // exists on the deal, and asserts no binding obligation when none does.
  const termsSentAt = contractSentAt(p.creator_offers);
  const payoutSubject = `You've been paid for your ${artistName} collab`;
  const payoutMessage =
    `${senderName} just sent your $${Math.round(p.amount_usd)} payment for the ${artistName} campaign. ` +
    `The promo pack (the ${artistName} track to promote) is sent to you automatically the moment you collect. ` +
    agreementTermsSentence(termsSentAt, 'the agreed deliverables');
  // The creator's Connect account, only if it belongs to the mode we pay in.
  // An acct_ created with the Test key does not exist for the Live key (and
  // vice versa), so one from the other mode is ignored and executePayout
  // creates a fresh one in this mode. A pre-064 row has no mode column; once
  // 064 is in force a NULL mode is a pre-064 account, which was Test.
  const influencer = p.creator_offers.campaign_influencers.influencer;
  const storedAcctId = influencer.stripe_connect_account_id;
  const storedAcctMode = influencer.stripe_connect_account_mode ?? 'stripe_test';
  const foreignAcct = pinned && isStripeMode(mode) && !!storedAcctId && storedAcctMode !== mode;
  const connectAcctId = foreignAcct ? null : storedAcctId;
  const appBase = appBaseUrl();
  const result = await executePayout({
    mode,
    amount_usd: p.amount_usd,
    destination_email: recipientEmail,
    description: `Creator Campaigns payout — offer ${p.creator_offer_id}`,
    // Leg-scoped, and this is not cosmetic: Stripe returns the ORIGINAL response
    // for a repeated idempotency key, so a balance transfer reusing the
    // deposit's key would silently return the deposit's transfer and the
    // creator's second half would never be sent. Built by the SAME function
    // the Stripe onboarding webhook uses — a row reclaimed from 'executing'
    // can be retried by either path, and only an identical key dedupes.
    idempotency_key: payoutIdempotencyKey({ id: p.id, leg: p.leg }),
    email_subject: payoutSubject,
    email_message: payoutMessage,
    connect_account_id: connectAcctId,
    // Names a newly created (Accounts v2) payout account in Stripe.
    account_display_name: influencer.username ?? null,
    // Creator-facing URLs must be public (creators aren't app users) and
    // self-healing: refresh bounces through the stable onboard redirect that
    // mints a fresh AccountLink; return lands on the public "all set" page.
    onboarding_return_url: `${appBase}/payout/complete`,
    onboarding_refresh_url: `${appBase}/api/payout/onboard/${id}`,
  });
  const isPaypal = result.mode === 'paypal_sandbox' || result.mode === 'paypal_live';

  // Persist a newly-created Connect account id on the influencer for reuse,
  // with the mode it belongs to once 064 is in force.
  if (result.connect_account_id && result.connect_account_id !== connectAcctId) {
    await sb
      .from('influencers')
      .update({
        stripe_connect_account_id: result.connect_account_id,
        ...(pinned && isStripeMode(mode) ? { stripe_connect_account_mode: mode } : {}),
      } as never)
      .eq('id', creatorInfluencerId);
  }

  // Stripe Connect: the creator must onboard before we can transfer. Email the
  // hosted onboarding link, revert the authorization to 'approved' (so the
  // account.updated webhook — or a re-execute — completes the transfer once
  // payouts are enabled), and mark the deal awaiting onboarding. NOT paid, NOT failed.
  //
  // At most one live onboarding email per leg. Every execute on an
  // awaiting-onboarding row lands here again (Stripe still says "not
  // onboarded"), so an unconditional insert would queue a duplicate on every
  // Retry or re-send click. The email is queued BEFORE the row is released to 'approved', so the
  // 'executing' claim serializes the check-then-insert against a concurrent
  // execute.
  let onboardingEmail: OnboardingEmailDecision | 'lookup_failed' | 'not_queued' = 'not_queued';
  if (result.ok && result.needs_onboarding) {
    const ciId = p.creator_offers.campaign_influencer_id;
    if (ciId && result.onboarding_url) {
      const { data: prior, error: priorErr } = await sb
        .from('outreach_messages')
        .select('id, status, body')
        .eq('campaign_influencer_id', ciId)
        .eq('message_type', PAYOUT_ONBOARDING_MESSAGE_TYPE);
      // Unreadable → do not queue: the operator still has the Re-send button,
      // and a second copy is exactly what this guard exists to prevent.
      onboardingEmail = priorErr
        ? 'lookup_failed'
        : decideOnboardingEmail(
            (prior ?? []) as Array<{ status: string | null; body: string | null }>,
            id,
            opts.resendOnboardingEmail === true
          );
    }
    if (onboardingEmail === 'queued' && ciId) {
      // The email carries the STABLE onboard redirect, never the raw
      // AccountLink — AccountLinks are single-use and expire within minutes,
      // and this email waits on the dispatch tick plus the creator's inbox.
      const stableOnboardUrl = `${appBase}${onboardPathFor(id)}`;
      // Plain text is the stored body; sendOutreach derives the HTML part
      // (one "Set up payout" button) from it at send time — payout-email.ts.
      await sb.from('outreach_messages').insert({
        campaign_influencer_id: ciId,
        message_type: PAYOUT_ONBOARDING_MESSAGE_TYPE,
        direction: 'outbound',
        channel: 'email',
        subject: payoutOnboardingSubject(artistName),
        body: payoutOnboardingText({
          handle: p.creator_offers.campaign_influencers.influencer.username ?? null,
          amountUsd: Math.round(p.amount_usd),
          artistName,
          onboardUrl: stableOnboardUrl,
          termsSentence: agreementTermsSentence(termsSentAt, 'the agreed deliverables'),
          signoff: senderName,
        }),
        status: 'queued',
        send_after: new Date().toISOString(),
      } as never);
    }
    await sb
      .from('payment_authorizations')
      .update({ status: 'approved', payment_mode: mode } as never)
      .eq('id', id);
    await sb
      .from('creator_offers')
      .update({ payout_status: 'awaiting_onboarding' } as never)
      .eq('id', p.creator_offer_id);
    await audit(
      {
        action: 'payment.onboarding_link_sent',
        target_type: 'payment_authorization',
        target_id: id,
        firm_id: p.firm_id,
        metadata: {
          creator_offer_id: p.creator_offer_id,
          connect_account_id: result.connect_account_id ?? connectAcctId,
          // queued | already_queued | already_sent | lookup_failed | not_queued
          onboarding_email: onboardingEmail,
          resend_requested: opts.resendOnboardingEmail === true,
          ...(foreignAcct ? { ignored_connect_account_id: storedAcctId, ignored_connect_account_mode: storedAcctMode } : {}),
        },
      },
      req
    );
    return {
      httpStatus: 200,
      body: {
        ok: true,
        needs_onboarding: true,
        status: 'awaiting_onboarding',
        settled: false,
        onboarding_email: onboardingEmail,
        reason: result.reason,
        guidance: result.guidance,
      },
    };
  }

  // AMBIGUOUS outcome (network error / timeout / 5xx / idempotency conflict on
  // the transfer): the money may have moved. This used to fall through to
  // 'failed', which Retry re-claims — and past Stripe's idempotency window a
  // re-send is a second transfer. Leave the row 'executing' (counted as spent by
  // every cap, unclaimable by Retry, the webhook and cancel), mark it, and let
  // payment-reconcile.ts ask Stripe. Compare-and-set on our own claim.
  if (!result.ok && result.outcome_unknown) {
    await sb
      .from('payment_authorizations')
      .update({ failure_reason: OUTCOME_UNKNOWN_REASON, payment_mode: mode } as never)
      .eq('id', id)
      .eq('status', 'executing');
    await audit(
      {
        action: 'payment.outcome_unknown',
        target_type: 'payment_authorization',
        target_id: id,
        firm_id: p.firm_id,
        metadata: {
          path: 'execute',
          creator_offer_id: p.creator_offer_id,
          amount_usd: p.amount_usd,
          leg: p.leg ?? 'full',
          error: result.error,
          idempotency_key: payoutIdempotencyKey({ id: p.id, leg: p.leg }),
        },
      },
      req
    );
    alertOnce(`payment_outcome_unknown:${id}`, 'error', 'Payout outcome unknown — check with Stripe before anything else', {
      firm_id: p.firm_id,
      payment_authorization_id: id,
    });
    return {
      httpStatus: 502,
      body: {
        ok: false,
        outcome_unknown: true,
        settled: false,
        payment_mode: mode,
        error: result.error,
        reason: OUTCOME_UNKNOWN_REASON,
        guidance: result.guidance,
      },
    };
  }

  const finalStatus = result.ok ? 'completed' : 'failed';
  const now = new Date().toISOString();
  // Stamp the resolved payment mode regardless of success/failure so the
  // /audit + /campaigns/[id]/deals surfaces can show what *would* have
  // happened even when the dispatch errored.
  const resolvedMode = mode;
  // failure_reason is a human-facing column (DealRow, /statuses, /anomalies all
  // render it verbatim), so store the mapped operator guidance when we have one
  // and fall back to the provider's raw prose. The stable slug and the raw
  // message both survive in the audit metadata below.
  const failureReason = result.ok ? null : (result.guidance ?? result.error ?? null);
  // Compare-and-set on THIS claim (payment-claim.writeClaimOutcome). It used to
  // be `.eq('id', id)` with the error ignored.
  const written = await writeClaimOutcome(
    sb,
    id,
    {
      status: finalStatus,
      payment_provider_id: result.provider_id || null,
      failure_reason: failureReason,
      executed_at: now,
      payment_mode: resolvedMode,
      // For PayPal the provider_id IS the payout_batch_id — keep it for
      // webhook reconciliation / status polling.
      paypal_batch_id: isPaypal && result.provider_id ? result.provider_id : null,
    },
    { claimedAtIso: claimedAt.toISOString(), executingAtStamped: claim.executingAtStamped }
  );
  // Money moved and the row does not say so. Never silent, and never a
  // "failed" the operator would retry: audit it for the /anomalies money lane
  // (with the transfer id) and alert. The deal is still mirrored below — the
  // creator WAS paid, and the deal (and the 054 budget guard) must say so.
  if (result.ok && !written.recorded) {
    await audit(
      {
        action: COMPLETION_NOT_RECORDED_ACTION,
        target_type: 'payment_authorization',
        target_id: id,
        firm_id: p.firm_id,
        metadata: {
          path: 'execute',
          creator_offer_id: p.creator_offer_id,
          campaign_id: p.campaign_id,
          leg: p.leg ?? 'full',
          amount_usd: p.amount_usd,
          transfer_id: result.provider_id || null,
          payment_mode: resolvedMode,
          write_error: written.error,
        },
      },
      req
    );
    alertOnce(`payment_completion_not_recorded:${id}`, 'error', 'Transfer sent but not recorded on the payment row', {
      firm_id: p.firm_id,
      payment_authorization_id: id,
      transfer_id: result.provider_id || null,
    });
  } else if (!written.recorded) {
    console.warn('[execute-payment] failed-attempt write did not land on this claim', { authorization_id: id, error: written.error });
  }

  // Paper-mode ledger insert. Idempotent via UNIQUE (idempotency_key) so a
  // retried execute on the same payment_authorization id is a no-op rather
  // than a duplicate row. We deliberately do NOT abort the response if the
  // ledger insert fails — the canonical state lives in payment_authorizations,
  // and the ledger is a convenience surface.
  if (result.ok && resolvedMode === 'paper') {
    const { error: ledgerErr } = await sb
      .from('paper_money_ledger')
      .insert({
        payment_authorization_id: id,
        amount_usd: p.amount_usd,
        recipient_email: recipientEmail,
        idempotency_key: id,
      } as never);
    if (ledgerErr) {
      // 23505 = unique_violation (retry, expected). Log everything else.
      if (!ledgerErr.message.includes('duplicate key')) {
        console.warn('[payments.execute] paper_money_ledger insert failed', ledgerErr.message);
      }
    }
  }

  // Mirror settlement to the deal.
  const leg: 'full' | 'deposit' | 'balance' =
    (p.leg as 'full' | 'deposit' | 'balance' | null) ?? 'full';
  if (result.ok && result.settled) {
    // Instant settlement (paper / stripe): the deal is paid now, so flip it and
    // fire the promo-materials automation (idempotent).
    //
    // Which status depends on the leg, and the paid_at rule is load-bearing:
    // webhooks/stripe and webhooks/paypal both use `paid_at IS NULL` as their
    // once-only gate, so the DEPOSIT must not stamp it or the balance leg's
    // webhook would be treated as already handled.
    // The per-leg patch (deposit_paid / balance_paid / paid) and the promo
    // rule live in offerSettlementUpdate, shared with the onboarding webhook.
    const settle = offerSettlementUpdate(leg, p.amount_usd, now);
    await sb
      .from('creator_offers')
      .update(settle.patch as never)
      .eq('id', p.creator_offer_id);
    if (settle.sendMaterials) {
      await sendPromoMaterials(sb, { creatorOfferId: p.creator_offer_id });
    }
  } else if (result.ok && !result.settled) {
    // Deferred settlement (PayPal): the payout is dispatched but the creator
    // hasn't claimed yet. Do NOT mark paid and do NOT send materials — that
    // happens in /api/webhooks/paypal on PAYMENT.PAYOUTS-ITEM.SUCCEEDED.
    await sb
      .from('creator_offers')
      .update({ payout_status: 'pending' } as never)
      .eq('id', p.creator_offer_id);
  }

  await audit(
    {
      action: result.ok ? 'payment.executed' : 'payment.failed',
      target_type: 'payment_authorization',
      target_id: id,
      firm_id: p.firm_id,
      metadata: {
        creator_offer_id: p.creator_offer_id,
        amount_usd: p.amount_usd,
        provider_id: result.provider_id,
        payment_mode: resolvedMode,
        dry_run: result.dry_run,
        // The provider's verbatim prose — preserved for the audit trail even
        // though the operator is shown the mapped guidance instead.
        error: result.error,
        error_code: result.error_code,
        error_type: result.error_type,
        reason: result.reason,
      },
    },
    req
  );

  return {
    httpStatus: result.ok ? 200 : 502,
    body: {
      ok: result.ok,
      provider_id: result.provider_id,
      dry_run: result.dry_run,
      payment_mode: resolvedMode,
      settled: result.settled,
      // `error` stays the raw provider prose (unchanged contract). The mapped
      // fields are additive and are what the UI actually renders.
      error: result.error,
      error_code: result.error_code,
      error_type: result.error_type,
      reason: result.reason,
      guidance: result.guidance,
      // Sent but not recorded: still ok (money moved — a "failed" here would
      // invite a retry), flagged so the UI says so instead of a clean "Paid".
      ...(result.ok && !written.recorded
        ? {
            recorded: false,
            reason: 'transfer_not_recorded',
            guidance: `The money was sent (transfer ${result.provider_id || 'id unavailable'}), but the payment record could not be updated. Do not retry: it is flagged on Anomalies for a manual check.`,
          }
        : {}),
    },
  };
}
