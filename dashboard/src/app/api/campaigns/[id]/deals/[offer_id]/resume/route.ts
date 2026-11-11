// src/app/api/campaigns/[id]/deals/[offer_id]/resume/route.ts
//
// USER PATH — "Resume automation" on a deal a human took over. An escalation puts the offer in manual mode;
// this is the only way back. The person must enter the price they last quoted
// the creator and confirm it: it is recorded on the thread as the last sent
// price, the standing offer is set to it, and the next "Deal!" is agreed at
// that number and no other.
//
// Every decision lives in resumeAutomation (src/lib/negotiation-takeover.ts,
// executed in tests/human-takeover.test.ts): firm and campaign scope, the
// thread really is manual, no DM counter is waiting unsent, the price is a
// clean dollar figure inside the creator's ceiling, and the explicit confirm.
// Any refusal leaves the deal manual.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSessionAndClient } from '@/lib/auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { resumeAutomation } from '@/lib/negotiation-takeover';

export const runtime = 'nodejs';

interface Ctx {
  params: Promise<{ id: string; offer_id: string }>;
}

const Body = z.object({
  price_usd: z.union([z.number(), z.string().max(32)]),
  confirm: z.boolean(),
  // "I quoted this new price to the creator", required when the
  // price differs from the last one on record (resumeAutomation decides).
  quoted_new: z.boolean().optional(),
});

export async function POST(req: NextRequest, ctx: Ctx) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  const { id: campaignId, offer_id } = await ctx.params;
  let sb, session;
  try {
    ({ sb, session } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }
  const body = await readJson(req, Body);
  if (body instanceof NextResponse) return body;

  const result = await resumeAutomation(sb, {
    offerId: offer_id,
    campaignId,
    firmId: session.firm_id,
    price: body.price_usd,
    confirmed: body.confirm === true,
    quotedNew: body.quoted_new === true,
    actorLabel: `user:${session.user.email ?? session.user.id}`,
    request: req,
  });
  return NextResponse.json(result.body, { status: result.status });
}
