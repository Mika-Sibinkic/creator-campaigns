// src/lib/apify.ts
import { ApifyClient } from 'apify-client';
import { getEnv } from './env';

const TIKTOK_ACTOR_ID = 'clockworks/tiktok-scraper';

/**
 * Instagram creator search.
 *
 * `apify/instagram-search-scraper` (store id DrF9mzPPEuVizVF4l) is the only
 * official Instagram actor whose INPUT is free text and whose OUTPUT is a
 * creator profile, which is exactly the shape this pipeline needs: the run
 * route already has generated search queries and needs follower + engagement
 * numbers back.
 *
 * The two rejected alternatives, so nobody re-litigates this:
 *   - apify/instagram-hashtag-scraper returns POSTS carrying only
 *     `ownerUsername` and no follower count, so every creator would need a
 *     second profile call. Two actors, two bills, for one answer.
 *   - apify/instagram-api-scraper's search path is $6.00/1,000 results
 *     against this actor's $2.70 — 2.2x for the identical output shape.
 */
const INSTAGRAM_ACTOR_ID = 'apify/instagram-search-scraper';

let _client: ApifyClient | null = null;
function client() {
  if (_client) return _client;
  _client = new ApifyClient({ token: getEnv('APIFY_TOKEN') });
  return _client;
}

export interface TikTokScrapeInput {
  searchQueries?: string[];
  profiles?: string[];
  resultsPerPage?: number;
  maxProfilesPerQuery?: number;
  // Pre-scrape bot filter: bound the follower window inside the actor so we
  // don't pay to ingest profiles that the normalize-time filter would just
  // discard. Forwarded as-is; the clockworks/tiktok-scraper actor reads
  // these on profile-search inputs and silently ignores them on
  // result shapes where they don't apply.
  followersMoreThan?: number;
  followersLessThan?: number;
}

export interface TikTokProfile {
  authorMeta?: {
    name?: string;
    nickName?: string;
    fans?: number;
    following?: number;
    heart?: number;
    video?: number;
    digg?: number;
    verified?: boolean;
    signature?: string;
    avatar?: string;
    profileUrl?: string;
  };
  text?: string;
  diggCount?: number;
  shareCount?: number;
  playCount?: number;
  commentCount?: number;
  createTime?: number;
  webVideoUrl?: string;
  videoMeta?: { duration?: number };
  hashtags?: { name: string }[];
  [k: string]: unknown;
}

export interface TikTokScrapeResult {
  profiles: TikTokProfile[];
  costUsd: number;
  runId: string;
  defaultDatasetId: string;
  durationMs: number;
}

// ── Instagram ───────────────────────────────────────────────────────────────

export interface InstagramScrapeInput {
  /** Free-text search terms. Sent to the actor as ONE comma-joined string. */
  searchTerms: string[];
  /** Profiles per term. Actor maximum is 250. */
  searchLimit?: number;
  /** Charge ceiling in dataset items. See the note in scrapeInstagram. */
  maxItems?: number;
  /** Hard USD ceiling for this run, enforced by Apify, not by us. */
  maxTotalChargeUsd?: number;
  /** Actor run timeout in SECONDS (apify-client's unit, not milliseconds). */
  timeoutSecs?: number;
}

/**
 * One item of an instagram-search-scraper `latestPosts[]` entry.
 *
 * Deliberately all-optional with an index signature: this is a vendor payload
 * that has changed shape before, and a missing engagement field must degrade
 * to "unknown" rather than throw. The readers in discovery-candidates.ts
 * accept several spellings for the same number for the same reason.
 */
export interface InstagramPost {
  caption?: string;
  likesCount?: number;
  commentsCount?: number;
  /**
   * Two spellings, neither reliable alone. The actor's published
   * `latestPosts` samples carry `videoViewCount`, which Apify's own field
   * description marks "deprecated by Instagram; may be null or stale, prefer
   * videoPlayCount" — while `videoPlayCount` is only declared on the
   * top-level post shape. Read both and coalesce; `Image` posts have neither.
   */
  videoPlayCount?: number;
  videoViewCount?: number;
  /** ISO 8601, e.g. "2025-08-21T09:13:01.000Z". */
  timestamp?: string;
  url?: string;
  /** "Image" | "Video" | "Sidecar", per Apify's field description. */
  type?: string;
  /** Parsed from the caption, WITHOUT a leading '#'. */
  hashtags?: string[];
  [k: string]: unknown;
}

