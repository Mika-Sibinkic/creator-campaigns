"use client";
// src/app/campaigns/[id]/deals/[ci_id]/thread/page.tsx
//
// Statuses dashboard — the per-creator conversation thread.
// Everything that ever happened with one creator on one campaign, on one
// vertical timeline: outbound emails/DMs (drafts, queued, sent, counters,
// acceptance + payout mails), inbound replies (classification + flag
// state), and system events (negotiation/payment audit rows + delivery
// facts). Read-only by design — actions stay on /campaigns/[id]/deals — with
// ONE exception: "Resume automation" on a deal a human has taken
// over lives here, because the price it asks for is the one in this thread.
//
// A route (not a drawer) so /anomalies rows can deep-link straight here.
// One left-aligned rail: messages are cards on it (inbound on a muted
// surface), system events are single quiet rows, so the eye reads straight
// down instead of zig-zagging through centred lines.

import { useCallback, useEffect, useState, use } from "react";
import { messageStatusLabel } from "@/lib/message-status";
import { Hand, Loader2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/StatusBadge";
import { useIsOperator } from "@/components/OperatorContext";
import { describeDealError } from "@/lib/deal-errors";
import { funnelClasses, funnelLabel } from "../../funnel-labels";
import type { ThreadEvent } from "@/lib/statuses";
import {
  MANUAL_MODE_DETAIL,
  MANUAL_MODE_LABEL,
  NEW_QUOTE_CONFIRM_LABEL,
  checkResumePrice,
  isHumanTakeover,
  lastQuotedLine,
  resumeNeedsNewQuote,
} from "@/lib/takeover-state";

interface ThreadResponse {
  ci: { id: string; username: string | null; display_name: string | null };
  offer: {
    id: string;
    status: string;
    injection_flagged: boolean;
    /** creator_offers.autonomy_mode ('human' = taken over). */
    autonomy_mode?: string | null;
    /** Manual mode, or a reply on this thread still held for a human. */
    manual?: boolean;
    agreed_amount_usd: number | null;
    current_offer_usd: number | null;
    /** The last STRUCTURED price sent (offer_usd); null = none on record. */
    last_sent_offer_usd?: number | null;
    ceiling_usd: number;
    rounds: number;
    /** The agreed package, one label-readable line. '' when the offer carries
     *  none (offers agreed before the agreement-time freeze). */
    deliverables_text: string;
    contract_sent: boolean;
  } | null;
  events: ThreadEvent[];
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "Unknown time";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

const SEND_MODE_LABELS: Record<string, string> = {
  auto_email: "sent automatically",
  computer_use: "sent by the assistant",
  human_queue: "sent by hand",
};

// outreach_messages.channel. Rendered raw, this line read
// "instagram_dm · payout_onboarding" — two machine values joined by a dot.
const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  instagram_dm: "Instagram DM",
  tiktok_dm: "TikTok DM",
};

function channelLabel(channel: string | null): string {
  if (!channel) return "";
  return CHANNEL_LABELS[channel] ?? channel.replace(/_/g, " ");
}

// outreach_messages.message_type, written raw by the generate, negotiation and
// payout paths.
const MESSAGE_TYPE_LABELS: Record<string, string> = {
  initial: "First message",
  follow_up: "Follow-up",
  negotiation: "Negotiation",
  counter: "Counter-offer",
  response: "Reply",
  agreement_confirmation: "Deal confirmation",
  holding_note: "Holding note",
  payout_onboarding: "Payment setup",
  promo_materials: "Promo materials",
  price_record: "Price you quoted outside Creator Campaigns (not sent)",
};

function messageTypeLabel(type: string | null): string {
  if (!type) return "";
  return MESSAGE_TYPE_LABELS[type] ?? type.replace(/_/g, " ");
}

// classifyResponse() output (src/lib/outreach.ts). This badge rendered the raw
// value, so a manager read "not_interested (82%)".
const CLASSIFICATION_LABELS: Record<string, string> = {
  interested: "Interested",
  not_interested: "Not interested",
  negotiating: "Negotiating",
  question: "Asked a question",
  unclear: "Unclear",
};

function classificationLabel(value: string): string {
  return CLASSIFICATION_LABELS[value] ?? value.replace(/_/g, " ");
}

/** A 0–1 classifier confidence in words. "82%" invites a precision the model
 *  does not have, and the number is only actionable as "trust this or check
 *  it". */
function confidenceNote(confidence: number | null): string | null {
  if (confidence == null) return null;
  if (confidence >= 0.75) return null;
  return confidence >= 0.45 ? "fairly sure" : "unsure, worth reading";
}

// audit_log.action for the rows src/lib/statuses.ts does not already turn into
// a sentence. summarizeAuditEvent() covers the negotiation and payment actions;
// these are the rest of what can land on a creator's timeline.
const SYSTEM_ACTION_LABELS: Record<string, string> = {
  "campaign.confirmed": "Campaign confirmed",
  "contract.not_attached": "No contract was attached",
  "delivery.pending": "Waiting for the post to appear",
  "delivery.verified": "Post found on their profile",
  "delivery.missing": "Post not found on their profile",
  "influencer.blocklist.update": "Creator blocked",
  "influencer.contact_email.update": "Contact email updated",
  "outcome.recorded": "Results recorded",
  "outreach.draft.create": "Draft written",
  "outreach.draft.refused": "Draft not written",
  "outreach.escalated": "Brought to you for a decision",
  "outreach.escalation_blocked": "Escalation held back",
  "outreach.respond.classify": "Reply read",
  "outreach.send": "Message sent",
  "outreach.send.failed": "Message could not be sent",
};

/** Our own tooling writing into a client-visible timeline. A label must never
 *  see "simulator.reply_inserted" — it is proof the reply was fabricated. */
function isOperatorOnlyAction(action: string): boolean {
  return action.startsWith("simulator.") || action.startsWith("system.cron.");
}

/** The sentence for a system row. `detail` is summarizeAuditEvent()'s output
 *  and always wins; the map covers what it returns null for; anything left
 *  de-snakes rather than showing a dotted enum. */
function systemLine(ev: Extract<ThreadEvent, { kind: "system" }>): string {
  if (ev.detail) return ev.detail;
  const mapped = SYSTEM_ACTION_LABELS[ev.action];
  if (mapped) return mapped;
  const tail = ev.action.includes(".")
    ? ev.action.slice(ev.action.indexOf(".") + 1)
    : ev.action;
  const words = tail.replace(/[._]/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Activity recorded";
}

/** A dot on the rail. Colour only where something broke. */
function RailDot({ tone = "quiet" }: { tone?: "quiet" | "strong" | "flagged" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -left-[1.6875rem] top-3.5 size-2 rounded-full ring-4 ring-background",
        tone === "flagged" ? "bg-destructive" : tone === "strong" ? "bg-foreground/60" : "bg-border",
      )}
    />
  );
}

