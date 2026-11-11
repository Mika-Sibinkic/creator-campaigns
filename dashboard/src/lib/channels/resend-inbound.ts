// src/lib/channels/resend-inbound.ts
//
// Resend INBOUND (receiving) adapter — the provider-specific half of email
// reply intake. The transport-agnostic half is email-inbound.ts.
//
// Docs of record:
//   payload  https://resend.com/docs/webhooks/emails/received
//   body     https://resend.com/docs/api-reference/emails/retrieve-received-email
//   DNS      https://resend.com/docs/dashboard/receiving/custom-domains
//
// ── THE ONE THING THAT SHAPES THIS WHOLE MODULE ─────────────────────────────
//
// The `email.received` webhook does NOT contain the email body. Resend states
// it in five separate docs:
//
//   "Webhooks do not include the email body, headers, or attachments, only
//    their metadata. You must call the Received emails API … to retrieve them.
//    This design choice supports large attachments in serverless environments
//    that have limited request body sizes."
//
// So inbound is TWO HOPS: the signed webhook gives metadata (including the
// `email_id`), and the body requires `GET /emails/receiving/:email_id` with the
// Resend API key. A handler that only reads the webhook payload ingests empty
// replies. Attachments would be a third hop; we do not read them — a creator's
// negotiation reply is text, and fetching arbitrary attachment bytes from an
// untrusted sender is a liability we have no use for.
//
// ── DEDUPE ──────────────────────────────────────────────────────────────────
//
// Resend delivers webhooks AT LEAST ONCE and does not guarantee order. We do
// NOT need a `processed_*_events` table for that: `data.email_id` is stable
// across redeliveries of the same email, so `external_id = resend:<email_id>`
// makes ingestInboundReply's existing (channel, external_id) dedupe the
// idempotency key. One less table, no migration.

import type { InboundEmailMessage } from './email-inbound';

/** Injectable fetch seam — mirrors GmailFetch so tests never touch the network. */
export type InboundFetch = (url: string, init?: RequestInit) => Promise<Response>;

const RESEND_API = 'https://api.resend.com';

/** The `email.received` event type, verbatim from Resend's webhook docs. */
export const RESEND_INBOUND_EVENT = 'email.received';

/** Webhook envelope. Only the fields we read are typed. */
export interface ResendInboundEvent {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    created_at?: string;
    from?: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    /** Addresses taken from the `for` clause of the message's Received headers. */
    received_for?: string[];
    /** RFC Message-ID header value — NOT the dedupe key; `email_id` is. */
    message_id?: string;
    subject?: string;
  };
}

/** `GET /emails/receiving/:email_id` response. Only the fields we read. */
export interface ResendReceivedEmail {
  id?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  text?: string | null;
  html?: string | null;
  html_format?: string;
  headers?: Record<string, string>;
  received_for?: string[];
  created_at?: string;
}

export type ContentFetchResult =
  | { ok: true; email: ResendReceivedEmail }
  | { ok: false; error: string };

/**
 * Hop two: retrieve the body Resend deliberately withheld from the webhook.
 *
 * Reads RESEND_API_KEY directly rather than via getEnv() because getEnv THROWS
 * on a missing key. A webhook must degrade to a legible 5xx (so Resend retries
 * on its published schedule) instead of exploding inside the handler. Only
 * STRIPE_SECRET_KEY and PAYPAL_CLIENT_SECRET are secret-isolation-gated
 * (tests/secret-isolation.test.ts); RESEND_API_KEY is already read in
 * src/lib/resend.ts.
 */
/**
 * Hard ceiling on the retrieved body. The webhook envelope is capped at the
 * route, but THAT is the metadata Resend deliberately keeps small — this hop is
 * the one Resend withholds precisely because it can be large, and it was the
 * unbounded half. 1 MB is generous for a negotiation reply and bounds the work
 * the downstream text processing can ever be asked to do.
 */
export const MAX_CONTENT_BYTES = 1_000_000;

