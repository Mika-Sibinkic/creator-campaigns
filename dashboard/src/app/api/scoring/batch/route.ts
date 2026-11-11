// src/app/api/scoring/batch/route.ts
//
// SEC-1 refactor: USER PATH — gated by session, but no DB access (pure
// scoring compute). No supabaseAdmin usage here.
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { scoreInfluencers } from "@/lib/scoring";
import { tieredLimit, rateLimited } from "@/lib/rate-limit";
import { readJson } from "@/lib/validate";
import { ScoringBatchBody } from "@/lib/zod-schemas";

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  // CPU-heavy + scales linearly with input size → expensive tier.
  const limit = tieredLimit(req, 'expensive');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  try {
    await requireSession();
  } catch (r) {
    return r as Response;
  }
  const body = await readJson(req, ScoringBatchBody);
  if (body instanceof NextResponse) return body;
  const { profiles, campaign_context } = body;

  // Loose passthrough into scoreInfluencers — schema enforced shape, not types.
  const result = scoreInfluencers(
    profiles as unknown as Parameters<typeof scoreInfluencers>[0],
    (campaign_context as unknown as Parameters<typeof scoreInfluencers>[1]) || {}
  );

  return NextResponse.json(result);
}
