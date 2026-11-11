// tests/gmail-inbound.test.ts
//
// Unit tests for src/lib/channels/gmail-inbound.ts auth paths. Hermetic: the
// injectable GmailFetch seam mocks BOTH the Google token exchange and the
// Gmail API — no real network. Covers: token-exchange failure degrading to
// { skipped:'error' } (never throws), the exchanged access token being used
// on Gmail API calls, the TTL cache suppressing re-exchange within a poll
// cycle, static-token backward compat, refresh-path preference, partial
// config legibility, and 401 cache invalidation.
//
// Run: npx tsx tests/gmail-inbound.test.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  pollGmailInbound,
  resetGmailTokenCache,
  correlateCampaignInfluencer,
  type GmailFetch,
} from '../src/lib/channels/gmail-inbound';
import { buildCorrelatedReplyTo } from '../src/lib/channels/reply-correlation';
import { buildOutboundEnvelope } from '../src/lib/channels/outbound-envelope';
import { hasSubjectTag } from '../src/lib/channels/subject-tag';

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

// ── Env harness ──────────────────────────────────────────────────────────────
const GMAIL_ENV = [
  'GMAIL_ACCESS_TOKEN',
  'GMAIL_REFRESH_TOKEN',
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
  'GMAIL_USER',
  'GMAIL_QUERY',
  'GMAIL_MAX_MESSAGES',
] as const;

function resetCase() {
  for (const k of GMAIL_ENV) delete process.env[k];
  resetGmailTokenCache();
}

function setRefreshEnv() {
  process.env.GMAIL_REFRESH_TOKEN = 'test-refresh-token';
  process.env.GMAIL_CLIENT_ID = 'test-client-id';
  process.env.GMAIL_CLIENT_SECRET = 'test-client-secret';
}

// ── Fetch seam harness ───────────────────────────────────────────────────────
// List responses are always empty ({messages:[]}) so ingestInboundReply is
// never reached — the supabase client can be a bare stub.
const sb = {} as unknown as SupabaseClient;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface SeenCall {
  url: string;
  auth: string | null;
  body: string | null;
}

