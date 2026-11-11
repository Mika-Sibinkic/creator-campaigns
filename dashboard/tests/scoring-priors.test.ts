// tests/scoring-priors.test.ts
//
// The learning write-back: the firm's observed per-channel reply rate
// (channel_conversion_priors) rescaling the response-likelihood component of
// src/lib/scoring.ts. Until this existed the counters were written and read for
// routing but never changed a SCORE — the loop recorded outcomes and did
// nothing with them.
//
// Hermetic and pure: scoring.ts does no I/O, so there is nothing to stub.
//
// Proves:
//   1. COLD-START SAFE. No priors, empty priors, an untracked channel, a
//      channel with zero OBSERVED sends, and pre-043 rows with no observed
//      columns at all return the heuristic byte-for-byte.
//   1b. REGRESSION (review finding B1): the migration-020 cold-start SEED
//      (sent=100 per channel, "a starting guess, not measured data") must
//      never drive the blend. It used to pin confidence at 1.0 from run one.
//   2. A channel that out-performs the firm's pooled reply rate scores HIGHER;
//      one that under-performs scores LOWER. Direction is not an accident.
//   3. The n/30 confidence ramp (rl-pricing.ts:106) governs how far the
//      observed rate may move the heuristic: the same ratio with 6 sends moves
//      a fifth as far as with 30.
//   4. Laplace smoothing stops a lucky thin sample from taking over — 1 send /
//      1 reply is a 100% observed rate and moves the score by one point.
//   5. The swing is clamped to ±50%, so no channel can zero out or double a
//      score however lopsided the counters get, and output stays in [0,100].
//   6. DETERMINISTIC — same inputs, same output, every time. No clock, no rng.
//   7. The blend reaches the composite (and therefore the ranking), moving
//      nothing else in the breakdown.
//
// Run: npx tsx tests/scoring-priors.test.ts

import {
  blendResponseLikelihood,
  scoreInfluencers,
  scoringChannelFor,
  RESPONSE_PRIOR_FULL_CONFIDENCE_N,
  RESPONSE_PRIOR_MAX_SWING,
  type ChannelReplyPrior,
} from '../src/lib/scoring';

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

const STATIC = 60;

/**
 * The exact migration-020 cold-start seed
 * (email 100/8, instagram_dm 100/3, tiktok_dm 100/2).
 * Every fixture below carries these in the LEGACY columns, so each assertion
 * also proves the seed was ignored.
 */
const SEED: Record<string, { sent: number; replies: number }> = {
  email: { sent: 100, replies: 8 },
  instagram_dm: { sent: 100, replies: 3 },
  tiktok_dm: { sent: 100, replies: 2 },
};

/** A prior row: seeded legacy counters, plus whatever was actually observed. */
function prior(
  channel: string,
  observed_sent: number,
  observed_replies: number,
  observed_deals = 0,
): ChannelReplyPrior {
  const seed = SEED[channel] ?? { sent: 100, replies: 5 };
  return {
    channel,
    sent: seed.sent,
    replies: seed.replies,
    deals: 0,
    observed_sent,
    observed_replies,
    observed_deals,
  };
}

/** Production on day one: seeded rows, nothing observed. */
const SEED_ONLY: ChannelReplyPrior[] = [
  prior('email', 0, 0),
  prior('instagram_dm', 0, 0),
  prior('tiktok_dm', 0, 0),
];

// TikTok DMs beat Instagram DMs badly for this firm, on 6 OBSERVED sends each.
const THIN: ChannelReplyPrior[] = [prior('tiktok_dm', 6, 2), prior('instagram_dm', 6, 0)];
// The same shape of difference, on 30 observed sends each — full confidence.
const THICK: ChannelReplyPrior[] = [prior('tiktok_dm', 30, 10, 2), prior('instagram_dm', 30, 0)];

const profile = (over: Record<string, unknown> = {}) => ({
  username: 'raemakes_example',
  platform: 'tiktok',
  display_name: 'Rae',
  followers: 12_000,
  engagement_rate: 0.05,
  bio: 'dance creator, collab inquiries in bio, booking via linktree',
  verified: false,
  video_count: 40,
  has_contact_info: false,
  contact_email: null,
  ...over,
});

