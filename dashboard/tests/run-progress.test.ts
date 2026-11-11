// tests/run-progress.test.ts
//
// Unit tests for the discovery-run state machine (src/lib/run-progress.ts),
// which is what <CampaignProgress> renders. Every case below is a regression
// found by reading the SSE producer at src/app/api/campaigns/[id]/run/route.ts
// against the browser code that consumed it — that code knew 3 of the route's 6
// event names and 4 of its 5 steps.
//
// The two that matter most for a demo:
//
//   1. ZERO CREATORS. The route emits `done {total: 0}` — byte-identical in
//      shape to a successful run (the final `done` frame in run/route.ts).
//      The old client never read `total`, so a run that found nobody
//      painted a full green progress bar above an empty list. That is the all-green bug.
//   2. DOUBLE ERROR. The cost-cap and timeout paths emit a detailed `error`
//      frame and THEN throw, producing a second terse frame whose message is
//      just the bare code ("apify_cost_cap"). Last-write-wins overwrote the
//      useful sentence with the code. First error must win.
//
// Run: npx tsx tests/run-progress.test.ts

import {
  DISCOVERY_STEPS,
  ERROR_COPY,
  GENERIC_ERROR,
  STEP_LABELS,
  describeFilters,
  incompleteSteps,
  initialRunState,
  parseSseFrames,
  reduceRun,
  runPercent,
  type RunState,
  type SseFrame,
} from '../src/lib/run-progress';

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

/** Fold a list of frames over a fresh state, the way the component does. */
function run(frames: SseFrame[], state: RunState = initialRunState()): RunState {
  return frames.reduce(reduceRun, state);
}

function frame(event: string, data: Record<string, unknown>): SseFrame {
  return { event, data };
}

