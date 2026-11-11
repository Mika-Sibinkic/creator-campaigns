// src/lib/stripe-isolated.ts
//
// SECURITY-OK: stripe-secret-isolation — this is the ONLY module in the
// codebase allowed to read a Stripe secret: STRIPE_SECRET_KEY_TEST,
// STRIPE_SECRET_KEY_LIVE, the legacy STRIPE_SECRET_KEY, and the webhook
// signing secrets (STRIPE_WEBHOOK_SECRETS_TEST / _LIVE, legacy
// STRIPE_WEBHOOK_SECRET). tests/secret-isolation.test.ts and the smoke test
// (section 13a) refuse a read anywhere else. Audit metadata + log lines NEVER
// include a key; callers only ever see presence / prefix-kind booleans.
//
// ACCOUNTS v2 (2026-10-01): creator payout accounts are created, read and
// onboarded through Stripe Accounts v2 unless STRIPE_ACCOUNTS_API(_TEST|_LIVE)
// =v1; see "Connected accounts" below STRIPE_API_VERSION. Thin v2 events are
// resolved here too (resolveThinAccountEvent), since that needs the key.
//
// TEST/LIVE SWITCH (migration 064):
//   * keyFor(mode) picks the key for one Stripe mode: the explicit
//     STRIPE_SECRET_KEY_TEST / _LIVE, else the legacy STRIPE_SECRET_KEY when
//     its prefix matches the mode. Secret (sk_) and restricted (rk_) keys are
//     both accepted; the prefix must match the mode or the key is refused.
//   * resolvePaymentMode() is the ENV CEILING, exactly the pre-064 resolution.
//   * resolveActivePaymentMode(sb) is what money paths use: the single
//     platform_payment_settings row picks stripe_test / stripe_live, never
//     above the ceiling (live only when PAYMENTS_MODE=stripe_live). With no
//     settings row (pre-064) it IS resolvePaymentMode(), unpinned.
//
// Pay out a creator after human approval has been recorded on the
// payment_authorizations row. Called only from /api/payments/[id]/execute,
// which itself is only reachable when status='approved' AND
// human_approved_at IS NOT NULL (DB-level CHECK constraint, migration 009).
//
// PAYMENTS_MODE dispatch (migration 015 + 030):
//   * paper           — skip all providers. Stamp provider_id='paper_<idem>'.
//                       No money moves. Settles instantly; /api/payments/[id]/execute
//                       writes a paper_money_ledger row + sends materials.
//   * stripe_test     — the SAME Connect code path as stripe_live, against a
//                       TEST key: creates real Express accounts and real test
//                       Transfers. NOT a stub — there is no customers.create
//                       call anywhere in this repo, and an earlier version of
//                       this comment claiming one is what made stripe_test read
//                       as inert. Only the key prefix differs from live.
//                       Requires an sk_test_ key or it falls back to paper.
//   * stripe_live     — LIVE key path: Transfers to acct_*. Real money. (Legacy;
//                       superseded by paypal_* as the creator rail — needs Connect.)
//   * paypal_sandbox  — PayPal Payouts SANDBOX: real API, sandbox money, pays a
//                       creator by EMAIL. Settlement is DEFERRED to the webhook.
//   * paypal_live     — PayPal Payouts LIVE: real money to a creator's email.
// The creator rail is PayPal Payouts. PayPal modes require
// PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET; if absent we fall back to 'paper'.
// If a provider's secret is unset, resolvePaymentMode falls back to 'paper'
// regardless of the requested mode and warns — an operator can leave
// PAYMENTS_MODE blank for safety and the system quietly stays in paper mode.

import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createPaypalPayout, paypalConfigured } from './paypal-isolated';
import { createLogger } from './logger';
import { appBaseUrl } from './env';

const log = createLogger('stripe-isolated');
import { ACCOUNT_NOT_ONBOARDED, mapStripeError, type StripeApiError } from './stripe-errors';
import { OUTCOME_UNKNOWN_REASON } from './payment-claim';

export type PaymentMode = 'paper' | 'stripe_test' | 'stripe_live' | 'paypal_sandbox' | 'paypal_live';

/** The two Stripe environments the platform can switch between. */
export type StripeMode = 'stripe_test' | 'stripe_live';

export function isStripeMode(m: unknown): m is StripeMode {
  return m === 'stripe_test' || m === 'stripe_live';
}

/** Accepted key prefixes per mode: full secret keys and restricted keys. */
export const STRIPE_KEY_PREFIXES: Record<StripeMode, readonly string[]> = {
  stripe_test: ['sk_test_', 'rk_test_'],
  stripe_live: ['sk_live_', 'rk_live_'],
};

/** Does this key's prefix belong to this mode? A live key never passes as test. */
export function stripeKeyMatchesMode(mode: StripeMode, key: string): boolean {
  return STRIPE_KEY_PREFIXES[mode].some((p) => key.startsWith(p));
}

function envTrim(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t.length > 0 ? t : null;
}

/** The explicit per-mode key, if one is set (any prefix). */
function explicitKey(mode: StripeMode): string | null {
  return envTrim(mode === 'stripe_live' ? process.env.STRIPE_SECRET_KEY_LIVE : process.env.STRIPE_SECRET_KEY_TEST);
}

/**
 * The Stripe key for ONE mode, or null. Module-private: no caller outside this
 * file ever holds a key value.
 *
 * The explicit STRIPE_SECRET_KEY_TEST / _LIVE wins. A wrong-kind explicit key
 * (an sk_live_ in _TEST) is refused outright, never papered over with the
 * legacy key. Without an explicit key, the legacy STRIPE_SECRET_KEY serves the
 * mode its prefix belongs to, which is how a pre-064 deployment keeps working
 * with no env change.
 */
function keyFor(mode: StripeMode): string | null {
  const explicit = explicitKey(mode);
  if (explicit) return stripeKeyMatchesMode(mode, explicit) ? explicit : null;
  const legacy = envTrim(process.env.STRIPE_SECRET_KEY);
  if (legacy && stripeKeyMatchesMode(mode, legacy)) return legacy;
  return null;
}

/** Presence and kind of the key for one mode, for the readiness checklist and
 *  the Settings card. Never the value. */
export interface StripeKeyStatus {
  /** Some key material is configured for this mode (explicit, or a legacy key). */
  present: boolean;
  /** A usable key for this mode exists (prefix matches the mode). */
  usable: boolean;
  source: 'explicit' | 'legacy' | null;
  kind: 'secret' | 'restricted' | null;
}

export function stripeKeyStatus(mode: StripeMode): StripeKeyStatus {
  const explicit = explicitKey(mode);
  const key = keyFor(mode);
  const source: StripeKeyStatus['source'] = key ? (explicit ? 'explicit' : 'legacy') : null;
  return {
    present: explicit != null || key != null,
    usable: key != null,
    source,
    kind: key ? (key.startsWith('rk_') ? 'restricted' : 'secret') : null,
  };
}

/**
 * The Stripe API version every raw call in this module pins itself to.
 *
 * Without this header a request floats on whatever version the *account* is
 * pinned to in the Stripe Dashboard — so the same code can behave differently
 * on two deployments, and a Stripe-side account upgrade can change payout
 * behavior with no deploy. Pinning here makes the contract a property of the
 * code, upgraded deliberately.
 *
 * Value verified 2026-09-15 first-hand at https://docs.stripe.com/api/versioning:
 *   "The current version is 2026-08-26.dahlia."
 *   "…unless you override it by setting the `Stripe-Version` header."
 * Corroborated by the top entry of https://docs.stripe.com/changelog.
 * `dahlia` is the major-release train name; monthly releases within a train are
 * backward-compatible. Bump only alongside a read of the changelog diff.
 */
