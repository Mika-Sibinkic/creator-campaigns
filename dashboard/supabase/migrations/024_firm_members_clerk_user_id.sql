-- Migration 024 — Clerk auth: key firm_members on a Clerk user id.
--
-- Additive + idempotent.
--
-- Authentication moved from Supabase magic-link to Clerk. firm_members is now keyed
-- on clerk_user_id (text, e.g. user_xxx) instead of the Supabase auth.users
-- UUID. user_id becomes nullable so a Clerk-provisioned member needs no
-- auth.users row; legacy rows keep their user_id and get clerk_user_id
-- backfilled on first Clerk sign-in (bootstrapMembershipByClerk).
--
-- Rollback: drop clerk_user_id + its index, re-add NOT NULL on user_id (only
-- safe once no Clerk-only rows exist).

ALTER TABLE public.firm_members
  ADD COLUMN IF NOT EXISTS clerk_user_id text;

ALTER TABLE public.firm_members
  ALTER COLUMN user_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS firm_members_clerk_user_id_key
  ON public.firm_members(clerk_user_id)
  WHERE clerk_user_id IS NOT NULL;

COMMENT ON COLUMN public.firm_members.clerk_user_id IS
  'Clerk user id (user_xxx). Primary auth key after the Clerk migration. NULL on legacy Supabase-auth rows until claimed on first Clerk sign-in.';
