// tests/stripe-accounts-v2.test.ts
//
// WHAT THIS GUARDS: creator payout accounts on Stripe Accounts v2 (the default
// since 2026-10-01, when Stripe refused POST /v1/accounts on a platform without
// the "Accounts v1 support" API-policy toggle).
//
//   1. Create: exact POST /v2/core/accounts request — URL, JSON body,
//      Stripe-Version, Content-Type, Idempotency-Key — then the v2 readiness
//      read and the v2 account link body. No /v1/accounts call at all.
//   2. Onboarded v2 account: transfer still goes through POST /v1/transfers.
//   3. Readiness parsing: only stripe_transfers.status === 'active' is ready.
//   4. v1 fallback: an existing account whose v2 view has no recipient
//      configuration is read and onboarded through v1.
//   5. STRIPE_ACCOUNTS_API=v1 (and the per-mode override) restores the v1 path.
//   6. mintOnboardingLink on v2.
//   7. Thin events: signature verified, related object fetched (and only that
//      URL), account_link.returned resolved through the event, context events
//      ignored, a failed fetch reported as a failure.
//   8. v2 error codes → operator copy, including through executePayout.
//   9. Connect probe and the readiness checklist follow the configured API.
//  10. Static pins on the webhook route.
//
// Hermetic: every api.stripe.com call hits a stub; in-memory store; no network.
//
// Run: npx tsx tests/stripe-accounts-v2.test.ts

import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeStore, type Row } from './negotiation-harness/store';
import {
  authenticateStripeWebhook,
  connectAccountsApi,
  executePayout,
  isConnectThinEventType,
  isThinEvent,
  mintOnboardingLink,
  parseV2AccountReadiness,
  probeStripeConnect,
  resolveThinAccountEvent,
  STRIPE_V2_API_VERSION,
  v2RecipientAccountBody,
  type StripeThinEvent,
} from '../src/lib/stripe-isolated';
import { mapStripeError, V2_ACCOUNT_CREATION_BLOCKED_REASONS } from '../src/lib/stripe-errors';
import { readPaymentsStatus, type ReadinessDeps } from '../src/lib/payments-readiness';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

// ── env ─────────────────────────────────────────────────────────────────────
const ENV_KEYS = [
  'PAYMENTS_MODE',
  'STRIPE_SECRET_KEY',
  'STRIPE_SECRET_KEY_TEST',
  'STRIPE_SECRET_KEY_LIVE',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_WEBHOOK_SECRETS_TEST',
  'STRIPE_WEBHOOK_SECRETS_LIVE',
  'STRIPE_ACCOUNTS_API',
  'STRIPE_ACCOUNTS_API_TEST',
  'STRIPE_ACCOUNTS_API_LIVE',
  'NEXT_PUBLIC_APP_URL',
];
async function withEnv<T>(patch: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, patch);
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
const TEST_ENV = { PAYMENTS_MODE: 'stripe_test', STRIPE_SECRET_KEY_TEST: 'sk_test_dummy', NEXT_PUBLIC_APP_URL: 'https://app.example.com' };

// ── fetch stub (api.stripe.com only) ────────────────────────────────────────
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
const harnessFetch = globalThis.fetch;
async function withStripe<T>(
  handler: (c: Call) => { status: number; json: unknown } | 'throw',
  fn: (calls: Call[]) => Promise<T>
): Promise<T> {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (!u.startsWith('https://api.stripe.com/')) return harnessFetch(url as string, init as RequestInit);
    const i = (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: unknown };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(i.headers ?? {})) headers[k.toLowerCase()] = v;
    const call: Call = { url: u, method: i.method ?? 'GET', headers, body: i.body == null ? '' : String(i.body) };
    calls.push(call);
    const r = handler(call);
    if (r === 'throw') throw new Error('ECONNRESET');
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json } as Response;
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = harnessFetch;
  }
}

const ACCOUNT_URL = (id: string) =>
  `https://api.stripe.com/v2/core/accounts/${id}?include[0]=configuration.recipient&include[1]=requirements`;
const v2Account = (id: string, transfers: string | null, payouts: string | null = null) => ({
  id,
  object: 'v2.core.account',
  configuration: {
    recipient: {
      capabilities: {
        stripe_balance: {
          ...(transfers ? { stripe_transfers: { status: transfers, status_details: [] } } : {}),
          ...(payouts ? { payouts: { status: payouts, status_details: [] } } : {}),
        },
      },
    },
  },
});

