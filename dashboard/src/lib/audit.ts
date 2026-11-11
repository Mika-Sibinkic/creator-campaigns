// src/lib/audit.ts
//
// SEC-3: Append-only audit log writer.
//
// Pattern mirrors `src/lib/api-ledger.ts`: a "write-then-don't-throw" helper
// that records an event to `audit_log` via the service-role client. If the
// insert fails (network blip, schema drift, etc.) we log to console.error
// and return; the caller's user action MUST never be blocked because audit
// failed. Audit is append-only at the database level (migration 008 wires
// BEFORE UPDATE / BEFORE DELETE triggers raising `audit_log is append-only`).
//
// Actor resolution:
//   - If the caller passes `actor_label`, we use it verbatim (e.g. system
//     paths set 'system:cron' / 'system:pipeline' / 'webhook:resend').
//   - Otherwise we read the current Supabase Auth session via `getSession()`
//     and synthesize 'user:<email>'. firm_id is taken from the session unless
//     explicitly overridden by the caller (helpful when a user action targets
//     a different firm — currently impossible due to RLS, but preserved for
//     future multi-firm support).
//
// Request metadata: when the caller passes the inbound `Request`, we extract
// `x-forwarded-for` (first IP) and `user-agent` for forensic purposes. These
// fields are nullable on the table.

import { supabaseAdmin } from './supabase';
import { getSession } from './auth';

// INF-5: PII scrubbing for audit_log.metadata.
//
// Audit_log is append-only and outlives the user-action context, so we
// don't want to persist raw email addresses or phone numbers into it.
// Scrubbed forms are still debuggable:
//   alice@example.com → a***@example.com
//   +1 (415) 555-1234 → ***-***-1234
//
// Only strings inside metadata are scrubbed. We deliberately walk objects
// + arrays recursively so a nested `resolved_to` or `customer.email` field
// gets the same treatment.
const EMAIL_RE = /([A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]*@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})/g;
const PHONE_RE = /(?<!\d)\+?\d[\d\s().\-]{7,}\d(?!\d)/g;

function scrubString(s: string): string {
  let out = s.replace(EMAIL_RE, '$1***@$2');
  out = out.replace(PHONE_RE, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 7) return match;
    return `***-***-${digits.slice(-4)}`;
  });
  return out;
}

export function scrubPII(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubPII);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubPII(v);
    }
    return out;
  }
  return value;
}

export interface AuditEntry {
  /** Hierarchical action key, e.g. 'campaign.create', 'outreach.send'. */
  action: string;
  /** Logical type of the row touched, e.g. 'campaign' / 'outreach_message'. */
  target_type?: string;
  /** UUID of the row touched, when applicable. */
  target_id?: string;
  /** Free-form additional context (before/after diff, params, etc). */
  metadata?: Record<string, unknown>;

  // ─── overrides for system events (otherwise resolved from session) ───
  /** Override actor user id; null/undefined → resolved from session. */
  actor_user_id?: string | null;
  /** Override actor label; falls back to 'user:<email>' or 'system:unknown'. */
  actor_label?: string;
  /** Override firm scope; falls back to session's firm_id. */
  firm_id?: string | null;
  /** Override request IP (else parsed from `req` header). */
  request_ip?: string;
  /** Override user-agent (else parsed from `req` header). */
  user_agent?: string;
}

/**
 * Insert one row into `audit_log`. Never throws; logs and returns on failure.
 *
 * Usage examples:
 *   // System path
 *   await audit({ action: 'system.cron.smoke', metadata: { count: 5 } });
 *
 *   // User path (auto-resolves actor from session)
 *   await audit(
 *     { action: 'outreach.send', target_type: 'outreach_message',
 *       target_id: messageId, firm_id, metadata: { test_mode, resolved_to } },
 *     req
 *   );
 */
export async function audit(entry: AuditEntry, req?: Request): Promise<void> {
  let actor_user_id: string | null = entry.actor_user_id ?? null;
  let actor_label = entry.actor_label ?? 'system:unknown';
  let firm_id: string | null = entry.firm_id ?? null;

  // If the caller didn't tag this as a system event, resolve actor from session.
  if (!entry.actor_label) {
    const session = await getSession().catch(() => null);
    if (session?.user) {
      actor_user_id = session.user.id;
      actor_label = `user:${session.user.email ?? session.user.id}`;
      // Only adopt session firm_id if the caller didn't explicitly pass one
      // (including explicit `null` to suppress firm scoping for cross-firm events).
      if (firm_id === null && entry.firm_id === undefined) {
        firm_id = session.firm_id || null;
      }
    }
  }

  // actor_user_id is a uuid column, but Clerk ids are `user_...` strings —
  // inserting one fails the whole row and the event is lost (every authed
  // user action since the Clerk migration). Keep the identity in actor_label
  // (always carries id or email) and null out non-uuid actor ids.
  if (actor_user_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actor_user_id)) {
    if (actor_label === 'system:unknown') actor_label = `user:${actor_user_id}`;
    actor_user_id = null;
  }

  const ip =
    entry.request_ip ??
    req?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null;
  const ua = entry.user_agent ?? req?.headers.get('user-agent') ?? null;

  // INF-2: thread request-id into metadata so audit rows correlate to logs
  // and to client bug reports that quote the x-request-id response header.
  const requestId = req?.headers.get('x-request-id') ?? null;
  // INF-5: scrub PII (emails, phones) before persisting. The request-id is
  // attached AFTER scrub so it isn't accidentally regex-matched.
  const scrubbed = entry.metadata
    ? (scrubPII(entry.metadata) as Record<string, unknown>)
    : null;
  const metadata = requestId
    ? { ...(scrubbed ?? {}), request_id: requestId }
    : scrubbed;

  try {
    const { error } = await supabaseAdmin()
      .from('audit_log')
      .insert({
        action: entry.action,
        actor_user_id,
        actor_label,
        firm_id,
        target_type: entry.target_type ?? null,
        target_id: entry.target_id ?? null,
        metadata,
        request_ip: ip,
        user_agent: ua,
      } as unknown as never);
    if (error) {
      console.error('[audit] insert failed', error.message, { action: entry.action });
    }
  } catch (e) {
    console.error('[audit] insert threw', e, { action: entry.action });
    // Never re-throw. Audit must not block the user action.
  }
}
