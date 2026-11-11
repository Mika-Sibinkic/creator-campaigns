// src/lib/measurement-tick.ts
//
// Measurement runtime: for each posted deal, verify delivery + snapshot the
// post's performance on the ~1wk-then-monthly cadence (measurement.ts), scraping
// current metrics via Apify (matched back to the deal's post_url). Spend-capped
// per tick. Fired by the same scheduler as the negotiation tick. Never throws on
// a single bad deal — a poison row is skipped, not fatal.
//
// Delivery checks:
//   - deliverable-spec verification: when the scrape finds the post, its type/
//     duration is compared against creator_offers.agreed_deliverables and the
//     result stamped on deal_deliveries.spec_check (status semantics untouched);
//   - artist stream polling: campaigns confirmed with a Soundcharts UUID get
//     their Spotify monthly listeners polled into artist_metric_snapshots.
//
// Artist polling: the artist poll runs on its own DAILY cadence
// (not the week-then-monthly delivery rhythm), backfills every day in the
// returned window rather than a single point, keys rows on metric_date, and
// records each Soundcharts call to api_ledger. See pollArtistMetrics below for
// why each of those is load-bearing rather than tidying.

// Spend control: the delivery pass
//   - never selects an offer belonging to a synthetic ([SAMPLE]) campaign,
//   - records every Apify scrape it makes to api_ledger with its real cost,
//   - backs off and eventually gives up on a post_url that never resolves.
// See MEASUREMENT_ENDPOINT below for why the ledger is also the retry memory.

import type { SupabaseClient } from '@supabase/supabase-js';
import { PAID_STATES } from './analytics';
import { resolveCampaignWindow, measurementAllowedAt, windowOffsets } from './campaign-window';
import { scrapeTikTok, type TikTokProfile } from './apify';
import { labelCpm, latestSnapshot, totalReach, type PerformanceSnapshot } from './cpm-model';
import {
  isSnapshotDue,
  matchPost,
  postMetrics,
  checkDeliverableSpec,
  resolveAttemptDue,
} from './measurement';
import { normalizeDeliverables } from './deliverables';
import { writeDealCpmRecord } from './deal-cpm-records';
import {
  soundchartsConfigured,
  getSpotifyListeners,
  latestSeriesValue,
  scDay,
  type ScResult,
  type ScListeningSeries,
} from './soundcharts';
// Type-only: api-ledger pulls in ./supabase, which constructs a client at
// module-evaluation time and throws without env. A static import would make
// every hermetic test importing this module blow up at load. The real writer is
// resolved lazily below, only when no `recordCall` dep was injected.
import type { LedgerEntry } from './api-ledger';
// Same arrangement for the audit writer: type-only import, lazy default.
import type { AuditEntry } from './audit';

/**
 * api_ledger.endpoint for the delivery-verification scrape.
 *
 * Distinct from the discovery run's 'tiktok-scraper' on purpose, and it does
 * double duty. Both rows are source='apify', so the per-firm daily cap in
 * api/campaigns/[id]/run/route.ts sums them together (which is the point — the
 * tick was spending against that cap invisibly). The separate endpoint string
 * is what lets THIS module read back its own attempt history: the ledger is the
 * retry memory, so the backoff needs no new column and works against the schema
 * as it stands today.
 */
export const MEASUREMENT_ENDPOINT = 'tiktok-scraper-measurement';

export interface MeasurementTally {
  considered: number;
  scraped: number;
  snapshots: number;
  verified: number;
  skipped: number;
  /** Real Apify dollars spent by this tick — was silently discarded before. */
  costUsd: number;
  /** Deliveries whose retry backoff had not elapsed; deliberately not scraped. */
  backoff: number;
  /** Deliveries that hit the attempt ceiling this tick and were marked `missing`. */
  unresolvable: number;
  /** Soundcharts artist polls performed this tick. */
  artistPolls: number;
  /** Artist polls skipped (env absent, empty series, or a poison row). */
  artistSkipped: number;
  /** artist_metric_snapshots rows written this tick. */
  artistSnapshots: number;
  /** cpm_snapshots rows written/refreshed this tick (migration 042). */
  cpmSnapshots: number;
  /** Split-settlement deals closed this tick because the agreed delivery window
   *  passed with no post (migration 052). Zero until a firm enables the split. */
  undelivered: number;
  /** deal_cpm_records rows created or refreshed this tick (CPM slice S4, migration 062). */
  dealCpmRecords: number;
}

