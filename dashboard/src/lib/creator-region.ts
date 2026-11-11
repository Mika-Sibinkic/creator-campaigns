// src/lib/creator-region.ts
//
// firms.scraping_prefs.region — a label wants to scope a campaign to a city,
// a region, a country or the world, and to rule some audiences out. The value
// is collected by /onboarding, rendered back on the confirm page as a
// configured setting, and was read by NOTHING until this file. A control that
// does nothing is worse than a missing one: the label believes the pool is
// scoped and it is not.
//
// ── What the data can actually support ──────────────────────────────────────
//
// What the scraped `influencers` rows carry:
//
//   raw_data.posts[].textLanguage   populated on effectively every row; some
//                                   rows are 'un' on every post
//   raw_data.posts[].locationMeta   only a small minority carry a countryCode
//   locationMeta.countryCode        GeoNames NUMERIC ids, not ISO codes
//                                   (6252001 = US, 2635167 = UK), so a
//                                   `countryCode === 'US'` test matches zero
//                                   rows while looking correct
//   locationMeta.address            the only human-readable geo, ranging from
//                                   a full street address to "North America"
//                                   to a literal "Mock Address"
//   authorMeta.region               advertised in Apify's public docs and
//                                   absent from the scraped rows
//
// locationMeta is a per-post VENUE TAG, not a creator home base, and there is
// no author-level region field at all. Three rules fall out of that, and they
// are the entire design of this module:
//
//   1. LANGUAGE DECIDES. It is the only signal with full coverage.
//   2. COUNTRY ONLY CONFIRMS. A venue tag inside the target country is
//      evidence of presence; a venue tag outside it is evidence of a trip.
//      So country can upgrade 'unknown' to 'match' and can NEVER produce a
//      'mismatch'.
//   3. NO SIGNAL IS KEPT, AND LABELLED. A creator we cannot place comes back
//      'unknown' and stays in the pool. Silently dropping them would be a
//      fabricated exclusion; the house rule is null over fabrication. 'un'
//      is a third state, not a reject — it mostly means the caption was too
//      short to classify.
//
// ── The honest name for the result ──────────────────────────────────────────
//
// This is an AUDIENCE-LANGUAGE filter, not a residence filter. A creator
// posting in English from Berlin serves a US release; a creator posting in
// Russian from Brooklyn does not. Copy anywhere in the product that promised
// "creators in the US" would be a second promise this data cannot keep, so
// nothing here says that and the confirm-page line says what this does.
//
// Pure module: no env, no I/O, no model. Tested by tests/creator-region.test.ts.

/** A firm's region preference, resolved into signals the pipeline can use. */
export interface RegionPref {
  /** Exactly what the firm typed, trimmed. Threaded into the query prompt. */
  raw: string;
  /** Display name of what `raw` resolved to; null when unrecognized. */
  matched: string | null;
  /** ISO 639-1 codes a creator serving this region is expected to post in. */
  languages: string[];
  /** GeoNames numeric country ids that CONFIRM a match. Never exclude on these. */
  countryIds: number[];
  /** True when the text explicitly means "no geographic scoping at all". */
  worldwide: boolean;
}

interface RegionEntry {
  name: string;
  languages: string[];
  /**
   * GeoNames numeric country id, or null when we do not have one VERIFIED
   * against a real locationMeta.countryCode value. Exactly two are confirmed
   * (United States 6252001, United Kingdom 2635167, both observed in scraped
   * rows). The rest are deliberately null rather than
   * transcribed from a public table nothing here has checked. A null costs
   * nothing: country is confirmation-only, so its absence excludes no one.
   */
  geonamesId: number | null;
  /** Match tokens, already normalized (lowercase, ascii, single-spaced). */
  aliases: string[];
}

/** Sentinel name for "the firm asked for no scoping". */
const WORLDWIDE = 'Worldwide';

