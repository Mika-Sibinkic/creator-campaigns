// src/lib/outreach-send-copy.ts
//
// Honest operator-facing copy + outcome accounting for the outreach send path.
// Pure and dependency-free so /outreach can stay a thin consumer and the copy
// itself is unit-testable (tests/outreach-send.test.ts).
//
// Two things this exists to stop happening again:
//
//   1. The bulk-send dialogs hardcoded "in testing mode … sent to your test
//      inbox" and never read firms.testing_mode. With testing mode off, that
//      told the operator their real creator emails were going to a test inbox.
//      Mode now comes in as a value, and there is no way to render the testing
//      copy without passing mode: 'testing'.
//   2. The bulk loops counted HTTP 409 as "sent". 409 also means dm_queue
//      (routed to a human) and stale_draft (blocked, needs regeneration).
//      classifySendResponse splits them; summarizeSendTally reports each one.
//   3. The bulk loops fired batches of 3 with no delay between them, while
//      /api/outreach/[id]/send sits on the 'expensive' rate tier — 5 requests
//      per minute. "Send All Drafts (20)" therefore put 5 on the wire and
//      collected fifteen 429s, every one of which was tallied as `failed`.
//      A rate limit is not an outage. planSendSchedule paces the loop to the
//      real limit so the 429s do not happen, describeSendPace states the time
//      cost before the operator commits, and the 'rate_limited' outcome
//      reports any throttle that still gets through as a throttle.

// ── Mode ────────────────────────────────────────────────────────────────────

/** 'unknown' is a real state: /api/firm can fail, and guessing is the bug. */
export type SendMode = 'testing' | 'live' | 'unknown';

export function sendModeFromTestingMode(testingMode: boolean | null | undefined): SendMode {
  if (testingMode === true) return 'testing';
  if (testingMode === false) return 'live';
  return 'unknown';
}

export function sendModeLabel(mode: SendMode): string {
  if (mode === 'testing') return 'Testing mode';
  if (mode === 'live') return 'LIVE mode';
  return 'Mode unknown';
}

// ── Per-send outcome ────────────────────────────────────────────────────────

/**
 * Every distinct thing /api/outreach/[id]/send can mean. Only 'sent' put an
 * email on the wire; the other four did not, and each needs different operator
 * action.
 */
export type SendOutcome =
  | 'sent'
  | 'already_sent'
  | 'dm_queue'
  | 'stale_draft'
  | 'rate_limited'
  /** Refused by the pool gates — blocklisted, over the firm's follower cap,
   *  outside its audience-fit band, or already ruled out in qualification. */
  | 'excluded'
  /** The campaign window closed before this draft could be sent.
   *  Its own bucket rather than the already_sent catch-all: nothing was
   *  delivered, and reporting a non-send as "already sent (skipped)" is the
   *  exact class of lie this module exists to stop. */
  | 'window_closed'
  /** The campaign's outreach limit or budget pacing refused a FIRST touch
   *  (src/lib/first-touch-gate.ts). Nothing went out; the draft stays. */
  | 'held_by_limit'
  | 'failed';

export interface SendTally {
  sent: number;
  already_sent: number;
  dm_queue: number;
  stale_draft: number;
  rate_limited: number;
  excluded: number;
  window_closed: number;
  held_by_limit: number;
  failed: number;
}

export function emptyTally(): SendTally {
  return {
    sent: 0,
    already_sent: 0,
    dm_queue: 0,
    stale_draft: 0,
    rate_limited: 0,
    excluded: 0,
    window_closed: 0,
    held_by_limit: 0,
    failed: 0,
  };
}

/**
 * Map an HTTP status + parsed body to an outcome. The route returns 409 for
 * four different situations, distinguished by `error`:
 *   'already sent' · 'dm_queue' (send_mode=human_queue or DM-routed creator)
 *   · 'stale_draft' (written before a release date that has since passed)
 *   · 'excluded' (the pool gates refused this creator).
 * A 409 we cannot parse is treated as already_sent — the conservative read,
 * since it still means "nothing went out just now".
 *
 * 'excluded' needs its own bucket rather than falling into that catch-all:
 * reporting a blocklisted creator as "already sent (skipped)" tells the
 * operator a message went out at some point, which is the opposite of what
 * happened and hides the very refusal the gate exists to surface.
 *
 * 429 is its own outcome. The draft is untouched and still sendable; calling
 * that `failed` tells an operator their drafts broke when the server simply
 * asked them to slow down.
 */
