// src/lib/comment-audit-store.ts
//
// Every database read and write the comment-quality audit makes, in one place,
// each one safe before migration 066 is applied.
//
// PRE-066 (columns/table missing → PGRST204 / 42703 / PGRST205 / 42P01) the
// feature is ABSENT, not broken: no toggle, no step, no hold, no price change.
// Any OTHER read failure is reported as unreadable, and the caller decides:
// the first-touch gate fails CLOSED (503, nothing sent); drafting, listing and
// pricing fall back to today's behaviour, because the send gate still stands
// behind them.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingColumnError } from './holding-note';
import { isMissingTableError } from './firm-blocks';
import {
  AUDIT_REUSE_DAYS,
  botProbabilityWithComments,
  commentCompositeFactor,
  commentPriceFactor,
  type AuditDecision,
  type StoredAudit,
} from './comment-audit';

export const AUDITS_TABLE = 'creator_comment_audits' as const;
export const AUDIT_ENABLED_COLUMN = 'comment_audit_enabled' as const;

/** Bot flag threshold, same as bot-detection.ts (probability > 0.6). */
const BOT_FLAG_THRESHOLD = 0.6;

export function isMissingSchemaError(error: unknown): boolean {
  return isMissingColumnError(error) || isMissingTableError(error);
}

function errMsg(e: unknown): string {
  return (e as { message?: string } | null)?.message ?? 'read failed';
}

/** Is 066 applied? null = the probe itself failed. */
export async function commentAuditSupported(sb: SupabaseClient): Promise<boolean | null> {
  const a = await sb.from('campaigns').select(AUDIT_ENABLED_COLUMN).limit(1);
  if (a.error) return isMissingSchemaError(a.error) ? false : null;
  const b = await sb.from(AUDITS_TABLE).select('id').limit(1);
  if (b.error) return isMissingSchemaError(b.error) ? false : null;
  return true;
}

export type AuditEnabledRead = 'enabled' | 'disabled' | 'unsupported' | 'unreadable';

export async function readCampaignAuditEnabled(sb: SupabaseClient, campaignId: string): Promise<AuditEnabledRead> {
  const { data, error } = await sb.from('campaigns').select(AUDIT_ENABLED_COLUMN).eq('id', campaignId).maybeSingle();
  if (error) return isMissingSchemaError(error) ? 'unsupported' : 'unreadable';
  if (!data) return 'unreadable';
  return (data as Record<string, unknown>)[AUDIT_ENABLED_COLUMN] === true ? 'enabled' : 'disabled';
}

export interface CommentOverride {
  by_user_id: string | null;
  by_label: string;
  reason: string;
  at: string;
}

export function isHeld(row: { comment_held?: unknown; comment_override?: unknown } | null | undefined): boolean {
  if (!row) return false;
  return row.comment_held === true && (row.comment_override == null || row.comment_override === false);
}

/**
 * The first-touch gate's 409 body for a held creator. `error: 'excluded'` on
 * purpose: the send copy (outreach-send-copy.ts) already classifies that as
 * "this creator was refused", so bulk send skips this one creator and carries
 * on. It is NOT a limit/budget refusal, which would stop the whole batch.
 */
export const COMMENT_HOLD_REFUSAL_BODY = {
  error: 'excluded',
  reason: 'comment_hold',
  message:
    'Held: comments. Someone on your team has to override the hold on the campaign page before this creator is contacted.',
} as const;

export type CommentHoldRead =
  | { state: 'ok'; held: boolean }
  | { state: 'unsupported' }
  | { state: 'unreadable'; message: string };

/** Is this campaign_influencers row held on comments (and not overridden)? */
export async function readCommentHold(sb: SupabaseClient, campaignInfluencerId: string): Promise<CommentHoldRead> {
  const { data, error } = await sb
    .from('campaign_influencers')
    .select('id, comment_held, comment_override')
    .eq('id', campaignInfluencerId)
    .maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return { state: 'unsupported' };
    return { state: 'unreadable', message: errMsg(error) };
  }
  if (!data) return { state: 'unreadable', message: 'campaign_influencer_not_found' };
  return { state: 'ok', held: isHeld(data as Record<string, unknown>) };
}

/**
 * The campaign's held creators (campaign_influencers ids). Empty pre-066.
 * null = unreadable; drafting callers then log and draft as before, because
 * the send gate (first-touch-gate.ts) refuses a held creator regardless.
 */
