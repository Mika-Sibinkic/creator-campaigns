// src/app/api/webhooks/inbound-email/route.ts
//
// SECURITY-OK: supabaseAdmin — an inbound-email webhook carries no user JWT.
// Writes only through ingestInboundReply(), and only AFTER Svix signature
// verification (HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${raw body}`,
// constant-time compare, ±5-min replay window). Middleware already whitelists
// /api/webhooks/* from both the auth gate and the CSRF check.
//
// WHAT THIS IS
//
// The production inbound transport for creator replies: Resend RECEIVING
// (https://resend.com/docs/dashboard/receiving/introduction), event
// `email.received` (https://resend.com/docs/webhooks/emails/received).
//
// It replaces Gmail polling as the path that has to work for a LICENSED
// product. Gmail polling requires every label to hand over a Google OAuth
// consent for their own mailbox; an MX record on a subdomain requires nothing
// from the label at all, and one Resend account serves every tenant.
//
// This route is deliberately SEPARATE from /api/webhooks/resend (delivery
// status: bounced/complained/delivered/opened/clicked). Different Resend
// webhook endpoints get different signing secrets, so they cannot share one
// handler or one env var anyway.
//
// ── THE TWO-HOP SHAPE ───────────────────────────────────────────────────────
//
// Resend's inbound webhook carries METADATA ONLY — no body, by design, so that
// large attachments do not blow the request-size limit of a serverless handler.
// The body comes from a second call to GET /emails/receiving/:email_id. See the
// header of src/lib/channels/resend-inbound.ts.
//
// ── FAILURE POSTURE ─────────────────────────────────────────────────────────
//
// ── WHO IS TRUSTED ──────────────────────────────────────────────────────────
//
// Signature verification proves the request came from Resend. It says nothing
// about who wrote the EMAIL. Attribution to a lead therefore needs three more
// things, all enforced below: a `+lead-<uuid>` on the recipient value, a From
// address matching that creator's known contact, and an AUTHENTICATED sender.
// See the trust-model note in src/lib/channels/email-inbound.ts.
//
// The third is the one that contains the damage when the first two rest on
// something the message carried. Resend performs no SPF/DKIM/DMARC check we can
// observe and publishes no verdict field, and neither `data.to` nor
// `received_for` is documented as envelope-derived (`received_for` is
// explicitly parsed out of `Received` headers). So a reply arriving here is
// UNAUTHENTICATED by default, and an unauthenticated reply is ingested, stored
// and visible — but never attributed, which means it cannot counter, accept or
// close. Policy is INBOUND_SENDER_AUTH_MODE / INBOUND_TRUSTED_AUTHSERV_IDS and
// defaults to the safe side.
//
// One narrow exception: a TESTING-MODE dry run. When the tagged lead's firm has
// testing_mode on and the From is exactly that firm's test inbox (where every
// outbound was rerouted), the reply is attributed and marked
// (sender_auth_outcome = 'testing_mode_attribution'). See
// testingModeSenderMatch in src/lib/channels/inbound-attribution.ts.
//
//   secret unset            → 401. Fail CLOSED. Never infer trust from a header.
//   bad/absent signature    → 401.
//   body over the cap       → 413.
//   body fetch failed       → 503, so Resend retries on its published schedule
//                             (immediately, 5s, 5min, 30min, 2h, 5h, 10h, 10h).
//   gate rejected the mail  → 200 + a reason. Spam to the inbound subdomain must
//                             not look like an outage, and must not be retried.
//   ingest threw            → 503 (retryable); the message is not lost.
//
// KNOWN CHARACTERISTIC: the 'public' rate-limit tier is 30 req/min keyed on
// client IP, and every Resend webhook arrives from one of ~5 fixed egress IPs —
// so they share a single bucket. A burst of more than 30 replies in a minute
// gets 429s. Nothing is lost (Resend retries: 5s, 5min, 30min, 2h, 5h, 10h,
// 10h), but sustained 429s can get an endpoint auto-disabled. The limit is kept
// because this URL is unauthenticated and the handler makes an outbound Resend
// API call per accepted message. Raise the tier if real reply volume ever
// approaches it.

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { ingestInboundReply } from '@/lib/ingest-inbound';
import {
  correlateFromEnvelope,
  normalizeInboundEmail,
  parseFromMailbox,
} from '@/lib/channels/email-inbound';
import {
  isKnownCreatorContact,
  senderMatchesLeadCreator,
  testingModeSenderMatch,
} from '@/lib/channels/inbound-attribution';
import {
  evaluateSenderAuthentication,
  resolveInboundAuthPolicy,
} from '@/lib/channels/inbound-authentication';
import {
  RESEND_INBOUND_EVENT,
  fetchReceivedEmail,
  resolveFirmByInbox,
  toInboundEmailMessage,
  type ResendInboundEvent,
} from '@/lib/channels/resend-inbound';
import { readSvixHeaders, verifySvixSignature } from '@/lib/svix-verify';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';

