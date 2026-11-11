// tests/confirm-summary.test.ts
//
// Unit tests for src/lib/confirm-summary.ts — the copy layer behind
// /campaigns/[id]/confirm, which is on the main demo path (pressing Run
// discovery on an unconfirmed campaign redirects straight there).
//
// What this locks down:
//
//   1. NO RAW COLUMN NAMES. The confirm route answers 412
//      `campaign_caps_required` with `missing: ['total_budget_usd',
//      'per_creator_cap_usd']` AND a `message` that interpolates those column
//      names verbatim. The page must render its own labels instead.
//   2. NO BLANKS FOR UNSET PREFS. The page replaced two `<pre>{JSON}</pre>`
//      blocks; an unset pref has to read as the default that will actually
//      apply, never as an empty cell or the word `undefined`. The defaults
//      asserted here are the literal fallbacks in
//      api/campaigns/[id]/run/route.ts (follower_min 1500, no upper bound, no
//      engagement floor).
//   3. GARBAGE IN, READABLE OUT. These prefs are free-form jsonb written by
//      /onboarding and /settings. Nulls, strings-in-number-fields and
//      non-arrays must not produce NaN or [object Object].
//
// Run: npx tsx tests/confirm-summary.test.ts

import {
  CAP_FIELD_LABELS,
  capFieldLabel,
  capsRequiredMessage,
  describeOutreachPrefs,
  describeScrapingPrefs,
  type SummaryLine,
} from '../src/lib/confirm-summary';

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

function valueOf(lines: SummaryLine[], label: string): string {
  const hit = lines.find((l) => l.label === label);
  return hit ? hit.value : '<<missing>>';
}

function isDefault(lines: SummaryLine[], label: string): boolean {
  return lines.find((l) => l.label === label)?.isDefault === true;
}

/** No rendered value may contain a machine artefact. */
function assertClean(lines: SummaryLine[], where: string) {
  for (const l of lines) {
    assert(l.value.trim() !== '', `${where}/${l.label}: value is never blank`);
    assert(
      !/undefined|NaN|\[object Object\]|null/.test(l.value),
      `${where}/${l.label}: value has no machine artefact (got "${l.value}")`,
    );
    assert(
      !/_usd\b|_min\b|_max\b|_days\b/.test(l.label),
      `${where}/${l.label}: label is not a column name`,
    );
  }
}

