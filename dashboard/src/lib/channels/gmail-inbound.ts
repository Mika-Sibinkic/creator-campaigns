// src/lib/channels/gmail-inbound.ts
//
// Gmail reply intake adapter — behind the inbound interface,
// OAuth-gated, a NO-OP until Gmail credentials are present.
//
// When configured, pollGmailInbound() lists recent Gmail messages, normalizes
// each reply to the channel-agnostic NormalizedInbound shape and hands it to
// ingestInboundReply() — the exact same seam the simulator and (later)
// Resend/Unipile use. Dedupe is automatic: the Gmail message id is the
// external_id, and ingestInboundReply dedupes on (channel, external_id), so
// re-polling the same thread never double-ingests.
//
// ── WHY THE INTAKE IS NOT SUBJECT-TAG-GATED ANYMORE ─────────────────────────
//
// This adapter used to hard-drop every message whose subject lacked the
// `[Creator Campaigns]` tag, and search only for that tag. But resend.ts stamps the
// tag ONLY when firms.testing_mode is true — real creators must never see an
// internal tag. Net effect: turning testing mode OFF silenced the entire reply
// loop. A creator replied, the poller never fetched it, the negotiation tick
// had nothing to answer, and nothing anywhere said so.
//
// The signal that survives both modes is the plus-addressed Reply-To that
// sendOutreach stamps on every correlated send
// (`<local>+lead-<campaign_influencer_id>@<domain>`, see reply-correlation.ts).
// So the intake gate is now:
//
//     ingest when the message CORRELATES to a lead, OR carries the tag
//
// with the tag demoted to an optional narrowing hint. That keeps the old
// "a stray thread must never be processed" guarantee — arbitrary inbox mail has
// neither a `+lead-<uuid>@` address nor the tag — while letting live-mode replies
// through. Messages the gate rejects are counted (`ignored`), not silent.
//
// SECURITY: no hardcoded secrets. All auth config comes from env. Two paths:
//
//   1. LONG-LIVED (production): GMAIL_REFRESH_TOKEN + GMAIL_CLIENT_ID +
//      GMAIL_CLIENT_SECRET → exchanged at https://oauth2.googleapis.com/token
//      for a fresh access token, cached in-module for `expires_in` minus a
//      safety margin (capped at 45 min — comfortably under Google's ~1h token
//      lifetime). Preferred whenever the full trio is present. Mint the
//      refresh token once with tools/gmail-oauth-setup.mjs.
//   2. STATIC (tests / manual runs): GMAIL_ACCESS_TOKEN used as-is when the
//      refresh trio is absent. Google access tokens expire in ~1h, so this is
//      NOT viable for an always-on deployment.
//
// Optional GMAIL_USER / GMAIL_QUERY / GMAIL_MAX_MESSAGES tune the poll. No
// creds at all → { skipped: 'gmail_not_configured' }. Every network path (token
// exchange included) is wrapped so the poller NEVER throws into the tick loop;
// failures surface as a result field.
//
// Correlation to a campaign_influencer: prefer the plus-address tag on the
// reply headers (`+lead-<campaign_influencer_id>@`, legacy
// `outreach+<campaign_influencer_id>@`), else a `[Creator Campaigns] <token>` token
// embedded in the subject. A TAGGED but uncorrelated reply still lands in
// inbound_messages unmatched, for a later matcher to resolve.

import type { SupabaseClient } from '@supabase/supabase-js';
import { ingestInboundReply, type NormalizedInbound } from '../ingest-inbound';
import { correlateFromEnvelope, normalizeInboundEmail, parseFromMailbox } from './email-inbound';
import {
  isKnownCreatorContact,
  resolveFirmByInbox,
  senderMatchesLeadCreator,
  testingModeSenderMatch,
} from './inbound-attribution';
import {
  GMAIL_AUTHSERV_ID,
  evaluateSenderAuthentication,
  resolveInboundAuthPolicy,
} from './inbound-authentication';

