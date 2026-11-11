// tests/paypal-payout.test.ts
//
// Unit tests for src/lib/paypal-isolated.ts against a stubbed globalThis.fetch —
// NO network. Asserts: OAuth + payout request shape, email/idempotency guards,
// error legibility, webhook cert-host defense, and verify-signature pass/fail.
//
// Run: npx tsx tests/paypal-payout.test.ts

import {
  createPaypalPayout,
  verifyPaypalWebhook,
  isPlausibleEmail,
  isPaypalCertHost,
} from '../src/lib/paypal-isolated';

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
  headers: Record<string, string>;
  body: string;
}
let calls: FetchCall[] = [];
const realFetch = globalThis.fetch;

function stubFetch(handler: (call: FetchCall) => { status: number; json: unknown }) {
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const i = (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string };
    const call: FetchCall = {
      url: String(url),
      method: i.method ?? 'GET',
      headers: (i.headers ?? {}) as Record<string, string>,
      body: typeof i.body === 'string' ? i.body : '',
    };
    calls.push(call);
    const { status, json } = handler(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    } as Response;
  }) as typeof fetch;
}

function reset() {
  calls = [];
  process.env.PAYPAL_CLIENT_ID = 'test_client';
  process.env.PAYPAL_CLIENT_SECRET = 'test_secret';
  process.env.PAYPAL_WEBHOOK_ID = 'WH-TEST-123';
}

