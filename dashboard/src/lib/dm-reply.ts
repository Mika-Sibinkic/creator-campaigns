// src/lib/dm-reply.ts
//
// An operator-logged DM reply → the negotiator.
//
// DMs are sent by hand from the label's own Instagram/TikTok account (the DM
// queue, src/app/outreach/dm-queue-tab.tsx), so their replies arrive there too
// and nothing in the product can read them. The operator pastes the reply in;
// this module turns it into the same NormalizedInbound every other reply source
// produces and hands it to ingestInboundReply — the one seam that writes
// inbound_messages, which is the only table negotiation-tick reads.
//
// Before this existed the only operator path was /api/outreach/respond, which
// writes an inbound outreach_messages row and stops. The lead advanced, the
// reply was classified, and the negotiator never saw it.
//
// Channel is the whole point. inbound_messages.channel is what
// negotiation-tick's sendModeFor() keys on, so a reply logged as 'instagram_dm'
// gets its counter / acceptance note queued send_mode='human_queue' on
// 'instagram_dm' — back into the DM queue, never to the auto-sender (dispatchDue
// allow-lists channel='email'). Logging a DM reply as email would have the
// negotiator EMAIL a creator who wrote on Instagram, which is why this path
// refuses every non-DM channel.
//
// Provenance: external_id is `dm-manual:<submission uuid>`. Distinct from the
// simulator's `sim:` and the email providers' `resend:` / `gmail:`, and it makes
// ingest's (channel, external_id) dedupe absorb a retried submission.
//
// Pure + injected: no env, no Supabase client import (types only), no React.
// The route supplies the lead lookup and the ingest call; the UI imports the
// helpers below directly.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { IngestResult, NormalizedInbound } from './ingest-inbound';
import { checkFirmScope } from './firm-scope';

export const DM_REPLY_CHANNELS = ['instagram_dm', 'tiktok_dm'] as const;
export type DmReplyChannel = (typeof DM_REPLY_CHANNELS)[number];

export function isDmReplyChannel(value: unknown): value is DmReplyChannel {
  return (DM_REPLY_CHANNELS as readonly unknown[]).includes(value);
}

export const DM_REPLY_CHANNEL_LABELS: Record<DmReplyChannel, string> = {
  instagram_dm: 'Instagram DM',
  tiktok_dm: 'TikTok DM',
};

export const MANUAL_DM_EXTERNAL_ID_PREFIX = 'dm-manual:';

export function manualDmExternalId(submissionId: string): string {
  return `${MANUAL_DM_EXTERNAL_ID_PREFIX}${submissionId}`;
}

/**
 * The NormalizedInbound for one pasted DM reply.
 *
 * `from_identity` is the creator's handle — the thread view prints it as the
 * speaker — falling back to the marker when no handle is known. No provider
 * evidence fields are set: a hand-typed transcription is not a verbatim
 * provider body and must not be stored as one.
 */
export function buildManualDmInbound(input: {
  campaignInfluencerId: string;
  channel: DmReplyChannel;
  text: string;
  submissionId: string;
  creatorHandle: string | null;
}): NormalizedInbound {
  if (!isDmReplyChannel(input.channel)) {
    throw new Error(`manual DM reply on a non-DM channel: ${String(input.channel)}`);
  }
  const handle = (input.creatorHandle ?? '').trim().replace(/^@+/, '');
  return {
    channel: input.channel,
    external_id: manualDmExternalId(input.submissionId),
    from_identity: handle ? `@${handle}` : 'dm-manual',
    body: input.text.trim(),
    campaign_influencer_id: input.campaignInfluencerId,
  };
}

interface ThreadMessage {
  direction: string;
  channel: string | null;
  sent_at: string | null;
  created_at: string;
}

function latestSentDm(messages: readonly ThreadMessage[]): ThreadMessage | null {
  let best: ThreadMessage | null = null;
  for (const m of messages) {
    if (m.direction !== 'outbound' || !m.sent_at || !isDmReplyChannel(m.channel)) continue;
    if (!best || Date.parse(m.sent_at) > Date.parse(best.sent_at as string)) best = m;
  }
  return best;
}

export interface DmReplyLead {
  id: string;
  username: string;
  artist_name: string | null;
  channel: DmReplyChannel;
  last_dm_at: string;
}

/**
 * Leads a DM reply can come from: at least one DM actually went out to them.
 * Most recently messaged first — that is who is most likely to be answering.
 * Each carries the channel we last DM'd them on, which is where a reply to it
 * will be. Also answers "is this a DM lead at all" for the lead view.
 */