export interface MeasurementDeps {
  now?: number;
  /**
   * Set false to skip the delivery-expiry sweeper (migration 052).
   *
   * Exists for hermetic tests: the sweeper's candidate query uses `.not()` and
   * `.lte()`, which the in-memory Supabase double does not model, so the pass
   * throws a TypeError, gets caught, and logs — correct behaviour, but it
   * printed a failure line into every green test run. Tests opt out; production
   * leaves it on.
   */
  expireUndelivered?: boolean;
  /** max profile scrapes per tick — the spend cap (Apify costs per run). */
  maxScrapes?: number;
  /**
   * Injectable scraper for tests; default = real Apify.
   *
   * Returns the whole result, not just `.profiles`. The old shape destructured
   * `.profiles` at the call site and threw `costUsd` away, which is precisely
   * how this tick spent real money without a single ledger row.
   */
  scrape?: (handle: string) => Promise<{
    profiles: TikTokProfile[];
    costUsd: number;
    runId?: string;
  }>;
  /** max Soundcharts artist polls per tick. */
  maxArtistPolls?: number;
  /** injectable listeners fetch for tests; default = real Soundcharts. */
  fetchListeners?: (
    uuid: string,
    startDate?: string,
    endDate?: string,
  ) => Promise<ScResult<ScListeningSeries>>;
  /** override the SOUNDCHARTS_* env gate for tests. */
  soundchartsEnabled?: boolean;
  /** injectable api_ledger writer; default = real recordApiCall. */
  recordCall?: (e: LedgerEntry) => Promise<void>;
  /** injectable audit writer; default = real audit() (lazy import). */
  auditFn?: (e: AuditEntry) => Promise<void>;
}

interface PostedOffer {
  id: string;
  firm_id: string | null;
  campaign_id: string | null;
  campaign_influencer_id: string | null;
  post_url: string | null;
  posted_at: string | null;
  agreed_deliverables: unknown;
}

