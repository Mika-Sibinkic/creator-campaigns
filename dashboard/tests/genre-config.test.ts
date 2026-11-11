// tests/genre-config.test.ts
//
// Proves no genre is privileged by default.
//
// Three places could bake a genre in and shape money and candidate supply for
// every firm, regardless of what that firm releases:
//   1. pricing-engine.ts  — a hardcoded genre premium list.
//   2. pricing.ts         — a default `genre` parameter, which would stop the
//      table's own neutral `default` (1.15x) from ever firing.
//   3. spotify.ts         — a literal fallback discovery query. Spotify
//      Development Mode strips artist.genres, so a literal would run on nearly
//      every campaign and seed the whole candidate pool.
//
// Four layers:
//   1. parsing            — untrusted jsonb from firms.scraping_prefs.
//   2. premium table      — configuration, empty by default, exact-match.
//   3. genre resolution   — campaign → legacy → firm → null. No default.
//   4. source invariants  — none of the three carries a genre literal.
//
// Hermetic: no env, no network, no DB.
//
// Run: npx tsx tests/genre-config.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_GENRE_PREMIUMS,
  NEUTRAL_GENRE_MULTIPLIER,
  MIN_GENRE_PREMIUM,
  MAX_GENRE_PREMIUM,
  normalizeGenre,
  parseGenreList,
  parseGenrePremiums,
  genrePremium,
  resolveGenre,
  resolveGenrePremiums,
} from '../src/lib/genre-config';
import { calculateInitialOffer } from '../src/lib/pricing-engine';
import { estimatePrice } from '../src/lib/pricing';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(msg);
    console.error(`  ✗ FAIL: ${msg}`);
  }
}
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// ───────────────────────────────────────────────────────────────────────────
// 1. Normalization + parsing of untrusted jsonb
// ───────────────────────────────────────────────────────────────────────────
{
  assert(normalizeGenre('  Country  ') === 'country', 'genre is trimmed + lowercased');
  assert(normalizeGenre('') === null, 'blank genre → null');
  assert(normalizeGenre('   ') === null, 'whitespace-only genre → null');
  assert(normalizeGenre(null) === null, 'null genre → null');
  assert(normalizeGenre(undefined) === null, 'undefined genre → null');
  assert(normalizeGenre(42 as unknown as string) === null, 'non-string genre → null');

  assert(
    JSON.stringify(parseGenreList(['Hip Hop', ' drill ', ''])) ===
      JSON.stringify(['hip hop', 'drill']),
    'genre list normalized, blanks dropped'
  );
  assert(
    JSON.stringify(parseGenreList(['pop', 'POP', 'Pop'])) === JSON.stringify(['pop']),
    'genre list dedupes case-insensitively'
  );
  assert(parseGenreList('country').length === 0, 'a bare string is not a genre list');
  assert(parseGenreList(null).length === 0, 'null → empty genre list');
  assert(parseGenreList({ genres: ['pop'] }).length === 0, 'an object is not a genre list');
  assert(
    JSON.stringify(parseGenreList(['a', 1, null, 'b'])) === JSON.stringify(['a', 'b']),
    'non-string entries dropped from a genre list'
  );
  // Order is load-bearing: entry 0 is the primary genre.
  assert(parseGenreList(['drill', 'trap'])[0] === 'drill', 'genre list preserves order');
}

