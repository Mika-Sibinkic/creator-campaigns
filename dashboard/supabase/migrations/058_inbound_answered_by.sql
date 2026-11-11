-- 058_inbound_answered_by.sql
--
-- Record which creator reply's negotiation turn answered an earlier one.
--
-- The code works with or without it. Apply with
--   CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/058_inbound_answered_by.sql
--
-- WHY
--   A creator who sends two emails before we answer used to get two counters
--   two minutes apart. The negotiation tick now
--   takes ONE turn per thread per tick: it negotiates the latest pending
--   inbound with the earlier unanswered ones as context, and marks the earlier
--   ones processed. This column says which inbound answered them, so the
--   thread history can show "answered together" instead of an earlier email
--   that looks handled with nothing sent in reply to it.
--
-- HOW THE CODE USES IT
--   markAnsweredBy (src/lib/negotiation-tick.ts) writes it alongside the
--   status. Before this is applied the write is refused (PGRST204) and the code
--   retries with the status alone, so the earlier row still leaves the pending
--   set. Pinned by tests/holding-note.test.ts (coalesce, pre-058).
--
-- Additive only. Nullable, ON DELETE SET NULL, no backfill.

alter table public.inbound_messages
  add column if not exists answered_by_inbound_id uuid
    references public.inbound_messages (id) on delete set null;

comment on column public.inbound_messages.answered_by_inbound_id is
  'The inbound whose negotiation turn also answered this one (one turn per thread per tick). NULL when this row was answered on its own.';