export async function runMeasurementTick(
  sb: SupabaseClient,
  deps: MeasurementDeps = {},
): Promise<MeasurementTally> {
  const now = deps.now ?? Date.now();
  const maxScrapes = deps.maxScrapes ?? 5;
  const scrape = deps.scrape ?? ((handle: string) => scrapeTikTok({ profiles: [handle] }));
  const record =
    deps.recordCall ??
    (async (e: LedgerEntry) => {
      const { recordApiCall } = await import('./api-ledger');
      await recordApiCall(e);
    });
  // Delivery status transitions get an immutable audit trail. Before this,
  // deal_deliveries wrote no audit rows at all — statuses.ts synthesizes
  // `delivery.*` timeline events from the table because there was nothing in
  // audit_log to read. The table view shows only the CURRENT status; the
  // audit rows are the when-and-why of each pending→verified→missing flip.
  // Write-then-don't-throw, and the guard is on the CALL SITE, not just on the
  // default writer. An earlier shape wrapped only the default in try/catch,
  // which left the injected `deps.auditFn` path unguarded — so a caller's
  // writer that rejected would abort the whole offer mid-pass. The expensive
  // version of that: the `delivery.verified` write happens AFTER the Apify
  // scrape has been paid for and ledgered, so a throw there discarded a
  // result we had already spent money on, under-reported the tally, and — the
  // row now being `verified` — suppressed the audit row forever while the next
  // tick paid for the scrape again. An audit gap must never cost a
  // verification, let alone a duplicate scrape charge.
  const auditImpl =
    deps.auditFn ??
    (async (e: AuditEntry) => {
      const { audit } = await import('./audit');
      await audit(e);
    });
  const auditWrite = async (e: AuditEntry) => {
    try {
      await auditImpl(e);
    } catch {
      // No env, no DB, or a caller-supplied writer that threw. Swallowed by
      // design — the measurement pass is the valuable work; the trail is not
      // worth failing it over.
    }
  };

  const tally: MeasurementTally = {
    considered: 0,
    scraped: 0,
    snapshots: 0,
    verified: 0,
    skipped: 0,
    costUsd: 0,
    backoff: 0,
    unresolvable: 0,
    artistPolls: 0,
    artistSkipped: 0,
    artistSnapshots: 0,
    cpmSnapshots: 0,
    undelivered: 0,
    dealCpmRecords: 0,
  };

  // ── Layer 1: never scrape a fabricated row ────────────────────────────────
  //
  // `creator_offers` has no synthetic column, but it does carry campaign_id
  // (migration 009), so the [SAMPLE] seed's campaigns are one hop away. Fetch
  // the synthetic ids (a handful — migration 021 indexes exactly this
  // predicate) and exclude them IN THE QUERY. Not a post-filter: a post-filter
  // still lets a fabricated row occupy a slot in the maxScrapes budget, which
  // is half of what made this leak starve real deals.
  //
  // FAIL CLOSED, matching negotiation.ts's RL-history exclusion: if we cannot
  // prove which campaigns are fabricated, we scrape nothing this tick. A
  // skipped hour costs nothing; a wrong guess costs Apify credit.
  const { data: synthRows, error: synthErr } = await sb
    .from('campaigns')
    .select('id')
    .eq('synthetic', true);
  if (synthErr) {
    await pollArtistMetrics(sb, deps, now, tally);
    return tally;
  }
  const syntheticCampaignIds = ((synthRows as Array<{ id: string }> | null) ?? []).map(
    (r) => r.id,
  );


  const offersQuery = sb
    .from('creator_offers')
    .select(
      'id, firm_id, campaign_id, campaign_influencer_id, post_url, posted_at, agreed_deliverables',
    )
    .not('post_url', 'is', null);
  // Ternary rather than reassigning `offersQuery`: PostgrestFilterBuilder is
  // self-referential, and a `let` that re-assigns a further-narrowed builder
  // makes tsc give up with TS2589 (excessively deep instantiation).
  const { data } =
    syntheticCampaignIds.length > 0
      ? await offersQuery.not('campaign_id', 'in', `(${syntheticCampaignIds.join(',')})`)
      : await offersQuery;
  const offers = (data ?? []) as PostedOffer[];

  // ── Campaign window — gates the REFRESH, not the resolution ───────────────
  //
  // The first version of this gate excluded window-closed campaigns from the
  // query above. That made `deal_deliveries.status = 'missing'` UNREACHABLE:
  // the only writer of it lives inside this loop, so a delivery stuck at
  // 'pending' when the window closed could never terminalize. Downstream,
  // repeat-collaborators and creator-performance both bucket 'pending'
  // separately from 'missing' with `else` as the pending catch-all — so a
  // creator who took payment and never posted read as "still pending" forever,
  // and the only honest non-delivery signal the CPM ranking has stayed 0.
  //
  // It also could not be fixed by "letting the give-up run outside the window":
  // resolveAttemptDue only returns 'give_up' at >= MAX_RESOLVE_ATTEMPTS, and
  // attempts are api_ledger rows that exist only because a scrape happened.
  // Gate the scrape and the attempt count freezes below the threshold, so
  // 'give_up' is never reached no matter how long we wait.
  //
  // What is actually unbounded is the REFRESH of an already-verified delivery:
  // isSnapshotDue says "monthly" forever, so a campaign from last year keeps
  // costing Apify credit every month, permanently. The resolution path
  // is already bounded — at most MAX_RESOLVE_ATTEMPTS scrapes per offer, ever,
  // and then it terminalizes on its own.
  //
  // So the window gates re-snapshotting a VERIFIED delivery, and leaves the
  // pending → verified/missing resolution alone. Bounded cost either way, and
  // every delivery still reaches a terminal state.
  //
  // Scoped to the campaigns of the offers actually in hand, not every
  // release-dated campaign in the database — the previous shape serialized an
  // unbounded id list into a NOT IN URL that reached the 414 region at a few
  // hundred campaigns.
  const offerCampaignIds = [...new Set(offers.map((o) => o.campaign_id).filter(Boolean))] as string[];
  const windowByCampaign = new Map<string, boolean>(); // campaign_id → measurement allowed
  if (offerCampaignIds.length > 0) {
    const { data: campRows, error: campErr } = await sb
      .from('campaigns')
      .select('id, firm_id, release_date, created_at')
      .in('id', offerCampaignIds);
    if (!campErr) {
      const camps = (campRows ?? []) as Array<{
        id: string;
        firm_id: string | null;
        release_date: string | null;
        created_at: string | null;
      }>;
      const firmIds = [...new Set(camps.map((c) => c.firm_id).filter(Boolean))] as string[];
      const { data: firmRows } = firmIds.length
        ? await sb.from('firms').select('id, outreach_prefs').in('id', firmIds)
        : { data: [] };
      const offsetsByFirm = new Map(
        ((firmRows ?? []) as Array<{ id: string; outreach_prefs: unknown }>).map((r) => [
          r.id,
          windowOffsets(r.outreach_prefs),
        ]),
      );
      for (const c of camps) {
        const offsets = c.firm_id ? offsetsByFirm.get(c.firm_id) : undefined;
        const { window: w } = resolveCampaignWindow({
          releaseDate: c.release_date,
          createdAt: c.created_at,
          offsets: offsets ?? windowOffsets(undefined),
        });
        windowByCampaign.set(c.id, measurementAllowedAt(w, now));
      }
    }
    // A read error leaves the map empty → every lookup below defaults to
    // allowed. Measuring a finished campaign once more costs a few cents;
    // wrongly skipping a live one corrupts the delivery record.
  }

  // ── Layer 3 (read side): how many times has each of these already missed? ──
  //
  // One query, not one per offer. Fail closed again — an unreadable ledger
  // means an unknown attempt count, and retrying on an unknown count is
  // exactly the infinite loop being fixed.
  const attempts = await loadResolveAttempts(sb);
  if (!attempts) {
    await pollArtistMetrics(sb, deps, now, tally);
    return tally;
  }

  let ledgerBroken = false;
  // Campaigns that received a new performance snapshot this tick — the set the
  // CPM time-series writer refreshes after the loop.
  const cpmTouched = new Set<string>();
  for (const offer of offers) {
    if (ledgerBroken) break;
    if (tally.scraped >= maxScrapes) break;
    tally.considered += 1;
    if (!offer.post_url || !offer.firm_id) {
      tally.skipped += 1;
      continue;
    }
    try {
      // 1. Ensure a delivery row (idempotent on offer+post_url). Inserted as
      //    'pending' — a pasted URL is a claim, not a verification.
      const delivery = await ensureDelivery(sb, offer, now);
      if (!delivery) {
        tally.skipped += 1;
        continue;
      }
      const deliveryId = delivery.id;
      if (delivery.created) {
        await auditWrite({
          action: 'delivery.pending',
          actor_label: 'system:measurement-tick',
          target_type: 'deal_delivery',
          target_id: deliveryId,
          firm_id: offer.firm_id,
          metadata: { creator_offer_id: offer.id, post_url: offer.post_url },
        });
      }
      // Already given up on. Terminal — don't re-derive the verdict every hour.
      if (delivery.status === 'missing') continue;

      // 2. Snapshot due? (first ~1wk after post, then monthly.)
      const detectedMs = Date.parse(offer.posted_at ?? '') || now;
      const { data: lastSnap } = await sb
        .from('deal_performance_snapshots')
        .select('captured_at')
        .eq('deal_delivery_id', deliveryId)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const lastMs = lastSnap
        ? Date.parse((lastSnap as { captured_at: string }).captured_at)
        : null;
      if (!isSnapshotDue(detectedMs, lastMs, now)) continue;

      // Window closed + already verified → stop re-snapshotting. This is the
      // unbounded cost the window exists to stop. A delivery that is still
      // 'pending' deliberately falls through: it must be allowed to reach
      // 'missing', which is bounded at MAX_RESOLVE_ATTEMPTS scrapes.
      const measurable = offer.campaign_id
        ? (windowByCampaign.get(offer.campaign_id) ?? true)
        : true;
      if (!measurable && delivery.status === 'verified') {
        tally.skipped += 1;
        continue;
      }

      // 2b. Has this post already refused to resolve? isSnapshotDue cannot
      //     tell — a miss writes no snapshot, so it stays "due" forever.
      //     Attempts counted since the last successful snapshot, so a post
      //     that resolves once starts clean if it later disappears.
      const prior = (attempts.get(offer.id) ?? []).filter(
        (ms) => lastMs == null || ms > lastMs,
      );
      const lastAttemptMs = prior.length ? Math.max(...prior) : null;
      const decision = resolveAttemptDue(prior.length, lastAttemptMs, now);
      if (decision === 'wait') {
        tally.backoff += 1;
        continue;
      }
      if (decision === 'give_up') {
        // Say so in the data instead of re-queueing it forever. 'missing' has
        // been a legal deal_deliveries.status since migration 029 and this is
        // its first writer. Guarded on 'pending' so a genuinely verified
        // delivery can never be downgraded by the give-up path.
        await sb
          .from('deal_deliveries')
          .update({ status: 'missing' } as never)
          .eq('id', deliveryId)
          .eq('status', 'pending');
        // Audit gated on the same fact as the update guard (the row WAS
        // pending), so a no-op write never fabricates a transition row.
        if (delivery.status === 'pending' || delivery.status == null) {
          await auditWrite({
            action: 'delivery.missing',
            actor_label: 'system:measurement-tick',
            target_type: 'deal_delivery',
            target_id: deliveryId,
            firm_id: offer.firm_id,
            metadata: {
              creator_offer_id: offer.id,
              post_url: offer.post_url,
              resolve_attempts: prior.length,
            },
          });
        }
        tally.unresolvable += 1;
        continue;
      }

      // 3. Scrape the creator's posts + match this deal's post.
      const handle = await handleFor(sb, offer.campaign_influencer_id);
      if (!handle) {
        tally.skipped += 1;
        continue;
      }
      const startedAt = Date.now();
      const result = await scrape(handle);
      const posts = result.profiles ?? [];
      tally.scraped += 1;
      tally.costUsd += Number(result.costUsd) || 0;
      const matched = matchPost(posts, offer.post_url);

      // ── Layer 2: the spend is now on the books ───────────────────────────
      // Written for EVERY scrape, hit or miss, before the miss short-circuits
      // below — a miss is the expensive case and was the one going unrecorded.
      // `matched` is what the backoff reads back on the next tick.
      let ledgered = true;
      try {
        await record({
          campaign_id: offer.campaign_id ?? null,
          source: 'apify',
          endpoint: MEASUREMENT_ENDPOINT,
          cost_usd: Number(result.costUsd) || 0,
          records_returned: posts.length,
          latency_ms: Date.now() - startedAt,
          request_meta: {
            creator_offer_id: offer.id,
            deal_delivery_id: deliveryId,
            handle,
            matched: Boolean(matched),
            runId: result.runId ?? null,
          },
        });
      } catch {
        ledgered = false;
      }
      if (!ledgered) {
        // An unbooked scrape is both unaccounted spend AND a lost backoff
        // attempt — the exact pair that produced the infinite retry. Stop the
        // delivery pass here rather than keep spending blind; the next tick
        // retries from a known state.
        ledgerBroken = true;
        tally.skipped += 1;
        continue;
      }

      if (!matched) continue; // post not found — backoff decides the next try
      const metrics = postMetrics(matched);

      // The scrape found the actual post on the creator's profile — THAT is
      // verification (existence-level). Previously the row was stamped
      // 'verified' the moment a human pasted any URL, before any check ran.
      await sb
        .from('deal_deliveries')
        .update({ status: 'verified' } as never)
        .eq('id', deliveryId)
        .eq('status', 'pending');
      if (delivery.status === 'pending' || delivery.status == null) {
        await auditWrite({
          action: 'delivery.verified',
          actor_label: 'system:measurement-tick',
          target_type: 'deal_delivery',
          target_id: deliveryId,
          firm_id: offer.firm_id,
          metadata: {
            creator_offer_id: offer.id,
            post_url: offer.post_url,
            handle,
          },
        });
      }
      tally.verified += 1;

      // Deliverable-spec verification: compare the found post
      // against agreed_deliverables. Deliberately status-neutral — spec_check
      // is its own column, refreshed on every snapshot pass so a re-scrape
      // with richer payload can upgrade 'partial'. Pre-migration-036 this
      // update errors server-side and is ignored (supabase-js returns the
      // error, nothing throws).
      const spec = checkDeliverableSpec(
        normalizeDeliverables(offer.agreed_deliverables),
        matched,
      );
      if (spec) {
        await sb
          .from('deal_deliveries')
          .update({ spec_check: spec.check, spec_check_detail: spec.detail } as never)
          .eq('id', deliveryId);
      }

      await sb.from('deal_performance_snapshots').insert({
        deal_delivery_id: deliveryId,
        firm_id: offer.firm_id,
        views: metrics.views,
        likes: metrics.likes,
        comments: metrics.comments,
        shares: metrics.shares,
        source: 'apify_tiktok',
        captured_at: new Date(now).toISOString(),
      } as never);
      tally.snapshots += 1;
      if (offer.campaign_id) cpmTouched.add(offer.campaign_id);

      // CPM slice S4: this deal's realised CPM — the 7-day reading on the first
      // snapshot (which isSnapshotDue makes due at 7 days), latest on every
      // later one. Data capture only; never throws; pre-062 skipped silently.
      // The scrape above is TikTok's, so that is the platform measured.
      const cpmOutcome = await writeDealCpmRecord(sb, {
        offer_id: offer.id,
        firm_id: offer.firm_id,
        campaign_id: offer.campaign_id,
        platform: 'tiktok',
        views: metrics.views,
        posted_at_ms: Number.isFinite(Date.parse(offer.posted_at ?? '')) ? Date.parse(offer.posted_at ?? '') : null,
        now_ms: now,
        deal_delivery_id: deliveryId,
        synthetic_campaign_ids: syntheticCampaignIds,
      });
      if (cpmOutcome === 'created' || cpmOutcome === 'updated') tally.dealCpmRecords += 1;
    } catch {
      tally.skipped += 1;
    }
  }

  // CPM time series (migration 042): one campaign-level row per UTC day,
  // refreshed after snapshots land. Synthetic campaigns can never appear in
  // cpmTouched — they were excluded from the offers query above. Never throws;
  // pre-apply (table absent) it skips silently.
  tally.cpmSnapshots = await writeCpmSnapshots(sb, [...cpmTouched], now);

  await pollArtistMetrics(sb, deps, now, tally);

  // ── Delivery expiry (migration 052) ──────────────────────────────────────
  //
  // Close deals whose agreed delivery window passed with no post, so the label
  // never inherits a list of people to chase. Runs LAST and is best-effort: a
  // measurement tick that already scraped and snapshotted must not lose that
  // work to a sweeper failure. Inert until a firm enables the split — with the
  // flag off, no deal ever reaches `deposit_paid`.
  try {
    if (deps.expireUndelivered === false) throw { skip: true };
    const { runDeliveryExpiry } = await import('./delivery-expiry');
    const expiry = await runDeliveryExpiry(sb, { now });
    tally.undelivered = expiry.expired;
  } catch (e) {
    // This module has no logger of its own by convention; the sweeper logs its
    // own failures internally, so this catch exists only so the measurement work
    // already done in this tick survives.
    if (!(e as { skip?: boolean })?.skip) {
      console.error('[measurement-tick] delivery expiry pass failed:', (e as Error).message);
    }
  }

  // Reclaim payment authorizations stranded in 'executing'. Same posture as the
  // expiry pass above: last, best-effort, and it must never cost this tick the
  // measurement work it already did. Unlike the expiry pass this one is NOT
  // gated on a firm flag — a stranded claim burns budget on any firm, split or
  // not, and before 055 the only recovery was hand SQL against production.
  try {
    const { runPaymentReclaim } = await import('./payment-reclaim');
    await runPaymentReclaim(sb, { now });
  } catch (e) {
    console.error('[measurement-tick] payment reclaim pass failed:', (e as Error).message);
  }

  return tally;
}

