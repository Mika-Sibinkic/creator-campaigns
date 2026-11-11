// src/app/api/enrichment/tick/route.ts
//
// Scheduled contact enrichment. Same cron-auth + admin-client + tick_runs shape
// as /api/negotiation/tick and /api/measurement/tick; middleware whitelists
// /api/*/tick via the cron-path exemption.
//
// Exists because contact discovery was only ever reachable from a live campaign
// run, capped at 25 creators inside a 60s slice of the pipeline's budget — see
// the header of src/lib/enrichment-tick.ts for the measured consequence. This
// route is the un-capped path: no scraping, no Apify, bounded model spend.
//
// Cadence: hourly is plenty. The pool only grows when a discovery run adds to
// it, and a creator that yields nothing three times stops being selected.
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { authorizeCron } from '@/lib/cron-auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { runEnrichmentTick } from '@/lib/enrichment-tick';
import { recordTickRun } from '@/lib/tick-runs';
import { requestLogger } from '@/lib/logger';

export const runtime = 'nodejs';
// Bio-link fetches are network-bound and the batch is 60 creators; the library
// stops itself at 120s, this is the hard outer wall.
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

  const log = requestLogger('enrichment-tick', req);
  const started = Date.now();

  // Constructed above the try for the same reason the measurement tick does it:
  // a missing-env throw from supabaseAdmin() on the error path would lose the
  // tick_runs FAILURE row, and a missing row reads as a dead scheduler.
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
    const tally = await runEnrichmentTick(sb);
    await audit({
      action: 'system.cron.enrichment_tick',
      actor_label: 'system:cron',
      target_type: 'system',
      metadata: { ...tally },
    });
    await recordTickRun(sb, {
      tick: 'enrichment',
      startedAtMs: started,
      finishedAtMs: Date.now(),
      ok: true,
      tally: { ...tally },
    });
    log.info('enrichment tick complete', { ...tally, latency_ms: Date.now() - started });
    return NextResponse.json({ ok: true, ...tally });
  } catch (e) {
    const error = e as Error;
    log.error('enrichment tick failed', { error, latency_ms: Date.now() - started });
    await recordTickRun(sb, {
      tick: 'enrichment',
      startedAtMs: started,
      finishedAtMs: Date.now(),
      ok: false,
      error: error.message,
    });
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

// POST delegates, matching /api/negotiation/tick so either verb works from a
// scheduler that only speaks one.
export async function POST(req: Request) {
  return GET(req);
}
