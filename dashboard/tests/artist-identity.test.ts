// tests/artist-identity.test.ts
//
// The new-campaign artist step: a campaign is created for a confirmed artist
// (picked card or resolved Spotify link), never a typed guess. Hermetic:
// globalThis.fetch is stubbed and refuses every URL it was not told about, so
// no test here can reach real Spotify or Soundcharts.
//
//   1. Spotify link parsing: every accepted form, every refused one.
//   2. Name mismatch: what is and isn't material.
//   3. src/lib/spotify.ts against a mocked Spotify Web API.
//   4. Candidate lookup: relevance filter, same-name artists stay apart,
//      Soundcharts degrades to nulls, the enrichment cache.
//   5. Link resolve + create-time verification (refused without confirmation,
//      on mismatch, on not-found, and fail-closed on outage).
//   6. Storage and the no-migration path: legacy rows, the columns used exist.
//   7. Wiring: the create route verifies before inserting; the form requires it.
//
// Run: npx tsx tests/artist-identity.test.ts

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

const ROOT = join(__dirname, '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// Fake credentials so the Spotify module believes it is configured; the
// stubbed fetch below answers the token call. Set before any import.
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
process.env.SPOTIFY_CLIENT_SECRET = 'test-client-secret';

const ADA = 'SampleArtistId00000001';
const ADA_TWIN = '0aaaaaaaaaaaaaaaaaaaaa';
const SAMPLEY = 'SampleArtistId00000002';
const UNRELATED = 'SampleArtistId00000003';
const MISSING = '0zzzzzzzzzzzzzzzzzzzzz';

type Route = (url: URL) => { status: number; body: unknown } | null;
let routes: Route[] = [];
const calls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  calls.push(url.href);
  for (const r of routes) {
    const hit = r(url);
    if (hit) {
      return new Response(JSON.stringify(hit.body), {
        status: hit.status,
        headers: { 'content-type': 'application/json' },
      });
    }
  }
  throw new Error(`unmocked fetch: ${url.href}`);
}) as typeof fetch;

const spotifyToken: Route = (u) =>
  u.hostname === 'accounts.spotify.com' && u.pathname === '/api/token'
    ? { status: 200, body: { access_token: 'tok', expires_in: 3600 } }
    : null;

const artistJson = (id: string, name: string, images = true) => ({
  id,
  name,
  external_urls: { spotify: `https://open.spotify.com/artist/${id}` },
  images: images
    ? [
        { url: `https://i.scdn.co/${id}-640`, width: 640, height: 640 },
        { url: `https://i.scdn.co/${id}-160`, width: 160, height: 160 },
        { url: `https://i.scdn.co/${id}-32`, width: 32, height: 32 },
      ]
    : [],
});

