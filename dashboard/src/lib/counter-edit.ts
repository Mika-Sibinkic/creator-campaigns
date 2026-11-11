// src/lib/counter-edit.ts
//
// A HUMAN-EDITED COUNTER QUOTES THE PRICE ITS TEXT QUOTES.
//
// scheduleCounter records the engine's price on the counter row
// (outreach_messages.offer_usd, migration 059), and the offer row's standing
// price (creator_offers.current_offer_usd) is written when the counter is
// drafted. Editing the draft used to change only its body, so a label that
// rewrote "$175" as "$160" sent $160 while every record still said $175: the
// thread's last-sent price, the "Last price sent" line on the approval card,
// and — worst — the amount a later "deal!" was agreed and authorized at.
//
// Now an edit to a QUEUED counter re-derives the quoted price from the edited
// body with the same parser acceptances use (readStatedPrice):
//
//   one certain price        → that price, recorded on the row. A price field
//                              that disagrees with it is refused: the text is
//                              what the creator reads, the two must match.
//   none / not certain       → the editor must confirm the price (the form
//                              prefills it); refused with the draft's price as
//                              the suggestion until they do.
//   above the ceiling        → refused. The offer row could never record it
//                              (current_within_ceiling, migration 009).
//   above the campaign's     → refused, by computeEffectiveCeiling,
//   remaining budget           the same check finalizeAgreement runs. An
//                              unverifiable budget refuses too.
//   no open offer            → refused: nothing to check against.
//
// The row's offer_usd is what the send paths copy onto the offer row once the
// counter actually goes (applySentCounterPrice in ./last-sent-offer).

import type { SupabaseClient } from '@supabase/supabase-js';
import { COUNTER_OFFER_COLUMN, PRICE_RECORD_MESSAGE_TYPE } from './last-sent-offer';
import { readStatedPrice } from './stated-price';
import { computeEffectiveCeiling, type CreatorOfferRow } from './negotiation';

function isMissingColumnError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  if (code === 'PGRST204' || code === '42703') return true;
  const msg = typeof e?.message === 'string' ? e.message.toLowerCase() : '';
  return msg.includes('could not find the') || (msg.includes('column') && msg.includes('does not exist'));
}

export type CounterEditResult =
  /** Not a queued counter draft: the caller edits it the way it always has. */
  | { kind: 'not_counter' }
  /** Saved. `row` is the updated outreach_messages row. */
  | { kind: 'saved'; row: Record<string, unknown>; offer_usd: number; derived: boolean }
  /** Refused; nothing was written. */
  | { kind: 'refused'; status: number; body: Record<string, unknown> };

export interface CounterEditInput {
  messageId: string;
  body: string;
  subject?: string;
  /** The price the editor confirmed in the form, when they did. */
  confirmedOfferUsd?: number | null;
}

type MessageRow = {
  id: string;
  message_type?: string | null;
  direction?: string | null;
  status?: string | null;
  campaign_influencer_id?: string | null;
  body?: string | null;
  subject?: string | null;
  [COUNTER_OFFER_COLUMN]?: unknown;
};

const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** Two recorded prices are the same (NULL/empty = no price; cents tolerance). */
function samePrice(a: unknown, b: unknown): boolean {
  const n = (v: unknown) => (v == null || v === '' ? null : Number(v));
  const x = n(a);
  const y = n(b);
  if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) return x == null && y == null;
  return Math.abs(x - y) < 0.005;
}

/**
 * Edit a queued counter draft, recording the price the edited text quotes.
 * Returns 'not_counter' for anything that is not a queued outbound counter.
 */
