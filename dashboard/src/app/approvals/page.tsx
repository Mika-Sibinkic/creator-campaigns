// src/app/approvals/page.tsx
//
// Human-review approval inbox. The ONLY surface where a person clicks
// to approve a payment — and approval IS payment: the approve
// route auto-executes the payout server-side (one human gate, no second
// click), with the human approval recorded on the row and every spend cap
// re-checked before money moves.
//
// Server component for the list; client island for the Approve & pay / Reject
// buttons.
//
// SEC: the list is firm-scoped IN THE QUERY (src/lib/approvals-query.ts), not
// by RLS. requireSessionAndClient() returns the service-role client
// (auth.ts:160), which is RLS-inert, so migration 009's
// `payment_auth_select_own_firm` policy never applies here. This file used to
// filter on status alone and so showed every firm's pending payouts to any
// authenticated member; the "RLS-scoped to firm" note it carried was stale.

import { requireSessionAndClient } from '@/lib/auth';
import { doNotContactForApprovals, fetchPendingApprovals, lastSentForApprovals } from '@/lib/approvals-query';
import { lastSentNotice } from '@/lib/last-sent-offer';
import { doNotContactNotice } from '@/lib/do-not-contact-copy';
import { resolvePaymentMode, type PaymentMode } from '@/lib/stripe-isolated';
import { describeDeliverables, normalizeDeliverables } from '@/lib/deliverables';
import { legLabel, normalizeLeg } from '@/lib/payment-legs';
import { ApprovalActions } from './ApprovalActions';
import { AppShell } from '@/components/AppShell';
import { RLAffordance } from '@/components/RLAffordance';
import { AttentionCallout, EmptyState } from '@/components/page';
import { HandCoins } from 'lucide-react';

export const runtime = 'nodejs';

// Consequence line for the Approve & pay confirm dialog — resolved
// server-side (the client must never see payment env config directly).
//
// This disclosure belongs exactly where it is: on screen at the moment money
// moves. What changed is the language. Naming the payment mode ("Stripe TEST
// mode", "PayPal sandbox") told a record label which vendor and which
// environment we happen to be wired to; what they need to know is whether the
// creator ends up with the money. One sentence per mode, no vendor, no
// environment — and every mode is still enumerated so a new one has to make
// this call deliberately.
const MODE_NOTES: Record<PaymentMode, string> = {
  paper: 'This is a rehearsal. The creator will not actually be paid.',
  stripe_test: 'This is a rehearsal. The creator will not actually be paid.',
  paypal_sandbox: 'This is a rehearsal. The creator will not actually be paid.',
  stripe_live: 'This is real. The money leaves your account and reaches the creator.',
  paypal_live: 'This is real. The money leaves your account and reaches the creator.',
};

/** creator_offers.agreed_deliverables (jsonb) → one label-readable line, or ''
 *  when the deal carries none. Never guesses a package it can't read. */
function deliverablesFor(agreed: unknown): string {
  return describeDeliverables(normalizeDeliverables(agreed));
}

