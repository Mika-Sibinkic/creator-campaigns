-- 049_campaign_influencer_escalation.sql — per-lead multi-channel
-- escalation state. Additive only.
--
-- Apply with `CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/049_campaign_influencer_escalation.sql`
-- from dashboard/.
--
-- ─── Why ─────────────────────────────────────────────────────────────────────
--
-- Routing BY best channel chooses one channel per creator at discovery time
-- and stamps it on campaign_influencers.primary_channel. Nothing ever tried a
-- SECOND channel after silence, so "try a different mode if there is no
-- response within X" had no implementation.
--
-- Escalation needs exactly two facts per lead that the schema cannot currently
-- express, plus one counter:
--
--   channels_tried    which channels this lead has already been contacted on.
--                     primary_channel holds only the FIRST one and is
--                     overwritten by nothing, so it cannot accumulate. Without
--                     this column the escalator cannot tell "email failed, try
--                     IG" from "we already tried IG" and would re-send.
--
--   next_attempt_at   the earliest moment the next channel may be tried.
--                     Derivable from last_outreach_at + the firm's silence
--                     window, but only while the silence window never changes:
--                     persisting the decision means a firm editing its cadence
--                     does not retroactively release a batch of leads to
--                     escalate all at once.
--
--   escalation_count  how many times this lead has been escalated. The contact
--                     cap is enforced on message_count, so this is not a gate —
--                     it is the observability that tells us whether escalation
--                     is doing anything, per lead, without diffing arrays.
--
-- ─── Safety ──────────────────────────────────────────────────────────────────
--
-- Every statement is ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, so
-- re-applying is a no-op. Both defaults are non-volatile constants, so PG11+
-- backfills them without a table rewrite.
--
-- NOTE the empty-array default rather than NULL: src/lib/escalation.ts folds
-- primary_channel into the attempted set precisely so rows written BEFORE this
-- migration (channels_tried = '{}') still count their first touch and cannot
-- escalate onto the channel they were already contacted on. The application is
-- correct with or without this migration having run; applying it makes the
-- state durable instead of re-derived.

alter table public.campaign_influencers
  add column if not exists channels_tried text[] not null default '{}'::text[],
  add column if not exists next_attempt_at timestamptz,
  add column if not exists escalation_count integer not null default 0;

comment on column public.campaign_influencers.channels_tried is
  'Channels this lead has been contacted on, accumulated across escalations (email | instagram_dm | tiktok_dm; legacy ''dm'' appears on pre-issue-21 rows). The escalator never re-picks a channel listed here. src/lib/escalation.ts also folds primary_channel in, so rows predating migration 049 are safe.';

comment on column public.campaign_influencers.next_attempt_at is
  'Earliest moment the next channel may be tried for this lead. Written when an escalation is dispatched (now + the firm''s escalation silence window, firms.outreach_prefs.escalation_silence_hours, falling back to follow_up_cadence_days). NULL means "never escalated" — the decision then derives from last_outreach_at.';

comment on column public.campaign_influencers.escalation_count is
  'How many times this lead has been escalated to a new channel. Observability only — the per-lead contact ceiling is enforced by counting real outbound rows in outreach_messages (direction=''outbound'' and status in (''sent'',''queued'')) against firms.outreach_prefs.max_follow_ups. Deliberately NOT campaign_influencers.message_count, which is stamped at draft time, is inflated by inbound replies, and is 0 on every live lead.';

-- ─────────────────────────────────────────────────────────────────────────────
-- outreach_messages.status gains a fourth terminal value: 'window_closed'
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Migration 046's COMMENT still asserts the lifecycle is draft -> queued -> sent
-- and "must stay terminal at 'sent'". This adds one more terminal state:
-- a queued message the campaign window closed before it could legally send.
--
-- This does NOT break the six analytics/performance readers 046 was protecting.
-- Every one of them uses status='sent' as a DENOMINATOR, and a window-closed
-- message genuinely was never sent, so excluding it is correct rather than
-- lossy. The rule 046 was really protecting — never write a PROVIDER DELIVERY
-- EVENT into status; those belong in delivery_status — is unchanged.
--
-- Restated here rather than by editing 046, because rewriting an applied
-- migration's text would leave the repo and an already-migrated database
-- disagreeing about what ran.

comment on column public.outreach_messages.status is
  'SEND lifecycle: draft -> queued -> sent, plus the terminal non-send '
  '''window_closed'' (the campaign window ended before this message could be '
  'sent; src/lib/negotiation-tick.ts) and ''failed'' (provider rejected it). '
  'Terminal states never change again. Orthogonal to delivery_status, which is '
  'what the email PROVIDER reported after hand-off (migration 046) — never write '
  'a delivery event into status. Analytics readers use status=''sent'' as their '
  'denominator; window_closed is deliberately excluded from it because nothing '
  'was delivered. Plain text with no CHECK, matching 019. Vocabulary in '
  'src/lib/message-status.ts.';

-- The escalation scan is "contacted, silent, and due": outreach_status = 'sent'
-- with next_attempt_at in the past. Partial index so it stays small — the vast
-- majority of campaign_influencers rows are never in this state.
create index if not exists campaign_influencers_escalation_due_idx
  on public.campaign_influencers (next_attempt_at)
  where outreach_status = 'sent';
