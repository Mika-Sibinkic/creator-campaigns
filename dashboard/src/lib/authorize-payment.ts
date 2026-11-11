// src/lib/authorize-payment.ts
//
// The authorize-route core, extracted so the decision table is testable
// without an HTTP harness — same shape as src/lib/execute-payment.ts
// (`(sb, input, hooks) -> { httpStatus, body }`), and the same
// dependency-injection seam as `webhookCapGate` in src/lib/spend-caps.ts:
// `audit` arrives as a hook so a test can assert on it without importing
// src/lib/audit.ts (which pulls in next/headers + Clerk and is not
// importable from a plain tsx script).
//
// What this creates: one `payment_authorizations` row in
// 'pending_human_review' for a creator_offer that has reached
// 'human_approval_required'. That row is the head of the money path — a human
// then approves it, and since #25 approval auto-executes a real transfer. So
// minting one is a privileged act, and this module treats it as one.
//
// Guards, in order:
//   1. offer must exist                                 → 404
//   2. caller's firm must own the offer (checkFirmScope) → 401/403
//   3. offer.status === 'human_approval_required'        → 409
//   4. agreed_amount_usd present and > 0                 → 400
//   5. agreed_amount_usd <= ceiling_usd                  → 400
//
// The firm check sits immediately after the load and before every state
// check, mirroring the approve/reject routes, so a cross-firm caller cannot
// use the 400/409 responses to probe another firm's offer states.
//
// Never a blind upsert: a first mint is an INSERT (the (creator_offer_id, leg)
// unique index, migration 055, arbitrates racing first mints), and any write to
// an existing row is an UPDATE compare-and-set on its id and the state that was
// read. A double-click is idempotent; a leg that moved in between is 409.

import type { SupabaseClient } from '@supabase/supabase-js';
import { checkFirmScope, firmScopeErrorBody } from './firm-scope';
// These two have had no production caller since 052 shipped them — this file is
// the first. Until now `amount_usd` was always the full agreed amount, so the
// split governed neither what was reserved nor what was paid.
import { resolveSettlementPolicy, settlementLegs, balanceDue } from './split-settlement';
import { approvalQueueGap, legStoppedByHuman } from './payment-legs';

export interface AuthorizePaymentOutcome {
  httpStatus: number;
  body: Record<string, unknown>;
}

export interface AuthorizePaymentInput {
  /** The creator_offer to mint an authorization for. */
  creatorOfferId: string;
  /**
   * Firm of the AUTHENTICATED caller. Required — pass `session.firm_id`.
   * null/undefined/'' are refusals, never wildcards.
   */
  callerFirmId: string | null | undefined;
  /** Clerk user id of the caller, recorded as the audit actor. */
  actorUserId?: string | null;
  /**
   * Which settlement leg to reserve. Omitted means "the first one": `full` for a
   * firm with the split off, `deposit` for a firm with it on. `balance` is
   * passed only by the post-verification path, which is the one caller allowed
   * to reserve the second half.
   */
  leg?: SettlementLeg;
  /**
   * The operator explicitly asked to re-create a leg a PERSON stopped
   * (reject / revoke / cancel). Without it such a leg is never overwritten —
   * no automatic path (negotiation automint, the post route's balance mint)
   * may undo a human's stop. Set only by remintPaymentForOffer on an explicit
   * request.
   */
  reopenStopped?: boolean;
}

