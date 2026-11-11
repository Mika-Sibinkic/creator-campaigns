/**
 * Scoring Regression Tests v1.0
 *
 * Runs fixture profiles through the scoring algorithm and validates:
 * - Bot accounts always rank below non-bots
 * - Tier assignments are monotonically ordered by score
 * - Known profiles meet expected score thresholds
 * - Bot detection flags fire on known bot profiles
 *
 * Run: npx tsx tests/scoring-regression.test.ts
 */

import { scoreInfluencers } from "../src/lib/scoring";
import { detectBot } from "../src/lib/bot-detection";
import { readFileSync } from "fs";
import { resolve } from "path";

const fixtureData = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/scoring_regression.json"), "utf-8")
);

const profiles = fixtureData.profiles;
const campaignContext = fixtureData.campaign_context;

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

// --- Run scoring ---
const result = scoreInfluencers(
  profiles.map((p: Record<string, unknown>) => {
    // Strip test metadata
    const { _test_id, _expected, ...profile } = p;
    return profile;
  }),
  campaignContext
);

const ranked = result.ranked_influencers;

console.log(`\n=== Creator Campaigns Scoring Regression Tests ===`);
console.log(`Scored ${ranked.length} profiles\n`);
console.log(`Summary: ${result.scoring_summary.tier_a_count}A / ${result.scoring_summary.tier_b_count}B / ${result.scoring_summary.tier_c_count}C / ${result.scoring_summary.bot_flagged_count} bot-flagged\n`);

// --- Invariant 1: Bot-flagged profiles rank below all non-bot profiles ---
console.log("--- Invariant: Bot accounts rank last ---");
const lastNonBotIdx = ranked.reduce(
  (max, inf, idx) => (!inf.bot_flagged ? Math.max(max, idx) : max),
  -1
);
const firstBotIdx = ranked.findIndex((inf) => inf.bot_flagged);

if (firstBotIdx !== -1 && lastNonBotIdx !== -1) {
  assert(
    firstBotIdx > lastNonBotIdx,
    `First bot (idx ${firstBotIdx}: ${ranked[firstBotIdx]?.username}) must appear after last non-bot (idx ${lastNonBotIdx}: ${ranked[lastNonBotIdx]?.username})`
  );
} else if (firstBotIdx === -1) {
  console.log("  ⚠ No bot-flagged profiles in results — skipping rank check");
} else {
  assert(true, "All profiles are bot-flagged or no non-bots present");
}

// --- Invariant 2: Tier ordering (within non-bot set) ---
console.log("\n--- Invariant: Tier scores are monotonically ordered ---");
const nonBots = ranked.filter((inf) => !inf.bot_flagged);
const tierAScores = nonBots.filter((inf) => inf.tier === "A").map((inf) => inf.composite_score);
const tierBScores = nonBots.filter((inf) => inf.tier === "B").map((inf) => inf.composite_score);
const tierCScores = nonBots.filter((inf) => inf.tier === "C").map((inf) => inf.composite_score);

const minA = tierAScores.length > 0 ? Math.min(...tierAScores) : Infinity;
const maxB = tierBScores.length > 0 ? Math.max(...tierBScores) : -Infinity;
const minB = tierBScores.length > 0 ? Math.min(...tierBScores) : Infinity;
const maxC = tierCScores.length > 0 ? Math.max(...tierCScores) : -Infinity;

if (tierAScores.length > 0 && tierBScores.length > 0) {
  assert(minA >= maxB, `Min Tier A score (${minA}) must >= max Tier B score (${maxB})`);
}
if (tierBScores.length > 0 && tierCScores.length > 0) {
  assert(minB >= maxC, `Min Tier B score (${minB}) must >= max Tier C score (${maxC})`);
}

