// src/lib/discovery-candidates.ts
//
// The one creator shape the discovery pipeline works in, and the Instagram
// normalizer that produces it.
//
// Before this file the run route grouped TikTok posts by author inline and
// every downstream step reached back into `posts[0].authorMeta` for things the
// row already knew. That is fine with one scraper and impossible with two, so
// the fields those reach-ins wanted (`following`, `author_meta`,
// `reach_per_follower`) are now on the row itself and the bot pre-filter,
// scorer and qualifier no longer care which platform a candidate came from.
//
// ── The one number that does NOT mean the same thing on both platforms ──────
//
// `engagement_rate` has a different denominator per platform, and no amount of
// normalizing fixes that, because Instagram does not publish impressions for
// image posts:
//
//   TikTok     (likes + comments) / PLAYS       — what the existing pipeline
//                                                 has always computed
//   Instagram  (likes + comments) / FOLLOWERS   — the only denominator with
//                                                 full coverage on IG, and the
//                                                 platform convention
//
// The two are not comparable, and a TikTok rate will usually read higher than
// an Instagram rate for an equally healthy creator. That matters in three
// places and is deliberately left visible rather than fudged: scoring.ts
// scores the number, firms.scraping_prefs.engagement_min gates on it, and the
// creator list shows it in one column. Inventing a fake play count for IG to
// make the columns match would be fabricating the denominator, which is worse
// than an asymmetry that is written down. If a single cross-platform metric is
// wanted, it needs its own column and its own decision.
//
// Pure module: no env, no I/O, no network. Tested by tests/instagram-scrape.test.ts.

import type { InstagramPost, InstagramProfile, TikTokProfile } from './apify';

export type CandidatePlatform = 'tiktok' | 'instagram';

/**
 * A scraped post, in the shape the pipeline reads (TikTok's, since that is
 * what qualify.ts / scoring.ts were written against). Instagram posts are
 * mapped INTO this on the way in, with their original keys preserved
 * alongside, so nothing is lost and no consumer needs a platform branch.
 */
export interface DiscoveryPost {
  text?: string;
  diggCount?: number;
  commentCount?: number;
  shareCount?: number;
  playCount?: number;
  createTime?: number;
  createTimeISO?: string;
  hashtags?: { name?: string }[];
  /** TikTok only. Instagram carries NO language field on any actor's output. */
  textLanguage?: string;
  [k: string]: unknown;
}

/** One creator candidate, platform-neutral. */
export interface CandidateRow {
  username: string;
  platform: CandidatePlatform;
  posts: DiscoveryPost[];
  followers: number;
  /**
   * False when the platform did not return a follower count at all.
   *
   * `followers` is then 0, which is a placeholder and NOT a measurement — the
   * Instagram actor types followersCount as nullable and really does omit it
   * for private and restricted profiles. Everything that divides by followers
   * must consult this first. Without it, `Math.max(followers, 1)` turned a
   * creator with 1,240 mean engagements into an engagement_rate of 1240, which
   * cleared every floor and persisted with follower_count 0 — a fabricated
   * denominator producing a confident, nonsense number.
   */
  followers_known: boolean;
  following: number;
  engagement_rate: number;
  bio: string;
  verified: boolean;
  display_name: string;
  profile_url: string;
  avatar_url: string | null;
  ratio: number | null;
  /**
   * Mean reach per follower — the dead-account signal, per platform:
   *   TikTok     mean plays per post / followers
   *   Instagram  mean (likes + comments) per post / followers
   * Different measurements of the same question ("does anyone see this?"),
   * which is why the floor is per-platform below and not one constant.
   */
  reach_per_follower: number;
  /** The platform's own author blob, persisted into raw_data.authorMeta. */
  author_meta: Record<string, unknown>;
  db_row: Record<string, unknown>;
}

