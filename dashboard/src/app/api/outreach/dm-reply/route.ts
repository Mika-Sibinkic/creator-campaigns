// src/app/api/outreach/dm-reply/route.ts
//
// POST — log a creator's Instagram/TikTok DM reply, pasted by an operator, into
// the negotiator's queue.
//
// The DM queue sends by hand from the label's own account, so replies arrive
// there and only a human can carry them back. This route is that door: it
// resolves the lead through the caller's RLS-bound client (a lead from another
// firm is invisible → 404, and checkFirmScope re-checks the owning firm), then
// ingests through ingestInboundReply exactly as email and the simulator do. The
// negotiator's answer is queued human_queue on the same DM channel by
// negotiation-tick; nothing here sends anything. Decision logic:
// src/lib/dm-reply.ts (tests/dm-reply.test.ts).
//
// SECURITY-OK: supabaseAdmin — only for ingestInboundReply. inbound_messages
// writes are service-role only (migration 018 RLS), same as the simulator and
// the inbound-email webhook. Authorization happens first, on the RLS client.
//
// Not operator-gated, unlike simulate-reply: that route fabricates a reply,
// this one records a real one, and the label's own staff are the ones reading
// their DMs.

import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { LogDmReplyBody } from '@/lib/zod-schemas';
import { ingestInboundReply } from '@/lib/ingest-inbound';
import { logManualDmReply, readSentDmToLead, type ManualDmLead } from '@/lib/dm-reply';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  let session, sb;
  try {
    ({ session, sb } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }
  const body = await readJson(req, LogDmReplyBody);
  if (body instanceof NextResponse) return body;

  const loadLead = async (ciId: string): Promise<ManualDmLead | null> => {
    const { data: ci } = await sb
      .from('campaign_influencers')
      .select('id, influencer:influencers ( username ), campaign:campaigns!inner ( firm_id )')
      .eq('id', ciId)
      .maybeSingle();
    if (!ci) return null;
    const one = <T,>(v: T | T[] | null | undefined): T | null =>
      Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
    const row = ci as {
      influencer: { username: string | null } | { username: string | null }[] | null;
      campaign: { firm_id: string | null } | { firm_id: string | null }[] | null;
    };
    const { data: offers } = await sb
      .from('creator_offers')
      .select('id')
      .eq('campaign_influencer_id', ciId)
      .limit(1);
    return {
      firm_id: one(row.campaign)?.firm_id ?? null,
      username: one(row.influencer)?.username ?? null,
      has_offer: Array.isArray(offers) && offers.length > 0,
      sent_dm: await readSentDmToLead(sb, ciId),
    };
  };

  let outcome;
  try {
    outcome = await logManualDmReply({
      input: body,
      callerFirmId: session.firm_id,
      loadLead,
      ingest: (normalized) => ingestInboundReply(normalized, supabaseAdmin()),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.error, message: outcome.message },
      { status: outcome.status },
    );
  }

  if (!outcome.ingest.deduped) {
    await audit(
      {
        action: 'outreach.dm_reply.logged',
        target_type: 'campaign_influencer',
        target_id: body.campaign_influencer_id,
        firm_id: session.firm_id,
        metadata: {
          channel: body.channel,
          inbound_message_id: outcome.ingest.inbound_message_id,
          outreach_message_id: outcome.ingest.outreach_message_id,
          classification: outcome.ingest.classification,
          confidence: outcome.ingest.confidence,
          negotiator_will_answer: outcome.negotiator_will_answer,
          reply_length: body.text.length,
        },
      },
      req,
    );
  }

  return NextResponse.json({
    inbound_message_id: outcome.ingest.inbound_message_id,
    deduped: outcome.ingest.deduped,
    classification: outcome.ingest.classification,
    negotiator_will_answer: outcome.negotiator_will_answer,
  });
}
