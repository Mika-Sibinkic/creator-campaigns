'use client';
// src/app/audit/page.tsx
//
// N8: the activity history. GET /api/audit is firm-scoped to the caller.
//
// This page was a database table viewer
// pointed at a record label: raw dotted actions in monospace
// (`system.cron.negotiation_tick`, `firm.testing_mode.toggle`), raw
// `target_type` enums, `JSON.stringify(metadata)` in a <pre>, a truncated
// UUID with click-to-copy-the-full-UUID, and `user:<email>` in the actor
// column. Most recent rows were cron heartbeats and the
// table held literal test artifacts (`smoke.test`, `verify-008.test`).
//
// So there are two views now:
//   - OPERATOR: the raw table, unchanged. It is genuinely how we debug.
//   - EVERYONE ELSE: one readable sentence per event — who, what, when — with
//     the machine rows dropped rather than translated. An action we have not
//     written copy for is NOT shown as its slug; a slug on a client screen was
//     the bug.
//
// Copy rules honored here: no raw enums, no UUIDs, no table or column names,
// no email addresses (an actor is "You", "A teammate" or "Creator Campaigns").

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { useIsOperator, useMe } from '@/components/OperatorContext';
import { EmptyState } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface AuditRow {
  id: string;
  occurred_at: string;
  actor_user_id: string | null;
  actor_label: string;
  firm_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
  request_ip: string | null;
  user_agent: string | null;
}

const DEFAULT_LIMIT = 100;
// The readable view drops every machine row, so it has to read further back to
// fill a screen. Still inside the route's MAX_LIMIT of 500.
const READABLE_LIMIT = 200;

/** Never put a driver/Postgres message on screen — /api/audit returns the raw
 *  error.message. The detail goes to the console for devtools triage. */
const LOAD_ERROR =
  'Could not load the activity history. Try again in a moment.';

/** occurred_at is typed as a string, but a null or malformed value throws
 *  RangeError out of toISOString() and takes the whole table down. */
function formatWhen(iso: string | null): string {
  if (!iso) return 'Unknown time';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unknown time';
  return d.toLocaleString();
}

/** Placeholder for an empty cell: the word, quietly, never a bare glyph. */
function EmptyCell() {
  return <span className="text-xs text-faint">None</span>;
}

// ── Readable view ────────────────────────────────────────────────────────────