export function classifySendResponse(
  status: number,
  body: { error?: string } | null | undefined,
): SendOutcome {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 429) return 'rate_limited';
  if (status === 409) {
    const error = body?.error;
    if (error === 'dm_queue') return 'dm_queue';
    if (error === 'stale_draft') return 'stale_draft';
    if (error === 'excluded') return 'excluded';
    if (error === 'window_closed') return 'window_closed';
    if (error && (FIRST_TOUCH_REFUSALS as readonly string[]).includes(error)) return 'held_by_limit';
    return 'already_sent';
  }
  return 'failed';
}

/**
 * The `error` codes src/lib/first-touch-gate.ts answers 409 with. Duplicated
 * rather than imported: this module is in the client bundle and the gate
 * imports the negotiation lib. tests/first-touch-gate.test.ts pins the two
 * lists equal.
 */
export const FIRST_TOUCH_REFUSALS = [
  'outreach_limit_reached',
  'budget_fully_allocated',
  'campaign_budget_not_set',
  'per_creator_cap_not_set',
] as const;

/** "Contacted X of N" (or "Contacted X" with no limit) — the campaign page. */
export function contactedLabel(contacted: number, limit: number | null): string {
  return limit == null ? `Contacted ${contacted}` : `Contacted ${contacted} of ${limit}`;
}

export function tallyOutcome(tally: SendTally, outcome: SendOutcome): void {
  tally[outcome] += 1;
}

// ── Result summary ──────────────────────────────────────────────────────────

export interface SendSummary {
  level: 'success' | 'warning' | 'error' | 'info';
  message: string;
}

/**
 * One truthful sentence per batch. Counts are never merged: a draft that got
 * routed to the DM queue is not a send, and saying "12 sent" when 5 of them
 * bounced off a 409 is the thing this replaces.
 */
export function summarizeSendTally(tally: SendTally, mode: SendMode): SendSummary {
  const total =
    tally.sent +
    tally.already_sent +
    tally.dm_queue +
    tally.stale_draft +
    tally.rate_limited +
    tally.excluded +
    tally.window_closed +
    tally.held_by_limit +
    tally.failed;
  if (total === 0) {
    return { level: 'info', message: 'Nothing to send.' };
  }

  const parts: string[] = [];
  if (tally.sent > 0) {
    const where =
      mode === 'testing'
        ? ' in testing mode'
        : mode === 'live'
          ? ' to real creators (live)'
          : '';
    parts.push(`${tally.sent} sent${where}`);
  }
  if (tally.dm_queue > 0) {
    parts.push(`${tally.dm_queue} moved to the DM queue (send by hand)`);
  }
  if (tally.stale_draft > 0) {
    parts.push(`${tally.stale_draft} blocked as stale (regenerate the drafts)`);
  }
  if (tally.already_sent > 0) {
    parts.push(`${tally.already_sent} already sent (skipped)`);
  }
  if (tally.excluded > 0) {
    parts.push(
      `${tally.excluded} not contacted: outside this firm's creator pool (blocklisted, over the follower cap, or ruled out)`,
    );
  }
  if (tally.window_closed > 0) {
    parts.push(
      `${tally.window_closed} not sent: the campaign window has closed`,
    );
  }
  if (tally.held_by_limit > 0) {
    parts.push(
      `${tally.held_by_limit} not sent: the campaign's outreach limit or budget is reached`,
    );
  }
  if (tally.rate_limited > 0) {
    // Named as the rate limit it is, with the operator's actual next step.
    // These drafts are untouched and still sendable.
    parts.push(
      `${tally.rate_limited} held back by the send rate limit (still queued; send again in a minute)`,
    );
  }
  if (tally.failed > 0) {
    parts.push(`${tally.failed} failed`);
  }

  const level: SendSummary['level'] =
    tally.failed > 0
      ? 'error'
      : tally.dm_queue +
            tally.stale_draft +
            tally.already_sent +
            tally.rate_limited +
            tally.excluded +
            tally.window_closed +
            tally.held_by_limit >
          0
        ? 'warning'
        : 'success';

  return { level, message: `${parts.join(', ')}.` };
}

// ── Pacing ──────────────────────────────────────────────────────────────────
//
// These MUST equal TIER_CONFIG.expensive in src/lib/rate-limit.ts, which is
// what /api/outreach/[id]/send is gated on. They are duplicated rather than
// imported because this module is pulled into the client bundle and
// rate-limit.ts imports the Supabase admin client. tests/outreach-status.test.ts
// imports both and asserts they are equal, so the two cannot drift silently.

