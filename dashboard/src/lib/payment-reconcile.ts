// src/lib/payment-reconcile.ts
//
// Resolve a payout whose outcome is UNKNOWN by asking Stripe.
//
// WHY THIS EXISTS
//   A network error, timeout, 5xx or idempotency conflict on the transfer call
//   was treated as a clean failure: the execute path wrote 'failed' (which a
//   Retry click re-claims), the onboarding webhook reverted to 'approved' (which
//   the NEXT account.updated re-sends with no human click), and the reclaimer
//   blind-reverted stale claims to 'approved'. All three re-send under the same
//   idempotency key — safe only inside Stripe's 24h key window, a second
//   transfer outside it.
//
//   Now stripe-isolated.ts classifies an ambiguous transfer as outcome_unknown,
//   and the callers leave the row 'executing' marked OUTCOME_UNKNOWN_REASON.
//   This module is the ONLY thing that moves such a row on, and it does so from
//   Stripe's own record: every transfer is created with
//   transfer_group = the payout idempotency key (<pa id>.<leg>), so
//   GET /v1/transfers?transfer_group=… either finds it or proves there is none.
//
// Outcomes:
//   completed      exactly one transfer, right amount, not reversed → the row is
//                  'completed' with that transfer id and the deal settles
//                  exactly as a live success would (offerSettlementUpdate).
//   not_sent       Stripe has NO transfer in the group → 'failed' +
//                  CONFIRMED_NOT_SENT_REASON: an ordinary retryable failure. A
//                  human Retry may now re-send; nothing re-sends on its own.
//   still_unknown  lookup failed, >1 transfer, amount mismatch, reversed, too
//                  soon to trust "not found", or not a Stripe mode → the row
//                  stays 'executing' + marked; a human looks.
//
// Callers: POST /api/anomalies/stripe-check (operator "Check with Stripe") and
// payment-reclaim.ts (stale claims). All Stripe HTTP stays in stripe-isolated.

import type { SupabaseClient } from '@supabase/supabase-js';
import { checkFirmScope } from './firm-scope';
import {
  CONFIRMED_NOT_SENT_REASON,
  OUTCOME_UNKNOWN_REASON,
  offerSettlementUpdate,
  payoutIdempotencyKey,
  type SettlementLeg,
} from './payment-claim';
import {
  lookupTransfersByGroup,
  resolveActivePaymentMode,
  type PaymentMode,
  type TransferLookupResult,
} from './stripe-isolated';

export type TransferLookup = TransferLookupResult;

/**
 * How long after the claim a "no transfer found" is trusted. A request that
 * timed out on our side can still be finishing at Stripe; minutes, not hours,
 * but never zero.
 */
export const MIN_NOT_FOUND_AGE_MS = 2 * 60_000;

/** Same threshold as payment-reclaim.STALE_EXECUTING_MS (a literal to keep the
 *  import graph one-way; tests pin them equal). A claim this old cannot still be
 *  in flight, so it is reconcilable even without the outcome-unknown marker. */
const STALE_CLAIM_MS = 15 * 60_000;

