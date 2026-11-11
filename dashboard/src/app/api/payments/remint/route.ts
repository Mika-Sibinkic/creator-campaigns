// src/app/api/payments/remint/route.ts
//
// USER + OPERATOR PATH — "Create payment for approval": re-create the payment a
// deal is waiting on when the automatic mint failed (negotiation's automint,
// or the balance mint after a logged post). Used by DealRow and by the
// /anomalies money lane.
//
// Not money: the row lands in /approvals at pending_human_review and a human
// approval still stands before any transfer. All decisions live in
// remintPaymentForOffer (src/lib/authorize-payment.ts, executed in
// tests/money-path-adversarial.test.ts): firm-scoped, refuses unless the deal
// has a real gap (payment-legs.approvalQueueGap), and mints through
// authorizePaymentForOffer with every guard it has.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSessionAndClient } from '@/lib/auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { audit } from '@/lib/audit';
import { remintPaymentForOffer } from '@/lib/authorize-payment';

export const runtime = 'nodejs';

// reopen_stopped: the operator explicitly re-creates a payment a PERSON stopped
// (reject / revoke / cancel). Without it such a leg stays closed and this
// returns 409 leg_stopped. DealRow sends it only behind a confirm dialog.
const Body = z.object({ offer_id: z.string().uuid(), reopen_stopped: z.boolean().optional() });

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

  const out = await remintPaymentForOffer(
    sb,
    {
      offerId: body.offer_id,
      callerFirmId: session.firm_id,
      actorUserId: session.user.id,
      reopenStopped: body.reopen_stopped === true,
    },
    { audit: async (entry) => { await audit(entry, req); } }
  );
  return NextResponse.json(out.body, { status: out.httpStatus });
}