const BASE_INPUT = {
  amount_usd: 125,
  destination_email: 'creator@example.com',
  description: 'Creator Campaigns payout — offer o-1',
  idempotency_key: 'pa-1.full',
  account_display_name: 'cool.creator',
  onboarding_refresh_url: 'https://app.example.com/api/payout/onboard/pa-1',
  onboarding_return_url: 'https://app.example.com/payout/complete',
} as const;

// ── 1. create → readiness → v2 account link ─────────────────────────────────
async function section1() {
  console.log('\n1. v2 create: exact request shapes, then v2 readiness + v2 link');
  await withEnv(TEST_ENV, () =>
    withStripe(
      (c) => {
        if (c.method === 'POST' && c.url === 'https://api.stripe.com/v2/core/accounts') return { status: 200, json: { id: 'acct_V2NEW', object: 'v2.core.account' } };
        if (c.method === 'GET' && c.url === ACCOUNT_URL('acct_V2NEW')) return { status: 200, json: v2Account('acct_V2NEW', 'pending') };
        if (c.method === 'POST' && c.url === 'https://api.stripe.com/v2/core/account_links') return { status: 200, json: { object: 'v2.core.account_link', url: 'https://accounts.stripe.com/r/acct_V2NEW#alu_x' } };
        return { status: 404, json: { error: { message: `unexpected ${c.method} ${c.url}` } } };
      },
      async (calls) => {
        assert(connectAccountsApi('stripe_test') === 'v2' && connectAccountsApi('stripe_live') === 'v2', 'v2 is the default in both modes');
        const r = await executePayout({ ...BASE_INPUT, mode: 'stripe_test' });
        assert(r.ok && r.needs_onboarding === true && r.raw_status === 'awaiting_onboarding' && !r.settled, 'not ready → awaiting onboarding, not settled');
        assert(r.connect_account_id === 'acct_V2NEW', 'the created account id is returned for persistence');
        assert(r.onboarding_url === 'https://accounts.stripe.com/r/acct_V2NEW#alu_x', 'the v2 link url is returned');
        assert(!calls.some((c) => c.url.includes('/v1/accounts') || c.url.includes('/v1/account_links')), 'no Accounts v1 call at all');

        const create = calls[0];
        assert(create?.method === 'POST' && create.url === 'https://api.stripe.com/v2/core/accounts', 'first call: POST /v2/core/accounts');
        assert(create?.headers['stripe-version'] === STRIPE_V2_API_VERSION && STRIPE_V2_API_VERSION === '2026-09-30.preview', `create pins Stripe-Version ${STRIPE_V2_API_VERSION}`);
        assert(create?.headers['content-type'] === 'application/json', 'create sends JSON');
        assert(create?.headers['authorization'] === 'Bearer sk_test_dummy', 'create uses the test key');
        assert(create?.headers['idempotency-key'] === 'pa-1.full.account', 'create carries a deterministic Idempotency-Key');
        const body = JSON.parse(create?.body || '{}');
        const expected = {
          contact_email: 'creator@example.com',
          display_name: 'cool.creator',
          dashboard: 'express',
          defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
          identity: { country: 'us' },
          configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
          include: ['configuration.recipient', 'identity', 'requirements'],
        };
        assert(JSON.stringify(body) === JSON.stringify(expected), `create body is exactly the marketplace-guide shape (got ${create?.body})`);
        assert(!('display_name' in v2RecipientAccountBody('a@b.test', null)), 'display_name omitted when there is none');

        const read = calls[1];
        assert(read?.method === 'GET' && read.url === ACCOUNT_URL('acct_V2NEW'), 'second call: GET the account with indexed include params');
        assert(read?.headers['stripe-version'] === STRIPE_V2_API_VERSION && read.body === '', 'readiness read: v2 version, no body');

        const link = calls[2];
        assert(link?.method === 'POST' && link.url === 'https://api.stripe.com/v2/core/account_links', 'third call: POST /v2/core/account_links');
        assert(link?.headers['stripe-version'] === STRIPE_V2_API_VERSION && link.headers['content-type'] === 'application/json', 'link: v2 version, JSON');
        assert(/^[0-9a-f-]{36}$/.test(link?.headers['idempotency-key'] ?? ''), 'link: a fresh UUID Idempotency-Key per mint');
        const lb = JSON.parse(link?.body || '{}');
        const expectedLink = {
          account: 'acct_V2NEW',
          use_case: {
            type: 'account_onboarding',
            account_onboarding: {
              refresh_url: 'https://app.example.com/api/payout/onboard/pa-1',
              return_url: 'https://app.example.com/payout/complete',
              collection_options: { fields: 'eventually_due' },
            },
          },
        };
        assert(JSON.stringify(lb) === JSON.stringify(expectedLink), `link body exact (got ${link?.body})`);
        assert(calls.length === 3, `exactly three Stripe calls (got ${calls.length})`);
      }
    )
  );
}

