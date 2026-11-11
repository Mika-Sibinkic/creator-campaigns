// src/lib/dm-reserve.ts
//
// Reserve-before-copy for DM first touches: the DB half. Why it exists, and
// the reservation's lifecycle: src/lib/dm-reservation.ts.
//
//   reserveDmFirstTouch          POST /api/outreach/messages/[id]/reserve
//   releaseExpiredDmReservations the negotiation tick (*/5): clears + audits
//   stampFirstTouchSlots         the outreach listing: "Limit reached" up front
//
// THE RESERVATION IS A CLAIM, THEN A RECOUNT — the same shape the email send
// route and the dispatch pass use (src/lib/first-touch-gate.ts
// recheckFirstTouchAfterClaim). checkFirstTouch is a read, so two reserves in
// flight both see the last free slot. The claim (a compare-and-swap on
// outreach_messages.dm_reserved_at) is a committed write that makes the thread
// read as contacted, so a recount after it sees every rival that claimed
// first: of two racers the later recount refuses and releases. That holds
// across server instances because Postgres arbitrates it.
//
// The recount alone can refuse BOTH racers (each sees the other). Within one
// server instance reserves for the same campaign are also run one at a time
// (withCampaignLock), so N simultaneous reserves against L free slots give
// exactly L. Across instances the worst case stays "refused, try again",
// never "past the limit"; a refused reserve hands over no text, so no DM goes
// out unrecorded either way.

import type { SupabaseClient } from '@supabase/supabase-js';
import { checkDoNotContact } from './firm-blocks';
import {
  checkCampaignFirstTouchSlot,
  checkFirstTouch,
  readCampaignContacts,
  recheckFirstTouchAfterClaim,
  type FirstTouchVerdict,
} from './first-touch-gate';
import { isMissingColumnError } from './holding-note';
import {
  DM_RESERVATION_TTL_MS,
  DM_RESERVED_AT_COLUMN,
  awaitsFirstTouchSlot,
  isReplyOnlyMessageType,
  reservationExpiresAt,
  reservationLive,
  type FirstTouchSlotStamp,
} from './dm-reservation';
import { DM_REFUSAL_HTTP_STATUS, dmMarkSentRefusal } from '@/app/outreach/dm-queue-guards';
import type { AuditEntry } from './audit';

export interface DmReserveOutcome {
  status: number;
  body: Record<string, unknown>;
}

export const DM_RESERVE_DO_NOT_CONTACT_MESSAGE =
  "This creator is on your label's do-not-contact list: they opted out, or someone blocked them. Don't DM them.";
export const DM_RESERVE_BLOCK_UNREADABLE_MESSAGE =
  "Couldn't confirm this creator hasn't opted out of your label's outreach, so no slot was reserved. Try again in a minute.";
export const DM_RESERVE_UNAVAILABLE_MESSAGE =
  'Slot reservations are not switched on for this workspace yet. Copy the draft directly.';
export const DM_RESERVE_LOST_MESSAGE = 'This DM changed while the slot was being reserved. Reload and try again.';

// ── One reserve at a time per campaign, per server instance ────────────────
const campaignLocks = new Map<string, Promise<void>>();