const CTX = { genre: 'pop', target_platforms: ['tiktok'], artist_name: 'Ada Sample' };

// ── 1. Cold start returns the heuristic untouched ───────────────────────────

function scenarioColdStart() {
  const base = scoreInfluencers([profile()], CTX).ranked_influencers[0];

  for (const [label, priors] of [
    ['undefined priors', undefined],
    ['null priors', null],
    ['empty priors', [] as ChannelReplyPrior[]],
    // Creator is tiktok → tiktok_dm; only email has observed history.
    ['untracked channel', [prior('email', 500, 200, 40)]],
    // Row exists but nothing was ever OBSERVED on it.
    ['zero-observed channel', [prior('tiktok_dm', 0, 0), prior('email', 500, 200, 40)]],
    // THE DEFECT THIS GUARDS: migration 020 seeds sent=100 per channel and
    // calls it a starting guess. Blending on `sent` would read that as full
    // confidence and rescale every score from run one.
    ['migration-020 seed only', SEED_ONLY],
    // A pre-043 read cannot select observed_* at all — absent, not zero.
    [
      'pre-043 rows (no observed columns)',
      [
        { channel: 'tiktok_dm', sent: 100, replies: 2, deals: 0 },
        { channel: 'email', sent: 100, replies: 8, deals: 0 },
      ],
    ],
  ] as Array<[string, ChannelReplyPrior[] | null | undefined]>) {
    const got = scoreInfluencers([profile()], CTX, { priors }).ranked_influencers[0];
    assert(
      JSON.stringify(got.score_breakdown) === JSON.stringify(base.score_breakdown),
      `cold start (${label}): breakdown identical to the pre-blend heuristic`,
    );
    assert(got.composite_score === base.composite_score, `cold start (${label}): composite unchanged`);
  }

  // And the direct helper agrees.
  assert(blendResponseLikelihood(STATIC, 'tiktok_dm', []) === STATIC, 'cold start: empty priors are a no-op');
  assert(blendResponseLikelihood(STATIC, null, THICK) === STATIC, 'cold start: null channel is a no-op');
  assert(
    blendResponseLikelihood(STATIC, 'email', THICK) === STATIC,
    'cold start: a channel with no row is a no-op',
  );
}

// ── 1b. REGRESSION: the migration-020 seed must never drive the blend ───────
//
// Review finding B1. The ramp originally counted `sent`, which migration 020
// seeds to 100 per channel while explicitly calling it a STARTING GUESS. That
// made confidence = min(1, 100/30) = 1.0 from the first discovery run on every
// firm, so the blend ran at FULL strength against three numbers nobody
// measured. Against the 020 seed that is a 0.68x multiplier on tiktok_dm —
// a static 80 becomes 55 and a static 60 becomes 41 — and 1.5x on email.
//
// The ramp now counts observed_sent, which starts at 0 and is written only by
// real funnel events, so the seed alone is inert.

function scenarioSeedNeverDrivesTheBlend() {
  for (const channel of ['email', 'instagram_dm', 'tiktok_dm']) {
    for (const score of [0, 41, 60, 80, 100]) {
      const got = blendResponseLikelihood(score, channel, SEED_ONLY);
      assert(
        got === score,
        `seed-only ${channel}: ${score} stays ${score}, not rescaled (got ${got})`,
      );
    }
  }

  // The specific numbers the review computed must NOT occur.
  assert(
    blendResponseLikelihood(80, 'tiktok_dm', SEED_ONLY) !== 55,
    'seed-only: a static 80 on tiktok_dm is NOT dragged to 55',
  );
  assert(
    blendResponseLikelihood(60, 'tiktok_dm', SEED_ONLY) !== 41,
    'seed-only: a static 60 on tiktok_dm is NOT dragged to 41',
  );
  assert(
    blendResponseLikelihood(80, 'email', SEED_ONLY) !== 100,
    'seed-only: a static 80 on email is NOT inflated to 100',
  );

  // A seeded row with ONE real send ramps from 1/30, not from 101/30.
  const oneRealSend = [prior('tiktok_dm', 1, 1), prior('email', 1, 0)];
  const nudged = blendResponseLikelihood(60, 'tiktok_dm', oneRealSend);
  assert(
    Math.abs(nudged - 60) <= 1,
    `one real send nudges by at most a point, not a third of the score (got ${nudged})`,
  );

  // And a firm with real volume is unaffected by how large the seed is: the
  // legacy columns differ wildly here, the observed ones do not.
  const seedHeavy = THICK.map((r) => ({ ...r, sent: 99_999, replies: 0 }));
  assert(
    blendResponseLikelihood(STATIC, 'tiktok_dm', seedHeavy) ===
      blendResponseLikelihood(STATIC, 'tiktok_dm', THICK),
    'the legacy seed columns cannot influence the result at all',
  );
}

