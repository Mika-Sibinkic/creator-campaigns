// src/lib/pool-gates.ts
//
// Per-firm pool-hygiene gates.
//
// Three deterministic, config-driven gates that every read path selecting
// creator candidates (pipeline qualification, the batch qualify endpoint,
// draft pools, the per-draft eligibility gate) must apply:
//
//   1. FOLLOWER CAP — firms.scraping_prefs.follower_max. The cap was only
//      passed to the Apify actor at scrape time (followersLessThan), so the
//      shared cross-firm `influencers` table can still hold million-follower
//      accounts far over a firm's cap. The table is shared, so
//      rows are never deleted; instead each firm's cap is enforced when a
//      candidate is READ for that firm, and the exclusion persists onto the
//      firm-scoped campaign_influencers row with an inspectable reason.
//
//   2. AUDIENCE-FIT MINIMUM — firms.scraping_prefs.audience_fit_min.
//      OFF BY DEFAULT (0). Opt-in, and deliberately so.
//
//      A minimum of 65, 70 or 75 sounds natural, and the first cut of this
//      file defaulted it to 70 on the reasoning that scoring.ts already used
//      `>= 70` as a threshold. That reasoning was wrong twice over.
//
//      First: scoring.ts:421 uses `>= 70` to append the reason string
//      "ideal audience size". IDEAL is not MINIMUM ACCEPTABLE. Promoting one
//      to the other is a silent, large policy change wearing a small one's
//      clothes.
//
//      Second, and worse: scoreAudienceFit (scoring.ts:154-182) is not a
//      measure of audience quality at all. It is `followerBand +
//      platformBonus` — <5k→30, 5-10k→50..80, 10-30k→80, 30-50k→80..50,
//      >50k→40, plus 20 for a matching platform or 5 for anything else. So
//      "audience_fit >= 70" decodes to exactly "5,000-50,000 followers on a
//      matching platform". It is a second, harsher FOLLOWER filter wearing an
//      audience-quality name.
//
//      A default of 70 therefore excludes every creator under 5,000
//      followers, including the ones a firm's own scraping_prefs.follower_min
//      (say 1500) tells the pipeline to go and PAY Apify for. A firm whose
//      prefs carry no audience_fit_min key would lose them with no config
//      change and no model ever looking at those creators.
//
//      A gate no one asked to enable must not delete a large share of a pool.
//      It stays available — a firm that wants it sets the key — but the
//      default is off, and the thresholds that actually change behavior are
//      enumerated in AUDIENCE_FIT_GATE_OPTIONS rather than presented as a
//      continuous 0-100 dial the underlying arithmetic cannot deliver.
//
//      Building a real audience-fit signal is separate work.
//
//   3. AUDIENCE LANGUAGE — firms.scraping_prefs.region. Also
//      opt-in, by the same test: it does nothing until someone types a region
//      that resolves to a language expectation. It is named for what it
//      measures rather than what was asked for, because the scrape carries no
//      author-level geography at all — src/lib/creator-region.ts has the
//      coverage measurements and the reasoning. Only a 'mismatch' excludes;
//      an unplaceable creator is kept and counted as unknown.
//
// The music-artist exclusion lives in src/lib/qualify.ts —
// it is an account-type question — but its per-firm toggle
// (scraping_prefs.exclude_music_artists, default true) is parsed HERE so
// there is exactly one reader of the jsonb.
//
// Posture: fail-open on missing DATA (unknown followers / no audience_fit
// in score_breakdown → no gate, same as qualify.ts), fail-closed on the
// gate itself (data present and over the line → excluded, confidence 1 —
// these are arithmetic facts, not model opinions).

import {
  ABANDONED_REASON_PREFIX,
  MUSIC_ARTIST_REASON_PREFIX,
  NO_POSTS_REASON_PREFIX,
} from './qualify';
import {
  AUDIENCE_LANGUAGE_REASON_PREFIX,
  regionGateActive,
  resolveRegionPref,
  sameLanguageTarget,
  type RegionAssessment,
  type RegionPref,
} from './creator-region';

