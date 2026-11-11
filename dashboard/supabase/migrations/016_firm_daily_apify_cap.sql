-- Migration 016 — Per-firm daily Apify spend cap
--
-- Rail to stop a tester accidentally clicking "Run Discovery" 20 times and
-- racking up Apify spend. The run route sums api_ledger.cost_usd for
-- source='apify' joined through campaigns.firm_id and the current calendar
-- day (UTC). If the sum is at/above this cap, the run is rejected with a
-- 429 and SSE 'error' event { code: 'daily_apify_cap_exceeded', ... }.
--
-- Default $10/day — high enough that a tester can run several
-- discovery passes per day, low enough that a 20x runaway click costs less
-- than a single steak dinner.
--
-- Layers on TOP of:
--   * APIFY_PER_RUN_USD_CAP (per-run cap, env-tunable, default $5)
--   * firms.monthly_spend_cap_usd (payment executor, not pipeline)

ALTER TABLE public.firms
  ADD COLUMN IF NOT EXISTS daily_apify_cap_usd numeric NOT NULL DEFAULT 10;

COMMENT ON COLUMN public.firms.daily_apify_cap_usd IS
  'Per-firm calendar-day (UTC) Apify spend ceiling enforced by the campaign run route. 0 disables.';
