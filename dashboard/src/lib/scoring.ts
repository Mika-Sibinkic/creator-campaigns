/**
 * Creator Campaigns Deterministic Scoring Algorithm
 * v1.0 — Multi-signal influencer scoring
 *
 * Replaces GPT-based scoring with a transparent, reproducible formula.
 * Each influencer gets a composite score (0-100) built from 5 weighted sub-scores.
 */

import { detectBot, type BotDetectionResult } from "./bot-detection";
import { estimatePrice, type PriceEstimate } from "./pricing";
import { computeQualitySignals } from "./quality-signals";

export interface ScoreBreakdown {
  engagement_quality: number; // 0-100, weight 30%
  content_relevance: number; // 0-100, weight 25%
  audience_fit: number; // 0-100, weight 20%
  bot_risk_inverse: number; // 0-100, weight 15%
  response_likelihood: number; // 0-100, weight 10%
  // 0-100, weight 0% — displayed alongside the composite, NOT folded in.
  // Folding it in would re-weight the existing 100%-allocated formula and
  // shift the frozen regression-fixture outcomes, so it stays display-only.
  // Lives inside score_breakdown so it persists through the existing
  // campaign_influencers.score_breakdown jsonb column with no migration.
  trust_score: number;
  // Composite points from src/lib/quality-signals.ts (≤ 0, at most −6) and
  // the flags behind them. Optional so rows scored before 2026-10-01 still
  // type-check.
  quality_adjustment?: number;
  quality_flags?: string[];
}

export interface ScoredInfluencer {
  username: string;
  platform: string;
  display_name: string;
  profile_url: string;
  followers: number;
  engagement_rate: number;
  bio: string;
  verified: boolean;
  avatar: string;
  composite_score: number;
  tier: "A" | "B" | "C";
  score_breakdown: ScoreBreakdown;
  bot_detection: BotDetectionResult;
  price_estimate: PriceEstimate;
  outreach_priority: "immediate" | "standard" | "backup";
  outreach_angle: string;
  reasoning: string;
  bot_flagged: boolean;
  contact_email: string | null;
  has_contact_info: boolean;
  raw_data?: Record<string, unknown>;
}

export interface ScoringResult {
  scoring_summary: {
    total_scored: number;
    tier_a_count: number;
    tier_b_count: number;
    tier_c_count: number;
    bot_flagged_count: number;
    avg_score: number;
  };
  ranked_influencers: ScoredInfluencer[];
}

// Music/entertainment bio keywords for content relevance scoring
const MUSIC_KEYWORDS = [
  "music", "artist", "singer", "song", "band", "producer", "dj",
  "rapper", "country", "rock", "pop", "hip hop", "r&b", "indie",
  "songwriter", "vocal", "guitar", "piano", "drum", "bass",
  "tour", "concert", "album", "single", "ep", "mixtape",
  "spotify", "soundcloud", "apple music",
  "musician", "performer", "entertainment",
  "content creator", "influencer", "tiktoker", "creator",
  "dance", "choreograph", "cover", "remix", "lyric",
  "booking", "mgmt", "management", "label", "record",
];

const CONTACT_KEYWORDS = [
  "email", "dm", "business", "collab", "booking", "inquir",
  "contact", "link in bio", "linktree", "beacons",
];

interface CampaignContext {
  genre?: string;
  target_platforms?: string[];
  urgency?: string;
  artist_name?: string;
  top_genres?: string[];
  top_themes?: string[];
  /**
   * campaigns.per_creator_cap_usd. Bounds the persisted price estimate, which
   * is the figure quoted to the creator during negotiation. Omitted -> no
   * bound, exactly as before; the clamp only ever lowers.
   */
  per_creator_cap_usd?: number | null;
}

