-- 009_onboarding_negotiation_payments.sql
--
-- Foundation for the firm-onboarding + agentic-negotiation + AI-blind
-- payments flow: negotiations with learning loops and real money, but in a
-- secure standalone account where the AI model can't see billing
-- information, and human review before any payment.
--
-- Sections:
--   1. Expand `firms` with label profile + onboarding fields
--   2. Expand `campaigns` with confirm-before-run + per-creator cap
--   3. New `creator_offers` table — negotiation state machine
--   4. New `payment_authorizations` table — AI-blind payment intent with
--      a structural CHECK that enforces "no execution without human
--      approval"
--   5. Expand `campaign_outcomes` with the RL feedback fields
--
-- All new tables get RLS + firm_id-scoped policies. The audit_log
-- immutability triggers from migration 008 are unaffected.

-- ─────────────────────────────────────────────────────────────────────
-- 1. firms — onboarding + label profile
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE firms
  ADD COLUMN IF NOT EXISTS label_type TEXT NOT NULL DEFAULT 'label'
    CHECK (label_type IN ('label', 'manager', 'artist', 'agency')),
  ADD COLUMN IF NOT EXISTS scraping_prefs JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS outreach_prefs JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS campaign_defaults JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

COMMENT ON COLUMN firms.label_type IS
  'Drives onboarding flow + UX. label = full record label, manager = solo artist manager, artist = self-serve, agency = PR/marketing firm.';
COMMENT ON COLUMN firms.scraping_prefs IS
  'JSON: {genres[], follower_range:{min,max}, engagement_min, regions[], content_style, language}. Read at every campaign create; per-campaign overrides land in campaigns.scraping_overrides.';
COMMENT ON COLUMN firms.outreach_prefs IS
  'JSON: {voice, tone, dos[], donts[], signoff, sender_email, sender_name, follow_up_cadence_days, max_follow_ups}. Supersedes the legacy voice_profile column once onboarding is complete.';
COMMENT ON COLUMN firms.campaign_defaults IS
  'JSON: {total_budget_usd, target_count, per_creator_cap_usd, urgency, default_message_type}. Pre-fills the campaign-create form.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. campaigns — confirm-before-run + per-creator cap
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS per_creator_cap_usd NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS total_budget_usd NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS scraping_overrides JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS outreach_overrides JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

COMMENT ON COLUMN campaigns.per_creator_cap_usd IS
  'Hard ceiling per individual creator. Negotiation state machine refuses to advance past this. Defaults from firms.campaign_defaults.per_creator_cap_usd.';
COMMENT ON COLUMN campaigns.total_budget_usd IS
  'Hard ceiling for the whole campaign. Sum of executed payment_authorizations.amount_usd cannot exceed this.';
COMMENT ON COLUMN campaigns.confirmed_at IS
  'Set when the user explicitly confirms scraping + outreach + caps before pipeline kickoff. Pipeline route refuses to run if NULL (pre-run gate).';

-- ─────────────────────────────────────────────────────────────────────
-- 3. creator_offers — negotiation state machine
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS creator_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_influencer_id UUID NOT NULL REFERENCES campaign_influencers(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,

  -- State machine. The transition graph is enforced in src/lib/negotiation.ts;
  -- this CHECK just keeps invalid persisted values out of the column.
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued',
    'offered',
    'counter_offered',
    'agreed',
    'human_approval_required',
    'approved',
    'rejected',
    'paid',
    'posted',
    'measured',
    'failed'
  )),

  -- Pricing fields
  initial_offer_usd NUMERIC(10,2),
  current_offer_usd NUMERIC(10,2),
  agreed_amount_usd NUMERIC(10,2),
  ceiling_usd NUMERIC(10,2) NOT NULL,

  -- Negotiation thread metadata
  rounds INT NOT NULL DEFAULT 0,
  last_message_id UUID REFERENCES outreach_messages(id),

  -- Outcome timestamps
  approved_at TIMESTAMPTZ,
  approved_by_user_id UUID,
  paid_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  post_url TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT positive_ceiling CHECK (ceiling_usd > 0),
  CONSTRAINT current_within_ceiling CHECK (current_offer_usd IS NULL OR current_offer_usd <= ceiling_usd),
  CONSTRAINT agreed_within_ceiling CHECK (agreed_amount_usd IS NULL OR agreed_amount_usd <= ceiling_usd)
);

CREATE INDEX IF NOT EXISTS idx_creator_offers_status        ON creator_offers(status);
CREATE INDEX IF NOT EXISTS idx_creator_offers_campaign      ON creator_offers(campaign_id);
CREATE INDEX IF NOT EXISTS idx_creator_offers_firm_status   ON creator_offers(firm_id, status);
CREATE INDEX IF NOT EXISTS idx_creator_offers_pending_approval
  ON creator_offers(firm_id) WHERE status = 'human_approval_required';