function OutboundBubble({ ev }: { ev: Extract<ThreadEvent, { kind: "outbound" }> }) {
  const isOperator = useIsOperator();
  const meta = [channelLabel(ev.channel), messageTypeLabel(ev.message_type)].filter(Boolean).join(" · ");
  return (
    <li className="relative">
      <RailDot tone="strong" />
      <div className="rounded-lg border bg-background">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2 text-xs">
          <span className="font-medium text-foreground">You</span>
          {meta && <span className="text-muted-foreground">{meta}</span>}
          <span className="ml-auto flex items-center gap-2">
            {ev.send_mode && (
              <span className="text-faint">{SEND_MODE_LABELS[ev.send_mode] ?? ev.send_mode}</span>
            )}
            {ev.status === "sent" ? (
              <span className="tabular-nums text-muted-foreground">Sent {formatDateTime(ev.sent_at)}</span>
            ) : (
              <StatusBadge
                state="sourced"
                label={messageStatusLabel(ev.status).replace(/^./, (c) => c.toUpperCase())}
              />
            )}
          </span>
        </div>
        <div className="px-4 py-3">
          {/* In testing mode this address is the operator's test inbox, not the
              creator's. Who it went to is ours. */}
          {ev.sent_to && isOperator && (
            <div className="mb-1 break-all font-mono text-[11px] text-faint">to {ev.sent_to}</div>
          )}
          {ev.subject && <div className="text-sm font-medium text-foreground">{ev.subject}</div>}
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{ev.body}</p>
        </div>
      </div>
    </li>
  );
}

