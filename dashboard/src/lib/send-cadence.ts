// src/lib/send-cadence.ts
//
// How long Creator Campaigns waits before answering a creator.
//
// WHY THIS IS NOT ONE NUMBER
//   The previous model was a single uniform 20–120s applied to every outbound
//   reply, and it had three problems worth naming because each one is a
//   different kind of mistake.
//
//   1. IT WAS INVISIBLE. `send_after` is only honoured by the dispatch pass,
//      and that pass rides the negotiation tick at */5. A 20–120s delay inside
//      a 300s tick is fully swallowed: the observed latency was 0–5 minutes
//      regardless of the jitter, and — worse — every reply computed in one tick
//      went out in the same batch seconds apart, at :00, :05, :10. Forty
//      replies arriving on the same five-minute beat is a stronger machine tell
//      than answering instantly would have been. The jitter was decorative.
//      Fixed by giving dispatch its own minute-cadence entrypoint, so the
//      per-message schedule is what actually decides when a message leaves.
//
//   2. A COUNTER AND AN ACCEPTANCE ARE NOT THE SAME ACT. Saying "yes, deal" in
//      ninety seconds is natural and good — the creator just committed, and
//      momentum is worth money. Answering a price negotiation in ninety
//      seconds, forty times, is not: a person weighing what to pay takes
//      minutes. Same jitter for both was the wrong shape, not the wrong range.
//
//   3. UNIFORM IS NOT HUMAN. Real reply latency is right-skewed — usually
//      quick, occasionally much slower. A flat distribution across a narrow
//      band is its own signature. These draw `min + span * rand²`, which puts
//      the mode near the fast end and keeps a tail.
//
// THE BANDS ARE FIXED PRODUCT VALUES
//   A counter goes 300–480s after the creator's reply arrives, a clarification
//   120–240s. The previous counter band (240–1080s) had a tail past seventeen
//   minutes, which is incompatible with the holding note below. These are
//   specified values, not tuned ones — change them deliberately, together with
//   the holding note's promise.
//
// THE HOLDING NOTE
//   Before an automated EMAIL counter or acceptance, a short human "let me check
//   on my end, back to you in the next 15 minutes" note goes first:
//     holding note   60–180s after arrival  (CADENCE_BANDS.holding_note)
//     the real reply 300–480s after arrival  (HELD_REPLY_BAND)
//   so the reply always follows the note and always lands well inside the
//   promised HOLDING_PROMISE_MINUTES. The decision of WHETHER to send one, and
//   the copy, live in src/lib/holding-note.ts; this module only owns timing.
//
// ANCHORED ON ARRIVAL, NOT PICKUP
//   These minutes are what the creator experiences, so the negotiation paths
//   measure them from inbound_messages.received_at. The tick runs every five
//   minutes, so a band can already have elapsed when the reply is picked up;
//   then the message goes at now + CATCH_UP_JITTER_BAND, note still first.
//   `sendAfterMsFor(nowMs, …)` below stays a pickup-anchored helper for callers
//   with no arrival time.
//
// WHAT THIS MODULE DOES NOT DECIDE
//   Whether it is legal or polite to send at all. Quiet hours
//   (src/lib/quiet-hours.ts, 9am–9pm local) and the campaign window
//   (src/lib/campaign-window.ts) are applied at dispatch, downstream of this.
//   A schedule computed here can still be deferred or closed by those.
//
// THE OPEN QUESTION, STATED HONESTLY
//   Human-feel and conversion may pull in opposite directions. Every minute of
//   delay is a minute the creator can lose interest, so it is entirely possible
//   that faster converts better and the right amount of human-feel is the
//   minimum that avoids looking automated. This is measurable rather than
//   arguable: the real latency of every reply is already derivable from
//   inbound_messages.received_at → outreach_messages.sent_at, so the CPM
//   learning loop can score it once enough rounds exist. Until then these are
//   defensible defaults, not findings. Do not defend them as findings.

/** Outbound reply kinds this module schedules. Keys match outreach_messages.message_type. */
export type CadenceKind =
  | 'agreement_confirmation'
  | 'counter'
  | 'clarification'
  | 'holding_note'
  | 'other';

export interface CadenceBand {
  minSec: number;
  maxSec: number;
  /** Why this band, in one line — surfaced in the operator timeline. */
  rationale: string;
}