export interface ScoreOptions {
  /**
   * The firm's channel_conversion_priors rows. Present ⇒ the response-likelihood
   * component is rescaled by what this firm has actually observed. Absent ⇒
   * identical output to before this existed. Injected rather than fetched so
   * scoring stays pure: no DB, no clock, one query per batch instead of per
   * creator.
   */
  priors?: ChannelReplyPrior[] | null;
}

function scoreEngagementQuality(engagementRate: number): number {
  // TikTok micro-influencer benchmark: 3-8% is excellent
  // Formula: peak score at 5-8%, decay on both sides
  if (engagementRate >= 0.03 && engagementRate <= 0.12) {
    return 90 + Math.min((engagementRate - 0.03) * 100, 10);
  } else if (engagementRate > 0.12 && engagementRate <= 0.25) {
    return 80; // Still good but suspiciously high
  } else if (engagementRate > 0.25 && engagementRate <= 0.50) {
    return 50; // Getting suspicious
  } else if (engagementRate > 0.50) {
    return 20; // Almost certainly artificial
  } else if (engagementRate >= 0.01) {
    return 40 + (engagementRate - 0.01) * 2500; // 40-90 for 1-3%
  } else if (engagementRate > 0) {
    return Math.max(10, engagementRate * 4000); // Below 1% = low score
  }
  return 0;
}

function scoreContentRelevance(
  bio: string,
  context: CampaignContext,
  extras?: { content_relevance_score?: number; video_count?: number }
): number {
  const bioLower = (bio || "").toLowerCase();
  if (!bioLower || bioLower.length < 3) return 10;

  let score = 20; // Base score for having a bio

  // Use pre-computed content relevance if available (from normalize node)
  if (extras?.content_relevance_score && extras.content_relevance_score > 0) {
    score += Math.min(extras.content_relevance_score * 10, 40);
  } else {
    // Fallback: check bio for music keywords
    const musicMatches = MUSIC_KEYWORDS.filter((kw) => bioLower.includes(kw));
    score += Math.min(musicMatches.length * 12, 40);
  }

  // Genre alignment
  const genre = (context.genre || "").toLowerCase();
  if (genre && bioLower.includes(genre)) {
    score += 20;
  }

  // Artist name mention
  if (context.artist_name && bioLower.includes(context.artist_name.toLowerCase())) {
    score += 15;
  }

  // Theme alignment
  const themes = context.top_themes || [];
  const themeMatches = themes.filter((t) =>
    bioLower.includes((typeof t === "string" ? t : (t as { term: string }).term || "").toLowerCase())
  );
  score += Math.min(themeMatches.length * 5, 10);

  // Video count bonus — creators with substantial content libraries score higher
  if (extras?.video_count) {
    if (extras.video_count >= 100) score += 10;
    else if (extras.video_count >= 50) score += 5;
  }

  return Math.min(100, score);
}

function scoreAudienceFit(
  followers: number,
  platform: string,
  targetPlatforms: string[]
): number {
  let score = 0;

  // Follower sweet spot: 10K-30K = 100, decay toward edges
  if (followers >= 10000 && followers <= 30000) {
    score += 80;
  } else if (followers >= 5000 && followers < 10000) {
    score += 50 + ((followers - 5000) / 5000) * 30; // 50-80
  } else if (followers > 30000 && followers <= 50000) {
    score += 80 - ((followers - 30000) / 20000) * 30; // 80-50
  } else if (followers > 50000) {
    score += 40; // Over micro range but still viable
  } else {
    score += 30; // Under 5K
  }

  // Platform alignment
  if (targetPlatforms.includes(platform.toLowerCase())) {
    score += 20;
  } else {
    score += 5;
  }

  return Math.min(100, score);
}