// Ambiguous tokens are deliberately absent. "georgia" is a US state and a
// country with a different language; "ca" is California and Canada. A wrong
// language expectation excludes real creators, so anything that could land on
// two answers is left unmatched — which makes the gate inert rather than wrong.
const REGIONS: readonly RegionEntry[] = [
  {
    name: WORLDWIDE,
    languages: [],
    geonamesId: null,
    aliases: [
      'worldwide', 'world', 'global', 'globally', 'international',
      'anywhere', 'everywhere', 'any', 'all', 'none', 'no preference',
    ],
  },
  {
    name: 'United States',
    languages: ['en'],
    geonamesId: 6252001,
    aliases: [
      'us', 'u s', 'usa', 'u s a', 'united states', 'united states of america',
      'america', 'american', 'stateside', 'north america',
      'new york', 'new york city', 'nyc',
      'los angeles', 'california', 'chicago', 'illinois', 'atlanta',
      'austin', 'texas', 'miami', 'florida', 'seattle', 'washington',
      'boston', 'massachusetts', 'denver', 'colorado', 'memphis',
      'tennessee',
      'detroit', 'michigan', 'houston', 'dallas', 'phoenix', 'arizona',
      'philadelphia', 'pennsylvania', 'portland', 'oregon', 'san francisco',
    ],
  },
  {
    name: 'United Kingdom',
    languages: ['en'],
    geonamesId: 2635167,
    aliases: [
      'uk', 'u k', 'united kingdom', 'great britain', 'britain', 'british',
      'england', 'scotland', 'wales', 'northern ireland',
      'london', 'manchester', 'glasgow', 'birmingham', 'liverpool', 'leeds',
    ],
  },
  { name: 'Ireland', languages: ['en'], geonamesId: null, aliases: ['ireland', 'irish', 'dublin'] },
  {
    name: 'Canada',
    languages: ['en', 'fr'],
    geonamesId: null,
    aliases: ['canada', 'canadian', 'toronto', 'vancouver', 'montreal', 'ontario', 'quebec'],
  },
  {
    name: 'Australia',
    languages: ['en'],
    geonamesId: null,
    aliases: ['australia', 'australian', 'aus', 'sydney', 'melbourne', 'brisbane', 'perth'],
  },
  { name: 'New Zealand', languages: ['en'], geonamesId: null, aliases: ['new zealand', 'nz', 'auckland'] },
  { name: 'Nigeria', languages: ['en'], geonamesId: null, aliases: ['nigeria', 'nigerian', 'lagos'] },
  {
    name: 'South Africa',
    languages: ['en', 'af'],
    geonamesId: null,
    aliases: ['south africa', 'johannesburg', 'cape town'],
  },
  {
    name: 'Germany',
    languages: ['de'],
    geonamesId: null,
    aliases: ['germany', 'german', 'deutschland', 'berlin', 'munich', 'hamburg', 'cologne'],
  },
  { name: 'Austria', languages: ['de'], geonamesId: null, aliases: ['austria', 'vienna'] },
  {
    name: 'Switzerland',
    languages: ['de', 'fr', 'it'],
    geonamesId: null,
    aliases: ['switzerland', 'swiss', 'zurich', 'geneva'],
  },
  {
    name: 'France',
    languages: ['fr'],
    geonamesId: null,
    aliases: ['france', 'french', 'paris', 'marseille', 'lyon'],
  },
  { name: 'Belgium', languages: ['nl', 'fr'], geonamesId: null, aliases: ['belgium', 'brussels'] },
  {
    name: 'Netherlands',
    languages: ['nl'],
    geonamesId: null,
    aliases: ['netherlands', 'dutch', 'holland', 'amsterdam'],
  },
  {
    name: 'Spain',
    languages: ['es'],
    geonamesId: null,
    aliases: ['spain', 'spanish', 'espana', 'madrid', 'barcelona'],
  },
  {
    name: 'Mexico',
    languages: ['es'],
    geonamesId: null,
    aliases: ['mexico', 'mexican', 'mexico city', 'guadalajara', 'monterrey'],
  },
  {
    name: 'Latin America',
    languages: ['es', 'pt'],
    geonamesId: null,
    aliases: ['latin america', 'latam', 'south america', 'latinoamerica'],
  },
  { name: 'Argentina', languages: ['es'], geonamesId: null, aliases: ['argentina', 'buenos aires'] },
  { name: 'Colombia', languages: ['es'], geonamesId: null, aliases: ['colombia', 'bogota', 'medellin'] },
  { name: 'Chile', languages: ['es'], geonamesId: null, aliases: ['chile', 'santiago'] },
  {
    name: 'Brazil',
    languages: ['pt'],
    geonamesId: null,
    aliases: ['brazil', 'brasil', 'brazilian', 'sao paulo', 'rio de janeiro'],
  },
  { name: 'Portugal', languages: ['pt'], geonamesId: null, aliases: ['portugal', 'portuguese', 'lisbon'] },
  { name: 'Italy', languages: ['it'], geonamesId: null, aliases: ['italy', 'italian', 'italia', 'rome', 'milan'] },
  { name: 'Sweden', languages: ['sv'], geonamesId: null, aliases: ['sweden', 'swedish', 'stockholm'] },
  { name: 'Norway', languages: ['no'], geonamesId: null, aliases: ['norway', 'norwegian', 'oslo'] },
  { name: 'Denmark', languages: ['da'], geonamesId: null, aliases: ['denmark', 'danish', 'copenhagen'] },
  { name: 'Finland', languages: ['fi'], geonamesId: null, aliases: ['finland', 'finnish', 'helsinki'] },
  { name: 'Poland', languages: ['pl'], geonamesId: null, aliases: ['poland', 'polish', 'warsaw'] },
  {
    name: 'Russia',
    languages: ['ru'],
    geonamesId: null,
    aliases: ['russia', 'russian', 'moscow', 'saint petersburg', 'st petersburg'],
  },
  // 'uk' in THIS entry's languages is ISO 639-1 for Ukrainian, not the United
  // Kingdom. The collision is in the two specs, not in this table: languages
  // and aliases are different fields and are never compared to each other.
  { name: 'Ukraine', languages: ['uk', 'ru'], geonamesId: null, aliases: ['ukraine', 'ukrainian', 'kyiv', 'kiev'] },
  { name: 'Turkey', languages: ['tr'], geonamesId: null, aliases: ['turkey', 'turkish', 'istanbul'] },
  { name: 'Israel', languages: ['he'], geonamesId: null, aliases: ['israel', 'tel aviv'] },
  {
    name: 'Middle East',
    languages: ['ar'],
    geonamesId: null,
    aliases: [
      'middle east', 'arabic', 'uae', 'dubai', 'abu dhabi',
      'saudi arabia', 'egypt', 'cairo',
    ],
  },
  { name: 'Japan', languages: ['ja'], geonamesId: null, aliases: ['japan', 'japanese', 'tokyo', 'osaka'] },
  { name: 'South Korea', languages: ['ko'], geonamesId: null, aliases: ['korea', 'south korea', 'korean', 'seoul'] },
  {
    name: 'China',
    languages: ['zh'],
    geonamesId: null,
    aliases: ['china', 'chinese', 'mandarin', 'beijing', 'shanghai', 'taiwan', 'taipei'],
  },
  {
    name: 'India',
    languages: ['hi', 'en'],
    geonamesId: null,
    aliases: ['india', 'indian', 'mumbai', 'delhi', 'bangalore', 'bengaluru'],
  },
  { name: 'Indonesia', languages: ['id'], geonamesId: null, aliases: ['indonesia', 'jakarta'] },
  { name: 'Philippines', languages: ['tl', 'en'], geonamesId: null, aliases: ['philippines', 'filipino', 'manila'] },
  { name: 'Thailand', languages: ['th'], geonamesId: null, aliases: ['thailand', 'thai', 'bangkok'] },
  {
    name: 'Vietnam',
    languages: ['vi'],
    geonamesId: null,
    aliases: ['vietnam', 'vietnamese', 'hanoi', 'ho chi minh'],
  },
  // Bare language names, so "English-speaking" resolves without pretending to
  // name a country.
  {
    name: 'English-speaking',
    languages: ['en'],
    geonamesId: null,
    aliases: ['english', 'english speaking', 'anglophone'],
  },
];

