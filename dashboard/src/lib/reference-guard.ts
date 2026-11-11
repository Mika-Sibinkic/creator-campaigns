// src/lib/reference-guard.ts
//
// Sensible-reference guard. When outreach references a
// creator's own recent post, it must NOT misattribute the PROMOTED artist's
// release to the creator — e.g. praising their "cover" / "take" / "reaction" on
// the artist's song as if it were the creator's own work. That reads as a bot and
// burns trust on the first line.
//
// Two layers:
//   1. Deterministic string check — if the cited post literally names the
//      promoted artist or track, the post is ABOUT the release, so referencing it
//      as the creator's own content is a misattribution. Reject, no LLM needed.
//   2. Light-LLM provenance check (runs only when the post is string-clean) —
//      asks whether the post is a cover / reaction / use of the promoted track.
//      "About the promoted release" with usable confidence → reject.
//
// Draft-gen policy (`shouldUseReference`): use the reference only when it is
// confidently the creator's OWN content; otherwise DROP it and open from the
// creator's niche generically. When unsure (LLM unavailable or low confidence)
// we honor the deterministic string floor rather than nuking every reference.

import { complete } from './model-provider';

export interface ValidateReferenceInput {
  /** The creator's own recent post text / hook we want to reference. */
  influencer_post: string;
  artist_name: string;
  track_name?: string | null;
  /** campaigns.id — attributes the provenance call's model spend in api_ledger. */
  campaign_id?: string | null;
}

export interface ReferenceVerdict {
  ok: boolean;
  reason: string;
  /** 0..1 confidence in the verdict. */
  confidence: number;
  /**
   * True when the post is the creator's OWN ORIGINAL work (their own song,
   * single, or original content) rather than commentary/cover/reaction to
   * someone else's. Drives framing: an original must never be called their
   * "take/cover/version/spin" — that tells a songwriter we think their song
   * is someone else's. Defaults true (the safe framing) when unknown: "your
   * post about X" is always safe, "your take on X" is not.
   */
  creator_is_author: boolean;
}

/** Below this confidence, draft-gen drops the reference (treats it as "unsure"). */
export const REFERENCE_MIN_CONFIDENCE = 0.5;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when `post` appears to be ABOUT the promoted artist or track (their name
 * shows up as a whole-word match). Pure + deterministic — the security-critical
 * misattribution gate.
 */
export function referenceMentionsArtist(
  post: string,
  artist_name: string,
  track_name?: string | null,
): boolean {
  const hay = ` ${normalize(post)} `;
  const needles = [artist_name, track_name ?? '']
    .map((n) => normalize(n))
    .filter((n) => n.length >= 2);
  return needles.some((n) => hay.includes(` ${n} `));
}

// ── Light-LLM provenance check ──────────────────────────────────────────────

const PROVENANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['about_promoted_release', 'creator_is_author', 'confidence'],
  properties: {
    about_promoted_release: { type: 'boolean' },
    creator_is_author: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

const PROVENANCE_SYSTEM = [
  'You decide two things about a social post we may reference in an outreach',
  'email to its creator.',
  '',
  '1. about_promoted_release: is the post ABOUT the specific promoted song or',
  'artist named below? If it is a cover, reaction, review, edit, duet, or use',
  'of the promoted track or artist, calling it the creator\'s own work would',
  'be wrong: answer true. If it is the creator\'s own unrelated content,',
  'answer false.',
  '',
  '2. creator_is_author: is the post the creator\'s OWN ORIGINAL work (their',
  'own song, single, album, or original content they made), as opposed to',
  'their commentary on / cover of / reaction to someone ELSE\'s work? A',
  'songwriter posting their own single: true. Someone reviewing a film score',
  'or covering another artist\'s song: false. When you cannot tell, answer',
  'true. Praising an original as an original is safe; calling an original a',
  '"take" on someone else\'s song insults its author.',
  '',
  'Return only the JSON object.',
].join('\n');

/**
 * Validate that a candidate reference is safe to cite as the creator's own work.
 * String check first (deterministic reject); a light-LLM provenance check runs
 * only when the string check is clean.
 */
export async function validateReference(
  input: ValidateReferenceInput,
): Promise<ReferenceVerdict> {
  const post = (input.influencer_post ?? '').trim();
  if (post.length === 0) {
    return { ok: false, reason: 'no post text to reference', confidence: 1, creator_is_author: true };
  }

  // 1. Deterministic misattribution gate.
  if (referenceMentionsArtist(post, input.artist_name, input.track_name)) {
    return {
      ok: false,
      reason:
        'post references the promoted artist/track; citing it as the creator\'s own content would misattribute the release',
      confidence: 0.99,
      creator_is_author: false,
    };
  }

  // 2. Light-LLM provenance check (string-clean only).
  try {
    const out = await complete({
      system: PROVENANCE_SYSTEM,
      user: [
        `Promoted artist: ${input.artist_name}`,
        input.track_name ? `Promoted track: ${input.track_name}` : '',
        'Creator post:',
        `"""${post.slice(0, 500)}"""`,
      ]
        .filter(Boolean)
        .join('\n'),
      schema: PROVENANCE_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0,
      purpose: 'reference_guard.provenance',
      campaign_id: input.campaign_id ?? null,
    });
    const about = out.about_promoted_release === true;
    // Unknown/malformed → true: "your post about X" is always safe framing,
    // "your take on X" is only safe when the work is genuinely not theirs.
    const isAuthor = out.creator_is_author !== false;
    const rawConf = out.confidence;
    const conf =
      typeof rawConf === 'number' && Number.isFinite(rawConf)
        ? Math.max(0, Math.min(1, rawConf))
        : 0;

    if (about && conf >= REFERENCE_MIN_CONFIDENCE) {
      return {
        ok: false,
        reason: 'model flagged the post as about the promoted release',
        confidence: conf,
        creator_is_author: isAuthor,
      };
    }
    if (!about) {
      return {
        ok: true,
        reason: 'creator\'s own content (no provenance conflict)',
        confidence: conf || 0.7,
        creator_is_author: isAuthor,
      };
    }
    // "about" but low confidence → unsure → drop to be safe.
    return {
      ok: false,
      reason: 'low-confidence provenance read; dropping the reference to be safe',
      confidence: conf,
      creator_is_author: isAuthor,
    };
  } catch {
    // LLM unavailable / malformed → the deterministic string floor already passed.
    return {
      ok: true,
      reason: 'string-clean; provenance model unavailable',
      confidence: 0.6,
      creator_is_author: true,
    };
  }
}

/** Draft-gen decision: cite the reference only when confidently the creator's own. */
export function shouldUseReference(v: ReferenceVerdict): boolean {
  return v.ok && v.confidence >= REFERENCE_MIN_CONFIDENCE;
}
