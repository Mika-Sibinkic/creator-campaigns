// src/lib/dm-mark-sent.ts
//
// The `mark_sent` branch of PATCH /api/outreach/messages/[id] for
// send_mode='human_queue' rows, extracted so it EXECUTES in tests
// instead of being pinned by source greps.
//
// A human sent this DM by hand from the label's own account; this records it:
// sent flip + lead advance + social_send_events audit row + 'sent' prior + a
// PRICED negotiable offer (channel-priors.markHumanQueueSent). None of that can
// be undone, so every gate runs first, in this order:
//
//   1. dmMarkSentRefusal — already sent / window closed / terminal / held (409)
//   2. ownership        — the message's firm must be the caller's (403). Before
//                         the block check, so a foreign caller learns nothing
//                         about another label's do-not-contact list.
//   3. do-not-contact   — influencers.blocklisted OR this firm's
//                         firm_influencer_blocks row (src/lib/firm-blocks.ts).
//                         'blocked' → 409; 'unknown' (list unreadable) → 503,
//                         fail closed. Applies to rows queued BEFORE the block
//                         too: a STOP after drafting still stops the send.
//   4. first touch      — the campaign's outreach limit and budget pacing
//                         (src/lib/first-touch-gate.ts). 409, or 503 unreadable.
//                         Re-counted after the sent flip. Skipped for a row
//                         holding a live first-touch reservation (its slot is
//                         already counted — src/lib/dm-reservation.ts).

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  firmIdForCampaignInfluencer,
  markHumanQueueSent,
  toPriorChannel,
} from './channel-priors';
import { channelToPlatform } from './social-dispatch';
import type { ContactChannel } from './contact-discovery';
import { checkDoNotContact } from './firm-blocks';
import { checkFirstTouch, type GateRefusal } from './first-touch-gate';
import { applySentCounterPrice } from './last-sent-offer';
import { isMissingColumnError } from './holding-note';
import { DM_RESERVED_AT_COLUMN, reservationLive } from './dm-reservation';
import { DM_REFUSAL_HTTP_STATUS, dmMarkSentRefusal } from '@/app/outreach/dm-queue-guards';

export type DmMarkSentOutcome =
  /** Not a human_queue row (or not found) — the caller takes the email path. */
  | { kind: 'not_human_queue' }
  | { kind: 'response'; status: number; body: Record<string, unknown> };

export const DM_DO_NOT_CONTACT_MESSAGE =
  "This creator is on your label's do-not-contact list (they opted out, or someone blocked them), " +
  "so this DM can't be recorded as sent. Don't send it.";

export const DM_BLOCK_UNREADABLE_MESSAGE =
  "Couldn't confirm this creator hasn't opted out of your label's outreach, so nothing was recorded. " +
  "Don't send the DM yet. Try again in a minute.";

/** A first-touch gate refusal as this route's answer: a 409 also tells the human not to send. */
function gateRefusalResponse(r: Pick<GateRefusal, 'status' | 'body'>): DmMarkSentOutcome {
  return {
    kind: 'response',
    status: r.status,
    body: r.status === 409 ? { ...r.body, message: `${r.body.message}. Don't send this DM.` } : r.body,
  };
}

/** The DM platform for a message: its own channel when DM-specific, else the
 *  creator's platform (drafts rerouted from the email path carry channel
 *  'email'). Returns null when neither resolves. */
async function resolveDmPlatform(
  sb: SupabaseClient,
  msg: { channel: string | null; campaign_influencer_id: string | null },
): Promise<'instagram' | 'tiktok' | null> {
  const fromChannel = channelToPlatform((msg.channel ?? '') as ContactChannel);
  if (fromChannel) return fromChannel;
  if (!msg.campaign_influencer_id) return null;
  const { data: ci } = await sb
    .from('campaign_influencers')
    .select('influencer_id')
    .eq('id', msg.campaign_influencer_id)
    .maybeSingle();
  const influencerId = (ci as { influencer_id: string } | null)?.influencer_id;
  if (!influencerId) return null;
  const { data: inf } = await sb
    .from('influencers')
    .select('platform')
    .eq('id', influencerId)
    .maybeSingle();
  const platform = (inf as { platform: string | null } | null)?.platform;
  return platform === 'instagram' || platform === 'tiktok' ? platform : null;
}

