// src/app/api/measurement/tick/route.ts
//
// Agenda steps 6-8 scheduler entrypoint: verify deliveries + snapshot post
// performance on the ~1wk-then-monthly cadence. Same cron-auth + admin-client
// pattern as /api/negotiation/tick. pg_cron fires it hourly (tools/_pgcron-setup.mjs),
// plenty for a weekly/monthly measurement rhythm. Middleware whitelists /api/*/tick via the
// cron-path exemption.
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { authorizeCron } from '@/lib/cron-auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { runMeasurementTick } from '@/lib/measurement-tick';
import { recordTickRun } from '@/lib/tick-runs';
import { requestLogger } from '@/lib/logger';

export const runtime = 'nodejs';
// A loaded tick now writes 25-50 sequential api_ledger rows (+2.5-5s) on top of
// the tick body and the tick_runs write, so the platform default is too tight.
// A truncated tick loses the tick_runs row that the stalled-tick anomaly lane
// reads — i.e. a timeout would look exactly like a dead scheduler. Same ceiling
// as /api/campaigns/[id]/run.
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!authorizeCron(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const r = tieredLimit(req, 'expensive');
  if (!r.ok) {
    const { body, init } = rateLimited(r.resetAt);
    return NextResponse.json(body, init);
  }

  const log = requestLogger('measurement-tick', req);
  const started = Date.now();

  // One admin client for the whole request, constructed ABOVE the try. It used
  // to be re-called inside the catch, so a missing-env throw from
  // supabaseAdmin() itself threw a second time on the error path and the
  // tick_runs FAILURE row — the row that distinguishes "running but throwing"
  // from "dead scheduler" — never got written. Nothing can be recorded when the
  // client is the thing that failed, so that case returns the route's normal
  // 500 shape rather than an unhandled rejection.
  let sb: ReturnType<typeof supabaseAdmin>;
  try {
    sb = supabaseAdmin();
  } catch (e) {
    log.error('supabase admin unavailable', {
      error: e as Error,
      latency_ms: Date.now() - started,
    });
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }

  try {
    const tally = await runMeasurementTick(sb);
    await audit({
      action: 'system.cron.measurement_tick',
      actor_label: 'system:cron',
      target_type: 'system',
      metadata: { ...tally },
    });
    // Tick-run persistence (migration 044): before this, MeasurementTally —
    // including real Apify dollars spent — existed only in the HTTP response
    // nobody stores. Write-then-don't-throw.
    await recordTickRun(sb, {
      tick: 'measurement',
      startedAtMs: started,
      finishedAtMs: Date.now(),
      ok: true,
      tally: { ...tally },
    });
    log.info('tick complete', { ...tally, latency_ms: Date.now() - started });
    return NextResponse.json({ ok: true, ...tally });
  } catch (e) {
    log.error('tick failed', { error: e as Error, latency_ms: Date.now() - started });
    await recordTickRun(sb, {
      tick: 'measurement',
      startedAtMs: started,
      finishedAtMs: Date.now(),
      ok: false,
      error: (e as Error).message,
    });
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
