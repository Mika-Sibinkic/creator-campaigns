// tests/quality-signals.test.ts
//
// Free authenticity signals from stored post stats (src/lib/quality-signals.ts):
//   1. the numbers: median vs mean plays/follower, view volatility, like
//      uniformity, comments per 100 likes, share and like rates;
//   2. the flags at both comment-ratio tails, one viral hit, uniform likes;
//   3. the penalty: only with enough data, capped at 6 points;
//   4. scoring.ts folds it in; bot-detection.ts reads REAL comment counts;
//   5. the card line.
// Weights are not backtested; these tests pin behaviour, not wisdom.
//
// Hermetic. Run: npx tsx tests/quality-signals.test.ts

import {
  QUALITY_MAX_PENALTY,
  computeQualitySignals,
  postTotals,
  qualitySignalsLine,
} from '../src/lib/quality-signals';
import { detectBot } from '../src/lib/bot-detection';
import { scoreInfluencers } from '../src/lib/scoring';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

const post = (plays: number, likes: number, comments: number, shares = 0) => ({
  playCount: plays,
  diggCount: likes,
  commentCount: comments,
  shareCount: shares,
});

// ── 1. Numbers ────────────────────────────────────────────────────────────
{
  const s = computeQualitySignals([post(10_000, 800, 16, 20), post(20_000, 1_500, 30, 40), post(30_000, 2_300, 46, 60)], 10_000);
  assert(s.posts_n === 3, 'three posts with plays');
  assert(s.median_plays_per_follower === 2 && s.mean_plays_per_follower === 2, `median and mean plays/follower (got ${s.median_plays_per_follower}/${s.mean_plays_per_follower})`);
  assert(s.comments_per_100_likes === 2, `2 comments per 100 likes (got ${s.comments_per_100_likes})`);
  assert(s.shares_per_1k_plays === 2, `2 shares per 1k plays (got ${s.shares_per_1k_plays})`);
  assert(Math.abs((s.likes_per_play ?? 0) - 0.0767) < 0.001, `likes per play ~7.7% (got ${s.likes_per_play})`);
  assert(s.view_cv != null && s.like_cv != null, 'across-post signals present with 3 posts');
  assert(s.flags.length === 0 && s.adjustment === 0, `a normal creator has no flags (got ${s.flags})`);

  // Median resists one viral post where the mean does not.
  const v = computeQualitySignals([post(1_000, 80, 2), post(1_200, 90, 2), post(500_000, 40_000, 800)], 10_000);
  assert((v.median_plays_per_follower ?? 0) < 0.2 && (v.mean_plays_per_follower ?? 0) > 16, 'median 0.12x vs mean 16.7x followers');
  assert(v.flags.includes('one_viral_hit'), `one viral hit flagged (got ${v.flags})`);

  const one = computeQualitySignals([post(5_000, 400, 8)], 2_000);
  assert(one.view_cv === null && one.like_cv === null && one.view_p90_over_median === null, 'a single post has no across-post signals');
  assert(one.comments_per_100_likes === 2, 'the comment ratio works on one post');

  const none = computeQualitySignals(undefined, 1000);
  assert(none.posts_n === 0 && none.adjustment === 0 && none.flags.length === 0, 'no posts → nothing, no penalty');
  const noFollowers = computeQualitySignals([post(5_000, 400, 8)], 0);
  assert(noFollowers.median_plays_per_follower === null, 'no follower count → no per-follower number (never a fabricated denominator)');
}

// ── 2. Flags ──────────────────────────────────────────────────────────────
{
  const few = computeQualitySignals([post(50_000, 4_000, 2)], 10_000);
  assert(few.flags.includes('few_comments'), `0.05 comments per 100 likes → few_comments (got ${few.flags})`);
  const fewSmall = computeQualitySignals([post(500, 50, 0)], 10_000);
  assert(!fewSmall.flags.includes('few_comments'), 'under 100 likes is too small a sample to flag');
  const heavy = computeQualitySignals([post(5_000, 200, 60)], 10_000);
  assert(heavy.flags.includes('comment_heavy'), `30 per 100 likes → comment_heavy (got ${heavy.flags})`);
  const heavySmall = computeQualitySignals([post(500, 20, 10)], 10_000);
  assert(!heavySmall.flags.includes('comment_heavy'), 'under 20 comments is too small a sample to flag');
  // Live median is 1.97 per 100; the tails are p10 0.19 and p95 22.3.
  const typical = computeQualitySignals([post(10_000, 1_000, 20)], 5_000);
  assert(typical.flags.length === 0, 'a live-median ratio is not flagged');

  const uniform = computeQualitySignals([post(1_000, 500, 10), post(20_000, 505, 10), post(80_000, 498, 10)], 10_000);
  assert(uniform.flags.includes('uniform_likes'), `likes flat while views swing 80x → uniform_likes (got ${uniform.flags})`);
  const tracking = computeQualitySignals([post(1_000, 80, 2), post(20_000, 1_600, 30), post(80_000, 6_400, 120)], 10_000);
  assert(!tracking.flags.includes('uniform_likes'), 'likes that track views are not uniform');
}

