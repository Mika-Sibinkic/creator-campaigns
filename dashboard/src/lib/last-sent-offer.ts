// src/lib/last-sent-offer.ts
//
// THE LAST PRICE ACTUALLY SENT.
//
// creator_offers.current_offer_usd is overwritten when a counter is DRAFTED,
// before it is sent, and a draft can be superseded or window-closed without
// ever reaching the creator. So it cannot answer "what number has this
// creator actually seen from us?". This module can: each counter records the
// price it quotes (outreach_messages.offer_usd, migration 059), and the latest
// sent message that quoted a price is the answer (never the opening
// offer on the row unless a sent message actually named it).
//
// Two consumers: the negotiation tick's fold (a turn must never concede from
// a price the creator never saw) and the approval card / deal row (display
// only: "Last price sent to creator: $X" beside the agreed amount).
//
// STRUCTURED DATA ONLY. Earlier versions read prices out of
// free text WE sent: "The new single drops October 24" in an opener became
// "Deal, $24 works", and a firm called "Studio 54" signing a holding note
// became "Deal, $54 works". No parser can tell money from a date or a name in
// copy we wrote, so this module no longer reads message bodies at all. The
// only prices it knows are the ones written to outreach_messages.offer_usd
// when something explicitly quoted one: an AI counter, an edited counter
// (confirmed price field), an operator's "Price quoted" field on a manual
// send, a Resume price record. Nothing structured → unknown → a human.
//
// A leaf module (type-only imports), so the client deals page can use
// lastSentNotice without pulling the tick's graph into its bundle.

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * outreach_messages column holding the price a counter quotes (migration 059).
 * Written by scheduleCounter; read back by lastSentOffer.
 */
export const COUNTER_OFFER_COLUMN = 'offer_usd' as const;

export interface LastSentOffer {
  /** The last price that reached the creator, or null when it cannot be known. */
  usd: number | null;
  /**
   * counter   a sent counter's recorded price (offer_usd)
   * message   any other sent message carrying a recorded price (offer_usd):
   *           an operator's manual send with "Price quoted" filled in, an
   *           opener whose template quoted one. Never read from its text.
   * operator  a price an operator recorded when resuming automation
   *           (negotiation-takeover.ts): quoted to the creator outside the app
   * none      nothing we sent carries a recorded price: there is no price to
   *           agree at, and none to concede from
   * unknown   a counter went with no recorded price, or the thread was read
   *           without the offer_usd column (pre-059): never guessed
   */
  source: 'counter' | 'message' | 'operator' | 'none' | 'unknown';
}

/**
 * outreach_messages row an operator writes when they resume automation on a
 * thread they took over (negotiation-takeover.ts): the price they quoted the
 * creator outside Creator Campaigns. Never dispatched (status is not 'queued') and
 * never counted as a send (status is not 'sent'); it exists so the thread's
 * record of "the last price we quoted" includes the one a human quoted.
 */
export const PRICE_RECORD_MESSAGE_TYPE = 'price_record' as const;
export const PRICE_RECORD_STATUS = 'recorded' as const;

type ThreadRow = {
  message_type?: string | null;
  status?: string | null;
  direction?: string | null;
  sent_at?: string | null;
  body?: string | null;
  [COUNTER_OFFER_COLUMN]?: unknown;
};

