// src/lib/spend-caps.ts
//
// The three spend caps, extracted VERBATIM (in behavior) from the execute
// route so every money-out path — manual execute, auto-execute-on-approve,
// and the Stripe account.updated webhook — enforces the same ceilings
// (the webhook used to transfer with zero cap checks).
//
//   1. campaign        — campaigns.total_budget_usd, all-time per campaign
//   2. firm_monthly    — firms.monthly_spend_cap_usd, UTC calendar month
//   3. creator_monthly — firms.per_creator_monthly_cap_usd, UTC calendar
//                        month, summed per influencer
//
// Semantics preserved from the execute route (the route was the spec):
//   - SPENT_STATES counts 'executing' (in-flight) as spent so two concurrent
//     executes can't both read $0 remaining (TOCTOU closed by claim-then-read).
//   - Monthly windows include executed_at IS NULL rows — in-flight 'executing'
//     rows have no executed_at yet but must still count as this month's spend.
//   - The current authorization is excluded via .neq(id, ...): the caller has
//     already claimed it to 'executing' before checking.
//   - Breach condition is strict: spent + current > cap. Landing exactly on
//     the cap passes.
//
// ── FAIL CLOSED ON THE CAMPAIGN BUDGET ──────────────────────────────────────
//
// A NULL budget used to disable the cap, and NULL is the column default: a
// money guard whose permissive state is also its default state. So the
// campaign budget is NOT DISABLEABLE. NULL / 0 / negative / non-numeric
// all BLOCK with `cap: 'campaign'` and `detail.reason = 'campaign_budget_not_set'`.
// The refusal is deliberately reported as the campaign cap rather than a new
// CapName so both existing callers keep their consequences unchanged and
// remain retryable: the execute path marks the row 'failed' (re-claimable) and
// the webhook gate reverts it to 'approved'. Setting a budget makes the same
// authorization payable — this is a gate, not a dead end.
//
// The FIRM caps keep their documented `0 disables` opt-out. That asymmetry is
// deliberate, not an oversight: firms.monthly_spend_cap_usd and
// per_creator_monthly_cap_usd are NOT NULL DEFAULT 1000/500 (migration 014,
// COMMENT "0 disables") and surfaced in /settings, so a 0 there is an
// affirmative act by an operator, never an unset default. A NULL read is a
// different thing — an unverifiable cap, not a chosen one — and now fails
// closed like any other lookup failure. Because the campaign cap can no longer
// be disabled, no payout can reach the wire with zero enforceable ceiling
// regardless of how the firm caps are configured.
//
// This module does READS ONLY — no status writes, no audit, no alerts. Each
// caller applies its own consequences (execute path marks the row failed;
// the webhook gate below reverts to 'approved'). Keeping it side-effect-free
// is also what makes it hermetically testable with an in-memory stub.

import type { SupabaseClient } from '@supabase/supabase-js';

/** Statuses that count as money already spent (or committed in-flight).
 *  'executed' / 'paid' are defensive — not in the current CHECK-constraint
 *  enum, but included in case the status set is extended without revisiting
 *  this check. */
export const SPENT_STATES = ['executed', 'completed', 'paid', 'executing'];

export type CapName = 'campaign' | 'firm_monthly' | 'creator_monthly';

/** The one string every layer uses for "this campaign has no enforceable
 *  ceiling" — cap detail, confirm-route 412 body, and the DB constraint name
 *  in migration 037 all point at the same concept. */
export const CAMPAIGN_BUDGET_NOT_SET = 'campaign_budget_not_set';

export type CampaignBudgetResolution =
  | { ok: true; totalBudgetUsd: number }
  | { ok: false; reason: typeof CAMPAIGN_BUDGET_NOT_SET };

/**
 * The single definition of "this campaign has an enforceable total budget".
 *
 * Shared by the cap check and the campaign-confirm gate so the rule can't
 * drift between the thing that blocks money and the thing that lets a user
 * say the campaign is ready. PostgREST returns NUMERIC as a string, so a
 * numeric string is valid input.
 *
 * Anything that is not a finite number strictly greater than zero is NOT a
 * budget: NULL, undefined, 0, negative, ''  and NaN all resolve to unset.
 */
export function resolveCampaignBudget(raw: unknown): CampaignBudgetResolution {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, reason: CAMPAIGN_BUDGET_NOT_SET };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: CAMPAIGN_BUDGET_NOT_SET };
  return { ok: true, totalBudgetUsd: n };
}

/** The columns the money path actually enforces against. */
export interface CampaignCapColumns {
  total_budget_usd: unknown;
  per_creator_cap_usd: unknown;
}

