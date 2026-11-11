// src/lib/dm-reservation.ts
//
// Reserve-before-copy for DM first touches: the pure, client-safe half. The DB
// half is src/lib/dm-reserve.ts.
//
// WHY. A DM is sent by a human from the label's own account: they copy the
// draft, send it, then click Mark sent. The campaign's outreach limit and
// budget pacing (src/lib/first-touch-gate.ts) could only refuse at Mark sent,
// after the DM was already in the creator's inbox, so a real DM went out and
// was never recorded. Now the copy action of a FIRST-TOUCH opener reserves a
// first-touch slot first ("Reserve & copy"), and the text is only handed over
// once the slot is held. An opener past the limit or budget shows "Limit
// reached" and has no copy button.
//
// A reservation is outreach_messages.dm_reserved_at (migration 060). While it
// is live it counts toward the outreach limit and budget pacing exactly like a
// sent opener (first-touch-gate's "contacted" includes it), and Mark sent on
// that row never refuses for limit or budget: the slot is already held. It
// lapses DM_RESERVATION_TTL_MS after it was taken if the row is not marked
// sent: the gate stops counting it at once, and the negotiation tick clears
// and audits it. Pre-060 the column does not exist, the listing's '*' select
// does not return the key, and the queue copies plainly as before.

export const DM_RESERVED_AT_COLUMN = 'dm_reserved_at' as const;

/** A reservation not marked sent within this long is released. */
export const DM_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Message types that only ever answer a conversation already under way: a
 * counter, an acceptance, a holding note, payout / promo mail after a deal,
 * a logged response, a price record. Never a first touch, whatever the thread
 * shows. Without this, a legacy thread whose opener and offer rows are missing
 * would hold its counter in the dispatch queue every minute, forever.
 * (Defined here so the client can read it; first-touch-gate re-exports it.)
 */
export const REPLY_ONLY_MESSAGE_TYPES = [
  'counter',
  'agreement_confirmation',
  'holding_note',
  'payout_onboarding',
  'promo_materials',
  'response',
  'price_record',
] as const;

export function isReplyOnlyMessageType(t: string | null | undefined): boolean {
  return (REPLY_ONLY_MESSAGE_TYPES as readonly string[]).includes(t ?? '');
}

/** Is a reservation taken at `reservedAt` still holding its slot at `nowMs`? */
export function reservationLive(reservedAt: unknown, nowMs: number): boolean {
  if (typeof reservedAt !== 'string' || !reservedAt) return false;
  const at = Date.parse(reservedAt);
  if (!Number.isFinite(at)) return false;
  return nowMs - at < DM_RESERVATION_TTL_MS;
}

export function reservationExpiresAt(reservedAt: string): string | null {
  const at = Date.parse(reservedAt);
  return Number.isFinite(at) ? new Date(at + DM_RESERVATION_TTL_MS).toISOString() : null;
}

/**
 * Per lead, stamped by the listing (src/lib/dm-reserve.ts stampFirstTouchSlots)
 * on a creator not yet contacted whose DM opener is waiting:
 *   open           a first touch may be reserved now
 *   limit_reached  the outreach limit or budget is used up (message says which)
 *   contacted      the creator is already in a conversation: not a first touch
 * Absent = not computed (the server decides at Reserve & copy).
 */
export type FirstTouchSlotStamp =
  | { state: 'open' }
  | { state: 'contacted' }
  | { state: 'limit_reached'; message: string };

/**
 * What the copy control on one DM-queue row does:
 *   plain     copy the text (pre-060, a reply/counter, a creator already contacted)
 *   reserve   "Reserve & copy": the server holds a first-touch slot, then the text is copied
 *   reserved  this row already holds a slot: copy the text
 *   limit     "Limit reached": no copy
 */
export type DmCopyMode = 'plain' | 'reserve' | 'reserved' | 'limit';

export function dmCopyMode(
  msg: { message_type?: string | null; dm_reserved_at?: string | null },
  slot: FirstTouchSlotStamp | null | undefined,
  nowMs: number,
): DmCopyMode {
  // Pre-060 the listing's select('*') carries no such key.
  if (!Object.prototype.hasOwnProperty.call(msg, DM_RESERVED_AT_COLUMN)) return 'plain';
  if (isReplyOnlyMessageType(msg.message_type)) return 'plain';
  if (reservationLive(msg.dm_reserved_at, nowMs)) return 'reserved';
  if (slot?.state === 'contacted') return 'plain';
  if (slot?.state === 'limit_reached') return 'limit';
  return 'reserve';
}

/**
 * A lead the listing should stamp: it has an unsent post-060 DM opener that
 * is not a reply-only type and holds no live slot.
 */
export function awaitsFirstTouchSlot(row: { messages?: unknown }, nowMs: number): boolean {
  const msgs = (Array.isArray(row.messages) ? row.messages : []) as Array<Record<string, unknown>>;
  return msgs.some(
    (m) =>
      m.direction === 'outbound' &&
      m.send_mode === 'human_queue' &&
      !m.sent_at &&
      Object.prototype.hasOwnProperty.call(m, DM_RESERVED_AT_COLUMN) &&
      !isReplyOnlyMessageType(m.message_type as string | null) &&
      !reservationLive(m[DM_RESERVED_AT_COLUMN], nowMs),
  );
}
