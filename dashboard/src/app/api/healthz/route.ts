// src/app/api/healthz/route.ts
//
// INF-1: LIVENESS probe — no I/O, no DB call. Returns 200 if the Node
// process is alive. Used by Vercel's keep-alive ping (15-min) and
// orchestrators that just want a binary "is the runtime running?" signal.
//
// For a READINESS check (DB reachable, env wired), hit `/api/health`
// instead. Liveness should never depend on downstreams or it will
// trigger restarts/incidents for outages it can't fix.
//
// Whitelisted in middleware (no auth, no rate limit). Cheap by design —
// hitting this 4× per minute on Vercel hobby is a no-op.
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export function GET() {
  return NextResponse.json({
    ok: true,
    ts: new Date().toISOString(),
    uptime_s: Math.round(process.uptime()),
  });
}
