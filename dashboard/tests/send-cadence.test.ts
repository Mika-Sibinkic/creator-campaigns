// tests/send-cadence.test.ts
//
// Pins the reply-timing model. Three separate things are being guarded here and
// they fail in different ways, so they get separate sections.
//
//   1. THE BANDS. An acceptance must answer fast (the creator just said yes;
//      delay is pure downside) and a price counter must not (an instant counter,
//      forty times, reads as automated). If someone collapses these back into
//      one band, that is a regression in product behaviour, not a refactor.
//
//   2. THE SHAPE. Uniform latency across a narrow band is its own machine
//      signature. The draw is right-skewed on purpose — mode near the fast end,
//      tail to the ceiling.
//
//   3. THE ENVELOPE. SEND_DELAY_MIN_SEC / MAX are derived from the bands so
//      they cannot drift from what they claim to summarise.
//
// Hermetic: pure functions, injected rand, no clock, no DB, no network.
//
// Run: npx tsx tests/send-cadence.test.ts

export {};

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

async function main() {
  const {
    CADENCE_BANDS,
    CATCH_UP_JITTER_BAND,
    HELD_REPLY_BAND,
    HOLDING_PROMISE_MINUTES,
    cadenceKindFor,
    delaySecondsFor,
    delaySecondsInBand,
    sendAfterMsFor,
  } = await import('../src/lib/send-cadence');

  // ── 1. The bands say what the product intends ────────────────────────────
  const accept = CADENCE_BANDS.agreement_confirmation;
  const counter = CADENCE_BANDS.counter;

  assert(accept.minSec === 60 && accept.maxSec === 180, 'acceptance answers in 60-180s');
  assert(
    counter.minSec > accept.maxSec,
    'a price counter is SLOWER than an acceptance — a person weighing money takes minutes, ' +
      'and an instant counter is the tell. If this fails, the two bands were collapsed.',
  );
  // Specified bands. These are pinned
  // exactly: they are a product decision, not tunable defaults, and the
  // holding note's "back to you in the next 15 minutes" promise is only honest
  // while the counter ceiling stays this low.
  assert(
    counter.minSec === 300 && counter.maxSec === 480,
    `counter answers in 300-480s — the specified band (got ${counter.minSec}-${counter.maxSec})`,
  );
  const clar = CADENCE_BANDS.clarification;
  assert(
    clar.minSec === 120 && clar.maxSec === 240,
    `clarification answers in 120-240s — the specified band (got ${clar.minSec}-${clar.maxSec})`,
  );
  assert(
    /weighing money/.test(counter.rationale) && /15-minute promise/.test(counter.rationale),
    'counter rationale states why the band is what it is',
  );
  assert(
    /a moment to read/.test(clar.rationale),
    'clarification rationale states why the band is what it is',
  );
  const hold = CADENCE_BANDS.holding_note;
  assert(
    hold.minSec === 60 && hold.maxSec === 180,
    `holding note goes 60-180s after pickup (got ${hold.minSec}-${hold.maxSec})`,
  );
  assert(
    HELD_REPLY_BAND.minSec === 300 && HELD_REPLY_BAND.maxSec === 480,
    `the reply behind a holding note goes 300-480s after pickup (got ${HELD_REPLY_BAND.minSec}-${HELD_REPLY_BAND.maxSec})`,
  );
  assert(
    HELD_REPLY_BAND.minSec > hold.maxSec,
    'the real reply can never be scheduled before its own holding note',
  );
  // The promise, end to end. Bands run from the creator's reply ARRIVING, so
  // the longest the reply can trail its note is the held-reply ceiling minus
  // the note floor, plus a minute of dispatch granularity. When pickup is late
  // enough that the bands have elapsed, both go at now + CATCH_UP_JITTER_BAND
  // with the reply a fixed gap behind — shorter still.
  assert(
    HELD_REPLY_BAND.maxSec - hold.minSec + 60 < HOLDING_PROMISE_MINUTES * 60,
    'worst-case note-to-reply gap + dispatch granularity stays under the promised 15 minutes',
  );
  assert(
    CATCH_UP_JITTER_BAND.minSec === 15 && CATCH_UP_JITTER_BAND.maxSec === 60,
    'an elapsed band sends at now + 15-60s, not instantly',
  );
  assert(HOLDING_PROMISE_MINUTES === 15, 'the promise the copy makes is 15 minutes');
  for (const [name, band] of Object.entries(CADENCE_BANDS)) {
    assert(band.minSec >= 60, `${name}: never answers inside a minute — that is the bot floor`);
    assert(band.maxSec > band.minSec, `${name}: band is a real range, not a point`);
    assert(band.rationale.length > 20, `${name}: carries a stated reason, not a bare number`);
  }

  // ── 2. Mapping from the stored message_type ──────────────────────────────
  assert(cadenceKindFor('agreement_confirmation') === 'agreement_confirmation', 'maps acceptance');
  assert(cadenceKindFor('counter') === 'counter', 'maps counter');
  assert(cadenceKindFor('clarification') === 'clarification', 'maps clarification');
  assert(cadenceKindFor('holding_note') === 'holding_note', 'maps holding note');
  assert(cadenceKindFor('initial') === 'other', 'an unmapped type falls back to the default band');
  assert(cadenceKindFor(null) === 'other', 'null type falls back');
  assert(cadenceKindFor(undefined) === 'other', 'undefined type falls back');

  // ── 3. Every draw lands inside its own band, at both extremes ────────────
  // The held-reply band is drawn through the same skewed, clamped function.
  assert(delaySecondsInBand(HELD_REPLY_BAND, () => 0) === 300, 'held reply: rand=0 gives 300s');
  assert(delaySecondsInBand(HELD_REPLY_BAND, () => 1) === 480, 'held reply: rand=1 is clamped to 480s');

  for (const kind of ['agreement_confirmation', 'counter', 'clarification', 'holding_note', 'other'] as const) {
    const band = CADENCE_BANDS[kind];
    assert(delaySecondsFor(kind, () => 0) === band.minSec, `${kind}: rand=0 gives the floor`);
    assert(delaySecondsFor(kind, () => 0.999999) <= band.maxSec, `${kind}: rand→1 stays under the ceiling`);
    for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999999]) {
      const d = delaySecondsFor(kind, () => r);
      assert(
        d >= band.minSec && d <= band.maxSec,
        `${kind}: rand=${r} → ${d}s is inside [${band.minSec}, ${band.maxSec}]`,
      );
    }
  }

  // ── 4. The distribution is right-skewed, not uniform ─────────────────────
  // rand=0.5 on a uniform draw would land at the midpoint. Squaring puts it at
  // a quarter of the span, so most replies are fast and the tail is rare.
  {
    const band = CADENCE_BANDS.counter;
    const mid = delaySecondsFor('counter', () => 0.5);
    const uniformMid = band.minSec + (band.maxSec - band.minSec) / 2;
    assert(
      mid < uniformMid,
      'rand=0.5 lands BELOW the midpoint — the draw is skewed toward fast replies, not uniform',
    );

    // Sampled over a sweep, the median must sit in the lower half of the band.
    const samples = Array.from({ length: 1001 }, (_, i) =>
      delaySecondsFor('counter', () => i / 1000),
    ).sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    assert(median < uniformMid, 'the median of a full sweep sits in the fast half of the band');
    assert(samples[samples.length - 1] <= band.maxSec, 'the sweep never exceeds the ceiling');
    assert(samples[0] === band.minSec, 'the sweep reaches the floor');
  }

  // ── 5. sendAfterMsFor is the band applied to a clock ─────────────────────
  {
    const now = 1_700_000_000_000;
    const at = sendAfterMsFor(now, 'agreement_confirmation', () => 0);
    assert(at === now + 60_000, 'floor draw schedules exactly 60s out');
    const late = sendAfterMsFor(now, 'counter', () => 0.999999);
    assert(
      late > now + CADENCE_BANDS.counter.minSec * 1000,
      'a tail draw on a counter schedules well past the acceptance band',
    );
  }

  // ── 6. The exported envelope cannot drift from the bands ─────────────────
  // negotiation-tick re-exports these; they are derived, so this is a guard
  // against someone hardcoding them back to a stale pair.
  {
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:9';
    process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-dummy';
    const { SEND_DELAY_MIN_SEC, SEND_DELAY_MAX_SEC, computeSendAfterIso } = await import(
      '../src/lib/negotiation-tick'
    );
    const mins = Object.values(CADENCE_BANDS).map((b) => b.minSec);
    const maxes = Object.values(CADENCE_BANDS).map((b) => b.maxSec);
    assert(SEND_DELAY_MIN_SEC === Math.min(...mins), 'envelope floor is the fastest band');
    assert(SEND_DELAY_MAX_SEC === Math.max(...maxes), 'envelope ceiling is the slowest band');

    // And the tick's own helper routes by message_type rather than a global band.
    const now = 1_700_000_000_000;
    const acceptIso = computeSendAfterIso(now, () => 0, 'agreement_confirmation');
    const counterIso = computeSendAfterIso(now, () => 0, 'counter');
    assert(
      Date.parse(acceptIso) < Date.parse(counterIso),
      'the tick schedules an acceptance sooner than a counter computed at the same instant — ' +
        'this is the behaviour the whole module exists for',
    );
    assert(
      Date.parse(acceptIso) === now + 60_000,
      'the tick applies the acceptance band, not the envelope',
    );
  }

  console.log(`send-cadence test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
