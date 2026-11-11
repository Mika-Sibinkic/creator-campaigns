// src/app/api/outreach/respond/route.ts
//
// POST — log a creator's EMAIL reply, pasted by an operator from /outreach
// ("Log response"), into the same ingest path as real inbound email.
//
// The lead is resolved through the caller's RLS-bound client and its owning
// firm is re-checked with checkFirmScope, so a lead from another label is 404
// (invisible) or 403 (firm mismatch) before anything is written. The reply then
// goes through logManualEmailReply → ingestInboundReply with a `manual:`
// external_id: it lands in inbound_messages for the negotiator, a STOP becomes
// a per-label block (firm-blocks.ts) and cancels that creator's queued
// messages, and the lead's status advances — exactly as for a reply the email
// provider delivered. Decision logic: src/lib/manual-email-reply.ts.
//
// This route used to classify the text, insert an outreach_messages row and
// update the lead itself. That recorded a STOP without honouring it, and the
// negotiator never saw the reply. DM replies
// have their own door, /api/outreach/dm-reply, so the answer goes back as a DM.
//
// SECURITY-OK: supabaseAdmin — two uses, both AFTER authorization on the RLS
// client: (1) ingestInboundReply, because inbound_messages writes are
// service-role only (migration 018 RLS), same as dm-reply and the webhooks;
// (2) `influencers.last_response`, a SHARED cross-firm table with no per-firm
// UPDATE policy. Per-firm response timestamps are deferred (single-tenant today).

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireSessionAndClient } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { audit } from "@/lib/audit";
import { classificationToStatus } from "@/lib/outreach";
import { tieredLimit, rateLimited } from "@/lib/rate-limit";
import { readJson } from "@/lib/validate";
import { RespondClassifyBody } from "@/lib/zod-schemas";
import { ingestInboundReply } from "@/lib/ingest-inbound";
import { logManualEmailReply, type ManualEmailLead } from "@/lib/manual-email-reply";

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
  const body = await readJson(req, RespondClassifyBody);
  if (body instanceof NextResponse) return body;
  const { campaign_influencer_id, response_text, channel } = body;
  // A client that predates submission ids still works; it just loses retry
  // dedupe (every POST is a new reply).
  const submission_id = body.submission_id ?? randomUUID();

  const loadLead = async (ciId: string): Promise<ManualEmailLead | null> => {
    const { data: ci } = await sb
      .from('campaign_influencers')
      .select('id, campaign:campaigns!inner ( firm_id )')
      .eq('id', ciId)
      .maybeSingle();
    if (!ci) return null;
    const camp = (ci as { campaign: { firm_id: string | null } | { firm_id: string | null }[] | null })
      .campaign;
    const one = Array.isArray(camp) ? (camp[0] ?? null) : camp;
    return { firm_id: one?.firm_id ?? null };
  };

  let outcome;
  try {
    outcome = await logManualEmailReply({
      input: { campaign_influencer_id, response_text, submission_id, channel },
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
  const { ingest } = outcome;

  if (!ingest.deduped) {
    // Influencer's global last_response — SHARED table write, see header.
    const { data: ci } = await sb
      .from("campaign_influencers")
      .select("influencer_id")
      .eq("id", campaign_influencer_id)
      .maybeSingle();
    if (ci) {
      await supabaseAdmin()
        .from("influencers")
        .update({ last_response: new Date().toISOString() } as never)
        .eq("id", (ci as { influencer_id: string }).influencer_id);
    }

    await audit(
      {
        action: 'outreach.respond.classify',
        target_type: 'outreach_message',
        target_id: ingest.outreach_message_id ?? ingest.inbound_message_id ?? campaign_influencer_id,
        firm_id: session.firm_id,
        metadata: {
          campaign_influencer_id,
          channel: 'email',
          inbound_message_id: ingest.inbound_message_id,
          classification: ingest.classification,
          confidence: ingest.confidence,
          pipeline_status: classificationToStatus(ingest.classification),
          response_length: response_text.length,
        },
      },
      req
    );
  }

  return NextResponse.json({
    message_id: ingest.outreach_message_id,
    inbound_message_id: ingest.inbound_message_id,
    deduped: ingest.deduped,
    classification: ingest.classification,
    confidence: ingest.confidence,
    pipeline_status: ingest.deduped ? null : classificationToStatus(ingest.classification),
  });
}
