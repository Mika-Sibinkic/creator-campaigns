"use client";

// Guided contract builder: one question group per screen, answers saved as a
// local draft, a preview of the exact agreement, then "Approve and apply".
//
// The page never assembles legal text itself. The preview comes from
// POST /api/firm/contract-template/builder/preview (pure, no writes unless
// the optional wording polish is asked for), and apply re-derives the text
// from the answers server-side. What this file owns is the questions.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronLeft, ChevronRight, Lock, RotateCcw, Sparkles } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AttentionCallout } from "@/components/page";
import { cn } from "@/lib/utils";
import {
  OPTIONS,
  PLATFORMS,
  PLATFORM_LABEL,
  POST_TYPES,
  defaultAnswers,
  paymentMatchesPolicy,
  type BuilderAnswers,
  type PolicyLike,
  type PostType,
} from "@/lib/contract-builder-options";

// ── Server shapes ──────────────────────────────────────────────────────────

interface BuilderContext {
  firm_id: string;
  firm_name: string;
  settlement: { split_enabled: boolean; deposit_pct: number };
  current_template: { name: string; updated_at: string; approved_at: string | null } | null;
}

interface PreviewResult {
  base_text: string;
  body_text: string;
  source: "deterministic" | "polished";
  warnings: string[];
  diff: { removedSections: string[]; removedPlaceholders: string[]; addedSections: string[]; addedPlaceholders: string[] } | null;
  reworded_sections: string[];
  problems: string[];
}

// ── Steps ──────────────────────────────────────────────────────────────────

const STEPS = [
  { key: "parties", title: "Parties" },
  { key: "deliverables", title: "Deliverables" },
  { key: "timing", title: "Timing" },
  { key: "payment", title: "Payment" },
  { key: "rights", title: "Content rights" },
  { key: "compliance", title: "Compliance" },
  { key: "performance", title: "Performance" },
  { key: "termination", title: "Termination and disputes" },
  { key: "acceptance", title: "Signature" },
  { key: "preview", title: "Preview" },
] as const;
type StepKey = (typeof STEPS)[number]["key"];

const DRAFT_VERSION = 1;
const draftKey = (firmId: string) => `creator-campaigns.contract-builder.v${DRAFT_VERSION}.${firmId}`;

const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware",
  "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky",
  "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi",
  "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico",
  "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania",
  "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont",
  "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
];
const stateJurisdiction = (s: string) => `the State of ${s}`;

// ── Tiles ──────────────────────────────────────────────────────────────────

function Tile({
  selected,
  onSelect,
  title,
  hint,
  disabled,
  multi,
  locked,
}: {
  selected: boolean;
  onSelect?: () => void;
  title: React.ReactNode;
  hint?: React.ReactNode;
  disabled?: boolean;
  multi?: boolean;
  locked?: boolean;
}) {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={selected}
      aria-disabled={disabled || locked}
      disabled={disabled}
      onClick={() => {
        if (!disabled && !locked) onSelect?.();
      }}
      className={cn(
        "group relative flex min-h-14 w-full flex-col items-start justify-center gap-0.5 rounded-lg border bg-card px-3.5 py-2.5 text-left transition-colors outline-none",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        selected
          ? "border-primary bg-primary/[0.06] ring-1 ring-primary"
          : "border-border hover:border-foreground/25 hover:bg-muted/40",
        disabled && "cursor-not-allowed opacity-50 hover:border-border hover:bg-card",
        locked && "cursor-default",
      )}
    >
      <span className="flex w-full items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span
          aria-hidden
          className={cn(
            "flex size-4.5 shrink-0 items-center justify-center border transition-colors",
            multi ? "rounded-[5px]" : "rounded-full",
            selected ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background",
          )}
        >
          {locked ? <Lock className="size-2.5" /> : selected ? <Check className="size-3" strokeWidth={3} /> : null}
        </span>
      </span>
      {hint && <span className="text-meta text-muted-foreground">{hint}</span>}
    </button>
  );
}

