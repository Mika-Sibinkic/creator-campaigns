// src/app/api/campaigns/[id]/run/route.ts
//
// SECURITY-OK: supabaseAdmin — pipeline persists into shared cross-firm `influencers` + system tables (api_ledger, learning_logs) with no INSERT policy for authed users. Session + firm-ownership check still gates the route.
//
// SYSTEM PATH (SEC-1 exempt) — this route is the discovery pipeline. It
// acts on the user's behalf but persists into shared, cross-firm tables
// (`influencers`, which has no firm_id and is shared across all firms)
// and writes into `api_ledger` / `learning_logs` which are system-audit
// tables with no INSERT policy for authenticated users. It MUST therefore
// run with the service role.
//
// Authorization: we still gate the route by requiring a session AND
// confirming the campaign belongs to the caller's firm before doing
// anything. This prevents a logged-in user from kicking off pipeline
// runs against another firm's campaigns.
//
// Runs the pipeline synchronously and streams progress over SSE.
//
// Pipeline order:
//   1. Spotify  → similar artists (ecosystem context)
//   2. OpenAI   → 8 search queries, steered by the firm's region
//   3. Apify    → scrape each platform in campaigns.target_platforms
//                 (live, real data)
//   4. Normalize → group posts by author, score, persist to DB
//
// Step 3 fans ONE set of generated queries across every supported platform
// the campaign selected, and reports the rest (a campaign could otherwise
// select Instagram and get a TikTok-only pool with nothing saying so). Both
// scrapes live inside the single `apify` SSE step on purpose — reduceRun keys
// steps by id and OVERWRITES, so a second running/done pair under the same id
// would rewind the client's progress bar from 60% back to 40% mid-run.
//
// Each external boundary is recorded to api_ledger via recordApiCall().
// Progress is streamed to the client as Server-Sent Events.
//
// IMPORTANT — library-shape adaptations vs. the plan's template (Task C3):
// - spotify.ts exports `getRelatedArtistsContext(artistName)` returning a
//   string, not `getRelatedArtists` returning {name}[]. We call it and parse
//   `- Name (genre)` lines to recover the names list the rest of the pipeline
//   expects. Modifying spotify.ts is out of C3 scope.
// - scoring.ts exports `scoreInfluencers(profiles[], context)` (plural batch),
//   returning `{ ranked_influencers: [{composite_score, ...}] }`, not
//   `scoreInfluencer(input) -> {total}`. We call the batch variant per-author
//   and read `composite_score`.
// - bot-detection.ts `detectBot` takes `{username, followers, engagement_rate,
//   bio, verified, raw_data?}` and returns `{bot_flagged, bot_probability, ...}`.
//   We use this real shape.

import { supabaseAdmin } from "@/lib/supabase";
import { getSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getRelatedArtistsContext } from "@/lib/spotify";
import { generateSearchQueries } from "@/lib/openai";
import { scrapeInstagram, scrapeTikTok } from "@/lib/apify";
import {
  candidateKey,
  candidatesFromInstagram,
  candidatesFromTikTok,
  planPlatforms,
  prefilterCandidates,
  resolveEngagementFloors,
  type CandidateRow,
} from "@/lib/discovery-candidates";
import {
  assessCreatorRegion,
  emptyRegionReport,
  readCreatorRegionSignal,
  regionGateActive,
  tallyRegion,
} from "@/lib/creator-region";
import { recordApiCall } from "@/lib/api-ledger";
import { scoreInfluencers } from "@/lib/scoring";
import { complete, activeModelLabel } from "@/lib/model-provider";
import { selectCommentsProvider } from "@/lib/comments-provider";
import {
  describeAuditSummary,
  runCommentAudits,
  type AuditCandidate,
} from "@/lib/comment-audit-run";
import { AUDIT_DEFAULT_SPEND_CAP_USD } from "@/lib/comment-audit";
import { discoverContacts } from "@/lib/contact-discovery";
import { resolveGenre } from "@/lib/genre-config";
import {
  qualifyCreator,
  statusForVerdict,
  type QualifyRawPost,
} from "@/lib/qualify";
import {
  gateExclusionPatch,
  poolGateExclusion,
  resolvePoolGatePrefs,
} from "@/lib/pool-gates";
import { readFirmBlocks } from "@/lib/firm-blocks";
import { describeKeptByPlatform } from "@/lib/run-progress";
import { tieredLimit, rateLimited } from "@/lib/rate-limit";
import { alertOnce } from "@/lib/sentry-alerts";
import { requestLogger } from "@/lib/logger";
import { envNumber } from "@/lib/env";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

// INF-6: hard ceilings on a single pipeline run. Defaults are conservative
// — overrides via env let prod widen them if a campaign legitimately needs
// more, without code changes.
// envNumber, not parseFloat: these three carried the same NaN-on-blank hole,
// and APIFY_PER_RUN_USD_CAP in particular now feeds the Instagram charge
// ceiling, so a blank value there would propagate NaN into the one guard
// standing between a second scrape and an uncapped bill.
const PIPELINE_TIMEOUT_MS = envNumber(process.env.PIPELINE_TIMEOUT_MS, 180000);
// Comment-quality audit (Step 4b): hard per-run spend cap, its own wall-clock
// budget, and the time it must leave for contact discovery + qualify after it.
const COMMENT_AUDIT_SPEND_CAP_USD = envNumber(
  process.env.COMMENT_AUDIT_SPEND_CAP_USD,
  AUDIT_DEFAULT_SPEND_CAP_USD
);
const COMMENT_AUDIT_TIME_BUDGET_MS = 90_000;
const COMMENT_AUDIT_RESERVE_FOR_LATER_STEPS_MS = 70_000;
const APIFY_PER_RUN_USD_CAP = envNumber(process.env.APIFY_PER_RUN_USD_CAP, 5);
const OPENAI_PER_RUN_USD_CAP = envNumber(process.env.OPENAI_PER_RUN_USD_CAP, 1);

// Instagram ceilings, handed to Apify so the platform enforces them BEFORE it
// bills. APIFY_PER_RUN_USD_CAP is only inspected after a scrape returns, which
// is too late to stop a runaway second scrape — it can only report one.
//
// INSTAGRAM_MAX_CHARGE_USD is the REAL rail. instagram-search-scraper is a
// PAY_PER_EVENT actor (~$0.0027 per result), and apify-client's own types say
// maxItems applies to pay-per-RESULT actors only — so maxItems is inert here
// and is sent purely as a belt-and-braces bound in case the actor's pricing
// model changes. At $0.0027/result the $0.75 ceiling is ~277 results, which is
// the number that actually binds, not the 120 in INSTAGRAM_MAX_ITEMS.
const INSTAGRAM_MAX_ITEMS = envNumber(process.env.INSTAGRAM_MAX_ITEMS, 120);
const INSTAGRAM_MAX_CHARGE_USD = envNumber(
  process.env.INSTAGRAM_MAX_CHARGE_USD,
  0.75
);
/** Actor run timeout in SECONDS — apify-client's unit, not milliseconds. */
const INSTAGRAM_TIMEOUT_SECS = envNumber(process.env.INSTAGRAM_TIMEOUT_SECS, 120);

interface RouteCtx {
  params: Promise<{ id: string }>;
}

