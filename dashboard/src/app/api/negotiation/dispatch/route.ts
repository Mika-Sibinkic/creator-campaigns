// src/app/api/negotiation/dispatch/route.ts
//
// The minute-cadence dispatch pass: send every queued outbound message whose
// send_after has come due, and nothing else.
//
// WHY IT IS SEPARATE FROM /api/negotiation/tick
//   send_after is only honoured by the dispatch pass, and that pass used to ride
//   the full negotiation tick on its five-minute beat. A per-message delay of
//   60-180s inside a five-minute tick is swallowed whole — the real latency was
//   0-5 minutes regardless of what was computed, and every reply scheduled in
//   one tick left in the same batch seconds apart, on the beat. Replies arriving
//   in lockstep at :00, :05, :10 is a worse machine tell than an instant reply.
//
//   This pass is four queries and no model calls, so running it every minute
//   costs almost nothing, while the expensive negotiate-and-classify pass stays
//   at five minutes. Quiet hours and the campaign window still gate every send
//   inside dispatchDue — this changes WHEN a due message is noticed, never
//   whether it was allowed.
//
// Idempotent: dispatchDue clears send_after and flips status the moment it
// sends, so two overlapping runs cannot double-send the same row.
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { authorizeCron } from '@/lib/cron-auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { runDispatchPass } from '@/lib/negotiation-tick';
import { recordTickRun } from '@/lib/tick-runs';
import { requestLogger } from '@/lib/logger';

export const runtime = 'nodejs';
// Sends are network-bound and a backlog can be large after a quiet-hours
// window opens; same ceiling as the other ticks.
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

  const log = requestLogger('negotiation-dispatch', req);
  const started = Date.now();

  // Constructed above the try for the same reason the other ticks do it: a
  // missing-env throw from supabaseAdmin() on the error path would lose the
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
    const tally = await runDispatchPass(sb);
    // Audit only when something actually moved. This runs 1,440 times a day and
    // most runs have nothing due; writing a row every minute would bury the
    // audit log in exactly the way the client-facing activity feed was buried.
    if (
      tally.sent > 0 ||
      tally.deferred > 0 ||
      tally.window_closed > 0 ||
      tally.skipped > 0 ||
      tally.holding_dropped > 0
    ) {
      await audit({
        action: 'system.cron.negotiation_dispatch',
        actor_label: 'system:cron',
        target_type: 'system',
        metadata: { ...tally },
      });
    }
    // Same reasoning for tick_runs: the stalled-tick anomaly lane reads the
    // newest row per tick name, and a no-op minute is not evidence of health
    // worth storing 1,440 times a day.
    if (tally.sent > 0) {
      await recordTickRun(sb, {
        tick: 'dispatch',
        startedAtMs: started,
        finishedAtMs: Date.now(),
        ok: true,
        tally: { ...tally },
      });
    }
    log.info('dispatch pass complete', { ...tally, latency_ms: Date.now() - started });
    return NextResponse.json({ ok: true, ...tally });
  } catch (e) {
    const error = e as Error;
    log.error('dispatch pass failed', { error, latency_ms: Date.now() - started });
    await recordTickRun(sb, {
      tick: 'dispatch',
      startedAtMs: started,
      finishedAtMs: Date.now(),
      ok: false,
      error: error.message,
    });
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return GET(req);
}
