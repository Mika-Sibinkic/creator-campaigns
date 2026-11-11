// tests/inbound-acceptance-evidence.test.ts
//
// Pins the thing that makes an emailed acceptance PROVABLE rather than merely
// claimable (migration 052).
//
// Creator Campaigns does not buy an e-signature vendor. What a vendor actually sells is
// evidence packaging, so these two properties have to hold in-house:
//
//   1. A creator who writes "Yes, I agree to these terms" ABOVE the quoted
//      contract keeps the quoted contract in `raw_body`, while `body` — the
//      classifier's and the negotiator's input — still contains only the
//      creator's own words. Before this, stripQuotedReply() cut the terms out of
//      the only stored copy: an acceptance with no trace of the thing accepted.
//
//   2. The SPF/DKIM/DMARC verdict the receiving infrastructure stamped survives
//      all the way to the INSERT. Before this it was computed, console.warn'd,
//      and dropped; the only durable footprint of a failed authentication was
//      campaign_influencer_id IS NULL, which is indistinguishable from a reply
//      that carried no correlation tag.
//
// Also pins: hash stability and recomputability, the verbatim cap being RECORDED
// rather than silent, In-Reply-To capture, the missing-column degrade path (the
// code can be deployed before 052 is applied, so code and schema are skewed
// until someone applies it), and — structurally — that nothing widened what
// reaches the model.
//
// Hermetic: no network (injected GmailFetch), no database (recording stub), no
// secrets, and the two policy env vars are cleared and restored.
//
// Run: npx tsx tests/inbound-acceptance-evidence.test.ts

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MAX_VERBATIM_BODY_CHARS,
  captureVerbatimBody,
  normalizeInboundEmail,
  parentMessageId,
  sha256Hex,
  stripQuotedReply,
} from '../src/lib/channels/email-inbound';
import { ingestInboundReply, type NormalizedInbound } from '../src/lib/ingest-inbound';
import {
  pollGmailInbound,
  resetGmailTokenCache,
  type GmailFetch,
} from '../src/lib/channels/gmail-inbound';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const CI_ID = '11111111-2222-3333-4444-555555555555';
const CREATOR = 'rowan@example.com';
const INBOX = `deals+lead-${CI_ID}@mail.example.com`;

/** The clause whose survival is the entire point of the feature. */
const CONTRACT_CLAUSE = 'Fee: USD 400.00 for one (1) TikTok video';

/**
 * A real reply shape: assent on top, our contract quoted beneath it under the
 * Gmail/Apple attribution line. BOTH quote markers stripQuotedReply cuts on are
 * present — the "On … wrote:" attribution and `>` lines.
 */
const ACCEPTANCE = [
  'Yes, I agree to these terms.',
  '',
  `On Mon, Sep 21, 2026 at 4:12 PM Creator Campaigns <${INBOX}> wrote:`,
  '> --- Agreement terms ---',
  `> ${CONTRACT_CLAUSE}`,
  '> Payment: Stripe payout, net 14 after posting',
  '> Usage: organic only, 90 days',
].join('\n');

const GMAIL_DMARC_PASS =
  'mx.google.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=rowan@example.com; dmarc=pass header.from=example.com';

function emailMessage(over: Record<string, unknown> = {}) {
  return {
    provider: 'gmail',
    providerMessageId: 'msg-1',
    from: CREATOR,
    envelopeRecipients: [INBOX],
    subject: 'Re: Collaboration',
    text: ACCEPTANCE,
    authenticationResults: GMAIL_DMARC_PASS,
    ...over,
  };
}

/** Accepts with all three locks satisfied, verdict attached. */
function normalizeAccepted(over: Record<string, unknown> = {}) {
  const decision = normalizeInboundEmail(emailMessage(over), {
    senderVerified: true,
    senderIsKnownCreator: true,
    senderAuthenticated: true,
    senderAuthVerdict: { outcome: 'dmarc_pass', authservId: 'mx.google.com' },
    requireSenderAuthentication: true,
  });
  if (!decision.accepted) {
    console.error('  ✗ FAIL (fixture): normalizeInboundEmail refused:', decision.reason);
    process.exit(1);
  }
  return decision;
}

// ── Gmail transport harness (no network) ────────────────────────────────────

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