function scoreResponseLikelihood(
  bio: string,
  verified: boolean,
  followers: number,
  extras?: { has_contact_info?: boolean; contact_email?: string | null }
): number {
  let score = 40; // Base

  const bioLower = (bio || "").toLowerCase();

  // Direct contact info available = highest signal
  if (extras?.contact_email) {
    score += 25;
  } else if (extras?.has_contact_info) {
    score += 20;
  } else {
    // Fallback: check bio text for contact keywords
    const contactMatches = CONTACT_KEYWORDS.filter((kw) => bioLower.includes(kw));
    score += Math.min(contactMatches.length * 15, 20);
  }

  // Smaller accounts respond more
  if (followers < 15000) score += 15;
  else if (followers < 25000) score += 10;
  else if (followers < 40000) score += 5;

  // Verified accounts are harder to reach
  if (verified) score -= 10;

  // Bio length — engaged creators have longer bios
  if (bioLower.length > 50) score += 10;
  else if (bioLower.length > 20) score += 5;

  return Math.max(0, Math.min(100, score));
}

// ── Learned response likelihood (the write-back) ─────────────────────────────
//
// scoreResponseLikelihood above is a hand-written heuristic: it has never once
// been corrected by whether creators actually replied. channel_conversion_priors
// is the firm's own observed funnel (sent / replies / deals per channel), and
// this is where it earns its keep — the loop closes here or it does not close.
//
// The blend deliberately does NOT replace the heuristic with the raw reply
// rate. A real reply rate is single-digit percent; dropping it in as a 0-100
// component would collapse the dimension for every creator equally and rank
// nothing. What carries ranking information is RELATIVE channel performance:
// this firm gets more replies on TikTok DMs than on Instagram DMs. So the
// observed signal rescales the heuristic rather than overwriting it:
//
//   observed = Laplace(replies, sent)  for the creator's channel
//   pooled   = Laplace(Σreplies, Σsent) across the firm's channels
//   ratio    = clamp(observed / pooled, 1 ± MAX_SWING)
//   blended  = (1 - conf) * static + conf * (static * ratio)
//
// which is the house blend shape from estimateOpeningPct (analytics.ts) —
// prior → learned target, interpolated by a sample-size confidence — with the
// n/30 ramp from rl-pricing.ts:106, the same one correlation.ts's
// confidenceForN exposes.
//
// IT READS ONLY THE OBSERVED COUNTERS, AND THAT IS THE WHOLE BALLGAME.
// Migration 020 seeds sent=100 per channel and calls it a STARTING GUESS, not
// measured data. A min(1, sent/30) ramp reads that as FULL confidence, so a
// blend over `sent` would have run at maximum strength against three numbers
// nobody measured, on every firm, from the first discovery run — against the
// live seed (email 100/8, instagram_dm 100/3, tiktok_dm 100/2) that is a 0.68x
// multiplier on tiktok_dm and 1.5x on email, moving a static 80 to 55 or to
// 100. The seed is right for ROUTING, where priorScore wants an overturnable
// cold-start ranking; it is poison for learning. So migration 043 adds
// observed_sent / observed_replies, which start at 0 on every row and are
// incremented only by real funnel events, and this function reads nothing else.
//
// COLD-START SAFE BY CONSTRUCTION, and now true of the deployed system rather
// than only of the function: with no priors, no row for the channel, or zero
// OBSERVED sends, it returns the heuristic byte-for-byte. Every firm is in
// exactly that state until it actually sends. Deterministic — pure arithmetic,
// no clock, no rng, no I/O.
//
// KNOWN LIMITATION, deliberate. On the campaign run route every profile is
// scored with platform 'tiktok' and contact_email null (contacts are discovered
// AFTER scoring), so scoringChannelFor returns the same channel for the whole
// batch and the blend is a uniform rescale — it shifts absolute scores, and so
// tier boundaries, without reordering creators within the batch. The relative-
// channel-performance argument only pays off where creators differ in channel,
// which today means a mixed-platform batch or a re-score after contact
// discovery. Worth revisiting by moving scoring after contact discovery; not
// done here because that reorders the run pipeline.
//
// [SAMPLE] EXCLUSION: channel_conversion_priors has no campaign_id and no
// synthetic column, so this cannot be filtered on read. It does not need to be.
// The counters are written only by bumpPrior, reached only from live send /
// ingest / negotiation-tick paths; tools/seed-sample-analytics.mjs writes
// campaign and offer rows directly and never calls it. Synthetic data cannot
// enter this table, which is why the exclusion lives at the write path rather
// than here. If a future seeder ever drives a real send, it must gain the
// isSyntheticCampaign guard learning-log.ts uses.

