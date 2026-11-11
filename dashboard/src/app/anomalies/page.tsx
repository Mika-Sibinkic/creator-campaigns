"use client";
// src/app/anomalies/page.tsx
//
// The "needs human eyes" surface — one rollup of everything in the
// workspace that is waiting on a person, each row deep-linking to where the
// work gets done.
//
// Label-facing pass:
//   - Five of the twelve lanes were ours, not the label's: Injection, Flagged
//     reply, Fishy reply, Spec fail and Loop stalled. They told a record label
//     that the product is prompt-injectable, that replies trip safety
//     classifiers, and that a cron has stopped beating. All five are now
//     operator-only, from both the tab row AND the row list — hiding a tab
//     while "All" still listed its rows would have been theatre.
//   - A lane with nothing in it is no longer a tab for a label. Twelve tabs
//     over two rows, eleven of them permanently reading 0, is the page telling
//     you about itself instead of about your campaigns.
//   - Every lane has a named primary action instead of one ghost link. None of
//     them needs a new endpoint: each is the page where that specific problem
//     is actually fixed.
//
// Layout mirrors /outreach: line Tabs used as a filter control (no
// TabsContent) over one bordered list. Badge colour follows the status rule:
// red where something broke, amber where a person must decide, neutral else.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Loader2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useIsOperator } from "@/components/OperatorContext";
import { EmptyState } from "@/components/page";
import { StatusBadge, type AtsStatus } from "@/components/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button, buttonVariants } from "@/components/ui/button";
import { toast } from "sonner";
import {
  OPERATOR_ONLY_ANOMALY_CATEGORIES,
  anomalyDetailFor,
  resolveOptionsFor,
  type AnomalyCategory,
  type AnomalyRow,
} from "@/lib/statuses";

// Category → label + badge tone. Red = abuse or money went wrong; amber = a
// person has to decide; neutral = follow-ups and bookkeeping gaps.
const CATEGORY_META: Record<
  AnomalyCategory,
  { label: string; tone: AtsStatus; empty: string }
> = {
  injection_flagged: {
    label: "Injection",
    tone: "flagged",
    empty:
      "No prompt-injection attempts flagged. The injection guard marks offers here the moment a creator reply tries to steer the negotiator.",
  },
  flagged_inbound: {
    label: "Flagged reply",
    tone: "flagged",
    empty:
      "No replies in the flagged lane. Replies land here when the negotiator refuses to act on them automatically.",
  },
  fishy_reply: {
    label: "Fishy reply",
    tone: "sourced",
    empty:
      "No replies are being held. Anything the system cannot confidently read is parked here for a person to look at.",
  },
  needs_decision: {
    label: "Needs a decision",
    tone: "reply",
    empty:
      "Nothing is waiting on a decision. When a creator proposes work outside a campaign's deal scope, or asks a question, the negotiator stops and puts it here instead of answering for you.",
  },
  payment_failed: {
    label: "Payment failed",
    tone: "flagged",
    empty:
      "No failed payments. Payments that fail, or that get stopped by a spending cap, show up here with the reason.",
  },
  delivery_spec_failed: {
    label: "Spec fail",
    tone: "sourced",
    empty:
      "No deliveries failing the spec check. Posts that don't match the agreed deliverables land here after measurement.",
  },
  stalled_negotiation: {
    label: "Stalled",
    tone: "sourced",
    empty:
      "No stalled negotiations. Deals waiting on a creator reply, or on an answer to their counter-offer, for more than 7 days show up here.",
  },
  unmatched_inbound: {
    label: "Unmatched",
    tone: "sourced",
    empty:
      "No unmatched replies. Inbound mail that can't be tied to a creator queues here so it never disappears silently.",
  },
  contract_missing: {
    label: "No contract",
    tone: "sourced",
    empty:
      "Every closed deal has a contract on it. Deals that closed with no agreement terms attached show up here.",
  },
  bounced_email: {
    label: "Bounced",
    tone: "flagged",
    empty:
      "No outreach has bounced. Emails that never reached a creator (a dead address, or one that marked us as spam) show up here so the lead gets fixed or dropped.",
  },
  stalled_tick: {
    label: "Loop stalled",
    tone: "flagged",
    empty:
      "The negotiation loop is running on schedule. If it stops, this lane says so. While it is stopped, no counter-offers go out and no replies get read.",
  },
  payment_anomaly: {
    label: "Money path",
    tone: "flagged",
    empty:
      "Nothing odd on the money path. Approved payouts held by a cap or a failed transfer, payments stuck mid-send or reclaimed, and creator bank payouts that bounced all show up here.",
  },
};

