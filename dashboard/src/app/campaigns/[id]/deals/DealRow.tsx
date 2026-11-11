'use client';
// src/app/campaigns/[id]/deals/DealRow.tsx
//
// Action island for one deal row on /campaigns/[id]/deals. Owns the per-row
// state machine: pulls the actions menu out of the page so a slow network
// call on one row doesn't freeze the list, and so each row's busy/error
// state is local.
//
// Deal-level buttons are a function of offer.status (see /lib/negotiation.ts
// state graph). Money buttons are per settlement leg (migration 055: deposit +
// balance, or one full), each derived from THAT leg's state by
// lib/payment-legs.legActions — never from offer.status alone, which is how a
// failed balance leg on a 'posted' deal used to have no Retry. Inline forms
// appear in-place for the two human-data-entry transitions: paid→posted (log
// post URL) and posted→measured (record streams).

import { useState } from 'react';
import { describeDealError, describeFailureReason } from '@/lib/deal-errors';
import { PROMO_LABEL, PROMO_TYPES, type PromoType } from '@/lib/deliverables';
import { MANUAL_MODE_LABEL, isHumanTakeover } from '@/lib/takeover-state';
import {
  legActions,
  legLabel,
  legStatusText,
  type DealPaymentLeg,
} from '@/lib/payment-legs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface DealOffer {
  id: string;
  status: string;
  initial_offer_usd: number | null;
  current_offer_usd: number | null;
  agreed_amount_usd: number | null;
  /** The last price the creator was actually sent; null/absent when unknown.
   *  Display only. Optional for older payloads. */
  last_sent_offer_usd?: number | null;
  /** 'human' = a person has taken this negotiation over. */
  autonomy_mode?: string | null;
  ceiling_usd: number;
  rounds: number;
  post_url: string | null;
  posted_at: string | null;
  paid_at: string | null;
  // Migration 030/031 — payout lifecycle distinct from the deal state machine
  // (null | awaiting_onboarding | pending | paid | returned | failed).
  payout_status: string | null;
  // Every settlement leg, ordered deposit → full → balance. Empty until a
  // payment is set up.
  payment_authorizations: DealPaymentLeg[];
  /** Server-computed (payment-legs.approvalQueueGap): the deal is waiting on a
   *  payment that was never created. Optional for older payloads. */
  approval_gap?: 'first' | 'balance' | null;
  /** Server-computed: a person stopped this deal's payment (no transfer on
   *  file). "Re-create stopped payment" reopens it — explicit, confirmed. */
  reopenable_gap?: 'first' | 'balance' | null;
  outcome: {
    streams_attributed: number | null;
    attribution_method: string | null;
    measured_at: string | null;
    // At-post snapshots — preferred factor sources for the
    // correlation engine; echoed by the deals route to pre-fill re-measures.
    follower_count_at_post: number | null;
    engagement_at_post: number | null;
  } | null;
  // Migration 036 — delivery verification. status = the post exists on the
  // creator's profile; spec_check = the found post matches the agreed
  // deliverables (pass | fail | partial).
  delivery: {
    status: string;
    spec_check: string | null;
    spec_check_detail: string | null;
  } | null;
  // What the money actually buys, frozen at agreement time. The deals
  // route already ships both; this row rendered neither, so the deal list was
  // the one surface showing a price with no package.
  //   deliverables_text: one label-readable line, '' when the offer carries none
  //   contract_sent:     contract_generated_at != null
  deliverables_text: string;
  contract_sent: boolean;
}

interface Props {
  campaignId: string;
  campaignInfluencerId: string;
  // influencerId + contactEmail thread through so we can backfill the email
  // inline when payment is about to be created/executed against a creator
  // we never enriched a contact for (manual stopgap until automated
  // contact enrichment covers it).
  influencerId: string;
  contactEmail: string | null;
  offer: DealOffer | null;
  /** The campaign's standing package, for the quick-offer form to name as the
   *  default it is about to inherit. Null when it could not be read. */
  standingPackage?: string | null;
  // Called after any successful state-changing action so the parent can
  // re-fetch the full deals payload.
  onChanged: () => void;
}