export async function readHeldCampaignInfluencerIds(sb: SupabaseClient, campaignId: string): Promise<Set<string> | null> {
  const { data, error } = await sb
    .from('campaign_influencers')
    .select('id, comment_held, comment_override')
    .eq('campaign_id', campaignId)
    .eq('comment_held', true);
  if (error) return isMissingSchemaError(error) ? new Set() : null;
  const out = new Set<string>();
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    if (typeof r.id === 'string' && isHeld(r)) out.add(r.id);
  }
  return out;
}

async function readAuditById(sb: SupabaseClient, id: string): Promise<StoredAudit | null> {
  const { data, error } = await sb.from(AUDITS_TABLE).select('*').eq('id', id).maybeSingle();
  if (error || !data) return null;
  return data as StoredAudit;
}

/**
 * Multiplier for this creator's opening offer AND per-creator ceiling in this
 * campaign: max(0.7, 1 − negative share) when the applied audit flagged them,
 * else 1. Any failure (pre-066 included) → 1, i.e. exactly today's price.
 */
export async function readCommentPriceFactor(sb: SupabaseClient, campaignInfluencerId: string): Promise<number> {
  try {
    const { data, error } = await sb
      .from('campaign_influencers')
      .select('id, comment_audit_id')
      .eq('id', campaignInfluencerId)
      .maybeSingle();
    if (error || !data) return 1;
    const auditId = (data as { comment_audit_id?: unknown }).comment_audit_id;
    if (typeof auditId !== 'string' || auditId === '') return 1;
    const audit = await readAuditById(sb, auditId);
    const f = commentPriceFactor(audit);
    return Number.isFinite(f) && f > 0 && f <= 1 ? f : 1;
  } catch {
    return 1;
  }
}

export interface CardAudit {
  negative_share: number | null;
  posts_count: number;
  comments_count: number;
  insufficient: boolean;
  consistent_negative: boolean;
  held: boolean;
  samples: unknown;
  created_at: string | null;
}

/** Attach `comment_audit` to listing rows that have one. Silent pre-066. */
export async function attachCommentAudits<T extends Record<string, unknown>>(
  sb: SupabaseClient,
  rows: T[],
): Promise<Array<T & { comment_audit?: CardAudit | null }>> {
  const ids = [...new Set(rows.map((r) => r.comment_audit_id).filter((v): v is string => typeof v === 'string'))];
  if (ids.length === 0) return rows;
  const { data, error } = await sb.from(AUDITS_TABLE).select('*').in('id', ids);
  if (error) return rows;
  const byId = new Map(((data ?? []) as Array<Record<string, unknown>>).map((a) => [a.id as string, a]));
  return rows.map((r) => {
    const a = typeof r.comment_audit_id === 'string' ? byId.get(r.comment_audit_id) : undefined;
    if (!a) return r;
    return {
      ...r,
      comment_audit: {
        negative_share: a.negative_share == null ? null : Number(a.negative_share),
        posts_count: Number(a.posts_count ?? 0),
        comments_count: Number(a.comments_count ?? 0),
        insufficient: a.insufficient === true,
        consistent_negative: a.consistent_negative === true,
        held: a.held === true,
        samples: a.samples ?? [],
        created_at: typeof a.created_at === 'string' ? a.created_at : null,
      },
    };
  });
}

/** Latest audit per (creator, platform) younger than 30 days. */
export async function findReusableAudits(
  sb: SupabaseClient,
  influencerIds: string[],
  nowMs: number,
): Promise<Map<string, StoredAudit> | null> {
  const out = new Map<string, StoredAudit>();
  if (influencerIds.length === 0) return out;
  const since = new Date(nowMs - AUDIT_REUSE_DAYS * 86_400_000).toISOString();
  const { data, error } = await sb
    .from(AUDITS_TABLE)
    .select('*')
    .in('influencer_id', influencerIds)
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  if (error) return null;
  for (const a of (data ?? []) as StoredAudit[]) {
    const key = `${a.influencer_id}|${a.platform}`;
    if (!out.has(key)) out.set(key, a);
  }
  return out;
}

export interface NewAuditRow {
  influencer_id: string;
  platform: string;
  decision: AuditDecision;
  provider: string;
  model: string | null;
  cost_usd: number;
  run_ids: string[];
  created_at: string;
}

