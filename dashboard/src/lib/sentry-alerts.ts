// src/lib/sentry-alerts.ts
//
// N7: thin Sentry helper for "alert me, but only once per N minutes" events.
//
// Why: payment-cap blocks and Resend failures can fire in bursts (e.g. a
// cron sweep tries to drain 20 approved rows against a $0 remaining budget).
// We want a Sentry signal *that something is wrong*, not 20 identical issues
// crowding the inbox. Per-process in-memory dedupe with a 5-minute TTL.
//
// No-op when SENTRY_DSN is unset so dev / preview / the demo path don't get
// surprised by silent failures or extra noise.
//
// Process-local dedupe is sufficient for our scale (single Vercel
// serverless region, function instances cycle frequently). If we ever need
// cross-instance dedupe we'll lift the cache into Supabase or Upstash — but
// not before measuring actual fan-out.

import * as Sentry from '@sentry/nextjs';

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, number>();

function isEnabled(): boolean {
  return !!process.env.SENTRY_DSN;
}

function shouldFire(key: string, now: number): boolean {
  const last = cache.get(key);
  if (last !== undefined && now - last < TTL_MS) return false;
  cache.set(key, now);
  // Opportunistic GC so the map can't grow unbounded across a long-lived
  // serverless instance. Cheap because the map is tiny in practice.
  if (cache.size > 256) {
    for (const [k, ts] of cache) {
      if (now - ts >= TTL_MS) cache.delete(k);
    }
  }
  return true;
}

export type AlertLevel = 'warning' | 'error';

/**
 * Fire a Sentry message at most once per `key` per 5-minute window.
 *
 * @param key       Dedupe key. Include the reason + the most specific scope
 *                  (firm_id, campaign_id) so different contexts get separate
 *                  alerts. Example: `payment_block:over_budget:<firm>:<camp>`.
 * @param level     'warning' for cap/block events, 'error' for hard failures.
 * @param message   Human-readable summary, used as the Sentry issue title.
 * @param context   Free-form extras attached to the event. `firm_id` here is
 *                  promoted to a tag by `beforeSend` in instrumentation.ts.
 */
export function alertOnce(
  key: string,
  level: AlertLevel,
  message: string,
  context: Record<string, unknown>
): void {
  if (!isEnabled()) return;
  if (!shouldFire(key, Date.now())) return;
  try {
    Sentry.captureMessage(message, {
      level,
      extra: { ...context, alert_key: key },
    });
  } catch (e) {
    // Never let an alerting failure cascade into the user-path.
    console.error('[sentry-alerts] captureMessage threw', e);
  }
}

// Exported for tests / forced re-fires (e.g. integration suites that want
// each run to start clean).
export function _resetAlertCache(): void {
  cache.clear();
}
