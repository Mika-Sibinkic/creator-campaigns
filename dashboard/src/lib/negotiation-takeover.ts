// src/lib/negotiation-takeover.ts
//
// MANUAL MODE: entering it, honouring it, leaving it. The state itself is described in
// ./takeover-state.ts.
//
//   readThreadHold      the tick asks this BEFORE any turn: is a human
//                       handling this thread? Manual mode, a reply still held
//                       for a human on the thread (the fail-safe fallback: an
//                       escalation that could not write the mode is still
//                       manual), or a DM counter sitting unsent in the human
//                       DM queue. Any of them → no model call, no fold, no
//                       agreement, no counter; the reply goes to a human.
//   enterHumanTakeover  every escalation ('flagged' / 'needs_human') puts the
//                       OFFER into manual mode, not just the one reply.
//   resumeAutomation    the only way out: an operator confirms the price they
//                       last quoted the creator. It is recorded on the thread
//                       as the last sent price, the standing offer is set to
//                       it, held replies on the thread are marked reviewed,
//                       and the whole thing is audited.

import type { SupabaseClient } from '@supabase/supabase-js';
import { audit } from './audit';
import {
  COUNTER_OFFER_COLUMN,
  PRICE_RECORD_MESSAGE_TYPE,
  PRICE_RECORD_STATUS,
  lastSentOffer,
} from './last-sent-offer';
import { checkResumePrice, isHumanTakeover, resumeNeedsNewQuote, resumedModeFrom, takeoverModeFrom } from './takeover-state';
import { HOLDING_NOTE_MESSAGE_TYPE, HOLDING_NOTE_SUPERSEDED_STATUS } from './holding-note';

/** PGRST204 / 42703: a column is not there yet. Same test as last-sent-offer. */
function isMissingColumnError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  if (code === 'PGRST204' || code === '42703') return true;
  const msg = typeof e?.message === 'string' ? e.message.toLowerCase() : '';
  return msg.includes('could not find the') || (msg.includes('column') && msg.includes('does not exist'));
}

type OfferRef = {
  id: string;
  firm_id?: string | null;
  campaign_influencer_id?: string | null;
  autonomy_mode?: string | null;
  status?: string | null;
  ceiling_usd?: number | null;
  current_offer_usd?: number | null;
};

export type ThreadHold =
  | { kind: 'clear' }
  /** A human is handling this thread. 'takeover' = the offer is in manual
   *  mode; 'held_reply' = an earlier reply on it is still held for a human
   *  (the fallback when the mode write failed, or for a thread flagged before
   *  manual mode existed). */
  | { kind: 'manual'; reason: 'takeover' | 'held_reply'; held_inbound_ids: string[] }
  /** A DM counter is in the human DM queue, not yet marked sent. */
  | { kind: 'dm_counter_unsent'; drafts: Array<{ id: string; offer_usd: number | null }> }
  /** A read failed: the turn is retried next tick, never guessed clear. */
  | { kind: 'unreadable'; detail: string };

/**
 * Is a human handling this thread? See the file header. `claimedIds` are the
 * replies this turn is about to answer (never 'flagged' yet, excluded anyway).
 */
export async function readThreadHold(
  sb: SupabaseClient,
  offer: OfferRef,
  claimedIds: ReadonlyArray<string>,
): Promise<ThreadHold> {
  const ciId = offer.campaign_influencer_id;
  if (!ciId) {
    return isHumanTakeover(offer) ? { kind: 'manual', reason: 'takeover', held_inbound_ids: [] } : { kind: 'clear' };
  }

  const { data: held, error: hErr } = await sb
    .from('inbound_messages')
    .select('id, status')
    .eq('campaign_influencer_id', ciId)
    .eq('status', 'flagged');
  if (hErr) {
    // Manual mode does not need the read to be honoured.
    if (isHumanTakeover(offer)) return { kind: 'manual', reason: 'takeover', held_inbound_ids: [] };
    return { kind: 'unreadable', detail: hErr.message };
  }
  const heldIds = ((held ?? []) as Array<{ id: string }>).map((r) => r.id).filter((id) => !claimedIds.includes(id));
  if (isHumanTakeover(offer)) return { kind: 'manual', reason: 'takeover', held_inbound_ids: heldIds };
  if (heldIds.length > 0) return { kind: 'manual', reason: 'held_reply', held_inbound_ids: heldIds };

  const dm = await readUnsentDmCounters(sb, ciId);
  if (!dm.ok) return { kind: 'unreadable', detail: dm.detail };
  if (dm.drafts.length > 0) return { kind: 'dm_counter_unsent', drafts: dm.drafts };
  return { kind: 'clear' };
}

