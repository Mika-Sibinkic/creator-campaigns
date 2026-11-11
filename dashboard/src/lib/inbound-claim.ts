// src/lib/inbound-claim.ts
//
// One negotiation tick per creator reply.
//
// THE RACE
//   The negotiation tick (*/5, maxDuration 300s) is fired by pg_net, which does
//   not wait for a response, so two runs can overlap. Both SELECT the same
//   pending inbound_messages row, both run autoNegotiateInbound, and both queue
//   a counter. The creator gets two offers for one message, and the offer
//   advances two rounds. The holding note's unique index (migration 057) only
//   stops the second NOTE. This stops the second everything.
//
// THE FIX
//   Before processing, a tick CLAIMS the row with a conditional UPDATE that
//   only one writer can win:
//
//     UPDATE inbound_messages SET claimed_at = now
//      WHERE id = $1 AND status IN ('new','classified') AND claimed_at IS NULL
//     RETURNING id
//
//   If no row comes back, a second conditional UPDATE takes over a STALE claim
//   (claimed_at older than INBOUND_CLAIM_TTL_MS). The owner crashed, and without
//   this the reply would be stranded forever. Postgres re-checks the WHERE
//   after waiting on the row lock, so two ticks racing for the same stale claim
//   still produce one winner. Once processed, the row leaves the pending
//   statuses and the claim is moot. A poison row that throws RELEASES its
//   claim, so the next tick retries it at once, as it did before claims
//   existed.
//
// WHY A NEW COLUMN (claimed_at, migration 057)
//   Existing columns cannot do this. `status` carries a CHECK
//   ('new','classified','flagged','processed'), so a 'processing' state is DDL
//   either way. `received_at` / `received_at_server` are arrival evidence and
//   must not be overwritten. A lease with no timestamp cannot expire, so
//   reclaiming a crashed tick's rows needs one.
//
// BEFORE 057 IS APPLIED
//   The claim UPDATE names a missing column and PostgREST refuses it (PGRST204).
//   That returns 'unguarded', and the tick processes the row exactly as it did
//   before this module existed. The overlap race stays open until 057 is
//   applied, and nothing regresses in the meantime.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingColumnError } from './holding-note';

/** Statuses that mean "this inbound reply has not been negotiated yet." */
export const PENDING_INBOUND_STATUSES = ['new', 'classified'];

/** inbound_messages column holding the claim (migration 057, NOT yet applied). */
export const INBOUND_CLAIM_COLUMN = 'claimed_at' as const;

/**
 * How long a claim protects its row. Twice the tick route's maxDuration (300s):
 * a live tick can never be reclaimed out from under itself, and a crashed one
 * holds the reply up by at most ten minutes.
 */
export const INBOUND_CLAIM_TTL_MS = 10 * 60_000;

/**
 *   claimed    this tick owns the row: process it.
 *   unguarded  057 not applied: process it, as before claims existed.
 *   lost       another tick owns it (or already finished it): skip.
 *   error      the claim itself failed: skip. The row is untouched, so the
 *              next tick retries it.
 */
export type InboundClaim = 'claimed' | 'unguarded' | 'lost' | 'error';

export async function claimInbound(
  sb: SupabaseClient,
  inboundId: string,
  nowMs: number,
): Promise<InboundClaim> {
  const stamp = { [INBOUND_CLAIM_COLUMN]: new Date(nowMs).toISOString() };

  const fresh = await sb
    .from('inbound_messages')
    .update(stamp as never)
    .eq('id', inboundId)
    .in('status', PENDING_INBOUND_STATUSES)
    .is(INBOUND_CLAIM_COLUMN, null)
    .select('id')
    .maybeSingle();
  if (fresh.error) return isMissingColumnError(fresh.error) ? 'unguarded' : 'error';
  if (fresh.data) return 'claimed';

  const stale = await sb
    .from('inbound_messages')
    .update(stamp as never)
    .eq('id', inboundId)
    .in('status', PENDING_INBOUND_STATUSES)
    .lt(INBOUND_CLAIM_COLUMN, new Date(nowMs - INBOUND_CLAIM_TTL_MS).toISOString())
    .select('id')
    .maybeSingle();
  if (stale.error) return isMissingColumnError(stale.error) ? 'unguarded' : 'error';
  return stale.data ? 'claimed' : 'lost';
}

/**
 * Give a claim back so the next tick retries the row immediately. Best-effort:
 * if it fails, the claim simply expires after INBOUND_CLAIM_TTL_MS.
 */
export async function releaseInboundClaim(sb: SupabaseClient, inboundId: string): Promise<void> {
  try {
    await sb
      .from('inbound_messages')
      .update({ [INBOUND_CLAIM_COLUMN]: null } as never)
      .eq('id', inboundId);
  } catch {
    /* expires on its own */
  }
}
