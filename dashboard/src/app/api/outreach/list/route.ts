// src/app/api/outreach/list/route.ts
//
// USER PATH. Thin wrapper: auth + rate limit + response shaping. Every
// decision about WHICH ROWS this caller may see lives in
// src/lib/outreach-listing.ts, where it is executable-testable against an
// in-memory Supabase fake (tests/creator-scope.test.ts).
//
// The header here used to read "uses cookie-bound client. RLS scopes
// campaign_influencers + outreach_messages to the user's firm." Both halves
// were false, and the combination was the broadest cross-tenant leak in the
// app: `requireSessionAndClient()` returns the SERVICE-ROLE client
// (src/lib/auth.ts:155-161), and post-Clerk `auth.uid()` is NULL so every
// policy in migration 007 is inert. This route then selected
// campaign_influencers joined to `influencers(contact_email)` and
// `campaigns(artist_name, status)` with no firm predicate at all — any
// authenticated user of any label saw every other label's creators, their
// scraped contact emails, and which artists those labels were working.
import { NextRequest, NextResponse } from "next/server";
import { requireSessionAndClient } from "@/lib/auth";
import { listOutreachForFirm } from "@/lib/outreach-listing";
import { tieredLimit, rateLimited } from "@/lib/rate-limit";

export const runtime = 'nodejs';

// GET — list outreach messages with influencer + campaign data
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

  const { searchParams } = new URL(req.url);
  const result = await listOutreachForFirm(sb, session.firm_id, {
    campaign_id: searchParams.get("campaign_id"),
    status: searchParams.get("status"), // an /outreach TAB, mapped downstream
    search: searchParams.get("search"),
  });

  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.httpStatus });
  }
  return NextResponse.json(result.rows);
}
