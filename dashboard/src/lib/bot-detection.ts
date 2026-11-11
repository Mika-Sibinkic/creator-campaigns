/**
 * Creator Campaigns Bot Detection Module
 * v1.0 — Multi-signal bot probability scoring
 *
 * Analyzes TikTok profile data to determine the likelihood
 * that an account is a bot, repost farm, or spam account.
 */

import { postTotals } from "./quality-signals";

export interface BotSignals {
  followerFollowingRatio: number | null;
  postingCadence: number | null; // videos per day estimate
  engagementRateAnomaly: boolean;
  zeroCommentHighLikes: boolean;
  emptyBio: boolean;
  randomUsername: boolean;
  suspiciouslyHighEngagement: boolean;
  noOriginalContent: boolean;
}

export interface BotDetectionResult {
  bot_probability: number; // 0-1
  bot_flagged: boolean; // true if probability > 0.6
  signals: BotSignals;
  reasons: string[];
}

// Common bot username patterns: random alphanumeric, user + long numbers
const BOT_USERNAME_PATTERNS = [
  /^user\d{6,}$/i,
  /^[a-z]{2,4}\d{8,}$/i,
  /^\d{10,}$/,
  /^[a-z]\d{5,}[a-z]\d{3,}$/i,
];

export function detectBot(profile: {
  username: string;
  followers: number;
  engagement_rate: number;
  bio: string;
  verified: boolean;
  raw_data?: Record<string, unknown>;
}): BotDetectionResult {
  const reasons: string[] = [];
  let probability = 0;

  const raw = profile.raw_data || {};
  const authorMeta = (raw.authorMeta || raw.author || {}) as Record<string, unknown>;
  const following = (authorMeta.following as number) || (authorMeta.followingCount as number) || 0;
  const videoCount = (authorMeta.video as number) || (authorMeta.videoCount as number) || 0;
  const heartCount = (authorMeta.heart as number) || (authorMeta.heartCount as number) || 0;

  // Signal 1: Follower/following ratio
  let followerFollowingRatio: number | null = null;
  if (following > 0) {
    followerFollowingRatio = profile.followers / following;
    if (followerFollowingRatio < 0.1) {
      probability += 0.20;
      reasons.push(`Very low follower/following ratio (${followerFollowingRatio.toFixed(2)}) — follows many, few follow back`);
    } else if (followerFollowingRatio > 50) {
      // Could be legit celebrity, but for micro-influencers this is unusual
      probability += 0.10;
      reasons.push(`Unusually high follower/following ratio (${followerFollowingRatio.toFixed(0)})`);
    }
  }

  // Signal 2: Posting cadence (rough estimate)
  let postingCadence: number | null = null;
  if (videoCount > 0) {
    // Estimate account age from video count — rough heuristic
    // If they have 500+ videos but only 10K followers, likely a repost farm
    if (videoCount > 300 && profile.followers < 20000) {
      postingCadence = videoCount / 365; // estimate daily rate assuming ~1 year
      probability += 0.20;
      reasons.push(`High video count (${videoCount}) relative to followers (${profile.followers}) — possible repost farm`);
    } else if (videoCount > 1000) {
      postingCadence = videoCount / 365;
      probability += 0.15;
      reasons.push(`Extremely high video count (${videoCount}) — likely automated posting`);
    }
  }

  // Signal 3: Engagement rate anomaly
  const engagementRateAnomaly = profile.engagement_rate > 0.80;
  if (engagementRateAnomaly) {
    probability += 0.20;
    reasons.push(`Suspiciously high engagement rate (${(profile.engagement_rate * 100).toFixed(1)}%)`);
  }

  // Signal 4: Very low engagement on high-follower account
  const suspiciouslyHighEngagement = profile.engagement_rate > 0.50;
  if (profile.followers > 20000 && profile.engagement_rate < 0.005) {
    probability += 0.15;
    reasons.push(`Very low engagement (${(profile.engagement_rate * 100).toFixed(2)}%) for ${profile.followers} followers — possible purchased followers`);
  }

  // Signal 5: Empty or generic bio
  const bio = (profile.bio || "").trim();
  const emptyBio = bio.length < 3 || /^[\p{Emoji}\s]+$/u.test(bio);
  if (emptyBio) {
    probability += 0.10;
    reasons.push("Empty or emoji-only bio");
  }

  // Signal 6: Username pattern analysis
  const randomUsername = BOT_USERNAME_PATTERNS.some((p) => p.test(profile.username));
  if (randomUsername) {
    probability += 0.10;
    reasons.push(`Username pattern matches bot naming convention (${profile.username})`);
  }

  // Signal 7: Content indicators — no original content (repost accounts)
  const noOriginalContent =
    bio.toLowerCase().includes("repost") ||
    bio.toLowerCase().includes("dm for promo") ||
    bio.toLowerCase().includes("send your") ||
    bio.toLowerCase().includes("submit your") ||
    (videoCount > 100 && heartCount > 0 && heartCount / videoCount < 50);
  if (noOriginalContent) {
    probability += 0.15;
    reasons.push("Bio or metrics suggest repost/promo farm, not original creator");
  }

  // Signal 8: Likes with (almost) no comments — a bought-likes pattern.
  //
  // REAL counts when the stored posts carry them (raw_data.posts[].commentCount
  // and diggCount, present on scraped TikTok rows): fewer than 0.1 comments
  // per 100 likes over at least 200 likes, which is below the bottom decile of
  // the calibration sample (src/lib/quality-signals.ts). Only
  // when no post carries a comment count does the old engagement-rate
  // estimate still stand in.
  const totals = postTotals(raw.posts);
  const zeroCommentHighLikes = totals.has_comment_data
    ? totals.likes >= 200 && (100 * totals.comments) / totals.likes < 0.1
    : profile.engagement_rate > 0.3 && videoCount > 50 && profile.followers < 15000;
  if (zeroCommentHighLikes) {
    probability += 0.10;
    reasons.push(
      totals.has_comment_data
        ? `${totals.likes.toLocaleString()} likes but ${totals.comments} comment${totals.comments === 1 ? "" : "s"} on recent posts, possible bought likes`
        : "High engagement with many videos and low followers, possible engagement manipulation"
    );
  }

  // Verified accounts get a bot probability reduction
  if (profile.verified) {
    probability = Math.max(0, probability - 0.30);
    reasons.push("Verified account — reduced bot probability");
  }

  // Cap at 1.0
  probability = Math.min(1.0, probability);

  return {
    bot_probability: Math.round(probability * 100) / 100,
    bot_flagged: probability > 0.6,
    signals: {
      followerFollowingRatio,
      postingCadence,
      engagementRateAnomaly,
      zeroCommentHighLikes,
      emptyBio,
      randomUsername,
      suspiciouslyHighEngagement,
      noOriginalContent,
    },
    reasons,
  };
}
