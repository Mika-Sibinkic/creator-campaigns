// src/lib/first-touch-gate.ts
//
// The mini-run limit and budget pacing, enforced where a creator is contacted
// for the FIRST time.
//
// Two refusals, both 409, both only for a first touch: a reply, counter or
// follow-up to a creator this campaign has already contacted is never limited.
//
//   1. OUTREACH LIMIT. campaigns.outreach_limit (migration 060, nullable; null
//      = no limit). Once that many creators have been contacted, no further
//      creator is: "Campaign limit reached (10 of 10 contacted)". Pre-060 the
//      column is missing and there is no limit.
//
//   2. BUDGET PACING. Before this, a label could have more live offers than
//      it could pay: offers at 'offered' are not committed spend (migration
//      054's guard), so the budget only bit once a deal was agreed. Now a new
//      creator is contacted only while
//          committed + open offers (at their current amount)
//          + cap × contacted creators with no offer yet
//          + cap (the creator about to be contacted)
//        <= total_budget_usd
//      "committed" is campaignCommittedUsd — the same read
//      computeEffectiveCeiling uses (src/lib/negotiation.ts), not a copy.
//
//   3. COMMENT HOLD (migration 066, 2026-10-01). A creator held by the
//      comment-quality audit (campaign_influencers.comment_held, no
//      comment_override) is refused with error 'excluded', reason
//      'comment_hold' (comment-audit-store.ts). Pre-066: no hold.
//
// FAIL CLOSED. Any read this needs that fails is a 503 and nothing is sent.
// An unset budget or per-creator cap is a 409 naming the fix: the send path
// used to send anyway and leave the unset budget to escalate at negotiation
// time, after the creator already had an offer.
//
// "Contacted" = a campaign_influencers row that is already in a conversation,
// by ANY of four signals, checked cheapest first:
//   - its markers: outreach_status past draft_ready, or last_outreach_at set;
//   - a creator_offers row (sending opens the offer — openOfferForSentOutreach);
//   - an outreach message already gone (sent_at set, or status 'sent'), or a
//     DM opener holding a live first-touch reservation (dm_reserved_at,
//     migration 060; src/lib/dm-reservation.ts) — a slot held for a DM the
//     human is about to send counts exactly like a sent opener;
//   - an inbound message from the creator (a reply is never a first touch).
// Each alone misses real rows: the send route did not write outreach_status
// in older versions, a human-queue DM before that did not write last_outreach_at,
// and a thread a creator opened has no outbound row at all.
//
// Callers (production):
//   src/app/api/outreach/[id]/send/route.ts      manual Send + bulk send (+ recount after claim)
//   src/lib/dm-mark-sent.ts                      DM queue "Mark sent" (+ recount after claim)
//   src/lib/dm-reserve.ts                        DM queue "Reserve & copy" (+ recount after claim)
//   src/lib/negotiation-tick.ts dispatchDue      scheduled dispatch (+ recount after claim)
//   src/app/api/campaigns/[id]/draft-all         draft volume (openerSlots)
//   src/app/api/outreach/generate-bulk           draft volume (openerSlots)
//   src/app/api/campaigns/[id] GET               "Contacted X of N"
//
// Executed by tests/first-touch-gate.test.ts.

import type { SupabaseClient } from '@supabase/supabase-js';
import { campaignCommittedUsd } from './negotiation';
import { resolveCampaignBudget } from './spend-caps';
import { isMissingColumnError } from './holding-note';
import { DM_RESERVED_AT_COLUMN, reservationLive } from './dm-reservation';
import { COMMENT_HOLD_REFUSAL_BODY, readCommentHold } from './comment-audit-store';

export const OUTREACH_LIMIT_COLUMN = 'outreach_limit' as const;

/** outreach_status values that mean a message has gone out (outreach-status.ts). */
export const CONTACTED_OUTREACH_STATUSES = [
  'sent',
  'responded',
  'negotiating',
  'rejected',
  'deal_closed',
] as const;

/** Reply-only message types are never a first touch (defined client-safe in dm-reservation.ts). */
export { REPLY_ONLY_MESSAGE_TYPES, isReplyOnlyMessageType } from './dm-reservation';

