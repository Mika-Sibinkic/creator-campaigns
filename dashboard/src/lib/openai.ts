// src/lib/openai.ts
import { appendOptOut } from './channels/outbound-envelope';
import { describeDeliverables } from './deliverables';
import { DEFAULT_DELIVERABLES } from './deliverables-store';
import { complete } from './model-provider';
import { stripEmDashes } from './no-em-dash';
import { personalityDirective, resolvePersonality, type PersonalityKey } from './personality';
import { validateReference, shouldUseReference } from './reference-guard';

export interface QueryGenerationInput {
  artist: string;
  similarArtists: string[];
  trackName?: string;
  genres?: string[];
  /**
   * firms.scraping_prefs.region, verbatim.
   *
   * This is the ONLY lever a region has on acquisition. Neither scraper takes
   * a geo, country or proxy input — `TikTokScrapeInput` has no such field and
   * no Instagram actor exposes one either — so steering the queries is the
   * whole of it. Everything downstream is a filter on what came back.
   *
   * Free text on purpose. "the Gulf Coast" or "the Southeast" mean something to a
   * model and nothing to the lookup table in creator-region.ts, so the raw
   * string goes here even when that table cannot resolve it.
   */
  region?: string | null;
  /** Platforms the campaign actually targets, e.g. ['tiktok','instagram']. */
  platforms?: string[];
  /** campaigns.id — attributes this call's model spend in api_ledger. */
  campaignId?: string | null;
}

export async function generateSearchQueries(input: QueryGenerationInput): Promise<string[]> {
  const platforms =
    input.platforms && input.platforms.length > 0 ? input.platforms : ['tiktok'];
  const platformLabel = platforms.join(' and ');
  const sys = `You generate ${platformLabel} search queries to find micro-influencers (1k–500k followers) likely to engage with a music release. Output JSON only.`;
  const user = `Target artist: ${input.artist}
Similar artists: ${input.similarArtists.join(', ') || '(none found)'}
${input.trackName ? `Track: ${input.trackName}` : ''}
${input.genres?.length ? `Genres: ${input.genres.join(', ')}` : ''}
${input.region ? `Audience region: ${input.region}. Favor creators and scenes based there, and use local wording, city and scene names where a real person searching for them would. Do not bolt the region onto every query, at most half of them.` : ''}

Return 8 short search queries (2–5 words each) that would surface music creators in this space on ${platformLabel}. Mix: artist-name queries, genre/mood queries, behavior queries (e.g. "song recommendations indie"). No quotation marks. No hashtags.

Output JSON: {"queries": ["...", "..."]}`;
  const parsed = (await complete({
    system: sys,
    user,
    schema: { queries: ['string'] },
    temperature: 0.7,
    purpose: 'discovery.search_queries',
    campaign_id: input.campaignId ?? null,
  })) as { queries?: string[] };
  return (parsed.queries ?? []).slice(0, 10);
}

// ── The label's configured voice ────────────────────────────────────────────
//
// firms.outreach_prefs is a form the label fills in: tone, things to always do,
// things to never do, and the exact sign-off they want on their own mail. Until
// now the draft path collapsed the whole object to `op.voice ?? op.tone` and
// handed that single string to the prompt as "Brand voice to honor:" — so for
// a label whose `voice` slot is its own name, the model was told to honour
// a voice consisting of the words "Example Records", and the tone, the dos,
// the donts and the sign-off never reached it at all. The label configured a
// voice and got none of it.
//
// This is where the object becomes prompt text, once, so the two call sites
// (src/lib/outreach.ts and api/campaigns/[id]/draft-all) cannot drift.

export interface OutreachVoicePrefs {
  /** outreach_prefs.voice, else outreach_prefs.tone. Free text. */
  tone?: string | null;
  /** outreach_prefs.dos — "always do" lines from onboarding. */
  dos?: string[];
  /** outreach_prefs.donts — "never do" lines from onboarding. */
  donts?: string[];
  /** outreach_prefs.signoff, verbatim as the label typed it. */
  signoff?: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter((x): x is string => x !== null);
  // Tolerate a newline blob: the onboarding form splits on newlines before it
  // writes, but a hand-edited jsonb row in the shared DB may not have.
  const one = str(v);
  return one ? one.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0) : [];
}

/** Loose equality for "this string is just the label's own name". */
function sameName(a: string | null, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return norm(a) === norm(b);
}

