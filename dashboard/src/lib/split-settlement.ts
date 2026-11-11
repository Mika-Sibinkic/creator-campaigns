// src/lib/split-settlement.ts
//
// Half on agreement, half on a verified post — and an outside date that closes
// the deal by itself.
//
// THE PROBLEM IT SOLVES
//   The offer state machine paid in full before the deliverable existed:
//   approved → paid → posted → measured. Worse, the standard contract says the
//   creator accepts "by collecting the payment … or by publishing any
//   deliverable … whichever happens first" — so under that order the binding act
//   was taking the money, and nothing after it obliged anyone to post. At
//   micro-creator deal sizes litigation is not a remedy, so the
//   contract was never the protection. The payment order was, and it pointed the
//   wrong way.
//
// WHAT MAKES IT SAFE FOR THE LABEL, which is the part that matters
//   A split alone only halves the loss. What removes the work is that a miss
//   resolves itself. Every deal carries `deliver_by`, derived from the package
//   the creator agreed to and told to them at close. When it passes with no
//   verified post: the balance is never paid, the deal closes `undelivered`, the
//   committed budget is released, and the non-delivery is recorded against that
//   creator for that firm so the roster stops offering them work. Nobody sends a
//   reminder, nobody opens a collections queue, nobody is chased. The deposit is
//   the entire loss and its size is policy, not accident.
//
// WHY THE SPLIT IS CONFIGURABLE
//   50/50 is the convention in influencer deals, which is exactly why it is the
//   default — a creator reads it as normal rather than as distrust. It is not a
//   measured optimum. `firms.deposit_pct` exists so a label can take less
//   exposure without a code change, and so the tradeoff can eventually be
//   measured against close rate rather than argued.
//
// OFF BY DEFAULT. With `require_delivery_before_balance` false, every function
// here reports the single-payment behaviour the system has today. Nothing
// changes for an existing deal until a label opts in.
//
// Pure: no DB, no clock, no network. Every input is passed in.

import { maxWindowDays, normalizeDeliverables } from './deliverables';

/** Default share paid up front when the split is on. */
export const DEFAULT_DEPOSIT_PCT = 50;

/** Fallback outside date when a package somehow carries no window. */
export const DEFAULT_DELIVERY_WINDOW_DAYS = 14;

export interface SettlementPolicy {
  /** firms.require_delivery_before_balance */
  splitEnabled: boolean;
  /** firms.deposit_pct, clamped 0-100. */
  depositPct: number;
}

/** Read a policy off a firm row, tolerating nulls and out-of-range values. */
export function resolveSettlementPolicy(firm: {
  require_delivery_before_balance?: boolean | null;
  deposit_pct?: number | null;
} | null | undefined): SettlementPolicy {
  const raw = Number(firm?.deposit_pct);
  const pct = Number.isFinite(raw) ? Math.min(100, Math.max(0, Math.round(raw))) : DEFAULT_DEPOSIT_PCT;
  return {
    splitEnabled: firm?.require_delivery_before_balance === true,
    depositPct: pct,
  };
}

export interface SettlementLegs {
  /** Paid on approval. Equals the full amount when the split is off. */
  depositUsd: number;
  /** Paid after a verified post. Zero when the split is off. */
  balanceUsd: number;
}

/**
 * Split an agreed amount into the two legs.
 *
 * Rounds the DEPOSIT and derives the balance by subtraction, so the two legs
 * always sum to exactly the agreed amount — deriving both independently is how
 * you end up a cent short or over on the thing a creator is counting.
 */
export function settlementLegs(agreedUsd: number, policy: SettlementPolicy): SettlementLegs {
  const total = Math.max(0, Math.round((Number(agreedUsd) || 0) * 100) / 100);
  if (!policy.splitEnabled) {
    return { depositUsd: total, balanceUsd: 0 };
  }
  const deposit = Math.round(total * (policy.depositPct / 100) * 100) / 100;
  const clamped = Math.min(total, Math.max(0, deposit));
  return {
    depositUsd: clamped,
    balanceUsd: Math.round((total - clamped) * 100) / 100,
  };
}

