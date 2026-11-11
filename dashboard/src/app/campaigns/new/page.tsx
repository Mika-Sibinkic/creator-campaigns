"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { SettingsSection } from "@/components/page";
import { CommentAuditToggle } from "@/components/CommentAuditToggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Check, Loader2 } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { ArtistStep } from "@/components/ArtistStep";
import type { ArtistCandidate } from "@/lib/artist-identity";

const PLATFORMS = ["tiktok", "instagram", "youtube"] as const;
const URGENCY_LEVELS = ["low", "normal", "high", "urgent"] as const;

// POST /api/campaigns answers with `{ error: <slug> }` and no prose, so the
// old `body.message ?? body.error` put slugs like `validation_failed` straight
// into a red toast. Same shape as ERROR_COPY in src/lib/run-progress.ts: every
// code a user can actually trigger from this form gets a sentence.
const CREATE_ERROR_COPY: Record<string, string> = {
  onboarding_required:
    "Finish your workspace setup before creating a campaign.",
  validation_failed:
    "Something on this form wasn't accepted. Check the artist name, budget, cap and duration, then try again.",
  invalid_json:
    "That form could not be read. Reload the page and try again.",
  rate_limited:
    "Too many attempts in a short time. Wait a moment, then try again.",
  unauthorized: "Your session has expired. Sign in again, then try again.",
};

