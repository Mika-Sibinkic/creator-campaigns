// tests/inbound-email.test.ts
//
// Hermetic tests for the inbound-email transport:
//   src/lib/svix-verify.ts            — webhook signature verification
//   src/lib/channels/email-inbound.ts — transport-agnostic normalization
//   src/lib/channels/resend-inbound.ts— Resend payload mapping + tenant routing
//
// No network: the Resend API is reached through an injected fetch, and the
// firm lookup through a chainable Supabase stub.
//
// The signature cases are anchored on Svix's OWN published test vector, so this
// suite proves the from-scratch node:crypto implementation is byte-compatible
// with the library we chose not to depend on — not merely self-consistent.
//
// Payload fixtures are copied VERBATIM from
// https://resend.com/docs/webhooks/emails/received and
// https://resend.com/docs/api-reference/emails/retrieve-received-email
// (only addresses/ids swapped where a test needs a correlation tag).
//
// Run: npx tsx tests/inbound-email.test.ts

import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readSvixHeaders, verifySvixSignature } from '../src/lib/svix-verify';
import {
  MAX_BODY_CHARS,
  baseAddress,
  correlateFromEnvelope,
  htmlToPlainText,
  normalizeInboundEmail,
  parseEmailAddresses,
  parseFromMailbox,
  stripQuotedReply,
} from '../src/lib/channels/email-inbound';
import {
  isKnownCreatorContact,
  senderMatchesLeadCreator,
  testingModeSenderMatch,
} from '../src/lib/channels/inbound-attribution';
import {
  evaluateSenderAuthentication,
  resolveInboundAuthPolicy,
} from '../src/lib/channels/inbound-authentication';
import { ingestInboundReply } from '../src/lib/ingest-inbound';
import {
  envelopeRecipientValues,
  fetchReceivedEmail,
  resolveFirmByInbox,
  toInboundEmailMessage,
  type ResendInboundEvent,
  type ResendReceivedEmail,
} from '../src/lib/channels/resend-inbound';

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

function headers(h: Record<string, string>): Headers {
  return new Headers(h);
}

// ── 1. Svix verification against the published test vector ──────────────────
//
// Source: standard-webhooks / svix reference test data.
const VECTOR = {
  secret: 'whsec_plJ3nmyCDGBKInavdOK15jsl',
  payload: '{"event_type":"ping","data":{"success":true}}',
  id: 'msg_loFOjxBNrRLzqYUf',
  timestamp: '1731705121',
  signature: 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=',
};
const VECTOR_NOW = Number(VECTOR.timestamp);

{
  const v = verifySvixSignature(
    VECTOR.payload,
    { id: VECTOR.id, timestamp: VECTOR.timestamp, signature: VECTOR.signature },
    VECTOR.secret,
    VECTOR_NOW,
  );
  assert(v.ok, 'case1: Svix published test vector verifies with bare node:crypto');
}

{
  // Same vector, one byte changed in the body.
  const v = verifySvixSignature(
    VECTOR.payload.replace('true', 'fals'),
    { id: VECTOR.id, timestamp: VECTOR.timestamp, signature: VECTOR.signature },
    VECTOR.secret,
    VECTOR_NOW,
  );
  assert(!v.ok, 'case2: a tampered body fails verification');
}

{
  const v = verifySvixSignature(
    VECTOR.payload,
    { id: 'msg_different', timestamp: VECTOR.timestamp, signature: VECTOR.signature },
    VECTOR.secret,
    VECTOR_NOW,
  );
  assert(!v.ok, 'case3: svix-id is part of the signed content — swapping it fails');
}

{
  const v = verifySvixSignature(
    VECTOR.payload,
    { id: VECTOR.id, timestamp: VECTOR.timestamp, signature: VECTOR.signature },
    'whsec_' + Buffer.from('a different key').toString('base64'),
    VECTOR_NOW,
  );
  assert(!v.ok, 'case4: a wrong signing secret fails');
}

// Replay window: ±300s, both directions.
{
  const tooOld = verifySvixSignature(
    VECTOR.payload,
    { id: VECTOR.id, timestamp: VECTOR.timestamp, signature: VECTOR.signature },
    VECTOR.secret,
    VECTOR_NOW + 301,
  );
  const justInside = verifySvixSignature(
    VECTOR.payload,
    { id: VECTOR.id, timestamp: VECTOR.timestamp, signature: VECTOR.signature },
    VECTOR.secret,
    VECTOR_NOW + 299,
  );
  const tooNew = verifySvixSignature(
    VECTOR.payload,
    { id: VECTOR.id, timestamp: VECTOR.timestamp, signature: VECTOR.signature },
    VECTOR.secret,
    VECTOR_NOW - 301,
  );
  assert(!tooOld.ok && /too old/.test(tooOld.reason), 'case5a: >300s old is rejected as replay');
  assert(justInside.ok, 'case5b: 299s old still verifies');
  assert(!tooNew.ok && /too new/.test(tooNew.reason), 'case5c: >300s in the future is rejected');
}

// Missing headers → fail closed, legibly.
{
  for (const [h, label] of [
    [{ id: null, timestamp: VECTOR.timestamp, signature: VECTOR.signature }, 'svix-id'],
    [{ id: VECTOR.id, timestamp: null, signature: VECTOR.signature }, 'svix-timestamp'],
    [{ id: VECTOR.id, timestamp: VECTOR.timestamp, signature: null }, 'svix-signature'],
  ] as const) {
    const v = verifySvixSignature(VECTOR.payload, h, VECTOR.secret, VECTOR_NOW);
    assert(!v.ok && v.reason.includes(label), `case6: missing ${label} is rejected`);
  }
}

// Space-delimited multi-signature list; non-v1 versions skipped.
{
  const multi = `v1,ZmFrZXNpZ25hdHVyZXZhbHVlcGFkZGluZ2Jhc2U2NA== ${VECTOR.signature}`;
  const v = verifySvixSignature(
    VECTOR.payload,
    { id: VECTOR.id, timestamp: VECTOR.timestamp, signature: multi },
    VECTOR.secret,
    VECTOR_NOW,
  );
  assert(v.ok, 'case7a: any matching entry in a space-delimited list verifies');

  const v2Only = verifySvixSignature(
    VECTOR.payload,
    { id: VECTOR.id, timestamp: VECTOR.timestamp, signature: VECTOR.signature.replace('v1,', 'v2,') },
    VECTOR.secret,
    VECTOR_NOW,
  );
  assert(!v2Only.ok, 'case7b: a non-v1 version is not accepted blindly');
}

// Header reading, including the white-labelled `webhook-*` spelling.
{
  const svix = readSvixHeaders(
    headers({ 'svix-id': 'a', 'svix-timestamp': 'b', 'svix-signature': 'c' }),
  );
  assert(
    svix.id === 'a' && svix.timestamp === 'b' && svix.signature === 'c',
    'case8a: svix-* headers are read',
  );
  const wh = readSvixHeaders(
    headers({ 'webhook-id': 'x', 'webhook-timestamp': 'y', 'webhook-signature': 'z' }),
  );
  assert(
    wh.id === 'x' && wh.timestamp === 'y' && wh.signature === 'z',
    'case8b: white-labelled webhook-* headers are accepted as a fallback',
  );
}

