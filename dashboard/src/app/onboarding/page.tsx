'use client';
// src/app/onboarding/page.tsx
//
// Onboarding for the workspace-level profile that shapes every campaign.
// Four steps on one page:
//   1. Who to look for (genres, follower range, engagement floor, region)
//   2. How outreach sounds (tone, dos/donts, signoff, sender identity)
//   3. Campaign defaults (per-creator cap, total budget, target count)
//   4. Spend caps
//
// On Save: PATCHes /api/firm with the union of all fields, including
// onboarding_completed_at = now() so the dashboard knows we're done.
//
// WHERE THE GATE ACTUALLY IS. `POST /api/campaigns` does NOT check
// onboarding_completed_at — a stale comment here claimed it did for months.
// The real server-side gate is on confirm
// (src/app/api/campaigns/[id]/confirm/route.ts:58-72, 412 onboarding_required),
// plus the AppShell onboarding gate that lands the user here. This page
// intentionally renders WITHOUT the AppShell so that gate can't loop.
//
// The gate used to be decorative on this side too: every field in
// UpdateFirmBody is optional and save(true) stamped onboarding_completed_at
// unconditionally, so "Save & finish setup" passed on a form nobody had
// touched. `requirements` below is the fix — see the comment on it for why
// those four and nothing else.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Crosshair, Eye, Loader2 } from 'lucide-react';

import { AttentionCallout, SettingsSection } from '@/components/page';
import { Button } from '@/components/ui/button';
import { OperatorOnly } from '@/components/OperatorContext';
import { TestingModeBanner } from '@/components/TestingModeBanner';
import { SpendCapsCard } from '@/components/SpendCapsCard';
import { Input } from '@/components/ui/input';
import { AUDIENCE_FIT_GATE_OPTIONS } from '@/lib/pool-gates';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface FirmRow {
  id: string;
  name: string;
  scraping_prefs: ScrapingPrefs;
  outreach_prefs: OutreachPrefs;
  campaign_defaults: CampaignDefaults;
  test_recipient_email: string | null;
  sender_email: string | null;
  sender_name: string | null;
  testing_mode: boolean;
  onboarding_completed_at: string | null;
  // N5 — migration 014 — monthly spend caps (0 disables)
  monthly_spend_cap_usd: number | null;
  per_creator_monthly_cap_usd: number | null;
  // Migration 016 — daily discovery spend cap (0 disables)
  daily_apify_cap_usd: number | null;
}

interface ScrapingPrefs {
  genres?: string[];
  follower_min?: number;
  follower_max?: number;
  engagement_min?: number;
  region?: string;
  /**
   * Audience-fit gate. 0 = off, the default. See AUDIENCE_FIT_GATE_OPTIONS —
   * the underlying score is a follower-band proxy, not a quality measure.
   */
  audience_fit_min?: number;
  /** Keep music artists out of the creator pool. Default true. */
  exclude_music_artists?: boolean;
}
interface OutreachPrefs {
  voice?: string;
  tone?: string;
  dos?: string[];
  donts?: string[];
  signoff?: string;
  follow_up_cadence_days?: number;
  max_follow_ups?: number;
}
interface CampaignDefaults {
  per_creator_cap_usd?: number;
  total_budget_usd?: number;
  target_count?: number;
  urgency?: string;
}

