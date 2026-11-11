"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { UserButton } from "@clerk/nextjs";
import {
  ChartColumn,
  CheckSquare,
  Crosshair,
  LayoutDashboard,
  MessageSquare,
  Moon,
  Rocket,
  ScrollText,
  Search,
  Settings,
  ShieldAlert,
  Sparkles,
  Sun,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { PaymentModeChip } from "@/components/PaymentModeChip";
import { TestingModeBanner } from "@/components/TestingModeBanner";
import { PageHeader, type PageWidth } from "@/components/page";
import { OperatorOnly, useIsOperator, useMe } from "@/components/OperatorContext";

type NavGroup = "Run a campaign" | "Review" | "Account";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  group: NavGroup;
  /** Hidden from the label; operator staff only. */
  operatorOnly?: boolean;
}

// Ordered by the work, not by when each page was built. The old order put
// Setup — step one — last, below Anomalies and Analytics, and interleaved two
// engineering surfaces with the workflow stages.
//
// Four workflow stages still have no nav entry: negotiation (lives at
// /campaigns/[id]/deals), contracts (buried in Settings), and delivery (inside
// the campaign page). Each is campaign-scoped, so a global route would need an
// API that does not exist yet — they are reached from the campaign instead.
const ITEMS: NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard, group: "Run a campaign" },
  { href: "/campaigns", label: "Campaigns", icon: Crosshair, group: "Run a campaign" },
  { href: "/influencers", label: "Creators", icon: Users, group: "Run a campaign" },
  { href: "/outreach", label: "Outreach", icon: MessageSquare, group: "Run a campaign" },
  { href: "/approvals", label: "Approvals", icon: CheckSquare, group: "Run a campaign" },
  { href: "/analytics", label: "Results", icon: ChartColumn, group: "Review" },
  { href: "/anomalies", label: "Needs attention", icon: ShieldAlert, group: "Review" },
  { href: "/audit", label: "Activity", icon: ScrollText, group: "Review" },
  { href: "/settings", label: "Settings", icon: Settings, group: "Account" },
  // One-time flow. The OnboardingGate below forces anyone who hasn't finished
  // it to /onboarding anyway, so a permanent nav entry is clutter for everyone
  // who has — but it stays reachable for us when re-running a workspace setup.
  { href: "/onboarding", label: "Workspace setup", icon: Rocket, group: "Account", operatorOnly: true },
];

const APPROVALS_POLL_MS = 30_000;

function useApprovalsCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await fetch("/api/approvals/count", { cache: "no-store" });
        if (!r.ok) return;
        const json = (await r.json()) as { pending?: number };
        if (cancelled) return;
        if (typeof json.pending === "number") setCount(json.pending);
      } catch {
        /* silent */
      }
    }
    void tick();
    const id = setInterval(() => void tick(), APPROVALS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return count;
}

