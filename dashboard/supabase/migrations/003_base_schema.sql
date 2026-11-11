-- =============================================================================
-- Creator Campaigns — base schema (consolidated migrations 001–003)
-- =============================================================================
-- First file in the migration chain; `supabase db reset` applies it before 004.
-- Reconstructed from the dashboard source (src/lib/supabase.ts + API routes).
-- Safe to re-run — uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS everywhere.
-- =============================================================================

create extension if not exists "uuid-ossp";

-- ─── Firms (the labels / managers that run campaigns) ────────────────────────
create table if not exists firms (
  id                    uuid primary key default uuid_generate_v4(),
  name                  text not null,
  primary_contact_email text,
  genre_focus           text[] default '{}',
  created_at            timestamptz not null default now()
);

-- Voice profile / tone of voice / house-style context per firm.
-- Consumed by the outreach message generator.
create table if not exists firm_contexts (
  id          uuid primary key default uuid_generate_v4(),
  firm_id     uuid references firms(id) on delete cascade,
  tone        text,
  values      text,
  do_not_say  text,
  sample_copy text,
  created_at  timestamptz not null default now()
);

-- ─── Campaigns (one per artist × release) ────────────────────────────────────
create table if not exists campaigns (
  id                  uuid primary key default uuid_generate_v4(),
  firm_id             uuid references firms(id) on delete cascade,
  artist_name         text not null,
  artist_spotify_id   text,
  artist_data         jsonb default '{}'::jsonb,
  budget              numeric,
  per_influencer_cap  numeric,
  release_date        date,
  duration_days       int default 30,
  urgency             text default 'normal',
  target_platforms    text[] default '{tiktok}',
  geo_overrides       text[],
  special_instructions text,
  status              text default 'draft',       -- draft | running | active | completed
  similar_artists     jsonb default '[]'::jsonb,
  ip_intelligence     jsonb default '{}'::jsonb,
  pipeline_costs      jsonb,                      -- migration 002
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ─── Influencers (global pool, unique by platform+username) ──────────────────
create table if not exists influencers (
  id              uuid primary key default uuid_generate_v4(),
  platform        text not null,
  username        text not null,
  display_name    text,
  profile_url     text,
  follower_count  int,
  engagement_rate numeric,
  bio             text,
  verified        boolean default false,
  avatar_url      text,
  content_genres  text[],
  contact_email   text,
  bot_probability numeric,                         -- migration 002
  bot_flagged     boolean default false,           -- migration 002
  blocklisted     boolean default false,
  score_breakdown jsonb,                           -- migration 002
  posting_cadence jsonb,                           -- migration 002
  follower_following_ratio numeric,                -- migration 002
  raw_data        jsonb default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  unique (platform, username)
);

-- ─── Campaign ↔ Influencer link (per-campaign scoring + outreach state) ─────
create table if not exists campaign_influencers (
  id                      uuid primary key default uuid_generate_v4(),
  campaign_id             uuid not null references campaigns(id) on delete cascade,
  influencer_id           uuid not null references influencers(id) on delete cascade,
  composite_score         numeric,
  tier                    text,
  price_estimate_low      numeric,
  price_estimate_mid      numeric,
  price_estimate_high     numeric,
  outreach_priority       text default 'standard',
  outreach_angle          text,
  source_artists          text[],
  status                  text default 'queued',   -- queued | contacted | responded | negotiating | deal_closed | rejected
  score_breakdown         jsonb,                    -- migration 002
  bot_flagged             boolean default false,    -- migration 002
  outreach_status         text default 'none',      -- migration 003: none | drafted | sent | replied
  message_count           int default 0,            -- migration 003
  last_outreach_at        timestamptz,              -- migration 003
  last_response_at        timestamptz,              -- migration 003
  response_classification text,                     -- migration 003
  created_at              timestamptz not null default now(),
  unique (campaign_id, influencer_id)
);

-- ─── Outreach messages (bidirectional: outbound + inbound logged replies) ────
create table if not exists outreach_messages (
  id                         uuid primary key default uuid_generate_v4(),
  campaign_influencer_id     uuid not null references campaign_influencers(id) on delete cascade,
  message_type               text not null,          -- initial | follow_up | negotiation | response
  direction                  text not null,          -- outbound | inbound
  subject                    text,
  body                       text not null,
  channel                    text,                   -- email | dm | comment
  sent_at                    timestamptz,
  delivered                  boolean,
  opened                     boolean,
  replied                    boolean,
  classification             text,                   -- interested | not_interested | negotiating | question | unclear
  classification_confidence  numeric,
  ai_suggested_response      text,
  version                    int default 1,          -- migration 003
  template_used              text,                   -- migration 003
  generation_model           text,                   -- migration 003
  edited_by_user             boolean default false,  -- migration 003
  original_body              text,                   -- migration 003
  created_at                 timestamptz not null default now()
);

-- ─── Deals (signed agreements) ───────────────────────────────────────────────
create table if not exists deals (
  id                      uuid primary key default uuid_generate_v4(),
  campaign_influencer_id  uuid not null references campaign_influencers(id) on delete cascade,
  agreed_price            numeric not null,
  deliverable_type        text,
  deliverable_specs       jsonb default '{}'::jsonb,
  deadline                date,
  payment_status          text default 'pending',
  fulfillment_status      text default 'pending',
  content_url             text,
  created_at              timestamptz not null default now()
);

-- ─── Campaign outcomes (post-campaign attribution + learning) ────────────────
create table if not exists campaign_outcomes (
  id             uuid primary key default uuid_generate_v4(),
  campaign_id    uuid not null references campaigns(id) on delete cascade,
  total_spend    numeric,
  total_reach    bigint,
  streams_lift   int,
  follower_lift  int,
  roi_estimate   numeric,
  notes          text,
  created_at     timestamptz not null default now()
);

-- ─── Learning logs (free-form observations fed back into scoring) ────────────
create table if not exists learning_logs (
  id         uuid primary key default uuid_generate_v4(),
  category   text,
  signal     text,
  context    jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ─── Helpful indexes ─────────────────────────────────────────────────────────
create index if not exists idx_campaign_influencers_campaign on campaign_influencers(campaign_id);
create index if not exists idx_campaign_influencers_status   on campaign_influencers(status);
create index if not exists idx_outreach_messages_ci          on outreach_messages(campaign_influencer_id);
create index if not exists idx_outreach_messages_direction   on outreach_messages(direction);
create index if not exists idx_influencers_platform_user     on influencers(platform, username);

-- ─── Row-level security ──────────────────────────────────────────────────────
-- The dashboard runs with the anon key, so either (a) leave RLS off for single-
-- tenant dev, or (b) enable RLS and write policies keyed to auth.uid() once you
-- add Supabase Auth.  The app code does not assume RLS is on.
--
-- Example (commented out):
-- alter table campaigns enable row level security;
-- create policy "anon read campaigns" on campaigns for select using (true);