// ── 2-3. Direction, and the n/30 confidence ramp ────────────────────────────

function scenarioDirectionAndRamp() {
  // THICK: tiktok observed (10+1)/(30+2)=0.34375 vs pooled (10+1)/(60+2)=0.17742
  // → ratio 1.94, clamped to 1.5; confidence 30/30 = 1 → static × 1.5.
  const upThick = blendResponseLikelihood(STATIC, 'tiktok_dm', THICK);
  assert(upThick === 90, `over-performing channel at full confidence: 60 → 90 (got ${upThick})`);

  // instagram observed (0+1)/32=0.03125 → ratio 0.176, clamped to 0.5 → × 0.5.
  const downThick = blendResponseLikelihood(STATIC, 'instagram_dm', THICK);
  assert(downThick === 30, `under-performing channel at full confidence: 60 → 30 (got ${downThick})`);
  assert(upThick > STATIC && downThick < STATIC, 'direction: better channel up, worse channel down');

  // THIN: same clamped ratio 1.5, but confidence 6/30 = 0.2
  // → 0.8×60 + 0.2×90 = 66.
  const upThin = blendResponseLikelihood(STATIC, 'tiktok_dm', THIN);
  assert(upThin === 66, `same ratio on 6 sends moves a fifth as far: 60 → 66 (got ${upThin})`);
  assert(
    Math.abs(upThin - STATIC) * 5 === Math.abs(upThick - STATIC),
    'ramp: the move scales linearly with min(1, sent/30)',
  );
  assert(RESPONSE_PRIOR_FULL_CONFIDENCE_N === 30, 'ramp: the house n/30 constant');

  // Past n=30 confidence saturates — it never over-shoots.
  const saturated = blendResponseLikelihood(STATIC, 'tiktok_dm', [
    prior('tiktok_dm', 3000, 1000, 200),
    prior('instagram_dm', 3000, 0),
  ]);
  assert(saturated === 90, `confidence saturates at 1: still 90 (got ${saturated})`);
}

// ── 4. Laplace smoothing survives a thin lucky sample ───────────────────────

function scenarioLaplaceSmoothing() {
  // One send, one reply: a raw 100% reply rate against a firm baseline of ~6%.
  const lucky = blendResponseLikelihood(STATIC, 'tiktok_dm', [
    prior('tiktok_dm', 1, 1),
    prior('email', 100, 5, 1),
  ]);
  assert(
    lucky === 61,
    `one lucky reply moves the score by a single point, not forty (got ${lucky})`,
  );

  // One send, zero replies is equally weak evidence in the other direction.
  const unlucky = blendResponseLikelihood(STATIC, 'tiktok_dm', [
    prior('tiktok_dm', 1, 0),
    prior('email', 100, 40, 8),
  ]);
  assert(
    Math.abs(unlucky - STATIC) <= 1,
    `one silent send barely moves the score (got ${unlucky}, expected within 1 of ${STATIC})`,
  );
}

// ── 5. Clamped swing, and the 0-100 range ───────────────────────────────────