export const runtime = 'nodejs';

/**
 * Explicit execution ceiling. Without one the platform default applies, and a
 * handler that runs long on hostile input is a concurrency-exhaustion lever:
 * Resend retries on a 7-step schedule, so every retry would repeat the full
 * cost. The work here is one bounded HTTP call plus bounded text processing;
 * anything approaching this limit is pathological and should be cut off.
 */
export const maxDuration = 15;

/**
 * Matches the stripe webhook's cap. Resend's inbound webhook is metadata only,
 * so a legitimate payload is a couple of KB even with many attachments listed.
 * The BODY of the email is not here — it is fetched in hop two, which has its
 * own (larger) ceiling in resend-inbound.ts.
 */
const MAX_BODY_BYTES = 256_000;

/**
 * Case-insensitive read of Resend's flat header map.
 *
 * A flat `Record<string, string>` cannot represent a repeated header, which is
 * exactly why `Authentication-Results` is not trustworthy from this transport
 * (see authenticationResultsValue in resend-inbound.ts). `In-Reply-To` and
 * `References` are different: they are single-instance headers, they are
 * SENDER-written either way, and nothing here authorizes on them. They are
 * captured as evidence — the join to outreach_messages.provider_message_id that
 * turns "they agreed" into "they agreed to THIS message".
 */
function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want && typeof value === 'string') return value;
  }
  return null;
}

