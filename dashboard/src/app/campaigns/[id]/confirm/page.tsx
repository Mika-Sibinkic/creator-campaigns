'use client';
// src/app/campaigns/[id]/confirm/page.tsx
//
// Pre-run confirmation, and the page a label manager is redirected to the
// first time they press Run discovery (CampaignProgress bounces a 412
// `campaign_not_confirmed` straight here). It is therefore on the demo path and
// has to stand on its own: nav, a way back, and an explanation of why it exists.
//
// Confirm sets confirmed_at on the campaign row. The pipeline route
// (/api/campaigns/[id]/run) refuses to run otherwise (412).
//
// ── What this page deliberately does NOT do any more ──────────────────────
//
//  * It no longer renders `<pre>{JSON}</pre>` of the firm prefs next to a
//    textarea pre-filled with `{}`. Two reasons. First, asking a label manager
//    to hand-edit JSON to start a campaign is not a usable control. Second,
//    `campaigns.scraping_overrides` — the column one of those textareas wrote
//    to — was read by NOTHING at the time: the run route sourced
//    firms.scraping_prefs directly. The control was inert.
//    NO LONGER TRUE as of the label-agnostic tenancy work: the run route now
//    resolves genre via src/lib/genre-config.ts, where
//    `scraping_overrides.genres[0]` is priority 1, ahead of the firm default.
//    The column is live again — but only for genre, and still not through a
//    JSON textarea. The prefs that really drive the run are
//    now shown as readable lines (src/lib/confirm-summary.ts) with a link to
//    where they are actually editable.
//    The confirm body no longer sends either override key, so whatever is
//    stored stays stored — the route writes only the keys it is given.
//  * It no longer renders its own bare page with hardcoded zinc colours. It is
//    inside <AppShell> like every other signed-in surface, and uses the shared
//    semantic tokens so it is not a dark slab in light mode.
//  * It no longer gets stuck on "Loading…" forever when a fetch fails.
//
// MONEY: both enforced ceilings must be set before a campaign can be confirmed.
// Migration 037 (campaigns_confirmed_requires_caps) is the DB constraint, the
// confirm route answers 412 `campaign_caps_required`, and this form is the
// place a human can still fix it. Do not soften any of that.

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2 } from 'lucide-react';

import { AppShell } from '@/components/AppShell';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  capsRequiredMessage,
  describeOutreachPrefs,
  describeScrapingPrefs,
  type SummaryLine,
} from '@/lib/confirm-summary';

interface FirmRow {
  scraping_prefs?: Record<string, unknown>;
  outreach_prefs?: Record<string, unknown>;
  campaign_defaults?: { per_creator_cap_usd?: number; total_budget_usd?: number };
  onboarding_completed_at: string | null;
}
interface CampaignRow {
  id: string;
  artist_name: string;
  per_creator_cap_usd: number | null;
  total_budget_usd: number | null;
  confirmed_at: string | null;
  status: string;
  /** Migration 060. Absent (and the field hidden) until the column exists. */
  outreach_limit?: number | null;
  outreach_limit_supported?: boolean;
}

/** What the confirm route can answer with. `missing` carries raw column names
 *  (412 campaign_caps_required); they are mapped to form labels before display
 *  and never rendered as-is. */
interface ConfirmError {
  error?: string;
  message?: string;
  missing?: string[];
}

