// src/app/api/firm/contract-template/builder/preview/route.ts
//
// POST { answers, polish? } — build the guided template from the answers and
// return it for preview. Never saves a template and never sends anything.
//
// polish:false (default) is pure computation: the deterministic assembly,
// no model, no audit row. polish:true additionally runs the wording-only
// model pass. polishGuidedTemplate rejects any output that changes a
// section, a placeholder or a number and returns the deterministic text
// instead; the per-section change list comes back so the reviewer sees what
// was reworded rather than diffing legal prose by eye. Only the polish call
// is audited (it spends a model call), same action as the generate route.

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { ContractBuilderPreviewBody } from '@/lib/zod-schemas';
import {
  assembleGuidedTemplate,
  guidedTemplateProblems,
  polishGuidedTemplate,
  validateAnswers,
} from '@/lib/contract-builder';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = await readJson(req, ContractBuilderPreviewBody);
  if (body instanceof NextResponse) return body;

  // A model call is the expensive tier; a plain preview is ordinary traffic.
  const limit = tieredLimit(req, body.polish ? 'expensive' : 'auth');
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

  const v = validateAnswers(body.answers);
  if (!v.ok) {
    return NextResponse.json({ error: 'invalid_answers', errors: v.errors }, { status: 422 });
  }
  const base = assembleGuidedTemplate(v.answers);

  if (!body.polish) {
    return NextResponse.json({
      base_text: base,
      body_text: base,
      source: 'deterministic',
      generated_by: 'base',
      warnings: [],
      diff: null,
      reworded_sections: [],
      problems: guidedTemplateProblems(base),
    });
  }

  const result = await polishGuidedTemplate(base);
  await audit(
    {
      action: 'firm.contract_template.draft_generated',
      target_type: 'contract_template',
      target_id: session.firm_id,
      firm_id: session.firm_id,
      // Shape only, same posture as the generate route.
      metadata: {
        via: 'guided_builder',
        source: result.source,
        generated_by: result.generated_by,
        warnings: result.warnings,
        length: result.body_text.length,
        reworded_sections: result.reworded_sections,
      },
    },
    req,
  );

  return NextResponse.json({
    base_text: base,
    ...result,
    problems: guidedTemplateProblems(result.body_text),
  });
}