/**
 * Below this, nobody is watching.
 *
 * TikTok's 0.005 is the value the pipeline has always used (plays per
 * follower), and it is deliberately low: very few real TikTok creators
 * fall under it.
 *
 * Instagram's is NOT the same number, and the first cut of this file made
 * exactly that mistake. 0.005 against an engagements-per-follower measurement
 * is a 0.5% engagement rate, which is inside the normal range for real
 * Instagram accounts — the actor's own published sample profile computes to
 * about 0.0038 and would have been thrown away as dead. This database
 * contains ZERO Instagram rows, so there is nothing here to calibrate
 * against; 0.0005 is deliberately an order of magnitude below any published
 * benchmark so it only catches accounts with effectively no engagement at
 * all. It is provisional and should be re-derived from real rows once a live
 * scrape has landed some.
 *
 * Conservative is the right direction for both: this filter runs BEFORE
 * persistence, so anyone it drops is gone from the run without a row to
 * inspect.
 */
export const DEAD_ACCOUNT_REACH_FLOOR: Record<CandidatePlatform, number> = {
  tiktok: 0.005,
  instagram: 0.0005,
};

// ── The engagement floor, per platform ──────────────────────────────────────
//
// firms.scraping_prefs.engagement_min is ONE number, and it cannot mean the
// same thing on both platforms, because engagement_rate does not mean the same
// thing on both platforms (see the header).
//
// Take engagement_min 0.03. Against TikTok rows, whose rate divides by PLAYS
// (typical values sit well above 0.03), it is a mild quality filter.
//
// Against an Instagram rate, which divides by FOLLOWERS, 0.03 is a different
// gate entirely: both creators in the test fixture compute to 0.0267 and
// 0.0281, and the actor's own published sample computes to ~0.0038. Applying
// the same number to both platforms means Apify is billed for the Instagram
// scrape and then every creator it returned is discarded
// before persistence, while the run reports success. That is not a
// conservative filter; it is the whole feature deleted, silently.
//
// So the floors are per platform, and Instagram's default is OFF:
//
//   - The configured engagement_min belongs to the denominator it was written
//     against. It keeps applying to TikTok exactly as before.
//   - There are ZERO Instagram rows in this database. Any conversion factor
//     between the two denominators would be invented, and the house rule is
//     null over fabrication.
//   - A gate nobody configured must not delete 100% of a new source's output.
//     That is the same lesson DEFAULT_AUDIENCE_FIT_MIN = 0 already records in
//     pool-gates.ts, where a well-meant default removed a large share of a pool.
//
// A firm that wants an Instagram floor sets scraping_prefs.engagement_min_instagram
// from real numbers once real numbers exist.

/**
 * The identity of a candidate within one run.
 *
 * `influencers` is unique on (platform, username), and so is a creator: the
 * same handle on TikTok and on Instagram is two different people as far as
 * this pipeline is concerned, and often two different people in fact. Every
 * in-memory lookup keyed on a bare username is a collision waiting for the
 * first run that scrapes both platforms — which is every default campaign now
 * that Instagram is real.
 */
export function candidateKey(platform: string, username: string): string {
  return `${platform}:${username}`;
}

/** Per-platform engagement floor. undefined = no floor enforced. */
export type EngagementFloors = Record<CandidatePlatform, number | undefined>;

/** The jsonb key a firm sets to turn the Instagram floor on. */
export const INSTAGRAM_ENGAGEMENT_MIN_KEY = 'engagement_min_instagram';

function positiveNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/**
 * Resolve firms.scraping_prefs into a floor per platform.
 *
 * `engagement_min` → TikTok only. `engagement_min_instagram` → Instagram,
 * absent by default, which means no floor rather than a borrowed one.
 */
export function resolveEngagementFloors(rawPrefs: unknown): EngagementFloors {
  const p = (
    rawPrefs !== null && typeof rawPrefs === 'object' && !Array.isArray(rawPrefs)
      ? rawPrefs
      : {}
  ) as Record<string, unknown>;
  return {
    tiktok: positiveNumber(p.engagement_min),
    instagram: positiveNumber(p[INSTAGRAM_ENGAGEMENT_MIN_KEY]),
  };
}

// ── The pre-filter ──────────────────────────────────────────────────────────

export type RejectionReason =
  | 'no_content'
  | 'mass_follow'
  | 'dead_account'
  | 'below_follower_floor'
  | 'below_engagement_floor';

