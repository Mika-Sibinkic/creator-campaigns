// src/lib/campaign-window.ts
//
// release_date drives a real campaign window.
//
// The default campaign runs four weeks before the release and two weeks after
// it. Until now `release_date`
// only picked a verb tense (outreach.ts) and fed a stale_draft reason — there
// was no campaign start, no campaign end, and nothing scheduled against the
// release at all.
//
// This module is the single definition of that window. It is PURE: given a
// release date, the firm's offsets and a clock, it answers "may we send now",
// "may we still measure", and "where does a deferred send land". No DB, no
// Date.now() at module scope — hermetic tests need no clock.
//
// ── The two properties that matter ──────────────────────────────────────────
//
// 1. A NULL release_date means NO WINDOW, and no window means no gate. Every
//    campaign that exists today has whatever release_date it already had, and
//    most demo rows have none. Gating those to death on the day this ships
//    would be a silent regression dressed as a feature, so `deriveWindow`
//    returns null and every caller treats null as "allowed, as before".
//
// 2. The window must not fight the two schedulers that already exist:
//
//      * migration 019's `send_after` — the tick's due-scan,
//      * the quiet-hours governor (quiet-hours.ts) — which DEFERS a due send
//        by pushing `send_after` to the next 9am-9pm opening.
//
//    Those compose in a dangerous direction. Quiet hours can push a send
//    FORWARD, so a counter that came due at 21:05 on the last night of the
//    window gets rescheduled to ~09:00 the next morning — outside it. Left
//    alone the window would be advisory: every send it "blocked" would simply
//    arrive late. `clampDeferral()` below is the fix, and it is why this
//    module exposes a deferral decision rather than a bare boolean.
//
//    (The send window is 9am-9pm with 9pm EXCLUSIVE, so 20:58 is still inside
//    it and sends immediately. The clamp starts biting at 21:00. An earlier
//    version of this comment used 20:58 as the example, which described a
//    case that never happens.)
//
// ── Why the end is soft for a live thread ───────────────────────────────────
//
// A hard stop at window_end strands whatever is mid-conversation: a creator
// answers on the last afternoon, the negotiator queues a counter, the window
// closes, and the counter sits `queued` forever with a human on the other end
// waiting for a reply that the scheduler will never send. That is a worse
// failure than a late message, and it is the exact "a window must not strand a
// queued counter forever" hazard.
//
// So the end is enforced in two tiers:
//
//    window_end                     → no NEW thread may be opened. Hard.
//    window_end + IN_THREAD_GRACE   → an already-open thread may still be
//                                     answered, so live negotiations land.
//    past the grace                 → the message is CLOSED OUT explicitly
//                                     (a terminal status + a reason), never
//                                     left queued. Nothing is stranded; it is
//                                     visibly, inspectably finished.

// ── Grandfathering: the window must never apply retroactively ───────────────
//
// The first version of this module got this wrong in a way that would have
// broken running campaigns within five minutes of deploy, and the lesson is
// worth more than the fix.
//
// The safety argument was "a campaign with no release_date has no window, so
// this cannot retro-gate live work." That is true of the NULL case and ONLY
// the NULL case. Take a campaign with release_date = 2026-07-04 on a firm with
// no window keys: the 28/14 defaults derive a window that closed on
// 2026-07-18, and the campaign may still be holding an `offered` or a
// `human_approval_required` offer.
//
// The failure: a creator on that open offer replies, processInbound
// auto-negotiates and queues a counter, and within five minutes dispatchDue
// evaluates the counter against a deadline that expired in July and closes it.
// The creator who just replied is ghosted permanently, with no retry path —
// and before this feature existed, that counter simply went out.
//
// A campaign that ran its entire life without a window must never be
// retroactively subjected to one. Two conditions, both on `campaigns
// .created_at`, which already exists (no migration):
//
//   1. created before WINDOW_ENFORCEMENT_EPOCH → ungated, forever. The feature
//      did not exist when the campaign was planned, so the label never agreed
//      to a window and never had the chance to set one.
//
//   2. created AFTER its own window_end → ungated. This is the back-dated
//      catalog campaign: a label sets up a push today for a release from last
//      year. Its window is over before the campaign exists, so enforcing it
//      would mean the campaign could never send anything at all.
//
// Why this over the alternatives:
//
//   * Per-firm opt-in: labels are told this feature exists, and there is
//     no UI to flip the flag, so nobody would actually get it. It also
//     does not help a firm that opts in while holding old campaigns — the
//     same retro-gating lands the moment they do.
//   * "Treat an already-closed window as absent" (unconditionally): needs
//     persisted first-evaluation state to be deterministic, and it would
//     permanently disable the window for exactly the expired campaigns you
//     DO want gated going forward.
//
// Grandfathering by created_at is deterministic, needs no new state, and
// encodes the actual principle rather than approximating it.

