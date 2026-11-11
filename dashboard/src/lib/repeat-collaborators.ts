// src/lib/repeat-collaborators.ts
//
// The "worked before" roster — the creators this firm has ACTUALLY closed
// deals with, ranked by how well those deals performed.
//
// A label ends up with its go-to creators: the people who match a release and
// ride the line better than others. The value of the product converges on a learned roster of
// repeat collaborators, so this module is the read-model behind it.
//
// PURE, DETERMINISTIC, TESTABLE. No DB, no I/O, no clock, no rng — same
// doctrine as src/lib/analytics.ts and src/lib/statuses.ts. The route
// (/api/influencers/roster) does the firm-scoped reads and hands the rows
// here; everything that decides *what the label sees* lives in this file so
// tests/repeat-collaborators.test.ts can drive it with in-memory rows.
//
// COMPUTED ON READ. There is no `repeat_collaborators` table, no cached rank,
// no `is_favorite` flag, no migration. A roster is a fact about the deal
// history, so it is derived from the deal history every time. A stored rank is
// a second source of truth that goes stale silently.
//
// Self-contained by necessity: src/lib/creator-performance.ts is not on this
// branch's base (origin/main @ a31580c), so there is nothing to import for the
// per-deal math. The only shared helpers used are cpm-model.ts (labelCpm /
// latestSnapshot) and the CLOSED_STATUSES set in statuses.ts.
//
// ── The honesty rules this module is built around ──────────────────────────
//
//   1. NULL OVER A FABRICATED ZERO. A creator with no verified reach gets
//      `realized_label_cpm: null` — never 0, and never a CPM inferred from
//      follower counts. Zero is a measurement ("we looked, it was zero");
//      null is the absence of one. `labelCpm()` in cpm-model.ts already
//      refuses to divide by an unknown reach; this module never papers over
//      that null on the way out.
//
//   2. REFUSE TO STATE A RANKING SIGNAL WE DO NOT HAVE. Creators are not
//      ranked against each other on a metric one of them is missing. They are
//      bucketed by what is actually known (`rank_basis`), best-evidence bucket
//      first, and sorted inside their bucket. A creator with no verified reach
//      is never given a placeholder CPM so the sort can proceed.
//
//   3. EVERY GAP IS NAMED. `unknowns[]` carries a plain-English sentence for
//      each thing this row cannot claim, so the surface can print the reason
//      instead of a blank or a dash.
//
//   4. SYNTHETIC DATA NEVER COUNTS. Offers under `campaigns.synthetic = true`
//      (the [SAMPLE] analytics seed, migration 021) are dropped before any
//      math, exactly as negotiation.ts's `fetchNegotiationHistory` and
//      measurement-tick.ts's scrape filter do. A fabricated deal must never
//      make a creator look like a proven go-to.
//
//   5. NO PER-CREATOR CAUSAL STREAM ATTRIBUTION. Read the doctrine at the top
//      of src/lib/stream-lift.ts: per-creator causation is NOT identifiable
//      from an artist-level rolling metric when posts overlap, and no deal
//      ever receives a share of a campaign's listener delta. Nothing in this
//      file reads, derives, or re-exports `streams_attributed`, and no field
//      here claims a creator moved streams. The only value signal used is
//      DELIVERED IMPRESSIONS on the creator's own post — an observation from
//      `deal_performance_snapshots`, not a causal claim about the artist.
//      "Realized label CPM" therefore means exactly "dollars committed per
//      1,000 views we actually measured on the posts they delivered", and
//      nothing more.

import { labelCpm, latestSnapshot } from './cpm-model';
import { CLOSED_STATUSES } from './statuses';

// ── Input row shapes (subsets of the live tables the route reads) ───────────

/** `campaigns`. `synthetic` is the [SAMPLE] seed flag (migration 021). */
export interface RosterCampaignRow {
  id: string;
  synthetic?: boolean | null;
}

/** `campaign_influencers` — the campaign ↔ influencer join. */
export interface RosterLinkRow {
  id: string;
  campaign_id: string;
  influencer_id: string;
}

/**
 * `creator_offers` — the negotiation state machine (migration 009) and the
 * real deal entity. The legacy `deals` table is unreferenced by any code.
 * Money columns are NUMERIC(10,2) in DOLLARS, never cents.
 */
