-- 039_outreach_status_state_machine.sql
--
-- The application code does NOT depend on it having run.
--
-- ─── Why ──────────────────────────────────────────────────────────────────
--
-- campaign_influencers.outreach_status is the spine of the /outreach screen —
-- the draft pool, all seven tabs and the stat counters read it — and it had
-- three mutually exclusive definitions and no constraint:
--
--   * supabase/migrations/003_base_schema.sql (the consolidated base schema) declares
--       outreach_status text default 'none'   -- none | drafted | sent | replied
--   * a deployed database could carry a 'pending'::text default, which nothing
--     in dashboard/supabase/migrations/ set — changed out of band, so the
--     repo and the database disagree and neither is annotated as authoritative
--   * the application writes 'draft_ready', 'sent', 'responded' and 'rejected',
--     none of which appear in either vocabulary above
--
-- Discovery never writes the column at all (api/campaigns/[id]/run/route.ts:
-- 743-757 omits it), so a freshly discovered creator's state is whichever
-- default the database happens to carry. The "Generate All Drafts" pool query
-- was pinned to one spelling and returned zero rows against the other.
--
-- The application fix (src/lib/outreach-status.ts) tolerates every spelling, so
-- this migration is convergence and documentation, not a prerequisite. Running
-- it lets a future reader treat 'pending' as the single answer.
--
-- ─── Effect on existing rows ─────────────────────────────────────────────
--
-- Rows holding 'draft_ready', 'pending', 'responded' or 'sent' are UNCHANGED.
-- Section 1 rewrites 'none', '' and NULL to 'pending'. The base schema
-- produces 'none', so any database provisioned from 003_base_schema.sql
-- — a fresh local stack, a future branch database — starts out full of them.
--
-- Section 2 pins the column default to 'pending': a no-op where it already
-- is 'pending', and the fix on any 003-derived database. It makes the
-- default explicit in a migration for the first time, so the value has
-- in-repo provenance.
--
-- Section 3 adds a NOT VALID CHECK. Every row in one of the four values above
-- satisfies it, so the validation in section 4 succeeds rather than warning. NOT VALID + explicit
-- VALIDATE is used per migration 037's precedent: it avoids a long
-- ACCESS EXCLUSIVE lock and cannot abort the migration on a surprise row.
--
-- No column is dropped, no data is deleted, and nothing here is destructive.

begin;

-- ─── 1. Backfill the legacy spellings onto the canonical one ───────────────
--
-- 'none' is the 003_base_schema.sql default; '' is defensive (a hand-edited
-- row); NULL predates any default. All three mean the same thing: no outbound
-- message has gone to this creator yet.
--
-- Idempotent — a second run matches nothing.

update public.campaign_influencers
   set outreach_status = 'pending'
 where outreach_status is null
    or outreach_status in ('none', '');

-- ─── 2. Pin the default in a migration ─────────────────────────────────────
--
-- Before this, no migration in this directory set the default, so the repo
-- could not prove what a fresh row gets. This states it.
-- Discovery deliberately does NOT write the column (it upserts on
-- campaign_id,influencer_id and must not reset an existing creator's state on
-- a re-run), so this default is the only thing that puts a new creator into
-- the draft pool. Changing it silently breaks "Generate All Drafts".

alter table public.campaign_influencers
  alter column outreach_status set default 'pending';

-- ─── 3. Close the vocabulary ───────────────────────────────────────────────
--
-- Without this, a typo in any writer creates a new state that every reader
-- silently drops — which is precisely how 'pending' vs 'none' survived.
--
-- NULL is still permitted: the column is nullable and making it NOT NULL would
-- require an ACCESS EXCLUSIVE table rewrite for no benefit, since
-- src/lib/outreach-status.ts treats NULL as 'pending' anyway.
--
-- 'negotiating' and 'deal_closed' are included even though no writer currently
-- advances a creator into them — the /outreach tabs and the deals funnel read
-- them, and a constraint that would reject a future correct write is worse
-- than one that is slightly wide today.

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'campaign_influencers_outreach_status_valid'
  ) then
    alter table public.campaign_influencers
      add constraint campaign_influencers_outreach_status_valid
      check (
        outreach_status is null
        or outreach_status in (
          'pending',
          'draft_ready',
          'sent',
          'responded',
          'negotiating',
          'rejected',
          'deal_closed'
        )
      ) not valid;
  end if;
end $$;

-- ─── 4. Validate against existing rows ─────────────────────────────────────
--
-- Expected to succeed outright when every row is already in the allowed
-- set. Wrapped so an unexpected row raises a NOTICE naming the offending
-- values instead of aborting the migration (migration 037's pattern).

do $$
declare
  bad text;
begin
  begin
    alter table public.campaign_influencers
      validate constraint campaign_influencers_outreach_status_valid;
  exception when check_violation then
    select string_agg(distinct coalesce(outreach_status, '<null>'), ', ')
      into bad
      from public.campaign_influencers
     where outreach_status is not null
       and outreach_status not in (
         'pending', 'draft_ready', 'sent', 'responded',
         'negotiating', 'rejected', 'deal_closed'
       );
    raise notice
      'outreach_status constraint left NOT VALID — unexpected values present: %',
      bad;
  end;
end $$;

-- ─── 5. Document the column ────────────────────────────────────────────────

comment on column public.campaign_influencers.outreach_status is
  'Outreach state machine: pending -> draft_ready -> sent -> responded|rejected '
  '(-> negotiating -> deal_closed). Default ''pending''; discovery deliberately '
  'omits this column so the default is what puts a new creator in the draft '
  'pool. The vocabulary lives in src/lib/outreach-status.ts — read it through '
  'that module, never with a hardcoded string. NOTE: campaign_influencers.status '
  'is a SEPARATE, older funnel column that every discovery re-run resets to '
  '''queued'' (api/campaigns/[id]/run/route.ts:757), so it cannot carry send '
  'state; outreach_status is the one the /outreach screen reads.';

commit;
