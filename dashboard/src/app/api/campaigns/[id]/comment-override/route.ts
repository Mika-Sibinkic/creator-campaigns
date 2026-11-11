// src/app/api/campaigns/[id]/comment-override/route.ts
//
// POST { campaign_influencer_id, reason } — a human clears a comment hold
// (migration 066, src/lib/comment-audit.ts) so the creator can be contacted.
//
// Who may: a member of the firm that owns the campaign, or a platform
// operator (src/lib/operator.ts). Writes campaign_influencers.comment_override
// = {by_user_id, by_label, reason, at} and an audit_log row
// 'campaign_influencer.comment_override'. The audit row itself stays: the
// override clears the hold for this campaign, it does not rewrite history.
//
// USER PATH — service-role client, so the firm check below is the boundary.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionAndClient } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { isPlatformOperator } from "@/lib/operator";
import { tieredLimit, rateLimited } from "@/lib/rate-limit";
import { readJson } from "@/lib/validate";
import { overrideCommentHold } from "@/lib/comment-audit-store";

export const runtime = "nodejs";

const Body = z.object({
  campaign_influencer_id: z.string().min(1).max(100),
  reason: z.string().trim().min(3).max(500),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const limit = tieredLimit(req, "auth");
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  const { id: campaignId } = await params;
  let sb, session;
  try {
    ({ sb, session } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }
  const body = await readJson(req, Body);
  if (body instanceof NextResponse) return body;

  const { data: camp, error: campErr } = await sb
    .from("campaigns")
    .select("id, firm_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (campErr) {
    return NextResponse.json({ error: "unreadable", message: "Couldn't read this campaign. Try again in a minute." }, { status: 503 });
  }
  const firmId = (camp as { firm_id?: string } | null)?.firm_id;
  const operator = isPlatformOperator(session.user.email);
  if (!camp || (firmId !== session.firm_id && !operator)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const byLabel = `${operator ? "operator" : "user"}:${session.user.email ?? session.user.id}`;
  const result = await overrideCommentHold(sb, {
    campaignId,
    campaignInfluencerId: body.campaign_influencer_id,
    byUserId: session.user.id,
    byLabel,
    reason: body.reason,
    nowIso: new Date().toISOString(),
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, message: result.message }, { status: result.status });
  }

  await audit(
    {
      action: "campaign_influencer.comment_override",
      target_type: "campaign_influencer",
      target_id: body.campaign_influencer_id,
      firm_id: firmId ?? session.firm_id,
      metadata: {
        campaign_id: campaignId,
        reason: body.reason,
        by_operator: operator,
      },
    },
    req
  );

  return NextResponse.json({ ok: true, override: result.override });
}
