// src/app/api/campaigns/comment-audit/route.ts
//
// GET → { supported, provider, estimate_usd }: is migration 066 applied (the
// comment-quality audit's columns + table), which comment provider is
// active, and what one run of the audit is expected to cost with it. The
// new-campaign form shows "Check comments (≈$N per run)" only when supported.
// A failed probe answers supported=false: the toggle stays hidden.
//
// USER PATH — session required; reads no row data (LIMIT 1 column probes).
// A static segment, so it takes precedence over /api/campaigns/[id].
import { NextRequest, NextResponse } from "next/server";
import { requireSessionAndClient } from "@/lib/auth";
import { tieredLimit, rateLimited } from "@/lib/rate-limit";
import { commentAuditSupported } from "@/lib/comment-audit-store";
import { selectCommentsProvider } from "@/lib/comments-provider";
import { estimateAuditRunUsd } from "@/lib/comment-audit-run";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limit = tieredLimit(req, "auth");
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  let sb;
  try {
    ({ sb } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }
  const supported = await commentAuditSupported(sb);
  const provider = selectCommentsProvider();
  return NextResponse.json({
    supported: supported === true,
    provider: provider.name,
    estimate_usd: estimateAuditRunUsd(provider),
  });
}