export async function editCounterDraft(
  sb: SupabaseClient,
  input: CounterEditInput,
): Promise<CounterEditResult> {
  const cols = 'id, message_type, direction, status, campaign_influencer_id, body, subject';
  const read = (select: string) => sb.from('outreach_messages').select(select).eq('id', input.messageId).maybeSingle();
  let columnExists = true;
  let { data, error } = await read(`${cols}, ${COUNTER_OFFER_COLUMN}`);
  if (error && isMissingColumnError(error)) {
    columnExists = false;
    ({ data, error } = await read(cols));
  }
  if (error) return { kind: 'refused', status: 500, body: { error: 'read_failed', message: 'Could not read this draft. Try again.' } };
  const msg = data as unknown as MessageRow | null;
  if (!msg || msg.message_type !== 'counter' || msg.direction !== 'outbound' || msg.status !== 'queued') {
    return { kind: 'not_counter' };
  }

  // The offer this counter prices: its ceiling and the campaign's remaining
  // budget bound the edit, and before migration 059 its standing price is the
  // only price we can compare with. FAIL CLOSED. With no active offer
  // there is no ceiling or budget to check the edited price against, so the
  // edit is refused rather than saved unbounded.
  type OfferRow = { id: string; status: string; campaign_id: string; ceiling_usd: unknown; current_offer_usd: unknown };
  let offer: OfferRow | null = null;
  if (msg.campaign_influencer_id) {
    const { data: offers, error: oErr } = await sb
      .from('creator_offers')
      .select('id, status, campaign_id, ceiling_usd, current_offer_usd')
      .eq('campaign_influencer_id', msg.campaign_influencer_id);
    if (oErr) return { kind: 'refused', status: 500, body: { error: 'read_failed', message: 'Could not read the offer for this draft. Try again.' } };
    const list = (offers ?? []) as OfferRow[];
    offer = list.find((o) => o.status === 'offered' || o.status === 'counter_offered') ?? null;
  }
  if (!offer) {
    return {
      kind: 'refused',
      status: 409,
      body: {
        error: 'no_active_offer',
        message: 'There is no open offer for this creator, so an edited price cannot be checked against the ceiling or the campaign budget. Reject the draft and message the creator yourself.',
      },
    };
  }
  const draftUsd = Number(msg[COUNTER_OFFER_COLUMN] ?? offer.current_offer_usd ?? Number.NaN);
  const suggested = Number.isFinite(draftUsd) && draftUsd > 0 ? draftUsd : null;

  // The recorded price is ONLY the one the editor confirmed in the
  // price field. The edited text is read solely as a guard (a body that
  // plainly quotes a different number is refused, so the two cannot drift);
  // it never supplies the price, because a date or a name in our own copy
  // reads as money ("drops October 24" → $24).
  const stated = readStatedPrice(input.body);
  const confirmed =
    input.confirmedOfferUsd != null && Number.isFinite(Number(input.confirmedOfferUsd))
      ? Math.round(Number(input.confirmedOfferUsd) * 100) / 100
      : null;
  if (confirmed == null) {
    return {
      kind: 'refused',
      status: 422,
      body: {
        error: 'price_confirmation_required',
        message: 'Confirm the price this counter offers the creator in the price field before saving.',
        suggested_offer_usd: suggested,
      },
    };
  }
  if (stated.kind === 'one' && Math.abs(confirmed - stated.usd) >= 0.005) {
    return {
      kind: 'refused',
      status: 422,
      body: {
        error: 'price_mismatch',
        message: `The edited message quotes ${money(stated.usd)} but the price field says ${money(confirmed)}. Make them match before saving.`,
        suggested_offer_usd: suggested,
      },
    };
  }
  const price = confirmed;
  const derived = false;

  const bound = await boundQuotedPrice(sb, offer, price, suggested);
  if (bound) return bound;

  const base: Record<string, unknown> = { body: input.body };
  if (input.subject !== undefined) base.subject = input.subject;
  // A no-op Save (same text, same price) leaves the AI draft an AI
  // draft, so manual mode still withdraws it. The draft's price is its
  // recorded one, else the standing offer it was drafted at (`suggested`).
  if (
    input.body !== (msg.body ?? '') ||
    (input.subject !== undefined && input.subject !== (msg.subject ?? '')) ||
    !samePrice(price, suggested)
  ) {
    base.edited_by_user = true;
  }
  // Guarded on 'queued': a counter that went (or was superseded) while the
  // editor typed is not edited after the fact.
  const write = (patch: Record<string, unknown>) =>
    sb
      .from('outreach_messages')
      .update(patch as never)
      .eq('id', msg.id)
      .eq('status', 'queued')
      .select()
      .maybeSingle();
  let res = columnExists ? await write({ ...base, [COUNTER_OFFER_COLUMN]: price }) : null;
  if (!res || (res.error && isMissingColumnError(res.error))) {
    // Pre-059: the price cannot be recorded on the row. An edit that keeps the
    // standing price is safe to save; one that changes it would leave every
    // record naming a price the creator was never sent, so it is refused.
    const standing = Number(offer.current_offer_usd);
    if (!Number.isFinite(standing) || Math.abs(standing - price) >= 0.005) {
      return {
        kind: 'refused',
        status: 409,
        body: {
          error: 'price_not_recordable',
          message: `This counter's price can't be changed yet (the database is missing migration 059). Keep it at ${Number.isFinite(standing) ? money(standing) : 'the drafted price'}, or reject the draft and message the creator yourself.`,
          suggested_offer_usd: Number.isFinite(standing) ? standing : suggested,
        },
      };
    }
    res = await write(base);
  }
  if (res.error) return { kind: 'refused', status: 500, body: { error: res.error.message } };
  if (!res.data) {
    return {
      kind: 'refused',
      status: 409,
      body: { error: 'not_queued', message: 'This counter was already sent or withdrawn, so it can no longer be edited.' },
    };
  }
  return { kind: 'saved', row: res.data as Record<string, unknown>, offer_usd: price, derived };
}

