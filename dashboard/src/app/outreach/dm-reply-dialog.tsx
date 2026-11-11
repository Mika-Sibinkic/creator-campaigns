"use client";

// src/app/outreach/dm-reply-dialog.tsx
//
// Log a creator's DM reply so the negotiator can answer it. Used from the DM
// queue (pick the creator) and from a lead's expanded view on /outreach (creator
// fixed). Both post to /api/outreach/dm-reply; the rules live in
// src/lib/dm-reply.ts. The negotiator's answer comes back into the DM queue as a
// draft — nothing on this path sends.

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DM_REPLY_CHANNELS,
  DM_REPLY_CHANNEL_LABELS,
  isDmReplyChannel,
  type DmReplyChannel,
  type DmReplyLead,
} from "@/lib/dm-reply";

type PostResult =
  | { ok: true; negotiatorWillAnswer: boolean; deduped: boolean }
  | { ok: false; message: string };

/** One POST to /api/outreach/dm-reply, every outcome classified. */
export async function postDmReply(args: {
  campaignInfluencerId: string;
  channel: DmReplyChannel;
  text: string;
  submissionId: string;
}): Promise<PostResult> {
  try {
    const res = await fetch("/api/outreach/dm-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaign_influencer_id: args.campaignInfluencerId,
        channel: args.channel,
        text: args.text,
        submission_id: args.submissionId,
      }),
    });
    if (res.status === 429) {
      return { ok: false, message: "Too many requests just now. Wait a moment and try again." };
    }
    const data = (await res.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
      negotiator_will_answer?: boolean;
      deduped?: boolean;
    };
    if (!res.ok) {
      return { ok: false, message: data.message ?? "Couldn't log that reply. Please try again." };
    }
    return {
      ok: true,
      negotiatorWillAnswer: data.negotiator_will_answer === true,
      deduped: data.deduped === true,
    };
  } catch {
    return { ok: false, message: "Network error while logging the reply. Check your connection." };
  }
}

/** The toast for a logged reply. Says plainly when nothing will answer it. */
export function announceDmReply(result: Extract<PostResult, { ok: true }>): void {
  if (result.deduped) {
    toast.info("That reply was already logged.");
  } else if (result.negotiatorWillAnswer) {
    toast.success("Reply logged. The answer will appear in the DM queue.");
  } else {
    toast.warning("Reply logged. There is no offer for this creator yet, so nothing will answer it automatically.");
  }
}

function newSubmissionId(): string {
  return crypto.randomUUID();
}

const CHANNEL_ITEMS = Object.fromEntries(
  DM_REPLY_CHANNELS.map((c) => [c, DM_REPLY_CHANNEL_LABELS[c]]),
) as Record<DmReplyChannel, string>;

export function DmReplyDialog({
  open,
  onOpenChange,
  leads,
  onLogged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Leads a DM has actually gone to (dmReplyLeads). */
  leads: DmReplyLead[];
  onLogged: () => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Mounted only while open, so every open starts from a clean form. */}
        {open && <DmReplyForm leads={leads} onClose={() => onOpenChange(false)} onLogged={onLogged} />}
      </DialogContent>
    </Dialog>
  );
}

function DmReplyForm({
  leads,
  onClose,
  onLogged,
}: {
  leads: DmReplyLead[];
  onClose: () => void;
  onLogged: () => Promise<void>;
}) {
  const [leadId, setLeadId] = useState<string>(() => leads[0]?.id ?? "");
  const [channel, setChannel] = useState<DmReplyChannel>(() => leads[0]?.channel ?? "instagram_dm");
  const [text, setText] = useState("");
  const [logging, setLogging] = useState(false);
  // One id per reply being written, reused across retries of that reply, so a
  // double submit or a retry after a network error is written once. Any edit
  // (creator, channel, text) makes it a different reply: cleared, re-minted on
  // the next submit.
  const submissionRef = useRef<string>("");

  const leadItems = Object.fromEntries(
    leads.map((l) => [l.id, `@${l.username}${l.artist_name ? ` · ${l.artist_name}` : ""}`]),
  );

  async function submit() {
    if (!leadId || !text.trim()) return;
    if (!submissionRef.current) submissionRef.current = newSubmissionId();
    setLogging(true);
    const result = await postDmReply({
      campaignInfluencerId: leadId,
      channel,
      text,
      submissionId: submissionRef.current,
    });
    setLogging(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    announceDmReply(result);
    onClose();
    await onLogged();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Log a DM reply</DialogTitle>
      </DialogHeader>
      {leads.length === 0 ? (
        <p className="text-sm text-muted-foreground">No DMs have been marked sent yet.</p>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="dm-reply-creator">Creator</Label>
            <Select
              items={leadItems}
              value={leadId}
              onValueChange={(v) => {
                const id = String(v ?? "");
                setLeadId(id);
                const lead = leads.find((l) => l.id === id);
                if (lead) setChannel(lead.channel);
                submissionRef.current = "";
              }}
            >
              <SelectTrigger id="dm-reply-creator" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {leads.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {leadItems[l.id]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dm-reply-channel">Channel</Label>
            <Select
              items={CHANNEL_ITEMS}
              value={channel}
              onValueChange={(v) => {
                if (isDmReplyChannel(v)) {
                  setChannel(v);
                  submissionRef.current = "";
                }
              }}
            >
              <SelectTrigger id="dm-reply-channel" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DM_REPLY_CHANNELS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {DM_REPLY_CHANNEL_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dm-reply-text">Their reply</Label>
            <Textarea
              id="dm-reply-text"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                submissionRef.current = "";
              }}
              rows={5}
              className="text-sm"
            />
          </div>
        </div>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={logging}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={logging || !leadId || !text.trim()}>
          {logging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Log reply"}
        </Button>
      </DialogFooter>
    </>
  );
}
