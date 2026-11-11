// src/app/api/outreach/[id]/send/route.ts
//
// SECURITY-OK: supabaseAdmin — api_ledger has no INSERT policy for authed users (system audit table). Single chokepoint for one ledger row per send (success OR failure). Session + message-firm-ownership check gates the route.
//
// SYSTEM PATH (SEC-1 exempt) — owns Resend dispatch + ledger writes.
//
// Why service-role: api_ledger has no INSERT policy for authenticated users
// (system audit table) and we want a single chokepoint that produces a
// consistent ledger row for every send attempt (success OR failure).
// We still gate the route by requiring a session and confirming the
// message belongs to the caller's firm — FIRST, before any state-dependent
// response (src/lib/outreach-send-gate.ts).
//
// Task E2: Send route — dispatches an outreach_messages draft via Resend with
// firm-level testing-mode recipient resolution. Records every send attempt to
// api_ledger (cost_usd=0, request_meta carries test_mode + resolved_to). On
// success advances the campaign_influencers row to status='contacted'.
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getSession } from '@/lib/auth';
import { sendOutreach } from '@/lib/resend';
import { recordApiCall } from '@/lib/api-ledger';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { bumpPrior, isDmPrimaryChannel } from '@/lib/channel-priors';
import { logReplyPrediction } from '@/lib/learning-log';
import { openOfferForSentOutreach } from '@/lib/negotiation';
import {
  audienceFitOf,
  contactBlock,
  resolvePoolGatePrefs,
} from '@/lib/pool-gates';
import type { OutreachStatus } from '@/lib/outreach-status';
import { loadSendableMessage } from '@/lib/outreach-send-gate';
import { OUTREACH_NOT_FOUND } from '@/lib/outreach-scope';
import { readFirmBlocks } from '@/lib/firm-blocks';
import {
  checkFirstTouch,
  isReplyOnlyMessageType,
  recheckFirstTouchAfterClaim,
  type GateRefusal,
} from '@/lib/first-touch-gate';
import {
  MANUAL_SEND_LOST,
  MANUAL_SEND_NOT_SENDABLE,
  claimAndSendManual,
} from '@/lib/outbound-claim';