export interface InstagramProfile {
  username?: string;
  fullName?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
  verified?: boolean;
  isBusinessAccount?: boolean;
  biography?: string;
  externalUrl?: string;
  profilePicUrlHD?: string;
  profilePicUrl?: string;
  latestPosts?: InstagramPost[];
  [k: string]: unknown;
}

export interface InstagramScrapeResult {
  profiles: InstagramProfile[];
  /** 0 when costKnown is false — read costKnown before trusting this. */
  costUsd: number;
  /**
   * Whether Apify actually reported a cost for this run.
   *
   * `run.usageTotalUsd` is optional on ActorRun (apify-client 2.23.1,
   * resource_clients/actor.d.ts:472), and the TikTok path collapses a missing
   * value to 0 with `?? 0`. To be clear about what is and is not known here:
   * no silent-$0 row has ever been OBSERVED — production TikTok figures
   * reconcile against the actor's per-result price, so the field does carry
   * event charges in practice. This flag exists because the type permits
   * absence and a ledger row on a SHARED credit pool should not assert a
   * measured zero it cannot distinguish from a missing one. Callers may
   * ledger 0; they must not report it as measured.
   */
  costKnown: boolean;
  runId: string;
  defaultDatasetId: string;
  /** Apify run status, e.g. 'SUCCEEDED' / 'TIMED-OUT' / 'ABORTED'. */
  status: string;
  durationMs: number;
}

/**
 * The exact payload sent to instagram-search-scraper.
 *
 * Exported so a hermetic test can pin it, because this is a payload whose
 * mistakes are SILENT: Apify ignores unknown input keys, so a misspelled or
 * imagined field produces no error, no warning, and a full bill for a run
 * that did the wrong thing. Four keys in particular must never appear here —
 * `enhanceUserSearchWithFacebookPage` (hidden, legally fraught),
 * `isUserTaggedFeedURL`, `isUserReelFeedURL` (not inputs on this actor), and
 * any proxy/country configuration (this actor has none). A test asserts their
 * absence rather than trusting a comment to hold the line.
 */
export function buildInstagramActorInput(
  searchTerms: string[],
  searchLimit?: number,
): Record<string, unknown> {
  return {
    // The actor takes ONE comma-separated string, not an array of terms.
    search: searchTerms.join(','),
    // Wire value is 'user'. The rendered docs page shows a display title
    // ("Profiles"); the build API shows what the actor actually parses, and
    // the enum is ['place','user','hashtag','popular'] with a default of
    // 'place'. So this is not optional and 'profiles' is not a value: omit it
    // or misspell it and the actor happily searches LOCATIONS instead, at
    // full price, returning nothing this pipeline can use.
    searchType: 'user',
    // A non-positive limit is treated as "not specified", matching how this
    // codebase reads every other numeric pref. Clamping 0 up to 1 instead
    // would pay for a one-result-per-term run that nobody asked for; whether
    // to scrape Instagram at all is planPlatforms' decision, not this one's.
    searchLimit:
      typeof searchLimit === 'number' && searchLimit > 0
        ? Math.min(Math.floor(searchLimit), 250)
        : 25,
  };
}

/**
 * Search Instagram for creator profiles.
 *
 * Deliberate omissions — every one of these is a field that DOES NOT EXIST on
 * this actor, and Apify silently ignores unknown input keys, so a typo here
 * fails with no error and a full bill:
 *   - `enhanceUserSearchWithFacebookPage` — hidden in the schema and carries a
 *     legal warning; not ours to enable
 *   - `isUserTaggedFeedURL`, `isUserReelFeedURL` — not inputs on this actor
 *   - proxy / country configuration — this actor has no proxy input at all,
 *     which is why the region work in creator-region.ts is a post-filter and
 *     not a scrape parameter
 *
 * No retry, on purpose. `.call()` already waits for the run to finish, so a
 * retry would mean a SECOND billed run against shared credit on a failure we
 * cannot classify from here. The caller sees `status` and decides.
 */
