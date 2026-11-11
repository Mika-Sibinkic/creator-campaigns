// tests/payout-onboarding-dedupe.test.ts
//
// WHAT THIS GUARDS: at most ONE live payout-setup email per payment leg.
//
// The race: the operator clicks "Retry payment" (payment.retry_claimed). Stripe
// answers "not onboarded", so execute-payment queues a payout_onboarding
// email and puts the row back to 'approved'. The same DealRow button then
// re-renders in place as "Re-send payout setup email"; a click on it seconds
// later (no retry_claimed, because the row is no longer 'failed') runs execute
// again. Without the guard that queues a SECOND email, and the creator gets
// two identical emails.
//
// The rule now:
//   1. An automatic path (approve auto-execute, Execute, Retry) queues the
//      email only if this leg has none queued or sent.
//   2. "Re-send payout setup email" is the only path that may add another, and
//      only when it says so explicitly (resend_onboarding_email) AND the
//      previous one has already gone out. A re-send while one is still queued
//      is a no-op: that one is about to be sent.
//   3. The email is queued while the row is still 'executing' (claimed), so a
//      concurrent execute cannot claim in between and queue its own.
//
// Hermetic: in-memory store, dummy env, fetch stubbed for api.stripe.com.
//
// Run: npx tsx tests/payout-onboarding-dedupe.test.ts

import './negotiation-harness/setup-env'; // FIRST — dummy env
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeStore, type Row } from './negotiation-harness/store';
import { executeAuthorizedPayment } from '../src/lib/execute-payment';
import {
  decideOnboardingEmail,
  onboardPathFor,
  PAYOUT_ONBOARDING_MESSAGE_TYPE,
} from '../src/lib/payout-email';

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

const FIRM = 'firm-1';
const CAMPAIGN = 'camp-1';
const ENV: Record<string, string> = { PAYMENTS_MODE: 'stripe_test', STRIPE_SECRET_KEY_TEST: 'sk_test_dummy' };

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ['PAYMENTS_MODE', 'STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY_TEST', 'STRIPE_SECRET_KEY_LIVE']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, ENV);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Stripe with a connected account that has NOT finished onboarding. */
const harnessFetch = globalThis.fetch;
async function withUnonboardedStripe<T>(fn: () => Promise<T>): Promise<T> {
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (!u.startsWith('https://api.stripe.com/')) return harnessFetch(url as string, init as RequestInit);
    const method = ((init ?? {}) as { method?: string }).method ?? 'GET';
    let json: unknown = { error: { message: 'unexpected call' } };
    let status = 404;
    if (method === 'GET' && u.includes('/v1/accounts/')) [status, json] = [200, { id: 'acct_1', payouts_enabled: false }];
    if (method === 'POST' && u.endsWith('/v1/account_links')) [status, json] = [200, { url: 'https://connect.stripe.com/setup/x' }];
    // Accounts v2 (merged after this suite was written): readiness is read
    // from the recipient configuration first; transfers not yet active.
    if (method === 'GET' && u.includes('/v2/core/accounts/'))
      [status, json] = [
        200,
        { id: 'acct_1', object: 'v2.core.account', configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: 'pending' } } } } } },
      ];
    if (method === 'POST' && u.endsWith('/v2/core/account_links')) [status, json] = [200, { url: 'https://connect.stripe.com/setup/x' }];
    return { ok: status === 200, status, json: async () => json } as Response;
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = harnessFetch;
  }
}

