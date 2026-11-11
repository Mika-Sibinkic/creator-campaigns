"use client";

// The creator card's quality lines (campaign page, ranked creators):
//   - free signals from stored post stats (src/lib/quality-signals.ts), e.g.
//     "Views 2.5x followers · 1.97 comments per 100 likes";
//   - the comment audit, when one ran (migration 066, src/lib/comment-audit.ts):
//     "Comments: 8% negative · 3 posts / 84 comments", samples on hover;
//   - a held creator: "Held: comments" with an Override button. Overriding
//     asks for a reason and is audited server-side.
// Renders nothing it has no data for, so pre-066 rows look as before plus the
// signals line.

import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  COMMENT_HELD_LABEL,
  commentAuditLine,
  commentSamplesTitle,
} from "@/lib/comment-audit";
import { computeQualitySignals, qualitySignalsLine } from "@/lib/quality-signals";

interface CardAudit {
  negative_share: number | null;
  posts_count: number;
  comments_count: number;
  insufficient: boolean;
  consistent_negative: boolean;
  held: boolean;
  samples: unknown;
}

interface RowShape {
  id?: string;
  comment_held?: boolean | null;
  comment_override?: unknown;
  comment_audit?: CardAudit | null;
  influencer?: {
    follower_count?: number | null;
    raw_data?: { posts?: unknown } | null;
  } | null;
}

export function CreatorQualityLines({
  row,
  campaignId,
  onChanged,
}: {
  row: object;
  campaignId: string;
  onChanged?: () => void;
}) {
  const r = row as RowShape;
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const signals = computeQualitySignals(r.influencer?.raw_data?.posts, r.influencer?.follower_count ?? null);
  const signalsLine = qualitySignalsLine(signals);
  const audit = r.comment_audit ?? null;
  const held = r.comment_held === true && r.comment_override == null;

  async function saveOverride() {
    if (!r.id || reason.trim().length < 3) {
      toast.error("Say why in a few words before overriding.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/comment-override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_influencer_id: r.id, reason: reason.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        toast.error(body.message ?? "Couldn't save the override. Try again.");
        return;
      }
      toast.success("Hold cleared. This creator can be contacted.");
      setOverriding(false);
      setReason("");
      onChanged?.();
    } finally {
      setSaving(false);
    }
  }

  if (!signalsLine && !audit && !held) return null;
  return (
    <div className="space-y-1">
      {signalsLine && (
        <div className="text-xs text-muted-foreground truncate" title="From recent post stats. Not yet checked against deal outcomes.">
          {signalsLine}
        </div>
      )}
      {audit && (
        <div
          className={`text-xs truncate cursor-help ${audit.consistent_negative && !audit.insufficient ? "text-attention-fg" : "text-muted-foreground"}`}
          title={commentSamplesTitle(audit.samples)}
        >
          {commentAuditLine(audit)}
        </div>
      )}
      {held && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="border-attention-border text-attention-fg">
            {COMMENT_HELD_LABEL}
          </Badge>
          {!overriding ? (
            <Button size="sm" variant="ghost" onClick={() => setOverriding(true)}>
              Override
            </Button>
          ) : (
            <>
              <Input
                className="h-8 max-w-64"
                placeholder="Why is this creator OK to contact?"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-label="Override reason"
              />
              <Button size="sm" onClick={saveOverride} disabled={saving}>
                Confirm override
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOverriding(false)} disabled={saving}>
                Cancel
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