/** Counters waiting in the human DM queue (send_mode 'human_queue', still
 *  queued): a person may already have pasted one into the DM. */
async function readUnsentDmCounters(
  sb: SupabaseClient,
  ciId: string,
): Promise<{ ok: true; drafts: Array<{ id: string; offer_usd: number | null }> } | { ok: false; detail: string }> {
  const cols = 'id, message_type, status, send_mode';
  const readDrafts = (select: string) =>
    sb
      .from('outreach_messages')
      .select(select)
      .eq('campaign_influencer_id', ciId)
      .eq('direction', 'outbound')
      .eq('message_type', 'counter')
      .eq('status', 'queued');
  let { data: drafts, error: dErr } = await readDrafts(`${cols}, ${COUNTER_OFFER_COLUMN}`);
  if (dErr && isMissingColumnError(dErr)) ({ data: drafts, error: dErr } = await readDrafts(cols));
  if (dErr) return { ok: false, detail: dErr.message };
  return {
    ok: true,
    drafts: ((drafts ?? []) as unknown as Array<{ id: string; send_mode?: string | null; [COUNTER_OFFER_COLUMN]?: unknown }>)
      .filter((r) => r.send_mode === 'human_queue')
      .map((r) => {
        const usd = Number(r[COUNTER_OFFER_COLUMN]);
        return { id: r.id, offer_usd: Number.isFinite(usd) && usd > 0 ? usd : null };
      }),
  };
}

/**
 * Outbound types the engine writes on its own and the dispatch pass sends
 * without a human: counters, acceptances ("Deal, $X works"), holding notes and
 * automated follow-ups. Payout onboarding and promo materials are post-deal
 * money/fulfilment mail, not negotiation replies, and are not on this list.
 */
export const AI_REPLY_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'counter',
  'agreement_confirmation',
  HOLDING_NOTE_MESSAGE_TYPE,
  'follow_up',
]);

/** Status a withdrawn AI reply is left in: never sent, never re-queued. */
export const AI_REPLY_WITHDRAWN_STATUS = HOLDING_NOTE_SUPERSEDED_STATUS;

/**
 * Is this queued outbound row an AI reply the dispatch pass would send with no
 * human in the loop? Human-authored rows (edited_by_user) and the human DM
 * queue (send_mode 'human_queue', sent by a person) are not.
 */
export function isAutoAiReply(row: {
  message_type?: string | null;
  edited_by_user?: boolean | null;
  send_mode?: string | null;
}): boolean {
  return (
    AI_REPLY_MESSAGE_TYPES.has(String(row.message_type ?? '')) &&
    row.edited_by_user !== true &&
    row.send_mode !== 'human_queue'
  );
}

/**
 * A HUMAN HAS THE THREAD: WITHDRAW WHAT THE AI QUEUED. Manual mode and held replies stopped
 * the next TURN, but not the counter an earlier turn had already queued: the
 * thread went manual, and two minutes later "I can do $200" went out anyway.
 *
 * Every still-queued AI reply on the thread (isAutoAiReply) is moved to
 * 'superseded', guarded on status = 'queued' so a row the dispatch pass has
 * already claimed is left to it. A holding note is withdrawn with them unless
 * a human-authored reply is still queued behind it (the note announces that
 * reply). Human-authored rows are untouched. One audit row when anything
 * moved. Never throws; returns the ids withdrawn.
 */
