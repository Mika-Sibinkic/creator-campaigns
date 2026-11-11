'use client';
// src/app/page.tsx — the landing page a record label opens.
//
// Three blocks, in descending weight: the active campaign (primary), money and
// outcomes, then recent activity. It used to be six equal-weight cards — a
// hero, a quick-actions row that only relinked the sidebar, an analytics strip,
// an activity feed, a funnel that repeated two of the hero's numbers, and a
// recent-campaigns grid that repeated /campaigns. Nothing told you where to
// look, and the primary action sat as a small button behind the theme toggle.
//
// Polling cadences preserved (10s activity / 30s dashboard).

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Award,
  Ban,
  CheckCircle,
  Crosshair,
  DollarSign,
  FileText,
  Handshake,
  MessageSquareReply,
  Plus,
  Send,
  Sparkles,
  ThumbsUp,
  Users,
  Zap,
} from 'lucide-react';

import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CampaignStatusBadge } from '@/components/StatusBadge';
import { AttentionCallout, EmptyState, Section, Stat, StatGroup } from '@/components/page';
import { RLAffordance } from '@/components/RLAffordance';
import { AnalyticsCard } from '@/components/AnalyticsCard';
import { OperatorOnly, useMe } from '@/components/OperatorContext';

// ─── types ──────────────────────────────────────────────────────────────
interface AuditRow {
  id: string;
  occurred_at: string;
  actor_label: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
}

/** DEALS. Mirrors api/dashboard's `deal_stages` — one offer, one stage. */
interface DealStages {
  offer_out: number;
  agreed: number;
  awaiting_approval: number;
  approved: number;
  paid: number;
  posted: number;
  measured: number;
  declined: number;
}

/** CREATORS. Mirrors api/dashboard's `creator_progress` — distinct people. */
interface CreatorProgress {
  found: number;
  drafted: number;
  contacted: number;
}

interface DashboardData {
  active_campaign: {
    id: string;
    artist_name: string;
    status: string;
    track_name: string | null;
    last_activity_at: string | null;
    creator_progress: CreatorProgress;
  } | null;
  deal_stages: DealStages;
  approvals_pending_count: number;
}

// ─── creator progress steps ────────────────────────────────────────────
// Three steps, all counting DISTINCT CREATORS. "Measured" is deliberately
// absent: it is a property of a deal, it lives in the deal stages below, and it
// was previously rendered twice from the same number.
const CREATOR_STEPS: Array<{ key: keyof CreatorProgress; label: string }> = [
  { key: 'found', label: 'Found' },
  { key: 'drafted', label: 'Drafted' },
  { key: 'contacted', label: 'Contacted' },
];

// ─── deal stages ───────────────────────────────────────────────────────
// Every stage counts DEALS. No label here may repeat a creator-step label.
const DEAL_STAGES: Array<{ key: keyof DealStages; label: string }> = [
  { key: 'offer_out', label: 'Offer out' },
  { key: 'agreed', label: 'Price agreed' },
  { key: 'awaiting_approval', label: 'Needs your approval' },
  { key: 'approved', label: 'Approved' },
  { key: 'paid', label: 'Paid' },
  { key: 'posted', label: 'Posted' },
  { key: 'measured', label: 'Measured' },
  { key: 'declined', label: 'Declined' },
];

// ─── activity feed: the allowlist IS the dictionary ────────────────────
// This table decides three things at once: which audit rows a client may see,
// what each one is called, and how it looks. A key that is not here is not
// fetched — the request sends these keys as an exact-match filter, so an
// unnamed machine key cannot reach the screen by merely existing in the table.
//
// What is deliberately absent: every `system.*` cron heartbeat (1,778
// negotiation ticks and counting — they were 20 of the last 20 rows, each with
// a thumbs-up widget beside it), smoke probes, `negotiation.injection_flagged`,
// `pipeline.bot_prefilter`, `draft.timeout` and `firm.testing_mode.toggle`.
// Those are how we run the product, not things the label did or that happened
// to its deals. Operators read the full tail on /audit.
type ActionTone = 'forward' | 'wait' | 'block' | 'info';

interface FeedAction {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: ActionTone;
}

