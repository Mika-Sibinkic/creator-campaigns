// src/lib/resend.ts
//
// Resend dispatch wrapper. Owns sender + recipient resolution.
//
// Resolution order (migration 013 layered per-user overrides on top of firm
// defaults so each tester routes outreach to their own inbox without
// fighting over a single firm-wide test_recipient_email):
//
//   From sender_email:
//     1. firm_members.sender_email          (per-user override)
//     2. firms.sender_email                 (firm default)
//     3. env RESEND_FROM_EMAIL
//     4. 'onboarding@resend.dev'
//
//   From sender_name:
//     1. firm_members.sender_name           (per-user override)
//     2. firms.sender_name                  (firm default)
//     3. firms.name                         (the label's own name)
//     4. 'The team'                         — never the product's name; the
//        label is the sender, Creator Campaigns is the tool.
//
//   To (testing_mode === true only):
//     1. firm_members.test_recipient_email  (per-user override)
//     2. firms.test_recipient_email         (firm default)
//     3. user_email                         (session.user.email)
//     4. env TEST_RECIPIENT_EMAIL
//     5. fail with { ok:false, error:'no_test_recipient' }
//
//   To (testing_mode === false):
//     - input.to_real (creator's real contact_email); null → fail.
//
// We deliberately do NOT fall through to onboarding@resend.dev for the To
// resolution — silently routing to Resend's sandbox address would lose the
// signal that a tester forgot to set their inbox.

import { Resend } from 'resend';
import { getEnv } from './env';
import { supabaseAdmin } from './supabase';
import { audit as writeAudit } from './audit';
import { alertOnce } from './sentry-alerts';
import { buildOutboundEnvelope, listUnsubscribeHeaders } from './channels/outbound-envelope';
import { outboundHtmlFor } from './payout-email';

let _client: Resend | null = null;
function client() {
  if (_client) return _client;
  _client = new Resend(getEnv('RESEND_API_KEY'));
  return _client;
}

export interface SendInput {
  firm_id: string;
  to_real: string | null; // creator's actual contact email; null if unknown
  subject: string;
  body: string;
  reply_to?: string;
  /**
   * When set (and no explicit reply_to is given), the send carries a
   * correlated Reply-To — `<inbox-local>+lead-<id>@<inbox-domain>` — so the
   * Gmail intake poller can match the creator's reply back to this lead.
   * Without it, a real reply lands in inbound_messages uncorrelated and the
   * negotiation tick skips it forever.
   */
  campaign_influencer_id?: string;
  /** Caller's user id — enables firm_members per-user override lookup. */
  /** Clerk user id of the sender, for per-user overrides on firm_members. */
  clerk_user_id?: string;
  /** Caller's session email — final fallback for testing-mode To. */
  user_email?: string | null;
  /** Optional file attachments (e.g. the promo track). content is base64. */
  attachments?: { filename: string; content: string; contentType?: string }[];
  /**
   * outreach_messages.message_type of the row being sent. Opt-in types get an
   * HTML alternative derived from `body` (src/lib/payout-email.ts); every
   * other type, and an absent value, stays text-only.
   */
  message_type?: string | null;
}

/** Test seams. Production callers pass nothing. */
export interface SendDeps {
  sb?: Pick<ReturnType<typeof supabaseAdmin>, 'from'>;
  resend?: { emails: { send: Resend['emails']['send'] } };
  audit?: typeof writeAudit;
}

export interface SendResult {
  ok: boolean;
  resolved_to: string;
  message_id?: string;
  error?: string;
  test_mode: boolean;
}

type ResolutionSource =
  | 'firm_member'
  | 'firm'
  | 'session_user'
  | 'env'
  | 'creator';