function recordedPrice(raw: unknown): number | null {
  const usd = raw == null || raw === '' ? Number.NaN : Number(raw);
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

/**
 * The last price this creator was actually sent (rounds 7 and 8).
 *
 * THE RULE: the AI may only ever auto-agree at a price we explicitly quoted
 * AND recorded as data. This walks our outbound messages that reached the
 * creator, newest first, and stops at the first one carrying a price:
 *
 *   sent row with a recorded offer_usd  → that price (counter / message /
 *                                         operator, by message type)
 *   sent counter with none              → UNKNOWN (a counter always quotes;
 *                                         a pre-059 one cannot be read back)
 *   any other sent row with none        → skipped: it quoted nothing on record
 *   nothing carries a price             → NONE (no price to agree at)
 *   `priceColumn: false` (the thread
 *     was read without offer_usd)       → UNKNOWN, whatever the rows say
 *
 * MESSAGE TEXT IS NEVER READ. Not the opener, not a holding note,
 * not a sign-off, not a price record's sentence. A date ("drops October 24"),
 * a firm name ("Studio 54") or a track title ("Room 214") in our own copy was
 * being agreed as the price. ./stated-price is for the CREATOR's words only.
 *
 * The opening offer on the row (initial_offer_usd) is NOT a fallback either:
 * the opener asks the creator's rate and records no price, so a bare "I'm in!"
 * to it agreed nothing. An unknown or absent price is never agreed: the
 * acceptance gate hands it to a human.
 *
 * A queued, superseded or window-closed row never reached the creator, so it
 * is never it.
 */
export function lastSentOffer(
  thread: ReadonlyArray<ThreadRow>,
  opts: { priceColumn?: boolean } = {},
): LastSentOffer {
  // Pre-059: no row can carry a structured price, so nothing can be known.
  if (opts.priceColumn === false) return { usd: null, source: 'unknown' };
  const candidates = thread
    .filter((r) => (r.direction ?? 'outbound') === 'outbound')
    .filter(
      (r) =>
        r.status === 'sent' ||
        (r.message_type === PRICE_RECORD_MESSAGE_TYPE && r.status === PRICE_RECORD_STATUS),
    )
    .map((r, i) => {
      const t = r.sent_at ? Date.parse(r.sent_at) : Number.NaN;
      // A sent row with no timestamp still went; it sorts oldest, not newest.
      return { r, i, ms: Number.isFinite(t) ? t : -Number.MAX_VALUE };
    })
    // Newest first; on a tie the later row in the read wins (as before).
    .sort((a, b) => b.ms - a.ms || b.i - a.i);

  for (const { r } of candidates) {
    const usd = recordedPrice(r[COUNTER_OFFER_COLUMN]);
    if (r.message_type === 'counter') {
      return usd != null ? { usd, source: 'counter' } : { usd: null, source: 'unknown' };
    }
    if (r.message_type === PRICE_RECORD_MESSAGE_TYPE) {
      // A record written pre-059 has only its sentence: unknown, never parsed.
      return usd != null ? { usd, source: 'operator' } : { usd: null, source: 'unknown' };
    }
    if (usd != null) return { usd, source: 'message' };    // Nothing on record for this message; an older one may have quoted.
  }
  return { usd: null, source: 'none' };
}

/**
 * Last sent price per campaign_influencer, for display. A lead whose price
 * cannot be known is OMITTED (never guessed); a failed read returns an empty
 * map, so the card simply shows nothing extra.
 */
export async function readLastSentOffers(
  sb: SupabaseClient,
  offers: ReadonlyArray<{ campaign_influencer_id: string | null }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ciIds = [...new Set(offers.map((o) => o.campaign_influencer_id).filter((x): x is string => !!x))];
  if (ciIds.length === 0) return out;
  const cols = 'campaign_influencer_id, message_type, direction, status, sent_at, body';
  const read = (select: string) =>
    sb
      .from('outreach_messages')
      .select(select)
      .in('campaign_influencer_id', ciIds)
      .eq('direction', 'outbound')
      .in('status', ['sent', PRICE_RECORD_STATUS]);
  // Pre-059 there is no structured price to show: every lead is unknown, so
  // the map stays empty (never a price read out of a message's text).
  const { data, error } = await read(`${cols}, ${COUNTER_OFFER_COLUMN}`);
  if (error) return out;
  const byCi = new Map<string, ThreadRow[]>();
  for (const r of (data ?? []) as unknown as Array<ThreadRow & { campaign_influencer_id: string }>) {
    const list = byCi.get(r.campaign_influencer_id) ?? [];
    list.push(r);
    byCi.set(r.campaign_influencer_id, list);
  }
  for (const o of offers) {
    if (!o.campaign_influencer_id) continue;
    const got = lastSentOffer(byCi.get(o.campaign_influencer_id) ?? []);
    if (got.usd != null) out.set(o.campaign_influencer_id, got.usd);
  }
  return out;
}

/**
 * The PATCH fields for a hand-edited message's optional "Price quoted" input
 * Counters are priced by their own field, so nothing here. Empty
 * input clears a price the row had, and sends nothing when it had none. A
 * typed value must be a dollar amount above $0.
 */
export function manualQuotedPayload(
  isCounter: boolean,
  raw: string,
  was: number | null,
): Record<string, never> | { offer_usd: number | null } | 'invalid' {
  if (isCounter) return {};
  const s = raw.trim().replace(/^\$/, '');
  if (s === '') return was != null ? { offer_usd: null } : {};
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) return 'invalid';
  const usd = Number(s);
  return Number.isFinite(usd) && usd > 0 ? { offer_usd: usd } : 'invalid';
}