export interface RosterOfferRow {
  id: string;
  campaign_id: string | null;
  campaign_influencer_id: string | null;
  status: string;
  agreed_amount_usd: number | null;
  current_offer_usd: number | null;
  approved_at?: string | null;
  paid_at?: string | null;
  posted_at?: string | null;
  created_at?: string | null;
}

/** `influencers` — the SHARED cross-firm creator pool (no firm_id column). */
export interface RosterInfluencerRow {
  id: string;
  platform?: string | null;
  username?: string | null;
  display_name?: string | null;
  follower_count?: number | null;
  avatar_url?: string | null;
  content_genres?: string[] | null;
}

/** `deal_deliveries` — one delivered post (migration 029 + spec_check in 036). */
export interface RosterDeliveryRow {
  id: string;
  creator_offer_id: string;
  /** pending | verified | missing — existence of the post. */
  status: string;
  /** pass | fail | partial — does the post match the agreed spec. Null until checked. */
  spec_check?: string | null;
}

/** `deal_performance_snapshots` — measured reach on a delivered post. */
export interface RosterSnapshotRow {
  deal_delivery_id: string;
  captured_at: string;
  views?: number | null;
}

export interface RepeatCollaboratorsInput {
  campaigns: RosterCampaignRow[];
  links: RosterLinkRow[];
  offers: RosterOfferRow[];
  influencers: RosterInfluencerRow[];
  deliveries: RosterDeliveryRow[];
  snapshots: RosterSnapshotRow[];
}

// ── Output shapes ───────────────────────────────────────────────────────────

/**
 * Which signal this row was ranked on. Ordered best-evidence first; a row is
 * only ever compared against other rows carrying the SAME basis.
 */
export type RankBasis = 'realized_cpm' | 'delivery_reliability' | 'deal_count';

/** Which timestamp `last_worked_at` came from — so the surface can't overclaim. */
export type LastWorkedBasis = 'posted' | 'paid' | 'approved' | 'agreed';

export interface DeliveryReliability {
  /** deal_deliveries rows attached to this creator's closed deals. */
  promised: number;
  verified: number;
  missing: number;
  /** Promised but not yet resolved either way. An open question, not a miss. */
  pending: number;
  /**
   * verified ÷ (verified + missing). Null when nothing has resolved yet.
   *
   * Pending rows are deliberately OUT of the denominator: a deal closed
   * yesterday has not broken a promise, and counting it as a miss would
   * publish a made-up failure rate against the newest — often best — creators.
   * `promised` and `pending` are reported alongside so nothing is hidden.
   */
  rate: number | null;
  spec_pass: number;
  spec_partial: number;
  spec_fail: number;
  /** pass ÷ checked. Null when no delivery has been spec-checked yet. */
  spec_pass_rate: number | null;
}

export interface CpmBasis {
  /** Closed deals that carried at least one measured view. */
  deals: number;
  /** Σ latest measured views across those deals' posts. */
  reach: number;
  /** Σ dollars committed on those deals — the CPM numerator. */
  spend_usd: number;
}

export interface RepeatCollaborator {
  influencer_id: string;
  platform: string | null;
  /** The handle. `influencers` has no `handle` column — username is it. */
  username: string | null;
  display_name: string | null;
  follower_count: number | null;
  content_genres: string[] | null;
  avatar_url: string | null;

  /** Closed deals (CLOSED_STATUSES) with this firm. Always >= 1. */
  deals_closed: number;
  /** Distinct campaigns of this firm the creator has closed a deal on. */
  campaigns_worked: number;
  /**
   * Closed deals carrying no price at all — neither agreed nor standing. They
   * are excluded from `total_spend_usd` and from the CPM basis rather than
   * counted as $0, and disclosed in `unknowns`.
   */
  deals_unpriced: number;
  /**
   * Σ agreed (else standing) dollars across the closed deals that HAVE a
   * price. Read together with `deals_unpriced`: when that is non-zero this is
   * a floor, not a total.
   */
  total_spend_usd: number;
  /** Median agreed price. Null when no deal has an agreed amount recorded. */
  median_agreed_usd: number | null;

  delivery: DeliveryReliability;

  /**
   * Dollars committed per 1,000 MEASURED views on the posts this creator
   * delivered. Null when no post of theirs has measured reach — never 0, and
   * never estimated from followers. See doctrine note 5: delivered
   * impressions, not attributed streams.
   */
  realized_label_cpm: number | null;
  /** What the CPM was computed from. Null exactly when the CPM is null. */
  cpm_basis: CpmBasis | null;

