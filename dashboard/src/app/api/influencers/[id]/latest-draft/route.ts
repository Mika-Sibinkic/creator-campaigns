// src/app/api/influencers/[id]/latest-draft/route.ts
//
// SEC-1 refactor: USER PATH — uses cookie-bound client. RLS limits the
// campaign_influencers + outreach_messages reads to the user's firm,
// so the "latest draft" is naturally only the latest draft this firm
// has generated for this creator (not another firm's drafts).
import { NextRequest, NextResponse } from "next/server";
import { requireSessionAndClient } from "@/lib/auth";
import { tieredLimit, rateLimited } from "@/lib/rate-limit";

export const runtime = 'nodejs';

/**
 * GET /api/influencers/[id]/latest-draft
 *
 * F5: Returns the most-recent outreach_messages row whose campaign_influencer
 * row is linked to this influencer (across any of the user's firm's campaigns).
 *
 * Returns:
 *   - 200 { message: null } when no draft exists yet
 *   - 200 { message: { id, subject, body, status, sent_at, created_at, campaign: { id, artist_name } } } when found
 *   - 500 on unexpected DB error
 */
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

  // Influencers are a shared global pool, so scope the CI lookup to THIS firm's
  // campaigns (via the campaign→firm_id inner join). Without it, when two firms
  // target the same creator, one could read the other's draft. Service-role
  // client is RLS-inert post-Clerk, so this filter is the authorization boundary.
  const { data: cis, error: ciErr } = await sb
    .from("campaign_influencers")
    .select("id, campaign_id, campaigns!inner(firm_id)")
    .eq("influencer_id", id)
    .eq("campaigns.firm_id", session.firm_id);

  if (ciErr) {
    return NextResponse.json({ error: ciErr.message }, { status: 500 });
  }

  const ciIds = (cis ?? []).map((c) => c.id as string);
  if (ciIds.length === 0) {
    return NextResponse.json({ message: null });
  }

  const { data: msgs, error: msgErr } = await sb
    .from("outreach_messages")
    .select(
      "id, campaign_influencer_id, subject, body, status, sent_at, created_at, generation_model, edited_by_user"
    )
    .in("campaign_influencer_id", ciIds)
    .order("created_at", { ascending: false })
    .limit(1);

  if (msgErr) {
    return NextResponse.json({ error: msgErr.message }, { status: 500 });
  }

  const msg = msgs?.[0];
  if (!msg) {
    return NextResponse.json({ message: null });
  }

  const matchedCi = (cis ?? []).find(
    (c) => (c.id as string) === (msg.campaign_influencer_id as string)
  );
  let campaign: { id: string; artist_name: string | null } | null = null;
  if (matchedCi?.campaign_id) {
    const { data: camp } = await sb
      .from("campaigns")
      .select("id, artist_name")
      .eq("id", matchedCi.campaign_id as string)
      .single();
    if (camp) {
      campaign = {
        id: camp.id as string,
        artist_name: (camp.artist_name as string | null) ?? null,
      };
    }
  }

  return NextResponse.json({
    message: {
      id: msg.id,
      campaign_influencer_id: msg.campaign_influencer_id,
      subject: msg.subject,
      body: msg.body,
      status: msg.status,
      sent_at: msg.sent_at,
      created_at: msg.created_at,
      generation_model: msg.generation_model,
      edited_by_user: msg.edited_by_user,
      campaign,
    },
  });
}