async function main() {
  const identity = await import('../src/lib/artist-identity');
  const spotify = await import('../src/lib/spotify');
  const lookup = await import('../src/lib/artist-lookup');
  const { parseSpotifyArtistRef, artistNameMismatch, readArtistIdentity, formatListeners } = identity;

  // ── 1. Link parsing ───────────────────────────────────────────────────────
  {
    const ok: Array<[string, string]> = [
      [`https://open.spotify.com/artist/${ADA}`, 'plain https link'],
      [`https://open.spotify.com/artist/${ADA}?si=Ab12Cd34Ef56`, 'share link with ?si='],
      [`https://open.spotify.com/artist/${ADA}?si=x&nd=1&dlsi=y`, 'several query params'],
      [`https://open.spotify.com/intl-de/artist/${ADA}`, 'intl-de prefix'],
      [`https://open.spotify.com/intl-pt-BR/artist/${ADA}?si=z`, 'intl-pt-BR prefix'],
      [`open.spotify.com/artist/${ADA}`, 'no scheme'],
      [`http://open.spotify.com/artist/${ADA}/`, 'http + trailing slash'],
      [`https://OPEN.SPOTIFY.COM/artist/${ADA}`, 'uppercase host'],
      [`https://play.spotify.com/artist/${ADA}`, 'legacy play host'],
      [`https://open.spotify.com/artist/${ADA}#top`, 'fragment'],
      [`spotify:artist:${ADA}`, 'spotify: URI'],
      [`  spotify:artist:${ADA}  `, 'URI with whitespace'],
      [ADA, 'bare id'],
    ];
    for (const [input, label] of ok) {
      assert(parseSpotifyArtistRef(input) === ADA, `parse: ${label} → id (got ${parseSpotifyArtistRef(input)})`);
    }
    const bad: Array<[string, string]> = [
      ['', 'empty'],
      ['Ada Sample', 'a name'],
      [`https://open.spotify.com/track/${ADA}`, 'track link'],
      [`https://open.spotify.com/album/${ADA}`, 'album link'],
      [`https://open.spotify.com/playlist/${ADA}`, 'playlist link'],
      [`spotify:track:${ADA}`, 'track URI'],
      [`https://evil.example.com/artist/${ADA}`, 'other host'],
      [`https://open.spotify.com.evil.com/artist/${ADA}`, 'lookalike host'],
      [`https://open.spotify.com/artist/${ADA}/albums`, 'extra path segment'],
      ['https://open.spotify.com/artist/short', 'short id'],
      [`https://open.spotify.com/artist/${ADA}x`, '23-char id'],
      ['https://open.spotify.com/artist/', 'no id'],
      ['spotify:artist:not-an-id', 'malformed URI'],
    ];
    for (const [input, label] of bad) {
      assert(parseSpotifyArtistRef(input) === null, `parse: ${label} → null (got ${parseSpotifyArtistRef(input)})`);
    }
  }

  // ── 2. Name mismatch ──────────────────────────────────────────────────────
  {
    assert(artistNameMismatch('Ada Sample', 'Ada Sampley'), 'mismatch: one letter is two artists');
    assert(artistNameMismatch('Ada Sample', 'Adele Sampley'), 'mismatch: different first name');
    assert(!artistNameMismatch('ada sample', 'Ada Sample'), 'mismatch: case is not material');
    assert(!artistNameMismatch('  Ada  Sample ', 'Ada Sample'), 'mismatch: whitespace is not material');
    assert(!artistNameMismatch('Beyonce', 'Beyoncé'), 'mismatch: accents are not material');
    assert(!artistNameMismatch('Lumineers', 'The Lumineers'), 'mismatch: a leading "The" is not material');
    assert(!artistNameMismatch('Simon and Garfunkel', 'Simon & Garfunkel'), 'mismatch: & equals and');
    assert(!artistNameMismatch('AC/DC', 'AC DC'), 'mismatch: punctuation is not material');
    assert(!artistNameMismatch('', 'Ada Sampley'), 'mismatch: empty typed name never mismatches');
  }

  // ── 3. Spotify client against a mocked Web API ────────────────────────────
  {
    routes = [
      spotifyToken,
      (u) =>
        u.hostname === 'api.spotify.com' && u.pathname === `/v1/artists/${ADA}`
          ? { status: 200, body: artistJson(ADA, 'Ada Sample') }
          : null,
      (u) =>
        u.hostname === 'api.spotify.com' && u.pathname === `/v1/artists/${MISSING}`
          ? { status: 404, body: { error: { status: 404 } } }
          : null,
      (u) =>
        u.hostname === 'api.spotify.com' && u.pathname === `/v1/artists/${SAMPLEY}`
          ? { status: 502, body: { error: { status: 502 } } }
          : null,
      (u) =>
        u.hostname === 'api.spotify.com' && u.pathname === `/v1/artists/${ADA}/albums`
          ? {
              status: 200,
              body: {
                items: [
                  { name: 'SAMPLE LP', album_type: 'album', release_date: '2024-07-19' },
                  { name: 'Ada Sample', album_type: 'album', release_date: '2014-07-25' },
                  { name: 'Christmas to Me', album_type: 'single', release_date: '2025-11-21' },
                ],
              },
            }
          : null,
      (u) =>
        u.hostname === 'api.spotify.com' && u.pathname === '/v1/search'
          ? {
              status: 200,
              body: { artists: { items: [artistJson(ADA, 'Ada Sample'), artistJson(SAMPLEY, 'Ada Sampley', false)] } },
            }
          : null,
    ];
    calls.length = 0;

    assert(spotify.spotifyConfigured(), 'spotify: configured from env');
    const a = await spotify.getSpotifyArtist(ADA);
    assert(a.ok && a.data.name === 'Ada Sample' && a.data.spotify_id === ADA, 'spotify: artist resolves');
    assert(a.ok && a.data.image_url === `https://i.scdn.co/${ADA}-160`, 'spotify: smallest image >= 64px is picked (not the 640, not the 32)');
    assert(a.ok && a.data.spotify_url === `https://open.spotify.com/artist/${ADA}`, 'spotify: canonical link');

    const missing = await spotify.getSpotifyArtist(MISSING);
    assert(!missing.ok && missing.error === 'not_found', 'spotify: 404 is not_found');
    const down = await spotify.getSpotifyArtist(SAMPLEY);
    assert(!down.ok && down.error === 'upstream', 'spotify: 5xx is upstream, not not_found');

    const rel = await spotify.getSpotifyLatestRelease(ADA);
    assert(rel?.name === 'Christmas to Me' && rel.type === 'single', 'spotify: latest release is the newest, not the first album in API order');

    const s = await spotify.searchSpotifyArtistProfiles('Ada Sample');
    assert(s.ok && s.data.length === 2 && s.data[1].image_url === null, 'spotify: search parses; no images → null image');

    const tokenCalls = calls.filter((c) => c.includes('accounts.spotify.com')).length;
    assert(tokenCalls === 1, `spotify: token is cached across calls (got ${tokenCalls} token requests)`);
    assert(calls.every((c) => !c.includes('top-tracks')), 'spotify: never calls top-tracks (403 for this app)');
  }

  // ── 4. Candidate lookup ───────────────────────────────────────────────────
  type P = import('../src/lib/artist-lookup').ArtistProviders;
  const counts = { search: 0, bridge: 0, listeners: 0, release: 0, get: 0 };
  const profile = (id: string, name: string) => ({
    spotify_id: id,
    name,
    spotify_url: `https://open.spotify.com/artist/${id}`,
    image_url: `https://i.scdn.co/${id}`,
  });
  const fake = (over: Partial<P> = {}): P => ({
    spotifyConfigured: () => true,
    searchSpotify: async () => {
      counts.search++;
      return {
        ok: true,
        data: [
          profile(ADA, 'Ada Sample'),
          profile(ADA_TWIN, 'Ada Sample'),
          profile(SAMPLEY, 'Ada Sampley'),
          profile(UNRELATED, 'The Unrelated Band'),
          profile(ADA, 'Ada Sample'),
        ],
      };
    },
    getSpotifyArtist: async (id) => {
      counts.get++;
      if (id === ADA) return { ok: true, data: profile(ADA, 'Ada Sample') };
      if (id === SAMPLEY) return { ok: true, data: profile(SAMPLEY, 'Ada Sampley') };
      return { ok: false, error: 'not_found' };
    },
    getLatestRelease: async (id) => {
      counts.release++;
      return id === ADA ? { name: 'SAMPLE LP', type: 'album', release_date: '2024-07-19', spotify_url: null } : null;
    },
    soundchartsConfigured: () => true,
    soundchartsBySpotifyId: async (id) => {
      counts.bridge++;
      if (id === ADA) return { uuid: 'sc-ada', genres: ['country'], country_code: 'US', image_url: null };
      if (id === ADA_TWIN) return { uuid: 'sc-twin', genres: ['folk'], country_code: 'GB', image_url: null };
      return null;
    },
    monthlyListeners: async (uuid) => {
      counts.listeners++;
      return uuid === 'sc-ada' ? { value: 4321, date: '2026-09-30' } : uuid === 'sc-twin' ? { value: 12, date: '2026-09-29' } : null;
    },
    ...over,
  });

  {
    lookup.__resetArtistLookupCache();
    const cards = await lookup.lookupArtistCandidates('Ada Sample', fake());
    const ids = cards.map((c) => c.spotify_id);
    assert(!ids.includes(UNRELATED), 'lookup: unrelated Spotify padding is dropped');
    assert(new Set(ids).size === ids.length, 'lookup: duplicate Spotify ids collapse');
    assert(cards.length === 3, `lookup: three plausible artists (got ${cards.length})`);
    const [a, twin] = [cards.find((c) => c.spotify_id === ADA)!, cards.find((c) => c.spotify_id === ADA_TWIN)!];
    assert(a.name === twin.name, 'lookup: the two same-name artists are both offered');
    assert(
      a.monthly_listeners === 4321 && twin.monthly_listeners === 12 && a.country_code !== twin.country_code && a.genres[0] !== twin.genres[0],
      'lookup: same-name artists differ on listeners, country and genre'
    );
    assert(a.spotify_url !== twin.spotify_url, 'lookup: each card links to its own Spotify page');
    assert(a.latest_release?.name === 'SAMPLE LP', 'lookup: latest release on the card');
    assert(a.soundcharts_uuid === 'sc-ada', 'lookup: Soundcharts UUID bridged from the Spotify id');
    const sampley = cards.find((c) => c.spotify_id === SAMPLEY)!;
    assert(sampley.soundcharts_uuid === null && sampley.monthly_listeners === null, 'lookup: not in Soundcharts → nulls, card still offered');

    const before = { ...counts };
    await lookup.lookupArtistCandidates('Ada Sampl', fake());
    assert(counts.bridge === before.bridge && counts.listeners === before.listeners, 'lookup: enrichment cached across keystrokes for found artists');

    assert((await lookup.lookupArtistCandidates('A', fake())).length === 0, 'lookup: one-letter query → []');
    assert((await lookup.lookupArtistCandidates('Ada', fake({ spotifyConfigured: () => false }))).length === 0, 'lookup: no Spotify credentials → []');
    assert(
      (await lookup.lookupArtistCandidates('Ada', fake({ searchSpotify: async () => ({ ok: false, error: 'upstream' }) }))).length === 0,
      'lookup: Spotify outage → []'
    );

    lookup.__resetArtistLookupCache();
    const scOff = await lookup.lookupArtistCandidates('Ada Sample', fake({ soundchartsConfigured: () => false }));
    assert(scOff.length === 3 && scOff.every((c) => c.soundcharts_uuid === null && c.monthly_listeners === null), 'lookup: no Soundcharts → cards without listeners');

    lookup.__resetArtistLookupCache();
    const scThrows = await lookup.lookupArtistCandidates(
      'Ada Sample',
      fake({ soundchartsBySpotifyId: async () => { throw new Error('boom'); } })
    );
    assert(scThrows.length === 3, 'lookup: a throwing Soundcharts bridge degrades, never fails the lookup');

    assert(lookup.plausibleMatch('Morgn Wallen', 'Morgan Wallen'), 'relevance: one right word keeps a misspelt query');
    assert(!lookup.plausibleMatch('Ada Sample', 'The Unrelated Band'), 'relevance: no shared word prefix drops it');
  }

  // ── 5. Resolve + create-time verification ────────────────────────────────
  {
    lookup.__resetArtistLookupCache();
    const r = await lookup.resolveArtistById(ADA, fake());
    assert(r.ok && r.artist.name === 'Ada Sample' && r.artist.monthly_listeners === 4321, 'resolve: id → the same card the search shows');
    const nf = await lookup.resolveArtistById(MISSING, fake());
    assert(!nf.ok && nf.error === 'artist_not_found', 'resolve: unknown id → artist_not_found');
    const bad = await lookup.resolveArtistById('nope', fake());
    assert(!bad.ok && bad.error === 'invalid_link', 'resolve: malformed id → invalid_link, no provider call');
    const off = await lookup.resolveArtistById(ADA, fake({ spotifyConfigured: () => false }));
    assert(!off.ok && off.error === 'artist_lookup_unavailable', 'resolve: no Spotify → unavailable');
    const down = await lookup.resolveArtistById(ADA, fake({ getSpotifyArtist: async () => ({ ok: false, error: 'upstream' }) }));
    assert(!down.ok && down.error === 'artist_lookup_unavailable', 'resolve: outage → unavailable, not "not found"');

    // The mismatch the form warns about: typed one name, pasted another's link.
    assert(r.ok && !artistNameMismatch('Ada Sample', r.artist.name), 'resolve: matching link → no warning');
    const other = await lookup.resolveArtistById(SAMPLEY, fake());
    assert(other.ok && artistNameMismatch('Ada Sample', other.artist.name), 'resolve: link for Ada Sampley while "Ada Sample" typed → warning');

    const v = lookup.verifyCampaignArtist;
    const none = await v({ artist_name: 'Ada Sample' }, fake());
    assert(!none.ok && none.error === 'artist_unconfirmed' && none.status === 422, 'create: refused without a confirmed artist');
    const nul = await v({ artist_name: 'Ada Sample', artist_spotify_id: null }, fake());
    assert(!nul.ok && nul.error === 'artist_unconfirmed', 'create: refused with a null artist id');
    const junk = await v({ artist_name: 'Ada Sample', artist_spotify_id: 'Ada Sample' }, fake());
    assert(!junk.ok && junk.error === 'artist_unconfirmed', 'create: refused with a non-id string');
    const gone = await v({ artist_name: 'X', artist_spotify_id: MISSING }, fake());
    assert(!gone.ok && gone.error === 'artist_not_found' && gone.status === 422, 'create: refused for an id Spotify does not know');
    const outage = await v({ artist_name: 'Ada Sample', artist_spotify_id: ADA }, fake({ getSpotifyArtist: async () => ({ ok: false, error: 'upstream' }) }));
    assert(!outage.ok && outage.error === 'artist_lookup_unavailable' && outage.status === 503, 'create: fails closed on a Spotify outage');
    const drift = await v({ artist_name: 'Ada Sample', artist_spotify_id: SAMPLEY }, fake());
    assert(!drift.ok && drift.error === 'artist_name_mismatch', 'create: refused when the name drifted from the confirmed artist');
    for (const res of [none, gone, outage, drift]) {
      assert(!res.ok && !/—/.test(res.message) && res.message.length > 0, `create: ${!res.ok && res.error} copy is a sentence with no em dash`);
    }

    lookup.__resetArtistLookupCache();
    const now = new Date('2026-10-01T12:00:00Z');
    const good = await v({ artist_name: 'ada sample', artist_spotify_id: ADA }, fake(), now);
    assert(good.ok, 'create: accepted for a confirmed artist');
    if (good.ok) {
      const c = good.columns;
      assert(c.artist_spotify_id === ADA, 'create: stores artist_spotify_id');
      assert(c.artist_soundcharts_uuid === 'sc-ada', 'create: stores the bridged Soundcharts UUID');
      assert(c.artist_confirmed_source === 'spotify', 'create: confirmed source is spotify');
      const snap = c.artist_data.spotify;
      assert(snap.name === 'Ada Sample' && snap.image_url === `https://i.scdn.co/${ADA}` && snap.confirmed_at === now.toISOString(), 'create: server-side snapshot for the header');
      assert(!('genre' in c.artist_data), 'create: never writes artist_data.genre (discovery targeting is not set here)');
    }
    const noBridge = await v({ artist_name: 'Ada Sampley', artist_spotify_id: SAMPLEY }, fake());
    assert(noBridge.ok && noBridge.columns.artist_soundcharts_uuid === null, 'create: no Soundcharts match still creates, with a null UUID');
  }

  // ── 6. Storage, legacy rows, and why there is no migration 063 ───────────
  {
    assert(readArtistIdentity({ artist_spotify_id: null, artist_name: 'Old', artist_data: {} }) === null, 'header: legacy campaign (no id) renders nothing');
    assert(readArtistIdentity({ artist_name: 'Old', artist_data: { note: 'x' } }) === null, 'header: legacy row without the column key renders nothing');
    const bare = readArtistIdentity({ artist_spotify_id: ADA, artist_name: 'Ada Sample', artist_data: {} });
    assert(bare?.name === 'Ada Sample' && bare.image_url === null && bare.spotify_url.endsWith(ADA), 'header: id without snapshot still links');
    const stale = readArtistIdentity({ artist_spotify_id: ADA, artist_name: 'Ada Sample', artist_data: { spotify: { spotify_id: SAMPLEY, name: 'Ada Sampley', image_url: 'x' } } });
    assert(stale?.name === 'Ada Sample' && stale.image_url === null, 'header: a snapshot for another id is ignored');
    const full = readArtistIdentity({ artist_spotify_id: ADA, artist_name: 'Ada Sample', artist_data: { spotify: { spotify_id: ADA, name: 'Ada Sample', image_url: 'https://i.scdn.co/a' } } });
    assert(full?.image_url === 'https://i.scdn.co/a', 'header: snapshot image shown');
    assert(readArtistIdentity({ artist_spotify_id: 'garbage', artist_data: {} }) === null, 'header: a malformed id renders nothing');

    // Every column the create path writes already exists, so the feature needs
    // no migration and there is no pre/post-063 split to degrade across.
    const schema = src('supabase/migrations/003_base_schema.sql');
    assert(/artist_spotify_id\s+text/.test(schema) && /artist_data\s+jsonb/.test(schema), 'schema: artist_spotify_id + artist_data are base columns');
    const m036 = src('supabase/migrations/036_attribution.sql');
    assert(/artist_soundcharts_uuid text/.test(m036) && /artist_confirmed_source text/.test(m036), 'schema: 036 has the Soundcharts UUID + source columns');
    const migs = readdirSync(join(ROOT, 'supabase/migrations'));
    assert(!migs.some((f) => f.startsWith('063_campaign_artist_identity')), 'schema: no migration needed, none written');

    assert(formatListeners(4321) === '4,321 monthly listeners', 'format: thousands separator');
    assert(formatListeners(1) === '1 monthly listener', 'format: singular');
    assert(formatListeners(1_250_000) === '1.3M monthly listeners' || formatListeners(1_250_000) === '1.2M monthly listeners', 'format: millions abbreviated');
  }

  // ── 7. Wiring ─────────────────────────────────────────────────────────────
  {
    const create = src('src/app/api/campaigns/route.ts');
    const verifyAt = create.indexOf('await verifyCampaignArtist(body)');
    const insertAt = create.indexOf('.insert(');
    assert(verifyAt > 0 && verifyAt < insertAt, 'create route: verifies the artist before inserting');
    assert(/if \(!artist\.ok\)\s*\{\s*return NextResponse\.json\(/.test(create), 'create route: an unverified artist returns before the insert');
    assert(/artist_spotify_id: artist\.columns\.artist_spotify_id/.test(create), 'create route: writes the verified id, not the body id');
    assert(!/body\.artist_soundcharts_uuid/.test(create), 'create route: Soundcharts UUID is bridged server-side, not taken from the client');

    const page = src('src/app/campaigns/new/page.tsx');
    assert(/disabled=\{submitting \|\| !artist \|\|/.test(page), 'form: Create is disabled until an artist is confirmed');
    assert(/artist_spotify_id: artist\.spotify_id/.test(page), 'form: sends the confirmed Spotify id');
    assert(!/optional — improves/.test(page), 'form: the "(optional — improves …)" helper is gone');

    const step = src('src/components/ArtistStep.tsx');
    const copy = step.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(!/—/.test(copy), 'artist step: no em dashes in rendered copy');
    assert(/Spotify artist link/.test(step) && /Open in Spotify/.test(step), 'artist step: link field + Open in Spotify');
    assert(/artistNameMismatch\(artistName, resolved\.name\)/.test(step) && /role="alert"/.test(step), 'artist step: resolved link with a different name shows an alert');
    assert(/mismatch \? `Use \$\{resolved\.name\}` : "Use this artist"/.test(step), 'artist step: confirming a mismatch names the other artist explicitly');

    const resolveRoute = src('src/app/api/artists/resolve/route.ts');
    assert(/requireSessionAndClient/.test(resolveRoute) && /tieredLimit/.test(resolveRoute), 'resolve route: session-gated + rate-limited');
    assert(existsSync(join(ROOT, 'src/app/api/artists/search/route.ts')), 'search route present');
    for (const f of ['src/components/ArtistStep.tsx', 'src/lib/artist-identity.ts']) {
      assert(!/from ["']@?\/?.*\/(spotify|soundcharts|artist-lookup)["']/.test(src(f)), `${f}: client bundle imports no credentialed module`);
    }
  }

  globalThis.fetch = realFetch;
  console.log(`\nartist-identity: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
