// src/app/api/firm/route.ts
//
// SEC-1 refactor: USER PATH — uses the cookie-bound Supabase client so RLS
// scopes the read/write to the caller's firm via firm_members. Service-role
// is no longer used here. F2/F3 settings page calls this with the magic-link
// session, and only sees its own firm's row.
import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { UpdateFirmBody } from '@/lib/zod-schemas';

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

  // RLS guarantees this row is the caller's firm. Single-tenant: still 1 row.
  const { data, error } = await sb
    .from('firms')
    .select('id, name, testing_mode, test_recipient_email, negotiation_inbox_email, sender_email, sender_name, voice_profile, label_type, scraping_prefs, outreach_prefs, campaign_defaults, onboarding_completed_at, monthly_spend_cap_usd, per_creator_monthly_cap_usd, daily_apify_cap_usd')
    .eq('id', session.firm_id)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
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

  const body = await readJson(req, UpdateFirmBody);
  if (body instanceof NextResponse) return body;
  const updates: Record<string, unknown> = Object.fromEntries(
    Object.entries(body).filter(([, v]) => v !== undefined)
  );

  const { data, error } = await sb
    .from('firms')
    .update(updates as never)
    .eq('id', session.firm_id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Testing-mode toggles get their own action so ops can grep for them; the
  // recipient email change is just as sensitive (it's where outreach is
  // routed in testing mode), so it carries the same elevated action when
  // it appears in the diff.
  const updatedKeys = Object.keys(updates);
  const action =
    'testing_mode' in updates ||
    'test_recipient_email' in updates ||
    'negotiation_inbox_email' in updates
      ? 'firm.testing_mode.toggle'
      : 'firm.update';
  await audit(
    {
      action,
      target_type: 'firm',
      target_id: session.firm_id,
      firm_id: session.firm_id,
      metadata: { fields: updatedKeys, after: updates },
    },
    req
  );

  return NextResponse.json(data);
}
