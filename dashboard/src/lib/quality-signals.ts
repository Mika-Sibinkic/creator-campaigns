// src/lib/quality-signals.ts
//
// Free authenticity signals from the post stats discovery already stores in
// influencers.raw_data.posts (plays, likes, comments, shares). No scraper
// call, no model call. Pure and client-safe: scoring.ts folds a small penalty
// into the composite, bot-detection.ts reads the real comment counts, and the
// creator card shows the compact line.
//
// NOT BACKTESTED. Every threshold and weight below is a first cut, chosen to
// be conservative (penalty only, at most 6 composite points, nothing at all
// without enough data). None of it has been checked against deal outcomes
// yet. Revisit once there are closed deals to score against.
//
// Calibration, where there was data to calibrate on: the thresholds were set
// against the comments-per-100-likes, likes-per-play and shares-per-play
// distributions of a sample of TikTok creators' stored posts (read-only SELECT).
// Outside reference: TikTok likes per view of 3-6% is strong
// (help.modash.io/en/articles/6542471). Bought-likes red flag: like counts
// "almost identical across every post" (HypeAuditor fraud guidance).
//
// LIMIT, stated plainly: most stored creators carry ONE post, because
// discovery keeps the video that matched a search. Every
// across-posts signal (view volatility, like uniformity) needs ≥ 3 posts and
// is null for them. The comment ratio works on a single post.

export interface PostStatsInput {
  playCount?: unknown;
  diggCount?: unknown;
  likesCount?: unknown;
  commentCount?: unknown;
  commentsCount?: unknown;
  shareCount?: unknown;
  videoPlayCount?: unknown;
  videoViewCount?: unknown;
  [k: string]: unknown;
}

export type QualityFlag = 'few_comments' | 'comment_heavy' | 'one_viral_hit' | 'uniform_likes';

export interface QualitySignals {
  /** Posts with a usable play count. */
  posts_n: number;
  median_plays_per_follower: number | null;
  mean_plays_per_follower: number | null;
  /** Coefficient of variation of plays (n ≥ 3). */
  view_cv: number | null;
  /** p90 / median of plays (n ≥ 3); with ≤ 10 posts p90 is close to the max. */
  view_p90_over_median: number | null;
  /** Coefficient of variation of likes (n ≥ 3). */
  like_cv: number | null;
  comments_per_100_likes: number | null;
  likes_per_play: number | null;
  shares_per_1k_plays: number | null;
  flags: QualityFlag[];
  /** Composite points, ≤ 0. */
  adjustment: number;
}

export const QUALITY_MIN_POSTS_ACROSS = 3;
export const FEW_COMMENTS_PER_100_LIKES = 0.2;
export const FEW_COMMENTS_MIN_LIKES = 100;
export const HEAVY_COMMENTS_PER_100_LIKES = 22;
export const HEAVY_COMMENTS_MIN_COMMENTS = 20;
export const ONE_HIT_P90_OVER_MEDIAN = 10;
export const UNIFORM_LIKES_CV = 0.1;
export const UNIFORM_LIKES_MIN_VIEW_CV = 0.5;
export const QUALITY_PENALTY: Record<QualityFlag, number> = {
  few_comments: 3,
  comment_heavy: 2,
  one_viral_hit: 2,
  uniform_likes: 3,
};
export const QUALITY_MAX_PENALTY = 6;

function num(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function cv(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean <= 0) return null;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance) / mean;
}

const r4 = (n: number | null) => (n == null ? null : Math.round(n * 10_000) / 10_000);

export interface PostTotals {
  posts: number;
  likes: number;
  comments: number;
  /** False when no post carried a comment count at all. */
  has_comment_data: boolean;
}

/** Totals over stored posts, for callers that only need the real comment counts. */
export function postTotals(posts: unknown): PostTotals {
  const list = Array.isArray(posts) ? (posts as PostStatsInput[]) : [];
  let likes = 0;
  let comments = 0;
  let has = false;
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const l = num(p.diggCount, p.likesCount);
    const c = num(p.commentCount, p.commentsCount);
    if (l != null) likes += l;
    if (c != null) {
      comments += c;
      has = true;
    }
  }
  return { posts: list.length, likes, comments, has_comment_data: has };
}

