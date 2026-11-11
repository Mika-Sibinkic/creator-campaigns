-- Migration 023 — editable negotiation inbox address on firms + firm_members
--
-- Additive + idempotent. Mirrors the test_recipient_email pattern (migration
-- 013): a per-firm default plus an optional per-user override, so a tester
-- can point autonomous-negotiation intake at their OWN inbox instead of the
-- firm default.
--
-- This is the READ side of the loop — the Gmail address whose tagged
-- replies the negotiation tick polls — as opposed to test_recipient_email,
-- which is the WRITE/testing-mode To. Both null on an existing row, so the
-- resolution chain (member override ?? firm default ?? env GMAIL_USER ?? 'me')
-- degrades exactly as before until a value is set.
--
-- NOTE (inbox-wiring): the negotiation poll (src/lib/channels/gmail-inbound.ts,
-- pollGmailInbound) currently reads process.env.GMAIL_USER at a firm-agnostic
-- cron call site (/api/negotiation/tick uses supabaseAdmin() with no firm_id in
-- scope). This migration STORES the setting; wiring the poll to read it is a
-- per-firm-loop change deferred behind a // TODO(inbox-wiring) marker at that
-- env-read line.
--
-- Rollback: drop the two columns; nothing else references them yet.

ALTER TABLE public.firms
  ADD COLUMN IF NOT EXISTS negotiation_inbox_email text;

ALTER TABLE public.firm_members
  ADD COLUMN IF NOT EXISTS negotiation_inbox_email text;

COMMENT ON COLUMN public.firms.negotiation_inbox_email IS
  'Firm default for the Gmail inbox the negotiation tick reads replies from. NULL = fall back to env GMAIL_USER then ''me''.';

COMMENT ON COLUMN public.firm_members.negotiation_inbox_email IS
  'Per-user override for the negotiation read-inbox. Falls back to firms.negotiation_inbox_email then env GMAIL_USER.';
