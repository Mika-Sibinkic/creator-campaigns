// tests/pool-gates.test.ts
//
// Unit tests for src/lib/pool-gates.ts — the per-firm pool-hygiene gates:
// the follower cap enforced at READ time (the shared influencers table can
// still hold multi-million-follower rows scraped before a firm set its cap),
// and the audience-fit hard gate (65/70/75 options).
//
// Hermetic: pure functions, no network, no DB, no model.
//
// Run: npx tsx tests/pool-gates.test.ts

import {
  DEFAULT_AUDIENCE_FIT_MIN,
  DEFAULT_EXCLUDE_MUSIC_ARTISTS,
  EXCLUSION_CAUSES,
  EXCLUSION_CAUSE_LABELS,
  AUDIENCE_FIT_GATE_OPTIONS,
  BLOCKLIST_REASON,
  audienceFitOf,
  classifyExclusionReason,
  contactBlock,
  gateExclusionPatch,
  poolGateExclusion,
  resolvePoolGatePrefs,
} from '../src/lib/pool-gates';
import { assessCreatorRegion, readCreatorRegionSignal } from '../src/lib/creator-region';
import { musicArtistPrecheck, precheckVerdict } from '../src/lib/qualify';
import { scoreInfluencers } from '../src/lib/scoring';

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

// ── 1. resolvePoolGatePrefs — tolerant jsonb parsing ─────────────────────────
{
  const d = resolvePoolGatePrefs(undefined);
  assert(d.follower_max === null, 'prefs: no config → no follower cap');
  assert(
    d.audience_fit_min === DEFAULT_AUDIENCE_FIT_MIN,
    'prefs: no config → the documented audience-fit default',
  );
  // THE default assertion. A non-zero default here would remove a large share
  // of a pool on merge, because the score it gates on is a follower-band
  // proxy (scoring.ts:154-182) and not a quality measure. Opt-in, not opt-out.
  assert(DEFAULT_AUDIENCE_FIT_MIN === 0, 'prefs: the audience-fit gate is OFF by default');
  assert(
    d.exclude_music_artists === true && DEFAULT_EXCLUDE_MUSIC_ARTISTS === true,
    'prefs: no config → music artists excluded by default',
  );
}
{
  // A typical label config shape (onboarding writes these keys).
  const p = resolvePoolGatePrefs({
    follower_min: 1500,
    follower_max: 250_000,
    engagement_min: 0.03,
    audience_fit_min: 65,
    exclude_music_artists: false,
  });
  assert(p.follower_max === 250_000, 'prefs: follower_max read through');
  assert(p.audience_fit_min === 65, 'prefs: audience_fit_min 65 (a gate option) read through');
  assert(p.exclude_music_artists === false, 'prefs: explicit artist allow read through');
}
{
  // A numeric string in jsonb is a value the firm plainly meant. Coercing it
  // is the difference between honoring a configured cap and silently ignoring
  // it: `follower_max: "250000"` used to resolve to null — no cap at all.
  const coerced = resolvePoolGatePrefs({
    follower_max: '250000',
    audience_fit_min: '70',
  });
  assert(coerced.follower_max === 250_000, 'prefs: numeric-string follower_max is honored, not dropped');
  assert(coerced.audience_fit_min === 70, 'prefs: numeric-string audience_fit_min is honored');
  assert(
    resolvePoolGatePrefs({ exclude_music_artists: 'false' }).exclude_music_artists === false,
    'prefs: string "false" toggle is honored',
  );

  // ONE posture for unreadable numbers: never tighten a gate. The two
  // thresholds used to fail in opposite directions on the same input class —
  // a bad follower_max loosened, a bad audience_fit_min tightened.
  const p = resolvePoolGatePrefs({
    follower_max: 'lots',
    audience_fit_min: 170,
    exclude_music_artists: 'yes',
  });
  assert(p.follower_max === null, 'prefs: unreadable follower_max → no cap (fails open)');
  assert(
    p.audience_fit_min === 0,
    'prefs: out-of-range audience_fit_min → gate OFF (fails open, same direction as follower_max)',
  );
  assert(
    p.exclude_music_artists === true,
    'prefs: unreadable artist toggle → the documented default, not a fail-open',
  );
  const q = resolvePoolGatePrefs('not an object');
  assert(
    q.follower_max === null && q.audience_fit_min === 0 && q.exclude_music_artists === true,
    'prefs: non-object jsonb → full defaults',
  );
  assert(
    resolvePoolGatePrefs({ follower_max: 0 }).follower_max === null,
    'prefs: follower_max 0 means no cap (matches the run route\'s reading)',
  );
  assert(
    resolvePoolGatePrefs({ follower_max: -5 }).follower_max === null,
    'prefs: negative follower_max → no cap',
  );
  assert(
    resolvePoolGatePrefs({ audience_fit_min: 0 }).audience_fit_min === 0,
    'prefs: explicit 0 disables the audience-fit gate',
  );
}