// ── CPM time series (migration 042) ─────────────────────────────────────────
//
// The persisted trend line for the objective function. CPM was computed on
// read only (cpm-model.ts) — no history, nothing for the optimizer or a
// label report to trend against. One row per (campaign, UTC day):
//
//   spend_usd      Σ agreed over offers whose money actually moved
//                  (PAID_STATES — mirrors analytics.ts spend semantics).
//   verified_reach Σ latest-snapshot views per delivery (verified impressions).
//   label_cpm      labelCpm(spend, reach) — NULL when reach is 0, never
//                  fabricated.
//
// Same-day re-runs refresh the existing row (found via the UNIQUE
// (campaign_id, snapshot_date) key), so the series holds the day's latest
// known state. Exported for the hermetic suite.

/** Write/refresh one cpm_snapshots row per campaign. Returns rows written. */
export async function writeCpmSnapshots(
  sb: SupabaseClient,
  campaignIds: string[],
  nowMs: number,
): Promise<number> {
  let written = 0;
  const snapshotDate = new Date(nowMs).toISOString().slice(0, 10);
  for (const campaignId of campaignIds) {
    try {
      // Spend: offers whose money moved. agreed_amount_usd is the paid figure.
      const { data: offerRows, error: offerErr } = await sb
        .from('creator_offers')
        .select('id, firm_id, status, agreed_amount_usd')
        .eq('campaign_id', campaignId)
        .in('status', [...PAID_STATES]);
      if (offerErr) continue;
      const offers = (offerRows ?? []) as Array<{
        id: string;
        firm_id: string | null;
        agreed_amount_usd: number | null;
      }>;
      const spendUsd =
        Math.round(
          offers.reduce((s, o) => s + Math.max(0, Number(o.agreed_amount_usd ?? 0) || 0), 0) * 100,
        ) / 100;
      const firmId = offers.find((o) => o.firm_id)?.firm_id ?? null;

      // Verified reach: latest snapshot per delivery, summed.
      let reach = 0;
      const offerIds = offers.map((o) => o.id);
      if (offerIds.length > 0) {
        const { data: delRows, error: delErr } = await sb
          .from('deal_deliveries')
          .select('id, creator_offer_id')
          .in('creator_offer_id', offerIds);
        if (delErr) continue;
        const deliveryIds = ((delRows ?? []) as Array<{ id: string }>).map((d) => d.id);
        if (deliveryIds.length > 0) {
          const { data: snapRows, error: snapErr } = await sb
            .from('deal_performance_snapshots')
            .select('deal_delivery_id, captured_at, views')
            .in('deal_delivery_id', deliveryIds);
          if (snapErr) continue;
          const byDelivery = new Map<string, PerformanceSnapshot[]>();
          for (const raw of (snapRows ?? []) as Array<
            PerformanceSnapshot & { deal_delivery_id: string }
          >) {
            const list = byDelivery.get(raw.deal_delivery_id) ?? [];
            list.push(raw);
            byDelivery.set(raw.deal_delivery_id, list);
          }
          const latestPerPost: PerformanceSnapshot[] = [];
          for (const snaps of byDelivery.values()) {
            const latest = latestSnapshot(snaps);
            if (latest) latestPerPost.push(latest);
          }
          reach = totalReach(latestPerPost);
        }
      }

      const row = {
        campaign_id: campaignId,
        firm_id: firmId,
        snapshot_date: snapshotDate,
        spend_usd: spendUsd,
        verified_reach: reach,
        // NULL when reach is 0 — a CPM is never fabricated (labelCpm contract).
        label_cpm: labelCpm(spendUsd, reach),
        updated_at: new Date(nowMs).toISOString(),
      };

      // The select is ONLY the pre-migration-042 probe: table absent → skip
      // silently, so the tick's heartbeat never depends on the migration.
      const { error: selErr } = await sb
        .from('cpm_snapshots')
        .select('id')
        .eq('campaign_id', campaignId)
        .eq('snapshot_date', snapshotDate)
        .maybeSingle();
      if (selErr) continue;

      // UPSERT, not select-then-insert (review finding N5). The original
      // read-then-write was the exact race migration 043 exists to remove,
      // against the same kind of UNIQUE constraint: two overlapping ticks both
      // read "no row", both insert, and the loser's unique violation was
      // swallowed by `if (error) continue` — a silently dropped snapshot. It
      // was shaped that way to suit the hermetic store, which is a test
      // constraint driving a production race.
      const { error } = await sb
        .from('cpm_snapshots')
        .upsert(row as never, { onConflict: 'campaign_id,snapshot_date' });
      if (error) continue;
      written += 1;
    } catch {
      // One campaign's failure never takes down the pass.
    }
  }
  return written;
}