/** Offers still being negotiated: in play, not yet committed spend. */
export const OPEN_OFFER_STATES = ['queued', 'offered', 'counter_offered'] as const;

const EPS = 0.005;

export interface CiContactMarkers {
  id: string;
  outreach_status?: string | null;
  last_outreach_at?: string | null;
}

export function markersSayContacted(ci: CiContactMarkers): boolean {
  if (ci.last_outreach_at) return true;
  return (CONTACTED_OUTREACH_STATUSES as readonly string[]).includes(ci.outreach_status ?? '');
}

function messageWentOut(m: { sent_at?: string | null; status?: string | null }): boolean {
  return !!m.sent_at || m.status === 'sent';
}

/** A positive integer, or null (no limit). Anything else is no limit. */
export function normalizeOutreachLimit(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export type OutreachLimitRead =
  | { state: 'ok'; limit: number | null }
  /** Pre-060: the column does not exist. No limit, and the UI hides the field. */
  | { state: 'unsupported' }
  | { state: 'unreadable'; message: string };

export async function readOutreachLimit(
  sb: SupabaseClient,
  campaignId: string,
): Promise<OutreachLimitRead> {
  const { data, error } = await sb
    .from('campaigns')
    .select(OUTREACH_LIMIT_COLUMN)
    .eq('id', campaignId)
    .maybeSingle();
  if (error) {
    if (isMissingColumnError(error)) return { state: 'unsupported' };
    return { state: 'unreadable', message: (error as { message?: string }).message ?? 'read failed' };
  }
  if (!data) return { state: 'unreadable', message: 'campaign_not_found' };
  return { state: 'ok', limit: normalizeOutreachLimit((data as Record<string, unknown>)[OUTREACH_LIMIT_COLUMN]) };
}

/** Is campaigns.outreach_limit there? (pre-060 → false). Null when the probe itself failed. */
export async function outreachLimitSupported(sb: SupabaseClient): Promise<boolean | null> {
  const { error } = await sb.from('campaigns').select(OUTREACH_LIMIT_COLUMN).limit(1);
  if (!error) return true;
  return isMissingColumnError(error) ? false : null;
}

export type ContactsRead =
  | { ok: true; contactedIds: Set<string> }
  | { ok: false; message: string };

/** Every creator this campaign has contacted (or holds a live DM reservation for). */
export async function readCampaignContacts(
  sb: SupabaseClient,
  campaignId: string,
  nowMs: number = Date.now(),
): Promise<ContactsRead> {
  const { data: ciRows, error: ciErr } = await sb
    .from('campaign_influencers')
    .select('id, outreach_status, last_outreach_at')
    .eq('campaign_id', campaignId);
  if (ciErr) return { ok: false, message: ciErr.message };
  const contactedIds = await contactedAmong(sb, (ciRows ?? []) as CiContactMarkers[], nowMs);
  if (!contactedIds) return { ok: false, message: 'contact history could not be read' };
  return { ok: true, contactedIds };
}

/**
 * Of these campaign_influencers rows, the ones already in a conversation (the
 * four signals in the header). Each read covers only the ids still undecided,
 * so a batch of already-contacted threads costs nothing past the markers.
 * null = a read failed and the answer is unknown.
 */
async function contactedAmong(
  sb: SupabaseClient,
  cis: readonly CiContactMarkers[],
  nowMs: number,
): Promise<Set<string> | null> {
  const out = new Set<string>();
  for (const ci of cis) if (markersSayContacted(ci)) out.add(ci.id);
  const sources: Array<{
    table: string;
    cols: string;
    /** Selected when it exists; pre-migration the read retries without it. */
    optionalCol?: string;
    hit: (r: Record<string, unknown>) => boolean;
  }> = [
    { table: 'creator_offers', cols: 'campaign_influencer_id', hit: () => true },
    {
      table: 'outreach_messages',
      cols: 'campaign_influencer_id, sent_at, status',
      optionalCol: DM_RESERVED_AT_COLUMN,
      hit: (r) =>
        messageWentOut(r as { sent_at?: string | null; status?: string | null }) ||
        reservationLive(r[DM_RESERVED_AT_COLUMN], nowMs),
    },
    { table: 'inbound_messages', cols: 'campaign_influencer_id', hit: () => true },
  ];
  for (const s of sources) {
    const ids = cis.map((c) => c.id).filter((id) => !out.has(id));
    if (ids.length === 0) break;
    const read = (cols: string) => sb.from(s.table).select(cols).in('campaign_influencer_id', ids);
    let { data, error } = await read(s.optionalCol ? `${s.cols}, ${s.optionalCol}` : s.cols);
    if (error && s.optionalCol && isMissingColumnError(error)) ({ data, error } = await read(s.cols));
    if (error) return null;
    for (const r of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      const id = r.campaign_influencer_id;
      if (typeof id === 'string' && s.hit(r)) out.add(id);
    }
  }
  return out;
}

/** Has this one creator already been contacted? null = could not tell. */
export async function threadContacted(
  sb: SupabaseClient,
  ci: CiContactMarkers,
  nowMs: number = Date.now(),
): Promise<boolean | null> {
  const hit = await contactedAmong(sb, [ci], nowMs);
  return hit == null ? null : hit.has(ci.id);
}

/**
 * Of these threads, the ones already contacted, for a whole batch (the
 * dispatch pass). A thread with no campaign_influencers row is judged on its
 * offers and messages alone. null = could not tell.
 */
export async function threadsAlreadyContacted(
  sb: SupabaseClient,
  ciIds: readonly string[],
  nowMs: number = Date.now(),
): Promise<Set<string> | null> {
  if (ciIds.length === 0) return new Set();
  const { data: ciRows, error: ciErr } = await sb
    .from('campaign_influencers')
    .select('id, outreach_status, last_outreach_at')
    .in('id', [...ciIds]);
  if (ciErr) return null;
  const byId = new Map(((ciRows ?? []) as CiContactMarkers[]).map((c) => [c.id, c]));
  return contactedAmong(sb, ciIds.map((id) => byId.get(id) ?? { id }), nowMs);
}

export interface InPlay {
  committed: number;
  open: number;
  /** Contacted creators with no offer row at all, each held at the cap. */
  uncovered: number;
  total: number;
}

/** What the campaign already has in play, in dollars. null = unreadable. */
export async function campaignInPlayUsd(
  sb: SupabaseClient,
  campaignId: string,
  perCreatorCapUsd: number,
  contactedIds: ReadonlySet<string>,
): Promise<InPlay | null> {
  const committed = await campaignCommittedUsd(sb, campaignId, null);
  if (committed == null) return null;
  const { data, error } = await sb
    .from('creator_offers')
    .select('campaign_influencer_id, status, current_offer_usd, initial_offer_usd')
    .eq('campaign_id', campaignId);
  if (error) return null;
  const offers = (data ?? []) as Array<{
    campaign_influencer_id: string | null;
    status: string | null;
    current_offer_usd: number | string | null;
    initial_offer_usd: number | string | null;
  }>;
  let open = 0;
  const covered = new Set<string>();
  for (const o of offers) {
    if (o.campaign_influencer_id) covered.add(o.campaign_influencer_id);
    if ((OPEN_OFFER_STATES as readonly string[]).includes(o.status ?? '')) {
      const amt = Number(o.current_offer_usd ?? o.initial_offer_usd ?? perCreatorCapUsd);
      open += Number.isFinite(amt) ? amt : perCreatorCapUsd;
    }
  }
  let uncoveredCount = 0;
  for (const id of contactedIds) if (!covered.has(id)) uncoveredCount += 1;
  const uncovered = uncoveredCount * perCreatorCapUsd;
  return { committed, open, uncovered, total: committed + open + uncovered };
}

export function formatUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export type GateRefusal = { ok: false; status: 409 | 503; body: { error: string; message: string } & Record<string, unknown> };
export type FirstTouchVerdict = { ok: true; firstTouch: boolean } | GateRefusal;

export const GATE_UNREADABLE_MESSAGE =
  "Couldn't confirm this campaign's outreach limit and budget, so nothing was sent. Try again in a minute.";

const unreadable = (detail: string): GateRefusal => ({
  ok: false,
  status: 503,
  body: { error: 'first_touch_unverifiable', message: GATE_UNREADABLE_MESSAGE, detail },
});

/**
 * The pure decision, given what was read. Exported for the tests; the DB
 * shell is checkFirstTouch below.
 */
export async function decideFirstTouch(input: {
  limit: number | null;
  contacted: number;
  totalBudgetRaw: unknown;
  perCreatorCapRaw: unknown;
  /** Called only when both are set; null = unreadable. */
  inPlay: (capUsd: number) => Promise<InPlay | null>;
}): Promise<FirstTouchVerdict> {
  if (input.limit != null && input.contacted >= input.limit) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'outreach_limit_reached',
        message: `Campaign limit reached (${input.contacted} of ${input.limit} contacted)`,
        contacted: input.contacted,
        limit: input.limit,
      },
    } as GateRefusal;
  }
  const budget = resolveCampaignBudget(input.totalBudgetRaw);
  if (!budget.ok) {
    return {
      ok: false,
      status: 409,
      body: { error: 'campaign_budget_not_set', message: 'Set a campaign budget before contacting creators' },
    } as GateRefusal;
  }
  const cap = Number(input.perCreatorCapRaw);
  if (input.perCreatorCapRaw == null || input.perCreatorCapRaw === '' || !Number.isFinite(cap) || cap <= 0) {
    return {
      ok: false,
      status: 409,
      body: { error: 'per_creator_cap_not_set', message: 'Set a per-creator cap before contacting creators' },
    } as GateRefusal;
  }
  const inPlay = await input.inPlay(cap);
  if (!inPlay) return unreadable('in-play spend could not be read');
  if (inPlay.total + cap > budget.totalBudgetUsd + EPS) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'budget_fully_allocated',
        message: `Budget fully allocated: ${formatUsd(inPlay.total)} in play of ${formatUsd(budget.totalBudgetUsd)}`,
        in_play_usd: inPlay.total,
        total_budget_usd: budget.totalBudgetUsd,
        per_creator_cap_usd: cap,
      },
    } as GateRefusal;
  }
  return { ok: true, firstTouch: true };
}

