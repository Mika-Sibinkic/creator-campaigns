-- Migration 014 — monthly spend caps
--
-- Two new firm-level guardrails layered ON TOP of the existing per-campaign
-- `campaigns.total_budget_usd` ceiling enforced by
-- src/app/api/payments/[id]/execute/route.ts:
--
--   * firms.monthly_spend_cap_usd        — total dollars the firm can ship
--                                          across every campaign per calendar
--                                          month (executed/in-flight rows).
--   * firms.per_creator_monthly_cap_usd  — total dollars the firm can ship
--                                          to a single creator (resolved via
--                                          creator_offers → campaign_influencers
--                                          → influencers.id) per calendar
--                                          month.
--
-- Defaults are conservative ($1000/firm, $500/creator) — high enough that the
-- existing testing harness keeps moving, low enough that a runaway
-- pipeline can't drain a budget in one batch. Firms edit both from
-- /onboarding and /settings.
--
-- The actual block lives in the payment-execute route and emits
-- payment.blocked_over_firm_monthly_cap / payment.blocked_over_creator_monthly_cap
-- audit events with the same shape as payment.blocked_over_budget.

ALTER TABLE public.firms
  ADD COLUMN IF NOT EXISTS monthly_spend_cap_usd numeric NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS per_creator_monthly_cap_usd numeric NOT NULL DEFAULT 500;

COMMENT ON COLUMN public.firms.monthly_spend_cap_usd IS
  'Per-firm calendar-month spend ceiling enforced by the payment-execute route. 0 disables.';
COMMENT ON COLUMN public.firms.per_creator_monthly_cap_usd IS
  'Per-creator (influencer_id) calendar-month spend ceiling. 0 disables.';
