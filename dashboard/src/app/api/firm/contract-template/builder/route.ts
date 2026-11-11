// src/app/api/firm/contract-template/builder/route.ts
//
// GET — what the guided contract builder needs to start: the firm's name (the
// default legal name), how its payouts actually settle (so the payment tile
// starts on the clause that matches), and whether a template already exists
// (so the page can say applying replaces it). Read-only.
//
// SECURITY-OK: supabaseAdmin, same posture as ../route.ts — contract_templates
// is service-role only, and every query is scoped to session.firm_id.

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { resolveSettlementPolicy } from '@/lib/split-settlement';

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
  if (!session.firm_id) {
    return NextResponse.json({ error: 'no_firm' }, { status: 403 });
  }

  const sb = supabaseAdmin();
  const { data: firm, error: firmErr } = await sb
    .from('firms')
    .select('id, name, require_delivery_before_balance, deposit_pct')
    .eq('id', session.firm_id)
    .maybeSingle();
  if (firmErr) return NextResponse.json({ error: firmErr.message }, { status: 500 });
  const f = firm as {
    id: string;
    name: string | null;
    require_delivery_before_balance?: boolean | null;
    deposit_pct?: number | null;
  } | null;
  const policy = resolveSettlementPolicy(f);

  const { data: tpl } = await sb
    .from('contract_templates')
    .select('id, name, updated_at')
    .eq('firm_id', session.firm_id)
    .maybeSingle();
  let approvedAt: string | null = null;
  if (tpl) {
    const { data: appr } = await sb
      .from('contract_templates')
      .select('approved_at')
      .eq('firm_id', session.firm_id)
      .maybeSingle();
    approvedAt = (appr as { approved_at?: string | null } | null)?.approved_at ?? null;
  }

  return NextResponse.json({
    firm_id: session.firm_id,
    firm_name: f?.name ?? '',
    settlement: { split_enabled: policy.splitEnabled, deposit_pct: policy.depositPct },
    current_template: tpl
      ? {
          name: (tpl as { name: string }).name,
          updated_at: (tpl as { updated_at: string }).updated_at,
          approved_at: approvedAt,
        }
      : null,
  });
}