/** lowercase, strip accents, drop punctuation, collapse whitespace. */
function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function entryFor(token: string): RegionEntry | null {
  if (!token) return null;
  for (const e of REGIONS) {
    if (e.aliases.includes(token)) return e;
  }
  return null;
}

/**
 * Resolve firms.scraping_prefs.region (untyped jsonb, free text) into the
 * signals the pipeline can act on. Returns null when nothing was typed.
 *
 * Unrecognized text is NOT an error and is NOT dropped: `matched` is null and
 * `languages` is empty, which makes the language gate inert, while `raw` still
 * reaches the search-query prompt. "the Gulf Coast" means something to a model and
 * nothing to a lookup table, and the prompt is where it can do some good.
 */
export function resolveRegionPref(raw: unknown): RegionPref | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const whole = normalizeToken(trimmed);
  const parts = trimmed
    .split(/[,/|;&]+|\band\b/)
    .map(normalizeToken)
    .filter((t) => t !== '');
  const tokens = whole !== '' && !parts.includes(whole) ? [whole, ...parts] : parts;

  const languages: string[] = [];
  const countryIds: number[] = [];
  const names: string[] = [];
  let worldwide = false;

  for (const token of tokens) {
    const entry = entryFor(token);
    if (!entry) continue;
    if (entry.name === WORLDWIDE) {
      worldwide = true;
      continue;
    }
    if (!names.includes(entry.name)) names.push(entry.name);
    for (const l of entry.languages) if (!languages.includes(l)) languages.push(l);
    if (entry.geonamesId !== null && !countryIds.includes(entry.geonamesId)) {
      countryIds.push(entry.geonamesId);
    }
  }

  // "US and worldwide" is a contradiction a free-text box allows. Resolve it
  // as "and the rest of the world too": the wider of the two wins, so nobody
  // is excluded.
  if (worldwide) {
    return { raw: trimmed, matched: WORLDWIDE, languages: [], countryIds: [], worldwide: true };
  }

  return {
    raw: trimmed,
    matched: names.length > 0 ? names.join(' + ') : null,
    languages,
    countryIds,
    worldwide: false,
  };
}