/** Injected side effects, so the core stays hermetic under test. */
export interface AuthorizePaymentHooks {
  audit: (entry: {
    action: string;
    target_type: string;
    target_id: string;
    firm_id?: string | null;
    actor_user_id?: string | null;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
}

interface OfferRow {
  id: string;
  campaign_id: string;
  firm_id: string;
  status: string;
  agreed_amount_usd: number | null;
  ceiling_usd: number;
  deposit_paid_usd: number | null;
  balance_paid_usd: number | null;
}

/**
 * Which settlement leg to reserve.
 *
 * `full` is the pre-split behaviour and what a firm with the split turned off
 * always gets. `deposit` and `balance` only ever appear for a firm with
 * `require_delivery_before_balance = true`, and they are separate ROWS because
 * migration 009's `human_approval_required_for_execute` CHECK means a row may
 * only execute while it carries its own `human_approved_at` — reusing one row
 * would pay the balance under the deposit's approval.
 */
export type SettlementLeg = 'full' | 'deposit' | 'balance';

/** Offer states each leg may be minted from. */
const LEG_REQUIRED_OFFER_STATUS: Record<SettlementLeg, readonly string[]> = {
  full: ['human_approval_required'],
  deposit: ['human_approval_required'],
  // The balance is only reservable once the post exists and has been verified.
  // That is the whole point of the split: the second half is contingent on the
  // deliverable, so its authorization cannot predate it.
  balance: ['posted'],
};

export async function authorizePaymentForOffer(
  sb: SupabaseClient,
  input: AuthorizePaymentInput,
  hooks: AuthorizePaymentHooks
): Promise<AuthorizePaymentOutcome> {
  const { data: offer, error: oErr } = await sb
    .from('creator_offers')
    .select(
      'id, campaign_id, firm_id, status, agreed_amount_usd, ceiling_usd, deposit_paid_usd, balance_paid_usd'
    )
    .eq('id', input.creatorOfferId)
    .single();
  if (oErr || !offer) {
    return { httpStatus: 404, body: { error: 'creator_offer_not_found' } };
  }
  const o = offer as unknown as OfferRow;

  // SEC: firm scope. Before this existed, any authenticated member of ANY
  // firm could mint an authorization row against another firm's offer and
  // drop it into that firm's approval queue. The edge session gate cannot
  // catch this — it only knows the caller is a member of *something*.
  const scope = checkFirmScope(input.callerFirmId, o.firm_id);
  if (!scope.ok) {
    return { httpStatus: scope.httpStatus, body: firmScopeErrorBody(scope) };
  }

  // Which leg is being reserved. Resolved from the FIRM's policy, not the
  // request — the caller chooses which offer, never how the money is split.
  const { data: firmRow } = await sb
    .from('firms')
    .select('require_delivery_before_balance, deposit_pct')
    .eq('id', o.firm_id)
    .maybeSingle();
  const policy = resolveSettlementPolicy(
    firmRow as { require_delivery_before_balance?: boolean | null; deposit_pct?: number | null } | null
  );
  // What the deposit ACTUALLY paid, as recorded when it settled
  // (offerSettlementUpdate). Null/0 = no deposit on record.
  const depositPaidUsd = Number(o.deposit_paid_usd ?? 0) > 0 ? Number(o.deposit_paid_usd) : null;
  // Split off → one 'full' leg, which is exactly the pre-split behaviour.
  // Split on → 'deposit' unless the caller is explicitly minting the balance.
  // EXCEPT: a balance asked for on a deal whose deposit already left is a
  // balance, whatever the policy says now. The firm turning the split off after
  // paying a deposit used to force 'full' here and 409 on the 'posted' deal —
  // the remaining money was owed and could never be minted.
  const leg: SettlementLeg =
    input.leg === 'balance' && depositPaidUsd != null
      ? 'balance'
      : !policy.splitEnabled
        ? 'full'
        : (input.leg ?? 'deposit');

  const allowed = LEG_REQUIRED_OFFER_STATUS[leg];
  if (!allowed.includes(o.status)) {
    return {
      httpStatus: 409,
      body: { error: 'invalid_state', status: o.status, expected: allowed.join('|'), leg },
    };
  }
  if (!o.agreed_amount_usd || o.agreed_amount_usd <= 0) {
    return { httpStatus: 400, body: { error: 'no_agreed_amount' } };
  }
  if (o.agreed_amount_usd > o.ceiling_usd) {
    return { httpStatus: 400, body: { error: 'agreed_above_ceiling' } };
  }

  if (leg === 'balance' && depositPaidUsd == null) {
    // A balance on a deal that never took a deposit is a second FULL payment,
    // not a second leg (same rule as split-settlement.balanceDue).
    return { httpStatus: 409, body: { error: 'no_deposit_paid', leg } };
  }
  // The balance is what is LEFT of the agreed amount after what the deposit
  // actually paid — never recomputed from the firm's CURRENT deposit_pct. The
  // pct can change between the two legs (50% →
  // 20% after a $50 deposit minted an $80 balance on a $100 deal). Never
  // negative; a deposit that already covered the deal leaves nothing to mint.
  const amountUsd =
    leg === 'balance'
      ? Math.max(0, Math.round((o.agreed_amount_usd - (depositPaidUsd ?? 0)) * 100) / 100)
      : settlementLegs(o.agreed_amount_usd, policy).depositUsd;
  if (amountUsd <= 0) {
    // A zero leg is not an error worth a 500, but it must never become a
    // provider call. deposit_pct 0 or 100 makes one leg empty by design.
    return { httpStatus: 409, body: { error: 'leg_has_no_amount', leg, amount_usd: amountUsd } };
  }
  if (leg === 'balance' && o.balance_paid_usd != null) {
    return { httpStatus: 409, body: { error: 'balance_already_paid', leg } };
  }

  // Never resurrect a live leg: an approved, executing or completed row — or a
  // failed one with a transfer on file — is a payment that is moving or has
  // moved (and a later execute would reuse its idempotency key).
  //
  // Nor a leg a PERSON stopped, unless the operator explicitly asked
  // (input.reopenStopped). Before this, the post route's automatic balance mint
  // silently turned a reviewer's reject back into a pending payment.
  //
  // This read decides WHICH write follows, never whether that write is safe:
  // every write below is compare-and-set on what was read. The old blind upsert on (creator_offer_id, leg) meant
  // a human approving the pending row and execute claiming it between this read
  // and that write had their EXECUTING row reset to pending_human_review with
  // the approval wiped — mid-transfer.
  const legsQ = (withLeg: boolean) => {
    const q = sb
      .from('payment_authorizations')
      .select('id, status, payment_provider_id, failure_reason, amount_usd, human_approved_at, human_approved_by_user_id')
      .eq('creator_offer_id', o.id);
    return withLeg ? q.eq('leg', leg) : q;
  };
  let { data: existing, error: exErr } = await legsQ(true);
  const pre055Read = !!exErr;
  if (exErr) ({ data: existing, error: exErr } = await legsQ(false));
  if (exErr) return { httpStatus: 503, body: { error: 'existing_leg_check_failed' } };
  const rows = (existing ?? []) as ExistingLegRow[];
  const inFlight = (r: ExistingLegRow): AuthorizePaymentOutcome => ({
    httpStatus: 409,
    body: { error: 'leg_in_flight', leg, status: r.status, payment_authorization_id: r.id },
  });
  const live = rows.find(isLiveLeg);
  if (live) return inFlight(live);
  const stopped = rows.find((r) => legStoppedByHuman(r));
  if (stopped && !input.reopenStopped) {
    return {
      httpStatus: 409,
      body: {
        error: 'leg_stopped',
        leg,
        status: stopped.status,
        payment_authorization_id: stopped.id,
        guidance: LEG_STOPPED_GUIDANCE,
      },
    };
  }
  // One row per (creator_offer, leg) since 055 (one per offer before it).
  const current = rows[0] ?? null;
  // The row this mint replaces, when it is not the pending double-click: a dead
  // failure or an explicitly reopened stop. Kept for the audit below.
  const replaced = current && current.status !== 'pending_human_review' ? current : null;

  // firm_id / amount are taken from the OFFER and the firm's policy, never from
  // the request body — the caller chooses which offer, never whose firm or how
  // much.
  //
  // A mint over an existing (failed / reopened) row is a NEW payment awaiting a
  // NEW approval, so the old approval stamp and failure are cleared in the same
  // write. Keeping the stamp is what made this 500: migration 009's
  // human_approval_required_for_execute admits 'pending_human_review' only with
  // human_approved_at IS NULL. It is also the gate — the old approval was given
  // for a different amount and must not carry over. Who approved the replaced
  // row, and when, is kept in this action's append-only audit below.
  const base = {
    creator_offer_id: o.id,
    campaign_id: o.campaign_id,
    firm_id: o.firm_id,
    amount_usd: amountUsd,
    currency: 'usd',
    status: 'pending_human_review',
    payment_provider: 'stripe',
    human_approved_at: null,
    human_approved_by_user_id: null,
    failure_reason: null,
  };
  let pa: Record<string, unknown>;
  if (current) {
    // An existing row (the pending double-click, a dead failure, a reopened
    // stop): UPDATE conditioned on its id AND the exact state just read —
    // status, failure_reason, no transfer on file, and for a pending row still
    // no approval. Anything that moved it in between (an approval, an execute
    // claim, a stop, a transfer) matches zero rows → 409 leg_in_flight, and the
    // row is left exactly as the other writer left it. The approval is cleared
    // only by a write that actually matched the dead/stopped/pending row.
    let q = sb
      .from('payment_authorizations')
      .update(base as never)
      .eq('id', current.id)
      .eq('status', current.status)
      .is('payment_provider_id', null);
    q = current.failure_reason == null ? q.is('failure_reason', null) : q.eq('failure_reason', current.failure_reason);
    if (current.status === 'pending_human_review') q = q.is('human_approved_at', null);
    const { data: updated, error: uErr } = await q.select().maybeSingle();
    if (uErr) return { httpStatus: 500, body: { error: uErr.message ?? 'update_failed' } };
    if (!updated) return inFlight((await readLeg(sb, o.id, leg, pre055Read)) ?? current);
    pa = updated as Record<string, unknown>;
  } else {
    // First mint: a plain INSERT. The (creator_offer_id, leg) unique index
    // (migration 055; UNIQUE(creator_offer_id) before it) arbitrates two racing
    // first mints: the loser gets 23505 and reads the winner — a pending winner
    // is the double-click (200, the same row), anything else is in flight.
    let ins = await sb.from('payment_authorizations').insert({ ...base, leg } as never).select().single();
    // Migration 055 is what creates `leg`. Until it is applied the leg-aware
    // insert fails on the unknown column, and an authorization route that 500s
    // is worse than one that behaves the way it did before the split — the
    // deploy is a manual CLI upload, so the order is easy to get wrong. Fall
    // back to the legacy single-authorization shape, loudly: pre-split
    // behaviour, and a split-ON firm gets the deposit under a 'full'-shaped row
    // (under-reserves, never over-pays). ONLY on the pre-055 shape — any other
    // error (a CHECK violation, say) is real and is returned.
    if (ins.error && isPre055Error(ins.error)) {
      const legacyIns = await sb.from('payment_authorizations').insert(base as never).select().single();
      if (!legacyIns.error && legacyIns.data) {
        console.warn(
          '[authorize-payment] leg-aware insert failed; fell back to the pre-055 shape. ' +
            'Apply supabase/migrations/055_settlement_authorization_legs.sql to enable split settlement.',
          { leg, error: ins.error.message }
        );
      }
      ins = legacyIns;
    }
    if (ins.error && isUniqueViolation(ins.error)) {
      const winner = await readLeg(sb, o.id, leg, pre055Read);
      if (winner && winner.status === 'pending_human_review' && !winner.payment_provider_id) {
        return { httpStatus: 200, body: winner as unknown as Record<string, unknown> };
      }
      return winner ? inFlight(winner) : { httpStatus: 409, body: { error: 'leg_in_flight', leg } };
    }
    if (ins.error || !ins.data) {
      return { httpStatus: 500, body: { error: ins.error?.message ?? 'insert_failed' } };
    }
    pa = ins.data as Record<string, unknown>;
  }

  await hooks.audit({
    action: 'payment.authorization_created',
    target_type: 'payment_authorization',
    target_id: (pa as { id: string }).id,
    firm_id: o.firm_id,
    // Attribution: this row starts the money path, so it records who asked
    // for it. Before the auth fix there was no caller identity to record.
    actor_user_id: input.actorUserId ?? null,
    metadata: {
      creator_offer_id: o.id,
      amount_usd: o.agreed_amount_usd,
      leg_amount_usd: amountUsd,
      leg,
      authorized_by_user_id: input.actorUserId ?? null,
      ...(input.reopenStopped ? { reopened_stopped: true } : {}),
      // The row this mint overwrote, including the approval it cleared.
      ...(replaced
        ? {
            replaced: {
              payment_authorization_id: replaced.id,
              prior_status: replaced.status,
              prior_failure_reason: replaced.failure_reason ?? null,
              prior_amount_usd: replaced.amount_usd ?? null,
              prior_approval: {
                human_approved_at: replaced.human_approved_at ?? null,
                human_approved_by_user_id: replaced.human_approved_by_user_id ?? null,
              },
            },
          }
        : {}),
    },
  });

  return { httpStatus: 200, body: pa as Record<string, unknown> };
}

interface ExistingLegRow {
  id: string;
  status: string;
  payment_provider_id: string | null;
  failure_reason?: string | null;
  amount_usd?: number | string | null;
  human_approved_at?: string | null;
  human_approved_by_user_id?: string | null;
}

/** Operator copy for a leg a person stopped. Names the one path that reopens it. */
export const LEG_STOPPED_GUIDANCE =
  'Nothing was created: a person stopped this payment on purpose. To pay it anyway, use “Re-create stopped payment” on the deal; it goes back to Approvals and needs a fresh approval.';

/** Approved, executing, completed — or anything with a transfer on file. */
function isLiveLeg(r: { status: string; payment_provider_id: string | null }): boolean {
  return ['approved', 'executing', 'completed'].includes(r.status) || !!r.payment_provider_id;
}

/** Re-read one leg after a lost compare-and-set or insert race. */
async function readLeg(
  sb: SupabaseClient,
  offerId: string,
  leg: SettlementLeg,
  pre055: boolean
): Promise<ExistingLegRow | null> {
  const q = sb.from('payment_authorizations').select('*').eq('creator_offer_id', offerId);
  const { data } = await (pre055 ? q : q.eq('leg', leg));
  return ((data ?? []) as ExistingLegRow[])[0] ?? null;
}

/**
 * Is this the error a pre-055 database gives the leg-aware insert? 42703 =
 * undefined column (`leg`). Matched on message too, for clients that drop the
 * code.
 */
function isPre055Error(e: { message?: string; code?: string }): boolean {
  if (e.code === '42703') return true;
  return /column .*leg.* does not exist/i.test(e.message ?? '');
}

/** 23505: the (creator_offer_id, leg) unique index refused a second row. */
function isUniqueViolation(e: { message?: string; code?: string }): boolean {
  return e.code === '23505' || /duplicate key value violates unique constraint/i.test(e.message ?? '');
}

/** Audit hook shape shared by the two helpers below. */
type MintHooks = AuthorizePaymentHooks;

export interface MintBalanceOutcome {
  minted: boolean;
  /** True when no balance was due — not a failure, nothing audited. */
  skipped?: boolean;
  httpStatus?: number;
  body?: Record<string, unknown>;
}

/**
 * The post route's balance mint, extracted so its failure handling is
 * executable. The post IS logged by the time this runs, so it never throws;
 * but a mint that did not happen must never be silent (a non-2xx from authorizePaymentForOffer was stored in the
 * response and dropped, and the balance stranded with nothing in /approvals).
 * Any non-200 or throw is audited as payment.balance_authorization_failed —
 * which the /anomalies money lane shows with a "Create payment for approval"
 * action (remintPaymentForOffer).
 */
export async function mintBalanceAfterPost(
  sb: SupabaseClient,
  input: {
    offer: { id: string; firm_id: string; campaign_id: string; deposit_paid_usd: number | null; balance_paid_usd: number | null };
    callerFirmId: string;
    actorUserId: string | null;
  },
  hooks: MintHooks
): Promise<MintBalanceOutcome> {
  const o = input.offer;
  if (!balanceDue({ ...o, status: 'posted' })) return { minted: false, skipped: true };
  const fail = async (metadata: Record<string, unknown>) => {
    await hooks.audit({
      action: 'payment.balance_authorization_failed',
      target_type: 'creator_offer',
      target_id: o.id,
      firm_id: o.firm_id,
      actor_user_id: input.actorUserId,
      metadata: { campaign_id: o.campaign_id, leg: 'balance', ...metadata },
    });
  };
  try {
    const minted = await authorizePaymentForOffer(
      sb,
      { creatorOfferId: o.id, callerFirmId: input.callerFirmId, actorUserId: input.actorUserId, leg: 'balance' },
      hooks
    );
    if (minted.httpStatus !== 200) {
      await fail({ http_status: minted.httpStatus, error: minted.body.error ?? null, response: minted.body });
      return { minted: false, httpStatus: minted.httpStatus, body: minted.body };
    }
    return { minted: true, httpStatus: 200, body: minted.body };
  } catch (e) {
    await fail({ http_status: null, error: (e as Error).message });
    return { minted: false };
  }
}

/**
 * "Create payment for approval": re-mint the payment a deal is waiting on when
 * the automatic mint failed (negotiation automint, or the post route's balance
 * mint). Minting is not money — the new row lands in /approvals at
 * pending_human_review and a human approval still stands before any transfer.
 *
 * Decides nothing on its own: payment-legs.approvalQueueGap says whether there
 * is a gap and which leg fills it, the same helper the deal row uses to show
 * the button. No gap → 409 (already_queued when a live leg exists, else
 * nothing_to_mint). The mint itself is authorizePaymentForOffer, with every
 * guard it has (firm scope, state, amounts, the live-leg guard above).
 */
export async function remintPaymentForOffer(
  sb: SupabaseClient,
  input: {
    offerId: string;
    callerFirmId: string | null | undefined;
    actorUserId: string | null;
    /** Explicit operator request to re-create a leg a person stopped. */
    reopenStopped?: boolean;
  },
  hooks: MintHooks
): Promise<AuthorizePaymentOutcome> {
  const { data: offer, error: oErr } = await sb
    .from('creator_offers')
    .select('id, firm_id, campaign_id, status, deposit_paid_usd, balance_paid_usd')
    .eq('id', input.offerId)
    .maybeSingle();
  if (oErr) return { httpStatus: 503, body: { error: 'offer_lookup_failed' } };
  if (!offer) return { httpStatus: 404, body: { error: 'creator_offer_not_found' } };
  const o = offer as { id: string; firm_id: string; campaign_id: string; status: string; deposit_paid_usd: number | null; balance_paid_usd: number | null };
  const scope = checkFirmScope(input.callerFirmId, o.firm_id);
  if (!scope.ok) return { httpStatus: scope.httpStatus, body: firmScopeErrorBody(scope) };

  const legsQ = (withLeg: boolean) =>
    sb
      .from('payment_authorizations')
      .select(`id, status, failure_reason, payment_provider_id, human_approved_at${withLeg ? ', leg' : ''}`)
      .eq('creator_offer_id', o.id);
  let { data: legRows, error: lErr } = await legsQ(true);
  if (lErr) ({ data: legRows, error: lErr } = await legsQ(false));
  if (lErr) return { httpStatus: 503, body: { error: 'legs_lookup_failed' } };
  const legs = (legRows ?? []) as unknown as { id: string; leg?: string | null; status: string; failure_reason: string | null; payment_provider_id: string | null; human_approved_at?: string | null }[];

  const reopenStopped = input.reopenStopped === true;
  const gap = approvalQueueGap(o, legs, { reopenStopped });
  if (!gap) {
    // A leg a person stopped: say so, and name the explicit path, rather than
    // the misleading "not waiting on a payment".
    if (!reopenStopped && approvalQueueGap(o, legs, { reopenStopped: true })) {
      return { httpStatus: 409, body: { error: 'leg_stopped', guidance: LEG_STOPPED_GUIDANCE } };
    }
    const queued = legs.some((l) => ['pending_human_review', 'approved', 'executing'].includes(l.status));
    return {
      httpStatus: 409,
      body: queued
        ? { error: 'already_queued', guidance: 'A payment for this deal is already in Approvals (or on its way). Nothing was created.' }
        : { error: 'nothing_to_mint', status: o.status, guidance: 'This deal is not waiting on a payment, so nothing was created.' },
    };
  }
  const minted = await authorizePaymentForOffer(
    sb,
    {
      creatorOfferId: o.id,
      callerFirmId: input.callerFirmId,
      actorUserId: input.actorUserId,
      ...(gap === 'balance' ? { leg: 'balance' as const } : {}),
      ...(reopenStopped ? { reopenStopped: true } : {}),
    },
    hooks
  );
  await hooks.audit({
    action: 'payment.reminted',
    target_type: 'creator_offer',
    target_id: o.id,
    firm_id: o.firm_id,
    actor_user_id: input.actorUserId,
    metadata: { gap, http_status: minted.httpStatus, error: minted.body.error ?? null, reopened_stopped: reopenStopped },
  });
  return minted;
}
