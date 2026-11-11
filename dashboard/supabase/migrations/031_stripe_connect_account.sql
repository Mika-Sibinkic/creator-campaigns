-- Stripe Connect Express creator-settlement rail. The creator's connected-account
-- id (acct_*) is created on first payout and reused thereafter. Additive +
-- nullable → reversible, safe on an existing database.

alter table public.influencers add column if not exists stripe_connect_account_id text;

comment on column public.influencers.stripe_connect_account_id is
  'Stripe Connect Express account id (acct_*) for paying this creator; created on first payout, reused after.';

-- payout_status (added in 030) gains the Connect onboarding state; documented for clarity.
comment on column public.creator_offers.payout_status is
  'Payout lifecycle: awaiting_onboarding|pending|unclaimed|paid|returned|failed. Null until a payout is dispatched.';
