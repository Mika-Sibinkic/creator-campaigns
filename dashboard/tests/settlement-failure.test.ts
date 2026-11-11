// tests/settlement-failure.test.ts
//
// The async money-out failure path: refuse, never coerce, and learn about a
// transfer that did not stick.
//
// Hermetic: no env, no network, no DB, no live Stripe. `fetch` is replaced
// with a throwing stub so any accidental call fails the suite loudly. The
// in-memory store is local to this file, per the convention in
// tests/spend-caps.test.ts and tests/firm-scope.test.ts.
//
// Run: npx tsx tests/settlement-failure.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  readPayoutAmountUsd,
  refuseUnreadableAmount,
  handleTransferReversed,
  handlePayoutFailed,
  SETTLEMENT_FAILURE_REASON,
  type SettlementHooks,
} from '../src/lib/settlement-failure';

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

/** Drop comments so a source-shape assertion can't be satisfied — or tripped —
 *  by prose. `//` is only treated as a comment when it does not follow a colon,
 *  so `https://` inside a string survives.
 *
 *  Line comments go FIRST on purpose: this route's header contains the path
 *  `/api/webhooks/*`, and that stray `/*` opens a phantom block comment that
 *  swallows everything up to the next JSDoc terminator — including the
 *  signature-verification code these assertions exist to check. */
function stripComments(src: string): string {
  return src
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

// No test in this file may talk to the network.
globalThis.fetch = (async () => {
  throw new Error('network access from a hermetic test');
}) as typeof fetch;

const FIRM = 'ffffffff-1111-4111-8111-ffffffffffff';
const ACCT = 'acct_creator_1';

// ───────────────────────────────────────────────────────────────────────────
// In-memory Supabase fake
// ───────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/** Resolve 'a.b.c' against nested plain objects, the way PostgREST embedded
 *  filters read on a joined row. */
function getPath(row: Row, path: string): unknown {
  if (!path.includes('.')) return row[path];
  let cur: unknown = row;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Row)[seg];
  }
  return cur;
}

interface StoreOpts {
  /** Force a query error for this table, to exercise the retryable path. */
  errorOn?: { table: string; message: string };
}

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private mode: 'select' | 'update' = 'select';
  private patch: Row = {};
  private filters: Array<[string, unknown]> = [];
  private wantsRows = false;
  private single = false;

  constructor(
    private rows: Row[],
    private table: string,
    private opts: StoreOpts
  ) {}

  select() {
    if (this.mode !== 'update') this.mode = 'select';
    this.wantsRows = true;
    return this;
  }
  update(patch: Row) {
    this.mode = 'update';
    this.patch = patch;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }

  private matched(): Row[] {
    return this.rows.filter((r) =>
      this.filters.every(([col, val]) => getPath(r, col) === val)
    );
  }

  // Only `resolve` is implemented: this fake never rejects (query errors come
  // back as `{ data: null, error }`, the way PostgREST reports them).
  then<R1 = { data: unknown; error: unknown }, R2 = never>(
    resolve?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null
  ): PromiseLike<R1 | R2> {
    const settle = (v: { data: unknown; error: unknown }) =>
      Promise.resolve(resolve ? resolve(v) : (v as unknown as R1));

    if (this.opts.errorOn && this.opts.errorOn.table === this.table) {
      return settle({ data: null, error: { message: this.opts.errorOn.message } });
    }

    const hits = this.matched();
    if (this.mode === 'update') {
      for (const h of hits) Object.assign(h, this.patch);
    }
    if (this.single) return settle({ data: hits[0] ?? null, error: null });
    if (this.mode === 'update' && !this.wantsRows) {
      return settle({ data: null, error: null });
    }
    return settle({ data: hits, error: null });
  }
}

function makeStore(opts: StoreOpts = {}) {
  const tables: Record<string, Row[]> = {
    payment_authorizations: [],
    creator_offers: [],
  };
  const sb = {
    from(table: string) {
      tables[table] ??= [];
      return new Query(tables[table], table, opts);
    },
  } as unknown as SupabaseClient;
  return {
    sb,
    seed(table: string, row: Row) {
      (tables[table] ??= []).push(row);
      return row;
    },
    get(table: string, id: string) {
      return (tables[table] ?? []).find((r) => r.id === id);
    },
  };
}