export type CampaignCapsCheck =
  | { ok: true; totalBudgetUsd: number; perCreatorCapUsd: number }
  | { ok: false; missing: Array<'total_budget_usd' | 'per_creator_cap_usd'> };

/**
 * Both enforced ceilings present and positive? Used by the confirm route to
 * refuse to arm a campaign that would later hit the fail-closed cap check —
 * so the user learns at confirm time, not when a payout silently refuses.
 */
export function campaignCapsConfigured(row: CampaignCapColumns): CampaignCapsCheck {
  const budget = resolveCampaignBudget(row.total_budget_usd);
  const perCreator = resolveCampaignBudget(row.per_creator_cap_usd);
  const missing: Array<'total_budget_usd' | 'per_creator_cap_usd'> = [];
  if (!budget.ok) missing.push('total_budget_usd');
  if (!perCreator.ok) missing.push('per_creator_cap_usd');
  if (!budget.ok || !perCreator.ok) return { ok: false, missing };
  return { ok: true, totalBudgetUsd: budget.totalBudgetUsd, perCreatorCapUsd: perCreator.totalBudgetUsd };
}

/**
 * A firm-level monthly cap. Unlike the campaign budget, 0 IS a documented
 * opt-out here (migration 014) — but NULL/garbage is an unverifiable cap and
 * fails closed. `enforced: false` means "operator chose no limit at this
 * layer"; the campaign budget still governs underneath.
 */
function resolveFirmCap(
  raw: unknown
): { ok: true; capUsd: number; enforced: boolean } | { ok: false } {
  if (raw === null || raw === undefined || raw === '') return { ok: false };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, capUsd: n, enforced: n > 0 };
}

/** failure_reason / HTTP error-code string per cap — exactly what the
 *  execute route has always written. */
export const CAP_FAILURE_REASON: Record<CapName, string> = {
  campaign: 'campaign_total_budget_exceeded',
  firm_monthly: 'firm_monthly_cap_exceeded',
  creator_monthly: 'creator_monthly_cap_exceeded',
};

export interface SpendCapsInput {
  paymentAuthorizationId: string;
  firmId: string;
  campaignId: string;
  /** influencers.id behind this deal; null skips the per-creator cap
   *  (mirrors the execute route's `creatorInfluencerId &&` guard). */
  creatorInfluencerId: string | null;
  amountUsd: number;
}

export type SpendCapsResult =
  | {
      ok: true;
      /** Fetched alongside the caps (same selects the execute route always
       *  made) so the execute path doesn't need a second round-trip for its
       *  payout copy. */
      artistName: string;
      senderName: string;
    }
  | {
      ok: false;
      cap: 'campaign';
      detail: {
        spent_usd: number;
        current_usd: number;
        /** null when the campaign has no budget configured at all. Reported as
         *  null rather than 0 so the audit trail never implies a real ceiling
         *  that was never set. */
        total_budget_usd: number | null;
        /** false → the refusal is "no enforceable ceiling", not an overage. */
        budget_configured: boolean;
        reason?: typeof CAMPAIGN_BUDGET_NOT_SET;
      };
    }
  | {
      ok: false;
      cap: 'firm_monthly';
      detail: { spent_usd: number; current_usd: number; monthly_cap_usd: number; period: string };
    }
  | {
      ok: false;
      cap: 'creator_monthly';
      detail: { spent_usd: number; current_usd: number; monthly_cap_usd: number; period: string };
    }
  | {
      /** A lookup failed — caps could NOT be verified. Callers must fail
       *  closed (no transfer). `error` + `status` mirror the execute route's
       *  historical responses (campaign_not_found/firm_not_found → 404,
       *  query error message → 500). */
      ok: false;
      cap: 'lookup_failed';
      detail: { error: string; status: number };
    };

function sumAmounts(rows: unknown[] | null): number {
  return (rows ?? []).reduce(
    (acc: number, r) => acc + Number((r as { amount_usd: number }).amount_usd ?? 0),
    0
  );
}

/**
 * Check all three spend caps for a payment authorization that has ALREADY
 * been atomically claimed to 'executing'. Read-only; returns the first
 * breach in the same order the execute route always checked them
 * (campaign → firm_monthly → creator_monthly).
 */
