"use client";

// Settings card for the label's deal-contract template.
//
// The label pastes their own contract text once — or generates a starting one
// — and then APPROVES it. When a deal closes, the app fills in that creator's
// details and sends the finished contract with the agreement-confirmation
// email. The app never writes or rewrites legal language; it only substitutes
// the {{...}} slots.
//
// Saving and approving are deliberately two different actions. Saving stores
// wording; approving is the statement "a human read this exact text and it may
// go to a creator". Approval lives in the database and every save revokes it,
// so an edit can never inherit an earlier approval.
//
// This is the most consequential control in the product — it authorizes legal
// text to be sent to a third party — so every refusal here has to say what to
// do next in words, and no failure may reach the user as a raw status code or
// a database message.

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SettingsSection } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  detectPlaceholders,
  looksLikeDraftHeader,
  KNOWN_PLACEHOLDERS,
  DEAL_FILLABLE_PLACEHOLDERS,
} from "@/lib/contracts";
// TYPE ONLY. src/lib/contract-import.ts pulls in the .docx and .pdf parsers;
// a value import here would ship both into the browser bundle of a settings
// page. The three constants below are therefore copied rather than imported,
// and tests/contract-import.test.ts asserts they still match their source.
import type { BlankSuggestion } from "@/lib/contract-import";

/** Mirrors ACCEPT_ATTRIBUTE / ACCEPTED_DESCRIPTION / MAX_IMPORT_BYTES. */
const IMPORT_ACCEPT = ".docx,.pdf,.txt,.md,.markdown";
const IMPORT_ACCEPTED_DESCRIPTION = "Word (.docx), PDF (.pdf), or plain text (.txt, .md)";
const IMPORT_MAX_MB = 2;

interface ContractTemplate {
  id: string;
  name: string;
  body_text: string;
  placeholders_detected: string[] | null;
  updated_at: string;
}

interface TemplateDiff {
  removedSections: string[];
  addedSections: string[];
  removedPlaceholders: string[];
  addedPlaceholders: string[];
}

/** Label-friendly meaning of each slot the app can fill. */
const PLACEHOLDER_LEGEND: Record<string, string> = {
  creator_name: "the creator's name",
  creator_handle: "their @handle",
  amount_usd: "the agreed payment",
  deliverables: "what they're posting",
  schedule: "when it goes live",
  payment_method: "how they get paid",
  artist_name: "your artist",
  campaign_name: "the song / campaign",
  date: "today's date",
  firm_name: "your label's name",
  governing_law: "your jurisdiction (write it out yourself)",
};

interface ApiFailure {
  error?: string;
  code?: string;
  field?: string;
}

/** A response body, or {} when the server sent something that isn't JSON. */
async function readPayload(r: Response): Promise<ApiFailure> {
  try {
    return (await r.json()) as ApiFailure;
  } catch {
    return {};
  }
}

/**
 * Turn an API failure into a sentence someone can act on.
 *
 * Server text is passed through ONLY when the route wrote it for a human. A
 * bare status, a machine code and a database error string all resolve to real
 * copy instead — four paths here used to print things like "Could not save:
 * 500" or a Postgres column name.
 */
function failureMessage(status: number, payload: ApiFailure): string {
  switch (payload.code ?? payload.error) {
    case "empty_template":
      return "The contract is empty. Paste your contract text first.";
    case "template_too_large":
      return "That's too long. Keep the contract under 50,000 characters.";
    case "not_plain_text":
      return "That text carries characters we can't store. Paste it as plain text and try again.";
  }
  if (status >= 500) {
    return "Something went wrong on our side and nothing changed. Try again in a moment.";
  }
  // Routes that refuse for a reason write full sentences; codes never contain
  // a space, so this passes the former through and never the latter.
  if (typeof payload.error === "string" && /\s/.test(payload.error)) {
    return payload.error;
  }
  if (status === 401 || status === 403) {
    return "You're signed out. Sign in again, then try once more.";
  }
  if (status === 404) {
    return "There's no saved contract yet. Save one first.";
  }
  if (status === 409) {
    return "The saved contract changed since you opened this page. Reload, read the wording again, then approve.";
  }
  if (status === 429) {
    return "Too many tries in a row. Wait a minute, then try again.";
  }
  return "That didn't go through, and nothing changed. Try again in a moment.";
}