export interface GmailPollResult {
  /** Present when the poller did no work. */
  skipped?: 'gmail_not_configured' | 'error';
  error?: string;
  /** Message ids returned by the search (before the intake gate). */
  fetched?: number;
  /** New rows written to inbound_messages. */
  ingested?: number;
  /** Messages already in the queue (deduped on gmail id). */
  deduped?: number;
  /** Ingested rows we could not correlate to a campaign_influencer. */
  unmatched?: number;
  /**
   * Fetched messages that produced no row: rejected by the intake gate (not
   * ours, or our own outbound copy), or unreadable from the Gmail API.
   */
  ignored?: number;
  /** True when GMAIL_MAX_MESSAGES cut the poll short — the backlog is real. */
  truncated?: boolean;
}

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Default search. Deliberately NOT subject-tag-gated — a live-mode reply
 * carries no tag, so `subject:"[Creator Campaigns]"` fetched exactly zero of the
 * replies that matter once testing mode was off. Bounded by recency, and by
 * GMAIL_MAX_MESSAGES below; the intake gate in normalizeGmailMessage does the
 * real filtering, so a wide search costs Gmail reads, never bad rows.
 *
 * `-in:sent -in:drafts -in:chats` matters: our OWN outbound copy carries the
 * `+lead-` Reply-To (and, in testing mode, the subject tag), so without this the
 * poller would re-ingest its own sends as creator replies. normalizeGmailMessage
 * re-checks the labels as defense in depth.
 *
 * Ops can narrow with GMAIL_QUERY (e.g. `label:creator-campaigns newer_than:2d`) on a
 * high-volume inbox.
 */
const DEFAULT_GMAIL_QUERY = '-in:sent -in:drafts -in:chats newer_than:7d';

/** Gmail's page size for messages.list. Pagination is driven by nextPageToken. */
const GMAIL_PAGE_SIZE = 100;
/**
 * Hard ceiling on message ids examined per poll. The tick runs every 5 minutes
 * against a shared inbox, so an unbounded sweep is a Gmail-quota and latency
 * risk; hitting the ceiling is REPORTED (`truncated: true`) rather than
 * silently discarding the tail, which is what maxResults=50 with no pagination
 * used to do.
 */
const DEFAULT_MAX_MESSAGES = 250;

function maxMessages(): number {
  const raw = Number(process.env.GMAIL_MAX_MESSAGES?.trim());
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_MAX_MESSAGES;
}

/**
 * Injectable fetch seam (mirrors contact-discovery's BioLinkFetcher pattern):
 * tests mock it, production defaults to global fetch. Covers BOTH the token
 * exchange and the Gmail API calls so tests can observe the Authorization
 * header without any real network.
 */
export type GmailFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface GmailPollOptions {
  fetchImpl?: GmailFetch;
  /**
   * The mailbox to poll, overriding GMAIL_USER. This is the seam the per-firm
   * `negotiation_inbox_email` wiring needs — see the TODO(inbox-wiring) in
   * pollGmailInbound. Nothing in-tree passes it yet.
   */
  user?: string | null;
}

// ── Access-token acquisition (refresh-token exchange + TTL cache) ────────────

/** Refresh the cached access token this long before Google's stated expiry. */
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000;
/** Cache cap — comfortably under Google's ~3600s access-token lifetime. */
const TOKEN_MAX_TTL_MS = 45 * 60 * 1000;

let cachedToken: { token: string; expiresAt: number } | null = null;

/** Test hook: drop the in-module access-token cache. */
export function resetGmailTokenCache(): void {
  cachedToken = null;
}

function env(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

function tokenTtlMs(expiresIn: unknown): number {
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    const ms = expiresIn * 1000 - TOKEN_SAFETY_MARGIN_MS;
    return Math.max(30_000, Math.min(ms, TOKEN_MAX_TTL_MS));
  }
  return TOKEN_MAX_TTL_MS;
}

type TokenAcquisition = { token: string } | { notConfigured: true } | { error: string };

