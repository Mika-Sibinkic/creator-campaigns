// src/lib/statuses.ts
//
// Statuses dashboard assembly: pure, deterministic, testable.
// No DB, no I/O, no clock, no rng — same doctrine as src/lib/analytics.ts.
// The two API routes (/api/campaigns/[id]/statuses and /api/anomalies) do the
// queries; everything that decides *what the label sees* lives here so
// tests/statuses.test.ts can drive it with in-memory rows.
//
// Three exports matter:
//   assembleThread()       — one chronological timeline per campaign_influencer
//   detectAnomalies()      — firm-wide "needs human eyes" rollup
//   computeCampaignState() — the /campaigns/[id] stat-strip math

import { labelCpm } from './cpm-model';
import { SPENT_STATES } from './spend-caps';
import { legAccountsForPayment, normalizeLeg } from './payment-legs';
import { COMPLETION_NOT_RECORDED_ACTION } from './payment-claim';
import { MODE_MISMATCH_ACTION, modeMismatchSentence, parseModeMismatch } from './payment-mode-copy';
import {
  EXCLUSION_CAUSES,
  classifyExclusionReason,
  type ExclusionCause,
} from './pool-gates';

// ─── Thread: input row shapes (subset of the real columns) ──────────────────

export interface ThreadOutboundRow {
  id: string;
  message_type: string | null;
  status: string | null; // free text: draft | queued | sent | failed | window_closed
  // (vocabulary + labels: src/lib/message-status.ts)
  subject: string | null;
  body: string;
  sent_to: string | null;
  send_mode: string | null; // auto_email | computer_use | human_queue | null
  channel: string | null;
  sent_at: string | null;
  send_after?: string | null;
  created_at: string;
}

export interface ThreadInboundRow {
  id: string;
  channel: string;
  from_identity: string | null;
  body: string;
  received_at: string;
  status: string; // new | classified | flagged | processed
  classification: unknown; // jsonb: { classification, confidence } | null
}

export interface ThreadAuditRow {
  id: string;
  occurred_at: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: unknown;
}

export interface ThreadDeliveryRow {
  id: string;
  status: string; // pending | verified | missing
  spec_check: string | null; // pass | fail | partial
  spec_check_detail: string | null;
  post_url: string | null;
  detected_at: string | null;
  created_at: string;
}

// ─── Thread: output events ───────────────────────────────────────────────────

export interface OutboundEvent {
  kind: 'outbound';
  at: string;
  id: string;
  message_type: string | null;
  status: string | null;
  subject: string | null;
  body: string;
  sent_to: string | null;
  send_mode: string | null;
  channel: string | null;
  sent_at: string | null;
}

export interface InboundEvent {
  kind: 'inbound';
  at: string;
  id: string;
  channel: string;
  from_identity: string | null;
  body: string;
  /** status === 'flagged' — injection / fishy / low-confidence hold lane. */
  flagged: boolean;
  classification: string | null;
  classification_confidence: number | null;
}

export interface SystemEvent {
  kind: 'system';
  at: string;
  id: string;
  /** audit_log.action, or a synthesized `delivery.*` action. The timeline
   *  derives delivery events from deal_deliveries directly (current status);
   *  measurement-tick.ts ALSO writes `delivery.*` audit rows since the
   *  observability-spine pass, but those target deal_delivery ids, which the
   *  thread route deliberately does not fetch — so no duplicate events. */
  action: string;
  detail: string | null;
}

export type ThreadEvent = OutboundEvent | InboundEvent | SystemEvent;

/** Best-effort read of inbound_messages.classification jsonb. */
function parseClassification(raw: unknown): {
  classification: string | null;
  confidence: number | null;
} {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { classification: null, confidence: null };
  }
  const obj = raw as Record<string, unknown>;
  return {
    classification:
      typeof obj.classification === 'string' ? obj.classification : null,
    confidence: typeof obj.confidence === 'number' ? obj.confidence : null,
  };
}

/** Nullable free text from a provider or a spec check → something safe to put
 *  on screen. An empty string or a literal "null"/"undefined" must never render
 *  as a detail line; it reads as a bug. */
function cleanDetail(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text || text === 'null' || text === 'undefined') return null;
  return text;
}

/** payment_authorizations.failure_reason in plain language. Same doctrine as
 *  run-progress.ERROR_COPY: every code a label can actually see gets a
 *  sentence. Cap codes are written by spend-caps.CAP_FAILURE_REASON. */
const PAYMENT_FAILURE_COPY: Record<string, string> = {
  campaign_total_budget_exceeded: 'Stopped by the campaign budget cap',
  'cap:campaign': 'Stopped by the campaign budget cap',
  firm_monthly_cap_exceeded: 'Stopped by the monthly spending cap',
  'cap:firm_monthly': 'Stopped by the monthly spending cap',
  creator_monthly_cap_exceeded: 'Stopped by the per-creator spending cap',
  'cap:creator_monthly': 'Stopped by the per-creator spending cap',
  no_creator_email: 'No payout email on file for this creator',
  cancelled_by_operator: 'Cancelled before the payment was sent',
  transfer_failed: 'The payment could not be completed',
  invalid_payout_amount: 'The approved amount could not be read, so nothing was sent',
  stripe_transfer_reversed: 'The payment was reversed: the creator was not paid',
  offer_not_payable: 'The deal was closed before the payment went out, so nothing was sent',
  offer_check_failed: 'The deal could not be checked, so the payment was held. Nothing was sent',
  revoked_before_payout: 'Stopped before the payment was sent',
  legs_exceed_agreed: 'Refused: paying this would take the deal past its agreed amount, so nothing was sent',
  stripe_confirmed_not_sent:
    'Stripe confirmed nothing was sent after a connection problem. Retrying this payment is safe',
  stripe_outcome_unknown: 'Stripe did not confirm whether this payment went out. Do not retry it; check with Stripe first',
};

/** Map a failure code to a sentence. Unknown codes pass through rather than
 *  being dropped — but a vendor-prefixed code never reaches a client screen. */
function paymentFailureCopy(raw: string | null | undefined): string | null {
  const text = cleanDetail(raw);
  if (text == null) return null;
  const mapped = PAYMENT_FAILURE_COPY[text];
  if (mapped) return mapped;
  if (text.startsWith('cap_check_failed')) {
    return 'The spending-cap check could not be completed';
  }
  const mismatch = parseModeMismatch(text);
  if (mismatch) {
    return `Nothing was sent. ${modeMismatchSentence(mismatch.approvedMode, mismatch.currentMode)}`;
  }
  if (text.startsWith('paypal_') || text.startsWith('stripe_')) {
    return 'The payment provider could not complete the payout';
  }
  return text;
}

/** creator_offers.status → why the deal is sitting still. The raw enum is a
 *  developer string; a label reads the reason. */
const OFFER_STATUS_COPY: Record<string, string> = {
  queued: 'the opening offer has not gone out',
  offered: 'waiting on the creator to reply',
  counter_offered: 'their counter-offer is still unanswered',
  agreed: 'agreed, waiting on the next step',
  human_approval_required: 'waiting on your approval',
  approved: 'approved, waiting on payment',
};

