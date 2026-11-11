// tests/instagram-scrape.test.ts
//
// Unit tests for the Instagram discovery path: the actor payload
// in src/lib/apify.ts and the normalizer in src/lib/discovery-candidates.ts.
//
// Hermetic and fixture-driven. NO live scrape has been run for this feature —
// a real one costs Apify credit. tests/fixtures/instagram/ carries a
// synthetic payload whose field names and types come from the actor's own
// published schema, and says so in its own first key.
//
// Two of these assertions exist because the failure they describe is SILENT:
//   - Apify ignores unknown input keys, so an imagined field costs a full
//     billed run and returns no error. The payload is pinned exactly.
//   - Instagram carries no language field on any actor, so every IG creator
//     is unplaceable by the region gate and MUST be kept. A
//     regression there would quietly delete the entire Instagram pool from
//     any campaign whose firm has a region set.
//
// Run: npx tsx tests/instagram-scrape.test.ts

import { readFileSync } from 'node:fs';
import { buildInstagramActorInput, type InstagramProfile } from '../src/lib/apify';
import {
  DEAD_ACCOUNT_REACH_FLOOR,
  candidateKey,
  candidatesFromInstagram,
  candidatesFromTikTok,
  instagramPostEngagements,
  planPlatforms,
  prefilterCandidates,
  resolveEngagementFloors,
  toDiscoveryPost,
} from '../src/lib/discovery-candidates';
import {
  assessCreatorRegion,
  readCreatorRegionSignal,
  resolveRegionPref,
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

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/instagram/search-user-sample.json', import.meta.url), 'utf8'),
) as { _synthetic: string; items: InstagramProfile[] };

// ── 1. The actor payload ─────────────────────────────────────────────────────
{
  const input = buildInstagramActorInput(['city record collectors', 'indie music scene'], 25);

  assert(
    input.search === 'city record collectors,indie music scene',
    'payload: terms are sent as ONE comma-joined string, not an array',
  );
  assert(
    input.searchType === 'user',
    "payload: searchType is the wire value 'user' (the enum default is 'place' — omitting it searches LOCATIONS at full price)",
  );
  assert(input.searchLimit === 25, 'payload: searchLimit passes through');

  assert(
    buildInstagramActorInput(['x'], 9999).searchLimit === 250,
    "payload: searchLimit is clamped to the actor's 250 maximum",
  );
  assert(
    buildInstagramActorInput(['x'], 0).searchLimit === 25,
    'payload: a zero searchLimit falls back to the default rather than requesting nothing',
  );
  assert(
    buildInstagramActorInput(['x']).searchLimit === 25,
    'payload: an omitted searchLimit defaults',
  );
}
{
  // Apify silently ignores unknown input keys: a typo or an imagined field
  // produces no error and a full bill. These four must never appear.
  const input = buildInstagramActorInput(['x'], 10);
  const keys = Object.keys(input);
  for (const forbidden of [
    'enhanceUserSearchWithFacebookPage',
    'isUserTaggedFeedURL',
    'isUserReelFeedURL',
    'proxy',
    'proxyConfiguration',
    'country',
    'countryCode',
  ]) {
    assert(!keys.includes(forbidden), `payload: never sends "${forbidden}" (not an input on this actor)`);
  }
  // The actor declares FIVE inputs — search, searchType, searchLimit,
  // enhanceUserSearchWithFacebookPage and liveSearch. We send three and
  // deliberately omit the last two; the earlier wording here claimed the
  // actor only had three, which was simply false.
  assert(
    keys.length === 3 &&
      keys.includes('search') &&
      keys.includes('searchType') &&
      keys.includes('searchLimit'),
    `payload: sends exactly the three inputs we intend, omitting the other two the actor declares (got ${keys.join(', ')})`,
  );
  assert(
    !keys.includes('liveSearch'),
    'payload: liveSearch is a real actor input we deliberately do not set',
  );
}

