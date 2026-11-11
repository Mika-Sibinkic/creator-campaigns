// tests/settlement-legs.test.ts
//
// WHAT THIS GUARDS: the split settlement had no production caller at all.
// `settlementLegs()` and `resolveSettlementPolicy()` shipped in migration 052
// and, until the change this suite covers, were referenced only by their own
// unit test — so `firms.require_delivery_before_balance = true` changed nothing
// whatsoever. `authorize-payment.ts` always minted the FULL agreed amount, and
// the structural reason was a UNIQUE(creator_offer_id) on payment_authorizations
// that made a second leg unrepresentable.
//
// So this suite is deliberately about the WIRING, not the arithmetic:
//   1. Split off  → one 'full' leg for the whole agreed amount. The pre-existing
//      behaviour, which must not move.
//   2. Split on   → 'deposit' leg for deposit_pct, and the balance leg REFUSED
//      until the deal is actually 'posted'.
//   3. The two legs sum to exactly the agreed amount — a creator being a cent
//      short is a support ticket, and rounding both legs independently is how
//      that happens.
//   4. `balanceDue` only fires on a posted deal that took a deposit and has not
//      been paid its balance.
//   5. `evaluateExpiry` no longer treats any pasted string as delivery — the
//      change that makes the sweeper able to do its job.
//
// Hermetic: in-memory store, no env, no network, no DB.
//
// Run: npx tsx tests/settlement-legs.test.ts

import './negotiation-harness/setup-env'; // FIRST — dummy env
import {
  resolveSettlementPolicy,
  settlementLegs,
  balanceDue,
  evaluateExpiry,
} from '../src/lib/split-settlement';
import { authorizePaymentForOffer } from '../src/lib/authorize-payment';
import { makeStore, type Row } from './negotiation-harness/store';

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

const FIRM = 'firm-1';
const CAMPAIGN = 'camp-1';
const noopHooks = { audit: async () => {} };

function seed(store: ReturnType<typeof makeStore>, opts: {
  splitOn: boolean;
  depositPct?: number;
  offerStatus: string;
  agreed?: number;
  depositPaid?: number | null;
  balancePaid?: number | null;
}): Row {
  store.seed('firms', {
    id: FIRM,
    require_delivery_before_balance: opts.splitOn,
    deposit_pct: opts.depositPct ?? 50,
  });
  return store.seed('creator_offers', {
    id: 'offer-1',
    campaign_id: CAMPAIGN,
    firm_id: FIRM,
    status: opts.offerStatus,
    agreed_amount_usd: opts.agreed ?? 40,
    ceiling_usd: 250,
    deposit_paid_usd: opts.depositPaid ?? null,
    balance_paid_usd: opts.balancePaid ?? null,
  });
}