export async function withdrawQueuedAiReplies(
  sb: SupabaseClient,
  ciId: string | null | undefined,
  ctx: { reason: string; offer_id?: string | null; firm_id?: string | null; inbound_message_id?: string | null },
): Promise<string[]> {
  if (!ciId) return [];
  try {
    const { data, error } = await sb
      .from('outreach_messages')
      .select('id, message_type, status, direction, send_mode, edited_by_user')
      .eq('campaign_influencer_id', ciId)
      .eq('direction', 'outbound')
      .eq('status', 'queued');
    if (error) {
      console.warn('[negotiation-takeover] could not read queued replies to withdraw', ciId, error.message);
      return [];
    }
    const queued = (data ?? []) as Array<{ id: string; message_type: string | null; send_mode: string | null; edited_by_user: boolean | null }>;
    const humanReplyStays = queued.some(
      (r) => r.message_type !== HOLDING_NOTE_MESSAGE_TYPE && !isAutoAiReply(r) && r.send_mode !== 'human_queue',
    );
    const targets = queued.filter(
      (r) => isAutoAiReply(r) && !(r.message_type === HOLDING_NOTE_MESSAGE_TYPE && humanReplyStays),
    );
    const withdrawn: string[] = [];
    for (const r of targets) {
      const { data: won } = await sb
        .from('outreach_messages')
        .update({ status: AI_REPLY_WITHDRAWN_STATUS, send_after: null } as never)
        .eq('id', r.id)
        .eq('status', 'queued')
        .select('id');
      if (Array.isArray(won) && won.length > 0) withdrawn.push(r.id);
    }
    if (withdrawn.length > 0) {
      await audit({
        action: 'negotiation.ai_replies_withdrawn',
        actor_label: 'system:negotiation-takeover',
        target_type: 'creator_offer',
        target_id: ctx.offer_id ?? undefined,
        firm_id: ctx.firm_id ?? null,
        metadata: {
          reason: ctx.reason,
          campaign_influencer_id: ciId,
          inbound_message_id: ctx.inbound_message_id ?? null,
          withdrawn_message_ids: withdrawn,
          withdrawn_types: targets.filter((t) => withdrawn.includes(t.id)).map((t) => t.message_type),
        },
      });
    }
    return withdrawn;
  } catch (e) {
    console.warn('[negotiation-takeover] withdrawQueuedAiReplies failed', e);
    return [];
  }
}

export type DispatchThreadState = 'clear' | 'held' | 'unreadable';

/**
 * The dispatch pass's per-row re-check, right before an AI reply is claimed
 * and sent: is a human handling this thread NOW? Manual mode on any
 * of the lead's offers, or any reply on the thread held for a human ('flagged'),
 * is 'held'. A failed read is 'unreadable', and the row is not sent this pass.
 */
export async function dispatchThreadState(sb: SupabaseClient, ciId: string): Promise<DispatchThreadState> {
  const { data: offers, error: oErr } = await sb
    .from('creator_offers')
    .select('id, autonomy_mode')
    .eq('campaign_influencer_id', ciId);
  if (oErr) return 'unreadable';
  if (((offers ?? []) as Array<{ autonomy_mode?: string | null }>).some((o) => isHumanTakeover(o))) return 'held';
  const { data: held, error: hErr } = await sb
    .from('inbound_messages')
    .select('id')
    .eq('campaign_influencer_id', ciId)
    .eq('status', 'flagged');
  if (hErr) return 'unreadable';
  return Array.isArray(held) && held.length > 0 ? 'held' : 'clear';
}

/**
 * Put the offer into manual mode after an escalation. Guarded on the mode we
 * read, so a concurrent resume is never undone. Never throws: if the write
 * fails, the reply it escalated is still held ('flagged'), and readThreadHold
 * treats a thread with a held reply as manual anyway.
 *
 * Every escalation also withdraws the AI replies already queued on
 * the thread (withdrawQueuedAiReplies), even when the offer was already
 * manual: a human has the thread, so nothing automated goes out on it.
 */
