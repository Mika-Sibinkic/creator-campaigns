// src/lib/rate-limit.ts
//
// SEC-2: per-IP in-memory sliding-window rate limiter.
//
// Why in-memory (no Upstash/Redis): a single-region deploy with few users
// needs nothing more. Limits are advisory ("don't hammer the
// expensive endpoints"); a determined attacker could spread across multiple
// instances. We can swap this for Upstash later without changing callers.
//
// Buckets are keyed by `${tier}:${ip}` so the three tiers don't share
// quota. A periodic GC keeps the Map bounded.
//
// Usage:
//   const limit = tieredLimit(req, 'expensive');
//   if (!limit.ok) return NextResponse.json(
//     { error: 'rate_limited', resetAt: limit.resetAt },
//     { status: 429,
//       headers: { 'Retry-After': String(Math.ceil((limit.resetAt - Date.now())/1000)) } }
//   );

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): { ok: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { ok: true, remaining: limit - 1, resetAt };
  }
  bucket.count++;
  return {
    ok: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt,
  };
}

export type RateLimitTier = 'public' | 'auth' | 'expensive';

// Exported so callers that must PACE themselves against a tier (the /outreach
// bulk-send loop) can read the real number instead of guessing one. See the
// duplicated constants in src/lib/outreach-send-copy.ts and the equality
// assertion in tests/outreach-status.test.ts.
export const TIER_CONFIG: Record<RateLimitTier, { limit: number; windowMs: number }> = {
  // 30 req/min — public/unauthed endpoints (webhooks, CSP reports)
  public:    { limit: 30,  windowMs: 60_000 },
  // 120 req/min — authed UI CRUD
  auth:      { limit: 120, windowMs: 60_000 },
  // 5 req/min — anything that costs $$ or burns external quota
  expensive: { limit: 5,   windowMs: 60_000 },
};

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get('x-real-ip');
  if (real) return real;
  return 'unknown';
}

export function tieredLimit(
  req: Request,
  tier: RateLimitTier
): { ok: boolean; remaining: number; resetAt: number; tier: RateLimitTier } {
  const ip = clientIp(req);
  const cfg = TIER_CONFIG[tier];
  const r = rateLimit(`${tier}:${ip}`, cfg.limit, cfg.windowMs);
  return { ok: r.ok, remaining: r.remaining, resetAt: r.resetAt, tier };
}

/**
 * Build the standard 429 response for a rejected rate-limit check.
 * Centralized so every route emits the same shape + Retry-After header.
 */
export function rateLimited(
  resetAt: number
): { body: { error: string; resetAt: number }; init: ResponseInit } {
  const retryAfterSec = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return {
    body: { error: 'rate_limited', resetAt },
    init: {
      status: 429,
      headers: { 'Retry-After': String(retryAfterSec) },
    },
  };
}

// Periodic cleanup so old/expired buckets don't leak forever. Idempotent —
// safe to import multiple times in one process (Next.js dev hot-reload).
const GC_INTERVAL_MS = 60_000;
declare global {
  var __creator_campaigns_rate_limit_gc__: NodeJS.Timeout | undefined;
}
if (!globalThis.__creator_campaigns_rate_limit_gc__) {
  globalThis.__creator_campaigns_rate_limit_gc__ = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) {
      if (v.resetAt < now) buckets.delete(k);
    }
  }, GC_INTERVAL_MS);
  // Don't keep the event loop alive purely for GC.
  if (typeof globalThis.__creator_campaigns_rate_limit_gc__.unref === 'function') {
    globalThis.__creator_campaigns_rate_limit_gc__.unref();
  }
}
