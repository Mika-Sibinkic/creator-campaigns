// src/app/api/campaigns/[id]/deal-scope/route.ts
//
// THE FIRST WRITER promo_deliverables has ever had.
//
// The table has existed since migration 025 and nothing has ever inserted a
// row, so every production negotiation has priced against a hardcoded constant
// in deliverables-store.ts while the auto-negotiator agreed to whatever package
// a creator proposed. This route is where a label states what the campaign is
// actually buying, and src/lib/negotiation.ts refuses to agree outside it.
//
// GET  → the campaign's scope, plus the derived fallback so the editor can show
//        what is in force when nothing has been set.
// PUT  → replace the whole scope. Whole-document, not per-line: the scope is
//        one statement of intent, and a partial write would leave a promo type
//        enabled that the label thought they had removed.
//
// Firm-scoped by hand. Post-Clerk the service-role client is RLS-inert, so
// every query filters on session.firm_id explicitly.
import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase';
import { readJson } from '@/lib/validate';
import { PutDealScopeBody } from '@/lib/zod-schemas';
import {
  PROMO_MAX_SECONDS,
  TIME_BASED_DEFAULT_SECONDS,
  describeDeliverables,
  type PromoType,
} from '@/lib/deliverables';
import { resolveCampaignSpec, resolveOfferDeliverables } from '@/lib/deliverables-store';

export const runtime = 'nodejs';

const SELECT =
  'promo_type, quantity, delivery_window_days, min_seconds, min_quantity, max_quantity, max_seconds';

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
  let session;
  try {
    ({ session } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }
  if (!(await assertCampaignInFirm(id, session.firm_id))) {
    return NextResponse.json({ error: 'campaign_not_found' }, { status: 404 });
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('promo_deliverables')
    .select(SELECT)
    .eq('campaign_id', id)
    .eq('firm_id', session.firm_id);
  // A missing column here means migration 040 has not been applied. Say so
  // rather than rendering an empty editor that silently drops the bounds.
  if (error) {
    return NextResponse.json({ error: 'deal_scope_unavailable', detail: error.message }, { status: 503 });
  }

  // What is ACTUALLY in force right now, including the derived fallback. The
  // editor shows this so an unconfigured campaign does not read as unguarded.
  const standing = await resolveOfferDeliverables(admin, { campaignId: id });
  const spec = await resolveCampaignSpec(admin, { campaignId: id, standing });

  return NextResponse.json({
    lines: data ?? [],
    in_force: spec,
    standing_package_text: describeDeliverables(standing),
    platform_max_seconds: PROMO_MAX_SECONDS,
    default_seconds: TIME_BASED_DEFAULT_SECONDS,
  });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const rl = tieredLimit(req, 'auth');
  if (!rl.ok) {
    const { body, init } = rateLimited(rl.resetAt);
    return NextResponse.json(body, init);
  }

  const { id } = await ctx.params;
  let session;
  try {
    ({ session } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }
  if (!(await assertCampaignInFirm(id, session.firm_id))) {
    return NextResponse.json({ error: 'campaign_not_found' }, { status: 404 });
  }

  const body = await readJson(req, PutDealScopeBody);
  if (body instanceof NextResponse) return body;

  // One row per promo_type is a DB unique index (migration 025). Catch it here
  // so the label gets a sentence instead of a Postgres error.
  const seen = new Set<PromoType>();
  for (const line of body.lines) {
    if (seen.has(line.promo_type)) {
      return NextResponse.json(
        { error: 'duplicate_promo_type', promo_type: line.promo_type, message: 'Each content type can only appear once.' },
        { status: 422 },
      );
    }
    seen.add(line.promo_type);

    const minQ = line.min_quantity ?? 1;
    const maxQ = line.max_quantity ?? line.quantity;
    if (minQ > maxQ) {
      return NextResponse.json(
        { error: 'invalid_range', promo_type: line.promo_type, field: 'quantity', message: 'The smallest number you will accept cannot be above the largest.' },
        { status: 422 },
      );
    }
    if (line.quantity > maxQ || line.quantity < minQ) {
      return NextResponse.json(
        { error: 'invalid_range', promo_type: line.promo_type, field: 'quantity', message: 'The number you are asking for has to sit inside the range you will accept.' },
        { status: 422 },
      );
    }
    const timeBased = TIME_BASED_DEFAULT_SECONDS[line.promo_type] != null;
    if (!timeBased && (line.min_seconds != null || line.max_seconds != null)) {
      return NextResponse.json(
        { error: 'invalid_range', promo_type: line.promo_type, field: 'seconds', message: 'A feed post has no length, so a length range cannot be set on it.' },
        { status: 422 },
      );
    }
    if (line.min_seconds != null && line.max_seconds != null && line.min_seconds > line.max_seconds) {
      return NextResponse.json(
        { error: 'invalid_range', promo_type: line.promo_type, field: 'seconds', message: 'The shortest video you will accept cannot be longer than the longest.' },
        { status: 422 },
      );
    }
    const platformMax = PROMO_MAX_SECONDS[line.promo_type];
    if (platformMax != null && line.max_seconds != null && line.max_seconds > platformMax) {
      return NextResponse.json(
        {
          error: 'above_platform_limit',
          promo_type: line.promo_type,
          field: 'max_seconds',
          limit: platformMax,
          message: `The platform caps this format at ${platformMax} seconds, so a creator cannot deliver a longer one.`,
        },
        { status: 422 },
      );
    }
  }

  const admin = supabaseAdmin();

  // Replace, don't merge. Only CAMPAIGN-parent rows — an offer-parent row is a
  // negotiated per-deal package and is not this document's to delete.
  const { error: delErr } = await admin
    .from('promo_deliverables')
    .delete()
    .eq('campaign_id', id)
    .eq('firm_id', session.firm_id);
  if (delErr) {
    return NextResponse.json({ error: 'deal_scope_write_failed', detail: delErr.message }, { status: 500 });
  }

  let inserted: unknown[] = [];
  if (body.lines.length > 0) {
    const rows = body.lines.map((line) => ({
      firm_id: session.firm_id,
      campaign_id: id,
      creator_offer_id: null,
      promo_type: line.promo_type,
      quantity: line.quantity,
      delivery_window_days: body.delivery_window_days,
      min_seconds: line.min_seconds ?? TIME_BASED_DEFAULT_SECONDS[line.promo_type] ?? null,
      min_quantity: line.min_quantity ?? null,
      max_quantity: line.max_quantity ?? null,
      max_seconds: line.max_seconds ?? null,
    }));
    const { data, error: insErr } = await admin
      .from('promo_deliverables')
      .insert(rows as never)
      .select(SELECT);
    if (insErr) {
      return NextResponse.json({ error: 'deal_scope_write_failed', detail: insErr.message }, { status: 500 });
    }
    inserted = data ?? [];
  }

  await audit(
    {
      action: 'campaign.deal_scope_set',
      firm_id: session.firm_id,
      target_type: 'campaign',
      target_id: id,
      metadata: {
        line_count: body.lines.length,
        delivery_window_days: body.delivery_window_days,
        lines: body.lines,
      },
    },
    req,
  );

  const standing = await resolveOfferDeliverables(admin, { campaignId: id });
  const spec = await resolveCampaignSpec(admin, { campaignId: id, standing });
  return NextResponse.json({ lines: inserted, in_force: spec });
}
