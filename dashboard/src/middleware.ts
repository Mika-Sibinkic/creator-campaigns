// src/middleware.ts
//
// Clerk authenticates every request outside the public paths below; a signed-in
// user also needs a firm_members row (keyed on clerk_user_id, cached 60s), or
// API calls get 401 and pages bounce to /sign-in. /auth/clerk-bootstrap creates
// that row after sign-in. State-changing requests must be same-origin (CSRF).

import { NextRequest, NextResponse } from 'next/server';
import { clerkMiddleware } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';

// Scheduler-driven routes (pg_cron / external pinger) must not be intercepted
// by the session gate — they carry their own bearer-secret auth. The list lives
// in its own module because a missing entry here is invisible in the response:
// the middleware's 401 is byte-identical to an unmatched path's. See that file
// for the three times this has bitten, and the drift test that now pins it.
import { isCronPath } from '@/lib/cron-paths';

// Orphan-session detection: a Clerk user with no firm_members row would hit
// every API with session.firm_id === ''. Resolve it here once per user id,
// cache the answer for 60s, and bounce orphans to /sign-in?error=not_allowed.
type MembershipCacheEntry = { ts: number; ok: boolean };
const MEMBERSHIP_TTL_MS = 60_000;
const membershipCache = new Map<string, MembershipCacheEntry>();

// Paths the orphan-session check must NOT run on:
//   - /api/webhooks/* — external systems, no user session
//   - /sign-in       — landing page after we bounce them
//   - /auth/*        — /auth/clerk-bootstrap provisions the missing row
//   - /api/health(z) / /api/csp-report — public anyway
function isMembershipCheckExempt(pathname: string): boolean {
  if (pathname.startsWith('/api/webhooks/')) return true;
  if (isCronPath(pathname)) return true;
  if (pathname === '/sign-in' || pathname.startsWith('/sign-in/')) return true;
  if (pathname === '/api/health' || pathname === '/api/healthz') return true;
  if (pathname === '/api/csp-report') return true;
  if (pathname.startsWith('/auth/')) return true;
  return false;
}

const PUBLIC_PATHS = [
  '/sign-in',
  '/auth',
  '/api/health',
  '/api/healthz', // INF-1: liveness probe (no DB, no auth)
  '/api/csp-report', // INF-11: browser violation receiver
  // Creator-facing payout surfaces. Creators are not app users: the onboard
  // redirect authenticates by unguessable pa_id (magic-link trust class) and
  // only 302s into Stripe-hosted onboarding; /payout/complete is a static
  // landing with no data.
  '/api/payout/onboard',
  '/payout/complete',
];

const STATE_CHANGING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function isPublic(pathname: string): boolean {
  if (pathname === '/favicon.ico') return true;
  if (pathname.startsWith('/_next/')) return true;
  // SEC-2: webhook receivers verify their own signatures (Resend uses Svix).
  // They MUST bypass the auth gate so external systems can deliver events.
  if (pathname.startsWith('/api/webhooks/')) return true;
  // Cron/scheduler routes authenticate via Bearer CRON_SECRET only (cron-auth.ts).
  if (isCronPath(pathname)) return true;
  for (const p of PUBLIC_PATHS) {
    if (pathname === p || pathname.startsWith(p + '/')) return true;
  }
  return false;
}

// SEC-5: paths that handle their own request authentication and therefore
// don't need the same-origin CSRF check.
function isCsrfExempt(pathname: string): boolean {
  // Webhooks verify Svix-style signatures (no user session).
  if (pathname.startsWith('/api/webhooks/')) return true;
  // Cron/scheduler routes authenticate via bearer secret, not a session —
  // there is no cookie for a cross-site attacker to ride.
  if (isCronPath(pathname)) return true;
  // INF-11 CSP report endpoint is browser-driven; no user session involved.
  if (pathname === '/api/csp-report') return true;
  return false;
}

