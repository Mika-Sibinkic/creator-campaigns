// src/lib/learning-log.ts
//
// THE prediction→actual spine for the CPM-first learning loop: every decision
// point emits a (state, action, outcome) record the optimizer can learn from.
//
// learning_logs (migrations 003 and 007) had ZERO writers in src/ until
// this module. This is the single write path.
//
// Event vocabulary (append-only; outcomes are PAIRED EVENTS, not row updates —
// learning_logs has no offer/CI key column, so an update would need a jsonb
// filter the hermetic store cannot express, and append-only keeps the table an
// immutable observation log the way audit_log is):
//
//   opening_offer          @ createOffer            predicted agreed amount
//   opening_offer_outcome  @ finalizeAgreement      actual agreed amount
//   reply_prediction       @ outreach send          scoring response_likelihood
//   reply_outcome          @ first matched reply    replied=true + classification
//   deal_cpm               @ /api/outcomes/record   full dealCpmFeatures record,
//                                                   predicted vs actual
//                                                   streams-per-dollar + label CPM
//
// Pair keys live in input_data (creator_offer_id / campaign_influencer_id);
// readers join prediction↔outcome in JS or with a jsonb expression.
//
// INVARIANTS
//   * Write-then-don't-throw (the audit.ts / api-ledger.ts pattern): a learning
//     write must never take down a send, a negotiation round, or an outcome
//     recording. Failures log to console.error and return.
//   * [SAMPLE]-synthetic exclusion: rows keyed to a `campaigns.synthetic = true`
//     campaign are NEVER written, and an UNPROVABLE synthetic status (lookup
//     error) also skips — the same fail-closed direction as
//     fetchNegotiationHistory (negotiation.ts) and the measurement tick.
//     Fabricated deals must not teach the optimizer anything.
//
// SECURITY: callers inject the Supabase client (service-role on system paths) —
// the SEC-1 visible-blast-radius pattern shared with ingest-inbound.ts and
// channel-priors.ts. learning_logs INSERT is service-role-only (007).

import type { SupabaseClient } from '@supabase/supabase-js';
import { dealCpmFeatures, labelCpm, latestSnapshot, totalReach } from './cpm-model';
import type { PerformanceSnapshot } from './cpm-model';
import { normalizeDeliverables } from './deliverables';
import { predict, type OutcomeDatum } from './rl-pricing';

export const LEARNING_EVENTS = {
  OPENING_OFFER: 'opening_offer',
  OPENING_OFFER_OUTCOME: 'opening_offer_outcome',
  REPLY_PREDICTION: 'reply_prediction',
  REPLY_OUTCOME: 'reply_outcome',
  DEAL_CPM: 'deal_cpm',
} as const;

export type LearningEventType = (typeof LEARNING_EVENTS)[keyof typeof LEARNING_EVENTS];

export interface LearningLogEntry {
  event_type: LearningEventType;
  input_data?: Record<string, unknown> | null;
  predicted_value?: Record<string, unknown> | null;
  actual_value?: Record<string, unknown> | null;
  campaign_id?: string | null;
  influencer_id?: string | null;
}

/**
 * Is this campaign the [SAMPLE] synthetic seed? Returns:
 *   false → provably real (safe to learn from)
 *   true  → provably synthetic
 *   null  → unknown (missing id, missing row, or lookup error)
 * Callers treat anything other than `false` as "do not learn".
 */
export async function isSyntheticCampaign(
  sb: SupabaseClient,
  campaignId: string | null | undefined,
): Promise<boolean | null> {
  try {
    if (!campaignId) return null;
    const { data, error } = await sb
      .from('campaigns')
      .select('id, synthetic')
      .eq('id', campaignId)
      .maybeSingle();
    if (error || !data) return null;
    return Boolean((data as { synthetic?: unknown }).synthetic);
  } catch {
    return null;
  }
}

/**
 * Insert one learning_logs row. Never throws. Skips (silently, by design) when
 * the campaign is synthetic or its synthetic status cannot be proven — see the
 * header invariant. Entries without a campaign_id are system-scoped and carry
 * no synthetic risk surface, so they write directly.
 */
