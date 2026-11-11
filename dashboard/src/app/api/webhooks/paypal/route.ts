// src/app/api/webhooks/paypal/route.ts
//
// SECURITY-OK: supabaseAdmin — PayPal webhook has no user JWT; writes deal
// payout state after verifying the transmission signature. This module does NOT
// read PAYPAL_CLIENT_SECRET — it calls verifyPaypalWebhook() in paypal-isolated
// (the ONLY module allowed to touch the secret), so it stays outside the
// secret-isolation grep gate. Middleware whitelists /api/webhooks/* (public +
// CSRF-exempt) already.
//
// PayPal Payouts settlement. A payout dispatched by
// /api/payments/[id]/execute lands PENDING/UNCLAIMED; the terminal per-item
// state arrives here:
//   PAYMENT.PAYOUTS-ITEM.SUCCEEDED → creator claimed → flip paid + send materials
//   PAYMENT.PAYOUTS-ITEM.UNCLAIMED → sent, not yet claimed → mark, alert, NO materials
//   RETURNED/FAILED/BLOCKED/DENIED/REFUNDED/REVERSED/CANCELED → mark failed, alert, NO materials
//
// We map the item back to our deal via sender_item_id, which execute-route set
// to the payment_authorizations.id.

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { sendPromoMaterials } from '@/lib/promo-materials';
import { verifyPaypalWebhook } from '@/lib/paypal-isolated';
import { resolvePaymentMode } from '@/lib/stripe-isolated';
import { alertOnce } from '@/lib/sentry-alerts';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';

export const runtime = 'nodejs';

interface PaypalWebhookEvent {
  id?: string;
  event_type?: string;
  resource?: {
    transaction_status?: string;
    payout_item_id?: string;
    sender_item_id?: string;
    payout_item?: { sender_item_id?: string };
  };
}

// Map a PayPal item transaction_status to our creator_offers.payout_status and
// whether it is a terminal success (claimed) vs a terminal failure.
function classify(status: string | undefined): 'success' | 'unclaimed' | 'failed' | 'ignore' {
  switch ((status ?? '').toUpperCase()) {
    case 'SUCCESS':
      return 'success';
    case 'UNCLAIMED':
    case 'ONHOLD':
    case 'PENDING':
      return 'unclaimed';
    case 'RETURNED':
    case 'FAILED':
    case 'BLOCKED':
    case 'DENIED':
    case 'REFUNDED':
    case 'REVERSED':
    case 'CANCELED':
      return 'failed';
    default:
      return 'ignore';
  }
}

