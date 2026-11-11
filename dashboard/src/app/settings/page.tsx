"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState, SettingsSection } from "@/components/page";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AppShell } from "@/components/AppShell";
import { ContractTemplateCard } from "@/components/ContractTemplateCard";
import { ThemeCard } from "@/components/ThemeCard";
import { SpendCapsCard } from "@/components/SpendCapsCard";
import { PaymentsCard } from "@/components/PaymentsCard";
import { OperatorOnly, useIsOperator } from "@/components/OperatorContext";
import {
  PERSONALITY,
  DEFAULT_PERSONALITY,
  isPersonalityKey,
  type PersonalityKey,
} from "@/lib/personality";

interface Firm {
  id?: string;
  name?: string | null;
  testing_mode: boolean;
  test_recipient_email: string | null;
  negotiation_inbox_email: string | null;
  sender_email: string | null;
  sender_name: string | null;
  voice_profile: unknown;
  // jsonb prefs bag (migration 009) — carries the personality dial and the
  // free-text tone the draft prompt actually reads.
  outreach_prefs: Record<string, unknown> | null;
  // N5 — migration 014 — monthly spend caps (0 disables)
  monthly_spend_cap_usd: number | null;
  per_creator_monthly_cap_usd: number | null;
  // Migration 016 — per-firm daily Apify pipeline cap (0 disables)
  daily_apify_cap_usd: number | null;
}

interface FirmMember {
  id: string;
  role: string;
  sender_email: string | null;
  sender_name: string | null;
  test_recipient_email: string | null;
  negotiation_inbox_email: string | null;
}

// /api/payments/mode returns the resolved mode (src/lib/stripe-isolated.ts
// PaymentMode); its copy lives in src/components/PaymentsCard.tsx, which
// tolerates a mode it has no copy for.
type PaymentMode = string;

function clean(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : null;
}

/**
 * The free-text voice the draft prompt actually honors.
 *
 * `outreach_prefs.tone` is the live slot: the draft path reads
 * outreach_prefs first (voice, then tone) and only falls back to the legacy
 * `voice_profile` column when outreach_prefs is absent entirely — which it
 * never is once the personality dial has been set. Read both so nobody's
 * existing wording disappears; write only the live one.
 */
function voiceText(firm: Firm): string {
  const prefs = firm.outreach_prefs ?? {};
  const fromPrefs = prefs.voice ?? prefs.tone;
  if (typeof fromPrefs === "string" && fromPrefs.trim().length > 0) return fromPrefs;
  if (typeof firm.voice_profile === "string") return firm.voice_profile;
  if (firm.voice_profile && typeof firm.voice_profile === "object") {
    const legacy = (firm.voice_profile as Record<string, unknown>).tone;
    if (typeof legacy === "string") return legacy;
  }
  return "";
}

