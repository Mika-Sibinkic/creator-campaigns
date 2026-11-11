-- Promo materials uploaded at campaign inception (the track to promote + assets),
-- attached to creators on payment. Files in the private campaign-materials bucket;
-- this table is the metadata index.
insert into storage.buckets (id, name, public)
values ('campaign-materials', 'campaign-materials', false)
on conflict (id) do nothing;

create table if not exists public.campaign_materials (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  firm_id uuid not null references public.firms(id) on delete cascade,
  storage_path text not null,
  filename text not null,
  content_type text,
  size_bytes bigint,
  created_at timestamptz not null default now()
);
create index if not exists campaign_materials_campaign_idx on public.campaign_materials(campaign_id);
alter table public.campaign_materials enable row level security;
comment on table public.campaign_materials is
  'Promo materials (audio/video/image) uploaded per campaign, attached to creators on payment. Service-role access only (RLS denies anon).';
