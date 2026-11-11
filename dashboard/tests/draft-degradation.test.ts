// tests/draft-degradation.test.ts
//
// What happens to a draft run when the MODEL LAYER ITSELF fails.
//
// Before the fix the answer was "nothing gets produced": the deterministic
// `fallbackDraft` in src/lib/openai.ts was only reachable when the model
// answered and its COPY failed validation. A provider exception (e.g. a
// free-tier 429 storm) propagated straight out of generateOutreachDraft, so
// nearly every creator in the run got no draft at all.
//
// The contract now:
//   - model answers, copy is clean          → source 'model'
//   - model answers, copy fails twice       → deterministic fallback
//   - model layer throws (all providers)    → deterministic fallback
//   - deterministic fallback itself fails the copy validator → THROW.
//     Degrading must never mean shipping copy the validator rejects.
//   - every fallback is marked so an operator can tell it from model copy.
//
// Fully hermetic: providers are registered mocks, no network, no DB.
//
// Run: npx tsx tests/draft-degradation.test.ts

process.env.MODEL_PROVIDER = 'mock-draft';
// No ambient failover: a developer shell with a real OPENAI_API_KEY must not
// turn this suite into a live API call.
process.env.MODEL_FALLBACK_CHAIN = '';

import { registerProvider } from '../src/lib/model-provider';
import {
  generateOutreachDraft,
  checkDraftCopy,
  FALLBACK_DRAFT_MODEL,
  FALLBACK_DRAFT_TEMPLATE,
  MODEL_DRAFT_TEMPLATE,
  type DraftPersonalizationInput,
} from '../src/lib/openai';

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