export async function sendOutreach(input: SendInput, deps: SendDeps = {}): Promise<SendResult> {
  const sb = deps.sb ?? supabaseAdmin();
  const audit = deps.audit ?? writeAudit;

  const { data: firm, error } = await sb
    .from('firms')
    .select('name, testing_mode, test_recipient_email, sender_email, sender_name, negotiation_inbox_email')
    .eq('id', input.firm_id)
    .single();
  if (error || !firm) {
    return { ok: false, resolved_to: '', error: 'firm not found', test_mode: true };
  }
  const f = firm as {
    name: string | null;
    testing_mode: boolean;
    test_recipient_email: string | null;
    sender_email: string | null;
    sender_name: string | null;
    negotiation_inbox_email: string | null;
  };

  // Per-user overrides (migration 013). Only fetched when a Clerk user id is
  // provided; a missing row tolerates legacy callers gracefully.
  //
  // Keyed on `clerk_user_id`, NOT `user_id`. `firm_members.user_id` is a uuid
  // FK to auth.users from the pre-Clerk magic-link era; the session carries a
  // Clerk id like `user_2ab…`, and querying the uuid column with it makes
  // Postgres raise 22P02. That error was discarded here, so every per-user
  // sender and test-recipient override silently never applied.
  let memberSenderEmail: string | null = null;
  let memberSenderName: string | null = null;
  let memberTestRecipient: string | null = null;
  if (input.clerk_user_id) {
    const { data: member } = await sb
      .from('firm_members')
      .select('sender_email, sender_name, test_recipient_email')
      .eq('clerk_user_id', input.clerk_user_id)
      .eq('firm_id', input.firm_id)
      .maybeSingle();
    if (member) {
      const m = member as {
        sender_email: string | null;
        sender_name: string | null;
        test_recipient_email: string | null;
      };
      memberSenderEmail = m.sender_email;
      memberSenderName = m.sender_name;
      memberTestRecipient = m.test_recipient_email;
    }
  }

  // ─── Sender resolution ────────────────────────────────────────────────
  let fromEmail: string;
  let fromEmailSource: ResolutionSource;
  if (memberSenderEmail) {
    fromEmail = memberSenderEmail;
    fromEmailSource = 'firm_member';
  } else if (f.sender_email) {
    fromEmail = f.sender_email;
    fromEmailSource = 'firm';
  } else {
    fromEmail = getEnv('RESEND_FROM_EMAIL', 'onboarding@resend.dev');
    fromEmailSource = 'env';
  }
  // Sender reads as the USER FIRM, never the product — Creator Campaigns is the
  // tool, the firm (e.g. "Example Records") is who the creator hears from.
  const fromName = memberSenderName ?? f.sender_name ?? f.name ?? 'The team';

  // ─── Recipient resolution ─────────────────────────────────────────────
  let resolved_to: string | null = null;
  let toSource: ResolutionSource | null = null;
  if (f.testing_mode) {
    if (memberTestRecipient) {
      resolved_to = memberTestRecipient;
      toSource = 'firm_member';
    } else if (f.test_recipient_email) {
      resolved_to = f.test_recipient_email;
      toSource = 'firm';
    } else if (input.user_email) {
      resolved_to = input.user_email;
      toSource = 'session_user';
    } else {
      const envFallback = process.env.TEST_RECIPIENT_EMAIL ?? null;
      if (envFallback) {
        resolved_to = envFallback;
        toSource = 'env';
      }
    }
    if (!resolved_to) {
      await audit({
        action: 'outreach.send.failed',
        firm_id: input.firm_id,
        target_type: 'outreach_message',
        metadata: {
          test_mode: true,
          error: 'no_test_recipient',
          resolution_source: 'none',
          resolved_from: `${fromName} <${fromEmail}>`,
          from_source: fromEmailSource,
          ok: false,
        },
      });
      return {
        ok: false,
        resolved_to: '',
        error: 'no_test_recipient',
        test_mode: true,
      };
    }
  } else {
    resolved_to = input.to_real;
    toSource = 'creator';
    if (!resolved_to) {
      return {
        ok: false,
        resolved_to: '',
        error: 'no recipient (live mode + influencer has no contact_email)',
        test_mode: false,
      };
    }
  }

  const resolved_from = `${fromName} <${fromEmail}>`;

  // Subject + Reply-To in one decision (src/lib/channels/outbound-envelope.ts).
  //
  // Subject: the `[Creator Campaigns]` tag is a TESTING-mode nicety — real creators
  // must never see an internal tag, so live mode ships the subject untouched.
  // It is NOT a correlation signal, and the Gmail intake adapter no longer
  // requires it (requiring it meant turning testing mode off silenced the whole
  // reply loop). Idempotent, so a threaded "Re: [Creator Campaigns] …" is never
  // double-tagged.
  //
  // Reply-To: explicit caller value wins; otherwise the correlated plus-address
  // from the firm's negotiation inbox (falling back to the resolved sender,
  // which is often the same Workspace inbox the Gmail poller reads). This is
  // the ONLY correlation anchor on a live send.
  const envelope = buildOutboundEnvelope({
    testingMode: f.testing_mode,
    subject: input.subject,
    explicitReplyTo: input.reply_to,
    campaignInfluencerId: input.campaign_influencer_id,
    negotiationInboxEmail: f.negotiation_inbox_email,
    fromEmail,
  });
  const outboundSubject = envelope.subject;
  const replyTo = envelope.replyTo;

  // Multipart: text/plain is always the stored body; an HTML alternative is
  // added only for opt-in message types whose body still matches their
  // template (payout-email.ts). Recipient resolution above is untouched by
  // this, so testing mode redirects the HTML exactly as it does the text.
  const html = outboundHtmlFor(input.message_type, input.body);

  try {
    const r = await (deps.resend ?? client()).emails.send({
      from: resolved_from,
      to: resolved_to,
      subject: outboundSubject,
      text: input.body,
      ...(html ? { html } : {}),
      replyTo,
      // CAN-SPAM 15 U.S.C. §7704(a)(3)-(4) requires a working opt-out on
      // commercial email, and until now no message carried one in any form —
      // no header, no link, no line in the body. The body copy now says "reply
      // STOP"; this is the machine-readable half, so a mail client can offer
      // unsubscribe without the creator having to compose anything.
      //
      // The reply address is the target, because that is the channel the copy
      // promises and the one that is actually wired: an inbound STOP is detected
      // by isOptOutReply and blocks the creator for this label
      // (firm_influencer_blocks, src/lib/firm-blocks.ts), which pool-gates
      // refuses every future send from this label against. One-click POST is only advertised when
      // a real https endpoint exists — claiming it with a mailto would make us
      // fail the thing we just announced.
      headers: listUnsubscribeHeaders({
        channel: 'email',
        replyAddress: replyTo ?? fromEmail,
      }),
      ...(input.attachments && input.attachments.length > 0
        ? {
            attachments: input.attachments.map((a) => ({
              filename: a.filename,
              content: a.content,
              contentType: a.contentType,
            })),
          }
        : {}),
    });
    // The Resend SDK does NOT throw on API-level failures — it resolves with
    // `{ data: null, error }`. So a daily_quota_exceeded or
    // rate_limit_exceeded came back as a SUCCESS here: the caller marked the
    // row 'sent', the audit trail said ok, provider_message_id was stamped
    // NULL, and no email existed. Silent, and precisely the case you most
    // need to know about, because it happens in bursts.
    //
    // A missing id is treated the same way. Without it the delivery webhook
    // has nothing to correlate on, so the message is unverifiable forever —
    // better to fail loudly at send time than to bank an untrackable send.
    // Throwing hands off to the catch below, which already audits
    // outreach.send.failed, dedupes a Sentry alert, and returns ok:false.
    if (r.error || !r.data?.id) {
      const detail = r.error
        ? `${r.error.name ?? 'resend_error'}: ${r.error.message}`
        : 'resend accepted the call but returned no message id';
      throw new Error(`resend send failed — ${detail}`);
    }

    // SEC-3 audit: every successful Resend dispatch is recorded here so the
    // event captures every call site (route handler, future cron, etc.) in
    // one place. audit() never throws — fire-and-forget.
    await audit({
      action: 'outreach.send',
      firm_id: input.firm_id,
      target_type: 'outreach_message',
      metadata: {
        test_mode: f.testing_mode,
        resolved_to,
        resolved_from,
        resolution_source: toSource,
        from_source: fromEmailSource,
        subject_preview: outboundSubject.slice(0, 120),
        reply_to: replyTo ?? null,
        // False means this lead's reply cannot be routed back to it — the
        // thread is a dead end. Visible here rather than inferred later.
        reply_to_correlated: envelope.correlated,
        html: html !== null,
        message_id: r.data?.id,
        ok: true,
      },
    });
    return { ok: true, resolved_to, message_id: r.data.id, test_mode: f.testing_mode };
  } catch (e) {
    const errMsg = (e as Error).message;
    await audit({
      action: 'outreach.send.failed',
      firm_id: input.firm_id,
      target_type: 'outreach_message',
      metadata: {
        test_mode: f.testing_mode,
        resolved_to,
        resolved_from,
        resolution_source: toSource,
        from_source: fromEmailSource,
        error: errMsg,
        ok: false,
      },
    });
    // N7: Sentry — Resend dispatch failure. Dedupe per firm + error-class
    // so a Resend outage that hits 50 sends in a row shows up as one issue.
    alertOnce(
      `resend_send_failure:${input.firm_id}:${errMsg.slice(0, 80)}`,
      'error',
      'Resend send failed',
      {
        firm_id: input.firm_id,
        test_mode: f.testing_mode,
        resolution_source: toSource,
        from_source: fromEmailSource,
        error: errMsg,
      }
    );
    return { ok: false, resolved_to, error: errMsg, test_mode: f.testing_mode };
  }
}
