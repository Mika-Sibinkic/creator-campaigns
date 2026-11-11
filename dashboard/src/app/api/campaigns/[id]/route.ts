// src/app/api/campaigns/[id]/route.ts
//
// USER PATH — post-Clerk, data access is via the service-role client (RLS-
// inert), so every query MUST filter by session.firm_id explicitly. Without it
// a firm-A user could GET or DELETE (cascade) firm-B's campaign. CASCADE deletes
// still apply for campaign_influencers, outreach_messages, deals, outcomes.
import { NextRequest, NextResponse } from "next/server";
import { requireSessionAndClient } from "@/lib/auth";
import { tieredLimit, rateLimited } from "@/lib/rate-limit";
import { deriveWindow, windowOffsets, windowPhaseAt } from "@/lib/campaign-window";
import {
  OUTREACH_LIMIT_COLUMN,
  normalizeOutreachLimit,
  readCampaignContacts,
} from "@/lib/first-touch-gate";

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

  const { data, error } = await sb
    .from("campaigns")
    .select("*")
    .eq("id", id)
    .eq("firm_id", session.firm_id)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }

  // The campaign window, derived here rather than on the client so
  // the page and the schedulers read the SAME definition. The offsets live in
  // firms.outreach_prefs, which the browser has no business fetching just to
  // render a date range. `campaign_window` is null when the campaign has no
  // release_date, which is exactly the "not time-boxed" case the UI renders.
  let campaign_window = null;
  const release_date = (data as { release_date?: string | null })?.release_date ?? null;
  if (release_date) {
    const { data: firm } = await sb
      .from("firms")
      .select("outreach_prefs")
      .eq("id", session.firm_id)
      .maybeSingle();
    const w = deriveWindow(
      release_date,
      windowOffsets((firm as { outreach_prefs?: unknown } | null)?.outreach_prefs),
    );
    if (w) {
      campaign_window = {
        start: w.start_iso,
        end: w.end_iso,
        lead_days: w.lead_days,
        tail_days: w.tail_days,
        phase: windowPhaseAt(w, Date.now()),
      };
    }
  }

  // Mini-run (migration 060): "Contacted X of N" on the campaign page, and
  // whether the limit column exists yet. select('*') returns the key only
  // post-060, so its presence IS the capability; the confirm page shows the
  // field only then. Same "contacted" definition as the send gate
  // (src/lib/first-touch-gate.ts). An unreadable count is null, never 0.
  const row = data as Record<string, unknown>;
  const outreach_limit_supported = Object.prototype.hasOwnProperty.call(row, OUTREACH_LIMIT_COLUMN);
  const contacts = await readCampaignContacts(sb, id);
  const outreach_progress = contacts.ok
    ? {
        contacted: contacts.contactedIds.size,
        limit: outreach_limit_supported ? normalizeOutreachLimit(row[OUTREACH_LIMIT_COLUMN]) : null,
      }
    : null;

  return NextResponse.json({ ...data, campaign_window, outreach_limit_supported, outreach_progress });
}

export async function DELETE(
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

  // CASCADE deletes handle campaign_influencers, outreach_messages, deals, outcomes
  const { error } = await sb
    .from("campaigns")
    .delete()
    .eq("id", id)
    .eq("firm_id", session.firm_id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