/**
 * A firm×channel funnel-counter row (subset of channel_conversion_priors).
 *
 * `sent`/`replies`/`deals` carry the migration-020 cold-start SEED and are what
 * routing reads. `observed_*` start at 0 on every row, are written only by real
 * funnel events (migration 043), and are the only counters this module reads —
 * see the note above. They are optional so a pre-043 read, which cannot select
 * columns that do not exist, is simply a cold start.
 */
export interface ChannelReplyPrior {
  channel: string;
  sent: number;
  replies: number;
  deals: number;
  observed_sent?: number | null;
  observed_replies?: number | null;
  observed_deals?: number | null;
}

/** OBSERVED sends at which the measured rate is trusted fully — rl-pricing.ts:106.
 *  Observed, never seeded: see the note above. */
export const RESPONSE_PRIOR_FULL_CONFIDENCE_N = 30;
/** Most the learned signal may move the heuristic, at full confidence. */
export const RESPONSE_PRIOR_MAX_SWING = 0.5;

/**
 * Add-1 / add-2 Laplace-smoothed reply rate. Same smoothing constants as
 * contact-discovery's priorScore, so routing and scoring cannot disagree about
 * what a thin sample means.
 */
function laplaceReplyRate(replies: number, sent: number): number {
  return (Math.max(0, replies) + 1) / (Math.max(0, sent) + 2);
}

/**
 * The channel a creator would actually be contacted on, for prior lookup.
 * Mirrors the campaign run route's own primary_channel stamp
 * (contact_email ? 'email' : platform DM). Returns null when the platform is
 * one the priors table does not track, which reads as "no learned signal".
 */
export function scoringChannelFor(profile: {
  platform?: string | null;
  contact_email?: string | null;
}): string | null {
  if (profile.contact_email) return "email";
  const p = (profile.platform || "").toLowerCase();
  if (p === "tiktok" || p === "tiktok_dm") return "tiktok_dm";
  if (p === "instagram" || p === "instagram_dm") return "instagram_dm";
  return null;
}

/**
 * Rescale the heuristic response-likelihood by the firm's observed per-channel
 * reply rate. Returns `staticScore` unchanged whenever there is nothing
 * trustworthy to learn from.
 */
export function blendResponseLikelihood(
  staticScore: number,
  channel: string | null,
  priors: ChannelReplyPrior[] | null | undefined
): number {
  if (!channel || !priors || priors.length === 0) return staticScore;

  // OBSERVED counters only. A row that exists but has never recorded a real
  // send is a cold start, however large its seeded `sent` is.
  const observedSent = (p: ChannelReplyPrior) => Number(p.observed_sent ?? 0);
  const observedReplies = (p: ChannelReplyPrior) => Number(p.observed_replies ?? 0);

  const row = priors.find((p) => p.channel === channel);
  if (!row || !(observedSent(row) > 0)) return staticScore;

  // The firm's own measured baseline, not an industry number and not the seed.
  // Only channels with real send history contribute, so one untouched channel
  // cannot drag the mean.
  const withHistory = priors.filter((p) => observedSent(p) > 0);
  const totalSent = withHistory.reduce((s, p) => s + observedSent(p), 0);
  const totalReplies = withHistory.reduce((s, p) => s + observedReplies(p), 0);

  const observed = laplaceReplyRate(observedReplies(row), observedSent(row));
  const pooled = laplaceReplyRate(totalReplies, totalSent);
  if (!(pooled > 0) || !Number.isFinite(observed)) return staticScore;

  const ratio = Math.max(
    1 - RESPONSE_PRIOR_MAX_SWING,
    Math.min(1 + RESPONSE_PRIOR_MAX_SWING, observed / pooled)
  );
  const confidence = Math.min(1, observedSent(row) / RESPONSE_PRIOR_FULL_CONFIDENCE_N);

  const blended = (1 - confidence) * staticScore + confidence * (staticScore * ratio);
  return Math.max(0, Math.min(100, Math.round(blended)));
}