/** The incident's shape: a failed leg, an existing Test account, not onboarded. */
function seed(store: ReturnType<typeof makeStore>, paStatus: 'failed' | 'approved' = 'failed'): Row {
  store.seed('platform_payment_settings', { id: true, stripe_mode: 'stripe_test', switched_by: null, switched_at: null });
  store.seed('campaigns', { id: CAMPAIGN, total_budget_usd: 10_000, artist_name: 'Ada Sample' });
  store.seed('firms', { id: FIRM, monthly_spend_cap_usd: 0, per_creator_monthly_cap_usd: 0, sender_name: 'Label' });
  store.seed('influencers', { id: 'inf-1', stripe_connect_account_id: 'acct_1', stripe_connect_account_mode: 'stripe_test' });
  store.seed('creator_offers', {
    id: 'offer-1',
    firm_id: FIRM,
    campaign_id: CAMPAIGN,
    campaign_influencer_id: 'ci-1',
    status: 'approved',
    agreed_amount_usd: 25,
    ceiling_usd: 50,
    deposit_paid_usd: null,
    balance_paid_usd: null,
    payout_status: null,
    paid_at: null,
  });
  return store.seed('payment_authorizations', {
    id: 'pa-1',
    firm_id: FIRM,
    campaign_id: CAMPAIGN,
    creator_offer_id: 'offer-1',
    amount_usd: 25,
    status: paStatus,
    leg: 'full',
    approved_mode: 'stripe_test',
    human_approved_at: '2026-01-15T12:00:30.000Z',
    human_approved_by_user_id: 'user_approver',
    payment_provider_id: null,
    failure_reason: paStatus === 'failed' ? 'No money moved — Stripe rejected the payout request as invalid.' : null,
    executing_at: null,
    payment_mode: 'stripe_test',
    created_at: '2026-01-15T12:00:00.000Z',
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
          username: 'marlo_example',
          stripe_connect_account_id: 'acct_1',
          stripe_connect_account_mode: 'stripe_test',
        },
      },
    },
  });
}

const onboardingRows = (store: ReturnType<typeof makeStore>) =>
  store.all('outreach_messages').filter((m) => m.message_type === PAYOUT_ONBOARDING_MESSAGE_TYPE);

async function section1Incident() {
  console.log('\n1. the 2026-10-01 incident: Retry, then the morphed button, before dispatch');
  const s = makeStore();
  seed(s, 'failed');
  await withEnv(() =>
    withUnonboardedStripe(async () => {
      const retry = await executeAuthorizedPayment(s.sb, 'pa-1', { expectedFirmId: FIRM });
      assert(retry.httpStatus === 200 && retry.body.needs_onboarding === true, `retry → needs onboarding (got ${retry.httpStatus} ${JSON.stringify(retry.body)})`);
      assert(onboardingRows(s).length === 1, `retry queues one email (got ${onboardingRows(s).length})`);
      assert(s.all('payment_authorizations')[0].status === 'approved', 'row back to approved, awaiting onboarding');

      // Nine seconds later, "Re-send payout setup email" — the first is still queued.
      const resend = await executeAuthorizedPayment(s.sb, 'pa-1', { expectedFirmId: FIRM, resendOnboardingEmail: true });
      assert(resend.httpStatus === 200 && resend.body.needs_onboarding === true, 'the re-send still answers awaiting onboarding');
      assert(onboardingRows(s).length === 1, `re-send while one is queued adds nothing (got ${onboardingRows(s).length})`);
      assert(resend.body.onboarding_email === 'already_queued', `body says already_queued (got ${String(resend.body.onboarding_email)})`);

      // A plain Execute (the approve auto-execute shape) adds nothing either.
      await executeAuthorizedPayment(s.sb, 'pa-1', { expectedFirmId: FIRM });
      assert(onboardingRows(s).length === 1, `automatic execute while queued adds nothing (got ${onboardingRows(s).length})`);
    })
  );
}

async function section2AfterSend() {
  console.log('\n2. after the email went out: only an explicit re-send adds one');
  const s = makeStore();
  seed(s, 'approved');
  await withEnv(() =>
    withUnonboardedStripe(async () => {
      await executeAuthorizedPayment(s.sb, 'pa-1', { expectedFirmId: FIRM });
      assert(onboardingRows(s).length === 1, 'first execute queues one');
      onboardingRows(s)[0].status = 'sent';

      const auto = await executeAuthorizedPayment(s.sb, 'pa-1', { expectedFirmId: FIRM });
      assert(onboardingRows(s).length === 1, `automatic execute after send adds nothing (got ${onboardingRows(s).length})`);
      assert(auto.body.onboarding_email === 'already_sent', `body says already_sent (got ${String(auto.body.onboarding_email)})`);

      const explicit = await executeAuthorizedPayment(s.sb, 'pa-1', { expectedFirmId: FIRM, resendOnboardingEmail: true });
      const rows = onboardingRows(s);
      assert(rows.length === 2 && rows.filter((r) => r.status === 'queued').length === 1, `explicit re-send queues exactly one more (got ${rows.map((r) => r.status).join(',')})`);
      assert(explicit.body.onboarding_email === 'queued', `body says queued (got ${String(explicit.body.onboarding_email)})`);

      await executeAuthorizedPayment(s.sb, 'pa-1', { expectedFirmId: FIRM, resendOnboardingEmail: true });
      assert(onboardingRows(s).length === 2, `a second explicit re-send before dispatch adds nothing (got ${onboardingRows(s).length})`);
    })
  );
}