// ── 3. Penalty ────────────────────────────────────────────────────────────
{
  const many = computeQualitySignals([post(1_000, 500, 0), post(1_100, 505, 0), post(400_000, 498, 0)], 10_000);
  assert(many.flags.length >= 3, `several flags at once (got ${many.flags})`);
  assert(many.adjustment === -QUALITY_MAX_PENALTY, `penalty capped at ${QUALITY_MAX_PENALTY} (got ${many.adjustment})`);
  const few = computeQualitySignals([post(50_000, 4_000, 2)], 10_000);
  assert(few.adjustment === -3, `few_comments costs 3 points (got ${few.adjustment})`);
}

// ── 4. Scoring + bot detection ────────────────────────────────────────────
{
  const base = {
    username: 'creator_a',
    platform: 'tiktok',
    followers: 20_000,
    engagement_rate: 0.08,
    bio: 'country music covers',
    verified: false,
  };
  const ctx = { genre: 'country', target_platforms: ['tiktok'], artist_name: 'X' };
  const clean = scoreInfluencers([{ ...base, raw_data: { posts: [post(50_000, 4_000, 80)] } }], ctx).ranked_influencers[0];
  const bought = scoreInfluencers([{ ...base, raw_data: { posts: [post(50_000, 4_000, 2)] } }], ctx).ranked_influencers[0];
  assert(bought.score_breakdown.quality_adjustment === -3, `breakdown carries the adjustment (got ${bought.score_breakdown.quality_adjustment})`);
  assert(JSON.stringify(bought.score_breakdown.quality_flags) === '["few_comments"]', 'breakdown carries the flags');
  assert(clean.composite_score - bought.composite_score >= 3, `the flagged creator scores lower (clean ${clean.composite_score}, flagged ${bought.composite_score})`);

  const t = postTotals([post(1, 600, 0), post(1, 400, 0)]);
  assert(t.likes === 1000 && t.comments === 0 && t.has_comment_data, 'post totals read real counts');
  const botReal = detectBot({ username: 'creator_b', followers: 30_000, engagement_rate: 0.05, bio: 'singer', verified: false, raw_data: { posts: [post(30_000, 1_000, 0)] } });
  assert(botReal.signals.zeroCommentHighLikes && botReal.reasons.some((r) => r.includes('1,000 likes but 0 comments')), `real counts: 1,000 likes, 0 comments → signal 8 (got ${botReal.reasons})`);
  const botFine = detectBot({ username: 'creator_c', followers: 30_000, engagement_rate: 0.5, bio: 'singer', verified: false, raw_data: { posts: [post(30_000, 1_000, 25)], authorMeta: { video: 80 } } });
  assert(!botFine.signals.zeroCommentHighLikes, 'real comments present → no signal 8, whatever the estimate would have said');
  const botEstimate = detectBot({ username: 'creator_d', followers: 10_000, engagement_rate: 0.5, bio: 'singer', verified: false, raw_data: { authorMeta: { video: 80 } } });
  assert(botEstimate.signals.zeroCommentHighLikes, 'no comment data at all → the old engagement estimate still stands in');
}

// ── 5. Copy ───────────────────────────────────────────────────────────────
{
  const s = computeQualitySignals([post(50_000, 4_000, 2)], 20_000);
  const line = qualitySignalsLine(s);
  assert(line === 'Views 2.5x followers · 0.05 comments per 100 likes · very few comments for the likes', `card line (got ${line})`);
  assert(qualitySignalsLine(computeQualitySignals([], 100)) === null, 'nothing to say → null');
  assert(!/—/.test(line ?? ''), 'no em dashes in card copy');
}

console.log(`\nquality-signals: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