/** Shape-only email check. The server (UpdateFirmBody) is the real gate; this
 *  exists so the user is told which field is wrong BEFORE a round trip. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMPTY_FIRM: Partial<FirmRow> = {
  scraping_prefs: {
    follower_min: 1_500,
    follower_max: 250_000,
    engagement_min: 0.03,
    audience_fit_min: 0,
    exclude_music_artists: true,
  },
  outreach_prefs: {
    tone: 'warm, specific, conversational',
    dos: ['reference 2-3 of the creator\'s actual recent posts by hook'],
    donts: ['no exclamation points', 'no hope-this-finds-you-well'],
    signoff: '— ',
    follow_up_cadence_days: 5,
    max_follow_ups: 2,
  },
  campaign_defaults: {
    per_creator_cap_usd: 250,
    total_budget_usd: 5000,
    target_count: 20,
    urgency: 'normal',
  },
};

export default function OnboardingPage() {
  const router = useRouter();
  const [firm, setFirm] = useState<Partial<FirmRow>>(EMPTY_FIRM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [errDetail, setErrDetail] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/firm');
        // DATA-LOSS GUARD. This was try/finally with no catch and no !ok
        // branch: a 401/500 left EMPTY_FIRM's defaults sitting on screen as if
        // they were the workspace's real settings, and the next save PATCHed
        // those blanks straight over them. Never render this form on top of a
        // read we didn't get.
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const cur = await r.json();
        // Merge with defaults so empty jsonb columns don't break the form.
        setFirm({
          ...EMPTY_FIRM,
          ...cur,
          scraping_prefs: { ...EMPTY_FIRM.scraping_prefs, ...(cur.scraping_prefs ?? {}) },
          outreach_prefs: { ...EMPTY_FIRM.outreach_prefs, ...(cur.outreach_prefs ?? {}) },
          campaign_defaults: { ...EMPTY_FIRM.campaign_defaults, ...(cur.campaign_defaults ?? {}) },
        });
        setLoadFailed(false);
      } catch {
        setLoadFailed(true);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function save(complete: boolean) {
    setSaving(true);
    setErr(null);
    setErrDetail(null);
    try {
      // A blank sender email is "unset", not "invalid" — UpdateFirmBody takes
      // null but rejects ''. Normalising here is what stops a cleared box from
      // coming back as an unexplained 400.
      const senderEmail = (firm.sender_email ?? '').trim();
      const senderName = (firm.sender_name ?? '').trim();
      const body: Partial<FirmRow> = {
        scraping_prefs: firm.scraping_prefs,
        outreach_prefs: firm.outreach_prefs,
        campaign_defaults: firm.campaign_defaults,
        sender_email: senderEmail === '' ? null : senderEmail,
        sender_name: senderName === '' ? null : senderName,
        monthly_spend_cap_usd: firm.monthly_spend_cap_usd ?? undefined,
        per_creator_monthly_cap_usd: firm.per_creator_monthly_cap_usd ?? undefined,
        daily_apify_cap_usd: firm.daily_apify_cap_usd ?? undefined,
      };
      if (complete) (body as Record<string, unknown>).onboarding_completed_at = new Date().toISOString();
      const r = await fetch('/api/firm', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        // "Couldn't save: HTTP 400" named nothing the user could fix, and it
        // was shown twice — inline and as a toast — for one failure. One
        // surface, and it says which box is wrong.
        setErrDetail(`HTTP ${r.status}`);
        throw new Error(
          r.status === 400
            ? 'Check the sender email. It has to be a real address you can receive replies at.'
            : "We couldn't save just now. Nothing you typed was lost. Try again."
        );
      }
      if (complete) {
        toast.success('Setup complete. Taking you to your dashboard.');
        router.push('/');
      } else {
        toast.success('Saved. Come back any time to finish.');
      }
    } catch (e) {
      setErr(
        e instanceof Error && e.message
          ? e.message
          : "We couldn't save just now. Nothing you typed was lost. Try again."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-svh items-center justify-center bg-background text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading…
      </main>
    );
  }

  // Refuse to render the form rather than show defaults that aren't yours.
  if (loadFailed) {
    return (
      <main className="flex min-h-svh items-center justify-center bg-background px-4">
        <div className="w-full max-w-md space-y-4 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            We couldn&apos;t load your settings
          </h1>
          <p className="text-sm text-muted-foreground">
            Nothing has changed and nothing is lost. We stopped here on purpose:
            showing you an empty form would have let the next save overwrite
            the settings you already have.
          </p>
          <Button type="button" onClick={() => window.location.reload()}>
            Try again
          </Button>
        </div>
      </main>
    );
  }

  const sp = firm.scraping_prefs ?? {};
  const op = firm.outreach_prefs ?? {};
  const cd = firm.campaign_defaults ?? {};
  const alreadyOnboarded = Boolean(firm.onboarding_completed_at);

  // What a campaign genuinely cannot run without. Everything else on this page
  // has a working fallback and is deliberately NOT required:
  //   genres    → resolveGenre falls back campaign → artist → null, and null is
  //               a supported, genre-neutral run (api/campaigns/[id]/run)
  //   region, follower bounds, engagement floor, tone, sign-off, cadence,
  //   spend caps → all carry live defaults
  // These four do not:
  //   sender name + email are what a creator sees and replies to. With no
  //     sender email, src/lib/resend.ts falls back to RESEND_FROM_EMAIL — an
  //     address nobody at the label reads — so replies are lost, not delayed.
  //   both money ceilings are z.number().positive() on campaign create
  //     (CreateCampaignBody), so a 0 here pre-fills the campaign form with a
  //     value the API will refuse.
  const requirements = [
    { label: 'Sender name', done: (firm.sender_name ?? '').trim().length > 0 },
    {
      label: 'Sender email',
      done: EMAIL_SHAPE.test((firm.sender_email ?? '').trim()),
    },
    { label: 'Per-creator cap', done: (cd.per_creator_cap_usd ?? 0) > 0 },
    { label: 'Total budget', done: (cd.total_budget_usd ?? 0) > 0 },
  ];
  const missing = requirements.filter((r) => !r.done);
  const doneCount = requirements.length - missing.length;

  return (
    <>
    {/* No AppShell here, so the testing-mode notice is mounted directly. */}
    <TestingModeBanner />
    <main className="min-h-svh bg-background px-4 py-10 sm:py-16">
      <div className="mx-auto w-full max-w-5xl space-y-8">
        {/* Brand mark + optional escape hatch (only once setup is done, so a
            first-run user can't skip past the gate). */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Crosshair className="size-5 text-primary" />
            <span className="text-sm font-semibold tracking-tight">Creator Campaigns</span>
          </div>
          {alreadyOnboarded && (
            <Link
              href="/"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              Back to dashboard
            </Link>
          )}
        </div>

        <header className="space-y-4">
          <h1 className="text-page-title text-foreground">Set up your workspace</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Everything here is a starting point you can change on any individual
            campaign, except the four marked Required, which a campaign cannot
            run without.
          </p>

          {/* Progress. There was none: ~20 inputs across equal-weight cards
              with nothing saying which mattered or how far along you were. */}
          <div className="max-w-2xl space-y-2">
            <p className="text-meta text-muted-foreground">
              <span className="font-medium tabular-nums text-foreground">
                {doneCount} of {requirements.length}
              </span>{' '}
              required details filled in
            </p>
            <div
              className="h-1 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={requirements.length}
              aria-valuenow={doneCount}
              aria-label="Required setup details"
            >
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${(doneCount / requirements.length) * 100}%` }}
              />
            </div>
            {/* Which ones are missing is named ONCE, next to the button they
                block. Listing them here too would be the same sentence twice on
                one screen, which is half of what this pass is removing. */}
          </div>
        </header>

        {/* firms.testing_mode defaults to true in the database, so a label
            finishing setup would otherwise have no idea that nothing they set
            up here reaches anyone. The global banner says it too; this is the
            screen where the expectation gets set. The redirect ADDRESS is the
            operator's test inbox and stays out of the label's view — this page
            deliberately renders no input for it, and no longer PATCHes it. */}
        {firm.testing_mode && (
          <AttentionCallout icon={Eye} title="Nothing you set up here will reach a creator yet">
            Your workspace is in preview. Creator Campaigns writes every message and
            puts it in front of you, but does not deliver it. That stays true
            until delivery is switched on in Settings, so you can finish setup
            and run a whole campaign without a single creator being contacted.
          </AttentionCallout>
        )}

        <div>
        {/* 1. Scraping prefs */}
        <SettingsSection title="Who do you want to find?">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Genres (comma-separated)">
              <Input
                value={(sp.genres ?? []).join(', ')}
                onChange={(e) =>
                  setFirm({
                    ...firm,
                    scraping_prefs: {
                      ...sp,
                      genres: e.target.value.split(',').map((g) => g.trim()).filter(Boolean),
                    },
                  })
                }
                placeholder="country, americana, indie"
              />
            </Field>
            <Field label="Region (optional)">
              <Input
                value={sp.region ?? ''}
                onChange={(e) =>
                  setFirm({
                    ...firm,
                    scraping_prefs: { ...sp, region: e.target.value || undefined },
                  })
                }
                placeholder="US, Austin, etc."
              />
              {/* Says what it does, because for months it did nothing
                  and the confirm screen still reported it as a setting.
                  The last sentence is the part that matters: the scrape
                  carries no author-level geography, so this is a language
                  filter and must not be read as a location one. */}
              <p className="text-xs text-muted-foreground">
                Steers the search terms, and rules out creators who only post in
                other languages. It cannot check where a creator lives.
              </p>
            </Field>
            <Field label="Min followers">
              <Input
                type="number"
                className="tabular-nums"
                value={sp.follower_min ?? ''}
                onChange={(e) =>
                  setFirm({
                    ...firm,
                    scraping_prefs: { ...sp, follower_min: parseInt(e.target.value) || 0 },
                  })
                }
              />
            </Field>
            <Field label="Max followers">
              <Input
                type="number"
                className="tabular-nums"
                value={sp.follower_max ?? ''}
                onChange={(e) =>
                  setFirm({
                    ...firm,
                    scraping_prefs: { ...sp, follower_max: parseInt(e.target.value) || 0 },
                  })
                }
              />
            </Field>
            <Field label="Min engagement (e.g. 0.03 = 3%)">
              <Input
                type="number"
                step="0.005"
                className="tabular-nums"
                value={sp.engagement_min ?? ''}
                onChange={(e) =>
                  setFirm({
                    ...firm,
                    scraping_prefs: { ...sp, engagement_min: parseFloat(e.target.value) || 0 },
                  })
                }
              />
            </Field>
            {/*
              This was a free-text "Min audience fit (0-100)" box. It offered
              precision that does not exist: the score behind it is
              followerBand + platformBonus (scoring.ts:154-182), so every
              value from 51 to 60 behaves identically, as does 61 to 70. The
              box also wrote 0 on `parseInt(...) || 0` when cleared, silently
              turning the gate off with no way to say "use the default".
              A closed list of the thresholds that actually partition the
              pool, described in the followers they really measure.
            */}
            <Field label="Audience-fit gate (a follower-band filter, not a quality score)">
              <Select
                items={AUDIENCE_FIT_GATE_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
                value={String(sp.audience_fit_min ?? 0)}
                onValueChange={(v) => {
                  if (v === null) return;
                  setFirm({
                    ...firm,
                    scraping_prefs: { ...sp, audience_fit_min: parseInt(v, 10) },
                  });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUDIENCE_FIT_GATE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={String(o.value)}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                {AUDIENCE_FIT_GATE_OPTIONS.find(
                  (o) => o.value === (sp.audience_fit_min ?? 0)
                )?.detail ??
                  `Custom threshold ${sp.audience_fit_min}. Set elsewhere; kept as-is.`}
              </p>
            </Field>
            <Field label="Music artists in the pool?">
              <Select
                items={[
                  { value: 'exclude', label: 'Exclude music artists (recommended)' },
                  { value: 'allow', label: 'Allow music artists' },
                ]}
                value={(sp.exclude_music_artists ?? true) ? 'exclude' : 'allow'}
                onValueChange={(v) =>
                  setFirm({
                    ...firm,
                    scraping_prefs: { ...sp, exclude_music_artists: v === 'exclude' },
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="exclude">
                    Exclude music artists (recommended)
                  </SelectItem>
                  <SelectItem value="allow">Allow music artists</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
        </SettingsSection>

        {/* 2. Outreach voice */}
        <SettingsSection title="How should outreach sound?">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Sender name"
              required
              hint="The name in the From line of every message."
            >
              <Input
                value={firm.sender_name ?? ''}
                onChange={(e) => setFirm({ ...firm, sender_name: e.target.value })}
                placeholder="Example Records"
              />
            </Field>
            {/* This box had no type="email" while the server requires a valid
                one, so a typo came back as an unexplained HTTP 400. */}
            <Field
              label="Sender email"
              required
              hint="Where creator replies land. Use an address you actually read."
            >
              <Input
                type="email"
                inputMode="email"
                autoComplete="email"
                aria-invalid={
                  (firm.sender_email ?? '').trim().length > 0 &&
                  !EMAIL_SHAPE.test((firm.sender_email ?? '').trim())
                }
                value={firm.sender_email ?? ''}
                onChange={(e) => setFirm({ ...firm, sender_email: e.target.value })}
                placeholder="you@yourlabel.com"
              />
            </Field>
            <Field label="Tone">
              <Input
                value={op.tone ?? ''}
                onChange={(e) =>
                  setFirm({ ...firm, outreach_prefs: { ...op, tone: e.target.value } })
                }
              />
            </Field>
            <Field label="Sign-off">
              <Input
                value={op.signoff ?? ''}
                onChange={(e) =>
                  setFirm({ ...firm, outreach_prefs: { ...op, signoff: e.target.value } })
                }
              />
            </Field>
            <Field label="Always do (one per line)" wide>
              <Textarea
                rows={3}
                value={(op.dos ?? []).join('\n')}
                onChange={(e) =>
                  setFirm({
                    ...firm,
                    outreach_prefs: {
                      ...op,
                      dos: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                    },
                  })
                }
              />
            </Field>
            <Field label="Never do (one per line)" wide>
              <Textarea
                rows={3}
                value={(op.donts ?? []).join('\n')}
                onChange={(e) =>
                  setFirm({
                    ...firm,
                    outreach_prefs: {
                      ...op,
                      donts: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                    },
                  })
                }
              />
            </Field>
            <Field label="Follow-up cadence (days)">
              <Input
                type="number"
                className="tabular-nums"
                value={op.follow_up_cadence_days ?? ''}
                onChange={(e) =>
                  setFirm({
                    ...firm,
                    outreach_prefs: {
                      ...op,
                      follow_up_cadence_days: parseInt(e.target.value) || 0,
                    },
                  })
                }
              />
            </Field>
            <Field label="Max follow-ups">
              <Input
                type="number"
                className="tabular-nums"
                value={op.max_follow_ups ?? ''}
                onChange={(e) =>
                  setFirm({
                    ...firm,
                    outreach_prefs: { ...op, max_follow_ups: parseInt(e.target.value) || 0 },
                  })
                }
              />
            </Field>
          </div>
        </SettingsSection>

        {/* 3. Campaign defaults. "You can override any per campaign" leads
            the page header; what survives here is the consequence a reader
            can't infer from the heading. */}
        <SettingsSection
          title="Campaign defaults"
          description="The per-creator cap is the most any one creator can ever be paid on a campaign that starts from these numbers."
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Per-creator cap ($)" required>
              <Input
                type="number"
                className="tabular-nums"
                value={cd.per_creator_cap_usd ?? ''}
                onChange={(e) =>
                  setFirm({
                    ...firm,
                    campaign_defaults: { ...cd, per_creator_cap_usd: parseFloat(e.target.value) || 0 },
                  })
                }
              />
            </Field>
            <Field label="Total budget ($)" required>
              <Input
                type="number"
                className="tabular-nums"
                value={cd.total_budget_usd ?? ''}
                onChange={(e) =>
                  setFirm({
                    ...firm,
                    campaign_defaults: { ...cd, total_budget_usd: parseFloat(e.target.value) || 0 },
                  })
                }
              />
            </Field>
            <Field label="Target creators">
              <Input
                type="number"
                className="tabular-nums"
                value={cd.target_count ?? ''}
                onChange={(e) =>
                  setFirm({
                    ...firm,
                    campaign_defaults: { ...cd, target_count: parseInt(e.target.value) || 0 },
                  })
                }
              />
            </Field>
            <Field label="Urgency">
              <Select
                items={[
                  { value: 'rush', label: 'Rush' },
                  { value: 'normal', label: 'Normal' },
                  { value: 'long-tail', label: 'Long-tail' },
                ]}
                value={cd.urgency ?? 'normal'}
                onValueChange={(v) =>
                  setFirm({
                    ...firm,
                    campaign_defaults: { ...cd, urgency: v ?? 'normal' },
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rush">Rush</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="long-tail">Long-tail</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
        </SettingsSection>

        {/* 4. Spend caps (N5)

            Was a hand-copied duplicate of the same card in /settings, down to
            the byte. Now the shared component — which also carries the daily
            discovery cap this copy had silently dropped, so a label sets every
            money limit in one place instead of two thirds of them here. */}
        <SpendCapsCard
          idPrefix="onboarding-caps"
          commitOn="change"
          columns={2}
          value={{
            monthly_spend_cap_usd: firm.monthly_spend_cap_usd ?? null,
            per_creator_monthly_cap_usd: firm.per_creator_monthly_cap_usd ?? null,
            daily_apify_cap_usd: firm.daily_apify_cap_usd ?? null,
          }}
          onChange={(patch) => setFirm((prev) => ({ ...prev, ...patch }))}
        />
        </div>

        <div className="space-y-3 border-t pt-6">
          {err && (
            <p className="text-sm text-destructive" role="alert">
              {err}
              {errDetail && (
                <OperatorOnly>
                  <span className="ml-2 font-mono text-xs opacity-70">
                    {errDetail}
                  </span>
                </OperatorOnly>
              )}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-3">
            {missing.length > 0 && (
              <p className="mr-auto text-meta text-muted-foreground">
                Add {missing.map((m) => m.label).join(', ')} to finish setup.
                Everything else you have typed is safe to save now.
              </p>
            )}
            <Button type="button" variant="ghost" onClick={() => save(false)} disabled={saving}>
              {saving ? 'Saving…' : 'Save and come back later'}
            </Button>
            {/* The real gate. Every field in UpdateFirmBody is optional and the
                server stamps onboarding_completed_at on whatever it is given,
                so this button was passable on a form nobody had touched. */}
            <Button
              type="button"
              onClick={() => save(true)}
              disabled={saving || missing.length > 0}
            >
              {saving ? 'Saving…' : 'Finish setup'}
            </Button>
          </div>
        </div>

        {alreadyOnboarded && (
          <p className="text-right text-meta text-muted-foreground">
            Setup completed {new Date(firm.onboarding_completed_at!).toLocaleDateString()}.
            Saving here updates your defaults without repeating setup.
          </p>
        )}
      </div>
    </main>
    </>
  );
}

function Field({
  label,
  children,
  wide,
  required,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
  /** Marks a field a campaign cannot run without — see `requirements`. */
  required?: boolean;
  /** One line of consequence. Omit it when it would only restate the label. */
  hint?: string;
}) {
  return (
    <label className={`block space-y-1.5 ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="block text-sm font-medium text-foreground">
        {label}
        {required && (
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            Required
          </span>
        )}
      </span>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </label>
  );
}