// ── 2. Follower cap — mega-accounts ─────────────────────────────────────────
{
  const prefs = resolvePoolGatePrefs({ follower_max: 250_000 });
  // Synthetic mega-accounts well above a 250k cap.
  const megas: [string, number][] = [
    ['mega_example_1', 5_200_000],
    ['mega_example_2', 4_800_000],
    ['mega_example_3', 1_600_000],
  ];
  for (const [name, followers] of megas) {
    const g = poolGateExclusion({ followers }, prefs);
    assert(g !== null && g.gate === 'follower_cap', `cap: ${name} (${followers}) is gated out`);
    assert(
      (g?.reason ?? '').includes('250,000') &&
        (g?.reason ?? '').includes(followers.toLocaleString('en-US')),
      `cap: ${name} reason names both numbers ("${g?.reason}")`,
    );
    assert((g?.reason ?? '').length <= 140, `cap: ${name} reason fits qualification_reason`);
  }
  assert(
    poolGateExclusion({ followers: 250_000 }, prefs) === null,
    'cap: exactly at the cap passes (cap is inclusive)',
  );
  assert(
    poolGateExclusion({ followers: 249_000 }, prefs) === null,
    'cap: under the cap passes',
  );
  assert(
    poolGateExclusion({ followers: 5_200_000 }, resolvePoolGatePrefs({})) === null,
    'cap: no cap configured → no gate, even for a mega-account',
  );
  assert(
    poolGateExclusion({ followers: null }, prefs) === null,
    'cap: unknown follower count → fail-open (no gate on missing data)',
  );
  assert(
    poolGateExclusion({ followers: NaN }, prefs) === null,
    'cap: NaN follower count → fail-open',
  );
}

// ── 3. Audience-fit hard gate (options: 65, 70 or 75) ───────────────────────
{
  for (const min of [65, 70, 75]) {
    const prefs = resolvePoolGatePrefs({ audience_fit_min: min });
    const below = poolGateExclusion({ audience_fit: min - 1 }, prefs);
    assert(
      below !== null && below.gate === 'audience_fit',
      `fit: ${min - 1} gated at minimum ${min}`,
    );
    assert(
      (below?.reason ?? '').includes(String(min)),
      `fit: reason names the firm's minimum ${min} ("${below?.reason}")`,
    );
    assert(
      poolGateExclusion({ audience_fit: min }, prefs) === null,
      `fit: exactly ${min} passes at minimum ${min}`,
    );
  }
  const defaults = resolvePoolGatePrefs(undefined);
  assert(
    poolGateExclusion({ audience_fit: 40 }, defaults) === null,
    'fit: the gate is OFF by default — a low fit alone excludes nobody',
  );
  assert(
    poolGateExclusion({ audience_fit: null }, defaults) === null,
    'fit: missing audience_fit → fail-open (older rows without a breakdown)',
  );
  assert(
    poolGateExclusion({ audience_fit: 40 }, resolvePoolGatePrefs({ audience_fit_min: 0 })) === null,
    'fit: explicit 0 disables the gate',
  );
}

