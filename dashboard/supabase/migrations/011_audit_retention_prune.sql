-- 011_audit_retention_prune.sql
--
-- Retention-prune attempt: revert. The session-local-GUC pattern for
-- surgically bypassing the 008 audit_log immutability triggers didn't work
-- reliably across the Postgres trigger context, so we walk it back to
-- preserve the absolute-immutability guarantee and move pruning to a
-- manual ops procedure.
--
-- Audit_log volume at the system heartbeat rate is small enough for Postgres to
-- handle trivially. Pruning is a "do this once a year by hand" task, not an
-- automated daily cron.
--
-- This migration restores the original 008 trigger function. If
-- migration 011 was applied earlier with the GUC bypass, this overwrites
-- it. If migration 011 was never applied (this is the first run), it's
-- still safe — restoring the function is a no-op vs the 008 baseline.
--
-- prune_audit_log() function is dropped to prevent accidental use; the
-- manual procedure uses an out-of-band ALTER TABLE … DISABLE TRIGGER on
-- a maintenance window with explicit human confirmation, then re-enables.

CREATE OR REPLACE FUNCTION audit_log_block_writes()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;

DROP FUNCTION IF EXISTS prune_audit_log(INT);