/** Unknown statuses degrade to the enum de-underscored and sentence-cased. */
function offerStatusCopy(status: string): string {
  const mapped = OFFER_STATUS_COPY[status];
  if (mapped) return mapped;
  const spaced = String(status ?? '').replace(/_/g, ' ').trim();
  if (!spaced) return 'no status recorded';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** inbound_messages.channel → the DM names used elsewhere in the UI (see
 *  campaigns/[id]/deals/page.tsx CHANNEL_META). Lower-cased 'email' because
 *  this one is read mid-sentence, not as a badge. */
const CHANNEL_COPY: Record<string, string> = {
  email: 'email',
  instagram_dm: 'Instagram DM',
  tiktok_dm: 'TikTok DM',
};

function channelCopy(channel: string): string {
  const mapped = CHANNEL_COPY[channel];
  if (mapped) return mapped;
  const spaced = String(channel ?? '').replace(/_/g, ' ').trim();
  return spaced || 'an unknown channel';
}

/** deal_deliveries.spec_check → the timeline line a label reads. */
const SPEC_CHECK_COPY: Record<string, string> = {
  pass: 'Delivered post matched the agreed spec',
  fail: 'Delivered post did not match the agreed spec',
  partial: 'Delivered post only partly matched the agreed spec',
};

/** One-line human summary for the audit actions the thread cares about.
 *  Unknown actions fall back to null detail — the action string still shows. */
export function summarizeAuditEvent(action: string, metadata: unknown): string | null {
  const md =
    metadata != null && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const usd = (v: unknown): string | null =>
    typeof v === 'number' && Number.isFinite(v) ? `$${v.toFixed(2)}` : null;
  switch (action) {
    case 'negotiation.agreed': {
      const amt = usd(md.agreed_amount_usd);
      return amt ? `Deal agreed at ${amt}` : 'Deal agreed';
    }
    case 'negotiation.offer_sent':
      return 'Opening offer sent';
    case 'negotiation.auto_counter_sent':
      return 'Auto-counter sent';
    case 'negotiation.auto_rejected':
      return 'Auto-rejected';
    case 'negotiation.injection_flagged':
      return 'Prompt-injection attempt flagged, reply held';
    case 'negotiation.fishy_flagged':
      return 'Reply looked fishy, held for human review';
    case 'negotiation.low_confidence_flagged':
      return 'Reply was unclear, held for human review';
    case 'negotiation.pending_human_approval':
      return 'Waiting on human approval';
    case 'negotiation.auto_paid': {
      const amt = usd(md.amount_usd);
      return amt ? `Auto-paid ${amt}` : 'Auto-paid';
    }
    case 'negotiation.auto_payout_failed': {
      const why = paymentFailureCopy(
        typeof md.error === 'string' ? md.error : null,
      );
      return why ? `Auto-payout failed: ${why}` : 'Auto-payout failed';
    }
    case 'payment.authorization_created':
      return 'Payment authorization created';
    case 'payment.approved':
      return 'Payment approved';
    case 'payment.rejected':
      return 'Payment rejected';
    case 'payment.executed':
      return 'Payment executed';
    case 'payment.failed':
      return 'Payment failed';
    case 'payment.onboarding_link_sent':
      return 'Payout onboarding email sent';
    case 'payment.onboarding_link_opened':
      return 'Creator opened the payout onboarding link';
    case 'offer.quick_agreed':
      return 'Deal locked in manually';
    case 'offer.cancelled':
      return 'Deal cancelled';
    case 'offer.posted':
      return 'Post URL logged';
    case 'deal.paid':
      return 'Payment confirmed by provider';
    default:
      return null;
  }
}

export interface ThreadInput {
  outbound: ThreadOutboundRow[];
  inbound: ThreadInboundRow[];
  audit: ThreadAuditRow[];
  deliveries: ThreadDeliveryRow[];
}

/** Interleave outbound + inbound + system events into one ascending timeline.
 *
 *  Timestamps: outbound uses sent_at, else send_after (queued), else
 *  created_at (draft). Inbound uses received_at. Audit uses occurred_at.
 *  Deliveries use detected_at, else created_at. Ties break on kind
 *  (outbound → inbound → system) then id, so the order is deterministic. */
export function assembleThread(input: ThreadInput): ThreadEvent[] {
  const events: ThreadEvent[] = [];

  for (const m of input.outbound) {
    events.push({
      kind: 'outbound',
      at: m.sent_at ?? m.send_after ?? m.created_at,
      id: m.id,
      message_type: m.message_type,
      status: m.status,
      subject: m.subject,
      body: m.body,
      sent_to: m.sent_to,
      send_mode: m.send_mode,
      channel: m.channel,
      sent_at: m.sent_at,
    });
  }

  for (const m of input.inbound) {
    const cls = parseClassification(m.classification);
    events.push({
      kind: 'inbound',
      at: m.received_at,
      id: m.id,
      channel: m.channel,
      from_identity: m.from_identity,
      body: m.body,
      flagged: m.status === 'flagged',
      classification: cls.classification,
      classification_confidence: cls.confidence,
    });
  }

  for (const a of input.audit) {
    events.push({
      kind: 'system',
      at: a.occurred_at,
      id: a.id,
      action: a.action,
      detail: summarizeAuditEvent(a.action, a.metadata),
    });
  }

  for (const d of input.deliveries) {
    const specNote =
      d.spec_check != null
        ? (SPEC_CHECK_COPY[d.spec_check] ?? `Spec check: ${d.spec_check}`)
        : null;
    const specWhy = cleanDetail(d.spec_check_detail);
    const detail =
      specNote != null
        ? specWhy
          ? `${specNote}: ${specWhy}`
          : specNote
        : cleanDetail(d.post_url);
    events.push({
      kind: 'system',
      at: d.detected_at ?? d.created_at,
      id: `delivery-${d.id}`,
      action: `delivery.${d.status}`,
      detail,
    });
  }

  const KIND_ORDER: Record<ThreadEvent['kind'], number> = {
    outbound: 0,
    inbound: 1,
    system: 2,
  };
  events.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) {
      return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return events;
}

// ─── Anomalies ───────────────────────────────────────────────────────────────

export const STALL_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
/** Offer statuses where "nothing moved for a week" means a stalled deal, not
 *  a resting state. queued = not started; agreed+ = human/payment court. */
export const STALL_STATUSES: readonly string[] = ['offered', 'counter_offered'];

/** audit_log actions that make up the fishy-reply lane. */
export const FISHY_AUDIT_ACTIONS: readonly string[] = [
  'negotiation.fishy_flagged',
  'negotiation.low_confidence_flagged',
];

/** audit_log actions that make up the needs-a-decision lane (issues #65, #66).
 *  Kept as a literal list rather than imported from negotiation.ts, which is
 *  the same arrangement FISHY_AUDIT_ACTIONS has and keeps this module free of
 *  the negotiation graph. Mirrors ESCALATION_AUDIT_ACTIONS there. */
export const ESCALATION_AUDIT_ACTIONS: readonly string[] = [
  'negotiation.out_of_spec_flagged',
  'negotiation.terms_discarded',
  'negotiation.corrupt_freeze',
  'negotiation.question_unanswered',
  'negotiation.budget_unverifiable',
  'negotiation.sent_price_unknown',
  'negotiation.accept_price_unclear',
  'negotiation.counter_price_unclear',
  'negotiation.edited_counter_superseded',
  'negotiation.manual_mode_reply',
  'negotiation.dm_counter_unsent',
];

/** One line per escalation action, written for the label, not for an engineer. */
const ESCALATION_COPY: Record<string, string> = {
  'negotiation.out_of_spec_flagged':
    'A creator proposed work outside this campaign’s deal scope',
  'negotiation.terms_discarded':
    'A creator proposed something the negotiator does not sell',
  'negotiation.corrupt_freeze':
    'The agreed package on this deal could not be read back',
  'negotiation.question_unanswered':
    'A creator asked a question, and it needs an answer from you',
  'negotiation.budget_unverifiable':
    'This campaign has no usable budget, so negotiation is paused on it',
  'negotiation.sent_price_unknown':
    'A creator wrote again before our counter went, and the last price they saw needs checking by you',
  'negotiation.accept_price_unclear':
    'A creator said yes, but their reply has a number other than the last price we sent, so confirm the price with them',
  'negotiation.counter_price_unclear':
    'A creator countered, but the price they named is not a single clear US-dollar figure, so reply to them yourself',
  'negotiation.edited_counter_superseded':
    'A creator wrote again before your edited counter went. It was held back so two counters don’t go out; reply to them yourself',
  'negotiation.manual_mode_reply':
    'A creator replied on a deal you have taken over. Nothing was agreed or countered automatically; reply yourself, or resume automation from the deal thread with the price you last quoted',
  'negotiation.dm_counter_unsent':
    'A creator replied before your DM counter was marked sent. The draft is still in the DM queue; mark it sent if it went, then reply yourself or resume automation',
};

export type AnomalyCategory =
  | 'injection_flagged'
  | 'flagged_inbound'
  | 'fishy_reply'
  | 'needs_decision'
  | 'payment_failed'
  | 'delivery_spec_failed'
  | 'stalled_negotiation'
  | 'unmatched_inbound'
  | 'contract_missing'
  | 'bounced_email'
  | 'stalled_tick'
  | 'payment_anomaly';

export const ANOMALY_CATEGORIES: readonly AnomalyCategory[] = [
  'injection_flagged',
  'flagged_inbound',
  'fishy_reply',
  'needs_decision',
  'payment_failed',
  'delivery_spec_failed',
  'stalled_negotiation',
  'unmatched_inbound',
  'contract_missing',
  'bounced_email',
  'stalled_tick',
  'payment_anomaly',
];

/**
 * audit_log actions that make up the payment_anomaly lane — money-path events
 * that used to reach only audit_log and Sentry. None of them leaves the
 * authorization in 'failed', so none of them appears in payment_failed:
 *
 *   payment.webhook_cap_refused     spend-caps.webhookCapGate — an approved
 *                                   payout blocked by a cap after onboarding,
 *                                   reverted to 'approved'
 *   payment.cap_check_failed        execute-payment — caps unverifiable,
 *                                   reverted to 'approved'
 *   payment.webhook_transfer_failed onboarding-payout — the transfer failed,
 *                                   reverted to 'approved'
 *   payment.offer_check_failed      the deal could not be read before paying
 *   payment.reclaimed_stale         payment-reclaim — a claim stranded in
 *                                   'executing' was returned to 'approved'
 *   payment.failed (creator_offer)  settlement-failure.handlePayoutFailed —
 *                                   Stripe payout.failed: the creator's bank
 *                                   bounced money that already left the label.
 *                                   Only the `stage: 'bank_payout'` rows; the
 *                                   execute path's own payment.failed targets
 *                                   the authorization, which is already in
 *                                   payment_failed via its status.
 *
 * Read from audit_log rather than a new table: every one of these is already
 * written there, append-only, with firm_id.
 */
const AUTOMINT_FAILED_ACTION_LITERAL = 'negotiation.payment_auth_automint_failed';
const BALANCE_MINT_FAILED_ACTION_LITERAL = 'payment.balance_authorization_failed';

/**
 * A deal whose payment never reached /approvals: negotiation's automint
 * (deposit/full leg) or the post route's balance mint failed. The deal would
 * otherwise read "awaiting approval" with nothing to approve. One row per deal
 * (newest failure), cleared once the gap is filled or the deal moved on; the
 * row carries mint_payment_offer_id for "Create payment for approval".
 */
export const PAYMENT_MINT_FAILED_ACTIONS: readonly string[] = [
  AUTOMINT_FAILED_ACTION_LITERAL,
  BALANCE_MINT_FAILED_ACTION_LITERAL,
];

export const MONEY_ANOMALY_AUDIT_ACTIONS: readonly string[] = [
  'payment.webhook_cap_refused',
  'payment.cap_check_failed',
  'payment.webhook_transfer_failed',
  'payment.offer_check_failed',
  'payment.reclaimed_stale',
  'promo.held_unconfirmed',
  'payment.reconcile_mismatch',
  'payment.reclaim_provider_unreachable',
  'payment.legs_exceed_agreed',
  AUTOMINT_FAILED_ACTION_LITERAL,
  BALANCE_MINT_FAILED_ACTION_LITERAL,
  COMPLETION_NOT_RECORDED_ACTION,
  MODE_MISMATCH_ACTION,
];

/**
 * Money anomalies that are re-raised about the SAME payment while it stays
 * unresolved (payment-reclaim.ts backs these off, but a stuck payment still
 * collects one a day). The lane shows ONE row per payment — the latest state,
 * with first-seen and count — and the route fetches them with their own query,
 * scoped to payments still executing, so they cannot crowd out the rest of the
 * lane. Kept in step with payment-reclaim.RECLAIM_FLAG_ACTIONS (tests pin it).
 */
export const RECONCILE_FLAG_ACTIONS: readonly string[] = [
  'payment.reconcile_mismatch',
  'payment.reclaim_provider_unreachable',
];

/**
 * A paid creator's promo pack NOT sent because the label's do-not-contact list
 * could not be read (src/lib/promo-materials.ts, fail closed). Its callers fire
 * once per paid deal, so nothing retries it — the lane row is the retry, via
 * the operator's "Resend promo pack" (POST /api/anomalies/promo-resend).
 */
export const PROMO_HELD_ACTION = 'promo.held_unconfirmed';

/**
 * The promo pack was deliberately not sent: the creator is on the label's
 * do-not-contact list. Not an anomaly itself — it RESOLVES an earlier held row
 * for the same deal, because re-running would only reach the same answer.
 */
export const PROMO_WITHHELD_ACTION = 'promo.withheld_do_not_contact';

/** The bank-payout form of payment.failed, fetched by its own query (the
 *  action alone would also match every execute-path failure). */
export const BANK_PAYOUT_FAILED_ACTION = 'payment.failed';

/** A claim older than this is stranded, not in flight — the same threshold the
 *  reclaimer uses (payment-reclaim.STALE_EXECUTING_MS), so the lane and the
 *  recovery agree. A literal, not an import: this module is bundled into the
 *  client /anomalies page and payment-reclaim.ts lazily imports the server-only
 *  audit writer. tests/payment-gate.test.ts pins the two values equal. */
export const STUCK_EXECUTING_MS = 15 * 60_000;

/** payment-claim.OUTCOME_UNKNOWN_REASON, as a literal for the same reason as
 *  STUCK_EXECUTING_MS (client bundle). tests/money-path-adversarial pins it. */
export const OUTCOME_UNKNOWN_FAILURE = 'stripe_outcome_unknown';

/** No negotiation tick_run for longer than this → the loop is stalled.
 *  The tick fires every ~5 min; 15 min = three consecutive missed beats,
 *  which is a dead scheduler, not jitter. */
export const STALLED_TICK_THRESHOLD_MS = 15 * 60 * 1000;

/** Offer statuses that mean the deal CLOSED — past this point the creator has
 *  been told there is a deal, so there should be a contract on the row. */
export const CLOSED_STATUSES: readonly string[] = [
  'agreed',
  'human_approval_required',
  'approved',
  'paid',
  'posted',
  'measured',
];

export interface AnomalyRow {
  category: AnomalyCategory;
  /** ISO timestamp of the triggering fact. */
  at: string;
  /** One-line label-readable description. */
  what: string;
  /** Reason / snippet / failure_reason — nullable, shown as secondary text. */
  detail: string | null;
  /** Creator handle or inbound from_identity; null when unattributable. */
  who: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  /** Deep-link target: /campaigns/{campaign_id}/deals/{campaign_influencer_id}/thread */
  campaign_influencer_id: string | null;
  /** Stable unique key for the source row (React key / dedupe). */
  ref: string;
  /** Set on a held promo pack: the creator_offers.id the operator's
   *  "Resend promo pack" re-runs. Absent on every other row. */
  resend_promo_offer_id?: string | null;
  /** Set on a payment whose outcome is unknown (or a stale claim): the
   *  payment_authorizations.id the operator's "Check with Stripe"
   *  (POST /api/anomalies/stripe-check) reconciles. */
  check_stripe_payment_id?: string | null;
  /** Set on a deal whose payment never reached /approvals: the
   *  creator_offers.id "Create payment for approval"
   *  (POST /api/payments/remint) re-mints. */
  mint_payment_offer_id?: string | null;
  /** Per-payment flags (RECONCILE_FLAG_ACTIONS) collapse to one row: when the
   *  first flag was raised, and how many there are in the fetched window. */
  first_seen_at?: string | null;
  occurrences?: number;
}

/**
 * Lanes that exist for whoever RUNS Creator Campaigns, not for the label using it.
 *
 * Four of these tell a record label something about our plumbing rather than
 * about their campaign: that the product is prompt-injectable and has a guard
 * for it, that a reply tripped a safety classifier, that a delivery failed an
 * internal spec check, and that the negotiation cron has stopped beating
 * ("check the cron scheduler" is a pager alert, not a customer message).
 *
 * The rows still get detected, audited and acted on — this only decides who
 * sees the lane. The label's remaining lanes are the ones where the answer is
 * a decision they can make: needs_decision, payment_failed, contract_missing,
 * bounced_email, stalled_negotiation, unmatched_inbound.
 */
export const OPERATOR_ONLY_ANOMALY_CATEGORIES: readonly AnomalyCategory[] = [
  'injection_flagged',
  'flagged_inbound',
  'fishy_reply',
  'delivery_spec_failed',
  'stalled_tick',
  // Money plumbing: a stranded claim, a reclaim, a provider/bank failure, a
  // cap that could not be read. The label's view of a payment that did not
  // go out stays the payment_failed lane and the deal row; these are the
  // operator's "go look at the provider / the scheduler" signals.
  'payment_anomaly',
];

/**
 * One anomaly's detail line, written for whoever is reading it.
 *
 * Only `bounced_email` differs today. Its detail is `Sent to <address>`, and
 * with firms.testing_mode on that address is OUR test inbox — so the lane
 * that exists to tell a label "your outreach is not landing" was instead
 * showing them an internal mailbox. The fact that it bounced is carried by
 * `what` and is not touched; what the non-operator gets instead is the fix.
 */
export function anomalyDetailFor(
  row: AnomalyRow,
  isOperator: boolean,
): string | null {
  if (isOperator) return row.detail;
  if (row.category === 'bounced_email') {
    return 'Stop sending to this address. Update the creator’s contact email, or drop the lead.';
  }
  return row.detail;
}

export interface AnomalyOfferRow {
  id: string;
  campaign_influencer_id: string;
  campaign_id: string;
  status: string;
  injection_flagged: boolean;
  updated_at: string;
  current_offer_usd: number | null;
  /** creator_offers.contract_generated_at — non-null iff a filled contract was
   *  frozen on this deal. Timestamp, not the text: contract_text is a whole
   *  legal document and this is a bulk scan. Optional so callers that predate
   *  migration 034 still type-check. */
  contract_generated_at?: string | null;
}

export interface AnomalyPaymentRow {
  id: string;
  creator_offer_id: string;
  campaign_id: string;
  status: string;
  failure_reason: string | null;
  amount_usd: number;
  created_at: string;
  executed_at: string | null;
}

export interface AnomalyDeliveryRow {
  id: string;
  creator_offer_id: string;
  spec_check: string | null;
  spec_check_detail: string | null;
  detected_at: string | null;
  created_at: string;
}

export interface AnomalyInboundRow {
  id: string;
  campaign_influencer_id: string | null;
  creator_offer_id: string | null;
  channel: string;
  from_identity: string | null;
  body: string;
  received_at: string;
  status: string;
  /** Carries `possible_duplicate_of` when ingest held the reply as a near-duplicate. */
  classification?: unknown;
}

/** Ingest held this reply because it is SIMILAR to another on the thread. */
export function isPossibleDuplicate(classification: unknown): boolean {
  return (
    classification != null &&
    typeof classification === 'object' &&
    typeof (classification as Record<string, unknown>).possible_duplicate_of === 'string'
  );
}

export interface AnomalyCiRow {
  id: string;
  campaign_id: string;
  influencer_id: string;
}

/** Outbound outreach_messages whose Resend delivery status came back
 *  terminal-bad ('bounced' | 'complained') — webhook-written since the
 *  provider_message_id correlation fix.
 *
 *  Reads `delivery_status` (migration 046), NOT `status`. Those are different
 *  axes: `status` is the send lifecycle and stays terminal at 'sent' because
 *  six analytics/performance readers use it as a denominator. */
export interface AnomalyBouncedRow {
  id: string;
  campaign_influencer_id: string | null;
  delivery_status: string;
  sent_to: string | null;
  sent_at: string | null;
  created_at: string;
}

/** The newest tick_runs row per tick name (migration 044). `null` /
 *  undefined = the table is unreadable or empty (pre-migration, or the
 *  feature just landed) — stall detection then stays silent rather than
 *  crying wolf on a table that has never been written. */
export interface AnomalyTickInput {
  /** started_at of the newest 'negotiation' tick_runs row. */
  last_negotiation_run_at: string | null;
}

/** A payment_authorizations row currently in 'executing'. `executing_at` is
 *  null before migration 055 (or for a row claimed through the pre-055
 *  fallback) — such a row cannot be reclaimed automatically, so it is shown
 *  once it is older than the threshold by created_at. */
export interface AnomalyExecutingRow {
  id: string;
  creator_offer_id: string;
  campaign_id: string;
  amount_usd: number;
  executing_at: string | null;
  created_at: string;
  /** 'stripe_outcome_unknown' when the transfer call came back ambiguous
   *  (payment-claim.OUTCOME_UNKNOWN_REASON). Optional for older callers. */
  failure_reason?: string | null;
}

export interface AnomaliesInput {
  offers: AnomalyOfferRow[];
  payments: AnomalyPaymentRow[];
  deliveries: AnomalyDeliveryRow[];
  /** Pre-filtered to FISHY_AUDIT_ACTIONS + ESCALATION_AUDIT_ACTIONS by the
   *  route. */
  audit: ThreadAuditRow[];
  inbound: AnomalyInboundRow[];
  cis: AnomalyCiRow[];
  influencers: { id: string; username: string }[];
  campaigns: { id: string; artist_name: string }[];
  /** Whether the firm has a contract template saved at all. Decides whether an
   *  uncovered deal means "save a template" or "the template has a slot the
   *  app can't fill" — two different fixes, so they get two different lines. */
  hasContractTemplate: boolean;
  /** Optional (route degrades to [] when the query fails): bounced/complained
   *  outbound emails, pre-filtered to this firm's CIs by the route. */
  bounced?: AnomalyBouncedRow[];
  /** Optional: newest tick-run facts for stalled-tick detection. Omit when
   *  tick_runs is unreadable/empty (pre-migration-044). */
  tick?: AnomalyTickInput | null;
  /** Optional: audit rows for MONEY_ANOMALY_AUDIT_ACTIONS plus the
   *  bank-payout payment.failed rows. */
  moneyAudit?: ThreadAuditRow[];
  /** Optional: authorizations currently in 'executing'. */
  executing?: AnomalyExecutingRow[];
  /** Optional: leads that already have a promo_materials message (sent or
   *  provider-failed). A held promo row for one of them is resolved. */
  promoSentCiIds?: string[];
  /** Optional: the payment legs of deals named by a mint-failed audit row. A
   *  failure is resolved once a leg accounts for the payment. */
  offerLegs?: {
    creator_offer_id: string;
    leg?: string | null;
    status: string;
    failure_reason?: string | null;
    payment_provider_id?: string | null;
  }[];
  /** Optional: what an operator already resolved — anomaly refs,
   *  and replies marked reviewed or sent back to the negotiator. Escalation
   *  and fishy rows (audit-backed, so they never change on their own) are
   *  dropped when their ref, or the reply they name, is in here. Built from
   *  audit rows by resolvedFromAudit. */
  resolved?: ResolvedAnomalies;
}

/** audit_log action written by every /anomalies "Resolve" (anomaly-resolve.ts). */
export const ANOMALY_RESOLVED_ACTION = 'anomaly.resolved';
/** Audit actions that retire anomalies: a Resolve, and a resume of automation
 *  (which marks the thread's held replies reviewed). */
export const RESOLUTION_AUDIT_ACTIONS: readonly string[] = [ANOMALY_RESOLVED_ACTION, 'negotiation.automation_resumed'];

export interface ResolvedAnomalies {
  refs: ReadonlySet<string>;
  inbound_ids: ReadonlySet<string>;
}

/** The refs and replies RESOLUTION_AUDIT_ACTIONS rows have retired. */
export function resolvedFromAudit(rows: ReadonlyArray<ThreadAuditRow>): ResolvedAnomalies {
  const refs = new Set<string>();
  const inbound = new Set<string>();
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    if (r.action === ANOMALY_RESOLVED_ACTION) {
      if (typeof meta.ref === 'string') refs.add(meta.ref);
      for (const id of ids(meta.inbound_ids)) inbound.add(id);
    } else if (r.action === 'negotiation.automation_resumed') {
      for (const id of ids(meta.resolved_inbound_ids)) inbound.add(id);
    }
  }
  return { refs, inbound_ids: inbound };
}