function InboundBubble({ ev }: { ev: Extract<ThreadEvent, { kind: "inbound" }> }) {
  const note = confidenceNote(ev.classification_confidence);
  return (
    <li className="relative">
      <RailDot tone={ev.flagged ? "flagged" : "strong"} />
      <div
        className={cn(
          "rounded-lg border",
          ev.flagged ? "border-destructive/40 bg-status-flagged/40" : "bg-muted/50",
        )}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2 text-xs">
          <span className="font-medium text-foreground">{ev.from_identity ?? "Creator"}</span>
          {ev.channel && <span className="text-muted-foreground">{channelLabel(ev.channel)}</span>}
          {ev.classification && (
            <StatusBadge
              state="sourced"
              label={`${classificationLabel(ev.classification)}${note ? `, ${note}` : ""}`}
            />
          )}
          {ev.flagged && <StatusBadge state="flagged" label="Flagged, held for review" />}
          <span className="ml-auto tabular-nums text-muted-foreground">{formatDateTime(ev.at)}</span>
        </div>
        <p className="whitespace-pre-wrap px-4 py-3 text-sm text-foreground">{ev.body}</p>
      </div>
    </li>
  );
}

function SystemLine({ ev }: { ev: Extract<ThreadEvent, { kind: "system" }> }) {
  const isOperator = useIsOperator();
  // `simulator.reply_inserted` on a client's timeline is us telling them the
  // reply above was fabricated, in a vocabulary they cannot read.
  if (isOperatorOnlyAction(ev.action) && !isOperator) return null;
  return (
    <li className="relative flex flex-wrap items-baseline gap-x-2 py-0.5 text-xs">
      <span
        aria-hidden
        className="absolute -left-[1.625rem] top-[0.4375rem] size-1.5 rounded-full bg-border ring-4 ring-background"
      />
      <span className="text-muted-foreground">{systemLine(ev)}</span>
      {isOperator && <span className="font-mono text-faint">{ev.action}</span>}
      <span className="ml-auto tabular-nums text-faint">{formatDateTime(ev.at)}</span>
    </li>
  );
}

/**
 * Manual mode. An escalation took this deal over: nothing is agreed
 * or countered automatically. Resuming needs the price last quoted to the
 * creator, confirmed, because automation will agree at exactly that number.
 */