export default async function ApprovalsPage() {
  const { sb, session } = await requireSessionAndClient();

  // Pull pending rows + the negotiation context we need to render a card.
  // Scoped to session.firm_id — see the SEC note at the top of this file.
  const result = await fetchPendingApprovals(sb, session.firm_id);

  if (!result.ok) {
    // `message` on a query_failed is the raw Postgres error. It is the only
    // driver message rendered anywhere in src/app — it goes to the server log,
    // not to the label, and the sentence on screen answers the one question
    // this page raises: did anything get paid while it was broken?
    if (result.reason === 'query_failed') {
      console.error('[approvals] pending query failed', result.message);
    }
    return (
      <AppShell title="Approvals" width="medium">
        <div className="mx-auto w-full max-w-5xl px-4 pb-12 pt-6 sm:px-6 lg:px-8">
          <p className={result.reason === 'query_failed' ? 'text-destructive' : 'text-muted-foreground'}>
            {result.reason === 'query_failed'
              ? 'We couldn’t load your pending payments just now. Nothing was approved and nothing was paid. Try again in a moment.'
              : result.message}
          </p>
        </div>
      </AppShell>
    );
  }

  // Row shape lives with the query in src/lib/approvals-query.ts.
  const rows = result.rows;
  const modeNote = MODE_NOTES[resolvePaymentMode()];
  // Display only: "Creator opted out" on the card before anyone approves.
  // It changes no payment behaviour (src/lib/approvals-query.ts).
  const dnc = await doNotContactForApprovals(sb, session.firm_id, rows);
  // Display only: the last price the creator was actually sent, beside the
  // agreed amount, flagged when they differ.
  const lastSent = await lastSentForApprovals(sb, rows);

  return (
    <AppShell
      title="Approvals"
      width="medium"
      subtitle={
        rows.length > 0
          ? `${rows.length} payment${rows.length === 1 ? '' : 's'} waiting on you`
          : undefined
      }
    >
      <div className="mx-auto w-full max-w-5xl px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        {rows.length === 0 ? (
          <EmptyState title="Nothing is waiting on you">
            Deals the negotiator won&rsquo;t pay out on its own show up here for
            your approval.
          </EmptyState>
        ) : (
          // The consequence sentence is the loudest thing above the list: this
          // is the one page in the product where a click moves money.
          <AttentionCallout
            icon={HandCoins}
            className="mb-8"
            title="Approving pays the creator immediately"
          >
            There is no separate &ldquo;pay&rdquo; step afterwards. {modeNote}
          </AttentionCallout>
        )}

        <ul className="space-y-4">
          {rows.map((r) => {
            // A deal can carry a deposit and a balance, each approved on its own
            // (migration 055). The card leads with WHICH payment and how much, so
            // approving the deposit can never read as approving the whole deal.
            const leg = normalizeLeg(r.leg);
            const agreed = r.creator_offers.agreed_amount_usd;
            const optOut = doNotContactNotice(dnc.get(r.id));
            const sentNote = lastSentNotice(agreed ?? r.amount_usd, lastSent.get(r.id));
            const inf = r.creator_offers.campaign_influencers.influencer;
            return (
              <li key={r.id} className="rounded-lg border bg-card shadow-xs">
                <div className="flex flex-col gap-6 p-5 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <h2 className="text-base font-semibold text-foreground">@{inf.username}</h2>
                      <span className="text-meta text-muted-foreground">
                        {r.creator_offers.campaigns?.artist_name ?? 'Unknown campaign'}
                      </span>
                      {optOut && (
                        <span className="rounded bg-status-flagged px-1.5 py-0.5 text-xs font-medium text-status-flagged-fg">
                          {optOut.label}
                        </span>
                      )}
                    </div>
                    {optOut && (
                      <p className="mt-2 text-sm font-medium text-destructive">{optOut.detail}</p>
                    )}

                    {/* The money, at the size the money deserves. */}
                    <div className="mt-3 flex flex-wrap items-baseline gap-2">
                      <span className="text-kpi tabular-nums text-foreground">
                        ${r.amount_usd.toFixed(2)}
                      </span>
                      <span className="text-sm font-medium text-foreground">{legLabel(leg)}</span>
                      {leg !== 'full' && agreed != null && (
                        <span className="text-sm text-muted-foreground">
                          of ${Number(agreed).toFixed(2)} agreed
                        </span>
                      )}
                    </div>

                    <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr_auto_1fr]">
                      <dt className="text-muted-foreground">Agreed</dt>
                      <dd className="tabular-nums">
                        ${Number(agreed ?? r.amount_usd).toFixed(2)}{' '}
                        <span className="text-muted-foreground">
                          (ceiling ${r.creator_offers.ceiling_usd.toFixed(0)})
                        </span>
                        {sentNote && (
                          <span
                            className={`block text-xs ${sentNote.differs ? 'font-medium text-attention-fg' : 'text-muted-foreground'}`}
                            title={sentNote.detail ?? undefined}
                          >
                            {sentNote.text}
                            {sentNote.differs && '. Differs from the agreed amount, check the thread'}
                          </span>
                        )}
                      </dd>
                      <dt className="text-muted-foreground">Followers</dt>
                      <dd className="tabular-nums">{(inf.follower_count ?? 0).toLocaleString()}</dd>
                      {/* Approving pays immediately, so this card has to say what
                          the money buys. Without it the only question a human can
                          answer here is "is this number too big", not "is this
                          deal the deal we made". */}
                      <dt className="text-muted-foreground">Deliverables</dt>
                      <dd>
                        {deliverablesFor(r.creator_offers.agreed_deliverables) || (
                          <span className="text-attention-fg">
                            Not recorded. Check the thread before approving.
                          </span>
                        )}
                      </dd>
                      <dt className="text-muted-foreground">Engagement</dt>
                      <dd className="tabular-nums">
                        {((inf.engagement_rate ?? 0) * 100).toFixed(2)}%
                      </dd>
                      <dt className="text-muted-foreground">Contract</dt>
                      <dd>
                        {r.creator_offers.contract_generated_at ? (
                          'Sent with the acceptance email'
                        ) : (
                          <span className="text-attention-fg">None attached to this deal</span>
                        )}
                      </dd>
                      <dt className="text-muted-foreground">Rounds</dt>
                      <dd className="tabular-nums">{r.creator_offers.rounds}</dd>
                      <dt className="text-muted-foreground">Contact email</dt>
                      <dd className="break-all sm:col-span-3">
                        {inf.contact_email ?? (
                          <span className="text-destructive">Missing. Payment will fail.</span>
                        )}
                      </dd>
                    </dl>
                  </div>
                  <ApprovalActions
                    paymentAuthorizationId={r.id}
                    emailMissing={
                      !r.creator_offers.campaign_influencers.influencer.contact_email
                    }
                    amountUsd={r.amount_usd}
                    leg={leg}
                    username={r.creator_offers.campaign_influencers.influencer.username}
                    modeNote={modeNote}
                    blockedReason={r.payable ? null : r.blocked_reason}
                  />
                </div>
                {/* RLAffordance documents removing an internal acronym from the
                    a11y tree; this call site kept printing it on screen anyway. */}
                <div className="flex items-center gap-2 border-t px-5 py-2.5">
                  <span className="text-xs text-muted-foreground">Is this the right call?</span>
                  <RLAffordance
                    eventId={`payment_authorization:${r.id}`}
                    context={{
                      amount_usd: r.amount_usd,
                      ceiling_usd: r.creator_offers.ceiling_usd,
                      rounds: r.creator_offers.rounds,
                      campaign_id: r.creator_offers.campaigns?.id,
                    }}
                    size="xs"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </AppShell>
  );
}