// --- Invariant 3: Per-profile expected values ---
console.log("\n--- Invariant: Per-profile expected values ---");
for (const fixtureProfile of profiles) {
  const testId = fixtureProfile._test_id;
  const expected = fixtureProfile._expected;
  if (!expected) continue;

  const scored = ranked.find(
    (inf: { username: string }) => inf.username === fixtureProfile.username
  );
  if (!scored) {
    assert(false, `${testId}: profile "${fixtureProfile.username}" not found in results`);
    continue;
  }

  if (expected.bot_flagged !== undefined) {
    assert(
      scored.bot_flagged === expected.bot_flagged,
      `${testId} (${scored.username}): bot_flagged expected=${expected.bot_flagged}, got=${scored.bot_flagged} (prob=${scored.bot_detection.bot_probability})`
    );
  }

  if (expected.tier !== undefined) {
    assert(
      scored.tier === expected.tier,
      `${testId} (${scored.username}): tier expected=${expected.tier}, got=${scored.tier} (score=${scored.composite_score})`
    );
  }

  if (expected.min_score !== undefined) {
    assert(
      scored.composite_score >= expected.min_score,
      `${testId} (${scored.username}): score ${scored.composite_score} < min_score ${expected.min_score}`
    );
  }

  if (expected.max_score !== undefined) {
    assert(
      scored.composite_score <= expected.max_score,
      `${testId} (${scored.username}): score ${scored.composite_score} > max_score ${expected.max_score}`
    );
  }

  if (expected.min_trust_score !== undefined) {
    assert(
      scored.score_breakdown.trust_score >= expected.min_trust_score,
      `${testId} (${scored.username}): trust_score ${scored.score_breakdown.trust_score} < min_trust_score ${expected.min_trust_score}`
    );
  }

  if (expected.max_trust_score !== undefined) {
    assert(
      scored.score_breakdown.trust_score <= expected.max_trust_score,
      `${testId} (${scored.username}): trust_score ${scored.score_breakdown.trust_score} > max_trust_score ${expected.max_trust_score}`
    );
  }
}

// --- Invariant 3b: outreach angles never target music artists ---
// scoring.ts:generateOutreachAngle used to open its music branch with
// "Fellow music creator — ... propose collaboration", i.e. artist-to-artist
// framing aimed at exactly the accounts the pool should exclude. The pool
// now excludes artists at qualification; the angle copy for the music-adjacent
// creators that remain must never pitch a peer collaboration.
console.log("\n--- Invariant: No artist-collab framing in outreach angles ---");
for (const inf of ranked) {
  assert(
    !/fellow music creator/i.test(inf.outreach_angle),
    `${inf.username}: outreach_angle must not use "Fellow music creator" framing (got "${inf.outreach_angle}")`
  );
  assert(
    !/propose collaboration/i.test(inf.outreach_angle),
    `${inf.username}: outreach_angle must not propose an artist collaboration (got "${inf.outreach_angle}")`
  );
}

// --- Invariant 4: Bot detection signals fire correctly ---
console.log("\n--- Invariant: Bot detection signals ---");

// Repost farm should trigger noOriginalContent
const repostBot = profiles.find(
  (p: Record<string, unknown>) => p._test_id === "bot_repost_farm"
);
if (repostBot) {
  const detection = detectBot({
    username: repostBot.username,
    followers: repostBot.followers,
    engagement_rate: repostBot.engagement_rate,
    bio: repostBot.bio,
    verified: repostBot.verified,
    raw_data: repostBot.raw_data,
  });
  assert(
    detection.signals.noOriginalContent === true,
    `bot_repost_farm: noOriginalContent signal should fire (bio: "${repostBot.bio}")`
  );
}

// Random username bot should trigger randomUsername
const randomBot = profiles.find(
  (p: Record<string, unknown>) => p._test_id === "bot_random_username"
);
if (randomBot) {
  const detection = detectBot({
    username: randomBot.username,
    followers: randomBot.followers,
    engagement_rate: randomBot.engagement_rate,
    bio: randomBot.bio,
    verified: randomBot.verified,
    raw_data: randomBot.raw_data,
  });
  assert(
    detection.signals.randomUsername === true,
    `bot_random_username: randomUsername signal should fire (username: "${randomBot.username}")`
  );
  assert(
    detection.signals.engagementRateAnomaly === true,
    `bot_random_username: engagementRateAnomaly should fire (rate: ${randomBot.engagement_rate})`
  );
}

// Follow ratio bot should trigger low follower/following ratio
const followBot = profiles.find(
  (p: Record<string, unknown>) => p._test_id === "bot_follow_ratio"
);
if (followBot) {
  const detection = detectBot({
    username: followBot.username,
    followers: followBot.followers,
    engagement_rate: followBot.engagement_rate,
    bio: followBot.bio,
    verified: followBot.verified,
    raw_data: followBot.raw_data,
  });
  assert(
    detection.signals.followerFollowingRatio !== null &&
      detection.signals.followerFollowingRatio < 0.1,
    `bot_follow_ratio: low follower/following ratio should be detected (ratio: ${detection.signals.followerFollowingRatio})`
  );
}

