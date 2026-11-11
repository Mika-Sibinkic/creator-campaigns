// tests/payment-legs.test.ts
//
// WHAT THIS GUARDS: the human sees, and acts on, every settlement leg of a deal.
//
// Since migration 055 one deal carries up to two payment_authorizations (leg =
// deposit | balance, or one 'full'), each with its own human approval. The
// deals route built `new Map(rows.map(p => [p.creator_offer_id, p]))`, so a
// deal with two legs kept whichever row PostgREST happened to return last and
// the other leg vanished from the page. DealRow then gated Retry on the OFFER
// being 'approved', so a failed balance leg (offer at 'posted') had no button
// even though the server accepts that retry.
//
//   1. groupLegsByOffer keeps every leg, ordered deposit → full → balance, and
//      reads a missing leg (pre-055 row) as 'full'.
//   2. legActions mirrors the server rules exactly: Approve/Reject on pending,
//      Execute/Stop on approved, Retry per payment-claim.retryRefusal plus the
//      offer-payable allowlist, nothing while executing.
//   3. legStatusText says what state each leg is in.
//   4. fetchPendingApprovals returns the leg, and degrades to the pre-055 select
//      on a query error.
//   5. Source invariants: the deals route no longer collapses legs, DealRow no
//      longer gates Retry on offer.status === 'approved'.
//
// Hermetic: pure functions and a local fake client. No env, DB or network.
//
// Run: npx tsx tests/payment-legs.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  groupLegsByOffer,
  legActions,
  legStatusText,
  legLabel,
  normalizeLeg,
  type DealPaymentLeg,
} from '../src/lib/payment-legs';
import { fetchPendingApprovals } from '../src/lib/approvals-query';

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

function leg(over: Partial<DealPaymentLeg> = {}): DealPaymentLeg {
  return {
    id: 'pa-1',
    leg: 'full',
    status: 'pending_human_review',
    amount_usd: 250,
    failure_reason: null,
    payment_mode: 'stripe_test',
    payment_provider_id: null,
    human_approved_at: null,
    ...over,
  };
}

const APPROVED_AT = '2026-09-30T10:00:00.000Z';

// ─── 1. groupLegsByOffer ────────────────────────────────────────────────────
{
  const rows = [
    // Returned balance-first on purpose: the old Map kept the LAST row.
    { id: 'bal', creator_offer_id: 'o1', leg: 'balance', status: 'failed', amount_usd: '150', failure_reason: 'stripe_error', payment_mode: 'stripe_test', payment_provider_id: null, human_approved_at: APPROVED_AT },
    { id: 'dep', creator_offer_id: 'o1', leg: 'deposit', status: 'completed', amount_usd: 100, failure_reason: null, payment_mode: 'stripe_test', payment_provider_id: 'tr_1', human_approved_at: APPROVED_AT },
    { id: 'only', creator_offer_id: 'o2', status: 'approved', amount_usd: 300, failure_reason: null, payment_mode: 'paper', payment_provider_id: null, human_approved_at: APPROVED_AT },
  ];
  const byOffer = groupLegsByOffer(rows);
  const o1 = byOffer.get('o1') ?? [];
  assert(o1.length === 2, `a deal with two legs keeps both (got ${o1.length})`);
  assert(o1.map((l) => l.id).join(',') === 'dep,bal', `legs ordered deposit → balance (got ${o1.map((l) => l.id).join(',')})`);
  assert(o1[1].amount_usd === 150 && typeof o1[1].amount_usd === 'number', 'amount_usd coerced to a number (numeric arrives as a string)');
  assert(o1[1].human_approved_at === APPROVED_AT && o1[0].payment_provider_id === 'tr_1', 'retry-rule fields survive the merge');
  const o2 = byOffer.get('o2') ?? [];
  assert(o2.length === 1 && o2[0].leg === 'full', 'a row with no leg column (pre-055 select) reads as full');
  assert(!byOffer.has('o3'), 'an offer with no authorization has no entry');

  const orderCheck = groupLegsByOffer([
    { id: 'b', creator_offer_id: 'x', leg: 'balance', status: 'pending_human_review', amount_usd: 1 },
    { id: 'f', creator_offer_id: 'x', leg: 'full', status: 'rejected', amount_usd: 1 },
    { id: 'd', creator_offer_id: 'x', leg: 'deposit', status: 'completed', amount_usd: 1 },
  ]).get('x') ?? [];
  assert(orderCheck.map((l) => l.id).join(',') === 'd,f,b', 'order is deposit, full, balance regardless of input order');

  assert(normalizeLeg('deposit') === 'deposit' && normalizeLeg('balance') === 'balance', 'normalizeLeg keeps real legs');
  assert(normalizeLeg(null) === 'full' && normalizeLeg(undefined) === 'full' && normalizeLeg('weird') === 'full', 'normalizeLeg reads anything else as full');
  assert(legLabel('deposit') === 'Deposit' && legLabel('balance') === 'Balance' && legLabel('full') === 'Full payment', 'leg labels');
}

