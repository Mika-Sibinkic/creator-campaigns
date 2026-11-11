// tests/payments-mode-switch.test.ts
//
// WHAT THIS GUARDS: the operator-only Test/Live payments switch
// (migration 064).
//
//   1. Resolution: the platform setting under the PAYMENTS_MODE ceiling; no
//      settings row (pre-064) is exactly the old env resolution.
//   2. Keys: per-mode keys, restricted rk_ prefixes accepted, a key of the
//      wrong mode refused, the legacy single key serving its own mode.
//   3. A payment approved in Test is refused (mode_mismatch) after the switch
//      to Live, on the execute path and the onboarding webhook path.
//   4. A Test connected account is never used with the Live key.
//   5. Webhook: the secret decides the mode; live secret + livemode:false is
//      rejected; handlers only touch rows of the event's mode.
//   6. The readiness checklist: each failing item blocks the switch; the
//      typed confirmation is required; back to Test always works.
//   7. Non-operators get 403.
//   8. Pre-064 behaviour unchanged.
//   9. Accounts v1 refusal mapping, the operator header chip, static pins.
//
// Hermetic: in-memory store, dummy env (setup-env), fetch stubbed for every
// api.stripe.com call. No DB, no Stripe, no network.
//
// Run: npx tsx tests/payments-mode-switch.test.ts

import { auditActions } from './negotiation-harness/setup-env'; // FIRST — dummy env
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeStore, type Row } from './negotiation-harness/store';
import {
  authenticateStripeWebhook,
  combinePaymentMode,
  mintOnboardingLink,
  resolveActivePaymentMode,
  resolvePaymentMode,
  stripeKeyStatus,
  stripeKeyMatchesMode,
  type PlatformPaymentSetting,
  type StripeTransferInput,
  type StripeTransferResult,
} from '../src/lib/stripe-isolated';
import { executeAuthorizedPayment } from '../src/lib/execute-payment';
import { approvePaymentAuthorization } from '../src/lib/approve-payment';
import { payOnboardedAuthorization, type OnboardingPayoutDeps } from '../src/lib/onboarding-payout';
import { retryRefusal } from '../src/lib/payment-claim';
import { legAccountsForPayment } from '../src/lib/payment-legs';
import { handleTransferReversed } from '../src/lib/settlement-failure';
import {
  readPaymentsStatus,
  switchPaymentsMode,
  SWITCH_CONFIRMATION,
  MODE_SWITCH_ACTION,
  type ReadinessDeps,
} from '../src/lib/payments-readiness';
import { mapStripeError } from '../src/lib/stripe-errors';
import { paymentModeChip, MODE_MISMATCH_ACTION } from '../src/lib/payment-mode-copy';
import { MONEY_ANOMALY_AUDIT_ACTIONS } from '../src/lib/statuses';

// This suite pins the Accounts v1 path (its Stripe stubs answer /v1/accounts and
// its checklist cases are the v1 refusal). The v2 default is covered by
// tests/stripe-accounts-v2.test.ts.
process.env.STRIPE_ACCOUNTS_API = 'v1';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(msg);
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

const SRC = join(__dirname, '..', 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
/** Source with comments stripped, so a prose mention is not a call. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

const ENV_KEYS = [
  'PAYMENTS_MODE',
  'STRIPE_SECRET_KEY',
  'STRIPE_SECRET_KEY_TEST',
  'STRIPE_SECRET_KEY_LIVE',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_WEBHOOK_SECRETS_TEST',
  'STRIPE_WEBHOOK_SECRETS_LIVE',
  'OPERATOR_EMAILS',
] as const;
type EnvPatch = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

/** Run fn with exactly these Stripe env vars (everything else in ENV_KEYS unset). */
async function withEnv<T>(patch: EnvPatch, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const harnessFetch = globalThis.fetch;
interface StubCall { url: string; method: string; auth: string }
/** Stub api.stripe.com; everything else (the audit writer) goes to the harness. */
async function withStripe<T>(
  handler: (c: StubCall) => { status: number; json: unknown },
  fn: (calls: StubCall[]) => Promise<T>
): Promise<T> {
  const calls: StubCall[] = [];
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (!u.startsWith('https://api.stripe.com/')) return harnessFetch(url as string, init as RequestInit);
    const i = (init ?? {}) as { method?: string; headers?: Record<string, string> };
    const call = { url: u, method: i.method ?? 'GET', auth: i.headers?.Authorization ?? '' };
    calls.push(call);
    const r = handler(call);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json } as Response;
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = harnessFetch;
  }
}

const LIVE_ENV: EnvPatch = {
  PAYMENTS_MODE: 'stripe_live',
  STRIPE_SECRET_KEY_TEST: 'sk_test_dummy',
  STRIPE_SECRET_KEY_LIVE: 'rk_live_dummy',
  // No built-in operators: the switch is operator-only, so name one.
  OPERATOR_EMAILS: 'operator.personal@example.com',
};

const FIRM = 'firm-1';
const CAMPAIGN = 'camp-1';

function settings(stripeMode: 'stripe_test' | 'stripe_live'): Row {
  return { id: true, stripe_mode: stripeMode, switched_by: null, switched_at: null };
}

