"use client";

// Settings → Payments. Labels see one read-only badge: whether approving a
// payout moves real money. Operators also see the Stripe account, the live
// balance, the readiness checklist and the Test/Live switch
// (GET /api/payments/status, POST /api/payments/mode). The server re-runs the
// checklist on every switch; nothing here is trusted for the decision.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, CircleHelp, X } from "lucide-react";
import { SettingsSection } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useIsOperator } from "@/components/OperatorContext";
import { refreshPaymentModeChip } from "@/components/PaymentModeChip";
import { cn } from "@/lib/utils";

const SWITCH_CONFIRMATION = "SWITCH TO LIVE";

type Tone = "neutral" | "live";

const MODE_COPY: Record<string, { label: string; tone: Tone; copy: string }> = {
  paper: {
    label: "Test mode",
    tone: "neutral",
    copy: "No money moves yet. Approving a payout records the amount you agreed; nothing reaches the creator's account.",
  },
  stripe_test: {
    label: "Test mode",
    tone: "neutral",
    copy: "Connected to a test payment account. Approving a payout records it; no money moves.",
  },
  stripe_live: {
    label: "Live",
    tone: "live",
    copy: "Live payments are on. Approved payouts move real money. Review each one carefully.",
  },
  paypal_sandbox: {
    label: "Test mode",
    tone: "neutral",
    copy: "Connected to a test payment account. Approving a payout records it; no money moves.",
  },
  paypal_live: {
    label: "Live",
    tone: "live",
    copy: "Live payments are on. Approved payouts move real money. Review each one carefully.",
  },
};

const OPERATOR_MODE_LABEL: Record<string, string> = {
  paper: "Paper money",
  stripe_test: "Stripe test",
  stripe_live: "Stripe live",
  paypal_sandbox: "PayPal sandbox",
  paypal_live: "PayPal live",
};

interface ChecklistItem {
  id: string;
  label: string;
  ok: boolean;
  unknown?: boolean;
  detail: string | null;
  fix: string | null;
  rows?: { id: string; amount_usd: number; status: string; mode: string | null }[];
}

interface PaymentsStatus {
  mode: string;
  stripe_mode: "stripe_test" | "stripe_live" | null;
  ceiling: string;
  live_allowed: boolean;
  settings_applied: boolean;
  switched_by: string | null;
  switched_at: string | null;
  account: { mode: string; id: string; display_name: string | null } | null;
  account_error: string | null;
  balance: { available_usd: number; pending_usd: number } | null;
  balance_needed_usd: number | null;
  checklist: ChecklistItem[];
  ready: boolean;
}

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

function ModeBadge({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded px-1.5 text-xs font-medium",
        // Live is the one state on this card that moves real money, so it is
        // the only loud one.
        tone === "live" ? "bg-destructive text-white" : "bg-status-sourced text-status-sourced-fg",
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  );
}

function ChecklistRow({ item }: { item: ChecklistItem }) {
  const state = !item.ok ? "fail" : item.unknown ? "unknown" : "pass";
  const Icon = state === "pass" ? Check : state === "fail" ? X : CircleHelp;
  return (
    <li className="flex gap-3 py-2.5">
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          state === "pass" && "text-muted-foreground",
          state === "fail" && "text-destructive",
          state === "unknown" && "text-attention-fg",
        )}
        aria-label={state}
      />
      <div className="min-w-0 space-y-0.5 text-sm">
        <p className="font-medium">{item.label}</p>
        {item.detail && <p className="text-meta text-muted-foreground">{item.detail}</p>}
        {item.fix && (
          // The red X already says it failed; the fix reads as an instruction.
          <p className={cn("text-meta", state === "fail" ? "text-foreground" : "text-muted-foreground")}>
            {item.fix}
          </p>
        )}
        {item.rows && item.rows.length > 0 && (
          <ul className="mt-1 space-y-0.5 font-mono text-xs text-muted-foreground">
            {item.rows.slice(0, 10).map((r) => (
              <li key={r.id}>
                {r.id.slice(0, 8)} {usd(r.amount_usd)} {r.status} ({r.mode ?? "mode not recorded"})
              </li>
            ))}
            {item.rows.length > 10 && <li>and {item.rows.length - 10} more</li>}
          </ul>
        )}
      </div>
    </li>
  );
}