/**
 * 0 = the audience-fit gate is OFF. See the header: a non-zero default
 * silently removes a large share of a pool, because the score it gates on is
 * a follower-band proxy and not a quality measure.
 */
export const DEFAULT_AUDIENCE_FIT_MIN = 0;

/**
 * The thresholds that actually partition the pool, with what each one really
 * does. scoreAudienceFit only emits a handful of distinct values, so a
 * free-text 0-100 box offers precision that does not exist: every value from
 * 51 to 60 behaves identically, as does every value from 61 to 70.
 *
 * Descriptions are written in followers because followers are what the score
 * measures. Assumes a matching platform (a platform mismatch costs 15 points
 * and pulls every band down with it).
 */
export const AUDIENCE_FIT_GATE_OPTIONS: ReadonlyArray<{
  value: number;
  label: string;
  detail: string;
}> = [
  {
    value: 0,
    label: 'Off: review every creator (default)',
    detail: 'No creator is ruled out on audience fit.',
  },
  {
    value: 60,
    label: 'Skip creators under ~5,000 followers',
    detail: 'Rules out the smallest band. Note your scrape minimum may be lower.',
  },
  {
    value: 70,
    label: 'Skip creators under ~5,000 or over ~50,000 followers',
    detail: 'Keeps roughly the 5,000-50,000 band on a matching platform.',
  },
];
export const DEFAULT_EXCLUDE_MUSIC_ARTISTS = true;

export interface PoolGatePrefs {
  /** Hard follower ceiling for the pool. null = no cap configured. */
  follower_max: number | null;
  /** Hard audience-fit floor (0–100). 0 disables the gate. Default 70. */
  audience_fit_min: number;
  /** Music artists excluded from the pool? Default true. */
  exclude_music_artists: boolean;
  /**
   * The firm's region pref, resolved. null = nothing typed.
   *
   * This gate turns itself on only when the text resolves to a language
   * expectation — see regionGateActive(). An unrecognized region still steers
   * the search-query prompt; it just cannot rule anyone out, because a
   * lookup miss is not evidence about a creator.
   */
  region: RegionPref | null;
}

/** A jsonb number, or a string that plainly is one. Anything else → null. */
function numberish(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A jsonb boolean, or the strings/numbers jsonb editors produce for one. */
function boolish(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
  }
  return fallback;
}

/**
 * Parse firms.scraping_prefs (untyped jsonb) into the gate config.
 *
 * ONE posture for every numeric key: **malformed config never tightens a
 * gate.** The first cut of this function had the two thresholds failing in
 * opposite directions on the same class of input — a string
 * `follower_max: "250000"` fell back to null (no cap, looser than the firm
 * intended) while a malformed audience_fit_min fell back to 70 (a gate the
 * firm never asked for, stricter than intended). A config typo must not
 * silently delete creators.
 *
 * So: numeric strings are coerced, because `"250000"` in jsonb is a value the
 * firm plainly meant, and anything genuinely unreadable resolves to the
 * no-gate default.
 *
 * exclude_music_artists is deliberately NOT symmetric. It is not a threshold
 * whose malformed value is ambiguous — it is a requirement with a stated
 * default (exclude artists), so an unreadable value resolves to that
 * requirement rather than dropping it.
 */
export function resolvePoolGatePrefs(raw: unknown): PoolGatePrefs {
  const p = (
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  ) as Record<string, unknown>;

  const rawFollowerMax = numberish(p.follower_max);
  const followerMax =
    rawFollowerMax !== null && rawFollowerMax > 0
      ? Math.floor(rawFollowerMax)
      : null;

  const rawFitMin = numberish(p.audience_fit_min);
  const audienceFitMin =
    rawFitMin !== null && rawFitMin >= 0 && rawFitMin <= 100
      ? rawFitMin
      : DEFAULT_AUDIENCE_FIT_MIN;

  const excludeMusicArtists = boolish(
    p.exclude_music_artists,
    DEFAULT_EXCLUDE_MUSIC_ARTISTS,
  );

  return {
    follower_max: followerMax,
    audience_fit_min: audienceFitMin,
    exclude_music_artists: excludeMusicArtists,
    region: resolveRegionPref(p.region),
  };
}