/** An offer + one authorization the execute path can load end to end. */
function seedDeal(
  store: ReturnType<typeof makeStore>,
  opts: { paStatus?: string; approvedMode?: string | null; acct?: string | null; acctMode?: string | null; failureReason?: string | null }
): Row {
  store.seed('campaigns', { id: CAMPAIGN, total_budget_usd: 10_000, artist_name: 'Artist' });
  store.seed('firms', { id: FIRM, monthly_spend_cap_usd: 0, per_creator_monthly_cap_usd: 0, sender_name: 'Label' });
  store.seed('influencers', { id: 'inf-1', stripe_connect_account_id: opts.acct ?? null, stripe_connect_account_mode: opts.acctMode ?? null });
  store.seed('creator_offers', {
    id: 'offer-1',
    firm_id: FIRM,
    campaign_id: CAMPAIGN,
    campaign_influencer_id: 'ci-1',
    status: 'approved',
    agreed_amount_usd: 100,
    ceiling_usd: 200,
    deposit_paid_usd: null,
    balance_paid_usd: null,
    payout_status: null,
    paid_at: null,
  });
  const status = opts.paStatus ?? 'approved';
  const approved = !['pending_human_review', 'rejected'].includes(status);
  return store.seed('payment_authorizations', {
    id: 'pa-1',
    firm_id: FIRM,
    campaign_id: CAMPAIGN,
    creator_offer_id: 'offer-1',
    amount_usd: 100,
    status,
    leg: 'full',
    human_approved_at: approved ? '2026-09-29T10:00:00.000Z' : null,
    human_approved_by_user_id: approved ? 'user_approver' : null,
    payment_provider_id: null,
    failure_reason: opts.failureReason ?? null,
    executing_at: null,
    payment_mode: 'paper',
    ...(opts.approvedMode !== undefined ? { approved_mode: opts.approvedMode } : {}),
    created_at: '2026-09-29T09:00:00.000Z',
    creator_offers: {
      id: 'offer-1',
      payout_email: 'c@example.com',
      contract_text: null,
      contract_generated_at: null,
      campaign_influencer_id: 'ci-1',
      campaign_influencers: {
        influencer_id: 'inf-1',
        influencer: {
          contact_email: 'c@example.com',
          username: 'creator',
          stripe_connect_account_id: opts.acct ?? null,
          stripe_connect_account_mode: opts.acctMode ?? null,
        },
      },
    },
  });
}

/** A Stripe that onboards and pays happily. */
const happyStripe = (c: StubCall) => {
  if (c.method === 'POST' && c.url.endsWith('/v1/accounts')) return { status: 200, json: { id: 'acct_live_new' } };
  if (c.method === 'GET' && c.url.includes('/v1/accounts/')) return { status: 200, json: { id: 'acct', payouts_enabled: true } };
  if (c.method === 'POST' && c.url.endsWith('/v1/transfers')) return { status: 200, json: { id: 'tr_live_1' } };
  if (c.method === 'POST' && c.url.endsWith('/v1/account_links')) return { status: 200, json: { url: 'https://connect.stripe.com/x' } };
  return { status: 404, json: { error: { message: 'unexpected call' } } };
};

const absent: PlatformPaymentSetting = { state: 'absent', stripe_mode: null, switched_by: null, switched_at: null };
const present = (m: 'stripe_test' | 'stripe_live'): PlatformPaymentSetting => ({ state: 'present', stripe_mode: m, switched_by: null, switched_at: null });

async function section1Resolution() {
  console.log('\n1. resolution: platform setting under the env ceiling');
  await withEnv(LIVE_ENV, () => {
    assert(combinePaymentMode(present('stripe_test')).mode === 'stripe_test', 'ceiling live + setting test → stripe_test');
    assert(combinePaymentMode(present('stripe_live')).mode === 'stripe_live', 'ceiling live + setting live → stripe_live');
    assert(combinePaymentMode(present('stripe_live')).pinned, 'a settings row pins claims');
    assert(
      combinePaymentMode({ state: 'error', stripe_mode: null, switched_by: null, switched_at: null, error: 'boom' }).mode === 'stripe_test',
      'unreadable setting → held in Test'
    );
    const pre = combinePaymentMode(absent);
    assert(pre.mode === 'stripe_live' && !pre.pinned, 'no settings row (pre-064) → env resolution, unpinned');
  });
  await withEnv({ ...LIVE_ENV, PAYMENTS_MODE: 'stripe_test' }, () => {
    assert(combinePaymentMode(present('stripe_live')).mode === 'stripe_test', 'ceiling test caps a live setting at Test');
  });
  await withEnv({ PAYMENTS_MODE: 'paper', STRIPE_SECRET_KEY_LIVE: 'rk_live_x' }, () => {
    const p = combinePaymentMode(present('stripe_live'));
    assert(p.mode === 'paper' && p.pinned, 'ceiling paper → paper (pinned once 064 is applied)');
  });
  await withEnv({ PAYMENTS_MODE: 'stripe_live', STRIPE_SECRET_KEY_LIVE: 'rk_live_x' }, () => {
    assert(combinePaymentMode(present('stripe_test')).mode === 'paper', 'setting Test with no test key → paper, never the live key');
  });
  // Through the database: a missing table is pre-064, a present row decides.
  {
    const missing = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.platform_payment_settings' in the schema cache" } }) }) }),
      }),
    } as never;
    const a = await withEnv(LIVE_ENV, () => resolveActivePaymentMode(missing));
    assert(a.mode === 'stripe_live' && !a.pinned && a.setting.state === 'absent', 'PGRST205 → pre-064 resolution, unpinned');
    const s = makeStore();
    s.seed('platform_payment_settings', settings('stripe_test'));
    const b = await withEnv(LIVE_ENV, () => resolveActivePaymentMode(s.sb));
    assert(b.mode === 'stripe_test' && b.pinned, 'settings row Test under a live ceiling → stripe_test, pinned');
  }
}