export async function enterHumanTakeover(
  sb: SupabaseClient,
  offer: OfferRef,
  ctx: { reason: string; escalation_kind?: string | null; inbound_message_id?: string | null },
): Promise<void> {
  await withdrawQueuedAiReplies(sb, offer.campaign_influencer_id, {
    reason: ctx.reason,
    offer_id: offer.id,
    firm_id: offer.firm_id ?? null,
    inbound_message_id: ctx.inbound_message_id ?? null,
  });
  if (isHumanTakeover(offer)) return;
  const previous = offer.autonomy_mode ?? 'auto';
  try {
    const { error } = await sb
      .from('creator_offers')
      .update({ autonomy_mode: takeoverModeFrom(previous) } as never)
      .eq('id', offer.id)
      .eq('autonomy_mode', previous);
    if (error) {
      console.warn('[negotiation-takeover] could not put the offer in manual mode; the held reply keeps it manual', offer.id, error.message);
      return;
    }
    await audit({
      action: 'negotiation.manual_mode_entered',
      actor_label: 'system:negotiation-tick',
      target_type: 'creator_offer',
      target_id: offer.id,
      firm_id: offer.firm_id ?? null,
      metadata: {
        previous_autonomy_mode: previous,
        reason: ctx.reason,
        escalation_kind: ctx.escalation_kind ?? null,
        inbound_message_id: ctx.inbound_message_id ?? null,
      },
    });
  } catch (e) {
    console.warn('[negotiation-takeover] enterHumanTakeover failed', e);
  }
}

export interface ResumeInput {
  offerId: string;
  /** The caller's firm. The offer must be this firm's. */
  firmId: string;
  /** When the route names a campaign, the offer must be in it. */
  campaignId?: string;
  /** The price the operator last quoted the creator, as entered. */
  price: unknown;
  /** The operator ticked "this is the price I last quoted". */
  confirmed: boolean;
  /**
   * The operator ticked "I quoted this new price to the creator".
   * Required whenever the price differs from the last one on record (or none
   * is on record): automation will agree at it, so it must be a price the
   * creator was actually given.
   */
  quotedNew?: boolean;
  /** Who did it, for the thread record and the audit row. */
  actorLabel: string;
  nowMs?: number;
  request?: Request;
}

export interface ResumeResult {
  status: number;
  body: Record<string, unknown>;
}

const NEGOTIABLE = new Set(['offered', 'counter_offered']);

/**
 * Leave manual mode. Every refusal leaves the thread exactly as it was
 * (manual). The record is written FIRST, and the mode flipped only after it
 * landed, so automation can never resume without the price it must agree at.
 */
