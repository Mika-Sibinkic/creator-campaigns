// src/lib/stripe-errors.ts
//
// Stripe error → operator-facing guidance.
//
// Raw Stripe prose ("Only Stripe Connect platforms can work with other
// accounts.") tells an operator nothing about what to DO, and it used to be
// passed through verbatim to the approvals inbox and the deals page. This maps
// the failures we can actually hit on the payout path onto one actionable
// sentence each, while preserving the provider's verbatim message for the audit
// trail (callers keep it in `error` / `raw_error`).
//
// Mapping precedence:
//   1. error.code   — Stripe's documented, stable identifier. Preferred always.
//   2. error.message — prose patterns, ONLY for the cases below, as a safety net
//                      for responses that omit a code.
//   3. error.type   — the coarse four-value enum; a generic sentence per type.
//   4. HTTP status  — last resort.
//
// EVERY code below was verified against Stripe's own error-code reference on
// 2026-09-15 — none are invented:
//   https://docs.stripe.com/error-codes
//   * platform_account_required        "Only Stripe Connect platforms can work
//                                       with other accounts. You can set up a
//                                       Stripe Connect platform in the Dashboard."
//   * capability_not_active            "Your account is missing the active
//                                       capabilities required to access this
//                                       endpoint. Check the capabilities array in
//                                       the error response for details…"
//   * transfers_not_allowed            "The requested transfer can't be created.
//                                       Contact us if you're receiving this error."
//   * not_allowed_on_standard_account  "Transfers and payouts on behalf of a
//                                       Standard connected account aren't allowed."
//   * balance_insufficient             "The transfer or payout couldn't be
//                                       completed because the associated account
//                                       doesn't have a sufficient balance
//                                       available…"
//   * payouts_not_allowed              "Payouts have been disabled on the
//                                       connected account. Check the connected
//                                       account's status…"
// error.type enum (api_error | card_error | idempotency_error |
// invalid_request_error) verified at https://docs.stripe.com/api/errors.
//
// NOT-ONBOARDED IS NOT AN ERROR CODE. Stripe documents no error code for
// "account hasn't finished onboarding" — per
// https://docs.stripe.com/connect/handling-api-verification the state is read
// from the Account object's `payouts_enabled` / `requirements` fields, which is
// exactly what stripe-isolated.ts does before it attempts a transfer. The
// ACCOUNT_NOT_ONBOARDED mapping below is shared by that structural check and by
// the `payouts_not_allowed` code so both produce the same operator sentence.
//
// Pure module: no env, no I/O, no secrets. Tested by tests/stripe-connect.test.ts.

/** The subset of Stripe's error object we read. */
export interface StripeApiError {
  message?: string;
  code?: string;
  type?: string;
  param?: string;
  decline_code?: string;
  doc_url?: string;
}

export interface MappedStripeError {
  /** Stable slug for branching/logging. Never Stripe prose. */
  reason: string;
  /** One operator-facing sentence: what happened and what to do next. */
  guidance: string;
  /** Stripe's error.code, echoed when present. */
  code?: string;
  /** Stripe's error.type, echoed when present. */
  type?: string;
}

type Mapping = { reason: string; guidance: string };

/** Shared by the `payouts_not_allowed` code AND by the structural
 *  `payouts_enabled === false` check in stripe-isolated.ts. */
export const ACCOUNT_NOT_ONBOARDED: Mapping = {
  reason: 'stripe_account_not_onboarded',
  guidance:
    "No money moved: the creator hasn't finished their Stripe payout onboarding, so payouts are still disabled on their account. We email them the setup link; the payment sends automatically once they complete it.",
};