async function section2Keys() {
  console.log('\n2. keys: per mode, restricted prefixes accepted, wrong mode refused');
  assert(stripeKeyMatchesMode('stripe_test', 'rk_test_abc'), 'rk_test_ accepted for Test');
  assert(stripeKeyMatchesMode('stripe_live', 'rk_live_abc'), 'rk_live_ accepted for Live');
  assert(stripeKeyMatchesMode('stripe_live', 'sk_live_abc') && stripeKeyMatchesMode('stripe_test', 'sk_test_abc'), 'sk_ keys accepted');
  assert(!stripeKeyMatchesMode('stripe_live', 'rk_test_abc') && !stripeKeyMatchesMode('stripe_test', 'sk_live_abc'), 'a key never passes for the other mode');
  await withEnv({ PAYMENTS_MODE: 'stripe_live', STRIPE_SECRET_KEY_LIVE: 'rk_live_x' }, () => {
    assert(resolvePaymentMode() === 'stripe_live', 'restricted live key resolves stripe_live');
    const s = stripeKeyStatus('stripe_live');
    assert(s.usable && s.kind === 'restricted' && s.source === 'explicit', 'key status: restricted, explicit');
  });
  await withEnv({ PAYMENTS_MODE: 'stripe_test', STRIPE_SECRET_KEY_TEST: 'rk_test_x' }, () => {
    assert(resolvePaymentMode() === 'stripe_test', 'restricted test key resolves stripe_test');
  });
  await withEnv({ PAYMENTS_MODE: 'stripe_live', STRIPE_SECRET_KEY_LIVE: 'sk_test_wrong', STRIPE_SECRET_KEY: 'sk_live_legacy' }, () => {
    assert(resolvePaymentMode() === 'paper', 'a wrong-mode explicit key is refused, not papered over with the legacy key');
    const s = stripeKeyStatus('stripe_live');
    assert(s.present && !s.usable, 'key status: present but unusable');
  });
  await withEnv({ PAYMENTS_MODE: 'stripe_test', STRIPE_SECRET_KEY_TEST: 'rk_test_x' }, async () => {
    // The test key is used for a test-mode call, never anything else.
    await withStripe(happyStripe, async (calls) => {
      const r = await mintOnboardingLink('acct_t', 'https://r', 'https://ret', 'stripe_test');
      assert(r.ok && calls.length > 0 && calls.every((c) => c.auth === 'Bearer rk_test_x'), 'mintOnboardingLink(stripe_test) uses the test key');
      const before = calls.length;
      const live = await mintOnboardingLink('acct_t', 'https://r', 'https://ret', 'stripe_live');
      assert(!live.ok && calls.length === before, 'mintOnboardingLink(stripe_live) without a live key makes no call');
    });
  });
}