async function main() {
  // ── 1. Split OFF: one 'full' leg, whole amount. Must not change. ──────────
  {
    const store = makeStore();
    seed(store, { splitOn: false, offerStatus: 'human_approval_required', agreed: 40 });
    const out = await authorizePaymentForOffer(
      store.sb,
      { creatorOfferId: 'offer-1', callerFirmId: FIRM },
      noopHooks
    );
    assert(out.httpStatus === 200, `split off authorizes (got ${out.httpStatus} ${JSON.stringify(out.body)})`);
    const rows = store.all('payment_authorizations');
    assert(rows.length === 1, `exactly one authorization (got ${rows.length})`);
    assert(rows[0]?.leg === 'full', `leg is 'full' (got '${String(rows[0]?.leg)}')`);
    assert(
      Number(rows[0]?.amount_usd) === 40,
      `reserves the FULL agreed amount when the split is off (got ${String(rows[0]?.amount_usd)})`
    );
  }

  // ── 2. Split ON: deposit leg only, and the balance is refused pre-post ────
  {
    const store = makeStore();
    seed(store, { splitOn: true, depositPct: 50, offerStatus: 'human_approval_required', agreed: 40 });
    const deposit = await authorizePaymentForOffer(
      store.sb,
      { creatorOfferId: 'offer-1', callerFirmId: FIRM },
      noopHooks
    );
    assert(deposit.httpStatus === 200, `deposit leg authorizes (got ${deposit.httpStatus})`);
    const legRow = store.all('payment_authorizations')[0];
    assert(legRow?.leg === 'deposit', `defaults to the deposit leg when split is on (got '${String(legRow?.leg)}')`);
    assert(
      Number(legRow?.amount_usd) === 20,
      `reserves only the deposit, not the agreed total (got ${String(legRow?.amount_usd)})`
    );

    // The balance must NOT be reservable while the deal is unposted. This is the
    // whole contingency: reserving it early would make the split cosmetic.
    const early = await authorizePaymentForOffer(
      store.sb,
      { creatorOfferId: 'offer-1', callerFirmId: FIRM, leg: 'balance' },
      noopHooks
    );
    assert(
      early.httpStatus === 409,
      `balance leg REFUSED before the post exists (got ${early.httpStatus} ${JSON.stringify(early.body)})`
    );
    assert(
      store.all('payment_authorizations').length === 1,
      'the refusal wrote no row'
    );
  }

  // ── 3. Balance leg on a posted deal, and the legs sum exactly ────────────
  {
    const store = makeStore();
    seed(store, {
      splitOn: true, depositPct: 50, offerStatus: 'posted', agreed: 41, depositPaid: 20.5,
    });
    const bal = await authorizePaymentForOffer(
      store.sb,
      { creatorOfferId: 'offer-1', callerFirmId: FIRM, leg: 'balance' },
      noopHooks
    );
    assert(bal.httpStatus === 200, `balance leg authorizes once posted (got ${bal.httpStatus} ${JSON.stringify(bal.body)})`);
    const row = store.all('payment_authorizations').find((r) => r.leg === 'balance');
    assert(row != null, 'a balance-leg row exists');
    assert(Number(row?.amount_usd) === 20.5, `balance is the remainder (got ${String(row?.amount_usd)})`);

    // Odd cents: the two legs must sum to the agreed amount EXACTLY.
    for (const agreed of [41, 33.33, 0.01, 99.99, 25, 137.77]) {
      const legs = settlementLegs(agreed, { splitEnabled: true, depositPct: 50 });
      assert(
        Math.round((legs.depositUsd + legs.balanceUsd) * 100) === Math.round(agreed * 100),
        `legs sum to exactly ${agreed} (got ${legs.depositUsd} + ${legs.balanceUsd})`
      );
    }
  }

  // ── 4. balanceDue ────────────────────────────────────────────────────────
  {
    assert(
      balanceDue({ status: 'posted', deposit_paid_usd: 20, balance_paid_usd: null }),
      'posted + deposit taken + balance unpaid → due'
    );
    assert(
      !balanceDue({ status: 'posted', deposit_paid_usd: 20, balance_paid_usd: 20 }),
      'already paid → not due (no double balance)'
    );
    assert(
      !balanceDue({ status: 'posted', deposit_paid_usd: null, balance_paid_usd: null }),
      'never took a deposit → not due (that would be a second FULL payment)'
    );
    for (const s of ['agreed', 'human_approval_required', 'deposit_paid', 'paid', 'measured', 'undelivered']) {
      assert(
        !balanceDue({ status: s, deposit_paid_usd: 20, balance_paid_usd: null }),
        `status '${s}' does not owe a balance — only a verified post does`
      );
    }
  }

  // ── 5. Expiry no longer treats any pasted string as delivery ─────────────
  {
    const base = { status: 'deposit_paid', deliverByMs: 1_000, nowMs: 2_000 };
    assert(
      evaluateExpiry({ ...base, postUrl: null }).action === 'expire',
      'no post + deadline passed → expire'
    );
    assert(
      evaluateExpiry({ ...base, postUrl: 'https://tiktok.com/@x/video/1' }).action === 'wait',
      'a post URL with no verdict yet → wait (verification owns it, never expiry)'
    );
    assert(
      evaluateExpiry({ ...base, postUrl: 'anything', deliveryStatus: 'verified' }).action === 'wait',
      'verified → wait, forever; never expire a creator who delivered'
    );
    assert(
      evaluateExpiry({ ...base, postUrl: 'garbage', deliveryStatus: 'missing' }).action === 'expire',
      'the tick looked repeatedly and could not find it → expire. Before this, ' +
        'pasting ANY string parked the deal in deposit_paid forever and put a ' +
        'human back in the loop the split exists to remove'
    );
    assert(
      evaluateExpiry({ ...base, postUrl: 'garbage', deliveryStatus: 'missing', nowMs: 500 }).action === 'wait',
      'missing but still inside the window → wait; the agreed deadline still governs'
    );
    assert(
      evaluateExpiry({ status: 'deposit_paid', deliverByMs: null, postUrl: null, nowMs: 9e9 }).action === 'wait',
      'no stamped deadline → never expire a deal nobody was told a deadline for'
    );
  }

  // ── 6. Policy resolution tolerates the real column shapes ────────────────
  {
    assert(resolveSettlementPolicy(null).splitEnabled === false, 'null firm → split off (fail safe)');
    assert(resolveSettlementPolicy({}).depositPct === 50, 'missing deposit_pct → 50');
    assert(resolveSettlementPolicy({ deposit_pct: 150 }).depositPct === 100, 'deposit_pct clamps to 100');
    assert(resolveSettlementPolicy({ deposit_pct: -5 }).depositPct === 0, 'deposit_pct clamps to 0');
    assert(
      resolveSettlementPolicy({ require_delivery_before_balance: null }).splitEnabled === false,
      'null flag is not truthy — a NULL column must never enable the split'
    );
  }

  if (failures.length > 0) console.error('\nFailures:\n - ' + failures.join('\n - '));
  console.log(`settlement-legs test: ${passed}/${passed + failed} pass`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
