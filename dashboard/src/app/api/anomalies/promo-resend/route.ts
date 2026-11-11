// src/app/api/anomalies/promo-resend/route.ts
//
// OPERATOR PATH — "Resend promo pack" on a held promo row in /anomalies
// (payment_anomaly lane). A paid creator's promo email is held, fail closed,
// when the label's do-not-contact list cannot be read, and nothing retries it
// on its own (src/lib/promo-materials.ts). This is the retry.
//
// All decisions live in resendHeldPromo (executed in
// tests/firm-blocks-human-paths.test.ts): the deal must be the caller firm's
// and must have a recorded hold; the re-run goes through the same
// do-not-contact check and the promo_materials idempotency check, so it can
// neither reach a creator who said stop nor send a pack twice.
//
// 'expensive' tier: each call can send an email with attachments.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSessionAndClient } from '@/lib/auth';
import { requireOperator } from '@/lib/operator';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { audit } from '@/lib/audit';
import { resendHeldPromo } from '@/lib/promo-materials';

export const runtime = 'nodejs';

const Body = z.object({ offer_id: z.string().uuid() });

export async function POST(req: NextRequest) {
  const limit = tieredLimit(req, 'expensive');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  let sb, session;
  try {
    ({ sb, session } = await requireSessionAndClient());
    requireOperator(session);
  } catch (r) {
    return r as Response;
  }
  const body = await readJson(req, Body);
  if (body instanceof NextResponse) return body;

  const result = await resendHeldPromo(sb, { offerId: body.offer_id, firmId: session.firm_id });
  await audit(
    {
      action: 'promo.resend_requested',
      target_type: 'creator_offer',
      target_id: body.offer_id,
      firm_id: session.firm_id,
      metadata: { status: result.status, outcome: result.body.outcome ?? result.body.error ?? null },
    },
    req,
  );
  return NextResponse.json(result.body, { status: result.status });
}