/**
 * May this creator be contacted now? A creator already contacted always may
 * (not a first touch). Otherwise the outreach limit, then budget pacing.
 */
export async function checkFirstTouch(
  sb: SupabaseClient,
  campaignInfluencerId: string,
  nowMs: number = Date.now(),
): Promise<FirstTouchVerdict> {
  const { data: ciRow, error: ciErr } = await sb
    .from('campaign_influencers')
    .select('id, campaign_id, outreach_status, last_outreach_at')
    .eq('id', campaignInfluencerId)
    .maybeSingle();
  if (ciErr || !ciRow) return unreadable(ciErr?.message ?? 'campaign_influencer_not_found');
  const ci = ciRow as CiContactMarkers & { campaign_id: string };

  const already = await threadContacted(sb, ci, nowMs);
  if (already == null) return unreadable('thread could not be read');
  if (already) return { ok: true, firstTouch: false };

  return evaluateFirstTouch(sb, ci, nowMs);
}

/**
 * THE SAME DECISION, RE-TAKEN AFTER THE SEND CLAIM (the race the pre-check
 * alone leaves open). checkFirstTouch is a read; two first touches in flight
 * at once (bulk send fires a batch concurrently, or two tabs) can both read
 * "9 of 10" and both send. The send claim (src/lib/outbound-claim.ts) is a
 * committed write that already makes the thread read as contacted, so a
 * sender that re-counts AFTER its own claim sees every rival that claimed
 * before that recount. Of any two racers the later recount sees both and
 * refuses; at worst both refuse, never both send. The caller releases its
 * claim on a refusal. Only for a send the pre-check judged a first touch.
 */