// ── 2. candidatesFromInstagram ───────────────────────────────────────────────
const rows = candidatesFromInstagram(fixture.items);
const byName = new Map(rows.map((r) => [r.username, r]));
{
  assert(rows.length === 5, `normalize: 7 fixture entries produce 5 creators (got ${rows.length})`);
  assert(
    rows.filter((r) => r.username === 'cityvinyl_example').length === 1,
    'normalize: a creator returned by two search terms is deduped, not double-upserted',
  );
  assert(
    !rows.some((r) => r.username === ''),
    'normalize: a profile with no username is dropped — a blank would collide every nameless row onto one (platform, username) key',
  );
  assert(
    rows.every((r) => r.platform === 'instagram'),
    'normalize: every row is stamped instagram',
  );
  assert(
    rows.every((r) => r.db_row.platform === 'instagram'),
    'normalize: the persisted row is stamped instagram (the upsert conflict key is platform+username)',
  );
  assert(
    rows.every((r) => !('contact_email' in r.db_row) && !('content_genres' in r.db_row)),
    'normalize: the upsert row never carries contact_email/content_genres — on conflict it would null a found email for every label',
  );
}
{
  const r = byName.get('cityvinyl_example')!;
  assert(r.followers === 45000, 'normalize: followersCount maps to followers');
  assert(r.following === 900, 'normalize: followsCount maps to following');
  assert(r.display_name === 'City Vinyl Club', 'normalize: fullName maps to display_name');
  assert(
    r.profile_url === 'https://www.instagram.com/cityvinyl_example',
    'normalize: profile_url is built from the handle',
  );
  assert(
    r.avatar_url === 'https://example.invalid/pp/cityvinyl_example_hd.jpg',
    'normalize: the HD avatar is preferred',
  );
  assert(r.verified === false, 'normalize: verified maps through');
  assert(r.posts.length === 6, 'normalize: latestPosts become posts');

  // 7,000 likes + 220 comments over 6 posts = 1,203.33 mean, / 45,000 followers
  assert(
    r.engagement_rate === 0.0267,
    `normalize: engagement is mean (likes+comments) per follower (got ${r.engagement_rate})`,
  );
  assert(
    Math.abs(r.reach_per_follower - 7220 / 6 / 45000) < 1e-9,
    'normalize: reach_per_follower is the unrounded same measure',
  );
  assert(r.ratio === 50, 'normalize: follower/following ratio');

  // contact-discovery.ts reads raw_data.authorMeta.bioLink to fetch a
  // link-in-bio. Mapping externalUrl onto it makes IG contact discovery work
  // with no branch over there.
  assert(
    (r.author_meta as Record<string, unknown>).bioLink === 'https://linktr.ee/cityvinyl_example',
    'normalize: externalUrl is mapped onto authorMeta.bioLink so contact discovery works unchanged',
  );
  assert(
    (r.author_meta as Record<string, unknown>).fans === 45000,
    'normalize: authorMeta is shaped like TikTok\'s so existing readers keep working',
  );
}
{
  const r = byName.get('cityvinyl_example')!;
  const post = r.posts[0];
  assert(post.text === 'New arrivals wall is restocked. Come dig. #vinylcommunity #austin', 'post: caption maps to text');
  assert(post.diggCount === 1200, 'post: likesCount maps to diggCount');
  assert(post.commentCount === 40, 'post: commentsCount maps to commentCount');
  assert(post.createTimeISO === '2026-08-14T15:02:11.000Z', 'post: timestamp maps to createTimeISO');
  assert(
    post.createTime === Math.floor(Date.parse('2026-08-14T15:02:11.000Z') / 1000),
    'post: createTime is the epoch-second form the qualifier reads',
  );
  assert(
    JSON.stringify(post.hashtags) === JSON.stringify([{ name: 'vinylcommunity' }, { name: 'austin' }]),
    'post: bare hashtag strings become {name} objects like TikTok\'s',
  );
  assert(post.shortCode === 'Cx1aaaaaaaa', 'post: the original vendor keys survive underneath');
  assert(
    post.playCount === undefined,
    'post: an Image post gets NO invented playCount — a 0 would read as a dead account, a like count would be a fabricated denominator',
  );
}
{
  // Neither videoPlayCount nor videoViewCount is a DOCUMENTED latestPosts
  // field: both appear only on top-level items from a 'popular' reels search,
  // and latestPosts has no enumerated sub-schema. Mapping them onto playCount
  // was an inference, and playCount is read as `views` by outreach.ts and
  // draft-all — copy sent TO the creator. So it is not mapped at all.
  const r = byName.get('songsbymay_example')!;
  assert(
    r.posts[0].playCount === undefined,
    'post: no playCount is inferred for Instagram — it would become a fabricated view count in outreach copy',
  );
  assert(
    r.posts[0].videoViewCount === 9000,
    'post: the vendor key survives verbatim in raw_data, so nothing is lost',
  );
  assert(
    toDiscoveryPost({ videoPlayCount: 1234 }).playCount === undefined,
    'post: videoPlayCount is not mapped either',
  );
  // Instagram engagement never depended on plays, so dropping it costs no
  // arithmetic — this is the assertion that says so.
  assert(
    instagramPostEngagements({ likesCount: 10, commentsCount: 2, videoViewCount: 999999 }) === 12,
    'post: engagement is likes + comments only, never plays',
  );
}
{
  // Alternate spellings that have appeared across this actor family. A
  // silently-missing like count reads as a dead account and deletes a real
  // creator, so unknown must stay unknown rather than becoming 0.
  assert(instagramPostEngagements({ likesCount: 10, commentsCount: 2 }) === 12, 'post: engagements sum');
  assert(
    instagramPostEngagements({ likeCount: 10, commentCount: 2 } as never) === 12,
    'post: alternate like/comment spellings are accepted',
  );
  assert(instagramPostEngagements({}) === 0, 'post: a post with no counts contributes zero engagements');
  assert(
    toDiscoveryPost({}).diggCount === undefined,
    'post: an absent like count stays undefined, never 0',
  );
  assert(
    toDiscoveryPost({ likesCount: '450' } as never).diggCount === 450,
    'post: a numeric-string count is coerced rather than dropped',
  );
}

