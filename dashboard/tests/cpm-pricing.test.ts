// tests/cpm-pricing.test.ts
//
// CPM slice S1, the pure half: expected views from a creator's own post
// history, and the shadow CPM price built on them.
//
// Nothing here is used to price a deal yet. These pin the arithmetic and, more
// importantly, the refusals: Instagram has no trustworthy view count
// (discovery-candidates.ts toDiscoveryPost), a thin history is not an estimate,
// and a fresh post has not finished collecting views.
//
// Hermetic, pure. Run: npx tsx tests/cpm-pricing.test.ts

import { expectedViews, EXPECTED_VIEWS_MAX_POSTS } from '../src/lib/expected-views';
import {
  computeCpmPricing,
  impliedFormulaCpm,
  poolTargetCpm,
  DEFAULT_VIEW_FACTOR_K,
  COLD_START_TARGET_CPM_USD,
  DEFAULT_MAX_OVER_TARGET,
} from '../src/lib/cpm-pricing';

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

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-01T12:00:00Z');
const post = (plays: number | undefined, ageDays: number, extra: Record<string, unknown> = {}) => ({
  ...(plays === undefined ? {} : { playCount: plays }),
  createTime: Math.floor((NOW - ageDays * DAY) / 1000),
  ...extra,
});

// ── expectedViews ───────────────────────────────────────────────────────────
{
  const r = expectedViews({ platform: 'tiktok', raw_data: { posts: [post(1000, 5), post(3000, 6), post(2000, 7)] }, nowMs: NOW });
  assert(r?.views === 2000 && r?.n === 3, `median of 3 eligible posts (got ${JSON.stringify(r)})`);
}
{
  const r = expectedViews({
    platform: 'tiktok',
    raw_data: { posts: [post(1000, 5), post(3000, 6), post(2000, 7), post(4000, 8)] },
    nowMs: NOW,
  });
  assert(r?.views === 2500 && r?.n === 4, `even count → mean of the middle two (got ${JSON.stringify(r)})`);
}
{
  // A post under 3 days old is still collecting views — excluded, not counted.
  const r = expectedViews({
    platform: 'tiktok',
    raw_data: { posts: [post(900_000, 1), post(1000, 5), post(3000, 6), post(2000, 7)] },
    nowMs: NOW,
  });
  assert(r?.views === 2000 && r?.n === 3, `posts <3 days old are excluded (got ${JSON.stringify(r)})`);
}
{
  const r = expectedViews({
    platform: 'tiktok',
    raw_data: { posts: [post(900_000, 2.9), post(1000, 5), post(3000, 6)] },
    nowMs: NOW,
  });
  assert(r === null, 'fewer than 3 eligible posts → null, not a guess');
}
{
  // Up to the LAST 10 posts: the 11th-and-older are ignored, whatever order raw_data stores them in.
  const recent = Array.from({ length: 10 }, (_, i) => post(1000 + i, 4 + i)); // 1000..1009
  const old = Array.from({ length: 5 }, (_, i) => post(1_000_000, 60 + i));
  const r = expectedViews({ platform: 'tiktok', raw_data: { posts: [...old, ...recent] }, nowMs: NOW });
  assert(EXPECTED_VIEWS_MAX_POSTS === 10, 'window is the last 10 posts');
  assert(r?.n === 10 && r?.views === 1005, `only the 10 most recent eligible posts count (got ${JSON.stringify(r)})`);
}
{
  // ISO timestamps (some actor versions) are read too.
  const iso = (plays: number, ageDays: number) => ({ playCount: plays, createTimeISO: new Date(NOW - ageDays * DAY).toISOString() });
  const r = expectedViews({ platform: 'tiktok', raw_data: { posts: [iso(10, 4), iso(20, 5), iso(30, 6)] }, nowMs: NOW });
  assert(r?.views === 20, `createTimeISO is honoured (got ${JSON.stringify(r)})`);
}
{
  // A post with no timestamp cannot be shown to be ≥3 days old — excluded.
  const r = expectedViews({
    platform: 'tiktok',
    raw_data: { posts: [{ playCount: 5 }, { playCount: 6 }, post(10, 4), post(20, 5)] },
    nowMs: NOW,
  });
  assert(r === null, 'undated posts do not count toward the minimum');
}
{
  // Missing / non-numeric / negative play counts are not zero views.
  const r = expectedViews({
    platform: 'tiktok',
    raw_data: { posts: [post(undefined, 4), post(Number.NaN, 4), post(-5, 4), post(100, 5), post(200, 6), post(300, 7)] },
    nowMs: NOW,
  });
  assert(r?.views === 200 && r?.n === 3, `unreadable play counts are skipped, never read as 0 (got ${JSON.stringify(r)})`);
}
{
  // Instagram: refused even when the payload happens to carry a playCount
  // (see the refusal at discovery-candidates.ts toDiscoveryPost).
  const posts = [post(1000, 5), post(3000, 6), post(2000, 7)];
  assert(expectedViews({ platform: 'instagram', raw_data: { posts }, nowMs: NOW }) === null, 'Instagram → null');
  assert(expectedViews({ platform: 'Instagram', raw_data: { posts }, nowMs: NOW }) === null, 'Instagram (any case) → null');
  assert(expectedViews({ platform: null, raw_data: { posts }, nowMs: NOW }) === null, 'unknown platform → null (fail closed)');
}
{
  for (const raw of [null, undefined, {}, { posts: null }, { posts: 'x' }, 'garbage', 42]) {
    assert(expectedViews({ platform: 'tiktok', raw_data: raw, nowMs: NOW }) === null, `malformed raw_data ${JSON.stringify(raw)} → null`);
  }
}

