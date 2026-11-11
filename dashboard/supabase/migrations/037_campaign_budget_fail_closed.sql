-- 037_campaign_budget_fail_closed.sql — make "campaign with no enforceable
-- spend ceiling" unrepresentable. Additive and idempotent; no drops, no
-- rewrites of existing values, safe to re-run.
--
-- WHY
--
-- src/lib/spend-caps.ts used to read:
--
--     if (totalBudget > 0 && spent + current > totalBudget) { block }
--
-- so a NULL or 0 campaigns.total_budget_usd DISABLED the campaign spend cap
-- outright. The permissive state was also the DEFAULT state: the column is
-- nullable with no default, and POST /api/campaigns wrote only the legacy
-- `budget` / `per_influencer_cap` columns, which no money path reads. Result:
-- campaigns that displayed a budget in the UI while the payout ceiling they
-- were checked against did not exist.
--
-- The application now fails CLOSED on that state. This migration closes the
-- data half: backfill what the legacy columns already knew, then constrain the
-- shape so the NULL state cannot come back.
--
-- WHAT IT DOES TO EXISTING CAMPAIGNS: rows that already have both caps are
-- untouched. A NULL enforced cap is filled from a positive legacy value; where
-- the legacy column is NULL too there is no value to copy and none is
-- invented. A row still missing a cap after the backfill cannot be confirmed
-- until someone sets one.
--
-- BOTH CONSTRAINTS ARE ADDED **NOT VALID** ON PURPOSE. NOT VALID still
-- enforces on every future INSERT and UPDATE (which is the guarantee we want)
-- but skips the full-table verification, so the migration cannot fail on a
-- legacy row and cannot take a long ACCESS EXCLUSIVE lock. The DO block at the
-- end then tries to VALIDATE for real and, if any row is non-conforming,
-- raises a NOTICE naming it instead of aborting.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Backfill the enforced columns from the legacy display columns
-- ─────────────────────────────────────────────────────────────────────
-- Only fills NULLs, only from a positive legacy value. Idempotent: a second
-- run matches nothing. Never overwrites a value the confirm route already
-- wrote — where the two representations have drifted (e.g. per_influencer_cap
-- 500 vs per_creator_cap_usd 250), the ENFORCED column wins.

UPDATE public.campaigns
   SET total_budget_usd = budget
 WHERE total_budget_usd IS NULL
   AND budget IS NOT NULL
   AND budget > 0;

UPDATE public.campaigns
   SET per_creator_cap_usd = per_influencer_cap
 WHERE per_creator_cap_usd IS NULL
   AND per_influencer_cap IS NOT NULL
   AND per_influencer_cap > 0;

-- ─────────────────────────────────────────────────────────────────────
-- 2. A cap that exists must be a real ceiling
-- ─────────────────────────────────────────────────────────────────────
-- 0 and negative are not budgets. The app treats both as "unset" and refuses
-- to spend; this stops them being written in the first place.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.campaigns'::regclass
       AND conname  = 'campaigns_caps_positive'
  ) THEN
    ALTER TABLE public.campaigns
      ADD CONSTRAINT campaigns_caps_positive
      CHECK (
        (total_budget_usd    IS NULL OR total_budget_usd    > 0)
        AND
        (per_creator_cap_usd IS NULL OR per_creator_cap_usd > 0)
      ) NOT VALID;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- 3. A CONFIRMED campaign must have both enforced ceilings
-- ─────────────────────────────────────────────────────────────────────
-- confirmed_at is the arming switch: the pipeline route refuses to run without
-- it, and running is what leads to negotiation and payouts. Tying the caps to
-- confirmed_at (rather than NOT NULL on the columns) is what keeps this purely
-- additive — a half-filled draft stays legal, an armed campaign with no
-- ceiling does not.
--
-- This is the DB mirror of the 412 campaign_caps_required check in
-- src/app/api/campaigns/[id]/confirm/route.ts. The app catches it first with a
-- readable message; this makes it structural, the same way migration 009 made
-- the per-deal ceiling a CHECK rather than app logic.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.campaigns'::regclass
       AND conname  = 'campaigns_confirmed_requires_caps'
  ) THEN
    ALTER TABLE public.campaigns
      ADD CONSTRAINT campaigns_confirmed_requires_caps
      CHECK (
        confirmed_at IS NULL
        OR (
          total_budget_usd    IS NOT NULL AND total_budget_usd    > 0
          AND
          per_creator_cap_usd IS NOT NULL AND per_creator_cap_usd > 0
        )
      ) NOT VALID;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- 4. Try to validate against existing rows — report, never abort
-- ─────────────────────────────────────────────────────────────────────
-- Expected to succeed wherever every confirmed campaign already has both
-- caps. If a stale row blocks it, the constraint
-- stays NOT VALID — still enforced on all future writes — and the offending
-- ids are printed so they can be fixed deliberately rather than guessed at.

DO $$
DECLARE
  offenders text;
BEGIN
  BEGIN
    ALTER TABLE public.campaigns VALIDATE CONSTRAINT campaigns_caps_positive;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'campaigns_caps_positive left NOT VALID: existing rows have a 0/negative cap.';
  END;

  BEGIN
    ALTER TABLE public.campaigns VALIDATE CONSTRAINT campaigns_confirmed_requires_caps;
  EXCEPTION WHEN check_violation THEN
    SELECT string_agg(id::text, ', ') INTO offenders
      FROM public.campaigns
     WHERE confirmed_at IS NOT NULL
       AND (total_budget_usd IS NULL OR per_creator_cap_usd IS NULL);
    RAISE NOTICE 'campaigns_confirmed_requires_caps left NOT VALID. Confirmed campaigns missing a cap: %', offenders;
  END;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- 5. Document which columns are load-bearing
-- ─────────────────────────────────────────────────────────────────────

COMMENT ON COLUMN public.campaigns.total_budget_usd IS
  'ENFORCED. Hard ceiling for the whole campaign; src/lib/spend-caps.ts refuses every payout while this is NULL or <= 0 (fails CLOSED — it does not disable the cap). Written at campaign create and at confirm.';

COMMENT ON COLUMN public.campaigns.per_creator_cap_usd IS
  'ENFORCED. Hard ceiling per individual creator; the negotiation state machine refuses to advance past it. Written at campaign create and at confirm.';

COMMENT ON COLUMN public.campaigns.budget IS
  'DEPRECATED display mirror of total_budget_usd. Read-only surfaces still select it (api/dashboard, campaigns list, analytics fallback). NOTHING enforces against it and nothing new should — the money path reads total_budget_usd.';

COMMENT ON COLUMN public.campaigns.per_influencer_cap IS
  'DEPRECATED display mirror of per_creator_cap_usd. Not enforced anywhere; the negotiation ceiling reads per_creator_cap_usd.';