async function run() {
  // ── helpers ──
  assert(isPlausibleEmail('creator@example.com'), 'valid email accepted');
  assert(!isPlausibleEmail('not-an-email'), 'no-@ rejected');
  assert(!isPlausibleEmail('a@b'), 'no-TLD rejected');
  assert(!isPlausibleEmail(''), 'empty rejected');
  assert(isPaypalCertHost('https://api.paypal.com/cert.pem'), 'paypal.com cert host ok');
  assert(isPaypalCertHost('https://api.sandbox.paypal.com/x'), 'sandbox.paypal.com cert host ok');
  assert(!isPaypalCertHost('https://evil.com/cert.pem'), 'non-paypal cert host rejected');
  assert(!isPaypalCertHost('https://paypal.com.evil.com/x'), 'lookalike cert host rejected');
  assert(!isPaypalCertHost('http://api.paypal.com/x'), 'non-https cert host rejected');

  // ── invalid receiver short-circuits BEFORE any network ──
  reset();
  stubFetch(() => ({ status: 200, json: {} }));
  const bad = await createPaypalPayout({
    sandbox: true, amount_usd: 100, receiver_email: 'nope', note: 'n',
    email_subject: 's', email_message: 'm', idempotency_key: 'pa-1',
  });
  assert(!bad.ok && bad.error === 'invalid_receiver_email', 'bad email rejected pre-flight');
  assert(calls.length === 0, 'no fetch on bad email');

  // ── happy path: OAuth then payout, correct shape ──
  reset();
  stubFetch((call) => {
    if (call.url.endsWith('/v1/oauth2/token')) return { status: 200, json: { access_token: 'tok_abc', expires_in: 3200 } };
    if (call.url.endsWith('/v1/payments/payouts')) return { status: 201, json: { batch_header: { payout_batch_id: 'BATCH-1', batch_status: 'PENDING' } } };
    return { status: 404, json: {} };
  });
  const ok = await createPaypalPayout({
    sandbox: true, amount_usd: 185.5, receiver_email: 'creator@example.com', note: 'deal',
    email_subject: 'You have money', email_message: 'body', idempotency_key: 'pa-xyz',
  });
  assert(ok.ok && ok.batch_id === 'BATCH-1' && ok.batch_status === 'PENDING', 'payout returns batch id + status');
  const tokenCall = calls.find((c) => c.url.endsWith('/v1/oauth2/token'))!;
  assert(tokenCall.url.startsWith('https://api-m.sandbox.paypal.com'), 'sandbox base url used');
  assert(String(tokenCall.headers['Authorization']).startsWith('Basic '), 'oauth uses basic auth');
  const payoutCall = calls.find((c) => c.url.endsWith('/v1/payments/payouts'))!;
  assert(payoutCall.headers['Authorization'] === 'Bearer tok_abc', 'payout uses bearer token');
  assert(payoutCall.headers['PayPal-Request-Id'] === 'pa-xyz', 'idempotency header = payment_authorization id');
  const parsed = JSON.parse(payoutCall.body) as {
    sender_batch_header: { sender_batch_id: string };
    items: Array<{ recipient_type: string; receiver: string; amount: { value: string; currency: string }; sender_item_id: string }>;
  };
  assert(parsed.sender_batch_header.sender_batch_id === 'pa-xyz', 'sender_batch_id = pa id');
  assert(parsed.items[0].recipient_type === 'EMAIL', 'recipient_type EMAIL');
  assert(parsed.items[0].receiver === 'creator@example.com', 'receiver email correct');
  assert(parsed.items[0].amount.value === '185.50' && parsed.items[0].amount.currency === 'USD', 'amount formatted 2dp USD');
  assert(parsed.items[0].sender_item_id === 'pa-xyz', 'sender_item_id = pa id (webhook mapping)');

  // ── live mode uses the live base ──
  reset();
  stubFetch((call) => {
    if (call.url.includes('/oauth2/token')) return { status: 200, json: { access_token: 't', expires_in: 3200 } };
    return { status: 201, json: { batch_header: { payout_batch_id: 'B2', batch_status: 'PENDING' } } };
  });
  await createPaypalPayout({
    sandbox: false, amount_usd: 50, receiver_email: 'c@example.com', note: 'n',
    email_subject: 's', email_message: 'm', idempotency_key: 'pa-2',
  });
  assert(calls[0].url.startsWith('https://api-m.paypal.com'), 'live base url used when sandbox=false');

  // ── payout API error is surfaced legibly ──
  reset();
  stubFetch((call) => {
    if (call.url.includes('/oauth2/token')) return { status: 200, json: { access_token: 't', expires_in: 3200 } };
    return { status: 400, json: { name: 'VALIDATION_ERROR', message: 'Invalid request', details: [{ description: 'receiver bad' }] } };
  });
  const err = await createPaypalPayout({
    sandbox: true, amount_usd: 10, receiver_email: 'c@example.com', note: 'n',
    email_subject: 's', email_message: 'm', idempotency_key: 'pa-3',
  });
  assert(!err.ok && /VALIDATION_ERROR/.test(err.error ?? '') && /receiver bad/.test(err.error ?? ''), 'payout error surfaced with detail');

  // ── missing credentials → clean error, no crash ──
  reset();
  delete process.env.PAYPAL_CLIENT_SECRET;
  stubFetch(() => ({ status: 200, json: {} }));
  const noCreds = await createPaypalPayout({
    sandbox: true, amount_usd: 10, receiver_email: 'c@example.com', note: 'n',
    email_subject: 's', email_message: 'm', idempotency_key: 'pa-4',
  });
  assert(!noCreds.ok && noCreds.error === 'paypal_credentials_missing', 'missing creds → clean error');

  // ── webhook verify: rejects a non-paypal cert host WITHOUT calling paypal ──
  reset();
  stubFetch((call) => {
    if (call.url.includes('/oauth2/token')) return { status: 200, json: { access_token: 't', expires_in: 3200 } };
    return { status: 200, json: { verification_status: 'SUCCESS' } };
  });
  const evilCert = await verifyPaypalWebhook(true, {
    authAlgo: 'SHA256withRSA', certUrl: 'https://evil.com/cert.pem', transmissionId: 'x',
    transmissionSig: 'sig', transmissionTime: 't',
  }, '{"id":"EVT-1"}');
  assert(evilCert.ok === true && evilCert.ok && evilCert.verified === false, 'evil cert host → not verified');
  assert(!calls.some((c) => c.url.includes('verify-webhook-signature')), 'no verify call for bad cert host');

  // ── webhook verify: SUCCESS from paypal → verified true ──
  reset();
  stubFetch((call) => {
    if (call.url.includes('/oauth2/token')) return { status: 200, json: { access_token: 't', expires_in: 3200 } };
    return { status: 200, json: { verification_status: 'SUCCESS' } };
  });
  const good = await verifyPaypalWebhook(true, {
    authAlgo: 'SHA256withRSA', certUrl: 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT', transmissionId: 'x',
    transmissionSig: 'sig', transmissionTime: 't',
  }, '{"id":"EVT-2"}');
  assert(good.ok && good.ok === true && good.verified === true, 'valid signature → verified');

  // ── webhook verify: missing webhook id → clean error (fail closed upstream) ──
  reset();
  delete process.env.PAYPAL_WEBHOOK_ID;
  const noWh = await verifyPaypalWebhook(true, {
    authAlgo: 'a', certUrl: 'https://api.paypal.com/c', transmissionId: 'x', transmissionSig: 's', transmissionTime: 't',
  }, '{}');
  assert(!noWh.ok && noWh.error === 'paypal_webhook_id_missing', 'missing webhook id → clean error');

  globalThis.fetch = realFetch;
  console.log(`paypal-payout test: ${passed}/${passed + failed} pass`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