// ── 3. The pre-filter signals the run route acts on ──────────────────────────
{
  const bot = byName.get('followtrain_bot')!;
  assert(
    bot.following / Math.max(bot.followers, 1) > 5,
    'prefilter: a follow-for-follow account trips the mass-follow ratio',
  );

  const dead = byName.get('dormant_gallery')!;
  assert(
    dead.reach_per_follower < DEAD_ACCOUNT_REACH_FLOOR.instagram,
    'prefilter: 2 likes across 30k followers falls under the Instagram reach floor',
  );

  const silent = byName.get('silentpress_example')!;
  assert(silent.posts.length === 0, 'prefilter: an empty latestPosts is a no-content reject');

  const healthy = byName.get('cityvinyl_example')!;
  assert(
    healthy.reach_per_follower >= DEAD_ACCOUNT_REACH_FLOOR.instagram &&
      healthy.following / healthy.followers <= 5,
    'prefilter: a healthy creator survives every pre-filter',
  );
  assert(
    DEAD_ACCOUNT_REACH_FLOOR.tiktok === 0.005,
    'prefilter: the TikTok floor is unchanged at the long-standing 0.005',
  );
  // 0.005 against an Instagram engagements-per-follower rate is a 0.5%
  // engagement rate, which is INSIDE the normal range — the actor's own
  // published sample computes to ~0.0038 and would have been discarded as
  // dead. Zero Instagram rows exist to calibrate against, so the floor sits an
  // order of magnitude below any published benchmark.
  assert(
    DEAD_ACCOUNT_REACH_FLOOR.instagram < 0.0038,
    'prefilter: the Instagram floor does not discard the actor\'s own sample profile',
  );
}