/** True when this pref can actually rule anyone out. */
export function regionGateActive(pref: RegionPref | null | undefined): boolean {
  return !!pref && !pref.worldwide && pref.languages.length > 0;
}

// ── Reading the creator's side ──────────────────────────────────────────────

export interface CreatorRegionSignal {
  totalPosts: number;
  /** Posts whose textLanguage is a real language code. */
  classifiedPosts: number;
  /** Posts whose textLanguage is 'un' — usually a caption too short to classify. */
  unclassifiedPosts: number;
  /** Posts with no textLanguage field at all. */
  missingLanguagePosts: number;
  /** language code -> post count, 'un' excluded. */
  languageCounts: Record<string, number>;
  /** Distinct GeoNames numeric ids seen on locationMeta.countryCode. */
  countryIds: number[];
  /** Posts carrying any locationMeta.countryCode value, parseable or not. */
  postsWithCountry: number;
}

function postsOf(rawData: unknown): unknown[] {
  if (Array.isArray(rawData)) return rawData;
  if (rawData !== null && typeof rawData === 'object') {
    const p = (rawData as Record<string, unknown>).posts;
    if (Array.isArray(p)) return p;
  }
  return [];
}

/**
 * A GeoNames numeric id, or null.
 *
 * An ISO code like 'US' is deliberately NOT converted. Mapping ISO to GeoNames
 * needs a table nothing here has checked against this database, and a wrong id
 * would read as a confident match. Unconvertible values simply carry no
 * country evidence, which is the truth about them.
 */
