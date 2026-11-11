// tests/quiet-hours.test.ts
//
// Hermetic unit test for src/lib/quiet-hours.ts — the gate that stops the
// negotiation tick auto-emailing a "hand-typed" counter-offer at 3am. In
// testing mode that is invisible; in live mode it is an instant machine-tell
// to the creator on the other end, and the deal reads as a bot the moment it
// lands. So the property under test is narrow and absolute: a due send
// outside 9am–9pm local is never dispatched, it is rescheduled INTO the
// window.
//
// Everything is pure given (tsMs, offsetHours, rand), so every case passes an
// explicit ms-epoch and an explicit rand. No Date.now(), no clock, no
// tolerance windows — a flaky test here would be worse than no test, because
// it trains people to re-run instead of read.
//
// NOTE the module uses a FIXED numeric UTC offset, not an IANA timezone: it
// has no DST table and deliberately does not pretend to. These assertions
// encode the fixed-offset contract, not US DST rules.
//
// Run: npx tsx tests/quiet-hours.test.ts

import {
  DEFAULT_TZ_OFFSET_HOURS,
  WINDOW_OPEN_JITTER_MAX_MS,
  tzOffsetHours,
  localHourAt,
  inSendWindow,
  nextSendWindowMs,
} from '../src/lib/quiet-hours';
import { ACTIVE_START_HOUR, ACTIVE_END_HOUR } from '../src/lib/social-cadence';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

const HOUR_MS = 3_600_000;

/** ms-epoch for a UTC wall-clock, so every case reads as a real instant. */
function utc(y: number, mo: number, d: number, h: number, mi = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi, 0, 0);
}

/** Set OUTREACH_TZ_OFFSET_HOURS for one assertion and always restore it. */
function withOffsetEnv<T>(value: string | undefined, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'OUTREACH_TZ_OFFSET_HOURS');
  const prev = process.env.OUTREACH_TZ_OFFSET_HOURS;
  try {
    if (value === undefined) delete process.env.OUTREACH_TZ_OFFSET_HOURS;
    else process.env.OUTREACH_TZ_OFFSET_HOURS = value;
    return fn();
  } finally {
    if (had) process.env.OUTREACH_TZ_OFFSET_HOURS = prev;
    else delete process.env.OUTREACH_TZ_OFFSET_HOURS;
  }
}