export async function POST(req: Request) {
  const limit = tieredLimit(req, 'public');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }

  // Fail closed: no secret means no way to verify, which means no trust.
  const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.error('[inbound-email] RESEND_INBOUND_WEBHOOK_SECRET is unset — refusing');
    return NextResponse.json({ error: 'webhook_not_configured' }, { status: 401 });
  }

  // Refuse an oversized envelope on the DECLARED length first, so an obvious
  // flood is rejected without buffering it. req.text() below still has to
  // buffer, so the post-read check stays as the backstop for a missing or
  // dishonest content-length — this pair is a cheap early-out plus a correct
  // guarantee, not a true streaming cap.
  const declaredLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }

  // RAW body before any parse — the signature covers the exact bytes. Resend:
  // "Some frameworks parse the request as JSON and then stringify it, and this
  // will also break the signature verification."
  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }

  const verdict = verifySvixSignature(rawBody, readSvixHeaders(req.headers), secret);
  if (!verdict.ok) {
    return NextResponse.json({ error: 'unauthorized', reason: verdict.reason }, { status: 401 });
  }

  let event: ResendInboundEvent;
  try {
    event = JSON.parse(rawBody) as ResendInboundEvent;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // One endpoint may be subscribed to several event types; only act on inbound.
  if (event.type !== RESEND_INBOUND_EVENT) {
    return NextResponse.json({ ok: true, ignored: 'event_type', type: event.type ?? null });
  }

  const emailId = event.data?.email_id?.trim();
  if (!emailId) {
    // Nothing to dedupe on and nothing to fetch. Not retryable.
    return NextResponse.json({ ok: true, ignored: 'missing_email_id' });
  }

  // Hop two: the body. Size-capped and timed out inside fetchReceivedEmail.
  const content = await fetchReceivedEmail(emailId);
  if (!content.ok) {
    // An oversized or unparseable body is a PERMANENT property of that message.
    // Retrying re-pays the download for the same refusal, so answer 200.
    if (content.error === 'content_too_large' || content.error === 'content_invalid_json') {
      console.error('[inbound-email] refusing body:', content.error, emailId);
      return NextResponse.json({ ok: true, ignored: content.error });
    }
    console.error('[inbound-email] body retrieve failed:', content.error);
    return NextResponse.json({ error: 'content_unavailable', reason: content.error }, { status: 503 });
  }

  const sb = supabaseAdmin();
  const msg = toInboundEmailMessage(event, content.email);

  // Which tenant's inbox this arrived at. Resolved FIRST now, because it is no
  // longer observability only: it is the scope the identity-admission check
  // runs inside (H2). Knowing an address still proves nothing on its own — a
  // firm match alone admits nothing.
  const firm = await resolveFirmByInbox(sb, msg.envelopeRecipients);

  // ── SEC: prove WHO sent this before letting it touch a lead ───────────────
  //
  // The envelope may correlate to a lead, but the campaign_influencer_id rides
  // in the Reply-To of every outreach email and leaks through forwards and
  // auto-replies. Attribution therefore also requires the sender to be that
  // creator. A correlated message from the wrong sender is still queued — just
  // unattributed, for a human — because a creator mailing from a second address
  // looks identical to an attacker from here.
  const correlated = correlateFromEnvelope(msg.envelopeRecipients);
  const senderVerified = correlated
    ? await senderMatchesLeadCreator(sb, correlated, msg.from)
    : false;
  // Admission path for a creator replying on a fresh thread with no tag —
  // scoped to the firm this message was delivered to, and failing closed when
  // no firm could be resolved.
  const senderIsKnownCreator =
    !correlated || !senderVerified
      ? await isKnownCreatorContact(sb, msg.from, { firmId: firm?.firmId ?? null })
      : true;
  // Testing-mode dry run: outbound was rerouted to the firm's test inbox, so the
  // operator replies FROM it, playing the creator. Only asked when the tag is
  // valid and the creator check failed; null unless the lead's firm is in
  // testing mode and the From is exactly that firm's test inbox.
  const testingMatch =
    correlated && !senderVerified
      ? await testingModeSenderMatch(sb, correlated, msg.from, {
          inboxFirmId: firm?.firmId ?? null,
        })
      : null;

  // ── SEC (H4): the third lock — did the sending domain PROVE the identity? ──
  //
  // Everything above is read off the message. Resend performs no SPF/DKIM/DMARC
  // check we can see and exposes no verdict (checked against its full docs
  // corpus), and its `headers` map cannot even represent the
  // repeated header the answer would live in. So this transport contributes NO
  // default trusted authserv-id: absent an explicit INBOUND_TRUSTED_AUTHSERV_IDS
  // opt-in, every reply here is unauthenticated and gets queued for a human
  // instead of driving the negotiator. That is the intended posture, not a gap.
  const authPolicy = resolveInboundAuthPolicy();
  const auth = evaluateSenderAuthentication({
    headerValue: msg.authenticationResults,
    fromMailbox: parseFromMailbox(msg.from),
    policy: authPolicy,
  });

  const decision = normalizeInboundEmail(
    {
      ...msg,
      // Evidence-only additions; neither is an input to any gate. toInbound-
      // EmailMessage does not set them (resend-inbound.ts is not this route's
      // file), so they are read from the retrieve response here.
      bodyMediaType: content.email?.text?.trim() ? 'text/plain' : 'text/html',
      inReplyTo: headerValue(content.email?.headers, 'in-reply-to'),
      references: headerValue(content.email?.headers, 'references'),
    },
    {
      senderVerified,
      senderIsKnownCreator,
      senderAuthenticated: auth.authenticated,
      // The verdict is PERSISTED now, not just warned about. On this transport it
      // is virtually always a refusal (`no_trusted_authserv_configured`, because
      // Resend contributes no trusted authserv-id — see above), and that is the
      // point: "no receiver vouched for this sender" and "this reply carried no
      // correlation tag" used to be the same NULL campaign_influencer_id.
      senderAuthVerdict: auth,
      requireSenderAuthentication: authPolicy.requireAuthentication,
      testingModeAttribution: testingMatch !== null,
    },
  );
  if (!decision.accepted) {
    // 200: a rejected message is a decision, not a failure. Retrying changes
    // nothing, and Resend disables endpoints that keep returning errors.
    return NextResponse.json({ ok: true, ignored: decision.reason });
  }
  if (decision.senderMismatch) {
    // Loud on purpose: either a creator has a new address, or someone is
    // replaying a leaked campaign_influencer_id at the endpoint.
    console.warn(
      '[inbound-email] sender does not match the correlated creator — queued unattributed',
      { email_id: emailId, campaign_influencer_id: correlated },
    );
  }
  if (decision.testingModeAttribution) {
    console.info('[inbound-email] testing-mode reply from the firm test inbox — attributed', {
      email_id: emailId,
      campaign_influencer_id: correlated,
      firm_id: testingMatch?.firmId ?? null,
    });
  }
  if (decision.authenticationHeld) {
    // The address is right and the thread is right; the sender is unproven.
    // Ingested and visible, but it will not counter, accept or close.
    console.warn(
      '[inbound-email] sender not authenticated — queued for human confirmation',
      {
        email_id: emailId,
        campaign_influencer_id: correlated,
        outcome: auth.outcome,
        authserv_id: auth.authservId,
      },
    );
  }

  try {
    const result = await ingestInboundReply(decision.normalized, sb);

    // ── Audit: a SECOND trace, never the record itself ─────────────────────
    //
    // The durable evidence is on the inbound_messages row (migration 052).
    // audit_log is a corroborating trace with three properties that disqualify
    // it as the primary: metadata is PII-scrubbed on write, audit() swallows its
    // own insert failures so absence proves nothing, and the documented manual
    // prune deletes `system:%` rows past 90 days. Hence the explicit
    // actor_label, which is neither `system:%` nor `user:%`.
    //
    // Metadata is numbers, booleans and short enums ONLY: scrubPII rewrites
    // strings, and a mangled hash or id in a log that someone later compares
    // against the row is worse than no log line. The inbound row id rides in
    // target_id, which is a column and is not scrubbed.
    //
    // Written only for a NEW, accepted message: this endpoint is
    // unauthenticated and Resend retries seven times, so auditing refusals or
    // dedupes would let a stranger drive unbounded growth of an append-only
    // table that has no automatic prune.
    if (!result.deduped) {
      await audit(
        {
          action: 'inbound.email.received',
          target_type: 'inbound_message',
          target_id: result.inbound_message_id ?? undefined,
          actor_label: 'webhook:resend-inbound',
          firm_id: firm?.firmId ?? testingMatch?.firmId ?? null,
          metadata: {
            channel: 'email',
            attributed: result.campaign_influencer_advanced,
            sender_mismatch: decision.senderMismatch,
            sender_authenticated: auth.authenticated,
            authentication_outcome: auth.outcome,
            authserv_id: auth.authservId,
            held_for_human: decision.authenticationHeld,
            testing_mode_attribution: decision.testingModeAttribution,
            verbatim_body_stored: decision.normalized.raw_body != null,
            verbatim_body_chars: decision.normalized.raw_body_chars ?? null,
            verbatim_body_truncated: decision.normalized.raw_body_truncated ?? null,
            in_reply_to_captured: decision.normalized.in_reply_to != null,
          },
        },
        req,
      );
    }

    return NextResponse.json({
      ok: true,
      deduped: result.deduped,
      inbound_message_id: result.inbound_message_id,
      classification: result.classification,
      matched: result.campaign_influencer_advanced,
      sender_mismatch: decision.senderMismatch,
      sender_authenticated: auth.authenticated,
      authentication_outcome: auth.outcome,
      held_for_human: decision.authenticationHeld,
      testing_mode_attribution: decision.testingModeAttribution,
      firm_id: firm?.firmId ?? null,
    });
  } catch (e) {
    // Retryable: the reply is real and we failed to store it. A 200 here would
    // silently drop a creator's response — the exact failure this whole route
    // exists to end.
    console.error('[inbound-email] ingest failed:', e);
    return NextResponse.json({ error: 'ingest_failed' }, { status: 503 });
  }
}

// ── OPEN: tenant is resolved but not PERSISTED ──────────────────────────────
//
// resolveFirmByInbox tells us which firm's negotiation inbox a reply arrived
// at, but `inbound_messages` (018_negotiation_foundation.sql) has no firm
// column, so a correctly-addressed reply to Firm A's inbox is still stored
// tenant-less. Unattributed rows are then read with NO firm filter by
// /api/anomalies (deliberate and documented there), which means one firm can
// see another's unattributed inbound.
//
// That is tenant ADMISSION, not tenant ROUTING, and the difference matters
// as soon as more than one firm shares a deployment. Closing it needs
// `inbound_messages.firm_id` plus an RLS policy, which is a migration of its
// own; it is documented here rather than taken in this route.
