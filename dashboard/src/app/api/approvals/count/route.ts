// src/app/api/approvals/count/route.ts
//
// USER PATH — small polling endpoint that powers the red-dot badge on
// the /approvals nav link. Returns the number of payment_authorizations
// rows sitting at status='pending_human_review' for the caller's firm.
//
// Why a dedicated endpoint (not a server component re-render): the nav
// is a client component on every page; we want a 30s tick that doesn't
// require a full RSC round-trip. Single integer payload, RLS-scoped via
// the cookie-bound Supabase client.
//
// Cheap: count(*) on a small, hot table with a status index.

import { NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  let session;
  let sb;
  try {
    ({ session, sb } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }

  const { count, error } = await sb
    .from('payment_authorizations')
    .select('id', { count: 'exact', head: true })
    .eq('firm_id', session.firm_id)
    .eq('status', 'pending_human_review');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ pending: count ?? 0 });
}
