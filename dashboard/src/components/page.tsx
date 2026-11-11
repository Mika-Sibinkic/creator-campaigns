// Shared page primitives. The rule they encode: one thing per page is loud
// (the primary action, or the item that needs a person), and everything else
// steps down through four type roles (page title, section title, body, meta)
// instead of being wrapped in identical cards.

import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { cn } from "@/lib/utils";

export type PageWidth = "form" | "narrow" | "medium" | "default" | "wide";

export const PAGE_WIDTH: Record<PageWidth, string> = {
  form: "max-w-2xl",
  narrow: "max-w-3xl",
  medium: "max-w-5xl",
  default: "max-w-6xl",
  wide: "max-w-7xl",
};

/** Horizontal gutter shared by the page header and every page body. */
export const PAGE_GUTTER = "px-4 sm:px-6 lg:px-8";

export function PageHeader({
  title,
  meta,
  badge,
  actions,
  back,
  width = "wide",
}: {
  title: React.ReactNode;
  /** One quiet line under the title: state, dates, counts. Never a sentence. */
  meta?: React.ReactNode;
  /** Sits beside the title. A status badge, nothing longer. */
  badge?: React.ReactNode;
  /** One primary button, optionally preceded by quiet secondary ones. */
  actions?: React.ReactNode;
  back?: { href: string; label: string };
  width?: PageWidth;
}) {
  return (
    <div className={cn("mx-auto w-full pt-6 sm:pt-8", PAGE_GUTTER, PAGE_WIDTH[width])}>
      {back && (
        <Link
          href={back.href}
          className="mb-2 inline-flex items-center gap-1 text-meta text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="truncate text-page-title text-foreground">{title}</h1>
            {badge}
          </div>
          {meta && <div className="mt-1 text-meta text-muted-foreground">{meta}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** A titled region of a page. Grouping by space and a heading, not a box. */
export function Section({
  title,
  count,
  action,
  children,
  className,
  id,
}: {
  title?: React.ReactNode;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("min-w-0", className)}>
      {(title || action) && (
        <div className="mb-3 flex min-h-8 items-center justify-between gap-4">
          {title && (
            <h2 className="flex items-baseline gap-2 text-section-title text-foreground">
              {title}
              {count != null && (
                <span className="text-meta font-normal tabular-nums text-faint">{count}</span>
              )}
            </h2>
          )}
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * One group of settings: what it is on the left, the controls on the right,
 * a hairline between groups. Replaces a stack of identical cards on Settings
 * and Workspace setup. Stacks to one column below lg.
 */
export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
  id,
}: {
  title: React.ReactNode;
  /** Only when the setting's effect is not obvious from its name. */
  description?: React.ReactNode;
  /** A quiet control beside the title (Re-check, a badge). */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        "grid gap-x-12 gap-y-4 border-t py-8 first:border-t-0 first:pt-2 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="text-section-title text-foreground">{title}</h2>
          {action}
        </div>
        {description && (
          <div className="mt-1 text-meta text-muted-foreground">{description}</div>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/** A row of headline numbers divided by hairlines (no tile per number). */
export function StatGroup({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <dl
      className={cn(
        "grid grid-cols-2 gap-y-5 border-y py-5 md:flex md:divide-x md:gap-y-0",
        className,
      )}
    >
      {children}
    </dl>
  );
}

export function Stat({
  label,
  value,
  sub,
  empty,
  className,
}: {
  label: React.ReactNode;
  /** null = we genuinely do not have the number yet. `empty` says why. */
  value: React.ReactNode | null;
  sub?: React.ReactNode;
  empty?: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 md:flex-1 md:px-6 md:first:pl-0 md:last:pr-0", className)}>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="mt-1">
        {value != null ? (
          <span className="text-kpi tabular-nums text-foreground">{value}</span>
        ) : (
          <span className="block pt-1.5 text-sm text-faint">{empty ?? "Not yet"}</span>
        )}
      </dd>
      {sub && value != null && <dd className="mt-1 text-xs text-muted-foreground">{sub}</dd>}
    </div>
  );
}

/**
 * The block that says "this is waiting on you". The only tinted surface a
 * page is allowed, and it should hold the page's primary button.
 */
export function AttentionCallout({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-attention-border bg-attention px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        {Icon && <Icon className="mt-0.5 size-4 shrink-0 text-attention-fg" />}
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {children && <div className="mt-0.5 text-meta text-muted-foreground">{children}</div>}
        </div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

/** Empty or failed list. Says what is true and offers the next step. */
export function EmptyState({
  title,
  children,
  action,
  className,
}: {
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-lg border border-dashed px-6 py-12 text-center",
        className,
      )}
    >
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children && <div className="mt-1 max-w-md text-meta text-muted-foreground">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
