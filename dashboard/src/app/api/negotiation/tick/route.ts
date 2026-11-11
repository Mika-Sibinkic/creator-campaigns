// src/app/api/negotiation/tick/route.ts
//
// SECURITY-OK: supabaseAdmin — invoked by Vercel Cron (no user JWT). Drives the
// autonomous-negotiation loop (Gmail intake → process inbound → schedule
// counters → dispatch due sends). Auth is `Authorization: Bearer $CRON_SECRET`
// and NOTHING else: src/lib/cron-auth.ts deliberately does not trust an
// `x-vercel-cron` header, because it is client-suppliable off-Vercel and
// trusting it let anyone drive the spend loop unauthenticated (closed on
// purpose). With no CRON_SECRET set the route opens ONLY in local
// non-production dev so a developer can hit it by hand; a deployed build with the
// secret unset fails closed. Same authorizeCron() gate as /api/cron/smoke.
//
// The heavy lifting lives in src/lib/negotiation-tick.ts (injectable clock /
// rng / dispatch seams so it unit-tests hermetically). This route is the thin
// cron-auth + admin-client wrapper: it runs one tick and records a heartbeat
// audit row with the tally, so ops has a compliance trail of every loop pass.

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { runNegotiationTick } from '@/lib/negotiation-tick';
import { sweepDealEconomics } from '@/lib/deal-economics';
import { authorizeCron } from '@/lib/cron-auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
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
  // Spend cap: this route fans out to the negotiator LLM + Resend per pending
  // inbound, so an authorized-but-runaway caller (e.g. a misconfigured pinger)
  // must not amplify spend. 'expensive' tier — legitimate cron is 1/min.
  const limit = tieredLimit(req, 'expensive');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }

  const log = requestLogger('negotiation-tick', req);
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

  let tally;
  try {
    tally = await runNegotiationTick(sb, { request: req });
  } catch (e) {
    // Failure is a run too — tick_runs carries success AND failure so the
    // stalled-tick probe (and a human) can tell "dead scheduler" from
    // "running but throwing". recordTickRun never throws.
    log.error('tick failed', { error: e as Error, latency_ms: Date.now() - started });
    await recordTickRun(sb, {
      tick: 'negotiation',
      startedAtMs: started,
      finishedAtMs: Date.now(),
      ok: false,
      error: (e as Error).message,
    });
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
  // Deal-economics sweep: stamp perceived_generosity / price_give_pct on
  // closed offers still pending (also the historical backfill).
  // Degrade-not-throw: a sweeper failure must never break the tick heartbeat,
  // so it is caught here and surfaced in the tally/audit trail instead.
  let economics: { scanned: number; updated: number; error?: string };
  try {
    economics = await sweepDealEconomics(sb);
  } catch (e) {
    economics = { scanned: 0, updated: 0, error: (e as Error).message };
  }

  const ms = Date.now() - started;

  // Heartbeat + compliance trail. actor_label 'system:cron' so audit() does not
  // try to resolve a (nonexistent) session.
  await audit(
    {
      action: 'system.cron.negotiation_tick',
      actor_label: 'system:cron',
      metadata: { ...tally, economics, latency_ms: ms },
    },
    req,
  );

  // Tick-run persistence (migration 044): the queryable per-run record the
  // audit heartbeat isn't — /api/anomalies reads the newest row for the
  // stalled-tick lane. Write-then-don't-throw.
  await recordTickRun(sb, {
    tick: 'negotiation',
    startedAtMs: started,
    finishedAtMs: Date.now(),
    ok: true,
    tally: { ...tally, economics, latency_ms: ms },
  });
  log.info('tick complete', { ...tally, economics, latency_ms: ms });

  return NextResponse.json({ ok: true, ts: new Date().toISOString(), ms, ...tally, economics });
}

export async function POST(req: Request) {
  // POST is treated identically — cron infra varies on verb.
  return GET(req);
}