  last_worked_at: string | null;
  last_worked_basis: LastWorkedBasis | null;

  rank_basis: RankBasis;
  /** Plain-English sentence per thing this row cannot claim. */
  unknowns: string[];
}

export interface RepeatCollaboratorsResult {
  /** Ranked best-repeat-bet first. */
  collaborators: RepeatCollaborator[];
  /** Firm-level rollup over the rows above. */
  totals: {
    creators: number;
    deals_closed: number;
    total_spend_usd: number;
    with_realized_cpm: number;
  };
  /** Synthetic ([SAMPLE]) campaigns excluded before any math ran. */
  excluded_synthetic_campaigns: number;
  /** Closed offers dropped because they belong to a synthetic campaign. */
  excluded_synthetic_offers: number;
}

// ── Small helpers ───────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const finite = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The dollars a closed deal has committed: agreed wins, else the standing
 * offer. Mirrors `offerSpend()` in analytics.ts — the same rule, restated
 * rather than imported because `AnalyticsOfferRow` demands ceiling/opening
 * columns this read-model has no reason to fetch. If that rule changes, both
 * places change.
 *
 * NULL when neither price is recorded, and that is load-bearing. Both columns
 * are nullable (migration 009) with no CHECK tying either to a closed status,
 * so an unpriced closed deal is representable. analytics.ts can coalesce to 0
 * because it is summing a budget; here the number becomes a CPM NUMERATOR, and
 * a $0 numerator is not "free" — it is the best possible score. A creator with
 * one unpriced measured deal would otherwise outrank everyone alive, and
 * mixing one priced deal with one unpriced one would halve the reported CPM
 * with nothing on the row to say so. An unknown price is excluded from spend
 * and from the CPM basis, and counted in `deals_unpriced`.
 */
function dealSpend(o: RosterOfferRow): number | null {
  const agreed = finite(o.agreed_amount_usd);
  if (agreed !== null) return agreed;
  return finite(o.current_offer_usd);
}

/** Standard median. Even counts average the two middle values. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return round2(s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

/**
 * When a closed deal last involved real work, and which fact says so.
 *
 * `creator_offers` has no closed_at column, and `updated_at` is touched by
 * every write (trigger, migration 009) so it is not a close date. The ordered
 * fallback below is most-concrete first: a post going live beats a payment,
 * which beats an approval, which beats the agreement row itself. Publishing
 * the basis stops the surface printing "last posted" over a deal that was only
 * ever agreed.
 */
function lastWorked(o: RosterOfferRow): { at: string; basis: LastWorkedBasis } | null {
  const candidates: Array<[string | null | undefined, LastWorkedBasis]> = [
    [o.posted_at, 'posted'],
    [o.paid_at, 'paid'],
    [o.approved_at, 'approved'],
    [o.created_at, 'agreed'],
  ];
  for (const [value, basis] of candidates) {
    if (typeof value === 'string' && value.trim() !== '') {
      if (Number.isFinite(Date.parse(value))) return { at: value, basis };
    }
  }
  return null;
}

const CLOSED = new Set<string>(CLOSED_STATUSES);

// ── The roster ──────────────────────────────────────────────────────────────

/**
 * Build the firm's "worked before" roster from already-firm-scoped rows.
 *
 * FIRM SCOPING IS THE CALLER'S JOB and is not re-derivable here: `influencers`
 * is a SHARED cross-firm table with no firm_id at all (migration 007 makes the
 * sharing explicit), so an influencer_id filter proves nothing. The route
 * passes only THIS firm's campaigns, and this function walks
 * campaigns → campaign_influencers → creator_offers, so an offer whose
 * campaign is not in the supplied set is structurally unreachable. That is the
 * scope boundary: a row that arrives without a matching campaign is dropped,
 * never guessed at.
 *
 * Deterministic: no clock, no rng, and every sort ends in an id tie-break, so
 * the same rows always produce the same order.
 */
