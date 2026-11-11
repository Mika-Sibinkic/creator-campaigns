// src/app/api/firm/contract-template/generate/route.ts
//
// POST — generate a starting contract-template DRAFT for the firm (labels
// that don't bring their own contract). Deterministic base template; when the
// firm describes extra clauses, model-assisted customization via the one
// model seam (src/lib/model-provider.ts complete()), structurally validated
// with a deterministic fallback — see src/lib/contract-generator.ts.
//
// This route NEVER writes to the database and NEVER sends anything. The draft
// goes back to the settings editor, a human reviews it, and saving goes
// through the existing PUT /api/firm/contract-template flow.
//
// Saving does not make it sendable either: the send path gates on
// contract_templates.approved_at, which only ./approve sets. Every draft also
// starts with DRAFT_TEMPLATE_HEADER, but that is a VISIBLE MARKER for the
// reviewer, not a gate — an em dash does not survive a Word round-trip.

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { GenerateContractTemplateBody } from '@/lib/zod-schemas';
import { KNOWN_PLACEHOLDERS } from '@/lib/contracts';
import { generateContractTemplate, normalizeJurisdiction } from '@/lib/contract-generator';

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

  const body = await readJson(req, GenerateContractTemplateBody);
  if (body instanceof NextResponse) return body;

  // The clause reads "governed by the laws of {{governing_law}}", so
  // "Delaware law" would render as "the laws of Delaware law". Reject it
  // here with wording the user can act on rather than emitting nonsense into
  // a legal document and hoping review catches it.
  const jurisdiction = normalizeJurisdiction(body.governing_law);
  if ('error' in jurisdiction) {
    return NextResponse.json(
      { error: jurisdiction.error, field: 'governing_law' },
      { status: 422 },
    );
  }

  const result = await generateContractTemplate({
    firmName: body.firm_name,
    governingLaw: jurisdiction.value,
    extraClauses: body.extra_clauses,
  });

  await audit(
    {
      action: 'firm.contract_template.draft_generated',
      target_type: 'contract_template',
      target_id: session.firm_id,
      firm_id: session.firm_id,
      // Shape only — the draft body is (candidate) legal text, same posture
      // as the PUT route's audit.
      metadata: {
        source: result.source,
        generated_by: result.generated_by,
        warnings: result.warnings,
        length: result.body_text.length,
        had_extra_clauses: Boolean(body.extra_clauses?.trim()),
      },
    },
    req,
  );

  return NextResponse.json({
    body_text: result.body_text,
    source: result.source,
    generated_by: result.generated_by,
    warnings: result.warnings,
    // What the model changed relative to the curated base, so the reviewer
    // can see a removed or renamed clause instead of having to diff nine
    // sections of legal prose by eye.
    diff: result.diff,
    known_placeholders: KNOWN_PLACEHOLDERS,
  });
}