export async function recheckFirstTouchAfterClaim(
  sb: SupabaseClient,
  campaignInfluencerId: string,
  nowMs: number = Date.now(),
): Promise<FirstTouchVerdict> {
  const { data: ciRow, error: ciErr } = await sb
    .from('campaign_influencers')
    .select('id, campaign_id')
    .eq('id', campaignInfluencerId)
    .maybeSingle();
  if (ciErr || !ciRow) return unreadable(ciErr?.message ?? 'campaign_influencer_not_found');
  return evaluateFirstTouch(sb, ciRow as { id: string; campaign_id: string }, nowMs);
}

/**
 * Could this campaign contact one more NEW creator now? The same decision as
 * checkFirstTouch for a creator not yet contacted, taken once per campaign:
 * the DM queue's listing stamps "Limit reached" with it before anyone copies.
 */
export async function checkCampaignFirstTouchSlot(
  sb: SupabaseClient,
  campaignId: string,
  nowMs: number = Date.now(),
): Promise<FirstTouchVerdict> {
  return evaluateFirstTouch(sb, { id: '', campaign_id: campaignId }, nowMs);
}

/**
 * Limit + pacing for contacting `ci`, judged against every OTHER creator the
 * campaign has in play. `ci` itself is left out of the count, so the answer is
 * the same before its send is claimed (when it is not yet contacted) and after
 * (when its own claim makes it read as contacted).
 */
