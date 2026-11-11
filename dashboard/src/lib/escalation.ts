// src/lib/escalation.ts
//
// Timed multi-channel escalation.
//
// The idea: the system strikes up deals via email, Instagram DM or LinkedIn
// message, and tries a different mode if it gets no response within some
// timeframe. Channel routing (channel-priors.ts) delivered routing BY best
// channel — one channel is chosen per creator and that is the end of it. Nothing ever
// tried a SECOND channel after silence. This module is that missing step.
//
// PURE. Given a lead's state, the creator's reachable channels, the firm's
// priors and a clock, it returns one decision. The tick does the DB work; the
// rules live here so tests can exercise every refusal without a database.
//
// ── LinkedIn: deliberately absent, and that is the finding ──────────────────
//
// The description above names LinkedIn. The repo cannot send one.
// Verified across src/, supabase/ and tools/: the ONLY things that
// mention it are (a) `outreach_messages.channel`'s CHECK constraint, which
// permits the string 'linkedin_dm' (migration 018), and (b) two comments
// naming Unipile as a someday-integration. There is no LinkedIn contact
// discovery, no account model, no dispatcher, and `toPriorChannel()` returns
// null for it so it has no conversion data either.
//
// Adding 'linkedin_dm' to the ladder would therefore produce a channel that
// ranks, gets selected, gets written to `channels_tried`, and then silently
// sends NOTHING — burning the lead's contact budget on a message no human
// will ever receive, and reporting it as an attempt. That is strictly worse
// than not having the channel: it manufactures the appearance of coverage.
//
// So LinkedIn is excluded HERE, by name, with a reason string that surfaces in
// the decision — not omitted by accident. `CHANNELS_WITHOUT_DISPATCH` is the
// registry, and the moment a real dispatch path exists, deleting one entry
// from it enables the channel. See tests/escalation.test.ts, which pins this
// behaviour so nobody re-adds LinkedIn without a dispatcher.

import type { ContactChannel } from './contact-discovery';
import { pickBestChannel, type ChannelPrior } from './contact-discovery';
import type { CampaignWindow } from './campaign-window';
import { canOpenThreadAt } from './campaign-window';
import { expandLegacyDmChannel, isLegacyDmChannel } from './social-dispatch';

/**
 * Channels named in the product story that have NO working dispatch path.
 * A channel listed here is never escalated to. Empty this list only by
 * shipping a real sender for the channel.
 */
export const CHANNELS_WITHOUT_DISPATCH: Record<string, string> = {
  linkedin_dm:
    'LinkedIn has no dispatch path in this repo — no contact discovery, no account model, no sender. Escalating to it would consume the lead contact budget and send nothing.',
};

/**
 * Default silence before the next channel is tried. Three days: long enough
 * that a creator who simply had a busy weekend is not double-tapped, short
 * enough to matter inside a six-week campaign.
 */
export const DEFAULT_SILENCE_HOURS = 72;

/** Floor on the configurable silence window — a guard against a 0 that would hammer a creator. */
export const MIN_SILENCE_HOURS = 12;

/**
 * Default ceiling on total outbound touches per lead when the firm has set no
 * `max_follow_ups`. One initial message plus two follow-ups matches the
 * onboarding form's own default of 2.
 */
export const DEFAULT_MAX_FOLLOW_UPS = 2;

const HOUR_MS = 3_600_000;

/**
 * The canonical "this lead has answered" set. `campaign_influencers
 * .outreach_status` is the state machine (migration 039): a contacted lead
 * sits at 'sent' until ingest-inbound classifies a reply and advances it.
 * Anything past 'sent' means a human engaged (or the lead is terminal), and
 * escalation must never touch it.
 */
export const REPLIED_OR_TERMINAL_STATUSES = [
  'responded',
  'negotiating',
  'rejected',
  'deal_closed',
] as const;

/** Only a lead that was contacted and stayed silent is escalatable. */
export const ESCALATABLE_STATUS = 'sent';

export interface EscalationPrefs {
  silence_hours: number;
  max_follow_ups: number;
}

