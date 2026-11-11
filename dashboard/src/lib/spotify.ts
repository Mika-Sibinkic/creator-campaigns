/**
 * Creator Campaigns Spotify Integration v1.2
 *
 * Uses Spotify Web API (client credentials flow) to:
 * 1. Confirm an artist exists on Spotify
 * 2. Search for similar artists by name patterns
 *
 * LIMITATION: Spotify "Development Mode" strips genres, popularity, and followers
 * from API responses. To get full data, submit the app for "Extended Access Mode"
 * at https://developer.spotify.com/dashboard → App → Settings → Request Extension.
 * Until then, this provides basic artist confirmation and name-based search.
 *
 * Requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in env.
 * Gracefully returns null if credentials are not configured.
 */

import { createLogger } from "./logger";

const log = createLogger("spotify");

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "";

let cachedToken: { token: string; expires: number } | null = null;

export interface SpotifyArtistInfo {
  name: string;
  spotify_id: string;
  spotify_url: string;
  genres: string[];
  popularity: number;
  followers: number;
}

async function getAccessToken(): Promise<string | null> {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return null;

  if (cachedToken && Date.now() < cachedToken.expires) {
    return cachedToken.token;
  }

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    log.error("token request failed", { status: res.status });
    return null;
  }

  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in - 60) * 1000,
  };
  return cachedToken.token;
}

async function spotifyGet(path: string, token: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    log.error("GET failed", { path, status: res.status });
    return null;
  }
  return res.json();
}

function parseArtist(a: Record<string, unknown>): SpotifyArtistInfo {
  const externalUrls = (a.external_urls as Record<string, string>) || {};
  return {
    name: a.name as string,
    spotify_id: a.id as string,
    spotify_url: externalUrls.spotify || `https://open.spotify.com/artist/${a.id}`,
    genres: (a.genres || []) as string[],
    popularity: (a.popularity || 0) as number,
    followers: ((a.followers as Record<string, unknown>)?.total || 0) as number,
  };
}

async function searchArtists(
  query: string,
  token: string,
  limit = 20
): Promise<SpotifyArtistInfo[]> {
  const q = encodeURIComponent(query);
  const data = await spotifyGet(`/search?q=${q}&type=artist&limit=${limit}`, token);
  if (!data) return [];

  const items = (data.artists as Record<string, unknown>)?.items as Array<Record<string, unknown>>;
  if (!items) return [];

  return items.map(parseArtist);
}

// ── Artist identity (new-campaign artist step) ─────────────────────────────
//
// What the Development-Mode app actually returns, probed live 2026-10-01:
//   GET /artists/{id}                 200 — id, name, images, external_urls.
//                                         NO genres / popularity / followers.
//   GET /search?type=artist           200 — same stripped shape.
//   GET /artists/{id}/albums          200 — name, album_type, release_date.
//   GET /artists/{id}/top-tracks      403 — not available to this app.
//   GET /artists?ids=                 403 — not available to this app.
// So the card's "recent work" line is the latest release, not a top track,
// and listeners/genres come from Soundcharts.

export function spotifyConfigured(): boolean {
  return !!SPOTIFY_CLIENT_ID && !!SPOTIFY_CLIENT_SECRET;
}

export type SpotifyLookup<T> =
  | { ok: true; data: T }
  | { ok: false; error: "not_configured" | "not_found" | "upstream"; status?: number };

export interface SpotifyArtistProfile {
  spotify_id: string;
  name: string;
  spotify_url: string;
  /** The smallest image at least 64px wide; the card renders it at 48px. */
  image_url: string | null;
}

export interface SpotifyRelease {
  name: string;
  /** "album" | "single" | "compilation" */
  type: string;
  /** "YYYY", "YYYY-MM" or "YYYY-MM-DD", as Spotify reports precision. */
  release_date: string | null;
  spotify_url: string | null;
}

async function spotifyRequest(
  path: string
): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; error: "not_configured" | "not_found" | "upstream"; status?: number }> {
  const token = await getAccessToken().catch(() => null);
  if (!token) {
    return { ok: false, error: spotifyConfigured() ? "upstream" : "not_configured" };
  }
  try {
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404 || res.status === 400) {
      // Spotify answers 400 "invalid id" for a well-formed but unknown id.
      return { ok: false, error: "not_found", status: res.status };
    }
    if (!res.ok) {
      log.error("GET failed", { path, status: res.status });
      return { ok: false, error: "upstream", status: res.status };
    }
    return { ok: true, json: (await res.json()) as Record<string, unknown> };
  } catch (e) {
    log.error("GET threw", { path, error: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "upstream" };
  }
}

function pickImage(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  const sized = images
    .filter((i): i is { url: string; width?: number | null } => !!i && typeof (i as { url?: unknown }).url === "string")
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  if (sized.length === 0) return null;
  return (sized.find((i) => (i.width ?? 0) >= 64) ?? sized[sized.length - 1]).url;
}

function toProfile(a: Record<string, unknown>): SpotifyArtistProfile | null {
  if (typeof a.id !== "string" || typeof a.name !== "string") return null;
  const externalUrls = (a.external_urls as Record<string, string> | undefined) ?? {};
  return {
    spotify_id: a.id,
    name: a.name,
    spotify_url: externalUrls.spotify || `https://open.spotify.com/artist/${a.id}`,
    image_url: pickImage(a.images),
  };
}