export default function NewCampaignPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(["tiktok", "instagram"]);
  const [formData, setFormData] = useState({
    artist_name: "",
    track_name: "",
    budget: "",
    per_influencer_cap: "",
    release_date: "",
    duration_days: "30",
    urgency: "normal",
    special_instructions: "",
    outreach_limit: "",
  });

  // Mini-run (migration 060). The field renders only once the column exists;
  // until then the probe answers false and the form is exactly as before.
  const [limitSupported, setLimitSupported] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/campaigns/outreach-limit", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { supported: false }))
      .then((j: { supported?: boolean }) => {
        if (!cancelled) setLimitSupported(j.supported === true);
      })
      .catch(() => {
        /* probe failed — keep the field hidden */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // Comment-quality audit (migration 066). Sent only when the toggle exists.
  const [commentAudit, setCommentAudit] = useState(false);
  const [commentAuditSupported, setCommentAuditSupported] = useState(false);
  const limitText = formData.outreach_limit.trim();
  const limitNum = Number(limitText);
  const limitOk = limitText === "" || (Number.isInteger(limitNum) && limitNum > 0);

  // ── Artist identity (required) ────────────────────────────────────────
  // A picked candidate card or a resolved Spotify link. The create route
  // re-verifies the Spotify id and bridges it to the Soundcharts UUID that
  // attribution runs on; see src/components/ArtistStep.tsx.
  const [artist, setArtist] = useState<ArtistCandidate | null>(null);

  // Both spend ceilings are required and must be > 0 — see handleSubmit.
  const budgetNum = Number(formData.budget);
  const capNum = Number(formData.per_influencer_cap);
  const budgetOk = formData.budget.trim() !== "" && Number.isFinite(budgetNum) && budgetNum > 0;
  const capOk =
    formData.per_influencer_cap.trim() !== "" && Number.isFinite(capNum) && capNum > 0;
  const capsValid = budgetOk && capOk;

  function togglePlatform(platform: string) {
    setSelectedPlatforms((prev) =>
      prev.includes(platform)
        ? prev.filter((p) => p !== platform)
        : [...prev, platform]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formData.artist_name.trim()) return;
    if (!artist) {
      toast.error("Pick the artist from the list or paste their Spotify link.");
      return;
    }
    // MONEY: these two fields become campaigns.total_budget_usd and
    // per_creator_cap_usd — the only ceilings the payout path enforces. They
    // were optional, and blank sent `null`, which produced campaigns that
    // displayed a budget but had no enforceable cap. Required now, both here
    // and in CreateCampaignBody.
    if (!capsValid) {
      toast.error(
        "Set a campaign budget and a per-creator cap above 0. They're the limits that stop this campaign overspending."
      );
      return;
    }

    if (limitSupported && !limitOk) {
      toast.error("Max creators to contact must be a whole number above 0, or blank for no limit.");
      return;
    }

    const parsedDuration = parseInt(formData.duration_days, 10);
    const durationDays = Number.isFinite(parsedDuration) ? parsedDuration : undefined;

    setSubmitting(true);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formData,
          // Sent only when the column exists and a number was typed; blank
          // means no limit, and pre-060 the key is never sent at all.
          outreach_limit: limitSupported && limitText !== "" ? limitNum : undefined,
          comment_audit_enabled: commentAuditSupported && commentAudit ? true : undefined,
          track_name: formData.track_name.trim() || undefined,
          budget: budgetNum,
          per_influencer_cap: capNum,
          // An empty Duration field gave parseInt("") === NaN, which
          // JSON.stringify writes as null, which the optional zod number
          // rejects — a 422 whose only explanation was `validation_failed`.
          duration_days: durationDays,
          target_platforms: selectedPlatforms,
          artist_spotify_id: artist.spotify_id,
        }),
      });

      if (!res.ok) {
        let message = "Couldn't create the campaign. Please try again.";
        try {
          const body = (await res.json()) as { error?: string; message?: string };
          const code = body.error;
          if (body.message) {
            message = body.message;
          } else if (code && CREATE_ERROR_COPY[code]) {
            message = CREATE_ERROR_COPY[code];
          } else if (code) {
            // Unmapped codes are machine slugs (`validation_failed`,
            // `campaign_not_found`). They used to be appended in brackets, so
            // the label read internal vocabulary in a red toast. Log them,
            // don't render them — devtools keeps the diagnosis.
            console.error(`[campaigns] POST /api/campaigns → ${code}`);
          }
        } catch {
          /* non-JSON response — keep the friendly default */
        }
        toast.error(message);
        setSubmitting(false);
        return;
      }
      const campaign = (await res.json()) as { id?: string };
      if (!campaign?.id) {
        // A 200 with no id would otherwise push to /campaigns/undefined.
        toast.error(
          "The campaign was created but we could not open it. Find it on the Campaigns page."
        );
        router.push("/campaigns");
        return;
      }
      router.push(`/campaigns/${campaign.id}`);
    } catch {
      // The raw browser exception ("Failed to fetch") told the user nothing.
      toast.error(
        "Couldn't create the campaign: we can't reach the server. Check your connection and try again."
      );
      setSubmitting(false);
    }
  }

  // What still blocks Create, named once beside the button. Empty required
  // fields are not painted red on arrival: a form that opens in an error
  // state reads as broken. A field turns invalid only once it holds a value
  // that will be refused.
  const blockers = [
    !artist ? "pick the artist" : null,
    !budgetOk ? "set a campaign budget" : null,
    !capOk ? "set a per-creator cap" : null,
    limitSupported && !limitOk ? "fix the creator limit" : null,
  ].filter((b): b is string => b != null);

  return (
    <AppShell title="New campaign" back={{ href: "/campaigns", label: "Campaigns" }} width="medium">
      <div className="mx-auto w-full max-w-5xl px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        <form onSubmit={handleSubmit}>
          <SettingsSection
            title="Artist"
            description="Pick the exact artist, so attribution reads the right streaming profile."
          >
            <div className="max-w-xl space-y-5">
              <ArtistStep
                artistName={formData.artist_name}
                onArtistNameChange={(name) =>
                  setFormData((prev) => ({ ...prev, artist_name: name }))
                }
                identity={artist}
                onIdentityChange={setArtist}
              />

              <div className="space-y-2">
                <Label htmlFor="track_name">
                  Track name <span className="font-normal text-faint">Optional</span>
                </Label>
                <Input
                  id="track_name"
                  placeholder="e.g. Sample Single"
                  value={formData.track_name}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      track_name: e.target.value,
                    }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  The release this campaign promotes. Used in outreach drafts and contracts.
                </p>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection
            title="Spend limits"
            description="The campaign's hard ceilings: the total it can ever pay out, and the most any single creator can be paid. Payouts are refused while either is unset."
          >
            <div className="max-w-xl space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="budget">Campaign budget ($)</Label>
                  <Input
                    id="budget"
                    type="number"
                    min="0"
                    step="any"
                    required
                    className="tabular-nums"
                    aria-invalid={formData.budget.trim() !== "" && !budgetOk}
                    placeholder="10000"
                    value={formData.budget}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        budget: e.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="per_influencer_cap">Per-creator cap ($)</Label>
                  <Input
                    id="per_influencer_cap"
                    type="number"
                    min="0"
                    step="any"
                    required
                    className="tabular-nums"
                    aria-invalid={formData.per_influencer_cap.trim() !== "" && !capOk}
                    placeholder="500"
                    value={formData.per_influencer_cap}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        per_influencer_cap: e.target.value,
                      }))
                    }
                  />
                </div>
              </div>

              {limitSupported && (
                <div className="space-y-2">
                  <Label htmlFor="outreach_limit">
                    Max creators to contact <span className="font-normal text-faint">Optional</span>
                  </Label>
                  <Input
                    id="outreach_limit"
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    aria-invalid={!limitOk}
                    aria-describedby="outreach_limit-help"
                    className="max-w-40 tabular-nums"
                    placeholder="No limit"
                    value={formData.outreach_limit}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        outreach_limit: e.target.value,
                      }))
                    }
                  />
                  <p id="outreach_limit-help" className="text-xs text-muted-foreground">
                    Once this many creators have been contacted, no new creator is.
                  </p>
                </div>
              )}
            </div>
          </SettingsSection>

          <SettingsSection title="Timing and reach">
            <div className="max-w-xl space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="release_date">Release date</Label>
                  <Input
                    id="release_date"
                    type="date"
                    value={formData.release_date}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        release_date: e.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="duration_days">Duration (days)</Label>
                  <Input
                    id="duration_days"
                    type="number"
                    className="tabular-nums"
                    value={formData.duration_days}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        duration_days: e.target.value,
                      }))
                    }
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label id="platforms-label">Platforms</Label>
                <ToggleGroup aria-labelledby="platforms-label">
                  {PLATFORMS.map((platform) => (
                    <ToggleButton
                      key={platform}
                      pressed={selectedPlatforms.includes(platform)}
                      onClick={() => togglePlatform(platform)}
                    >
                      {PLATFORM_LABEL[platform]}
                    </ToggleButton>
                  ))}
                </ToggleGroup>
              </div>

              <div className="space-y-2">
                <Label id="urgency-label">Urgency</Label>
                <ToggleGroup aria-labelledby="urgency-label">
                  {URGENCY_LEVELS.map((level) => (
                    <ToggleButton
                      key={level}
                      pressed={formData.urgency === level}
                      onClick={() => setFormData((prev) => ({ ...prev, urgency: level }))}
                    >
                      {level.charAt(0).toUpperCase() + level.slice(1)}
                    </ToggleButton>
                  ))}
                </ToggleGroup>
              </div>

              <CommentAuditToggle
                checked={commentAudit}
                onChange={setCommentAudit}
                onSupported={setCommentAuditSupported}
              />
            </div>
          </SettingsSection>

          <SettingsSection
            title="Notes for the outreach copy"
            description="This does not set what the deal includes. Set that on the campaign page under Deal scope, which is what negotiation is held to."
          >
            <div className="max-w-xl">
              <Textarea
                id="special_instructions"
                aria-label="Notes for the outreach copy"
                placeholder="Anything to mention, or to stay away from…"
                value={formData.special_instructions}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    special_instructions: e.target.value,
                  }))
                }
                rows={3}
              />
            </div>
          </SettingsSection>

          <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-6">
            {blockers.length > 0 && (
              <p className="mr-auto text-meta text-muted-foreground">
                To create it, {blockers.join(", ")}.
              </p>
            )}
            <Button variant="ghost" type="button" nativeButton={false} render={<Link href="/campaigns" />}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting || !artist || !capsValid || (limitSupported && !limitOk)}
            >
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Creating…
                </>
              ) : (
                "Create campaign"
              )}
            </Button>
          </div>
        </form>
      </div>
    </AppShell>
  );
}

const PLATFORM_LABEL: Record<(typeof PLATFORMS)[number], string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
};

function ToggleGroup({
  children,
  ...rest
}: { children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div role="group" className="inline-flex flex-wrap gap-1.5" {...rest}>
      {children}
    </div>
  );
}

/** A real button with aria-pressed, in place of a Badge with an onClick. */
function ToggleButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        pressed
          ? "border-foreground/30 bg-accent font-medium text-foreground"
          : "bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      {pressed && <Check className="size-3.5" aria-hidden />}
      {children}
    </button>
  );
}