export function computeQualitySignals(posts: unknown, followers: number | null | undefined): QualitySignals {
  const list = (Array.isArray(posts) ? (posts as PostStatsInput[]) : []).filter((p) => p && typeof p === 'object');
  const plays: number[] = [];
  const likesWithPlays: number[] = [];
  let likesTotal = 0;
  let commentsTotal = 0;
  let sharesTotal = 0;
  let playsTotal = 0;
  let commentData = false;
  let shareData = false;
  for (const p of list) {
    const pl = num(p.playCount, p.videoPlayCount, p.videoViewCount);
    const l = num(p.diggCount, p.likesCount);
    const c = num(p.commentCount, p.commentsCount);
    const s = num(p.shareCount);
    if (l != null) likesTotal += l;
    if (c != null) {
      commentsTotal += c;
      commentData = true;
    }
    if (pl != null && pl > 0) {
      plays.push(pl);
      playsTotal += pl;
      if (l != null) likesWithPlays.push(l);
      if (s != null) {
        sharesTotal += s;
        shareData = true;
      }
    }
  }

  const f = Number(followers);
  const hasFollowers = Number.isFinite(f) && f > 0;
  const n = plays.length;
  const across = n >= QUALITY_MIN_POSTS_ACROSS;

  const signals: QualitySignals = {
    posts_n: n,
    median_plays_per_follower: hasFollowers && n > 0 ? r4(median(plays) / f) : null,
    mean_plays_per_follower: hasFollowers && n > 0 ? r4(playsTotal / n / f) : null,
    view_cv: across ? r4(cv(plays)) : null,
    view_p90_over_median: across && median(plays) > 0 ? r4(quantile(plays, 0.9) / median(plays)) : null,
    like_cv: across && likesWithPlays.length >= QUALITY_MIN_POSTS_ACROSS ? r4(cv(likesWithPlays)) : null,
    comments_per_100_likes: commentData && likesTotal > 0 ? r4((100 * commentsTotal) / likesTotal) : null,
    likes_per_play: playsTotal > 0 && likesWithPlays.length > 0 ? r4(likesWithPlays.reduce((a, b) => a + b, 0) / playsTotal) : null,
    shares_per_1k_plays: shareData && playsTotal > 0 ? r4((1000 * sharesTotal) / playsTotal) : null,
    flags: [],
    adjustment: 0,
  };

  const flags: QualityFlag[] = [];
  const c100 = signals.comments_per_100_likes;
  if (c100 != null && likesTotal >= FEW_COMMENTS_MIN_LIKES && c100 < FEW_COMMENTS_PER_100_LIKES) flags.push('few_comments');
  if (c100 != null && commentsTotal >= HEAVY_COMMENTS_MIN_COMMENTS && c100 > HEAVY_COMMENTS_PER_100_LIKES) flags.push('comment_heavy');
  if (signals.view_p90_over_median != null && signals.view_p90_over_median >= ONE_HIT_P90_OVER_MEDIAN) flags.push('one_viral_hit');
  if (
    signals.like_cv != null &&
    signals.view_cv != null &&
    signals.like_cv < UNIFORM_LIKES_CV &&
    signals.view_cv >= UNIFORM_LIKES_MIN_VIEW_CV
  ) {
    flags.push('uniform_likes');
  }
  signals.flags = flags;
  const penalty = flags.reduce((a, fl) => a + QUALITY_PENALTY[fl], 0);
  signals.adjustment = -Math.min(QUALITY_MAX_PENALTY, penalty);
  return signals;
}

// ── Copy (creator card) ─────────────────────────────────────────────────────

const FLAG_COPY: Record<QualityFlag, string> = {
  few_comments: 'very few comments for the likes',
  comment_heavy: 'unusually comment-heavy',
  one_viral_hit: 'one viral hit',
  uniform_likes: 'likes nearly identical across posts',
};

function compact(n: number): string {
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1).replace(/\.0$/, '');
  return n.toFixed(2).replace(/0$/, '').replace(/\.0$/, '');
}

/** "Views 2.5x followers · 1.97 comments per 100 likes · one viral hit", or null when there is nothing to say. */
export function qualitySignalsLine(s: QualitySignals): string | null {
  const parts: string[] = [];
  if (s.median_plays_per_follower != null) parts.push(`Views ${compact(s.median_plays_per_follower)}x followers`);
  if (s.comments_per_100_likes != null) parts.push(`${compact(s.comments_per_100_likes)} comments per 100 likes`);
  for (const f of s.flags) parts.push(FLAG_COPY[f]);
  return parts.length > 0 ? parts.join(' · ') : null;
}
