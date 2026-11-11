// tests/money-path-adversarial.test.ts
//
// WHAT THIS GUARDS: five money-path defects, each confirmed by executing it.
// Each section below reproduces the scenario against the real lib code and
// asserts it now fails safe.
//
//   1. Approve reopened a closed deal. The approve route mirrored
//      creator_offers.status='approved' unconditionally, so approving a pending
//      leg on a cancelled/rejected deal (or racing a cancel) reopened it, and
//      execute's post-claim re-check then read 'approved' and paid. The same
//      write overwrote 'posted' with 'approved' on balance legs.
//   2. The balance leg was sized from the firm's CURRENT deposit_pct, not from
//      what the deposit actually paid — a pct change after the deposit overpaid.
//      Turning the split off after a deposit stranded the balance entirely.
//   3. An ambiguous Stripe outcome (network error, timeout, 5xx, idempotency
//      conflict) was treated as a clean failure and re-sent with no human click.
//   4. Stopping a balance leg on a deposit-paid deal set the deal 'rejected',
//      dropping the paid deposit out of the 054 budget guard.
//   5. A failed balance mint / automint was silent.
//
// Hermetic: in-memory store, dummy env (setup-env), paper payments mode unless a
// section switches to stripe_test with a stubbed fetch. No DB, no Stripe, no
// network.
//
// Run: npx tsx tests/money-path-adversarial.test.ts

import './negotiation-harness/setup-env'; // FIRST — dummy env
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeStore, type Row } from './negotiation-harness/store';
import { executeAuthorizedPayment } from '../src/lib/execute-payment';
import { cancelOffer } from '../src/lib/cancel-offer';
import { approvePaymentAuthorization } from '../src/lib/approve-payment';
import { fetchPendingApprovals } from '../src/lib/approvals-query';
import { authorizePaymentForOffer, mintBalanceAfterPost, remintPaymentForOffer } from '../src/lib/authorize-payment';
import { approvalQueueGap, legStatusText } from '../src/lib/payment-legs';
import { NON_RETRYABLE_FAILURE_REASONS } from '../src/lib/payment-claim';
import { payOnboardedAuthorization, type OnboardingPayoutDeps } from '../src/lib/onboarding-payout';
import type { StripeTransferInput, StripeTransferResult } from '../src/lib/stripe-isolated';
import { executePayout, lookupTransfersByGroup, type PaymentMode } from '../src/lib/stripe-isolated';
import { retryRefusal, claimForExecution, OUTCOME_UNKNOWN_REASON, CONFIRMED_NOT_SENT_REASON } from '../src/lib/payment-claim';
import { rejectPaymentAuthorization } from '../src/lib/reject-payment';
import { reconcilePaymentOutcome, type ReconcileDeps, type TransferLookup } from '../src/lib/payment-reconcile';
import { runPaymentReclaim, reconcileBackoffMs, RECLAIM_FLAG_ACTIONS, STALE_EXECUTING_MS } from '../src/lib/payment-reclaim';
import { detectAnomalies, OUTCOME_UNKNOWN_FAILURE, RECONCILE_FLAG_ACTIONS, MONEY_ANOMALY_AUDIT_ACTIONS, type AnomaliesInput } from '../src/lib/statuses';
import { MIN_NOT_FOUND_AGE_MS } from '../src/lib/payment-reconcile';
import { markOfferMeasured } from '../src/lib/record-outcome';
import { summarizePayout } from '../src/lib/payout-surfacing';

/** Injected deps for the onboarding webhook path; `result` scripts each transfer. */
function onboardingDeps(results: Partial<StripeTransferResult>[]) {
  const payouts: StripeTransferInput[] = [];
  const audits: { action: string; metadata?: Record<string, unknown> }[] = [];
  const deps: OnboardingPayoutDeps = {
    audit: async (e) => {
      audits.push(e);
    },
    alertOnce: () => {},
    executePayout: async (input) => {
      payouts.push(input);
      const r = results[Math.min(payouts.length - 1, results.length - 1)] ?? {};
      return { ok: true, provider_id: 'tr_ok', dry_run: false, raw_status: 'paid', settled: true, mode: 'stripe_test', ...r } as StripeTransferResult;
    },
    capGate: async () => ({ allowed: true, artistName: 'A', senderName: 'L' }) as never,
    sendPromoMaterials: async () => {},
  };
  return { deps, payouts, audits };
}

// The executePayout stubs below answer the Accounts v1 read; pin that path
// (the v2 default is covered by tests/stripe-accounts-v2.test.ts).
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

const FIRM = 'firm-1';
const CAMPAIGN = 'camp-1';
type Store = ReturnType<typeof makeStore>;
const noAudit = { audit: async () => {} };

/** An offer + one authorization the execute path can load end to end. */
function seedDeal(
  store: Store,
  opts: {
    offerStatus: string;
    paStatus: string;
    leg?: string;
    amount?: number;
    agreed?: number;
    depositPaid?: number | null;
    extraOffer?: Row;
  }
): Row {
  store.seed('campaigns', { id: CAMPAIGN, total_budget_usd: 10_000, artist_name: 'Artist' });
  store.seed('firms', { id: FIRM, monthly_spend_cap_usd: 0, per_creator_monthly_cap_usd: 0, sender_name: 'Label' });
  store.seed('creator_offers', {
    id: 'offer-1',
    firm_id: FIRM,
    campaign_id: CAMPAIGN,
    campaign_influencer_id: 'ci-1',
    status: opts.offerStatus,
    agreed_amount_usd: opts.agreed ?? 100,
    ceiling_usd: 200,
    deposit_paid_usd: opts.depositPaid ?? null,
    balance_paid_usd: null,
    payout_status: null,
    paid_at: null,
    ...(opts.extraOffer ?? {}),
  });
  const approved = !['pending_human_review', 'rejected'].includes(opts.paStatus);
  return store.seed('payment_authorizations', {
    id: 'pa-1',
    firm_id: FIRM,
    campaign_id: CAMPAIGN,
    creator_offer_id: 'offer-1',
    amount_usd: opts.amount ?? 100,
    status: opts.paStatus,
    leg: opts.leg ?? 'full',
    human_approved_at: approved ? '2026-09-29T10:00:00.000Z' : null,
    human_approved_by_user_id: approved ? 'user_approver' : null,
    payment_provider_id: null,
    failure_reason: null,
    executing_at: null,
    created_at: '2026-09-29T09:00:00.000Z',
    creator_offers: {
      id: 'offer-1',
      payout_email: 'c@example.com',
      contract_text: null,
      contract_generated_at: null,
      campaign_influencer_id: 'ci-1',
      campaign_influencers: {
        influencer_id: 'inf-1',
        influencer: { contact_email: 'c@example.com', username: 'creator', stripe_connect_account_id: null },
      },
    },
  });
}

/** The approve route's flow, minus Next/Clerk: the lib, then auto-execute. */
async function approveAndExecute(sb: SupabaseClient, id: string) {
  const a = await approvePaymentAuthorization(
    sb,
    { id, callerFirmId: FIRM, actorUserId: 'user_approver' },
    noAudit
  );
  if (!a.ok) return { approve: a, executed: null };
  const executed = await executeAuthorizedPayment(sb, id, { expectedFirmId: FIRM });
  return { approve: a, executed };
}

