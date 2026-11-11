-- 008_audit_log.sql
-- Append-only `audit_log` table for security/compliance forensics.
--
-- Stores every privileged action across the system: user-initiated mutations
-- (campaign.create / outreach.send / firm.testing_mode.toggle / etc.) and
-- system-path events (system.cron.smoke / pipeline.run.start / pipeline.run.complete /
-- webhook.resend.bounce). Inserts go through the service-role helper
-- `src/lib/audit.ts` which never throws — audit failure must NEVER block the
-- user action.
--
-- Immutability:
--   1. RLS allows SELECT for firm members only (or null firm_id system events
--      which are visible to everyone authenticated). No INSERT / UPDATE /
--      DELETE policies are written, which means RLS denies them for everyone
--      except service_role (BYPASSRLS).
--   2. Defense-in-depth: BEFORE UPDATE / BEFORE DELETE triggers raise
--      "audit_log is append-only" — this protects against an accidental
--      service_role mutation as well as future RLS policy mistakes.
--
--   The only non-trigger path to remove rows is TRUNCATE, which BYPASSES
--   row-level triggers (postgres design). Operationally, TRUNCATE is gated
--   behind direct DB access (Supabase dashboard / pooler) and is reserved for
--   admins doing a full retention purge. Application code never TRUNCATEs.

BEGIN;

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,                    -- auth.users.id, null for system
  actor_label text NOT NULL,             -- 'user:<email>' / 'system:cron' / 'system:pipeline' / 'webhook:resend'
  firm_id uuid,                          -- nullable for cross-firm system events
  action text NOT NULL,                  -- 'campaign.create' / 'outreach.send' / 'firm.testing_mode.toggle' / etc
  target_type text,                      -- 'campaign' / 'outreach_message' / 'firm' / etc
  target_id uuid,                        -- the row touched
  metadata jsonb,                        -- additional context (before/after for updates, etc)
  request_ip text,
  user_agent text
);

CREATE INDEX IF NOT EXISTS audit_log_occurred_at_idx ON audit_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_firm_id_idx ON audit_log(firm_id);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log(action);
CREATE INDEX IF NOT EXISTS audit_log_target_idx ON audit_log(target_type, target_id);

-- Row-level security: members read their firm's events, plus null-firm system events.
-- No INSERT / UPDATE / DELETE policies are defined, so non-service-role roles
-- get an implicit deny.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_select ON audit_log;
CREATE POLICY audit_log_select ON audit_log
  FOR SELECT USING (
    firm_id IS NULL
    OR firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
  );

-- Defense-in-depth immutability triggers. Even service_role (BYPASSRLS) will
-- be rejected by these triggers, since triggers fire regardless of role.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

COMMIT;
