"use client";

// src/app/outreach/dm-queue-tab.tsx
//
// The DM queue: outreach_messages rows with send_mode='human_queue'
// (DM-channel creators routed off the auto-email path). The compliant design:
// the AI drafts, a HUMAN sends each DM from the label's own account by
// copy-paste, then marks it sent here — which records the send
// (social_send_events + priors), advances the lead, and OPENS A PRICED OFFER.
//
// ── What this screen is sized for ───────────────────────────────────────────
//
// ~95% of the discovered pool has no email address, so this is where almost
// every lead lands: two real campaigns are about to drop ~369 rows in here,
// ~302 of them from a single "Generate all drafts" click. The previous version
// was written for "a handful":
//
//   * it fired ONE GET per row in parallel for a cadence readout. At 302 rows
//     ~180 of them 429 against the shared 120-req/min 'auth' bucket, and
//     `if (!res.ok) return null` swallowed every one. The burst also drained
//     the bucket for `Mark sent` and the list reload, which share that tier
//     with 40+ other routes. That readout is gone (see below) and this
//     component now issues ZERO requests on render.
//   * it rendered all 302 cards at once, sorted created_at ascending — which
//     after a bulk draft run is insertion order, i.e. arbitrary. Now: 25 per
//     page, ordered by composite_score (see compareDmQueueOrder).
//   * it had no multi-select, no keyboard path, no progress readout and no
//     message_type, so a cold first touch and a counter-offer looked identical
//     and there was no way to know where you were in the list.
//
// ── The cadence readout, and why it is gone ─────────────────────────────────
//
// It read `social_accounts`: a table with ZERO rows, ZERO writers anywhere in
// the repo (no API route, no UI, no worker, no seed, no DB function) and a
// `handle` column describing the LABEL's sending account, not a creator's. So
// it always rendered "Connect a sending account to track cadence" — a control
// instructing the operator to do something the product cannot do. Its
// `local_hour` also came from the operator's browser clock, which the route's
// own comment admitted. Removed, and replaced with the one scheduling fact that
// is real and per-row: outreach_messages.send_after.
//
// ── Reserve & copy (first touches) ──────────────────────────────────────────
//
// The campaign's outreach limit and budget pacing could only refuse at Mark
// sent — after the human had already sent the DM by hand. A first-touch
// opener's copy action now reserves a slot first (POST …/reserve,
// src/lib/dm-reserve.ts) and copies only the text that call returns. An
// opener past the limit or budget shows "Limit reached" and no copy button.
// Replies, counters and follow-ups to creators already contacted copy as
// before. Pre-060 (no dm_reserved_at on the row) every row copies as before.
//
// ── Testing mode does not cover this screen ────────────────────────────────
//
// firms.testing_mode rewrites the RECIPIENT of an EMAIL (src/lib/resend.ts).
// A human pasting a draft from here into Instagram bypasses it completely.
// The app-wide banner says "not delivered to creators"; on this one surface
// that is false, which is why the notice below is unconditional.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Loader2,
  Reply,
} from "lucide-react";
import { toast } from "sonner";
import {
  compareDmQueueOrder,
  dmMarkSentRefusal,
  dmQueueWithholdReason,
  parseSendAfter,
  resolveDmTarget,
  type DmRefusal,
  type DmTarget,
} from "./dm-queue-guards";
import { dmReplyLeads } from "@/lib/dm-reply";
import {
  dmCopyMode,
  reservationExpiresAt,
  type DmCopyMode,
  type FirstTouchSlotStamp,
} from "@/lib/dm-reservation";
import { FIRST_TOUCH_REFUSALS } from "@/lib/outreach-send-copy";
import { readStatedPrice, checkCounterEditPrice } from "@/lib/stated-price";
import { manualQuotedPayload } from "@/lib/last-sent-offer";
import { DmReplyDialog } from "./dm-reply-dialog";

interface DmQueueMessage {
  id: string;
  subject: string | null;
  body: string;
  channel: string;
  direction: string;
  sent_at: string | null;
  created_at: string;
  message_type: string;
  send_mode?: string | null;
  // The send lifecycle. Already on the wire (outreach-listing
  // selects '*'); it was only ever missing from this type, which is why a
  // window_closed row rendered here as a live queue item with a live button.
  status?: string | null;
  // Migration 019 — a SCHEDULED send. negotiation-tick stamps it on every
  // escalation it defers out of quiet hours. The queue never selected it, so a
  // DM held until 9am tomorrow showed up tonight with a live button.
  send_after?: string | null;
  // Migration 059 — the price a counter quotes; prefills the edit form's price
  // field (an edited counter records its own price).
  offer_usd?: number | null;
  // Migration 060 — a first-touch slot held by Reserve & copy. The key is
  // absent pre-060, which is how the queue knows to copy plainly.
  dm_reserved_at?: string | null;
}

interface DmQueueInfluencer {
  username: string;
  display_name: string;
  platform: string;
  profile_url: string | null;
  /** Platform-wide block (operator-only). Already folded into do_not_contact. */
  blocklisted?: boolean | null;
}