ALTER TABLE creator_offers ENABLE ROW LEVEL SECURITY;

CREATE POLICY creator_offers_select_own_firm ON creator_offers
  FOR SELECT TO authenticated
  USING (firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid()));

CREATE POLICY creator_offers_update_own_firm ON creator_offers
  FOR UPDATE TO authenticated
  USING (firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid()));

-- INSERT is service-role only (negotiation runner creates rows on behalf of
-- the system). DELETE is forbidden — use status='rejected' instead.

-- ─────────────────────────────────────────────────────────────────────
-- 4. payment_authorizations — AI-blind payment intent
-- ─────────────────────────────────────────────────────────────────────
--
-- Design intent: the AI agents that drive negotiation can write `pending_
-- human_review` rows here, but cannot transition to `executing` or
-- `completed` without a human-approval timestamp + user_id, enforced both
-- by route logic AND by the structural CHECK below.

CREATE TABLE IF NOT EXISTS payment_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_offer_id UUID NOT NULL UNIQUE REFERENCES creator_offers(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,

  amount_usd NUMERIC(10,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',

  status TEXT NOT NULL DEFAULT 'pending_human_review' CHECK (status IN (
    'pending_human_review',
    'approved',
    'rejected',
    'executing',
    'completed',
    'failed'
  )),

  human_approved_at TIMESTAMPTZ,
  human_approved_by_user_id UUID,

  -- Provider details — opaque to AI. The actual provider id (pi_xxx, tr_xxx)
  -- is stored AFTER execution. AI never sees Stripe secrets; the executor
  -- route is the only path with STRIPE_SECRET_KEY in scope.
  payment_provider TEXT NOT NULL DEFAULT 'stripe',
  payment_provider_id TEXT,
  failure_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at TIMESTAMPTZ,

  CONSTRAINT positive_amount CHECK (amount_usd > 0),
  -- Structural enforcement: payment cannot be approved/executed/completed
  -- without a human approval timestamp AND user. AI agents cannot bypass
  -- this even via service-role writes.
  CONSTRAINT human_approval_required_for_execute CHECK (
    (status IN ('pending_human_review', 'rejected') AND human_approved_at IS NULL)
    OR
    (status IN ('approved', 'executing', 'completed', 'failed')
       AND human_approved_at IS NOT NULL
       AND human_approved_by_user_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_payment_auth_status      ON payment_authorizations(status);
CREATE INDEX IF NOT EXISTS idx_payment_auth_firm_status ON payment_authorizations(firm_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_auth_pending     ON payment_authorizations(firm_id)
  WHERE status = 'pending_human_review';

ALTER TABLE payment_authorizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY payment_auth_select_own_firm ON payment_authorizations
  FOR SELECT TO authenticated
  USING (firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid()));

-- No INSERT/UPDATE/DELETE policies for authenticated users. All writes go
-- through service-role inside /api/payments/* routes which enforce
-- ownership + the human-approval flow in code.

-- ─────────────────────────────────────────────────────────────────────
-- 5. campaign_outcomes — RL feedback fields
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE campaign_outcomes
  ADD COLUMN IF NOT EXISTS creator_offer_id UUID REFERENCES creator_offers(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS streams_attributed BIGINT,
  ADD COLUMN IF NOT EXISTS streams_attribution_method TEXT
    CHECK (streams_attribution_method IS NULL OR streams_attribution_method IN
      ('manual', 'spotify_for_artists', 'estimated_from_views', 'unknown')),
  ADD COLUMN IF NOT EXISTS follower_count_at_post INT,
  ADD COLUMN IF NOT EXISTS engagement_at_post NUMERIC(6,4),
  ADD COLUMN IF NOT EXISTS payment_usd_amount NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS measured_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_campaign_outcomes_offer ON campaign_outcomes(creator_offer_id);

COMMENT ON COLUMN campaign_outcomes.streams_attributed IS
  'Streams attributed to this specific creator_offer post. Manual entry initially; Spotify-for-Artists API integration deferred.';
COMMENT ON COLUMN campaign_outcomes.payment_usd_amount IS
  'Snapshot of the actual payment_authorizations.amount_usd at measurement time, denormalized so RL queries don''t join across tables on every prediction.';

-- ─────────────────────────────────────────────────────────────────────
-- updated_at trigger for creator_offers (Postgres doesn't auto-touch this)
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION touch_creator_offers_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_creator_offers_touch ON creator_offers;
CREATE TRIGGER trg_creator_offers_touch
  BEFORE UPDATE ON creator_offers
  FOR EACH ROW EXECUTE FUNCTION touch_creator_offers_updated_at();
