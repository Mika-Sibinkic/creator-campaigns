// src/lib/channels/email-inbound.ts
//
// The TRANSPORT-AGNOSTIC half of email reply intake: provider payload →
// NormalizedInbound. Pure (no env, no SDK, no network, no Supabase) so every
// transport shares one normalizer and one test surface.
//
// WHY THIS EXISTS
//
// Reply intake used to live entirely inside gmail-inbound.ts, which meant the
// correlation regexes, the intake gate and the body extraction were welded to
// one provider's payload shape. Adding Resend inbound would have forked all
// three. Everything here is shape-independent: a caller hands over addresses,
// a subject and a body, whatever the wire format was.
//
// ── THE TRUST MODEL (read this before changing the gate) ────────────────────
//
// An inbound reply can advance a lead to `responded` and be handed to the
// autonomous negotiator, which can counter, accept and close a deal. So the
// question this module answers is not "is this plausibly ours?" but "what did
// the sender have to PROVE to get this far?".
//
// Three independent locks, ALL required to attribute a message to a lead:
//
//   1. ENVELOPE CORRELATION — a `+lead-<uuid>` on an address the RECEIVING
//      infrastructure attested. Only someone who received a real outreach
//      email has one.
//   2. SENDER MATCH — the From address matches that creator's known contact
//      (resolved against the DB in inbound-attribution.ts).
//   3. SENDER AUTHENTICATION — a trusted, aligned SPF/DKIM/DMARC verdict from
//      the receiving infrastructure (channels/inbound-authentication.ts).
//
// Lock 1 alone is not enough: the uuid rides in the Reply-To of every outreach
// email, so it leaks through forwards, bounces and auto-replies. Lock 2 alone
// is not enough: it says who, not which thread. And 1+2 together are still not
// enough, because BOTH are read off the message — a `From:` header costs an
// attacker nothing to write. Lock 3 is the only one that asks the sending
// domain to prove anything, and it is the reason a lying transport downgrades
// to "a human looks at it" instead of "the negotiator agrees a deal".
//
// Failing any lock does not DROP the message. It is ingested, visible, and
// unattributed — it just cannot counter, accept or close on its own.
//
// Things that are explicitly NOT proof of anything, and must never be restored
// as admission signals:
//   - the `[Creator Campaigns]` subject tag (sender writes the subject)
//   - `To` / `Cc` / `Reply-To` headers (sender writes them)
//   - being addressed to a known firm inbox (knowing an address is not a secret)
//
// WHAT IS NEW HERE: quoted-chain and signature stripping. The Gmail path never
// had it (it took Gmail's text/plain part verbatim), so every classified reply
// body carried the whole thread history beneath it. That matters because the
// body is fed to classifyResponse() and then to a model — a quoted copy of OUR
// last message contains our own offer language and reads as if the creator
// wrote it. Stripping is deliberately conservative: cut at the FIRST quote
// marker, and if that leaves nothing, keep the original text untouched.
//
// ── WHY THE VERBATIM BODY IS KEPT TOO (evidence, not classifier input) ──────
//
// Stripping is right for the classifier and WRONG for the record. A creator who
// replies "Yes, I agree to these terms" above the quoted contract had the quoted
// contract cut out of the stored row: an acceptance with no trace of the thing
// accepted. Creator Campaigns treats that email as binding instead of buying an
// e-signature vendor, and what
// a vendor actually sells is evidence packaging — so the evidence has to be
// captured here.
//
// So normalizeInboundEmail now emits BOTH: `body`, byte-identical to what it
// always was and still the only thing any classifier or model sees, and a
// verbatim copy with its sha256, which nothing in the codebase reads. The
// verbatim text was already in hand and thrown away a few lines later.

import { createHash } from 'node:crypto';
import type { NormalizedInbound } from '../ingest-inbound';
import type { AuthenticationVerdict } from './inbound-authentication';
// NOTE: subject-tag/hasSubjectTag is deliberately NOT imported here
// any more. The `[Creator Campaigns]` subject tag used to admit a message through the
// intake gate; it is sender-controlled, so it is no longer an authorization
// signal. See the security note on normalizeInboundEmail.