/**
 * Escalation tuning from `firms.outreach_prefs` (migration 009's JSONB bag).
 *
 * `escalation_silence_hours` is the dedicated dial. When it is unset we fall
 * back to the firm's EXISTING `follow_up_cadence_days`, because that field
 * already means "how long we wait before touching this creator again" and a
 * firm that has tuned it should not have to tune a second thing to be obeyed.
 */
export function escalationPrefs(outreachPrefs: unknown): EscalationPrefs {
  const p =
    outreachPrefs && typeof outreachPrefs === 'object'
      ? (outreachPrefs as Record<string, unknown>)
      : {};

  let silence = DEFAULT_SILENCE_HOURS;
  const explicit = Number(p.escalation_silence_hours);
  const cadenceDays = Number(p.follow_up_cadence_days);
  if (Number.isFinite(explicit) && explicit > 0) {
    silence = explicit;
  } else if (Number.isFinite(cadenceDays) && cadenceDays > 0) {
    silence = cadenceDays * 24;
  }

  // max_follow_ups === 0 is meaningful ("one message only"), so it must
  // survive the falsy check that a bare `|| default` would eat.
  const rawMax = p.max_follow_ups;
  let maxFollowUps = DEFAULT_MAX_FOLLOW_UPS;
  if (rawMax === 0 || rawMax === '0') {
    maxFollowUps = 0;
  } else {
    const n = Number(rawMax);
    if (Number.isFinite(n) && n > 0) maxFollowUps = Math.floor(n);
  }

  return {
    silence_hours: Math.max(MIN_SILENCE_HOURS, silence),
    max_follow_ups: maxFollowUps,
  };
}

/** Everything the decision needs about one lead. */
export interface LeadEscalationState {
  campaign_influencer_id: string;
  /** campaign_influencers.outreach_status — the reply state machine. */
  outreach_status: string | null;
  /** The channel the first touch went out on (campaign_influencers.primary_channel). */
  primary_channel: string | null;
  /** migration 049 — channels already attempted for this lead. */
  channels_tried: string[] | null;
  /** migration 049 — earliest next escalation, set when the last attempt was made. */
  next_attempt_at: string | null;
  /** campaign_influencers.last_outreach_at — when we last messaged them. */
  last_outreach_at: string | null;
  /**
   * Real outbound touches already committed to this lead: rows in
   * `outreach_messages` with direction='outbound' and status IN
   * ('sent','queued'). Counted from the messages table, NOT from
   * `campaign_influencers.message_count`.
   *
   * Why not message_count — it does not mean what its name says:
   *   * it is stamped at DRAFT time by saveOutreachMessage, so it counts
   *     drafts, not sends;
   *   * the version count behind it queries outreach_messages with NO
   *     direction filter, so every INBOUND creator reply inflates it — a
   *     chatty creator would hit the contact cap faster than a silent one;
   *   * the bulk draft path (draft-all) writes an identical draft row and
   *     never touches it, so two routes to the same user action disagree;
   *   * the send route never touches it at all, so it is decoupled from
   *     delivery entirely;
   *   * two ops scripts reset it to 0 without deleting the messages.
   *
   * In practice every 'sent' and every 'responded' lead can carry
   * message_count = 0, so a cap read from it never binds for ANY
   * configuration — including max_follow_ups: 0. The guard was inoperative.
   *
   * 'queued' counts alongside 'sent' because a queued row is a committed
   * future send; ignoring it would let a batch of escalations blow past the
   * ceiling before any of them fired. 'draft' and 'window_closed' do not
   * count — neither was ever delivered.
   */
  outbound_count: number | null;
  /** True when a pool gate or the blocklist already bars contact (contactBlocksFor). */
  contact_blocked: boolean;
  /** Reason for the above, surfaced verbatim so the skip is inspectable. */
  contact_block_reason?: string | null;
}

