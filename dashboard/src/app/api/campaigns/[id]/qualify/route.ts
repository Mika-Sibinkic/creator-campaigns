// src/app/api/campaigns/[id]/qualify/route.ts
//
// POST — batch/paginated qualification over a campaign's UNREVIEWED creators
// (the pipeline's in-run pass only ever covers the top 25 ranked, leaving
// most of a large pool unreviewed; qualifying on demand at draft time closes
// the dangerous half, but verdicts would still never appear in the ranked list BEFORE someone clicked Generate).
//
// Each call processes one bounded batch, highest composite_score first, and
// is idempotent — rows leave the 'unreviewed' set as verdicts persist, so
// repeated calls walk the backlog to zero. Per call:
//
//   1. The per-firm pool gates (follower cap + audience-fit minimum from
//      firms.scraping_prefs) and the deterministic qualify
//      pre-checks (no posts / abandoned / music-artist bio signals — §2)
//      decide for free, no model calls.
//   2. The remainder gets ONE qualifyCreator() LLM call each, capped at
//      QUALIFY_LLM_CAP calls and QUALIFY_TIME_BUDGET_MS per invocation —
//      the same cost posture as the pipeline's in-run pass. Model access is
//      only ever via src/lib/model-provider complete() inside qualify.ts.
//
// SEC-1: USER PATH — cookie-bound client; the .eq('firm_id', session.firm_id)
// campaign lookup is the authorization boundary. recordApiCall keeps service
// role internally (api_ledger is a system audit table).