export async function logLearning(sb: SupabaseClient, entry: LearningLogEntry): Promise<void> {
  try {
    if (entry.campaign_id != null) {
      const synthetic = await isSyntheticCampaign(sb, entry.campaign_id);
      if (synthetic !== false) return; // synthetic or unprovable → never learn
    }
    const { error } = await sb.from('learning_logs').insert({
      event_type: entry.event_type,
      input_data: entry.input_data ?? null,
      predicted_value: entry.predicted_value ?? null,
      actual_value: entry.actual_value ?? null,
      campaign_id: entry.campaign_id ?? null,
      influencer_id: entry.influencer_id ?? null,
    } as never);
    if (error) {
      console.error('[learning-log] insert failed', error.message, {
        event_type: entry.event_type,
      });
    }
  } catch (e) {
    console.error('[learning-log] insert threw', e, { event_type: entry.event_type });
    // Never re-throw — learning must not block the caller's action.
  }
}

// ── reply_prediction / reply_outcome ─────────────────────────────────────────

export interface ReplyPredictionArgs {
  campaignInfluencerId: string | null | undefined;
  /** outreach channel the message left on ('email' | 'instagram_dm' | …). */
  channel: string | null | undefined;
  outreachMessageId?: string | null;
}

/**
 * Log the response-likelihood prediction at the moment an outreach message
 * actually leaves (auto email send, or a human marking a DM sent). The
 * prediction is the scoring composite's response_likelihood component, frozen
 * on campaign_influencers.score_breakdown at discovery time. Never throws.
 */
export async function logReplyPrediction(
  sb: SupabaseClient,
  args: ReplyPredictionArgs,
): Promise<void> {
  try {
    if (!args.campaignInfluencerId) return;
    const { data } = await sb
      .from('campaign_influencers')
      .select('id, campaign_id, influencer_id, score_breakdown')
      .eq('id', args.campaignInfluencerId)
      .maybeSingle();
    const ci = data as {
      campaign_id?: string | null;
      influencer_id?: string | null;
      score_breakdown?: unknown;
    } | null;
    if (!ci?.campaign_id) return;
    const rl = (ci.score_breakdown as { response_likelihood?: unknown } | null)
      ?.response_likelihood;
    await logLearning(sb, {
      event_type: LEARNING_EVENTS.REPLY_PREDICTION,
      campaign_id: ci.campaign_id,
      influencer_id: ci.influencer_id ?? null,
      input_data: {
        campaign_influencer_id: args.campaignInfluencerId,
        channel: args.channel ?? null,
        outreach_message_id: args.outreachMessageId ?? null,
      },
      predicted_value: {
        response_likelihood: typeof rl === 'number' ? rl : null,
      },
    });
  } catch {
    // never block a send on a learning write
  }
}

export interface ReplyOutcomeArgs {
  campaignInfluencerId: string | null | undefined;
  channel: string | null | undefined;
  classification?: string | null;
}

/**
 * Log the actual: a FIRST matched inbound reply landed for this creator (the
 * same first-reply-per-creator semantics as the channel prior's 'reply' event —
 * the pair reads as "predicted likelihood N, creator replied"). Never throws.
 */
export async function logReplyOutcome(sb: SupabaseClient, args: ReplyOutcomeArgs): Promise<void> {
  try {
    if (!args.campaignInfluencerId) return;
    const { data } = await sb
      .from('campaign_influencers')
      .select('id, campaign_id, influencer_id')
      .eq('id', args.campaignInfluencerId)
      .maybeSingle();
    const ci = data as { campaign_id?: string | null; influencer_id?: string | null } | null;
    if (!ci?.campaign_id) return;
    await logLearning(sb, {
      event_type: LEARNING_EVENTS.REPLY_OUTCOME,
      campaign_id: ci.campaign_id,
      influencer_id: ci.influencer_id ?? null,
      input_data: {
        campaign_influencer_id: args.campaignInfluencerId,
        channel: args.channel ?? null,
      },
      actual_value: {
        replied: true,
        classification: args.classification ?? null,
      },
    });
  } catch {
    // never block reply ingestion on a learning write
  }
}

// ── deal_cpm ─────────────────────────────────────────────────────────────────

export interface DealCpmArgs {
  creatorOfferId: string;
  campaignId: string | null;
  firmId: string | null;
  streamsAttributed: number;
  paymentUsd: number;
  attributionMethod: string;
  followerCountAtPost?: number | null;
}

