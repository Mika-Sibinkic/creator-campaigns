// src/app/api/artists/search/route.ts
//
// Candidate artist cards for the new-campaign artist step. Spotify search,
// enriched with Soundcharts listeners/genres and the latest release, so two
// artists with the same name can be told apart (src/lib/artist-lookup.ts).
// Session-gated + 'auth'-tier rate limited like every USER PATH route.
//
// Contract: ALWAYS 200 with a JSON array of ArtistCandidate. [] on short
// queries, missing SPOTIFY_* env, or upstream errors; the form then offers
// the paste-a-link path.
import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { lookupArtistCandidates } from '@/lib/artist-lookup';

export const runtime = 'nodejs';

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

  const q = req.nextUrl.searchParams.get('q') ?? '';
  try {
    return NextResponse.json(await lookupArtistCandidates(q));
  } catch {
    return NextResponse.json([]);
  }
}