export async function resumeAutomation(sb: SupabaseClient, input: ResumeInput): Promise<ResumeResult> {
  const { data: o, error: oErr } = await sb
    .from('creator_offers')
    .select('id, firm_id, campaign_id, campaign_influencer_id, autonomy_mode, status, ceiling_usd, current_offer_usd')
    .eq('id', input.offerId)
    .maybeSingle();
  if (oErr) return { status: 503, body: { error: 'offer_unreadable', message: 'Could not read this deal. Try again in a minute.' } };
  const offer = o as (OfferRef & { campaign_id?: string | null }) | null;
  if (!offer || offer.firm_id !== input.firmId) return { status: 404, body: { error: 'not_found' } };
  if (input.campaignId && offer.campaign_id !== input.campaignId) return { status: 404, body: { error: 'not_found' } };
  const ciId = offer.campaign_influencer_id;
  if (!ciId) return { status: 409, body: { error: 'no_thread', message: 'This deal has no creator thread to resume.' } };
  if (!NEGOTIABLE.has(String(offer.status))) {
    return {
      status: 409,
      body: { error: 'not_negotiable', message: `This deal is ${offer.status}; there is no negotiation to hand back to automation.` },
    };
  }

  const hold = await readThreadHold(sb, offer, []);
  if (hold.kind === 'unreadable') {
    return { status: 503, body: { error: 'thread_unreadable', message: 'Could not read this thread. Try again in a minute.' } };
  }
  if (hold.kind === 'clear') {
    return { status: 409, body: { error: 'not_manual', message: 'Automation is already running on this deal.' } };
  }
  const dm = await readUnsentDmCounters(sb, ciId);
  if (!dm.ok) {
    return { status: 503, body: { error: 'thread_unreadable', message: 'Could not read this thread. Try again in a minute.' } };
  }
  if (hold.kind === 'dm_counter_unsent' || dm.drafts.length > 0) {
    return {
      status: 409,
      body: {
        error: 'dm_counter_unsent',
        message: 'A DM counter is still waiting in the DM queue. Mark it sent (or cancel it) first, so the price it quotes is on record.',
      },
    };
  }

  const price = checkResumePrice(input.price, offer.ceiling_usd);
  if (!price.ok) return { status: 422, body: { error: 'invalid_price', message: price.message } };
  if (!input.confirmed) {
    return {
      status: 422,
      body: {
        error: 'confirm_required',
        message: `Confirm that $${price.usd} is the price you last quoted this creator. Automation will agree at that price if they say yes.`,
      },
    };
  }

  // What the thread has on record: the last STRUCTURED price sent (never parsed text; pre-059 nothing is on record).
  const cols = 'message_type, direction, status, channel, sent_at, created_at';
  const readThread = (select: string) =>
    sb.from('outreach_messages').select(select).eq('campaign_influencer_id', ciId).eq('direction', 'outbound');
  let priceColumn = true;
  let { data: thread, error: tErr } = await readThread(`${cols}, ${COUNTER_OFFER_COLUMN}`);
  if (tErr && isMissingColumnError(tErr)) {
    priceColumn = false;
    ({ data: thread, error: tErr } = await readThread(cols));
  }
  if (tErr) return { status: 503, body: { error: 'thread_unreadable', message: 'Could not read this thread. Try again in a minute.' } };
  const rows = (thread ?? []) as unknown as Array<{ channel?: string | null; sent_at?: string | null; created_at?: string | null }>;
  const previousLastSent = lastSentOffer(rows as never, { priceColumn }).usd;
  // A price that is not the one on record is a NEW quote the
  // operator gave outside the app. Automation will agree at it, so they must
  // say so explicitly.
  const quotedNew = resumeNeedsNewQuote(price.usd, previousLastSent);
  if (quotedNew && input.quotedNew !== true) {
    return {
      status: 422,
      body: {
        error: 'new_quote_confirm_required',
        last_sent_offer_usd: previousLastSent,
        message:
          previousLastSent == null
            ? `No price is on record for this creator. Confirm that you quoted them $${price.usd} yourself before automation agrees at it.`
            : `The last price on record is $${previousLastSent}, not $${price.usd}. Confirm that you quoted them $${price.usd} yourself before automation agrees at it.`,
      },
    };
  }
  const latest = [...rows].sort((a, b) =>
    String(b.sent_at ?? b.created_at ?? '').localeCompare(String(a.sent_at ?? a.created_at ?? '')),
  )[0];
  const channel = ['email', 'instagram_dm', 'tiktok_dm', 'linkedin_dm'].includes(String(latest?.channel))
    ? String(latest?.channel)
    : 'email';

  // 1. The record: the price the operator quoted, as the thread's last sent price.
  const nowIso = new Date(input.nowMs ?? Date.now()).toISOString();
  const record = {
    campaign_influencer_id: ciId,
    message_type: PRICE_RECORD_MESSAGE_TYPE,
    direction: 'outbound',
    channel,
    subject: null,
    body: `Price quoted to the creator outside Creator Campaigns: $${price.usd}. Recorded by ${input.actorLabel} when resuming automation.`,
    status: PRICE_RECORD_STATUS,
    sent_at: nowIso,
    send_after: null,
    edited_by_user: true,
  };
  // The price rides offer_usd: the ONLY thing lastSentOffer reads. Pre-059
  // the record keeps its sentence (audit trail) but carries no structured
  // price, so a later "deal" still goes to a human (priceRecorded: false).
  let priceRecorded = true;
  let { error: rErr } = await sb.from('outreach_messages').insert({ ...record, [COUNTER_OFFER_COLUMN]: price.usd } as never);
  if (rErr && isMissingColumnError(rErr)) {
    priceRecorded = false;
    ({ error: rErr } = await sb.from('outreach_messages').insert(record as never));
  }
  if (rErr) {
    return { status: 503, body: { error: 'record_failed', message: 'Could not record the price. Nothing changed; the deal is still manual.' } };
  }

  // 2. The standing offer is that price, and the mode goes back. Guarded on
  //    the mode we read, so a concurrent escalation is not overwritten.
  // A taken-over offer gets its previous mode back; one held only by a held
  // reply (the fallback) keeps the mode it already has.
  const restored = isHumanTakeover(offer)
    ? resumedModeFrom(offer.autonomy_mode)
    : offer.autonomy_mode === 'auto'
      ? 'auto'
      : 'manual';
  let upd = sb
    .from('creator_offers')
    .update({ current_offer_usd: price.usd, autonomy_mode: restored } as never)
    .eq('id', offer.id);
  upd = offer.autonomy_mode == null ? upd.is('autonomy_mode', null) : upd.eq('autonomy_mode', offer.autonomy_mode);
  const { data: updated, error: uErr } = await upd.select('id');
  if (uErr || !Array.isArray(updated) || updated.length === 0) {
    return {
      status: uErr ? 503 : 409,
      body: {
        error: uErr ? 'resume_failed' : 'changed',
        message: 'The deal changed while you were resuming it. It is still manual; reload and try again.',
      },
    };
  }

  // 3. Replies held on this thread were reviewed by whoever resumed it.
  const resolved: string[] = [];
  if (hold.kind === 'manual') {
    for (const id of hold.held_inbound_ids) {
      if (await markInboundReviewed(sb, id, { actorLabel: input.actorLabel, via: 'resume', nowIso })) resolved.push(id);
    }
  }

  await audit(
    {
      action: 'negotiation.automation_resumed',
      actor_label: input.actorLabel,
      target_type: 'creator_offer',
      target_id: offer.id,
      firm_id: input.firmId,
      metadata: {
        confirmed_price_usd: price.usd,
        previous_last_sent_usd: previousLastSent,
        quoted_new_price: quotedNew,
        price_recorded: priceRecorded,
        previous_current_offer_usd: offer.current_offer_usd ?? null,
        restored_autonomy_mode: restored,
        resolved_inbound_ids: resolved,
        held_reason: hold.reason,
        recorded_by: input.actorLabel,
      },
    },
    input.request,
  );
  return {
    status: 200,
    body: {
      ok: true,
      autonomy_mode: restored,
      last_sent_offer_usd: priceRecorded ? price.usd : null,
      price_recorded: priceRecorded,
      resolved_inbound_ids: resolved,
    },
  };
}

