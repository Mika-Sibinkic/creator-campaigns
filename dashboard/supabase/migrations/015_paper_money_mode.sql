-- Migration 015 — Paper money mode
--
-- Adds a `payment_mode` discriminator column on payment_authorizations so
-- audit/UI surfaces can distinguish rows that hit real Stripe (test or
-- live) from rows that were stamped via the paper-money path (no money
-- moved, no Stripe API call made).
--
-- Also creates `paper_money_ledger` — a thin record of paper-mode executes
-- so demos & internal tests can prove the flow ran end-to-end without
-- touching a Stripe account. RLS firm-scoped via a join through
-- payment_authorizations.
--
-- The dispatch logic lives in src/lib/stripe-isolated.ts:
--   PAYMENTS_MODE=paper        → stamp payment_mode='paper',
--                                 provider_id='paper_<idem>', insert
--                                 paper_money_ledger row.
--   PAYMENTS_MODE=stripe_test  → existing TEST customers.create path.
--   PAYMENTS_MODE=stripe_live  → existing LIVE Transfers path.
-- If STRIPE_SECRET_KEY is unset the code falls back to 'paper' regardless.

ALTER TABLE public.payment_authorizations
  ADD COLUMN IF NOT EXISTS payment_mode text NOT NULL DEFAULT 'paper';

COMMENT ON COLUMN public.payment_authorizations.payment_mode IS
  'Resolved at /api/payments/[id]/execute time from PAYMENTS_MODE env. '
  'One of: paper | stripe_test | stripe_live. Default paper so legacy '
  'rows back-fill safe.';

CREATE TABLE IF NOT EXISTS public.paper_money_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_authorization_id uuid NOT NULL REFERENCES public.payment_authorizations(id) ON DELETE CASCADE,
  amount_usd numeric NOT NULL,
  recipient_email text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paper_money_ledger_pa_idx
  ON public.paper_money_ledger (payment_authorization_id);
CREATE INDEX IF NOT EXISTS paper_money_ledger_occurred_idx
  ON public.paper_money_ledger (occurred_at DESC);

ALTER TABLE public.paper_money_ledger ENABLE ROW LEVEL SECURITY;

-- SELECT: firm members read paper ledger rows whose payment_authorization
-- belongs to a firm they have membership on. INSERT/UPDATE/DELETE: no
-- policies → implicit deny for non-service-role. Writes happen via
-- supabaseAdmin from /api/payments/[id]/execute.
DROP POLICY IF EXISTS paper_money_ledger_select ON public.paper_money_ledger;
CREATE POLICY paper_money_ledger_select ON public.paper_money_ledger
  FOR SELECT
  USING (
    payment_authorization_id IN (
      SELECT pa.id
      FROM public.payment_authorizations pa
      WHERE pa.firm_id IN (
        SELECT fm.firm_id
        FROM public.firm_members fm
        WHERE fm.user_id = auth.uid()
      )
    )
  );

COMMENT ON TABLE public.paper_money_ledger IS
  'Append-only record of paper-money executes (no real Stripe call). One '
  'row per executed payment_authorization when PAYMENTS_MODE=paper. '
  'idempotency_key is the payment_authorization.id, UNIQUE so retries do '
  'not double-write.';
