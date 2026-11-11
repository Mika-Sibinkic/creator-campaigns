// src/lib/paypal-isolated.ts
//
// SECURITY-OK: paypal-secret-isolation — this is the ONLY module in the
// codebase allowed to read PAYPAL_CLIENT_SECRET (and PAYPAL_CLIENT_ID /
// PAYPAL_WEBHOOK_ID). tests/secret-isolation.test.ts greps the entire src/
// tree and fails if any other module references PAYPAL_CLIENT_SECRET. Audit
// metadata + log lines NEVER include the secret or the OAuth token.
//
// PayPal Payouts is the creator-settlement rail: the label pays the creator by
// EMAIL. This module is a thin fetch() shim — no PayPal SDK — so a misuse can't
// slip a secret read past the isolation grep gate.
//
// Endpoints (v1):
//   POST /v1/oauth2/token                          — client_credentials → bearer
//   POST /v1/payments/payouts                       — create a batch payout (EMAIL recipient)
//   GET  /v1/payments/payouts/{batch_id}            — poll batch + item status
//   POST /v1/notifications/verify-webhook-signature — authenticate an inbound webhook
//
// Env (sandbox vs live is chosen by the caller, derived from PAYMENTS_MODE):
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET  — REST app credentials
//   PAYPAL_WEBHOOK_ID                        — the webhook id from the PayPal dashboard

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
const LIVE_BASE = 'https://api-m.paypal.com';

export function paypalBase(sandbox: boolean): string {
  return sandbox ? SANDBOX_BASE : LIVE_BASE;
}

/**
 * True when PayPal REST credentials are present. Presence-only — never reads or
 * logs the secret value. Exposed so resolvePaymentMode() can decide the paper
 * fallback WITHOUT referencing PAYPAL_CLIENT_SECRET outside this module (keeps
 * the secret-isolation gate green).
 */
export function paypalConfigured(): boolean {
  return !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET;
}

// ── OAuth token cache ──────────────────────────────────────────────────────
// Cached per base URL so a warm serverless instance doesn't re-auth on every
// call. Expiry is trimmed by 60s to avoid using a token that dies mid-flight.
interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}
const tokenCache = new Map<string, CachedToken>();

async function getAccessToken(sandbox: boolean): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) {
    return { ok: false, error: 'paypal_credentials_missing' };
  }
  const base = paypalBase(sandbox);
  const cached = tokenCache.get(base);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return { ok: true, token: cached.token };
  }
  try {
    const res = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
      error?: string;
    };
    if (!res.ok || !json.access_token) {
      return { ok: false, error: json.error_description ?? json.error ?? `HTTP ${res.status}` };
    }
    const ttlMs = Math.max(0, (json.expires_in ?? 32400) - 60) * 1000;
    tokenCache.set(base, { token: json.access_token, expiresAt: now + ttlMs });
    return { ok: true, token: json.access_token };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Create payout ──────────────────────────────────────────────────────────

export interface PaypalPayoutInput {
  sandbox: boolean;
  amount_usd: number;
  receiver_email: string; // the creator's confirmed PayPal email
  note: string; // shown to the creator in PayPal's notification
  email_subject: string; // subject of PayPal's "you have money" email
  email_message: string; // body of PayPal's notification email
  idempotency_key: string; // payment_authorizations.id — dedupes double-submits
}

export interface PaypalPayoutResult {
  ok: boolean;
  batch_id?: string; // payout_batch_id — our reconciliation handle
  batch_status?: string; // PENDING | PROCESSING | SUCCESS | DENIED ...
  error?: string;
}

// Item transaction statuses PayPal can report on the batch/webhook.
export type PaypalItemStatus =
  | 'SUCCESS'
  | 'PENDING'
  | 'UNCLAIMED'
  | 'ONHOLD'
  | 'RETURNED'
  | 'BLOCKED'
  | 'REFUNDED'
  | 'REVERSED'
  | 'FAILED'
  | 'DENIED'
  | 'CANCELED';

/**
 * Creates a single-item batch payout to an EMAIL recipient.
 *
 * Idempotency: PayPal-Request-Id carries the payment_authorization id, so a
 * retried dispatch with the same id returns the original batch rather than
 * paying twice. sender_batch_id carries the same id for reconciliation.
 *
 * A brand-new batch comes back PENDING/PROCESSING — money has NOT settled to
 * the creator yet. The terminal per-item state (SUCCESS vs UNCLAIMED vs
 * RETURNED) arrives asynchronously via the PAYMENT.PAYOUTS-ITEM.* webhook,
 * which is where materials-on-payment is gated.
 */