function makeHooks() {
  const auditCalls: Array<Record<string, unknown>> = [];
  const alertCalls: Array<{ key: string; level: string; message: string }> = [];
  const hooks: SettlementHooks = {
    audit: async (entry) => {
      auditCalls.push(entry as unknown as Record<string, unknown>);
    },
    alertOnce: (key, level, message) => {
      alertCalls.push({ key, level, message });
    },
  };
  return { hooks, auditCalls, alertCalls };
}

function seedPaidDeal(store: ReturnType<typeof makeStore>, transferId: string) {
  store.seed('payment_authorizations', {
    id: 'pa-1',
    firm_id: FIRM,
    campaign_id: 'camp-1',
    creator_offer_id: 'offer-1',
    amount_usd: 150.5,
    status: 'completed',
    payment_provider_id: transferId,
    failure_reason: null,
  });
  store.seed('creator_offers', {
    id: 'offer-1',
    firm_id: FIRM,
    campaign_id: 'camp-1',
    status: 'paid',
    payout_status: 'paid',
    campaign_influencers: { influencer_id: 'ci-1', influencer: { stripe_connect_account_id: ACCT } },
  });
}

async function runCoreTests() {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. readPayoutAmountUsd — refuse, never coerce
  // ─────────────────────────────────────────────────────────────────────────
  {
    for (const [label, raw] of [
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
    ] as Array<[string, unknown]>) {
      const v = readPayoutAmountUsd(raw);
      assert(v.ok === false, `${label} amount → refused`);
      assert(v.ok === false && v.reason === 'missing_amount', `${label} → missing_amount`);
    }

    for (const [label, raw] of [
      ['zero', 0],
      ['negative', -25],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['non-numeric string', 'abc'],
      ['zero string', '0'],
    ] as Array<[string, unknown]>) {
      const v = readPayoutAmountUsd(raw);
      assert(v.ok === false, `${label} amount → refused`);
      assert(v.ok === false && v.reason === 'invalid_amount', `${label} → invalid_amount`);
    }

    const ok = readPayoutAmountUsd(150.5);
    assert(ok.ok === true && ok.amountUsd === 150.5, 'a real amount passes through EXACTLY (150.5)');
    const okStr = readPayoutAmountUsd('150.50');
    assert(okStr.ok === true && okStr.amountUsd === 150.5, 'numeric string parses to 150.5');
    const tiny = readPayoutAmountUsd(0.01);
    assert(tiny.ok === true && tiny.amountUsd === 0.01, 'one cent is a legitimate amount');

    // The regression itself: the old code turned every refusal into $0.
    assert(
      (['missing_amount', 'invalid_amount'] as const).every(
        (r) => SETTLEMENT_FAILURE_REASON[r] === 'invalid_payout_amount'
      ),
      'both refusal reasons map to the invalid_payout_amount slug'
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. refuseUnreadableAmount — fails closed, exactly once
  // ─────────────────────────────────────────────────────────────────────────
  {
    const store = makeStore();
    store.seed('payment_authorizations', {
      id: 'pa-x',
      firm_id: FIRM,
      campaign_id: 'camp-1',
      creator_offer_id: 'offer-x',
      amount_usd: null,
      status: 'executing',
      failure_reason: null,
    });
    const { hooks, auditCalls, alertCalls } = makeHooks();

    const did = await refuseUnreadableAmount(
      store.sb,
      {
        paymentAuthorizationId: 'pa-x',
        firmId: FIRM,
        campaignId: 'camp-1',
        creatorOfferId: 'offer-x',
        verdict: { ok: false, reason: 'missing_amount' },
        rawAmount: null,
      },
      hooks
    );
    assert(did === true, 'unreadable amount → refusal recorded');

    const pa = store.get('payment_authorizations', 'pa-x') as Row;
    assert(pa.status === 'failed', 'authorization moved to failed (visible on /anomalies)');
    assert(
      pa.failure_reason === 'invalid_payout_amount',
      `failure_reason is the stable slug (got ${String(pa.failure_reason)})`
    );
    assert(auditCalls.length === 1, 'exactly one audit row');
    assert(auditCalls[0].action === 'payment.failed', 'reuses the payment.failed audit action');
    assert(
      auditCalls[0].target_type === 'payment_authorization',
      'audit targets the authorization'
    );
    assert(alertCalls.length === 1 && alertCalls[0].level === 'error', 'one error-level alert');

    // Redelivery / second pass must not double-write.
    const again = await refuseUnreadableAmount(
      store.sb,
      {
        paymentAuthorizationId: 'pa-x',
        firmId: FIRM,
        campaignId: 'camp-1',
        creatorOfferId: 'offer-x',
        verdict: { ok: false, reason: 'missing_amount' },
        rawAmount: null,
      },
      hooks
    );
    assert(again === false, 'second refusal is a no-op (status no longer executing)');
    assert(auditCalls.length === 1, 'no duplicate audit row on redelivery');
    assert(alertCalls.length === 1, 'no duplicate alert on redelivery');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. transfer.reversed — the creator is not paid
  // ─────────────────────────────────────────────────────────────────────────
  {
    // No transfer id on the event.
    const store = makeStore();
    const { hooks, auditCalls } = makeHooks();
    const r = await handleTransferReversed(
      store.sb,
      { transferId: null, amountMinor: null, amountReversedMinor: null, reversed: true, eventId: 'evt_1' },
      hooks
    );
    assert(r.handled === false && r.reason === 'no_transfer_id', 'missing transfer id → no_transfer_id');
    assert(auditCalls.length === 0, 'nothing audited for an unusable event');
  }

  {
    // A transfer we have never seen — 200, no writes.
    const store = makeStore();
    const { hooks, auditCalls } = makeHooks();
    const r = await handleTransferReversed(
      store.sb,
      { transferId: 'tr_unknown', amountMinor: 1000, amountReversedMinor: 1000, reversed: true, eventId: 'evt_2' },
      hooks
    );
    assert(r.handled === false && r.reason === 'unknown_transfer', 'unknown transfer → unknown_transfer');
    assert(auditCalls.length === 0, 'unknown transfer audits nothing');
  }

  {
    // A lookup failure must be retryable, not silently swallowed.
    const store = makeStore({ errorOn: { table: 'payment_authorizations', message: 'boom' } });
    const { hooks } = makeHooks();
    const r = await handleTransferReversed(
      store.sb,
      { transferId: 'tr_1', amountMinor: 1000, amountReversedMinor: 1000, reversed: true, eventId: 'evt_3' },
      hooks
    );
    assert(r.handled === false && r.reason === 'lookup_failed', 'lookup error → lookup_failed');
    assert(
      r.handled === false && r.reason === 'lookup_failed' && r.retryable === true,
      'lookup_failed is marked retryable so the route can 503'
    );
  }

  {
    // The real thing: a full reversal.
    const store = makeStore();
    seedPaidDeal(store, 'tr_full');
    const { hooks, auditCalls, alertCalls } = makeHooks();

    const r = await handleTransferReversed(
      store.sb,
      { transferId: 'tr_full', amountMinor: 15050, amountReversedMinor: 15050, reversed: true, eventId: 'evt_4' },
      hooks
    );
    assert(r.handled === true, 'full reversal is handled');
    assert(r.handled === true && r.fullyReversed === true, 'recognised as a FULL reversal');

    const pa = store.get('payment_authorizations', 'pa-1') as Row;
    assert(pa.status === 'failed', 'authorization reverted completed → failed');
    assert(
      pa.failure_reason === 'stripe_transfer_reversed',
      `failure_reason records the reversal (got ${String(pa.failure_reason)})`
    );

    const offer = store.get('creator_offers', 'offer-1') as Row;
    assert(offer.payout_status === 'returned', 'payout_status → returned (PayPal reversal precedent)');
    // The load-bearing one: creator_offers.failed is TERMINAL in
    // negotiation.ts VALID_TRANSITIONS, so touching status would strand a
    // deal that is still legitimately retryable.
    assert(offer.status === 'paid', 'creator_offers.status is NOT moved to a terminal state');

    assert(auditCalls.length === 1 && auditCalls[0].action === 'payment.failed', 'one payment.failed audit');
    const meta = auditCalls[0].metadata as Row;
    assert(meta.transfer_id === 'tr_full', 'audit metadata carries the transfer id');
    assert(meta.stripe_event_id === 'evt_4', 'audit metadata carries the stripe event id');
    assert(meta.fully_reversed === true, 'audit metadata records full vs partial');
    assert(alertCalls.length === 1 && alertCalls[0].level === 'error', 'one error alert');
    assert(
      alertCalls[0].message.includes('fully reversed'),
      'alert copy names a full reversal'
    );

    // Redelivery is a no-op.
    const again = await handleTransferReversed(
      store.sb,
      { transferId: 'tr_full', amountMinor: 15050, amountReversedMinor: 15050, reversed: true, eventId: 'evt_4' },
      hooks
    );
    assert(again.handled === false && again.reason === 'already_recorded', 'redelivery → already_recorded');
    assert(auditCalls.length === 1, 'redelivery writes no second audit row');
    assert(alertCalls.length === 1, 'redelivery raises no second alert');
  }

  {
    // Partial reversal: `reversed` stays false, so the amounts decide.
    const store = makeStore();
    seedPaidDeal(store, 'tr_partial');
    const { hooks, alertCalls } = makeHooks();

    const r = await handleTransferReversed(
      store.sb,
      { transferId: 'tr_partial', amountMinor: 15050, amountReversedMinor: 5000, reversed: false, eventId: 'evt_5' },
      hooks
    );
    assert(r.handled === true, 'partial reversal is still handled');
    assert(r.handled === true && r.fullyReversed === false, 'partial reversal is NOT reported as full');
    assert(
      alertCalls[0].message.includes('partially reversed'),
      'alert copy names a partial reversal'
    );
    const offer = store.get('creator_offers', 'offer-1') as Row;
    assert(offer.payout_status === 'returned', 'a partial reversal still marks the payout returned');
  }

  {
    // Full-by-amount even though `reversed` is false — the trap the Stripe
    // docs call out.
    const store = makeStore();
    seedPaidDeal(store, 'tr_amt');
    const { hooks } = makeHooks();
    const r = await handleTransferReversed(
      store.sb,
      { transferId: 'tr_amt', amountMinor: 15050, amountReversedMinor: 15050, reversed: false, eventId: 'evt_6' },
      hooks
    );
    assert(
      r.handled === true && r.fullyReversed === true,
      'amount_reversed >= amount counts as full even when `reversed` is false'
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. payout.failed — money left the platform, the bank bounced it
  // ─────────────────────────────────────────────────────────────────────────
  {
    const store = makeStore();
    const { hooks } = makeHooks();
    const r = await handlePayoutFailed(
      store.sb,
      { connectAccountId: null, failureCode: 'no_account', failureMessage: null, payoutId: 'po_1', eventId: 'evt_7' },
      hooks
    );
    assert(r.handled === false && r.reason === 'no_account_id', 'no connected account → no_account_id');
  }

  {
    const store = makeStore();
    const { hooks } = makeHooks();
    const r = await handlePayoutFailed(
      store.sb,
      { connectAccountId: 'acct_nobody', failureCode: 'no_account', failureMessage: null, payoutId: 'po_2', eventId: 'evt_8' },
      hooks
    );
    assert(r.handled === false && r.reason === 'no_matching_deals', 'unknown account → no_matching_deals');
  }

  {
    const store = makeStore();
    seedPaidDeal(store, 'tr_bank');
    const { hooks, auditCalls, alertCalls } = makeHooks();

    const r = await handlePayoutFailed(
      store.sb,
      {
        connectAccountId: ACCT,
        failureCode: 'account_closed',
        failureMessage: 'The bank account has been closed.',
        payoutId: 'po_3',
        eventId: 'evt_9',
      },
      hooks
    );
    assert(r.handled === true, 'bank payout failure is handled');

    const offer = store.get('creator_offers', 'offer-1') as Row;
    assert(offer.payout_status === 'failed', 'deal payout_status → failed');
    assert(offer.status === 'paid', 'creator_offers.status untouched');

    // The distinction that matters: the label's money DID leave, so the
    // authorization must NOT be un-completed.
    const pa = store.get('payment_authorizations', 'pa-1') as Row;
    assert(
      pa.status === 'completed',
      'payment_authorization stays completed — a bank bounce is not a reversal'
    );
    assert(pa.failure_reason === null, 'no failure_reason written onto a completed authorization');

    assert(auditCalls.length === 1, 'one audit row');
    assert(auditCalls[0].action === 'payment.failed', 'reuses payment.failed');
    assert(auditCalls[0].target_type === 'creator_offer', 'audit targets the deal, not the authorization');
    const meta = auditCalls[0].metadata as Row;
    assert(meta.stage === 'bank_payout', 'audit metadata distinguishes the bank-payout stage');
    assert(meta.failure_code === 'account_closed', 'audit metadata carries the Stripe failure code');
    assert(
      typeof meta.guidance === 'string' && (meta.guidance as string).length > 0,
      'guidance comes from the existing stripe-errors mapper'
    );
    assert(
      typeof meta.reason === 'string' && (meta.reason as string).startsWith('stripe_'),
      `mapped reason is a stripe_* slug (got ${String(meta.reason)})`
    );
    assert(
      (meta.guidance as string).includes('The bank account has been closed.'),
      "Stripe's verbatim message survives into the guidance"
    );
    assert(alertCalls.length === 1 && alertCalls[0].level === 'error', 'one error alert');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Source invariants
  // ─────────────────────────────────────────────────────────────────────────
  {
    const routePath = join(process.cwd(), 'src', 'app', 'api', 'webhooks', 'stripe', 'route.ts');
    const routeSrc = readFileSync(routePath, 'utf8');
    // Comments deliberately quote the old expressions so the next reader knows
    // what was removed, so shape assertions run against CODE only.
    const routeCode = stripComments(routeSrc);

    // The regression: the two "pay less" coercions must be gone.
    assert(
      !routeCode.includes('Number(r.amount_usd ?? 0)'),
      'the cap-check amount coercion is gone'
    );
    assert(
      !routeCode.includes('amount_usd: r.amount_usd ?? 0'),
      'the transfer amount coercion is gone'
    );
    // The per-row account.updated logic moved to src/lib/onboarding-payout.ts
    // (2026-09-30), so the guard is asserted where the transfer is now built —
    // and the route must still delegate to it rather than transfer on its own.
    const payoutLibSrc = readFileSync(
      join(process.cwd(), 'src', 'lib', 'onboarding-payout.ts'),
      'utf8'
    );
    const payoutLibCode = stripComments(payoutLibSrc);
    assert(
      routeSrc.includes('payOnboardedAuthorization') && payoutLibSrc.includes('readPayoutAmountUsd'),
      'the account.updated transfer reads the amount through the guard'
    );
    assert(
      !payoutLibCode.includes('?? 0'),
      'no "pay less" coercion in the onboarding payout either'
    );

    // `transfer.failed` is not a real Stripe event — never ship a handler for
    // it. https://docs.stripe.com/api/events/types
    assert(
      !/'transfer\.failed'|"transfer\.failed"/.test(routeCode),
      'no handler branch for the non-existent transfer.failed event'
    );
    assert(routeCode.includes("'transfer.reversed'"), 'handles transfer.reversed');
    assert(routeCode.includes("'payout.failed'"), 'handles payout.failed');

    // Signature verification and dedupe stay single-path. Verification moved
    // into the isolated module with the signing secrets (Test/Live switch,
    // 2026-10-01): the route calls it once and computes no HMAC itself.
    const isolatedCode = stripComments(readFileSync(join(process.cwd(), 'src', 'lib', 'stripe-isolated.ts'), 'utf8'));
    assert(
      (routeCode.match(/createHmac/g) ?? []).length === 0 &&
        (routeCode.match(/authenticateStripeWebhook(<[^>]*>)?\(/g) ?? []).length === 1 &&
        (isolatedCode.match(/createHmac/g) ?? []).length === 1,
      'exactly one signature verification path'
    );
    assert(
      (routeCode.match(/processed_stripe_events/g) ?? []).length === 2,
      'the existing processed_stripe_events dedupe is reused, not duplicated'
    );

    // The secret-isolation gate must stay intact. Same needle as
    // tests/secret-isolation.test.ts: the env READ, not a comment mention.
    const libPath = join(process.cwd(), 'src', 'lib', 'settlement-failure.ts');
    const libSrc = readFileSync(libPath, 'utf8');
    assert(
      !routeSrc.includes('process.env.STRIPE_SECRET_KEY') &&
        !libSrc.includes('process.env.STRIPE_SECRET_KEY'),
      'neither the route nor the settlement module reads STRIPE_SECRET_KEY'
    );

    // Every slug this module writes has operator copy.
    const dealErrors = readFileSync(join(process.cwd(), 'src', 'lib', 'deal-errors.ts'), 'utf8');
    const statuses = readFileSync(join(process.cwd(), 'src', 'lib', 'statuses.ts'), 'utf8');
    for (const slug of ['invalid_payout_amount', 'stripe_transfer_reversed']) {
      assert(dealErrors.includes(slug), `${slug} has deal-page copy`);
      assert(statuses.includes(slug), `${slug} has anomaly-surface copy`);
    }
  }
}

async function main() {
  await runCoreTests();
  if (failures.length > 0) console.error('\nFailures:\n - ' + failures.join('\n - '));
  console.log(`settlement-failure test: ${passed}/${passed + failed} pass`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
