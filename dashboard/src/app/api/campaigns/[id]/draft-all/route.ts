// src/app/api/campaigns/[id]/draft-all/route.ts
//
// Personalized outreach drafts for the top-scored creators of a campaign.
//
// DRAFT VOLUME = GOAL × FUNNEL_INVERSE, not a magic 20. Draft as many
// outreach messages as the campaign needs to hit its conversion target,
// not a fixed cap.
//
// Volume math:
//   target_count            = campaigns.target_count
//                             ?? firm.campaign_defaults.target_count ?? 20
//   expected_deal_rate      = campaigns.outreach_overrides.expected_deal_rate
//                             ?? firm.outreach_prefs.expected_deal_rate
//                             ?? firm.campaign_defaults.expected_deal_rate
//                             ?? 0.06   (6%, conservative funnel default)
//   wanted_drafts           = ceil(target_count / expected_deal_rate)
//   actual_drafts           = min(wanted_drafts, eligible_pool_size)
//
// Drafts are bounded by pool, NOT by budget — drafts are ~$0.01 each, and
// the real-money ceiling lives in payment_authorizations + the per-campaign
// total_budget_usd cap. Over-drafting on a generous pool is fine; under-
// paying is what the negotiation+approval gate enforces. Budget pacing of
// who actually gets CONTACTED is enforced at send (src/lib/first-touch-gate.ts).
//
// MINI-RUN. A campaign with outreach_limit N (migration 060)
// drafts at most N openers in total, highest composite score first; see
// the slots block below.
//
// Idempotent: campaign_influencers that already have an `initial`-type
// outreach_messages row are SKIPPED so a re-run of /draft-all only fills
// the gap, not 2× the count.
//
// CHARGE ON OUTPUT, NOT ON ATTEMPT.
// The cap CHECK still happens before every model call (and now also counts
// in-flight reservations, so concurrent workers cannot both clear the same
// headroom). The CHARGE moved to after the call and only lands when the model
// actually returned something. The old order — charge, then call — let a
// provider 429 storm spend the entire cap while producing almost no
// drafts: every failed call was billed as if it had worked, and
// the worker loop never looked at the result. Drafts that degrade to
// deterministic copy are written with generation_model='deterministic-fallback'
// and surfaced as `fallback_drafts` in the response.
//
// User path. Uses the service-role client, so the firm_id filter on the
// campaign read is the firm boundary.
//
// Live-schema adaptations vs. the plan source:
//   - campaign_influencers uses `composite_score`, not `score`.
//   - outreach_messages has `message_type`, not `type`.
//   - firms.outreach_prefs (jsonb) supersedes voice_profile from
//     migration 009; we read both with outreach_prefs winning.
import { NextResponse } from "next/server";
import { requireSessionAndClient } from "@/lib/auth";
import { envNumber } from "@/lib/env";
import {
  generateOutreachDraft,
  FALLBACK_DRAFT_MODEL,
  FALLBACK_DRAFT_TEMPLATE,
  MODEL_DRAFT_TEMPLATE,
} from "@/lib/openai";
import { activeModelLabel } from "@/lib/model-provider";
import { resolvePersonality } from "@/lib/personality";
import { tieredLimit, rateLimited } from "@/lib/rate-limit";
import { outreachDispatchFields } from "@/lib/social-dispatch";
import {
  audienceFitOf,
  gateExclusionPatch,
  poolGateExclusion,
  resolvePoolGatePrefs,
} from "@/lib/pool-gates";
import { readFirmBlocks } from "@/lib/firm-blocks";
import { readHeldCampaignInfluencerIds } from "@/lib/comment-audit-store";
import { eligibleDraftFilter } from "@/lib/outreach";
import {
  openerSlots,
  pickOpenerTargets,
  readCampaignContacts,
  readOutreachLimit,
} from "@/lib/first-touch-gate";

export const runtime = "nodejs";
export const maxDuration = 300;

// Conservative funnel default until the RL pricing loop has enough
// campaign_outcomes data to derive a per-firm-per-genre rate. A planning
// estimate, not a measurement (1900 raw → 280 scored → 170 outreach → 50
// negotiations → 10 deals → ~6% deal-rate from outreach).
const DEFAULT_EXPECTED_DEAL_RATE = 0.06;
const DEFAULT_TARGET_COUNT = 20;

