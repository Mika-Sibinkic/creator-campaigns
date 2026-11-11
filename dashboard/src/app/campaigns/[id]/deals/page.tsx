'use client';
// src/app/campaigns/[id]/deals/page.tsx
//
// Deals funnel for one campaign. Shows every creator that has crossed the
// "sent or further" line as a card with their negotiation/payment/post/
// measurement state. Action buttons per row live in DealRow.
//
// Hierarchy: deals waiting on the manager render as full cards with their
// actions; every other group renders as a quieter divided list, so the eye
// lands on the decisions first. Shares its type and badge tones with
// /approvals.

import { useCallback, useEffect, useState, use } from 'react';
import { AppShell } from '@/components/AppShell';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Download, Search, Shuffle, Mail, Instagram, Music2, type LucideIcon } from 'lucide-react';
import { describeDealError } from '@/lib/deal-errors';
import { doNotContactNotice, type DoNotContactDisplay } from '@/lib/do-not-contact-copy';
import { lastSentNotice } from '@/lib/last-sent-offer';
import { DealRow, type DealOffer } from './DealRow';
import { useIsOperator } from '@/components/OperatorContext';
import {
  DEAL_GROUP_META,
  DEAL_GROUP_ORDER,
  dealGroup,
  funnelClasses,
  funnelLabel,
} from './funnel-labels';

interface DealInfluencer {
  id: string;
  username: string;
  display_name: string | null;
  follower_count: number | null;
  contact_email: string | null;
  profile_url: string | null;
}

interface DealLatestMessage {
  id: string;
  status: string | null;
  sent_at: string | null;
  body: string;
}

interface Deal {
  campaign_influencer_id: string;
  outreach_status: string | null;
  tier: string | null;
  // Highest-converting-channel recommendation from contact-discovery.
  best_channel: string | null;
  channel_confidence: number | null;
  influencer: DealInfluencer;
  latest_message: DealLatestMessage | null;
  offer: DealOffer | null;
  // Opted out / blocked for this label, or 'unknown' if the list was
  // unreadable. Display only — payment actions are unchanged.
  do_not_contact?: DoNotContactDisplay | null;
}

interface CampaignHeader {
  id: string;
  artist_name: string;
  status: string;
  track_name: string | null;
}

interface DealsResponse {
  campaign: CampaignHeader;
  deals: Deal[];
}

function FunnelBadge({ deal }: { deal: Deal }) {
  // Labels, tones and grouping are shared with the campaign strip and the
  // per-creator thread (./funnel-labels). This file used to own the only copy,
  // which is why the thread page rendered `human_approval_required` raw.
  const key = deal.offer?.status ?? null;
  // "Awaiting approval" is only true when something is IN Approvals. A deal
  // whose payment was never created (approval_gap) says so instead.
  const gap = deal.offer?.approval_gap ?? null;
  const label =
    gap === 'first'
      ? 'Agreed, payment not set up'
      : gap === 'balance'
        ? 'Posted, balance not set up'
        : funnelLabel(key);
  return (
    <Badge
      variant="outline"
      className={
        gap
          ? 'border-transparent bg-status-payout-pending text-status-payout-pending-fg'
          : funnelClasses(key)
      }
    >
      {label}
    </Badge>
  );
}

function TierBadge({ tier }: { tier: string | null }) {
  if (!tier) return null;
  return (
    <Badge variant="outline" className="text-muted-foreground">
      Tier {tier}
    </Badge>
  );
}

// Highest-converting-channel recommendation from src/lib/contact-discovery.ts,
// surfaced per creator. Reuses the outreach status token so it reads as the
// same product surface as FunnelBadge — no new colors, no globals.css touch.
const CHANNEL_META: Record<string, { label: string; Icon: LucideIcon }> = {
  email: { label: 'Email', Icon: Mail },
  instagram_dm: { label: 'Instagram DM', Icon: Instagram },
  tiktok_dm: { label: 'TikTok DM', Icon: Music2 },
};

/** A 0–1 model confidence as words. "(confidence 0.72)" is a bare float on a
 *  scale nobody stated, which is not a fact a manager can use. */
function confidenceWords(confidence: number | null): string {
  if (confidence == null) return '';
  if (confidence >= 0.75) return ' We are confident about this one.';
  if (confidence >= 0.45) return ' A reasonable guess, not a certainty.';
  return ' A weak guess, worth checking yourself.';
}