/**
 * Timestamps of every UNMATCHED delivery scrape, keyed by creator_offer_id.
 *
 * Returns null when the history cannot be read — the caller treats that as
 * "spend nothing this tick" rather than "assume zero attempts", because
 * assuming zero is what re-queues a poison row on every pass.
 *
 * Rows are filtered in JS rather than with a `request_meta->>` PostgREST
 * operator so the hermetic test store (select/eq/in/not chains only) can
 * exercise this path; the table is small and scoped to one endpoint.
 */
async function loadResolveAttempts(
  sb: SupabaseClient,
): Promise<Map<string, number[]> | null> {
  const { data, error } = await sb
    .from('api_ledger')
    .select('created_at, request_meta')
    .eq('source', 'apify')
    .eq('endpoint', MEASUREMENT_ENDPOINT);
  if (error) return null;
  const map = new Map<string, number[]>();
  for (const raw of (data ?? []) as Array<{
    created_at: string | null;
    request_meta: unknown;
  }>) {
    const meta = (raw.request_meta ?? {}) as Record<string, unknown>;
    if (meta.matched !== false) continue; // only misses count against a row
    const offerId = typeof meta.creator_offer_id === 'string' ? meta.creator_offer_id : '';
    if (!offerId) continue;
    const ms = Date.parse(raw.created_at ?? '');
    if (!Number.isFinite(ms)) continue;
    const list = map.get(offerId);
    if (list) list.push(ms);
    else map.set(offerId, [ms]);
  }
  return map;
}