/**
 * Parse `firms.outreach_prefs` (jsonb, untyped) into the shape the prompt uses.
 *
 * TONE PRECEDENCE IS `tone` FIRST, NOT `voice`, and that is the opposite of
 * what the draft-all route does today.
 *
 * `tone` is the only slot anything writes: both the onboarding form and the
 * settings page set `outreach_prefs.tone`, and `voice` has no writer anywhere
 * in the app (src/app/settings/page.tsx says so in a comment). A `voice` value
 * on a live row is therefore a leftover from an earlier shape or a hand edit,
 * and preferring it — as `op.voice ?? op.tone` does — shadows the field the
 * label actually filled in with a stale one it cannot see or change.
 *
 * `labelName` lets us drop a tone that is merely the label's own name. That
 * carries no voice information and it actively misleads: "Brand voice to
 * honor: Example Records" tells a model to write in the style of a proper
 * noun.
 *
 * `legacyVoiceProfile` is the pre-migration-009 `firms.voice_profile` column,
 * still populated on older firms; its `.tone` is the last resort. Never
 * throws: a malformed row yields empty prefs and the generator falls back to
 * its own default voice, which is what it did for every firm before this
 * existed.
 */
export function resolveOutreachVoicePrefs(
  raw: unknown,
  legacyVoiceProfile?: unknown,
  labelName?: string | null,
): OutreachVoicePrefs {
  const op = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const vp = (legacyVoiceProfile && typeof legacyVoiceProfile === 'object'
    ? legacyVoiceProfile
    : {}) as Record<string, unknown>;
  const tone = [str(op.tone), str(op.voice), str(vp.tone)].find(
    (t): t is string => t !== null && t !== undefined && !sameName(t, labelName),
  );
  return {
    tone: tone ?? null,
    dos: strList(op.dos),
    donts: strList(op.donts),
    signoff: str(op.signoff),
  };
}

/**
 * The sign-off as it may appear in a body — em dash removed.
 *
 * A label's `outreach_prefs.signoff` can be a literal string like "\u2014 Example
 * Records". Em dashes are a banned tell (checkDraftCopy bans /\u2014/ outright,
 * because generated copy leaks them), so honouring that field verbatim
 * would have made EVERY draft fail the validator, then fail it again on the
 * retry, then fail it on the deterministic fallback too — at which point
 * generateOutreachDraft throws by design and the campaign produces zero
 * drafts. The label's intent is the name, not the punctuation, so the leading
 * dash marker is dropped and an internal one becomes a comma.
 */
