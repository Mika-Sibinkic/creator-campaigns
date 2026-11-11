-- PayPal Payouts creator-settlement rail.
-- The label PAYS the creator by email; a fresh payout is PENDING/UNCLAIMED and
-- only becomes "paid" when the creator claims (PAYMENT.PAYOUTS-ITEM.SUCCEEDED).
-- All additive + nullable → reversible, safe on an existing database.

-- The creator's confirmed payout email (defaults to the address they corresponded
-- from; a typo guard so we never pay a wrong address). Falls back to
-- influencers.contact_email when null.
alter table public.creator_offers add column if not exists payout_email text;

-- PayPal per-item lifecycle, distinct from creator_offers.status so the deal
-- state machine isn't overloaded: null → 'pending' → 'unclaimed'|'paid'|'returned'|'failed'.
alter table public.creator_offers add column if not exists payout_status text;

-- Reconciliation handle for the payout batch (also used for status polling if a
-- webhook is missed).
alter table public.payment_authorizations add column if not exists paypal_batch_id text;

-- Webhook idempotency: dedupe PayPal event ids the same way processed_stripe_events
-- did for the (now removed) Stripe checkout webhook.
create table if not exists public.processed_paypal_events (
  event_id text primary key,
  received_at timestamptz not null default now()
);
alter table public.processed_paypal_events enable row level security;
comment on table public.processed_paypal_events is
  'PayPal webhook event-id dedupe. Service-role access only (RLS denies anon).';

comment on column public.creator_offers.payout_email is
  'Creator-confirmed PayPal payout address; falls back to influencers.contact_email when null.';
comment on column public.creator_offers.payout_status is
  'PayPal payout lifecycle: pending|unclaimed|paid|returned|failed. Null until a payout is dispatched.';
comment on column public.payment_authorizations.paypal_batch_id is
  'PayPal payout_batch_id for reconciliation / status polling.';
