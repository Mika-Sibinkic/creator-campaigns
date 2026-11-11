"use client";
// src/app/analytics/SampleDataBanner.tsx
//
// The bar: sample data must be "visibly, unambiguously fake to
// anyone looking." Three layers here:
//   - SampleDataBanner — full-width page banner when report.scope.synthetic
//     (attention tokens, mirroring TestingModeBanner's treatment)
//   - SampleBadge — per-card tag so the label survives a screenshot of any
//     single factor card
// Always icon + the word, never color alone.

import { FlaskConical } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export function SampleDataBanner({ className }: { className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-3 rounded-lg border border-attention-border bg-attention px-4 py-3 text-sm text-attention-fg",
        className
      )}
    >
      <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>
        <strong>Sample data.</strong> Every number below is fabricated to
        demonstrate the mechanism. No real campaign, creator, or dollar appears
        here.
      </p>
    </div>
  );
}

export function SampleBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-attention-border text-attention-fg",
        className
      )}
    >
      <FlaskConical aria-hidden />
      Sample
    </Badge>
  );
}
