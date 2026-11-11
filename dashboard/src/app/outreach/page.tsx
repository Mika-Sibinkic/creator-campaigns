"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useCallback } from "react";
import { AppShell } from "@/components/AppShell";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Send,
  Copy,
  Check,
  Loader2,
  Sparkles,
  Search,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  MessageCircle,
} from "lucide-react";
import { toast } from "sonner";
import type { Campaign } from "@/lib/supabase";
import {
  bulkSendConfirmCopy,
  classifySendResponse,
  describeSendPace,
  emptyTally,
  planSendSchedule,
  sendModeFromTestingMode,
  sendModeLabel,
  summarizeSendTally,
  tallyOutcome,
  type SendMode,
  type SendTally,
} from "@/lib/outreach-send-copy";
import {
  isNoMessageYet,
  outreachStatusLabel,
  outreachStatusValuesForTab,
} from "@/lib/outreach-status";
import { useIsOperator } from "@/components/OperatorContext";
import { isSendableMessageStatus, messageStatusLabel, isWindowClosed } from "@/lib/message-status";
import { readStatedPrice, checkCounterEditPrice } from "@/lib/stated-price";
import { manualQuotedPayload } from "@/lib/last-sent-offer";
import { DmQueueTab, dmQueueItems } from "./dm-queue-tab";
import { announceDmReply, postDmReply } from "./dm-reply-dialog";
import {
  DM_REPLY_CHANNEL_LABELS,
  dmReplyLeads,
  isDmReplyChannel,
  type DmReplyChannel,
} from "@/lib/dm-reply";

type ReplyChannel = "email" | DmReplyChannel;

const REPLY_CHANNEL_ITEMS: Record<ReplyChannel, string> = {
  email: "Email",
  ...DM_REPLY_CHANNEL_LABELS,
};

// Machine slugs this page's routes emit, in the words a label manager needs.
// Same shape as ERROR_COPY in src/lib/run-progress.ts. `readError` used to
// return `body.error` verbatim, so a sixth Generate click inside a minute
// (expensive tier: 5/min) produced a red toast reading exactly `rate_limited`.
const OUTREACH_ERROR_COPY: Record<string, string> = {
  rate_limited:
    "Too many requests in a short time. Wait about a minute, then try again. Nothing was lost.",
  unauthorized: "Your session has expired. Sign in again, then try again.",
  forbidden: "This belongs to another workspace, so nothing was changed.",
  invalid_json: "That request could not be read. Reload the page and try again.",
  validation_failed:
    "Something in that form wasn't accepted, so nothing was saved. Check the values and try again.",
  no_test_recipient:
    "Testing mode is on but no test inbox is set, so nothing was sent. Add a test recipient in Settings.",
  "campaign_influencer not found":
    "This creator is no longer on the campaign, so nothing was sent. Reload the page.",
  "no recipient (live mode + influencer has no contact_email)":
    "This creator has no email address on file, so nothing was sent. Add one on the Deals page first.",
};

/** Resolve a failed response into one sentence. Prose from the route wins;
 *  a known slug is translated; an unknown one stays visible in brackets so an
 *  unmapped failure is still diagnosable rather than silently generic. */
function describeOutreachError(
  body: { error?: string; message?: string } | null,
  fallback: string,
): string {
  if (body?.message) return body.message;
  const code = body?.error?.trim();
  if (!code) return fallback;
  const mapped = OUTREACH_ERROR_COPY[code];
  if (mapped) return mapped;
  // An unmapped code used to be appended in brackets, producing
  // "Couldn't generate that draft. Please try again. (campaign not found)" —
  // our vocabulary, in a red toast, at a record label. Keep it diagnosable in
  // devtools instead.
  console.error(`[outreach] unmapped error code: ${code}`);
  return fallback;
}

// Pull a human-readable message out of a failed response, falling back to a
// friendly default so the label never sees a raw status code or silence.
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return describeOutreachError(body, fallback);
  } catch {
    return fallback;
  }
}

// Summarize a batch send as a single toast. Every outcome is reported
// separately — a 409 is NOT a send (see src/lib/outreach-send-copy.ts).
function sendSummaryToast(tally: SendTally, mode: SendMode): void {
  const { level, message } = summarizeSendTally(tally, mode);
  if (level === "info") return;
  toast[level](message);
}

// POST one draft and classify what actually happened. Never throws: a network
// error is an outcome ('failed'), not an exception the batch loop has to catch.
async function sendOne(messageId: string) {
  try {
    const res = await fetch(`/api/outreach/${messageId}/send`, { method: "POST" });
    let body: { error?: string } | null = null;
    if (!res.ok) {
      try {
        body = (await res.json()) as { error?: string };
      } catch {
        /* unparseable body — classifier falls back on status alone */
      }
    }
    return classifySendResponse(res.status, body);
  } catch {
    return "failed" as const;
  }
}

/**
 * Run `sendOne` over every id, paced so the server's rate limit is never tripped.
 *
 * /api/outreach/[id]/send is on the 'expensive' tier — 5 requests per minute
 * per IP. The old loop fired fixed batches of 3 back-to-back, so "Send All
 * Drafts (20)" put 5 on the wire and collected fifteen 429s, each tallied as
 * `failed`. Nothing was broken; the operator was told fifteen creators failed.
 *
 * planSendSchedule sizes the batches from the real limit and we wait a full
 * window between them. `onProgress` exists because the honest version of this
 * takes minutes, and a silent multi-minute spinner reads as a hang.
 */
async function runPacedSends(
  ids: string[],
  tally: SendTally,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  const plan = planSendSchedule(ids.length);
  let cursor = 0;
  for (let b = 0; b < plan.batches.length; b++) {
    const slice = ids.slice(cursor, cursor + plan.batches[b]);
    cursor += plan.batches[b];
    // One at a time inside the window (same 5/min rate). Concurrent sends for
    // a campaign's last slot would all be refused by the server's post-claim
    // recount (src/lib/first-touch-gate.ts), sending none of them.
    let done = cursor - slice.length;
    for (const id of slice) {
      const outcome = await sendOne(id);
      tallyOutcome(tally, outcome);
      done += 1;
      onProgress(done, ids.length);
      // The campaign's outreach limit or budget is reached: every further
      // first touch would be refused the same way, a minute per five. Stop,
      // and count the rest as held rather than spend an hour on 409s.
      if (outcome === "held_by_limit") {
        tally.held_by_limit += ids.length - done;
        onProgress(ids.length, ids.length);
        return;
      }
    }
    // Wait out the rate-limit window before the next batch — but never after
    // the last one, which would just stall the UI for a minute at the end.
    if (b < plan.batches.length - 1) {
      await new Promise((r) => setTimeout(r, plan.waitMsBetweenBatches));
    }
  }
}

