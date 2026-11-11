// src/lib/ingest-inbound.ts
//
// The ONE seam every inbound reply source flows through: simulator (exists),
// Resend `email.received` (later), Unipile IG webhook (later). Each source
// normalizes its payload into `NormalizedInbound` and calls
// ingestInboundReply(), which:
//
//   1. dedupes on (channel, external_id) — one row per provider message id;
//   2. classifies the reply body (keyword classifier, migration-017 path);
//   3. writes the normalized row into inbound_messages (the reply queue);
//   4. behavior-preserving mirror: inserts the inbound outreach_messages row
//      and advances campaign_influencers state — EXACTLY as the inline logic in
//      simulate-reply/route.ts did — but only when the source resolved which
//      campaign_influencer the reply belongs to. Unmatched replies land in the
//      queue for a later matcher (plus-addressing / chat_id map) to resolve.
//
// SECURITY: callers inject the Supabase client explicitly (service-role admin
// for pipeline/webhook paths). Mirrors the SEC-1 pattern in src/lib/outreach.ts
// — keeps the blast radius of the service-role key visible at the call site.

import type { SupabaseClient } from '@supabase/supabase-js';
import { bumpPrior, firmIdForCampaignInfluencer } from './channel-priors';
import { logReplyOutcome } from './learning-log';
import { classifyResponse, classificationToStatus, isOptOutReply } from './outreach';
import { cancelQueuedOutboundForOptOut, honourOptOut } from './firm-blocks';

/**
 * The channel-agnostic shape every reply source produces. `channel`,
 * `external_id`, `from_identity`, `body` come straight off the source payload;
 * `campaign_influencer_id` is filled when the source can resolve the thread
 * (simulator always can; email via plus-addressing; DM via chat_id map).
 */
export interface NormalizedInbound {
  channel: string;
  external_id: string;
  from_identity: string;
  body: string;
  campaign_influencer_id?: string | null;
  /** Provider timestamp (ISO). Defaults to now() at the DB when omitted. */
  received_at?: string;

  // ── EVIDENCE (migration 052) — write-only; nothing in the app reads these ──
  //
  // `body` above is the classifier's input: for email it has been stripped at
  // the first quote marker, which deletes a quoted contract from a reply that
  // says "Yes, I agree to these terms" above it. These fields make the
  // acceptance provable without changing what the classifier or the negotiator
  // sees. Every one is optional, so the simulator and the DM paths are
  // unaffected and simply store NULL.
  //
  // SEC: raw_body is untrusted creator text. It is written and never read back.
  // Do not add a reader that feeds it to a model — `body` is the only body that
  // reaches one, and widening that would hand an attacker a quoted-text channel
  // straight into the negotiator prompt.

  /** The provider body VERBATIM, pre-strip, capped. */
  raw_body?: string | null;
  /** 'text/plain' | 'text/html' — which part raw_body is. */
  raw_body_media_type?: string | null;
  /** Lowercase hex sha256 of raw_body exactly as stored. */
  raw_body_sha256?: string | null;
  /** True when the verbatim cap cut raw_body. */
  raw_body_truncated?: boolean | null;
  /** Length of the provider body before the cap. */
  raw_body_chars?: number | null;
  /** Did a trusted, aligned SPF/DKIM/DMARC verdict hold for the From domain. */
  sender_authenticated?: boolean | null;
  /** The AuthOutcome behind that boolean. */
  sender_auth_outcome?: string | null;
  /** Which authserv-id stamped the verdict (e.g. mx.google.com). */
  sender_auth_authserv_id?: string | null;
  /** Did the From mailbox match the correlated lead's known creator contact. */
  sender_matched_lead?: boolean | null;
  /** Message-ID this reply answers. Sender-controlled: evidence, not authorization. */
  in_reply_to?: string | null;

  /**
   * Refuse this reply when the same thread already holds the same reply (see
   * findContentDuplicate). Defaults to true for operator pastes (`manual:`
   * external ids) and false for everything else: a provider delivery is the
   * evidence of record and is never dropped for looking like an earlier
   * message. (A provider delivery that repeats an earlier PASTE is still
   * recorded, as the paste's canonical copy with no turn of its own.)
   */
  dedupe_by_content?: boolean;
}

/**
 * external_id prefix of an operator-pasted EMAIL reply ("Log response" on
 * /outreach, src/lib/manual-email-reply.ts). Lives here so ingest can tell a
 * paste from a provider delivery without importing the route's helper.
 */
export const MANUAL_EMAIL_EXTERNAL_ID_PREFIX = 'manual:';

/** external_id prefixes of a real email-provider delivery (email-inbound.ts). */
export const PROVIDER_EMAIL_EXTERNAL_ID_PREFIXES = ['resend:', 'gmail:'] as const;

