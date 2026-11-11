// src/lib/comment-audit-run.ts
//
// The comment-quality audit step of a discovery run (called from
// api/campaigns/[id]/run after scoring + persistence). Rules and copy live in
// comment-audit.ts; reads and writes in comment-audit-store.ts; the comment
// fetch in comments-provider.ts. Everything that costs money or touches the
// network is injected, so tests/comment-audit-run.test.ts runs it with no
// scraper, no model and no database.
//
// Order of work:
//   1. campaigns.comment_audit_enabled must be true (pre-066: skipped);
//   2. the top 20 non-bot creators by composite;
//   3. an audit < 30 days old for the same (creator, platform) is REUSED, free;
//   4. the rest are fetched + classified, a few at a time, each one reserving
//      its estimated cost first. A creator whose reservation would cross the
//      per-run cap is not started: the step stops early and says so. The same
//      for the wall-clock budget, so the route stays inside maxDuration;
//   5. every audit is stored and applied to this campaign's rows.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { LedgerEntry } from './api-ledger';
import {
  AUDIT_COMMENTS_PER_POST,
  AUDIT_DEFAULT_SPEND_CAP_USD,
  AUDIT_LLM_RESERVE_USD,
  AUDIT_MIN_CLASSIFIED,
  AUDIT_POSTS_PER_CREATOR,
  AUDIT_TOP_N,
  COMMENT_CLASSIFIER_SCHEMA,
  COMMENT_CLASSIFIER_SYSTEM_PROMPT,
  buildClassifierUserMessage,
  decideAudit,
  parseClassifierOutput,
  postUrlsFromRawData,
  type AuditDecision,
  type StoredAudit,
} from './comment-audit';
import type { AuditPlatform, CommentsProvider } from './comments-provider';
import {
  applyAuditToCampaign,
  findReusableAudits,
  insertAudit,
  readCampaignAuditEnabled,
} from './comment-audit-store';

export interface AuditCandidate {
  influencer_id: string;
  platform: string;
  username: string;
  raw_data: unknown;
  composite: number;
  bot_flagged: boolean;
}

export type ClassifyFn = (p: {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  purpose: string;
  campaign_id: string;
}) => Promise<Record<string, unknown>>;

export interface CommentAuditDeps {
  sb: SupabaseClient;
  provider: CommentsProvider;
  classify: ClassifyFn;
  ledger: (e: LedgerEntry) => Promise<void>;
  modelLabel?: string | null;
  now?: () => number;
}

export interface CommentAuditOptions {
  campaignId: string;
  spendCapUsd?: number;
  timeBudgetMs?: number;
  concurrency?: number;
  topN?: number;
  postsPerCreator?: number;
  commentsPerPost?: number;
  /** Per-call provider timeout. */
  fetchTimeoutSecs?: number;
}

export interface CreatorAuditResult {
  influencer_id: string;
  platform: string;
  username: string;
  outcome: 'reused' | 'audited' | 'skipped_budget' | 'skipped_time' | 'failed';
  audit: StoredAudit | null;
  composite: number | null;
  note?: string;
}

export interface CommentAuditSummary {
  state: 'ran' | 'disabled' | 'unsupported' | 'unreadable';
  provider: string;
  considered: number;
  reused: number;
  audited: number;
  flagged: number;
  held: number;
  insufficient: number;
  skipped_budget: number;
  skipped_time: number;
  failed: number;
  spend_usd: number;
  cap_usd: number;
  stopped_early: boolean;
  results: CreatorAuditResult[];
  notes: string[];
}

const AUDITABLE = new Set<AuditPlatform>(['tiktok', 'instagram']);

export function pickAuditTargets(cands: readonly AuditCandidate[], topN: number = AUDIT_TOP_N): AuditCandidate[] {
  return cands
    .filter((c) => !c.bot_flagged && AUDITABLE.has(c.platform as AuditPlatform))
    .slice()
    .sort((a, b) => b.composite - a.composite)
    .slice(0, Math.max(0, topN));
}

function emptySummary(state: CommentAuditSummary['state'], provider: string, cap: number): CommentAuditSummary {
  return {
    state,
    provider,
    considered: 0,
    reused: 0,
    audited: 0,
    flagged: 0,
    held: 0,
    insufficient: 0,
    skipped_budget: 0,
    skipped_time: 0,
    failed: 0,
    spend_usd: 0,
    cap_usd: cap,
    stopped_early: false,
    results: [],
    notes: [],
  };
}