/** error.code → mapping. Codes verified against docs.stripe.com/error-codes. */
const BY_CODE: Record<string, Mapping> = {
  platform_account_required: {
    reason: 'stripe_connect_not_enabled',
    guidance:
      'No money moved: Stripe Connect is not enabled on this platform account, so we cannot create or pay connected accounts. Enable Connect in the Stripe Dashboard (Connect → Get started), then retry the payout from the Deals page.',
  },
  capability_not_active: {
    reason: 'stripe_transfers_capability_inactive',
    guidance:
      "No money moved: the `transfers` capability is not active yet, so Stripe refused the payout. Check the connected account's capabilities and outstanding requirements in the Stripe Dashboard, then retry once transfers are active.",
  },
  transfers_not_allowed: {
    reason: 'stripe_transfers_not_allowed',
    guidance:
      'No money moved: Stripe refused to create this transfer. Check the platform and connected account status in the Stripe Dashboard; this one usually needs Stripe support before it will clear.',
  },
  not_allowed_on_standard_account: {
    reason: 'stripe_transfers_not_allowed_standard_account',
    guidance:
      'No money moved: this creator is on a Standard connected account, which cannot receive platform transfers. Onboard them as an Express account instead, then retry the payout.',
  },
  balance_insufficient: {
    reason: 'stripe_insufficient_platform_balance',
    guidance:
      'No money moved: the platform Stripe balance is too low to cover this payout. Top up the Stripe balance (or wait for pending funds to become available), then retry from the Deals page.',
  },
  payouts_not_allowed: ACCOUNT_NOT_ONBOARDED,
};

// ── Accounts v2 (POST /v2/core/accounts, POST /v2/core/account_links) ───────
// Codes verified 2026-10-01 against the endpoints' own error tables:
//   https://docs.stripe.com/api/v2/core/accounts/create
//   https://docs.stripe.com/api/v2/core/account-links/create
// Only the ones an operator can act on get their own sentence; the rest fall
// through to the type/status mapping with Stripe's prose kept for the audit.

/** Platform-side setup is incomplete, so Stripe will not create a creator's
 *  payout account. Shared by the readiness checklist (payments-readiness.ts). */
export const V2_ACCOUNT_CREATION_BLOCKED_REASONS = [
  'stripe_platform_not_activated',
  'stripe_connect_profile_incomplete',
  'stripe_platform_not_verified',
  'stripe_platform_responsibilities_unacknowledged',
  'stripe_platform_cannot_create_accounts',
  'stripe_accounts_v2_blocked',
  'stripe_account_configuration_rejected',
] as const;

const V2_PLATFORM_RESPONSIBILITIES: Mapping = {
  reason: 'stripe_platform_responsibilities_unacknowledged',
  guidance:
    "No money moved. Stripe will not create the creator's payout account until this platform acknowledges its Connect responsibilities (the platform pays Stripe fees and covers negative balances). Review and accept them in the Stripe Dashboard (Connect → Settings → Platform controls / loss liability), then retry the payout.",
};

const V2_ACCOUNT_CONFIGURATION: Mapping = {
  reason: 'stripe_account_configuration_rejected',
  guidance:
    "No money moved. Stripe rejected the kind of payout account this platform asks for (Express dashboard, platform pays fees and covers losses). Check the Connect settings in the Stripe Dashboard; a retry will fail the same way until that is changed.",
};

const V2_CANNOT_CREATE: Mapping = {
  reason: 'stripe_platform_cannot_create_accounts',
  guidance:
    "No money moved. Stripe says this platform account cannot create connected accounts in its current state. Contact Stripe support from the Dashboard; nothing in this app can clear it.",
};

const V2_CREATOR_EMAIL: Mapping = {
  reason: 'stripe_creator_email_invalid',
  guidance:
    "No money moved. Stripe refused the creator's email address for their payout account. Correct the creator's payout email on the deal, then retry.",
};

