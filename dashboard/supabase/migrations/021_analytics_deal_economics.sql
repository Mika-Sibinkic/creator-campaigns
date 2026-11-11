-- Migration 021 — analytics: per-deal economics + synthetic campaign labeling
--
-- Additive + idempotent. Two concerns:
--
--   1. creator_offers gains two latent per-deal economics:
--      perceived_generosity (agreed ÷ tier-base norm) and
--      price_give_pct ((agreed − opening) ÷ ceiling). Both are SNAPSHOTS
--      written once by src/lib/deal-economics.ts (sweeper on the negotiation
--      tick + targeted write on outcome record) — follower counts drift, so
--      deriving at read time would silently rewrite history.
--      economics_computed_at marks the row done (sweeper convergence key).
--
--   2. campaigns.synthetic — the labeled-sample-data flag, mirroring
--      influencers.synthetic (migration 004). Synthetic campaigns are
--      excluded from the firm money rollup (/api/analytics, /api/dashboard)
--      and NEVER pooled with real campaigns in a correlation report.
--
-- Rollback: drop the three creator_offers columns, the campaigns column,
-- and the two indexes; nothing else references them.

ALTER TABLE public.creator_offers
  ADD COLUMN IF NOT EXISTS perceived_generosity numeric,
  ADD COLUMN IF NOT EXISTS price_give_pct numeric,
  ADD COLUMN IF NOT EXISTS economics_computed_at timestamptz;

COMMENT ON COLUMN public.creator_offers.perceived_generosity IS
  'agreed_amount_usd ÷ tier_base_usd(follower_count) — how generous the close felt vs the pricing-engine norm (1.0 = exactly the tier base). Falls back to agreed ÷ ceiling_usd when follower count is unknown. Snapshot written by deal-economics sweeper; NULL = not yet computed.';
COMMENT ON COLUMN public.creator_offers.price_give_pct IS
  '(agreed_amount_usd − initial_offer_usd) ÷ ceiling_usd — how far the price moved during negotiation, normalized to the per-creator ceiling. Positive = we moved up from our opening. Same formula as the meanGap term in analytics.ts estimateOpeningPct, persisted per-deal. NULL = not yet computed.';
COMMENT ON COLUMN public.creator_offers.economics_computed_at IS
  'When the deal-economics sweeper stamped perceived_generosity/price_give_pct. NULL = pending (sweeper picks it up on the next negotiation tick).';

-- Sweeper scan: only closed-with-a-number rows still awaiting economics.
CREATE INDEX IF NOT EXISTS creator_offers_econ_pending_idx
  ON public.creator_offers (id)
  WHERE agreed_amount_usd IS NOT NULL AND economics_computed_at IS NULL;

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS synthetic boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.campaigns.synthetic IS
  'TRUE = clearly-labeled fabricated sample campaign (tools/seed-sample-analytics.mjs). Excluded from firm money rollups; never pooled with real campaigns in correlation reports. Mirrors influencers.synthetic (migration 004).';

CREATE INDEX IF NOT EXISTS campaigns_synthetic_idx
  ON public.campaigns (synthetic)
  WHERE synthetic = true;