export function buildRepeatCollaborators(
  input: RepeatCollaboratorsInput
): RepeatCollaboratorsResult {
  // ── 1. Drop synthetic campaigns before anything is counted ────────────────
  const syntheticIds = new Set(
    input.campaigns.filter((c) => c.synthetic === true).map((c) => c.id)
  );
  const realCampaignIds = new Set(
    input.campaigns.filter((c) => c.synthetic !== true).map((c) => c.id)
  );

  // ── 2. campaign_influencer_id → influencer_id, real campaigns only ────────
  const linkToInfluencer = new Map<string, string>();
  const linkToCampaign = new Map<string, string>();
  for (const l of input.links) {
    if (!realCampaignIds.has(l.campaign_id)) continue;
    linkToInfluencer.set(l.id, l.influencer_id);
    linkToCampaign.set(l.id, l.campaign_id);
  }

  // ── 3. Keep only closed offers that resolve to a real, in-scope campaign ──
  let excludedSyntheticOffers = 0;
  const closedOffers: RosterOfferRow[] = [];
  for (const o of input.offers) {
    if (!CLOSED.has(o.status)) continue;
    if (o.campaign_id != null && syntheticIds.has(o.campaign_id)) {
      excludedSyntheticOffers++;
      continue;
    }
    const linkId = o.campaign_influencer_id;
    if (linkId == null) continue;
    if (!linkToInfluencer.has(linkId)) continue; // out of scope, or synthetic
    closedOffers.push(o);
  }

  // ── 4. Index deliveries and their latest measured reach ───────────────────
  const deliveriesByOffer = new Map<string, RosterDeliveryRow[]>();
  for (const d of input.deliveries) {
    const list = deliveriesByOffer.get(d.creator_offer_id);
    if (list) list.push(d);
    else deliveriesByOffer.set(d.creator_offer_id, [d]);
  }

  const snapshotsByDelivery = new Map<string, RosterSnapshotRow[]>();
  for (const s of input.snapshots) {
    const list = snapshotsByDelivery.get(s.deal_delivery_id);
    if (list) list.push(s);
    else snapshotsByDelivery.set(s.deal_delivery_id, [s]);
  }

  /**
   * Measured views on one delivery: the newest snapshot only. Snapshots are a
   * time series of the same post, so summing them would double-count the same
   * impressions. 0 means "no measurement", and callers treat it as unknown —
   * it never reaches the output as a reach of zero.
   */
  function deliveryReach(deliveryId: string): number {
    const snaps = snapshotsByDelivery.get(deliveryId);
    if (!snaps || snaps.length === 0) return 0;
    const latest = latestSnapshot(
      snaps.map((s) => ({ captured_at: s.captured_at, views: s.views }))
    );
    const views = finite(latest?.views);
    return views !== null && views > 0 ? views : 0;
  }

  const influencerById = new Map(input.influencers.map((i) => [i.id, i]));

  // ── 5. Fold offers into per-creator accumulators ──────────────────────────
  interface Acc {
    dealsClosed: number;
    dealsUnpriced: number;
    campaigns: Set<string>;
    totalSpend: number;
    agreedPrices: number[];
    promised: number;
    verified: number;
    missing: number;
    pending: number;
    specPass: number;
    specPartial: number;
    specFail: number;
    cpmDeals: number;
    cpmReach: number;
    cpmSpend: number;
    lastAt: string | null;
    lastBasis: LastWorkedBasis | null;
    lastMs: number;
  }

  const blank = (): Acc => ({
    dealsClosed: 0,
    dealsUnpriced: 0,
    campaigns: new Set<string>(),
    totalSpend: 0,
    agreedPrices: [],
    promised: 0,
    verified: 0,
    missing: 0,
    pending: 0,
    specPass: 0,
    specPartial: 0,
    specFail: 0,
    cpmDeals: 0,
    cpmReach: 0,
    cpmSpend: 0,
    lastAt: null,
    lastBasis: null,
    lastMs: Number.NEGATIVE_INFINITY,
  });

  const acc = new Map<string, Acc>();

  for (const o of closedOffers) {
    const linkId = o.campaign_influencer_id as string;
    const influencerId = linkToInfluencer.get(linkId);
    if (!influencerId) continue;

    let a = acc.get(influencerId);
    if (!a) {
      a = blank();
      acc.set(influencerId, a);
    }

    a.dealsClosed++;
    const campaignId = o.campaign_id ?? linkToCampaign.get(linkId);
    if (campaignId) a.campaigns.add(campaignId);

    const spend = dealSpend(o);
    if (spend === null) a.dealsUnpriced++;
    else a.totalSpend += spend;
    const agreed = finite(o.agreed_amount_usd);
    if (agreed !== null) a.agreedPrices.push(agreed);

    // Delivery reliability + spec verdicts.
    const deliveries = deliveriesByOffer.get(o.id) ?? [];
    let offerReach = 0;
    for (const d of deliveries) {
      a.promised++;
      if (d.status === 'verified') a.verified++;
      else if (d.status === 'missing') a.missing++;
      else a.pending++;

      if (d.spec_check === 'pass') a.specPass++;
      else if (d.spec_check === 'partial') a.specPartial++;
      else if (d.spec_check === 'fail') a.specFail++;

      offerReach += deliveryReach(d.id);
    }

    // CPM basis: a deal needs BOTH a measured view and a known price.
    //
    // Unmeasured spend cannot enter the numerator — that would charge the
    // reach we did measure for reach we never saw, inventing a worse creator.
    // And an unpriced deal cannot enter either: its reach would land in the
    // denominator with $0 against it, silently dragging the CPM toward zero
    // and inventing a better one. Both halves must be known or the deal sits
    // out, and `deals_unpriced` / the "covers N of M" line say that it did.
    if (offerReach > 0 && spend !== null) {
      a.cpmDeals++;
      a.cpmReach += offerReach;
      a.cpmSpend += spend;
    }

    const lw = lastWorked(o);
    if (lw) {
      const ms = Date.parse(lw.at);
      if (ms > a.lastMs) {
        a.lastMs = ms;
        a.lastAt = lw.at;
        a.lastBasis = lw.basis;
      }
    }
  }

  // ── 6. Project each accumulator into a row ────────────────────────────────
  const collaborators: RepeatCollaborator[] = [];
  for (const [influencerId, a] of acc) {
    const inf = influencerById.get(influencerId);

    const resolved = a.verified + a.missing;
    const reliability = resolved > 0 ? round2(a.verified / resolved) : null;
    const specChecked = a.specPass + a.specPartial + a.specFail;
    const specPassRate = specChecked > 0 ? round2(a.specPass / specChecked) : null;

    const cpm = a.cpmReach > 0 ? labelCpm(a.cpmSpend, a.cpmReach) : null;
    const cpmBasis: CpmBasis | null =
      cpm === null
        ? null
        : { deals: a.cpmDeals, reach: a.cpmReach, spend_usd: round2(a.cpmSpend) };

    const unknowns: string[] = [];
    if (cpm === null) {
      unknowns.push(
        'No measured views on their posts yet, so cost per 1,000 views is unknown.'
      );
    } else {
      if (a.cpmDeals === 1) {
        unknowns.push(
          'Cost per 1,000 views comes from a single deal: thin evidence so far.'
        );
      }
      if (a.cpmDeals < a.dealsClosed) {
        unknowns.push(
          `Cost per 1,000 views covers ${a.cpmDeals} of ${a.dealsClosed} deals; the rest have no measured views.`
        );
      }
    }
    if (reliability === null) {
      unknowns.push(
        a.promised === 0
          ? 'No posts recorded against these deals, so delivery reliability is unknown.'
          : 'Every promised post is still outstanding, so delivery reliability is unknown.'
      );
    } else if (a.pending > 0) {
      unknowns.push(
        `${a.pending} promised post${a.pending === 1 ? ' is' : 's are'} still outstanding, not counted for or against them.`
      );
    }
    if (specPassRate === null && a.promised > 0) {
      unknowns.push('No post has been spec-checked yet.');
    }
    if (a.agreedPrices.length === 0) {
      unknowns.push('No agreed price recorded, so median price is unknown.');
    }
    if (a.dealsUnpriced > 0) {
      unknowns.push(
        `${a.dealsUnpriced} of ${a.dealsClosed} deals have no price on record, so they are left out of spend and of cost per 1,000 views rather than counted as $0.`
      );
    }
    // Never claim a creator moved streams. See the stream-lift.ts doctrine.
    unknowns.push(
      'Their share of any streaming lift is not identifiable and is not claimed.'
    );

    const rankBasis: RankBasis =
      cpm !== null
        ? 'realized_cpm'
        : reliability !== null
          ? 'delivery_reliability'
          : 'deal_count';

    collaborators.push({
      influencer_id: influencerId,
      platform: inf?.platform ?? null,
      username: inf?.username ?? null,
      display_name: inf?.display_name ?? null,
      follower_count: finite(inf?.follower_count),
      content_genres: inf?.content_genres ?? null,
      avatar_url: inf?.avatar_url ?? null,
      deals_closed: a.dealsClosed,
      campaigns_worked: a.campaigns.size,
      deals_unpriced: a.dealsUnpriced,
      total_spend_usd: round2(a.totalSpend),
      median_agreed_usd: median(a.agreedPrices),
      delivery: {
        promised: a.promised,
        verified: a.verified,
        missing: a.missing,
        pending: a.pending,
        rate: reliability,
        spec_pass: a.specPass,
        spec_partial: a.specPartial,
        spec_fail: a.specFail,
        spec_pass_rate: specPassRate,
      },
      realized_label_cpm: cpm,
      cpm_basis: cpmBasis,
      last_worked_at: a.lastAt,
      last_worked_basis: a.lastBasis,
      rank_basis: rankBasis,
      unknowns,
    });
  }

  collaborators.sort(compareRepeatCollaborators);

  return {
    collaborators,
    totals: {
      creators: collaborators.length,
      deals_closed: collaborators.reduce((s, c) => s + c.deals_closed, 0),
      total_spend_usd: round2(
        collaborators.reduce((s, c) => s + c.total_spend_usd, 0)
      ),
      with_realized_cpm: collaborators.filter((c) => c.realized_label_cpm !== null).length,
    },
    excluded_synthetic_campaigns: syntheticIds.size,
    excluded_synthetic_offers: excludedSyntheticOffers,
  };
}

