// src/app/api/firm/contract-template/builder/apply/route.ts
//
// POST — "Approve and apply to this firm" from the guided builder. Saves the
// previewed agreement as the firm's template AND marks it approved, so the
// next closed deal attaches it (generateOfferContract reads approved_at).
//
// Same gate and the same audit actions as the two-step path it collapses
// (PUT ../route.ts, then POST ../approve): session-gated, scoped to
// session.firm_id, approved_by derived server-side, never from the client.
// The approve route's guards are kept in substance: the text approved is the
// text the reviewer saw (the page sends what it previewed, and the server
// re-derives it from the answers), it cannot carry a DRAFT header, and it
// cannot contain a slot the deal fill does not know.
//
// One upsert, not save-then-approve, so a failure cannot leave a previously
// approved template replaced by an unapproved one.
//
// SECURITY-OK: supabaseAdmin — contract_templates is RLS service-role only.

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { ContractBuilderApplyBody } from '@/lib/zod-schemas';
import { applyGuidedTemplate } from '@/lib/contract-builder';
import { isPlatformOperator } from '@/lib/operator';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
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

  const body = await readJson(req, ContractBuilderApplyBody);
  if (body instanceof NextResponse) return body;

  const outcome = await applyGuidedTemplate(supabaseAdmin(), {
    firmId: session.firm_id,
    rawAnswers: body.answers,
    bodyText: body.body_text,
    approvedBy: `user:${session.user.email ?? session.user.id}`,
    nowIso: new Date().toISOString(),
  });

  if (!outcome.ok) {
    return NextResponse.json(
      {
        error: outcome.error,
        code: outcome.code,
        // Operator-only technical detail, same posture as ../approve.
        detail:
          outcome.code === 'invalid_answers' || isPlatformOperator(session.user.email)
            ? outcome.detail
            : undefined,
      },
      { status: outcome.status },
    );
  }

  await audit(
    {
      action: 'firm.contract_template.updated',
      target_type: 'contract_template',
      target_id: outcome.template_id,
      firm_id: session.firm_id,
      metadata: {
        via: 'guided_builder',
        source: outcome.source,
        length: outcome.length,
        placeholders: outcome.placeholders,
        unknown_placeholders: [],
      },
    },
    req,
  );
  await audit(
    {
      action: 'firm.contract_template.approved',
      target_type: 'contract_template',
      target_id: outcome.template_id,
      firm_id: session.firm_id,
      metadata: { via: 'guided_builder', length: outcome.length, approved_at: outcome.approved_at },
    },
    req,
  );

  return NextResponse.json({
    approved_at: outcome.approved_at,
    approved_by: outcome.approved_by,
    source: outcome.source,
  });
}
