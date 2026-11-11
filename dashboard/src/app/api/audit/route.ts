// src/app/api/audit/route.ts
//
// USER PATH — audit log read API.
//
// SCOPING. There is no RLS on this path. `requireSessionAndClient()` hands back
// the service-role client, which is RLS-inert, so the `.eq('firm_id', …)` below
// is the ONLY tenancy boundary. A header comment here used to claim RLS scoped
// these rows; it did not, and believing it would make loosening this filter look
// harmless. It is not.
//
//   - A label sees its own workspace's rows and nothing else.
//   - A platform operator additionally sees firm-NULL rows — the global system
//     tail (cron ticks, scheduled sweeps, smoke probes). Those are our
//     forensics, not the client's activity: they carry no tenant, so a `firm_id
//     IS NULL` union handed every workspace every other workspace's system
//     events and buried real work under 5-minute cron heartbeats.
//
// Query params:
//   action       — substring filter against audit_log.action
//   actions      — CSV of EXACT action keys; an allowlist, ANDed with `action`
//   target_type  — exact match
//   since        — ISO date/timestamp; clamps to occurred_at >= since
//   limit        — page size, default 100, max 500
//
// Response shape:
//   { rows: Array<AuditLogRow> }
import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { isPlatformOperator } from '@/lib/operator';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';

export const runtime = 'nodejs';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_ACTION_FILTERS = 64;

// What a non-operator is allowed to receive. `request_ip` and `user_agent` are
// PII-adjacent and no surface renders them; `actor_user_id` is a raw identity
// key that must never reach a client screen either. Operators keep them —
// tracing a bad send back to a request is the job.
const CLIENT_COLUMNS =
  'id, occurred_at, actor_label, firm_id, action, target_type, target_id, metadata';
const OPERATOR_COLUMNS =
  'id, occurred_at, actor_user_id, actor_label, firm_id, action, target_type, target_id, metadata, request_ip, user_agent';

export async function GET(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  let session, sb;
  try {
    ({ session, sb } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }

  const isOperator = isPlatformOperator(session.user.email);

  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  const actionsCsv = url.searchParams.get('actions');
  const target_type = url.searchParams.get('target_type');
  const since = url.searchParams.get('since');
  const limitParamRaw = url.searchParams.get('limit');
  let limitParam = limitParamRaw ? parseInt(limitParamRaw, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(limitParam) || limitParam <= 0) limitParam = DEFAULT_LIMIT;
  if (limitParam > MAX_LIMIT) limitParam = MAX_LIMIT;

  let q = sb
    .from('audit_log')
    .select(isOperator ? OPERATOR_COLUMNS : CLIENT_COLUMNS)
    .order('occurred_at', { ascending: false })
    .limit(limitParam);

  // Tenancy. Operators get the global system tail unioned in; everyone else is
  // pinned to their own workspace.
  q = isOperator
    ? q.or(`firm_id.eq.${session.firm_id},firm_id.is.null`)
    : q.eq('firm_id', session.firm_id);

  if (action) {
    q = q.ilike('action', `%${action.replace(/[%_]/g, (m) => `\\${m}`)}%`);
  }
  if (actionsCsv) {
    // Exact-match allowlist. The home feed sends the set of actions it has
    // plain-English names for, so an unnamed machine key can never reach a
    // client screen by simply existing in the table.
    const wanted = Array.from(
      new Set(
        actionsCsv
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    ).slice(0, MAX_ACTION_FILTERS);
    if (wanted.length === 0) {
      return NextResponse.json({ rows: [] });
    }
    q = q.in('action', wanted);
  }
  if (target_type) {
    q = q.eq('target_type', target_type);
  }
  if (since) {
    // Postgres accepts ISO timestamps directly; let it raise on garbage.
    q = q.gte('occurred_at', since);
  }

  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ rows: data ?? [] });
}