/**
 * Take a held reply off the human queue as reviewed. Guarded on 'flagged', so
 * a reply already released is not touched; the decision is merged into the
 * row's classification jsonb (inbound_messages.status has a CHECK with no
 * 'reviewed' value). Returns whether this call moved it.
 */
export async function markInboundReviewed(
  sb: SupabaseClient,
  id: string,
  ctx: { actorLabel: string; via: string; nowIso: string; nextStatus?: 'processed' | 'classified' },
): Promise<boolean> {
  const { data: cur, error } = await sb
    .from('inbound_messages')
    .select('id, status, classification')
    .eq('id', id)
    .maybeSingle();
  if (error || !cur) return false;
  const row = cur as { status: string; classification: unknown };
  if (row.status !== 'flagged') return false;
  const prior =
    row.classification && typeof row.classification === 'object' && !Array.isArray(row.classification)
      ? (row.classification as Record<string, unknown>)
      : {};
  const { data: moved, error: wErr } = await sb
    .from('inbound_messages')
    .update({
      status: ctx.nextStatus ?? 'processed',
      classification: { ...prior, operator_resolution: { by: ctx.actorLabel, at: ctx.nowIso, via: ctx.via } },
    } as never)
    .eq('id', id)
    .eq('status', 'flagged')
    .select('id');
  return !wErr && Array.isArray(moved) && moved.length > 0;
}
