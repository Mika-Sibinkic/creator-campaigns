// src/app/api/firm/contract-template/approve/route.ts
//
// POST — mark the firm's saved contract template approved for sending.
// DELETE — revoke that approval.
//
// This is the ONLY thing that lets a contract reach a creator. The send path
// (generateOfferContract) reads contract_templates.approved_at and attaches
// nothing while it is NULL, so approval is state set by a deliberate action —
// not a sentence someone deleted from the body.
//
// It used to be the latter: generated drafts carried a "DRAFT — ..." header
// and the reviewer deleted that line to approve. That gate failed open. The
// header contains an em dash (U+2014), so a Word/Google Docs round-trip of
// counsel's redline, or a reviewer retyping the line, produced a hyphen the
// gate no longer matched — and the next closed deal emailed a creator a
// machine-drafted agreement still headed "DRAFT".
//
// Two guards on the approval itself:
//   - body_text must match what is stored, so the reviewer cannot approve
//     text that was edited in another tab (or by another user) since they
//     read it.
//   - a body that still reads as an un-reviewed draft is refused. That check
//     is fuzzy (looksLikeDraftHeader normalizes dashes and case) precisely
//     because the exact-match version was the bug. It only ever REFUSES
//     approval; it can never grant a send.
//
// approved_by is derived from the session server-side, never from the client.

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { ApproveContractTemplateBody } from '@/lib/zod-schemas';
import { detectPlaceholders, looksLikeDraftHeader, KNOWN_PLACEHOLDERS } from '@/lib/contracts';
import { isPlatformOperator } from '@/lib/operator';

export const runtime = 'nodejs';

// Two audiences, one failure. The label needs to know the door is shut and
// that it is not their doing; we need to know which door. The migration file
// name used to be in the user-facing `error` string, on a record label's
// settings page.
const APPROVAL_UNAVAILABLE =
  'Contract approval is temporarily unavailable. Nothing was changed. Try again shortly.';
const APPROVAL_UNAVAILABLE_OPERATOR_HINT =
  'The contract_templates approval columns are missing. Apply ' +
  'supabase/migrations/041_contract_template_approval.sql, then approve again.';

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

  const body = await readJson(req, ApproveContractTemplateBody);
  if (body instanceof NextResponse) return body;

  const sb = supabaseAdmin();
  const { data: tpl, error } = await sb
    .from('contract_templates')
    .select('id, body_text')
    .eq('firm_id', session.firm_id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const row = tpl as { id: string; body_text: string } | null;
  if (!row) {
    return NextResponse.json(
      { error: 'No contract template saved yet. Save one before approving it.' },
      { status: 404 },
    );
  }

  // Approve exactly what the reviewer read.
  if (row.body_text !== body.body_text) {
    return NextResponse.json(
      {
        error:
          'The saved template has changed since you loaded it. Reload the page, re-read the wording, then approve.',
        code: 'stale_body',
      },
      { status: 409 },
    );
  }

  if (looksLikeDraftHeader(row.body_text)) {
    return NextResponse.json(
      {
        error:
          'This template still carries its generated DRAFT header, so it has not been through legal review. ' +
          'Remove that line once the wording has been reviewed, save, then approve.',
        code: 'still_draft',
      },
      { status: 422 },
    );
  }

  // An approved template that cannot fill is an approval that will never
  // produce a contract. Say so now rather than at the moment a deal closes.
  const unknown = detectPlaceholders(row.body_text).filter(
    (p) => !new Set<string>(KNOWN_PLACEHOLDERS).has(p),
  );
  if (unknown.length > 0) {
    return NextResponse.json(
      {
        error:
          `This template uses ${unknown.map((u) => `{{${u}}}`).join(', ')}, which Creator Campaigns cannot fill, ` +
          'so no contract would ever send from it. Replace those with fixed text, save, then approve.',
        code: 'unknown_placeholders',
        unknown_placeholders: unknown,
      },
      { status: 422 },
    );
  }

  const approvedAt = new Date().toISOString();
  const approvedBy = `user:${session.user.email ?? session.user.id}`;
  const { error: updErr } = await sb
    .from('contract_templates')
    .update({ approved_at: approvedAt, approved_by: approvedBy } as never)
    .eq('id', row.id);
  if (updErr) {
    return NextResponse.json(
      {
        error: APPROVAL_UNAVAILABLE,
        detail: isPlatformOperator(session.user.email)
          ? `${APPROVAL_UNAVAILABLE_OPERATOR_HINT} (${updErr.message})`
          : undefined,
      },
      { status: 503 }
    );
  }

  await audit(
    {
      action: 'firm.contract_template.approved',
      target_type: 'contract_template',
      target_id: row.id,
      firm_id: session.firm_id,
      // Shape only — the body is the firm's legal text, same posture as PUT.
      metadata: { length: row.body_text.length, approved_at: approvedAt },
    },
    req,
  );

  return NextResponse.json({ approved_at: approvedAt, approved_by: approvedBy });
}

export async function DELETE(req: NextRequest) {
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

  const sb = supabaseAdmin();
  const { data: tpl, error } = await sb
    .from('contract_templates')
    .select('id')
    .eq('firm_id', session.firm_id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const row = tpl as { id: string } | null;
  if (!row) return NextResponse.json({ approved_at: null });

  const { error: updErr } = await sb
    .from('contract_templates')
    .update({ approved_at: null, approved_by: null } as never)
    .eq('id', row.id);
  if (updErr) {
    return NextResponse.json(
      {
        error: APPROVAL_UNAVAILABLE,
        detail: isPlatformOperator(session.user.email)
          ? `${APPROVAL_UNAVAILABLE_OPERATOR_HINT} (${updErr.message})`
          : undefined,
      },
      { status: 503 }
    );
  }

  await audit(
    {
      action: 'firm.contract_template.approval_revoked',
      target_type: 'contract_template',
      target_id: row.id,
      firm_id: session.firm_id,
      metadata: {},
    },
    req,
  );

  return NextResponse.json({ approved_at: null });
}