/** Lanes an operator can resolve from /anomalies, and whether a held reply in
 *  them can be sent back to the negotiator. */
export function resolveOptionsFor(row: Pick<AnomalyRow, 'category'>): { reviewed: boolean; processNormally: boolean } {
  switch (row.category) {
    case 'flagged_inbound':
      return { reviewed: true, processNormally: true };
    case 'injection_flagged':
    case 'fishy_reply':
    case 'needs_decision':
      return { reviewed: true, processNormally: false };
    default:
      return { reviewed: false, processNormally: false };
  }
}

const CAP_COPY: Record<string, string> = {
  campaign: 'the campaign budget cap',
  firm_monthly: 'the monthly spending cap',
  creator_monthly: 'the per-creator monthly cap',
  lookup_failed: 'a spending-cap check that could not be completed',
};

function metaString(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === 'string' && v.trim() ? v : null;
}

/** One money-anomaly audit row → what/detail, or null when the row is not a
 *  money anomaly (e.g. an execute-path payment.failed). */
function moneyAnomalyCopy(a: ThreadAuditRow): { what: string; detail: string | null } | null {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  switch (a.action) {
    case 'payment.webhook_cap_refused': {
      const cap = metaString(meta, 'cap');
      return {
        what: 'Approved payout held by a spending cap after the creator finished payout setup',
        detail: `Blocked by ${CAP_COPY[cap ?? ''] ?? 'a spending cap'}. It is back in the approved state and goes out on the next attempt once there is room.`,
      };
    }
    case 'payment.cap_check_failed':
      return {
        what: 'Payout held: the spending caps could not be verified',
        detail: metaString(meta, 'error') ?? 'The cap lookup failed, so the payout was refused. It is back in the approved state.',
      };
    case 'payment.webhook_transfer_failed':
      return {
        what: 'Transfer failed after the creator finished payout setup',
        detail: metaString(meta, 'guidance') ?? metaString(meta, 'error') ?? 'The payout did not go out. It is back in the approved state.',
      };
    case 'payment.offer_check_failed':
      return {
        what: 'Payout held: the deal could not be checked before paying',
        detail: 'Nothing was sent. It is back in the approved state and is re-checked on the next attempt.',
      };
    case PROMO_HELD_ACTION:
      return {
        what: 'Promo pack not sent to a paid creator: the do-not-contact list could not be read',
        detail:
          'Held, not sent, and nothing retries it automatically. Resend it once the list is readable; it re-checks the list first.',
      };
    case 'payment.reclaimed_stale': {
      const claimed = metaString(meta, 'claimed_at');
      return {
        what: 'A payment stuck mid-send was returned to approved',
        detail: `The process sending it stopped${claimed ? ` (claimed ${claimed})` : ''}. A retry reuses the same idempotency key; check the payment provider before retrying by hand.`,
      };
    }
    case 'payment.reconcile_mismatch': {
      const reason = metaString(meta, 'reason');
      const copy: Record<string, string> = {
        multiple_transfers: 'Stripe holds MORE THAN ONE transfer for this payment. The creator may have been paid twice',
        amount_mismatch: 'Stripe holds a transfer for this payment, but for a different amount',
        transfer_reversed: 'Stripe holds a transfer for this payment, but it was reversed',
      };
      return {
        what: copy[reason ?? ''] ?? 'Stripe’s record of this payment does not match ours',
        detail: `Left as “outcome unknown”. Nothing was re-sent. Open the transfer in Stripe (${metaString(meta, 'detail') ?? 'see transfer_group ' + (metaString(meta, 'transfer_group') ?? '')}) and resolve it by hand.`,
      };
    }
    case 'payment.reclaim_provider_unreachable': {
      const rowMode = metaString(meta, 'row_mode') ?? 'an unrecorded mode';
      const envMode = metaString(meta, 'env_mode') ?? 'unknown';
      const configured = metaString(meta, 'configured_mode');
      return {
        what: 'A payment stuck mid-send cannot be checked from this server',
        detail: `It was sent in ${rowMode}; this server is running ${envMode}${configured && configured !== envMode ? ` (configured ${configured}, but its key is missing or the wrong kind)` : ''}. It was left exactly as it was: not re-sent, not returned to approved. Fix the payment key for ${rowMode}, then use “Check with Stripe”.`,
      };
    }
    case AUTOMINT_FAILED_ACTION_LITERAL:
      return {
        what: 'Deal agreed, but its payment never reached Approvals',
        detail:
          'The deal reads as awaiting approval, but nothing is waiting in Approvals, so nothing will be paid. “Create payment for approval” puts it there, and it still needs an approval before any money moves.',
      };
    case BALANCE_MINT_FAILED_ACTION_LITERAL:
      return {
        what: 'Post logged, but the balance payment never reached Approvals',
        detail:
          'The deposit is paid and the creator posted, but nothing is waiting in Approvals for the balance, so it would never be paid. “Create payment for approval” puts it there, and it still needs an approval before any money moves.',
      };
    case COMPLETION_NOT_RECORDED_ACTION: {
      const transfer = metaString(meta, 'transfer_id');
      return {
        what: 'Transfer sent but not recorded: money moved and the payment row does not say so',
        detail: `${transfer ? `Stripe transfer ${transfer}` : 'The transfer'} went out, but the payment record could not be updated afterwards. Do not retry it. Open the transfer in the payment provider to confirm it, then mark the payment complete by hand.`,
      };
    }
    case 'payment.legs_exceed_agreed':
      return {
        what: 'Payout refused: it would have paid more than the agreed amount',
        detail: 'Nothing was sent. Do not reject it: on the deal, use “Create balance payment” (or “Set up payment”) to replace it with one sized from what was already paid. The replacement needs a fresh approval.',
      };
    case MODE_MISMATCH_ACTION:
      return {
        what: 'Payout refused: it was approved in the other payments mode',
        detail: `Nothing was sent. ${modeMismatchSentence(metaString(meta, 'approved_mode'), metaString(meta, 'current_mode'))} On the deal, use “Set up payment” to put it back in Approvals.`,
      };
    case BANK_PAYOUT_FAILED_ACTION:
      if (a.target_type !== 'creator_offer' || meta.stage !== 'bank_payout') return null;
      return {
        what: 'The creator’s bank rejected the payout: the money is sitting in their Stripe balance',
        detail: metaString(meta, 'guidance') ?? 'Ask the creator to fix their bank details in Stripe.',
      };
    default:
      return null;
  }
}