// ─── 2. legActions ──────────────────────────────────────────────────────────
{
  // Pending: Approve + Reject, Approve only while the deal is payable for the leg.
  const pendingFull = legActions(leg(), 'human_approval_required');
  assert(pendingFull.approve && pendingFull.reject, 'pending full leg on an awaiting-approval deal → Approve + Reject');
  assert(!pendingFull.retry && !pendingFull.execute && !pendingFull.stop, 'pending leg → no Retry/Execute/Stop');

  const pendingBalance = legActions(leg({ leg: 'balance' }), 'posted');
  assert(pendingBalance.approve, 'pending balance leg on a posted deal → Approve (the old row needed human_approval_required)');

  const pendingOnClosed = legActions(leg(), 'rejected');
  assert(!pendingOnClosed.approve && pendingOnClosed.reject, 'pending leg on a closed deal → Reject only, never Approve');

  // Approved, not sent: Execute + Stop.
  const approved = legActions(leg({ status: 'approved', human_approved_at: APPROVED_AT }), 'approved');
  assert(approved.execute && approved.stop, 'approved leg → Execute + Stop');
  assert(!approved.retry && !approved.approve, 'approved leg → no Retry/Approve');

  const approvedWithTransfer = legActions(
    leg({ status: 'approved', human_approved_at: APPROVED_AT, payment_provider_id: 'tr_9' }),
    'approved'
  );
  assert(!approvedWithTransfer.stop, 'approved leg with a transfer on file → no Stop (server answers payout_already_started)');

  // THE BUG: failed balance leg on a posted deal.
  const failedBalance = leg({
    id: 'bal',
    leg: 'balance',
    status: 'failed',
    amount_usd: 150,
    failure_reason: 'stripe_error',
    human_approved_at: APPROVED_AT,
  });
  const fb = legActions(failedBalance, 'posted');
  assert(fb.retry, 'failed balance leg on a posted deal → Retry (the old row showed nothing)');
  assert(fb.stop, 'failed, never-sent, not-stopped leg → Stop (server revokes failed rows with no transfer)');
  assert(!fb.execute && !fb.approve, 'failed leg → no Execute/Approve');

  // Every retryRefusal case refuses in the UI too.
  assert(!legActions({ ...failedBalance, payment_provider_id: 'tr_2' }, 'posted').retry, 'failed with a transfer id → no Retry');
  assert(!legActions({ ...failedBalance, payment_provider_id: 'tr_2' }, 'posted').stop, 'failed with a transfer id → no Stop');
  for (const r of ['offer_not_payable', 'cancelled_by_operator', 'revoked_before_payout']) {
    const a = legActions({ ...failedBalance, failure_reason: r }, 'posted');
    assert(!a.retry && !a.stop, `failed with stop reason ${r} → no Retry, no Stop`);
  }
  assert(!legActions({ ...failedBalance, human_approved_at: null }, 'posted').retry, 'failed with no approval → no Retry');
  assert(legActions({ ...failedBalance, failure_reason: null }, 'posted').retry, 'failed with no reason recorded is still retryable');

  // Offer must be payable for the leg (checkOfferPayable runs after the claim).
  assert(!legActions(failedBalance, 'balance_paid').retry, 'balance leg on a balance_paid deal → no Retry (would pay twice)');
  assert(!legActions(failedBalance, 'rejected').retry, 'failed leg on a closed deal → no Retry');
  assert(legActions({ ...failedBalance, leg: 'full' }, 'approved').retry, 'failed full leg on an approved deal → Retry (old behaviour kept)');
  assert(!legActions({ ...failedBalance, leg: 'deposit' }, 'posted').retry, 'failed deposit leg on a posted deal → no Retry (deposit is not payable from posted)');

  // In flight: nothing.
  const exec = legActions(leg({ status: 'executing', human_approved_at: APPROVED_AT }), 'approved');
  assert(exec.inFlight && !exec.approve && !exec.reject && !exec.execute && !exec.retry && !exec.stop, 'executing leg → in flight, no actions');

  // Terminal: nothing.
  for (const s of ['completed', 'rejected']) {
    const a = legActions(leg({ status: s, human_approved_at: s === 'completed' ? APPROVED_AT : null }), 'approved');
    assert(!a.approve && !a.reject && !a.execute && !a.retry && !a.stop && !a.inFlight, `${s} leg → no actions`);
  }
}

