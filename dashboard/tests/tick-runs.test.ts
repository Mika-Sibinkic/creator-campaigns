// tests/tick-runs.test.ts
//
// Hermetic tests for tick-run persistence (src/lib/tick-runs.ts, migration
// 044) and the stalled-tick anomaly lane (src/lib/statuses.ts). A minimal
// chainable mock records inserts; no DB, no network.
//
// Run: npx tsx tests/tick-runs.test.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import { recordTickRun } from '../src/lib/tick-runs';
import { _setSink } from '../src/lib/logger';
import {
  detectAnomalies,
  STALLED_TICK_THRESHOLD_MS,
  type AnomaliesInput,
} from '../src/lib/statuses';

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

_setSink(() => {}); // silence the writer's warn path in the failure cases

function mockSb(behavior: 'ok' | 'error' | 'throw'): {
  sb: SupabaseClient;
  inserts: { table: string; row: Record<string, unknown> }[];
} {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const sb = {
    from(table: string) {
      return {
        async insert(row: Record<string, unknown>) {
          if (behavior === 'throw') throw new Error('connection reset');
          inserts.push({ table, row });
          return behavior === 'error'
            ? { error: { message: 'relation "tick_runs" does not exist' } }
            : { error: null };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { sb, inserts };
}

const EMPTY_INPUT: AnomaliesInput = {
  offers: [],
  payments: [],
  deliveries: [],
  audit: [],
  inbound: [],
  cis: [],
  influencers: [],
  campaigns: [],
  hasContractTemplate: false,
};

async function main() {
  // ── recordTickRun: row shape ─────────────────────────────────────────────
  {
    const { sb, inserts } = mockSb('ok');
    await recordTickRun(sb, {
      tick: 'negotiation',
      startedAtMs: 1_000_000,
      finishedAtMs: 1_004_000,
      ok: true,
      tally: { processed: 2, sent: 1 },
    });
    assert(inserts.length === 1, 'one insert per run');
    const row = inserts[0];
    assert(row.table === 'tick_runs', 'writes to tick_runs');
    assert(row.row.tick === 'negotiation', 'tick name persisted');
    assert(row.row.started_at === new Date(1_000_000).toISOString(), 'started_at ISO');
    assert(row.row.finished_at === new Date(1_004_000).toISOString(), 'finished_at ISO');
    assert(row.row.ok === true, 'ok=true persisted');
    assert(
      JSON.stringify(row.row.tally) === JSON.stringify({ processed: 2, sent: 1 }),
      'tally persisted verbatim',
    );
    assert(row.row.error === null, 'no error on a success row');
  }

  // ── recordTickRun: failure row ───────────────────────────────────────────
  {
    const { sb, inserts } = mockSb('ok');
    await recordTickRun(sb, {
      tick: 'measurement',
      startedAtMs: 5,
      finishedAtMs: 9,
      ok: false,
      error: 'apify exploded',
    });
    assert(inserts[0].row.ok === false, 'ok=false persisted');
    assert(inserts[0].row.error === 'apify exploded', 'error message persisted');
    assert(inserts[0].row.tally === null, 'no tally on a failure row');
  }

  // ── write-then-don't-throw: table missing (pre-migration) and hard throw ─
  {
    const { sb } = mockSb('error');
    let threw = false;
    try {
      await recordTickRun(sb, {
        tick: 'negotiation',
        startedAtMs: 1,
        finishedAtMs: 2,
        ok: true,
      });
    } catch {
      threw = true;
    }
    assert(!threw, 'insert error (table absent pre-044) never throws');
  }
  {
    const { sb } = mockSb('throw');
    let threw = false;
    try {
      await recordTickRun(sb, {
        tick: 'negotiation',
        startedAtMs: 1,
        finishedAtMs: 2,
        ok: true,
      });
    } catch {
      threw = true;
    }
    assert(!threw, 'insert throw never propagates');
  }

  // ── stalled-tick anomaly lane ────────────────────────────────────────────
  const NOW = Date.parse('2026-09-17T12:00:00.000Z');
  {
    // Fresh run (5 min ago) → silent.
    const rows = detectAnomalies(
      { ...EMPTY_INPUT, tick: { last_negotiation_run_at: new Date(NOW - 5 * 60_000).toISOString() } },
      NOW,
    );
    assert(rows.length === 0, 'fresh tick run raises nothing');
  }
  {
    // Exactly at the threshold → NOT stalled (strictly greater, like stall_negotiation).
    const rows = detectAnomalies(
      {
        ...EMPTY_INPUT,
        tick: { last_negotiation_run_at: new Date(NOW - STALLED_TICK_THRESHOLD_MS).toISOString() },
      },
      NOW,
    );
    assert(rows.length === 0, 'exactly 15 min is not stalled');
  }
  {
    // 40 minutes of silence → stalled_tick anomaly with minute count.
    const rows = detectAnomalies(
      { ...EMPTY_INPUT, tick: { last_negotiation_run_at: new Date(NOW - 40 * 60_000).toISOString() } },
      NOW,
    );
    assert(rows.length === 1, 'stalled tick raises one anomaly');
    assert(rows[0].category === 'stalled_tick', 'category stalled_tick');
    assert(rows[0].what.includes('40 minutes'), `what names the gap (got "${rows[0].what}")`);
    assert(rows[0].ref === 'stalled-tick-negotiation', 'stable ref');
  }
  {
    // No tick input (pre-migration / empty table) → silent, never a false alarm.
    const rows = detectAnomalies({ ...EMPTY_INPUT }, NOW);
    assert(rows.length === 0, 'absent tick input stays silent');
    const rows2 = detectAnomalies({ ...EMPTY_INPUT, tick: { last_negotiation_run_at: null } }, NOW);
    assert(rows2.length === 0, 'null last-run stays silent');
  }

  console.log(`tick-runs test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