const SNIPPET_MAX = 140;

function snippet(body: string): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return oneLine.length > SNIPPET_MAX
    ? `${oneLine.slice(0, SNIPPET_MAX)}…`
    : oneLine;
}

/** Firm-wide "needs human eyes" detection over in-memory rows. Pure; the
 *  clock is injected (nowMs) so the 7-day stall boundary is testable.
 *  Returns rows sorted newest-first. */
export function detectAnomalies(input: AnomaliesInput, nowMs: number): AnomalyRow[] {
  const ciById = new Map(input.cis.map((c) => [c.id, c]));
  const infById = new Map(input.influencers.map((i) => [i.id, i]));
  const campaignById = new Map(input.campaigns.map((c) => [c.id, c]));
  const offerById = new Map(input.offers.map((o) => [o.id, o]));

  const whoForCi = (ciId: string | null): string | null => {
    if (!ciId) return null;
    const ci = ciById.get(ciId);
    if (!ci) return null;
    const inf = infById.get(ci.influencer_id);
    return inf ? `@${inf.username}` : null;
  };
  const campaignNameFor = (campaignId: string | null): string | null =>
    campaignId ? (campaignById.get(campaignId)?.artist_name ?? null) : null;

  const rows: AnomalyRow[] = [];

  // 1. Injection-flagged offers (creator_offers.injection_flagged).
  for (const o of input.offers) {
    if (!o.injection_flagged) continue;
    rows.push({
      category: 'injection_flagged',
      at: o.updated_at,
      what: 'Prompt-injection attempt flagged on this negotiation',
      detail: null,
      who: whoForCi(o.campaign_influencer_id),
      campaign_id: o.campaign_id,
      campaign_name: campaignNameFor(o.campaign_id),
      campaign_influencer_id: o.campaign_influencer_id,
      ref: `injection-${o.id}`,
    });
  }

  // 2 + 7. Inbound: flagged lane and unmatched replies. A row with no
  //    campaign_influencer_id is UNMATCHED first — that is the actionable
  //    fact (nobody will ever see it in a thread until it's matched).
  for (const m of input.inbound) {
    if (m.campaign_influencer_id == null) {
      const viaOffer = m.creator_offer_id
        ? (offerById.get(m.creator_offer_id) ?? null)
        : null;
      rows.push({
        category: 'unmatched_inbound',
        at: m.received_at,
        what: `Reply on ${channelCopy(m.channel)} couldn't be matched to a creator`,
        detail: snippet(m.body),
        who: m.from_identity,
        campaign_id: viaOffer?.campaign_id ?? null,
        campaign_name: campaignNameFor(viaOffer?.campaign_id ?? null),
        campaign_influencer_id: viaOffer?.campaign_influencer_id ?? null,
        ref: `unmatched-${m.id}`,
      });
      continue;
    }
    if (m.status !== 'flagged') continue;
    const ci = ciById.get(m.campaign_influencer_id);
    rows.push({
      category: 'flagged_inbound',
      at: m.received_at,
      what: isPossibleDuplicate(m.classification)
        ? 'Possible duplicate reply. Review it beside the earlier one; nothing was negotiated'
        : 'Creator reply flagged, held out of the auto-negotiation loop',
      detail: snippet(m.body),
      who: whoForCi(m.campaign_influencer_id) ?? m.from_identity,
      campaign_id: ci?.campaign_id ?? null,
      campaign_name: campaignNameFor(ci?.campaign_id ?? null),
      campaign_influencer_id: m.campaign_influencer_id,
      ref: `flagged-${m.id}`,
    });
  }

  // 3b. Needs-a-decision lane (issues #65, #66) — a readable reply the
  //     auto-negotiator deliberately refused to answer on the label's behalf.
  //     Same audit-action mechanism as the fishy lane, separate category
  //     because the ask is different: a fishy reply wants a security look, this
  //     wants a commercial decision.
  // An audit-backed row never changes on its own, so a Resolve (or a
  // resume that reviewed the reply it names) is what retires it.
  const retired = (prefix: string, a: ThreadAuditRow): boolean => {
    if (!input.resolved) return false;
    if (input.resolved.refs.has(`${prefix}-${a.id}`)) return true;
    const inboundId = (a.metadata as { inbound_message_id?: unknown } | null)?.inbound_message_id;
    return typeof inboundId === 'string' && input.resolved.inbound_ids.has(inboundId);
  };
  for (const a of input.audit) {
    if (!ESCALATION_AUDIT_ACTIONS.includes(a.action)) continue;
    if (retired('escalation', a)) continue;
    const offer = a.target_id ? (offerById.get(a.target_id) ?? null) : null;
    const meta = (a.metadata ?? {}) as { detail?: unknown };
    rows.push({
      category: 'needs_decision',
      at: a.occurred_at,
      what: ESCALATION_COPY[a.action] ?? 'This negotiation needs a decision from you',
      detail: typeof meta.detail === 'string' ? snippet(meta.detail) : null,
      who: whoForCi(offer?.campaign_influencer_id ?? null),
      campaign_id: offer?.campaign_id ?? null,
      campaign_name: campaignNameFor(offer?.campaign_id ?? null),
      campaign_influencer_id: offer?.campaign_influencer_id ?? null,
      ref: `escalation-${a.id}`,
    });
  }

  // 3. Fishy-reply lane (audit actions; target is the creator_offer).
  for (const a of input.audit) {
    if (!FISHY_AUDIT_ACTIONS.includes(a.action)) continue;
    if (retired('fishy', a)) continue;
    const offer = a.target_id ? (offerById.get(a.target_id) ?? null) : null;
    rows.push({
      category: 'fishy_reply',
      at: a.occurred_at,
      what:
        a.action === 'negotiation.fishy_flagged'
          ? 'Reply looked fishy, held for human review'
          : 'A creator reply was unclear, held for human review',
      detail: null,
      who: whoForCi(offer?.campaign_influencer_id ?? null),
      campaign_id: offer?.campaign_id ?? null,
      campaign_name: campaignNameFor(offer?.campaign_id ?? null),
      campaign_influencer_id: offer?.campaign_influencer_id ?? null,
      ref: `fishy-${a.id}`,
    });
  }

  // 4. Failed payment authorizations (includes cap refusals via failure_reason).
  for (const p of input.payments) {
    if (p.status !== 'failed') continue;
    const offer = offerById.get(p.creator_offer_id) ?? null;
    // A null/garbage amount must drop the figure, never render "$NaN".
    const amountUsd = Number(p.amount_usd);
    rows.push({
      category: 'payment_failed',
      at: p.executed_at ?? p.created_at,
      what: Number.isFinite(amountUsd)
        ? `Payment of $${amountUsd.toFixed(2)} failed`
        : 'Payment failed',
      detail: paymentFailureCopy(p.failure_reason),
      who: whoForCi(offer?.campaign_influencer_id ?? null),
      campaign_id: p.campaign_id,
      campaign_name: campaignNameFor(p.campaign_id),
      campaign_influencer_id: offer?.campaign_influencer_id ?? null,
      ref: `payment-${p.id}`,
    });
  }

  // 5. Deliveries that failed the spec check.
  for (const d of input.deliveries) {
    if (d.spec_check !== 'fail') continue;
    const offer = offerById.get(d.creator_offer_id) ?? null;
    rows.push({
      category: 'delivery_spec_failed',
      at: d.detected_at ?? d.created_at,
      what: 'Delivered post failed the agreed-spec check',
      detail: cleanDetail(d.spec_check_detail),
      who: whoForCi(offer?.campaign_influencer_id ?? null),
      campaign_id: offer?.campaign_id ?? null,
      campaign_name: campaignNameFor(offer?.campaign_id ?? null),
      campaign_influencer_id: offer?.campaign_influencer_id ?? null,
      ref: `delivery-${d.id}`,
    });
  }

  // 6. Stalled negotiations: strictly more than 7 days without movement while
  //    the ball is in the creator's (or negotiator's) court. updated_at is
  //    trigger-touched on every transition (migration 009), so it's a
  //    faithful last-activity stamp. Exactly 7 days is NOT stalled.
  for (const o of input.offers) {
    if (!STALL_STATUSES.includes(o.status)) continue;
    const idleMs = nowMs - Date.parse(o.updated_at);
    if (!(idleMs > STALL_THRESHOLD_MS)) continue;
    const idleDays = Math.floor(idleMs / (24 * 60 * 60 * 1000));
    rows.push({
      category: 'stalled_negotiation',
      at: o.updated_at,
      what: `Negotiation stalled: ${offerStatusCopy(o.status)}, no movement for ${idleDays} days`,
      detail:
        o.current_offer_usd != null
          ? `Standing offer $${Number(o.current_offer_usd).toFixed(2)}`
          : null,
      who: whoForCi(o.campaign_influencer_id),
      campaign_id: o.campaign_id,
      campaign_name: campaignNameFor(o.campaign_id),
      campaign_influencer_id: o.campaign_influencer_id,
      ref: `stall-${o.id}`,
    });
  }

  // 8. Closed deals carrying no contract. contract_templates having zero rows
  //    made generateOfferContract a no-op, so the acceptance email went out
  //    with nothing binding attached and NO signal anywhere — the deal looked
  //    identical to a covered one. Same lane now as any other "needs eyes".
  for (const o of input.offers) {
    if (!CLOSED_STATUSES.includes(o.status)) continue;
    if (o.contract_generated_at) continue;
    rows.push({
      category: 'contract_missing',
      at: o.updated_at,
      what: 'Deal closed with no contract attached',
      detail: input.hasContractTemplate
        ? 'The contract template has a placeholder Creator Campaigns cannot fill, so nothing was sent. Fix the template on the settings page.'
        : 'No contract template saved, so the acceptance email carried no agreement terms. Save one on the settings page.',
      who: whoForCi(o.campaign_influencer_id),
      campaign_id: o.campaign_id,
      campaign_name: campaignNameFor(o.campaign_id),
      campaign_influencer_id: o.campaign_influencer_id,
      ref: `contract-${o.id}`,
    });
  }

  // 9. Bounced / spam-flagged outreach (webhook-written since the
  //    provider_message_id correlation fix). A bounce means every further
  //    message to this creator is wasted send quota and a dead thread — the
  //    label should fix the address or drop the lead.
  for (const b of input.bounced ?? []) {
    const ci = b.campaign_influencer_id ? ciById.get(b.campaign_influencer_id) : null;
    rows.push({
      category: 'bounced_email',
      at: b.sent_at ?? b.created_at,
      what:
        b.delivery_status === 'complained'
          ? 'Recipient marked an outreach email as spam'
          : 'Outreach email bounced: the address is unusable',
      detail: b.sent_to ? `Sent to ${b.sent_to}` : null,
      who: whoForCi(b.campaign_influencer_id),
      campaign_id: ci?.campaign_id ?? null,
      campaign_name: campaignNameFor(ci?.campaign_id ?? null),
      campaign_influencer_id: b.campaign_influencer_id,
      ref: `bounce-${b.id}`,
    });
  }

  // 10. Stalled negotiation tick. The loop is supposed to beat every ~5 min
  //     (tick_runs, migration 044); >15 min of silence means counters are not
  //     going out and inbound replies are not being processed — invisible from
  //     every per-deal surface, so it gets its own lane. Only fires when the
  //     caller could actually read a last-run fact (see AnomalyTickInput).
  if (input.tick?.last_negotiation_run_at) {
    const lastMs = Date.parse(input.tick.last_negotiation_run_at);
    if (Number.isFinite(lastMs) && nowMs - lastMs > STALLED_TICK_THRESHOLD_MS) {
      const idleMin = Math.floor((nowMs - lastMs) / 60_000);
      rows.push({
        category: 'stalled_tick',
        at: input.tick.last_negotiation_run_at,
        what: `Negotiation loop has not run for ${idleMin} minutes`,
        detail:
          'Scheduled counters and inbound replies are not being processed. Check the cron scheduler.',
        who: null,
        campaign_id: null,
        campaign_name: null,
        campaign_influencer_id: null,
        ref: 'stalled-tick-negotiation',
      });
    }
  }

  // 11. Money anomalies from audit_log (see MONEY_ANOMALY_AUDIT_ACTIONS).
  //
  // Held promo packs: one row per deal (the newest hold), and none once the
  // deal is resolved — a promo_materials message exists for the lead, or a
  // withheld-do-not-contact decision was recorded at/after the newest hold.
  const promoSent = new Set(input.promoSentCiIds ?? []);
  const newestHold = new Map<string, string>();
  const newestWithheld = new Map<string, string>();
  for (const a of input.moneyAudit ?? []) {
    if (a.target_type !== 'creator_offer' || !a.target_id) continue;
    const m =
      a.action === PROMO_HELD_ACTION
        ? newestHold
        : a.action === PROMO_WITHHELD_ACTION
          ? newestWithheld
          : null;
    if (!m) continue;
    const prev = m.get(a.target_id);
    if (!prev || a.occurred_at > prev) m.set(a.target_id, a.occurred_at);
  }
  const emittedHold = new Set<string>();
  // Mint failures: newest per deal, and only while the gap is still open.
  const newestMintFail = new Map<string, string>();
  for (const a of input.moneyAudit ?? []) {
    if (!PAYMENT_MINT_FAILED_ACTIONS.includes(a.action) || !a.target_id) continue;
    const prev = newestMintFail.get(a.target_id);
    if (!prev || a.occurred_at > prev) newestMintFail.set(a.target_id, a.occurred_at);
  }
  const legsByOffer = new Map<string, NonNullable<AnomaliesInput['offerLegs']>>();
  for (const l of input.offerLegs ?? []) {
    const list = legsByOffer.get(l.creator_offer_id) ?? [];
    list.push(l);
    legsByOffer.set(l.creator_offer_id, list);
  }
  const mintGapOpen = (action: string, offerId: string): boolean => {
    const offer = offerById.get(offerId);
    if (!offer) return false;
    const legs = legsByOffer.get(offerId) ?? [];
    if (action === AUTOMINT_FAILED_ACTION_LITERAL) {
      return (
        offer.status === 'human_approval_required' &&
        !legs.some((l) => normalizeLeg(l.leg) !== 'balance' && legAccountsForPayment(l))
      );
    }
    return offer.status === 'posted' && !legs.some((l) => normalizeLeg(l.leg) === 'balance' && legAccountsForPayment(l));
  };
  const emittedMint = new Set<string>();
  // Per-payment flags: newest row per payment carries the state; the oldest
  // gives first-seen; the count is how often it was raised.
  const flagAgg = new Map<string, { newest: ThreadAuditRow; firstAt: string; count: number }>();
  for (const a of input.moneyAudit ?? []) {
    if (!RECONCILE_FLAG_ACTIONS.includes(a.action) || !a.target_id) continue;
    const prev = flagAgg.get(a.target_id);
    if (!prev) {
      flagAgg.set(a.target_id, { newest: a, firstAt: a.occurred_at, count: 1 });
      continue;
    }
    prev.count += 1;
    if (a.occurred_at < prev.firstAt) prev.firstAt = a.occurred_at;
    if (a.occurred_at > prev.newest.occurred_at || (a.occurred_at === prev.newest.occurred_at && a.id > prev.newest.id)) {
      prev.newest = a;
    }
  }
  for (const a of input.moneyAudit ?? []) {
    const copy = moneyAnomalyCopy(a);
    if (!copy) continue;
    let flag: { firstAt: string; count: number } | null = null;
    if (RECONCILE_FLAG_ACTIONS.includes(a.action)) {
      const agg = a.target_id ? flagAgg.get(a.target_id) : undefined;
      if (!agg || agg.newest !== a) continue;
      flag = agg;
      if (agg.count > 1) {
        copy.detail = `${copy.detail ?? ''} Raised ${agg.count} times since ${agg.firstAt}.`.trim();
      }
    }
    let mintOfferId: string | null = null;
    if (PAYMENT_MINT_FAILED_ACTIONS.includes(a.action)) {
      const oid = a.target_id;
      if (!oid || emittedMint.has(oid) || a.occurred_at !== newestMintFail.get(oid)) continue;
      if (!mintGapOpen(a.action, oid)) continue;
      emittedMint.add(oid);
      mintOfferId = oid;
    }
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const offerId =
      a.target_type === 'creator_offer'
        ? a.target_id
        : metaString(meta, 'creator_offer_id');
    const offer = offerId ? (offerById.get(offerId) ?? null) : null;
    let resendPromoOfferId: string | null = null;
    if (a.action === PROMO_HELD_ACTION) {
      if (!offerId || emittedHold.has(offerId)) continue;
      if (a.occurred_at !== newestHold.get(offerId)) continue;
      const ciId = offer?.campaign_influencer_id ?? metaString(meta, 'campaign_influencer_id');
      if (ciId && promoSent.has(ciId)) continue;
      const withheldAt = newestWithheld.get(offerId);
      if (withheldAt && withheldAt >= a.occurred_at) continue;
      emittedHold.add(offerId);
      resendPromoOfferId = offerId;
    }
    const campaignId = offer?.campaign_id ?? metaString(meta, 'campaign_id');
    rows.push({
      category: 'payment_anomaly',
      at: a.occurred_at,
      what: copy.what,
      detail: copy.detail,
      who: whoForCi(offer?.campaign_influencer_id ?? null),
      campaign_id: campaignId,
      campaign_name: campaignNameFor(campaignId),
      campaign_influencer_id: offer?.campaign_influencer_id ?? null,
      ref: flag ? `money-flag-${a.target_id}` : `money-${a.id}`,
      ...(flag ? { first_seen_at: flag.firstAt, occurrences: flag.count } : {}),
      ...(resendPromoOfferId ? { resend_promo_offer_id: resendPromoOfferId } : {}),
      ...(mintOfferId ? { mint_payment_offer_id: mintOfferId } : {}),
    });
  }

  // 12. Payments stuck in 'executing'. A claim is followed by at most 300s of
  //     provider calls; past STUCK_EXECUTING_MS nothing is still in flight.
  //     With a claim time, the reclaimer will return it to 'approved' on its
  //     next pass. Without one (pre-055), nothing will — it needs a person.
  //     A row marked outcome-unknown (the transfer call came back ambiguous)
  //     surfaces IMMEDIATELY: the sender already gave up, and the only safe next
  //     step is asking Stripe — which is the row's action.
  for (const p of input.executing ?? []) {
    const sinceIso = p.executing_at ?? p.created_at;
    const sinceMs = Date.parse(sinceIso);
    const unknown = p.failure_reason === OUTCOME_UNKNOWN_FAILURE;
    const stale = Number.isFinite(sinceMs) && nowMs - sinceMs > STUCK_EXECUTING_MS;
    if (!unknown && !stale) continue;
    const offer = offerById.get(p.creator_offer_id) ?? null;
    const amountUsd = Number(p.amount_usd);
    const amount = Number.isFinite(amountUsd) ? `$${amountUsd.toFixed(2)} ` : '';
    rows.push({
      category: 'payment_anomaly',
      at: Number.isFinite(sinceMs) ? sinceIso : p.created_at,
      what: unknown
        ? `Payment of ${amount}: Stripe did not confirm whether it went out`
        : p.executing_at
          ? `Payment of ${amount}stuck mid-send for ${Math.floor((nowMs - sinceMs) / 60_000)} minutes`
          : `Payment of ${amount}stuck mid-send, claim time unknown`,
      detail: unknown
        ? 'Do not retry it: a second send could pay the creator twice. “Check with Stripe” looks the transfer up and resolves it to sent or not sent; the hourly reclaim pass does the same. It counts against every spending cap until then.'
        : p.executing_at
          ? 'The process sending it stopped, so it may or may not have gone out. The next reclaim pass checks with the payment provider; “Check with Stripe” does it now. It counts against every spending cap until then.'
          : 'No claim time is recorded (migration 055 not applied), so it cannot be recovered automatically and counts against every spending cap. Check with Stripe, then resolve it by hand.',
      who: whoForCi(offer?.campaign_influencer_id ?? null),
      campaign_id: p.campaign_id,
      campaign_name: campaignNameFor(p.campaign_id),
      campaign_influencer_id: offer?.campaign_influencer_id ?? null,
      ref: `stuck-${p.id}`,
      check_stripe_payment_id: p.id,
    });
  }

  rows.sort((a, b) => (a.at === b.at ? (a.ref < b.ref ? -1 : 1) : a.at < b.at ? 1 : -1));
  return rows;
}