interface MockNet {
  fetchImpl: GmailFetch;
  calls: SeenCall[];
  tokenCalls: () => SeenCall[];
  gmailCalls: () => SeenCall[];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Build a GmailFetch mock: `onToken` answers the exchange, Gmail lists are empty. */
function makeNet(onToken: (call: SeenCall) => Response | Promise<Response>): MockNet {
  const calls: SeenCall[] = [];
  const fetchImpl: GmailFetch = async (url, init) => {
    const call: SeenCall = {
      url,
      auth: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    if (url === TOKEN_URL) return onToken(call);
    return jsonResponse({ messages: [] });
  };
  return {
    fetchImpl,
    calls,
    tokenCalls: () => calls.filter((c) => c.url === TOKEN_URL),
    gmailCalls: () => calls.filter((c) => c.url !== TOKEN_URL),
  };
}

// ── Message-level harness (cases 10-15) ─────────────────────────────────────
// Builds real-shaped Gmail `format=full` payloads and serves them over the
// same injectable fetch seam, so the gate + correlation + ingest path is
// exercised end to end with zero network.

interface FakeMessage {
  id: string;
  labelIds?: string[];
  subject: string;
  to: string;
  /** Envelope recipient, when it differs from the To header. */
  deliveredTo?: string;
  from: string;
  replyTo?: string;
  body: string;
  /**
   * Headers the message ARRIVED carrying — i.e. attacker-controlled. They are
   * emitted BELOW the ones Gmail's receiving MX prepends, which is exactly
   * where a real forged duplicate lands.
   */
  carriedHeaders?: Array<{ name: string; value: string }>;
  /**
   * Gmail's own Authentication-Results. Defaults to an aligned DMARC pass for
   * the From domain, because a real message delivered by Gmail ALWAYS carries
   * one — omitting it made every fixture an unauthenticated message, which is
   * not what these cases are about. Set null to model a message with no verdict.
   */
  authResults?: string | null;
}

/** An aligned pass, in the shape mx.google.com actually writes. */
function gmailAuthPass(from: string): string {
  const at = from.lastIndexOf('@');
  const domain = (at === -1 ? from : from.slice(at + 1)).replace(/>$/, '').trim().toLowerCase();
  return `mx.google.com; dkim=pass header.d=${domain}; spf=pass smtp.mailfrom=${domain}; dmarc=pass header.from=${domain}`;
}

function gmailMessage(m: FakeMessage): FakeMessage {
  return m;
}

/** Encode a fake message into the Gmail `format=full` JSON shape. */
function toGmailPayload(m: FakeMessage): unknown {
  const auth = m.authResults === undefined ? gmailAuthPass(m.from) : m.authResults;
  const headers = [
    // ── Written by Gmail's receiving MX, PREPENDED above everything the
    // message arrived with. `header()` uses `.find()`, so these win any
    // duplicate below them — that ordering is the whole reason this transport
    // can have a trustworthy verdict where Resend cannot.
    //
    // Delivered-To carries the address mail was actually delivered to, plus tag
    // included; it is the ONLY value correlation trusts, because `To` is
    // sender-controlled. Fixtures emit both, exactly as a real message does.
    { name: 'Delivered-To', value: m.deliveredTo ?? m.to },
    ...(auth === null ? [] : [{ name: 'Authentication-Results', value: auth }]),

    // ── Written by the SENDER.
    { name: 'Subject', value: m.subject },
    { name: 'To', value: m.to },
    { name: 'From', value: m.from },
    { name: 'Date', value: 'Mon, 15 Sep 2026 09:00:00 -0500' },
    ...(m.replyTo ? [{ name: 'Reply-To', value: m.replyTo }] : []),
    ...(m.carriedHeaders ?? []),
  ];
  return {
    id: m.id,
    threadId: `t-${m.id}`,
    labelIds: m.labelIds ?? ['INBOX'],
    snippet: m.body.slice(0, 40),
    payload: {
      headers,
      mimeType: 'text/plain',
      body: { data: Buffer.from(m.body, 'utf8').toString('base64url') },
    },
  };
}

/**
 * Gmail mock that serves a message corpus, optionally across pages.
 * `pages` is a list of id-arrays; page N+1 is only reachable via the
 * nextPageToken returned with page N.
 */
function makeGmailNet(opts: { messages: FakeMessage[]; pages?: string[][] }): MockNet {
  const byId = new Map(opts.messages.map((m) => [m.id, m]));
  const pages = opts.pages ?? [opts.messages.map((m) => m.id)];
  const calls: SeenCall[] = [];
  const fetchImpl: GmailFetch = async (url, init) => {
    calls.push({
      url,
      auth: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    if (url === TOKEN_URL) return jsonResponse({ access_token: 'tok', expires_in: 3600 });
    if (url.includes('/messages?')) {
      const token = new URL(url).searchParams.get('pageToken');
      const index = token ? Number(token.replace('tok-', '')) : 0;
      const ids = pages[index] ?? [];
      const hasNext = index + 1 < pages.length;
      return jsonResponse({
        messages: ids.map((id) => ({ id })),
        ...(hasNext ? { nextPageToken: `tok-${index + 1}` } : {}),
      });
    }
    const id = decodeURIComponent(url.split('/messages/')[1]?.split('?')[0] ?? '');
    const m = byId.get(id);
    if (!m) return jsonResponse({ error: 'not found' }, 404);
    return jsonResponse(toGmailPayload(m));
  };
  return {
    fetchImpl,
    calls,
    tokenCalls: () => calls.filter((c) => c.url === TOKEN_URL),
    gmailCalls: () => calls.filter((c) => c.url !== TOKEN_URL),
  };
}

/**
 * Minimal chainable Supabase stub. Records every .insert() payload so a test
 * can assert what ingestInboundReply actually wrote.
 *
 * Reads are table-aware because attribution now needs real answers:
 * `inbound_messages` resolves to "no existing row" so nothing dedupes, while
 * `campaign_influencers` / `influencers` resolve the creator behind a lead so
 * senderMatchesLeadCreator can verify the From header. `creatorEmail` is the
 * address the stubbed creator is known by — a fixture whose From differs from
 * it is, correctly, treated as an unverified sender.
 */
function makeSbStub(
  opts: {
    creatorEmail?: string;
    /**
     * When set, the lead belongs to a campaign under a firm with this
     * testing_mode / test_recipient_email. Absent → the lead has no campaign,
     * so the testing-mode check can never match (every pre-existing case).
     */
    testingFirm?: { testingMode: boolean; testRecipient: string };
  } = {},
): {
  sb: SupabaseClient;
  inserts: { table: string; row: Record<string, unknown> }[];
} {
  const creatorEmail = opts.creatorEmail ?? 'rowan@example.com';
  const tf = opts.testingFirm;
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const builder = (table: string) => {
    const b = {
      insert(row: Record<string, unknown>) {
        inserts.push({ table, row });
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
          return {
            data: {
              influencer_id: 'inf-1',
              last_response_at: null,
              ...(tf ? { campaign_id: 'camp-1' } : {}),
            },
            error: null,
          };
        }
        if (table === 'influencers') return { data: { contact_email: creatorEmail }, error: null };
        if (tf && table === 'campaigns') return { data: { firm_id: 'firm-tm' }, error: null };
        if (tf && table === 'firms') {
          return {
            data: { testing_mode: tf.testingMode, test_recipient_email: tf.testRecipient },
            error: null,
          };
        }
        return { data: null, error: null };
      },
      single: async () => ({ data: { id: `${table}-row` }, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return b;
  };
  return { sb: { from: (t: string) => builder(t) } as unknown as SupabaseClient, inserts };
}

async function main() {
  // ── 1. No Gmail env at all → gmail_not_configured, zero network ──
  {
    resetCase();
    const net = makeNet(() => jsonResponse({}, 500));
    const r = await pollGmailInbound(sb, { fetchImpl: net.fetchImpl });
    assert(r.skipped === 'gmail_not_configured', 'case1: unconfigured → skipped gmail_not_configured');
    assert(net.calls.length === 0, 'case1: no network calls when unconfigured');
  }

  // ── 2a. Token exchange HTTP failure → skipped error, NEVER throws ──
  {
    resetCase();
    setRefreshEnv();
    const net = makeNet(() => jsonResponse({ error: 'invalid_grant' }, 400));
    const r = await pollGmailInbound(sb, { fetchImpl: net.fetchImpl });
    assert(r.skipped === 'error', 'case2a: exchange HTTP 400 → skipped error (no throw)');
    assert(/token exchange HTTP 400/.test(r.error ?? ''), 'case2a: error names the token-exchange failure');
    assert(net.gmailCalls().length === 0, 'case2a: no Gmail API call after failed exchange');
  }

  // ── 2b. Token exchange network throw → skipped error, NEVER throws ──
  {
    resetCase();
    setRefreshEnv();
    const net = makeNet(() => {
      throw new Error('ECONNRESET');
    });
    const r = await pollGmailInbound(sb, { fetchImpl: net.fetchImpl });
    assert(r.skipped === 'error', 'case2b: exchange network throw → skipped error (no throw)');
    assert(/ECONNRESET/.test(r.error ?? ''), 'case2b: error carries the underlying cause');
  }

  // ── 2c. Exchange 200 but no access_token in body → legible skipped error ──
  {
    resetCase();
    setRefreshEnv();
    const net = makeNet(() => jsonResponse({ token_type: 'Bearer' }));
    const r = await pollGmailInbound(sb, { fetchImpl: net.fetchImpl });
    assert(r.skipped === 'error' && /no access_token/.test(r.error ?? ''), 'case2c: empty exchange body → legible error');
  }

  // ── 3. Successful exchange → exchanged token used on the Gmail API call ──
  {
    resetCase();
    setRefreshEnv();
    const net = makeNet(() => jsonResponse({ access_token: 'exchanged-tok-1', expires_in: 3600 }));
    const r = await pollGmailInbound(sb, { fetchImpl: net.fetchImpl });
    assert(r.skipped === undefined && r.fetched === 0, 'case3: poll succeeds with empty inbox');
    assert(net.tokenCalls().length === 1, 'case3: exactly one token exchange');
    const body = net.tokenCalls()[0].body ?? '';
    const params = new URLSearchParams(body);
    assert(params.get('grant_type') === 'refresh_token', 'case3: exchange uses grant_type=refresh_token');
    assert(params.get('refresh_token') === 'test-refresh-token', 'case3: exchange sends the env refresh token');
    assert(params.get('client_id') === 'test-client-id', 'case3: exchange sends the env client id');
    assert(net.gmailCalls().length === 1, 'case3: one Gmail list call');
    assert(net.gmailCalls()[0].auth === 'Bearer exchanged-tok-1', 'case3: Gmail call carries the EXCHANGED token');
  }

  // ── 4. TTL cache: second poll within TTL does NOT re-exchange ──
  {
    resetCase();
    setRefreshEnv();
    const net = makeNet(() => jsonResponse({ access_token: 'exchanged-tok-2', expires_in: 3600 }));
    const r1 = await pollGmailInbound(sb, { fetchImpl: net.fetchImpl });
    const r2 = await pollGmailInbound(sb, { fetchImpl: net.fetchImpl });
    assert(r1.skipped === undefined && r2.skipped === undefined, 'case4: both polls succeed');
    assert(net.tokenCalls().length === 1, 'case4: cache hit — token exchanged ONCE across two polls');
    assert(net.gmailCalls().length === 2, 'case4: both polls hit the Gmail API');
    assert(
      net.gmailCalls().every((c) => c.auth === 'Bearer exchanged-tok-2'),
      'case4: both Gmail calls reuse the cached token',
    );
  }

  // ── 5. Backward compat: static GMAIL_ACCESS_TOKEN, no refresh vars ──
  {
    resetCase();
    process.env.GMAIL_ACCESS_TOKEN = 'static-tok';
    const net = makeNet(() => jsonResponse({ access_token: 'SHOULD-NOT-EXCHANGE' }));
    const r = await pollGmailInbound(sb, { fetchImpl: net.fetchImpl });
    assert(r.skipped === undefined && r.fetched === 0, 'case5: static-token poll succeeds');
    assert(net.tokenCalls().length === 0, 'case5: NO token exchange on the static path');
    assert(net.gmailCalls()[0]?.auth === 'Bearer static-tok', 'case5: Gmail call carries the static token');
  }

  // ── 6. Refresh path PREFERRED when both static + refresh vars present ──
  {
    resetCase();
    setRefreshEnv();
    process.env.GMAIL_ACCESS_TOKEN = 'stale-static-tok';
    const net = makeNet(() => jsonResponse({ access_token: 'fresh-tok', expires_in: 3600 }));
    const r = await pollGmailInbound(sb, { fetchImpl: net.fetchImpl });
    assert(r.skipped === undefined, 'case6: poll succeeds');
    assert(net.tokenCalls().length === 1, 'case6: refresh path taken despite static token present');
    assert(net.gmailCalls()[0]?.auth === 'Bearer fresh-tok', 'case6: fresh token wins over the stale static one');
  }

  // ── 7. Partial refresh config (no static fallback) → legible error ──
  {
    resetCase();
    process.env.GMAIL_REFRESH_TOKEN = 'test-refresh-token';
    const net = makeNet(() => jsonResponse({}));
    const r = await pollGmailInbound(sb, { fetchImpl: net.fetchImpl });
    assert(r.skipped === 'error', 'case7: partial refresh config → skipped error, not a silent no-op');
    assert(
      /GMAIL_CLIENT_ID/.test(r.error ?? '') && /GMAIL_CLIENT_SECRET/.test(r.error ?? ''),
      'case7: error names the missing env vars',
    );
    assert(net.calls.length === 0, 'case7: no network attempted on misconfiguration');
  }

  // ── 8. Gmail 401 invalidates the cache → next poll re-exchanges ──
  {
    resetCase();
    setRefreshEnv();
    let gmailStatus = 401;
    const calls: SeenCall[] = [];
    const fetchImpl: GmailFetch = async (url, init) => {
      calls.push({
        url,
        auth: new Headers(init?.headers).get('authorization'),
        body: typeof init?.body === 'string' ? init.body : null,
      });
      if (url === TOKEN_URL) return jsonResponse({ access_token: 'tok-401', expires_in: 3600 });
      return gmailStatus === 401 ? jsonResponse({}, 401) : jsonResponse({ messages: [] });
    };
    const r1 = await pollGmailInbound(sb, { fetchImpl });
    assert(r1.skipped === 'error' && /gmail list HTTP 401/.test(r1.error ?? ''), 'case8: stale token 401 → legible skipped error');
    gmailStatus = 200;
    const r2 = await pollGmailInbound(sb, { fetchImpl });
    assert(r2.skipped === undefined, 'case8: next poll recovers');
    assert(calls.filter((c) => c.url === TOKEN_URL).length === 2, 'case8: 401 dropped the cache — token re-exchanged');
  }

  // ── 9. Reply correlation: `+lead-<ci_id>@` plus-address ↔ buildCorrelatedReplyTo ──
  {
    const CI = '3f9c2a1e-7b4d-4e0a-9c66-2d8f5b1a0c3e';
    const H = (name: string, value: string) => ({ name, value });

    // The round trip: what sendOutreach emits is what the poller correlates.
    const emitted = buildCorrelatedReplyTo('operator@operator.example', CI);
    assert(emitted === `operator+lead-${CI}@operator.example`, 'case9: reply-to derives local+lead-<ci>@domain');
    assert(
      correlateCampaignInfluencer([H('Delivered-To', `Owen <${emitted}>`)]) === CI,
      'case9: the envelope Delivered-To header round-trips to the ci id',
    );

    // Base already plus-addressed → tag replaces, never stacks.
    assert(
      buildCorrelatedReplyTo('operator+old@operator.example', CI) === `operator+lead-${CI}@operator.example`,
      'case9: existing +tag on base is stripped',
    );
    // Malformed / missing base → null, never a guessed address.
    assert(buildCorrelatedReplyTo(null, CI) === null, 'case9: null base → null');
    assert(buildCorrelatedReplyTo('not-an-email', CI) === null, 'case9: malformed base → null');

    // Legacy alias still matches, but only on an envelope header. (It used to
    // be asserted through X-Original-To; that header is no longer read on this
    // transport — see case9-sec-H3 below — so the same claim is made through
    // Delivered-To, which Gmail actually writes.)
    assert(
      correlateCampaignInfluencer([H('Delivered-To', `outreach+${CI}@a.co`)]) === CI,
      'case9: legacy outreach+ alias still matches on the envelope',
    );

    // ── SEC (H3): X-Original-To is a POSTFIX header. Gmail never stamps it. ──
    //
    // So on this transport the only X-Original-To that can exist is one the
    // MESSAGE carried — i.e. one the sender wrote — and correlateFromEnvelope
    // scans every value it is handed. That made it a free self-attribution
    // channel for anyone holding a leaked ci id.
    assert(
      correlateCampaignInfluencer([H('X-Original-To', `x+lead-${CI}@a.co`)]) === null,
      'case9-sec-H3: a forged X-Original-To must NOT correlate — Gmail does not write it',
    );
    assert(
      correlateCampaignInfluencer([H('X-Original-To', `outreach+${CI}@a.co`)]) === null,
      'case9-sec-H3: ...on the legacy alias either',
    );
    // Delivered-To survives the same trick ONLY because Gmail prepends its own
    // copy and header() takes .find() — the first match. A duplicate the
    // attacker adds sorts below it and is never read.
    assert(
      correlateCampaignInfluencer([
        H('Delivered-To', 'operator@operator.example'),
        H('Delivered-To', `x+lead-${CI}@a.co`),
      ]) === null,
      'case9-sec-H3: a DUPLICATE Delivered-To below Gmail\'s own is never read',
    );

    // ── SEC: sender-controlled headers must NOT correlate ──────────────────
    //
    // These four assertions previously asserted the OPPOSITE. Correlating on
    // them is the thread-hijack: the ci id rides in the Reply-To of every
    // outreach email, so it leaks via forwards, bounces and auto-replies, and
    // anyone holding one could self-attribute a message to a creator's lead.
    assert(
      correlateCampaignInfluencer([H('Reply-To', `x+lead-${CI}@a.co`)]) === null,
      'case9-sec: a sender-supplied Reply-To must NOT correlate',
    );
    assert(
      correlateCampaignInfluencer([H('Cc', `x+lead-${CI}@a.co`)]) === null,
      'case9-sec: a sender-supplied Cc must NOT correlate (thread hijack)',
    );
    assert(
      correlateCampaignInfluencer([H('To', `x+lead-${CI}@a.co`)]) === null,
      'case9-sec: a sender-supplied To must NOT correlate',
    );
    assert(
      correlateCampaignInfluencer([H('Subject', `[Creator Campaigns] ${CI} hello`)]) === null,
      'case9-sec: a subject token must NOT correlate',
    );
    // No signal → null (unmatched, counted, never guessed).
    assert(
      correlateCampaignInfluencer([H('Delivered-To', 'operator@operator.example')]) === null,
      'case9: plain reply with no token stays uncorrelated',
    );
  }

  // ── 10. LIVE MODE end-to-end: a reply with NO subject tag still correlates ──
  //
  // THE REGRESSION THAT MATTERS. resend.ts only prefixes `[Creator Campaigns]` when
  // firms.testing_mode is true, and normalizeGmailMessage used to hard-drop
  // every message whose subject lacked that tag — so flipping testing mode off
  // silenced the entire reply loop. The plus-address that sendOutreach stamps
  // on EVERY send (both modes) is the correlation anchor; the subject tag is
  // only a narrowing hint.
  {
    resetCase();
    setRefreshEnv();
    const CI = '3f9c2a1e-7b4d-4e0a-9c66-2d8f5b1a0c3e';

    // What a LIVE-mode send puts on the wire (same helper resend.ts uses).
    const env = buildOutboundEnvelope({
      testingMode: false,
      subject: 'Collab on "Sample Single"',
      campaignInfluencerId: CI,
      negotiationInboxEmail: 'replies@examplerecords.example',
      fromEmail: 'hello@examplerecords.example',
    });
    assert(!hasSubjectTag(env.subject), 'case10: live-mode subject carries NO [Creator Campaigns] tag');
    assert(env.replyTo === `replies+lead-${CI}@examplerecords.example`, 'case10: live-mode send is still correlated');

    // The creator's reply: To = our correlated Reply-To, subject untagged.
    const reply = gmailMessage({
      id: 'live-reply-1',
      labelIds: ['INBOX', 'UNREAD'],
      subject: `Re: ${env.subject}`,
      to: `Example Records Replies <${env.replyTo}>`,
      from: 'Rowan <rowan@example.com>',
      body: 'Yes — interested. What is the budget?',
    });

    const store = makeSbStub();
    const net = makeGmailNet({ messages: [reply] });
    const r = await pollGmailInbound(store.sb, { fetchImpl: net.fetchImpl });

    assert(r.skipped === undefined, 'case10: live-mode poll is not skipped');
    assert(r.fetched === 1, 'case10: the untagged live reply IS fetched');
    assert(r.ingested === 1, 'case10: the untagged live reply IS ingested (was: silently dropped)');
    assert(r.unmatched === 0, 'case10: the live reply is correlated, not unmatched');
    const row = store.inserts.find((i) => i.table === 'inbound_messages')?.row;
    assert(row != null, 'case10: an inbound_messages row was written');
    assert(row?.campaign_influencer_id === CI, 'case10: the row carries the campaign_influencer_id from the plus-address');
    assert(row?.external_id === 'gmail:live-reply-1', 'case10: external_id is the gmail message id');
    assert(
      typeof row?.body === 'string' && (row.body as string).includes('What is the budget?'),
      'case10: the reply body survives the round trip',
    );

    // ── 10b. H3 END TO END: a forged X-Original-To must not attribute ───────
    //
    // The attacker knows a leaked ci id and writes it into X-Original-To.
    // Gmail does not stamp that header, so before the fix theirs was the ONLY
    // one present and correlateFromEnvelope read it.
    {
      resetCase();
      setRefreshEnv();
      const forged = gmailMessage({
        id: 'forged-xot-1',
        labelIds: ['INBOX', 'UNREAD'],
        subject: 'hello',
        to: 'replies@examplerecords.example',
        deliveredTo: 'replies@examplerecords.example', // no plus tag: no real correlation
        from: 'Attacker <attacker@evil.example>',
        carriedHeaders: [{ name: 'X-Original-To', value: `replies+lead-${CI}@examplerecords.example` }],
        body: 'yes, $2,000 works, send the contract',
      });
      const store2 = makeSbStub();
      const net2 = makeGmailNet({ messages: [forged] });
      const r2 = await pollGmailInbound(store2.sb, { fetchImpl: net2.fetchImpl });
      const forgedRow = store2.inserts.find((i) => i.table === 'inbound_messages')?.row;
      assert(
        r2.ingested === 0 && forgedRow == null,
        'case10-sec-H3: a forged X-Original-To does not even admit the message',
      );
      assert(
        !store2.inserts.some((i) => i.table === 'outreach_messages'),
        'case10-sec-H3: ...so no inbound row is written in anyone\'s name',
      );
    }

    // ── 10c. H4 END TO END: the real creator, but no verdict → held ─────────
    //
    // Same message as case10, same correlated Delivered-To, same known creator.
    // The ONLY difference is that Gmail stamped no Authentication-Results. It
    // must still be ingested and visible, and must NOT advance the lead.
    {
      resetCase();
      setRefreshEnv();
      const unauth = gmailMessage({
        id: 'unauth-reply-1',
        labelIds: ['INBOX', 'UNREAD'],
        subject: `Re: ${env.subject}`,
        to: `Example Records Replies <${env.replyTo}>`,
        from: 'Rowan <rowan@example.com>',
        body: 'Yes — $2,000 works, send the contract.',
        authResults: null,
      });
      const store3 = makeSbStub();
      const net3 = makeGmailNet({ messages: [unauth] });
      const r3 = await pollGmailInbound(store3.sb, { fetchImpl: net3.fetchImpl });
      const heldRow = store3.inserts.find((i) => i.table === 'inbound_messages')?.row;
      assert(r3.ingested === 1 && heldRow != null, 'case10-H4: an unauthenticated reply is still INGESTED');
      assert(
        heldRow?.campaign_influencer_id === null,
        'case10-sec-H4: ...but is NOT attributed, so the negotiator never sees it',
      );
      assert(
        !store3.inserts.some((i) => i.table === 'outreach_messages'),
        'case10-sec-H4: ...and no inbound outreach_messages row is written in the creator\'s name',
      );
      assert(
        typeof heldRow?.body === 'string' && (heldRow.body as string).includes('$2,000'),
        'case10-H4: the body is preserved verbatim for the human who reviews it',
      );
    }

    // ── 10d. H4: a verdict the ATTACKER wrote is not a verdict ──────────────
    {
      resetCase();
      setRefreshEnv();
      const selfSigned = gmailMessage({
        id: 'self-signed-1',
        labelIds: ['INBOX', 'UNREAD'],
        subject: `Re: ${env.subject}`,
        to: `Example Records Replies <${env.replyTo}>`,
        from: 'Rowan <rowan@example.com>',
        body: 'Yes — $2,000 works, send the contract.',
        // Gmail stamped nothing; the message arrived carrying its own "pass".
        authResults: null,
        carriedHeaders: [
          {
            name: 'Authentication-Results',
            value: 'evil.example; dmarc=pass header.from=example.com; dkim=pass header.d=example.com',
          },
        ],
      });
      const store4 = makeSbStub();
      const net4 = makeGmailNet({ messages: [selfSigned] });
      await pollGmailInbound(store4.sb, { fetchImpl: net4.fetchImpl });
      const row4 = store4.inserts.find((i) => i.table === 'inbound_messages')?.row;
      assert(
        row4 != null && row4.campaign_influencer_id === null,
        'case10-sec-H4: a self-signed Authentication-Results from an untrusted authserv-id does NOT attribute',
      );
    }

    // ── 10e. The control: Gmail's own aligned verdict still attributes ──────
    //
    // Without this, every assertion above would pass on a change that simply
    // refused everything.
    {
      resetCase();
      setRefreshEnv();
      const good = gmailMessage({
        id: 'authed-reply-1',
        labelIds: ['INBOX', 'UNREAD'],
        subject: `Re: ${env.subject}`,
        to: `Example Records Replies <${env.replyTo}>`,
        from: 'Rowan <rowan@example.com>',
        body: 'Yes — $2,000 works, send the contract.',
        // Gmail's own stamp, plus a forged duplicate BELOW it. The real one wins.
        carriedHeaders: [
          { name: 'Authentication-Results', value: 'evil.example; dmarc=fail' },
        ],
      });
      const store5 = makeSbStub();
      const net5 = makeGmailNet({ messages: [good] });
      await pollGmailInbound(store5.sb, { fetchImpl: net5.fetchImpl });
      const row5 = store5.inserts.find((i) => i.table === 'inbound_messages')?.row;
      assert(
        row5?.campaign_influencer_id === CI,
        'case10-H4: an authenticated creator reply IS still attributed (the gate is not a blanket refusal)',
      );
    }
  }

  // ── 11. The gate stays tight: no tag AND no correlation → never ingested ──
  {
    resetCase();
    setRefreshEnv();
    const stray = gmailMessage({
      id: 'stray-1',
      labelIds: ['INBOX'],
      subject: 'Your invoice is due',
      to: 'replies@examplerecords.example',
      from: 'billing@vendor.example',
      body: 'Please pay.',
    });
    const store = makeSbStub();
    const net = makeGmailNet({ messages: [stray] });
    const r = await pollGmailInbound(store.sb, { fetchImpl: net.fetchImpl });
    assert(r.fetched === 1, 'case11: stray mail is fetched by the widened query');
    assert(r.ingested === 0, 'case11: stray mail with no tag and no correlation is NOT ingested');
    assert(r.ignored === 1, 'case11: stray mail is counted as ignored, not silently vanished');
    assert(store.inserts.length === 0, 'case11: no DB write for stray mail');
  }

  // ── 12. Self-echo guard: our OWN outbound copy is never ingested ─────────
  // The widened query makes this reachable: our sent copy carries BOTH the
  // `[Creator Campaigns]` tag and the `+lead-` Reply-To, so the content gate alone
  // would happily ingest it as a "reply" from the creator.
  {
    resetCase();
    setRefreshEnv();
    const CI = '3f9c2a1e-7b4d-4e0a-9c66-2d8f5b1a0c3e';
    const ownSent = gmailMessage({
      id: 'sent-echo-1',
      labelIds: ['SENT'],
      subject: '[Creator Campaigns] Collab on "Sample Single"',
      to: 'rowan@example.com',
      from: 'Example Records <hello@examplerecords.example>',
      replyTo: `replies+lead-${CI}@examplerecords.example`,
      body: 'Hi Rowan, ...',
    });
    const draft = gmailMessage({
      id: 'draft-echo-1',
      labelIds: ['DRAFT'],
      subject: '[Creator Campaigns] Collab',
      to: `replies+lead-${CI}@examplerecords.example`,
      from: 'Example Records <hello@examplerecords.example>',
      body: 'unsent',
    });
    const store = makeSbStub();
    const net = makeGmailNet({ messages: [ownSent, draft] });
    const r = await pollGmailInbound(store.sb, { fetchImpl: net.fetchImpl });
    assert(r.ingested === 0, 'case12: SENT/DRAFT copies of our own outbound are never ingested');
    assert(r.ignored === 2, 'case12: both self-echoes are counted as ignored');
    assert(store.inserts.length === 0, 'case12: no DB write for our own outbound');
  }

  // ── 13. The default query must actually fetch live-mode replies ─────────
  {
    resetCase();
    setRefreshEnv();
    const store = makeSbStub();
    const net = makeGmailNet({ messages: [] });
    await pollGmailInbound(store.sb, { fetchImpl: net.fetchImpl });
    const listUrl = net.gmailCalls().find((c) => c.url.includes('/messages?'))?.url ?? '';
    const q = new URL(listUrl).searchParams.get('q') ?? '';
    assert(
      !/subject:/i.test(q),
      'case13: default query does NOT hard-filter on the subject tag (live replies carry none)',
    );
    assert(/newer_than:/.test(q), 'case13: default query keeps a recency bound');
    assert(/-in:sent/.test(q), 'case13: default query excludes our own sent copies');

    // Ops override still wins verbatim.
    resetCase();
    setRefreshEnv();
    process.env.GMAIL_QUERY = 'label:creator-campaigns newer_than:2d';
    const net2 = makeGmailNet({ messages: [] });
    await pollGmailInbound(makeSbStub().sb, { fetchImpl: net2.fetchImpl });
    const q2 = new URL(net2.gmailCalls().find((c) => c.url.includes('/messages?'))!.url).searchParams.get('q');
    assert(q2 === 'label:creator-campaigns newer_than:2d', 'case13: GMAIL_QUERY override is used verbatim');
  }

  // ── 14. Pagination + an explicit, reported bound ─────────────────────────
  {
    resetCase();
    setRefreshEnv();
    const CI = '3f9c2a1e-7b4d-4e0a-9c66-2d8f5b1a0c3e';
    const msgs = [1, 2, 3].map((n) =>
      gmailMessage({
        id: `page-${n}`,
        labelIds: ['INBOX'],
        subject: 'Re: Collab',
        to: `replies+lead-${CI}@examplerecords.example`,
        from: `c${n}@example.com`,
        body: `reply ${n}`,
      }),
    );
    // Two pages: [page-1, page-2] + nextPageToken, then [page-3].
    const store = makeSbStub();
    const net = makeGmailNet({ messages: msgs, pages: [['page-1', 'page-2'], ['page-3']] });
    const r = await pollGmailInbound(store.sb, { fetchImpl: net.fetchImpl });
    assert(r.fetched === 3, 'case14: the poller paginates past the first page');
    assert(r.ingested === 3, 'case14: every page is ingested');
    assert(r.truncated !== true, 'case14: not truncated when the cap is not hit');
    const listCalls = net.gmailCalls().filter((c) => c.url.includes('/messages?'));
    assert(listCalls.length === 2, 'case14: exactly two list calls (one per page)');
    assert(
      new URL(listCalls[1].url).searchParams.get('pageToken') === 'tok-1',
      'case14: the second list call carries the nextPageToken',
    );

    // Explicit cap: the bound is enforced AND reported, never silent.
    resetCase();
    setRefreshEnv();
    process.env.GMAIL_MAX_MESSAGES = '2';
    const store2 = makeSbStub();
    const net2 = makeGmailNet({ messages: msgs, pages: [['page-1', 'page-2'], ['page-3']] });
    const r2 = await pollGmailInbound(store2.sb, { fetchImpl: net2.fetchImpl });
    assert(r2.fetched === 2, 'case14: GMAIL_MAX_MESSAGES caps the messages examined');
    assert(r2.truncated === true, 'case14: hitting the cap is REPORTED, not silent');
    delete process.env.GMAIL_MAX_MESSAGES;
  }

  // ── 15. Per-firm inbox: the poller honors an injected inbox address ───────
  {
    resetCase();
    setRefreshEnv();
    process.env.GMAIL_USER = 'env-account@examplerecords.example';
    const net = makeGmailNet({ messages: [] });
    await pollGmailInbound(makeSbStub().sb, {
      fetchImpl: net.fetchImpl,
      user: 'firm-inbox@examplerecords.example',
    });
    const listUrl = net.gmailCalls().find((c) => c.url.includes('/messages?'))?.url ?? '';
    assert(
      listUrl.includes(encodeURIComponent('firm-inbox@examplerecords.example')),
      'case15: options.user overrides GMAIL_USER (the seam per-firm wiring needs)',
    );
  }

  // ── 16. DELIBERATE BEHAVIOR CHANGES vs the pre-shared-normalizer poller ──
  //
  // These three were NOT true before the transport-agnostic normalizer landed.
  // They are pinned here so the change is enforced rather than incidental.
  {
    resetCase();
    setRefreshEnv();
    const CI = '3f9c2a1e-7b4d-4e0a-9c66-2d8f5b1a0c3e';
    const replyTo = `replies+lead-${CI}@examplerecords.example`;

    // (a) WAS: an empty body ingested a row with body ''. NOW: refused, and
    //     counted as ignored — there is nothing to classify.
    const empty = gmailMessage({
      id: 'empty-1',
      labelIds: ['INBOX'],
      subject: 'Re: Collab',
      to: `Example Records <${replyTo}>`,
      from: 'Rowan <rowan@example.com>',
      body: '',
    });
    const s1 = makeSbStub();
    const r1 = await pollGmailInbound(s1.sb, { fetchImpl: makeGmailNet({ messages: [empty] }).fetchImpl });
    assert(r1.ingested === 0, 'case16a: an empty-body message is NOT ingested (was: body-empty row)');
    assert(r1.ignored === 1, 'case16a: it is counted as ignored, not silently dropped');

    // (b) WAS: the whole quoted thread was stored. NOW: cut at the marker, so
    //     our own quoted offer no longer reads as the creator's words.
    const quoted = gmailMessage({
      id: 'quoted-1',
      labelIds: ['INBOX'],
      subject: 'Re: Collab',
      to: `Example Records <${replyTo}>`,
      from: 'Rowan <rowan@example.com>',
      body:
        'Yes, $400 works.\n\nOn Wed, Sep 17, 2026 at 3:04 PM Example Records <hello@examplerecords.example> wrote:\n> We can offer $400.',
    });
    const s2 = makeSbStub();
    await pollGmailInbound(s2.sb, { fetchImpl: makeGmailNet({ messages: [quoted] }).fetchImpl });
    const row2 = s2.inserts.find((i) => i.table === 'inbound_messages')?.row;
    assert(row2?.body === 'Yes, $400 works.', 'case16b: the quoted chain is stripped from the stored body');

    // (c) SEC: correlated envelope, but the sender is not the creator on file.
    //     Ingested for a human, never attributed — so no lead advances and the
    //     autonomous negotiator is never handed the message.
    const impostor = gmailMessage({
      id: 'impostor-1',
      labelIds: ['INBOX'],
      subject: 'Re: Collab',
      to: `Example Records <${replyTo}>`,
      from: 'Attacker <attacker@evil.example>',
      body: 'yes, $2,000 works, send the contract',
    });
    const s3 = makeSbStub({ creatorEmail: 'rowan@example.com' });
    const r3 = await pollGmailInbound(s3.sb, { fetchImpl: makeGmailNet({ messages: [impostor] }).fetchImpl });
    const row3 = s3.inserts.find((i) => i.table === 'inbound_messages')?.row;
    assert(r3.ingested === 1, 'case16c: a correlated message from a stranger is still queued');
    assert(
      row3?.campaign_influencer_id === null,
      'case16c-sec: ...but is NOT attributed to the lead (thread-hijack guard)',
    );
    assert(
      s3.inserts.every((i) => i.table !== 'outreach_messages'),
      'case16c-sec: no inbound outreach_messages row is written in the creator name',
    );
  }

  // ── 17. Testing-mode dry run: the operator replies FROM the test inbox ──
  //
  // Outbound in testing mode goes to the firm's test inbox, so the dry-run
  // reply comes from there. Same rule as the Resend route.
  {
    resetCase();
    setRefreshEnv();
    const CI = '3f9c2a1e-7b4d-4e0a-9c66-2d8f5b1a0c3e';
    const replyTo = `replies+lead-${CI}@examplerecords.example`;
    const TEST_INBOX = 'operator.personal@example.com';
    const dryRun = (id: string, from: string) =>
      gmailMessage({
        id,
        labelIds: ['INBOX'],
        subject: 'Re: [Creator Campaigns] Collab',
        to: `Example Records <${replyTo}>`,
        from,
        body: 'Yes, $300 works.',
      });

    // (a) testing mode + test inbox + tag → attributed, ingested, marked.
    const s1 = makeSbStub({ testingFirm: { testingMode: true, testRecipient: TEST_INBOX } });
    const r1 = await pollGmailInbound(s1.sb, {
      fetchImpl: makeGmailNet({ messages: [dryRun('tm-1', `Owen <${TEST_INBOX}>`)] }).fetchImpl,
    });
    const row1 = s1.inserts.find((i) => i.table === 'inbound_messages')?.row;
    assert(r1.ingested === 1 && r1.unmatched === 0, 'case17a: the dry-run reply is ingested and matched');
    assert(row1?.campaign_influencer_id === CI, 'case17a: ...attributed to the tagged lead');
    assert(
      row1?.sender_auth_outcome === 'testing_mode_attribution',
      'case17a: ...and marked as a testing-mode attribution',
    );

    // (b) same message, testing mode OFF → unattributed.
    const s2 = makeSbStub({ testingFirm: { testingMode: false, testRecipient: TEST_INBOX } });
    await pollGmailInbound(s2.sb, {
      fetchImpl: makeGmailNet({ messages: [dryRun('tm-2', `Owen <${TEST_INBOX}>`)] }).fetchImpl,
    });
    const row2 = s2.inserts.find((i) => i.table === 'inbound_messages')?.row;
    assert(row2?.campaign_influencer_id === null, 'case17b: testing mode off → queued unattributed');

    // (c) testing mode ON, other From → unattributed.
    const s3 = makeSbStub({ testingFirm: { testingMode: true, testRecipient: TEST_INBOX } });
    await pollGmailInbound(s3.sb, {
      fetchImpl: makeGmailNet({ messages: [dryRun('tm-3', 'someone@else.example')] }).fetchImpl,
    });
    const row3 = s3.inserts.find((i) => i.table === 'inbound_messages')?.row;
    assert(row3?.campaign_influencer_id === null, 'case17c: testing mode on, other From → unattributed');
  }

  resetCase();
  console.log(`gmail-inbound test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
