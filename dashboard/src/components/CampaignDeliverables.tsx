// src/components/CampaignDeliverables.tsx
//
// The deal scope editor — what this campaign is buying, and the
// limits the auto-negotiator may not agree past. Until this existed, every
// negotiation ran against a hardcoded default package and the negotiator would
// accept any package a creator proposed as long as the money fit, so a creator
// could be locked into ten 600-second dance videos for $150 with nobody in the
// loop.
//
// Self-contained, same as CampaignMaterials: owns its own fetch + save state so
// it never re-renders the parent's creator list.
//
// A campaign can have at most one row per content type (DB unique index), so
// this is four toggles with a detail row each, not a generic add/remove list.
"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, ShieldCheck } from "lucide-react";

const PROMO_TYPES = ["story", "post", "reel", "dance_trend"] as const;
type PromoType = (typeof PROMO_TYPES)[number];

const PROMO_LABEL: Record<PromoType, string> = {
  story: "Story",
  post: "Feed post",
  reel: "Reel",
  dance_trend: "Dance / trend video",
};

interface ScopeLine {
  promo_type: PromoType;
  quantity: number;
  delivery_window_days: number;
  min_seconds: number | null;
  min_quantity: number | null;
  max_quantity: number | null;
  max_seconds: number | null;
}

interface ScopeResponse {
  lines: ScopeLine[];
  in_force: { source: "campaign" | "derived"; max_delivery_window_days: number };
  standing_package_text: string;
  platform_max_seconds: Record<PromoType, number | null>;
  default_seconds: Partial<Record<PromoType, number>>;
}

/** Editor state per type. Numbers are held as strings, like every other form in
 *  this app, and coerced once at save. */
interface Draft {
  enabled: boolean;
  quantity: string;
  min_quantity: string;
  max_quantity: string;
  min_seconds: string;
  max_seconds: string;
}

const EMPTY: Draft = {
  enabled: false,
  quantity: "1",
  min_quantity: "",
  max_quantity: "",
  min_seconds: "",
  max_seconds: "",
};

function numOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function CampaignDeliverables({ campaignId }: { campaignId: string }) {
  const [drafts, setDrafts] = useState<Record<PromoType, Draft>>(() =>
    Object.fromEntries(PROMO_TYPES.map((t) => [t, { ...EMPTY }])) as Record<PromoType, Draft>,
  );
  const [windowDays, setWindowDays] = useState("14");
  const [meta, setMeta] = useState<ScopeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/deal-scope`, { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) {
            setError(
              res.status === 503
                ? "The deal scope is not available on this database yet. Nothing is broken: the negotiator is still held to the package this campaign already offers."
                : "The deal scope could not be loaded.",
            );
          }
          return;
        }
        const j = (await res.json()) as ScopeResponse;
        if (cancelled) return;
        setMeta(j);
        const next = Object.fromEntries(
          PROMO_TYPES.map((t) => [t, { ...EMPTY }]),
        ) as Record<PromoType, Draft>;
        for (const line of j.lines ?? []) {
          next[line.promo_type] = {
            enabled: true,
            quantity: String(line.quantity ?? 1),
            min_quantity: line.min_quantity == null ? "" : String(line.min_quantity),
            max_quantity: line.max_quantity == null ? "" : String(line.max_quantity),
            min_seconds: line.min_seconds == null ? "" : String(line.min_seconds),
            max_seconds: line.max_seconds == null ? "" : String(line.max_seconds),
          };
        }
        setDrafts(next);
        if (j.lines?.length) setWindowDays(String(j.lines[0].delivery_window_days ?? 14));
        else setWindowDays(String(j.in_force?.max_delivery_window_days ?? 14));
      } catch {
        if (!cancelled) setError("The deal scope could not be loaded.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  function patch(type: PromoType, next: Partial<Draft>) {
    setSaved(false);
    setDrafts((prev) => ({ ...prev, [type]: { ...prev[type], ...next } }));
  }

  const enabled = PROMO_TYPES.filter((t) => drafts[t].enabled);
  const windowNum = Number(windowDays);
  const windowOk = windowDays.trim() !== "" && Number.isFinite(windowNum) && windowNum > 0;
  const canSave = !saving && windowOk && enabled.every((t) => (numOrNull(drafts[t].quantity) ?? 0) > 0);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/deal-scope`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          delivery_window_days: Math.floor(windowNum),
          lines: enabled.map((t) => ({
            promo_type: t,
            quantity: numOrNull(drafts[t].quantity) ?? 1,
            min_quantity: numOrNull(drafts[t].min_quantity),
            max_quantity: numOrNull(drafts[t].max_quantity),
            min_seconds: numOrNull(drafts[t].min_seconds),
            max_seconds: numOrNull(drafts[t].max_seconds),
          })),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "The deal scope could not be saved. Nothing was changed.");
      }
      const j = (await res.json()) as ScopeResponse;
      setMeta((m) => (m ? { ...m, in_force: j.in_force } : m));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4" /> Deal scope
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          What this campaign is buying, and the limits negotiation will not agree past. A creator who
          proposes something outside this stops the negotiation and comes to you instead of being
          quoted a price.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          /* One loading treatment across the campaign page and its cards. */
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            {meta?.in_force?.source === "derived" && (
              <p className="text-sm text-muted-foreground">
                Nothing set yet, so negotiation is held to the package this campaign already offers
                {meta.standing_package_text ? `: ${meta.standing_package_text}` : ""}. Set it
                explicitly below to widen or narrow that.
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {PROMO_TYPES.map((t) => (
                <Badge
                  key={t}
                  variant={drafts[t].enabled ? "default" : "outline"}
                  className="cursor-pointer px-3 py-1.5 text-sm"
                  onClick={() => patch(t, { enabled: !drafts[t].enabled })}
                >
                  {PROMO_LABEL[t]}
                </Badge>
              ))}
            </div>

            {enabled.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No content types selected. Saving with none clears the scope back to the package the
                campaign already offers.
              </p>
            ) : (
              <div className="space-y-4">
                {enabled.map((t) => {
                  const timeBased = meta?.default_seconds?.[t] != null;
                  const platformMax = meta?.platform_max_seconds?.[t] ?? null;
                  const qtyOk = (numOrNull(drafts[t].quantity) ?? 0) > 0;
                  return (
                    <div key={t} className="rounded-lg border bg-card p-3">
                      <div className="mb-3 text-sm font-medium">{PROMO_LABEL[t]}</div>
                      <div className="grid gap-4 sm:grid-cols-3">
                        <div className="space-y-1.5">
                          <Label htmlFor={`${t}-qty`}>How many you want</Label>
                          <Input
                            id={`${t}-qty`}
                            type="number"
                            min="1"
                            step="1"
                            inputMode="numeric"
                            aria-invalid={!qtyOk}
                            className="font-mono tabular-nums"
                            value={drafts[t].quantity}
                            onChange={(e) => patch(t, { quantity: e.target.value })}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`${t}-minq`}>Fewest you will accept</Label>
                          <Input
                            id={`${t}-minq`}
                            type="number"
                            min="1"
                            step="1"
                            inputMode="numeric"
                            className="font-mono tabular-nums"
                            placeholder="1"
                            value={drafts[t].min_quantity}
                            onChange={(e) => patch(t, { min_quantity: e.target.value })}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`${t}-maxq`}>Most you will accept</Label>
                          <Input
                            id={`${t}-maxq`}
                            type="number"
                            min="1"
                            step="1"
                            inputMode="numeric"
                            className="font-mono tabular-nums"
                            placeholder={drafts[t].quantity || "1"}
                            value={drafts[t].max_quantity}
                            onChange={(e) => patch(t, { max_quantity: e.target.value })}
                          />
                        </div>
                      </div>

                      {timeBased && (
                        <div className="mt-4 grid gap-4 sm:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label htmlFor={`${t}-mins`}>Shortest video (seconds)</Label>
                            <Input
                              id={`${t}-mins`}
                              type="number"
                              min="1"
                              step="1"
                              inputMode="numeric"
                              className="font-mono tabular-nums"
                              placeholder={String(meta?.default_seconds?.[t] ?? "")}
                              value={drafts[t].min_seconds}
                              onChange={(e) => patch(t, { min_seconds: e.target.value })}
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor={`${t}-maxs`}>Longest video (seconds)</Label>
                            <Input
                              id={`${t}-maxs`}
                              type="number"
                              min="1"
                              step="1"
                              inputMode="numeric"
                              aria-describedby={`${t}-maxs-help`}
                              className="font-mono tabular-nums"
                              placeholder={platformMax == null ? "" : String(platformMax)}
                              value={drafts[t].max_seconds}
                              onChange={(e) => patch(t, { max_seconds: e.target.value })}
                            />
                            {platformMax != null && (
                              <p id={`${t}-maxs-help`} className="text-xs text-muted-foreground">
                                The platform caps this format at {platformMax} seconds.
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="scope-window">Days to deliver</Label>
              <Input
                id="scope-window"
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                aria-invalid={!windowOk}
                aria-describedby="scope-window-help"
                className="font-mono tabular-nums sm:max-w-40"
                value={windowDays}
                onChange={(e) => {
                  setSaved(false);
                  setWindowDays(e.target.value);
                }}
              />
              <p id="scope-window-help" className="text-xs text-muted-foreground">
                The outside date for every deliverable on this campaign.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {/* A settings save, not the page's primary action — the
                  campaign page picks that from campaign state. */}
              <Button
                type="button"
                variant="secondary"
                disabled={!canSave}
                onClick={() => void save()}
              >
                {saving ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Saving…
                  </>
                ) : (
                  "Save deal scope"
                )}
              </Button>
              {saved && <span className="text-sm text-muted-foreground">Saved.</span>}
            </div>
          </>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
