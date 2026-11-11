// tests/creator-region.test.ts
//
// Unit tests for src/lib/creator-region.ts — making firms.scraping_prefs.region
// do something, without claiming more than the scrape can support.
//
// The assertions that matter most are the ones about what is NOT excluded. A
// region filter that quietly drops creators it could not read would be worse
// than the dead input it replaced: the label would see a smaller pool and
// believe it was scoped, when it was only truncated.
//
// Hermetic: pure functions, no network, no DB, no model.
//
// Run: npx tsx tests/creator-region.test.ts

import {
  AUDIENCE_LANGUAGE_REASON_PREFIX,
  MIN_CLASSIFIED_POSTS_FOR_MISMATCH,
  assessCreatorRegion,
  emptyRegionReport,
  readCreatorRegionSignal,
  regionGateActive,
  resolveRegionPref,
  tallyRegion,
} from '../src/lib/creator-region';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

/** A raw_data blob shaped like scraped influencers rows. */
function rawData(
  posts: { lang?: string | null; country?: unknown }[],
): { posts: Record<string, unknown>[] } {
  return {
    posts: posts.map((p) => {
      const post: Record<string, unknown> = { text: 'hello' };
      if (p.lang !== null && p.lang !== undefined) post.textLanguage = p.lang;
      if (p.country !== undefined) post.locationMeta = { countryCode: p.country };
      return post;
    }),
  };
}

// ── 1. resolveRegionPref ─────────────────────────────────────────────────────
{
  assert(resolveRegionPref(undefined) === null, 'pref: undefined → null');
  assert(resolveRegionPref(null) === null, 'pref: null → null');
  assert(resolveRegionPref('') === null, 'pref: empty string → null');
  assert(resolveRegionPref('   ') === null, 'pref: whitespace → null');
  assert(resolveRegionPref(42) === null, 'pref: a non-string → null');

  // The most common configured value.
  const us = resolveRegionPref('US')!;
  assert(us.matched === 'United States', 'pref: "US" resolves to the United States');
  assert(
    JSON.stringify(us.languages) === JSON.stringify(['en']),
    'pref: the US expects English-language posts',
  );
  assert(
    us.countryIds.length === 1 && us.countryIds[0] === 6252001,
    'pref: the US carries the GeoNames numeric id the scraper returns, not "US"',
  );
  assert(regionGateActive(us), 'pref: a resolved region activates the gate');

  // A city + state phrasing.
  const cityPref = resolveRegionPref('Austin, Texas')!;
  assert(cityPref.matched === 'United States', 'pref: a city + state resolves to its country');
  assert(
    JSON.stringify(cityPref.languages) === JSON.stringify(['en']),
    'pref: Austin expects English',
  );

  const uk = resolveRegionPref('UK')!;
  assert(
    uk.countryIds.length === 1 && uk.countryIds[0] === 2635167,
    'pref: the UK carries its own observed GeoNames id',
  );

  const ru = resolveRegionPref('Russia')!;
  assert(
    JSON.stringify(ru.languages) === JSON.stringify(['ru']),
    'pref: Russia expects Russian ("are Russians off-limits?", 2026-05-29)',
  );
}
{
  // "and then we can have the world too, right?" — the wider of the two wins,
  // so a contradictory box never costs anyone their place in the pool.
  const both = resolveRegionPref('US and worldwide')!;
  assert(both.worldwide === true, 'pref: "worldwide" anywhere in the text means worldwide');
  assert(both.languages.length === 0, 'pref: worldwide carries no language expectation');
  assert(!regionGateActive(both), 'pref: worldwide leaves the gate inert');

  for (const word of ['anywhere', 'Global', 'international', 'no preference']) {
    assert(
      resolveRegionPref(word)!.worldwide === true,
      `pref: "${word}" means no geographic scoping`,
    );
  }
}
{
  // A lookup miss is not evidence about anybody. The text still reaches the
  // query prompt; it just cannot rule a creator out.
  const odd = resolveRegionPref('Riverside Arts District')!;
  assert(odd.raw === 'Riverside Arts District', 'pref: unrecognized text is preserved verbatim for the prompt');
  assert(odd.matched === null, 'pref: unrecognized text resolves to no region');
  assert(odd.languages.length === 0, 'pref: unrecognized text expects no language');
  assert(!regionGateActive(odd), 'pref: unrecognized text CANNOT exclude anyone');
}
{
  // The documented escape hatch for a multilingual market.
  const multi = resolveRegionPref('US, Spanish')!;
  assert(
    multi.languages.includes('en') && multi.languages.includes('es'),
    'pref: "US, Spanish" unions both languages rather than picking one',
  );

  // Accents and punctuation must not defeat the table.
  assert(
    resolveRegionPref('España')!.languages[0] === 'es',
    'pref: accented input normalizes ("España" → Spain)',
  );
  assert(
    resolveRegionPref('U.S.A.')!.matched === 'United States',
    'pref: punctuated input normalizes ("U.S.A." → United States)',
  );
}