// ── 3b. A typical label config must not delete the Instagram pool ───────────
//
// The regression test for the defect this file's earlier version missed
// entirely. A typical firms.scraping_prefs:
//
//   {"region":"US","language":"en","engagement_min":0.03,
//    "follower_min":1500,"follower_max":250000, ...}
//
// engagement_min 0.03 is a mild filter against the TikTok rate, which divides
// by PLAYS, so most TikTok creators clear it. Against an Instagram rate,
// which divides by FOLLOWERS, it is above almost everything real. Applied
// platform-blind it meant: Apify billed for the Instagram scrape, every
// creator it returned was discarded before persistence, and the run reported
// success.
const LABEL_PREFS = {
  region: 'US',
  language: 'en',
  genres: ['country', 'pop-country', 'americana', 'indie'],
  content_style: 'music-creators',
  engagement_min: 0.03,
  follower_min: 1500,
  follower_max: 250000,
};
{
  const floors = resolveEngagementFloors(LABEL_PREFS);
  assert(floors.tiktok === 0.03, 'floors: the configured engagement_min still applies to TikTok');
  assert(
    floors.instagram === undefined,
    'floors: it does NOT leak onto Instagram, whose rate has a different denominator',
  );

  const { survivors, rejected } = prefilterCandidates(rows, {
    followerMin: LABEL_PREFS.follower_min,
    engagementFloors: floors,
  });
  const keptNames = survivors.map((s) => s.username).sort();

  assert(
    keptNames.includes('cityvinyl_example') && keptNames.includes('songsbymay_example'),
    `label config: real Instagram creators SURVIVE (kept: ${keptNames.join(', ') || 'none'})`,
  );
  assert(
    survivors.length === 2,
    `label config: exactly the two healthy creators survive (got ${survivors.length})`,
  );
  assert(
    !rejected.some((r) => r.reason === 'below_engagement_floor'),
    'label config: nobody is cut by an engagement floor borrowed from another platform',
  );

  // And the floor still works when a firm deliberately opts in.
  const optedIn = resolveEngagementFloors({
    ...LABEL_PREFS,
    engagement_min_instagram: 0.03,
  });
  assert(optedIn.instagram === 0.03, 'floors: a firm CAN set an Instagram floor explicitly');
  const strict = prefilterCandidates(rows, {
    followerMin: LABEL_PREFS.follower_min,
    engagementFloors: optedIn,
  });
  assert(
    strict.survivors.length === 0 &&
      strict.rejected.some((r) => r.reason === 'below_engagement_floor'),
    'floors: an explicitly configured Instagram floor is enforced',
  );
}

// ── 3c. Every pre-filter branch, including the two that fire for Instagram ──
{
  const cfg = {
    followerMin: 1500,
    engagementFloors: { tiktok: 0.03, instagram: undefined } as ReturnType<
      typeof resolveEngagementFloors
    >,
  };
  const { rejected } = prefilterCandidates(rows, cfg);
  const reasonFor = (u: string) => rejected.find((r) => r.username === u)?.reason;

  assert(reasonFor('silentpress_example') === 'no_content', 'branch: no_content fires');
  assert(reasonFor('followtrain_bot') === 'mass_follow', 'branch: mass_follow fires');
  assert(reasonFor('dormant_gallery') === 'dead_account', 'branch: dead_account fires');

  // below_follower_floor — Instagram only, since TikTok bounds it in the actor.
  const tiny = candidatesFromInstagram([
    {
      username: 'tinyaccount',
      followersCount: 400,
      followsCount: 100,
      latestPosts: [{ likesCount: 80, commentsCount: 5, timestamp: '2026-08-01T00:00:00.000Z' }],
    },
  ]);
  assert(
    prefilterCandidates(tiny, cfg).rejected[0]?.reason === 'below_follower_floor',
    'branch: below_follower_floor fires for Instagram, which no actor input can bound',
  );

  // below_engagement_floor — only when a floor for THAT platform exists.
  const lowIg = candidatesFromInstagram([
    {
      username: 'lowengagement',
      followersCount: 50_000,
      followsCount: 200,
      latestPosts: [{ likesCount: 60, commentsCount: 2, timestamp: '2026-08-01T00:00:00.000Z' }],
    },
  ]);
  assert(
    prefilterCandidates(lowIg, cfg).survivors.length === 1,
    'branch: with no Instagram floor configured, a low-engagement IG creator is kept',
  );
  assert(
    prefilterCandidates(lowIg, {
      ...cfg,
      engagementFloors: { tiktok: 0.03, instagram: 0.03 },
    }).rejected[0]?.reason === 'below_engagement_floor',
    'branch: below_engagement_floor fires once that platform has a floor',
  );
}