export interface DmQueueEntry {
  id: string;
  influencer: DmQueueInfluencer | null;
  campaign: { artist_name: string } | null;
  messages: DmQueueMessage[];
  // The pool's own value ranking — what the queue is ordered by.
  composite_score?: number | null;
  tier?: string | null;
  /** Per-label do-not-contact, stamped by src/lib/outreach-listing.ts.
   *  Anything but 'clear' keeps every DM for this creator off the queue. */
  do_not_contact?: "blocked" | "clear" | "unknown";
  /** Stamped by the listing on a creator not yet contacted (src/lib/dm-reserve.ts). */
  first_touch_slot?: FirstTouchSlotStamp;
}

interface QueueItem {
  entry: DmQueueEntry;
  msg: DmQueueMessage;
  influencer: DmQueueInfluencer;
  target: DmTarget;
  /** Non-null when this row must not be marked sent. */
  refusal: DmRefusal | null;
  /** What the copy control does (src/lib/dm-reservation.ts dmCopyMode). */
  copyMode: DmCopyMode;
  /** copyMode 'limit': the gate's reason ("Campaign limit reached (10 of 10 contacted)"). */
  limitMessage: string | null;
  /** refusal, no target, or limit reached — the one flag the UI gates on. */
  blocked: boolean;
}

/** 25 rows a page. Enough that paging is rare inside a work session, few enough
 *  that a bulk action can never exceed a quarter of the per-minute budget. */
const PAGE_SIZE = 25;

/** Bulk mark-sent pacing. The 'auth' tier is 120 req/min per IP, SHARED with
 *  the list reload and every other authed route, so a full page (25) plus the
 *  reload is ~26 — a fifth of the budget. Batched anyway so a slow DB doesn't
 *  see 25 concurrent connections. */
const MARK_BATCH_SIZE = 4;
const MARK_BATCH_PAUSE_MS = 400;

/** Hard ceiling on one bulk action. Selection is tracked by id and SURVIVES
 *  paging, so without this an operator could walk 12 pages, accumulate all 302
 *  rows and fire 302 PATCHes into a 120-req/min bucket — the same burst that
 *  made the old cadence fan-out unusable, just triggered by hand. One page's
 *  worth at a time keeps the worst case at ~26 requests including the reload. */
const MAX_SELECTION = PAGE_SIZE;

const SELECTION_CAP_NOTE =
  `${MAX_SELECTION} at a time. Recording a send is rate-limited and that limit is shared with ` +
  'the rest of the app, so mark these first and then select more.';

const MESSAGE_TYPE_LABELS: Record<string, string> = {
  initial: "first contact",
  follow_up: "follow-up",
  negotiation: "counter-offer",
  response: "reply to them",
  acceptance: "deal confirmation",
};

function messageTypeLabel(type: string | null | undefined): string {
  if (!type) return "message";
  return MESSAGE_TYPE_LABELS[type] ?? type.replace(/_/g, " ");
}

/** Absolute local time, spelled out. "Held until 9:14 AM" with no date is how
 *  an operator sends something a day early. */
