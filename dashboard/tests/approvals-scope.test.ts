// tests/approvals-scope.test.ts
//
// Regression test for the cross-firm leak on /approvals.
//
// The bug: src/app/approvals/page.tsx selected payment_authorizations filtered
// only by status='pending_human_review'. requireSessionAndClient() returns the
// SERVICE-ROLE client (src/lib/auth.ts:160), which is RLS-inert, so migration
// 009's `payment_auth_select_own_firm` policy never ran. Firm A's approver saw
// firm B's pending payouts — creator handles, contact emails, amounts.
//
// Three layers, mirroring tests/firm-scope.test.ts:
//   1. fetchPendingApprovals against an in-memory store holding BOTH firms'
//      rows — firm B's rows must be absent for firm A, and the blank/unscoped
//      caller must get nothing rather than everything.
//   2. the filter is applied in the QUERY, not after the fact — a fake that
//      ignores .eq('firm_id') must still not leak (proves we didn't "fix" it
//      by post-filtering a full table read, which would still ship every
//      firm's rows over the wire).
//   3. source invariant — the page passes session.firm_id and never
//      hand-rolls its own unscoped payment_authorizations select again.
//
// Hermetic: no env, no network, no DB, no Clerk. Local fake store, same
// convention as tests/firm-scope.test.ts and tests/spend-caps.test.ts.
//
// Run: npx tsx tests/approvals-scope.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
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

const FIRM_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const FIRM_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

interface StoreRow {
  id: string;
  firm_id: string;
  status: string;
  amount_usd: number;
  created_at: string;
  creator_offer_id: string;
  creator_offers: unknown;
}

function row(id: string, firmId: string, amount: number, username: string, status = 'pending_human_review'): StoreRow {
  return {
    id,
    firm_id: firmId,
    status,
    amount_usd: amount,
    created_at: `2026-09-1${id.length}T00:00:00.000Z`,
    creator_offer_id: `offer-${id}`,
    creator_offers: {
      id: `offer-${id}`,
      rounds: 1,
      current_offer_usd: amount,
      agreed_amount_usd: amount,
      ceiling_usd: amount + 50,
      agreed_deliverables: null,
      contract_generated_at: null,
      campaigns: { id: `camp-${id}`, artist_name: `artist-${id}` },
      campaign_influencers: {
        influencer_id: `inf-${id}`,
        influencer: {
          username,
          display_name: username,
          follower_count: 1000,
          engagement_rate: 0.05,
          contact_email: `${username}@example.test`,
          profile_url: null,
        },
      },
    },
  };
}

const STORE: StoreRow[] = [
  row('a1', FIRM_A, 100, 'alpha_one'),
  row('a2', FIRM_A, 150, 'alpha_two'),
  row('b1', FIRM_B, 900, 'bravo_secret'),
  row('b2', FIRM_B, 800, 'bravo_secret_two'),
  // Same firm as A but already executed — must not show on the pending queue.
  row('a3', FIRM_A, 200, 'alpha_done', 'completed'),
];

/**
 * Minimal chainable Supabase fake. `honorFirmEq: false` deliberately IGNORES
 * the firm_id predicate, simulating a backend that returns everything — used
 * by layer 2 to prove the caller isn't relying on the DB to be well-behaved.
 */
function makeFake(opts: { honorFirmEq?: boolean; error?: { message: string } } = {}) {
  const honorFirmEq = opts.honorFirmEq !== false;
  const seenEq: Array<[string, unknown]> = [];
  let fromTable = '';

  const builder = {
    select() {
      return builder;
    },
    eq(col: string, val: unknown) {
      seenEq.push([col, val]);
      return builder;
    },
    order() {
      return builder;
    },
    then(resolve: (r: { data: unknown; error: unknown }) => void) {
      if (opts.error) {
        resolve({ data: null, error: opts.error });
        return;
      }
      let rows = STORE.slice();
      for (const [col, val] of seenEq) {
        if (col === 'firm_id' && !honorFirmEq) continue;
        rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[col] === val);
      }
      resolve({ data: rows, error: null });
    },
  };

  const client = {
    from(t: string) {
      fromTable = t;
      return builder;
    },
    _seenEq: seenEq,
    _table: () => fromTable,
  };
  return client as unknown as SupabaseClient & {
    _seenEq: Array<[string, unknown]>;
    _table: () => string;
  };
}