const FEED_ACTIONS: Record<string, FeedAction> = {
  'campaign.create': { label: 'Campaign created', icon: Crosshair, tone: 'info' },
  'campaign.created': { label: 'Campaign created', icon: Crosshair, tone: 'info' },
  'campaign.confirmed': { label: 'Campaign confirmed', icon: CheckCircle, tone: 'forward' },
  'campaign.cloned': { label: 'Campaign copied', icon: Crosshair, tone: 'info' },
  'discovery.started': { label: 'Creator search started', icon: Sparkles, tone: 'info' },
  'discovery.completed': { label: 'Creator search finished', icon: Sparkles, tone: 'forward' },
  'outreach.draft': { label: 'Message drafted', icon: FileText, tone: 'info' },
  'outreach.draft.create': { label: 'Message drafted', icon: FileText, tone: 'info' },
  'outreach.draft_created': { label: 'Message drafted', icon: FileText, tone: 'info' },
  'outreach.generated': { label: 'Message drafted', icon: FileText, tone: 'info' },
  'outreach.send': { label: 'Message sent', icon: Send, tone: 'forward' },
  'outreach.sent': { label: 'Message sent', icon: Send, tone: 'forward' },
  'outreach.failed': { label: 'Message could not be sent', icon: Ban, tone: 'block' },
  'outreach.response_logged': { label: 'Creator replied', icon: MessageSquareReply, tone: 'forward' },
  'negotiation.offer_sent': { label: 'Offer sent', icon: Handshake, tone: 'forward' },
  'negotiation.auto_counter_sent': { label: 'Counter-offer sent', icon: Handshake, tone: 'forward' },
  'negotiation.agreed': { label: 'Price agreed', icon: CheckCircle, tone: 'forward' },
  'negotiation.pending_human_approval': {
    label: 'Waiting for your approval',
    icon: ThumbsUp,
    tone: 'wait',
  },
  'offer.agreed': { label: 'Price agreed', icon: CheckCircle, tone: 'forward' },
  'offer.quick_agreed': { label: 'Price agreed', icon: CheckCircle, tone: 'forward' },
  'offer.posted': { label: 'Post went live', icon: Zap, tone: 'forward' },
  'offer.measured': { label: 'Results measured', icon: Award, tone: 'forward' },
  'outcome.recorded': { label: 'Results measured', icon: Award, tone: 'forward' },
  'payment.authorization_created': {
    label: 'Payment ready for your approval',
    icon: DollarSign,
    tone: 'wait',
  },
  'payment.approved': { label: 'Payment approved', icon: ThumbsUp, tone: 'forward' },
  'payment.executed': { label: 'Creator paid', icon: DollarSign, tone: 'forward' },
  'deal.paid': { label: 'Creator paid', icon: DollarSign, tone: 'forward' },
  'payment.failed': { label: 'Payment failed', icon: AlertTriangle, tone: 'block' },
  'firm.update': { label: 'Workspace settings changed', icon: Activity, tone: 'info' },
  'influencer.contact_email.update': {
    label: 'Creator contact details updated',
    icon: Users,
    tone: 'info',
  },
};

const FEED_ACTION_KEYS = Object.keys(FEED_ACTIONS);
const FEED_ACTIONS_PARAM = encodeURIComponent(FEED_ACTION_KEYS.join(','));

const TONE_STYLES: Record<ActionTone, string> = {
  forward: 'bg-muted text-muted-foreground',
  wait: 'bg-status-payout-pending text-status-payout-pending-fg',
  block: 'bg-status-flagged text-status-flagged-fg',
  info: 'bg-muted text-faint',
};

const UNKNOWN_ACTION: FeedAction = { label: 'Activity', icon: Activity, tone: 'info' };

// ─── helpers ───────────────────────────────────────────────────────────
function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

/**
 * Who did this, in words — or nothing at all.
 *
 * `actor_label` is a machine string: `user:owner@examplerecords.example`,
 * `system:cron`, `system:auto-negotiator`, `system:unknown`, `smoke`. It was
 * rendered raw under every row, which put an email address (sometimes ours) on
 * a client screen and labelled real work "system:unknown". An address is never
 * shown: either it is you, or it is someone in your workspace, or the name goes
 * away and the timestamp stands alone.
 */
function actorName(actorLabel: string | null | undefined, myEmail: string | null): string | null {
  const raw = (actorLabel ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('user:')) {
    const email = raw.slice('user:'.length).trim().toLowerCase();
    if (!email) return null;
    if (myEmail && email === myEmail.trim().toLowerCase()) return 'You';
    return 'Someone in your workspace';
  }
  if (raw === 'system' || raw.startsWith('system:')) return 'Creator Campaigns';
  return null;
}

/** True when Creator Campaigns decided this, rather than a person. */
function isAutomated(actorLabel: string | null | undefined): boolean {
  const raw = (actorLabel ?? '').trim();
  return raw === 'system' || raw.startsWith('system:');
}

/**
 * A creator handle from the row's metadata, or null.
 *
 * `sent_to` / `resolved_to` used to be candidates here. They are delivery
 * addresses, and with firm testing mode on every one of them is OUR test
 * inbox — so the feed showed the label an internal address and called it the
 * creator. Handles only, and never anything shaped like an email.
 */
