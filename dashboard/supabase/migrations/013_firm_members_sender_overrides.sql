-- Migration 013 — per-user sender and test-recipient overrides
--
-- Per-user testing/sender overrides on firm_members. Each member can supply
-- their own sender_email / sender_name / test_recipient_email so testers
-- route outreach to their own inbox in testing mode without competing with
-- other firm members. All three fall back to the firm-level defaults on the
-- firms table when null.
--
-- Resolution order owned by src/lib/resend.ts:
--   from sender_email:  firm_members.sender_email
--                       ?? firms.sender_email
--                       ?? env RESEND_FROM_EMAIL
--                       ?? 'onboarding@resend.dev'
--   from sender_name:   firm_members.sender_name
--                       ?? firms.sender_name
--                       ?? 'Creator Campaigns'
--   to (testing_mode):  firm_members.test_recipient_email
--                       ?? firms.test_recipient_email
--                       ?? session.user.email
--                       ?? env TEST_RECIPIENT_EMAIL
--                       (fail with no_test_recipient if all null)

ALTER TABLE public.firm_members
  ADD COLUMN IF NOT EXISTS sender_email text,
  ADD COLUMN IF NOT EXISTS sender_name text,
  ADD COLUMN IF NOT EXISTS test_recipient_email text;

COMMENT ON COLUMN public.firm_members.sender_email IS
  'Per-user override for outreach From. Falls back to firms.sender_email.';
COMMENT ON COLUMN public.firm_members.test_recipient_email IS
  'Per-user override for testing-mode To. Falls back to firms.test_recipient_email then session.user.email.';