// ── Artist stream polling (issues #24, #49, #50; migrations 036 + 038) ──────
//
// For campaigns confirmed with a Soundcharts artist UUID, poll Spotify monthly
// listeners into artist_metric_snapshots. Never throws: env absent or a poison
// row → artistSkipped, and the campaigns select degrades to zero rows
// pre-migration-036.
//
// Three deliberate changes from the original issue-#24 shape:
//
//  1. DAILY, not week-then-monthly. The delivery cadence (isSnapshotDue: first
//     at 7 days, then every 30) is right for "did this post exist and how did
//     it do", and useless for a trend line — it yields two points a month, which
//     cannot carry a lift calculation. Artist metrics get their own cadence.
//
//  2. BACKFILL THE WHOLE WINDOW, not just the newest point. One call returns
//     the campaign's entire series, so we store every day we don't already
//     have. That makes the poll self-healing (an outage costs nothing as long
//     as it is shorter than the requested window) and decouples series density
//     from tick reliability. Storing one point per call would have tied the
//     quality of the lift math to cron uptime for no reason.
//
//  3. metric_date, not just captured_at. captured_at is when WE polled;
//     metric_date is the day the reading is FOR. Soundcharts lags up to three
//     days, so two polls a day apart routinely carry the same underlying
//     reading. Keying on poll time would have written duplicate points and
//     manufactured phantom flat days in the series.
//
// Quota: one call per campaign per day, capped at maxArtistPolls per tick.
// Against the hourly tick that is at most 24 × cap calls/day.

