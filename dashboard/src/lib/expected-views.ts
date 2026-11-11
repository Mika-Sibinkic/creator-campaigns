// src/lib/expected-views.ts
//
// How many views a creator's next post can be expected to get, read from their
// own recent history. The denominator of every CPM this project computes before
// a deal is measured (CPM slice S1).
//
// Pure. No I/O, no clock — the caller passes `nowMs`.
//
// THE RULE
//   Median playCount over the creator's most recent (up to) 10 posts in
//   influencers.raw_data.posts, counting only posts at least 3 days old.
//
//   - Median, not mean: TikTok view counts are heavy-tailed. One viral post
//     would otherwise set the price of every deal with that creator.
//   - ≥3 days old: a post still collecting views understates the creator. A post
//     with no readable timestamp cannot be shown to be old enough and is left out.
//   - Fewer than 3 eligible posts → null. Two numbers are not an estimate.
//   - A missing, non-numeric or negative playCount is skipped, never read as 0.
//
// REFUSALS — null, never a guess
//   Instagram. The scrape carries no documented view count for a feed post, and
//   toDiscoveryPost (discovery-candidates.ts) deliberately never sets playCount
//   from an Instagram payload: an inferred field becoming a claimed view count
//   is the fabrication this codebase refuses. Refused here by platform, so a
//   vendor key that happens to be called playCount cannot leak in either.
//   Any platform other than TikTok is refused the same way (fail closed): the
//   rule above was written for, and is only known to hold on, TikTok payloads.

/** How many recent posts the median looks at. */
export const EXPECTED_VIEWS_MAX_POSTS = 10;
/** Fewer eligible posts than this → no estimate. */
export const EXPECTED_VIEWS_MIN_POSTS = 3;
/** A post younger than this is still collecting views and is excluded. */
export const EXPECTED_VIEWS_MIN_AGE_DAYS = 3;

const DAY_MS = 86_400_000;

export interface ExpectedViewsEstimate {
  /** Median views, rounded to a whole view. */
  views: number;
  /** Posts the median was taken over (3..10). */
  n: number;
}

/** Post timestamp in ms: `createTime` (epoch seconds, Apify TikTok) or `createTimeISO`. */
function postTimeMs(p: Record<string, unknown>): number | null {
  const ct = p.createTime;
  if (typeof ct === 'number' && Number.isFinite(ct) && ct > 0) return ct * 1000;
  if (typeof p.createTimeISO === 'string') {
    const t = Date.parse(p.createTimeISO);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function expectedViews(input: {
  platform: string | null | undefined;
  raw_data: unknown;
  nowMs: number;
}): ExpectedViewsEstimate | null {
  if (String(input.platform ?? '').trim().toLowerCase() !== 'tiktok') return null;
  const raw = input.raw_data;
  if (!raw || typeof raw !== 'object') return null;
  const posts = (raw as { posts?: unknown }).posts;
  if (!Array.isArray(posts)) return null;

  const eligible: Array<{ at: number; views: number }> = [];
  for (const p of posts) {
    if (!p || typeof p !== 'object') continue;
    const rec = p as Record<string, unknown>;
    const views = rec.playCount;
    if (typeof views !== 'number' || !Number.isFinite(views) || views < 0) continue;
    const at = postTimeMs(rec);
    if (at == null) continue;
    if (input.nowMs - at < EXPECTED_VIEWS_MIN_AGE_DAYS * DAY_MS) continue;
    eligible.push({ at, views });
  }

  const recent = eligible.sort((a, b) => b.at - a.at).slice(0, EXPECTED_VIEWS_MAX_POSTS);
  if (recent.length < EXPECTED_VIEWS_MIN_POSTS) return null;
  const sorted = recent.map((r) => r.views).sort((a, b) => a - b);
  return { views: Math.round(median(sorted)), n: recent.length };
}