export interface Rejection {
  username: string;
  platform: CandidatePlatform;
  reason: RejectionReason;
  followers: number;
  following?: number;
  engagement?: number;
  /** Plays per follower on TikTok, engagements per follower on Instagram. */
  reach_per_follower?: number;
}

export interface PrefilterConfig {
  /** scraping_prefs.follower_min. Enforced here only where an actor could not. */
  followerMin: number;
  engagementFloors: EngagementFloors;
}

export interface PrefilterResult {
  survivors: CandidateRow[];
  rejected: Rejection[];
}

/** Mass-follow ratio: following this many times your followers is a bot tell. */
export const MASS_FOLLOW_RATIO = 5;

/**
 * Drop junk before it costs a DB row or a scorer pass.
 *
 * Pure and exported so it can be tested directly. It used to be inline in the
 * run route, where nothing could reach it — and a platform-blind engagement
 * floor sat in it discarding every Instagram creator the pipeline had just
 * paid for. A filter that decides what the label never sees does not get to
 * be the untested part of the pipeline.
 *
 * Order is deliberate: the three "this account is junk" checks run first, so a
 * follow-for-follow account with 800 followers is reported as a bot rather
 * than as "under your minimum". The two firm-config thresholds follow.
 *
 * Fail-open on missing data throughout — a creator whose followers the actor
 * did not return is never measured against a ratio, because every such ratio
 * would be a number we made up.
 */
export function prefilterCandidates(
  rows: CandidateRow[],
  cfg: PrefilterConfig,
): PrefilterResult {
  const survivors: CandidateRow[] = [];
  const rejected: Rejection[] = [];

  for (const r of rows) {
    if (r.posts.length === 0) {
      rejected.push({
        username: r.username,
        platform: r.platform,
        reason: 'no_content',
        followers: r.followers,
      });
      continue;
    }

    // Every check below divides by followers. Without them the only honest
    // move is to skip the arithmetic, keep the creator, and let the scorer
    // and the qualification pass judge them on what IS known.
    if (r.followers_known) {
      if (r.following / Math.max(r.followers, 1) > MASS_FOLLOW_RATIO) {
        rejected.push({
          username: r.username,
          platform: r.platform,
          reason: 'mass_follow',
          followers: r.followers,
          following: r.following,
        });
        continue;
      }

      if (r.reach_per_follower < DEAD_ACCOUNT_REACH_FLOOR[r.platform]) {
        rejected.push({
          username: r.username,
          platform: r.platform,
          reason: 'dead_account',
          followers: r.followers,
          reach_per_follower: r.reach_per_follower,
        });
        continue;
      }

      // Follower floor. TikTok gets `followersMoreThan` passed INTO the actor,
      // so its results arrive pre-bounded and this never fires for it.
      // Instagram's search actor has no follower input at all, so without this
      // the firm's minimum would apply on one platform and be silently ignored
      // on the other.
      if (r.platform !== 'tiktok' && r.followers > 0 && r.followers < cfg.followerMin) {
        rejected.push({
          username: r.username,
          platform: r.platform,
          reason: 'below_follower_floor',
          followers: r.followers,
        });
        continue;
      }
    }

    const floor = cfg.engagementFloors[r.platform];
    if (floor !== undefined && r.followers_known && r.engagement_rate < floor) {
      rejected.push({
        username: r.username,
        platform: r.platform,
        reason: 'below_engagement_floor',
        followers: r.followers,
        engagement: r.engagement_rate,
      });
      continue;
    }

    survivors.push(r);
  }

  return { survivors, rejected };
}

// ── TikTok ──────────────────────────────────────────────────────────────────

/**
 * Group clockworks/tiktok-scraper post rows by author into candidates.
 *
 * Lifted verbatim out of the run route when Instagram arrived — same grouping,
 * same engagement arithmetic ((likes + comments) / plays), same db_row. The
 * only additions are the fields the route used to re-derive by reaching into
 * `posts[0].authorMeta` at three separate call sites.
 */