function geonamesId(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** Read the language + venue-country evidence out of an influencer's raw_data. */
export function readCreatorRegionSignal(rawData: unknown): CreatorRegionSignal {
  const posts = postsOf(rawData);

  const languageCounts: Record<string, number> = {};
  const countryIds: number[] = [];
  let classifiedPosts = 0;
  let unclassifiedPosts = 0;
  let missingLanguagePosts = 0;
  let postsWithCountry = 0;

  for (const raw of posts) {
    if (raw === null || typeof raw !== 'object') {
      missingLanguagePosts += 1;
      continue;
    }
    const post = raw as Record<string, unknown>;

    const lang =
      typeof post.textLanguage === 'string' ? post.textLanguage.trim().toLowerCase() : '';
    if (lang === '') {
      missingLanguagePosts += 1;
    } else if (lang === 'un') {
      unclassifiedPosts += 1;
    } else {
      classifiedPosts += 1;
      languageCounts[lang] = (languageCounts[lang] ?? 0) + 1;
    }

    const meta = post.locationMeta;
    if (meta !== null && typeof meta === 'object') {
      const code = (meta as Record<string, unknown>).countryCode;
      if (code !== null && code !== undefined && `${code}`.trim() !== '') {
        postsWithCountry += 1;
        const id = geonamesId(code);
        if (id !== null && !countryIds.includes(id)) countryIds.push(id);
      }
    }
  }

  return {
    totalPosts: posts.length,
    classifiedPosts,
    unclassifiedPosts,
    missingLanguagePosts,
    languageCounts,
    countryIds,
    postsWithCountry,
  };
}

// ── The verdict ─────────────────────────────────────────────────────────────

/**
 * One classified post in a foreign language is a repost, a lyric quote, or a
 * two-word caption the classifier guessed at. Two is a pattern. This is the
 * whole difference between a filter and a coin flip, so it is a named constant
 * and a test pins it.
 */
export const MIN_CLASSIFIED_POSTS_FOR_MISMATCH = 2;

export type RegionMatch = 'match' | 'mismatch' | 'unknown';

export type RegionBasis =
  | 'country'
  | 'language'
  | 'no_target'
  | 'no_language_signal'
  | 'thin_language_signal';

export interface RegionAssessment {
  verdict: RegionMatch;
  basis: RegionBasis;
  /** Language codes seen on this creator's posts, most frequent first. */
  languages: string[];
  /**
   * The languages this verdict was computed AGAINST.
   *
   * Carried so a consumer can check the verdict still matches the config it is
   * about to act on. Without it, "mismatch" is a bare boolean with no
   * provenance: a verdict computed under a Russia-targeting pref would exclude
   * a creator under a US-targeting one, since both are simply `mismatch`.
   */
  targetLanguages: string[];
  /** Only set when verdict === 'mismatch'. Persists into qualification_reason. */
  reason?: string;
}

/** Do two language targets describe the same gate? Order-insensitive. */
export function sameLanguageTarget(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((code, i) => code === right[i]);
}

/** Fixed lead phrase — pool-gates.ts classifies exclusions off this. */
export const AUDIENCE_LANGUAGE_REASON_PREFIX = 'Audience language:';

function rankedLanguages(counts: Record<string, number>): string[] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code]) => code);
}

function mismatchReason(seen: string[], pref: RegionPref): string {
  const shown = seen.slice(0, 3).join(', ');
  const want = pref.languages.join(', ');
  const where = pref.raw.length > 40 ? `${pref.raw.slice(0, 39)}…` : pref.raw;
  const text =
    `${AUDIENCE_LANGUAGE_REASON_PREFIX} posts are in ${shown}, ` +
    `not the ${want} this firm's region (${where}) targets`;
  return text.length <= 140 ? text : `${text.slice(0, 139)}…`;
}

/**
 * Place one creator against the firm's region pref.
 *
 * Order matters and IS the module:
 *
 *   1. no usable target                     -> unknown  (gate inert)
 *   2. any post in a wanted language        -> match    (language decides)
 *   3. no classified posts                  -> country tag if we have one,
 *                                              else unknown
 *   4. one classified post, not a match     -> country tag if we have one,
 *                                              else unknown (too thin)
 *   5. >= 2 classified posts, none matching -> mismatch
 *
 * Country is checked at 3 and 4 and nowhere else, which is the precise
 * meaning of "confirms, never excludes". It resolves what language cannot
 * say; it does not overrule what language does say. A venue tag is one post's
 * location, at 10% coverage, and a creator who captions everything in Russian
 * does not serve an English-language release because they once tagged a bar
 * in Brooklyn.
 *
 * The firm's escape hatch for a real multilingual market is the region box
 * itself: "US, Spanish" resolves to ['en','es'] and keeps both.
 */