/**
 * Bands per reply kind.
 *
 * `agreement_confirmation` carries the specified range (60–180s). It is
 * the right band for exactly this message: the creator has already said yes,
 * so a prompt reply reads as an organised counterparty rather than a bot, and
 * any delay here is pure downside. It applies when NO holding note precedes
 * the acceptance (a DM, or a reply that would straddle quiet hours); when one
 * does, the acceptance moves to HELD_REPLY_BAND instead.
 *
 * `counter` and `clarification` are specified bands.
 * `holding_note` is the brief "let me check" note that precedes an emailed
 * counter or acceptance.
 */
export const CADENCE_BANDS: Record<CadenceKind, CadenceBand> = {
  agreement_confirmation: {
    minSec: 60,
    maxSec: 180,
    rationale: 'they just said yes — answer promptly, confirming while it is still front of mind',
  },
  counter: {
    minSec: 300,
    maxSec: 480,
    rationale:
      "specified band: a person weighing money takes minutes, and it must land inside the holding note's 15-minute promise",
  },
  clarification: {
    minSec: 120,
    maxSec: 240,
    rationale:
      "specified band: answering a question takes a moment to read and a moment to write",
  },
  holding_note: {
    minSec: 60,
    maxSec: 180,
    rationale:
      "specified band: the quick 'let me check, back to you in 15' that a person sends before the real reply",
  },
  other: {
    minSec: 60,
    maxSec: 300,
    rationale: 'unrecognised reply kind — a middling band that is neither instant nor slow',
  },
};

/**
 * The band for the REAL reply (counter or acceptance) when a holding note has
 * gone ahead of it — the specified 300–480s. Always starts
 * after the holding note's band ends, so the order can never invert.
 */
export const HELD_REPLY_BAND: CadenceBand = {
  minSec: 300,
  maxSec: 480,
  rationale:
    "specified band: the real reply follows its holding note, well inside the promised 15 minutes",
};

/**
 * Bands run from the creator's reply ARRIVING (inbound_messages.received_at),
 * because that is the latency the creator experiences. When pickup is late
 * enough that a band has already elapsed, the message goes at the earliest
 * legal moment instead: now + this jitter, so a backlog drained in one tick
 * still does not leave in lockstep.
 */
export const CATCH_UP_JITTER_BAND: CadenceBand = {
  minSec: 15,
  maxSec: 60,
  rationale: 'the band already elapsed before pickup — go now, but not in the same second as the rest of the batch',
};

/** The minutes the holding note's copy promises. The bands above must fit inside it. */
export const HOLDING_PROMISE_MINUTES = 15;

/** Map an outreach_messages.message_type to a cadence kind. Unknown → 'other'. */
export function cadenceKindFor(messageType: string | null | undefined): CadenceKind {
  if (messageType === 'agreement_confirmation') return 'agreement_confirmation';
  if (messageType === 'counter') return 'counter';
  if (messageType === 'clarification') return 'clarification';
  if (messageType === 'holding_note') return 'holding_note';
  return 'other';
}

/**
 * Seconds to wait, drawn from `band`.
 *
 * Right-skewed by squaring the uniform draw: the mode sits near `minSec` and
 * the tail reaches `maxSec`. Deterministic given `rand`, so tests need no clock
 * and no randomness.
 */
export function delaySecondsInBand(band: CadenceBand, rand: () => number): number {
  const span = band.maxSec - band.minSec;
  // `span + 1` makes the integer range inclusive of maxSec for a [0,1) draw.
  // Clamped because `rand` is injectable: Math.random() never returns 1, but a
  // test seam or a different rng can, and that would schedule maxSec + 1 — one
  // second outside a band the whole module exists to guarantee.
  const skewed = Math.min(0.999999999, Math.max(0, rand())) ** 2;
  const delay = band.minSec + Math.floor(skewed * (span + 1));
  return Math.min(band.maxSec, delay);
}

/** Seconds to wait before sending a reply of this kind. */
export function delaySecondsFor(kind: CadenceKind, rand: () => number): number {
  return delaySecondsInBand(CADENCE_BANDS[kind], rand);
}

/** Absolute send time as ms-epoch for a reply of this kind computed at `nowMs`. */
export function sendAfterMsFor(nowMs: number, kind: CadenceKind, rand: () => number): number {
  return nowMs + delaySecondsFor(kind, rand) * 1000;
}
