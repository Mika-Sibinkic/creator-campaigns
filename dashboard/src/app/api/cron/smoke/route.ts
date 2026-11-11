// src/app/api/cron/smoke/route.ts
//
// SECURITY-OK: supabaseAdmin — invoked by Vercel Cron (no user JWT). Writes `system.cron.smoke` heartbeat into audit_log; gated by `Authorization: Bearer $CRON_SECRET` ONLY (src/lib/cron-auth.ts, constant-time).
//
// SYSTEM PATH — invoked by Vercel Cron (G3 daily smoke / 15-min keep-alive).
//
// Authorization: `Authorization: Bearer $CRON_SECRET` and NOTHING ELSE, via
// authorizeCron() (constant-time compare). Vercel Cron also sends an
// `x-vercel-cron` header, but that header is client-suppliable off-Vercel and
// trusting it would let anyone drive the money/spend loop unauthenticated —
// so it was deliberately removed. Do not "restore" it. With no CRON_SECRET set the
// route opens ONLY in local non-production dev; a deployed build fails closed.
//
// What it does:
//   - Probes Supabase via a 1-row read of the `firms` table (catches DB outages).
//   - Records a `system.cron.smoke` event in audit_log so we have a heartbeat
//     trail for compliance + ops review.
//   - Returns `{ok, ts, ms}`.
//
// What it does NOT do:
//   - Hit external paid APIs (Apify/OpenAI).

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { authorizeCron } from '@/lib/cron-auth';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  if (!authorizeCron(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const started = Date.now();
  let dbOk = false;
  let dbError: string | null = null;
  try {
    const sb = supabaseAdmin();
    const { error } = await sb.from('firms').select('id').limit(1);
    if (error) {
      dbError = error.message;
    } else {
      dbOk = true;
    }
  } catch (e) {
    dbError = (e as Error).message;
  }
  const ms = Date.now() - started;

  // SEC-3: heartbeat audit. actor_label is set explicitly to 'system:cron' so
  // audit() does not try to resolve a session (cron has none).
  await audit({
    action: 'system.cron.smoke',
    actor_label: 'system:cron',
    metadata: { db_ok: dbOk, db_error: dbError, latency_ms: ms },
  }, req);

  if (!dbOk) {
    return NextResponse.json(
      { ok: false, ts: new Date().toISOString(), ms, error: dbError },
      { status: 503 }
    );
  }
  return NextResponse.json({ ok: true, ts: new Date().toISOString(), ms });
}

export async function POST(req: Request) {
  // POST is treated identically — cron infra varies on verb.
  return GET(req);
}
