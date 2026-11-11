-- 056_firm_influencer_blocks.sql
--
-- A creator's opt-out, and a label's "do not contact", belong to ONE label.
--
-- WHY
--   `influencers` is deliberately shared across firms (one row per creator,
--   `unique (platform, username)`; 007 documents it as SHARED). Its
--   `blocklisted` boolean was therefore a cross-tenant switch wearing a per-firm
--   label: a creator who replied STOP to label A's email was blocked for label B
--   too, and a label clicking "Block" removed the creator from every other
--   label's pool while the UI told them it was "your creator list".
--
--   The opt-out copy every message carries says "we'll take you off OUR list"
--   (src/lib/channels/outbound-envelope.ts). The sender is the label, so the
--   promise — and the CAN-SPAM §7704 obligation behind it — is per sender. A
--   per-firm row keeps that promise exactly; the global column over-kept it at
--   another label's expense.
--
--   Named `firm_influencer_blocks` because a row is one firm's block, not a list.
--
-- WHAT DOES NOT CHANGE — and why there is NO BACKFILL
--   `influencers.blocklisted` stays, stays read, and stays honoured for every
--   firm. Rows already true are left exactly as they are and are NOT copied into
--   this table. They are treated as a platform-level block: every reader gates
--   on (global flag OR this firm's row). Copying them into one firm's rows would
--   silently UNBLOCK the creator for every other firm — and there is no record
--   of which label (or which STOP) set each one, so any attribution would be
--   invented. A backfill that gives every block to the first-created firm is
--   deliberately not used.
--
--   From this migration on, the global column is written only by a platform
--   operator (PATCH /api/influencers/[id] with scope='global', src/lib/operator.ts)
--   or by the STOP fallback below.
--
-- PRE-056 SAFETY (the code ships before this is applied)
--   src/lib/firm-blocks.ts detects the missing table (PGRST205 / 42P01). Readers
--   then gate on the global column alone (today's behaviour); a STOP falls back
--   to writing the global column so an opt-out is never lost, and says so in the
--   log. Nothing breaks and nothing is contacted that is not contacted today.
--
-- COLUMNS
--   source              'creator_opt_out' (a STOP reply, system-written) or
--                       'label_user' (a human clicked Block).
--   created_by_user_id  TEXT, not uuid: identities are Clerk ids (`user_...`),
--                       and audit.ts already documents that a uuid column
--                       rejects them and loses the row. NULL for system writes.
--
-- RLS — same posture as cpm_snapshots (042) and learning_logs (007 §12): members
--   may SELECT their own firm's rows; INSERT/UPDATE/DELETE are service-role only
--   (no policies). Stated plainly: post-Clerk `auth.uid()` is NULL and every app
--   read goes through the service-role client, so these policies are
--   defense-in-depth, not the boundary. The boundary is the app-level
--   `.eq('firm_id', …)` in firm-blocks.ts.
--
-- Additive only. Apply with:
--   CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/056_firm_influencer_blocks.sql
--
-- Re-runnable: every statement is IF NOT EXISTS / DROP IF EXISTS guarded.
--
-- Rollback: code keeps working (it falls back to the global column), but per-firm
-- blocks recorded meanwhile would stop being honoured, so promote them first if
-- they must survive:
--   update public.influencers set blocklisted = true
--     where id in (select influencer_id from public.firm_influencer_blocks);
--   drop table if exists public.firm_influencer_blocks;

CREATE TABLE IF NOT EXISTS public.firm_influencer_blocks (
  firm_id            uuid        NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  influencer_id      uuid        NOT NULL REFERENCES public.influencers(id) ON DELETE CASCADE,
  reason             text,
  source             text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id text,
  PRIMARY KEY (firm_id, influencer_id)
);

ALTER TABLE public.firm_influencer_blocks
  DROP CONSTRAINT IF EXISTS firm_influencer_blocks_source_check;
ALTER TABLE public.firm_influencer_blocks
  ADD CONSTRAINT firm_influencer_blocks_source_check
  CHECK (source IN ('creator_opt_out', 'label_user'));

-- The PK leads with firm_id, which serves every "this firm's blocks" read. The
-- dispatch pass also resolves blocks for a batch of creators across firms.
CREATE INDEX IF NOT EXISTS firm_influencer_blocks_influencer_idx
  ON public.firm_influencer_blocks (influencer_id);

COMMENT ON TABLE public.firm_influencer_blocks IS
  'One label''s do-not-contact for one creator: a STOP reply to that label, or a label user''s Block. Gates that label''s pool, drafts, sends and dispatch. influencers.blocklisted remains a separate platform-level block honoured for every firm; its true rows were deliberately not migrated here.';
COMMENT ON COLUMN public.firm_influencer_blocks.source IS
  'creator_opt_out = the creator replied STOP (system-written). label_user = a label member clicked Block.';
COMMENT ON COLUMN public.firm_influencer_blocks.created_by_user_id IS
  'Clerk user id (text, not uuid) of the member who blocked. NULL for system writes such as an opt-out reply.';

ALTER TABLE public.firm_influencer_blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS firm_influencer_blocks_select_member ON public.firm_influencer_blocks;
CREATE POLICY firm_influencer_blocks_select_member ON public.firm_influencer_blocks
  FOR SELECT TO authenticated
  USING (
    firm_id IN (SELECT firm_id FROM public.firm_members WHERE user_id = auth.uid())
  );
