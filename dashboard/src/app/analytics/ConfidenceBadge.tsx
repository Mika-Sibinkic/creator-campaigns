"use client";
// src/app/analytics/ConfidenceBadge.tsx
//
// Confidence is a first-class visual: every factor card carries
// how sure we are and how many finished deals sit behind it. The text always
// names the tier — color and icon are reinforcement only, never the sole
// channel (dataviz accessibility rule).
//
// This badge is the ONE place a card states its deal
// count, so the charts, sentences and axis ticks no longer repeat it. The
// tooltip is written here rather than echoing `confidence.reason` from the
// engine — that string is developer-facing ("insufficient: 3 measured deals
// with this factor (need 5 for low)") and a record label should never read it.

import { CircleAlert, CircleCheck, CircleDashed, CircleDot } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Confidence, ConfidenceTier } from "./contract";

const TIER_SPEC: Record<
  ConfidenceTier,
  { label: string; icon: typeof CircleDot; className: string; hint: string }
> = {
  insufficient: {
    label: "Not enough yet",
    icon: CircleDashed,
    className: "border-dashed text-muted-foreground",
    hint: "Too few finished deals to call a pattern. It takes five.",
  },
  low: {
    label: "Low",
    icon: CircleAlert,
    className: "text-muted-foreground",
    hint: "An early lead, not a rule. It firms up around fifteen finished deals.",
  },
  medium: {
    label: "Medium",
    icon: CircleDot,
    className: "",
    hint: "Worth acting on, still settling. It's solid around forty finished deals.",
  },
  high: {
    label: "High",
    icon: CircleCheck,
    className: "text-foreground",
    hint: "Enough finished deals behind this to plan against.",
  },
};

export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const spec = TIER_SPEC[confidence.tier];
  const Icon = spec.icon;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex cursor-default" />}>
          <Badge variant="outline" className={cn("tabular-nums", spec.className)}>
            <Icon aria-hidden />
            {spec.label} · {confidence.n} deal{confidence.n === 1 ? "" : "s"}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{spec.hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The legend for every badge — lives in the scope bar's
 *  "How confidence works" popover (§7.2.1). */
export function ConfidenceLegend() {
  const rows: Array<{ tier: ConfidenceTier; range: string; meaning: string }> = [
    { tier: "insufficient", range: "Under 5 deals", meaning: "No chart, no claims. We say nothing." },
    { tier: "low", range: "5–14 deals", meaning: "A direction to watch; treat it as a lead, not a rule." },
    { tier: "medium", range: "15–39 deals", meaning: "Worth acting on, still firming up." },
    { tier: "high", range: "40 or more", meaning: "Stable enough to plan against." },
  ];
  return (
    <ul className="flex flex-col gap-2">
      {rows.map(({ tier, range, meaning }) => {
        const spec = TIER_SPEC[tier];
        const Icon = spec.icon;
        return (
          <li key={tier} className="flex items-start gap-2">
            <Badge
              variant="outline"
              className={cn("shrink-0 tabular-nums", spec.className)}
            >
              <Icon aria-hidden />
              {spec.label}
            </Badge>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground tabular-nums">{range}</span>:{" "}
              {meaning}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
