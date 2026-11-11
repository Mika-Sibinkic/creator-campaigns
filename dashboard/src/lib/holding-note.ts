// src/lib/holding-note.ts
//
// The holding note.
//
// WHAT IT IS
//   Before the AI sends an EMAIL counter or acceptance, a person on the label's
//   side would usually fire off a quick "Thanks, let me check on my end and get
//   back to you in the next 15 minutes." and then send the real answer a few
//   minutes later. This module decides whether that note goes, what it says,
//   when it goes relative to the real reply, and whether it may still leave at
//   dispatch time. The DB shell lives in negotiation-tick.ts
//   (planHeldReply / queueHoldingNote / the holding branch in dispatchDue).
//
// THE ONE INVARIANT: NEVER AN EMPTY PROMISE
//   A note that says "back to you in 15 minutes" is only honest if a reply is
//   actually scheduled inside those 15 minutes. Every rule below serves that:
//     * scheduling: note 60–180s after the creator's reply ARRIVED, the real
//       reply 300–480s after (send-cadence.ts; now + 15–60s for any band
//       already elapsed at pickup, note still first), and only when BOTH fall
//       inside the send window —
//       a note at 20:58 whose reply quiet hours defers to 09:20 tomorrow is
//       worse than no note;
//     * dispatch: the note leaves only while its real reply is still queued and
//       due between HOLDING_MIN_LEAD_MS and HOLDING_REPLY_DEADLINE_MS from now. A
//       deleted, window-closed, deferred or already-due reply drops the note to
//       the terminal status 'superseded' instead;
//     * after the note has gone: a later reply on the same thread (the creator
//       wrote again, the first reply was withdrawn) is pulled inside the
//       original promise rather than drawn fresh.
//
// ORDER ON THE THREAD
//   A real reply never goes less than HOLDING_MIN_GAP_MS after a note on the
//   same thread, whether that note is still queued (its send_after) or went
//   moments ago (its sent_at). A note never goes after a real reply on the
//   same thread: if another reply is due first, or one is sent while the note
//   is still queued, the note is superseded. Without this a second creator
//   message could produce counter -> note -> counter.
//
// ONE NOTE PER INBOUND
//   planHeldReply reads the thread first (a queued or unanswered note blocks
//   another), which covers sequential re-runs. Overlapping ticks both read an
//   empty thread, so migration 057 adds a partial unique index on
//   HOLDING_NOTE_INBOUND_COLUMN; the insert treats the violation as "already
//   queued" and falls back to a column-less insert until 057 is applied.
//
// WHAT IT IS NOT
//   Not for DMs — DM replies go through a human queue, and a human does not
//   need a robot's stalling line queued ahead of them. Not for clarification
//   answers — those are fast already (120–240s) and nothing is being "checked".
//
// No model call: the copy is a small fixed set of human variants. A holding
// note says nothing about money or terms, so there is nothing to generate and
// nothing a model could get wrong.

import {
  CADENCE_BANDS,
  CATCH_UP_JITTER_BAND,
  HELD_REPLY_BAND,
  HOLDING_PROMISE_MINUTES,
  cadenceKindFor,
  delaySecondsInBand,
  type CadenceBand,
} from './send-cadence';
import { inSendWindow } from './quiet-hours';

/** outreach_messages.message_type for the note. Free text, no CHECK (see 009/019). */
export const HOLDING_NOTE_MESSAGE_TYPE = 'holding_note' as const;

/**
 * Terminal status for a note that was dropped instead of sent. Registered in
 * src/lib/message-status.ts so no UI offers to send it by hand.
 */
export const HOLDING_NOTE_SUPERSEDED_STATUS = 'superseded' as const;

/** The replies a holding note may precede. */
export const HELD_REPLY_MESSAGE_TYPES = ['counter', 'agreement_confirmation'] as const;
export type HeldReplyType = (typeof HELD_REPLY_MESSAGE_TYPES)[number];

