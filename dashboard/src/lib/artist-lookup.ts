// src/lib/artist-lookup.ts
//
// Server-only: turns a typed name or a pasted Spotify link into ArtistCandidate
// cards, and verifies the identity a campaign is created with.
//
// Sources (all server-side; the browser never sees a credential):
//   Spotify (client credentials)   id, name, image, link, latest release
//   Soundcharts by-platform        UUID for attribution, genres, country
//   Soundcharts /listening         monthly listeners
//
// Spotify is the identity authority: an artist is "confirmed" when the user
// picks a card or a link that resolves to one Spotify id. Soundcharts only
// enriches, and every Soundcharts failure degrades to nulls on the card.
//
// Providers are injected so tests run hermetic with no network at all.

import {
  getSpotifyArtist,
  getSpotifyLatestRelease,
  searchSpotifyArtistProfiles,
  spotifyConfigured,
  type SpotifyArtistProfile,
  type SpotifyLookup,
  type SpotifyRelease,
} from "./spotify";
import {
  getArtistBySpotifyId,
  getSpotifyListeners,
  latestSeriesValue,
  scDay,
  soundchartsConfigured,
} from "./soundcharts";
import {
  SPOTIFY_ID_RE,
  artistNameMismatch,
  normalizeArtistName,
  type ArtistCandidate,
  type ArtistIdentitySnapshot,
} from "./artist-identity";

export interface SoundchartsBridge {
  uuid: string;
  genres: string[];
  country_code: string | null;
  image_url: string | null;
}

export interface ArtistProviders {
  spotifyConfigured(): boolean;
  searchSpotify(query: string, limit: number): Promise<SpotifyLookup<SpotifyArtistProfile[]>>;
  getSpotifyArtist(id: string): Promise<SpotifyLookup<SpotifyArtistProfile>>;
  getLatestRelease(id: string): Promise<SpotifyRelease | null>;
  soundchartsConfigured(): boolean;
  soundchartsBySpotifyId(id: string): Promise<SoundchartsBridge | null>;
  monthlyListeners(uuid: string): Promise<{ value: number; date: string } | null>;
}

/** How far back to look for the newest listener point (series has gaps). */
const LISTENER_LOOKBACK_DAYS = 14;

export const liveProviders: ArtistProviders = {
  spotifyConfigured,
  searchSpotify: searchSpotifyArtistProfiles,
  getSpotifyArtist,
  getLatestRelease: getSpotifyLatestRelease,
  soundchartsConfigured,
  async soundchartsBySpotifyId(id) {
    const r = await getArtistBySpotifyId(id);
    const o = r.ok ? r.data?.object : undefined;
    if (!o?.uuid) return null;
    const genres: string[] = [];
    for (const g of o.genres ?? []) {
      for (const s of g?.sub?.length ? g.sub : g?.root ? [g.root] : []) {
        if (typeof s === "string" && s && !genres.includes(s)) genres.push(s);
      }
    }
    return {
      uuid: o.uuid,
      genres,
      country_code: o.countryCode || null,
      image_url: o.imageUrl || null,
    };
  },
  async monthlyListeners(uuid) {
    const now = Date.now();
    const r = await getSpotifyListeners(
      uuid,
      scDay(now - LISTENER_LOOKBACK_DAYS * 86_400_000),
      scDay(now)
    );
    return r.ok ? latestSeriesValue(r.data?.items) : null;
  },
};

// ── Enrichment cache ────────────────────────────────────────────────────────
// Typing "Ada Sam" → "Ada Samp" → "Ada Sample" returns mostly the same
// artists; the cache keeps that from re-spending Soundcharts calls per
// keystroke. Per server instance, bounded, short-lived.
const ENRICH_TTL_MS = 6 * 60 * 60 * 1000;
// A missing Soundcharts bridge may be a transient failure, and the UUID is
// what attribution runs on, so a miss is retried soon instead of pinned.
const ENRICH_MISS_TTL_MS = 5 * 60 * 1000;
const ENRICH_MAX = 500;
type Enrichment = Omit<ArtistCandidate, "spotify_id" | "name" | "spotify_url" | "image_url">;
const enrichCache = new Map<string, { at: number; ttl: number; value: Enrichment }>();

export function __resetArtistLookupCache(): void {
  enrichCache.clear();
}

async function enrich(id: string, p: ArtistProviders): Promise<Enrichment> {
  const hit = enrichCache.get(id);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;

  const [release, bridge] = await Promise.all([
    p.getLatestRelease(id).catch(() => null),
    p.soundchartsConfigured() ? p.soundchartsBySpotifyId(id).catch(() => null) : Promise.resolve(null),
  ]);
  const listeners = bridge ? await p.monthlyListeners(bridge.uuid).catch(() => null) : null;

  const value: Enrichment = {
    monthly_listeners: listeners?.value ?? null,
    listeners_date: listeners?.date ?? null,
    genres: (bridge?.genres ?? []).slice(0, 3),
    country_code: bridge?.country_code ?? null,
    latest_release: release
      ? { name: release.name, type: release.type, release_date: release.release_date }
      : null,
    soundcharts_uuid: bridge?.uuid ?? null,
  };
  if (enrichCache.size >= ENRICH_MAX) {
    const oldest = enrichCache.keys().next().value;
    if (oldest !== undefined) enrichCache.delete(oldest);
  }
  const ttl = bridge || !p.soundchartsConfigured() ? ENRICH_TTL_MS : ENRICH_MISS_TTL_MS;
  enrichCache.set(id, { at: Date.now(), ttl, value });
  return value;
}