// INF-6-style cost ceiling for THIS route. The discovery pipeline cap
// ($1 OpenAI) only applies to /api/campaigns/[id]/run. Draft generation
// is on a separate budget. Default $5 covers ~500 personalized drafts
// (each ~$0.01). Override via env per environment if a campaign
// legitimately needs more.
const DRAFT_OPENAI_USD_CAP = envNumber(process.env.DRAFT_OPENAI_USD_CAP, 5);
// Concurrency for the OpenAI fan-out. Vercel maxDuration is 300s; with
// each draft taking ~2-3s, 5-way concurrency gives us ~250 drafts in
// budget before we hit the timeout. Higher concurrency would help for
// bigger campaigns but risks bumping OpenAI org-tier RPM limits.
// 2, not 5: the draft path now makes up to ~4 model calls per creator
// (provenance guard + generation retry), and a free-tier provider (e.g.
// Gemini) has a tight per-minute quota: 5-way concurrency drains it and
// 429-fails entire batches. Idempotent re-runs pick up where a run stops.
const DRAFT_CONCURRENCY = 2;
// Soft wall-clock cap so the function returns cleanly before Vercel
// kills it at 300s. Leaves ~30s headroom for the response + audit writes.
const DRAFT_TIMEOUT_MS = 270_000;

interface Ctx {
  params: Promise<{ id: string }>;
}

const DEFAULT_FIRM_VOICE =
  "Warm, specific, no buzzwords. Reference the creator's actual recent posts. " +
  "Soft ask for a paid creator post. 4-6 lines. No exclamation points. " +
  "No 'I hope this finds you well'.";

// Defensive shape for Apify TikTok post payloads we persist into
// influencers.raw_data.posts (see C3 normalization).
type RawPost = {
  text?: string;
  playCount?: number;
  hashtags?: { name?: string }[];
  createTimeISO?: string;
};

type InfluencerRow = {
  id: string;
  username: string;
  platform: string | null;
  contact_email: string | null;
  bio: string | null;
  raw_data: { posts?: RawPost[] } | null;
};

type CiRow = {
  id: string;
  influencer_id: string;
  composite_score: number | null;
  score_breakdown: unknown;
  primary_channel: string | null;
};

type CampaignRow = {
  id: string;
  firm_id: string;
  artist_name: string;
  track_name: string | null;
  release_date: string | null;
  target_count: number | null;
  outreach_overrides: { expected_deal_rate?: number } | null;
};

type FirmRow = {
  id: string;
  voice_profile: unknown;
  outreach_prefs: { voice?: string; tone?: string; personality?: string; expected_deal_rate?: number } | null;
  campaign_defaults: { target_count?: number; expected_deal_rate?: number } | null;
  scraping_prefs: unknown;
};