/** Silence the expected [model-provider] failover warnings while a case runs. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = realWarn;
  }
}

const baseInput: DraftPersonalizationInput = {
  firmVoice: 'Warm, specific, no buzzwords.',
  artistName: 'Ada Sample',
  trackName: 'Glass Harbor',
  personality: 'direct',
  creator: { handle: 'demo.beats_example', bio: 'sync licensing nerd', recentPosts: [] },
};

function httpError(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

async function main() {
  // ── 1. Happy path: clean model copy is used and labelled 'model' ──────────
  let modelCallCount = 0;
  registerProvider('mock-draft', async () => {
    modelCallCount++;
    return JSON.stringify({
      subject: 'Paid post for Glass Harbor?',
      body: "Hi @demo.beats_example,\n\nYour sync breakdowns are sharp. We're putting Glass Harbor from Ada Sample out and think your audience would take to it.\n\nOpen to a paid post? Happy to talk details.\n\nOwen",
    });
  });

  const clean = await generateOutreachDraft(baseInput);
  assert(clean.source === 'model', `clean model copy is sourced 'model' (got: ${clean.source})`);
  assert(clean.modelCalls === 1, `clean path makes exactly one model call (got: ${clean.modelCalls})`);
  assert(clean.subject === 'Paid post for Glass Harbor?', 'model subject is returned verbatim');
  assert(clean.degradedReason === undefined, 'a model draft carries no degradedReason');
  assert(
    checkDraftCopy({
      subject: clean.subject,
      body: clean.body,
      artistName: baseInput.artistName,
      trackName: baseInput.trackName,
      creatorBio: baseInput.creator.bio,
      creatorIsAuthor: true,
      releasePast: false,
    }).length === 0,
    'the returned model draft actually passes the validator',
  );

  // ── 2. THE 429-STORM CASE: every provider 429s ────────────────────────────
  // This is the regression. Before the fix this threw and produced nothing.
  modelCallCount = 0;
  registerProvider('mock-draft', async () => {
    modelCallCount++;
    throw httpError(429, 'Rate limit reached: quota exceeded for gemini-2.0-flash');
  });

  const stormed = await quiet(() => generateOutreachDraft(baseInput));
  assert(
    stormed.source === 'fallback',
    `a 429 storm degrades to the deterministic draft instead of throwing (got: ${stormed.source})`,
  );
  assert(
    stormed.modelCalls === 0,
    `no model output was received, so modelCalls is 0 (got: ${stormed.modelCalls})`,
  );
  assert(stormed.subject.length > 0 && stormed.body.length > 0, 'the degraded draft has real copy');
  assert(
    stormed.body.includes('@demo.beats_example') && stormed.body.includes('Ada Sample'),
    'the degraded draft still addresses the right creator and artist',
  );
  assert(
    /429|rate limit|quota/i.test(stormed.degradedReason ?? ''),
    `degradedReason names the provider failure (got: ${stormed.degradedReason})`,
  );
  assert(
    modelCallCount === 1,
    `the model is not re-prompted after the provider chain is exhausted (got ${modelCallCount} calls)`,
  );

  // ── 3. The degraded draft must itself pass the copy validator ─────────────
  assert(
    checkDraftCopy({
      subject: stormed.subject,
      body: stormed.body,
      artistName: baseInput.artistName,
      trackName: baseInput.trackName,
      creatorBio: baseInput.creator.bio,
      creatorIsAuthor: true,
      releasePast: false,
    }).length === 0,
    'the deterministic fallback passes the same validator model copy must pass',
  );

  // ── 4. Model answers but its copy is unusable twice → fallback ────────────
  modelCallCount = 0;
  registerProvider('mock-draft', async () => {
    modelCallCount++;
    return JSON.stringify({
      subject: 'So excited about this',
      body: 'Hi @demo.beats_example, we are thrilled about your recent videos — they really resonate.',
    });
  });
  const dirty = await generateOutreachDraft(baseInput);
  assert(dirty.source === 'fallback', 'copy that fails validation twice degrades to the fallback');
  assert(
    dirty.modelCalls === 2,
    `both retries are counted as real model calls (got: ${dirty.modelCalls})`,
  );
  assert(
    /banned phrase/i.test(dirty.degradedReason ?? ''),
    `degradedReason explains the copy rejection (got: ${dirty.degradedReason})`,
  );
  assert(!dirty.body.includes('thrilled'), 'the rejected model copy is not what gets returned');

  // ── 5. Empty model output → fallback, and it is not counted as usable ─────
  registerProvider('mock-draft', async () => JSON.stringify({ subject: '', body: '' }));
  const empty = await generateOutreachDraft(baseInput);
  assert(empty.source === 'fallback', 'empty model output degrades to the fallback');
  assert(
    /empty/i.test(empty.degradedReason ?? ''),
    `degradedReason names the empty output (got: ${empty.degradedReason})`,
  );

  // ── 6. THE GATE: a fallback that fails the validator must NOT ship ────────
  // Failure class: the creator's own quoted
  // title sitting next to the promoted artist reads as misattribution. When the
  // track name collides with a title quoted in the creator's bio, the
  // deterministic copy produces exactly that — so it must be refused, not sent.
  registerProvider('mock-draft', async () => {
    throw httpError(503, 'Service Unavailable');
  });
  const colliding: DraftPersonalizationInput = {
    ...baseInput,
    trackName: 'Glass Harbor',
    creator: {
      handle: 'demo.beats_example',
      bio: 'producer, known for "Glass Harbor"',
      recentPosts: [],
    },
  };
  let gateErr = '';
  try {
    await quiet(() => generateOutreachDraft(colliding));
  } catch (e) {
    gateErr = (e as Error).message;
  }
  assert(gateErr.length > 0, 'a fallback that fails the copy validator throws instead of shipping');
  assert(
    /fallback/i.test(gateErr) && /valid/i.test(gateErr),
    `the gate error explains that the fallback was rejected (got: ${gateErr})`,
  );
  assert(
    /503|unavailable/i.test(gateErr),
    `the gate error still carries the underlying provider failure (got: ${gateErr})`,
  );

  // ── 7. Fallbacks stay reachable when the provenance guard also has no model ─
  // pickSafeReference() runs BEFORE the draft loop and calls the model too. It
  // must not strand the draft when every provider is down.
  registerProvider('mock-draft', async () => {
    throw httpError(500, 'internal error');
  });
  const withPosts: DraftPersonalizationInput = {
    ...baseInput,
    creator: {
      handle: 'demo.beats_example',
      bio: 'sync licensing nerd',
      recentPosts: [{ hook: 'three ways to layer a pad', views: 40_000, hashtags: ['synth'] }],
    },
  };
  const stranded = await quiet(() => generateOutreachDraft(withPosts));
  assert(
    stranded.source === 'fallback',
    'a total outage during the provenance check still yields a deterministic draft',
  );

  // ── 8. The marking constants an operator greps for ────────────────────────
  assert(
    FALLBACK_DRAFT_MODEL === 'deterministic-fallback',
    `fallback rows are identifiable by generation_model (got: ${FALLBACK_DRAFT_MODEL})`,
  );
  assert(
    FALLBACK_DRAFT_TEMPLATE === 'initial_email_fallback_v1',
    `fallback rows are identifiable by template_used (got: ${FALLBACK_DRAFT_TEMPLATE})`,
  );
  // Widened to string[] deliberately: as literal types TS proves these unequal,
  // which makes a direct comparison a no-op. This guards the real risk — a
  // later edit collapsing two markers onto the same value.
  const markers: string[] = [FALLBACK_DRAFT_MODEL, FALLBACK_DRAFT_TEMPLATE, MODEL_DRAFT_TEMPLATE];
  assert(
    new Set(markers).size === 3,
    `model and fallback markers stay distinct (got: ${markers.join(', ')})`,
  );

  console.log(`draft-degradation test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
