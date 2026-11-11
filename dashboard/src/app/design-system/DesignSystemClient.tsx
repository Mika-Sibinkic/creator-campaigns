"use client";

import { useTheme } from "next-themes";
import { useState } from "react";
import {
  Activity,
  ArrowRight,
  Check,
  Inbox,
  LayoutDashboard,
  Settings,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Users,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { StatusBadge, PaperMoneyChip, type AtsStatus } from "@/components/StatusBadge";

const ATS_STATES: AtsStatus[] = [
  "sourced",
  "outreach",
  "reply",
  "negotiation",
  "locked",
  "payout-pending",
  "payout-complete",
  "flagged",
];

const FUNNEL = [
  { stage: "Sourced", value: 142, color: "bg-status-sourced" },
  { stage: "Sent", value: 98, color: "bg-status-outreach" },
  { stage: "Replied", value: 27, color: "bg-status-reply" },
  { stage: "Negotiating", value: 11, color: "bg-status-negotiation" },
  { stage: "Locked", value: 6, color: "bg-status-locked" },
  { stage: "Paid", value: 3, color: "bg-status-payout-complete" },
];

const FEED = [
  { id: 1, ts: "14:02", text: "AI drafted outreach to @rowan_example" },
  { id: 2, ts: "14:01", text: "@playlist_example replied · classified warm" },
  { id: 3, ts: "13:58", text: "Counter sent: $185 → @playlist_example" },
  { id: 4, ts: "13:55", text: "Paper-money payout authorised: $150" },
];

// Brand tokens — indigo is the single accent, everything else monochrome.
const BRAND_SWATCHES: { token: string; className: string; note: string }[] = [
  { token: "--brand-accent", className: "bg-brand-accent", note: "accent" },
  { token: "--brand-accent-strong", className: "bg-brand-accent-strong", note: "AA fill · white text · = --primary" },
  { token: "--brand-accent-deep", className: "bg-brand-accent-deep", note: "hover / pressed" },
  { token: "--brand-ink", className: "bg-brand-ink", note: "near-black ink" },
  { token: "--brand-paper-2", className: "bg-brand-paper-2", note: "off-white surface" },
  { token: "--brand-hairline", className: "bg-brand-hairline", note: "hairline / divider" },
];

export function DesignSystemClient() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [feed, setFeed] = useState(FEED);
  const [signal, setSignal] = useState<Record<number, "up" | "down" | null>>({});

  const handleSignal = (id: number, kind: "up" | "down") => {
    setSignal((prev) => ({ ...prev, [id]: prev[id] === kind ? null : kind }));
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <Sparkles className="size-5 text-primary" />
            <div>
              <div className="text-sm font-semibold">Creator Campaigns Design System</div>
              <div className="text-xs text-muted-foreground">
                Primer · gated to dev + operators · resolvedTheme={resolvedTheme}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <PaperMoneyChip />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              Toggle theme
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-12 px-6 py-10">
        <Section
          title="0 · Brand tokens"
          subtitle="Indigo is the single accent; everything else is monochrome. Source of truth for --brand-*."
        >
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {BRAND_SWATCHES.map((s) => (
                <div key={s.token} className="space-y-2">
                  <div className={`h-16 rounded-md border ${s.className}`} aria-hidden />
                  <div className="space-y-0.5">
                    <div className="font-mono text-xs">{s.token}</div>
                    <div className="text-xs text-muted-foreground">{s.note}</div>
                  </div>
                </div>
              ))}
            </div>
            <Separator />
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1">
                <p className="tagline-display text-2xl text-foreground">Fraunces italic</p>
                <p className="text-xs text-muted-foreground">
                  --font-display · Fraunces italic
                </p>
              </div>
              <div className="space-y-1">
                <p className="heading-chrome text-2xl text-foreground">Live pipeline</p>
                <p className="text-xs text-muted-foreground">
                  --font-heading · Geist 500 · UPPERCASE
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
                  142 · $487
                </p>
                <p className="text-xs text-muted-foreground">--font-sans · Geist · tabular (kept)</p>
              </div>
            </div>
          </div>
        </Section>

        <Section
          title="1 · Auto-ATS status palette"
          subtitle="Each state is a glanceable badge across the funnel."
        >
          <div className="flex flex-wrap gap-2">
            {ATS_STATES.map((s) => (
              <StatusBadge key={s} state={s} />
            ))}
          </div>
        </Section>

        <Section title="2 · Funnel hero" subtitle="Pipeline at a glance. Landing page mockup.">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="size-4 text-primary" /> Live pipeline
              </CardTitle>
              <CardDescription>
                Ada Sample campaign · 142 sourced · $487 of $500 spent
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-6 gap-3">
                {FUNNEL.map((f, i) => {
                  const next = FUNNEL[i + 1];
                  const pct = next ? Math.round((next.value / f.value) * 100) : null;
                  return (
                    <div key={f.stage} className="space-y-2">
                      <div
                        className={`flex h-24 items-end justify-center rounded-md ${f.color} px-2 pb-2`}
                      >
                        <span className="text-xs font-medium opacity-80">{f.stage}</span>
                      </div>
                      <div className="flex items-baseline justify-between px-1">
                        <span className="tabular-nums text-lg font-semibold">{f.value}</span>
                        {pct !== null && (
                          <span className="tabular-nums text-xs text-muted-foreground">
                            {pct}%
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </Section>

        <Section
          title="3 · Live activity feed"
          subtitle="Each row carries an RL signal affordance for preference training."
        >
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y">
                {feed.map((row) => (
                  <li key={row.id} className="flex items-center gap-4 px-5 py-3">
                    <span className="tabular-nums text-xs text-muted-foreground">{row.ts}</span>
                    <span className="flex-1 text-sm">{row.text}</span>
                    <div className="flex items-center gap-1">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant={signal[row.id] === "up" ? "default" : "ghost"}
                              size="icon"
                              className="size-7"
                              onClick={() => handleSignal(row.id, "up")}
                              aria-label="Approve signal"
                            >
                              <ThumbsUp className="size-3.5" />
                            </Button>
                          }
                        />
                        <TooltipContent>Operator would approve (+)</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant={signal[row.id] === "down" ? "destructive" : "ghost"}
                              size="icon"
                              className="size-7"
                              onClick={() => handleSignal(row.id, "down")}
                              aria-label="Reject signal"
                            >
                              <ThumbsDown className="size-3.5" />
                            </Button>
                          }
                        />
                        <TooltipContent>Operator would reject (−)</TooltipContent>
                      </Tooltip>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => setFeed((f) => f.filter((r) => r.id !== row.id))}
                        aria-label="Dismiss"
                      >
                        <X className="size-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              {feed.length === 0 && (
                <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                  Feed cleared.{" "}
                  <Button variant="link" className="h-auto p-0" onClick={() => setFeed(FEED)}>
                    Reset
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </Section>

        <Section title="4 · Sidebar shell" subtitle="Persistent left rail. Collapses below 768px.">
          <Card className="overflow-hidden p-0">
            <SidebarProvider defaultOpen className="min-h-[28rem]">
              <Sidebar variant="inset" collapsible="icon">
                <SidebarHeader>
                  <div className="flex items-center gap-2 px-2 py-1">
                    <Sparkles className="size-4 text-primary" />
                    <span className="text-sm font-semibold">Creator Campaigns</span>
                  </div>
                </SidebarHeader>
                <SidebarContent>
                  <SidebarGroup>
                    <SidebarGroupLabel>Workspace</SidebarGroupLabel>
                    <SidebarGroupContent>
                      <SidebarMenu>
                        {[
                          { icon: LayoutDashboard, label: "Pipeline", active: true },
                          { icon: Activity, label: "Campaigns" },
                          { icon: Users, label: "Influencers" },
                          { icon: Inbox, label: "Outreach", badge: 3 },
                          { icon: Check, label: "Approvals", badge: 2 },
                          { icon: Settings, label: "Settings" },
                        ].map((item) => (
                          <SidebarMenuItem key={item.label}>
                            <SidebarMenuButton isActive={item.active}>
                              <item.icon />
                              <span>{item.label}</span>
                              {item.badge && (
                                <Badge variant="secondary" className="ml-auto tabular-nums">
                                  {item.badge}
                                </Badge>
                              )}
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        ))}
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </SidebarGroup>
                </SidebarContent>
              </Sidebar>
              <div className="flex-1 p-6">
                <h3 className="text-lg font-semibold">Main pane</h3>
                <p className="text-sm text-muted-foreground">
                  Resizes around the sidebar. Try the rail-collapse toggle in production.
                </p>
              </div>
            </SidebarProvider>
          </Card>
        </Section>

        <Section title="5 · Buttons" subtitle="One primary action per surface, restrained accent.">
          <div className="flex flex-wrap items-center gap-3">
            <Button>
              Send all <ArrowRight className="size-4" />
            </Button>
            <Button variant="secondary">Save draft</Button>
            <Button variant="outline">Cancel</Button>
            <Button variant="ghost">Override</Button>
            <Button variant="destructive">Flag</Button>
            <Button variant="link">View audit log</Button>
            <Button disabled>Disabled</Button>
          </div>
        </Section>

        <Section title="6 · Cards · forms · skeletons">
          <div className="grid gap-6 md:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Campaign brief</CardTitle>
                <CardDescription>Tell the AI what to look for.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="ds-artist">Artist</Label>
                  <Input id="ds-artist" defaultValue="Ada Sample" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ds-brief">Pitch</Label>
                  <Textarea
                    id="ds-brief"
                    rows={3}
                    defaultValue="Indie folk · piano-led · fans of quiet piano pop"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="ds-auto">Auto-send drafts</Label>
                  <Switch id="ds-auto" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Loading state</CardTitle>
                <CardDescription>Skeletons replace &ldquo;Loading…&rdquo; text.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-2/3" />
                <Separator className="my-2" />
                <div className="flex items-center gap-3">
                  <Skeleton className="size-9 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3 w-1/2" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Approval queue</CardTitle>
                <CardDescription>Inline-actionable from any page.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {[
                  { who: "rowan_example", what: "Counter $185", state: "negotiation" as const },
                  { who: "playlist_example", what: "Payout $150", state: "payout-pending" as const },
                  { who: "kid_example", what: "Counter $220", state: "negotiation" as const },
                ].map((row, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Avatar className="size-8">
                      <AvatarFallback>{row.who[0].toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1">
                      <div className="text-sm font-medium">@{row.who}</div>
                      <div className="text-xs text-muted-foreground">{row.what}</div>
                    </div>
                    <StatusBadge state={row.state} />
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section title="7 · Tabs" subtitle="Campaign workspace switcher pattern.">
          <Tabs defaultValue="pipeline" className="w-full">
            <TabsList>
              <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
              <TabsTrigger value="influencers">Influencers</TabsTrigger>
              <TabsTrigger value="deals">Deals</TabsTrigger>
              <TabsTrigger value="outcomes">Outcomes</TabsTrigger>
            </TabsList>
            <TabsContent value="pipeline" className="text-sm text-muted-foreground">
              Funnel + activity feed lives here.
            </TabsContent>
            <TabsContent value="influencers" className="text-sm text-muted-foreground">
              Scored creator list.
            </TabsContent>
            <TabsContent value="deals" className="text-sm text-muted-foreground">
              Deal kanban.
            </TabsContent>
            <TabsContent value="outcomes" className="text-sm text-muted-foreground">
              Streams-per-dollar lift.
            </TabsContent>
          </Tabs>
        </Section>

        <Section title="8 · Typography ramp">
          <div className="space-y-2">
            <p className="text-4xl font-semibold tracking-tight">Display · Auto-ATS</p>
            <p className="text-2xl font-semibold">Heading · Live pipeline</p>
            <p className="text-lg font-medium">Subheading · Ada Sample campaign</p>
            <p className="text-sm">Body · 142 sourced · $487 of $500 spent</p>
            <p className="text-xs text-muted-foreground">Meta · last updated 14:02</p>
            <p className="font-mono text-sm tabular-nums">
              Mono · $487 / $500 · 83.33 streams per dollar
            </p>
          </div>
        </Section>

        <footer className="pt-8 text-xs text-muted-foreground">
          Acceptance gate for tokens + primitives. Every product page must consume from this surface.
        </footer>
      </main>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="heading-chrome text-sm text-muted-foreground">
          {title}
        </h2>
        {subtitle && <p className="text-sm text-muted-foreground/80">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}