export const runtime = 'nodejs';

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(_req: Request, ctx: Ctx) {
  // SEC-2: Resend send → expensive tier (free-tier daily quota is finite).
  const limit = tieredLimit(_req, 'expensive');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  const { id: messageId } = await ctx.params;

  // SEC-1 gate: require an authenticated session before triggering a send.
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const sb = supabaseAdmin();

  // 1. Ownership, then the draft and its terminal-state refusals
  //    (src/lib/outreach-send-gate.ts). The firm check runs FIRST: a foreign
  //    id is a 404 identical to an unknown one, so another label cannot probe
  //    which messages exist or whether they were sent, withdrawn or closed.
  const gate = await loadSendableMessage(sb, messageId, session.firm_id);
  if (!gate.ok) {
    return NextResponse.json(gate.body, { status: gate.status });
  }
  const m = gate.message;

  // 2. Resolve campaign_influencer → campaign → firm + influencer
  const { data: ci, error: ciErr } = await sb
    .from('campaign_influencers')
    .select(
      'id, campaign_id, influencer_id, primary_channel, ' +
        'qualification_status, qualification_reason, bot_flagged, score_breakdown'
    )
    .eq('id', m.campaign_influencer_id)
    .single();
  if (ciErr || !ci) {
    return NextResponse.json(
      { error: 'campaign_influencer not found' },
      { status: 404 }
    );
  }
  const ciTyped = ci as {
    id: string;
    campaign_id: string;
    influencer_id: string;
    primary_channel: string | null;
    qualification_status: string | null;
    qualification_reason: string | null;
    bot_flagged: boolean | null;
    score_breakdown: unknown;
  };

  const { data: campaign, error: campErr } = await sb
    .from('campaigns')
    .select('firm_id, release_date, genre')
    .eq('id', ciTyped.campaign_id)
    .single();
  if (campErr || !campaign) {
    return NextResponse.json({ error: 'campaign not found' }, { status: 404 });
  }
  const firmId = (campaign as { firm_id: string }).firm_id;
  const releaseDate = (campaign as { release_date: string | null }).release_date;
  const campTyped = campaign as { genre: string | null };

  // Staleness gate: an INITIAL draft written before a release date that has
  // since passed almost certainly pitches the release as upcoming (live
  // corpus: 265 queued drafts said "upcoming July 4th" ten weeks after
  // July 4th). Block it and name the fix — regenerate drafts.
  if (m.message_type === 'initial' && releaseDate && m.created_at) {
    const rel = Date.parse(releaseDate);
    const created = Date.parse(m.created_at);
    if (Number.isFinite(rel) && Number.isFinite(created) && created < rel && Date.now() > rel) {
      return NextResponse.json(
        {
          error: 'stale_draft',
          message:
            'This draft was written before the release date, which has since passed, so it likely pitches the release as upcoming. Regenerate drafts for this campaign, then send.',
        },
        { status: 409 }
      );
    }
  }

  // SEC-1 ownership re-check (defense in depth — loadSendableMessage already
  // proved it). Same 404 as an unknown id, never a distinguishable 403.
  if (firmId !== session.firm_id) {
    return NextResponse.json(OUTREACH_NOT_FOUND, { status: 404 });
  }

  const { data: inf, error: infErr } = await sb
    .from('influencers')
    .select('contact_email, username, platform, follower_count, engagement_rate, bot_flagged, blocklisted')
    .eq('id', ciTyped.influencer_id)
    .single();
  if (infErr || !inf) {
    return NextResponse.json({ error: 'influencer not found' }, { status: 404 });
  }
  const infTyped = inf as {
    contact_email: string | null;
    username: string;
    platform: string | null;
    follower_count: number | null;
    engagement_rate: number | null;
    bot_flagged: boolean | null;
    blocklisted: boolean | null;
  };

  // Pool gate at the SEND boundary.
  //
  // Gating the draft path was not enough. A draft written before a gate
  // existed — or before the firm set its cap — kept a working Send button,
  // even for creators these gates rule out. "The gate decides who gets contacted" has to hold at the
  // last door, not just the first, so the firm's CURRENT prefs are re-derived
  // here rather than trusting the verdict stored at draft time.
  //
  // Placed before the DM-routing guard on purpose: a creator who must not be
  // contacted must not be queued for a human to contact by hand either.
  const { data: gateFirm } = await sb
    .from('firms')
    .select('scraping_prefs')
    .eq('id', firmId)
    .single();
  // Per-label do-not-contact (migration 056) — a STOP to this label, or this
  // label's Block. This is the last door, so an unreadable list fails CLOSED:
  // the draft stays, nothing is sent, and the user can retry. Pre-056 the
  // table is missing and only the global flag gates, as before.
  const firmBlocks = await readFirmBlocks(sb, firmId, [ciTyped.influencer_id]);
  if (firmBlocks.state === 'unreadable') {
    console.error('[outreach/send] firm block list unreadable — refusing to send', firmBlocks.message);
    return NextResponse.json(
      {
        error: 'block_list_unreadable',
        message: `Couldn't confirm @${infTyped.username} hasn't opted out of your label's outreach, so nothing was sent. Try again in a minute.`,
      },
      { status: 503 }
    );
  }
  const block = contactBlock(
    {
      qualification_status: ciTyped.qualification_status,
      qualification_reason: ciTyped.qualification_reason,
      bot_flagged: ciTyped.bot_flagged === true || infTyped.bot_flagged === true,
      blocklisted: infTyped.blocklisted === true || firmBlocks.ids.has(ciTyped.influencer_id),
      followers: infTyped.follower_count,
      audience_fit: audienceFitOf(ciTyped.score_breakdown),
    },
    resolvePoolGatePrefs(
      (gateFirm as { scraping_prefs?: unknown } | null)?.scraping_prefs
    )
  );
  if (block) {
    return NextResponse.json(
      {
        error: 'excluded',
        code: block.code,
        message: `@${infTyped.username} is out of this firm's creator pool: ${block.reason}. The draft stays for the record; it was not sent.`,
      },
      { status: 409 }
    );
  }

  // Mini-run limit + budget pacing (src/lib/first-touch-gate.ts), for a FIRST
  // touch only — a creator already contacted passes straight through. Before
  // the DM-routing branch on purpose: a creator past the limit must not be
  // queued for a human to contact by hand either. Unreadable → 503, nothing sent.
  const firstTouch = isReplyOnlyMessageType(m.message_type)
    ? ({ ok: true, firstTouch: false } as const)
    : await checkFirstTouch(sb, ciTyped.id);
  if (!firstTouch.ok) {
    return NextResponse.json(firstTouch.body, { status: firstTouch.status });
  }

  // Guard 2/2 — routed dispatch: a creator whose resolved channel is
  // a DM (campaign_influencers.primary_channel: 'instagram_dm' | 'tiktok_dm',
  // or the legacy 'dm' stamp meaning "no email found"), or a draft written FOR
  // a DM channel, must not go out as an email. Stamp it human_queue on this
  // first send attempt — that moves it to the DM queue tab, where a human
  // sends it from the firm's own account and marks it sent.
  const dmRouted =
    isDmPrimaryChannel(ciTyped.primary_channel) || (m.channel != null && m.channel !== 'email');
  if (dmRouted) {
    await sb
      .from('outreach_messages')
      .update({ send_mode: 'human_queue', needs_human: true } as never)
      .eq('id', messageId);
    return NextResponse.json(
      {
        error: 'dm_queue',
        routed: true,
        message: `@${infTyped.username} is reached by DM. Draft moved to the DM queue for a one-click human send.`,
      },
      { status: 409 }
    );
  }

  // 3. CLAIM, THEN SEND WHAT THE CLAIM RETURNED. This route used to send the body it read
  //    in step 1, flip the row to sent unconditionally, and re-read offer_usd
  //    afterwards: an edit landing mid-send left the creator with the old text
  //    while the row recorded the new price, and the AI later agreed a deal at
  //    a number the creator never saw. A queued row could also go twice — once
  //    here, once from the dispatch pass. Now the row is claimed with the SAME
  //    conditional update the dispatch pass uses (src/lib/outbound-claim.ts):
  //    one sender wins, the other gets 409; the body sent and the price
  //    recorded are the claim's RETURNING; a failed send releases the row.
  //
  //    Dispatch via Resend (testing-mode resolution lives inside sendOutreach).
  //    Pass session user id + email so the resolver can pick up per-user
  //    firm_members overrides (migration 013) and fall back to the caller's
  //    own inbox before env defaults. provider_message_id is Resend's own
  //    email id — the ONLY key the delivery webhook can match on,
  //    stamped by claimAndSendManual on success.
  // Set when the post-claim recount refuses (see recheckFirstTouchAfterClaim).
  const heldAfterClaim: { refusal: GateRefusal | null } = { refusal: null };
  const outcome = await claimAndSendManual(
    sb,
    { messageId, from: { status: m.status, send_after: m.send_after }, nowMs: Date.now() },
    async (claimed) => {
      // A first touch re-counts AFTER its claim, so concurrent first touches
      // (a bulk batch, two tabs) cannot all take the last slot or the last
      // dollar. A refusal is returned as a failed send: the claim is released
      // and nothing reaches the provider.
      if (firstTouch.firstTouch) {
        const re = await recheckFirstTouchAfterClaim(sb, ciTyped.id);
        if (!re.ok) {
          heldAfterClaim.refusal = re;
          return { ok: false, test_mode: false, resolved_to: '', error: re.body.error };
        }
      }
      const t0 = Date.now();
      const r = await sendOutreach({
        firm_id: firmId,
        to_real: infTyped.contact_email,
        subject: claimed.subject ?? '',
        body: claimed.body,
        message_type: claimed.message_type,
        clerk_user_id: session.user.id,
        user_email: session.user.email,
        campaign_influencer_id: ciTyped.id,
      });
      // 4. Audit — even failures get a ledger row so debug-from-data works
      await recordApiCall({
        campaign_id: ciTyped.campaign_id,
        source: 'resend',
        endpoint: 'send',
        cost_usd: 0,
        latency_ms: Date.now() - t0,
        request_meta: {
          message_id: messageId,
          influencer_username: infTyped.username,
          test_mode: r.test_mode,
          resolved_to: r.resolved_to,
          ok: r.ok,
          error: r.error ?? null,
        },
      });
      return r;
    }
  );

  if (outcome.kind === 'not_sendable') {
    return NextResponse.json(MANUAL_SEND_NOT_SENDABLE, { status: 409 });
  }
  if (outcome.kind === 'lost') {
    return NextResponse.json(MANUAL_SEND_LOST, { status: 409 });
  }
  if (outcome.kind === 'not_email') {
    return NextResponse.json(
      {
        error: 'dm_queue',
        message: 'This draft is in the DM queue. Send it by hand from the DM queue tab.',
      },
      { status: 409 }
    );
  }
  if (outcome.kind === 'failed' && heldAfterClaim.refusal) {
    const r = heldAfterClaim.refusal;
    return NextResponse.json(r.body, { status: r.status });
  }
  if (outcome.kind === 'failed') {
    return NextResponse.json(
      { ok: false, error: outcome.result.error, test_mode: outcome.result.test_mode },
      { status: 500 }
    );
  }
  const result = outcome.result;

  // 5. Mark the campaign_influencer as sent (the message row was claimed and
  //    stamped in step 3, and a price recorded on it applied from the claim).
  const sentAt = outcome.sentAt;
  await sb
    .from('campaign_influencers')
    .update({
      // outreach_status is what the /outreach screen reads — its Sent tab, its
      // stat counters and the log-response box are all gated on this value.
      // This route used to advance only `status`, so a real, delivered send
      // left the creator sitting on 'draft_ready' forever: the Sent tab was
      // permanently empty and the reply box never appeared. `status` is also
      // reset to 'queued' by every discovery re-run
      // (api/campaigns/[id]/run/route.ts:757), so it cannot carry send state.
      outreach_status: 'sent' satisfies OutreachStatus,
      status: 'contacted',
      last_outreach_at: sentAt,
    } as never)
    .eq('id', ciTyped.id);

  // Priors learn — a successful auto-email is the 'sent' funnel
  // event on the email channel (this route only ever dispatches email).
  await bumpPrior(sb, { firmId, channel: 'email', event: 'sent' });

  // Learning spine: freeze the response-likelihood PREDICTION
  // at the moment the message actually left. The actual lands as a paired
  // reply_outcome event on the first matched inbound (ingest-inbound.ts).
  // Never throws; synthetic campaigns excluded inside.
  await logReplyPrediction(sb, {
    campaignInfluencerId: ciTyped.id,
    channel: 'email',
    outreachMessageId: messageId,
  });

  // Open the negotiable offer. Sending outreach IS the initial offer, and before
  // this nothing ever created one at 'offered' — so a creator's
  // reply hit an offer the auto-negotiator refuses to touch, no-opped, and was
  // marked processed. See openOfferForSentOutreach for the full diagnosis.
  // Idempotent and non-throwing: the email has already left.
  const offer = await openOfferForSentOutreach(sb, {
    campaign_influencer_id: ciTyped.id,
    campaign_id: ciTyped.campaign_id,
    firm_id: firmId,
    outreach_message_id: messageId,
    follower_count: infTyped.follower_count,
    engagement_rate: infTyped.engagement_rate,
    genre: campTyped.genre,
    platform: infTyped.platform ?? null,
    request: _req,
  });

  return NextResponse.json({
    ok: true,
    test_mode: result.test_mode,
    resolved_to: result.resolved_to,
    message_id: result.message_id,
    offer_id: offer?.id ?? null,
    offer_usd: offer?.current_offer_usd ?? null,
  });
}