// ── 2. onboarded v2 account → transfer ──────────────────────────────────────
async function section2() {
  console.log('\n2. onboarded v2 account: transfer via POST /v1/transfers');
  await withEnv(TEST_ENV, () =>
    withStripe(
      (c) => {
        if (c.method === 'GET' && c.url === ACCOUNT_URL('acct_READY')) return { status: 200, json: v2Account('acct_READY', 'active', 'active') };
        if (c.method === 'POST' && c.url === 'https://api.stripe.com/v1/transfers') return { status: 200, json: { id: 'tr_1' } };
        return { status: 404, json: {} };
      },
      async (calls) => {
        const r = await executePayout({ ...BASE_INPUT, mode: 'stripe_test', connect_account_id: 'acct_READY' });
        assert(r.ok && r.settled && r.provider_id === 'tr_1' && r.raw_status === 'paid', 'transfer settles');
        assert(!calls.some((c) => c.method === 'POST' && c.url.includes('/v2/core/accounts')), 'no account creation for an existing id');
        const tr = calls.find((c) => c.url.endsWith('/v1/transfers'));
        const p = new URLSearchParams(tr?.body ?? '');
        assert(p.get('destination') === 'acct_READY' && p.get('amount') === '12500' && p.get('currency') === 'usd', 'transfer: destination acct_, cents, usd');
        assert(tr?.headers['idempotency-key'] === 'pa-1.full.transfer' && tr.headers['content-type'] === 'application/x-www-form-urlencoded', 'transfer: v1 form body + idempotency key');
        assert(tr?.headers['stripe-version'] !== STRIPE_V2_API_VERSION, 'transfer keeps the v1 pinned version');
      }
    )
  );

  await withEnv(TEST_ENV, () =>
    withStripe(
      (c) => (c.url.startsWith('https://api.stripe.com/v2/core/accounts/') ? 'throw' : { status: 404, json: {} }),
      async (calls) => {
        const r = await executePayout({ ...BASE_INPUT, mode: 'stripe_test', connect_account_id: 'acct_X' });
        assert(!r.ok && !r.outcome_unknown && r.connect_account_id === 'acct_X', 'a failed readiness read fails definitely (no money call made)');
        assert(!calls.some((c) => c.url.endsWith('/v1/transfers')), 'no transfer after a failed readiness read');
      }
    )
  );
}

// ── 3. readiness parsing ────────────────────────────────────────────────────
function section3() {
  console.log('\n3. readiness parsing');
  const active = parseV2AccountReadiness(v2Account('a', 'active', 'pending'));
  assert(active.ready && active.has_recipient && active.transfers_status === 'active' && active.payouts_status === 'pending', 'active transfers → ready; payouts status reported');
  for (const s of ['pending', 'restricted', 'unsupported']) {
    assert(!parseV2AccountReadiness(v2Account('a', s)).ready, `${s} → not ready`);
  }
  const noCap = parseV2AccountReadiness(v2Account('a', null));
  assert(noCap.has_recipient && !noCap.ready && noCap.transfers_status === null, 'recipient without the capability → not ready');
  const noRecipient = parseV2AccountReadiness({ id: 'a', configuration: { recipient: null } });
  assert(!noRecipient.has_recipient && !noRecipient.ready, 'no recipient configuration → has_recipient false');
  assert(!parseV2AccountReadiness(null).ready && !parseV2AccountReadiness({}).has_recipient, 'garbage → not ready');
}