function usd(v: unknown): string | null {
  return typeof v === 'number' && Number.isFinite(v)
    ? `$${v.toFixed(2)}`
    : null;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/** firms column names are not copy. Only the settings a label recognises get
 *  named; anything else stays generic rather than leaking a column. */
const FIRM_FIELD_COPY: Record<string, string> = {
  monthly_spend_cap_usd: 'monthly spending cap',
  creator_monthly_cap_usd: 'per-creator monthly cap',
  autonomy_mode: 'how much Creator Campaigns does on its own',
  quiet_hours_start: 'quiet hours',
  quiet_hours_end: 'quiet hours',
  from_email: 'sending address',
  reply_to_email: 'reply-to address',
};

/**
 * One audit row → one sentence, or null when the row is not the label's
 * business (cron heartbeats, test artifacts, scraper internals, the reply
 * simulator, testing-mode switches, safety-classifier flags).
 *
 * Deliberately a whitelist. A new action shows up as nothing rather than as
 * `pipeline.bot_prefilter` — a silent omission is recoverable, a slug on a
 * client screen is the thing we are fixing.
 */
function describeAuditEvent(
  action: string,
  metadata: Record<string, unknown> | null,
): string | null {
  const md = metadata ?? {};
  switch (action) {
    // ── Campaigns ──────────────────────────────────────────────────────────
    case 'campaign.create':
    case 'campaign.created': {
      const artist = text(md.artist_name);
      return artist ? `Started a campaign for ${artist}` : 'Started a campaign';
    }
    case 'campaign.cloned': {
      const artist = text(md.artist_name);
      return artist ? `Copied a campaign to ${artist}` : 'Copied a campaign';
    }
    case 'campaign.confirmed':
      return 'Confirmed a campaign’s budget and limits';
    case 'campaign.deal_scope_set':
      return 'Set what creators have to deliver on a campaign';
    case 'campaign.material_uploaded':
      return 'Added promo material to a campaign';

    // ── Outreach ───────────────────────────────────────────────────────────
    case 'outreach.draft':
    case 'outreach.draft.create':
    case 'outreach.draft_created':
    case 'outreach.initial_draft':
    case 'outreach.generated':
      return 'Drafted a message to a creator';
    case 'outreach.draft.refused':
      return 'Declined to draft a message to a creator';
    case 'outreach.send':
    case 'outreach.sent':
      return 'Sent a message to a creator';
    case 'outreach.send.failed':
    case 'outreach.failed':
      return 'A message to a creator could not be sent';
    case 'outreach.response_logged':
      return 'Logged a creator’s reply';
    case 'outreach.escalated':
    case 'outreach.escalation_blocked':
      return 'Held a creator’s reply for a person to answer';
    case 'draft.timeout':
      return 'Message drafting stopped before it finished';

    // ── Negotiation ────────────────────────────────────────────────────────
    case 'negotiation.offer_sent': {
      const amt = usd(md.amount_usd);
      return amt ? `Sent an opening offer of ${amt}` : 'Sent an opening offer';
    }
    case 'negotiation.auto_counter_sent': {
      const amt = usd(md.counter_sent_usd);
      return amt ? `Countered a creator at ${amt}` : 'Countered a creator';
    }
    case 'negotiation.auto_rejected':
      return 'Turned down a creator’s asking price';
    case 'negotiation.agreed':
    case 'offer.agreed': {
      const amt = usd(md.agreed_amount_usd);
      return amt ? `Agreed a deal at ${amt}` : 'Agreed a deal';
    }
    case 'offer.quick_agreed': {
      const amt = usd(md.agreed_amount_usd);
      return amt ? `Locked in a deal at ${amt}` : 'Locked in a deal';
    }
    case 'negotiation.pending_human_approval':
      return 'Held a deal for your approval';
    case 'negotiation.question_unanswered':
      return 'A creator asked something that needs your answer';
    case 'negotiation.out_of_spec_flagged':
      return 'A creator proposed work outside the campaign’s scope';
    case 'negotiation.terms_discarded':
      return 'Ignored terms a creator proposed that the campaign doesn’t cover';
    case 'negotiation.budget_unverifiable':
      return 'Stopped a negotiation because the campaign budget could not be read';
    case 'offer.cancelled':
      return 'Cancelled a deal';
    case 'offer.posted':
      return 'Logged a creator’s post';

    // ── Money ──────────────────────────────────────────────────────────────
    case 'payment.authorization_created': {
      const amt = usd(md.amount_usd);
      return amt
        ? `Queued a ${amt} payment for approval`
        : 'Queued a payment for approval';
    }
    case 'payment.approved': {
      const amt = usd(md.amount_usd);
      return amt ? `Approved a payment of ${amt}` : 'Approved a payment';
    }
    case 'payment.rejected':
      return 'Rejected a payment. No money moved';
    case 'payment.executed':
    case 'negotiation.auto_paid':
      return `Paid a creator${usd(md.amount_usd) ? ` ${usd(md.amount_usd)}` : ''}`;
    case 'deal.paid': {
      const amt = usd(md.amount_total_usd);
      return amt ? `A creator was paid ${amt}` : 'A creator was paid';
    }
    case 'payment.failed':
    case 'negotiation.auto_payout_failed': {
      const amt = usd(md.amount_usd);
      return amt
        ? `A payment of ${amt} did not go through. No money moved`
        : 'A payment did not go through. No money moved';
    }
    case 'payment.approved_payout_failed':
      return 'A payment was approved but did not go out. No money moved';
    case 'negotiation.payment_auth_automint_failed':
      return 'A payment could not be set up automatically';
    case 'payment.blocked_over_budget':
      return 'A payment was stopped by the campaign budget. No money moved';
    case 'payment.blocked_over_creator_monthly_cap':
      return 'A payment was stopped by the per-creator monthly cap. No money moved';
    case 'payment.blocked_over_firm_monthly_cap':
    case 'payment.webhook_cap_refused':
      return 'A payment was stopped by your monthly spending cap. No money moved';
    case 'payment.onboarding_link_sent':
      return 'Sent a creator their payout setup link';
    case 'payment.onboarding_link_opened':
      return 'A creator opened their payout setup link';
    case 'payment.payout_unclaimed':
      return 'A creator has not claimed their payout yet';

    // ── Delivery + results ─────────────────────────────────────────────────
    case 'delivery.verified':
      return 'Confirmed a creator’s post is live';
    case 'delivery.missing':
      return 'A creator’s post could not be found';
    case 'outcome.recorded':
    case 'offer.measured':
      return 'Recorded what a creator’s post delivered';

    // ── Contracts + workspace ──────────────────────────────────────────────
    case 'contract.not_attached':
      return 'A deal closed without a contract attached';
    case 'firm.contract_template.draft_generated':
      return 'Drafted a contract template';
    case 'firm.contract_template.updated':
      return 'Updated the contract template';
    case 'firm.contract_template.approved':
      return 'Approved the contract template for use';
    case 'firm.contract_template.approval_revoked':
      return 'Withdrew approval of the contract template';
    case 'firm.update': {
      const fields = Array.isArray(md.fields) ? md.fields : [];
      const named = fields
        .map((f) => (typeof f === 'string' ? FIRM_FIELD_COPY[f] : null))
        .filter((f): f is string => f != null);
      const unique = [...new Set(named)];
      return unique.length > 0
        ? `Changed the ${unique.join(' and ')}`
        : 'Changed a workspace setting';
    }
    case 'firm_member.update':
      return 'Changed who can use this workspace';
    case 'influencer.contact_email.update':
      return 'Updated a creator’s contact email';
    case 'influencer.blocklist.update':
      return 'Changed whether a creator can be contacted';

    default:
      return null;
  }
}

/**
 * Who did it, without ever printing an address. `actor_label` is
 * `user:<email>` / `system:<worker>` / a bare worker name, and one of those
 * emails is usually the operator's.
 */
function describeActor(
  actorLabel: string | null | undefined,
  myEmail: string | null,
): string {
  const raw = (actorLabel ?? '').trim();
  if (!raw.startsWith('user:')) return 'Creator Campaigns';
  const email = raw.slice('user:'.length).trim().toLowerCase();
  if (!email) return 'Creator Campaigns';
  if (myEmail && email === myEmail.trim().toLowerCase()) return 'You';
  return 'A teammate';
}

/** The readable view's filter: one substring the route already understands,
 *  named in the label's words instead of ours. */
const SHOW_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Everything' },
  { value: 'campaign', label: 'Campaigns' },
  { value: 'outreach', label: 'Messages to creators' },
  { value: 'negotiation', label: 'Negotiations' },
  { value: 'payment', label: 'Payments' },
  { value: 'contract', label: 'Contracts' },
];

