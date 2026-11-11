// src/lib/deliverables.ts
//
// The promo-deliverables model. A deal carries concrete
// deliverables — story / post / reel / dance_trend — each with a quantity and a
// delivery window, not just a dollar figure. This module owns the enum, the
// relative pricing weights, and the pure helpers used by pricing, the
// negotiator, and copy generation. No DB access here (that stays in the
// data-access + negotiation layers); this is pure logic so it is trivially
// testable.

export const PROMO_TYPES = ['story', 'post', 'reel', 'dance_trend'] as const;
export type PromoType = (typeof PROMO_TYPES)[number];

export function isPromoType(v: unknown): v is PromoType {
  return typeof v === 'string' && (PROMO_TYPES as readonly string[]).includes(v);
}

/** Human labels for copy + UI. Singular; pluralize at the call site. */
export const PROMO_LABEL: Record<PromoType, string> = {
  story: 'story',
  post: 'feed post',
  reel: 'reel',
  dance_trend: 'dance/trend video',
};

// Relative effort/value weight per promo type, anchored to a standard feed post
// (post = 1.0). A story is lighter/ephemeral; a reel is more production; an
// original dance/trend video is the heaviest lift and the highest reach upside.
// Bundle base price = Σ (weight × quantity) × the campaign's per-unit rate.
export const PROMO_WEIGHT: Record<PromoType, number> = {
  story: 0.4,
  post: 1.0,
  reel: 1.3,
  dance_trend: 1.8,
};

export interface Deliverable {
  promo_type: PromoType;
  quantity: number;
  delivery_window_days: number;
  /** Minimum video length in seconds for time-based types (reel, dance_trend,
   *  video story). A 5-second reel is not a 30/60-second reel. Null = length-
   *  agnostic (feed post) or unspecified. */
  min_seconds?: number | null;
  unit_price_usd?: number | null;
  /** Short sanitized timing phrase from term negotiation, e.g.
   *  "can post next week". Persisted for the frozen contract state; NEVER
   *  echoed into outbound copy (describeDeliverables ignores it). Sanitized
   *  upstream by injection-guard's sanitizeScheduleNote before it gets here. */
  schedule_note?: string | null;
}

// Promo types where a minimum length is meaningful, with a sensible default.
export const TIME_BASED_DEFAULT_SECONDS: Partial<Record<PromoType, number>> = {
  reel: 30,
  dance_trend: 30,
  story: 15,
};

/**
 * Coerce arbitrary input (DB jsonb, LLM output, form body) into a clean,
 * de-duplicated Deliverable[]. Drops invalid rows rather than throwing so a
 * bad line never breaks the negotiation path. One line per promo_type (last
 * wins), quantity/window floored to >= 1.
 */
export function normalizeDeliverables(input: unknown): Deliverable[] {
  if (!Array.isArray(input)) return [];
  const byType = new Map<PromoType, Deliverable>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (!isPromoType(r.promo_type)) continue;
    const quantity = Math.max(1, Math.floor(Number(r.quantity ?? 1)) || 1);
    const windowDays = Math.max(1, Math.floor(Number(r.delivery_window_days ?? 14)) || 14);
    const unit =
      r.unit_price_usd == null || Number.isNaN(Number(r.unit_price_usd))
        ? null
        : Math.round(Number(r.unit_price_usd) * 100) / 100;
    const secsRaw = Math.floor(Number(r.min_seconds));
    const minSeconds =
      r.min_seconds == null || !Number.isFinite(secsRaw) || secsRaw <= 0
        ? TIME_BASED_DEFAULT_SECONDS[r.promo_type] ?? null
        : secsRaw;
    // Carry a sanitized schedule note through DB round-trips (frozen contract
    // state). Hygiene only — the injection scrub happens at parse time, and
    // nothing downstream echoes this into copy.
    const note =
      typeof r.schedule_note === 'string' && r.schedule_note.trim()
        ? r.schedule_note.trim().slice(0, 200)
        : null;
    byType.set(r.promo_type, {
      promo_type: r.promo_type,
      quantity,
      delivery_window_days: windowDays,
      min_seconds: minSeconds,
      unit_price_usd: unit,
      schedule_note: note,
    });
  }
  // Stable order by the canonical PROMO_TYPES sequence.
  return PROMO_TYPES.filter((t) => byType.has(t)).map((t) => byType.get(t) as Deliverable);
}

/** Σ (weight × quantity) across the bundle — the effort units used for pricing. */
export function bundleWeight(deliverables: Deliverable[]): number {
  return deliverables.reduce((sum, d) => sum + PROMO_WEIGHT[d.promo_type] * d.quantity, 0);
}