/**
 * Resolve a usable Gmail access token. Preference order:
 *   1. refresh-token exchange (GMAIL_REFRESH_TOKEN + GMAIL_CLIENT_ID +
 *      GMAIL_CLIENT_SECRET), with an in-module TTL cache;
 *   2. static GMAIL_ACCESS_TOKEN (backward compat for tests / manual runs);
 *   3. neither → notConfigured.
 * A partial refresh trio with no static fallback is reported as an error (a
 * misconfiguration must be legible in the tick tally, not silently a no-op).
 * Never throws.
 */
async function acquireGmailAccessToken(f: GmailFetch): Promise<TokenAcquisition> {
  const refreshVars = {
    GMAIL_REFRESH_TOKEN: env('GMAIL_REFRESH_TOKEN'),
    GMAIL_CLIENT_ID: env('GMAIL_CLIENT_ID'),
    GMAIL_CLIENT_SECRET: env('GMAIL_CLIENT_SECRET'),
  };
  const staticToken = env('GMAIL_ACCESS_TOKEN');
  const { GMAIL_REFRESH_TOKEN: refreshToken, GMAIL_CLIENT_ID: clientId, GMAIL_CLIENT_SECRET: clientSecret } =
    refreshVars;

  // Preferred path: full refresh trio → exchange for a fresh access token.
  if (refreshToken && clientId && clientSecret) {
    if (cachedToken && Date.now() < cachedToken.expiresAt) return { token: cachedToken.token };
    try {
      const res = await f(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      });
      if (!res.ok) return { error: `gmail token exchange HTTP ${res.status}` };
      const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
      const token = typeof json.access_token === 'string' ? json.access_token.trim() : '';
      if (!token) return { error: 'gmail token exchange returned no access_token' };
      cachedToken = { token, expiresAt: Date.now() + tokenTtlMs(json.expires_in) };
      return { token };
    } catch (e) {
      return { error: `gmail token exchange failed: ${(e as Error).message}` };
    }
  }

  // Backward compat: static access token when the refresh trio is absent.
  if (staticToken) return { token: staticToken };

  const missing = Object.entries(refreshVars)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length < 3) {
    return { error: `gmail refresh auth incomplete: missing ${missing.join(', ')}` };
  }

  return { notConfigured: true };
}

/**
 * Pull new creator replies out of Gmail into the inbound_messages queue.
 * Works in BOTH testing and live mode — see the intake-gate note in the file
 * header. No-op (returns { skipped: 'gmail_not_configured' }) unless Gmail auth
 * env is present (see file header for the two auth paths). Never throws.
 */
