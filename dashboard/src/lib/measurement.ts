// src/lib/measurement.ts
//
// Measurement core: decide WHEN to snapshot a delivered post's performance
// (poll ~1 week after delivery, then monthly), and MATCH a scraped profile's
// posts back to the deal's post_url to read current metrics. Pure logic — the
// measurement tick supplies the scraped data + writes the snapshots. Kept pure
// so the cadence + matching is unit-testable without Apify or a DB.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Is a performance snapshot due for a delivered post?
 *   - first snapshot: ~1 week after delivery,
 *   - subsequent: monthly.
 * `detectedAtMs` = when the post was verified live; `lastSnapshotMs` = the most
 * recent snapshot (null if none yet).
 */
export function isSnapshotDue(
  detectedAtMs: number,
  lastSnapshotMs: number | null,
  nowMs: number,
): boolean {
  if (lastSnapshotMs == null) {
    return nowMs - detectedAtMs >= WEEK_MS;
  }
  return nowMs - lastSnapshotMs >= MONTH_MS;
}

// ── Give-up policy for a post_url that never resolves ───────────────────────
//
// `isSnapshotDue` answers "should we look again at a post we can find". It has
// no opinion about a post we CANNOT find, and that gap was a live money leak:
// a miss wrote nothing, so `lastSnapshotMs` stayed null, so isSnapshotDue
// stayed true, so the identical scrape ran again on the next hourly tick —
// forever. A handful of deliveries whose post_url pointed at fabricated sample
// handles could burn Apify actor runs every hour, and consume the whole
// per-tick scrape budget so a real deal queued behind them would never have
// been measured.
//
// The policy: retry, but pay less each time, and eventually stop.
//
//   - The FIRST attempt is unconditional. A post genuinely can be late — the
//     creator posts, then edits the caption, then the scrape lands.
//   - Every later attempt waits 2^(n-1) × 2h: 2h, 4h, 8h, 16h, 32h. Doubling
//     is the right curve because the probability a URL is simply wrong (typo,
//     deleted post, fabricated handle) rises monotonically with each miss,
//     while the probability it is merely late falls.
//   - After MAX_RESOLVE_ATTEMPTS misses the delivery is declared `missing` and
//     never scraped again. A ceiling is what makes the cost of ONE bad row
//     finite; backoff alone only makes it grow slowly, and "slowly forever" is
//     still forever on shared credit.
//
// Six attempts spans ~62 hours, which is far longer than any honest posting
// delay, and caps a bad row at 6 scrapes total instead of ~2,600 in the same
// stretch. `missing` is not a new vocabulary word — it has been in the
// deal_deliveries status CHECK since migration 029 with no writer.

/** Misses after which a delivery is declared `missing` and left alone. */
export const MAX_RESOLVE_ATTEMPTS = 6;

/** Wait after the first miss; doubles per miss. Matches the tick's own hourly
 *  cadence at 2× so a backed-off row always skips at least one tick. */
const RESOLVE_BACKOFF_BASE_MS = 2 * 60 * 60 * 1000;

/** Ceiling on a single wait, so the curve can't overflow into absurdity. */
const RESOLVE_BACKOFF_CAP_MS = 7 * 24 * 60 * 60 * 1000;

export type ResolveDecision = 'scrape' | 'wait' | 'give_up';

/**
 * Should we spend another Apify run trying to find this post?
 *
 * `attempts` = scrapes for this delivery that did NOT match, since the most
 * recent successful snapshot. `lastAttemptMs` = when the newest of those ran.
 */
export function resolveAttemptDue(
  attempts: number,
  lastAttemptMs: number | null,
  nowMs: number,
): ResolveDecision {
  if (attempts >= MAX_RESOLVE_ATTEMPTS) return 'give_up';
  // No prior miss, or no usable timestamp on one: there is no wait to enforce.
  // Erring toward 'scrape' here is safe because the ceiling above still bounds
  // total spend even if every wait is skipped.
  if (attempts <= 0 || lastAttemptMs == null || !Number.isFinite(lastAttemptMs)) {
    return 'scrape';
  }
  const wait = Math.min(
    RESOLVE_BACKOFF_BASE_MS * 2 ** (attempts - 1),
    RESOLVE_BACKOFF_CAP_MS,
  );
  return nowMs - lastAttemptMs >= wait ? 'scrape' : 'wait';
}

export interface ScrapedPost {
  postUrl?: string;
  webVideoUrl?: string;
  id?: string;
  playCount?: number;
  diggCount?: number;
  commentCount?: number;
  shareCount?: number;
  /** Present on TikTok scrape payloads when the actor returns it (apify.ts
   *  TikTokProfile.videoMeta) — the only duration signal we have. */
  videoMeta?: { duration?: number };
}

