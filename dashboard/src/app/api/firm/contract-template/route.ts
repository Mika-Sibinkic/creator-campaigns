// src/app/api/firm/contract-template/route.ts
//
// GET/PUT the firm's deal-contract template (migration 034 —
// one active template per firm, v1).
//
// SECURITY-OK: supabaseAdmin — contract_templates is RLS service-role-only
// (same posture as migration 032's tables), so the cookie-bound RLS client
// can't read it. Access is session-gated and every query is explicitly
// scoped to session.firm_id, mirroring the payments routes.
//
// The template body saved here is the firm's OWN legal text — this path never
// generates or rewrites it (no LLM anywhere in it); it only detects
// {{placeholders}} at save time and substitutes agreed deal facts later. The
// optional generator lives at ./generate: its output lands in the editor as a
// draft and comes back through this PUT.
//
// Saving NEVER makes a template sendable. Every PUT revokes approval, and
// ./approve is the only thing that grants it.
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { PutContractTemplateBody } from '@/lib/zod-schemas';
import {
  detectPlaceholders,
  templateBodyError,
  KNOWN_PLACEHOLDERS,
} from '@/lib/contracts';

export const runtime = 'nodejs';

const TEMPLATE_COLS =
  'id, firm_id, name, body_text, placeholders_detected, created_at, updated_at';

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

  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from('contract_templates')
    .select(TEMPLATE_COLS)
    .eq('firm_id', session.firm_id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Approval state (migration 041), separate query so the card still loads
  // while the migration is unapplied. `null` renders as "not approved", which
  // matches how the send path behaves in exactly that situation.
  let approvedAt: string | null = null;
  let approvalReadable = true;
  if (data) {
    const { data: appr, error: apprErr } = await sb
      .from('contract_templates')
      .select('approved_at')
      .eq('firm_id', session.firm_id)
      .maybeSingle();
    if (apprErr) approvalReadable = false;
    else approvedAt = (appr as { approved_at?: string | null } | null)?.approved_at ?? null;
  }

  return NextResponse.json({
    template: data ?? null,
    known_placeholders: KNOWN_PLACEHOLDERS,
    approved_at: approvedAt,
    approval_readable: approvalReadable,
  });
}

export async function PUT(req: NextRequest) {
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

  const body = await readJson(req, PutContractTemplateBody);
  if (body instanceof NextResponse) return body;

  // Plain-text/markdown guards shared with the fill engine's tests.
  const bodyErr = templateBodyError(body.body_text);
  if (bodyErr) return NextResponse.json({ error: bodyErr }, { status: 422 });

  const placeholders = detectPlaceholders(body.body_text);
  const known = new Set<string>(KNOWN_PLACEHOLDERS);
  const unknown = placeholders.filter((p) => !known.has(p));

  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from('contract_templates')
    .upsert(
      {
        firm_id: session.firm_id,
        ...(body.name !== undefined ? { name: body.name } : {}),
        body_text: body.body_text,
        placeholders_detected: placeholders,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: 'firm_id' },
    )
    .select(TEMPLATE_COLS)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // ANY edit revokes approval (migration 041). Approval attaches to the exact
  // text a human read, not to the row — otherwise approving once would bless
  // every later edit, including one that pasted in a machine-drafted clause.
  // Separate statement so an unapplied migration degrades to a warning rather
  // than failing the save; the send path independently fails CLOSED while the
  // column is unreadable, so a skipped revoke can never open a gate.
  {
    const { error: revokeErr } = await sb
      .from('contract_templates')
      .update({ approved_at: null, approved_by: null } as never)
      .eq('id', (data as { id: string }).id);
    if (revokeErr) {
      console.warn(
        '[contract-template] approval not revoked on edit (migration 041 applied?):',
        revokeErr.message,
      );
    }
  }

  await audit(
    {
      action: 'firm.contract_template.updated',
      target_type: 'contract_template',
      target_id: (data as { id: string }).id,
      firm_id: session.firm_id,
      // Never audit the body itself — it's the firm's legal text. Shape only.
      metadata: {
        length: body.body_text.length,
        placeholders,
        unknown_placeholders: unknown,
        approval_revoked: true,
      },
    },
    req,
  );

  return NextResponse.json({
    template: data,
    known_placeholders: KNOWN_PLACEHOLDERS,
    unknown_placeholders: unknown,
  });
}
