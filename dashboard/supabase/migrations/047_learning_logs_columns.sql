-- 047_learning_logs_columns.sql — the learning_logs shape the code actually
-- writes. Additive only.
--
-- Apply with `CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/047_learning_logs_columns.sql`
-- from dashboard/.
--
-- ─── Why ─────────────────────────────────────────────────────────────────────
--
-- src/lib/learning-log.ts inserts event_type, input_data,
-- predicted_value, actual_value, campaign_id and influencer_id, and cites
-- migration 007 plus the base schema (003) as its source of truth. NEITHER
-- creates those columns:
--
--   * 007 only ENABLEs RLS on learning_logs and adds the member-select policy.
--   * 003_base_schema.sql still carries the original five-column
--     free-form shape (id, category, signal, context, created_at).
--
-- A table altered by hand to carry the columns works. Any environment rebuilt
-- from repo SQL without this migration is broken: every insert fails, learning-log.ts
-- catches the error and console.error's it by design (a learning write must
-- never take down a send), and the ENTIRE learning spine silently no-ops with
-- nothing surfacing. A prediction→actual ledger that quietly records nothing is
-- worse than not having one, because the absence looks like "no events yet".
--
-- Every statement is ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, so
-- applying this to a database that already has the columns is a no-op, and applying it
-- to a fresh database makes the repo self-sufficient.
--
-- Numeric columns are JSONB, not numeric: the writers store labelled objects
-- ({ agreed_amount_usd: 150 }, { streams_per_dollar: 12.4, label_cpm: 8.1 })
-- rather than bare scalars, because a prediction is rarely one number and a
-- column per metric would need a migration per metric.

ALTER TABLE public.learning_logs
  ADD COLUMN IF NOT EXISTS event_type      text,
  ADD COLUMN IF NOT EXISTS input_data      jsonb,
  ADD COLUMN IF NOT EXISTS predicted_value jsonb,
  ADD COLUMN IF NOT EXISTS actual_value    jsonb,
  ADD COLUMN IF NOT EXISTS campaign_id     uuid,
  ADD COLUMN IF NOT EXISTS influencer_id   uuid;

COMMENT ON COLUMN public.learning_logs.event_type IS
  'LEARNING_EVENTS member (src/lib/learning-log.ts). Paired: <x> is the prediction, <x>_outcome the actual, joined on the id carried in input_data.';
COMMENT ON COLUMN public.learning_logs.input_data IS
  'The STATE the decision was made from, plus the join key (creator_offer_id / campaign_influencer_id). Append-only: outcomes are new rows, never updates.';
COMMENT ON COLUMN public.learning_logs.predicted_value IS
  'What the model expected, as a labelled object. NULL is meaningful — it means no prediction existed (e.g. a human-set quick offer), and is never back-filled with a reconstruction.';
COMMENT ON COLUMN public.learning_logs.actual_value IS
  'What actually happened, same shape as predicted_value.';

-- Reading is always "this event type, newest first", and the 007 RLS policy
-- scopes by campaign_id.
CREATE INDEX IF NOT EXISTS idx_learning_logs_event_created
  ON public.learning_logs (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_learning_logs_campaign
  ON public.learning_logs (campaign_id);
