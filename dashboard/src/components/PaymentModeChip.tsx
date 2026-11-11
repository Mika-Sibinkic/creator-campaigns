"use client";

// Operator header chip: the payments mode money actually moves in, from
// GET /api/payments/mode (the platform setting under the env ceiling; one
// database row, never a Stripe call). Replaces the static "Paper-money mode"
// chip, which was wrong under stripe_test. Render it inside <OperatorOnly>.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { paymentModeChip, type PaymentModeTone } from "@/lib/payment-mode-copy";

const TONE_CLASSES: Record<PaymentModeTone, string> = {
  paper: "bg-paper-money text-paper-money-fg",
  test: "border border-border bg-muted text-foreground",
  live: "bg-destructive font-semibold tracking-wide text-white",
};

// One fetch per 30s across every AppShell mount, so page navigation does not
// re-ask on each screen. A switch made in Settings calls refreshPaymentModeChip.
const TTL_MS = 30_000;
let cached: { at: number; mode: Promise<string | null> } | null = null;
const listeners = new Set<(mode: string | null) => void>();

function fetchMode(): Promise<string | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.mode;
  const mode = fetch("/api/payments/mode", { cache: "no-store" })
    .then(async (r) => (r.ok ? ((await r.json()) as { mode?: string }).mode ?? null : null))
    .catch(() => null);
  cached = { at: Date.now(), mode };
  return mode;
}

/** Drop the cache and re-read; every mounted chip updates. */
export function refreshPaymentModeChip(): void {
  cached = null;
  void fetchMode().then((m) => listeners.forEach((l) => l(m)));
}

export function PaymentModeChip({ className }: { className?: string }) {
  const [mode, setMode] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const listener = (m: string | null) => {
      if (mounted) setMode(m);
    };
    listeners.add(listener);
    void fetchMode().then(listener);
    return () => {
      mounted = false;
      listeners.delete(listener);
    };
  }, []);

  if (!mode) return null;
  const chip = paymentModeChip(mode);
  return (
    <span
      data-payment-mode={mode}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium",
        TONE_CLASSES[chip.tone],
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {chip.label}
    </span>
  );
}