/**
 * Latest a reply may land after the note and still keep the promise. 13 of the
 * promised 15 minutes: dispatch runs once a minute, so a row due at 13:00 can
 * leave as late as ~14:00, and the promise still holds.
 */
export const HOLDING_REPLY_DEADLINE_MS = (HOLDING_PROMISE_MINUTES - 2) * 60_000;

/**
 * At dispatch, the real reply must still be at least this far out for the note
 * to leave. 30s, not 60: dispatch runs once a minute, so a note can leave up to
 * a minute after its send_after, and HOLDING_MIN_GAP_MS below keeps that much
 * room behind it.
 */
export const HOLDING_MIN_LEAD_MS = 30_000;

/**
 * At scheduling, the real reply trails the note by at least this. Only binds
 * when pickup was late and both would otherwise land at the same catch-up
 * moment; on a prompt pickup the bands already keep them 2+ minutes apart.
 */
export const HOLDING_MIN_GAP_MS = 120_000;

/**
 * The column that ties a holding note to the inbound it answers
 * (migration 057, NOT yet applied). 057 puts a partial unique index on it, so
 * two overlapping ticks can never queue two notes for one creator reply.
 */
export const HOLDING_NOTE_INBOUND_COLUMN = 'in_reply_to_inbound_id' as const;

/**
 * What a holding-note insert error means:
 *   duplicate       23505 on 057's index — the note is already queued. No-op.
 *   missing_column  057 not applied yet (PGRST204 / 42703) — retry without the
 *                   column; the per-thread read in planHeldReply still guards
 *                   sequential re-runs, only the overlap race is unguarded.
 *   other           a real failure. No note; the reply still goes.
 * Same missing-column test as ingest-inbound.ts's isMissingColumnError.
 */
export function classifyHoldingInsertError(
  error: unknown,
): 'ok' | 'duplicate' | 'missing_column' | 'other' {
  if (!error) return 'ok';
  const e = error as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  if (code === '23505' || msg.includes('duplicate key')) return 'duplicate';
  if (isMissingColumnError(error)) return 'missing_column';
  return 'other';
}

/**
 * True when the database is saying a COLUMN does not exist: PostgREST's schema
 * cache miss (PGRST204) or Postgres undefined_column (42703). The signal that a
 * migration this code already speaks (057) has not been applied yet. Same test
 * as ingest-inbound.ts's private helper, exported here because inbound-claim.ts
 * needs it without importing the whole ingest path.
 */
export function isMissingColumnError(error: unknown): boolean {
  if (!error) return false;
  const e = error as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  return (
    code === 'PGRST204' ||
    code === '42703' ||
    msg.includes('could not find the') ||
    msg.includes('schema cache') ||
    (msg.includes('column') && msg.includes('does not exist'))
  );
}

/**
 * How far past the reply's scheduled time the send window must stay open for a
 * note to be worth sending — room for dispatch lag before a 9pm close.
 */
export const HOLDING_WINDOW_MARGIN_MS = 5 * 60_000;

/**
 * A note sent longer ago than this, still unanswered, is history rather than an
 * open promise: whatever happened next was a human's call, and pulling a brand
 * new reply forward to "keep" it would just make that reply instant.
 */
export const HOLDING_PROMISE_STALE_MS = 60 * 60_000;

export function isHeldReplyType(messageType: string | null | undefined): messageType is HeldReplyType {
  return (HELD_REPLY_MESSAGE_TYPES as readonly string[]).includes(messageType ?? '');
}

/**
 * Does this outbound reply get a holding note in front of it? Email only, and
 * only on the auto-email path; counters and acceptances only.
 */
export function holdingNoteEligible(input: {
  messageType: string | null | undefined;
  channel: string | null | undefined;
  sendMode: string | null | undefined;
}): boolean {
  if (!isHeldReplyType(input.messageType)) return false;
  if (input.channel !== 'email') return false;
  if (input.sendMode === 'human_queue') return false;
  return true;
}