type BoundOffer = { id: string; status: string; campaign_id: string; ceiling_usd: unknown; current_offer_usd: unknown };

/**
 * The bounds every price a human puts on the record must sit inside: more
 * than $0, at or under the creator's ceiling (current_within_ceiling,
 * migration 009), and inside what the campaign has left (the same
 * computeEffectiveCeiling finalizeAgreement checks; fails closed). Returns the
 * refusal, or null when the price is fine.
 */
async function boundQuotedPrice(
  sb: SupabaseClient,
  offer: BoundOffer,
  price: number,
  suggested: number | null,
): Promise<Extract<CounterEditResult, { kind: 'refused' }> | null> {
  if (!(price > 0)) {
    return { kind: 'refused', status: 422, body: { error: 'invalid_price', message: 'The price must be more than $0.' } };
  }
  const ceiling = Number(offer.ceiling_usd);
  if (!Number.isFinite(ceiling) || price > ceiling + 0.005) {
    return {
      kind: 'refused',
      status: 422,
      body: {
        error: 'above_ceiling',
        message: Number.isFinite(ceiling)
          ? `${money(price)} is above this creator's ceiling of ${money(ceiling)}.`
          : "This creator has no readable ceiling, so an edited price can't be checked.",
        suggested_offer_usd: suggested,
      },
    };
  }
  const eff = await computeEffectiveCeiling(sb, offer as unknown as CreatorOfferRow);
  if (eff.budget_unverifiable) {
    return {
      kind: 'refused',
      status: eff.unverifiable_kind === 'unreadable' ? 503 : 422,
      body: {
        error: 'budget_unverifiable',
        message: `The campaign budget can't be checked (${eff.unverifiable_reason}), so this price can't be saved.`,
        suggested_offer_usd: suggested,
      },
    };
  }
  if (price > eff.ceiling + 0.005) {
    return {
      kind: 'refused',
      status: 422,
      body: {
        error: 'above_budget',
        message: `${money(price)} is more than this campaign has left for this creator (${money(Math.max(0, eff.ceiling))} after other committed deals).`,
        suggested_offer_usd: suggested != null && suggested <= eff.ceiling + 0.005 ? suggested : null,
      },
    };
  }
  return null;
}

export type QuotedPriceResult =
  | { kind: 'saved'; offer_usd: number | null }
  | { kind: 'refused'; status: number; body: Record<string, unknown> };

