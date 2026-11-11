-- 035: LLM qualification pass on scraped creators.
--
-- The discovery pipeline's heuristic bot filters let through accounts that
-- are structurally fine and semantically wrong (venue notice boards,
-- business/agency pages, abandoned accounts, name-substring noise). A
-- post-scoring LLM pass (src/lib/qualify.ts) now records a per-lead verdict
-- here. Excluded creators KEEP their campaign_influencers row — they stay
-- visible in the ranked list (flagged with the reason) and are only removed
-- from draft-all's eligible pool.
--
-- Additive only. Default 'unreviewed' backfills every existing row
-- (PG11+ fast path, no table rewrite).

alter table public.campaign_influencers
  add column if not exists qualification_status text not null default 'unreviewed'
    check (qualification_status in ('qualified', 'excluded', 'unreviewed')),
  add column if not exists qualification_reason text,
  add column if not exists qualification_confidence numeric
    check (
      qualification_confidence is null
      or (qualification_confidence >= 0 and qualification_confidence <= 1)
    );

comment on column public.campaign_influencers.qualification_status is
  'LLM qualification verdict (src/lib/qualify.ts): qualified | excluded | unreviewed. Excluded rows stay visible but leave the draft-all pool.';
comment on column public.campaign_influencers.qualification_reason is
  'Label-readable one-liner (≤140 chars) explaining the verdict, e.g. "Venue account — posts are show listings, not creator content".';
comment on column public.campaign_influencers.qualification_confidence is
  'Model confidence 0..1 in the verdict. Exclusion requires >= 0.6 (QUALIFY_EXCLUDE_MIN_CONFIDENCE).';
