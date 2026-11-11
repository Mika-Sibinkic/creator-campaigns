// src/app/api/influencers/roster/route.ts
//
// GET /api/influencers/roster — the firm's "worked before" roster: every
// creator they have actually closed a deal with, ranked by how well those
// deals performed. All the math lives in src/lib/repeat-collaborators.ts
// (pure); this file only does the firm-scoped reads.
//
// ── Scoping: why an influencer_id filter would NOT be firm scoping ─────────
//
// `influencers` is a SHARED cross-firm pool with no firm_id column at all —
// migration 007 says so out loud ("creators are SHARED across firms"). And the
// Supabase client returned by requireSessionAndClient() is the SERVICE-ROLE
// client, which is RLS-inert post-Clerk. So filtering by influencer id proves
// nothing about who is allowed to see the deal history behind it.
//
// The scope boundary is the firm's own CAMPAIGNS, walked forwards:
//
//   campaigns (firm_id = caller's firm, synthetic dropped)
//     → campaign_influencers (campaign_id IN those)
//       → creator_offers (firm_id = caller's firm AND campaign_id IN those)
//         → deal_deliveries (firm_id = caller's firm)
//           → deal_performance_snapshots (firm_id = caller's firm)
//
// Every hop carries its own firm_id predicate where the column exists, and the
// campaign set bounds the ones where it does not. A creator another label
// worked with is unreachable because their offers hang off campaigns this
// query never selected.
//
// ── Fail closed, twice ────────────────────────────────────────────────────
//
//   1. Caller side, before any query: an authenticated-but-unprovisioned Clerk
//      user carries firm_id '' (src/lib/auth.ts), and '' must never scope a
//      read. checkFirmScope() refuses it.
//   2. Read side: ANY query error returns 500. A failed read is never
//      downgraded to an empty roster — telling a label "you have no repeat
//      collaborators" when the truth is "the query broke" is the one thing
//      this surface must never say. Same reasoning as the list page's
//      loadFailed branch.
//
// Query params:
//   limit  — max creators to return. 1..500, default 100.
//
// Response shape:
//   { collaborators: [...], returned: n, totals: {...},
//     excluded_synthetic_campaigns: n }
// `totals` covers the whole roster; `returned` is the size of this page.

import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { checkFirmScope, firmScopeErrorBody } from '@/lib/firm-scope';
import { CLOSED_STATUSES } from '@/lib/statuses';
import { readFirmBlocks } from '@/lib/firm-blocks';
import {
  buildRepeatCollaborators,
  type RosterCampaignRow,
  type RosterLinkRow,
  type RosterOfferRow,
  type RosterInfluencerRow,
  type RosterDeliveryRow,
  type RosterSnapshotRow,
  type RepeatCollaboratorsResult,
} from '@/lib/repeat-collaborators';