// ───────────────────────────────────────────────────────────────────────────
// 2. The premium table — configuration, not a literal
// ───────────────────────────────────────────────────────────────────────────
{
  assert(
    Object.keys(DEFAULT_GENRE_PREMIUMS).length === 0,
    'THE HEADLINE: the default premium table is EMPTY — no genre is privileged'
  );
  assert(NEUTRAL_GENRE_MULTIPLIER === 1.0, 'the neutral multiplier is exactly 1.0');

  // Out of the box, every genre prices identically.
  for (const g of ['country', 'pop', 'hip-hop', 'americana', 'drill', 'k-pop', null]) {
    assert(
      genrePremium(g) === NEUTRAL_GENRE_MULTIPLIER,
      `unconfigured firm: ${String(g)} gets the neutral multiplier`
    );
  }

  // A firm that wants a premium configures one.
  const labelPremiums = { country: 1.1, 'pop-country': 1.1, americana: 1.1, pop: 1.1 };
  assert(genrePremium('country', labelPremiums) === 1.1, 'a configured genre gets its premium');
  assert(genrePremium('Country', labelPremiums) === 1.1, 'lookup is case-insensitive');
  assert(genrePremium('hip-hop', labelPremiums) === 1.0, 'an unconfigured genre stays neutral');

  // EXACT match, not substring. The old implementation used
  // `norm.includes(g)` with 'pop' in the needle list, so "indie pop",
  // "bedroom pop", "k-pop" and "pop punk" all silently collected the country
  // premium — while "hip-hop" did not, because 'hop' !== 'pop'.
  for (const g of ['indie pop', 'bedroom pop', 'dream pop', 'k-pop', 'synthpop', 'pop punk']) {
    assert(
      genrePremium(g, labelPremiums) === 1.0,
      `substring bug is gone: "${g}" does not inherit the "pop" premium`
    );
  }
  assert(genrePremium('pop', labelPremiums) === 1.1, 'but an exact "pop" still matches');

  // Untrusted premium blobs degrade to neutral, never to arbitrary pricing.
  assert(Object.keys(parseGenrePremiums(null)).length === 0, 'null premiums → empty');
  assert(Object.keys(parseGenrePremiums('x')).length === 0, 'string premiums → empty');
  assert(Object.keys(parseGenrePremiums([1, 2])).length === 0, 'array premiums → empty');
  assert(
    Object.keys(parseGenrePremiums({ pop: 'lots' })).length === 0,
    'non-numeric premium dropped'
  );
  assert(
    Object.keys(parseGenrePremiums({ pop: NaN })).length === 0,
    'NaN premium dropped'
  );
  assert(
    Object.keys(parseGenrePremiums({ pop: Infinity })).length === 0,
    'Infinity premium dropped'
  );
  // Money sanity band: a typo'd 110 (meant 1.10) must not 100x an offer.
  assert(
    Object.keys(parseGenrePremiums({ pop: 110 })).length === 0,
    `premium above ${MAX_GENRE_PREMIUM} dropped, not clamped`
  );
  assert(
    Object.keys(parseGenrePremiums({ pop: 0.01 })).length === 0,
    `premium below ${MIN_GENRE_PREMIUM} dropped, not clamped`
  );
  assert(
    parseGenrePremiums({ pop: MAX_GENRE_PREMIUM }).pop === MAX_GENRE_PREMIUM,
    'the band is inclusive at the top'
  );
  assert(
    parseGenrePremiums({ pop: MIN_GENRE_PREMIUM }).pop === MIN_GENRE_PREMIUM,
    'the band is inclusive at the bottom'
  );
  assert(
    parseGenrePremiums({ '  Pop  ': 1.1 }).pop === 1.1,
    'premium keys are normalized'
  );

  assert(
    resolveGenrePremiums({ scrapingPrefs: { genre_premiums: { drill: 1.2 } } }).drill === 1.2,
    'premiums resolve out of firms.scraping_prefs'
  );
  assert(
    Object.keys(resolveGenrePremiums({})).length === 0,
    'a firm with no prefs gets the empty table'
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Genre resolution — campaign → legacy → firm → null
// ───────────────────────────────────────────────────────────────────────────
{
  assert(resolveGenre({}, {}) === null, 'THE HEADLINE: no configuration → null, NOT "country"');

  assert(
    resolveGenre({}, { scrapingPrefs: { genres: ['drill', 'trap'] } }) === 'drill',
    'firm default is used when the campaign says nothing'
  );
  assert(
    resolveGenre({ artistData: { genre: 'Grime' } }, { scrapingPrefs: { genres: ['drill'] } }) ===
      'grime',
    'legacy artist_data.genre beats the firm default'
  );
  assert(
    resolveGenre(
      { scrapingOverrides: { genres: ['afrobeats'] }, artistData: { genre: 'grime' } },
      { scrapingPrefs: { genres: ['drill'] } }
    ) === 'afrobeats',
    'campaign override beats everything'
  );

  // Junk at any level degrades to the next level, never to a guess.
  assert(
    resolveGenre({ scrapingOverrides: { genres: [] } }, { scrapingPrefs: { genres: ['drill'] } }) ===
      'drill',
    'an empty campaign override falls through to the firm'
  );
  assert(
    resolveGenre({ scrapingOverrides: 'nonsense' }, {}) === null,
    'a malformed override resolves to null, not a default'
  );
  assert(
    resolveGenre({ artistData: { genre: 42 } }, {}) === null,
    'a non-string legacy genre resolves to null'
  );
  assert(
    resolveGenre({}, { scrapingPrefs: { genres: 'country' } }) === null,
    'a malformed firm genres value resolves to null'
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 4. End-to-end through the two pricing paths
// ───────────────────────────────────────────────────────────────────────────
{
  // pricing-engine: identical creator, two labels, no configuration.
  // ER at the calibrated TikTok median (pricing-engine.ts),
  // where the engagement multiplier is exactly 1.0x, so only genre moves.
  const base = {
    follower_count: 5000,
    engagement_rate: 0.0813,
    per_creator_cap_usd: 500,
  };
  const countryLabel = calculateInitialOffer({ ...base, genre: 'country' });
  const hipHopLabel = calculateInitialOffer({ ...base, genre: 'hip-hop' });
  assert(
    countryLabel.initial_offer_usd === hipHopLabel.initial_offer_usd,
    `THE HEADLINE: unconfigured, a country and a hip-hop label offer the same ` +
      `(got ${countryLabel.initial_offer_usd} vs ${hipHopLabel.initial_offer_usd})`
  );
  assert(countryLabel.initial_offer_usd === 50, `neutral offer is 50*1.0*1.0 = 50 (got ${countryLabel.initial_offer_usd})`);

  // The old hardcoded +10% is reproducible — as one firm's setting, not everyone's.
  const countryConfigured = calculateInitialOffer({
    ...base,
    genre: 'country',
    genre_premiums: { country: 1.1 },
  });
  assert(
    countryConfigured.initial_offer_usd === 55,
    `a configured +10% gives 50*1.1 = 55 (got ${countryConfigured.initial_offer_usd})`
  );
  // ...and that setting does NOT leak to the other label.
  const hipHopUnderCountryConfig = calculateInitialOffer({
    ...base,
    genre: 'hip-hop',
    genre_premiums: { country: 1.1 },
  });
  assert(
    hipHopUnderCountryConfig.initial_offer_usd === 50,
    'a country premium does not raise a hip-hop offer'
  );

  // The ceiling stays structural — the premium can never breach it.
  const capped = calculateInitialOffer({
    follower_count: 5_000_000,
    engagement_rate: 0.2,
    per_creator_cap_usd: 40,
    genre: 'country',
    genre_premiums: { country: MAX_GENRE_PREMIUM },
  });
  assert(
    capped.initial_offer_usd === 40,
    `offer is still min(formula, cap) with a max premium (got ${capped.initial_offer_usd})`
  );

  // ── B2: estimatePrice can RISE, and must stay bounded ──────────────────
  //
  // GENRE_MULTIPLIERS (country 1.2, pop 1.3, hip hop 1.4, r&b 1.3,
  // default 1.15). A real genre reaches the table via
  // firms.scraping_prefs.genres[0], which /onboarding writes, so relative to
  // a 1.2 baseline:
  //     hip hop 1.4 = +16.7%   pop / r&b 1.3 = +8.3%   country = unchanged
  //
  // So prices can move UP, and on the ONE dollar path that has no ceiling:
  // price_estimate_mid is persisted and then quoted verbatim to the creator
  // (outreach.ts:751 -> priceRules, "The ONLY money figure you may write is
  // $X"), bounded only by the [25, 2000] sanity clamp. The rise itself is
  // defensible — the table is a market observation — but an unbounded
  // creator-facing figure is not, so the campaign ceiling now applies here
  // exactly as it always has in calculateInitialOffer.
  {
    const uncapped = estimatePrice(50_000, 0.05, 'tiktok', 'hip hop');
    const asCountry = estimatePrice(50_000, 0.05, 'tiktok', 'country');
    assert(
      uncapped.mid > asCountry.mid,
      'a hip-hop campaign genuinely prices above a country one (the market table)'
    );

    const capped = estimatePrice(50_000, 0.05, 'tiktok', 'hip hop', 'normal', 200);
    assert(
      capped.mid <= 200,
      `THE B2 BOUND: the estimate never exceeds the campaign ceiling (got ${capped.mid})`
    );
    assert(
      capped.high <= 200,
      `nor does the top of the range, which is mid * 1.4 (got ${capped.high})`
    );
    assert(
      capped.low <= capped.mid && capped.mid <= capped.high,
      'and the range stays ordered after clamping'
    );

    // Every genre, every urgency, stays inside the ceiling.
    for (const g of ['country', 'pop', 'hip hop', 'r&b', 'rock', 'indie', 'electronic', null]) {
      for (const u of ['low', 'normal', 'high', 'urgent']) {
        const r = estimatePrice(500_000, 0.3, 'youtube', g, u, 150);
        assert(
          r.mid <= 150 && r.high <= 150,
          `ceiling holds for genre=${String(g)} urgency=${u} (mid ${r.mid}, high ${r.high})`
        );
      }
    }

    // The ceiling beats the $25 floor: we never name a number we are not
    // authorized to pay.
    const tinyCap = estimatePrice(50_000, 0.05, 'tiktok', 'hip hop', 'normal', 10);
    assert(tinyCap.mid === 10, `a ceiling below the $25 floor still wins (got ${tinyCap.mid})`);

    // Omitted / unusable caps leave behaviour exactly as before.
    const noCap = estimatePrice(50_000, 0.05, 'tiktok', 'hip hop');
    for (const bad of [null, undefined, 0, -5, NaN, Infinity]) {
      assert(
        estimatePrice(50_000, 0.05, 'tiktok', 'hip hop', 'normal', bad).mid === noCap.mid,
        `an unusable cap ${String(bad)} is ignored, not applied as a bound`
      );
    }
    // A cap above the formula changes nothing.
    assert(
      estimatePrice(50_000, 0.05, 'tiktok', 'hip hop', 'normal', 99_999).mid === noCap.mid,
      'a ceiling above the formula leaves the estimate untouched'
    );
  }

  // pricing.ts: the default parameter is gone.
  const noGenre = estimatePrice(10_000, 0.05, 'tiktok');
  const explicitCountry = estimatePrice(10_000, 0.05, 'tiktok', 'country');
  assert(
    noGenre.formula_inputs.genre_multiplier === 1.15,
    `THE HEADLINE: an unspecified genre gets the NEUTRAL 1.15 default ` +
      `(got ${noGenre.formula_inputs.genre_multiplier}), not country's 1.2`
  );
  assert(
    explicitCountry.formula_inputs.genre_multiplier === 1.2,
    'an explicit country campaign still gets the country market rate'
  );
  assert(
    noGenre.mid < explicitCountry.mid,
    'so an unspecified campaign no longer silently prices as country'
  );
  for (const bad of [null, undefined, '', '   ']) {
    assert(
      estimatePrice(10_000, 0.05, 'tiktok', bad).formula_inputs.genre_multiplier === 1.15,
      `blank genre ${JSON.stringify(bad)} → neutral multiplier, no crash`
    );
  }
  assert(
    close(estimatePrice(10_000, 0.05, 'tiktok', 'HIP HOP').formula_inputs.genre_multiplier, 1.4),
    'market-rate lookup is case-insensitive'
  );
  // normalizeGenre TRIMS where the old `.toLowerCase()` did not, so a padded
  // value that used to miss the table and land on `default` (1.15) now hits
  // its real rate. Documented rather than left as a surprise.
  assert(
    close(estimatePrice(10_000, 0.05, 'tiktok', '  pop  ').formula_inputs.genre_multiplier, 1.3),
    'a padded genre is now trimmed into the table (was 1.15 via default)'
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 5. Source invariants — the three literals cannot come back
// ───────────────────────────────────────────────────────────────────────────
{
  // These assertions must read EXECUTABLE code only. The fix deliberately
  // leaves comments quoting the old literals so the next reader knows what
  // was removed and why — matching those would make the guard unfalsifiable.
  const stripComments = (src: string): string =>
    src
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');

  const LIB = join(process.cwd(), 'src', 'lib');
  const engineSrc = stripComments(readFileSync(join(LIB, 'pricing-engine.ts'), 'utf8'));
  const pricingSrc = stripComments(readFileSync(join(LIB, 'pricing.ts'), 'utf8'));
  const spotifySrc = stripComments(readFileSync(join(LIB, 'spotify.ts'), 'utf8'));

  assert(
    !/['"]country['"]/.test(engineSrc),
    'pricing-engine carries no hardcoded genre literal'
  );
  assert(
    !/return 1\.1;/.test(engineSrc),
    'pricing-engine no longer returns a literal 1.1 premium'
  );
  assert(
    engineSrc.includes('DEFAULT_GENRE_PREMIUMS'),
    'pricing-engine sources its premium table from configuration'
  );

  assert(
    !/genre: string = "/.test(pricingSrc),
    'pricing.ts has no default genre parameter'
  );
  assert(
    /genre\?: string \| null/.test(pricingSrc),
    'pricing.ts takes genre as optional with no default'
  );

  assert(
    !/searchGenre \|\| "/.test(spotifySrc),
    'spotify.ts never falls back to a literal discovery genre'
  );
  assert(
    /if \(searchGenre\)/.test(spotifySrc),
    'spotify.ts runs the genre query only when a genre exists'
  );

  // The run route must resolve genre rather than reading one field that
  // nothing writes.
  const runSrc = stripComments(
    readFileSync(
      join(process.cwd(), 'src', 'app', 'api', 'campaigns', '[id]', 'run', 'route.ts'),
      'utf8'
    )
  );
  assert(runSrc.includes('resolveGenre'), 'the run route resolves genre through genre-config');
}

if (failures.length > 0) console.error('\nFailures:\n - ' + failures.join('\n - '));
console.log(`genre-config test: ${passed}/${passed + failed} pass`);
process.exit(failed === 0 ? 0 : 1);
