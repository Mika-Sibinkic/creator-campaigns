// src/lib/manual-email-reply.ts
//
// An operator-logged EMAIL reply (/outreach → "Log response") → the same ingest
// path as real inbound email.
//
// Before this, /api/outreach/respond classified the pasted text, wrote an
// inbound outreach_messages row and stopped. A pasted STOP was classified
// not_interested and nothing else: no per-label block (firm-blocks.ts), the
// creator's queued messages still dispatched, and the negotiator never saw the
// reply. The route also had no firm check.
//
// Now the reply is normalized and handed to ingestInboundReply — the one seam
// that writes inbound_messages, honours an opt-out, and feeds negotiation-tick
// — exactly as the Gmail/Resend pollers and the DM path (dm-reply.ts) do.
//
// Provenance: external_id is `manual:<submission uuid>`. Distinct from the
// simulator's `sim:`, the DM path's `dm-manual:` and the providers' `resend:` /
// `gmail:`, and it makes ingest's (channel, external_id) dedupe absorb a
// retried submission. The prefix also turns on ingest's CONTENT dedupe: a
// paste of a reply already on the thread (usually the same email, delivered by
// the provider) is refused with 409 instead of opening a second negotiation
// turn.
//
// Pure + injected, like dm-reply.ts: the route supplies the lead lookup (on the
// caller's RLS client) and the ingest call.

import {
  MANUAL_EMAIL_EXTERNAL_ID_PREFIX,
  type IngestResult,
  type NormalizedInbound,
} from './ingest-inbound';
import { checkFirmScope } from './firm-scope';
import { isDmReplyChannel } from './dm-reply';

// Defined in ingest-inbound, which uses it to content-dedupe pastes.
export { MANUAL_EMAIL_EXTERNAL_ID_PREFIX };

export interface ManualEmailLead {
  firm_id: string | null;
}

export type ManualEmailReplyOutcome =
  | { ok: true; ingest: IngestResult }
  | { ok: false; status: 400 | 401 | 403 | 404 | 409; error: string; message: string };

/**
 * What the operator is told when a paste repeats a reply already on the
 * thread. It says the reply is in, that nothing new happened, and where to
 * look — a 409 that read like a failure would invite pasting it again.
 */
export function alreadyReceivedMessage(receivedAt: string | null | undefined): string {
  const t = receivedAt ? Date.parse(receivedAt) : Number.NaN;
  const when = Number.isFinite(t)
    ? ` on ${new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`
    : '';
  return `That reply already came in${when}, so nothing new was logged. It is in the thread below.`;
}

/** The NormalizedInbound for one pasted email reply. */
export function buildManualEmailInbound(input: {
  campaignInfluencerId: string;
  text: string;
  submissionId: string;
}): NormalizedInbound {
  return {
    channel: 'email',
    external_id: `${MANUAL_EMAIL_EXTERNAL_ID_PREFIX}${input.submissionId}`,
    from_identity: 'manual',
    body: input.text.trim(),
    campaign_influencer_id: input.campaignInfluencerId,
  };
}

/**
 * Validate, scope and ingest one operator-logged email reply. Every refusal
 * happens before `ingest` is called, so a refused request writes nothing.
 */
export async function logManualEmailReply(opts: {
  input: {
    campaign_influencer_id: string;
    response_text: string;
    submission_id: string;
    channel?: string;
  };
  callerFirmId: string | null | undefined;
  loadLead: (campaignInfluencerId: string) => Promise<ManualEmailLead | null>;
  ingest: (normalized: NormalizedInbound) => Promise<IngestResult>;
}): Promise<ManualEmailReplyOutcome> {
  const { input } = opts;
  const channel = input.channel ?? 'email';
  if (channel !== 'email') {
    return {
      ok: false,
      status: 400,
      error: isDmReplyChannel(channel) ? 'use_dm_reply' : 'unsupported_channel',
      message: isDmReplyChannel(channel)
        ? 'Log DM replies from the DM reply form, so the answer goes back as a DM.'
        : 'Only email replies can be logged here.',
    };
  }
  if (!input.response_text.trim()) {
    return { ok: false, status: 400, error: 'empty_reply', message: 'Paste the reply first.' };
  }

  const lead = await opts.loadLead(input.campaign_influencer_id);
  if (!lead) {
    return { ok: false, status: 404, error: 'not_found', message: 'That creator was not found.' };
  }
  const scope = checkFirmScope(opts.callerFirmId, lead.firm_id);
  if (!scope.ok) {
    return {
      ok: false,
      status: scope.httpStatus,
      error: scope.error,
      message: 'That creator belongs to another label.',
    };
  }

  const ingest = await opts.ingest(
    buildManualEmailInbound({
      campaignInfluencerId: input.campaign_influencer_id,
      text: input.response_text,
      submissionId: input.submission_id,
    }),
  );
  // Same words already on this thread (the email provider delivered it, or it
  // was pasted before under another submission): no second negotiation turn.
  if (ingest.duplicate_of) {
    return {
      ok: false,
      status: 409,
      error: 'already_received',
      message: alreadyReceivedMessage(ingest.duplicate_of.received_at),
    };
  }
  return { ok: true, ingest };
}
