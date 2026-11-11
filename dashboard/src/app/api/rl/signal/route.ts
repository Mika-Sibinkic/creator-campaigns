// src/app/api/rl/signal/route.ts
//
// RL training-data sink.
//
// Every clickable affordance in the dashboard funnels a tuple
//   (event_id, kind, context) → audit_log
// so the models get a continuous corrective signal stream from the
// operator's reactions to AI-taken actions. The audit_log row is the single training surface
// (firm-scoped via the standard `audit` helper).
//
// Contract:
//   POST /api/rl/signal
//   Body: { event_id: string, kind: 'up'|'down'|'override', context?: Record<string, unknown> }
//   200: { ok: true }
//   400: { error: 'invalid_body' }
//
// Not rate-limited intentionally — humans click these by hand. If a script
// starts hammering this route we'll see it in audit and address then.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { requireSession } from '@/lib/auth';

export const runtime = 'nodejs';

const Body = z.object({
  event_id: z.string().min(1).max(256),
  kind: z.enum(['up', 'down', 'override']),
  context: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: Request) {
  const session = await requireSession().catch(() => null);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  await audit(
    {
      action: `rl.signal.${parsed.kind}`,
      target_type: 'rl_event',
      target_id: parsed.event_id,
      metadata: {
        kind: parsed.kind,
        context: parsed.context ?? {},
      },
    },
    req,
  );

  return NextResponse.json({ ok: true });
}
