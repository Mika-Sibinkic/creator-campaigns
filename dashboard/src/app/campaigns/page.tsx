"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Search } from "lucide-react";

import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CampaignStatusBadge } from "@/components/StatusBadge";
import type { Campaign } from "@/lib/supabase";

/** Never render the string "Invalid Date" at a client. */
/**
 * The budget to SHOW for a campaign.
 *
 * `campaigns.budget` is a deprecated display mirror (migration 037). Only
 * campaign-create writes it: /api/campaigns/[id]/confirm updates
 * total_budget_usd alone, and /api/campaigns/[id]/clone never writes the mirror
 * at all. So this list showed a campaign's original budget forever after the
 * first confirm-time edit, and a blank for every clone, while the money path
 * enforced a different number.
 *
 * Fixed by reading the enforced column. The mirror survives only as a fallback
 * for rows migration 037's backfill could not fill (mirror NULL or <= 0);
 * nothing writes it going forward and nothing should start.
 */
function displayBudget(c: Campaign): number | null {
  return c.total_budget_usd ?? c.budget;
}

function formatCreatedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

// ── Grouping ────────────────────────────────────────────────────────────────
//
// One flat `grid gap-3` of identical cards gave a label with a dozen campaigns
// no way to tell which one needs them today. These four buckets are ordered by
// what is owed: a campaign that has never run sits above one that is finished.

type Bucket = "not_started" | "running" | "paused" | "finished";

const BUCKET_ORDER: Bucket[] = ["not_started", "running", "paused", "finished"];

const BUCKET_HEADING: Record<Bucket, string> = {
  not_started: "Not started",
  running: "Running",
  paused: "Paused",
  finished: "Finished",
};

function bucketFor(status: string): Bucket {
  if (status === "completed") return "finished";
  if (status === "paused") return "paused";
  if (status === "draft") return "not_started";
  return "running";
}

type SortKey = "newest" | "budget";

const PLATFORM_NAME: Record<string, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
};

function platformName(p: string): string {
  return PLATFORM_NAME[p.toLowerCase()] ?? p;
}

// Passed as `items` so the closed trigger shows the label, not the raw value.
const SORT_ITEMS: Array<{ value: SortKey; label: string }> = [
  { value: "newest", label: "Newest first" },
  { value: "budget", label: "Biggest budget first" },
];

