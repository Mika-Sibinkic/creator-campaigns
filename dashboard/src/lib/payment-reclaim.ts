// src/lib/payment-reclaim.ts
//
// Return stranded payment authorizations to 'approved' so they can be retried.
//
// WHY THIS EXISTS
//   The claim to 'executing' in execute-payment.ts is atomic and correct — it is
//   what stops two concurrent executes from both paying. What it cannot do is
//   survive the process dying afterwards. The claim is followed by up to four
//   sequential provider HTTP calls, none of them in a transaction with it, and
//   there is no writer anywhere that can move a row out of 'executing' from a
//   later invocation.
//
//   That made a timeout permanent, and expensive in a non-obvious way:
//   spend-caps.ts counts 'executing' in SPENT_STATES and deliberately includes
//   rows with executed_at IS NULL, so a stranded row burns campaign budget, firm
//   monthly budget and the creator's monthly cap forever. The UI dead-ends too —
//   DealRow renders "Payment in progress…" with no action. Recovery was hand SQL
//   against production.
//
// WHY BACK TO 'approved' AND NOT 'failed'
//   The human approval already happened and is still recorded on the row, and
//   every spend cap re-runs from scratch on the next attempt. 'approved' is the
//   state the operator left it in, so it is the honest place to put it back.
//   'failed' would also work mechanically but reads as "the provider rejected
//   this", which is a different and false claim.
//
// RECONCILED, NOT BLIND-REVERTED (since 2026-09-30)
//   This used to put every stale claim back to 'approved' on the argument that
//   the idempotency key makes a retry safe. It does not: Stripe keeps a key for
//   24h, and an 'approved' row is re-sent by the onboarding webhook with no
//   human click, possibly days later. A process that died mid-transfer is as
//   ambiguous as a network error. So in the Stripe modes a stale claim is now
//   resolved by payment-reconcile.ts from Stripe's own record (transfer_group):
//   completed, confirmed-not-sent ('failed', retryable by a human only), or
//   left 'executing' + marked outcome-unknown for the /anomalies lane.
//   Paper mode keeps the old revert — no money exists to double-send. PayPal
//   has no reconciliation, so a stale PayPal claim is left for a human.
//
// THE ROW'S MODE, NOT THE ENV'S
//   The branch used to be chosen from the CURRENT environment's resolved mode.
//   resolvePaymentMode() falls back to 'paper' when a Stripe key is missing or
//   the wrong kind (test key under stripe_live) — so a key rotation turned a
//   stripe_live "outcome unknown" row back into 'approved', and the next
//   approval path re-sent it. Now each row is routed by its recorded
//   payment_mode (stamped with the claim): reconciled only when this
//   environment runs that same Stripe mode, reverted only when the row is paper
//   AND paper is what is configured, and otherwise left exactly as it is with a
//   payment.reclaim_provider_unreachable anomaly for a human.
//
// BACKED OFF, NOT HOURLY
//   A row that stays unresolvable (Stripe holds two transfers, a reversed one,
//   the wrong amount; or this env cannot reach its rail) used to be re-asked
//   and re-audited on EVERY hourly pass — 24 identical anomaly rows a day per
//   payment, enough to push every other money anomaly out of the lane's fetch
//   window. Now a row that already has k flags (payment.reconcile_mismatch /
//   payment.reclaim_provider_unreachable) is skipped until reconcileBackoffMs(k)
//   has passed since the newest one. Flags are read from audit_log — the same
//   append-only rows the lane shows, so there is no second state to drift. An
//   unreadable audit_log means no backoff: asking again is the safe direction.
//   The operator's "Check with Stripe" is never backed off.
//
// Bounded, quiet, and idempotent: the reclaim is a conditional update, so two
// overlapping passes cannot both reclaim the same row.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from './logger';
import type { AuditEntry } from './audit';
import { reconcilePaymentOutcome, type ReconcileDeps } from './payment-reconcile';
import { configuredPaymentMode, resolveActivePaymentMode } from './stripe-isolated';
import { OUTCOME_UNKNOWN_REASON } from './payment-claim';