/**
 * The outside date for a deal, as ms-epoch.
 *
 * Taken from the largest `delivery_window_days` in the package the creator
 * actually agreed to, so the deadline is something they consented to rather than
 * something imposed afterwards. That is what makes automatic expiry fair enough
 * to run unattended.
 */
export function deliverByMs(agreedAtMs: number, agreedDeliverables: unknown): number {
  const pkg = normalizeDeliverables(agreedDeliverables);
  const days = maxWindowDays(pkg) || DEFAULT_DELIVERY_WINDOW_DAYS;
  return agreedAtMs + days * 24 * 60 * 60 * 1000;
}

export type ExpiryAction =
  | { action: 'wait'; reason: string }
  | { action: 'expire'; reason: string };

/**
 * Should this deal close itself for non-delivery?
 *
 * Deliberately narrow. It fires only for a deal that took a deposit, has a
 * stated outside date, has passed it, and has no post recorded. Anything
 * ambiguous waits — a sweeper that guesses would be worse than one that misses,
 * because the failure mode is refusing to pay a creator who did deliver.
 */
export function evaluateExpiry(input: {
  status: string;
  deliverByMs: number | null;
  postUrl: string | null | undefined;
  /**
   * `deal_deliveries.status` for this offer, when there is a row.
   *
   * This is what separates "they posted" from "they pasted a string". The
   * measurement tick scrapes the creator's profile and only writes 'verified'
   * when it finds the post at that URL on that account; after bounded retries it
   * writes 'missing'. Passing that verdict in is what lets expiry distinguish a
   * pending check from a failed one.
   */
  deliveryStatus?: string | null;
  nowMs: number;
}): ExpiryAction {
  if (input.status !== 'deposit_paid') {
    return { action: 'wait', reason: `status ${input.status} is not awaiting delivery` };
  }
  // A post URL used to stop the clock on its own. That made the sweeper useless
  // against the one case it exists for: a creator who pastes ANY string parks the
  // deal in deposit_paid forever, the balance is never paid (money is safe), and
  // a human has to go look — which is precisely the queue the split was built to
  // eliminate. So the URL only stops the clock while the verdict is still open.
  const claimed = typeof input.postUrl === 'string' && input.postUrl.trim().length > 0;
  if (claimed && input.deliveryStatus !== 'missing') {
    return { action: 'wait', reason: 'a post was recorded — verification, not expiry, owns this' };
  }
  if (claimed && input.deliveryStatus === 'missing') {
    // The tick looked, repeatedly, and could not find the post at that URL on
    // that creator's account. That is a non-delivery with a URL attached, and it
    // still needs the agreed outside date to pass before it closes — the checks
    // below apply, deliberately, rather than short-circuiting to expire here.
  }
  if (input.deliverByMs == null) {
    return { action: 'wait', reason: 'no outside date stamped — never expire a deal nobody was told a deadline for' };
  }
  if (input.nowMs < input.deliverByMs) {
    return { action: 'wait', reason: 'still inside the delivery window' };
  }
  return { action: 'expire', reason: 'the agreed delivery window passed with no post' };
}

/**
 * Is the second half now owed?
 *
 * Pure, so the trigger for minting a balance authorization is testable next to
 * the expiry rule it mirrors. Both halves of the split are then decided by this
 * module rather than by whichever route happened to be touched last.
 *
 * `posted` is the gate, not `measured`: the deal reaches `posted` only after the
 * delivery is verified, and waiting for `measured` would hold a creator's money
 * hostage to a metrics snapshot they have no control over.
 */
export function balanceDue(offer: {
  status: string;
  deposit_paid_usd?: number | null;
  balance_paid_usd?: number | null;
}): boolean {
  if (offer.status !== 'posted') return false;
  // Never pay a balance on a deal that never took a deposit — that would be a
  // second full payment, not a second leg.
  if (offer.deposit_paid_usd == null) return false;
  return offer.balance_paid_usd == null;
}

/**
 * What the label is actually exposed to on one deal, for the UI and for the
 * confirmation shown before approving a payout.
 */
export function exposureUsd(legs: SettlementLegs): number {
  return legs.depositUsd;
}