const BY_CODE_V2: Record<string, Mapping> = {
  account_create_activation_required: {
    reason: 'stripe_platform_not_activated',
    guidance:
      "No money moved. Stripe will not create the creator's payout account until this Stripe account is activated. Finish account activation in the Stripe Dashboard (business details and bank account), then retry the payout.",
  },
  connect_profile_not_submitted: {
    reason: 'stripe_connect_profile_incomplete',
    guidance:
      "No money moved. Stripe will not create the creator's payout account until the Connect platform profile is submitted. Complete it in the Stripe Dashboard (Connect → Get started / Platform profile), then retry.",
  },
  connect_identity_not_verified: {
    reason: 'stripe_platform_not_verified',
    guidance:
      "No money moved. Stripe has not verified this platform account yet, so it cannot create connected accounts. Finish verification in the Stripe Dashboard, then retry.",
  },
  account_creation_liability_unacknowledged: V2_PLATFORM_RESPONSIBILITIES,
  account_creation_requirement_collection_unacknowledged: V2_PLATFORM_RESPONSIBILITIES,
  account_creation_requirement_collection_and_liability_unacknowledged: V2_PLATFORM_RESPONSIBILITIES,
  account_creation_losses_collector_unavailable: V2_PLATFORM_RESPONSIBILITIES,
  cannot_create_connected_account: V2_CANNOT_CREATE,
  cannot_create_new_account_rejected: V2_CANNOT_CREATE,
  accounts_v2_access_blocked: {
    reason: 'stripe_accounts_v2_blocked',
    guidance:
      "No money moved. Stripe has not enabled Accounts v2 on this Stripe account, so the creator's payout account could not be created. Ask Stripe support to enable Accounts v2, or set STRIPE_ACCOUNTS_API=v1 in the deployment and turn on Accounts v1 support (Settings → Developers → API policies).",
  },
  // "Needs to use the newer API version or onboard to Connect" / "has not
  // signed up for Connect" — both mean Connect is not set up on the platform.
  non_connect_platform_accounts_v2_access_blocked: BY_CODE.platform_account_required,
  platform_registration_required: BY_CODE.platform_account_required,
  account_controller_express_dash_without_application_losses_or_fees: V2_ACCOUNT_CONFIGURATION,
  account_controller_stripe_pricing_platform_liable: V2_ACCOUNT_CONFIGURATION,
  account_controller_unsupported_configuration: V2_ACCOUNT_CONFIGURATION,
  account_controller_ua_unsupported_configuration: V2_ACCOUNT_CONFIGURATION,
  account_controller_unsupported_configuration_private_preview: V2_ACCOUNT_CONFIGURATION,
  email_invalid: V2_CREATOR_EMAIL,
  email_domain_invalid_for_recipient: V2_CREATOR_EMAIL,
  configs_must_match_to_use_account_links: {
    reason: 'stripe_account_link_configuration_mismatch',
    guidance:
      "No money moved. Stripe would not open onboarding for this creator's payout account because the account's configuration does not match the onboarding link. Check the connected account in the Stripe Dashboard (it should have the recipient configuration).",
  },
};

Object.assign(BY_CODE, BY_CODE_V2);

/** Where Stripe sends an account owner to turn Accounts v1 back on. */
export const ACCOUNTS_V1_SETTINGS_URL =
  'https://dashboard.stripe.com/settings/developers/api-policies/feat_accounts_v1_support';

/** Matches Stripe's refusal to create a v1 (Express) connected account. */
export const ACCOUNTS_V1_BLOCKED_PATTERN = /accounts v1|feat_accounts_v1_support/i;

/**
 * POST /v1/accounts refused because the platform's Stripe account has Accounts
 * v1 turned off for new Connect integrations. Stripe returns it as an
 * invalid_request_error whose message says
 * "Stripe no longer recommends Accounts v1 for new Connect integrations…
 * enable Accounts v1 support in the Dashboard: <ACCOUNTS_V1_SETTINGS_URL>".
 * No error code was observed, so it is matched on that prose. Without this it
 * fell through to the generic invalid_request_error sentence, which sent the
 * operator to check the deal amount.
 */
export const ACCOUNTS_V1_DISABLED: Mapping = {
  reason: 'stripe_accounts_v1_disabled',
  guidance: `No money moved. Stripe blocked creating the creator's payout account: this Stripe account needs Accounts v1 support turned on (Settings → Developers → API policies), or the deployment switched to Accounts v2 (STRIPE_ACCOUNTS_API=v2, the default). ${ACCOUNTS_V1_SETTINGS_URL}`,
};

/** Prose safety net for responses that carry no `code`. Deliberately narrow —
 *  only the failures we specifically handle. Checked AFTER error.code. */