/** Encode frames the way the route writes them, for the parser tests. */
function wire(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── zero-creator run: completed, but not a success ──────────────────────────
{
  const state = run([
    frame('progress', { step: 'spotify', status: 'done' }),
    frame('progress', { step: 'queries', status: 'done' }),
    frame('progress', { step: 'apify', status: 'done' }),
    frame('progress', { step: 'normalize', status: 'done' }),
    frame('done', { campaign_id: 'c-1', total: 0 }),
  ]);
  assert(state.outcome?.kind === 'empty', 'zero creators → outcome "empty", not "found"');
  assert(state.outcome?.total === 0, 'zero creators → total 0 carried through');
  assert(state.error === '', 'zero creators is not an error — nothing failed');
  assert(state.running === false, 'zero creators → run is over');
}

{
  const state = run([frame('done', { campaign_id: 'c-1', total: 24 })]);
  assert(state.outcome?.kind === 'found', 'non-zero total → outcome "found"');
  assert(state.outcome?.total === 24, 'non-zero total carried through');
}

// A `done` frame with no `total` key at all must not be reported as success.
{
  const state = run([frame('done', { campaign_id: 'c-1' })]);
  assert(
    state.outcome?.kind === 'empty',
    'done with a missing total → "empty" (never assume creators were added)',
  );
}

// ── double error: the first, detailed frame wins ────────────────────────────
{
  const state = run([
    frame('progress', { step: 'apify', status: 'running' }),
    frame('error', {
      message: 'Discovery stopped at its spending cap',
      code: 'apify_cost_cap',
      after: 'apify',
    }),
    // The route throws immediately after, producing this terse duplicate.
    frame('error', { message: 'apify_cost_cap' }),
  ]);
  assert(
    state.error === ERROR_COPY.apify_cost_cap,
    `double error → first (mapped) message survives (got "${state.error}")`,
  );
  assert(
    state.error !== 'apify_cost_cap',
    'double error → bare code never reaches the screen',
  );
  assert(state.running === false, 'error ends the run');
}

// A raw code with no `code` field still must not surface untranslated as the
// *only* signal — an unmapped message passes through, but a missing one falls
// back to a sentence rather than an empty string.
{
  const state = run([frame('error', {})]);
  assert(state.error === GENERIC_ERROR, 'error with no message → generic sentence, never blank');
}

{
  const state = run([frame('error', { code: 'pipeline_timeout', message: 'timed out' })]);
  assert(
    state.error === ERROR_COPY.pipeline_timeout,
    'known code beats the route message',
  );
}

// Every mapped error must read as a sentence, not a code, and the daily-cap one
// must not tell the user to retry — retrying cannot work until the cap resets.
for (const [code, copy] of Object.entries(ERROR_COPY)) {
  assert(!copy.includes(code), `ERROR_COPY["${code}"] does not echo the raw code`);
  assert(/[.!]$/.test(copy), `ERROR_COPY["${code}"] is a sentence`);
}
assert(
  !/try (running it |it )?again/i.test(ERROR_COPY.daily_apify_cap_exceeded),
  'daily cap copy does not advise a retry that cannot succeed',
);

// ── steps left spinning are swept ───────────────────────────────────────────
{
  const state = run([
    frame('progress', { step: 'apify', status: 'running' }),
    frame('error', { code: 'pipeline_timeout' }),
  ]);
  assert(state.steps.apify.status === 'error', 'running step at error → marked error, not left spinning');
  assert(state.steps.spotify.status === 'pending', 'untouched steps stay pending');
}

// ── truncated stream: the reader ends with no done/error frame ──────────────
// CampaignProgress synthesises this frame itself when `reader.read()` reports
// done without either terminal event. Before, that case set `running:false` and
// nothing else: a bar frozen mid-run, one step spinning forever, no words.
{
  const state = run([
    frame('progress', { step: 'apify', status: 'done' }),
    frame('progress', { step: 'normalize', status: 'running' }),
    frame('error', { code: 'stream_truncated' }),
  ]);
  assert(state.error === ERROR_COPY.stream_truncated, 'truncation gets its own sentence');
  assert(state.running === false, 'truncation ends the run');
  assert(state.steps.normalize.status === 'error', 'the spinning step stops spinning');
  assert(state.steps.apify.status === 'done', 'steps that genuinely finished keep their result');
  assert(
    !state.error.toLowerCase().includes('failed'),
    'truncation does not claim the run failed — the outcome is unknown, not bad',
  );
}

// ── a step still running when `done` arrives did NOT finish ────────────────
//
// This block used to assert the opposite — that the sweep promoted a spinning
// step to 'done'. That was the bug, written down as a spec. The route's Step 6
// (qualification) catch used to only log a crash, then emit `done` anyway,
// so the sweep was turning "we never heard back" into a green check at 100%
// with "Added N creators" underneath. In front of a label the screen stated
// something false.
//
// All four of the other steps emit an explicit `progress {status:'done'}` of
// their own (Steps 1-4 in run/route.ts) and qualify is closed by the
// `qualification` event, so NOTHING legitimately depends on this sweep to go
// green. Sweeping to 'done' could only ever launder a failure.
{
  const state = run([
    frame('progress', { step: 'normalize', status: 'running' }),
    frame('done', { total: 3 }),
  ]);
  assert(
    state.steps.normalize.status === 'incomplete',
    `running step at done → 'incomplete', never 'done' (got "${state.steps.normalize.status}")`,
  );
  assert(
    !!state.steps.normalize.message,
    'an incomplete step says why it is incomplete',
  );
  assert(
    runPercent(state.steps) === 0,
    `an incomplete step does not count toward the bar (got ${runPercent(state.steps)}%)`,
  );
  assert(incompleteSteps(state.steps).length === 1, 'the incomplete step is reportable');
  assert(incompleteSteps(state.steps)[0] === 'normalize', 'and it is named');
}

// The real shape of the bug: the crash is in qualify, everything before it
// genuinely finished, and creators really were persisted.
{
  const state = run([
    ...DISCOVERY_STEPS.filter((s) => s !== 'qualify').map((s) =>
      frame('progress', { step: s, status: 'done' }),
    ),
    frame('progress', { step: 'qualify', status: 'running' }),
    // run/route.ts Step 6 throws here; its catch used to log and emit nothing.
    frame('done', { campaign_id: 'c-1', total: 24 }),
  ]);
  assert(
    state.steps.qualify.status === 'incomplete',
    `crashed qualify is not reported as complete (got "${state.steps.qualify.status}")`,
  );
  assert(
    runPercent(state.steps) === 80,
    `four of five steps finished → 80%, not 100% (got ${runPercent(state.steps)}%)`,
  );
  assert(state.outcome?.kind === 'found', 'the 24 persisted creators are still real and still reported');
  assert(state.running === false, 'the run is over either way');
}

// A clean run must NOT be dragged down by the fix.
{
  const state = run([
    ...DISCOVERY_STEPS.filter((s) => s !== 'qualify').map((s) =>
      frame('progress', { step: s, status: 'done' }),
    ),
    frame('qualification', { processed: 24, excluded: 5, llm_calls: 24 }),
    frame('done', { campaign_id: 'c-1', total: 24 }),
  ]);
  assert(runPercent(state.steps) === 100, 'a genuinely complete run still reads 100%');
  assert(incompleteSteps(state.steps).length === 0, 'and reports nothing incomplete');
}

// The route now announces the crash directly; inference is the fallback, not
// the mechanism.
{
  const state = run([
    frame('progress', { step: 'qualify', status: 'running' }),
    frame('progress', { step: 'qualify', status: 'error', message: 'Qualifying failed partway.' }),
    frame('done', { total: 24 }),
  ]);
  assert(state.steps.qualify.status === 'error', 'an explicit step error survives the done sweep');
  assert(
    state.steps.qualify.message === 'Qualifying failed partway.',
    'and keeps the message the route sent',
  );
  assert(incompleteSteps(state.steps).length === 0, "an errored step is not also 'incomplete'");
}

// Steps that never started stay pending — silence about a step we never
// reached is honest; claiming it failed is not.
{
  const state = run([
    frame('progress', { step: 'spotify', status: 'done' }),
    frame('done', { total: 0 }),
  ]);
  assert(state.steps.qualify.status === 'pending', 'a never-started step stays pending, not incomplete');
  assert(incompleteSteps(state.steps).length === 0, 'pending is not incomplete');
}

// ── qualify never sends a terminal "done" — `qualification` closes it ───────
{
  const state = run([
    frame('progress', { step: 'qualify', status: 'running' }),
    frame('qualification', { processed: 24, excluded: 5, llm_calls: 24 }),
  ]);
  assert(state.steps.qualify.status === 'done', 'qualification event closes the qualify step');
  assert(
    state.steps.qualify.message === 'Checked 24, ruled out 5 as a poor fit',
    `qualify message is plain language (got "${state.steps.qualify.message}")`,
  );
}

// ── the three events the old client dropped entirely ────────────────────────
{
  const state = run([
    frame('filtered', {
      total_apify: 118,
      kept: 24,
      filtered_total: 94,
      filtered_by_reason: { mass_follow: 51, no_content: 30, dead_account: 13 },
    }),
  ]);
  const filters = state.filters;
  assert(filters !== null, 'filtered event is not dropped');
  assert(filters?.scraped === 118 && filters?.kept === 24, 'filtered counts read');
  const sentence = filters ? describeFilters(filters) : '';
  assert(
    sentence ===
      'Reviewed 118 creators, kept 24. Screened out 94: 51 follow-for-follow accounts, 30 no recent posts, 13 inactive accounts.',
    `filtered renders as a sentence with reasons ordered by size (got "${sentence}")`,
  );
  assert(!sentence.includes('mass_follow'), 'filter reason codes never reach the screen');
}

{
  const state = run([
    frame('progress', { step: 'normalize', status: 'running', message: 'Scoring 24 creators' }),
    frame('contacts', { processed: 24, emails_found: 11, llm_calls: 6 }),
  ]);
  assert(
    state.steps.normalize.message === 'Scoring 24 creators · Contact details found for 11 of 24',
    `contacts event appends to the normalize step (got "${state.steps.normalize.message}")`,
  );
}

// ── progress percent tracks all five steps, not a hardcoded four ────────────
{
  assert(DISCOVERY_STEPS.length === 5, 'the route has five steps');
  const oneDone = run([frame('progress', { step: 'spotify', status: 'done' })]);
  assert(runPercent(oneDone.steps) === 20, `1/5 done → 20% (got ${runPercent(oneDone.steps)})`);
  const all = run(DISCOVERY_STEPS.map((s) => frame('progress', { step: s, status: 'done' })));
  assert(runPercent(all.steps) === 100, 'all five done → 100%');
}

// ── no vendor name or snake_case id is renderable ───────────────────────────
for (const step of DISCOVERY_STEPS) {
  const label = STEP_LABELS[step];
  assert(!!label, `step "${step}" has a label`);
  assert(!/_/.test(label), `step label "${label}" has no snake_case`);
  assert(
    !/apify|spotify|openai|gemini/i.test(label),
    `step label "${label}" names no vendor`,
  );
}

// ── unknown frames and malformed steps are inert, never crashes ─────────────
{
  const before = initialRunState();
  const after = run(
    [
      frame('heartbeat', {}),
      frame('progress', { step: 'not_a_step', status: 'done' }),
      frame('progress', { status: 'done' }),
    ],
    before,
  );
  assert(JSON.stringify(after) === JSON.stringify(before), 'unknown event / bad step → state unchanged');
}

// ── SSE framing ─────────────────────────────────────────────────────────────
{
  const buf = wire('progress', { step: 'spotify', status: 'done' }) + wire('done', { total: 2 });
  const { frames, rest } = parseSseFrames(buf);
  assert(frames.length === 2, `two complete frames parsed (got ${frames.length})`);
  assert(rest === '', 'no trailing partial when the buffer ends on a boundary');
}

{
  // A chunk that splits mid-frame must not lose the frame.
  const full = wire('done', { total: 7 });
  const cut = Math.floor(full.length / 2);
  const first = parseSseFrames(full.slice(0, cut));
  assert(first.frames.length === 0, 'half a frame yields nothing yet');
  const second = parseSseFrames(first.rest + full.slice(cut));
  assert(second.frames.length === 1, 'the frame arrives once the rest of the chunk does');
  assert(Number(second.frames[0].data.total) === 7, 'split frame reassembles with its payload intact');
}

{
  const { frames } = parseSseFrames('event: progress\ndata: {not json}\n\n' + wire('done', { total: 1 }));
  assert(frames.length === 1, 'a malformed frame is dropped, the stream survives');
  assert(frames[0].event === 'done', 'the good frame after a malformed one still lands');
}

// ── a realistic full run, end to end ────────────────────────────────────────
{
  const state = run([
    frame('progress', { step: 'spotify', status: 'running' }),
    frame('progress', { step: 'spotify', status: 'done', message: 'Found artist context' }),
    frame('progress', { step: 'queries', status: 'done' }),
    frame('progress', { step: 'apify', status: 'running' }),
    frame('filtered', {
      total_apify: 60,
      kept: 40,
      filtered_total: 20,
      filtered_by_reason: { mass_follow: 20 },
    }),
    frame('progress', { step: 'apify', status: 'done' }),
    frame('progress', { step: 'normalize', status: 'running' }),
    frame('contacts', { processed: 40, emails_found: 18 }),
    frame('progress', { step: 'normalize', status: 'done' }),
    frame('progress', { step: 'qualify', status: 'running' }),
    frame('qualification', { processed: 40, excluded: 16 }),
    frame('done', { campaign_id: 'c-1', total: 24 }),
  ]);
  assert(state.outcome?.kind === 'found' && state.outcome.total === 24, 'full run ends "found" with 24');
  assert(state.error === '', 'full run has no error');
  assert(state.running === false, 'full run is finished');
  assert(runPercent(state.steps) === 100, 'full run reaches 100%');
  assert(
    DISCOVERY_STEPS.every((s) => state.steps[s].status === 'done'),
    'every step ends "done" — including qualify, which never sends one',
  );
}

console.log(`run-progress test: ${passed} passed, ${failed} failed`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
