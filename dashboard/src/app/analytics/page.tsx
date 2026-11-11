"use client";
// src/app/analytics/page.tsx — /analytics
//
// What the label's money actually bought. Renders the CorrelationReport from
// GET /api/analytics/correlations: scope bar → sample-data banner → summary
// strip → the strongest finding → ranked factor cards → one card naming the
// factors that don't have enough deals behind them yet.
//
// This page used to put nine identical grey cards on screen, and with
// little data every one of them read "not enough data", because a factor
// needs 5 measured deals. Now:
//   - a factor only gets a card when it can actually say something
//     (`speaks()`), and the cards are ranked so the top of the page is the
//     strongest finding rather than registry order
//   - the two pairs that ask the same buying question twice (size/engagement,
//     generosity/price-give) render under one heading
//   - when nothing can speak, the page shows the empty state that names the
//     next action instead of nine dead boxes
//
// Data seam: the page consumes the LIVE endpoint by default. Only when
// the route is absent (404) or when forced via ?mock=1 IN A DEV BUILD does it
// fall back to the colocated contract fixture, and then only behind a loud
// "CONTRACT FIXTURE" banner. Non-404 failures show an error card with a retry.
// The fixture is never silently substituted for live numbers, and in a
// production build it is not reachable from the UI or the URL at all.

import { useEffect, useRef, useState } from "react";
import { CircleQuestionMark, FlaskConical } from "lucide-react";

import { cn } from "@/lib/utils";
import { AppShell } from "@/components/AppShell";
import { useIsOperator } from "@/components/OperatorContext";
import { StreamLiftCard } from "@/components/StreamLiftCard";
import { Button } from "@/components/ui/button";
import {
  EmptyState as PageEmptyState,
  Section,
  Stat,
  StatGroup,
} from "@/components/page";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

import { ConfidenceLegend } from "./ConfidenceBadge";
import { FactorCard, categoricalSentence, numericSentence } from "./FactorCard";
import { SampleBadge, SampleDataBanner } from "./SampleDataBanner";
import { fixtureResponse } from "./contract-fixture";
import { fmtCompact, fmtUsd } from "./format";
import type { CorrelationsResponse, FactorId, FactorResult } from "./contract";

type DataSource = "live" | "fixture";

/**
 * Demo-safety gate for the contract fixture.
 *
 * The fixture is fabricated data — 40 deals, 1.5M streams, $5,240 of spend.
 * This page may be shown on a shared screen, so in a production build
 * NOTHING may put those numbers up: not a click, and not a URL. `?mock=1` is
 * read through this gate for exactly that reason; it used to be read before
 * it, which made a fabricated dashboard one typed query param away in prod.
 *
 * The affordance is not deleted — run a dev build and it is all still there.
 * Next.js inlines NODE_ENV into the client bundle at build time.
 */
const DEV_AFFORDANCES = process.env.NODE_ENV !== "production";

/** Scope select value: 'real' | 'sample' | a campaign id. */
function scopeQuery(scope: string): string {
  return scope === "real" || scope === "sample"
    ? `scope=${scope}`
    : `scope=campaign&campaign_id=${encodeURIComponent(scope)}`;
}

// ── Ranking + grouping ───────────────────────────────────────────────────────

/** A factor earns a card only when it has both a tier above 'insufficient'
 *  and something to draw. Everything else is named in one line instead. */
function speaks(f: FactorResult): boolean {
  if (f.confidence.tier === "insufficient") return false;
  return f.kind === "numeric" ? f.buckets.length > 0 : f.groups.length > 0;
}

const TIER_WEIGHT = { insufficient: 0, low: 1, medium: 2, high: 3 } as const;

/** Loudness, for ordering only. Confidence dominates: a well-evidenced weak
 *  trend outranks a strong one drawn from five deals. */
