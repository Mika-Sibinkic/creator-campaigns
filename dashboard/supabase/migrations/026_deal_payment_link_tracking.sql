-- Payment-link tracking on the deal + Stripe event dedupe. Without it the
-- Stripe webhook 503s and paid deals never deliver.
alter table public.creator_offers add column if not exists checkout_session_id text;
alter table public.creator_offers add column if not exists payment_link_url text;
alter table public.creator_offers add column if not exists paid_at timestamptz;
create unique index if not exists creator_offers_checkout_session_key
  on public.creator_offers(checkout_session_id) where checkout_session_id is not null;
create table if not exists public.processed_stripe_events (
  event_id text primary key,
  received_at timestamptz not null default now()
);
alter table public.processed_stripe_events enable row level security;
