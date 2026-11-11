"use client";

// Shared "Spend caps" card. /settings and /onboarding edit the SAME three
// limits; they used to carry two hand-copied versions of this card, and the
// copies had already drifted (onboarding never showed the daily discovery cap,
// so its description promised limits the page did not offer).
//
// Two commit styles, because the two pages save differently and neither was
// worth rewriting:
//   commitOn="blur"   (/settings)   — uncontrolled inputs; each field PATCHes
//                                     on blur, only when it actually changed.
//   commitOn="change" (/onboarding) — controlled inputs feeding form state the
//                                     user saves explicitly at the end.
//
// This is only the editor. The caps are enforced server-side.

import { SettingsSection } from "@/components/page";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface SpendCapsValue {
  monthly_spend_cap_usd: number | null;
  per_creator_monthly_cap_usd: number | null;
  /** Optional: hidden entirely when `showDiscoveryCap` is false. */
  daily_apify_cap_usd?: number | null;
}

type CapField = keyof SpendCapsValue;

export interface SpendCapsCardProps {
  value: SpendCapsValue;
  /** Called with just the field that changed. 0 means "no limit". */
  onChange: (patch: Partial<SpendCapsValue>) => void;
  commitOn?: "blur" | "change";
  showDiscoveryCap?: boolean;
  columns?: 1 | 2;
  /** Prefix for input ids, so two instances on one page stay distinct. */
  idPrefix?: string;
}

export function SpendCapsCard({
  value,
  onChange,
  commitOn = "blur",
  showDiscoveryCap = true,
  columns = 1,
  idPrefix = "caps",
}: SpendCapsCardProps) {
  function current(field: CapField): number | null {
    return value[field] ?? null;
  }

  // A negative cap is rejected by the API, so refuse it here rather than
  // showing a saved-looking box next to a value that never landed.
  function commit(field: CapField, raw: string): boolean {
    const trimmed = raw.trim();
    const num = trimmed === "" ? 0 : Number(trimmed);
    if (!Number.isFinite(num) || num < 0) return false;
    if (commitOn === "change" || num !== (current(field) ?? 0)) {
      onChange({ [field]: num } as Partial<SpendCapsValue>);
    }
    return true;
  }

  function field(id: string, label: string, name: CapField, placeholder: string, hint?: string) {
    const v = current(name);
    return (
      <div className="space-y-2" key={id}>
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          type="number"
          min={0}
          inputMode="decimal"
          className="tabular-nums"
          placeholder={placeholder}
          {...(commitOn === "change"
            ? {
                value: v ?? "",
                onChange: (e: React.ChangeEvent<HTMLInputElement>) => commit(name, e.target.value),
              }
            : {
                defaultValue: v ?? "",
                onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
                  if (!commit(name, e.target.value)) {
                    e.target.value = v === null ? "" : String(v);
                  }
                },
              })}
        />
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    );
  }

  return (
    <SettingsSection
      title="Spend caps"
      description={
        <>
          Hard limits on top of each campaign&apos;s budget. We block any payout
          that would take you past these in the same calendar month. Set a box
          to 0 to turn that limit off.
        </>
      }
    >
      <div className={columns === 2 ? "grid grid-cols-1 gap-4 sm:grid-cols-2" : "max-w-sm space-y-4"}>
        {field(
          `${idPrefix}-monthly`,
          "Monthly cap, whole workspace ($)",
          "monthly_spend_cap_usd",
          "e.g. 1000",
        )}
        {field(
          `${idPrefix}-per-creator`,
          "Monthly cap, per creator ($)",
          "per_creator_monthly_cap_usd",
          "e.g. 500",
        )}
        {showDiscoveryCap &&
          field(
            `${idPrefix}-discovery`,
            "Daily discovery cap ($)",
            "daily_apify_cap_usd",
            "e.g. 10",
            "The most we spend in a day looking for new creators. Discovery pauses when you hit it.",
          )}
      </div>
    </SettingsSection>
  );
}