/**
 * 'blocklisted' is not a firm-config threshold like the other two — it is an
 * explicit per-creator "do not contact" flag a human set. It lives here
 * anyway, and is checked FIRST, because this function is the one thing every
 * read path already calls: routing it through here is what makes the
 * blocklist impossible to forget.
 */
export type PoolGateName =
  | 'blocklisted'
  | 'follower_cap'
  | 'audience_language'
  | 'audience_fit';

/** Lead phrase for a blocklist exclusion — see classifyExclusionReason. */
export const BLOCKLIST_REASON =
  'Blocklisted: this creator is marked do-not-contact';

export interface PoolGateExclusion {
  gate: PoolGateName;
  /** ≤140 chars, label-readable — persists into qualification_reason. */
  reason: string;
}

/**
 * Apply the deterministic per-firm gates to one candidate. Returns the first
 * exclusion that fires (follower cap outranks audience fit — it is the older
 * and more common reason), or null when the candidate passes every gate the
 * data can answer.
 */
export function poolGateExclusion(
  input: {
    followers?: number | null;
    audience_fit?: number | null;
    /** influencers.blocklisted — a human said do not contact this creator. */
    blocklisted?: boolean | null;
    /**
     * This creator placed against the firm's region, from
     * assessCreatorRegion(). Omitted or null means "not assessed", which is
     * NOT the same as 'unknown' and is treated identically: no exclusion.
     * Callers without the creator's posts in hand (contactBlock, the send
     * paths) legitimately cannot compute it.
     */
    region_assessment?: RegionAssessment | null;
  },
  prefs: PoolGatePrefs,
): PoolGateExclusion | null {
  // Outranks every other gate and is not configurable: a firm that blocklists
  // a creator has already decided. Until now the column was a DISPLAY filter
  // only — present in the influencers list and detail pages, and referenced
  // nowhere in the run, draft, send or negotiation paths — so a blocklisted
  // creator vanished from the UI while the pipeline carried on drafting,
  // sending and negotiating with them. It looked obeyed and was not.
  if (input.blocklisted === true) {
    return { gate: 'blocklisted', reason: BLOCKLIST_REASON };
  }

  const followers = input.followers;
  if (
    prefs.follower_max !== null &&
    typeof followers === 'number' &&
    Number.isFinite(followers) &&
    followers > prefs.follower_max
  ) {
    return {
      gate: 'follower_cap',
      reason: `${followers.toLocaleString('en-US')} followers is over this firm's ${prefs.follower_max.toLocaleString('en-US')} follower cap`,
    };
  }

  // Region. Ranks below the follower cap — that is the older,
  // louder complaint — and above audience fit, which is off by default.
  //
  // ONLY 'mismatch' excludes. 'unknown' is a real answer here and it keeps the
  // creator: the language classifier returns 'un' for captions too short to
  // read, and 10% of rows carry any geo at all. Dropping those would invent an
  // exclusion the data never supported. assessCreatorRegion() owns that call;
  // this branch just refuses to add a second opinion on top of it.
  //
  // regionGateActive(prefs.region) is re-checked here and not assumed from the
  // assessment. An assessment is computed against SOME pref and then carried
  // around; nothing stops a caller pairing one with a different firm's config,
  // and a verdict computed under "US" must not exclude anyone under
  // "worldwide". Every other gate above re-reads its own pref the same way.
  // The verdict must have been computed against THIS firm's target, not just
  // against some target. Checking regionGateActive alone closes the
  // "configured vs not" case and leaves the "configured differently" one open:
  // a mismatch produced under a Russia-targeting pref is the same bare
  // 'mismatch' as one produced under a US-targeting pref, and would exclude
  // under either. sameLanguageTarget makes the provenance explicit.
  const region = input.region_assessment;
  if (
    regionGateActive(prefs.region) &&
    region &&
    region.verdict === 'mismatch' &&
    region.reason &&
    sameLanguageTarget(region.targetLanguages, prefs.region!.languages)
  ) {
    return { gate: 'audience_language', reason: region.reason };
  }

  const fit = input.audience_fit;
  if (
    prefs.audience_fit_min > 0 &&
    typeof fit === 'number' &&
    Number.isFinite(fit) &&
    fit < prefs.audience_fit_min
  ) {
    return {
      gate: 'audience_fit',
      reason: `Audience fit ${Math.round(fit)} is below this firm's minimum of ${prefs.audience_fit_min}`,
    };
  }

  return null;
}