export const runtime = 'nodejs';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** An honest empty roster: zero creators, and nothing fabricated to fill it. */
const EMPTY: RepeatCollaboratorsResult = {
  collaborators: [],
  totals: { creators: 0, deals_closed: 0, total_spend_usd: 0, with_realized_cpm: 0 },
  excluded_synthetic_campaigns: 0,
  excluded_synthetic_offers: 0,
};

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

  // Caller-side half of the firm-scope predicate, run before anything is read.
  // A blank firm id is a denial, never a match — see src/lib/firm-scope.ts.
  const scope = checkFirmScope(session.firm_id, session.firm_id);
  if (!scope.ok) {
    return NextResponse.json(firmScopeErrorBody(scope), { status: scope.httpStatus });
  }
  const firmId = scope.firmId;

  const url = new URL(req.url);
  const rawLimit = url.searchParams.get('limit');
  let maxRows = rawLimit ? parseInt(rawLimit, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(maxRows) || maxRows <= 0) maxRows = DEFAULT_LIMIT;
  if (maxRows > MAX_LIMIT) maxRows = MAX_LIMIT;

  // ── 1. The firm's campaigns. This is the scope boundary. ──────────────────
  const { data: campaignData, error: campaignErr } = await sb
    .from('campaigns')
    .select('id, synthetic')
    .eq('firm_id', firmId);
  if (campaignErr) {
    return NextResponse.json({ error: campaignErr.message }, { status: 500 });
  }
  const campaigns = (campaignData ?? []) as RosterCampaignRow[];
  // Synthetic campaigns are excluded from the math inside the lib, but there
  // is no point fetching their children — and a firm with only [SAMPLE] data
  // has an empty real roster, which is the honest answer.
  const realCampaignIds = campaigns.filter((c) => c.synthetic !== true).map((c) => c.id);
  if (realCampaignIds.length === 0) {
    return NextResponse.json({
      ...EMPTY,
      excluded_synthetic_campaigns: campaigns.length - realCampaignIds.length,
    });
  }

  // ── 2. Closed offers under those campaigns ────────────────────────────────
  // Both predicates on purpose: firm_id is the row's own claim, campaign_id
  // is the boundary we proved above. Either alone would be weaker.
  const { data: offerData, error: offerErr } = await sb
    .from('creator_offers')
    .select(
      'id, campaign_id, campaign_influencer_id, status, agreed_amount_usd, current_offer_usd, approved_at, paid_at, posted_at, created_at'
    )
    .eq('firm_id', firmId)
    .in('campaign_id', realCampaignIds)
    .in('status', [...CLOSED_STATUSES]);
  if (offerErr) {
    return NextResponse.json({ error: offerErr.message }, { status: 500 });
  }
  const offers = (offerData ?? []) as RosterOfferRow[];
  if (offers.length === 0) {
    return NextResponse.json({
      ...EMPTY,
      excluded_synthetic_campaigns: campaigns.length - realCampaignIds.length,
    });
  }

  // ── 3. The campaign ↔ influencer links those offers hang off ──────────────
  const linkIds = Array.from(
    new Set(offers.map((o) => o.campaign_influencer_id).filter((v): v is string => !!v))
  );
  if (linkIds.length === 0) {
    return NextResponse.json({
      ...EMPTY,
      excluded_synthetic_campaigns: campaigns.length - realCampaignIds.length,
    });
  }
  const { data: linkData, error: linkErr } = await sb
    .from('campaign_influencers')
    .select('id, campaign_id, influencer_id')
    .in('id', linkIds)
    .in('campaign_id', realCampaignIds);
  if (linkErr) {
    return NextResponse.json({ error: linkErr.message }, { status: 500 });
  }
  const links = (linkData ?? []) as RosterLinkRow[];

  // ── 4. The creators themselves (shared table — reached only via §3) ───────
  //
  // Synthetic and blocklisted creators are dropped here, matching what the
  // influencers list page already hides. The drop is applied to the LINKS, not
  // after the math: an excluded creator's offers then have no path to an
  // influencer and never enter a count, a spend total or a CPM. Filtering the
  // output instead would leave their dollars in the firm totals.
  const influencerIds = Array.from(new Set(links.map((l) => l.influencer_id)));
  let influencers: RosterInfluencerRow[] = [];
  let scopedLinks: RosterLinkRow[] = [];
  if (influencerIds.length > 0) {
    const { data: infData, error: infErr } = await sb
      .from('influencers')
      .select('id, platform, username, display_name, follower_count, avatar_url, content_genres')
      .in('id', influencerIds)
      .eq('synthetic', false)
      .eq('blocklisted', false);
    if (infErr) {
      return NextResponse.json({ error: infErr.message }, { status: 500 });
    }
    // ...and creators THIS label has blocked (migration 056: a STOP to this
    // firm, or its Block). Display-only path, so an unreadable list degrades
    // to the global filter above rather than failing the page.
    const firmBlocks = await readFirmBlocks(sb, firmId, influencerIds);
    if (firmBlocks.state === 'unreadable') {
      console.error('[roster] firm block list unreadable — hiding global blocks only', firmBlocks.message);
    }
    influencers = ((infData ?? []) as RosterInfluencerRow[]).filter(
      (i) => !firmBlocks.ids.has(i.id)
    );
    const allowed = new Set(influencers.map((i) => i.id));
    scopedLinks = links.filter((l) => allowed.has(l.influencer_id));
  }

  // ── 5. Delivery records + their measured reach ────────────────────────────
  //
  // Both reads are chunked. PostgREST serialises `.in()` into the query string,
  // so a few hundred uuids becomes a multi-kilobyte GET URL that a proxy will
  // eventually refuse, and the row count is capped server-side by `db.max_rows`
  // (PostgREST default 1000) which `.limit()` can lower but never raise.
  //
  // The snapshot chunk is much smaller than the delivery chunk on purpose:
  // deliveries are ~1-3 per offer, but snapshots are a TIME SERIES — roughly
  // 13 rows per delivered post in year one. Unchunked, a firm past ~75-100
  // delivered posts would silently receive an arbitrary 1000-row subset,
  // `latestSnapshot` would pick the newest of that subset, and the CPM would
  // shift between two identical requests. 50 deliveries × ~13 keeps a chunk
  // well under the cap, and the descending `captured_at` order means that even
  // if one were ever truncated it is truncated from the OLD end, which is the
  // end `latestSnapshot` discards anyway. Same ordering as the sibling read in
  // campaigns/[id]/statuses.
  const OFFER_CHUNK = 200;
  const DELIVERY_CHUNK = 50;

  const offerIds = offers.map((o) => o.id);
  const deliveries: RosterDeliveryRow[] = [];
  for (let i = 0; i < offerIds.length; i += OFFER_CHUNK) {
    const { data, error } = await sb
      .from('deal_deliveries')
      .select('id, creator_offer_id, status, spec_check')
      .eq('firm_id', firmId)
      .in('creator_offer_id', offerIds.slice(i, i + OFFER_CHUNK));
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    deliveries.push(...((data ?? []) as RosterDeliveryRow[]));
  }

  const deliveryIds = deliveries.map((d) => d.id);
  const snapshots: RosterSnapshotRow[] = [];
  for (let i = 0; i < deliveryIds.length; i += DELIVERY_CHUNK) {
    const { data, error } = await sb
      .from('deal_performance_snapshots')
      .select('deal_delivery_id, captured_at, views')
      .eq('firm_id', firmId)
      .in('deal_delivery_id', deliveryIds.slice(i, i + DELIVERY_CHUNK))
      .order('captured_at', { ascending: false });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    snapshots.push(...((data ?? []) as RosterSnapshotRow[]));
  }

  // ── 6. Pure math ──────────────────────────────────────────────────────────
  const result = buildRepeatCollaborators({
    campaigns,
    links: scopedLinks,
    offers,
    influencers,
    deliveries,
    snapshots,
  });

  // `totals` describes the WHOLE roster, not just the page returned — so a
  // `limit` can never make a firm's spend or deal count look smaller than it
  // is. `returned` is the page size, kept separate so the two can't be
  // mistaken for each other.
  //
  // The envelope is built field by field rather than spread, because
  // `result.excluded_synthetic_offers` is deliberately NOT published here: §2
  // already restricts the offer query to real campaigns, so the lib's counter
  // can only increment on rows this route never fetched and would always
  // report 0 over HTTP. A structural 0 reads as "we checked and found none",
  // which is a claim this route cannot make. The lib still returns it for
  // direct callers that pass unfiltered offers (the test suite does).
  const page = result.collaborators.slice(0, maxRows);
  return NextResponse.json({
    collaborators: page,
    returned: page.length,
    totals: result.totals,
    excluded_synthetic_campaigns: result.excluded_synthetic_campaigns,
  });
}