export async function createPaypalPayout(input: PaypalPayoutInput): Promise<PaypalPayoutResult> {
  if (!isPlausibleEmail(input.receiver_email)) {
    return { ok: false, error: 'invalid_receiver_email' };
  }
  const auth = await getAccessToken(input.sandbox);
  if (!auth.ok) return { ok: false, error: auth.error };

  const base = paypalBase(input.sandbox);
  const body = {
    sender_batch_header: {
      sender_batch_id: input.idempotency_key,
      recipient_type: 'EMAIL',
      email_subject: input.email_subject.slice(0, 255),
      email_message: input.email_message.slice(0, 1000),
    },
    items: [
      {
        recipient_type: 'EMAIL',
        receiver: input.receiver_email,
        amount: { value: input.amount_usd.toFixed(2), currency: 'USD' },
        note: input.note.slice(0, 1000),
        sender_item_id: input.idempotency_key,
        recipient_wallet: 'PAYPAL',
      },
    ],
  };

  try {
    const res = await fetch(`${base}/v1/payments/payouts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'content-type': 'application/json',
        // Endpoint-level idempotency — a retry with the same id won't double-pay.
        'PayPal-Request-Id': input.idempotency_key,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      batch_header?: { payout_batch_id?: string; batch_status?: string };
      name?: string;
      message?: string;
      details?: Array<{ issue?: string; description?: string }>;
    };
    if (!res.ok) {
      const detail = json.details?.[0]?.description ?? json.details?.[0]?.issue;
      return { ok: false, error: json.message ? `${json.name ?? 'error'}: ${json.message}${detail ? ` (${detail})` : ''}` : `HTTP ${res.status}` };
    }
    return {
      ok: true,
      batch_id: json.batch_header?.payout_batch_id,
      batch_status: json.batch_header?.batch_status,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Poll payout status (reconciliation / fallback when a webhook is missed) ──

export interface PaypalPayoutStatus {
  ok: boolean;
  batch_status?: string;
  item_status?: PaypalItemStatus;
  item_id?: string;
  error?: string;
}

export async function getPaypalPayoutStatus(sandbox: boolean, batchId: string): Promise<PaypalPayoutStatus> {
  const auth = await getAccessToken(sandbox);
  if (!auth.ok) return { ok: false, error: auth.error };
  const base = paypalBase(sandbox);
  try {
    const res = await fetch(`${base}/v1/payments/payouts/${encodeURIComponent(batchId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
    });
    const json = (await res.json()) as {
      batch_header?: { batch_status?: string };
      items?: Array<{ transaction_status?: string; payout_item_id?: string }>;
      message?: string;
    };
    if (!res.ok) return { ok: false, error: json.message ?? `HTTP ${res.status}` };
    const item = json.items?.[0];
    return {
      ok: true,
      batch_status: json.batch_header?.batch_status,
      item_status: item?.transaction_status as PaypalItemStatus | undefined,
      item_id: item?.payout_item_id,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Webhook signature verification ─────────────────────────────────────────

export interface PaypalWebhookHeaders {
  authAlgo: string | null;
  certUrl: string | null;
  transmissionId: string | null;
  transmissionSig: string | null;
  transmissionTime: string | null;
}

/**
 * Authenticates an inbound PayPal webhook by posting the transmission headers +
 * the raw event back to PayPal's verify-webhook-signature endpoint. We do NOT
 * roll our own crypto — PayPal's endpoint is authoritative.
 *
 * Defense-in-depth: reject any cert_url whose host is not a paypal.com domain
 * before we trust it enough to round-trip.
 */
export async function verifyPaypalWebhook(
  sandbox: boolean,
  headers: PaypalWebhookHeaders,
  rawEventJson: string,
): Promise<{ ok: true; verified: boolean } | { ok: false; error: string }> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return { ok: false, error: 'paypal_webhook_id_missing' };
  const { authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime } = headers;
  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
    return { ok: true, verified: false };
  }
  if (!isPaypalCertHost(certUrl)) {
    return { ok: true, verified: false };
  }
  const auth = await getAccessToken(sandbox);
  if (!auth.ok) return { ok: false, error: auth.error };

  let event: unknown;
  try {
    event = JSON.parse(rawEventJson);
  } catch {
    return { ok: true, verified: false };
  }

  const base = paypalBase(sandbox);
  try {
    const res = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: webhookId,
        webhook_event: event,
      }),
    });
    const json = (await res.json()) as { verification_status?: string; message?: string };
    if (!res.ok) return { ok: false, error: json.message ?? `HTTP ${res.status}` };
    return { ok: true, verified: json.verification_status === 'SUCCESS' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Conservative email plausibility check — not RFC-perfect, just typo defense. */
export function isPlausibleEmail(email: string): boolean {
  if (typeof email !== 'string') return false;
  const e = email.trim();
  if (e.length < 3 || e.length > 254) return false;
  // exactly one @, non-empty local part, a dotted domain with a 2+ char TLD
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

/** cert_url must live on a paypal.com host (defense-in-depth before trust). */
export function isPaypalCertHost(certUrl: string): boolean {
  try {
    const u = new URL(certUrl);
    return u.protocol === 'https:' && (u.hostname === 'paypal.com' || u.hostname.endsWith('.paypal.com'));
  } catch {
    return false;
  }
}
