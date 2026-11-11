"use client";

import { useEffect, useState, use } from "react";
import { messageStatusLabel } from "@/lib/message-status";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, ExternalLink, Ban, PlayCircle } from "lucide-react";
import Link from "next/link";
import { OperatorOnly } from "@/components/OperatorContext";
import { EmptyState, Section, Stat, StatGroup } from "@/components/page";
import { StatusBadge } from "@/components/StatusBadge";
import { outreachStatusLabel } from "@/lib/outreach-status";
import { PERF_MIN_SAMPLE } from "@/lib/creator-performance";
import type {
  CreatorPerformance,
  CreatorDealRecord,
  GatedMetric,
} from "@/lib/creator-performance";

interface InfluencerDetail {
  id: string;
  platform: string;
  username: string;
  display_name: string | null;
  profile_url: string | null;
  follower_count: number | null;
  engagement_rate: number | null;
  bio: string | null;
  verified: boolean;
  avatar_url: string | null;
  /** Platform-level block (influencers.blocklisted) — honoured by every label. */
  blocklisted: boolean;
  /** This label's own block (firm_influencer_blocks, migration 056). */
  firm_blocked?: boolean;
  bot_probability: number | null;
  score_breakdown: Record<string, number> | null;
  raw_data: Record<string, unknown> | null;
  created_at: string;
  campaign_appearances: Array<{
    id: string;
    composite_score: number | null;
    tier: string | null;
    price_estimate_mid: number | null;
    outreach_priority: string | null;
    outreach_angle: string | null;
    /** The OLD funnel column. Every discovery re-run resets it to 'queued'
     *  (api/campaigns/[id]/run/route.ts), so it can't be shown as progress. */
    status: string;
    /** The state machine the /outreach screen reads. This is the real one. */
    outreach_status: string | null;
    score_breakdown: Record<string, number> | null;
    bot_flagged: boolean;
    campaign: {
      id: string;
      artist_name: string;
      status: string;
      created_at: string;
    };
  }>;
}

interface LatestDraft {
  id: string;
  campaign_influencer_id: string;
  subject: string | null;
  body: string;
  status: string | null;
  sent_at: string | null;
  created_at: string;
  generation_model: string | null;
  edited_by_user: boolean;
  campaign: { id: string; artist_name: string | null } | null;
}

interface RawPost {
  text?: string;
  hook?: string;
  caption?: string;
  playCount?: number;
  views?: number;
  diggCount?: number;
  likes?: number;
  webVideoUrl?: string;
  url?: string;
  videoUrl?: string;
  cover?: string;
  thumbnail?: string;
  createTime?: number;
}

// The scorer's feature vector. OPERATOR-ONLY (see the card at the bottom of
// the page): six numbers out of 100 that a label manager cannot act on, two of
// which — "Bot Safety" (bot_risk_inverse) and "Trust Score" (trust_score) — are
// different measures whose names no reader can tell apart. The label sees the
// single composite fit score in the header instead.
const SCORE_LABELS: Record<string, string> = {
  engagement_quality: "Engagement Quality",
  content_relevance: "Content Relevance",
  audience_fit: "Audience Fit",
  bot_risk_inverse: "Bot Safety",
  response_likelihood: "Response Likelihood",
  trust_score: "Trust Score",
};

// Weight in the composite (src/lib/scoring.ts:579-583). trust_score carries 0%
// — it is displayed alongside, never folded in — which is exactly the fact that
// made two similarly-named bars unreadable. Stated here so an operator tuning
// the scorer can see which bar actually moves the number.
const SCORE_WEIGHTS: Record<string, string> = {
  engagement_quality: "30%",
  content_relevance: "25%",
  audience_fit: "20%",
  bot_risk_inverse: "15%",
  response_likelihood: "10%",
  trust_score: "0%, shown, not scored",
};

