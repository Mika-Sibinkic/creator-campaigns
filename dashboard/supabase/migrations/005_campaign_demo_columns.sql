-- 005_campaign_demo_columns.sql
-- Adds the demo-pipeline write targets the pipeline expects on campaigns.
-- Both nullable; safe to apply over existing rows.

BEGIN;

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS track_name text;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS target_count integer;

-- Outreach status tracking on outreach_messages
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS sent_to text;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS status text DEFAULT 'draft';

-- Subject line on outreach_messages (some existing schemas omit it)
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS subject text;

COMMIT;