async function runCoreTests() {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. Firm A never sees firm B
  // ─────────────────────────────────────────────────────────────────────────
  {
    const sb = makeFake();
    const res = await fetchPendingApprovals(sb, FIRM_A);
    assert(res.ok === true, 'firm A scoped read succeeds');
    if (res.ok) {
      const ids = res.rows.map((r) => r.id).sort();
      assert(ids.length === 2, `firm A sees exactly its 2 pending rows (got ${ids.length})`);
      assert(ids.join(',') === 'a1,a2', `firm A sees a1,a2 (got ${ids.join(',')})`);

      const blob = JSON.stringify(res.rows);
      assert(!blob.includes('bravo_secret'), "firm B's creator handles absent from firm A's payload");
      assert(!blob.includes(FIRM_B), "firm B's firm id absent from firm A's payload");
      assert(!blob.includes('900'), "firm B's amounts absent from firm A's payload");
      assert(
        !res.rows.some((r) => r.status !== 'pending_human_review'),
        'only pending_human_review rows are returned (completed row excluded)'
      );
    }
  }

  // Symmetry: firm B likewise sees only its own.
  {
    const sb = makeFake();
    const res = await fetchPendingApprovals(sb, FIRM_B);
    assert(res.ok === true && res.rows.length === 2, 'firm B sees exactly its 2 pending rows');
    if (res.ok) {
      const blob = JSON.stringify(res.rows);
      assert(!blob.includes('alpha_one'), "firm A's creator handles absent from firm B's payload");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Fail closed on an unscoped caller — nothing, not everything
  // ─────────────────────────────────────────────────────────────────────────
  {
    for (const [label, val] of [
      ['empty string (unprovisioned Clerk user)', ''],
      ['whitespace only', '   '],
      ['null', null],
      ['undefined', undefined],
    ] as Array<[string, string | null | undefined]>) {
      const sb = makeFake();
      const res = await fetchPendingApprovals(sb, val);
      assert(res.ok === false, `${label} → refused`);
      assert(
        res.ok === false && res.reason === 'caller_unscoped',
        `${label} → reason caller_unscoped`
      );
      // The decisive part: it must not even ask the database.
      assert(sb._seenEq.length === 0, `${label} → no query issued at all`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. The firm filter is pushed into the query, not applied afterwards
  // ─────────────────────────────────────────────────────────────────────────
  {
    const sb = makeFake();
    await fetchPendingApprovals(sb, FIRM_A);
    const cols = sb._seenEq.map(([c]) => c);
    assert(cols.includes('firm_id'), "query carries an .eq('firm_id', ...) predicate");
    assert(cols.includes('status'), "query still carries the .eq('status', ...) predicate");
    const firmEq = sb._seenEq.find(([c]) => c === 'firm_id');
    assert(firmEq?.[1] === FIRM_A, 'firm predicate is bound to the CALLER firm id');
    assert(sb._table() === 'payment_authorizations', 'reads payment_authorizations');
  }

  // A backend that ignores the predicate would leak — we assert the predicate
  // is present (above) precisely because that is the only defense with a
  // service-role client. Document the failure mode explicitly:
  {
    const sb = makeFake({ honorFirmEq: false });
    const res = await fetchPendingApprovals(sb, FIRM_A);
    assert(
      res.ok === true && res.rows.length === 4,
      'control: ignoring the firm predicate WOULD return both firms (4 pending rows) — ' +
        'proves the assertion above is load-bearing'
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Query errors surface as a denial, not as an empty success
  // ─────────────────────────────────────────────────────────────────────────
  {
    const sb = makeFake({ error: { message: 'boom' } });
    const res = await fetchPendingApprovals(sb, FIRM_A);
    assert(res.ok === false, 'query error → not ok');
    assert(res.ok === false && res.reason === 'query_failed', 'query error → reason query_failed');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Source invariants — the page cannot regress to an unscoped read
  // ─────────────────────────────────────────────────────────────────────────
  {
    const pagePath = join(process.cwd(), 'src', 'app', 'approvals', 'page.tsx');
    const pageSrc = readFileSync(pagePath, 'utf8');

    assert(
      pageSrc.includes('fetchPendingApprovals'),
      'approvals page goes through fetchPendingApprovals'
    );
    assert(
      pageSrc.includes('session.firm_id'),
      'approvals page passes session.firm_id as the scope'
    );
    assert(
      !/\.from\(\s*['"]payment_authorizations['"]\s*\)/.test(pageSrc),
      'approvals page no longer queries payment_authorizations directly'
    );

    // The badge endpoint was already scoped; keep it that way.
    const countPath = join(process.cwd(), 'src', 'app', 'api', 'approvals', 'count', 'route.ts');
    const countSrc = readFileSync(countPath, 'utf8');
    assert(
      /\.eq\(\s*['"]firm_id['"]\s*,\s*session\.firm_id\s*\)/.test(countSrc),
      'approvals count route still firm-scopes its count'
    );

    // The query module itself must never lose its guard.
    const libPath = join(process.cwd(), 'src', 'lib', 'approvals-query.ts');
    const libSrc = readFileSync(libPath, 'utf8');
    assert(
      /\.eq\(\s*['"]firm_id['"]\s*,\s*callerFirmId\s*\)/.test(libSrc),
      'approvals-query binds the firm predicate to callerFirmId'
    );
  }
}

async function main() {
  await runCoreTests();
  if (failures.length > 0) console.error('\nFailures:\n - ' + failures.join('\n - '));
  console.log(`approvals-scope test: ${passed}/${passed + failed} pass`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