export function candidatesFromTikTok(profiles: TikTokProfile[]): CandidateRow[] {
  const byAuthor = new Map<string, TikTokProfile[]>();
  for (const p of profiles) {
    const name = p.authorMeta?.name;
    if (!name) continue;
    if (!byAuthor.has(name)) byAuthor.set(name, []);
    byAuthor.get(name)!.push(p);
  }

  const rows: CandidateRow[] = [];
  for (const [username, posts] of byAuthor) {
    const meta = posts[0].authorMeta!;
    const totalLikes = posts.reduce((a, p) => a + (p.diggCount ?? 0), 0);
    const totalPlays = posts.reduce((a, p) => a + (p.playCount ?? 0), 0);
    const totalComments = posts.reduce((a, p) => a + (p.commentCount ?? 0), 0);
    const engagement = totalPlays > 0 ? (totalLikes + totalComments) / totalPlays : 0;
    const fans = meta.fans ?? 0;
    const following = meta.following ?? 0;
    const followerForRatio = Math.max(fans, 1);
    const avgPlays = posts.length > 0 ? totalPlays / posts.length : 0;

    rows.push({
      username,
      platform: 'tiktok',
      posts: posts as DiscoveryPost[],
      followers: fans,
      // authorMeta.fans is normally present on TikTok rows.
      // Treating a missing/zero count as unknown keeps the same fail-open
      // posture as the Instagram path rather than inventing a denominator.
      followers_known: fans > 0,
      following,
      engagement_rate: Number(engagement.toFixed(4)),
      bio: meta.signature ?? '',
      verified: meta.verified ?? false,
      display_name: meta.nickName ?? username,
      profile_url: meta.profileUrl ?? `https://tiktok.com/@${username}`,
      avatar_url: meta.avatar ?? null,
      ratio: fans > 0 && following > 0 ? fans / following : null,
      reach_per_follower: avgPlays / followerForRatio,
      author_meta: meta as Record<string, unknown>,
      db_row: {
        platform: 'tiktok',
        username,
        display_name: meta.nickName ?? username,
        profile_url: meta.profileUrl ?? `https://tiktok.com/@${username}`,
        follower_count: fans,
        engagement_rate: Number(engagement.toFixed(4)),
        bio: meta.signature ?? null,
        verified: meta.verified ?? false,
        avatar_url: meta.avatar ?? null,
        // contact_email / content_genres deliberately absent: this row is
        // UPSERTed on (platform, username), and a key present as null would
        // overwrite an email that enrichment or a label already found.
        raw_data: { posts: posts.slice(0, 10), authorMeta: meta },
        synthetic: false,
      },
    });
  }

  return rows;
}

// ── Instagram ───────────────────────────────────────────────────────────────

/**
 * First readable number among several candidate keys.
 *
 * Instagram actor payloads have renamed engagement fields between builds, and
 * a silently-missing like count would read as a dead account and get the
 * creator dropped. Unknown stays undefined; it never becomes 0.
 */
function firstNumber(src: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return undefined;
}

