'use client';
// src/components/AnalyticsCard.tsx
//
// Compact money/outcome strip for the Pipeline landing. Surfaces the four
// headline metrics from /api/analytics (firm rollup): CPM, response-conversion
// rate, output-per-dollar, and spend consumed/remaining. Token-driven only
// (Card + muted/primary/status tokens) — the brand pass owns globals.css, so
// nothing here hardcodes colour or touches brand tokens.

import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Section, Stat, StatGroup } from '@/components/page';
import type { FirmAnalytics } from '@/lib/analytics';

const POLL_MS = 30_000;

function fmtUsd(n: number, dp = 0): string {
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

function fmtPct(n: number | null): string {
  return n == null ? 'Not measured' : `${(n * 100).toFixed(1)}%`;
}

function fmtCount(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 1 : 0 });
}

export function AnalyticsCard() {
  const [firm, setFirm] = useState<FirmAnalytics | null>(null);
  const [loaded, setLoaded] = useState(false);
  // A failed load used to leave the skeleton up forever. Say so instead, and
  // never fall through to the zero-filled stats (that would read as "$0 spent").
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/analytics', { cache: 'no-store' });
        if (!r.ok) {
          if (alive) setFailed(true);
          return;
        }
        const body = (await r.json()) as { firm?: FirmAnalytics };
        if (alive) {
          setFirm(body.firm ?? null);
          setLoaded(true);
          setFailed(false);
        }
      } catch {
        /* silent — next tick retries */
        if (alive) setFailed(true);
      }
    };
    void load();
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        void load();
      }
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // No description line and no "Learns from results" chip. The first only
  // restated the title; the second was a product claim with nothing behind it
  // (learning_logs holds 0 rows and has no reader).
  return (
    <Section title="Money and outcomes">
      {failed && !loaded ? (
        <p className="border-y py-5 text-sm text-muted-foreground">
          Couldn&rsquo;t load these numbers. It will try again in a moment.
        </p>
      ) : !loaded ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <Stats firm={firm} />
      )}
    </Section>
  );
}

function Stats({ firm }: { firm: FirmAnalytics | null }) {
  const cpm = firm?.cpm.cpm_usd ?? null;
  const conv = firm?.conversion.response_conversion_rate ?? null;
  const opd = firm?.roi.output_per_dollar ?? null;

  const budget = firm?.spend.budget_usd ?? null;
  const consumed = firm?.spend.spend_committed_usd ?? 0;
  const remaining = firm?.spend.remaining_usd ?? null;
  const consumedPct = firm?.spend.consumed_pct ?? null;

  // A null value renders the reason it is missing, in quiet type, instead of a
  // bare dash at KPI size (which reads as a broken screen). Never invent a
  // number to fill the space.
  return (
    <StatGroup>
      {/* Committed spend leads: it is the one number here that is always real. */}
      <Stat
        label="Committed to creators"
        value={fmtUsd(consumed)}
        sub={
          // The denominator is every campaign's budget added up, including ones
          // that never ran. Say which it is rather than quietly shrinking it.
          budget != null ? (
            <>
              <span className="tabular-nums">
                of {fmtUsd(budget)}
                {consumedPct != null ? ` (${Math.round(consumedPct * 100)}%)` : ''}
              </span>{' '}
              budgeted across every campaign, drafts included
              {remaining != null && (
                <span className="tabular-nums">. {fmtUsd(remaining)} left</span>
              )}
            </>
          ) : (
            'No budget set yet'
          )
        }
      />
      {/* CPM is null until a post is measured. The stat still earns its place:
          it names the number the product optimises and says what makes it appear. */}
      <Stat
        label="Cost per 1,000 views"
        value={cpm == null ? null : fmtUsd(cpm, 2)}
        empty="Appears once a creator posts"
      />
      <Stat
        label="Response rate"
        value={conv == null ? null : fmtPct(conv)}
        empty="Nothing sent yet"
        sub={
          conv != null && firm
            ? `${firm.conversion.creators_replied} of ${firm.conversion.creators_sent} creators replied`
            : undefined
        }
      />
      <Stat
        label="Streams per $"
        value={opd == null ? null : fmtCount(opd)}
        empty="Appears once streams are measured"
      />
    </StatGroup>
  );
}
