-- 064_payments_mode_switch.sql
--
-- Operator-only Test/Live payments switch.
--
-- The code works with or without it. Apply with
--   CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/064_payments_mode_switch.sql
--
-- WHAT
--   platform_payment_settings — ONE row, the active Stripe mode for the whole
--     platform ('stripe_test' | 'stripe_live'). Env PAYMENTS_MODE stays the
--     ceiling: live is used only when the env also allows it
--     (src/lib/stripe-isolated.ts resolveActivePaymentMode). Written only by
--     POST /api/payments/mode (operator, typed confirmation, readiness
--     checklist, audited as payments.mode_switch).
--   payment_authorizations.approved_mode — the mode a human approved the
--     payment in. Every claim (execute, onboarding webhook) is conditioned on
--     approved_mode = the mode it is about to pay in, so a payment approved in
--     Test can never execute with the Live key. Refused claims are marked
--     failed with failure_reason 'mode_mismatch:<approved>:<current>'.
--   influencers.stripe_connect_account_mode — which Stripe mode the creator's
--     acct_ id belongs to. An account from the other mode is ignored and a
--     fresh one is created in the current mode.
--
-- BACKFILL
--   approved_mode: payment_mode when that is a Stripe mode, else 'stripe_test',
--   for every row a claim can still pick up (pending, approved, executing,
--   failed). 'stripe_test' is the conservative default: a backfilled row can
--   never execute with the Live key. Historical completed/rejected rows stay NULL.
--   stripe_connect_account_mode: 'stripe_test' wherever an account id is set.
--
-- RLS — same posture as processed_stripe_events (026) and tick_runs (044):
--   RLS enabled with no policies, so authenticated users can neither read nor
--   write it; the service role bypasses RLS. The operator read is enforced in
--   the route (requireOperator, src/lib/operator.ts); labels only ever see the
--   resolved mode through GET /api/payments/mode.
--
-- PRE-064 SAFETY
--   resolveActivePaymentMode reads the settings row; PGRST205 / 42P01 (table
--   missing) or no row -> exactly the pre-064 behaviour (env PAYMENTS_MODE and
--   a single STRIPE_SECRET_KEY), and no claim is mode-pinned. A delete trigger
--   keeps the row from disappearing once it exists.
--
-- Additive only. Re-runnable: every statement is IF NOT EXISTS / DROP IF EXISTS
-- / ON CONFLICT guarded.
--
-- Rollback (instant, no code change): UPDATE platform_payment_settings SET
-- stripe_mode = 'stripe_test'. Full rollback (only after reverting the code):
--   drop table if exists public.platform_payment_settings;
--   alter table public.payment_authorizations drop column if exists approved_mode;
--   alter table public.influencers drop column if exists stripe_connect_account_mode;

CREATE TABLE IF NOT EXISTS public.platform_payment_settings (
  id           boolean     PRIMARY KEY DEFAULT true,
  stripe_mode  text        NOT NULL DEFAULT 'stripe_test',
  switched_by  text,
  switched_at  timestamptz,
  CONSTRAINT platform_payment_settings_single_row CHECK (id),
  CONSTRAINT platform_payment_settings_mode_check CHECK (stripe_mode IN ('stripe_test', 'stripe_live'))
);

INSERT INTO public.platform_payment_settings (id, stripe_mode)
VALUES (true, 'stripe_test')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.platform_payment_settings IS
  'Single row: the active Stripe mode for the platform. Env PAYMENTS_MODE is the ceiling (live only when it allows live). Written only by POST /api/payments/mode (operator, typed confirmation, readiness checklist, audit payments.mode_switch).';
COMMENT ON COLUMN public.platform_payment_settings.switched_by IS
  'Email (or user id) of the operator who last switched the mode.';

CREATE OR REPLACE FUNCTION public.platform_payment_settings_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform_payment_settings is a single permanent row; set stripe_mode instead of deleting it';
END;
$$;

DROP TRIGGER IF EXISTS platform_payment_settings_no_delete ON public.platform_payment_settings;
CREATE TRIGGER platform_payment_settings_no_delete
  BEFORE DELETE ON public.platform_payment_settings
  FOR EACH ROW EXECUTE FUNCTION public.platform_payment_settings_no_delete();

ALTER TABLE public.platform_payment_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.payment_authorizations
  ADD COLUMN IF NOT EXISTS approved_mode text;

ALTER TABLE public.payment_authorizations
  DROP CONSTRAINT IF EXISTS payment_authorizations_approved_mode_check;
ALTER TABLE public.payment_authorizations
  ADD CONSTRAINT payment_authorizations_approved_mode_check
  CHECK (approved_mode IS NULL OR approved_mode IN ('paper', 'stripe_test', 'stripe_live', 'paypal_sandbox', 'paypal_live'));

COMMENT ON COLUMN public.payment_authorizations.approved_mode IS
  'Payment mode in force when a human approved this row. Claims are conditioned on approved_mode = the mode being paid in; a mismatch is refused (failure_reason mode_mismatch:<approved>:<current>) and needs a fresh approval.';

UPDATE public.payment_authorizations
   SET approved_mode = CASE
         WHEN payment_mode IN ('stripe_test', 'stripe_live') THEN payment_mode
         ELSE 'stripe_test'
       END
 WHERE approved_mode IS NULL
   AND status IN ('pending_human_review', 'approved', 'executing', 'failed');

ALTER TABLE public.influencers
  ADD COLUMN IF NOT EXISTS stripe_connect_account_mode text;

ALTER TABLE public.influencers
  DROP CONSTRAINT IF EXISTS influencers_stripe_connect_account_mode_check;
ALTER TABLE public.influencers
  ADD CONSTRAINT influencers_stripe_connect_account_mode_check
  CHECK (stripe_connect_account_mode IS NULL OR stripe_connect_account_mode IN ('stripe_test', 'stripe_live'));

COMMENT ON COLUMN public.influencers.stripe_connect_account_mode IS
  'Stripe mode the stripe_connect_account_id belongs to. An account from the other mode is never used; a fresh one is created in the current mode.';

UPDATE public.influencers
   SET stripe_connect_account_mode = 'stripe_test'
 WHERE stripe_connect_account_id IS NOT NULL
   AND stripe_connect_account_mode IS NULL;
