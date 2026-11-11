-- 061_cpm_pricing_shadow.sql
--
-- CPM pricing in shadow mode: the columns a CPM price needs, and the per-firm
-- switch that will one day let it decide.
--
-- The code works with or without it. Apply with
--   CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/061_cpm_pricing_shadow.sql
--
-- WHAT EACH COLUMN IS FOR
--   campaigns.target_cpm_usd   The CPM (USD per 1,000 expected sponsored views)
--                              the label wants to open at. NULL = not set; the
--                              shadow price then uses the CPM the follower-tier
--                              formula already implies across the campaign's
--                              scored pool, else a constant (src/lib/cpm-pricing.ts).
--   campaigns.max_cpm_usd      The CPM the label would walk away at. NULL = not
--                              set (target × 1.5, an unvalidated default).
--   creator_offers.pricing_basis
--                              The CPM price computed at offer creation, stored
--                              BESIDE the formula price that was actually used:
--                              { method, views, k, target, max, n, price,
--                                walkaway, formula_price, cap, target_source,
--                                target_n, k_source, applied:false, version }.
--                              Written by src/lib/cpm-shadow.ts. Read by NOTHING
--                              that decides or sends.
--   firms.pricing_mode         'formula' (default) | 'cpm'. In shadow mode nothing
--                              reads it: every firm prices by the formula whatever
--                              this says. A later change is what will
--                              make 'cpm' mean something, per firm, flippable
--                              back instantly with no deploy.
--
-- THE HARD RULE THIS MIGRATION SHIPS UNDER
--   With pricing_mode='formula', nothing a creator sees and nothing the
--   negotiator decides may change. tests/cpm-shadow-equivalence.test.ts runs
--   opener / counter / accept / fold / decline flows against a database with
--   and without these columns and asserts identical sent prices, offer amounts
--   and statuses, byte for byte, against a trace captured before this slice.
--
-- PRE-061 SAFETY
--   The shadow write is a separate UPDATE after the offer insert. Before this is
--   applied the campaign read is refused (PGRST204), the shadow step returns,
--   and one log line says so per process. The offer insert itself never names a
--   new column, so it cannot be refused.
--
-- Additive only. Nullable / defaulted, no backfill. Re-runnable.
--
-- Rollback (no data the app depends on lives here):
--   alter table public.creator_offers drop column if exists pricing_basis;
--   alter table public.campaigns drop column if exists target_cpm_usd;
--   alter table public.campaigns drop column if exists max_cpm_usd;
--   alter table public.firms drop column if exists pricing_mode;

alter table public.campaigns
  add column if not exists target_cpm_usd numeric,
  add column if not exists max_cpm_usd numeric;

alter table public.campaigns drop constraint if exists campaigns_target_cpm_positive;
alter table public.campaigns
  add constraint campaigns_target_cpm_positive
  check (target_cpm_usd is null or target_cpm_usd > 0);

alter table public.campaigns drop constraint if exists campaigns_max_cpm_positive;
alter table public.campaigns
  add constraint campaigns_max_cpm_positive
  check (max_cpm_usd is null or max_cpm_usd > 0);

alter table public.campaigns drop constraint if exists campaigns_target_cpm_le_max;
alter table public.campaigns
  add constraint campaigns_target_cpm_le_max
  check (target_cpm_usd is null or max_cpm_usd is null or target_cpm_usd <= max_cpm_usd);

alter table public.creator_offers
  add column if not exists pricing_basis jsonb;

alter table public.firms
  add column if not exists pricing_mode text not null default 'formula';

alter table public.firms drop constraint if exists firms_pricing_mode_check;
alter table public.firms
  add constraint firms_pricing_mode_check
  check (pricing_mode in ('formula', 'cpm'));

comment on column public.campaigns.target_cpm_usd is
  'Target CPM in USD per 1,000 expected sponsored views. NULL = unset (shadow pricing falls back to the formula-implied pool CPM, then a constant). Shadow-only until CPM slice S2.';
comment on column public.campaigns.max_cpm_usd is
  'Walk-away CPM in USD per 1,000 expected sponsored views. NULL = unset (target x 1.5, unvalidated). Shadow-only until CPM slice S2.';
comment on column public.creator_offers.pricing_basis is
  'CPM price computed at offer creation, stored beside the formula price actually used (src/lib/cpm-pricing.ts PricingBasis). applied=false: read by nothing that decides or sends.';
comment on column public.firms.pricing_mode is
  'formula (default) | cpm. Not read in CPM slice S1 — every firm prices by the formula. Slice S2 gives cpm its meaning; set back to formula to roll back instantly.';
