// tests/engagement-curve.test.ts
//
// The engagement multiplier in pricing-engine.ts, calibrated so offers vary
// per creator by engagement strength.
//
// The old curve, clamp(0.7 + ER/0.05, 0.7, 1.5), hit its 1.5x ceiling at 4% ER.
// Against a TikTok pool with an 8.13% median that gives 234 of 300 synthetic
// creators the maximum. These tests pin:
//   1. the anchors: p10 → 0.75x, p50 → 1.0x, p90+ → 1.4x, floor 0.7x;
//   2. monotonicity across the whole ER range;
//   3. the synthetic sample (tests/fixtures/engagement, generated from the
//      calibration anchors) is no longer saturated: the multipliers spread;
//   4. every offer still sits under the per-creator cap, so no ceiling moves.
//
// Hermetic: no env, no network, no DB.
// Run: npx tsx tests/engagement-curve.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENGAGEMENT_CALIBRATION,
  ENGAGEMENT_MULTIPLIER_CAP,
  ENGAGEMENT_MULTIPLIER_FLOOR,
  calculateInitialOffer,
  engagementMultiplier,
} from '../src/lib/pricing-engine';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/engagement/synthetic-er.json'), 'utf8'),
) as { n: number; tiktok: number[] };
const live = fixture.tiktok;
const cal = ENGAGEMENT_CALIBRATION.tiktok;

// ── 1. Anchors ────────────────────────────────────────────────────────────
{
  assert(close(engagementMultiplier(cal.p10, 'tiktok'), 0.75), 'p10 → 0.75x');
  assert(close(engagementMultiplier(cal.p50, 'tiktok'), 1.0), 'median → 1.0x');
  assert(close(engagementMultiplier(cal.p90, 'tiktok'), 1.4), 'p90 → 1.4x');
  assert(engagementMultiplier(0.85, 'tiktok') === ENGAGEMENT_MULTIPLIER_CAP, 'far above p90 holds at the cap');
  assert(engagementMultiplier(0.0001, 'tiktok') === ENGAGEMENT_MULTIPLIER_FLOOR, 'near-zero ER sits on the floor');
  assert(engagementMultiplier(0, 'tiktok') === ENGAGEMENT_MULTIPLIER_FLOOR, 'zero ER → floor');
  assert(engagementMultiplier(-1, 'tiktok') === ENGAGEMENT_MULTIPLIER_FLOOR, 'negative ER → floor');
  assert(engagementMultiplier(Number.NaN, 'tiktok') === ENGAGEMENT_MULTIPLIER_FLOOR, 'NaN ER → floor');
  // THE OLD BUG: the comment said 5% → 1.0x; the code gave 1.5x.
  const m5 = engagementMultiplier(0.05, 'tiktok');
  assert(m5 > 0.75 && m5 < 1.0, `5% ER is below the calibrated median, so below 1.0x (got ${m5.toFixed(3)})`);
  // Unknown platform uses the TikTok anchors (the only calibrated platform).
  assert(engagementMultiplier(0.05) === m5, 'no platform → TikTok calibration');
  assert(engagementMultiplier(0.05, 'TikTok ') === m5, 'platform key is case/space-insensitive');
  // An unmeasured platform keeps the legacy linear curve.
  assert(close(engagementMultiplier(0.01, 'instagram'), 0.9), 'instagram (no calibration sample) keeps the legacy curve');
}

// ── 2. Monotonic ──────────────────────────────────────────────────────────
{
  let prev = -Infinity;
  let ok = true;
  for (let er = 0; er <= 1.0; er += 0.0005) {
    const m = engagementMultiplier(er, 'tiktok');
    if (m < prev - 1e-12) ok = false;
    if (m < ENGAGEMENT_MULTIPLIER_FLOOR - 1e-12 || m > ENGAGEMENT_MULTIPLIER_CAP + 1e-12) ok = false;
    prev = m;
  }
  assert(ok, 'multiplier is non-decreasing in ER and stays inside [floor, cap]');
  // Strictly increasing between p10 and p90, where offers must differ.
  assert(
    engagementMultiplier(0.04, 'tiktok') < engagementMultiplier(0.06, 'tiktok') &&
      engagementMultiplier(0.06, 'tiktok') < engagementMultiplier(0.1, 'tiktok') &&
      engagementMultiplier(0.1, 'tiktok') < engagementMultiplier(0.15, 'tiktok'),
    'strictly increasing through the body of the distribution',
  );
}

// ── 3. The synthetic sample is no longer saturated ─────────────────────────
{
  assert(fixture.n === 300 && live.length === 300, 'fixture carries the 300 synthetic TikTok rows');
  const ms = live.map((er) => engagementMultiplier(er, 'tiktok'));
  const atCap = ms.filter((m) => m >= ENGAGEMENT_MULTIPLIER_CAP - 1e-9).length;
  const oldAtCap = live.filter((er) => Math.min(1.5, Math.max(0.7, 0.7 + er / 0.05)) >= 1.5).length;
  assert(oldAtCap === 234, `the old curve saturated 234 of 300 (got ${oldAtCap})`);
  assert(atCap <= 40, `at most ~p90 of the pool sits at the cap (got ${atCap} of 300)`);
  const distinct = new Set(ms.map((m) => m.toFixed(2))).size;
  assert(distinct >= 40, `multipliers spread across many values (got ${distinct} distinct at 2dp)`);
  const sorted = [...ms].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))];
  assert(q(0.9) - q(0.1) >= 0.5, `p10→p90 spread ≥ 0.5x (got ${(q(0.9) - q(0.1)).toFixed(2)})`);
  assert(Math.abs(q(0.5) - 1.0) < 0.03, `median creator prices near 1.0x (got ${q(0.5).toFixed(3)})`);

  // Offers actually differ: a micro-tier creator at p10 vs p90.
  const lo = calculateInitialOffer({ follower_count: 20_000, engagement_rate: cal.p10, platform: 'tiktok', per_creator_cap_usd: 1000 });
  const hi = calculateInitialOffer({ follower_count: 20_000, engagement_rate: cal.p90, platform: 'tiktok', per_creator_cap_usd: 1000 });
  assert(lo.initial_offer_usd === 75 && hi.initial_offer_usd === 140, `micro p10 $75 vs p90 $140 (got $${lo.initial_offer_usd} / $${hi.initial_offer_usd})`);
}

// ── 4. Ceilings respected ─────────────────────────────────────────────────
{
  let ok = true;
  for (const er of live) {
    for (const followers of [5_000, 30_000, 120_000, 900_000]) {
      for (const cap of [40, 100, 250, 600]) {
        const r = calculateInitialOffer({
          follower_count: followers,
          engagement_rate: er,
          platform: 'tiktok',
          genre: 'country',
          genre_premiums: { country: 1.25 },
          per_creator_cap_usd: cap,
        });
        if (r.initial_offer_usd > cap || r.ceiling_usd !== cap) ok = false;
      }
    }
  }
  assert(ok, 'every sample offer is ≤ the per-creator cap and the ceiling is the cap, unchanged');
  const r = calculateInitialOffer({ follower_count: 20_000, engagement_rate: 0.06, platform: 'tiktok', per_creator_cap_usd: 500 });
  const m6 = engagementMultiplier(0.06, 'tiktok');
  assert(m6 < 1 && r.rationale.includes(`engagement=6.00% → ${m6.toFixed(2)}x`), `rationale reports the new multiplier (got ${r.rationale})`);
}

console.log(`\nengagement-curve: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