function sse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: string,
  data: unknown
) {
  controller.enqueue(
    new TextEncoder().encode(
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    )
  );
}

/**
 * Parse the Spotify context string produced by getRelatedArtistsContext()
 * back into a list of artist names. Lines look like:
 *   "- Some Artist (genre, genre)"
 * Returns [] if the context is null or contains no list rows.
 */
function parseSimilarArtistNames(context: string | null): string[] {
  if (!context) return [];
  const names: string[] = [];
  for (const line of context.split("\n")) {
    const match = line.match(/^-\s+(.+?)(?:\s+\(.*\))?$/);
    if (match && match[1]) {
      const name = match[1].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

export async function POST(_req: Request, ctx: RouteCtx) {
  // SEC-2: full pipeline burns Apify $$ + OpenAI tokens → expensive tier.
  const limit = tieredLimit(_req, 'expensive');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }

  const { id: campaignId } = await ctx.params;
  // Structured, request-scoped pipeline logging: every line carries
  // campaign_id + the x-request-id audit.ts also persists, so a failed run is
  // greppable end-to-end from either side.
  const log = requestLogger("pipeline", _req, { campaign_id: campaignId });

  // SEC-1: gate the system path with an explicit firm-ownership check
  // before any pipeline work begins. RLS doesn't apply (we use service
  // role internally), so we enforce authorization manually here.
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const sb = supabaseAdmin();
  const { data: ownership, error: ownErr } = await sb
    .from('campaigns')
    .select('id, firm_id, confirmed_at')
    .eq('id', campaignId)
    .single();
  if (ownErr || !ownership) {
    return NextResponse.json({ error: 'campaign not found' }, { status: 404 });
  }
  const ownRow = ownership as { id: string; firm_id: string; confirmed_at: string | null };
  if (ownRow.firm_id !== session.firm_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Rail #2: per-firm daily Apify cap. Layered on top of APIFY_PER_RUN_USD_CAP.
  // We sum api_ledger.cost_usd for source='apify' joined through
  // campaigns.firm_id (api_ledger has no firm_id column, so we resolve via
  // campaign_id). Block at the route boundary BEFORE we open the SSE stream
  // so the caller gets a real 429 (with the same payload mirrored into SSE
  // on caps hit mid-stream, but here we just short-circuit).
  const { data: firmRow, error: firmErr } = await sb
    .from('firms')
    .select('daily_apify_cap_usd')
    .eq('id', session.firm_id)
    .single();
  if (firmErr || !firmRow) {
    return NextResponse.json({ error: 'firm not found' }, { status: 404 });
  }
  // Sibling of the spend-caps fail-closed fix: `?? 0` turned an UNREADABLE cap
  // into a DISABLED one. The column is NOT NULL DEFAULT 10 (migration 016), so
  // NULL here means we could not verify the ceiling — refuse the run rather
  // than let it scrape on an unverifiable budget. An explicit 0 remains the
  // documented opt-out.
  const rawDailyCap = (firmRow as { daily_apify_cap_usd: unknown }).daily_apify_cap_usd;
  const dailyCapUsd = Number(rawDailyCap);
  if (rawDailyCap === null || rawDailyCap === undefined || !Number.isFinite(dailyCapUsd) || dailyCapUsd < 0) {
    return NextResponse.json(
      {
        error: 'daily_apify_cap_not_set',
        message: 'This firm has no readable daily Apify spend cap. Set one in /settings before running discovery.',
      },
      { status: 412 }
    );
  }
  if (dailyCapUsd > 0) {
    // Start of current UTC day.
    const now = new Date();
    const startOfDayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    const startOfNextDayUtc = new Date(startOfDayUtc.getTime() + 24 * 60 * 60 * 1000);
    // Fetch this firm's campaign ids, then sum api_ledger.cost_usd for
    // those ids today. Two-step because api_ledger doesn't carry firm_id.
    const { data: firmCampaigns } = await sb
      .from('campaigns')
      .select('id')
      .eq('firm_id', session.firm_id);
    const firmCampaignIds = (firmCampaigns ?? []).map(
      (c) => (c as { id: string }).id
    );
    let spentTodayUsd = 0;
    if (firmCampaignIds.length > 0) {
      const { data: ledgerRows } = await sb
        .from('api_ledger')
        .select('cost_usd')
        .eq('source', 'apify')
        .in('campaign_id', firmCampaignIds)
        .gte('created_at', startOfDayUtc.toISOString())
        .lt('created_at', startOfNextDayUtc.toISOString());
      spentTodayUsd = (ledgerRows ?? []).reduce(
        (a, r) => a + Number((r as { cost_usd: number }).cost_usd ?? 0),
        0
      );
    }
    if (spentTodayUsd >= dailyCapUsd) {
      await audit(
        {
          action: 'pipeline.blocked_over_daily_apify_cap',
          target_type: 'campaign',
          target_id: campaignId,
          firm_id: session.firm_id,
          metadata: {
            spent_usd: spentTodayUsd,
            cap_usd: dailyCapUsd,
            resets_at: startOfNextDayUtc.toISOString(),
          },
        },
        _req
      );
      return NextResponse.json(
        {
          error: 'daily_apify_cap_exceeded',
          spent_usd: spentTodayUsd,
          cap_usd: dailyCapUsd,
          resets_at: startOfNextDayUtc.toISOString(),
        },
        { status: 429 }
      );
    }
  }
  // Pre-run gate. Pipeline cannot kick off until the user has
  // explicitly confirmed the campaign (and onboarding is complete on the
  // firm — confirm endpoint enforces that). Surfaces a 412 the UI can
  // act on with a redirect to /campaigns/[id]/confirm.
  if (!ownRow.confirmed_at) {
    return NextResponse.json(
      {
        error: 'campaign_not_confirmed',
        message: 'Confirm the campaign at /campaigns/[id]/confirm before running.',
        redirect_to: `/campaigns/${campaignId}/confirm`,
      },
      { status: 412 }
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // INF-6: budget bookkeeping. checkBudgets() is called after every
      // external boundary; on any breach it emits an SSE error, writes a
      // pipeline.* audit row, and throws to bail out of the try/finally
      // (which closes the controller cleanly).
      const pipelineStartMs = Date.now();
      let apifyTotalUsd = 0;
      let openaiTotalUsd = 0;
      const checkBudgets = async (after: string) => {
        const elapsed = Date.now() - pipelineStartMs;
        if (elapsed > PIPELINE_TIMEOUT_MS) {
          sse(controller, 'error', {
            code: 'pipeline_timeout',
            message: `pipeline timed out after ${elapsed}ms (>${PIPELINE_TIMEOUT_MS}ms cap)`,
            after,
          });
          await audit(
            {
              action: 'pipeline.timeout',
              target_type: 'campaign',
              target_id: campaignId,
              firm_id: session.firm_id,
              metadata: {
                elapsed_ms: elapsed,
                cap_ms: PIPELINE_TIMEOUT_MS,
                step: after,
                apify_usd: apifyTotalUsd,
                openai_usd: openaiTotalUsd,
              },
            },
            _req
          );
          alertOnce(
            `pipeline_timeout:${session.firm_id}:${campaignId}`,
            'warning',
            'Pipeline timeout exceeded',
            {
              firm_id: session.firm_id,
              campaign_id: campaignId,
              elapsed_ms: elapsed,
              cap_ms: PIPELINE_TIMEOUT_MS,
              step: after,
              apify_usd: apifyTotalUsd,
              openai_usd: openaiTotalUsd,
            }
          );
          throw new Error('pipeline_timeout');
        }
        if (apifyTotalUsd > APIFY_PER_RUN_USD_CAP) {
          sse(controller, 'error', {
            code: 'apify_cost_cap',
            message: `apify cost $${apifyTotalUsd.toFixed(2)} exceeds cap $${APIFY_PER_RUN_USD_CAP}`,
          });
          await audit(
            {
              action: 'pipeline.cost_cap_hit',
              target_type: 'campaign',
              target_id: campaignId,
              firm_id: session.firm_id,
              metadata: {
                provider: 'apify',
                spent_usd: apifyTotalUsd,
                cap_usd: APIFY_PER_RUN_USD_CAP,
                step: after,
              },
            },
            _req
          );
          alertOnce(
            `pipeline_cost_cap:apify:${session.firm_id}:${campaignId}`,
            'warning',
            'Pipeline cost cap exceeded (apify)',
            {
              firm_id: session.firm_id,
              campaign_id: campaignId,
              provider: 'apify',
              spent_usd: apifyTotalUsd,
              cap_usd: APIFY_PER_RUN_USD_CAP,
              step: after,
            }
          );
          throw new Error('apify_cost_cap');
        }
        if (openaiTotalUsd > OPENAI_PER_RUN_USD_CAP) {
          sse(controller, 'error', {
            code: 'openai_cost_cap',
            message: `openai cost $${openaiTotalUsd.toFixed(4)} exceeds cap $${OPENAI_PER_RUN_USD_CAP}`,
          });
          await audit(
            {
              action: 'pipeline.cost_cap_hit',
              target_type: 'campaign',
              target_id: campaignId,
              firm_id: session.firm_id,
              metadata: {
                provider: 'openai',
                spent_usd: openaiTotalUsd,
                cap_usd: OPENAI_PER_RUN_USD_CAP,
                step: after,
              },
            },
            _req
          );
          alertOnce(
            `pipeline_cost_cap:openai:${session.firm_id}:${campaignId}`,
            'warning',
            'Pipeline cost cap exceeded (openai)',
            {
              firm_id: session.firm_id,
              campaign_id: campaignId,
              provider: 'openai',
              spent_usd: openaiTotalUsd,
              cap_usd: OPENAI_PER_RUN_USD_CAP,
              step: after,
            }
          );
          throw new Error('openai_cost_cap');
        }
      };

      try {
        // 1. Load campaign
        const { data: campaignRow, error: cErr } = await sb
          .from("campaigns")
          .select("*")
          .eq("id", campaignId)
          .single();
        if (cErr || !campaignRow) {
          sse(controller, "error", { message: "Campaign not found" });
          controller.close();
          return;
        }
        const c = campaignRow as {
          id: string;
          artist_name: string;
          track_name?: string;
          release_date?: string;
          target_platforms?: string[];
          urgency?: string;
          artist_data?: Record<string, unknown>;
        };
        // Genre is firm/campaign-driven — never a hardcoded default.
        //
        // This used to read artist_data.genre alone, which nothing writes, so
        // `genre` was always undefined and every downstream consumer fell back
        // to its own "country" literal (spotify.ts discovery query,
        // pricing.ts multiplier). Resolution order is campaign override →
        // legacy artist_data.genre → firm default → null; `null` is a
        // supported answer that makes consumers run genre-neutrally.
        // ONE read of the firm's scraping_prefs for the whole run. Genre
        // (here) and the Apify follower bounds (Rail #1a below) both need it.
        const { data: firmPrefsRow } = await sb
          .from('firms')
          .select('scraping_prefs')
          .eq('id', session.firm_id)
          .single();
        const firmScrapingPrefs = (
          firmPrefsRow as { scraping_prefs?: unknown } | null
        )?.scraping_prefs;
        const genre =
          resolveGenre(
            {
              scrapingOverrides: (c as { scraping_overrides?: unknown }).scraping_overrides,
              artistData: c.artist_data,
            },
            { scrapingPrefs: firmScrapingPrefs }
          ) ?? undefined;

        // The per-firm pool gates, parsed ONCE for the whole run from the same
        // single firms.scraping_prefs fetch as genre and the follower bounds —
        // this file's third separate query against that row was collapsed
        // deliberately; do not add a fourth.
        //
        // Hoisted up here from the qualification step because the region
        // now has two consumers, and they must not disagree: the
        // search-query prompt below — the only lever a region has on
        // ACQUISITION, since neither scraper takes a geo input — and the
        // audience-language gate at qualification time.
        const gatePrefs = resolvePoolGatePrefs(firmScrapingPrefs);
        const regionPref = gatePrefs.region;

        // Which platforms this run can actually acquire from, and which
        // selected ones it cannot. `unsupported` is reported, never dropped.
        const platformPlan = planPlatforms(c.target_platforms);

        // ────────────────────────────────────────────────────────────────────
        // Step 1: Spotify — find similar artists
        // ────────────────────────────────────────────────────────────────────
        sse(controller, "progress", {
          step: "spotify",
          status: "running",
          message: "Finding similar artists…",
        });
        const t0 = Date.now();
        const spotifyContext = await getRelatedArtistsContext(
          c.artist_name,
          genre
        ).catch(() => null);
        const similarNames = parseSimilarArtistNames(spotifyContext);
        await recordApiCall({
          campaign_id: campaignId,
          source: "spotify",
          endpoint: "related-artists",
          cost_usd: 0,
          records_returned: similarNames.length,
          latency_ms: Date.now() - t0,
        });
        sse(controller, "progress", {
          step: "spotify",
          status: "done",
          message: `Found ${similarNames.length} similar artists`,
          data: similarNames.slice(0, 6),
        });

        // ────────────────────────────────────────────────────────────────────
        // Step 2: OpenAI — generate search queries
        // ────────────────────────────────────────────────────────────────────
        sse(controller, "progress", {
          step: "queries",
          status: "running",
          message: "Generating search queries…",
        });
        const queries = await generateSearchQueries({
          artist: c.artist_name,
          similarArtists: similarNames.slice(0, 8),
          trackName: c.track_name,
          genres: genre ? [genre] : undefined,
          // The raw string, not the resolved pref: "the Hill Country" is useful to a
          // model and unresolvable by a lookup table.
          region: regionPref?.raw ?? null,
          platforms: platformPlan.scrape,
          campaignId,
        });
        // No recordApiCall here: complete() ledgers this call itself
        // (endpoint 'discovery.search_queries') under the provider that
        // actually served it, priced from real token usage. The flat $0.005
        // row this used to write double-counted the same call and always said
        // source 'openai' even when Gemini served it. The in-process run cap
        // below still uses the flat estimate — it has to decide BEFORE the
        // ledger row exists.
        openaiTotalUsd += 0.005;
        await checkBudgets('openai-query-gen');
        sse(controller, "progress", {
          step: "queries",
          status: "done",
          message: `${queries.length} queries`,
          data: queries,
        });

        // ────────────────────────────────────────────────────────────────────
        // Step 3: Apify — scrape every selected platform (the expensive call)
        //
        // Rail #1a: source firm.scraping_prefs to pre-bound the actor's
        // follower window. Saves Apify spend on profiles we'd reject at
        // normalize anyway.
        //
        // The bounds below reach the TikTok actor as real inputs. Instagram's
        // search actor takes NO follower parameters, so the same floor is
        // applied to its results in the pre-filter instead — the config has to
        // mean the same thing on both platforms or it is a setting that only
        // half works.
        // ────────────────────────────────────────────────────────────────────
        // Reuses the single firms.scraping_prefs read above — this used to
        // issue the identical query a second time in the same run.
        const scrapingPrefs =
          (firmScrapingPrefs as
            | { follower_min?: number; follower_max?: number; engagement_min?: number }
            | undefined) ?? {};
        // Follower floor: uniform 1,500 default across artists.
        // Firm scraping_prefs.follower_min overrides when explicitly set.
        const followerMin =
          typeof scrapingPrefs.follower_min === 'number' && scrapingPrefs.follower_min > 0
            ? scrapingPrefs.follower_min
            : 1500;
        const followerMax =
          typeof scrapingPrefs.follower_max === 'number' && scrapingPrefs.follower_max > 0
            ? scrapingPrefs.follower_max
            : undefined;
        // engagement_min is deliberately NOT read here any more. It is one
        // number that cannot mean the same thing on two platforms, so
        // resolveEngagementFloors() turns it into a floor PER platform at the
        // pre-filter. Reading it as a single scalar here is what let a
        // TikTok-basis threshold silently delete the whole Instagram pool.

        sse(controller, "progress", {
          step: "apify",
          status: "running",
          message: `Searching ${platformPlan.scrape.join(" and ")}…`,
        });

        // ONE running/done pair for the whole step regardless of how many
        // platforms run inside it. See the header note on reduceRun.
        const profileRows: CandidateRow[] = [];
        const recordsByPlatform: Record<string, number> = {};
        const creatorsByPlatform: Record<string, number> = {};
        let apifyCostUsd = 0;
        let apifyCostComplete = true;
        const scrapeNotes: string[] = [];

        if (platformPlan.scrape.includes("tiktok")) {
          const t2 = Date.now();
          const scrape = await scrapeTikTok({
            searchQueries: queries.slice(0, 4),
            maxProfilesPerQuery: 25,
            followersMoreThan: followerMin,
            followersLessThan: followerMax,
          });
          apifyTotalUsd += scrape.costUsd;
          apifyCostUsd += scrape.costUsd;
          await recordApiCall({
            campaign_id: campaignId,
            source: "apify",
            endpoint: "tiktok-scraper",
            cost_usd: scrape.costUsd,
            records_returned: scrape.profiles.length,
            latency_ms: Date.now() - t2,
            request_meta: { runId: scrape.runId },
          });
          await checkBudgets("apify-tiktok-scraper");
          const rows = candidatesFromTikTok(scrape.profiles);
          profileRows.push(...rows);
          recordsByPlatform.tiktok = scrape.profiles.length;
          creatorsByPlatform.tiktok = rows.length;
        }

        if (platformPlan.scrape.includes("instagram")) {
          // checkBudgets() above has already bailed the run out if TikTok
          // alone breached the per-run cap, so reaching here means there is
          // headroom. Hand Apify whatever is LEFT of it as a platform-enforced
          // ceiling: APIFY_PER_RUN_USD_CAP is only inspected AFTER a scrape
          // returns, which can report an overrun but cannot prevent one.
          const remainingUsd = Math.max(0, APIFY_PER_RUN_USD_CAP - apifyTotalUsd);
          const igChargeCapUsd = Math.min(remainingUsd, INSTAGRAM_MAX_CHARGE_USD);
          // checkBudgets() only throws once spend is OVER the cap, so landing
          // exactly ON it arrives here with nothing left. Running anyway would
          // be the worst case available: scrapeInstagram DROPS a non-positive
          // maxTotalChargeUsd rather than sending "spend zero", so the run
          // with no budget would be the one scrape with no ceiling. Skip it.
          if (igChargeCapUsd <= 0) {
            scrapeNotes.push("instagram skipped, no budget left in this run");
            log.error("instagram scrape skipped for budget", {
              apify_total_usd: apifyTotalUsd,
              cap_usd: APIFY_PER_RUN_USD_CAP,
            });
          } else {
            const t3 = Date.now();
            const ig = await scrapeInstagram({
              searchTerms: queries.slice(0, 4),
              searchLimit: 25,
              maxItems: INSTAGRAM_MAX_ITEMS,
              maxTotalChargeUsd: igChargeCapUsd,
              timeoutSecs: INSTAGRAM_TIMEOUT_SECS,
            });
            apifyTotalUsd += ig.costUsd;
            apifyCostUsd += ig.costUsd;
            // A run Apify did not price is ledgered as 0 because the column
            // needs a number, but the run must not then REPORT a measured $0.
            if (!ig.costKnown) apifyCostComplete = false;
            await recordApiCall({
              campaign_id: campaignId,
              source: "apify",
              // Distinct from the TikTok endpoint on purpose. The daily Apify
              // cap is evaluated once at route entry and never re-checked, so
              // this second call is not blocked by it and it doubles the day's
              // ledgered total. Separate endpoint strings are what make that
              // visible in api_ledger instead of buried in one bucket.
              endpoint: "instagram-search-scraper",
              cost_usd: ig.costUsd,
              records_returned: ig.profiles.length,
              latency_ms: Date.now() - t3,
              request_meta: {
                runId: ig.runId,
                status: ig.status,
                cost_known: ig.costKnown,
              },
            });
            await checkBudgets("apify-instagram-scraper");
            // 'SKIPPED' is this client's own sentinel for "no search terms", not
            // an Apify status — it means no run happened and nothing was billed.
            if (ig.status !== "SUCCEEDED" && ig.status !== "SKIPPED") {
              scrapeNotes.push(`instagram run ended ${ig.status}`);
              log.error("instagram scrape did not succeed", {
                status: ig.status,
                runId: ig.runId,
                returned: ig.profiles.length,
              });
            }
            const rows = candidatesFromInstagram(ig.profiles);
            profileRows.push(...rows);
            recordsByPlatform.instagram = ig.profiles.length;
            creatorsByPlatform.instagram = rows.length;
          }
        }

        if (platformPlan.unsupported.length > 0) {
          // Selecting YouTube and getting a TikTok-only pool with nothing
          // saying so is the exact failure this pair of issues is about.
          scrapeNotes.push(
            `no discovery source for ${platformPlan.unsupported.join(", ")}`
          );
          await audit(
            {
              action: "pipeline.platform_unsupported",
              target_type: "campaign",
              target_id: campaignId,
              firm_id: session.firm_id,
              metadata: {
                selected: c.target_platforms ?? null,
                scraped: platformPlan.scrape,
                unsupported: platformPlan.unsupported,
              },
            },
            _req
          );
        }

        const scrapedCreators = profileRows.length;
        const costLabel = apifyCostComplete
          ? `$${apifyCostUsd.toFixed(2)}`
          : `$${apifyCostUsd.toFixed(2)}+ (Apify reported no cost for part of this run)`;
        sse(controller, "progress", {
          step: "apify",
          status: "done",
          // "Found" is the wrong verb for a number taken BEFORE the screen:
          // this counts what the scrapers returned, and the next step can and
          // does throw a whole platform's worth of it away. The per-platform
          // KEPT counts land on the `filtered` frame, which is the first
          // point in the run where they are true.
          message:
            `Scraped ${scrapedCreators} profile${scrapedCreators === 1 ? "" : "s"} from ` +
            `${platformPlan.scrape.join(", ")}, ${costLabel}` +
            (scrapeNotes.length > 0 ? `. ${scrapeNotes.join("; ")}` : ""),
          data: {
            count: scrapedCreators,
            cost: apifyCostUsd,
            cost_complete: apifyCostComplete,
            records_by_platform: recordsByPlatform,
            creators_by_platform: creatorsByPlatform,
            unsupported_platforms: platformPlan.unsupported,
          },
        });

        // ────────────────────────────────────────────────────────────────────
        // Step 4: Normalize + score + persist
        // ────────────────────────────────────────────────────────────────────
        sse(controller, "progress", {
          step: "normalize",
          status: "running",
          message: "Normalizing + scoring…",
        });

        // `profileRows` is already built: each platform's scrape produced
        // CandidateRow[] above, via candidatesFromTikTok / candidatesFromInstagram
        // in src/lib/discovery-candidates.ts. The grouping that used to live
        // here moved there when Instagram arrived, so the steps below never
        // branch on platform.

        // Rail #1b: pre-persist junk filter, now in src/lib/discovery-candidates.ts
        // so it is reachable by a test. It used to be 100 lines inline here,
        // which is how a platform-blind engagement floor sat in it silently
        // discarding every Instagram creator the run had just paid Apify for.
        //
        // The engagement floor is per platform because engagement_rate has a
        // different denominator per platform. A configured 0.03 sits below
        // the TikTok median of 0.0750 (plays-based) and ABOVE almost every
        // real Instagram rate (follower-based), so one number applied to both
        // is two very different gates. resolveEngagementFloors keeps the
        // configured value on the platform it was written for.
        const { survivors, rejected } = prefilterCandidates(profileRows, {
          followerMin,
          engagementFloors: resolveEngagementFloors(firmScrapingPrefs),
        });

        const filteredByReason: Record<string, number> = {};
        for (const rej of rejected) {
          filteredByReason[rej.reason] = (filteredByReason[rej.reason] ?? 0) + 1;
        }
        const keptByPlatform: Record<string, number> = {};
        for (const s of survivors) {
          keptByPlatform[s.platform] = (keptByPlatform[s.platform] ?? 0) + 1;
        }

        // ONE `filtered` frame for the whole run, covering every platform.
        // reduceRun REPLACES state.filters rather than summing, so a second
        // frame would silently erase the first platform's numbers from the
        // client's "we removed N accounts" line.
        sse(controller, 'filtered', {
          total_apify: profileRows.length,
          kept: survivors.length,
          filtered_total: rejected.length,
          filtered_by_reason: filteredByReason,
          kept_by_platform: keptByPlatform,
        });

        await audit(
          {
            action: 'pipeline.bot_prefilter',
            target_type: 'campaign',
            target_id: campaignId,
            firm_id: session.firm_id,
            metadata: {
              total_apify: profileRows.length,
              filtered_total: rejected.length,
              filtered_by_reason: filteredByReason,
              persisted_candidates: survivors.length,
              platforms_scraped: platformPlan.scrape,
              platforms_unsupported: platformPlan.unsupported,
              records_by_platform: recordsByPlatform,
              creators_by_platform: creatorsByPlatform,
              kept_by_platform: keptByPlatform,
              apify_cost_usd: apifyCostUsd,
              apify_cost_complete: apifyCostComplete,
            },
          },
          _req
        );

        // Swap the working set to survivors. The downstream scoring loop
        // operates on this filtered list so we never persist a profile that
        // failed the pre-filter.
        profileRows.length = 0;
        profileRows.push(...survivors);

        // Run the batch scorer once across all authors so tier/priority
        // assignment is consistent.
        const scoringInput = profileRows.map((r) => ({
          username: r.username,
          // The real platform, not a literal. This is what makes
          // target_platforms mean something: scoreAudienceFit gives +20 for a
          // platform the campaign selected and +5 otherwise, and that branch
          // has been unreachable because every candidate was stamped "tiktok"
          // while every default selection contained "tiktok".
          platform: r.platform,
          display_name: r.display_name,
          profile_url: r.profile_url,
          followers: r.followers,
          engagement_rate: r.engagement_rate,
          bio: r.bio,
          verified: r.verified,
          avatar: r.avatar_url ?? "",
          video_count: r.posts.length,
          has_contact_info: false,
          contact_email: null,
          raw_data: { posts: r.posts.slice(0, 10), authorMeta: r.author_meta },
        }));
        // Firm channel priors, loaded once for the whole run. TWO consumers
        // now: the scorer's learned response-likelihood blend (immediately
        // below) and discoverContacts' channel routing (step 5). Hoisted above
        // scoring so both read the same snapshot — one query, not two, and no
        // chance of the two steps disagreeing about the firm's funnel. Empty ⇒
        // both fall back to their cold-start behavior.
        let priors: {
          channel: string;
          sent: number;
          replies: number;
          deals: number;
          observed_sent?: number | null;
          observed_replies?: number | null;
          observed_deals?: number | null;
        }[] = [];
        try {
          // observed_* exist only after migration 043. Selecting a column that
          // does not exist fails the WHOLE query, which would silently cost
          // contact routing its priors too — so fall back to the legacy column
          // list rather than letting the scoring blend's requirement degrade
          // channel selection. Pre-043 the blend then cold-starts, which is
          // exactly right: there are no observed counters to learn from yet.
          const withObserved = await sb
            .from("channel_conversion_priors")
            .select(
              "channel, sent, replies, deals, observed_sent, observed_replies, observed_deals"
            )
            .eq("firm_id", session.firm_id);
          if (withObserved.error) {
            const legacy = await sb
              .from("channel_conversion_priors")
              .select("channel, sent, replies, deals")
              .eq("firm_id", session.firm_id);
            priors = (legacy.data ?? []) as typeof priors;
          } else {
            priors = (withObserved.data ?? []) as typeof priors;
          }
        } catch {
          priors = [];
        }

        const scoring = scoreInfluencers(
          scoringInput,
          {
            genre,
            target_platforms: c.target_platforms ?? ["tiktok"],
            urgency: c.urgency,
            artist_name: c.artist_name,
            // Bound the persisted estimate by the campaign's own ceiling.
            // price_estimate_mid is quoted verbatim to the creator during
            // negotiation (outreach.ts), so an unbounded value could name a
            // figure above what this campaign is authorized to pay.
            per_creator_cap_usd:
              (c as { per_creator_cap_usd?: number | null }).per_creator_cap_usd ?? null,
          },
          { priors }
        );
        // Keyed by PLATFORM + username, never username alone.
        //
        // One run now legitimately holds candidates from two platforms, and a
        // creator using the same handle on both is ordinary, not an edge case.
        // Keyed on the bare username, `new Map` silently keeps only the last
        // entry — so one platform's campaign_influencers row would receive the
        // OTHER platform's composite_score, tier, bot_flagged and
        // price_estimate_mid. That last one is quoted verbatim to the creator
        // during negotiation, so the collision does not stay inside the
        // database. A pool with only TikTok rows never collides; adding
        // Instagram discovery is what makes it reachable.
        const scoredByCandidate = new Map(
          scoring.ranked_influencers.map((s) => [candidateKey(s.platform, s.username), s])
        );

        const persisted: {
          id: string;
          username: string;
          score: number;
          platform: string;
        }[] = [];
        for (const row of profileRows) {
          const scored = scoredByCandidate.get(candidateKey(row.platform, row.username));
          if (!scored) continue;

          // Upsert influencer
          const { data: up, error: upErr } = await sb
            .from("influencers")
            .upsert(row.db_row as never, { onConflict: "platform,username" })
            .select("id")
            .single();
          if (upErr || !up) {
            log.error("influencer upsert failed", {
              username: row.username,
              error: upErr?.message,
            });
            continue;
          }

          const score = scored.composite_score;
          const upsertCi = await sb
            .from("campaign_influencers")
            .upsert(
              {
                campaign_id: campaignId,
                influencer_id: (up as { id: string }).id,
                composite_score: score,
                score_breakdown: scored.score_breakdown,
                tier: scored.tier,
                price_estimate_low: scored.price_estimate.low,
                price_estimate_mid: scored.price_estimate.mid,
                price_estimate_high: scored.price_estimate.high,
                outreach_priority: scored.outreach_priority,
                outreach_angle: scored.outreach_angle,
                bot_flagged: scored.bot_flagged,
                primary_channel: scored.contact_email ? "email" : "dm",
                channel_confidence: scored.contact_email ? 0.85 : 0.5,
                status: "queued",
              } as never,
              { onConflict: "campaign_id,influencer_id" }
            );
          if (upsertCi.error) {
            log.error("campaign_influencers upsert failed", {
              username: row.username,
              error: upsertCi.error.message,
            });
            continue;
          }
          persisted.push({
            id: (up as { id: string }).id,
            username: row.username,
            score,
            platform: row.platform,
          });
        }

        // Post-persist reality, per platform. The apify step's number is
        // pre-screen and the two can differ by an entire platform, so this is
        // the one the operator should be reading.
        const persistedByPlatform: Record<string, number> = {};
        for (const pl of platformPlan.scrape) persistedByPlatform[pl] = 0;
        for (const p of persisted) {
          persistedByPlatform[p.platform] = (persistedByPlatform[p.platform] ?? 0) + 1;
        }
        const persistedSplit = describeKeptByPlatform(persistedByPlatform);

        const top = persisted
          .sort((a, b) => b.score - a.score)
          .slice(0, 50);
        sse(controller, "progress", {
          step: "normalize",
          status: "done",
          message:
            `Persisted ${persisted.length} creators` +
            (persistedSplit ? ` (${persistedSplit})` : ""),
          data: {
            count: persisted.length,
            by_platform: persistedByPlatform,
            top: top.slice(0, 10),
          },
        });

        // ────────────────────────────────────────────────────────────────────
        // Step 4b: Comment-quality audit (migration 066)
        //
        // Only when campaigns.comment_audit_enabled. The top 20 non-bot
        // creators get their recent comments labelled; a creator consistently
        // dogged on in their comments is flagged (composite × 0.85, lower
        // offer + ceiling) or held (no first touch until a human overrides).
        // Hard spend cap, wall-clock budget, 30-day reuse: comment-audit-run.ts.
        // Pre-066 or toggle off: returns at once, nothing spent. Any failure
        // leaves every creator exactly as scored.
        // ────────────────────────────────────────────────────────────────────
        try {
          const auditBudgetMs = Math.min(
            COMMENT_AUDIT_TIME_BUDGET_MS,
            PIPELINE_TIMEOUT_MS - (Date.now() - pipelineStartMs) - COMMENT_AUDIT_RESERVE_FOR_LATER_STEPS_MS,
          );
          if (auditBudgetMs >= 15_000) {
            const rowByKey = new Map(profileRows.map((r) => [candidateKey(r.platform, r.username), r]));
            const auditCandidates: AuditCandidate[] = persisted.map((p) => ({
              influencer_id: p.id,
              platform: p.platform,
              username: p.username,
              raw_data: rowByKey.get(candidateKey(p.platform, p.username))?.db_row.raw_data ?? null,
              composite: p.score,
              bot_flagged: scoredByCandidate.get(candidateKey(p.platform, p.username))?.bot_flagged === true,
            }));
            const auditSummary = await runCommentAudits(
              {
                sb,
                provider: selectCommentsProvider(),
                classify: (p) => complete(p),
                ledger: recordApiCall,
                modelLabel: activeModelLabel(),
              },
              auditCandidates,
              {
                campaignId,
                spendCapUsd: COMMENT_AUDIT_SPEND_CAP_USD,
                timeBudgetMs: auditBudgetMs,
                fetchTimeoutSecs: Math.max(15, Math.floor((auditBudgetMs - 10_000) / 1000)),
              },
            );
            if (auditSummary.state === "ran") {
              // Later steps (contact discovery) order by score: use the
              // audited composite.
              for (const r of auditSummary.results) {
                if (r.composite == null) continue;
                const p = persisted.find((x) => x.id === r.influencer_id && x.platform === r.platform);
                if (p) p.score = r.composite;
              }
              sse(controller, "progress", {
                step: "comment_audit",
                status: "done",
                message: describeAuditSummary(auditSummary),
                data: {
                  provider: auditSummary.provider,
                  checked: auditSummary.audited + auditSummary.reused,
                  reused: auditSummary.reused,
                  flagged: auditSummary.flagged,
                  held: auditSummary.held,
                  insufficient: auditSummary.insufficient,
                  not_checked: auditSummary.skipped_budget + auditSummary.skipped_time,
                  failed: auditSummary.failed,
                  spend_usd: auditSummary.spend_usd,
                  cap_usd: auditSummary.cap_usd,
                },
              });
              await audit(
                {
                  action: "pipeline.comment_audit",
                  target_type: "campaign",
                  target_id: campaignId,
                  firm_id: session.firm_id,
                  metadata: {
                    provider: auditSummary.provider,
                    considered: auditSummary.considered,
                    audited: auditSummary.audited,
                    reused: auditSummary.reused,
                    flagged: auditSummary.flagged,
                    held: auditSummary.held,
                    insufficient: auditSummary.insufficient,
                    skipped_budget: auditSummary.skipped_budget,
                    skipped_time: auditSummary.skipped_time,
                    failed: auditSummary.failed,
                    spend_usd: auditSummary.spend_usd,
                    cap_usd: auditSummary.cap_usd,
                    notes: auditSummary.notes.slice(0, 20),
                  },
                },
                _req
              );
            }
          }
        } catch (e) {
          log.error("comment audit step error", { error: (e as Error).message });
        }

        // ────────────────────────────────────────────────────────────────────
        // Step 5: Contact discovery + highest-converting-channel recommendation
        //
        // For the top-scored creators: discoverContacts runs bio-regex → LLM
        // (ONLY when regex found no email) → bio-link fetch, persists candidates
        // to creator_contacts (idempotent), and stamps the recommended channel
        // onto campaign_influencers.primary_channel. Everything here is
        // cost/latency-bounded (top-N cap + LLM-call cap) and fully wrapped so a
        // bio-link timeout or LLM hiccup can NEVER block or fail the pipeline.
        // ────────────────────────────────────────────────────────────────────
        try {
          const profileByCandidate = new Map(
            profileRows.map((r) => [candidateKey(r.platform, r.username), r])
          );

          // `priors` is loaded once above, before scoring — the scorer's
          // response-likelihood blend and this step's channel routing read the
          // same snapshot. Empty → discoverContacts uses the cold-start order
          // (email > ig_dm > tt_dm).

          const CONTACTS_MAX_CREATORS = 25;
          const CONTACTS_LLM_CAP = 15;
          // Hard wall-clock ceiling on the whole step so a slow batch of
          // bio-link fetches can never push the route toward its maxDuration.
          const CONTACTS_TIME_BUDGET_MS = 60_000;
          const contactsStartMs = Date.now();
          let contactsLlmCalls = 0;
          let emailsFound = 0;
          let contactsProcessed = 0;

          const discoverTargets = persisted
            .slice()
            .sort((a, b) => b.score - a.score)
            .slice(0, CONTACTS_MAX_CREATORS);

          for (const p of discoverTargets) {
            if (Date.now() - contactsStartMs > CONTACTS_TIME_BUDGET_MS) break;
            const row = profileByCandidate.get(candidateKey(p.platform, p.username));
            if (!row) continue;
            contactsProcessed += 1;
            try {
              const { candidates, best_channel } = await discoverContacts(
                {
                  username: row.username,
                  platform: row.platform,
                  bio: row.bio,
                  raw_data: row.db_row.raw_data as
                    | Record<string, unknown>
                    | null,
                  contact_email: null,
                },
                {
                  supabase: sb,
                  influencerId: p.id,
                  campaignId,
                  priors,
                  // One bio-link fetch per creator bounds worst-case latency.
                  maxBioLinks: 1,
                  enableLlm: contactsLlmCalls < CONTACTS_LLM_CAP,
                  onLlmCall: () => {
                    contactsLlmCalls += 1;
                    openaiTotalUsd += 0.001;
                  },
                }
              );

              const bestEmail =
                candidates.find((c) => c.channel === "email")?.address ?? null;
              const bestConf =
                candidates.find((c) => c.channel === best_channel)?.confidence ??
                null;

              // Stamp the highest-converting channel recommendation onto the CI.
              await sb
                .from("campaign_influencers")
                .update({
                  primary_channel: best_channel,
                  ...(bestConf != null ? { channel_confidence: bestConf } : {}),
                } as never)
                .eq("campaign_id", campaignId)
                .eq("influencer_id", p.id);

              // Backfill a discovered email onto the shared influencer ONLY when
              // it has none — never clobber a real contact.
              if (bestEmail) {
                emailsFound += 1;
                await sb
                  .from("influencers")
                  .update({ contact_email: bestEmail } as never)
                  .eq("id", p.id)
                  .is("contact_email", null);
              }
            } catch (e) {
              log.error("contact discovery failed", {
                username: p.username,
                error: (e as Error).message,
              });
            }
          }

          sse(controller, "contacts", {
            processed: contactsProcessed,
            emails_found: emailsFound,
            llm_calls: contactsLlmCalls,
          });
        } catch (e) {
          // Best-effort — the pipeline is already "done" persisting creators.
          log.error("contact discovery step error", { error: (e as Error).message });
        }

        // ────────────────────────────────────────────────────────────────────
        // Step 6: qualification pass
        //
        // Phase A — deterministic screening of EVERY persisted creator, no
        // model calls: the per-firm pool gates (follower cap + audience-fit
        // minimum from firms.scraping_prefs) and the free
        // qualify pre-checks (no posts / abandoned / music-artist bio
        // signals). This is what closes most of the unreviewed
        // backlog at zero LLM cost.
        //
        // Phase B — ONE qualifyCreator() LLM call per creator for the top
        // slice of whatever Phase A left standing, same caps as before.
        //
        // Exclusion is fail-closed on confidence (statusForVerdict) and the
        // whole step is best-effort — a model hiccup can NEVER block or fail
        // the pipeline; rows simply stay 'unreviewed'.
        // ────────────────────────────────────────────────────────────────────
        try {
          const QUALIFY_MAX_CREATORS = 25;
          const QUALIFY_LLM_CAP = 25;
          const QUALIFY_TIME_BUDGET_MS = 45_000;
          // Static per-call estimate (small prompt, ~100 output tokens on
          // gemini-flash-class models). Counted into the run's OpenAI budget.
          const QUALIFY_COST_PER_CALL_USD = 0.001;
          const qualifyStartMs = Date.now();
          let qualifyLlmCalls = 0;
          let qualifyProcessed = 0;
          let llmReviewed = 0;
          let qualifyExcluded = 0;
          let gateExcluded = 0;
          let languageExcluded = 0;

          // `gatePrefs` is parsed once at the top of the run, beside genre and
          // the follower bounds. It used to be parsed here, which was fine
          // while nothing upstream needed it; the region prompt does.

          // The geo/language split for this run. Filled for EVERY
          // creator screened, including the ones the gate keeps, so the report
          // can say how many were placed versus how many simply could not be.
          const regionReport = emptyRegionReport(gatePrefs.region);

          const qualifyProfileByCandidate = new Map(
            profileRows.map((r) => [candidateKey(r.platform, r.username), r])
          );
          const excludedIds = new Set<string>();

          // influencers.blocklisted — a human's explicit do-not-contact. The
          // upsert above never writes this column, so an existing blocklisted
          // creator keeps the flag and must be screened out here rather than
          // re-entering the pool on every rediscovery.
          const { data: blockRows } = await sb
            .from("influencers")
            .select("id, blocklisted")
            .in("id", persisted.map((p) => p.id));
          const blocklistedIds = new Set(
            ((blockRows ?? []) as { id: string; blocklisted: boolean | null }[])
              .filter((r) => r.blocklisted === true)
              .map((r) => r.id)
          );
          // ...and THIS label's own blocks (migration 056): a creator who
          // replied STOP to this firm, or that this firm blocked. Another
          // label's block is not ours. Unreadable → global flag only, logged:
          // this pass persists exclusions, and the send paths re-check and
          // fail closed.
          const firmBlocks = await readFirmBlocks(
            sb,
            session.firm_id,
            persisted.map((p) => p.id)
          );
          if (firmBlocks.state === "unreadable") {
            console.error("[run] firm block list unreadable — screening on the global flag only", firmBlocks.message);
          }
          for (const id of firmBlocks.ids) blocklistedIds.add(id);

          sse(controller, "progress", {
            step: "qualify",
            status: "running",
            message: `Screening all ${persisted.length} creators, then qualifying the top ranked…`,
          });

          const profileInputFor = (row: (typeof profileRows)[number]) => ({
            username: row.username,
            display_name: row.display_name,
            bio: row.bio,
            followers: row.followers,
            following: row.following,
            engagement_rate: row.engagement_rate,
            verified: row.verified,
            raw_data: row.db_row.raw_data as {
              posts?: QualifyRawPost[];
            } | null,
            campaign: {
              // 83: attributes this call's model spend in api_ledger.
              id: campaignId,
              artist_name: c.artist_name,
              track_name: c.track_name ?? null,
              genre: genre ?? null,
            },
          });

          // Phase A: deterministic, whole pool, no model calls.
          for (const p of persisted) {
            if (Date.now() - qualifyStartMs > QUALIFY_TIME_BUDGET_MS) break;
            const row = qualifyProfileByCandidate.get(candidateKey(p.platform, p.username));
            if (!row) continue;
            // Counted HERE, not in Phase B. Phase B only ever sees a subset of
            // what Phase A screened, so incrementing there while Phase A fed
            // the exclusion counters could report more excluded than
            // processed — an impossible number in an audit row.
            qualifyProcessed += 1;
            try {
              const scored = scoredByCandidate.get(candidateKey(p.platform, p.username));
              // Place the creator against the firm's region. Tallied for
              // everyone, gate or no gate: a report that only counted the
              // creators it removed could not tell "we checked 40 and ruled
              // out 3" from "we could only read 3 of them".
              const regionSignal = readCreatorRegionSignal(row.db_row.raw_data);
              const regionAssessment = assessCreatorRegion(
                regionSignal,
                gatePrefs.region
              );
              tallyRegion(regionReport, regionSignal, regionAssessment);
              const gate = poolGateExclusion(
                {
                  followers: row.followers,
                  audience_fit: scored?.score_breakdown.audience_fit ?? null,
                  blocklisted: blocklistedIds.has(p.id),
                  region_assessment: regionAssessment,
                },
                gatePrefs
              );
              if (gate?.gate === "audience_language") languageExcluded += 1;
              let patch:
                | {
                    qualification_status: string;
                    qualification_reason: string;
                    qualification_confidence: number;
                  }
                | null = null;
              if (gate) {
                patch = gateExclusionPatch(gate);
              } else {
                // enableLlm:false → only the deterministic pre-checks run
                // (zero posts / abandoned / music-artist). Free.
                const verdict = await qualifyCreator(profileInputFor(row), {
                  enableLlm: false,
                  excludeMusicArtists: gatePrefs.exclude_music_artists,
                });
                const status = statusForVerdict(verdict);
                if (status !== "unreviewed") {
                  patch = {
                    qualification_status: status,
                    qualification_reason: verdict.reason,
                    qualification_confidence: verdict.confidence,
                  };
                }
              }
              if (!patch) continue;
              if (patch.qualification_status === "excluded") {
                excludedIds.add(p.id);
                if (gate) gateExcluded += 1;
                else qualifyExcluded += 1;
              }
              await sb
                .from("campaign_influencers")
                .update(patch as never)
                .eq("campaign_id", campaignId)
                .eq("influencer_id", p.id);
            } catch (e) {
              log.error("deterministic screening failed", {
                username: p.username,
                error: (e as Error).message,
              });
            }
          }

          // Phase B: LLM qualification for the top slice of the survivors —
          // never spend a model call on a row a gate already excluded.
          const qualifyTargets = persisted
            .filter((p) => !excludedIds.has(p.id))
            .sort((a, b) => b.score - a.score)
            .slice(0, QUALIFY_MAX_CREATORS);

          for (const p of qualifyTargets) {
            if (Date.now() - qualifyStartMs > QUALIFY_TIME_BUDGET_MS) break;
            const row = qualifyProfileByCandidate.get(candidateKey(p.platform, p.username));
            if (!row) continue;
            llmReviewed += 1;
            try {
              const verdict = await qualifyCreator(profileInputFor(row), {
                enableLlm: qualifyLlmCalls < QUALIFY_LLM_CAP,
                excludeMusicArtists: gatePrefs.exclude_music_artists,
                onLlmCall: () => {
                  qualifyLlmCalls += 1;
                  openaiTotalUsd += QUALIFY_COST_PER_CALL_USD;
                },
              });

              const status = statusForVerdict(verdict);
              if (status === "unreviewed") continue; // leave the row's default
              if (status === "excluded") qualifyExcluded += 1;
              await sb
                .from("campaign_influencers")
                .update({
                  qualification_status: status,
                  qualification_reason: verdict.reason,
                  qualification_confidence: verdict.confidence,
                } as never)
                .eq("campaign_id", campaignId)
                .eq("influencer_id", p.id);
            } catch (e) {
              log.error("qualification failed", {
                username: p.username,
                error: (e as Error).message,
              });
            }
          }

          sse(controller, "qualification", {
            processed: qualifyProcessed,
            excluded: qualifyExcluded + gateExcluded,
            gate_excluded: gateExcluded,
            language_excluded: languageExcluded,
            llm_reviewed: llmReviewed,
            llm_calls: qualifyLlmCalls,
            region: regionReport,
          });

          await audit(
            {
              action: "pipeline.qualification",
              target_type: "campaign",
              target_id: campaignId,
              firm_id: session.firm_id,
              metadata: {
                processed: qualifyProcessed,
                excluded: qualifyExcluded + gateExcluded,
                gate_excluded: gateExcluded,
                language_excluded: languageExcluded,
                llm_reviewed: llmReviewed,
                llm_calls: qualifyLlmCalls,
                llm_cap: QUALIFY_LLM_CAP,
                est_cost_usd: qualifyLlmCalls * QUALIFY_COST_PER_CALL_USD,
                gate_prefs: {
                  follower_max: gatePrefs.follower_max,
                  audience_fit_min: gatePrefs.audience_fit_min,
                  exclude_music_artists: gatePrefs.exclude_music_artists,
                  region: gatePrefs.region?.raw ?? null,
                  region_matched: gatePrefs.region?.matched ?? null,
                  region_languages: gatePrefs.region?.languages ?? [],
                  region_gate_active: regionGateActive(gatePrefs.region),
                },
                region: regionReport,
              },
            },
            _req
          );
        } catch (e) {
          // Best-effort for the PIPELINE — unqualified rows stay 'unreviewed'
          // and pitchable, and the run still completes. Best-effort for the
          // SCREEN is a different thing, and this catch used to do it: it
          // logged to a server console nobody watching a demo can see, and the
          // `done` frame below then swept the spinning qualify step to a green
          // check at 100%. The run is allowed to survive this; the progress
          // display is not allowed to claim the step succeeded.
          log.error("qualification step error", { error: (e as Error).message });
          try {
            sse(controller, "progress", {
              step: "qualify",
              status: "error",
              message:
                "Qualifying didn’t finish. The creators found are still on the list; they just haven’t been screened for fit.",
            });
          } catch {
            // The controller can already be closed (client navigated away).
            // Failing to report a failure must not become a second failure.
          }
        }

        // Mark campaign as discovered
        await sb
          .from("campaigns")
          .update({
            status: "discovered",
            target_count: persisted.length,
          } as never)
          .eq("id", campaignId);

        sse(controller, "done", {
          campaign_id: campaignId,
          total: persisted.length,
        });
      } catch (e) {
        log.error("pipeline run failed", { error: e as Error });
        sse(controller, "error", { message: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
