import { cn } from "@/lib/utils";

export type AtsStatus =
  | "sourced"
  | "outreach"
  | "reply"
  | "negotiation"
  | "locked"
  | "payout-pending"
  | "payout-complete"
  | "flagged";

const LABEL: Record<AtsStatus, string> = {
  sourced: "Sourced",
  outreach: "Outreach Sent",
  reply: "Reply Received",
  negotiation: "Negotiating",
  locked: "Deal Locked",
  "payout-pending": "Payout Pending",
  "payout-complete": "Paid",
  flagged: "Flagged",
};

const STYLES: Record<AtsStatus, string> = {
  sourced: "bg-status-sourced text-status-sourced-fg",
  outreach: "bg-status-outreach text-status-outreach-fg",
  reply: "bg-status-reply text-status-reply-fg",
  negotiation: "bg-status-negotiation text-status-negotiation-fg",
  locked: "bg-status-locked text-status-locked-fg",
  "payout-pending": "bg-status-payout-pending text-status-payout-pending-fg",
  "payout-complete": "bg-status-payout-complete text-status-payout-complete-fg",
  flagged: "bg-status-flagged text-status-flagged-fg",
};

/** States that ask a person to do something. Only these carry a dot. */
const NEEDS_ACTION: ReadonlySet<AtsStatus> = new Set(["reply", "payout-pending", "flagged"]);

export function StatusBadge({
  state,
  label,
  className,
}: {
  state: AtsStatus;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded px-1.5 text-xs font-medium",
        STYLES[state],
        className,
      )}
    >
      {NEEDS_ACTION.has(state) && (
        <span className="size-1.5 rounded-full bg-current" aria-hidden />
      )}
      {label ?? LABEL[state]}
    </span>
  );
}

/**
 * Campaign status → badge colour. One mapping for every page that shows a
 * campaign (it was copied into three files). Running is the only state worth
 * a colour; paused asks for attention; everything else is neutral.
 */
export function campaignTone(s: string): AtsStatus {
  switch (s) {
    case "active":
    case "outreach":
    case "discovering":
    case "discovered":
      return "payout-complete";
    case "paused":
      return "payout-pending";
    default:
      return "sourced";
  }
}

export function CampaignStatusBadge({ status, className }: { status: string; className?: string }) {
  return <StatusBadge state={campaignTone(status)} label={campaignLabel(status)} className={className} />;
}

/**
 * Campaign status → the words a label reads. The raw DB value ("discovering",
 * "draft") used to be passed straight through as a badge label, which put
 * lowercase machine vocabulary on a client screen. The LABEL map above is
 * deal-stage vocabulary ("Sourced", "Paid") and is wrong for a campaign, so
 * campaigns get their own. Shared here because both /campaigns and
 * /campaigns/[id] render this badge.
 */
const CAMPAIGN_LABEL: Record<string, string> = {
  draft: "Draft",
  discovering: "Finding creators",
  outreach: "Outreach",
  active: "Active",
  completed: "Completed",
  paused: "Paused",
};

/** Falls back to de-snake-cased sentence case so an unmapped status still reads. */
export function campaignLabel(s: string): string {
  return (
    CAMPAIGN_LABEL[s] ??
    String(s ?? "")
      .replace(/_/g, " ")
      .replace(/^./, (ch) => ch.toUpperCase())
  );
}

export function PaperMoneyChip({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md bg-paper-money px-2 py-0.5 text-xs font-medium text-paper-money-fg",
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      Paper-money mode
    </span>
  );
}