// ── Correlation ─────────────────────────────────────────────────────────────
//
// campaign_influencer_id is a uuid column — only a uuid-shaped token may
// correlate. A looser pattern false-positives: every testing-mode subject is
// "[Creator Campaigns] Collaboration …", which a generic {6,} token regex "matched".
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Primary signal: the correlated Reply-To sendOutreach stamps on every send. */
const LEAD_PLUS_RE = new RegExp(`\\+lead-(${UUID})@`, 'i');
/** Legacy alias; not emitted by any current send path. */
const CI_PLUS_RE = new RegExp(`outreach\\+(${UUID})@`, 'i');

/**
 * Resolve campaign_influencer_id from ENVELOPE DELIVERY values only.
 *
 * ── SEC: WHY THE INPUT IS RESTRICTED (thread-hijack fix) ────────────────────
 *
 * This used to accept any addressing header — `To`, `Cc`, `Reply-To`,
 * `X-Original-To` — plus a `[Creator Campaigns] <uuid>` subject token. Every one of
 * those is written by the SENDER, and the campaign_influencer_id travels in the
 * Reply-To of every outreach email, so it survives forwarding, bounces and
 * auto-replies. Anyone who obtained one could send a message with
 * `Cc: x+lead-<uuid>@anything` and have it attributed to the creator: the lead
 * flipped to `responded`, an inbound row written in the creator's name, and the
 * autonomous negotiator fed the attacker's text — which can agree a deal. The
 * injection guard does not help, because "yes, $2,000 works" is not an
 * injection, it is a sentence.
 *
 * Callers must therefore pass only values the RECEIVING infrastructure
 * attested, never values the message carried:
 *   - Resend: `data.to` + `received_for` (the SMTP envelope / Received `for`).
 *   - Gmail:  `Delivered-To` / `X-Original-To` (added by the receiving server).
 *
 * Correlation alone still does not advance state — see normalizeInboundEmail's
 * sender check. This is the first of two locks, not the only one.
 *
 * Regex-major, not value-major: every value is checked for the current `+lead-`
 * signal before ANY value is checked for the legacy `outreach+` one, so a
 * message carrying both correlates on the modern tag.
 */
export function correlateFromEnvelope(
  values: Array<string | null | undefined>,
): string | null {
  for (const re of [LEAD_PLUS_RE, CI_PLUS_RE]) {
    for (const v of values) {
      const m = v ? v.match(re) : null;
      if (m) return m[1];
    }
  }
  return null;
}

// ── Address parsing ─────────────────────────────────────────────────────────

/**
 * ── SEC: WHY THIS IS A PARSER AND NOT A REGEX (H1, display-name injection) ──
 *
 * This used to regex-harvest EVERY address-shaped token out of the whole header
 * value. A display name is free text, so that made the sender check forgeable
 * by writing the victim's address into it:
 *
 *     From: "jane@creator.example" <attacker@evil.example>
 *
 * The harvest returned BOTH addresses, the victim's landed in the candidate
 * set, and senderMatchesLeadCreator said yes. Executed end to end, that
 * produced byte-identical DB writes to an honest reply — `negotiating`, an
 * inbound row in the creator's name, `senderMismatch: false`, and the body
 * handed to the autonomous negotiator. `jane@x <attacker@y>` unquoted,
 * `attacker@y, jane@x` and `attacker@y (jane@x)` all worked the same way.
 *
 * So: display-name text is NEVER an address. Only the bracketed `<addr-spec>`
 * counts, or — when there are no brackets at all — an item that is ITSELF
 * nothing but an addr-spec. Anything else parses to nothing, which fails
 * closed.
 *
 * Known, deliberate loss: a quoted local part (`"john doe"@example.com`) does
 * not parse. It is vanishingly rare in practice and failing closed on it costs
 * one human confirmation, not a deal.
 */

/** Conservative addr-spec. Must match the WHOLE candidate, never a substring. */
const ADDR_SPEC_RE =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

/**
 * Split an RFC 5322 address-list into items, honouring quoted strings, angle
 * brackets and (nested) comments. Comment text is DROPPED, not emitted — that
 * is what kills the `attacker@y (jane@x)` variant.
 */
