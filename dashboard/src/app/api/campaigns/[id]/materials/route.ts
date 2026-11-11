// src/app/api/campaigns/[id]/materials/route.ts
//
// Promo-material upload for a campaign (agenda: materials at campaign inception).
// POST a multipart file → stored in the private campaign-materials bucket +
// indexed in campaign_materials. GET lists a campaign's materials. Firm-scoped:
// the campaign must belong to the caller's firm. Files are attached to creators
// on payment (see promo-materials.ts).
import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

const BUCKET = 'campaign-materials';
const MAX_BYTES = 30 * 1024 * 1024; // 30MB/file
const ALLOWED = new Set([
  'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3',
  'video/mp4', 'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
]);

async function assertCampaignInFirm(campaignId: string, firmId: string): Promise<boolean> {
  const { data } = await supabaseAdmin()
    .from('campaigns')
    .select('id')
    .eq('id', campaignId)
    .eq('firm_id', firmId)
    .maybeSingle();
  return !!data;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { session } = await requireSessionAndClient();
  if (!(await assertCampaignInFirm(id, session.firm_id))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const { data } = await supabaseAdmin()
    .from('campaign_materials')
    .select('id, filename, content_type, size_bytes, created_at')
    .eq('campaign_id', id)
    .order('created_at', { ascending: true });
  return NextResponse.json({ materials: data ?? [] });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const rl = tieredLimit(req, 'expensive');
  if (!rl.ok) {
    const { body, init } = rateLimited(rl.resetAt);
    return NextResponse.json(body, init);
  }

  const { id } = await ctx.params;
  const { session } = await requireSessionAndClient();
  if (!(await assertCampaignInFirm(id, session.firm_id))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file_required' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'file_too_large', max_bytes: MAX_BYTES }, { status: 413 });
  }
  const contentType = file.type || 'application/octet-stream';
  if (!ALLOWED.has(contentType)) {
    return NextResponse.json({ error: 'unsupported_type', got: contentType }, { status: 415 });
  }

  const admin = supabaseAdmin();
  const safeName = file.name.replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'upload';
  const key = `${session.firm_id}/${id}/${crypto.randomUUID()}-${safeName}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  const { error: upErr } = await admin.storage.from(BUCKET).upload(key, bytes, {
    contentType,
    upsert: false,
  });
  if (upErr) {
    return NextResponse.json({ error: 'upload_failed', detail: upErr.message }, { status: 502 });
  }

  const { data: row, error: insErr } = await admin
    .from('campaign_materials')
    .insert({
      campaign_id: id,
      firm_id: session.firm_id,
      storage_path: key,
      filename: safeName,
      content_type: contentType,
      size_bytes: file.size,
    } as never)
    .select('id, filename, content_type, size_bytes, created_at')
    .single();
  if (insErr) {
    await admin.storage.from(BUCKET).remove([key]); // roll back the orphaned object
    return NextResponse.json({ error: 'index_failed', detail: insErr.message }, { status: 502 });
  }

  await audit({
    action: 'campaign.material_uploaded',
    firm_id: session.firm_id,
    target_type: 'campaign',
    target_id: id,
    metadata: { filename: safeName, content_type: contentType, size_bytes: file.size },
  }, req);

  return NextResponse.json({ material: row }, { status: 201 });
}