export const STRIPE_API_VERSION = '2026-08-26.dahlia';

// ── Connected accounts: Accounts v2 (default) or v1 ──────────────────────────
// Stripe refuses POST /v1/accounts (express) on a
// platform without the "Accounts v1 support" API-policy toggle ("Stripe no
// longer recommends Accounts v1 for new Connect integrations…"). Creator payout
// accounts are therefore created through Accounts v2 by default:
//   create      POST /v2/core/accounts (recipient config, stripe_transfers)
//   onboarding  POST /v2/core/account_links (use_case account_onboarding)
//   readiness   GET  /v2/core/accounts/{id}?include[0]=configuration.recipient
//               → configuration.recipient.capabilities.stripe_balance
//                 .stripe_transfers.status === 'active'
//   transfer    POST /v1/transfers destination=acct_… (unchanged for v2)
// Sources (fetched 2026-10-01): docs.stripe.com/connect/marketplace/tasks/create,
// /api/v2/core/accounts/create, /api/v2/core/account-links/create,
// /api-v2-overview (JSON bodies, mandatory Stripe-Version, include[n] syntax).
//
// Accounts created with v1 before this change need no migration: "You can use
// the Accounts v2 API with your existing v1 Accounts without making any
// changes to them" (docs.stripe.com/connect/accounts-v2/migrate-integration).
// So v2 mode reads EVERY acct_ through v2. If an account's v2 view carries no
// recipient configuration (not expected for a v1 Express account with the
// transfers capability, but not documented either way) it falls back to the v1
// read + v1 account link for that account only.
//
// STRIPE_ACCOUNTS_API=v1 restores the pre-v2 path wholesale (v1 create, v1
// readiness on payouts_enabled, v1 account links) for a Stripe account that
// still has Accounts v1 support on. Per-mode overrides STRIPE_ACCOUNTS_API_TEST
// / _LIVE win over the shared value, since the Dev (test) account and the
// label's live account are configured independently.

/** The Stripe-Version every /v2 call sends. /v2 requires the header
 *  (docs.stripe.com/api-v2-overview). The marketplace guide shows `.preview`;
 *  the API reference shows `2026-09-30.endive` for the same endpoints. Bump
 *  only alongside a read of the changelog. */
export const STRIPE_V2_API_VERSION = '2026-09-30.preview';

export type ConnectAccountsApi = 'v1' | 'v2';

/** Which Accounts API creates and reads creator payout accounts in one mode.
 *  Anything other than an explicit 'v1' is v2. */
export function connectAccountsApi(mode: StripeMode): ConnectAccountsApi {
  const perMode = envTrim(mode === 'stripe_live' ? process.env.STRIPE_ACCOUNTS_API_LIVE : process.env.STRIPE_ACCOUNTS_API_TEST);
  const raw = (perMode ?? envTrim(process.env.STRIPE_ACCOUNTS_API) ?? '').toLowerCase();
  return raw === 'v1' ? 'v1' : 'v2';
}

/** Auth + pinned-version headers for every raw Stripe call. `key` is passed in
 *  by the caller — these helpers never read STRIPE_SECRET_KEY themselves. */
function stripeHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    'Stripe-Version': STRIPE_API_VERSION,
    ...extra,
  };
}

/** A raw Stripe failure, carried structurally so callers can branch on
 *  error.code / error.type instead of regexing prose. */
export interface StripeCallFailure {
  ok: false;
  /** Stripe's verbatim `error.message` (or `HTTP <status>` if absent). */
  error: string;
  stripe?: StripeApiError;
  http_status?: number;
  /**
   * True when the call may have taken effect at Stripe even though we did not
   * get a success back: a thrown fetch (network, TLS, timeout, unreadable
   * body), any 5xx, a 409, or an idempotency_error. Only set by the TRANSFER
   * call — every earlier call moves no money, so its failure is definite.
   */
  outcome_unknown?: boolean;
}

/** Guidance for an ambiguous transfer outcome. Never "retry". */
const OUTCOME_UNKNOWN_GUIDANCE =
  'We could not confirm whether this payment reached the creator. Do not retry it. Use “Check with Stripe” on the Needs-attention page; it resolves the payment to sent or not sent.';

/**
 * Was this transfer failure AMBIGUOUS — could the transfer exist anyway?
 *   thrown fetch          the request may have reached Stripe and been applied
 *   5xx                   Stripe's own docs: the result is indeterminate
 *   409                   a request with this idempotency key is in flight
 *   idempotency_error     this key was used before — a transfer may exist
 * Everything else (4xx card/balance/auth/validation, 429 rate limit) means
 * Stripe refused the request and nothing was created.
 */
function transferOutcomeUnknown(status: number | undefined, err: StripeApiError | undefined): boolean {
  if (status === undefined) return true;
  if (status >= 500) return true;
  if (status === 409) return true;
  if (err?.type === 'idempotency_error') return true;
  return false;
}

/** Normalize a non-2xx Stripe response body into a StripeCallFailure. */
function stripeFailure(status: number, json: { error?: StripeApiError }): StripeCallFailure {
  const err = json?.error;
  return {
    ok: false,
    error: err?.message ?? `HTTP ${status}`,
    ...(err ? { stripe: err } : {}),
    http_status: status,
  };
}

/** Build the uniform StripeTransferResult failure shape. Every Stripe failure
 *  return in executePayout goes through here so they can't drift apart —
 *  the account-creation branch used to drop connect_account_id while its three
 *  siblings kept it. */
function failedTransferResult(
  mode: PaymentMode,
  failure: StripeCallFailure,
  connectAccountId: string | null | undefined
): StripeTransferResult {
  const mapped = mapStripeError(failure.stripe, failure.error, failure.http_status);
  return {
    ok: false,
    provider_id: '',
    dry_run: false,
    raw_status: failure.outcome_unknown ? 'outcome_unknown' : 'failed',
    settled: false,
    mode,
    error: failure.error,
    error_code: mapped.code,
    error_type: mapped.type,
    // An ambiguous outcome overrides the mapping: whatever the prose says, the
    // one true statement is "we do not know", and the one wrong action is retry.
    reason: failure.outcome_unknown ? OUTCOME_UNKNOWN_REASON : mapped.reason,
    guidance: failure.outcome_unknown ? OUTCOME_UNKNOWN_GUIDANCE : mapped.guidance,
    ...(failure.outcome_unknown ? { outcome_unknown: true } : {}),
    connect_account_id: connectAccountId ?? undefined,
  };
}

/** Resolve one Stripe mode against its key: the mode itself, or 'paper' (with
 *  a warning) when no usable key exists for it. */
function stripeModeOrPaper(mode: StripeMode): PaymentMode {
  if (keyFor(mode)) return mode;
  const status = stripeKeyStatus(mode);
  const prefixes = STRIPE_KEY_PREFIXES[mode].join(' or ');
  const envName = mode === 'stripe_live' ? 'STRIPE_SECRET_KEY_LIVE' : 'STRIPE_SECRET_KEY_TEST';
  // Structural sandbox enforcement, both directions: a live key in test mode
  // could move real money, and a test key in live mode would run the live rail
  // silently in test (the UI says live, no money reaches a creator). Either is
  // a config error, so fail to paper where it is visible.
  log.warn(
    status.present
      ? `falling back to PAPER mode — ${mode} requires a ${prefixes} key`
      : `falling back to PAPER mode — no Stripe key is set for ${mode}`,
    { payments_mode: mode, fix: `set ${envName} (${prefixes}) in Vercel env` }
  );
  return 'paper';
}

