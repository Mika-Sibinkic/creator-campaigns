// src/instrumentation.ts
//
// SEC-3 / N7: Sentry wiring for the Next.js Node runtime.
//
// Behavior:
//   - If `SENTRY_DSN` is unset → no-op (development default; tests stay quiet).
//   - If set → init with conservative tracesSampleRate (10% in prod, 100% in
//     dev so local repro captures everything) and `sendDefaultPii: false` so
//     IPs and emails don't leak into Sentry by default.
//   - `beforeSend` hook tags events with firm_id (lifted out of event.extra
//     when callers pushed it there), release (VERCEL_GIT_COMMIT_SHA), and
//     environment (VERCEL_ENV). `feature=creator-campaigns` is set once at init so
//     events filter cleanly in the Sentry UI.
//
// Next.js calls `register()` once per server boot (Edge AND Node). The
// `Sentry.init` call is idempotent — repeated invocations across HMR reloads
// re-use the same hub.
//
// Companion export `onRequestError` is consumed by Next.js >= 15 to
// auto-capture unhandled errors from route handlers / server components.

import * as Sentry from '@sentry/nextjs';

export function register() {
  if (!process.env.SENTRY_DSN) {
    // No-op fallback so importing this file does nothing when Sentry isn't
    // configured, so the app runs without a Sentry account.
    return;
  }
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    sendDefaultPii: false,
    beforeSend(event) {
      // Lift firm_id out of event.extra (if the caller put it there via
      // alertOnce) so Sentry can filter / group by tag.
      const firmId =
        (event.extra && typeof event.extra === 'object'
          ? (event.extra as Record<string, unknown>).firm_id
          : undefined);
      if (typeof firmId === 'string' && firmId.length > 0) {
        event.tags = { ...(event.tags ?? {}), firm_id: firmId };
      }
      // Stamp release + environment on every event from this process even
      // though they're also set at init — defensive against runtime overrides.
      if (process.env.VERCEL_GIT_COMMIT_SHA) {
        event.release = process.env.VERCEL_GIT_COMMIT_SHA;
      }
      if (process.env.VERCEL_ENV) {
        event.environment = process.env.VERCEL_ENV;
      }
      return event;
    },
  });
  // Filter tag so this app's events are one click away in
  // the Sentry UI when this DSN ends up shared with other products.
  Sentry.setTag('feature', 'creator-campaigns');
}

export const onRequestError = Sentry.captureRequestError;