const TAB_ORDER: ("all" | AnomalyCategory)[] = [
  "all",
  "injection_flagged",
  "flagged_inbound",
  "fishy_reply",
  "needs_decision",
  "payment_failed",
  "delivery_spec_failed",
  "stalled_negotiation",
  "unmatched_inbound",
  "contract_missing",
  "bounced_email",
  "stalled_tick",
  "payment_anomaly",
];

/** Never put a driver/Postgres message on screen — /api/anomalies returns the
 *  raw error.message from seven places. Detail goes to the console instead. */
const LOAD_ERROR = "Could not load what needs your attention. Try again in a moment.";

/** toLocaleString() on an unparseable date returns the literal string
 *  "Invalid Date" rather than throwing, so a NaN check is the real guard. */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown time";
  return d.toLocaleString();
}

/**
 * The one thing to do about this row, and where it gets done.
 *
 * No new endpoint behind any of these — each is the existing page where that
 * problem is actually fixed. A bounced address is edited inline on the deals
 * page; a missing contract is a template in settings; everything creator-side
 * is answered in the thread. `null` only when the row has no route at all,
 * and then the card says so rather than showing a dead control.
 */
function primaryAction(
  r: AnomalyRow,
): { label: string; href: string } | null {
  const thread =
    r.campaign_id && r.campaign_influencer_id
      ? `/campaigns/${r.campaign_id}/deals/${r.campaign_influencer_id}/thread`
      : null;
  const deals = r.campaign_id ? `/campaigns/${r.campaign_id}/deals` : null;

  switch (r.category) {
    case "contract_missing":
      return { label: "Set up your contract template", href: "/settings" };
    case "bounced_email":
      return deals ? { label: "Fix the contact email", href: deals } : null;
    case "payment_failed":
    case "payment_anomaly":
      return deals ? { label: "Open the deal", href: deals } : null;
    case "needs_decision":
      return thread ? { label: "Answer this", href: thread } : null;
    case "stalled_negotiation":
      return thread ? { label: "Nudge or close this", href: thread } : null;
    case "delivery_spec_failed":
      return thread ? { label: "Check what was delivered", href: thread } : null;
    default:
      return thread ? { label: "Open the thread", href: thread } : null;
  }
}

/** `who` on the unmatched lane is the raw sender identity. With testing mode
 *  on, that is our own inbox. Keep the domain — which is the part that helps
 *  a label recognise the sender — and drop the mailbox. */
function whoFor(r: AnomalyRow, isOperator: boolean): string {
  const who = r.who;
  if (!who) return "Unattributed";
  if (isOperator || !who.includes("@")) return who;
  const domain = who.slice(who.lastIndexOf("@") + 1);
  return domain ? `Someone at ${domain}` : "Unattributed";
}

