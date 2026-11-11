-- Migration 018 — Autonomous-negotiation foundation
--
-- Additive schema for the autonomous-negotiation feature. All statements
-- are idempotent (IF NOT EXISTS / guarded DO blocks) so the file can be
-- applied and re-applied without error.
--
-- New tables:
--   * inbound_messages          — the ONE normalized reply queue. Every reply
--                                 source (simulator, Resend email.received,
--                                 Unipile IG) writes a row here via
--                                 src/lib/ingest-inbound.ts → classifier →
--                                 auto-negotiator. Dedupe on (channel,
--                                 external_id).
--   * creator_contacts          — discovered contact candidates per influencer
--                                 (bio-regex → LLM extraction → bio-link fetch).
--   * channel_conversion_priors — per firm×channel sent/replies/deals counters
--                                 that feed channel-selector + the RL loop.
--   * dm_thread_state           — provider chat_id ↔ campaign_influencer map for
--                                 DM threading (IG/LinkedIn via Unipile, later).
--
-- Altered tables:
--   * outreach_messages — +provider_message_id, +provider_thread_id, and a
--                         controlled-vocabulary CHECK on the EXISTING channel
--                         column (email | instagram_dm | tiktok_dm | linkedin_dm).
--                         The Resend route's fragile best-effort match keys off
--                         provider_message_id / provider_thread_id going forward.
--   * creator_offers    — +autonomy_mode (default 'auto'), +opening_pct
--                         (RL-set opening offer as fraction of ceiling),
--                         +injection_flagged (prompt-injection lane marker).
--
-- RLS: mirrors existing tables. Firm-scoped SELECT for authenticated members;
-- all writes are service-role only (BYPASSRLS) via supabaseAdmin() from the
-- ingest/pipeline/webhook paths. creator_contacts follows the SHARED-influencer
-- model (influencers are firm-agnostic in this schema, so are their contacts).

-- ──────────────────────────────────────────────────────────────────────────
-- 1. inbound_messages — normalized reply queue
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.inbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL,
  external_id text,
  creator_offer_id uuid REFERENCES public.creator_offers(id) ON DELETE SET NULL,
  campaign_influencer_id uuid REFERENCES public.campaign_influencers(id) ON DELETE CASCADE,
  from_identity text,
  body text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'classified', 'flagged', 'processed')),
  classification jsonb
);

COMMENT ON TABLE public.inbound_messages IS
  'Single normalized reply queue. All channels + sources land here via ingestInboundReply(); classifier + auto-negotiator consume it. Dedupe on (channel, external_id).';

-- Dedupe key: one row per provider message id per channel. Partial so many
-- rows may carry a NULL external_id (sources that lack a stable id).
CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_channel_extid_uidx
  ON public.inbound_messages (channel, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS inbound_messages_ci_idx
  ON public.inbound_messages (campaign_influencer_id);
CREATE INDEX IF NOT EXISTS inbound_messages_offer_idx
  ON public.inbound_messages (creator_offer_id);
CREATE INDEX IF NOT EXISTS inbound_messages_status_idx
  ON public.inbound_messages (status);
CREATE INDEX IF NOT EXISTS inbound_messages_received_idx
  ON public.inbound_messages (received_at DESC);

ALTER TABLE public.inbound_messages ENABLE ROW LEVEL SECURITY;

-- SELECT: firm members read inbound rows whose campaign_influencer resolves to
-- a firm they belong to (via campaign_influencers → campaigns → firm_members),
-- mirroring outreach_messages. Unmatched rows (campaign_influencer_id IS NULL)
-- are visible to NO authenticated user — service-role only, like learning_logs.
-- INSERT/UPDATE/DELETE: no policies → implicit deny (service role only).
DROP POLICY IF EXISTS inbound_messages_select_member ON public.inbound_messages;
CREATE POLICY inbound_messages_select_member ON public.inbound_messages
  FOR SELECT TO authenticated
  USING (
    campaign_influencer_id IS NOT NULL
    AND campaign_influencer_id IN (
      SELECT ci.id FROM public.campaign_influencers ci
      JOIN public.campaigns c ON c.id = ci.campaign_id
      WHERE c.firm_id IN (
        SELECT firm_id FROM public.firm_members WHERE user_id = auth.uid()
      )
    )
  );

-- ──────────────────────────────────────────────────────────────────────────
-- 2. creator_contacts — discovered contact candidates per influencer
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.creator_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  influencer_id uuid NOT NULL REFERENCES public.influencers(id) ON DELETE CASCADE,
  channel text NOT NULL,
  address text NOT NULL,
  source text NOT NULL,
  confidence numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.creator_contacts IS
  'Discovered contact candidates per influencer (bio-regex → LLM extraction → bio-link fetch). Ranked by confidence; channel hints feed channel-selector.';

CREATE INDEX IF NOT EXISTS creator_contacts_influencer_idx
  ON public.creator_contacts (influencer_id);
-- One row per (influencer, channel, address) so re-discovery is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS creator_contacts_uniq
  ON public.creator_contacts (influencer_id, channel, address);

ALTER TABLE public.creator_contacts ENABLE ROW LEVEL SECURITY;

-- SELECT: any authenticated user, mirroring the SHARED influencers table
-- (creators are firm-agnostic here, so are their discovered contacts).
-- INSERT/UPDATE/DELETE: service-role only (discovery pipeline).
DROP POLICY IF EXISTS creator_contacts_select_all ON public.creator_contacts;
CREATE POLICY creator_contacts_select_all ON public.creator_contacts
  FOR SELECT TO authenticated
  USING (true);

-- ──────────────────────────────────────────────────────────────────────────
-- 3. channel_conversion_priors — firm×channel funnel counters
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.channel_conversion_priors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  channel text NOT NULL,
  sent integer NOT NULL DEFAULT 0,
  replies integer NOT NULL DEFAULT 0,
  deals integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, channel)
);

