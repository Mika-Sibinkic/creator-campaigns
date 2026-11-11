// src/lib/anomaly-resolve.ts
//
// "Resolve" on /anomalies.
//
// A held or flagged reply never left /anomalies: nothing could take an
// inbound row out of 'flagged', clear creator_offers.injection_flagged, or
// retire an escalation / fishy audit row. Now an operator can resolve one:
//
//   reviewed          the person dealt with it. A held reply is moved to
//                     'processed' (with who/when/how merged into its
//                     classification jsonb: inbound_messages.status has a CHECK
//                     with no 'reviewed' value); an injection flag is cleared;
//                     an escalation / fishy row is retired. Never sends or
//                     negotiates anything.
//   process_normally  a held reply goes back to the negotiation queue
//                     ('classified') so the next tick negotiates it. RESPECTS
//                     MANUAL MODE: refused while a human has the thread
//                     (negotiation-takeover.ts), because the negotiator would
//                     only hold it again; resume automation first.
//
// Every resolution writes one 'anomaly.resolved' audit row. That row is also
// how an audit-backed anomaly (escalation-*, fishy-*) is retired: the
// /anomalies route reads them back and detectAnomalies drops the refs and the
// replies they name.
//
// Scope: the anomaly must be the caller's firm's. The operator-only lanes
// (flagged replies, injection, fishy) can only be resolved by an operator; a
// label resolves its own needs-decision rows.

import type { SupabaseClient } from '@supabase/supabase-js';
import { audit } from './audit';
import { firmIdForCampaignInfluencer } from './channel-priors';
import { readThreadHold, markInboundReviewed } from './negotiation-takeover';
import { isHumanTakeover } from './takeover-state';
import { ANOMALY_RESOLVED_ACTION, ESCALATION_AUDIT_ACTIONS, FISHY_AUDIT_ACTIONS } from './statuses';
import { INBOUND_CLAIM_COLUMN } from './inbound-claim';
import { isMissingColumnError } from './holding-note';

export type ResolveAction = 'reviewed' | 'process_normally';

export interface ResolveInput {
  ref: string;
  action: ResolveAction;
  firmId: string;
  isOperator: boolean;
  actorLabel: string;
  nowMs?: number;
  request?: Request;
}

export interface ResolveResult {
  status: number;
  body: Record<string, unknown>;
}

const NOT_FOUND: ResolveResult = { status: 404, body: { error: 'not_found' } };
const OPERATOR_ONLY: ResolveResult = {
  status: 403,
  body: { error: 'operator_only', message: 'Only a platform operator can resolve this item.' },
};

type InboundRow = {
  id: string;
  status: string;
  campaign_influencer_id: string | null;
  creator_offer_id: string | null;
  classification: unknown;
};

async function inboundFirm(sb: SupabaseClient, row: InboundRow): Promise<string | null> {
  if (row.campaign_influencer_id) return firmIdForCampaignInfluencer(sb, row.campaign_influencer_id);
  if (row.creator_offer_id) {
    const { data } = await sb.from('creator_offers').select('firm_id').eq('id', row.creator_offer_id).maybeSingle();
    return (data as { firm_id?: string | null } | null)?.firm_id ?? null;
  }
  return null;
}

/** The offer on a reply's thread, for the manual-mode check. */
async function threadOffer(sb: SupabaseClient, row: InboundRow) {
  const q = sb.from('creator_offers').select('id, firm_id, campaign_influencer_id, autonomy_mode, status');
  const { data } = row.creator_offer_id
    ? await q.eq('id', row.creator_offer_id)
    : await q.eq('campaign_influencer_id', String(row.campaign_influencer_id));
  const offers = (data ?? []) as Array<{ id: string; campaign_influencer_id: string | null; autonomy_mode: string | null; status: string }>;
  return offers.find((o) => o.status === 'offered' || o.status === 'counter_offered') ?? offers[0] ?? null;
}

