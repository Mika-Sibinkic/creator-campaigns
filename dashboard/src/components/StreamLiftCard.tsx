"use client";

// src/components/StreamLiftCard.tsx
//
// The label-facing surface for campaign streaming lift.
//
// The hard part of this card is not the chart, it is the restraint. Spotify
// monthly listeners is a rolling 28-day count, so:
//   - a rise the artist was already trending toward is shown as NOT lift,
//   - a deal that shared its window with another deal shows no number at all
//     rather than a proportional share,
//   - every number carries the method that produced it, in text, next to it.
//
// All arithmetic comes from src/lib/stream-lift.ts. This file renders and
// never computes a claim of its own.

import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { CircleDashed, CircleQuestionMark, TrendingDown, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/page";
import { StatusBadge } from "@/components/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { daysBetween, type CampaignLift, type DealWindow } from "@/lib/stream-lift";

interface LiftResponse {
  campaign_id: string;
  artist_name: string;
  artist_confirmed: boolean;
  lift: CampaignLift;
}

// Matches the fmtCompact idiom in src/app/analytics/format.ts.
function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${Math.round(n / 1_000)}k`;
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}
function fmtSigned(n: number): string {
  return `${n >= 0 ? "+" : "−"}${fmtCompact(Math.abs(n))}`;
}
function fmtPct(f: number): string {
  return `${f >= 0 ? "+" : "−"}${(Math.abs(f) * 100).toFixed(1)}%`;
}

/**
 * One headline metric. A null `value` means we genuinely don't have the number,
 * which stays honest: a bare "—" in big mono type reads as a broken screen, so
 * a null renders the reason instead, in normal muted type. Never invent a
 * number to fill the space. Mirrors the Stat in src/app/campaigns/[id]/page.tsx.
 */
function Stat({
  label,
  value,
  empty,
  sub,
}: {
  label: string;
  value: string | null;
  /** Why the value isn't available. Required whenever `value` can be null. */
  empty?: string;
  sub: string;
}) {
  return (
    <div>
      <div className="text-meta text-muted-foreground">{label}</div>
      {value != null ? (
        <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">{value}</div>
      ) : (
        <p className="mt-1 text-sm text-faint">{empty ?? "Not measured yet"}</p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

const METHOD_LABEL: Record<CampaignLift["method"], string> = {
  none: "No measurement yet",
  observed_window_delta: "Observed change",
  baseline_trend_projection: "vs. pre-campaign trend",
};

function MethodologyPopover() {
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="ghost" size="sm" className="text-muted-foreground" />}
      >
        <CircleQuestionMark className="size-3.5" />
        How this is measured
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96">
        <PopoverHeader>
          <PopoverTitle>What this number is</PopoverTitle>
          <PopoverDescription>
            Spotify monthly listeners for this artist, read once a day. It counts
            distinct listeners over a rolling 28-day window. It is not a stream
            count, and consecutive days cannot be added up.
          </PopoverDescription>
        </PopoverHeader>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">Observed change</strong> is the
            difference between the reading taken when you confirmed this campaign
            and the most recent one. It is a fact about the artist, not a claim
            about the campaign.
          </p>
          <p>
            <strong className="text-foreground">vs. pre-campaign trend</strong>{" "}
            extends the line the artist was already on before the campaign and
            compares where they actually landed. This shows correlation over the
            window. It cannot prove cause: a playlist add or a radio play in the
            same days would look identical.
          </p>
          <p>
            Per-creator numbers only appear when a creator&rsquo;s post was the
            only one live in its window. When posts overlap, the movement
            can&rsquo;t be separated between them, so nothing is shown rather
            than a guess.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LiftChart({ lift }: { lift: CampaignLift }) {
  const trend = lift.trend;
  const latest = lift.latest;

  // The projection line passes through (latest.date, expected) with the
  // pre-campaign slope, so it can be evaluated at any date on the axis.
  const projectedAt = (day: string): number | null => {
    if (!trend || !latest) return null;
    return trend.expected + trend.slope_per_day * daysBetween(latest.date, day);
  };

  const data = lift.points.map((p) => ({
    day: p.date.slice(5), // MM-DD — the year is fixed by the window
    observed: p.value,
    projected: projectedAt(p.date),
  }));

  const config = {
    observed: { label: "Monthly listeners", color: "var(--chart-1)" },
    ...(trend
      ? { projected: { label: "Pre-campaign trend", color: "var(--muted-foreground)" } }
      : {}),
  } satisfies ChartConfig;

  return (
    <ChartContainer config={config} className="aspect-auto h-48 w-full">
      <LineChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tick={{ fontSize: 10 }}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={44}
          domain={["dataMin - 100", "dataMax + 100"]}
          tick={{ fontSize: 10 }}
          tickFormatter={(v) => fmtCompact(Number(v))}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        {lift.baseline && (
          <ReferenceLine
            y={lift.baseline.value}
            stroke="var(--border)"
            strokeDasharray="2 4"
          />
        )}
        {trend && (
          <Line
            dataKey="projected"
            type="linear"
            stroke="var(--color-projected)"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            dot={false}
            connectNulls
          />
        )}
        <Line
          dataKey="observed"
          type="monotone"
          stroke="var(--color-observed)"
          strokeWidth={2}
          dot={false}
        />
        {trend && <ChartLegend content={<ChartLegendContent />} />}
      </LineChart>
    </ChartContainer>
  );
}

function DealWindowRow({ d }: { d: DealWindow }) {
  const label = d.creator_label ? `@${d.creator_label.replace(/^@/, "")}` : "Creator";
  const measurable = d.status === "sole_post_window" && d.observed_delta != null;
  return (
    <li className="flex items-start justify-between gap-3 border-t py-2 first:border-t-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{d.reason}</p>
      </div>
      <div className="shrink-0 text-right">
        {measurable ? (
          <>
            <span className="tabular-nums text-sm font-semibold">
              {fmtSigned(d.observed_delta as number)}
            </span>
            <p className="text-xs text-muted-foreground">
              over {d.window_days} {d.window_days === 1 ? "day" : "days"}
            </p>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Unknown</span>
        )}
      </div>
    </li>
  );
}

/**
 * The state this card renders until a campaign has streaming data, so it has to
 * carry its own weight: the computed reason, plus what would actually put a
 * number here. Today no campaign has its artist matched to a streaming profile,
 * so the readings table is not merely empty — nothing is writing to it.
 */
function NotMeasured({ reason }: { reason: string }) {
  return (
    <div className="space-y-1">
      <p className="text-sm text-muted-foreground">{reason}</p>
      <p className="text-xs text-faint">
        Readings start once this campaign&rsquo;s artist is matched to their
        streaming profile and a first daily reading has been taken. Until then
        there is nothing to compare against, so this is not a zero result.
      </p>
    </div>
  );
}

export function StreamLiftCard({ campaignId }: { campaignId: string }) {
  const [data, setData] = useState<LiftResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch(`/api/campaigns/${campaignId}/lift`, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const body = (await r.json()) as LiftResponse;
        if (live) setData(body);
      } catch (e) {
        // Never surface raw HTTP text to a label.
        console.error("lift fetch failed", e);
        if (live) setFailed(true);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [campaignId]);

  if (loading) return <Skeleton className="h-64 w-full" />;
  if (failed || !data) {
    return (
      <Section title="Streaming impact">
        <p className="text-sm text-muted-foreground">
          Streaming numbers aren&rsquo;t loading right now. Nothing is wrong
          with your campaign data.
        </p>
      </Section>
    );
  }

  const { lift } = data;
  const trend = lift.trend;

  // No delta means no direction. `(lift.observed_delta ?? 0) >= 0` coerced the
  // absence of a measurement into "up", so the card rendered a rising trend
  // arrow beside the words "No measurement yet" — and since status is never
  // 'ok' without a matched streaming profile, that was the state it showed.
  const delta = lift.status === "ok" ? lift.observed_delta : null;
  const Icon = delta == null ? CircleDashed : delta >= 0 ? TrendingUp : TrendingDown;

  // Second tile: the counterfactual, or an honest reason there isn't one.
  let vsTrendValue: string | null = null;
  let vsTrendEmpty = "Not enough pre-campaign history to compare against.";
  if (trend) {
    if (trend.within_normal_variation) {
      vsTrendEmpty = "Inside this artist's normal week-to-week variation.";
    } else {
      vsTrendValue = fmtSigned(Math.round(trend.excess));
    }
  }

  const measurableDeals = lift.deals.filter(
    (d) => d.status === "sole_post_window" && d.observed_delta != null,
  ).length;

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          {delta != null && <Icon className="size-4 text-muted-foreground" aria-hidden />}
          Streaming impact
        </span>
      }
      action={<StatusBadge state="sourced" label={METHOD_LABEL[lift.method]} />}
    >
      <div className="flex flex-col gap-4">
        {lift.status !== "ok" ? (
          <NotMeasured reason={lift.reason} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
              <Stat
                label="Monthly listeners"
                value={
                  lift.latest ? new Intl.NumberFormat("en-US").format(lift.latest.value) : null
                }
                empty="No reading yet."
                sub={lift.latest?.date ? `As of ${lift.latest.date}` : "No reading yet"}
              />
              <Stat
                label="Observed change"
                value={
                  lift.observed_delta != null ? fmtSigned(lift.observed_delta) : null
                }
                empty="No change to report yet."
                sub={
                  lift.observed_pct != null
                    ? `${fmtPct(lift.observed_pct)} over ${lift.window_days} days`
                    : `Over ${lift.window_days} days`
                }
              />
              <Stat
                label="vs. pre-campaign trend"
                value={vsTrendValue}
                empty={vsTrendEmpty}
                sub={
                  trend
                    ? `Trend fitted on ${trend.pre_points} readings over ${trend.pre_span_days} days`
                    : "Correlation only, never proof of cause"
                }
              />
            </div>

            <p className="text-sm text-muted-foreground">{lift.reason}</p>

            {lift.points.length >= 2 && <LiftChart lift={lift} />}

            {/* Per-creator attribution is a slice of a campaign number. With no
                campaign number it sat outside this branch and rendered
                "0 of 14 measurable" over fourteen rows reading "Unknown" —
                fourteen restatements of the empty state above it. It belongs
                here, where the number it divides up actually exists. */}
            {lift.deals.length > 0 && (
              <div>
                <div className="flex items-baseline justify-between gap-2">
                  <h4 className="text-meta font-medium text-muted-foreground">
                    By creator
                  </h4>
                  <span className="text-xs text-muted-foreground">
                    {measurableDeals} of {lift.deals.length} measurable
                  </span>
                </div>
                <ul className="mt-2">
                  {lift.deals.map((d) => (
                    <DealWindowRow key={d.deal_id} d={d} />
                  ))}
                </ul>
              </div>
            )}

            <div className="flex justify-end">
              <MethodologyPopover />
            </div>
          </>
        )}
      </div>
    </Section>
  );
}
