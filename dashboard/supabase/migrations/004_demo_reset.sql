-- 004_demo_reset.sql
-- Adds demo-mode infrastructure: synthetic flag, testing toggle, api_ledger.

BEGIN;

-- 1. Quarantine flag on influencers
ALTER TABLE influencers ADD COLUMN IF NOT EXISTS synthetic boolean NOT NULL DEFAULT false;

-- Mark rows created before the cutoff date as synthetic (pre-pipeline demo data)
UPDATE influencers
SET synthetic = true
WHERE created_at < '2026-05-06T00:00:00Z' AND synthetic = false;

-- 2. Testing-mode controls on firms
ALTER TABLE firms ADD COLUMN IF NOT EXISTS testing_mode boolean NOT NULL DEFAULT true;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS test_recipient_email text;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS sender_email text;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS sender_name text;

-- 3. API ledger (cost truth)
CREATE TABLE IF NOT EXISTS api_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  source text NOT NULL,                -- 'spotify' | 'openai' | 'apify' | 'scrapegraphai' | 'resend'
  endpoint text,
  cost_usd numeric(10, 4) NOT NULL DEFAULT 0,
  records_returned integer,
  latency_ms integer,
  request_meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_ledger_campaign_idx ON api_ledger(campaign_id);
CREATE INDEX IF NOT EXISTS api_ledger_source_idx ON api_ledger(source);

-- 4. Channel routing fields on campaign_influencers (some may already exist)
ALTER TABLE campaign_influencers ADD COLUMN IF NOT EXISTS primary_channel text;
ALTER TABLE campaign_influencers ADD COLUMN IF NOT EXISTS channel_confidence numeric(4, 3);
ALTER TABLE campaign_influencers ADD COLUMN IF NOT EXISTS fallback_channel text;

COMMIT;