export default function ConfirmPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [firm, setFirm] = useState<FirmRow | null>(null);
  const [campaign, setCampaign] = useState<CampaignRow | null>(null);
  const [loading, setLoading] = useState(true);
  // A failed load is a state of its own. It used to be indistinguishable from
  // a slow one — both left the page on "Loading…" with no nav and no retry.
  const [loadError, setLoadError] = useState<string | null>(null);

  const [perCreatorCap, setPerCreatorCap] = useState<string>('');
  const [totalBudget, setTotalBudget] = useState<string>('');
  // True while the inputs still hold the firm default rather than a value
  // saved on this campaign. A draft campaign with no per-creator cap lands
  // here, and the difference matters.
  const [capsPrefilled, setCapsPrefilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Both enforced ceilings must be > 0 or the campaign cannot be confirmed:
  // src/lib/spend-caps.ts fails closed on an unset budget, so arming a
  // campaign without one just defers the refusal to payout time.
  const capNum = Number(perCreatorCap);
  const budgetNum = Number(totalBudget);
  const capOk = perCreatorCap.trim() !== '' && Number.isFinite(capNum) && capNum > 0;
  const budgetOk = totalBudget.trim() !== '' && Number.isFinite(budgetNum) && budgetNum > 0;
  const capsValid = capOk && budgetOk;

  // Mini-run limit (migration 060). Blank = no limit.
  const [outreachLimit, setOutreachLimit] = useState<string>('');
  const limitSupported = campaign?.outreach_limit_supported === true;
  const limitText = outreachLimit.trim();
  const limitNum = Number(limitText);
  const limitOk = limitText === '' || (Number.isInteger(limitNum) && limitNum > 0);

  // `silent` re-reads the row without dropping the whole page back to the
  // loading state — used after a successful save, where blanking the form the
  // user just filled in reads as if something went wrong.
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setLoadError(null);
    try {
      const [fRes, cRes] = await Promise.all([
        fetch('/api/firm', { cache: 'no-store' }),
        fetch(`/api/campaigns/${id}`, { cache: 'no-store' }),
      ]);
      if (!cRes.ok) {
        throw new Error(
          cRes.status === 404
            ? 'This campaign could not be found. It may have been deleted in another tab.'
            : 'We could not load this campaign. Check your connection and try again.'
        );
      }
      if (!fRes.ok) {
        throw new Error(
          'We could not load your workspace settings, so this page cannot show what the run will use. Try again.'
        );
      }
      const f = (await fRes.json()) as FirmRow;
      const c = (await cRes.json()) as CampaignRow;
      setFirm(f);
      setCampaign(c);
      // Prefill from the firm default when the campaign has no cap yet.
      // These used to render as PLACEHOLDER text ("firm default: 250") while
      // the field stayed empty — and the confirm route writes only what it
      // is sent, so submitting a blank field left the column NULL and the
      // spend cap unenforceable. The number shown is now the number sent.
      const capFallback = f.campaign_defaults?.per_creator_cap_usd;
      const budgetFallback = f.campaign_defaults?.total_budget_usd;
      setPerCreatorCap(String(c.per_creator_cap_usd ?? capFallback ?? ''));
      setTotalBudget(String(c.total_budget_usd ?? budgetFallback ?? ''));
      setCapsPrefilled(c.per_creator_cap_usd == null || c.total_budget_usd == null);
      setOutreachLimit(c.outreach_limit != null ? String(c.outreach_limit) : '');
    } catch (e) {
      setLoadError(
        e instanceof Error
          ? e.message
          : 'Something went wrong loading this page. Try again.'
      );
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function confirm(thenOpen: boolean) {
    setBusy(true);
    setErr(null);
    try {
      // MONEY: both ceilings must be real numbers > 0. The old code sent
      // `parseFloat(x) || undefined`, which silently dropped a typed 0 (and a
      // blank field) — the route then wrote nothing and the column stayed
      // NULL, leaving the campaign with no enforceable cap. The API enforces
      // this too (412 campaign_caps_required); this is the fast, local half.
      if (!capsValid) {
        throw new Error(capsRequiredMessage(['total_budget_usd', 'per_creator_cap_usd']));
      }
      if (limitSupported && !limitOk) {
        throw new Error('Max creators to contact must be a whole number above 0, or blank for no limit.');
      }
      const r = await fetch(`/api/campaigns/${id}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          per_creator_cap_usd: Number(perCreatorCap),
          total_budget_usd: Number(totalBudget),
          // Pre-060 the key is never sent, so the stored row is untouched.
          ...(limitSupported ? { outreach_limit: limitText === '' ? null : limitNum } : {}),
        }),
      });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as ConfirmError;
        if (e.error === 'onboarding_required') {
          router.push('/onboarding');
          return;
        }
        // Raw column names off the 412 get mapped to this form's own labels.
        if (e.error === 'campaign_caps_required') {
          throw new Error(capsRequiredMessage(e.missing ?? []));
        }
        throw new Error(
          e.message ??
            'The campaign could not be confirmed. Nothing was started. Try again.'
        );
      }
      setCapsPrefilled(false);
      if (thenOpen) {
        router.push(`/campaigns/${id}`);
        return;
      }
      await load(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The campaign could not be confirmed.');
    } finally {
      setBusy(false);
    }
  }

  const title = campaign ? `Confirm ${campaign.artist_name}` : 'Confirm campaign';

  if (loading) {
    return (
      <AppShell title="Confirm campaign" width="narrow">
        <div className="mx-auto w-full max-w-3xl px-4 pb-12 pt-6 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            <span className="text-sm">Loading this campaign…</span>
          </div>
        </div>
      </AppShell>
    );
  }

  if (loadError || !firm || !campaign) {
    return (
      <AppShell title="Confirm campaign" width="narrow">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 pb-12 pt-6 sm:px-6 lg:px-8">
          <Alert variant="destructive">
            <AlertTriangle aria-hidden />
            <AlertTitle>This page could not load</AlertTitle>
            <AlertDescription>
              {loadError ?? 'We could not load this campaign. Try again.'}
            </AlertDescription>
          </Alert>
          <div className="flex gap-2">
            <Button type="button" onClick={() => void load()}>
              Try again
            </Button>
            <Link
              href="/campaigns"
              className={buttonVariants({ variant: 'outline' })}
            >
              <ArrowLeft className="size-3.5" />
              All campaigns
            </Link>
          </div>
        </div>
      </AppShell>
    );
  }

  const scraping = describeScrapingPrefs(firm.scraping_prefs);
  const outreach = describeOutreachPrefs(firm.outreach_prefs);
  const onboardingDone = !!firm.onboarding_completed_at;
  const canSubmit = !busy && onboardingDone && capsValid && (!limitSupported || limitOk);

  return (
    <AppShell title={title} width="narrow">
      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/campaigns/${id}`}
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            <ArrowLeft className="size-3.5" />
            Back to campaign
          </Link>
          <Link
            href="/campaigns"
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            All campaigns
          </Link>
        </div>

        <p className="text-sm text-muted-foreground">
          A campaign has to be confirmed before it can search for creators,
          negotiate, or pay anyone. Confirming is what sets the two spending
          limits below.
        </p>

        {!onboardingDone && (
          <Alert>
            <AlertTriangle aria-hidden />
            <AlertTitle>Finish setup first</AlertTitle>
            <AlertDescription>
              Your workspace setup is not complete, so this campaign cannot be
              confirmed yet.{' '}
              <Link href="/onboarding" className="underline underline-offset-4">
                Finish setup
              </Link>
              , then come back here.
            </AlertDescription>
          </Alert>
        )}

        {campaign.confirmed_at && (
          <Alert>
            <CheckCircle2 aria-hidden />
            <AlertTitle>
              Already confirmed on {new Date(campaign.confirmed_at).toLocaleString()}
            </AlertTitle>
            <AlertDescription>
              Confirming again overwrites the limits below. To start the
              discovery run, open the campaign.
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Spending limits</CardTitle>
            <CardDescription>
              These two numbers are the only things that stop this campaign
              paying a creator. Both are enforced on every payout, not just
              displayed here. A campaign with either one unset cannot pay
              anybody at all.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {capsPrefilled && (
              <Alert>
                <AlertTriangle aria-hidden />
                <AlertTitle>These limits are not saved yet</AlertTitle>
                <AlertDescription>
                  This campaign is missing at least one limit, so we have filled
                  in your workspace defaults. Check the numbers and confirm to
                  save them to this campaign.
                </AlertDescription>
              </Alert>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="per-creator-cap">Most to pay one creator</Label>
                <Input
                  id="per-creator-cap"
                  type="number"
                  min="0"
                  step="any"
                  required
                  inputMode="decimal"
                  aria-invalid={!capOk}
                  aria-describedby="per-creator-cap-help"
                  className="font-mono tabular-nums"
                  value={perCreatorCap}
                  onChange={(e) => setPerCreatorCap(e.target.value)}
                  placeholder="250"
                />
                <p id="per-creator-cap-help" className="text-xs text-muted-foreground">
                  US dollars. Negotiation will never agree above this, per
                  creator.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="total-budget">Most to spend on this campaign</Label>
                <Input
                  id="total-budget"
                  type="number"
                  min="0"
                  step="any"
                  required
                  inputMode="decimal"
                  aria-invalid={!budgetOk}
                  aria-describedby="total-budget-help"
                  className="font-mono tabular-nums"
                  value={totalBudget}
                  onChange={(e) => setTotalBudget(e.target.value)}
                  placeholder="5000"
                />
                <p id="total-budget-help" className="text-xs text-muted-foreground">
                  US dollars, across every creator on this campaign, for its
                  whole life.
                </p>
              </div>
            </div>
            {!capsValid && (
              <p className="text-sm text-destructive">
                {capsRequiredMessage([
                  ...(budgetOk ? [] : ['total_budget_usd']),
                  ...(capOk ? [] : ['per_creator_cap_usd']),
                ])}
              </p>
            )}
            {limitSupported && (
              <div className="space-y-1.5 border-t pt-4">
                <Label htmlFor="outreach-limit">Max creators to contact</Label>
                <Input
                  id="outreach-limit"
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  aria-invalid={!limitOk}
                  aria-describedby="outreach-limit-help"
                  className="max-w-40 font-mono tabular-nums"
                  value={outreachLimit}
                  onChange={(e) => setOutreachLimit(e.target.value)}
                  placeholder="No limit"
                />
                <p id="outreach-limit-help" className="text-xs text-muted-foreground">
                  Leave blank for no limit. Once this many creators have been
                  contacted, no new creator is. New creators are also held
                  back while the budget is fully allocated at the per-creator
                  cap.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What this run will use</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-6 sm:grid-cols-2">
            <SummaryBlock
              heading="Creator search"
              lines={scraping}
              editHref="/onboarding"
              editLabel="Change in setup"
            />
            {/* Tone, sign-off and follow-up cadence are edited on /onboarding,
                not /settings — /settings carries only the personality dial. */}
            <SummaryBlock
              heading="Outreach voice"
              lines={outreach}
              editHref="/onboarding"
              editLabel="Change in setup"
            />
            {/* MONEY: a discovery run buys an outside creator search plus
                several AI steps, so every run costs real money. This card listed filters and tone and said nothing
                at all about dollars, on the one screen whose whole job is
                spending limits. */}
            <p className="border-t pt-4 text-sm text-muted-foreground sm:col-span-2">
              Running discovery costs about{' '}
              <span className="font-medium text-foreground">$0.35</span> each
              time, for the creator search and the AI steps. That is separate
              from the limits above, which only cover what you pay creators.
            </p>
          </CardContent>
        </Card>

        {err && (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden />
            <AlertTitle>Not confirmed</AlertTitle>
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap gap-3">
          <Button type="button" disabled={!canSubmit} onClick={() => void confirm(true)}>
            {busy ? 'Saving…' : 'Confirm and open campaign'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!canSubmit}
            onClick={() => void confirm(false)}
          >
            {busy ? 'Saving…' : 'Save limits, stay here'}
          </Button>
        </div>
      </div>
    </AppShell>
  );
}

function SummaryBlock({
  heading,
  lines,
  editHref,
  editLabel,
}: {
  heading: string;
  lines: SummaryLine[];
  editHref: string;
  editLabel: string;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{heading}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {lines.map((l) => (
          <div key={l.label} className="contents">
            <dt className="text-muted-foreground">{l.label}</dt>
            <dd className={l.isDefault ? 'text-muted-foreground' : 'text-foreground'}>
              {l.value}
            </dd>
          </div>
        ))}
      </dl>
      <Link
        href={editHref}
        className="inline-block text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        {editLabel}
      </Link>
    </div>
  );
}
