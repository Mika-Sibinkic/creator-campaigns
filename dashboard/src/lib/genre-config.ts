// src/lib/genre-config.ts
//
// Genre is a PROPERTY OF THE LABEL, not of the codebase.
//
// No genre is privileged by default. A genre baked into the code would shape
// money and candidate supply for every tenant: a hardcoded premium list in
// pricing-engine.ts, a default `genre` parameter in pricing.ts, or a literal
// fallback discovery query in spotify.ts would each bias every label toward
// one vertical regardless of what it releases.
//
// This module is the single place genre is resolved and priced. Two rules:
//
//   * THERE IS NO DEFAULT GENRE. Absent configuration the answer is `null`,
//     and every consumer must behave genre-neutrally rather than guess. A
//     wrong guess is worse than no guess: a defaulted genre would pitch an
//     EDM label as "aligning perfectly" with some other genre's music.
//   * PREMIUMS ARE CONFIGURATION. The default table is EMPTY: no genre is
//     privileged out of the box. A label that wants a premium sets it on its
//     own firm row.
//
// Storage needs no migration. `firms.scraping_prefs` (jsonb, migration 009)
// is already documented as `{genres[], follower_range, engagement_min,
// regions[], content_style, language}` and already passes `UpdateFirmBody`
// as `z.unknown()`; `campaigns.scraping_overrides` (jsonb, same migration) is
// its per-campaign mirror.
//
// Pure: no I/O, no env. Callers hand in the already-fetched jsonb blobs.

/**
 * Multiplier applied when a genre carries no configured premium.
 * Neutral by construction — this is the value a label with no genre
 * configuration gets, and it must not advantage or disadvantage anyone.
 */
export const NEUTRAL_GENRE_MULTIPLIER = 1.0;

/**
 * Default premium table: deliberately EMPTY.
 *
 * Shipping a non-empty default here would privilege some genres for every
 * tenant, which is exactly the bias this module exists to remove.
 */
export const DEFAULT_GENRE_PREMIUMS: Readonly<Record<string, number>> = Object.freeze({});

/**
 * Bounds on a configured premium. A premium is a money input, so a typo'd
 * `110` (meant as 1.10) must not turn a $50 offer into $5,500. Values outside
 * the band are dropped, not clamped — a silently-corrected multiplier is a
 * multiplier nobody audits.
 *
 * This is an app-level sanity band, NOT the money ceiling. The per-deal
 * ceiling remains the DB CHECK from migration 009
 * (`current_within_ceiling` / `agreed_within_ceiling`) and is untouched:
 * `calculateInitialOffer` still takes `min(formula, per_creator_cap_usd)`.
 */
export const MIN_GENRE_PREMIUM = 0.5;
export const MAX_GENRE_PREMIUM = 2.0;

/** Normalize a genre string for table lookup. Blank → null. */
export function normalizeGenre(genre: string | null | undefined): string | null {
  if (typeof genre !== 'string') return null;
  const trimmed = genre.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Coerce an untrusted jsonb value into a list of genres.
 * Non-arrays, non-strings and blanks are dropped; order is preserved because
 * the first entry is treated as the primary genre.
 */
export function parseGenreList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const g = normalizeGenre(typeof entry === 'string' ? entry : null);
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}

/**
 * Coerce an untrusted jsonb value into a premium table.
 * Fail-closed: anything that is not a finite number inside
 * [MIN_GENRE_PREMIUM, MAX_GENRE_PREMIUM] is dropped, so a malformed settings
 * blob degrades to neutral pricing rather than to arbitrary pricing.
 */
export function parseGenrePremiums(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const genre = normalizeGenre(key);
    if (!genre) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (value < MIN_GENRE_PREMIUM || value > MAX_GENRE_PREMIUM) continue;
    out[genre] = value;
  }
  return out;
}

/**
 * The premium multiplier for a genre under a given table.
 *
 * Exact match on the normalized genre, NOT substring. A substring match with
 * `'pop'` in the table would hand the premium to "indie pop", "bedroom pop",
 * "dream pop", "k-pop", "synthpop" and "pop punk" alike. Exact matching makes
 * the configured table mean what it says.
 */
export function genrePremium(
  genre: string | null | undefined,
  table: Readonly<Record<string, number>> = DEFAULT_GENRE_PREMIUMS
): number {
  const norm = normalizeGenre(genre);
  if (!norm) return NEUTRAL_GENRE_MULTIPLIER;
  const configured = table[norm];
  if (typeof configured !== 'number' || !Number.isFinite(configured)) {
    return NEUTRAL_GENRE_MULTIPLIER;
  }
  return configured;
}

/** The jsonb shapes this module reads. Both are already-persisted columns. */
export interface FirmGenreSources {
  /** firms.scraping_prefs */
  scrapingPrefs?: unknown;
}
export interface CampaignGenreSources {
  /** campaigns.scraping_overrides */
  scrapingOverrides?: unknown;
  /** campaigns.artist_data — legacy home of `.genre`, still read. */
  artistData?: unknown;
}

function pickKey(blob: unknown, key: string): unknown {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return undefined;
  return (blob as Record<string, unknown>)[key];
}

/**
 * Resolve the effective genre for a campaign. Most specific wins:
 *   1. campaigns.scraping_overrides.genres[0]
 *   2. campaigns.artist_data.genre        (legacy field, still honoured)
 *   3. firms.scraping_prefs.genres[0]     (set by /onboarding today)
 *   4. null                               — never a guessed default
 *
 * Returning null is a supported, first-class answer. Consumers must run
 * genre-neutrally on null rather than substituting a guess.
 */
export function resolveGenre(
  campaign: CampaignGenreSources,
  firm: FirmGenreSources
): string | null {
  const campaignGenres = parseGenreList(pickKey(campaign.scrapingOverrides, 'genres'));
  if (campaignGenres.length > 0) return campaignGenres[0];

  const legacy = normalizeGenre(
    typeof pickKey(campaign.artistData, 'genre') === 'string'
      ? (pickKey(campaign.artistData, 'genre') as string)
      : null
  );
  if (legacy) return legacy;

  const firmGenres = parseGenreList(pickKey(firm.scrapingPrefs, 'genres'));
  if (firmGenres.length > 0) return firmGenres[0];

  return null;
}

/**
 * Resolve the effective premium table for a firm:
 * `firms.scraping_prefs.genre_premiums`, else the (empty) default.
 */
export function resolveGenrePremiums(
  firm: FirmGenreSources
): Record<string, number> {
  return parseGenrePremiums(pickKey(firm.scrapingPrefs, 'genre_premiums'));
}