async function section3TestApprovalRefusedInLive() {
  console.log('\n3. a payment approved in Test is refused after the switch to Live');
  const s = makeStore();
  s.seed('platform_payment_settings', settings('stripe_live'));
  seedDeal(s, { approvedMode: 'stripe_test' });
  const before = auditActions.length;
  const out = await withEnv(LIVE_ENV, () =>
    withStripe(happyStripe, async (calls) => {
      const r = await executeAuthorizedPayment(s.sb, 'pa-1', { expectedFirmId: FIRM });
      assert(calls.length === 0, `no Stripe call is made (got ${calls.length})`);
      return r;
    })
  );
  assert(out.httpStatus === 409 && out.body.error === 'mode_mismatch', `execute → 409 mode_mismatch (got ${out.httpStatus} ${String(out.body.error)})`);
  assert(out.body.guidance === 'No money moved. Approved in Test; re-approve to pay in Live.', `operator sentence (got ${String(out.body.guidance)})`);
  const pa = s.all('payment_authorizations')[0];
  assert(pa.status === 'failed' && pa.failure_reason === 'mode_mismatch:stripe_test:stripe_live', `row failed with the mismatch reason (got ${String(pa.status)} ${String(pa.failure_reason)})`);
  assert(auditActions.slice(before).includes(MODE_MISMATCH_ACTION), 'payment.mode_mismatch audited');
  assert(MONEY_ANOMALY_AUDIT_ACTIONS.includes(MODE_MISMATCH_ACTION), 'payment.mode_mismatch is in the /anomalies money lane');
  const refusal = retryRefusal(pa as never);
  assert(refusal === 'mode_mismatch', `retry refused (got ${String(refusal)})`);
  assert(!legAccountsForPayment(pa as never), 'the refused leg no longer accounts for the payment: it can be set up again');

  // A retry click on it changes nothing.
  const retry = await withEnv(LIVE_ENV, () => executeAuthorizedPayment(s.sb, 'pa-1', { expectedFirmId: FIRM }));
  assert(retry.httpStatus === 409 && retry.body.reason === 'mode_mismatch', 'retry → 409 mode_mismatch');

  // Re-approval records the current mode; then it pays in Live.
  {
    const s2 = makeStore();
    s2.seed('platform_payment_settings', settings('stripe_live'));
    seedDeal(s2, { paStatus: 'pending_human_review', approvedMode: 'stripe_test' });
    (s2.all('creator_offers')[0] as Row).status = 'human_approval_required';
    const active = await withEnv(LIVE_ENV, () => resolveActivePaymentMode(s2.sb));
    const a = await approvePaymentAuthorization(
      s2.sb,
      { id: 'pa-1', callerFirmId: FIRM, actorUserId: 'u1', ...(active.pinned ? { approvedMode: active.mode } : {}) },
      { audit: async () => {} }
    );
    assert(a.ok && s2.all('payment_authorizations')[0].approved_mode === 'stripe_live', 'approval records approved_mode = stripe_live');
    const paid = await withEnv(LIVE_ENV, () =>
      withStripe(happyStripe, () => executeAuthorizedPayment(s2.sb, 'pa-1', { expectedFirmId: FIRM }))
    );
    assert(paid.httpStatus === 200 && paid.body.payment_mode === 'stripe_live', `re-approved payment pays in Live (got ${paid.httpStatus} ${JSON.stringify(paid.body)})`);
  }

  // The onboarding webhook path refuses the same way and never sends.
  {
    const s3 = makeStore();
    s3.seed('platform_payment_settings', settings('stripe_live'));
    seedDeal(s3, { approvedMode: 'stripe_test' });
    const payouts: StripeTransferInput[] = [];
    const audits: string[] = [];
    const deps: OnboardingPayoutDeps = {
      audit: async (e) => {
        audits.push(e.action);
      },
      alertOnce: () => {},
      executePayout: async (input) => {
        payouts.push(input);
        return { ok: true, provider_id: 'tr', dry_run: false, raw_status: 'paid', settled: true, mode: 'stripe_live' } as StripeTransferResult;
      },
      capGate: async () => ({ allowed: true, artistName: 'A', senderName: 'L' }) as never,
      sendPromoMaterials: async () => {},
      paymentMode: () => 'stripe_live',
      pinMode: true,
    };
    const r = await payOnboardedAuthorization(
      s3.sb,
      { id: 'pa-1', firm_id: FIRM, campaign_id: CAMPAIGN, amount_usd: 100, creator_offer_id: 'offer-1', leg: 'full', influencer_id: 'inf-1' },
      'acct_test1',
      deps
    );
    assert(r.outcome === 'mode_mismatch' && payouts.length === 0, `webhook path: mode_mismatch, no payout (got ${r.outcome}, ${payouts.length})`);
    assert(audits.includes(MODE_MISMATCH_ACTION), 'webhook path audits payment.mode_mismatch');
    // Same row approved in Live → the webhook pays it, in Live.
    const s4 = makeStore();
    s4.seed('platform_payment_settings', settings('stripe_live'));
    seedDeal(s4, { approvedMode: 'stripe_live' });
    const ok = await payOnboardedAuthorization(
      s4.sb,
      { id: 'pa-1', firm_id: FIRM, campaign_id: CAMPAIGN, amount_usd: 100, creator_offer_id: 'offer-1', leg: 'full', influencer_id: 'inf-1' },
      'acct_live1',
      deps
    );
    assert(ok.outcome === 'paid' && payouts[0]?.mode === 'stripe_live', 'a Live approval pays on the webhook path with mode stripe_live');
  }
}

async function section4TestAccountNeverWithLiveKey() {
  console.log('\n4. a Test connected account is never used with the Live key');
  const s = makeStore();
  s.seed('platform_payment_settings', settings('stripe_live'));
  seedDeal(s, { approvedMode: 'stripe_live', acct: 'acct_test1', acctMode: 'stripe_test' });
  const { out, calls } = await withEnv(LIVE_ENV, () =>
    withStripe(happyStripe, async (calls) => ({ out: await executeAuthorizedPayment(s.sb, 'pa-1', { expectedFirmId: FIRM }), calls }))
  );
  assert(out.httpStatus === 200 && out.body.ok === true, `paid (got ${out.httpStatus} ${JSON.stringify(out.body)})`);
  assert(!calls.some((c) => c.url.includes('acct_test1')), 'no Stripe call names the Test account');
  assert(calls.every((c) => c.auth === 'Bearer rk_live_dummy'), 'every call used the live key');
  assert(calls.some((c) => c.method === 'POST' && c.url.endsWith('/v1/accounts')), 'a fresh Live account was created');
  const inf = s.all('influencers')[0];
  assert(inf.stripe_connect_account_id === 'acct_live_new' && inf.stripe_connect_account_mode === 'stripe_live', 'the new account is stored with its mode');

  // Same mode → the stored account is reused, not recreated.
  const s2 = makeStore();
  s2.seed('platform_payment_settings', settings('stripe_live'));
  seedDeal(s2, { approvedMode: 'stripe_live', acct: 'acct_live_old', acctMode: 'stripe_live' });
  const calls2 = await withEnv(LIVE_ENV, () =>
    withStripe(happyStripe, async (c) => {
      await executeAuthorizedPayment(s2.sb, 'pa-1', { expectedFirmId: FIRM });
      return c;
    })
  );
  assert(!calls2.some((c) => c.method === 'POST' && c.url.endsWith('/v1/accounts')) && calls2.some((c) => c.url.includes('acct_live_old')), 'a same-mode account is reused');
}