export const SEND_RATE_LIMIT_PER_WINDOW = 5;
export const SEND_RATE_WINDOW_MS = 60_000;

/**
 * A small margin on top of the window. The server limiter's window opens on
 * the FIRST request in a batch, so waiting exactly windowMs from the last
 * request in that batch is already safe; the extra second absorbs clock skew
 * between the browser and the serverless instance.
 */
const WINDOW_MARGIN_MS = 1_000;

export interface SendSchedule {
  /** Number of sends in each successive window, in order. */
  batches: number[];
  /** How long to wait between one batch finishing and the next starting. */
  waitMsBetweenBatches: number;
  /** Total wall-clock time spent waiting (does not include send latency). */
  estimatedMs: number;
}

/**
 * Split `count` sends into batches that fit the server's rate limit.
 *
 * The old loop used a hardcoded batch of 3 with no delay, which overruns a
 * 5-per-minute limit on the second batch. Pacing to the real limit means the
 * 429s never happen — which is better than reporting them honestly, though
 * classifySendResponse does that too for the case where an operator has
 * another tab sending on the same IP.
 */
export function planSendSchedule(
  count: number,
  limitPerWindow: number = SEND_RATE_LIMIT_PER_WINDOW,
  windowMs: number = SEND_RATE_WINDOW_MS,
): SendSchedule {
  const batches: number[] = [];
  let remaining = Math.max(0, Math.floor(count));
  while (remaining > 0) {
    const n = Math.min(limitPerWindow, remaining);
    batches.push(n);
    remaining -= n;
  }
  const waitMsBetweenBatches = windowMs + WINDOW_MARGIN_MS;
  const waits = Math.max(0, batches.length - 1);
  return {
    batches,
    waitMsBetweenBatches,
    estimatedMs: waits * waitMsBetweenBatches,
  };
}

/**
 * One sentence for the confirm dialog stating how long the send will take, or
 * '' when it fits in a single window and there is nothing to warn about.
 *
 * The operator is told the time cost BEFORE committing, which is the whole
 * point — a three-minute progress bar with no explanation reads as a hang.
 */
export function describeSendPace(
  count: number,
  limitPerWindow: number = SEND_RATE_LIMIT_PER_WINDOW,
  windowMs: number = SEND_RATE_WINDOW_MS,
): string {
  const plan = planSendSchedule(count, limitPerWindow, windowMs);
  if (plan.batches.length <= 1) return '';
  const minutes = Math.max(1, Math.round(plan.estimatedMs / 60_000));
  return (
    `Sending is capped at ${limitPerWindow} per minute, so this runs in ` +
    `${plan.batches.length} rounds and takes about ${minutes} ` +
    `${minutes === 1 ? 'minute' : 'minutes'}. Leave this page open.`
  );
}

// ── Confirm copy ────────────────────────────────────────────────────────────

export interface BulkSendConfirmArgs {
  mode: SendMode;
  count: number;
  /** Resolved firm_member ?? firm test_recipient_email; null when unset. */
  testRecipient: string | null;
}

export interface BulkSendConfirmCopy {
  title: string;
  body: string;
  /** True when this send reaches real creators — style the button accordingly. */
  destructive: boolean;
}

export function bulkSendConfirmCopy(args: BulkSendConfirmArgs): BulkSendConfirmCopy {
  const { mode, count, testRecipient } = args;
  const n = `${count} draft${count === 1 ? '' : 's'}`;

  if (mode === 'live') {
    return {
      title: `Send ${n} LIVE to real creators?`,
      destructive: true,
      body:
        `Each message goes to that creator's real email address. Nothing is rerouted, ` +
        `and sent email cannot be recalled. Switch this firm back to testing in ` +
        `Settings if that is not what you want.`,
    };
  }

  if (mode === 'testing') {
    return {
      title: `Send ${n} in testing mode?`,
      destructive: false,
      body: testRecipient
        ? `Testing mode is on, so no creator is contacted: all ${count} land in ${testRecipient}. ` +
          `Messages go out a few at a time.`
        : `Testing mode is on, but no test recipient is set for you or this firm, ` +
          `so these sends will fail. Set one in Settings first.`,
    };
  }

  return {
    title: `Send ${n}?`,
    destructive: true,
    body:
      `Could not read this firm's send mode, so it is unknown whether these go to ` +
      `a test inbox or to real creators. Reload the page or check Settings before sending.`,
  };
}