/**
 * Resolve one held reply (and the earlier replies it answered for, which were
 * held with it). Returns the ids moved, or a refusal.
 */
async function resolveHeldReply(
  sb: SupabaseClient,
  inboundId: string,
  input: ResolveInput,
  nowIso: string,
): Promise<{ ok: true; ids: string[] } | { ok: false; result: ResolveResult }> {
  const { data, error } = await sb
    .from('inbound_messages')
    .select('id, status, campaign_influencer_id, creator_offer_id, classification')
    .eq('id', inboundId)
    .maybeSingle();
  if (error) return { ok: false, result: { status: 503, body: { error: 'unreadable', message: 'Could not read this reply. Try again in a minute.' } } };
  const row = data as InboundRow | null;
  if (!row) return { ok: false, result: NOT_FOUND };
  if ((await inboundFirm(sb, row)) !== input.firmId) return { ok: false, result: NOT_FOUND };
  if (row.status !== 'flagged') {
    return { ok: false, result: { status: 409, body: { error: 'not_held', message: 'This reply is no longer held; nothing to resolve.' } } };
  }

  if (input.action === 'process_normally') {
    const offer = await threadOffer(sb, row);
    if (offer) {
      // Manual mode, or another reply on the thread still held, means the
      // negotiator would hold this one again: say so instead.
      const hold = await readThreadHold(sb, offer, [row.id]);
      if (isHumanTakeover(offer) || hold.kind !== 'clear') {
        return {
          ok: false,
          result: {
            status: 409,
            body: {
              error: 'thread_in_manual_mode',
              message:
                hold.kind === 'unreadable'
                  ? 'Could not check this thread. Try again in a minute.'
                  : 'A person is handling this negotiation, so the negotiator would hold this reply again. Mark it reviewed, or resume automation from the deal thread first.',
            },
          },
        };
      }
    }
    const prior =
      row.classification && typeof row.classification === 'object' && !Array.isArray(row.classification)
        ? (row.classification as Record<string, unknown>)
        : {};
    const patch = {
      status: 'classified',
      classification: { ...prior, operator_resolution: { by: input.actorLabel, at: nowIso, via: 'process_normally' } },
    };
    const write = (p: Record<string, unknown>) =>
      sb.from('inbound_messages').update(p as never).eq('id', row.id).eq('status', 'flagged').select('id');
    // A stale claim from the turn that held it must not block the next tick.
    let { data: moved, error: wErr } = await write({ ...patch, [INBOUND_CLAIM_COLUMN]: null });
    if (wErr && isMissingColumnError(wErr)) ({ data: moved, error: wErr } = await write(patch));
    if (wErr || !Array.isArray(moved) || moved.length === 0) {
      return { ok: false, result: { status: 409, body: { error: 'changed', message: 'This reply changed while you were resolving it. Reload.' } } };
    }
    return { ok: true, ids: [row.id] };
  }

  const ids: string[] = [];
  if (await markInboundReviewed(sb, row.id, { actorLabel: input.actorLabel, via: 'resolve', nowIso })) ids.push(row.id);
  // Earlier replies answered by this one (migration 058) were held with it.
  const { data: group, error: gErr } = await sb
    .from('inbound_messages')
    .select('id, status')
    .eq('answered_by_inbound_id', row.id)
    .eq('status', 'flagged');
  if (!gErr) {
    for (const g of (group ?? []) as Array<{ id: string }>) {
      if (await markInboundReviewed(sb, g.id, { actorLabel: input.actorLabel, via: 'resolve_with_answering_reply', nowIso })) ids.push(g.id);
    }
  }
  return { ok: true, ids };
}