import { NextRequest, NextResponse } from "next/server";
import { requireSessionAndClient } from "@/lib/auth";
import { checkFirmScope } from "@/lib/firm-scope";
import { audit } from "@/lib/audit";
import { recordApiCall } from "@/lib/api-ledger";
import { tieredLimit, rateLimited } from "@/lib/rate-limit";
import {
  qualifyCreator,
  statusForVerdict,
  type QualifyRawPost,
} from "@/lib/qualify";
import {
  audienceFitOf,
  gateExclusionPatch,
  poolGateExclusion,
  resolvePoolGatePrefs,
} from "@/lib/pool-gates";
import { readFirmBlocks } from "@/lib/firm-blocks";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Rows fetched per invocation (deterministic gates are free, so this can
 *  exceed the LLM cap — gated rows don't consume model budget). */
const QUALIFY_BATCH_MAX = 50;
/** Model calls per invocation — mirrors the pipeline's in-run cap. */
const QUALIFY_LLM_CAP = 25;
/**
 * Wall-clock ceiling per invocation. Checked BEFORE each row, so the true
 * worst case is this budget plus one slow model call — which is why it sits
 * well under maxDuration (60s) rather than near it. At 45s one slow row could
 * carry the handler past 60s and take the ledger write with it.
 */
const QUALIFY_TIME_BUDGET_MS = 30_000;

/**
 * Campaigns with a batch in flight in THIS instance.
 *
 * Two dashboard tabs both hitting Screen select the same top-50 unreviewed
 * rows and both pay for the same model calls. A real claim needs a lease
 * column on campaign_influencers, which is a migration of its own, so this
 * is deliberately the weaker guard: it
 * removes the common case (one user, two tabs, one lambda) and does nothing
 * across instances. The `expensive` rate limit remains the real spend bound.
 */
const inFlight = new Set<string>();
/** Static per-call estimate, same figure the pipeline budgets with. */
const QUALIFY_COST_PER_CALL_USD = 0.001;

interface Ctx {
  params: Promise<{ id: string }>;
}

type CiRow = {
  id: string;
  influencer_id: string;
  composite_score: number | null;
  score_breakdown: unknown;
  influencer: {
    id: string;
    username: string;
    display_name: string | null;
    bio: string | null;
    follower_count: number | null;
    engagement_rate: number | null;
    verified: boolean | null;
    blocklisted: boolean | null;
    raw_data: { posts?: QualifyRawPost[] } | null;
  } | null;
};

export async function POST(req: NextRequest, ctx: Ctx) {
  // Model spend on every call → expensive tier.
  const limit = tieredLimit(req, "expensive");
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  const { id: campaignId } = await ctx.params;
  let sb, session;
  try {
    ({ sb, session } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }

  // Firm-ownership gate for the whole route.
  //
  // Via checkFirmScope rather than an .eq('firm_id', session.firm_id) filter.
  // The filter did fail closed, but by accident: an unprovisioned caller
  // carries firm_id '', and `.eq('firm_id', '')` throws a Postgres 22P02 uuid
  // cast error that happens to land in this 404. checkFirmScope makes a blank
  // firm id on either side a denial by construction instead of a coincidence.
  const { data: campaign, error: cErr } = await sb
    .from("campaigns")
    .select("id, firm_id, artist_name, track_name, artist_data")
    .eq("id", campaignId)
    .single();
  if (cErr || !campaign) {
    return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
  }
  const scope = checkFirmScope(
    session.firm_id,
    (campaign as { firm_id: string | null }).firm_id
  );
  if (!scope.ok) {
    // 404, not 403: a caller outside the firm learns nothing about whether
    // this campaign id exists.
    return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
  }
  const cmp = campaign as {
    id: string;
    firm_id: string;
    artist_name: string;
    track_name: string | null;
    artist_data: Record<string, unknown> | null;
  };
  const genre =
    typeof cmp.artist_data?.genre === "string" ? cmp.artist_data.genre : null;

  // Per-firm pool gates.
  const { data: firmRow } = await sb
    .from("firms")
    .select("scraping_prefs")
    .eq("id", cmp.firm_id)
    .single();
  const gatePrefs = resolvePoolGatePrefs(
    (firmRow as { scraping_prefs?: unknown } | null)?.scraping_prefs
  );

  // One batch of unreviewed, non-bot rows, best-ranked first. Bot-flagged
  // rows are already un-draftable (eligibleDraftFilter), so no model budget
  // is spent deciding them.
  const { data: ciRowsRaw, error: ciErr } = await sb
    .from("campaign_influencers")
    .select(
      "id, influencer_id, composite_score, score_breakdown, " +
        "influencer:influencers(id, username, display_name, bio, follower_count, engagement_rate, verified, blocklisted, raw_data)"
    )
    .eq("campaign_id", campaignId)
    .eq("qualification_status", "unreviewed")
    .eq("bot_flagged", false)
    .order("composite_score", { ascending: false, nullsFirst: false })
    .limit(QUALIFY_BATCH_MAX);
  if (ciErr) {
    return NextResponse.json({ error: ciErr.message }, { status: 500 });
  }
  const ciRows = ((ciRowsRaw ?? []) as unknown[]).map((r) => {
    const row = r as Omit<CiRow, "influencer"> & { influencer: unknown };
    const inf = Array.isArray(row.influencer)
      ? (row.influencer[0] ?? null)
      : row.influencer;
    return { ...row, influencer: inf } as CiRow;
  });

  // This label's own blocks (migration 056). Unreadable → global flag only,
  // logged: this pass persists exclusions, and the send paths fail closed.
  const firmBlocks = await readFirmBlocks(
    sb,
    cmp.firm_id,
    ciRows.map((r) => r.influencer_id)
  );
  if (firmBlocks.state === "unreadable") {
    console.error("[qualify] firm block list unreadable — gating on the global flag only", firmBlocks.message);
  }

  if (inFlight.has(campaignId)) {
    return NextResponse.json(
      {
        error: "already_screening",
        message:
          "A screening pass for this campaign is already running. Wait for it to finish rather than paying for the same creators twice.",
      },
      { status: 409 }
    );
  }
  inFlight.add(campaignId);

  const startMs = Date.now();
  let processed = 0;
  let excluded = 0;
  let gateExcluded = 0;
  let qualified = 0;
  let llmCalls = 0;
  let timeoutHit = false;

  try {
  for (const ci of ciRows) {
    if (Date.now() - startMs > QUALIFY_TIME_BUDGET_MS) {
      timeoutHit = true;
      break;
    }
    const inf = ci.influencer;
    if (!inf) continue;
    processed += 1;

    let patch: {
      qualification_status: string;
      qualification_reason: string;
      qualification_confidence: number;
    } | null = null;

    // 1. Deterministic per-firm gates — free.
    const gate = poolGateExclusion(
      {
        followers: inf.follower_count,
        audience_fit: audienceFitOf(ci.score_breakdown),
        blocklisted: inf.blocklisted === true || firmBlocks.ids.has(inf.id),
      },
      gatePrefs
    );
    if (gate) {
      patch = gateExclusionPatch(gate);
      gateExcluded += 1;
    } else {
      // 2. Qualification — deterministic pre-checks first, then one model
      //    call while the per-invocation cap holds. Never throws; fails
      //    open to 'unreviewed'.
      const verdict = await qualifyCreator(
        {
          username: inf.username,
          display_name: inf.display_name,
          bio: inf.bio,
          followers: inf.follower_count,
          engagement_rate: inf.engagement_rate,
          verified: inf.verified,
          raw_data: inf.raw_data,
          campaign: {
            artist_name: cmp.artist_name,
            track_name: cmp.track_name,
            genre,
          },
        },
        {
          enableLlm: llmCalls < QUALIFY_LLM_CAP,
          excludeMusicArtists: gatePrefs.exclude_music_artists,
          onLlmCall: () => {
            llmCalls += 1;
          },
        }
      );
      const status = statusForVerdict(verdict);
      if (status === "unreviewed") continue; // stays in the backlog
      patch = {
        qualification_status: status,
        qualification_reason: verdict.reason,
        qualification_confidence: verdict.confidence,
      };
    }

    if (patch.qualification_status === "excluded") excluded += 1;
    else qualified += 1;
    const { error: upErr } = await sb
      .from("campaign_influencers")
      .update(patch as never)
      .eq("id", ci.id);
    if (upErr) {
      console.error("[qualify-batch] persist failed", inf.username, upErr.message);
    }
  }

  } finally {
    // In `finally` so spend is never unrecorded. It used to run only after a
    // clean loop: any throw mid-batch meant model calls had been paid for
    // with no api_ledger row to show for them.
    inFlight.delete(campaignId);
    if (llmCalls > 0) {
      await recordApiCall({
        campaign_id: campaignId,
        source: "openai",
        endpoint: "qualify-batch",
        cost_usd: llmCalls * QUALIFY_COST_PER_CALL_USD,
        records_returned: processed,
        latency_ms: Date.now() - startMs,
      }).catch((e) =>
        console.error("[qualify-batch] ledger write failed", (e as Error).message)
      );
    }
  }
  const costUsd = llmCalls * QUALIFY_COST_PER_CALL_USD;

  // How much backlog is left (same filters as the batch query).
  const { count: remaining } = await sb
    .from("campaign_influencers")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("qualification_status", "unreviewed")
    .eq("bot_flagged", false);

  await audit(
    {
      action: "qualification.batch",
      target_type: "campaign",
      target_id: campaignId,
      firm_id: session.firm_id,
      metadata: {
        processed,
        excluded,
        gate_excluded: gateExcluded,
        qualified,
        llm_calls: llmCalls,
        llm_cap: QUALIFY_LLM_CAP,
        est_cost_usd: costUsd,
        remaining: remaining ?? null,
        timeout_hit: timeoutHit,
        gate_prefs: {
          follower_max: gatePrefs.follower_max,
          audience_fit_min: gatePrefs.audience_fit_min,
          exclude_music_artists: gatePrefs.exclude_music_artists,
        },
      },
    },
    req
  );

  return NextResponse.json({
    processed,
    excluded,
    gate_excluded: gateExcluded,
    qualified,
    llm_calls: llmCalls,
    cost_usd: costUsd,
    remaining: remaining ?? 0,
    timeout_hit: timeoutHit,
  });
}