export function dmReplyLeads(
  entries: ReadonlyArray<{
    id: string;
    influencer: { username: string; platform: string } | null;
    campaign: { artist_name: string } | null;
    messages: readonly ThreadMessage[];
  }>,
): DmReplyLead[] {
  const leads: DmReplyLead[] = [];
  for (const e of entries) {
    if (!e.influencer) continue;
    const sent = latestSentDm(e.messages);
    if (!sent) continue;
    leads.push({
      id: e.id,
      username: e.influencer.username,
      artist_name: e.campaign?.artist_name ?? null,
      channel: sent.channel as DmReplyChannel,
      last_dm_at: sent.sent_at as string,
    });
  }
  return leads.sort((a, b) => Date.parse(b.last_dm_at) - Date.parse(a.last_dm_at));
}

// ── The route's decision shell ──────────────────────────────────────────────

/** What the route resolves about the lead through the caller's RLS client. */
export interface ManualDmLead {
  firm_id: string | null;
  username: string | null;
  /** A creator_offers row exists — negotiation-tick skips replies without one. */
  has_offer: boolean;
  /** A DM went out to this lead (readSentDmToLead). null = could not tell. */
  sent_dm: boolean | null;
}

/**
 * An outbound row that is a DM that actually went out: a human_queue row
 * (including drafts rerouted from the email path, which keep channel 'email'),
 * or a DM channel, legacy 'dm' included.
 */
export function isSentDmOutbound(m: {
  direction: string | null;
  channel: string | null;
  send_mode: string | null;
  sent_at: string | null;
  status: string | null;
}): boolean {
  if (m.direction !== 'outbound') return false;
  if (!m.sent_at && m.status !== 'sent') return false;
  return m.send_mode === 'human_queue' || isDmReplyChannel(m.channel) || m.channel === 'dm';
}

/**
 * Was a DM sent to this lead? A campaign_influencers row is one creator in
 * one campaign, so this is "in that campaign". null = the read failed.
 */
export async function readSentDmToLead(sb: SupabaseClient, campaignInfluencerId: string): Promise<boolean | null> {
  const { data, error } = await sb
    .from('outreach_messages')
    .select('direction, channel, send_mode, sent_at, status')
    .eq('campaign_influencer_id', campaignInfluencerId)
    .eq('direction', 'outbound');
  if (error) return null;
  return ((data ?? []) as Array<Parameters<typeof isSentDmOutbound>[0]>).some(isSentDmOutbound);
}

export type ManualDmReplyOutcome =
  | { ok: true; ingest: IngestResult; negotiator_will_answer: boolean }
  | { ok: false; status: 400 | 401 | 403 | 404 | 409 | 503; error: string; message: string };

/**
 * Validate, scope and ingest one operator-logged DM reply. Every refusal
 * happens before `ingest` is called, so a refused request writes nothing.
 */
export async function logManualDmReply(opts: {
  input: { campaign_influencer_id: string; channel: string; text: string; submission_id: string };
  callerFirmId: string | null | undefined;
  loadLead: (campaignInfluencerId: string) => Promise<ManualDmLead | null>;
  ingest: (normalized: NormalizedInbound) => Promise<IngestResult>;
}): Promise<ManualDmReplyOutcome> {
  const { input } = opts;
  if (!isDmReplyChannel(input.channel)) {
    return {
      ok: false,
      status: 400,
      error: 'not_dm_channel',
      message: 'Only Instagram and TikTok DM replies can be logged here.',
    };
  }
  if (!input.text.trim()) {
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

  // A reply needs a DM to reply to. Ingesting one for a creator never DM'd
  // marks them contacted, and their opener then skips the campaign's outreach
  // limit and budget pacing (src/lib/first-touch-gate.ts).
  if (lead.sent_dm === null) {
    return {
      ok: false,
      status: 503,
      error: 'dm_history_unreadable',
      message: "Couldn't check which DMs this creator was sent, so nothing was logged. Try again in a minute.",
    };
  }
  if (!lead.sent_dm) {
    return {
      ok: false,
      status: 409,
      error: 'no_dm_sent',
      message: 'No DM to this creator is recorded as sent in this campaign. Mark the DM sent first.',
    };
  }

  const ingest = await opts.ingest(
    buildManualDmInbound({
      campaignInfluencerId: input.campaign_influencer_id,
      channel: input.channel,
      text: input.text,
      submissionId: input.submission_id,
      creatorHandle: lead.username,
    }),
  );
  return { ok: true, ingest, negotiator_will_answer: lead.has_offer };
}
