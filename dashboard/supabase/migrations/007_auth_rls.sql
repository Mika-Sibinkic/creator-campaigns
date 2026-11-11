-- 007_auth_rls.sql
-- Replace raw-password gate with Supabase Auth + RLS firm-scoping.
--
-- Adds firm_members (mapping auth.users → firms with a role), enables RLS on
-- all 10 user-facing tables, and writes per-table SELECT/INSERT/UPDATE/DELETE
-- policies scoped via the firm_members.user_id = auth.uid() pattern.
--
-- After this migration is applied, the service_role key STILL bypasses RLS
-- (by Postgres design — service_role is BYPASSRLS). System paths
-- (cron / webhooks / pipeline) keep using supabaseAdmin(). Every user-facing
-- read/write must go through an anon-key client carrying the user's JWT —
-- RLS then enforces firm scope automatically.
--
-- Seeding the first firm_member is intentionally NOT done in this migration:
-- the owner's auth.users.id only exists after their first magic-link sign-in.
-- After they sign in once, run the helper SQL block at the bottom of this file
-- (commented) from the Supabase SQL editor, OR hit the one-time bootstrap
-- API route POST /api/auth/bootstrap-membership.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. firm_members table
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS firm_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, user_id)
);

CREATE INDEX IF NOT EXISTS firm_members_user_idx ON firm_members(user_id);
CREATE INDEX IF NOT EXISTS firm_members_firm_idx ON firm_members(firm_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Enable RLS on every user-facing table.
--    Service-role (BYPASSRLS) keeps full access for cron/pipeline/webhooks.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE firms                ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_contexts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns            ENABLE ROW LEVEL SECURITY;
ALTER TABLE influencers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_influencers ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_messages    ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals                ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_outcomes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_ledger           ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_members         ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. firm_members policies
--    Members can see only their own membership rows. Inserts/updates/deletes
--    are service-role only (bootstrap + admin paths).
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS firm_members_select_self ON firm_members;
CREATE POLICY firm_members_select_self ON firm_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. firms policies — visible to members of the firm
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS firms_select_member ON firms;
CREATE POLICY firms_select_member ON firms
  FOR SELECT TO authenticated
  USING (
    id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS firms_update_member ON firms;
CREATE POLICY firms_update_member ON firms
  FOR UPDATE TO authenticated
  USING (
    id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
  )
  WITH CHECK (
    id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
  );

-- INSERT/DELETE on firms remain service-role only (no policy = no access for
-- authenticated). Multi-tenant signup will add an INSERT policy later.

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. firm_contexts policies — scoped by firm_id
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS firm_contexts_select_member ON firm_contexts;
CREATE POLICY firm_contexts_select_member ON firm_contexts
  FOR SELECT TO authenticated
  USING (
    firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS firm_contexts_insert_member ON firm_contexts;
CREATE POLICY firm_contexts_insert_member ON firm_contexts
  FOR INSERT TO authenticated
  WITH CHECK (
    firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS firm_contexts_update_member ON firm_contexts;
CREATE POLICY firm_contexts_update_member ON firm_contexts
  FOR UPDATE TO authenticated
  USING (
    firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
  )
  WITH CHECK (
    firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS firm_contexts_delete_member ON firm_contexts;
CREATE POLICY firm_contexts_delete_member ON firm_contexts
  FOR DELETE TO authenticated
  USING (
    firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. campaigns policies — scoped by firm_id
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS campaigns_select_member ON campaigns;
CREATE POLICY campaigns_select_member ON campaigns
  FOR SELECT TO authenticated
  USING (
    firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS campaigns_insert_member ON campaigns;
CREATE POLICY campaigns_insert_member ON campaigns
  FOR INSERT TO authenticated
  WITH CHECK (
    firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS campaigns_update_member ON campaigns;
CREATE POLICY campaigns_update_member ON campaigns
  FOR UPDATE TO authenticated
  USING (
    firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
  )
  WITH CHECK (
    firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS campaigns_delete_member ON campaigns;
CREATE POLICY campaigns_delete_member ON campaigns
  FOR DELETE TO authenticated
  USING (
    firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. influencers policies — creators are SHARED across firms
--    SELECT all real (synthetic=false) rows for any authenticated user;
--    INSERT/UPDATE/DELETE are pipeline-only (service role).
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS influencers_select_real ON influencers;
CREATE POLICY influencers_select_real ON influencers
  FOR SELECT TO authenticated
  USING (synthetic = false);

-- No INSERT/UPDATE/DELETE policies for authenticated — only service role.

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. campaign_influencers policies — scope via campaign_id → campaigns.firm_id
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS ci_select_member ON campaign_influencers;
CREATE POLICY ci_select_member ON campaign_influencers
  FOR SELECT TO authenticated
  USING (
    campaign_id IN (
      SELECT c.id FROM campaigns c
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS ci_insert_member ON campaign_influencers;
CREATE POLICY ci_insert_member ON campaign_influencers
  FOR INSERT TO authenticated
  WITH CHECK (
    campaign_id IN (
      SELECT c.id FROM campaigns c
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS ci_update_member ON campaign_influencers;
CREATE POLICY ci_update_member ON campaign_influencers
  FOR UPDATE TO authenticated
  USING (
    campaign_id IN (
      SELECT c.id FROM campaigns c
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  )
  WITH CHECK (
    campaign_id IN (
      SELECT c.id FROM campaigns c
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS ci_delete_member ON campaign_influencers;
CREATE POLICY ci_delete_member ON campaign_influencers
  FOR DELETE TO authenticated
  USING (
    campaign_id IN (
      SELECT c.id FROM campaigns c
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. outreach_messages policies — scope via campaign_influencer → campaign → firm
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS om_select_member ON outreach_messages;
CREATE POLICY om_select_member ON outreach_messages
  FOR SELECT TO authenticated
  USING (
    campaign_influencer_id IN (
      SELECT ci.id FROM campaign_influencers ci
      JOIN campaigns c ON c.id = ci.campaign_id
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS om_insert_member ON outreach_messages;
CREATE POLICY om_insert_member ON outreach_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    campaign_influencer_id IN (
      SELECT ci.id FROM campaign_influencers ci
      JOIN campaigns c ON c.id = ci.campaign_id
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS om_update_member ON outreach_messages;
CREATE POLICY om_update_member ON outreach_messages
  FOR UPDATE TO authenticated
  USING (
    campaign_influencer_id IN (
      SELECT ci.id FROM campaign_influencers ci
      JOIN campaigns c ON c.id = ci.campaign_id
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  )
  WITH CHECK (
    campaign_influencer_id IN (
      SELECT ci.id FROM campaign_influencers ci
      JOIN campaigns c ON c.id = ci.campaign_id
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS om_delete_member ON outreach_messages;
CREATE POLICY om_delete_member ON outreach_messages
  FOR DELETE TO authenticated
  USING (
    campaign_influencer_id IN (
      SELECT ci.id FROM campaign_influencers ci
      JOIN campaigns c ON c.id = ci.campaign_id
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. deals policies — scope via campaign_influencer
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS deals_select_member ON deals;
CREATE POLICY deals_select_member ON deals
  FOR SELECT TO authenticated
  USING (
    campaign_influencer_id IN (
      SELECT ci.id FROM campaign_influencers ci
      JOIN campaigns c ON c.id = ci.campaign_id
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS deals_insert_member ON deals;
CREATE POLICY deals_insert_member ON deals
  FOR INSERT TO authenticated
  WITH CHECK (
    campaign_influencer_id IN (
      SELECT ci.id FROM campaign_influencers ci
      JOIN campaigns c ON c.id = ci.campaign_id
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS deals_update_member ON deals;
CREATE POLICY deals_update_member ON deals
  FOR UPDATE TO authenticated
  USING (
    campaign_influencer_id IN (
      SELECT ci.id FROM campaign_influencers ci
      JOIN campaigns c ON c.id = ci.campaign_id
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  )
  WITH CHECK (
    campaign_influencer_id IN (
      SELECT ci.id FROM campaign_influencers ci
      JOIN campaigns c ON c.id = ci.campaign_id
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS deals_delete_member ON deals;
CREATE POLICY deals_delete_member ON deals
  FOR DELETE TO authenticated
  USING (
    campaign_influencer_id IN (
      SELECT ci.id FROM campaign_influencers ci
      JOIN campaigns c ON c.id = ci.campaign_id
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. campaign_outcomes policies — scope via campaign_id
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS co_select_member ON campaign_outcomes;
CREATE POLICY co_select_member ON campaign_outcomes
  FOR SELECT TO authenticated
  USING (
    campaign_id IN (
      SELECT c.id FROM campaigns c
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS co_insert_member ON campaign_outcomes;
CREATE POLICY co_insert_member ON campaign_outcomes
  FOR INSERT TO authenticated
  WITH CHECK (
    campaign_id IN (
      SELECT c.id FROM campaigns c
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS co_update_member ON campaign_outcomes;
CREATE POLICY co_update_member ON campaign_outcomes
  FOR UPDATE TO authenticated
  USING (
    campaign_id IN (
      SELECT c.id FROM campaigns c
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  )
  WITH CHECK (
    campaign_id IN (
      SELECT c.id FROM campaigns c
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS co_delete_member ON campaign_outcomes;
CREATE POLICY co_delete_member ON campaign_outcomes
  FOR DELETE TO authenticated
  USING (
    campaign_id IN (
      SELECT c.id FROM campaigns c
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. learning_logs / api_ledger — scope via campaign_id; allow rows with
--     campaign_id IS NULL to be visible to NO authenticated user (they're
--     system-only events visible to admins via the service-role key).
-- ─────────────────────────────────────────────────────────────────────────────
-- The base schema's learning_logs has no campaign_id (047 adds it with this
-- same definition); add it here so the policy below can be created.
ALTER TABLE learning_logs ADD COLUMN IF NOT EXISTS campaign_id uuid;
DROP POLICY IF EXISTS ll_select_member ON learning_logs;
CREATE POLICY ll_select_member ON learning_logs
  FOR SELECT TO authenticated
  USING (
    campaign_id IS NOT NULL
    AND campaign_id IN (
      SELECT c.id FROM campaigns c
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );
-- INSERT/UPDATE/DELETE on learning_logs are pipeline-only (service role).

DROP POLICY IF EXISTS al_select_member ON api_ledger;
CREATE POLICY al_select_member ON api_ledger
  FOR SELECT TO authenticated
  USING (
    campaign_id IS NOT NULL
    AND campaign_id IN (
      SELECT c.id FROM campaigns c
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );
-- INSERT/UPDATE/DELETE on api_ledger are pipeline-only (service role).

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- POST-MIGRATION SEED (run AFTER the owner's first magic-link sign-in)
-- ─────────────────────────────────────────────────────────────────────────────
-- After the owner signs in once and their auth.users row exists, run this manually
-- in the Supabase SQL editor — OR call POST /api/auth/bootstrap-membership
-- which does the same thing using the service role.
--
-- INSERT INTO firm_members (firm_id, user_id, role)
-- SELECT
--   (SELECT id FROM firms WHERE name = '<your firm name>' LIMIT 1),
--   (SELECT id FROM auth.users WHERE email = '<owner email>' LIMIT 1),
--   'owner'
-- ON CONFLICT (firm_id, user_id) DO NOTHING;