COMMENT ON TABLE public.channel_conversion_priors IS
  'Per firm×channel sent/replies/deals counters → conversion rate per channel. Cold-start defaults seeded; RL loop + channel-selector read/update.';

CREATE INDEX IF NOT EXISTS channel_conversion_priors_firm_idx
  ON public.channel_conversion_priors (firm_id);

ALTER TABLE public.channel_conversion_priors ENABLE ROW LEVEL SECURITY;

-- SELECT: firm members read their own firm's priors (direct firm_id scope,
-- mirroring firm_contexts). Writes are service-role only (pipeline/RL loop).
DROP POLICY IF EXISTS ccp_select_member ON public.channel_conversion_priors;
CREATE POLICY ccp_select_member ON public.channel_conversion_priors
  FOR SELECT TO authenticated
  USING (
    firm_id IN (
      SELECT firm_id FROM public.firm_members WHERE user_id = auth.uid()
    )
  );

-- ──────────────────────────────────────────────────────────────────────────
-- 4. dm_thread_state — provider chat_id ↔ campaign_influencer map
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.dm_thread_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  account_id text,
  chat_id text NOT NULL,
  campaign_influencer_id uuid REFERENCES public.campaign_influencers(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, chat_id)
);

COMMENT ON TABLE public.dm_thread_state IS
  'DM threading map: provider chat_id ↔ campaign_influencer_id (IG/LinkedIn via Unipile). Dedupe inbound DMs on (provider, chat_id).';

CREATE INDEX IF NOT EXISTS dm_thread_state_ci_idx
  ON public.dm_thread_state (campaign_influencer_id);

ALTER TABLE public.dm_thread_state ENABLE ROW LEVEL SECURITY;

-- SELECT: firm members read thread state for their own firm's campaign
-- influencers (join scope, mirroring outreach_messages / inbound_messages).
-- Writes are service-role only (webhook/adapter paths).
DROP POLICY IF EXISTS dm_thread_state_select_member ON public.dm_thread_state;
CREATE POLICY dm_thread_state_select_member ON public.dm_thread_state
  FOR SELECT TO authenticated
  USING (
    campaign_influencer_id IS NOT NULL
    AND campaign_influencer_id IN (
      SELECT ci.id FROM public.campaign_influencers ci
      JOIN public.campaigns c ON c.id = ci.campaign_id
      WHERE c.firm_id IN (
        SELECT firm_id FROM public.firm_members WHERE user_id = auth.uid()
      )
    )
  );

-- ──────────────────────────────────────────────────────────────────────────
-- 5. outreach_messages — provider ids + controlled-vocabulary channel
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.outreach_messages
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS provider_thread_id text;

COMMENT ON COLUMN public.outreach_messages.provider_message_id IS
  'Stable provider message id (Resend/Unipile). Dedupe + reply-match key; replaces the earlier fragile best-effort match in the Resend webhook.';
COMMENT ON COLUMN public.outreach_messages.provider_thread_id IS
  'Provider thread/conversation id for DM + email threading.';

CREATE INDEX IF NOT EXISTS outreach_messages_provider_msg_idx
  ON public.outreach_messages (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS outreach_messages_provider_thread_idx
  ON public.outreach_messages (provider_thread_id)
  WHERE provider_thread_id IS NOT NULL;

-- channel ALREADY EXISTS (text DEFAULT 'email'). We are NOT re-adding it; we
-- add the controlled-vocabulary CHECK. Any legacy value outside the new set
-- (historical 'dm' / 'comment' from generateOutreachMessage, or NULL) is
-- normalized to 'email' first so the constraint applies cleanly — the demo
-- path only ever wrote 'email', so this is a no-op in practice.
UPDATE public.outreach_messages
  SET channel = 'email'
  WHERE channel IS NULL
     OR channel NOT IN ('email', 'instagram_dm', 'tiktok_dm', 'linkedin_dm');

ALTER TABLE public.outreach_messages
  ALTER COLUMN channel SET DEFAULT 'email';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outreach_messages_channel_check'
      AND conrelid = 'public.outreach_messages'::regclass
  ) THEN
    ALTER TABLE public.outreach_messages
      ADD CONSTRAINT outreach_messages_channel_check
      CHECK (channel IN ('email', 'instagram_dm', 'tiktok_dm', 'linkedin_dm'));
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────────
-- 6. creator_offers — autonomy + RL opening-offer + injection lane
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.creator_offers
  ADD COLUMN IF NOT EXISTS autonomy_mode text NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS opening_pct numeric,
  ADD COLUMN IF NOT EXISTS injection_flagged boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.creator_offers.autonomy_mode IS
  'Negotiation autonomy: ''auto'' = AI auto-sends counters within caps (default). Non-auto modes park the offer for human review.';
COMMENT ON COLUMN public.creator_offers.opening_pct IS
  'Opening offer as a fraction of ceiling_usd, set by the RL loop toward the learned price↔output equilibrium. NULL = not yet computed.';
COMMENT ON COLUMN public.creator_offers.injection_flagged IS
  'True when an inbound reply for this offer tripped the prompt-injection detector and was routed to the flagged lane (excluded from auto-counter).';
