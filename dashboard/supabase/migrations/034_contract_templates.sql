-- Contract template system. The label uploads ONE contract template
-- (their own legal clauses, plain text/markdown, {{placeholder}} slots); the app
-- fills it per deal at autonomous-acceptance time and freezes the filled copy on
-- the creator_offer. All additive → safe. RLS service-role-only, mirroring 032.

-- One active template per firm (v1). body_text is the firm's own legal text —
-- NEVER model-generated; the app only substitutes placeholders.
create table if not exists public.contract_templates (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  name text not null default 'Deal contract',
  body_text text not null,
  placeholders_detected jsonb,                    -- detectPlaceholders() output at save time
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists contract_templates_firm_uq
  on public.contract_templates(firm_id);
alter table public.contract_templates enable row level security;
comment on table public.contract_templates is
  'Per-firm deal-contract template (one active per firm, v1). Firm-authored legal text with {{placeholder}} slots; filled deterministically per deal. Service-role only (RLS denies anon).';

-- The filled copy is frozen per deal at generation time, so later template edits
-- never rewrite what a creator was actually sent.
alter table public.creator_offers add column if not exists contract_text text;
alter table public.creator_offers add column if not exists contract_generated_at timestamptz;
comment on column public.creator_offers.contract_text is
  'Contract as delivered for this deal: the firm template filled with the agreed terms, frozen at generation time.';
comment on column public.creator_offers.contract_generated_at is
  'When contract_text was generated (and appended to the agreement-confirmation email).';
