// src/app/api/webhooks/resend/route.ts
//
// SECURITY-OK: supabaseAdmin — webhook from Resend has no user JWT; writes outreach_messages status updates after Svix-style signature verification (SEC-2).
//
// Resend delivery-status webhook (delivered / opened / bounced / complained).
// Resend signs with Svix; verification is src/lib/svix-verify.ts, shared with
// the inbound-email route. Needs RESEND_WEBHOOK_SECRET (`whsec_<base64>`).
// No user session, so it writes with supabaseAdmin(); middleware lets
// /api/webhooks/* through without auth or CSRF checks.

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import {
  resendEventToStatus,
  mayOverwriteStatus,
  allowedPreviousDeliveryStatuses,
} from '@/lib/resend-events';
import { createLogger } from '@/lib/logger';
import { readSvixHeaders, verifySvixSignature } from '@/lib/svix-verify';

const log = createLogger('resend-webhook');

export const runtime = 'nodejs';

/** Same cap as the inbound-email and Stripe webhooks; a status event is ~1 KB. */
const MAX_BODY_BYTES = 256_000;

// Resend event payload (loose — we only key on type + message_id).
type ResendEvent = {
  type?: string;
  data?: {
    email_id?: string;
    to?: string | string[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/**
 * `retryable` means: tell Resend to send this again. Svix retries on 5xx, so
 * anything that might succeed later (a Supabase blip, an unapplied migration)
 * MUST surface as an error rather than a polite 200. Previously a DB failure
 * was indistinguishable from "no matching row" — both returned 200 — so a
 * 30-second Supabase outage during a send burst permanently discarded those
 * `email.bounced` events with no trace.
 */
type EventOutcome =
  | { kind: 'updated' }
  | { kind: 'ignored'; reason: string }
  | { kind: 'retryable'; reason: string };

async function handleEvent(event: ResendEvent): Promise<EventOutcome> {
  const type = event.type ?? '';
  const messageId = event.data?.email_id ?? null;
  if (!messageId) return { kind: 'ignored', reason: 'no_email_id' };

  // Map Resend event → a DELIVERY status (src/lib/resend-events.ts).
  // delivered/opened/clicked are observability; bounced/complained matter
  // most — they mean the recipient is unusable, and feed /api/anomalies.
  const deliveryStatus = resendEventToStatus(type);
  if (!deliveryStatus) return { kind: 'ignored', reason: `unhandled_type:${type}` };

  // `data.email_id` IS the Resend message id, and the
  // send paths (outreach send route, negotiation-tick dispatch) stamp it onto
  // outreach_messages.provider_message_id at send time. Match on that column
  // directly. The old code matched email_id against the INTERNAL message id
  // via api_ledger.request_meta — two different id spaces, so no status
  // update ever landed.
  const sb = supabaseAdmin();
  const { data: row, error: selErr } = await sb
    .from('outreach_messages')
    .select('id, delivery_status')
    .eq('provider_message_id', messageId)
    .maybeSingle();
  // A read failure is NOT "no match" — say so, and let Svix retry.
  if (selErr) return { kind: 'retryable', reason: `select_failed:${selErr.message}` };
  if (!row) return { kind: 'ignored', reason: 'no_row_for_provider_message_id' };

  const target = row as { id: string; delivery_status: string | null };
  // Out-of-order / retried events must never downgrade what we know
  // (e.g. a late 'delivered' erasing 'opened', anything erasing 'bounced').
  // Checked here to skip a pointless write...
  if (!mayOverwriteStatus(target.delivery_status, deliveryStatus)) {
    return { kind: 'ignored', reason: 'would_downgrade' };
  }

  // ...and enforced AGAIN as a predicate on the UPDATE itself, because the
  // check above is not atomic. Two Svix deliveries can both SELECT the same
  // pre-state and both conclude they may write; the predicate makes the
  // database reject the loser. NULL needs the explicit is-null arm: SQL `IN`
  // never matches NULL, and NULL is the normal starting state.
  const allowed = allowedPreviousDeliveryStatuses(deliveryStatus);
  const { data: updated, error } = await sb
    .from('outreach_messages')
    .update({
      delivery_status: deliveryStatus,
      delivery_status_at: new Date().toISOString(),
    } as never)
    .eq('id', target.id)
    .or(`delivery_status.is.null,delivery_status.in.(${allowed.join(',')})`)
    .select('id');
  // Pre-migration-046 the column does not exist and this errors — retryable
  // on purpose, so the events queue rather than vanish. Crucially it does NOT
  // fall back to writing `status`: that column is the send lifecycle and must
  // stay terminal at 'sent' (see migration 046).
  if (error) return { kind: 'retryable', reason: `update_failed:${error.message}` };
  // Zero rows = the predicate rejected it, i.e. a concurrent event already
  // wrote something at least as informative. Correct, and not an error.
  if (!updated || updated.length === 0) {
    return { kind: 'ignored', reason: 'lost_race_to_equal_or_better_status' };
  }
  return { kind: 'updated' };
}

// No IP rate limit: every sent email produces several status events from
// Resend's sender IPs, and a shared per-IP bucket would 429 the inbound-email
// webhook (creator replies) behind them. The body cap and the HMAC check bound it.
export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET ?? '';
  if (!secret) {
    // Fail-closed: no secret = no way to verify = reject. Logging this so
    // we notice misconfiguration in deploy.
    log.error('RESEND_WEBHOOK_SECRET is unset — rejecting, cannot verify signature');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Declared length first (cheap early-out), then the real byte count.
  const declaredLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }

  // Read RAW body BEFORE JSON.parse — signature is over the exact bytes.
  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }

  const sigCheck = verifySvixSignature(rawBody, readSvixHeaders(req.headers), secret);
  if (!sigCheck.ok) {
    return NextResponse.json(
      { error: 'unauthorized', reason: sigCheck.reason },
      { status: 401 }
    );
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(rawBody) as ResendEvent;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    const result = await handleEvent(event);
    if (result.kind === 'retryable') {
      // 5xx so Svix redelivers. The alternative — a 200 — silently drops a
      // bounce we will never be told about again.
      log.warn('delivery event deferred for retry', { reason: result.reason, type: event.type });
      return NextResponse.json({ ok: false, error: result.reason }, { status: 503 });
    }
    return NextResponse.json({ ok: true, updated: result.kind === 'updated' });
  } catch (e) {
    // An unexpected throw is our bug, but it may equally be transient. Prefer
    // a retry over a silent loss: these events are not reproducible.
    log.error('handler error', { error: e as Error, type: event.type });
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 503 });
  }
}
