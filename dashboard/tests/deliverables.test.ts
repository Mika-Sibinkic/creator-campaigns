// tests/deliverables.test.ts
//
// Unit tests for src/lib/deliverables.ts. Fully hermetic (no network, no DB).
//
// Run: npx tsx tests/deliverables.test.ts

import {
  PROMO_TYPES,
  PROMO_WEIGHT,
  TERMS_MAX_QUANTITY,
  isPromoType,
  normalizeDeliverables,
  bundleWeight,
  bundleExplicitPriceUsd,
  maxWindowDays,
  describeDeliverables,
  applyTermsToDeliverables,
  type Deliverable,
} from '../src/lib/deliverables';
import {
  bundleValueUnits,
  deliverableValueUnits,
  evaluateTermTrade,
} from '../src/lib/pricing-engine';
import {
  DEFAULT_DELIVERABLES,
  resolveStandingDeliverables,
} from '../src/lib/deliverables-store';
import { makeStore } from './negotiation-harness/store';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(condition: boolean, message: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

// ── 1. guards ────────────────────────────────────────────────────────────
assert(isPromoType('story') && isPromoType('dance_trend'), 'guard: valid promo types');
assert(!isPromoType('tiktok') && !isPromoType(undefined) && !isPromoType(7), 'guard: rejects invalid');
assert(PROMO_TYPES.length === 4, 'four promo types');
assert(PROMO_WEIGHT.dance_trend > PROMO_WEIGHT.reel && PROMO_WEIGHT.reel > PROMO_WEIGHT.post && PROMO_WEIGHT.post > PROMO_WEIGHT.story, 'weights ordered story < post < reel < dance_trend');

// ── 2. normalize: drops junk, floors, dedups, orders ─────────────────────
const norm = normalizeDeliverables([
  { promo_type: 'post', quantity: 2, delivery_window_days: 14 },
  { promo_type: 'bogus', quantity: 5 },
  { promo_type: 'story', quantity: 0, delivery_window_days: -3 }, // floored to 1/1
  { promo_type: 'post', quantity: 9, delivery_window_days: 7 },   // dup: last wins
  'garbage',
  null,
]);
assert(norm.length === 2, `normalize: 2 valid lines (got ${norm.length})`);
assert(norm[0].promo_type === 'story', 'normalize: canonical order (story first)');
const post = norm.find((d) => d.promo_type === 'post')!;
assert(post.quantity === 9 && post.delivery_window_days === 7, 'normalize: dup last-wins');
const story = norm.find((d) => d.promo_type === 'story')!;
assert(story.quantity === 1 && story.delivery_window_days === 1, 'normalize: floors quantity/window to >= 1');
assert(normalizeDeliverables('nope').length === 0, 'normalize: non-array → []');

// ── 3. bundle math ───────────────────────────────────────────────────────
const bundle: Deliverable[] = [
  { promo_type: 'reel', quantity: 2, delivery_window_days: 14, min_seconds: 30, unit_price_usd: 100 },
  { promo_type: 'dance_trend', quantity: 1, delivery_window_days: 30, min_seconds: 30, unit_price_usd: 250 },
];
assert(Math.abs(bundleWeight(bundle) - (1.3 * 2 + 1.8 * 1)) < 1e-9, 'bundleWeight = Σ weight×qty');
assert(bundleExplicitPriceUsd(bundle) === 100 * 2 + 250, 'explicit price sums unit×qty');
assert(bundleExplicitPriceUsd([{ promo_type: 'post', quantity: 1, delivery_window_days: 7 }]) === null, 'explicit price null when a unit price missing');
assert(maxWindowDays(bundle) === 30, 'maxWindowDays picks widest');

// ── 4. copy ──────────────────────────────────────────────────────────────
const desc = describeDeliverables(bundle);
assert(desc.includes('2 30-second reels') && desc.includes('dance/trend video'), `describe lists items w/ length: "${desc}"`);
// min_seconds: default applied for reel when unset; explicit honored
const withLen = normalizeDeliverables([{ promo_type: 'reel', quantity: 1, delivery_window_days: 7 }]);
assert(withLen[0].min_seconds === 30, `reel defaults to 30s (got ${withLen[0].min_seconds})`);
const explicitLen = normalizeDeliverables([{ promo_type: 'reel', quantity: 1, delivery_window_days: 7, min_seconds: 60 }]);
assert(explicitLen[0].min_seconds === 60, 'explicit reel length honored (60s)');
const postLen = normalizeDeliverables([{ promo_type: 'post', quantity: 1, delivery_window_days: 7 }]);
assert(postLen[0].min_seconds == null, 'feed post is length-agnostic (null)');
assert(desc.includes('and') && desc.includes('within'), 'describe joins with "and ... within"');
assert(!desc.includes('—') && !desc.includes('–'), 'describe: no em/en dash');
assert(describeDeliverables([{ promo_type: 'story', quantity: 3, delivery_window_days: 14 }]).includes('within 2 weeks'), 'describe: 14 days → 2 weeks');
assert(describeDeliverables([]) === '', 'describe: empty → empty string');

// ── 5. term proposals → proposed package ─────────────────────
const CURRENT: Deliverable[] = [
  { promo_type: 'reel', quantity: 1, delivery_window_days: 14, min_seconds: 30 },
  { promo_type: 'story', quantity: 1, delivery_window_days: 14, min_seconds: 15 },
];
{
  const p = applyTermsToDeliverables(
    { quantity: 2, promo_type: 'reel', min_seconds: 60, schedule_note: 'can post next week' },
    CURRENT,
  );
  assert(p !== null && p.length === 1, 'terms: valid proposal → single-line package');
  assert(p?.[0].promo_type === 'reel' && p?.[0].quantity === 2, 'terms: type + quantity applied');
  assert(p?.[0].min_seconds === 60, 'terms: explicit length honored');
  assert(p?.[0].delivery_window_days === 14, 'terms: window carried from current package');
  assert(p?.[0].schedule_note === 'can post next week', 'terms: schedule note carried');
}
{
  const p = applyTermsToDeliverables({ promo_type: 'reel' }, CURRENT);
  assert(p?.[0].quantity === 1 && p?.[0].min_seconds === 30, 'terms: quantity defaults to 1, length to type default');
}
{
  const wide: Deliverable[] = [{ promo_type: 'post', quantity: 1, delivery_window_days: 30 }];
  const p = applyTermsToDeliverables({ promo_type: 'story' }, wide);
  assert(p?.[0].delivery_window_days === 30, 'terms: widest current window carried');
  assert(applyTermsToDeliverables({ promo_type: 'story' }, [])?.[0].delivery_window_days === 14, 'terms: empty current → 14-day default window');
}
// Garbage → null (price-only path):
assert(applyTermsToDeliverables(null, CURRENT) === null, 'terms: null → null');
assert(applyTermsToDeliverables({}, CURRENT) === null, 'terms: no promo_type → null');
assert(applyTermsToDeliverables({ promo_type: 'podcast' }, CURRENT) === null, 'terms: invalid promo_type → null');
assert(applyTermsToDeliverables({ promo_type: 'reel', quantity: 0 }, CURRENT) === null, 'terms: quantity 0 → null');
assert(applyTermsToDeliverables({ promo_type: 'reel', quantity: TERMS_MAX_QUANTITY + 1 }, CURRENT) === null, 'terms: absurd quantity → null');
assert(applyTermsToDeliverables({ promo_type: 'reel', quantity: Number.NaN }, CURRENT) === null, 'terms: NaN quantity → null');
assert(applyTermsToDeliverables({ promo_type: 'reel', min_seconds: 4 }, CURRENT) === null, 'terms: sub-5s length → null');
assert(applyTermsToDeliverables({ promo_type: 'reel', min_seconds: 601 }, CURRENT) === null, 'terms: >600s length → null');

// normalize round-trips a schedule note (frozen contract state), drops junk notes.
{
  const norm = normalizeDeliverables([
    { promo_type: 'reel', quantity: 1, delivery_window_days: 7, schedule_note: '  posts friday  ' },
    { promo_type: 'story', quantity: 1, delivery_window_days: 7, schedule_note: 42 },
  ]);
  assert(norm.find((d) => d.promo_type === 'reel')?.schedule_note === 'posts friday', 'normalize: schedule note trimmed + carried');
  assert(norm.find((d) => d.promo_type === 'story')?.schedule_note === null, 'normalize: non-string note → null');
}

// ── 6. value model + term-trade decisions ────────────────────────────────
// Default-style bundle = 1.3 (reel@30s) + 0.4 (story@15s) = 1.7 units.
assert(Math.abs(bundleValueUnits(CURRENT) - 1.7) < 1e-9, `value: default bundle = 1.7 units (got ${bundleValueUnits(CURRENT)})`);
// Length scales linearly vs the type default, clamped 0.5–2.0.
assert(Math.abs(deliverableValueUnits({ promo_type: 'reel', quantity: 1, delivery_window_days: 14, min_seconds: 60 }) - 2.6) < 1e-9, 'value: 60s reel = 2× 30s reel');
assert(Math.abs(deliverableValueUnits({ promo_type: 'reel', quantity: 1, delivery_window_days: 14, min_seconds: 300 }) - 2.6) < 1e-9, 'value: length factor clamped at 2×');
assert(Math.abs(deliverableValueUnits({ promo_type: 'reel', quantity: 1, delivery_window_days: 14, min_seconds: 5 }) - 0.65) < 1e-9, 'value: length factor clamped at 0.5×');
assert(Math.abs(deliverableValueUnits({ promo_type: 'post', quantity: 2, delivery_window_days: 14 }) - 2.0) < 1e-9, 'value: length-agnostic post ignores seconds');

const REEL_ONLY: Deliverable[] = [{ promo_type: 'reel', quantity: 1, delivery_window_days: 14, min_seconds: 30 }];
{
  // Reduced package at the old price → counter at the proportional price.
  const d = evaluateTermTrade({
    current_offer_usd: 100, counter_usd: 100, ceiling_usd: 200, rounds: 1,
    current_deliverables: CURRENT, proposed_deliverables: REEL_ONLY,
  });
  assert(d.action === 'counter' && d.new_offer_usd === 76, `trade: reduced package @ same price → counter $76 (got ${JSON.stringify(d)})`);
}
{
  // Asked at-or-under the value-fair price → accept at asked.
  const d = evaluateTermTrade({
    current_offer_usd: 100, counter_usd: 70, ceiling_usd: 200, rounds: 1,
    current_deliverables: CURRENT, proposed_deliverables: REEL_ONLY,
  });
  assert(d.action === 'accept' && d.agreed_amount_usd === 70, 'trade: asked ≤ fair → accept at asked');
}
{
  // Enlarged package above ceiling → clamped at the ceiling, never breached.
  const three: Deliverable[] = [{ promo_type: 'reel', quantity: 3, delivery_window_days: 14, min_seconds: 30 }];
  const d = evaluateTermTrade({
    current_offer_usd: 100, counter_usd: 500, ceiling_usd: 200, rounds: 1,
    current_deliverables: CURRENT, proposed_deliverables: three,
  });
  assert(d.action === 'counter' && d.new_offer_usd === 200, `trade: enlarged package clamped at ceiling (got ${JSON.stringify(d)})`);
}
{
  // No asked price → never accept; counter so the creator confirms a number.
  const d = evaluateTermTrade({
    current_offer_usd: 100, counter_usd: null, ceiling_usd: 200, rounds: 1,
    current_deliverables: CURRENT, proposed_deliverables: REEL_ONLY,
  });
  assert(d.action === 'counter' && d.new_offer_usd === 76, 'trade: no asked price → counter at fair, never auto-accept');
  const bigger: Deliverable[] = [{ promo_type: 'reel', quantity: 2, delivery_window_days: 14, min_seconds: 30 }];
  const d2 = evaluateTermTrade({
    current_offer_usd: 100, counter_usd: null, ceiling_usd: 200, rounds: 1,
    current_deliverables: CURRENT, proposed_deliverables: bigger,
  });
  assert(d2.action === 'counter' && d2.new_offer_usd === 100, 'trade: enlarged package w/o asked price → never volunteer above our offer');
}
{
  // Over-ask at max rounds → reject; empty packages → reject.
  const d = evaluateTermTrade({
    current_offer_usd: 100, counter_usd: 500, ceiling_usd: 200, rounds: 3,
    current_deliverables: CURRENT, proposed_deliverables: REEL_ONLY,
  });
  assert(d.action === 'reject', 'trade: over-ask at max rounds → reject');
  const e = evaluateTermTrade({
    current_offer_usd: 100, counter_usd: 50, ceiling_usd: 200, rounds: 0,
    current_deliverables: CURRENT, proposed_deliverables: [],
  });
  assert(e.action === 'reject', 'trade: empty proposed package → reject');
}

// ── 8. standing-package resolution (DB-backed, hermetic in-memory store) ─────
//
// Every agreement path has to answer "what package is this price for?" the
// same way, or the offer record and the creator's email drift apart.
async function testStandingPackage() {
  // No configured lines anywhere → the default bundle, never an empty package.
  const bare = makeStore();
  const fromDefault = await resolveStandingDeliverables(bare.sb, {
    id: 'offer-1',
    campaign_id: 'camp-1',
    agreed_deliverables: null,
  });
  assert(
    JSON.stringify(fromDefault) === JSON.stringify(DEFAULT_DELIVERABLES),
    `standing: nothing configured → DEFAULT_DELIVERABLES (got ${JSON.stringify(fromDefault)})`,
  );
  // The phrase a creator reads must not change when the same package makes a
  // round trip through the DB (normalizeDeliverables reorders; the copy layer
  // re-sorts heaviest-first, so both spellings render identically).
  const asStored = normalizeDeliverables(fromDefault);
  assert(
    describeDeliverables(fromDefault) === '1 30-second reel and 1 15-second story within 2 weeks',
    `standing: default bundle reads heaviest-first (got "${describeDeliverables(fromDefault)}")`,
  );
  assert(
    describeDeliverables(asStored) === describeDeliverables(fromDefault),
    `standing: copy is identical before and after a DB round trip (got "${describeDeliverables(asStored)}")`,
  );

  // Campaign template lines win over the default.
  const configured = makeStore();
  configured.seed('promo_deliverables', {
    id: 'pd-1',
    campaign_id: 'camp-1',
    creator_offer_id: null,
    promo_type: 'post',
    quantity: 2,
    delivery_window_days: 7,
    min_seconds: null,
    unit_price_usd: null,
  });
  const fromCampaign = await resolveStandingDeliverables(configured.sb, {
    id: 'offer-1',
    campaign_id: 'camp-1',
    agreed_deliverables: null,
  });
  assert(
    fromCampaign.length === 1 && fromCampaign[0].promo_type === 'post' && fromCampaign[0].quantity === 2,
    `standing: campaign template wins over the default (got ${JSON.stringify(fromCampaign)})`,
  );

  // A package already frozen by a term trade beats everything — a later
  // price-only accept must inherit what was actually negotiated.
  const frozen = await resolveStandingDeliverables(configured.sb, {
    id: 'offer-1',
    campaign_id: 'camp-1',
    agreed_deliverables: [
      { promo_type: 'reel', quantity: 1, delivery_window_days: 14, min_seconds: 30 },
    ],
  });
  assert(
    frozen.length === 1 && frozen[0].promo_type === 'reel',
    `standing: frozen package wins over the campaign template (got ${JSON.stringify(frozen)})`,
  );
}

testStandingPackage()
  .catch((e) => {
    failed++;
    failures.push(`standing: threw unexpectedly — ${(e as Error).message}`);
  })
  .then(() => {
    console.log(`deliverables test: ${passed} passed, ${failed} failed`);
    if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed === 0 ? 0 : 1);
  });