/**
 * INF-2 + SEC-6: Default security + observability headers applied to every
 * response.
 *
 * Headers chosen for impact + low breakage risk:
 *   - X-Content-Type-Options: nosniff   — disables MIME-type sniffing
 *   - X-Frame-Options: DENY             — anti-clickjacking (no embedding)
 *   - Referrer-Policy: strict-origin-when-cross-origin
 *                                       — full URL same-origin, just origin
 *                                         cross-origin, nothing to insecure
 *   - Permissions-Policy: camera=()/...  — disables device APIs we don't use
 *
 * In production additionally:
 *   - Strict-Transport-Security         — force HTTPS for 1 year + subdomains
 *
 * CSP is intentionally NOT set here — Tailwind v4 + Next.js inline styles +
 * Sentry need a hand-crafted policy to avoid breaking the app, and a wrong
 * CSP is worse than none. Tracked in SEC-7.
 */
// INF-11: hand-crafted Content-Security-Policy. Tailwind v4 generates inline
// styles so `style-src` needs `'unsafe-inline'` (the Tailwind v4 team have
// indicated nonce support is on the roadmap; revisit then). Next.js inline
// hydration scripts need `script-src 'unsafe-inline'`. `connect-src` is
// scoped to our backend + the third-party hosts the client may hit
// directly (none currently — server-side only — but listed defensively
// so future client-side calls don't silently break under enforce mode).
const CSP_DIRECTIVES = [
  "default-src 'self'",
  // 'unsafe-inline' kept until Tailwind v4 nonce support lands.
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.openai.com https://api.apify.com https://api.resend.com https://accounts.spotify.com https://api.spotify.com",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  'report-uri /api/csp-report',
].join('; ');

function applySecurityHeaders(res: NextResponse, requestId?: string): NextResponse {
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()'
  );
  // Report-Only first so a wrong policy doesn't break the app. Switch to
  // 'Content-Security-Policy' (enforcing) after a clean week of reports.
  res.headers.set('Content-Security-Policy-Report-Only', CSP_DIRECTIVES);
  if (process.env.NODE_ENV === 'production') {
    res.headers.set(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains'
    );
  }
  if (requestId) res.headers.set('x-request-id', requestId);
  return res;
}

/**
 * SEC-5: CSRF defense. State-changing requests must come from the same origin.
 *
 * Trust order:
 *   1. `Sec-Fetch-Site` header (set by all major browsers, marked
 *      "forbidden" so JavaScript can't override it). Accept only
 *      `same-origin`. Reject `cross-site` / `same-site`.
 *   2. `Origin` header. Compare host to the request URL's host.
 *   3. `Referer` header. Compare host to the request URL's host.
 *   4. Nothing → reject. Server-to-server clients (curl, smoke tests,
 *      cron) must pass an explicit `Origin` header that matches the
 *      deployment host.
 */
function isSameOriginRequest(req: NextRequest): boolean {
  const requestHost = new URL(req.url).host;

  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite) {
    return fetchSite === 'same-origin';
  }

  const origin = req.headers.get('origin');
  if (origin) {
    if (origin === 'null') return false;
    try {
      return new URL(origin).host === requestHost;
    } catch {
      return false;
    }
  }

  const referer = req.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).host === requestHost;
    } catch {
      return false;
    }
  }

  // No Sec-Fetch-Site, no Origin, no Referer → can't prove same-origin.
  return false;
}