const log = createLogger('payment-reclaim');

/**
 * How long a claim may sit before it is considered stranded.
 *
 * execute-payment's own ceiling is maxDuration = 300s on the routes that call
 * it, so anything past 15 minutes cannot still be in flight. Generous on
 * purpose: reclaiming a live execution would be worse than waiting.
 */
export const STALE_EXECUTING_MS = 15 * 60_000;

/** Rows examined per pass. */
export const RECLAIM_BATCH_SIZE = 50;

export interface ReclaimTally {
  considered: number;
  /** Paper mode: returned to 'approved'. */
  reclaimed: number;
  /** Stripe modes: resolved from Stripe (completed or confirmed not sent). */
  reconciled: number;
  /** Stripe/PayPal modes: left 'executing' for a human (outcome unknown). */
  unresolved: number;
  /** Left untouched: this environment cannot reach the rail the row was sent on. */
  unreachable: number;
  /** Skipped this pass: already flagged, and inside its backoff window. */
  backedOff: number;
  errors: number;
}

/** Audit actions that flag a stale claim as needing a human. Kept in step with
 *  statuses.ts RECONCILE_FLAG_ACTIONS (the lane); tests pin them equal. */
export const RECLAIM_FLAG_ACTIONS: readonly string[] = ['payment.reconcile_mismatch', 'payment.reclaim_provider_unreachable'];

const BACKOFF_BASE_MS = 60 * 60_000;
const BACKOFF_MAX_MS = 24 * 60 * 60_000;

/** Wait after the newest of `flags` flags before this row is looked at again:
 *  2h, 4h, 8h, 16h, then daily. */
export function reconcileBackoffMs(flags: number): number {
  if (flags <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(flags, 16), BACKOFF_MAX_MS);
}

/** Flags already on record per authorization: count + newest. Null when
 *  audit_log cannot be read (then nothing is backed off). */
async function priorFlags(
  sb: SupabaseClient,
  ids: string[]
): Promise<Map<string, { count: number; newestMs: number }> | null> {
  const out = new Map<string, { count: number; newestMs: number }>();
  if (ids.length === 0) return out;
  try {
    const { data, error } = await sb
      .from('audit_log')
      .select('target_id, occurred_at')
      .eq('target_type', 'payment_authorization')
      .in('target_id', ids)
      .in('action', [...RECLAIM_FLAG_ACTIONS])
      .order('occurred_at', { ascending: false })
      .limit(2000);
    if (error) return null;
    for (const r of (data ?? []) as { target_id: string | null; occurred_at: string }[]) {
      if (!r.target_id) continue;
      const at = Date.parse(r.occurred_at);
      const prev = out.get(r.target_id) ?? { count: 0, newestMs: Number.NEGATIVE_INFINITY };
      out.set(r.target_id, { count: prev.count + 1, newestMs: Number.isFinite(at) ? Math.max(prev.newestMs, at) : prev.newestMs });
    }
    return out;
  } catch {
    return null;
  }
}

/** Audit action for a stale claim this environment cannot resolve. Surfaced by
 *  the /anomalies money lane (statuses.ts). */
export const RECLAIM_PROVIDER_UNREACHABLE_ACTION = 'payment.reclaim_provider_unreachable';

export type ReclaimRoute = 'revert' | 'reconcile' | 'unreachable';

const STRIPE_MODES = ['stripe_test', 'stripe_live'];

/**
 * What to do with one stale claim, from the ROW's recorded mode.
 *
 *   row stripe_*       reconcile iff this env resolves to the SAME mode; a test
 *                      key cannot see live transfers, so anything else is
 *                      unreachable.
 *   row paypal_*       unreachable — there is no PayPal reconciliation, and a
 *                      revert would let the payout be re-sent.
 *   row paper / unset  the column default, so "paper" may also mean "never
 *                      stamped" (a pre-stamp claim). Then:
 *                        - outcome-unknown marker → it WAS a Stripe call:
 *                          reconcile if this env is on Stripe, else unreachable.
 *                        - env on Stripe → reconcile (asking is always safe).
 *                        - env resolves to paper because paper is CONFIGURED →
 *                          revert (nothing real could have moved).
 *                        - env resolves to paper only as a FALLBACK (a Stripe or
 *                          PayPal mode is configured without working keys) →
 *                          unreachable: the claim may have been made while the
 *                          key worked.
 *                        - env on PayPal → reconcile (answers not_stripe; the
 *                          row stays for a human, as before).
 */
