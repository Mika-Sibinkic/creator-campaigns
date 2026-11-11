// src/lib/tick-runs.ts
//
// Persist one tick_runs row per scheduler tick run (migration 044) — the
// answer to "did the loop run, when, and what did it do", which previously
// evaporated with the HTTP response (MeasurementTally) or hid inside one
// audit_log heartbeat's metadata (negotiation).
//
// Doctrine: write-then-don't-throw, exactly like audit.ts and api-ledger.ts.
// The tick's real work is already done by the time this runs; a broken (or
// not-yet-applied — the migration ships unapplied) table must never fail the
// tick. The Supabase client is INJECTED by the route (service-role admin),
// mirroring the SEC-1 visible-blast-radius pattern of the tick libs
// themselves, and keeping this module import-safe for hermetic tests.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from './logger';

const log = createLogger('tick-runs');

export type TickName = 'negotiation' | 'measurement' | 'enrichment' | 'dispatch';

export interface TickRunEntry {
  tick: TickName;
  /** ms epoch when the tick body started. */
  startedAtMs: number;
  /** ms epoch when the tick body finished (success or throw). */
  finishedAtMs: number;
  /** true = the tick body completed; false = it threw. */
  ok: boolean;
  /** The tick's own tally object (TickTally / MeasurementTally), when ok. */
  tally?: Record<string, unknown> | null;
  /** Error message, when !ok. */
  error?: string | null;
}

/** Insert one tick_runs row. Never throws; logs and returns on failure. */
export async function recordTickRun(sb: SupabaseClient, e: TickRunEntry): Promise<void> {
  try {
    const { error } = await sb.from('tick_runs').insert({
      tick: e.tick,
      started_at: new Date(e.startedAtMs).toISOString(),
      finished_at: new Date(e.finishedAtMs).toISOString(),
      ok: e.ok,
      tally: e.tally ?? null,
      error: e.error ?? null,
    } as never);
    if (error) {
      // Expected until migration 044 is applied — visible, not fatal.
      log.warn('tick_runs insert failed', { tick: e.tick, error: error.message });
    }
  } catch (err) {
    log.warn('tick_runs insert threw', { tick: e.tick, error: err as Error });
  }
}