/** Total explicit price if every line carries a unit_price_usd (else null). */
export function bundleExplicitPriceUsd(deliverables: Deliverable[]): number | null {
  if (deliverables.length === 0) return null;
  let total = 0;
  for (const d of deliverables) {
    if (d.unit_price_usd == null) return null;
    total += d.unit_price_usd * d.quantity;
  }
  return Math.round(total * 100) / 100;
}

/** The widest delivery window in the bundle (days) — the deal's due horizon. */
export function maxWindowDays(deliverables: Deliverable[]): number {
  return deliverables.reduce((mx, d) => Math.max(mx, d.delivery_window_days), 0);
}

/**
 * Plain-English deliverable summary for negotiation copy, e.g.
 * "2 reels and 1 dance/trend video within 2 weeks". No em-dashes, no hype —
 * matches the humanizer rules the negotiator copy already follows.
 *
 * READING ORDER IS FIXED HERE, heaviest deliverable first, and is deliberately
 * independent of storage order. normalizeDeliverables() canonicalizes to
 * PROMO_TYPES order (lightest first) on every DB round-trip, so without this
 * sort the same package would read "reel and story" before it was persisted
 * and "story and reel" after — the creator would watch the wording flip
 * mid-thread. Leading with the main ask also just reads better.
 */
export function describeDeliverables(deliverables: Deliverable[]): string {
  if (deliverables.length === 0) return '';
  const ordered = [...deliverables].sort((a, b) => {
    const byWeight = PROMO_WEIGHT[b.promo_type] - PROMO_WEIGHT[a.promo_type];
    if (byWeight !== 0) return byWeight;
    // Equal weight can only mean the same promo_type (normalizeDeliverables
    // collapses duplicates), but keep it total so the phrasing is stable.
    return PROMO_TYPES.indexOf(a.promo_type) - PROMO_TYPES.indexOf(b.promo_type);
  });
  const parts = ordered.map((d) => {
    // Prefix the length for time-based types: "2 30-second reels".
    const lengthPrefix = d.min_seconds ? `${d.min_seconds}-second ` : '';
    const label = `${lengthPrefix}${PROMO_LABEL[d.promo_type]}`;
    const plural = d.quantity === 1 ? label : `${label}s`;
    return `${d.quantity} ${plural}`;
  });
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  const window = maxWindowDays(deliverables);
  return `${list} within ${describeWindow(window)}`;
}

/**
 * Plain-English description of what a package change REMOVED, e.g.
 * "1 15-second story". Null when nothing was dropped or reduced.
 *
 * When a counter quotes less than the number already on the table
 * because the package shrank, the message has to name the removal. Quoting a
 * smaller figure and letting the creator work out why is the same failure as
 * quoting backwards — it just hides better.
 *
 * Counts a line as removed when it disappears, and as reduced when its
 * quantity drops (reporting the difference). Same reading order as
 * describeDeliverables: heaviest first.
 */
