// src/app/api/campaigns/[id]/influencers/route.ts
//
// SEC-1 refactor: USER PATH — RLS scopes campaign_influencers via the
// campaign → firm chain. Synthetic-row quarantine still applies to the
// influencers JOIN (the synthetic=false RLS policy on influencers + the
// explicit two-step pattern below).
import { NextRequest, NextResponse } from "next/server";
import { requireSessionAndClient } from "@/lib/auth";
import { tieredLimit, rateLimited } from "@/lib/rate-limit";
import { attachCommentAudits } from "@/lib/comment-audit-store";

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  const { id } = await params;
  let sb, session;
  try {
    ({ sb, session } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }

  // Firm ownership gate — the service-role client is RLS-inert post-Clerk, so
  // verify the campaign belongs to the caller's firm before listing its creators.
  const { data: own } = await sb
    .from("campaigns")
    .select("id")
    .eq("id", id)
    .eq("firm_id", session.firm_id)
    .maybeSingle();
  if (!own) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Quarantine: exclude synthetic=true influencers from this user-facing query.
  // Two-step pattern (see plan task A5): first fetch real influencer IDs,
  // then return only join rows whose influencer is in that real set. This
  // avoids Postgrest embedded-resource filter ambiguity (it would filter
  // the embed but still return the parent row with a null `influencer`).
  const { data: realInfluencers, error: infErr } = await sb
    .from("influencers")
    .select("id")
    .eq("synthetic", false);

  if (infErr) {
    return NextResponse.json({ error: infErr.message }, { status: 500 });
  }

  const realIds = (realInfluencers ?? []).map((r) => r.id);

  if (realIds.length === 0) {
    return NextResponse.json([]);
  }

  const { data, error } = await sb
    .from("campaign_influencers")
    .select(`
      *,
      influencer:influencers(*)
    `)
    .eq("campaign_id", id)
    .in("influencer_id", realIds)
    .order("composite_score", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Comment-quality audit summary for the creator card (migration 066).
  // Rows without one, and every row pre-066, are returned unchanged.
  const rows = await attachCommentAudits(
    sb,
    (data ?? []) as Array<Record<string, unknown>>
  );
  return NextResponse.json(rows);
}