// ─── 3. legStatusText ───────────────────────────────────────────────────────
{
  assert(legStatusText(leg(), null) === 'Awaiting approval', 'pending → Awaiting approval');
  assert(
    /payout setup/.test(legStatusText(leg({ status: 'approved' }), 'awaiting_onboarding')),
    'approved + awaiting_onboarding names the payout setup wait'
  );
  assert(legStatusText(leg({ status: 'approved' }), null) === 'Approved, not sent', 'approved → not sent');
  assert(legStatusText(leg({ status: 'executing' }), null) === 'Sending…', 'executing → Sending…');
  assert(legStatusText(leg({ status: 'completed' }), null) === 'Paid', 'completed → Paid');
  assert(
    legStatusText(leg({ status: 'completed', payment_mode: 'paper' }), null) === 'Recorded, no money moved',
    'completed in paper mode does not claim money moved'
  );
  assert(legStatusText(leg({ status: 'failed' }), null) === 'Failed', 'failed → Failed');
  assert(
    legStatusText(leg({ status: 'rejected', failure_reason: 'revoked_before_payout' }), null) === 'Stopped',
    'revoked → Stopped'
  );
  assert(
    legStatusText(leg({ status: 'rejected', failure_reason: 'cancelled_by_operator' }), null) === 'Stopped',
    'cancelled → Stopped'
  );
  assert(legStatusText(leg({ status: 'rejected', failure_reason: 'too much' }), null) === 'Rejected', 'reviewer reject → Rejected');
  assert(legStatusText(leg({ status: 'some_new_state' }), null) === 'Some new state', 'unknown status is de-snaked, never raw');
}

// ─── 4. fetchPendingApprovals carries the leg, and degrades pre-055 ─────────
function fakeApprovals(opts: { failLegSelect: boolean }) {
  const selects: string[] = [];
  const client = {
    from() {
      let sel = '';
      const b = {
        select(s: string) {
          sel = s;
          selects.push(s);
          return b;
        },
        eq() {
          return b;
        },
        order() {
          return b;
        },
        then(resolve: (r: { data: unknown; error: unknown }) => void) {
          const hasLeg = /(^|[\s,])leg([\s,]|$)/.test(sel);
          if (hasLeg && opts.failLegSelect) {
            resolve({ data: null, error: { message: 'column payment_authorizations.leg does not exist' } });
            return;
          }
          resolve({
            data: [
              { id: 'p1', amount_usd: 125, status: 'pending_human_review', ...(hasLeg ? { leg: 'deposit' } : {}) },
            ],
            error: null,
          });
        },
      };
      return b;
    },
  };
  return { sb: client as unknown as SupabaseClient, selects };
}

async function approvalsTests() {
  {
    const { sb, selects } = fakeApprovals({ failLegSelect: false });
    const res = await fetchPendingApprovals(sb, 'firm-1');
    assert(res.ok && res.rows[0].leg === 'deposit', 'approvals row carries its leg');
    assert(selects.length === 1, 'one query when the 055 shape works');
  }
  {
    const { sb, selects } = fakeApprovals({ failLegSelect: true });
    const res = await fetchPendingApprovals(sb, 'firm-1');
    assert(res.ok === true, 'a leg-select error falls back instead of failing the page');
    assert(res.ok && normalizeLeg(res.rows[0].leg) === 'full', 'fallback row reads as a full leg');
    assert(selects.length === 2 && !/(^|[\s,])leg([\s,]|$)/.test(selects[1]), 'fallback select names no leg column');
  }
}

// ─── 5. Source invariants ───────────────────────────────────────────────────
function sourceTests() {
  const route = read('app/api/campaigns/[id]/deals/route.ts');
  assert(route.includes('groupLegsByOffer'), 'deals route groups every leg per offer');
  assert(!/new Map\(\s*\(\(payRows/.test(route), 'deals route no longer collapses legs into one Map entry per offer');
  assert(/payment_authorizations:/.test(route), 'deals route ships payment_authorizations (plural)');

  const row = read('app/campaigns/[id]/deals/DealRow.tsx');
  assert(row.includes('legActions'), 'DealRow derives per-leg buttons from legActions');
  assert(!/offer\.status === 'approved' &&\s*offer\.payment_authorization/.test(row), "DealRow no longer gates the money buttons on offer.status === 'approved'");
  assert(/Retry payment/.test(row) && /Stop payment/.test(row) && row.includes("'revoke'"), 'DealRow still offers Retry payment and Stop payment');

  const page = read('app/approvals/page.tsx');
  assert(page.includes('legLabel'), '/approvals names the leg on each card');
  const actions = read('app/approvals/ApprovalActions.tsx');
  assert(/leg/.test(actions), 'ApprovalActions names the leg in the approve confirmation');
}

async function main() {
  await approvalsTests();
  sourceTests();
  if (failures.length > 0) console.error('\nFailures:\n - ' + failures.join('\n - '));
  console.log(`payment-legs test: ${passed}/${passed + failed} pass`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