/**
 * Statuses a message can still be edited in: written but never queued
 * (`draft`, or NULL — the column default predates most writers) and `queued`.
 * Everything else has left the queue: claimed and sent, or terminal.
 */
const EDITABLE_STATUSES: ReadonlySet<string> = new Set(['draft', 'queued']);
const isEditableStatus = (s: string | null | undefined) => s == null || EDITABLE_STATUSES.has(s);

const notEditable = (status: string | null | undefined): Extract<QuotedPriceResult, { kind: 'refused' }> => ({
  kind: 'refused',
  status: 409,
  body: {
    error: status === 'sent' ? 'already_sent' : 'not_editable',
    message:
      status === 'sent'
        ? 'This message is already sending or was sent, so it can no longer be edited.'
        : 'This message is no longer a draft or queued (it was withdrawn, closed or recorded), so it can no longer be edited.',
  },
});

export type MessageEditResult =
  | { kind: 'saved'; row: Record<string, unknown>; offer_usd: number | null | undefined }
  | { kind: 'refused'; status: number; body: Record<string, unknown> };

export interface MessageEditInput {
  messageId: string;
  body?: string;
  subject?: string;
  /** "Price quoted": a number records it, null clears it, undefined leaves it. */
  usd?: number | null;
}

/**
 * EDIT ANY NON-COUNTER MESSAGE: body, subject and "Price quoted" in ONE write
 * 
 *
 * The dispatch pass claims a queued row (status queued → sent) and sends the
 * copy its claim returned. This write is a compare-and-swap on the status it
 * read, so it either lands while the row is still a draft or queued (and the
 * claim then returns it), or it lands on nothing and is refused with 409: an
 * edit can never reach a row between its claim and its send. Body and price go
 * together, so the row can never carry a new price beside text that went out
 * without it.
 */
