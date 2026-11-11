-- 053_inbound_message_evidence.sql
--
-- Makes a creator's emailed acceptance PROVABLE instead of merely claimable.
--
-- WHY
--   Creator Campaigns treats an over-email confirmation as binding rather than
--   buying an e-signature vendor. A
--   vendor's actual product is EVIDENCE PACKAGING, so declining to buy one
--   means this table has to carry the evidence itself. Today it carries two
--   defects that make the record unusable in a dispute:
--
--   1. THE TERMS ARE DELETED. inbound_messages.body is the output of
--      stripQuotedReply() (src/lib/channels/email-inbound.ts), which cuts the
--      text at the first quote marker — `> ` lines and the Gmail/Apple
--      "On … wrote:" attribution among them. A creator who replies
--      "Yes, I agree to these terms" ABOVE the quoted contract therefore has
--      the quoted contract deleted from the stored row. What survives is an
--      acceptance with no trace of the thing accepted. The stripping is
--      correct for the CLASSIFIER — a quoted copy of our own offer reads as if
--      the creator wrote it — so the fix is to keep both, not to stop
--      stripping.
--
--   2. THE AUTHENTICATION VERDICT IS THROWN AWAY.
--      src/lib/channels/inbound-authentication.ts reads the receiver's RFC 8601
--      Authentication-Results header and checks DMARC/DKIM/SPF alignment
--      against the From domain. On the Gmail transport that verdict can
--      genuinely be trusted (Google's MX prepends its own copy and the Gmail
--      API preserves header order). The verdict was computed, console.warn'd,
--      and then dropped: NormalizedInbound had no field for it. The only
--      durable footprint of a FAILED authentication was
--      campaign_influencer_id IS NULL, which is indistinguishable from a reply
--      that simply carried no correlation tag.
--
--   An audit log is not a substitute for either. audit_log.metadata is
--   PII-scrubbed on write (src/lib/audit.ts), audit() swallows its own insert
--   failures by design, and the manual prune procedure deletes
--   `actor_label LIKE 'system:%'` rows older than 90 days — the default label for exactly the kind of
--   unattended write a creator's reply produces. Evidence goes on the ROW.
--
-- ADDITIVE ONLY. Every column is nullable, nothing is backfilled, no existing
-- column changes meaning, and no index is dropped. Old rows keep NULLs, which
-- truthfully say "this predates the evidence columns" rather than asserting
-- something about a message nobody captured.
ALTER TABLE public.inbound_messages
  -- ── 1. The message as it actually arrived ────────────────────────────────
  ADD COLUMN IF NOT EXISTS raw_body text,
  ADD COLUMN IF NOT EXISTS raw_body_media_type text,
  ADD COLUMN IF NOT EXISTS raw_body_sha256 text,
  ADD COLUMN IF NOT EXISTS raw_body_truncated boolean,
  ADD COLUMN IF NOT EXISTS raw_body_chars integer,
  -- ── 2. What the receiving infrastructure proved about the sender ─────────
  ADD COLUMN IF NOT EXISTS sender_authenticated boolean,
  ADD COLUMN IF NOT EXISTS sender_auth_outcome text,
  ADD COLUMN IF NOT EXISTS sender_auth_authserv_id text,
  ADD COLUMN IF NOT EXISTS sender_matched_lead boolean,
  -- ── 3. Which of our messages this answers ───────────────────────────────
  ADD COLUMN IF NOT EXISTS in_reply_to text,
  -- ── 4. When WE received it, as opposed to when the provider says we did ──
  ADD COLUMN IF NOT EXISTS received_at_server timestamptz;