function splitAddressList(value: string): string[] {
  const items: string[] = [];
  let buf = '';
  let inQuote = false;
  let inAngle = false;
  let commentDepth = 0;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inQuote) {
      if (ch === '\\' && i + 1 < value.length) {
        buf += ch + value[i + 1];
        i++;
        continue;
      }
      if (ch === '"') inQuote = false;
      buf += ch;
      continue;
    }
    if (commentDepth > 0) {
      if (ch === '\\' && i + 1 < value.length) {
        i++;
        continue;
      }
      if (ch === '(') commentDepth++;
      else if (ch === ')') commentDepth--;
      continue; // comment content never reaches the buffer
    }
    if (ch === '"') {
      inQuote = true;
      buf += ch;
      continue;
    }
    if (ch === '(') {
      commentDepth = 1;
      continue;
    }
    if (ch === '<') {
      inAngle = true;
      buf += ch;
      continue;
    }
    if (ch === '>') {
      inAngle = false;
      buf += ch;
      continue;
    }
    // `;` terminates an RFC 5322 group (`Team: a@b, c@d;`); its members are
    // mailboxes, so both separators split.
    if ((ch === ',' || ch === ';') && !inAngle) {
      items.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  items.push(buf);
  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** One address-list item → its addr-spec, or null when it carries none. */
function addrSpecFromItem(item: string): string | null {
  const open = item.lastIndexOf('<');
  if (open !== -1) {
    const close = item.indexOf('>', open);
    if (close === -1) return null; // malformed angle-addr: refuse, don't guess
    let inner = item.slice(open + 1, close).trim();
    // Obsolete route-addr: `<@relay1,@relay2:user@host>` — the mailbox is the
    // part after the final colon.
    if (inner.startsWith('@')) {
      const colon = inner.lastIndexOf(':');
      if (colon !== -1) inner = inner.slice(colon + 1).trim();
    }
    return ADDR_SPEC_RE.test(inner) ? inner.toLowerCase() : null;
  }
  // No angle brackets: the item must be nothing BUT an addr-spec. A display
  // name is not an address no matter how address-shaped it is.
  const bare = item.trim();
  return ADDR_SPEC_RE.test(bare) ? bare.toLowerCase() : null;
}

/**
 * Parse an RFC 5322 address-list header into its addr-specs, lowercased, order
 * preserved: `Acme <a@b.com>, c@d.com` → `['a@b.com', 'c@d.com']`.
 *
 * Display-name text and comments contribute NOTHING. See the security note
 * above before loosening this.
 */
export function parseEmailAddresses(value: string | null | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const item of splitAddressList(value)) {
    const addr = addrSpecFromItem(item);
    if (addr) out.push(addr);
  }
  return out;
}

/**
 * The ONE mailbox a `From` header identifies, or null.
 *
 * Null when the value parses to zero mailboxes OR to more than one. A
 * multi-mailbox `From` is legal RFC 5322 (it then requires a `Sender:`), but it
 * is not what a creator's reply looks like, and accepting any member of the
 * list is exactly the `attacker@y, jane@x` forgery. Refusing the whole value
 * fails closed: the message is still ingested, it just does not verify.
 *
 * This — not parseEmailAddresses — is what sender identity must be built on.
 */
export function parseFromMailbox(value: string | null | undefined): string | null {
  const addrs = parseEmailAddresses(value);
  return addrs.length === 1 ? addrs[0] : null;
}

/**
 * Strip a `+tag` from an address' local part: `a+lead-<uuid>@b` → `a@b`.
 * Tenant routing needs this because outbound stamps a per-lead plus tag onto
 * the negotiation inbox, so the address a reply is actually delivered TO never
 * equals the stored `negotiation_inbox_email` verbatim.
 */
export function baseAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const m = address.trim().toLowerCase().match(/^([^@\s]+)@([A-Za-z0-9.-]+)$/);
  if (!m) return null;
  return `${m[1].split('+')[0]}@${m[2]}`;
}

// ── Body cleanup ────────────────────────────────────────────────────────────

/**
 * ── SEC/PERF: hard input ceiling for every regex in this file ───────────────
 *
 * The markers below and the HTML stripper are backtracking patterns. Run over a
 * multi-megabyte body they go quadratic: measured on this machine,
 * htmlToPlainText took 2.77s at 512KB, 11.9s at 1MB and 57.2s at 2MB, and
 * stripQuotedReply 7.5s at 2MB. That is reachable from an unauthenticated
 * webhook, so it is a CPU-exhaustion vector, not a latency nit.
 *
 * Every entry point truncates to this ceiling FIRST, which makes the worst case
 * a bounded constant regardless of what arrives. A creator's negotiation reply
 * is a few hundred bytes; 64KB of text is already far past any real message, so
 * truncation cannot lose a real answer. The transport ALSO caps the bytes it is
 * willing to download (see resend-inbound.ts) — this is the second layer.
 */
