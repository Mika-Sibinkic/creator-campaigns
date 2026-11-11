-- Migration 025 — promo deliverables model.
--
-- A deal is no longer just a dollar amount: it carries concrete promo
-- deliverables (story / post / reel / dance_trend) × a quantity over a delivery
-- window. Line-items attach to EITHER a campaign (the default template the
-- negotiator opens from) OR a specific creator_offer (the per-deal package the
-- creator counters on). agreed_deliverables freezes the final package on the
-- offer at agreement time (audit-replayable contract).
--
-- RLS: enabled, no permissive policy → anon/authenticated denied; the app reads
-- and writes via the service-role client (Clerk auth + app-level firm_id
-- scoping is the authorization boundary post-Clerk migration).
--
-- Rollback: drop promo_deliverables; drop creator_offers.agreed_deliverables.

create table if not exists public.promo_deliverables (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete cascade,
  creator_offer_id uuid references public.creator_offers(id) on delete cascade,
  promo_type text not null check (promo_type in ('story','post','reel','dance_trend')),
  quantity int not null check (quantity > 0),
  delivery_window_days int not null check (delivery_window_days > 0),
  unit_price_usd numeric(10,2),
  created_at timestamptz not null default now(),
  -- exactly one parent
  constraint promo_deliverables_one_parent check (
    (campaign_id is not null and creator_offer_id is null) or
    (campaign_id is null and creator_offer_id is not null)
  )
);

-- one line per promo_type per parent
create unique index if not exists promo_deliverables_campaign_type_key
  on public.promo_deliverables(campaign_id, promo_type) where campaign_id is not null;
create unique index if not exists promo_deliverables_offer_type_key
  on public.promo_deliverables(creator_offer_id, promo_type) where creator_offer_id is not null;
create index if not exists promo_deliverables_firm_idx on public.promo_deliverables(firm_id);

alter table public.creator_offers
  add column if not exists agreed_deliverables jsonb;

alter table public.promo_deliverables enable row level security;

comment on table public.promo_deliverables is
  'Promo deliverable line-items for a deal: promo_type x quantity over delivery_window_days. Parent is a campaign (template) OR a creator_offer (per-deal). Service-role access only (RLS denies anon).';
comment on column public.creator_offers.agreed_deliverables is
  'Immutable snapshot of the agreed promo package (jsonb array of {promo_type, quantity, delivery_window_days, unit_price_usd}) frozen on the agreed transition. The audit-replayable contract of what the creator agreed to.';
