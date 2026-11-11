// src/components/CampaignProgress.tsx
//
// Client-side SSE consumer for POST /api/campaigns/[id]/run.
//
// This is on screen while a label watches a discovery run, so it has to tell
// the truth about what happened — including the boring and the bad outcomes.
// It previously knew only 3 of the route's 6 event names and 4 of its 5 steps,
// so a run that found ZERO creators rendered as four green dots and a full
// progress bar next to an empty list.
//
// All of the stream vocabulary and state transitions live in
// src/lib/run-progress.ts (pure, tested by tests/run-progress.test.ts — there
// is no browser harness in this repo). This file is the rendering only.
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  DISCOVERY_STEPS,
  ERROR_COPY,
  STEP_LABELS,
  describeFilters,
  incompleteSteps,
  initialRunState,
  parseSseFrames,
  reduceRun,
  runPercent,
  type RunState,
} from "@/lib/run-progress";

export function CampaignProgress({
  campaignId,
  onDone,
  primary = true,
}: {
  campaignId: string;
  onDone?: () => void;
  /** True when discovery is the campaign's current step. The campaign page
   *  gives exactly one card the filled button; the rest are outlines. */
  primary?: boolean;
}) {
  const [state, setState] = useState<RunState>(() => initialRunState(false));
  const [hasRun, setHasRun] = useState(false);

  async function run() {
    setState(initialRunState(true));
    setHasRun(true);
    const fail = (message: string) =>
      setState((s) => ({
        ...s,
        running: false,
        // First error wins; the route can send a terse duplicate after a
        // detailed one.
        error: s.error || message,
      }));
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/run`, {
        method: "POST",
      });
      // A non-2xx (e.g. 412 campaign_not_confirmed) still has a body — it's the
      // JSON error, NOT an SSE stream. Check res.ok BEFORE reading the stream,
      // otherwise the error is silently swallowed and the button just resets.
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (j.error === "campaign_not_confirmed") {
          // Route through the confirm gate (it sets the negotiation cap etc.).
          window.location.assign(`/campaigns/${campaignId}/confirm`);
          return;
        }
        console.error(
          `[discovery] POST /api/campaigns/${campaignId}/run → HTTP ${res.status}`,
          j
        );
        fail(
          (j.error && ERROR_COPY[j.error]) ||
            "Discovery couldn’t start. Nothing was charged. Try again, and if it keeps happening send a screenshot."
        );
        return;
      }
      if (!res.body) {
        fail("Discovery started but sent nothing back. Try again.");
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      // The route always closes AFTER emitting `done` or `error`
      // (run/route.ts finally). So a reader that ends without one of them means
      // the stream was cut — a platform timeout, a proxy, a throttled tab. That
      // used to be completely silent: the bar froze mid-run, one step span
      // forever, and nothing on screen said why.
      let sawTerminal = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const { frames, rest } = parseSseFrames(buf);
        buf = rest;
        for (const frame of frames) {
          if (frame.event === "error") {
            console.error("[discovery] run error", frame.data);
          }
          if (frame.event === "done" || frame.event === "error") sawTerminal = true;
          setState((s) => reduceRun(s, frame));
          if (frame.event === "done") onDone?.();
        }
      }
      if (!sawTerminal) {
        console.error("[discovery] stream ended with no done/error frame");
        // Sweep the spinner via the same reducer path rather than by hand, so
        // there is one definition of "still running when it ended".
        setState((s) => reduceRun(s, { event: "error", data: { code: "stream_truncated" } }));
      }
    } catch (e) {
      console.error("[discovery] stream failed", e);
      fail(
        "The connection to the discovery run dropped. Reload the page to see where it got to."
      );
    } finally {
      setState((s) => ({ ...s, running: false }));
    }
  }

  const { steps, running, error, outcome, filters } = state;
  const failed = DISCOVERY_STEPS.some((k) => steps[k].status === "error");
  /** Steps the run abandoned — non-empty means "partial", not "done". */
  const partial = incompleteSteps(steps);
  const pct = runPercent(steps);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={run}
          disabled={running}
          variant={primary ? "default" : "outline"}
        >
          {running ? "Running…" : hasRun ? "Run discovery again" : "Run discovery"}
        </Button>
        {/* A run buys a creator search and several AI steps. Saying so at the button
            is the difference between a control and a surprise on an invoice. */}
        <span className="text-xs text-muted-foreground">
          Each run costs about $0.35 in search and AI time.
        </span>
      </div>

      {/* Before the first run there is nothing to report. An all-grey step list
          with a 0% bar reads as "this is broken", which is its own demo bug. */}
      {hasRun && (
        <>
          <Progress value={pct} />
          <div className="space-y-1">
            {DISCOVERY_STEPS.map((k) => {
              const s = steps[k];
              // `incomplete` reads as neither success nor failure on purpose —
              // an amber half-ring, because that is exactly what is known.
              const dot =
                s.status === "done"
                  ? "●"
                  : s.status === "running"
                    ? "◐"
                    : s.status === "error"
                      ? "✗"
                      : s.status === "incomplete"
                        ? "◌"
                        : "○";
              const dotColor =
                // Progress is not news: done is quiet, running carries the
                // one accent, only an error is red.
                s.status === "done"
                  ? "text-foreground"
                  : s.status === "running"
                    ? "text-primary"
                    : s.status === "error"
                      ? "text-destructive"
                      : s.status === "incomplete"
                        ? "text-attention-fg"
                        : "text-faint";
              return (
                <div key={k} className="flex items-center gap-2 text-sm">
                  <span className={`w-4 ${dotColor}`} aria-hidden>
                    {dot}
                  </span>
                  <span className="w-32 shrink-0">{STEP_LABELS[k]}</span>
                  <span className="text-muted-foreground">
                    {s.message ?? ""}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {filters && (
        <p className="text-sm text-muted-foreground">
          {describeFilters(filters)}
        </p>
      )}

      {outcome?.kind === "empty" && !failed && !error && (
        <div
          role="status"
          className="rounded-lg border border-attention-border bg-attention px-4 py-3 text-sm text-attention-fg"
        >
          <p className="font-medium">This run found no creators to add.</p>
          <p className="mt-1">
            The search ran and finished, but nothing cleared the quality bar for
            this artist, so nothing was added to the list. Widen the campaign
            brief or try a different reference artist, then run it again.
          </p>
        </div>
      )}

      {/* A partial run added real creators, so the count is true — but a bare
          "Added 24 creators" next to a step that never finished reads as an
          unqualified success. Name the gap instead. */}
      {outcome?.kind === "found" && !error && partial.length > 0 && (
        <div
          role="status"
          className="rounded-lg border border-attention-border bg-attention px-4 py-3 text-sm text-attention-fg"
        >
          <p className="font-medium">
            Added {outcome.total} creator{outcome.total === 1 ? "" : "s"}, but the
            run did not finish every step.
          </p>
          <p className="mt-1">
            {partial.map((k) => STEP_LABELS[k]).join(" and ")} stopped without
            reporting back, so those creators have not been through it. The list
            is usable; run discovery again if you need that step applied.
          </p>
        </div>
      )}

      {outcome?.kind === "found" && !error && partial.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Added {outcome.total} creator{outcome.total === 1 ? "" : "s"} to this
          campaign.
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}
    </div>
  );
}
