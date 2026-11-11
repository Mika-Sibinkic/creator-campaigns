-- Migration 022 — widen campaign_outcomes.streams_attribution_method CHECK
-- to admit 'synthetic_sample': the in-data label on fabricated demo outcomes
-- written by tools/seed-sample-analytics.mjs (one of its three sample labels).
-- The 009 constraint predates the sample-data feature. Additive-permissive:
-- every existing row satisfies the widened check.
-- Rollback: delete rows with streams_attribution_method = 'synthetic_sample'
-- (the seeder's --remove does this), then re-add the 009 constraint.

ALTER TABLE public.campaign_outcomes
  DROP CONSTRAINT IF EXISTS campaign_outcomes_streams_attribution_method_check;

ALTER TABLE public.campaign_outcomes
  ADD CONSTRAINT campaign_outcomes_streams_attribution_method_check
  CHECK (streams_attribution_method IS NULL OR streams_attribution_method IN
    ('manual', 'spotify_for_artists', 'estimated_from_views', 'unknown', 'synthetic_sample'));
