// src/lib/negotiation.ts
//
// Negotiation state machine for creator_offers (migration 009).
//
// State graph (matches the CHECK constraint enum on creator_offers.status):
//
//                  ┌────────┐
//                  │ queued │
//                  └───┬────┘
//                      │ make_initial_offer
//                  ┌───▼────┐
//   ┌─────────────►│offered │
//   │              └───┬────┘
//   │ recv_counter (round-trip)
//   │   ┌──────────────▼──────────────┐
//   │   │     counter_offered         │
//   │   └──┬──────────────────────────┘
//   │      │ evaluateCounter()
//   │      │  ─ counter (re-offer) → back to "offered"
//   └──────┘  ─ accept            → "agreed"
//             ─ reject            → "rejected" (terminal)
//
//                  ┌────────┐
//                  │ agreed │
//                  └───┬────┘
//                      │ auto-promote
//                  ┌───▼─────────────────────────┐
//                  │ human_approval_required     │  ← MANDATORY GATE
//                  └───┬─────────────────────────┘
//                      │ /api/payments/[id]/approve  (a human clicks)
//                  ┌───▼────┐                    │ reject
//                  │approved│                    ▼
//                  └───┬────┘               ┌────────┐
//                      │ /api/payments/.../execute   │rejected│
//                  ┌───▼────┐                └────────┘
//                  │  paid  │
//                  └───┬────┘
//                      │ creator confirms post (post_url stored)
//                  ┌───▼────┐
//                  │ posted │
//                  └───┬────┘
//                      │ streams measured (manual or Spotify-for-Artists)
//                  ┌───▼────────┐
//                  │ measured   │ ← terminal, RL gets the (pay,streams) tuple
//                  └────────────┘
//
// "failed" is a terminal escape hatch from any non-terminal state for
// transient errors (Resend down, creator email bounced, Stripe failure
// before approval, etc.). Failed offers get retried by hand or new
// outreach, never auto-resumed.
//
// IMPORTANT — Human-approval gate:
//   The transition agreed → human_approval_required is automatic.
//   The transition human_approval_required → approved is BLOCKED unless
//   it carries an `approved_by_user_id` and the row is updated through
//   /api/payments/[id]/approve (which is rate-limit + audit-gated).
//   The DB-level CHECK constraint on payment_authorizations enforces the
//   same invariant on the payment side as a belt-and-suspenders.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyCounterRatchet,
  bundleValueUnits,
  calculateInitialOffer,
  evaluateCounter,
  evaluateTermTrade,
  type CounterDecision,
  type MarketDataPoint,
  type TermTradeDecision,
} from './pricing-engine';
import {
  applyTermsToDeliverables,
  checkPackageAgainstSpec,
  describeDeliverables,
  describeSpecViolations,
  type Deliverable,
  type DeliverableSpec,
  type SpecViolation,
} from './deliverables';
import {
  checkFrozenDeliverables,
  resolveCampaignSpec,
  resolveStandingDeliverables,
} from './deliverables-store';
import {
  estimateOpeningPct,
  chooseSweetSpot,
  marginalOutputPerDollar,
} from './analytics';
import type {
  NegotiationOutcome,
  OpeningPctContext,
  OutputPoint,
} from './analytics';
import { resolveGenrePremiums } from './genre-config';
import { audit } from './audit';
import { LEARNING_EVENTS, logLearning } from './learning-log';
import { complete } from './model-provider';
import {
  sanitizeInbound,
  parseNegotiatorOutput,
  NEGOTIATOR_OUTPUT_SCHEMA,
  NEGOTIATOR_SYSTEM_PROMPT,
  type NegotiatorOutput,
} from './injection-guard';
import { checkReplySanity } from './reply-sanity';
// The negotiation path resolves a campaign budget through the very
// same function the payout path does, so the two can never drift apart on what
// counts as a usable budget.
import { CAMPAIGN_BUDGET_NOT_SET, resolveCampaignBudget } from './spend-caps';
import { resolvePaymentMode } from './stripe-isolated';
import { authorizePaymentForOffer } from './authorize-payment';
import { createLogger } from './logger';
import { deliverByMs } from './split-settlement';
import { acceptanceGate, acceptanceNumberGate, acceptanceWordingGate, counterGate, type PriceGate } from './stated-price';
import { isHumanTakeover } from './takeover-state';
// CPM slices S1/S4: shadow RECORDS only — read by nothing that decides or sends.
import { loadCreatorProfile, recordFirstAsk, recordShadowPricingBasis, type CreatorProfile } from './cpm-shadow';
import { readCommentPriceFactor } from './comment-audit-store';

const negotiationLog = createLogger('negotiation');

// ── Full-auto negotiation (spec decisions #1, #2, #7) ───────────────────────
//
// autonomy_mode drives whether the human-approval gate is enforced:
//   'auto'   (default) — the AI decides accept/counter/reject AND, in
//                        paper-money mode, auto-executes the paper payout
//                        within caps. NO human_approval_required stop.
//   'manual'          — the AI still negotiates, but on agreement it STOPS at
//                        human_approval_required (the kill-switch). Nothing is
//                        paid without a human. Any non-paper payment mode also
//                        forces this gate, so real money can NEVER move
//                        autonomously — only paper does.
//
// HARD CAPS ARE THE GUARDRAIL that replaces the human in 'auto' mode. Every
// agreement is bounded by an EFFECTIVE CEILING = min(per-creator ceiling,
// remaining campaign budget). evaluateCounter() is fed that effective ceiling,
// so it can only ever accept at-or-below both caps, counter at a midpoint that
// stays at-or-below them, or reject. A computed offer that would breach a cap
// is clamped down or rejected — it is never sent.
//
// Injection defense: inbound replies are untrusted DATA. sanitizeInbound()
// fences + flags them BEFORE the model runs; a flagged reply (or a low-
// confidence actionable read) sets creator_offers.injection_flagged and is
// NOT auto-countered — a human reviews it. The negotiator LLM has no tools and
// can only return the strict { intent, counter_usd, sentiment, confidence }
// object; anything off-contract is treated as `unclear` (a safe no-op).

export type OfferStatus =
  | 'queued'
  | 'offered'
  | 'counter_offered'
  | 'agreed'
  | 'human_approval_required'
  | 'approved'
  | 'rejected'
  | 'paid'
  | 'deposit_paid'
  | 'posted'
  | 'balance_paid'
  | 'measured'
  | 'undelivered'
  | 'failed';

export const TERMINAL_STATES: OfferStatus[] = ['measured', 'rejected', 'failed', 'undelivered'];

const VALID_TRANSITIONS: Record<OfferStatus, OfferStatus[]> = {
  queued:                  ['offered', 'failed'],
  offered:                 ['counter_offered', 'agreed', 'rejected', 'failed'],
  counter_offered:         ['offered', 'agreed', 'rejected', 'failed'],
  // 'paid' is the full-auto (paper-money) fast-path: in 'auto' mode the AI
  // auto-executes the paper payout and skips the human_approval_required stop.
  // The human gate (agreed → human_approval_required) is preserved for 'manual'
  // mode and for any non-paper payment mode (real money never auto-pays).
  // 'paid' removed — agreed can no longer reach paid without the
  // human gate. The only path is agreed → human_approval_required → approved
  // → paid, in every payment mode including paper.
  agreed:                  ['human_approval_required', 'failed'],
  human_approval_required: ['approved', 'rejected'],
  // Two legal settlement paths, and firms.require_delivery_before_balance picks
  // which one a deal takes (migration 052, src/lib/split-settlement.ts):
  //
  //   flag OFF (today, and the default):
  //     approved → paid → posted → measured
  //
  //   flag ON:
  //     approved → deposit_paid → posted → balance_paid → measured
  //                     └──────→ undelivered   (outside date passed, no post)
  //
  // The old path is untouched on purpose: turning the flag on must not
  // retro-gate a deal that is already mid-settlement under the other rules.
  approved:                ['paid', 'deposit_paid', 'failed'],
  rejected:                [],
  paid:                    ['posted', 'failed'],
  // A deposit is out and the creator owes a post. `undelivered` is how this
  // resolves itself when the window passes — no reminder, no chase.
  deposit_paid:            ['posted', 'undelivered', 'failed'],
  // `posted` reaches `measured` directly on the single-payment path, and via
  // `balance_paid` on the split path.
  posted:                  ['measured', 'balance_paid', 'failed'],
  balance_paid:            ['measured', 'failed'],
  measured:                [],
  // Terminal. The deposit is the loss; the balance was never sent.
  undelivered:             [],
  failed:                  [],
};