/**
 * Persist the full dealCpmFeatures() record for a measured deal — the row the
 * CPM optimizer compares across deals and campaigns — plus predicted vs actual
 * streams-per-dollar and label CPM.
 *
 *   predicted: rl-pricing predict() over this firm's PRIOR measured outcomes
 *              (synthetic campaigns excluded, this offer's own outcome
 *              excluded — a prediction may never see its own actual).
 *   actual:    streams_attributed ÷ payment, and labelCpm(payment, verified
 *              reach). Reach comes from deal_performance_snapshots (latest
 *              snapshot per delivery); no snapshots ⇒ reach 0 ⇒ label_cpm
 *              null — never fabricated.
 *
 * Never throws; every lookup degrades to null-context rather than blocking
 * the outcome recording.
 */
export async function logDealCpm(sb: SupabaseClient, args: DealCpmArgs): Promise<void> {
  try {
    // Offer context: negotiation shape + frozen package.
    const { data: offerRow } = await sb
      .from('creator_offers')
      .select(
        'id, campaign_influencer_id, initial_offer_usd, agreed_amount_usd, rounds, agreed_deliverables',
      )
      .eq('id', args.creatorOfferId)
      .maybeSingle();
    const offer = offerRow as {
      campaign_influencer_id: string | null;
      initial_offer_usd: number | null;
      agreed_amount_usd: number | null;
      rounds: number | null;
      agreed_deliverables: unknown;
    } | null;

    // Verified reach: deliveries → latest snapshot per delivery → Σ views.
    const reach = await verifiedReachForOffer(sb, args.creatorOfferId);

    // Campaign pool context (size + scrape quality) — best-effort.
    const pool = await campaignPoolContext(sb, args.campaignId);

    const features = dealCpmFeatures({
      agreedAmountUsd: Number(args.paymentUsd) || 0,
      openingOfferUsd: offer?.initial_offer_usd ?? null,
      rounds: Number(offer?.rounds ?? 0) || 0,
      deliverables: normalizeDeliverables(offer?.agreed_deliverables),
      reach,
      campaignSize: pool.size,
      scrapeQuality: pool.avgScore,
    });

    // Predicted streams-per-dollar from the firm's PRIOR real outcomes.
    const history = await firmOutcomeHistory(sb, args.firmId, args.creatorOfferId);
    const predicted = predict(
      {
        follower_count: Number(args.followerCountAtPost ?? 0) || 0,
        payment_usd: Number(args.paymentUsd) || 0,
      },
      history,
    );

    const payment = Number(args.paymentUsd) || 0;
    const influencerId = await influencerIdForCi(sb, offer?.campaign_influencer_id ?? null);

    await logLearning(sb, {
      event_type: LEARNING_EVENTS.DEAL_CPM,
      campaign_id: args.campaignId ?? null,
      influencer_id: influencerId,
      input_data: {
        creator_offer_id: args.creatorOfferId,
        campaign_influencer_id: offer?.campaign_influencer_id ?? null,
        attribution_method: args.attributionMethod,
        follower_count_at_post: args.followerCountAtPost ?? null,
        features: features as unknown as Record<string, unknown>,
      },
      predicted_value: {
        streams_per_dollar: predicted.predicted_streams_per_dollar,
        streams: predicted.predicted_streams,
        method: predicted.method,
        sample_size: predicted.sample_size,
        confidence: predicted.confidence,
      },
      actual_value: {
        streams_attributed: args.streamsAttributed,
        streams_per_dollar: payment > 0 ? args.streamsAttributed / payment : null,
        verified_reach: reach,
        label_cpm: labelCpm(payment, reach),
      },
    });
  } catch (e) {
    console.error('[learning-log] deal_cpm failed', (e as Error).message, {
      creator_offer_id: args.creatorOfferId,
    });
  }
}

