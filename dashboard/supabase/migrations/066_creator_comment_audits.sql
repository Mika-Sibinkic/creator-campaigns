-- 066_creator_comment_audits.sql
--
-- Comment-quality audit: creators must not be
-- "popular for the wrong reasons, getting dogged on in their comments
-- CONSISTENTLY".
--
-- WHAT
--   campaigns.comment_audit_enabled   per-campaign opt-in (default false). The
--                                     run route audits the top creators only
--                                     when this is true.
--   creator_comment_audits            one row per audit of one creator on one
--                                     platform. Reused for 30 days by every
--                                     campaign that opts in, so a creator is
--                                     paid for once a month, not once a run.
--   campaign_influencers.comment_audit_id   the audit this campaign applied.
--   campaign_influencers.comment_held       snapshot of audit.held at apply
--                                           time. True blocks first touch.
--   campaign_influencers.comment_override   {by_user_id, by_label, reason, at}
--                                           A human cleared the hold. Audited.
--
--   The held flag is copied onto the campaign row (not read through the join)
--   so the first-touch gate and the draft pool need one read on a table they
--   already read. The audit row stays the record of WHY.
--
-- PRE-066 SAFETY (the code ships before this is applied)
--   Every reader detects the missing column/table (PGRST204 / 42703 /
--   PGRST205 / 42P01) and treats the feature as absent: the toggle is hidden,
--   the run route skips the step, the gate sees no hold, offers are unchanged.
--   src/lib/comment-audit-store.ts holds those reads.
--
-- RLS. Audits are about SHARED creators (influencers is cross-firm), so a
--   member may SELECT an audit only for a creator their own firm has a
--   campaign relationship with. INSERT/UPDATE/DELETE: service role only (no
--   policies), the same posture as firm_influencer_blocks (056) and
--   cpm_snapshots (042). Post-Clerk auth.uid() is NULL and app reads use the
--   service-role client, so this is defense in depth; the boundary is the
--   app-level firm check in the routes.
--
-- Additive only. Apply with:
--   CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/066_creator_comment_audits.sql
--
-- Re-runnable: every statement is IF NOT EXISTS / DROP IF EXISTS guarded.
--
-- Rollback (the code falls back to "feature absent"):
--   alter table public.campaign_influencers drop column if exists comment_override,
--     drop column if exists comment_held, drop column if exists comment_audit_id;
--   drop table if exists public.creator_comment_audits;
--   alter table public.campaigns drop column if exists comment_audit_enabled;

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS comment_audit_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.campaigns.comment_audit_enabled IS
  'Per-campaign opt-in to the comment-quality audit of the top creators after scoring. Costs scraper credit; see src/lib/comment-audit.ts.';

CREATE TABLE IF NOT EXISTS public.creator_comment_audits (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  influencer_id        uuid        NOT NULL REFERENCES public.influencers(id) ON DELETE CASCADE,
  platform             text        NOT NULL,
  posts_count          integer     NOT NULL DEFAULT 0,
  comments_count       integer     NOT NULL DEFAULT 0,
  supportive_share     numeric(5,4),
  neutral_share        numeric(5,4),
  negative_share       numeric(5,4),
  bot_spam_share       numeric(5,4),
  consistent_negative  boolean     NOT NULL DEFAULT false,
  held                 boolean     NOT NULL DEFAULT false,
  insufficient         boolean     NOT NULL DEFAULT false,
  per_post             jsonb       NOT NULL DEFAULT '[]'::jsonb,
  samples              jsonb       NOT NULL DEFAULT '[]'::jsonb,
  provider             text,
  model                text,
  cost_usd             numeric(10,4) NOT NULL DEFAULT 0,
  apify_run_id         text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.creator_comment_audits
  DROP CONSTRAINT IF EXISTS creator_comment_audits_shares_check;
ALTER TABLE public.creator_comment_audits
  ADD CONSTRAINT creator_comment_audits_shares_check CHECK (
    (supportive_share IS NULL OR supportive_share BETWEEN 0 AND 1) AND
    (neutral_share    IS NULL OR neutral_share    BETWEEN 0 AND 1) AND
    (negative_share   IS NULL OR negative_share   BETWEEN 0 AND 1) AND
    (bot_spam_share   IS NULL OR bot_spam_share   BETWEEN 0 AND 1)
  );

-- The 30-day reuse read: latest audit per (creator, platform).
CREATE INDEX IF NOT EXISTS creator_comment_audits_reuse_idx
  ON public.creator_comment_audits (influencer_id, platform, created_at DESC);

COMMENT ON TABLE public.creator_comment_audits IS
  'Comment-quality audit of one creator on one platform: shares of supportive / neutral / negative-at-creator / bot-spam comments over their most recent posts. consistent_negative = >=15% negative on >=2 posts; held = >=30% on >=2 posts. Reused for 30 days.';
COMMENT ON COLUMN public.creator_comment_audits.negative_share IS
  'Share of classified comments that are negative AT THE CREATOR (not at a third party, not slang praise).';
COMMENT ON COLUMN public.creator_comment_audits.insufficient IS
  'Fewer than 20 classified comments. Recorded so the spend is not repeated, but it has no effect on the creator.';
COMMENT ON COLUMN public.creator_comment_audits.apify_run_id IS
  'Provider run/request id(s) for the comment fetch (Apify run id, or a ScrapeCreators marker). Comma-joined when there were several.';

ALTER TABLE public.creator_comment_audits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS creator_comment_audits_select_related ON public.creator_comment_audits;
CREATE POLICY creator_comment_audits_select_related ON public.creator_comment_audits
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.campaign_influencers ci
      JOIN public.campaigns c ON c.id = ci.campaign_id
      JOIN public.firm_members fm ON fm.firm_id = c.firm_id
      WHERE ci.influencer_id = creator_comment_audits.influencer_id
        AND fm.user_id = auth.uid()
    )
  );

ALTER TABLE public.campaign_influencers
  ADD COLUMN IF NOT EXISTS comment_audit_id uuid REFERENCES public.creator_comment_audits(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS comment_held boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS comment_override jsonb;

COMMENT ON COLUMN public.campaign_influencers.comment_held IS
  'The applied comment audit held this creator (>=30% negative-at-creator on >=2 posts). Blocks first touch and drafting until comment_override is set.';
COMMENT ON COLUMN public.campaign_influencers.comment_override IS
  'A human cleared the comment hold: {by_user_id, by_label, reason, at}. Also written to audit_log as campaign_influencer.comment_override.';