export function assessCreatorRegion(
  signal: CreatorRegionSignal,
  pref: RegionPref | null | undefined,
): RegionAssessment {
  const seen = rankedLanguages(signal.languageCounts);

  if (!regionGateActive(pref)) {
    return {
      verdict: 'unknown',
      basis: 'no_target',
      languages: seen,
      targetLanguages: pref?.languages ?? [],
    };
  }
  const p = pref as RegionPref;

  const matched = p.languages.reduce((n, code) => n + (signal.languageCounts[code] ?? 0), 0);
  if (matched > 0) {
    return { verdict: 'match', basis: 'language', languages: seen, targetLanguages: p.languages };
  }

  const inTargetCountry =
    p.countryIds.length > 0 && signal.countryIds.some((id) => p.countryIds.includes(id));

  if (signal.classifiedPosts === 0) {
    return inTargetCountry
      ? { verdict: 'match', basis: 'country', languages: seen, targetLanguages: p.languages }
      : {
          verdict: 'unknown',
          basis: 'no_language_signal',
          languages: seen,
          targetLanguages: p.languages,
        };
  }

  if (signal.classifiedPosts < MIN_CLASSIFIED_POSTS_FOR_MISMATCH) {
    return inTargetCountry
      ? { verdict: 'match', basis: 'country', languages: seen, targetLanguages: p.languages }
      : {
          verdict: 'unknown',
          basis: 'thin_language_signal',
          languages: seen,
          targetLanguages: p.languages,
        };
  }

  return {
    verdict: 'mismatch',
    basis: 'language',
    languages: seen,
    targetLanguages: p.languages,
    reason: mismatchReason(seen, p),
  };
}

// ── Run-level reporting ─────────────────────────────────────────────────────

/**
 * The geo/language split for one run, for the SSE `qualification` frame and
 * the pipeline.qualification audit row.
 *
 * Every creator lands in exactly one verdict bucket, and the coverage counters
 * say WHY 'unknown' is the size it is: "12 unknown" is not actionable, "12
 * unknown, 9 of them with no classifiable caption" is. Without that split the
 * report would imply we looked at 12 creators and could not decide, when in
 * fact we had nothing to look at.
 */
export interface RegionReport {
  region: string | null;
  matched: string | null;
  target_languages: string[];
  gate_active: boolean;
  assessed: number;
  match: number;
  mismatch: number;
  unknown: number;
  /** Unknowns split by why we could not place them. */
  unknown_no_language_signal: number;
  unknown_thin_language_signal: number;
  /** Creators with at least one venue-tagged post (the 10%-coverage signal). */
  with_country_signal: number;
  /** Creators a venue tag placed inside the target country. */
  country_confirmed: number;
}

export function emptyRegionReport(pref: RegionPref | null | undefined): RegionReport {
  return {
    region: pref?.raw ?? null,
    matched: pref?.matched ?? null,
    target_languages: pref?.languages ?? [],
    gate_active: regionGateActive(pref),
    assessed: 0,
    match: 0,
    mismatch: 0,
    unknown: 0,
    unknown_no_language_signal: 0,
    unknown_thin_language_signal: 0,
    with_country_signal: 0,
    country_confirmed: 0,
  };
}

/** Fold one creator's verdict into the run report. Mutates and returns it. */
export function tallyRegion(
  report: RegionReport,
  signal: CreatorRegionSignal,
  assessment: RegionAssessment,
): RegionReport {
  report.assessed += 1;
  report[assessment.verdict] += 1;
  if (assessment.verdict === 'unknown') {
    if (assessment.basis === 'no_language_signal') report.unknown_no_language_signal += 1;
    if (assessment.basis === 'thin_language_signal') report.unknown_thin_language_signal += 1;
  }
  if (signal.postsWithCountry > 0) report.with_country_signal += 1;
  if (assessment.verdict === 'match' && assessment.basis === 'country') {
    report.country_confirmed += 1;
  }
  return report;
}