/** One artist by Spotify id. `not_found` is a definitive "no such artist". */
export async function getSpotifyArtist(id: string): Promise<SpotifyLookup<SpotifyArtistProfile>> {
  const r = await spotifyRequest(`/artists/${encodeURIComponent(id)}`);
  if (!r.ok) return r;
  const profile = toProfile(r.json);
  return profile ? { ok: true, data: profile } : { ok: false, error: "upstream" };
}

/** Artist search, in Spotify's relevance order. */
export async function searchSpotifyArtistProfiles(
  query: string,
  limit = 8
): Promise<SpotifyLookup<SpotifyArtistProfile[]>> {
  const r = await spotifyRequest(
    `/search?q=${encodeURIComponent(query)}&type=artist&limit=${limit}`
  );
  if (!r.ok) return r;
  const items = ((r.json.artists as Record<string, unknown> | undefined)?.items ?? []) as Array<Record<string, unknown>>;
  return {
    ok: true,
    data: items.map(toProfile).filter((p): p is SpotifyArtistProfile => p !== null),
  };
}

/**
 * The artist's most recent album or single, or null. Best-effort: any failure
 * is null, because the card is still identifiable from image + listeners.
 */
export async function getSpotifyLatestRelease(id: string): Promise<SpotifyRelease | null> {
  const r = await spotifyRequest(
    `/artists/${encodeURIComponent(id)}/albums?include_groups=album,single&limit=10`
  );
  if (!r.ok) return null;
  const items = (r.json.items ?? []) as Array<Record<string, unknown>>;
  const releases: SpotifyRelease[] = items
    .filter((x) => typeof x?.name === "string")
    .map((x) => ({
      name: x.name as string,
      type: typeof x.album_type === "string" ? x.album_type : "album",
      release_date: typeof x.release_date === "string" ? x.release_date : null,
      spotify_url: ((x.external_urls as Record<string, string> | undefined) ?? {}).spotify ?? null,
    }));
  // Spotify groups albums before singles, so the API order is not recency.
  releases.sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""));
  return releases[0] ?? null;
}

/**
 * Gets Spotify context for an artist and similar artists in the same space.
 * Uses multiple search strategies to find related artists.
 *
 * Returns formatted context string for GPT enrichment, or null if unavailable.
 */
export async function getRelatedArtistsContext(
  artistName: string,
  genre?: string
): Promise<string | null> {
  const token = await getAccessToken();
  if (!token) {
    log.info("no credentials configured, skipping enrichment");
    return null;
  }

  // Search for the target artist
  const artistResults = await searchArtists(artistName, token, 5);
  const artist = artistResults.find(
    (a) => a.name.toLowerCase() === artistName.toLowerCase()
  ) || artistResults[0];

  if (!artist) {
    log.info("artist not found", { artist: artistName });
    return null;
  }

  log.info("artist found", { artist: artist.name });

  // Search for similar artists using genre + artist name patterns
  const seen = new Set<string>();
  seen.add(artist.name.toLowerCase());
  const similar: SpotifyArtistInfo[] = [];

  // Strategy 1: Search by genre if provided
  const searchGenre = genre || (artist.genres.length > 0 ? artist.genres[0] : null);
  if (searchGenre) {
    const genreResults = await searchArtists(searchGenre, token, 20);
    for (const a of genreResults) {
      if (!seen.has(a.name.toLowerCase())) {
        seen.add(a.name.toLowerCase());
        similar.push(a);
      }
    }
  }

  // Strategy 2: Search by "similar to [artist]" and "[genre] artist".
  //
  // The genre query is CONDITIONAL. Spotify Development Mode strips
  // `artist.genres` and artist_data.genre is rarely set, so a literal fallback
  // query would run on nearly every campaign. Its results become
  // `similarNames`, which seed the TikTok query generator, so a single
  // hardcoded word would shape the entire candidate pool for every label
  // regardless of what they release.
  //
  // With no genre we now run the artist-similarity query alone rather than
  // inventing a vertical. A smaller genre-neutral pool beats a large pool of
  // the wrong genre.
  const supplementalQueries = [`${artistName} similar`];
  if (searchGenre) {
    supplementalQueries.push(`${searchGenre} singer songwriter`);
  }
  for (const q of supplementalQueries) {
    const results = await searchArtists(q, token, 10);
    for (const a of results) {
      if (!seen.has(a.name.toLowerCase())) {
        seen.add(a.name.toLowerCase());
        similar.push(a);
      }
    }
  }

  // Build context
  const lines: string[] = [];
  lines.push(`Spotify confirms "${artist.name}" exists (${artist.spotify_url})`);

  if (artist.genres.length > 0) {
    lines.push(`Genres: ${artist.genres.join(", ")}`);
  }

  if (similar.length > 0) {
    lines.push(`\nArtists in the same Spotify ecosystem (${similar.length} found):`);
    const top = similar.slice(0, 25);
    for (const s of top) {
      const genreStr = s.genres.length > 0 ? ` (${s.genres.slice(0, 2).join(", ")})` : "";
      lines.push(`- ${s.name}${genreStr}`);
    }
  }

  const context = lines.join("\n");
  log.info("context built", { similar_artists: similar.length });
  return context;
}