function extractTargetLabel(row: AuditRow): string | null {
  const md = row.metadata;
  if (!md) return null;
  for (const k of ['username', 'handle', 'creator']) {
    const v = md[k];
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (!s || /\s/.test(s)) continue;
    if (s.includes('@') && !s.startsWith('@')) continue; // an email address
    return s.startsWith('@') ? s : `@${s}`;
  }
  return null;
}

function extractAmount(row: AuditRow): string | null {
  const md = row.metadata;
  if (!md) return null;
  for (const k of ['amount_usd', 'agreed_amount_usd', 'amount']) {
    const v = md[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return `$${v.toFixed(0)}`;
    }
  }
  return null;
}

const ACTIVITY_POLL_MS = 10_000;
const DASHBOARD_POLL_MS = 30_000;

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [activity, setActivity] = useState<AuditRow[] | null>(null);
  const [activityFailed, setActivityFailed] = useState(false);
  const visibleRef = useRef<boolean>(
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  );

  const loadDashboard = useCallback(async () => {
    try {
      const r = await fetch('/api/dashboard', { cache: 'no-store' });
      if (!r.ok) return;
      const body = (await r.json()) as DashboardData;
      setData(body);
    } catch {
      /* silent — next tick retries */
    }
  }, []);

  const loadActivity = useCallback(async () => {
    try {
      const r = await fetch(`/api/audit?limit=20&actions=${FEED_ACTIONS_PARAM}`, {
        cache: 'no-store',
      });
      if (!r.ok) {
        // The route returns the raw driver message on a 500. That belongs in
        // devtools, never on a client screen.
        console.error(`[activity] GET /api/audit → HTTP ${r.status}`);
        setActivityFailed(true);
        return;
      }
      const body = (await r.json()) as { rows?: AuditRow[]; error?: string };
      if (body.error) {
        console.error('[activity] /api/audit returned an error', body.error);
        setActivityFailed(true);
        return;
      }
      setActivityFailed(false);
      setActivity(body.rows ?? []);
    } catch (e) {
      console.error('[activity] load failed', e);
      setActivityFailed(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDashboard();
    void loadActivity();

    const dashId = setInterval(() => {
      if (visibleRef.current) void loadDashboard();
    }, DASHBOARD_POLL_MS);
    const actId = setInterval(() => {
      if (visibleRef.current) void loadActivity();
    }, ACTIVITY_POLL_MS);

    function onVisibility() {
      const nowVisible = document.visibilityState !== 'hidden';
      const wasHidden = !visibleRef.current && nowVisible;
      visibleRef.current = nowVisible;
      if (wasHidden) {
        void loadDashboard();
        void loadActivity();
      }
    }
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(dashId);
      clearInterval(actId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [loadDashboard, loadActivity]);

  const pending = data?.approvals_pending_count ?? 0;

  return (
    <AppShell
      title="Overview"
      // One primary per page: while payouts wait on the label, approving them
      // is the primary action and New campaign steps down to outline.
      actions={
        <Button
          variant={pending > 0 ? 'outline' : 'default'}
          nativeButton={false}
          render={<Link href="/campaigns/new" />}
        >
          <Plus className="size-4" /> New campaign
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-7xl px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        {pending > 0 && (
          <AttentionCallout
            icon={ThumbsUp}
            className="mb-8"
            title={
              pending === 1
                ? '1 payout is waiting for your approval'
                : `${pending} payouts are waiting for your approval`
            }
            action={
              <Button nativeButton={false} render={<Link href="/approvals" />}>
                Review {pending === 1 ? 'payout' : 'payouts'}
              </Button>
            }
          >
            Approving pays the creator.
          </AttentionCallout>
        )}
        <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-10">
            <ActiveCampaign data={data} />
            <AnalyticsCard />
          </div>
          <ActivityFeed rows={activity} failed={activityFailed} />
        </div>
      </div>
    </AppShell>
  );
}

// ─── Active campaign (primary block) ───────────────────────────────────
// Carries the page: the biggest type below the page title, and the only
// numbers set at KPI size. Grouped by space and hairlines, not a card.
function ActiveCampaign({ data }: { data: DashboardData | null }) {
  if (!data) {
    return (
      <Section title="Active campaign">
        <div className="space-y-4">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-20 w-full" />
        </div>
      </Section>
    );
  }

  const c = data.active_campaign;
  if (!c) {
    return (
      <Section title="Active campaign">
        <EmptyState
          title="No campaign running"
          action={
            <Button nativeButton={false} render={<Link href="/campaigns/new" />}>
              <Plus className="size-4" /> Start a campaign
            </Button>
          }
        >
          Creator Campaigns finds creators, writes the first message and negotiates each price.
        </EmptyState>
      </Section>
    );
  }

  // `?? 0` guards a stale cached payload from before the two units were split
  // apart — a missing key would otherwise render "undefined" as a count.
  const progress = c.creator_progress;
  const creators = CREATOR_STEPS.map((s) => ({ ...s, value: progress?.[s.key] ?? 0 }));
  const stages = DEAL_STAGES.map((s) => ({ ...s, value: data.deal_stages?.[s.key] ?? 0 }));
  const anyDeals = stages.some((s) => s.value > 0);

  return (
    <Section
      title="Active campaign"
      action={
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href={`/campaigns/${c.id}`} />}>
          Open campaign <ArrowRight className="size-3.5" />
        </Button>
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link
          href={`/campaigns/${c.id}`}
          className="text-xl font-semibold tracking-tight text-foreground hover:text-primary"
        >
          {c.artist_name}
        </Link>
        {c.track_name && <span className="text-sm text-muted-foreground">{c.track_name}</span>}
        <CampaignStatusBadge status={c.status} className="self-center" />
        <span className="text-meta text-faint">
          {c.last_activity_at ? `Last activity ${relTime(c.last_activity_at)}` : 'No activity yet'}
        </span>
      </div>

      <StatGroup className="mt-5">
        {creators.map((s) => (
          <Stat key={s.key} label={`Creators ${s.label.toLowerCase()}`} value={s.value.toLocaleString()} />
        ))}
      </StatGroup>

      <div className="mt-6">
        <h3 className="text-meta font-medium text-muted-foreground">Deals by stage</h3>
        {anyDeals ? (
          <ul className="mt-2 grid grid-cols-2 gap-x-8 sm:grid-cols-4">
            {stages.map((s) => {
              const needsYou = s.key === 'awaiting_approval' && s.value > 0;
              return (
                <li key={s.key}>
                  <Link
                    href={`/campaigns/${c.id}/deals`}
                    className="group flex items-baseline justify-between gap-3 border-b py-2 text-sm"
                  >
                    <span
                      className={
                        needsYou
                          ? 'font-medium text-attention-fg'
                          : 'text-muted-foreground group-hover:text-foreground'
                      }
                    >
                      {s.label}
                    </span>
                    <span
                      className={`tabular-nums ${
                        needsYou
                          ? 'font-semibold text-attention-fg'
                          : s.value === 0
                            ? 'text-faint'
                            : 'font-medium text-foreground'
                      }`}
                    >
                      {s.value}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-faint">
            No deals yet. A deal starts when a creator replies to an offer.
          </p>
        )}
      </div>
    </Section>
  );
}

// ─── Activity feed ─────────────────────────────────────────────────────
// A side rail: smaller type, no card, icons tinted only when a row waits on
// the label or something failed.
function ActivityFeed({ rows, failed }: { rows: AuditRow[] | null; failed: boolean }) {
  const me = useMe();

  return (
    <Section title="Recent activity" className="lg:border-l lg:pl-8">
      <div className="max-h-[640px] overflow-y-auto">
        {failed && rows === null && (
          <p className="py-2 text-sm text-muted-foreground">
            Couldn&rsquo;t load recent activity. It will try again in a moment.
          </p>
        )}

        {rows === null && !failed && (
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        )}

        {rows !== null && rows.length === 0 && (
          <p className="py-2 text-sm text-faint">Nothing yet. This fills in as your campaigns run.</p>
        )}

        {rows !== null && rows.length > 0 && (
          <ul>
            {rows.map((r) => {
              const v = FEED_ACTIONS[r.action] ?? UNKNOWN_ACTION;
              const Icon = v.icon;
              const target = extractTargetLabel(r);
              const amount = extractAmount(r);
              const who = actorName(r.actor_label, me?.email ?? null);
              const automated = isAutomated(r.actor_label);
              return (
                <li key={r.id} className="group relative flex items-start gap-3 py-2.5">
                  <span
                    className={`mt-px flex size-6 shrink-0 items-center justify-center rounded ${TONE_STYLES[v.tone]}`}
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate font-medium text-foreground">{v.label}</span>
                      {amount && <span className="shrink-0 tabular-nums text-foreground">{amount}</span>}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {[target, who, relTime(r.occurred_at)].filter(Boolean).join(', ')}
                    </p>
                    <OperatorOnly>
                      <p className="truncate font-mono text-[11px] text-faint">
                        {r.action} {r.actor_label}
                      </p>
                    </OperatorOnly>
                  </div>
                  {/* Feedback belongs on decisions Creator Campaigns made. Asking the
                      label to rate its own click taught the model nothing and
                      made every row look machine-generated. */}
                  {automated && (
                    <RLAffordance
                      eventId={r.id}
                      context={{
                        action: r.action,
                        target_type: r.target_type,
                        target_id: r.target_id,
                      }}
                      size="xs"
                      className="absolute bottom-1.5 right-0 bg-background opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Section>
  );
}