/** Hop two must not hold a webhook worker open indefinitely. */
export const CONTENT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Read a response body with a hard byte ceiling, abandoning the stream as soon
 * as the cap is passed. Using res.json()/res.text() would buffer the whole
 * payload first, which is exactly the exhaustion vector we are closing: the cap
 * has to be enforced DURING the read, not after it.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  if (!res.body) {
    const text = await res.text();
    return Buffer.byteLength(text, 'utf8') > maxBytes ? null : text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

export async function fetchReceivedEmail(
  emailId: string,
  fetchImpl: InboundFetch = fetch,
): Promise<ContentFetchResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: 'resend_api_key_missing' };
  try {
    const res = await fetchImpl(`${RESEND_API}/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(CONTENT_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `resend retrieve HTTP ${res.status}` };

    const raw = await readCapped(res, MAX_CONTENT_BYTES);
    if (raw === null) return { ok: false, error: 'content_too_large' };
    try {
      return { ok: true, email: JSON.parse(raw) as ResendReceivedEmail };
    } catch {
      return { ok: false, error: 'content_invalid_json' };
    }
  } catch (e) {
    return { ok: false, error: `resend retrieve failed: ${(e as Error).message}` };
  }
}

/**
 * The recipient values used for correlation.
 *
 * ── SEC (H5): THE ENVELOPE PREMISE IS UNVERIFIED, AND WE STOPPED RESTING ON IT
 *
 * This function's docstring used to assert that `data.to` "is the recipient set
 * Resend's SMTP server actually accepted" and that both values are "attested by
 * the receiver". Neither claim is supported. Checked 2026-09-18 against
 * Resend's complete docs corpus:
 *
 *   - `data.to` is documented only as "Array of impacted recipient email
 *     addresses" — shared boilerplate reused verbatim across every `email.*`
 *     event, never described as envelope- or RCPT-TO-derived. The same payload
 *     also carries separate `to`/`cc`/`bcc` arrays, and an SMTP envelope has no
 *     concept of cc or bcc. That is structural evidence it is HEADER-parsed.
 *   - `received_for` is documented as "taken from the `for` clause of the
 *     message's `Received` headers" — explicitly header-derived. `Received`
 *     headers already present when a message arrives are attacker-controllable
 *     through any relay they choose to route it via.
 *
 * It cannot be settled empirically until DNS is live, and we are not guessing.
 * The resolution is NOT to tighten this list further — it is to stop letting
 * correlation carry the weight alone. With the authentication lock in place
 * (channels/inbound-authentication.ts), a FORGED `data.to` buys an attacker an
 * unauthenticated message queued for a human, not a negotiated deal. That is
 * the containment, and it holds whichever way the premise resolves.
 *
 * Revisit when the MX record goes live: send a message with a `To:` header that
 * differs from the SMTP RCPT TO and read which one lands in `data.to`.
 *
 * ── SEC: WHAT WAS REMOVED AND WHY ───────────────────────────────────────────
 *
 * This previously also fed `data.cc`, `email.cc`, `email.to` and the retrieved
 * `headers['to'|'cc'|'reply-to'|'x-original-to']` into correlation. All of those
 * are copied from the MESSAGE, which means the sender writes them. Since the
 * campaign_influencer_id rides in the Reply-To of every outreach email and
 * survives forwards and auto-replies, anyone holding one could self-attribute a
 * message by adding `Cc: x+lead-<uuid>@anything` — and drive the autonomous
 * negotiator into agreeing a deal. They are gone on purpose; do not add them
 * back for "better matching".
 */
export function envelopeRecipientValues(
  event: ResendInboundEvent,
  email: ResendReceivedEmail | null,
): string[] {
  const out: string[] = [];
  const push = (v: string | string[] | undefined) => {
    if (!v) return;
    for (const s of Array.isArray(v) ? v : [v]) if (s) out.push(s);
  };
  push(event.data?.to);
  push(event.data?.received_for);
  push(email?.received_for);
  return out;
}

/**
 * Resend payload (+ retrieved content) → the shared InboundEmailMessage shape.
 * Pure: no env, no network. normalizeInboundEmail() applies the intake gate.
 */
export function toInboundEmailMessage(
  event: ResendInboundEvent,
  email: ResendReceivedEmail | null,
): InboundEmailMessage {
  const d = event.data ?? {};
  // Prefer the richer `headers.from` from the retrieve call: Resend states the
  // webhook's `from` is "the bare email address only; the display name from the
  // original From: header is preserved in headers.from on the retrieve endpoint".
  const from = email?.headers?.from ?? email?.from ?? d.from ?? null;
  return {
    provider: 'resend',
    providerMessageId: d.email_id ?? '',
    from,
    envelopeRecipients: envelopeRecipientValues(event, email),
    subject: d.subject ?? email?.subject ?? null,
    text: email?.text ?? null,
    html: email?.html ?? null,
    receivedAt: d.created_at ?? event.created_at ?? null,
    authenticationResults: authenticationResultsValue(email),
  };
}

/**
 * The `Authentication-Results` value, IF one is exposed.
 *
 * ── SEC (H4): why this is almost always null, on purpose ────────────────────
 *
 * Resend documents no authentication verdict anywhere: not in the
 * `email.received` payload (ten documented `data` fields, none of them a
 * verdict, and no headers at all by design), and not in the retrieve response —
 * whose `headers` field is not documented at ALL, appearing only in an example
 * with three keys (`from`, `return-path`, `mime-version`). A grep of Resend's
 * full 363-page docs corpus on 2026-09-18 found zero occurrences of
 * `Authentication-Results`, `ARC-*`, `Received-SPF` or `DKIM-Signature`.
 *
 * The shape is the deeper problem and it survives any doc update: resend-node
 * types this `Record<string, string> | null`. A flat map cannot hold a REPEATED
 * header name, and `Authentication-Results` is repeated once per hop — with only
 * the receiver's own topmost instance being trustworthy. Collapsed into a map,
 * an attacker's forged copy is indistinguishable from the receiver's real one.
 *
 * So the value is surfaced but NOT trusted: evaluateSenderAuthentication only
 * believes a verdict whose authserv-id is on a configured trust list, and this
 * transport contributes no default. Absent INBOUND_TRUSTED_AUTHSERV_IDS, every
 * Resend reply is unauthenticated and therefore queued for a human. If Resend
 * later documents a receiver-stamped, de-duplicated verdict, naming its
 * authserv-id in that env var is the whole opt-in.
 */
export function authenticationResultsValue(
  email: ResendReceivedEmail | null,
): string | null {
  const headers = email?.headers;
  if (!headers) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authentication-results' && typeof value === 'string') {
      return value;
    }
  }
  return null;
}

// ── Multi-tenant routing ────────────────────────────────────────────────────
//
// resolveFirmByInbox MOVED to ./inbound-attribution.ts, because the Gmail
// transport needs it too now: it is what supplies the firm scope that
// isKnownCreatorContact requires (H2 — admission on identity used to be
// answered across every tenant at once). Re-exported here so existing importers
// and tests are untouched.
export { resolveFirmByInbox, type FirmMatch } from './inbound-attribution';
