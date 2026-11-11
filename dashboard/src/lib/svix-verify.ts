// src/lib/svix-verify.ts
//
// Svix webhook signature verification, from scratch on node:crypto.
//
// Resend signs every webhook with Svix. Scheme, per Resend's own doc
// (https://resend.com/docs/webhooks/verify-webhooks-requests) which defers the
// manual algorithm to https://docs.svix.com/receiving/verifying-payloads/how-manual:
//
//   signed content = `${svix-id}.${svix-timestamp}.${raw body}`
//   key            = base64-DECODED bytes of the secret after the `whsec_` prefix
//   signature      = base64( HMAC-SHA256( key, signed content ) )
//   header         = space-delimited `v<n>,<base64>` entries; ANY v1 entry may match
//   timestamp      = unix SECONDS; reference impl tolerance is ±300s, both directions
//
// Used by both Resend webhooks (delivery status and inbound email). As a pure
// function it is unit-tested against Svix's own published test vector
// (tests/inbound-email.test.ts) without standing up a Next.js request.
//
// No `svix` npm dependency: the algorithm is ~30 lines and the package would
// add a runtime dependency to a serverless cold path for no benefit.

import crypto from 'node:crypto';

/** Reference-implementation tolerance (standard-webhooks): 5 minutes each way. */
export const SVIX_TOLERANCE_SEC = 5 * 60;

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export type SvixVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Read the Svix headers off a request.
 *
 * Accepts the `webhook-*` spelling as well as `svix-*`: Svix white-labels the
 * prefix for Professional/Enterprise senders and its own libraries accept both.
 * Resend's docs only ever show `svix-*`, so the fallback is insurance.
 */
export function readSvixHeaders(headers: Headers): SvixHeaders {
  const pick = (a: string, b: string) => headers.get(a) ?? headers.get(b);
  return {
    id: pick('svix-id', 'webhook-id'),
    timestamp: pick('svix-timestamp', 'webhook-timestamp'),
    signature: pick('svix-signature', 'webhook-signature'),
  };
}

/** `whsec_<base64>` → raw key bytes. Returns null on an unusable secret. */
function decodeSecret(secret: string): Buffer | null {
  const stripped = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  if (!stripped) return null;
  try {
    const buf = Buffer.from(stripped, 'base64');
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/** Constant-time compare of two base64 signature strings. */
function signatureMatches(candidate: string, expected: Buffer): boolean {
  let candidateBuf: Buffer;
  try {
    candidateBuf = Buffer.from(candidate, 'base64');
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch; a wrong length is already a
  // non-match and leaks nothing about the key.
  if (candidateBuf.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidateBuf, expected);
}

/**
 * Verify a Svix-signed payload. `rawBody` MUST be the exact bytes received —
 * Resend's docs call this out explicitly, because a JSON round-trip reorders or
 * reformats and breaks the signature.
 *
 * `nowSec` is injectable so tests can pin the replay window.
 */
export function verifySvixSignature(
  rawBody: string,
  headers: SvixHeaders,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): SvixVerdict {
  if (!headers.id) return { ok: false, reason: 'missing svix-id' };
  if (!headers.timestamp) return { ok: false, reason: 'missing svix-timestamp' };
  if (!headers.signature) return { ok: false, reason: 'missing svix-signature' };

  const tsSec = Number.parseInt(headers.timestamp, 10);
  if (!Number.isFinite(tsSec)) return { ok: false, reason: 'invalid svix-timestamp' };
  if (nowSec - tsSec > SVIX_TOLERANCE_SEC) return { ok: false, reason: 'timestamp too old' };
  if (tsSec - nowSec > SVIX_TOLERANCE_SEC) return { ok: false, reason: 'timestamp too new' };

  const key = decodeSecret(secret);
  if (!key) return { ok: false, reason: 'invalid webhook secret' };

  const expected = crypto
    .createHmac('sha256', key)
    .update(`${headers.id}.${headers.timestamp}.${rawBody}`, 'utf8')
    .digest();

  for (const entry of headers.signature.split(' ')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(',');
    if (idx === -1) continue;
    // Only v1 is defined today; a future version must not be accepted blindly.
    if (trimmed.slice(0, idx) !== 'v1') continue;
    const value = trimmed.slice(idx + 1);
    if (value && signatureMatches(value, expected)) return { ok: true };
  }
  return { ok: false, reason: 'no matching v1 signature' };
}