export async function recordHumanDmSend(
  sb: SupabaseClient,
  input: { messageId: string; callerFirmId: string | null | undefined; nowMs?: number },
): Promise<DmMarkSentOutcome> {
  const nowMs = input.nowMs ?? Date.now();
  // `status` and `send_after` are selected because the guards need them —
  // their absence was how a window_closed row got resurrected through this
  // door (see dm-queue-guards.ts).
  // dm_reserved_at (migration 060) is read when it exists: a row holding a
  // first-touch reservation skips the limit/budget gate below.
  const readMsg = (cols: string) =>
    sb.from('outreach_messages').select(cols).eq('id', input.messageId).maybeSingle();
  const BASE_COLS = 'id, campaign_influencer_id, channel, send_mode, sent_at, status, send_after';
  let { data: msgRow, error: msgErr } = await readMsg(`${BASE_COLS}, ${DM_RESERVED_AT_COLUMN}`);
  if (msgErr && isMissingColumnError(msgErr)) ({ data: msgRow, error: msgErr } = await readMsg(BASE_COLS));
  const mr = msgRow as unknown as {
    id: string;
    campaign_influencer_id: string | null;
    channel: string | null;
    send_mode: string | null;
    sent_at: string | null;
    status: string | null;
    send_after: string | null;
    dm_reserved_at?: string | null;
  } | null;
  if (mr?.send_mode !== 'human_queue') return { kind: 'not_human_queue' };

  // 1. One predicate, shared with the button that produced this request.
  const refusal = dmMarkSentRefusal(mr, nowMs);
  if (refusal) {
    return {
      kind: 'response',
      status: DM_REFUSAL_HTTP_STATUS,
      body: {
        error: refusal.error,
        message: refusal.message,
        ...(refusal.send_after ? { send_after: refusal.send_after } : {}),
      },
    };
  }

  // 2. SEC-1 ownership gate: sb is service-role.
  const ownerFirmId = await firmIdForCampaignInfluencer(sb, mr.campaign_influencer_id);
  if (!ownerFirmId || ownerFirmId !== input.callerFirmId) {
    return { kind: 'response', status: 403, body: { error: 'forbidden' } };
  }

  // 3. Per-label do-not-contact, at the last door.
  const dnc = await checkDoNotContact(sb, {
    firmId: ownerFirmId,
    campaignInfluencerId: mr.campaign_influencer_id,
  });
  if (dnc.verdict === 'blocked') {
    return {
      kind: 'response',
      status: DM_REFUSAL_HTTP_STATUS,
      body: { error: 'do_not_contact', message: DM_DO_NOT_CONTACT_MESSAGE },
    };
  }
  if (dnc.verdict === 'unknown') {
    console.error('[dm-mark-sent] do-not-contact unconfirmed — refusing to record the send', {
      messageId: mr.id,
      detail: dnc.detail,
    });
    return {
      kind: 'response',
      status: 503,
      body: { error: 'block_list_unreadable', message: DM_BLOCK_UNREADABLE_MESSAGE },
    };
  }

  // 4. Mini-run limit + budget pacing (src/lib/first-touch-gate.ts), first
  //    touch only. Recording this send opens a priced offer, so past the
  //    campaign's limit or budget it is refused like a do-not-contact: the
  //    human is told not to send the DM. Unreadable → 503, nothing recorded.
  //    A first touch is re-counted after the sent flip (markHumanQueueSent).
  //    A row holding a live reservation (Reserve & copy, src/lib/dm-reserve.ts)
  //    already holds its slot: the human was handed the text only once the
  //    slot was counted, so this never refuses it for limit or budget.
  let isFirstTouch = false;
  const reserved = reservationLive(mr.dm_reserved_at, nowMs);
  if (mr.campaign_influencer_id && !reserved) {
    const firstTouch = await checkFirstTouch(sb, mr.campaign_influencer_id, nowMs);
    if (!firstTouch.ok) return gateRefusalResponse(firstTouch);
    isFirstTouch = firstTouch.firstTouch;
  }

  // Ledger channel: the message's own DM channel when specific, else the
  // creator's platform (rerouted email-channel drafts).
  let channel: string | null = toPriorChannel(mr.channel);
  if (!channel || channel === 'email') {
    channel = toPriorChannel(await resolveDmPlatform(sb, mr));
  }
  const result = await markHumanQueueSent(sb, {
    messageId: mr.id,
    campaignInfluencerId: mr.campaign_influencer_id,
    firmId: ownerFirmId,
    channel,
    nowMs,
    ...(isFirstTouch ? { firstTouchRecheck: { restore: { status: mr.status, send_after: mr.send_after } } } : {}),
  });
  if (!result.ok) {
    // 'already_sent' comes from the conditional update in markHumanQueueSent —
    // the real idempotency guard. Losing that race is not a server error.
    if (result.error === 'already_sent') {
      return { kind: 'response', status: 409, body: { error: 'already sent' } };
    }
    if (result.refusal) return gateRefusalResponse(result.refusal);
    return { kind: 'response', status: 500, body: { error: result.error } };
  }
  // A human-edited counter quotes its own price; once it has gone, that is
  // the offer's standing price. No-op for any other message.
  await applySentCounterPrice(sb, mr.id);
  return { kind: 'response', status: 200, body: { ok: true, human: true, sent_at: result.sent_at } };
}