interface OutreachInfluencer {
  username: string;
  display_name: string;
  platform: string;
  follower_count: number;
  engagement_rate: number;
  bio: string;
  contact_email: string | null;
  profile_url: string | null;
  id: string;
}

interface OutreachMessage {
  id: string;
  campaign_influencer_id: string;
  message_type: string;
  direction: string;
  subject: string | null;
  body: string;
  channel: string;
  sent_at: string | null;
  sent_to: string | null;
  classification: string | null;
  edited_by_user: boolean;
  created_at: string;
  // Routed dispatch: 'human_queue' rows live in the DM queue tab.
  send_mode?: string | null;
  // The send lifecycle. Already on the wire (outreach-listing
  // selects '*'); it was only ever missing from this type, which is why a
  // window_closed row rendered as an ordinary unsent draft with a live Send
  // button that silently overwrote the status.
  status?: string | null;
  // Migration 019 — a SCHEDULED send (quiet-hours deferral). Also already on
  // the wire and also missing from this type, which is how a DM deliberately
  // held until 9am tomorrow appeared in the DM queue tonight with a live
  // button. The DM queue reads it; see ./dm-queue-guards.ts.
  send_after?: string | null;
  // Migration 059 — the price a counter quotes. The edit form prefills its
  // price field from it (an edited counter records its own price).
  offer_usd?: number | null;
}

/** The price field's starting value for a counter draft: the recorded price,
 *  else the one its text states, else empty (the editor types it). */
function counterPricePrefill(msg: { body: string; offer_usd?: number | null }): string {
  if (msg.offer_usd != null && Number(msg.offer_usd) > 0) return String(Number(msg.offer_usd));
  const stated = readStatedPrice(msg.body);
  return stated.kind === "one" ? String(stated.usd) : "";
}

interface OutreachEntry {
  id: string;
  campaign_id: string;
  composite_score: number | null;
  tier: string | null;
  outreach_priority: string;
  outreach_angle: string | null;
  outreach_status: string;
  message_count: number;
  last_outreach_at: string | null;
  last_response_at: string | null;
  response_classification: string | null;
  status: string;
  price_estimate_mid: number | null;
  influencer: OutreachInfluencer | null;
  campaign: { id: string; artist_name: string; status: string } | null;
  messages: OutreachMessage[];
}

// Neutral unless it needs the label (a reply to read) or it closed a deal.
const STATUS_COLORS: Record<string, string> = {
  pending: "bg-status-sourced text-status-sourced-fg border-transparent",
  draft_ready: "bg-status-outreach text-status-outreach-fg border-transparent",
  sent: "bg-status-outreach text-status-outreach-fg border-transparent",
  responded: "bg-status-reply text-status-reply-fg border-transparent",
  follow_up: "bg-status-negotiation text-status-negotiation-fg border-transparent",
  negotiating: "bg-status-negotiation text-status-negotiation-fg border-transparent",
  deal_closed: "bg-status-payout-complete text-status-payout-complete-fg border-transparent",
  rejected: "bg-status-sourced text-status-sourced-fg border-transparent",
};

const PLATFORM_NAME: Record<string, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
};

// The status vocabulary now lives in @/lib/outreach-status, shared with the
// two API routes that filter on it. It was duplicated here, which is how the
// page's own idea of "no message yet" (three spellings) drifted from what
// /api/outreach/list actually queried (one).

// outreach_messages.message_type, written raw by the generate/negotiation paths.
const MESSAGE_TYPE_LABELS: Record<string, string> = {
  initial: "first message",
  follow_up: "follow-up",
  negotiation: "negotiation",
  response: "their reply",
};

// classifyResponse() output (src/lib/outreach.ts). Three of the five values
// were not keys in STATUS_COLORS, so they rendered as unstyled raw slugs.
const CLASSIFICATION_META: Record<string, { label: string; classes: string }> = {
  interested: {
    label: "Interested",
    classes: "bg-status-payout-complete text-status-payout-complete-fg border-transparent",
  },
  not_interested: {
    label: "Not interested",
    classes: "bg-status-sourced text-status-sourced-fg border-transparent",
  },
  negotiating: {
    label: "Negotiating",
    classes: "bg-status-negotiation text-status-negotiation-fg border-transparent",
  },
  question: {
    label: "Asked a question",
    classes: "bg-status-reply text-status-reply-fg border-transparent",
  },
  unclear: {
    label: "Unclear",
    classes: "bg-status-sourced text-status-sourced-fg border-transparent",
  },
};

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "pending", label: "No message" },
  { value: "draft_ready", label: "Drafts" },
  // DM-channel creators: AI-drafted, human-sent from the firm's
  // own account. Not an outreach_status; filtered client-side on send_mode.
  { value: "dm_queue", label: "DM queue" },
  { value: "sent", label: "Sent" },
  { value: "responded", label: "Responded" },
  { value: "negotiating", label: "Negotiating" },
  { value: "rejected", label: "Rejected" },
];