type LegAction = 'approve' | 'reject' | 'execute' | 'revoke';

type Busy =
  | null
  | 'quick_offer'
  | 'authorize'
  | 'log_post'
  | 'record_streams'
  | 'save_contact_email'
  | 'cancel_offer'
  // Money actions are per leg: `<action>:<payment_authorization id>`.
  | `${LegAction}:${string}`;

const legBusy = (action: LegAction, paId: string): Busy => `${action}:${paId}`;

// Offer statuses where Cancel is no longer safe — money has moved or
// external state exists. Mirrors TERMINAL_OR_POST_PAID in lib/cancel-offer.ts
// (including the split-settlement states it gained with 052), plus the
// already-terminal pair so we don't render Cancel on a row that's already done.
const CANCEL_BLOCKED_STATUSES = new Set([
  'paid',
  'deposit_paid',
  'posted',
  'balance_paid',
  'measured',
  'undelivered',
  'rejected',
  'failed',
]);

const ATTRIBUTION_METHODS = [
  { value: 'manual', label: 'Manual count' },
  { value: 'spotify_for_artists', label: 'Spotify for Artists' },
  { value: 'estimated_from_views', label: 'Estimated from views' },
  { value: 'unknown', label: 'Unknown' },
];

// Statuses dashboard: every deal row links to the read-only
// per-creator thread. Rendered by the exported wrapper (not inside
// DealRowActions) so the link survives every early-return state — the
// rejected/failed/flagged rows are exactly the ones worth inspecting.
/** Blank quantities for the per-deal package editor. */
const EMPTY_PACKAGE: Record<PromoType, string> = {
  story: '',
  post: '',
  reel: '',
  dance_trend: '',
};

export function DealRow(props: Props) {
  return (
    <div className="flex min-w-0 flex-col items-end gap-2">
      {/* Manual mode. Resuming needs the price last quoted, which
          lives in the thread, so the resume form is there. */}
      {props.offer && isHumanTakeover(props.offer) && (
        <a
          href={`/campaigns/${props.campaignId}/deals/${props.campaignInfluencerId}/thread`}
          className="rounded-md border border-status-flagged bg-status-flagged/20 px-2 py-1 text-xs"
          title="Nothing is agreed or countered automatically. Open the thread to resume automation with the price you last quoted."
        >
          {MANUAL_MODE_LABEL} · resume from the thread
        </a>
      )}
      <a
        href={`/campaigns/${props.campaignId}/deals/${props.campaignInfluencerId}/thread`}
        className="text-xs font-medium text-primary underline-offset-4 hover:underline"
      >
        View thread
      </a>
      <DealRowActions {...props} />
    </div>
  );
}

