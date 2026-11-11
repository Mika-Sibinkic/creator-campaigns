// src/lib/comments-provider.ts
//
// Where the comment-quality audit gets its comments. Provider-agnostic: the
// audit (comment-audit-run.ts) only calls fetchRecentComments() and reads the
// per-creator cost estimate; it never knows which vendor answered.
//
// Selection: COMMENTS_PROVIDER=scrapecreators|apify. ScrapeCreators is used
// only when SCRAPECREATORS_API_KEY is set (and is the default then, unless
// COMMENTS_PROVIDER=apify); with no key it is always Apify, whose key exists.
//
// PRICES, per comment fetched (the estimate the per-run cap reserves before a
// call; the ledger records what was actually charged):
//   Apify TikTok      $0.001     BRONZE tier of clockworks/tiktok-comments-scraper
//   Apify Instagram   $0.0023    BRONZE tier of apify/instagram-comment-scraper
//     Prices checked 2026-10-01 at api.apify.com (actor pricingInfos). Apify
//     bills by account tier; on FREE the cost is ~25% higher, and the 1.5x
//     per-creator ceiling still bounds it.
//   ScrapeCreators    $0.00188 per credit (Freelance pack, $47 / 25,000),
//     checked 2026-10-01 at scrapecreators.com. Credits per call are read off
//     each response's `credits_charged` (shown in the OpenAPI examples); 1 per
//     call is assumed when it is absent.
//   ScrapeCreators page sizes: TikTok comments ~20 per page (the OpenAPI
//     example returns cursor 20). Instagram's page size is not documented;
//     15 is assumed for the estimate.

import type { PostComments, RawComment } from './comment-audit';
import {
  scrapeInstagramComments,
  scrapeTikTokComments,
  type CommentActorItem,
  type CommentScrapeResult,
} from './apify';

export type CommentsProviderName = 'apify' | 'scrapecreators';
export type AuditPlatform = 'tiktok' | 'instagram';

export interface FetchRecentCommentsInput {
  platform: AuditPlatform;
  username: string;
  /** Post URLs already stored in raw_data, newest first. May be fewer than postsWanted. */
  postUrls: string[];
  postsWanted: number;
  perPost: number;
  /** The most this creator's fetch may be charged. */
  maxChargeUsd: number;
  timeoutSecs: number;
}

export interface ProviderLedgerRow {
  source: string;
  endpoint: string;
  cost_usd: number;
  records_returned: number;
  latency_ms: number;
  request_meta: Record<string, unknown>;
}

export interface FetchRecentCommentsResult {
  posts: PostComments[];
  costUsd: number;
  costKnown: boolean;
  /** Provider run/request ids, for creator_comment_audits.apify_run_id. */
  runIds: string[];
  ledger: ProviderLedgerRow[];
  notes: string[];
}

export interface CommentsProvider {
  name: CommentsProviderName;
  /** Pre-call USD estimate for one creator (what the cap reserves). */
  estimateCreatorUsd(platform: AuditPlatform, postsWanted: number, perPost: number): number;
  fetchRecentComments(input: FetchRecentCommentsInput): Promise<FetchRecentCommentsResult>;
}

const clean = (u: string) => u.split('?')[0];

function toComments(texts: Array<string | undefined | null>, authors: Array<string | undefined | null>, perPost: number): RawComment[] {
  const out: RawComment[] = [];
  texts.forEach((t, i) => {
    if (typeof t !== 'string' || t.trim() === '') return;
    if (out.length >= perPost) return;
    out.push({ text: t, author: authors[i] ?? null });
  });
  return out;
}

// ── Apify ───────────────────────────────────────────────────────────────────

export const APIFY_TIKTOK_USD_PER_COMMENT = 0.001;
export const APIFY_INSTAGRAM_USD_PER_COMMENT = 0.0023;

export interface ApifyCommentDeps {
  tiktok: typeof scrapeTikTokComments;
  instagram: typeof scrapeInstagramComments;
}