/**
 * The campaign_influencers patch that persists a gate exclusion. Confidence 1:
 * these are arithmetic facts against the firm's own config, not model output.
 * Kept here so every caller writes the identical, inspectable shape.
 */
export function gateExclusionPatch(g: PoolGateExclusion): {
  qualification_status: 'excluded';
  qualification_reason: string;
  qualification_confidence: number;
} {
  return {
    qualification_status: 'excluded',
    qualification_reason: g.reason,
    qualification_confidence: 1,
  };
}

/**
 * Pull audience_fit out of a persisted campaign_influencers.score_breakdown
 * jsonb, or null when absent/malformed (older rows, partial writes).
 */
export function audienceFitOf(scoreBreakdown: unknown): number | null {
  if (
    scoreBreakdown === null ||
    typeof scoreBreakdown !== 'object' ||
    Array.isArray(scoreBreakdown)
  ) {
    return null;
  }
  const v = (scoreBreakdown as Record<string, unknown>).audience_fit;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ── Attributing an exclusion ─────────────────────────────────────────────────
//
// "6 of your creators were ruled out" is not an answer a label can act on;
// "6 over your follower cap" is. campaign_influencers has no column for the
// cause (adding one is a migration, and migration numbers are allocated
// centrally), so the cause is read back out of the reason text this module
// and qualify.ts write.
//
// That only works because both writers emit a fixed lead phrase — the
// patterns below match those templates exactly, and tests/pool-gates.test.ts
// round-trips real poolGateExclusion() and musicArtistPrecheck() output
// through classifyExclusionReason() so the pair cannot drift apart. Anything
// else — every model-written verdict, and every row excluded before these
// gates existed — is honestly reported as 'other' rather than guessed at.

export type ExclusionCause =
  | PoolGateName
  | 'music_artist'
  | 'no_posts'
  | 'abandoned'
  | 'other';

export const EXCLUSION_CAUSES: readonly ExclusionCause[] = [
  'blocklisted',
  'follower_cap',
  // TypeScript does NOT check this array against PoolGateName or
  // ExclusionCause — it is a plain readonly list, and both consumers
  // (statuses.ts's bucket seeding and the campaign page's "ruled out" line)
  // iterate THIS, not the label record. A cause missing here compiles, ships,
  // and is invisible in the UI forever.
  'audience_language',
  'audience_fit',
  'music_artist',
  'no_posts',
  'abandoned',
  'other',
];

/**
 * Human labels for the causes.
 *
 * `other` used to read "ruled out on review", which claimed a reviewer had
 * looked. Rows carrying qualify.ts's own deterministic pre-check reasons — no
 * posts in the scrape, or an account whose newest post is years old — landed
 * in that bucket, so the UI said those creators had been reviewed when
 * nothing had reviewed them. Those two
 * now have their own causes, and `other` no longer claims anything.
 */
export const EXCLUSION_CAUSE_LABELS: Record<ExclusionCause, string> = {
  blocklisted: 'blocklisted (do not contact)',
  follower_cap: 'over the follower cap',
  // Says language, not location, because language is what was measured. "not
  // in your region" would be the product claiming a residence check it cannot
  // perform — there is no author-level geo field in the scrape at all.
  audience_language: 'posting in another language',
  audience_fit: 'outside the audience-fit follower band',
  music_artist: 'music artists',
  no_posts: 'no posts in the scrape',
  abandoned: 'account looks abandoned',
  other: 'ruled out for other reasons',
};

const BLOCKLIST_REASON_RE = /^Blocklisted\b/i;
const FOLLOWER_CAP_REASON_RE = /^[\d,]+ followers is over this firm's /i;
const AUDIENCE_FIT_REASON_RE = /^Audience fit \d+ is below this firm's /i;
const AUDIENCE_LANGUAGE_REASON_RE = new RegExp(
  `^${AUDIENCE_LANGUAGE_REASON_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  'i',
);
const MUSIC_ARTIST_REASON_RE = new RegExp(`^${MUSIC_ARTIST_REASON_PREFIX}\\b`, 'i');
const NO_POSTS_REASON_RE = new RegExp(`^${NO_POSTS_REASON_PREFIX}\\b`, 'i');
const ABANDONED_REASON_RE = new RegExp(`^${ABANDONED_REASON_PREFIX}\\b`, 'i');

/**
 * Attribute a persisted campaign_influencers.qualification_reason to whatever
 * produced it. Unrecognized text is 'other' — never a guess.
 */
export function classifyExclusionReason(
  reason: string | null | undefined,
): ExclusionCause {
  const r = (reason ?? '').trim();
  if (!r) return 'other';
  if (BLOCKLIST_REASON_RE.test(r)) return 'blocklisted';
  if (FOLLOWER_CAP_REASON_RE.test(r)) return 'follower_cap';
  if (AUDIENCE_FIT_REASON_RE.test(r)) return 'audience_fit';
  if (AUDIENCE_LANGUAGE_REASON_RE.test(r)) return 'audience_language';
  if (MUSIC_ARTIST_REASON_RE.test(r)) return 'music_artist';
  if (NO_POSTS_REASON_RE.test(r)) return 'no_posts';
  if (ABANDONED_REASON_RE.test(r)) return 'abandoned';
  return 'other';
}

// ── May this creator be contacted? ───────────────────────────────────────────
//
// The gates are only worth anything if "the gate decides who gets contacted"
// is true end to end. Drafting was covered; SENDING was not — a draft written
// before the gates existed kept a working Send button, even for creators these
// gates rule out.
//
// This is the one predicate the send paths share. Pure, so it is testable
// without a database and cannot drift from the draft-time gate: it calls the
// same poolGateExclusion().

export type ContactBlockCode = PoolGateName | 'bot_flagged' | 'excluded';

export interface ContactBlock {
  code: ContactBlockCode;
  /** Label-readable, safe to return in an API error body. */
  reason: string;
}

/**
 * Why this creator must not be contacted, or null when they may be.
 *
 * Checked in decreasing order of certainty: a bot flag and a persisted
 * exclusion are already-made decisions, so they win; the live gates then
 * re-derive the follower cap and audience-fit verdicts from the firm's
 * CURRENT prefs, which is what catches rows drafted before a gate existed.
 */
export function contactBlock(
  row: {
    qualification_status?: string | null;
    qualification_reason?: string | null;
    bot_flagged?: boolean | null;
    blocklisted?: boolean | null;
    followers?: number | null;
    audience_fit?: number | null;
  },
  prefs: PoolGatePrefs,
): ContactBlock | null {
  // Before anything else, including the bot flag: a human said no.
  if (row.blocklisted === true) {
    return { code: 'blocklisted', reason: BLOCKLIST_REASON };
  }
  if (row.bot_flagged === true) {
    return {
      code: 'bot_flagged',
      reason: 'Flagged as a likely bot or engagement farm',
    };
  }
  if (row.qualification_status === 'excluded') {
    return {
      code: 'excluded',
      reason:
        (row.qualification_reason ?? '').trim() ||
        'Ruled out by the qualification pass',
    };
  }
  // No region_assessment: placing a creator needs their posts, and the send
  // paths hold a campaign_influencers row, not a scrape. That is not a hole.
  // The run route persists a language exclusion as
  // qualification_status='excluded', and the check above catches it before we
  // ever get here — so a language-excluded creator is still unsendable. What
  // this cannot do is re-derive the verdict for a row scored before the gate
  // existed, the way it re-derives the follower cap. Those rows stay
  // contactable until the campaign is re-run, which is the honest behavior:
  // nothing has looked at their posts under the current pref.
  const gate = poolGateExclusion(
    {
      followers: row.followers,
      audience_fit: row.audience_fit,
      blocklisted: row.blocklisted,
    },
    prefs,
  );
  return gate ? { code: gate.gate, reason: gate.reason } : null;
}