// ── 4. Gate precedence + persistence patch ───────────────────────────────────
{
  const prefs = resolvePoolGatePrefs({ follower_max: 250_000, audience_fit_min: 70 });
  const both = poolGateExclusion({ followers: 5_200_000, audience_fit: 10 }, prefs);
  assert(
    both?.gate === 'follower_cap',
    'precedence: follower cap outranks audience fit when both fire',
  );
  const patch = gateExclusionPatch(both!);
  assert(patch.qualification_status === 'excluded', 'patch: status is excluded');
  assert(patch.qualification_reason === both!.reason, 'patch: reason carried verbatim');
  assert(
    patch.qualification_confidence === 1,
    'patch: confidence 1 — arithmetic fact, not a model opinion',
  );
}

// ── 5. audienceFitOf — score_breakdown jsonb reader ──────────────────────────
assert(audienceFitOf({ audience_fit: 82 }) === 82, 'fitOf: reads audience_fit');
assert(audienceFitOf({ audience_fit: 0 }) === 0, 'fitOf: zero is a real value, not missing');
assert(audienceFitOf(null) === null, 'fitOf: null breakdown → null');
assert(audienceFitOf(undefined) === null, 'fitOf: undefined breakdown → null');
assert(audienceFitOf([1, 2]) === null, 'fitOf: array breakdown → null');
assert(audienceFitOf({ audience_fit: 'high' }) === null, 'fitOf: non-numeric → null');
assert(audienceFitOf({}) === null, 'fitOf: absent key → null');