export type EscalationDecision =
  | {
      action: 'escalate';
      channel: ContactChannel;
      /** Which ranking produced it — the existing pickBestChannel provenance. */
      source: 'priors' | 'cold_start';
      /** channels_tried after this attempt is recorded. */
      next_channels_tried: string[];
      /** next_attempt_at after this attempt, ms-epoch. */
      next_attempt_ms: number;
    }
  | { action: 'skip'; reason: EscalationSkipReason; detail?: string };

export type EscalationSkipReason =
  | 'not_contacted_yet'
  | 'already_replied'
  | 'contact_blocked'
  | 'cap_reached'
  /** The real outbound count could not be read — never escalate blind. */
  | 'cap_unknown'
  | 'too_soon'
  | 'outside_window'
  | 'no_untried_channel';

export interface EscalationInput {
  lead: LeadEscalationState;
  /** Channels the creator can actually be reached on (contact-discovery.availableChannels). */
  available: ContactChannel[];
  /** Firm channel priors — the SAME ranking signal channel routing uses. */
  priors: ChannelPrior[] | null | undefined;
  prefs: EscalationPrefs;
  window: CampaignWindow | null;
  nowMs: number;
}

/**
 * Normalize the channels already attempted. `primary_channel` is folded in
 * because the FIRST touch predates migration 049 and therefore never wrote
 * `channels_tried` — without this, every pre-existing lead would "escalate" to
 * the channel it was already contacted on, i.e. send a duplicate.
 *
 * ── The legacy 'dm' expansion, and why it lives HERE ────────────────────────
 *
 * An earlier revision of this function recorded the literal string 'dm' and
 * said so in a comment: legacy 'dm' "is recorded as attempted so it can never
 * be re-picked, but it does not mask instagram_dm or tiktok_dm." That was
 * sound while 'dm' was unroutable. It stopped being sound when
 * `resolveOutreachChannel` learned to resolve 'dm' → the creator's platform DM
 * and draft-all started stamping `channel='tiktok_dm'` on the message — with
 * no write-back to `primary_channel` or `channels_tried`.
 *
 * The result was a duplicate send, reachable on every legacy 'dm' TikTok row:
 * first touch DM'd on tiktok_dm, lead flipped to
 * 'sent', `channels_tried` still empty, `primary_channel` still 'dm' — so
 * tried={'dm'} vs available=['tiktok_dm'], tiktok_dm looked untried, and the
 * escalation re-queued `prev.body` VERBATIM to the same TikTok inbox, as a
 * `human_queue` row indistinguishable from a first touch.
 *
 * It is fixed here, in the bookkeeping, rather than only by writing the
 * resolved channel back at draft time, because this is the single place the
 * decision is made. `escalationDecision` is the only function that can return
 * `action: 'escalate'`, and it is the only caller that matters — so the
 * expansion cannot be skipped by a caller that forgets a write-back, by a new
 * draft path, or by any of the 315 rows already in the table with 'dm' on them.
 * A data write-back fixes rows written AFTER it ships; this fixes the read.
 *
 * `available` is optional so every existing caller keeps compiling, and
 * defaults to the conservative interpretation via `expandLegacyDmChannel`.
 */
export function attemptedChannels(
  lead: LeadEscalationState,
  available: readonly string[] = [],
): string[] {
  const raw: string[] = [];
  for (const c of lead.channels_tried ?? []) {
    if (typeof c === 'string' && c) raw.push(c);
  }
  if (lead.primary_channel) raw.push(lead.primary_channel);

  const set = new Set<string>();
  for (const c of raw) {
    // The legacy value is kept as well as expanded: it is a true record of
    // what the row said, and keeping it means a future writer that persists
    // this set cannot silently lose the fact that the row was legacy.
    set.add(c);
    if (isLegacyDmChannel(c)) {
      for (const concrete of expandLegacyDmChannel(available)) set.add(concrete);
    }
  }
  return [...set];
}

/**
 * Decide whether this lead escalates to another channel right now.
 *
 * Order is deliberate: the free, absolute refusals run before anything that
 * costs a query or a model call, and the two safety rules the issue calls out
 * as hard requirements — never escalate a replied lead, never escalate past
 * the contact cap — are checked before channel selection, not after.
 */