// ── Copy ────────────────────────────────────────────────────────────────────

const M = HOLDING_PROMISE_MINUTES;

// Variant one had its em dash swapped for a comma: em dashes are the most
// common AI tell and are banned from every outbound body.
const COUNTER_VARIANTS: readonly string[] = [
  `Thanks, let me check on my end and get back to you in the next ${M} minutes.`,
  `Got it, thanks. Let me look at this on my side and I'll get back to you within ${M} minutes.`,
  `Thanks for getting back to me. Give me a few minutes to check a couple of things and I'll reply in the next ${M} minutes.`,
  `Appreciate it. Let me run this past the team and I'll be back to you within ${M} minutes.`,
];

const ACCEPTANCE_VARIANTS: readonly string[] = [
  `Thanks, let me check on my end and get back to you in the next ${M} minutes.`,
  `Great, thanks. Let me get things lined up on my side and I'll confirm everything within ${M} minutes.`,
  `Perfect, thanks. Give me a few minutes to sort out the details here and I'll get back to you in the next ${M} minutes.`,
];

/** The variant set for a reply kind (exported so tests can pin every line). */
export function holdingNoteVariants(kind: HeldReplyType): readonly string[] {
  return kind === 'agreement_confirmation' ? ACCEPTANCE_VARIANTS : COUNTER_VARIANTS;
}

/**
 * The note body: one variant picked by `rand`, then the signoff on its own
 * line — the same resolveSignoff() chain initial outreach and closure notices
 * sign with. `signoff` null leaves the note unsigned (the From header still
 * carries the sender's name).
 */
export function holdingNoteBody(
  kind: HeldReplyType,
  rand: () => number,
  signoff: string | null,
): string {
  const variants = holdingNoteVariants(kind);
  const r = Math.min(0.999999999, Math.max(0, rand()));
  const line = variants[Math.floor(r * variants.length)];
  const sign = signoff?.trim();
  return sign ? `${line}\n\n${sign}` : line;
}

// ── Promise state for a thread ──────────────────────────────────────────────

export interface ThreadMessage {
  message_type: string | null;
  direction: string | null;
  status: string | null;
  sent_at: string | null;
  /** When a queued row is due. Read so a reply can be kept behind a queued note. */
  send_after?: string | null;
}

export type HoldingPromise =
  | { state: 'none' }
  /**
   * A note is queued and has not gone yet. `noteAtMs` is its send_after (the
   * latest, if a pre-057 race queued two); absent when unparseable.
   */
  | { state: 'pending'; noteAtMs?: number }
  /** A note went at `sentAtMs` and no counter/acceptance has been sent since. */
  | { state: 'open'; sentAtMs: number };

/** What this thread's outbound history says about holding-note promises. */
export function holdingPromiseState(rows: ThreadMessage[], nowMs: number): HoldingPromise {
  const outbound = rows.filter((r) => r.direction === 'outbound' || r.direction == null);
  const queuedNotes = outbound.filter(
    (r) => r.message_type === HOLDING_NOTE_MESSAGE_TYPE && r.status === 'queued',
  );
  if (queuedNotes.length > 0) {
    let noteAtMs = -Infinity;
    for (const r of queuedNotes) {
      const t = r.send_after ? Date.parse(r.send_after) : Number.NaN;
      if (Number.isFinite(t) && t > noteAtMs) noteAtMs = t;
    }
    return Number.isFinite(noteAtMs) ? { state: 'pending', noteAtMs } : { state: 'pending' };
  }
  let lastNoteMs = -Infinity;
  for (const r of outbound) {
    if (r.message_type !== HOLDING_NOTE_MESSAGE_TYPE || r.status !== 'sent' || !r.sent_at) continue;
    const t = Date.parse(r.sent_at);
    if (Number.isFinite(t) && t > lastNoteMs) lastNoteMs = t;
  }
  if (!Number.isFinite(lastNoteMs)) return { state: 'none' };
  if (nowMs - lastNoteMs > HOLDING_PROMISE_STALE_MS) return { state: 'none' };
  const answered = outbound.some((r) => {
    if (!isHeldReplyType(r.message_type) || r.status !== 'sent' || !r.sent_at) return false;
    const t = Date.parse(r.sent_at);
    return Number.isFinite(t) && t >= lastNoteMs;
  });
  return answered ? { state: 'none' } : { state: 'open', sentAtMs: lastNoteMs };
}

