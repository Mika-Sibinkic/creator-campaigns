'use client';
// src/app/approvals/ApprovalActions.tsx
//
// Client island for the Approve & pay / Reject buttons. Calls
// /api/payments/[id]/{approve,reject} with credentials + Origin header
// (CSRF-safe). On a clean payout it reloads so the row drops out of the inbox.
//
// Approval IS payment — the approve route auto-executes the payout
// server-side, so the confirmation states the money consequence before the one
// and only human click.
//
// Label-facing pass:
//   - The rejection reason came from window.prompt() and the payout was gated
//     by TWO stacked window.confirm()s. Browser modals are unstyled, unbranded
//     and block automation. Both are now real dialogs, and the two confirms are
//     ONE: the missing-email warning is a line inside the single payout
//     confirmation rather than a separate click to dismiss. The guard is not
//     weaker — it is the same deliberate stop, said once.
//   - Colors came off the raw Tailwind palette (bg-emerald-600, border-zinc-700,
//     text-red-400, and -200/-300 foregrounds that only work in dark mode on a
//     page with a light-mode toggle). Everything here now wears design tokens.
//   - `reason:` and `provider:` were rendered as mono machine text. A label
//     gets the written sentence; the provider's verbatim prose is kept for
//     whoever operates the product.
//
// Silent-failure fix (unchanged): the approve route answers 207 with
// `payout: { ok: false, reason, guidance, raw_error }` when the approval
// committed but the payout did NOT go out. 207 is still 2xx, so an `if (!r.ok)`
// check would treat it as success and reload — the row then vanishes from the
// inbox (it no longer matches status='pending_human_review') and the person is
// shown nothing. We read the body and, on anything other than a settled payout,
// hold the row on screen with the reason in place.

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { OperatorOnly } from '@/components/OperatorContext';
import { describeDealError, describeFailureReason } from '@/lib/deal-errors';
import type { PayoutSummary } from '@/lib/payout-surfacing';
import { legLabel, type SettlementLeg } from '@/lib/payment-legs';

interface Props {
  paymentAuthorizationId: string;
  emailMissing: boolean;
  /** Payout amount shown in the confirmation — this leg's amount. */
  amountUsd: number;
  /** Which settlement leg this approval pays (deposit | balance | full). */
  leg: SettlementLeg;
  /** Creator handle shown in the confirmation. */
  username: string;
  /** Server-resolved consequence line: whether the creator actually ends up
   *  with this money. Resolved server-side so the client never sees payment
   *  env config. */
  modeNote: string;
  /**
   * Set when the deal is closed for this leg (approvals-query.ts `payable:
   * false`). The server refuses the approval with 409 in that case, so the
   * Approve button is not rendered at all — only Reject, which clears the row.
   */
  blockedReason?: string | null;
}