export function escalationDecision(input: EscalationInput): EscalationDecision {
  const { lead, prefs, nowMs, window: w } = input;

  // 1. Must have actually been contacted. 'pending'/'draft_ready' leads have
  //    no first touch to escalate FROM — they belong to the send path.
  if (lead.outreach_status !== ESCALATABLE_STATUS) {
    if (
      (REPLIED_OR_TERMINAL_STATUSES as readonly string[]).includes(lead.outreach_status ?? '')
    ) {
      return { action: 'skip', reason: 'already_replied' };
    }
    return { action: 'skip', reason: 'not_contacted_yet' };
  }

  // 2. Pool gates + blocklist. A gated or blocklisted creator must not be
  //    escalated to — the same rule the draft and dispatch paths enforce.
  if (lead.contact_blocked) {
    return {
      action: 'skip',
      reason: 'contact_blocked',
      detail: lead.contact_block_reason ?? undefined,
    };
  }

  // 3. Per-lead contact cap. An escalation IS a touch, so it counts against
  //    the firm's max_follow_ups exactly as a same-channel follow-up would.
  //    The initial message is one of these touches, so the ceiling on total
  //    outbound messages is 1 + max_follow_ups.
  //
  //    FAIL CLOSED on an unknown count. A null here means the caller could not
  //    read the messages table; escalating on an unknown touch count is how a
  //    creator gets contacted past a ceiling the firm set.
  if (lead.outbound_count == null) {
    return { action: 'skip', reason: 'cap_unknown' };
  }
  const sent = Math.max(0, lead.outbound_count);
  if (sent >= 1 + prefs.max_follow_ups) {
    return { action: 'skip', reason: 'cap_reached' };
  }

  // 4. Silence window. next_attempt_at (049) wins when present; otherwise
  //    derive it from the last touch so leads predating the migration still
  //    observe the cadence instead of all escalating at once on deploy.
  const nextAttemptMs = lead.next_attempt_at ? Date.parse(lead.next_attempt_at) : NaN;
  if (Number.isFinite(nextAttemptMs)) {
    if (nowMs < nextAttemptMs) return { action: 'skip', reason: 'too_soon' };
  } else {
    const lastMs = lead.last_outreach_at ? Date.parse(lead.last_outreach_at) : NaN;
    // No last-touch timestamp at all → we cannot prove the silence window has
    // elapsed. Fail closed: wait rather than risk an immediate double-tap.
    if (!Number.isFinite(lastMs)) return { action: 'skip', reason: 'too_soon' };
    if (nowMs < lastMs + prefs.silence_hours * HOUR_MS) {
      return { action: 'skip', reason: 'too_soon' };
    }
  }

  // 5. Campaign window. An escalation OPENS A NEW THREAD on a new
  //    channel, so it takes the hard gate, not the in-thread grace.
  if (!canOpenThreadAt(w, nowMs)) {
    return { action: 'skip', reason: 'outside_window' };
  }

  // 6. Next-best UNTRIED channel, ranked by the existing channel priors.
  //
  //    `available` is passed so a legacy `primary_channel='dm'` is expanded to
  //    the concrete channel(s) it actually resolves to for THIS creator —
  //    otherwise a lead already DM'd on TikTok escalates onto tiktok_dm and
  //    the human pastes the identical body into the same inbox.
  const tried = new Set(attemptedChannels(lead, input.available));
  const candidates = input.available.filter(
    (ch) => !tried.has(ch) && !(ch in CHANNELS_WITHOUT_DISPATCH),
  );
  if (candidates.length === 0) {
    return { action: 'skip', reason: 'no_untried_channel' };
  }

  // Reuse channel routing's ranking verbatim — same Laplace-smoothed prior score,
  // same cold-start order, same deterministic tie-break. Escalation must not
  // invent a second, divergent notion of "best channel".
  const picked = pickBestChannel(candidates, input.priors);

  return {
    action: 'escalate',
    channel: picked.channel,
    source: picked.source,
    next_channels_tried: [...tried, picked.channel],
    next_attempt_ms: nowMs + prefs.silence_hours * HOUR_MS,
  };
}
