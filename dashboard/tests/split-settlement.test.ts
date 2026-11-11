// tests/split-settlement.test.ts
//
// Pins the half-on-agreement / half-on-post settlement policy.
//
// WHY EACH SECTION EXISTS
//   The state machine used to pay in full before the deliverable existed, and the
//   standard contract made taking the money the binding act — so nothing after
//   payment obliged anyone to post. At a real $40 median, litigation is not a
//   remedy. The protection is the payment order plus an outside date that closes
//   the deal without anyone chasing anyone.
//
//   The guards that matter, in order of how badly they fail:
//     1. OFF BY DEFAULT. If the flag ever defaults on, every live deal changes
//        settlement mid-flight. That is the worst possible regression here.
//     2. The legs must sum to the agreed amount exactly. A cent lost or invented
//        is a cent on a number a creator is counting.
//     3. Expiry must NEVER fire on a deal that delivered. The failure mode of a
//        loose sweeper is refusing to pay someone who did the work — far worse
//        than missing an expiry.
//
// Hermetic: pure functions, no DB, no clock, no network.
//
// Run: npx tsx tests/split-settlement.test.ts

export {};

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:9';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-dummy';

  const {
    DEFAULT_DEPOSIT_PCT,
    DEFAULT_DELIVERY_WINDOW_DAYS,
    resolveSettlementPolicy,
    settlementLegs,
    deliverByMs,
    evaluateExpiry,
    exposureUsd,
  } = await import('../src/lib/split-settlement');
  const { canTransition, TERMINAL_STATES } = await import('../src/lib/negotiation');

  // ── 1. Off by default, and only an explicit true turns it on ─────────────
  assert(!resolveSettlementPolicy(null).splitEnabled, 'null firm → split OFF');
  assert(!resolveSettlementPolicy(undefined).splitEnabled, 'undefined firm → split OFF');
  assert(!resolveSettlementPolicy({}).splitEnabled, 'firm with no flag → split OFF');
  assert(
    !resolveSettlementPolicy({ require_delivery_before_balance: null }).splitEnabled,
    'null flag → split OFF',
  );
  assert(
    resolveSettlementPolicy({ require_delivery_before_balance: true }).splitEnabled,
    'explicit true → split ON',
  );
  assert(resolveSettlementPolicy({}).depositPct === DEFAULT_DEPOSIT_PCT, 'default share is 50%');

  // A nonsense deposit_pct must not produce a nonsense payment.
  for (const [raw, want] of [[-10, 0], [0, 0], [25, 25], [100, 100], [140, 100]] as const) {
    assert(
      resolveSettlementPolicy({ deposit_pct: raw }).depositPct === want,
      `deposit_pct ${raw} clamps to ${want}`,
    );
  }
  assert(
    resolveSettlementPolicy({ deposit_pct: Number.NaN }).depositPct === DEFAULT_DEPOSIT_PCT,
    'NaN deposit_pct falls back to the default rather than paying 0',
  );

  // ── 2. With the split OFF, behaviour is exactly today's ──────────────────
  {
    const off = resolveSettlementPolicy({});
    const legs = settlementLegs(230, off);
    assert(legs.depositUsd === 230, 'split off: the whole amount is the one payment');
    assert(legs.balanceUsd === 0, 'split off: no balance leg exists');
  }

  // ── 3. The legs always sum to the agreed amount, exactly ─────────────────
  {
    const on = resolveSettlementPolicy({ require_delivery_before_balance: true });
    for (const amount of [0, 0.01, 1, 25, 40, 41, 99.99, 126, 185, 230, 1000.05, 7777.77]) {
      const legs = settlementLegs(amount, on);
      const sum = Math.round((legs.depositUsd + legs.balanceUsd) * 100) / 100;
      const expected = Math.round(amount * 100) / 100;
      assert(sum === expected, `$${amount}: legs sum to exactly the agreed amount (got ${sum})`);
      assert(legs.depositUsd >= 0 && legs.balanceUsd >= 0, `$${amount}: neither leg is negative`);
      assert(legs.depositUsd <= expected, `$${amount}: the deposit never exceeds the total`);
    }
    // The odd-cent case the "derive both independently" bug would break.
    const odd = settlementLegs(41.01, on);
    assert(
      Math.round((odd.depositUsd + odd.balanceUsd) * 100) / 100 === 41.01,
      '$41.01 splits without losing or inventing a cent',
    );
  }

  // A 0% or 100% deposit is legal and must still balance.
  {
    const zero = settlementLegs(200, { splitEnabled: true, depositPct: 0 });
    assert(zero.depositUsd === 0 && zero.balanceUsd === 200, '0% deposit pays everything on delivery');
    const all = settlementLegs(200, { splitEnabled: true, depositPct: 100 });
    assert(all.depositUsd === 200 && all.balanceUsd === 0, '100% deposit is the old behaviour');
  }

  // ── 4. The outside date comes from what the creator agreed to ────────────
  {
    const at = 1_700_000_000_000;
    const pkg = [{ promo_type: 'reel', quantity: 1, delivery_window_days: 21 }];
    assert(deliverByMs(at, pkg) === at + 21 * DAY, 'deadline is the package window');
    // Largest window wins — the creator is owed the longest they were promised.
    const mixed = [
      { promo_type: 'reel', quantity: 1, delivery_window_days: 7 },
      { promo_type: 'post', quantity: 1, delivery_window_days: 30 },
    ];
    assert(deliverByMs(at, mixed) === at + 30 * DAY, 'the longest promised window governs');
    // An unrecognised promo type is dropped by normalizeDeliverables rather than
    // trusted, so it can never extend a deadline. Worth pinning: the deadline is
    // the thing automatic expiry is measured against, and a bogus line inflating
    // it would silently park a deposit for months.
    const bogus = [
      { promo_type: 'reel', quantity: 1, delivery_window_days: 7 },
      { promo_type: 'feed_post', quantity: 1, delivery_window_days: 3650 },
    ];
    assert(
      deliverByMs(at, bogus) === at + 7 * DAY,
      'an invalid promo type cannot extend the delivery deadline',
    );
    assert(
      deliverByMs(at, null) === at + DEFAULT_DELIVERY_WINDOW_DAYS * DAY,
      'a missing package falls back to the default window rather than expiring immediately',
    );
    assert(deliverByMs(at, []) === at + DEFAULT_DELIVERY_WINDOW_DAYS * DAY, 'an empty package too');
  }

  // ── 5. Expiry is narrow, and never fires on a delivered deal ────────────
  {
    const now = 1_700_000_000_000;
    const past = now - DAY;
    const future = now + DAY;

    assert(
      evaluateExpiry({ status: 'deposit_paid', deliverByMs: past, postUrl: null, nowMs: now }).action ===
        'expire',
      'deposit out, window passed, no post → expire',
    );

    // The one that must never be wrong.
    assert(
      evaluateExpiry({
        status: 'deposit_paid',
        deliverByMs: past,
        postUrl: 'https://tiktok.com/@x/video/1',
        nowMs: now,
      }).action === 'wait',
      'a recorded post stops the clock even past the deadline — verification owns it, not expiry',
    );
    assert(
      evaluateExpiry({ status: 'deposit_paid', deliverByMs: past, postUrl: '   ', nowMs: now }).action ===
        'expire',
      'a blank post URL is not a post',
    );
    assert(
      evaluateExpiry({ status: 'deposit_paid', deliverByMs: future, postUrl: null, nowMs: now }).action ===
        'wait',
      'inside the window → wait',
    );
    assert(
      evaluateExpiry({ status: 'deposit_paid', deliverByMs: now, postUrl: null, nowMs: now }).action ===
        'expire',
      'exactly at the deadline → expire (the boundary is pinned deliberately)',
    );
    assert(
      evaluateExpiry({ status: 'deposit_paid', deliverByMs: null, postUrl: null, nowMs: now }).action ===
        'wait',
      'no stated deadline → never expire; nobody was told a date',
    );

    // No other state may be expired by this sweeper.
    for (const st of ['queued', 'offered', 'agreed', 'approved', 'paid', 'posted', 'balance_paid', 'measured', 'undelivered', 'rejected', 'failed']) {
      assert(
        evaluateExpiry({ status: st, deliverByMs: past, postUrl: null, nowMs: now }).action === 'wait',
        `status ${st} is never expired by the delivery sweeper`,
      );
    }
    // Every wait carries a stated reason — this sweeper touches money, so a
    // silent no-op is not acceptable.
    const waited = evaluateExpiry({ status: 'paid', deliverByMs: past, postUrl: null, nowMs: now });
    assert(waited.reason.length > 10, 'a refusal to expire says why');
  }

  // ── 6. The state machine permits both paths, and only those ─────────────
  assert(canTransition('approved', 'paid'), 'the single-payment path survives');
  assert(canTransition('approved', 'deposit_paid'), 'the split path opens');
  assert(canTransition('deposit_paid', 'posted'), 'a deposit-paid deal can be delivered');
  assert(canTransition('deposit_paid', 'undelivered'), 'a deposit-paid deal can expire');
  assert(canTransition('posted', 'balance_paid'), 'delivery unlocks the balance');
  assert(canTransition('balance_paid', 'measured'), 'the balance path still reaches measured');
  assert(canTransition('posted', 'measured'), 'the single-payment path still reaches measured directly');

  // The transitions that would cost real money if they were legal.
  assert(!canTransition('deposit_paid', 'balance_paid'), 'the balance can NEVER be paid without a post');
  assert(!canTransition('undelivered', 'balance_paid'), 'an expired deal can never be paid out later');
  assert(!canTransition('undelivered', 'posted'), 'an expired deal cannot be revived by a late post');
  assert(!canTransition('undelivered', 'measured'), 'undelivered is genuinely terminal');
  assert(!canTransition('approved', 'balance_paid'), 'no shortcut to the balance');
  assert(!canTransition('agreed', 'deposit_paid'), 'the human approval gate still stands in front of both paths');

  assert(TERMINAL_STATES.includes('undelivered'), 'undelivered is declared terminal');

  // ── 7. Exposure is the deposit, and that is what the UI should say ──────
  {
    const on = resolveSettlementPolicy({ require_delivery_before_balance: true });
    assert(exposureUsd(settlementLegs(230, on)) === 115, 'exposure on a $230 deal is the $115 deposit');
    const off = resolveSettlementPolicy({});
    assert(exposureUsd(settlementLegs(230, off)) === 230, 'with the split off, exposure is the whole amount');
  }

  console.log(`split-settlement test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
