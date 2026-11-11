// src/app/campaigns/[id]/deals/funnel-labels.ts
//
// creator_offers.status → the words a label manager reads, in ONE place.
//
// The same eleven states were spelled out three times: the badge map on
// /campaigns/[id]/deals, a lowercase copy on /campaigns/[id] (for the "3
// awaiting approval · 2 countered" strip), and nothing at all on the thread
// page — which rendered the raw enum, so a manager saw `human_approval_required`
// and `counter_offered` on screen.
//
// `label` is the badge wording, `short` is the inline-sentence wording (the
// strip reads "3 awaiting approval", not "3 Approved — ready to pay"), and
// `classes` is the badge tone. Anything unmapped de-snakes rather than showing
// an enum, because a state we forgot is still not a machine value.
//
// Pure module: no React, no I/O.

export interface FunnelState {
  /** Badge wording. */
  label: string;
  /** Inline wording, lowercase, for "N <short>" sentences. */
  short: string;
  /** Badge tone. Neutral unless the manager must act (amber), a payout
   *  failed (red) or money landed (green). */
  classes: string;
}

// Sourced from the state graph in src/lib/negotiation.ts.
export const FUNNEL_STATES: Record<string, FunnelState> = {
  queued: {
    label: 'Queued',
    short: 'queued',
    classes: 'bg-status-sourced text-status-sourced-fg border-transparent',
  },
  offered: {
    label: 'Offered',
    short: 'offered',
    classes: 'bg-status-sourced text-status-sourced-fg border-transparent',
  },
  counter_offered: {
    label: 'Counter received',
    short: 'countered',
    classes: 'bg-status-payout-pending text-status-payout-pending-fg border-transparent',
  },
  agreed: {
    label: 'Agreed',
    short: 'agreed',
    classes: 'bg-status-sourced text-status-sourced-fg border-transparent',
  },
  human_approval_required: {
    label: 'Awaiting approval',
    short: 'awaiting approval',
    classes: 'bg-status-payout-pending text-status-payout-pending-fg border-transparent',
  },
  approved: {
    label: 'Approved, ready to pay',
    short: 'ready to pay',
    classes: 'bg-status-payout-pending text-status-payout-pending-fg border-transparent',
  },
  paid: {
    label: 'Paid',
    short: 'paid',
    classes: 'bg-status-payout-complete text-status-payout-complete-fg border-transparent',
  },
  // Split settlement (migration 052). The wording says what the label is owed
  // next, not what the system did — "Deposit paid" would leave a manager
  // wondering whether that is finished.
  deposit_paid: {
    label: 'Deposit paid, waiting on the post',
    short: 'waiting on the post',
    classes: 'bg-status-sourced text-status-sourced-fg border-transparent',
  },
  balance_paid: {
    label: 'Paid in full',
    short: 'paid in full',
    classes: 'bg-status-payout-complete text-status-payout-complete-fg border-transparent',
  },
  undelivered: {
    label: 'Never posted, balance not paid',
    short: 'never posted',
    classes: 'bg-status-sourced text-status-sourced-fg border-transparent',
  },
  posted: {
    label: 'Posted',
    short: 'posted',
    classes: 'bg-status-sourced text-status-sourced-fg border-transparent',
  },
  measured: {
    label: 'Measured',
    short: 'measured',
    classes: 'bg-status-payout-complete text-status-payout-complete-fg border-transparent',
  },
  rejected: {
    label: 'Rejected',
    short: 'rejected',
    classes: 'bg-status-sourced text-status-sourced-fg border-transparent',
  },
  failed: {
    label: 'Closed: payment did not go through',
    short: 'payment did not go through',
    classes: 'bg-status-flagged text-status-flagged-fg border-transparent',
  },
};

/** Pre-offer fallback: the creator has been contacted but has no deal row. */
export const SENT_NO_OFFER: FunnelState = {
  label: 'Contacted, no price agreed yet',
  short: 'no price agreed yet',
  classes: 'bg-status-sourced text-status-sourced-fg border-transparent',
};

/** Badge wording for a status. Never returns a raw enum. */
export function funnelLabel(status: string | null | undefined): string {
  if (!status) return SENT_NO_OFFER.label;
  return FUNNEL_STATES[status]?.label ?? status.replace(/_/g, ' ');
}

/** Inline wording for a status, for "N <short>" sentences. */
export function funnelShortLabel(status: string | null | undefined): string {
  if (!status) return SENT_NO_OFFER.short;
  return FUNNEL_STATES[status]?.short ?? status.replace(/_/g, ' ');
}

/** Badge tone for a status, defaulting to the pre-offer tone. */
export function funnelClasses(status: string | null | undefined): string {
  if (!status) return SENT_NO_OFFER.classes;
  return FUNNEL_STATES[status]?.classes ?? SENT_NO_OFFER.classes;
}

// ── Grouping ────────────────────────────────────────────────────────────────
//
// Eleven states rendered as one flat list is not a funnel, it is a pile. These
// four groups are ordered by what the manager has to DO, so the rows that need
// a decision are never below the rows that are finished.

export type DealGroup = 'action' | 'working' | 'live' | 'closed';

export const DEAL_GROUP_ORDER: DealGroup[] = ['action', 'working', 'live', 'closed'];

export const DEAL_GROUP_META: Record<
  DealGroup,
  { heading: string; blurb: string }
> = {
  action: {
    heading: 'Waiting on you',
    blurb: 'Nothing moves on these until you approve, pay, or record a price.',
  },
  working: {
    heading: 'In negotiation',
    blurb: 'Offers are out or being countered. No action needed yet.',
  },
  live: {
    heading: 'Paid and running',
    blurb: 'Money has moved. What is left is the post and its numbers.',
  },
  closed: { heading: 'Closed', blurb: 'No further action possible.' },
};

const GROUP_BY_STATUS: Record<string, DealGroup> = {
  queued: 'working',
  offered: 'working',
  counter_offered: 'action',
  agreed: 'working',
  human_approval_required: 'action',
  approved: 'action',
  paid: 'live',
  // A deposit is out and a post is owed. 'live' rather than 'action' because
  // there is nothing for the manager to do but wait — the deadline enforces
  // itself, which is the whole point of the split.
  deposit_paid: 'live',
  posted: 'live',
  balance_paid: 'live',
  measured: 'live',
  rejected: 'closed',
  // Closed, not action: the deal resolved itself and the balance was never
  // sent. Putting it in 'action' would recreate exactly the chase-them-down
  // work the split exists to avoid.
  undelivered: 'closed',
  failed: 'action',
};

/**
 * Which group a deal belongs to. A creator with no offer row is waiting on a
 * price, which is a decision only a human can make — so it is action, not
 * "in negotiation". `failed` is action too: a failed payout is retryable and
 * burying it under "closed" is how a creator goes unpaid quietly.
 */
export function dealGroup(status: string | null | undefined): DealGroup {
  if (!status) return 'action';
  return GROUP_BY_STATUS[status] ?? 'working';
}