async function evaluateFirstTouch(
  sb: SupabaseClient,
  ci: { id: string; campaign_id: string },
  nowMs: number,
): Promise<FirstTouchVerdict> {
  // COMMENT HOLD (migration 066, src/lib/comment-audit.ts). A creator whose
  // comments are consistently hostile to them is not contacted until a human
  // overrides. Per creator, so the campaign-level slot check (id '') skips
  // it. Pre-066 there is no hold; an unreadable hold fails closed like every
  // other read here.
  if (ci.id) {
    const hold = await readCommentHold(sb, ci.id);
    if (hold.state === 'unreadable') return unreadable(hold.message);
    if (hold.state === 'ok' && hold.held) {
      return { ok: false, status: 409, body: { ...COMMENT_HOLD_REFUSAL_BODY } } as GateRefusal;
    }
  }

  const { data: camp, error: campErr } = await sb
    .from('campaigns')
    .select('total_budget_usd, per_creator_cap_usd')
    .eq('id', ci.campaign_id)
    .maybeSingle();
  if (campErr || !camp) return unreadable(campErr?.message ?? 'campaign_not_found');
  const c = camp as { total_budget_usd: unknown; per_creator_cap_usd: unknown };

  const lim = await readOutreachLimit(sb, ci.campaign_id);
  if (lim.state === 'unreadable') return unreadable(lim.message);

  const contacts = await readCampaignContacts(sb, ci.campaign_id, nowMs);
  if (!contacts.ok) return unreadable(contacts.message);
  const others = new Set(contacts.contactedIds);
  others.delete(ci.id);

  return decideFirstTouch({
    limit: lim.state === 'ok' ? lim.limit : null,
    contacted: others.size,
    totalBudgetRaw: c.total_budget_usd,
    perCreatorCapRaw: c.per_creator_cap_usd,
    inPlay: (cap) => campaignInPlayUsd(sb, ci.campaign_id, cap, others),
  });
}

/**
 * How many more creators may get an opener DRAFTED. Draft-all and
 * generate-bulk write at most this many (highest composite score first), so
 * a mini-run of 10 produces 10 drafts, not a pool's worth. Slots are used by
 * contacted creators and by creators with an unsent opener already drafted.
 * null = no limit.
 */
export function openerSlots(limit: number | null, used: ReadonlySet<string>): number | null {
  if (limit == null) return null;
  return Math.max(0, limit - used.size);
}

/**
 * The creators to draft an opener for: highest composite score first (no
 * score sorts last), at most `slots` of them (null = no limit).
 */
export function pickOpenerTargets<T extends { composite_score: number | null }>(
  rows: readonly T[],
  slots: number | null,
): T[] {
  const score = (r: T) => (typeof r.composite_score === 'number' ? r.composite_score : Number.NEGATIVE_INFINITY);
  const sorted = [...rows].sort((a, b) => (score(a) === score(b) ? 0 : score(b) > score(a) ? 1 : -1));
  return slots == null ? sorted : sorted.slice(0, Math.max(0, slots));
}

/** "Contacted X of N" — defined in the client-safe copy module, re-exported. */
export { contactedLabel } from './outreach-send-copy';
