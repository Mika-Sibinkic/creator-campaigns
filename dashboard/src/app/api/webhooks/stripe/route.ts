// src/app/api/webhooks/stripe/route.ts
//
// SECURITY-OK: supabaseAdmin — Stripe webhook has no user JWT; writes deal
// payout state after verifying the Stripe-Signature (HMAC-SHA256 over
// `${t}.${rawBody}`, constant-time compare, 5-min replay tolerance). The
// verification and every signing secret live in src/lib/stripe-isolated.ts
// (verifyStripeWebhook); this route reads no Stripe secret. Middleware
// whitelists /api/webhooks/* already.
//
// TEST/LIVE (migration 064): one endpoint serves both modes. The signing
// secret that verifies the payload decides the event's mode
// (STRIPE_WEBHOOK_SECRETS_TEST / _LIVE, comma-separated; the legacy
// STRIPE_WEBHOOK_SECRET counts as Test), event.livemode must agree, and every
// handler only touches rows of that mode.
//
// ACCOUNTS v2: a v2 event destination (thin payloads,
// object "v2.core.event") may point at this same URL; its whsec_ goes in the
// same per-mode secret list. Three thin types are acted on —
// v2.core.account[configuration.recipient].capability_status_updated,
// v2.core.account[requirements].updated, v2.core.account_link.returned — by
// fetching the account's current state (stripe-isolated
// resolveThinAccountEvent) and, when it can receive transfers, running the
// same awaiting-onboarding payout loop as account.updated.
//
// Stripe Connect settlement. This handles
// CONNECT events only (the old creator-PAYS checkout webhook was removed):
//   account.updated with payouts_enabled=true → the creator finished onboarding
//   → for each awaiting payout: claim it (stamping executing_at so a dead
//   process is reclaimable), re-read the deal (it may have been cancelled or
//   closed since the approval), re-check every spend cap (src/lib/spend-caps.ts
//   — same three as the execute path), then transfer under the idempotency key
//   the execute path also uses → flip the deal paid + send promo materials.
//   Per-row logic: src/lib/onboarding-payout.ts.
//   transfer.reversed → the money was clawed back out of the creator's Stripe
//   balance; the creator is NOT paid. Reverse the payout and raise it.
//   payout.failed → the creator's own bank bounced the payout. The label's
//   money DID leave, so the deal is not un-paid; it is surfaced for an
//   operator to chase the creator's bank details.
//
// There is deliberately no `transfer.failed` branch: that event does not exist
// in the current Stripe API (deleted in version 2017-04-06 along with
// transfer.paid). A transfer either succeeds or throws at call time, where
// src/lib/stripe-isolated.ts already maps it. See src/lib/settlement-failure.ts
// for the citations.
//
// Decision logic lives in src/lib/settlement-failure.ts with injected hooks so
// it is testable without this route; this file verifies, dedupes and dispatches.

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { sendPromoMaterials } from '@/lib/promo-materials';
import {
  authenticateStripeWebhook,
  connectAccountsApi,
  executePayout,
  isConnectThinEventType,
  isThinEvent,
  resolveActivePaymentMode,
  resolveThinAccountEvent,
  type StripeThinEvent,
} from '@/lib/stripe-isolated';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { alertOnce } from '@/lib/sentry-alerts';
import { webhookCapGate } from '@/lib/spend-caps';
import { payOnboardedAuthorization } from '@/lib/onboarding-payout';
import {
  handleTransferReversed,
  handlePayoutFailed,
  type SettlementHooks,
} from '@/lib/settlement-failure';

export const runtime = 'nodejs';

interface StripeAccount {
  id?: string;
  payouts_enabled?: boolean;
  /** v1 view; for a v2 account `transfers` mirrors stripe_balance.stripe_transfers. */
  capabilities?: { transfers?: string } | null;
}
/** transfer.reversed → data.object is the TRANSFER, never the reversal (there
 *  is no `transfer_reversal.*` event). The modern Transfer object carries no
 *  `status`, `failure_code` or `failure_message` — those were removed in API
 *  version 2017-04-06 — so partial reversals must be read off the amounts. */
interface StripeTransfer {
  id?: string;
  amount?: number;
  amount_reversed?: number;
  reversed?: boolean;
}
/** payout.failed → data.object is the PAYOUT, delivered on the Connect
 *  endpoint with the connected account in the event's top-level `account`. */