// ── 2. readCreatorRegionSignal ───────────────────────────────────────────────
{
  const s = readCreatorRegionSignal(
    rawData([{ lang: 'en' }, { lang: 'en' }, { lang: 'un' }, { lang: null }]),
  );
  assert(s.totalPosts === 4, 'signal: counts every post');
  assert(s.classifiedPosts === 2, 'signal: only real language codes count as classified');
  assert(s.unclassifiedPosts === 1, "signal: 'un' is counted separately, not as a language");
  assert(s.missingLanguagePosts === 1, 'signal: a missing textLanguage is counted separately');
  assert(s.languageCounts.en === 2, 'signal: per-language counts are kept');
  assert(s.languageCounts.un === undefined, "signal: 'un' never becomes a language bucket");
}
{
  // countryCode carries GeoNames NUMERIC ids on scraped rows, in both number
  // and string form. An ISO code is unconvertible without a table nothing here
  // has checked, so it contributes no evidence rather than a guessed id.
  const numeric = readCreatorRegionSignal(rawData([{ lang: 'en', country: 6252001 }]));
  assert(
    numeric.countryIds.length === 1 && numeric.countryIds[0] === 6252001,
    'signal: a numeric countryCode is read',
  );

  const stringy = readCreatorRegionSignal(rawData([{ lang: 'en', country: '2635167' }]));
  assert(
    stringy.countryIds[0] === 2635167,
    'signal: a numeric-string countryCode is read',
  );

  const iso = readCreatorRegionSignal(rawData([{ lang: 'en', country: 'US' }]));
  assert(iso.countryIds.length === 0, 'signal: an ISO code contributes NO country id (never guessed)');
  assert(
    iso.postsWithCountry === 1,
    'signal: an unparseable countryCode still counts toward geo coverage',
  );
}
{
  // Malformed input must not throw — this reads a vendor jsonb blob.
  for (const junk of [null, undefined, 42, 'nope', {}, { posts: 'no' }, { posts: [null, 7] }]) {
    const s = readCreatorRegionSignal(junk);
    assert(
      typeof s.classifiedPosts === 'number' && s.classifiedPosts === 0,
      `signal: malformed raw_data (${JSON.stringify(junk)}) degrades to an empty signal`,
    );
  }
  // A bare array of posts is accepted as well as { posts: [...] }.
  assert(
    readCreatorRegionSignal([{ textLanguage: 'fr' }]).classifiedPosts === 1,
    'signal: a bare post array is accepted',
  );
}

// ── 3. assessCreatorRegion — what gets KEPT ─────────────────────────────────
//
// These are the load-bearing ones. Scrapes return creators with 'un' on
// every post; every one of them must survive.
{
  const us = resolveRegionPref('US')!;

  const allUn = assessCreatorRegion(readCreatorRegionSignal(rawData([{ lang: 'un' }, { lang: 'un' }])), us);
  assert(allUn.verdict === 'unknown', "assess: an all-'un' creator is UNKNOWN, never a mismatch");
  assert(
    allUn.basis === 'no_language_signal',
    'assess: and the report says why — there was nothing to read',
  );
  assert(allUn.reason === undefined, 'assess: an unknown verdict carries no exclusion reason');

  const noPosts = assessCreatorRegion(readCreatorRegionSignal({ posts: [] }), us);
  assert(noPosts.verdict === 'unknown', 'assess: a creator with no posts is unknown, not excluded');

  const thin = assessCreatorRegion(readCreatorRegionSignal(rawData([{ lang: 'ru' }])), us);
  assert(
    thin.verdict === 'unknown' && thin.basis === 'thin_language_signal',
    'assess: ONE foreign-language post is too thin to exclude on',
  );

  assert(
    MIN_CLASSIFIED_POSTS_FOR_MISMATCH === 2,
    'assess: the mismatch threshold is two classified posts',
  );
}
{
  // No target => no opinion, whatever the creator posts.
  const inert = resolveRegionPref('Riverside Arts District')!;
  const ru = readCreatorRegionSignal(rawData([{ lang: 'ru' }, { lang: 'ru' }, { lang: 'ru' }]));
  assert(
    assessCreatorRegion(ru, inert).verdict === 'unknown',
    'assess: an unresolvable region rules out nobody',
  );
  assert(
    assessCreatorRegion(ru, null).verdict === 'unknown',
    'assess: no region at all rules out nobody',
  );
  assert(
    assessCreatorRegion(ru, resolveRegionPref('worldwide')).verdict === 'unknown',
    'assess: worldwide rules out nobody',
  );
}

