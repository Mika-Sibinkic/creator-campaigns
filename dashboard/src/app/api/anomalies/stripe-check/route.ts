// src/app/api/anomalies/stripe-check/route.ts
//
// OPERATOR PATH — "Check with Stripe" on a payment whose outcome is unknown (or
// a stale 'executing' claim) in /anomalies (payment_anomaly lane).
//
// All decisions live in reconcilePaymentOutcome (src/lib/payment-reconcile.ts,
// executed in tests/money-path-adversarial.test.ts): firm-scoped, only an
// 'executing' row, Stripe read by transfer_group through the isolated client.
// Read-only at Stripe — it NEVER re-sends. Outcomes:
//   completed      the transfer exists → the payment is recorded as sent
//   not_sent       Stripe has no transfer → the row becomes a retryable failure
//   still_unknown  Stripe could not answer, or its record does not match
//
// 'auth' tier: one GET to Stripe per click.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSessionAndClient } from '@/lib/auth';
import { requireOperator } from '@/lib/operator';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { audit } from '@/lib/audit';
import { reconcilePaymentOutcome, type ReconcileOutcome } from '@/lib/payment-reconcile';

export const runtime = 'nodejs';

const Body = z.object({ payment_authorization_id: z.string().uuid() });

const STILL_UNKNOWN_COPY: Record<string, string> = {
  lookup_failed: 'Stripe could not be reached. Nothing changed. Try again in a minute.',
  too_soon: 'Too soon to be sure: Stripe may still be processing it. Check again in two minutes.',
  multiple_transfers: 'Stripe holds more than one transfer for this payment. Nothing changed. Resolve it in Stripe.',
  amount_mismatch: 'Stripe holds a transfer with a different amount. Nothing changed. Resolve it in Stripe.',
  transfer_reversed: 'Stripe holds a reversed transfer for this payment. Nothing changed. Resolve it in Stripe.',
  not_stripe: 'Payments are not running on Stripe right now, so there is nothing to check.',
  provider_unreachable:
    'This payment was sent from a different Stripe account (test vs live) than this server is using, so it cannot be checked from here. Nothing changed. Fix the Stripe key for that mode, or check it in that Stripe dashboard.',
};

function respond(r: ReconcileOutcome): { status: number; body: Record<string, unknown> } {
  switch (r.outcome) {
    case 'completed':
      return { status: 200, body: { ...r, message: 'Stripe confirms it was sent. Recorded as paid.' } };
    case 'not_sent':
      return { status: 200, body: { ...r, message: 'Stripe confirms nothing was sent. It is now a failed payment you can safely retry from the deal.' } };
    case 'still_unknown':
      return { status: 409, body: { ...r, message: STILL_UNKNOWN_COPY[r.reason] ?? 'Still unknown. Nothing changed.' } };
    case 'not_applicable':
      return { status: 409, body: { ...r, message: 'This payment is no longer waiting on a check. Reload the page.' } };
    case 'forbidden':
    case 'not_found':
      return { status: 404, body: { outcome: 'not_found', error: 'payment_authorization_not_found' } };
  }
}

export async function POST(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
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

  const result = await reconcilePaymentOutcome(sb, body.payment_authorization_id, {
    callerFirmId: session.firm_id,
  });
  await audit(
    {
      action: 'payment.stripe_check_requested',
      target_type: 'payment_authorization',
      target_id: body.payment_authorization_id,
      firm_id: session.firm_id,
      metadata: { outcome: result.outcome, reason: 'reason' in result ? result.reason : null },
    },
    req,
  );
  const out = respond(result);
  return NextResponse.json(out.body, { status: out.status });
}