export default function SettingsPage() {
  const [firm, setFirm] = useState<Firm | null>(null);
  const [member, setMember] = useState<FirmMember | null>(null);
  const [memberSettled, setMemberSettled] = useState(false);
  const [paymentMode, setPaymentMode] = useState<PaymentMode | null>(null);
  const [error, setError] = useState("");
  const isOperator = useIsOperator();

  useEffect(() => {
    fetch("/api/firm")
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.text();
          // Technical detail stays in devtools; the page shows a plain sentence.
          console.error(`[settings] GET /api/firm ${r.status}: ${body.slice(0, 200)}`);
          throw new Error("firm-load-failed");
        }
        return r.json();
      })
      .then((data: Firm) => setFirm(data))
      .catch((e: Error) => {
        console.error("[settings] firm load failed", e);
        setError("We couldn't load your settings right now. Refresh the page to try again.");
      });

    // Per-user overrides — 404 means the row doesn't exist yet
    // (pre-bootstrap dev-stub). Treat that as "no overrides set".
    fetch("/api/firm-member")
      .then(async (r) => {
        if (r.status === 404) return null;
        if (!r.ok) {
          const body = await r.text();
          console.error(`[settings] GET /api/firm-member ${r.status}: ${body.slice(0, 200)}`);
          throw new Error("firm-member-load-failed");
        }
        return r.json() as Promise<FirmMember>;
      })
      .then((data) => {
        if (data) setMember(data);
      })
      .catch((e: Error) => {
        // Non-fatal — the rest of the page still works.
        console.warn("firm-member load failed", e.message);
      })
      .finally(() => setMemberSettled(true));

    // Payments mode (read-only). Resolves the same way stripe-isolated does
    // internally so the UI badge can't drift from the actual dispatch path.
    fetch("/api/payments/mode")
      .then(async (r) => {
        if (!r.ok) return null;
        return r.json() as Promise<{ mode: PaymentMode }>;
      })
      .then((data) => {
        if (data?.mode) setPaymentMode(data.mode);
      })
      .catch(() => {
        /* non-fatal — banner stays hidden if the route is unreachable */
      });
  }, []);

  // One save path for both rows. The status lives in a toast that dismisses
  // itself: an earlier version set "Saved" in a <p> and never cleared it, so
  // the page claimed a save that had happened minutes ago.
  async function patchRow<T>(
    url: string,
    updates: object,
    apply: (row: T) => void,
  ): Promise<void> {
    const id = toast.loading("Saving…");
    try {
      const r = await fetch(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(updates),
      });
      const d = await r.json();
      if (r.ok) {
        apply(d as T);
        toast.success("Saved", { id });
      } else {
        console.error(`[settings] PATCH ${url} failed`, r.status, d);
        toast.error("We couldn't save that. Try again in a moment.", { id });
      }
    } catch (e) {
      console.error(`[settings] PATCH ${url} threw`, e);
      toast.error("We couldn't save that. Check your connection and try again.", { id });
    }
  }

  const save = (updates: Partial<Firm>) => patchRow<Firm>("/api/firm", updates, setFirm);
  const saveMember = (updates: Partial<FirmMember>) =>
    patchRow<FirmMember>("/api/firm-member", updates, setMember);

  if (error) {
    return (
      <AppShell title="Settings" width="medium">
        <div className="mx-auto w-full max-w-5xl px-4 pb-12 pt-6 sm:px-6 lg:px-8">
          <EmptyState title={<span className="text-destructive">{error}</span>} />
        </div>
      </AppShell>
    );
  }

  if (!firm) {
    return (
      <AppShell title="Settings" width="medium">
        <div className="mx-auto w-full max-w-5xl space-y-6 px-4 pb-12 pt-8 sm:px-6 lg:px-8">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </AppShell>
    );
  }

  const storedPersonality = firm.outreach_prefs?.personality;
  const personality: PersonalityKey = isPersonalityKey(storedPersonality)
    ? storedPersonality
    : DEFAULT_PERSONALITY;

  // What a creator would actually see on a message you send right now.
  // Per-user override first, then the workspace default — the same order
  // src/lib/resend.ts resolves them in at send time.
  const workspaceName = clean(firm.name);
  const senderName = clean(member?.sender_name) ?? clean(firm.sender_name);
  const senderEmail = clean(member?.sender_email) ?? clean(firm.sender_email);
  const replyInbox = clean(firm.negotiation_inbox_email);
  const voiceDefault = voiceText(firm);

  return (
    <AppShell title="Settings" width="medium">
      <div className="mx-auto w-full max-w-5xl px-4 pb-12 pt-6 sm:px-6 lg:px-8">

      {/* Labels: a read-only badge. Operators: account, balance, readiness
          checklist and the Test/Live switch (src/components/PaymentsCard.tsx). */}
      <PaymentsCard mode={paymentMode} />

      <SettingsSection
        title="Outreach sender"
        description="Who creators see the message from, and where their replies land."
      >
        <div className="max-w-xl space-y-6">
          <div className="space-y-1 rounded-lg border bg-muted/40 px-4 py-3">
            <p className="text-meta text-muted-foreground">What creators see on your messages</p>
            <p className="text-sm font-medium">
              {senderName ?? "Creator Campaigns"}
              <span className="ml-2 font-normal text-muted-foreground">
                {senderEmail ? `<${senderEmail}>` : "<a sending address>"}
              </span>
            </p>
            {(!senderName || !senderEmail) && (
              <p className="text-xs text-attention-fg">
                That&apos;s us, not you. Fill the sender in below so creators see
                the label they&apos;re hearing from.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {replyInbox
                ? `Replies come back to ${replyInbox}.`
                : senderEmail
                  ? "No separate reply inbox, so replies come back to the sender address above."
                  : "With no address set, a creator's reply can't be matched back to their campaign."}
            </p>
            {!isOperator && firm.testing_mode && (
              <p className="text-xs text-attention-fg">
                Delivery is paused: messages are drafted and reviewed, but nothing
                is being sent to creators yet.
              </p>
            )}
          </div>

          <div className="space-y-4">
            <p className="text-meta font-medium text-foreground">
              Workspace default, used by everyone here
            </p>
            <div className="space-y-2">
              <Label htmlFor="se">Sender email</Label>
              <Input
                id="se"
                type="email"
                defaultValue={firm.sender_email ?? ""}
                placeholder="outreach@yourlabel.com"
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next !== (firm.sender_email ?? "")) {
                    void save({ sender_email: next || null });
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                Use an address on a domain you&apos;ve verified for sending, or
                messages land in spam.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sn">Sender name</Label>
              <Input
                id="sn"
                defaultValue={firm.sender_name ?? workspaceName ?? ""}
                placeholder={workspaceName ?? "Your label's name"}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next !== (firm.sender_name ?? "")) {
                    void save({ sender_name: next || null });
                  }
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ni">Reply inbox</Label>
              <Input
                id="ni"
                type="email"
                defaultValue={firm.negotiation_inbox_email ?? ""}
                placeholder="replies@yourlabel.com"
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next !== (firm.negotiation_inbox_email ?? "")) {
                    void save({ negotiation_inbox_email: next || null });
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                Creator replies land here, and it&apos;s how a reply gets matched
                back to the right creator and campaign.
              </p>
            </div>
          </div>

          {/* Per-user override. Same two fields as above, deliberately NOT a
              second card: the pair used to render twice with nothing saying
              which one won at send time. */}
          <div className="space-y-4 border-t pt-4" key={member?.id ?? "no-member"}>
            <p className="text-meta font-medium text-foreground">Only for messages you send</p>
            <div className="space-y-2">
              <Label htmlFor="me-se">Your sender email</Label>
              <Input
                id="me-se"
                type="email"
                disabled={memberSettled && !member}
                defaultValue={member?.sender_email ?? ""}
                placeholder={firm.sender_email ?? "outreach@yourlabel.com"}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next !== (member?.sender_email ?? "")) {
                    void saveMember({ sender_email: next || null });
                  }
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="me-sn">Your sender name</Label>
              <Input
                id="me-sn"
                disabled={memberSettled && !member}
                defaultValue={member?.sender_name ?? ""}
                placeholder={firm.sender_name ?? workspaceName ?? "Your label's name"}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next !== (member?.sender_name ?? "")) {
                    void saveMember({ sender_name: next || null });
                  }
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {memberSettled && !member
                ? "Available once your account finishes setting up. Until then every message uses the workspace default above."
                : "Leave these blank and your messages use the workspace default above. Fill one in and it wins for your messages only."}
            </p>
          </div>
        </div>
      </SettingsSection>

      <ContractTemplateCard />

      <SpendCapsCard value={firm} onChange={(patch) => void save(patch)} />

      <SettingsSection
        title="Outreach voice"
        description="How drafts and negotiation replies read. Tone only, never the offer amount, and never who gets contacted."
      >
        <div className="max-w-xl space-y-6">
          <div className="space-y-2">
            <Label htmlFor="tone">Starting tone</Label>
            <Select
              value={personality}
              onValueChange={(v) => {
                if (!isPersonalityKey(v) || v === personality) return;
                void save({
                  outreach_prefs: { ...(firm.outreach_prefs ?? {}), personality: v },
                });
              }}
            >
              <SelectTrigger id="tone" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(PERSONALITY).map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {PERSONALITY[personality].directive}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="voice">Your own notes</Label>
            <Textarea
              id="voice"
              rows={6}
              defaultValue={voiceDefault}
              placeholder="e.g. Warm and specific. Mention one of their posts. Avoid exclamation points and hype."
              onBlur={(e) => {
                const raw = e.target.value.trim();
                if (raw === voiceDefault.trim()) return;
                void save({
                  outreach_prefs: { ...(firm.outreach_prefs ?? {}), tone: raw },
                });
              }}
            />
            <p className="text-xs text-muted-foreground">
              These notes go to the writer as the voice to honor, on top of the
              tone above, so they win wherever the two disagree. This is the same
              box as the one in setup.
            </p>
          </div>
        </div>
      </SettingsSection>

      {/* Operator-only. A label flipping this would silently redirect every
          message they send to one of our inboxes; the amber banner already
          tells them delivery is paused. src/lib/resend.ts and the /outreach
          send path keep reading firms.testing_mode either way. */}
      <OperatorOnly>
        <SettingsSection
          title="Testing mode (internal)"
          description="While this is on, every outbound message is redirected to a test inbox instead of the creator. The label sees a paused-delivery notice, not this section."
        >
          <div className="max-w-xl space-y-4">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="tm">Redirect all outreach to a test inbox</Label>
              <Switch
                id="tm"
                checked={firm.testing_mode}
                onCheckedChange={(v: boolean) => {
                  if (
                    firm.testing_mode &&
                    !v &&
                    !window.confirm(
                      "Are you sure? Future sends will go to real creators."
                    )
                  ) {
                    return;
                  }
                  void save({ testing_mode: v });
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="te">Redirect to: workspace</Label>
              <Input
                id="te"
                type="email"
                defaultValue={firm.test_recipient_email ?? ""}
                placeholder="where test sends should land"
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next !== (firm.test_recipient_email ?? "")) {
                    void save({ test_recipient_email: next || null });
                  }
                }}
              />
            </div>
            <div className="space-y-2" key={`tr-${member?.id ?? "no-member"}`}>
              <Label htmlFor="me-tr">Redirect to: just my sends</Label>
              <Input
                id="me-tr"
                type="email"
                disabled={memberSettled && !member}
                defaultValue={member?.test_recipient_email ?? ""}
                placeholder={firm.test_recipient_email ?? "your own inbox"}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next !== (member?.test_recipient_email ?? "")) {
                    void saveMember({ test_recipient_email: next || null });
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                Your own address wins over the workspace one for messages you
                send. With both blank the redirect falls back to your signed-in
                address, then the environment default; if none of them resolve the
                send fails rather than reaching a creator.
              </p>
            </div>
          </div>
        </SettingsSection>
      </OperatorOnly>

      <ThemeCard />
      </div>
    </AppShell>
  );
}