interface GmailFixture {
  id: string;
  from: string;
  deliveredTo: string;
  auth: string | null;
  /** Single-part text/plain body, or an explicit multipart payload. */
  text?: string;
  html?: string;
  extraHeaders?: Array<{ name: string; value: string }>;
}

function gmailPayload(f: GmailFixture) {
  const headers = [
    // Gmail's own MX stamps these and PREPENDS them; `.find()` takes the first,
    // which is why this transport can carry a trustworthy verdict at all.
    { name: 'Delivered-To', value: f.deliveredTo },
    ...(f.auth === null ? [] : [{ name: 'Authentication-Results', value: f.auth }]),
    { name: 'Subject', value: 'Re: Collaboration' },
    { name: 'From', value: f.from },
    { name: 'Date', value: 'Mon, 21 Sep 2026 16:20:00 -0500' },
    ...(f.extraHeaders ?? []),
  ];
  const payload =
    f.html !== undefined
      ? {
          headers,
          mimeType: 'multipart/alternative',
          parts: [{ mimeType: 'text/html', body: { data: b64(f.html) } }],
        }
      : {
          headers,
          mimeType: 'text/plain',
          body: { data: b64(f.text ?? '') },
        };
  return { id: f.id, threadId: `t-${f.id}`, labelIds: ['INBOX'], snippet: '', payload };
}

function gmailNet(fixtures: GmailFixture[]): GmailFetch {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  return async (url) => {
    if (url === TOKEN_URL) return jsonResponse({ access_token: 'tok', expires_in: 3600 });
    if (url.includes('/messages?')) {
      return jsonResponse({ messages: fixtures.map((f) => ({ id: f.id })) });
    }
    const id = decodeURIComponent(url.split('/messages/')[1]?.split('?')[0] ?? '');
    const f = byId.get(id);
    return f ? jsonResponse(gmailPayload(f)) : jsonResponse({ error: 'not found' }, 404);
  };
}

/**
 * Chainable Supabase stub recording every insert. Reads answer just enough for
 * attribution: the lead resolves to an influencer, the influencer's contact
 * email is the creator's, and no inbound row exists so nothing dedupes.
 *
 * `failInsertOnce` reproduces the schema-skew case: PostgREST rejects an insert
 * naming a column its cache does not know (PGRST204).
 */
function sbStub(
  opts: { creatorEmail?: string; failInsertWhen?: (row: Record<string, unknown>) => boolean } = {},
): { sb: SupabaseClient; inserts: Array<{ table: string; row: Record<string, unknown> }> } {
  const creatorEmail = opts.creatorEmail ?? CREATOR;
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const builder = (table: string) => {
    let rejected = false;
    const b: Record<string, unknown> = {
      insert(row: Record<string, unknown>) {
        inserts.push({ table, row });
        rejected = opts.failInsertWhen ? opts.failInsertWhen(row) : false;
        return b;
      },
      select: () => b,
      update: () => b,
      eq: () => b,
      in: () => b,
      is: () => b,
      not: () => b,
      limit: () => b,
      order: () => b,
      maybeSingle: async () => {
        if (table === 'campaign_influencers') {
          return { data: { influencer_id: 'inf-1', last_response_at: null }, error: null };
        }
        if (table === 'influencers') return { data: { contact_email: creatorEmail }, error: null };
        return { data: null, error: null };
      },
      single: async () =>
        rejected
          ? {
              data: null,
              error: {
                code: 'PGRST204',
                message: "Could not find the 'raw_body' column of 'inbound_messages' in the schema cache",
              },
            }
          : { data: { id: `${table}-row` }, error: null },
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return b;
  };
  return { sb: { from: (t: string) => builder(t) } as unknown as SupabaseClient, inserts };
}

/**
 * Every `.from('inbound_messages').select(...)` in the tree, with the column
 * list it asked for. Used to prove the evidence columns did not widen what any
 * reader — model prompt or API response — receives.
 */
function selectsOnInboundMessages(root: string): Array<{ file: string; columns: string }> {
  const out: Array<{ file: string; columns: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const src = readFileSync(full, 'utf8');
      if (!src.includes("from('inbound_messages')")) continue;
      const re = /from\('inbound_messages'\)\s*\.select\(([^)]*)\)/g;
      for (const m of src.matchAll(re)) out.push({ file: full, columns: m[1] });
    }
  };
  walk(root);
  return out;
}