/**
 * Campaigns created before this instant are never window-gated.
 * 2026-09-18 — the day the campaign window shipped.
 */
export const WINDOW_ENFORCEMENT_EPOCH = '2026-09-18T00:00:00.000Z';
export const WINDOW_ENFORCEMENT_EPOCH_MS = Date.parse(WINDOW_ENFORCEMENT_EPOCH);

/** 4 weeks before the release — the default. */
export const DEFAULT_WINDOW_LEAD_DAYS = 28;
/** 2 weeks after the release — the default. */
export const DEFAULT_WINDOW_TAIL_DAYS = 14;

/**
 * How long past window_end an ALREADY-OPEN thread may still be answered.
 * Covers a creator who replies in the last hours of the window; past it a
 * queued message is closed out rather than left hanging.
 */
export const IN_THREAD_GRACE_DAYS = 7;

/**
 * How long past window_end measurement keeps running. Measurement is the
 * point of the campaign and the data arrives AFTER the post: content posted on
 * the final day still needs its performance snapshots. Gating measurement
 * exactly at window_end would throw away the reach numbers the CPM model is
 * built on. Past this the campaign is done and we stop paying Apify for it.
 */
export const MEASUREMENT_TAIL_DAYS = 30;

/** Offsets are clamped to something a human could plausibly mean. */
export const MAX_OFFSET_DAYS = 365;

const DAY_MS = 86_400_000;

export interface WindowOffsets {
  lead_days: number;
  tail_days: number;
}

export interface CampaignWindow {
  /** Inclusive start, ms-epoch. */
  start_ms: number;
  /** Inclusive end, ms-epoch. */
  end_ms: number;
  start_iso: string;
  end_iso: string;
  /** The release itself, ms-epoch — the anchor both offsets are measured from. */
  release_ms: number;
  lead_days: number;
  tail_days: number;
}

export type WindowPhase =
  /** No release_date → no window → nothing is gated. */
  | 'no_window'
  /** Before window_start — too early; a send waits rather than being refused. */
  | 'before'
  /** Inside [start, end] — normal operation. */
  | 'open'
  /** Past window_end but inside the in-thread grace. */
  | 'grace'
  /** Past window_end + grace — finished. */
  | 'closed';

/**
 * Parse one offset out of firm prefs. Accepts 0 (a firm may legitimately want
 * "start exactly on release day"), rejects negatives and nonsense, and clamps
 * absurd values rather than letting a typo produce a decade-long campaign.
 */
function offsetDays(raw: unknown, fallback: number): number {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), MAX_OFFSET_DAYS);
}

/**
 * Firm-configurable window offsets, read from `firms.outreach_prefs` — the
 * same JSONB bag that already carries voice, signoff, follow_up_cadence_days
 * and max_follow_ups (migration 009). Deliberately NOT new columns: the
 * offsets are firm preferences, they live where every other firm preference
 * lives, and adding them needs no migration on `firms` at all.
 */
export function windowOffsets(outreachPrefs: unknown): WindowOffsets {
  const p =
    outreachPrefs && typeof outreachPrefs === 'object'
      ? (outreachPrefs as Record<string, unknown>)
      : {};
  return {
    lead_days: offsetDays(p.campaign_window_lead_days, DEFAULT_WINDOW_LEAD_DAYS),
    tail_days: offsetDays(p.campaign_window_tail_days, DEFAULT_WINDOW_TAIL_DAYS),
  };
}

/**
 * Parse `campaigns.release_date`. The column is a DATE, so PostgREST hands
 * back 'YYYY-MM-DD' with no time and no zone. Anchor it at UTC midnight:
 * appending a time would invent precision the column does not have, and
 * `new Date('2026-06-01')` already means UTC midnight by spec. Full ISO
 * timestamps are accepted too, so a caller passing a timestamptz still works.
 */