export interface LastSentNotice {
  /** "Last price sent to creator: $150.00" */
  text: string;
  /** The agreed amount is not the last price the creator was sent. */
  differs: boolean;
  /** Set when `differs`: what the human should check before approving. */
  detail: string | null;
}

/**
 * The line shown beside the agreed amount. Null when the sent price is
 * unknown. Flagged when it differs from the agreed amount — legitimate when
 * the creator named their own number, worth a look before money moves.
 */
export function lastSentNotice(
  agreedUsd: number | null | undefined,
  lastSentUsd: number | null | undefined,
): LastSentNotice | null {
  if (lastSentUsd == null || !Number.isFinite(Number(lastSentUsd))) return null;
  const sent = Number(lastSentUsd);
  const agreed = agreedUsd == null ? null : Number(agreedUsd);
  const differs = agreed != null && Number.isFinite(agreed) && Math.abs(agreed - sent) >= 0.005;
  return {
    text: `Last price sent to creator: $${sent.toFixed(2)}`,
    differs,
    detail: differs
      ? `The agreed amount differs from the last price we sent. Check the thread for the number the creator actually accepted before approving.`
      : null,
  };
}

/**
 * A counter just WENT: make the offer row's standing price the price it
 * quoted. The two agree for an engine-drafted
 * counter, which is left alone; they differ when a human edited the draft's
 * price (counter-edit.ts),
 * and without this a later "deal!" would be agreed at the engine's number
 * instead of the one the creator was sent. Called by every send path: the
 * dispatch pass, the manual Send route, and the DM queue's Mark sent.
 *
 * The same for ANY other sent message carrying a recorded price (an
 * operator's manual send with "Price quoted" filled in): the creator now has
 * that number, so it is the standing offer, and the fold and the acceptance
 * gate read the same structured value.
 *
 * Only a negotiable offer is moved, guarded on the price read, so a
 * concurrent turn is never overwritten. Pre-059 (no recorded price) it does
 * nothing: no counter can carry an edited price then (counter-edit refuses).
 * Never throws — the message has already left.
 */
export type SentMessageSnapshot = ThreadRow & {
  campaign_influencer_id?: string | null;
  edited_by_user?: boolean | null;
};

export async function applySentCounterPrice(
  sb: SupabaseClient,
  messageId: string,
  /**
   * The row exactly as it was sent (the dispatch pass's claim
   * RETURNING). When given, its price is recorded and the row is NOT re-read,
   * so the price on record can never differ from the copy the creator got.
   */
  sent?: SentMessageSnapshot,
): Promise<void> {
  try {
    let m: SentMessageSnapshot;
    if (sent) {
      m = sent;
    } else {
      const { data, error } = await sb
        .from('outreach_messages')
        .select(`id, message_type, status, campaign_influencer_id, edited_by_user, ${COUNTER_OFFER_COLUMN}`)
        .eq('id', messageId)
        .maybeSingle();
      if (error || !data) return;
      m = data as unknown as SentMessageSnapshot;
    }
    if (m.status !== 'sent' || !m.campaign_influencer_id) return;
    if (m.message_type === PRICE_RECORD_MESSAGE_TYPE) return;
    // An engine-drafted counter's price IS the standing one (scheduleCounter
    // wrote both); only an edit can have moved it. Any other message carries
    // a price only when an operator entered one.
    if (m.message_type === 'counter' && m.edited_by_user !== true) return;
    const raw = m[COUNTER_OFFER_COLUMN];
    const usd = raw == null || raw === '' ? Number.NaN : Number(raw);
    if (!Number.isFinite(usd) || usd <= 0) return;
    const { data: offers, error: oErr } = await sb
      .from('creator_offers')
      .select('id, status, current_offer_usd')
      .eq('campaign_influencer_id', m.campaign_influencer_id);
    if (oErr) return;
    for (const o of (offers ?? []) as Array<{ id: string; status: string; current_offer_usd: unknown }>) {
      if (o.status !== 'offered' && o.status !== 'counter_offered') continue;
      if (o.current_offer_usd != null && Math.abs(Number(o.current_offer_usd) - usd) < 0.005) continue;
      const q = sb.from('creator_offers').update({ current_offer_usd: usd } as never).eq('id', o.id);
      const { error: wErr } = await (o.current_offer_usd == null
        ? q.is('current_offer_usd', null)
        : q.eq('current_offer_usd', o.current_offer_usd as never));
      if (wErr) console.warn('[last-sent-offer] could not record the sent counter price on the offer', o.id, wErr.message);
    }
  } catch (e) {
    console.warn('[last-sent-offer] applySentCounterPrice failed', e);
  }
}
