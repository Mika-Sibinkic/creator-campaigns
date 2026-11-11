-- 012_campaign_outcomes_unique_creator_offer.sql
--
-- /api/outcomes/record upserts into campaign_outcomes with
-- onConflict: 'creator_offer_id'. That requires a UNIQUE index on the
-- column. The original schema only had a non-unique idx_campaign_outcomes_offer,
-- so the first Record-streams click after a deal landed at PostgREST with:
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
--
-- Replace the non-unique index with a unique one. One outcome row per
-- creator_offer matches product intent — outcomes are measured once per
-- deal; later re-measurements OVERWRITE.

DROP INDEX IF EXISTS public.idx_campaign_outcomes_offer;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_campaign_outcomes_creator_offer
  ON public.campaign_outcomes (creator_offer_id);
