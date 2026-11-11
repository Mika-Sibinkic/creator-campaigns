"use client";

// "Check comments (≈$2 per run)" on the new-campaign form (migration 066,
// src/lib/comment-audit.ts). Renders nothing until /api/campaigns/comment-audit
// says the columns exist, so a pre-066 database never sees a setting it
// cannot store. The dollar figure comes from the active comment provider.

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { commentToggleLabel } from "@/lib/comment-audit";

export function CommentAuditToggle({
  checked,
  onChange,
  onSupported,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Told once whether the feature exists, so the form never sends it pre-066. */
  onSupported?: (supported: boolean) => void;
}) {
  const [probe, setProbe] = useState<{ supported: boolean; estimate: number | null }>({
    supported: false,
    estimate: null,
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/campaigns/comment-audit", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { supported: false }))
      .then((j: { supported?: boolean; estimate_usd?: number }) => {
        if (cancelled) return;
        const supported = j.supported === true;
        setProbe({ supported, estimate: typeof j.estimate_usd === "number" ? j.estimate_usd : null });
        onSupported?.(supported);
      })
      .catch(() => {
        /* probe failed: keep the toggle hidden */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!probe.supported) return null;
  return (
    <div className="flex items-center gap-3">
      <Switch id="comment_audit_enabled" checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor="comment_audit_enabled">{commentToggleLabel(probe.estimate)}</Label>
    </div>
  );
}
