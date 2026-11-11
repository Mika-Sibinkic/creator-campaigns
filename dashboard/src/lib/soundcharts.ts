// src/lib/soundcharts.ts
//
// Soundcharts artist-performance data (cross-platform streams / audience /
// virality) — the streamcount side of CPM attribution. OAuth 2.0 client_credentials →
// bearer token (cached), then Bearer auth on the data API.
//
// Auth (https://developers.soundcharts.com/api/authorization):
//   POST https://account.soundcharts.com/oauth/token
//     Authorization: Basic base64(CLIENT_ID:CLIENT_SECRET)
//     body: grant_type=client_credentials&team_id=<team>
//   → { access_token, token_type: 'bearer', expires_in }
//   Data: GET https://customer.api.soundcharts.com/... with Authorization: Bearer <token>
//
// Env: SOUNDCHARTS_CLIENT_ID, SOUNDCHARTS_CLIENT_SECRET, SOUNDCHARTS_TEAM_ID (optional).

const ACCOUNT_BASE = 'https://account.soundcharts.com';
const API_BASE = 'https://customer.api.soundcharts.com';

let cachedToken: { token: string; expiresAt: number } | null = null;

export function soundchartsConfigured(): boolean {
  return !!process.env.SOUNDCHARTS_CLIENT_ID && !!process.env.SOUNDCHARTS_CLIENT_SECRET;
}

