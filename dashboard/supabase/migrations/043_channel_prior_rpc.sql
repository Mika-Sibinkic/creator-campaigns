-- 043_channel_prior_rpc.sql — atomic channel-prior increment + OBSERVED
-- counters. Additive only.
--
-- Apply with `CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/043_channel_prior_rpc.sql`
-- from dashboard/. The application code does NOT depend on it having run:
-- bumpPrior() (src/lib/channel-priors.ts) tries this RPC first and falls back
-- to the legacy read-modify-write when the function is absent, and the scoring
-- blend degrades to its pure heuristic when the observed_* columns are absent.
-- Pre-apply behavior is byte-identical to today.
--
-- ─── Why the RPC ─────────────────────────────────────────────────────────────
--
-- channel_conversion_priors (018/020) is the firm×channel sent/replies/deals
-- funnel counter feeding best-channel routing and (from this migration) the
-- scoring response-likelihood blend. Its only writer was a documented
-- read-modify-write race: two concurrent bumps of the same (firm, channel)
-- could lose a count, and a cold-row double-insert lost one too. That was an
-- accepted v1 gap because fixing it needed a migration; this is that
-- migration. INSERT … ON CONFLICT DO UPDATE with relative increments is
-- atomic under concurrency — no lost counts, no double-insert error path.
--
-- ─── Why the observed_* columns ──────────────────────────────────────────────
--
-- 020 seeds every channel with sent=100 and explicitly calls it a STARTING
-- GUESS, not measured data. That seed is correct and load-bearing for ROUTING:
-- priorScore ranks channels cold-start, and a guessed baseline that ~2 real
-- deals can overturn is exactly what it wants.
--
-- It is poison for LEARNING. A confidence ramp of min(1, sent/30) reads
-- sent=100 as full confidence, so the scoring blend would run at maximum
-- strength against three numbers nobody measured, from the very first
-- discovery run, on every firm. Marking the seeded rows is not enough either:
-- once one real send lands, sent=101 and the ramp is still saturated, so the
-- seed baseline would have to be stored and subtracted — which is a worse
-- version of just counting separately.
--
-- So: sent/replies/deals keep their seeded cold-start semantics and keep
-- feeding routing. observed_sent/observed_replies/observed_deals start at 0 on
-- every row, are incremented ONLY by real funnel events through this function,
-- and are the only counters the scoring blend is allowed to read. A firm with
-- no send history therefore has observed_sent = 0, confidence 0, and scores
-- identical to the pre-blend heuristic — which is what the code always claimed
-- and, before this migration, was true of the function but false of the
-- deployed system.
--
-- ─── Security ────────────────────────────────────────────────────────────────
--
-- SECURITY DEFINER, owner postgres, so it bypasses RLS on
-- channel_conversion_priors entirely — the EXECUTE grant is therefore the
-- WHOLE access-control surface, not a second line of defense.
--
-- REVOKE … FROM PUBLIC ALONE IS NOT ENOUGH ON SUPABASE. Supabase grants
-- EXECUTE on public functions to `anon` and `authenticated` as explicit
-- per-role grants, not through PUBLIC, so revoking PUBLIC strips only the
-- =X/postgres entry and leaves anon=X/postgres and authenticated=X/postgres in
-- place. Verified against the existing SECURITY DEFINER function from 010:
--   rl_check_and_increment -> =X/postgres postgres=X/postgres anon=X/postgres
--                             authenticated=X/postgres service_role=X/postgres
-- Anyone holding the publishable anon key — which ships in the frontend by
-- design — could then POST /rest/v1/rpc/bump_channel_prior and move any firm's
-- funnel counters unauthenticated. Those counters now drive routing AND
-- scoring. So anon and authenticated are revoked by name.
--
-- search_path pins pg_temp last: with `public` alone, Postgres still searches
-- an implicit pg_temp FIRST for relation names, so a caller-created temp table
-- named channel_conversion_priors would capture the write.

ALTER TABLE public.channel_conversion_priors
  ADD COLUMN IF NOT EXISTS observed_sent    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS observed_replies integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS observed_deals   integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.channel_conversion_priors.observed_sent IS
  'Real first-touch sends counted by bump_channel_prior. Starts at 0 and is NEVER seeded — the 020 cold-start guess lives in `sent`. This is the only send count the scoring blend may use as a confidence sample size.';
COMMENT ON COLUMN public.channel_conversion_priors.observed_replies IS
  'Real first replies counted by bump_channel_prior. Never seeded.';
COMMENT ON COLUMN public.channel_conversion_priors.observed_deals IS
  'Real closed deals counted by bump_channel_prior. Never seeded.';

CREATE OR REPLACE FUNCTION bump_channel_prior(
  p_firm_id uuid,
  p_channel text,
  p_event   text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_firm_id IS NULL THEN
    RETURN;
  END IF;
  IF p_event NOT IN ('sent', 'reply', 'deal') THEN
    RAISE EXCEPTION 'bump_channel_prior: unknown event %', p_event;
  END IF;
  IF p_channel NOT IN ('email', 'instagram_dm', 'tiktok_dm') THEN
    RAISE EXCEPTION 'bump_channel_prior: unknown channel %', p_channel;
  END IF;

  INSERT INTO channel_conversion_priors (
    firm_id, channel,
    sent, replies, deals,
    observed_sent, observed_replies, observed_deals,
    updated_at
  )
  VALUES (
    p_firm_id,
    p_channel,
    CASE WHEN p_event = 'sent'  THEN 1 ELSE 0 END,
    CASE WHEN p_event = 'reply' THEN 1 ELSE 0 END,
    CASE WHEN p_event = 'deal'  THEN 1 ELSE 0 END,
    CASE WHEN p_event = 'sent'  THEN 1 ELSE 0 END,
    CASE WHEN p_event = 'reply' THEN 1 ELSE 0 END,
    CASE WHEN p_event = 'deal'  THEN 1 ELSE 0 END,
    now()
  )
  ON CONFLICT (firm_id, channel) DO UPDATE SET
    sent             = channel_conversion_priors.sent             + CASE WHEN p_event = 'sent'  THEN 1 ELSE 0 END,
    replies          = channel_conversion_priors.replies          + CASE WHEN p_event = 'reply' THEN 1 ELSE 0 END,
    deals            = channel_conversion_priors.deals            + CASE WHEN p_event = 'deal'  THEN 1 ELSE 0 END,
    observed_sent    = channel_conversion_priors.observed_sent    + CASE WHEN p_event = 'sent'  THEN 1 ELSE 0 END,
    observed_replies = channel_conversion_priors.observed_replies + CASE WHEN p_event = 'reply' THEN 1 ELSE 0 END,
    observed_deals   = channel_conversion_priors.observed_deals   + CASE WHEN p_event = 'deal'  THEN 1 ELSE 0 END,
    updated_at       = now();
END;
$$;

-- anon and authenticated by NAME — see the security note above. PUBLIC is
-- revoked too, for the =X/postgres entry and for any non-Supabase deployment.
REVOKE ALL ON FUNCTION bump_channel_prior(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_channel_prior(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION bump_channel_prior(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION bump_channel_prior(uuid, text, text) TO service_role;
