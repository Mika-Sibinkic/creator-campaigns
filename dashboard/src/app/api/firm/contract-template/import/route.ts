// src/app/api/firm/contract-template/import/route.ts
//
// POST multipart — read a contract the label already has (.docx / .pdf / .txt
// / .md) and hand back its text plus suggested {{placeholder}} positions.
//
// SAME POSTURE AS ./generate, deliberately: this route NEVER writes to the
// database and NEVER sends anything. The text lands in the settings editor as
// a draft, a human reviews it and clicks the blanks they want turned into
// slots, and saving goes through the existing PUT /api/firm/contract-template
// flow — which revokes approval, so an import can no more send itself than a
// generated draft can. Nothing is stored here, so nothing needs cleaning up
// when the label closes the tab on a contract they decided not to use.
//
// THE UPLOAD IS UNTRUSTED INPUT FROM A THIRD PARTY. Their lawyer wrote it, or
// someone claiming to be their lawyer did. It is handled as TEXT and it never
// reaches a model: there is no import of model-provider here or in
// src/lib/contract-import.ts, and tests/contract-import.test.ts asserts that
// against the source of both files so a later "summarize the imported
// contract" feature cannot add one quietly. The defences that remain are
// boring on purpose — a byte cap, an extension allowlist, a magic-byte sniff,
// and control-character stripping.
//
// Rate limit: 'auth', matching ./generate and ./approve. That is safe here
// only because MAX_IMPORT_BYTES (2MB) bounds the parse, so 120 req/min cannot
// turn into unbounded CPU the way an uncapped PDF would. If the cap ever
// rises, this moves to 'expensive' with it.

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { DEAL_FILLABLE_PLACEHOLDERS, KNOWN_PLACEHOLDERS } from '@/lib/contracts';
import {
  ACCEPTED_DESCRIPTION,
  ContractImportError,
  MAX_IMPORT_BYTES,
  extractContractText,
  suggestBlanks,
} from '@/lib/contract-import';

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

  // Not readJson: this is the one contract-template route that takes bytes.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: 'Nothing was uploaded. Choose a contract file and try again.', code: 'invalid_form' },
      { status: 400 },
    );
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: 'Nothing was uploaded. Choose a contract file and try again.', code: 'file_required' },
      { status: 400 },
    );
  }

  // Checked before reading the body into memory as well as inside the
  // extractor, which is the one that a direct lib caller also goes through.
  if (file.size > MAX_IMPORT_BYTES) {
    return NextResponse.json(
      {
        error: `That file is ${(file.size / (1024 * 1024)).toFixed(1)}MB. A contract is text; the limit is ${MAX_IMPORT_BYTES / (1024 * 1024)}MB.`,
        code: 'file_too_large',
        max_bytes: MAX_IMPORT_BYTES,
      },
      { status: 413 },
    );
  }

  const filename = typeof file.name === 'string' ? file.name : '';
  const declaredType = file.type || '';

  let extracted;
  try {
    extracted = await extractContractText(await file.arrayBuffer(), declaredType, filename);
  } catch (e) {
    if (e instanceof ContractImportError) {
      // 415 for "we don't take that", 413 for size, 422 for "we take that but
      // this copy is broken". The message is already a sentence for the user.
      const status =
        e.code === 'file_too_large' ? 413
        : e.code === 'unsupported_type' || e.code === 'legacy_doc' ? 415
        : 422;
      return NextResponse.json(
        { error: e.message, code: e.code, accepted: ACCEPTED_DESCRIPTION },
        { status },
      );
    }
    // An unexpected parser failure is ours, not theirs. Never leak the stack.
    console.error('[contract-template/import] extraction threw', e);
    return NextResponse.json(
      {
        error: 'We couldn’t read that file, and nothing was changed. Try re-saving it, or paste the text in by hand.',
        code: 'extraction_failed',
      },
      { status: 500 },
    );
  }

  const suggestions = suggestBlanks(extracted.text);

  await audit(
    {
      action: 'firm.contract_template.imported',
      target_type: 'contract_template',
      target_id: session.firm_id,
      firm_id: session.firm_id,
      // SHAPE ONLY. The body is a third party's legal text and nothing is
      // stored, so putting it in the audit log would be the only copy this
      // route ever persisted — same posture as PUT and ./generate.
      metadata: {
        filename: filename.slice(0, 120),
        content_type: declaredType.slice(0, 120),
        size_bytes: file.size,
        chars: extracted.text.length,
        warnings: extracted.warnings.length,
        suggestions: suggestions.length,
      },
    },
    req,
  );

  return NextResponse.json({
    text: extracted.text,
    warnings: extracted.warnings,
    suggestions,
    // Explicit, because the whole affordance rests on it being true.
    stored: false,
    filename: filename.slice(0, 120),
    known_placeholders: KNOWN_PLACEHOLDERS,
    deal_fillable_placeholders: DEAL_FILLABLE_PLACEHOLDERS,
  });
}