// ── 4. assessCreatorRegion — what gets MATCHED and EXCLUDED ─────────────────
{
  const us = resolveRegionPref('US')!;

  const en = assessCreatorRegion(
    readCreatorRegionSignal(rawData([{ lang: 'en' }, { lang: 'ru' }])),
    us,
  );
  assert(en.verdict === 'match', 'assess: one post in the target language is a match');
  assert(en.basis === 'language', 'assess: and the basis is language');

  const ru = assessCreatorRegion(
    readCreatorRegionSignal(rawData([{ lang: 'ru' }, { lang: 'ru' }])),
    us,
  );
  assert(ru.verdict === 'mismatch', 'assess: two posts, all in another language, is a mismatch');
  assert(!!ru.reason, 'assess: a mismatch carries an exclusion reason');
  assert(
    ru.reason!.startsWith(AUDIENCE_LANGUAGE_REASON_PREFIX),
    'assess: the reason uses the fixed lead phrase the classifier matches on',
  );
  assert(ru.reason!.length <= 140, `assess: the reason fits the 140-char budget (${ru.reason!.length})`);
  assert(
    ru.reason!.includes('ru') && ru.reason!.includes('en'),
    'assess: the reason names both what they post and what was wanted',
  );
  assert(
    !/\blives?\b|\blocated\b|\bbased in\b/i.test(ru.reason!),
    'assess: the reason never claims to know where the creator lives',
  );
}
{
  // Country CONFIRMS: it rescues a creator language could not read...
  const us = resolveRegionPref('US')!;
  const tagged = assessCreatorRegion(
    readCreatorRegionSignal(rawData([{ lang: 'un', country: 6252001 }, { lang: 'un' }])),
    us,
  );
  assert(
    tagged.verdict === 'match' && tagged.basis === 'country',
    'assess: a venue tag inside the target country resolves an unreadable creator to a match',
  );

  // ...and NEVER overrules a language verdict it disagrees with.
  const contradicted = assessCreatorRegion(
    readCreatorRegionSignal(rawData([{ lang: 'ru', country: 6252001 }, { lang: 'ru' }])),
    us,
  );
  assert(
    contradicted.verdict === 'mismatch',
    'assess: one US venue tag does NOT overturn two Russian-language posts',
  );

  // A venue tag OUTSIDE the target country proves nothing: it is a trip.
  const abroad = assessCreatorRegion(
    readCreatorRegionSignal(rawData([{ lang: 'en' }, { lang: 'en', country: 2635167 }])),
    us,
  );
  assert(
    abroad.verdict === 'match',
    'assess: a foreign venue tag never excludes an on-language creator',
  );
}
{
  // A long region string must not blow the reason past 140 chars.
  const long = resolveRegionPref(
    'Austin, Texas and the greater American South including Houston and Atlanta',
  )!;
  const r = assessCreatorRegion(
    readCreatorRegionSignal(rawData([{ lang: 'ja' }, { lang: 'ja' }, { lang: 'ko' }])),
    long,
  );
  assert(r.verdict === 'mismatch', 'assess: a long region still produces a verdict');
  assert(r.reason!.length <= 140, `assess: a long region's reason is truncated to 140 (${r.reason!.length})`);
}

// ── 5. The run report ────────────────────────────────────────────────────────
{
  const us = resolveRegionPref('US')!;
  const report = emptyRegionReport(us);
  assert(report.gate_active === true, 'report: a resolved region reports the gate as active');
  assert(report.region === 'US', 'report: carries the raw region for the audit row');

  const rows = [
    rawData([{ lang: 'en' }, { lang: 'en' }]),          // match
    rawData([{ lang: 'un' }, { lang: 'un' }]),          // unknown, no signal
    rawData([{ lang: 'es' }]),                          // unknown, thin
    rawData([{ lang: 'ru' }, { lang: 'ru' }]),          // mismatch
    rawData([{ lang: 'un', country: 6252001 }]),        // match, by country
  ];
  for (const raw of rows) {
    const signal = readCreatorRegionSignal(raw);
    tallyRegion(report, signal, assessCreatorRegion(signal, us));
  }

  assert(report.assessed === 5, 'report: every creator screened is counted');
  assert(
    report.match + report.mismatch + report.unknown === report.assessed,
    'report: the three verdict buckets partition the pool exactly',
  );
  assert(report.match === 2, 'report: two matches (one by language, one by country)');
  assert(report.mismatch === 1, 'report: one mismatch');
  assert(report.unknown === 2, 'report: two unknowns');
  assert(
    report.unknown_no_language_signal === 1 && report.unknown_thin_language_signal === 1,
    'report: unknowns are split by WHY, so "unknown" is actionable',
  );
  assert(report.with_country_signal === 1, 'report: geo coverage is reported separately');
  assert(report.country_confirmed === 1, 'report: country-confirmed matches are attributable');
}
{
  const inert = emptyRegionReport(resolveRegionPref('Riverside Arts District'));
  assert(
    inert.gate_active === false && inert.target_languages.length === 0,
    'report: an unresolvable region is reported as an inactive gate, not a silent one',
  );
  assert(
    emptyRegionReport(null).region === null,
    'report: no region configured reports a null region',
  );
}

console.log(`creator-region test: ${passed} passed, ${failed} failed`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