export async function editOutboundMessage(
  sb: SupabaseClient,
  input: MessageEditInput,
): Promise<MessageEditResult> {
  const cols = 'id, message_type, direction, status, campaign_influencer_id, body, subject';
  const read = (select: string) => sb.from('outreach_messages').select(select).eq('id', input.messageId).maybeSingle();
  let { data, error } = await read(`${cols}, ${COUNTER_OFFER_COLUMN}`);
  if (error && isMissingColumnError(error)) {
    if (input.usd !== undefined) {
      return {
        kind: 'refused',
        status: 409,
        body: {
          error: 'price_not_recordable',
          message: "A quoted price can't be recorded yet (the database is missing migration 059). Save without a price; a yes from the creator will then come to you.",
        },
      };
    }
    ({ data, error } = await read(cols));
  }
  if (error) return { kind: 'refused', status: 500, body: { error: 'read_failed', message: 'Could not read this message. Try again.' } };
  const msg = data as unknown as (MessageRow & { body?: string | null; subject?: string | null }) | null;
  if (!msg) return { kind: 'refused', status: 404, body: { error: 'not_found' } };
  // The Resume price record (the price an operator quoted OUTSIDE
  // Creator Campaigns) is the thread's last quoted price, and it changes only through
  // the Resume flow (negotiation-takeover.ts). Refused by type, not just by its
  // 'recorded' status: status is free text with no CHECK.
  if (msg.message_type === PRICE_RECORD_MESSAGE_TYPE) {
    return {
      kind: 'refused',
      status: 409,
      body: {
        error: 'price_record',
        message: 'This is the price you recorded when resuming automation. It changes only through Resume, not here.',
      },
    };
  }
  if (!isEditableStatus(msg.status)) return notEditable(msg.status);

  const patch: Record<string, unknown> = {};
  if (input.usd !== undefined) {
    if (msg.direction !== 'outbound') return { kind: 'refused', status: 404, body: { error: 'not_found' } };
    if (msg.message_type === 'counter') {
      return { kind: 'refused', status: 409, body: { error: 'counter_price', message: "A counter's price is set with its own price field when you edit it." } };
    }
    let price: number | null = null;
    if (input.usd != null) {
      price = Math.round(Number(input.usd) * 100) / 100;
      if (!msg.campaign_influencer_id) {
        return { kind: 'refused', status: 409, body: { error: 'no_active_offer', message: 'This message has no creator deal to quote a price on.' } };
      }
      const { data: offers, error: oErr } = await sb
        .from('creator_offers')
        .select('id, status, campaign_id, ceiling_usd, current_offer_usd')
        .eq('campaign_influencer_id', msg.campaign_influencer_id);
      if (oErr) return { kind: 'refused', status: 500, body: { error: 'read_failed', message: 'Could not read the offer for this creator. Try again.' } };
      const offer = ((offers ?? []) as BoundOffer[]).find((o) => o.status === 'offered' || o.status === 'counter_offered') ?? null;
      if (!offer) {
        return {
          kind: 'refused',
          status: 409,
          body: {
            error: 'no_active_offer',
            message: 'There is no open offer for this creator, so a quoted price cannot be checked against the ceiling or the campaign budget.',
          },
        };
      }
      const bound = await boundQuotedPrice(sb, offer, price, null);
      if (bound) return bound;
    }
    patch[COUNTER_OFFER_COLUMN] = price;
  }
  if (input.body !== undefined) patch.body = input.body;
  if (input.subject !== undefined) patch.subject = input.subject;
  // A Save that changes nothing leaves an AI draft an AI draft (a
  // human-edited row survives manual-mode withdrawal and is sent as the
  // operator's). Human-edited only when body, subject or price really changed.
  const priceChanged = input.usd !== undefined && !samePrice(patch[COUNTER_OFFER_COLUMN], msg[COUNTER_OFFER_COLUMN]);
  if (
    (input.body !== undefined && input.body !== (msg.body ?? '')) ||
    (input.subject !== undefined && input.subject !== (msg.subject ?? '')) ||
    priceChanged
  ) {
    patch.edited_by_user = true;
  }

  // Compare-and-swap on the status just read: a row claimed for sending (or
  // withdrawn) since then is not edited after the fact.
  const q = sb.from('outreach_messages').update(patch as never).eq('id', msg.id);
  const { data: w, error: wErr } = await (msg.status == null ? q.is('status', null) : q.eq('status', msg.status))
    .select()
    .maybeSingle();
  if (wErr) return { kind: 'refused', status: 500, body: { error: wErr.message } };
  if (!w) return notEditable('sent');
  const price = input.usd === undefined ? undefined : (patch[COUNTER_OFFER_COLUMN] as number | null);
  return { kind: 'saved', row: w as Record<string, unknown>, offer_usd: price };
}

/**
 * MANUAL SEND / REPLY: "PRICE QUOTED".
 *
 * A message an operator sends by hand (an edited opener, a reply typed into a
 * draft, a DM pasted from the queue) may quote a price. That price is known
 * ONLY when the operator enters it in the optional "Price quoted" field, which
 * lands here and is stored on the row's offer_usd; the message text is never
 * read for it. When the message goes (any send path), lastSentOffer reads it
 * as the last price sent and applySentCounterPrice makes it the standing
 * offer, so the fold and the acceptance gate see the same number.
 *
 *   usd = number   recorded, inside the ceiling and the campaign budget
 *   usd = null     cleared: this message quotes no price
 *
 * Only for an outbound message that is still a draft or queued. Refused for a
 * counter (editCounterDraft owns those), for the Resume price record (it changes only through Resume), for a row that already went or left the
 * queue, with no open offer (nothing to bound the price by), and pre-059 (the
 * price could not be recorded; a price only in the text counts for nothing).
 */
export async function recordManualQuotedPrice(
  sb: SupabaseClient,
  input: { messageId: string; usd: number | null },
): Promise<QuotedPriceResult> {
  const r = await editOutboundMessage(sb, { messageId: input.messageId, usd: input.usd });
  return r.kind === 'saved' ? { kind: 'saved', offer_usd: r.offer_usd ?? null } : r;
}