// ── 1. Scraping prefs ───────────────────────────────────────────────────────
{
  const empty = describeScrapingPrefs({});
  assertClean(empty, 'scraping/empty');
  assert(valueOf(empty, 'Genres') === 'any genre', 'no genres reads "any genre"');
  assert(
    valueOf(empty, 'Follower range') === '1,500 and up',
    'unset follower range reports the real 1,500 default from the run route',
  );
  assert(isDefault(empty, 'Follower range'), 'the unset range is marked as a default');
  assert(
    valueOf(empty, 'Minimum engagement') === 'no floor set',
    'unset engagement floor says so rather than showing 0%',
  );
  assert(valueOf(empty, 'Region') === 'anywhere', 'unset region reads "anywhere"');

  assertClean(describeScrapingPrefs(null), 'scraping/null');
  assertClean(describeScrapingPrefs(undefined), 'scraping/undefined');
  assert(
    describeScrapingPrefs(null).length === describeScrapingPrefs({}).length,
    'null prefs produce the same set of lines as empty prefs',
  );

  const full = describeScrapingPrefs({
    genres: ['hyperpop', 'bedroom pop'],
    follower_min: 1500,
    follower_max: 250000,
    engagement_min: 0.03,
    region: 'US',
  });
  assertClean(full, 'scraping/full');
  assert(valueOf(full, 'Genres') === 'hyperpop, bedroom pop', 'genres join readably');
  assert(
    valueOf(full, 'Follower range') === '1,500 to 250,000',
    'a real follower range is thousands-separated',
  );
  assert(
    valueOf(full, 'Minimum engagement') === '3.0%',
    'engagement_min is a fraction in the DB and renders as a percent',
  );
  assert(!isDefault(full, 'Region'), 'a set region is not marked as a default');

  // Echoing the word back was the WHOLE feature for months, and a
  // confirmation screen that reports a setting the pipeline ignores is the
  // same broken promise in quieter type. So a set region now also states what
  // it does — and what it does is a language filter, not a location check.
  assert(
    valueOf(empty, 'How region is used') === '<<missing>>',
    'no region set → no effect line to explain (the block stays four rows)',
  );
  assert(
    valueOf(full, 'How region is used') === 'search terms + a language check',
    `a resolvable region names both things it does (got "${valueOf(full, 'How region is used')}")`,
  );
  // The line used to name the languages by ISO code ("search terms + en/es
  // check"). Those codes are internal; a label manager is not reading 639-1.
  for (const region of ['US', 'Berlin', 'Mexico']) {
    assert(
      !/\b(en|es|de|fr|pt|nl|it|af)\b/.test(
        valueOf(describeScrapingPrefs({ region }), 'How region is used'),
      ),
      `region "${region}": the confirm line carries no raw language codes`,
    );
  }
  // "en-only posts" was the first wording and it overstated twice over.
  // Under region "US" the language gate rules out only creators whose posts
  // are clearly in another language and keeps everyone it cannot read — and every
  // Instagram creator is unknown-and-kept by construction, since no Instagram
  // actor emits a language field at all. A confirm screen promising "en-only"
  // would be the same dead-control problem this work exists to fix.
  for (const region of ['US', 'Austin, Texas', 'Berlin']) {
    assert(
      !/only/i.test(valueOf(describeScrapingPrefs({ region }), 'How region is used')),
      `region "${region}": the confirm line never claims an only-this-language pool`,
    );
  }
  assert(
    valueOf(describeScrapingPrefs({ region: 'worldwide' }), 'How region is used') ===
      'search terms only',
    'a worldwide region promises no filtering, because it does none',
  );
  assert(
    valueOf(describeScrapingPrefs({ region: 'Riverside Arts District' }), 'How region is used') ===
      'search terms only',
    'a region the pipeline cannot resolve does NOT claim to filter anything',
  );
  for (const region of ['US', 'worldwide', 'Riverside Arts District', 'Austin, Texas']) {
    const lines = describeScrapingPrefs({ region });
    assertClean(lines, `scraping/region:${region}`);
    assert(
      !/\blives?\b|\blocated\b|\bbased in\b|\bcreators in\b/i.test(
        valueOf(lines, 'How region is used'),
      ),
      `region "${region}": the copy never claims to know where a creator lives`,
    );
    // The confirm page keys its <dl> rows by label, so a duplicate label is a
    // React duplicate-key bug rather than a cosmetic one.
    const labels = lines.map((l) => l.label);
    assert(
      new Set(labels).size === labels.length,
      `region "${region}": every label in the block is unique (they are React keys)`,
    );
    // The value column is roughly 200-260px at text-sm; past ~35 characters it
    // wraps and drags the neighbouring block's rows out of alignment.
    for (const l of lines) {
      assert(
        l.value.length <= 35,
        `region "${region}"/${l.label}: value stays inside the column (${l.value.length} chars)`,
      );
    }
  }

  // Half-set range: floor only, ceiling only.
  assert(
    valueOf(describeScrapingPrefs({ follower_min: 5000 }), 'Follower range') ===
      '5,000 and up',
    'floor without ceiling reads "and up"',
  );
  assert(
    valueOf(describeScrapingPrefs({ follower_max: 90000 }), 'Follower range') ===
      '1,500 to 90,000',
    'ceiling without floor still names the enforced 1,500 floor',
  );

  // Garbage jsonb.
  const junk = describeScrapingPrefs({
    genres: 'not-an-array',
    follower_min: 'abc',
    follower_max: -5,
    engagement_min: null,
    region: '   ',
  });
  assertClean(junk, 'scraping/junk');
  assert(valueOf(junk, 'Genres') === 'any genre', 'a non-array genres value degrades safely');
  assert(
    valueOf(junk, 'Follower range') === '1,500 and up',
    'non-numeric bounds fall back to the default, not NaN',
  );
  assert(valueOf(junk, 'Region') === 'anywhere', 'a whitespace region is treated as unset');

  // PostgREST hands NUMERIC back as a string.
  assert(
    valueOf(describeScrapingPrefs({ follower_min: '2500' }), 'Follower range') ===
      '2,500 and up',
    'a numeric string from PostgREST is a real number',
  );
  assert(
    valueOf(describeScrapingPrefs({ genres: ['pop', '', '  '] }), 'Genres') === 'pop',
    'blank genre entries are dropped',
  );
}