// ── 4. v1 fallback for an existing account ──────────────────────────────────
async function section4() {
  console.log('\n4. existing account with no v2 recipient view → v1 read + v1 link');
  await withEnv(TEST_ENV, () =>
    withStripe(
      (c) => {
        if (c.method === 'GET' && c.url === ACCOUNT_URL('acct_OLD')) return { status: 200, json: { id: 'acct_OLD', object: 'v2.core.account', configuration: null } };
        if (c.method === 'GET' && c.url === 'https://api.stripe.com/v1/accounts/acct_OLD') return { status: 200, json: { id: 'acct_OLD', payouts_enabled: false } };
        if (c.method === 'POST' && c.url === 'https://api.stripe.com/v1/account_links') return { status: 200, json: { url: 'https://connect.stripe.com/setup/old' } };
        return { status: 404, json: {} };
      },
      async (calls) => {
        const r = await executePayout({ ...BASE_INPUT, mode: 'stripe_test', connect_account_id: 'acct_OLD' });
        assert(r.ok && r.needs_onboarding === true && r.onboarding_url === 'https://connect.stripe.com/setup/old', 'v1 link minted for a v1-only account');
        assert(calls.map((c) => `${c.method} ${c.url.replace('https://api.stripe.com', '')}`).join(' | ') ===
          `GET ${ACCOUNT_URL('acct_OLD').replace('https://api.stripe.com', '')} | GET /v1/accounts/acct_OLD | POST /v1/account_links`, 'order: v2 read → v1 read → v1 link');
        assert(!calls.some((c) => c.url.endsWith('/v2/core/account_links')), 'no v2 link for a v1-only account');
      }
    )
  );
  await withEnv(TEST_ENV, () =>
    withStripe(
      (c) => {
        if (c.url === ACCOUNT_URL('acct_OLD')) return { status: 200, json: { id: 'acct_OLD' } };
        if (c.url === 'https://api.stripe.com/v1/accounts/acct_OLD') return { status: 200, json: { id: 'acct_OLD', payouts_enabled: true } };
        if (c.url.endsWith('/v1/transfers')) return { status: 200, json: { id: 'tr_old' } };
        return { status: 404, json: {} };
      },
      async () => {
        const r = await executePayout({ ...BASE_INPUT, mode: 'stripe_test', connect_account_id: 'acct_OLD' });
        assert(r.ok && r.settled && r.provider_id === 'tr_old', 'v1-only account with payouts_enabled is paid');
      }
    )
  );
}

// ── 5. STRIPE_ACCOUNTS_API=v1 ───────────────────────────────────────────────
async function section5() {
  console.log('\n5. STRIPE_ACCOUNTS_API=v1 and per-mode overrides');
  await withEnv({ ...TEST_ENV, STRIPE_ACCOUNTS_API: 'v1' }, () =>
    withStripe(
      (c) => {
        if (c.method === 'POST' && c.url === 'https://api.stripe.com/v1/accounts') return { status: 200, json: { id: 'acct_V1' } };
        if (c.method === 'GET' && c.url === 'https://api.stripe.com/v1/accounts/acct_V1') return { status: 200, json: { id: 'acct_V1', payouts_enabled: false } };
        if (c.method === 'POST' && c.url === 'https://api.stripe.com/v1/account_links') return { status: 200, json: { url: 'https://connect.stripe.com/setup/v1' } };
        return { status: 404, json: {} };
      },
      async (calls) => {
        const r = await executePayout({ ...BASE_INPUT, mode: 'stripe_test' });
        assert(r.ok && r.needs_onboarding === true && r.connect_account_id === 'acct_V1', 'v1: express account created and link minted');
        const create = calls.find((c) => c.url.endsWith('/v1/accounts') && c.method === 'POST');
        assert(new URLSearchParams(create?.body ?? '').get('type') === 'express', 'v1 create is the express form body');
        assert(!calls.some((c) => c.url.includes('/v2/')), 'v1: no v2 call');
      }
    )
  );
  await withEnv({ STRIPE_ACCOUNTS_API: 'v1', STRIPE_ACCOUNTS_API_LIVE: 'v2' }, () => {
    assert(connectAccountsApi('stripe_test') === 'v1' && connectAccountsApi('stripe_live') === 'v2', 'per-mode override wins over the shared value');
  });
  await withEnv({ STRIPE_ACCOUNTS_API: 'V1 ' }, () => assert(connectAccountsApi('stripe_test') === 'v1', 'value is trimmed and case-insensitive'));
  await withEnv({ STRIPE_ACCOUNTS_API: 'v3' }, () => assert(connectAccountsApi('stripe_test') === 'v2', 'an unknown value is v2'));
}