/** How far back a reply is compared against replies already on the thread. */
export const MANUAL_PASTE_DEDUPE_DAYS = 14;

/**
 * Inside the 14 days, a same-words reply is only the SAME reply
 * when the earlier one is still unanswered, or arrived within this window of
 * it. An answered "can you do $300?" from last week, said again, is a new ask.
 */
export const CONTENT_DEDUPE_WINDOW_MS = 48 * 3_600_000;

/**
 * A normalized body this short or shorter is never a content
 * duplicate. "sounds good" / "ok" / "yes please" are said again for real, and
 * refusing one strands a reply the negotiator needed to see. At or below this
 * the external-id dedupe is the only one that applies.
 */
export const CONTENT_DEDUPE_MIN_CHARS = 20;

/** Inbound statuses that mean "nobody has answered this yet": pending for the
 *  tick, or held for a human. Mirrors PENDING_INBOUND_STATUSES + 'flagged'. */
const UNANSWERED_INBOUND_STATUSES = ['new', 'classified', 'flagged'];

/** inbound_messages column linking a reply to the one whose turn answered it
 *  (migration 058; ANSWERED_BY_INBOUND_COLUMN in negotiation-tick.ts). */
const ANSWERED_BY_COLUMN = 'answered_by_inbound_id';

/**
 * A reply body reduced to what a person wrote, for comparing a paste with a
 * reply the email provider already delivered: the quoted chain ("On … wrote:",
 * "-----Original Message-----", `>` lines), a signature after `--` and a
 * "Sent from my …" trailer are cut; case, curly quotes and whitespace are
 * folded. Empty when nothing is left, which never matches.
 */
export function normalizeReplyForDedupe(text: string | null | undefined): string {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^on\b.*\bwrote:$/i.test(t)) break;
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(t)) break;
    if (/^--\s*$/.test(t)) break;
    if (/^sent from my\b/i.test(t)) break;
    if (t.startsWith('>')) continue;
    kept.push(t);
  }
  kept = cutSignOff(kept);
  return kept
    .join(' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    // A dropped full stop is not a different reply.
    .replace(/[\s.!,;:]+$/, '')
    .trim();
}

/** A line that closes a message: "Thanks,", "Best", "Cheers!". */
const SIGN_OFF_LINE =
  /^(?:thanks(?: so much| again| a lot)?|thank you(?: so much)?|many thanks|thx|ty|cheers|best(?: regards| wishes)?|all the best|kind regards|warm regards|regards|sincerely|talk soon|speak soon|love|xo|xoxo)[\s,.!-]*$/i;
/** What may follow a sign-off and still be a signature (name, handle, title). */
const MAX_SIGNATURE_CHARS = 120;

/**
 * Cut a trailing sign-off and the signature under it: a provider
 * copy carries "Thanks,\nJane\n@janecreates", a paste of the same email often
 * does not. Only when something was written above it, and only when what
 * follows is short and asks nothing — "Thanks!\nActually, could we do two
 * reels?" is content, not a signature, and is kept.
 */
function cutSignOff(lines: string[]): string[] {
  for (let i = 1; i < lines.length; i++) {
    if (!SIGN_OFF_LINE.test(lines[i])) continue;
    if (!lines.slice(0, i).some((l) => l.length > 0)) continue;
    const trailer = lines.slice(i + 1).join(' ').trim();
    if (trailer.length <= MAX_SIGNATURE_CHARS && !trailer.includes('?')) return lines.slice(0, i);
  }
  return lines;
}