export function sanitizeSignoff(signoff: string | null | undefined): string | null {
  const raw = str(signoff);
  if (!raw) return null;
  const cleaned = raw
    .replace(/^[\s\u2013\u2014-]+/, '')
    .replace(/[\u2013\u2014]/g, ', ')
    .replace(/\s*,\s*,\s*/g, ', ')
    .replace(/\s+,/g, ',')
    .replace(/,(?=\S)/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Who the message is actually from, in the order a creator needs it.
 *
 * A real human's name is used when one is configured (firms.sender_name /
 * firm_members.sender_name — the same field resend.ts already resolves the
 * From header from). When none is, we sign as the label. We never let the model
 * choose: an unknown account signing a real name that belongs to nobody is a
 * worse trust signal than no name at all, and it is unanswerable — the creator
 * cannot look that person up.
 */
export function resolveSignoff(input: {
  prefsSignoff?: string | null;
  senderName?: string | null;
  labelName?: string | null;
}): string | null {
  return (
    sanitizeSignoff(input.prefsSignoff) ??
    str(input.senderName) ??
    str(input.labelName)
  );
}

/** Render the label's configured voice as prompt lines. Empty when unset. */
export function voicePrefsBlock(prefs: OutreachVoicePrefs | undefined): string[] {
  if (!prefs) return [];
  const out: string[] = [];
  if (prefs.tone) out.push(`Tone the label asked for: ${prefs.tone}`);
  if (prefs.dos?.length) {
    out.push('The label always wants you to:');
    out.push(...prefs.dos.map((d) => `  - ${d}`));
  }
  if (prefs.donts?.length) {
    out.push('The label never wants you to:');
    out.push(...prefs.donts.map((d) => `  - ${d}`));
  }
  return out;
}

export interface DraftPersonalizationInput {
  firmVoice: string;
  artistName: string;
  trackName?: string;
  releaseDate?: string;
  /** campaigns.id — attributes draft + reference-guard model spend in api_ledger. */
  campaignId?: string | null;
  /** Voice dial. Defaults to the resolved firm/env personality. */
  personality?: PersonalityKey;
  /**
   * firms.name — the label. REQUIRED in practice, optional in the type only so
   * an un-updated call site still compiles.
   *
   * The body used to say "We're promoting X" and never once said who "we" are.
   * An unknown account claiming to represent an artist the creator has not
   * heard of, with no named sender, is the exact shape of every brand-deal scam
   * in a creator's DM requests. When this is absent the copy degrades to
   * "the label behind <artist>", which is at least true, and the draft is still
   * weaker than it needs to be.
   */
  labelName?: string | null;
  /**
   * firms.sender_name / firm_members.sender_name — a real human, if the label
   * configured one. NEVER invented. resolveSignoff() decides what actually
   * lands in the body.
   */
  senderName?: string | null;
  /** firms.outreach_prefs, parsed by resolveOutreachVoicePrefs(). */
  prefs?: OutreachVoicePrefs;
  /**
   * The surface this message goes out on. Most scraped creators have no email
   * address, so `dm` is the majority case, and a DM is not a short email: the
   * queue throws the subject away, so the body has to carry everything.
   */
  channel?: 'email' | 'dm';
  /**
   * The concrete ask, from describeDeliverables() — e.g. "1 30-second reel and
   * 1 15-second story within two weeks".
   *
   * The old copy asked for "a paid post", which is not a thing a creator can
   * price, schedule or decline. Defaults to the standing default package so the
   * ask is concrete even on a call site that has not resolved one.
   */
  deliverables?: string;
  /** Platform label for the ask, e.g. 'TikTok'. Purely descriptive. */
  platform?: string | null;
  /**
   * Where a reply lands, named in the opt-out line so the instruction is
   * verifiable. Omitted → the line says "reply" without an address.
   */
  replyAddress?: string | null;
  creator: {
    handle: string;
    bio?: string;
    recentPosts: { hook: string; views?: number; hashtags?: string[]; postedAt?: string }[];
  };
}

/** Hooks older than this are never cited — "recent" claims about years-old
 *  posts (years-old posts pitched as "recent") read as bot spam. */
export const REFERENCE_MAX_AGE_DAYS = 120;

interface SafeReference {
  hook: string;
  /** False when the post is commentary/cover of someone ELSE's work. */
  creatorIsAuthor: boolean;
}

/**
 * Pick a reference safe to cite as the creator's OWN content.
 * Walks up to 3 hooks (age-filtered) and returns the first that passes the
 * provenance guard plus its authorship verdict; returns null when none are
 * safe, so draft-gen opens generically instead of misattributing.
 */
async function pickSafeReference(
  input: DraftPersonalizationInput,
  nowMs = Date.now(),
): Promise<SafeReference | null> {
  const maxAgeMs = REFERENCE_MAX_AGE_DAYS * 24 * 3600 * 1000;
  const candidates = input.creator.recentPosts
    .filter((p) => {
      if (!p.postedAt) return true; // age unknown — allowed, but never called "recent"
      const t = Date.parse(p.postedAt);
      return Number.isNaN(t) || nowMs - t <= maxAgeMs;
    })
    .map((p) => (p.hook ?? '').trim())
    .filter((h) => h.length > 0)
    .slice(0, 3);
  for (const hook of candidates) {
    const verdict = await validateReference({
      influencer_post: hook,
      artist_name: input.artistName,
      track_name: input.trackName ?? null,
      campaign_id: input.campaignId ?? null,
    });
    if (shouldUseReference(verdict)) {
      return { hook, creatorIsAuthor: verdict.creator_is_author };
    }
  }
  return null;
}

// ── Post-generation copy validator ─────────────────────────────────────────
// Prompt-only bans measurably leak ("excited", "thrilled" and em dashes all
// show up in copy whose prompt explicitly banned them).
// Every draft passes through this deterministic check; violations trigger one
// constrained retry, then a plain safe fallback.

const BANNED_PHRASES: RegExp[] = [
  /—/,
  /\b(thrilled|excited|amazing|incredible|obsessed|huge fan|vibrant)\b/i,
  /hope this (email )?finds you well/i,
  /hope you'?re doing well/i,
  /wanted to reach out/i,
  /aligns? (perfectly|beautifully|so well)/i,
  /\b(perfect|great) fit\b/i,
  /shines? through/i,
  /unique (spin|style|voice|sound)/i,
  /caught (our|my) (attention|eye)/i,
  /resonat(e|es|ed|ing)/i,
  // "recent" is banned outright: post timestamps are unreliable at draft time
  // and a model will happily call a 4-year-old post "recent."
  /\brecent(ly)?\b/i,
];

/** Framing verbs that assert the creator's work belongs to someone else. */
const DERIVATIVE_FRAMING = /\b(your |their )?(take|cover|version|rendition|spin|remix) (on|of)\b/i;

/**
 * Neutralise apostrophes that are part of a word before any quote-matching runs.
 *
 * The title regexes below treat `'` as an opening quote, so two ordinary
 * contractions read as a quoted span: "Ada Sample has closed, so we aren't
 * taking it further, that's why" matched `artist ... 't taking it further,
 * that ...` and was reported as "names a quoted track title for the artist".
 *
 * That fires on real copy — any body that mentions the artist and then uses two
 * contractions inside one sentence, whenever the campaign has no track_name,
 * which is the normal case. The cost was silent: the draft was rejected, retried,
 * and fell through to deterministic copy for a title it never named. Contractions
 * are also unavoidable here, because the prompt asks for them ("Contractions are
 * good").
 *
 * A single-character substitution, so every offset and length is preserved and
 * regexes built from a masked span still match masked text.
 */
const APOS_SENTINEL = '\u0001';

function maskApostrophes(text: string): string {
  return text.replace(/([A-Za-z])['’]([A-Za-z])/g, (_m, a, b) => `${a}${APOS_SENTINEL}${b}`);
}

function unmaskApostrophes(text: string): string {
  return text.split(APOS_SENTINEL).join("'");
}

/** Quoted spans (straight or typographic) of 3+ chars in a text. */
function quotedSpans(text: string): string[] {
  const out: string[] = [];
  const re = /["“”'‘’]([^"“”'‘’\n]{3,80})["“”'‘’]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1].trim());
  return out;
}

/**
 * Self-introductions in the copy that name a person we have no record of.
 *
 * Three high-signal shapes only ("I'm Dana", "this is Dana", "Dana here") and a
 * generous allow-list, because a false positive costs one constrained retry and
 * then the deterministic fallback, while a false NEGATIVE is a cold message to a
 * stranger signed by somebody who does not exist. That is the single worst trust
 * signal a first touch can carry, and the old prompt invited it: it asked for "a
 * first name" and was given no name to use.
 */
function inventedPersonNames(body: string, allowed: (string | null | undefined)[]): string[] {
  const ok = new Set<string>();
  for (const a of allowed) {
    if (typeof a !== 'string') continue;
    for (const tok of a.split(/[^A-Za-z']+/)) {
      if (tok.length > 1) ok.add(tok.toLowerCase());
    }
  }
  // Words that follow "I'm"/"this is" constantly and are never a name.
  const notNames = new Set([
    'a', 'an', 'the', 'i', 'we', 'writing', 'reaching', 'working', 'not', 'just',
    'here', 'happy', 'glad', 'also', 'still', 'going', 'looking', 'hoping',
    'sure', 'sorry', 'one', 'it', 'my', 'our', 'your', 'in', 'on', 'with',
  ]);
  const out: string[] = [];
  const patterns = [
    /\bI'?m\s+([A-Z][a-z]{1,15})\b/g,
    /\bthis is\s+([A-Z][a-z]{1,15})\b/gi,
    /(?:^|[.!?]\s+|\n)([A-Z][a-z]{1,15})\s+here\b/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(body)) !== null) {
      const name = m[1];
      const lower = name.toLowerCase();
      if (notNames.has(lower) || ok.has(lower)) continue;
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

export interface DraftCheckInput {
  body: string;
  subject: string;
  artistName: string;
  trackName?: string | null;
  creatorBio?: string | null;
  creatorIsAuthor: boolean;
  releasePast: boolean;
  /**
   * The exact sign-off the body must end with, from resolveSignoff().
   *
   * Checked structurally rather than asked for in the prompt, because the
   * prompt used to say "sign off plainly with a first name or the label name"
   * while NO name was passed in at all — so the model was free to invent a
   * person and put them at the bottom of a real message to a real creator.
   * Omit to skip the check (thread copy, where no sign-off is threaded).
   */
  requiredSignoff?: string | null;
  /**
   * Names the copy is allowed to introduce as a human: the configured sender,
   * the label, the artist. Any OTHER first-person self-introduction is an
   * invented person. Only enforced when `requiredSignoff` is also set, so this
   * cannot fire on callers that do not plumb identity at all.
   */
  allowedNames?: (string | null | undefined)[];
}

/** Returns human-readable violations; empty array = clean. Exported for tests. */
export function checkDraftCopy(input: DraftCheckInput): string[] {
  const text = `${input.subject}\n${input.body}`;
  const violations: string[] = [];
  for (const re of BANNED_PHRASES) {
    const m = text.match(re);
    if (m) violations.push(`banned phrase "${m[0]}"`);
  }
  if (input.creatorIsAuthor && DERIVATIVE_FRAMING.test(text)) {
    violations.push(
      'calls the creator\'s own original a take/cover/version. Never frame their original work as derivative',
    );
  }
  if (input.releasePast && /\bupcoming\b/i.test(text)) {
    violations.push('calls an already-released track "upcoming"');
  }
  // No track supplied → the draft must not attribute any quoted title to the
  // artist. Live failure: with track_name NULL the model grabbed the
  // creator's own single out of her bio and called it the artist's release.
  const artist = input.artistName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Masked once, used by both title rules: a contraction is not a quote mark.
  const masked = maskApostrophes(text);
  if (!input.trackName) {
    const attributedTitle = new RegExp(`${artist}[^.\\n]{0,50}["“”'‘’][^"“”'‘’\\n]{3,}["“”'‘’]`, 'i');
    if (attributedTitle.test(masked)) {
      violations.push('names a quoted track title for the artist when no track was supplied');
    }
  }
  // Never echo a title quoted in the CREATOR's bio, regardless of trackName.
  //
  // This used to require the title and the artist name to sit within 80
  // non-period characters of each other. That proximity window was a
  // false-positive guard, and a sentence boundary defeated it: a draft like
  // "...the label behind Ada Sample. We're putting paid promotion behind
  // "Glass Harbor"..." would slip through while meaning exactly what the rule
  // exists to catch, because
  // the creator reads a quoted title in a pitch as the thing being pitched.
  //
  // So the test is containment now. If the creator's bio quotes "Glass Harbor"
  // and our copy quotes "Glass Harbor", it does not matter how many sentences
  // apart the artist's name is: the creator cannot tell whose song we mean, and
  // on this campaign we are claiming it is the artist's. The narrower version
  // was checked by tests/draft-degradation.test.ts case 6 and passed only
  // because the old fallback happened to put the two in one clause.
  for (const span of quotedSpans(maskApostrophes(input.creatorBio ?? ''))) {
    if (span.length < 3) continue;
    if (masked.toLowerCase().includes(span.toLowerCase())) {
      violations.push(
        `echoes the creator's own title "${unmaskApostrophes(span)}". In a pitch for ${input.artistName} a quoted title reads as the thing being pitched, which is misattribution`,
      );
    }
  }

  // ── Identity: sign with a real name or the label, never an invented person ─
  if (input.requiredSignoff) {
    const want = input.requiredSignoff.trim().toLowerCase();
    const end = input.body.replace(/\s+$/, '').toLowerCase();
    if (!end.endsWith(want)) {
      violations.push(
        `does not sign off as "${input.requiredSignoff}". The sign-off is the label's, not the model's to choose`,
      );
    }
    for (const invented of inventedPersonNames(input.body, input.allowedNames ?? [])) {
      violations.push(
        `introduces a person called "${invented}" who is not the configured sender, the label or the artist. Never invent a human`,
      );
    }
  }

  return violations;
}

/** Where a draft's copy came from. Persisted so an operator can tell them apart. */
export type DraftSource = 'model' | 'fallback';

/**
 * Markers written to outreach_messages for a deterministic (non-model) draft.
 * Both columns already exist (supabase/migrations/003_base_schema.sql), so marking
 * degraded copy needs NO new migration. Grep either one to find every draft a
 * provider outage produced:
 *   select count(*) from outreach_messages where generation_model = 'deterministic-fallback';
 */
export const FALLBACK_DRAFT_MODEL = 'deterministic-fallback';
export const FALLBACK_DRAFT_TEMPLATE = 'initial_email_fallback_v1';
/** Template marker for model-written copy (unchanged; kept here so both live together). */
export const MODEL_DRAFT_TEMPLATE = 'initial_email_v1';

export interface GeneratedDraft {
  subject: string;
  body: string;
  source: DraftSource;
  /**
   * How many model completions actually came BACK. 0 means the provider layer
   * never produced output, which is what the caller bills on: a 429 storm
   * costs nothing and must not be charged against the spend cap.
   */
  modelCalls: number;
  /** Present only when source === 'fallback' — why the run degraded. */
  degradedReason?: string;
}

/** The concrete ask, defaulted so no first touch can say "a paid post". */
export function firstTouchAsk(deliverables?: string | null): string {
  const given = str(deliverables);
  return given ?? describeDeliverables(DEFAULT_DELIVERABLES);
}

/** Human-readable platform for the ask line, e.g. "TikTok". */
function platformLabel(platform?: string | null): string | null {
  const p = str(platform);
  if (!p) return null;
  const known: Record<string, string> = {
    tiktok: 'TikTok',
    instagram: 'Instagram',
    youtube: 'YouTube',
  };
  return known[p.toLowerCase()] ?? p;
}

/**
 * The deterministic first touch. Used when two generations both fail
 * validation, and it is also the reference for what the prompt above is asking
 * the model to write.
 *
 * WHAT WAS WRONG WITH THE OLD ONE, and what each line here is answering:
 *
 *   "Hi @handle, We're promoting "Track" from Ada Sample and think it could
 *    sit well with your audience. Would you be open to a paid post? If that
 *    sounds interesting, just reply and we'll sort the details."
 *
 *   - "We're" — the label was never named in the body. An unknown account
 *     claiming to represent an artist you have not heard of, with no named
 *     sender, is the shape of every brand-deal scam in a creator's DM requests.
 *   - "a paid post" — of what? A video, a story, using the sound? For how long?
 *     Nothing a creator can price, schedule, or decline on the merits.
 *   - "just reply and we'll sort the details" — among the most common scam
 *     phrasings there is. It asks for a reply in exchange for nothing.
 *   - No sign-off at all, so the model was free to invent a person.
 *   - No opt-out, on cold commercial email from a real sending domain.
 *
 * The subject also carried the only clear statement in the message, and ~97% of
 * this pool is reached by DM, where the queue throws the subject away. So the
 * DM body below stands alone.
 */
export function buildFirstTouchFallback(input: DraftPersonalizationInput): {
  subject: string;
  body: string;
} {
  const label = str(input.labelName);
  const artist = input.artistName;
  const release = input.trackName ? `"${input.trackName}"` : 'their new release';
  const ask = firstTouchAsk(input.deliverables);
  const plat = platformLabel(input.platform);
  const signoff = resolveSignoff({
    prefsSignoff: input.prefs?.signoff,
    senderName: input.senderName,
    labelName: input.labelName,
  });
  // Naming the label is the whole point; when firms.name was not plumbed, say
  // the true weaker thing rather than "we".
  const whoWeAre = label
    ? `${label}, the label behind ${artist}`
    : `the label behind ${artist}`;

  if (input.channel === 'dm') {
    const lines = [
      `Hi @${input.creator.handle}, I'm with ${whoWeAre}. We pay creators to feature ${release}: ${ask}. What's your rate for that? A no is a fine answer.`,
    ];
    if (signoff) lines.push('', signoff);
    return {
      // Not shown to the creator on a DM; kept for operator search.
      subject: label ? `Paid collab with ${artist} (${label})` : `Paid collab with ${artist}`,
      body: lines.join('\n'),
    };
  }

  const askLine = plat
    ? `The ask: ${ask}, featuring the song on ${plat}.`
    : `The ask: ${ask}, featuring the song.`;
  const body = [
    `Hi @${input.creator.handle},`,
    '',
    `I'm writing from ${whoWeAre}. We're putting paid promotion behind ${release} and want a few creators to feature it.`,
    '',
    `${askLine} It's a paid collab. Tell me what you charge for that and I'll come straight back with what we can do.`,
    '',
    `If it's not for you, say so and that's the end of it.`,
  ];
  if (signoff) body.push('', signoff);
  return {
    subject: label ? `Paid collab with ${artist} (${label})` : `Paid collab with ${artist}`,
    body: body.join('\n'),
  };
}

/**
 * Produce one outreach draft, degrading honestly rather than producing nothing.
 *
 * Three exits:
 *   - model copy that passes checkDraftCopy      → source 'model'
 *   - model unusable (provider down, or copy rejected twice, or empty)
 *     AND the deterministic fallback passes checkDraftCopy → source 'fallback'
 *   - the deterministic fallback ALSO fails checkDraftCopy → throws
 *
 * That last exit is deliberate. A provider exception used to escape this
 * function entirely and `fallbackDraft` was dead code on that path, so a burst
 * of provider 429s lost nearly every draft in a batch. Making it reachable must
 * not become a hole in the copy validator, so degraded copy goes through the
 * exact same gate — and when it cannot pass, we produce nothing and say why.
 */
export async function generateOutreachDraft(
  input: DraftPersonalizationInput,
): Promise<GeneratedDraft> {
  const pkey = input.personality ?? resolvePersonality();
  const ref = await pickSafeReference(input);
  const releaseMs = input.releaseDate ? Date.parse(input.releaseDate) : NaN;
  const releasePast = Number.isFinite(releaseMs) && releaseMs < Date.now();

  const channel = input.channel ?? 'email';
  const isDm = channel === 'dm';
  const ask = firstTouchAsk(input.deliverables);
  const plat = platformLabel(input.platform);
  const label = str(input.labelName);
  const signoff = resolveSignoff({
    prefsSignoff: input.prefs?.signoff,
    senderName: input.senderName,
    labelName: input.labelName,
  });

  /**
   * Stamp the opt-out on, after validation, never before.
   *
   * Deterministic on purpose: a CAN-SPAM §7704(a)(3) mechanism is not something
   * to ask a model for and then hope it complied. It goes on AFTER the validator
   * so the sign-off check still sees the body ending on the label's sign-off,
   * and the line itself is asserted validator-clean in tests/first-touch.test.ts
   * rather than re-checked on every draft.
   */
  const withOptOut = (body: string) =>
    appendOptOut(body, { channel, replyAddress: input.replyAddress ?? null });

  // Humanizer principles baked into the instructions: kill em-dashes, hype, the
  // rule-of-three, robotic polish, and the "hope this finds you well" opener.
  //
  // On top of that, the ANSWERABILITY block. Everything above it is about not
  // sounding like a bot; that block is about the message being worth answering
  // at all. A creator triages a cold pitch on four questions — who is this, for
  // whom, what exactly do you want, and how do I get out — and the old prompt
  // answered none of them, which is why a well-written one still got deleted.
  const sys = [
    isDm
      ? `You write one short first-contact DM from a music label to a creator${plat ? ` on ${plat}` : ''} about a paid collab.`
      : `You write one short first-contact email from a music label to a creator${plat ? ` on ${plat}` : ''} about a paid collab.`,
    'Sound like a real person who works at this label, not a marketing bot.',
    `Voice: ${personalityDirective(pkey)}`,
    ...voicePrefsBlock(input.prefs),
    // The legacy single-string voice seam. Still carries the label's campaign
    // notes (src/lib/outreach.ts labelNotes), so it is kept, not replaced.
    ...(str(input.firmVoice) ? ['Brand voice to honor:', input.firmVoice] : []),
    '',
    'THE MESSAGE MUST BE ANSWERABLE WITHOUT A REPLY. Mandatory, all of them:',
    label
      ? `- Name the label in the BODY: ${label}. "We" on its own, with no name, is what every fake brand deal says.`
      : `- Say plainly that you are writing from ${input.artistName}'s label.`,
    `- Name the artist: ${input.artistName}.`,
    `- Name the ask concretely and completely: ${ask}. Never write "a paid post", "a collab" or "a partnership" and stop there. A creator has to be able to price it and put it in a calendar.`,
    '- Say plainly that it is paid.',
    '- Ask what they charge for that exact ask.',
    '- Give them a one-clause way out, e.g. that a no is a fine answer. Do not beg for a reply.',
    signoff
      ? `- End the body with exactly this, on its own final line, character for character: ${signoff}`
      : '- Do not sign a personal name.',
    '',
    'Rules:',
    isDm
      ? '- Under 70 words. There is no subject line on a DM, so the body has to stand alone. Output a subject anyway; it is only used for internal search.'
      : '- 4 to 6 short lines. Vary sentence length. A short fragment is fine if it sounds natural.',
    '- No em dashes anywhere. Use periods or commas.',
    '- No hype or flattery words (thrilled, excited, amazing, incredible, obsessed, huge fan, vibrant, love your content).',
    '- No "I hope this finds you well", no "hope you\'re doing well", no "I wanted to reach out".',
    '- Never say "just reply and we\'ll sort the details" or anything like it. It asks for a reply in exchange for nothing and it is a known scam tell.',
    '- Never use the word "recent" or claim recency about their posts. Reference the content itself, not when it was posted.',
    '- Do not stack three compliments or three-part lists. One genuine, specific point is plenty.',
    '- Do not open with "Loved your". Vary how you start.',
    '- Contractions are good. Slightly imperfect and human beats polished and robotic.',
    // The no-number rule, kept — with the reason, because a rule without one
    // reads as a rule to route around.
    '- Do NOT name a price, a range, or any dollar amount. Their own rate is the number that matters and they know it better than we do, so ask for it. The concrete ask above is what makes this answerable, not a figure.',
    '- Only mention a track title if a Track line is given below. Never guess or invent a title, and never attribute a song from the CREATOR\'s bio to the artist.',
    input.senderName
      ? `- If you name yourself, the only name you may use is ${input.senderName}.`
      : '- Never introduce yourself by name. Do not write "I\'m <name>" or "<name> here". There is no named person on this account and inventing one is worse than having none.',
    'Output JSON only: {"subject": "...", "body": "..."}',
  ].join('\n');

  const refLine = ref
    ? [
        `Mention this ONE thing from one of their videos, naturally and briefly (it is genuinely their content): "${ref.hook}"`,
        ref.creatorIsAuthor
          ? 'This is their OWN ORIGINAL work. Never call it a take, cover, version, rendition, or spin on anything. Praise it as theirs.'
          : '',
        'Mention nothing else specific. Do not invent a second detail.',
      ]
        .filter(Boolean)
        .join('\n')
    : 'You have no verified specific post to cite. Do NOT invent specifics about their videos. Open genuinely from their niche or bio instead.';

  const releaseLine = input.releaseDate
    ? releasePast
      ? `Release: already out (released ${input.releaseDate}). Frame as the new/latest release. Never "upcoming", never a future date.`
      : `Release: upcoming, ${input.releaseDate}.`
    : '';

  const user = [
    label ? `Label (name this in the body): ${label}` : '',
    `Artist: ${input.artistName}`,
    input.trackName ? `Track: ${input.trackName}` : 'Track: (none given, do not name one)',
    releaseLine,
    `Creator: @${input.creator.handle}`,
    plat ? `Platform: ${plat}` : '',
    `Bio: ${input.creator.bio?.slice(0, 200) ?? '(none)'}`,
    `The ask, verbatim: ${ask}`,
    signoff ? `Sign off with exactly: ${signoff}` : '',
    '',
    refLine,
    '',
    isDm
      ? 'Write the DM now. It is the whole message; nothing else is shown. Output the JSON.'
      : 'Write the outreach now. Keep it human and specific. Output the JSON.',
  ]
    .filter(Boolean)
    .join('\n');

  const checkOpts = {
    artistName: input.artistName,
    trackName: input.trackName ?? null,
    creatorBio: input.creator.bio ?? null,
    creatorIsAuthor: ref?.creatorIsAuthor ?? true,
    releasePast,
    requiredSignoff: signoff,
    allowedNames: [input.senderName, label, input.artistName],
  };

  let lastViolations: string[] = [];
  let modelCalls = 0;
  let modelError: Error | null = null;
  let sawEmptyOutput = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const retryRules =
      attempt > 0 && lastViolations.length > 0
        ? `\n\nYour previous attempt was rejected for: ${lastViolations.join('; ')}. Fix every one of these.`
        : '';
    let parsed: { subject?: string; body?: string };
    try {
      parsed = (await complete({
        system: sys,
        user: user + retryRules,
        schema: { subject: 'string', body: 'string' },
        temperature: 0.6,
        purpose: 'outreach.initial_draft',
        campaign_id: input.campaignId ?? null,
      })) as { subject?: string; body?: string };
    } catch (e) {
      // complete() has ALREADY walked its whole provider failover chain. A
      // second identical prompt would just traverse the same dead chain and
      // double the wall-clock cost of a failing batch. Stop and degrade.
      modelError = e as Error;
      break;
    }
    modelCalls++;
    // Em dashes are rewritten, not retried: the prompt bans them, and a draft
    // that is otherwise clean should not cost a second call or fall back to
    // template copy over one punctuation mark (no-em-dash.ts).
    const subject = stripEmDashes(parsed.subject ?? '');
    const body = stripEmDashes(parsed.body ?? '');
    if (!subject || !body) {
      sawEmptyOutput = true;
      continue;
    }
    lastViolations = checkDraftCopy({ body, subject, ...checkOpts });
    if (lastViolations.length === 0) {
      return { subject, body: withOptOut(body), source: 'model', modelCalls };
    }
  }

  // ── Degrade to deterministic copy — still gated by the copy validator ─────
  const fb = buildFirstTouchFallback(input);
  const fbViolations = checkDraftCopy({ body: fb.body, subject: fb.subject, ...checkOpts });
  const cause = modelError
    ? `model unavailable (${modelError.message})`
    : lastViolations.length > 0
      ? `model copy rejected: ${lastViolations.join('; ')}`
      : 'model returned empty output';

  if (fbViolations.length > 0) {
    throw new Error(
      `generateOutreachDraft: ${cause}, and the deterministic fallback also failed copy ` +
        `validation (${fbViolations.join('; ')}), refusing to produce a draft for ` +
        `@${input.creator.handle}.`,
    );
  }

  return {
    subject: fb.subject,
    body: withOptOut(fb.body),
    source: 'fallback',
    modelCalls,
    degradedReason: sawEmptyOutput && !modelError && lastViolations.length === 0
      ? 'model returned empty output'
      : cause,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Reply-template testing suite (migration 017).
//
// Lightly reword a synthetic creator reply so each simulation looks unique
// while the SIGNAL the classifier must extract stays fixed. The "signal" is
// stored separately (reply_templates.signal jsonb); this function only
// produces text.
//
// Inputs that MUST survive verbatim into the reworded output so the
// classifier's job is faithful:
//   - any "$X" dollar mentions (we inject the literal counter amount when
//     archetype carries a counter_multiplier)
//   - the intent direction (accept / counter / decline / clarify) — we
//     pass this in as a steering instruction, not just by hoping GPT
//     re-derives it from the base text
//
// Empty base text → empty output (silent_treatment archetype).
// ────────────────────────────────────────────────────────────────────────

export interface RewordReplyInput {
  base_text: string;
  intent: string;              // 'accept' | 'counter' | 'decline' | 'clarify' | 'ghost' | 'silent' | 'garble'
  tone: string;                // 'warm' | 'aggressive' | 'curt' | 'rambling' | 'none'
  counter_amount_usd?: number; // present iff intent === 'counter'
  artist_name?: string;        // weave in for variety
  /** campaigns.id — attributes this simulator call's model spend in api_ledger. */
  campaign_id?: string | null;
}

export async function rewordReplyTemplate(input: RewordReplyInput): Promise<string> {
  if (!input.base_text || input.base_text.trim().length === 0) return '';
  const sys =
    'You are simulating a real micro-influencer replying to a paid-collab pitch from a music label. ' +
    'Lightly reword the supplied base reply so it sounds unique and human. Keep it short (2-5 sentences). ' +
    'Preserve all explicit dollar amounts EXACTLY as written. Preserve the intent direction (accept/counter/decline/clarify/etc). ' +
    'Do not invent platform-specific details (no fake handle names). Casual lowercase is fine.';
  const counterLine = input.counter_amount_usd
    ? `Counter offer (must appear verbatim in your text): $${input.counter_amount_usd.toFixed(0)}`
    : '';
  const user = `Intent: ${input.intent}
Tone: ${input.tone}
${input.artist_name ? `Promoted artist (so the reword stays on-topic): ${input.artist_name}` : ''}
${counterLine}

Base reply (lightly reword, do NOT shift the intent):
"""
${input.base_text}
"""

Output JSON: {"body": "<reworded reply>"}`;
  const parsed = (await complete({
    system: sys,
    user,
    schema: { body: 'string' },
    temperature: 0.9,
    purpose: 'testing.reword_reply',
    campaign_id: input.campaign_id ?? null,
  })) as { body?: string };
  return parsed.body ?? '';
}