export const MAX_BODY_CHARS = 64_000;

function capInput(s: string): string {
  return s.length > MAX_BODY_CHARS ? s.slice(0, MAX_BODY_CHARS) : s;
}

/**
 * Markers that begin a quoted thread, a forwarded block, or a signature.
 * Earliest match in the body wins.
 */
const QUOTE_MARKERS: RegExp[] = [
  // Gmail/Apple attribution line: "On <date> <name> <addr@host> wrote:".
  // Anchored to end-of-line, length-bounded, AND required to contain an `@` or
  // `<` before "wrote:". That last condition is what stops prose like
  // "On Monday I sent the brief … he wrote:" from being read as an attribution
  // line and silently truncating a real reply. The span may cross a newline
  // because mail clients wrap long attribution lines mid-address.
  /^[ \t]*On\b[\s\S]{0,300}?[<@][\s\S]{0,200}?\bwrote:[ \t]*$/m,
  /^[ \t]*-{2,}[ \t]*Original Message[ \t]*-{2,}/im,
  /^[ \t]*-{3,}[ \t]*Forwarded message[ \t]*-{3,}/im,
  // Outlook's block header: a From: line immediately followed by Sent:/Date:.
  /^[ \t]*From:[ \t]*\S.*\r?\n[ \t]*(?:Sent|Date):[ \t]*\S/im,
  // Any quoted line.
  /^[ \t]*>/m,
  // RFC 3676 signature delimiter ("-- " on its own line; the trailing space is
  // routinely eaten in transit, so accept it bare).
  /^[ \t]*--[ \t]*\r?$/m,
  /^[ \t]*Sent from my \S/im,
  /^[ \t]*Get Outlook for \S/im,
];

/**
 * Cut a reply body at the first quoted-thread / signature marker.
 *
 * CONSERVATIVE BY CONTRACT: if no marker is found, or cutting would leave
 * nothing but whitespace, the original text is returned unchanged. Losing a
 * creator's actual words is far worse than keeping a quoted tail — a dropped
 * "yes, $400 works" is a dead deal, whereas a surviving quote is noise the
 * classifier already tolerated before this function existed.
 */
export function stripQuotedReply(input: string): string {
  if (!input) return '';
  const body = capInput(input);
  let cut = -1;
  for (const re of QUOTE_MARKERS) {
    const m = body.match(re);
    if (m && m.index !== undefined && (cut === -1 || m.index < cut)) cut = m.index;
  }
  if (cut <= 0) return body.trim();
  const head = body.slice(0, cut).trim();
  return head.length > 0 ? head : body.trim();
}

// ── Verbatim capture (the evidentiary half) ─────────────────────────────────

/**
 * Ceiling on the VERBATIM copy, separate from MAX_BODY_CHARS on purpose.
 *
 * MAX_BODY_CHARS (64KB) exists to bound BACKTRACKING REGEX work. The verbatim
 * copy is never matched against anything — it is hashed once, in a single linear
 * pass, and written — so the CPU argument does not apply to it and a 64KB cut
 * would throw away exactly the quoted contract this capture exists to keep. A
 * real negotiation thread with a filled contract stapled under
 * '--- Agreement terms ---' plus several quoted rounds is a few tens of KB; 256KB
 * is far past that and still an order of magnitude under the 1MB the Resend
 * transport is willing to download (MAX_CONTENT_BYTES in resend-inbound.ts).
 *
 * Hitting it is RECORDED (`truncated`), never silent: a truncated evidence copy
 * that presents itself as complete is worse than no copy at all.
 */
export const MAX_VERBATIM_BODY_CHARS = 256_000;

export interface VerbatimBody {
  /** The provider body as it arrived, pre-strip, capped. */
  text: string;
  /** Which MIME part `text` came from: 'text/plain' | 'text/html' | null. */
  mediaType: string | null;
  /** Lowercase hex sha256 over `text` exactly as stored — recomputable. */
  sha256: string;
  /** True when the cap cut it. */
  truncated: boolean;
  /** Length of the provider body BEFORE the cap. */
  chars: number;
}