function sign(body: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

async function section5Webhook() {
  console.log('\n5. webhook: the secret decides the mode, livemode must agree');
  const LIVE_SECRET = 'whsec_live_1';
  const TEST_SECRET = 'whsec_test_1';
  const env: EnvPatch = { STRIPE_WEBHOOK_SECRETS_TEST: `${TEST_SECRET}, whsec_test_old`, STRIPE_WEBHOOK_SECRETS_LIVE: LIVE_SECRET };
  await withEnv(env, () => {
    const liveFalse = JSON.stringify({ id: 'evt_1', type: 'account.updated', livemode: false });
    const r1 = authenticateStripeWebhook(liveFalse, sign(liveFalse, LIVE_SECRET));
    assert(!r1.ok && r1.status === 400 && r1.error === 'livemode_mismatch', `live secret + livemode:false rejected (got ${JSON.stringify(r1)})`);
    const liveTrue = JSON.stringify({ id: 'evt_2', type: 'account.updated', livemode: true });
    const r2 = authenticateStripeWebhook(liveTrue, sign(liveTrue, LIVE_SECRET));
    assert(r2.ok && r2.mode === 'stripe_live', 'live secret + livemode:true → stripe_live');
    const r3 = authenticateStripeWebhook(liveTrue, sign(liveTrue, TEST_SECRET));
    assert(!r3.ok && r3.error === 'livemode_mismatch', 'test secret + livemode:true rejected');
    const testEvt = JSON.stringify({ id: 'evt_3', type: 'payout.failed', livemode: false });
    const r4 = authenticateStripeWebhook(testEvt, sign(testEvt, 'whsec_test_old'));
    assert(r4.ok && r4.mode === 'stripe_test', 'any secret in the comma-separated list verifies');
    const noLivemode = JSON.stringify({ id: 'evt_4', type: 'payout.failed' });
    const r5 = authenticateStripeWebhook(noLivemode, sign(noLivemode, TEST_SECRET));
    assert(!r5.ok && r5.error === 'livemode_mismatch', 'an event without livemode is rejected');
    const r6 = authenticateStripeWebhook(testEvt, sign(testEvt, 'whsec_unknown'));
    assert(!r6.ok && r6.error === 'invalid_signature', 'an unknown secret is rejected');
    const r7 = authenticateStripeWebhook(testEvt, sign(testEvt, TEST_SECRET, Math.floor(Date.now() / 1000) - 600));
    assert(!r7.ok && r7.reason === 'timestamp outside tolerance', 'replay tolerance kept');
  });
  await withEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_legacy' }, () => {
    const evt = JSON.stringify({ id: 'evt_5', livemode: false });
    const r = authenticateStripeWebhook(evt, sign(evt, 'whsec_legacy'));
    assert(r.ok && r.mode === 'stripe_test', 'legacy STRIPE_WEBHOOK_SECRET counts as Test');
  });
  await withEnv({ STRIPE_WEBHOOK_SECRETS_TEST: 'whsec_same', STRIPE_WEBHOOK_SECRETS_LIVE: 'whsec_same' }, () => {
    const evt = JSON.stringify({ id: 'evt_6', livemode: true });
    const r = authenticateStripeWebhook(evt, sign(evt, 'whsec_same'));
    assert(!r.ok && r.status === 400, 'a secret configured for both modes is refused');
  });
  await withEnv({}, () => {
    const r = authenticateStripeWebhook('{}', 't=1,v1=x');
    assert(!r.ok && r.status === 500 && r.error === 'webhook_not_configured', 'no secret configured → 500, fail closed');
  });
  // Handlers only touch rows of the event's mode.
  {
    const s = makeStore();
    s.seed('payment_authorizations', { id: 'pa-t', status: 'completed', payment_provider_id: 'tr_1', payment_mode: 'stripe_test', amount_usd: 100 });
    const hooks = { audit: async () => {}, alertOnce: () => {} };
    const live = await handleTransferReversed(s.sb, { transferId: 'tr_1', amountMinor: 10000, amountReversedMinor: 10000, reversed: true, eventId: 'e', mode: 'stripe_live' }, hooks);
    assert(!live.handled && live.reason === 'unknown_transfer' && s.all('payment_authorizations')[0].status === 'completed', 'a Live reversal never touches a Test payment');
    const test = await handleTransferReversed(s.sb, { transferId: 'tr_1', amountMinor: 10000, amountReversedMinor: 10000, reversed: true, eventId: 'e', mode: 'stripe_test' }, hooks);
    assert(test.handled, 'a Test reversal reaches the Test payment');
  }
  const route = read('app/api/webhooks/stripe/route.ts');
  assert(!route.includes('process.env.'), 'the webhook route reads no env (secrets live in stripe-isolated)');
  assert(/\.eq\('approved_mode', eventMode\)/.test(route), 'account.updated lookup is scoped to the event mode');
  assert(/stripe_connect_account_mode', eventMode/.test(route), 'account.updated lookup requires a Connect account of the event mode');
  assert(/pinMode: active\.pinned/.test(route) && /paymentMode: \(\) => active\.mode/.test(route), 'onboarding payout pays in the active mode, pinned');
  assert(/mode: eventMode/.test(route) && /connectAccountMode: eventMode/.test(route), 'reversal and bank-failure handlers are scoped to the event mode');
}

/** Readiness deps where every item passes; override one to break it. */
function greenDeps(over: Partial<ReadinessDeps> = {}): ReadinessDeps {
  return {
    keyStatus: (m) =>
      m === 'stripe_live'
        ? { present: true, usable: true, source: 'explicit', kind: 'restricted' }
        : { present: true, usable: true, source: 'explicit', kind: 'secret' },
    liveAllowed: () => true,
    webhookSecretStatus: () => ({ count: 1, all_whsec: true }),
    probeAccount: async () => ({ ok: true, id: 'acct_platform', display_name: 'Example Records' }),
    probeBalance: async () => ({ ok: true, available_usd: 5000, pending_usd: 10, livemode: true }),
    probeConnect: async () => ({ ok: true }),
    listWebhookEndpoints: async () => ({
      ok: true,
      endpoints: [
        { id: 'we_1', url: 'https://app.example.com/api/webhooks/stripe', status: 'enabled', enabled_events: ['account.updated', 'transfer.reversed', 'payout.failed'] },
      ],
    }),
    webhookUrl: () => 'https://app.example.com/api/webhooks/stripe',
    ...over,
  };
}

