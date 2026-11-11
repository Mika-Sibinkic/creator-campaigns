// src/app/api/anomalies/route.ts
//
// USER PATH — statuses dashboard, firm-wide half. One read-only
// rollup of everything that needs human eyes:
//
//   injection-flagged offers · flagged inbound replies · fishy-reply lane
//   (audit actions) · failed payment authorizations (incl. cap refusals) ·
//   deliveries failing the spec check · negotiations stalled >7 days ·
//   unmatched inbound (campaign_influencer_id NULL) · money-path anomalies
//   (payment_anomaly: cap refusals after onboarding, reclaimed or stuck
//   'executing' claims, webhook transfer failures, bank payout failures).
//
// Detection rules live in src/lib/statuses.ts (pure, hermetically tested);
// this file queries and firm-gates. Post-Clerk the client is service-role
// (RLS-inert): firm-owned tables filter .eq('firm_id', ...) directly;
// inbound_messages has NO firm column, so its rows are admitted only when
// they resolve to this firm through their campaign_influencer → campaign or
// creator_offer linkage. Fully-unlinked unmatched replies (no CI, no offer)
// have no firm owner at all — they are shown to every firm as
// "unattributed" so orphaned replies are never invisible to everyone.
// Revisit before true multi-tenant.
// Read-only: no audit writes.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSessionAndClient } from '@/lib/auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import {
  detectAnomalies,
  BANK_PAYOUT_FAILED_ACTION,
  ESCALATION_AUDIT_ACTIONS,
  FISHY_AUDIT_ACTIONS,
  MONEY_ANOMALY_AUDIT_ACTIONS,
  PAYMENT_MINT_FAILED_ACTIONS,
  PROMO_HELD_ACTION,
  PROMO_WITHHELD_ACTION,
  RECONCILE_FLAG_ACTIONS,
  RESOLUTION_AUDIT_ACTIONS,
  resolvedFromAudit,
  type AnomalyBouncedRow,
  type AnomalyExecutingRow,
  type AnomalyInboundRow,
  type AnomalyOfferRow,
  type AnomalyTickInput,
  type ThreadAuditRow,
} from '@/lib/statuses';

export const runtime = 'nodejs';

