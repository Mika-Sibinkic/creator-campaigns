// src/lib/creator-detail.ts
//
// What GET /api/influencers/[id] may return about a SHARED creator row.
//
// `influencers` is one row per creator shared by every label, and several of
// its columns are written by one label's pipeline and mean nothing (or too
// much) to another: the Stripe Connect payout account a payment created, the
// `last_response` timestamp a creator's reply to some label stamped, the
// enrichment tick's scan counters, a campaign-context `score_breakdown`, and
// the raw scraped author blob. `select *` handed every one of them to any
// signed-in user of any label, and would hand over whatever column is added
// next. The response is therefore an ALLOWLIST: a new column stays private
// until someone decides it is public profile.
//
// Pure — no client, no env.

import { doNotContactVerdict, type DoNotContactVerdict, type FirmBlockRead } from './firm-blocks';

/**
 * Creator fields a label may see. Public profile + creator-level signals, plus
 * `contact_email` (redacted separately for a label that never worked the
 * creator, src/lib/creator-scope.ts redactUnrelatedCreator).
 *
 * Deliberately absent: stripe_connect_account_id, last_response,
 * contact_scanned_at, contact_scan_attempts, score_breakdown, synthetic, and
 * `blocklisted` — block state is returned as this label's view instead
 * (firmBlockView).
 */
export const CREATOR_DETAIL_FIELDS = [
  'id',
  'platform',
  'username',
  'display_name',
  'profile_url',
  'follower_count',
  'engagement_rate',
  'bio',
  'verified',
  'avatar_url',
  'content_genres',
  'bot_probability',
  'bot_flagged',
  'posting_cadence',
  'follower_following_ratio',
  'created_at',
  'contact_email',
  'raw_data',
] as const;

/** raw_data minus the scraped author blob: the posts grid is all the page reads. */
function publicRawData(v: unknown): { posts: unknown[] } | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const posts = (v as { posts?: unknown }).posts;
  return { posts: Array.isArray(posts) ? posts : [] };
}

/** The allowlisted projection of a creator row. Absent fields read as null. */
export function pickCreatorDetail(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of CREATOR_DETAIL_FIELDS) {
    out[f] = f === 'raw_data' ? publicRawData(row.raw_data) : (row[f] ?? null);
  }
  return out;
}

export interface FirmBlockView {
  /** Platform-level block (operator-set). Every label honours it. */
  blocklisted: boolean;
  /** THIS label's own block or STOP (firm_influencer_blocks). */
  firm_blocked: boolean;
  /** The contact rule for THIS label: platform OR own block. 'unknown' when
   *  this label's list could not be read — absent is not clear. */
  do_not_contact: DoNotContactVerdict;
}

/** Block state as the calling label sees it. Never another label's rows. */
export function firmBlockView(
  influencerId: string,
  globalBlocklisted: unknown,
  read: Pick<FirmBlockRead, 'state' | 'ids'>
): FirmBlockView {
  const global = globalBlocklisted === true;
  return {
    blocklisted: global,
    firm_blocked: read.state === 'ok' && read.ids.has(influencerId),
    do_not_contact: doNotContactVerdict(global, influencerId, read),
  };
}
