-- 050_contact_enrichment_scan.sql
--
-- Lets contact discovery run off the request path, on every creator, instead of
-- only the top 25 of a live discovery run.
--
-- WHY
--   Contact discovery today is invoked from src/app/api/campaigns/[id]/run,
--   capped at CONTACTS_MAX_CREATORS = 25 inside a 60s wall-clock budget, because
--   it shares a 300s route with the whole pipeline. Consequence: a bio that
--   carries a plainly regex-matchable email outside the top 25 is never
--   harvested, although the address is already present in data we paid to
--   scrape. The regex pass is pure CPU, so lifting the cap costs nothing but a
--   place to run.
--
--   These two columns are that place: a cursor so a batched tick can walk the
--   whole pool without rescanning the same creator forever, and an attempt
--   counter so a creator whose bio will never yield an address stops consuming
--   budget.
--
-- Additive only. No backfill: a NULL contact_scanned_at means "never scanned",
-- which is exactly true of every existing row and is what the tick selects on.
ALTER TABLE public.influencers
  ADD COLUMN IF NOT EXISTS contact_scanned_at timestamptz,
  ADD COLUMN IF NOT EXISTS contact_scan_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.influencers.contact_scanned_at IS
  'When the contact-enrichment tick last examined this creator. NULL = never scanned. Ordering key for the tick: NULLs first, then oldest.';
COMMENT ON COLUMN public.influencers.contact_scan_attempts IS
  'How many times enrichment has looked and found nothing. Reset to 0 on a hit; the tick stops selecting a creator past CONTACT_SCAN_MAX_ATTEMPTS.';

-- The tick's selection predicate: real creators with no email, least-recently
-- scanned first. Partial so the index stays small as the pool grows — a creator
-- that already has an address is never a candidate.
CREATE INDEX IF NOT EXISTS influencers_contact_scan_idx
  ON public.influencers (contact_scanned_at NULLS FIRST)
  WHERE contact_email IS NULL AND synthetic = false;
