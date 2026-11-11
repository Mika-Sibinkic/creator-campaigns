// src/app/api/campaigns/[id]/deals/route.ts
//
// USER PATH — funnel-state aggregate for the /campaigns/[id]/deals page.
//
// Returns one row per campaign_influencer that has progressed past
// "draft sitting in a bucket" — i.e. has either at least one outbound
// outreach_messages row with status='sent' OR an outreach_status of
// sent/responded/negotiating/draft_ready.
//
// PostgREST embedded-resource filtering across four optional joins is
// brittle, so we fetch each table independently (RLS-scoped on every
// query via the user-bound supabase client) and merge in JS. For an
// single campaign of ≤200 creators this is comfortably cheaper
// than fighting the embedded-filter grammar.

import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { approvalQueueGap, groupLegsByOffer, type DealPaymentLeg, type RawLegRow } from '@/lib/payment-legs';
import {
  describeDeliverables,
  normalizeDeliverables,
  type Deliverable,
} from '@/lib/deliverables';
import { readDoNotContactFlags } from '@/lib/firm-blocks';
import { readLastSentOffers } from '@/lib/last-sent-offer';
import type { DoNotContactDisplay } from '@/lib/do-not-contact-copy';

export const runtime = 'nodejs';

// ─── shape returned to the client ───────────────────────────────────────
interface DealInfluencer {
  // id surfaces to the deals UI so DealRow can PATCH /api/influencers/[id]
  // when a tester backfills a contact_email inline.
  id: string;
  username: string;
  display_name: string | null;
  follower_count: number | null;
  contact_email: string | null;
  profile_url: string | null;
}

interface DealLatestMessage {
  id: string;
  status: string | null;
  sent_at: string | null;
  body: string;
}

interface DealOutcome {
  streams_attributed: number | null;
  attribution_method: string | null;
  measured_at: string | null;
  // At-post snapshots — echoed so the re-measure form can pre-fill.
  follower_count_at_post: number | null;
  engagement_at_post: number | null;
}

// Migration 036 — delivery verification surfaced next to the post URL.
// status = existence (pending/verified/missing); spec_check = does the found
// post match the agreed deliverables (pass/fail/partial, detail = why).
interface DealDelivery {
  status: string;
  spec_check: string | null;
  spec_check_detail: string | null;
}

interface DealOffer {
  id: string;
  status: string;
  initial_offer_usd: number | null;
  current_offer_usd: number | null;
  agreed_amount_usd: number | null;
  /** The last price the creator was actually SENT (last-sent-offer.ts), null
   *  when it cannot be known. Display only. */
  last_sent_offer_usd: number | null;
  /** creator_offers.autonomy_mode; 'human' = a person has taken the
   *  negotiation over (takeover-state.ts). */
  autonomy_mode: string | null;
  ceiling_usd: number;
  rounds: number;
  post_url: string | null;
  posted_at: string | null;
  paid_at: string | null;
  payout_status: string | null;
  // Every settlement leg (migration 055: deposit + balance, or one full),
  // ordered deposit → full → balance. Each has its own human approval, so each
  // is shown and acted on separately. Empty until a payment is set up.
  payment_authorizations: DealPaymentLeg[];
  /** The deal is waiting on a payment that does not exist (a failed mint):
   *  'first' | 'balance' | null. See payment-legs.approvalQueueGap. */
  approval_gap: 'first' | 'balance' | null;
  /** Set only when approval_gap is null because a PERSON stopped the leg
   *  (reject / revoke / cancel, no transfer on file): the gap an explicit
   *  "Re-create stopped payment" would fill. Never offered automatically. */
  reopenable_gap: 'first' | 'balance' | null;
  outcome: DealOutcome | null;
  delivery: DealDelivery | null;
  // What the money actually buys. A deals row that shows an amount and no
  // deliverables is a price with no product attached — the operator approves
  // spend without a statement of what was promised. Empty array = the offer
  // predates the agreement-time freeze (nothing is invented to fill the gap).
  deliverables: Deliverable[];
  /** Same package as one label-readable line, e.g. "1 30-second reel and
   *  1 15-second story within 2 weeks". '' when there is nothing to state. */
  deliverables_text: string;
  /** Whether a filled contract was frozen and delivered for this deal. */
  contract_sent: boolean;
}

