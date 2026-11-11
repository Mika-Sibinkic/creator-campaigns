-- 006_firm_voice_profile.sql
-- Gap: firms has no voice_profile column, but draft generation
-- expects one (firm tone, dos/donts, brand guidelines). Adding as JSONB so it
-- can hold either a string blob or a structured object.

BEGIN;

ALTER TABLE firms ADD COLUMN IF NOT EXISTS voice_profile jsonb;

-- Each firm edits its voice profile on the settings page.

COMMIT;