export default function OutreachPage() {
  const [entries, setEntries] = useState<OutreachEntry[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [filter, setFilter] = useState({
    status: "all",
    campaign_id: "",
    search: "",
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const [bulkGenerating, setBulkGenerating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // N11: bulk-send selection. Keys are the latest-outbound message id per
  // selected draft row (we send by message id, not entry id, since
  // /api/outreach/[id]/send expects an outreach_messages.id).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkSending, setBulkSending] = useState(false);
  // Live progress through a paced send. A rate-limited run takes minutes; the
  // operator needs to see it advancing rather than guess whether it hung.
  const [sendProgress, setSendProgress] = useState<{ done: number; total: number } | null>(null);
  // "Send All Drafts" promotion — confirms via Dialog before firing the same
  // rate-limit-paced loop that powers per-row bulk-send.
  const [sendAllOpen, setSendAllOpen] = useState(false);
  const [sendAllRunning, setSendAllRunning] = useState(false);
  // Resolved test recipient surfaced in the modal copy so the operator can
  // see exactly where the drafts will land before confirming.
  const [testRecipient, setTestRecipient] = useState<string | null>(null);
  // firms.testing_mode, as read from /api/firm. null = not read yet / the read
  // failed, which is a distinct state from "live": the confirm copy says
  // "unknown" rather than guessing. This page used to hardcode "in testing
  // mode / to your test inbox" and never read the flag at all, so a live
  // campaign told the operator their real creator emails were going to a test
  // inbox.
  const [testingMode, setTestingMode] = useState<boolean | null>(null);
  const sendMode: SendMode = sendModeFromTestingMode(testingMode);

  // The status tab is applied CLIENT-side now. It used to be a server filter,
  // which meant `entries` only ever held the active tab's rows — so every
  // other tab badge counted from a set that excluded it and read 0. Standing
  // on the Drafts tab, "Sent" said 0. Dropping the stat tiles above made those
  // badges the only counts on the page, so they have to be true.
  const loadEntries = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter.campaign_id) params.set("campaign_id", filter.campaign_id);
    if (filter.search) params.set("search", filter.search);

    // A rejected fetch used to skip setLoading(false) and leave the spinner up
    // forever; a non-ok response left entries at [] and showed a label manager
    // with 400 creators the "no outreach entries" empty state instead.
    try {
      const res = await fetch(`/api/outreach/list?${params}`);
      if (res.ok) {
        const data = await res.json();
        setEntries(Array.isArray(data) ? data : []);
        setLoadErr(null);
      } else {
        let body: { error?: string; message?: string } | null = null;
        try {
          body = (await res.json()) as { error?: string };
        } catch {
          /* not JSON */
        }
        setLoadErr(
          describeOutreachError(
            body,
            "We couldn't load your outreach list. Try again.",
          ),
        );
      }
    } catch {
      setLoadErr(
        "We couldn't reach the server. Check your connection, then try again.",
      );
    } finally {
      setLoading(false);
    }
  }, [filter.campaign_id, filter.search]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadEntries();
  }, [loadEntries]);

  useEffect(() => {
    async function loadCampaigns() {
      const res = await fetch("/api/campaigns");
      if (res.ok) {
        const data = await res.json();
        setCampaigns(Array.isArray(data) ? data : []);
      }
    }
    loadCampaigns();
  }, []);

  // Resolve BOTH the send mode and the test recipient for the confirm copy.
  // testing_mode is firm-level only (the per-user row only overrides where
  // testing-mode mail is routed, never whether it is rerouted at all — see the
  // resolution order in src/lib/resend.ts). Recipient: per-user override
  // (firm_member.test_recipient_email) wins, then firm-level, then unset.
  useEffect(() => {
    async function loadSendContext() {
      try {
        const [memRes, firmRes] = await Promise.all([
          fetch("/api/firm-member").catch(() => null),
          fetch("/api/firm").catch(() => null),
        ]);
        let mem: { test_recipient_email?: string | null } = {};
        if (memRes && memRes.ok) {
          mem = (await memRes.json()) as { test_recipient_email?: string | null };
        }
        let firm: { test_recipient_email?: string | null; testing_mode?: boolean } = {};
        if (firmRes && firmRes.ok) {
          firm = (await firmRes.json()) as {
            test_recipient_email?: string | null;
            testing_mode?: boolean;
          };
        }
        const resolved =
          mem.test_recipient_email ?? firm.test_recipient_email ?? null;
        setTestRecipient(resolved);
        setTestingMode(typeof firm.testing_mode === "boolean" ? firm.testing_mode : null);
      } catch {
        /* non-fatal — the confirm copy says the mode is unknown rather than
           guessing, which is the whole point. */
      }
    }
    loadSendContext();
  }, []);

  async function generateMessage(ciId: string, messageType = "initial") {
    setGenerating((prev) => new Set(prev).add(ciId));
    try {
      const res = await fetch("/api/outreach/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaign_influencer_id: ciId,
          message_type: messageType,
        }),
      });
      if (res.ok) {
        await loadEntries();
        setExpandedId(ciId);
      } else {
        toast.error(await readError(res, "Couldn't generate that draft. Please try again."));
      }
    } catch {
      toast.error("Network error while generating the draft. Check your connection.");
    } finally {
      setGenerating((prev) => {
        const next = new Set(prev);
        next.delete(ciId);
        return next;
      });
    }
  }

  async function generateBulk() {
    if (!filter.campaign_id) return;
    setBulkGenerating(true);
    try {
      const res = await fetch("/api/outreach/generate-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaign_id: filter.campaign_id,
          tier_filter: "all",
        }),
      });
      if (res.ok) {
        // A 200 with generated: 0 is not a success. The route explains why in
        // `message`; the old toast threw that away and painted it green.
        const result = (await res.json()) as {
          generated?: number;
          skipped?: number;
          failed?: number;
          message?: string;
        };
        await loadEntries();
        if (result.generated === 0) {
          toast.info(
            result.message ??
              "No drafts were generated: there were no creators waiting for a first message."
          );
        } else if (typeof result.generated === "number") {
          const extras = [
            result.skipped ? `${result.skipped} skipped` : null,
            result.failed ? `${result.failed} failed` : null,
          ].filter(Boolean);
          toast.success(
            `Generated ${result.generated} draft${result.generated === 1 ? "" : "s"}.` +
              (extras.length ? ` ${extras.join(", ")}.` : "")
          );
        } else {
          toast.success("Drafts generated.");
        }
      } else {
        toast.error(await readError(res, "Couldn't generate the drafts. Please try again."));
      }
    } catch {
      toast.error("Network error while generating drafts. Check your connection.");
    } finally {
      setBulkGenerating(false);
    }
  }

  async function handleSend(messageId: string) {
    // F6: Direct call to /api/outreach/[id]/send (cleaner than the
    // PATCH-with-mark_sent shim). Server resolves testing-mode at send
    // time from the firm row + dispatches via Resend.
    let res: Response;
    try {
      res = await fetch(`/api/outreach/${messageId}/send`, {
        method: "POST",
      });
    } catch {
      toast.error(
        "Couldn't send: we can't reach the server. Check your connection and try again. Nothing was sent."
      );
      return;
    }

    if (res.status === 409) {
      // A 409 is three different things: already sent, routed to the DM queue
      // or blocked as a stale draft. Surface the route's own
      // message; "already sent" is only the fallback, never the blanket answer.
      let body: { error?: string; message?: string } | null = null;
      try {
        body = (await res.json()) as { error?: string; message?: string };
      } catch {
        /* fall through to the outcome default */
      }
      const outcome = classifySendResponse(409, body);
      const fallback =
        outcome === "dm_queue"
          ? "Moved to the DM queue for a human send."
          : outcome === "stale_draft"
            ? "Blocked as a stale draft. Regenerate it, then send."
            : "That message was already sent.";
      toast.info(body?.message ?? fallback);
      await loadEntries();
      return;
    }

    let data: {
      ok?: boolean;
      test_mode?: boolean;
      resolved_to?: string;
      error?: string;
    } = {};
    try {
      data = await res.json();
    } catch {
      toast.error(
        `Couldn't send that message. Nothing was sent. Try again. (error ${res.status})`
      );
      return;
    }

    if (!data.ok) {
      toast.error(
        describeOutreachError(data, "Couldn't send that message. Nothing was sent. Try again.")
      );
      return;
    }

    const recipient = data.resolved_to ?? "the recipient";
    if (data.test_mode) {
      toast.success(`Sent in testing mode to ${recipient}.`);
    } else {
      toast.success(`Sent to ${recipient}.`);
    }
    await loadEntries();
  }

  async function copyMessage(body: string, id: string) {
    await navigator.clipboard.writeText(body);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  // Rows for the active tab. `entries` is now the full set for the current
  // campaign/search, so the tab badges below can count honestly.
  const visibleEntries: OutreachEntry[] =
    filter.status === "all" || filter.status === "dm_queue"
      ? entries
      : (() => {
          const values = outreachStatusValuesForTab(filter.status);
          if (values === null) return entries;
          return entries.filter((e) =>
            filter.status === "pending"
              ? isNoMessageYet(e.outreach_status)
              : values.includes(e.outreach_status)
          );
        })();

  function tabCount(value: string): number {
    if (value === "dm_queue") return dmQueueItems(entries).length;
    if (value === "all") return entries.length;
    if (value === "pending") {
      return entries.filter((e) => isNoMessageYet(e.outreach_status)).length;
    }
    const values = outreachStatusValuesForTab(value) ?? [value];
    return entries.filter((e) => values.includes(e.outreach_status)).length;
  }

  // N11: Bulk-send selection helpers.
  //
  // We send by outreach_messages.id (the latest unsent outbound message on a
  // draft_ready entry). selectableMessageIds is the universe of ids the
  // "Select all" checkbox toggles between {all-selected, none-selected}.
  function getDraftMessageId(entry: OutreachEntry): string | null {
    if (entry.outreach_status !== "draft_ready") return null;
    // human_queue rows belong to the DM queue tab, not the email
    // bulk-send universe — a human sends those from the firm's own account.
    const latestOutbound = entry.messages.find(
      (m) =>
        m.direction === "outbound" &&
        !m.sent_at &&
        m.send_mode !== "human_queue" &&
        // A window-closed draft is terminal. Without this it stayed inside
        // "Send All Drafts (N)" and one click undid the campaign window.
        isSendableMessageStatus(m.status)
    );
    return latestOutbound?.id ?? null;
  }
  const selectableMessageIds: string[] = visibleEntries
    .map(getDraftMessageId)
    .filter((id): id is string => id !== null);
  const allSelected =
    selectableMessageIds.length > 0 &&
    selectableMessageIds.every((id) => selected.has(id));

  function toggleSelected(messageId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }
  function toggleSelectAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectableMessageIds));
    }
  }

  // Paced by runPacedSends against the server's real 'expensive' tier limit.
  // Promise.all over each batch so a single 5xx doesn't abort the rest — every
  // outcome is classified, never thrown.
  async function sendBulk() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    // Confirm copy is DERIVED from the firm's actual testing_mode. It used to
    // assert "in testing mode … lands in the test recipient inbox" no matter
    // what the firm was set to.
    const copy = bulkSendConfirmCopy({
      mode: sendMode,
      count: ids.length,
      testRecipient,
    });
    const pace = describeSendPace(ids.length);
    if (!window.confirm(`${copy.title}\n\n${copy.body}${pace ? `\n\n${pace}` : ""}`)) return;

    setBulkSending(true);
    const tally = emptyTally();
    try {
      await runPacedSends(ids, tally, (done, total) => setSendProgress({ done, total }));
    } finally {
      setBulkSending(false);
      setSendProgress(null);
      setSelected(new Set());
      sendSummaryToast(tally, sendMode);
      await loadEntries();
    }
  }

  // "Send All Drafts (N)" — counts EVERY draft in the current filtered view
  // (not just selected). N excludes already-sent rows because draftMsgId
  // returns null for those. Reuses the same rate-limit-paced loop sendBulk
  // uses, so a 20-draft run does not collect fifteen 429s.
  async function runSendAll() {
    const ids: string[] = visibleEntries
      .map(getDraftMessageId)
      .filter((id): id is string => id !== null);
    if (ids.length === 0) {
      setSendAllOpen(false);
      return;
    }
    setSendAllRunning(true);
    const tally = emptyTally();
    try {
      await runPacedSends(ids, tally, (done, total) => setSendProgress({ done, total }));
    } finally {
      setSendAllRunning(false);
      setSendProgress(null);
      setSendAllOpen(false);
      setSelected(new Set());
      sendSummaryToast(tally, sendMode);
      await loadEntries();
    }
  }

  // Count of drafts in the currently-filtered view — surfaces in the
  // "Send all drafts (N)" header button.
  const draftCount = selectableMessageIds.length;
  // Creators still waiting on a first message. Drives which of the two
  // workflow buttons is the page's primary action.
  const needMessageCount = entries.filter((e) =>
    isNoMessageYet(e.outreach_status)
  ).length;

  // Confirm copy for the Send All modal, derived from the firm's real mode.
  const sendAllCopy = bulkSendConfirmCopy({
    mode: sendMode,
    count: draftCount,
    testRecipient,
  });

  return (
    <AppShell
      title="Outreach"
      badge={
        // The standing mode chip only appears when the testing-mode banner is
        // NOT already saying it. LIVE and unknown carry information the banner
        // never shows.
        sendMode !== "testing" ? (
          <Badge
            variant={sendMode === "live" ? "destructive" : "outline"}
            title={
              sendMode === "live"
                ? "Messages go to creators' real email addresses."
                : "We could not read whether messages are being delivered. Check Settings before sending."
            }
          >
            {sendModeLabel(sendMode)}
          </Badge>
        ) : undefined
      }
      // Step 1 then step 2, in that order, and only the current step is
      // filled. "Send all drafts" used to be the only filled button while
      // "Generate all drafts" (which has to happen first) was a secondary that
      // disappeared entirely until you picked a campaign.
      actions={
        <>
          <Button
            variant={draftCount === 0 && needMessageCount > 0 ? "default" : "outline"}
            onClick={generateBulk}
            disabled={bulkGenerating || !filter.campaign_id}
            title={
              filter.campaign_id
                ? undefined
                : "Pick a campaign first. Drafts are written per campaign."
            }
          >
            {bulkGenerating ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Sparkles className="size-4" />
                1. Write drafts
              </>
            )}
          </Button>
          {draftCount >= 1 && (
            <Button
              onClick={() => setSendAllOpen(true)}
              disabled={sendAllRunning || bulkSending}
            >
              <Send className="size-4" />
              2. Send {draftCount} draft{draftCount === 1 ? "" : "s"}
            </Button>
          )}
        </>
      }
    >
      <div className="mx-auto w-full max-w-7xl px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        {/* Filters */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search className="absolute left-2.5 top-2 size-4 text-faint" />
            <Input
              placeholder="Find a creator"
              aria-label="Find a creator"
              className="h-8 pl-8"
              value={filter.search}
              onChange={(e) => setFilter((f) => ({ ...f, search: e.target.value }))}
            />
          </div>
          <Select
            items={[
              { value: "all", label: "All campaigns" },
              ...campaigns.map((c) => ({ value: c.id, label: c.artist_name })),
            ]}
            value={filter.campaign_id || "all"}
            onValueChange={(v) => setFilter((f) => ({ ...f, campaign_id: v === "all" ? "" : (v ?? "") }))}
          >
            <SelectTrigger className="w-56" aria-label="Filter by campaign">
              <SelectValue placeholder="All campaigns" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All campaigns</SelectItem>
              {campaigns.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.artist_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Status filter: an underline tab row, counts in quiet type. */}
        <Tabs
          value={filter.status}
          onValueChange={(v) => setFilter((f) => ({ ...f, status: v }))}
          className="mb-4 border-b"
        >
          <TabsList variant="line" className="h-9 gap-4 p-0">
            {STATUS_TABS.map(({ value, label }) => (
              <TabsTrigger key={value} value={value} className="px-0">
                {label}
                <span className="text-xs font-normal tabular-nums text-faint">
                  {tabCount(value)}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {/* Entries List */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : loadErr ? (
          <EmptyState
            title={<span className="text-destructive">{loadErr}</span>}
            action={
              <Button type="button" variant="outline" onClick={() => void loadEntries()}>
                Try again
              </Button>
            }
          />
        ) : filter.status === "dm_queue" ? (
          /* Human send queue for DM-channel creators. Ordered
             AFTER the loadErr branch: it used to come first, so a failed list
             load rendered the DM queue's "No DMs waiting" empty state and the
             operator read an outage as an empty queue.
             testingMode is passed because it is the one thing this screen must
             say out loud — a DM pasted from here is NOT rerouted by testing
             mode, so this queue is the only surface in the product that can
             really reach a creator while the app-wide banner says nothing can. */
          <DmQueueTab
            entries={entries}
            onReload={loadEntries}
            testingMode={testingMode}
            testRecipient={testRecipient}
          />
        ) : visibleEntries.length === 0 ? (
          <EmptyState
            title="Nothing here yet"
            action={
              <Link href="/campaigns" className={buttonVariants({ variant: "outline" })}>
                Go to campaigns
              </Link>
            }
          >
            Creators appear once a campaign has run discovery. Then you can
            draft and send messages from this page.
          </EmptyState>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            {/* N11: Select-all header for drafts. Hidden when there are no
                draft_ready rows currently filtered/visible so the strip
                doesn't clutter Sent/Responded tabs. */}
            <div className="flex h-9 items-center gap-3 border-b bg-muted/50 px-4 text-xs font-medium text-muted-foreground">
              {selectableMessageIds.length > 0 ? (
                <input
                  type="checkbox"
                  className="size-4 rounded border-input accent-primary"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  aria-label="Select all drafts on this page"
                />
              ) : (
                <span className="size-4" aria-hidden />
              )}
              <span className="flex-1">
                {selectableMessageIds.length > 0
                  ? `Creator (${selectableMessageIds.length} draft${selectableMessageIds.length === 1 ? "" : "s"} selectable)`
                  : "Creator"}
              </span>
              <span className="hidden w-24 text-right md:block">Followers</span>
              <span className="hidden w-20 text-right md:block">Est. price</span>
              <span className="w-36">Status</span>
              <span className="w-28" aria-hidden />
            </div>

            <ul className="divide-y">
              {visibleEntries.map((entry) => {
                const inf = entry.influencer;
                if (!inf) return null;
                const isExpanded = expandedId === entry.id;
                const latestOutbound = entry.messages.find((m) => m.direction === "outbound");
                const isGenerating = generating.has(entry.id);
                // N11: only draft_ready entries with an unsent outbound msg get
                // a checkbox. Other rows pad the column so the rows stay aligned.
                const draftMsgId = getDraftMessageId(entry);
                const isSelected = draftMsgId ? selected.has(draftMsgId) : false;

                return (
                  <li key={entry.id} className={isExpanded ? "bg-muted/30" : undefined}>
                    {/* Row Header */}
                    <div
                      className="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50"
                      onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                    >
                      {draftMsgId ? (
                        <input
                          type="checkbox"
                          className="size-4 shrink-0 rounded border-input accent-primary"
                          checked={isSelected}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleSelected(draftMsgId)}
                          aria-label={`Select draft for @${inf.username}`}
                        />
                      ) : (
                        <span className="size-4 shrink-0" aria-hidden />
                      )}
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                          {/* Handle, not display name: "[SAMPLE] …" names put a
                              bracket in the circle. */}
                          {inf.username[0]?.toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              @{inf.username}
                            </span>
                            {entry.tier && (
                              <span className="text-xs text-faint">Tier {entry.tier}</span>
                            )}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {[
                              entry.campaign?.artist_name,
                              PLATFORM_NAME[inf.platform?.toLowerCase?.() ?? ""] ?? inf.platform,
                              inf.contact_email ? "has email" : null,
                            ]
                              .filter(Boolean)
                              .join(", ")}
                          </p>
                        </div>
                      </div>
                      <span className="hidden w-24 text-right text-sm tabular-nums text-muted-foreground md:block">
                        {inf.follower_count != null ? inf.follower_count.toLocaleString() : <span className="text-xs text-faint">Unknown</span>}
                      </span>
                      <span className="hidden w-20 text-right text-sm tabular-nums text-muted-foreground md:block">
                        {entry.price_estimate_mid ? `~$${entry.price_estimate_mid}` : <span className="text-xs text-faint">None</span>}
                      </span>
                      <span className="w-36">
                        <Badge className={STATUS_COLORS[entry.outreach_status] || STATUS_COLORS.pending}>
                          {outreachStatusLabel(entry.outreach_status)}
                        </Badge>
                      </span>
                      <div className="flex w-28 shrink-0 items-center justify-end gap-1">
                        {isNoMessageYet(entry.outreach_status) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              generateMessage(entry.id);
                            }}
                            disabled={isGenerating}
                          >
                            {isGenerating ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <>
                                <Sparkles className="size-3.5" />
                                Generate
                              </>
                            )}
                          </Button>
                        )}
                        {latestOutbound &&
                          !latestOutbound.sent_at &&
                          isSendableMessageStatus(latestOutbound.status) && (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Copy message"
                            onClick={(e) => {
                              e.stopPropagation();
                              copyMessage(
                                latestOutbound.subject
                                  ? `Subject: ${latestOutbound.subject}\n\n${latestOutbound.body}`
                                  : latestOutbound.body,
                                latestOutbound.id
                              );
                            }}
                          >
                            {copiedId === latestOutbound.id ? (
                              <Check className="size-3.5 text-status-payout-complete-fg" />
                            ) : (
                              <Copy className="size-3.5" />
                            )}
                          </Button>
                        )}
                        {isExpanded ? (
                          <ChevronUp className="size-4 text-faint" />
                        ) : (
                          <ChevronDown className="size-4 text-faint" />
                        )}
                      </div>
                    </div>

                    {/* Expanded Content */}
                    {isExpanded && (
                      <ExpandedOutreach
                        entry={entry}
                        onSend={handleSend}
                        onCopy={copyMessage}
                        copiedId={copiedId}
                        onGenerate={(type) => generateMessage(entry.id, type)}
                        isGenerating={isGenerating}
                        onReload={loadEntries}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {/* "Send All Drafts" confirm modal. Title + body are DERIVED from the
          firm's actual testing_mode (bulkSendConfirmCopy) — they used to assert
          "in testing mode … to your test inbox" unconditionally, which with
          testing mode off lied about where real creator email was going. */}
      <Dialog open={sendAllOpen} onOpenChange={setSendAllOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{sendAllCopy.title}</DialogTitle>
            <DialogDescription>
              {/* The pace sentence is DERIVED from the server's real rate
                  limit, not a vague reassurance. "a few at a time" was true
                  but useless — 20 drafts genuinely take about 3 minutes and
                  the operator should know that before committing, not after
                  watching a spinner. */}
              {sendAllCopy.body} {describeSendPace(draftCount)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setSendAllOpen(false)}
              disabled={sendAllRunning}
            >
              Cancel
            </Button>
            <Button
              onClick={runSendAll}
              disabled={sendAllRunning}
              variant={sendAllCopy.destructive ? "destructive" : "default"}
            >
              {sendAllRunning ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  {sendProgress
                    ? `Sent ${sendProgress.done} of ${sendProgress.total}…`
                    : "Sending…"}
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-1.5" />
                  {sendMode === "live" ? "Send all (LIVE)" : "Send all"}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* N11: sticky bulk-send bar. Renders outside the page container so the
          floating position isn't constrained by its centered width. */}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-sm">
              <span className="font-medium">{selected.size} drafts selected</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelected(new Set())}
                disabled={bulkSending}
              >
                Clear
              </Button>
            </div>
            <Button
              size="sm"
              onClick={sendBulk}
              disabled={bulkSending}
              variant={sendMode === "testing" ? "default" : "destructive"}
            >
              {bulkSending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  {sendProgress
                    ? `Sent ${sendProgress.done} of ${sendProgress.total}…`
                    : "Sending…"}
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-1.5" />
                  {sendMode === "live" ? "Send all (LIVE)" : "Send all"}
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function ExpandedOutreach({
  entry,
  onSend,
  onCopy,
  copiedId,
  onGenerate,
  isGenerating,
  onReload,
}: {
  entry: OutreachEntry;
  onSend: (id: string) => Promise<void>;
  onCopy: (body: string, id: string) => Promise<void>;
  copiedId: string | null;
  onGenerate: (type: string) => void;
  isGenerating: boolean;
  onReload: () => Promise<void>;
}) {
  const inf = entry.influencer!;
  const isOperator = useIsOperator();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [editSubject, setEditSubject] = useState("");
  // A counter draft's price. The server re-derives it from the text
  // and refuses a mismatch; this field is what the editor confirms when the
  // text alone can't say.
  const [editIsCounter, setEditIsCounter] = useState(false);
  const [editPrice, setEditPrice] = useState("");
  // The editor's explicit "yes, this counter offers $X" when the text
  // does not state that price itself. Cleared whenever the text or price moves.
  const [editPriceConfirmed, setEditPriceConfirmed] = useState(false);
  const editCheck = editIsCounter ? checkCounterEditPrice(editBody, editPrice) : null;
  const editBlocked =
    editCheck != null &&
    (editCheck.kind === "missing" || editCheck.kind === "mismatch" || (editCheck.kind === "confirm" && !editPriceConfirmed));
  // Any other message's optional "Price quoted" field. The ONLY way
  // a price in a hand-edited message is known; its text is never read for it.
  const [editQuoted, setEditQuoted] = useState("");
  const [editQuotedWas, setEditQuotedWas] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [responseText, setResponseText] = useState("");
  const [logging, setLogging] = useState(false);
  // Where the reply came in. A DM reply goes through /api/outreach/dm-reply so
  // the negotiator sees it; /respond only records it. Defaults to the DM
  // channel we last actually messaged them on, else email.
  const sentDmChannel = dmReplyLeads([entry])[0]?.channel ?? null;
  const [replyChannel, setReplyChannel] = useState<ReplyChannel>(sentDmChannel ?? "email");
  const replySubmissionRef = useRef<string>("");

  async function saveEdit(messageId: string) {
    // Never submit the prefilled price on its own: it goes only when the text
    // states it, or when the editor has explicitly confirmed it.
    if (editBlocked) {
      toast.error(editCheck?.kind === "confirm" || editCheck?.kind === "mismatch" || editCheck?.kind === "missing" ? editCheck.message : "Confirm the counter's price first.");
      return;
    }
    const quotedPayload = manualQuotedPayload(editIsCounter, editQuoted, editQuotedWas);
    if (quotedPayload === "invalid") {
      toast.error("Price quoted must be a dollar amount above $0, or left empty.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/outreach/messages/${messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: editBody,
          subject: editSubject || undefined,
          ...(editCheck && editCheck.kind !== "missing" ? { offer_usd: editCheck.usd } : {}),
          ...quotedPayload,
        }),
      });
      if (!res.ok) {
        const refusal = (await res.clone().json().catch(() => null)) as { suggested_offer_usd?: unknown } | null;
        if (editIsCounter && !(Number(editPrice) > 0) && Number(refusal?.suggested_offer_usd) > 0) {
          setEditPrice(String(Number(refusal?.suggested_offer_usd)));
          setEditPriceConfirmed(false);
        }
        toast.error(await readError(res, "Couldn't save your edits. Please try again."));
        return;
      }
      setEditingId(null);
      await onReload();
    } catch {
      toast.error("Network error while saving your edits. Check your connection.");
    } finally {
      setSaving(false);
    }
  }

  async function logResponse() {
    if (!responseText.trim()) return;
    setLogging(true);
    if (isDmReplyChannel(replyChannel)) {
      // Same id across retries of this reply; a fresh one once it lands.
      if (!replySubmissionRef.current) replySubmissionRef.current = crypto.randomUUID();
      const result = await postDmReply({
        campaignInfluencerId: entry.id,
        channel: replyChannel,
        text: responseText,
        submissionId: replySubmissionRef.current,
      });
      setLogging(false);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      announceDmReply(result);
      replySubmissionRef.current = "";
      setResponseText("");
      await onReload();
      return;
    }
    // Same id across retries of this reply, so the server dedupes a double
    // submit; a fresh one once it lands (same pattern as the DM path above).
    if (!replySubmissionRef.current) replySubmissionRef.current = crypto.randomUUID();
    try {
      const res = await fetch("/api/outreach/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaign_influencer_id: entry.id,
          response_text: responseText,
          submission_id: replySubmissionRef.current,
        }),
      });
      if (res.status === 409) {
        // The same reply is already on this thread (usually the email arrived
        // on its own). Not a failure: nothing new happened, so say that and
        // clear the box rather than invite a second paste.
        toast.info(await readError(res, "That reply already came in, so nothing new was logged."));
        replySubmissionRef.current = "";
        setResponseText("");
        await onReload();
        return;
      }
      if (!res.ok) {
        toast.error(await readError(res, "Couldn't log that response. Please try again."));
        return;
      }
      replySubmissionRef.current = "";
      setResponseText("");
      await onReload();
    } catch {
      toast.error("Network error while logging the response. Check your connection.");
    } finally {
      setLogging(false);
    }
  }

  return (
    <div className="space-y-4 border-t px-4 pb-5 sm:pl-[4.25rem]">
      {/* Influencer Info */}
      <div className="flex items-start justify-between pt-3">
        <div className="text-xs text-muted-foreground space-y-1">
          <p>
            <span className="font-medium text-foreground">{inf.display_name}</span> @{inf.username}
          </p>
          <p className="max-w-lg">{inf.bio}</p>
          {inf.contact_email && (
            <p>
              Email: <span className="text-foreground">{inf.contact_email}</span>
            </p>
          )}
          {entry.outreach_angle && (
            <p className="italic">Angle: {entry.outreach_angle}</p>
          )}
        </div>
        {inf.profile_url && (
          <a
            href={inf.profile_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        )}
      </div>

      <Separator />

      {/* Message Thread */}
      {entry.messages.length > 0 ? (
        <div className="space-y-3">
          <p className="text-meta font-medium text-muted-foreground">
            Messages ({entry.messages.length})
          </p>
          {entry.messages
            .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
            .map((msg) => (
              <div
                key={msg.id}
                className={`rounded-lg border p-3 ${
                  msg.direction === "inbound"
                    ? "ml-8 bg-muted/60"
                    : "bg-card mr-8"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      {msg.direction === "outbound" ? "You" : inf.username}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">
                      {msg.channel},{" "}
                      {MESSAGE_TYPE_LABELS[msg.message_type] ??
                        msg.message_type.replace(/_/g, " ")}
                    </span>
                    {msg.sent_at && (
                      <Badge variant="secondary" className="text-[10px]">
                        ✓ Sent {new Date(msg.sent_at).toLocaleDateString()}
                        {/* In testing mode `sent_to` is the operator's test inbox,
                            not the creator's address. The badge already says
                            the message went out; who it went to is ours. */}
                        {isOperator && msg.sent_to ? ` to ${msg.sent_to}` : ""}
                      </Badge>
                    )}
                    {msg.classification && (
                      <Badge
                        className={
                          CLASSIFICATION_META[msg.classification]?.classes ??
                          STATUS_COLORS[msg.classification] ??
                          ""
                        }
                        variant={CLASSIFICATION_META[msg.classification] ? undefined : "outline"}
                      >
                        {CLASSIFICATION_META[msg.classification]?.label ??
                          msg.classification.replace(/_/g, " ")}
                      </Badge>
                    )}
                  </div>
                  {msg.direction === "outbound" && (
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2"
                        onClick={() =>
                          onCopy(
                            msg.subject ? `Subject: ${msg.subject}\n\n${msg.body}` : msg.body,
                            msg.id
                          )
                        }
                      >
                        {copiedId === msg.id ? (
                          <Check className="h-3 w-3 text-status-locked-fg" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </Button>
                      {!msg.sent_at && isSendableMessageStatus(msg.status) && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() => {
                              setEditingId(msg.id);
                              setEditBody(msg.body);
                              setEditSubject(msg.subject || "");
                              setEditIsCounter(msg.message_type === "counter");
                              setEditPrice(counterPricePrefill(msg));
                              setEditPriceConfirmed(false);
                              const was = msg.message_type !== "counter" && Number(msg.offer_usd) > 0 ? Number(msg.offer_usd) : null;
                              setEditQuoted(was != null ? String(was) : "");
                              setEditQuotedWas(was);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            onClick={() => onSend(msg.id)}
                          >
                            <Send className="h-3 w-3 mr-1" />
                            Send
                          </Button>
                        </>
                      )}
                      {isWindowClosed(msg.status) && (
                        // Say WHY the Send button is gone. A missing control
                        // with no explanation reads as a broken screen, and
                        // this is the one status a label can act on (reopen
                        // the window or move the release date).
                        <Badge
                          variant="outline"
                          className="text-[10px] text-muted-foreground"
                          title="The campaign window closed before this message could be sent."
                        >
                          {messageStatusLabel(msg.status)}
                        </Badge>
                      )}
                    </div>
                  )}
                </div>

                {editingId === msg.id ? (
                  <div className="space-y-2">
                    {msg.channel === "email" && (
                      <Input
                        placeholder="Subject…"
                        value={editSubject}
                        onChange={(e) => setEditSubject(e.target.value)}
                        className="text-sm"
                      />
                    )}
                    <Textarea
                      value={editBody}
                      onChange={(e) => {
                        setEditBody(e.target.value);
                        setEditPriceConfirmed(false);
                        // Keep the price field on the price the text states,
                        // when it states exactly one.
                        const stated = editIsCounter ? readStatedPrice(e.target.value) : null;
                        if (stated?.kind === "one") setEditPrice(String(stated.usd));
                      }}
                      rows={6}
                      className="text-sm"
                    />
                    {editIsCounter && (
                      <div className="flex items-center gap-2">
                        <label htmlFor={`counter-price-${msg.id}`} className="text-xs text-muted-foreground">
                          Price this counter offers ($)
                        </label>
                        <Input
                          id={`counter-price-${msg.id}`}
                          type="number"
                          min={1}
                          step="1"
                          inputMode="decimal"
                          value={editPrice}
                          onChange={(e) => {
                            setEditPrice(e.target.value);
                            setEditPriceConfirmed(false);
                          }}
                          className="h-8 w-28 text-sm"
                        />
                        <span className="text-[11px] text-muted-foreground">
                          Must match the price in the message. This is what we record as offered.
                        </span>
                      </div>
                    )}
                    {!editIsCounter && (
                      <div className="flex items-center gap-2">
                        <label htmlFor={`quoted-price-${msg.id}`} className="text-xs text-muted-foreground">
                          Price quoted ($, optional)
                        </label>
                        <Input
                          id={`quoted-price-${msg.id}`}
                          type="number"
                          min={1}
                          step="1"
                          inputMode="decimal"
                          value={editQuoted}
                          onChange={(e) => setEditQuoted(e.target.value)}
                          className="h-8 w-28 text-sm"
                        />
                        <span className="text-[11px] text-muted-foreground">
                          Fill this in only if this message offers the creator a price. A price in the text alone is not recorded, so a yes to it comes to you instead of closing automatically.
                        </span>
                      </div>
                    )}
                    {editCheck && editCheck.kind !== "ok" && (
                      <div className="rounded-md border border-attention-border bg-attention p-2 text-xs text-attention-fg">
                        <p>{editCheck.message}</p>
                        {editCheck.kind === "confirm" && (
                          <label className="mt-1 flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={editPriceConfirmed}
                              onChange={(e) => setEditPriceConfirmed(e.target.checked)}
                            />
                            Yes, this counter offers ${editCheck.usd}
                          </label>
                        )}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => saveEdit(msg.id)} disabled={saving || editBlocked}>
                        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    {msg.subject && (
                      <p className="text-sm font-medium mb-1">Subject: {msg.subject}</p>
                    )}
                    <p className="text-sm whitespace-pre-wrap">{msg.body}</p>
                  </>
                )}
              </div>
            ))}
        </div>
      ) : (
        <div className="text-center py-4">
          {/* The row's own status badge already reads "No message yet". */}
          <Button
            size="sm"
            onClick={() => onGenerate("initial")}
            disabled={isGenerating}
          >
            {isGenerating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 mr-1" />
            )}
            Write the first message
          </Button>
        </div>
      )}

      {/* Actions */}
      {entry.messages.length > 0 && (
        <>
          <Separator />
          <div className="flex items-center gap-2 flex-wrap">
            {entry.outreach_status === "sent" ||
            entry.outreach_status === "responded" ||
            sentDmChannel !== null ? (
              <>
                <div className="flex-1 min-w-[200px]">
                  <Textarea
                    placeholder="Paste the creator’s reply here"
                    value={responseText}
                    onChange={(e) => {
                      setResponseText(e.target.value);
                      replySubmissionRef.current = "";
                    }}
                    rows={2}
                    className="text-sm"
                  />
                </div>
                <Select
                  items={REPLY_CHANNEL_ITEMS}
                  value={replyChannel}
                  onValueChange={(v) => {
                    if (v === "email" || isDmReplyChannel(v)) {
                      setReplyChannel(v);
                      replySubmissionRef.current = "";
                    }
                  }}
                >
                  <SelectTrigger size="sm" className="w-36" aria-label="Reply came in by">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(REPLY_CHANNEL_ITEMS) as ReplyChannel[]).map((c) => (
                      <SelectItem key={c} value={c}>
                        {REPLY_CHANNEL_ITEMS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  onClick={logResponse}
                  disabled={logging || !responseText.trim()}
                >
                  {logging ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <>
                      <MessageCircle className="h-3.5 w-3.5 mr-1" />
                      Log reply
                    </>
                  )}
                </Button>
              </>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => onGenerate("follow_up")}
              disabled={isGenerating}
            >
              {isGenerating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5 mr-1" />
                  Follow-up
                </>
              )}
            </Button>
            {(entry.outreach_status === "responded" || entry.response_classification === "interested") && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onGenerate("negotiation")}
                disabled={isGenerating}
              >
                <Sparkles className="h-3.5 w-3.5 mr-1" />
                Negotiation
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