async function section1() {
  console.log('\n1. approve cannot reopen a closed deal, or regress a posted one');

  // T1b — no race: a pending leg on an already-rejected deal.
  {
    const store = makeStore();
    seedDeal(store, { offerStatus: 'rejected', paStatus: 'pending_human_review' });
    const r = await approveAndExecute(store.sb, 'pa-1');
    assert(!r.approve.ok && r.approve.httpStatus === 409, `approve on a rejected deal → 409 (got ${r.approve.httpStatus})`);
    const refusal = r.approve.ok ? null : r.approve.body.error;
    assert(refusal === 'offer_not_payable', `…error offer_not_payable (got ${String(refusal)})`);
    assert(r.executed === null, '…nothing executed');
    assert(store.getOffer('offer-1')?.status === 'rejected', `…deal stays rejected (got ${String(store.getOffer('offer-1')?.status)})`);
    assert(store.all('payment_authorizations')[0].status === 'pending_human_review', '…authorization untouched');
    assert(store.all('paper_money_ledger').length === 0, '…no paper ledger row (no money)');
  }
  for (const closed of ['failed', 'undelivered', 'paid', 'deposit_paid', 'balance_paid']) {
    const store = makeStore();
    seedDeal(store, { offerStatus: closed, paStatus: 'pending_human_review', leg: 'full' });
    const r = await approveAndExecute(store.sb, 'pa-1');
    assert(!r.approve.ok && r.approve.httpStatus === 409, `full leg on a '${closed}' deal → 409`);
    assert(store.getOffer('offer-1')?.status === closed, `…'${closed}' not overwritten`);
  }

  // T1 — cancel races approve. Cancel's CAS closes the deal; the approve lands
  // right after it (before cancel revokes the legs).
  {
    const store = makeStore();
    seedDeal(store, { offerStatus: 'human_approval_required', paStatus: 'pending_human_review' });
    let injected = false;
    let approveResult: Awaited<ReturnType<typeof approveAndExecute>> | null = null;
    const realFrom = store.sb.from.bind(store.sb);
    const sb = {
      from(table: string) {
        const q = realFrom(table) as unknown as Record<string, unknown>;
        if (table === 'creator_offers') {
          const origUpdate = (q.update as (p: Row) => unknown).bind(q);
          q.update = (p: Row) => {
            const r = origUpdate(p) as Record<string, unknown>;
            if (p.status === 'rejected' && !injected) {
              const origMS = (r.maybeSingle as () => Promise<unknown>).bind(r);
              r.maybeSingle = async () => {
                const res = await origMS();
                injected = true;
                approveResult = await approveAndExecute(store.sb, 'pa-1');
                return res;
              };
            }
            return r;
          };
        }
        return q;
      },
    } as unknown as SupabaseClient;
    await cancelOffer(sb, { campaignId: CAMPAIGN, ciId: 'ci-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    const ar = approveResult as Awaited<ReturnType<typeof approveAndExecute>> | null;
    assert(injected && ar !== null, 'race injected');
    assert(ar !== null && !ar.approve.ok, `approve landing after the cancel is refused (got ${ar?.approve.httpStatus})`);
    const pa = store.all('payment_authorizations')[0];
    assert(pa.status !== 'completed' && pa.payment_provider_id == null, `no payout on a cancelled deal (pa=${String(pa.status)})`);
    assert(store.getOffer('offer-1')?.status === 'rejected', `deal stays rejected (got ${String(store.getOffer('offer-1')?.status)})`);
    assert(store.all('paper_money_ledger').length === 0, 'no paper ledger row');
  }

  // Race the other way: approve's read sees a payable deal, then the cancel's
  // CAS lands before approve's own (guarded) deal write.
  {
    const store = makeStore();
    seedDeal(store, { offerStatus: 'human_approval_required', paStatus: 'pending_human_review' });
    const realFrom = store.sb.from.bind(store.sb);
    let flipped = false;
    const sb = {
      from(table: string) {
        const q = realFrom(table) as unknown as Record<string, unknown>;
        if (table === 'creator_offers') {
          const origUpdate = (q.update as (p: Row) => unknown).bind(q);
          q.update = (p: Row) => {
            if (p.status === 'approved' && !flipped) {
              flipped = true;
              store.getOffer('offer-1')!.status = 'rejected'; // the cancel's CAS wins first
            }
            return origUpdate(p);
          };
        }
        return q;
      },
    } as unknown as SupabaseClient;
    const a = await approvePaymentAuthorization(sb, { id: 'pa-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    assert(flipped, 'race injected at the deal write');
    assert(!a.ok && a.httpStatus === 409, `guarded deal write refuses the closed deal (got ${a.httpStatus})`);
    assert(store.getOffer('offer-1')?.status === 'rejected', 'deal NOT reopened');
    assert(store.all('payment_authorizations')[0].status === 'pending_human_review', 'authorization NOT approved');
  }

  // Deposit / full leg on a live deal: approved, deal mirrored, paid.
  {
    const store = makeStore();
    seedDeal(store, { offerStatus: 'human_approval_required', paStatus: 'pending_human_review', leg: 'deposit', amount: 50 });
    const r = await approveAndExecute(store.sb, 'pa-1');
    assert(r.approve.ok, 'deposit leg on a live deal approves');
    assert(r.executed?.httpStatus === 200, `…and pays (got ${r.executed?.httpStatus})`);
    assert(store.getOffer('offer-1')?.status === 'deposit_paid', `…deal ends deposit_paid (got ${String(store.getOffer('offer-1')?.status)})`);
  }

  // Balance leg: the deal is 'posted' and must stay 'posted' until paid.
  {
    const store = makeStore();
    seedDeal(store, { offerStatus: 'posted', paStatus: 'pending_human_review', leg: 'balance', amount: 50, depositPaid: 50 });
    const offer = store.getOffer('offer-1')!;
    let sawApprovedWrite = false;
    const realFrom = store.sb.from.bind(store.sb);
    const sb = {
      from(table: string) {
        const q = realFrom(table) as unknown as Record<string, unknown>;
        if (table === 'creator_offers') {
          const origUpdate = (q.update as (p: Row) => unknown).bind(q);
          q.update = (p: Row) => {
            if (p.status === 'approved') sawApprovedWrite = true;
            return origUpdate(p);
          };
        }
        return q;
      },
    } as unknown as SupabaseClient;
    const a = await approvePaymentAuthorization(sb, { id: 'pa-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    assert(a.ok, 'balance leg on a posted deal approves');
    assert(!sawApprovedWrite, 'balance approval never writes status=approved onto the deal');
    assert(offer.status === 'posted', `deal stays posted after the balance approval (got ${String(offer.status)})`);
    const ex = await executeAuthorizedPayment(store.sb, 'pa-1', { expectedFirmId: FIRM });
    assert(ex.httpStatus === 200 && offer.status === 'balance_paid', `balance pays → balance_paid (got ${ex.httpStatus}/${String(offer.status)})`);
  }
  // Balance leg on a deal whose balance was already paid → refused.
  {
    const store = makeStore();
    seedDeal(store, { offerStatus: 'balance_paid', paStatus: 'pending_human_review', leg: 'balance', amount: 50, depositPaid: 50 });
    const a = await approvePaymentAuthorization(store.sb, { id: 'pa-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    assert(!a.ok && a.httpStatus === 409, 'balance leg on a balance_paid deal → 409');
    assert(store.getOffer('offer-1')?.status === 'balance_paid', '…not regressed');
  }
  // Scope and state guards the route had are kept.
  {
    const store = makeStore();
    seedDeal(store, { offerStatus: 'human_approval_required', paStatus: 'pending_human_review' });
    const x = await approvePaymentAuthorization(store.sb, { id: 'pa-1', callerFirmId: 'firm-other', actorUserId: 'u' }, noAudit);
    assert(!x.ok && (x.httpStatus === 403 || x.httpStatus === 404), `cross-firm approve refused (got ${x.httpStatus})`);
    const blank = await approvePaymentAuthorization(store.sb, { id: 'pa-1', callerFirmId: '', actorUserId: 'u' }, noAudit);
    assert(!blank.ok, 'blank caller firm refused');
    assert(store.getOffer('offer-1')?.status === 'human_approval_required', 'refusals wrote nothing');
    const ok = await approvePaymentAuthorization(store.sb, { id: 'pa-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    assert(ok.ok, 'first approve ok');
    const again = await approvePaymentAuthorization(store.sb, { id: 'pa-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    assert(!again.ok && again.httpStatus === 409, 'second approve → 409');
  }

  // /approvals: a pending leg whose deal is not payable is shown blocked.
  {
    const store = makeStore();
    seedDeal(store, { offerStatus: 'rejected', paStatus: 'pending_human_review' });
    // The page's nested select comes back as the joined offer.
    const pa = store.all('payment_authorizations')[0];
    pa.creator_offers = { ...(pa.creator_offers as Row), status: 'rejected' };
    store.seed('payment_authorizations', {
      id: 'pa-2', firm_id: FIRM, campaign_id: CAMPAIGN, creator_offer_id: 'offer-2', amount_usd: 100,
      status: 'pending_human_review', leg: 'full', created_at: '2026-09-29T09:05:00.000Z',
      creator_offers: { id: 'offer-2', status: 'human_approval_required' },
    });
    const res = await fetchPendingApprovals(store.sb, FIRM);
    assert(res.ok, 'approvals query ok');
    if (res.ok) {
      const dead = res.rows.find((r) => r.id === 'pa-1');
      const live = res.rows.find((r) => r.id === 'pa-2');
      assert(dead?.payable === false, 'leg on a rejected deal → payable:false');
      assert(typeof dead?.blocked_reason === 'string' && dead.blocked_reason.length > 0, '…with a blocked_reason');
      assert(live?.payable === true && live.blocked_reason == null, 'leg on a live deal → payable:true');
    }
    assert(/creator_offers!inner\([\s\S]*\bstatus\b/.test(read('lib/approvals-query.ts')), 'approvals select reads the deal status');
    const page = read('app/approvals/page.tsx');
    const actions = read('app/approvals/ApprovalActions.tsx');
    assert(page.includes('blockedReason='), 'approvals page passes blockedReason to the actions island');
    assert(/blockedReason\s*\?/.test(actions) || /if \(blockedReason\)/.test(actions), 'ApprovalActions branches on blockedReason');
  }

  // The route delegates to the lib (the lib is what these tests execute).
  {
    const route = read('app/api/payments/[id]/approve/route.ts');
    assert(route.includes('approvePaymentAuthorization('), 'approve route delegates to approvePaymentAuthorization');
    assert(!/from\('creator_offers'\)/.test(route), 'approve route no longer writes creator_offers itself');
  }
}

async function section2() {
  console.log('\n2. the balance is what is left of the agreed amount, never the current pct');

  const mint = async (firm: Row, offer: Row) => {
    const store = makeStore();
    store.seed('firms', { id: FIRM, ...firm });
    store.seed('creator_offers', {
      id: 'offer-2', campaign_id: CAMPAIGN, firm_id: FIRM, status: 'posted',
      agreed_amount_usd: 100, ceiling_usd: 200, deposit_paid_usd: 50, balance_paid_usd: null, ...offer,
    });
    const r = await authorizePaymentForOffer(
      store.sb,
      { creatorOfferId: 'offer-2', callerFirmId: FIRM, actorUserId: 'u', leg: 'balance' },
      noAudit
    );
    return { r, rows: store.all('payment_authorizations') };
  };

  // T2 — pct lowered 50 → 20 after the deposit went out.
  {
    const { r, rows } = await mint({ require_delivery_before_balance: true, deposit_pct: 20 }, {});
    assert(r.httpStatus === 200, `balance mints (got ${r.httpStatus})`);
    assert(Number(r.body.amount_usd) === 50, `balance = agreed − deposit_paid = 50 (got ${String(r.body.amount_usd)})`);
    assert(rows.length === 1 && rows[0].leg === 'balance', 'one balance-leg row');
  }
  // pct raised 50 → 80: balance must still be 50, not 20.
  {
    const { r } = await mint({ require_delivery_before_balance: true, deposit_pct: 80 }, {});
    assert(Number(r.body.amount_usd) === 50, `pct raised → balance still 50 (got ${String(r.body.amount_usd)})`);
  }
  // Odd cents.
  {
    const { r } = await mint({ require_delivery_before_balance: true, deposit_pct: 50 }, { agreed_amount_usd: 100, deposit_paid_usd: 33.33 });
    assert(Number(r.body.amount_usd) === 66.67, `100 − 33.33 → 66.67 (got ${String(r.body.amount_usd)})`);
  }
  // Deposit already covered everything → nothing to mint, never negative.
  for (const dep of [100, 120]) {
    const { r, rows } = await mint({ require_delivery_before_balance: true, deposit_pct: 50 }, { deposit_paid_usd: dep });
    assert(r.httpStatus === 409 && r.body.error === 'leg_has_no_amount', `deposit ${dep} of 100 → 409 leg_has_no_amount (got ${r.httpStatus} ${String(r.body.error)})`);
    assert(rows.length === 0, `…no row for deposit ${dep}`);
  }
  // T2b — split turned OFF after the deposit was paid: the remainder is still
  // owed and is minted as the balance leg, not stranded behind a 409.
  {
    const { r, rows } = await mint({ require_delivery_before_balance: false, deposit_pct: 50 }, {});
    assert(r.httpStatus === 200, `split off after deposit → balance still mints (got ${r.httpStatus} ${JSON.stringify(r.body)})`);
    assert(rows.length === 1 && rows[0].leg === 'balance', `…as the balance leg (got ${String(rows[0]?.leg)})`);
    assert(Number(rows[0]?.amount_usd) === 50, `…for the remaining 50 (got ${String(rows[0]?.amount_usd)})`);
  }
  // A balance with no deposit on record is a second FULL payment → refused.
  {
    const { r, rows } = await mint({ require_delivery_before_balance: true, deposit_pct: 50 }, { deposit_paid_usd: null });
    assert(r.httpStatus === 409, `balance with no deposit paid → 409 (got ${r.httpStatus})`);
    assert(rows.length === 0, '…no row');
  }

  // Execute asserts the legs never sum past the agreed amount.
  {
    const store = makeStore();
    const pa = seedDeal(store, { offerStatus: 'posted', paStatus: 'approved', leg: 'balance', amount: 80, depositPaid: 50 });
    store.seed('payment_authorizations', {
      id: 'pa-dep', firm_id: FIRM, campaign_id: CAMPAIGN, creator_offer_id: 'offer-1', amount_usd: 50,
      status: 'completed', leg: 'deposit', payment_provider_id: 'paper_dep',
      human_approved_at: 'x', human_approved_by_user_id: 'u',
    });
    const ex = await executeAuthorizedPayment(store.sb, 'pa-1', { expectedFirmId: FIRM });
    assert(ex.httpStatus === 409 && ex.body.error === 'legs_exceed_agreed', `50 paid + 80 on agreed 100 → 409 legs_exceed_agreed (got ${ex.httpStatus} ${String(ex.body.error)})`);
    assert(pa.status === 'failed' && pa.failure_reason === 'legs_exceed_agreed', `…row failed, legs_exceed_agreed (got ${String(pa.status)}/${String(pa.failure_reason)})`);
    assert(store.all('paper_money_ledger').length === 0, '…no money');
    assert(store.getOffer('offer-1')?.status === 'posted', '…deal untouched');
    assert(NON_RETRYABLE_FAILURE_REASONS.includes('legs_exceed_agreed'), 'legs_exceed_agreed is not retryable');
  }
  {
    // Exactly the remainder passes.
    const store = makeStore();
    seedDeal(store, { offerStatus: 'posted', paStatus: 'approved', leg: 'balance', amount: 50, depositPaid: 50 });
    store.seed('payment_authorizations', {
      id: 'pa-dep', firm_id: FIRM, campaign_id: CAMPAIGN, creator_offer_id: 'offer-1', amount_usd: 50,
      status: 'completed', leg: 'deposit', payment_provider_id: 'paper_dep',
      human_approved_at: 'x', human_approved_by_user_id: 'u',
    });
    const ex = await executeAuthorizedPayment(store.sb, 'pa-1', { expectedFirmId: FIRM });
    assert(ex.httpStatus === 200, `50 + 50 on agreed 100 pays (got ${ex.httpStatus} ${String(ex.body.error)})`);
  }
  {
    // A single full leg above the agreed amount is refused too.
    const store = makeStore();
    seedDeal(store, { offerStatus: 'approved', paStatus: 'approved', leg: 'full', amount: 150, agreed: 100 });
    const ex = await executeAuthorizedPayment(store.sb, 'pa-1', { expectedFirmId: FIRM });
    assert(ex.httpStatus === 409 && ex.body.error === 'legs_exceed_agreed', `full 150 on agreed 100 → 409 (got ${ex.httpStatus})`);
  }
  {
    // The onboarding webhook runs the same assertion before its transfer.
    const store = makeStore();
    const pa = seedDeal(store, { offerStatus: 'posted', paStatus: 'approved', leg: 'balance', amount: 80, depositPaid: 50 });
    const f = onboardingDeps([{}]);
    const out = await payOnboardedAuthorization(
      store.sb,
      { id: 'pa-1', firm_id: FIRM, campaign_id: CAMPAIGN, amount_usd: 80, creator_offer_id: 'offer-1', leg: 'balance', influencer_id: 'inf-1' },
      'acct_1',
      f.deps
    );
    assert(out.outcome === 'legs_exceed_agreed', `webhook: 50 + 80 on 100 → legs_exceed_agreed (got ${out.outcome})`);
    assert(f.payouts.length === 0, '…no transfer attempted');
    assert(pa.status === 'failed' && pa.failure_reason === 'legs_exceed_agreed', `…row failed (got ${String(pa.status)})`);
  }
  for (const sib of [
    { status: 'completed', payment_provider_id: 'tr_dep' },
    { status: 'executing', payment_provider_id: null },
    { status: 'failed', payment_provider_id: 'tr_reversed' },
  ]) {
    // A sibling leg that moved money counts even if the deal never recorded it
    // (e.g. the deposit's settlement write was lost).
    const store = makeStore();
    seedDeal(store, { offerStatus: 'approved', paStatus: 'approved', leg: 'balance', amount: 80, depositPaid: null });
    store.seed('payment_authorizations', {
      id: 'pa-dep', firm_id: FIRM, campaign_id: CAMPAIGN, creator_offer_id: 'offer-1', amount_usd: 50,
      leg: 'deposit', human_approved_at: 'x', human_approved_by_user_id: 'u', ...sib,
    });
    const ex = await executeAuthorizedPayment(store.sb, 'pa-1', { expectedFirmId: FIRM });
    assert(ex.httpStatus === 409 && ex.body.error === 'legs_exceed_agreed', `sibling ${sib.status}/${String(sib.payment_provider_id)} 50 + 80 → 409 (got ${ex.httpStatus})`);
  }
  {
    // A sibling that never moved money does not count.
    const store = makeStore();
    seedDeal(store, { offerStatus: 'approved', paStatus: 'approved', leg: 'full', amount: 100 });
    store.seed('payment_authorizations', {
      id: 'pa-old', firm_id: FIRM, campaign_id: CAMPAIGN, creator_offer_id: 'offer-1', amount_usd: 100,
      leg: 'deposit', status: 'rejected', payment_provider_id: null, human_approved_at: null, human_approved_by_user_id: null,
    });
    const ex = await executeAuthorizedPayment(store.sb, 'pa-1', { expectedFirmId: FIRM });
    assert(ex.httpStatus === 200, `rejected unmoved sibling does not count (got ${ex.httpStatus} ${String(ex.body.error)})`);
  }
  {
    // Recorded deposit_paid_usd counts even if the deposit row is missing.
    const store = makeStore();
    seedDeal(store, { offerStatus: 'posted', paStatus: 'approved', leg: 'balance', amount: 80, depositPaid: 50 });
    const ex = await executeAuthorizedPayment(store.sb, 'pa-1', { expectedFirmId: FIRM });
    assert(ex.httpStatus === 409 && ex.body.error === 'legs_exceed_agreed', `recorded deposit 50 + 80 → 409 (got ${ex.httpStatus})`);
  }
}

// ── Stripe stubbing: the real isolated client, a scripted fetch ─────────────
const harnessFetch = globalThis.fetch;
interface StubCall { url: string; method: string; body: string; headers: Record<string, string> }
function withStripe<T>(
  handler: (c: StubCall) => { status: number; json: unknown } | 'throw',
  fn: (calls: StubCall[]) => Promise<T>
): Promise<T> {
  const calls: StubCall[] = [];
  const prevMode = process.env.PAYMENTS_MODE;
  const prevKey = process.env.STRIPE_SECRET_KEY;
  process.env.PAYMENTS_MODE = 'stripe_test';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const i = (init ?? {}) as { method?: string; body?: unknown; headers?: Record<string, string> };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(i.headers ?? {})) headers[k.toLowerCase()] = v;
    const u = String(url);
    if (!u.startsWith('https://api.stripe.com/')) return harnessFetch(url as string, init as RequestInit);
    const call = { url: u, method: i.method ?? 'GET', body: i.body == null ? '' : String(i.body), headers };
    calls.push(call);
    const r = handler(call);
    if (r === 'throw') throw new TypeError('fetch failed: socket hang up');
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json } as Response;
  }) as typeof fetch;
  return fn(calls).finally(() => {
    globalThis.fetch = harnessFetch;
    process.env.PAYMENTS_MODE = prevMode;
    if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevKey;
  });
}
/** Account already onboarded; the transfer answers with `transfer`. */
const onboardedThen =
  (transfer: { status: number; json: unknown } | 'throw') =>
  (c: StubCall): { status: number; json: unknown } | 'throw' => {
    if (c.method === 'GET' && c.url.includes('/v1/accounts/')) return { status: 200, json: { id: 'acct_1', payouts_enabled: true } };
    if (c.method === 'POST' && c.url.endsWith('/v1/transfers')) return transfer;
    return { status: 404, json: {} };
  };
const payoutIn = { amount_usd: 100, destination_email: 'c@example.com', description: 'd', idempotency_key: 'pa-1.full', connect_account_id: 'acct_1' };

async function section3() {
  console.log('\n3. an ambiguous Stripe outcome is never treated as a clean failure');

  // 3a. Classification in the isolated client.
  const cases: [string, { status: number; json: unknown } | 'throw', boolean][] = [
    ['network exception', 'throw', true],
    ['HTTP 500', { status: 500, json: { error: { type: 'api_error', message: 'boom' } } }, true],
    ['HTTP 502, no body', { status: 502, json: {} }, true],
    ['HTTP 409 idempotency in progress', { status: 409, json: { error: { type: 'idempotency_error', message: 'in progress' } } }, true],
    ['HTTP 409 lock timeout, no idempotency type', { status: 409, json: { error: { type: 'invalid_request_error', code: 'lock_timeout', message: 'conflict' } } }, true],
    ['HTTP 400 idempotency_error', { status: 400, json: { error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters' } } }, true],
    ['HTTP 400 insufficient balance', { status: 400, json: { error: { type: 'invalid_request_error', code: 'balance_insufficient', message: 'Insufficient funds' } } }, false],
    ['HTTP 429 rate limited', { status: 429, json: { error: { type: 'rate_limit_error', message: 'slow down' } } }, false],
    ['HTTP 401 bad key', { status: 401, json: { error: { type: 'invalid_request_error', message: 'Invalid API Key' } } }, false],
  ];
  for (const [label, resp, unknown] of cases) {
    const r = await withStripe(onboardedThen(resp), async () => executePayout(payoutIn));
    assert(!r.ok, `${label}: not ok`);
    assert((r.outcome_unknown === true) === unknown, `${label}: outcome_unknown=${unknown} (got ${String(r.outcome_unknown)})`);
    if (unknown) assert(r.reason === OUTCOME_UNKNOWN_REASON, `${label}: reason ${OUTCOME_UNKNOWN_REASON} (got ${String(r.reason)})`);
  }
  // A failure BEFORE the transfer (account read) moved nothing → definite.
  {
    const r = await withStripe(
      (c) => (c.url.includes('/v1/accounts/') ? 'throw' : { status: 404, json: {} }),
      async () => executePayout(payoutIn)
    );
    assert(!r.ok && r.outcome_unknown !== true, 'network error on the account read (before any transfer) is a definite failure');
  }
  // The transfer carries a deterministic transfer_group = the idempotency key.
  {
    const ok = await withStripe(onboardedThen({ status: 200, json: { id: 'tr_9' } }), async (calls) => {
      const r = await executePayout(payoutIn);
      const tr = calls.find((c) => c.url.endsWith('/v1/transfers'));
      const body = new URLSearchParams(tr?.body ?? '');
      assert(body.get('transfer_group') === 'pa-1.full', `transfer_group = idempotency key (got ${String(body.get('transfer_group'))})`);
      assert(tr?.headers['idempotency-key'] === 'pa-1.full.transfer', 'idempotency header unchanged');
      return r;
    });
    assert(ok.ok && ok.provider_id === 'tr_9', 'clean success unchanged');
  }
  // Lookup by transfer_group goes through the isolated client, GET, filtered.
  {
    const r = await withStripe(
      (c) => (c.method === 'GET' && c.url.includes('/v1/transfers?') ? { status: 200, json: { data: [{ id: 'tr_5', amount: 10000, amount_reversed: 0, reversed: false, destination: 'acct_1' }] } } : { status: 404, json: {} }),
      async (calls) => {
        const out = await lookupTransfersByGroup('pa-1.full');
        const u = new URL(calls[0]?.url ?? 'https://x');
        assert(u.pathname === '/v1/transfers' && u.searchParams.get('transfer_group') === 'pa-1.full', 'lookup filters GET /v1/transfers by transfer_group');
        return out;
      }
    );
    assert(r.ok && r.transfers.length === 1 && r.transfers[0].id === 'tr_5' && r.transfers[0].amount_minor === 10000, 'lookup parses transfers');
    const bad = await withStripe(() => 'throw', async () => lookupTransfersByGroup('pa-1.full'));
    assert(!bad.ok, 'lookup network error → not ok (never "no transfer")');
    const paper = await lookupTransfersByGroup('pa-1.full');
    assert(!paper.ok && paper.not_stripe === true, 'paper mode: lookup refuses, no call');
  }

  // 3b. Execute path: network error on the transfer → row stays 'executing',
  //     marked outcome-unknown; nothing can re-send it.
  {
    const store = makeStore();
    const pa = seedDeal(store, { offerStatus: 'approved', paStatus: 'approved' });
    ((pa.creator_offers as Row).campaign_influencers as { influencer: Row }).influencer.stripe_connect_account_id = 'acct_1';
    const out = await withStripe(onboardedThen('throw'), async (calls) => {
      const ex = await executeAuthorizedPayment(store.sb, 'pa-1', { expectedFirmId: FIRM });
      assert(pa.status === 'executing', `ambiguous → row stays executing (got ${String(pa.status)})`);
      assert(pa.failure_reason === OUTCOME_UNKNOWN_REASON, `…marked ${OUTCOME_UNKNOWN_REASON} (got ${String(pa.failure_reason)})`);
      assert(ex.httpStatus === 502 && ex.body.reason === OUTCOME_UNKNOWN_REASON, `…execute reports outcome unknown (got ${ex.httpStatus} ${String(ex.body.reason)})`);
      assert(store.getOffer('offer-1')?.status === 'approved', '…deal not settled, not failed');
      // A manual Execute/Retry click cannot claim it.
      const again = await executeAuthorizedPayment(store.sb, 'pa-1', { expectedFirmId: FIRM });
      assert(again.httpStatus === 409, `…second execute refused (got ${again.httpStatus})`);
      const cancel = await cancelOffer(store.sb, { campaignId: CAMPAIGN, ciId: 'ci-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
      assert(cancel.httpStatus === 409, `…cancel refused while unknown (got ${cancel.httpStatus})`);
      const stop = await rejectPaymentAuthorization(store.sb, { id: 'pa-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
      assert(stop.httpStatus === 409, `…stop refused while unknown (got ${stop.httpStatus})`);
      return calls.filter((c) => c.url.endsWith('/v1/transfers')).length;
    });
    assert(out === 1, `exactly one transfer attempt (got ${out})`);
    assert(retryRefusal({ status: 'failed', payment_provider_id: null, failure_reason: OUTCOME_UNKNOWN_REASON, human_approved_at: 'x' }) === 'stopped', 'a failed row marked outcome-unknown is never retryable');
  }

  // 3c. Onboarding webhook (reviewer T3): ambiguous → stays executing; the next
  //     account.updated cannot claim it; one transfer total.
  {
    const store = makeStore();
    const pa = seedDeal(store, { offerStatus: 'approved', paStatus: 'approved', extraOffer: { payout_status: 'awaiting_onboarding' } });
    const f = onboardingDeps([{ ok: false, provider_id: '', settled: false, error: 'fetch failed: socket hang up', outcome_unknown: true, reason: OUTCOME_UNKNOWN_REASON }, { ok: true, provider_id: 'tr_2' }]);
    const row = { id: 'pa-1', firm_id: FIRM, campaign_id: CAMPAIGN, amount_usd: 100, creator_offer_id: 'offer-1', leg: 'full' as const, influencer_id: 'inf-1' };
    const r1 = await payOnboardedAuthorization(store.sb, row, 'acct_1', f.deps);
    assert(r1.outcome === 'outcome_unknown', `webhook: ambiguous → outcome_unknown (got ${r1.outcome})`);
    assert(pa.status === 'executing' && pa.failure_reason === OUTCOME_UNKNOWN_REASON, `…row executing + marked (got ${String(pa.status)}/${String(pa.failure_reason)})`);
    assert(f.audits.some((a) => a.action === 'payment.outcome_unknown'), '…audited payment.outcome_unknown');
    const r2 = await payOnboardedAuthorization(store.sb, row, 'acct_1', f.deps);
    assert(r2.outcome === 'not_claimed' && f.payouts.length === 1, `second account.updated does not re-send (got ${r2.outcome}, ${f.payouts.length} transfers)`);
    // A definite failure keeps the old behaviour: back to approved, retryable.
    const s2 = makeStore();
    const pa2 = seedDeal(s2, { offerStatus: 'approved', paStatus: 'approved' });
    const g = onboardingDeps([{ ok: false, provider_id: '', settled: false, error: 'Insufficient funds', reason: 'stripe_balance_insufficient' }]);
    const d = await payOnboardedAuthorization(s2.sb, row, 'acct_1', g.deps);
    assert(d.outcome === 'transfer_failed' && pa2.status === 'approved', 'definite failure still reverts to approved');
  }

  // 3d. Reconciliation — "Check with Stripe".
  const NOWMS = Date.parse('2026-09-30T12:00:00.000Z');
  const unknownRow = (store: Store, opts: { claimedMsAgo?: number; leg?: string; amount?: number; marker?: string | null } = {}) => {
    const pa = seedDeal(store, { offerStatus: 'approved', paStatus: 'executing', leg: opts.leg, amount: opts.amount });
    pa.failure_reason = opts.marker === undefined ? OUTCOME_UNKNOWN_REASON : opts.marker;
    pa.executing_at = new Date(NOWMS - (opts.claimedMsAgo ?? 10 * 60_000)).toISOString();
    return pa;
  };
  const reconDeps = (lookup: TransferLookup) => {
    const audits: { action: string; metadata?: Record<string, unknown> }[] = [];
    const promos: string[] = [];
    const deps: Required<ReconcileDeps> = {
        lookup: async (): Promise<TransferLookup> => lookup,
        audit: async (e: { action: string; metadata?: Record<string, unknown> }) => {
          audits.push(e);
        },
        sendPromoMaterials: async (_sb: SupabaseClient, o: { creatorOfferId: string }) => {
          promos.push(o.creatorOfferId);
        },
        now: () => new Date(NOWMS),
        mode: (): PaymentMode => 'stripe_test',
    };
    return { audits, promos, deps };
  };
  const tr = (over: Record<string, unknown> = {}) => ({ id: 'tr_found', amount_minor: 10000, amount_reversed_minor: 0, reversed: false, destination: 'acct_1', ...over });
  {
    const store = makeStore();
    const pa = unknownRow(store);
    const d = reconDeps({ ok: true, transfers: [tr()] });
    const r = await reconcilePaymentOutcome(store.sb, 'pa-1', { callerFirmId: FIRM }, d.deps);
    assert(r.outcome === 'completed', `transfer found → completed (got ${r.outcome})`);
    assert(pa.status === 'completed' && pa.payment_provider_id === 'tr_found' && pa.failure_reason == null, `…row completed with the transfer id (got ${String(pa.status)}/${String(pa.payment_provider_id)})`);
    assert(store.getOffer('offer-1')?.status === 'paid', `…deal settled (got ${String(store.getOffer('offer-1')?.status)})`);
    assert(d.promos.length === 1, '…promo pack sent once');
    assert(d.audits.some((a) => a.action === 'payment.reconciled_completed'), '…audited');
  }
  {
    const store = makeStore();
    const pa = unknownRow(store);
    const d = reconDeps({ ok: true, transfers: [] });
    const r = await reconcilePaymentOutcome(store.sb, 'pa-1', { callerFirmId: FIRM }, d.deps);
    assert(r.outcome === 'not_sent', `no transfer at Stripe → not_sent (got ${r.outcome})`);
    assert(pa.status === 'failed' && pa.failure_reason === CONFIRMED_NOT_SENT_REASON, `…row failed + ${CONFIRMED_NOT_SENT_REASON} (got ${String(pa.status)}/${String(pa.failure_reason)})`);
    assert(retryRefusal(pa as never) === null, '…and a human Retry is now allowed');
    assert(store.getOffer('offer-1')?.status === 'approved', '…deal untouched');
    assert(d.audits.some((a) => a.action === 'payment.reconciled_not_sent'), '…audited');
  }
  for (const [label, lookup, why] of [
    ['lookup failed', { ok: false, error: 'socket hang up' }, 'lookup_failed'],
    ['two transfers', { ok: true, transfers: [tr(), tr({ id: 'tr_other' })] }, 'multiple_transfers'],
    ['amount mismatch', { ok: true, transfers: [tr({ amount_minor: 8000 })] }, 'amount_mismatch'],
    ['reversed', { ok: true, transfers: [tr({ reversed: true, amount_reversed_minor: 10000 })] }, 'transfer_reversed'],
  ] as [string, TransferLookup, string][]) {
    const store = makeStore();
    const pa = unknownRow(store);
    const d = reconDeps(lookup);
    const r = await reconcilePaymentOutcome(store.sb, 'pa-1', { callerFirmId: FIRM }, d.deps);
    assert(r.outcome === 'still_unknown' && r.reason === why, `${label} → still_unknown/${why} (got ${r.outcome}/${'reason' in r ? String(r.reason) : ''})`);
    assert(pa.status === 'executing', `${label}: row stays executing`);
    if (why !== 'lookup_failed') assert(d.audits.some((a) => a.action === 'payment.reconcile_mismatch'), `${label}: audited payment.reconcile_mismatch`);
  }
  {
    // Too soon to trust "not found": Stripe may still be processing the request.
    const store = makeStore();
    const pa = unknownRow(store, { claimedMsAgo: 30_000 });
    const r = await reconcilePaymentOutcome(store.sb, 'pa-1', { callerFirmId: FIRM }, reconDeps({ ok: true, transfers: [] }).deps);
    assert(r.outcome === 'still_unknown' && r.reason === 'too_soon', `not found 30s after the claim → too_soon (got ${r.outcome})`);
    assert(pa.status === 'executing', '…row untouched');
  }
  {
    // A live, unmarked claim that is not yet stale is somebody else's.
    const store = makeStore();
    const pa = unknownRow(store, { claimedMsAgo: 60_000, marker: null });
    const r = await reconcilePaymentOutcome(store.sb, 'pa-1', { callerFirmId: FIRM }, reconDeps({ ok: true, transfers: [tr()] }).deps);
    assert(r.outcome === 'not_applicable', `in-flight claim → not_applicable (got ${r.outcome})`);
    assert(pa.status === 'executing', '…untouched');
  }
  {
    const store = makeStore();
    seedDeal(store, { offerStatus: 'approved', paStatus: 'approved' });
    const r = await reconcilePaymentOutcome(store.sb, 'pa-1', { callerFirmId: FIRM }, reconDeps({ ok: true, transfers: [] }).deps);
    assert(r.outcome === 'not_applicable', `not executing → not_applicable (got ${r.outcome})`);
    const s2 = makeStore();
    unknownRow(s2);
    const x = await reconcilePaymentOutcome(s2.sb, 'pa-1', { callerFirmId: 'firm-other' }, reconDeps({ ok: true, transfers: [] }).deps);
    assert(x.outcome === 'forbidden', `cross-firm check refused (got ${x.outcome})`);
    const b = await reconcilePaymentOutcome(s2.sb, 'pa-1', { callerFirmId: '' }, reconDeps({ ok: true, transfers: [] }).deps);
    assert(b.outcome === 'forbidden', 'blank firm refused');
  }
  {
    // Lookup is by the leg-scoped key (= transfer_group).
    const store = makeStore();
    unknownRow(store, { leg: 'balance', amount: 50 });
    store.getOffer('offer-1')!.status = 'posted';
    store.getOffer('offer-1')!.deposit_paid_usd = 50;
    let asked = '';
    const d = reconDeps({ ok: true, transfers: [] });
    d.deps.lookup = async (g: string): Promise<TransferLookup> => {
      asked = g;
      return { ok: true, transfers: [tr({ amount_minor: 5000 })] };
    };
    const r = await reconcilePaymentOutcome(store.sb, 'pa-1', { callerFirmId: FIRM }, d.deps);
    assert(asked === 'pa-1.balance', `looks up transfer_group pa-1.balance (got ${asked})`);
    assert(r.outcome === 'completed' && store.getOffer('offer-1')?.status === 'balance_paid', 'balance reconciles to balance_paid');
    assert(d.promos.length === 0, 'balance reconcile sends no promo');
  }

  // 3e. The reclaimer reconciles instead of blind-reverting (stripe modes).
  {
    const mk = (lookup: TransferLookup) => {
      const store = makeStore();
      const pa = unknownRow(store, { claimedMsAgo: STALE_EXECUTING_MS + 60_000, marker: null });
      return { store, pa, d: reconDeps(lookup) };
    };
    const found = mk({ ok: true, transfers: [tr()] });
    const t1 = await runPaymentReclaim(found.store.sb, { now: NOWMS, audit: async () => {}, reconcileDeps: found.d.deps });
    assert(found.pa.status === 'completed', `reclaimer + transfer found → completed (got ${String(found.pa.status)})`);
    assert(t1.reconciled === 1, `…tally.reconciled (got ${String(t1.reconciled)})`);
    const none = mk({ ok: true, transfers: [] });
    await runPaymentReclaim(none.store.sb, { now: NOWMS, audit: async () => {}, reconcileDeps: none.d.deps });
    assert(none.pa.status === 'failed' && none.pa.failure_reason === CONFIRMED_NOT_SENT_REASON, `reclaimer + no transfer → failed/retryable, NOT approved (got ${String(none.pa.status)})`);
    const down = mk({ ok: false, error: 'down' });
    await runPaymentReclaim(down.store.sb, { now: NOWMS, audit: async () => {}, reconcileDeps: down.d.deps });
    assert(down.pa.status === 'executing' && down.pa.failure_reason === OUTCOME_UNKNOWN_REASON, `reclaimer + Stripe unreachable → stays executing, marked unknown (got ${String(down.pa.status)}/${String(down.pa.failure_reason)})`);
    // paypal: no reconciliation exists → never blind-revert.
    const pp = mk({ ok: true, transfers: [] });
    pp.d.deps.mode = () => 'paypal_sandbox';
    await runPaymentReclaim(pp.store.sb, { now: NOWMS, audit: async () => {}, reconcileDeps: pp.d.deps });
    assert(pp.pa.status === 'executing', `paypal stale claim is not blind-reverted (got ${String(pp.pa.status)})`);
    // paper: nothing can have moved → the old revert to approved stands.
    const paper = mk({ ok: true, transfers: [] });
    paper.d.deps.mode = () => 'paper';
    await runPaymentReclaim(paper.store.sb, { now: NOWMS, audit: async () => {}, reconcileDeps: paper.d.deps });
    assert(paper.pa.status === 'approved', `paper stale claim → approved as before (got ${String(paper.pa.status)})`);
  }

  // 3f. Surfaced on /anomalies with a "Check with Stripe" action.
  {
    const base: AnomaliesInput = {
      offers: [{ id: 'offer-1', campaign_influencer_id: 'ci-1', campaign_id: CAMPAIGN, status: 'approved', injection_flagged: false, updated_at: '2026-09-30T11:00:00.000Z', current_offer_usd: 100 }],
      payments: [], deliveries: [], audit: [], inbound: [], cis: [], influencers: [], campaigns: [], hasContractTemplate: true,
    };
    const fresh = detectAnomalies({
      ...base,
      executing: [{ id: 'pa-1', creator_offer_id: 'offer-1', campaign_id: CAMPAIGN, amount_usd: 100, executing_at: new Date(NOWMS - 60_000).toISOString(), created_at: '2026-09-30T11:00:00.000Z', failure_reason: OUTCOME_UNKNOWN_REASON }],
    }, NOWMS);
    const row = fresh.find((r) => r.ref === 'stuck-pa-1');
    assert(row != null, 'outcome-unknown row surfaces immediately, not after 15 minutes');
    assert(row?.category === 'payment_anomaly' && row.check_stripe_payment_id === 'pa-1', '…in the money lane with check_stripe_payment_id');
    assert(/do not retry|don’t retry|not retry/i.test(row?.detail ?? ''), `…detail says not to retry (got ${String(row?.detail)})`);
    const stale = detectAnomalies({
      ...base,
      executing: [{ id: 'pa-2', creator_offer_id: 'offer-1', campaign_id: CAMPAIGN, amount_usd: 100, executing_at: new Date(NOWMS - STALE_EXECUTING_MS - 60_000).toISOString(), created_at: 'x', failure_reason: null }],
    }, NOWMS);
    assert(stale.find((r) => r.ref === 'stuck-pa-2')?.check_stripe_payment_id === 'pa-2', 'stale executing row also offers Check with Stripe');
    const inflight = detectAnomalies({
      ...base,
      executing: [{ id: 'pa-3', creator_offer_id: 'offer-1', campaign_id: CAMPAIGN, amount_usd: 100, executing_at: new Date(NOWMS - 60_000).toISOString(), created_at: 'x', failure_reason: null }],
    }, NOWMS);
    assert(!inflight.some((r) => r.ref === 'stuck-pa-3'), 'a live, unmarked claim is not an anomaly');
    const failedRow = detectAnomalies({
      ...base,
      payments: [{ id: 'pa-4', creator_offer_id: 'offer-1', campaign_id: CAMPAIGN, status: 'failed', failure_reason: CONFIRMED_NOT_SENT_REASON, amount_usd: 100, created_at: 'x', executed_at: null }],
    }, NOWMS).find((r) => r.ref === 'payment-pa-4');
    assert(failedRow != null && /Stripe/.test(failedRow.detail ?? '') && !/could not complete/.test(failedRow.detail ?? ''), `confirmed-not-sent row has its own copy (got ${String(failedRow?.detail)})`);

    const route = read('app/api/anomalies/stripe-check/route.ts');
    assert(route.includes('requireOperator(') && route.includes('reconcilePaymentOutcome('), 'stripe-check route: operator-only, calls reconcilePaymentOutcome');
    assert(route.includes('callerFirmId: session.firm_id'), 'stripe-check route: firm-scoped');
    const api = read('app/api/anomalies/route.ts');
    assert(/executing_at[\s\S]{0,80}failure_reason|failure_reason[\s\S]{0,80}executing_at/.test(api), 'anomalies route selects failure_reason on executing rows');
    const page = read('app/anomalies/page.tsx');
    assert(page.includes('/api/anomalies/stripe-check') && page.includes('Check with Stripe'), 'anomalies page has the Check with Stripe action');
  }
  assert(OUTCOME_UNKNOWN_FAILURE === OUTCOME_UNKNOWN_REASON, 'statuses literal pinned to payment-claim OUTCOME_UNKNOWN_REASON');
  assert(MIN_NOT_FOUND_AGE_MS > 0 && MIN_NOT_FOUND_AGE_MS < STALE_EXECUTING_MS, 'not-found age floor is positive and below the stale threshold');
  // All Stripe HTTP stays inside the isolated client.
  assert(!/api\.stripe\.com/.test(read('lib/payment-reconcile.ts') + read('lib/payment-reclaim.ts')), 'reconcile/reclaim never call Stripe directly');
}

/** 054's committed_states and amount fold, read from the migration itself. */
function budgetGuard054() {
  const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '054_budget_guard_split_states.sql'), 'utf8');
  const m = sql.match(/committed_states text\[\] := array\[([\s\S]*?)\];/);
  const states = (m?.[1] ?? '').match(/'([a-z_]+)'/g)?.map((x) => x.slice(1, -1)) ?? [];
  return {
    states,
    contribution: (o: Row) =>
      !states.includes(String(o.status))
        ? 0
        : o.status === 'undelivered'
          ? Number(o.deposit_paid_usd ?? 0)
          : Number(o.agreed_amount_usd ?? o.current_offer_usd ?? 0),
  };
}

async function section4() {
  console.log('\n4. stopping a leg never drops money that already left out of the budget guard');
  const guard = budgetGuard054();
  assert(guard.states.includes('posted') && guard.states.includes('undelivered') && !guard.states.includes('rejected'), `054 committed_states parsed (${guard.states.join(',')})`);

  const seedPosted = (store: Store, opts: { depositPaid: number | null; depositRow: boolean; balStatus: string }) => {
    store.seed('creator_offers', {
      id: 'offer-1', firm_id: FIRM, campaign_id: CAMPAIGN, campaign_influencer_id: 'ci-1',
      status: 'posted', agreed_amount_usd: 100, deposit_paid_usd: opts.depositPaid,
    });
    if (opts.depositRow) {
      store.seed('payment_authorizations', { id: 'pa-dep', firm_id: FIRM, creator_offer_id: 'offer-1', amount_usd: 50, status: 'completed', leg: 'deposit', payment_provider_id: 'tr_d', human_approved_at: 'x', human_approved_by_user_id: 'u' });
    }
    const approved = opts.balStatus !== 'pending_human_review';
    return store.seed('payment_authorizations', {
      id: 'pa-bal', firm_id: FIRM, creator_offer_id: 'offer-1', amount_usd: 50, status: opts.balStatus, leg: 'balance',
      payment_provider_id: null, failure_reason: null,
      human_approved_at: approved ? 'x' : null, human_approved_by_user_id: approved ? 'u' : null,
    });
  };
  // T4 — reject (pending) and revoke (approved) of the balance, deposit paid.
  for (const balStatus of ['pending_human_review', 'approved']) {
    for (const [label, depositPaid, depositRow] of [
      ['recorded deposit + completed row', 50, true],
      ['recorded deposit only', 50, false],
      ['completed deposit row only', null, true],
    ] as [string, number | null, boolean][]) {
      const store = makeStore();
      const bal = seedPosted(store, { depositPaid, depositRow, balStatus });
      const before = guard.contribution(store.getOffer('offer-1')!);
      const r = await rejectPaymentAuthorization(store.sb, { id: 'pa-bal', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
      const offer = store.getOffer('offer-1')!;
      assert(r.httpStatus === 200 && bal.status === 'rejected', `${balStatus}/${label}: balance leg stopped (got ${r.httpStatus}/${String(bal.status)})`);
      assert(offer.status !== 'rejected', `${balStatus}/${label}: deal NOT set rejected (got ${String(offer.status)})`);
      assert(guard.states.includes(String(offer.status)), `${balStatus}/${label}: deal stays in 054 committed_states (got ${String(offer.status)})`);
      assert(guard.contribution(offer) >= 50, `${balStatus}/${label}: the paid $50 still counts (got ${guard.contribution(offer)})`);
      assert(guard.contribution(offer) <= before, `${balStatus}/${label}: contribution never rises on a stop`);
    }
  }
  // Legacy: the pre-fix approve route wrote 'approved' over 'posted' on balance
  // legs, so a deposit-paid deal can sit in 'approved' — a closable status.
  // The money-moved check is what keeps it counted there.
  for (const [label, depositPaid, depositRow] of [
    ['recorded deposit', 50, false],
    ['completed deposit row', null, true],
  ] as [string, number | null, boolean][]) {
    const store = makeStore();
    seedPosted(store, { depositPaid, depositRow, balStatus: 'pending_human_review' });
    store.getOffer('offer-1')!.status = 'approved';
    const r = await rejectPaymentAuthorization(store.sb, { id: 'pa-bal', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    const offer = store.getOffer('offer-1')!;
    assert(r.httpStatus === 200 && offer.status === 'approved', `legacy 'approved' balance deal (${label}): stop keeps it (got ${String(offer.status)})`);
    assert(guard.contribution(offer) >= 50, `legacy (${label}): paid deposit still counted`);
    assert(r.body.deal_after_stop === 'kept_money_moved', `legacy (${label}): reports kept_money_moved`);
  }
  // No money moved on the deal → a stop still closes it, as before.
  {
    const store = makeStore();
    seedDeal(store, { offerStatus: 'human_approval_required', paStatus: 'pending_human_review' });
    const r = await rejectPaymentAuthorization(store.sb, { id: 'pa-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    assert(r.httpStatus === 200 && store.getOffer('offer-1')?.status === 'rejected', 'unpaid deal: reject still closes it');
  }
  {
    const store = makeStore();
    seedDeal(store, { offerStatus: 'approved', paStatus: 'approved' });
    const r = await rejectPaymentAuthorization(store.sb, { id: 'pa-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    assert(r.httpStatus === 200 && store.getOffer('offer-1')?.status === 'rejected', 'unpaid deal: revoke still closes it');
  }
  // A stop never regresses a paid state to rejected, even with no money on the row.
  for (const st of ['paid', 'balance_paid', 'measured']) {
    const store = makeStore();
    seedDeal(store, { offerStatus: st, paStatus: 'pending_human_review' });
    await rejectPaymentAuthorization(store.sb, { id: 'pa-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    assert(store.getOffer('offer-1')?.status === st, `stop on a '${st}' deal leaves it '${st}'`);
  }
}

async function section5() {
  console.log('\n5. a payment that failed to reach /approvals is never silent');
  const auditsOf = () => {
    const audits: { action: string; target_id: string; metadata?: Record<string, unknown> }[] = [];
    return { audits, hooks: { audit: async (e: { action: string; target_id: string; metadata?: Record<string, unknown> }) => { audits.push(e); } } };
  };
  const postedDeal = (store: Store, over: Row = {}) => {
    store.seed('firms', { id: FIRM, require_delivery_before_balance: true, deposit_pct: 50 });
    return store.seed('creator_offers', {
      id: 'offer-1', firm_id: FIRM, campaign_id: CAMPAIGN, campaign_influencer_id: 'ci-1', status: 'posted',
      agreed_amount_usd: 100, ceiling_usd: 200, deposit_paid_usd: 50, balance_paid_usd: null, ...over,
    });
  };

  // 5a. The post route's balance mint: a non-2xx is audited, not dropped.
  {
    const store = makeStore();
    postedDeal(store, { deposit_paid_usd: 100 }); // nothing left → 409 leg_has_no_amount
    const a = auditsOf();
    const r = await mintBalanceAfterPost(store.sb, { offer: store.getOffer('offer-1') as never, callerFirmId: FIRM, actorUserId: 'u' }, a.hooks);
    assert(r.minted === false, 'non-2xx mint → minted:false');
    const f = a.audits.find((x) => x.action === 'payment.balance_authorization_failed');
    assert(f != null, `non-2xx balance mint audited (got ${a.audits.map((x) => x.action).join(',')})`);
    assert(f?.metadata?.http_status === 409, `…with the http status (got ${String(f?.metadata?.http_status)})`);
  }
  {
    const store = makeStore();
    postedDeal(store);
    const a = auditsOf();
    const broken = { from: () => { throw new Error('db down'); } } as unknown as SupabaseClient;
    const r = await mintBalanceAfterPost(broken, { offer: store.getOffer('offer-1') as never, callerFirmId: FIRM, actorUserId: 'u' }, a.hooks);
    assert(r.minted === false && a.audits.some((x) => x.action === 'payment.balance_authorization_failed'), 'thrown mint audited too');
  }
  {
    const store = makeStore();
    postedDeal(store);
    const a = auditsOf();
    const r = await mintBalanceAfterPost(store.sb, { offer: store.getOffer('offer-1') as never, callerFirmId: FIRM, actorUserId: 'u' }, a.hooks);
    assert(r.minted === true && !a.audits.some((x) => x.action === 'payment.balance_authorization_failed'), 'successful mint: no failure audit');
    const none = makeStore();
    postedDeal(none, { deposit_paid_usd: null });
    const n = await mintBalanceAfterPost(none.sb, { offer: none.getOffer('offer-1') as never, callerFirmId: FIRM, actorUserId: 'u' }, auditsOf().hooks);
    assert(n.minted === false && n.skipped === true, 'no balance due → skipped, not a failure');
  }
  {
    const route = read('app/api/campaigns/[id]/deals/[offer_id]/post/route.ts');
    assert(route.includes('mintBalanceAfterPost('), 'post route mints through mintBalanceAfterPost');
    const neg = read('lib/negotiation.ts');
    const catchBlock = neg.slice(neg.indexOf("console.warn('[negotiation] payment-auth automint failed'") - 600, neg.indexOf("console.warn('[negotiation] payment-auth automint failed'") + 400);
    assert(/catch \(e\)[\s\S]*negotiation\.payment_auth_automint_failed/.test(catchBlock), 'a THROWN automint is audited too, not only logged');
  }

  // 5b. Authorize never resurrects a live leg (the re-mint action relies on it).
  for (const st of ['approved', 'executing', 'completed']) {
    const store = makeStore();
    postedDeal(store);
    const existing = store.seed('payment_authorizations', {
      id: 'pa-bal', firm_id: FIRM, campaign_id: CAMPAIGN, creator_offer_id: 'offer-1', leg: 'balance', amount_usd: 50, status: st,
      human_approved_at: 'x', human_approved_by_user_id: 'u',
    });
    const r = await authorizePaymentForOffer(store.sb, { creatorOfferId: 'offer-1', callerFirmId: FIRM, leg: 'balance' }, noAudit);
    assert(r.httpStatus === 409 && r.body.error === 'leg_in_flight', `existing '${st}' balance leg → 409 leg_in_flight (got ${r.httpStatus} ${String(r.body.error)})`);
    assert(existing.status === st && existing.human_approved_at === 'x', `…'${st}' row untouched`);
  }

  // 5c. The operator re-mint ("Create payment for approval").
  {
    const store = makeStore();
    postedDeal(store);
    const r = await remintPaymentForOffer(store.sb, { offerId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    const rows = store.all('payment_authorizations');
    assert(r.httpStatus === 200 && rows.length === 1 && rows[0].leg === 'balance' && Number(rows[0].amount_usd) === 50, `posted deal, no balance leg → balance minted for 50 (got ${r.httpStatus} ${JSON.stringify(rows.map((x) => [x.leg, x.amount_usd]))})`);
    assert(rows[0].status === 'pending_human_review', '…pending human review (lands in /approvals)');
    const again = await remintPaymentForOffer(store.sb, { offerId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    assert(again.httpStatus === 409 && again.body.error === 'already_queued', `second click → 409 already_queued (got ${again.httpStatus} ${String(again.body.error)})`);
    assert(store.all('payment_authorizations').length === 1, '…no second row');
  }
  {
    const store = makeStore();
    store.seed('firms', { id: FIRM, require_delivery_before_balance: false, deposit_pct: 50 });
    store.seed('creator_offers', { id: 'offer-1', firm_id: FIRM, campaign_id: CAMPAIGN, status: 'human_approval_required', agreed_amount_usd: 100, ceiling_usd: 200, deposit_paid_usd: null, balance_paid_usd: null });
    const r = await remintPaymentForOffer(store.sb, { offerId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    const rows = store.all('payment_authorizations');
    assert(r.httpStatus === 200 && rows.length === 1 && rows[0].leg === 'full' && Number(rows[0].amount_usd) === 100, `awaiting-approval deal with no leg → full leg minted (got ${r.httpStatus})`);
  }
  for (const st of ['rejected', 'paid', 'balance_paid', 'approved']) {
    const store = makeStore();
    postedDeal(store, { status: st });
    const r = await remintPaymentForOffer(store.sb, { offerId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    assert(r.httpStatus === 409 && r.body.error === 'nothing_to_mint', `'${st}' deal → 409 nothing_to_mint (got ${r.httpStatus} ${String(r.body.error)})`);
    assert(store.all('payment_authorizations').length === 0, `'${st}': no row`);
  }
  {
    const store = makeStore();
    postedDeal(store);
    const x = await remintPaymentForOffer(store.sb, { offerId: 'offer-1', callerFirmId: 'firm-other', actorUserId: 'u' }, noAudit);
    assert(x.httpStatus === 403 || x.httpStatus === 404, `cross-firm re-mint refused (got ${x.httpStatus})`);
    const b = await remintPaymentForOffer(store.sb, { offerId: 'offer-1', callerFirmId: '', actorUserId: 'u' }, noAudit);
    assert(b.httpStatus !== 200, 'blank firm refused');
    assert(store.all('payment_authorizations').length === 0, 'refusals wrote nothing');
  }

  // 5d. The gap is computed once, in a pure helper the deal surfaces share.
  {
    const leg = (over: Partial<Row>) => ({ id: 'l', leg: 'full', status: 'pending_human_review', amount_usd: 1, failure_reason: null, payment_mode: null, payment_provider_id: null, human_approved_at: null, ...over }) as never;
    assert(approvalQueueGap({ status: 'human_approval_required' }, []) === 'first', 'awaiting approval, no leg → gap first');
    assert(approvalQueueGap({ status: 'human_approval_required' }, [leg({})]) === null, 'awaiting approval, pending leg → no gap');
    assert(approvalQueueGap({ status: 'human_approval_required' }, [leg({ status: 'failed', failure_reason: 'legs_exceed_agreed' })]) === 'first', 'only a dead (non-retryable, unsent) leg → gap first');
    assert(approvalQueueGap({ status: 'human_approval_required' }, [leg({ status: 'rejected' })]) === null, 'a leg a human rejected → not a gap (it was a decision)');
    assert(approvalQueueGap({ status: 'posted', deposit_paid_usd: 50, balance_paid_usd: null }, [leg({ leg: 'deposit', status: 'completed' })]) === 'balance', 'posted, deposit paid, no balance leg → gap balance');
    assert(approvalQueueGap({ status: 'posted', deposit_paid_usd: 50, balance_paid_usd: null }, [leg({ leg: 'balance' })]) === null, 'posted with a pending balance → no gap');
    assert(approvalQueueGap({ status: 'posted', deposit_paid_usd: null, balance_paid_usd: null }, []) === null, 'posted on the single-payment path → no gap');
    assert(approvalQueueGap({ status: 'approved' }, []) === null, 'approved → no gap');
    assert(approvalQueueGap({ status: 'posted', deposit_paid_usd: 50, balance_paid_usd: null }, [leg({ leg: 'balance', status: 'rejected', failure_reason: 'revoked_before_payout' })]) === null, 'balance a human stopped → not a gap (it was a decision)');

    assert(!/Sending/.test(legStatusText(leg({ status: 'executing', failure_reason: OUTCOME_UNKNOWN_REASON }), null)), 'an outcome-unknown leg does not read "Sending…"');
    assert(legStatusText(leg({ status: 'executing' }), null) === 'Sending…', 'a live claim still reads "Sending…"');
    const dealsApi = read('app/api/campaigns/[id]/deals/route.ts');
    assert(dealsApi.includes('approvalQueueGap(') && dealsApi.includes('approval_gap'), 'deals API exposes approval_gap');
    const dealRow = read('app/campaigns/[id]/deals/DealRow.tsx');
    assert(dealRow.includes('approval_gap') && dealRow.includes('/api/payments/remint'), 'DealRow offers the re-mint when there is a gap');
    const dealsPage = read('app/campaigns/[id]/deals/page.tsx');
    assert(/approval_gap/.test(dealsPage), 'deal badge does not say "Awaiting approval" when nothing is queued');
    const remint = read('app/api/payments/remint/route.ts');
    assert(remint.includes('requireSession') && remint.includes('remintPaymentForOffer(') && remint.includes('callerFirmId: session.firm_id'), 'remint route: session + firm-scoped + lib');
  }

  // 5e. /anomalies: both failures surface, with the action, and clear once fixed.
  {
    const offersFor = (status: string) => [{ id: 'offer-1', campaign_influencer_id: 'ci-1', campaign_id: CAMPAIGN, status, injection_flagged: false, updated_at: '2026-09-30T11:00:00.000Z', current_offer_usd: 100 }];
    const audit = (id: string, action: string, at: string) => ({ id, occurred_at: at, action, target_type: 'creator_offer', target_id: 'offer-1', metadata: { http_status: 409 } });
    const base = (status: string, legs: { creator_offer_id: string; leg: string; status: string; failure_reason?: string | null }[], moneyAudit: ReturnType<typeof audit>[]): AnomaliesInput => ({
      offers: offersFor(status), payments: [], deliveries: [], audit: [], inbound: [], cis: [], influencers: [], campaigns: [], hasContractTemplate: true,
      moneyAudit: moneyAudit as never, offerLegs: legs,
    });
    const nowMs = Date.parse('2026-09-30T12:00:00.000Z');
    const am = [audit('a1', 'negotiation.payment_auth_automint_failed', '2026-09-30T10:00:00.000Z'), audit('a2', 'negotiation.payment_auth_automint_failed', '2026-09-30T10:05:00.000Z')];
    const rows = detectAnomalies(base('human_approval_required', [], am), nowMs).filter((r) => r.mint_payment_offer_id);
    assert(rows.length === 1, `automint failure → exactly one row per deal (got ${rows.length})`);
    assert(rows[0]?.category === 'payment_anomaly' && rows[0].mint_payment_offer_id === 'offer-1', '…money lane, with the Create-payment action');
    assert(/approvals/i.test(rows[0]?.what + ' ' + rows[0]?.detail), `…says nothing is in Approvals (got ${rows[0]?.what})`);
    assert(detectAnomalies(base('human_approval_required', [{ creator_offer_id: 'offer-1', leg: 'full', status: 'pending_human_review' }], am), nowMs).every((r) => !r.mint_payment_offer_id), 'clears once a leg is queued');
    assert(detectAnomalies(base('rejected', [], am), nowMs).every((r) => !r.mint_payment_offer_id), 'clears once the deal moved on');
    const bm = [audit('b1', 'payment.balance_authorization_failed', '2026-09-30T10:00:00.000Z')];
    const brow = detectAnomalies(base('posted', [{ creator_offer_id: 'offer-1', leg: 'deposit', status: 'completed' }], bm), nowMs).filter((r) => r.mint_payment_offer_id);
    assert(brow.length === 1, 'balance mint failure → one row');
    assert(detectAnomalies(base('posted', [{ creator_offer_id: 'offer-1', leg: 'balance', status: 'pending_human_review' }], bm), nowMs).every((r) => !r.mint_payment_offer_id), 'balance row clears once the balance is queued');
    const api = read('app/api/anomalies/route.ts');
    assert(api.includes('offerLegs'), 'anomalies route passes the offer legs');
    const page = read('app/anomalies/page.tsx');
    assert(page.includes('Create payment for approval') && page.includes('/api/payments/remint'), 'anomalies page: Create payment for approval');
  }
}

// ─── Part 3 ───

/** Migration 009's human_approval_required_for_execute, verbatim from prod. */
const approvalCheckHolds = (r: Row) =>
  (['pending_human_review', 'rejected'].includes(r.status as string) && r.human_approved_at == null) ||
  (['approved', 'executing', 'completed', 'failed'].includes(r.status as string) &&
    r.human_approved_at != null &&
    r.human_approved_by_user_id != null);

/**
 * A store that enforces what the in-memory mock does not: the 009 CHECK on
 * every payment_authorizations write (insert, update, upsert), post-055
 * uniqueness on insert — the ONLY unique key is (creator_offer_id, leg) — and,
 * for any upsert, ON CONFLICT (creator_offer_id) failing the way Postgres fails
 * it (42P10). Records every write: 'insert', 'update', or the upsert target.
 */
function checkedStore() {
  const store = makeStore();
  const upserts: string[] = [];
  const realFrom = store.sb.from.bind(store.sb);
  const fail = (message: string, code?: string) => {
    const r = { data: null, error: { message, ...(code ? { code } : {}) } };
    const chain: Record<string, unknown> = {
      select: () => chain,
      single: async () => r,
      maybeSingle: async () => r,
      then: (f: (v: typeof r) => unknown) => Promise.resolve(r).then(f),
    };
    return chain;
  };
  const CHECK_MSG = 'new row for relation "payment_authorizations" violates check constraint "human_approval_required_for_execute"';
  const sb = {
    from(table: string) {
      const q = realFrom(table) as unknown as Record<string, unknown>;
      if (table !== 'payment_authorizations') return q;
      const origInsert = (q.insert as (p: Row) => unknown).bind(q);
      q.insert = (p: Row) => {
        upserts.push('insert');
        if (store.all(table).some((r) => r.creator_offer_id === p.creator_offer_id && r.leg === p.leg)) {
          return fail('duplicate key value violates unique constraint "payment_authorizations_offer_leg_key"', '23505');
        }
        if (!approvalCheckHolds(p)) return fail(CHECK_MSG);
        return origInsert(p);
      };
      const origUpdate = (q.update as (p: Row) => unknown).bind(q);
      q.update = (p: Row) => {
        upserts.push('update');
        const chain = origUpdate(p) as Record<string, unknown>;
        // Evaluate the CHECK on the rows the UPDATE actually produced; roll
        // back and fail the statement if any violates it, as Postgres would.
        for (const term of ['single', 'maybeSingle', 'then']) {
          const orig = (chain[term] as (...a: unknown[]) => Promise<unknown>).bind(chain);
          chain[term] = (...a: unknown[]) => {
            const rows = store.all(table);
            const snap = rows.map((r) => ({ ...r }));
            const guarded = (async () => {
              const res = await orig();
              if (rows.some((r) => !approvalCheckHolds(r))) {
                rows.forEach((r, i) => {
                  for (const k of Object.keys(r)) delete r[k];
                  Object.assign(r, snap[i]);
                });
                return { data: null, error: { message: CHECK_MSG } };
              }
              return res;
            })();
            return term === 'then' ? guarded.then(a[0] as never, a[1] as never) : guarded;
          };
        }
        return chain;
      };
      const origUpsert = (q.upsert as (p: Row, o?: { onConflict?: string }) => unknown).bind(q);
      q.upsert = (p: Row, o?: { onConflict?: string }) => {
        const target = o?.onConflict ?? '';
        upserts.push(target);
        if (target !== 'creator_offer_id,leg') {
          return fail('there is no unique or exclusion constraint matching the ON CONFLICT specification');
        }
        const existing = store.all(table).find((r) => r.creator_offer_id === p.creator_offer_id && r.leg === p.leg);
        const merged = { ...(existing ?? {}), ...p };
        if (!approvalCheckHolds(merged)) {
          return fail('new row for relation "payment_authorizations" violates check constraint "human_approval_required_for_execute"');
        }
        return origUpsert(p, o);
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { ...store, sb, upserts };
}

async function section6() {
  console.log('\n6. re-mint gate, reclaimer mode, anomaly flood, outcome regression');

  const auditsOf = () => {
    const audits: { action: string; metadata?: Record<string, unknown> }[] = [];
    return { audits, hooks: { audit: async (e: { action: string; metadata?: Record<string, unknown> }) => { audits.push(e); } } };
  };
  const postedSplit = (store: { seed: Store['seed'] }, balance: Row | null) => {
    store.seed('firms', { id: FIRM, require_delivery_before_balance: true, deposit_pct: 50 });
    store.seed('creator_offers', { id: 'offer-1', firm_id: FIRM, campaign_id: CAMPAIGN, campaign_influencer_id: 'ci-1', status: 'posted', agreed_amount_usd: 100, ceiling_usd: 200, deposit_paid_usd: 50, balance_paid_usd: null });
    store.seed('payment_authorizations', { id: 'pa-dep', firm_id: FIRM, campaign_id: CAMPAIGN, creator_offer_id: 'offer-1', leg: 'deposit', amount_usd: 50, status: 'completed', payment_provider_id: 'tr_d', human_approved_at: 'x', human_approved_by_user_id: 'u' });
    if (balance) {
      store.seed('payment_authorizations', { id: 'pa-bal', firm_id: FIRM, campaign_id: CAMPAIGN, creator_offer_id: 'offer-1', leg: 'balance', amount_usd: 80, payment_provider_id: null, ...balance });
    }
  };
  const bal = (s: { all: Store['all'] }) => s.all('payment_authorizations').find((x) => x.leg === 'balance') as Row;

  // 6.1a Re-minting over a dead failed leg clears the approval stamp (a fresh
  //      human approval is the gate), keeps an audit of the old one, and passes
  //      the live CHECK — it used to 500 on it.
  for (const reason of ['legs_exceed_agreed', 'offer_not_payable']) {
    const s = checkedStore();
    postedSplit(s, { status: 'failed', failure_reason: reason, human_approved_at: '2026-09-29T10:00:00.000Z', human_approved_by_user_id: 'user_old' });
    const a = auditsOf();
    const r = await remintPaymentForOffer(s.sb, { offerId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u' }, a.hooks);
    const row = bal(s);
    assert(r.httpStatus === 200, `[${reason}] re-mint over a dead failed balance → 200 (got ${r.httpStatus} ${String(r.body.error)})`);
    assert(row.status === 'pending_human_review' && row.human_approved_at == null && row.human_approved_by_user_id == null, `[${reason}] …pending with NO approval stamp (got ${String(row.status)} / ${String(row.human_approved_at)})`);
    assert(approvalCheckHolds(row), `[${reason}] …passes the 009 CHECK`);
    assert(row.failure_reason == null && Number(row.amount_usd) === 50, `[${reason}] …old failure cleared, re-sized to 50 (got ${String(row.failure_reason)} ${String(row.amount_usd)})`);
    assert(s.upserts.join(',') === 'update', `[${reason}] …one compare-and-set UPDATE of that row, no upsert (got ${s.upserts.join(' | ')})`);
    const created = a.audits.find((x) => x.action === 'payment.authorization_created');
    const replaced = (created?.metadata?.replaced ?? null) as Record<string, unknown> | null;
    const prior = (replaced?.prior_approval ?? null) as Record<string, unknown> | null;
    assert(!!replaced && replaced.prior_status === 'failed' && replaced.prior_failure_reason === reason, `[${reason}] …audit records the replaced row`);
    assert(prior?.human_approved_at === '2026-09-29T10:00:00.000Z' && prior?.human_approved_by_user_id === 'user_old', `[${reason}] …and the approval it cleared`);
  }

  // 6.1b A real error on the leg-aware insert is reported, not masked by the
  //      pre-055 fallback (a legacy insert without `leg`).
  {
    const s = checkedStore();
    postedSplit(s, null);
    const realFrom = s.sb.from.bind(s.sb);
    const sb = {
      from(table: string) {
        const q = realFrom(table) as unknown as Record<string, unknown>;
        if (table === 'payment_authorizations') {
          const orig = (q.insert as (p: Row) => unknown).bind(q);
          q.insert = (p: Row) => {
            if ('leg' in p) {
              s.upserts.push('forced-fail');
              const r = { data: null, error: { message: 'violates check constraint "x"', code: '23514' } };
              const chain: Record<string, unknown> = { select: () => chain, single: async () => r };
              return chain;
            }
            return orig(p);
          };
        }
        return q;
      },
    } as unknown as SupabaseClient;
    const r = await authorizePaymentForOffer(sb, { creatorOfferId: 'offer-1', callerFirmId: FIRM, leg: 'balance' }, noAudit);
    assert(r.httpStatus === 500 && /check constraint/.test(String(r.body.error)), `a CHECK failure on the leg insert is surfaced (got ${r.httpStatus} ${String(r.body.error)})`);
    assert(s.upserts.join(',') === 'forced-fail', `…no legacy (leg-less) insert attempt (got ${s.upserts.join(' | ')})`);
  }

  // 6.1c A leg a HUMAN stopped stays closed: no automatic path resurrects it,
  //      and the plain re-mint refuses — only the explicit re-create reopens it.
  for (const stopped of [
    { status: 'rejected', failure_reason: 'revoked_before_payout' },
    { status: 'rejected', failure_reason: 'rejected by reviewer' },
    { status: 'failed', failure_reason: 'cancelled_by_operator', human_approved_at: 'x', human_approved_by_user_id: 'u' },
  ]) {
    const tag = `${stopped.status}/${stopped.failure_reason}`;
    const leg = { leg: 'balance', ...stopped, payment_provider_id: null };
    assert(approvalQueueGap({ status: 'posted', deposit_paid_usd: 50, balance_paid_usd: null }, [leg]) === null, `[${tag}] no gap shown for a human stop`);
    assert(approvalQueueGap({ status: 'posted', deposit_paid_usd: 50, balance_paid_usd: null }, [leg], { reopenStopped: true }) === 'balance', `[${tag}] …but re-creatable on explicit request`);

    const s = checkedStore();
    postedSplit(s, { ...stopped, human_approved_at: stopped.status === 'rejected' ? null : 'x', human_approved_by_user_id: stopped.status === 'rejected' ? null : 'u' });
    const auto = await mintBalanceAfterPost(s.sb, { offer: s.getOffer('offer-1') as never, callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    assert(auto.minted === false && bal(s).status === stopped.status, `[${tag}] automatic balance mint does not resurrect it (got ${String(bal(s).status)})`);
    const plain = await remintPaymentForOffer(s.sb, { offerId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    assert(plain.httpStatus === 409 && plain.body.error === 'leg_stopped', `[${tag}] plain re-mint → 409 leg_stopped (got ${plain.httpStatus} ${String(plain.body.error)})`);
    assert(bal(s).status === stopped.status, `[${tag}] …row untouched`);
    const a = auditsOf();
    const explicit = await remintPaymentForOffer(s.sb, { offerId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u', reopenStopped: true }, a.hooks);
    assert(explicit.httpStatus === 200 && bal(s).status === 'pending_human_review' && approvalCheckHolds(bal(s)), `[${tag}] explicit re-create → pending, CHECK holds (got ${explicit.httpStatus} ${String(explicit.body.error)})`);
    assert(a.audits.some((x) => x.action === 'payment.reminted' && x.metadata?.reopened_stopped === true), `[${tag}] …audited as a reopened stop`);
  }
  {
    // A stopped leg with a transfer id on file is never re-created, flag or not.
    const s = checkedStore();
    postedSplit(s, { status: 'rejected', failure_reason: 'revoked_before_payout', payment_provider_id: 'tr_x', human_approved_at: null });
    const r = await remintPaymentForOffer(s.sb, { offerId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u', reopenStopped: true }, noAudit);
    assert(r.httpStatus === 409 && bal(s).status === 'rejected', `stopped leg with a transfer on file → never re-created (got ${r.httpStatus})`);
  }

  // 6.1d The reviewer's dead end: follow the old guidance (reject, then create
  //      again). The reject is a human stop, so it now needs the explicit
  //      re-create — which works, instead of 409 nothing_to_mint.
  {
    const s = checkedStore();
    postedSplit(s, { status: 'failed', failure_reason: 'legs_exceed_agreed', human_approved_at: 'x', human_approved_by_user_id: 'u' });
    const rj = await rejectPaymentAuthorization(s.sb, { id: 'pa-bal', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    assert(rj.httpStatus === 200 && s.getOffer('offer-1')?.status === 'posted', 'reject of the dead balance: deal stays posted (deposit paid)');
    const plain = await remintPaymentForOffer(s.sb, { offerId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    assert(plain.httpStatus === 409 && plain.body.error === 'leg_stopped' && /re-create/i.test(String(plain.body.guidance)), `…plain re-mint names the explicit path (got ${plain.httpStatus} ${String(plain.body.error)})`);
    const again = await remintPaymentForOffer(s.sb, { offerId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u', reopenStopped: true }, noAudit);
    assert(again.httpStatus === 200 && Number(bal(s).amount_usd) === 50 && approvalCheckHolds(bal(s)), `…explicit re-create → 200, sized 50 (got ${again.httpStatus} ${String(again.body.error)})`);
  }

  // 6.1e The guidance matches the real path: re-create from the deal, never
  //      "reject" (rejecting a first leg closes the deal for good).
  {
    for (const f of ['lib/execute-payment.ts', 'lib/deal-errors.ts', 'lib/statuses.ts']) {
      assert(!/Reject this payment and create it again/.test(read(f)), `${f}: no "Reject this payment and create it again"`);
    }
    assert(/Create balance payment/.test(read('lib/deal-errors.ts')) && /Create balance payment/.test(read('app/campaigns/[id]/deals/DealRow.tsx')), 'deal-errors: legs_exceed_agreed names the button DealRow actually shows');
    const remint = read('app/api/payments/remint/route.ts');
    assert(/reopen_stopped/.test(remint) && /reopenStopped/.test(remint), 'remint route accepts the explicit reopen_stopped flag');
    const dealsApi = read('app/api/campaigns/[id]/deals/route.ts');
    assert(/reopenable_gap/.test(dealsApi) && /reopenStopped: true/.test(dealsApi), 'deals API exposes reopenable_gap');
    const dealRow = read('app/campaigns/[id]/deals/DealRow.tsx');
    assert(/reopenable_gap/.test(dealRow) && /reopen_stopped: true/.test(dealRow) && /window\.confirm/.test(dealRow), 'DealRow: explicit, confirmed re-create for a stopped leg');
  }

  // 6.2 The reclaimer acts on the ROW's recorded mode, never the current env's.
  const NOW2 = Date.parse('2026-09-30T12:00:00Z');
  const staleRow = (s: Store, over: Row) =>
    s.seed('payment_authorizations', {
      id: 'pa-u', firm_id: FIRM, campaign_id: CAMPAIGN, creator_offer_id: 'offer-1', leg: 'full', amount_usd: 100,
      status: 'executing', failure_reason: OUTCOME_UNKNOWN_REASON, payment_mode: 'stripe_live', payment_provider_id: null,
      executing_at: '2026-09-29T00:00:00.000Z', human_approved_at: 'x', human_approved_by_user_id: 'u', ...over,
    });
  const lookupSpy = () => {
    const calls: string[] = [];
    return { calls, lookup: async (g: string): Promise<TransferLookup> => { calls.push(g); return { ok: true, transfers: [] }; } };
  };
  const withEnv = async <T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    try { return await fn(); } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
  };
  {
    // The reviewer's scenario C: stripe_live row, env says stripe_live but the
    // key is a test key → resolves to paper. Used to revert it to 'approved'.
    const s = makeStore();
    const row = staleRow(s, {});
    const before = { ...row };
    const spy = lookupSpy();
    const a = auditsOf();
    const t = await withEnv({ PAYMENTS_MODE: 'stripe_live', STRIPE_SECRET_KEY: 'sk_test_rotated_wrong' }, () =>
      runPaymentReclaim(s.sb, { now: NOW2, audit: a.hooks.audit as never, reconcileDeps: { lookup: spy.lookup } })
    );
    assert(row.status === 'executing' && row.failure_reason === OUTCOME_UNKNOWN_REASON && row.executing_at === before.executing_at, `stripe_live outcome-unknown row under a paper fallback → untouched (got ${String(row.status)}/${String(row.failure_reason)})`);
    assert(spy.calls.length === 0, '…no Stripe call with the wrong key');
    assert(t.reclaimed === 0 && t.unreachable === 1, `…tally.unreachable (got ${JSON.stringify(t)})`);
    const an = a.audits.find((x) => x.action === 'payment.reclaim_provider_unreachable');
    assert(!!an && an.metadata?.row_mode === 'stripe_live' && an.metadata?.env_mode === 'paper', `…anomaly audited with both modes (got ${JSON.stringify(an?.metadata ?? null)})`);
  }
  for (const [rowMode, envMode] of [['stripe_live', 'stripe_test'], ['stripe_test', 'stripe_live'], ['paypal_live', 'paper'], ['paypal_sandbox', 'stripe_test']] as [string, PaymentMode][]) {
    const s = makeStore();
    const row = staleRow(s, { payment_mode: rowMode, failure_reason: null });
    const spy = lookupSpy();
    const a = auditsOf();
    const t = await runPaymentReclaim(s.sb, { now: NOW2, audit: a.hooks.audit as never, reconcileDeps: { lookup: spy.lookup, mode: () => envMode } });
    assert(row.status === 'executing' && row.failure_reason === null && spy.calls.length === 0, `row ${rowMode} under env ${envMode} → untouched, no lookup (got ${String(row.status)}/${String(row.failure_reason)}, ${spy.calls.length} calls)`);
    assert(t.unreachable === 1 && a.audits.some((x) => x.action === 'payment.reclaim_provider_unreachable'), `…surfaced as an anomaly`);
  }
  {
    // Same mode → reconciled exactly as before.
    const s = makeStore();
    seedDeal(s, { offerStatus: 'approved', paStatus: 'approved' });
    s.all('payment_authorizations').length = 0;
    const row = staleRow(s, { payment_mode: 'stripe_test' });
    const spy = lookupSpy();
    const t = await runPaymentReclaim(s.sb, { now: NOW2, audit: async () => {}, reconcileDeps: { lookup: spy.lookup, mode: () => 'stripe_test', audit: async () => {} } });
    assert(spy.calls.length === 1 && row.status === 'failed' && row.failure_reason === CONFIRMED_NOT_SENT_REASON && t.reconciled === 1, `stripe_test row under stripe_test → reconciled (got ${String(row.status)}, ${spy.calls.length} calls)`);
  }
  {
    // An unstamped row (column default 'paper') under a paper FALLBACK is not
    // provably paper: the claim may have been made while Stripe was configured.
    const s = makeStore();
    const row = staleRow(s, { payment_mode: 'paper', failure_reason: null });
    const a = auditsOf();
    const t = await withEnv({ PAYMENTS_MODE: 'stripe_test', STRIPE_SECRET_KEY: undefined }, () =>
      runPaymentReclaim(s.sb, { now: NOW2, audit: a.hooks.audit as never })
    );
    assert(row.status === 'executing' && t.unreachable === 1, `'paper' row under a stripe_test→paper fallback → untouched (got ${String(row.status)})`);
    // Configured paper → the old revert stands.
    const p = makeStore();
    const prow = staleRow(p, { payment_mode: 'paper', failure_reason: null });
    const pt = await withEnv({ PAYMENTS_MODE: 'paper' }, () => runPaymentReclaim(p.sb, { now: NOW2, audit: async () => {} }));
    assert(prow.status === 'approved' && pt.reclaimed === 1, `'paper' row under configured paper → approved as before (got ${String(prow.status)})`);
    // …but never an outcome-unknown row: that marker only exists after a Stripe call.
    const m = makeStore();
    const mrow = staleRow(m, { payment_mode: 'paper' });
    const mt = await withEnv({ PAYMENTS_MODE: 'paper' }, () => runPaymentReclaim(m.sb, { now: NOW2, audit: async () => {} }));
    assert(mrow.status === 'executing' && mrow.failure_reason === OUTCOME_UNKNOWN_REASON && mt.reclaimed === 0, `outcome-unknown row is never reverted to approved in paper (got ${String(mrow.status)})`);
  }
  {
    // The operator "Check with Stripe" path refuses the same mismatch.
    const s = makeStore();
    seedDeal(s, { offerStatus: 'approved', paStatus: 'approved' });
    s.all('payment_authorizations').length = 0;
    const row = staleRow(s, {});
    const spy = lookupSpy();
    const r = await reconcilePaymentOutcome(s.sb, 'pa-u', { callerFirmId: FIRM }, { lookup: spy.lookup, mode: () => 'stripe_test', audit: async () => {} });
    assert(r.outcome === 'still_unknown' && r.reason === 'provider_unreachable' && spy.calls.length === 0 && row.status === 'executing', `reconcile of a stripe_live row from stripe_test → provider_unreachable, no lookup (got ${r.outcome}/${'reason' in r ? r.reason : ''})`);
    assert(/provider_unreachable/.test(read('app/api/anomalies/stripe-check/route.ts')), 'stripe-check route has copy for provider_unreachable');
  }
  {
    // The anomaly reaches the money lane.
    const rows = detectAnomalies({
      offers: [], payments: [], deliveries: [], audit: [], inbound: [], cis: [], influencers: [], campaigns: [], hasContractTemplate: true,
      moneyAudit: [{ id: 'a1', occurred_at: '2026-09-30T12:00:00.000Z', action: 'payment.reclaim_provider_unreachable', target_type: 'payment_authorization', target_id: 'pa-u', metadata: { row_mode: 'stripe_live', env_mode: 'paper' } }] as never,
    } as AnomaliesInput, NOW2);
    const row = rows.find((r) => r.category === 'payment_anomaly');
    assert(!!row && /stripe_live/.test(String(row.detail)), `provider-unreachable → payment_anomaly row naming the mode (got ${row?.what ?? 'none'})`);
  }
  {
    // The mode is stamped WITH the claim, so a stranded row records where it was sent.
    const s = makeStore();
    seedDeal(s, { offerStatus: 'approved', paStatus: 'approved' });
    const c = await claimForExecution(s.sb, 'pa-1', ['approved'], { paymentMode: 'stripe_test' });
    assert(c.claimed && s.all('payment_authorizations')[0].payment_mode === 'stripe_test', 'claimForExecution stamps payment_mode with the claim');
    assert(/claimForExecution\(sb, id, (\['approved'\]|fromStatuses), \{[^}]*paymentMode/.test(read('lib/execute-payment.ts')), 'execute-payment passes the resolved mode to the claim');
  }

  // 6.3 A persistent mismatch does not flood: the reclaimer backs off instead of
  //     asking Stripe (and auditing) every hourly pass, and the lane shows one
  //     row per payment that other anomalies cannot be crowded out by.
  const HOUR = 3600e3;
  const twoTransfers = async (): Promise<TransferLookup> => ({ ok: true, transfers: [
    { id: 'tr_1', amount_minor: 10000, amount_reversed_minor: 0, reversed: false, destination: 'acct' },
    { id: 'tr_2', amount_minor: 10000, amount_reversed_minor: 0, reversed: false, destination: 'acct' }] } as TransferLookup);
  /** Audit hook that lands in the store's audit_log, as the real audit() does. */
  const storeAudit = (s: Store, at: () => number) => async (e: { action: string; target_type: string; target_id: string; metadata?: Record<string, unknown> }) => {
    s.seed('audit_log', { id: `al-${s.all('audit_log').length}`, firm_id: FIRM, occurred_at: new Date(at()).toISOString(), ...e });
  };
  {
    const s = makeStore();
    seedDeal(s, { offerStatus: 'approved', paStatus: 'approved' });
    s.all('payment_authorizations').length = 0;
    const row = staleRow(s, { id: 'pa-m', payment_mode: 'stripe_live' });
    let calls = 0;
    let t = NOW2;
    const lookup = async (g: string) => { void g; calls++; return twoTransfers(); };
    const tallies: { backedOff: number }[] = [];
    for (let h = 0; h < 5; h++) {
      t = NOW2 + h * HOUR;
      const audit = storeAudit(s, () => t);
      tallies.push(await runPaymentReclaim(s.sb, { now: t, audit: audit as never, reconcileDeps: { lookup, mode: () => 'stripe_live', audit: audit as never } }));
    }
    const mism = s.all('audit_log').filter((a) => a.action === 'payment.reconcile_mismatch');
    assert(calls === 2, `5 hourly passes over one mismatch → 2 Stripe lookups, not 5 (got ${calls})`);
    assert(mism.length === 2, `…2 mismatch audits, not 5 (got ${mism.length})`);
    assert(tallies.reduce((n, x) => n + x.backedOff, 0) === 3, `…3 passes backed off (got ${tallies.map((x) => x.backedOff).join(',')})`);
    assert(row.status === 'executing' && row.failure_reason === OUTCOME_UNKNOWN_REASON, '…row still outcome-unknown (never resolved by the backoff)');
    assert(reconcileBackoffMs(1) === 2 * HOUR && reconcileBackoffMs(10) === 24 * HOUR, `backoff doubles from 2h and caps at 24h (got ${reconcileBackoffMs(1)}, ${reconcileBackoffMs(10)})`);
    // The operator's explicit "Check with Stripe" is never backed off.
    const before = calls;
    await reconcilePaymentOutcome(s.sb, 'pa-m', { callerFirmId: FIRM }, { lookup, mode: () => 'stripe_live', audit: async () => {} });
    assert(calls === before + 1, 'operator Check with Stripe still asks Stripe while backed off');
  }
  {
    // The unreachable anomaly is backed off the same way.
    const s = makeStore();
    staleRow(s, { id: 'pa-x', payment_mode: 'stripe_live' });
    let t = NOW2;
    for (let h = 0; h < 5; h++) {
      t = NOW2 + h * HOUR;
      await runPaymentReclaim(s.sb, { now: t, audit: storeAudit(s, () => t) as never, reconcileDeps: { mode: () => 'stripe_test' } });
    }
    const n = s.all('audit_log').filter((a) => a.action === 'payment.reclaim_provider_unreachable').length;
    assert(n === 2, `5 passes over an unreachable row → 2 anomaly audits, not 5 (got ${n})`);
  }
  {
    // An unreadable audit_log means no backoff, never a skipped check.
    const s = makeStore();
    seedDeal(s, { offerStatus: 'approved', paStatus: 'approved' });
    s.all('payment_authorizations').length = 0;
    staleRow(s, { id: 'pa-m', payment_mode: 'stripe_live' });
    s.seed('audit_log', { id: 'old', firm_id: FIRM, occurred_at: new Date(NOW2 - 60_000).toISOString(), action: 'payment.reconcile_mismatch', target_type: 'payment_authorization', target_id: 'pa-m' });
    const realFrom = s.sb.from.bind(s.sb);
    const sb = { from: (tbl: string) => (tbl === 'audit_log' ? { select: () => { throw new Error('audit_log down'); } } : realFrom(tbl)) } as unknown as SupabaseClient;
    let calls = 0;
    const t = await runPaymentReclaim(sb, { now: NOW2, audit: async () => {}, reconcileDeps: { lookup: async () => { calls++; return twoTransfers(); }, mode: () => 'stripe_live', audit: async () => {} } });
    assert(calls === 1 && t.backedOff === 0, `audit_log unreadable → checks anyway (got ${calls} calls, backedOff ${t.backedOff})`);
  }
  {
    // Detector: one row per payment — latest state, first seen, count.
    const ev = (id: string, target: string, action: string, h: number, reason = 'multiple_transfers') => ({
      id, occurred_at: new Date(NOW2 + h * HOUR).toISOString(), action, target_type: 'payment_authorization', target_id: target,
      metadata: { reason, detail: 'tr_1,tr_2', transfer_group: `${target}.full`, row_mode: 'stripe_live', env_mode: 'paper' },
    });
    const moneyAudit = [
      ...[0, 1, 2, 3, 4].map((h) => ev(`m${h}`, 'pa-m', 'payment.reconcile_mismatch', h)),
      ev('u5', 'pa-m', 'payment.reclaim_provider_unreachable', 5),
      ev('o1', 'pa-2', 'payment.reconcile_mismatch', 2, 'amount_mismatch'),
      { id: 'le', occurred_at: new Date(NOW2 - 10 * HOUR).toISOString(), action: 'payment.legs_exceed_agreed', target_type: 'payment_authorization', target_id: 'pa-9', metadata: {} },
    ];
    const inp = { offers: [], payments: [], deliveries: [], audit: [], inbound: [], cis: [], influencers: [], campaigns: [], hasContractTemplate: true, moneyAudit } as unknown as AnomaliesInput;
    const rows = detectAnomalies(inp, NOW2 + 6 * HOUR).filter((r) => r.category === 'payment_anomaly');
    const pam = rows.filter((r) => r.ref.includes('pa-m'));
    assert(pam.length === 1, `6 flags on one payment → 1 row (got ${pam.length})`);
    assert(/cannot be checked/.test(pam[0]?.what ?? '') && pam[0]?.at === new Date(NOW2 + 5 * HOUR).toISOString(), `…showing the LATEST state (got ${pam[0]?.what})`);
    assert(pam[0]?.first_seen_at === new Date(NOW2).toISOString() && pam[0]?.occurrences === 6, `…with first-seen and count (got ${pam[0]?.first_seen_at} × ${pam[0]?.occurrences})`);
    assert(/6 times/.test(pam[0]?.detail ?? ''), '…and says so in the detail');
    assert(rows.filter((r) => r.ref.includes('pa-2')).length === 1, 'another payment keeps its own row');
    assert(rows.some((r) => /more than the agreed amount/.test(r.what)), 'other money anomalies still show');
    // Route: flags have their own query, scoped to live (executing) payments, so
    // a flood can no longer push other money anomalies past the fetch limit.
    const api = read('app/api/anomalies/route.ts');
    assert(/RECONCILE_FLAG_ACTIONS/.test(api) && /!RECONCILE_FLAG_ACTIONS\.includes\(/.test(api), 'anomalies route: main money query excludes the per-payment flags');
    assert(/\.in\('target_id', executingIds\)/.test(api), 'anomalies route: flags fetched only for payments still executing');
    assert(JSON.stringify([...RECLAIM_FLAG_ACTIONS].sort()) === JSON.stringify([...RECONCILE_FLAG_ACTIONS].sort()), 'reclaimer backoff and lane dedupe key on the same actions');
    assert(RECONCILE_FLAG_ACTIONS.every((x) => MONEY_ANOMALY_AUDIT_ACTIONS.includes(x)), 'every flag action is a money anomaly');
  }

  // 6.4 Recording streams never makes an owed balance unpayable, and never
  //     overwrites a state that cannot become 'measured'.
  const splitPosted = (balanceStatus: string | null, over: Row = {}) => {
    const s = makeStore();
    if (balanceStatus) {
      const approved = !['pending_human_review', 'rejected'].includes(balanceStatus);
      seedDeal(s, { offerStatus: 'posted', paStatus: balanceStatus, leg: 'balance', amount: 50, depositPaid: 50 });
      Object.assign(s.all('payment_authorizations')[0], { human_approved_at: approved ? 'x' : null, ...over });
    } else {
      seedDeal(s, { offerStatus: 'posted', paStatus: 'completed', leg: 'deposit', amount: 50, depositPaid: 50 });
      Object.assign(s.all('payment_authorizations')[0], { payment_provider_id: 'tr_d' });
    }
    Object.assign(s.all('firms')[0], { require_delivery_before_balance: true, deposit_pct: 50 });
    return s;
  };
  {
    // The reviewer's case: streams recorded while the balance waits in Approvals.
    const s = splitPosted('pending_human_review');
    const r = await markOfferMeasured(s.sb, 'offer-1');
    assert(!r.written && r.reason === 'payment_unsettled' && s.getOffer('offer-1')?.status === 'posted', `posted + pending balance → deal stays posted (got ${JSON.stringify(r)} / ${String(s.getOffer('offer-1')?.status)})`);
    const paid = await approveAndExecute(s.sb, 'pa-1');
    assert(paid.approve.ok && paid.executed?.httpStatus === 200 && s.getOffer('offer-1')?.status === 'balance_paid', `…and the balance still approves and pays (got ${paid.executed?.httpStatus} ${JSON.stringify(paid.executed?.body ?? paid.approve)} / ${String(s.getOffer("offer-1")?.status)})`);
    const after = await markOfferMeasured(s.sb, 'offer-1');
    assert(after.written && s.getOffer('offer-1')?.status === 'measured', 'once the balance is paid, the next measurement marks it measured');
  }
  for (const [label, st, over] of [
    ['approved', 'approved', {}],
    ['executing', 'executing', {}],
    ['retryable failure', 'failed', { failure_reason: 'card_declined' }],
    ['failed with a transfer on file', 'failed', { failure_reason: 'reversed', payment_provider_id: 'tr_r' }],
  ] as [string, string, Row][]) {
    const s = splitPosted(st, over);
    const r = await markOfferMeasured(s.sb, 'offer-1');
    assert(!r.written && s.getOffer('offer-1')?.status === 'posted', `posted + ${label} balance → stays posted (got ${JSON.stringify(r)})`);
  }
  {
    // Balance owed with NOTHING minted (a dead failed leg, or none at all).
    const s = splitPosted(null);
    const r = await markOfferMeasured(s.sb, 'offer-1');
    assert(!r.written && r.reason === 'payment_unsettled' && s.getOffer('offer-1')?.status === 'posted', `posted, deposit paid, no balance leg → stays posted (got ${JSON.stringify(r)})`);
    const d = splitPosted('failed', { failure_reason: 'legs_exceed_agreed' });
    const rd = await markOfferMeasured(d.sb, 'offer-1');
    assert(!rd.written && d.getOffer('offer-1')?.status === 'posted', 'posted + dead failed balance (owed, re-mintable) → stays posted');
  }
  {
    // Settled deals are measured as before.
    const single = makeStore();
    seedDeal(single, { offerStatus: 'posted', paStatus: 'completed', leg: 'full' });
    const a = await markOfferMeasured(single.sb, 'offer-1');
    assert(a.written && single.getOffer('offer-1')?.status === 'measured', 'single-payment posted, paid → measured');
    const bp = makeStore();
    seedDeal(bp, { offerStatus: 'balance_paid', paStatus: 'completed', leg: 'balance', depositPaid: 50 });
    assert((await markOfferMeasured(bp.sb, 'offer-1')).written && bp.getOffer('offer-1')?.status === 'measured', 'balance_paid → measured');
    const stopped = splitPosted('rejected', { failure_reason: 'revoked_before_payout' });
    const kept = await markOfferMeasured(stopped.sb, 'offer-1');
    assert(!kept.written && kept.reason === 'balance_stopped' && stopped.getOffer('offer-1')?.status === 'posted', `posted with a balance a person stopped → stays posted, re-creatable (it used to become measured, which is terminal) (got ${JSON.stringify(kept)})`);
    const again = makeStore();
    seedDeal(again, { offerStatus: 'measured', paStatus: 'completed' });
    const r = await markOfferMeasured(again.sb, 'offer-1');
    assert(!r.written && r.reason === 'already_measured' && again.getOffer('offer-1')?.status === 'measured', 're-measure: stays measured, no write');
  }
  for (const st of ['human_approval_required', 'approved', 'paid', 'deposit_paid', 'rejected', 'undelivered', 'failed']) {
    const s = makeStore();
    seedDeal(s, { offerStatus: st, paStatus: 'completed' });
    const r = await markOfferMeasured(s.sb, 'offer-1');
    assert(!r.written && r.reason === 'status_not_measurable' && s.getOffer('offer-1')?.status === st, `'${st}' is never overwritten with measured (got ${String(s.getOffer('offer-1')?.status)})`);
  }
  {
    const route = read('app/api/outcomes/record/route.ts');
    assert(route.includes('markOfferMeasured(') && !/update\(\{ status: 'measured' \}/.test(route), 'outcomes/record goes through markOfferMeasured, no raw status write');
    assert(/campaign_outcomes/.test(route) && route.indexOf("from('campaign_outcomes')") < route.indexOf('markOfferMeasured('), '…and still records the measurement first');
  }
}

// ─── Part 4 ───

/**
 * Runs `fn` with the audit-log writer captured. The execute path audits through
 * the real audit() (service-role client → fetch); this records every POST to
 * audit_log instead of letting it vanish into the harness's empty-OK stub.
 * Optionally scripts Stripe (same shape as withStripe) in the same stub, since
 * withStripe's pass-through bypasses any outer wrapper.
 */
async function withAuditCapture<T>(
  fn: (audits: { action: string; target_id?: string; metadata?: Record<string, unknown> }[]) => Promise<T>,
  stripe?: (c: StubCall) => { status: number; json: unknown } | 'throw'
): Promise<T> {
  const audits: { action: string; target_id?: string; metadata?: Record<string, unknown> }[] = [];
  const prevMode = process.env.PAYMENTS_MODE;
  const prevKey = process.env.STRIPE_SECRET_KEY;
  if (stripe) {
    process.env.PAYMENTS_MODE = 'stripe_test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  }
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const i = (init ?? {}) as { method?: string; body?: unknown; headers?: Record<string, string> };
    const u = String(url);
    if (u.includes('/rest/v1/audit_log') && (i.method ?? 'GET') === 'POST') {
      const parsed = JSON.parse(String(i.body ?? '{}'));
      for (const row of Array.isArray(parsed) ? parsed : [parsed]) audits.push(row);
      return new Response('[]', { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (stripe && u.startsWith('https://api.stripe.com/')) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(i.headers ?? {})) headers[k.toLowerCase()] = v;
      const r = stripe({ url: u, method: i.method ?? 'GET', body: i.body == null ? '' : String(i.body), headers });
      if (r === 'throw') throw new TypeError('fetch failed: socket hang up');
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json } as Response;
    }
    return harnessFetch(url as string, init as RequestInit);
  }) as typeof fetch;
  try {
    return await fn(audits);
  } finally {
    globalThis.fetch = harnessFetch;
    process.env.PAYMENTS_MODE = prevMode;
    if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevKey;
  }
}

/**
 * Wrap a store so the FIRST write (insert / update / upsert) to
 * payment_authorizations runs `before` just ahead of it — the window between a
 * read and the write that follows it, where a concurrent writer lands.
 */
function raceBeforeFirstPaWrite(sb: SupabaseClient, before: (payload: Row) => void, only?: (payload: Row) => boolean): SupabaseClient {
  let fired = false;
  const realFrom = sb.from.bind(sb);
  return {
    from(table: string) {
      const q = realFrom(table) as unknown as Record<string, unknown>;
      if (table !== 'payment_authorizations') return q;
      for (const op of ['insert', 'update', 'upsert']) {
        const orig = (q[op] as (p: Row, o?: unknown) => unknown).bind(q);
        q[op] = (p: Row, o?: unknown) => {
          if (!fired && (!only || only(p))) {
            fired = true;
            before(p);
          }
          return orig(p, o);
        };
      }
      return q;
    },
  } as unknown as SupabaseClient;
}

const AWAITING = { id: 'pa-1', firm_id: FIRM, campaign_id: CAMPAIGN, amount_usd: 100, creator_offer_id: 'offer-1', leg: 'full' as const, influencer_id: 'inf-1' };

/** A payment_authorizations table that predates migration 055: naming `leg`
 *  or `executing_at` anywhere in a query errors (42703) and writes nothing.
 *  Same double as tests/payment-gate.test.ts. */
function pre055(sb: SupabaseClient): SupabaseClient {
  const missing = ['leg', 'executing_at'];
  const names = (s: string) => missing.some((c) => new RegExp(`\\b${c}\\b`).test(s));
  return {
    from(table: string) {
      const q = (sb as unknown as { from: (t: string) => Record<string, unknown> }).from(table);
      if (table !== 'payment_authorizations') return q;
      let bad = false;
      const err = { data: null, error: { message: 'column does not exist', code: '42703' } };
      const proxy: Record<string, unknown> = new Proxy(q, {
        get(target, prop: string) {
          const v = target[prop];
          if (typeof v !== 'function') return v;
          return (...args: unknown[]) => {
            if (prop === 'select' && typeof args[0] === 'string' && names(args[0])) bad = true;
            if (['update', 'insert', 'upsert'].includes(prop) && args[0] && typeof args[0] === 'object') {
              if (Object.keys(args[0] as object).some((k) => missing.includes(k))) bad = true;
            }
            if (['eq', 'in', 'is', 'not', 'lte', 'lt', 'gte', 'order'].includes(prop) && missing.includes(args[0] as string)) bad = true;
            if (bad && (prop === 'single' || prop === 'maybeSingle')) return Promise.resolve(err);
            if (bad && prop === 'then') return Promise.resolve(err).then(args[0] as never, args[1] as never);
            const r = (v as (...a: unknown[]) => unknown).apply(target, args);
            return r === target ? proxy : r;
          };
        },
      }) as Record<string, unknown>;
      return proxy;
    },
  } as unknown as SupabaseClient;
}

async function section7() {
  console.log('\n7. no blind re-mint, recorded completion, stopped balance stays re-creatable, onboarding mode');

  const posted = (s: Store, balance: Row | null) => {
    s.seed('firms', { id: FIRM, require_delivery_before_balance: true, deposit_pct: 50 });
    s.seed('creator_offers', { id: 'offer-1', firm_id: FIRM, campaign_id: CAMPAIGN, campaign_influencer_id: 'ci-1', status: 'posted', agreed_amount_usd: 100, ceiling_usd: 200, deposit_paid_usd: 50, balance_paid_usd: null });
    s.seed('payment_authorizations', { id: 'pa-dep', firm_id: FIRM, campaign_id: CAMPAIGN, creator_offer_id: 'offer-1', leg: 'deposit', amount_usd: 50, status: 'completed', payment_provider_id: 'tr_d', human_approved_at: 'x', human_approved_by_user_id: 'u' });
    if (balance) s.seed('payment_authorizations', { id: 'pa-bal', firm_id: FIRM, campaign_id: CAMPAIGN, creator_offer_id: 'offer-1', leg: 'balance', amount_usd: 50, payment_provider_id: null, ...balance });
  };
  const balRow = (s: Store) => s.all('payment_authorizations').find((x) => x.leg === 'balance') as Row;

  // 7.1 R1 — the re-mint read the leg, then blind-upserted it. A human approving
  //     and execute claiming in between had their EXECUTING row reset to
  //     pending_human_review with the approval wiped. Now every write to an
  //     existing row is compare-and-set on its id and the status that was read.
  for (const [label, start, reopen] of [
    ['pending double-click', { status: 'pending_human_review', human_approved_at: null, human_approved_by_user_id: null }, false],
    ['dead failure re-mint', { status: 'failed', failure_reason: 'legs_exceed_agreed', human_approved_at: 'x', human_approved_by_user_id: 'u' }, false],
    ['explicit re-create of a stop', { status: 'rejected', failure_reason: 'revoked_before_payout', human_approved_at: null, human_approved_by_user_id: null }, true],
  ] as [string, Row, boolean][]) {
    const s = makeStore();
    posted(s, start);
    const sb = raceBeforeFirstPaWrite(s.sb, () => {
      Object.assign(balRow(s), { status: 'executing', failure_reason: null, human_approved_at: 'T', human_approved_by_user_id: 'u2', executing_at: 'now', payment_mode: 'stripe_live' });
    });
    const r = await authorizePaymentForOffer(sb, { creatorOfferId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u', leg: 'balance', ...(reopen ? { reopenStopped: true } : {}) }, noAudit);
    const row = balRow(s);
    assert(r.httpStatus === 409 && r.body.error === 'leg_in_flight', `[${label}] a leg claimed between read and write → 409 leg_in_flight (got ${r.httpStatus} ${String(r.body.error)})`);
    assert(row.status === 'executing' && row.human_approved_at === 'T' && row.human_approved_by_user_id === 'u2' && row.executing_at === 'now', `[${label}] …the executing row keeps its status, approval and claim (got ${String(row.status)} / ${String(row.human_approved_at)})`);
    assert(approvalCheckHolds(row), `[${label}] …009 CHECK holds`);
    assert(s.all('payment_authorizations').filter((x) => x.leg === 'balance').length === 1, `[${label}] …no second balance row`);
  }
  {
    // Same race on a deposit/full leg (human_approval_required deal).
    const s = makeStore();
    seedDeal(s, { offerStatus: 'human_approval_required', paStatus: 'pending_human_review' });
    const pa = s.all('payment_authorizations')[0];
    const sb = raceBeforeFirstPaWrite(s.sb, () => Object.assign(pa, { status: 'approved', human_approved_at: 'T', human_approved_by_user_id: 'u2' }));
    const r = await authorizePaymentForOffer(sb, { creatorOfferId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    assert(r.httpStatus === 409 && pa.status === 'approved' && pa.human_approved_at === 'T', `full leg approved between read and write → 409, approval kept (got ${r.httpStatus} ${String(pa.status)} ${String(pa.human_approved_at)})`);
  }
  {
    // No race: the double-click is still idempotent, and a dead row is replaced
    // IN PLACE (same id), approval cleared, never a second row.
    const s = makeStore();
    seedDeal(s, { offerStatus: 'human_approval_required', paStatus: 'pending_human_review' });
    s.all('payment_authorizations').length = 0;
    const a = await authorizePaymentForOffer(s.sb, { creatorOfferId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    const b = await authorizePaymentForOffer(s.sb, { creatorOfferId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    const rows = s.all('payment_authorizations');
    assert(a.httpStatus === 200 && b.httpStatus === 200 && rows.length === 1 && a.body.id === b.body.id, `fresh mint + double-click → 200/200, one row (got ${a.httpStatus}/${b.httpStatus}, ${rows.length} rows)`);
    assert(rows[0].status === 'pending_human_review' && rows[0].human_approved_at == null && rows[0].leg === 'full', '…pending, unapproved, leg full');
    const d = makeStore();
    posted(d, { status: 'failed', failure_reason: 'legs_exceed_agreed', amount_usd: 80, human_approved_at: 'x', human_approved_by_user_id: 'u' });
    const r = await authorizePaymentForOffer(d.sb, { creatorOfferId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u', leg: 'balance' }, noAudit);
    const row = balRow(d);
    assert(r.httpStatus === 200 && row.id === 'pa-bal' && row.status === 'pending_human_review' && row.human_approved_at == null && row.human_approved_by_user_id == null && Number(row.amount_usd) === 50 && row.failure_reason == null, `dead failed balance replaced in place, approval cleared, re-sized (got ${r.httpStatus} ${String(row.id)} ${String(row.status)} ${String(row.amount_usd)})`);
  }
  {
    // Two first mints racing: the loser's INSERT hits the (offer, leg) unique
    // index. A pending winner is the double-click (200, the winner's row); an
    // approved one is in flight (409). Never a 500, never a second row.
    for (const [winner, want] of [['pending_human_review', 200], ['approved', 409]] as [string, number][]) {
      const s = makeStore();
      seedDeal(s, { offerStatus: 'human_approval_required', paStatus: 'pending_human_review' });
      s.all('payment_authorizations').length = 0;
      const realFrom = s.sb.from.bind(s.sb);
      const sb = {
        from(table: string) {
          const q = realFrom(table) as unknown as Record<string, unknown>;
          if (table !== 'payment_authorizations') return q;
          q.insert = () => {
            s.seed('payment_authorizations', { id: 'pa-win', firm_id: FIRM, campaign_id: CAMPAIGN, creator_offer_id: 'offer-1', leg: 'full', amount_usd: 100, status: winner, payment_provider_id: null, human_approved_at: winner === 'approved' ? 'T' : null, human_approved_by_user_id: winner === 'approved' ? 'u2' : null });
            const res = { data: null, error: { message: 'duplicate key value violates unique constraint "payment_authorizations_offer_leg_key"', code: '23505' } };
            const chain: Record<string, unknown> = { select: () => chain, single: async () => res, maybeSingle: async () => res };
            return chain;
          };
          return q;
        },
      } as unknown as SupabaseClient;
      const r = await authorizePaymentForOffer(sb, { creatorOfferId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
      assert(r.httpStatus === want && s.all('payment_authorizations').length === 1, `insert race vs a ${winner} winner → ${want} (got ${r.httpStatus} ${String(r.body.error)}, ${s.all('payment_authorizations').length} rows)`);
      if (want === 200) assert(r.body.id === 'pa-win', '…returns the winner’s row');
      else assert(r.body.error === 'leg_in_flight', '…leg_in_flight');
    }
  }
  {
    // Pre-055 (no `leg` column): the insert falls back to the legacy shape.
    const s = makeStore();
    seedDeal(s, { offerStatus: 'human_approval_required', paStatus: 'pending_human_review' });
    s.all('payment_authorizations').length = 0;
    const r = await authorizePaymentForOffer(pre055(s.sb), { creatorOfferId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    const rows = s.all('payment_authorizations');
    assert(r.httpStatus === 200 && rows.length === 1 && rows[0].leg === undefined, `pre-055: legacy insert without leg (got ${r.httpStatus} ${String(r.body.error)}, ${rows.length} rows)`);
    const again = await authorizePaymentForOffer(pre055(s.sb), { creatorOfferId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u' }, noAudit);
    assert(again.httpStatus === 200 && s.all('payment_authorizations').length === 1, `pre-055 double-click → 200, one row (got ${again.httpStatus} ${String(again.body.error)})`);
  }
  {
    const code = read('lib/authorize-payment.ts').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    assert(!/\.upsert\(/.test(code), 'authorize-payment.ts: no blind upsert left');
  }

  // 7.2 R-exec — the final `completed` write was `.eq('id', id)` with its
  //     error ignored. It is now compare-and-set on the claim; when it does not
  //     land after money moved, that is audited and shown on /anomalies.
  const loseCompletedWrite = (s: Store, pa: Row, how: 'reclaimed' | 'reclaimed_and_reclaimed' | 'error') => {
    const realFrom = s.sb.from.bind(s.sb);
    return {
      from(table: string) {
        const q = realFrom(table) as unknown as Record<string, unknown>;
        if (table !== 'payment_authorizations') return q;
        const orig = (q.update as (p: Row) => unknown).bind(q);
        q.update = (p: Row) => {
          if (p.status !== 'completed') return orig(p);
          if (how === 'error') {
            const res = { data: null, error: { message: 'connection reset' } };
            const chain: Record<string, unknown> = {};
            for (const m of ['eq', 'in', 'is', 'select']) chain[m] = () => chain;
            chain.single = async () => res;
            chain.maybeSingle = async () => res;
            chain.then = (f: (v: typeof res) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(res).then(f, r);
            return chain;
          }
          // The reclaimer returned it to approved (executing_at cleared) — and,
          // in the second variant, a fresh execute claimed it again.
          if (how === 'reclaimed') Object.assign(pa, { status: 'approved', executing_at: null });
          else Object.assign(pa, { status: 'executing', executing_at: '2099-01-01T00:00:00.000Z' });
          return orig(p);
        };
        return q;
      },
    } as unknown as SupabaseClient;
  };
  for (const how of ['reclaimed', 'reclaimed_and_reclaimed', 'error'] as const) {
    const s = makeStore();
    const pa = seedDeal(s, { offerStatus: 'approved', paStatus: 'approved' });
    ((pa.creator_offers as Row).campaign_influencers as { influencer: Row }).influencer.stripe_connect_account_id = 'acct_1';
    const out = await withAuditCapture(
      async (audits) => ({ ex: await executeAuthorizedPayment(loseCompletedWrite(s, pa, how), 'pa-1', { expectedFirmId: FIRM }), audits }),
      onboardedThen({ status: 200, json: { id: 'tr_77' } })
    );
    assert(pa.status !== 'completed', `[exec/${how}] the lost completed write does not overwrite the row (got ${String(pa.status)})`);
    const flag = out.audits.find((a) => a.action === 'payment.completion_not_recorded');
    assert(!!flag && flag.target_id === 'pa-1' && flag.metadata?.transfer_id === 'tr_77', `[exec/${how}] …audited payment.completion_not_recorded with the transfer id (got ${JSON.stringify(flag ?? out.audits.map((a) => a.action))})`);
    assert(out.ex.body.ok === true && out.ex.body.recorded === false && /tr_77/.test(String(out.ex.body.guidance)), `[exec/${how}] …response says sent-but-not-recorded, not a failure to retry (got ${JSON.stringify(out.ex.body)})`);
    assert(s.getOffer('offer-1')?.status === 'paid', `[exec/${how}] …the deal still reflects that money moved (got ${String(s.getOffer('offer-1')?.status)})`);
    const shown = summarizePayout(out.ex);
    assert(shown.ok && shown.reason === 'transfer_not_recorded' && /tr_77/.test(String(shown.guidance)), `[exec/${how}] …approve UI shows it, not a clean "Paid" (got ${JSON.stringify(shown)})`);
    if (how === 'reclaimed_and_reclaimed') assert(pa.executing_at === '2099-01-01T00:00:00.000Z' && pa.status === 'executing', '…the newer claim is left alone');
  }
  {
    // Happy path unchanged: recorded, no anomaly.
    const s = makeStore();
    const pa = seedDeal(s, { offerStatus: 'approved', paStatus: 'approved' });
    ((pa.creator_offers as Row).campaign_influencers as { influencer: Row }).influencer.stripe_connect_account_id = 'acct_1';
    const out = await withAuditCapture(async (audits) => ({ ex: await executeAuthorizedPayment(s.sb, 'pa-1', { expectedFirmId: FIRM }), audits }), onboardedThen({ status: 200, json: { id: 'tr_78' } }));
    assert(pa.status === 'completed' && pa.payment_provider_id === 'tr_78' && out.ex.body.recorded !== false, `execute happy path still completes (got ${String(pa.status)})`);
    assert(!out.audits.some((a) => a.action === 'payment.completion_not_recorded'), '…no anomaly');
  }
  {
    // The /anomalies money lane shows it, with the transfer id.
    assert(MONEY_ANOMALY_AUDIT_ACTIONS.includes('payment.completion_not_recorded'), 'completion_not_recorded is a money-anomaly action (the route fetches it)');
    const lane = detectAnomalies(
      {
        offers: [], payments: [], deliveries: [], audit: [], inbound: [], cis: [], influencers: [], campaigns: [], hasContractTemplate: true, bounced: [],
        moneyAudit: [{ id: 'a1', occurred_at: '2026-09-30T12:00:00Z', action: 'payment.completion_not_recorded', target_type: 'payment_authorization', target_id: 'pa-1', metadata: { transfer_id: 'tr_77', amount_usd: 100, creator_offer_id: 'offer-1' } }],
      } as unknown as AnomaliesInput,
      Date.parse('2026-09-30T13:00:00Z')
    );
    const row = lane.find((x) => x.category === 'payment_anomaly');
    assert(!!row && /sent but not recorded/i.test(row.what) && /tr_77/.test(String(row.detail)), `anomaly lane: "transfer sent but not recorded" naming tr_77 (got ${JSON.stringify(row ?? null)})`);
  }
  for (const how of ['reclaimed', 'error'] as const) {
    // Onboarding webhook: same guard on its completed write.
    const s = makeStore();
    const pa = seedDeal(s, { offerStatus: 'approved', paStatus: 'approved', extraOffer: { payout_status: 'awaiting_onboarding' } });
    const f = onboardingDeps([{ ok: true, provider_id: 'tr_88', settled: true }]);
    const r = await payOnboardedAuthorization(loseCompletedWrite(s, pa, how), AWAITING, 'acct_1', f.deps);
    assert(pa.status !== 'completed', `[onboarding/${how}] lost completed write does not overwrite (got ${String(pa.status)})`);
    const flag = f.audits.find((a) => a.action === 'payment.completion_not_recorded');
    assert(!!flag && flag.metadata?.transfer_id === 'tr_88', `[onboarding/${how}] …audited with the transfer id (got ${f.audits.map((a) => a.action).join(',')})`);
    assert(r.outcome === 'paid' && (r as { recorded?: boolean }).recorded === false, `[onboarding/${how}] …outcome paid, recorded false (got ${JSON.stringify(r)})`);
  }
  {
    const s = makeStore();
    const pa = seedDeal(s, { offerStatus: 'approved', paStatus: 'approved', extraOffer: { payout_status: 'awaiting_onboarding' } });
    const f = onboardingDeps([{ ok: true, provider_id: 'tr_89', settled: true }]);
    const r = await payOnboardedAuthorization(s.sb, AWAITING, 'acct_1', f.deps);
    assert(r.outcome === 'paid' && pa.status === 'completed' && pa.payment_provider_id === 'tr_89' && !f.audits.some((a) => a.action === 'payment.completion_not_recorded'), `onboarding happy path still completes, no anomaly (got ${String(pa.status)})`);
  }

  // 7.3 R2 — a REJECTED balance used to count as settled, so recording streams
  //     moved the deal to 'measured' (terminal) and "Re-create stopped payment"
  //     then answered 409 nothing_to_mint. A person-stopped, unpaid balance now
  //     keeps the deal 'posted' — the streams are still recorded by the route.
  for (const stop of [
    { status: 'rejected', failure_reason: null },
    { status: 'rejected', failure_reason: 'revoked_before_payout' },
    { status: 'failed', failure_reason: 'cancelled_by_operator', human_approved_at: 'x', human_approved_by_user_id: 'u' },
  ] as Row[]) {
    const tag = `${String(stop.status)}/${String(stop.failure_reason)}`;
    const s = makeStore();
    posted(s, { human_approved_at: null, human_approved_by_user_id: null, ...stop });
    const m = await markOfferMeasured(s.sb, 'offer-1');
    assert(!m.written && m.reason === 'balance_stopped' && s.getOffer('offer-1')?.status === 'posted', `[${tag}] stopped unpaid balance → deal stays posted (got ${JSON.stringify(m)} / ${String(s.getOffer('offer-1')?.status)})`);
    const re = await remintPaymentForOffer(s.sb, { offerId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u', reopenStopped: true }, noAudit);
    assert(re.httpStatus === 200 && balRow(s).status === 'pending_human_review' && approvalCheckHolds(balRow(s)), `[${tag}] …"Re-create stopped payment" still works after measuring (got ${re.httpStatus} ${String(re.body.error)})`);
  }
  {
    // The whole road: stop → measure (kept posted) → re-create → approve + pay
    // → measure again → measured.
    const s = makeStore();
    seedDeal(s, { offerStatus: 'posted', paStatus: 'rejected', leg: 'balance', amount: 50, depositPaid: 50 });
    Object.assign(s.all('firms')[0], { require_delivery_before_balance: true, deposit_pct: 50 });
    assert(!(await markOfferMeasured(s.sb, 'offer-1')).written, 'road: stopped balance, measure → kept posted');
    const re = await remintPaymentForOffer(s.sb, { offerId: 'offer-1', callerFirmId: FIRM, actorUserId: 'u', reopenStopped: true }, noAudit);
    const paid = await approveAndExecute(s.sb, 'pa-1');
    assert(re.httpStatus === 200 && paid.executed?.httpStatus === 200 && s.getOffer('offer-1')?.status === 'balance_paid', `road: re-create → approve → balance_paid (got ${re.httpStatus} ${paid.executed?.httpStatus} ${String(s.getOffer('offer-1')?.status)})`);
    const m = await markOfferMeasured(s.sb, 'offer-1');
    assert(m.written && s.getOffer('offer-1')?.status === 'measured', 'road: …then measured');
  }
  {
    // A stopped balance WITH a transfer on file is money that moved: not a
    // "stopped, unpaid" leg, and not re-creatable. Unchanged: stays unsettled.
    const s = makeStore();
    posted(s, { status: 'rejected', failure_reason: 'revoked_before_payout', payment_provider_id: 'tr_x', human_approved_at: null });
    const m = await markOfferMeasured(s.sb, 'offer-1');
    assert(m.written || m.reason !== 'balance_stopped', `stopped balance with a transfer on file is not "stopped unpaid" (got ${JSON.stringify(m)})`);
  }

  // 7.4 The onboarding claim stamps payment_mode, like execute's.
  {
    const s = makeStore();
    const pa = seedDeal(s, { offerStatus: 'approved', paStatus: 'approved', extraOffer: { payout_status: 'awaiting_onboarding' } });
    pa.payment_mode = 'paper';
    const claims: Row[] = [];
    const sb = raceBeforeFirstPaWrite(s.sb, (p) => claims.push({ ...p }), (p) => p.status === 'executing');
    const f = onboardingDeps([{ ok: false, provider_id: '', settled: false, error: 'socket hang up', outcome_unknown: true, reason: OUTCOME_UNKNOWN_REASON }]);
    const prevMode = process.env.PAYMENTS_MODE;
    const prevKey = process.env.STRIPE_SECRET_KEY;
    process.env.PAYMENTS_MODE = 'stripe_test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    try {
      await payOnboardedAuthorization(sb, AWAITING, 'acct_1', f.deps);
    } finally {
      process.env.PAYMENTS_MODE = prevMode;
      if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = prevKey;
    }
    assert(claims[0]?.payment_mode === 'stripe_test', `onboarding claim carries payment_mode (got ${JSON.stringify(claims[0] ?? null)})`);
    assert(pa.status === 'executing' && pa.payment_mode === 'stripe_test', `…a claim stranded mid-transfer records the rail it was sent on (got ${String(pa.status)}/${String(pa.payment_mode)})`);
  }
}

async function main() {
  await section1();
  await section2();
  await section3();
  await section4();
  await section5();
  await section6();
  await section7();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:\n' + failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
