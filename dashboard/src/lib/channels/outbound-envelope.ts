// src/lib/channels/outbound-envelope.ts
//
// The outbound envelope decision — what subject and Reply-To a send actually
// puts on the wire — pulled out of sendOutreach() so it is decidable without a
// DB, a Resend client, or env. Kept dependency-free (same contract as
// reply-correlation.ts) so hermetic tests can assert the live-mode envelope.
//
// WHY THIS EXISTS AS ITS OWN MODULE
//
// The `[Creator Campaigns]` subject tag is a TESTING-mode convenience: it lets a
// tester eyeball which threads in their own inbox came from the tool, and it
// used to be the Gmail poller's only intake filter. Real creators must never
// see it, so live-mode sends ship the subject untouched — which means in live
// mode the tag cannot be, and never was, a correlation signal.
//
// The correlation signal that works in BOTH modes is the plus-addressed
// Reply-To (`<local>+lead-<campaign_influencer_id>@<domain>`). It is the ONLY
// durable anchor on a live send, so a send that fails to stamp one is a lead
// whose reply can never be routed back. `correlated` reports that explicitly
// rather than leaving the caller to infer it from a `replyTo` string.

import { applySubjectTag } from './subject-tag';
import { buildCorrelatedReplyTo } from './reply-correlation';

export interface OutboundEnvelopeInput {
  /** firms.testing_mode — controls the subject tag ONLY, never correlation. */
  testingMode: boolean;
  subject: string;
  /** An explicit caller Reply-To. Wins, at the cost of correlation. */
  explicitReplyTo?: string;
  /** The lead this send belongs to. Absent → nothing to correlate to. */
  campaignInfluencerId?: string;
  /** firms/firm_members negotiation_inbox_email — the inbox the poller reads. */
  negotiationInboxEmail?: string | null;
  /** Resolved sender address; the fallback correlation base (a firm may send
   *  from the same Workspace inbox the poller reads). */
  fromEmail?: string | null;
}

export interface OutboundEnvelope {
  /** Subject as it goes on the wire. */
  subject: string;
  /** Reply-To as it goes on the wire; undefined when none could be derived. */
  replyTo: string | undefined;
  /** True only when replyTo carries the `+lead-<ci_id>` correlation tag. */
  correlated: boolean;
}

export function buildOutboundEnvelope(input: OutboundEnvelopeInput): OutboundEnvelope {
  // applySubjectTag, not ensureSubjectTagPrefix: live mode must
  // STRIP the tag, not merely decline to add it.
  //
  // Declining to add it was never enough, because this is not the only place a
  // subject is decided. The counter and acceptance schedulers tag at INSERT
  // time (negotiation-tick.ts scheduleCounter / scheduleAcceptanceNote), so
  // the subject handed to us in live mode already carried `[Creator Campaigns]`, and
  // threadSubject() re-reads that stored string for every later round.
  // Stripping here covers the send path with no migration and no backfill,
  // whatever tagged subjects are already stored in outreach_messages.
  const subject = applySubjectTag(input.subject, input.testingMode);

  // An explicit Reply-To is an instruction, not a suggestion — honor it, but
  // report the lost correlation so callers/audit can see the thread went out
  // unanchored.
  if (input.explicitReplyTo) {
    return { subject, replyTo: input.explicitReplyTo, correlated: false };
  }

  if (!input.campaignInfluencerId) {
    return { subject, replyTo: undefined, correlated: false };
  }

  const correlated =
    buildCorrelatedReplyTo(input.negotiationInboxEmail, input.campaignInfluencerId) ??
    buildCorrelatedReplyTo(input.fromEmail, input.campaignInfluencerId);

  return {
    subject,
    replyTo: correlated ?? undefined,
    correlated: correlated !== null,
  };
}

