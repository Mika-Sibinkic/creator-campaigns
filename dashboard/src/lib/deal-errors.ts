// src/lib/deal-errors.ts
//
// One deal-row action failure → one sentence a label manager can act on.
//
// The deals page is the surface where a manager approves and pays real people,
// and it was rendering bare machine slugs at them: `over_cap`, `invalid_state`,
// `agreed_above_ceiling`. This resolves a failed action response into copy,
// WITHOUT inventing a second mapper for anything already mapped:
//
//   1. `guidance`  — already operator-facing. The Stripe mapper
//                    (src/lib/stripe-errors.ts) and the payout surfacer
//                    (src/lib/payout-surfacing.ts) to bake guidance into the
//                    response server-side. That prose always wins; this module
//                    never re-maps a Stripe failure.
//   2. `message`   — prose the route wrote itself. Two routes already ship it
//                    (`over_cap`, `creator_excluded`) and the client used to
//                    throw it away, rendering the slug instead.
//   3. DEAL_ERROR_COPY — this module, for the app's own slugs.
//   4. PAYOUT_REASON_GUIDANCE — REUSED from src/lib/payout-guidance.ts. Every
//                    early-return guard in execute-payment.ts already has a
//                    written sentence there; the approve path surfaces them and
//                    the execute path does not. Reading the same map on the
//                    client makes both buttons say the same thing about the
//                    same refusal.
//   5. Unmapped    — the raw text stays VISIBLE inside a framing sentence.
//                    Hiding an unmapped failure behind friendly copy would be
//                    worse than the slug it replaced.
//
// Pure module: no env, no I/O, no React. Tested by tests/deal-errors.test.ts.

import { PAYOUT_REASON_GUIDANCE } from './payout-guidance';

/** The fields a failed deal-action response can carry. */
export interface DealErrorPayload {
  error?: string;
  message?: string;
  guidance?: string;
}

/**
 * App-emitted slugs reachable from the deal row's nine endpoints that
 * PAYOUT_REASON_GUIDANCE does not already cover. Each one was read off the
 * route that emits it, not guessed.
 */
export const DEAL_ERROR_COPY: Record<string, string> = {
  // ── State machine ──────────────────────────────────────────────────────
  // Deliberately does not echo the raw status enum back at the user; the row
  // itself shows the real state the moment the page reloads.
  invalid_state:
    'This deal has already moved on, so that action no longer applies. Reload the page to see where it is now.',
  too_late:
    'This deal has gone too far to cancel: money has moved or the creator has already posted. Nothing changed.',
  offer_exists:
    'This creator already has a deal on this campaign, so a second one was not created. Reload the page to see it.',
  not_approved:
    'This payment is not approved yet, so nothing was paid. Approve it first, then pay.',
  // Revoke (src/lib/reject-payment.ts) arriving after the payout started.
  payout_already_started:
    'This payment has already gone out, so it can no longer be stopped. Reload the page to see where it is now.',
  payout_in_progress:
    'This payment is being sent right now, so it can no longer be stopped. Reload the page in a minute to see how it landed.',
  // The deal was re-read right before paying (src/lib/payment-claim.ts).
  offer_not_payable:
    'No money moved: this deal was closed or cancelled after the payment was approved, so it was not paid.',
  offer_check_failed:
    'No money moved: the deal could not be checked just before paying. Try again in a moment.',
  legs_exceed_agreed:
    'No money moved: paying this would take the deal past its agreed amount. Do not reject it: on the deal, use “Create balance payment” (or “Set up payment”) to replace it with one sized from what was already paid. The replacement needs a fresh approval.',
  legs_check_failed:
    'No money moved: the deal could not be read to confirm the amount. Try again in a moment.',
  // Approved in Test, paying in Live (or the reverse): payment-claim pins the
  // approval's mode. The execute route sends the exact sentence as guidance.
  mode_mismatch:
    'No money moved. This payment was approved in the other payments mode (Test or Live). Use “Set up payment” on the deal and approve it again to pay in the current mode.',
  no_deposit_paid:
    'No money moved: this deal has no deposit on record, so there is no balance to pay.',
  stripe_outcome_unknown:
    'Stripe did not confirm whether this payment went out. Do not retry it. Use “Check with Stripe” on the Needs-attention page first.',
  stripe_confirmed_not_sent:
    'Stripe confirmed nothing was sent after a connection problem. Retrying this payment is safe.',

  // ── Money guards. These are the ceilings doing their job, not faults. ───
  over_cap:
    'That amount is above the per-creator limit for this campaign, so it was not saved. Lower the amount, or raise the limit on the campaign confirm page.',
  agreed_above_ceiling:
    'The agreed amount is above this deal\'s ceiling, so no payment was set up. The ceiling is enforced on every payout. Lower the agreed amount or raise the campaign limit first.',
  no_agreed_amount:
    'This deal has no agreed amount yet, so there is nothing to pay. Lock in an amount first.',
  invalid_payout_amount:
    'The approved amount on this payment could not be read, so nothing was sent. The deal needs a fresh agreed amount before it can be paid.',
  // Not retryable from the deal row: the transfer id is on file, and a retry
  // under the same idempotency key can return the reversed transfer
  // (payment-claim.ts retryRefusal → 'transfer_on_file').
  stripe_transfer_reversed:
    'The payout was reversed at Stripe, so the creator did not keep the money. It cannot be retried from here. Check the Stripe dashboard for why before paying this creator again.',
  // execute-payment.ts refusing a Retry click; the response also carries
  // per-reason `guidance`, which wins over this line.
  retry_not_allowed:
    'No money moved from this click: this payment cannot be retried. Reload the page to see why.',
  creator_excluded:
    'This creator is excluded from outreach, so no deal was created for them.',

  // ── Missing rows ───────────────────────────────────────────────────────
  creator_offer_not_found:
    'This deal could not be found. It may have been removed in another tab. Reload the page.',
  offer_not_found:
    'This deal could not be found. It may have been removed in another tab. Reload the page.',
  payment_authorization_not_found:
    'This payment could not be found. It may have been removed in another tab. Reload the page.',
  campaign_not_found:
    'This campaign could not be found. It may have been deleted in another tab.',
  campaign_influencer_not_found:
    'This creator is no longer on this campaign. Reload the page.',
  campaign_mismatch:
    'This deal belongs to a different campaign, so nothing was changed. Reload the page.',

  // ── Auth, input, plumbing ──────────────────────────────────────────────
  unauthorized: 'Your session has expired. Sign in again, then retry.',
  // Cross-firm refusal from src/lib/firm-scope.ts. Nothing was changed: the
  // row belongs to a different workspace than the signed-in session.
  forbidden:
    'Nothing was changed. This deal belongs to a different workspace. Reload the page and sign in to the right one.',
  rate_limited:
    'Too many actions too quickly. Nothing was changed. Wait a moment and try again.',
  invalid_json:
    'That request could not be read, so nothing was changed. Reload the page and try again.',
  validation_failed:
    'Something in that form was not accepted, so nothing was saved. Check the values and try again.',
  insert_failed:
    'This could not be saved. Nothing was changed. Try again, and if it repeats send a screenshot.',
  upsert_failed:
    'This could not be saved. Nothing was changed. Try again, and if it repeats send a screenshot.',
  // Cap lookup failures from spend-caps.ts. These fail CLOSED on purpose.
  firm_monthly_cap_not_set:
    'No money moved: the monthly spend cap could not be read, so the payout was refused. Set the monthly cap in Settings, then retry.',
  creator_monthly_cap_not_set:
    'No money moved: the per-creator monthly cap could not be read, so the payout was refused. Set it in Settings, then retry.',
  campaign_budget_not_set:
    'No money moved: this campaign has no total budget set, so no payout is allowed. Set the budget on the campaign confirm page, then retry.',
  firm_not_found:
    'No money moved: your workspace could not be loaded. Reload the page and try again.',

  // ── Stored on payment_authorizations.failure_reason ────────────────────
  cancelled_by_operator: 'Cancelled here. No money moved.',
  revoked_before_payout: 'Stopped here before it was sent. No money moved.',
  'rejected by reviewer': 'Rejected here. No money moved.',
  transfer_failed:
    'No money moved: the transfer to this creator did not go through. Retry the payout, and check the payment provider if it repeats.',
};