const BY_MESSAGE: Array<{ test: RegExp; mapping: Mapping }> = [
  {
    test: ACCOUNTS_V1_BLOCKED_PATTERN,
    mapping: ACCOUNTS_V1_DISABLED,
  },
  {
    test: /only stripe connect platforms|set up a stripe connect platform/i,
    mapping: BY_CODE.platform_account_required,
  },
  {
    test: /insufficient (funds|balance)|sufficient balance available/i,
    mapping: BY_CODE.balance_insufficient,
  },
  {
    test: /capabilit(y|ies).*(transfer|not active|missing)|transfers capability/i,
    mapping: BY_CODE.capability_not_active,
  },
  {
    test: /payouts (have been|are) disabled|payouts_enabled/i,
    mapping: ACCOUNT_NOT_ONBOARDED,
  },
];

/** error.type → coarse mapping. Enum per docs.stripe.com/api/errors. */
const BY_TYPE: Record<string, Mapping> = {
  invalid_request_error: {
    reason: 'stripe_invalid_request',
    guidance:
      'No money moved: Stripe rejected the payout request as invalid. Check the deal amount and the creator record on the Deals page, then retry.',
  },
  api_error: {
    reason: 'stripe_api_error',
    guidance:
      "No money moved: Stripe hit an error on their side. This is usually transient: retry the payout from the Deals page, and check Stripe's status page if it repeats.",
  },
  idempotency_error: {
    reason: 'stripe_idempotency_error',
    guidance:
      'No money moved from this attempt: Stripe saw this idempotency key used with different parameters. Check the Stripe Dashboard for an existing transfer on this deal before retrying, so the creator is not paid twice.',
  },
  card_error: {
    reason: 'stripe_card_error',
    guidance:
      'No money moved: Stripe refused the card involved in this payout. Check the payment method in the Stripe Dashboard, then retry.',
  },
};

/** HTTP status → last-resort mapping when there is no usable code or type. */
const BY_HTTP_STATUS: Record<number, Mapping> = {
  401: {
    reason: 'stripe_auth_failed',
    guidance:
      'No money moved: Stripe rejected our API key. Check the Stripe key for the current payments mode (STRIPE_SECRET_KEY_TEST or STRIPE_SECRET_KEY_LIVE) in the deployment environment (it may have been rotated or revoked), then retry.',
  },
  403: {
    reason: 'stripe_forbidden',
    guidance:
      'No money moved: Stripe refused this request as not permitted for this account. Check the account permissions in the Stripe Dashboard.',
  },
  429: {
    reason: 'stripe_rate_limited',
    guidance:
      'No money moved: Stripe rate-limited us. Wait a minute, then retry the payout from the Deals page.',
  },
};

/**
 * Map a Stripe failure onto an operator-facing reason + guidance.
 *
 * @param err        Stripe's `error` object, when the response had one.
 * @param rawMessage The verbatim message the caller captured (kept separately).
 * @param httpStatus The response status, when known.
 */
export function mapStripeError(
  err: StripeApiError | undefined,
  rawMessage?: string,
  httpStatus?: number
): MappedStripeError {
  const code = err?.code;
  const type = err?.type;
  const echo = { ...(code ? { code } : {}), ...(type ? { type } : {}) };

  // 1. error.code — Stripe's stable identifier. Always preferred.
  if (code && BY_CODE[code]) return { ...BY_CODE[code], ...echo };

  // 2. Prose safety net for the specific failures we handle, when no code came back.
  const message = err?.message ?? rawMessage ?? '';
  if (message) {
    for (const { test, mapping } of BY_MESSAGE) {
      if (test.test(message)) return { ...mapping, ...echo };
    }
  }

  // 3. error.type — coarse but still provider-driven.
  if (type && BY_TYPE[type]) return { ...BY_TYPE[type], ...echo };

  // 4. HTTP status.
  if (httpStatus && BY_HTTP_STATUS[httpStatus]) {
    return { ...BY_HTTP_STATUS[httpStatus], ...echo };
  }

  // 5. Unmapped — still never leave the operator without a next step, and keep
  //    the raw prose visible so an unmapped failure is diagnosable.
  return {
    reason: code ? `stripe_${code}` : 'stripe_unmapped_error',
    guidance: message
      ? `No money moved: Stripe refused the payout: ${message} Retry from the Deals page once that is resolved.`
      : `No money moved: the Stripe payout failed${httpStatus ? ` (HTTP ${httpStatus})` : ''} with no further detail. Check the Stripe Dashboard, then retry from the Deals page.`,
    ...echo,
  };
}