export interface ReconcileDeps {
  lookup?: (transferGroup: string) => Promise<TransferLookup>;
  audit?: (e: {
    action: string;
    target_type: string;
    target_id: string;
    firm_id?: string | null;
    actor_label?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  sendPromoMaterials?: (sb: SupabaseClient, opts: { creatorOfferId: string }) => Promise<unknown>;
  now?: () => Date;
  mode?: () => PaymentMode;
}

export type StillUnknownReason =
  | 'lookup_failed'
  | 'multiple_transfers'
  | 'amount_mismatch'
  | 'transfer_reversed'
  | 'too_soon'
  | 'not_stripe'
  | 'provider_unreachable';

export type ReconcileOutcome =
  | { outcome: 'completed'; transferId: string }
  | { outcome: 'not_sent' }
  | { outcome: 'still_unknown'; reason: StillUnknownReason; detail?: string }
  | { outcome: 'not_applicable'; status: string | null }
  | { outcome: 'not_found' }
  | { outcome: 'forbidden' };

/** `callerFirmId` for a human caller (fail-closed scope); `system` for the reclaimer. */
export type ReconcileScope = { callerFirmId: string | null | undefined } | { system: true };

interface PaRow {
  id: string;
  firm_id: string;
  status: string;
  creator_offer_id: string;
  amount_usd: number;
  leg?: SettlementLeg | null;
  executing_at?: string | null;
  created_at?: string | null;
  failure_reason: string | null;
  /** Migration 015: the rail this row was sent on (stamped with the claim). */
  payment_mode?: string | null;
}

export async function reconcilePaymentOutcome(
  sb: SupabaseClient,
  id: string,
  scope: ReconcileScope,
  deps: ReconcileDeps = {}
): Promise<ReconcileOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const auditWrite =
    deps.audit ??
    (async (e: Parameters<NonNullable<ReconcileDeps['audit']>>[0]) => {
      const { audit } = await import('./audit');
      await audit(e as never);
    });

  const load = (withLeg: boolean) =>
    sb
      .from('payment_authorizations')
      .select(
        `id, firm_id, status, creator_offer_id, amount_usd, failure_reason, created_at, payment_mode${withLeg ? ', leg, executing_at' : ''}`
      )
      .eq('id', id)
      .maybeSingle();
  let { data, error } = await load(true);
  if (error) ({ data, error } = await load(false));
  if (error || !data) return { outcome: 'not_found' };
  const p = data as unknown as PaRow;

  if ('callerFirmId' in scope) {
    const s = checkFirmScope(scope.callerFirmId, p.firm_id);
    if (!s.ok) return { outcome: 'forbidden' };
  }
  if (p.status !== 'executing') return { outcome: 'not_applicable', status: p.status };

  const marked = p.failure_reason === OUTCOME_UNKNOWN_REASON;
  const claimedAt = Date.parse(p.executing_at ?? p.created_at ?? '');
  const ageMs = Number.isFinite(claimedAt) ? now.getTime() - claimedAt : Number.POSITIVE_INFINITY;
  // An unmarked claim younger than the stale threshold may be a live execution:
  // it is not ours to resolve.
  if (!marked && ageMs < STALE_CLAIM_MS) return { outcome: 'not_applicable', status: p.status };

  const leg: SettlementLeg = p.leg ?? 'full';
  const group = payoutIdempotencyKey({ id: p.id, leg });
  const base = {
    target_type: 'payment_authorization',
    target_id: p.id,
    firm_id: p.firm_id,
    actor_label: 'system:payment-reconcile',
  };
  const meta = { creator_offer_id: p.creator_offer_id, leg, amount_usd: p.amount_usd, transfer_group: group };

  // Keep the row findable by the anomaly lane with the right copy.
  const markUnknown = async () => {
    if (marked) return;
    await sb
      .from('payment_authorizations')
      .update({ failure_reason: OUTCOME_UNKNOWN_REASON } as never)
      .eq('id', p.id)
      .eq('status', 'executing');
  };
  const stillUnknown = async (reason: StillUnknownReason, detail?: string, auditMismatch = false): Promise<ReconcileOutcome> => {
    await markUnknown();
    if (auditMismatch) {
      await auditWrite({ ...base, action: 'payment.reconcile_mismatch', metadata: { ...meta, reason, detail: detail ?? null } });
    }
    return { outcome: 'still_unknown', reason, ...(detail ? { detail } : {}) };
  };

  // The ACTIVE mode (platform setting under the env ceiling, migration 064).
  const mode = deps.mode ? deps.mode() : (await resolveActivePaymentMode(sb)).mode;
  // Act on the rail the ROW was sent on, not the one this environment resolves
  // to now. A test key cannot see live transfers (and vice versa), so asking the
  // wrong account returns "no transfer" for a payment that may well exist — and
  // not_sent makes it retryable. A PayPal row has nothing to ask Stripe about.
  // Left exactly as it is: no marker, no audit, no status change.
  const rowMode = p.payment_mode ?? null;
  if (rowMode === 'paypal_sandbox' || rowMode === 'paypal_live') {
    return { outcome: 'still_unknown', reason: 'not_stripe', detail: `this payment was sent via ${rowMode}` };
  }
  if ((rowMode === 'stripe_test' || rowMode === 'stripe_live') && rowMode !== mode) {
    return {
      outcome: 'still_unknown',
      reason: 'provider_unreachable',
      detail: `sent in ${rowMode}; this environment resolves to ${mode}`,
    };
  }
  if (mode !== 'stripe_test' && mode !== 'stripe_live') {
    return { outcome: 'still_unknown', reason: 'not_stripe', detail: `payments mode is ${mode}` };
  }

  const found = await (deps.lookup ?? ((g: string) => lookupTransfersByGroup(g, mode)))(group);
  if (!found.ok) return stillUnknown('lookup_failed', found.error);

  if (found.transfers.length === 0) {
    if (ageMs < MIN_NOT_FOUND_AGE_MS) return stillUnknown('too_soon');
    const { data: moved } = await sb
      .from('payment_authorizations')
      .update({ status: 'failed', failure_reason: CONFIRMED_NOT_SENT_REASON, executed_at: now.toISOString() } as never)
      .eq('id', p.id)
      .eq('status', 'executing')
      .select('id')
      .maybeSingle();
    if (!moved) return { outcome: 'not_applicable', status: null };
    await auditWrite({ ...base, action: 'payment.reconciled_not_sent', metadata: meta });
    return { outcome: 'not_sent' };
  }
  if (found.transfers.length > 1) {
    return stillUnknown('multiple_transfers', found.transfers.map((t) => t.id).join(','), true);
  }
  const t = found.transfers[0];
  if (t.reversed || t.amount_reversed_minor > 0) {
    return stillUnknown('transfer_reversed', t.id, true);
  }
  const expectedMinor = Math.round(Number(p.amount_usd) * 100);
  if (t.amount_minor !== expectedMinor) {
    return stillUnknown('amount_mismatch', `${t.id}: ${t.amount_minor} vs ${expectedMinor}`, true);
  }

  // Exactly the transfer this row asked for. Settle it the way a live success
  // does — compare-and-set on the claim, once-only on the deal.
  const nowIso = now.toISOString();
  const { data: done } = await sb
    .from('payment_authorizations')
    .update({ status: 'completed', payment_provider_id: t.id, failure_reason: null, executed_at: nowIso } as never)
    .eq('id', p.id)
    .eq('status', 'executing')
    .select('id')
    .maybeSingle();
  if (!done) return { outcome: 'not_applicable', status: null };
  const settle = offerSettlementUpdate(leg, Number(p.amount_usd), nowIso);
  await sb
    .from('creator_offers')
    .update(settle.patch as never)
    .eq('id', p.creator_offer_id)
    .is(settle.onceOnlyColumn, null);
  await auditWrite({ ...base, action: 'payment.reconciled_completed', metadata: { ...meta, transfer_id: t.id } });
  if (settle.sendMaterials) {
    const send =
      deps.sendPromoMaterials ??
      (async (s: SupabaseClient, o: { creatorOfferId: string }) => {
        const { sendPromoMaterials } = await import('./promo-materials');
        return sendPromoMaterials(s, o);
      });
    await send(sb, { creatorOfferId: p.creator_offer_id });
  }
  return { outcome: 'completed', transferId: t.id };
}