/** sha256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Capture the provider body as evidence: no stripping, no entity decoding, no
 * HTML→text conversion, no trim.
 *
 * Source selection MIRRORS what the classifier path picks (text when it has
 * content, else HTML) so the two columns describe the same part of the same
 * message — but where the classifier gets htmlToPlainText(html), which deletes
 * `<blockquote>` and with it the quoted contract, this keeps the HTML SOURCE.
 * `mediaType` records which, because "is this markup?" must be a stored fact
 * rather than something a reader sniffs later.
 *
 * Returns null only when there is no body at all.
 */
export function captureVerbatimBody(
  text: string | null | undefined,
  html: string | null | undefined,
  mediaTypeHint?: string | null,
): VerbatimBody | null {
  const usePlain = !!text?.trim();
  const source = usePlain ? (text as string) : html ?? '';
  if (!source) return null;
  const chars = source.length;
  const truncated = chars > MAX_VERBATIM_BODY_CHARS;
  const stored = truncated ? source.slice(0, MAX_VERBATIM_BODY_CHARS) : source;
  return {
    text: stored,
    mediaType: mediaTypeHint?.trim().toLowerCase() || (usePlain ? 'text/plain' : 'text/html'),
    // Hash the STORED value, not the original. A hash nobody can recompute
    // against the row it sits on is decoration; `truncated` + `chars` carry the
    // "and there was more" part.
    sha256: sha256Hex(stored),
    truncated,
    chars,
  };
}

/** One RFC 5322 `<message-id>`, or null. Bounded; never a whole header dump. */
const MESSAGE_ID_RE = /<[^<>\s]{1,512}>/g;

/**
 * Which of OUR messages this reply answers: the In-Reply-To message-id, else the
 * LAST id in References (RFC 5322 §3.6.4 orders References oldest-first, so the
 * final entry is the parent when In-Reply-To is absent — some clients send only
 * References).
 *
 * SEC: both headers are written by the SENDER, so this is EVIDENCE and never
 * authorization. Nothing may correlate, admit or attribute on it. Its value is
 * that it joins to outreach_messages.provider_message_id, which is how a dispute
 * gets from "they agreed" to "they agreed to THIS message" — today the `+lead-`
 * envelope tag resolves only to a LEAD, so message-level attribution is pure
 * heuristic. Capturing it now is what makes resolving that later possible at
 * all; it does not resolve it.
 */
export function parentMessageId(
  inReplyTo: string | null | undefined,
  references: string | null | undefined,
): string | null {
  const direct = inReplyTo?.match(MESSAGE_ID_RE);
  if (direct && direct.length > 0) return direct[0];
  const chain = references?.match(MESSAGE_ID_RE);
  if (chain && chain.length > 0) return chain[chain.length - 1];
  // A bare id with no angle brackets is common enough to accept, but only when
  // the whole value is one token — never a fragment sliced out of prose.
  const bare = inReplyTo?.trim();
  if (bare && !/\s/.test(bare) && bare.length <= 512 && bare.includes('@')) return bare;
  return null;
}

const ENTITIES: Array<[RegExp, string]> = [
  [/&nbsp;/gi, ' '],
  [/&amp;/gi, '&'],
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
  [/&quot;/gi, '"'],
  [/&#39;|&apos;/gi, "'"],
];

/**
 * ── SEC/PERF: the `<`-density guard ─────────────────────────────────────────
 *
 * The 64KB ceiling bounds the worst case, but does not make it cheap. The true
 * worst case AT the cap is 64,000 bare `<` characters: every one of them is an
 * opening delimiter that never closes, so `<(script|style)…` and `<[^>]+>` each
 * rescan forward from it. Measured on this machine: 1556 ms, against 0.4 ms for
 * a real HTML reply of comparable size.
 *
 * That is NOT an outage lever — `maxDuration = 15` caps a single request and
 * one webhook cannot exceed it. It is a cost lever: the inbound route shares a
 * 30/min rate-limit bucket across all of Resend's egress IPs, so a sender can
 * spend ~1.5 CPU-seconds per request of ours for ~64KB of theirs.
 *
 * Real HTML has roughly as many `>` as `<`. A flood does not. Counting both in
 * one linear pass over an already-capped string is free, and lets the
 * pathological input skip the backtracking patterns entirely — it is not markup,
 * so there is no markup to strip, only delimiters to drop.
 */
const ANGLE_FLOOD_MIN_LT = 1_000;
const ANGLE_FLOOD_RATIO = 4;

function isAngleFlood(s: string): boolean {
  let lt = 0;
  let gt = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 60) lt++;
    else if (c === 62) gt++;
  }
  return lt >= ANGLE_FLOOD_MIN_LT && lt > gt * ANGLE_FLOOD_RATIO;
}