export function apifyCommentsProvider(
  deps: ApifyCommentDeps = { tiktok: scrapeTikTokComments, instagram: scrapeInstagramComments },
): CommentsProvider {
  return {
    name: 'apify',
    estimateCreatorUsd(platform, postsWanted, perPost) {
      const per = platform === 'tiktok' ? APIFY_TIKTOK_USD_PER_COMMENT : APIFY_INSTAGRAM_USD_PER_COMMENT;
      return postsWanted * perPost * per;
    },
    async fetchRecentComments(input) {
      if (input.platform === 'tiktok') return apifyTikTok(deps, input);
      return apifyInstagram(deps, input);
    },
  };
}

async function apifyTikTok(deps: ApifyCommentDeps, input: FetchRecentCommentsInput): Promise<FetchRecentCommentsResult> {
  const byUrl = input.postUrls.length >= input.postsWanted;
  const t0 = Date.now();
  const r: CommentScrapeResult = await deps.tiktok({
    ...(byUrl
      ? { postURLs: input.postUrls.slice(0, input.postsWanted) }
      : { profiles: [input.username], postsPerProfile: input.postsWanted }),
    commentsPerPost: input.perPost,
    maxTotalChargeUsd: input.maxChargeUsd,
    timeoutSecs: input.timeoutSecs,
  });
  // Group by the video the comment is under, in first-seen order.
  const groups = new Map<string, CommentActorItem[]>();
  for (const it of r.items) {
    if (it.errorCode) continue;
    const url = typeof it.videoWebUrl === 'string' ? clean(it.videoWebUrl) : '';
    if (!url) continue;
    if (!groups.has(url)) groups.set(url, []);
    groups.get(url)!.push(it);
  }
  const order = byUrl ? input.postUrls.slice(0, input.postsWanted).map(clean) : [...groups.keys()];
  const posts: PostComments[] = order
    .filter((u) => groups.has(u))
    .slice(0, input.postsWanted)
    .map((u) => {
      const items = groups.get(u)!;
      return {
        post_url: u,
        comments: toComments(items.map((i) => i.text), items.map((i) => i.uniqueId), input.perPost),
      };
    });
  return {
    posts,
    costUsd: r.costUsd,
    costKnown: r.costKnown,
    runIds: r.runId ? [r.runId] : [],
    ledger: [
      {
        source: 'apify',
        endpoint: 'tiktok-comments-scraper',
        cost_usd: r.costUsd,
        records_returned: r.items.length,
        latency_ms: Date.now() - t0,
        request_meta: { runId: r.runId, status: r.status, cost_known: r.costKnown, mode: byUrl ? 'post_urls' : 'profile', purpose: 'comment-audit' },
      },
    ],
    notes: r.status === 'SUCCEEDED' ? [] : [`tiktok comments run ended ${r.status}`],
  };
}