-- received_at_server gets its default in a SEPARATE statement, AFTER the
-- column exists. That ordering is the whole point: `ADD COLUMN … DEFAULT now()`
-- would stamp every pre-existing row with the migration's own clock, i.e.
-- fabricate a receipt time for every message received before it ran —
-- the opposite of evidence. Added bare, existing rows stay NULL; the default
-- then applies only to rows inserted from here on.
--
-- The application must NOT send this column. `received_at` is provider-claimed
-- (src/lib/ingest-inbound.ts falls back to the app's own clock when the
-- provider omits it, silently), so it cannot answer "when did OUR
-- infrastructure see this?". Leaving the value to the database default makes
-- Postgres the only writer and the DB clock the only source.
ALTER TABLE public.inbound_messages
  ALTER COLUMN received_at_server SET DEFAULT now();

COMMENT ON COLUMN public.inbound_messages.raw_body IS
  'The provider body VERBATIM, before stripQuotedReply() cut it — so a "Yes, I agree" written above a quoted contract still has the quoted contract. Capped at MAX_VERBATIM_BODY_CHARS (256000) in email-inbound.ts. Untrusted creator text: evidence only. Nothing reads this column, and nothing may feed it to a model.';
COMMENT ON COLUMN public.inbound_messages.raw_body_media_type IS
  'Which MIME part raw_body is: text/plain, or text/html when the reply had no plain-text alternative (in which case raw_body is HTML SOURCE, not the lossy htmlToPlainText conversion). NULL when the transport could not say.';
COMMENT ON COLUMN public.inbound_messages.raw_body_sha256 IS
  'Lowercase hex sha256 of the raw_body value AS STORED. Verifiable against this row: recompute over raw_body and compare. When raw_body_truncated is true it is the hash of the stored prefix, not of the whole message — a hash you cannot recompute proves nothing.';
COMMENT ON COLUMN public.inbound_messages.raw_body_truncated IS
  'True when the verbatim cap cut raw_body. Recorded rather than silent: a truncated evidence copy that claims to be complete is worse than no copy.';
COMMENT ON COLUMN public.inbound_messages.raw_body_chars IS
  'Length in characters of the provider body BEFORE the cap. Equals length(raw_body) when raw_body_truncated is false; quantifies what was cut when it is true.';
COMMENT ON COLUMN public.inbound_messages.sender_authenticated IS
  'Did a trusted, aligned SPF/DKIM/DMARC verdict hold for the From domain — the exact boolean the attribution gate acted on, not a re-derivation. False and NULL are different: NULL means no verdict was recorded for this row at all.';
COMMENT ON COLUMN public.inbound_messages.sender_auth_outcome IS
  'AuthOutcome from src/lib/channels/inbound-authentication.ts: dmarc_pass | dkim_aligned | spf_aligned | explicit_fail | unaligned | no_verdict_header | untrusted_authserv | no_trusted_authserv_configured | unparseable | no_from_mailbox. Deliberately NOT a CHECK constraint: the enum is application-side and will grow, and a rejected insert on this path silently drops a creator reply — the failure this whole table exists to prevent.';
COMMENT ON COLUMN public.inbound_messages.sender_auth_authserv_id IS
  'The authserv-id that stamped the verdict (RFC 8601 s5), e.g. mx.google.com. Answers WHICH receiver said so; an outcome with no attributable receiver is not evidence.';
COMMENT ON COLUMN public.inbound_messages.sender_matched_lead IS
  'Did the From mailbox match the known creator contact of the lead the envelope correlated to. Distinct from sender_authenticated: "right address, unproven sender" and "wrong address" are different facts and used to collapse into the same NULL campaign_influencer_id.';
COMMENT ON COLUMN public.inbound_messages.in_reply_to IS
  'The RFC 5322 Message-ID this reply answers (In-Reply-To, else the last id in References). Joins to outreach_messages.provider_message_id for message-level attribution; today correlation resolves only to a LEAD. Sender-controlled: evidence, never authorization.';
COMMENT ON COLUMN public.inbound_messages.received_at_server IS
  'Database clock at insert — when our infrastructure recorded the message. Distinct from received_at, which is the provider''s claimed time with a silent app-clock fallback. NULL on rows predating this column. Never written by the application.';