export default function InfluencerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [influencer, setInfluencer] = useState<InfluencerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [latestDraft, setLatestDraft] = useState<LatestDraft | null>(null);
  const [draftLoading, setDraftLoading] = useState(true);
  const [perf, setPerf] = useState<CreatorPerformance | null>(null);

  useEffect(() => {
    fetch(`/api/influencers/${id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then(setInfluencer)
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraftLoading(true);
    fetch(`/api/influencers/${id}/latest-draft`)
      .then((res) => (res.ok ? res.json() : { message: null }))
      .then((j) => setLatestDraft(j?.message ?? null))
      .catch(() => setLatestDraft(null))
      .finally(() => setDraftLoading(false));
  }, [id]);

  useEffect(() => {
    fetch(`/api/influencers/${id}/performance`)
      .then((res) => (res.ok ? res.json() : null))
      .then((j) => setPerf(j ?? null))
      .catch(() => setPerf(null));
  }, [id]);

  // Blocks are per label: this writes (or removes) THIS label's block only.
  // Before migration 056 is applied the server falls back to the platform-wide
  // flag and says so (`scope: "global_fallback"`), so the badge follows what
  // was actually written rather than what was asked for.
  const [blockError, setBlockError] = useState<string | null>(null);
  async function toggleBlocklist() {
    if (!influencer) return;
    const next = !influencer.firm_blocked;
    setBlockError(null);
    try {
      const res = await fetch(`/api/influencers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocklisted: next }),
      });
      if (!res.ok) {
        setBlockError("Couldn't update the block. Nothing changed; try again.");
        return;
      }
      const body = (await res.json().catch(() => null)) as { scope?: string } | null;
      setInfluencer((prev) =>
        !prev
          ? prev
          : body?.scope === "global_fallback"
            ? { ...prev, blocklisted: next }
            : { ...prev, firm_blocked: next }
      );
    } catch {
      setBlockError("Couldn't update the block. Check your connection.");
    }
  }

  if (loading) {
    return (
      <AppShell title="Creator" back={{ href: "/influencers", label: "Creators" }} width="medium">
        <div className="mx-auto w-full max-w-5xl space-y-4 px-4 pb-12 pt-6 sm:px-6 lg:px-8">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </AppShell>
    );
  }

  if (!influencer) {
    return (
      <AppShell title="Creator" back={{ href: "/influencers", label: "Creators" }} width="medium">
        <div className="mx-auto w-full max-w-5xl px-4 pb-12 pt-6 sm:px-6 lg:px-8">
          <EmptyState title="Creator not found">
            They may have been removed, or the link is wrong.
          </EmptyState>
        </div>
      </AppShell>
    );
  }

  // An unmeasured engagement rate is not 0%, and "—%" reads as a broken
  // screen. Null here, and the tile renders words instead of a number.
  const engNum = Number(influencer.engagement_rate);
  const engPct =
    influencer.engagement_rate != null && Number.isFinite(engNum)
      ? (engNum * 100).toFixed(2)
      : null;

  // Get best score breakdown from campaign appearances
  const bestAppearance = influencer.campaign_appearances
    ?.sort((a, b) => (b.composite_score || 0) - (a.composite_score || 0))[0];

  const breakdown =
    bestAppearance?.score_breakdown || influencer.score_breakdown || {};

  // The one score a label sees. `|| "—"` would have hidden a legitimate 0.
  const fitScore =
    typeof bestAppearance?.composite_score === "number"
      ? bestAppearance.composite_score
      : null;
  const appearanceCount = influencer.campaign_appearances?.length ?? 0;

  // Posts grid: pull from raw_data.posts[] (the "wow" reference data populated
  // by the Apify scrape). We render the top 3 with hook + view count + thumb.
  const rawPosts: RawPost[] = Array.isArray(
    (influencer.raw_data as Record<string, unknown> | null)?.posts
  )
    ? (((influencer.raw_data as Record<string, unknown>).posts as RawPost[]) ?? [])
    : [];
  const topPosts = rawPosts.slice(0, 3);

  function postHook(p: RawPost): string {
    const raw = p.hook ?? p.text ?? p.caption ?? "";
    const trimmed = raw.trim();
    return trimmed.length > 140 ? trimmed.slice(0, 140) + "…" : trimmed;
  }
  function postViews(p: RawPost): number {
    return Number(p.playCount ?? p.views ?? 0);
  }
  function postUrl(p: RawPost): string | null {
    return p.webVideoUrl ?? p.url ?? p.videoUrl ?? null;
  }
  function postThumb(p: RawPost): string | null {
    return p.cover ?? p.thumbnail ?? null;
  }

  const meta = [
    influencer.display_name,
    platformLabel(influencer.platform),
    influencer.verified ? "Verified" : null,
    `First found ${new Date(influencer.created_at).toLocaleDateString()}`,
  ].filter(Boolean);

  return (
    <AppShell
      title={`@${influencer.username}`}
      back={{ href: "/influencers", label: "Creators" }}
      width="medium"
      badge={
        influencer.blocklisted ? (
          <span title="Blocked across the platform. No label can contact this creator.">
            <StatusBadge state="flagged" label="Blocked platform-wide" />
          </span>
        ) : influencer.firm_blocked ? (
          <span title="Your label won't draft, send to or negotiate with this creator. Other labels are unaffected.">
            <StatusBadge state="flagged" label="Blocked for your label" />
          </span>
        ) : undefined
      }
      subtitle={meta.join(" · ")}
      actions={
        <>
          {/* Never the page's primary. This is the one destructive control
              here. */}
          <Button variant="ghost" onClick={toggleBlocklist}>
            <Ban className="size-3.5" />
            {influencer.firm_blocked ? "Unblock" : "Block for your label"}
          </Button>
          {influencer.profile_url && (
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <a href={influencer.profile_url} target="_blank" rel="noopener noreferrer" />
              }
            >
              <ExternalLink className="size-3.5" />
              View profile
            </Button>
          )}
        </>
      }
    >
      {/* One column, in decision order: who they are, what they cost and
          delivered, the draft we would send, then history. */}
      <div className="mx-auto w-full max-w-5xl space-y-10 px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        {blockError && (
          <p className="-mt-2 text-xs text-destructive" role="alert">
            {blockError}
          </p>
        )}

        <div className="space-y-5">
          {influencer.bio && (
            <p className="max-w-2xl text-sm text-foreground">{influencer.bio}</p>
          )}
          {/* Three numbers, each defined. One fit number, stated once, with
              what it means and what it does not mean directly underneath. */}
          <StatGroup>
            <Stat
              label="Followers"
              value={(influencer.follower_count || 0).toLocaleString()}
            />
            <Stat
              label="Engagement rate"
              value={engPct === null ? null : `${engPct}%`}
              empty="Not measured yet"
            />
            <Stat
              label="Fit score"
              value={fitScore}
              empty="Not scored yet"
              sub={appearanceCount > 1 ? `Best of ${appearanceCount} campaigns` : "Out of 100"}
            />
          </StatGroup>
          {fitScore !== null && (
            <p className="max-w-2xl text-meta text-muted-foreground">
              Fit ranks this creator against the others found for the same
              campaign: engagement, how close their recent posts sit to the
              brief, audience size and how likely they are to reply. Use it to
              decide who to contact first. It is not a forecast of what a post
              will do.
            </p>
          )}
        </div>

        {/* Performance first: what this creator has cost, how fast they
            reply, whether they deliver. */}
        {perf && perf.deals.length > 0 && <PerformanceSection perf={perf} />}

        <Section
          title="Latest outreach draft"
          action={
            latestDraft?.status ? (
              <StatusBadge
                state="sourced"
                label={messageStatusLabel(latestDraft.status).replace(/^./, (c) => c.toUpperCase())}
              />
            ) : undefined
          }
        >
          {/* The angle is the input to this draft; it belongs on top of it. */}
          {bestAppearance?.outreach_angle && (
            <div className="mb-4">
              <p className="mb-1 text-meta text-muted-foreground">The angle we lead with</p>
              <p className="text-sm">{bestAppearance.outreach_angle}</p>
            </div>
          )}
          {draftLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading draft…
            </div>
          ) : latestDraft ? (
            <div className="overflow-hidden rounded-lg border">
              {latestDraft.subject && (
                <div className="border-b px-4 py-2.5 text-sm">
                  <span className="mr-2 text-muted-foreground">Subject</span>
                  <span className="font-medium">{latestDraft.subject}</span>
                </div>
              )}
              <pre className="whitespace-pre-wrap px-4 py-3 font-sans text-sm text-foreground">
                {latestDraft.body}
              </pre>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
                <span>
                  {latestDraft.campaign?.artist_name && `${latestDraft.campaign.artist_name} · `}
                  Generated {new Date(latestDraft.created_at).toLocaleString()}
                  {latestDraft.edited_by_user ? " · edited" : ""}
                  {/* Live values are model ids. Ours to know, not the label's. */}
                  {latestDraft.generation_model && (
                    <OperatorOnly>{` · ${latestDraft.generation_model}`}</OperatorOnly>
                  )}
                </span>
                {latestDraft.campaign?.id && (
                  <Link
                    href={`/outreach?campaign_id=${latestDraft.campaign.id}`}
                    className="font-medium text-foreground hover:underline"
                  >
                    View in outreach
                  </Link>
                )}
              </div>
            </div>
          ) : (
            // Drafting is a campaign-at-a-time operation, so say that plainly
            // and point at the screen where it happens.
            <EmptyState
              title="Nothing drafted for this creator yet"
              action={
                bestAppearance?.campaign?.id ? (
                  <Button
                    variant="outline"
                    nativeButton={false}
                    render={<Link href={`/campaigns/${bestAppearance.campaign.id}`} />}
                  >
                    Open {bestAppearance.campaign.artist_name ?? "the campaign"}
                  </Button>
                ) : undefined
              }
            >
              Outreach is written for a whole campaign at once.
            </EmptyState>
          )}
        </Section>

        {topPosts.length > 0 && (
          <Section title="Recent posts" count={topPosts.length}>
            <div className="grid max-w-3xl grid-cols-3 gap-3 sm:grid-cols-5">
              {topPosts.map((p, i) => {
                const hook = postHook(p);
                const views = postViews(p);
                const url = postUrl(p);
                const thumb = postThumb(p);
                const inner = (
                  <div className="flex h-full flex-col overflow-hidden rounded-lg border transition-colors hover:bg-muted/50">
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={thumb}
                        alt={hook || `Post ${i + 1}`}
                        className="aspect-[9/16] w-full bg-muted object-cover"
                      />
                    ) : (
                      <div className="flex aspect-[9/16] w-full items-center justify-center bg-muted">
                        <PlayCircle className="size-6 text-faint" />
                      </div>
                    )}
                    <div className="flex flex-1 flex-col gap-1 p-2">
                      <p className="line-clamp-2 text-xs">
                        {hook || <span className="text-faint">No caption</span>}
                      </p>
                      <p className="mt-auto text-xs tabular-nums text-muted-foreground">
                        {views.toLocaleString()} views
                      </p>
                    </div>
                  </div>
                );
                return url ? (
                  <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="block">
                    {inner}
                  </a>
                ) : (
                  <div key={i}>{inner}</div>
                );
              })}
            </div>
          </Section>
        )}

        <Section title="Campaign history" count={appearanceCount}>
          {!influencer.campaign_appearances?.length ? (
            <EmptyState title="Not in any campaign yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="h-9 pr-3 font-medium">Campaign</th>
                    <th className="h-9 px-3 font-medium">Outreach</th>
                    <th className="h-9 px-3 font-medium">Tier</th>
                    <th className="h-9 px-3 text-right font-medium">Est. price</th>
                    <th className="h-9 pl-3 text-right font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {influencer.campaign_appearances.map((app) => (
                    <tr key={app.id} className="border-b">
                      <td className="py-2.5 pr-3">
                        <Link
                          href={`/campaigns/${app.campaign?.id}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {app.campaign?.artist_name}
                        </Link>
                      </td>
                      {/* outreach_status, not the old funnel column, which every
                          discovery re-run resets to 'queued'. */}
                      <td className="px-3 text-muted-foreground">
                        {outreachStatusLabel(app.outreach_status)}
                      </td>
                      <td className="px-3 text-muted-foreground">
                        {app.tier ? `Tier ${app.tier}` : <Missing>None</Missing>}
                      </td>
                      <td className="px-3 text-right tabular-nums">
                        {app.price_estimate_mid ? (
                          `$${app.price_estimate_mid.toLocaleString()}`
                        ) : (
                          <Missing>No estimate</Missing>
                        )}
                      </td>
                      <td className="pl-3 text-right tabular-nums text-muted-foreground">
                        {app.campaign?.created_at
                          ? new Date(app.campaign.created_at).toLocaleDateString()
                          : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* ── Operator only ────────────────────────────────────────────────
            The scorer's feature vector. Six numbers a label manager has no
            action for, two of which (bot_risk_inverse "Bot Safety" and
            trust_score "Trust Score") are different measures with names no
            reader can tell apart. The label gets the single composite fit
            score above; we keep the internals for tuning. */}
        <OperatorOnly>
          <Section
            title="Score breakdown"
            action={<StatusBadge state="sourced" label="Operator view" />}
          >
            <div className="max-w-2xl space-y-3">
              {influencer.bot_probability !== null && (
                <div className="flex items-baseline justify-between border-b pb-3 text-sm">
                  <span>
                    bot_probability
                    <span className="ml-2 text-xs text-muted-foreground">raw detector output</span>
                  </span>
                  <span className="tabular-nums">
                    {Number(influencer.bot_probability).toFixed(2)}
                  </span>
                </div>
              )}
              {Object.keys(breakdown).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No score breakdown stored for this creator.
                </p>
              ) : (
                Object.entries(breakdown).map(([key, value]) => {
                  // Rows scored before a dimension existed (e.g. trust_score
                  // pre-S3.1) may carry null. Say so, never NaN or 0.
                  const hasValue = typeof value === "number" && Number.isFinite(value);
                  const numValue = hasValue ? value : 0;
                  return (
                    <div key={key}>
                      <div className="mb-1 flex items-center justify-between text-sm">
                        <span>
                          {SCORE_LABELS[key] || key}
                          {SCORE_WEIGHTS[key] && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              {SCORE_WEIGHTS[key]}
                            </span>
                          )}
                        </span>
                        <span className="tabular-nums">
                          {hasValue ? `${numValue}/100` : <Missing>Not scored</Missing>}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary/70"
                          style={{ width: `${numValue}%` }}
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </Section>
        </OperatorOnly>
      </div>
    </AppShell>
  );
}

const PLATFORM_LABEL: Record<string, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
};

function platformLabel(p: string | null | undefined): string | null {
  if (!p) return null;
  return PLATFORM_LABEL[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

function Missing({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-faint">{children}</span>;
}

// ─── Performance section ─────────────────────────────────────────────────────
//
// Per-deal table + cross-campaign rollup from /api/influencers/[id]/performance
// (src/lib/creator-performance.ts). Honest-null doctrine throughout, mirroring
// AnalyticsCard: a metric the system has not measured renders as words, never
// a fabricated number. Gated aggregates (below n=5) say so.

// creator_offers.status → words. The raw column reaches the client as
// "human approval required" otherwise, which is our workflow vocabulary, not
// theirs. src/lib/statuses.ts carries the same mapping as full sentences for
// the anomaly feed, but does not export it; these are the short badge forms.
const DEAL_STATUS_LABELS: Record<string, string> = {
  queued: "opening offer not sent",
  offered: "waiting on their reply",
  counter_offered: "their counter is unanswered",
  agreed: "agreed",
  human_approval_required: "waiting on your approval",
  approved: "approved, awaiting payment",
  paid: "paid",
  rejected: "declined",
  failed: "did not complete",
};

function dealStatusLabel(status: string): string {
  return DEAL_STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

const ATTRIBUTION_LABELS: Record<string, string> = {
  manual: "manual",
  spotify_for_artists: "Spotify for Artists",
  estimated_from_views: "est. from views",
  unknown: "unknown",
  synthetic_sample: "sample",
};

function fmtMoney(n: number | null, dp = 0): string | null {
  if (n == null) return null;
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

/** Cost-per-view is often sub-cent, so show enough decimals to mean something. */
function fmtCpv(n: number | null): string | null {
  if (n == null) return null;
  return `$${n >= 0.01 ? n.toFixed(2) : n.toFixed(4)}`;
}

function fmtLatency(ms: number | null): string | null {
  if (ms == null) return null;
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function gatedText(
  m: GatedMetric,
  fmt: (v: number) => string | null
): { value: string | null; note: string } {
  if (m.status === "insufficient_data") {
    return {
      value: null,
      note: `Needs ${m.needed} deals with data (have ${m.n})`,
    };
  }
  return { value: fmt(m.value), note: `across ${m.n} deals` };
}

function DealPerformanceRow({
  deal,
  showViews,
  showStreams,
}: {
  deal: CreatorDealRecord;
  /** Both view columns are hidden campaign-wide when nothing is measured. */
  showViews: boolean;
  showStreams: boolean;
}) {
  const delivered =
    deal.delivery.promised != null
      ? `${deal.delivery.verified}/${deal.delivery.promised}`
      : deal.delivery.deliveries_total > 0
        ? `${deal.delivery.verified}/${deal.delivery.deliveries_total}`
        : null;
  const specFailed = deal.delivery.spec.fail > 0;
  const cell = "px-3 py-2.5 text-right tabular-nums";
  return (
    <tr className="border-b">
      <td className="py-2.5 pr-3">
        <Link
          href={`/campaigns/${deal.campaign_id}`}
          className="font-medium text-foreground hover:underline"
        >
          {deal.campaign_name ?? "Untitled campaign"}
        </Link>
        <span className="ml-2 text-xs text-muted-foreground">
          {dealStatusLabel(deal.status)}
        </span>
      </td>
      <td className={cell}>{fmtMoney(deal.agreed_amount_usd) ?? <Missing>No price</Missing>}</td>
      <td className={cell}>{deal.rounds ?? <Missing>None</Missing>}</td>
      <td className={cell}>{fmtLatency(deal.reply_latency_ms) ?? <Missing>No reply</Missing>}</td>
      <td className={cell}>
        {delivered ?? <Missing>None agreed</Missing>}
        {specFailed && (
          <span className="ml-1 text-xs font-medium text-destructive">spec fail</span>
        )}
      </td>
      {showViews && (
        <>
          <td className={cell}>
            {deal.verified.views != null ? (
              deal.verified.views.toLocaleString()
            ) : (
              <Missing>Not measured</Missing>
            )}
          </td>
          <td className={cell}>
            {fmtCpv(deal.cost_per_verified_view_usd) ?? <Missing>Not measured</Missing>}
          </td>
        </>
      )}
      {showStreams && (
        <td className="py-2.5 pl-3 text-right tabular-nums">
          {deal.streams?.streams_per_dollar != null ? (
            <>
              {deal.streams.streams_per_dollar.toFixed(1)}
              <span className="ml-1 text-xs text-muted-foreground">
                {ATTRIBUTION_LABELS[deal.streams.attribution_method ?? ""] ??
                  deal.streams.attribution_method ??
                  ""}
              </span>
            </>
          ) : (
            <Missing>Not measured</Missing>
          )}
        </td>
      )}
    </tr>
  );
}

function PerformanceSection({ perf }: { perf: CreatorPerformance }) {
  const r = perf.rollup;
  const latency = gatedText(r.median_reply_latency_ms, fmtLatency);
  const cpv = gatedText(r.median_cost_per_verified_view_usd, fmtCpv);

  // Close rate and delivery reliability are cross-deal rates, so they carry
  // the same PERF_MIN_SAMPLE gate as the medians: no "100%" off one deal.
  // The raw counts underneath are observations, so they always render.
  const closeRate =
    r.close_rate.status === "ok"
      ? {
          value: `${Math.round(r.close_rate.value * 100)}%`,
          note: `${r.closed_cis} of ${r.close_rate.n} engaged`,
        }
      : {
          value: null,
          note:
            r.close_rate.n > 0
              ? `${r.closed_cis} of ${r.close_rate.n} engaged. Rate needs ${r.close_rate.needed}`
              : "No outreach sent yet",
        };

  const delivery =
    r.delivery.expected > 0
      ? {
          value: `${r.delivery.verified}/${r.delivery.expected}`,
          note:
            r.delivery.reliability.status === "ok"
              ? `${Math.round(r.delivery.reliability.value * 100)}% of promised posts verified`
              : `posts verified vs promised. Rate needs ${r.delivery.reliability.needed}`,
        }
      : { value: null, note: "No deliverables agreed yet" };

  const trend =
    r.price_trend.status === "ok"
      ? {
          value:
            r.price_trend.direction === "flat"
              ? "Flat"
              : r.price_trend.direction === "rising"
                ? "Rising"
                : "Falling",
          note: `over ${r.price_trend.n} closed deals`,
        }
      : {
          value: null,
          note: `Needs ${r.price_trend.needed} closed deals (have ${r.price_trend.n})`,
        };

  // Every rollup above is gated at PERF_MIN_SAMPLE (5). One honest sentence
  // beats five dead tiles; the raw counts underneath are observations, not
  // gated rates, so they stay.
  const anyRollup =
    closeRate.value !== null ||
    latency.value !== null ||
    delivery.value !== null ||
    cpv.value !== null ||
    trend.value !== null;

  // Same rule one level down: a column with nothing measured in it is hidden,
  // and the note under the table says what would fill it.
  const showViews = perf.deals.some((d) => d.verified.views != null);
  const showStreams = perf.deals.some((d) => d.streams?.streams_per_dollar != null);

  return (
    <Section
      title="Performance"
      count={r.deals_count}
      action={
        <span className="text-meta text-muted-foreground">
          {r.confidence.tier === "insufficient"
            ? "Too little data"
            : `${r.confidence.tier.charAt(0).toUpperCase()}${r.confidence.tier.slice(1)} confidence`}
        </span>
      }
    >
      <div className="space-y-5">
        {anyRollup ? (
          <StatGroup>
            <Stat label="Close rate" value={closeRate.value} empty="Not measured yet" sub={closeRate.note} />
            <Stat label="Median reply" value={latency.value} empty="Not measured yet" sub={latency.note} />
            <Stat label="Delivery" value={delivery.value} empty="Not measured yet" sub={delivery.note} />
            <Stat label="Median $ / view" value={cpv.value} empty="Not measured yet" sub={cpv.note} />
            <Stat label="Price trend" value={trend.value} empty="Not measured yet" sub={trend.note} />
          </StatGroup>
        ) : (
          <div className="text-meta text-muted-foreground">
            <p>
              Close rate, reply time, delivery, cost per view and price direction
              each need {PERF_MIN_SAMPLE} finished deals before they mean anything.{" "}
              {r.deals_count === 1 ? "There is 1 so far." : `There are ${r.deals_count} so far.`}
            </p>
            {/* Raw counts, not gated rates: these are facts. */}
            <p className="mt-1">
              {r.close_rate.n > 0
                ? `${r.closed_cis} of ${r.close_rate.n} approaches reached a deal.`
                : "No outreach has gone out to this creator yet."}{" "}
              {r.delivery.expected > 0
                ? `${r.delivery.verified} of ${r.delivery.expected} promised posts verified.`
                : "No deliverables agreed yet."}
            </p>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="h-9 pr-3 text-left font-medium">Campaign</th>
                <th className="h-9 px-3 text-right font-medium">Price</th>
                <th className="h-9 px-3 text-right font-medium">Rounds</th>
                <th className="h-9 px-3 text-right font-medium">Reply</th>
                <th className="h-9 px-3 text-right font-medium">Delivered</th>
                {showViews && (
                  <>
                    <th className="h-9 px-3 text-right font-medium">Views</th>
                    <th className="h-9 px-3 text-right font-medium">$ / view</th>
                  </>
                )}
                {showStreams && <th className="h-9 pl-3 text-right font-medium">Streams / $</th>}
              </tr>
            </thead>
            <tbody>
              {perf.deals.map((deal) => (
                <DealPerformanceRow
                  key={deal.offer_id}
                  deal={deal}
                  showViews={showViews}
                  showStreams={showStreams}
                />
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          {showViews
            ? "Views are counted on posts we have checked ourselves and confirmed went live. Nothing here is estimated from follower counts."
            : "Views and cost per view appear per deal once a promised post is confirmed live and its numbers are read."}
          {showStreams &&
            " Streams / $ shows only on deals with a recorded outcome, labelled with how the streams were attributed; it is never a share of a campaign-wide figure."}
        </p>
      </div>
    </Section>
  );
}