function decodeEntities(s: string): string {
  let out = s;
  for (const [re, ch] of ENTITIES) out = out.replace(re, ch);
  return out;
}

/**
 * Minimal HTML → text. Only used when a provider gives HTML and no plain-text
 * alternative; a full MIME/HTML stack is not worth a dependency for what is
 * almost always a two-line reply.
 */
export function htmlToPlainText(input: string): string {
  if (!input) return '';
  const capped = capInput(input);

  // Unbalanced-delimiter flood: not markup. Drop the delimiters and stop.
  if (isAngleFlood(capped)) {
    return decodeEntities(capped.replace(/[<>]/g, ' '))
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  let s = capped
    // SEC/PERF: the inner span is BOUNDED. Unbounded `[\s\S]*?` against input
    // like `<script foo ` repeated (an opening tag that never closes) forces a
    // scan to end-of-input for every opening tag — the quadratic blowup that
    // put 2MB at 57s. A bounded span makes each scan a constant, and a real
    // <script> block longer than this is not content we want anyway.
    .replace(/<(script|style)\b[\s\S]{0,4000}?<\/\1>/gi, '')
    .replace(/<!--[\s\S]{0,4000}?-->/g, '')
    // Gmail wraps the quoted thread in this; drop it before tag-stripping so
    // stripQuotedReply is not the only line of defense on HTML-only replies.
    .replace(/<blockquote[\s\S]*$/i, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── The shared normalizer ───────────────────────────────────────────────────

/** A received email, flattened from whatever the provider's wire shape was. */
export interface InboundEmailMessage {
  /** Provider slug namespacing external_id, e.g. 'resend' | 'gmail'. */
  provider: string;
  /** The provider's own message id. Dedupe key; required. */
  providerMessageId: string;
  /** Envelope sender, display name allowed. */
  from: string | null;
  /**
   * ONLY values the receiving infrastructure attested — the SMTP envelope
   * recipients. NEVER `To`/`Cc`/`Reply-To` off the message itself: those are
   * attacker-controlled and correlating on them is a thread hijack (see
   * correlateFromEnvelope). Raw values are fine; display names are tolerated.
   */
  envelopeRecipients: Array<string | null | undefined>;
  subject: string | null;
  /** text/plain body, when the provider supplies one. */
  text?: string | null;
  /** text/html body; used only when `text` is absent. */
  html?: string | null;
  /**
   * What `text` actually is, when the transport knows. Gmail's part walk falls
   * back to the first part carrying data, so `text` may hold HTML SOURCE; the
   * transport is the only layer that can say which, and the alternative is
   * sniffing markup out of a string later. Omitted → derived from which of
   * text/html was used.
   */
  bodyMediaType?: string | null;
  /** RFC 5322 In-Reply-To. Evidence for message-level attribution, never authorization. */
  inReplyTo?: string | null;
  /** RFC 5322 References. Used only when In-Reply-To is absent. */
  references?: string | null;
  /** Provider timestamp (anything Date.parse accepts). */
  receivedAt?: string | null;
  /** Provider says this is our OWN outbound copy — never ingest it as a reply. */
  isSelfCopy?: boolean;
  /**
   * The `Authentication-Results` value the RECEIVING infrastructure stamped, if
   * the transport can identify one it actually wrote (ordered headers, first
   * occurrence). Null when the transport cannot tell its own stamp from a
   * forged copy the message carried — which is the Resend case. Evaluated in
   * channels/inbound-authentication.ts against a configured authserv-id.
   */
  authenticationResults?: string | null;
}

export type InboundEmailDecision =
  | {
      accepted: true;
      normalized: NormalizedInbound;
      /**
       * True when the envelope correlated to a lead but the SENDER did not match
       * that creator's known contact. The message is queued UNATTRIBUTED
       * (campaign_influencer_id null) so a human can look at it; no state
       * advances. Callers should count this — a nonzero rate is either a
       * creator mailing from a new address or someone probing the endpoint.
       */
      senderMismatch: boolean;
      /**
       * True when the envelope correlated AND the sender matched that creator,
       * but the sender was NOT authenticated and policy requires it. The
       * message is queued UNATTRIBUTED for human confirmation: visible, but it
       * does not counter, accept or close. Distinct from senderMismatch on
       * purpose — "we believe the address, we cannot prove the sender" is a
       * different operator signal from "wrong address".
       */
      authenticationHeld: boolean;
      /**
       * True when the message was attributed on the TESTING-MODE basis: the
       * lead's firm is in testing mode and the From is that firm's own test
       * inbox (see testingModeSenderMatch in inbound-attribution.ts). Never
       * true without envelope correlation.
       */
      testingModeAttribution: boolean;
    }
  | { accepted: false; reason: 'self_copy' | 'no_message_id' | 'not_ours' | 'empty_body' };

export interface NormalizeOptions {
  /**
   * The envelope-correlated lead's known creator contact matched `from`.
   * Resolved against the database by the caller (see inbound-attribution.ts).
   * Required for the message to be ATTRIBUTED to that lead.
   */
  senderVerified?: boolean;
  /**
   * `from` matches a known creator contact for SOME lead, even if this message
   * carries no correlation tag. Admits the message to the queue (unattributed)
   * so a creator replying from a fresh thread is not silently dropped.
   */
  senderIsKnownCreator?: boolean;
  /**
   * The sending domain PROVED the From identity — a trusted, aligned SPF / DKIM
   * / DMARC verdict. Resolved by the caller via
   * channels/inbound-authentication.ts. Absent means unproven, never "assume
   * fine".
   */
  senderAuthenticated?: boolean;
  /**
   * The FULL verdict behind `senderAuthenticated`, recorded on the row so the
   * question "did the receiver say this came from the creator's domain, and
   * which receiver said so" has a durable answer. Recorded only — it is NOT a
   * second input to the gate. `senderAuthenticated` remains the single boolean
   * the gate reads, so the stored row can never claim something the gate did not
   * act on.
   *
   * Before this existed the verdict was computed on every inbound email, warned
   * to the console, and dropped. The only durable footprint of a FAILED
   * authentication was campaign_influencer_id IS NULL, which looks exactly like
   * a reply that carried no correlation tag.
   */
  senderAuthVerdict?: Pick<AuthenticationVerdict, 'outcome' | 'authservId'>;
  /**
   * Policy: may an UNAUTHENTICATED reply advance a lead autonomously? Defaults
   * to false — i.e. authentication is REQUIRED — so a caller that forgets to
   * pass a policy gets the safe behaviour rather than the old one.
   */
  requireSenderAuthentication?: boolean;
  /**
   * The caller established (testingModeSenderMatch) that the correlated lead's
   * firm is in TESTING MODE and the From is that firm's test inbox — the
   * operator replying to a rerouted outbound to play the creator in a dry run.
   * Stands in for the sender-match and authentication locks; it never stands in
   * for correlation, so it is inert on an untagged message.
   */
  testingModeAttribution?: boolean;
}

/** sender_auth_outcome marker for a row attributed on the testing-mode basis. */
export const TESTING_MODE_ATTRIBUTION_OUTCOME = 'testing_mode_attribution';

/**
 * Provider payload → NormalizedInbound, or a legible refusal.
 *
 * ── SEC: TWO INDEPENDENT LOCKS ──────────────────────────────────────────────
 *
 * ADMISSION (may this write a row at all?) requires something the sender cannot
 * mint: either a valid `+lead-<uuid>` on the ENVELOPE recipient (which only
 * someone who received a real outreach email possesses), or a `from` that
 * matches a known creator contact.
 *
 * A `[Creator Campaigns]` subject tag is NOT admission. It used to be, and it is a
 * case-insensitive substring match anywhere in a sender-controlled field — so
 * any stranger who learned the inbound address could write arbitrary rows into
 * inbound_messages, which the anomalies view then shows to every firm. The tag
 * survives only as a narrowing hint for operators, never as authorization.
 * Neither is "addressed to a known firm inbox" admission: knowing an address is
 * not proof of anything.
 *
 * ATTRIBUTION (may this advance a lead?) additionally requires the sender to
 * match that lead's known creator contact AND to be AUTHENTICATED. Correlation
 * alone is not enough, because the campaign_influencer_id rides in the Reply-To
 * of every outreach email and therefore leaks through forwards, bounces and
 * auto-replies. Correlation plus a From match is still not enough, because both
 * are things the sender wrote.
 *
 * The gate, in order:
 *   1. our own outbound copy                     → self_copy
 *   2. no provider message id                    → no_message_id
 *   3. not envelope-correlated AND sender not a known creator → not_ours
 *   4. body empty after cleanup                  → empty_body
 *   5. accepted; attributed only if correlated AND senderVerified AND
 *      (senderAuthenticated OR policy says authentication is not required),
 *      OR correlated AND testingModeAttribution (testing-mode dry run)
 */
export function normalizeInboundEmail(
  msg: InboundEmailMessage,
  options: NormalizeOptions = {},
): InboundEmailDecision {
  if (msg.isSelfCopy) return { accepted: false, reason: 'self_copy' };
  const providerMessageId = msg.providerMessageId?.trim();
  if (!providerMessageId) return { accepted: false, reason: 'no_message_id' };

  const correlated = correlateFromEnvelope(msg.envelopeRecipients);
  if (!correlated && !options.senderIsKnownCreator) {
    return { accepted: false, reason: 'not_ours' };
  }

  // EVIDENCE, captured from the SAME inputs and before any of them is altered.
  // Deliberately above the classifier path so no future edit to `raw` can reach
  // it: the two are computed from msg.text/msg.html independently.
  const verbatim = captureVerbatimBody(msg.text, msg.html, msg.bodyMediaType);

  const raw = msg.text?.trim() ? msg.text : msg.html ? htmlToPlainText(msg.html) : '';
  const body = stripQuotedReply(raw ?? '');
  if (!body.trim()) return { accepted: false, reason: 'empty_body' };

  const receivedAt =
    msg.receivedAt && !Number.isNaN(Date.parse(msg.receivedAt))
      ? new Date(msg.receivedAt).toISOString()
      : undefined;

  // ── THE THREE LOCKS ───────────────────────────────────────────────────────
  //
  // Attribute ONLY when the envelope correlated (which lead), AND the sender
  // matched that creator's known contact (who claims to have written it), AND
  // the sending domain actually PROVED that identity (whether the claim is
  // worth anything). Anything else is queued unattributed for a human.
  //
  // The third lock is the one that survives a lying transport. Every signal the
  // first two rest on is carried BY the message; if the provider's envelope
  // fields turn out to be header-derived, a forged correlation plus a forged
  // From gets an unauthenticated message queued for a person, not negotiated.
  const senderMatched = correlated !== null && options.senderVerified === true;
  const requireAuth = options.requireSenderAuthentication !== false;
  const authOk = options.senderAuthenticated === true || !requireAuth;
  // Testing-mode dry run: the caller proved the From is the lead's firm's own
  // test inbox while that firm is in testing mode. Only meaningful WITH a
  // correlation tag, and only consulted when the normal locks did not attribute.
  const testingMode =
    correlated !== null && !(senderMatched && authOk) && options.testingModeAttribution === true;
  const attributed = (senderMatched && authOk) || testingMode;

  return {
    accepted: true,
    // Unchanged meaning: the envelope named a lead and the FROM was not that
    // creator's. An authentication hold is reported separately.
    senderMismatch: correlated !== null && !senderMatched && !testingMode,
    authenticationHeld: senderMatched && !authOk && !testingMode,
    testingModeAttribution: testingMode,
    normalized: {
      channel: 'email',
      external_id: `${msg.provider}:${providerMessageId}`,
      from_identity: msg.from?.trim() || 'unknown',
      // UNCHANGED: still the stripped body, still the only field any classifier
      // or model sees. Everything added below is write-only evidence.
      body,
      campaign_influencer_id: attributed ? correlated : null,
      received_at: receivedAt,
      raw_body: verbatim?.text ?? null,
      raw_body_media_type: verbatim?.mediaType ?? null,
      raw_body_sha256: verbatim?.sha256 ?? null,
      raw_body_truncated: verbatim?.truncated ?? null,
      raw_body_chars: verbatim?.chars ?? null,
      // The gate's own boolean, not a re-derivation — see senderAuthVerdict.
      sender_authenticated: options.senderAuthenticated === true,
      // A testing-mode attribution is marked HERE so the row says on its face
      // that it advanced on the dry-run basis, not on a verified sender.
      sender_auth_outcome: testingMode
        ? TESTING_MODE_ATTRIBUTION_OUTCOME
        : options.senderAuthVerdict?.outcome ?? null,
      sender_auth_authserv_id: options.senderAuthVerdict?.authservId ?? null,
      sender_matched_lead: senderMatched,
      in_reply_to: parentMessageId(msg.inReplyTo, msg.references),
    },
  };
}
