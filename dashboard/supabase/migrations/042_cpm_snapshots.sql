-- 042_cpm_snapshots.sql — campaign-level daily CPM time series. Additive only.
--
-- Apply with `CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/042_cpm_snapshots.sql`
-- from dashboard/. The application code does NOT depend on it having run:
-- measurement-tick's writeCpmSnapshots() probes the table with a select and
-- silently skips when it errors (pre-apply state), so the tick keeps its
-- heartbeat either way.
--
-- ─── Why ──────────────────────────────────────────────────────────────────
--
-- Label-side CPM is the objective function, but
-- it was computed on READ only — cpm-model.ts derives it per request and
-- nothing ever persisted it, so there was no time series: no way to show a
-- label "your CPM this week vs last week", and nothing for the optimizer to
-- trend against. One row per campaign per UTC day closes that.
--
-- Semantics (mirrors src/lib/analytics.ts):
--   spend_usd      Σ agreed amount over offers whose money actually moved
--                  (status paid | posted | measured — the PAID_STATES set).
--   verified_reach Σ latest-snapshot views per delivery
--                  (deal_performance_snapshots), i.e. VERIFIED impressions.
--   label_cpm      spend ÷ (reach/1000). NULLABLE AND NEVER FABRICATED:
--                  zero verified reach ⇒ NULL, exactly like labelCpm() in
--                  cpm-model.ts. A row with spend and NULL cpm is honest
--                  ("money out, reach not yet verified"), not a zero.
--
-- Writer: writeCpmSnapshots() in src/lib/measurement-tick.ts, after the
-- delivery pass lands performance snapshots (one upsert-shaped write per
-- touched campaign per day; re-runs the same day refresh the row).
-- Synthetic ([SAMPLE]) campaigns can never reach it — the tick excludes them
-- in the offers query itself.

CREATE TABLE IF NOT EXISTS cpm_snapshots (
  -- gen_random_uuid(), like every other migration in this directory.
  -- uuid_generate_v4() needs the uuid-ossp extension; _apply-file.mjs runs
  -- statements one at a time OUTSIDE a transaction, so if that first statement
  -- failed the table could still land later with RLS not yet enabled.
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  firm_id        uuid REFERENCES firms(id) ON DELETE CASCADE,
  snapshot_date  date NOT NULL,
  spend_usd      numeric NOT NULL DEFAULT 0 CHECK (spend_usd >= 0),
  verified_reach bigint  NOT NULL DEFAULT 0 CHECK (verified_reach >= 0),
  -- NULL when verified_reach is 0 — a CPM is never fabricated from zero reach.
  label_cpm      numeric CHECK (label_cpm IS NULL OR label_cpm >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS cpm_snapshots_campaign_date_idx
  ON cpm_snapshots (campaign_id, snapshot_date DESC);

-- RLS: same posture as learning_logs (007 §12) — members read their own
-- firm's campaigns' rows; INSERT/UPDATE/DELETE are pipeline-only (service
-- role, no policies).
ALTER TABLE cpm_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cpm_snapshots_select_member ON cpm_snapshots;
CREATE POLICY cpm_snapshots_select_member ON cpm_snapshots
  FOR SELECT TO authenticated
  USING (
    campaign_id IN (
      SELECT c.id FROM campaigns c
      WHERE c.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = auth.uid())
    )
  );
