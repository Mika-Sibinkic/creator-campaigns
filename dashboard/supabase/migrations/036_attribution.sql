-- 036_attribution.sql — Soundcharts artist confirmation + stream
-- baseline/poll + deliverable-spec verification. Additive only.
--
-- campaigns:
--   artist_soundcharts_uuid  — Soundcharts artist UUID picked in the new-campaign
--                              confirmation seam (null = legacy free-text flow).
--   artist_baseline          — jsonb metric snapshot captured at campaign confirm
--                              (spotify listeners + trimmed metadata); the anchor
--                              the attribution deltas are measured against.
--   artist_confirmed_source  — how the identity was confirmed ('soundcharts').
alter table public.campaigns
  add column if not exists artist_soundcharts_uuid text,
  add column if not exists artist_baseline jsonb,
  add column if not exists artist_confirmed_source text;

-- Artist-level metric time series polled by the measurement tick (hourly
-- cadence, gated to the week-then-monthly snapshot rhythm and max 3
-- campaigns per tick). One row per poll; source/metric kept generic so a
-- second platform metric can land without a schema change.
create table if not exists public.artist_metric_snapshots (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  firm_id uuid not null references public.firms(id) on delete cascade,
  source text not null default 'soundcharts',
  metric text not null default 'spotify_listeners',
  value numeric,
  captured_at timestamptz not null default now()
);
create index if not exists artist_metric_snapshots_campaign_idx
  on public.artist_metric_snapshots(campaign_id);
create index if not exists artist_metric_snapshots_captured_idx
  on public.artist_metric_snapshots(captured_at);
alter table public.artist_metric_snapshots enable row level security;

-- Deliverable-spec verification result, stamped when the measurement scrape
-- finds the post. Deliberately NOT part of the status state machine —
-- status stays pending/verified/missing (existence), spec_check records
-- whether the found post matches the agreed deliverables (type x duration).
--   pass    — duration >= 90% of the agreed minimum (or no minimum agreed)
--   fail    — duration below the 90% tolerance of the agreed minimum
--   partial — found the post but could not fully check (no duration in the
--             scrape payload, or a story-only bundle a feed scrape can't see)
alter table public.deal_deliveries
  add column if not exists spec_check text
    check (spec_check in ('pass', 'fail', 'partial')),
  add column if not exists spec_check_detail text;