// ── 6. mintOnboardingLink ───────────────────────────────────────────────────
async function section6() {
  console.log('\n6. mintOnboardingLink through v2');
  await withEnv(TEST_ENV, () =>
    withStripe(
      (c) => {
        if (c.url === ACCOUNT_URL('acct_R')) return { status: 200, json: v2Account('acct_R', 'active') };
        if (c.url === ACCOUNT_URL('acct_P')) return { status: 200, json: v2Account('acct_P', 'pending') };
        if (c.url.endsWith('/v2/core/account_links')) return { status: 200, json: { url: 'https://accounts.stripe.com/r/acct_P' } };
        return { status: 404, json: {} };
      },
      async (calls) => {
        const ready = await mintOnboardingLink('acct_R', 'https://r', 'https://ret', 'stripe_test');
        assert(ready.ok && ready.payouts_enabled === true, 'ready account → already set up, no link');
        assert(!calls.some((c) => c.url.endsWith('/account_links')), 'no link minted for a ready account');
        const pending = await mintOnboardingLink('acct_P', 'https://r', 'https://ret', 'stripe_test');
        assert(pending.ok && !pending.payouts_enabled && pending.url === 'https://accounts.stripe.com/r/acct_P', 'pending → fresh v2 link');
        const live = await mintOnboardingLink('acct_P', 'https://r', 'https://ret', 'stripe_live');
        assert(!live.ok, 'no live key → refused, never the test key');
      }
    )
  );
}