function loudness(f: FactorResult): number {
  const tier = TIER_WEIGHT[f.confidence.tier] * 10;
  if (f.kind === "numeric") {
    const effect =
      f.direction === "none" || f.spearman_rho == null
        ? 0
        : Math.min(1, Math.abs(f.spearman_rho));
    return tier + effect;
  }
  if (!f.leader) return tier;
  const lead = f.groups.find((g) => g.value === f.leader);
  const second = f.groups.find((g) => g.value !== f.leader);
  if (!lead || !second || second.mean_outcome <= 0) return tier + 1;
  return tier + Math.min(1, lead.mean_outcome / second.mean_outcome - 1);
}

/** The one-sentence finding a card is making. */
function finding(f: FactorResult): string {
  return f.kind === "numeric" ? numericSentence(f) : categoricalSentence(f);
}

/**
 * Pairs that ask the same buying question twice. Follower count and engagement
 * are both "which creator is worth it"; price-give and perceived generosity
 * are both "did conceding on price pay off". Side by side under one heading
 * they read as one question with two readings — as nine peers they read as
 * nine unrelated dashboards.
 */
const FACTOR_PAIRS: ReadonlyArray<{ heading: string; ids: FactorId[] }> = [
  {
    heading: "Which creators are worth it",
    ids: ["follower_count", "engagement_rate"],
  },
  {
    heading: "Did giving ground on price pay off",
    ids: ["price_give_pct", "perceived_generosity"],
  },
];

type Unit =
  | { kind: "one"; key: string; factor: FactorResult }
  | { kind: "pair"; key: string; heading: string; factors: FactorResult[] };