// ── 3d. Unknown followers are never a fabricated denominator ────────────────
{
  // The Instagram actor types followersCount as nullable and really does omit
  // it for private/restricted profiles. Math.max(followers, 1) turned that into
  // an engagement_rate of ~1240, which cleared every floor and persisted a
  // confident follower_count of 0.
  const unknown = candidatesFromInstagram([
    {
      username: 'privateprofile',
      followsCount: 300,
      latestPosts: [
        { likesCount: 1200, commentsCount: 40, timestamp: '2026-08-01T00:00:00.000Z' },
      ],
    },
  ]);
  assert(unknown.length === 1, 'unknown followers: the creator is still returned');
  const u = unknown[0];
  assert(u.followers_known === false, 'unknown followers: flagged as unknown, not measured');
  assert(
    u.engagement_rate === 0 && u.reach_per_follower === 0,
    `unknown followers: no rate is invented (got ${u.engagement_rate})`,
  );
  assert(
    u.db_row.follower_count === null && u.db_row.engagement_rate === null,
    'unknown followers: persisted as null, never a confident 0',
  );
  assert(u.ratio === null, 'unknown followers: no follower/following ratio is computed');

  // And it is KEPT — fail-open on missing data, like every other gate here.
  const out = prefilterCandidates(unknown, {
    followerMin: 1500,
    engagementFloors: { tiktok: 0.03, instagram: 0.03 },
  });
  assert(
    out.survivors.length === 1,
    'unknown followers: kept, never measured against a ratio we would have had to invent',
  );
}

// ── 3e. The same handle on two platforms is two creators ────────────────────
{
  // `influencers` is unique on (platform, username), and a run now holds both
  // platforms. Keyed on the bare username, a Map silently keeps the LAST entry
  // — so one platform's campaign_influencers row took the other's score, tier,
  // bot_flagged and price_estimate_mid, and price_estimate_mid is quoted
  // verbatim to the creator during negotiation.
  const ig = candidatesFromInstagram([
    {
      username: 'samehandle',
      followersCount: 20_000,
      followsCount: 500,
      latestPosts: [{ likesCount: 900, commentsCount: 30, timestamp: '2026-08-01T00:00:00.000Z' }],
    },
  ]);
  const tt = candidatesFromTikTok([
    {
      authorMeta: { name: 'samehandle', fans: 20_000, following: 500 },
      diggCount: 500,
      commentCount: 50,
      playCount: 10_000,
    },
  ]);
  const both = [...tt, ...ig];

  const naive = new Map(both.map((r) => [r.username, r]));
  assert(naive.size === 1, 'collision: a username-keyed map really does collapse the two');

  const keyed = new Map(both.map((r) => [candidateKey(r.platform, r.username), r]));
  assert(keyed.size === 2, 'collision: a platform-keyed map keeps both creators distinct');
  assert(
    keyed.get(candidateKey('tiktok', 'samehandle'))!.engagement_rate !==
      keyed.get(candidateKey('instagram', 'samehandle'))!.engagement_rate,
    'collision: the two rows really do carry different numbers, so mixing them up matters',
  );
  assert(
    candidateKey('tiktok', 'a') !== candidateKey('instagram', 'a'),
    'collision: the key separates platforms',
  );
}

// ── 4. Instagram and the region gate ────────────────────────────────────────
{
  // No Instagram actor emits a language field. So an IG creator can never be
  // placed, and the gate must keep every one of them. If this ever flips, a
  // firm with a region set loses its whole Instagram pool without being told.
  const us = resolveRegionPref('US')!;
  for (const r of rows) {
    const signal = readCreatorRegionSignal(r.db_row.raw_data);
    assert(
      signal.classifiedPosts === 0,
      `region: no language signal is invented for @${r.username} (Instagram has no language field)`,
    );
    const verdict = assessCreatorRegion(signal, us);
    assert(
      verdict.verdict === 'unknown',
      `region: @${r.username} is UNKNOWN, never excluded, under a US region`,
    );
  }
}

