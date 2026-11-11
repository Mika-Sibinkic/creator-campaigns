// tests/cpm-snapshots.test.ts
//
// The CPM time series (migration 042 + writeCpmSnapshots in
// src/lib/measurement-tick.ts). Hermetic: in-memory harness store, no network.
//
// Proves:
//   1. spend = Σ agreed over PAID_STATES offers only (committed-not-paid and
//      rejected money never counts);
//   2. verified_reach = Σ LATEST snapshot views per delivery;
//   3. label_cpm = spend / (reach/1000), and NULL — never fabricated — when
//      verified reach is 0;
//   4. one row per (campaign, UTC day): a same-day re-run refreshes the row
//      instead of duplicating it;
//   5. pre-migration (table select errors) the writer skips silently — the
//      measurement tick's heartbeat is never at risk.
//
// Run: npx tsx tests/cpm-snapshots.test.ts

import './negotiation-harness/setup-env'; // FIRST — dummy env, no network
import { writeCpmSnapshots } from '../src/lib/measurement-tick';
import { makeStore } from './negotiation-harness/store';
import type { SupabaseClient } from '@supabase/supabase-js';

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

const NOW = Date.parse('2026-09-17T15:00:00.000Z');

function seedWorld() {
  const store = makeStore();
  store.seed('campaigns', { id: 'camp-1', firm_id: 'firm-1', synthetic: false });
  // Money moved: paid $100 + measured $150 = $250.
  store.seed('creator_offers', {
    id: 'offer-paid',
    campaign_id: 'camp-1',
    firm_id: 'firm-1',
    status: 'paid',
    agreed_amount_usd: 100,
  });
  store.seed('creator_offers', {
    id: 'offer-measured',
    campaign_id: 'camp-1',
    firm_id: 'firm-1',
    status: 'measured',
    agreed_amount_usd: 150,
  });
  // Committed but NOT paid — must not count as spend.
  store.seed('creator_offers', {
    id: 'offer-agreed',
    campaign_id: 'camp-1',
    firm_id: 'firm-1',
    status: 'agreed',
    agreed_amount_usd: 999,
  });
  // Reach: two deliveries; one has two snapshots (latest wins), one has one.
  store.seed('deal_deliveries', { id: 'del-1', creator_offer_id: 'offer-paid' });
  store.seed('deal_deliveries', { id: 'del-2', creator_offer_id: 'offer-measured' });
  store.seed('deal_performance_snapshots', {
    id: 's1',
    deal_delivery_id: 'del-1',
    captured_at: '2026-09-10T00:00:00.000Z',
    views: 5_000,
  });
  store.seed('deal_performance_snapshots', {
    id: 's2',
    deal_delivery_id: 'del-1',
    captured_at: '2026-09-16T00:00:00.000Z',
    views: 30_000,
  });
  store.seed('deal_performance_snapshots', {
    id: 's3',
    deal_delivery_id: 'del-2',
    captured_at: '2026-09-15T00:00:00.000Z',
    views: 20_000,
  });
  return store;
}

async function scenarioMathAndRefresh() {
  const store = seedWorld();

  const written = await writeCpmSnapshots(store.sb, ['camp-1'], NOW);
  assert(written === 1, `one row written (got ${written})`);
  const rows = store.all('cpm_snapshots');
  assert(rows.length === 1, `one cpm_snapshots row (got ${rows.length})`);
  const row = rows[0];
  assert(row.campaign_id === 'camp-1' && row.firm_id === 'firm-1', 'row is campaign+firm scoped');
  assert(row.snapshot_date === '2026-09-17', `UTC snapshot date (got ${row.snapshot_date})`);
  assert(Number(row.spend_usd) === 250, `spend counts PAID_STATES only: 100+150 (got ${row.spend_usd})`);
  assert(Number(row.verified_reach) === 50_000, `reach = latest-per-delivery 30k+20k (got ${row.verified_reach})`);
  assert(Number(row.label_cpm) === 5, `label CPM = 250/(50000/1000) = $5.00 (got ${row.label_cpm})`);

  // Same-day re-run after more reach lands → REFRESH, not a second row.
  store.seed('deal_performance_snapshots', {
    id: 's4',
    deal_delivery_id: 'del-2',
    captured_at: '2026-09-17T12:00:00.000Z',
    views: 50_000,
  });
  const again = await writeCpmSnapshots(store.sb, ['camp-1'], NOW + 60_000);
  assert(again === 1, 'same-day re-run reports the refresh');
  const after = store.all('cpm_snapshots');
  assert(after.length === 1, `still exactly one row for the day (got ${after.length})`);
  assert(Number(after[0].verified_reach) === 80_000, `reach refreshed to 30k+50k (got ${after[0].verified_reach})`);
  assert(Number(after[0].label_cpm) === 3.13, `CPM refreshed: 250/80 = 3.13 (got ${after[0].label_cpm})`);

  // A NEW day gets its own row.
  const nextDay = await writeCpmSnapshots(store.sb, ['camp-1'], NOW + 24 * 3600 * 1000);
  assert(nextDay === 1, 'next-day run writes');
  assert(store.all('cpm_snapshots').length === 2, 'a new UTC day appends a new row (the time series)');
}

async function scenarioNoReachNeverFabricates() {
  const store = makeStore();
  store.seed('campaigns', { id: 'camp-2', firm_id: 'firm-1', synthetic: false });
  store.seed('creator_offers', {
    id: 'offer-x',
    campaign_id: 'camp-2',
    firm_id: 'firm-1',
    status: 'paid',
    agreed_amount_usd: 200,
  });
  // No deliveries, no snapshots → reach 0.
  const written = await writeCpmSnapshots(store.sb, ['camp-2'], NOW);
  assert(written === 1, 'zero-reach campaign still gets its spend row');
  const row = store.all('cpm_snapshots')[0];
  assert(Number(row.spend_usd) === 200, 'spend recorded');
  assert(Number(row.verified_reach) === 0, 'reach 0');
  assert(row.label_cpm === null, 'label_cpm NULL on zero reach — never fabricated');
}

async function scenarioPreMigrationSkipsSilently() {
  const store = seedWorld();
  // Wrap the store: any touch of cpm_snapshots errors like a missing table.
  const sb = {
    from(table: string) {
      if (table === 'cpm_snapshots') {
        const err = { message: 'relation "cpm_snapshots" does not exist' };
        const chain = {
          select: () => chain,
          insert: () => chain,
          update: () => chain,
          eq: () => chain,
          in: () => chain,
          maybeSingle: async () => ({ data: null, error: err }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: err }),
        };
        return chain;
      }
      return (store.sb as unknown as { from(t: string): unknown }).from(table);
    },
  } as unknown as SupabaseClient;

  let threw = false;
  let written = -1;
  try {
    written = await writeCpmSnapshots(sb, ['camp-1'], NOW);
  } catch {
    threw = true;
  }
  assert(!threw, 'pre-migration state never throws');
  assert(written === 0, `pre-migration state writes nothing (got ${written})`);
}

async function main() {
  await scenarioMathAndRefresh();
  await scenarioNoReachNeverFabricates();
  await scenarioPreMigrationSkipsSilently();

  console.log(`cpm-snapshots test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
