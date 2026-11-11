-- 052_split_settlement.sql
--
-- Pay half on agreement, half on a verified post — and expire the rest
-- automatically so nobody has to chase anyone.
--
-- WHY
--   The state machine paid in full before the deliverable existed:
--   approved → paid → posted → measured. The contract's own Section 9 compounds
--   it — the creator accepts "by collecting the payment … or by publishing any
--   deliverable … whichever happens first" — so under that order the creator
--   became bound by taking the money, and nothing afterwards obliged them to
--   post. At micro-creator deal sizes nobody litigates, so the contract was
--   never the protection. The
--   payment order was, and it pointed the wrong way.
--
-- THE SHAPE, and the part that matters most
--   A 50/50 split halves the exposure. What makes it actually safe for the label
--   is that a miss RESOLVES ITSELF: every deal carries an outside date derived
--   from the package the creator agreed to, and when it passes with no verified
--   post the balance is simply never paid, the deal closes as `undelivered`, and
--   the creator is recorded so the roster stops recommending them. No dunning,
--   no email chain, no operator queue of people to hunt down. The deposit is the
--   whole loss and it is bounded by policy.
--
--   One honest limit: the payment authorization is currently minted for the FULL
--   agreed amount at agreement time, so wiring it to the deposit leg (and minting
--   a second one after a verified post) is remaining executor work. Until that
--   lands the split governs what is PAID, not yet what is reserved.
--
--   `deposit_pct` is per-firm and configurable precisely because "50" is a
--   convention, not a finding. A label that wants less exposure sets 25 without
--   a code change.
--
-- OFF BY DEFAULT. `require_delivery_before_balance` is false, so every existing
-- deal and every new one behaves exactly as it does today until a label opts in.
-- Additive only, no backfill.

ALTER TABLE public.firms
  ADD COLUMN IF NOT EXISTS require_delivery_before_balance boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deposit_pct integer NOT NULL DEFAULT 50;

-- Drop-then-add so the file is re-runnable; every other statement here is
-- IF NOT EXISTS and a bare ADD CONSTRAINT would fail the whole migration on a
-- second run, which is how a half-applied migration happens.
ALTER TABLE public.firms
  DROP CONSTRAINT IF EXISTS firms_deposit_pct_range;
ALTER TABLE public.firms
  ADD CONSTRAINT firms_deposit_pct_range
  CHECK (deposit_pct >= 0 AND deposit_pct <= 100);

COMMENT ON COLUMN public.firms.require_delivery_before_balance IS
  'When true, a deal pays deposit_pct on approval and the remainder only after a verified post, and expires itself as undelivered if the outside date passes. False = pay in full on approval (the pre-052 behaviour).';
COMMENT ON COLUMN public.firms.deposit_pct IS
  'Percentage of the agreed amount paid up front when require_delivery_before_balance is on. 50 is a convention, not a measured optimum — a label wanting less exposure lowers it.';

-- Per-deal settlement state. Amounts are recorded rather than derived so a
-- later change to deposit_pct can never restate what was actually paid.
ALTER TABLE public.creator_offers
  ADD COLUMN IF NOT EXISTS deposit_paid_usd numeric(10,2),
  ADD COLUMN IF NOT EXISTS balance_paid_usd numeric(10,2),
  ADD COLUMN IF NOT EXISTS deliver_by timestamptz,
  ADD COLUMN IF NOT EXISTS undelivered_at timestamptz;

COMMENT ON COLUMN public.creator_offers.deposit_paid_usd IS
  'What actually left on the deposit leg. Recorded, not derived from deposit_pct — the policy can change, the history cannot.';
COMMENT ON COLUMN public.creator_offers.balance_paid_usd IS
  'What actually left on the balance leg, after a verified post. NULL on an undelivered deal, and that is the saving.';
COMMENT ON COLUMN public.creator_offers.deliver_by IS
  'The outside date, stamped on the agreed transition from the frozen package''s largest delivery_window_days. Known to both sides from the moment the deal closes — the creator is told it, so expiry is never a surprise.';
COMMENT ON COLUMN public.creator_offers.undelivered_at IS
  'When the deal self-closed for non-delivery. Set by the sweeper, never by hand.';

-- The expiry sweeper's predicate: deposit out, nothing posted, date passed.
CREATE INDEX IF NOT EXISTS creator_offers_deliver_by_idx
  ON public.creator_offers (deliver_by)
  WHERE status = 'deposit_paid';

-- Three new statuses. `deposit_paid` and `balance_paid` sit either side of
-- `posted`; `undelivered` is terminal. The pre-052 `paid` path is untouched, so
-- both flows are legal and the flag decides which one a deal takes.
ALTER TABLE public.creator_offers
  DROP CONSTRAINT IF EXISTS creator_offers_status_check;
ALTER TABLE public.creator_offers
  ADD CONSTRAINT creator_offers_status_check CHECK (status IN (
    'queued',
    'offered',
    'counter_offered',
    'agreed',
    'human_approval_required',
    'approved',
    'rejected',
    'paid',
    'deposit_paid',
    'posted',
    'balance_paid',
    'measured',
    'undelivered',
    'failed'
  ));

-- Non-delivery recorded on the creator, firm-scoped, so the roster and the pool
-- gates can stop recommending someone who took a deposit and did not post. This
-- is the other half of "the label should not have to chase anyone" — the
-- consequence is that they are not offered the next deal, which costs the label
-- nothing to enforce.
CREATE TABLE IF NOT EXISTS public.creator_delivery_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  influencer_id uuid NOT NULL REFERENCES public.influencers(id) ON DELETE CASCADE,
  creator_offer_id uuid NOT NULL REFERENCES public.creator_offers(id) ON DELETE CASCADE,
  deposit_lost_usd numeric(10,2),
  deliver_by timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.creator_delivery_failures IS
  'One row per deal that took a deposit and never delivered, scoped to the firm that lost it. Firm-scoped on purpose: one label''s bad experience is not evidence for another, and a shared blocklist across tenants would be both unfair to the creator and a licensing problem.';

CREATE UNIQUE INDEX IF NOT EXISTS creator_delivery_failures_offer_uq
  ON public.creator_delivery_failures (creator_offer_id);
CREATE INDEX IF NOT EXISTS creator_delivery_failures_firm_inf_idx
  ON public.creator_delivery_failures (firm_id, influencer_id);

ALTER TABLE public.creator_delivery_failures ENABLE ROW LEVEL SECURITY;
