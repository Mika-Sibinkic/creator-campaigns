// src/lib/channel-priors.ts
//
// Channel routing beyond email + priors that learn.
//
// channel_conversion_priors (migration 018, seeded by 020) is the firm×channel
// funnel-counter table the best_channel selector reads (contact-discovery
// loadPriors + the campaign run route). Until this file existed nothing ever
// INCREMENTED those counters — every recommendation was frozen at the
// 2026-07-15 industry seed. This lib is the single write path:
//
//   sent  → an outreach message actually left (auto email send, or a human
//           marking a DM sent from the queue)
//   reply → a matched inbound reply landed for a creator who had not replied
//           before (first reply only — the funnel counts creators who replied,
//           not messages; 5 messages in one negotiation are 1 conversion)
//   deal  → the negotiation engine flipped an offer to agreed
//           (accepted_pending_approval in the tick)
//
// THE DENOMINATOR IS CREATORS, NOT MESSAGES. All three counters are keyed to
// the creator, so replies/sent and deals/sent read as conversion RATES:
//
//   sent  counts FIRST TOUCHES only — the one message that opens a thread with
//         a creator. The two writers are the auto-email send route and
//         markHumanQueueSent (the DM leg); between them they cover every
//         channel a first touch can leave on, because automated social dispatch
//         does not exist yet (resolveSendPlan routes every DM to the human
//         queue) and the human-queue route resolves a legacy 'dm' channel to
//         the creator's real platform before calling in.
//   reply counts creators who answered at all — first reply only.
//   deal  counts offers that closed, at most one per creator-offer.
//
// FOLLOW-UP SENDS MUST NOT BUMP `sent`. negotiation-tick's dispatchDue sends
// counters, acceptance notes and payout-onboarding mail, and promo-materials
// sends the post-payment fulfilment mail — all of them land INSIDE a thread a
// first touch already opened. Counting them would inflate the denominator
// without ever moving the numerator (`replies` is first-reply-only), so a
// channel would look worse the better it negotiates. A five-round negotiation
// is one contacted creator, not six. Adding a new SENDER is therefore only a
// priors change if that sender can open a thread.
//
// Also hosts the small routing helpers channel routing needs (which
// primary_channel values mean "human DM queue") and markHumanQueueSent(),
// the DB side of the queue's "Mark sent" action — kept here rather than in
// the route handler so tests/channel-routing.test.ts exercises it hermetically.
//
// SECURITY: callers inject the Supabase client (service-role on system paths)
// — same SEC-1 visible-blast-radius pattern as ingest-inbound.ts.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { OutreachStatus } from './outreach-status';

/** The channels channel_conversion_priors actually tracks (018/020). */
export type PriorChannel = 'email' | 'instagram_dm' | 'tiktok_dm';

export type PriorEvent = 'sent' | 'reply' | 'deal';

const PRIOR_COLUMNS: Record<PriorEvent, 'sent' | 'replies' | 'deals'> = {
  sent: 'sent',
  reply: 'replies',
  deal: 'deals',
};

/**
 * Normalize any channel-ish value the codebase carries onto a priors channel.
 * Accepts outreach_messages.channel values ('email'|'instagram_dm'|'tiktok_dm'|
 * 'linkedin_dm'), influencer platforms ('instagram'|'tiktok'), and returns null
 * for anything the priors table doesn't track (legacy 'dm', linkedin, unknown).
 */
export function toPriorChannel(value: string | null | undefined): PriorChannel | null {
  if (value === 'email' || value === 'instagram_dm' || value === 'tiktok_dm') return value;
  if (value === 'instagram') return 'instagram_dm';
  if (value === 'tiktok') return 'tiktok_dm';
  return null;
}

/**
 * True when a campaign_influencers.primary_channel means "this creator is
 * reached by DM, not auto-email." Values in the wild: 'email' and legacy 'dm'
 * (run route pre-contact-discovery stamp: contact_email ? 'email' : 'dm'),
 * plus the ContactChannel set from discoverContacts ('email'|'instagram_dm'|
 * 'tiktok_dm'). Legacy 'dm' routes to the human queue too — it literally means
 * "no email address was found", so the auto-email path cannot work.
 */