export async function insertAudit(sb: SupabaseClient, r: NewAuditRow): Promise<StoredAudit | null> {
  const d = r.decision;
  const row = {
    influencer_id: r.influencer_id,
    platform: r.platform,
    posts_count: d.posts_count,
    comments_count: d.comments_count,
    supportive_share: d.supportive_share,
    neutral_share: d.neutral_share,
    negative_share: d.negative_share,
    bot_spam_share: d.bot_spam_share,
    consistent_negative: d.consistent_negative,
    held: d.held,
    insufficient: d.insufficient,
    per_post: d.per_post,
    samples: d.samples,
    provider: r.provider,
    model: r.model,
    cost_usd: Math.round(r.cost_usd * 10_000) / 10_000,
    apify_run_id: r.run_ids.length > 0 ? r.run_ids.join(',').slice(0, 500) : null,
    created_at: r.created_at,
  };
  const { data, error } = await sb.from(AUDITS_TABLE).insert(row as never).select().single();
  if (error || !data) return null;
  return data as StoredAudit;
}

/**
 * Apply an audit to this campaign's row for the creator: link it, snapshot the
 * hold, and scale the composite (× 0.85 when flagged) from the run's freshly
 * scored value, so a re-run never compounds the penalty. comment_override is
 * left untouched: a human's override survives a re-run.
 *
 * Mostly-spam comments raise the shared influencers.bot_probability (never
 * lower it) and, past the existing 0.6 threshold, set this row's bot_flagged.
 */
export async function applyAuditToCampaign(
  sb: SupabaseClient,
  input: {
    campaignId: string;
    influencerId: string;
    audit: StoredAudit;
    baseComposite: number;
  },
): Promise<{ ok: boolean; composite: number; bot_probability: number | null }> {
  const composite = Math.round(input.baseComposite * commentCompositeFactor(input.audit));
  let botProbability: number | null = null;
  try {
    const { data: inf } = await sb
      .from('influencers')
      .select('id, bot_probability')
      .eq('id', input.influencerId)
      .maybeSingle();
    botProbability = botProbabilityWithComments(
      (inf as { bot_probability?: number | null } | null)?.bot_probability ?? null,
      input.audit,
    );
    if (botProbability != null) {
      await sb.from('influencers').update({ bot_probability: botProbability } as never).eq('id', input.influencerId);
    }
  } catch {
    botProbability = null;
  }
  const patch: Record<string, unknown> = {
    comment_audit_id: input.audit.id ?? null,
    comment_held: input.audit.held === true,
    composite_score: composite,
  };
  if (botProbability != null && botProbability > BOT_FLAG_THRESHOLD) patch.bot_flagged = true;
  const { error } = await sb
    .from('campaign_influencers')
    .update(patch as never)
    .eq('campaign_id', input.campaignId)
    .eq('influencer_id', input.influencerId);
  return { ok: !error, composite, bot_probability: botProbability };
}

export type OverrideResult =
  | { ok: true; override: CommentOverride }
  | { ok: false; status: 404 | 409 | 503; error: string; message: string };

/** A human clears a comment hold. The caller authorizes and audits. */
export async function overrideCommentHold(
  sb: SupabaseClient,
  input: {
    campaignId: string;
    campaignInfluencerId: string;
    byUserId: string | null;
    byLabel: string;
    reason: string;
    nowIso: string;
  },
): Promise<OverrideResult> {
  const { data, error } = await sb
    .from('campaign_influencers')
    .select('id, campaign_id, comment_held, comment_override')
    .eq('id', input.campaignInfluencerId)
    .eq('campaign_id', input.campaignId)
    .maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) {
      return { ok: false, status: 409, error: 'comment_audit_unavailable', message: 'Comment checks are not switched on for this workspace yet.' };
    }
    return { ok: false, status: 503, error: 'unreadable', message: "Couldn't read this creator. Try again in a minute." };
  }
  if (!data) return { ok: false, status: 404, error: 'not_found', message: 'That creator is not in this campaign.' };
  const row = data as Record<string, unknown>;
  if (row.comment_held !== true) {
    return { ok: false, status: 409, error: 'not_held', message: 'This creator is not held on comments.' };
  }
  const override: CommentOverride = {
    by_user_id: input.byUserId,
    by_label: input.byLabel,
    reason: input.reason,
    at: input.nowIso,
  };
  const { error: upErr } = await sb
    .from('campaign_influencers')
    .update({ comment_override: override } as never)
    .eq('id', input.campaignInfluencerId)
    .eq('campaign_id', input.campaignId);
  if (upErr) return { ok: false, status: 503, error: 'write_failed', message: "Couldn't save the override. Try again in a minute." };
  return { ok: true, override };
}