function ManualModePanel({
  campaignId,
  offer,
  onResumed,
}: {
  campaignId: string;
  offer: NonNullable<ThreadResponse["offer"]>;
  onResumed: () => void;
}) {
  // Prefilled from the last price ON RECORD (structured offer_usd),
  // never from the standing offer, which can be an unsent draft's number.
  const lastSent = offer.last_sent_offer_usd ?? null;
  const [price, setPrice] = useState(lastSent != null ? String(lastSent) : "");
  const [confirmed, setConfirmed] = useState(false);
  const [quotedNew, setQuotedNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const negotiable = offer.status === "offered" || offer.status === "counter_offered";
  const check = checkResumePrice(price, offer.ceiling_usd);
  const needsNewQuote = check.ok && resumeNeedsNewQuote(check.usd, lastSent);

  async function resume() {
    if (!check.ok) {
      setMessage(check.message);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch(`/api/campaigns/${campaignId}/deals/${offer.id}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ price_usd: check.usd, confirm: confirmed, quoted_new: needsNewQuote && quotedNew }),
      });
      const body = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!r.ok) {
        setMessage(body.message ?? describeDealError(body, r.status));
        return;
      }
      onResumed();
    } catch {
      setMessage(describeDealError(null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="status" className="space-y-3 rounded-lg border border-attention-border bg-attention px-4 py-3.5">
        <div className="flex items-start gap-3">
          <Hand className="mt-0.5 size-4 shrink-0 text-attention-fg" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{MANUAL_MODE_LABEL}</p>
            <p className="mt-0.5 text-meta text-muted-foreground">{MANUAL_MODE_DETAIL}</p>
          </div>
        </div>
        {negotiable ? (
          <div className="space-y-2">
            <p className="text-sm">{lastQuotedLine(lastSent)}</p>
            <label className="block text-sm font-medium" htmlFor="resume-price">
              The price you last quoted this creator
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">$</span>
              <input
                id="resume-price"
                inputMode="decimal"
                className="h-8 w-32 rounded-md border border-input bg-background px-2 text-sm tabular-nums"
                value={price}
                onChange={(e) => {
                  setPrice(e.target.value);
                  setConfirmed(false);
                  setQuotedNew(false);
                }}
              />
              <span className="text-xs text-muted-foreground">
                your limit ${offer.ceiling_usd.toFixed(0)}
              </span>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                disabled={!check.ok}
              />
              <span>
                {check.ok
                  ? `$${check.usd} is the last price I quoted. If they say yes, automation will agree at $${check.usd}.`
                  : "Enter the price first."}
              </span>
            </label>
            {needsNewQuote && check.ok && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={quotedNew}
                  onChange={(e) => setQuotedNew(e.target.checked)}
                />
                <span>
                  {NEW_QUOTE_CONFIRM_LABEL} (${check.usd}).{" "}
                  {lastSent != null
                    ? `It differs from the $${lastSent} on record.`
                    : "Nothing on record quoted a price."}
                </span>
              </label>
            )}
            <button
              type="button"
              className={buttonVariants({ size: "sm" })}
              disabled={busy || !check.ok || !confirmed || (needsNewQuote && !quotedNew)}
              onClick={() => void resume()}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Resume automation
            </button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            This deal is no longer being negotiated, so there is nothing to resume.
          </p>
        )}
        {message && <p className="text-sm text-destructive">{message}</p>}
    </div>
  );
}

export default function ThreadPage({
  params,
}: {
  params: Promise<{ id: string; ci_id: string }>;
}) {
  const { id, ci_id } = use(params);
  const [data, setData] = useState<ThreadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/campaigns/${id}/statuses?ci=${ci_id}`, {
        cache: "no-store",
      });
      if (!r.ok) {
        // This used to build `HTTP 500` by hand, or echo the route's raw slug,
        // and render it as "Error loading thread: HTTP 500". The sibling deals
        // page already routes every failure through one mapper; so does this.
        const txt = await r.text();
        let parsed: { error?: string; message?: string } | null = null;
        try {
          parsed = txt ? (JSON.parse(txt) as { error?: string }) : null;
        } catch {
          /* not JSON */
        }
        console.error(
          `[thread] GET /api/campaigns/${id}/statuses?ci=${ci_id} → HTTP ${r.status}`,
          parsed
        );
        throw new Error(describeDealError(parsed, r.status));
      }
      setData((await r.json()) as ThreadResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : describeDealError(null));
    }
  }, [id, ci_id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const title = data?.ci.username ? `@${data.ci.username}` : "Thread";
  const offer = data?.offer ?? null;
  const meta = offer
    ? [
        offer.agreed_amount_usd != null
          ? `Agreed $${offer.agreed_amount_usd.toFixed(2)}`
          : offer.current_offer_usd != null
            ? `Standing offer $${offer.current_offer_usd.toFixed(2)}`
            : null,
        `Your limit $${offer.ceiling_usd.toFixed(0)}`,
        `${offer.rounds} round${offer.rounds === 1 ? "" : "s"}`,
        // What the money buys. A price with no statement of what was promised
        // is half a deal.
        offer.deliverables_text ? `For ${offer.deliverables_text}` : "Deliverables not recorded on this deal",
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;

  return (
    <AppShell
      title={title}
      back={{ href: `/campaigns/${id}/deals`, label: "Deals" }}
      badge={
        offer ? (
          <span className="flex items-center gap-2">
            {/* funnelLabel, never the raw status: a manager must not read
                `human_approval_required` off their own deal. */}
            <Badge variant="outline" className={funnelClasses(offer.status)}>
              {funnelLabel(offer.status)}
            </Badge>
            {offer.injection_flagged && <StatusBadge state="flagged" label="Injection flagged" />}
          </span>
        ) : undefined
      }
      subtitle={meta}
      width="narrow"
    >
      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        {offer && (offer.manual || isHumanTakeover(offer)) && (
          <ManualModePanel campaignId={id} offer={offer} onResumed={() => void load()} />
        )}

        {error && <EmptyState title={<span className="text-destructive">{error}</span>} />}

        {!error && data === null && (
          <div className="space-y-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-28 w-full" />
          </div>
        )}

        {data !== null && data.events.length === 0 && (
          <EmptyState title="Nothing has happened with this creator yet">
            Drafts, sent messages, replies and negotiation events appear here in
            order the moment they exist.
          </EmptyState>
        )}

        {data !== null && data.events.length > 0 && (
          <ol className="ml-2 space-y-3 border-l pl-6">
            {data.events.map((ev) =>
              ev.kind === "outbound" ? (
                <OutboundBubble key={ev.id} ev={ev} />
              ) : ev.kind === "inbound" ? (
                <InboundBubble key={ev.id} ev={ev} />
              ) : (
                <SystemLine key={ev.id} ev={ev} />
              )
            )}
          </ol>
        )}
      </div>
    </AppShell>
  );
}