// ── 6. classifyExclusionReason — attributing a persisted exclusion ──────────
//
// The campaign qualification split reports WHY creators were ruled out, and
// there is no column for the cause, so the cause is read back out of the
// reason text. These round-trips are what stop the writers and the reader
// from drifting apart: every assertion below feeds REAL output from
// poolGateExclusion() / musicArtistPrecheck() back through the classifier
// rather than a copy of the wording.
{
  const capReason = poolGateExclusion(
    { followers: 5_200_000 },
    {
      follower_max: 250_000,
      audience_fit_min: 70,
      exclude_music_artists: true,
      region: null,
    },
  )!.reason;
  assert(
    classifyExclusionReason(capReason) === 'follower_cap',
    `round-trip: a real follower-cap reason classifies as follower_cap (got "${capReason}")`,
  );

  const fitReason = poolGateExclusion(
    { audience_fit: 41 },
    {
      follower_max: null,
      audience_fit_min: 70,
      exclude_music_artists: true,
      region: null,
    },
  )!.reason;
  assert(
    classifyExclusionReason(fitReason) === 'audience_fit',
    `round-trip: a real audience-fit reason classifies as audience_fit (got "${fitReason}")`,
  );

  // Audience language. Same round-trip discipline: REAL
  // assessCreatorRegion() output through REAL poolGateExclusion() and back
  // through the classifier, so the three cannot drift apart.
  const usPrefs = resolvePoolGatePrefs({ region: 'US' });
  assert(usPrefs.region !== null, 'prefs: a region string is parsed out of scraping_prefs');
  assert(
    usPrefs.region!.languages.includes('en'),
    'prefs: the parsed region carries its language expectation',
  );

  const foreign = assessCreatorRegion(
    readCreatorRegionSignal({
      posts: [{ textLanguage: 'ru' }, { textLanguage: 'ru' }],
    }),
    usPrefs.region,
  );
  const langGate = poolGateExclusion({ region_assessment: foreign }, usPrefs)!;
  assert(langGate.gate === 'audience_language', 'round-trip: a language mismatch fires its own gate');
  assert(
    langGate.reason.length <= 140,
    `round-trip: the language reason fits the 140-char budget (${langGate.reason.length})`,
  );
  assert(
    classifyExclusionReason(langGate.reason) === 'audience_language',
    `round-trip: a real audience-language reason classifies as audience_language (got "${langGate.reason}")`,
  );
  assert(
    EXCLUSION_CAUSES.includes('audience_language'),
    'round-trip: audience_language is in EXCLUSION_CAUSES — TypeScript does NOT check that array, and both UI consumers iterate it rather than the label record',
  );
  assert(
    typeof EXCLUSION_CAUSE_LABELS.audience_language === 'string' &&
      !/\bregion\b|\blocation\b|\blives?\b/i.test(EXCLUSION_CAUSE_LABELS.audience_language),
    'round-trip: the label says language, not location — there is no author-level geography in the scrape',
  );

  // The keeps. A gate that silently dropped what it could not read would be
  // worse than the dead input it replaced.
  const unreadable = assessCreatorRegion(
    readCreatorRegionSignal({ posts: [{ textLanguage: 'un' }, { textLanguage: 'un' }] }),
    usPrefs.region,
  );
  assert(
    poolGateExclusion({ region_assessment: unreadable }, usPrefs) === null,
    'gate: a creator with no classifiable caption is KEPT, not excluded',
  );
  assert(
    poolGateExclusion({ region_assessment: null }, usPrefs) === null,
    'gate: an unassessed creator is KEPT — the send paths cannot compute a verdict and must not invent one',
  );
  assert(
    poolGateExclusion({}, usPrefs) === null,
    'gate: an omitted region_assessment is KEPT',
  );
  assert(
    poolGateExclusion(
      { region_assessment: foreign },
      resolvePoolGatePrefs({ region: 'worldwide' }),
    ) === null,
    'gate: a worldwide region excludes nobody, whatever they post',
  );

  // Ranking: when both apply, the follower cap wins.
  const capAndLanguage = poolGateExclusion(
    { followers: 5_200_000, region_assessment: foreign },
    resolvePoolGatePrefs({ follower_max: 250_000, region: 'US' }),
  )!;
  assert(
    capAndLanguage.gate === 'follower_cap',
    'gate: the follower cap outranks the language gate when both fire',
  );

  const artistReason = musicArtistPrecheck({
    username: 'indiepulse_music_example',
    display_name: null,
    bio: 'indie pop artist | new single out now',
    followers: 20_000,
    engagement_rate: 0.04,
    verified: false,
    raw_data: null,
  })!.reason;
  assert(
    classifyExclusionReason(artistReason) === 'music_artist',
    `round-trip: a real music-artist reason classifies as music_artist (got "${artistReason}")`,
  );
}
{
  // Anything the gates did not write is 'other' — never a guess. This covers
  // every model-written verdict and every row excluded before the gates
  // existed.
  assert(
    classifyExclusionReason('Venue account — posts are show listings, not creator content') ===
      'other',
    'classify: a model verdict is unattributable, reported as other',
  );
  assert(classifyExclusionReason(null) === 'other', 'classify: null reason → other');
  assert(classifyExclusionReason(undefined) === 'other', 'classify: undefined reason → other');
  assert(classifyExclusionReason('   ') === 'other', 'classify: blank reason → other');
  assert(
    classifyExclusionReason('Creator has 900,000 followers, seems big') === 'other',
    'classify: prose that merely mentions followers is not a cap exclusion',
  );
  assert(
    classifyExclusionReason('Great audience fit but wrong genre') === 'other',
    'classify: prose that merely mentions audience fit is not a fit exclusion',
  );
}
{
  assert(
    EXCLUSION_CAUSES.includes('other') &&
      EXCLUSION_CAUSES.includes('no_posts') &&
      EXCLUSION_CAUSES.includes('abandoned') &&
      EXCLUSION_CAUSES.includes('blocklisted'),
    'causes: every bucket the writers can produce is enumerable for a UI breakdown',
  );
  assert(
    new Set(EXCLUSION_CAUSES).size === EXCLUSION_CAUSES.length,
    'causes: no duplicate buckets',
  );
  assert(
    EXCLUSION_CAUSES.every((c) => (EXCLUSION_CAUSE_LABELS[c] ?? '').length > 0),
    'causes: every cause has a human label',
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 7. THE DEFAULT MUST NOT DELETE THE CLIENT'S POOL
// ══════════════════════════════════════════════════════════════════════════
//
// This is the test that bites. The first cut of pool-gates defaulted
// audience_fit_min to 70, reasoning from scoring.ts:421's `>= 70`. But that
// threshold means "ideal audience size", and scoreAudienceFit is not a
// quality measure at all — it is followerBand + platformBonus, so `>= 70`
// decodes to "5,000-50,000 followers on a matching platform".
//
// A label with scraping_prefs.follower_min = 1,500 PAYS Apify to scrape the
// 1,500-5,000 band, and a default of 70 hard-excluded every one of them at
// confidence 1 with no model review.
//
// The score is computed from the REAL scoring path here rather than a
// hand-copied number, so this bites if either the default or the arithmetic
// moves under it.
{
  const scored = scoreInfluencers(
    [
      {
        username: 'smallbutreal_example',
        platform: 'tiktok',
        followers: 2_000, // inside the label's own scrape window (follower_min 1500)
        engagement_rate: 0.06,
        bio: 'austin coffee runs and gig reviews',
      },
    ],
    { genre: 'country', target_platforms: ['tiktok'], artist_name: 'Test Artist' },
  );
  const fit = scored.ranked_influencers[0]?.score_breakdown.audience_fit ?? null;
  assert(fit !== null, 'default: the scoring path produced an audience_fit to test against');
  assert(
    fit === 50,
    `default: a 2,000-follower creator on a matching platform scores ${fit} — followerBand(<5k)=30 + platform=20`,
  );
  assert(
    poolGateExclusion({ followers: 2_000, audience_fit: fit }, resolvePoolGatePrefs(undefined)) ===
      null,
    'DEFAULT: merging this does NOT exclude a 2,000-follower creator on a matching platform',
  );
  // Typical label prefs: a follower cap, no audience_fit_min key at all.
  const labelPrefs = resolvePoolGatePrefs({
    follower_min: 1_500,
    follower_max: 250_000,
    engagement_min: 0.03,
  });
  assert(labelPrefs.audience_fit_min === 0, 'DEFAULT: typical label prefs resolve to no audience-fit gate');
  assert(
    poolGateExclusion({ followers: 2_000, audience_fit: fit }, labelPrefs) === null,
    'DEFAULT: under a typical label config the 1,500-5,000 band they pay to scrape survives',
  );
  // And the gate still works for a firm that deliberately turns it on.
  assert(
    poolGateExclusion({ followers: 2_000, audience_fit: fit }, resolvePoolGatePrefs({ audience_fit_min: 70 }))
      ?.gate === 'audience_fit',
    'DEFAULT: opt-in still gates — the capability is kept, only the default changed',
  );
}
{
  // The UI offers only thresholds that actually partition the pool.
  assert(
    AUDIENCE_FIT_GATE_OPTIONS[0]?.value === 0,
    'options: the first/default choice is Off',
  );
  assert(
    AUDIENCE_FIT_GATE_OPTIONS.every(
      (o) => o.value === resolvePoolGatePrefs({ audience_fit_min: o.value }).audience_fit_min,
    ),
    'options: every offered value survives the prefs parser',
  );
  assert(
    AUDIENCE_FIT_GATE_OPTIONS.every((o) => o.label.length > 0 && o.detail.length > 0),
    'options: every choice says what it actually does',
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 8. Blocklist — "do not contact" must actually mean it
// ══════════════════════════════════════════════════════════════════════════
//
// influencers.blocklisted was a DISPLAY filter: present in the influencers
// list and detail pages, referenced nowhere in run, draft-all, send,
// outreach.ts or negotiation-tick. A label blocklisted a creator, the creator
// vanished from the UI, and the pipeline kept drafting, sending and negotiating
// with them. It looked obeyed and was not.
{
  const none = resolvePoolGatePrefs(undefined);
  const g = poolGateExclusion({ blocklisted: true, followers: 20_000 }, none);
  assert(g?.gate === 'blocklisted', 'blocklist: a blocklisted creator is gated with no firm config at all');
  assert(g?.reason === BLOCKLIST_REASON, 'blocklist: carries the stable inspectable reason');
  assert(
    classifyExclusionReason(g!.reason) === 'blocklisted',
    'blocklist: the reason round-trips to the blocklisted cause',
  );
  assert(
    gateExclusionPatch(g!).qualification_status === 'excluded',
    'blocklist: persists as an excluded row like every other gate',
  );
  assert(
    poolGateExclusion({ blocklisted: false, followers: 20_000 }, none) === null,
    'blocklist: an un-blocklisted creator is unaffected',
  );
  assert(
    poolGateExclusion({ followers: 20_000 }, none) === null,
    'blocklist: absent flag is not treated as blocklisted',
  );
  // Outranks the config gates: it is a human decision, not a threshold.
  const strict = resolvePoolGatePrefs({ follower_max: 1_000, audience_fit_min: 70 });
  assert(
    poolGateExclusion({ blocklisted: true, followers: 5_200_000, audience_fit: 10 }, strict)?.gate ===
      'blocklisted',
    'blocklist: outranks the follower cap and audience fit when all three fire',
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 9. contactBlock — the predicate the SEND paths share
// ══════════════════════════════════════════════════════════════════════════
{
  const none = resolvePoolGatePrefs(undefined);
  assert(contactBlock({}, none) === null, 'contact: a clean row is contactable');
  assert(
    contactBlock({ blocklisted: true }, none)?.code === 'blocklisted',
    'contact: blocklisted is refused at the send boundary',
  );
  assert(
    contactBlock({ bot_flagged: true }, none)?.code === 'bot_flagged',
    'contact: a bot-flagged row is refused',
  );
  assert(
    contactBlock({ blocklisted: true, bot_flagged: true }, none)?.code === 'blocklisted',
    'contact: the human decision outranks the bot flag',
  );
  const stored = contactBlock(
    { qualification_status: 'excluded', qualification_reason: 'Venue account — show listings' },
    none,
  );
  assert(stored?.code === 'excluded', 'contact: a persisted exclusion is refused');
  assert(
    stored?.reason === 'Venue account — show listings',
    'contact: the stored reason is surfaced verbatim, not replaced',
  );
  assert(
    (contactBlock({ qualification_status: 'excluded', qualification_reason: '  ' }, none)?.reason ?? '')
      .length > 0,
    'contact: a blank stored reason still yields something inspectable',
  );
  // A draft written before the firm set its cap.
  assert(
    contactBlock(
      { qualification_status: 'qualified', followers: 5_200_000 },
      resolvePoolGatePrefs({ follower_max: 250_000 }),
    )?.code === 'follower_cap',
    'contact: a row stored as qualified is still refused under the firm\'s CURRENT cap',
  );
  assert(
    contactBlock({ qualification_status: 'qualified', followers: 24_000 }, resolvePoolGatePrefs({ follower_max: 250_000 })) ===
      null,
    'contact: a qualified row under the cap sends normally',
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 10. The deterministic pre-check reasons are attributable, not "other"
// ══════════════════════════════════════════════════════════════════════════
//
// Rows carrying qualify.ts's own pre-check reasons used to classify as
// 'other', whose label read "ruled out on review" — the UI telling the label
// those creators had been reviewed when nothing reviewed them. Round-tripped from REAL precheckVerdict output.
{
  const noPosts = precheckVerdict({
    username: 'ghost',
    display_name: null,
    bio: 'hello',
    followers: 10_000,
    engagement_rate: 0.05,
    verified: false,
    raw_data: { posts: [] },
  });
  assert(noPosts !== null, 'precheck: a zero-post profile is decided deterministically');
  assert(
    classifyExclusionReason(noPosts!.reason) === 'no_posts',
    `precheck: the no-posts reason attributes to no_posts (got "${noPosts!.reason}")`,
  );

  const old = precheckVerdict(
    {
      username: 'dormant',
      display_name: null,
      bio: 'hello',
      followers: 10_000,
      engagement_rate: 0.05,
      verified: false,
      raw_data: { posts: [{ createTimeISO: '2019-01-01T00:00:00Z' } as never] },
    },
    Date.parse('2026-09-18T00:00:00Z'),
  );
  assert(old !== null, 'precheck: an ancient-posts profile is decided deterministically');
  assert(
    classifyExclusionReason(old!.reason) === 'abandoned',
    `precheck: the abandoned reason attributes to abandoned (got "${old!.reason}")`,
  );
  assert(
    !/review/i.test(EXCLUSION_CAUSE_LABELS.other),
    'labels: the catch-all no longer claims a reviewer looked at the row',
  );
}

console.log(`pool-gates test: ${passed} passed, ${failed} failed`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