/**
 * The ENV CEILING: PAYMENTS_MODE resolved against the configured keys, with
 * safety fallbacks. This is exactly the pre-064 resolution.
 *   - Unknown / unset values  → 'paper'.
 *   - 'stripe_test' / 'stripe_live' with no usable key for that mode → 'paper'
 *     plus a warning so the gap is visible in logs.
 *
 * Money paths must NOT use this directly once migration 064 is applied: the
 * platform setting can hold the deployment in Test below a live ceiling. They
 * call resolveActivePaymentMode(sb). This stays for display and for gates
 * where the ceiling is the conservative answer (the reply simulator refuses
 * whenever live is even possible).
 */
export function resolvePaymentMode(): PaymentMode {
  const raw = (process.env.PAYMENTS_MODE ?? '').toLowerCase().trim();
  if (raw === 'stripe_test' || raw === 'stripe_live') {
    return stripeModeOrPaper(raw);
  }
  // PayPal Payouts — the creator-settlement rail. Both modes need REST app
  // credentials; without them, fall back to paper (never guess a live rail).
  if (raw === 'paypal_sandbox' || raw === 'paypal_live') {
    const haveCreds = paypalConfigured();
    if (!haveCreds) {
      log.warn('falling back to PAPER mode — PayPal credentials are unset', {
        payments_mode: raw,
        fix: 'set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET',
      });
      return 'paper';
    }
    return raw;
  }
  return 'paper';
}

/**
 * The mode the environment is CONFIGURED for (PAYMENTS_MODE as written), before
 * resolvePaymentMode's safety fallbacks. The two differ exactly when a Stripe or
 * PayPal mode is configured but its credentials are missing or mismatched — and
 * then the resolved 'paper' says nothing about where an earlier payment went.
 */
export function configuredPaymentMode(): string {
  const raw = (process.env.PAYMENTS_MODE ?? '').toLowerCase().trim();
  return raw || 'paper';
}

/** Does the env ceiling allow live Stripe at all? */
export function liveAllowedByCeiling(): boolean {
  return configuredPaymentMode() === 'stripe_live';
}

// ── Platform setting (migration 064) ─────────────────────────────────────────

/** The single platform_payment_settings row as read. */
export interface PlatformPaymentSetting {
  /** absent = pre-064 (table missing) or no row; error = unreadable. */
  state: 'present' | 'absent' | 'error';
  stripe_mode: StripeMode | null;
  switched_by: string | null;
  switched_at: string | null;
  error?: string;
}

/** PostgREST / Postgres "this relation does not exist" — the pre-064 shape. */
function isMissingRelation(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === 'PGRST205' || err.code === '42P01') return true;
  return /does not exist|could not find the table|schema cache/i.test(err.message ?? '');
}

