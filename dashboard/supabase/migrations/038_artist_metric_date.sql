-- 038_artist_metric_date.sql — make artist_metric_snapshots usable
-- as a time series. Additive only.
--
-- 036 gave the table `captured_at` (when WE polled) but no field for the day a
-- reading is actually FOR. Those are not the same day: Soundcharts lags the
-- platform by up to three days, so two polls 24h apart routinely return the
-- same underlying reading. Without a metric_date the poller either writes a
-- duplicate point every day — manufacturing flat stretches that never happened
-- — or has to guess. Neither produces a series you can honestly difference.
--
--   metric_date  — the calendar day the reading describes, straight from the
--                  Soundcharts series `date`. This is the x-axis of every lift
--                  calculation. Nullable because rows written before this
--                  migration have no honest value to backfill: their
--                  captured_at is a poll time and inferring a metric_date from
--                  it would be a fabricated data point. src/lib/stream-lift.ts
--                  ignores rows without one rather than guessing.
--
-- The unique index is the idempotency guarantee that lets the measurement tick
-- re-request a whole window every day and simply not write what it already
-- holds. NULLs are distinct in a Postgres unique index by default, so the
-- pre-existing metric_date-less rows do not collide with each other or block
-- this index.
--
-- Rollback:
--   drop index if exists artist_metric_snapshots_campaign_metric_day_key;
--   alter table public.artist_metric_snapshots drop column if exists metric_date;

alter table public.artist_metric_snapshots
  add column if not exists metric_date date;

comment on column public.artist_metric_snapshots.metric_date is
  'Calendar day the reading is FOR (Soundcharts series date), as opposed to captured_at which is when we polled. Null on rows written before migration 038; those rows are excluded from lift calculations rather than back-dated.';

create unique index if not exists artist_metric_snapshots_campaign_metric_day_key
  on public.artist_metric_snapshots(campaign_id, metric, metric_date);

create index if not exists artist_metric_snapshots_campaign_metric_date_idx
  on public.artist_metric_snapshots(campaign_id, metric, metric_date desc);
