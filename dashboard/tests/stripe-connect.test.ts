// tests/stripe-connect.test.ts
//
// Unit tests for the Stripe Connect Express payout path in stripe-isolated.ts,
// driven through executePayout() against a stubbed globalThis.fetch — NO network.
// Covers: onboarding-required flow, transfer-on-enabled, error surfacing, and the
// sk_test_ structural guard (non-test key in stripe_test → falls back to paper).
//
// Also covers, since the payout-failure-surfacing change:
//   * every raw call pins Stripe-Version to one constant (no floating version)
//   * the account-CREATION failure path (Connect not enabled on the platform) —
//     previously untested, and the first case a fresh Stripe account hits
//   * error.code / error.type → operator-facing guidance (src/lib/stripe-errors.ts)
//
// Run: npx tsx tests/stripe-connect.test.ts

import { executePayout, STRIPE_API_VERSION } from '../src/lib/stripe-isolated';
import { ACCOUNT_NOT_ONBOARDED, mapStripeError } from '../src/lib/stripe-errors';

// This suite pins the Accounts v1 path (STRIPE_ACCOUNTS_API=v1); the v2 default
// is covered by tests/stripe-accounts-v2.test.ts.
process.env.STRIPE_ACCOUNTS_API = 'v1';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

interface FetchCall {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}
let calls: FetchCall[] = [];
const realFetch = globalThis.fetch;

function stubFetch(handler: (call: FetchCall) => { status: number; json: unknown }) {
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const i = (init ?? {}) as { method?: string; body?: unknown; headers?: unknown };
    // Stripe uses form-encoding (URLSearchParams), not JSON — capture both.
    const bodyStr =
      i.body == null ? '' : typeof i.body === 'string' ? i.body : String(i.body);
    // Lower-case the header names so assertions don't depend on casing.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((i.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const call: FetchCall = {
      url: String(url),
      method: i.method ?? 'GET',
      body: bodyStr,
      headers,
    };
    calls.push(call);
    const { status, json } = handler(call);
    return { ok: status >= 200 && status < 300, status, json: async () => json } as Response;
  }) as typeof fetch;
}

function setStripeTest() {
  calls = [];
  process.env.PAYMENTS_MODE = 'stripe_test';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
}