// --- Invariant 5: High-engagement anomaly detection ---
console.log("\n--- Invariant: Engagement anomaly detection ---");
const highEngProfiles = profiles.filter(
  (p: Record<string, unknown>) => (p.engagement_rate as number) > 0.80
);
for (const p of highEngProfiles) {
  const detection = detectBot({
    username: p.username,
    followers: p.followers,
    engagement_rate: p.engagement_rate,
    bio: p.bio,
    verified: p.verified,
    raw_data: p.raw_data,
  });
  assert(
    detection.signals.engagementRateAnomaly === true,
    `${p._test_id} (${p.username}): engagement ${p.engagement_rate} > 0.80 should trigger anomaly`
  );
}

// --- Invariant 6: Trust score dimension (S3.1) ---
console.log("\n--- Invariant: Trust score ordering ---");

// Every scored profile carries a finite trust_score in [0, 100] — no NaN,
// no undefined, regardless of how sparse the input raw_data is.
for (const inf of ranked) {
  const t = inf.score_breakdown.trust_score;
  assert(
    Number.isFinite(t) && t >= 0 && t <= 100,
    `${inf.username}: trust_score must be a finite 0-100 number, got ${t}`
  );
}

function trustOf(testId: string): number | null {
  const fixture = profiles.find(
    (p: Record<string, unknown>) => p._test_id === testId
  );
  if (!fixture) return null;
  const scored = ranked.find((inf) => inf.username === fixture.username);
  return scored ? scored.score_breakdown.trust_score : null;
}

const trustEstablished = trustOf("trust_established_consistent");
const trustSpiky = trustOf("trust_new_spiky");
const trustNearMiss = trustOf("trust_botline_near_miss");

assert(
  trustEstablished !== null && trustSpiky !== null && trustNearMiss !== null,
  `trust fixtures must all be present and scored (established=${trustEstablished}, spiky=${trustSpiky}, near_miss=${trustNearMiss})`
);

if (trustEstablished !== null && trustSpiky !== null && trustNearMiss !== null) {
  // Established consistent creator outranks a suspiciously-new/spiky account
  // at equal followers (both 14K).
  assert(
    trustEstablished > trustSpiky,
    `established consistent account (${trustEstablished}) must out-trust new spiky account (${trustSpiky}) at equal followers`
  );
  // Spiky-but-plausible still outranks a bot-flag near-miss.
  assert(
    trustSpiky > trustNearMiss,
    `new spiky account (${trustSpiky}) must out-trust bot-flag near-miss (${trustNearMiss})`
  );
  // A near-miss (bot_probability just under the 0.6 flag threshold, not
  // flagged) scores low on trust even though it escaped the flag.
  const nearMissFixture = profiles.find(
    (p: Record<string, unknown>) => p._test_id === "trust_botline_near_miss"
  );
  const nearMissScored = ranked.find(
    (inf) => inf.username === nearMissFixture.username
  );
  assert(
    nearMissScored !== undefined && nearMissScored.bot_flagged === false,
    `trust_botline_near_miss must NOT be bot-flagged (prob=${nearMissScored?.bot_detection.bot_probability})`
  );
  assert(
    nearMissScored !== undefined &&
      nearMissScored.bot_detection.bot_probability >= 0.4,
    `trust_botline_near_miss must sit near the flag threshold (prob=${nearMissScored?.bot_detection.bot_probability}, expected >= 0.4)`
  );
}

// --- Print ranked results for human review ---
console.log("\n--- Ranked Results ---");
for (const inf of ranked) {
  const flag = inf.bot_flagged ? " 🤖 BOT" : "";
  console.log(
    `  ${inf.tier} | ${String(inf.composite_score).padStart(3)} | trust=${String(inf.score_breakdown.trust_score).padStart(3)} | ${inf.username.padEnd(25)} | eng=${(inf.engagement_rate * 100).toFixed(1)}% | ${inf.followers} followers${flag}`
  );
}

// --- Summary ---
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  ✗ ${f}`);
  }
  process.exit(1);
} else {
  console.log("All scoring regression tests passed ✓");
  process.exit(0);
}