// ─── Campaign state header ───────────────────────────────────────────────────

export interface CampaignStateInput {
  /** campaigns.total_budget_usd ?? campaigns.budget (analytics precedence). */
  budgetUsd: number | null;
  authorizations: { status: string; amount_usd: number }[];
  offers: { status: string }[];
  /** Outbound outreach_messages rows for the campaign's CIs. */
  outreach: { campaign_influencer_id: string; status: string | null }[];
  inbound: { campaign_influencer_id: string | null }[];
  cis: {
    qualification_status: string | null;
    /** Persisted verdict text; attributed to a cause for the split below. */
    qualification_reason?: string | null;
  }[];
  /** Summed latest verified-post views across the campaign's deliveries;
   *  null = no verified reach data yet (CPM is then omitted, never faked). */
  reachViews: number | null;
}

export interface CampaignState {
  budget_total_usd: number | null;
  budget_spent_usd: number;
  deals_total: number;
  deals_by_stage: Record<string, number>;
  contacted: number;
  responded: number;
  /** responded / contacted; null when nothing has been sent yet. */
  response_rate: number | null;
  /** Label CPM to date over verified reach; null when reach is unknown/zero. */
  cpm_usd: number | null;
  qualification: {
    qualified: number;
    excluded: number;
    unreviewed: number;
    /**
     * Why the excluded ones were excluded. Sums to `excluded`. 'other'
     * covers every model-written verdict and every row excluded before the
     * per-firm pool gates existed — unattributable, not guessed at.
     */
    excluded_by: Record<ExclusionCause, number>;
  };
}

