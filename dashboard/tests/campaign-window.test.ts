// tests/campaign-window.test.ts
//
// Hermetic unit test for src/lib/campaign-window.ts — the campaign
// window: the thing that turns `release_date` from a verb-tense hint into a
// real start and end that sends and measurement are held to.
//
// Everything under test is pure given (releaseDate, offsets, nowMs), so every
// case passes an explicit ms-epoch. No Date.now(), no clock, no tolerances.
//
// The properties that actually matter, in priority order:
//
//   1. NO release_date → NO window → NOTHING is gated. This is the
//      non-regression property. Every existing campaign without a release
//      date runs ungated; if shipping this file retro-gated them, working
//      campaigns would go silent on deploy. Tested first because it is the one that
//      breaks production rather than merely failing to add a feature.
//
//   2. A quiet-hours deferral can never smuggle a send past the window end.
//      Quiet hours only pushes sends FORWARD (9am-9pm governor), so without
//      the clamp the window would be advisory — every send it "blocked" would
//      just arrive late. clampDeferral() is the whole point of the module.
//
//   3. Nothing is ever stranded. A message that can never legally be sent is
//      CLOSED, not left queued forever with a human waiting on the other end.
//
// Run: npx tsx tests/campaign-window.test.ts

import {
  DEFAULT_WINDOW_LEAD_DAYS,
  DEFAULT_WINDOW_TAIL_DAYS,
  IN_THREAD_GRACE_DAYS,
  MEASUREMENT_TAIL_DAYS,
  MAX_OFFSET_DAYS,
  canContinueThreadAt,
  canOpenThreadAt,
  clampDeferral,
  daysUntil,
  deriveWindow,
  describeWindow,
  measurementAllowedAt,
  parseReleaseMs,
  windowOffsets,
  windowPhaseAt,
  resolveCampaignWindow,
  WINDOW_ENFORCEMENT_EPOCH,
  WINDOW_PHASE_LABELS,
  type CampaignWindow,
} from '../src/lib/campaign-window';

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

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** ms-epoch for a UTC wall-clock, so every case reads as a real instant. */
function utc(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi, 0, 0);
}

const RELEASE = '2026-06-01';
const RELEASE_MS = utc(2026, 6, 1);

function defaultWindow(): CampaignWindow {
  const w = deriveWindow(RELEASE, windowOffsets(undefined));
  if (!w) throw new Error('fixture window should exist');
  return w;
}

