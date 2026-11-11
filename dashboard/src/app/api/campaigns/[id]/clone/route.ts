// src/app/api/campaigns/[id]/clone/route.ts
//
// N12: Campaign clone. USER PATH — RLS scopes both the source-read and the
// insert to the caller's firm. Produces a clean-slate copy:
//   * artist_name        → '<source> (copy)' with a date suffix if a copy
//                          already exists for the same firm
//   * artist_spotify_id, artist_data, special_instructions, target_count,
//     duration_days, urgency, target_platforms, per_creator_cap_usd,
//     total_budget_usd  → copied verbatim
//   * release_date       → NULL (user re-picks)
//   * status             → 'draft'
//   * confirmed_at       → NULL (must be re-confirmed)
//   * pipeline_costs     → '{}'
//   * similar_artists    → '[]'
//   * ip_intelligence    → '{}'
//
// Does NOT clone discovery state — no campaign_influencers, outreach_messages,
// creator_offers, payment_authorizations, or campaign_outcomes. The clone is
// the seed of a fresh discovery pass; cloning history would invalidate every
// downstream gate (caps, dedupe, attribution).
//
// Returns { id: <newCampaignId> }. Caller navigates to /campaigns/<id>/confirm.
import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';

export const runtime = 'nodejs';

interface Ctx {
  params: Promise<{ id: string }>;
}

interface SourceCampaign {
  id: string;
  firm_id: string;
  artist_name: string;
  artist_spotify_id: string | null;
  artist_data: unknown;
  special_instructions: string | null;
  target_count: number | null;
  duration_days: number | null;
  urgency: string | null;
  target_platforms: string[] | null;
  per_creator_cap_usd: number | null;
  total_budget_usd: number | null;
  track_name: string | null;
}

export async function POST(req: NextRequest, ctx: Ctx) {
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
  const { id } = await ctx.params;

  // Load source under RLS — 404 if it isn't in the caller's firm.
  const { data: src, error: srcErr } = await sb
    .from('campaigns')
    .select(
      'id, firm_id, artist_name, artist_spotify_id, artist_data, special_instructions, target_count, duration_days, urgency, target_platforms, per_creator_cap_usd, total_budget_usd, track_name'
    )
    .eq('id', id)
    .single();
  if (srcErr || !src) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const source = src as unknown as SourceCampaign;

  // Build a new artist_name that doesn't collide with an existing copy in
  // the same firm. First try '<name> (copy)'; if that's taken, append today's
  // YYYY-MM-DD so back-to-back clones don't conflict either.
  const baseCopyName = `${source.artist_name} (copy)`;
  let candidate = baseCopyName;
  const { data: collide } = await sb
    .from('campaigns')
    .select('id, artist_name')
    .eq('firm_id', session.firm_id)
    .eq('artist_name', baseCopyName)
    .limit(1);
  if (collide && collide.length > 0) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    candidate = `${source.artist_name} (copy ${today})`;
    // Final safeguard: also dodge a same-day collision with a numeric suffix.
    const { data: collide2 } = await sb
      .from('campaigns')
      .select('id')
      .eq('firm_id', session.firm_id)
      .eq('artist_name', candidate)
      .limit(1);
    if (collide2 && collide2.length > 0) {
      candidate = `${source.artist_name} (copy ${today} ${Date.now().toString(36).slice(-4)})`;
    }
  }

  const insertRow = {
    firm_id: session.firm_id,
    artist_name: candidate,
    artist_spotify_id: source.artist_spotify_id,
    artist_data: source.artist_data ?? {},
    special_instructions: source.special_instructions,
    target_count: source.target_count,
    duration_days: source.duration_days ?? 30,
    urgency: source.urgency ?? 'normal',
    target_platforms: source.target_platforms ?? ['tiktok', 'instagram'],
    per_creator_cap_usd: source.per_creator_cap_usd,
    total_budget_usd: source.total_budget_usd,
    track_name: source.track_name,
    // Reset fields per spec
    release_date: null,
    status: 'draft',
    confirmed_at: null,
    pipeline_costs: {},
    similar_artists: [],
    ip_intelligence: {},
  };

  const { data: created, error: insErr } = await sb
    .from('campaigns')
    .insert(insertRow as never)
    .select('id')
    .single();
  if (insErr || !created) {
    return NextResponse.json({ error: insErr?.message ?? 'insert_failed' }, { status: 500 });
  }
  const newId = (created as { id: string }).id;

  await audit(
    {
      action: 'campaign.cloned',
      target_type: 'campaign',
      target_id: newId,
      firm_id: session.firm_id,
      metadata: {
        source_campaign_id: id,
        artist_name: candidate,
      },
    },
    req
  );

  return NextResponse.json({ id: newId });
}