export async function scrapeInstagram(
  input: InstagramScrapeInput,
): Promise<InstagramScrapeResult> {
  const start = Date.now();
  const c = client();

  const terms = input.searchTerms.map((t) => t.trim()).filter((t) => t !== '');
  if (terms.length === 0) {
    return {
      profiles: [],
      costUsd: 0,
      costKnown: true,
      runId: '',
      defaultDatasetId: '',
      status: 'SKIPPED',
      durationMs: 0,
    };
  }

  const actorInput = buildInstagramActorInput(terms, input.searchLimit);

  // maxItems / maxTotalChargeUsd are CHARGE ceilings the platform enforces,
  // not result limits the client applies: Apify's own docs say maxItems does
  // not guarantee the run returns at most that many items. Both are set
  // anyway, because the thing worth bounding here is the bill on shared
  // credit, and this route's own APIFY_PER_RUN_USD_CAP is only checked AFTER
  // a scrape returns — i.e. after Apify has already charged.
  const callOptions: {
    maxItems?: number;
    maxTotalChargeUsd?: number;
    timeout?: number;
  } = {};
  if (typeof input.maxItems === 'number' && input.maxItems > 0) {
    callOptions.maxItems = Math.floor(input.maxItems);
  }
  if (typeof input.maxTotalChargeUsd === 'number' && input.maxTotalChargeUsd > 0) {
    callOptions.maxTotalChargeUsd = input.maxTotalChargeUsd;
  }
  if (typeof input.timeoutSecs === 'number' && input.timeoutSecs > 0) {
    callOptions.timeout = Math.floor(input.timeoutSecs);
  }

  const run = await c.actor(INSTAGRAM_ACTOR_ID).call(actorInput, callOptions);
  const dataset = await c.dataset(run.defaultDatasetId).listItems();
  const usage = run.usageTotalUsd;

  return {
    profiles: dataset.items as InstagramProfile[],
    costUsd: typeof usage === 'number' ? usage : 0,
    costKnown: typeof usage === 'number',
    runId: run.id,
    defaultDatasetId: run.defaultDatasetId,
    status: run.status,
    durationMs: Date.now() - start,
  };
}

// ── Comment actors (comment-quality audit, src/lib/comment-audit.ts) ────────
//
// Prices, checked 2026-10-01 at api.apify.com/v2/acts/<actor> pricingInfos:
//   clockworks/tiktok-comments-scraper  pay-per-event, per comment:
//     FREE $0.00125 · BRONZE $0.001 · SILVER $0.00075 (tiered).
//     minimalMaxTotalChargeUsd 0.5: a per-run charge ceiling below $0.50 is
//     not accepted, so callers pass at least that.
//   apify/instagram-comment-scraper     pay-per-event, per comment:
//     FREE $0.0026 · BRONZE $0.0023 · SILVER $0.0021 (tiered).
// Input + output field names, checked 2026-10-01 against each actor's store
// page. TikTok items carry `videoWebUrl`; Instagram items carry NO post URL,
// which is why Instagram is fetched one post per run.

const TIKTOK_COMMENTS_ACTOR_ID = 'clockworks/tiktok-comments-scraper';
const INSTAGRAM_COMMENTS_ACTOR_ID = 'apify/instagram-comment-scraper';
export const TIKTOK_COMMENTS_MIN_CHARGE_USD = 0.5;

export interface CommentActorItem {
  text?: string;
  uniqueId?: string;
  ownerUsername?: string;
  videoWebUrl?: string;
  errorCode?: string;
  [k: string]: unknown;
}

export interface CommentScrapeResult {
  items: CommentActorItem[];
  /** 0 when costKnown is false. */
  costUsd: number;
  costKnown: boolean;
  runId: string;
  status: string;
  durationMs: number;
}

/**
 * The exact payload for clockworks/tiktok-comments-scraper. Either post URLs,
 * or a handle whose most recent posts the actor resolves itself (pinned posts
 * excluded, so a creator's old viral pin does not stand in for "recent").
 * Exported so a hermetic test pins it: Apify ignores unknown keys silently.
 */
export function buildTikTokCommentsInput(input: {
  postURLs?: string[];
  profiles?: string[];
  postsPerProfile?: number;
  commentsPerPost: number;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    commentsPerPost: Math.max(1, Math.floor(input.commentsPerPost)),
    maxRepliesPerComment: 0,
  };
  if (input.profiles && input.profiles.length > 0) {
    return {
      ...base,
      profiles: input.profiles,
      resultsPerPage: Math.max(1, Math.floor(input.postsPerProfile ?? 3)),
      profileSorting: 'latest',
      excludePinnedPosts: true,
    };
  }
  return { ...base, postURLs: input.postURLs ?? [] };
}

/** The exact payload for apify/instagram-comment-scraper (post/reel URLs only). */
export function buildInstagramCommentsInput(input: {
  directUrls: string[];
  resultsLimit: number;
}): Record<string, unknown> {
  return {
    directUrls: input.directUrls,
    resultsLimit: Math.max(1, Math.floor(input.resultsLimit)),
    includeNestedComments: false,
  };
}