function firstString(src: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

const LIKE_KEYS = ['likesCount', 'likeCount', 'likes'];
const COMMENT_KEYS = ['commentsCount', 'commentCount', 'comments'];
const CAPTION_KEYS = ['caption', 'text', 'title'];
const TIMESTAMP_KEYS = ['timestamp', 'takenAt', 'createdAt'];

/** Engagements (likes + comments) on one post, or 0 when neither is present. */
export function instagramPostEngagements(post: InstagramPost): number {
  const p = post as Record<string, unknown>;
  return (firstNumber(p, LIKE_KEYS) ?? 0) + (firstNumber(p, COMMENT_KEYS) ?? 0);
}

/**
 * Map one Instagram post into the pipeline's post shape.
 *
 * The original keys are spread in first and survive underneath, so raw_data
 * still holds exactly what the vendor sent.
 *
 * `playCount` is deliberately NEVER set from an Instagram payload.
 *
 * An earlier cut mapped it by coalescing `videoPlayCount` / `videoViewCount`.
 * Checked against the actor's raw build JSON, neither is a documented field on
 * a `latestPosts[]` entry: both appear only on TOP-LEVEL items from a
 * `searchType: 'popular'` reels search, and `latestPosts` is typed
 * `{"items":{"type":"object","additionalProperties":{}}}` with no enumerated
 * sub-schema. Every published example post is `type: "Image"`. So the mapping
 * was an inference dressed as a reading.
 *
 * That would be harmless if the number stayed put, and it does not: `playCount`
 * is read as `views` by outreach.ts and draft-all, which quote it in copy sent
 * TO the creator, and by measurement.ts. An inferred field becoming a claimed
 * view count in a pitch is exactly the fabrication this codebase refuses.
 * Instagram's engagement_rate never used it — that is likes plus comments over
 * followers — so dropping it costs no arithmetic.
 *
 * Nothing is lost either way: `...post` above preserves the vendor's own keys
 * verbatim in raw_data, so a real `videoViewCount` is still there to be read
 * by anything that later learns what it means.
 *
 * `textLanguage` is never set for the same reason: no Instagram actor emits a
 * language field, so every IG creator is honestly unplaceable by the region
 * gate rather than guessed at.
 */
export function toDiscoveryPost(post: InstagramPost): DiscoveryPost {
  const p = post as Record<string, unknown>;
  const out: DiscoveryPost = { ...(post as Record<string, unknown>) };

  const caption = firstString(p, CAPTION_KEYS);
  if (caption !== undefined) out.text = caption;

  const likes = firstNumber(p, LIKE_KEYS);
  if (likes !== undefined) out.diggCount = likes;

  const comments = firstNumber(p, COMMENT_KEYS);
  if (comments !== undefined) out.commentCount = comments;

  const ts = firstString(p, TIMESTAMP_KEYS);
  if (ts !== undefined) {
    out.createTimeISO = ts;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) out.createTime = Math.floor(ms / 1000);
  }

  if (Array.isArray(post.hashtags)) {
    out.hashtags = post.hashtags
      .filter((h): h is string => typeof h === 'string')
      .map((name) => ({ name }));
  }

  return out;
}

/**
 * Turn instagram-search-scraper output into candidate rows.
 *
 * Profiles with no usable username are dropped here rather than downstream:
 * `influencers` upserts on (platform, username), so a blank one would collide
 * every nameless profile onto a single row. Duplicates across search terms are
 * merged on first-seen, which matches the TikTok path's group-by-author.
 */