async function withCampaignLock<T>(campaignId: string, fn: () => Promise<T>): Promise<T> {
  const prev = campaignLocks.get(campaignId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  campaignLocks.set(campaignId, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (campaignLocks.get(campaignId) === tail) campaignLocks.delete(campaignId);
  }
}

function gateRefusal(v: Exclude<FirstTouchVerdict, { ok: true }>): DmReserveOutcome {
  return { status: v.status, body: v.body };
}

interface ReserveRow {
  id: string;
  campaign_influencer_id: string | null;
  send_mode: string | null;
  message_type: string | null;
  sent_at: string | null;
  status: string | null;
  send_after: string | null;
  body: string;
  dm_reserved_at: string | null;
}

const RESERVE_COLS = `id, campaign_influencer_id, send_mode, message_type, sent_at, status, send_after, body, ${DM_RESERVED_AT_COLUMN}`;

/** The row, or 'unsupported' pre-060, or null (not found / unreadable). */
async function readReserveRow(sb: SupabaseClient, id: string): Promise<ReserveRow | 'unsupported' | null> {
  const { data, error } = await sb.from('outreach_messages').select(RESERVE_COLS).eq('id', id).maybeSingle();
  if (error) return isMissingColumnError(error) ? 'unsupported' : null;
  const row = data as unknown as ReserveRow | null;
  if (!row) return null;
  return { ...row, dm_reserved_at: row.dm_reserved_at ?? null };
}

function reservedBody(body: string, reservedAt: string): Record<string, unknown> {
  return { reserved: true, body, reserved_at: reservedAt, expires_at: reservationExpiresAt(reservedAt) };
}

/**
 * Reserve a first-touch slot for one DM-queue opener, and only then hand back
 * the text to copy. Gates, in order: row is a sendable human_queue DM (409),
 * ownership (403), do-not-contact (409 / 503 unreadable), then — first touch
 * only — the outreach limit and budget pacing (409 / 503), re-taken after the
 * claim. A reply-only type, or a creator already contacted, needs no slot: the
 * text comes back with reserved:false. A row already holding a live slot
 * returns it again (re-copy).
 *
 * `serialize: false` skips the in-process campaign lock; tests use it to stand
 * in for reserves landing on different server instances.
 */
export async function reserveDmFirstTouch(
  sb: SupabaseClient,
  input: { messageId: string; callerFirmId: string | null | undefined; nowMs?: number; serialize?: boolean },
): Promise<DmReserveOutcome> {
  const nowMs = input.nowMs ?? Date.now();
  const first = await readReserveRow(sb, input.messageId);
  if (first === 'unsupported') {
    return { status: 409, body: { error: 'reservation_unavailable', message: DM_RESERVE_UNAVAILABLE_MESSAGE } };
  }
  if (!first) return { status: 404, body: { error: 'not_found' } };
  if (first.send_mode !== 'human_queue') {
    return { status: 409, body: { error: 'not_dm_queue', message: 'This draft is not in the DM queue.' } };
  }
  const refusal = dmMarkSentRefusal(first, nowMs);
  if (refusal) {
    return {
      status: DM_REFUSAL_HTTP_STATUS,
      body: { error: refusal.error, message: refusal.message, ...(refusal.send_after ? { send_after: refusal.send_after } : {}) },
    };
  }
  const ciId = first.campaign_influencer_id;
  if (!ciId) return { status: 404, body: { error: 'not_found' } };

  // Ownership (sb is service-role).
  const { data: ciRow } = await sb.from('campaign_influencers').select('id, campaign_id').eq('id', ciId).maybeSingle();
  const campaignId = (ciRow as { campaign_id?: string } | null)?.campaign_id ?? null;
  if (!campaignId) return { status: 404, body: { error: 'not_found' } };
  const { data: camp } = await sb.from('campaigns').select('firm_id').eq('id', campaignId).maybeSingle();
  const ownerFirmId = (camp as { firm_id?: string } | null)?.firm_id ?? null;
  if (!ownerFirmId || ownerFirmId !== input.callerFirmId) {
    return { status: 403, body: { error: 'forbidden' } };
  }

  const dnc = await checkDoNotContact(sb, { firmId: ownerFirmId, campaignInfluencerId: ciId });
  if (dnc.verdict === 'blocked') {
    return { status: 409, body: { error: 'do_not_contact', message: DM_RESERVE_DO_NOT_CONTACT_MESSAGE } };
  }
  if (dnc.verdict === 'unknown') {
    return { status: 503, body: { error: 'block_list_unreadable', message: DM_RESERVE_BLOCK_UNREADABLE_MESSAGE } };
  }

  // A reply or counter is never a first touch: no slot, plain copy.
  if (isReplyOnlyMessageType(first.message_type)) {
    return { status: 200, body: { reserved: false, body: first.body } };
  }

  const run = async (): Promise<DmReserveOutcome> => {
    const verdict = await checkFirstTouch(sb, ciId, nowMs);
    if (!verdict.ok) return gateRefusal(verdict);

    // Re-read inside the lock: a rival (or a double-click) may have reserved
    // or recorded this row since the first read.
    const cur = await readReserveRow(sb, input.messageId);
    if (cur === 'unsupported' || !cur) return { status: 409, body: { error: 'reservation_lost', message: DM_RESERVE_LOST_MESSAGE } };
    if (cur.sent_at) {
      return { status: 409, body: { error: 'already sent', message: 'This DM is already marked sent.' } };
    }
    if (reservationLive(cur.dm_reserved_at, nowMs)) {
      return { status: 200, body: { ...reservedBody(cur.body, cur.dm_reserved_at as string), already_held: true } };
    }
    // Already in a conversation: not a first touch, nothing to hold.
    if (!verdict.firstTouch) return { status: 200, body: { reserved: false, body: cur.body } };

    // CLAIM: compare-and-swap on the value just read (null, or a lapsed stamp).
    const stamp = new Date(nowMs).toISOString();
    const claim = sb
      .from('outreach_messages')
      .update({ [DM_RESERVED_AT_COLUMN]: stamp } as never)
      .eq('id', cur.id)
      .is('sent_at', null);
    const { data: claimed, error: claimErr } = await (cur.dm_reserved_at == null
      ? claim.is(DM_RESERVED_AT_COLUMN, null)
      : claim.eq(DM_RESERVED_AT_COLUMN, cur.dm_reserved_at)
    )
      .select('id, body')
      .maybeSingle();
    if (claimErr || !claimed) {
      return { status: 409, body: { error: 'reservation_lost', message: DM_RESERVE_LOST_MESSAGE } };
    }

    // RECOUNT: every rival that claimed before this read is counted.
    const re = await recheckFirstTouchAfterClaim(sb, ciId, nowMs);
    if (!re.ok) {
      await sb
        .from('outreach_messages')
        .update({ [DM_RESERVED_AT_COLUMN]: cur.dm_reserved_at } as never)
        .eq('id', cur.id)
        .eq(DM_RESERVED_AT_COLUMN, stamp)
        .is('sent_at', null);
      return gateRefusal(re);
    }
    return { status: 200, body: reservedBody((claimed as { body: string }).body, stamp) };
  };

  return input.serialize === false ? run() : withCampaignLock(campaignId, run);
}

/**
 * Release every DM reservation that lapsed without a Mark sent, and audit each
 * one. The gate already stopped counting them at expiry (lazy on read); this
 * makes the row state match and leaves a trail. Never throws. Pre-060 → 0.
 */
export async function releaseExpiredDmReservations(
  sb: SupabaseClient,
  nowMs: number,
  auditFn?: (entry: AuditEntry) => Promise<void>,
): Promise<number> {
  try {
    const cutoff = new Date(nowMs - DM_RESERVATION_TTL_MS).toISOString();
    const { data, error } = await sb
      .from('outreach_messages')
      .select(`id, campaign_influencer_id, ${DM_RESERVED_AT_COLUMN}`)
      .lte(DM_RESERVED_AT_COLUMN, cutoff)
      .is('sent_at', null);
    if (error) {
      if (!isMissingColumnError(error)) console.error('[dm-reserve] expired reservations unreadable', error);
      return 0;
    }
    const doAudit = auditFn ?? (await import('./audit')).audit;
    let released = 0;
    for (const r of (data ?? []) as unknown as Array<{ id: string; campaign_influencer_id: string | null; dm_reserved_at: string }>) {
      const { data: rel } = await sb
        .from('outreach_messages')
        .update({ [DM_RESERVED_AT_COLUMN]: null } as never)
        .eq('id', r.id)
        .eq(DM_RESERVED_AT_COLUMN, r.dm_reserved_at)
        .is('sent_at', null)
        .select('id')
        .maybeSingle();
      if (!rel) continue; // marked sent or re-reserved since the read
      released += 1;
      let firmId: string | null = null;
      if (r.campaign_influencer_id) {
        const { firmIdForCampaignInfluencer } = await import('./channel-priors');
        firmId = await firmIdForCampaignInfluencer(sb, r.campaign_influencer_id);
      }
      await doAudit({
        action: 'outreach.dm_reservation.released',
        actor_label: 'system:negotiation-tick',
        target_type: 'outreach_message',
        target_id: r.id,
        firm_id: firmId,
        metadata: {
          campaign_influencer_id: r.campaign_influencer_id,
          reserved_at: r.dm_reserved_at,
          reason: 'not_marked_sent_within_ttl',
          ttl_hours: DM_RESERVATION_TTL_MS / 3_600_000,
        },
      });
    }
    return released;
  } catch (e) {
    console.error('[dm-reserve] releasing expired reservations failed', e);
    return 0;
  }
}

/**
 * Stamp `first_touch_slot` on each listed lead whose DM opener is waiting to
 * be copied (post-060 rows only), so the queue shows "Limit reached" before
 * anyone copies. One gate evaluation per campaign. A campaign whose state
 * cannot be read gets no stamp: the queue then offers Reserve & copy and the
 * server decides. Never throws.
 */
export async function stampFirstTouchSlots(
  sb: SupabaseClient,
  rows: Array<Record<string, unknown>>,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    const byCampaign = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const campaignId = row.campaign_id;
      if (!awaitsFirstTouchSlot(row, nowMs) || typeof campaignId !== 'string') continue;
      if (!byCampaign.has(campaignId)) byCampaign.set(campaignId, []);
      byCampaign.get(campaignId)!.push(row);
    }
    for (const [campaignId, leads] of byCampaign) {
      const contacts = await readCampaignContacts(sb, campaignId, nowMs);
      if (!contacts.ok) continue;
      const fresh = leads.filter((l) => !contacts.contactedIds.has(l.id as string));
      for (const l of leads) {
        if (contacts.contactedIds.has(l.id as string)) l.first_touch_slot = { state: 'contacted' } satisfies FirstTouchSlotStamp;
      }
      if (fresh.length === 0) continue;
      const v = await checkCampaignFirstTouchSlot(sb, campaignId, nowMs);
      let stamp: FirstTouchSlotStamp | null = null;
      if (v.ok) stamp = { state: 'open' };
      else if (v.status === 409) stamp = { state: 'limit_reached', message: v.body.message };
      if (stamp) for (const l of fresh) l.first_touch_slot = stamp;
    }
  } catch (e) {
    console.error('[dm-reserve] first-touch slot stamp failed', e);
  }
}