async function section3Ordering() {
  console.log('\n3. the email is queued while the claim is still held');
  const s = makeStore();
  const pa = seed(s, 'approved');
  const statusAtInsert: string[] = [];
  const sb = new Proxy(s.sb, {
    get(target, key) {
      if (key !== 'from') return (target as unknown as Record<string | symbol, unknown>)[key];
      return (table: string) => {
        const q = target.from(table) as unknown as { insert: (p: unknown) => unknown };
        if (table === 'outreach_messages') {
          const insert = q.insert.bind(q);
          q.insert = (p: unknown) => {
            statusAtInsert.push(String(pa.status));
            return insert(p);
          };
        }
        return q;
      };
    },
  });
  await withEnv(() => withUnonboardedStripe(() => executeAuthorizedPayment(sb as typeof s.sb, 'pa-1', { expectedFirmId: FIRM })));
  assert(statusAtInsert.length === 1 && statusAtInsert[0] === 'executing', `inserted under the executing claim (got ${statusAtInsert.join(',') || 'no insert'})`);
  assert(pa.status === 'approved', 'released to approved afterwards');
}

function section4Decision() {
  console.log('\n4. decideOnboardingEmail: per leg, by status');
  const mine = (status: string | null) => ({ status, body: `Set up here: https://app.test${onboardPathFor('pa-1')}\n\nThanks` });
  const other = (status: string | null) => ({ status, body: `Set up here: https://app.test${onboardPathFor('pa-10')}\n\nThanks` });
  assert(decideOnboardingEmail([], 'pa-1', false) === 'queued', 'nothing yet → queue');
  assert(decideOnboardingEmail([mine('queued')], 'pa-1', false) === 'already_queued', 'queued → skip');
  assert(decideOnboardingEmail([mine('draft')], 'pa-1', true) === 'already_queued', 'draft counts as pending, even on explicit re-send');
  assert(decideOnboardingEmail([mine(null)], 'pa-1', true) === 'already_queued', 'null status counts as pending');
  assert(decideOnboardingEmail([mine('sent')], 'pa-1', false) === 'already_sent', 'sent + automatic → skip');
  assert(decideOnboardingEmail([mine('sent')], 'pa-1', true) === 'queued', 'sent + explicit → queue');
  assert(decideOnboardingEmail([mine('sent'), mine('queued')], 'pa-1', true) === 'already_queued', 'sent + queued + explicit → skip');
  for (const t of ['failed', 'superseded', 'window_closed']) {
    assert(decideOnboardingEmail([mine(t)], 'pa-1', false) === 'queued', `${t} never went out → queue`);
  }
  assert(decideOnboardingEmail([other('queued'), other('sent')], 'pa-1', false) === 'queued', "another leg's email (pa-10) does not count for pa-1");
}

function section5Wiring() {
  console.log('\n5. wiring: only the Re-send button asks for an explicit re-send');
  const route = read('app/api/payments/[id]/execute/route.ts');
  assert(/resendOnboardingEmail/.test(route) && /resend_onboarding_email/.test(route), 'execute route forwards resend_onboarding_email');
  const approve = read('app/api/payments/[id]/approve/route.ts');
  assert(!/resendOnboardingEmail/.test(approve), 'approve auto-execute never asks for a re-send');
  const row = read('app/campaigns/[id]/deals/DealRow.tsx');
  assert(/resend_onboarding_email:\s*awaitingOnboarding\s*&&\s*!a\.retry/.test(row), 'DealRow sends the flag only from the Re-send label');
  const exec = read('lib/execute-payment.ts');
  const insertAt = exec.indexOf("from('outreach_messages').insert");
  const releaseAt = exec.indexOf(".update({ status: 'approved', payment_mode: mode }");
  assert(insertAt > 0 && releaseAt > insertAt, 'execute-payment queues the email before releasing the claim');
}

async function main() {
  await section1Incident();
  await section2AfterSend();
  await section3Ordering();
  section4Decision();
  section5Wiring();
  console.log(`\npayout-onboarding-dedupe: ${passed} passed, ${failed} failed`);
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