export async function POST(req: Request) {
  // Rate-limit the unauthenticated settlement webhook so a flood of crafted
  // requests can't amplify into unbounded verify-webhook-signature calls to
  // PayPal (which would throttle legitimate settlements). PayPal retries a 429.
  const limit = tieredLimit(req, 'public');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }

  const mode = resolvePaymentMode();
  // Verify against the live host unless we're explicitly in sandbox mode. The
  // PAYPAL_WEBHOOK_ID env keys the verification to the app's registered webhook.
  const sandbox = mode !== 'paypal_live';

  const rawBody = await req.text();
  // Cap body size before the verify round-trip (defense against large-payload abuse).
  if (rawBody.length > 64_000) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }
  const verdict = await verifyPaypalWebhook(
    sandbox,
    {
      authAlgo: req.headers.get('paypal-auth-algo'),
      certUrl: req.headers.get('paypal-cert-url'),
      transmissionId: req.headers.get('paypal-transmission-id'),
      transmissionSig: req.headers.get('paypal-transmission-sig'),
      transmissionTime: req.headers.get('paypal-transmission-time'),
    },
    rawBody,
  );
  if (!verdict.ok) {
    // Missing webhook id / token failure — cannot trust the payload. Fail closed.
    return NextResponse.json({ error: 'webhook_not_verifiable', reason: verdict.error }, { status: 500 });
  }
  if (!verdict.verified) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  let event: PaypalWebhookEvent;
  try {
    event = JSON.parse(rawBody) as PaypalWebhookEvent;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!event.id) return NextResponse.json({ error: 'missing_event_id' }, { status: 400 });

  const sb = supabaseAdmin();

  // Idempotency is a READ, not a claim: the real once-only gate is the paid_at
  // null-guard on the flip below. Mark processed only AFTER side effects succeed
  // so a transient DB failure returns 5xx (PayPal retries) rather than dropping it.
  const { data: seen } = await sb
    .from('processed_paypal_events')
    .select('event_id')
    .eq('event_id', event.id)
    .maybeSingle();
  if (seen) return NextResponse.json({ received: true, duplicate: true });

  // Only payout-ITEM events carry a deal mapping; batch-level or any other
  // subscribed event type must never drive a deal flip even if it happens to
  // carry a sender_item_id + SUCCESS (defense-in-depth on the classify()).
  const isPayoutItemEvent = (event.event_type ?? '').startsWith('PAYMENT.PAYOUTS-ITEM.');
  const senderItemId = event.resource?.payout_item?.sender_item_id ?? event.resource?.sender_item_id;
  const kind = classify(event.resource?.transaction_status);

  if (isPayoutItemEvent && senderItemId && kind !== 'ignore') {
    // sender_item_id === payment_authorizations.id (set by execute-route).
    const { data: pa, error: paErr } = await sb
      .from('payment_authorizations')
      .select('id, firm_id, creator_offer_id, amount_usd')
      .eq('id', senderItemId)
      .maybeSingle();
    if (paErr) {
      console.error('[paypal-webhook] pa lookup failed:', paErr.message);
      return NextResponse.json({ error: 'lookup_failed' }, { status: 503 });
    }

    if (pa) {
      const row = pa as { id: string; firm_id: string | null; creator_offer_id: string | null; amount_usd: number | null };
      const offerId = row.creator_offer_id;

      if (kind === 'success' && offerId) {
        // Flip only if not already paid — the row is the once-only gate.
        const { data: updated, error: flipErr } = await sb
          .from('creator_offers')
          .update({ status: 'paid', paid_at: new Date().toISOString(), payout_status: 'paid' } as never)
          .eq('id', offerId)
          .is('paid_at', null)
          .select('id')
          .maybeSingle();
        if (flipErr) {
          console.error('[paypal-webhook] paid flip failed:', flipErr.message, 'offer', offerId);
          return NextResponse.json({ error: 'flip_failed' }, { status: 503 });
        }
        if (updated) {
          await audit(
            {
              action: 'deal.paid',
              target_type: 'creator_offer',
              target_id: offerId,
              firm_id: row.firm_id ?? undefined,
              metadata: {
                payout_batch_item: event.resource?.payout_item_id ?? null,
                amount_usd: row.amount_usd,
                provider: 'paypal',
                binding: 'creator_claimed_payout',
              },
            },
            req,
          );
          // Materials-on-payment (idempotent). Failures are logged inside and
          // never block the ack.
          await sendPromoMaterials(sb, { creatorOfferId: offerId });
        }
      } else if (kind === 'unclaimed' && offerId) {
        await sb.from('creator_offers').update({ payout_status: 'unclaimed' } as never).eq('id', offerId).is('paid_at', null);
        await audit(
          {
            action: 'payment.payout_unclaimed',
            target_type: 'creator_offer',
            target_id: offerId,
            firm_id: row.firm_id ?? undefined,
            metadata: { payment_authorization_id: row.id, provider: 'paypal' },
          },
          req,
        );
        alertOnce(
          `paypal_unclaimed:${row.id}`,
          'warning',
          'PayPal payout unclaimed by creator',
          { firm_id: row.firm_id, payment_authorization_id: row.id, creator_offer_id: offerId },
        );
      } else if (kind === 'failed') {
        // Money did not reach the creator. Mark the deal + authorization failed,
        // do NOT send materials, alert the firm.
        if (offerId) {
          // Record the reversal even if the deal was already PAID — a post-claim
          // RETURNED/REVERSED/REFUNDED must not be silently dropped. Surfaces via
          // the alert below for manual clawback reconciliation (materials already
          // sent can't be unsent; a human handles it).
          await sb.from('creator_offers').update({ payout_status: 'returned' } as never).eq('id', offerId);
        }
        await sb
          .from('payment_authorizations')
          .update({ status: 'failed', failure_reason: `paypal_${(event.resource?.transaction_status ?? 'failed').toLowerCase()}` } as never)
          .eq('id', row.id);
        await audit(
          {
            action: 'payment.failed',
            target_type: 'payment_authorization',
            target_id: row.id,
            firm_id: row.firm_id ?? undefined,
            metadata: {
              creator_offer_id: offerId,
              provider: 'paypal',
              transaction_status: event.resource?.transaction_status ?? null,
            },
          },
          req,
        );
        alertOnce(
          `paypal_failed:${row.id}`,
          'error',
          'PayPal payout failed / returned',
          { firm_id: row.firm_id, payment_authorization_id: row.id, transaction_status: event.resource?.transaction_status },
        );
      }
    } else {
      // A validly-signed payout-item event whose payment_authorization we can't
      // find yet (read-after-write lag / wrong env). Do NOT mark processed —
      // return 5xx so PayPal retries rather than dropping a real settlement.
      console.error('[paypal-webhook] no payment_authorization for sender_item_id', senderItemId);
      return NextResponse.json({ error: 'pa_not_found' }, { status: 503 });
    }
  }

  // Mark processed only after side effects succeeded. A unique violation
  // (concurrent duplicate delivery) is benign.
  const { error: markErr } = await sb
    .from('processed_paypal_events')
    .insert({ event_id: event.id } as never);
  if (markErr && markErr.code !== '23505') {
    console.error('[paypal-webhook] mark-processed failed (non-fatal):', markErr.message);
  }

  return NextResponse.json({ received: true });
}