export function describePackageReduction(
  before: Deliverable[],
  after: Deliverable[],
): string | null {
  const afterByType = new Map(after.map((d) => [d.promo_type, d]));
  const dropped: Deliverable[] = [];
  for (const b of before) {
    const a = afterByType.get(b.promo_type);
    const lostQty = a ? b.quantity - a.quantity : b.quantity;
    if (lostQty > 0) dropped.push({ ...b, quantity: lostQty });
  }
  if (dropped.length === 0) return null;
  const ordered = [...dropped].sort(
    (a, b) => PROMO_WEIGHT[b.promo_type] - PROMO_WEIGHT[a.promo_type],
  );
  const parts = ordered.map((d) => {
    const lengthPrefix = d.min_seconds ? `${d.min_seconds}-second ` : '';
    const label = `${lengthPrefix}${PROMO_LABEL[d.promo_type]}`;
    return `${d.quantity} ${d.quantity === 1 ? label : `${label}s`}`;
  });
  return parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function describeWindow(days: number): string {
  if (days <= 0) return 'the agreed window';
  if (days % 7 === 0) {
    const weeks = days / 7;
    return weeks === 1 ? '1 week' : `${weeks} weeks`;
  }
  return days === 1 ? '1 day' : `${days} days`;
}

// ── Term-level negotiation ──────────────────────────────────────────────────
//
// A creator reply can renegotiate the PACKAGE, not just the price ("one 30s
// reel but no story"). The negotiator LLM surfaces that as a TermsPatch; this
// helper deterministically converts it into the proposed Deliverable[] the
// pricing value model evaluates. Structurally it matches injection-guard's
// NegotiatorTerms without importing it (injection-guard imports from this
// module — a type import back would be a cycle).

export interface TermsPatch {
  quantity?: number | null;
  promo_type?: string | null;
  min_seconds?: number | null;
  schedule_note?: string | null;
}

// Plausibility bounds for a micro-influencer term proposal. Outside these the
// terms are GARBAGE (a hallucinated or adversarial package) and the caller
// falls back to the price-only path — we never silently reshape an absurd
// proposal into a plausible one and negotiate against it.
export const TERMS_MAX_QUANTITY = 10;
export const TERMS_MIN_SECONDS = 5;
export const TERMS_MAX_SECONDS = 600;

/**
 * Turn a parsed term proposal + the current standing package into the
 * creator's proposed Deliverable[] — or null when the terms don't describe a
 * usable package change (missing/invalid promo_type, out-of-bounds quantity or
 * length). Null = "ignore terms, negotiate price only."
 *
 * Semantics: the proposal REPLACES the package with quantity × promo_type at
 * min_seconds (defaulted per type when unstated), keeping the current
 * package's delivery window. The sanitized schedule note rides along for the
 * frozen contract state.
 */
export function applyTermsToDeliverables(
  terms: TermsPatch | null | undefined,
  current: Deliverable[],
): Deliverable[] | null {
  if (!terms || typeof terms !== 'object') return null;
  // A package change is anchored on WHAT they'll make. No valid type, no trade.
  if (!isPromoType(terms.promo_type)) return null;

  let quantity = 1;
  if (terms.quantity != null) {
    const q = Math.floor(Number(terms.quantity));
    if (!Number.isFinite(q) || q < 1 || q > TERMS_MAX_QUANTITY) return null;
    quantity = q;
  }

  let minSeconds: number | null = null;
  if (terms.min_seconds != null) {
    const s = Math.floor(Number(terms.min_seconds));
    if (!Number.isFinite(s) || s < TERMS_MIN_SECONDS || s > TERMS_MAX_SECONDS) return null;
    minSeconds = s;
  }

  const note =
    typeof terms.schedule_note === 'string' && terms.schedule_note.trim()
      ? terms.schedule_note.trim()
      : null;

  const proposed = normalizeDeliverables([
    {
      promo_type: terms.promo_type,
      quantity,
      delivery_window_days: maxWindowDays(current) || 14,
      // normalizeDeliverables applies the per-type default when null.
      min_seconds: minSeconds,
      schedule_note: note,
    },
  ]);
  return proposed.length > 0 ? proposed : null;
}

// ── The deal scope the LABEL sets ───────────────────────────────────────────
//
// applyTermsToDeliverables above answers "what package is the creator
// proposing?". It deliberately does NOT answer "is that a package we sell?",
// and until this section existed nothing did. The value model priced whatever
// came back and the ceiling bounded the dollars, so a creator could propose ten
// 600-second dance videos for $150 and the engine accepted it: money guarded,
// scope unguarded. The acceptance email then promised the label something it
// had never agreed to buy, in a format (a 600-second reel) that does not exist
// on the platform.
//
// A DeliverableSpec is the label's intent expressed as data: which promo types
// are on offer, how many of each, how long, and by when. It is a BOUND, not a
// package — the package is still negotiated inside it.
//
// The spec is not advisory. A proposal outside it is not repriced, it is
// escalated to a human (see evaluateTermTrade and negotiation.ts). Repricing an
// out-of-scope proposal is how you end up with a defensible number attached to
// a deal nobody authorized.

/**
 * Longest video we will agree to per promo type, in seconds. These are PLATFORM
 * limits, not preferences — they are the ceiling on what a label's spec may ask
 * for, and the default ceiling when a spec leaves it unset.
 *
 *   reel        90  — Instagram's hard cap for a Reel.
 *   dance_trend 180 — TikTok allows far longer; past ~3 minutes a "trend video"
 *                     is a different product and a human should look at it.
 *   story       60  — a story is 15s segments; 60s is four of them stitched.
 *   post        null — a feed post is length-agnostic.
 *
 * TERMS_MAX_SECONDS (600) upstream is a PLAUSIBILITY bound on PARSING — it
 * stops a hallucinated number becoming a package. These are the COMMERCIAL
 * bound on AGREEING. The live bug lived in the gap between the two.
 */
export const PROMO_MAX_SECONDS: Record<PromoType, number | null> = {
  story: 60,
  post: null,
  reel: 90,
  dance_trend: 180,
};

/** One allowed line of a campaign's deal scope. A promo type with no line is
 *  not on offer at all. */
export interface SpecLine {
  promo_type: PromoType;
  /** Fewest we will agree to. 1 by default — a creator narrowing the package is
   *  a normal negotiation move the value model already prices correctly. */
  min_quantity: number;
  /** Most we will agree to. Defaults to the quantity the label asked for. */
  max_quantity: number;
  /** Shortest acceptable video. Null for length-agnostic types. */
  min_seconds: number | null;
  /** Longest acceptable video. Null for length-agnostic types. */
  max_seconds: number | null;
}

export interface DeliverableSpec {
  lines: SpecLine[];
  /** The outside date, in days. A package claiming longer is out of scope. */
  max_delivery_window_days: number;
  /** 'campaign' = the label set this explicitly; 'derived' = inferred from the
   *  standing package because they have not. Carried so copy, logs and the UI
   *  can tell a decision apart from a default. */
  source: 'campaign' | 'derived';
}

export type SpecViolationCode =
  | 'empty_package'
  | 'type_not_allowed'
  | 'quantity_above_max'
  | 'quantity_below_min'
  | 'seconds_above_max'
  | 'seconds_below_min'
  | 'window_above_max';

export interface SpecViolation {
  code: SpecViolationCode;
  promo_type: PromoType | null;
  /** Plain-English, safe for an audit row and for a human to read. */
  detail: string;
}

/**
 * The spec implied by a package when the label has not set one.
 *
 * This is why the guard is live for every campaign on day one rather than only
 * for campaigns someone remembered to configure. An unset spec is not an
 * unbounded spec: it means "what we already told this creator we wanted, with
 * platform reality as the outer edge".
 *
 * Deliberately asymmetric. The quantity CEILING is the ask (agreeing to more
 * work than the label specified is the #65 bug), while the quantity FLOOR is 1
 * (agreeing to less is a reduction, which the value model already reprices
 * proportionally and the ratchet already protects). Length is bounded by the
 * platform, not by the ask, so an ordinary 60-second reel against a 30-second
 * ask still negotiates instead of waking someone up.
 */
export function specFromPackage(pkg: Deliverable[]): DeliverableSpec {
  const lines: SpecLine[] = pkg.map((d) => {
    const timeBased = TIME_BASED_DEFAULT_SECONDS[d.promo_type] != null;
    return {
      promo_type: d.promo_type,
      min_quantity: 1,
      max_quantity: Math.max(1, Math.floor(d.quantity) || 1),
      min_seconds: timeBased ? TERMS_MIN_SECONDS : null,
      max_seconds: PROMO_MAX_SECONDS[d.promo_type],
    };
  });
  return {
    lines,
    max_delivery_window_days: maxWindowDays(pkg) || 14,
    source: 'derived',
  };
}

/**
 * Every way a proposed package falls outside the label's scope. Empty array =
 * in scope. Reports ALL violations rather than the first, because the human who
 * reads the escalation needs the whole picture to answer it in one reply.
 */
export function checkPackageAgainstSpec(
  proposed: Deliverable[],
  spec: DeliverableSpec,
): SpecViolation[] {
  if (!Array.isArray(proposed) || proposed.length === 0) {
    return [
      { code: 'empty_package', promo_type: null, detail: 'the proposal contains no deliverables' },
    ];
  }
  const byType = new Map(spec.lines.map((l) => [l.promo_type, l]));
  const out: SpecViolation[] = [];

  for (const d of proposed) {
    const label = PROMO_LABEL[d.promo_type];
    const line = byType.get(d.promo_type);
    if (!line) {
      out.push({
        code: 'type_not_allowed',
        promo_type: d.promo_type,
        detail: `this campaign is not buying ${label}s`,
      });
      continue;
    }
    if (d.quantity > line.max_quantity) {
      out.push({
        code: 'quantity_above_max',
        promo_type: d.promo_type,
        detail: `${d.quantity} ${label}s proposed, at most ${line.max_quantity} in scope`,
      });
    } else if (d.quantity < line.min_quantity) {
      out.push({
        code: 'quantity_below_min',
        promo_type: d.promo_type,
        detail: `${d.quantity} ${label}s proposed, at least ${line.min_quantity} required`,
      });
    }
    if (d.min_seconds != null) {
      if (line.max_seconds != null && d.min_seconds > line.max_seconds) {
        out.push({
          code: 'seconds_above_max',
          promo_type: d.promo_type,
          detail: `a ${d.min_seconds}-second ${label} proposed, at most ${line.max_seconds} seconds in scope`,
        });
      } else if (line.min_seconds != null && d.min_seconds < line.min_seconds) {
        out.push({
          code: 'seconds_below_min',
          promo_type: d.promo_type,
          detail: `a ${d.min_seconds}-second ${label} proposed, at least ${line.min_seconds} seconds required`,
        });
      }
    }
    if (d.delivery_window_days > spec.max_delivery_window_days) {
      out.push({
        code: 'window_above_max',
        promo_type: d.promo_type,
        detail: `${d.delivery_window_days} days to deliver proposed, the campaign allows ${spec.max_delivery_window_days}`,
      });
    }
  }
  return out;
}

/** One readable sentence for a set of violations. Used in audit metadata, the
 *  anomaly feed and the escalation reason. Never sent to a creator. */
export function describeSpecViolations(violations: SpecViolation[]): string {
  if (violations.length === 0) return '';
  return violations.map((v) => v.detail).join('; ');
}
