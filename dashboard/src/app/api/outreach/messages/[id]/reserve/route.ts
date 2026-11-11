// src/app/api/outreach/messages/[id]/reserve/route.ts
//
// POST — the DM queue's "Reserve & copy" for a first-touch opener: hold one of
// the campaign's first-touch slots (outreach limit + budget pacing), and only
// then return the text to copy. A DM is sent by hand, so the limit has to bite
// BEFORE the human has the text, not at Mark sent. Decision logic and the
// claim + recount: src/lib/dm-reserve.ts (tests/dm-first-touch-reserve.test.ts).
//
// Tenant gate first: sb is the service-role client, so a foreign id answers
// exactly like an unknown one (404).

import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { OUTREACH_NOT_FOUND, outreachMessageInFirm } from '@/lib/outreach-scope';
import { reserveDmFirstTouch } from '@/lib/dm-reserve';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  const { id } = await ctx.params;
  let session, sb;
  try {
    ({ session, sb } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }
  if (!(await outreachMessageInFirm(sb, id, session.firm_id))) {
    return NextResponse.json(OUTREACH_NOT_FOUND, { status: 404 });
  }

  const out = await reserveDmFirstTouch(sb, { messageId: id, callerFirmId: session.firm_id });
  if (out.status === 200 && out.body.reserved === true && out.body.already_held !== true) {
    await audit(
      {
        action: 'outreach.dm_reservation.reserved',
        target_type: 'outreach_message',
        target_id: id,
        firm_id: session.firm_id,
        metadata: { reserved_at: out.body.reserved_at, expires_at: out.body.expires_at },
      },
      req,
    );
  }
  return NextResponse.json(out.body, { status: out.status });
}