export function ApprovalActions({
  paymentAuthorizationId,
  emailMissing,
  amountUsd,
  leg,
  username,
  modeNote,
  blockedReason = null,
}: Props) {
  const [busy, setBusy] = useState<'approve' | 'reject' | 'stop' | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  // Set once the approval has committed. Holds the row on screen with the
  // payout outcome rather than reloading it out of existence.
  const [payout, setPayout] = useState<PayoutSummary | null>(null);

  const amount = `$${amountUsd.toFixed(2)}`;
  // Every button and dialog names the leg, so the deposit and the balance of
  // one deal can never be mistaken for each other or for the whole deal.
  const legName = legLabel(leg).toLowerCase();
  const what = leg === 'full' ? amount : `${legName} ${amount}`;
  const payment = leg === 'full' ? `${amount} payment` : `${amount} ${legName}`;

  async function approve() {
    setConfirmOpen(false);
    setBusy('approve');
    setErr(null);
    try {
      const r = await fetch(
        `/api/payments/${paymentAuthorizationId}/approve`,
        { method: 'POST', headers: { 'content-type': 'application/json' } }
      );
      const body = (await r.json().catch(() => null)) as
        | { payout?: PayoutSummary; error?: string; message?: string; guidance?: string }
        | null;
      // A real HTTP error means the approval itself did not commit.
      if (!r.ok) throw new Error(describeDealError(body, r.status));
      const summary = body?.payout ?? null;
      // Fail closed: a 2xx with no payout envelope (or a payout that did not
      // settle) must NOT reload the row out of the inbox unexplained.
      if (!summary) {
        setPayout({
          ok: false,
          status: 'failed',
          http_status: r.status,
          reason: 'no_payout_result',
          guidance:
            'Approved, but the server did not report a payout outcome. Check the campaign Deals page before retrying. Do not approve again.',
          raw_error: null,
          provider_id: null,
          payment_mode: null,
        });
        setBusy(null);
        return;
      }
      if (summary.ok && summary.status === 'paid') {
        window.location.reload();
        return;
      }
      setPayout(summary);
      setBusy(null);
    } catch (e) {
      setErr(
        e instanceof Error && e.message
          ? e.message
          : describeDealError(null)
      );
      setBusy(null);
    }
  }

  async function reject() {
    const reason = rejectReason.trim();
    setRejectOpen(false);
    setBusy('reject');
    setErr(null);
    try {
      const r = await fetch(
        `/api/payments/${paymentAuthorizationId}/reject`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason }),
        }
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as
          | { error?: string; message?: string; guidance?: string }
          | null;
        throw new Error(describeDealError(body, r.status));
      }
      window.location.reload();
    } catch (e) {
      setErr(
        e instanceof Error && e.message ? e.message : describeDealError(null)
      );
      setBusy(null);
    }
  }

  // Revoke an approval whose payout has not started — the same reject route,
  // which accepts 'approved' only while nothing has been sent.
  async function stopPayment() {
    setStopOpen(false);
    setBusy('stop');
    setErr(null);
    try {
      const r = await fetch(
        `/api/payments/${paymentAuthorizationId}/reject`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as
          | { error?: string; message?: string; guidance?: string }
          | null;
        throw new Error(describeDealError(body, r.status));
      }
      window.location.reload();
    } catch (e) {
      setErr(
        e instanceof Error && e.message ? e.message : describeDealError(null)
      );
      setBusy(null);
    }
  }

  // The approval has committed — approving again can only 409, so the buttons
  // are gone and the outcome stays on screen until it is dismissed.
  if (payout) {
    const failed = !payout.ok;
    // Approved, waiting on the creator's payout setup: the Stripe webhook pays
    // it automatically the moment they finish, so this is the last point a
    // person can still say no.
    const stoppable = payout.status === 'awaiting_onboarding';
    // guidance is already written for a person (payout-surfacing.ts bakes it
    // in). Without one, the stored slug goes through the house mapper rather
    // than onto the screen.
    const explanation =
      payout.guidance?.trim() || describeFailureReason(payout.reason);
    return (
      <div
        role="status"
        aria-live="polite"
        className={`flex max-w-sm flex-col gap-2 rounded-md border p-3 text-sm ${
          failed
            ? 'border-destructive/50 bg-destructive/10 text-destructive'
            : 'border-attention-border bg-attention text-attention-fg'
        }`}
      >
        <span className="font-medium">
          {failed
            ? 'Approved, but the payment did not go out. No money moved.'
            : 'Approved. The payment is not final yet.'}
        </span>
        {explanation && (
          <span className="text-foreground/80">{explanation}</span>
        )}
        {/* The provider's verbatim prose is kept, not shown to the label. */}
        <OperatorOnly>
          {payout.reason && (
            <span className="font-mono text-xs opacity-70">
              reason: {payout.reason}
            </span>
          )}
          {payout.raw_error && payout.raw_error !== payout.guidance && (
            <span className="font-mono text-xs break-words opacity-70">
              provider: {payout.raw_error}
            </span>
          )}
        </OperatorOnly>
        {stoppable && (
          <span className="text-foreground/80">
            It sends automatically once @{username} finishes payout setup.
          </span>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.location.reload()}
            disabled={busy !== null}
          >
            Dismiss &amp; refresh
          </Button>
          {stoppable && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setStopOpen(true)}
              disabled={busy !== null}
            >
              {busy === 'stop' ? 'Stopping…' : 'Stop this payment'}
            </Button>
          )}
        </div>
        {err && <span className="text-destructive">{err}</span>}

        <Dialog open={stopOpen} onOpenChange={setStopOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Stop the {payment} to @{username}?</DialogTitle>
              <DialogDescription>
                Nothing has been sent yet. Stopping it cancels the approval, so
                @{username} is not paid when they finish payout setup. The deal
                closes too, unless part of it is already paid, in which case
                it stays open and what was paid still counts against the budget.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>
                Keep it
              </DialogClose>
              <Button variant="destructive" onClick={() => void stopPayment()}>
                Stop payment
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-stretch gap-2 text-sm sm:w-56">
      {blockedReason ? (
        <p className="max-w-xs rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
          {blockedReason}
        </p>
      ) : (
        // The page's one primary action, at full size.
        <Button
          size="lg"
          onClick={() => setConfirmOpen(true)}
          disabled={busy !== null}
        >
          {busy === 'approve' ? 'Approving & paying…' : `Approve & pay ${what}`}
        </Button>
      )}
      <Button
        variant="ghost"
        onClick={() => setRejectOpen(true)}
        disabled={busy !== null}
      >
        {busy === 'reject' ? 'Rejecting…' : 'Reject'}
      </Button>
      {err && <span className="text-destructive">{err}</span>}

      {/* The one deliberate stop before money moves. */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {leg === 'full'
                ? `Pay @${username} ${amount} now?`
                : `Pay @${username} the ${legName} of ${amount} now?`}
            </DialogTitle>
            <DialogDescription>
              This is the only confirmation. The payment goes out as soon as you
              approve. There is no second click. {modeNote}
            </DialogDescription>
          </DialogHeader>
          {emailMissing && (
            <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              This creator has no contact email on file, so the payment will
              fail straight after you approve it. Add their email first unless
              you have a reason not to.
            </p>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button onClick={() => void approve()}>Yes, pay {what}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Reject the {payment} to @{username}?
            </DialogTitle>
            <DialogDescription>
              No money moves. @{username} is not paid, and the deal stays on the
              campaign so you can come back to it.
            </DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">
              Why? Optional, saved on the deal.
            </span>
            <Textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g. asking too much for one reel"
              rows={3}
            />
          </label>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button variant="destructive" onClick={() => void reject()}>
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