/** Words that turn a few extra words into a different message ("Hi, actually no"). */
const CHANGES_MEANING = /\b(?:no|not|don'?t|can'?t|won'?t|actually|but|instead|except|unless|also|however|wait)\b/;

/** The greeting WORD that may open a message. Only the word: the
 *  previous pattern also swallowed up to two words after it, so "Hey never
 *  mind, I can do the reel for $250" compared equal to "I can do the reel for
 *  $250" and the retraction was dropped as a duplicate. */
const LEADING_GREETING_WORD = /^(?:hiya|hi|hey|hello|yo|dear|good (?:morning|afternoon|evening))(?![a-z0-9'])/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Drop a leading greeting word, then (only when the caller knows it) the name
 * it greets — the creator's handle, the label, the sender — then the
 * punctuation after it. Nothing else: a word that is not a known name is
 * content ("Hey never mind", "Yo no way", "Hello not anymore").
 */
function stripLeadingGreeting(text: string, names: ReadonlyArray<string>): string {
  const g = text.match(LEADING_GREETING_WORD);
  if (!g) return text;
  let rest = text.slice(g[0].length);
  const known = [...new Set(names.map((n) => String(n ?? '').trim().toLowerCase().replace(/^@+/, '')).filter((n) => n.length >= 2))]
    .sort((a, b) => b.length - a.length);
  for (const n of known) {
    const m = rest.match(new RegExp(`^[\\s,]+@?${escapeRegExp(n)}(?![a-z0-9'])`, 'i'));
    if (m) {
      rest = rest.slice(m[0].length);
      break;
    }
  }
  return rest.replace(/^[\s,!.:;-]+/, '');
}

/**
 * The exact-comparison form of a reply: normalizeReplyForDedupe,
 * then a leading greeting (the greeting word and a KNOWN name only),
 * punctuation and apostrophes are dropped. A dot between digits and "$" are
 * kept, so "1.5k" never equals "15k" and "$180" never equals "180 views".
 */
export function canonicalReplyForDedupe(text: string | null | undefined, names: ReadonlyArray<string> = []): string {
  return stripLeadingGreeting(normalizeReplyForDedupe(text), names)
    .replace(/'/g, '')
    .replace(/(?<=\d)[.,](?=\d)/g, (m) => (m === '.' ? '\u0000' : ''))
    .replace(/[^a-z0-9$\u0000\s]+/g, ' ')
    .replace(/\u0000/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How `a` relates to `b`, for content dedupe (fail-safe):
 *
 *   'same'      exactly equal once quoted history, signature, sign-off,
 *               greeting, whitespace, punctuation and case are stripped. The
 *               only result that may DROP a reply.
 *   'similar'   a near-match: one contains the other with a short
 *               figure-free leftover, or >= 0.9 word similarity, with every
 *               figure identical. This also matches "I am NOT
 *               able", "next week" for "this week" and "story" for "reel", so a
 *               similar reply is never dropped and never negotiated: it is
 *               recorded and the thread goes to a human ("possible duplicate").
 *   'different' anything else, ingested as a new reply.
 *
 * Each side must be more than CONTENT_DEDUPE_MIN_CHARS: short replies are
 * said again for real and are never matched.
 */
export type DedupeMatch = 'same' | 'similar' | 'different';

export function compareReplyForDedupe(
  a: string | null | undefined,
  b: string | null | undefined,
  /** Names a greeting may carry on this thread (creator handle, label, sender). */
  names: ReadonlyArray<string> = [],
): DedupeMatch {
  const x = normalizeReplyForDedupe(a);
  const y = normalizeReplyForDedupe(b);
  if (x.length <= CONTENT_DEDUPE_MIN_CHARS || y.length <= CONTENT_DEDUPE_MIN_CHARS) return 'different';
  const cx0 = canonicalReplyForDedupe(a, names);
  if (cx0.length > 0 && cx0 === canonicalReplyForDedupe(b, names)) return 'same';
  return nearReply(x, y) ? 'similar' : 'different';
}

/** True only for an exact match ('same'): the only one that may drop a reply. */
export function sameReplyForDedupe(
  a: string | null | undefined,
  b: string | null | undefined,
  names: ReadonlyArray<string> = [],
): boolean {
  return compareReplyForDedupe(a, b, names) === 'same';
}

/** The near-match over two normalized bodies (see compareReplyForDedupe). */
function nearReply(x: string, y: string): boolean {
  if (x === y) return true;
  const words = (s: string) => s.replace(/[^a-z0-9$']+/g, ' ').trim().split(' ').filter(Boolean);
  const wx = words(x);
  const wy = words(y);
  const figures = (w: string[]) => w.filter((t) => /\d/.test(t)).sort().join(' ');
  // A changed price is never the same reply, however similar the rest is.
  if (figures(wx) !== figures(wy)) return false;

  const [short, long] = wx.length <= wy.length ? [wx, wy] : [wy, wx];
  const shortText = ` ${short.join(' ')} `;
  const longText = ` ${long.join(' ')} `;
  const at = longText.indexOf(shortText);
  if (at >= 0) {
    const leftover = `${longText.slice(0, at)} ${longText.slice(at + shortText.length)}`.trim();
    const leftoverWords = leftover ? leftover.split(/\s+/) : [];
    const longRaw = x.length >= y.length ? x : y;
    if (
      leftoverWords.length <= 6 &&
      leftover.length <= 40 &&
      !/\d/.test(leftover) &&
      !CHANGES_MEANING.test(leftover) &&
      // A question the other copy does not ask is content.
      (longRaw.match(/\?/g) ?? []).length === ((x.length >= y.length ? y : x).match(/\?/g) ?? []).length
    ) {
      return true;
    }
  }

  const count = (w: string[]) => {
    const m = new Map<string, number>();
    for (const t of w) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  };
  const cx = count(wx);
  const cy = count(wy);
  let inter = 0;
  let union = 0;
  for (const k of new Set([...cx.keys(), ...cy.keys()])) {
    const p = cx.get(k) ?? 0;
    const q = cy.get(k) ?? 0;
    inter += Math.min(p, q);
    union += Math.max(p, q);
  }
  return union > 0 && inter / union >= 0.9;
}

/**
 * True only when the database is telling us a COLUMN does not exist: PostgREST
 * failing to find it in its schema cache (PGRST204), or Postgres
 * undefined_column (42703). Mirrors isMissingFunctionError in channel-priors.ts.
 *
 * Why this exists: migration 052 adds the evidence columns and runs against a
 * SHARED LIVE Supabase project, so code and schema are skewed for as long as it
 * takes someone to apply it. An insert naming an absent column is rejected
 * WHOLESALE — which would turn every creator reply into a 503 until the
 * migration lands. Same shape as the pre-038 fallback in measurement-tick.ts:
 * retry the old row, keep the reply, and say so loudly.
 */
function isMissingColumnError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  if (code === 'PGRST204' || code === '42703') return true;
  const msg = typeof e?.message === 'string' ? e.message.toLowerCase() : '';
  return (
    msg.includes('could not find the') ||
    msg.includes('schema cache') ||
    (msg.includes('column') && msg.includes('does not exist'))
  );
}

export interface IngestResult {
  deduped: boolean;
  /** inbound_messages.id (the queue row). */
  inbound_message_id: string | null;
  /** outreach_messages.id of the mirrored inbound row (null when unmatched). */
  outreach_message_id: string | null;
  classification: string;
  confidence: number;
  status: 'new' | 'classified';
  campaign_influencer_advanced: boolean;
  /**
   * Set when a paste was refused because the thread already holds the same
   * reply (content dedupe). `deduped` is true as well; nothing was written.
   */
  duplicate_of?: { inbound_message_id: string; received_at: string | null } | null;
  /**
   * Set when a provider delivery repeated an operator paste already on the
   * thread: the delivery was recorded (it is the evidence of record) as that
   * paste's canonical copy, already answered by the paste's turn. `deduped` is
   * false — a row WAS written — but no turn, mirror row or stage change was.
   */
  canonical_copy_of?: { inbound_message_id: string } | null;
  /**
   * Set when the reply is SIMILAR to one already on the thread but
   * not the same. It was recorded (and mirrored onto the thread) as 'flagged',
   * the earlier one is held too if unanswered, and nothing is negotiated until
   * a human reviews them ("possible duplicate").
   */
  possible_duplicate_of?: { inbound_message_id: string } | null;
}

/**
 * The reply already on this thread that `body` repeats, if any: same
 * campaign_influencer, the same reply by sameReplyForDedupe (a
 * sign-off or greeting one copy lacks, or >= 0.9 word similarity with every
 * figure identical — not only byte-equal), inside MANUAL_PASTE_DEDUPE_DAYS,
 * and only when that is plausibly the SAME message rather than
 * a real repeat:
 *
 *   - the body is non-trivial (> CONTENT_DEDUPE_MIN_CHARS normalized), and
 *   - the earlier reply is still unanswered (pending, or held for a human), or
 *     arrived within CONTENT_DEDUPE_WINDOW_MS of this one (either side: a
 *     paste is stamped when it is pasted, a delivery when it was sent).
 *
 * `onlyPastes` restricts the match to operator pastes, for a provider
 * delivery. A read failure returns null, i.e. the reply is ingested as before — a
 * second negotiation turn is recoverable, a reply that never reaches the
 * negotiator is not.
 */
async function findContentDuplicate(
  sb: SupabaseClient,
  campaignInfluencerId: string,
  body: string,
  receivedAtIso: string,
  opts: { onlyPastes?: boolean } = {},
): Promise<{ id: string; status: string; received_at: string | null; match: 'same' | 'similar' } | null> {
  const needle = normalizeReplyForDedupe(body);
  if (needle.length <= CONTENT_DEDUPE_MIN_CHARS) return null;
  const parsed = Date.parse(receivedAtIso);
  const at = Number.isFinite(parsed) ? parsed : Date.now();
  const sinceMs = at - MANUAL_PASTE_DEDUPE_DAYS * 86_400_000;
  // Thrown or returned, a failed read is "no duplicate": this lookup now runs
  // on every provider delivery too, and must never cost one its ingest.
  let data: unknown;
  try {
    const res = await sb
      .from('inbound_messages')
      .select('id, body, received_at, status, external_id')
      .eq('campaign_influencer_id', campaignInfluencerId)
      .gte('received_at', new Date(sinceMs).toISOString());
    if (res.error) return null;
    data = res.data;
  } catch {
    return null;
  }
  const rows = (data ?? []) as Array<{
    id: string;
    body: string | null;
    received_at: string | null;
    status: string;
    external_id?: string | null;
  }>;
  const sameMessage = (r: (typeof rows)[number]) => {
    if (UNANSWERED_INBOUND_STATUSES.includes(r.status)) return true;
    const t = r.received_at ? Date.parse(r.received_at) : Number.NaN;
    return Number.isFinite(t) && Math.abs(t - at) <= CONTENT_DEDUPE_WINDOW_MS;
  };
  // An exact match wins over a near one: only 'same' may drop or fold a reply.
  let similar: (typeof rows)[number] | null = null;
  const names = rows.length > 0 ? await greetingNames(sb, campaignInfluencerId) : [];
  for (const r of rows) {
    if (opts.onlyPastes && !String(r.external_id ?? '').startsWith(MANUAL_EMAIL_EXTERNAL_ID_PREFIX)) continue;
    if (!sameMessage(r)) continue;
    const m = compareReplyForDedupe(r.body, body, names);
    if (m === 'same') return { id: r.id, status: r.status, received_at: r.received_at, match: 'same' };
    if (m === 'similar' && !similar) similar = r;
  }
  return similar ? { id: similar.id, status: similar.status, received_at: similar.received_at, match: 'similar' } : null;
}

/**
 * The names a greeting on this thread may carry: the creator's
 * handle, the label's name and its sender name (and that sender's first name).
 * Only these are stripped after "Hi"/"Hey" for the exact match. A failed read
 * returns none, which only makes an exact match LESS likely: a reply is then
 * held as similar or ingested, never dropped on a guess.
 */
async function greetingNames(sb: SupabaseClient, campaignInfluencerId: string): Promise<string[]> {
  const names: string[] = [];
  try {
    const { data: ci } = await sb
      .from('campaign_influencers')
      .select('influencer_id')
      .eq('id', campaignInfluencerId)
      .maybeSingle();
    const influencerId = (ci as { influencer_id?: string | null } | null)?.influencer_id;
    if (influencerId) {
      const { data: inf } = await sb.from('influencers').select('username').eq('id', influencerId).maybeSingle();
      const u = (inf as { username?: string | null } | null)?.username;
      if (u) names.push(u);
    }
    const firmId = await firmIdForCampaignInfluencer(sb, campaignInfluencerId);
    if (firmId) {
      const { data: firm } = await sb
        .from('firms')
        .select('name, sender_name, outreach_prefs')
        .eq('id', firmId)
        .maybeSingle();
      const f = firm as {
        name?: string | null;
        sender_name?: string | null;
        outreach_prefs?: { sender_name?: unknown } | null;
      } | null;
      for (const n of [f?.name, f?.sender_name, f?.outreach_prefs?.sender_name]) {
        if (typeof n !== 'string' || !n.trim()) continue;
        names.push(n.trim());
        const first = n.trim().split(/\s+/)[0];
        if (first && first !== n.trim()) names.push(first);
      }
    }
  } catch {
    /* fall through with what we have */
  }
  return names;
}

/**
 * A reply that is SIMILAR to one already on the thread, but not the
 * same, is recorded and never negotiated, and the thread goes to a human. The
 * earlier reply is held too when nobody has answered it yet, so the tick does
 * not negotiate one half of a pair a person has to read side by side.
 * Guarded on the status read, so a turn already under way is never undone.
 */
async function holdEarlierForReview(
  sb: SupabaseClient,
  earlier: { id: string; status: string },
): Promise<void> {
  if (earlier.status !== 'new' && earlier.status !== 'classified') return;
  try {
    await sb
      .from('inbound_messages')
      .update({ status: 'flagged' } as never)
      .eq('id', earlier.id)
      .eq('status', earlier.status);
  } catch (e) {
    console.warn('[ingest-inbound] could not hold the earlier reply for review', earlier.id, e);
  }
}

export async function ingestInboundReply(
  normalized: NormalizedInbound,
  sb: SupabaseClient,
): Promise<IngestResult> {
  const { channel, external_id, from_identity, body } = normalized;
  const campaignInfluencerId = normalized.campaign_influencer_id ?? null;
  const receivedAt = normalized.received_at ?? new Date().toISOString();

  // 1. Dedupe on (channel, external_id) — retries + fan-out never double-write.
  const { data: existing } = await sb
    .from('inbound_messages')
    .select('id, status, body, campaign_influencer_id')
    .eq('channel', channel)
    .eq('external_id', external_id)
    .maybeSingle();
  if (existing) {
    const row = existing as {
      id: string;
      status: 'new' | 'classified';
      body?: string | null;
      campaign_influencer_id?: string | null;
    };
    // A deduped delivery of a STOP still honours it. The first attempt may have
    // died between writing the inbound row and blocking the creator; the block
    // and the cancel are idempotent, so running them again costs nothing and is
    // the only way a retry can finish what the failed attempt started.
    const dedupeCi = row.campaign_influencer_id ?? campaignInfluencerId;
    if (dedupeCi && isOptOutReply(row.body ?? body)) {
      await honourOptOutForLead(sb, dedupeCi, channel, 'dedupe_retry');
    }
    return {
      deduped: true,
      inbound_message_id: row.id,
      outreach_message_id: null,
      classification: '',
      confidence: 0,
      status: row.status,
      campaign_influencer_advanced: false,
    };
  }

  // 1b. Content dedupe for operator pastes. The
  //     external_id dedupe above cannot see that a pasted reply is the one the
  //     email provider already delivered — different ids, same words — so a
  //     paste of an already-ingested reply opened a second negotiation turn
  //     and moved the offer another round.
  const contentDedupe =
    normalized.dedupe_by_content ?? external_id.startsWith(MANUAL_EMAIL_EXTERNAL_ID_PREFIX);
  // 1c. …and the other order: the operator pasted first, then the
  //     provider delivered the same email. The delivery is the evidence of
  //     record, so it is written, but as the paste's canonical copy: already
  //     answered by the paste's turn, no second turn, no second thread entry.
  const isProviderEmail =
    channel === 'email' && PROVIDER_EMAIL_EXTERNAL_ID_PREFIXES.some((p) => external_id.startsWith(p));
  let pasteOf: { id: string } | null = null;
  // Similar-but-not-equal to a reply on the thread. Recorded, never
  // dropped and never negotiated; the thread goes to a human.
  let possibleDuplicateOf: { id: string; status: string } | null = null;
  if (!contentDedupe && isProviderEmail && normalized.dedupe_by_content !== false && campaignInfluencerId) {
    const m = await findContentDuplicate(sb, campaignInfluencerId, body, receivedAt, { onlyPastes: true });
    if (m?.match === 'same') pasteOf = m;
    else if (m) possibleDuplicateOf = m;
  }
  if (contentDedupe && campaignInfluencerId) {
    const dup = await findContentDuplicate(sb, campaignInfluencerId, body, receivedAt);
    if (dup?.match === 'similar') possibleDuplicateOf = dup;
    else if (dup) {
      // The original already honoured a STOP; again is idempotent and free.
      if (isOptOutReply(body)) await honourOptOutForLead(sb, campaignInfluencerId, channel, 'dedupe_retry');
      return {
        deduped: true,
        inbound_message_id: dup.id,
        outreach_message_id: null,
        classification: '',
        confidence: 0,
        status: dup.status === 'new' ? 'new' : 'classified',
        campaign_influencer_advanced: false,
        duplicate_of: { inbound_message_id: dup.id, received_at: dup.received_at },
      };
    }
  }

  // 2. Classify the reply body (same classifier the simulator exercised).
  const { classification, confidence } = classifyResponse(body);

  // 3. Write the normalized queue row.
  //
  // `received_at_server` is deliberately ABSENT from this payload: it is the DB
  // clock (migration 052 default), and `received_at` below is the provider's
  // claim with an app-clock fallback. Sending both from here would make them the
  // same number and destroy the distinction.
  const baseRow: Record<string, unknown> = {
    channel,
    external_id,
    from_identity,
    body,
    campaign_influencer_id: campaignInfluencerId,
    received_at: receivedAt,
    // A paste's canonical copy is born answered: 'processed' is outside
    // PENDING_INBOUND_STATUSES, so no tick ever takes a turn on it.
    // A possible duplicate is held for a human: 'flagged' is outside
    // PENDING_INBOUND_STATUSES (no turn) and is what /anomalies lists.
    status: pasteOf ? 'processed' : possibleDuplicateOf ? 'flagged' : 'classified',
    classification: pasteOf
      ? { classification, confidence, duplicate_of_paste: pasteOf.id }
      : possibleDuplicateOf
        ? { classification, confidence, possible_duplicate_of: possibleDuplicateOf.id }
        : { classification, confidence },
  };
  const evidenceRow: Record<string, unknown> = {
    ...baseRow,
    raw_body: normalized.raw_body ?? null,
    raw_body_media_type: normalized.raw_body_media_type ?? null,
    raw_body_sha256: normalized.raw_body_sha256 ?? null,
    raw_body_truncated: normalized.raw_body_truncated ?? null,
    raw_body_chars: normalized.raw_body_chars ?? null,
    sender_authenticated: normalized.sender_authenticated ?? null,
    sender_auth_outcome: normalized.sender_auth_outcome ?? null,
    sender_auth_authserv_id: normalized.sender_auth_authserv_id ?? null,
    sender_matched_lead: normalized.sender_matched_lead ?? null,
    in_reply_to: normalized.in_reply_to ?? null,
  };

  // The paste link rides its own column (migration 058) when it exists; before
  // 058 it is dropped from the insert and survives in `classification` above.
  let { data: inboundRow, error: inboundErr } = await sb
    .from('inbound_messages')
    .insert((pasteOf ? { ...evidenceRow, [ANSWERED_BY_COLUMN]: pasteOf.id } : evidenceRow) as never)
    .select('id')
    .single();
  if (pasteOf && inboundErr && isMissingColumnError(inboundErr)) {
    ({ data: inboundRow, error: inboundErr } = await sb
      .from('inbound_messages')
      .insert(evidenceRow as never)
      .select('id')
      .single());
  }
  if (inboundErr && isMissingColumnError(inboundErr)) {
    // Schema skew, not a lost reply: store the row the old schema can express.
    // Loud, because the evidence columns are the point of migration 052 and a
    // silent degrade here means an acceptance that cannot be proved later.
    console.error(
      '[ingest-inbound] inbound_messages evidence columns are missing — migration 052 is not applied. ' +
        'Storing the reply WITHOUT the verbatim body or the authentication verdict.',
      inboundErr.message,
    );
    ({ data: inboundRow, error: inboundErr } = await sb
      .from('inbound_messages')
      .insert(baseRow as never)
      .select('id')
      .single());
  }
  if (inboundErr) {
    throw new Error(`inbound_messages insert failed: ${inboundErr.message}`);
  }
  const inboundId = (inboundRow as { id: string }).id;

  if (possibleDuplicateOf) await holdEarlierForReview(sb, possibleDuplicateOf);
  // This reply is held for a human, so the thread is a human's now.
  // Whatever the AI already queued on it (a counter, a "Deal, $X works", the
  // holding note announcing them) is withdrawn rather than sent behind the
  // human's back. Human-authored queued sends are untouched.
  if (possibleDuplicateOf && campaignInfluencerId) {
    // Lazy, like `audit` below: the takeover module pulls in the Supabase
    // admin client, which this module must not need at load time.
    const { withdrawQueuedAiReplies } = await import('./negotiation-takeover');
    await withdrawQueuedAiReplies(sb, campaignInfluencerId, {
      reason: 'reply_held_possible_duplicate',
      inbound_message_id: inboundId,
    });
  }

  if (pasteOf && campaignInfluencerId) {
    // The paste already put this reply on the thread (mirror row, stage) and
    // already took its turn. Only a STOP is re-honoured: idempotent and free.
    if (isOptOutReply(body)) await honourOptOutForLead(sb, campaignInfluencerId, channel, 'dedupe_retry');
    return {
      deduped: false,
      inbound_message_id: inboundId,
      outreach_message_id: null,
      classification,
      confidence,
      status: 'classified',
      campaign_influencer_advanced: false,
      canonical_copy_of: { inbound_message_id: pasteOf.id },
    };
  }

  // 4. Behavior-preserving mirror into outreach_messages + campaign_influencers,
  //    only when the reply is matched to a campaign_influencer.
  let outreachMessageId: string | null = null;
  let advanced = false;
  if (campaignInfluencerId) {
    // The opt-out runs FIRST, before the mirror insert below can throw: a STOP
    // whose outreach_messages insert failed used to leave an inbound row with
    // no block, and the provider's retry was deduped at step 1 without ever
    // reaching the block. See honourOptOutForLead.
    if (isOptOutReply(body)) {
      await honourOptOutForLead(sb, campaignInfluencerId, channel, 'ingest');
    }

    const { data: omRow, error: omErr } = await sb
      .from('outreach_messages')
      .insert({
        campaign_influencer_id: campaignInfluencerId,
        message_type: 'response',
        direction: 'inbound',
        channel,
        body,
        classification,
        classification_confidence: confidence,
        sent_at: receivedAt,
      } as never)
      .select('id')
      .single();
    if (omErr) {
      throw new Error(`outreach_messages insert failed: ${omErr.message}`);
    }
    outreachMessageId = (omRow as { id: string }).id;

    // Priors learn — a matched inbound is the 'reply' funnel event.
    // FIRST reply per creator only (read last_response_at before we stamp it):
    // the counter feeds a reply-RATE ranking, so five messages inside one
    // negotiation must count as one converted creator, not five.
    const { data: ciBefore } = await sb
      .from('campaign_influencers')
      .select('last_response_at')
      .eq('id', campaignInfluencerId)
      .maybeSingle();
    const isFirstReply =
      (ciBefore as { last_response_at: string | null } | null)?.last_response_at == null;

    const newStatus = classificationToStatus(classification);
    const { error: ciErr } = await sb
      .from('campaign_influencers')
      .update({
        status: newStatus,
        outreach_status: classification === 'not_interested' ? 'rejected' : 'responded',
        response_classification: classification,
        last_response_at: receivedAt,
      } as never)
      .eq('id', campaignInfluencerId);
    if (ciErr) {
      throw new Error(`campaign_influencers update failed: ${ciErr.message}`);
    }
    advanced = true;

    if (isFirstReply) {
      const firmId = await firmIdForCampaignInfluencer(sb, campaignInfluencerId);
      await bumpPrior(sb, { firmId, channel, event: 'reply' }); // never throws
      // Learning spine: the reply ACTUAL — pairs with the
      // reply_prediction frozen at send time. First reply per creator only,
      // matching the prior's conversion semantics. Never throws.
      await logReplyOutcome(sb, {
        campaignInfluencerId,
        channel,
        classification,
      });
    }
  }

  return {
    deduped: false,
    inbound_message_id: inboundId,
    outreach_message_id: outreachMessageId,
    classification,
    confidence,
    status: 'classified',
    campaign_influencer_advanced: advanced,
    possible_duplicate_of: possibleDuplicateOf ? { inbound_message_id: possibleDuplicateOf.id } : null,
  };
}

/**
 * Honour an opt-out, for real — for the label it was said to.
 *
 * Every creator-facing message carries an opt-out line telling the creator to
 * reply STOP. Detecting that and filing it as `not_interested` was NOT
 * honouring it: `not_interested` is scoped to one lead, so the same creator
 * stays in the pool and the next campaign contacts them again. A promise in
 * copy that the system does not keep is worse than no promise.
 *
 * The promise is "we'll take you off OUR list", and the sender is the label.
 * So the block is a firm_influencer_blocks row for the campaign's firm
 * (migration 056), which every contact path for that firm refuses — not the
 * shared influencers.blocklisted column, which used to remove the creator from
 * every OTHER label's pool too. honourOptOut falls back to the global column
 * (logged) when the per-firm write is impossible — pre-056, unresolvable firm,
 * failed write — so an opt-out is never lost. `isOptOutReply` is strict on
 * purpose (a bare STOP only when it is the whole message), so "I can't stop
 * listening to this" does not block someone keen.
 *
 * IDEMPOTENT, because it runs on a deduped retry as well as on first ingest:
 * the block write keeps the first row, and the cancel only touches rows still
 * queued.
 */
async function honourOptOutForLead(
  sb: SupabaseClient,
  campaignInfluencerId: string,
  channel: string,
  via: 'ingest' | 'dedupe_retry',
): Promise<void> {
  const { data: ciInf } = await sb
    .from('campaign_influencers')
    .select('influencer_id')
    .eq('id', campaignInfluencerId)
    .maybeSingle();
  const influencerId = (ciInf as { influencer_id: string | null } | null)?.influencer_id ?? null;
  if (!influencerId) return;
  const optOutFirmId = await firmIdForCampaignInfluencer(sb, campaignInfluencerId);
  const outcome = await honourOptOut(sb, { influencerId, firmId: optOutFirmId });
  if (outcome.scope === 'not_honoured') return;
  // Held by the dispatch gate is not enough: cancel what is queued, so no
  // stale offer is left live for a Send click or a lifted block.
  const cancelled = await cancelQueuedOutboundForOptOut(sb, {
    influencerId,
    firmId: outcome.scope === 'firm' ? outcome.firm_id : null,
  });
  // Lazy import: ./audit builds a Supabase client at module load, which makes
  // this module unimportable wherever env is absent — including this file's
  // own hermetic tests, which is exactly how a static import here broke two
  // green suites.
  const { audit } = await import('./audit');
  await audit({
    action: 'creator.opted_out',
    actor_label: 'system:inbound',
    target_type: 'influencer',
    target_id: influencerId,
    firm_id: outcome.firm_id,
    metadata: {
      campaign_influencer_id: campaignInfluencerId,
      channel,
      scope: outcome.scope,
      via,
      queued_outbound_cancelled: cancelled,
      ...(outcome.scope === 'global_fallback' ? { fallback_reason: outcome.why } : {}),
    },
  });
}