export function reclaimRoute(
  row: { payment_mode?: string | null; failure_reason?: string | null },
  envMode: string,
  configuredMode: string
): ReclaimRoute {
  const rowMode = row.payment_mode ?? 'paper';
  if (STRIPE_MODES.includes(rowMode)) return envMode === rowMode ? 'reconcile' : 'unreachable';
  if (rowMode !== 'paper') return 'unreachable';
  if (row.failure_reason === OUTCOME_UNKNOWN_REASON) return STRIPE_MODES.includes(envMode) ? 'reconcile' : 'unreachable';
  if (envMode !== 'paper') return 'reconcile';
  return configuredMode === 'paper' ? 'revert' : 'unreachable';
}

interface StaleRow {
  id: string;
  firm_id: string | null;
  campaign_id: string | null;
  creator_offer_id: string | null;
  executing_at: string | null;
  payment_mode?: string | null;
  failure_reason?: string | null;
}

export async function runPaymentReclaim(
  sb: SupabaseClient,
  opts: {
    now?: number;
    batchSize?: number;
    /** Injectable audit writer; default = real audit() (lazy import, same
     *  shape as measurement-tick.ts). Every reclaim is audited as
     *  `payment.reclaimed_stale` — that row is what puts it in the /anomalies
     *  payment_anomaly lane. A log line alone was invisible to the operator. */
    audit?: (e: AuditEntry) => Promise<void>;
    /** Injected Stripe lookup / clock / mode for reconciliation (tests). */
    reconcileDeps?: ReconcileDeps;
    /** PAYMENTS_MODE as configured, before fallbacks (tests). */
    configuredMode?: () => string;
  } = {},
): Promise<ReclaimTally> {
  const nowMs = opts.now ?? Date.now();
  const auditWrite =
    opts.audit ??
    (async (e: AuditEntry) => {
      const { audit } = await import('./audit');
      await audit(e);
    });
  const tally: ReclaimTally = { considered: 0, reclaimed: 0, reconciled: 0, unresolved: 0, unreachable: 0, backedOff: 0, errors: 0 };
  // The ACTIVE mode (platform setting under the env ceiling, migration 064):
  // a stale stripe_test claim is reconciled only while the platform runs Test,
  // and is otherwise left untouched for a human (reclaimRoute → unreachable).
  const mode = opts.reconcileDeps?.mode ? opts.reconcileDeps.mode() : (await resolveActivePaymentMode(sb)).mode;
  const configured = (opts.configuredMode ?? configuredPaymentMode)();
  const cutoff = new Date(nowMs - STALE_EXECUTING_MS).toISOString();

  // Matches the partial index migration 055 creates. Rows claimed BEFORE 055
  // have executing_at NULL and are deliberately left alone: without a timestamp
  // there is no way to know whether they are stranded or in flight, and guessing
  // on the money path is the wrong direction.
  const { data, error } = await sb
    .from('payment_authorizations')
    .select('id, firm_id, campaign_id, creator_offer_id, executing_at, payment_mode, failure_reason')
    .eq('status', 'executing')
    .not('executing_at', 'is', null)
    .lte('executing_at', cutoff)
    .limit(opts.batchSize ?? RECLAIM_BATCH_SIZE);

  if (error) {
    // Errors only on a database without migration 055. Visible, not fatal.
    log.warn('stale-executing query failed', { error: error.message });
    tally.errors += 1;
    return tally;
  }

  const stale = (data ?? []) as unknown as StaleRow[];
  const flags = await priorFlags(sb, stale.map((r) => r.id));
  if (!flags) log.warn('prior-flag lookup failed; no backoff this pass');

  for (const row of stale) {
    tally.considered += 1;
    const prior = flags?.get(row.id);
    if (prior && nowMs - prior.newestMs < reconcileBackoffMs(prior.count)) {
      tally.backedOff += 1;
      continue;
    }
    const route = reclaimRoute(row, mode, configured);
    if (route === 'unreachable') {
      // Leave the row exactly as it is — no marker, no revert, no provider
      // call — and put it in front of a human.
      tally.unreachable += 1;
      log.warn('stale claim on a rail this environment cannot reach; left untouched', {
        authorization_id: row.id,
        row_mode: row.payment_mode ?? null,
        env_mode: mode,
        configured_mode: configured,
      });
      try {
        await auditWrite({
          action: RECLAIM_PROVIDER_UNREACHABLE_ACTION,
          target_type: 'payment_authorization',
          target_id: row.id,
          firm_id: row.firm_id,
          actor_label: 'system:payment-reclaim',
          metadata: {
            campaign_id: row.campaign_id,
            creator_offer_id: row.creator_offer_id,
            claimed_at: row.executing_at,
            row_mode: row.payment_mode ?? null,
            env_mode: mode,
            configured_mode: configured,
            outcome_unknown: row.failure_reason === OUTCOME_UNKNOWN_REASON,
          },
        });
      } catch (e) {
        log.warn('unreachable audit failed', { authorization_id: row.id, error: (e as Error).message });
      }
      continue;
    }
    if (route === 'reconcile') {
      // Money may have moved. Ask the provider; never re-send blind.
      try {
        const r = await reconcilePaymentOutcome(sb, row.id, { system: true }, {
          now: () => new Date(nowMs),
          ...(opts.audit ? { audit: opts.audit as NonNullable<ReconcileDeps['audit']> } : {}),
          ...opts.reconcileDeps,
          mode: () => mode,
        });
        if (r.outcome === 'completed' || r.outcome === 'not_sent') tally.reconciled += 1;
        else if (r.outcome === 'still_unknown') tally.unresolved += 1;
        log.info('reconciled stale executing authorization', { authorization_id: row.id, ...r });
      } catch (e) {
        log.warn('reconcile failed', { authorization_id: row.id, error: (e as Error).message });
        tally.errors += 1;
      }
      continue;
    }
    // Conditional on the row still being the one we read. Postgres arbitrates,
    // so a pass that overlaps a genuine execution finishing cannot clobber it.
    const { data: reclaimed, error: uErr } = await sb
      .from('payment_authorizations')
      .update({
        status: 'approved',
        executing_at: null,
        failure_reason: 'reclaimed_stale_executing',
      } as never)
      .eq('id', row.id)
      .eq('status', 'executing')
      .select('id')
      .maybeSingle();
    if (uErr) {
      log.warn('reclaim failed', { authorization_id: row.id, error: uErr.message });
      tally.errors += 1;
      continue;
    }
    if (!reclaimed) continue;
    tally.reclaimed += 1;
    log.info('reclaimed stale executing authorization', {
      authorization_id: row.id,
      firm_id: row.firm_id,
      campaign_id: row.campaign_id,
      creator_offer_id: row.creator_offer_id,
      claimed_at: row.executing_at,
      stale_for_ms: row.executing_at ? nowMs - Date.parse(row.executing_at) : null,
    });
    try {
      await auditWrite({
        action: 'payment.reclaimed_stale',
        target_type: 'payment_authorization',
        target_id: row.id,
        firm_id: row.firm_id,
        actor_label: 'system:payment-reclaim',
        metadata: {
          campaign_id: row.campaign_id,
          creator_offer_id: row.creator_offer_id,
          claimed_at: row.executing_at,
          stale_for_ms: row.executing_at ? nowMs - Date.parse(row.executing_at) : null,
        },
      });
    } catch (e) {
      // The reclaim itself already happened; an audit gap must not undo it.
      log.warn('reclaim audit failed', { authorization_id: row.id, error: (e as Error).message });
    }
  }

  return tally;
}
