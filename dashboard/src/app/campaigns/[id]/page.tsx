// src/app/campaigns/[id]/page.tsx
//
// Campaign detail page (centerpiece of the demo): artist header + status badge,
// the SSE-driven CampaignProgress runner, and the ranked list of discovered
// creators. Schema-adapted: campaign_influencers.composite_score (not `score`).
"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Hand, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CampaignProgress } from "@/components/CampaignProgress";
import { CampaignDeliverables } from "@/components/CampaignDeliverables";
import { CampaignMaterials } from "@/components/CampaignMaterials";
import { StreamLiftCard } from "@/components/StreamLiftCard";
import { AppShell } from "@/components/AppShell";
import {
  CampaignStatusBadge,
  StatusBadge,
  type AtsStatus,
} from "@/components/StatusBadge";
import { AttentionCallout, Section, Stat, StatGroup } from "@/components/page";
import { ArtistIdentityChip } from "@/components/ArtistIdentityChip";
import { readArtistIdentity } from "@/lib/artist-identity";
import type { CampaignState } from "@/lib/statuses";
import {
  EXCLUSION_CAUSES,
  EXCLUSION_CAUSE_LABELS,
} from "@/lib/pool-gates";
import { WINDOW_PHASE_LABELS, type WindowPhase } from "@/lib/campaign-window";
// creator_offers.status → words, shared with /campaigns/[id]/deals and the
// per-creator thread. This file used to carry its own eleven-row copy of the
// same map.
import { dealGroup, funnelShortLabel } from "./deals/funnel-labels";
import { contactedLabel } from "@/lib/outreach-send-copy";
import { CreatorQualityLines } from "@/components/CreatorQualityLines";

// Statuses dashboard — compact campaign-state strip under the
// title: budget consumed vs total, deals by stage, response rate,
// CPM-to-date (omitted when there is no verified reach — never faked),
// qualification split. Data: GET /api/campaigns/[id]/statuses; math lives
// in src/lib/statuses.ts. Own component so a slow aggregate never blocks
// the ranked-creators list.
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;

