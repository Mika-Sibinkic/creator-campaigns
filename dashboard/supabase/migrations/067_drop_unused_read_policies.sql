-- 067_drop_unused_read_policies.sql
--
-- Removes access paths nothing in the app uses.
--
-- Three SELECT policies let any holder of a Supabase `authenticated` JWT read
-- every creator row, every scraped contact address and every reply template.
-- The app never holds such a JWT: Clerk sessions use the service-role client
-- and filter by firm in code. RLS stays on, so with no policy the anon and
-- authenticated keys read nothing.
--
-- Migration 010's shared rate limiter was never called. Its table had no RLS
-- and its SECURITY DEFINER function was executable by anon and authenticated
-- (see the grant listing in 043).
--
-- Idempotent: safe on a fresh install and on a database that ran 007-018.

BEGIN;

DROP POLICY IF EXISTS influencers_select_real ON public.influencers;
DROP POLICY IF EXISTS reply_templates_select_all ON public.reply_templates;
DROP POLICY IF EXISTS creator_contacts_select_all ON public.creator_contacts;

DROP FUNCTION IF EXISTS public.rl_check_and_increment(text, int, int);
DROP TABLE IF EXISTS public.rate_limit_buckets;

COMMIT;