// ── Ranking ─────────────────────────────────────────────────────────────────

const BASIS_ORDER: Record<RankBasis, number> = {
  realized_cpm: 0,
  delivery_reliability: 1,
  deal_count: 2,
};

const lastWorkedMs = (c: RepeatCollaborator): number =>
  c.last_worked_at === null ? Number.NEGATIVE_INFINITY : Date.parse(c.last_worked_at);

/**
 * Best repeat bet first — WITHOUT ever comparing two creators on a number one
 * of them does not have.
 *
 * Buckets, strongest evidence first:
 *   1. `realized_cpm`         — measured views exist. Sort by CPM ASCENDING:
 *                               cpm-model.ts is explicit that lower cost per
 *                               1,000 delivered impressions is better, and it
 *                               is the objective the RL loop optimizes down.
 *   2. `delivery_reliability` — no measured views, but posts have resolved.
 *                               Sort by verified-rate descending.
 *   3. `deal_count`           — they closed deals and nothing else is known
 *                               yet. Sort by deal count descending.
 *
 * There is deliberately NO blended score. A weighted composite across these
 * three would require inventing a stand-in value for whichever input is
 * missing, which is the exact fabrication this module exists to avoid. The
 * bucket is published as `rank_basis` so the surface can say which question
 * each creator is winning, and a thin CPM basis is disclosed in `unknowns`
 * rather than silently suppressed by a minimum-sample cutoff nobody specified.
 *
 * Every comparison ends on `influencer_id` so the order is total and stable.
 */