export function computeCampaignState(input: CampaignStateInput): CampaignState {
  let spent = 0;
  for (const a of input.authorizations) {
    if (SPENT_STATES.includes(a.status)) spent += Number(a.amount_usd) || 0;
  }
  spent = Math.round((spent + Number.EPSILON) * 100) / 100;

  const byStage: Record<string, number> = {};
  for (const o of input.offers) {
    byStage[o.status] = (byStage[o.status] ?? 0) + 1;
  }

  const contactedCis = new Set<string>();
  for (const m of input.outreach) {
    if (m.status === 'sent') contactedCis.add(m.campaign_influencer_id);
  }
  const respondedCis = new Set<string>();
  for (const m of input.inbound) {
    if (m.campaign_influencer_id != null && contactedCis.has(m.campaign_influencer_id)) {
      respondedCis.add(m.campaign_influencer_id);
    }
  }

  const excludedBy = Object.fromEntries(
    EXCLUSION_CAUSES.map((c) => [c, 0])
  ) as Record<ExclusionCause, number>;
  const qualification = {
    qualified: 0,
    excluded: 0,
    unreviewed: 0,
    excluded_by: excludedBy,
  };
  for (const ci of input.cis) {
    if (ci.qualification_status === 'qualified') qualification.qualified++;
    else if (ci.qualification_status === 'excluded') {
      qualification.excluded++;
      excludedBy[classifyExclusionReason(ci.qualification_reason)]++;
    } else qualification.unreviewed++;
  }

  return {
    budget_total_usd: input.budgetUsd,
    budget_spent_usd: spent,
    deals_total: input.offers.length,
    deals_by_stage: byStage,
    contacted: contactedCis.size,
    responded: respondedCis.size,
    response_rate:
      contactedCis.size > 0 ? respondedCis.size / contactedCis.size : null,
    cpm_usd:
      input.reachViews != null && input.reachViews > 0
        ? labelCpm(spent, input.reachViews)
        : null,
    qualification,
  };
}
