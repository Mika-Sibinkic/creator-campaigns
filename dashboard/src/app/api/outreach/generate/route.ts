// src/app/api/outreach/generate/route.ts
//
// requireSessionAndClient() returns the SERVICE-ROLE client, so RLS does not
// scope the lead; leadInFirm (src/lib/outreach-scope.ts) does, before any
// model spend.
//
// This route is the /outreach page's "Generate" button. It used to
// run an unguarded second generator; it now goes through the one hardened
// path in src/lib/outreach.ts, which refuses excluded/bot creators outright
// (DraftRefusedError → 422, not 500) and validates every draft before it is
// saved.
import { NextRequest, NextResponse } from "next/server";
import { requireSessionAndClient } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { DraftRefusedError, generateOutreachMessage, saveOutreachMessage } from "@/lib/outreach";
import { leadInFirm } from "@/lib/outreach-scope";
import { tieredLimit, rateLimited } from "@/lib/rate-limit";
import { readJson } from "@/lib/validate";
import { GenerateOutreachBody } from "@/lib/zod-schemas";

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  // OpenAI cost on every call → expensive tier.
  const limit = tieredLimit(req, 'expensive');
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
  const body = await readJson(req, GenerateOutreachBody);
  if (body instanceof NextResponse) return body;
  const { campaign_influencer_id, message_type, channel, custom_instructions } = body;

  // Tenant gate: sb is service-role, so nothing else stops a caller drafting
  // (and reading back) outreach for another label's lead. 404, not 403 — a
  // foreign lead id reads exactly like an unknown one.
  if (!(await leadInFirm(sb, campaign_influencer_id, session.firm_id))) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  try {
    const message = await generateOutreachMessage({
      sb,
      campaign_influencer_id,
      message_type: message_type || "initial",
      channel,
      custom_instructions,
    });

    const messageId = await saveOutreachMessage(
      sb,
      campaign_influencer_id,
      message,
      message_type || "initial"
    );

    await audit(
      {
        action: 'outreach.draft.create',
        target_type: 'outreach_message',
        target_id: messageId,
        firm_id: session.firm_id,
        metadata: {
          campaign_influencer_id,
          message_type: message_type || 'initial',
          // The channel the draft was actually written to, resolved from the
          // lead — not the request's optional hint.
          channel: message.channel,
          has_custom_instructions: !!custom_instructions,
          // Copy provenance: 'fallback' means the model's copy failed the
          // validator twice and safe deterministic copy was used instead.
          copy_source: message.copy_source,
          violations: message.violations,
          qualification: message.qualification,
        },
      },
      req
    );

    return NextResponse.json({
      id: messageId,
      ...message,
    });
  } catch (err) {
    if (err instanceof DraftRefusedError) {
      await audit(
        {
          action: 'outreach.draft.refused',
          target_type: 'campaign_influencer',
          target_id: campaign_influencer_id,
          firm_id: session.firm_id,
          metadata: {
            reason_code: err.refusal.reason_code,
            reason: err.refusal.message,
            qualification: err.refusal.qualification_status,
          },
        },
        req
      );
      return NextResponse.json(
        {
          error: err.refusal.message,
          reason_code: err.refusal.reason_code,
          qualification: err.refusal.qualification_status,
        },
        { status: 422 }
      );
    }
    console.error("[creator-campaigns] Outreach generation error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Generation failed" },
      { status: 500 }
    );
  }
}