async function runCommentActor(
  actorId: string,
  actorInput: Record<string, unknown>,
  opts: { maxItems?: number; maxTotalChargeUsd?: number; timeoutSecs?: number },
): Promise<CommentScrapeResult> {
  const start = Date.now();
  const c = client();
  const callOptions: { maxItems?: number; maxTotalChargeUsd?: number; timeout?: number } = {};
  if (typeof opts.maxItems === 'number' && opts.maxItems > 0) callOptions.maxItems = Math.floor(opts.maxItems);
  if (typeof opts.maxTotalChargeUsd === 'number' && opts.maxTotalChargeUsd > 0) {
    callOptions.maxTotalChargeUsd = opts.maxTotalChargeUsd;
  }
  if (typeof opts.timeoutSecs === 'number' && opts.timeoutSecs > 0) callOptions.timeout = Math.floor(opts.timeoutSecs);
  const run = await c.actor(actorId).call(actorInput, callOptions);
  // A TIMED-OUT run still has a dataset; whatever landed is usable and billed.
  const dataset = await c.dataset(run.defaultDatasetId).listItems();
  const usage = run.usageTotalUsd;
  return {
    items: dataset.items as CommentActorItem[],
    costUsd: typeof usage === 'number' ? usage : 0,
    costKnown: typeof usage === 'number',
    runId: run.id,
    status: run.status,
    durationMs: Date.now() - start,
  };
}

/** TikTok comments. No retry: a retry is a second billed run on shared credit. */
export async function scrapeTikTokComments(input: {
  postURLs?: string[];
  profiles?: string[];
  postsPerProfile?: number;
  commentsPerPost: number;
  maxTotalChargeUsd?: number;
  timeoutSecs?: number;
}): Promise<CommentScrapeResult> {
  const actorInput = buildTikTokCommentsInput(input);
  const posts = input.profiles?.length
    ? input.profiles.length * Math.max(1, input.postsPerProfile ?? 3)
    : (input.postURLs ?? []).length;
  return runCommentActor(TIKTOK_COMMENTS_ACTOR_ID, actorInput, {
    maxItems: posts * Math.max(1, input.commentsPerPost),
    maxTotalChargeUsd:
      typeof input.maxTotalChargeUsd === 'number'
        ? Math.max(TIKTOK_COMMENTS_MIN_CHARGE_USD, input.maxTotalChargeUsd)
        : undefined,
    timeoutSecs: input.timeoutSecs,
  });
}

/** Instagram comments for ONE post or reel (items carry no post URL). */
export async function scrapeInstagramComments(input: {
  postUrl: string;
  resultsLimit: number;
  maxTotalChargeUsd?: number;
  timeoutSecs?: number;
}): Promise<CommentScrapeResult> {
  const actorInput = buildInstagramCommentsInput({ directUrls: [input.postUrl], resultsLimit: input.resultsLimit });
  return runCommentActor(INSTAGRAM_COMMENTS_ACTOR_ID, actorInput, {
    maxItems: Math.max(1, input.resultsLimit),
    maxTotalChargeUsd: input.maxTotalChargeUsd,
    timeoutSecs: input.timeoutSecs,
  });
}

export async function scrapeTikTok(input: TikTokScrapeInput): Promise<TikTokScrapeResult> {
  const start = Date.now();
  const c = client();
  const actorInput: Record<string, unknown> = {
    searchQueries: input.searchQueries ?? [],
    profiles: input.profiles ?? [],
    resultsPerPage: input.resultsPerPage ?? 30,
    maxProfilesPerQuery: input.maxProfilesPerQuery ?? 50,
  };
  if (typeof input.followersMoreThan === 'number' && input.followersMoreThan > 0) {
    actorInput.followersMoreThan = input.followersMoreThan;
  }
  if (typeof input.followersLessThan === 'number' && input.followersLessThan > 0) {
    actorInput.followersLessThan = input.followersLessThan;
  }
  const run = await c.actor(TIKTOK_ACTOR_ID).call(actorInput);
  const dataset = await c.dataset(run.defaultDatasetId).listItems();
  const usage = run.usageTotalUsd ?? 0;
  return {
    profiles: dataset.items as TikTokProfile[],
    costUsd: usage,
    runId: run.id,
    defaultDatasetId: run.defaultDatasetId,
    durationMs: Date.now() - start,
  };
}
