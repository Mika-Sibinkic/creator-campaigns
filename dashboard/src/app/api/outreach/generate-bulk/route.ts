// src/app/api/outreach/generate-bulk/route.ts
//
// requireSessionAndClient() returns the SERVICE-ROLE client, so RLS does not
// scope the campaign; campaignInFirm (src/lib/outreach-scope.ts) does, before
// the target query and any model spend.
//
// This route is the /outreach page's "Generate All Drafts" button. It used
// to run an unguarded second generator AND ignored
// qualification_status entirely, so venues, business pages, abandoned
// accounts and bots the qualification pass had excluded stayed pitchable from
// this screen even though /campaigns/[id]/draft-all skipped them. It now
// shares one eligibility filter (eligibleDraftFilter) with the per-row gate
// in src/lib/outreach.ts, and every draft goes through the hardened path.
import { NextRequest, NextResponse } from "next/server";
import { requireSessionAndClient } from "@/lib/auth";
import {
  DraftRefusedError,
  draftPoolFilter,
  eligibleDraftFilter,
  generateOutreachMessage,
  saveOutreachMessage,
} from "@/lib/outreach";
import {
  openerSlots,
  pickOpenerTargets,
  readCampaignContacts,
  readOutreachLimit,
} from "@/lib/first-touch-gate";
import { campaignInFirm } from "@/lib/outreach-scope";
import { readHeldCampaignInfluencerIds } from "@/lib/comment-audit-store";
import { tieredLimit, rateLimited } from "@/lib/rate-limit";
import { readJson } from "@/lib/validate";
import { GenerateOutreachBulkBody } from "@/lib/zod-schemas";

export const runtime = 'nodejs';
export const maxDuration = 300;

type BulkResult = {
  campaign_influencer_id: string;
  status: "generated" | "skipped" | "failed";
  message_id?: string;
  error?: string;
  reason_code?: string;
};

export async function POST(req: NextRequest) {
  // OpenAI fan-out → expensive tier.
  const limit = tieredLimit(req, 'expensive');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  let sb, session;
  try {
    ({ sb, session } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }
  const body = await readJson(req, GenerateOutreachBulkBody);
  if (body instanceof NextResponse) return body;
  const { campaign_id, tier_filter, message_type, channel, custom_instructions } = body;

  // Tenant gate: sb is service-role, so nothing else stops a caller drafting
  // (and paying the model for) another label's whole campaign. 404, not 403.
  if (!(await campaignInFirm(sb, campaign_id, session.firm_id))) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  // The draft pool: eligible creators (not a bot, not excluded) who
  // have had no message yet.
  //
  // This used to be `.in("outreach_status", ["pending"])`. Discovery never
  // writes the column (api/campaigns/[id]/run/route.ts:743-757) — every
  // freshly discovered creator gets whatever the DB default is, and this
  // project has two: live Supabase defaults to 'pending', the checked-in
  // supabase/schema.sql:97 defaults to 'none'. Pinning the pool to one
  // spelling meant "Generate All Drafts" returned 0 against the other, and
  // missed legacy NULL rows on both. noMessageYetFilter covers all of them —
  // `.in()` cannot, because SQL IN never matches NULL.
  let query = draftPoolFilter(
    sb
      .from("campaign_influencers")
      .select("id, tier, outreach_status, bot_flagged, qualification_status, composite_score")
      .eq("campaign_id", campaign_id)
  );

  if (tier_filter && tier_filter !== "all") {
    query = query.eq("tier", tier_filter);
  }

  const { data: pool, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Mini-run (campaigns.outreach_limit, migration 060): at most the limit's
  // remaining slots, highest composite score first. A slot is used by a
  // creator already contacted or already holding an unsent draft. No limit
  // (or pre-060): every eligible creator, as before, now in score order.
  // An opener is the only draft that can START a contact; a follow-up type
  // here is still drafted to the same pool, so the same slots apply.
  const outreachLimit = await readOutreachLimit(sb, campaign_id);
  if (outreachLimit.state === "unreadable") {
    return NextResponse.json(
      {
        error: "outreach_limit_unreadable",
        message: "Couldn't read this campaign's outreach limit, so nothing was drafted. Try again in a minute.",
      },
      { status: 503 }
    );
  }
  const limitN = outreachLimit.state === "ok" ? outreachLimit.limit : null;
  let slots: number | null = null;
  if (limitN != null) {
    const contacts = await readCampaignContacts(sb, campaign_id);
    const { data: drafted, error: dErr } = await eligibleDraftFilter(
      sb
        .from("campaign_influencers")
        .select("id")
        .eq("campaign_id", campaign_id)
        .eq("outreach_status", "draft_ready")
    );
    if (!contacts.ok || dErr) {
      return NextResponse.json(
        {
          error: "outreach_limit_unreadable",
          message: "Couldn't count who this campaign has contacted, so nothing was drafted. Try again in a minute.",
        },
        { status: 503 }
      );
    }
    const used = new Set(contacts.contactedIds);
    for (const r of (drafted ?? []) as { id: string }[]) used.add(r.id);
    slots = openerSlots(limitN, used);
  }
  // Comment hold (migration 066): held creators are not drafted until a human
  // overrides. Unreadable → logged, drafted as before; the send gate
  // (first-touch-gate.ts) refuses a held creator regardless.
  const heldIds = await readHeldCampaignInfluencerIds(sb, campaign_id);
  if (heldIds == null) {
    console.error("[generate-bulk] comment holds unreadable; drafting without them, the send gate still refuses held creators");
  }
  const targets = pickOpenerTargets(
    ((pool ?? []) as { id: string; composite_score: number | null }[]).filter((r) => !heldIds?.has(r.id)),
    slots
  );

  if (targets.length === 0) {
    return NextResponse.json({
      generated: 0,
      message:
        slots === 0 && (pool ?? []).length > 0
          ? `This campaign's limit is ${limitN} creators, and that many already have a draft or have been contacted.`
          : "No eligible influencers found",
    });
  }

  // Generate in batches of 5 to avoid rate limits
  const BATCH_SIZE = 5;
  const results: BulkResult[] = [];

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (ci): Promise<BulkResult> => {
        const message = await generateOutreachMessage({
          sb,
          campaign_influencer_id: ci.id,
          message_type: message_type || "initial",
          channel,
          custom_instructions,
        });
        const messageId = await saveOutreachMessage(sb, ci.id, message, message_type || "initial");
        return { campaign_influencer_id: ci.id, status: "generated", message_id: messageId };
      })
    );

    // Index-aligned with `batch` — Promise.allSettled preserves order. (The
    // previous `batch[results.length % batch.length]` attributed failures to
    // whichever creator that arithmetic happened to land on.)
    batchResults.forEach((result, idx) => {
      const ciId = batch[idx]?.id ?? "unknown";
      if (result.status === "fulfilled") {
        results.push(result.value);
        return;
      }
      const reason = result.reason;
      // A refusal is not a failure: the system declined to write to a creator
      // it must not contact. Surface it separately so a run of skips doesn't
      // read as an outage.
      if (reason instanceof DraftRefusedError) {
        results.push({
          campaign_influencer_id: ciId,
          status: "skipped",
          reason_code: reason.refusal.reason_code,
          error: reason.refusal.message,
        });
        return;
      }
      results.push({
        campaign_influencer_id: ciId,
        status: "failed",
        error: reason instanceof Error ? reason.message : "Unknown error",
      });
    });
  }

  const generated = results.filter((r) => r.status === "generated").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;

  return NextResponse.json({
    generated,
    skipped,
    failed,
    total: targets.length,
    results,
  });
}
