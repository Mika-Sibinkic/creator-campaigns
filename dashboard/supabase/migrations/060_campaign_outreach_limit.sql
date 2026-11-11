-- 060_campaign_outreach_limit.sql
--
-- Per-campaign "mini-run" limit: the most creators this campaign may contact.
--
-- The code works with or without it. Apply with
--   CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/060_campaign_outreach_limit.sql
--
-- WHY
--   Need: run a campaign that contacts only N
--   creators, chosen by the label. Nothing capped contact volume: draft-all
--   drafts ceil(target_count / deal_rate) and discovery overwrites
--   target_count with the pool size.
--
-- HOW THE CODE USES IT (src/lib/first-touch-gate.ts)
--   Every first-touch send path (manual/bulk Send, DM-queue Mark sent, the
--   dispatch pass) refuses a new creator once this many have been contacted:
--   409 "Campaign limit reached (10 of 10 contacted)". Replies and counters to
--   creators already contacted are never limited. Draft-all and generate-bulk
--   draft at most the remaining slots, highest composite score first. The
--   campaign page shows "Contacted X of N".
--
--   Before this is applied, the select of the column fails PGRST204 / 42703,
--   which the code reads as "no limit", and the form field is hidden
--   (GET /api/campaigns/outreach-limit answers supported=false).
--
-- outreach_messages.dm_reserved_at (review fix)
--   A DM is sent BY HAND: the human copies the draft, sends it, then clicks
--   Mark sent, so a limit that bites at Mark sent bites after the DM is in
--   the creator's inbox. The DM queue's copy action for a first-touch opener
--   is now "Reserve & copy" (src/lib/dm-reserve.ts): it stamps this column
--   with a compare-and-swap, re-counts the limit and budget after the stamp,
--   and only then hands over the text. A live stamp (< 24h old, row unsent)
--   counts as a contacted creator in src/lib/first-touch-gate.ts; Mark sent on
--   that row never refuses for limit or budget. The negotiation tick clears
--   lapsed stamps and audits each (outreach.dm_reservation.released).
--   Before this is applied the listing's select('*') carries no such key and
--   the queue copies plainly, exactly as before.
--
-- Additive only. Nullable, no default, no backfill: NULL means no limit and
-- no reservation, so every existing campaign and message behaves exactly as
-- it does today.
--
-- Rollback:
--   alter table public.outreach_messages drop column if exists dm_reserved_at;
--   alter table public.campaigns drop column if exists outreach_limit;

alter table public.campaigns
  add column if not exists outreach_limit integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'campaigns_outreach_limit_positive'
       and conrelid = 'public.campaigns'::regclass
  ) then
    alter table public.campaigns
      add constraint campaigns_outreach_limit_positive
      check (outreach_limit is null or outreach_limit > 0);
  end if;
end $$;

comment on column public.campaigns.outreach_limit is
  'Most creators this campaign may contact (first touches). NULL = no limit. Enforced at every first-touch send path by src/lib/first-touch-gate.ts; replies to creators already contacted are never limited.';

alter table public.outreach_messages
  add column if not exists dm_reserved_at timestamptz;

comment on column public.outreach_messages.dm_reserved_at is
  'DM queue first-touch reservation: when "Reserve & copy" took a slot of the campaign''s outreach limit / budget for this unsent human_queue opener. Live for 24h; counts as contacted in src/lib/first-touch-gate.ts. Cleared and audited by the negotiation tick if not marked sent in time (src/lib/dm-reserve.ts). NULL = no reservation.';