/**
 * Posting-cadence consistency from raw_data.posts[].createTime (unix seconds).
 * Returns a trust delta: +10 consistent, -10 bursty, 0 unknown/neutral.
 *
 * Note: posts[] holds only the ~10 most recent posts, so this measures the
 * regularity of the visible posting window — not true account age (which is
 * not derivable from the data we persist; oldest-of-10 for a daily poster
 * would look "days old" and false-positive as a new account).
 */
function postingCadenceDelta(rawData?: Record<string, unknown>): number {
  const posts = Array.isArray(rawData?.posts)
    ? (rawData.posts as Array<{ createTime?: unknown }>)
    : [];
  const times = posts
    .map((p) => Number(p?.createTime))
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);
  if (times.length < 5) return 0; // not enough signal

  // Entire visible history inside 48h = burst-posting (spun-up account)
  const spanSeconds = times[times.length - 1] - times[0];
  if (spanSeconds < 48 * 3600) return -10;

  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const g = times[i] - times[i - 1];
    if (g > 0) gaps.push(g);
  }
  if (gaps.length < 4) return -10; // mostly identical timestamps = batch upload

  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
  const cv = Math.sqrt(variance) / mean; // coefficient of variation

  if (cv <= 1.25) return 10; // steady rhythm
  if (cv > 2.5) return -10; // wildly spiky
  return 0; // irregular-but-human — neutral
}

/**
 * Trust score (0-100). Reuses the bot-detection result's signals rather than
 * re-deriving parallel heuristics, plus verification + plausibility bands.
 */
function scoreTrust(
  profile: {
    engagement_rate: number;
    verified: boolean;
    raw_data?: Record<string, unknown>;
  },
  bot: BotDetectionResult
): number {
  // Base: inverse bot probability scaled to 60 points.
  let score = (1 - bot.bot_probability) * 60;

  // Near-miss penalty: un-flagged but sitting close to the 0.6 flag
  // threshold — trusted far less than a linear inverse would imply.
  if (!bot.bot_flagged && bot.bot_probability >= 0.4) score -= 15;

  // Platform-vetted identity
  if (profile.verified) score += 15;

  // Organic follower/following band (reuses detectBot's computed ratio)
  const ratio = bot.signals.followerFollowingRatio;
  if (ratio !== null && ratio >= 1 && ratio <= 50) score += 10;

  // Engagement plausibility band (mirrors the engagement-quality peak zone)
  if (profile.engagement_rate >= 0.01 && profile.engagement_rate <= 0.12) {
    score += 10;
  }

  // detectBot sets signals.postingCadence only when cadence is anomalous
  // (repost farm / automated posting); null here means no anomaly fired.
  if (bot.signals.postingCadence === null) score += 5;

  // Consistency of the visible posting window (timestamps, when available)
  score += postingCadenceDelta(profile.raw_data);

  return Math.max(0, Math.min(100, Math.round(score)));
}

