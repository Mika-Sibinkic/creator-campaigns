// src/app/api/artists/resolve/route.ts
//
// Paste-a-link path of the new-campaign artist step. Takes a Spotify artist
// link, `spotify:artist:` URI or bare id, resolves it against the Spotify Web
// API (client credentials, server-side only) and returns the same card the
// search returns. Deterministic: one id in, that artist out, no ranking.
//
//   200 { artist: ArtistCandidate }
//   400 { error: 'invalid_link' }               not a Spotify artist link
//   404 { error: 'artist_not_found' }           Spotify has no such artist
//   503 { error: 'artist_lookup_unavailable' }  Spotify unconfigured or down
import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { parseSpotifyArtistRef } from '@/lib/artist-identity';
import { resolveArtistById } from '@/lib/artist-lookup';

export const runtime = 'nodejs';

const STATUS = { invalid_link: 400, artist_not_found: 404, artist_lookup_unavailable: 503 } as const;

export async function GET(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }

  try {
    await requireSessionAndClient();
  } catch (r) {
    return r as Response;
  }

  const id = parseSpotifyArtistRef((req.nextUrl.searchParams.get('ref') ?? '').slice(0, 500));
  if (!id) return NextResponse.json({ error: 'invalid_link' }, { status: STATUS.invalid_link });

  try {
    const r = await resolveArtistById(id);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: STATUS[r.error] });
    return NextResponse.json({ artist: r.artist });
  } catch {
    return NextResponse.json(
      { error: 'artist_lookup_unavailable' },
      { status: STATUS.artist_lookup_unavailable }
    );
  }
}
