-- 046_outreach_delivery_status.sql — give Resend delivery events their own column.
--
-- WHY THIS EXISTS (of the delivery-webhook fix):
--
-- The Resend delivery webhook was fixed to actually correlate
-- (it had been comparing Resend's `email_id` against our internal
-- outreach_messages.id — two different id spaces, so it had NEVER matched).
-- The moment it started matching, it began writing 'delivered' / 'opened' /
-- 'clicked' / 'bounced' / 'complained' into outreach_messages.status.
--
-- That column is free-text (019: no CHECK), so those writes would have landed
-- silently. But because the webhook never worked, `status` has been DE FACTO
-- FROZEN at 'sent' for the life of the product, and six readers were written
-- against that assumption:
--
--   src/lib/analytics.ts            computeConversion() denominator
--   src/lib/statuses.ts             campaign header "contacted" + respondedCis
--   src/lib/creator-performance.ts  reply-latency firstSent
--   src/lib/creator-performance.ts  cross-campaign close_rate denominator
--   src/app/api/analytics/correlations/route.ts   .eq('status','sent')
--   src/lib/correlation.ts          the same reduced first-send set
--
-- The failure is not cosmetic and it is not random. analytics.ts counts
-- `creators_sent` as status='sent' but `creators_replied` as ANY inbound
-- regardless of outbound status. So an engaged creator leaves the denominator
-- the instant an `email.opened` lands, while staying in the numerator:
-- response_conversion_rate climbs past 1.0, and at full delivery-event
-- coverage `creators_sent` reaches 0 and the rate returns null — the UI would
-- report "nothing has been sent" while replies were arriving. The bias is
-- systematic rather than noisy: the creators most likely to reply are exactly
-- the ones an `email.opened` removes first. The same mechanism silently
-- deflates the CPM-first inputs in creator-performance.ts.
--
-- THE FIX: delivery state is a SECOND, ORTHOGONAL axis, not a later value of
-- the same one. "We sent it" and "the mailbox accepted it, then they opened
-- it" are different facts with different lifetimes, and overloading one text
-- column to carry both is what made a lifecycle event look like a lifecycle
-- REGRESSION. `status` stays the send-lifecycle column
-- (draft → queued → sent), untouched and still terminal at 'sent'. Everything
-- Resend tells us after the hand-off lands here.
--
-- Additive only. No existing column, row, or index is touched, and no reader
-- changes behavior: every one of the six above keys on `status`, which now
-- never leaves 'sent' again.
--
-- DEGRADES SAFELY WHILE UNAPPLIED: the webhook's UPDATE targets
-- delivery_status, so pre-apply every delivery event fails its write, is
-- counted as an error, and returns a retryable 5xx to Svix — it does not
-- corrupt `status`, which is the property that actually matters. The
-- /api/anomalies bounced lane queries delivery_status and degrades to an
-- empty lane on error (it already does this for the same reason).

ALTER TABLE public.outreach_messages
  ADD COLUMN IF NOT EXISTS delivery_status text,
  ADD COLUMN IF NOT EXISTS delivery_status_at timestamptz;

COMMENT ON COLUMN public.outreach_messages.delivery_status IS
  'What the EMAIL PROVIDER told us happened after we handed the message off: '
  'delivered | opened | clicked | bounced | complained. Written only by '
  'src/app/api/webhooks/resend/route.ts, keyed on provider_message_id. '
  'Orthogonal to outreach_messages.status, which is the SEND lifecycle '
  '(draft → queued → sent) and must stay terminal at ''sent'' — six analytics '
  'and performance readers use status=''sent'' as their denominator. Never '
  'write a delivery event into status. Plain text with no CHECK, matching '
  'status (019) and api_ledger.source: a new provider event should not need a '
  'migration.';
COMMENT ON COLUMN public.outreach_messages.delivery_status_at IS
  'When the delivery_status now on the row was observed. Resend events can '
  'arrive out of order (Svix retries, races); this is the time of the event '
  'that WON the rank guard, not simply the last one received.';

-- The bounced/complained lane in /api/anomalies scans for terminal-bad
-- delivery states. Partial index: the overwhelming majority of rows are NULL
-- (never sent, or sent with no event yet) and are not worth indexing.
CREATE INDEX IF NOT EXISTS outreach_messages_delivery_status_idx
  ON public.outreach_messages (delivery_status)
  WHERE delivery_status IS NOT NULL;