export function parseReleaseMs(releaseDate: string | null | undefined): number | null {
  if (!releaseDate) return null;
  const ms = Date.parse(
    /^\d{4}-\d{2}-\d{2}$/.test(releaseDate) ? `${releaseDate}T00:00:00.000Z` : releaseDate,
  );
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The campaign window, or null when the campaign has no release date.
 *
 * NULL IS THE IMPORTANT RETURN. It means "this campaign is ungated", which is
 * exactly how every campaign behaves today, so shipping this cannot retro-gate
 * existing work.
 */
export function deriveWindow(
  releaseDate: string | null | undefined,
  offsets: WindowOffsets,
): CampaignWindow | null {
  const release_ms = parseReleaseMs(releaseDate);
  if (release_ms === null) return null;

  const lead_days = Math.max(0, Math.floor(offsets.lead_days));
  const tail_days = Math.max(0, Math.floor(offsets.tail_days));
  const start_ms = release_ms - lead_days * DAY_MS;
  // End-of-day on the final day: a window that "runs to 2 weeks after release"
  // means through that day, not up to its opening midnight.
  const end_ms = release_ms + tail_days * DAY_MS + (DAY_MS - 1);

  return {
    start_ms,
    end_ms,
    start_iso: new Date(start_ms).toISOString(),
    end_iso: new Date(end_ms).toISOString(),
    release_ms,
    lead_days,
    tail_days,
  };
}

export type WindowExemption =
  | 'none'
  | 'no_release_date'
  | 'created_before_feature'
  | 'created_after_window_end'
  | 'unknown_created_at';

export interface ResolvedWindow {
  window: CampaignWindow | null;
  /** Why the window is absent, when it is. 'none' means it IS enforced. */
  exemption: WindowExemption;
}

/**
 * THE entry point. Every caller that gates behaviour on the window must use
 * this rather than deriveWindow(), because deriveWindow() knows nothing about
 * grandfathering and will happily hand back a window that closed in July for a
 * campaign that has been running since June.
 *
 * Returns `window: null` for every exempt case, which every gate already reads
 * as "ungated" — the behaviour that shipped before this feature existed.
 */
export function resolveCampaignWindow(args: {
  releaseDate: string | null | undefined;
  createdAt: string | null | undefined;
  offsets: WindowOffsets;
  /** Injectable for tests; defaults to the shipped epoch. */
  epochMs?: number;
}): ResolvedWindow {
  const w = deriveWindow(args.releaseDate, args.offsets);
  if (!w) return { window: null, exemption: 'no_release_date' };

  const createdMs = args.createdAt ? Date.parse(args.createdAt) : NaN;
  // An unreadable created_at means we cannot prove the campaign is in scope.
  // Fail OPEN (ungated) rather than closed: the cost of wrongly gating is a
  // ghosted creator mid-negotiation, the cost of wrongly not gating is a late
  // message. Those are not symmetric.
  if (!Number.isFinite(createdMs)) {
    return { window: null, exemption: 'unknown_created_at' };
  }

  const epoch = args.epochMs ?? WINDOW_ENFORCEMENT_EPOCH_MS;
  if (createdMs < epoch) {
    return { window: null, exemption: 'created_before_feature' };
  }

  if (createdMs > w.end_ms) {
    return { window: null, exemption: 'created_after_window_end' };
  }

  return { window: w, exemption: 'none' };
}

/** Where `nowMs` sits relative to the window. */
export function windowPhaseAt(
  w: CampaignWindow | null,
  nowMs: number,
  graceDays: number = IN_THREAD_GRACE_DAYS,
): WindowPhase {
  if (!w) return 'no_window';
  if (nowMs < w.start_ms) return 'before';
  if (nowMs <= w.end_ms) return 'open';
  if (nowMs <= w.end_ms + Math.max(0, graceDays) * DAY_MS) return 'grace';
  return 'closed';
}

/**
 * May a NEW thread be opened right now? This is the hard gate — first touches
 * and channel escalations both go through it. No window → always yes.
 */
export function canOpenThreadAt(w: CampaignWindow | null, nowMs: number): boolean {
  const phase = windowPhaseAt(w, nowMs);
  // 'no_window' must pass. A campaign with no release_date is UNGATED, which is
  // how every campaign behaves today — treating it as "not open" would silently
  // stop outreach on every untimed campaign the moment this shipped.
  return phase === 'no_window' || phase === 'open';
}

/**
 * May an ALREADY-OPEN thread be answered right now? Softer than
 * `canOpenThreadAt` by exactly the in-thread grace, so a live negotiation
 * started inside the window can finish.
 */
export function canContinueThreadAt(
  w: CampaignWindow | null,
  nowMs: number,
  graceDays: number = IN_THREAD_GRACE_DAYS,
): boolean {
  const phase = windowPhaseAt(w, nowMs, graceDays);
  return phase === 'no_window' || phase === 'open' || phase === 'grace';
}

/**
 * May the measurement tick still spend scraper credit on this campaign?
 * Runs from window_start through window_end + MEASUREMENT_TAIL_DAYS.
 */
export function measurementAllowedAt(
  w: CampaignWindow | null,
  nowMs: number,
  tailDays: number = MEASUREMENT_TAIL_DAYS,
): boolean {
  if (!w) return true;
  // Gates the CLOSED side only. An earlier version also returned false before
  // window_start, which contradicted the name and every comment around it: a
  // back-dated catalog campaign would have been excluded from measurement the
  // instant it was created. There is nothing to protect on the early side —
  // a campaign with no posts yet has no deliveries to scrape, so the loop
  // finds nothing and costs nothing.
  return nowMs <= w.end_ms + Math.max(0, tailDays) * DAY_MS;
}

export type DeferralDecision =
  /** Reschedule to `at_ms` and leave the row queued. */
  | { action: 'reschedule'; at_ms: number; reason: string }
  /** Send now — the proposed time is inside the window. */
  | { action: 'send_now'; reason: string }
  /** Stop: the row can never be sent inside the window. Close it out. */
  | { action: 'close'; reason: string };

/**
 * THE QUIET-HOURS CLAMP — the reason this module exists rather than a boolean.
 *
 * The caller has a message due at `nowMs` and a quiet-hours-corrected time
 * `deferredToMs` (what nextSendWindowMs() proposed). This decides what may
 * actually happen, so a deferral can never smuggle a send past the window:
 *
 *   before the window   → reschedule to the later of window_start and the
 *                         quiet-hours opening. Nothing is lost, it just waits.
 *   inside, no deferral → send now.
 *   inside, but the quiet-hours opening lands past the deadline → CLOSE. This
 *                         is the case the whole issue turns on: the send was
 *                         legal when it came due and illegal by the time quiet
 *                         hours would have released it, so it must not go.
 *   past the deadline    → close.
 *
 * `deadline_ms` is window_end for a new thread, or window_end + grace for a
 * continuation — the caller picks which contract it is under.
 */
export function clampDeferral(args: {
  window: CampaignWindow | null;
  nowMs: number;
  deferredToMs: number;
  deadlineMs?: number;
}): DeferralDecision {
  const { window: w, nowMs, deferredToMs } = args;

  // No window → the window imposes nothing; quiet hours still applies.
  if (!w) {
    return deferredToMs > nowMs
      ? { action: 'reschedule', at_ms: deferredToMs, reason: 'quiet_hours' }
      : { action: 'send_now', reason: 'no_window' };
  }

  const deadline = args.deadlineMs ?? w.end_ms;

  if (nowMs > deadline) {
    return { action: 'close', reason: 'window_closed' };
  }

  if (nowMs < w.start_ms) {
    // Too early. Wait for the window, and for quiet hours within it.
    const at = Math.max(w.start_ms, deferredToMs);
    return at > deadline
      ? { action: 'close', reason: 'window_shorter_than_quiet_hours' }
      : { action: 'reschedule', at_ms: at, reason: 'before_window_start' };
  }

  // Inside the window as of now.
  if (deferredToMs <= nowMs) return { action: 'send_now', reason: 'in_window' };

  // Quiet hours wants to push it. Only allowed if it still lands in time.
  return deferredToMs > deadline
    ? { action: 'close', reason: 'quiet_hours_would_exit_window' }
    : { action: 'reschedule', at_ms: deferredToMs, reason: 'quiet_hours' };
}

/** Label-readable window summary for the campaign page. */
export function describeWindow(w: CampaignWindow | null): string {
  if (!w) return 'No release date set, so outreach is not time-boxed.';
  const d = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return `${d(w.start_ms)} → ${d(w.end_ms)} (${w.lead_days}d before release, ${w.tail_days}d after)`;
}

export const WINDOW_PHASE_LABELS: Record<WindowPhase, string> = {
  no_window: 'Not time-boxed',
  before: 'Starts soon',
  open: 'In window',
  grace: 'Closing: replies only',
  closed: 'Window closed',
};

/** Days until the window opens / after it closed — for the UI countdown. */
export function daysUntil(targetMs: number, nowMs: number): number {
  return Math.ceil((targetMs - nowMs) / DAY_MS);
}