const FIELD_LABEL = 'mb-1 block text-xs text-muted-foreground';

export default function AuditPage() {
  const isOperator = useIsOperator();
  const me = useMe();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Filter bar state
  const [action, setAction] = useState('');
  const [targetType, setTargetType] = useState('');
  const [since, setSince] = useState('');
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);

  // Per-row UI state (operator table only)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (action.trim()) params.set('action', action.trim());
      if (isOperator && targetType.trim()) params.set('target_type', targetType.trim());
      if (since.trim()) params.set('since', since.trim());
      params.set('limit', String(isOperator ? limit : READABLE_LIMIT));
      const r = await fetch(`/api/audit?${params.toString()}`);
      const body = (await r.json().catch(() => ({}))) as {
        rows?: AuditRow[];
        error?: string;
      };
      if (!r.ok) {
        console.error('[audit] load failed', r.status, body.error);
        setErr(LOAD_ERROR);
        setRows([]);
        return;
      }
      setRows(body.rows ?? []);
    } catch (e) {
      console.error('[audit] load failed', e);
      setErr(LOAD_ERROR);
    } finally {
      setLoading(false);
    }
  }, [action, targetType, since, limit, isOperator]);

  // Initial load. Filter changes are explicit — user clicks Apply.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(id);
      setTimeout(() => setCopied((cur) => (cur === id ? null : cur)), 1200);
    } catch {
      /* clipboard blocked — fall through silently */
    }
  }

  const readable = rows
    .map((r) => ({ row: r, what: describeAuditEvent(r.action, r.metadata) }))
    .filter((e): e is { row: AuditRow; what: string } => e.what != null);

  const metaLine = loading
    ? undefined
    : isOperator
      ? // The first load can run before operator status resolves (at the
        // readable limit), so "max {limit}" would misstate what was fetched.
        `${rows.length} row${rows.length === 1 ? '' : 's'} shown`
      : `${readable.length} event${readable.length === 1 ? '' : 's'}, newest first. Routine background checks aren’t listed.`;

  const applyButton = (
    <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}>
      {loading ? 'Loading…' : 'Apply'}
    </Button>
  );

  return (
    <AppShell title="Activity" subtitle={metaLine} width="default">
      <div className="mx-auto w-full max-w-6xl space-y-4 px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        {/* Filter row: plain fields above the list they filter, no box. */}
        {isOperator ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="w-44">
              <span className={FIELD_LABEL}>Action contains</span>
              <Input className="h-8" value={action} onChange={(e) => setAction(e.target.value)} placeholder="e.g. payment" />
            </label>
            <label className="w-36">
              <span className={FIELD_LABEL}>Item type</span>
              <Input className="h-8" value={targetType} onChange={(e) => setTargetType(e.target.value)} placeholder="campaign" />
            </label>
            <label className="w-52">
              <span className={FIELD_LABEL}>Since</span>
              <Input type="datetime-local" className="h-8" value={since} onChange={(e) => setSince(e.target.value)} />
            </label>
            <label className="w-20">
              <span className={FIELD_LABEL}>Limit</span>
              <Input
                type="number"
                min={1}
                max={500}
                className="h-8 tabular-nums"
                value={limit}
                onChange={(e) => setLimit(Math.max(1, Math.min(500, parseInt(e.target.value) || DEFAULT_LIMIT)))}
              />
            </label>
            {applyButton}
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="w-56">
              <span className={FIELD_LABEL}>Show</span>
              <Select
                items={SHOW_OPTIONS.map((o) => ({ value: o.value || 'all', label: o.label }))}
                value={action || 'all'}
                onValueChange={(v) => setAction(!v || v === 'all' ? '' : String(v))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SHOW_OPTIONS.map((o) => (
                    <SelectItem key={o.value || 'all'} value={o.value || 'all'}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="w-52">
              <span className={FIELD_LABEL}>Since</span>
              <Input type="datetime-local" className="h-8" value={since} onChange={(e) => setSince(e.target.value)} />
            </label>
            {applyButton}
          </div>
        )}

        {err && <EmptyState title={<span className="text-destructive">{err}</span>} />}

        {loading && rows.length === 0 && !err ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : isOperator ? (
          rows.length === 0 && !err ? (
            <EmptyState title="No audit events match these filters" />
          ) : (
            <div className="max-h-[70vh] overflow-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
                  <tr className="border-b text-left">
                    <th className="h-9 px-3 font-medium">When</th>
                    <th className="h-9 px-3 font-medium">Actor</th>
                    <th className="h-9 px-3 font-medium">Action</th>
                    <th className="h-9 px-3 font-medium">Item type</th>
                    <th className="h-9 px-3 font-medium">Item reference</th>
                    <th className="h-9 px-3 font-medium">Metadata</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r) => {
                    const isOpen = !!expanded[r.id];
                    const targetIdShort = r.target_id ? `${r.target_id.slice(0, 8)}…` : '';
                    return (
                      <tr key={r.id} className="align-top transition-colors hover:bg-muted/40">
                        <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted-foreground">
                          {formatWhen(r.occurred_at)}
                        </td>
                        <td className="px-3 py-2">{r.actor_label}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.action}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {r.target_type ?? <EmptyCell />}
                        </td>
                        <td className="px-3 py-2">
                          {r.target_id ? (
                            <button
                              type="button"
                              onClick={() => void copyId(r.target_id!)}
                              title="Click to copy the full reference"
                              className="rounded border bg-background px-1.5 font-mono text-xs leading-5 transition-colors hover:bg-muted"
                            >
                              {copied === r.target_id ? 'Copied' : targetIdShort}
                            </button>
                          ) : (
                            <EmptyCell />
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {r.metadata && Object.keys(r.metadata).length > 0 ? (
                            <div>
                              <button
                                type="button"
                                onClick={() => setExpanded((cur) => ({ ...cur, [r.id]: !cur[r.id] }))}
                                className="text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                              >
                                {isOpen ? 'Hide' : 'Show'} ({Object.keys(r.metadata).length})
                              </button>
                              {isOpen && (
                                <pre className="mt-2 max-w-xl overflow-auto rounded border bg-muted p-2 font-mono text-[11px]">
                                  {JSON.stringify(r.metadata, null, 2)}
                                </pre>
                              )}
                            </div>
                          ) : (
                            <EmptyCell />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : readable.length === 0 && !err ? (
          <EmptyState title="Nothing to show for this period" />
        ) : (
          <ul className="divide-y rounded-lg border">
            {readable.map(({ row, what }) => (
              <li
                key={row.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5"
              >
                <span className="text-sm">
                  <span className="font-medium">
                    {describeActor(row.actor_label, me?.email ?? null)}
                  </span>{' '}
                  <span className="text-muted-foreground">{what}</span>
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatWhen(row.occurred_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
