-- Measurement foundation: verify delivery, track performance over time,
-- attribute artist lift + optimize label-side CPM.
create table if not exists public.deal_deliveries (
  id uuid primary key default gen_random_uuid(),
  creator_offer_id uuid not null references public.creator_offers(id) on delete cascade,
  firm_id uuid not null references public.firms(id) on delete cascade,
  promo_type text check (promo_type in ('story','post','reel','dance_trend')),
  platform text,
  post_url text,
  status text not null default 'pending' check (status in ('pending','verified','missing')),
  detected_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists deal_deliveries_offer_idx on public.deal_deliveries(creator_offer_id);
alter table public.deal_deliveries enable row level security;

create table if not exists public.deal_performance_snapshots (
  id uuid primary key default gen_random_uuid(),
  deal_delivery_id uuid not null references public.deal_deliveries(id) on delete cascade,
  firm_id uuid not null references public.firms(id) on delete cascade,
  captured_at timestamptz not null default now(),
  views bigint, likes bigint, comments bigint, shares bigint,
  source text
);
create index if not exists deal_perf_delivery_idx on public.deal_performance_snapshots(deal_delivery_id);
create index if not exists deal_perf_captured_idx on public.deal_performance_snapshots(captured_at);
alter table public.deal_performance_snapshots enable row level security;