export function candidatesFromInstagram(profiles: InstagramProfile[]): CandidateRow[] {
  const seen = new Set<string>();
  const rows: CandidateRow[] = [];

  for (const profile of profiles) {
    const username = typeof profile.username === 'string' ? profile.username.trim() : '';
    if (username === '') continue;
    if (seen.has(username)) continue;
    seen.add(username);

    const followersRaw =
      typeof profile.followersCount === 'number' && Number.isFinite(profile.followersCount)
        ? profile.followersCount
        : null;
    const followersKnown = followersRaw !== null && followersRaw > 0;
    const followers = followersRaw ?? 0;
    const following = typeof profile.followsCount === 'number' ? profile.followsCount : 0;
    const posts = (Array.isArray(profile.latestPosts) ? profile.latestPosts : []).map(
      toDiscoveryPost,
    );

    const totalEngagements = (
      Array.isArray(profile.latestPosts) ? profile.latestPosts : []
    ).reduce((a, p) => a + instagramPostEngagements(p), 0);
    const meanEngagements = posts.length > 0 ? totalEngagements / posts.length : 0;
    // Instagram's denominator is followers — see the header. Not comparable to
    // the TikTok rate, and deliberately not made to look like it is.
    //
    // No follower count means no rate. Dividing by Math.max(followers, 1)
    // would turn "we don't know" into a spectacular engagement_rate that
    // clears every floor; 0 is carried alongside followers_known: false so
    // nothing downstream reads it as a measurement.
    const engagement = followersKnown ? meanEngagements / followers : 0;

    const displayName =
      typeof profile.fullName === 'string' && profile.fullName.trim() !== ''
        ? profile.fullName.trim()
        : username;
    const bio = typeof profile.biography === 'string' ? profile.biography : '';
    const verified = profile.verified === true;
    const avatar =
      (typeof profile.profilePicUrlHD === 'string' ? profile.profilePicUrlHD : null) ??
      (typeof profile.profilePicUrl === 'string' ? profile.profilePicUrl : null);
    const profileUrl = `https://www.instagram.com/${username}`;

    // Shaped like TikTok's authorMeta on purpose. contact-discovery.ts reads
    // `raw_data.authorMeta.bioLink` to fetch a creator's link-in-bio, so
    // mapping externalUrl onto that key gets Instagram contact discovery for
    // free instead of needing a second branch over there.
    const authorMeta: Record<string, unknown> = {
      name: username,
      nickName: displayName,
      fans: followers,
      following,
      video: typeof profile.postsCount === 'number' ? profile.postsCount : undefined,
      verified,
      signature: bio,
      avatar,
      profileUrl,
      bioLink: typeof profile.externalUrl === 'string' ? profile.externalUrl : undefined,
      isBusinessAccount: profile.isBusinessAccount === true,
    };

    rows.push({
      username,
      platform: 'instagram',
      posts,
      followers,
      followers_known: followersKnown,
      following,
      engagement_rate: Number(engagement.toFixed(4)),
      bio,
      verified,
      display_name: displayName,
      profile_url: profileUrl,
      avatar_url: avatar,
      ratio: followersKnown && following > 0 ? followers / following : null,
      reach_per_follower: engagement,
      author_meta: authorMeta,
      db_row: {
        platform: 'instagram',
        username,
        display_name: displayName,
        profile_url: profileUrl,
        // null, not 0, when the actor returned no count. A 0 here reads as
        // "this creator has no followers", which is a claim we cannot make.
        follower_count: followersKnown ? followers : null,
        engagement_rate: followersKnown ? Number(engagement.toFixed(4)) : null,
        bio: bio === '' ? null : bio,
        verified,
        avatar_url: avatar,
        // contact_email / content_genres deliberately absent: this row is
        // UPSERTed on (platform, username), and a key present as null would
        // overwrite an email that enrichment or a label already found.
        raw_data: { posts: posts.slice(0, 10), authorMeta },
        synthetic: false,
      },
    });
  }

  return rows;
}

// ── Fanning queries across the campaign's platforms ─────────────────────────

/** Platforms discovery can actually acquire from today. */
export const SUPPORTED_DISCOVERY_PLATFORMS: readonly CandidatePlatform[] = [
  'tiktok',
  'instagram',
];

export interface PlatformPlan {
  /** Platforms we will actually scrape, in pipeline order. */
  scrape: CandidatePlatform[];
  /**
   * Selected platforms discovery cannot acquire (today: 'youtube', which the
   * campaign-create UI offers). Reported rather than silently ignored — the
   * whole point of this pair of issues is that selecting a platform and
   * getting nothing is the bug.
   */
  unsupported: string[];
}

/**
 * Decide which platforms a run scrapes.
 *
 * An empty or missing selection falls back to TikTok, matching the run route's
 * long-standing `?? ["tiktok"]`. A selection of ONLY unsupported platforms
 * also falls back to TikTok rather than scraping nothing, and says so through
 * `unsupported`: a run that silently returns zero creators looks like a
 * product failure, not a configuration one.
 */
export function planPlatforms(selected: string[] | null | undefined): PlatformPlan {
  const raw = (selected ?? []).map((p) => `${p}`.trim().toLowerCase()).filter((p) => p !== '');
  const scrape: CandidatePlatform[] = [];
  const unsupported: string[] = [];

  for (const p of raw) {
    if ((SUPPORTED_DISCOVERY_PLATFORMS as readonly string[]).includes(p)) {
      const known = p as CandidatePlatform;
      if (!scrape.includes(known)) scrape.push(known);
    } else if (!unsupported.includes(p)) {
      unsupported.push(p);
    }
  }

  if (scrape.length === 0) scrape.push('tiktok');
  // Pipeline order, not selection order: TikTok is the cheaper, better-tested
  // path and should land its results first if the run hits a cap.
  scrape.sort(
    (a, b) =>
      SUPPORTED_DISCOVERY_PLATFORMS.indexOf(a) - SUPPORTED_DISCOVERY_PLATFORMS.indexOf(b),
  );

  return { scrape, unsupported };
}