export interface PostMetrics {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

/** Normalize a URL for comparison (strip protocol, query, trailing slash, case). */
export function normalizeUrl(u: string | null | undefined): string {
  if (!u) return '';
  return u
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[?#]/)[0]
    .replace(/\/+$/, '');
}

/**
 * Find the deal's post among a scraped profile's recent posts (match by URL,
 * then by trailing id). Null when no post matches (creator may not have
 * posted yet → deal stays 'pending'). Returns the raw scraped post so the
 * spec check can read videoMeta.duration off the same match.
 */
export function matchPost(posts: ScrapedPost[], postUrl: string): ScrapedPost | null {
  const target = normalizeUrl(postUrl);
  if (!target) return null;
  const targetId = target.split('/').pop() ?? '';
  for (const p of posts) {
    const cand = normalizeUrl(p.postUrl ?? p.webVideoUrl);
    const idMatch = targetId && (p.id === targetId || cand.endsWith(`/${targetId}`));
    if (cand === target || (cand && (cand === target || idMatch))) {
      return p;
    }
  }
  return null;
}

/** Current metrics of a matched post (see matchPost). */
export function postMetrics(p: ScrapedPost): PostMetrics {
  return {
    views: numOrNull(p.playCount),
    likes: numOrNull(p.diggCount),
    comments: numOrNull(p.commentCount),
    shares: numOrNull(p.shareCount),
  };
}

/** matchPost + postMetrics in one step (kept for existing callers/tests). */
export function matchPostMetrics(posts: ScrapedPost[], postUrl: string): PostMetrics | null {
  const p = matchPost(posts, postUrl);
  return p ? postMetrics(p) : null;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Deliverable-spec verification ────────────────────────────────────────────
//
// Once the scrape has FOUND the post (existence → status 'verified'), compare
// it against the agreed deliverable spec (creator_offers.agreed_deliverables,
// normalized by deliverables.ts). Scope honesty: a TikTok profile scrape
// returns feed videos only —
//   - it cannot distinguish a 'reel' from a 'dance_trend' from a plain video
//     'post', so the TYPE check is satisfied by any feed video when the bundle
//     contains any feed type;
//   - it cannot see 'story' items at all (ephemeral, not in the feed), so a
//     story-only bundle can never be more than 'partial';
//   - DURATION is checked against the smallest min_seconds across the agreed
//     feed lines (we can't tell which line this post fulfils, so we only call
//     'fail' when the post fails even the most lenient ask).
// Tolerance (existing default): duration >= 90% of min_seconds passes.

/** Fraction of the agreed min_seconds a post must reach to pass. */
export const SPEC_DURATION_TOLERANCE = 0.9;

/** Deliverable line shape consumed by the spec check (deliverables.ts). */
export interface SpecDeliverableLine {
  promo_type: 'story' | 'post' | 'reel' | 'dance_trend';
  min_seconds?: number | null;
}

export interface SpecCheckResult {
  check: 'pass' | 'fail' | 'partial';
  detail: string;
}

/**
 * Compare a found post against the agreed deliverables. Null when no
 * deliverables were agreed (nothing to check → nothing stamped).
 */
export function checkDeliverableSpec(
  agreed: SpecDeliverableLine[],
  post: ScrapedPost,
): SpecCheckResult | null {
  if (agreed.length === 0) return null;

  const feedLines = agreed.filter((d) => d.promo_type !== 'story');
  if (feedLines.length === 0) {
    return {
      check: 'partial',
      detail:
        'agreed bundle is story-only; the TikTok profile scrape sees feed videos, not stories',
    };
  }

  const minAsks = feedLines
    .map((d) => Number(d.min_seconds))
    .filter((s) => Number.isFinite(s) && s > 0);
  if (minAsks.length === 0) {
    return {
      check: 'pass',
      detail:
        'post found in feed; no minimum length agreed (type check only; the scrape cannot distinguish promo subtypes)',
    };
  }
  const minAsk = Math.min(...minAsks);

  const duration = Number(post.videoMeta?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    return {
      check: 'partial',
      detail: `post found but the scrape payload carries no video duration; ${minAsk}s minimum unverified`,
    };
  }

  if (duration >= SPEC_DURATION_TOLERANCE * minAsk) {
    return {
      check: 'pass',
      detail: `duration ${duration}s meets the ${minAsk}s minimum (>=90% tolerance)`,
    };
  }
  return {
    check: 'fail',
    detail: `duration ${duration}s is below 90% of the agreed ${minAsk}s minimum`,
  };
}
