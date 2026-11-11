"use client";
// src/app/analytics/FactorCard.tsx
//
// One card per factor that actually has something to say. The page decides
// which those are (see `speaks()` in page.tsx) and names the rest in a single
// "still gathering" card — nothing is silently dropped, but nine identical
// grey boxes that all read "not enough data" are not an analytics page.
//
// Copy rules on this surface (a record label reads it):
//   - no ρ, no n=, no "Spearman", no min(1, n/30). The strength of a trend is
//     stated in words; the deal count is stated ONCE per card, in the
//     ConfidenceBadge.
//   - per-bucket n is off the axis on purpose: quantile buckets are near-equal
//     in size by construction, so it was four repetitions of the same number.
//     Categorical groups DO vary, so a group under three deals still carries
//     its own count as a warning — text, not color alone.
//
// Chart choices follow the dataviz skill:
//   - single series ⇒ single hue (--chart-1, the accent) and NO legend (the card
//     title names the series)
//   - thin bars (≤24px), 4px rounded data-end, square at the baseline
//   - recessive hairline grid (ChartContainer restyles recharts' default
//     #ccc grid to border/50), one axis per chart, never two outcome metrics
//   - per-mark hover tooltip (bucket/group, mean)
//   - small-sample categorical groups: muted 40%-opacity fill PLUS an explicit
//     count tag — secondary encoding, not color-alone
//   - axis/label text wears text tokens (wrapper fills ticks with
//     muted-foreground), never the series color

import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { ConfidenceBadge } from "./ConfidenceBadge";
import { SampleBadge } from "./SampleDataBanner";
import { fmtCompact, outcomeLabel } from "./format";
import type {
  CategoricalFactorResult,
  FactorResult,
  NumericFactorResult,
} from "./contract";

export function FactorCard({
  result,
  synthetic,
}: {
  result: FactorResult;
  synthetic: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{result.label}</CardTitle>
        {/* The buying question, not a restatement of the title. The outcome
            unit used to be appended here and is already on the axis. */}
        <CardDescription className="text-xs">{result.question}</CardDescription>
        <CardAction className="flex items-center gap-1.5">
          {synthetic && <SampleBadge />}
          <ConfidenceBadge confidence={result.confidence} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {result.kind === "numeric" ? (
          <NumericBody result={result} />
        ) : (
          <CategoricalBody result={result} />
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// shared copy helpers

/** Data-derived group values arrive machine-shaped (`instagram_dm`). Nothing
 *  snake_cased belongs on a label's screen. */
export function prettyGroupValue(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => {
      const upper = w.toUpperCase();
      if (upper === "DM" || upper === "UTC") return upper;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

// ---------------------------------------------------------------------------
// numeric — quantile-bucket columns; the hump shows a sweet spot even when the
// overall trend is flat (this is the chart; the sentence states the trend)

function NumericBody({ result }: { result: NumericFactorResult }) {
  const data = result.buckets.map((b) => ({
    tick: b.label,
    mean: b.mean_outcome,
  }));
  const config = {
    mean: { label: outcomeLabel(result.outcome), color: "var(--chart-1)" },
  } satisfies ChartConfig;

  return (
    <>
      <ChartContainer config={config} className="aspect-auto h-44 w-full">
        <BarChart data={data} margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="tick"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            interval={0}
            tick={{ fontSize: 10 }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={44}
            tick={{ fontSize: 10 }}
            tickFormatter={(v) => fmtCompact(Number(v))}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar
            dataKey="mean"
            fill="var(--color-mean)"
            radius={[4, 4, 0, 0]}
            maxBarSize={24}
          />
        </BarChart>
      </ChartContainer>
      <p className="text-xs text-muted-foreground">{numericSentence(result)}</p>
      <Notes notes={result.notes} />
    </>
  );
}

/** How hard the trend leans, in words. The engine's ρ is the source, but a
 *  label reads "consistently", not "ρ = 0.56". */
function strengthWord(rho: number): string {
  return Math.abs(rho) >= 0.5 ? "consistently" : "more often than not";
}

export function numericSentence(r: NumericFactorResult): string {
  if (r.direction === "none" || r.spearman_rho == null) {
    return "No clear pattern yet.";
  }
  const more = r.direction === "positive";
  const what = r.label.toLowerCase();
  const band = strengthWord(r.spearman_rho);
  return r.outcome === "streams"
    ? `Deals with higher ${what} ${band} brought ${more ? "more" : "fewer"} streams.`
    : `Deals with higher ${what} ${band} returned ${more ? "more" : "less"} for every dollar spent.`;
}

// ---------------------------------------------------------------------------
// categorical — horizontal group-mean bars, sorted by mean (engine order)

function CategoricalBody({ result }: { result: CategoricalFactorResult }) {
  const data = result.groups.map((g) => ({
    // Under three deals the group gets its count on the axis as a warning;
    // the rest stay clean, because the card's badge already carries the total.
    tick: g.small_sample
      ? `${prettyGroupValue(g.value)} · ${g.n} deal${g.n === 1 ? "" : "s"}`
      : prettyGroupValue(g.value),
    mean: g.mean_outcome,
    small: g.small_sample,
  }));
  const config = {
    mean: { label: outcomeLabel(result.outcome), color: "var(--chart-1)" },
  } satisfies ChartConfig;
  // Grow with the group count so the x-axis band is never squeezed out.
  const height = Math.max(112, data.length * 40 + 32);

  return (
    <>
      <ChartContainer
        config={config}
        className="aspect-auto w-full"
        style={{ height }}
      >
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 0, right: 8, left: 4, bottom: 0 }}
        >
          <CartesianGrid horizontal={false} />
          <XAxis
            type="number"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10 }}
            tickFormatter={(v) => fmtCompact(Number(v))}
          />
          <YAxis
            type="category"
            dataKey="tick"
            tickLine={false}
            axisLine={false}
            width={128}
            interval={0}
            tick={{ fontSize: 10 }}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="mean" radius={[0, 4, 4, 0]} maxBarSize={20}>
            {data.map((d) => (
              <Cell
                key={d.tick}
                fill={d.small ? "var(--muted-foreground)" : "var(--color-mean)"}
                fillOpacity={d.small ? 0.4 : 1}
              />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
      <p className="text-xs text-muted-foreground">
        {categoricalSentence(result)}
      </p>
      <Notes notes={result.notes} />
    </>
  );
}

export function categoricalSentence(r: CategoricalFactorResult): string {
  if (r.leader) {
    const i = r.groups.findIndex((g) => g.value === r.leader);
    const lead = r.groups[i];
    const second = r.groups.find((_, j) => j !== i);
    if (lead && second) {
      return `${prettyGroupValue(lead.value)} is ahead: ${fmtCompact(lead.mean_outcome)} against ${fmtCompact(second.mean_outcome)} for the next best.`;
    }
  }
  return "No group stands out yet.";
}

// ---------------------------------------------------------------------------

function Notes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <p className="text-xs text-muted-foreground/70 italic">
      {notes.join(" · ")}
    </p>
  );
}
