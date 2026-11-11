-- Social (Instagram/TikTok) DM outreach via computer-use on credible established
-- accounts. Channel routing
-- + priors already exist (018); this adds the sending-account registry, a send
-- audit/rate ledger, and the per-message routing columns. All additive → safe.

-- Credible sending accounts the computer-use worker (or a human) sends from.
create table if not exists public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  platform text not null,                         -- 'instagram' | 'tiktok'
  handle text not null,
  display_name text,
  credibility_note text,                          -- why this account is credible (followers, history, verified)
  status text not null default 'warming',         -- warming | active | cooling | blocked
  daily_cap int not null default 10,              -- human-paced ceiling, ramped up over time
  sends_today int not null default 0,
  sends_today_date date,                          -- the day sends_today counts (reset when != today)
  last_send_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists social_accounts_firm_idx on public.social_accounts(firm_id);
create unique index if not exists social_accounts_firm_platform_handle_uq
  on public.social_accounts(firm_id, platform, handle);
alter table public.social_accounts enable row level security;
comment on table public.social_accounts is
  'Credible established accounts used to send social DMs (computer-use/human). Service-role only (RLS denies anon).';

-- Append-only ledger of every social send attempt — audit + rate governance +
-- channel-conversion signal (feeds CPM: which account/channel converts).
create table if not exists public.social_send_events (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  social_account_id uuid references public.social_accounts(id) on delete set null,
  outreach_message_id uuid references public.outreach_messages(id) on delete set null,
  campaign_influencer_id uuid references public.campaign_influencers(id) on delete set null,
  channel text not null,                          -- instagram_dm | tiktok_dm
  status text not null,                           -- sent | failed | needs_human | challenged | skipped_cap
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists social_send_events_firm_idx on public.social_send_events(firm_id, created_at);
create index if not exists social_send_events_account_idx on public.social_send_events(social_account_id, created_at);
alter table public.social_send_events enable row level security;
comment on table public.social_send_events is
  'Append-only social-DM send ledger (audit + rate governance + conversion signal). Service-role only.';

-- Per-message routing: how a queued outreach_message gets dispatched, and by which account.
alter table public.outreach_messages add column if not exists send_mode text;       -- auto_email | computer_use | human_queue
alter table public.outreach_messages add column if not exists social_account_id uuid references public.social_accounts(id) on delete set null;
alter table public.outreach_messages add column if not exists needs_human boolean not null default false;
comment on column public.outreach_messages.send_mode is
  'Dispatch path: auto_email (Resend), computer_use (browser worker), or human_queue (dashboard one-click send).';