export function PaymentsCard({ mode }: { mode: string | null }) {
  const isOperator = useIsOperator();
  const [status, setStatus] = useState<PaymentsStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [typed, setTyped] = useState("");
  const [switching, setSwitching] = useState(false);

  // State is only set from the promise callbacks, never synchronously in the
  // effect body.
  const fetchStatus = useCallback(
    () =>
      fetch("/api/payments/status", { cache: "no-store" })
        .then(async (r) => {
          if (!r.ok) throw new Error(`status ${r.status}`);
          setStatus((await r.json()) as PaymentsStatus);
          setLoadError(false);
        })
        .catch((e) => {
          console.error("[settings] payments status failed", e);
          setLoadError(true);
        })
        .finally(() => setLoading(false)),
    [],
  );

  const load = useCallback(() => {
    setLoading(true);
    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (isOperator) void fetchStatus();
  }, [isOperator, fetchStatus]);

  async function switchTo(target: "stripe_test" | "stripe_live") {
    setSwitching(true);
    const id = toast.loading(target === "stripe_live" ? "Switching to Live…" : "Switching to Test…");
    try {
      const r = await fetch("/api/payments/mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target === "stripe_live" ? { mode: target, confirmation: typed } : { mode: target }),
      });
      const d = (await r.json()) as { guidance?: string; error?: string };
      if (r.ok) {
        toast.success(target === "stripe_live" ? "Payments are Live." : "Payments are in Test.", { id });
        setTyped("");
      } else {
        toast.error(d.guidance ?? "The switch did not go through.", { id });
      }
    } catch (e) {
      console.error("[settings] payments switch failed", e);
      toast.error("The switch did not go through. Check your connection and try again.", { id });
    } finally {
      setSwitching(false);
      refreshPaymentModeChip();
      void load();
    }
  }

  const current = status?.mode ?? mode;
  if (!current) return null;
  const view = MODE_COPY[current] ?? { label: "Payments", tone: "neutral" as Tone, copy: "Your payout setup is managed for you." };

  if (!isOperator) {
    return (
      <SettingsSection title="Payments" description="Whether approving a payout moves real money.">
        <div className="space-y-2">
          <ModeBadge label={view.label} tone={view.tone} />
          <p className="text-sm">{view.copy}</p>
        </div>
      </SettingsSection>
    );
  }

  const isLive = status?.stripe_mode === "stripe_live";
  const canTypeConfirm = !!status?.settings_applied && !!status?.ready && !isLive;
  return (
    <SettingsSection
      title="Payments"
      description="Stripe mode for every label. Live moves real money."
      action={
        <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={loading} onClick={() => void load()}>
          {loading ? "Checking…" : "Re-check"}
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <ModeBadge label={OPERATOR_MODE_LABEL[current] ?? current} tone={current.endsWith("_live") ? "live" : "neutral"} />
          {status && (
            <span className="text-xs text-muted-foreground">
              Ceiling PAYMENTS_MODE={status.ceiling}
              {status.switched_at ? `. Switched ${status.switched_at.slice(0, 16).replace("T", " ")} UTC by ${status.switched_by ?? "unknown"}` : ""}
            </span>
          )}
        </div>

        {loadError && !status && (
          <p className="text-sm text-destructive">Payments status could not be loaded. Re-check in a moment.</p>
        )}

        {status && (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Account</dt>
              <dd className="min-w-0 truncate">
                {status.account
                  ? `${status.account.display_name ?? "Unnamed"} (${status.account.id}, ${status.account.mode === "stripe_live" ? "live key" : "test key"})`
                  : status.account_error ?? "No Stripe key set"}
              </dd>
              <dt className="text-muted-foreground">Live balance</dt>
              <dd>
                {status.balance
                  ? `${usd(status.balance.available_usd)} available, ${usd(status.balance.pending_usd)} pending`
                  : "Needs the live key"}
              </dd>
            </dl>

            {!status.settings_applied && (
              <p className="text-sm text-attention-fg">
                Migration 064 is not applied, so the mode follows PAYMENTS_MODE and cannot be switched here.
              </p>
            )}

            <div>
              <p className="text-meta font-medium text-foreground">Ready for Live</p>
              <ul className="mt-1 divide-y border-y">
                {status.checklist.map((c) => (
                  <ChecklistRow key={c.id} item={c} />
                ))}
              </ul>
            </div>

            {isLive ? (
              <div className="flex items-center justify-between gap-4 border-t pt-4">
                <p className="text-sm">Switching back to Test takes effect at once. Payments approved in Live then need re-approval.</p>
                <Button variant="outline" disabled={switching} onClick={() => void switchTo("stripe_test")}>
                  Switch to Test
                </Button>
              </div>
            ) : (
              <div className="space-y-2 border-t pt-4">
                <Label htmlFor="live-confirm">Type {SWITCH_CONFIRMATION} to switch</Label>
                <div className="flex gap-2">
                  <Input
                    id="live-confirm"
                    value={typed}
                    disabled={!canTypeConfirm || switching}
                    placeholder={canTypeConfirm ? SWITCH_CONFIRMATION : "Every item above must pass first"}
                    onChange={(e) => setTyped(e.target.value)}
                    autoComplete="off"
                  />
                  <Button
                    variant="destructive"
                    disabled={!canTypeConfirm || switching || typed !== SWITCH_CONFIRMATION}
                    onClick={() => void switchTo("stripe_live")}
                  >
                    Switch to Live
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Payments approved in Test stay unpaid and need re-approval in Live.
                </p>
              </div>
            )}
          </>
        )}

      </div>
    </SettingsSection>
  );
}