function readyStore(): ReturnType<typeof makeStore> {
  const s = makeStore();
  s.seed('platform_payment_settings', settings('stripe_test'));
  s.seed('firms', { id: FIRM, monthly_spend_cap_usd: 1000 });
  return s;
}

const OPERATOR = { user: { id: 'u_op', email: 'operator.personal@example.com' } };
const LABEL = { user: { id: 'u_label', email: 'owner@examplerecords.example' } };

async function section6Checklist() {
  console.log('\n6. readiness checklist: every failing item blocks the switch');
  await withEnv({ ...LIVE_ENV }, async () => {
    const green = await readPaymentsStatus(readyStore().sb, greenDeps());
    assert(green.ready, `all green → ready (failing: ${green.checklist.filter((c) => !c.ok).map((c) => c.id).join(',')})`);
    assert(green.account?.id === 'acct_platform' && green.balance?.available_usd === 5000, 'status carries account and balance');
    assert(green.balance_needed_usd === 1000, 'balance must cover max(platform cap, approved Live total)');
    const creation = green.checklist.find((c) => c.id === 'account_creation');
    assert(!!creation && creation.ok && creation.unknown === true, 'connected-account creation is unknown until the first live payout, and does not block');

    const cases: [string, ReadinessDeps, ((s: ReturnType<typeof makeStore>) => void)?][] = [
      ['ceiling', greenDeps({ liveAllowed: () => false })],
      ['live_key', greenDeps({ keyStatus: () => ({ present: false, usable: false, source: null, kind: null }) })],
      ['account', greenDeps({ probeAccount: async () => ({ ok: false, error: 'Invalid API Key', http_status: 401 }) })],
      [
        'connect',
        greenDeps({
          probeConnect: async () => ({
            ok: false,
            error: 'Only Stripe Connect platforms can work with other accounts.',
            reason: 'stripe_connect_not_enabled',
            guidance: 'x',
          }),
        }),
      ],
      [
        'webhook_endpoint',
        greenDeps({
          listWebhookEndpoints: async () => ({
            ok: true,
            endpoints: [{ id: 'we_1', url: 'https://app.example.com/api/webhooks/stripe', status: 'enabled', enabled_events: ['account.updated'] }],
          }),
        }),
      ],
      ['webhook_secret', greenDeps({ webhookSecretStatus: () => ({ count: 0, all_whsec: false }) })],
      ['balance', greenDeps({ probeBalance: async () => ({ ok: true, available_usd: 999.99, pending_usd: 0, livemode: true }) })],
      [
        'no_test_rows',
        greenDeps(),
        (s) => s.seed('payment_authorizations', { id: 'pa-test', status: 'approved', approved_mode: 'stripe_test', payment_mode: 'paper', amount_usd: 50 }),
      ],
      [
        'account_creation',
        greenDeps(),
        (s) =>
          s.seed('audit_log', {
            action: 'payment.failed',
            occurred_at: '2026-10-01T12:00:00Z',
            metadata: { payment_mode: 'stripe_live', error: 'Stripe no longer recommends Accounts v1 for new Connect integrations.', reason: 'stripe_invalid_request' },
          }),
      ],
    ];
    for (const [id, deps, seed] of cases) {
      const s = readyStore();
      seed?.(s);
      const status = await readPaymentsStatus(s.sb, deps);
      const it = status.checklist.find((c) => c.id === id);
      assert(!status.ready && !!it && !it.ok && !!it.fix, `${id}: fails with a fix line, not ready`);
      const out = await switchPaymentsMode(s.sb, { session: OPERATOR, target: 'stripe_live', confirmation: SWITCH_CONFIRMATION }, { audit: async () => {}, deps });
      assert(
        out.httpStatus === 409 && Array.isArray(out.body.failing) && (out.body.failing as string[]).includes(id),
        `${id}: blocks the switch (got ${out.httpStatus} ${JSON.stringify(out.body.failing)})`
      );
      assert(s.all('platform_payment_settings')[0].stripe_mode === 'stripe_test', `${id}: setting unchanged`);
    }
    {
      const s = readyStore();
      s.seed('payment_authorizations', { id: 'pa-x', status: 'executing', approved_mode: 'stripe_live', payment_mode: 'stripe_test', amount_usd: 20 });
      const st = await readPaymentsStatus(s.sb, greenDeps());
      const it = st.checklist.find((c) => c.id === 'no_test_rows');
      assert(!!it && !it.ok && it.rows?.[0]?.id === 'pa-x', 'a Test payment still sending is listed');
    }
    {
      const s = readyStore();
      s.seed('payment_authorizations', { id: 'pa-l', status: 'approved', approved_mode: 'stripe_live', amount_usd: 4000 });
      const st = await readPaymentsStatus(s.sb, greenDeps({ probeBalance: async () => ({ ok: true, available_usd: 3000, pending_usd: 0, livemode: true }) }));
      assert(st.balance_needed_usd === 4000 && !st.checklist.find((c) => c.id === 'balance')?.ok, 'balance must cover the approved Live total when it exceeds the cap');
    }

    // Typed confirmation.
    {
      const s = readyStore();
      const wrong = await switchPaymentsMode(s.sb, { session: OPERATOR, target: 'stripe_live', confirmation: 'switch to live' }, { audit: async () => {}, deps: greenDeps() });
      assert(wrong.httpStatus === 400 && wrong.body.error === 'confirmation_required', 'wrong confirmation → 400');
      const none = await switchPaymentsMode(s.sb, { session: OPERATOR, target: 'stripe_live' }, { audit: async () => {}, deps: greenDeps() });
      assert(none.httpStatus === 400, 'missing confirmation → 400');
      const audits: { action: string; metadata?: Record<string, unknown> }[] = [];
      const ok = await switchPaymentsMode(
        s.sb,
        { session: OPERATOR, target: 'stripe_live', confirmation: SWITCH_CONFIRMATION },
        { audit: async (e) => { audits.push(e); }, deps: greenDeps(), now: () => new Date('2026-10-01T20:00:00Z') }
      );
      const row = s.all('platform_payment_settings')[0];
      assert(ok.httpStatus === 200 && row.stripe_mode === 'stripe_live', `switch to Live → 200 and the row says live (got ${ok.httpStatus})`);
      assert(row.switched_by === 'operator.personal@example.com' && row.switched_at === '2026-10-01T20:00:00.000Z', 'switched_by / switched_at recorded');
      assert(audits[0]?.action === MODE_SWITCH_ACTION && audits[0]?.metadata?.to === 'stripe_live' && audits[0]?.metadata?.from === 'stripe_test', 'payments.mode_switch audited with from/to');
      assert(ok.body.mode === 'stripe_live', 'the active mode is now stripe_live');

      // Back to Test: no checklist, no confirmation, even with everything red.
      const back = await switchPaymentsMode(
        s.sb,
        { session: OPERATOR, target: 'stripe_test' },
        { audit: async (e) => { audits.push(e); }, deps: greenDeps({ liveAllowed: () => false, probeConnect: async () => { throw new Error('must not be called'); } }) }
      );
      assert(back.httpStatus === 200 && s.all('platform_payment_settings')[0].stripe_mode === 'stripe_test', 'back to Test always works');
      assert(audits.length === 2 && audits[1].metadata?.to === 'stripe_test', 'the switch back is audited too');
    }
    {
      const s = makeStore(); // no settings row: pre-064
      const r = await switchPaymentsMode(s.sb, { session: OPERATOR, target: 'stripe_test' }, { audit: async () => {}, deps: greenDeps() });
      assert(r.httpStatus === 409 && r.body.error === 'settings_not_applied', 'pre-064 the switch refuses: nothing to write');
    }
    {
      const s = readyStore();
      const bad = await switchPaymentsMode(s.sb, { session: OPERATOR, target: 'paper' }, { audit: async () => {}, deps: greenDeps() });
      assert(bad.httpStatus === 400, 'only stripe_test / stripe_live are switch targets');
    }
  });
}