async function run() {
  // ── No connected account yet → create account, link, return needs_onboarding ──
  setStripeTest();
  stubFetch((call) => {
    if (call.url.endsWith('/v1/accounts')) return { status: 200, json: { id: 'acct_NEW' } };
    if (call.url.includes('/v1/accounts/acct_NEW')) return { status: 200, json: { id: 'acct_NEW', payouts_enabled: false } };
    if (call.url.endsWith('/v1/account_links')) return { status: 200, json: { url: 'https://connect.stripe.com/setup/x' } };
    return { status: 404, json: {} };
  });
  const onboard = await executePayout({
    amount_usd: 185, destination_email: 'creator@example.com',
    description: 'deal', idempotency_key: 'pa-1',
  });
  assert(onboard.ok && onboard.needs_onboarding === true, 'no account → needs_onboarding');
  assert(onboard.settled === false, 'onboarding path is not settled');
  assert(onboard.onboarding_url === 'https://connect.stripe.com/setup/x', 'returns hosted onboarding url');
  assert(onboard.connect_account_id === 'acct_NEW', 'returns created account id to persist');
  assert(calls.some((c) => c.url.endsWith('/v1/accounts') && c.method === 'POST'), 'created a connect account');
  assert(calls.some((c) => c.url.endsWith('/v1/account_links')), 'created an onboarding link');
  assert(!calls.some((c) => c.url.endsWith('/v1/transfers')), 'did NOT transfer before onboarding');
  // payouts_enabled=false is a STATE, not a Stripe error code — it still has to
  // reach the operator as a sentence, and as the same sentence the
  // `payouts_not_allowed` error code produces.
  assert(onboard.reason === 'stripe_account_not_onboarded', 'onboarding path carries the not-onboarded reason');
  assert(
    typeof onboard.guidance === 'string' && /onboarding/i.test(onboard.guidance),
    'onboarding path carries operator guidance'
  );

  // ── Stripe-Version is pinned on every raw call (3 of 4 seen on this path) ──
  assert(
    calls.length === 3 && calls.every((c) => c.headers['stripe-version'] === STRIPE_API_VERSION),
    `every account/link call pins Stripe-Version=${STRIPE_API_VERSION}`
  );
  assert(/^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/.test(STRIPE_API_VERSION), 'pinned version looks like a Stripe version string');

  // ── Existing account, payouts enabled → transfer, settled ──
  setStripeTest();
  stubFetch((call) => {
    if (call.url.includes('/v1/accounts/acct_OK')) return { status: 200, json: { id: 'acct_OK', payouts_enabled: true } };
    if (call.url.endsWith('/v1/transfers')) return { status: 200, json: { id: 'tr_123' } };
    return { status: 404, json: {} };
  });
  const paid = await executePayout({
    amount_usd: 185, destination_email: 'creator@example.com',
    description: 'deal', idempotency_key: 'pa-2', connect_account_id: 'acct_OK',
  });
  assert(paid.ok && paid.settled === true, 'enabled account → settled transfer');
  assert(paid.provider_id === 'tr_123', 'returns transfer id as provider_id');
  assert(!paid.needs_onboarding, 'no onboarding when already enabled');
  const transferCall = calls.find((c) => c.url.endsWith('/v1/transfers'))!;
  assert(transferCall.body.includes('destination=acct_OK'), 'transfer targets the connected account');
  assert(transferCall.body.includes('amount=18500'), 'transfer amount in cents');
  assert(!calls.some((c) => c.url.endsWith('/v1/accounts') && c.method === 'POST'), 'reused existing account (no create)');
  // The 4th raw call. With the account-create/link/get assertions above, all
  // four api.stripe.com calls in this module are covered.
  assert(
    transferCall.headers['stripe-version'] === STRIPE_API_VERSION,
    'transfer call pins Stripe-Version'
  );
  assert(
    transferCall.headers['idempotency-key'] === 'pa-2.transfer',
    'transfer call still sends its idempotency key alongside the pinned version'
  );

  // ── Transfer API error surfaces as ok:false ──
  setStripeTest();
  stubFetch((call) => {
    if (call.url.includes('/v1/accounts/acct_OK')) return { status: 200, json: { id: 'acct_OK', payouts_enabled: true } };
    if (call.url.endsWith('/v1/transfers')) return { status: 400, json: { error: { message: 'Insufficient funds in the platform account' } } };
    return { status: 404, json: {} };
  });
  const txErr = await executePayout({
    amount_usd: 185, destination_email: 'c@example.com',
    description: 'deal', idempotency_key: 'pa-3', connect_account_id: 'acct_OK',
  });
  assert(!txErr.ok && /Insufficient funds/.test(txErr.error ?? ''), 'transfer error surfaced');
  assert(txErr.connect_account_id === 'acct_OK', 'account id preserved on error');
  // No `code` on that response → the prose safety net still maps it.
  assert(
    txErr.reason === 'stripe_insufficient_platform_balance',
    `codeless insufficient-funds prose still maps (got ${txErr.reason})`
  );
  assert(
    typeof txErr.guidance === 'string' && /top up/i.test(txErr.guidance),
    'insufficient balance → actionable guidance'
  );

  // ── ACCOUNT CREATION FAILS: Connect not enabled on the platform ──
  // The first-launch case. Previously untested, and this branch used to return a
  // different shape from its three siblings (no connect_account_id, no
  // structured error), so the caller could not treat failures uniformly.
  setStripeTest();
  stubFetch((call) => {
    if (call.url.endsWith('/v1/accounts') && call.method === 'POST') {
      return {
        status: 400,
        json: {
          error: {
            // Verified code, docs.stripe.com/error-codes (2026-09-15).
            code: 'platform_account_required',
            type: 'invalid_request_error',
            message: 'Only Stripe Connect platforms can work with other accounts.',
          },
        },
      };
    }
    return { status: 200, json: {} };
  });
  const noConnect = await executePayout({
    amount_usd: 185, destination_email: 'creator@example.com',
    description: 'deal', idempotency_key: 'pa-5',
  });
  assert(noConnect.ok === false, 'connect-not-enabled → ok:false');
  assert(noConnect.raw_status === 'failed' && noConnect.settled === false, 'connect-not-enabled → failed + unsettled');
  assert(
    noConnect.error === 'Only Stripe Connect platforms can work with other accounts.',
    'connect-not-enabled → raw Stripe prose preserved verbatim for the audit log'
  );
  assert(noConnect.error_code === 'platform_account_required', 'connect-not-enabled → error.code carried through');
  assert(noConnect.error_type === 'invalid_request_error', 'connect-not-enabled → error.type carried through');
  assert(noConnect.reason === 'stripe_connect_not_enabled', 'connect-not-enabled → stable reason slug');
  assert(
    typeof noConnect.guidance === 'string' &&
      /enable connect/i.test(noConnect.guidance) &&
      noConnect.guidance !== noConnect.error,
    'connect-not-enabled → operator guidance that is not just the raw prose'
  );
  // Shape parity with the three sibling failure returns.
  assert('connect_account_id' in noConnect, 'connect-not-enabled failure carries connect_account_id like its siblings');
  assert(noConnect.connect_account_id === undefined, 'no account was created, so there is no id to carry');
  assert(
    !calls.some((c) => c.url.endsWith('/v1/account_links') || c.url.endsWith('/v1/transfers')),
    'connect-not-enabled → aborted before any link or transfer call'
  );
  assert(
    calls.every((c) => c.headers['stripe-version'] === STRIPE_API_VERSION),
    'failing account-create call still pinned Stripe-Version'
  );

  // ── Transfers capability not active on the connected account ──
  setStripeTest();
  stubFetch((call) => {
    if (call.url.includes('/v1/accounts/acct_OK')) return { status: 200, json: { id: 'acct_OK', payouts_enabled: true } };
    if (call.url.endsWith('/v1/transfers')) {
      return {
        status: 400,
        json: {
          error: {
            // Verified code, docs.stripe.com/error-codes (2026-09-15).
            code: 'capability_not_active',
            type: 'invalid_request_error',
            message: 'Your account is missing the active capabilities required to access this endpoint.',
          },
        },
      };
    }
    return { status: 404, json: {} };
  });
  const capErr = await executePayout({
    amount_usd: 185, destination_email: 'c@example.com',
    description: 'deal', idempotency_key: 'pa-6', connect_account_id: 'acct_OK',
  });
  assert(capErr.ok === false, 'capability-not-active → ok:false');
  assert(capErr.reason === 'stripe_transfers_capability_inactive', 'capability-not-active → mapped reason');
  assert(capErr.error_code === 'capability_not_active', 'capability-not-active → code carried');
  assert(capErr.connect_account_id === 'acct_OK', 'capability-not-active → account id preserved');

  // ── Insufficient platform balance, WITH the documented code ──
  setStripeTest();
  stubFetch((call) => {
    if (call.url.includes('/v1/accounts/acct_OK')) return { status: 200, json: { id: 'acct_OK', payouts_enabled: true } };
    if (call.url.endsWith('/v1/transfers')) {
      return {
        status: 400,
        json: {
          error: {
            // Verified code, docs.stripe.com/error-codes (2026-09-15).
            code: 'balance_insufficient',
            type: 'invalid_request_error',
            message:
              "The transfer or payout couldn't be completed because the associated account doesn't have a sufficient balance available.",
          },
        },
      };
    }
    return { status: 404, json: {} };
  });
  const balErr = await executePayout({
    amount_usd: 185, destination_email: 'c@example.com',
    description: 'deal', idempotency_key: 'pa-7', connect_account_id: 'acct_OK',
  });
  assert(balErr.reason === 'stripe_insufficient_platform_balance', 'balance_insufficient → mapped reason');
  assert(balErr.error_code === 'balance_insufficient', 'balance_insufficient → code carried');

  // ── Payouts disabled on the connected account (documented code form) ──
  setStripeTest();
  stubFetch((call) => {
    if (call.url.includes('/v1/accounts/acct_OK')) return { status: 200, json: { id: 'acct_OK', payouts_enabled: true } };
    if (call.url.endsWith('/v1/transfers')) {
      return {
        status: 400,
        json: {
          error: {
            // Verified code, docs.stripe.com/error-codes (2026-09-15).
            code: 'payouts_not_allowed',
            type: 'invalid_request_error',
            message: 'Payouts have been disabled on the connected account.',
          },
        },
      };
    }
    return { status: 404, json: {} };
  });
  const payoutsOff = await executePayout({
    amount_usd: 185, destination_email: 'c@example.com',
    description: 'deal', idempotency_key: 'pa-8', connect_account_id: 'acct_OK',
  });
  assert(payoutsOff.reason === 'stripe_account_not_onboarded', 'payouts_not_allowed → not-onboarded reason');
  assert(
    payoutsOff.guidance === ACCOUNT_NOT_ONBOARDED.guidance,
    'payouts_not_allowed guidance matches the shared not-onboarded sentence'
  );

  // ── mapStripeError precedence, directly ──
  // code wins over prose:
  const codeWins = mapStripeError(
    { code: 'balance_insufficient', type: 'invalid_request_error', message: 'Only Stripe Connect platforms can work with other accounts.' },
    undefined,
    400
  );
  assert(codeWins.reason === 'stripe_insufficient_platform_balance', 'error.code takes precedence over prose');
  assert(codeWins.code === 'balance_insufficient' && codeWins.type === 'invalid_request_error', 'mapper echoes code + type');
  // prose net when there is no code:
  const proseNet = mapStripeError(
    { type: 'invalid_request_error', message: 'Only Stripe Connect platforms can work with other accounts.' },
    undefined,
    400
  );
  assert(proseNet.reason === 'stripe_connect_not_enabled', 'prose fallback catches Connect-not-enabled without a code');
  // type fallback when neither code nor prose matches:
  const typeNet = mapStripeError({ type: 'api_error', message: 'Something went wrong.' }, undefined, 500);
  assert(typeNet.reason === 'stripe_api_error', 'error.type is the coarse fallback');
  // unknown code is still surfaced, never swallowed:
  const unknown = mapStripeError({ code: 'some_new_code', message: 'Brand new failure.' }, undefined, 400);
  assert(unknown.reason === 'stripe_some_new_code', 'unknown code becomes a namespaced reason');
  assert(/Brand new failure/.test(unknown.guidance), 'unknown code keeps the raw prose visible');
  // nothing at all:
  const empty = mapStripeError(undefined, undefined, 503);
  assert(empty.reason === 'stripe_unmapped_error' && empty.guidance.length > 0, 'bodyless failure still gets guidance');

  // ── sk_test_ structural guard: a non-test key in stripe_test → paper fallback ──
  calls = [];
  process.env.PAYMENTS_MODE = 'stripe_test';
  process.env.STRIPE_SECRET_KEY = 'sk_live_should_be_refused';
  stubFetch(() => ({ status: 200, json: {} }));
  const guarded = await executePayout({
    amount_usd: 50, destination_email: 'c@example.com', description: 'd', idempotency_key: 'pa-4',
  });
  assert(guarded.mode === 'paper' && guarded.settled === true, 'non-sk_test_ key falls back to paper (no real call)');
  assert(calls.length === 0, 'no Stripe call in paper fallback');

  globalThis.fetch = realFetch;
  delete process.env.STRIPE_SECRET_KEY;
  console.log(`stripe-connect test: ${passed}/${passed + failed} pass`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