// Bounded fetch sizes — this is a "needs eyes now" surface, not an archive.
const AnomaliesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function GET(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }

  const parsed = AnomaliesQuery.safeParse(
    Object.fromEntries(req.nextUrl.searchParams)
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_failed', issues: z.treeifyError(parsed.error) },
      { status: 422 }
    );
  }
  const fetchLimit = parsed.data.limit;

  let sb, session;
  try {
    ({ sb, session } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }
  const firmId = session.firm_id;

  // 1. Firm campaigns — names for display + the CI→firm membership check.
  const { data: campaignRows, error: cErr } = await sb
    .from('campaigns')
    .select('id, artist_name')
    .eq('firm_id', firmId);
  if (cErr) {
    return NextResponse.json({ error: cErr.message }, { status: 500 });
  }
  const campaigns = (campaignRows ?? []) as { id: string; artist_name: string }[];
  const firmCampaignIds = new Set(campaigns.map((c) => c.id));

  // 2. Firm offers — source for injection + stall detection, and the join
  //    key for fishy/payment/delivery attribution.
  const { data: offerRows, error: oErr } = await sb
    .from('creator_offers')
    .select(
      'id, campaign_influencer_id, campaign_id, status, injection_flagged, updated_at, current_offer_usd, contract_generated_at'
    )
    .eq('firm_id', firmId);
  if (oErr) {
    return NextResponse.json({ error: oErr.message }, { status: 500 });
  }
  const offers = (offerRows ?? []) as AnomalyOfferRow[];
  const offerIdSet = new Set(offers.map((o) => o.id));

  // 2b. Does this firm have a contract template at all? Decides which fix the
  //     contract_missing rows tell the operator to make. Non-fatal: a lookup
  //     failure degrades to "no template", the more common state.
  const { data: tplRow } = await sb
    .from('contract_templates')
    .select('id')
    .eq('firm_id', firmId)
    .maybeSingle();
  const hasContractTemplate = tplRow != null;

  // 3. Failed payment authorizations (cap refusals land here too, via
  //    failure_reason — see spend-caps.CAP_FAILURE_REASON).
  const { data: payRows, error: pErr } = await sb
    .from('payment_authorizations')
    .select(
      'id, creator_offer_id, campaign_id, status, failure_reason, amount_usd, created_at, executed_at'
    )
    .eq('firm_id', firmId)
    .eq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(fetchLimit);
  if (pErr) {
    return NextResponse.json({ error: pErr.message }, { status: 500 });
  }

  // 4. Deliveries that failed the agreed-spec check.
  const { data: delRows, error: dErr } = await sb
    .from('deal_deliveries')
    .select('id, creator_offer_id, spec_check, spec_check_detail, detected_at, created_at')
    .eq('firm_id', firmId)
    .eq('spec_check', 'fail')
    .order('created_at', { ascending: false })
    .limit(fetchLimit);
  if (dErr) {
    return NextResponse.json({ error: dErr.message }, { status: 500 });
  }

  // 5. Fishy-reply lane + the needs-a-decision lane — both
  //    are audit actions, and audit rows carry firm_id directly. One query,
  //    two categories; detectAnomalies splits them by action.
  const { data: auditRows, error: aErr } = await sb
    .from('audit_log')
    .select('id, occurred_at, action, target_type, target_id, metadata')
    .eq('firm_id', firmId)
    .in('action', [...FISHY_AUDIT_ACTIONS, ...ESCALATION_AUDIT_ACTIONS])
    .order('occurred_at', { ascending: false })
    .limit(fetchLimit);
  if (aErr) {
    return NextResponse.json({ error: aErr.message }, { status: 500 });
  }

  // 5a'. What an operator already resolved. Escalation and fishy rows
  //      are audit rows and never change on their own; a Resolve (or a resume
  //      that reviewed the reply) retires them. Non-fatal: on a failure the
  //      rows stay visible, which is the safe direction.
  const { data: resolutionRows } = await sb
    .from('audit_log')
    .select('id, occurred_at, action, target_type, target_id, metadata')
    .eq('firm_id', firmId)
    .in('action', [...RESOLUTION_AUDIT_ACTIONS])
    .order('occurred_at', { ascending: false })
    .limit(2000);
  const resolved = resolvedFromAudit((resolutionRows ?? []) as ThreadAuditRow[]);

  // 5b. Money-path anomalies (payment_anomaly lane). Their own queries, NOT
  //     folded into the audit query above: that one is limit-bounded, and the
  //     execute path writes a payment.failed per failed dispatch, which would
  //     crowd the fishy/escalation rows out. Non-fatal — a failure here
  //     degrades to an empty lane, the rest of the rollup still matters.
  const { data: moneyAuditRows } = await sb
    .from('audit_log')
    .select('id, occurred_at, action, target_type, target_id, metadata')
    .eq('firm_id', firmId)
    // PROMO_WITHHELD_ACTION is not an anomaly; it resolves a held promo row.
    // RECONCILE_FLAG_ACTIONS are fetched separately (5c'): they repeat per
    // payment while it stays stuck, and in this limit-bounded query they used to
    // crowd every other money anomaly out.
    .in('action', [
      ...MONEY_ANOMALY_AUDIT_ACTIONS.filter((a) => !RECONCILE_FLAG_ACTIONS.includes(a)),
      PROMO_WITHHELD_ACTION,
    ])
    .order('occurred_at', { ascending: false })
    .limit(fetchLimit);
  // Stripe payout.failed is audited as payment.failed against the OFFER
  // (settlement-failure.handlePayoutFailed); the execute path's own
  // payment.failed targets the authorization and is already in payment_failed.
  const { data: bankFailRows } = await sb
    .from('audit_log')
    .select('id, occurred_at, action, target_type, target_id, metadata')
    .eq('firm_id', firmId)
    .eq('action', BANK_PAYOUT_FAILED_ACTION)
    .eq('target_type', 'creator_offer')
    .order('occurred_at', { ascending: false })
    .limit(fetchLimit);

  // 5b'. Held promo packs are resolved once the lead has a promo_materials
  //      message (the resend landed, or the provider rejected it and it is on
  //      record). Only the held deals' leads are looked up. Non-fatal: on a
  //      failure the held rows stay visible, and a resend of an already-sent
  //      pack is refused by its own idempotency check.
  const heldOfferIds = new Set(
    ((moneyAuditRows ?? []) as ThreadAuditRow[])
      .filter((a) => a.action === PROMO_HELD_ACTION && a.target_id)
      .map((a) => a.target_id as string)
  );
  const heldCiIds = offers
    .filter((o) => heldOfferIds.has(o.id))
    .map((o) => o.campaign_influencer_id)
    .filter((id): id is string => typeof id === 'string');
  let promoSentCiIds: string[] = [];
  if (heldCiIds.length > 0) {
    const { data: promoRows } = await sb
      .from('outreach_messages')
      .select('campaign_influencer_id')
      .eq('message_type', 'promo_materials')
      .in('campaign_influencer_id', heldCiIds);
    promoSentCiIds = ((promoRows ?? []) as { campaign_influencer_id: string | null }[])
      .map((r) => r.campaign_influencer_id)
      .filter((id): id is string => typeof id === 'string');
  }

  // 5b''. Legs of the deals named by a mint-failed audit row — a failure is
  //       resolved once a leg accounts for the payment (statuses.ts). Non-fatal:
  //       on a failure the rows stay visible, and the re-mint itself refuses
  //       with already_queued if a leg exists.
  const mintFailOfferIds = [
    ...new Set(
      ((moneyAuditRows ?? []) as ThreadAuditRow[])
        .filter((a) => PAYMENT_MINT_FAILED_ACTIONS.includes(a.action) && a.target_id && offerIdSet.has(a.target_id))
        .map((a) => a.target_id as string)
    ),
  ];
  let offerLegs: NonNullable<Parameters<typeof detectAnomalies>[0]['offerLegs']> = [];
  if (mintFailOfferIds.length > 0) {
    const legsSelect = (withLeg: boolean) =>
      sb
        .from('payment_authorizations')
        .select(`creator_offer_id, status, failure_reason, payment_provider_id${withLeg ? ', leg' : ''}`)
        .eq('firm_id', firmId)
        .in('creator_offer_id', mintFailOfferIds);
    let { data: legRows, error: lgErr } = await legsSelect(true);
    if (lgErr) ({ data: legRows, error: lgErr } = await legsSelect(false));
    if (!lgErr) offerLegs = (legRows ?? []) as unknown as typeof offerLegs;
  }

  // 5c. Authorizations sitting in 'executing' — detectAnomalies keeps only the
  //     ones past the stranded threshold. `executing_at` arrives with migration
  //     055; on a database without it, the
  //     column-naming select errors and we fall back to created_at-only rows.
  const executingSelect = (withClaimTime: boolean) =>
    sb
      .from('payment_authorizations')
      .select(
        `id, creator_offer_id, campaign_id, amount_usd, created_at, failure_reason${withClaimTime ? ', executing_at' : ''}`
      )
      .eq('firm_id', firmId)
      .eq('status', 'executing')
      .limit(fetchLimit);
  let { data: execRows, error: exErr } = await executingSelect(true);
  if (exErr) ({ data: execRows, error: exErr } = await executingSelect(false));
  const executing = ((exErr ? [] : execRows ?? []) as Partial<AnomalyExecutingRow>[]).map(
    (p) =>
      ({
        ...p,
        amount_usd: Number(p.amount_usd),
        executing_at: p.executing_at ?? null,
        failure_reason: p.failure_reason ?? null,
      }) as AnomalyExecutingRow
  );

  // 5c'. Per-payment reconcile flags (mismatch / provider unreachable), only for
  //      payments STILL executing — a resolved payment's flags are history, not
  //      an anomaly. detectAnomalies collapses them to one row per payment
  //      (latest state + first seen + count). Own query and own bound, so they
  //      cannot displace the rest of the money lane. Non-fatal.
  const executingIds = executing.map((p) => p.id).filter((id): id is string => typeof id === 'string');
  let flagRows: ThreadAuditRow[] = [];
  if (executingIds.length > 0) {
    const { data: fr } = await sb
      .from('audit_log')
      .select('id, occurred_at, action, target_type, target_id, metadata')
      .eq('firm_id', firmId)
      .eq('target_type', 'payment_authorization')
      .in('target_id', executingIds)
      .in('action', [...RECONCILE_FLAG_ACTIONS])
      .order('occurred_at', { ascending: false })
      .limit(2000);
    flagRows = (fr ?? []) as ThreadAuditRow[];
  }

  // 6. Inbound: flagged lane + unmatched. No firm column — admitted via
  //    linkage checks below.
  const { data: flaggedRows, error: fErr } = await sb
    .from('inbound_messages')
    .select('id, campaign_influencer_id, creator_offer_id, channel, from_identity, body, received_at, status, classification')
    .eq('status', 'flagged')
    .order('received_at', { ascending: false })
    .limit(fetchLimit);
  if (fErr) {
    return NextResponse.json({ error: fErr.message }, { status: 500 });
  }
  const { data: unmatchedRows, error: uErr } = await sb
    .from('inbound_messages')
    .select('id, campaign_influencer_id, creator_offer_id, channel, from_identity, body, received_at, status')
    .is('campaign_influencer_id', null)
    .order('received_at', { ascending: false })
    .limit(fetchLimit);
  if (uErr) {
    return NextResponse.json({ error: uErr.message }, { status: 500 });
  }
  const inboundRaw = [
    ...((flaggedRows ?? []) as AnomalyInboundRow[]),
    ...((unmatchedRows ?? []) as AnomalyInboundRow[]),
  ];
  // A flagged row can also be unmatched — dedupe on id.
  const inboundById = new Map(inboundRaw.map((m) => [m.id, m]));

  // 6b. Bounced / spam-flagged outreach, read from delivery_status
  //     (migration 046 — NOT `status`, which stays terminal at 'sent' for the
  //     six analytics/performance readers that use it as a denominator).
  //     Pre-migration this query errors and the lane is simply empty.
  //     Non-fatal:
  //     a query failure degrades to an empty lane, not a 500 — this lane is
  //     additive observability, the rest of the rollup still matters.
  const { data: bounceRows } = await sb
    .from('outreach_messages')
    .select('id, campaign_influencer_id, delivery_status, sent_to, sent_at, created_at')
    .eq('direction', 'outbound')
    .in('delivery_status', ['bounced', 'complained'])
    .order('created_at', { ascending: false })
    .limit(fetchLimit);
  const bouncedRaw = (bounceRows ?? []) as AnomalyBouncedRow[];

  // 6c. Newest negotiation tick run (tick_runs, migration 044) for
  //     stalled-tick detection. Non-fatal by design: pre-migration the table
  //     does not exist and the query errors — stall detection stays silent
  //     (undefined input) rather than false-alarming.
  let tick: AnomalyTickInput | undefined;
  const { data: tickRow, error: tErr } = await sb
    .from('tick_runs')
    .select('started_at')
    .eq('tick', 'negotiation')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!tErr && tickRow) {
    tick = {
      last_negotiation_run_at: (tickRow as { started_at: string | null }).started_at ?? null,
    };
  }

  // 7. Targeted CI + influencer lookups for attribution ("who").
  const ciIds = new Set<string>();
  for (const o of offers) ciIds.add(o.campaign_influencer_id);
  for (const m of inboundById.values()) {
    if (m.campaign_influencer_id) ciIds.add(m.campaign_influencer_id);
  }
  for (const b of bouncedRaw) {
    if (b.campaign_influencer_id) ciIds.add(b.campaign_influencer_id);
  }
  let cis: { id: string; campaign_id: string; influencer_id: string }[] = [];
  if (ciIds.size > 0) {
    const { data: ciRows, error: ciErr } = await sb
      .from('campaign_influencers')
      .select('id, campaign_id, influencer_id')
      .in('id', [...ciIds]);
    if (ciErr) {
      return NextResponse.json({ error: ciErr.message }, { status: 500 });
    }
    cis = (ciRows ?? []) as typeof cis;
  }
  const ciById = new Map(cis.map((c) => [c.id, c]));

  let influencers: { id: string; username: string }[] = [];
  if (cis.length > 0) {
    const { data: infRows, error: iErr } = await sb
      .from('influencers')
      .select('id, username')
      .in('id', [...new Set(cis.map((c) => c.influencer_id))]);
    if (iErr) {
      return NextResponse.json({ error: iErr.message }, { status: 500 });
    }
    influencers = (infRows ?? []) as typeof influencers;
  }

  // Firm admission for inbound rows (no firm column on the table):
  //   - CI present  → CI's campaign must be this firm's.
  //   - CI absent   → keep if the linked offer is this firm's, or if the row
  //     is fully unlinked (no owner exists; surfaced as unattributed).
  //     Rows provably linked to ANOTHER firm's offer are dropped.
  const inbound = [...inboundById.values()].filter((m) => {
    if (m.campaign_influencer_id != null) {
      const ci = ciById.get(m.campaign_influencer_id);
      return ci != null && firmCampaignIds.has(ci.campaign_id);
    }
    if (m.creator_offer_id != null) return offerIdSet.has(m.creator_offer_id);
    return true;
  });

  // Firm admission for bounced outreach: outreach_messages has no firm
  // column, so a row is admitted only when its CI resolves to this firm's
  // campaign. Unlinked rows are dropped (unlike inbound, an outbound row we
  // sent always had a CI — a missing one is data damage, not a lost lead).
  const bounced = bouncedRaw.filter((b) => {
    if (b.campaign_influencer_id == null) return false;
    const ci = ciById.get(b.campaign_influencer_id);
    return ci != null && firmCampaignIds.has(ci.campaign_id);
  });

  const anomalies = detectAnomalies(
    {
      offers,
      payments: ((payRows ?? []) as {
        id: string;
        creator_offer_id: string;
        campaign_id: string;
        status: string;
        failure_reason: string | null;
        amount_usd: number;
        created_at: string;
        executed_at: string | null;
      }[]).map((p) => ({ ...p, amount_usd: Number(p.amount_usd) })),
      deliveries: (delRows ?? []) as {
        id: string;
        creator_offer_id: string;
        spec_check: string | null;
        spec_check_detail: string | null;
        detected_at: string | null;
        created_at: string;
      }[],
      audit: (auditRows ?? []) as ThreadAuditRow[],
      inbound,
      cis,
      influencers,
      campaigns,
      hasContractTemplate,
      bounced,
      tick,
      moneyAudit: [
        ...((moneyAuditRows ?? []) as ThreadAuditRow[]),
        ...((bankFailRows ?? []) as ThreadAuditRow[]),
        ...flagRows,
      ],
      executing,
      promoSentCiIds,
      offerLegs,
      resolved,
    },
    Date.now()
  );

  return NextResponse.json({ anomalies });
}