function generateOutreachAngle(
  profile: { username: string; bio: string; followers: number },
  context: CampaignContext
): string {
  const bio = (profile.bio || "").toLowerCase();
  const genre = context.genre || "music";
  const artist = context.artist_name || "the artist";

  // This branch used to open with "Fellow music creator —
  // propose collaboration", i.e. it TARGETED music artists — the exact
  // accounts labels want filtered out (qualification now excludes them
  // per-firm; see src/lib/qualify.ts musicArtistPrecheck). Music-adjacent
  // creators who legitimately remain in the pool (curators, reviewers,
  // dance/cover accounts) get a paid-feature pitch, never artist-to-artist
  // collaboration framing.
  if (bio.includes("music") || bio.includes("singer") || bio.includes("artist")) {
    return `Music-focused creator — pitch a paid post featuring ${artist}'s new ${genre} release to their music-loving audience.`;
  }
  if (bio.includes("dance") || bio.includes("choreograph")) {
    return `Dance content creator — pitch a sound/dance challenge using ${artist}'s track, highlight how it fits their content style.`;
  }
  if (bio.includes("content creator") || bio.includes("influencer")) {
    return `Content creator with engaged following — propose sponsored post featuring ${artist}'s music, emphasize authentic integration.`;
  }
  if (bio.includes("lifestyle") || bio.includes("vlog")) {
    return `Lifestyle creator — pitch background music placement or "song of the day" feature for ${artist}.`;
  }
  return `Micro-influencer in the ${genre} ecosystem — propose a sponsored post promoting ${artist}'s latest release with creative freedom on format.`;
}