async function section7NonOperator() {
  console.log('\n7. non-operators get 403');
  await withEnv({ ...LIVE_ENV }, async () => {
    const s = readyStore();
    const audits: unknown[] = [];
    const r = await switchPaymentsMode(s.sb, { session: LABEL, target: 'stripe_live', confirmation: SWITCH_CONFIRMATION }, { audit: async (e) => { audits.push(e); }, deps: greenDeps() });
    assert(r.httpStatus === 403 && r.body.error === 'operator_only', 'label owner → 403');
    const back = await switchPaymentsMode(s.sb, { session: LABEL, target: 'stripe_test' }, { audit: async () => {}, deps: greenDeps() });
    assert(back.httpStatus === 403, 'a label cannot switch to Test either');
    const nul = await switchPaymentsMode(s.sb, { session: { user: { id: 'x', email: null } }, target: 'stripe_test' }, { audit: async () => {}, deps: greenDeps() });
    assert(nul.httpStatus === 403, 'no email (Clerk outage) → 403');
    assert(s.all('platform_payment_settings')[0].stripe_mode === 'stripe_test' && audits.length === 0, 'nothing written, nothing audited');
  });
  const modeRoute = read('app/api/payments/mode/route.ts');
  const statusRoute = read('app/api/payments/status/route.ts');
  assert(/export async function POST[\s\S]*requireOperator\(session\)/.test(modeRoute), 'POST /api/payments/mode calls requireOperator');
  assert(/requireOperator\(session\)/.test(statusRoute) && /requireSession\(\)/.test(statusRoute), 'GET /api/payments/status requires session + operator');
}