interface DealRow {
  campaign_influencer_id: string;
  outreach_status: string | null;
  tier: string | null;
  // Highest-converting-channel recommendation from contact-discovery, stamped
  // onto campaign_influencers.primary_channel by the run pipeline.
  best_channel: string | null;
  channel_confidence: number | null;
  influencer: DealInfluencer;
  latest_message: DealLatestMessage | null;
  offer: DealOffer | null;
  /** The creator is on this label's do-not-contact list (opted out / blocked),
   *  or 'unknown' when the list could not be read. Null when clear. Display
   *  only: the row says so before anyone pays. */
  do_not_contact: DoNotContactDisplay | null;
}

// outreach_status values that mean "this creator is in the funnel."
const FUNNEL_STATUSES = new Set([
  'sent',
  'responded',
  'negotiating',
  'draft_ready',
]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  const { id: campaignId } = await params;

  let sb, session;
  try {
    ({ sb, session } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }

  // 1. Campaign header — firm ownership GATE for the whole route. Post-Clerk the
  //    client is service-role (RLS-inert), so filtering by session.firm_id here
  //    is what stops a firm-A user reading firm-B's deals/offers/payments (every
  //    query below keys off this campaignId). Not the firm's campaign → 404.
  const { data: campaignRow, error: cErr } = await sb
    .from('campaigns')
    .select('id, artist_name, status, track_name')
    .eq('id', campaignId)
    .eq('firm_id', session.firm_id)
    .single();
  if (cErr || !campaignRow) {
    return NextResponse.json({ error: 'campaign_not_found' }, { status: 404 });
  }

  // 2. All campaign_influencers for this campaign (+ joined influencer profile).
  const { data: ciRows, error: ciErr } = await sb
    .from('campaign_influencers')
    .select(
      `id, outreach_status, tier, influencer_id, primary_channel, channel_confidence,
       influencer:influencers(id, username, display_name, follower_count, contact_email, profile_url)`
    )
    .eq('campaign_id', campaignId);
  if (ciErr) {
    return NextResponse.json({ error: ciErr.message }, { status: 500 });
  }
  type CIRow = {
    id: string;
    outreach_status: string | null;
    tier: string | null;
    influencer_id: string;
    primary_channel: string | null;
    channel_confidence: number | null;
    influencer: DealInfluencer | DealInfluencer[] | null;
  };
  const cis = (ciRows ?? []) as unknown as CIRow[];
  if (cis.length === 0) {
    return NextResponse.json({ campaign: campaignRow, deals: [] });
  }
  const ciIds = cis.map((r) => r.id);

  // 3. Latest outbound 'sent' message per CI (we'll dedupe in JS).
  const { data: msgRows, error: mErr } = await sb
    .from('outreach_messages')
    .select('id, campaign_influencer_id, direction, status, sent_at, body, created_at')
    .in('campaign_influencer_id', ciIds)
    .eq('direction', 'outbound')
    .order('created_at', { ascending: false });
  if (mErr) {
    return NextResponse.json({ error: mErr.message }, { status: 500 });
  }
  type MsgRow = {
    id: string;
    campaign_influencer_id: string;
    direction: string;
    status: string | null;
    sent_at: string | null;
    body: string;
    created_at: string;
  };
  const msgs = (msgRows ?? []) as MsgRow[];

  // Most-recent outbound message per CI (regardless of status) and a
  // set of CIs that have at least one outbound *sent* row.
  const latestMsgByCi = new Map<string, MsgRow>();
  const sentCiIds = new Set<string>();
  for (const m of msgs) {
    if (!latestMsgByCi.has(m.campaign_influencer_id)) {
      latestMsgByCi.set(m.campaign_influencer_id, m);
    }
    if (m.status === 'sent') {
      sentCiIds.add(m.campaign_influencer_id);
    }
  }

  // 4. Offers, payment authorizations, and outcomes — fetched by ci_id /
  //    offer_id so RLS firm-scopes naturally.
  const { data: offerRows, error: oErr } = await sb
    .from('creator_offers')
    .select(
      `id, campaign_influencer_id, campaign_id, firm_id, status,
       initial_offer_usd, current_offer_usd, agreed_amount_usd, ceiling_usd,
       rounds, post_url, posted_at, paid_at, payout_status,
       deposit_paid_usd, balance_paid_usd,
       agreed_deliverables, contract_generated_at, autonomy_mode`
    )
    .in('campaign_influencer_id', ciIds);
  if (oErr) {
    return NextResponse.json({ error: oErr.message }, { status: 500 });
  }
  type OfferRow = {
    id: string;
    campaign_influencer_id: string;
    campaign_id: string;
    firm_id: string;
    status: string;
    initial_offer_usd: number | null;
    current_offer_usd: number | null;
    agreed_amount_usd: number | null;
    ceiling_usd: number;
    rounds: number;
    post_url: string | null;
    posted_at: string | null;
    paid_at: string | null;
    payout_status: string | null;
    agreed_deliverables: unknown;
    contract_generated_at: string | null;
    autonomy_mode: string | null;
  };
  const offers = (offerRows ?? []) as OfferRow[];
  const offerIds = offers.map((o) => o.id);
  const offerByCi = new Map<string, OfferRow>();
  for (const o of offers) offerByCi.set(o.campaign_influencer_id, o);
  // Display only: the last price each creator was actually sent. A failed
  // read is an empty map (the row just shows nothing extra).
  const lastSentByCi = await readLastSentOffers(sb, offers);

  // 5. Payment authorizations keyed by creator_offer_id — EVERY leg. This was
  //    `new Map(rows.map(p => [p.creator_offer_id, p]))`, which kept whichever
  //    leg PostgREST returned last (no ORDER BY) and silently dropped the other.
  //    payment_provider_id + human_approved_at ride along because the retry
  //    rule (payment-claim.retryRefusal) needs them to decide the Retry button.
  let payByOffer = new Map<string, DealPaymentLeg[]>();
  if (offerIds.length > 0) {
    const selectLegs = (withLeg: boolean) =>
      sb
        .from('payment_authorizations')
        .select(
          `id, creator_offer_id,${withLeg ? ' leg,' : ''} status, amount_usd, failure_reason, payment_mode, payment_provider_id, human_approved_at`
        )
        .in('creator_offer_id', offerIds);
    // Same degrade as authorize-payment.ts: on a query ERROR retry the pre-055
    // shape; a row with no leg is a 'full' leg.
    let { data: payRows, error: pErr } = await selectLegs(true);
    if (pErr) {
      console.warn('[deals] leg-aware select failed; retrying pre-055 shape:', pErr.message);
      ({ data: payRows, error: pErr } = await selectLegs(false));
    }
    if (pErr) {
      return NextResponse.json({ error: pErr.message }, { status: 500 });
    }
    payByOffer = groupLegsByOffer((payRows ?? []) as unknown as RawLegRow[]);
  }

  // 5b. Delivery verification keyed by creator_offer_id (migration 036).
  //     Non-fatal on error so the deals page keeps working if the spec_check
  //     columns aren't applied yet — the badge just doesn't render.
  let deliveryByOffer = new Map<string, DealDelivery>();
  if (offerIds.length > 0) {
    const { data: delRows } = await sb
      .from('deal_deliveries')
      .select('creator_offer_id, status, spec_check, spec_check_detail')
      .in('creator_offer_id', offerIds);
    type DelRow = {
      creator_offer_id: string;
      status: string;
      spec_check: string | null;
      spec_check_detail: string | null;
    };
    deliveryByOffer = new Map(
      ((delRows ?? []) as DelRow[]).map((r) => [
        r.creator_offer_id,
        {
          status: r.status,
          spec_check: r.spec_check ?? null,
          spec_check_detail: r.spec_check_detail ?? null,
        },
      ])
    );
  }

  // 6. Outcomes keyed by creator_offer_id.
  let outcomeByOffer = new Map<string, DealOutcome>();
  if (offerIds.length > 0) {
    const { data: ocRows, error: ocErr } = await sb
      .from('campaign_outcomes')
      .select(
        'creator_offer_id, streams_attributed, streams_attribution_method, measured_at, follower_count_at_post, engagement_at_post'
      )
      .in('creator_offer_id', offerIds);
    if (ocErr) {
      return NextResponse.json({ error: ocErr.message }, { status: 500 });
    }
    type OutcomeRow = {
      creator_offer_id: string;
      streams_attributed: number | null;
      streams_attribution_method: string | null;
      measured_at: string | null;
      follower_count_at_post: number | null;
      engagement_at_post: number | null;
    };
    outcomeByOffer = new Map(
      ((ocRows ?? []) as OutcomeRow[]).map((o) => [
        o.creator_offer_id,
        {
          streams_attributed:
            o.streams_attributed != null ? Number(o.streams_attributed) : null,
          attribution_method: o.streams_attribution_method,
          measured_at: o.measured_at,
          follower_count_at_post:
            o.follower_count_at_post != null
              ? Number(o.follower_count_at_post)
              : null,
          engagement_at_post:
            o.engagement_at_post != null ? Number(o.engagement_at_post) : null,
        },
      ])
    );
  }

  // 6b. Do-not-contact, read the way every send path reads it. Display only.
  const dnc = await readDoNotContactFlags(sb, session.firm_id, cis.map((c) => c.influencer_id));

  // 7. Merge — only emit CIs that have crossed the funnel threshold.
  const deals: DealRow[] = [];
  for (const ci of cis) {
    const inFunnelByStatus =
      ci.outreach_status != null && FUNNEL_STATUSES.has(ci.outreach_status);
    const inFunnelByMessage = sentCiIds.has(ci.id);
    if (!inFunnelByStatus && !inFunnelByMessage) continue;

    // PostgREST returns the embedded one-to-one join as an object, but
    // older clients sometimes typed it as array — normalize defensively.
    const inf = Array.isArray(ci.influencer)
      ? (ci.influencer[0] ?? null)
      : ci.influencer;
    if (!inf) continue;

    const latestMsgRow = latestMsgByCi.get(ci.id);
    const latest_message: DealLatestMessage | null = latestMsgRow
      ? {
          id: latestMsgRow.id,
          status: latestMsgRow.status,
          sent_at: latestMsgRow.sent_at,
          body: latestMsgRow.body,
        }
      : null;

    const offerRow = offerByCi.get(ci.id);
    const deliverables = offerRow ? normalizeDeliverables(offerRow.agreed_deliverables) : [];
    const offer: DealOffer | null = offerRow
      ? {
          id: offerRow.id,
          status: offerRow.status,
          initial_offer_usd:
            offerRow.initial_offer_usd != null
              ? Number(offerRow.initial_offer_usd)
              : null,
          current_offer_usd:
            offerRow.current_offer_usd != null
              ? Number(offerRow.current_offer_usd)
              : null,
          agreed_amount_usd:
            offerRow.agreed_amount_usd != null
              ? Number(offerRow.agreed_amount_usd)
              : null,
          last_sent_offer_usd: lastSentByCi.get(offerRow.campaign_influencer_id) ?? null,
          autonomy_mode: offerRow.autonomy_mode ?? null,
          ceiling_usd: Number(offerRow.ceiling_usd),
          rounds: offerRow.rounds,
          post_url: offerRow.post_url,
          posted_at: offerRow.posted_at,
          paid_at: offerRow.paid_at,
          payout_status: offerRow.payout_status ?? null,
          payment_authorizations: payByOffer.get(offerRow.id) ?? [],
          ...(() => {
            const gapOffer = {
              status: offerRow.status,
              deposit_paid_usd: (offerRow as { deposit_paid_usd?: number | null }).deposit_paid_usd ?? null,
              balance_paid_usd: (offerRow as { balance_paid_usd?: number | null }).balance_paid_usd ?? null,
            };
            const legs = payByOffer.get(offerRow.id) ?? [];
            const approval_gap = approvalQueueGap(gapOffer, legs);
            return {
              approval_gap,
              reopenable_gap: approval_gap ? null : approvalQueueGap(gapOffer, legs, { reopenStopped: true }),
            };
          })(),
          outcome: outcomeByOffer.get(offerRow.id) ?? null,
          delivery: deliveryByOffer.get(offerRow.id) ?? null,
          deliverables,
          deliverables_text: describeDeliverables(deliverables),
          contract_sent: offerRow.contract_generated_at != null,
        }
      : null;

    deals.push({
      campaign_influencer_id: ci.id,
      outreach_status: ci.outreach_status,
      tier: ci.tier,
      best_channel: ci.primary_channel,
      channel_confidence:
        ci.channel_confidence != null ? Number(ci.channel_confidence) : null,
      influencer: inf,
      latest_message,
      offer,
      do_not_contact:
        dnc.flags.get(ci.influencer_id) ?? (dnc.state === 'unreadable' ? 'unknown' : null),
    });
  }

  // Stable, useful ordering: rows with an offer first (most-progressed
  // status wins), then by latest message recency for the rest.
  const STATUS_ORDER: Record<string, number> = {
    measured: 0,
    posted: 1,
    paid: 2,
    approved: 3,
    human_approval_required: 4,
    agreed: 5,
    counter_offered: 6,
    offered: 7,
    queued: 8,
    rejected: 98,
    failed: 99,
  };
  deals.sort((a, b) => {
    const aOrder = a.offer ? (STATUS_ORDER[a.offer.status] ?? 50) : 100;
    const bOrder = b.offer ? (STATUS_ORDER[b.offer.status] ?? 50) : 100;
    if (aOrder !== bOrder) return aOrder - bOrder;
    const aSent = a.latest_message?.sent_at ?? '';
    const bSent = b.latest_message?.sent_at ?? '';
    return bSent.localeCompare(aSent);
  });

  return NextResponse.json({ campaign: campaignRow, deals });
}