export function isDmPrimaryChannel(primary: string | null | undefined): boolean {
  return primary === 'instagram_dm' || primary === 'tiktok_dm' || primary === 'dm';
}

/**
 * True only when the database is telling us bump_channel_prior does not exist:
 * Postgres undefined_function (42883), or PostgREST failing to find it in the
 * schema cache (PGRST202). Anything else — timeout, permission, connection —
 * is ambiguous about whether the write landed.
 */
function isMissingFunctionError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  if (code === '42883' || code === 'PGRST202') return true;
  const msg = typeof e?.message === 'string' ? e.message.toLowerCase() : '';
  return (
    msg.includes('does not exist') ||
    msg.includes('could not find the function') ||
    msg.includes('unknown function')
  );
}

export interface BumpPriorArgs {
  firmId: string | null | undefined;
  channel: string | null | undefined;
  event: PriorEvent;
}

/**
 * Increment one funnel counter on channel_conversion_priors. NEVER throws —
 * a priors write must not take down a send or an ingest.
 *
 * The OBSERVED counters (observed_sent/replies/deals, migration 043) are
 * written by the RPC only. They do not exist before 043, and after 043 the
 * client has .rpc — the legacy path below is a pre-migration compatibility
 * shim.
 *
 * The shim is lossy. Both consumers read observed_* (scoring.ts
 * blendResponseLikelihood and contact-discovery's loadPriors), and the shim
 * bumps only the seeded sent/replies/deals, so a count recorded through it is
 * invisible to both. That is still the right trade: it runs only before 043,
 * and a dropped advisory count beats a fabricated one.
 *
 * ATOMIC-FIRST (migration 043): the bump_channel_prior RPC is an
 * INSERT … ON CONFLICT DO UPDATE with relative increments — atomic under
 * concurrency, so no count is ever lost and the cold-row double-insert race
 * is gone. Until 043 is applied (or against a client without .rpc, like the
 * hermetic store), it falls back to the legacy read-modify-write below, which
 * keeps the documented v1 race: two concurrent bumps of the same
 * (firm, channel) can lose one count — tolerable because the counters feed a
 * Laplace-smoothed ranking where ±1 is noise, and it disappears entirely once
 * the migration lands.
 */
export async function bumpPrior(sb: SupabaseClient, args: BumpPriorArgs): Promise<void> {
  try {
    const { firmId, event } = args;
    if (!firmId) return;
    const channel = toPriorChannel(args.channel);
    if (!channel) return;
    const col = PRIOR_COLUMNS[event];

    // 1. Atomic path (043).
    //
    // The fallback is taken ONLY when the function is provably absent (review
    // finding N4). The first version fell back on ANY rpc failure, which is
    // unsafe in both directions: a statement timeout or a dropped connection
    // can arrive AFTER the server has already committed the increment, so
    // retrying through the legacy path double-counts, and a permission failure
    // post-apply would silently re-enable the very race 043 removes. An
    // ambiguous failure therefore drops the count instead — these counters are
    // advisory and Laplace-smoothed, so one missing event is noise, while a
    // double-count is a fabricated event.
    try {
      const rpc = (sb as unknown as { rpc?: unknown }).rpc;
      if (typeof rpc === 'function') {
        const { error } = await sb.rpc('bump_channel_prior', {
          p_firm_id: firmId,
          p_channel: channel,
          p_event: event,
        });
        if (!error) return;
        if (!isMissingFunctionError(error)) return; // ambiguous → drop, never retry
      }
    } catch {
      // A throw here is a transport failure that may or may not have committed.
      // Same asymmetry: drop rather than risk double-applying.
      return;
    }

    // 2. Legacy read-modify-write (pre-043 fallback).
    const { data } = await sb
      .from('channel_conversion_priors')
      .select('id, sent, replies, deals')
      .eq('firm_id', firmId)
      .eq('channel', channel)
      .maybeSingle();

    if (data) {
      const row = data as { id: string; sent: number; replies: number; deals: number };
      await sb
        .from('channel_conversion_priors')
        .update({
          [col]: Number(row[col] ?? 0) + 1,
          updated_at: new Date().toISOString(),
        } as never)
        .eq('id', row.id);
    } else {
      // Cold row (firm/channel the 020 seed didn't cover). UNIQUE(firm_id,
      // channel) makes a concurrent double-insert fail; that error is
      // swallowed below — the other writer's row won, we just lose one count.
      await sb.from('channel_conversion_priors').insert({
        firm_id: firmId,
        channel,
        sent: event === 'sent' ? 1 : 0,
        replies: event === 'reply' ? 1 : 0,
        deals: event === 'deal' ? 1 : 0,
      } as never);
    }
  } catch {
    // Counters are advisory — never let them break the caller's send path.
  }
}

