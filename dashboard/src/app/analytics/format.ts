// src/app/analytics/format.ts
//
// Page-local number formatting, matching the AnalyticsCard idiom (fmtUsd /
// fmtCount) plus a compact axis-friendly variant for chart ticks.

import type { OutcomeMetric } from './contract';

export function fmtUsd(n: number, dp = 0): string {
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

export function fmtCount(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 1 : 0 });
}

/** Compact for axis ticks and stat tiles: 1.6M / 45k / 302 / 3.5 */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${Math.round(n / 1_000)}k`;
  return fmtCount(n);
}

export function outcomeLabel(o: OutcomeMetric): string {
  return o === 'streams' ? 'streams' : 'streams / $';
}