// ── constants are the documented, unvalidated defaults ──────────────────────
assert(DEFAULT_VIEW_FACTOR_K === 0.75, 'k defaults to 0.75 (unvalidated)');
assert(COLD_START_TARGET_CPM_USD > 0, 'cold-start constant is positive');
assert(DEFAULT_MAX_OVER_TARGET > 1, 'default max sits above target');

// ── impliedFormulaCpm / poolTargetCpm ───────────────────────────────────────
assert(impliedFormulaCpm(150, 20_000, 0.75) === 10, 'implied CPM = price / (views × k / 1000)');
assert(impliedFormulaCpm(150, null, 0.75) === null, 'no views → no implied CPM');
assert(impliedFormulaCpm(150, 0, 0.75) === null, 'zero views → no implied CPM (never divide by zero)');
{
  const pool = [
    { formula_price: 150, views: 20_000 }, // 10
    { formula_price: 100, views: 20_000 }, // 6.67
    { formula_price: 250, views: 20_000 }, // 16.67
    { formula_price: 500, views: null }, // ignored
  ];
  const t = poolTargetCpm(pool, 0.75);
  assert(t?.cpm === 10 && t?.n === 3, `pool target = median implied CPM over creators with views (got ${JSON.stringify(t)})`);
  assert(poolTargetCpm(pool.slice(0, 2), 0.75) === null, 'fewer than 3 priced creators → no pool target');
  assert(poolTargetCpm([], 0.75) === null, 'empty pool → no pool target');
}

// ── computeCpmPricing ───────────────────────────────────────────────────────
{
  // Campaign-set target and max.
  const b = computeCpmPricing({
    views: { views: 20_000, n: 8 },
    formulaPriceUsd: 150,
    perCreatorCapUsd: 500,
    campaignTargetCpmUsd: 8,
    campaignMaxCpmUsd: 12,
  });
  assert(b.method === 'cpm', 'views present → method cpm');
  assert(b.price === 120, `opening = views × k × target / 1000 = 20000×0.75×8/1000 = 120 (got ${b.price})`);
  assert(b.walkaway === 180, `walk-away = views × k × max / 1000 = 180 (got ${b.walkaway})`);
  assert(b.k === 0.75 && b.k_source === 'default', 'k recorded with its source');
  assert(b.target === 8 && b.max === 12 && b.target_source === 'campaign', 'campaign target/max recorded');
  assert(b.n === 8 && b.views === 20_000, 'views and their sample size recorded');
  assert(b.formula_price === 150 && b.applied === false, 'formula price alongside, marked not applied');
}
{
  // Always ≤ the per-creator cap — price AND walk-away.
  const b = computeCpmPricing({
    views: { views: 200_000, n: 10 },
    formulaPriceUsd: 200,
    perCreatorCapUsd: 200,
    campaignTargetCpmUsd: 8,
    campaignMaxCpmUsd: 12,
  });
  assert(b.price === 200 && b.walkaway === 200, `capped at the per-creator cap (got ${b.price}/${b.walkaway})`);
}
{
  // Cold start from the pool, max defaults to target × DEFAULT_MAX_OVER_TARGET.
  const b = computeCpmPricing({
    views: { views: 20_000, n: 5 },
    formulaPriceUsd: 150,
    perCreatorCapUsd: 500,
    poolTarget: { cpm: 10, n: 40 },
  });
  assert(b.target === 10 && b.target_source === 'pool' && b.target_n === 40, 'cold start uses the pool-implied CPM');
  assert(b.price === 150, `pool-median creator prices at its formula price (got ${b.price})`);
  assert(b.max === 10 * DEFAULT_MAX_OVER_TARGET, 'max defaults to target × the default ratio');
}
{
  // No campaign target, no pool → the constant.
  const b = computeCpmPricing({ views: { views: 20_000, n: 5 }, formulaPriceUsd: 150, perCreatorCapUsd: 500 });
  assert(b.target === COLD_START_TARGET_CPM_USD && b.target_source === 'default', 'no data → constant target');
}
{
  // A campaign max below the derived target pulls the target down; the opening never exceeds the walk-away.
  const b = computeCpmPricing({
    views: { views: 20_000, n: 5 },
    formulaPriceUsd: 150,
    perCreatorCapUsd: 500,
    campaignMaxCpmUsd: 4,
    poolTarget: { cpm: 10, n: 40 },
  });
  assert(b.target === 4 && b.max === 4, `target clamps to max (got ${b.target}/${b.max})`);
  assert(b.price <= (b.walkaway ?? Infinity), 'opening ≤ walk-away');
}
{
  // No views → formula fallback, no invented walk-away.
  const b = computeCpmPricing({ views: null, formulaPriceUsd: 150, perCreatorCapUsd: 500, campaignTargetCpmUsd: 8 });
  assert(b.method === 'formula' && b.price === 150 && b.walkaway === null && b.views === null && b.n === 0, `no views → formula fallback (got ${JSON.stringify(b)})`);
}
{
  // Bad campaign config (non-positive / NaN) is ignored, never used.
  const b = computeCpmPricing({
    views: { views: 20_000, n: 5 },
    formulaPriceUsd: 150,
    perCreatorCapUsd: 500,
    campaignTargetCpmUsd: 0,
    campaignMaxCpmUsd: Number.NaN,
  });
  assert(b.target_source === 'default' && b.target === COLD_START_TARGET_CPM_USD, 'non-positive campaign target is ignored');
}

console.log(`cpm-pricing test: ${passed} passed, ${failed} failed`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
