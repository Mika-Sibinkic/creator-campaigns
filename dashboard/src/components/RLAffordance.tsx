"use client";

import { useState } from "react";
import { ThumbsDown, ThumbsUp, Pencil } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Feedback trio — 👍 / 👎 / take it over.
 *
 * Wires every visible AI action to `/api/rl/signal` so the pricing and
 * outreach models get a continuous corrective stream from whoever is watching.
 * One mounted instance per event row; idempotent server-side (audit_log is
 * append-only, so a double-click just creates two rows — still useful signal).
 *
 * The user-visible copy here is deliberately plain: this renders on the home
 * activity feed and on /approvals, both of which a label sees. It used to name
 * an individual and carry an internal acronym in the accessibility tree, read
 * aloud by screen readers. The /approvals call site kept printing the acronym
 * next to it too; it now asks the question in words.
 *
 * Each control's aria-label and its tooltip say DIFFERENT things on purpose.
 * The override pair used to be byte-identical, so a screen reader announced
 * the same sentence twice for one button.
 */
export function RLAffordance({
  eventId,
  context,
  onOverride,
  className,
  size = "sm",
}: {
  eventId: string;
  context?: Record<string, unknown>;
  onOverride?: () => void;
  className?: string;
  size?: "xs" | "sm";
}) {
  const [signal, setSignal] = useState<"up" | "down" | null>(null);
  const [pending, setPending] = useState(false);

  const btnSize = size === "xs" ? "icon-xs" : "icon-sm";
  const iconSize = size === "xs" ? "size-3" : "size-3.5";

  async function send(kind: "up" | "down" | "override") {
    if (pending) return;
    setPending(true);
    try {
      const r = await fetch("/api/rl/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: eventId, kind, context }),
      });
      // fetch does not reject on 4xx/5xx. Without this check the button lit up
      // as "recorded" even when the server refused it — a control that looks
      // like it worked and didn't.
      if (!r.ok) {
        console.error(`[feedback] POST /api/rl/signal → HTTP ${r.status}`);
        return;
      }
      if (kind === "up" || kind === "down") {
        setSignal((prev) => (prev === kind ? null : kind));
      }
    } catch (e) {
      // Silent on screen — a missing training row isn't worth interrupting
      // the user over — but it must not silently look successful either.
      console.error("[feedback] signal failed", e);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={cn("inline-flex items-center gap-0.5", className)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={signal === "up" ? "default" : "ghost"}
              size={btnSize}
              onClick={() => void send("up")}
              disabled={pending}
              aria-label="Mark this as the right call"
            >
              <ThumbsUp className={iconSize} />
            </Button>
          }
        />
        <TooltipContent>Right call, do more of this</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={signal === "down" ? "destructive" : "ghost"}
              size={btnSize}
              onClick={() => void send("down")}
              disabled={pending}
              aria-label="Mark this as the wrong call"
            >
              <ThumbsDown className={iconSize} />
            </Button>
          }
        />
        <TooltipContent>Wrong call, do less of this</TooltipContent>
      </Tooltip>
      {onOverride && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size={btnSize}
                onClick={() => {
                  void send("override");
                  onOverride();
                }}
                disabled={pending}
                aria-label="Handle this one yourself"
              >
                <Pencil className={iconSize} />
              </Button>
            }
          />
          <TooltipContent>
            Stop the automatic replies on this one and take it over
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