/** campaign_influencer → campaign → firm_id, or null. Never throws. */
export async function firmIdForCampaignInfluencer(
  sb: SupabaseClient,
  campaignInfluencerId: string | null | undefined,
): Promise<string | null> {
  try {
    if (!campaignInfluencerId) return null;
    const { data: ci } = await sb
      .from('campaign_influencers')
      .select('campaign_id')
      .eq('id', campaignInfluencerId)
      .maybeSingle();
    const campaignId = (ci as { campaign_id: string } | null)?.campaign_id;
    if (!campaignId) return null;
    const { data: camp } = await sb
      .from('campaigns')
      .select('firm_id')
      .eq('id', campaignId)
      .maybeSingle();
    return (camp as { firm_id: string } | null)?.firm_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Attempted-channel bookkeeping for a lead we are about to mark sent.
 *
 * `markHumanQueueSent` used to advance `outreach_status`/`last_outreach_at` and
 * leave `primary_channel` and `channels_tried` exactly as it found them, so a
 * lead drafted from a legacy `primary_channel='dm'` row went to
 * outreach_status='sent' still carrying 'dm' and an EMPTY `channels_tried` —
 * which is the state escalation then read as "tiktok_dm has never been tried".
 * Such rows end up with `channels_tried` of length 0.
 *
 * This is the send-time half of the fix. It is here rather than in a draft
 * route because this function is where a DM becomes a real send, whichever
 * route produced the draft — draft-all, /api/outreach/generate, generate-bulk,
 * or an escalation. escalation.ts's own expansion is what makes the READ safe
 * regardless; this makes the DATA true, so analytics, the audit trail and any
 * future reader see the concrete channel.
 *
 * Rules:
 *   * `channels_tried` is UNIONED, never replaced. An escalation writes
 *     [ch1, ch2] at insert time; replacing it with [ch2] here would drop ch1
 *     and re-open the duplicate on the first channel.
 *   * `primary_channel` is only written when it is null or the legacy 'dm'. A
 *     concrete value is never clobbered.
 *   * On a read failure it returns {} — the send still records, we just decline
 *     to guess at bookkeeping we could not read. Fail closed: a wrong
 *     `channels_tried` is worse than a stale one, because escalation.ts's
 *     expansion already covers the stale case.
 */
async function attemptedChannelPatch(
  sb: SupabaseClient,
  campaignInfluencerId: string,
  channel: PriorChannel | null,
): Promise<Record<string, unknown>> {
  if (!channel) return {};
  try {
    const { data, error } = await sb
      .from('campaign_influencers')
      .select('primary_channel, channels_tried')
      .eq('id', campaignInfluencerId)
      .maybeSingle();
    if (error || !data) return {};
    const row = data as { primary_channel: string | null; channels_tried: string[] | null };

    const tried = new Set<string>();
    for (const c of row.channels_tried ?? []) {
      if (typeof c === 'string' && c) tried.add(c);
    }
    tried.add(channel);

    const patch: Record<string, unknown> = { channels_tried: [...tried] };
    if (!row.primary_channel || row.primary_channel === 'dm') {
      patch.primary_channel = channel;
    }
    return patch;
  } catch {
    return {};
  }
}

export interface MarkHumanQueueSentArgs {
  messageId: string;
  campaignInfluencerId: string | null;
  firmId: string;
  /** Message channel or influencer platform — normalized internally. */
  channel: string | null | undefined;
  /** ms-epoch clock; default Date.now() (injectable for tests). */
  nowMs?: number;
  socialAccountId?: string | null;
  /**
   * Set when the caller's pre-check judged this a FIRST TOUCH (the creator has
   * not been contacted). The flip below is then a claim, and the campaign's
   * outreach limit and budget pacing are re-counted after it
   * (recheckFirstTouchAfterClaim), exactly as the email send route and the
   * dispatch pass do: concurrent Mark-sent clicks (the bulk action fires a
   * batch at once) all pass the pre-check, so only a recount after each
   * committed flip sees the rivals. A refusal puts the row back to `restore`.
   */
  firstTouchRecheck?: { restore: { status: string | null; send_after: string | null } };
}

export type MarkHumanQueueSentResult =
  | { ok: true; sent_at: string }
  | {
      ok: false;
      error: string;
      /** The gate's refusal when the post-claim recount said no ('first_touch_refused'). */
      refusal?: { status: 409 | 503; body: { error: string; message: string } & Record<string, unknown> };
    };

/**
 * The DB side of the DM queue's "Mark sent" action: the human has already sent
 * the DM from the firm's own account; this records the fact. Flips the
 * outreach_messages row to sent, advances the campaign_influencer (same fields
 * the email send route stamps), appends the social_send_events audit row, and
 * bumps the 'sent' prior. Ledger + prior are best-effort: a failure there never
 * un-sends what the human already sent.
 *
 * The CALLER owns authorization (firm ownership) and the already-sent check.
 */
export async function markHumanQueueSent(
  sb: SupabaseClient,
  args: MarkHumanQueueSentArgs,
): Promise<MarkHumanQueueSentResult> {
  const sentAt = new Date(args.nowMs ?? Date.now()).toISOString();
  const channel = toPriorChannel(args.channel);

  const { data: sentRow, error: msgErr } = await sb
    .from('outreach_messages')
    .update({
      status: 'sent',
      sent_at: sentAt,
      send_after: null,
      sent_to: channel ? `${channel}:human` : 'dm:human',
    } as never)
    .eq('id', args.messageId)
    // Conditional on the row not already being sent: this is the idempotency
    // guard, and it has to live in the WHERE clause rather than in a prior read.
    // The route checks `sent_at` before calling, but that is a read-then-write —
    // two concurrent Mark-sent clicks both pass the check, and everything below
    // (the channel prior, the reply prediction, and the priced offer that starts
    // the negotiator) would run twice for one message. Postgres is the only
    // thing that can arbitrate that.
    .is('sent_at', null)
    .select('id')
    .maybeSingle();
  if (msgErr) return { ok: false, error: msgErr.message };
  if (!sentRow) {
    // Someone already marked it. Not an error — the desired state holds — but
    // nothing after this point may run a second time.
    return { ok: false, error: 'already_sent' };
  }

  // The flip is committed, so this thread now reads as contacted to every
  // rival's recount, and every rival that flipped first reads as contacted to
  // ours. Of two racers for the last slot the later recount refuses; at worst
  // both refuse, never both record. Nothing below has run yet, so a refusal
  // leaves no lead advance, ledger row, prior or offer behind.
  if (args.firstTouchRecheck && args.campaignInfluencerId) {
    // Lazy: first-touch-gate pulls in negotiation.ts (see the offer block below).
    const { recheckFirstTouchAfterClaim } = await import('./first-touch-gate');
    const re = await recheckFirstTouchAfterClaim(sb, args.campaignInfluencerId, args.nowMs ?? Date.now());
    if (!re.ok) {
      const { restore } = args.firstTouchRecheck;
      await sb
        .from('outreach_messages')
        .update({ status: restore.status, sent_at: null, send_after: restore.send_after, sent_to: null } as never)
        .eq('id', args.messageId)
        .eq('sent_at', sentAt);
      return { ok: false, error: 'first_touch_refused', refusal: re };
    }
  }

  if (args.campaignInfluencerId) {
    const bookkeeping = await attemptedChannelPatch(sb, args.campaignInfluencerId, channel);
    await sb
      .from('campaign_influencers')
      .update({
        // Same gap the email send route had: advancing only `status` left the
        // creator on 'draft_ready', so a DM a human actually sent by hand never
        // showed up in the /outreach Sent tab. A hand-sent DM is a send.
        outreach_status: 'sent' satisfies OutreachStatus,
        status: 'contacted',
        last_outreach_at: sentAt,
        ...bookkeeping,
      } as never)
      .eq('id', args.campaignInfluencerId);
  }

  try {
    await sb.from('social_send_events').insert({
      firm_id: args.firmId,
      social_account_id: args.socialAccountId ?? null,
      outreach_message_id: args.messageId,
      campaign_influencer_id: args.campaignInfluencerId,
      channel: channel ?? 'dm',
      status: 'sent',
      detail: 'human_queue mark_sent',
    } as never);
  } catch {
    // Audit ledger is best-effort — the send already happened in the world.
  }

  await bumpPrior(sb, { firmId: args.firmId, channel, event: 'sent' });

  // Learning spine: the DM leg of the reply_prediction pair —
  // a human-marked DM send is a send, so the prediction freezes here exactly
  // as the auto-email route does. Lazy import keeps this module's dependency
  // surface unchanged for existing callers; never throws.
  try {
    const { logReplyPrediction } = await import('./learning-log');
    await logReplyPrediction(sb, {
      campaignInfluencerId: args.campaignInfluencerId,
      channel,
      outreachMessageId: args.messageId,
    });
  } catch {
    // learning is best-effort — the send already happened in the world
  }

  // Open the negotiable offer, exactly as the email send route does. A DM a
  // human sent by hand is a send, and the creator can reply to it — so without
  // this, every DM lead hit the same dead end the email path just stopped
  // hitting: the reply resolves to no offer at all and the negotiator no-ops.
  // That matters more here than on the email path, because ~95% of the pool is
  // DM-reachable and not email-reachable.
  //
  // Lazy import: negotiation.ts pulls in the model provider and the payment
  // path, and this module is imported by routes that must not carry that
  // weight. Never throws — the send already happened in the world.
  try {
    if (args.campaignInfluencerId) {
      const { data: ci } = await sb
        .from('campaign_influencers')
        .select('campaign_id, influencer_id')
        .eq('id', args.campaignInfluencerId)
        .maybeSingle();
      const row = ci as { campaign_id: string; influencer_id: string } | null;
      if (row) {
        const [{ openOfferForSentOutreach }, { data: inf }, { data: camp }] = await Promise.all([
          import('./negotiation'),
          sb
            .from('influencers')
            .select('platform, follower_count, engagement_rate')
            .eq('id', row.influencer_id)
            .maybeSingle(),
          sb.from('campaigns').select('genre').eq('id', row.campaign_id).maybeSingle(),
        ]);
        const i = inf as {
          platform: string | null;
          follower_count: number | null;
          engagement_rate: number | null;
        } | null;
        await openOfferForSentOutreach(sb, {
          campaign_influencer_id: args.campaignInfluencerId,
          campaign_id: row.campaign_id,
          firm_id: args.firmId,
          outreach_message_id: args.messageId,
          follower_count: i?.follower_count ?? null,
          engagement_rate: i?.engagement_rate ?? null,
          platform: i?.platform ?? null,
          genre: (camp as { genre: string | null } | null)?.genre ?? null,
        });
      }
    }
  } catch {
    // Offer creation is best-effort here for the same reason the email path
    // makes it non-throwing: the message is already out.
  }

  return { ok: true, sent_at: sentAt };
}