export function canTransition(from: OfferStatus, to: OfferStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface CreatorOfferRow {
  id: string;
  campaign_influencer_id: string;
  campaign_id: string;
  firm_id: string;
  status: OfferStatus;
  initial_offer_usd: number | null;
  current_offer_usd: number | null;
  agreed_amount_usd: number | null;
  ceiling_usd: number;
  rounds: number;
  last_message_id: string | null;
  approved_at: string | null;
  approved_by_user_id: string | null;
  paid_at: string | null;
  posted_at: string | null;
  post_url: string | null;
  // migration 018 — full-auto negotiation fields.
  autonomy_mode: string;              // 'auto' (default) | 'manual'
  opening_pct: number | null;         // RL-set opening offer as a fraction of ceiling
  injection_flagged: boolean;         // tripped the prompt-injection lane
  // migration 025 — jsonb Deliverable[] frozen by term negotiation:
  // written on a term-changing counter (the standing package for later rounds)
  // and on acceptance (the final contract state). Optional so pre-existing
  // seeds/rows without the column still type-check.
  agreed_deliverables?: unknown;
  created_at: string;
  updated_at: string;
}

export interface CreateOfferInput {
  campaign_influencer_id: string;
  campaign_id: string;
  firm_id: string;
  follower_count: number;
  engagement_rate: number;
  genre?: string | null;
  /**
   * Per-firm genre premium table. Injectable for tests; when omitted
   * createOffer reads it from the firm's own scraping_prefs, so a label's
   * configured premium is honoured without every caller knowing about it.
   */
  genre_premiums?: Readonly<Record<string, number>>;
  per_creator_cap_usd: number;
  /** Negotiation autonomy. Defaults to 'auto' (matches the DB column default). */
  autonomy_mode?: 'auto' | 'manual';
  /** Optional historical signals for the marginal-output opening heuristic. */
  market_data?: MarketDataPoint[];
  /**
   * Prior same-firm closed (opening, agreed) outcomes for the estimator's
   * desired-vs-negotiated gap correction. When omitted, createOffer fetches
   * them itself via fetchNegotiationHistory() — injecting is for hermetic
   * tests and callers that already hold the rows.
   */
  negotiation_history?: NegotiationOutcome[];
  /**
   * The creator's platform + raw_data, for the CPM shadow price (S1). Optional:
   * when omitted it is loaded from campaign_influencers → influencers, because
   * the send paths only carry followers/engagement. Never affects the price.
   */
  creator_profile?: CreatorProfile | null;
  /**
   * Comment-quality multiplier (migration 066, src/lib/comment-audit.ts),
   * in (0, 1]. Omitted → read from the campaign row's applied audit; 1 when
   * there is none, pre-066, or on any read failure (today's price).
   */
  comment_price_factor?: number;
}

/**
 * Create a fresh creator_offers row in 'queued' status. Initial pricing is
 * computed but not yet sent to the creator — the actual outbound message
 * is the responsibility of `makeInitialOffer()` which transitions to
 * 'offered' and writes a corresponding outreach_messages row.
 */
export async function createOffer(
  sb: SupabaseClient,
  input: CreateOfferInput
): Promise<CreatorOfferRow> {
  // COMMENT QUALITY (066): a creator flagged for consistently hostile comments
  // opens lower AND has a lower per-creator ceiling: × max(0.7, 1 − negative
  // share). Applied to the cap before anything reads it, so the formula
  // offer, the RL opening, the stored ceiling_usd and the learning log all
  // see the same tightened number. It only ever lowers the ceiling; the DB
  // CHECKs, computeEffectiveCeiling and budget pacing apply on top unchanged.
  const commentFactor =
    input.comment_price_factor ??
    (await readCommentPriceFactor(sb, input.campaign_influencer_id));
  if (Number.isFinite(commentFactor) && commentFactor > 0 && commentFactor < 1) {
    input = {
      ...input,
      per_creator_cap_usd: Math.floor(input.per_creator_cap_usd * commentFactor * 100) / 100,
    };
  }

  // The firm's configured genre premium. Injected value wins (hermetic
  // tests); otherwise read it here so the knob is live for every caller
  // rather than being a setting nothing consumes.
  const genre_premiums =
    input.genre_premiums ?? (await fetchFirmGenrePremiums(sb, input.firm_id));

  const pricing = calculateInitialOffer({
    follower_count: input.follower_count,
    engagement_rate: input.engagement_rate,
    platform: input.creator_profile?.platform ?? null,
    genre: input.genre,
    genre_premiums,
    per_creator_cap_usd: input.per_creator_cap_usd,
    market_data: input.market_data,
  });

  // RL loop closure (S3.4): prior same-firm closed deals feed the desired-vs-
  // negotiated gap correction in estimateOpeningPct. Caller-injected history
  // wins (hermetic tests / callers holding the rows); otherwise fetch it here
  // so EVERY caller closes the loop. Zero rows ⇒ [] ⇒ cold-start behavior,
  // unchanged.
  const negotiation_history =
    input.negotiation_history ??
    (await fetchNegotiationHistory(sb, input.firm_id));

  // Opening offer as a fraction of ceiling. The full estimate (not just the
  // pct) is kept so the learning log below records the estimator's actual
  // inputs and internals — the prediction side of the opening_offer pair.
  const estimate = estimateOpeningPct({
    follower_count: input.follower_count,
    engagement_rate: input.engagement_rate,
    genre: input.genre,
    genre_premiums,
    ceiling_usd: input.per_creator_cap_usd,
    market_data: input.market_data,
    negotiation_history,
  });
  const opening_pct = estimate.opening_pct;

  const { data, error } = await sb
    .from('creator_offers')
    .insert({
      campaign_influencer_id: input.campaign_influencer_id,
      campaign_id: input.campaign_id,
      firm_id: input.firm_id,
      status: 'queued',
      initial_offer_usd: pricing.initial_offer_usd,
      current_offer_usd: pricing.initial_offer_usd,
      ceiling_usd: input.per_creator_cap_usd,
      rounds: 0,
      autonomy_mode: input.autonomy_mode ?? 'auto',
      opening_pct,
    } as never)
    .select()
    .single();
  if (error || !data) throw new Error(`createOffer failed: ${error?.message}`);
  const row = data as CreatorOfferRow;

  // Learning spine: the opening-offer PREDICTION. The predicted
  // agreed amount is opening_pct × ceiling; the actual lands as a paired
  // opening_offer_outcome event in finalizeAgreement. Never throws; synthetic
  // campaigns are excluded inside logLearning.
  await logLearning(sb, {
    event_type: LEARNING_EVENTS.OPENING_OFFER,
    campaign_id: input.campaign_id,
    input_data: {
      creator_offer_id: row.id,
      campaign_influencer_id: input.campaign_influencer_id,
      firm_id: input.firm_id,
      follower_count: input.follower_count,
      engagement_rate: input.engagement_rate,
      genre: input.genre ?? null,
      ceiling_usd: input.per_creator_cap_usd,
      initial_offer_usd: pricing.initial_offer_usd,
      method: estimate.method,
      prior_pct: estimate.prior_pct,
      equilibrium_pct: estimate.equilibrium_pct,
      gap_adjustment_pct: estimate.gap_adjustment_pct,
      confidence: estimate.confidence,
      sample_size: estimate.sample_size,
      reason: estimate.reason,
    },
    predicted_value: {
      agreed_amount_usd:
        Math.round(opening_pct * input.per_creator_cap_usd * 100) / 100,
      opening_pct,
    },
  });

  // CPM slice S1 (shadow): the price this offer WOULD open at under CPM
  // pricing, stored in creator_offers.pricing_basis beside the formula price
  // above. It changes nothing — the row returned is the row inserted, and no
  // decision or send path reads pricing_basis. Separate UPDATE, never throws;
  // pre-061 it is skipped silently (logged once).
  await recordShadowPricingBasis(sb, {
    offer_id: row.id,
    campaign_id: input.campaign_id,
    campaign_influencer_id: input.campaign_influencer_id,
    genre: input.genre ?? null,
    genre_premiums,
    per_creator_cap_usd: input.per_creator_cap_usd,
    formula_price_usd: pricing.initial_offer_usd,
    creator_profile: input.creator_profile,
  });
  return row;
}

export interface MakeInitialOfferContext {
  outreach_message_id: string;       // the outbound that carries the offer
  request?: Request;                  // for audit IP/UA capture
}

export async function makeInitialOffer(
  sb: SupabaseClient,
  offer: CreatorOfferRow,
  ctx: MakeInitialOfferContext
): Promise<CreatorOfferRow> {
  if (!canTransition(offer.status, 'offered')) {
    throw new Error(`cannot transition ${offer.status} → offered`);
  }
  const next = await applyTransition(sb, offer.id, 'offered', {
    last_message_id: ctx.outreach_message_id,
    rounds: 1,
  });
  await audit(
    {
      action: 'negotiation.offer_sent',
      target_type: 'creator_offer',
      target_id: offer.id,
      firm_id: offer.firm_id,
      metadata: {
        amount_usd: offer.current_offer_usd,
        ceiling_usd: offer.ceiling_usd,
        round: 1,
      },
    },
    ctx.request
  );
  return next;
}


/**
 * Internal: validate transition + apply update. Bypasses RLS via the
 * service-role caller — this lib must be called from system paths only.
 */
async function applyTransition(
  sb: SupabaseClient,
  id: string,
  to: OfferStatus,
  patch: Partial<{
    current_offer_usd: number;
    agreed_amount_usd: number;
    rounds: number;
    last_message_id: string;
    approved_at: string;
    approved_by_user_id: string;
    paid_at: string;
    posted_at: string;
    post_url: string;
    autonomy_mode: string;
    opening_pct: number;
    injection_flagged: boolean;
    agreed_deliverables: unknown;
    /** Split settlement (migration 052): the outside date for delivery. */
    deliver_by: string;
  }> = {}
): Promise<CreatorOfferRow> {
  // Read current row so we can validate the transition before writing.
  const { data: cur, error: rErr } = await sb
    .from('creator_offers')
    .select('*')
    .eq('id', id)
    .single();
  if (rErr || !cur) throw new Error(`creator_offers ${id} not found: ${rErr?.message}`);
  const currentStatus = (cur as CreatorOfferRow).status;
  if (!canTransition(currentStatus, to)) {
    throw new Error(`invalid transition ${currentStatus} → ${to} on ${id}`);
  }

  const { data, error } = await sb
    .from('creator_offers')
    .update({ status: to, ...patch } as never)
    .eq('id', id)
    .select()
    .single();
  if (error || !data) throw new Error(`applyTransition failed: ${error?.message}`);
  return data as CreatorOfferRow;
}


/**
 * Update non-status fields on an offer without a state transition (e.g. flip
 * injection_flagged). Kept separate from applyTransition so the flagged/no-op
 * lanes never accidentally advance the state machine.
 */
async function patchOffer(
  sb: SupabaseClient,
  id: string,
  patch: Partial<{ injection_flagged: boolean; opening_pct: number; autonomy_mode: string }>,
): Promise<CreatorOfferRow> {
  const { data, error } = await sb
    .from('creator_offers')
    .update(patch as never)
    .eq('id', id)
    .select()
    .single();
  if (error || !data) throw new Error(`patchOffer failed: ${error?.message}`);
  return data as CreatorOfferRow;
}

// ── Tunables (safety defaults, not stated pricing) ──────────────────────────

/**
 * Below this negotiator confidence, an ACTIONABLE read (accept/counter/reject)
 * is routed to the flagged lane for human review instead of auto-executed.
 * A safety knob, not a pricing figure — tune freely.
 */
export const NEGOTIATOR_CONFIDENCE_THRESHOLD = 0.5;

/** Smallest offer the auto-loop will make. Below this there's no viable deal. */
const MIN_VIABLE_OFFER_USD = 1;

const EPS = 1e-9;

/**
 * Offer states that have COMMITTED campaign budget (an amount we are on the
 * hook for). Summed to compute remaining budget so a new agreement can never
 * push total committed spend over campaigns.total_budget_usd.
 */
// "This deal has committed money at this price." TWO consumers, and both matter:
// the RL price↔output loop (fetchNegotiationHistory) and the campaign budget
// check (campaignCommittedUsd). The DB trigger in migration 045 hardcodes the
// same list, and tests/campaign-budget-migration.test.ts asserts the two are
// byte-identical — so adding a status here without a matching migration makes a
// deal in that status invisible to the structural budget ceiling, i.e. lets a
// campaign overspend. That test caught exactly that when the split-settlement
// states landed.
//
// `undelivered` belongs here, which is worth stating because it looks wrong:
// the creator DID agree at that price, and the failure was delivery, not
// negotiation. Dropping it would quietly remove exactly the deals that went
// badly from the model that sets future prices — the most biased possible
// omission.
const COMMITTED_STATES: OfferStatus[] = [
  'agreed',
  'human_approval_required',
  'approved',
  'paid',
  'deposit_paid',
  'posted',
  'balance_paid',
  'measured',
  'undelivered',
];

// ── RL seam: opening-offer % (implemented in analytics.ts) ───────────────────
//
// The RL opening-offer estimator + the marginal-output helpers now live in
// src/lib/analytics.ts, which owns the price↔output learning loop. negotiation.ts
// delegates the seam to estimateOpeningPct and re-exports the pure helpers +
// types the harness / callers still import from here (stable public surface).

export {
  estimateOpeningPct,
  chooseSweetSpot,
  marginalOutputPerDollar,
};
export type { NegotiationOutcome, OpeningPctContext, OutputPoint };

/** Most-recent closed deals fed to the opening-offer gap correction. */
export const NEGOTIATION_HISTORY_LIMIT = 20;

/**
 * Prior same-firm closed negotiations, mapped to the estimator's
 * NegotiationOutcome shape — the RL feedback signal for where deals actually
 * CLOSE vs where we OPENED. "Closed" = any COMMITTED_STATES status (agreed →
 * measured): the price is negotiated the moment the creator agrees; the later
 * approval/payment/verification steps never change it. Rows missing an
 * opening or agreed amount (or with a non-positive ceiling) carry no gap
 * signal and are dropped. Zero usable rows ⇒ [] ⇒ estimateOpeningPct's
 * cold-start path — identical to pre-S3.4 behavior.
 *
 * Synthetic isolation (real data or clearly-labeled synthetic, never
 * presented as real): offers belonging to `campaigns.synthetic = true`
 * (the [SAMPLE] analytics seed) MUST NOT feed a real campaign's opening-offer
 * RL signal. `creator_offers` has no synthetic column, so we first fetch this
 * firm's synthetic campaign ids and drop their offers in JS. If that lookup
 * can't be resolved, we conservatively return [] (cold-start) rather than
 * risk blending fabricated deals into a real price decision — history is
 * best-effort and never blocks offer creation.
 *
 * Recency ordering + the row cap are applied in JS rather than
 * .order()/.limit(): per-firm closed-deal counts are tiny at this stage, and
 * the hermetic harness store only implements select/eq/in chains.
 */
/**
 * The firm's configured genre premium table, from firms.scraping_prefs.
 *
 * Returns the EMPTY table on any error or missing row — genre-neutral is the
 * correct degradation, and it matches DEFAULT_GENRE_PREMIUMS. Never throws:
 * a settings read must not be able to fail an offer.
 */
export async function fetchFirmGenrePremiums(
  sb: SupabaseClient,
  firm_id: string,
): Promise<Record<string, number>> {
  const { data, error } = await sb
    .from('firms')
    .select('scraping_prefs')
    .eq('id', firm_id)
    .limit(1)
    .single();
  if (error || !data) return {};
  return resolveGenrePremiums({
    scrapingPrefs: (data as { scraping_prefs?: unknown }).scraping_prefs,
  });
}

export async function fetchNegotiationHistory(
  sb: SupabaseClient,
  firm_id: string,
  limit: number = NEGOTIATION_HISTORY_LIMIT,
): Promise<NegotiationOutcome[]> {
  // Synthetic-campaign ids for this firm — offers under these never count.
  const { data: synthRows, error: synthErr } = await sb
    .from('campaigns')
    .select('id')
    .eq('firm_id', firm_id)
    .eq('synthetic', true);
  if (synthErr) return []; // cannot prove cleanliness ⇒ no history, never contaminate
  const syntheticCampaignIds = new Set(
    ((synthRows as Array<{ id: string }> | null) ?? []).map((r) => r.id),
  );

  const { data, error } = await sb
    .from('creator_offers')
    .select('initial_offer_usd, agreed_amount_usd, ceiling_usd, created_at, campaign_id')
    .eq('firm_id', firm_id)
    .in('status', COMMITTED_STATES);
  if (error || !data) return []; // history is best-effort — never block offer creation
  const rows = data as Array<{
    initial_offer_usd: number | null;
    agreed_amount_usd: number | null;
    ceiling_usd: number | null;
    created_at: string | null;
    campaign_id: string | null;
  }>;
  return rows
    .filter(
      (r) =>
        !syntheticCampaignIds.has(r.campaign_id ?? '') &&
        r.initial_offer_usd != null &&
        r.agreed_amount_usd != null &&
        Number(r.ceiling_usd) > 0,
    )
    .sort(
      (a, b) =>
        (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0),
    )
    .slice(0, limit)
    .map((r) => ({
      opening_usd: Number(r.initial_offer_usd),
      agreed_usd: Number(r.agreed_amount_usd),
      ceiling_usd: Number(r.ceiling_usd),
    }));
}

/**
 * Opening offer as a fraction of the per-creator ceiling — the RL seam the
 * negotiation core stubbed. Now backed by the learned estimator in analytics.ts:
 * it nudges the opening from outcome history toward the price↔output equilibrium
 * (marginal-output sweet spot) + the desired-vs-negotiated-price gap, and falls
 * back to the deterministic pricing-engine prior on cold-start. Returns 0 when
 * the ceiling is 0. See estimateOpeningPct for the full mechanics.
 *
 * DO NOT hardcode a fixed %; it falls out of pricing + RL.
 */
export function getOpeningPct(ctx: OpeningPctContext): number {
  return estimateOpeningPct(ctx).opening_pct;
}

// ── Full-auto inbound negotiation ───────────────────────────────────────────

export type AutoOutcome =
  | 'flagged' // injection or low-confidence actionable → human review, no counter
  // The reply is legitimate and readable, but answering it is not the
  // negotiator's call: the package is outside the campaign's deal scope, the
  // model proposed a term we do not recognise, the frozen package is corrupt,
  // or the creator asked a question. Distinct from 'flagged' because nothing
  // here is a security event — labelling a friendly "when do you need it?" as a
  // prompt-injection attempt would train the label to ignore the flag that
  // actually matters. Same destination (a human), different reason.
  | 'needs_human'
  // 'accepted_paid' (agreed + instant auto paper payout, skipping
  // /approvals entirely) no longer exists. EVERY agreement parks at the human
  // gate; approval is what executes the payout, paper or not.
  | 'accepted_pending_approval' // agreed → human_approval_required (all modes)
  | 'countered' // re-offer sent (≤ effective ceiling)
  | 'rejected'
  | 'no_op'; // unclear / question / empty / non-negotiable state — nothing changed

/** Why the auto-negotiator handed a readable reply back to a human. */
export type EscalationKind =
  /** The proposed package is outside the campaign's deal scope. */
  | 'out_of_spec'
  /** The model proposed a term we do not recognise. */
  | 'terms_discarded'
  /** creator_offers.agreed_deliverables did not read back as we wrote it. */
  | 'corrupt_freeze'
  /** The creator asked something before deciding. */
  | 'question_unanswered'
  /** The campaign budget could not be established, so no ceiling
   *  is enforceable. An operator config gap, not a creator problem. */
  | 'budget_unverifiable'
  /** The creator wrote again while our counter
   *  was queued, the counter was withdrawn, and the last price they were
   *  actually sent cannot be read back (sent before migration 059). Raised by
   *  negotiation-tick's fold, never by autoNegotiateInbound itself. */
  | 'sent_price_unknown'
  /** The creator accepted, but their own
   *  words contain a number that is not the last price we sent (or the last
   *  sent price cannot be read back). The AI only ever auto-agrees at a price
   *  WE sent; anything else is a human's call. */
  | 'accept_price_unclear'
  /** The creator countered, but not with exactly
   *  one unambiguous USD figure matching the model's read (non-USD currency,
   *  per-unit or multiplier wording, a range or alternative, or no figure). */
  | 'counter_price_unclear'
  /** The creator wrote again while a counter a
   *  HUMAN had edited was still queued. The edit is withdrawn rather than sent
   *  beside a second counter, and its text goes to the human with the new
   *  reply. Raised by negotiation-tick's fold, never by autoNegotiateInbound. */
  | 'edited_counter_superseded'
  /** The thread is in MANUAL mode: an earlier
   *  escalation handed it to a human, and nothing is agreed or countered
   *  automatically until someone resumes automation from the UI with the
   *  price they last quoted (negotiation-takeover.ts). Raised by the tick. */
  | 'manual_mode'
  /** A DM thread's counter is waiting in the
   *  human DM queue, not yet marked sent, when the creator wrote again. The
   *  draft is kept (it may already be pasted into the DM) and the thread goes
   *  to manual mode instead of being superseded and agreed at an older price.
   *  Raised by the tick. */
  | 'dm_counter_unsent';

export interface EscalationDetail {
  kind: EscalationKind;
  /** One line, safe for an audit row and for the anomaly feed. Never sent to
   *  the creator. */
  detail: string;
  /** Populated for 'out_of_spec'. */
  violations: SpecViolation[];
  /** The package that triggered it, when there was one. */
  proposed_deliverables: Deliverable[] | null;
}

/** audit_log actions that make up the needs-human lane. Mirrors
 *  FISHY_AUDIT_ACTIONS in statuses.ts, which is what surfaces them on
 *  /anomalies. Keep the two in step. */
export const ESCALATION_AUDIT_ACTIONS: Record<EscalationKind, string> = {
  out_of_spec: 'negotiation.out_of_spec_flagged',
  terms_discarded: 'negotiation.terms_discarded',
  corrupt_freeze: 'negotiation.corrupt_freeze',
  question_unanswered: 'negotiation.question_unanswered',
  budget_unverifiable: 'negotiation.budget_unverifiable',
  sent_price_unknown: 'negotiation.sent_price_unknown',
  accept_price_unclear: 'negotiation.accept_price_unclear',
  counter_price_unclear: 'negotiation.counter_price_unclear',
  edited_counter_superseded: 'negotiation.edited_counter_superseded',
  manual_mode: 'negotiation.manual_mode_reply',
  dm_counter_unsent: 'negotiation.dm_counter_unsent',
};

export interface AutoNegotiateContext {
  /** Raw, untrusted creator reply text. */
  inbound_text: string;
  /**
   * The creator's LATEST reply alone, when inbound_text also carries earlier
   * replies read with it (one turn per thread). An acceptance's stated number
   * must appear here: "my usual rate is $180" two emails ago is not what
   * "ok deal" accepts. Defaults to inbound_text.
   */
  latest_inbound_text?: string;
  /**
   * The last price this creator was actually SENT (lastSentOffer over the
   * thread), read by the tick. An acceptance is only ever agreed at this
   * number. null = it cannot be read back → any acceptance goes to
   * a human. 'unreadable' = the thread read failed → the turn is retried.
   * Omitted only by direct callers with no thread (tests): the offer row's
   * standing price stands in.
   */
  last_sent_offer_usd?: number | null | 'unreadable';
  /** inbound_messages / outreach_messages id this reply came from. */
  inbound_message_id: string;
  /** Creator payout destination (ignored in paper mode). */
  recipient_email?: string | null;
  request?: Request;
  /**
   * ms-epoch clock. The tick passes its own so the delivery deadline stamped on
   * an agreement is pinnable in a test; defaults to Date.now() for any caller
   * that does not care.
   */
  now?: number;
}

export interface AutoNegotiateResult {
  row: CreatorOfferRow;
  outcome: AutoOutcome;
  negotiator: NegotiatorOutput | null;
  injection_flags: string[];
  /** Fishy-reply labels (AI-speculation / out-of-context) that forced the flagged lane. */
  fishy_flags: string[];
  decision: CounterDecision | TermTradeDecision | null;
  /** Set whenever outcome is 'needs_human'. Why a human has to look, in a shape
   *  the caller, the tests and the audit row can all read. */
  escalation: EscalationDetail | null;
  /** Amount paid via the paper payout path, when a payout ran. */
  paid_usd: number | null;
  /** The deliverable package a term trade applied (persisted to
   *  creator_offers.agreed_deliverables on accept/counter); null when the
   *  round was price-only. */
  terms_applied: Deliverable[] | null;
  /** The highest amount this creator had already been quoted BEFORE this round
   *  — the ratchet floor. The copy layer needs it to say "down from $X". */
  standing_offer_usd: number;
  /** The package the standing number was quoted for, when this round replaced
   *  it. Null on a price-only round. Lets the copy layer name what was
   *  removed instead of silently quoting a smaller figure. */
  previous_deliverables: Deliverable[] | null;
  reason: string;
}

/**
 * The full-auto entry point. Given a raw inbound reply, run the guarded loop:
 * injection-guard → negotiator LLM (strict schema) → pricing decision under the
 * EFFECTIVE ceiling (per-creator ∧ campaign budget) → auto-advance, and in
 * auto+paper mode auto-execute the paper payout — all without a human in the
 * loop and without ever breaching a cap.
 */
export async function autoNegotiateInbound(
  sb: SupabaseClient,
  offer: CreatorOfferRow,
  ctx: AutoNegotiateContext,
): Promise<AutoNegotiateResult> {
  const result = (over: Partial<AutoNegotiateResult>): AutoNegotiateResult => ({
    row: offer,
    outcome: 'no_op',
    negotiator: null,
    injection_flags: [],
    fishy_flags: [],
    decision: null,
    paid_usd: null,
    terms_applied: null,
    standing_offer_usd: Math.max(
      Number(offer.current_offer_usd ?? 0) || 0,
      Number(offer.initial_offer_usd ?? 0) || 0,
    ),
    previous_deliverables: null,
    escalation: null,
    reason: '',
    ...over,
  });

  // Hand this reply to a human WITHOUT touching the state machine, the price,
  // or the package. Deliberately NOT patchOffer(injection_flagged) — that
  // column means "an attack was attempted", and reusing it for an ordinary
  // out-of-scope proposal would bury the security signal in noise. Deliberately
  // NOT the human_approval_required status either: that state is reachable only
  // from `agreed`, it requires an agreed_amount_usd, and approving there PAYS
  // the creator immediately. Getting to it would mean asserting an agreement
  // that never happened in order to ask whether the agreement should happen.
  // The audit row is the durable record; negotiation-tick marks the inbound
  // row 'flagged', which is what puts it on /anomalies with a link to the
  // thread.
  const escalate = async (
    kind: EscalationKind,
    detail: string,
    extra: {
      violations?: SpecViolation[];
      proposed?: Deliverable[] | null;
      negotiator?: NegotiatorOutput | null;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<AutoNegotiateResult> => {
    await audit(
      {
        action: ESCALATION_AUDIT_ACTIONS[kind],
        actor_label: 'system:auto-negotiator',
        target_type: 'creator_offer',
        target_id: offer.id,
        firm_id: offer.firm_id,
        metadata: {
          escalation_kind: kind,
          detail,
          inbound_message_id: ctx.inbound_message_id,
          rounds: offer.rounds,
          ...(extra.violations?.length ? { violations: extra.violations } : {}),
          ...(extra.proposed ? { proposed_deliverables: extra.proposed } : {}),
          ...(extra.metadata ?? {}),
        },
      },
      ctx.request,
    );
    return result({
      outcome: 'needs_human',
      negotiator: extra.negotiator ?? null,
      escalation: {
        kind,
        detail,
        violations: extra.violations ?? [],
        proposed_deliverables: extra.proposed ?? null,
      },
      reason: detail,
    });
  };

  // 0. Only negotiate from an active offered/counter_offered state. Anything
  //    else (queued, agreed, paid, terminal, …) is a safe no-op.
  if (offer.status !== 'offered' && offer.status !== 'counter_offered') {
    return result({ reason: `offer not in a negotiable state (status=${offer.status})` });
  }

  // 0a. MANUAL MODE. A human has taken this thread over; nothing is
  //     agreed or countered automatically until they resume it. The tick
  //     checks this first (readThreadHold); this is the same rule at the
  //     negotiator's own door, for any other caller.
  if (isHumanTakeover(offer)) {
    return escalate('manual_mode', 'this deal is in manual mode; a human is handling it, so nothing was agreed or countered automatically');
  }

  // 0b. Empty / whitespace inbound = ghost-equivalent. No spend, no change.
  if (!ctx.inbound_text || ctx.inbound_text.trim() === '') {
    return result({ reason: 'empty inbound (ghost): no action, no spend' });
  }

  // 1. Injection guard BEFORE the model sees anything (defense in depth).
  const { fenced, injection_flags } = sanitizeInbound(ctx.inbound_text);
  if (injection_flags.length > 0) {
    const row = await patchOffer(sb, offer.id, { injection_flagged: true });
    await audit(
      {
        action: 'negotiation.injection_flagged',
        actor_label: 'system:auto-negotiator',
        target_type: 'creator_offer',
        target_id: offer.id,
        firm_id: offer.firm_id,
        metadata: { injection_flags, inbound_message_id: ctx.inbound_message_id },
      },
      ctx.request,
    );
    return result({
      row,
      outcome: 'flagged',
      injection_flags,
      reason: `prompt-injection flags: ${injection_flags.join(', ')}`,
    });
  }

  // 1b. Fishy-reply guard: a reply that suspects it's talking
  //     to a bot, or that is an out-of-context non-sequitur vs the negotiation,
  //     is routed to the flagged lane for a human — never auto-answered. Same
  //     lane as injection: set injection_flagged, no model call, no counter.
  const { fishy_flags } = checkReplySanity(ctx.inbound_text);
  if (fishy_flags.length > 0) {
    const row = await patchOffer(sb, offer.id, { injection_flagged: true });
    await audit(
      {
        action: 'negotiation.fishy_flagged',
        actor_label: 'system:auto-negotiator',
        target_type: 'creator_offer',
        target_id: offer.id,
        firm_id: offer.firm_id,
        metadata: { fishy_flags, inbound_message_id: ctx.inbound_message_id },
      },
      ctx.request,
    );
    return result({
      row,
      outcome: 'flagged',
      fishy_flags,
      reason: `fishy reply: ${fishy_flags.join(', ')}`,
    });
  }

  // 1c. The STANDING PACKAGE — what our current price is actually for. Resolved
  //     once, here, and used for three things that must never disagree: the
  //     negotiator's prompt (it cannot spot a package change it was never
  //     shown), the pricing value model, and the package frozen onto the row
  //     when this round lands. Resolved after the guards so a flagged reply
  //     costs no reads; never throws (degrades to the default bundle).
  //
  //     Before resolving it, verify the FROZEN package reads back as we wrote
  //     it. resolveStandingDeliverables degrades a corrupt freeze to the
  //     default bundle without a word, so a deal frozen as three reels would
  //     quietly re-read as "1 reel and 1 story" — in the next counter email, in
  //     the acceptance email, and in the generated contract. A freeze we cannot
  //     read is not a package to guess at.
  const frozen = checkFrozenDeliverables(offer.agreed_deliverables);
  if (!frozen.ok) {
    return escalate('corrupt_freeze', `frozen deal package is unreadable: ${frozen.reason}`);
  }
  const currentDeliverables = await resolveStandingDeliverables(sb, offer);

  // 1d. THE LABEL'S DEAL SCOPE. What this campaign is buying, as
  //     data. Never unbounded: with no campaign rows it is derived from the
  //     package above, so a campaign nobody configured is still guarded.
  const spec: DeliverableSpec = await resolveCampaignSpec(sb, {
    campaignId: offer.campaign_id,
    standing: currentDeliverables,
  });

  // 2. Negotiator LLM (schema mode, no tools). Strict-parse the output.
  let neg: NegotiatorOutput | null = null;
  try {
    const raw = await complete({
      system: NEGOTIATOR_SYSTEM_PROMPT,
      user: buildNegotiatorUserPrompt(fenced, offer, currentDeliverables),
      schema: NEGOTIATOR_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      purpose: 'negotiation.classify',
      campaign_id: offer.campaign_id,
    });
    neg = parseNegotiatorOutput(raw);
  } catch {
    neg = null; // unparseable / provider error → treat as unclear, safe no-op
  }

  // 3. Unparseable, unclear, or a question → safe no-op (no price action).
  if (!neg) {
    return result({ reason: 'negotiator output unparseable → unclear no-op' });
  }
  if (neg.intent === 'unclear') {
    return result({ negotiator: neg, reason: 'intent=unclear → no price action' });
  }
  // A QUESTION IS NOT A NO-OP. This branch used to return here silently, before
  // rounds++ and before anything was scheduled, and negotiation-tick only
  // schedules a send on 'countered' — so the creator was marked processed and
  // never heard back. It fires on the most common friendly reply there is
  // ("sounds good, when do you need it?"), which means the deals it killed were
  // the ones going well.
  //
  // Answering is genuinely out of scope here: a free-text reply about deal
  // terms needs its own generator, its own reference-guard pass and its own
  // tests, and bolting one onto this change would be the least-reviewed part of
  // the most sensitive path. So it escalates instead — visible and answerable
  // by a human in the thread, rather than silently dead.
  if (neg.intent === 'question') {
    return escalate(
      'question_unanswered',
      'the creator asked a question before deciding, and the auto-negotiator does not answer questions',
      { negotiator: neg },
    );
  }
  // The model proposed a term we could not read. Everything about
  // the reply is otherwise valid, which is exactly why this was dangerous: the
  // terms object was dropped, the code fell through to the price-only branch,
  // and a creator who offered a livestream got an acceptance email confirming
  // a reel and a story. An unrecognised term means the conversation left the
  // rails; we do not get to keep negotiating the part we happened to parse.
  if (neg.terms_discarded && (neg.intent === 'accept' || neg.intent === 'counter')) {
    return escalate(
      'terms_discarded',
      `the reply proposed terms we could not read (${neg.terms_discarded}); it is not a price-only reply`,
      { negotiator: neg },
    );
  }
  // A 'counter' with no amount AND no term proposal is NOT an agreement. Never
  // fall back to our own standing offer (that would auto-accept + commit the
  // creator to deliverables they never named, and in auto+paper auto-execute
  // the payout). No-op it. A counter that names a package change but no price
  // ("I'll just do the one reel") continues — the term-trade evaluator only
  // ever COUNTERS with an explicit number in that case, never accepts.
  if (neg.intent === 'counter' && neg.counter_usd == null && !neg.terms) {
    return result({ negotiator: neg, reason: 'intent=counter but no amount → no price action' });
  }

  // 4. Low-confidence ACTIONABLE read → flagged lane (human reviews).
  if (neg.confidence < NEGOTIATOR_CONFIDENCE_THRESHOLD) {
    const row = await patchOffer(sb, offer.id, { injection_flagged: true });
    await audit(
      {
        action: 'negotiation.low_confidence_flagged',
        actor_label: 'system:auto-negotiator',
        target_type: 'creator_offer',
        target_id: offer.id,
        firm_id: offer.firm_id,
        metadata: {
          intent: neg.intent,
          confidence: neg.confidence,
          threshold: NEGOTIATOR_CONFIDENCE_THRESHOLD,
        },
      },
      ctx.request,
    );
    return result({
      row,
      outcome: 'flagged',
      negotiator: neg,
      reason: `confidence ${neg.confidence} < ${NEGOTIATOR_CONFIDENCE_THRESHOLD} → human review`,
    });
  }

  // 4a. FAIL-SAFE PRICE GATES. Checked
  //     HERE, before rounds++, so a reply that goes to a human costs the
  //     negotiation nothing.
  //
  //     The AI may only auto-agree at a price WE SENT. An acceptance goes
  //     through only when the creator's own latest words contain no number, or
  //     only the last price we sent; ANY other number ("posting Oct 15", "500
  //     saves", "€300", "300 per video") goes to a human with the reply and
  //     the last sent price beside it. An earlier version tried to read which
  //     numbers were money and agree at the creator's; every heuristic had a case that
  //     sent "Deal, $X works" at a price nobody agreed. This one does not guess.
  //
  //     A counter goes through the normal path only when the reply states one
  //     unambiguous USD figure and it is the one the model read.
  const latestReply = ctx.latest_inbound_text ?? ctx.inbound_text;
  const replyExcerpt = (() => {
    const t = latestReply.replace(/\s+/g, ' ').trim();
    return t.length > 280 ? `${t.slice(0, 279)}…` : t;
  })();
  const ourStanding = Number(offer.current_offer_usd ?? offer.initial_offer_usd ?? 0);
  let lastSentUsd: number | null;
  if (ctx.last_sent_offer_usd === 'unreadable') {
    // A transient thread-read failure must RETRY, not park (same reasoning as
    // the budget read below): the tick's catch leaves the reply pending.
    throw new Error('last_sent_read_failed: the thread could not be read to find the last price sent');
  } else if (ctx.last_sent_offer_usd === undefined) {
    lastSentUsd = Number.isFinite(ourStanding) && ourStanding > 0 ? ourStanding : null;
  } else {
    lastSentUsd = ctx.last_sent_offer_usd;
  }
  const sentLabel = lastSentUsd == null ? 'unknown' : `$${lastSentUsd}`;
  // The anomaly feed shows the first ~140 characters of `detail`, so the two
  // things a human needs to decide (what we sent, what they wrote) lead it.
  const shortReply = replyExcerpt.length > 90 ? `${replyExcerpt.slice(0, 89)}…` : replyExcerpt;
  const lead = `Last price sent ${sentLabel}; they wrote "${shortReply}"`;
  const priceMeta = { last_sent_offer_usd: lastSentUsd, reply_excerpt: replyExcerpt };
  let acceptAtUsd: number | null = null;
  // A yes with qualifying wording ("Deal, but I can only do the
  // reel") that ALSO proposes a package change goes to the term trade, which
  // prices the new package and counters. It may never auto-close:
  // `qualifiedYes` makes step 8 refuse an 'accept' decision for it.
  let qualifiedYes: string | null = null;
  if (neg.intent === 'accept') {
    const proposesPackage =
      neg.terms != null &&
      (neg.terms.promo_type != null || neg.terms.quantity != null || neg.terms.min_seconds != null);
    const numbers = acceptanceNumberGate(latestReply, lastSentUsd);
    const wording = acceptanceWordingGate(latestReply);
    if (numbers.ok && !wording.ok && proposesPackage) qualifiedYes = wording.reason;
    const gate: PriceGate = !numbers.ok ? numbers : wording.ok || proposesPackage ? { ok: true } : wording;
    if (!gate.ok) {
      return escalate(
        'accept_price_unclear',
        `${lead}. They said yes, but ${gate.reason}`,
        { negotiator: neg, metadata: priceMeta },
      );
    }
    // Our records must agree on what was sent. A standing price that is not
    // the last sent one (a draft that never went) is not something to agree
    // at, and not something to silently pick between.
    if (lastSentUsd == null || Math.abs(ourStanding - lastSentUsd) >= 0.005) {
      return escalate(
        'accept_price_unclear',
        `${lead}. They said yes, but the standing offer on record ($${ourStanding}) is not the last price sent`,
        { negotiator: neg, metadata: { ...priceMeta, standing_offer_usd: ourStanding } },
      );
    }
    acceptAtUsd = lastSentUsd;
  }
  if (neg.intent === 'counter' && neg.counter_usd != null) {
    const gate = counterGate(latestReply, neg.counter_usd);
    if (!gate.ok) {
      return escalate(
        'counter_price_unclear',
        `${lead}. They countered, but ${gate.reason}`,
        { negotiator: neg, metadata: { ...priceMeta, model_counter_usd: neg.counter_usd } },
      );
    }
    // CPM slice S4 (data capture): the creator's FIRST asking price, from the
    // structured number the gate above just validated against their own words.
    // Recorded once (conditional on NULL), read by nothing here, never throws;
    // pre-062 it is skipped silently.
    await recordFirstAsk(sb, offer as { id: string; first_ask_usd?: unknown }, neg.counter_usd);
  }

  // 4b. Term-level proposal: when the reply renegotiates the
  //     PACKAGE, build the proposed one against the standing package resolved
  //     at 1c. Garbage terms → null → price-only path, unchanged.
  let proposedDeliverables: Deliverable[] | null = null;
  if (neg.terms && (neg.intent === 'accept' || neg.intent === 'counter')) {
    proposedDeliverables = applyTermsToDeliverables(neg.terms, currentDeliverables);
    // The SECOND way a term proposal disappears (same class as
    // terms_discarded above but a different function): the terms parsed
    // cleanly, and applyTermsToDeliverables still refused to build a package
    // because a value was outside its plausibility bounds — "I could do 5000
    // reels". Returning null there is correct; treating null as "they were
    // talking about price" is not. The creator named a package, so the reply is
    // about the package, and a counter that quietly re-quotes the old bundle
    // answers a question they did not ask.
    //
    // A terms object carrying ONLY a schedule_note is not a package proposal —
    // "sounds good, I can post Friday" must keep flowing through the normal
    // path, so the escalation requires a package-bearing field.
    const proposedAPackage =
      neg.terms.promo_type != null || neg.terms.quantity != null || neg.terms.min_seconds != null;
    if (!proposedDeliverables && proposedAPackage) {
      return escalate(
        'terms_discarded',
        'the reply proposed a package we could not build (values outside the plausibility bounds); it is not a price-only reply',
        { negotiator: neg },
      );
    }
  }

  // 4c. SCOPE GATE. Checked HERE, before rounds++ and before any
  //     state transition, so an escalation costs the negotiation nothing — the
  //     deal comes back exactly as the human left it. evaluateTermTrade checks
  //     the same predicate again on the same spec; two independent gates over
  //     one shared function, the way the ratchet is enforced in the evaluators
  //     and re-derived again at the last gate before the wire. Neither can be
  //     removed without the other still holding.
  if (proposedDeliverables) {
    const violations = checkPackageAgainstSpec(proposedDeliverables, spec);
    if (violations.length > 0) {
      return escalate(
        'out_of_spec',
        `the creator proposed a package outside this campaign's deal scope: ${describeSpecViolations(violations)}`,
        { violations, proposed: proposedDeliverables, negotiator: neg },
      );
    }
  }
  // The package this round lands on: the traded one if a trade happened, else
  // the package that was already on the table. A price-only round is NOT a
  // package-less round — the creator was quoted a price FOR something, and the
  // record has to say what. (Before this, a plain "sure, $200 works" recorded
  // an amount and nothing else, while the acceptance email had already named a
  // package pulled from the default bundle.)
  const landedDeliverables: Deliverable[] = proposedDeliverables ?? currentDeliverables;
  // Terms present but unusable AND no price named → nothing actionable.
  if (neg.intent === 'counter' && neg.counter_usd == null && !proposedDeliverables) {
    return result({
      negotiator: neg,
      reason: 'intent=counter with no amount and no usable terms → no price action',
    });
  }

  // 5. Effective ceiling = min(per-creator ceiling, remaining campaign budget).
  const eff = await computeEffectiveCeiling(sb, offer);

  // 5b. FAIL CLOSED, matching spend-caps.ts. If the campaign budget
  //     could not be established there is no enforceable campaign cap, and
  //     negotiating anyway means quoting a number against a limit nobody can
  //     check. Escalating rather than rejecting is deliberate and mirrors the
  //     caps module's posture: this is a gate, not a dead end. An unset budget
  //     is an operator config gap, so the offer must stay live and negotiable
  //     the moment someone sets one; a 'rejected' transition is terminal and
  //     would record the creator as having declined something they never saw.
  if (eff.budget_unverifiable) {
    // A transient read failure must RETRY, not park (review finding N1).
    // Escalating sets the inbound row to 'flagged', and 'flagged' is not in
    // PENDING_INBOUND_STATUSES — there is no requeue path anywhere in the
    // codebase, so a one-off PostgREST blip would strand a real creator reply
    // permanently. Throwing lands in negotiation-tick's poison-row catch, which
    // leaves the row pending and reprocesses it on the next tick. Only the
    // durable config gap belongs in the escalation lane.
    if (eff.unverifiable_kind === 'unreadable') {
      throw new Error(`budget_read_failed: ${eff.unverifiable_reason}`);
    }
    return escalate(
      'budget_unverifiable',
      `campaign budget is not enforceable: ${eff.unverifiable_reason}`,
      { negotiator: neg },
    );
  }

  // 6. Land the counter round (rounds++). We deliberately do NOT write the
  //    creator's number into current_offer_usd — an over-ask would violate the
  //    DB's current_within_ceiling CHECK, and our own last offer is the right
  //    anchor for evaluateCounter.
  //
  //    We also do NOT stamp last_message_id here: that column is a FK to
  //    outreach_messages(id), but ctx.inbound_message_id is an inbound_messages
  //    queue id (a different table) — writing it trips
  //    creator_offers_last_message_id_fkey. The inbound id is preserved in the
  //    audit metadata below for traceability instead.
  const ourOffer = Number(offer.current_offer_usd ?? offer.initial_offer_usd ?? 0);
  // RATCHET FLOOR — the HIGHEST amount this creator has already
  // seen from us, not the most recent one. Both columns are numbers that were
  // actually put in front of them: initial_offer_usd is what makeInitialOffer
  // sent, and current_offer_usd is overwritten by every counter we send.
  //
  // Taking the MAX (rather than trusting current_offer_usd) matters for two
  // reasons. It is what makes the invariant hold on rows the bug already
  // damaged — offer 519baf66 carries initial $165 / current $126, and the max
  // recovers the real standing number so the next round cannot compound the
  // drop. And it is why this needs no new column: once the ratchet holds,
  // current_offer_usd is non-decreasing except through the sanctioned
  // scope-reduction path, so max(initial, current) IS the high-water mark.
  //
  // Deliberately conservative after a sanctioned scope reduction: the opening
  // number stays in the max even though it bought a bigger package, so a later
  // round whose effective ceiling has dropped between the reduced quote and the
  // opening REFUSES instead of countering. Refusing surfaces the offer for a
  // human; the alternative is sending a number that contradicts something this
  // creator has already read. The safe direction for a floor is up.
  const standingOfferUsd = Math.max(
    ourOffer,
    Number(offer.initial_offer_usd ?? 0) || 0,
  );
  const landed = await applyTransition(sb, offer.id, 'counter_offered', {
    rounds: offer.rounds + 1,
  });

  // 7. Map intent → a pricing-engine decision under the EFFECTIVE ceiling.
  //
  // An acceptance is priced at the last price we SENT, always (4a refused
  // every other shape). The engine still checks it against the effective
  // ceiling, so a budget that shrank since we sent it refuses, never pays.
  const acceptedUsd = neg.intent === 'accept' ? acceptAtUsd : null;
  const counterAmount = acceptedUsd ?? neg.counter_usd ?? ourOffer;
  let decision: CounterDecision | TermTradeDecision;
  if (neg.intent === 'reject') {
    decision = { action: 'reject', reason: 'creator declined (intent=reject)' };
  } else if (eff.ceiling < MIN_VIABLE_OFFER_USD) {
    // Budget exhausted (or no per-creator headroom): cannot make a viable
    // offer without breaching a cap → reject. Never breach.
    decision = {
      action: 'reject',
      reason: `no headroom under caps (effective ceiling $${eff.ceiling.toFixed(2)})`,
    };
  } else if (proposedDeliverables) {
    // Term trade: price the proposed package against the standing one. An
    // 'accept' with changed terms means "your price, my package" — evaluate at
    // our standing offer; a reduced package then yields a LOWER counter, never
    // an auto-pay at the old price. Same money guards: the effective ceiling
    // bounds every branch, and the same clamps below still apply.
    decision = evaluateTermTrade({
      current_offer_usd: ourOffer,
      standing_offer_usd: standingOfferUsd,
      counter_usd: acceptedUsd ?? neg.counter_usd,
      ceiling_usd: eff.ceiling,
      rounds: landed.rounds,
      current_deliverables: currentDeliverables,
      proposed_deliverables: proposedDeliverables,
      // The second gate. 4c already refused an out-of-spec package before the
      // round was landed; this one means no future branch can reach an
      // acceptance by skipping that check.
      spec,
    });
  } else {
    decision = evaluateCounter({
      current_offer_usd: ourOffer,
      standing_offer_usd: standingOfferUsd,
      counter_offer_usd: counterAmount,
      ceiling_usd: eff.ceiling,
      rounds: landed.rounds,
    });
  }

  // 8. Apply the decision. The landed package is persisted to
  //    creator_offers.agreed_deliverables on BOTH accept (the final contract
  //    state) and counter (the standing package the newly quoted price is for),
  //    whether or not this round changed it. Whatever we quote a price for,
  //    we record.
  //
  //    'escalate' is unreachable from here in practice — gate 4c returns before
  //    the round is landed. It is handled anyway, and handled FIRST, so that if
  //    4c is ever refactored away this path still cannot accept or counter an
  //    out-of-scope package. The one cost is the burnt round, which is the
  //    right thing to lose in that trade.
  if (decision.action === 'escalate') {
    return escalate('out_of_spec', decision.reason, {
      violations: decision.violations,
      proposed: decision.deliverables,
      negotiator: neg,
    });
  }

  if (decision.action === 'accept' && qualifiedYes) {
    // A qualified yes may counter through the term trade, never close.
    return escalate(
      'accept_price_unclear',
      `${lead}. They said yes with a package change, but ${qualifiedYes}`,
      { negotiator: neg, proposed: proposedDeliverables, metadata: priceMeta },
    );
  }

  if (decision.action === 'accept') {
    // NO downward clamp here. Clamping silently rewrote an acceptance into a
    // number the creator never agreed to (creator says $160, remaining budget
    // is $50, we record "agreed $50" and auto-pay it) AND it made
    // finalizeAgreement's agreed_above_cap_guard unreachable. Same class of
    // bug as the ratchet: a recomputation producing a worse-for-the-creator
    // number than the one already on the table. The cap is enforced by
    // refusing, not by quietly paying less.
    const fin = await finalizeAgreement(
      sb,
      landed,
      decision.agreed_amount_usd,
      eff,
      ctx,
      landedDeliverables,
    );
    return result({
      row: fin.row,
      outcome: fin.outcome,
      negotiator: neg,
      decision,
      paid_usd: fin.paid_usd,
      terms_applied: fin.outcome === 'rejected' ? null : proposedDeliverables,
      reason: decision.reason,
    });
  }

  if (decision.action === 'counter') {
    // LAST GATE BEFORE THE WIRE. The evaluators enforce the ratchet by
    // construction, but the ceiling clamp used to live HERE and it is exactly
    // the kind of late arithmetic that can undo an invariant established
    // upstream. Re-deriving both bounds at the point of persistence means no
    // future counter-producing branch can bypass them by skipping an
    // evaluator. On a floor-above-ceiling collision the ceiling wins and we
    // reject instead of sending a number we cannot honor.
    const gated = applyCounterRatchet(decision.new_offer_usd, {
      standing_offer_usd: standingOfferUsd,
      ceiling_usd: eff.ceiling,
      asked_usd: neg.counter_usd,
      package_reduced: proposedDeliverables
        ? bundleValueUnits(proposedDeliverables) < bundleValueUnits(currentDeliverables) - EPS
        : false,
    });
    if (!gated.ok) {
      const rejected = await applyTransition(sb, offer.id, 'rejected', {});
      await audit(
        {
          action: 'negotiation.auto_rejected',
          actor_label: 'system:auto-negotiator',
          target_type: 'creator_offer',
          target_id: offer.id,
          firm_id: offer.firm_id,
          metadata: {
            reason: 'ratchet_floor_above_ceiling',
            standing_offer_usd: standingOfferUsd,
            effective_ceiling_usd: eff.ceiling,
            per_creator_ceiling_usd: offer.ceiling_usd,
            computed_counter_usd: decision.new_offer_usd,
            rounds: rejected.rounds,
          },
        },
        ctx.request,
      );
      return result({
        row: rejected,
        outcome: 'rejected',
        negotiator: neg,
        decision,
        reason: gated.reason,
      });
    }
    const newOffer = gated.amount;
    const row = await applyTransition(sb, offer.id, 'offered', {
      current_offer_usd: newOffer,
      agreed_deliverables: landedDeliverables,
    });
    await audit(
      {
        action: 'negotiation.auto_counter_sent',
        actor_label: 'system:auto-negotiator',
        target_type: 'creator_offer',
        target_id: offer.id,
        firm_id: offer.firm_id,
        metadata: {
          counter_received_usd: counterAmount,
          counter_sent_usd: newOffer,
          standing_offer_usd: standingOfferUsd,
          effective_ceiling_usd: eff.ceiling,
          per_creator_ceiling_usd: offer.ceiling_usd,
          rounds: row.rounds,
          deliverables: landedDeliverables,
          ...(proposedDeliverables ? { terms_changed: true, proposed_deliverables: proposedDeliverables } : {}),
        },
      },
      ctx.request,
    );
    return result({
      row,
      outcome: 'countered',
      negotiator: neg,
      decision,
      terms_applied: proposedDeliverables,
      standing_offer_usd: standingOfferUsd,
      previous_deliverables: proposedDeliverables ? currentDeliverables : null,
      reason: decision.reason,
    });
  }

  // reject
  const row = await applyTransition(sb, offer.id, 'rejected', {});
  await audit(
    {
      action: 'negotiation.auto_rejected',
      actor_label: 'system:auto-negotiator',
      target_type: 'creator_offer',
      target_id: offer.id,
      firm_id: offer.firm_id,
      metadata: {
        counter_received_usd: counterAmount,
        effective_ceiling_usd: eff.ceiling,
        per_creator_ceiling_usd: offer.ceiling_usd,
        rounds: row.rounds,
        reason: decision.reason,
      },
    },
    ctx.request,
  );
  return result({ row, outcome: 'rejected', negotiator: neg, decision, reason: decision.reason });
}

export type AcceptancePrice =
  | { kind: 'at_sent'; usd: number }
  | { kind: 'escalate'; reason: string };

/**
 * What an acceptance may be agreed at: the last
 * price we sent, and only when the creator's latest words name no number or
 * only that one. Everything else is a human's call. Pure; the negotiator runs
 * the same gate (acceptanceGate) plus the standing-vs-sent record check.
 */
export function acceptancePrice(
  latestReply: string,
  lastSentUsd: number | null | undefined,
): AcceptancePrice {
  const gate = acceptanceGate(latestReply, lastSentUsd);
  if (!gate.ok) return { kind: 'escalate', reason: gate.reason };
  return { kind: 'at_sent', usd: Number(lastSentUsd) };
}

/**
 * The negotiator's user turn. It carries BOTH halves of the standing offer —
 * the dollar figure and the package that figure buys. The model is asked to
 * detect a package change (`terms`), which it cannot do against a package it
 * was never shown: fed price alone, "make it two reels instead" reads as a
 * price-only reply. The package is our own text, not creator input, so it sits
 * outside the untrusted-data fence.
 */
function buildNegotiatorUserPrompt(
  fenced: string,
  offer: CreatorOfferRow,
  deliverables: Deliverable[],
): string {
  const our = Number(offer.current_offer_usd ?? offer.initial_offer_usd ?? 0);
  const ask = describeDeliverables(deliverables);
  return [
    `Our current outstanding offer to this creator is $${our}.`,
    ...(ask
      ? [`That price is for this package of deliverables: ${ask}.`,
         'Set `terms` only if the reply proposes changing THAT package.']
      : []),
    'Classify the creator reply below and return ONLY the JSON object.',
    '',
    fenced,
  ].join('\n');
}

export interface EffectiveCeiling {
  /** min(per-creator ceiling, remaining campaign budget). */
  ceiling: number;
  /** null when the campaign budget could not be established. */
  remaining_budget: number | null;
  /** null — never 0 — when no budget was established, so the audit trail can
   *  never imply a ceiling that was never set. spend-caps.ts:167 idiom. */
  total_budget: number | null;
  /**
   * FAIL CLOSED. True when the campaign budget could not be
   * established: unset/zero/NaN, a failed or empty campaign read, or a failed
   * committed-spend read. The caller must escalate rather than negotiate; an
   * unenforceable cap is not an absent cap.
   */
  budget_unverifiable: boolean;
  /**
   * WHICH kind of unverifiable, because they need opposite handling.
   * 'unset'      — a durable operator config gap. Escalate: a human has to go
   *                set a budget, and no amount of retrying changes that.
   * 'unreadable' — a transient database failure. RETRY: throwing puts the
   *                inbound row back in the tick's poison-row lane, which
   *                leaves it pending and reprocesses it next tick.
   */
  unverifiable_kind: 'unset' | 'unreadable' | null;
  /** Why, for the audit row. Empty when the budget resolved cleanly. */
  unverifiable_reason: string;
}

/**
 * Compute the effective ceiling for an offer: the smaller of the per-creator
 * ceiling and the campaign's remaining budget. Feeding this to evaluateCounter
 * is what makes BOTH caps un-breachable in one place.
 */
export async function computeEffectiveCeiling(
  sb: SupabaseClient,
  offer: CreatorOfferRow,
): Promise<EffectiveCeiling> {
  const perCreator = Number(offer.ceiling_usd);
  const closed = (
    kind: 'unset' | 'unreadable',
    reason: string,
  ): EffectiveCeiling => ({
    ceiling: 0,
    remaining_budget: null,
    total_budget: null,
    budget_unverifiable: true,
    unverifiable_kind: kind,
    unverifiable_reason: reason,
  });

  // FAIL CLOSED on an unverifiable read. `error` was previously not even
  // destructured: a PostgREST failure, an RLS denial and a zero-row .single()
  // all collapsed to camp === null → totalBudget 0 → "no cap", so a campaign
  // whose budget we could not READ was negotiated as if it had none.
  const { data: camp, error: campErr } = await sb
    .from('campaigns')
    .select('total_budget_usd')
    .eq('id', offer.campaign_id)
    .single();
  if (campErr || !camp) {
    return closed(
      'unreadable',
      `campaign budget could not be read (${campErr?.message ?? 'campaign_not_found'})`,
    );
  }

  const budget = resolveCampaignBudget(
    (camp as { total_budget_usd: number | null }).total_budget_usd,
  );
  // FAIL CLOSED on an unset budget, the same rule spend-caps.ts applies to the
  // payout path: no configured
  // budget means no enforceable ceiling, and an unenforceable cap is not the
  // same thing as an absent one. Migration 037's
  // campaigns_confirmed_requires_caps makes it unreachable through the normal
  // path; the code should not depend on a CHECK constraint to be correct.
  if (!budget.ok) return closed('unset', CAMPAIGN_BUDGET_NOT_SET);

  // FAIL CLOSED on an unverifiable committed-spend read — the third fail-open
  // in this function, and the one the issue does not mention. It swallowed its
  // error and read as $0 committed, i.e. FULL budget headroom, which is the
  // most dangerous possible default.
  const committed = await campaignCommittedUsd(sb, offer.campaign_id, offer.id);
  if (committed == null) {
    return closed('unreadable', 'committed campaign spend could not be read');
  }

  const remaining = budget.totalBudgetUsd - committed;
  return {
    ceiling: Math.max(0, Math.min(perCreator, remaining)),
    remaining_budget: remaining,
    total_budget: budget.totalBudgetUsd,
    budget_unverifiable: false,
    unverifiable_kind: null,
    unverifiable_reason: '',
  };
}

/**
 * Sum of committed spend for a campaign, optionally excluding one offer (the
 * one being negotiated). Also the committed term of the first-touch budget
 * pacing gate (src/lib/first-touch-gate.ts), which passes null — one
 * definition of "committed" for both.
 */
export async function campaignCommittedUsd(
  sb: SupabaseClient,
  campaign_id: string,
  excludeOfferId: string | null,
): Promise<number | null> {
  let q = sb
    .from('creator_offers')
    .select('id, status, agreed_amount_usd, current_offer_usd, deposit_paid_usd')
    .eq('campaign_id', campaign_id)
    .in('status', COMMITTED_STATES);
  if (excludeOfferId) q = q.neq('id', excludeOfferId);
  const { data, error } = await q;
  // null, not 0: "I could not read the committed spend" and "nothing is
  // committed" are opposite facts, and conflating them handed the negotiator
  // the entire budget as headroom whenever the query failed.
  if (error) return null;
  const rows = (data ?? []) as Array<{
    id: string;
    agreed_amount_usd: number | null;
    current_offer_usd: number | null;
    deposit_paid_usd?: number | null;
    status?: string | null;
  }>;
  return rows.reduce((sum, r) => sum + committedContribution(r), 0);
}

/**
 * What one offer contributes to a campaign's committed spend.
 *
 * `undelivered` contributes only the DEPOSIT that actually left, not the full
 * agreed amount — the balance was never sent, and counting it would permanently
 * hold budget the label never spent, against a ceiling that then refuses deals
 * it can in fact afford. Every other committed status contributes the agreed
 * amount, falling back to the current offer.
 *
 * MUST stay identical to the `case` in the migration-045 trigger (updated by
 * migration 054). tests/campaign-budget-migration.test.ts pins that.
 */
export function committedContribution(row: {
  status?: string | null;
  agreed_amount_usd: number | null;
  current_offer_usd: number | null;
  deposit_paid_usd?: number | null;
}): number {
  if (row.status === 'undelivered') return Number(row.deposit_paid_usd ?? 0);
  return Number(row.agreed_amount_usd ?? row.current_offer_usd ?? 0);
}

/**
 * Take an agreed amount to the human gate. EVERY agreement — manual or auto,
 * paper or real money — parks at human_approval_required, and the
 * payment_authorizations row is minted immediately so the deal shows up in
 * /approvals with no extra click. Approval is what executes the payout
 * (spend caps re-checked). The amount is re-checked against the effective
 * ceiling first (belt-and-suspenders on evaluateCounter).
 *
 * This used to auto-execute the payout when autonomy === 'auto'
 * and the payment mode resolved to 'paper' — agreed → paid with no approval
 * row and no cap check. Since stripe-isolated.ts silently resolves to
 * 'paper' on four separate guard failures (missing/malformed key), a key
 * problem could quietly disable the human money gate while still marking
 * deals paid and emailing creators. Sandbox-ness and "no human needs to see
 * this" are different questions; the gate no longer conflates them.
 */
async function finalizeAgreement(
  sb: SupabaseClient,
  offer: CreatorOfferRow,
  agreedAmount: number,
  eff: EffectiveCeiling,
  ctx: AutoNegotiateContext,
  /** The package this agreement is FOR — the traded one when the round
   *  renegotiated terms, otherwise the standing one. Frozen into
   *  agreed_deliverables so the record matches the acceptance email. */
  deliverables: Deliverable[] | null = null,
): Promise<{ row: CreatorOfferRow; outcome: AutoOutcome; paid_usd: number | null }> {
  // Hard invariant: never agree above the effective ceiling.
  if (agreedAmount > eff.ceiling + EPS) {
    const row = await applyTransition(sb, offer.id, 'rejected', {});
    await audit(
      {
        action: 'negotiation.auto_rejected',
        actor_label: 'system:auto-negotiator',
        target_type: 'creator_offer',
        target_id: offer.id,
        firm_id: offer.firm_id,
        metadata: {
          reason: 'agreed_above_cap_guard',
          agreed_amount_usd: agreedAmount,
          effective_ceiling_usd: eff.ceiling,
        },
      },
      ctx.request,
    );
    return { row, outcome: 'rejected', paid_usd: null };
  }

  const autonomy = offer.autonomy_mode ?? 'auto';
  const mode = resolvePaymentMode();

  // Stamp the outside date for delivery at the moment the deal closes, from the
  // package the creator just agreed to (migration 052). Stamped unconditionally,
  // NOT behind the split flag: the date is the same fact either way, it is what
  // the acceptance email should be telling the creator, and if a firm enables the
  // split later, deals closed before that must already carry a deadline rather
  // than being un-expirable forever. The sweeper only ever acts on a
  // `deposit_paid` row, so a stamped date does nothing on its own.
  const agreedAtMs = ctx.now ?? Date.now();
  const deliverByIso = new Date(
    deliverByMs(agreedAtMs, deliverables ?? offer.agreed_deliverables),
  ).toISOString();

  const agreedRow = await applyTransition(sb, offer.id, 'agreed', {
    agreed_amount_usd: agreedAmount,
    deliver_by: deliverByIso,
    ...(deliverables && deliverables.length ? { agreed_deliverables: deliverables } : {}),
  });
  await audit(
    {
      action: 'negotiation.agreed',
      actor_label: 'system:auto-negotiator',
      target_type: 'creator_offer',
      target_id: offer.id,
      firm_id: offer.firm_id,
      metadata: {
        agreed_amount_usd: agreedAmount,
        autonomy_mode: autonomy,
        payment_mode: mode,
        rounds: agreedRow.rounds,
        deliver_by: deliverByIso,
        ...(deliverables && deliverables.length ? { agreed_deliverables: deliverables } : {}),
      },
    },
    ctx.request,
  );

  // Learning spine: the opening-offer ACTUAL — the paired outcome event for
  // createOffer's opening_offer prediction (join key: creator_offer_id in
  // input_data). Written the moment the price is negotiated; approval/payment
  // never change it. Never throws; synthetic campaigns excluded inside.
  await logLearning(sb, {
    event_type: LEARNING_EVENTS.OPENING_OFFER_OUTCOME,
    campaign_id: offer.campaign_id,
    input_data: {
      creator_offer_id: offer.id,
      rounds: agreedRow.rounds,
      ceiling_usd: offer.ceiling_usd,
      initial_offer_usd: offer.initial_offer_usd,
      opening_pct: offer.opening_pct,
    },
    predicted_value:
      offer.opening_pct != null && Number(offer.ceiling_usd) > 0
        ? {
            agreed_amount_usd:
              Math.round(Number(offer.opening_pct) * Number(offer.ceiling_usd) * 100) / 100,
          }
        : null,
    actual_value: { agreed_amount_usd: agreedAmount },
  });

  // UNCONDITIONAL human gate. No autonomy/payment-mode combination
  // may skip it.
  const row = await applyTransition(sb, offer.id, 'human_approval_required', {});
  await audit(
    {
      action: 'negotiation.pending_human_approval',
      actor_label: 'system:auto-negotiator',
      target_type: 'creator_offer',
      target_id: offer.id,
      firm_id: offer.firm_id,
      metadata: {
        agreed_amount_usd: agreedAmount,
        reason:
          autonomy !== 'auto'
            ? 'manual_mode'
            : mode === 'paper'
              ? 'paper_mode_human_gate'
              : 'non_paper_payment_mode',
        payment_mode: mode,
      },
    },
    ctx.request,
  );

  // Mint the payment_authorizations row (pending_human_review) so the deal
  // appears in /approvals with no extra "Create payment auth" click — the
  // undocumented manual step it used to need. Minting is not money: a human
  // approval (which re-runs every spend cap) still stands between this row
  // and any payout. Failure here is soft — the offer stays parked at
  // human_approval_required and the manual authorize route still works.
  try {
    const minted = await authorizePaymentForOffer(
      sb,
      { creatorOfferId: offer.id, callerFirmId: offer.firm_id, actorUserId: null },
      {
        audit: (entry) =>
          audit({ ...entry, actor_label: 'system:auto-negotiator' }, ctx.request),
      },
    );
    if (minted.httpStatus !== 200) {
      await audit(
        {
          action: 'negotiation.payment_auth_automint_failed',
          actor_label: 'system:auto-negotiator',
          target_type: 'creator_offer',
          target_id: offer.id,
          firm_id: offer.firm_id,
          metadata: { http_status: minted.httpStatus, ...minted.body },
        },
        ctx.request,
      );
    }
  } catch (e) {
    // Never let approval-row bookkeeping unwind an agreement that already
    // happened. But never silent either: a thrown mint used to reach only the
    // log, and the deal read "waiting on your approval" with nothing in
    // /approvals. Audited like a non-2xx, so /anomalies shows it with
    // "Create payment for approval".
    console.warn('[negotiation] payment-auth automint failed', e);
    try {
      await audit(
        {
          action: 'negotiation.payment_auth_automint_failed',
          actor_label: 'system:auto-negotiator',
          target_type: 'creator_offer',
          target_id: offer.id,
          firm_id: offer.firm_id,
          metadata: { http_status: null, error: (e as Error)?.message ?? String(e) },
        },
        ctx.request,
      );
    } catch {
      /* the log line above is the fallback */
    }
  }

  return { row, outcome: 'accepted_pending_approval', paid_usd: null };
}

/**
 * Open a negotiable offer for a creator we just contacted.
 *
 * THE GAP THIS CLOSES
 *   `createOffer` and `makeInitialOffer` had ZERO production callers. The only
 *   path that ever created a `creator_offers` row was /api/campaigns/[id]/
 *   quick-offer, which inserts directly at 'agreed' and promotes straight to
 *   'human_approval_required'. And `autoNegotiateInbound` no-ops on anything
 *   that is not 'offered' or 'counter_offered' (see its step 0).
 *
 *   So the entire auto-negotiator was unreachable: a real creator replying to a
 *   real campaign resolved to a `human_approval_required` offer, no-opped, and
 *   the inbound was marked processed rather than flagged — invisible unless a
 *   manager happened to open the thread. Every negotiation test constructs an
 *   'offered' offer as a fixture, which is why the suites were green over a
 *   path production never took.
 *
 *   Sending outreach IS the initial offer. This is that wire.
 *
 * CONTRACT
 *   - Idempotent: a creator who already has an offer is returned unchanged.
 *     The send route may be retried, and a second offer would double-count the
 *     campaign budget.
 *   - Never throws. The email has already left by the time this runs; a pricing
 *     hiccup must not turn a delivered message into a 500 the operator retries.
 *     A null return means "no offer opened" and is logged, not raised.
 *   - Honours the per-creator ceiling as the cap. A campaign with no
 *     `per_creator_cap_usd` gets no offer rather than an invented ceiling —
 *     the ceiling is enforced by a DB CHECK (migration 009) and guessing it
 *     here would be inventing the one number the structural guard depends on.
 */
export async function openOfferForSentOutreach(
  sb: SupabaseClient,
  input: {
    campaign_influencer_id: string;
    campaign_id: string;
    firm_id: string;
    outreach_message_id: string;
    follower_count: number | null;
    engagement_rate: number | null;
    genre?: string | null;
    /**
     * The creator's platform, from the influencer row the caller already
     * holds. Picks the engagement calibration curve: without it createOffer
     * saw platform=null and priced Instagram creators on TikTok's curve
     * (20k followers, 3.2% ER opened at $82 instead of $134). When omitted it
     * is read from the creator row below.
     */
    platform?: string | null;
    request?: Request;
  },
): Promise<CreatorOfferRow | null> {
  try {
    const { data: existing } = await sb
      .from('creator_offers')
      .select('*')
      .eq('campaign_influencer_id', input.campaign_influencer_id)
      .limit(1)
      .maybeSingle();
    if (existing) return existing as unknown as CreatorOfferRow;

    const { data: camp } = await sb
      .from('campaigns')
      .select('per_creator_cap_usd')
      .eq('id', input.campaign_id)
      .single();
    const cap = Number((camp as { per_creator_cap_usd: number | null } | null)?.per_creator_cap_usd);
    if (!Number.isFinite(cap) || cap <= 0) {
      negotiationLog.warn('no per-creator cap, not opening an offer', {
        campaign_id: input.campaign_id,
        campaign_influencer_id: input.campaign_influencer_id,
      });
      return null;
    }

    // One read of the creator row serves both the pricer (platform) and the
    // CPM shadow (raw_data), which loaded this same row itself before. The
    // caller's platform wins when it carries one.
    const profile = await loadCreatorProfile(sb, input.campaign_influencer_id);
    const creator_profile: CreatorProfile = {
      platform: input.platform ?? profile?.platform ?? null,
      raw_data: profile?.raw_data ?? null,
    };

    const queued = await createOffer(sb, {
      campaign_influencer_id: input.campaign_influencer_id,
      campaign_id: input.campaign_id,
      firm_id: input.firm_id,
      follower_count: Number(input.follower_count ?? 0) || 0,
      engagement_rate: Number(input.engagement_rate ?? 0) || 0,
      genre: input.genre ?? null,
      per_creator_cap_usd: cap,
      creator_profile,
    });

    return await makeInitialOffer(sb, queued, {
      outreach_message_id: input.outreach_message_id,
      request: input.request,
    });
  } catch (e) {
    negotiationLog.error('could not open an offer for a sent message', {
      campaign_influencer_id: input.campaign_influencer_id,
      outreach_message_id: input.outreach_message_id,
      error: (e as Error).message,
    });
    return null;
  }
}
