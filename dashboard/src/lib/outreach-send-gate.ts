// src/lib/outreach-send-gate.ts
//
// The first step of POST /api/outreach/[id]/send: prove the caller's label
// owns the message, THEN load it and apply the terminal-state refusals.
//
// The route runs on the service-role client. It used to load the message by id
// and answer 409 "already sent" / window_closed / superseded / dm_queue before
// its firm check, which sat after the campaign lookup and the stale-draft 409.
// Any signed-in user of any label could probe another label's message ids and
// read back which exist and what state each is in. Ownership now comes first,
// and a foreign id is a 404 byte-identical to an unknown one
// (outreachMessageInFirm, src/lib/outreach-scope.ts — the same gate the
// /api/outreach/messages/[id] handlers use).
//
// Executed by tests/outreach-send-scope.test.ts.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isSuperseded, isWindowClosed } from './message-status';
import { OUTREACH_NOT_FOUND, outreachMessageInFirm } from './outreach-scope';

export interface SendableMessage {
  id: string;
  campaign_influencer_id: string;
  subject: string | null;
  body: string;
  sent_at: string | null;
  created_at: string | null;
  message_type: string | null;
  channel: string | null;
  send_mode: string | null;
  status: string | null;
  /** Restored on a failed send, so a queued row keeps its schedule (outbound-claim.ts). */
  send_after: string | null;
}

export type SendGate =
  | { ok: true; message: SendableMessage }
  | { ok: false; status: 404 | 409; body: Record<string, unknown> };

const notFound = (): SendGate => ({ ok: false, status: 404, body: { ...OUTREACH_NOT_FOUND } });

export async function loadSendableMessage(
  sb: SupabaseClient,
  messageId: string,
  callerFirmId: string | null | undefined
): Promise<SendGate> {
  // Tenant gate FIRST — before any response that depends on the row's state.
  if (!(await outreachMessageInFirm(sb, messageId, callerFirmId))) return notFound();

  const { data: msg, error: msgErr } = await sb
    .from('outreach_messages')
    .select('id, campaign_influencer_id, subject, body, sent_at, created_at, message_type, channel, send_mode, status, send_after')
    .eq('id', messageId)
    .single();
  if (msgErr || !msg) return notFound();
  const m = msg as SendableMessage;

  // The client (dm-queue-tab, outreach-send-copy) keys on this exact string.
  if (m.sent_at) {
    return { ok: false, status: 409, body: { error: 'already sent' } };
  }

  // The campaign window already closed this message out. Refused
  // before everything else the route does, because its DM-routing branch
  // PERFORMS AN UPDATE (send_mode='human_queue') that would resurrect a
  // window-closed row into the DM queue for a human to send by hand.
  if (isWindowClosed(m.status)) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'window_closed',
        message:
          'This campaign’s outreach window has closed, so this message was not sent. Reopen the window (or adjust the release date) if it should still go out.',
      },
    };
  }

  // Dropped before it went: a holding note whose real reply could no longer
  // follow it in time (src/lib/holding-note.ts), or any message queued to a
  // creator who then opted out (firm-blocks.ts).
  if (isSuperseded(m.status)) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'superseded',
        message:
          'This message was cancelled before it went out (the creator opted out, or a newer reply replaced it), so it was not sent.',
      },
    };
  }

  // Guard 1/2: a row already routed to the human DM queue is never
  // auto-emailed — a human sends it from the firm's own account.
  if (m.send_mode === 'human_queue') {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'dm_queue',
        message: 'This draft is in the DM queue. Send it by hand from the DM queue tab.',
      },
    };
  }

  return { ok: true, message: m };
}