function DealRowActions({
  campaignId,
  campaignInfluencerId,
  influencerId,
  contactEmail,
  offer,
  standingPackage,
  onChanged,
}: Props) {
  const [busy, setBusy] = useState<Busy>(null);
  const [err, setErr] = useState<string | null>(null);

  // quick-offer form state (no offer yet → lock in agreed amount)
  const [quickAmount, setQuickAmount] = useState('');
  // Per-deal package. The route takes an optional `deliverables` array and this
  // form never sent one, so every manually-recorded deal silently inherited the
  // campaign's standing package and a manager had no way to agree different
  // terms with one creator — which is exactly the case this shortcut exists for
  // (the price was negotiated off-platform, so the package usually was too).
  const [packageOpen, setPackageOpen] = useState(false);
  const [quantities, setQuantities] = useState<Record<PromoType, string>>(EMPTY_PACKAGE);
  const [windowDays, setWindowDays] = useState('14');

  // post-URL form state
  const [postUrl, setPostUrl] = useState('');

  // streams form state — lazily pre-filled from the existing outcome so the
  // measured-state "Update measurement" path (re-measure, e.g. 1-week →
  // 30-day counts) starts from what was recorded last time.
  const [streams, setStreams] = useState(() =>
    offer?.outcome?.streams_attributed != null
      ? String(offer.outcome.streams_attributed)
      : ''
  );
  const [attribution, setAttribution] = useState(() => {
    const m = offer?.outcome?.attribution_method;
    return m && ATTRIBUTION_METHODS.some((x) => x.value === m) ? m : 'manual';
  });
  // Optional at-post snapshots. Engagement is entered as a percent
  // (0–100) and sent ÷ 100 to match the API's 0–1 zod range.
  const [followersAtPost, setFollowersAtPost] = useState(() =>
    offer?.outcome?.follower_count_at_post != null
      ? String(offer.outcome.follower_count_at_post)
      : ''
  );
  const [engagementPct, setEngagementPct] = useState(() =>
    offer?.outcome?.engagement_at_post != null
      ? String(Math.round(offer.outcome.engagement_at_post * 10_000) / 100)
      : ''
  );
  // measured-state re-measure form toggle.
  const [remeasureOpen, setRemeasureOpen] = useState(false);

  // contact-email backfill state (payment can't fire without one)
  const [emailDraft, setEmailDraft] = useState('');

  // Returns true on success so callers can close inline forms; errors land
  // in the row-local err state either way.
  async function call(
    label: Busy,
    url: string,
    init: RequestInit
  ): Promise<boolean> {
    setBusy(label);
    setErr(null);
    try {
      const r = await fetch(url, init);
      const text = await r.text();
      let parsed: {
        error?: string;
        // Two routes (quick-offer over_cap / creator_excluded) ship written
        // prose here; the old client never read it.
        message?: string;
        guidance?: string;
        payout?: { ok?: boolean; guidance?: string | null; reason?: string | null };
      } | null = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON */
      }
      if (!r.ok) {
        // describeDealError keeps its precedence — server-baked `guidance`
        // (Stripe + payout mappers) always wins — and only then falls back to
        // route prose and the app-slug map. It replaces `?? parsed.error`,
        // which put bare codes like `over_cap` and `invalid_state` on screen
        // and threw away the `message` two routes already send.
        throw new Error(describeDealError(parsed, r.status));
      }
      // A 2xx can still carry a failed payout: /api/payments/[id]/approve
      // answers 207 Multi-Status when the approval committed but the money did
      // NOT move. The row state really did change, so refresh it — but show the
      // reason instead of letting the failure read as a success.
      const payout = parsed?.payout;
      if (payout && payout.ok === false) {
        setErr(
          describeDealError(
            { guidance: payout.guidance ?? undefined, error: payout.reason ?? undefined },
            r.status
          )
        );
        onChanged();
        return false;
      }
      onChanged();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : describeDealError(null));
      return false;
    } finally {
      setBusy(null);
    }
  }

  // No offer yet — inline form to lock in an agreed amount. Skips the
  // multi-round negotiation walk (the label negotiates via email; once they have
  // a number, this records it and promotes to human_approval_required).
  if (!offer) {
    const amountValid = (() => {
      const n = Number(quickAmount);
      return Number.isFinite(n) && n > 0;
    })();
    const windowNum = Number(windowDays);
    const windowValid = Number.isFinite(windowNum) && windowNum > 0;
    // Only send a package when the manager actually set one. An empty editor
    // means "whatever this campaign normally buys", which is what the route
    // does with an absent `deliverables`.
    const customLines = PROMO_TYPES.map((t) => {
      const n = Number(quantities[t]);
      return Number.isFinite(n) && n > 0
        ? {
            promo_type: t,
            quantity: Math.floor(n),
            delivery_window_days: Math.floor(windowNum),
            min_seconds: null,
          }
        : null;
    }).filter((l): l is NonNullable<typeof l> => l !== null);
    const packageValid = customLines.length === 0 || windowValid;

    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-muted-foreground">$</span>
          <Input
            type="number"
            inputMode="decimal"
            placeholder="250"
            value={quickAmount}
            onChange={(e) => setQuickAmount(e.target.value)}
            disabled={busy !== null}
            className="w-24 font-mono"
            aria-label="Amount agreed with this creator"
          />
          <Button
            size="sm"
            disabled={!amountValid || !packageValid || busy !== null}
            onClick={() => {
              void call(
                'quick_offer',
                `/api/campaigns/${campaignId}/quick-offer/${campaignInfluencerId}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    agreed_amount_usd: Number(quickAmount),
                    ...(customLines.length > 0 ? { deliverables: customLines } : {}),
                  }),
                }
              );
            }}
          >
            {busy === 'quick_offer' ? 'Saving…' : 'Lock in deal'}
          </Button>
        </div>

        {/* What the money buys. Collapsed by default so the common case stays
            one number and one button; open it to agree different terms with
            this one creator. */}
        <div className="text-xs text-muted-foreground">
          {customLines.length > 0 ? (
            <span>
              For{' '}
              {customLines
                .map((l) => `${l.quantity} × ${PROMO_LABEL[l.promo_type]}`)
                .join(', ')}
              , within {Math.floor(windowNum)} days.
            </span>
          ) : (
            <span>
              For {standingPackage ? standingPackage : 'this campaign\u2019s usual package'}.
            </span>
          )}{' '}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => setPackageOpen((v) => !v)}
          >
            {packageOpen ? 'done' : 'change'}
          </button>
        </div>

        {packageOpen && (
          <div className="space-y-2 rounded-md border p-2">
            <div className="grid grid-cols-2 gap-2">
              {PROMO_TYPES.map((t) => (
                <label key={t} className="flex items-center gap-1.5 text-xs">
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={50}
                    placeholder="0"
                    value={quantities[t]}
                    onChange={(e) =>
                      setQuantities((prev) => ({ ...prev, [t]: e.target.value }))
                    }
                    disabled={busy !== null}
                    className="h-8 w-14 font-mono"
                  />
                  <span className="truncate">{PROMO_LABEL[t]}</span>
                </label>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-xs">
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                value={windowDays}
                onChange={(e) => setWindowDays(e.target.value)}
                disabled={busy !== null}
                aria-invalid={!windowValid}
                className="h-8 w-14 font-mono"
              />
              <span>days to deliver</span>
            </label>
            <p className="text-[11px] text-muted-foreground">
              Leave every box at 0 to use the campaign package.
            </p>
          </div>
        )}
        {err && <div className="text-xs text-destructive wrap-anywhere">{err}</div>}
      </div>
    );
  }

  const legs = offer.payment_authorizations;

  // One settlement leg: which payment, how much, what state, and the actions
  // the server will accept for it. Stop and Reject both close the whole deal
  // server-side (reject-payment.ts sets the offer to 'rejected').
  function renderLeg(l: DealPaymentLeg, interactive: boolean) {
    if (!offer) return null;
    const a = legActions(l, offer.status);
    const amount = `$${l.amount_usd.toFixed(2)}`;
    const name = legLabel(l.leg);
    // 'full' reads as "the payment"; a split leg names itself on the button.
    const what = l.leg === 'full' ? amount : `${name.toLowerCase()} ${amount}`;
    const awaitingOnboarding =
      l.status === 'approved' && offer.payout_status === 'awaiting_onboarding';
    const tone =
      l.status === 'failed'
        ? 'text-destructive'
        : l.status === 'completed'
          ? 'text-status-payout-complete-fg'
          : l.status === 'pending_human_review' || l.status === 'approved'
            ? 'text-status-payout-pending-fg'
            : 'text-muted-foreground';

    const legButtons: React.ReactNode[] = [];
    if (a.approve) {
      legButtons.push(
        // The human approval: full-size primary, the loudest control on the
        // card. Reject next to it stays ghost.
        <Button
          key="approve"
          type="button"
          disabled={busy !== null}
          onClick={() =>
            call(legBusy('approve', l.id), `/api/payments/${l.id}/approve`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
            })
          }
        >
          {busy === legBusy('approve', l.id) ? 'Approving…' : `Approve & pay ${what}`}
        </Button>
      );
    }
    if (a.reject) {
      legButtons.push(
        <Button
          key="reject"
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          disabled={busy !== null}
          onClick={() => {
            // window.prompt returns null when the user backs out. The old code
            // coerced that to '' and rejected the payment anyway — there was no
            // way to change your mind once the dialog was open.
            const reason = window.prompt(
              `Why are you rejecting the ${name.toLowerCase()} of ${amount}? (optional)`
            );
            if (reason === null) return;
            void call(legBusy('reject', l.id), `/api/payments/${l.id}/reject`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ reason }),
            });
          }}
        >
          {busy === legBusy('reject', l.id) ? 'Rejecting…' : 'Reject'}
        </Button>
      );
    }
    // The money action. Default size, not sm, so "send this creator $250" is
    // never the same object at the same weight as Cancel.
    if (a.execute || a.retry) {
      legButtons.push(
        <Button
          key="execute"
          type="button"
          variant={awaitingOnboarding ? 'outline' : 'default'}
          disabled={busy !== null}
          onClick={() =>
            call(legBusy('execute', l.id), `/api/payments/${l.id}/execute`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              // Only the "Re-send payout setup email" label may queue another
              // setup email; the server still refuses while one is queued.
              body: JSON.stringify({ resend_onboarding_email: awaitingOnboarding && !a.retry }),
            })
          }
        >
          {busy === legBusy('execute', l.id)
            ? a.retry
              ? 'Retrying…'
              : 'Executing…'
            : a.retry
              ? 'Retry payment'
              : awaitingOnboarding
                ? 'Re-send payout setup email'
                : 'Execute payment'}
        </Button>
      );
    }
    // Approved (or failed) and never sent: the human stop. Most often a
    // creator who has not finished payout setup — the Stripe webhook pays the
    // moment they do, possibly days after the approval, so this is the last
    // point anyone can say no. The server refuses (409) once a payout has
    // started.
    if (a.stop) {
      legButtons.push(
        <Button
          key="revoke"
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          disabled={busy !== null}
          onClick={() => {
            if (
              !window.confirm(
                `Stop the ${name.toLowerCase()} of ${amount}? The creator will not be paid and this deal will be closed.`
              )
            ) {
              return;
            }
            void call(legBusy('revoke', l.id), `/api/payments/${l.id}/reject`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({}),
            });
          }}
        >
          {busy === legBusy('revoke', l.id) ? 'Stopping…' : 'Stop payment'}
        </Button>
      );
    }

    return (
      <div
        key={l.id}
        className={`flex w-full min-w-0 flex-col items-end gap-1.5 rounded-md border px-3 py-2.5 ${
          interactive && (a.approve || a.execute || a.retry)
            ? l.status === "failed"
              ? "border-status-flagged-fg/30 bg-status-flagged/60"
              : "border-attention-border bg-attention"
            : ""
        }`}
      >
        <div className="flex flex-wrap items-baseline justify-end gap-x-2 text-xs">
          <span className="whitespace-nowrap font-medium">{name}</span>
          <span className="whitespace-nowrap font-semibold tabular-nums">{amount}</span>
          <span className={tone}>{legStatusText(l, offer.payout_status)}</span>
        </div>
        {l.status === 'failed' && l.failure_reason && (
          // Stripe reasons can carry a long unbroken URL: break anywhere so it
          // cannot widen the column, clamp to two lines, full text on hover.
          <span
            className="line-clamp-2 w-full text-right text-xs text-destructive wrap-anywhere"
            title={describeFailureReason(l.failure_reason)}
          >
            {describeFailureReason(l.failure_reason)}
          </span>
        )}
        {interactive && legButtons.length > 0 && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {legButtons}
          </div>
        )}
      </div>
    );
  }

  const legList = (interactive: boolean) =>
    legs.length > 0 ? (
      <div className="flex w-full flex-col gap-2">
        {legs.map((l) => renderLeg(l, interactive))}
      </div>
    ) : null;

  // Terminal states with no follow-up action. The legs still show: which
  // payments went out, and which were stopped, is the record of the deal.
  if (offer.status === 'rejected') {
    return (
      <div className="flex flex-col items-end gap-2">
        {legList(true)}
        <div className="text-sm text-muted-foreground">
          Rejected. This deal is closed.
        </div>
      </div>
    );
  }
  if (offer.status === 'failed') {
    return (
      <div className="flex flex-col items-end gap-2">
        {legList(true)}
        <div className="text-right text-sm text-destructive">
          This deal failed and was closed.
        </div>
      </div>
    );
  }
  // measured is no longer strictly terminal: re-measurement (typically the
  // 1-week stream count superseded by the 30-day count) reuses the same
  // record-streams form — /api/outcomes/record upserts on creator_offer_id
  // and re-stamps the deal economics. Closed state shows the summary line;
  // "Update measurement" opens the form pre-filled from the last outcome.
  if (offer.status === 'measured' && !remeasureOpen) {
    return (
      <div className="flex flex-col items-end gap-2 text-sm">
        {legList(true)}
        <div className="text-status-payout-complete-fg">
          Measured. This deal is complete.
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setRemeasureOpen(true)}
        >
          Update measurement
        </Button>
      </div>
    );
  }

  // Contact-email gate. Stripe Connect transfers + receipt mails require a
  // real creator email; until ScrapeGraphAI enrichment lands we collect it
  // inline. Block the next action on the states where creating or sending a
  // payment is next — including a balance leg on a 'posted' deal.
  const emailGateActive =
    !contactEmail &&
    (offer.status === 'human_approval_required' ||
      offer.status === 'approved' ||
      legs.some((l) => {
        const a = legActions(l, offer.status);
        return a.approve || a.execute || a.retry;
      }));

  async function submitContactEmail(e: React.FormEvent) {
    e.preventDefault();
    const next = emailDraft.trim();
    if (!next) {
      setErr('Enter the creator’s email address first.');
      return;
    }
    await call('save_contact_email', `/api/influencers/${influencerId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contact_email: next }),
    });
  }

  if (emailGateActive) {
    return (
      <form
        onSubmit={submitContactEmail}
        className="flex w-full flex-col items-end gap-2"
      >
        {legList(false)}
        <div className="text-right text-xs text-status-payout-pending-fg">
          We need this creator&apos;s email address before we can pay them.
        </div>
        <div className="flex w-full items-center gap-2">
          <Input
            type="email"
            placeholder="creator@example.com"
            aria-label="Creator email address"
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            disabled={busy !== null}
            className="flex-1"
          />
          <Button
            type="submit"
            size="sm"
            disabled={busy !== null || !emailDraft.trim()}
          >
            {busy === 'save_contact_email' ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {err && <span className="text-xs text-destructive wrap-anywhere">{err}</span>}
      </form>
    );
  }

  const buttons: React.ReactNode[] = [];

  // human_approval_required + no leg yet → create the first one. The
  // negotiation lib auto-promotes agreed → human_approval_required, so
  // 'agreed' is never a UI-visible resting state. /api/payments/authorize
  // requires status = 'human_approval_required'. A balance leg is minted by
  // post verification, never from here.
  //
  // approval_gap (server-computed) generalises that: 'first' is the same case
  // (the automatic mint failed, or only a dead leg exists), and 'balance' is a
  // posted deal whose balance mint failed — the remainder was owed with
  // nothing in /approvals and nothing that would ever create it. Both go
  // through /api/payments/remint, which refuses unless the gap is real.
  const gap = offer.approval_gap ?? (offer.status === 'human_approval_required' && legs.length === 0 ? 'first' : null);
  if (gap) {
    buttons.push(
      <span key="gap-note" className="text-xs text-status-payout-pending-fg">
        {gap === 'balance'
          ? 'The balance is owed, but nothing is waiting in Approvals for it yet.'
          : 'Nothing is waiting in Approvals for this deal yet.'}
      </span>
    );
    buttons.push(
      <Button
        key="auth"
        type="button"
        size="sm"
        title="Puts this payment in the Approvals queue. Nobody is paid until it is approved."
        disabled={busy !== null}
        onClick={() =>
          call('authorize', '/api/payments/remint', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ offer_id: offer.id }),
          })
        }
      >
        {busy === 'authorize' ? 'Preparing…' : gap === 'balance' ? 'Create balance payment' : 'Set up payment'}
      </Button>
    );
  }
  // A payment a PERSON stopped stays stopped — nothing re-creates it, and the
  // deal does not nag. The operator may still pay it deliberately: this is that
  // explicit act (reopen_stopped), behind a confirm, and the new payment still
  // needs a fresh approval before any money moves.
  const reopenGap = !gap ? (offer.reopenable_gap ?? null) : null;
  if (reopenGap) {
    buttons.push(
      <Button
        key="reopen"
        type="button"
        size="sm"
        variant="ghost"
        title="Someone stopped this payment. This puts a new one in Approvals; nobody is paid until it is approved."
        disabled={busy !== null}
        onClick={() => {
          if (
            !window.confirm(
              'This payment was stopped on purpose. Create it again and send it to Approvals? It still needs an approval before anything is paid.'
            )
          ) {
            return;
          }
          void call('authorize', '/api/payments/remint', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ offer_id: offer.id, reopen_stopped: true }),
          });
        }}
      >
        {busy === 'authorize' ? 'Preparing…' : 'Re-create stopped payment'}
      </Button>
    );
  }

  // Cancel button — available from any pre-paid state. Lives next to the
  // positive-action button(s) so a misclick on "Lock in deal" or a wrong
  // approval can be walked back before money moves. window.confirm() is
  // intentional friction (terminal action, no second-chance undo). Hidden
  // while any leg is in flight or has moved money — the same two refusals
  // lib/cancel-offer.ts answers with.
  const moneyMovingOrMoved = legs.some(
    (l) => l.status === 'executing' || l.status === 'completed' || !!l.payment_provider_id
  );
  if (!CANCEL_BLOCKED_STATUSES.has(offer.status) && !moneyMovingOrMoved) {
    buttons.push(
      <Button
        key="cancel"
        type="button"
        size="sm"
        variant="ghost"
        className="text-muted-foreground"
        disabled={busy !== null}
        onClick={() => {
          if (
            !window.confirm(
              'Cancel this deal? It cannot be reopened afterwards.'
            )
          ) {
            return;
          }
          void call(
            'cancel_offer',
            `/api/campaigns/${campaignId}/quick-offer/${campaignInfluencerId}/cancel`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
            }
          );
        }}
      >
        {busy === 'cancel_offer' ? 'Cancelling…' : 'Cancel'}
      </Button>
    );
  }

  // paid (no post_url yet) → inline form for the URL.
  const showLogPost = offer.status === 'paid' && !offer.post_url;
  // posted (no outcome) → inline form for streams; measured + re-measure
  // toggle → same form, pre-filled (the API upserts on creator_offer_id).
  const showRecordStreams =
    (offer.status === 'posted' && !offer.outcome) ||
    (offer.status === 'measured' && remeasureOpen);

  async function submitLogPost(e: React.FormEvent) {
    e.preventDefault();
    if (!offer) return;
    if (!postUrl.trim()) {
      setErr('Paste the link to the creator\u2019s post first.');
      return;
    }
    await call(
      'log_post',
      `/api/campaigns/${campaignId}/deals/${offer.id}/post`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ post_url: postUrl.trim() }),
      }
    );
  }

  async function submitStreams(e: React.FormEvent) {
    e.preventDefault();
    if (!offer) return;
    const n = parseInt(streams, 10);
    if (!Number.isFinite(n) || n < 0) {
      setErr('Enter the number of streams as a whole number, 0 or more.');
      return;
    }
    const body: Record<string, unknown> = {
      creator_offer_id: offer.id,
      streams_attributed: n,
      attribution_method: attribution,
    };
    // Optional at-post snapshots — only sent when filled (the API zod schema
    // takes both as optional; engagement is 0–1 there, entered as % here).
    if (followersAtPost.trim() !== '') {
      const f = parseInt(followersAtPost, 10);
      if (!Number.isFinite(f) || f < 0) {
        setErr('Enter the follower count as a whole number, 0 or more.');
        return;
      }
      body.follower_count_at_post = f;
    }
    if (engagementPct.trim() !== '') {
      const p = Number(engagementPct);
      if (!Number.isFinite(p) || p < 0 || p > 100) {
        setErr('Enter the engagement rate as a percentage between 0 and 100.');
        return;
      }
      body.engagement_at_post = p / 100;
    }
    const ok = await call('record_streams', '/api/outcomes/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (ok) setRemeasureOpen(false);
  }

  return (
    <div className="flex flex-col items-end gap-2 text-sm">
      {legList(true)}
      {buttons.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {buttons}
        </div>
      )}
      {showLogPost && (
        <form
          onSubmit={submitLogPost}
          className="flex w-full items-center gap-2"
        >
          <Input
            type="url"
            placeholder="https://tiktok.com/@…/video/…"
            aria-label="Post URL"
            value={postUrl}
            onChange={(e) => setPostUrl(e.target.value)}
            disabled={busy !== null}
            className="flex-1"
          />
          <Button
            type="submit"
            size="sm"
            disabled={busy !== null || !postUrl.trim()}
          >
            {busy === 'log_post' ? 'Saving…' : 'Log post URL'}
          </Button>
        </form>
      )}
      {showRecordStreams && (
        <form
          onSubmit={submitStreams}
          className="flex w-full flex-wrap items-center justify-end gap-2"
        >
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            placeholder="Streams"
            aria-label="Streams"
            value={streams}
            onChange={(e) => setStreams(e.target.value)}
            disabled={busy !== null}
            className="w-32"
          />
          <Select
            value={attribution}
            onValueChange={(v) => setAttribution(v ?? 'manual')}
            disabled={busy !== null}
          >
            <SelectTrigger className="w-48" aria-label="Attribution method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ATTRIBUTION_METHODS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            placeholder="Followers at post (opt.)"
            aria-label="Followers at post (optional)"
            title="Optional. Lets us compare this post against the creator's usual reach."
            value={followersAtPost}
            onChange={(e) => setFollowersAtPost(e.target.value)}
            disabled={busy !== null}
            className="w-44"
          />
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step="any"
            placeholder="Engagement % (opt.)"
            aria-label="Engagement percent (optional)"
            value={engagementPct}
            onChange={(e) => setEngagementPct(e.target.value)}
            disabled={busy !== null}
            className="w-40"
          />
          <Button
            type="submit"
            size="sm"
            disabled={busy !== null || streams === ''}
          >
            {busy === 'record_streams'
              ? 'Saving…'
              : offer.status === 'measured'
                ? 'Update measurement'
                : 'Record streams'}
          </Button>
          {offer.status === 'measured' && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setRemeasureOpen(false)}
            >
              Cancel
            </Button>
          )}
        </form>
      )}
      {err && <span className="text-right text-destructive wrap-anywhere">{err}</span>}
    </div>
  );
}