function ChannelBadge({
  channel,
  confidence,
}: {
  channel: string | null;
  confidence: number | null;
}) {
  if (!channel) return null;
  const meta = CHANNEL_META[channel];
  if (!meta) return null;
  const { Icon, label } = meta;
  return (
    <Badge
      variant="outline"
      className="gap-1 border-transparent bg-muted text-muted-foreground"
      title={`Creators like this one reply most often on ${label}.${confidenceWords(confidence)}`}
    >
      <Icon className="h-3 w-3" aria-hidden />
      Best: {label}
    </Badge>
  );
}

// Migration 036 delivery verification — `pass | fail | partial` is a machine
// value; the badge says what it means.
const SPEC_CHECK_LABELS: Record<string, string> = {
  pass: 'matches the agreed package',
  fail: 'does not match the agreed package',
  partial: 'partly matches the agreed package',
};

// Mirrors ATTRIBUTION_METHODS in ./DealRow — the recording form offers labels,
// so the readback must not show the stored slug.
const ATTRIBUTION_LABELS: Record<string, string> = {
  manual: 'Manual count',
  spotify_for_artists: 'Spotify for Artists',
  estimated_from_views: 'Estimated from views',
  unknown: 'Unknown',
};

function attributionLabel(method: string | null): string {
  if (!method) return 'Not recorded';
  return ATTRIBUTION_LABELS[method] ?? method.replace(/_/g, ' ');
}