interface StripePayout {
  id?: string;
  failure_code?: string | null;
  failure_message?: string | null;
}
interface StripeEvent extends StripeThinEvent {
  id?: string;
  type?: string;
  /** true for a live-mode event, false for test. Must agree with the secret. */
  livemode?: boolean;
  /** Connect deliveries carry the connected account that originated the event. */
  account?: string;
  data?: { object?: StripeAccount & StripeTransfer & StripePayout };
}

interface AwaitingPa {
  id: string;
  firm_id: string | null;
  campaign_id: string | null;
  amount_usd: number | null;
  creator_offer_id: string | null;
  /** Absent only on the pre-055 fallback lookup. */
  leg?: 'full' | 'deposit' | 'balance' | null;
  creator_offers: {
    campaign_influencers: { influencer_id: string | null } | null;
  } | null;
}

export async function POST(req: Request) {
  const limit = tieredLimit(req, 'public');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }

  const rawBody = await req.text();
  if (rawBody.length > 256_000) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }
  // Fail closed: no configured secret, a bad signature, or a livemode that
  // disagrees with the secret that verified it → nothing is touched.
  const auth = authenticateStripeWebhook<StripeEvent>(rawBody, req.headers.get('stripe-signature'));
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error, ...(auth.reason ? { reason: auth.reason } : {}) },
      { status: auth.status }
    );
  }
  const event = auth.event;
  const eventId = event.id as string;
  // The mode this event belongs to. Every handler below is scoped to it.
  const eventMode = auth.mode;

  const sb = supabaseAdmin();
  // The mode payouts go out in now, and whether 064 is in force (pinned).
  // Pre-064 nothing is mode-scoped beyond what each transfer id already is.
  const active = await resolveActivePaymentMode(sb);

  // One hooks object for every settlement decision in this route, so audit
  // rows from the webhook are consistently attributed (audit() otherwise falls
  // back to getSession(), and a webhook has no session).
  const hooks: SettlementHooks = {
    audit: (entry) => audit({ ...entry, actor_label: 'webhook:stripe' }, req),
    alertOnce,
  };

  // Dedupe (read now, mark after side effects so a transient failure → 5xx retry).
  const { data: seen } = await sb
    .from('processed_stripe_events')
    .select('event_id')
    .eq('event_id', eventId)
    .maybeSingle();
  if (seen) return NextResponse.json({ received: true, duplicate: true });

  // Which connected account (if any) this event says can now be paid.
  //   account.updated (v1 snapshot; Stripe still sends it for v2 accounts on
  //     the Connected-accounts scope): payouts_enabled, or — with Accounts v2
  //     in this mode — the transfers capability active. executePayout re-checks
  //     readiness through the configured API before any transfer either way.
  //   Connect thin events (v2 event destination): verified above with the same
  //     signature scheme, then the account's CURRENT state is fetched by
  //     stripe-isolated (the payload carries no snapshot). A failed fetch is a
  //     503 so Stripe redelivers; the event is not marked processed.
  let onboardedAcctId: string | null = null;
  if (event.type === 'account.updated') {
    const obj = event.data?.object;
    const transfersActive = connectAccountsApi(eventMode) === 'v2' && obj?.capabilities?.transfers === 'active';
    if (obj?.payouts_enabled === true || transfersActive) onboardedAcctId = obj?.id ?? null;
  } else if (isThinEvent(event) && isConnectThinEventType(event.type)) {
    const resolved = await resolveThinAccountEvent(eventMode, event);
    if (!resolved.ok) {
      console.error('[stripe-webhook] thin event fetch failed:', resolved.error);
      return NextResponse.json({ error: 'thin_event_fetch_failed' }, { status: 503 });
    }
    if (resolved.ready) onboardedAcctId = resolved.account_id;
  }

  if (onboardedAcctId) {
    const acctId = onboardedAcctId;
    {
      // Find approved authorizations whose deal is awaiting this account's
      // onboarding. With 064 in force, only rows approved in this event's mode
      // whose Connect account belongs to this event's mode; the claim in
      // onboarding-payout.ts then also pins approved_mode to the ACTIVE mode,
      // so a Test event never moves money while the platform pays in Live.
      const lookup = (withLeg: boolean) => {
        let q = sb
          .from('payment_authorizations')
          .select(
            `id, firm_id, campaign_id, amount_usd, creator_offer_id,${withLeg ? ' leg,' : ''}
             creator_offers!inner(
               payout_status,
               campaign_influencers!inner(
                 influencer_id,
                 influencer:influencers!inner(stripe_connect_account_id)
               )
             )`,
          )
          .eq('status', 'approved')
          .eq('creator_offers.payout_status', 'awaiting_onboarding')
          .eq('creator_offers.campaign_influencers.influencer.stripe_connect_account_id', acctId);
        if (active.pinned) {
          q = q
            .eq('approved_mode', eventMode)
            .eq('creator_offers.campaign_influencers.influencer.stripe_connect_account_mode', eventMode);
        }
        return q;
      };
      // `leg` arrives with migration 055. The
      // fallback stays for any database that predates it, same degrade as
      // authorize-payment.ts: on a query ERROR retry the pre-055 shape; a row
      // with no leg is keyed and settled as 'full', 055's default.
      let { data: rows, error: rowsErr } = await lookup(true);
      if (rowsErr) {
        console.warn('[stripe-webhook] leg-aware lookup failed; retrying pre-055 shape:', rowsErr.message);
        ({ data: rows, error: rowsErr } = await lookup(false));
      }
      if (rowsErr) {
        console.error('[stripe-webhook] awaiting lookup failed:', rowsErr.message);
        return NextResponse.json({ error: 'lookup_failed' }, { status: 503 });
      }

      // Each row: claim (stamping executing_at) → re-read the deal → amount →
      // spend caps → transfer under the shared idempotency key. All of it lives
      // in src/lib/onboarding-payout.ts; refusals are audited there. A refused
      // row never fails the delivery — we still return 200 at the bottom so
      // Stripe doesn't retry forever.
      for (const r of (rows ?? []) as unknown as AwaitingPa[]) {
        await payOnboardedAuthorization(
          sb,
          {
            id: r.id,
            firm_id: r.firm_id,
            campaign_id: r.campaign_id,
            amount_usd: r.amount_usd,
            creator_offer_id: r.creator_offer_id,
            leg: r.leg ?? null,
            influencer_id: r.creator_offers?.campaign_influencers?.influencer_id ?? null,
          },
          acctId,
          {
            ...hooks,
            executePayout,
            capGate: webhookCapGate,
            sendPromoMaterials,
            paymentMode: () => active.mode,
            pinMode: active.pinned,
          },
        );
      }
    }
  }

  // transfer.reversed — the platform clawed the money back out of the
  // creator's Stripe balance, so the creator is NOT paid. `reversed` is true
  // only on a FULL reversal, so the amounts are passed through too and the
  // partial case is detected in the handler.
  if (event.type === 'transfer.reversed') {
    const obj = event.data?.object;
    const outcome = await handleTransferReversed(
      sb,
      {
        transferId: obj?.id ?? null,
        amountMinor: typeof obj?.amount === 'number' ? obj.amount : null,
        amountReversedMinor:
          typeof obj?.amount_reversed === 'number' ? obj.amount_reversed : null,
        reversed: obj?.reversed === true,
        eventId,
        // Only a payment that was sent in this event's mode (payment_mode is
        // stamped at execution, migration 015, so this holds pre-064 too).
        mode: eventMode,
      },
      hooks,
    );
    // A lookup we could not complete must NOT be marked processed — 503 so
    // Stripe redelivers, rather than silently losing a reversal.
    if (!outcome.handled && outcome.reason === 'lookup_failed') {
      return NextResponse.json({ error: 'lookup_failed' }, { status: 503 });
    }
  }

  // payout.failed — the creator's own bank rejected the payout out of their
  // Stripe balance. Connect delivery, so the connected account is the event's
  // top-level `account`, and the Payout object carries failure_code/message.
  // The label's money already left, so this does not un-pay the deal.
  if (event.type === 'payout.failed') {
    const obj = event.data?.object;
    const outcome = await handlePayoutFailed(
      sb,
      {
        connectAccountId: event.account ?? null,
        failureCode: obj?.failure_code ?? null,
        failureMessage: obj?.failure_message ?? null,
        payoutId: obj?.id ?? null,
        eventId,
        // With 064 in force, only creators whose Connect account is of this mode.
        ...(active.pinned ? { connectAccountMode: eventMode } : {}),
      },
      hooks,
    );
    if (!outcome.handled && outcome.reason === 'lookup_failed') {
      return NextResponse.json({ error: 'lookup_failed' }, { status: 503 });
    }
  }

  const { error: markErr } = await sb.from('processed_stripe_events').insert({ event_id: eventId } as never);
  if (markErr && markErr.code !== '23505') {
    console.error('[stripe-webhook] mark-processed failed (non-fatal):', markErr.message);
  }

  return NextResponse.json({ received: true });
}
