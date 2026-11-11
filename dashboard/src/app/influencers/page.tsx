"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Search, ExternalLink, ShieldAlert, Ban } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/page";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Influencer } from "@/lib/supabase";
import type { RepeatCollaborator } from "@/lib/repeat-collaborators";

const PLATFORM_LABEL: Record<string, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
};

function platformLabel(p: string | null | undefined): string {
  if (!p) return "";
  return PLATFORM_LABEL[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

const PLATFORM_ITEMS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All platforms" },
  { value: "tiktok", label: "TikTok" },
  { value: "instagram", label: "Instagram" },
];

type SortField = "follower_count" | "engagement_rate" | "created_at";

const SORT_ITEMS: Array<{ value: SortField; label: string }> = [
  { value: "follower_count", label: "Most followers" },
  { value: "engagement_rate", label: "Highest engagement" },
  { value: "created_at", label: "Newest" },
];

function initial(name: string | null | undefined): string {
  // Array.from splits by code point, so an emoji-led name is not cut in half.
  return (Array.from((name ?? "").trim())[0] ?? "?").toUpperCase();
}

/** "Invalid Date" is what an unparseable date stringifies to, so guard on NaN. */
function workedBeforeWhen(rc: RepeatCollaborator): string | null {
  if (!rc.last_worked_at) return null;
  const d = new Date(rc.last_worked_at);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString();
}

export default function InfluencersPage() {
  const [influencers, setInfluencers] = useState<Influencer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState("");
  const [sort, setSort] = useState<SortField>("follower_count");
  const [order, setOrder] = useState<"asc" | "desc">("desc");

  // "Worked before" — the creators this firm has actually closed deals with,
  // already ranked best-repeat-bet-first by /api/influencers/roster. Fetched
  // once on mount rather than per keystroke: it is firm history, so it does
  // not change with the search box.
  const [roster, setRoster] = useState<RepeatCollaborator[]>([]);
  // The firm-wide creator count from `totals`, which is NOT the same as
  // `roster.length` — that is only the page the route returned. The chip must
  // show the real total or the label undercounts their own go-to list.
  const [rosterTotal, setRosterTotal] = useState<number | null>(null);
  const [rosterLoading, setRosterLoading] = useState(true);
  const [rosterFailed, setRosterFailed] = useState(false);
  const [workedBefore, setWorkedBefore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Same rule as the creator list: a failed request is NOT an empty
      // roster. If this throws we must never render "0 worked before", which
      // would tell the label they have no go-to creators.
      try {
        // 500 is the route's ceiling. Ask for all of it so the rendered list
        // and the chip count agree for any realistic firm.
        const res = await fetch("/api/influencers/roster?limit=500");
        if (res.ok) {
          const data = await res.json();
          if (cancelled) return;
          setRoster(Array.isArray(data?.collaborators) ? data.collaborators : []);
          setRosterTotal(
            typeof data?.totals?.creators === "number" ? data.totals.creators : null
          );
          setRosterFailed(false);
        } else if (!cancelled) {
          setRosterFailed(true);
        }
      } catch {
        if (!cancelled) setRosterFailed(true);
      }
      if (!cancelled) setRosterLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rosterById = useMemo(
    () => new Map(roster.map((r) => [r.influencer_id, r])),
    [roster]
  );

  // In "Worked before" mode the list is driven by the roster itself, in its
  // own rank order — not by intersecting it with the creator page, which would
  // silently drop a proven collaborator who fell outside the first 100 rows.
  // The search and platform chips still apply, filtered client-side.
  const workedBeforeRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return roster.filter((r) => {
      if (platform && r.platform !== platform) return false;
      if (!q) return true;
      return (
        (r.username ?? "").toLowerCase().includes(q) ||
        (r.display_name ?? "").toLowerCase().includes(q)
      );
    });
  }, [roster, search, platform]);

  const fetchInfluencers = useCallback(async () => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (platform) params.set("platform", platform);
    params.set("sort", sort);
    params.set("order", order);
    params.set("blocklisted", "false");
    // Quarantine: synthetic=true rows are excluded server-side in
    // /api/influencers (see plan task A5). This page never queries Supabase
    // directly, so the API is the single chokepoint that enforces the filter.
    // We pass synthetic=false explicitly so the URL documents the contract.
    params.set("synthetic", "false");

    // A failed request is not an empty roster. Without this branch a 401 or a
    // 500 fell through to the empty state and told the label they have no
    // creators, which is the one thing we must never say incorrectly.
    try {
      const res = await fetch(`/api/influencers?${params}`);
      if (res.ok) {
        const data = await res.json();
        setInfluencers(Array.isArray(data) ? data : []);
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
      }
    } catch {
      setLoadFailed(true);
    }
    setLoading(false);
  }, [search, platform, sort, order]);

  useEffect(() => {
    const timer = setTimeout(fetchInfluencers, 300);
    return () => clearTimeout(timer);
  }, [fetchInfluencers]);

  function toggleSort(field: SortField) {
    if (sort === field) {
      setOrder((prev) => (prev === "desc" ? "asc" : "desc"));
    } else {
      setSort(field);
      setOrder("desc");
    }
  }

  // Blocking removes the creator from this list (the query filters blocklisted
  // rows out), so it needs a deliberate confirm and an explicit result — the
  // row silently vanishing reads as a bug.
  async function blocklist(inf: Influencer) {
    const handle = `@${inf.username}`;
    if (
      !confirm(
        `Block ${handle} for your label? They'll be removed from your creator list and left out of your future outreach. Other labels are unaffected.`
      )
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/influencers/${inf.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocklisted: true }),
      });
      if (!res.ok) {
        toast.error(`Couldn't block ${handle}. Please try again.`);
        return;
      }
      toast.success(`${handle} blocked for your label and removed from your creator list.`);
      fetchInfluencers();
    } catch {
      toast.error(`Couldn't block ${handle}. Check your connection.`);
    }
  }

  const router = useRouter();

  const countLine = workedBefore
    ? !rosterLoading && !rosterFailed
      ? `${workedBeforeRows.length} worked before, best repeat bets first` +
        // Say so rather than quietly showing a short list.
        (rosterTotal !== null && rosterTotal > roster.length
          ? `. Showing the top ${roster.length} of ${rosterTotal}`
          : "")
      : null
    : !loading && !loadFailed
      ? `${influencers.length} ${influencers.length === 1 ? "creator" : "creators"}`
      : null;

  function sortHeader(field: SortField, label: string) {
    const active = sort === field;
    return (
      <button
        type="button"
        onClick={() => toggleSort(field)}
        className={`inline-flex items-center gap-1 font-medium transition-colors hover:text-foreground ${
          active ? "text-foreground" : ""
        }`}
        aria-label={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        {active && <span aria-hidden>{order === "desc" ? "↓" : "↑"}</span>}
      </button>
    );
  }

  // Title matches the sidebar entry. The meta line carries the count and the
  // one thing the list does not show: blocked creators are gone from it.
  return (
    <AppShell
      title="Creators"
      subtitle={
        countLine ? `${countLine}. Blocked creators are hidden.` : "Blocked creators are hidden."
      }
    >
      <div className="mx-auto w-full max-w-7xl px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        {/* Worked before is a different question from "which platform", and
            the more important one, so it is the tab row. A count
            only appears once the roster loaded; a failed fetch is never "0". */}
        <Tabs
          value={workedBefore ? "worked" : "all"}
          onValueChange={(v) => {
            if (v === "worked" && rosterFailed) return;
            setWorkedBefore(v === "worked");
          }}
          className="mb-4 border-b"
        >
          <TabsList variant="line" className="h-9 gap-4 p-0">
            <TabsTrigger value="all" className="px-0">
              All creators
            </TabsTrigger>
            <TabsTrigger
              value="worked"
              className="px-0"
              disabled={rosterFailed}
              title={rosterFailed ? "We couldn't load your past deals just now." : undefined}
            >
              Worked before
              {!rosterLoading && !rosterFailed && rosterTotal !== null && (
                <span className="text-xs font-normal tabular-nums text-faint">
                  {rosterTotal}
                </span>
              )}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search className="absolute left-2.5 top-2 size-4 text-faint" />
            <Input
              className="h-8 pl-8"
              placeholder="Find a creator"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Find a creator by username"
            />
          </div>
          <Select
            items={PLATFORM_ITEMS}
            value={platform || "all"}
            onValueChange={(v) => setPlatform(!v || v === "all" ? "" : String(v))}
          >
            <SelectTrigger className="w-40" aria-label="Platform">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLATFORM_ITEMS.map((it) => (
                <SelectItem key={it.value} value={it.value}>
                  {it.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* The roster carries its own ranking (best repeat bet first), so
              the follower/engagement sorts do not apply in that mode. */}
          {!workedBefore && (
            <Select
              items={SORT_ITEMS}
              value={sort}
              onValueChange={(v) => {
                setSort((v as SortField) ?? "follower_count");
                setOrder("desc");
              }}
            >
              <SelectTrigger className="w-48" aria-label="Sort creators">
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
          )}
        </div>

        {workedBefore ? (
          rosterLoading ? (
            <ListSkeleton />
          ) : rosterFailed ? (
            <EmptyState title="We couldn't load your past deals">
              Nothing is lost. Refresh the page to try again.
            </EmptyState>
          ) : workedBeforeRows.length === 0 ? (
            <EmptyState
              title={
                search || platform
                  ? "No creators you have worked with match these filters"
                  : "No closed deals yet"
              }
            >
              {search || platform
                ? null
                : "Once a creator agrees to a deal they appear here, ranked by how those deals performed."}
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="h-9 pr-3 font-medium">Creator</th>
                    <th className="h-9 px-3 font-medium">Platform</th>
                    <th className="h-9 px-3 text-right font-medium">Deals</th>
                    <th className="h-9 px-3 text-right font-medium">Typical price</th>
                    <th className="h-9 px-3 text-right font-medium">Per 1k views</th>
                    <th className="h-9 px-3 text-right font-medium">Posts verified</th>
                    <th className="h-9 pl-3 text-right font-medium">Last worked</th>
                  </tr>
                </thead>
                <tbody>
                  {workedBeforeRows.map((rc) => {
                    const when = workedBeforeWhen(rc);
                    const href = `/influencers/${rc.influencer_id}`;
                    return (
                      <tr
                        key={rc.influencer_id}
                        onClick={() => router.push(href)}
                        className="cursor-pointer border-b transition-colors hover:bg-muted/50"
                      >
                        <td className="py-2.5 pr-3">
                          <CreatorCell
                            href={href}
                            username={rc.username ?? "unknown"}
                            sub={rc.display_name}
                            name={rc.display_name || rc.username}
                          />
                        </td>
                        <td className="px-3 text-muted-foreground">{platformLabel(rc.platform)}</td>
                        <td className="px-3 text-right tabular-nums">{rc.deals_closed}</td>
                        {/* No zeros stand in for missing numbers: a creator we
                            never measured did not deliver nothing. */}
                        <td className="px-3 text-right tabular-nums">
                          {rc.median_agreed_usd === null ? (
                            <Missing>No price on record</Missing>
                          ) : (
                            `$${rc.median_agreed_usd.toLocaleString(undefined, {
                              minimumFractionDigits: Number.isInteger(rc.median_agreed_usd) ? 0 : 2,
                              maximumFractionDigits: 2,
                            })}`
                          )}
                        </td>
                        <td className="px-3 text-right tabular-nums">
                          {rc.realized_label_cpm === null ? (
                            <Missing>Not measured yet</Missing>
                          ) : (
                            `$${rc.realized_label_cpm.toFixed(2)}`
                          )}
                        </td>
                        <td className="px-3 text-right tabular-nums">
                          {rc.delivery.rate === null ? (
                            <Missing>Not established yet</Missing>
                          ) : (
                            `${rc.delivery.verified} of ${rc.delivery.verified + rc.delivery.missing}`
                          )}
                        </td>
                        <td className="pl-3 text-right tabular-nums text-muted-foreground">
                          {when ?? <Missing>Not recorded</Missing>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : loading ? (
          <ListSkeleton />
        ) : loadFailed ? (
          <EmptyState title="We couldn't load your creator list">
            Nothing is lost. Refresh the page to try again.
          </EmptyState>
        ) : influencers.length === 0 ? (
          <EmptyState
            title={search || platform ? "No creators match your search" : "No creators discovered yet"}
            action={
              search || platform ? undefined : (
                <Button nativeButton={false} variant="outline" render={<Link href="/campaigns" />}>
                  Go to campaigns
                </Button>
              )
            }
          >
            {search || platform ? null : "Creators appear here once a campaign runs discovery."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="h-9 pr-3 font-medium">Creator</th>
                  <th className="h-9 px-3 font-medium">Platform</th>
                  <th className="h-9 px-3 text-right">{sortHeader("follower_count", "Followers")}</th>
                  <th className="h-9 px-3 text-right">{sortHeader("engagement_rate", "Engagement")}</th>
                  <th className="h-9 w-20" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {influencers.map((inf) => {
                  // A missing engagement rate is unknown, not zero: it must not
                  // render as a percentage, and it must not trip the
                  // suspicious-engagement flag (which would accuse a creator
                  // for having no data).
                  const engRate =
                    inf.engagement_rate == null ||
                    !Number.isFinite(Number(inf.engagement_rate))
                      ? null
                      : Number(inf.engagement_rate);
                  const engPct = engRate === null ? null : (engRate * 100).toFixed(1);
                  const isSuspicious =
                    engRate !== null &&
                    (engRate > 0.5 || (engRate < 0.005 && (inf.follower_count || 0) > 20000));
                  const href = `/influencers/${inf.id}`;
                  const repeat = rosterById.get(inf.id);
                  const bio = inf.bio
                    ? `${inf.bio.slice(0, 80)}${inf.bio.length > 80 ? "…" : ""}`
                    : null;

                  return (
                    <tr
                      key={inf.id}
                      onClick={() => router.push(href)}
                      className="group cursor-pointer border-b transition-colors hover:bg-muted/50"
                    >
                      <td className="max-w-0 py-2.5 pr-3 sm:w-1/2">
                        <CreatorCell
                          href={href}
                          username={inf.username}
                          sub={[inf.display_name, bio].filter(Boolean).join(": ")}
                          name={inf.display_name || inf.username}
                          extra={
                            /* A go-to is worth spotting in the default list,
                               not only inside the tab. */
                            repeat ? (
                              <span
                                className="shrink-0 rounded border px-1.5 text-[11px] leading-4 text-muted-foreground"
                                title="You have closed deals with this creator"
                              >
                                Worked with {repeat.deals_closed}×
                              </span>
                            ) : null
                          }
                        />
                      </td>
                      <td className="px-3 text-muted-foreground">{platformLabel(inf.platform)}</td>
                      <td className="px-3 text-right tabular-nums">
                        {(inf.follower_count || 0).toLocaleString()}
                      </td>
                      <td className="px-3 text-right tabular-nums">
                        {engPct === null ? (
                          <Missing>Not measured yet</Missing>
                        ) : isSuspicious ? (
                          <span
                            className="inline-flex items-center gap-1 font-medium text-attention-fg"
                            title="Engagement looks unusual for this audience size"
                          >
                            <ShieldAlert className="size-3.5" />
                            {engPct}%
                          </span>
                        ) : (
                          `${engPct}%`
                        )}
                      </td>
                      <td className="pl-3">
                        <div className="flex items-center justify-end gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground hover:text-destructive"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void blocklist(inf);
                            }}
                            title={`Block @${inf.username}`}
                            aria-label={`Block @${inf.username}`}
                          >
                            <Ban className="size-3.5" />
                          </Button>
                          {inf.profile_url && (
                            <a
                              href={inf.profile_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                              aria-label={`Open @${inf.username} on ${platformLabel(inf.platform)}`}
                            >
                              <ExternalLink className="size-3.5" />
                            </a>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function CreatorCell({
  href,
  username,
  sub,
  name,
  extra,
}: {
  href: string;
  username: string;
  sub?: string | null;
  name?: string | null;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
        {initial(name)}
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={href}
            onClick={(e) => e.stopPropagation()}
            className="truncate font-medium text-foreground hover:underline"
          >
            @{username}
          </Link>
          {extra}
        </div>
        {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}

function Missing({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-faint">{children}</span>;
}

function ListSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}