/**
 * Minimum gap between polls for one campaign. Slightly under 24h so an hourly
 * tick lands once per calendar day instead of drifting an hour later each day
 * and eventually skipping one.
 */
const ARTIST_POLL_INTERVAL_MS = 20 * 60 * 60 * 1000;

/** Stop polling a campaign this long after confirm — dead campaigns cost quota. */
const ARTIST_MEASURE_WINDOW_DAYS = 120;

/** Largest history window we ever ask for in one call. */
const ARTIST_FETCH_WINDOW_DAYS = 90;

const DAY_MS = 86_400_000;

async function pollArtistMetrics(
  sb: SupabaseClient,
  deps: MeasurementDeps,
  now: number,
  tally: MeasurementTally,
): Promise<void> {
  try {
    const maxArtistPolls = deps.maxArtistPolls ?? 3;
    const enabled = deps.soundchartsEnabled ?? soundchartsConfigured();
    const record =
      deps.recordCall ??
      (async (e: LedgerEntry) => {
        const { recordApiCall } = await import('./api-ledger');
        await recordApiCall(e);
      });
    const fetchListeners =
      deps.fetchListeners ??
      ((uuid: string, startDate?: string, endDate?: string) =>
        getSpotifyListeners(uuid, startDate, endDate));

    const { data } = await sb
      .from('campaigns')
      .select('id, firm_id, artist_soundcharts_uuid, confirmed_at, created_at')
      .not('artist_soundcharts_uuid', 'is', null);
    const campaigns = (data ?? []) as Array<{
      id: string;
      firm_id: string | null;
      artist_soundcharts_uuid: string | null;
      confirmed_at: string | null;
      created_at: string | null;
    }>;

    for (const c of campaigns) {
      if (tally.artistPolls >= maxArtistPolls) break;
      if (!c.artist_soundcharts_uuid || !c.firm_id) continue;
      try {
        const anchorMs =
          Date.parse(c.confirmed_at ?? '') || Date.parse(c.created_at ?? '') || now;

        // Closed measurement window — not a gap, just done. Silent on purpose:
        // counting these as skipped would make every old campaign look broken.
        if (now - anchorMs > ARTIST_MEASURE_WINDOW_DAYS * DAY_MS) continue;

        type SnapRow = { captured_at: string; metric_date: string | null };
        const { data: existing, error: selErr } = await sb
          .from('artist_metric_snapshots')
          .select('captured_at, metric_date')
          .eq('campaign_id', c.id)
          .eq('metric', 'spotify_listeners');

        // Pre-migration-038 there is no metric_date column, and PostgREST
        // rejects the whole select. Falling back matters for quota, not
        // tidiness: without it `lastMs` stays null, every campaign reads as due
        // on every tick, and the daily poll silently becomes an hourly one.
        let rows: SnapRow[];
        if (selErr) {
          const { data: legacy } = await sb
            .from('artist_metric_snapshots')
            .select('captured_at')
            .eq('campaign_id', c.id)
            .eq('metric', 'spotify_listeners');
          rows = ((legacy ?? []) as Array<{ captured_at: string }>).map((r) => ({
            captured_at: r.captured_at,
            metric_date: null,
          }));
        } else {
          rows = (existing ?? []) as SnapRow[];
        }

        let lastMs: number | null = null;
        const haveDays = new Set<string>();
        for (const r of rows) {
          const ms = Date.parse(r.captured_at ?? '');
          if (Number.isFinite(ms) && (lastMs === null || ms > lastMs)) lastMs = ms;
          if (r.metric_date) haveDays.add(String(r.metric_date).slice(0, 10));
        }

        if (lastMs !== null && now - lastMs < ARTIST_POLL_INTERVAL_MS) continue;

        if (!enabled) {
          // Due but unpollable — count it so the tick output shows the gap.
          tally.artistSkipped += 1;
          continue;
        }

        const startMs = Math.max(anchorMs, now - ARTIST_FETCH_WINDOW_DAYS * DAY_MS);
        const startDate = scDay(startMs);
        const endDate = scDay(now);

        // artistPolls counts Soundcharts fetches — the quota the per-tick cap
        // protects — whether or not the series yields a snapshot.
        const startedAt = Date.now();
        const res = await fetchListeners(c.artist_soundcharts_uuid, startDate, endDate);
        tally.artistPolls += 1;
        const latencyMs = Date.now() - startedAt;

        const items = res.ok ? (res.data?.items ?? []) : [];

        // Soundcharts is a flat-rate plan metered in calls, not dollars, so the
        // honest cost is 0 — the ledger row exists to make the CALL COUNT
        // visible against a shared quota, which nothing tracked before.
        await record({
          campaign_id: c.id,
          source: 'soundcharts',
          endpoint: 'artist/streaming/spotify/listening',
          cost_usd: 0,
          records_returned: items.length,
          latency_ms: latencyMs,
          request_meta: {
            uuid: c.artist_soundcharts_uuid,
            start_date: startDate,
            end_date: endDate,
            ok: res.ok,
            error: res.ok ? null : (res.error ?? null),
          },
        });

        if (!res.ok || items.length === 0) {
          tally.artistSkipped += 1;
          continue;
        }

        // One row per calendar day we don't already hold.
        const capturedAt = new Date(now).toISOString();
        const fresh = new Map<string, number>();
        for (const it of items) {
          const day = typeof it?.date === 'string' ? it.date.slice(0, 10) : '';
          const value = Number(it?.value);
          if (!day || !Number.isFinite(value)) continue;
          if (haveDays.has(day) || fresh.has(day)) continue;
          fresh.set(day, value);
        }

        if (fresh.size === 0) continue; // already current, nothing to write

        const newRows = [...fresh.entries()].map(([metric_date, value]) => ({
          campaign_id: c.id,
          firm_id: c.firm_id,
          source: 'soundcharts',
          metric: 'spotify_listeners',
          value,
          metric_date,
          captured_at: capturedAt,
        }));

        const { error } = await sb
          .from('artist_metric_snapshots')
          .insert(newRows as never);

        if (error) {
          // Pre-migration-038 the metric_date column does not exist and the
          // insert is rejected wholesale. Fall back to the 036 shape — the
          // newest point only, which is all the old schema could express.
          const latest = latestSeriesValue(items);
          if (!latest) {
            tally.artistSkipped += 1;
            continue;
          }
          const { error: legacyError } = await sb
            .from('artist_metric_snapshots')
            .insert({
              campaign_id: c.id,
              firm_id: c.firm_id,
              source: 'soundcharts',
              metric: 'spotify_listeners',
              value: latest.value,
              captured_at: capturedAt,
            } as never);
          if (legacyError) {
            tally.artistSkipped += 1;
            continue;
          }
          tally.artistSnapshots += 1;
          continue;
        }

        tally.artistSnapshots += newRows.length;
      } catch {
        tally.artistSkipped += 1;
      }
    }
  } catch {
    // Whole-block guard: artist polling must never take the delivery tick down.
  }
}