export async function pollGmailInbound(
  sb: SupabaseClient,
  options: GmailPollOptions = {},
): Promise<GmailPollResult> {
  const f = options.fetchImpl ?? fetch;

  const acquired = await acquireGmailAccessToken(f);
  if ('notConfigured' in acquired) return { skipped: 'gmail_not_configured' };
  if ('error' in acquired) return { skipped: 'error', error: acquired.error };
  const token = acquired.token;

  // TODO(inbox-wiring): with no options.user this reads the env-level Gmail
  // account for the WHOLE negotiation loop. The editable firm/member
  // `negotiation_inbox_email` setting (migration 023, /settings) is STORED but
  // still NOT wired at the call site, because the only caller —
  // runNegotiationTick via /api/negotiation/tick — is a firm-agnostic Vercel
  // Cron using supabaseAdmin() with no firm_id in scope. Honoring the DB field
  // requires making the tick loop per-firm (fetch distinct firms, poll each
  // firm's inbox) — a multi-tenant redesign, not a one-liner, so it stays open.
  // The adapter side is now ready: pass the resolved inbox
  // (member.negotiation_inbox_email ?? firm.negotiation_inbox_email ?? env) as
  // GmailPollOptions.user and this honors it.
  const user = options.user?.trim() || process.env.GMAIL_USER?.trim() || 'me';
  // Gmail search: recent window, our own sends excluded. Overridable for ops
  // tuning. NOT subject-tag-gated — see DEFAULT_GMAIL_QUERY.
  const query = process.env.GMAIL_QUERY?.trim() || DEFAULT_GMAIL_QUERY;
  const cap = maxMessages();

  const result: GmailPollResult = {
    fetched: 0,
    ingested: 0,
    deduped: 0,
    unmatched: 0,
    ignored: 0,
  };
  try {
    const auth = { Authorization: `Bearer ${token}` };

    // 1. List message ids, following nextPageToken up to the cap. The old
    //    single maxResults=50 call silently dropped everything past the 50th
    //    message; now the ceiling is explicit and reported.
    const ids: string[] = [];
    let pageToken: string | null = null;
    do {
      const remaining = cap - ids.length;
      if (remaining <= 0) break;
      const listUrl =
        `${GMAIL_API}/users/${encodeURIComponent(user)}/messages` +
        `?q=${encodeURIComponent(query)}` +
        `&maxResults=${Math.min(GMAIL_PAGE_SIZE, remaining)}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const listRes = await f(listUrl, { headers: auth });
      if (!listRes.ok) {
        // A 401 means the cached/static token went stale mid-TTL (revoked, or
        // Google shortened its life). Drop the cache so the NEXT tick
        // re-exchanges instead of degrading forever.
        if (listRes.status === 401) cachedToken = null;
        return { skipped: 'error', error: `gmail list HTTP ${listRes.status}` };
      }
      const listJson = (await listRes.json()) as {
        messages?: Array<{ id: string }>;
        nextPageToken?: string;
      };
      for (const m of listJson.messages ?? []) {
        if (m.id && ids.length < cap) ids.push(m.id);
      }
      pageToken = listJson.nextPageToken ?? null;
      if (pageToken && ids.length >= cap) {
        result.truncated = true;
        break;
      }
    } while (pageToken);
    result.fetched = ids.length;

    // 2. Fetch + gate + normalize + ingest each message.
    for (const id of ids) {
      const msgUrl = `${GMAIL_API}/users/${encodeURIComponent(user)}/messages/${encodeURIComponent(id)}?format=full`;
      const msgRes = await f(msgUrl, { headers: auth });
      if (!msgRes.ok) {
        result.ignored = (result.ignored ?? 0) + 1;
        continue;
      }
      const msg = (await msgRes.json()) as GmailMessage;
      const normalized = await normalizeGmailMessage(sb, msg);
      if (!normalized) {
        result.ignored = (result.ignored ?? 0) + 1;
        continue;
      }

      const ing = await ingestInboundReply(normalized, sb);
      if (ing.deduped) result.deduped = (result.deduped ?? 0) + 1;
      else result.ingested = (result.ingested ?? 0) + 1;
      if (!normalized.campaign_influencer_id) result.unmatched = (result.unmatched ?? 0) + 1;
    }
    return result;
  } catch (e) {
    return { skipped: 'error', error: (e as Error).message };
  }
}

// ── Gmail payload shapes (only the fields we read) ──────────────────────────

export interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
  headers?: GmailHeader[];
}
interface GmailMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailPart & { headers?: GmailHeader[] };
}

/**
 * Gmail system labels that mean "this message is ours, not a creator's".
 * The query already excludes them; this is the defense-in-depth half, and it
 * matters more now that the search is not subject-tag-gated — our own outbound
 * carries the `+lead-` Reply-To and would otherwise correlate to itself.
 */
const SELF_LABELS = new Set(['SENT', 'DRAFT', 'CHAT', 'SPAM', 'TRASH']);

function header(headers: GmailHeader[] | undefined, name: string): string | null {
  if (!headers) return null;
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

function decodeBase64Url(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Prefer text/plain; walk parts; fall back to the first part carrying data.
 *
 * Returns the media type of the part it took as well as the text. That second
 * value is not cosmetic: the fallback branch happily returns text/html SOURCE
 * (an HTML-only reply has no text/plain part), and the evidence row records
 * whether the stored verbatim copy is markup or prose. Only the transport can
 * answer that; the alternative is sniffing for `<` later and guessing.
 */
function extractBodyWithType(payload: GmailPart | undefined): {
  text: string;
  mediaType: string | null;
} {
  if (!payload) return { text: '', mediaType: null };
  const walk = (part: GmailPart): { text: string; mediaType: string | null } | null => {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return { text: decodeBase64Url(part.body.data), mediaType: 'text/plain' };
    }
    if (part.parts) {
      for (const p of part.parts) {
        const found = walk(p);
        if (found) return found;
      }
    }
    if (part.body?.data) {
      return { text: decodeBase64Url(part.body.data), mediaType: part.mimeType ?? null };
    }
    return null;
  };
  return walk(payload) ?? { text: '', mediaType: null };
}

/**
 * ── SEC: only headers the RECEIVING server writes ───────────────────────────
 *
 * `Delivered-To` is stamped by Gmail's own delivering MTA, so it reports the
 * true envelope recipient. `To`, `Cc` and `Reply-To` are written by the SENDER
 * and used to be trusted here — which let anyone holding a leaked `+lead-<uuid>`
 * self-attribute a message to a creator's lead by putting it in `Cc`. They are
 * excluded deliberately; see correlateFromEnvelope.
 *
 * ── SEC (H3): X-Original-To was REMOVED ─────────────────────────────────────
 *
 * `X-Original-To` is a POSTFIX header. Gmail does not stamp it. So on this
 * transport the only `X-Original-To` that can ever be present is one the
 * MESSAGE carried — i.e. one the sender wrote — and correlateFromEnvelope scans
 * every value it is handed. That made it a free self-attribution channel: send
 * `X-Original-To: x+lead-<leaked-uuid>@anything` and the message correlates to
 * the victim's lead.
 *
 * `Delivered-To` is safe against the same trick only because Gmail PREPENDS its
 * own copy and `header()` takes `.find()` — the first match, which is Gmail's.
 * A duplicate the attacker adds sorts below it and is never read. That safety
 * is a property of ordering plus `.find()`; do not switch this to collect ALL
 * values of a header name without re-deriving it.
 */
const ENVELOPE_HEADERS = ['Delivered-To'] as const;

function envelopeValues(headers: GmailHeader[] | undefined): Array<string | null> {
  return ENVELOPE_HEADERS.map((name) => header(headers, name));
}

/**
 * Resolve campaign_influencer_id from the envelope-delivery headers.
 * Exported for tests only.
 *
 * The patterns live in channels/email-inbound.ts so Gmail and Resend cannot
 * drift on what counts as a correlation signal.
 *
 * BEHAVIOR CHANGE (security): this no longer correlates on `To`, `Cc`,
 * `Reply-To`, or a `[Creator Campaigns] <uuid>` subject token. All four are
 * sender-controlled. Gmail sets `Delivered-To` to the address mail was actually
 * delivered to — including the `+lead-` plus tag — so real replies still
 * correlate.
 */
export function correlateCampaignInfluencer(
  headers: GmailHeader[] | undefined,
): string | null {
  return correlateFromEnvelope(envelopeValues(headers));
}

/**
 * The intake gate + normalizer.
 *
 * Accepts a message when it CORRELATES to a lead (the `+lead-<ci_id>`
 * plus-address sendOutreach stamps in both testing and live mode) OR carries
 * the `[Creator Campaigns]` subject tag (testing-mode / legacy narrowing hint).
 * Requiring the tag — as this used to — dropped every live-mode reply on the
 * floor, because live sends deliberately ship an untagged subject.
 *
 * Rejects (returns null) our own SENT/DRAFT/CHAT copies first: they carry both
 * signals and would otherwise be ingested as replies from the creator.
 *
 * Covered end to end through pollGmailInbound in tests/gmail-inbound.test.ts.
 */
async function normalizeGmailMessage(
  sb: SupabaseClient,
  msg: GmailMessage,
): Promise<NormalizedInbound | null> {
  const headers = msg.payload?.headers;
  // Gmail-specific decoding stays here (base64url parts walk, snippet
  // fallback, SENT/DRAFT label check); the gate, correlation, quote-stripping
  // and NormalizedInbound assembly are the shared transport-agnostic path.
  const extracted = extractBodyWithType(msg.payload);
  const shaped = {
    provider: 'gmail',
    providerMessageId: msg.id ?? '',
    from: header(headers, 'From'),
    envelopeRecipients: envelopeValues(headers),
    subject: header(headers, 'Subject'),
    // UNCHANGED value: the extracted part, else the snippet, else ''.
    text: extracted.text || msg.snippet || '',
    // What that string IS. The snippet branch is called out explicitly because
    // Gmail's snippet is a ~200-char PREVIEW, so a verbatim copy taken from it
    // is not the message — and a stored evidence body that quietly isn't the
    // message is the failure this column set exists to end.
    bodyMediaType: extracted.text
      ? extracted.mediaType
      : msg.snippet
        ? 'text/plain; source=gmail-snippet'
        : null,
    // Sender-written, so evidence only — never correlation, never admission.
    // Joins to outreach_messages.provider_message_id for message-level
    // attribution, which the `+lead-` lead tag cannot do on its own.
    inReplyTo: header(headers, 'In-Reply-To'),
    references: header(headers, 'References'),
    receivedAt: header(headers, 'Date'),
    isSelfCopy: (msg.labelIds ?? []).some((l) => SELF_LABELS.has(l)),
    // `.find()` on an ORDERED header array, and Gmail prepends its own
    // Authentication-Results above anything the message arrived carrying. That
    // ordering is the entire reason this transport can have a trustworthy
    // verdict at all where Resend cannot — see inbound-authentication.ts.
    authenticationResults: header(headers, 'Authentication-Results'),
  };

  // Same three locks as the Resend route: correlation says which lead, the
  // sender check says who claims to have written it, and the authentication
  // verdict says whether that claim was proved. A message failing any of them
  // is queued unattributed rather than advancing a deal.
  const correlated = correlateFromEnvelope(shaped.envelopeRecipients);
  const senderVerified = correlated
    ? await senderMatchesLeadCreator(sb, correlated, shaped.from)
    : false;

  // H2: admission on identity is scoped to the firm whose negotiation inbox the
  // message was delivered to. `influencers` is shared across tenants, so an
  // unscoped question is answered across every tenant at once. Null firm fails
  // closed — see isKnownCreatorContact.
  const firm =
    !correlated || !senderVerified
      ? await resolveFirmByInbox(sb, shaped.envelopeRecipients)
      : null;
  const senderIsKnownCreator =
    !correlated || !senderVerified
      ? await isKnownCreatorContact(sb, shaped.from, { firmId: firm?.firmId ?? null })
      : true;
  // Same testing-mode dry-run rule as the Resend route: a tagged reply FROM the
  // lead's firm's own test inbox, while that firm is in testing mode.
  const testingMatch =
    correlated && !senderVerified
      ? await testingModeSenderMatch(sb, correlated, shaped.from, {
          inboxFirmId: firm?.firmId ?? null,
        })
      : null;

  const policy = resolveInboundAuthPolicy([GMAIL_AUTHSERV_ID]);
  const auth = evaluateSenderAuthentication({
    headerValue: shaped.authenticationResults,
    fromMailbox: parseFromMailbox(shaped.from),
    policy,
  });

  const decision = normalizeInboundEmail(shaped, {
    senderVerified,
    senderIsKnownCreator,
    senderAuthenticated: auth.authenticated,
    // The verdict used to be computed here, console.warn'd on failure, and
    // dropped. On THIS transport it can genuinely say yes — mx.google.com is a
    // trusted authserv-id because Google prepends its own stamp — so a passing
    // verdict is the strongest thing the system can say about who sent a reply.
    // It now lands on the row (migration 052) instead of in a log line.
    senderAuthVerdict: auth,
    requireSenderAuthentication: policy.requireAuthentication,
    testingModeAttribution: testingMatch !== null,
  });
  if (decision.accepted && decision.authenticationHeld) {
    console.warn(
      '[gmail-inbound] sender could not be authenticated — queued for human confirmation',
      { message_id: shaped.providerMessageId, campaign_influencer_id: correlated, outcome: auth.outcome },
    );
  }
  return decision.accepted ? decision.normalized : null;
}