// ── 5. TikTok normalization is unchanged by the move ────────────────────────
{
  // candidatesFromTikTok was lifted out of the run route verbatim. Same
  // arithmetic, same db_row, plus the fields the route used to re-derive.
  const tiktokRows = candidatesFromTikTok([
    {
      authorMeta: {
        name: 'creator_one',
        nickName: 'Creator One',
        fans: 20000,
        following: 400,
        verified: false,
        signature: 'bio here',
        avatar: 'https://example.invalid/a.jpg',
        profileUrl: 'https://tiktok.com/@creator_one',
      },
      diggCount: 500,
      commentCount: 50,
      playCount: 10000,
      textLanguage: 'en',
    },
    {
      authorMeta: { name: 'creator_one', fans: 20000, following: 400 },
      diggCount: 300,
      commentCount: 30,
      playCount: 6000,
      textLanguage: 'en',
    },
    { text: 'no author', diggCount: 1 },
  ]);

  assert(tiktokRows.length === 1, 'tiktok: posts group by author and an authorless post is skipped');
  const t = tiktokRows[0];
  assert(t.platform === 'tiktok', 'tiktok: rows are stamped tiktok');
  assert(t.posts.length === 2, 'tiktok: both posts land on the author');
  assert(t.followers === 20000 && t.following === 400, 'tiktok: follower/following come off authorMeta');
  // (500+300 likes + 50+30 comments) / (10000+6000 plays) = 880/16000
  assert(t.engagement_rate === 0.055, `tiktok: engagement stays (likes+comments)/PLAYS (got ${t.engagement_rate})`);
  // mean plays 8000 / 20000 followers
  assert(t.reach_per_follower === 0.4, 'tiktok: reach_per_follower is mean plays per follower');
  assert(t.display_name === 'Creator One', 'tiktok: nickName maps to display_name');
  assert(t.db_row.platform === 'tiktok', 'tiktok: the persisted row is stamped tiktok');
  assert(
    !('contact_email' in t.db_row) && !('content_genres' in t.db_row),
    'tiktok: the upsert row never carries contact_email/content_genres — a re-run must not wipe a found email',
  );

  // The language signal the region gate needs must survive into raw_data.
  const signal = readCreatorRegionSignal(t.db_row.raw_data);
  assert(
    signal.classifiedPosts === 2 && signal.languageCounts.en === 2,
    'tiktok: textLanguage survives into raw_data, which is what the region gate reads',
  );
}

// ── 6. planPlatforms ────────────────────────────────────────────────────────
{
  assert(
    JSON.stringify(planPlatforms(['tiktok', 'instagram']).scrape) ===
      JSON.stringify(['tiktok', 'instagram']),
    'plan: both supported platforms are scraped',
  );
  assert(
    JSON.stringify(planPlatforms(['instagram']).scrape) === JSON.stringify(['instagram']),
    'plan: Instagram alone is honored — this is the campaign the product used to lie about',
  );
  assert(
    JSON.stringify(planPlatforms(['instagram', 'tiktok']).scrape) ===
      JSON.stringify(['tiktok', 'instagram']),
    'plan: pipeline order is fixed, not selection order (the cheaper, better-tested path lands first)',
  );
  assert(
    JSON.stringify(planPlatforms(['TikTok', 'TIKTOK', 'tiktok']).scrape) ===
      JSON.stringify(['tiktok']),
    'plan: casing is normalized and duplicates collapse',
  );

  for (const empty of [null, undefined, [], ['']]) {
    assert(
      JSON.stringify(planPlatforms(empty).scrape) === JSON.stringify(['tiktok']),
      `plan: ${JSON.stringify(empty)} falls back to TikTok, matching the route's long-standing default`,
    );
  }
}
{
  // The campaign-create UI offers YouTube and discovery cannot acquire it.
  // Reported, never silently dropped — a run that returns nothing must say
  // why rather than look like a product failure.
  const yt = planPlatforms(['youtube']);
  assert(
    JSON.stringify(yt.scrape) === JSON.stringify(['tiktok']),
    'plan: an all-unsupported selection still scrapes something rather than nothing',
  );
  assert(
    JSON.stringify(yt.unsupported) === JSON.stringify(['youtube']),
    'plan: YouTube is reported as unsupported',
  );

  const mixed = planPlatforms(['instagram', 'youtube']);
  assert(
    JSON.stringify(mixed.scrape) === JSON.stringify(['instagram']),
    'plan: supported platforms are scraped alongside an unsupported one',
  );
  assert(
    JSON.stringify(mixed.unsupported) === JSON.stringify(['youtube']),
    'plan: and the unsupported one is still reported',
  );
  assert(
    planPlatforms(['tiktok', 'instagram']).unsupported.length === 0,
    'plan: nothing is reported unsupported when everything is supported',
  );
}

console.log(`instagram-scrape test: ${passed} passed, ${failed} failed`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