async function main() {
  // ── 1. No release date → no window → nothing gated ───────────────────────
  {
    for (const empty of [null, undefined, '']) {
      assert(
        deriveWindow(empty, windowOffsets(undefined)) === null,
        `deriveWindow(${JSON.stringify(empty)}) is null — no release date means no window`,
      );
    }
    assert(
      deriveWindow('not-a-date', windowOffsets(undefined)) === null,
      'an unparseable release_date yields no window rather than an Invalid Date window',
    );

    // The non-regression property, stated three ways.
    const now = utc(2030, 1, 1);
    assert(canOpenThreadAt(null, now), 'a null window never blocks opening a thread');
    assert(canContinueThreadAt(null, now), 'a null window never blocks continuing a thread');
    assert(measurementAllowedAt(null, now), 'a null window never blocks measurement');
    assert(
      windowPhaseAt(null, now) === 'no_window',
      'a null window reports the no_window phase, not a closed one',
    );
    const d = clampDeferral({ window: null, nowMs: now, deferredToMs: now });
    assert(
      d.action === 'send_now',
      'with no window and no quiet-hours deferral, the send goes now',
    );
    const d2 = clampDeferral({ window: null, nowMs: now, deferredToMs: now + HOUR_MS });
    assert(
      d2.action === 'reschedule' && d2.at_ms === now + HOUR_MS,
      'with no window, quiet hours still defers — the window imposes nothing, it removes nothing',
    );
  }

  // ── 2. The agreed default: 4 weeks before, 2 weeks after ─────────────────
  {
    assert(DEFAULT_WINDOW_LEAD_DAYS === 28, 'lead default is 28 days = the agreed four weeks');
    assert(DEFAULT_WINDOW_TAIL_DAYS === 14, 'tail default is 14 days = the agreed two weeks');

    const w = defaultWindow();
    assert(w.release_ms === RELEASE_MS, 'a DATE release parses as UTC midnight');
    assert(
      w.start_ms === RELEASE_MS - 28 * DAY_MS,
      'window_start is exactly 4 weeks before the release',
    );
    assert(
      w.start_iso.slice(0, 10) === '2026-05-04',
      'a 2026-06-01 release opens the window on 2026-05-04',
    );
    assert(
      w.end_iso.slice(0, 10) === '2026-06-15',
      'a 2026-06-01 release closes the window on 2026-06-15',
    );
    // End-of-day, not start-of-day: "through 2 weeks after" includes that day.
    assert(
      w.end_ms === RELEASE_MS + 14 * DAY_MS + (DAY_MS - 1),
      'window_end runs to the END of the final day, so the last day is usable',
    );
    assert(
      canOpenThreadAt(w, utc(2026, 6, 15, 23, 30)),
      'a send at 23:30 on the final day is still inside the window',
    );
    assert(
      !canOpenThreadAt(w, utc(2026, 6, 16, 0, 1)),
      'a send just after midnight on the following day is outside the window',
    );
  }

  // ── 3. Phases ────────────────────────────────────────────────────────────
  {
    const w = defaultWindow();
    assert(windowPhaseAt(w, utc(2026, 4, 1)) === 'before', 'well before the window → before');
    assert(
      windowPhaseAt(w, w.start_ms - 1) === 'before',
      'one ms before the start is still before',
    );
    assert(windowPhaseAt(w, w.start_ms) === 'open', 'the start instant is inside the window');
    assert(windowPhaseAt(w, utc(2026, 6, 1)) === 'open', 'release day is inside the window');
    assert(windowPhaseAt(w, w.end_ms) === 'open', 'the end instant is still inside the window');
    assert(
      windowPhaseAt(w, w.end_ms + 1) === 'grace',
      'just past the end is grace, not closed — a live thread may still land',
    );
    assert(
      windowPhaseAt(w, w.end_ms + IN_THREAD_GRACE_DAYS * DAY_MS) === 'grace',
      'the last instant of the grace period is still grace',
    );
    assert(
      windowPhaseAt(w, w.end_ms + IN_THREAD_GRACE_DAYS * DAY_MS + 1) === 'closed',
      'past the grace the campaign is closed',
    );
    for (const phase of ['no_window', 'before', 'open', 'grace', 'closed'] as const) {
      assert(
        typeof WINDOW_PHASE_LABELS[phase] === 'string' && WINDOW_PHASE_LABELS[phase].length > 0,
        `phase ${phase} has a label the UI can render`,
      );
    }
  }

  // ── 4. Open vs continue: the end is hard for new threads, soft for live ones ──
  {
    const w = defaultWindow();
    const inGrace = w.end_ms + 2 * DAY_MS;

    assert(
      !canOpenThreadAt(w, inGrace),
      'a NEW thread may not be opened after window_end — escalation takes the hard gate',
    );
    assert(
      canContinueThreadAt(w, inGrace),
      'an OPEN thread may still be answered in the grace period — a creator who replied late still gets their counter',
    );
    assert(
      !canContinueThreadAt(w, w.end_ms + (IN_THREAD_GRACE_DAYS + 1) * DAY_MS),
      'past the grace even an open thread stops',
    );
    assert(
      !canOpenThreadAt(w, w.start_ms - 1) && !canContinueThreadAt(w, w.start_ms - 1),
      'neither may happen before the window opens',
    );
  }

  // ── 5. THE CLAMP: quiet hours must not smuggle a send past the end ───────
  {
    const w = defaultWindow();

    // The exact hazard from the issue: due at 20:58 on the final night, quiet
    // hours wants to push it to ~09:00 the next morning — outside the window.
    const lastNight = utc(2026, 6, 15, 20, 58);
    const nextMorning = utc(2026, 6, 16, 9, 0);
    assert(lastNight <= w.end_ms, 'fixture: the send is due while still inside the window');
    assert(nextMorning > w.end_ms, 'fixture: the quiet-hours opening lands outside the window');

    const clamped = clampDeferral({ window: w, nowMs: lastNight, deferredToMs: nextMorning });
    assert(
      clamped.action === 'close',
      'a quiet-hours deferral that would land outside the window CLOSES the message instead of sending it late',
    );
    assert(
      clamped.action === 'close' && clamped.reason === 'quiet_hours_would_exit_window',
      'and the reason names the quiet-hours/window interaction rather than a generic failure',
    );

    // Same instant, but judged under the in-thread deadline (window_end +
    // grace) — a live negotiation is allowed to finish.
    const asContinuation = clampDeferral({
      window: w,
      nowMs: lastNight,
      deferredToMs: nextMorning,
      deadlineMs: w.end_ms + IN_THREAD_GRACE_DAYS * DAY_MS,
    });
    assert(
      asContinuation.action === 'reschedule' && asContinuation.at_ms === nextMorning,
      'the SAME deferral is allowed for an in-thread continuation — that is what the grace is for',
    );

    // Inside the window with no deferral pending → just send.
    const mid = utc(2026, 6, 1, 14, 0);
    const now1 = clampDeferral({ window: w, nowMs: mid, deferredToMs: mid });
    assert(now1.action === 'send_now', 'due inside the window with no deferral → send now');

    // A deferral that still lands inside the window is fine.
    const earlyMorning = utc(2026, 6, 1, 3, 0);
    const sameDayNine = utc(2026, 6, 1, 9, 0);
    const ok = clampDeferral({ window: w, nowMs: earlyMorning, deferredToMs: sameDayNine });
    assert(
      ok.action === 'reschedule' && ok.at_ms === sameDayNine,
      'a quiet-hours deferral that still lands inside the window is honoured normally',
    );
  }

  // ── 6. Before the window: wait, never refuse, never strand ───────────────
  {
    const w = defaultWindow();
    const early = utc(2026, 4, 20, 10, 0); // before window_start
    assert(early < w.start_ms, 'fixture: this instant is before the window opens');

    const d = clampDeferral({ window: w, nowMs: early, deferredToMs: early });
    assert(
      d.action === 'reschedule' && d.at_ms === w.start_ms,
      'a send queued before the window waits for window_start rather than being dropped',
    );
    assert(
      d.action === 'reschedule' && d.reason === 'before_window_start',
      'and the reason says so',
    );

    // Quiet hours later than window_start → take the later of the two.
    const laterOpening = w.start_ms + 5 * HOUR_MS;
    const d2 = clampDeferral({ window: w, nowMs: early, deferredToMs: laterOpening });
    assert(
      d2.action === 'reschedule' && d2.at_ms === laterOpening,
      'when quiet hours opens later than the window does, the LATER time wins — both gates hold',
    );
  }

  // ── 7. Nothing is stranded ───────────────────────────────────────────────
  {
    const w = defaultWindow();
    const wayPast = w.end_ms + 365 * DAY_MS;
    const d = clampDeferral({ window: w, nowMs: wayPast, deferredToMs: wayPast });
    assert(
      d.action === 'close' && d.reason === 'window_closed',
      'a message still queued long after the window is closed out, never left pending forever',
    );

    // A degenerate window narrower than a quiet-hours deferral must close
    // rather than reschedule into a time it can never reach.
    const narrow = deriveWindow('2026-06-01', { lead_days: 0, tail_days: 0 });
    if (!narrow) throw new Error('narrow window should exist');
    const before = narrow.start_ms - 2 * DAY_MS;
    const dd = clampDeferral({
      window: narrow,
      nowMs: before,
      deferredToMs: narrow.end_ms + DAY_MS,
    });
    assert(
      dd.action === 'close' && dd.reason === 'window_shorter_than_quiet_hours',
      'if quiet hours could only release the send after the window ends, it closes instead of waiting forever',
    );
  }

  // ── 8. Firm-configurable offsets ─────────────────────────────────────────
  {
    const d = windowOffsets(undefined);
    assert(
      d.lead_days === DEFAULT_WINDOW_LEAD_DAYS && d.tail_days === DEFAULT_WINDOW_TAIL_DAYS,
      'absent prefs fall back to the agreed 4-weeks-before / 2-weeks-after default',
    );
    assert(
      windowOffsets(null).lead_days === DEFAULT_WINDOW_LEAD_DAYS &&
        windowOffsets('nonsense').lead_days === DEFAULT_WINDOW_LEAD_DAYS &&
        windowOffsets(42).lead_days === DEFAULT_WINDOW_LEAD_DAYS,
      'non-object prefs fall back rather than throwing',
    );

    const custom = windowOffsets({
      campaign_window_lead_days: 60,
      campaign_window_tail_days: 7,
    });
    assert(
      custom.lead_days === 60 && custom.tail_days === 7,
      'a firm may configure its own offsets',
    );

    const w = deriveWindow(RELEASE, custom);
    assert(
      w !== null && w.start_ms === RELEASE_MS - 60 * DAY_MS,
      'configured offsets actually move the window start',
    );

    // 0 is meaningful: "start on release day".
    const zero = windowOffsets({ campaign_window_lead_days: 0, campaign_window_tail_days: 0 });
    assert(
      zero.lead_days === 0 && zero.tail_days === 0,
      'zero offsets are honoured — a firm may want a release-day-only campaign',
    );
    const zw = deriveWindow(RELEASE, zero);
    assert(
      zw !== null && zw.start_ms === RELEASE_MS,
      'a zero lead offset starts the window exactly on release day',
    );

    // Garbage must not produce a garbage window.
    const bad = windowOffsets({
      campaign_window_lead_days: -5,
      campaign_window_tail_days: 'soon',
    });
    assert(
      bad.lead_days === DEFAULT_WINDOW_LEAD_DAYS && bad.tail_days === DEFAULT_WINDOW_TAIL_DAYS,
      'negative and non-numeric offsets fall back to the defaults',
    );
    const huge = windowOffsets({ campaign_window_lead_days: 99999 });
    assert(
      huge.lead_days === MAX_OFFSET_DAYS,
      'an absurd offset is clamped rather than producing a decade-long campaign',
    );
    const frac = windowOffsets({ campaign_window_lead_days: 10.9 });
    assert(frac.lead_days === 10, 'fractional offsets are floored to whole days');
  }

  // ── 9. Measurement runs past the window, then stops ──────────────────────
  {
    const w = defaultWindow();
    // Gates the CLOSED side only. Returning false before window_start would
    // exclude a back-dated catalog campaign from measurement the instant it
    // was created, which the name and every comment contradict. There is
    // nothing to protect early: a campaign with no posts has no deliveries to
    // scrape, so the loop finds nothing and costs nothing.
    assert(
      measurementAllowedAt(w, w.start_ms - DAY_MS),
      'measurement is NOT blocked before the campaign starts — the gate is the closed side only',
    );
    assert(measurementAllowedAt(w, w.start_ms), 'measurement runs from window_start');
    assert(measurementAllowedAt(w, w.end_ms), 'measurement runs through window_end');
    assert(
      measurementAllowedAt(w, w.end_ms + MEASUREMENT_TAIL_DAYS * DAY_MS),
      'measurement continues through the whole measurement tail — content posted on the last day still gets its snapshots',
    );
    assert(
      !measurementAllowedAt(w, w.end_ms + (MEASUREMENT_TAIL_DAYS + 1) * DAY_MS),
      'past the tail we stop paying for scrapes on a finished campaign',
    );
    assert(
      MEASUREMENT_TAIL_DAYS > IN_THREAD_GRACE_DAYS,
      'measurement outlives messaging — the data arrives after the posts do',
    );
  }

  // ── 10. Release-date parsing ─────────────────────────────────────────────
  {
    assert(parseReleaseMs('2026-06-01') === RELEASE_MS, 'a bare DATE anchors at UTC midnight');
    assert(
      parseReleaseMs('2026-06-01T12:34:56.000Z') === Date.UTC(2026, 5, 1, 12, 34, 56),
      'a full ISO timestamp is accepted as-is',
    );
    assert(parseReleaseMs(null) === null, 'null parses to null');
    assert(parseReleaseMs('garbage') === null, 'garbage parses to null, not NaN');
  }

  // ── 11. UI helpers ───────────────────────────────────────────────────────
  {
    const w = defaultWindow();
    assert(
      describeWindow(null).includes('No release date'),
      'the no-window description says so in words a label can read',
    );
    const desc = describeWindow(w);
    assert(
      desc.includes('2026-05-04') && desc.includes('2026-06-15') && desc.includes('28d'),
      'the window description carries both dates and the offsets that produced them',
    );
    assert(
      daysUntil(w.start_ms, w.start_ms - 3 * DAY_MS) === 3,
      'daysUntil counts forward to the window opening',
    );
    assert(
      daysUntil(w.end_ms, w.end_ms + 2 * DAY_MS) < 0,
      'daysUntil goes negative once the target has passed',
    );
  }

  // ── 12. GRANDFATHERING — the window must not retro-gate live work ────────
  //
  // This section exists because the first version of this module shipped a
  // safety claim that was only true of the NULL case, and a review caught it.
  // The failing shape is reproduced exactly.
  {
    const EPOCH = Date.parse(WINDOW_ENFORCEMENT_EPOCH);

    // ---- The exact failing shape, reproduced. ----
    // Both campaigns: release_date 2026-07-04, firm has no window keys, so the
    // 28/14 defaults apply → window 2026-06-06 .. 2026-07-18, in-thread
    // deadline 2026-07-25. "Today" is 2026-09-18, i.e. 62 days past the end.
    const LABEL_RELEASE = '2026-07-04';
    const LABEL_CREATED = '2026-06-20T12:00:00.000Z'; // campaign predates the feature
    const TODAY = Date.parse('2026-09-18T15:00:00.000Z');

    const raw = deriveWindow(LABEL_RELEASE, windowOffsets(undefined));
    assert(raw !== null, 'fixture: the release date does derive a raw window');
    assert(
      raw !== null && raw.end_iso.slice(0, 10) === '2026-07-18',
      'fixture: that raw window really does end 2026-07-18, two months before today',
    );
    assert(
      raw !== null && TODAY > raw.end_ms + IN_THREAD_GRACE_DAYS * DAY_MS,
      'fixture: today is past even the in-thread grace — the retro-gating hazard is real',
    );

    // The fix: resolved through resolveCampaignWindow, it is UNGATED.
    const resolved = resolveCampaignWindow({
      releaseDate: LABEL_RELEASE,
      createdAt: LABEL_CREATED,
      offsets: windowOffsets(undefined),
    });
    assert(
      resolved.window === null,
      'a campaign created before the feature shipped is NOT window-gated, however old its release date',
    );
    assert(
      resolved.exemption === 'created_before_feature',
      'and the exemption names grandfathering rather than looking like a missing release date',
    );

    // THE REGRESSION TEST THE REVIEW ASKED FOR, stated as behaviour:
    // a campaign with a release_date 62 days in the past and an open offer
    // must still send its counter.
    const counterDue = clampDeferral({
      window: resolved.window,
      nowMs: TODAY,
      deferredToMs: TODAY,
      deadlineMs: undefined,
    });
    assert(
      counterDue.action === 'send_now',
      'a counter queued today for a 62-day-expired grandfathered campaign SENDS — the creator who just replied is not ghosted',
    );
    assert(
      canContinueThreadAt(resolved.window, TODAY),
      'and the live negotiation thread is still continuable',
    );
    assert(
      canOpenThreadAt(resolved.window, TODAY),
      'a grandfathered campaign is ungated for new threads too — it behaves exactly as it did before the feature existed',
    );

    // Had we NOT grandfathered, that same counter would have been killed.
    // Pinned so nobody "simplifies" the exemption away without seeing the cost.
    const ungrandfathered = clampDeferral({
      window: raw,
      nowMs: TODAY,
      deferredToMs: TODAY,
      deadlineMs: raw ? raw.end_ms + IN_THREAD_GRACE_DAYS * DAY_MS : undefined,
    });
    assert(
      ungrandfathered.action === 'close',
      'CONTROL: without grandfathering the identical counter is closed as window_closed — this is the defect being prevented',
    );

    // ---- Condition 2: created AFTER its own window_end ----
    // The back-dated catalog campaign: set up today for last year's release.
    const catalog = resolveCampaignWindow({
      releaseDate: '2026-01-01',
      createdAt: '2026-09-18T09:00:00.000Z',
      offsets: windowOffsets(undefined),
    });
    assert(
      catalog.window === null && catalog.exemption === 'created_after_window_end',
      'a campaign created after its own window closed is ungated — otherwise it could never send anything at all',
    );

    // ---- A campaign created after the epoch, inside its window, IS gated ----
    const future = resolveCampaignWindow({
      releaseDate: '2026-10-01',
      createdAt: '2026-09-18T09:00:00.000Z',
      offsets: windowOffsets(undefined),
    });
    assert(
      future.window !== null && future.exemption === 'none',
      'a NEW campaign created inside its own window IS gated — grandfathering does not disable the feature going forward',
    );
    assert(
      future.window !== null && future.window.end_iso.slice(0, 10) === '2026-10-15',
      'and its window is the ordinary 28/14 derivation',
    );

    // ---- Unknown created_at fails OPEN ----
    for (const bad of [null, undefined, '', 'not-a-date']) {
      const r = resolveCampaignWindow({
        releaseDate: LABEL_RELEASE,
        createdAt: bad,
        offsets: windowOffsets(undefined),
      });
      assert(
        r.window === null && r.exemption === 'unknown_created_at',
        `an unreadable created_at (${JSON.stringify(bad)}) leaves the campaign ungated rather than gating on data we could not read`,
      );
    }

    // ---- No release date still wins, and reports as such ----
    const none = resolveCampaignWindow({
      releaseDate: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      offsets: windowOffsets(undefined),
    });
    assert(
      none.window === null && none.exemption === 'no_release_date',
      'no release date is still the first exemption checked',
    );

    // ---- The epoch boundary is inclusive-at-or-after ----
    const atEpoch = resolveCampaignWindow({
      releaseDate: '2026-10-01',
      createdAt: new Date(EPOCH).toISOString(),
      offsets: windowOffsets(undefined),
      epochMs: EPOCH,
    });
    assert(
      atEpoch.exemption === 'none',
      'a campaign created exactly at the epoch instant is gated (>=, not >)',
    );
    const justBefore = resolveCampaignWindow({
      releaseDate: '2026-10-01',
      createdAt: new Date(EPOCH - 1).toISOString(),
      offsets: windowOffsets(undefined),
      epochMs: EPOCH,
    });
    assert(
      justBefore.exemption === 'created_before_feature',
      'one millisecond before the epoch is grandfathered',
    );
  }

  console.log(`campaign-window test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