export async function runCommentAudits(
  deps: CommentAuditDeps,
  candidates: readonly AuditCandidate[],
  opts: CommentAuditOptions,
): Promise<CommentAuditSummary> {
  const now = deps.now ?? (() => Date.now());
  const cap = Math.max(0, opts.spendCapUsd ?? AUDIT_DEFAULT_SPEND_CAP_USD);
  const postsWanted = opts.postsPerCreator ?? AUDIT_POSTS_PER_CREATOR;
  const perPost = opts.commentsPerPost ?? AUDIT_COMMENTS_PER_POST;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const deadline = now() + (opts.timeBudgetMs ?? 100_000);
  const fetchTimeoutSecs = opts.fetchTimeoutSecs ?? 75;

  const enabled = await readCampaignAuditEnabled(deps.sb, opts.campaignId);
  if (enabled !== 'enabled') {
    return emptySummary(enabled === 'disabled' ? 'disabled' : enabled, deps.provider.name, cap);
  }

  const summary = emptySummary('ran', deps.provider.name, cap);
  const targets = pickAuditTargets(candidates, opts.topN);
  summary.considered = targets.length;
  if (targets.length === 0) return summary;

  const reusable = await findReusableAudits(
    deps.sb,
    targets.map((t) => t.influencer_id),
    now(),
  );
  if (reusable == null) summary.notes.push('could not read earlier audits; auditing fresh');

  const tally = (r: CreatorAuditResult) => {
    summary.results.push(r);
    if (r.outcome === 'reused') summary.reused += 1;
    if (r.outcome === 'audited') summary.audited += 1;
    if (r.outcome === 'skipped_budget') summary.skipped_budget += 1;
    if (r.outcome === 'skipped_time') summary.skipped_time += 1;
    if (r.outcome === 'failed') summary.failed += 1;
    const a = r.audit;
    if (a && (r.outcome === 'reused' || r.outcome === 'audited')) {
      if (a.insufficient) summary.insufficient += 1;
      else if (a.held) summary.held += 1;
      if (!a.insufficient && a.consistent_negative) summary.flagged += 1;
    }
  };

  const apply = async (t: AuditCandidate, audit: StoredAudit): Promise<number | null> => {
    const r = await applyAuditToCampaign(deps.sb, {
      campaignId: opts.campaignId,
      influencerId: t.influencer_id,
      audit,
      baseComposite: t.composite,
    });
    return r.ok ? r.composite : null;
  };

  const fresh: AuditCandidate[] = [];
  for (const t of targets) {
    const hit = reusable?.get(`${t.influencer_id}|${t.platform}`);
    if (hit) {
      const composite = await apply(t, hit);
      tally({ influencer_id: t.influencer_id, platform: t.platform, username: t.username, outcome: 'reused', audit: hit, composite });
    } else {
      fresh.push(t);
    }
  }

  // Money accounting: `spent` is what came back from providers (+ the flat
  // model reservation for each classify call made); `reserved` is what the
  // creators in flight may still spend.
  let spent = 0;
  let reserved = 0;
  let stop: 'budget' | 'time' | null = null;
  const llmReserve = AUDIT_LLM_RESERVE_USD;

  const auditOne = async (t: AuditCandidate): Promise<void> => {
    if (stop === 'budget' || now() >= deadline) {
      if (now() >= deadline && stop == null) stop = 'time';
      tally({
        influencer_id: t.influencer_id,
        platform: t.platform,
        username: t.username,
        outcome: stop === 'budget' ? 'skipped_budget' : 'skipped_time',
        audit: null,
        composite: null,
      });
      return;
    }
    const platform = t.platform as AuditPlatform;
    const fetchEstimate = deps.provider.estimateCreatorUsd(platform, postsWanted, perPost);
    const need = fetchEstimate + llmReserve;
    if (spent + reserved + need > cap + 1e-9) {
      stop = 'budget';
      tally({ influencer_id: t.influencer_id, platform: t.platform, username: t.username, outcome: 'skipped_budget', audit: null, composite: null });
      return;
    }
    reserved += need;
    let fetchCost = 0;
    let llmCost = 0;
    try {
      const fetched = await deps.provider.fetchRecentComments({
        platform,
        username: t.username,
        postUrls: postUrlsFromRawData(platform, t.raw_data, postsWanted),
        postsWanted,
        perPost,
        // Up to 1.5x this creator's estimate, never past what is left of the cap.
        maxChargeUsd: Math.max(0.01, Math.min(fetchEstimate * 1.5, cap - spent - (reserved - need) - llmReserve)),
        timeoutSecs: fetchTimeoutSecs,
      });
      fetchCost = fetched.costUsd;
      for (const row of fetched.ledger) {
        await deps.ledger({
          campaign_id: opts.campaignId,
          source: row.source,
          endpoint: row.endpoint,
          cost_usd: row.cost_usd,
          records_returned: row.records_returned,
          latency_ms: row.latency_ms,
          request_meta: { ...row.request_meta, influencer_id: t.influencer_id },
        });
      }
      for (const n of fetched.notes) summary.notes.push(`@${t.username}: ${n}`);

      const posts = fetched.posts.filter((p) => p.comments.length > 0);
      const totalComments = posts.reduce((s, p) => s + p.comments.length, 0);
      let decision: AuditDecision;
      if (totalComments < AUDIT_MIN_CLASSIFIED) {
        // Cannot reach the minimum: no model call, recorded as insufficient so
        // the fetch is not paid for again inside 30 days.
        decision = decideAudit(posts, posts.map(() => []));
        decision.posts_count = posts.length;
        decision.comments_count = totalComments;
      } else {
        llmCost = llmReserve;
        const raw = await deps.classify({
          system: COMMENT_CLASSIFIER_SYSTEM_PROMPT,
          user: buildClassifierUserMessage(platform, posts),
          schema: COMMENT_CLASSIFIER_SCHEMA as unknown as Record<string, unknown>,
          purpose: 'comment-classify',
          campaign_id: opts.campaignId,
        });
        decision = decideAudit(posts, parseClassifierOutput(raw, posts));
      }

      const stored = await insertAudit(deps.sb, {
        influencer_id: t.influencer_id,
        platform,
        decision,
        provider: deps.provider.name,
        model: llmCost > 0 ? deps.modelLabel ?? null : null,
        cost_usd: fetchCost + llmCost,
        run_ids: fetched.runIds,
        created_at: new Date(now()).toISOString(),
      });
      // If the row could not be stored the decision still applies to THIS run
      // only when it carries an id; without one there is nothing to link, so
      // the creator is left exactly as scored.
      if (!stored) {
        tally({ influencer_id: t.influencer_id, platform, username: t.username, outcome: 'failed', audit: null, composite: null, note: 'audit could not be stored' });
        return;
      }
      const composite = await apply(t, stored);
      tally({ influencer_id: t.influencer_id, platform, username: t.username, outcome: 'audited', audit: stored, composite });
    } catch (e) {
      tally({
        influencer_id: t.influencer_id,
        platform,
        username: t.username,
        outcome: 'failed',
        audit: null,
        composite: null,
        note: (e instanceof Error ? e.message : String(e)).slice(0, 160),
      });
    } finally {
      reserved -= need;
      spent += fetchCost + llmCost;
    }
  };

  // A small worker pool, in composite order.
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, fresh.length) }, async () => {
    while (next < fresh.length) {
      const t = fresh[next++];
      await auditOne(t);
    }
  });
  await Promise.all(workers);

  summary.spend_usd = Math.round(spent * 10_000) / 10_000;
  summary.stopped_early = summary.skipped_budget > 0 || summary.skipped_time > 0;
  if (summary.skipped_budget > 0) {
    summary.notes.push(`stopped at the $${cap.toFixed(2)} comment-check cap; ${summary.skipped_budget} creator(s) not checked`);
  }
  if (summary.skipped_time > 0) {
    summary.notes.push(`ran out of time; ${summary.skipped_time} creator(s) not checked`);
  }
  return summary;
}

/**
 * What one run is expected to cost with this provider: the top 20 creators,
 * TikTok, plus the model reservation.
 * Apify ≈ $2.20 · ScrapeCreators ≈ $0.66. The campaign toggle shows it.
 */
export function estimateAuditRunUsd(provider: CommentsProvider): number {
  const perCreator =
    provider.estimateCreatorUsd('tiktok', AUDIT_POSTS_PER_CREATOR, AUDIT_COMMENTS_PER_POST) + AUDIT_LLM_RESERVE_USD;
  return Math.round(AUDIT_TOP_N * perCreator * 100) / 100;
}

/** One line for the run's progress stream. */
export function describeAuditSummary(s: CommentAuditSummary): string {
  if (s.state !== 'ran') return 'Comment check skipped';
  const checked = s.audited + s.reused;
  const parts = [`Checked comments for ${checked} creator${checked === 1 ? '' : 's'}`];
  if (s.flagged > 0) parts.push(`${s.flagged} flagged`);
  if (s.held > 0) parts.push(`${s.held} held`);
  if (s.stopped_early) parts.push(`${s.skipped_budget + s.skipped_time} not checked`);
  return parts.join(', ');
}