async function toCandidate(profile: SpotifyArtistProfile, p: ArtistProviders): Promise<ArtistCandidate> {
  // Spotify's image only. Soundcharts' imageUrl 307s to a blank default.png
  // for artists without a photo (checked live 2026-10-01), which renders as an
  // empty square; the card's initial-letter fallback says more.
  return {
    spotify_id: profile.spotify_id,
    name: profile.name,
    spotify_url: profile.spotify_url,
    image_url: profile.image_url,
    ...(await enrich(profile.spotify_id, p)),
  };
}

/**
 * Spotify sometimes pads a search with unrelated artists (a search for one
 * artist can return an unrelated duo). Keep a result only when one
 * of the query's words starts one of its name's words, or the reverse.
 */
export function plausibleMatch(query: string, name: string): boolean {
  const q = normalizeArtistName(query).split(" ").filter((t) => t.length >= 2);
  const n = normalizeArtistName(name).split(" ").filter(Boolean);
  if (q.length === 0) return false;
  return q.some((qt) => n.some((nt) => nt.startsWith(qt) || qt.startsWith(nt)));
}

export const MAX_CANDIDATES = 4;

/** Candidate cards for a typed name. [] on short query, no Spotify, or outage. */
export async function lookupArtistCandidates(
  query: string,
  p: ArtistProviders = liveProviders
): Promise<ArtistCandidate[]> {
  const q = query.trim().slice(0, 200);
  if (q.length < 2 || !p.spotifyConfigured()) return [];
  const res = await p.searchSpotify(q, 8);
  if (!res.ok) return [];
  const seen = new Set<string>();
  const picked = res.data.filter((a) => {
    if (seen.has(a.spotify_id) || !plausibleMatch(q, a.name)) return false;
    seen.add(a.spotify_id);
    return true;
  });
  return Promise.all(picked.slice(0, MAX_CANDIDATES).map((a) => toCandidate(a, p)));
}

export type ResolveResult =
  | { ok: true; artist: ArtistCandidate }
  | { ok: false; error: "invalid_link" | "artist_not_found" | "artist_lookup_unavailable" };

/** One card for one Spotify id. Deterministic: no search, no ranking. */
export async function resolveArtistById(
  spotifyId: string,
  p: ArtistProviders = liveProviders
): Promise<ResolveResult> {
  if (!SPOTIFY_ID_RE.test(spotifyId)) return { ok: false, error: "invalid_link" };
  if (!p.spotifyConfigured()) return { ok: false, error: "artist_lookup_unavailable" };
  const r = await p.getSpotifyArtist(spotifyId);
  if (!r.ok) {
    return { ok: false, error: r.error === "not_found" ? "artist_not_found" : "artist_lookup_unavailable" };
  }
  return { ok: true, artist: await toCandidate(r.data, p) };
}

// ── Campaign creation ───────────────────────────────────────────────────────

export const CREATE_ARTIST_ERRORS = {
  artist_unconfirmed: {
    status: 422,
    message: "Pick the artist from the list or paste their Spotify link.",
  },
  artist_not_found: {
    status: 422,
    message: "That Spotify artist no longer exists. Pick the artist again.",
  },
  artist_name_mismatch: {
    status: 422,
    message: "The artist name doesn't match the confirmed Spotify artist. Pick the artist again.",
  },
  artist_lookup_unavailable: {
    status: 503,
    message: "We can't reach Spotify to confirm the artist right now. Try again in a minute.",
  },
} as const;
export type CreateArtistError = keyof typeof CREATE_ARTIST_ERRORS;

export type CreateArtistResult =
  | {
      ok: true;
      columns: {
        artist_spotify_id: string;
        artist_soundcharts_uuid: string | null;
        artist_confirmed_source: "spotify";
        artist_data: { spotify: ArtistIdentitySnapshot };
      };
    }
  | { ok: false; error: CreateArtistError; status: number; message: string };

function refuse(error: CreateArtistError): CreateArtistResult {
  return { ok: false, error, ...CREATE_ARTIST_ERRORS[error] };
}

/**
 * Verify the identity a campaign is being created with. The client's card is
 * not trusted: the id is re-resolved against Spotify here, and the stored
 * snapshot is the server's. Fails closed. A campaign is never created for an
 * artist nobody confirmed, including during a Spotify outage.
 */
export async function verifyCampaignArtist(
  body: { artist_name: string; artist_spotify_id?: string | null },
  p: ArtistProviders = liveProviders,
  now: Date = new Date()
): Promise<CreateArtistResult> {
  const id = body.artist_spotify_id ?? "";
  if (!SPOTIFY_ID_RE.test(id)) return refuse("artist_unconfirmed");

  const r = await resolveArtistById(id, p);
  if (!r.ok) {
    return refuse(r.error === "invalid_link" ? "artist_unconfirmed" : r.error);
  }
  // The form always writes the confirmed artist's name into the name field,
  // so a difference here means the two drifted apart after confirmation.
  if (artistNameMismatch(body.artist_name, r.artist.name)) return refuse("artist_name_mismatch");

  return {
    ok: true,
    columns: {
      artist_spotify_id: r.artist.spotify_id,
      artist_soundcharts_uuid: r.artist.soundcharts_uuid,
      artist_confirmed_source: "spotify",
      artist_data: { spotify: { ...r.artist, confirmed_at: now.toISOString() } },
    },
  };
}
