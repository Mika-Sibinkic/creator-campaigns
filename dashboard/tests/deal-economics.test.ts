// tests/deal-economics.test.ts
//
// Unit tests for src/lib/deal-economics.ts (computeDealEconomics) and the
// tierBaseUsd export in src/lib/pricing-engine.ts. Pure + hermetic: no env,
// no DB, no network — only the pure math is exercised here (the sweeper /
// targeted-persist DB paths are thin wrappers around it).
// Fixtures are hand-computed.
//
// Run: npx tsx tests/deal-economics.test.ts

import { computeDealEconomics, type DealEconomicsInput } from '../src/lib/deal-economics';
import { tierBaseUsd } from '../src/lib/pricing-engine';

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

const EPS = 1e-9;
const close = (a: number | null, b: number, eps = EPS): boolean =>
  a != null && Math.abs(a - b) < eps;

// Input factory — nulls everywhere unless overridden.
function input(o: Partial<DealEconomicsInput>): DealEconomicsInput {
  return {
    agreed_amount_usd: null,
    initial_offer_usd: null,
    ceiling_usd: null,
    follower_count: null,
    ...o,
  };
}

// ── 1. perceived_generosity = agreed ÷ tierBaseUsd(follower_count) ───────────
{
  // $150 agreed / 25k followers → micro tier base $100 → 1.5
  const a = computeDealEconomics(input({ agreed_amount_usd: 150, follower_count: 25_000 }));
  assert(close(a.perceived_generosity, 1.5), `generosity: 150/25k → 1.5 (got ${a.perceived_generosity})`);

  // $60 / 5k followers → nano tier base $50 → 1.2
  const b = computeDealEconomics(input({ agreed_amount_usd: 60, follower_count: 5_000 }));
  assert(close(b.perceived_generosity, 1.2), `generosity: 60/5k → 1.2 (got ${b.perceived_generosity})`);

  // follower_count = 0 is a KNOWN count (nano tier), not a missing one.
  const c = computeDealEconomics(input({ agreed_amount_usd: 50, follower_count: 0 }));
  assert(close(c.perceived_generosity, 1.0), `generosity: 50 @ fc=0 → nano base → 1.0 (got ${c.perceived_generosity})`);

  // Tier path wins even when a ceiling is also present.
  const d = computeDealEconomics(
    input({ agreed_amount_usd: 150, follower_count: 25_000, ceiling_usd: 250 }),
  );
  assert(close(d.perceived_generosity, 1.5), `generosity: tier path beats ceiling fallback (got ${d.perceived_generosity})`);
}

// ── 2. perceived_generosity fallback: agreed ÷ ceiling ───────────────────────
{
  // No follower count + ceiling 250, agreed 200 → 0.8
  const a = computeDealEconomics(input({ agreed_amount_usd: 200, ceiling_usd: 250 }));
  assert(close(a.perceived_generosity, 0.8), `generosity fallback: 200/250 → 0.8 (got ${a.perceived_generosity})`);

  // No follower count + no ceiling → null
  const b = computeDealEconomics(input({ agreed_amount_usd: 200 }));
  assert(b.perceived_generosity === null, `generosity: no fc + no ceiling → null (got ${b.perceived_generosity})`);

  // Ceiling 0 is not a usable norm → null
  const c = computeDealEconomics(input({ agreed_amount_usd: 200, ceiling_usd: 0 }));
  assert(c.perceived_generosity === null, `generosity: ceiling 0 → null (got ${c.perceived_generosity})`);
}

// ── 3. agreed null → both null ────────────────────────────────────────────────
{
  const a = computeDealEconomics(
    input({ initial_offer_usd: 150, ceiling_usd: 250, follower_count: 25_000 }),
  );
  assert(a.perceived_generosity === null, `agreed null → generosity null (got ${a.perceived_generosity})`);
  assert(a.price_give_pct === null, `agreed null → price_give null (got ${a.price_give_pct})`);
}

// ── 4. price_give_pct = (agreed − initial) ÷ ceiling ─────────────────────────
{
  // (200 − 150) / 250 = 0.2
  const a = computeDealEconomics(
    input({ agreed_amount_usd: 200, initial_offer_usd: 150, ceiling_usd: 250 }),
  );
  assert(close(a.price_give_pct, 0.2), `price-give: (200−150)/250 → 0.2 (got ${a.price_give_pct})`);

  // Below-opening close: (140 − 150) / 250 = −0.04 — sign preserved, no clamp.
  const b = computeDealEconomics(
    input({ agreed_amount_usd: 140, initial_offer_usd: 150, ceiling_usd: 250 }),
  );
  assert(close(b.price_give_pct, -0.04), `price-give: (140−150)/250 → −0.04 signed (got ${b.price_give_pct})`);

  // ceiling 0 → null (no division by zero)
  const c = computeDealEconomics(
    input({ agreed_amount_usd: 200, initial_offer_usd: 150, ceiling_usd: 0 }),
  );
  assert(c.price_give_pct === null, `price-give: ceiling 0 → null (got ${c.price_give_pct})`);

  // initial null → null
  const d = computeDealEconomics(input({ agreed_amount_usd: 200, ceiling_usd: 250 }));
  assert(d.price_give_pct === null, `price-give: initial null → null (got ${d.price_give_pct})`);

  // No-move close: (150 − 150) / 250 = 0 — a real zero, not null.
  const e = computeDealEconomics(
    input({ agreed_amount_usd: 150, initial_offer_usd: 150, ceiling_usd: 250 }),
  );
  assert(close(e.price_give_pct, 0), `price-give: no move → 0 (got ${e.price_give_pct})`);
}

// ── 5. tierBaseUsd boundary values (TIER_TABLE, strict <) ────────────────────
{
  assert(tierBaseUsd(9_999) === 50, `tierBaseUsd(9,999) → 50 nano (got ${tierBaseUsd(9_999)})`);
  assert(tierBaseUsd(10_000) === 100, `tierBaseUsd(10,000) → 100 micro (got ${tierBaseUsd(10_000)})`);
  assert(tierBaseUsd(49_999) === 100, `tierBaseUsd(49,999) → 100 micro (got ${tierBaseUsd(49_999)})`);
  assert(tierBaseUsd(50_000) === 250, `tierBaseUsd(50,000) → 250 mid (got ${tierBaseUsd(50_000)})`);
  assert(tierBaseUsd(250_000) === 500, `tierBaseUsd(250,000) → 500 large (got ${tierBaseUsd(250_000)})`);
}

console.log(`deal-economics test: ${passed} passed, ${failed} failed`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
