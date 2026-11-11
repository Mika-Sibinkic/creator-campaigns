// src/lib/resend-events.ts
//
// Pure mapping layer for the Resend delivery webhook.
// The route (src/app/api/webhooks/resend/route.ts) does signature
// verification and the DB write; everything that decides WHAT to write lives
// here so tests/resend-correlation.test.ts can drive it without a server.
//
// Correlation contract: outreach_messages.provider_message_id carries
// Resend's own email id, stamped at send time (send route + the negotiation
// tick's dispatch pass). The webhook matches on THAT column — never on the
// internal outreach_messages.id, which lives in a different id space (the
// original bug: the two were compared and no status ever landed).
//
// DESTINATION contract (migration 046): these values are written to
// outreach_messages.DELIVERY_STATUS, never to outreach_messages.status.
// `status` is the send lifecycle (draft → queued → sent) and six analytics /
// performance readers use status='sent' as a denominator — writing 'opened'
// there removes engaged creators from the denominator while leaving them in
// the numerator, which pushes response_conversion_rate above 1.0 and
// eventually to null. Delivery state is an orthogonal axis, not a later value
// of the same one.

/** Resend webhook event type → outreach_messages.status, or null = ignore. */
export function resendEventToStatus(type: string): string | null {
  switch (type) {
    case 'email.bounced':
    case 'email.bounce':
      return 'bounced';
    case 'email.complained':
    case 'email.complaint':
      return 'complained';
    case 'email.delivered':
      return 'delivered';
    case 'email.opened':
      return 'opened';
    case 'email.clicked':
      return 'clicked';
    default:
      return null;
  }
}

// Delivery statuses ranked by information value. Webhook events can arrive
// out of order (Svix retries, races), so a write is only allowed when it does
// not DOWNGRADE what we already know: a late 'delivered' must never erase an
// 'opened', and nothing may erase a terminal 'bounced'/'complained'. Statuses
// outside this map ('sent', 'queued', null…) rank 0 and accept any event.
const DELIVERY_RANK: Record<string, number> = {
  delivered: 1,
  opened: 2,
  clicked: 3,
  bounced: 4,
  complained: 4,
};

/** May `next` (a webhook-derived status) overwrite the row's `current`? */
export function mayOverwriteStatus(current: string | null, next: string): boolean {
  const cur = current ? (DELIVERY_RANK[current] ?? 0) : 0;
  const nxt = DELIVERY_RANK[next] ?? 0;
  // Equal rank is allowed: a retried event re-writing the same status is
  // idempotent, and bounced↔complained are both terminal-bad.
  return nxt >= cur;
}

/**
 * Every delivery_status value that `next` is allowed to overwrite — i.e. the
 * set for which mayOverwriteStatus(x, next) is true.
 *
 * This exists because checking the rank in JS is not enough. The webhook does
 * SELECT → decide → UPDATE, and two Svix deliveries racing can both read the
 * same pre-state: an `email.opened` and a late `email.delivered` each see
 * NULL, each decide they may write, and the delivered lands second — exactly
 * the downgrade the rank guard exists to prevent. The caller turns this list
 * into a predicate ON the UPDATE, so the database rejects the losing write
 * instead of the two of them agreeing separately.
 *
 * NULL is always permitted and is handled by the caller (a NULL
 * delivery_status ranks 0, and SQL `IN` never matches NULL).
 */
export function allowedPreviousDeliveryStatuses(next: string): string[] {
  const nxt = DELIVERY_RANK[next] ?? 0;
  return Object.keys(DELIVERY_RANK).filter((s) => DELIVERY_RANK[s] <= nxt);
}