async function section8Pre064() {
  console.log('\n8. pre-064: behaviour unchanged');
  // No settings row, single legacy key, env stripe_test: today's path exactly.
  const s = makeStore();
  seedDeal(s, {}); // no approved_mode column at all
  const env: EnvPatch = { PAYMENTS_MODE: 'stripe_test', STRIPE_SECRET_KEY: 'sk_test_legacy' };
  const active = await withEnv(env, () => resolveActivePaymentMode(s.sb));
  assert(active.mode === 'stripe_test' && !active.pinned, 'no settings row → env mode, unpinned');
  const { out, calls } = await withEnv(env, () =>
    withStripe(happyStripe, async (calls) => ({ out: await executeAuthorizedPayment(s.sb, 'pa-1', { expectedFirmId: FIRM }), calls }))
  );
  assert(out.httpStatus === 200 && out.body.payment_mode === 'stripe_test', `pays as before (got ${out.httpStatus} ${JSON.stringify(out.body)})`);
  assert(calls.length > 0 && calls.every((c) => c.auth === 'Bearer sk_test_legacy'), 'with the legacy STRIPE_SECRET_KEY');
  const inf = s.all('influencers')[0];
  assert(inf.stripe_connect_account_id === 'acct_live_new' && inf.stripe_connect_account_mode == null, 'no mode column written pre-064');
  await withEnv({ PAYMENTS_MODE: 'stripe_live', STRIPE_SECRET_KEY: 'sk_test_rotated' }, () => {
    assert(resolvePaymentMode() === 'paper', 'stripe_live with only a test key still falls back to paper');
  });
  await withEnv({ PAYMENTS_MODE: 'stripe_test', STRIPE_SECRET_KEY: 'sk_live_wrong' }, () => {
    assert(resolvePaymentMode() === 'paper', 'stripe_test with only a live key still falls back to paper');
  });
  await withEnv({ PAYMENTS_MODE: 'stripe_live', STRIPE_SECRET_KEY: 'sk_live_legacy' }, () => {
    assert(resolvePaymentMode() === 'stripe_live', 'stripe_live with a legacy live key resolves as before');
  });
  // Approvals do not write approved_mode pre-064 (the column does not exist).
  {
    const s2 = makeStore();
    seedDeal(s2, { paStatus: 'pending_human_review' });
    (s2.all('creator_offers')[0] as Row).status = 'human_approval_required';
    await approvePaymentAuthorization(s2.sb, { id: 'pa-1', callerFirmId: FIRM, actorUserId: 'u1' }, { audit: async () => {} });
    assert(!('approved_mode' in s2.all('payment_authorizations')[0]), 'approval without a mode writes no approved_mode');
  }
}

async function section9Misc() {
  console.log('\n9. Accounts v1 mapping, header chip, static pins');
  const v1 = mapStripeError(
    {
      type: 'invalid_request_error',
      message:
        'Stripe no longer recommends Accounts v1 for new Connect integrations. To continue, enable Accounts v1 support in the Dashboard: https://dashboard.stripe.com/settings/developers/api-policies/feat_accounts_v1_support',
    },
    undefined,
    400
  );
  assert(v1.reason === 'stripe_accounts_v1_disabled', `Accounts v1 refusal mapped (got ${v1.reason})`);
  assert(v1.guidance.includes('Accounts v1 support turned on') && v1.guidance.includes('feat_accounts_v1_support'), 'guidance names the setting and links it');
  assert(!/deal amount/.test(v1.guidance), 'no longer sends the operator to check the deal amount');
  assert(mapStripeError({ type: 'invalid_request_error', message: 'Amount must be at least 50 cents' }).reason === 'stripe_invalid_request', 'other invalid requests unchanged');

  assert(paymentModeChip('paper').label === 'Paper money', 'chip: paper');
  assert(paymentModeChip('stripe_test').label === 'Stripe test' && paymentModeChip('stripe_test').tone === 'test', 'chip: stripe test');
  assert(paymentModeChip('stripe_live').label === 'LIVE' && paymentModeChip('stripe_live').tone === 'live', 'chip: LIVE in danger tone');
  assert(paymentModeChip('paypal_live').tone === 'live', 'chip: PayPal live is also danger');
  const shell = read('components/AppShell.tsx');
  assert(/<OperatorOnly>\s*<PaymentModeChip/.test(shell) && !shell.includes('PaperMoneyChip'), 'AppShell renders the real-mode chip, operator only');
  const chip = read('components/PaymentModeChip.tsx');
  assert(chip.includes('/api/payments/mode') && !chip.includes('/api/payments/status'), 'the chip reads the resolved mode only (no Stripe call)');
  const modeRoute = read('app/api/payments/mode/route.ts');
  const getBody = modeRoute.slice(modeRoute.indexOf('export async function GET'), modeRoute.indexOf('export async function POST'));
  assert(getBody.includes('resolveActivePaymentMode') && !/probe|listStripeWebhookEndpoints/.test(getBody), 'GET /api/payments/mode is a DB read, no Stripe probe');

  // Money paths pay in the ACTIVE mode, never the bare env ceiling.
  for (const f of ['lib/execute-payment.ts', 'lib/payment-reclaim.ts', 'lib/payment-reconcile.ts', 'app/api/webhooks/stripe/route.ts', 'app/api/payout/onboard/[pa_id]/route.ts']) {
    assert(!/resolvePaymentMode\(\)/.test(code(f)), `${f} does not call the env-only resolvePaymentMode()`);
  }
  const exec = read('lib/execute-payment.ts');
  assert(/executePayout\(\{\s*mode,/.test(exec), 'execute-payment passes the mode to executePayout');
  assert(/executePayout\(\{\s*mode: claimMode/.test(read('lib/onboarding-payout.ts')), 'onboarding-payout passes the claim mode to executePayout');
  assert(/approvedMode: active\.mode/.test(read('app/api/payments/[id]/approve/route.ts')), 'the approve route records the active mode');

  const settings = read('app/settings/page.tsx');
  const card = read('components/PaymentsCard.tsx');
  assert(settings.includes('<PaymentsCard') && !settings.includes('Managed for you —'), 'settings renders the Payments card');
  assert(!card.includes('—'), 'Payments card copy carries no em dashes');
}

async function main() {
  await section1Resolution();
  await section2Keys();
  await section3TestApprovalRefusedInLive();
  await section4TestAccountNeverWithLiveKey();
  await section5Webhook();
  await section6Checklist();
  await section7NonOperator();
  await section8Pre064();
  await section9Misc();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