export default clerkMiddleware(async (clerkAuth, req: NextRequest) => {
  const url = new URL(req.url);

  // INF-2: request-id propagation. Trust an inbound `x-request-id` if the
  // caller supplied one (so client-side debugging can pin a request through
  // the stack); otherwise mint a fresh UUID. Forwarded into route handlers
  // via the request headers and echoed on the response so clients can quote
  // it in bug reports.
  const requestId =
    req.headers.get('x-request-id') ??
    (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));
  req.headers.set('x-request-id', requestId);

  // SEC-5: same-origin enforcement on state-changing requests. Runs BEFORE
  // dev-bypass so the dev server enforces the same posture as prod (apart
  // from the dev-session fabrication elsewhere).
  if (STATE_CHANGING.has(req.method) && !isCsrfExempt(url.pathname)) {
    if (!isSameOriginRequest(req)) {
      return applySecurityHeaders(
        NextResponse.json(
          { error: 'csrf_blocked', reason: 'origin_mismatch_or_missing' },
          { status: 403 }
        ),
        requestId
      );
    }
  }

  // Response carrier. Clerk manages its own session cookies internally.
  const response = NextResponse.next({ request: { headers: req.headers } });
  response.headers.set('x-request-id', requestId);

  // Public paths bypass the auth gate.
  if (isPublic(url.pathname)) return applySecurityHeaders(response, requestId);

  // Authentication via Clerk.
  const { userId } = await clerkAuth();

  if (userId) {
    // Paths that must not trigger the membership check (the post-sign-in
    // bootstrap route, auth/webhook endpoints, the sign-in page itself).
    if (isMembershipCheckExempt(url.pathname)) {
      return applySecurityHeaders(response, requestId);
    }
    if (url.pathname === '/favicon.ico' || url.pathname.startsWith('/_next/')) {
      return applySecurityHeaders(response, requestId);
    }

    // Authorization: firm_members membership keyed on the Clerk user id
    // (60s cache). Runs on the nodejs runtime so the service-role client is
    // available; we only read a row count, never write.
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      // Can't verify membership without the admin client (local dev without
      // the service key). Mirror the prior pass-through; prod always has it.
      return applySecurityHeaders(response, requestId);
    }

    const cached = membershipCache.get(userId);
    const now = Date.now();
    let hasMembership: boolean;
    if (cached && now - cached.ts < MEMBERSHIP_TTL_MS) {
      hasMembership = cached.ok;
    } else {
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
        auth: { persistSession: false },
      });
      const { count, error: countErr } = await admin
        .from('firm_members')
        .select('id', { count: 'exact', head: true })
        .eq('clerk_user_id', userId);
      if (countErr) {
        // Fail open: a transient DB error shouldn't lock a real user out.
        console.error('[middleware] firm_members lookup failed', countErr.message);
        return applySecurityHeaders(response, requestId);
      }
      hasMembership = (count ?? 0) > 0;
      membershipCache.set(userId, { ts: now, ok: hasMembership });
    }

    if (hasMembership) return applySecurityHeaders(response, requestId);

    // Authenticated Clerk user with no firm membership. A fresh sign-in is
    // routed through /auth/clerk-bootstrap (membership-exempt) which
    // allowlist-gates + provisions; reaching here means bootstrap was
    // rejected or hasn't run. Bounce.
    membershipCache.delete(userId);
    if (url.pathname.startsWith('/api/')) {
      return applySecurityHeaders(
        NextResponse.json({ error: 'no_firm_membership' }, { status: 401 }),
        requestId
      );
    }
    const bounce = new URL('/sign-in', req.url);
    bounce.searchParams.set('error', 'not_allowed');
    return applySecurityHeaders(NextResponse.redirect(bounce), requestId);
  }

  // Dev bypass: if DEV_USER_EMAIL is set in non-prod, allow through.
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.DEV_USER_EMAIL &&
    process.env.DEV_USER_EMAIL.length > 0
  ) {
    return applySecurityHeaders(response, requestId);
  }

  // API routes → 401 JSON; pages → redirect to /sign-in with return path.
  if (url.pathname.startsWith('/api/')) {
    return applySecurityHeaders(
      NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
      requestId
    );
  }
  const signInUrl = new URL('/sign-in', req.url);
  signInUrl.searchParams.set('next', url.pathname + url.search);
  return applySecurityHeaders(NextResponse.redirect(signInUrl), requestId);
});

// nodejs runtime so the membership check can use the service-role client.
export const runtime = 'nodejs';

// Run on every path EXCEPT static assets (which are cheap to skip here too).
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
