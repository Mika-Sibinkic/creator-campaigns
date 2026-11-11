-- 057_holding_note_unique.sql
--
-- One negotiation tick per creator reply, and at most one holding note per
-- creator reply, both enforced by Postgres.
--
-- The code works with or without it (see BEFORE THIS IS APPLIED below).
-- Apply with
--   CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/057_holding_note_unique.sql
--
-- WHY
--   The holding note (src/lib/holding-note.ts) is
--   the "let me check, back to you in 15 minutes" email that goes out before an
--   automated counter or acceptance. planHeldReply reads the thread before it
--   inserts one: a queued note, or a sent note that has not been answered yet,
--   blocks a second one. That covers a tick re-running the same inbound. It
--   does NOT cover two ticks that OVERLAP. pg_net fires the */5 tick without
--   waiting, maxDuration is 300s, and both runs read an empty thread and then
--   both insert. The creator would get two "give me 15 minutes" notes, which
--   is the most obviously robotic thing this feature could do.
--
-- WHAT
--   1. outreach_messages.in_reply_to_inbound_id: the inbound_messages row this
--      outbound message answers. Nullable; ON DELETE SET NULL so pruning an
--      inbound never cascades into the outbound history. Today only holding
--      notes write it. Counters and acceptances could as well; that would be a
--      separate change.
--   2. A PARTIAL unique index over (in_reply_to_inbound_id) where
--      message_type = 'holding_note'. It is scoped to holding notes so that
--      nothing else that later links to an inbound is constrained by it. NULLs
--      never collide, so existing rows and every other writer are untouched.
--
-- HOW THE CODE USES IT
--   queueHoldingNote (src/lib/negotiation-tick.ts) inserts with the column set.
--   A 23505 from this index means "already queued" and is a silent no-op
--   (classifyHoldingInsertError, src/lib/holding-note.ts).
--
-- BEFORE THIS IS APPLIED
--   The insert names a column that does not exist, so PostgREST rejects it with
--   PGRST204. The code retries the same row without the column, which is
--   exactly what it did before this migration. Only the overlap race stays
--   open until then. Pinned by tests/holding-note.test.ts (pre-057 / post-057).
--
-- PART 2 (same file, same reason): inbound_messages.claimed_at
--   Overlapping ticks do not only double the NOTE. Both SELECT the same pending
--   inbound, both negotiate it, and both queue a COUNTER: two offers go to the
--   creator and the offer advances two rounds. claimInbound
--   (src/lib/inbound-claim.ts) now takes the row with a conditional UPDATE
--   before processing it:
--     SET claimed_at = now WHERE id = $1 AND status IN ('new','classified')
--       AND claimed_at IS NULL                       (then, failing that)
--       AND claimed_at < now - interval '10 minutes'  (a crashed tick's stale claim)
--   Only one tick gets the row back. A new column is needed because `status`
--   has a CHECK with no 'processing' value, and `received_at` /
--   `received_at_server` are arrival evidence that must not be overwritten.
--   Before this is applied the claim UPDATE is refused (PGRST204) and the tick
--   processes unguarded, exactly as it did before claims existed.
--
-- Additive only. No data backfill: every existing holding note predates this
-- migration and was already sent or dropped.

ALTER TABLE public.outreach_messages
  ADD COLUMN IF NOT EXISTS in_reply_to_inbound_id uuid
    REFERENCES public.inbound_messages (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.outreach_messages.in_reply_to_inbound_id IS
  'The inbound_messages row this outbound message answers. Written by holding notes (message_type=''holding_note''); a partial unique index (057) allows at most one holding note per inbound. NULL for everything else.';

CREATE UNIQUE INDEX IF NOT EXISTS outreach_messages_holding_note_inbound_uniq
  ON public.outreach_messages (in_reply_to_inbound_id)
  WHERE message_type = 'holding_note' AND in_reply_to_inbound_id IS NOT NULL;

ALTER TABLE public.inbound_messages
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

COMMENT ON COLUMN public.inbound_messages.claimed_at IS
  'When a negotiation tick claimed this reply for processing (src/lib/inbound-claim.ts). A claim older than 10 minutes is stale and may be taken over; a poison row''s claim is released so the next tick retries it. Meaningless once status leaves new/classified.';