/** Σ latest-snapshot views across this offer's deliveries. 0 when none. */
async function verifiedReachForOffer(sb: SupabaseClient, offerId: string): Promise<number> {
  try {
    const { data: delRows } = await sb
      .from('deal_deliveries')
      .select('id')
      .eq('creator_offer_id', offerId);
    const deliveryIds = ((delRows ?? []) as Array<{ id: string }>).map((d) => d.id);
    if (deliveryIds.length === 0) return 0;
    const { data: snapRows } = await sb
      .from('deal_performance_snapshots')
      .select('deal_delivery_id, captured_at, views, likes, comments, shares')
      .in('deal_delivery_id', deliveryIds);
    const byDelivery = new Map<string, PerformanceSnapshot[]>();
    for (const raw of (snapRows ?? []) as Array<
      PerformanceSnapshot & { deal_delivery_id: string }
    >) {
      const list = byDelivery.get(raw.deal_delivery_id) ?? [];
      list.push(raw);
      byDelivery.set(raw.deal_delivery_id, list);
    }
    const latestPerPost: PerformanceSnapshot[] = [];
    for (const snaps of byDelivery.values()) {
      const latest = latestSnapshot(snaps);
      if (latest) latestPerPost.push(latest);
    }
    return totalReach(latestPerPost);
  } catch {
    return 0;
  }
}

/** Creators in the campaign + avg composite score of the pool. */
async function campaignPoolContext(
  sb: SupabaseClient,
  campaignId: string | null,
): Promise<{ size: number | null; avgScore: number | null }> {
  try {
    if (!campaignId) return { size: null, avgScore: null };
    const { data } = await sb
      .from('campaign_influencers')
      .select('id, composite_score')
      .eq('campaign_id', campaignId);
    const rows = (data ?? []) as Array<{ composite_score: number | null }>;
    if (rows.length === 0) return { size: null, avgScore: null };
    const scores = rows
      .map((r) => Number(r.composite_score))
      .filter((n) => Number.isFinite(n));
    const avgScore = scores.length
      ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100
      : null;
    return { size: rows.length, avgScore };
  } catch {
    return { size: null, avgScore: null };
  }
}

/**
 * The firm's prior measured outcomes for the streams-per-dollar prediction.
 * Synthetic campaigns are excluded (fail closed: an unreadable campaign list
 * yields [] — same posture as fetchNegotiationHistory). The offer being
 * measured is excluded so the prediction never sees its own actual.
 */
async function firmOutcomeHistory(
  sb: SupabaseClient,
  firmId: string | null,
  excludeOfferId: string,
): Promise<OutcomeDatum[]> {
  try {
    if (!firmId) return [];
    const { data: campRows, error: campErr } = await sb
      .from('campaigns')
      .select('id, synthetic')
      .eq('firm_id', firmId);
    if (campErr) return [];
    const realCampaignIds = ((campRows ?? []) as Array<{ id: string; synthetic?: unknown }>)
      .filter((c) => !c.synthetic)
      .map((c) => c.id);
    if (realCampaignIds.length === 0) return [];
    const { data: ocRows, error: ocErr } = await sb
      .from('campaign_outcomes')
      .select(
        'creator_offer_id, campaign_id, streams_attributed, payment_usd_amount, follower_count_at_post, engagement_at_post',
      )
      .in('campaign_id', realCampaignIds);
    if (ocErr) return [];
    return ((ocRows ?? []) as Array<{
      creator_offer_id: string | null;
      streams_attributed: number | null;
      payment_usd_amount: number | null;
      follower_count_at_post: number | null;
      engagement_at_post: number | null;
    }>)
      .filter(
        (r) =>
          r.creator_offer_id !== excludeOfferId &&
          typeof r.streams_attributed === 'number' &&
          Number(r.payment_usd_amount) > 0,
      )
      .map((r) => ({
        follower_count: Number(r.follower_count_at_post ?? 0) || 0,
        payment_usd: Number(r.payment_usd_amount),
        streams_attributed: Number(r.streams_attributed),
        engagement_rate: r.engagement_at_post ?? null,
      }));
  } catch {
    return [];
  }
}

async function influencerIdForCi(
  sb: SupabaseClient,
  campaignInfluencerId: string | null,
): Promise<string | null> {
  try {
    if (!campaignInfluencerId) return null;
    const { data } = await sb
      .from('campaign_influencers')
      .select('id, influencer_id')
      .eq('id', campaignInfluencerId)
      .maybeSingle();
    return (data as { influencer_id?: string | null } | null)?.influencer_id ?? null;
  } catch {
    return null;
  }
}
