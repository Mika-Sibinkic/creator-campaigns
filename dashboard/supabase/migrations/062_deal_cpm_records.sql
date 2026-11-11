-- 062_deal_cpm_records.sql
--
-- CPM data capture: the per-deal CPM dataset, and the creator's
-- first asking price.
--
-- The code works with or without it. Apply with
--   CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/062_deal_cpm_records.sql
--
-- WHY
--   Until real deals have been measured, every CPM
--   parameter (the sponsored-view factor k, a target CPM) is a guess. This
--   table is the data that turns them into estimates: per deal, what we paid,
--   what views we expected (from pricing_basis, 061), and what the post got at
--   7 days and since. Nothing reads it to decide anything in this slice.
--
-- deal_cpm_records — one row per measured deal (offer_id UNIQUE)
--   Written by src/lib/deal-cpm-records.ts from the measurement tick, right
--   after a performance snapshot lands:
--     - created at the first snapshot once the post is >= 7 days old. views_7d
--       / cpm_7d come only from a snapshot taken no later than day 8 after the
--       post (that one, or the latest earlier one); otherwise NULL, so a deal
--       first recorded weeks late (062 applied to deals already measured)
--       never stores today's views as its 7-day reading. Never rewritten.
--     - views_latest / cpm_latest refreshed on every later snapshot.
--     - cpm = agreed_usd / (views / 1000). No views (image post), zero views or
--       no agreed amount -> NULL. Never invented.
--     - pricing_method: 'formula' unless pricing_basis says a CPM price was
--       actually applied (no code path applies one yet).
--     - synthetic ([SAMPLE]) campaigns never produce a row.
--
-- creator_offers.first_ask_usd
--   The creator's FIRST asking price: the structured counter_usd the negotiator
--   validated against the creator's own words (stated-price.ts counterGate) at
--   their first counter. Written once, conditional on NULL; our own messages are
--   never text-parsed for it. NULL = they never named a number we could verify.
--
-- RLS — same posture as firm_influencer_blocks (056), cpm_snapshots (042):
--   members may SELECT their own firm's rows; writes are service-role only (no
--   policies). Post-Clerk auth.uid() is NULL and every app read goes through the
--   service-role client, so these policies are defense-in-depth, not the
--   boundary.
--
-- PRE-062 SAFETY
--   The writer probes the table first; PGRST205 / 42P01 -> skipped silently,
--   logged once per process. The first-ask write is its own conditional UPDATE;
--   PGRST204 -> skipped. Neither can refuse a write the app depends on.
--
-- Additive only. Re-runnable: every statement is IF NOT EXISTS / DROP IF EXISTS
-- guarded.
--
-- Rollback (pure data capture; nothing depends on it):
--   drop table if exists public.deal_cpm_records;
--   alter table public.creator_offers drop column if exists first_ask_usd;

CREATE TABLE IF NOT EXISTS public.deal_cpm_records (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id        uuid        NOT NULL REFERENCES public.creator_offers(id) ON DELETE CASCADE,
  firm_id         uuid        NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  campaign_id     uuid        REFERENCES public.campaigns(id) ON DELETE CASCADE,
  platform        text,
  channel         text,
  agreed_usd      numeric,
  expected_views  numeric,
  views_7d        numeric,
  views_latest    numeric,
  cpm_7d          numeric,
  cpm_latest      numeric,
  pricing_method  text        NOT NULL DEFAULT 'formula',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS deal_cpm_records_offer_id_key
  ON public.deal_cpm_records (offer_id);
CREATE INDEX IF NOT EXISTS deal_cpm_records_firm_idx
  ON public.deal_cpm_records (firm_id);
CREATE INDEX IF NOT EXISTS deal_cpm_records_campaign_idx
  ON public.deal_cpm_records (campaign_id);

ALTER TABLE public.deal_cpm_records
  DROP CONSTRAINT IF EXISTS deal_cpm_records_pricing_method_check;
ALTER TABLE public.deal_cpm_records
  ADD CONSTRAINT deal_cpm_records_pricing_method_check
  CHECK (pricing_method IN ('formula', 'cpm'));

COMMENT ON TABLE public.deal_cpm_records IS
  'One row per measured deal: agreed price, expected views (pricing_basis), and realised views/CPM at 7 days and latest. Written by the measurement tick (src/lib/deal-cpm-records.ts). CPM is NULL when views are unknown — never invented. Calibration data for CPM pricing; read by nothing that decides.';
COMMENT ON COLUMN public.deal_cpm_records.cpm_7d IS
  'agreed_usd / (views_7d / 1000) at the first snapshot >= 7 days after posting. NULL when views or the agreed amount are unknown or zero. Never rewritten.';
COMMENT ON COLUMN public.deal_cpm_records.pricing_method IS
  'formula = priced by the follower-tier formula (every deal until CPM slice S2). cpm = a CPM price was actually applied.';

ALTER TABLE public.deal_cpm_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_cpm_records_select_member ON public.deal_cpm_records;
CREATE POLICY deal_cpm_records_select_member ON public.deal_cpm_records
  FOR SELECT TO authenticated
  USING (
    firm_id IN (SELECT firm_id FROM public.firm_members WHERE user_id = auth.uid())
  );

ALTER TABLE public.creator_offers
  ADD COLUMN IF NOT EXISTS first_ask_usd numeric;

ALTER TABLE public.creator_offers
  DROP CONSTRAINT IF EXISTS creator_offers_first_ask_positive;
ALTER TABLE public.creator_offers
  ADD CONSTRAINT creator_offers_first_ask_positive
  CHECK (first_ask_usd IS NULL OR first_ask_usd > 0);

COMMENT ON COLUMN public.creator_offers.first_ask_usd IS
  'The creator''s first asking price: the negotiator-validated structured counter_usd at their first counter. Written once (conditional on NULL); never text-parsed from our own messages. NULL = no verifiable ask.';
