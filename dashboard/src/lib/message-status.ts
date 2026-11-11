// src/lib/message-status.ts
//
// The vocabulary of `outreach_messages.status`, in one place.
//
// This module exists because a review found `window_closed` — the status the
// campaign window writes when a queued message can never legally be sent — was
// an ORPHAN. It was written in exactly one place and read in none. The
// consequences were all invisible, which is what made it dangerous:
//
//   * `/outreach` never declared `status` on its message type, so a closed row
//     rendered as an ordinary unsent draft and the Send button stayed live.
//     Clicking it re-sent the message and overwrote the status with 'sent',
//     silently undoing the window.
//   * two screens rendered the raw column, producing the literal text
//     `Window_closed` in the UI (CSS `capitalize` does not break on `_`).
//   * an end-to-end harness counted `status='queued'` to prove the
//     negotiation loop is alive, so a closed row vanished from its view and
//     the proof read healthy while the loop was dead.
//
// The lesson: a new terminal state is not "written" until something READS it.
// Adding the write was the easy half and on its own it was worse than nothing,
// because it moved rows into a state the whole application treated as normal.
//
// ── The column ──────────────────────────────────────────────────────────────
//
// `outreach_messages.status` is free text with no CHECK — migration 019 said
// so deliberately, and 046 kept it that way. This module is therefore a
// CONVENTION, not an enforcement point: it cannot stop a bad write, it can
// only make sure every reader agrees on what the legal values mean.
//
// Distinct from TWO other columns it is easy to confuse:
//   * `campaign_influencers.outreach_status` — the per-CREATOR reply state
//     machine (src/lib/outreach-status.ts). Different axis, different values.
//   * `outreach_messages.delivery_status` — what the email PROVIDER reported
//     after the send was handed over (migration 046). Never write a delivery event into status.

/**
 * Every legal value of `outreach_messages.status`.
 *
 *   draft          written, never queued. The default (migration 005).
 *   queued         scheduled; the tick's due-scan owns it.
 *   sent           handed to a provider. TERMINAL.
 *   failed         the provider rejected it (promo-materials).
 *   window_closed  the campaign window ended before it could legally send.
 *                  TERMINAL and deliberately NOT 'sent' — nothing was
 *                  delivered, and the six analytics readers that use
 *                  status='sent' as a denominator must not count it.
 *   superseded     a holding note ("back to you in 15 minutes") dropped at
 *                  dispatch because its real reply could no longer follow it
 *                  inside the promise (src/lib/holding-note.ts), or ANY queued
 *                  outbound to a creator who opted out before it went
 *                  (firm-blocks.ts cancelQueuedOutboundForOptOut). TERMINAL
 *                  and unsent: sending it later, by hand or otherwise, would be
 *                  a promise with nothing behind it, or a message to someone
 *                  who asked us to stop.
 *   recorded       a 'price_record' row, the price an operator
 *                  quoted the creator OUTSIDE Creator Campaigns, written when they
 *                  resume automation (negotiation-takeover.ts). A note for the
 *                  thread's record, never a message: TERMINAL and unsent, so
 *                  no path may ever send its text to the creator.
 */
export const MESSAGE_STATUS_VALUES = [
  'draft',
  'queued',
  'sent',
  'failed',
  'window_closed',
  'superseded',
  'recorded',
] as const;

export type MessageStatus = (typeof MESSAGE_STATUS_VALUES)[number];

/**
 * Terminal states — a message here will never be sent by any path, and no UI
 * may offer to send it.
 */
export const TERMINAL_MESSAGE_STATUSES = ['sent', 'failed', 'window_closed', 'superseded', 'recorded'] as const;

/**
 * Terminal WITHOUT anything having been delivered. The distinction matters for
 * reporting: `sent` is a success, `window_closed` is a deliberate non-send that
 * must be visible as such rather than blending into the draft pool.
 */
export const TERMINAL_UNSENT_MESSAGE_STATUSES = ['failed', 'window_closed', 'superseded', 'recorded'] as const;

export const MESSAGE_STATUS_LABELS: Record<string, string> = {
  draft: 'draft',
  queued: 'queued',
  sent: 'sent',
  failed: 'failed',
  window_closed: 'window closed',
  superseded: 'superseded',
  recorded: 'recorded by you, not sent',
};

/**
 * Label-readable form. Falls back to de-underscoring anything unknown, so a
 * value this module has not caught up with still renders as words rather than
 * as `some_raw_token` — the exact defect that produced `Window_closed` on the
 * influencer page.
 */
export function messageStatusLabel(status: string | null | undefined): string {
  if (!status) return 'draft';
  return MESSAGE_STATUS_LABELS[status] ?? status.replace(/_/g, ' ');
}

/**
 * True when the campaign window closed this message out. The single predicate
 * every refusal path should use, so the string literal lives in one file.
 */
export function isWindowClosed(status: string | null | undefined): boolean {
  return status === 'window_closed';
}

/**
 * True when a holding note was dropped instead of sent (src/lib/holding-note.ts).
 * The manual send route refuses these, the same way it refuses window_closed.
 */
export function isSuperseded(status: string | null | undefined): boolean {
  return status === 'superseded';
}

/**
 * True when a message can still be sent by a human or a scheduler. `null` and
 * `'draft'` are sendable (the column default predates most writers); the three
 * terminal states are not.
 *
 * NOTE this is about the MESSAGE's own state only. Callers still apply the
 * pool gates, the DM-queue routing rule and the stale-draft rule on top.
 */
export function isSendableMessageStatus(status: string | null | undefined): boolean {
  if (!status) return true;
  return !(TERMINAL_MESSAGE_STATUSES as readonly string[]).includes(status);
}
