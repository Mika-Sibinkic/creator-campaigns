// src/app/api/payments/status/route.ts
//
// GET: the Test/Live payments status for Settings → Payments. Operator only.
// Current mode and ceiling, the live Stripe account (GET /v1/account), its
// balance (GET /v1/balance) and the readiness checklist that gates the switch
// to Live (src/lib/payments-readiness.ts). Read-only: Stripe GETs through
// src/lib/stripe-isolated.ts and database reads. No key value ever leaves the
// server; the response carries presence and prefix-kind only.
//
// SEC: requireSession then requireOperator. A label never sees account ids,
// balances or the checklist; it gets the resolved mode from /api/payments/mode.

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { requireOperator } from '@/lib/operator';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase';
import { readPaymentsStatus } from '@/lib/payments-readiness';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  try {
    const session = await requireSession();
    requireOperator(session);
  } catch (r) {
    return r as Response;
  }
  const status = await readPaymentsStatus(supabaseAdmin());
  return NextResponse.json(status, { headers: { 'cache-control': 'no-store' } });
}