function CampaignStateHeader({
  campaignId,
  refreshKey,
  reviewAction,
  onState,
}: {
  campaignId: string;
  /** Bumped by the parent after anything that changes these numbers. Without
   *  it the strip was fetched once on mount, so screening creators moved the
   *  badges in the list below and left this card reading the old split. */
  refreshKey: number;
  reviewAction?: React.ReactNode;
  /** Lets the page raise the "waiting on you" callout from the same load. */
  onState?: (s: CampaignState) => void;
}) {
  const [state, setState] = useState<CampaignState | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadState() {
      try {
        const r = await fetch(`/api/campaigns/${campaignId}/statuses`, {
          cache: "no-store",
        });
        if (!r.ok) {
          if (!cancelled) setFailed(true);
          return;
        }
        const json = (await r.json()) as { state?: CampaignState };
        if (!cancelled && json.state) {
          setState(json.state);
          setFailed(false);
          onState?.(json.state);
        } else if (!cancelled) setFailed(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    void loadState();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, refreshKey]);

  // Both fallbacks still render the action. Screening does not depend on this
  // card loading, and hiding the control because a summary query failed would
  // take a working button away for an unrelated reason.
  if (failed) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 border-y py-5">
        <p className="text-sm text-muted-foreground">
          These numbers could not be loaded just now. Nothing is wrong with the
          campaign. Reload the page to try again.
        </p>
        {reviewAction}
      </div>
    );
  }
  if (!state) {
    return <Skeleton className="h-28 w-full" />;
  }

  // deals_by_stage keys are creator_offers.status verbatim (statuses.ts), so
  // this line used to read "3 human approval required · 2 counter offered".
  const stageLine =
    Object.entries(state.deals_by_stage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([stage, n]) => `${n} ${funnelShortLabel(stage)}`)
      .join(", ") || "No offers yet";
  const q = state.qualification;
  const reviewed = q.qualified + q.excluded;
  // "6 creators ruled out" is not something a label manager can act on;
  // "6 over your follower cap" is. Biggest cause first; causes with no rows
  // stay off the line entirely.
  const ruledOutLine = EXCLUSION_CAUSES.map(
    (c) => [c, q.excluded_by?.[c] ?? 0] as const
  )
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${n} ${EXCLUSION_CAUSE_LABELS[c]}`)
    .join(", ");

  return (
    <StatGroup>
      <Stat
        label="Spent"
        value={usd(state.budget_spent_usd)}
        // Say what the figure above does NOT give you: the ceiling and what
        // is left under it.
        sub={
          state.budget_total_usd != null
            ? `of ${usd(state.budget_total_usd)}. ${usd(Math.max(0, state.budget_total_usd - state.budget_spent_usd))} left`
            : "No total set. Payouts are refused until you set one."
        }
      />
      <Stat label="Deals" value={String(state.deals_total)} sub={stageLine} />
      <Stat
        label="Response rate"
        value={
          state.response_rate != null
            ? `${Math.round(state.response_rate * 100)}%`
            : null
        }
        empty="Nothing sent yet"
        sub={`${state.responded} of ${state.contacted} contacted`}
      />
      <Stat
        label="Cost per 1,000 reached"
        value={state.cpm_usd != null ? `$${state.cpm_usd.toFixed(2)}` : null}
        empty="Appears once a post is live"
      />
      {/* "Screen creators" sits next to the only number it moves. */}
      <Stat
        label="Creators reviewed"
        value={
          <>
            {reviewed}
            <span className="text-base font-normal text-faint"> of {reviewed + q.unreviewed}</span>
          </>
        }
        sub={
          <>
            {q.qualified} a good fit, {q.excluded} ruled out
            {ruledOutLine ? ` (${ruledOutLine})` : ""}
            {reviewAction && <div className="mt-2">{reviewAction}</div>}
          </>
        }
      />
    </StatGroup>
  );
}

/** Statuses that need the label to do something on the deals page. */
function waitingOnYou(state: CampaignState | null): number {
  if (!state) return 0;
  return Object.entries(state.deals_by_stage)
    .filter(([stage]) => dealGroup(stage) === "action")
    .reduce((n, [, v]) => n + v, 0);
}

/** TikTok avatar URLs expire; a dead one used to print its alt text. */
function CreatorAvatar({ src, username }: { src?: string | null; username: string }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        onError={() => setBroken(true)}
        className="size-7 shrink-0 rounded-full bg-muted object-cover"
      />
    );
  }
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
      {(username || "?").charAt(0).toUpperCase()}
    </span>
  );
}

// F-followup: drafting state lives in its own component so generating
// drafts does NOT cause the ranked-creators list to re-render. The list
// is owned by the parent; the drafter only mutates its own state.
type DraftStatus =
  | { kind: "idle" }
  | { kind: "running" }
  | {
      kind: "done";
      drafted: number;
      failed: number;
      cost_usd: number;
      target_count?: number;
      expected_deal_rate?: number;
      wanted_drafts?: number;
      pool_size?: number;
      already_drafted?: number;
      pool_short_of_goal?: number;
      explanation?: string;
      note?: string;
    }
  | { kind: "error"; message: string };

function OutreachDraftsCard({
  campaignId,
  primary,
  progress,
}: {
  campaignId: string;
  /** True when drafting is the campaign's current step. Exactly one card on
   *  this page gets the filled button; the rest are outlines. */
  primary: boolean;
  /** "Contacted X of N" — the mini-run limit (src/lib/first-touch-gate.ts). */
  progress?: { contacted: number; limit: number | null } | null;
}) {
  const [status, setStatus] = useState<DraftStatus>({ kind: "idle" });

  async function generate() {
    setStatus({ kind: "running" });
    try {
      const r = await fetch(`/api/campaigns/${campaignId}/draft-all`, {
        method: "POST",
      });
      const body = (await r.json().catch(() => ({}))) as {
        drafted?: number;
        failed?: number;
        cost_usd?: number;
        target_count?: number;
        expected_deal_rate?: number;
        wanted_drafts?: number;
        pool_size?: number;
        already_drafted?: number;
        pool_short_of_goal?: number;
        explanation?: string;
        note?: string;
        error?: string;
        detail?: string;
      };
      if (!r.ok) {
        // `body.error` / `body.detail` are internal identifiers and can carry
        // raw Postgres text ("column ci.qualification_status does not exist").
        // Log them, don't render them.
        console.error(
          `[drafts] POST /api/campaigns/${campaignId}/draft-all → HTTP ${r.status}`,
          body
        );
        setStatus({
          kind: "error",
          message:
            "Drafts couldn’t be generated just now. Nothing was charged. Try again, and send a screenshot if it keeps happening.",
        });
        return;
      }
      setStatus({
        kind: "done",
        drafted: body.drafted ?? 0,
        failed: body.failed ?? 0,
        cost_usd: body.cost_usd ?? 0,
        target_count: body.target_count,
        expected_deal_rate: body.expected_deal_rate,
        wanted_drafts: body.wanted_drafts,
        pool_size: body.pool_size,
        already_drafted: body.already_drafted,
        pool_short_of_goal: body.pool_short_of_goal,
        explanation: body.explanation,
        note: body.note,
      });
      // The route's `explanation` is a telemetry string
      // ("target_count=25 ÷ deal_rate=0.150 → wanted=167; pool=40 …"). Useful
      // to us, unreadable to a label — keep it in devtools, off the screen.
      if (body.explanation) console.info("[drafts]", body.explanation);
    } catch (e) {
      console.error("[drafts] request failed", e);
      setStatus({
        kind: "error",
        message:
          "We couldn’t reach the drafting service. Check your connection and try again.",
      });
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={generate}
          variant={primary ? "default" : "outline"}
          disabled={status.kind === "running"}
        >
          {status.kind === "running"
            ? "Generating…"
            : "Generate drafts to hit the campaign target"}
        </Button>
        {status.kind === "running" && (
          <span className="text-sm text-muted-foreground">
            This can take a few minutes.
          </span>
        )}
        {status.kind === "done" && (
          <span className="text-sm">
            {status.drafted > 0
              ? `Wrote ${status.drafted} draft${status.drafted === 1 ? "" : "s"}`
              : "No new drafts were needed"}
            {status.failed > 0 && `, ${status.failed} couldn’t be written`}
            {status.cost_usd > 0 && `, $${status.cost_usd.toFixed(2)}`}
          </span>
        )}
        {status.kind === "error" && (
          <span className="text-sm text-destructive">{status.message}</span>
        )}
        {progress && (
          <span className="ml-auto text-meta tabular-nums text-muted-foreground">
            {contactedLabel(progress.contacted, progress.limit)}
          </span>
        )}
      </div>
      {/* `drafted: 0` comes back as a 200 with a `note` explaining why. Without
          this the card read "Drafted 0, Failed 0, Cost $0.00" and looked broken. */}
      {status.kind === "done" && status.drafted === 0 && (
        <p className="text-sm text-muted-foreground">
          {status.note ??
            "Every creator in this campaign already has a draft. Run discovery again to add more creators."}
        </p>
      )}
      {status.kind === "done" && (status.pool_short_of_goal ?? 0) > 0 && (
        <p className="rounded-md border border-attention-border bg-attention px-3 py-2 text-xs text-attention-fg">
          There aren&rsquo;t enough creators yet to hit the campaign goal: short
          by {status.pool_short_of_goal}. Run discovery again with a wider brief
          (more genres, a broader follower range, more regions) to find more,
          then come back here.
        </p>
      )}
      {status.kind === "done" && (
        <Link href="/outreach" className="text-sm font-medium text-primary hover:underline">
          Review and send the drafts
        </Link>
      )}
    </div>
  );
}

// Verdicts belong in the ranked list BEFORE anyone clicks
// Generate. The button walks POST /api/campaigns/[id]/qualify in bounded
// rounds (each server-side capped on batch size, model calls, and time)
// until the campaign's unreviewed backlog is empty, then reloads the list so
// the Excluded badges and the qualification split reflect the verdicts.
type ScreenStatus =
  | { kind: "idle" }
  | { kind: "running"; processed: number; excluded: number; remaining: number | null }
  | { kind: "done"; processed: number; excluded: number; partial?: boolean }
  | { kind: "error" };

function ScreenPoolButton({
  campaignId,
  onDone,
}: {
  campaignId: string;
  onDone: () => void;
}) {
  const [status, setStatus] = useState<ScreenStatus>({ kind: "idle" });

  async function screen() {
    setStatus({ kind: "running", processed: 0, excluded: 0, remaining: null });
    let processed = 0;
    let excluded = 0;
    try {
      const MAX_ROUNDS = 25;
      for (let i = 0; i < MAX_ROUNDS; i++) {
        const r = await fetch(`/api/campaigns/${campaignId}/qualify`, {
          method: "POST",
        });
        if (!r.ok) {
          console.error(
            `[screen] POST /api/campaigns/${campaignId}/qualify → HTTP ${r.status}`
          );
          if (processed > 0) {
            setStatus({ kind: "done", processed, excluded, partial: true });
            onDone();
          } else {
            setStatus({ kind: "error" });
          }
          return;
        }
        const body = (await r.json().catch(() => ({}))) as {
          processed?: number;
          excluded?: number;
          qualified?: number;
          remaining?: number;
        };
        processed += body.processed ?? 0;
        excluded += body.excluded ?? 0;
        setStatus({
          kind: "running",
          processed,
          excluded,
          remaining: body.remaining ?? null,
        });
        if ((body.remaining ?? 0) <= 0 || (body.processed ?? 0) === 0) break;
        // No verdicts landed this round (e.g. the qualification model is
        // down and every row failed open to unreviewed) — looping again
        // would spin on the same backlog. Stop; a later click resumes.
        if ((body.excluded ?? 0) + (body.qualified ?? 0) === 0) break;
      }
      setStatus({ kind: "done", processed, excluded });
      onDone();
    } catch (e) {
      console.error("[screen] request failed", e);
      if (processed > 0) {
        setStatus({ kind: "done", processed, excluded, partial: true });
        onDone();
      } else {
        setStatus({ kind: "error" });
      }
    }
  }

  return (
    <div className="flex items-center gap-2">
      {status.kind === "running" && (
        <span className="text-xs text-muted-foreground">
          Screening…
          {status.remaining != null ? ` ${status.remaining} left` : ""}
        </span>
      )}
      {status.kind === "done" && (
        <span className="text-xs text-muted-foreground">
          Screened {status.processed}, {status.excluded} ruled out
          {status.partial ? " (stopped early; run again for the rest)" : ""}
        </span>
      )}
      {status.kind === "error" && (
        <span className="text-xs text-destructive">
          Screening didn&rsquo;t start. Try again in a moment.
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={screen}
        disabled={status.kind === "running"}
        title="Check every creator you have not reviewed yet against your follower cap, audience fit, and the rule that keeps other recording artists out"
      >
        {status.kind === "running" ? "Screening…" : "Screen creators"}
      </Button>
    </div>
  );
}

/**
 * The campaign window, on the page that runs the campaign.
 *
 * The window is what gates sends and measurement, so when a label asks "why
 * has nothing gone out?" the answer has to be visible here rather than only in
 * a tick tally. Renders the release date it is derived FROM and the offsets
 * that produced it, because a bare date range invites "says who?".
 *
 * A campaign with no release_date is not an error state and must not look like
 * one: it says so plainly and explains the consequence (outreach is untimed).
 */
// Only an open window is good news; "before" and "grace" are time-sensitive.
const WINDOW_PHASE_TONE: Record<WindowPhase, AtsStatus> = {
  no_window: "sourced",
  before: "sourced",
  open: "payout-complete",
  grace: "payout-pending",
  closed: "sourced",
};

const fmtDay = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

function CampaignWindowBar({ campaign }: { campaign: Campaign }) {
  const w = campaign.campaign_window ?? null;

  return (
    <Section
      title="Campaign window"
      action={
        <StatusBadge
          state={WINDOW_PHASE_TONE[w?.phase ?? "no_window"]}
          label={WINDOW_PHASE_LABELS[w?.phase ?? "no_window"]}
        />
      }
    >
      {w ? (
        <div className="space-y-1">
          <p className="text-sm font-medium tabular-nums text-foreground">
            {fmtDay(w.start)} to {fmtDay(w.end)}
          </p>
          <p className="text-xs text-muted-foreground">
            {w.lead_days} days before and {w.tail_days} days after the{" "}
            {campaign.release_date ? fmtDay(campaign.release_date) : "release"} release.
            Outreach and measurement are held to this range.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No release date set, so outreach is not held to a window. Add a release
          date to schedule against it.
        </p>
      )}
    </Section>
  );
}

interface Campaign {
  id: string;
  artist_name: string;
  /** Confirmed artist identity; null on campaigns created before it was required. */
  artist_spotify_id?: string | null;
  artist_data?: Record<string, unknown> | null;
  track_name?: string;
  status: string;
  target_count?: number;
  /** Set by /api/campaigns/[id]/confirm. Null means the run route will refuse
   *  with a 412, which is why this page needs a real Confirm action. */
  confirmed_at?: string | null;
  release_date?: string | null;
  /** Derived server-side in /api/campaigns/[id]. Null = not time-boxed. */
  campaign_window?: {
    start: string;
    end: string;
    lead_days: number;
    tail_days: number;
    phase: WindowPhase;
  } | null;
  /** Mini-run (migration 060), from /api/campaigns/[id]. Null = count unreadable. */
  outreach_progress?: { contacted: number; limit: number | null } | null;
}

interface Influencer {
  id: string;
  username: string;
  follower_count: number | null;
  engagement_rate: number | null;
  avatar_url?: string | null;
  bio?: string | null;
  raw_data?: { posts?: { text?: string }[] } | null;
}

interface CampaignInfluencerRow {
  id: string;
  influencer_id: string;
  composite_score: number | null;
  bot_flagged: boolean;
  qualification_status?: "qualified" | "excluded" | "unreviewed" | null;
  qualification_reason?: string | null;
  influencer: Influencer | null;
}

export default function CampaignDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [rows, setRows] = useState<CampaignInfluencerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [cloning, setCloning] = useState(false);
  const [cloneErr, setCloneErr] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // Bumped after discovery or screening so the state strip refetches. It used
  // to load once and then sit stale while the list below it changed.
  const [stateKey, setStateKey] = useState(0);
  const [campaignState, setCampaignState] = useState<CampaignState | null>(null);
  const [showAllCreators, setShowAllCreators] = useState(false);

  async function cloneCampaign() {
    setCloning(true);
    setCloneErr(null);
    try {
      const r = await fetch(`/api/campaigns/${id}/clone`, { method: "POST" });
      const body = (await r.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!r.ok || !body.id) {
        console.error(
          `[campaign] POST /api/campaigns/${id}/clone → HTTP ${r.status}`,
          body
        );
        setCloneErr(
          "This campaign couldn’t be copied. Nothing was changed. Try again in a moment."
        );
        return;
      }
      router.push(`/campaigns/${body.id}/confirm`);
    } catch (e) {
      console.error("[campaign] clone failed", e);
      setCloneErr(
        "This campaign couldn’t be copied. Nothing was changed. Try again in a moment."
      );
    } finally {
      setCloning(false);
    }
  }

  // A rejected fetch used to skip setLoading(false) entirely and leave the page
  // on "Loading…" forever, and a non-ok campaign response (429 from the auth
  // rate limiter, or any 500) fell through to "Campaign not found." — telling a
  // rate-limited user their campaign had been deleted.
  async function load() {
    setLoadErr(null);
    try {
      const [campRes, infRes] = await Promise.all([
        fetch(`/api/campaigns/${id}`),
        fetch(`/api/campaigns/${id}/influencers`),
      ]);
      if (campRes.ok) {
        const c = (await campRes.json()) as Campaign;
        setCampaign(c);
      } else if (campRes.status === 404) {
        setLoadErr(
          "This campaign could not be found. It may have been deleted in another tab."
        );
      } else if (campRes.status === 429) {
        setLoadErr(
          "We are loading too fast. Wait a few seconds and try again. Nothing is wrong with the campaign."
        );
      } else {
        setLoadErr("We could not load this campaign. Try again.");
      }
      if (infRes.ok) {
        const data = await infRes.json();
        setRows(Array.isArray(data) ? (data as CampaignInfluencerRow[]) : []);
      }
    } catch {
      setLoadErr(
        "We could not reach the server. Check your connection, then try again."
      );
    } finally {
      setLoading(false);
    }
  }

  /** Reload after an action that changes the numbers, not just the list. */
  async function refresh() {
    await load();
    setStateKey((k) => k + 1);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (loading) {
    return (
      <AppShell title="Campaign" back={{ href: "/campaigns", label: "Campaigns" }}>
        {/* One loading treatment across this page and the blocks inside it. */}
        <div className="mx-auto w-full max-w-7xl space-y-6 px-4 pb-12 pt-6 sm:px-6 lg:px-8">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </AppShell>
    );
  }

  if (!campaign) {
    return (
      <AppShell title="Campaign" back={{ href: "/campaigns", label: "Campaigns" }}>
        <div className="mx-auto w-full max-w-7xl space-y-4 px-4 pb-12 pt-6 sm:px-6 lg:px-8">
          <p className="text-muted-foreground">
            {loadErr ?? "We could not load this campaign. Try again."}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() => {
                setLoading(true);
                void load();
              }}
            >
              Try again
            </Button>
            <Link
              href="/campaigns"
              className={buttonVariants({ variant: "outline" })}
            >
              All campaigns
            </Link>
          </div>
        </div>
      </AppShell>
    );
  }

  // The page's one primary action, chosen by where the campaign actually is.
  // Before this, three cards each had a filled button and the page had no
  // primary action at all — it had a menu. When deals are waiting on the
  // label, reviewing them outranks every run step.
  const confirmed = campaign.confirmed_at != null;
  const phase: "confirm" | "discover" | "draft" = !confirmed
    ? "confirm"
    : rows.length === 0
      ? "discover"
      : "draft";
  const waiting = waitingOnYou(campaignState);

  return (
    <AppShell
      title={campaign.artist_name}
      back={{ href: "/campaigns", label: "Campaigns" }}
      badge={<CampaignStatusBadge status={campaign.status} />}
      subtitle={
        readArtistIdentity(campaign) || campaign.track_name ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <ArtistIdentityChip campaign={campaign} />
            {campaign.track_name && <span>Track: {campaign.track_name}</span>}
          </span>
        ) : undefined
      }
      actions={
        <>
          <Button
            type="button"
            variant="ghost"
            onClick={cloneCampaign}
            disabled={cloning}
            title="Create a draft copy of this campaign for a fresh discovery pass"
          >
            {cloning ? "Copying…" : "Make a copy"}
          </Button>
          <Link
            href={`/campaigns/${id}/deals`}
            className={buttonVariants({ variant: "outline" })}
          >
            Deals
          </Link>
        </>
      }
    >
      <div className="mx-auto w-full max-w-7xl space-y-10 px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        {cloneErr && <p className="-mt-4 text-xs text-destructive">{cloneErr}</p>}

        {/* The one tinted block: whatever is blocked on the label right now.
            The confirm step had no entry point anywhere before this; the only
            way to reach it was to press Run discovery and be bounced by a 412. */}
        {phase === "confirm" ? (
          <AttentionCallout
            icon={ShieldCheck}
            title="Confirm this campaign to start it"
            action={
              <Link href={`/campaigns/${id}/confirm`} className={buttonVariants()}>
                Confirm campaign
              </Link>
            }
          >
            Nothing runs until the spending limits are set.
          </AttentionCallout>
        ) : waiting > 0 ? (
          <AttentionCallout
            icon={Hand}
            title={
              waiting === 1
                ? "1 deal is waiting on you"
                : `${waiting} deals are waiting on you`
            }
            action={
              <Link href={`/campaigns/${id}/deals`} className={buttonVariants()}>
                Review deals
              </Link>
            }
          >
            Nothing moves on these until you approve, pay, or record a price.
          </AttentionCallout>
        ) : null}

        {/* ── Read: where this campaign is ──────────────────────────────── */}
        <CampaignStateHeader
          campaignId={id}
          refreshKey={stateKey}
          onState={setCampaignState}
          reviewAction={<ScreenPoolButton campaignId={id} onDone={refresh} />}
        />

        <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* ── Run: the two steps that spend money and send mail. A real
              sequence, so it is numbered. ─────────────────────────────── */}
          <Section title="Run this campaign">
            <ol className="divide-y border-y">
              <li className="py-4">
                <h3 className="mb-3 text-sm font-medium text-foreground">
                  <span className="mr-2 tabular-nums text-faint">1</span>Find creators
                </h3>
                <CampaignProgress
                  campaignId={id}
                  onDone={refresh}
                  primary={phase === "discover" && waiting === 0}
                />
              </li>
              <li className="py-4">
                <h3 className="mb-3 text-sm font-medium text-foreground">
                  <span className="mr-2 tabular-nums text-faint">2</span>Write outreach
                </h3>
                <OutreachDraftsCard
                  campaignId={id}
                  primary={phase === "draft" && waiting === 0}
                  progress={campaign.outreach_progress}
                />
              </li>
            </ol>
          </Section>

          <div className="space-y-10">
            <CampaignWindowBar campaign={campaign} />
            {/* What these deals did to the artist's streams. Its own
                component so a slow aggregate never blocks the rest. */}
            <StreamLiftCard campaignId={id} />
          </div>
        </div>

        {/* ── Read: who was found ───────────────────────────────────────── */}
        <Section title="Ranked creators" count={rows.length}>
          {rows.length === 0 ? (
            <p className="border-y py-6 text-sm text-faint">
              No creators yet. Run step 1 above to find some.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="h-9 w-10 font-medium">#</th>
                    <th className="h-9 pr-3 font-medium">Creator</th>
                    <th className="h-9 px-3 text-right font-medium">Followers</th>
                    <th className="h-9 px-3 text-right font-medium">Engagement</th>
                    <th className="h-9 px-3 text-right font-medium">Score</th>
                    <th className="h-9 px-3 font-medium">Review</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, showAllCreators ? 50 : 12).map((r, i) => {
                    const inf = r.influencer;
                    if (!inf) return null;
                    const score = r.composite_score ?? 0;
                    return (
                      <tr
                        key={r.id}
                        onClick={() => router.push(`/influencers/${inf.id}`)}
                        className="cursor-pointer border-b transition-colors hover:bg-muted/50"
                      >
                        <td className="py-2 tabular-nums text-faint">{i + 1}</td>
                        <td className="py-2 pr-3">
                          <div className="flex items-center gap-2.5">
                            <CreatorAvatar src={inf.avatar_url} username={inf.username} />
                            <div className="min-w-0 max-w-md">
                              <Link
                                href={`/influencers/${inf.id}`}
                                onClick={(e) => e.stopPropagation()}
                                className="block truncate font-medium text-foreground hover:text-primary"
                              >
                                @{inf.username}
                              </Link>
                              {/* Quality signals, comment audit, and the held/override
                                  control. Clicks stay here so Override doesn't open
                                  the creator page. */}
                              <div onClick={(e) => e.stopPropagation()}>
                                <CreatorQualityLines row={r} campaignId={id} onChanged={refresh} />
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {(inf.follower_count ?? 0).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {((inf.engagement_rate ?? 0) * 100).toFixed(1)}%
                        </td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${
                            score >= 70 ? "font-semibold text-foreground" : "text-muted-foreground"
                          }`}
                        >
                          {score}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1.5">
                            {/* A soft signal, so it looks like one and says what
                                it is (was a red "Bot?" badge). */}
                            {r.bot_flagged && (
                              <Badge
                                variant="outline"
                                className="cursor-help border-attention-border text-attention-fg"
                                title="Follower and posting patterns look automated. Worth a look before you contact them."
                              >
                                Looks automated
                              </Badge>
                            )}
                            {/* The tooltip names the reason, not the process. */}
                            {r.qualification_status === "excluded" && (
                              <Badge
                                variant="secondary"
                                className="cursor-help"
                                title={
                                  r.qualification_reason ??
                                  "Ruled out as a poor fit for this campaign. No reason was recorded."
                                }
                              >
                                Ruled out
                              </Badge>
                            )}
                            {r.qualification_status === "qualified" && (
                              <span className="text-xs text-muted-foreground">Good fit</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {rows.length > 12 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  onClick={() => setShowAllCreators((v) => !v)}
                >
                  {showAllCreators
                    ? "Show top 12"
                    : `Show top ${Math.min(50, rows.length)}`}
                </Button>
              )}
            </div>
          )}
        </Section>

        {/* ── Configure: things you set once, not things you run ────────── */}
        <Section title="Campaign setup">
          <div className="space-y-4">
            <CampaignDeliverables campaignId={id} />
            <CampaignMaterials campaignId={id} />
            <p className="text-sm text-muted-foreground">
              Spending limits are set on the confirm step.{" "}
              <Link
                href={`/campaigns/${id}/confirm`}
                className="font-medium text-primary hover:underline"
              >
                {confirmed ? "Change the limits" : "Confirm this campaign"}
              </Link>
            </p>
          </div>
        </Section>
      </div>
    </AppShell>
  );
}