function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const current = theme === "system" ? resolvedTheme : theme;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8"
      onClick={() => setTheme(current === "dark" ? "light" : "dark")}
      aria-label="Toggle theme"
    >
      {current === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

interface CampaignSummary {
  id: string;
  artist_name: string;
}

// Per-tab memo for the command palette's campaign list, so a quick re-open is
// instant. Lives in the client bundle — one browser tab, one signed-in user —
// so it carries no cross-tenant risk the way an HTTP cache entry would. A full
// reload clears it, which is also what sign-out does.
let campaignMemo: CampaignSummary[] = [];

function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  // Seeded from the per-tab memo, so a re-open paints before the fetch lands.
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>(campaignMemo);
  const isOperator = useIsOperator();
  const router = useRouter();

  // Hydrate the live campaign list when the palette opens.
  //
  // This used to pass `cache: "force-cache"`, which was the wrong mechanism
  // for the stated intent: it reaches for the browser HTTP cache rather than
  // memoizing in the page, ignores freshness entirely, carries no Vary, and
  // nothing purges it on sign-out — so the day anyone puts a Cache-Control on
  // /api/campaigns, one firm's campaign list surfaces in another's palette in
  // the same browser profile. It was also inert, since the handler is dynamic
  // and already answers no-store. A module-scope memo does what was meant,
  // in-page and per-tab.
  useEffect(() => {
    if (!open || campaignMemo.length > 0) return;
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/api/campaigns", { cache: "no-store" });
        if (!r.ok) return;
        const json = (await r.json()) as Array<{ id: string; artist_name: string }>;
        if (!cancelled && Array.isArray(json)) {
          const next = json.map((c) => ({ id: c.id, artist_name: c.artist_name }));
          campaignMemo = next;
          setCampaigns(next);
        }
      } catch {
        /* silent */
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Quick jump" description="Pages and global actions">
      <CommandInput placeholder="Type to search pages, actions, campaigns…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Navigate">
          {ITEMS.filter((i) => !i.operatorOnly || isOperator).map((item) => (
            <CommandItem
              key={item.href}
              value={item.label}
              onSelect={() => {
                onOpenChange(false);
                router.push(item.href);
              }}
            >
              <item.icon className="size-4" />
              {item.label}
            </CommandItem>
          ))}
        </CommandGroup>
        {campaigns.length > 0 && (
          <CommandGroup heading="Campaigns">
            {campaigns.map((c) => (
              <CommandItem
                key={c.id}
                value={`campaign-${c.artist_name}-${c.id}`}
                onSelect={() => {
                  onOpenChange(false);
                  router.push(`/campaigns/${c.id}`);
                }}
              >
                <Crosshair className="size-4" />
                {c.artist_name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Actions">
          <CommandItem
            value="new-campaign"
            onSelect={() => {
              onOpenChange(false);
              router.push("/campaigns/new");
            }}
          >
            <Sparkles className="size-4" />
            New campaign
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

// Sends a firm that hasn't finished setup to /onboarding. Mounted inside the
// AppShell, which every signed-in page renders — the /onboarding page has no
// AppShell, so there is no redirect loop. Stays quiet on a transient error so
// a blip never traps the user on a blank redirect.
function OnboardingGate() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (pathname === "/onboarding") return;
    let cancelled = false;
    async function check() {
      try {
        const r = await fetch("/api/firm", { cache: "no-store" });
        if (!r.ok) return;
        const firm = (await r.json()) as { onboarding_completed_at?: string | null };
        if (!cancelled && firm && firm.onboarding_completed_at == null) {
          router.replace("/onboarding");
        }
      } catch {
        /* silent — don't bounce the user on a network blip */
      }
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  return null;
}

export interface AppShellProps {
  title?: string;
  /** Quiet meta line under the title. Not a description of the page. */
  subtitle?: React.ReactNode;
  /** Badge beside the title (a status, nothing longer). */
  badge?: React.ReactNode;
  /** The page's primary action, right-aligned in the page header. */
  actions?: React.ReactNode;
  back?: { href: string; label: string };
  /** Must match the page body's max width so the header and content align. */
  width?: PageWidth;
  children: React.ReactNode;
}

export function AppShell({ title, subtitle, badge, actions, back, width = "wide", children }: AppShellProps) {
  const pathname = usePathname();
  const approvals = useApprovalsCount();
  const isOperator = useIsOperator();
  const me = useMe();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const groups: NavGroup[] = ["Run a campaign", "Review", "Account"];

  return (
    <SidebarProvider>
      {/* First in tab order, so keyboard users can skip the sidebar's links. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <Sidebar collapsible="icon">
        <SidebarHeader className="h-12 justify-center px-3">
          <div className="flex items-center gap-2 px-1">
            <Crosshair className="size-4 shrink-0 text-primary" />
            <span className="truncate text-sm font-semibold tracking-tight text-foreground group-data-[collapsible=icon]:hidden">
              Creator Campaigns
            </span>
          </div>
        </SidebarHeader>
        <SidebarContent className="gap-0 py-2">
          {groups.map((g) => (
            <SidebarGroup key={g} className="py-1.5">
              <SidebarGroupLabel className="h-7 text-xs font-medium text-faint">{g}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-px">
                  {ITEMS.filter((i) => i.group === g && (!i.operatorOnly || isOperator)).map((item) => {
                    const active = pathname === item.href || (item.href !== "/" && pathname?.startsWith(item.href));
                    const showBadge = item.href === "/approvals" && approvals > 0;
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          isActive={!!active}
                          tooltip={item.label}
                          className="h-8 text-sidebar-foreground data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground data-active:[&_svg]:text-primary"
                          render={<Link href={item.href} />}
                        >
                          <item.icon />
                          <span>{item.label}</span>
                          {showBadge && (
                            <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded bg-status-payout-pending px-1.5 text-xs font-semibold tabular-nums text-status-payout-pending-fg">
                              {approvals}
                            </span>
                          )}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter className="border-t border-sidebar-border px-3 py-3">
          <span className="truncate px-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            {me?.workspace_name ?? "Workspace"}
          </span>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="min-w-0">
        <TestingModeBanner />
        <header className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur sm:px-6">
          <SidebarTrigger className="-ml-1.5 text-muted-foreground" />
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="hidden h-8 w-72 items-center gap-2 rounded-md border border-input bg-muted/60 px-2.5 text-sm text-faint transition-colors hover:bg-muted sm:flex"
          >
            <Search className="size-3.5" />
            <span className="flex-1 text-left">Search</span>
            <kbd className="pointer-events-none inline-flex h-5 select-none items-center rounded border bg-background px-1.5 text-[10px] font-medium text-muted-foreground">
              ⌘K
            </kbd>
          </button>
          <div className="ml-auto flex items-center gap-2">
            {/* The resolved payments mode (Paper money / Stripe test / LIVE),
                operator only: useful to us, meaningless-to-alarming for the label. */}
            <OperatorOnly>
              <PaymentModeChip className="hidden md:inline-flex" />
            </OperatorOnly>
            <ThemeToggle />
            {/* Until now there was no way to sign out, and nothing showed which
                identity was active — on a product where the same browser may
                hold either a label's session or ours, that matters. */}
            <UserButton
              appearance={{ elements: { avatarBox: "size-7" } }}
              userProfileMode="modal"
            />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="flex-1 outline-none">
          {title && (
            <PageHeader
              title={title}
              meta={subtitle}
              badge={badge}
              actions={actions}
              back={back}
              width={width}
            />
          )}
          {children}
        </main>
      </SidebarInset>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <OnboardingGate />
    </SidebarProvider>
  );
}
