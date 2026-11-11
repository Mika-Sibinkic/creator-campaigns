// src/app/api/anomalies/resolve/route.ts
//
// "Resolve" on a /anomalies row: mark
// a held reply, an injection flag, or an escalation / fishy row reviewed, or
// send a held reply back to the negotiator ("process normally", refused while
// a human has the thread in manual mode). Audited as 'anomaly.resolved'.
//
// Every decision lives in resolveAnomaly (src/lib/anomaly-resolve.ts,
// executed in tests/anomaly-resolve.test.ts): firm scope, operator-only lanes,
// the manual-mode refusal, and the guarded writes.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSessionAndClient } from '@/lib/auth';
import { isPlatformOperator } from '@/lib/operator';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { resolveAnomaly } from '@/lib/anomaly-resolve';

export const runtime = 'nodejs';

const Body = z.object({
  ref: z.string().min(3).max(200),
  action: z.enum(['reviewed', 'process_normally']),
});

export async function POST(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  let sb, session;
  try {
    ({ sb, session } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }
  const body = await readJson(req, Body);
  if (body instanceof NextResponse) return body;

  const result = await resolveAnomaly(sb, {
    ref: body.ref,
    action: body.action,
    firmId: session.firm_id,
    isOperator: isPlatformOperator(session.user.email),
    actorLabel: `user:${session.user.email ?? session.user.id}`,
    request: req,
  });
  return NextResponse.json(result.body, { status: result.status });
}
