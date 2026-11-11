// src/app/api/firm-member/route.ts
//
// USER PATH — read/write the caller's firm_members row.
//
// Powers the "Per-user testing overrides" card on /settings. Each tester
// owns their own row and can set sender_email / sender_name /
// test_recipient_email to route outreach to their own inbox in testing mode
// without colliding with other firm members' overrides.
//
// All three fields are optional — null/blank means "fall back to the firm
// default" (the resolution chain lives in src/lib/resend.ts).
//
// Scoped by `clerk_user_id` + `firm_id`, NOT by `user_id`. `user_id` is a uuid
// FK to auth.users left from the magic-link era; the session carries a Clerk id
// (`user_2ab…`), so querying the uuid column with it raised Postgres 22P02 and
// this route answered 500. The settings page swallows the error, so the card
// simply never rendered and nobody saw a failure.
//
// RLS is not the boundary here — requireSessionAndClient returns the
// service-role client. The two .eq() filters below are.

import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { UpdateFirmMemberBody } from '@/lib/zod-schemas';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  let session, sb;
  try {
    ({ session, sb } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }

  const { data, error } = await sb
    .from('firm_members')
    .select('id, role, sender_email, sender_name, test_recipient_email, negotiation_inbox_email')
    .eq('clerk_user_id', session.user.id)
    .eq('firm_id', session.firm_id)
    .maybeSingle();
  if (error) {
    return NextResponse.json(
      { error: 'Could not load your preferences.' },
      { status: 500 }
    );
  }
  if (!data) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  let session, sb;
  try {
    ({ session, sb } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }

  const body = await readJson(req, UpdateFirmMemberBody);
  if (body instanceof NextResponse) return body;

  // Normalize: empty string → null so blanking a field deletes the override.
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    updates[k] = v === '' ? null : v;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'no_fields' }, { status: 400 });
  }

  // maybeSingle, not single: a caller with no membership row for this
  // workspace is a 404, not a 500 with a raw Postgres string. `.single()` on
  // zero rows raises PGRST116, and this route surfaced that message verbatim.
  const { data, error } = await sb
    .from('firm_members')
    .update(updates as never)
    .eq('clerk_user_id', session.user.id)
    .eq('firm_id', session.firm_id)
    .select('id, role, sender_email, sender_name, test_recipient_email, negotiation_inbox_email')
    .maybeSingle();
  if (error) {
    return NextResponse.json(
      { error: 'Could not save your preferences. Nothing was changed.' },
      { status: 500 }
    );
  }
  if (!data) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  await audit(
    {
      action: 'firm_member.update',
      target_type: 'firm_member',
      target_id: (data as { id: string }).id,
      firm_id: session.firm_id,
      metadata: { fields: Object.keys(updates), after: updates },
    },
    req
  );

  return NextResponse.json(data);
}