function scenarioClampAndRange() {
  assert(RESPONSE_PRIOR_MAX_SWING === 0.5, 'clamp: ±50% is the declared ceiling');

  // Grotesquely lopsided counters cannot exceed the swing.
  const absurdUp = blendResponseLikelihood(STATIC, 'tiktok_dm', [
    prior('tiktok_dm', 1000, 1000, 500),
    prior('instagram_dm', 100_000, 0),
  ]);
  assert(absurdUp === 90, `clamp: a perfect channel still caps at ×1.5 (got ${absurdUp})`);

  const absurdDown = blendResponseLikelihood(STATIC, 'instagram_dm', [
    prior('tiktok_dm', 1000, 1000, 500),
    prior('instagram_dm', 100_000, 0),
  ]);
  assert(absurdDown === 30, `clamp: a dead channel still floors at ×0.5 (got ${absurdDown})`);

  // Range holds at the extremes of the input scale.
  assert(blendResponseLikelihood(100, 'tiktok_dm', THICK) === 100, 'range: never exceeds 100');
  assert(blendResponseLikelihood(0, 'tiktok_dm', THICK) === 0, 'range: 0 stays 0');
  assert(blendResponseLikelihood(0, 'instagram_dm', THICK) === 0, 'range: never goes below 0');

  // Negative / malformed counters cannot produce a negative rate.
  const junk = blendResponseLikelihood(STATIC, 'tiktok_dm', [
    prior('tiktok_dm', 10, -5, -2),
    prior('email', 10, 5, 1),
  ]);
  assert(junk >= 0 && junk <= 100, `malformed counters stay in range (got ${junk})`);
}

// ── 6. Determinism ──────────────────────────────────────────────────────────

function scenarioDeterminism() {
  const runs = Array.from({ length: 5 }, () =>
    JSON.stringify(scoreInfluencers([profile()], CTX, { priors: THICK }).ranked_influencers[0]),
  );
  assert(new Set(runs).size === 1, 'deterministic: five identical runs produce one result');

  const direct = Array.from({ length: 5 }, () => blendResponseLikelihood(STATIC, 'tiktok_dm', THIN));
  assert(new Set(direct).size === 1, 'deterministic: the helper is pure');
}

// ── 7. It reaches the composite, and moves nothing else ─────────────────────

function scenarioReachesTheRanking() {
  const base = scoreInfluencers([profile()], CTX).ranked_influencers[0];
  const down = scoreInfluencers([profile({ platform: 'instagram' })], CTX, { priors: THICK })
    .ranked_influencers[0];
  const baseIg = scoreInfluencers([profile({ platform: 'instagram' })], CTX).ranked_influencers[0];

  assert(
    down.score_breakdown.response_likelihood < baseIg.score_breakdown.response_likelihood,
    'write-back: a weak channel lowers the response-likelihood component',
  );
  assert(down.composite_score < baseIg.composite_score, 'write-back: the composite moves, so the RANKING moves');

  // Everything else is untouched — this changes one component, not the formula.
  for (const k of ['engagement_quality', 'content_relevance', 'audience_fit', 'bot_risk_inverse', 'trust_score'] as const) {
    assert(
      down.score_breakdown[k] === baseIg.score_breakdown[k],
      `write-back: ${k} is untouched by the blend`,
    );
  }
  // 10% weight: the composite moves by a tenth of the component move (±1 rounding).
  const componentDelta = baseIg.score_breakdown.response_likelihood - down.score_breakdown.response_likelihood;
  const compositeDelta = baseIg.composite_score - down.composite_score;
  assert(
    Math.abs(compositeDelta - componentDelta * 0.1) <= 1,
    `write-back: composite moved ${compositeDelta} for a component move of ${componentDelta} (10% weight)`,
  );

  // The creator's channel is the one the run route would stamp.
  assert(scoringChannelFor({ platform: 'tiktok' }) === 'tiktok_dm', 'channel: tiktok → tiktok_dm');
  assert(scoringChannelFor({ platform: 'instagram' }) === 'instagram_dm', 'channel: instagram → instagram_dm');
  assert(
    scoringChannelFor({ platform: 'tiktok', contact_email: 'rae@example.com' }) === 'email',
    'channel: a known email wins, mirroring the run route primary_channel stamp',
  );
  assert(scoringChannelFor({ platform: 'youtube' }) === null, 'channel: untracked platform → null');
  assert(scoringChannelFor({ platform: null }) === null, 'channel: missing platform → null');
  void base;
}

function main() {
  scenarioColdStart();
  scenarioSeedNeverDrivesTheBlend();
  scenarioDirectionAndRamp();
  scenarioLaplaceSmoothing();
  scenarioClampAndRange();
  scenarioDeterminism();
  scenarioReachesTheRanking();

  console.log(`scoring-priors test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main();