/**
 * Remove the generated "DRAFT — requires legal review" line, or null when
 * there is no single line to remove.
 *
 * Deliberately a button and not an automatic strip: the approve route refuses
 * while that line is present, and the removal is the reviewer's statement that
 * legal review happened. Doing it silently would turn a machine-written draft
 * into an approvable document with nobody having read it.
 */
function stripDraftHeader(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let seen = 0;
  for (let i = 0; i < lines.length && seen < 3; i++) {
    if (lines[i].trim().length === 0) continue;
    seen++;
    const normalized = lines[i]
      .replace(/[‐-―−]/g, "-")
      .replace(/\s+/g, " ")
      .toLowerCase();
    if (normalized.includes("draft") && normalized.includes("requires legal review")) {
      const rest = [...lines.slice(0, i), ...lines.slice(i + 1)];
      while (rest.length > 0 && rest[0].trim().length === 0) rest.shift();
      return rest.join("\n");
    }
  }
  return null;
}

export function ContractTemplateCard() {
  const [body, setBody] = useState("");
  const [savedBody, setSavedBody] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  // Approval state, from the server. `null` = never approved = nothing sends.
  const [approvedAt, setApprovedAt] = useState<string | null>(null);
  const [approvalReadable, setApprovalReadable] = useState(true);
  const [approving, setApproving] = useState(false);
  const [confirmingApproval, setConfirmingApproval] = useState(false);

  // "Generate a starting template" (labels with no contract of their own).
  const [genFirmName, setGenFirmName] = useState("");
  const [genGoverningLaw, setGenGoverningLaw] = useState("");
  const [genClauses, setGenClauses] = useState("");
  const [generating, setGenerating] = useState(false);
  const [diff, setDiff] = useState<TemplateDiff | null>(null);

  // "Import the contract you already have."
  //
  // `importedText` is the pristine text the server returned, kept alongside
  // the editor copy because every suggestion's offsets are into THAT string.
  // Inserting a marker changes the editor's length, so applying the next one
  // needs the running shift — and if the user has hand-edited in between, the
  // span no longer matches and we refuse to place it rather than splicing
  // {{creator_name}} into the middle of a sentence.
  const [importing, setImporting] = useState(false);
  const [importedText, setImportedText] = useState<string | null>(null);
  const [importedName, setImportedName] = useState("");
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<BlankSuggestion[]>([]);
  const [appliedSuggestions, setAppliedSuggestions] = useState<number[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/firm/contract-template")
      .then(async (r) => {
        if (!r.ok) throw new Error(`load failed (${r.status})`);
        return r.json() as Promise<{
          template: ContractTemplate | null;
          approved_at?: string | null;
          approval_readable?: boolean;
        }>;
      })
      .then((d) => {
        const text = d.template?.body_text ?? "";
        setBody(text);
        setSavedBody(text);
        setApprovedAt(d.approved_at ?? null);
        setApprovalReadable(d.approval_readable !== false);
      })
      .catch(() => {
        // Non-fatal: the card still renders; saving will surface real errors.
      })
      .finally(() => setLoaded(true));
  }, []);

  const detected = useMemo(() => detectPlaceholders(body), [body]);
  const known = useMemo(() => new Set<string>(KNOWN_PLACEHOLDERS), []);
  const dealFillable = useMemo(() => new Set<string>(DEAL_FILLABLE_PLACEHOLDERS), []);
  const unknownDetected = detected.filter((p) => !known.has(p));
  // Recognized, so approval accepts it — but nothing supplies a value for it
  // when a deal closes, so a template that keeps it can never send. Catch it
  // here rather than handing over a success toast and a silent failure later.
  const unfillable = detected.filter((p) => known.has(p) && !dealFillable.has(p));
  const dirty = body !== savedBody;
  const readsAsDraft = looksLikeDraftHeader(body);
  const canApprove =
    loaded &&
    !dirty &&
    savedBody.length > 0 &&
    !approvedAt &&
    !readsAsDraft &&
    unknownDetected.length === 0 &&
    unfillable.length === 0;

  const slots = (names: string[]) => names.map((p) => `{{${p}}}`).join(", ");

  function clearImport() {
    setImportedText(null);
    setImportedName("");
    setImportWarnings([]);
    setSuggestions([]);
    setAppliedSuggestions([]);
  }

  /**
   * Read a contract file into the editor.
   *
   * The server stores nothing — this is the same posture as the generator: a
   * draft lands in the textarea and the existing Save → Approve path is still
   * the only way anything reaches a creator. Failure never blanks the editor,
   * because whatever is in there may be the only copy of wording the label
   * just typed.
   */
  async function importContract(file: File) {
    if (
      dirty &&
      !window.confirm("Replace the unsaved text in the editor with the contract from this file?")
    ) {
      return;
    }
    setImporting(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch("/api/firm/contract-template/import", {
        method: "POST",
        body: form,
      });
      const d = await readPayload(r);
      if (!r.ok) {
        toast.error(failureMessage(r.status, d));
        return;
      }
      const imported = d as ApiFailure & {
        text?: string;
        warnings?: string[];
        suggestions?: BlankSuggestion[];
        filename?: string;
      };
      const warnings = Array.isArray(imported.warnings) ? imported.warnings : [];
      if (typeof imported.text !== "string" || imported.text.length === 0) {
        // A scan, or an empty document. The warnings explain which, and they
        // are worth more than the toast, so they still get rendered.
        clearImport();
        setImportWarnings(warnings);
        setImportedName(file.name);
        toast.error("No text could be read out of that file. Nothing in the editor changed.");
        return;
      }
      setBody(imported.text);
      setImportedText(imported.text);
      setImportedName(imported.filename || file.name);
      setImportWarnings(warnings);
      setSuggestions(Array.isArray(imported.suggestions) ? imported.suggestions : []);
      setAppliedSuggestions([]);
      setDiff(null);
      toast.info(
        "Your contract is in the editor, exactly as written. Nothing is saved yet. Mark the blanks below, then save and approve.",
      );
    } catch (e) {
      console.error("[contract-template] import threw", e);
      toast.error("We couldn't reach the server. Check your connection and try again.");
    } finally {
      setImporting(false);
    }
  }

  /**
   * Put one {{slot}} where the import suggested it.
   *
   * Nothing is substituted automatically — this runs only on a click, one
   * blank at a time, and the guard below refuses rather than guessing if the
   * text has moved underneath it. These are someone's operative terms.
   */
  function applySuggestion(index: number) {
    const s = suggestions[index];
    if (!s || !importedText || appliedSuggestions.includes(index)) return;
    const marker = `{{${s.placeholder}}}`;
    // Every earlier marker already placed moved everything after it.
    let shift = 0;
    for (const i of appliedSuggestions) {
      const prev = suggestions[i];
      if (prev && prev.start < s.start) shift += `{{${prev.placeholder}}}`.length - (prev.end - prev.start);
    }
    const start = s.start + shift;
    const end = s.end + shift;
    if (body.slice(start, end) !== importedText.slice(s.start, s.end)) {
      toast.error(
        "That part of the text has been edited since the import, so we won't place the marker for you. Type it in where it belongs.",
      );
      return;
    }
    setBody(body.slice(0, start) + marker + body.slice(end));
    setAppliedSuggestions([...appliedSuggestions, index]);
  }

  async function generateTemplate() {
    if (!genGoverningLaw.trim()) {
      toast.error(
        "Governing law is required. Without it the template can never send, because there is no per-deal value to fill in.",
      );
      return;
    }
    if (dirty && !window.confirm("Replace the unsaved text in the editor with a new draft?")) {
      return;
    }
    setGenerating(true);
    try {
      const r = await fetch("/api/firm/contract-template/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(genFirmName.trim() ? { firm_name: genFirmName.trim() } : {}),
          governing_law: genGoverningLaw.trim(),
          ...(genClauses.trim() ? { extra_clauses: genClauses.trim() } : {}),
        }),
      });
      const d = await readPayload(r);
      if (!r.ok) {
        toast.error(failureMessage(r.status, d));
        return;
      }
      const generated = d as ApiFailure & { body_text?: string; diff?: TemplateDiff; warnings?: unknown };
      if (typeof generated.body_text !== "string" || generated.body_text.length === 0) {
        // Never blank the editor on a malformed answer — that text may be the
        // label's only copy of wording they just typed.
        toast.error("The draft came back empty. Nothing in the editor changed. Try again.");
        return;
      }
      setBody(generated.body_text);
      setDiff(generated.diff ?? null);
      // The generated body is a different document; imported offsets no longer
      // point at anything.
      clearImport();
      if (Array.isArray(generated.warnings) && generated.warnings.length > 0) {
        toast.warning(
          "Draft ready, but your extra clauses were appended word-for-word at the end instead of being worked into the sections. Rewrite them before approving.",
        );
      } else {
        toast.info(
          "Draft in the editor. Nothing sends from it: have it legally reviewed, remove the draft line, save, then approve.",
        );
      }
    } catch (e) {
      console.error("[contract-template] generate threw", e);
      toast.error("We couldn't reach the server. Check your connection and try again.");
    } finally {
      setGenerating(false);
    }
  }

  function removeDraftLine() {
    if (
      !window.confirm(
        "Remove the draft marker?\n\n" +
          "Do this only once someone has actually read the wording. Removing the line is your statement that the review happened. It does not approve anything. You still save, then approve, below.",
      )
    ) {
      return;
    }
    const next = stripDraftHeader(body);
    if (next === null || looksLikeDraftHeader(next)) {
      toast.error(
        "We couldn't find a single draft line to take out. Delete the draft wording at the top of the text yourself, then save.",
      );
      return;
    }
    setBody(next);
    toast.info("Draft line removed from the editor. Save it, then approve below.");
  }

  async function saveTemplate() {
    setSaving(true);
    try {
      const r = await fetch("/api/firm/contract-template", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body_text: body }),
      });
      const d = await readPayload(r);
      if (!r.ok) {
        toast.error(failureMessage(r.status, d));
        return;
      }
      setSavedBody(body);
      // Every save revokes approval server-side; mirror that immediately so
      // the card never shows "approved" for text nobody has approved.
      setApprovedAt(null);
      setConfirmingApproval(false);
      const unknown: string[] = (d as ApiFailure & { unknown_placeholders?: string[] })
        .unknown_placeholders ?? [];
      const blockers = [...unknown, ...unfillable];
      if (blockers.length > 0) {
        toast.warning(
          `Saved, but no contract can go out while ${slots(blockers)} ${
            blockers.length === 1 ? "is" : "are"
          } in the text, and we have no value to put there. Replace with your own wording.`,
        );
      } else {
        toast.success("Saved. Nothing sends yet. Approve it below when the wording is final.");
      }
    } catch (e) {
      console.error("[contract-template] save threw", e);
      toast.error("We couldn't reach the server. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function approveTemplate() {
    setApproving(true);
    try {
      const r = await fetch("/api/firm/contract-template/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body_text: savedBody }),
      });
      const d = await readPayload(r);
      if (!r.ok) {
        toast.error(failureMessage(r.status, d));
        return;
      }
      setApprovedAt((d as ApiFailure & { approved_at?: string }).approved_at ?? new Date().toISOString());
      setConfirmingApproval(false);
      toast.success("Approved. Closed deals from now on will include this contract.");
    } catch (e) {
      console.error("[contract-template] approve threw", e);
      toast.error("We couldn't reach the server. Check your connection and try again.");
    } finally {
      setApproving(false);
    }
  }

  async function revokeApproval() {
    setApproving(true);
    try {
      const r = await fetch("/api/firm/contract-template/approve", { method: "DELETE" });
      const d = await readPayload(r);
      if (!r.ok) {
        toast.error(failureMessage(r.status, d));
        return;
      }
      setApprovedAt(null);
      toast.info("Approval withdrawn. No contract will be sent until you approve again.");
    } catch (e) {
      console.error("[contract-template] revoke threw", e);
      toast.error("We couldn't reach the server. Check your connection and try again.");
    } finally {
      setApproving(false);
    }
  }

  return (
    <SettingsSection
      title="Deal contract"
      description={
        <>
          Paste your contract once, then approve it. We fill in each
          creator&apos;s details when a deal closes and send the finished copy
          with the deal-confirmation email. We never change your wording, only
          the blanks.
        </>
      }
    >
      <div className="space-y-4">
        <Link
          href="/settings/contract/builder"
          className={buttonVariants({ variant: "outline", size: "sm", className: "w-fit" })}
        >
          No contract yet? Build one step by step
        </Link>
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Put these anywhere in your text and we&apos;ll fill them in per deal:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {KNOWN_PLACEHOLDERS.map((p) => (
              <Badge key={p} variant="outline">
                <span className="font-mono">{`{{${p}}}`}</span>
                <span className="text-muted-foreground">
                  · {PLACEHOLDER_LEGEND[p]}
                </span>
              </Badge>
            ))}
          </div>
        </div>

        <Textarea
          rows={12}
          value={body}
          disabled={!loaded}
          onChange={(e) => setBody(e.target.value)}
          placeholder={
            "e.g.\nThis agreement is between {{artist_name}}'s team and {{creator_name}} ({{creator_handle}}).\n{{creator_name}} will post {{deliverables}} for {{campaign_name}}, {{schedule}}.\nPayment of {{amount_usd}} will be made by {{payment_method}}.\nDated {{date}}."
          }
          className="font-mono text-xs"
        />

        {detected.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Found in your contract:</p>
            <div className="flex flex-wrap gap-1.5">
              {detected.map((p) =>
                !known.has(p) ? (
                  <Badge key={p} variant="destructive">
                    <span className="font-mono">{`{{${p}}}`}</span>
                    <span>· blocks sending</span>
                  </Badge>
                ) : dealFillable.has(p) ? (
                  <Badge key={p} variant="secondary">
                    <span className="font-mono">{`{{${p}}}`}</span>
                  </Badge>
                ) : (
                  <Badge
                    key={p}
                    variant="outline"
                    className="border-attention-border text-attention-fg"
                  >
                    <span className="font-mono">{`{{${p}}}`}</span>
                    <span>· blocks sending</span>
                  </Badge>
                ),
              )}
            </div>
          </div>
        )}

        {readsAsDraft && (
          <div className="space-y-2 rounded-md border border-attention-border bg-attention p-3">
            <p className="text-xs">
              This text still carries the line marking it as a machine-written
              draft, and it can&apos;t be approved while that line is there. Have
              the wording reviewed, then take the line out. That removal is how
              you state the review happened.
            </p>
            <Button size="sm" variant="outline" onClick={removeDraftLine} disabled={!loaded}>
              Reviewed: remove the draft line
            </Button>
          </div>
        )}

        {diff &&
          (diff.removedSections.length > 0 ||
            diff.addedSections.length > 0 ||
            diff.removedPlaceholders.length > 0) && (
            <div className="space-y-1 rounded-md border border-attention-border bg-attention p-2 text-xs">
              <p className="font-medium">
                What the customization changed. Check these before approving:
              </p>
              {diff.removedSections.length > 0 && (
                <p>Sections removed or renamed: {diff.removedSections.join(", ")}</p>
              )}
              {diff.addedSections.length > 0 && (
                <p>Sections added: {diff.addedSections.join(", ")}</p>
              )}
              {diff.removedPlaceholders.length > 0 && (
                <p>Slots no longer filled per deal: {slots(diff.removedPlaceholders)}</p>
              )}
            </div>
          )}

        <div className="flex items-center gap-3">
          <Button
            variant={dirty ? "default" : "outline"}
            onClick={saveTemplate}
            disabled={!loaded || saving || !dirty}
          >
            {saving ? "Saving…" : "Save contract"}
          </Button>
          {!dirty && loaded && savedBody && (
            <p className="text-xs text-muted-foreground">Saved.</p>
          )}
        </div>

        {/* Approval: the only thing that lets a contract reach a creator. */}
        <div className="space-y-2 rounded-md border p-3">
          {!approvalReadable && (
            <p className="text-xs text-destructive">
              We can&apos;t read the approval state right now, so nothing will be
              sent. Get in touch if this doesn&apos;t clear on a refresh.
            </p>
          )}
          {approvedAt ? (
            <>
              <p className="text-sm font-medium">
                Approved for sending
                <span className="ml-2 font-normal text-muted-foreground">
                  {new Date(approvedAt).toLocaleString()}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                Closed deals include this contract. Editing the text withdraws
                this approval automatically.
              </p>
              <Button variant="outline" onClick={revokeApproval} disabled={approving}>
                {approving ? "Working…" : "Withdraw approval"}
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">Not approved. Nothing is being sent</p>
              <p className="text-xs text-muted-foreground">
                {dirty
                  ? "Save your changes first, then approve."
                  : savedBody.length === 0
                    ? "Save a contract first."
                    : readsAsDraft
                      ? "Take out the draft line after the wording has been reviewed, save, then approve."
                      : unknownDetected.length > 0
                        ? `We can't fill ${slots(unknownDetected)}, so no contract would ever go out. Replace those with your own fixed wording, save, then approve.`
                        : unfillable.length > 0
                          ? `${slots(unfillable)} is never filled in per deal. Write your jurisdiction out in the text itself, save, then approve.`
                          : "Approving states that a person has read this exact text and it may be sent to creators."}
              </p>
              {confirmingApproval ? (
                <div className="flex items-center gap-2">
                  <Button onClick={approveTemplate} disabled={approving || !canApprove}>
                    {approving ? "Approving…" : "Yes, approve this text"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setConfirmingApproval(false)}
                    disabled={approving}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  variant={dirty ? "outline" : "default"}
                  onClick={() => setConfirmingApproval(true)}
                  disabled={!canApprove}
                >
                  Approve for sending
                </Button>
              )}
            </>
          )}
        </div>

        {/* Import: for labels who already have a contract and would otherwise
            be retyping it. It only ever fills the editor above — the server
            stores nothing, so an import that turns out to be the wrong file
            costs a click, not a cleanup. */}
        <div className="space-y-3 border-t pt-4">
          <p className="text-sm font-medium">Already have a contract? Import it.</p>
          <p className="text-xs text-muted-foreground">
            We read the words out of a Word, PDF or text file into the editor
            above. Creator Campaigns does not read, interpret or change your terms, and
            uploading stores nothing. Close this page without saving and
            nothing has happened.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept={IMPORT_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Clear it, or picking the same file twice fires no event.
              e.target.value = "";
              if (file) void importContract(file);
            }}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={!loaded || importing}
            >
              {importing ? "Reading…" : "Choose a contract file"}
            </Button>
            <p className="text-xs text-muted-foreground">
              {IMPORT_ACCEPTED_DESCRIPTION} · up to {IMPORT_MAX_MB}MB
            </p>
          </div>

          {importedName && (
            <p className="text-xs text-muted-foreground">
              Read from <span className="font-medium">{importedName}</span>.
              Nothing has been saved.
            </p>
          )}

          {importWarnings.length > 0 && (
            <ul className="list-disc space-y-1 rounded-md border border-attention-border bg-attention p-3 pl-6 text-xs">
              {importWarnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          {suggestions.length > 0 && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-xs">
                We spotted {suggestions.length} blank
                {suggestions.length === 1 ? "" : "s"} that look like per-deal
                details. <span className="font-medium">None of them have been
                filled in.</span> Click one to drop that marker into the text.
                Read the wording around it first, because this is a guess from
                the words next to the blank, not an understanding of your
                contract.
              </p>
              <div className="space-y-1">
                {suggestions.map((s, i) => {
                  const done = appliedSuggestions.includes(i);
                  return (
                    <button
                      key={`${s.start}-${s.placeholder}`}
                      type="button"
                      onClick={() => applySuggestion(i)}
                      disabled={done}
                      className="flex w-full items-start gap-2 rounded-md border p-2 text-left text-xs hover:bg-muted disabled:opacity-60 disabled:hover:bg-transparent"
                    >
                      <Badge variant={done ? "secondary" : "outline"} className="shrink-0">
                        <span className="font-mono">{`{{${s.placeholder}}}`}</span>
                      </Badge>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono">{s.excerpt}</span>
                        <span className="block text-muted-foreground">{s.reason}</span>
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {done ? "Inserted" : "Insert"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Generator last: it is the path for labels who have no contract yet,
            not the main event. One separated section, not a box inside a box. */}
        <div className="space-y-3 border-t pt-4">
          <p className="text-sm font-medium">No contract of your own? Generate a starting point.</p>
          <p className="text-xs text-muted-foreground">
            A music-promotion creator licensing agreement (deliverables, track
            license, content rights, payment and timing, FTC disclosure,
            termination, governing law, acceptance). It lands in the editor above
            as a draft for your lawyer to review. Nothing sends from it until you
            approve it.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ct-firm-name" className="text-xs">
                Your label&apos;s name
              </Label>
              <Input
                id="ct-firm-name"
                value={genFirmName}
                onChange={(e) => setGenFirmName(e.target.value)}
                placeholder="As it should appear in the contract"
                disabled={generating}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ct-governing-law" className="text-xs">
                Governing law <span className="text-destructive">(required)</span>
              </Label>
              <Input
                id="ct-governing-law"
                value={genGoverningLaw}
                onChange={(e) => setGenGoverningLaw(e.target.value)}
                placeholder="e.g. the State of Delaware"
                disabled={generating}
                required
                aria-required
              />
            </div>
          </div>
          <Textarea
            rows={3}
            value={genClauses}
            onChange={(e) => setGenClauses(e.target.value)}
            placeholder="Optional: extra clauses in your own words (e.g. creator can't work with competing labels for 30 days; content must stay up 6 months)"
            disabled={generating}
            className="text-xs"
          />
          <Button
            variant="outline"
            onClick={generateTemplate}
            disabled={!loaded || generating || !genGoverningLaw.trim()}
          >
            {generating ? "Generating…" : "Generate a starting template"}
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}