async function getToken(): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const id = process.env.SOUNDCHARTS_CLIENT_ID;
  const secret = process.env.SOUNDCHARTS_CLIENT_SECRET;
  if (!id || !secret) return { ok: false, error: 'soundcharts_credentials_missing' };
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) return { ok: true, token: cachedToken.token };

  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const team = process.env.SOUNDCHARTS_TEAM_ID;
  if (team) body.set('team_id', team);

  try {
    const res = await fetch(`${ACCOUNT_BASE}/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const json = (await res.json().catch(() => null)) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
      message?: string;
    } | null;
    if (!res.ok || !json?.access_token) {
      return { ok: false, error: json?.error_description ?? json?.error ?? json?.message ?? `HTTP ${res.status}` };
    }
    cachedToken = { token: json.access_token, expiresAt: now + Math.max(0, (json.expires_in ?? 3600) - 60) * 1000 };
    return { ok: true, token: json.access_token };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ScResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  status?: number;
}

async function scGet<T = unknown>(path: string): Promise<ScResult<T>> {
  const t = await getToken();
  if (!t.ok) return { ok: false, error: t.error };
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${t.token}` } });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const errs = (json as { errors?: Array<{ message?: string }> } | null)?.errors;
      return { ok: false, status: res.status, error: errs?.[0]?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: json as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Artist lookups (used for identity confirmation + attribution) ───────────

export interface ScArtist {
  uuid: string;
  name: string;
  imageUrl?: string;
  appUrl?: string;
}

/** Search artists by name — used to confirm the campaign's artist exists + pick the UUID. */
export async function searchArtist(name: string): Promise<ScResult<{ items: ScArtist[] }>> {
  return scGet(`/api/v2/artist/search/${encodeURIComponent(name)}?offset=0&limit=10`);
}

export interface ScArtistDetail extends ScArtist {
  countryCode?: string;
  genres?: Array<{ root?: string; sub?: string[] }>;
}

/**
 * Soundcharts artist for a Spotify artist id — the deterministic bridge from a
 * confirmed Spotify identity to the UUID attribution runs on. Probed live
 * 2026-10-01: 200 `{ type: 'artist', object: {...} }`. (The reverse,
 * `/artist/{uuid}/identifiers`, is 404 "access" on this plan, so the bridge
 * only runs Spotify → Soundcharts.)
 */
export async function getArtistBySpotifyId(
  spotifyId: string,
): Promise<ScResult<{ object?: ScArtistDetail }>> {
  return scGet(`/api/v2.9/artist/by-platform/spotify/${encodeURIComponent(spotifyId)}`);
}

/** Full artist metadata by Soundcharts UUID. */
export async function getArtistMetadata(uuid: string): Promise<ScResult<{ object: unknown }>> {
  return scGet(`/api/v2.9/artist/${encodeURIComponent(uuid)}`);
}

// ── Spotify monthly listeners ───────────────────────────────────────────────
//
// The path is `/streaming/{platform}/listening`, NOT `/listeners`.
//
// `/listeners` returned 404 `{"errors":[{"key":"access","code":404,...}]}`,
// and that 404 was long read as a plan limitation ("Soundcharts doesn't
// serve us listeners"). It was never a plan limit — it was the wrong path.
// Probed live 2026-09-15: `/listening` returns 200 with a full daily series. Do not
// "correct" this back to the plural.
const LISTENING_PATH = 'listening';

export interface ScPage {
  offset: number;
  limit: number;
  next: string | null;
  previous: string | null;
  total: number;
}

export interface ScSeriesPoint {
  date: string;
  value: number;
}

export interface ScListeningSeries {
  items: ScSeriesPoint[];
  page?: ScPage;
  related?: {
    artist?: { uuid?: string; name?: string; imageUrl?: string; appUrl?: string; slug?: string };
    platform?: string;
    /** Last time Soundcharts itself crawled the platform — the freshness bound. */
    lastCrawlDate?: string;
  };
}

/** Hard cap on `page.next` follows, so a bad envelope can't spin the quota. */
const MAX_PAGES = 10;

/**
 * Spotify monthly-listener time series — the artist-side signal behind campaign
 * lift.
 *
 * Shape confirmed live 2026-09-15:
 *   { related: { artist, platform, lastCrawlDate },
 *     items: [{ date: '2026-09-14T00:00:00+00:00', value: 1234 }, ...],  // DESC
 *     page:  { offset, limit, next, previous, total },
 *     errors: [] }
 *
 * `items` is descending by date and is NOT dense — real gaps of 1-3 days are
 * normal, because the series reflects Soundcharts' crawl cadence.
 *
 * With no dates the API defaults to the last 30 days (observed: it rewrote an
 * unparameterised call to `startDate=<today-30d>&endDate=<today>` in the
 * `page.next` link). Pass dates explicitly for anything older than a month.
 *
 * `page.next` is a relative path carrying its own query string; we follow it
 * up to MAX_PAGES and concatenate.
 */
export async function getSpotifyListeners(
  uuid: string,
  startDate?: string,
  endDate?: string,
  limit?: number,
): Promise<ScResult<ScListeningSeries>> {
  const q = new URLSearchParams();
  if (startDate) q.set('startDate', startDate);
  if (endDate) q.set('endDate', endDate);
  if (limit) q.set('limit', String(limit));
  const qs = q.toString();
  let path = `/api/v2/artist/${encodeURIComponent(uuid)}/streaming/spotify/${LISTENING_PATH}${qs ? `?${qs}` : ''}`;

  const items: ScSeriesPoint[] = [];
  let firstPage: ScListeningSeries | undefined;
  let pages = 0;

  while (pages < MAX_PAGES) {
    const res = await scGet<ScListeningSeries>(path);
    if (!res.ok) {
      // A later page failing still yields the pages we already hold.
      if (items.length > 0 && firstPage) {
        return { ok: true, data: { ...firstPage, items } };
      }
      return res;
    }
    pages += 1;
    const body = res.data;
    if (!firstPage) firstPage = body;
    for (const it of body?.items ?? []) {
      const value = Number(it?.value);
      if (typeof it?.date === 'string' && Number.isFinite(value)) {
        items.push({ date: it.date, value });
      }
    }
    const next = body?.page?.next;
    if (!next) break;
    path = next.startsWith('http') ? new URL(next).pathname + new URL(next).search : next;
  }

  return { ok: true, data: { ...(firstPage ?? {}), items } };
}

/** `YYYY-MM-DD` in UTC, the date format the Soundcharts range params take. */
export function scDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ── Attribution helpers ─────────────────────────────────────────────────────

/** Most recent {date, value} point of a Soundcharts time series (null if empty). */
export function latestSeriesValue(
  items: Array<{ date?: string; value?: number }> | null | undefined,
): { date: string; value: number } | null {
  let best: { date: string; value: number } | null = null;
  for (const it of items ?? []) {
    const value = Number(it?.value);
    const date = typeof it?.date === 'string' ? it.date : '';
    if (!date || !Number.isFinite(value)) continue;
    if (!best || date > best.date) best = { date, value };
  }
  return best;
}

/**
 * Baseline metric snapshot persisted to campaigns.artist_baseline (jsonb,
 * migration 036) when a campaign is confirmed with a Soundcharts UUID. The
 * attribution deltas are measured against this anchor.
 */
export interface ArtistBaseline {
  source: 'soundcharts';
  soundcharts_uuid: string;
  captured_at: string;
  spotify_listeners: number | null;
  /** Date the listeners value is for (Soundcharts series date, not poll time). */
  listeners_date: string | null;
  /** Trimmed metadata subset — identity display only, not the raw payload. */
  artist: { name: string | null; image_url: string | null; country_code: string | null } | null;
  /**
   * Pre-campaign listener history, captured at confirm.
   *
   * This is the counterfactual anchor: without it the only claim available is
   * "listeners moved by N", with no way to say how much of that the artist was
   * heading for anyway. Captured at confirm rather than fetched on read so the
   * comparison line is fixed at the moment the campaign started and cannot be
   * re-fitted later to flatter the result.
   *
   * Costs zero extra API calls — it is the same `/listening` response the
   * baseline value is read from, just widened to PRE_WINDOW_DAYS.
   */
  pre_window: { start: string; end: string; points: ScSeriesPoint[] } | null;
  /** Populated when a sub-fetch failed; the baseline row still persists. */
  errors?: string[];
}

/** How much pre-campaign history to anchor the counterfactual on. */
export const PRE_WINDOW_DAYS = 90;

/**
 * Capture the confirm-time baseline: artist metadata + latest Spotify monthly
 * listeners. Never throws — partial failures land in `errors` so the confirm
 * route stays non-blocking (a Soundcharts outage must not block a campaign).
 */
export async function captureArtistBaseline(
  uuid: string,
  nowMs: number = Date.now(),
): Promise<ArtistBaseline> {
  const errors: string[] = [];

  let artist: ArtistBaseline['artist'] = null;
  const meta = await getArtistMetadata(uuid);
  if (meta.ok && meta.data?.object && typeof meta.data.object === 'object') {
    const o = meta.data.object as Record<string, unknown>;
    artist = {
      name: typeof o.name === 'string' ? o.name : null,
      image_url: typeof o.imageUrl === 'string' ? o.imageUrl : null,
      country_code: typeof o.countryCode === 'string' ? o.countryCode : null,
    };
  } else {
    errors.push(`metadata: ${meta.error ?? 'unavailable'}`);
  }

  // One call covers both jobs: the anchor value is the newest point in the
  // series, and everything behind it is the pre-campaign trend window.
  const start = scDay(nowMs - PRE_WINDOW_DAYS * 86_400_000);
  const end = scDay(nowMs);

  let listeners: { date: string; value: number } | null = null;
  let preWindow: ArtistBaseline['pre_window'] = null;
  const series = await getSpotifyListeners(uuid, start, end);
  if (series.ok) {
    const items = series.data?.items ?? [];
    listeners = latestSeriesValue(items);
    if (!listeners) errors.push('listeners: empty series');
    if (items.length > 0) {
      // Ascending, deduped by calendar day — the fit expects a clean series.
      const byDay = new Map<string, number>();
      for (const it of items) {
        const day = typeof it.date === 'string' ? it.date.slice(0, 10) : '';
        const value = Number(it.value);
        if (!day || !Number.isFinite(value)) continue;
        if (!byDay.has(day)) byDay.set(day, value);
      }
      const points = [...byDay.entries()]
        .map(([date, value]) => ({ date, value }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      if (points.length > 0) {
        preWindow = { start, end, points };
      }
    }
  } else {
    errors.push(`listeners: ${series.error ?? 'unavailable'}`);
  }

  const baseline: ArtistBaseline = {
    source: 'soundcharts',
    soundcharts_uuid: uuid,
    captured_at: new Date(nowMs).toISOString(),
    spotify_listeners: listeners?.value ?? null,
    listeners_date: listeners?.date ?? null,
    artist,
    pre_window: preWindow,
  };
  if (errors.length > 0) baseline.errors = errors;
  return baseline;
}
