// src/app/api/me/route.ts
//
// Who am I? The identity the UI chrome needs, in one call.
//
// Exists mainly so client components can hide operator-only surfaces without
// each one fetching its own thing. The hiding is cosmetic — every operator
// route enforces `requireOperator()` server-side regardless of what the client
// chose to render.
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { isPlatformOperator } from '@/lib/operator';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  let session;
  try {
    session = await requireSession();
  } catch (r) {
    return r as Response;
  }

  // The workspace name, so the shell can say whose workspace this is instead
  // of the hardcoded "<label> workspace" it used to carry.
  let workspace_name: string | null = null;
  if (session.firm_id) {
    const { data } = await supabaseAdmin()
      .from('firms')
      .select('name')
      .eq('id', session.firm_id)
      .maybeSingle();
    workspace_name = (data as { name: string } | null)?.name ?? null;
  }

  return NextResponse.json({
    email: session.user.email,
    firm_id: session.firm_id,
    workspace_name,
    role: session.role,
    operator: isPlatformOperator(session.user.email),
  });
}