function inboundInsert(
  inserts: Array<{ table: string; row: Record<string, unknown> }>,
  nth = 0,
): Record<string, unknown> | null {
  const rows = inserts.filter((i) => i.table === 'inbound_messages');
  return rows[nth]?.row ?? null;
}

async function main() {
  // Hermetic policy env: `require` mode, no extra trusted authserv-ids.
  const savedMode = process.env.INBOUND_SENDER_AUTH_MODE;
  const savedIds = process.env.INBOUND_TRUSTED_AUTHSERV_IDS;
  delete process.env.INBOUND_SENDER_AUTH_MODE;
  delete process.env.INBOUND_TRUSTED_AUTHSERV_IDS;
  process.env.GMAIL_ACCESS_TOKEN = 'static-test-token';
  resetGmailTokenCache();

  try {
    // ── 1. THE POINT: the terms accepted survive; the classifier input does not
    //      gain them ────────────────────────────────────────────────────────
    {
      const { normalized } = normalizeAccepted();

      assert(
        (normalized.raw_body ?? '').includes(CONTRACT_CLAUSE),
        'verbatim body RETAINS the quoted contract clause the creator agreed to'
      );
      assert(
        (normalized.raw_body ?? '').includes('--- Agreement terms ---'),
        'verbatim body retains the agreement-terms marker'
      );
      assert(
        normalized.raw_body === ACCEPTANCE,
        'verbatim body is the provider text byte-for-byte — no strip, no trim, no decode'
      );

      assert(
        normalized.body === 'Yes, I agree to these terms.',
        'stripped body is ONLY the creator\'s own words'
      );
      assert(
        !normalized.body.includes(CONTRACT_CLAUSE),
        'stripped body does NOT contain the quoted contract (the classifier would read it as ours)'
      );
      assert(!normalized.body.includes('>'), 'stripped body contains no quoted lines at all');
    }

    // ── 2. The classifier / model input is UNCHANGED ─────────────────────────
    //
    // `body` must still be exactly stripQuotedReply(provider text). If this ever
    // drifts, the negotiator's input changed and the feature broke its contract.
    {
      const { normalized } = normalizeAccepted();
      assert(
        normalized.body === stripQuotedReply(ACCEPTANCE),
        'body is still exactly stripQuotedReply(provider text) — model input unchanged'
      );

      // Structural guard on the consumer side: the negotiation tick names its
      // columns, so an added column cannot widen what reaches a model. A `*`
      // select here would silently start loading raw_body.
      const tickSrc = readFileSync(
        path.join(__dirname, '..', 'src', 'lib', 'negotiation-tick.ts'),
        'utf8'
      );
      const sel = tickSrc.match(/from\('inbound_messages'\)\s*\.select\(([^)]*)\)/);
      assert(sel !== null, 'negotiation-tick still selects from inbound_messages (guard is live)');
      assert(
        sel !== null && !sel[1].includes('*'),
        'negotiation-tick does NOT select * from inbound_messages'
      );
      assert(
        sel !== null && !sel[1].includes('raw_body'),
        'negotiation-tick does NOT read raw_body — untrusted verbatim text never reaches the model'
      );
      assert(
        !tickSrc.includes('raw_body'),
        'negotiation-tick does not mention raw_body anywhere'
      );

      // And the same guard across EVERY reader in the tree. raw_body is
      // untrusted creator text that may be HTML SOURCE; a `select('*')`
      // anywhere would put it into an API response or a model prompt without
      // anyone deciding to.
      const readers = selectsOnInboundMessages(path.join(__dirname, '..', 'src'));
      assert(readers.length > 0, 'the inbound_messages reader scan found something (guard is live)');
      const widened = readers.filter((r) => r.columns.includes('*') || r.columns.includes('raw_body'));
      assert(
        widened.length === 0,
        `no reader selects * or raw_body from inbound_messages (offenders: ${widened
          .map((r) => r.file)
          .join(', ')})`
      );
    }

    // ── 3. Hash: stable, and recomputable against the stored value ───────────
    {
      assert(
        sha256Hex('Yes, I agree to these terms.') ===
          '7f56d3f480e2500e83176519ca12ed37762ac37e7845c8fa5a6ede77c34fa70c',
        'sha256Hex is pinned: utf8 in, lowercase hex out'
      );
      assert(
        sha256Hex('Sí, acepto — £400') ===
          'ce22ac317e68169e3d19d9b6c33832b9298ec5b30bb0e61a682531099b00a23f',
        'sha256Hex is pinned for multi-byte utf8 (a creator does not reply in ASCII)'
      );

      const { normalized } = normalizeAccepted();
      assert(
        normalized.raw_body_sha256 === sha256Hex(normalized.raw_body ?? ''),
        'stored hash recomputes from the stored verbatim body — the row verifies itself'
      );
      assert(
        normalized.raw_body_sha256 === sha256Hex(ACCEPTANCE),
        'stored hash is the hash of what the provider actually sent'
      );
      assert(normalized.raw_body_truncated === false, 'a normal reply is not truncated');
      assert(
        normalized.raw_body_chars === ACCEPTANCE.length,
        'raw_body_chars is the provider body length'
      );
      assert(normalized.raw_body_media_type === 'text/plain', 'media type recorded for a plain reply');
    }

    // ── 4. The cap is RECORDED, never silent ─────────────────────────────────
    {
      const huge = 'I agree. ' + 'x'.repeat(MAX_VERBATIM_BODY_CHARS);
      const v = captureVerbatimBody(huge, null);
      assert(v !== null, 'cap case: a body is captured');
      assert(v?.text.length === MAX_VERBATIM_BODY_CHARS, 'verbatim body is cut AT the cap');
      assert(v?.truncated === true, 'truncation is recorded as a fact on the row');
      assert(v?.chars === huge.length, 'the ORIGINAL length is recorded, so what was cut is known');
      assert(
        v?.sha256 === sha256Hex(huge.slice(0, MAX_VERBATIM_BODY_CHARS)),
        'the hash covers the STORED prefix, so it can still be recomputed from the row'
      );
      assert(
        v?.text.startsWith('I agree.') === true,
        'the cap keeps the HEAD of the message, where the assent is'
      );

      // Exactly at the cap is not truncation.
      const exact = 'y'.repeat(MAX_VERBATIM_BODY_CHARS);
      assert(captureVerbatimBody(exact, null)?.truncated === false, 'a body exactly at the cap is not marked truncated');

      // No body at all → nothing claimed.
      assert(captureVerbatimBody('', null) === null, 'no body → no verbatim record (never an empty claim)');
      assert(captureVerbatimBody(null, undefined) === null, 'null/undefined body → no verbatim record');
    }

    // ── 5. HTML-only reply: the verbatim copy is the HTML SOURCE ─────────────
    //
    // htmlToPlainText deletes `<blockquote…>` to end-of-input, so on an HTML-only
    // reply the quoted contract is destroyed BEFORE stripQuotedReply even runs.
    // Capturing the source is the only thing that keeps it.
    {
      const html =
        '<div>Yes, I agree to these terms.</div>' +
        `<blockquote><div>--- Agreement terms ---</div><div>${CONTRACT_CLAUSE}</div></blockquote>`;
      const decision = normalizeInboundEmail(
        emailMessage({ text: null, html }),
        {
          senderVerified: true,
          senderAuthenticated: true,
          senderAuthVerdict: { outcome: 'dmarc_pass', authservId: 'mx.google.com' },
        }
      );
      assert(decision.accepted, 'html-only reply is accepted');
      if (decision.accepted) {
        const n = decision.normalized;
        assert(n.raw_body === html, 'verbatim body is the HTML source, unconverted');
        assert(
          (n.raw_body ?? '').includes(CONTRACT_CLAUSE),
          'html-only: the blockquoted contract survives in the verbatim copy'
        );
        assert(n.raw_body_media_type === 'text/html', 'media type says this is markup, not prose');
        assert(
          !n.body.includes(CONTRACT_CLAUSE),
          'html-only: the classifier body still has the blockquote removed'
        );
        assert(n.body === 'Yes, I agree to these terms.', 'html-only: classifier body unchanged in shape');
      }
    }

    // ── 6. Which message it answers (evidence, never authorization) ──────────
    {
      assert(
        parentMessageId('<abc@mail.example.com>', '<old@x.test> <newer@x.test>') ===
          '<abc@mail.example.com>',
        'In-Reply-To wins when present'
      );
      assert(
        parentMessageId(null, '<oldest@x.test> <middle@x.test> <parent@x.test>') ===
          '<parent@x.test>',
        'References falls back to its LAST id (RFC 5322 orders oldest-first)'
      );
      assert(parentMessageId(null, null) === null, 'no headers → no parent claimed');
      assert(
        parentMessageId('bare-id@mail.example.com', null) === 'bare-id@mail.example.com',
        'a bracket-less single-token id is accepted'
      );
      assert(
        parentMessageId('On Monday he wrote to me at a@b.example about it', null) === null,
        'prose is not a message-id — no fragment is sliced out of a sentence'
      );

      const { normalized } = normalizeAccepted({
        inReplyTo: '<outbound-42@mail.example.com>',
      });
      assert(
        normalized.in_reply_to === '<outbound-42@mail.example.com>',
        'In-Reply-To reaches NormalizedInbound for later message-level attribution'
      );
    }

    // ── 7. The authentication verdict survives to the INSERT (Gmail path) ────
    //
    // End to end through pollGmailInbound: this is the transport where the
    // verdict can genuinely be YES, and it used to die in a console.warn.
    {
      const { sb, inserts } = sbStub();
      const result = await pollGmailInbound(sb, {
        fetchImpl: gmailNet([
          {
            id: 'g-accept',
            from: CREATOR,
            deliveredTo: INBOX,
            auth: GMAIL_DMARC_PASS,
            text: ACCEPTANCE,
            extraHeaders: [
              { name: 'In-Reply-To', value: '<outbound-42@mail.example.com>' },
              { name: 'References', value: '<older@mail.example.com>' },
            ],
          },
        ]),
      });
      assert(result.ingested === 1, 'gmail: the acceptance was ingested');

      const row = inboundInsert(inserts);
      assert(row !== null, 'gmail: an inbound_messages row was written');
      if (row) {
        assert(
          row.sender_authenticated === true,
          'gmail: sender_authenticated TRUE is persisted — the receiver vouched for the domain'
        );
        assert(
          row.sender_auth_outcome === 'dmarc_pass',
          'gmail: WHICH verdict is persisted (dmarc_pass), not just a boolean'
        );
        assert(
          row.sender_auth_authserv_id === 'mx.google.com',
          'gmail: WHICH receiver stamped it is persisted'
        );
        assert(
          row.sender_matched_lead === true,
          'gmail: "the From matched this lead\'s creator" is persisted separately from the auth verdict'
        );
        assert(
          row.campaign_influencer_id === CI_ID,
          'gmail: all three locks held, so the reply is attributed'
        );
        assert(
          String(row.raw_body ?? '').includes(CONTRACT_CLAUSE),
          'gmail: the quoted contract reached the insert'
        );
        assert(
          row.raw_body_sha256 === sha256Hex(String(row.raw_body ?? '')),
          'gmail: the persisted hash matches the persisted verbatim body'
        );
        assert(
          row.in_reply_to === '<outbound-42@mail.example.com>',
          'gmail: In-Reply-To reached the insert'
        );
        assert(
          row.body === 'Yes, I agree to these terms.',
          'gmail: the stored classifier body is still only the creator\'s words'
        );
        assert(
          !('received_at_server' in row),
          'the app NEVER sends received_at_server — it is the database clock, or it proves nothing'
        );
      }
    }

    // ── 8. A FAILED verdict is durable too ──────────────────────────────────
    //
    // The old system's only footprint of "we could not prove the sender" was a
    // NULL campaign_influencer_id, identical to "this reply carried no tag".
    {
      const { sb, inserts } = sbStub();
      await pollGmailInbound(sb, {
        fetchImpl: gmailNet([
          {
            id: 'g-unproven',
            from: CREATOR,
            deliveredTo: INBOX,
            // A verdict from a receiver nobody told us to trust.
            auth: 'mx.attacker.example; dmarc=pass header.from=example.com',
            text: ACCEPTANCE,
          },
        ]),
      });
      const row = inboundInsert(inserts);
      assert(row !== null, 'untrusted-verdict reply is still ingested, not dropped');
      if (row) {
        assert(row.sender_authenticated === false, 'unproven sender is recorded as false, not NULL');
        assert(
          row.sender_auth_outcome === 'untrusted_authserv',
          'the REASON the verdict failed is recorded (untrusted authserv-id)'
        );
        assert(
          row.sender_auth_authserv_id === 'mx.attacker.example',
          'the authserv-id that made the untrusted claim is recorded'
        );
        assert(
          row.sender_matched_lead === true,
          '"right address, unproven sender" is now distinguishable from "wrong address"'
        );
        assert(
          row.campaign_influencer_id === null,
          'an unauthenticated reply is still queued UNATTRIBUTED — it cannot close a deal'
        );
      }
    }

    // ── 9. Schema skew degrades to the old row, never to a lost reply ────────
    //
    // Code can ship before 052 is applied. Until it is, an
    // insert naming the new columns is rejected WHOLESALE; a creator's reply
    // must not 503 for that.
    {
      const { sb, inserts } = sbStub({
        failInsertWhen: (row) => 'raw_body' in row,
      });
      const normalized: NormalizedInbound = {
        channel: 'email',
        external_id: 'gmail:skew-1',
        from_identity: CREATOR,
        body: 'Yes, I agree to these terms.',
        campaign_influencer_id: null,
        raw_body: ACCEPTANCE,
        raw_body_sha256: sha256Hex(ACCEPTANCE),
        raw_body_media_type: 'text/plain',
        raw_body_truncated: false,
        raw_body_chars: ACCEPTANCE.length,
        sender_authenticated: true,
        sender_auth_outcome: 'dmarc_pass',
        sender_auth_authserv_id: 'mx.google.com',
        sender_matched_lead: true,
      };
      const res = await ingestInboundReply(normalized, sb);
      assert(res.inbound_message_id !== null, 'pre-052 schema: the reply is STILL stored');
      assert(res.deduped === false, 'pre-052 schema: the retry is not mistaken for a dedupe');

      const first = inboundInsert(inserts, 0);
      const second = inboundInsert(inserts, 1);
      assert(first !== null && 'raw_body' in first, 'pre-052: the evidence row was attempted first');
      assert(second !== null, 'pre-052: a second, narrower insert was attempted');
      assert(
        second !== null && !('raw_body' in second),
        'pre-052: the fallback row names no evidence column'
      );
      assert(
        second !== null && second.body === 'Yes, I agree to these terms.',
        'pre-052: the creator\'s words are preserved in the fallback row'
      );
    }

    // ── 10. A real failure still fails ──────────────────────────────────────
    //
    // The fallback is narrow on purpose: only a MISSING COLUMN is retried. A
    // permission error or a dead connection must still surface, or a reply is
    // lost silently.
    {
      const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
      const sb = {
        from: () => {
          const b: Record<string, unknown> = {
            insert(row: Record<string, unknown>) {
              inserts.push({ table: 'inbound_messages', row });
              return b;
            },
            select: () => b,
            eq: () => b,
            maybeSingle: async () => ({ data: null, error: null }),
            single: async () => ({
              data: null,
              error: { code: '42501', message: 'permission denied for table inbound_messages' },
            }),
          };
          return b;
        },
      } as unknown as SupabaseClient;

      let threw: string | null = null;
      try {
        await ingestInboundReply(
          { channel: 'email', external_id: 'x', from_identity: CREATOR, body: 'yes', raw_body: 'yes' },
          sb
        );
      } catch (e) {
        threw = (e as Error).message;
      }
      assert(
        threw !== null && /permission denied/.test(threw),
        'a non-schema insert failure still throws (the webhook 503s and Resend retries)'
      );
      assert(inserts.length === 1, 'a permission error is NOT retried as a schema skew');
    }
  } finally {
    if (savedMode === undefined) delete process.env.INBOUND_SENDER_AUTH_MODE;
    else process.env.INBOUND_SENDER_AUTH_MODE = savedMode;
    if (savedIds === undefined) delete process.env.INBOUND_TRUSTED_AUTHSERV_IDS;
    else process.env.INBOUND_TRUSTED_AUTHSERV_IDS = savedIds;
    delete process.env.GMAIL_ACCESS_TOKEN;
    resetGmailTokenCache();
  }

  console.log(`inbound-acceptance-evidence test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
