-- Migration 019 — Negotiation send scheduling (human-cadence 2–8 min)
--
-- Additive + idempotent. Adds ONE nullable column to outreach_messages so the
-- auto-negotiator can PERSIST an outbound counter/reply and defer its actual
-- dispatch by a random 2–8 minutes ("human cadence, never instant"). The
-- /api/negotiation/tick poller dispatches rows whose send_after
-- has elapsed, then clears the column + stamps sent_at.
--
-- No new table, no CHECK change: outreach_messages.status is already free-text
-- (default 'draft'). Scheduled rows carry status='queued' and flip to 'sent'.
--
-- Rollback = drop the column + index below; nothing else references them.

ALTER TABLE public.outreach_messages
  ADD COLUMN IF NOT EXISTS send_after timestamptz;

COMMENT ON COLUMN public.outreach_messages.send_after IS
  'When set, this outbound message is SCHEDULED, not yet sent: the negotiation tick dispatches it once now() >= send_after (human-cadence 2–8 min delay), then clears the column and stamps sent_at. NULL = not a scheduled send.';

-- Partial index: the tick scans only rows still awaiting dispatch.
CREATE INDEX IF NOT EXISTS outreach_messages_send_after_idx
  ON public.outreach_messages (send_after)
  WHERE send_after IS NOT NULL;