export function scoreInfluencers(
  profiles: Array<{
    username: string;
    platform: string;
    display_name?: string;
    profile_url?: string;
    followers: number;
    engagement_rate: number;
    bio?: string;
    verified?: boolean;
    avatar?: string;
    video_count?: number;
    content_relevance_score?: number;
    has_contact_info?: boolean;
    contact_email?: string | null;
    raw_data?: Record<string, unknown>;
  }>,
  campaignContext: CampaignContext,
  options?: ScoreOptions
): ScoringResult {
  const scored: ScoredInfluencer[] = [];
  // Loaded once per batch by the caller (the run route already reads this table
  // for contact routing). Omitted ⇒ every score is the pure heuristic, which is
  // what /api/scoring/batch wants: it has a session but no DB and no firm id.
  const priors = options?.priors ?? null;

  for (const profile of profiles) {
    const bot = detectBot({
      username: profile.username,
      followers: profile.followers,
      engagement_rate: profile.engagement_rate,
      bio: profile.bio || "",
      verified: profile.verified || false,
      raw_data: profile.raw_data,
    });

    const breakdown: ScoreBreakdown = {
      engagement_quality: Math.round(scoreEngagementQuality(profile.engagement_rate)),
      content_relevance: Math.round(
        scoreContentRelevance(profile.bio || "", campaignContext, {
          content_relevance_score: profile.content_relevance_score,
          video_count: profile.video_count,
        })
      ),
      audience_fit: Math.round(
        scoreAudienceFit(
          profile.followers,
          profile.platform,
          campaignContext.target_platforms || ["tiktok"]
        )
      ),
      bot_risk_inverse: Math.round((1 - bot.bot_probability) * 100),
      response_likelihood: blendResponseLikelihood(
        Math.round(
          scoreResponseLikelihood(
            profile.bio || "",
            profile.verified || false,
            profile.followers,
            {
              has_contact_info: profile.has_contact_info,
              contact_email: profile.contact_email,
            }
          )
        ),
        scoringChannelFor(profile),
        priors
      ),
      trust_score: scoreTrust(
        {
          engagement_rate: profile.engagement_rate,
          verified: profile.verified || false,
          raw_data: profile.raw_data,
        },
        bot
      ),
    };

    // Consistency / authenticity term (2026-10-01, src/lib/quality-signals.ts):
    // free signals from the stored post stats. Penalty only, at most 6 points,
    // zero without enough data. NOT BACKTESTED, so it is kept outside the
    // 100%-allocated weights and deliberately small.
    const quality = computeQualitySignals(
      (profile.raw_data as { posts?: unknown } | undefined)?.posts,
      profile.followers
    );
    breakdown.quality_adjustment = quality.adjustment;
    breakdown.quality_flags = quality.flags;

    // Weighted composite — trust_score intentionally excluded (see
    // ScoreBreakdown: it's a display-alongside dimension with 0% weight).
    const composite = Math.max(
      0,
      Math.round(
        breakdown.engagement_quality * 0.30 +
          breakdown.content_relevance * 0.25 +
          breakdown.audience_fit * 0.20 +
          breakdown.bot_risk_inverse * 0.15 +
          breakdown.response_likelihood * 0.10 +
          quality.adjustment
      )
    );

    const price = estimatePrice(
      profile.followers,
      profile.engagement_rate,
      profile.platform,
      campaignContext.genre,
      campaignContext.urgency,
      campaignContext.per_creator_cap_usd
    );

    const reasons: string[] = [];
    if (breakdown.engagement_quality >= 80)
      reasons.push("strong engagement");
    if (breakdown.content_relevance >= 60)
      reasons.push("relevant content");
    if (breakdown.audience_fit >= 70)
      reasons.push("ideal audience size");
    if (bot.bot_flagged)
      reasons.push("BOT RISK — " + bot.reasons[0]);
    if (breakdown.content_relevance < 30)
      reasons.push("low content relevance");

    scored.push({
      username: profile.username,
      platform: profile.platform,
      display_name: profile.display_name || profile.username,
      profile_url:
        profile.profile_url || `https://tiktok.com/@${profile.username}`,
      followers: profile.followers,
      engagement_rate: profile.engagement_rate,
      bio: profile.bio || "",
      verified: profile.verified || false,
      avatar: profile.avatar || "",
      composite_score: composite,
      tier: "C", // Will be assigned after sorting
      score_breakdown: breakdown,
      bot_detection: bot,
      price_estimate: price,
      outreach_priority: "backup", // Will be assigned after sorting
      outreach_angle: generateOutreachAngle(
        { username: profile.username, bio: profile.bio || "", followers: profile.followers },
        campaignContext
      ),
      reasoning: reasons.join("; ") || "Standard profile",
      bot_flagged: bot.bot_flagged,
      contact_email: profile.contact_email || null,
      has_contact_info: profile.has_contact_info || false,
      raw_data: profile.raw_data,
    });
  }

  // Sort by composite score descending, bot-flagged pushed to bottom
  scored.sort((a, b) => {
    if (a.bot_flagged && !b.bot_flagged) return 1;
    if (!a.bot_flagged && b.bot_flagged) return -1;
    return b.composite_score - a.composite_score;
  });

  // Assign tiers and priority
  const nonBotCount = scored.filter((s) => !s.bot_flagged).length;
  const tierAThreshold = Math.ceil(nonBotCount * 0.2);
  const tierBThreshold = Math.ceil(nonBotCount * 0.7);

  scored.forEach((s, i) => {
    if (s.bot_flagged) {
      s.tier = "C";
      s.outreach_priority = "backup";
    } else if (i < tierAThreshold) {
      s.tier = "A";
      s.outreach_priority = "immediate";
    } else if (i < tierBThreshold) {
      s.tier = "B";
      s.outreach_priority = "standard";
    } else {
      s.tier = "C";
      s.outreach_priority = "backup";
    }
  });

  const nonFlagged = scored.filter((s) => !s.bot_flagged);
  return {
    scoring_summary: {
      total_scored: scored.length,
      tier_a_count: scored.filter((s) => s.tier === "A").length,
      tier_b_count: scored.filter((s) => s.tier === "B").length,
      tier_c_count: scored.filter((s) => s.tier === "C").length,
      bot_flagged_count: scored.filter((s) => s.bot_flagged).length,
      avg_score: nonFlagged.length > 0
        ? Math.round(nonFlagged.reduce((sum, s) => sum + s.composite_score, 0) / nonFlagged.length)
        : 0,
    },
    ranked_influencers: scored,
  };
}
