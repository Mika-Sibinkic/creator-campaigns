// src/lib/cron-paths.ts
//
// The canonical list of scheduler-driven request paths. Shared by the edge
// middleware — which must NOT intercept them — and by the reachability drift
// test that keeps this list honest.
//
// Each of these paths carries its OWN fail-closed auth: `Authorization: Bearer
// $CRON_SECRET` only, compared in constant time, 401 otherwise in production
// (src/lib/cron-auth.ts — the `x-vercel-cron` header is deliberately NOT
// trusted, see that file). So the session/CSRF gate must stand aside for them,
// the same trust model as /api/webhooks/*.
//
// WHY THIS IS ITS OWN MODULE
//   Without the middleware exemption a scheduled call 401s at the edge before
//   the route's own auth ever runs — and the failure is invisible, because that
//   401 body is byte-identical to the one an unmatched path returns. You cannot
//   tell "route missing" from "route fenced off" by looking at the response.
//
//   Adding a route and scheduling it is not enough. It has to appear HERE too.
//   tests/cron-scheduler-reachability.test.ts holds the three facts against each
//   other: what tools/_pgcron-setup.mjs schedules, what this list exempts, and
//   which route files exist and gate on authorizeCron. Schedule a tick without
//   listing it here and that test fails.

/** Prefixes whose entire subtree authenticates by bearer secret. */
export const CRON_PATH_PREFIXES = ['/api/cron/'] as const;

/** Exact scheduler-driven paths. Keep in sync with tools/_pgcron-setup.mjs. */
export const CRON_PATHS = [
  '/api/negotiation/tick',
  '/api/negotiation/dispatch',
  '/api/measurement/tick',
  '/api/enrichment/tick',
] as const;

export function isCronPath(pathname: string): boolean {
  for (const prefix of CRON_PATH_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  return (CRON_PATHS as readonly string[]).includes(pathname);
}