// ── Scheduling ──────────────────────────────────────────────────────────────

export interface ReplyPlan {
  /** When the holding note goes, or null for no note. */
  holdingAtMs: number | null;
  /** When the real reply goes. */
  replyAtMs: number;
}

/**
 * When the holding note (if any) and the real reply go.
 *
 * Every band is measured from `anchorMs`, the moment the creator's reply
 * ARRIVED (inbound_messages.received_at), because that is the latency the
 * creator experiences. Any time a band has already elapsed by `nowMs`, the
 * message goes at the earliest legal moment instead: now + CATCH_UP_JITTER_BAND.
 * The note always leads the reply by at least HOLDING_MIN_GAP_MS.
 *
 *   ineligible          → no note; the reply keeps its own kind band.
 *   no promise          → note in CADENCE_BANDS.holding_note, reply in
 *                         HELD_REPLY_BAND — when both are inside the send
 *                         window; else no note and the reply's own band.
 *   pending (queued)    → no second note; reply in HELD_REPLY_BAND so the
 *                         queued note, when it goes, has a reply behind it —
 *                         and never earlier than HOLDING_MIN_GAP_MS after
 *                         that note's own send_after, never later than its
 *                         promise.
 *   open (note sent)    → no second note; reply pulled inside the promise,
 *                         never earlier than HOLDING_MIN_GAP_MS after it.
 *
 * `anchorMs` in the future (clock skew) or unparseable is treated as `nowMs`:
 * never schedule off a time we cannot trust.
 */