export async function POST(_req: Request, ctx: Ctx) {
  // SEC-2: GPT-4o fan-out → expensive tier.
  const limit = tieredLimit(_req, 'expensive');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  const { id: campaignId } = await ctx.params;
  let sb: Awaited<ReturnType<typeof requireSessionAndClient>>['sb'];
  let session: Awaited<ReturnType<typeof requireSessionAndClient>>['session'];
  try {
    ({ sb, session } = await requireSessionAndClient());
  } catch (r) {
    return r as Response;
  }

  // --- 1. Load campaign (incl. target_count + outreach_overrides) ---
  const { data: campaign, error: campErr } = await sb
    .from("campaigns")
    .select(
      "id, firm_id, artist_name, track_name, release_date, target_count, outreach_overrides"
    )
    .eq("id", campaignId)
    .eq("firm_id", session.firm_id)
    .single();
  if (campErr || !campaign) {
    return NextResponse.json(
      { error: "campaign not found", detail: campErr?.message },
      { status: 404 }
    );
  }
  const cmp = campaign as unknown as CampaignRow;

  // --- 2. Load firm voice + funnel defaults ---
  const { data: firm } = await sb
    .from("firms")
    .select("id, voice_profile, outreach_prefs, campaign_defaults, scraping_prefs")
    .eq("id", cmp.firm_id)
    .single();
  const f = firm as unknown as FirmRow | null;

  // Voice resolution: outreach_prefs (onboarding) wins, falls back to
  // legacy voice_profile, then to the constant default.
  let firmVoice = DEFAULT_FIRM_VOICE;
  if (f?.outreach_prefs && typeof f.outreach_prefs === 'object') {
    const op = f.outreach_prefs as Record<string, unknown>;
    if (typeof op.voice === 'string' && op.voice.length > 0) firmVoice = op.voice;
    else if (typeof op.tone === 'string' && op.tone.length > 0) firmVoice = op.tone;
  } else if (f?.voice_profile && typeof f.voice_profile === 'object') {
    const vp = f.voice_profile as Record<string, unknown>;
    if (typeof vp.tone === 'string' && vp.tone.length > 0) firmVoice = vp.tone;
  }

  // Personality voice dial: firm setting → env → default.
  const personality = resolvePersonality(
    typeof f?.outreach_prefs?.personality === 'string' ? f.outreach_prefs.personality : undefined,
  );

  // --- 3. Compute the volume target from goal × funnel ---
  const targetCount =
    cmp.target_count ??
    f?.campaign_defaults?.target_count ??
    DEFAULT_TARGET_COUNT;
  const expectedDealRate =
    cmp.outreach_overrides?.expected_deal_rate ??
    f?.outreach_prefs?.expected_deal_rate ??
    f?.campaign_defaults?.expected_deal_rate ??
    DEFAULT_EXPECTED_DEAL_RATE;
  const wantedDrafts = Math.max(1, Math.ceil(targetCount / expectedDealRate));

  // --- 4. Identify the eligible undrafted pool ---
  // Two-step (per A5 synthetic-filter pattern): first non-synthetic
  // influencer ids, then campaign_influencers in that set ordered by
  // composite_score.
  const { data: realInfsRaw } = await sb
    .from("influencers")
    .select("id")
    .eq("synthetic", false);
  const realIds = ((realInfsRaw ?? []) as { id: string }[]).map((r) => r.id);
  if (realIds.length === 0) {
    return NextResponse.json({
      drafted: 0,
      failed: 0,
      cost_usd: 0,
      target_count: targetCount,
      expected_deal_rate: expectedDealRate,
      wanted_drafts: wantedDrafts,
      pool_size: 0,
      already_drafted: 0,
      note: "No creators found yet. Run discovery first.",
    });
  }

  // Already-drafted ci_ids (idempotency).
  const { data: existingDrafts } = await sb
    .from("outreach_messages")
    .select("campaign_influencer_id")
    .eq("message_type", "initial");
  const existingCiIds = new Set(
    ((existingDrafts ?? []) as { campaign_influencer_id: string }[]).map(
      (r) => r.campaign_influencer_id
    )
  );

  // Full eligible pool ordered by composite_score. Creators the
  // qualification pass excluded (venue/business/abandoned/bot)
  // keep their rows but never enter the draft pool. eligibleDraftFilter is the
  // same filter generate-bulk and the per-row gate use: this query used to
  // apply only the `excluded` half, so a bot_flagged creator the scorer had
  // flagged still got a draft here (and nowhere else).
  const { data: ciRowsRaw, error: ciErr } = await eligibleDraftFilter(
    sb
      .from("campaign_influencers")
      .select("id, influencer_id, composite_score, score_breakdown, primary_channel")
      .eq("campaign_id", campaignId)
      .in("influencer_id", realIds)
  ).order("composite_score", { ascending: false, nullsFirst: false });
  if (ciErr) {
    return NextResponse.json(
      { error: "failed to load campaign_influencers", detail: ciErr.message },
      { status: 500 }
    );
  }
  const allCiRows = (ciRowsRaw ?? []) as unknown as CiRow[];

  // Read-time pool-hygiene gates: the shared influencers
  // table still holds rows scraped before (or outside) this firm's caps, so
  // the firm's follower_max + audience_fit_min + blocklist are enforced HERE,
  // when candidates are read into the draft pool — not only at scrape time. A
  // gated row is persisted as excluded (inspectable reason, firm-scoped
  // campaign_influencers row) so it leaves the pool for good and shows up in
  // the qualification split rather than silently vanishing.
  //
  // Gated over the WHOLE pool, not just the undrafted part. Gating only the
  // undrafted rows left already-written drafts un-re-gated: drafts for
  // creators these gates rule out kept a working Send button. Screening the full set marks those excluded,
  // which is what the send path then refuses on.
  const gatePrefs = resolvePoolGatePrefs(f?.scraping_prefs);
  let gatedOut = 0;
  const gatedIds = new Set<string>();
  if (allCiRows.length > 0) {
    const { data: fcRows } = await sb
      .from("influencers")
      .select("id, follower_count, blocklisted")
      .in(
        "id",
        allCiRows.map((r) => r.influencer_id)
      );
    const infById = new Map(
      (
        (fcRows ?? []) as {
          id: string;
          follower_count: number | null;
          blocklisted: boolean | null;
        }[]
      ).map((r) => [r.id, r])
    );
    // This label's own blocks (migration 056). Unreadable → global flag only,
    // logged: this pass persists exclusions, and the send paths fail closed.
    const firmBlocks = await readFirmBlocks(
      sb,
      cmp.firm_id,
      allCiRows.map((r) => r.influencer_id)
    );
    if (firmBlocks.state === "unreadable") {
      console.error("[draft-all] firm block list unreadable — gating on the global flag only", firmBlocks.message);
    }
    for (const r of allCiRows) {
      const gate = poolGateExclusion(
        {
          followers: infById.get(r.influencer_id)?.follower_count ?? null,
          audience_fit: audienceFitOf(r.score_breakdown),
          blocklisted:
            infById.get(r.influencer_id)?.blocklisted === true ||
            firmBlocks.ids.has(r.influencer_id),
        },
        gatePrefs
      );
      if (!gate) continue;
      gatedIds.add(r.id);
      gatedOut += 1;
      // Best-effort persistence — the gate decision stands either way.
      const { error: gateErr } = await sb
        .from("campaign_influencers")
        .update(gateExclusionPatch(gate) as never)
        .eq("id", r.id);
      if (gateErr) {
        console.error(
          "[draft-all] gate exclusion persist failed",
          r.id,
          gateErr.message
        );
      }
    }
  }

  // Comment hold (migration 066): a held creator gets no opener until a human
  // overrides. Unreadable → logged, drafted as before; the send gate
  // (first-touch-gate.ts) refuses a held creator regardless.
  const heldIds = await readHeldCampaignInfluencerIds(sb, campaignId);
  if (heldIds == null) {
    console.error("[draft-all] comment holds unreadable; drafting without them, the send gate still refuses held creators");
  }
  const survivingCiRows = allCiRows.filter((r) => !gatedIds.has(r.id) && !heldIds?.has(r.id));
  const undraftedCiRows = survivingCiRows.filter((r) => !existingCiIds.has(r.id));
  const alreadyDrafted = survivingCiRows.length - undraftedCiRows.length;

  // Mini-run (campaigns.outreach_limit, migration 060): draft at most the
  // limit's remaining slots, highest composite score first. A slot is used by
  // a creator already contacted or already holding an opener draft, so a
  // limit of 10 yields 10 drafts, not a pool's worth. No limit (or pre-060):
  // unchanged. The send boundary enforces the limit regardless
  // (src/lib/first-touch-gate.ts); this keeps drafting from overshooting it.
  const outreachLimit = await readOutreachLimit(sb, campaignId);
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
  let draftable = undraftedCiRows;
  if (limitN != null) {
    const contacts = await readCampaignContacts(sb, campaignId);
    if (!contacts.ok) {
      return NextResponse.json(
        {
          error: "outreach_limit_unreadable",
          message: "Couldn't count who this campaign has contacted, so nothing was drafted. Try again in a minute.",
        },
        { status: 503 }
      );
    }
    const used = new Set(contacts.contactedIds);
    for (const r of survivingCiRows) if (existingCiIds.has(r.id)) used.add(r.id);
    slots = openerSlots(limitN, used);
    // A creator already contacted gets no second opener under a limit.
    draftable = undraftedCiRows.filter((r) => !contacts.contactedIds.has(r.id));
  }

  // Slice to wantedDrafts. If the pool is smaller, we draft everything
  // and the response surfaces that the goal can't be met from this pool
  // alone (caller's signal to widen scraping).
  const ciRows = pickOpenerTargets(draftable, slots).slice(0, wantedDrafts);
  const draftGoal = slots == null ? wantedDrafts : Math.min(wantedDrafts, slots);
  if (ciRows.length === 0) {
    return NextResponse.json({
      drafted: 0,
      failed: 0,
      cost_usd: 0,
      target_count: targetCount,
      expected_deal_rate: expectedDealRate,
      wanted_drafts: wantedDrafts,
      pool_size: allCiRows.length,
      already_drafted: alreadyDrafted,
      gated_out: gatedOut,
      outreach_limit: limitN,
      note:
        slots === 0 && draftable.length > 0
          ? `This campaign's limit is ${limitN} creators, and that many already have a draft or have been contacted. Raise the limit on the campaign's confirm page to draft more.`
          : undraftedCiRows.length === 0 && survivingCiRows.length > 0
          ? "all eligible creators in pool are already drafted (idempotent re-run)"
          : gatedOut > 0
            ? `every creator in this pool was excluded by this firm's pool gates (${gatedOut} blocklisted, over the follower cap, or outside the audience-fit band)`
            : "No eligible creators. Run discovery to fill the pool.",
    });
  }

  // --- 4. Load matching real (non-synthetic) influencers ---
  const ids = ciRows.map((r) => r.influencer_id);
  const { data: infsRaw, error: infErr } = await sb
    .from("influencers")
    .select("id, username, platform, contact_email, bio, raw_data")
    .in("id", ids)
    .eq("synthetic", false);
  if (infErr) {
    return NextResponse.json(
      { error: "failed to load influencers", detail: infErr.message },
      { status: 500 }
    );
  }
  const infs = (infsRaw ?? []) as unknown as InfluencerRow[];
  const infsById = new Map(infs.map((i) => [i.id, i] as const));

  // --- 5. Fan out drafts with bounded concurrency + cost/timeout caps ---
  // Static per-call cost estimate for GPT-4o personalization. Tuned to
  // roughly match observed input+output tokens for the prompt shape in
  // src/lib/openai.ts.
  const PER_DRAFT_COST_USD = 0.01;
  const startMs = Date.now();

  interface DraftResult {
    ci_id: string;
    ok: boolean;
    /**
     * Did this attempt actually consume model spend? A run that never got a
     * completion back (provider outage) costs nothing and must not be charged
     * against the cap — that is precisely how a 429 storm can burn the whole
     * budget and produce almost no drafts.
     */
    billable: boolean;
    source?: 'model' | 'fallback';
    error?: string;
  }

  const results: DraftResult[] = [];
  // spentUsd = charged for calls that produced output.
  // inFlightUsd = reserved for calls currently running, so two concurrent
  // workers cannot both squeak past the cap check on the same headroom.
  let spentUsd = 0;
  let inFlightUsd = 0;
  let costCapHit = false;
  let timeoutHit = false;

  // Worker that pulls from the shared queue. Bails when caps fire or
  // queue empties. We slice ciRows into a queue array so multiple
  // workers can pop from it atomically (single-threaded JS semantics
  // make .shift() atomic for our purposes).
  const queue = [...ciRows];
  async function draftOne(ci: CiRow): Promise<DraftResult> {
    const inf = infsById.get(ci.influencer_id);
    if (!inf) {
      return {
        ci_id: ci.id,
        ok: false,
        billable: false,
        error: 'influencer not found or synthetic',
      };
    }
    const recentPosts = (inf.raw_data?.posts ?? [])
      .slice(0, 5)
      .map((p) => ({
        hook: (p.text ?? '').slice(0, 140),
        views: p.playCount,
        hashtags: (p.hashtags ?? [])
          .map((h) => h?.name ?? '')
          .filter((n) => n.length > 0)
          .slice(0, 5),
        // Post age gates whether a hook may be cited at all (scrape data can
        // be years old; see REFERENCE_MAX_AGE_DAYS in openai.ts).
        postedAt: p.createTimeISO,
      }));
    try {
      const draft = await generateOutreachDraft({
        firmVoice,
        campaignId,
        artistName: cmp.artist_name,
        trackName: cmp.track_name ?? undefined,
        releaseDate: cmp.release_date ?? undefined,
        personality,
        creator: { handle: inf.username, bio: inf.bio ?? undefined, recentPosts },
      });
      const billable = draft.modelCalls > 0;
      const isFallback = draft.source === 'fallback';
      // No recordApiCall here: complete() ledgers each draft completion itself
      // (endpoint 'outreach.initial_draft', plus 'reference_guard.provenance'
      // for the guard calls), campaign-attributed and priced from real token
      // usage under the provider that served it. The flat $0.01 row this used
      // to write double-counted the same spend, and mislabelled the vendor as
      // 'openai' whatever MODEL_PROVIDER was. Model-vs-fallback copy stays
      // readable on outreach_messages (template_used / generation_model), and
      // a draft that got nothing back writes no row at all — complete()
      // ledgers on success only, which is exactly `billable`.
      // Channel + send mode, instead of the hardcoded 'email' this used to
      // stamp on every draft. ~95% of the pool has no email address, so every
      // one of those drafts claimed a channel it could not be sent on, and
      // `send_mode` stayed NULL — which is why the dashboard's DM queue (it
      // filters on send_mode === 'human_queue') has never held a single row.
      const dispatch = outreachDispatchFields({
        primaryChannel: ci.primary_channel,
        platform: inf.platform,
        contactEmail: inf.contact_email,
      });
      const channel = dispatch.channel;

      const { error: insErr } = await sb.from('outreach_messages').insert({
        campaign_influencer_id: ci.id,
        message_type: 'initial',
        direction: 'outbound',
        ...dispatch,
        subject: draft.subject,
        body: draft.body,
        version: 1,
        // Marking, so an operator can separate degraded copy from model copy
        // without a new column:
        //   select * from outreach_messages
        //   where generation_model = 'deterministic-fallback';
        template_used: isFallback ? FALLBACK_DRAFT_TEMPLATE : MODEL_DRAFT_TEMPLATE,
        // Was hardcoded 'gpt-4o-2024-08-06' regardless of MODEL_PROVIDER, which
        // was simply untrue on the Gemini-backed prod deploy.
        generation_model: isFallback ? FALLBACK_DRAFT_MODEL : activeModelLabel(),
        edited_by_user: false,
        original_body: draft.body,
        status: 'draft',
      } as unknown as never);
      if (insErr) {
        // The model call already happened, so it is still billable even though
        // the row did not land.
        return { ci_id: ci.id, ok: false, billable, source: draft.source, error: insErr.message };
      }
      // Promote ci.outreach_status so the /outreach UI's Drafts tab surfaces
      // the row. Without this, the page filter (outreach_status='draft_ready')
      // hides the new draft and the label can't see it. Best-effort: if the update
      // fails we still count the draft as ok — the row exists.
      //
      // primary_channel WRITE-BACK. This route resolves the concrete channel
      // (legacy 'dm' → tiktok_dm for a TikTok creator) and stamps it on the
      // message, but used to leave campaign_influencers.primary_channel saying
      // 'dm', or saying nothing at all on rows where it is NULL.
      // Escalation then read that row as "the concrete channel has never been
      // tried" and re-queued the same body to the same inbox. The read is now
      // safe on its own (escalation.attemptedChannels expands legacy 'dm'), but
      // a row that says what actually happened is worth having: NULL cannot be
      // expanded by anything, so for those rows this write-back is the only fix.
      //
      // Only null/legacy values are overwritten — a concrete primary_channel
      // set by contact discovery is never clobbered by a re-draft.
      const promote: Record<string, unknown> = { outreach_status: 'draft_ready' };
      if (!ci.primary_channel || ci.primary_channel === 'dm') {
        promote.primary_channel = channel;
      }
      await sb
        .from('campaign_influencers')
        .update(promote as unknown as never)
        .eq('id', ci.id);
      return { ci_id: ci.id, ok: true, billable, source: draft.source };
    } catch (e) {
      // generateOutreachDraft only throws when the model layer failed AND the
      // deterministic fallback could not pass copy validation. Nothing was
      // produced; if the model never answered, nothing was spent either.
      return { ci_id: ci.id, ok: false, billable: false, error: (e as Error).message };
    }
  }

  async function worker() {
    while (queue.length > 0) {
      // Pre-flight check — still strictly BEFORE the call, and now stricter:
      // in-flight reservations count against the cap so N concurrent workers
      // cannot each clear the same last dollar of headroom.
      if (spentUsd + inFlightUsd + PER_DRAFT_COST_USD > DRAFT_OPENAI_USD_CAP) {
        costCapHit = true;
        return;
      }
      if (Date.now() - startMs > DRAFT_TIMEOUT_MS) {
        timeoutHit = true;
        return;
      }
      const ci = queue.shift();
      if (!ci) return;
      // RESERVE before, CHARGE after. The old code charged unconditionally up
      // front, so a provider 429 storm could spend the entire cap and
      // produce almost no drafts — the budget was consumed by calls that
      // returned nothing at all.
      inFlightUsd += PER_DRAFT_COST_USD;
      let r: DraftResult;
      try {
        r = await draftOne(ci);
      } finally {
        inFlightUsd -= PER_DRAFT_COST_USD;
      }
      if (r.billable) spentUsd += PER_DRAFT_COST_USD;
      results.push(r);
    }
  }

  await Promise.all(
    Array.from({ length: DRAFT_CONCURRENCY }, () => worker())
  );

  const drafted = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  // Degradation visibility. A run that is 100% fallback copy is "successful"
  // by row count and still means the model layer was down for the whole run —
  // The label must not discover that by reading the drafts.
  const fallbackDrafts = results.filter((r) => r.ok && r.source === 'fallback').length;
  const modelDrafts = results.filter((r) => r.ok && r.source === 'model').length;
  const unbilledFailures = results.filter((r) => !r.ok && !r.billable).length;

  // INF-6 alignment: when a cost cap or timeout fires, audit it the same
  // way the discovery pipeline does so ops can grep for `pipeline.*` and
  // `draft.*` cap events together.
  if (costCapHit || timeoutHit) {
    const { audit } = await import('@/lib/audit');
    await audit(
      {
        action: timeoutHit ? 'draft.timeout' : 'draft.cost_cap_hit',
        target_type: 'campaign',
        target_id: campaignId,
        firm_id: cmp.firm_id,
        metadata: {
          drafted,
          failed,
          model_drafts: modelDrafts,
          fallback_drafts: fallbackDrafts,
          unbilled_failures: unbilledFailures,
          spent_usd: Number(spentUsd.toFixed(4)),
          cap_usd: DRAFT_OPENAI_USD_CAP,
          elapsed_ms: Date.now() - startMs,
          wanted_drafts: wantedDrafts,
          remaining_in_queue: queue.length,
        },
      },
      _req
    );
  }

  return NextResponse.json({
    drafted,
    failed,
    model_drafts: modelDrafts,
    fallback_drafts: fallbackDrafts,
    unbilled_failures: unbilledFailures,
    cost_usd: Number(spentUsd.toFixed(4)),
    target_count: targetCount,
    expected_deal_rate: expectedDealRate,
    wanted_drafts: wantedDrafts,
    pool_size: allCiRows.length,
    already_drafted: alreadyDrafted,
    gated_out: gatedOut,
    outreach_limit: limitN,
    // Under a mini-run the limit, not the funnel, is the goal.
    pool_short_of_goal: Math.max(0, draftGoal - ciRows.length),
    cost_cap_hit: costCapHit,
    timeout_hit: timeoutHit,
    explanation:
      `target_count=${targetCount} ÷ deal_rate=${expectedDealRate.toFixed(3)} ` +
      `→ wanted=${wantedDrafts}; pool=${allCiRows.length}, ` +
      `already_drafted=${alreadyDrafted}, ` +
      (gatedOut > 0 ? `gated_out=${gatedOut} (firm pool gates), ` : '') +
      `drafted_this_run=${drafted} ` +
      `(concurrency=${DRAFT_CONCURRENCY}, $${spentUsd.toFixed(2)}/$${DRAFT_OPENAI_USD_CAP} cap)` +
      (fallbackDrafts > 0
        ? ` — ${fallbackDrafts} of ${drafted} drafts are DETERMINISTIC FALLBACK copy ` +
          `(the model layer failed for those); they are marked ` +
          `generation_model='${FALLBACK_DRAFT_MODEL}' and should be reviewed before sending`
        : '') +
      (slots != null ? ` — outreach_limit=${limitN}, slots=${slots}` : '') +
      (ciRows.length < draftGoal
        ? ` — POOL SHORT BY ${draftGoal - ciRows.length}; widen scraping to hit goal`
        : '') +
      (costCapHit
        ? ` — DRAFT COST CAP HIT at $${DRAFT_OPENAI_USD_CAP}; raise DRAFT_OPENAI_USD_CAP to continue`
        : '') +
      (timeoutHit
        ? ` — TIMEOUT (270s); ${queue.length} drafts still queued, re-run /draft-all to resume`
        : ''),
  });
}