export default function CampaignsPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed load used to be mapped to [] and rendered as "No campaigns yet".
  // On a shared screen that says "this label has no campaigns", which is a far
  // worse thing to say than "we couldn't load them".
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");

  useEffect(() => {
    fetch("/api/campaigns")
      .then(async (res) => {
        if (!res.ok) {
          console.error(`[campaigns] GET /api/campaigns → HTTP ${res.status}`);
          setLoadError(true);
          return [];
        }
        return res.json();
      })
      .then((data) => setCampaigns(Array.isArray(data) ? data : []))
      .catch((e) => {
        console.error("[campaigns] load failed", e);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? campaigns.filter((c) =>
          (c.artist_name ?? "").toLowerCase().includes(q)
        )
      : campaigns;
    const sorted = [...filtered].sort((a, b) => {
      if (sort === "budget") {
        return (displayBudget(b) ?? 0) - (displayBudget(a) ?? 0);
      }
      return (
        new Date(b.created_at ?? 0).getTime() -
        new Date(a.created_at ?? 0).getTime()
      );
    });
    return sorted;
  }, [campaigns, search, sort]);

  const groups = useMemo(() => {
    const map = new Map<Bucket, Campaign[]>();
    for (const c of visible) {
      const b = bucketFor(c.status);
      const list = map.get(b);
      if (list) list.push(c);
      else map.set(b, [c]);
    }
    return BUCKET_ORDER.filter((b) => (map.get(b)?.length ?? 0) > 0).map(
      (b) => [b, map.get(b)!] as const
    );
  }, [visible]);

  async function deleteCampaign(e: React.MouseEvent, campaignId: string) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this campaign? This cannot be undone.")) return;

    setActionError("");
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setCampaigns((prev) => prev.filter((c) => c.id !== campaignId));
        return;
      }
      // A 403/500 used to leave the row on screen with no feedback at all,
      // after the user had already confirmed a destructive dialog.
      console.error(`[campaigns] DELETE ${campaignId} → HTTP ${res.status}`);
      setActionError(
        "That campaign couldn’t be deleted. Nothing was changed. Try again in a moment."
      );
    } catch (err) {
      console.error("[campaigns] delete failed", err);
      setActionError(
        "That campaign couldn’t be deleted. Nothing was changed. Try again in a moment."
      );
    }
  }

  return (
    <AppShell
      title="Campaigns"
      subtitle={
        !loading && campaigns.length > 0
          ? `${campaigns.length} ${campaigns.length === 1 ? "campaign" : "campaigns"}`
          : undefined
      }
      actions={
        <Button nativeButton={false} render={<Link href="/campaigns/new" />}>
          <Plus className="size-4" /> New campaign
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-7xl px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        {actionError && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            {actionError}
          </div>
        )}
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : loadError && campaigns.length === 0 ? (
          <EmptyState title="We couldn’t load your campaigns">
            Nothing has been lost. Refresh the page to try again.
          </EmptyState>
        ) : campaigns.length === 0 ? (
          <EmptyState
            title="No campaigns yet"
            action={
              <Button nativeButton={false} render={<Link href="/campaigns/new" />}>
                <Plus className="size-4" /> Create your first campaign
              </Button>
            }
          />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 sm:max-w-xs">
                <Search className="absolute left-2.5 top-2 size-4 text-faint" />
                <Input
                  className="h-8 pl-8"
                  placeholder="Find an artist"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Find a campaign by artist"
                />
              </div>
              <Select
                items={SORT_ITEMS}
                value={sort}
                onValueChange={(v) => setSort((v as SortKey) ?? "newest")}
              >
                <SelectTrigger className="w-48" aria-label="Sort campaigns">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SORT_ITEMS.map((it) => (
                    <SelectItem key={it.value} value={it.value}>
                      {it.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {search.trim() && (
                <span className="text-meta tabular-nums text-muted-foreground">
                  {visible.length} of {campaigns.length}
                </span>
              )}
            </div>

            {visible.length === 0 ? (
              <EmptyState title={`No campaign matches “${search.trim()}”`} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="h-9 pr-3 font-medium">Artist</th>
                      <th className="h-9 px-3 font-medium">Status</th>
                      <th className="h-9 px-3 font-medium">Platforms</th>
                      <th className="h-9 px-3 text-right font-medium">Budget</th>
                      <th className="h-9 px-3 text-right font-medium">Created</th>
                      <th className="h-9 w-10" aria-label="Actions" />
                    </tr>
                  </thead>
                  {groups.map(([bucket, list]) => (
                    <tbody key={bucket}>
                      {/* Grouped by what is owed: a campaign that never ran sits
                          above one that is finished. */}
                      <tr>
                        <th
                          colSpan={6}
                          scope="rowgroup"
                          className="border-b bg-muted/60 py-1.5 pl-2 text-left text-xs font-medium text-muted-foreground"
                        >
                          {BUCKET_HEADING[bucket]}
                          <span className="ml-2 tabular-nums text-faint">{list.length}</span>
                        </th>
                      </tr>
                      {list.map((c) => {
                        const budget = displayBudget(c);
                        return (
                          <tr
                            key={c.id}
                            onClick={() => router.push(`/campaigns/${c.id}`)}
                            className="group cursor-pointer border-b transition-colors hover:bg-muted/50"
                          >
                            <td className="py-2.5 pr-3">
                              <div className="flex items-center gap-2">
                                <Link
                                  href={`/campaigns/${c.id}`}
                                  onClick={(e) => e.stopPropagation()}
                                  className="font-medium text-foreground hover:text-primary"
                                >
                                  {c.artist_name ?? "Untitled campaign"}
                                </Link>
                                {c.artist_name?.startsWith("[SAMPLE]") && (
                                  <Badge variant="outline" className="text-muted-foreground">
                                    Sample
                                  </Badge>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <CampaignStatusBadge status={c.status} />
                            </td>
                            <td className="px-3 py-2.5 text-muted-foreground">
                              {c.target_platforms?.length
                                ? c.target_platforms.map(platformName).join(", ")
                                : <span className="text-xs text-faint">None</span>}
                            </td>
                            {/* total_budget_usd is the ENFORCED ceiling (migration
                                037); `budget` is a deprecated display mirror that
                                confirm never updates and clone never writes. A
                                zero budget renders "$0", never a bare number. */}
                            <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
                              {budget != null ? `$${budget.toLocaleString()}` : <span className="text-xs text-faint">Not set</span>}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                              {formatCreatedAt(c.created_at) ?? <span className="text-xs text-faint">Unknown</span>}
                            </td>
                            <td className="py-1.5 pl-1 text-right">
                              {/* Destructive, so it stays out of the way until
                                  the row is hovered or focused. */}
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="text-faint opacity-100 transition-opacity hover:text-destructive focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                                onClick={(e) => deleteCampaign(e, c.id)}
                                aria-label={`Delete campaign ${c.artist_name ?? ""}`}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  ))}
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