export function planReplySchedule(input: {
  nowMs: number;
  /** When the creator's reply arrived; defaults to nowMs. */
  anchorMs?: number;
  rand: () => number;
  messageType: string;
  eligible: boolean;
  promise: HoldingPromise;
  inWindow?: (ms: number) => boolean;
}): ReplyPlan {
  const { nowMs, rand, messageType, eligible, promise } = input;
  const inWindow = input.inWindow ?? ((ms: number) => inSendWindow(ms));
  const raw = input.anchorMs ?? nowMs;
  const anchorMs = Number.isFinite(raw) ? Math.min(raw, nowMs) : nowMs;

  // The earliest legal moment, drawn once so every message in this plan
  // shares one floor and the note/reply order cannot be inverted by the jitter.
  let floorMs: number | undefined;
  const floor = () => (floorMs ??= nowMs + delaySecondsInBand(CATCH_UP_JITTER_BAND, rand) * 1000);
  const fromArrival = (band: CadenceBand) =>
    Math.max(anchorMs + delaySecondsInBand(band, rand) * 1000, floor());
  const ownBand = () => fromArrival(CADENCE_BANDS[cadenceKindFor(messageType)]);
  const heldBand = () => fromArrival(HELD_REPLY_BAND);

  if (!eligible) return { holdingAtMs: null, replyAtMs: ownBand() };

  if (promise.state === 'open') {
    const deadline = Math.max(floor(), promise.sentAtMs + HOLDING_REPLY_DEADLINE_MS);
    return {
      holdingAtMs: null,
      replyAtMs: Math.max(promise.sentAtMs + HOLDING_MIN_GAP_MS, Math.min(heldBand(), deadline)),
    };
  }
  if (promise.state === 'pending') {
    const noteAt = promise.noteAtMs;
    if (noteAt == null || !Number.isFinite(noteAt)) return { holdingAtMs: null, replyAtMs: heldBand() };
    // Behind the queued note by the minimum gap, inside the promise it makes.
    return {
      holdingAtMs: null,
      replyAtMs: Math.max(
        floor(),
        noteAt + HOLDING_MIN_GAP_MS,
        Math.min(heldBand(), noteAt + HOLDING_REPLY_DEADLINE_MS),
      ),
    };
  }

  const holdingAtMs = fromArrival(CADENCE_BANDS.holding_note);
  const replyAtMs = Math.max(heldBand(), holdingAtMs + HOLDING_MIN_GAP_MS);
  if (inWindow(holdingAtMs) && inWindow(replyAtMs + HOLDING_WINDOW_MARGIN_MS)) {
    return { holdingAtMs, replyAtMs };
  }
  return { holdingAtMs: null, replyAtMs: ownBand() };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/** The queued-outbound columns the verdict reads (dispatchDue already loads them). */
export interface QueuedOutboundLite {
  id: string;
  campaign_influencer_id: string | null;
  message_type: string | null;
  channel: string | null;
  send_mode: string | null;
  send_after: string | null;
}

export type HoldingVerdict =
  | { send: true; reply_id: string }
  | {
      send: false;
      reason: 'outside_send_window' | 'no_reply_inside_promise' | 'reply_due_first';
    };

/**
 * May this due holding note leave now? Only while the send window is open (a
 * note is never deferred to the morning) and a real reply for the same thread
 * is still queued on the auto-email path, due between HOLDING_MIN_LEAD_MS and
 * HOLDING_REPLY_DEADLINE_MS from now, inside the window itself — and no other
 * real reply on the thread is due before it (the note would land after an
 * answer: counter -> note -> counter).
 */
export function holdingNoteVerdict(input: {
  nowMs: number;
  holding: QueuedOutboundLite;
  queued: QueuedOutboundLite[];
  inWindow?: (ms: number) => boolean;
  /**
   * May the reply actually leave at `ms` under the CAMPAIGN window
   * (src/lib/campaign-window.ts)? A reply the window would close or push out
   * keeps no promise, so the note is dropped rather than left unkept.
   * Default: no campaign window (ungated).
   */
  replyAllowedAt?: (ms: number) => boolean;
}): HoldingVerdict {
  const { nowMs, holding, queued } = input;
  const inWindow = input.inWindow ?? ((ms: number) => inSendWindow(ms));
  const replyAllowedAt = input.replyAllowedAt ?? (() => true);
  if (!inWindow(nowMs)) return { send: false, reason: 'outside_send_window' };
  const dueFirst = queued.some((r) => {
    if (r.id === holding.id || r.message_type === HOLDING_NOTE_MESSAGE_TYPE) return false;
    if (!holding.campaign_influencer_id || r.campaign_influencer_id !== holding.campaign_influencer_id) {
      return false;
    }
    if (r.channel !== 'email' || r.send_mode === 'human_queue' || !r.send_after) return false;
    const at = Date.parse(r.send_after);
    return Number.isFinite(at) && at < nowMs + HOLDING_MIN_LEAD_MS;
  });
  if (dueFirst) return { send: false, reason: 'reply_due_first' };
  const reply = queued.find((r) => {
    if (r.id === holding.id) return false;
    if (!holding.campaign_influencer_id || r.campaign_influencer_id !== holding.campaign_influencer_id) {
      return false;
    }
    if (!isHeldReplyType(r.message_type)) return false;
    if (r.channel !== 'email' || r.send_mode === 'human_queue') return false;
    if (!r.send_after) return false;
    const at = Date.parse(r.send_after);
    if (!Number.isFinite(at)) return false;
    if (at < nowMs + HOLDING_MIN_LEAD_MS) return false;
    if (at > nowMs + HOLDING_REPLY_DEADLINE_MS) return false;
    return inWindow(at) && replyAllowedAt(at);
  });
  return reply ? { send: true, reply_id: reply.id } : { send: false, reason: 'no_reply_inside_promise' };
}
