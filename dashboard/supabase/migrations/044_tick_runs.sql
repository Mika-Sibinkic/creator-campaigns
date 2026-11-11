-- 044_tick_runs.sql — observability spine: persist tick outcomes.
--
-- Why: the negotiation and measurement ticks each compute a rich tally
-- (processed/sent/flagged/scraped/costUsd/…) and then throw it away — the
-- MeasurementTally lives only in the HTTP response, and the negotiation tick
-- leaves one system.cron.* heartbeat row in audit_log with the tally buried
-- in jsonb metadata. Neither answers the two operational questions cheaply:
--   1. "Is the loop alive?"  → newest row per tick, indexed below; the
--      /api/anomalies stalled-tick lane reads exactly this (no negotiation
--      run in >15 min → anomaly).
--   2. "What did run N do / why did it fail?" → tally jsonb + error text,
--      one row per run, success AND failure.
--
-- Writers: src/app/api/negotiation/tick/route.ts and
-- src/app/api/measurement/tick/route.ts via src/lib/tick-runs.ts
-- (write-then-don't-throw, same doctrine as audit.ts — a ledger failure must
-- never take the tick down). The application tolerates this table being
-- absent (pre-apply): the writer swallows the error and the anomalies route
-- degrades to "no stall detection".
--
-- Additive only. No existing table or row is touched.

create table if not exists public.tick_runs (
  id uuid primary key default gen_random_uuid(),
  -- 'negotiation' | 'measurement' — plain text, no CHECK, so a future tick
  -- enrolls without a migration (same reasoning as api_ledger.source).
  tick text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  -- true = the tick body completed; false = it threw. Null never written by
  -- the current writers, tolerated for forward-compat.
  ok boolean,
  -- The tick's own tally object, verbatim (TickTally / MeasurementTally).
  tally jsonb,
  -- (e as Error).message when ok = false.
  error text,
  created_at timestamptz not null default now()
);

-- The stall probe is "newest row for tick X" — this index makes it O(1).
create index if not exists tick_runs_tick_started_idx
  on public.tick_runs (tick, started_at desc);

-- System table: service-role writes/reads only. RLS enabled with no policies
-- (deny-all for authed users; the service role bypasses RLS) — the same
-- arrangement as processed_stripe_events / artist_metric_snapshots.
alter table public.tick_runs enable row level security;

comment on table public.tick_runs is
  'One row per scheduler tick run (negotiation / measurement), success or '
  'failure, written by src/lib/tick-runs.ts. Newest row per tick answers '
  '"is the loop alive"; /api/anomalies raises stalled_tick when the newest '
  'negotiation run is older than 15 minutes.';