/** Ranked render units: pairs stay together, everything sorts by loudness. */
function toUnits(factors: FactorResult[]): Unit[] {
  const byId = new Map(factors.map((f) => [f.factor, f]));
  const claimed = new Set<FactorId>();
  const units: Unit[] = [];

  for (const pair of FACTOR_PAIRS) {
    const present = pair.ids
      .map((id) => byId.get(id))
      .filter((f): f is FactorResult => f != null);
    if (present.length < 2) continue; // a lone survivor stands on its own
    present.forEach((f) => claimed.add(f.factor));
    units.push({
      kind: "pair",
      key: pair.ids.join("+"),
      heading: pair.heading,
      factors: present,
    });
  }
  for (const f of factors) {
    if (claimed.has(f.factor)) continue;
    units.push({ kind: "one", key: f.factor, factor: f });
  }

  const score = (u: Unit) =>
    u.kind === "one"
      ? loudness(u.factor)
      : Math.max(...u.factors.map(loudness));
  return units.sort((a, b) => score(b) - score(a));
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const isOperator = useIsOperator();
  const [scope, setScope] = useState<string>("real");
  const [resp, setResp] = useState<CorrelationsResponse | null>(null);
  const [source, setSource] = useState<DataSource>("live");
  const [error, setError] = useState<string | null>(null);
  const [refetching, setRefetching] = useState(false);
  // ?mock=1 forces fixture mode (§7.3) — in a dev build only. Lazy init:
  // identical first render either way (loading skeleton), so no hydration
  // concern.
  const [forceMock, setForceMock] = useState<boolean>(
    () =>
      DEV_AFFORDANCES &&
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("mock")
  );
  const [reloadKey, setReloadKey] = useState(0);
  const hasDataRef = useRef(false);

  useEffect(() => {
    let alive = true;
    async function load() {
      if (hasDataRef.current) setRefetching(true);
      setError(null);
      try {
        if (!forceMock) {
          const r = await fetch(`/api/analytics/correlations?${scopeQuery(scope)}`, {
            cache: "no-store",
          });
          if (r.ok) {
            const body = (await r.json()) as CorrelationsResponse;
            if (alive) {
              setResp(body);
              setSource("live");
              hasDataRef.current = true;
            }
            return;
          }
          // In a dev build a 404 means the route isn't deployed yet
          // (parallel build) → fall back to the loudly-labeled fixture. In a
          // production build every non-OK response is a real failure and gets
          // the error card; fabricated numbers never auto-substitute.
          if (r.status !== 404 || !DEV_AFFORDANCES) {
            console.error(
              `[analytics] GET /api/analytics/correlations → HTTP ${r.status}`
            );
            throw new Error(
              "We couldn’t load analytics just now. Nothing is wrong with your campaign data. Try again in a moment."
            );
          }
        }
        if (alive) {
          setResp(fixtureResponse(scope));
          setSource("fixture");
          hasDataRef.current = true;
        }
      } catch (e) {
        // Network-level throws (offline, DNS, aborted socket) carry engine
        // wording like "Failed to fetch". Never put that on a client screen —
        // log it for triage, show a sentence a label can act on.
        console.error("[analytics] correlations load failed", e);
        if (alive)
          setError(
            "We couldn’t reach analytics just now. Check your connection and try again. No campaign data is affected."
          );
      } finally {
        if (alive) setRefetching(false);
      }
    }
    void load();
    return () => {
      alive = false;
    };
  }, [scope, forceMock, reloadKey]);

  const report = resp?.report ?? null;
  const campaigns = resp?.campaigns ?? [];
  // Fixture data is fabricated whatever its scope claims, so it gets the same
  // per-card "Sample" tag as seeded sample data. A banner alone is one scroll
  // away from being off screen; the tag survives a screenshot of one card.
  const fabricated = source === "fixture";
  const synthetic = (report?.scope.synthetic ?? false) || fabricated;
  const hasSample = campaigns.some((c) => c.synthetic);

  // The seeded multi-campaign demo is one of our tools for showing the product,
  // not a feature of it. A label clicking it lands on fabricated numbers, so
  // both routes in (the scope option and the empty state's button) are
  // operator-only. Their OWN synthetic campaigns still list, tagged.
  const showSampleScope = isOperator;

  // Base UI Select renders the raw value in the trigger unless Root gets an
  // items map — this supplies the human labels.
  const scopeItems = [
    { value: "real", label: "All campaigns" },
    ...(showSampleScope
      ? [{ value: "sample", label: "Sample data (multi-campaign demo)" }]
      : []),
    ...campaigns.map((c) => ({ value: c.id, label: c.artist_name })),
  ];

  const units = report ? toUnits(report.factors.filter(speaks)) : [];
  const quiet = report ? report.factors.filter((f) => !speaks(f)) : [];
  const lead = units[0];
  const leadFactor =
    lead == null
      ? null
      : lead.kind === "one"
        ? lead.factor
        : [...lead.factors].sort((a, b) => loudness(b) - loudness(a))[0];

  return (
    <AppShell
      title="Results"
      actions={
      <Popover>
        <PopoverTrigger
          render={
            <Button variant="ghost" size="sm" className="text-muted-foreground" />
          }
        >
          <CircleQuestionMark className="size-3.5" />
          How confidence works
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">
          <PopoverHeader>
            <PopoverTitle>How sure is this?</PopoverTitle>
            <PopoverDescription>
              Every claim here rests on finished deals: ones where a post
              went live and we recorded what it did. The fewer of those, the
              less we will say. Under five, we say nothing at all.
            </PopoverDescription>
          </PopoverHeader>
          <ConfidenceLegend />
        </PopoverContent>
      </Popover>
      }
    >
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        {/* Scope bar: one filter row above everything it scopes */}
        <div className="flex flex-wrap items-center gap-3">
          <Select
            items={scopeItems}
            value={scope}
            onValueChange={(v) => v && setScope(v)}
          >
            <SelectTrigger className="w-full max-w-xs sm:w-72" aria-label="Results for">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="real">All campaigns</SelectItem>
              {showSampleScope && (
                <SelectItem value="sample">Sample data (multi-campaign demo)</SelectItem>
              )}
              {campaigns.length > 0 && <SelectSeparator />}
              {campaigns.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  <span className="flex items-center gap-1.5">
                    {c.artist_name}
                    {c.synthetic && <SampleBadge />}
                    <span className="text-xs tabular-nums text-faint">
                      {c.deals_measured} measured
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

        </div>

        {/* Contract-fixture banner: loud, never silent */}
        {source === "fixture" && report && (
          <FixtureBanner
            forced={forceMock}
            onTryLive={() => {
              setForceMock(false);
              setReloadKey((k) => k + 1);
            }}
          />
        )}

        {/* Sample-data banner: every synthetic scope is unmistakably fake.
            Suppressed in fixture mode: FixtureBanner above already says this
            data is fabricated, and two stacked "this is fake" banners read as
            a rendering bug rather than as twice the warning. */}
        {synthetic && !fabricated && <SampleDataBanner />}

        {error ? (
          <ErrorCard
            message={error}
            onRetry={() => setReloadKey((k) => k + 1)}
            onPreviewFixture={() => setForceMock(true)}
          />
        ) : !report ? (
          <LoadingSkeleton />
        ) : (
          <div
            className={cn(
              "flex flex-col gap-10",
              // Hold the previous render at reduced opacity on refetch: no
              // skeleton flash, no layout jump.
              refetching && "pointer-events-none opacity-60"
            )}
          >
            {/* Artist-side streaming lift. Only meaningful for a
                single campaign, and deliberately outside the deals_measured
                gate below: lift comes from the artist's own listener series,
                so it exists even before any per-deal outcome is recorded. */}
            {scope !== "real" && scope !== "sample" && (
              <StreamLiftCard campaignId={scope} />
            )}

            {/* The sums are facts, not claims — they stay on screen even when
                no factor has enough behind it to say anything. Hiding them
                would hide real spend. */}
            {report.deals_measured > 0 && (
              <SummaryStrip
                deals={report.deals_measured}
                streams={report.totals.streams}
                spend={report.totals.spend_usd}
                spd={report.totals.streams_per_dollar}
                synthetic={synthetic}
              />
            )}

            {units.length === 0 ? (
              <EmptyState
                dealsMeasured={report.deals_measured}
                hasSample={hasSample && showSampleScope}
                onViewSample={() => setScope("sample")}
              />
            ) : (
              <>
                {/* One conclusion at the top, so the page has a primary read
                    instead of nine equal-weight boxes. */}
                {leadFactor && (
                  <div className="border-l-2 border-primary pl-4">
                    <p className="text-meta text-muted-foreground">Strongest signal so far</p>
                    <p className="mt-0.5 text-base font-medium text-foreground">
                      {finding(leadFactor)}
                    </p>
                  </div>
                )}

                <div className="grid gap-4 md:grid-cols-2">
                  {units.map((u) =>
                    u.kind === "one" ? (
                      <FactorCard
                        key={u.key}
                        result={u.factor}
                        synthetic={synthetic}
                      />
                    ) : (
                      <Section key={u.key} title={u.heading} className="md:col-span-2">
                        <div className="grid gap-4 md:grid-cols-2">
                          {u.factors.map((f) => (
                            <FactorCard
                              key={f.factor}
                              result={f}
                              synthetic={synthetic}
                            />
                          ))}
                        </div>
                      </Section>
                    )
                  )}
                </div>

                {quiet.length > 0 && <QuietFactors factors={quiet} />}
              </>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// summary strip — sums, not claims

function SummaryStrip({
  deals,
  streams,
  spend,
  spd,
  synthetic,
}: {
  deals: number;
  streams: number;
  spend: number;
  spd: number | null;
  synthetic: boolean;
}) {
  return (
    <div>
      <StatGroup>
        <Stat label="Measured deals" value={String(deals)} />
        <Stat label="Total streams" value={fmtCompact(streams)} />
        <Stat label="Spend" value={fmtUsd(spend)} />
        <Stat label="Streams / $" value={spd == null ? null : fmtCompact(spd)} empty="Not measured yet" />
      </StatGroup>
      {/* The one thing the four numbers are collectively saying, and it is
          not obvious: these are not your campaign totals. */}
      <p className="mt-2 text-xs text-muted-foreground">
        Counts only deals where a post went live and its streams were recorded,
        not your campaign totals.
        {synthetic && " Sample data."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// states

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-20 w-full" />
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-64 w-full" />
        ))}
      </div>
    </div>
  );
}

/** The factors that can't say anything yet — named once, in one card, instead
 *  of nine identical "not enough data" boxes. The two pairs that ask the same
 *  buying question collapse to a single line. */
function QuietFactors({ factors }: { factors: FactorResult[] }) {
  const byId = new Map(factors.map((f) => [f.factor, f]));
  const claimed = new Set<FactorId>();
  const lines: string[] = [];

  for (const pair of FACTOR_PAIRS) {
    const present = pair.ids.filter((id) => byId.has(id));
    if (present.length < 2) continue;
    present.forEach((id) => claimed.add(id));
    lines.push(pair.heading);
  }
  for (const f of factors) {
    if (claimed.has(f.factor)) continue;
    lines.push(f.label);
  }

  return (
    <p className="border-t pt-4 text-meta text-muted-foreground">
      <span className="font-medium text-foreground">Still gathering. </span>
      We don’t have five finished deals behind these yet, so this page won’t
      guess at them: {lines.join(", ")}.
    </p>
  );
}

function EmptyState({
  dealsMeasured,
  hasSample,
  onViewSample,
}: {
  dealsMeasured: number;
  hasSample: boolean;
  onViewSample: () => void;
}) {
  const started = dealsMeasured > 0;
  return (
    <PageEmptyState
      title={
        started
          ? "Not enough finished deals to say anything yet"
          : "No measured results here yet"
      }
      action={
        hasSample ? (
          <Button variant="outline" size="sm" onClick={onViewSample}>
            <FlaskConical className="size-3.5" /> See a worked example
          </Button>
        ) : undefined
      }
    >
      {started ? (
        <>
          You have {dealsMeasured} deal{dealsMeasured === 1 ? "" : "s"} with
          results recorded. It takes at least five before we’ll call a pattern.
          On the next creator whose post is live, open the campaign’s deals and
          use <strong className="font-medium text-foreground">Record streams</strong>.
        </>
      ) : (
        <>
          This compares what you paid against what each post delivered. On a
          creator whose post is live, open the campaign’s deals and use{" "}
          <strong className="font-medium text-foreground">Record streams</strong>.
          The first one you record appears here.
        </>
      )}
    </PageEmptyState>
  );
}

function ErrorCard({
  message,
  onRetry,
  onPreviewFixture,
}: {
  message: string;
  onRetry: () => void;
  onPreviewFixture: () => void;
}) {
  return (
    <PageEmptyState
      title="Results didn’t load"
      action={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
          {/* Dev-only: puts fabricated numbers on screen, so it must not be
              one click away on a build a client is looking at. */}
          {DEV_AFFORDANCES && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={onPreviewFixture}
            >
              <FlaskConical className="size-3.5" /> Preview with mock data (dev)
            </Button>
          )}
        </div>
      }
    >
      {message}
    </PageEmptyState>
  );
}

function FixtureBanner({
  forced,
  onTryLive,
}: {
  forced: boolean;
  onTryLive: () => void;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-attention-border bg-attention px-4 py-3 text-sm text-attention-fg"
    >
      <p className="flex items-start gap-3">
        <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          <strong>Contract fixture.</strong>{" "}
          {forced
            ? "Mock mode was forced (?mock=1)."
            : "The live correlations endpoint isn’t available yet."}{" "}
          Showing built-in mock data matching the API contract. Nothing here is
          real.
        </span>
      </p>
      <Button variant="outline" size="sm" onClick={onTryLive}>
        Try live endpoint
      </Button>
    </div>
  );
}