function formatDateTime(iso: string | null): string {
  if (!iso) return 'Unknown time';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// N13: CSV export. Client-side render from the in-memory deals[] — no new
// backend route. CSV quoting per RFC 4180: wrap every value in double-quotes
// and escape embedded quotes by doubling them. We always quote (rather than
// only when necessary) because some columns carry commas, newlines, and
// emoji bios that would otherwise need conditional logic.
const CSV_COLUMNS: { label: string; pick: (d: Deal) => string | number | null }[] = [
  { label: 'username', pick: (d) => d.influencer.username },
  { label: 'follower_count', pick: (d) => d.influencer.follower_count ?? '' },
  { label: 'contact_email', pick: (d) => d.influencer.contact_email ?? '' },
  { label: 'tier', pick: (d) => d.tier ?? '' },
  { label: 'outreach_status', pick: (d) => d.outreach_status ?? '' },
  { label: 'offer_status', pick: (d) => d.offer?.status ?? '' },
  { label: 'initial_offer_usd', pick: (d) => d.offer?.initial_offer_usd ?? '' },
  { label: 'current_offer_usd', pick: (d) => d.offer?.current_offer_usd ?? '' },
  { label: 'agreed_amount_usd', pick: (d) => d.offer?.agreed_amount_usd ?? '' },
  { label: 'ceiling_usd', pick: (d) => d.offer?.ceiling_usd ?? '' },
  { label: 'deliverables', pick: (d) => d.offer?.deliverables_text ?? '' },
  { label: 'contract_sent', pick: (d) => (d.offer ? String(d.offer.contract_sent) : '') },
  { label: 'rounds', pick: (d) => d.offer?.rounds ?? '' },
  { label: 'post_url', pick: (d) => d.offer?.post_url ?? '' },
  { label: 'posted_at', pick: (d) => d.offer?.posted_at ?? '' },
  { label: 'paid_at', pick: (d) => d.offer?.paid_at ?? '' },
  {
    label: 'streams_attributed',
    pick: (d) => d.offer?.outcome?.streams_attributed ?? '',
  },
  {
    label: 'streams_per_dollar',
    pick: (d) => {
      const s = d.offer?.outcome?.streams_attributed;
      const a = d.offer?.agreed_amount_usd;
      if (s == null || !a) return '';
      return (s / a).toFixed(2);
    },
  },
  { label: 'sent_at', pick: (d) => d.latest_message?.sent_at ?? '' },
];

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '""';
  const s = String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function buildCsv(deals: Deal[]): string {
  const header = CSV_COLUMNS.map((c) => csvEscape(c.label)).join(',');
  const rows = deals.map((d) =>
    CSV_COLUMNS.map((c) => csvEscape(c.pick(d))).join(',')
  );
  // Leading BOM so Excel/Numbers detect UTF-8 (creator bios + emojis).
  return '﻿' + [header, ...rows].join('\r\n') + '\r\n';
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'campaign';
}

function downloadCsv(deals: Deal[], artistName: string) {
  const csv = buildCsv(deals);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const today = new Date().toISOString().slice(0, 10);
  const filename = `deals-${slugify(artistName)}-${today}.csv`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari can finish reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function CampaignDealsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [data, setData] = useState<DealsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // The campaign's standing deliverable package, fetched once for the whole
  // list. Every quick-offer inherits it unless the row overrides it, and until
  // now nothing on this page said what it was.
  const [standingPackage, setStandingPackage] = useState<string | null>(null);
  // Simulator state (operator-only). simulating = in flight; simSummary
  // holds the last run's hit/miss/silent/skipped/failed tallies.
  const isOperator = useIsOperator();
  const [paymentMode, setPaymentMode] = useState<string | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [simSummary, setSimSummary] = useState<
    { hits: number; misses: number; silent: number; skipped: number; failed: number } | null
  >(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/campaigns/${id}/deals`);
      if (!r.ok) {
        const txt = await r.text();
        let parsed: { error?: string; message?: string } | null = null;
        try {
          parsed = txt ? (JSON.parse(txt) as { error?: string }) : null;
        } catch {
          /* not JSON */
        }
        throw new Error(describeDealError(parsed, r.status));
      }
      const json = (await r.json()) as DealsResponse;
      setData(json);
      setError(null);
    } catch (e) {
      // 'failed' was the literal fallback, so a non-Error rejection printed
      // the word `failed` at a label manager.
      setError(e instanceof Error ? e.message : describeDealError(null));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Resolve PAYMENTS_MODE once on mount so the simulator button only renders
  // in paper mode. Cheap one-shot fetch; no polling.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/payments/mode');
        if (!r.ok) return;
        const j = (await r.json()) as { mode: string };
        if (!cancelled) setPaymentMode(j.mode);
      } catch {
        /* keep paymentMode=null → button hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The campaign's standing package, once. Best-effort: the route answers 503
  // on a database without the deal-scope tables, and a missing line is better
  // than a broken card.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/campaigns/${id}/deal-scope`, { cache: 'no-store' });
        if (!r.ok) return;
        const j = (await r.json()) as { standing_package_text?: string };
        if (!cancelled && j.standing_package_text) {
          setStandingPackage(j.standing_package_text);
        }
      } catch {
        /* no line rather than a wrong one */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Batch simulate replies. Iterates every deal whose latest outbound is
  // 'sent', fires /api/outreach/simulate-reply per row at concurrency 3.
  // The route is idempotent (skips if an inbound already exists for the
  // CI), so re-clicks during the same run are safe.
  const runSimulateAll = useCallback(async () => {
    if (!data) return;
    const targets = data.deals
      .filter(
        (d) => d.latest_message?.id && d.latest_message?.status === 'sent'
      )
      .map((d) => d.latest_message!.id as string);
    if (targets.length === 0) return;
    if (
      !window.confirm(
        `Simulate creator replies for ${targets.length} sent draft${targets.length === 1 ? '' : 's'}? ` +
          'Replies span accept, counter, decline, question and silence, and are ' +
          'rewritten each time. Costs about $0.01 per draft.'
      )
    ) {
      return;
    }
    setSimulating(true);
    setSimSummary(null);
    let hits = 0,
      misses = 0,
      silent = 0,
      skipped = 0,
      failed = 0;
    const CONC = 3;
    const queue = [...targets];
    async function worker() {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) return;
        try {
          const r = await fetch('/api/outreach/simulate-reply', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ outreach_message_id: next }),
          });
          if (!r.ok) {
            failed++;
            continue;
          }
          const j = (await r.json()) as {
            action?: string;
            classifier_matched_intent?: boolean;
          };
          if (j.action === 'silent') silent++;
          else if (j.action === 'already_simulated') skipped++;
          else if (j.classifier_matched_intent) hits++;
          else misses++;
        } catch {
          failed++;
        }
      }
    }
    await Promise.all(Array.from({ length: CONC }, () => worker()));
    setSimSummary({ hits, misses, silent, skipped, failed });
    setSimulating(false);
    void load();
  }, [data, load]);

  if (loading) {
    return (
      <AppShell title="Deals" width="medium" back={{ href: `/campaigns/${id}`, label: 'Campaign' }}>
        <div className="mx-auto w-full max-w-5xl space-y-4 px-4 pb-12 pt-6 sm:px-6 lg:px-8">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </AppShell>
    );
  }
  if (error || !data) {
    return (
      <AppShell title="Deals" width="medium" back={{ href: `/campaigns/${id}`, label: 'Campaign' }}>
        <div className="mx-auto w-full max-w-5xl space-y-4 px-4 pb-12 pt-6 sm:px-6 lg:px-8">
          <p className="text-destructive">{error ?? describeDealError(null)}</p>
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
              href={`/campaigns/${id}`}
              className={buttonVariants({ variant: 'outline' })}
            >
              Back to campaign
            </Link>
          </div>
        </div>
      </AppShell>
    );
  }

  const { campaign, deals } = data;

  const query = search.trim().toLowerCase();
  const matching = query
    ? deals.filter(
        (d) =>
          d.influencer.username.toLowerCase().includes(query) ||
          (d.influencer.display_name ?? '').toLowerCase().includes(query)
      )
    : deals;
  // Eleven states rendered as one flat list is a pile, not a funnel. Grouped by
  // what the manager owes, so the rows needing a decision are never underneath
  // the rows that are finished.
  const groups = DEAL_GROUP_ORDER.map(
    (g) => [g, matching.filter((d) => dealGroup(d.offer?.status ?? null) === g)] as const
  ).filter(([, list]) => list.length > 0);

  const waiting = groups.find(([g]) => g === 'action')?.[1].length ?? 0;

  return (
    <AppShell
      title="Deals"
      width="medium"
      back={{ href: `/campaigns/${id}`, label: campaign.artist_name }}
      subtitle={
        deals.length === 0
          ? 'No creators here yet. They appear once an outreach message goes out.'
          : `${deals.length} creator${deals.length === 1 ? '' : 's'} contacted${
              waiting > 0 ? `, ${waiting} waiting on you` : ''
            }`
      }
      actions={
        // N13: client-side CSV export. Disabled with zero rows so we don't drop
        // an empty file on the user's desktop.
        <Button
          variant="outline"
          onClick={() => downloadCsv(deals, campaign.artist_name)}
          disabled={deals.length === 0}
        >
          <Download className="size-4" />
          Export CSV
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-5xl px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        {/* Reply-template simulator, and the tally it produces. Operator-only
            as ONE block: fabricating a creator reply is our tool for exercising
            the loop, and the run summary ("✓3 ≈1 · classifier 75%") is a
            readout of that fabrication. The summary used to render outside the
            gate, so a label could watch fake-reply statistics appear. The route
            enforces the same rule server-side and refuses in live payment
            modes. */}
        {isOperator &&
          paymentMode !== 'stripe_live' &&
          paymentMode !== 'paypal_live' && (
            <div className="mb-6 flex flex-wrap items-center gap-3 rounded-md border border-dashed px-3 py-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runSimulateAll()}
                disabled={simulating || deals.length === 0}
              >
                <Shuffle className="size-3.5" />
                {simulating ? 'Simulating…' : 'Simulate replies'}
              </Button>
              {simSummary && (
                <div className="font-mono text-xs tabular-nums text-muted-foreground">
                  ✓{simSummary.hits} ≈{simSummary.misses} ~{simSummary.silent}{' '}
                  skipped {simSummary.skipped}{' '}
                  {simSummary.failed > 0 ? `· ✗${simSummary.failed}` : ''}
                  {simSummary.hits + simSummary.misses > 0 && (
                    <span className="ml-2">
                      classifier{' '}
                      {((simSummary.hits / (simSummary.hits + simSummary.misses)) * 100).toFixed(0)}
                      %
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

        {deals.length > 0 && (
          <div className="relative mb-6 max-w-xs">
            <Search className="absolute left-2.5 top-2 size-4 text-faint" />
            <Input
              className="h-8 pl-8"
              placeholder="Find a creator"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Find a creator in this list"
            />
          </div>
        )}

        {deals.length > 0 && groups.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No creator here matches &ldquo;{search.trim()}&rdquo;.
          </p>
        )}

        {/* Grouped by what the manager owes. The action group is the page:
            full cards, the approve/pay controls inside them, and an amber
            count. Everything after it steps down to a divided list. */}
        <div className="space-y-12">
          {groups.map(([group, list]) => {
            const isAction = group === 'action';
            return (
              <section key={group}>
                <div className="mb-3 flex items-baseline gap-2">
                  <h2 className="text-section-title text-foreground">
                    {DEAL_GROUP_META[group].heading}
                  </h2>
                  {isAction ? (
                    <span className="inline-flex h-5 items-center rounded bg-status-payout-pending px-1.5 text-xs font-semibold tabular-nums text-status-payout-pending-fg">
                      {list.length}
                    </span>
                  ) : (
                    <span className="text-meta tabular-nums text-faint">{list.length}</span>
                  )}
                </div>
                <ul className={isAction ? 'space-y-3' : 'divide-y border-y'}>
                  {list.map((d) => (
                    <DealCard
                      key={d.campaign_influencer_id}
                      deal={d}
                      campaignId={id}
                      standingPackage={standingPackage}
                      emphasis={isAction}
                      onChanged={() => {
                        void load();
                      }}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}

/** One deal. Extracted so the page body reads as the funnel it is. */
function DealCard({
  deal: d,
  campaignId,
  standingPackage,
  onChanged,
  emphasis,
}: {
  deal: Deal;
  campaignId: string;
  standingPackage: string | null;
  onChanged: () => void;
  /** Waiting on the manager: a full card. Everything else: a divided row. */
  emphasis: boolean;
}) {
  const dimmed = d.offer?.status === 'rejected';
  const optOut = doNotContactNotice(d.do_not_contact);
  const followers = d.influencer.follower_count ?? 0;
  const o = d.offer;
  const streamsPerDollar =
    o?.outcome?.streams_attributed != null && o.agreed_amount_usd
      ? o.outcome.streams_attributed / o.agreed_amount_usd
      : null;
  const headlineAmount = o?.agreed_amount_usd ?? o?.current_offer_usd ?? null;
  // Display only: the last price the creator was
  // actually sent, beside the agreed amount, flagged when the two differ.
  const sentNote = lastSentNotice(o?.agreed_amount_usd, o?.last_sent_offer_usd);
  // Ceiling and round count are negotiation internals. They were `<dl>` rows
  // carrying the same visual weight as the agreed price, which is the only
  // number on this card that is actually money.
  const footnote = o
    ? [
        o.initial_offer_usd != null
          ? `opened at $${o.initial_offer_usd.toFixed(0)}`
          : null,
        `your limit for this creator is $${o.ceiling_usd.toFixed(0)}`,
        o.rounds > 0
          ? `${o.rounds} round${o.rounds === 1 ? '' : 's'} of back-and-forth`
          : null,
      ]
        .filter(Boolean)
        .join(', ')
    : '';

  return (
    <li
      className={`${
        emphasis ? 'rounded-lg border bg-card p-5 shadow-xs' : 'py-5'
      } ${dimmed ? 'opacity-60' : ''}`}
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-3">
            <h3 className="text-base font-semibold">
              {d.influencer.profile_url ? (
                <a
                  href={d.influencer.profile_url}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  @{d.influencer.username}
                </a>
              ) : (
                <>@{d.influencer.username}</>
              )}
            </h3>
            <span className="text-sm text-muted-foreground">
              {followers.toLocaleString()} followers
            </span>
            <TierBadge tier={d.tier} />
            <FunnelBadge deal={d} />
            <ChannelBadge
              channel={d.best_channel}
              confidence={d.channel_confidence}
            />
            {optOut && (
              <Badge
                variant="outline"
                className="border-transparent bg-destructive/10 text-destructive"
                title={optOut.detail}
              >
                {optOut.label}
              </Badge>
            )}
            {/* Migration 015 — the payment ran in paper mode. The badge used
                to read "Paper", which is our word for it. Hiding it entirely
                would let the UI claim a payment that moved no money, so the
                fact stays and the jargon goes. */}
            {d.offer?.payment_authorizations.some(
              (l) => l.payment_mode === 'paper' && l.status !== 'pending_human_review'
            ) && (
                <Badge
                  variant="outline"
                  className="border-transparent bg-paper-money px-1.5 text-[10px] text-paper-money-fg"
                  title="This campaign is running on practice payments, so the deal is recorded as paid but no money left your account."
                >
                  No money moved
                </Badge>
              )}
          </div>

          {optOut && (
            <p className="mt-2 text-sm font-medium text-destructive">{optOut.detail}</p>
          )}

          {/* The money, at the size the money deserves. */}
          {headlineAmount != null && (
            <div className="mt-3 flex flex-wrap items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums tracking-tight">
                ${headlineAmount.toFixed(2)}
              </span>
              <span className="text-sm text-muted-foreground">
                {o?.agreed_amount_usd != null ? 'agreed' : 'currently offered'}
              </span>
              {sentNote && (
                <span
                  className={`text-xs ${sentNote.differs ? 'font-medium text-status-payout-pending-fg' : 'text-muted-foreground'}`}
                  title={sentNote.detail ?? undefined}
                >
                  {sentNote.text}
                  {sentNote.differs && '. Differs from the agreed amount, check the thread'}
                </span>
              )}
            </div>
          )}

          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            {/* The deal list is where a manager reads the deal,
                and it showed a price with no package. Wording matches
                /approvals and the thread header so the same deal reads the
                same in all three places. */}
            {o && (
              <>
                <dt className="text-muted-foreground">What they deliver</dt>
                <dd>
                  {o.deliverables_text || (
                    <span className="text-status-payout-pending-fg">
                      Not recorded. Check the thread before approving.
                    </span>
                  )}
                </dd>
                <dt className="text-muted-foreground">Contract</dt>
                <dd>
                  {o.contract_sent ? (
                    'Sent with the acceptance email'
                  ) : (
                    <span className="text-status-payout-pending-fg">
                      None attached to this deal
                    </span>
                  )}
                </dd>
              </>
            )}
            {o?.paid_at && (
              <>
                <dt className="text-muted-foreground">Paid at</dt>
                <dd className="text-foreground/80">{formatDateTime(o.paid_at)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Contact email</dt>
            {d.influencer.contact_email ? (
              <dd className="break-all">
                {d.influencer.contact_email}
              </dd>
            ) : (
              <dd className="text-status-payout-pending-fg">
                Missing. Payment will fail.
              </dd>
            )}
          </dl>

          {footnote && (
            <p className="mt-2 text-xs text-muted-foreground">{footnote}</p>
          )}

          {o?.post_url && (
            <div className="mt-3 text-sm">
              <span className="text-muted-foreground">Post: </span>
              <a
                href={o.post_url}
                target="_blank"
                rel="noreferrer"
                className="break-all text-primary hover:underline"
              >
                {o.post_url}
              </a>
              {o.posted_at && (
                <span className="ml-2 text-muted-foreground">
                  ({formatDateTime(o.posted_at)})
                </span>
              )}
              {o.delivery?.spec_check && (
                <Badge
                  variant="outline"
                  title={o.delivery.spec_check_detail ?? undefined}
                  className={`ml-2 px-1.5 text-[10px] ${
                    o.delivery.spec_check === 'pass'
                      ? 'text-muted-foreground'
                      : o.delivery.spec_check === 'fail'
                        ? 'border-destructive/40 text-destructive'
                        : 'border-attention-border text-attention-fg'
                  }`}
                >
                  {SPEC_CHECK_LABELS[o.delivery.spec_check] ?? 'delivery checked'}
                </Badge>
              )}
            </div>
          )}

          {o?.outcome && (
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 border-t pt-3 text-sm">
              <dt className="text-muted-foreground">Streams attributed</dt>
              <dd className="tabular-nums">
                {(o.outcome.streams_attributed ?? 0).toLocaleString()}
              </dd>
              <dt className="text-muted-foreground">Attribution</dt>
              <dd className="text-foreground/80">
                {attributionLabel(o.outcome.attribution_method)}
              </dd>
              <dt className="text-muted-foreground">Measured at</dt>
              <dd className="text-foreground/80">
                {formatDateTime(o.outcome.measured_at)}
              </dd>
              {streamsPerDollar !== null && (
                <>
                  <dt className="text-muted-foreground">Streams / dollar</dt>
                  <dd className="tabular-nums">
                    {streamsPerDollar.toFixed(2)}
                  </dd>
                </>
              )}
            </dl>
          )}
        </div>

        <div className="shrink-0 md:w-80">
          <DealRow
            campaignId={campaignId}
            campaignInfluencerId={d.campaign_influencer_id}
            influencerId={d.influencer.id}
            contactEmail={d.influencer.contact_email}
            offer={o}
            standingPackage={standingPackage}
            onChanged={onChanged}
          />
        </div>
      </div>
    </li>
  );
}
