// tests/cpm-model.test.ts — hermetic. Run: npx tsx tests/cpm-model.test.ts
import { latestSnapshot, totalReach, labelCpm, dealCpmFeatures } from '../src/lib/cpm-model';

let passed = 0, failed = 0;
const fails: string[] = [];
function assert(c: boolean, m: string) { if (c) passed++; else { failed++; fails.push(m); console.error(`  ✗ ${m}`); } }

// latestSnapshot
const snaps = [
  { captured_at: '2026-07-01T00:00:00Z', views: 1000 },
  { captured_at: '2026-07-08T00:00:00Z', views: 5000 },
];
assert(latestSnapshot(snaps)?.views === 5000, 'latestSnapshot picks newest');
assert(latestSnapshot([]) === null, 'latestSnapshot empty → null');

// totalReach
assert(totalReach([{ captured_at: 'x', views: 5000 }, { captured_at: 'y', views: 3000 }]) === 8000, 'totalReach sums views');
assert(totalReach([{ captured_at: 'x', views: null }]) === 0, 'totalReach null → 0');

// labelCpm = spend / (reach/1000)
assert(labelCpm(185, 50000) === 3.7, `labelCpm 185/50k = 3.7 (got ${labelCpm(185, 50000)})`);
assert(labelCpm(100, 0) === null, 'labelCpm zero reach → null');

// features
const f = dealCpmFeatures({
  agreedAmountUsd: 185, openingOfferUsd: 120, rounds: 2,
  deliverables: [{ promo_type: 'reel', quantity: 2, delivery_window_days: 14, min_seconds: 30 }],
  reach: 50000, campaignSize: 267, scrapeQuality: 63.6,
});
assert(f.outreach_to_agreement_delta_usd === 65, 'delta = agreed - opening (185-120=65)');
assert(f.deliverable_weight === 2.6, `deliverable_weight = 1.3×2 = 2.6 (got ${f.deliverable_weight})`);
assert(f.label_cpm === 3.7, 'label_cpm computed');
assert(f.campaign_size === 267 && f.scrape_quality === 63.6, 'context carried through');
assert(dealCpmFeatures({ agreedAmountUsd: 185, rounds: 1, deliverables: [], reach: 0 }).outreach_to_agreement_delta_usd === null, 'null opening → null delta');

console.log(`cpm-model test: ${passed} passed, ${failed} failed`);
if (fails.length) console.error('Failures:\n  - ' + fails.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
