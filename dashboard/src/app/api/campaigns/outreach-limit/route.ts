// src/app/api/campaigns/outreach-limit/route.ts
//
// GET → { supported: boolean }: does campaigns.outreach_limit exist yet
// (migration 060)? The new-campaign form shows "Max creators to contact" only
// when it does, so a pre-060 database never sees a field it cannot store.
// A failed probe answers supported=false: the field stays hidden and creation
// works exactly as before.
//
// USER PATH — session required; reads no row data (a LIMIT 1 column probe).
// A static segment, so it takes precedence over /api/campaigns/[id].
import { NextRequest, NextResponse } from "next/server";
import { requireSessionAndClient } from "@/lib/auth";
import { tieredLimit, rateLimited } from "@/lib/rate-limit";
import { outreachLimitSupported } from "@/lib/first-touch-gate";

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
  const supported = await outreachLimitSupported(sb);
  return NextResponse.json({ supported: supported === true });
}