export async function checkSpendCaps(
  sb: SupabaseClient,
  input: SpendCapsInput,
  opts?: { now?: Date }
): Promise<SpendCapsResult> {
  const { paymentAuthorizationId, firmId, campaignId, creatorInfluencerId } = input;
  const currentUsd = Number(input.amountUsd);

  // ── campaign total budget ──
  const { data: campRow, error: campErr } = await sb
    .from('campaigns')
    .select('total_budget_usd, artist_name')
    .eq('id', campaignId)
    .single();
  if (campErr || !campRow) {
    return { ok: false, cap: 'lookup_failed', detail: { error: 'campaign_not_found', status: 404 } };
  }
  const campData = campRow as { total_budget_usd: unknown; artist_name: string | null };
  const budget = resolveCampaignBudget(campData.total_budget_usd);
  const artistName = campData.artist_name || 'the artist';

  // The prior-spend read runs even when the budget is unset: the refusal
  // audit is worth more with the real numbers attached.
  const { data: priorRows, error: priorErr } = await sb
    .from('payment_authorizations')
    .select('id, amount_usd, status')
    .eq('campaign_id', campaignId)
    .in('status', SPENT_STATES)
    .neq('id', paymentAuthorizationId);
  if (priorErr) {
    return { ok: false, cap: 'lookup_failed', detail: { error: priorErr.message, status: 500 } };
  }
  const spentUsd = sumAmounts(priorRows);

  // FAIL CLOSED: no configured budget → no enforceable ceiling → no spend.
  if (!budget.ok) {
    return {
      ok: false,
      cap: 'campaign',
      detail: {
        spent_usd: spentUsd,
        current_usd: currentUsd,
        total_budget_usd: null,
        budget_configured: false,
        reason: budget.reason,
      },
    };
  }
  if (spentUsd + currentUsd > budget.totalBudgetUsd) {
    return {
      ok: false,
      cap: 'campaign',
      detail: {
        spent_usd: spentUsd,
        current_usd: currentUsd,
        total_budget_usd: budget.totalBudgetUsd,
        budget_configured: true,
      },
    };
  }

  // ── firm-level monthly caps ──
  const { data: firmRow, error: firmErr } = await sb
    .from('firms')
    .select('monthly_spend_cap_usd, per_creator_monthly_cap_usd, sender_name')
    .eq('id', firmId)
    .single();
  if (firmErr || !firmRow) {
    return { ok: false, cap: 'lookup_failed', detail: { error: 'firm_not_found', status: 404 } };
  }
  const firmCaps = firmRow as {
    monthly_spend_cap_usd: unknown;
    per_creator_monthly_cap_usd: unknown;
    sender_name: string | null;
  };
  const senderName = firmCaps.sender_name || 'your campaign team';

  // Both columns are NOT NULL DEFAULT (migration 014), so NULL here means the
  // cap could not be read, not that someone opted out. Unverifiable → closed.
  const firmMonthly = resolveFirmCap(firmCaps.monthly_spend_cap_usd);
  if (!firmMonthly.ok) {
    return {
      ok: false,
      cap: 'lookup_failed',
      detail: { error: 'firm_monthly_cap_not_set', status: 409 },
    };
  }
  const creatorMonthly = resolveFirmCap(firmCaps.per_creator_monthly_cap_usd);
  if (!creatorMonthly.ok) {
    return {
      ok: false,
      cap: 'lookup_failed',
      detail: { error: 'creator_monthly_cap_not_set', status: 409 },
    };
  }
  const firmMonthlyCap = firmMonthly.capUsd;
  const creatorMonthlyCap = creatorMonthly.capUsd;

  // Calendar-month window in UTC. Format YYYY-MM for the audit/error period.
  const nowDate = opts?.now ?? new Date();
  const monthStart = new Date(
    Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1)
  ).toISOString();
  const period = `${nowDate.getUTCFullYear()}-${String(nowDate.getUTCMonth() + 1).padStart(2, '0')}`;

  // ── per-firm monthly cap ──
  if (firmMonthlyCap > 0) {
    const { data: firmMonthRows, error: firmMonthErr } = await sb
      .from('payment_authorizations')
      .select('amount_usd, status, executed_at')
      .eq('firm_id', firmId)
      .in('status', SPENT_STATES)
      // In-flight 'executing' rows have executed_at NULL — they must still
      // count as this month's spend or two concurrent executes undercount.
      .or(`executed_at.gte.${monthStart},executed_at.is.null`)
      .neq('id', paymentAuthorizationId);
    if (firmMonthErr) {
      return { ok: false, cap: 'lookup_failed', detail: { error: firmMonthErr.message, status: 500 } };
    }
    const firmSpentUsd = sumAmounts(firmMonthRows);
    if (firmSpentUsd + currentUsd > firmMonthlyCap) {
      return {
        ok: false,
        cap: 'firm_monthly',
        detail: {
          spent_usd: firmSpentUsd,
          current_usd: currentUsd,
          monthly_cap_usd: firmMonthlyCap,
          period,
        },
      };
    }
  }

  // ── per-creator monthly cap ──
  // Sum payment_authorizations for this firm, this month, where the offer's
  // campaign_influencer points at the same influencer_id as the current row.
  // Postgrest inner-join filter:
  //   creator_offers.campaign_influencers.influencer_id=eq.<uuid>
  if (creatorMonthlyCap > 0 && creatorInfluencerId) {
    const { data: creatorMonthRows, error: creatorMonthErr } = await sb
      .from('payment_authorizations')
      .select(
        `id, amount_usd, status, executed_at,
         creator_offers!inner(
           campaign_influencers!inner(influencer_id)
         )`
      )
      .eq('firm_id', firmId)
      .in('status', SPENT_STATES)
      // Same NULL-executed_at inclusion as the firm-monthly query above.
      .or(`executed_at.gte.${monthStart},executed_at.is.null`)
      .neq('id', paymentAuthorizationId)
      .eq('creator_offers.campaign_influencers.influencer_id', creatorInfluencerId);
    if (creatorMonthErr) {
      return { ok: false, cap: 'lookup_failed', detail: { error: creatorMonthErr.message, status: 500 } };
    }
    const creatorSpentUsd = sumAmounts(creatorMonthRows);
    if (creatorSpentUsd + currentUsd > creatorMonthlyCap) {
      return {
        ok: false,
        cap: 'creator_monthly',
        detail: {
          spent_usd: creatorSpentUsd,
          current_usd: currentUsd,
          monthly_cap_usd: creatorMonthlyCap,
          period,
        },
      };
    }
  }

  return { ok: true, artistName, senderName };
}

