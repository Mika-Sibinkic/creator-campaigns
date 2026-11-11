// src/app/api/influencers/route.ts
//
// USER PATH.
//
// Tenancy: `requireSessionAndClient()` returns the SERVICE-ROLE client, so RLS
// never evaluates here. The synthetic filter below is the only guard keeping
// sample rows out (tests/synthetic-quarantine.test.ts).
//
// `influencers` IS deliberately shared across firms — a creator is one
// person, and two labels discovering the same TikToker should converge on one
// row. But this endpoint is also the ENUMERATION source: `select("*")` over
// every real creator, 100 at a time. Sharing a public handle is fine; shipping
// one firm's scraped contact_email and payout account id to a competing label
// is not. Rows this firm has no relationship with now come back with those
// fields nulled (src/lib/creator-scope.ts).
import { NextRequest, NextResponse } from "next/server";
import { requireSessionAndClient } from "@/lib/auth";
import {
  firmRelatedInfluencerIds,
  redactUnrelatedCreator,
} from "@/lib/creator-scope";
import { tieredLimit, rateLimited } from "@/lib/rate-limit";
import { readFirmBlocks } from "@/lib/firm-blocks";

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

  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search") || "";
  const platform = searchParams.get("platform") || "";
  const sort = searchParams.get("sort") || "follower_count";
  const order = searchParams.get("order") || "desc";
  const blocklisted = searchParams.get("blocklisted");

  // Quarantine: never expose synthetic=true rows to user-facing API consumers.
  // Set by migration 004 (A4). This filter is the only guard: the route uses the
  // service-role client, and the anon-key RLS policy was removed.
  let query = sb
    .from("influencers")
    .select("*")
    .eq("synthetic", false)
    .order(sort, { ascending: order === "asc" });

  if (search) {
    query = query.or(`username.ilike.%${search}%,display_name.ilike.%${search}%`);
  }

  if (platform) {
    query = query.eq("platform", platform);
  }

  if (blocklisted === "true") {
    query = query.eq("blocklisted", true);
  } else if (blocklisted === "false") {
    query = query.eq("blocklisted", false);
  }

  const { data, error } = await query.limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // THIS label's blocks (migration 056) for the page just read. `firm_blocked`
  // rides on every row; `blocklisted=false` — what /influencers asks for —
  // also drops them, so "removed from your creator list" is true for the label
  // that blocked and for nobody else. `blocklisted=true` still filters on the
  // global column only (no caller uses it). Display path: an unreadable list
  // degrades to the global filter rather than failing the page.
  const pageIds = (data ?? []).map((row) => (row as { id: string }).id);
  const firmBlocks = await readFirmBlocks(sb, session.firm_id, pageIds);
  if (firmBlocks.state === "unreadable") {
    console.error("[influencers] firm block list unreadable — hiding global blocks only", firmBlocks.message);
  }
  const rows = (data ?? [])
    .map((row): Record<string, unknown> & { id: string; firm_blocked: boolean } => ({
      ...(row as Record<string, unknown>),
      id: (row as { id: string }).id,
      firm_blocked: firmBlocks.ids.has((row as { id: string }).id),
    }))
    .filter((row) => !(blocklisted === "false" && row.firm_blocked));

  // Redact scraped contact detail on creators this firm has never worked.
  // Resolved once for the whole page, not per row.
  const relatedIds = await firmRelatedInfluencerIds(sb, session.firm_id);
  const visible = rows.map((row) => redactUnrelatedCreator(row, relatedIds));

  return NextResponse.json(visible);
}