async function main() {
  // ── 0. The window constants are the SHARED social-cadence ones ───────────
  // quiet-hours exists so email and DM obey one window. If these drift apart
  // the module's whole premise is gone, so assert the coupling directly.
  assert(ACTIVE_START_HOUR === 9, 'shared window opens at 9am');
  assert(ACTIVE_END_HOUR === 21, 'shared window closes at 9pm');
  assert(DEFAULT_TZ_OFFSET_HOURS === -5, 'default offset is -5 (UTC-5; override with OUTREACH_TZ_OFFSET_HOURS)');

  // ── 1. tzOffsetHours(): env parsing, defaulting, clamping ───────────────
  assert(
    withOffsetEnv(undefined, () => tzOffsetHours()) === DEFAULT_TZ_OFFSET_HOURS,
    'unset OUTREACH_TZ_OFFSET_HOURS falls back to the default offset',
  );
  assert(
    withOffsetEnv('', () => tzOffsetHours()) === DEFAULT_TZ_OFFSET_HOURS,
    'blank OUTREACH_TZ_OFFSET_HOURS falls back to the default offset',
  );
  assert(
    withOffsetEnv('not-a-number', () => tzOffsetHours()) === DEFAULT_TZ_OFFSET_HOURS,
    'non-numeric OUTREACH_TZ_OFFSET_HOURS falls back to the default offset',
  );
  assert(
    withOffsetEnv('0', () => tzOffsetHours()) === 0,
    'OUTREACH_TZ_OFFSET_HOURS=0 is honored (UTC is a real offset, not a falsy miss)',
  );
  assert(
    withOffsetEnv('5.5', () => tzOffsetHours()) === 5.5,
    'fractional offsets are honored (India is +5.5)',
  );
  assert(
    withOffsetEnv('-8', () => tzOffsetHours()) === -8,
    'negative offsets are honored',
  );
  assert(
    withOffsetEnv('-13', () => tzOffsetHours()) === DEFAULT_TZ_OFFSET_HOURS,
    'offset below -12 is clamped back to the default rather than trusted',
  );
  assert(
    withOffsetEnv('15', () => tzOffsetHours()) === DEFAULT_TZ_OFFSET_HOURS,
    'offset above +14 is clamped back to the default rather than trusted',
  );
  assert(
    withOffsetEnv('14', () => tzOffsetHours()) === 14,
    'the +14 boundary itself is a valid offset (Kiribati)',
  );
  assert(
    withOffsetEnv('-12', () => tzOffsetHours()) === -12,
    'the -12 boundary itself is a valid offset',
  );

  // ── 2. localHourAt(): UTC instant → local hour at an explicit offset ─────
  assert(localHourAt(utc(2026, 9, 17, 14), 0) === 14, 'offset 0 leaves the UTC hour alone');
  assert(localHourAt(utc(2026, 9, 17, 14), -5) === 9, '14:00Z at -5 is 09:00 local');
  assert(localHourAt(utc(2026, 9, 17, 14), 2) === 16, '14:00Z at +2 is 16:00 local');
  // Negative-offset day ROLLBACK: 02:00Z is still the previous local evening.
  assert(
    localHourAt(utc(2026, 9, 17, 2), -5) === 21,
    '02:00Z at -5 rolls back to 21:00 on the PREVIOUS local day',
  );
  assert(
    localHourAt(utc(2026, 9, 17, 4), -5) === 23,
    '04:00Z at -5 rolls back to 23:00 on the previous local day',
  );
  // Positive-offset day ROLLFORWARD.
  assert(
    localHourAt(utc(2026, 9, 17, 23), 3) === 2,
    '23:00Z at +3 rolls forward to 02:00 on the NEXT local day',
  );

  // ── 3. inSendWindow(): 9am inclusive, 9pm exclusive ─────────────────────
  assert(inSendWindow(utc(2026, 9, 17, 14), -5), '09:00 local is inside the window (inclusive open)');
  assert(inSendWindow(utc(2026, 9, 17, 18), -5), '13:00 local is inside the window');
  assert(
    inSendWindow(utc(2026, 9, 18, 1, 59), -5),
    '20:59 local is inside the window (last minute before close)',
  );
  assert(
    !inSendWindow(utc(2026, 9, 18, 2), -5),
    '21:00 local is OUTSIDE the window (exclusive close — 9pm is already too late)',
  );
  assert(
    !inSendWindow(utc(2026, 9, 17, 13, 59), -5),
    '08:59 local is OUTSIDE the window (one minute early is still early)',
  );
  assert(
    !inSendWindow(utc(2026, 9, 17, 8), -5),
    '03:00 local is OUTSIDE the window — the 3am counter-offer this module exists to prevent',
  );
  assert(
    !inSendWindow(utc(2026, 9, 17, 5), -5),
    'midnight local is OUTSIDE the window',
  );

  // ── 4. nextSendWindowMs(): in-window is a passthrough ───────────────────
  {
    const inside = utc(2026, 9, 17, 18); // 13:00 local at -5
    assert(
      nextSendWindowMs(inside, () => 0.5, -5) === inside,
      'a timestamp already inside the window is returned UNCHANGED (no needless reschedule)',
    );
    assert(
      nextSendWindowMs(inside, () => 0.999, -5) === inside,
      'in-window passthrough ignores jitter entirely',
    );
  }

  // ── 5. nextSendWindowMs(): before 9am rolls to TODAY's opening ──────────
  {
    const early = utc(2026, 9, 17, 8); // 03:00 local at -5
    const todayOpen = utc(2026, 9, 17, 14); // 09:00 local same day
    assert(
      nextSendWindowMs(early, () => 0, -5) === todayOpen,
      '03:00 local with zero jitter rolls forward to 09:00 the SAME local day',
    );
    const jittered = nextSendWindowMs(early, () => 0.5, -5);
    assert(
      jittered === todayOpen + Math.floor(0.5 * WINDOW_OPEN_JITTER_MAX_MS),
      'jitter is added past the opening boundary, not subtracted from it',
    );
    assert(jittered > early, 'a deferred send is always scheduled into the future');
  }

  // ── 6. nextSendWindowMs(): at/after 9pm rolls to TOMORROW's opening ─────
  {
    const late = utc(2026, 9, 18, 2); // 21:00 local at -5 — first excluded minute
    const tomorrowOpen = utc(2026, 9, 18, 14); // 09:00 local next day
    assert(
      nextSendWindowMs(late, () => 0, -5) === tomorrowOpen,
      '21:00 local rolls to the NEXT day 09:00, never backwards to today',
    );
    const nearMidnight = utc(2026, 9, 18, 4, 30); // 23:30 local at -5
    assert(
      nextSendWindowMs(nearMidnight, () => 0, -5) === tomorrowOpen,
      '23:30 local rolls to the next local morning',
    );
  }

  // ── 7. The result is ALWAYS itself in-window — the invariant that matters ─
  // If this ever fails the tick would defer a send to another dead hour and
  // loop, rewriting send_after every beat instead of ever sending.
  {
    const rands: (() => number)[] = [() => 0, () => 0.25, () => 0.5, () => 0.9999999];
    const offsets = [-12, -8, -5, 0, 2, 5.5, 14];
    let invariantHolds = true;
    let monotonic = true;
    for (const off of offsets) {
      for (let h = 0; h < 24; h++) {
        for (const rand of rands) {
          const t = utc(2026, 9, 17, h, 0);
          const next = nextSendWindowMs(t, rand, off);
          if (!inSendWindow(next, off)) invariantHolds = false;
          if (next < t) monotonic = false;
        }
      }
    }
    assert(
      invariantHolds,
      'every rescheduled instant is itself inside the send window, across all 24 hours / 7 offsets / 4 jitter values',
    );
    assert(monotonic, 'nextSendWindowMs never returns a time earlier than its input');
  }

  // ── 8. Jitter is bounded — a deferral must not slide out of the window ──
  {
    const early = utc(2026, 9, 17, 8); // 03:00 local
    const todayOpen = utc(2026, 9, 17, 14);
    const maxJittered = nextSendWindowMs(early, () => 0.9999999, -5);
    assert(
      maxJittered - todayOpen < WINDOW_OPEN_JITTER_MAX_MS,
      'jitter is strictly bounded by WINDOW_OPEN_JITTER_MAX_MS',
    );
    assert(
      WINDOW_OPEN_JITTER_MAX_MS <= (ACTIVE_END_HOUR - ACTIVE_START_HOUR) * HOUR_MS,
      'max jitter is smaller than the window itself, so jitter can never overshoot the close',
    );
  }

  // ── 9. Env-driven default path agrees with the explicit-offset path ─────
  // The tick calls these with no offset argument, so the env default must
  // behave identically to passing that offset by hand.
  {
    const t = utc(2026, 9, 17, 8); // 03:00 local at -5
    const viaEnv = withOffsetEnv('-5', () => ({
      inWindow: inSendWindow(t),
      next: nextSendWindowMs(t, () => 0),
      hour: localHourAt(t),
    }));
    assert(viaEnv.inWindow === false, 'env-default inSendWindow agrees with the explicit offset');
    assert(
      viaEnv.next === nextSendWindowMs(t, () => 0, -5),
      'env-default nextSendWindowMs agrees with the explicit offset',
    );
    assert(viaEnv.hour === 3, 'env-default localHourAt agrees with the explicit offset');
  }

  console.log(`quiet-hours test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