export function compareRepeatCollaborators(
  a: RepeatCollaborator,
  b: RepeatCollaborator
): number {
  const basis = BASIS_ORDER[a.rank_basis] - BASIS_ORDER[b.rank_basis];
  if (basis !== 0) return basis;

  if (a.rank_basis === 'realized_cpm') {
    // Both are in this bucket, so both CPMs are non-null by construction.
    const cpm = (a.realized_label_cpm as number) - (b.realized_label_cpm as number);
    if (cpm !== 0) return cpm; // lower CPM first
  } else if (a.rank_basis === 'delivery_reliability') {
    const rate = (b.delivery.rate as number) - (a.delivery.rate as number);
    if (rate !== 0) return rate; // higher reliability first
  }

  if (a.deals_closed !== b.deals_closed) return b.deals_closed - a.deals_closed;

  // Recency, normalised to ±1.
  //
  // `lastWorkedMs` returns -Infinity for a creator with no date, so exactly one
  // side missing gives ±Infinity here. The previous `Number.isFinite` guard
  // discarded that as if it were a tie and fell through to the id compare,
  // which made the order INTRANSITIVE: with A(id 'b', no date), B(id 'a', Jan)
  // and C(id 'c', Feb) you got cmp(A,B)=+1, cmp(B,C)=+1 but cmp(A,C)=-1. V8
  // does not throw on that, it just returns an arbitrary permutation. Only a
  // genuine both-missing tie is NaN, and that is the one case to skip.
  const recency = lastWorkedMs(b) - lastWorkedMs(a);
  if (!Number.isNaN(recency) && recency !== 0) return recency > 0 ? 1 : -1;

  return a.influencer_id < b.influencer_id ? -1 : a.influencer_id > b.influencer_id ? 1 : 0;
}
