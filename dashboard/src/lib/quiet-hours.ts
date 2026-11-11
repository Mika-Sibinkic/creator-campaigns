// src/lib/quiet-hours.ts
//
// Quiet-hours gate for AUTO-EMAILED outreach. The
// social-cadence governor already encodes the researched activity window
// (9am–9pm local, ACTIVE_START/END_HOUR) for DMs — but it had zero runtime
// consumers, and email counters had no window at all: a creator replying at
// 2:40am got a "hand-typed" counter back at 2:46am. Invisible in testing
// mode, an instant machine-tell in live mode.
//
// This module applies the SAME window to the email dispatch path
// (negotiation-tick's dispatchDue): a due send outside the window is not
// sent — its send_after is pushed to the next window opening plus jitter, so
// the existing scheduler machinery (migration 019's send_after column, the
// tick's due-scan) does all the work and no new state is needed.
//
// Timezone: outreach_messages carries no recipient timezone, so the window is
// evaluated in a single configured offset — OUTREACH_TZ_OFFSET_HOURS, default
// -5 (UTC-5; set OUTREACH_TZ_OFFSET_HOURS for your creators' region). A single offset
// suits a pool concentrated in one region; revisit per-creator timezones if
// the pool goes international.
// Pure given (tsMs, offsetHours, rand) — hermetic tests need no clock.

import { ACTIVE_START_HOUR, ACTIVE_END_HOUR } from './social-cadence';

export const DEFAULT_TZ_OFFSET_HOURS = -5;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Jitter added past the 9:00 boundary so deferred sends don't all fire in a
 *  burst at 9:00:00 — up to 45 min keeps the morning drip human. */
export const WINDOW_OPEN_JITTER_MAX_MS = 45 * 60_000;

/** OUTREACH_TZ_OFFSET_HOURS, clamped to a real UTC offset; default -5. */
export function tzOffsetHours(): number {
  const raw = Number.parseFloat(process.env.OUTREACH_TZ_OFFSET_HOURS ?? '');
  if (!Number.isFinite(raw) || raw < -12 || raw > 14) return DEFAULT_TZ_OFFSET_HOURS;
  return raw;
}

/** Hour-of-day (0-23) at `tsMs` in the configured outreach timezone. */
export function localHourAt(tsMs: number, offsetHours: number = tzOffsetHours()): number {
  return new Date(tsMs + offsetHours * HOUR_MS).getUTCHours();
}

/** Is `tsMs` inside the allowed send window (9am ≤ local < 9pm)? */
export function inSendWindow(tsMs: number, offsetHours: number = tzOffsetHours()): boolean {
  const h = localHourAt(tsMs, offsetHours);
  return h >= ACTIVE_START_HOUR && h < ACTIVE_END_HOUR;
}

/**
 * The next moment sending is allowed, as ms-epoch: `tsMs` itself when already
 * inside the window, else the next local ACTIVE_START_HOUR boundary plus a
 * random jitter (rand injectable — the tick passes its deterministic seam).
 */
export function nextSendWindowMs(
  tsMs: number,
  rand: () => number = Math.random,
  offsetHours: number = tzOffsetHours(),
): number {
  if (inSendWindow(tsMs, offsetHours)) return tsMs;
  const localMs = tsMs + offsetHours * HOUR_MS;
  const localMidnight = Math.floor(localMs / DAY_MS) * DAY_MS;
  const todayOpen = localMidnight + ACTIVE_START_HOUR * HOUR_MS;
  // Before 9am local → today's opening; at/after 9pm → tomorrow's.
  const localOpen = localMs < todayOpen ? todayOpen : todayOpen + DAY_MS;
  const jitter = Math.floor(rand() * WINDOW_OPEN_JITTER_MAX_MS);
  return localOpen - offsetHours * HOUR_MS + jitter;
}