// ── 2. Outreach prefs ───────────────────────────────────────────────────────
{
  const empty = describeOutreachPrefs({});
  assertClean(empty, 'outreach/empty');
  assert(
    valueOf(empty, 'Tone') === 'the default warm, specific tone',
    'unset tone names the default in words',
  );
  assert(valueOf(empty, 'Writing rules') === 'none set', 'no dos/donts reads "none set"');
  assert(valueOf(empty, 'Follow-ups') === 'not set', 'unset follow-ups reads "not set"');
  assertClean(describeOutreachPrefs(null), 'outreach/null');

  const full = describeOutreachPrefs({
    tone: 'warm, specific, conversational',
    dos: ['reference recent posts'],
    donts: ['no exclamation points', 'no hope-this-finds-you-well'],
    signoff: '— Example Records',
    follow_up_cadence_days: 5,
    max_follow_ups: 2,
  });
  assertClean(full, 'outreach/full');
  assert(
    valueOf(full, 'Writing rules') === '1 thing to do, 2 to avoid',
    'writing rules are counted and singularised, not dumped as JSON',
  );
  assert(
    valueOf(full, 'Follow-ups') === 'up to 2, every 5 days',
    'follow-up cadence reads as a sentence',
  );
  assert(valueOf(full, 'Sign-off') === '— Example Records', 'the sign-off is shown verbatim');

  // 0 follow-ups is an affirmative choice, not "unset".
  const none = describeOutreachPrefs({ max_follow_ups: 0, follow_up_cadence_days: 5 });
  assert(
    valueOf(none, 'Follow-ups') === 'none, one message only',
    'max_follow_ups 0 reads as a deliberate choice',
  );
  assert(!isDefault(none, 'Follow-ups'), 'an explicit 0 is not marked as a default');

  // voice is the older key; tone wins when both exist.
  assert(
    valueOf(describeOutreachPrefs({ voice: 'dry and brief' }), 'Tone') === 'dry and brief',
    'voice is used when tone is absent',
  );
  assert(
    valueOf(describeOutreachPrefs({ voice: 'dry', tone: 'warm' }), 'Tone') === 'warm',
    'tone wins over voice',
  );
  assert(
    valueOf(describeOutreachPrefs({ dos: { a: 1 }, donts: null }), 'Writing rules') ===
      'none set',
    'non-array rule bags degrade to "none set"',
  );
  assert(
    valueOf(describeOutreachPrefs({ follow_up_cadence_days: 1, max_follow_ups: 1 }), 'Follow-ups') ===
      'up to 1, every 1 day',
    'a one-day cadence is singular',
  );
}

// ── 3. Cap gate copy ────────────────────────────────────────────────────────
{
  assert(capFieldLabel('total_budget_usd') === 'Total budget', 'budget column maps to its label');
  assert(
    capFieldLabel('per_creator_cap_usd') === 'Per-creator cap',
    'per-creator column maps to its label',
  );
  assert(
    capFieldLabel('some_future_cap_usd') === 'some future cap',
    'an unknown column is de-snaked rather than shown raw',
  );
  for (const [column, label] of Object.entries(CAP_FIELD_LABELS)) {
    assert(!label.includes('_'), `${column}: label carries no underscore`);
  }

  const both = capsRequiredMessage(['total_budget_usd', 'per_creator_cap_usd']);
  assert(!both.includes('_usd'), 'the message never interpolates a raw column name');
  assert(
    both.includes('Total budget') && both.includes('Per-creator cap'),
    'the message names both fields in the form’s own words',
  );
  assert(
    /cannot be armed|cannot pay/i.test(both),
    'the message says why the gate exists, not just that it failed',
  );

  const one = capsRequiredMessage(['per_creator_cap_usd']);
  assert(!one.includes(' and '), 'a single missing field reads without a conjunction');
  assert(one.includes('Per-creator cap'), 'a single missing field is still named');

  const none = capsRequiredMessage([]);
  assert(
    none.includes('a spending limit') && !none.includes('undefined'),
    'an empty missing[] still produces a sentence',
  );
}

console.log(`confirm-summary test: ${passed} passed, ${failed} failed`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