async function apifyInstagram(deps: ApifyCommentDeps, input: FetchRecentCommentsInput): Promise<FetchRecentCommentsResult> {
  // Items carry no post URL, so one run per post, in parallel.
  const urls = input.postUrls.slice(0, input.postsWanted);
  if (urls.length === 0) {
    return { posts: [], costUsd: 0, costKnown: true, runIds: [], ledger: [], notes: ['no stored instagram post urls'] };
  }
  const perRunCap = input.maxChargeUsd / urls.length;
  const runs = await Promise.all(
    urls.map(async (url) => {
      const t0 = Date.now();
      try {
        const r = await deps.instagram({
          postUrl: url,
          resultsLimit: input.perPost,
          maxTotalChargeUsd: perRunCap,
          timeoutSecs: input.timeoutSecs,
        });
        return { url, r, ms: Date.now() - t0, err: null as string | null };
      } catch (e) {
        return { url, r: null, ms: Date.now() - t0, err: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const posts: PostComments[] = [];
  const ledger: ProviderLedgerRow[] = [];
  const notes: string[] = [];
  let cost = 0;
  let known = true;
  const runIds: string[] = [];
  for (const run of runs) {
    if (!run.r) {
      notes.push(`instagram comments failed for a post: ${run.err?.slice(0, 120)}`);
      continue;
    }
    cost += run.r.costUsd;
    if (!run.r.costKnown) known = false;
    if (run.r.runId) runIds.push(run.r.runId);
    const items = run.r.items.filter((i) => !i.errorCode);
    posts.push({
      post_url: clean(run.url),
      comments: toComments(items.map((i) => i.text), items.map((i) => i.ownerUsername), input.perPost),
    });
    ledger.push({
      source: 'apify',
      endpoint: 'instagram-comment-scraper',
      cost_usd: run.r.costUsd,
      records_returned: run.r.items.length,
      latency_ms: run.ms,
      request_meta: { runId: run.r.runId, status: run.r.status, cost_known: run.r.costKnown, purpose: 'comment-audit' },
    });
  }
  return { posts, costUsd: cost, costKnown: known, runIds, ledger, notes };
}

// ── ScrapeCreators ──────────────────────────────────────────────────────────
//
// Endpoints and parameters, checked 2026-10-01 against
// https://docs.scrapecreators.com/openapi.json:
//   GET /v3/tiktok/profile/videos?handle=&sort_by=latest   → { aweme_list: [{ aweme_id, ... }] }
//   GET /v1/tiktok/video/comments?url=&cursor=             → { comments: [{ text, user: { unique_id } }], cursor, total }
//   GET /v2/instagram/post/comments?url=&cursor=           → { comments: [{ text, user: { username } }], cursor }
// Auth header x-api-key; base https://api.scrapecreators.com.
// `is_top` (pinned) on a profile-videos item is not documented; it is honoured
// when present and ignored otherwise.

export const SCRAPECREATORS_BASE_URL = 'https://api.scrapecreators.com';
export const SCRAPECREATORS_USD_PER_CREDIT = 0.00188;
export const SCRAPECREATORS_TIKTOK_PAGE = 20;
export const SCRAPECREATORS_INSTAGRAM_PAGE = 15;

type FetchFn = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ScrapeCreatorsDeps {
  apiKey: string;
  fetch?: FetchFn;
  usdPerCredit?: number;
}

export function scrapeCreatorsProvider(deps: ScrapeCreatorsDeps): CommentsProvider {
  const usdPerCredit = deps.usdPerCredit ?? SCRAPECREATORS_USD_PER_CREDIT;
  const doFetch: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchFn>);
  return {
    name: 'scrapecreators',
    estimateCreatorUsd(platform, postsWanted, perPost) {
      const page = platform === 'tiktok' ? SCRAPECREATORS_TIKTOK_PAGE : SCRAPECREATORS_INSTAGRAM_PAGE;
      const credits = (platform === 'tiktok' ? 1 : 0) + postsWanted * Math.ceil(perPost / page);
      return credits * usdPerCredit;
    },
    async fetchRecentComments(input) {
      return scFetch(doFetch, deps.apiKey, usdPerCredit, input);
    },
  };
}

async function scGet(
  doFetch: FetchFn,
  apiKey: string,
  path: string,
  params: Record<string, string>,
  timeoutSecs: number,
): Promise<{ body: Record<string, unknown> | null; credits: number; ms: number; status: number; error: string | null }> {
  const qs = new URLSearchParams(params).toString();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1, timeoutSecs) * 1000);
  const t0 = Date.now();
  try {
    const res = await doFetch(`${SCRAPECREATORS_BASE_URL}${path}?${qs}`, {
      headers: { 'x-api-key': apiKey },
      signal: ac.signal,
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const charged = Number(body?.credits_charged);
    const credits = Number.isFinite(charged) && charged >= 0 ? charged : res.ok ? 1 : 0;
    if (!res.ok || body?.success === false) {
      return { body: null, credits, ms: Date.now() - t0, status: res.status, error: `http ${res.status}` };
    }
    return { body, credits, ms: Date.now() - t0, status: res.status, error: null };
  } catch (e) {
    return { body: null, credits: 0, ms: Date.now() - t0, status: 0, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function scFetch(
  doFetch: FetchFn,
  apiKey: string,
  usdPerCredit: number,
  input: FetchRecentCommentsInput,
): Promise<FetchRecentCommentsResult> {
  const ledger: ProviderLedgerRow[] = [];
  const notes: string[] = [];
  let credits = 0;
  const maxCredits = Math.floor(input.maxChargeUsd / usdPerCredit);
  const record = (endpoint: string, r: { credits: number; ms: number; status: number; error: string | null }, n: number) => {
    credits += r.credits;
    ledger.push({
      source: 'scrapecreators',
      endpoint,
      cost_usd: r.credits * usdPerCredit,
      records_returned: n,
      latency_ms: r.ms,
      request_meta: { credits: r.credits, status: r.status, error: r.error, purpose: 'comment-audit' },
    });
  };

  let urls = input.postUrls.slice(0, input.postsWanted);
  if (input.platform === 'tiktok' && urls.length < input.postsWanted) {
    const r = await scGet(doFetch, apiKey, '/v3/tiktok/profile/videos', { handle: input.username, sort_by: 'latest' }, input.timeoutSecs);
    const list = Array.isArray(r.body?.aweme_list) ? (r.body!.aweme_list as Array<Record<string, unknown>>) : [];
    record('tiktok-profile-videos', r, list.length);
    const recent = list
      .filter((v) => v && typeof v.aweme_id === 'string' && v.is_top !== 1 && v.is_top !== true)
      .map((v) => `https://www.tiktok.com/@${input.username}/video/${v.aweme_id as string}`);
    if (recent.length > 0) urls = recent.slice(0, input.postsWanted);
    else if (r.error) notes.push(`tiktok profile videos failed: ${r.error}`);
  }

  const path = input.platform === 'tiktok' ? '/v1/tiktok/video/comments' : '/v2/instagram/post/comments';
  const endpoint = input.platform === 'tiktok' ? 'tiktok-video-comments' : 'instagram-post-comments';
  const page = input.platform === 'tiktok' ? SCRAPECREATORS_TIKTOK_PAGE : SCRAPECREATORS_INSTAGRAM_PAGE;
  const maxPages = Math.ceil(input.perPost / page) + 1;

  const posts: PostComments[] = [];
  for (const url of urls) {
    const texts: string[] = [];
    const authors: Array<string | null> = [];
    let cursor: string | null = null;
    for (let p = 0; p < maxPages && texts.length < input.perPost; p++) {
      if (credits >= maxCredits) {
        notes.push('stopped at the per-creator charge ceiling');
        break;
      }
      const params: Record<string, string> = { url };
      if (cursor) params.cursor = cursor;
      const r = await scGet(doFetch, apiKey, path, params, input.timeoutSecs);
      const comments = Array.isArray(r.body?.comments) ? (r.body!.comments as Array<Record<string, unknown>>) : [];
      record(endpoint, r, comments.length);
      if (r.error) {
        notes.push(`${endpoint} failed: ${r.error}`);
        break;
      }
      for (const c of comments) {
        const user = (c.user ?? {}) as Record<string, unknown>;
        texts.push(typeof c.text === 'string' ? c.text : '');
        authors.push(typeof user.unique_id === 'string' ? user.unique_id : typeof user.username === 'string' ? user.username : null);
      }
      const next = r.body?.cursor;
      const nextCursor = next == null || next === '' ? null : String(next);
      if (comments.length === 0 || !nextCursor || nextCursor === cursor) break;
      if (r.body?.has_more === false) break;
      cursor = nextCursor;
    }
    posts.push({ post_url: clean(url), comments: toComments(texts, authors, input.perPost) });
  }

  return {
    posts,
    costUsd: credits * usdPerCredit,
    costKnown: true,
    runIds: [],
    ledger,
    notes,
  };
}

// ── Selection ───────────────────────────────────────────────────────────────

export function resolveCommentsProviderName(env: Record<string, string | undefined> = process.env): CommentsProviderName {
  // Explicit apify wins. Otherwise ScrapeCreators whenever its key is set
  // (named, or as the default when COMMENTS_PROVIDER is unset); no key → apify.
  const want = (env.COMMENTS_PROVIDER ?? '').trim().toLowerCase();
  const key = (env.SCRAPECREATORS_API_KEY ?? '').trim();
  if (want === 'apify' || key === '') return 'apify';
  return 'scrapecreators';
}

export function selectCommentsProvider(env: Record<string, string | undefined> = process.env): CommentsProvider {
  if (resolveCommentsProviderName(env) === 'scrapecreators') {
    return scrapeCreatorsProvider({ apiKey: (env.SCRAPECREATORS_API_KEY ?? '').trim() });
  }
  return apifyCommentsProvider();
}