async function ensureDelivery(
  sb: SupabaseClient,
  offer: PostedOffer,
  now: number,
): Promise<{ id: string; status: string | null; created: boolean } | null> {
  const { data: existing } = await sb
    .from('deal_deliveries')
    .select('id, status')
    .eq('creator_offer_id', offer.id)
    .limit(1)
    .maybeSingle();
  if (existing) {
    const row = existing as { id: string; status?: string | null };
    return { id: row.id, status: row.status ?? null, created: false };
  }

  const { data: row } = await sb
    .from('deal_deliveries')
    .insert({
      creator_offer_id: offer.id,
      firm_id: offer.firm_id,
      post_url: offer.post_url,
      // 'pending' until the measurement scrape actually finds the post.
      // Stamping 'verified' here made the column an affirmative false claim —
      // any pasted string produced a permanently "verified" delivery.
      status: 'pending',
      detected_at: offer.posted_at ?? new Date(now).toISOString(),
    } as never)
    .select('id')
    .maybeSingle();
  return row ? { id: (row as { id: string }).id, status: 'pending', created: true } : null;
}

async function handleFor(
  sb: SupabaseClient,
  campaignInfluencerId: string | null,
): Promise<string | null> {
  if (!campaignInfluencerId) return null;
  const { data: ci } = await sb
    .from('campaign_influencers')
    .select('influencer_id')
    .eq('id', campaignInfluencerId)
    .maybeSingle();
  const influencerId = (ci as { influencer_id?: string } | null)?.influencer_id;
  if (!influencerId) return null;
  const { data: inf } = await sb
    .from('influencers')
    .select('username')
    .eq('id', influencerId)
    .maybeSingle();
  return (inf as { username?: string } | null)?.username ?? null;
}
