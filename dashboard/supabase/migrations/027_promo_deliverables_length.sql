-- Reels/stories/dance videos carry a minimum time length (a 5-sec reel is not a
-- 30/60-sec reel). Nullable — length-agnostic types (feed post) leave it null.
alter table public.promo_deliverables
  add column if not exists min_seconds int check (min_seconds is null or min_seconds > 0);
comment on column public.promo_deliverables.min_seconds is
  'Minimum video length in seconds for time-based promo types (reel, dance_trend, video story). NULL for length-agnostic types.';