export const GENERIC_DEAL_ERROR =
  'That did not go through. Nothing was changed. Try again, and if it repeats send a screenshot.';

/** A slug is machine-shaped: lower_snake_case, no spaces. Anything with a
 *  space is already prose (a raw Postgres message, usually) and must stay
 *  readable rather than be swapped for a generic line. */
function looksLikeSlug(value: string): boolean {
  return /^[a-z][a-z0-9_:]*$/.test(value);
}

/**
 * Render a STORED payment_authorizations.failure_reason.
 *
 * Different shape from a live response: the column holds three kinds of value
 * and each needs different treatment.
 *   * a machine slug        — execute-payment.ts, spend-caps.ts, the cancel and
 *                             reject routes → map it
 *   * already-mapped prose  — the Stripe webhook writes `payout.guidance`
 *                             straight into this column → show it as-is
 *   * an operator's own words — the reject route stores whatever the reviewer
 *                             typed → show it as-is; rewriting a human's note
 *                             would be a lie
 */
export function describeFailureReason(reason: string | null | undefined): string {
  const raw = reason?.trim();
  if (!raw) return '';
  const mapped = DEAL_ERROR_COPY[raw] ?? PAYOUT_REASON_GUIDANCE[raw];
  if (mapped) return mapped;
  // An unmapped slug is still machine-shaped; frame it. Anything else is
  // already human text (mapped guidance or a reviewer's note) — leave it alone.
  return looksLikeSlug(raw) ? `${GENERIC_DEAL_ERROR} (${raw})` : raw;
}

/**
 * Resolve one failed deal-action response into a sentence.
 *
 * @param payload    Parsed JSON body, when the response had one.
 * @param httpStatus Response status, used only for the no-body case.
 */
export function describeDealError(
  payload: DealErrorPayload | null | undefined,
  httpStatus?: number
): string {
  const guidance = payload?.guidance?.trim();
  if (guidance) return guidance;

  const message = payload?.message?.trim();
  if (message) return message;

  const code = payload?.error?.trim();
  if (code) {
    const mapped = DEAL_ERROR_COPY[code] ?? PAYOUT_REASON_GUIDANCE[code];
    if (mapped) return mapped;
    // Unmapped. Keep the original text on screen — a slug we have not written
    // copy for is still more diagnosable than a generic sentence that erases it.
    return looksLikeSlug(code)
      ? `${GENERIC_DEAL_ERROR} (${code})`
      : `That did not go through: ${code}`;
  }

  return httpStatus
    ? `${GENERIC_DEAL_ERROR} (error ${httpStatus})`
    : GENERIC_DEAL_ERROR;
}