// A freshly-minted signature (proves we can also produce what we verify).
{
  const body = JSON.stringify({ type: 'email.received', data: { email_id: 'abc' } });
  const id = 'msg_fresh';
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(VECTOR.secret.slice('whsec_'.length), 'base64');
  const sig =
    'v1,' + crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`, 'utf8').digest('base64');
  const v = verifySvixSignature(body, { id, timestamp: ts, signature: sig }, VECTOR.secret);
  assert(v.ok, 'case9: a freshly signed payload round-trips');
}

// ── 2. Quoted-chain + signature stripping ───────────────────────────────────

const CI_ID = '6b6f2b24-31a1-4a3a-9b1e-6f2d7c1a5e90';

{
  const gmailStyle =
    'Yes! $400 works for me.\n\n' +
    'On Wed, Sep 17, 2026 at 3:04 PM Owen <operator@operator.example> wrote:\n' +
    '> We can offer $400 for one TikTok.\n' +
    '> Let me know.\n';
  assert(
    stripQuotedReply(gmailStyle) === 'Yes! $400 works for me.',
    'case10: Gmail "On … wrote:" attribution and the quoted chain are stripped',
  );
}

{
  const quotedOnly = 'Sounds good.\n\n> previous message here\n> more quoted text';
  assert(
    stripQuotedReply(quotedOnly) === 'Sounds good.',
    'case11: a bare ">" quote block is stripped',
  );
}

{
  const withSig = 'Interested — send details.\n\n-- \nJane Doe\nCreator, @janed';
  assert(
    stripQuotedReply(withSig) === 'Interested — send details.',
    'case12: the RFC 3676 "-- " signature delimiter cuts the signature',
  );
}

{
  const outlook =
    'Can you do $600?\n\nFrom: Owen <operator@operator.example>\nSent: Wednesday, September 17, 2026\nTo: Jane\n\nOriginal offer was $400.';
  assert(
    stripQuotedReply(outlook) === 'Can you do $600?',
    'case13: the Outlook From:/Sent: block header cuts the quoted mail',
  );
}

{
  const original = 'Yes.\n\n-----Original Message-----\nFrom: someone';
  assert(
    stripQuotedReply(original) === 'Yes.',
    'case14: "-----Original Message-----" cuts the quoted mail',
  );
}

{
  const mobile = 'Sure thing.\n\nSent from my iPhone';
  assert(stripQuotedReply(mobile) === 'Sure thing.', 'case15: mobile signature is stripped');
}

{
  const clean = 'Just a normal reply with no quoting at all.';
  assert(stripQuotedReply(clean) === clean, 'case16: a body with no markers is returned unchanged');
}

{
  // The conservative contract: stripping must never empty a message. A reply
  // that is nothing BUT a quote keeps its original text rather than vanishing.
  const allQuote = '> only quoted text here\n> and more';
  assert(
    stripQuotedReply(allQuote) === allQuote.trim(),
    'case17: stripping never returns empty — an all-quote body is preserved intact',
  );
}

{
  assert(
    stripQuotedReply('I wrote: yes, that works.') === 'I wrote: yes, that works.',
    'case18: "wrote:" mid-sentence does NOT trigger the attribution cut',
  );
}

{
  // The attribution regex requires an address (`@` or `<`) before "wrote:".
  // Without that guard this prose reads as a Gmail attribution line and the
  // creator's actual answer below it is thrown away.
  const prose =
    'Happy to take part.\n\nOn Monday I sent the brief over to my manager and he wrote:\nlooks good to me.';
  assert(
    stripQuotedReply(prose) === prose.trim(),
    'case18b: prose "On <day> … wrote:" with no address does NOT truncate the reply',
  );
}

{
  // …while a genuinely wrapped attribution line still cuts.
  const wrapped =
    'Yes, works for me.\n\nOn Wed, Sep 17, 2026 at 3:04 PM Owen\n<operator@operator.example> wrote:\n> the offer';
  assert(
    stripQuotedReply(wrapped) === 'Yes, works for me.',
    'case18c: an attribution line wrapped across two lines still cuts',
  );
}

// ── 3. HTML → text ──────────────────────────────────────────────────────────

{
  const html = '<div>Yes &amp; thanks!<br>Let&#39;s do it.</div><blockquote>old thread</blockquote>';
  const text = htmlToPlainText(html);
  assert(
    text.includes('Yes & thanks!') && text.includes("Let's do it.") && !text.includes('old thread'),
    'case19: HTML is flattened, entities decoded, and the blockquote thread dropped',
  );
}

{
  assert(
    htmlToPlainText('<style>p{color:red}</style><p>Hello</p>').trim() === 'Hello',
    'case20: style/script blocks are removed, not rendered as text',
  );
}

// ── 4. Address parsing + correlation ────────────────────────────────────────

{
  assert(
    parseEmailAddresses('Acme <A@B.example>, c@d.example').join(',') === 'a@b.example,c@d.example',
    'case21: display-name lists parse to lowercased bare addresses',
  );
  assert(
    baseAddress(`operator+lead-${CI_ID}@operator.example`) === 'operator@operator.example',
    'case22: baseAddress strips the +lead- plus tag back to the stored inbox',
  );
}

{
  const ci = correlateFromEnvelope([`operator+lead-${CI_ID}@operator.example`]);
  assert(ci === CI_ID, 'case23: the +lead- plus-address correlates to campaign_influencer_id');
  assert(
    correlateFromEnvelope([`outreach+${CI_ID}@a.co`]) === CI_ID,
    'case24: the legacy outreach+ alias still correlates on the envelope',
  );
  assert(
    correlateFromEnvelope(['someone@else.example']) === null,
    'case25: an uncorrelated message returns null, not a false positive',
  );
}

// ── 5. The intake gate ──────────────────────────────────────────────────────

const baseMsg = {
  provider: 'resend',
  providerMessageId: '56761188-7520-42d8-8898-ff6fc54ce618',
  from: 'Jane <jane@creator.example>',
  subject: 'Re: Collaboration',
  text: 'Sounds great, count me in.',
  receivedAt: '2026-02-22T23:41:11.894Z',
};

/**
 * The happy path: envelope correlates, the sender IS that creator, and the
 * receiving infrastructure authenticated them.
 *
 * `senderAuthenticated` is not padding — attribution now requires it, and it
 * defaults to absent (i.e. unauthenticated) so a caller that forgets the policy
 * gets the safe answer. A real authenticated reply supplies it; these fixtures
 * model a real authenticated reply.
 */
const VERIFIED = { senderVerified: true, senderIsKnownCreator: true, senderAuthenticated: true };

{
  const d = normalizeInboundEmail(
    { ...baseMsg, envelopeRecipients: [`operator+lead-${CI_ID}@operator.example`] },
    VERIFIED,
  );
  assert(d.accepted, 'case26: a correlated reply from the real creator is accepted');
  if (d.accepted) {
    assert(
      d.normalized.external_id === 'resend:56761188-7520-42d8-8898-ff6fc54ce618',
      'case27: external_id is provider-namespaced for dedupe',
    );
    assert(d.normalized.campaign_influencer_id === CI_ID, 'case28: the lead id is carried through');
    assert(d.normalized.channel === 'email', 'case29: channel is email');
    assert(
      d.normalized.received_at === '2026-02-22T23:41:11.894Z',
      'case30: the provider timestamp is preserved as ISO',
    );
    assert(d.normalized.from_identity === 'Jane <jane@creator.example>', 'case31: sender is carried');
  }
}

{
  const d = normalizeInboundEmail({ ...baseMsg, envelopeRecipients: ['stranger@elsewhere.example'] });
  assert(
    !d.accepted && d.reason === 'not_ours',
    'case32: uncorrelated, untagged mail to an unknown address is refused (spam gate)',
  );
}

{
  // A creator replying on a fresh thread with no correlation tag: admitted on
  // the strength of their known address, but queued UNATTRIBUTED.
  const d = normalizeInboundEmail(
    { ...baseMsg, envelopeRecipients: ['replies@inbound.operator.example'] },
    { senderIsKnownCreator: true },
  );
  assert(
    d.accepted && d.normalized.campaign_influencer_id === null,
    'case33: a known creator with no correlation tag is queued UNMATCHED',
  );
}

{
  // ── SEC (B3): the subject tag is NOT authorization ──────────────────────
  // This assertion previously asserted the opposite. hasSubjectTag is a
  // case-insensitive substring match on a field the SENDER writes, so admitting
  // on it let any stranger who learned the inbound address write arbitrary rows
  // into inbound_messages — which /api/anomalies then shows to every firm.
  const d = normalizeInboundEmail({
    ...baseMsg,
    envelopeRecipients: ['x@y.example'],
    subject: '[Creator Campaigns] Collaboration',
  });
  assert(
    !d.accepted && d.reason === 'not_ours',
    'case34-sec: a [Creator Campaigns] subject tag alone must NOT admit a message',
  );
}

{
  // Nor does merely knowing a firm's inbox address admit anything.
  const d = normalizeInboundEmail({
    ...baseMsg,
    envelopeRecipients: ['replies@inbound.operator.example'],
  });
  assert(
    !d.accepted && d.reason === 'not_ours',
    'case34-sec2: addressing a known firm inbox is not proof of anything',
  );
}

{
  const d = normalizeInboundEmail({
    ...baseMsg,
    envelopeRecipients: [`operator+lead-${CI_ID}@operator.example`],
    isSelfCopy: true,
  });
  assert(
    !d.accepted && d.reason === 'self_copy',
    'case35: our own outbound copy is never ingested as a creator reply',
  );
}

{
  const d = normalizeInboundEmail({
    ...baseMsg,
    providerMessageId: '',
    envelopeRecipients: [`operator+lead-${CI_ID}@operator.example`],
  });
  assert(
    !d.accepted && d.reason === 'no_message_id',
    'case36: no provider message id is refused — nothing to dedupe on',
  );
}

{
  const d = normalizeInboundEmail({
    ...baseMsg,
    text: '   ',
    html: null,
    envelopeRecipients: [`operator+lead-${CI_ID}@operator.example`],
  });
  assert(!d.accepted && d.reason === 'empty_body', 'case37: an empty body is refused');
}

{
  const d = normalizeInboundEmail({
    ...baseMsg,
    text: null,
    html: '<p>Yes, I am in.</p>',
    envelopeRecipients: [`operator+lead-${CI_ID}@operator.example`],
  });
  assert(
    d.accepted && d.normalized.body === 'Yes, I am in.',
    'case38: HTML-only replies fall back to flattened text',
  );
}

{
  const d = normalizeInboundEmail({
    ...baseMsg,
    text: 'Yes, $400 works.\n\nOn Wed, Sep 17, 2026 at 3:04 PM Owen <m@n.example> wrote:\n> offer',
    envelopeRecipients: [`operator+lead-${CI_ID}@operator.example`],
  });
  assert(
    d.accepted && d.normalized.body === 'Yes, $400 works.',
    'case39: the quoted chain is stripped before the body reaches the classifier',
  );
}

// ── 6. Resend payload mapping (verbatim doc fixtures) ───────────────────────

const WEBHOOK_FIXTURE: ResendInboundEvent = {
  type: 'email.received',
  created_at: '2026-02-22T23:41:12.126Z',
  data: {
    email_id: '56761188-7520-42d8-8898-ff6fc54ce618',
    created_at: '2026-02-22T23:41:11.894Z',
    from: 'jane@creator.example',
    to: [`operator+lead-${CI_ID}@operator.example`],
    bcc: [],
    cc: [],
    received_for: ['forwarded@example.com'],
    message_id: '<111-222-333@email.example.com>',
    subject: 'Re: Collaboration',
  },
};

const CONTENT_FIXTURE: ResendReceivedEmail = {
  id: '56761188-7520-42d8-8898-ff6fc54ce618',
  to: [`operator+lead-${CI_ID}@operator.example`],
  from: 'jane@creator.example',
  created_at: '2026-02-22T23:41:11.894Z',
  subject: 'Re: Collaboration',
  html: 'Congrats on sending your <strong>first email</strong>!',
  html_format: 'data_uri',
  text: 'Yes — $400 works for one TikTok.',
  headers: {
    from: 'Jane Doe <jane@creator.example>',
    'return-path': 'jane@creator.example',
    'mime-version': '1.0',
  },
};

{
  const msg = toInboundEmailMessage(WEBHOOK_FIXTURE, CONTENT_FIXTURE);
  assert(msg.provider === 'resend', 'case40: provider slug is resend');
  assert(
    msg.providerMessageId === '56761188-7520-42d8-8898-ff6fc54ce618',
    'case41: dedupe key is data.email_id (stable across at-least-once redelivery)',
  );
  assert(
    msg.from === 'Jane Doe <jane@creator.example>',
    'case42: the richer headers.from display name wins over the bare webhook from',
  );
  assert(msg.text === 'Yes — $400 works for one TikTok.', 'case43: plain text body is carried');

  const d = normalizeInboundEmail(msg, VERIFIED);
  assert(
    d.accepted && d.normalized.campaign_influencer_id === CI_ID,
    'case44: the documented payload correlates and attributes end to end',
  );
  // Without the sender check the SAME payload must not attribute.
  const unverified = normalizeInboundEmail(msg, { senderVerified: false });
  assert(
    unverified.accepted && unverified.normalized.campaign_influencer_id === null,
    'case44-sec: the same payload does NOT attribute when the sender is unverified',
  );
}

{
  // The webhook alone (no retrieve hop) must NOT produce an ingestable reply —
  // this is the regression guard for the metadata-only payload design.
  const msg = toInboundEmailMessage(WEBHOOK_FIXTURE, null);
  const d = normalizeInboundEmail(msg);
  assert(
    !d.accepted && d.reason === 'empty_body',
    'case45: webhook metadata alone yields no body — the retrieve hop is mandatory',
  );
}

{
  const values = envelopeRecipientValues(WEBHOOK_FIXTURE, CONTENT_FIXTURE);
  assert(
    values[0] === `operator+lead-${CI_ID}@operator.example`,
    'case46: data.to leads the correlation precedence order',
  );
  assert(
    values.includes('forwarded@example.com'),
    'case47: received_for addresses are considered (forwarded mail)',
  );
}

// Sections 7-8 are async (injected fetch + Supabase stub), so they run inside
// main() — the CJS transform tsx uses does not allow top-level await.
async function main() {
// ── 7. The retrieve hop, over an injected fetch ─────────────────────────────

{
  const prevKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-resend-key';

  const seen: Array<{ url: string; auth: string | null }> = [];
  const okFetch = async (url: string, init?: RequestInit) => {
    seen.push({
      url,
      auth: new Headers(init?.headers as HeadersInit | undefined).get('authorization'),
    });
    return new Response(JSON.stringify(CONTENT_FIXTURE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const r = await fetchReceivedEmail('56761188-7520-42d8-8898-ff6fc54ce618', okFetch);
  assert(r.ok, 'case48: a 200 from the retrieve endpoint returns the email');
  assert(
    seen[0]?.url === 'https://api.resend.com/emails/receiving/56761188-7520-42d8-8898-ff6fc54ce618',
    'case49: the retrieve URL matches the documented endpoint',
  );
  assert(seen[0]?.auth === 'Bearer test-resend-key', 'case50: the API key is sent as a bearer token');

  const notFound = await fetchReceivedEmail('missing', async () => new Response('', { status: 404 }));
  assert(
    !notFound.ok && /404/.test(notFound.error),
    'case51: a non-2xx retrieve degrades to a legible error, never a throw',
  );

  const threw = await fetchReceivedEmail('boom', async () => {
    throw new Error('socket hang up');
  });
  assert(
    !threw.ok && /socket hang up/.test(threw.error),
    'case52: a network throw is caught and reported',
  );

  delete process.env.RESEND_API_KEY;
  const noKey = await fetchReceivedEmail('x', okFetch);
  assert(
    !noKey.ok && noKey.error === 'resend_api_key_missing',
    'case53: a missing RESEND_API_KEY is reported, not thrown',
  );

  if (prevKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = prevKey;
}

// ── 8. Multi-tenant firm routing ────────────────────────────────────────────

function firmsStub(rows: Array<{ id: string; negotiation_inbox_email: string | null }>) {
  return {
    from() {
      return {
        select() {
          return {
            not() {
              return {
                limit: async () => ({ data: rows, error: null }),
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

{
  const sb = firmsStub([
    { id: 'firm-other', negotiation_inbox_email: 'someone@otherlabel.example' },
    { id: 'firm-label', negotiation_inbox_email: 'Operator@Operator.Example' },
  ]);

  const match = await resolveFirmByInbox(sb, [`operator+lead-${CI_ID}@operator.example`]);
  assert(
    match?.firmId === 'firm-label',
    'case54: a plus-tagged recipient routes to the firm whose inbox it belongs to',
  );
  assert(
    match?.inbox === 'operator@operator.example',
    'case55: matching is case-insensitive against the stored column',
  );

  const none = await resolveFirmByInbox(sb, ['nobody@unknown.example']);
  assert(none === null, 'case56: an unknown recipient matches no firm (fail closed)');

  const empty = await resolveFirmByInbox(sb, []);
  assert(empty === null, 'case57: no addresses at all matches no firm');

  const display = await resolveFirmByInbox(sb, ['Creator Campaigns <operator@operator.example>']);
  assert(
    display?.firmId === 'firm-label',
    'case58: a display-name header value still routes to the right firm',
  );
}

{
  const errSb = {
    from() {
      return {
        select() {
          return {
            not() {
              return { limit: async () => ({ data: null, error: { message: 'boom' } }) };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  const r = await resolveFirmByInbox(errSb, ['operator@operator.example']);
  assert(r === null, 'case59: a firms lookup error resolves to no tenant, never a throw');
}

// ── 9. SECURITY REGRESSIONS: thread hijack (B1) ─────────────────────────────
//
// These are the assertions that BITE. Each one fails if the corresponding
// mitigation is removed.

{
  // The attack: attacker holds a leaked +lead-<uuid> (it rides in the Reply-To of
  // every outreach email, so it survives forwards, bounces and auto-replies)
  // and self-attributes a message by putting it in Cc.
  const hijack: ResendInboundEvent = {
    type: 'email.received',
    created_at: '2026-02-22T23:41:12.126Z',
    data: {
      email_id: 'attacker-msg-1',
      created_at: '2026-02-22T23:41:11.894Z',
      from: 'attacker@evil.example',
      to: ['replies@inbound.operator.example'],
      cc: [`x+lead-${CI_ID}@evil.example`],
      subject: 'Re: Collaboration',
    },
  };
  const hijackContent: ResendReceivedEmail = {
    text: 'yes, $2,000 works, send the contract',
    headers: { from: 'attacker@evil.example', cc: `x+lead-${CI_ID}@evil.example` },
  };

  const values = envelopeRecipientValues(hijack, hijackContent);
  assert(
    !values.some((v) => v.includes('+lead-')),
    'case60-sec: a Cc-borne +lead- tag never reaches the correlation input',
  );

  const msg = toInboundEmailMessage(hijack, hijackContent);
  assert(
    correlateFromEnvelope(msg.envelopeRecipients) === null,
    'case61-sec: a Cc-only correlation attempt does NOT correlate',
  );

  // Even if the attacker is somehow a "known creator" (so admission passes),
  // nothing may be attributed, because the envelope never correlated.
  const d = normalizeInboundEmail(msg, { senderIsKnownCreator: true });
  assert(
    d.accepted && d.normalized.campaign_influencer_id === null,
    'case62-sec: a Cc hijack attempt never advances a lead',
  );
}

{
  // Same leaked id, this time on the real envelope — but sent by someone who is
  // not the creator. Admitted (possession of a real tag is evidence of
  // something) but NOT attributed, so no deal can be agreed on it.
  const d = normalizeInboundEmail(
    {
      ...baseMsg,
      from: 'attacker@evil.example',
      text: 'yes, $2,000 works, send the contract',
      envelopeRecipients: [`operator+lead-${CI_ID}@operator.example`],
    },
    { senderVerified: false, senderIsKnownCreator: false },
  );
  assert(d.accepted, 'case63-sec: a correlated message from a stranger is still queued');
  assert(
    d.accepted && d.normalized.campaign_influencer_id === null,
    'case64-sec: ...but is NOT attributed to the lead, so no state advances',
  );
  assert(
    d.accepted && d.senderMismatch === true,
    'case65-sec: the mismatch is reported so it can be alerted on',
  );
}

{
  // The control: same envelope, sender verified → attribution restored.
  const d = normalizeInboundEmail(
    { ...baseMsg, envelopeRecipients: [`operator+lead-${CI_ID}@operator.example`] },
    VERIFIED,
  );
  assert(
    d.accepted && d.normalized.campaign_influencer_id === CI_ID && !d.senderMismatch,
    'case66-sec: the real creator on the real envelope IS attributed',
  );
}

// ── 10. The DB-backed sender check ──────────────────────────────────────────

/**
 * Chainable Supabase stub for the sender + admission checks.
 *
 * `inMatches` — the address is a known creator contact SOMEWHERE.
 * `firmLeadMatches` — that creator also has a lead under the firm being asked
 * about. Defaults to `inMatches`, so the pre-H2 cases keep their meaning; the
 * two are separable precisely so the firm predicate can be tested on its own.
 */
function attributionStub(opts: {
  influencerId?: string | null;
  contactEmail?: string | null;
  contacts?: Array<{ address: string; channel: string }>;
  inMatches?: boolean;
  firmLeadMatches?: boolean;
  /**
   * Addresses the stubbed database actually holds. When set, an `in(...)`
   * lookup matches ONLY if one of these is among the values queried — which is
   * what makes the H1 admission cases meaningful. A stub that answers "yes" to
   * any address cannot tell a narrowed candidate set from an unnarrowed one.
   */
  knownAddresses?: string[];
}) {
  const firmLead = opts.firmLeadMatches ?? opts.inMatches ?? false;
  return {
    from(table: string) {
      // One chainable node; every filter returns itself, and the terminal
      // `limit()` / `maybeSingle()` resolve based on the table being read.
      const node: Record<string, unknown> = {};
      const self = () => node;
      let addressHit = opts.knownAddresses === undefined;
      Object.assign(node, {
        select: self,
        eq: self,
        in: (_col: string, values: unknown) => {
          if (opts.knownAddresses !== undefined && Array.isArray(values)) {
            if (values.some((v) => opts.knownAddresses!.includes(String(v)))) addressHit = true;
          }
          return node;
        },
        not: self,
        is: self,
        order: self,
        maybeSingle: async () => {
          if (table === 'campaign_influencers') {
            return opts.influencerId === undefined
              ? { data: null, error: null }
              : { data: { influencer_id: opts.influencerId }, error: null };
          }
          return { data: { contact_email: opts.contactEmail ?? null }, error: null };
        },
        limit: async () => {
          if (table === 'creator_contacts') {
            // senderMatchesLeadCreator reads address+channel rows; the
            // admission path reads influencer_id off the same table.
            const rows = (opts.contacts ?? []).map((c) => ({ ...c, influencer_id: 'inf-1' }));
            return { data: rows, error: null };
          }
          if (table === 'influencers') {
            return { data: opts.inMatches && addressHit ? [{ id: 'inf-1' }] : [], error: null };
          }
          if (table === 'campaign_influencers') {
            return { data: firmLead ? [{ id: 'ci-1' }] : [], error: null };
          }
          return { data: [], error: null };
        },
      });
      return node;
    },
  } as unknown as SupabaseClient;
}

/** The firm the admission checks below are scoped to. */
const FIRM_ID = 'firm-aaaa-1111';

{
  const sb = attributionStub({ influencerId: 'inf-1', contactEmail: 'Jane@Creator.example' });
  assert(
    (await senderMatchesLeadCreator(sb, CI_ID, 'Jane Doe <jane@creator.example>')) === true,
    'case67: the creator primary contact matches, case-insensitively',
  );
  assert(
    (await senderMatchesLeadCreator(sb, CI_ID, 'attacker@evil.example')) === false,
    'case68-sec: a stranger does NOT match the lead creator',
  );
  assert(
    (await senderMatchesLeadCreator(sb, CI_ID, null)) === false,
    'case69-sec: a missing From never matches',
  );
}

{
  const sb = attributionStub({
    influencerId: 'inf-1',
    contactEmail: null,
    contacts: [{ address: 'jane.alt@creator.example', channel: 'email' }],
  });
  assert(
    (await senderMatchesLeadCreator(sb, CI_ID, 'jane.alt+promo@creator.example')) === true,
    'case70: a discovered creator_contacts address matches, plus-tag stripped',
  );
}

{
  // Fail closed: lead not found, or no contact on file.
  const missing = attributionStub({});
  assert(
    (await senderMatchesLeadCreator(missing, CI_ID, 'jane@creator.example')) === false,
    'case71-sec: an unresolvable lead fails CLOSED (no attribution)',
  );
  const noContact = attributionStub({ influencerId: 'inf-1', contactEmail: null });
  assert(
    (await senderMatchesLeadCreator(noContact, CI_ID, 'jane@creator.example')) === false,
    'case72-sec: a creator with no contact on file fails CLOSED',
  );
}

{
  assert(
    (await isKnownCreatorContact(attributionStub({ inMatches: true }), 'jane@creator.example', {
      firmId: FIRM_ID,
    })) === true,
    'case73: a known creator address admits a fresh-thread reply',
  );
  assert(
    (await isKnownCreatorContact(attributionStub({ inMatches: false }), 'nobody@nowhere.example', {
      firmId: FIRM_ID,
    })) === false,
    'case74-sec: an unknown address does not admit',
  );
}

// ── 10b. H2: admission is scoped to the firm that owns the lead ─────────────

{
  // The hole: `influencers` is shared across tenants, so "is this a known
  // creator?" used to be answered across EVERY firm at once. Anyone who knew
  // any creator's address could write rows into another firm's reply queue.
  const otherFirmsCreator = attributionStub({ inMatches: true, firmLeadMatches: false });
  assert(
    (await isKnownCreatorContact(otherFirmsCreator, 'jane@creator.example', { firmId: FIRM_ID })) ===
      false,
    'case82-sec-H2: a real creator with NO lead at this firm does not admit',
  );

  const ownCreator = attributionStub({ inMatches: true, firmLeadMatches: true });
  assert(
    (await isKnownCreatorContact(ownCreator, 'jane@creator.example', { firmId: FIRM_ID })) === true,
    'case83-H2: the same creator WITH a lead at this firm still admits',
  );

  assert(
    (await isKnownCreatorContact(ownCreator, 'jane@creator.example', { firmId: null })) === false,
    'case84-sec-H2: an unresolvable tenant fails CLOSED — no firm, no admission',
  );

  // The firm predicate must not be reachable by knowing an address alone: with
  // no creator row at all there is nothing to scope, and it still refuses.
  const unknown = attributionStub({ inMatches: false, firmLeadMatches: true });
  assert(
    (await isKnownCreatorContact(unknown, 'stranger@nowhere.example', { firmId: FIRM_ID })) === false,
    'case85-sec-H2: a firm with leads does not admit an address it has never seen',
  );
}

// ── 10c. H1: display-name injection must not forge sender identity ──────────
//
// Executed end to end before the fix, all four of these produced byte-identical
// DB writes to an honest creator reply: status `negotiating`, an inbound
// outreach_messages row in the creator's name, and senderMismatch FALSE. The
// regex harvested every address-shaped token in the whole From value, so the
// victim's address — typed into the display name by the attacker — landed in
// the candidate set.

{
  const VICTIM = 'jane@creator.example';
  const leadStub = () => attributionStub({ influencerId: 'inf-1', contactEmail: VICTIM });

  const FORGERIES: Array<[string, string]> = [
    ['quoted display name', `"${VICTIM}" <attacker@evil.example>`],
    ['unquoted display name', `${VICTIM} <attacker@evil.example>`],
    ['comma-separated list', `attacker@evil.example, ${VICTIM}`],
    ['parenthesised comment', `attacker@evil.example (${VICTIM})`],
  ];

  for (const [label, from] of FORGERIES) {
    assert(
      (await senderMatchesLeadCreator(leadStub(), CI_ID, from)) === false,
      `case86-sec-H1: ${label} does NOT verify as the creator (${from})`,
    );
  }

  // The same bug was an ADMISSION bypass, so close it on that path too. The
  // stub holds the VICTIM's address and nothing else, so an admission here can
  // only mean the victim's address reached the query — i.e. the display name
  // was read as an address again.
  for (const [label, from] of FORGERIES) {
    const admitStub = attributionStub({
      inMatches: true,
      firmLeadMatches: true,
      knownAddresses: [VICTIM],
    });
    assert(
      (await isKnownCreatorContact(admitStub, from, { firmId: FIRM_ID })) === false,
      `case87-sec-H1: ${label} does NOT admit as a known creator (${from})`,
    );
  }

  // The control that keeps this honest: the REAL creator still verifies. A fix
  // that simply refused everything would pass every assertion above.
  assert(
    (await senderMatchesLeadCreator(leadStub(), CI_ID, `Jane Doe <${VICTIM}>`)) === true,
    'case88-H1: the honest creator still verifies after the parser change',
  );
  assert(
    (await isKnownCreatorContact(
      attributionStub({ inMatches: true, firmLeadMatches: true, knownAddresses: [VICTIM] }),
      `Jane Doe <${VICTIM}>`,
      { firmId: FIRM_ID },
    )) === true,
    'case89-H1: the honest creator is still admitted after the parser change',
  );
}

{
  // The parser itself, independent of the DB.
  assert(
    parseEmailAddresses('"jane@creator.example" <attacker@evil.example>').join(',') === 'attacker@evil.example',
    'case90-sec-H1: a quoted address-shaped display name yields ONLY the real mailbox',
  );
  assert(
    parseEmailAddresses('jane@creator.example <attacker@evil.example>').join(',') === 'attacker@evil.example',
    'case91-sec-H1: an unquoted address-shaped display name yields ONLY the real mailbox',
  );
  assert(
    parseEmailAddresses('attacker@evil.example (jane@creator.example)').join(',') === 'attacker@evil.example',
    'case92-sec-H1: a parenthesised comment is dropped, never treated as an address',
  );
  assert(
    parseFromMailbox('attacker@evil.example, jane@creator.example') === null,
    'case93-sec-H1: a multi-mailbox From identifies nobody — it fails closed',
  );
  assert(
    parseFromMailbox('Jane Doe <jane@creator.example>') === 'jane@creator.example',
    'case94-H1: an ordinary From still resolves to its one mailbox',
  );
  assert(
    parseFromMailbox('Doe, Jane <jane@creator.example>') === 'jane@creator.example',
    'case95-H1: a comma inside an unquoted display name does not split the mailbox off',
  );
  assert(
    parseFromMailbox('Jane Doe') === null && parseFromMailbox('') === null,
    'case96-sec-H1: display-name-only and empty From values identify nobody',
  );
  assert(
    parseEmailAddresses('Acme <a@b.example>, c@d.example').join(',') === 'a@b.example,c@d.example',
    'case97-H1: ordinary address lists are unchanged by the stricter parser',
  );
}

// ── 10d. H4: attribution requires an AUTHENTICATED sender ───────────────────

{
  const correlatedEnvelope = { ...baseMsg, envelopeRecipients: [`operator+lead-${CI_ID}@operator.example`] };

  // The right thread, the right address — but nothing proved the sender.
  const held = normalizeInboundEmail(correlatedEnvelope, {
    senderVerified: true,
    senderIsKnownCreator: true,
    senderAuthenticated: false,
  });
  assert(held.accepted, 'case98-H4: an unauthenticated reply is still INGESTED, never dropped');
  assert(
    held.accepted && held.normalized.campaign_influencer_id === null,
    'case99-sec-H4: ...but is NOT attributed, so it cannot drive the negotiator',
  );
  assert(
    held.accepted && held.authenticationHeld === true,
    'case100-H4: the hold is reported so a human can be pointed at it',
  );
  assert(
    held.accepted && held.senderMismatch === false,
    'case101-H4: a hold is NOT a sender mismatch — the two signals stay distinct',
  );
  assert(
    held.accepted && held.normalized.body === baseMsg.text,
    'case102-H4: the body is preserved verbatim for the human who reviews it',
  );

  // Omitting the flag entirely must behave like "unauthenticated", not "fine".
  const omitted = normalizeInboundEmail(correlatedEnvelope, {
    senderVerified: true,
    senderIsKnownCreator: true,
  });
  assert(
    omitted.accepted && omitted.normalized.campaign_influencer_id === null,
    'case103-sec-H4: a caller that forgets the auth input gets the SAFE default',
  );

  // The explicit, configured opt-out restores the old behaviour — and only it.
  const permissive = normalizeInboundEmail(correlatedEnvelope, {
    senderVerified: true,
    senderIsKnownCreator: true,
    senderAuthenticated: false,
    requireSenderAuthentication: false,
  });
  assert(
    permissive.accepted && permissive.normalized.campaign_influencer_id === CI_ID,
    'case104-H4: permissive mode attributes without authentication, by explicit choice',
  );

  // An unauthenticated sender who is ALSO the wrong address stays a mismatch.
  const both = normalizeInboundEmail(
    { ...correlatedEnvelope, from: 'attacker@evil.example' },
    { senderVerified: false, senderIsKnownCreator: false, senderAuthenticated: false },
  );
  assert(
    both.accepted && both.senderMismatch === true && both.authenticationHeld === false,
    'case105-H4: a wrong-address sender is reported as a mismatch, not as a hold',
  );
}

// ── 11. SECURITY REGRESSIONS: CPU exhaustion (B2) ───────────────────────────

{
  // The hostile input from the review: an opening tag that never closes,
  // repeated. Unbounded, this was 57.2s at 2MB. The ceiling must make it fast
  // AND bounded regardless of size.
  const hostileHtml = '<script foo '.repeat(200_000); // ~2.4 MB
  const started = Date.now();
  const out = htmlToPlainText(hostileHtml);
  const elapsed = Date.now() - started;
  assert(
    elapsed < 2_000,
    `case75-sec: htmlToPlainText survives a 2MB unclosed-tag flood fast (took ${elapsed}ms)`,
  );
  assert(
    out.length <= MAX_BODY_CHARS,
    'case76-sec: htmlToPlainText output is bounded by the input ceiling',
  );

  const hostileText = 'On '.repeat(700_000); // ~2.1 MB
  const started2 = Date.now();
  stripQuotedReply(hostileText);
  const elapsed2 = Date.now() - started2;
  assert(
    elapsed2 < 2_000,
    `case77-sec: stripQuotedReply survives a 2MB marker flood fast (took ${elapsed2}ms)`,
  );
}

{
  const long = 'a'.repeat(MAX_BODY_CHARS + 5_000);
  assert(
    stripQuotedReply(long).length <= MAX_BODY_CHARS,
    'case78-sec: bodies past the ceiling are truncated before any regex runs',
  );
}

{
  // An oversized hop-two body must be REFUSED, not parsed. The route turns this
  // into a 200-ignored so Resend does not re-download it on every retry.
  const prevKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-resend-key';

  const huge = JSON.stringify({ text: 'x'.repeat(2_000_000) });
  const hugeFetch = async () =>
    new Response(huge, { status: 200, headers: { 'content-type': 'application/json' } });
  const r = await fetchReceivedEmail('big', hugeFetch);
  assert(
    !r.ok && r.error === 'content_too_large',
    'case79-sec: an oversized hop-two body is refused, never parsed',
  );

  // A declared content-length past the cap is refused without reading at all.
  const declaredBig = async () =>
    new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '99000000' },
    });
  const r2 = await fetchReceivedEmail('big2', declaredBig);
  assert(
    !r2.ok && r2.error === 'content_too_large',
    'case80-sec: an oversized declared content-length is refused up front',
  );

  const badJson = async () => new Response('not json', { status: 200 });
  const r3 = await fetchReceivedEmail('bad', badJson);
  assert(
    !r3.ok && r3.error === 'content_invalid_json',
    'case81: an unparseable hop-two body is reported, never thrown',
  );

  if (prevKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = prevKey;
}

  await testingModeCases();

  console.log(`inbound-email test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

// ── 12. Testing-mode dry runs ───────────────────────────────────────────────
//
// In testing mode every outbound is rerouted to the firm's test inbox, so the
// operator replies FROM it, playing the creator. That reply must attribute —
// and nothing else about the thread-hijack guard may loosen.

const TM_FIRM = 'firm-label-tm';
const TM_INBOX = 'replies@ex4mpl.resend.app';
const TM_TEST_RECIPIENT = 'operator.personal@example.com';
const TM_CREATOR = 'rowan@creator.example';

/**
 * Table-aware Supabase stub holding one firm, one campaign and one lead.
 * Records every insert so a case can assert what ingestInboundReply wrote.
 */
function testingModeStub(opts: {
  testingMode: boolean | null;
  firmTestRecipient?: string | null;
  memberTestRecipients?: string[];
  otherFirms?: Array<{ id: string; negotiation_inbox_email: string }>;
}) {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const sb = {
    from(table: string) {
      const b: Record<string, unknown> = {};
      const self = () => b;
      Object.assign(b, {
        select: self,
        update: self,
        eq: self,
        in: self,
        is: self,
        not: self,
        order: self,
        limit: self,
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return b;
        },
        maybeSingle: async () => {
          if (table === 'campaign_influencers') {
            return {
              data: { influencer_id: 'inf-1', campaign_id: 'camp-1', last_response_at: null },
              error: null,
            };
          }
          if (table === 'campaigns') return { data: { firm_id: TM_FIRM }, error: null };
          if (table === 'firms') {
            return {
              data: {
                testing_mode: opts.testingMode,
                test_recipient_email:
                  opts.firmTestRecipient === undefined ? TM_TEST_RECIPIENT : opts.firmTestRecipient,
              },
              error: null,
            };
          }
          if (table === 'influencers') return { data: { contact_email: TM_CREATOR }, error: null };
          return { data: null, error: null };
        },
        single: async () => ({ data: { id: `${table}-row` }, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          let data: unknown = null;
          if (table === 'firms') {
            data = [
              ...(opts.otherFirms ?? []),
              { id: TM_FIRM, negotiation_inbox_email: TM_INBOX },
            ];
          }
          if (table === 'firm_members') {
            data = (opts.memberTestRecipients ?? []).map((a) => ({ test_recipient_email: a }));
          }
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      });
      return b;
    },
  } as unknown as SupabaseClient;
  return { sb, inserts };
}

function tmEvent(to: string, from: string, emailId: string): ResendInboundEvent {
  return {
    type: 'email.received',
    created_at: '2026-10-01T15:00:00.000Z',
    data: {
      email_id: emailId,
      from,
      to: [to],
      subject: 'Re: Collaboration',
      created_at: '2026-10-01T15:00:00.000Z',
    },
  };
}

/**
 * The route's gate, step for step (src/app/api/webhooks/inbound-email/route.ts):
 * firm by inbox → correlation → creator check → admission → testing-mode check
 * → authentication (default `require` policy, no trusted authserv) → normalize
 * → ingest. Mirrored rather than imported: the route constructs supabaseAdmin()
 * from env and has no injection seam.
 */
async function routeGate(sb: SupabaseClient, event: ResendInboundEvent, from: string) {
  const msg = toInboundEmailMessage(event, { text: 'Yes, $300 works for me.', headers: { from } });
  const firm = await resolveFirmByInbox(sb, msg.envelopeRecipients);
  const correlated = correlateFromEnvelope(msg.envelopeRecipients);
  const senderVerified = correlated
    ? await senderMatchesLeadCreator(sb, correlated, msg.from)
    : false;
  const senderIsKnownCreator =
    !correlated || !senderVerified
      ? await isKnownCreatorContact(sb, msg.from, { firmId: firm?.firmId ?? null })
      : true;
  const testingMatch =
    correlated && !senderVerified
      ? await testingModeSenderMatch(sb, correlated, msg.from, {
          inboxFirmId: firm?.firmId ?? null,
        })
      : null;
  const policy = resolveInboundAuthPolicy([], {} as NodeJS.ProcessEnv);
  const auth = evaluateSenderAuthentication({
    headerValue: msg.authenticationResults,
    fromMailbox: parseFromMailbox(msg.from),
    policy,
  });
  const decision = normalizeInboundEmail(msg, {
    senderVerified,
    senderIsKnownCreator,
    senderAuthenticated: auth.authenticated,
    senderAuthVerdict: auth,
    requireSenderAuthentication: policy.requireAuthentication,
    testingModeAttribution: testingMatch !== null,
  });
  const ingested = decision.accepted ? await ingestInboundReply(decision.normalized, sb) : null;
  return { firm, testingMatch, decision, ingested };
}

async function testingModeCases() {
  const TAGGED = `replies+lead-${CI_ID}@ex4mpl.resend.app`;

  // tm1: the resend.app inbox address resolves the firm (plus tag stripped,
  // exact local+domain match of the configured inbox).
  {
    const { sb } = testingModeStub({
      testingMode: true,
      otherFirms: [{ id: 'firm-other', negotiation_inbox_email: 'replies@zz0000.resend.app' }],
    });
    const m = await resolveFirmByInbox(sb, [TAGGED]);
    assert(
      m?.firmId === TM_FIRM,
      'tm1: a +lead- tagged resend.app recipient resolves the firm whose inbox it is',
    );
    const wrongLocal = await resolveFirmByInbox(sb, [`other+lead-${CI_ID}@ex4mpl.resend.app`]);
    assert(wrongLocal === null, 'tm1: a different local part on the same resend.app domain resolves no firm');
    const wrongSub = await resolveFirmByInbox(sb, [`replies+lead-${CI_ID}@aa1111.resend.app`]);
    assert(wrongSub === null, 'tm1: the same local part on another resend.app subdomain resolves no firm');
  }

  // tm2: testing mode + From is the test inbox + valid tag → attributed AND ingested.
  {
    const { sb, inserts } = testingModeStub({ testingMode: true });
    const from = `Owen Operator <${TM_TEST_RECIPIENT.toUpperCase()}>`;
    const r = await routeGate(sb, tmEvent(TAGGED, TM_TEST_RECIPIENT, 'tm-email-2'), from);
    assert(
      r.testingMatch?.firmId === TM_FIRM,
      'tm2: the test-inbox From matches (case-insensitive, display name ignored)',
    );
    assert(r.decision.accepted, 'tm2: the dry-run reply is accepted');
    if (r.decision.accepted) {
      assert(
        r.decision.normalized.campaign_influencer_id === CI_ID,
        'tm2: ...and ATTRIBUTED to the tagged lead',
      );
      assert(r.decision.testingModeAttribution === true, 'tm2: the decision is flagged testing-mode');
      assert(
        r.decision.senderMismatch === false && r.decision.authenticationHeld === false,
        'tm2: not reported as a sender mismatch or an authentication hold',
      );
      assert(
        r.decision.normalized.sender_matched_lead === false,
        'tm2: the row still records that the From is NOT the creator on file',
      );
    }
    const row = inserts.find((i) => i.table === 'inbound_messages')?.row;
    assert(row?.campaign_influencer_id === CI_ID, 'tm2: ingestInboundReply stored the row attributed');
    assert(
      row?.sender_auth_outcome === 'testing_mode_attribution',
      'tm2: the stored row is marked sender_auth_outcome = testing_mode_attribution',
    );
    assert(r.ingested?.campaign_influencer_advanced === true, 'tm2: the lead advanced (reaches the negotiator)');
  }

  // tm3: SAME message with testing_mode false (or null) → unattributed.
  for (const mode of [false, null]) {
    const { sb, inserts } = testingModeStub({ testingMode: mode });
    const r = await routeGate(
      sb,
      tmEvent(TAGGED, TM_TEST_RECIPIENT, `tm-email-3-${mode}`),
      TM_TEST_RECIPIENT,
    );
    assert(r.testingMatch === null, `tm3(${mode}): no testing-mode match`);
    assert(
      r.decision.accepted && r.decision.normalized.campaign_influencer_id === null,
      `tm3(${mode}): queued UNATTRIBUTED`,
    );
    assert(
      r.decision.accepted && r.decision.senderMismatch === true,
      `tm3(${mode}): reported as a sender mismatch, as before`,
    );
    const row = inserts.find((i) => i.table === 'inbound_messages')?.row;
    assert(row?.campaign_influencer_id === null, `tm3(${mode}): the stored row is unattributed`);
  }

  // tm4: testing mode on, but From is some other address → unattributed.
  for (const from of [
    'attacker@evil.example',
    'operator.personal+x@example.com', // plus-tag variant is NOT the test inbox
    `"${TM_TEST_RECIPIENT}" <attacker@evil.example>`, // H1 display-name forgery
    `attacker@evil.example, ${TM_TEST_RECIPIENT}`, // multi-mailbox From
  ]) {
    const { sb } = testingModeStub({ testingMode: true });
    const r = await routeGate(sb, tmEvent(TAGGED, 'x@y.example', `tm-email-4-${from}`), from);
    assert(r.testingMatch === null, `tm4: no testing-mode match for From ${from}`);
    assert(
      r.decision.accepted && r.decision.normalized.campaign_influencer_id === null,
      `tm4: From ${from} is queued unattributed`,
    );
  }

  // tm5: no tag → refused exactly as before (the test inbox is not a creator).
  {
    const { sb, inserts } = testingModeStub({ testingMode: true });
    const r = await routeGate(sb, tmEvent(TM_INBOX, TM_TEST_RECIPIENT, 'tm-email-5'), TM_TEST_RECIPIENT);
    assert(r.testingMatch === null, 'tm5: the testing-mode check is never asked without a tag');
    assert(
      !r.decision.accepted && r.decision.reason === 'not_ours',
      'tm5: an untagged reply is refused not_ours',
    );
    assert(inserts.length === 0, 'tm5: nothing is stored');
  }

  // tm6: a per-member test_recipient override (resend.ts routes there first) counts.
  {
    const { sb } = testingModeStub({
      testingMode: true,
      firmTestRecipient: null,
      memberTestRecipients: ['tester@label.example'],
    });
    const m = await testingModeSenderMatch(sb, CI_ID, 'Tester <tester@label.example>', {
      inboxFirmId: TM_FIRM,
    });
    assert(m?.testRecipient === 'tester@label.example', 'tm6: a firm_members test_recipient override matches');
  }

  // tm7: delivered to ANOTHER firm's inbox, or no correlation → no match.
  {
    const { sb } = testingModeStub({ testingMode: true });
    const m = await testingModeSenderMatch(sb, CI_ID, TM_TEST_RECIPIENT, { inboxFirmId: 'firm-other' });
    assert(m === null, "tm7: an inbox resolving to a different firm than the lead's refuses the match");
    const none = await testingModeSenderMatch(sb, null, TM_TEST_RECIPIENT, { inboxFirmId: TM_FIRM });
    assert(none === null, 'tm7: no correlation id → no match');
  }

  // tm8: the option is inert without correlation (pure normalizer).
  {
    const d = normalizeInboundEmail(
      {
        provider: 'resend',
        providerMessageId: 'tm8',
        from: TM_TEST_RECIPIENT,
        envelopeRecipients: [TM_INBOX],
        subject: 's',
        text: 'hi',
      },
      { senderIsKnownCreator: true, testingModeAttribution: true },
    );
    assert(
      d.accepted && d.normalized.campaign_influencer_id === null && d.testingModeAttribution === false,
      'tm8: testingModeAttribution never attributes an untagged message',
    );
  }
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
