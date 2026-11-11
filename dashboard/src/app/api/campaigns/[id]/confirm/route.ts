// src/app/api/campaigns/[id]/confirm/route.ts
//
// Pre-run confirmation. The campaign must be confirmed before the
// pipeline route will run it. Body lets the user override per-campaign:
//   - per_creator_cap_usd / total_budget_usd
//   - scraping_overrides (genres, follower bounds, region, ...)
//   - outreach_overrides (tone, signoff, ...)
//
// Sets confirmed_at to lock the run gate. Re-confirm overwrites (so the
// review-loop is "edit → re-confirm").
//
// MONEY: confirming is what arms a campaign to run, negotiate and pay, so it
// REQUIRES both enforced ceilings (total_budget_usd and per_creator_cap_usd)
// to be present and positive — merged over whatever the row already has, since
// the body is all-optional. Missing → 412 campaign_caps_required naming the
// offending column. Migration 037 mirrors the same rule as a DB constraint.
import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAndClient } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { soundchartsConfigured, captureArtistBaseline } from '@/lib/soundcharts';
import { campaignCapsConfigured } from '@/lib/spend-caps';
import { isMissingColumnError } from '@/lib/holding-note';
import { z } from 'zod';

export const runtime = 'nodejs';

const Body = z.object({
  per_creator_cap_usd: z.number().positive().optional(),
  total_budget_usd: z.number().positive().optional(),
  scraping_overrides: z.unknown().optional(),
  outreach_overrides: z.unknown().optional(),
  // Migration 036 — Soundcharts artist UUID from the confirmation picker.
  // Permissive string on purpose (see CreateCampaignBody).
  artist_soundcharts_uuid: z.string().min(8).max(128).optional().nullable(),
  // Migration 060 — most creators to contact; null clears it (no limit).
  // Absent = leave the stored value alone, so pre-060 confirms are unchanged.
  outreach_limit: z.number().int().positive().max(100_000).optional().nullable(),
});

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx) {
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
  const { id } = await ctx.params;
  const body = await readJson(req, Body);
  if (body instanceof NextResponse) return body;

  // Verify firm onboarding is complete.
  const { data: firm } = await sb
    .from('firms')
    .select('onboarding_completed_at')
    .eq('id', session.firm_id)
    .single();
  if (!firm || !(firm as { onboarding_completed_at: string | null }).onboarding_completed_at) {
    return NextResponse.json(
      {
        error: 'onboarding_required',
        message: 'Complete /onboarding before confirming a campaign.',
      },
      { status: 412 }
    );
  }

  // Current caps, to merge the (all-optional) body against. Migration-009
  // columns only — the attribution read below stays separate and best-effort
  // so it keeps degrading to null pre-migration-036 instead of 404-ing here.
  const { data: stored } = await sb
    .from('campaigns')
    .select('total_budget_usd, per_creator_cap_usd')
    .eq('id', id)
    .eq('firm_id', session.firm_id)
    .maybeSingle();
  if (!stored) {
    return NextResponse.json({ error: 'campaign_not_found' }, { status: 404 });
  }
  const storedRow = stored as {
    total_budget_usd: unknown;
    per_creator_cap_usd: unknown;
  };

  const updates: Record<string, unknown> = {
    confirmed_at: new Date().toISOString(),
  };
  if (body.per_creator_cap_usd !== undefined) updates.per_creator_cap_usd = body.per_creator_cap_usd;
  if (body.total_budget_usd !== undefined) updates.total_budget_usd = body.total_budget_usd;
  if (body.scraping_overrides !== undefined) updates.scraping_overrides = body.scraping_overrides;
  if (body.outreach_overrides !== undefined) updates.outreach_overrides = body.outreach_overrides;
  if (body.outreach_limit !== undefined) updates.outreach_limit = body.outreach_limit;

  // MONEY GATE — confirming is what arms a campaign to run, negotiate and pay.
  // Refuse to arm one whose enforced ceilings are missing.
  //
  // This body has always been all-optional, and the route wrote only the keys
  // it was given — so confirming without touching the cap fields left
  // total_budget_usd / per_creator_cap_usd NULL. src/lib/spend-caps.ts now
  // fails CLOSED on that state, which means the campaign would run all the way
  // to a payout before refusing. Catch it here, where the operator can still
  // fix it in the form, and name exactly which ceiling is missing.
  const caps = campaignCapsConfigured({
    total_budget_usd: updates.total_budget_usd ?? storedRow.total_budget_usd,
    per_creator_cap_usd: updates.per_creator_cap_usd ?? storedRow.per_creator_cap_usd,
  });
  if (!caps.ok) {
    return NextResponse.json(
      {
        error: 'campaign_caps_required',
        missing: caps.missing,
        message:
          `Set a positive ${caps.missing.join(' and ')} before confirming. ` +
          'A campaign with no enforceable ceiling cannot pay a creator.',
      },
      { status: 412 }
    );
  }

  // ── Artist attribution seam (migration 036) ──────────────────────────────
  // A uuid in the body is an explicit (re-)confirmation of the artist and
  // recaptures the baseline. Absent from the body, we fall back to the uuid
  // stored at campaign create (the new-campaign picker) — but only capture a
  // baseline if none exists yet, so a plain re-confirm never moves the
  // attribution anchor. No uuid anywhere → today's behavior, unchanged.
  // Baseline capture never throws and never blocks the confirm; the read
  // below degrades to null pre-migration (columns missing → error → null).
  let baselineCaptured = false;
  const bodyUuid = body.artist_soundcharts_uuid ?? null;
  let effectiveUuid = bodyUuid;
  let hasExistingBaseline = false;
  if (!effectiveUuid) {
    const { data: attribution } = await sb
      .from('campaigns')
      .select('artist_soundcharts_uuid, artist_baseline')
      .eq('id', id)
      .eq('firm_id', session.firm_id)
      .maybeSingle();
    const s = attribution as {
      artist_soundcharts_uuid: string | null;
      artist_baseline: unknown;
    } | null;
    effectiveUuid = s?.artist_soundcharts_uuid ?? null;
    hasExistingBaseline = s?.artist_baseline != null;
  }
  if (effectiveUuid && (bodyUuid || !hasExistingBaseline)) {
    if (bodyUuid) {
      updates.artist_soundcharts_uuid = bodyUuid;
      updates.artist_confirmed_source = 'soundcharts';
    }
    if (soundchartsConfigured()) {
      updates.artist_baseline = await captureArtistBaseline(effectiveUuid);
      baselineCaptured = true;
    }
  }

  const { data, error } = await sb
    .from('campaigns')
    .update(updates as never)
    .eq('id', id)
    .eq('firm_id', session.firm_id)
    .select()
    .single();
  if (error) {
    // A limit sent to a pre-060 database: nothing was saved, say why.
    if (body.outreach_limit !== undefined && isMissingColumnError(error)) {
      return NextResponse.json(
        {
          error: 'outreach_limit_unavailable',
          message: "Max creators to contact isn't available yet. Clear that field and confirm again.",
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await audit(
    {
      action: 'campaign.confirmed',
      target_type: 'campaign',
      target_id: id,
      firm_id: session.firm_id,
      metadata: {
        per_creator_cap_usd: body.per_creator_cap_usd,
        total_budget_usd: body.total_budget_usd,
        had_scraping_overrides: !!body.scraping_overrides,
        had_outreach_overrides: !!body.outreach_overrides,
        artist_soundcharts_uuid: effectiveUuid,
        artist_baseline_captured: baselineCaptured,
        ...(body.outreach_limit !== undefined ? { outreach_limit: body.outreach_limit } : {}),
      },
    },
    req
  );
  return NextResponse.json(data);
}