export default function AnomaliesPage() {
  const isOperator = useIsOperator();
  const [rows, setRows] = useState<AnomalyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"all" | AnomalyCategory>("all");
  const [resending, setResending] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [minting, setMinting] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/anomalies", { cache: "no-store" });
      if (!r.ok) {
        const txt = await r.text();
        console.error("[anomalies] load failed", r.status, txt);
        throw new Error(LOAD_ERROR);
      }
      const json = (await r.json()) as { anomalies: AnomalyRow[] };
      setRows(Array.isArray(json.anomalies) ? json.anomalies : []);
      setError(null);
    } catch (e) {
      console.error("[anomalies] load failed", e);
      setError(LOAD_ERROR);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Operator-only: re-run a promo pack that was held because the label's
  // do-not-contact list could not be read. The server re-checks the list and
  // refuses a second send; every outcome is said out loud.
  async function resendPromo(offerId: string) {
    setResending(offerId);
    try {
      const res = await fetch("/api/anomalies/promo-resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offer_id: offerId }),
      });
      let body: { message?: string; error?: string } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        /* not JSON */
      }
      if (res.ok) toast.success("Promo pack sent.");
      else if (res.status === 429) toast.error("Rate limited. Try again in a minute.");
      else toast.error(body.message ?? body.error ?? "Couldn't resend the promo pack.");
    } catch {
      toast.error("Network error. Nothing was confirmed sent. Reload before retrying.");
    } finally {
      setResending(null);
      await load();
    }
  }

  // Operator-only: resolve a payment whose outcome is unknown by asking Stripe
  // whether the transfer exists. Read-only at Stripe; never re-sends. The
  // server answers completed / not sent (Retry is then safe) / still unknown.
  async function checkWithStripe(paymentId: string) {
    setChecking(paymentId);
    try {
      const res = await fetch("/api/anomalies/stripe-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payment_authorization_id: paymentId }),
      });
      let body: { outcome?: string; message?: string; error?: string } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        /* not JSON */
      }
      if (res.status === 429) toast.error("Rate limited. Try again in a minute.");
      else if (body.message) (res.ok ? toast.success : toast.error)(body.message);
      else toast.error(body.error ?? "Couldn't check with Stripe.");
    } catch {
      toast.error("Network error. Nothing changed. Try again.");
    } finally {
      setChecking(null);
      await load();
    }
  }

  // Operator-only: re-create the payment a deal is waiting on when the
  // automatic mint failed. Lands in /approvals; nothing is paid without an
  // approval there.
  async function mintPayment(offerId: string) {
    setMinting(offerId);
    try {
      const res = await fetch("/api/payments/remint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offer_id: offerId }),
      });
      let body: { guidance?: string; error?: string } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        /* not JSON */
      }
      if (res.ok) toast.success("Payment created. It is waiting in Approvals.");
      else if (res.status === 429) toast.error("Rate limited. Try again in a minute.");
      else toast.error(body.guidance ?? body.error ?? "Couldn't create the payment.");
    } catch {
      toast.error("Network error. Nothing was confirmed. Reload before retrying.");
    } finally {
      setMinting(null);
      await load();
    }
  }

  // Take a held reply, an injection flag or an escalation off this
  // page. "Process normally" sends a held reply back to the negotiator; the
  // server refuses it while a person has the thread in manual mode.
  async function resolveRow(ref: string, action: "reviewed" | "process_normally") {
    setResolving(ref);
    try {
      const res = await fetch("/api/anomalies/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref, action }),
      });
      let body: { message?: string; error?: string } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        /* not JSON */
      }
      if (res.ok) toast.success(body.message ?? "Resolved.");
      else if (res.status === 429) toast.error("Rate limited. Try again in a minute.");
      else toast.error(body.message ?? body.error ?? "Couldn't resolve this item.");
    } catch {
      toast.error("Network error. Nothing changed. Try again.");
    } finally {
      setResolving(null);
      await load();
    }
  }

  // Operator-only lanes are filtered out of the DATA, not just the tab row —
  // otherwise "All" would still list every one of them.
  const allowed = (rows ?? []).filter(
    (r) => isOperator || !OPERATOR_ONLY_ANOMALY_CATEGORIES.includes(r.category),
  );

  const counts = new Map<AnomalyCategory, number>();
  for (const r of allowed) {
    counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  }

  // Operators keep the full lane list — a lane at zero is a useful "this is
  // not the problem" for us. A label gets only lanes that have something in
  // them, so the page is about their campaigns rather than about itself.
  const tabs = TAB_ORDER.filter((t) => {
    if (t === "all") return true;
    if (!isOperator && OPERATOR_ONLY_ANOMALY_CATEGORIES.includes(t)) return false;
    return isOperator || (counts.get(t) ?? 0) > 0;
  });

  // A tab that vanished (or a lane that emptied) must not leave the filter
  // pointing at nothing.
  const activeTab = tabs.includes(tab) ? tab : "all";
  const visible = allowed.filter((r) => activeTab === "all" || r.category === activeTab);
  const showStallRule = visible.some((r) => r.category === "stalled_negotiation");

  const metaLine =
    allowed.length > 0
      ? `${allowed.length} open item${allowed.length === 1 ? "" : "s"}, newest first` +
        (showStallRule ? ". A negotiation counts as stalled after 7 quiet days." : "")
      : undefined;

  return (
    <AppShell title="Needs attention" subtitle={metaLine} width="default">
      <div className="mx-auto w-full max-w-6xl px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        {error && (
          <EmptyState
            title={<span className="text-destructive">{error}</span>}
            action={
              <button
                type="button"
                onClick={() => void load()}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Try again
              </button>
            }
          />
        )}

        {!error && rows === null && (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        )}

        {rows !== null && (
          <>
            {/* One tab is not a filter. With nothing outstanding the empty
                state below is the whole page. */}
            {tabs.length > 1 && (
              <Tabs
                value={activeTab}
                onValueChange={(v) => setTab(v as "all" | AnomalyCategory)}
                className="mb-4 border-b"
              >
                <TabsList
                  variant="line"
                  className="flex-wrap justify-start gap-x-4 gap-y-2 p-0 group-data-horizontal/tabs:h-auto"
                >
                  {tabs.map((t) => {
                    const n = t === "all" ? allowed.length : (counts.get(t) ?? 0);
                    return (
                      <TabsTrigger key={t} value={t} className="h-9 flex-none px-0">
                        {t === "all" ? "All" : CATEGORY_META[t].label}
                        <span className="text-xs font-normal tabular-nums text-faint">{n}</span>
                      </TabsTrigger>
                    );
                  })}
                </TabsList>
              </Tabs>
            )}

            {visible.length === 0 && (
              <EmptyState title={activeTab === "all" ? "Nothing needs you right now" : "Nothing here"}>
                {activeTab === "all"
                  ? "Decisions the negotiator won't make for you, failed payments, bounced outreach and deals closed without a contract all surface here the moment they happen."
                  : CATEGORY_META[activeTab].empty}
              </EmptyState>
            )}

            {visible.length > 0 && (
              <ul className="divide-y overflow-hidden rounded-lg border">
                {visible.map((r) => {
                  const meta = CATEGORY_META[r.category];
                  const action = primaryAction(r);
                  const detail = anomalyDetailFor(r, isOperator);
                  const resolveOpts = resolveOptionsFor(r);
                  return (
                    <li key={r.ref} className="flex items-start justify-between gap-4 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge state={meta.tone} label={meta.label} />
                          <span className="text-sm font-medium text-foreground">{r.what}</span>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {whoFor(r, isOperator)}
                          {r.campaign_name ? ` · ${r.campaign_name}` : ""}
                          {" · "}
                          <span className="tabular-nums">{formatDateTime(r.at)}</span>
                        </div>
                        {detail && (
                          <p className="mt-1.5 break-words text-meta text-muted-foreground">
                            {detail}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                        {isOperator && r.resend_promo_offer_id && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={resending !== null}
                            onClick={() => void resendPromo(r.resend_promo_offer_id as string)}
                          >
                            {resending === r.resend_promo_offer_id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              "Resend promo pack"
                            )}
                          </Button>
                        )}
                        {isOperator && r.mint_payment_offer_id && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={minting !== null}
                            onClick={() => void mintPayment(r.mint_payment_offer_id as string)}
                          >
                            {minting === r.mint_payment_offer_id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              "Create payment for approval"
                            )}
                          </Button>
                        )}
                        {isOperator && r.check_stripe_payment_id && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={checking !== null}
                            onClick={() => void checkWithStripe(r.check_stripe_payment_id as string)}
                          >
                            {checking === r.check_stripe_payment_id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              "Check with Stripe"
                            )}
                          </Button>
                        )}
                        {resolveOpts.processNormally && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={resolving !== null}
                            title="Send this reply back to the negotiator. Refused while you are handling the deal yourself."
                            onClick={() => void resolveRow(r.ref, "process_normally")}
                          >
                            {resolving === r.ref ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              "Process normally"
                            )}
                          </Button>
                        )}
                        {resolveOpts.reviewed && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={resolving !== null}
                            title="You dealt with this. It leaves this page; nothing is sent or negotiated."
                            onClick={() => void resolveRow(r.ref, "reviewed")}
                          >
                            {resolving === r.ref ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              "Mark reviewed"
                            )}
                          </Button>
                        )}
                        {action ? (
                          <Link
                            href={action.href}
                            className={buttonVariants({
                              variant: "ghost",
                              size: "sm",
                              className: "text-foreground",
                            })}
                          >
                            {action.label}
                            <ChevronRight className="size-3.5 text-faint" />
                          </Link>
                        ) : (
                          <span className="text-xs text-faint">Nowhere to open yet</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