function Question({
  label,
  note,
  children,
  cols = 2,
}: {
  label: string;
  note?: React.ReactNode;
  children: React.ReactNode;
  cols?: 2 | 3 | 4;
}) {
  return (
    <fieldset className="space-y-2.5">
      <legend className="mb-2.5 text-sm font-medium text-foreground">{label}</legend>
      <div
        role="group"
        className={cn(
          "grid grid-cols-1 gap-2 min-[420px]:grid-cols-2",
          cols === 3 && "sm:grid-cols-3",
          cols === 4 && "sm:grid-cols-4",
        )}
      >
        {children}
      </div>
      {note && <p className="text-meta text-muted-foreground">{note}</p>}
    </fieldset>
  );
}

function days(n: number) {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

// ── Agreement preview ──────────────────────────────────────────────────────

// split() needs the capture group; the per-part test must not be global, or
// lastIndex carries over between calls and every other slot renders plain.
const PH_SPLIT = /(\{\{\s*[A-Za-z0-9_]+\s*\}\})/;
const PH_WHOLE = /^\{\{\s*[A-Za-z0-9_]+\s*\}\}$/;
const HEADING = /^(\d+\.\s+[A-Z][A-Z0-9 ()/,&'-]{2,70}?\.)\s([\s\S]*)$/;

function withSlots(text: string) {
  return text.split(PH_SPLIT).map((part, i) =>
    PH_WHOLE.test(part) ? (
      <span
        key={i}
        className="rounded bg-brand-accent/10 px-1 py-px font-mono text-[0.8em] text-brand-accent-deep dark:text-brand-accent"
      >
        {part.replace(/[{}\s]/g, "")}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function AgreementPreview({ text, reworded }: { text: string; reworded: string[] }) {
  const paragraphs = text.split(/\n{2,}/);
  return (
    <article className="rounded-lg border bg-card px-5 py-6 text-[0.9375rem] leading-relaxed text-card-foreground sm:px-8 sm:py-8">
      {paragraphs.map((p, i) => {
        if (i === 0) {
          return (
            <h3 key={i} className="mb-5 font-display text-base tracking-wide text-foreground sm:text-lg">
              {p}
            </h3>
          );
        }
        const m = p.match(HEADING);
        if (m) {
          const heading = m[1].replace(/^\d+\.\s+/, "").replace(/\.$/, "");
          const changed = reworded.includes(heading);
          return (
            <p
              key={i}
              className={cn(
                "mb-4",
                changed && "-ml-3 border-l-2 border-primary pl-[10px] sm:-ml-4 sm:pl-[14px]",
              )}
            >
              <span className="font-semibold text-foreground">{m[1]}</span> {withSlots(m[2])}
              {changed && (
                <span className="ml-2 inline-block rounded bg-primary/10 px-1.5 text-meta font-medium text-primary">
                  Reworded
                </span>
              )}
            </p>
          );
        }
        return (
          <p key={i} className="mb-4 whitespace-pre-line">
            {withSlots(p)}
          </p>
        );
      })}
    </article>
  );
}

// ── Builder ────────────────────────────────────────────────────────────────

export function ContractBuilder() {
  const [ctx, setCtx] = useState<BuilderContext | null>(null);
  const [loadError, setLoadError] = useState("");
  const [answers, setAnswers] = useState<BuilderAnswers | null>(null);
  const [step, setStep] = useState(0);
  const [visited, setVisited] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  const [lawOther, setLawOther] = useState(false);

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [readIt, setReadIt] = useState(false);
  const [applying, setApplying] = useState(false);
  const [appliedAt, setAppliedAt] = useState<string | null>(null);

  const policy: PolicyLike | null = useMemo(
    () =>
      ctx ? { splitEnabled: ctx.settlement.split_enabled, depositPct: ctx.settlement.deposit_pct } : null,
    [ctx],
  );

  // Load context, then the local draft (if any) for this firm.
  useEffect(() => {
    fetch("/api/firm/contract-template/builder")
      .then(async (r) => {
        if (!r.ok) throw new Error(`builder context ${r.status}`);
        return (await r.json()) as BuilderContext;
      })
      .then((c) => {
        setCtx(c);
        const pol = { splitEnabled: c.settlement.split_enabled, depositPct: c.settlement.deposit_pct };
        let next = defaultAnswers(c.firm_name ?? "", pol);
        let nextStep = 0;
        try {
          const raw = window.localStorage.getItem(draftKey(c.firm_id));
          if (raw) {
            const saved = JSON.parse(raw) as { answers?: BuilderAnswers; step?: number };
            if (saved.answers) next = { ...next, ...saved.answers };
            if (typeof saved.step === "number") nextStep = Math.min(Math.max(0, saved.step), STEPS.length - 2);
          }
        } catch {
          // A corrupt draft is not worth an error; start from defaults.
        }
        const law = next.termination.governingLaw;
        setLawOther(!US_STATES.some((s) => stateJurisdiction(s) === law));
        setAnswers(next);
        setStep(nextStep);
        setVisited(nextStep);
      })
      .catch((e) => {
        console.error("[contract-builder] load failed", e);
        setLoadError("We couldn't load the contract builder. Refresh the page to try again.");
      });
  }, []);

  // Save the draft on every change.
  useEffect(() => {
    if (!ctx || !answers || appliedAt) return;
    try {
      window.localStorage.setItem(draftKey(ctx.firm_id), JSON.stringify({ answers, step }));
    } catch {
      // Storage full or disabled: the builder still works, it just won't resume.
    }
  }, [ctx, answers, step, appliedAt]);

  const set = useCallback(
    <K extends keyof BuilderAnswers>(group: K, patch: Partial<BuilderAnswers[K]>) => {
      setAnswers((a) => (a ? { ...a, [group]: { ...a[group], ...patch } } : a));
      setPreview(null);
      setReadIt(false);
      setStepError(null);
    },
    [],
  );

  const toggle = <T extends string>(list: T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const paymentCheck = useMemo(
    () => (answers && policy ? paymentMatchesPolicy(answers.payment, policy) : { ok: true as const }),
    [answers, policy],
  );

  const loadPreview = useCallback(
    async (polish: boolean) => {
      if (!answers) return;
      if (polish) setPolishing(true);
      else setPreviewLoading(true);
      try {
        const r = await fetch("/api/firm/contract-template/builder/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers, polish }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.status === 422 && d?.errors) {
          const [group, msg] = Object.entries(d.errors as Record<string, string>)[0] ?? [];
          const idx = STEPS.findIndex((s) => s.key === group);
          if (idx >= 0) setStep(idx);
          setStepError(msg ?? "Some answers need another look.");
          return;
        }
        if (!r.ok) {
          toast.error("We couldn't build the preview. Try again in a moment.");
          return;
        }
        const result = d as PreviewResult;
        setPreview(result);
        setShowOriginal(false);
        setReadIt(false);
        if (polish) {
          if (result.source === "polished") {
            toast.success(
              result.reworded_sections.length > 0
                ? `Wording polished in ${result.reworded_sections.length} ${result.reworded_sections.length === 1 ? "section" : "sections"}.`
                : "Polish found nothing to change.",
            );
          } else {
            toast.warning("The polish tried to change a term, so we kept your original wording.");
          }
        }
      } catch (e) {
        console.error("[contract-builder] preview threw", e);
        toast.error("We couldn't reach the server. Check your connection and try again.");
      } finally {
        setPolishing(false);
        setPreviewLoading(false);
      }
    },
    [answers],
  );

  const current = STEPS[step];

  function validateStep(key: StepKey): string | null {
    if (!answers) return null;
    if (key === "deliverables") {
      if (answers.deliverables.platforms.length === 0) return "Pick at least one platform.";
      if (answers.deliverables.postTypes.length === 0) return "Pick at least one post type.";
    }
    if (key === "termination" && !answers.termination.governingLaw.trim()) {
      return "Enter the state or country whose law governs the agreement.";
    }
    return null;
  }

  function go(to: number) {
    if (to > step) {
      const err = validateStep(current.key);
      if (err) {
        setStepError(err);
        return;
      }
    }
    setStepError(null);
    setStep(to);
    setVisited((v) => Math.max(v, to));
    window.scrollTo({ top: 0, behavior: "smooth" });
    // Any answer change clears the preview, so arriving here without one
    // means the answers are new: build it now.
    if (STEPS[to].key === "preview" && !preview) void loadPreview(false);
  }

  function startOver() {
    if (!ctx || !policy) return;
    if (!window.confirm("Clear every answer and start again from the defaults?")) return;
    window.localStorage.removeItem(draftKey(ctx.firm_id));
    setAnswers(defaultAnswers(ctx.firm_name ?? "", policy));
    setLawOther(false);
    setPreview(null);
    setStep(0);
    setVisited(0);
  }

  async function apply() {
    if (!answers || !preview || !ctx) return;
    const shown = showOriginal ? preview.base_text : preview.body_text;
    setApplying(true);
    try {
      const r = await fetch("/api/firm/contract-template/builder/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers, body_text: shown }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast.error(typeof d?.error === "string" ? d.error : "We couldn't apply the contract. Nothing was changed.");
        return;
      }
      window.localStorage.removeItem(draftKey(ctx.firm_id));
      setAppliedAt(d.approved_at ?? new Date().toISOString());
      toast.success("Contract approved and applied.");
    } catch (e) {
      console.error("[contract-builder] apply threw", e);
      toast.error("We couldn't reach the server. Nothing was changed.");
    } finally {
      setApplying(false);
    }
  }

  if (loadError) return <p className="text-sm text-destructive">{loadError}</p>;
  if (!ctx || !answers || !policy) return <p className="text-sm text-muted-foreground">Loading…</p>;

  if (appliedAt) {
    return (
      <div className="space-y-4 rounded-lg border bg-card p-6">
        <p className="text-section-title text-foreground">Applied to {ctx.firm_name || "this workspace"}</p>
        <p className="text-sm text-muted-foreground">
          Deals that close from now on attach this agreement, with each creator&apos;s name, handle,
          amount, deliverables and dates filled in.
        </p>
        <Link href="/settings" className={buttonVariants({ variant: "outline" })}>
          Back to Settings
        </Link>
      </div>
    );
  }

  const a = answers;
  const total = STEPS.length;
  const shownText = preview ? (showOriginal ? preview.base_text : preview.body_text) : "";
  const depositChoices = Array.from(new Set([25, 30, 40, 50, 60, 75, policy.depositPct]))
    .filter((p) => p >= 1 && p <= 99)
    .sort((x, y) => x - y);

  return (
    <div className="space-y-8">
      {/* Progress */}
      <nav aria-label="Contract builder progress" className="space-y-3">
        <div className="flex items-baseline justify-between gap-4">
          <p className="text-meta text-muted-foreground">
            <span className="tabular-nums">Step {step + 1} of {total}</span>
          </p>
          <button
            type="button"
            onClick={startOver}
            className="inline-flex items-center gap-1 text-meta text-muted-foreground transition-colors hover:text-foreground"
          >
            <RotateCcw className="size-3" /> Start over
          </button>
        </div>
        <ol className="flex gap-1">
          {STEPS.map((s, i) => (
            <li key={s.key} className="flex-1">
              <button
                type="button"
                aria-label={`${s.title}${i === step ? " (current)" : ""}`}
                aria-current={i === step ? "step" : undefined}
                disabled={i > visited}
                onClick={() => go(i)}
                className={cn(
                  "block h-1.5 w-full rounded-full transition-colors",
                  i < step && "bg-primary",
                  i === step && "bg-primary/60",
                  i > step && (i <= visited ? "bg-primary/20 hover:bg-primary/35" : "bg-muted"),
                )}
              />
            </li>
          ))}
        </ol>
      </nav>

      <section aria-labelledby="step-title" className="space-y-7">
        <h2 id="step-title" className="text-lg font-semibold tracking-tight text-foreground">
          {current.title}
        </h2>

        {stepError && (
          <p role="alert" className="text-sm text-destructive">
            {stepError}
          </p>
        )}

        {current.key === "parties" && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="cb-legal">Label legal name</Label>
                <Input
                  id="cb-legal"
                  value={a.parties.legalName}
                  placeholder="Example Records LLC"
                  onChange={(e) => set("parties", { legalName: e.target.value })}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="cb-addr">Address</Label>
                <Input
                  id="cb-addr"
                  value={a.parties.address}
                  placeholder="Street, city, state"
                  onChange={(e) => set("parties", { address: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cb-signer">Signer name</Label>
                <Input
                  id="cb-signer"
                  value={a.parties.signerName}
                  onChange={(e) => set("parties", { signerName: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cb-title">Signer title</Label>
                <Input
                  id="cb-title"
                  value={a.parties.signerTitle}
                  placeholder="Owner"
                  onChange={(e) => set("parties", { signerTitle: e.target.value })}
                />
              </div>
            </div>
            <p className="text-meta text-muted-foreground">
              The creator&apos;s name and handle are filled in on each deal.
            </p>
          </div>
        )}

        {current.key === "deliverables" && (
          <>
            <Question label="Platforms" cols={3}>
              {PLATFORMS.map((p) => (
                <Tile
                  key={p}
                  multi
                  title={PLATFORM_LABEL[p]}
                  selected={a.deliverables.platforms.includes(p)}
                  onSelect={() => set("deliverables", { platforms: toggle(a.deliverables.platforms, p) })}
                />
              ))}
            </Question>
            <Question label="Post types" cols={3}>
              {POST_TYPES.map((p) => (
                <Tile
                  key={p}
                  multi
                  title={{ short_video: "Short video", story: "Story", carousel: "Photo carousel" }[p as PostType]}
                  selected={a.deliverables.postTypes.includes(p)}
                  onSelect={() => set("deliverables", { postTypes: toggle(a.deliverables.postTypes, p) })}
                />
              ))}
            </Question>
            <Question label="Number of posts" cols={4}>
              {OPTIONS.minCount.map((n) => (
                <Tile
                  key={n}
                  title={n === 0 ? "Set per deal" : `At least ${n}`}
                  selected={a.deliverables.minCount === n}
                  onSelect={() => set("deliverables", { minCount: n })}
                />
              ))}
            </Question>
            <Question label="Minimum length" cols={4}>
              {OPTIONS.minLengthSec.map((n) => (
                <Tile
                  key={n}
                  title={n === 0 ? "None" : `${n} seconds`}
                  selected={a.deliverables.minLengthSec === n}
                  onSelect={() => set("deliverables", { minLengthSec: n })}
                />
              ))}
            </Question>
            <Question label="Every post must include">
              <Tile
                multi
                title="The track as the sound"
                selected={a.deliverables.useSound}
                onSelect={() => set("deliverables", { useSound: !a.deliverables.useSound })}
              />
              <Tile
                multi
                title="Link to the track"
                hint="In the caption or bio"
                selected={a.deliverables.includeLink}
                onSelect={() => set("deliverables", { includeLink: !a.deliverables.includeLink })}
              />
              <Tile
                multi
                title="Campaign hashtag"
                hint="Supplied with the promo materials"
                selected={a.deliverables.includeHashtag}
                onSelect={() => set("deliverables", { includeHashtag: !a.deliverables.includeHashtag })}
              />
              <Tile multi locked selected title="#ad disclosure" hint="Always required" />
            </Question>
          </>
        )}

        {current.key === "timing" && (
          <>
            <Question
              label="Post deadline"
              note="The campaign window is the delivery window the creator agrees to on each deal."
              cols={4}
            >
              {OPTIONS.deadlineDays.map((n) => (
                <Tile
                  key={n}
                  title={n === 0 ? "Campaign window" : `${days(n)} max`}
                  hint={n === 0 ? undefined : "After accepting"}
                  selected={a.timing.deadlineDays === n}
                  onSelect={() => set("timing", { deadlineDays: n })}
                />
              ))}
            </Question>
            <Question label="Minimum time live" cols={4}>
              {OPTIONS.minLiveDays.map((n) => (
                <Tile
                  key={n}
                  title={days(n)}
                  selected={a.timing.minLiveDays === n}
                  onSelect={() => set("timing", { minLiveDays: n })}
                />
              ))}
            </Question>
            <Question label="Revision rounds before posting" cols={3}>
              {OPTIONS.revisionRounds.map((n) => (
                <Tile
                  key={n}
                  title={n === 0 ? "No review" : n === 1 ? "1 round" : `${n} rounds`}
                  selected={a.timing.revisionRounds === n}
                  onSelect={() => set("timing", { revisionRounds: n })}
                />
              ))}
            </Question>
          </>
        )}

        {current.key === "payment" && (
          <>
            <Question label="Structure" cols={3}>
              <Tile
                title="Full on approval"
                hint="Paid before posting"
                selected={a.payment.structure === "full_on_approval"}
                onSelect={() => set("payment", { structure: "full_on_approval" })}
              />
              <Tile
                title="Deposit, then balance"
                hint="Balance after the post is verified"
                selected={a.payment.structure === "deposit_balance"}
                onSelect={() =>
                  set("payment", {
                    structure: "deposit_balance",
                    depositPct: policy.splitEnabled && policy.depositPct > 0 && policy.depositPct < 100 ? policy.depositPct : 50,
                  })
                }
              />
              <Tile disabled selected={false} title="Full after posting" hint="Payouts can't do this yet" />
            </Question>
            {a.payment.structure === "deposit_balance" && (
              <Question label="Deposit" cols={4}>
                {depositChoices.map((p) => (
                  <Tile
                    key={p}
                    title={`${p}% now`}
                    hint={`${100 - p}% after`}
                    selected={a.payment.depositPct === p}
                    onSelect={() => set("payment", { depositPct: p })}
                  />
                ))}
              </Question>
            )}
            <Question
              label={a.payment.structure === "deposit_balance" ? "Each payment released within" : "Payment released within"}
              note={
                a.payment.structure === "deposit_balance"
                  ? "Deposit counts from your approval, balance from verification."
                  : "Counted from your approval of the deal."
              }
              cols={3}
            >
              {OPTIONS.payWithinDays.map((n) => (
                <Tile
                  key={n}
                  title={days(n)}
                  selected={a.payment.payWithinDays === n}
                  onSelect={() => set("payment", { payWithinDays: n })}
                />
              ))}
            </Question>
            <p className="text-meta text-muted-foreground">Paid through Stripe.</p>
            {!paymentCheck.ok && (
              <AttentionCallout title="Doesn't match your payouts">{paymentCheck.reason}</AttentionCallout>
            )}
          </>
        )}

        {current.key === "rights" && (
          <>
            <Question label="Label may repost the content for" cols={4}>
              {OPTIONS.usageMonths.map((n) => (
                <Tile
                  key={n}
                  title={n === 0 ? "No reposting" : `${n} months`}
                  selected={a.rights.usageMonths === n}
                  onSelect={() => set("rights", { usageMonths: n, ...(n === 0 ? { paidAds: false } : {}) })}
                />
              ))}
            </Question>
            <Question label="Use in the label's paid ads">
              <Tile
                title="No"
                selected={!a.rights.paidAds}
                onSelect={() => set("rights", { paidAds: false })}
              />
              <Tile
                title="Yes"
                hint={a.rights.usageMonths === 0 ? "Needs a repost period" : "For the same period"}
                disabled={a.rights.usageMonths === 0}
                selected={a.rights.paidAds}
                onSelect={() => set("rights", { paidAds: true })}
              />
            </Question>
            <Question label="Whitelisting / Spark Ads">
              <Tile
                title="No"
                selected={!a.rights.whitelisting}
                onSelect={() => set("rights", { whitelisting: false })}
              />
              <Tile
                title="Yes"
                hint="Ads run from the creator's account"
                selected={a.rights.whitelisting}
                onSelect={() => set("rights", { whitelisting: true })}
              />
            </Question>
            <Question label="Exclusivity" cols={4}>
              {OPTIONS.exclusivityDays.map((n) => (
                <Tile
                  key={n}
                  title={n === 0 ? "None" : days(n)}
                  selected={a.rights.exclusivityDays === n}
                  onSelect={() => set("rights", { exclusivityDays: n })}
                />
              ))}
            </Question>
            {a.rights.exclusivityDays > 0 && (
              <Question label="No paid posts for">
                <Tile
                  title="Other labels"
                  hint="Record labels and distributors"
                  selected={a.rights.exclusivityCategory === "labels"}
                  onSelect={() => set("rights", { exclusivityCategory: "labels" })}
                />
                <Tile
                  title="Any other music"
                  selected={a.rights.exclusivityCategory === "any_music"}
                  onSelect={() => set("rights", { exclusivityCategory: "any_music" })}
                />
              </Question>
            )}
          </>
        )}

        {current.key === "compliance" && (
          <Question label="Clauses">
            <Tile multi locked selected title="FTC disclosure" hint="Always required" />
            <Tile
              multi
              title="No bots or bought engagement"
              selected={a.compliance.noBots}
              onSelect={() => set("compliance", { noBots: !a.compliance.noBots })}
            />
            <Tile
              multi
              title="Brand safety and conduct"
              hint="Termination for disrepute"
              selected={a.compliance.brandSafety}
              onSelect={() => set("compliance", { brandSafety: !a.compliance.brandSafety })}
            />
            <Tile
              multi
              title="Takedown on request"
              hint="Within 48 hours"
              selected={a.compliance.takedown}
              onSelect={() => set("compliance", { takedown: !a.compliance.takedown })}
            />
          </Question>
        )}

        {current.key === "performance" && (
          <>
            <Question label="Views" note="Views are measured either way, from the platform's public count.">
              <Tile
                title="No guarantee"
                hint="Payment never depends on views"
                selected={!a.performance.guarantee}
                onSelect={() => set("performance", { guarantee: false })}
              />
              <Tile
                title="Minimum views"
                hint="Short of it, one free extra post"
                selected={a.performance.guarantee}
                onSelect={() => set("performance", { guarantee: true })}
              />
            </Question>
            {a.performance.guarantee && (
              <>
                <Question label="Minimum per post" cols={4}>
                  {OPTIONS.minViews.map((n) => (
                    <Tile
                      key={n}
                      title={n.toLocaleString("en-US")}
                      selected={a.performance.minViews === n}
                      onSelect={() => set("performance", { minViews: n })}
                    />
                  ))}
                </Question>
                <Question label="Counted after" cols={3}>
                  {OPTIONS.measureAfterDays.map((n) => (
                    <Tile
                      key={n}
                      title={days(n)}
                      selected={a.performance.measureAfterDays === n}
                      onSelect={() => set("performance", { measureAfterDays: n })}
                    />
                  ))}
                </Question>
              </>
            )}
          </>
        )}

        {current.key === "termination" && (
          <>
            <Question label="Kill fee if you cancel before posting" cols={3}>
              {OPTIONS.killFeePct.map((n) => (
                <Tile
                  key={n}
                  title={n === 0 ? "None" : `${n}%`}
                  hint={n === 0 ? "Unposted work is repaid" : "Of that post's fee"}
                  selected={a.termination.killFeePct === n}
                  onSelect={() => set("termination", { killFeePct: n })}
                />
              ))}
            </Question>
            <div className="space-y-2.5">
              <Label htmlFor="cb-law" className="text-sm font-medium">
                Governing law
              </Label>
              <select
                id="cb-law"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:max-w-xs sm:text-sm"
                value={lawOther ? "__other" : a.termination.governingLaw}
                onChange={(e) => {
                  if (e.target.value === "__other") {
                    setLawOther(true);
                    set("termination", { governingLaw: "" });
                  } else {
                    setLawOther(false);
                    set("termination", { governingLaw: e.target.value });
                  }
                }}
              >
                {US_STATES.map((s) => (
                  <option key={s} value={stateJurisdiction(s)}>
                    {s}
                  </option>
                ))}
                <option value="__other">Somewhere else</option>
              </select>
              {lawOther && (
                <Input
                  aria-label="Jurisdiction"
                  value={a.termination.governingLaw}
                  placeholder="England and Wales"
                  className="sm:max-w-xs"
                  onChange={(e) => set("termination", { governingLaw: e.target.value })}
                />
              )}
            </div>
            <Question label="Disputes go to" cols={3}>
              <Tile
                title="Courts"
                hint="In the governing-law state"
                selected={a.termination.venue === "courts"}
                onSelect={() => set("termination", { venue: "courts" })}
              />
              <Tile
                title="Arbitration"
                hint="Binding, one arbitrator"
                selected={a.termination.venue === "arbitration"}
                onSelect={() => set("termination", { venue: "arbitration" })}
              />
              <Tile
                title="Small claims first"
                hint="Courts above the limit"
                selected={a.termination.venue === "small_claims"}
                onSelect={() => set("termination", { venue: "small_claims" })}
              />
            </Question>
          </>
        )}

        {current.key === "acceptance" && (
          <Question label="The creator accepts by" note="No e-signature service is involved either way.">
            <Tile
              title={"Replying “I agree”"}
              hint="Or by collecting payment or posting"
              selected={a.acceptance.method === "reply_or_conduct"}
              onSelect={() => set("acceptance", { method: "reply_or_conduct" })}
            />
            <Tile
              title="Collecting payment or posting"
              hint="No reply needed"
              selected={a.acceptance.method === "conduct"}
              onSelect={() => set("acceptance", { method: "conduct" })}
            />
          </Question>
        )}

        {current.key === "preview" && (
          <div className="space-y-5">
            {ctx.current_template && (
              <p className="text-meta text-muted-foreground">
                Applying replaces your current contract{ctx.current_template.approved_at ? ", which is approved" : ""}.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!preview || polishing || previewLoading}
                onClick={() => void loadPreview(true)}
              >
                <Sparkles data-icon="inline-start" />
                {polishing ? "Polishing…" : "Polish wording"}
              </Button>
              {preview?.source === "polished" && (
                <Button variant="ghost" size="sm" onClick={() => setShowOriginal((v) => !v)}>
                  {showOriginal ? "Show polished" : "Show original"}
                </Button>
              )}
              <span className="text-meta text-faint">Wording only. Terms never change.</span>
            </div>

            {preview?.source === "polished" && !showOriginal && preview.diff && (
              <div className="rounded-md border bg-muted/40 px-3.5 py-2.5 text-meta text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">Reworded:</span>{" "}
                  {preview.reworded_sections.length > 0
                    ? preview.reworded_sections.map((h) => h.toLowerCase()).join(", ")
                    : "nothing"}
                </p>
                <p>
                  <span className="font-medium text-foreground">Removed:</span>{" "}
                  {[...preview.diff.removedSections, ...preview.diff.removedPlaceholders].length === 0
                    ? "nothing"
                    : [...preview.diff.removedSections, ...preview.diff.removedPlaceholders].join(", ")}
                </p>
              </div>
            )}

            {previewLoading || !preview ? (
              <p className="text-sm text-muted-foreground">Building the agreement…</p>
            ) : (
              <AgreementPreview text={shownText} reworded={showOriginal ? [] : preview.reworded_sections} />
            )}

            <p className="text-meta text-muted-foreground">
              <span className="rounded bg-brand-accent/10 px-1 font-mono text-[0.8em] text-brand-accent-deep dark:text-brand-accent">
                highlighted
              </span>{" "}
              terms are filled in on each deal.
            </p>

            {!paymentCheck.ok && (
              <AttentionCallout title="Payment doesn't match your payouts">{paymentCheck.reason}</AttentionCallout>
            )}
            {preview && preview.problems.length > 0 && (
              <AttentionCallout title="This agreement can't send yet">
                {preview.problems.join(", ")}
              </AttentionCallout>
            )}

            <div className="space-y-4 border-t pt-5">
              <p className="text-sm font-medium text-foreground">
                Template, not legal advice. Have counsel review before live use.
              </p>
              <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  checked={readIt}
                  disabled={!preview}
                  onChange={(e) => setReadIt(e.target.checked)}
                />
                <span>I have read this agreement and approve it for sending to creators.</span>
              </label>
              <Button
                size="lg"
                disabled={
                  !preview || !readIt || applying || !paymentCheck.ok || (preview?.problems.length ?? 0) > 0
                }
                onClick={() => void apply()}
              >
                {applying ? "Applying…" : "Approve and apply to this firm"}
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* Back / next */}
      <div className="flex items-center justify-between gap-3 border-t pt-5">
        <Button variant="ghost" disabled={step === 0} onClick={() => go(step - 1)}>
          <ChevronLeft data-icon="inline-start" />
          Back
        </Button>
        {current.key !== "preview" && (
          <Button onClick={() => go(step + 1)}>
            {STEPS[step + 1].key === "preview" ? "Preview agreement" : STEPS[step + 1].title}
            <ChevronRight data-icon="inline-end" />
          </Button>
        )}
      </div>
    </div>
  );
}