function formatWhen(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Every unsent outbound human_queue message across the loaded entries, in
 * working order: highest composite_score first, rows that cannot be sent last.
 *
 * `nowMs` is injected so the caller (and the tab count) decide the clock.
 */
function isQueuedDm(msg: DmQueueMessage): boolean {
  return msg.direction === "outbound" && !msg.sent_at && msg.send_mode === "human_queue";
}

export function dmQueueItems(entries: DmQueueEntry[], nowMs: number = Date.now()): QueueItem[] {
  const items: QueueItem[] = [];
  for (const entry of entries) {
    const influencer = entry.influencer;
    if (!influencer) continue;
    // Per-label do-not-contact: hidden, and counted by dmQueueWithheld.
    if (dmQueueWithholdReason(entry) !== null) continue;
    for (const msg of entry.messages) {
      if (!isQueuedDm(msg)) continue;
      const target = resolveDmTarget({
        channel: msg.channel,
        platform: influencer.platform,
        username: influencer.username,
        profileUrl: influencer.profile_url,
      });
      const refusal = dmMarkSentRefusal(msg, nowMs);
      const slot = entry.first_touch_slot;
      const copyMode = dmCopyMode(msg, slot, nowMs);
      items.push({
        entry,
        msg,
        influencer,
        target,
        refusal,
        copyMode,
        limitMessage: copyMode === "limit" && slot?.state === "limit_reached" ? slot.message : null,
        blocked: refusal !== null || !target.sendable || copyMode === "limit",
      });
    }
  }
  return items.sort((a, b) =>
    compareDmQueueOrder(
      {
        blocked: a.blocked,
        compositeScore: a.entry.composite_score ?? null,
        createdAt: a.msg.created_at,
        id: a.msg.id,
      },
      {
        blocked: b.blocked,
        compositeScore: b.entry.composite_score ?? null,
        createdAt: b.msg.created_at,
        id: b.msg.id,
      },
    ),
  );
}

/** Unsent queue DMs kept off the list, by reason. */
export function dmQueueWithheld(entries: DmQueueEntry[]): {
  doNotContact: number;
  unconfirmed: number;
} {
  const out = { doNotContact: 0, unconfirmed: 0 };
  for (const entry of entries) {
    if (!entry.influencer) continue;
    const why = dmQueueWithholdReason(entry);
    if (why === null) continue;
    const n = entry.messages.filter(isQueuedDm).length;
    if (why === "do_not_contact") out.doNotContact += n;
    else out.unconfirmed += n;
  }
  return out;
}

interface MarkTally {
  recorded: number;
  already: number;
  refused: number;
  rateLimited: number;
  failed: number;
}

function summarizeMarks(t: MarkTally): string {
  const parts: string[] = [];
  if (t.recorded) parts.push(`${t.recorded} recorded as sent`);
  if (t.already) parts.push(`${t.already} were already sent`);
  if (t.refused) parts.push(`${t.refused} refused by the safety checks`);
  if (t.rateLimited) parts.push(`${t.rateLimited} hit the rate limit. Try those again in a minute`);
  if (t.failed) parts.push(`${t.failed} failed`);
  return parts.join(" · ");
}

export function DmQueueTab({
  entries,
  onReload,
  testingMode,
  testRecipient,
}: {
  entries: DmQueueEntry[];
  onReload: () => Promise<void>;
  /** firms.testing_mode. null = we could not read it — say so, never guess. */
  testingMode?: boolean | null;
  testRecipient?: string | null;
}) {
  // One clock per mount for the held-until comparisons. Re-derived on reload
  // (and on the ticker below) rather than on every render, so a row cannot
  // flip mid-render and give the list a different length than the cursor math.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const items = useMemo(() => dmQueueItems(entries, nowMs), [entries, nowMs]);
  const withheld = useMemo(() => dmQueueWithheld(entries), [entries]);

  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copiedIds, setCopiedIds] = useState<Set<string>>(new Set());
  const [lastCopiedId, setLastCopiedId] = useState<string | null>(null);
  const [reservingId, setReservingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  // A counter draft's price: what the editor confirms when the
  // edited text alone can't say. The server refuses a mismatch with the text.
  const [editIsCounter, setEditIsCounter] = useState(false);
  const [editPrice, setEditPrice] = useState("");
  // The editor's explicit "yes, this counter offers $X" when the text
  // does not state that price itself. Cleared whenever the text or price moves.
  const [editPriceConfirmed, setEditPriceConfirmed] = useState(false);
  const editCheck = editIsCounter ? checkCounterEditPrice(editBody, editPrice) : null;
  const editBlocked =
    editCheck != null &&
    (editCheck.kind === "missing" || editCheck.kind === "mismatch" || (editCheck.kind === "confirm" && !editPriceConfirmed));
  // Any other DM's optional "Price quoted" field. The ONLY way a
  // price in a hand-edited DM is known; its text is never read for it.
  const [editQuoted, setEditQuoted] = useState("");
  const [editQuotedWas, setEditQuotedWas] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markProgress, setMarkProgress] = useState<{ done: number; total: number } | null>(null);
  const [sentThisSession, setSentThisSession] = useState(0);
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  // A creator's DM reply comes back here, not to any inbox the product reads.
  const [replyOpen, setReplyOpen] = useState(false);
  const replyLeads = useMemo(() => dmReplyLeads(entries), [entries]);
  const cursorRef = useRef<HTMLDivElement | null>(null);

  // A held row becomes sendable on its own. Re-evaluate once a minute so the
  // operator doesn't have to reload to find out — cheap, and no network.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safeCursor = total === 0 ? 0 : Math.min(cursor, total - 1);
  const page = Math.floor(safeCursor / PAGE_SIZE);
  const pageStart = page * PAGE_SIZE;
  const pageItems = items.slice(pageStart, pageStart + PAGE_SIZE);

  const blockedCount = items.filter((i) => i.blocked).length;
  const selectableOnPage = pageItems.filter((i) => !i.blocked).map((i) => i.msg.id);
  const allPageSelected =
    selectableOnPage.length > 0 && selectableOnPage.every((id) => selected.has(id));

  const byId = useMemo(() => {
    const m = new Map<string, QueueItem>();
    for (const item of items) m.set(item.msg.id, item);
    return m;
  }, [items]);

  // Keep the focused card on screen when the cursor moves by keyboard.
  useEffect(() => {
    cursorRef.current?.scrollIntoView({ block: "nearest" });
  }, [safeCursor, page]);

  const markCopied = useCallback((id: string) => {
    setLastCopiedId(id);
    setCopiedIds((prev) => new Set(prev).add(id));
    setTimeout(() => setLastCopiedId((cur) => (cur === id ? null : cur)), 2000);
  }, []);

  /** Reserve & copy: the text reaches the clipboard only if the slot is held. */
  const reserveAndCopy = useCallback(
    async (item: QueueItem) => {
      setReservingId(item.msg.id);
      const pending: Promise<{ ok: true; body: string } | { ok: false; message: string }> = fetch(
        `/api/outreach/messages/${item.msg.id}/reserve`,
        { method: "POST" },
      )
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as { body?: unknown; message?: unknown; error?: unknown };
          if (res.ok && typeof data.body === "string") return { ok: true as const, body: data.body };
          if (res.status === 429) {
            return { ok: false as const, message: "Too many requests just now. Wait a moment and try again." };
          }
          const limit = (FIRST_TOUCH_REFUSALS as readonly string[]).includes(String(data.error));
          return {
            ok: false as const,
            message:
              typeof data.message === "string" && data.message
                ? limit
                  ? `${data.message}. Nothing was copied.`
                  : data.message
                : "Couldn't reserve a slot. Nothing was copied.",
          };
        })
        .catch(() => ({ ok: false as const, message: "Network error. Nothing was copied." }));

      // The clipboard write starts inside the click, with the text still
      // pending: browsers drop a write that starts after a network round trip.
      let copied = false;
      try {
        if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
          await navigator.clipboard.write([
            new ClipboardItem({
              "text/plain": pending.then((r) => {
                if (!r.ok) throw new Error(r.message);
                return new Blob([r.body], { type: "text/plain" });
              }),
            }),
          ]);
          copied = true;
        }
      } catch {
        /* refused, or the browser declined the write: decided below */
      }
      const r = await pending;
      setReservingId(null);
      if (!r.ok) {
        toast.error(r.message);
        await onReload();
        return;
      }
      if (!copied) {
        try {
          await navigator.clipboard.writeText(r.body);
          copied = true;
        } catch {
          /* falls through */
        }
      }
      if (copied) markCopied(item.msg.id);
      else toast.error("Slot reserved, but your browser blocked the clipboard. Select the draft text and copy it by hand.");
      await onReload();
    },
    [markCopied, onReload],
  );

  const copyDraft = useCallback(
    async (item: QueueItem) => {
      if (item.copyMode === "limit") {
        toast.error(item.limitMessage ?? "Limit reached");
        return;
      }
      if (item.copyMode === "reserve") {
        await reserveAndCopy(item);
        return;
      }
      // DECISION: a DM has no subject line, so Copy puts the BODY on the
      // clipboard and nothing else. The subject is generated and stored upstream
      // and is shown on the card as context, labelled as not copied — pasting
      // "Subject: …" into an Instagram DM is the most obvious machine-tell there
      // is. Silently discarding it, which is what this button used to do, was the
      // same behaviour without the operator knowing.
      try {
        await navigator.clipboard.writeText(item.msg.body);
      } catch {
        toast.error("Your browser blocked the clipboard. Select the draft text and copy it by hand.");
        return;
      }
      markCopied(item.msg.id);
    },
    [markCopied, reserveAndCopy],
  );

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
          ...(editCheck && editCheck.kind !== "missing" ? { offer_usd: editCheck.usd } : {}),
          ...quotedPayload,
        }),
      });
      if (!res.ok) {
        const refusal = (await res.json().catch(() => null)) as
          | { message?: unknown; suggested_offer_usd?: unknown }
          | null;
        if (editIsCounter && !(Number(editPrice) > 0) && Number(refusal?.suggested_offer_usd) > 0) {
          setEditPrice(String(Number(refusal?.suggested_offer_usd)));
          setEditPriceConfirmed(false);
        }
        toast.error(
          res.status === 429
            ? "Too many requests just now. Wait a moment and save again."
            : typeof refusal?.message === "string" && refusal.message
              ? refusal.message
              : "Couldn't save your edits. Please try again.",
        );
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

  /** PATCH one row. Classifies every outcome — nothing is swallowed. Returns
   *  true when this id is worth retrying (rate-limited or a transient error);
   *  a refusal is never retryable. */
  async function markOne(messageId: string, tally: MarkTally): Promise<boolean> {
    try {
      const res = await fetch(`/api/outreach/messages/${messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mark_sent: true }),
      });
      if (res.ok) {
        tally.recorded++;
        return false;
      }
      if (res.status === 429) {
        tally.rateLimited++;
        return true;
      }
      if (res.status === 409) {
        let err: { error?: string; message?: string } = {};
        try {
          err = (await res.json()) as { error?: string; message?: string };
        } catch {
          /* unparseable — fall through to the generic refusal */
        }
        if (err.error === "already sent") tally.already++;
        else {
          tally.refused++;
          if (err.message) toast.error(err.message);
        }
        return false;
      }
      tally.failed++;
      return true;
    } catch {
      tally.failed++;
      return true;
    }
  }

  /** Paced so a full page never spikes the shared 'auth' bucket. */
  async function markSent(ids: string[]) {
    if (ids.length === 0) return;
    setMarking(true);
    setMarkProgress({ done: 0, total: ids.length });
    const tally: MarkTally = { recorded: 0, already: 0, refused: 0, rateLimited: 0, failed: 0 };
    // The ids that are worth trying again, tracked by IDENTITY rather than by
    // count: a count tells you three failed, not WHICH three, and re-selecting
    // "the last three" would drop the rows that actually need the retry.
    const retryable: string[] = [];
    try {
      for (let i = 0; i < ids.length; i += MARK_BATCH_SIZE) {
        const batch = ids.slice(i, i + MARK_BATCH_SIZE);
        const outcomes = await Promise.all(batch.map((id) => markOne(id, tally)));
        outcomes.forEach((again, n) => {
          if (again) retryable.push(batch[n]);
        });
        setMarkProgress({ done: Math.min(i + batch.length, ids.length), total: ids.length });
        if (i + MARK_BATCH_SIZE < ids.length) {
          await new Promise((r) => setTimeout(r, MARK_BATCH_PAUSE_MS));
        }
      }
    } finally {
      setMarking(false);
      setMarkProgress(null);
      setSentThisSession((n) => n + tally.recorded);
      // Leave exactly the retryable rows selected, so a retry is one click and
      // nothing that already landed can be sent twice.
      setSelected(new Set(retryable));
      const summary = summarizeMarks(tally);
      if (tally.recorded > 0 && retryable.length === 0 && tally.refused === 0) {
        toast.success(summary);
      } else if (summary) {
        toast.warning(summary);
      }
      setNowMs(Date.now());
      await onReload();
    }
  }

  function toggleSelected(id: string) {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
      setSelected(next);
      return;
    }
    if (next.size >= MAX_SELECTION) {
      toast.info(SELECTION_CAP_NOTE);
      return;
    }
    next.add(id);
    setSelected(next);
  }

  function toggleSelectAllOnPage() {
    const next = new Set(selected);
    if (allPageSelected) {
      for (const id of selectableOnPage) next.delete(id);
      setSelected(next);
      return;
    }
    let skipped = 0;
    for (const id of selectableOnPage) {
      if (next.has(id)) continue;
      if (next.size >= MAX_SELECTION) {
        skipped++;
        continue;
      }
      next.add(id);
    }
    setSelected(next);
    if (skipped > 0) toast.info(SELECTION_CAP_NOTE);
  }

  function moveCursor(delta: number) {
    setCursor((c) => {
      const base = total === 0 ? 0 : Math.min(c, total - 1);
      return Math.max(0, Math.min(total - 1, base + delta));
    });
  }

  // ── Keyboard flow ─────────────────────────────────────────────────────────
  // 300 near-identical rows is a keyboard task. j/k move, c copies, o opens the
  // profile, x selects, Enter asks to mark sent. Nothing fires while a textarea
  // has focus or a dialog is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (confirmIds !== null || editingId !== null || marking || replyOpen) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      // Enter on a focused button or link is that control's own activation.
      // Handling it here too would ask about the cursor row while the browser
      // clicks a different one.
      if (e.key === "Enter" && (tag === "BUTTON" || tag === "A")) return;

      const item = items[Math.min(cursor, Math.max(0, items.length - 1))];
      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          moveCursor(1);
          return;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          moveCursor(-1);
          return;
        case "c":
          if (item) void copyDraft(item);
          return;
        case "o":
          if (item?.target.url) window.open(item.target.url, "_blank", "noopener,noreferrer");
          return;
        case "x":
          if (item && !item.blocked) toggleSelected(item.msg.id);
          return;
        case "a":
          e.preventDefault();
          toggleSelectAllOnPage();
          return;
        case "Enter":
          e.preventDefault();
          if (selected.size > 0) setConfirmIds(Array.from(selected));
          else if (item && !item.blocked) setConfirmIds([item.msg.id]);
          return;
        case "Escape":
          setSelected(new Set());
          return;
        case "?":
          setShowKeys((s) => !s);
          return;
        default:
          return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, cursor, selected, confirmIds, editingId, marking, allPageSelected, replyOpen]);

  const confirmItems = (confirmIds ?? []).map((id) => byId.get(id)).filter((i): i is QueueItem => !!i);
  const uncopied = confirmItems.filter((i) => !copiedIds.has(i.msg.id));

  // ── Testing-mode notice ───────────────────────────────────────────────────
  const modeNotice =
    testingMode === true
      ? {
          tone: "warn" as const,
          title: "Testing mode does NOT protect this queue.",
          body:
            `Testing mode only rewrites EMAIL recipients (everything goes to ${
              testRecipient ?? "an internal inbox"
            } instead of the creator). It cannot touch a DM you paste from here. ` +
            "Anything you send out of this screen reaches the real creator, and this is the only " +
            "surface in the product where that is true.",
        }
      : testingMode === false
        ? {
            tone: "live" as const,
            title: "Live mode. These reach real creators.",
            body:
              "Email delivery is live and these DMs are sent by hand from your own account. " +
              "Every row is a real message to a real person.",
          }
        : {
            tone: "warn" as const,
            title: "We could not read your delivery mode.",
            body:
              "Whatever it says, it does not apply here: a DM you paste from this screen goes " +
              "straight to the creator either way.",
          };

  const replyDialog = (
    <DmReplyDialog
      open={replyOpen}
      onOpenChange={setReplyOpen}
      leads={replyLeads}
      onLogged={onReload}
    />
  );

  // Rows kept off the queue by the label's do-not-contact list. Counted, never
  // silently dropped; 'unconfirmed' is the fail-closed hold when the list
  // could not be read.
  const withheldNotice =
    withheld.doNotContact > 0 || withheld.unconfirmed > 0 ? (
      <div className="space-y-0.5 text-xs text-muted-foreground">
        {withheld.doNotContact > 0 && (
          <p className="flex items-center gap-1.5">
            <Ban className="h-3.5 w-3.5 shrink-0" />
            {withheld.doNotContact} {withheld.doNotContact === 1 ? "DM" : "DMs"} hidden. The
            creator is on your label&apos;s do-not-contact list (they opted out, or were blocked).
          </p>
        )}
        {withheld.unconfirmed > 0 && (
          <p className="flex items-center gap-1.5 text-attention-fg">
            <Clock className="h-3.5 w-3.5 shrink-0" />
            {withheld.unconfirmed} {withheld.unconfirmed === 1 ? "DM" : "DMs"} held. We
            couldn&apos;t confirm your label&apos;s do-not-contact list, so they stay off this
            list until it can be read. Reload in a minute.
          </p>
        )}
      </div>
    ) : null;

  if (total === 0) {
    return (
      <EmptyState
        title="No DMs waiting"
        action={
          replyLeads.length > 0 ? (
            <Button variant="outline" onClick={() => setReplyOpen(true)}>
              <Reply className="size-3.5" />
              Log reply
            </Button>
          ) : undefined
        }
      >
        Drafts for DM-channel creators land here to be sent by hand from your own account.
        {withheldNotice && <div className="mt-4 text-left">{withheldNotice}</div>}
        {replyDialog}
      </EmptyState>
    );
  }

  return (
    <div className="space-y-3">
      {/* 1. The consequence, before anything else on the screen. */}
      <div
        className={`rounded-lg border px-4 py-3.5 text-sm ${
          modeNotice.tone === "live"
            ? "border-destructive/30 bg-status-flagged/60"
            : "border-attention-border bg-attention"
        }`}
      >
        <p
          className={`flex items-start gap-2 font-semibold ${
            modeNotice.tone === "live" ? "text-destructive" : "text-foreground"
          }`}
        >
          <AlertTriangle
            className={`mt-0.5 size-4 shrink-0 ${
              modeNotice.tone === "live" ? "" : "text-attention-fg"
            }`}
          />
          {modeNotice.title}
        </p>
        <p className="mt-0.5 pl-6 text-meta text-muted-foreground">{modeNotice.body}</p>
      </div>

      {withheldNotice}

      {/* 2. Where you are, and how to move. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b py-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input accent-primary"
              checked={allPageSelected}
              disabled={selectableOnPage.length === 0}
              onChange={toggleSelectAllOnPage}
              aria-label="Select every sendable DM on this page"
            />
            <span>
              Select page ({selectableOnPage.length} sendable)
            </span>
          </label>
          <span className="text-foreground font-medium">
            Row {safeCursor + 1} of {total}
          </span>
          <span>
            showing {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, total)}
          </span>
          {sentThisSession > 0 && (
            <span className="text-foreground">{sentThisSession} marked sent this session</span>
          )}
          {blockedCount > 0 && (
            <span className="text-attention-fg">
              {blockedCount} can&apos;t be sent (bottom of the list)
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {replyLeads.length > 0 && (
            <Button size="sm" variant="outline" className="mr-2" onClick={() => setReplyOpen(true)}>
              <Reply className="h-3.5 w-3.5 mr-1" />
              Log reply
            </Button>
          )}
          <button
            type="button"
            onClick={() => setShowKeys((s) => !s)}
            className="mr-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
          >
            keys {showKeys ? "−" : "?"}
          </button>
          <Button
            size="sm"
            variant="ghost"
            disabled={page === 0}
            onClick={() => setCursor(Math.max(0, (page - 1) * PAGE_SIZE))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span>
            page {page + 1} / {pageCount}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={page >= pageCount - 1}
            onClick={() => setCursor(Math.min(total - 1, (page + 1) * PAGE_SIZE))}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {showKeys && (
        <div className="rounded-lg border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">j</span> / <span className="font-medium text-foreground">k</span> move,{" "}
          <span className="font-medium text-foreground">c</span> copy the draft (reserves a slot for a first contact),{" "}
          <span className="font-medium text-foreground">o</span> open their profile,{" "}
          <span className="font-medium text-foreground">x</span> select,{" "}
          <span className="font-medium text-foreground">a</span> select the page,{" "}
          <span className="font-medium text-foreground">Enter</span> mark sent (asks first),{" "}
          <span className="font-medium text-foreground">Esc</span> clear the selection. Paging
          happens automatically at the ends of a page.
        </div>
      )}

      {/* 3. The rows. */}
      {pageItems.map((item, idxOnPage) => {
        const { msg, influencer, target, refusal, entry } = item;
        const absoluteIndex = pageStart + idxOnPage;
        const isCursor = absoluteIndex === safeCursor;
        const isSelected = selected.has(msg.id);
        const held = refusal?.kind === "held" ? refusal.send_after ?? msg.send_after : null;

        return (
          <div
            key={msg.id}
            ref={isCursor ? cursorRef : undefined}
            className={`overflow-hidden rounded-lg border bg-card ${
              isCursor ? "border-primary/50 ring-2 ring-primary/20" : ""
            } ${item.blocked ? "opacity-70" : ""}`}
            onClick={() => setCursor(absoluteIndex)}
          >
            <div className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-input accent-primary shrink-0 disabled:opacity-30"
                    checked={isSelected}
                    disabled={item.blocked}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleSelected(msg.id)}
                    aria-label={`Select the DM for @${influencer.username}`}
                  />
                  <span className="text-sm font-semibold text-foreground">@{influencer.username}</span>
                  <Badge variant="outline" className="text-muted-foreground">
                    {target.label}
                    {target.inferred ? " (inferred)" : ""}
                  </Badge>
                  <Badge variant="secondary">
                    {messageTypeLabel(msg.message_type)}
                  </Badge>
                  {typeof entry.composite_score === "number" && (
                    <span className="text-[10px] text-muted-foreground">
                      score {entry.composite_score.toFixed(0)}
                      {entry.tier ? `, tier ${entry.tier}` : ""}
                    </span>
                  )}
                  {entry.campaign?.artist_name && (
                    <span className="text-xs text-muted-foreground truncate">
                      {entry.campaign.artist_name}
                    </span>
                  )}
                  {copiedIds.has(msg.id) && (
                    <span className="text-[10px] text-muted-foreground">copied</span>
                  )}
                </div>
                {target.url ? (
                  <a
                    href={target.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    title="Opens their public profile page. No link can open a DM inbox, so send from your own account."
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {target.urlLabel}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-attention-fg">
                    <Ban className="h-3.5 w-3.5" />
                    No {target.label} address stored
                  </span>
                )}
              </div>

              {/* Why this row cannot be sent — the only two things that block a
                  click, both stated in full rather than as a disabled button. */}
              {refusal && (
                <p className="flex items-start gap-2 rounded-md border border-attention-border bg-attention px-3 py-2 text-xs text-attention-fg">
                  {refusal.kind === "held" ? (
                    <Clock className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  ) : (
                    <Ban className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  )}
                  <span>
                    {held ? <strong>Held until {formatWhen(held)}. </strong> : null}
                    {refusal.message}
                  </span>
                </p>
              )}
              {!refusal && item.limitMessage && (
                <p className="flex items-start gap-2 rounded-md border border-attention-border bg-attention px-3 py-2 text-xs text-attention-fg">
                  <Ban className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>
                    <strong>Limit reached. </strong>
                    {item.limitMessage}. Don&apos;t send this DM.
                  </span>
                </p>
              )}
              {!refusal && !item.limitMessage && target.blockedReason && (
                <p className="flex items-start gap-2 rounded-md border border-attention-border bg-attention px-3 py-2 text-xs text-attention-fg">
                  <Ban className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>{target.blockedReason}</span>
                </p>
              )}
              {/* A send_after in the past is still information: this row was
                  deliberately deferred and is now due. */}
              {!refusal && parseSendAfter(msg.send_after) !== null && (
                <p className="text-xs text-muted-foreground">
                  Scheduled for {formatWhen(msg.send_after as string)}, due now.
                </p>
              )}

              {editingId === msg.id ? (
                <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                  <Textarea
                    value={editBody}
                    onChange={(e) => {
                      setEditBody(e.target.value);
                      setEditPriceConfirmed(false);
                      const stated = editIsCounter ? readStatedPrice(e.target.value) : null;
                      if (stated?.kind === "one") setEditPrice(String(stated.usd));
                    }}
                    rows={6}
                    className="text-sm"
                  />
                  {editIsCounter && (
                    <div className="flex items-center gap-2">
                      <label htmlFor={`dm-counter-price-${msg.id}`} className="text-xs text-muted-foreground">
                        Price this counter offers ($)
                      </label>
                      <input
                        id={`dm-counter-price-${msg.id}`}
                        type="number"
                        min={1}
                        step="1"
                        inputMode="decimal"
                        value={editPrice}
                        onChange={(e) => {
                          setEditPrice(e.target.value);
                          setEditPriceConfirmed(false);
                        }}
                        className="h-8 w-28 rounded-md border bg-background px-2 text-sm"
                      />
                      <span className="text-[11px] text-muted-foreground">
                        Must match the price in the message.
                      </span>
                    </div>
                  )}
                  {!editIsCounter && (
                    <div className="flex items-center gap-2">
                      <label htmlFor={`dm-quoted-price-${msg.id}`} className="text-xs text-muted-foreground">
                        Price quoted ($, optional)
                      </label>
                      <input
                        id={`dm-quoted-price-${msg.id}`}
                        type="number"
                        min={1}
                        step="1"
                        inputMode="decimal"
                        value={editQuoted}
                        onChange={(e) => setEditQuoted(e.target.value)}
                        className="h-8 w-28 rounded-md border bg-background px-2 text-sm"
                      />
                      <span className="text-[11px] text-muted-foreground">
                        Only if this DM offers a price. A price in the text alone is not recorded.
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
                    <p className="text-xs text-muted-foreground">
                      Drafted subject line (not copied, a DM has no subject):{" "}
                      <span className="italic">{msg.subject}</span>
                    </p>
                  )}
                  <p className="text-sm whitespace-pre-wrap rounded-lg border bg-card p-3">
                    {msg.body}
                  </p>
                </>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                {item.copyMode === "limit" ? (
                  <Badge variant="outline" className="h-8 gap-1 border-attention-border px-2.5 text-xs text-attention-fg">
                    <Ban className="h-3.5 w-3.5" />
                    Limit reached
                  </Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={reservingId === msg.id}
                    title={
                      item.copyMode === "reserve"
                        ? "Holds one of this campaign's first-contact slots for 24 hours, then copies the draft."
                        : undefined
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      void copyDraft(item);
                    }}
                  >
                    {reservingId === msg.id ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                        Reserving…
                      </>
                    ) : lastCopiedId === msg.id ? (
                      <>
                        <Check className="h-3.5 w-3.5 mr-1 text-status-locked-fg" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5 mr-1" />
                        {item.copyMode === "reserve" ? "Reserve & copy" : "Copy draft"}
                      </>
                    )}
                  </Button>
                )}
                {item.copyMode === "reserved" && msg.dm_reserved_at && (
                  <span className="text-[11px] text-muted-foreground">
                    Slot held until {formatWhen(reservationExpiresAt(msg.dm_reserved_at) ?? msg.dm_reserved_at)}
                  </span>
                )}
                {editingId !== msg.id && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(msg.id);
                      setEditBody(msg.body);
                      setEditIsCounter(msg.message_type === "counter");
                      const stated = readStatedPrice(msg.body);
                      setEditPrice(
                        msg.offer_usd != null && Number(msg.offer_usd) > 0
                          ? String(Number(msg.offer_usd))
                          : stated.kind === "one"
                            ? String(stated.usd)
                            : "",
                      );
                      setEditPriceConfirmed(false);
                      const was = msg.message_type !== "counter" && Number(msg.offer_usd) > 0 ? Number(msg.offer_usd) : null;
                      setEditQuoted(was != null ? String(was) : "");
                      setEditQuotedWas(was);
                    }}
                  >
                    Edit
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={item.blocked || marking}
                  title={
                    refusal?.message ??
                    item.limitMessage ??
                    target.blockedReason ??
                    "Records the send, advances the lead and opens a priced offer."
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmIds([msg.id]);
                  }}
                >
                  <CheckCheck className="h-3.5 w-3.5 mr-1" />
                  Mark sent
                </Button>
              </div>
            </div>
          </div>
        );
      })}

      {/* 4. Bulk bar. Mirrors the email tab's sticky selection bar. */}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-sm">
              <span className="font-medium">{selected.size} selected</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelected(new Set())}
                disabled={marking}
              >
                Clear
              </Button>
            </div>
            <Button size="sm" disabled={marking} onClick={() => setConfirmIds(Array.from(selected))}>
              {marking ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  {markProgress
                    ? `Recording ${markProgress.done} of ${markProgress.total}…`
                    : "Recording…"}
                </>
              ) : (
                <>
                  <CheckCheck className="h-4 w-4 mr-1.5" />
                  Mark {selected.size} sent
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {/* 5. The confirmation. Names the creator, states the consequence, and
             says plainly that there is no undo — because there is no unsend
             route anywhere in this codebase. */}
      <Dialog open={confirmIds !== null} onOpenChange={(open) => !open && setConfirmIds(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmItems.length === 1
                ? `Record the DM to @${confirmItems[0]?.influencer.username} as sent?`
                : `Record ${confirmItems.length} DMs as sent?`}
            </DialogTitle>
            <DialogDescription>
              Only do this for DMs you have already sent from your own account.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-left text-sm text-muted-foreground">
            <p>
              For each one this marks the message sent, moves the creator to{" "}
              <strong>contacted</strong>, and <strong>opens a priced, negotiable offer</strong> that
              the auto-negotiator will run with from their first reply.
            </p>
            {confirmItems.length === 1 ? (
              <p className="text-foreground">
                <strong>@{confirmItems[0]?.influencer.username}</strong>
                {confirmItems[0]?.entry.campaign?.artist_name
                  ? ` · ${confirmItems[0]?.entry.campaign?.artist_name}`
                  : ""}{" "}
                · {confirmItems[0]?.target.label} ·{" "}
                {messageTypeLabel(confirmItems[0]?.msg.message_type)}
              </p>
            ) : (
              <p className="max-h-32 overflow-y-auto text-foreground">
                {confirmItems.map((i) => `@${i.influencer.username}`).join(", ")}
              </p>
            )}
            {uncopied.length > 0 && (
              <p className="text-attention-fg">
                {uncopied.length === confirmItems.length
                  ? confirmItems.length === 1
                    ? "You have not copied this draft on this screen. Are you sure it was sent?"
                    : "None of these drafts were copied on this screen. Are you sure they were sent?"
                  : `${uncopied.length} of these were never copied on this screen.`}
              </p>
            )}
            <p className="font-medium text-foreground">
              There is no undo. Nothing in the product can un-send a message or withdraw the offer
              this opens.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmIds(null)} disabled={marking}>
              Cancel
            </Button>
            <Button
              disabled={marking}
              onClick={() => {
                const ids = confirmIds ?? [];
                setConfirmIds(null);
                void markSent(ids);
              }}
            >
              {confirmItems.length === 1 ? "Yes, it was sent" : `Yes, all ${confirmItems.length} were sent`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {replyDialog}

      {/* Keeps the last card clear of the sticky bar. */}
      {selected.size > 0 && <div className="h-16" aria-hidden />}
    </div>
  );
}
