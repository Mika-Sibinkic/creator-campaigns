// src/lib/artist-identity.ts
//
// The campaign's artist identity: which real artist a campaign is for, pinned
// to provider ids rather than a typed name. Client-safe (no server imports):
// the new-campaign form, the campaign header and the server all share these.
//
// Storage, all on existing columns (checked against the live catalog
// 2026-10-01, so no migration):
//   campaigns.artist_spotify_id        the confirmed Spotify artist id
//   campaigns.artist_soundcharts_uuid  bridged from the Spotify id (036)
//   campaigns.artist_confirmed_source  'spotify'
//   campaigns.artist_data.spotify      ArtistIdentitySnapshot, display only
//
// `artist_data.genre` is a different, legacy key that discovery reads. This
// module never writes it: a genre shown on a card is not a targeting choice.

/** A Spotify artist id is 22 base62 characters. */
export const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;

/**
 * Extract a Spotify artist id from whatever a user pastes:
 *   https://open.spotify.com/artist/<id>?si=...
 *   open.spotify.com/intl-de/artist/<id>
 *   https://play.spotify.com/artist/<id>
 *   spotify:artist:<id>
 *   <id>
 * Returns null for anything else, including track/album/playlist links, so a
 * pasted song link is refused rather than resolved to the wrong thing.
 */
export function parseSpotifyArtistRef(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;

  const uri = /^spotify:artist:([A-Za-z0-9]{22})$/i.exec(raw);
  if (uri) return uri[1];

  if (SPOTIFY_ID_RE.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "open.spotify.com" && host !== "play.spotify.com") return null;

  // Path segments, ignoring an `intl-xx` locale prefix and a trailing slash.
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] && /^intl-[a-z]{2}(-[a-z]{2})?$/i.test(parts[0])) parts.shift();
  if (parts.length !== 2 || parts[0].toLowerCase() !== "artist") return null;
  return SPOTIFY_ID_RE.test(parts[1]) ? parts[1] : null;
}

/** Lowercase, accents and punctuation stripped, "&" as "and", no leading "the". */
export function normalizeArtistName(name: string): string {
  return (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

/**
 * True when a resolved artist's name differs materially from the typed one.
 * Case, accents, punctuation and a leading "The" are not material; a letter is
 * ("Ada Sample" vs "Ada Sampley" are two different artists). An empty typed
 * name never mismatches: there is nothing to contradict.
 */
export function artistNameMismatch(typed: string, resolved: string): boolean {
  const t = normalizeArtistName(typed);
  if (!t) return false;
  return t !== normalizeArtistName(resolved);
}

export interface ArtistRelease {
  name: string;
  type: string;
  release_date: string | null;
}

/** One artist, as the picker card and the campaign header show it. */
export interface ArtistCandidate {
  spotify_id: string;
  name: string;
  spotify_url: string;
  image_url: string | null;
  /** Spotify monthly listeners via Soundcharts; null when unavailable. */
  monthly_listeners: number | null;
  listeners_date: string | null;
  genres: string[];
  country_code: string | null;
  latest_release: ArtistRelease | null;
  /** Soundcharts UUID bridged from the Spotify id; null when not in Soundcharts. */
  soundcharts_uuid: string | null;
}

/** What is persisted at campaigns.artist_data.spotify. */
export interface ArtistIdentitySnapshot extends ArtistCandidate {
  confirmed_at: string;
}

/**
 * Read a campaign row's confirmed identity for display. Null for legacy
 * campaigns created before the artist step required one. A row with an id but
 * no snapshot (e.g. written by another path) still yields a working link.
 */
export function readArtistIdentity(row: {
  artist_spotify_id?: string | null;
  artist_name?: string | null;
  artist_data?: unknown;
}): { spotify_id: string; name: string; spotify_url: string; image_url: string | null } | null {
  const id = row.artist_spotify_id;
  if (!id || !SPOTIFY_ID_RE.test(id)) return null;
  const data = row.artist_data;
  const snap =
    data && typeof data === "object" && !Array.isArray(data)
      ? ((data as Record<string, unknown>).spotify as Partial<ArtistIdentitySnapshot> | undefined)
      : undefined;
  const usable = snap && typeof snap === "object" && snap.spotify_id === id;
  return {
    spotify_id: id,
    name: (usable && typeof snap.name === "string" ? snap.name : row.artist_name) ?? "",
    spotify_url: `https://open.spotify.com/artist/${id}`,
    image_url: usable && typeof snap.image_url === "string" ? snap.image_url : null,
  };
}

/** "8,705 monthly listeners", "1.2M monthly listeners". */
export function formatListeners(n: number): string {
  const v =
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`
      : n.toLocaleString("en-US");
  return `${v} monthly ${n === 1 ? "listener" : "listeners"}`;
}