// ── 7. thin events ──────────────────────────────────────────────────────────
const WHSEC_TEST = 'whsec_thin_test';
function sign(raw: string, secret: string, t: number): string {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`, 'utf8').digest('hex');
  return `t=${t},v1=${sig}`;
}
function thinEvent(over: Partial<StripeThinEvent> = {}): StripeThinEvent {
  return {
    id: 'evt_test_65ABC',
    object: 'v2.core.event',
    type: 'v2.core.account[configuration.recipient].capability_status_updated',
    livemode: false,
    context: null,
    related_object: { id: 'acct_T1', type: 'v2.core.account', url: '/v2/core/accounts/acct_T1' },
    ...over,
  };
}

async function section7() {
  console.log('\n7. thin events: verify, then fetch the related object');
  const now = 1_790_000_000;
  await withEnv({ ...TEST_ENV, STRIPE_WEBHOOK_SECRETS_TEST: WHSEC_TEST }, async () => {
    const raw = JSON.stringify(thinEvent());
    const auth = authenticateStripeWebhook<StripeThinEvent>(raw, sign(raw, WHSEC_TEST, now), now);
    assert(auth.ok && auth.mode === 'stripe_test' && isThinEvent(auth.event), 'a thin payload verifies with its whsec_ and is recognised as thin');
    const bad = authenticateStripeWebhook<StripeThinEvent>(raw, sign(raw, 'whsec_other', now), now);
    assert(!bad.ok && bad.status === 400 && bad.error === 'invalid_signature', 'a thin payload signed with another secret is refused');
    const tampered = authenticateStripeWebhook<StripeThinEvent>(raw.replace('acct_T1', 'acct_EVIL'), sign(raw, WHSEC_TEST, now), now);
    assert(!tampered.ok, 'a body altered after signing is refused');
    const liveClaim = JSON.stringify(thinEvent({ livemode: true }));
    const crossed = authenticateStripeWebhook<StripeThinEvent>(liveClaim, sign(liveClaim, WHSEC_TEST, now), now);
    assert(!crossed.ok && crossed.error === 'livemode_mismatch', 'test-signed thin event claiming livemode:true is refused');

    for (const t of ['v2.core.account[configuration.recipient].capability_status_updated', 'v2.core.account[requirements].updated', 'v2.core.account_link.returned']) {
      assert(isConnectThinEventType(t), `${t} is handled`);
    }
    assert(!isConnectThinEventType('v2.core.account.created') && !isConnectThinEventType('account.updated'), 'other types are not');
    assert(!isThinEvent({ object: 'event', type: 'account.updated' }), 'a v1 snapshot event is not thin');

    await withStripe(
      (c) => (c.url === ACCOUNT_URL('acct_T1') ? { status: 200, json: v2Account('acct_T1', 'active') } : { status: 404, json: {} }),
      async (calls) => {
        const r = await resolveThinAccountEvent('stripe_test', thinEvent());
        assert(r.ok && r.account_id === 'acct_T1' && r.ready && r.transfers_status === 'active', 'related account fetched and ready');
        assert(calls.length === 1 && calls[0].method === 'GET' && calls[0].url === ACCOUNT_URL('acct_T1'), 'exactly one GET of the related object (with include)');
        assert(calls[0].headers['stripe-version'] === STRIPE_V2_API_VERSION && calls[0].headers['authorization'] === 'Bearer sk_test_dummy', 'fetched with v2 version and the event-mode key');
      }
    );
    await withStripe(
      (c) => (c.url === ACCOUNT_URL('acct_T1') ? { status: 200, json: v2Account('acct_T1', 'pending') } : { status: 404, json: {} }),
      async () => {
        const r = await resolveThinAccountEvent('stripe_test', thinEvent({ type: 'v2.core.account[requirements].updated' }));
        assert(r.ok && r.account_id === 'acct_T1' && !r.ready, 'pending → account known, not ready');
      }
    );
    await withStripe(
      () => ({ status: 200, json: {} }),
      async (calls) => {
        const r = await resolveThinAccountEvent('stripe_test', thinEvent({ related_object: { id: 'acct_T1', type: 'v2.core.account', url: '/v1/transfers' } }));
        assert(!r.ok && calls.length === 0, 'a related_object.url that is not the account it names is refused without any fetch');
        const r2 = await resolveThinAccountEvent('stripe_test', thinEvent({ related_object: { id: '../v1/balance', type: 'v2.core.account' } }));
        assert(!r2.ok && calls.length === 0, 'a related_object.id that is not acct_ is refused without any fetch');
        const r3 = await resolveThinAccountEvent('stripe_test', thinEvent({ context: 'acct_connected' }));
        assert(r3.ok && r3.account_id === null && calls.length === 0, 'a connected-account-context event is ignored');
      }
    );
    await withStripe(
      (c) => {
        if (c.url === 'https://api.stripe.com/v2/core/events/evt_link_1') return { status: 200, json: { id: 'evt_link_1', type: 'v2.core.account_link.returned', data: { account_id: 'acct_L1' } } };
        if (c.url === ACCOUNT_URL('acct_L1')) return { status: 200, json: v2Account('acct_L1', 'active') };
        return { status: 404, json: {} };
      },
      async (calls) => {
        const r = await resolveThinAccountEvent('stripe_test', thinEvent({ id: 'evt_link_1', type: 'v2.core.account_link.returned', related_object: null }));
        assert(r.ok && r.account_id === 'acct_L1' && r.ready, 'account_link.returned resolved through the full event');
        assert(calls[0]?.url === 'https://api.stripe.com/v2/core/events/evt_link_1' && calls[0].headers['stripe-version'] === STRIPE_V2_API_VERSION, 'full event fetched from /v2/core/events/<id>');
      }
    );
    await withStripe(
      () => ({ status: 500, json: { error: { type: 'api_error', message: 'boom' } } }),
      async () => {
        const r = await resolveThinAccountEvent('stripe_test', thinEvent());
        assert(!r.ok && r.http_status === 500, 'a failed fetch is a failure (route answers 503), never "not ready"');
      }
    );
    await withStripe(
      () => 'throw',
      async () => {
        const r = await resolveThinAccountEvent('stripe_test', thinEvent());
        assert(!r.ok, 'a thrown fetch is a failure');
      }
    );
  });
  await withEnv({ PAYMENTS_MODE: 'stripe_test' }, async () => {
    const r = await resolveThinAccountEvent('stripe_live', thinEvent({ livemode: true }));
    assert(!r.ok, 'no key for the event mode → failure');
  });
}

// ── 8. v2 error mapping ─────────────────────────────────────────────────────
async function section8() {
  console.log('\n8. v2 error codes → operator copy');
  const act = mapStripeError({ type: 'invalid_request_error', code: 'account_create_activation_required', message: 'Platform must be activated to create connected accounts.' }, undefined, 400);
  assert(act.reason === 'stripe_platform_not_activated' && /activat/i.test(act.guidance) && act.guidance.startsWith('No money moved'), 'account_create_activation_required → activate the account');
  const blocked = mapStripeError({ code: 'accounts_v2_access_blocked' }, undefined, 400);
  assert(blocked.reason === 'stripe_accounts_v2_blocked' && blocked.guidance.includes('STRIPE_ACCOUNTS_API=v1'), 'accounts_v2_access_blocked names the v1 escape hatch');
  for (const code of [
    'account_creation_liability_unacknowledged',
    'account_creation_requirement_collection_unacknowledged',
    'account_creation_requirement_collection_and_liability_unacknowledged',
    'account_creation_losses_collector_unavailable',
  ]) {
    assert(mapStripeError({ code }).reason === 'stripe_platform_responsibilities_unacknowledged', `${code} → acknowledge platform responsibilities`);
  }
  assert(mapStripeError({ code: 'platform_registration_required' }).reason === 'stripe_connect_not_enabled', 'platform_registration_required → Connect not enabled');
  assert(mapStripeError({ code: 'non_connect_platform_accounts_v2_access_blocked' }).reason === 'stripe_connect_not_enabled', 'non_connect_platform_accounts_v2_access_blocked → Connect not enabled');
  assert(mapStripeError({ code: 'connect_profile_not_submitted' }).reason === 'stripe_connect_profile_incomplete', 'connect_profile_not_submitted mapped');
  assert(mapStripeError({ code: 'account_controller_express_dash_without_application_losses_or_fees' }).reason === 'stripe_account_configuration_rejected', 'express-collector rule mapped');
  assert(mapStripeError({ code: 'email_invalid' }).reason === 'stripe_creator_email_invalid', 'email_invalid → creator email');
  assert(mapStripeError({ code: 'cannot_create_new_account_rejected' }).reason === 'stripe_platform_cannot_create_accounts', 'rejected platform mapped');
  assert(mapStripeError({ code: 'payouts_not_allowed' }).reason === 'stripe_account_not_onboarded', 'v1 codes unchanged');
  assert((V2_ACCOUNT_CREATION_BLOCKED_REASONS as readonly string[]).includes('stripe_platform_not_activated'), 'activation is a creation-blocking reason');

  await withEnv(TEST_ENV, () =>
    withStripe(
      (c) =>
        c.url.endsWith('/v2/core/accounts')
          ? { status: 400, json: { error: { type: 'invalid_request_error', code: 'account_create_activation_required', message: 'Platform must be activated to create connected accounts.' } } }
          : { status: 404, json: {} },
      async (calls) => {
        const r = await executePayout({ ...BASE_INPUT, mode: 'stripe_test' });
        assert(!r.ok && !r.outcome_unknown && r.raw_status === 'failed', 'create refusal → definite failure');
        assert(r.reason === 'stripe_platform_not_activated' && r.error_code === 'account_create_activation_required', 'reason + code carried on the result');
        assert(r.error === 'Platform must be activated to create connected accounts.', 'Stripe prose kept verbatim for the audit');
        assert(calls.length === 1, 'nothing after a refused create');
      }
    )
  );
}

// ── 9. Connect probe + readiness checklist ──────────────────────────────────
function greenDeps(over: Partial<ReadinessDeps> = {}): ReadinessDeps {
  return {
    keyStatus: () => ({ present: true, usable: true, source: 'explicit', kind: 'restricted' }),
    liveAllowed: () => true,
    webhookSecretStatus: () => ({ count: 1, all_whsec: true }),
    probeAccount: async () => ({ ok: true, id: 'acct_platform', display_name: 'Example Records' }),
    probeBalance: async () => ({ ok: true, available_usd: 5000, pending_usd: 0, livemode: true }),
    probeConnect: async () => ({ ok: true }),
    listWebhookEndpoints: async () => ({
      ok: true,
      endpoints: [{ id: 'we_1', url: 'https://app.example.com/api/webhooks/stripe', status: 'enabled', enabled_events: ['account.updated', 'transfer.reversed', 'payout.failed'] }],
    }),
    webhookUrl: () => 'https://app.example.com/api/webhooks/stripe',
    accountsApi: () => 'v2',
    ...over,
  };
}
function readyStore(): ReturnType<typeof makeStore> {
  const s = makeStore();
  s.seed('platform_payment_settings', { id: true, stripe_mode: 'stripe_test', switched_by: null, switched_at: null } as Row);
  s.seed('firms', { id: 'firm-1', monthly_spend_cap_usd: 1000 } as Row);
  return s;
}

async function section9() {
  console.log('\n9. Connect probe and the account-creation checklist item under v2');
  await withEnv({ PAYMENTS_MODE: 'stripe_live', STRIPE_SECRET_KEY_LIVE: 'rk_live_dummy' }, async () => {
    await withStripe(
      (c) => (c.url === 'https://api.stripe.com/v2/core/accounts?limit=1' ? { status: 200, json: { data: [] } } : { status: 404, json: {} }),
      async (calls) => {
        const r = await probeStripeConnect('stripe_live');
        assert(r.ok, 'v2 Connect probe passes');
        assert(calls.length === 1 && calls[0].headers['stripe-version'] === STRIPE_V2_API_VERSION, 'probe lists /v2/core/accounts with the v2 version');
      }
    );
    await withStripe(
      () => ({ status: 400, json: { error: { code: 'platform_registration_required', message: 'not Connect' } } }),
      async () => {
        const r = await probeStripeConnect('stripe_live');
        assert(!r.ok && r.reason === 'stripe_connect_not_enabled', 'v2 probe refusal → Connect not enabled');
      }
    );

    const green = await readPaymentsStatus(readyStore().sb, greenDeps());
    const it = green.checklist.find((c) => c.id === 'account_creation');
    assert(green.ready && !!it && it.ok && !it.unknown, 'v2: account creation is reported ready, not unknown');
    assert(!!it?.detail && /Accounts v2/.test(it.detail) && /not needed/.test(it.detail), 'detail says the v1 toggle is not needed');

    const s1 = readyStore();
    s1.seed('audit_log', {
      action: 'payment.failed',
      occurred_at: '2026-10-01T18:51:00Z',
      metadata: { payment_mode: 'stripe_live', error: 'Stripe no longer recommends Accounts v1 for new Connect integrations.', reason: 'stripe_accounts_v1_disabled' },
    } as Row);
    const v1Refusal = await readPaymentsStatus(s1.sb, greenDeps());
    assert(v1Refusal.checklist.find((c) => c.id === 'account_creation')?.ok === true && v1Refusal.ready, 'a recorded Accounts-v1 refusal no longer blocks under v2');

    const s2 = readyStore();
    s2.seed('audit_log', {
      action: 'payment.failed',
      occurred_at: '2026-10-01T20:00:00Z',
      metadata: { payment_mode: 'stripe_live', reason: 'stripe_platform_not_activated', guidance: 'No money moved. Finish activation.' },
    } as Row);
    const v2Refusal = await readPaymentsStatus(s2.sb, greenDeps());
    const it2 = v2Refusal.checklist.find((c) => c.id === 'account_creation');
    assert(!!it2 && !it2.ok && !v2Refusal.ready && it2.fix === 'No money moved. Finish activation.', 'a v2 platform-setup refusal in Live blocks, with its guidance as the fix');

    const s3 = readyStore();
    s3.seed('audit_log', {
      action: 'payment.failed',
      occurred_at: '2026-10-01T20:00:00Z',
      metadata: { payment_mode: 'stripe_test', reason: 'stripe_platform_not_activated', guidance: 'No money moved. Finish activation.' },
    } as Row);
    const testRefusal = await readPaymentsStatus(s3.sb, greenDeps());
    const it3 = testRefusal.checklist.find((c) => c.id === 'account_creation');
    assert(!!it3 && it3.ok && it3.unknown === true && /in Test/.test(it3.detail ?? ''), 'a v2 refusal in Test is surfaced, does not block');

    const v1 = await readPaymentsStatus(s1.sb, greenDeps({ accountsApi: () => 'v1' }));
    assert(v1.checklist.find((c) => c.id === 'account_creation')?.ok === false, 'with STRIPE_ACCOUNTS_API=v1 the v1 refusal still blocks');
  });
}

// ── 10. static pins ─────────────────────────────────────────────────────────
function section10() {
  console.log('\n10. static pins');
  const SRC = join(__dirname, '..', 'src');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  const route = strip(readFileSync(join(SRC, 'app/api/webhooks/stripe/route.ts'), 'utf8'));
  assert(!route.includes('process.env.'), 'webhook route still reads no env');
  assert(/isThinEvent\(event\) && isConnectThinEventType\(event\.type\)/.test(route), 'route dispatches Connect thin events');
  assert(/resolveThinAccountEvent\(eventMode, event\)/.test(route), 'thin events are resolved in the event mode');
  assert(/thin_event_fetch_failed' \}, \{ status: 503 \}/.test(route), 'a failed thin-event fetch answers 503 so Stripe redelivers');
  assert(/event\.type === 'account\.updated'/.test(route) && /payouts_enabled === true/.test(route), 'the v1 account.updated handler is kept');
  const lib = strip(readFileSync(join(SRC, 'lib/stripe-isolated.ts'), 'utf8'));
  assert(!/fetch\(\s*`https:\/\/api\.stripe\.com\$\{(rel|event\.related_object)/.test(lib), 'related_object.url is never fetched verbatim');
  const env = readFileSync(join(__dirname, '..', '.env.example'), 'utf8');
  assert(/^STRIPE_ACCOUNTS_API=$/m.test(env), '.env.example lists STRIPE_ACCOUNTS_API (name only)');
}

async function main() {
  await section1();
  await section2();
  section3();
  await section4();
  await section5();
  await section6();
  await section7();
  await section8();
  await section9();
  section10();
  console.log(`\nstripe-accounts-v2 test: ${passed}/${passed + failed} pass`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
