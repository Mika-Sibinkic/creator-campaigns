// src/app/api/campaigns/route.ts
//
// SEC-1 refactor: USER PATH — RLS scopes campaigns to the caller's firm
// (via firm_members). The list returns only the firm's campaigns, and a
// new campaign is created with firm_id from the session (not body).
import { NextRequest, NextResponse } from "next/server";
import { requireSessionAndClient } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { isPlatformOperator } from "@/lib/operator";
import { tieredLimit, rateLimited } from "@/lib/rate-limit";
import { readJson } from "@/lib/validate";
import { CreateCampaignBody } from "@/lib/zod-schemas";
import { isMissingColumnError } from "@/lib/holding-note";
import { verifyCampaignArtist } from "@/lib/artist-lookup";

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }

  let sb, session;
  try {
    ({ sb, session } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }

  // Service-role client is RLS-inert post-Clerk — firm_id filter is the scope.
  //
  // Seeded sample rows (`synthetic = true`, written by
  // tools/seed-sample-analytics.mjs) are excluded for everyone but a platform
  // operator. Without that filter — which /api/dashboard and /api/analytics
  // have both had all along — three fabricated campaigns rendered on /campaigns
  // as real "Completed · $4,000" work. Operators keep seeing them: running a
  // seed and then checking it landed is how the system gets verified.
  const isOperator = isPlatformOperator(session.user.email);

  let q = sb
    .from("campaigns")
    .select("*")
    .eq("firm_id", session.firm_id)
    .order("created_at", { ascending: false });
  if (!isOperator) {
    q = q.eq("synthetic", false);
  }

  const { data, error } = await q;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Mark the sample rows explicitly. The list UI badges them off the
  // `artist_name` string starting with "[SAMPLE]", which is a naming
  // convention masquerading as a flag — rename one row and the badge vanishes
  // while the row stays fabricated. Badge off this column instead.
  const rows = ((data ?? []) as Array<Record<string, unknown>>).map((c) => ({
    ...c,
    synthetic: c.synthetic === true,
  }));

  return NextResponse.json(rows);
}

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

  const body = await readJson(req, CreateCampaignBody);
  if (body instanceof NextResponse) return body;

  // The artist is a confirmed Spotify identity, not a typed guess. The id is
  // re-resolved server-side and the stored snapshot is ours, not the client's.
  const artist = await verifyCampaignArtist(body);
  if (!artist.ok) {
    return NextResponse.json(
      { error: artist.error, message: artist.message },
      { status: artist.status }
    );
  }

  const { data, error } = await sb
    .from("campaigns")
    .insert({
      firm_id: session.firm_id,
      artist_name: body.artist_name,
      // Bug 13.8: the schema accepted track_name but the insert dropped it,
      // so drafting/contracts/qualify downstream always saw NULL.
      track_name: body.track_name || null,
      // MONEY — the columns the spend caps actually read.
      //
      // The create path used to write ONLY `budget` / `per_influencer_cap`,
      // while src/lib/spend-caps.ts reads `total_budget_usd` and the
      // negotiation ceiling reads `per_creator_cap_usd`. Those were written
      // nowhere but the confirm route, so every campaign created here was born
      // with NULL enforced caps and displayed a budget it could not enforce.
      // The enforced columns
      // are now the source of truth and are written at birth.
      total_budget_usd: body.budget,
      per_creator_cap_usd: body.per_influencer_cap,
      // DEPRECATED display mirror, written from the same input so the two
      // representations cannot drift. Several read-only surfaces still select
      // them (api/dashboard, campaigns list, analytics' legacy fallback), so
      // they stay populated until those are migrated — but nothing enforces
      // against them, and nothing should start. See migration 037.
      budget: body.budget,
      per_influencer_cap: body.per_influencer_cap,
      release_date: body.release_date || null,
      duration_days: body.duration_days || 30,
      urgency: body.urgency || "normal",
      target_platforms: body.target_platforms || ["tiktok", "instagram"],
      special_instructions: body.special_instructions || null,
      status: "draft",
      // Confirmed artist identity: artist_spotify_id (base schema),
      // artist_soundcharts_uuid + artist_confirmed_source (036), and the
      // display snapshot at artist_data.spotify. The Soundcharts UUID is
      // bridged server-side from the Spotify id; the baseline metric snapshot
      // is still captured at CONFIRM (the campaign's anchor point), not here.
      artist_spotify_id: artist.columns.artist_spotify_id,
      artist_data: artist.columns.artist_data,
      artist_confirmed_source: artist.columns.artist_confirmed_source,
      ...(artist.columns.artist_soundcharts_uuid
        ? { artist_soundcharts_uuid: artist.columns.artist_soundcharts_uuid }
        : {}),
      // Migration 060 — only when supplied; the form hides the field pre-060.
      ...(body.outreach_limit != null ? { outreach_limit: body.outreach_limit } : {}),
      // Migration 066 — only when switched on; the form hides it pre-066.
      ...(body.comment_audit_enabled === true ? { comment_audit_enabled: true } : {}),
    })
    .select()
    .single();

  if (error) {
    // A limit sent to a pre-060 database: refuse rather than create a campaign
    // silently missing the limit the user asked for.
    if (body.outreach_limit != null && isMissingColumnError(error)) {
      return NextResponse.json(
        {
          error: "outreach_limit_unavailable",
          message:
            "Max creators to contact isn't available yet. Clear that field to create the campaign without a limit.",
        },
        { status: 409 }
      );
    }
    if (body.comment_audit_enabled === true && isMissingColumnError(error)) {
      return NextResponse.json(
        {
          error: "comment_audit_unavailable",
          message:
            "Check comments isn't available yet. Switch it off to create the campaign.",
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await audit(
    {
      action: 'campaign.create',
      target_type: 'campaign',
      target_id: (data as { id: string }).id,
      firm_id: session.firm_id,
      metadata: {
        artist_name: body.artist_name,
        track_name: body.track_name ?? null,
        total_budget_usd: body.budget,
        per_creator_cap_usd: body.per_influencer_cap,
        urgency: body.urgency || 'normal',
        target_platforms: body.target_platforms || ['tiktok', 'instagram'],
        artist_confirmed: true,
        artist_spotify_id: artist.columns.artist_spotify_id,
        artist_soundcharts_uuid: artist.columns.artist_soundcharts_uuid,
        outreach_limit: body.outreach_limit ?? null,
        comment_audit_enabled: body.comment_audit_enabled === true,
      },
    },
    req
  );

  return NextResponse.json(data);
}