export async function resolveAnomaly(sb: SupabaseClient, input: ResolveInput): Promise<ResolveResult> {
  const nowIso = new Date(input.nowMs ?? Date.now()).toISOString();
  const m = /^(flagged|injection|escalation|fishy)-(.+)$/.exec(input.ref);
  if (!m) return { status: 422, body: { error: 'not_resolvable', message: 'This item cannot be resolved from here.' } };
  const [, kind, id] = m;

  let category: string;
  let offerId: string | null = null;
  let inboundIds: string[] = [];
  let note: string;

  if (kind === 'flagged') {
    if (!input.isOperator) return OPERATOR_ONLY;
    category = 'flagged_inbound';
    const r = await resolveHeldReply(sb, id, input, nowIso);
    if (!r.ok) return r.result;
    inboundIds = r.ids;
    note = input.action === 'process_normally' ? 'Sent back to the negotiator.' : 'Marked reviewed.';
  } else if (kind === 'injection') {
    if (!input.isOperator) return OPERATOR_ONLY;
    category = 'injection_flagged';
    const { data } = await sb.from('creator_offers').select('id, firm_id, injection_flagged').eq('id', id).maybeSingle();
    const offer = data as { id: string; firm_id: string | null; injection_flagged: boolean } | null;
    if (!offer || offer.firm_id !== input.firmId) return NOT_FOUND;
    if (!offer.injection_flagged) {
      return { status: 409, body: { error: 'not_flagged', message: 'This flag was already cleared.' } };
    }
    const { error } = await sb
      .from('creator_offers')
      .update({ injection_flagged: false } as never)
      .eq('id', id)
      .eq('injection_flagged', true);
    if (error) return { status: 503, body: { error: 'write_failed', message: 'Could not clear the flag. Try again.' } };
    offerId = id;
    note = 'Injection flag cleared. Manual mode, if on, stays on until automation is resumed.';
  } else {
    // An audit-backed row: retire it, and release the reply it was about.
    const actions = kind === 'escalation' ? ESCALATION_AUDIT_ACTIONS : FISHY_AUDIT_ACTIONS;
    if (kind === 'fishy' && !input.isOperator) return OPERATOR_ONLY;
    category = kind === 'escalation' ? 'needs_decision' : 'fishy_reply';
    const { data, error } = await sb
      .from('audit_log')
      .select('id, action, firm_id, target_id, metadata')
      .eq('id', id)
      .maybeSingle();
    if (error) return { status: 503, body: { error: 'unreadable', message: 'Could not read this item. Try again in a minute.' } };
    const row = data as { id: string; action: string; firm_id: string | null; target_id: string | null; metadata: Record<string, unknown> | null } | null;
    if (!row || row.firm_id !== input.firmId || !actions.includes(row.action)) return NOT_FOUND;
    offerId = row.target_id;
    const inboundId = typeof row.metadata?.inbound_message_id === 'string' ? row.metadata.inbound_message_id : null;
    if (inboundId) {
      const r = await resolveHeldReply(sb, inboundId, input, nowIso);
      if (r.ok) inboundIds = r.ids;
      else if (input.action === 'process_normally' || r.result.status === 503) return r.result;
      // 'reviewed' on a reply already released (or gone) still retires the row.
    } else if (input.action === 'process_normally') {
      return { status: 422, body: { error: 'no_reply', message: 'There is no held reply on this item to send to the negotiator.' } };
    }
    note = input.action === 'process_normally' ? 'Sent back to the negotiator.' : 'Marked reviewed.';
  }

  await audit(
    {
      action: ANOMALY_RESOLVED_ACTION,
      actor_label: input.actorLabel,
      target_type: kind === 'flagged' ? 'inbound_message' : kind === 'injection' ? 'creator_offer' : 'audit_log',
      target_id: id,
      firm_id: input.firmId,
      metadata: { ref: input.ref, category, resolution: input.action, inbound_ids: inboundIds, creator_offer_id: offerId },
    },
    input.request,
  );
  return { status: 200, body: { ok: true, ref: input.ref, resolution: input.action, inbound_ids: inboundIds, message: note } };
}