export async function readPlatformPaymentSetting(sb: SupabaseClient): Promise<PlatformPaymentSetting> {
  try {
    const { data, error } = await sb
      .from('platform_payment_settings')
      .select('stripe_mode, switched_by, switched_at')
      .eq('id', true)
      .maybeSingle();
    if (error) {
      if (isMissingRelation(error)) return { state: 'absent', stripe_mode: null, switched_by: null, switched_at: null };
      return { state: 'error', stripe_mode: null, switched_by: null, switched_at: null, error: error.message };
    }
    const row = data as { stripe_mode?: unknown; switched_by?: string | null; switched_at?: string | null } | null;
    if (!row) return { state: 'absent', stripe_mode: null, switched_by: null, switched_at: null };
    return {
      state: 'present',
      // An unrecognised value is read as Test: the safe floor.
      stripe_mode: isStripeMode(row.stripe_mode) ? row.stripe_mode : 'stripe_test',
      switched_by: row.switched_by ?? null,
      switched_at: row.switched_at ?? null,
    };
  } catch (e) {
    return { state: 'error', stripe_mode: null, switched_by: null, switched_at: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ActivePaymentMode {
  /** The mode money moves in right now. */
  mode: PaymentMode;
  /** PAYMENTS_MODE as configured (the ceiling), before key fallbacks. */
  ceiling: string;
  /**
   * True once migration 064 is in force: approvals record approved_mode, every
   * claim is conditioned on it, and Connect accounts carry their mode. False
   * only when the settings row does not exist (pre-064), which keeps the
   * pre-064 behaviour exactly.
   */
  pinned: boolean;
  setting: PlatformPaymentSetting;
}

/**
 * Combine the env ceiling with the platform setting. Pure (env aside), so the
 * table of cases is testable without a database.
 *
 *   setting absent           → resolvePaymentMode(), unpinned (pre-064).
 *   ceiling paper / paypal   → resolvePaymentMode(); the setting only picks
 *                              between the two Stripe modes.
 *   ceiling stripe_*         → setting stripe_live AND ceiling stripe_live →
 *                              stripe_live; anything else → stripe_test.
 *                              An unreadable setting is read as Test.
 *   no usable key for it     → 'paper', as the ceiling does.
 */
export function combinePaymentMode(setting: PlatformPaymentSetting): ActivePaymentMode {
  const ceiling = configuredPaymentMode();
  if (setting.state === 'absent') {
    return { mode: resolvePaymentMode(), ceiling, pinned: false, setting };
  }
  if (ceiling !== 'stripe_test' && ceiling !== 'stripe_live') {
    return { mode: resolvePaymentMode(), ceiling, pinned: true, setting };
  }
  const want: StripeMode =
    setting.state === 'present' && setting.stripe_mode === 'stripe_live' && ceiling === 'stripe_live'
      ? 'stripe_live'
      : 'stripe_test';
  return { mode: stripeModeOrPaper(want), ceiling, pinned: true, setting };
}

/** The mode money paths pay in. See combinePaymentMode for the rules. */
export async function resolveActivePaymentMode(sb: SupabaseClient): Promise<ActivePaymentMode> {
  const setting = await readPlatformPaymentSetting(sb);
  if (setting.state === 'error') {
    log.warn('platform_payment_settings unreadable; holding payments in Test', { error: setting.error });
  }
  return combinePaymentMode(setting);
}

/** True for any mode whose settlement completes asynchronously via a provider
 *  webhook rather than at dispatch time. PayPal payouts land PENDING/UNCLAIMED
 *  and only become "paid" when the creator claims (PAYMENT.PAYOUTS-ITEM.SUCCEEDED). */
export function isDeferredSettlement(mode: PaymentMode): boolean {
  return mode === 'paypal_sandbox' || mode === 'paypal_live';
}

export interface StripeTransferInput {
  amount_usd: number;
  destination_email: string;       // creator's confirmed payout email (PayPal) / contact_email
  description: string;             // e.g. "Creator Campaigns payout — offer <uuid>"
  idempotency_key: string;         // payment_authorizations.id ensures we never double-pay
  // Optional copy for the provider's creator-facing payment notification (PayPal).
  email_subject?: string;
  email_message?: string;
  // Stripe Connect: the creator's existing connected-account id (acct_*), if any.
  // When absent, executePayout creates one. Onboarding URLs are where Stripe sends
  // the creator back after the hosted onboarding flow.
  connect_account_id?: string | null;
  /** Shown on a newly created v2 account (Stripe Dashboard, Express). Optional. */
  account_display_name?: string | null;
  onboarding_return_url?: string;
  onboarding_refresh_url?: string;
  /**
   * The mode to pay in, as resolved by the caller (resolveActivePaymentMode) and
   * pinned on the claim. Every production caller passes it
   * (tests/payments-mode-switch.test.ts pins that); omitted, it falls back to
   * the env ceiling, which is the pre-064 behaviour.
   */
  mode?: PaymentMode;
}

export interface StripeTransferResult {
  ok: boolean;
  provider_id: string;             // tr_ (stripe transfer), paper_ (paper), payout_batch_id (paypal)
  dry_run: boolean;                // legacy field — kept true for paper, false otherwise
  raw_status: string;              // 'paid' | 'pending' | 'awaiting_onboarding' | 'unclaimed' | 'failed' | 'dry_run'
  settled: boolean;                // true = money is final now; false = deferred to a webhook
  mode: PaymentMode;
  /** The provider's VERBATIM prose. Preserved for the audit trail; never the
   *  only thing an operator is shown. */
  error?: string;
  /** Stripe's `error.code`, when the provider supplied one. */
  error_code?: string;
  /** Stripe's `error.type`, when the provider supplied one. */
  error_type?: string;
  /** Stable slug for branching/logging, e.g. 'stripe_connect_not_enabled'. */
  reason?: string;
  /** One operator-facing sentence: what happened and what to do next. */
  guidance?: string;
  // Stripe Connect: set when the creator must onboard before we can transfer.
  needs_onboarding?: boolean;
  onboarding_url?: string;         // hosted Stripe onboarding link to email the creator
  connect_account_id?: string;     // the created/used acct_* so the caller can persist it
  /**
   * The transfer MAY exist (see transferOutcomeUnknown). Callers must not treat
   * this as a failure: leave the row 'executing', mark it OUTCOME_UNKNOWN_REASON
   * and resolve it through payment-reconcile.ts. Only ever set with ok=false.
   */
  outcome_unknown?: boolean;
}

/**
 * Hits Stripe Transfers / Customers (or short-circuits to paper-mode).
 * The function is intentionally a thin shim — we don't import the
 * `stripe` npm package here so a misuse can't easily slip past the
 * smoke-test grep gate. fetch() with bearer auth is enough for what
 * we need.
 */
export async function executePayout(
  input: StripeTransferInput
): Promise<StripeTransferResult> {
  const mode = input.mode ?? resolvePaymentMode();

  // ── Paper mode — no Stripe API call. ──────────────────────────────────
  // Generate a stable, non-Stripe-looking provider_id so anything reading
  // the row downstream can tell at a glance this was paper.
  if (mode === 'paper') {
    const providerId = `paper_${input.idempotency_key.slice(0, 12)}`;
    log.warn('PAPER mode — no Stripe call', {
      provider_id: providerId,
      amount_usd: input.amount_usd,
    });
    return {
      ok: true,
      provider_id: providerId,
      dry_run: false,
      raw_status: 'paid',
      settled: true,
      mode,
    };
  }

  // ── PayPal Payouts — the creator rail. ────────────────────────────────────
  // Delegates to paypal-isolated (the only module that reads PAYPAL_CLIENT_SECRET,
  // preserving secret isolation). A fresh payout is PENDING/UNCLAIMED — NOT
  // settled — so settled=false; the deal only flips to paid when the creator
  // claims (PAYMENT.PAYOUTS-ITEM.SUCCEEDED → /api/webhooks/paypal).
  if (mode === 'paypal_sandbox' || mode === 'paypal_live') {
    const result = await createPaypalPayout({
      sandbox: mode === 'paypal_sandbox',
      amount_usd: input.amount_usd,
      receiver_email: input.destination_email,
      note: input.description,
      email_subject: input.email_subject ?? 'You have a payment from your campaign',
      email_message: input.email_message ?? input.description,
      idempotency_key: input.idempotency_key,
    });
    if (!result.ok) {
      return {
        ok: false,
        provider_id: '',
        dry_run: false,
        raw_status: 'failed',
        settled: false,
        mode,
        error: result.error,
      };
    }
    return {
      ok: true,
      provider_id: result.batch_id ?? '',
      dry_run: false,
      raw_status: 'pending',
      settled: false, // deferred to the PayPal webhook
      mode,
    };
  }

  // From here we MUST have the key for THIS mode (resolution guarantees it for
  // a resolved stripe_* mode; a caller-passed mode is re-checked here). A key
  // of the other mode is never substituted: keyFor refuses a wrong prefix.
  const key = keyFor(mode);
  if (!key) {
    return {
      ok: false,
      provider_id: '',
      dry_run: false,
      raw_status: 'failed',
      settled: false,
      mode,
      error: 'stripe_secret_key_missing',
      reason: 'stripe_secret_key_missing',
      guidance:
        mode === 'stripe_live'
          ? 'No money moved. The live Stripe key is not configured on this deployment. Set STRIPE_SECRET_KEY_LIVE in the environment, then retry the payout.'
          : 'No money moved. The test Stripe key is not configured on this deployment. Set STRIPE_SECRET_KEY_TEST in the environment, then retry the payout.',
    };
  }

  try {
    // ── Stripe Connect Express payout (stripe_test / stripe_live) ──
    // Pay the creator via a connected account. First time: create the account +
    // return a hosted onboarding link for the caller to email; once the account's
    // payouts are enabled, transfer the funds. Same API in test/live — the
    // sk_test_ vs sk_live_ key decides which environment.
    // v2 by default; v1 only when STRIPE_ACCOUNTS_API(_TEST|_LIVE)=v1. See
    // the "Connected accounts" block at the top of this file.
    const api = connectAccountsApi(mode as StripeMode);
    let acctId = input.connect_account_id ?? null;
    if (!acctId) {
      const created =
        api === 'v2'
          ? await stripeV2CreateRecipientAccount(key, {
              email: input.destination_email,
              displayName: input.account_display_name ?? null,
              // v2 replays a request with the same key for 30 days and returns
              // the SAME account, so a crash between create and persist does
              // not mint a second account for this payout.
              idempotencyKey: `${input.idempotency_key}.account`,
            })
          : await stripeCreateConnectAccount(key, input.destination_email);
      if (!created.ok) {
        // Same shape as the three sibling failures below (this branch used to
        // drop connect_account_id and the structured error entirely). acctId is
        // null here by definition — we only create when there isn't one — but
        // the field is carried explicitly so every failure return is uniform.
        return failedTransferResult(mode, created, acctId);
      }
      acctId = created.account_id;
    }

    const status = await connectAccountReadiness(key, api, acctId);
    if (!status.ok) {
      return failedTransferResult(mode, status, acctId);
    }
    if (!status.ready) {
      const base = appBaseUrl();
      const link = await createOnboardingLink(
        key,
        status.via,
        acctId,
        input.onboarding_refresh_url ?? `${base}/settings`,
        input.onboarding_return_url ?? `${base}/settings`,
      );
      if (!link.ok) {
        return failedTransferResult(mode, link, acctId);
      }
      // Not settled — the creator must onboard first. The caller emails the link;
      // the account.updated webhook triggers the transfer once payouts are enabled.
      // Stripe documents NO error code for this state (it is read off the Account
      // object's payouts_enabled field), so the reason/guidance come from the
      // shared ACCOUNT_NOT_ONBOARDED mapping — the same sentence the
      // `payouts_not_allowed` error code produces.
      return {
        ok: true, provider_id: '', dry_run: false, raw_status: 'awaiting_onboarding', settled: false, mode,
        needs_onboarding: true, onboarding_url: link.url, connect_account_id: acctId,
        reason: ACCOUNT_NOT_ONBOARDED.reason, guidance: ACCOUNT_NOT_ONBOARDED.guidance,
      };
    }

    // Onboarded → transfer the funds to the creator's connected account.
    const tr = await stripeTransfer(key, acctId, input.amount_usd, input.idempotency_key, input.description);
    if (!tr.ok) {
      return failedTransferResult(mode, tr, acctId);
    }
    return { ok: true, provider_id: tr.transfer_id ?? '', dry_run: false, raw_status: 'paid', settled: true, mode, connect_account_id: acctId };
  } catch (e) {
    return failedTransferResult(
      mode,
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      input.connect_account_id
    );
  }
}

/**
 * Mint a fresh onboarding AccountLink for an existing Connect account.
 * AccountLinks are single-use and expire minutes after creation, so an email
 * must never carry one — emails carry the stable /api/payout/onboard/<pa_id>
 * redirect, which calls this at click time. Also reports payouts_enabled so
 * the caller can short-circuit an already-onboarded account.
 *
 * `mode` is the mode the account belongs to (the payment row's approved mode):
 * a test acct_ is only ever touched with the test key and vice versa.
 */
export async function mintOnboardingLink(
  accountId: string,
  refreshUrl: string,
  returnUrl: string,
  mode: PaymentMode,
): Promise<
  | { ok: true; payouts_enabled: true }
  | { ok: true; payouts_enabled: false; url: string }
  | { ok: false; error: string }
> {
  if (mode !== 'stripe_test' && mode !== 'stripe_live') {
    return { ok: false, error: `stripe_not_active (mode=${mode})` };
  }
  const key = keyFor(mode);
  if (!key) return { ok: false, error: `stripe_key_missing (mode=${mode})` };
  // `payouts_enabled` keeps its name for callers; it means "ready to receive a
  // transfer" — v1 payouts_enabled, or v2 stripe_transfers active.
  const status = await connectAccountReadiness(key, connectAccountsApi(mode), accountId);
  if (!status.ok) return { ok: false, error: status.error };
  if (status.ready) return { ok: true, payouts_enabled: true };
  const link = await createOnboardingLink(key, status.via, accountId, refreshUrl, returnUrl);
  if (!link.ok) return { ok: false, error: link.error };
  return { ok: true, payouts_enabled: false, url: link.url };
}

// ── Accounts v2 helpers ─────────────────────────────────────────────────────
// JSON bodies, a mandatory Stripe-Version, Idempotency-Key on POST
// (docs.stripe.com/api-v2-overview). `key` is passed in; nothing here reads env.

function stripeV2Headers(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    'Stripe-Version': STRIPE_V2_API_VERSION,
    ...extra,
  };
}

/** The include list every v2 account read asks for. /v2 GETs need the indexed
 *  form `include[0]=…` even for one value (docs.stripe.com/api-v2-overview). */
const V2_ACCOUNT_INCLUDE_QS = 'include[0]=configuration.recipient&include[1]=requirements';

/** The exact JSON body POST /v2/core/accounts receives for a creator. Exported
 *  so the test pins it. Express requires both collectors = application
 *  (error account_controller_express_dash_without_application_losses_or_fees). */
export function v2RecipientAccountBody(email: string, displayName: string | null): Record<string, unknown> {
  return {
    contact_email: email,
    ...(displayName ? { display_name: displayName } : {}),
    dashboard: 'express',
    defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
    identity: { country: 'us' },
    configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
    include: ['configuration.recipient', 'identity', 'requirements'],
  };
}

async function stripeV2CreateRecipientAccount(
  key: string,
  opts: { email: string; displayName: string | null; idempotencyKey: string },
): Promise<{ ok: true; account_id: string } | StripeCallFailure> {
  try {
    const res = await fetch('https://api.stripe.com/v2/core/accounts', {
      method: 'POST',
      headers: stripeV2Headers(key, { 'Content-Type': 'application/json', 'Idempotency-Key': opts.idempotencyKey }),
      body: JSON.stringify(v2RecipientAccountBody(opts.email, opts.displayName)),
    });
    const json = (await res.json()) as { id?: string; error?: StripeApiError };
    if (!res.ok || !json.id) return stripeFailure(res.status, json);
    return { ok: true, account_id: json.id };
  } catch (e) {
    return networkFailure(e);
  }
}

/** Readiness as parsed from one v2 Account object. */
export interface V2AccountReadiness {
  /** The account has a recipient configuration at all. */
  has_recipient: boolean;
  /** configuration.recipient.capabilities.stripe_balance.stripe_transfers.status */
  transfers_status: string | null;
  /** configuration.recipient.capabilities.stripe_balance.payouts.status (informational) */
  payouts_status: string | null;
  /** A transfer to this account can be made now. */
  ready: boolean;
}

/** Pure: read transfer readiness off a v2 Account (fetched with
 *  include[0]=configuration.recipient). Only `active` is ready; pending,
 *  restricted and unsupported are not. */
export function parseV2AccountReadiness(account: unknown): V2AccountReadiness {
  const a = (account ?? {}) as {
    configuration?: {
      recipient?: {
        capabilities?: {
          stripe_balance?: { stripe_transfers?: { status?: unknown } | null; payouts?: { status?: unknown } | null } | null;
        } | null;
      } | null;
    } | null;
  };
  const recipient = a.configuration?.recipient;
  if (!recipient || typeof recipient !== 'object') {
    return { has_recipient: false, transfers_status: null, payouts_status: null, ready: false };
  }
  const bal = recipient.capabilities?.stripe_balance;
  const transfers = typeof bal?.stripe_transfers?.status === 'string' ? (bal.stripe_transfers.status as string) : null;
  const payouts = typeof bal?.payouts?.status === 'string' ? (bal.payouts.status as string) : null;
  return { has_recipient: true, transfers_status: transfers, payouts_status: payouts, ready: transfers === 'active' };
}

async function stripeV2GetAccount(
  key: string,
  accountId: string,
): Promise<({ ok: true; account: unknown }) | StripeCallFailure> {
  try {
    const res = await fetch(
      `https://api.stripe.com/v2/core/accounts/${encodeURIComponent(accountId)}?${V2_ACCOUNT_INCLUDE_QS}`,
      { method: 'GET', headers: stripeV2Headers(key) },
    );
    const json = (await res.json()) as { error?: StripeApiError };
    if (!res.ok) return stripeFailure(res.status, json);
    return { ok: true, account: json };
  } catch (e) {
    return networkFailure(e);
  }
}

async function stripeV2CreateAccountLink(
  key: string,
  accountId: string,
  refreshUrl: string,
  returnUrl: string,
): Promise<{ ok: true; url: string } | StripeCallFailure> {
  try {
    const res = await fetch('https://api.stripe.com/v2/core/account_links', {
      method: 'POST',
      // An AccountLink is single-use and short-lived, and each click of the
      // stable onboard redirect must mint a fresh one, so the key is unique
      // per call (v2 would otherwise replay the first, possibly expired, link).
      headers: stripeV2Headers(key, { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }),
      body: JSON.stringify({
        account: accountId,
        use_case: {
          type: 'account_onboarding',
          account_onboarding: {
            refresh_url: refreshUrl,
            return_url: returnUrl,
            collection_options: { fields: 'eventually_due' },
          },
        },
      }),
    });
    const json = (await res.json()) as { url?: string; error?: StripeApiError };
    if (!res.ok || !json.url) return stripeFailure(res.status, json);
    return { ok: true, url: json.url };
  } catch (e) {
    return networkFailure(e);
  }
}

/** Ready-to-receive-a-transfer, through whichever API owns the read. */
interface ConnectReadiness {
  ok: true;
  ready: boolean;
  /** Which API answered — the onboarding link is minted through the same one. */
  via: ConnectAccountsApi;
  transfers_status: string | null;
  payouts_status: string | null;
}

async function connectAccountReadiness(
  key: string,
  api: ConnectAccountsApi,
  accountId: string,
): Promise<ConnectReadiness | StripeCallFailure> {
  if (api === 'v2') {
    const got = await stripeV2GetAccount(key, accountId);
    if (!got.ok) return got;
    const r = parseV2AccountReadiness(got.account);
    if (r.has_recipient) {
      return { ok: true, ready: r.ready, via: 'v2', transfers_status: r.transfers_status, payouts_status: r.payouts_status };
    }
    log.warn('v2 account has no recipient configuration; reading it through v1', { account_id: accountId });
  }
  const v1 = await stripeGetAccountStatus(key, accountId);
  if (!v1.ok) return v1;
  return { ok: true, ready: v1.payouts_enabled, via: 'v1', transfers_status: null, payouts_status: null };
}

function createOnboardingLink(
  key: string,
  via: ConnectAccountsApi,
  accountId: string,
  refreshUrl: string,
  returnUrl: string,
): Promise<{ ok: true; url: string } | StripeCallFailure> {
  return via === 'v2'
    ? stripeV2CreateAccountLink(key, accountId, refreshUrl, returnUrl)
    : stripeCreateAccountLink(key, accountId, refreshUrl, returnUrl);
}

// ── Thin events (v2 event destinations) ─────────────────────────────────────
// A thin event carries no object snapshot: { id, object: "v2.core.event", type,
// livemode, created, context, reason, related_object: { id, type, url } }
// (docs.stripe.com/event-destinations, example payload). The receiver verifies
// the Stripe-Signature, then fetches the current state from the API. Only the
// account events that can mean "this creator can now be paid" are handled.

export const CONNECT_THIN_EVENT_TYPES = [
  'v2.core.account[configuration.recipient].capability_status_updated',
  'v2.core.account[requirements].updated',
  'v2.core.account_link.returned',
] as const;

export interface StripeThinEvent {
  id?: string;
  object?: string;
  type?: string;
  livemode?: boolean;
  context?: string | null;
  related_object?: { id?: string; type?: string; url?: string } | null;
}

export function isThinEvent(e: unknown): e is StripeThinEvent {
  return !!e && typeof e === 'object' && (e as { object?: unknown }).object === 'v2.core.event';
}

export function isConnectThinEventType(type: unknown): boolean {
  return typeof type === 'string' && (CONNECT_THIN_EVENT_TYPES as readonly string[]).includes(type);
}

const ACCT_ID = /^acct_[A-Za-z0-9]+$/;

export type ThinAccountResolution =
  | {
      ok: true;
      /** Null when the event names no account (nothing to do). */
      account_id: string | null;
      ready: boolean;
      transfers_status: string | null;
      payouts_status: string | null;
    }
  | StripeCallFailure;

/**
 * Resolve a verified Connect thin event to "which account, and can it be paid
 * now", by fetching the related object in the event's own mode.
 *
 *   related_object.type v2.core.account → GET related_object.url, which must
 *     be exactly /v2/core/accounts/<that id> (a URL from a signed payload is
 *     still never followed anywhere else), with include[0]=configuration.recipient
 *     so the capability is present.
 *   no related account (v2.core.account_link.returned) → GET
 *     /v2/core/events/<id> and read data.account_id, then the account.
 *
 * Events with a non-null `context` belong to a connected account's own
 * scope, not the platform's recipients; they are acknowledged and ignored.
 * A failed fetch is a failure (the route answers 5xx so Stripe redelivers),
 * never "not ready".
 */
export async function resolveThinAccountEvent(mode: StripeMode, event: StripeThinEvent): Promise<ThinAccountResolution> {
  const none: ThinAccountResolution = { ok: true, account_id: null, ready: false, transfers_status: null, payouts_status: null };
  if (event.context) return none;
  const key = keyFor(mode);
  if (!key) return noKeyFailure(mode);

  let acctId: string | null = null;
  const rel = event.related_object;
  if (rel && rel.type === 'v2.core.account' && typeof rel.id === 'string') {
    if (!ACCT_ID.test(rel.id)) return { ok: false, error: 'related_object.id is not an account id' };
    if (rel.url != null && rel.url !== `/v2/core/accounts/${rel.id}`) {
      return { ok: false, error: 'related_object.url does not match the account it names' };
    }
    acctId = rel.id;
  } else if (typeof event.id === 'string') {
    try {
      const res = await fetch(`https://api.stripe.com/v2/core/events/${encodeURIComponent(event.id)}`, {
        method: 'GET',
        headers: stripeV2Headers(key),
      });
      const json = (await res.json()) as { data?: { account_id?: unknown } | null; error?: StripeApiError };
      if (!res.ok) return stripeFailure(res.status, json);
      const fromData = json.data?.account_id;
      if (typeof fromData === 'string' && ACCT_ID.test(fromData)) acctId = fromData;
    } catch (e) {
      return networkFailure(e);
    }
  }
  if (!acctId) return none;

  const got = await stripeV2GetAccount(key, acctId);
  if (!got.ok) return got;
  const r = parseV2AccountReadiness(got.account);
  return { ok: true, account_id: acctId, ready: r.ready, transfers_status: r.transfers_status, payouts_status: r.payouts_status };
}

// ── Stripe Connect Express helpers ─────────────────────────────────────────
// fetch()-only (no stripe npm package) to preserve the secret-isolation gate.
// `key` is passed in by executePayout (already the isolated reader); these
// helpers never read STRIPE_SECRET_KEY independently.

/** Exception (DNS, TLS, timeout) → the same failure shape, minus a Stripe body. */
function networkFailure(e: unknown): StripeCallFailure {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

async function stripeCreateConnectAccount(
  key: string,
  email: string,
): Promise<{ ok: true; account_id: string } | StripeCallFailure> {
  const body = new URLSearchParams({
    type: 'express',
    email,
    'capabilities[transfers][requested]': 'true',
  });
  try {
    const res = await fetch('https://api.stripe.com/v1/accounts', {
      method: 'POST',
      headers: stripeHeaders(key, { 'content-type': FORM_CONTENT_TYPE }),
      body,
    });
    const json = (await res.json()) as { id?: string; error?: StripeApiError };
    if (!res.ok || !json.id) return stripeFailure(res.status, json);
    return { ok: true, account_id: json.id };
  } catch (e) {
    return networkFailure(e);
  }
}

async function stripeGetAccountStatus(
  key: string,
  accountId: string,
): Promise<{ ok: true; payouts_enabled: boolean } | StripeCallFailure> {
  try {
    const res = await fetch(`https://api.stripe.com/v1/accounts/${encodeURIComponent(accountId)}`, {
      method: 'GET',
      headers: stripeHeaders(key),
    });
    const json = (await res.json()) as { payouts_enabled?: boolean; error?: StripeApiError };
    if (!res.ok) return stripeFailure(res.status, json);
    return { ok: true, payouts_enabled: json.payouts_enabled === true };
  } catch (e) {
    return networkFailure(e);
  }
}

async function stripeCreateAccountLink(
  key: string,
  accountId: string,
  refreshUrl: string,
  returnUrl: string,
): Promise<{ ok: true; url: string } | StripeCallFailure> {
  const body = new URLSearchParams({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
  try {
    const res = await fetch('https://api.stripe.com/v1/account_links', {
      method: 'POST',
      headers: stripeHeaders(key, { 'content-type': FORM_CONTENT_TYPE }),
      body,
    });
    const json = (await res.json()) as { url?: string; error?: StripeApiError };
    if (!res.ok || !json.url) return stripeFailure(res.status, json);
    return { ok: true, url: json.url };
  } catch (e) {
    return networkFailure(e);
  }
}

async function stripeTransfer(
  key: string,
  destinationAccountId: string,
  amountUsd: number,
  idempotencyKey: string,
  description: string,
): Promise<{ ok: true; transfer_id?: string } | StripeCallFailure> {
  const body = new URLSearchParams({
    amount: String(Math.round(amountUsd * 100)),
    currency: 'usd',
    destination: destinationAccountId,
    description,
    // Deterministic, = the payout idempotency key (<pa id>.<leg>). This is what
    // makes an ambiguous outcome resolvable: lookupTransfersByGroup finds the
    // transfer (or proves there is none) without depending on Stripe's 24h
    // idempotency-key retention. Also mirrored into metadata for the dashboard.
    transfer_group: idempotencyKey,
    'metadata[payout_key]': idempotencyKey,
  });
  try {
    const res = await fetch('https://api.stripe.com/v1/transfers', {
      method: 'POST',
      headers: stripeHeaders(key, {
        'Idempotency-Key': `${idempotencyKey}.transfer`,
        'content-type': FORM_CONTENT_TYPE,
      }),
      body,
    });
    let json: { id?: string; error?: StripeApiError } = {};
    try {
      json = (await res.json()) as typeof json;
    } catch {
      // An unreadable body: on a 2xx the transfer exists and we lost its id;
      // on a 5xx it is indeterminate. Either way — not a clean answer.
      return { ok: false, error: `HTTP ${res.status} (unreadable body)`, http_status: res.status, outcome_unknown: true };
    }
    if (!res.ok) {
      const f = stripeFailure(res.status, json);
      return transferOutcomeUnknown(res.status, json?.error) ? { ...f, outcome_unknown: true } : f;
    }
    if (!json.id) {
      return { ok: false, error: 'transfer response carried no id', http_status: res.status, outcome_unknown: true };
    }
    return { ok: true, transfer_id: json.id };
  } catch (e) {
    return { ...networkFailure(e), outcome_unknown: true };
  }
}

/** One transfer as reconciliation needs it. Amounts in minor units (cents). */
export interface FoundTransfer {
  id: string;
  amount_minor: number;
  amount_reversed_minor: number;
  reversed: boolean;
  destination: string | null;
}

export type TransferLookupResult =
  | { ok: true; transfers: FoundTransfer[] }
  | { ok: false; error: string; not_stripe?: boolean };

/**
 * Every transfer Stripe holds for one transfer_group (GET /v1/transfers
 * ?transfer_group=…, documented filter — docs.stripe.com/api/transfers/list,
 * checked 2026-09-30). Read-only. Used ONLY by payment-reconcile.ts to resolve
 * an ambiguous payout.
 *
 * A failed lookup is `ok: false`, NEVER an empty list: "Stripe has no transfer"
 * lets a human re-send, so it may only come from a successful read. Non-Stripe
 * modes refuse with not_stripe (nothing to ask).
 *
 * `mode` is the mode to ask in (the caller's resolved active mode); omitted,
 * the env ceiling, which is the pre-064 behaviour.
 */
export async function lookupTransfersByGroup(transferGroup: string, modeIn?: PaymentMode): Promise<TransferLookupResult> {
  const mode = modeIn ?? resolvePaymentMode();
  if (mode !== 'stripe_test' && mode !== 'stripe_live') {
    return { ok: false, error: `stripe_not_active (mode=${mode})`, not_stripe: true };
  }
  const key = keyFor(mode);
  if (!key) return { ok: false, error: `stripe_key_missing (mode=${mode})` };
  const qs = new URLSearchParams({ transfer_group: transferGroup, limit: '100' });
  try {
    const res = await fetch(`https://api.stripe.com/v1/transfers?${qs.toString()}`, {
      method: 'GET',
      headers: stripeHeaders(key),
    });
    const json = (await res.json()) as {
      data?: { id?: string; amount?: number; amount_reversed?: number; reversed?: boolean; destination?: string | null }[];
      has_more?: boolean;
      error?: StripeApiError;
    };
    if (!res.ok) return { ok: false, error: stripeFailure(res.status, json).error };
    if (!Array.isArray(json.data)) return { ok: false, error: 'transfer list carried no data' };
    if (json.has_more) return { ok: false, error: 'more than 100 transfers in one group — resolve by hand' };
    return {
      ok: true,
      transfers: json.data
        .filter((t) => typeof t.id === 'string')
        .map((t) => ({
          id: t.id as string,
          amount_minor: Number(t.amount ?? 0),
          amount_reversed_minor: Number(t.amount_reversed ?? 0),
          reversed: t.reversed === true,
          destination: t.destination ?? null,
        })),
    };
  } catch (e) {
    return { ok: false, error: networkFailure(e).error };
  }
}

// ── Readiness probes (Settings → Payments, POST /api/payments/mode) ─────────
// Read-only GETs against one mode's key. Each returns a StripeCallFailure on
// any failure, with reason 'stripe_key_missing' when no usable key exists.

function noKeyFailure(mode: StripeMode): StripeCallFailure {
  return { ok: false, error: `stripe_key_missing (mode=${mode})`, stripe: { code: 'stripe_key_missing' } };
}

async function stripeGet<T>(mode: StripeMode, path: string): Promise<({ ok: true } & T) | StripeCallFailure> {
  const key = keyFor(mode);
  if (!key) return noKeyFailure(mode);
  try {
    const res = await fetch(`https://api.stripe.com${path}`, { method: 'GET', headers: stripeHeaders(key) });
    const json = (await res.json()) as T & { error?: StripeApiError };
    if (!res.ok) return stripeFailure(res.status, json);
    return { ok: true, ...json };
  } catch (e) {
    return networkFailure(e);
  }
}

/** Read-only GET against a /v2 path in one mode (v2 headers). */
async function stripeV2List(mode: StripeMode, path: string): Promise<{ ok: true } | StripeCallFailure> {
  const key = keyFor(mode);
  if (!key) return noKeyFailure(mode);
  try {
    const res = await fetch(`https://api.stripe.com${path}`, { method: 'GET', headers: stripeV2Headers(key) });
    const json = (await res.json()) as { error?: StripeApiError };
    if (!res.ok) return stripeFailure(res.status, json);
    return { ok: true };
  } catch (e) {
    return networkFailure(e);
  }
}

export interface StripeAccountSummary {
  ok: true;
  id: string;
  display_name: string | null;
}

/** GET /v1/account: which Stripe account this key belongs to. */
export async function probeStripeAccount(mode: StripeMode): Promise<StripeAccountSummary | StripeCallFailure> {
  const r = await stripeGet<{
    id?: string;
    email?: string | null;
    business_profile?: { name?: string | null } | null;
    settings?: { dashboard?: { display_name?: string | null } | null } | null;
  }>(mode, '/v1/account');
  if (!r.ok) return r;
  if (!r.id) return { ok: false, error: 'account response carried no id' };
  return {
    ok: true,
    id: r.id,
    display_name: r.settings?.dashboard?.display_name ?? r.business_profile?.name ?? r.email ?? null,
  };
}

export interface StripeBalanceSummary {
  ok: true;
  available_usd: number;
  pending_usd: number;
  livemode: boolean | null;
}

/** GET /v1/balance: the platform's USD balance (minor units summed, as dollars). */
export async function probeStripeBalance(mode: StripeMode): Promise<StripeBalanceSummary | StripeCallFailure> {
  const r = await stripeGet<{
    available?: { amount?: number; currency?: string }[];
    pending?: { amount?: number; currency?: string }[];
    livemode?: boolean;
  }>(mode, '/v1/balance');
  if (!r.ok) return r;
  const usd = (list: { amount?: number; currency?: string }[] | undefined) =>
    (list ?? []).filter((b) => b.currency === 'usd').reduce((s, b) => s + Number(b.amount ?? 0), 0) / 100;
  return {
    ok: true,
    available_usd: usd(r.available),
    pending_usd: usd(r.pending),
    livemode: typeof r.livemode === 'boolean' ? r.livemode : null,
  };
}

/**
 * Is Connect enabled on this platform? A one-item account list succeeds only
 * for a Connect platform; otherwise Stripe answers platform_account_required
 * (v1) or non_connect_platform_accounts_v2_access_blocked /
 * platform_registration_required (v2), all mapped to stripe_connect_not_enabled.
 * Asked through the same Accounts API the payout path uses, so a platform with
 * Accounts v1 off is not reported as unready for a v1-only reason.
 */
export async function probeStripeConnect(
  mode: StripeMode
): Promise<{ ok: true } | (StripeCallFailure & { reason: string; guidance: string })> {
  const r =
    connectAccountsApi(mode) === 'v2'
      ? await stripeV2List(mode, '/v2/core/accounts?limit=1')
      : await stripeGet<{ data?: unknown[] }>(mode, '/v1/accounts?limit=1');
  if (r.ok) return { ok: true };
  const mapped = mapStripeError(r.stripe, r.error, r.http_status);
  return { ...r, reason: mapped.reason, guidance: mapped.guidance };
}

export interface StripeWebhookEndpointSummary {
  id: string;
  url: string;
  status: string;
  enabled_events: string[];
}

/** GET /v1/webhook_endpoints: the endpoints registered on this account. */
export async function listStripeWebhookEndpoints(
  mode: StripeMode
): Promise<{ ok: true; endpoints: StripeWebhookEndpointSummary[] } | StripeCallFailure> {
  const r = await stripeGet<{ data?: { id?: string; url?: string; status?: string; enabled_events?: string[] }[] }>(
    mode,
    '/v1/webhook_endpoints?limit=100'
  );
  if (!r.ok) return r;
  return {
    ok: true,
    endpoints: (r.data ?? [])
      .filter((e) => typeof e.id === 'string' && typeof e.url === 'string')
      .map((e) => ({
        id: e.id as string,
        url: e.url as string,
        status: e.status ?? 'unknown',
        enabled_events: Array.isArray(e.enabled_events) ? e.enabled_events : [],
      })),
  };
}

// ── Webhook signature verification ───────────────────────────────────────────
// The webhook signing secrets are Stripe secrets too, so they are read here and
// nowhere else. One endpoint serves both modes: the secret that verifies the
// signature decides the mode, and the route requires event.livemode to agree.

const WEBHOOK_TOLERANCE_SEC = 5 * 60;

function parseSecretList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Signing secrets per mode. The legacy single STRIPE_WEBHOOK_SECRET counts as Test. */
function webhookSecretsFor(mode: StripeMode): string[] {
  if (mode === 'stripe_live') return parseSecretList(process.env.STRIPE_WEBHOOK_SECRETS_LIVE);
  const list = parseSecretList(process.env.STRIPE_WEBHOOK_SECRETS_TEST);
  const legacy = envTrim(process.env.STRIPE_WEBHOOK_SECRET);
  if (legacy && !list.includes(legacy)) list.push(legacy);
  return list;
}

/** How many signing secrets are configured for a mode, and whether every one
 *  looks like a Stripe signing secret (whsec_). Never the values. */
export function stripeWebhookSecretStatus(mode: StripeMode): { count: number; all_whsec: boolean } {
  const list = webhookSecretsFor(mode);
  return { count: list.length, all_whsec: list.length > 0 && list.every((s) => s.startsWith('whsec_')) };
}

export type StripeWebhookVerdict =
  | { ok: true; mode: StripeMode }
  | { ok: false; reason: string; not_configured?: true };

function signatureMatches(rawBody: string, t: string, v1s: string[], secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  const expBuf = Buffer.from(expected, 'utf8');
  return v1s.some((v) => {
    const vBuf = Buffer.from(v, 'utf8');
    return vBuf.length === expBuf.length && crypto.timingSafeEqual(vBuf, expBuf);
  });
}

/**
 * Verify a Stripe-Signature header (HMAC-SHA256 over `${t}.${rawBody}`,
 * constant-time compare, 5-minute replay tolerance) against every configured
 * signing secret of both modes. The secret that matches decides the mode. A
 * signature that matches secrets of BOTH modes (the same secret configured
 * twice) is refused: the mode would be a guess.
 */
export function verifyStripeWebhook(
  rawBody: string,
  sigHeader: string | null,
  nowSec: number = Math.floor(Date.now() / 1000)
): StripeWebhookVerdict {
  const secrets: { mode: StripeMode; secret: string }[] = [
    ...webhookSecretsFor('stripe_test').map((secret) => ({ mode: 'stripe_test' as const, secret })),
    ...webhookSecretsFor('stripe_live').map((secret) => ({ mode: 'stripe_live' as const, secret })),
  ];
  if (secrets.length === 0) return { ok: false, reason: 'webhook_not_configured', not_configured: true };
  if (!sigHeader) return { ok: false, reason: 'missing Stripe-Signature' };
  let t: string | null = null;
  const v1s: string[] = [];
  for (const part of sigHeader.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') t = v;
    else if (k === 'v1' && v) v1s.push(v);
  }
  if (!t || v1s.length === 0) return { ok: false, reason: 'malformed signature header' };
  const ts = Number(t);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(nowSec - ts) > WEBHOOK_TOLERANCE_SEC) return { ok: false, reason: 'timestamp outside tolerance' };
  const modes = new Set<StripeMode>();
  for (const s of secrets) {
    if (signatureMatches(rawBody, t, v1s, s.secret)) modes.add(s.mode);
  }
  if (modes.size === 0) return { ok: false, reason: 'no matching v1 signature' };
  if (modes.size > 1) return { ok: false, reason: 'signing secret configured for both modes' };
  return { ok: true, mode: [...modes][0] };
}

export type StripeWebhookAuth<E> =
  | { ok: true; mode: StripeMode; event: E }
  | { ok: false; status: number; error: string; reason?: string };

/**
 * Everything the webhook route must establish before it may act, in order:
 * a configured secret, a valid signature (whose secret decides the mode),
 * parseable JSON with an id, and `event.livemode` agreeing with that mode.
 * A live-signed event claiming livemode:false (or the reverse, or no livemode
 * at all) is refused: either the secrets are crossed or the payload is not
 * what it says, and both are reasons not to touch a payment row.
 */
export function authenticateStripeWebhook<E extends { id?: string; livemode?: boolean }>(
  rawBody: string,
  sigHeader: string | null,
  nowSec?: number
): StripeWebhookAuth<E> {
  const verdict = verifyStripeWebhook(rawBody, sigHeader, nowSec);
  if (!verdict.ok) {
    return verdict.not_configured
      ? { ok: false, status: 500, error: 'webhook_not_configured' }
      : { ok: false, status: 400, error: 'invalid_signature', reason: verdict.reason };
  }
  let event: E;
  try {
    event = JSON.parse(rawBody) as E;
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' };
  }
  if (!event || typeof event !== 'object' || !event.id) return { ok: false, status: 400, error: 'missing_event_id' };
  if (typeof event.livemode !== 'boolean' || event.livemode !== (verdict.mode === 'stripe_live')) {
    return {
      ok: false,
      status: 400,
      error: 'livemode_mismatch',
      reason: `signed with the ${verdict.mode === 'stripe_live' ? 'live' : 'test'} secret but livemode is ${String(event.livemode)}`,
    };
  }
  return { ok: true, mode: verdict.mode, event };
}