// ── Opt-out (CAN-SPAM §7704(a)(3)–(4)) ──────────────────────────────────────
//
// Every creator-facing message this system sends is unsolicited commercial
// email, from the label's own sending domain, to someone who never asked. That
// is squarely §7704: it requires a clear opt-out mechanism, a working one, and
// honouring it within 10 business days. Before this module there was no link,
// no header and no opt-out sentence in any message — the only exit was typing
// "stop" into classifyResponse(), which labels the reply `not_interested` for
// that ONE campaign and never sets influencers.blocklisted, so the next
// campaign mails them again.
//
// §7704(a)(3)(A)(i) is satisfied by "a functioning return electronic mail
// address", so a reply-based opt-out is compliant without a hosted landing
// page — PROVIDED the reply is actually honoured. The copy below therefore
// promises exactly what a per-label block delivers ("off OUR list": the sender
// is the label) and not one word more. ingest-inbound.ts detects the reply
// (isOptOutReply) and firm-blocks.ts honourOptOut() records it for that label
// (migration 056), which pool-gates contactBlock enforces at every send path.

/** The word the email copy asks for, matching the List-Unsubscribe mailto. */
export const OPT_OUT_KEYWORD = 'unsubscribe';

export interface OptOutCopyInput {
  channel: 'email' | 'dm';
  /**
   * Where a reply actually lands — the correlated Reply-To or the sender
   * address. Named in the copy so the instruction is verifiable rather than a
   * vague "reply to this".
   */
  replyAddress?: string | null;
  /**
   * A hosted one-click endpoint, once one exists. Absent today: no route, no
   * token, no table. When it lands, it upgrades the header to RFC 8058
   * one-click and shortens the body line.
   */
  unsubscribeUrl?: string | null;
}

/**
 * The opt-out sentence for the bottom of a creator-facing message.
 *
 * No em dash, no hype, and nothing the draft validator bans, because this line
 * is concatenated onto copy that has to clear checkDraftCopy(). Deliberately
 * not phrased as an apology: an opt-out that reads as grovelling invites a
 * reply instead of a click.
 */
export function optOutLine(input: OptOutCopyInput): string {
  if (input.channel === 'dm') {
    return "Not your thing? Reply STOP and you won't hear from us again.";
  }
  if (input.unsubscribeUrl) {
    return `Don't want these? Unsubscribe here: ${input.unsubscribeUrl}`;
  }
  return `Don't want these? Reply with the word ${OPT_OUT_KEYWORD.toUpperCase()} and we'll take you off our list for good.`;
}

/**
 * Append the opt-out line to a body, once.
 *
 * Idempotent on the exact line, so a caller that composes a body from parts
 * and then passes it through here again cannot double it up.
 */
export function appendOptOut(body: string, input: OptOutCopyInput): string {
  const line = optOutLine(input);
  const trimmed = body.replace(/\s+$/, '');
  if (trimmed.includes(line)) return trimmed;
  return `${trimmed}\n\n${line}`;
}

/**
 * The headers a compliant commercial send needs, ready to spread into the
 * Resend `emails.send({ ..., headers })` options object.
 *
 * `List-Unsubscribe-Post` is emitted ONLY alongside an https URL: RFC 8058
 * one-click is an HTTP POST, and advertising one-click over a bare mailto
 * makes Gmail and Yahoo attempt a POST that cannot work. A mailto-only
 * List-Unsubscribe is still a valid RFC 2369 header and still counts as the
 * §7704 mechanism — it just renders as a prompt rather than a one-tap button.
 *
 * Returns `{}` when neither a reply address nor a URL is available, so a
 * caller can spread it unconditionally without asserting a header it cannot
 * honour.
 */
export function listUnsubscribeHeaders(input: OptOutCopyInput): Record<string, string> {
  const mailto =
    input.replyAddress && input.replyAddress.includes('@')
      ? `<mailto:${input.replyAddress}?subject=${OPT_OUT_KEYWORD}>`
      : null;
  const url = input.unsubscribeUrl ? `<${input.unsubscribeUrl}>` : null;
  const value = [url, mailto].filter(Boolean).join(', ');
  if (!value) return {};
  const headers: Record<string, string> = { 'List-Unsubscribe': value };
  if (url) headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  return headers;
}
