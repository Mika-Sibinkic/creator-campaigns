// tests/search-queries.test.ts
//
// Unit tests for generateSearchQueries() in src/lib/openai.ts — the one place
// a firm's region can influence what discovery ACQUIRES, and the
// place the platform list stopped being hardcoded to TikTok.
//
// Neither scraper takes a geo input: TikTokScrapeInput has no country/proxy
// field and instagram-search-scraper has no proxy configuration at all. So if
// the region does not reach this prompt, it cannot affect what comes back at
// all — everything downstream is a filter on an already-paid-for pool. That
// makes these assertions the load-bearing half of the region feature.
//
// Hermetic: the provider is mocked through registerProvider(), so NO network
// call and no model spend. Run: npx tsx tests/search-queries.test.ts

import { registerProvider, setLedgerWriter } from '../src/lib/model-provider';
import { generateSearchQueries } from '../src/lib/openai';

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

interface Captured {
  system: string;
  user: string;
}

async function main() {
  // Same hermeticity guard as tests/model-provider.test.ts: a developer shell
  // may export a real API key, and an empty chain means "no fallbacks", so a
  // failure can never walk into a live provider.
  process.env.MODEL_FALLBACK_CHAIN = '';

  // complete() SELF-LEDGERS, and setLedgerWriter(null) means "use the real
  // recordApiCall", which needs Supabase env. Mocking the provider therefore
  // makes this test hermetic against the MODEL and not against the DATABASE:
  // run it in a shell with .env.local loaded and its dozen calls would INSERT
  // a dozen rows into that database's api_ledger. Capture them instead —
  // which also lets us assert the ledgering is attributed correctly.
  const ledgered: { endpoint?: string; campaign_id?: string | null }[] = [];
  setLedgerWriter(async (e) => {
    ledgered.push({ endpoint: e.endpoint, campaign_id: e.campaign_id });
  });

  const calls: Captured[] = [];
  let reply = '{"queries":["indie song recs","austin americana","new country finds"]}';

  registerProvider('mock-queries', async ({ system, user }) => {
    calls.push({ system, user });
    return reply;
  });
  process.env.MODEL_PROVIDER = 'mock-queries';

  const base = {
    artist: 'Alex Owner',
    similarArtists: ['Zach Bryan', 'Tyler Childers'],
    trackName: 'Backroad Hymn',
    genres: ['americana'],
    campaignId: null,
  };

  // ── 1. No region ───────────────────────────────────────────────────────────
  {
    const out = await generateSearchQueries({ ...base });
    const { user } = calls[calls.length - 1];
    assert(out.length === 3, 'returns the parsed queries');
    assert(
      !/Audience region/i.test(user),
      'no region set → no region line in the prompt (the existing optional-field pattern)',
    );
    assert(user.includes('Alex Owner'), 'the artist still reaches the prompt');
    assert(user.includes('Backroad Hymn'), 'the track still reaches the prompt');
    assert(user.includes('americana'), 'the genre still reaches the prompt');
  }

  // ── 2. A region that resolves ──────────────────────────────────────────────
  {
    await generateSearchQueries({ ...base, region: 'US' });
    const { user } = calls[calls.length - 1];
    assert(/Audience region: US/.test(user), 'a set region reaches the prompt verbatim');
    assert(
      /local wording|city and scene names/i.test(user),
      'the prompt tells the model HOW to use the region, not just that one exists',
    );
    assert(
      /at most half/i.test(user),
      'the prompt caps region-flavored queries so the whole search plan is not narrowed to one city',
    );
  }

  // ── 3. A region the lookup table cannot resolve still reaches the model ────
  {
    // This is the case the post-filter cannot help with: "Riverside Arts District" resolves
    // to no language and gates nobody, but it is exactly the kind of phrase a
    // model can turn into a useful query. Dropping it would throw away the
    // only usable half of an unrecognized region.
    await generateSearchQueries({ ...base, region: 'Riverside Arts District' });
    const { user } = calls[calls.length - 1];
    assert(
      /Audience region: Riverside Arts District/.test(user),
      'an unresolvable region still steers the queries',
    );
  }
  {
    await generateSearchQueries({ ...base, region: null });
    assert(
      !/Audience region/i.test(calls[calls.length - 1].user),
      'an explicit null region adds no line',
    );
    await generateSearchQueries({ ...base, region: '' });
    assert(
      !/Audience region/i.test(calls[calls.length - 1].user),
      'an empty-string region adds no line',
    );
  }

  // ── 4. Platforms ───────────────────────────────────────────────────────────
  {
    await generateSearchQueries({ ...base, platforms: ['tiktok', 'instagram'] });
    const { system, user } = calls[calls.length - 1];
    assert(
      /tiktok and instagram/i.test(system),
      'both platforms are named in the system prompt (queries are fanned across them)',
    );
    assert(
      /tiktok and instagram/i.test(user),
      'both platforms are named in the user prompt',
    );
    assert(
      !/\bTikTok search queries\b/.test(system),
      'the prompt no longer asks for TikTok-only queries when Instagram is targeted',
    );
  }
  {
    await generateSearchQueries({ ...base, platforms: ['instagram'] });
    assert(
      /instagram/i.test(calls[calls.length - 1].system) &&
        !/tiktok/i.test(calls[calls.length - 1].system),
      'an Instagram-only campaign asks for Instagram queries',
    );
  }
  {
    // Back-compat: the pre-existing callers pass no platforms at all.
    await generateSearchQueries({ ...base });
    assert(
      /tiktok/i.test(calls[calls.length - 1].system),
      'an omitted platform list defaults to TikTok, matching the run route fallback',
    );
    await generateSearchQueries({ ...base, platforms: [] });
    assert(
      /tiktok/i.test(calls[calls.length - 1].system),
      'an empty platform list defaults to TikTok rather than naming nothing',
    );
  }

  // ── 5. Output handling is unchanged ────────────────────────────────────────
  {
    reply = JSON.stringify({
      queries: Array.from({ length: 14 }, (_, i) => `query ${i}`),
    });
    const many = await generateSearchQueries({ ...base, region: 'US' });
    assert(many.length === 10, 'the returned list is still capped at 10');

    reply = '{"queries":[]}';
    assert(
      (await generateSearchQueries({ ...base })).length === 0,
      'an empty queries array comes back empty rather than throwing',
    );

    reply = '{"nope":true}';
    assert(
      (await generateSearchQueries({ ...base })).length === 0,
      'a malformed response degrades to no queries rather than throwing',
    );
  }

  // ── 6. Ledgering attribution ───────────────────────────────────────────────
  {
    assert(ledgered.length > 0, 'every query-gen call is ledgered by complete() itself');
    assert(
      ledgered.every((e) => e.endpoint === 'discovery.search_queries'),
      'query-gen spend is attributed to discovery.search_queries, not "unlabeled"',
    );
    // The route passes campaignId; the fixtures above pass null. Either way the
    // key must be present so CPM attribution is answerable.
    assert(
      ledgered.every((e) => 'campaign_id' in e),
      'every ledger row carries a campaign_id key',
    );
    await generateSearchQueries({ ...base, campaignId: 'camp-123' });
    assert(
      ledgered[ledgered.length - 1].campaign_id === 'camp-123',
      'a supplied campaignId reaches the ledger row',
    );
  }

  console.log(`search-queries test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