// ─── Webhook cap gate ────────────────────────────────────────────────────────
//
// The seam the Stripe account.updated handler calls between its
// approved → executing claim and the transfer. Kept here (with injected
// audit/alert hooks) so the money-refusal behavior is testable without
// importing the whole route module.
//
// On breach — or on a lookup failure, because unverifiable caps must fail
// closed — it reverts the authorization to 'approved' (NOT 'failed': human
// approval already happened, the transfer can retry once there's room),
// records failure_reason 'cap:<which>', audits 'payment.webhook_cap_refused',
// and alerts once. The caller must skip the transfer and still return 200 so
// Stripe doesn't retry forever.

export interface WebhookCapGateHooks {
  audit: (entry: {
    action: string;
    target_type: string;
    target_id: string;
    firm_id?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  alertOnce: (
    key: string,
    level: 'warning' | 'error',
    message: string,
    context: Record<string, unknown>
  ) => void;
}

export type WebhookCapGateResult =
  | { allowed: true; artistName: string; senderName: string }
  | { allowed: false; cap: CapName | 'lookup_failed' };

export async function webhookCapGate(
  sb: SupabaseClient,
  // creatorOfferId is carried only into the audit row, so the /anomalies
  // payment_anomaly lane can name the creator and deal. The caps ignore it.
  input: SpendCapsInput & { creatorOfferId?: string | null },
  hooks: WebhookCapGateHooks,
  opts?: { now?: Date }
): Promise<WebhookCapGateResult> {
  const result = await checkSpendCaps(sb, input, opts);
  if (result.ok) {
    return { allowed: true, artistName: result.artistName, senderName: result.senderName };
  }

  const failureReason =
    result.cap === 'lookup_failed'
      ? `cap_check_failed:${result.detail.error}`
      : `cap:${result.cap}`;

  // Revert executing → approved so the payout can retry (manual execute or a
  // later webhook) once there's budget room; keep the refusal on the row.
  await sb
    .from('payment_authorizations')
    .update({ status: 'approved', failure_reason: failureReason } as never)
    .eq('id', input.paymentAuthorizationId)
    .eq('status', 'executing');

  await hooks.audit({
    action: 'payment.webhook_cap_refused',
    target_type: 'payment_authorization',
    target_id: input.paymentAuthorizationId,
    firm_id: input.firmId || undefined,
    metadata: {
      cap: result.cap,
      campaign_id: input.campaignId,
      creator_offer_id: input.creatorOfferId ?? null,
      influencer_id: input.creatorInfluencerId,
      amount_usd: input.amountUsd,
      ...result.detail,
    },
  });
  hooks.alertOnce(
    `payment_block:webhook_cap:${input.firmId}:${input.paymentAuthorizationId}`,
    'warning',
    `Webhook payout refused: ${result.cap === 'lookup_failed' ? 'cap check failed' : `${result.cap} cap exceeded`}`,
    {
      firm_id: input.firmId,
      payment_authorization_id: input.paymentAuthorizationId,
      campaign_id: input.campaignId,
      cap: result.cap,
      ...result.detail,
    }
  );
  return { allowed: false, cap: result.cap };
}
