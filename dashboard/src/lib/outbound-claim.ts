// src/lib/outbound-claim.ts
//
// THE send claim for an outreach_messages row, shared by every path that hands
// a row to a provider: the scheduled dispatch pass (negotiation-tick.ts
// dispatchDue) and the manual Send button (POST /api/outreach/[id]/send).
//
// The claim is one UPDATE … WHERE id = ? AND status = <the status read>
// RETURNING the row's current contents. It moves the row to the in-flight state
// (status 'sent', sent_at set, provider_message_id still null) BEFORE the send,
// so Postgres, not a read-then-write in either caller, decides who sends it:
//
//   * two senders racing for one row: exactly one claim returns it; the other
//     sends nothing (the Send button on a queued row and the dispatch pass both emailed it).
//   * an edit racing a send: editOutboundMessage is a compare-and-swap on the
//     same status, so it lands before the claim (and the claim returns it) or
//     is refused with 409. What is sent and what is recorded (offer_usd) both
//     come from the claim's RETURNING, never from an earlier read or a later
//     re-read, so the creator always got the price the row records.
//
// A send that fails releases the claim back to the status it was taken from.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingColumnError } from './holding-note';
import { COUNTER_OFFER_COLUMN, applySentCounterPrice } from './last-sent-offer';

/** The row as the claim found it: exactly what is sent and recorded. */
export interface ClaimedOutbound {
  id: string;
  campaign_influencer_id: string | null;
  subject: string | null;
  body: string;
  channel: string | null;
  send_mode: string | null;
  message_type: string | null;
  edited_by_user: boolean | null;
  offer_usd?: unknown;
}

const CLAIM_COLUMNS =
  'id, campaign_influencer_id, subject, body, channel, send_mode, message_type, edited_by_user';

/**
 * Atomically move one row from `fromStatus` to in-flight ('sent') and return
 * its CURRENT contents. `fromStatus` null claims a row whose status is NULL
 * (the column default predates most writers). No row means someone else
 * claimed it, or it left that status. Pre-059 (no offer_usd column) PostgREST
 * rejects the whole statement before it runs, so the claim is retried without
 * the price column; no price can be on the row then.
 */
export async function claimOutboundRow(
  sb: SupabaseClient,
  id: string,
  nowMs: number,
  fromStatus: string | null = 'queued',
): Promise<{ row: ClaimedOutbound | null; sentAt: string; error: unknown }> {
  const sentAt = new Date(nowMs).toISOString();
  const claim = (cols: string) => {
    const q = sb
      .from('outreach_messages')
      .update({ status: 'sent', sent_at: sentAt, send_after: null } as never)
      .eq('id', id);
    return (fromStatus == null ? q.is('status', null) : q.eq('status', fromStatus)).select(cols).maybeSingle();
  };
  let { data, error } = await claim(`${CLAIM_COLUMNS}, ${COUNTER_OFFER_COLUMN}`);
  if (error && isMissingColumnError(error)) ({ data, error } = await claim(CLAIM_COLUMNS));
  return { row: (data as unknown as ClaimedOutbound | null) ?? null, sentAt, error };
}

/**
 * Put a claimed row back where it was taken from: the status it was claimed
 * from, unsent, with the given send_after. Guarded on the in-flight state so
 * it can never un-send a row another writer has since moved on.
 */
export async function releaseOutboundClaim(
  sb: SupabaseClient,
  id: string,
  restore: { status: string | null; send_after: string | null },
): Promise<void> {
  await sb
    .from('outreach_messages')
    .update({ status: restore.status, sent_at: null, send_after: restore.send_after } as never)
    .eq('id', id)
    .eq('status', 'sent');
}

/** Statuses the manual Send button may claim from (same set the edit route edits). */
export function isManuallySendableStatus(status: string | null | undefined): boolean {
  return status == null || status === 'draft' || status === 'queued';
}

export interface ManualProviderResult {
  ok: boolean;
  message_id?: string | null;
  resolved_to: string;
}

/**
 * The manual route's 409 when the claim is lost. `error` is the exact string
 * the client already keys on for a sent row (dm-queue-tab, outreach-send-copy).
 */
export const MANUAL_SEND_LOST = {
  error: 'already sent',
  message: 'This message is already sending or was sent, so it was not sent again.',
} as const;

/** The manual route's 409 for a status no path may send (failed, recorded, …). */
export const MANUAL_SEND_NOT_SENDABLE = {
  error: 'not_sendable',
  message: 'This message is no longer a draft or queued, so it cannot be sent.',
} as const;

export type ManualSendOutcome<R extends ManualProviderResult> =
  /** The row's status (as read) is not a draft or queued: nothing to claim. */
  | { kind: 'not_sendable' }
  /** The row was not in the status read: another sender has it, or it left. Nothing sent. */
  | { kind: 'lost' }
  /** The claimed row is no longer an auto-email (DM-routed since the read). Released, nothing sent. */
  | { kind: 'not_email' }
  /** The provider refused. Released. */
  | { kind: 'failed'; result: R }
  | { kind: 'sent'; result: R; row: ClaimedOutbound; sentAt: string };

/**
 * MANUAL SEND (POST /api/outreach/[id]/send) after every gate has passed:
 * claim → send exactly the claimed copy → record exactly the claimed price.
 *
 * `from` is the row as the route's gate read it: the claim is conditional on
 * that status, and a failed send restores it (with its send_after, so a queued
 * row keeps its schedule). The final write is conditioned on the in-flight
 * state the claim set.
 */
export async function claimAndSendManual<R extends ManualProviderResult>(
  sb: SupabaseClient,
  input: {
    messageId: string;
    from: { status: string | null; send_after: string | null };
    nowMs: number;
  },
  send: (row: ClaimedOutbound) => Promise<R>,
): Promise<ManualSendOutcome<R>> {
  if (!isManuallySendableStatus(input.from.status)) return { kind: 'not_sendable' };
  const claim = await claimOutboundRow(sb, input.messageId, input.nowMs, input.from.status);
  if (claim.error || !claim.row) return { kind: 'lost' };
  const row = claim.row;

  // Same rule the route's DM-routing guard applied to the pre-claim read,
  // re-applied to the claimed row: this path only ever emails.
  if ((row.channel != null && row.channel !== 'email') || row.send_mode === 'human_queue') {
    await releaseOutboundClaim(sb, row.id, input.from);
    return { kind: 'not_email' };
  }

  const result = await send(row);
  if (!result.ok) {
    await releaseOutboundClaim(sb, row.id, input.from);
    return { kind: 'failed', result };
  }

  // provider_message_id is the only key the delivery webhook matches on.
  await sb
    .from('outreach_messages')
    .update({ sent_to: result.resolved_to, provider_message_id: result.message_id ?? null } as never)
    .eq('id', row.id)
    .eq('status', 'sent')
    .eq('sent_at', claim.sentAt);
  // A price the operator recorded on this message is the standing offer now
  // that the creator has it — recorded from the claimed row, never re-read.
  await applySentCounterPrice(sb, row.id, { ...row, status: 'sent' });
  return { kind: 'sent', result, row, sentAt: claim.sentAt };
}
