// src/app/api/payments/mode/route.ts
//
// GET: which payment mode money moves in right now (paper / stripe_test /
// stripe_live / paypal_*), for the Settings badge, the operator header chip and
// the deals-page simulator gate. The platform setting under the env ceiling
// (resolveActivePaymentMode, migration 064): one database row, no Stripe call.
//
// POST: the operator-only Test/Live switch. Body { mode: 'stripe_test' |
// 'stripe_live', confirmation?: 'SWITCH TO LIVE' }. To Live requires the typed
// confirmation and an all-green readiness checklist, re-run here on the server.
// Audited as payments.mode_switch. Logic: src/lib/payments-readiness.ts.
//
// SEC: session-gated (every route under api/payments/** authenticates
// in-route; tests/firm-scope.test.ts enforces it). POST is additionally
// requireOperator: a label can never flip its own payments to Live. It touches
// no payment row, only the single platform_payment_settings row.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth';
import { requireOperator } from '@/lib/operator';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase';
import { readJson } from '@/lib/validate';
import { resolveActivePaymentMode } from '@/lib/stripe-isolated';
import { switchPaymentsMode } from '@/lib/payments-readiness';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  try {
    await requireSession();
  } catch (r) {
    return r as Response;
  }
  const active = await resolveActivePaymentMode(supabaseAdmin());
  return NextResponse.json({ mode: active.mode }, { headers: { 'cache-control': 'no-store' } });
}

const Body = z.object({
  mode: z.enum(['stripe_test', 'stripe_live']),
  confirmation: z.string().max(64).optional(),
});

export async function POST(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  let session;
  try {
    session = await requireSession();
    requireOperator(session);
  } catch (r) {
    return r as Response;
  }
  const body = await readJson(req, Body);
  if (body instanceof NextResponse) return body;

  const out = await switchPaymentsMode(
    supabaseAdmin(),
    { session, target: body.mode, confirmation: body.confirmation },
    { audit: async (entry) => { await audit(entry, req); } }
  );
  return NextResponse.json(out.body, { status: out.httpStatus });
}
