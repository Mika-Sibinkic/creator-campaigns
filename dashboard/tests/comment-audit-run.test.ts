import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
//
// tests/comment-audit-run.test.ts
//
// The comment-quality audit wired end to end against the in-memory store,
// with a MOCK comment provider and a MOCK classifier (src/lib/comment-audit-run.ts,
// comment-audit-store.ts, first-touch-gate.ts, negotiation.ts createOffer):
//   1. toggle off → nothing fetched, nothing spent;
//   2. pre-066 (columns/table missing) → inert everywhere: no step, no hold,
//      no price change, toggle probe says unsupported;
//   3. top 20 non-bot creators only, by composite;
//   4. the per-run spend cap stops early and says so;
//   5. an audit < 30 days old is reused (no fetch), an older one is not;
//   6. a held creator is refused first touch until a human overrides; a
//      flagged creator's composite × 0.85 and offer + ceiling × the factor;
//   7. mostly-spam comments raise bot_probability; drafting skips held rows.
// NEVER calls Apify, ScrapeCreators or a model.
//
// Run: npx tsx tests/comment-audit-run.test.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import { makeStore, type Row } from './negotiation-harness/store';
import { runCommentAudits, estimateAuditRunUsd, type AuditCandidate, type ClassifyFn } from '../src/lib/comment-audit-run';
import {
  commentAuditSupported,
  overrideCommentHold,
  readCommentPriceFactor,
  readHeldCampaignInfluencerIds,
  readCommentHold,
} from '../src/lib/comment-audit-store';
import type { CommentsProvider, FetchRecentCommentsInput } from '../src/lib/comments-provider';
import { apifyCommentsProvider, scrapeCreatorsProvider } from '../src/lib/comments-provider';
import { checkFirstTouch } from '../src/lib/first-touch-gate';
import { createOffer } from '../src/lib/negotiation';
import type { LedgerEntry } from '../src/lib/api-ledger';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

const NOW = Date.parse('2026-10-01T12:00:00Z');
const DAY = 86_400_000;

/** labels per post for each username; comments are generated to match. */
type Script = Record<string, string[]>;

function mockProvider(script: Script, perCreatorCost = 0.09): CommentsProvider & { calls: FetchRecentCommentsInput[] } {
  const calls: FetchRecentCommentsInput[] = [];
  return {
    name: 'apify',
    calls,
    estimateCreatorUsd: () => 0.09,
    async fetchRecentComments(input) {
      calls.push(input);
      const posts = (script[input.username] ?? []).map((labels, i) => ({
        post_url: `https://www.tiktok.com/@${input.username}/video/${i + 1}`,
        comments: labels.split('').map((l, j) => ({ text: `${l === 'C' ? 'you are a fraud' : l === 'B' ? 'promo DM me' : 'love it'} ${j}` })),
      }));
      return {
        posts,
        costUsd: perCreatorCost,
        costKnown: true,
        runIds: [`run-${input.username}`],
        ledger: [{ source: 'apify', endpoint: 'tiktok-comments-scraper', cost_usd: perCreatorCost, records_returned: 90, latency_ms: 1, request_meta: {} }],
        notes: [],
      };
    },
  };
}

/** A classifier that "reads" our generated comments perfectly: C for fraud, B for promo, S otherwise. */
const classify: ClassifyFn & { calls: number } = Object.assign(
  async (p: { user: string }) => {
    classify.calls += 1;
    const posts: Record<number, string> = {};
    for (const line of p.user.split('\n')) {
      const m = /^(\d+)\.(\d+): (.*)$/.exec(line);
      if (!m) continue;
      const post = Number(m[1]);
      const label = m[3].startsWith('you are a fraud') ? 'C' : m[3].startsWith('promo') ? 'B' : 'S';
      posts[post] = (posts[post] ?? '') + label;
    }
    return { posts: Object.entries(posts).map(([post, labels]) => ({ post: Number(post), labels })) };
  },
  { calls: 0 },
);

const S30 = 'S'.repeat(30);
const HOLD = 'C'.repeat(12) + 'S'.repeat(18); // 40% at the creator
const FLAG = 'C'.repeat(6) + 'S'.repeat(24); // 20%
const SPAM = 'B'.repeat(15) + 'S'.repeat(15); // 50% bot/spam

function seedWorld(opts: { enabled?: boolean; creators: Array<{ u: string; score: number; bot?: boolean }> }) {
  const store = makeStore();
  store.seed('firms', { id: 'firm-1', scraping_prefs: {} });
  store.seed('campaigns', {
    id: 'camp-1',
    firm_id: 'firm-1',
    total_budget_usd: 10_000,
    per_creator_cap_usd: 200,
    comment_audit_enabled: opts.enabled !== false,
  });
  const cands: AuditCandidate[] = [];
  for (const c of opts.creators) {
    store.seed('influencers', { id: `inf-${c.u}`, platform: 'tiktok', username: c.u, bot_probability: 0.1, follower_count: 20_000, engagement_rate: 0.08 });
    store.seed('campaign_influencers', {
      id: `ci-${c.u}`,
      campaign_id: 'camp-1',
      influencer_id: `inf-${c.u}`,
      composite_score: c.score,
      bot_flagged: c.bot === true,
      comment_held: false,
      comment_override: null,
      comment_audit_id: null,
      outreach_status: 'draft_ready',
    });
    cands.push({ influencer_id: `inf-${c.u}`, platform: 'tiktok', username: c.u, raw_data: { posts: [] }, composite: c.score, bot_flagged: c.bot === true });
  }
  return { store, cands };
}

/** Pre-066: refuse any query that names a 066 column or table, the way PostgREST does. */
function pre066(sb: SupabaseClient): SupabaseClient {
  const NEW_COLS = ['comment_audit_enabled', 'comment_held', 'comment_override', 'comment_audit_id'];
  return {
    from(table: string) {
      const q = (sb as unknown as { from(t: string): Record<string, (...a: unknown[]) => unknown> }).from(table);
      let refused = table === 'creator_comment_audits' ? { code: 'PGRST205', message: "Could not find the table 'public.creator_comment_audits' in the schema cache" } : null;
      const wrap: Record<string, unknown> = {};
      const passthrough = ['eq', 'neq', 'in', 'is', 'not', 'lte', 'lt', 'gte', 'order', 'limit', 'insert', 'update', 'upsert', 'delete'];
      for (const m of passthrough) {
        wrap[m] = (...args: unknown[]) => {
          if ((m === 'eq' || m === 'update') && NEW_COLS.some((c) => JSON.stringify(args).includes(c))) refused = { code: 'PGRST204', message: 'column does not exist' };
          q[m](...args);
          return wrap;
        };
      }
      wrap.select = (cols?: string) => {
        if (cols && NEW_COLS.some((c) => cols.includes(c))) refused = { code: '42703', message: 'column does not exist' };
        q.select(cols);
        return wrap;
      };
      wrap.maybeSingle = () => (refused ? Promise.resolve({ data: null, error: refused }) : q.maybeSingle());
      wrap.single = () => (refused ? Promise.resolve({ data: null, error: refused }) : q.single());
      wrap.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        (refused ? Promise.resolve({ data: null, error: refused }) : (q as unknown as PromiseLike<unknown>)).then(res, rej);
      return wrap;
    },
  } as unknown as SupabaseClient;
}

const ledgerRows: LedgerEntry[] = [];
const ledger = async (e: LedgerEntry) => {
  ledgerRows.push(e);
};

async function main() {
  // ── 1. Toggle off ─────────────────────────────────────────────────────────
  {
    const { store, cands } = seedWorld({ enabled: false, creators: [{ u: 'a', score: 80 }] });
    const prov = mockProvider({ a: [HOLD, HOLD, S30] });
    const s = await runCommentAudits({ sb: store.sb, provider: prov, classify, ledger, now: () => NOW }, cands, { campaignId: 'camp-1' });
    assert(s.state === 'disabled' && prov.calls.length === 0 && s.spend_usd === 0, 'toggle off → nothing fetched, nothing spent');
  }

  // ── 2. Pre-066 ────────────────────────────────────────────────────────────
  {
    const { store, cands } = seedWorld({ creators: [{ u: 'a', score: 80 }] });
    const sb = pre066(store.sb);
    const prov = mockProvider({ a: [HOLD, HOLD, S30] });
    const s = await runCommentAudits({ sb, provider: prov, classify, ledger, now: () => NOW }, cands, { campaignId: 'camp-1' });
    assert(s.state === 'unsupported' && prov.calls.length === 0, 'pre-066 → step skipped, nothing fetched');
    assert((await commentAuditSupported(sb)) === false, 'pre-066 → toggle probe says unsupported');
    assert((await commentAuditSupported(store.sb)) === true, 'post-066 → supported');
    const hold = await readCommentHold(sb, 'ci-a');
    assert(hold.state === 'unsupported', 'pre-066 → no hold read');
    assert((await readCommentPriceFactor(sb, 'ci-a')) === 1, 'pre-066 → price factor 1');
    assert((await readHeldCampaignInfluencerIds(sb, 'camp-1'))?.size === 0, 'pre-066 → no held ids, drafting unchanged');
    const gate = await checkFirstTouch(sb, 'ci-a', NOW);
    assert(gate.ok, `pre-066 → first touch is not refused for a hold (got ${JSON.stringify(gate)})`);
  }

  // ── 3 + 6. Run: top 20 non-bot, held, flagged, clean ─────────────────────
  {
    const creators = [
      { u: 'held', score: 90 },
      { u: 'flag', score: 85 },
      { u: 'clean', score: 80 },
      { u: 'onebad', score: 75 },
      { u: 'bot', score: 99, bot: true },
      ...Array.from({ length: 20 }, (_, i) => ({ u: `x${i}`, score: 10 + i })),
    ];
    const { store, cands } = seedWorld({ creators });
    const prov = mockProvider({ held: [HOLD, HOLD, S30], flag: [FLAG, FLAG, S30], clean: [S30, S30, S30], onebad: [HOLD, S30, S30] });
    classify.calls = 0;
    const s = await runCommentAudits(
      { sb: store.sb, provider: prov, classify, ledger, modelLabel: 'mock-model', now: () => NOW },
      cands,
      { campaignId: 'camp-1', spendCapUsd: 100, concurrency: 3 },
    );
    assert(s.state === 'ran' && s.considered === 20, `top 20 considered (got ${s.considered})`);
    assert(!prov.calls.some((c) => c.username === 'bot'), 'bot-flagged creator is not audited');
    assert(!prov.calls.some((c) => c.username === 'x0' || c.username === 'x3'), 'below the top 20 is not audited');
    assert(prov.calls.every((c) => c.postsWanted === 3 && c.perPost === 30), '3 posts × 30 comments');
    const ci = (u: string) => store.all('campaign_influencers').find((r) => r.id === `ci-${u}`) as Row;
    assert(ci('held').comment_held === true, 'held creator: comment_held set');
    assert(ci('held').composite_score === Math.round(90 * 0.85), `held is also flagged: composite × 0.85 (got ${ci('held').composite_score})`);
    assert(ci('flag').comment_held === false && ci('flag').composite_score === Math.round(85 * 0.85), 'flagged creator: composite × 0.85, not held');
    assert(ci('clean').composite_score === 80 && ci('clean').comment_held === false, 'clean creator unchanged');
    assert(ci('onebad').composite_score === 75 && ci('onebad').comment_held === false, 'one bad post: unchanged');
    assert(s.held === 1 && s.flagged === 2, `summary counts (held ${s.held}, flagged ${s.flagged})`);
    const audits = store.all('creator_comment_audits');
    const heldAudit = audits.find((a) => a.influencer_id === 'inf-held') as Row;
    assert(heldAudit && heldAudit.held === true && heldAudit.model === 'mock-model' && heldAudit.apify_run_id === 'run-held', 'audit row stored with model + run id');
    assert(Array.isArray(heldAudit.samples) && (heldAudit.samples as unknown[]).length === 3, 'audit row carries 3 samples');
    assert(ledgerRows.some((r) => r.endpoint === 'tiktok-comments-scraper' && r.campaign_id === 'camp-1'), 'scraper spend ledgered against the campaign');
    // Creators x0..x19 have no comments → insufficient, no model call.
    const insufficient = audits.filter((a) => a.insufficient === true).length;
    assert(insufficient === 16 && classify.calls === 4, `no-comment creators recorded insufficient without a model call (insufficient ${insufficient}, model calls ${classify.calls})`);

    // Held → first touch refused until override.
    const refused = await checkFirstTouch(store.sb, 'ci-held', NOW);
    assert(!refused.ok && refused.status === 409 && refused.body.error === 'excluded' && refused.body.reason === 'comment_hold', `held creator refused first touch (got ${JSON.stringify(refused)})`);
    assert(!refused.ok && !/—/.test(String(refused.body.message)), 'refusal copy has no em dash');
    const okClean = await checkFirstTouch(store.sb, 'ci-clean', NOW);
    assert(okClean.ok, 'clean creator passes');
    const heldIds = await readHeldCampaignInfluencerIds(store.sb, 'camp-1');
    assert(heldIds?.has('ci-held') === true && heldIds.size === 1, 'drafting excludes exactly the held creator');

    const ov = await overrideCommentHold(store.sb, { campaignId: 'camp-1', campaignInfluencerId: 'ci-held', byUserId: 'user_1', byLabel: 'user:label@x.example', reason: 'checked by hand, it is banter', nowIso: new Date(NOW).toISOString() });
    assert(ov.ok, 'override saved');
    const after = await checkFirstTouch(store.sb, 'ci-held', NOW);
    assert(after.ok, `after override, first touch allowed (got ${JSON.stringify(after)})`);
    assert((await readHeldCampaignInfluencerIds(store.sb, 'camp-1'))?.size === 0, 'after override, drafting includes them again');
    const notHeld = await overrideCommentHold(store.sb, { campaignId: 'camp-1', campaignInfluencerId: 'ci-clean', byUserId: 'u', byLabel: 'u', reason: 'xxx', nowIso: '' });
    assert(!notHeld.ok && notHeld.status === 409, 'override of a creator who is not held → 409');
    const wrongCampaign = await overrideCommentHold(store.sb, { campaignId: 'camp-2', campaignInfluencerId: 'ci-held', byUserId: 'u', byLabel: 'u', reason: 'xxx', nowIso: '' });
    assert(!wrongCampaign.ok && wrongCampaign.status === 404, 'override scoped to the campaign');

    // Flagged → offer and ceiling × max(0.7, 1 − 0.133).
    const factor = await readCommentPriceFactor(store.sb, 'ci-flag');
    assert(Math.abs(factor - (1 - 12 / 90)) < 1e-3, `price factor = 1 − negative share (got ${factor})`);
    assert((await readCommentPriceFactor(store.sb, 'ci-clean')) === 1, 'clean → factor 1');
    const offer = await createOffer(store.sb, {
      campaign_influencer_id: 'ci-flag',
      campaign_id: 'camp-1',
      firm_id: 'firm-1',
      follower_count: 20_000,
      engagement_rate: 0.2,
      per_creator_cap_usd: 200,
      genre_premiums: {},
      negotiation_history: [],
      creator_profile: { platform: 'tiktok', raw_data: {} },
    });
    const expectedCap = Math.floor(200 * factor * 100) / 100;
    assert(Number(offer.ceiling_usd) === expectedCap, `flagged ceiling = 200 × factor (got ${offer.ceiling_usd}, want ${expectedCap})`);
    assert(Number(offer.initial_offer_usd) <= expectedCap, 'opening offer stays inside the lowered ceiling');
    const cleanOffer = await createOffer(store.sb, {
      campaign_influencer_id: 'ci-clean',
      campaign_id: 'camp-1',
      firm_id: 'firm-1',
      follower_count: 20_000,
      engagement_rate: 0.2,
      per_creator_cap_usd: 200,
      genre_premiums: {},
      negotiation_history: [],
      creator_profile: { platform: 'tiktok', raw_data: {} },
    });
    assert(Number(cleanOffer.ceiling_usd) === 200 && Number(cleanOffer.initial_offer_usd) === 140, `clean creator: ceiling 200, offer $140 (got ${cleanOffer.ceiling_usd}/${cleanOffer.initial_offer_usd})`);
  }

  // ── 4. Spend cap ──────────────────────────────────────────────────────────
  {
    const creators = Array.from({ length: 10 }, (_, i) => ({ u: `c${i}`, score: 90 - i }));
    const { store, cands } = seedWorld({ creators });
    const script: Script = Object.fromEntries(creators.map((c) => [c.u, [S30, S30, S30]]));
    const prov = mockProvider(script);
    // Each creator reserves 0.09 fetch + 0.02 model = 0.11. A $0.50 cap fits 4.
    const s = await runCommentAudits({ sb: store.sb, provider: prov, classify, ledger, now: () => NOW }, cands, { campaignId: 'camp-1', spendCapUsd: 0.5, concurrency: 1 });
    assert(prov.calls.length === 4, `cap stops after 4 creators (got ${prov.calls.length})`);
    assert(s.audited === 4 && s.skipped_budget === 6 && s.stopped_early, `6 not checked, stopped early (got ${JSON.stringify({ a: s.audited, b: s.skipped_budget })})`);
    assert(s.spend_usd <= 0.5 + 1e-9, `spend within the cap (got ${s.spend_usd})`);
    assert(s.notes.some((n) => n.includes('$0.50 comment-check cap')), 'the stop is reported');
    // Concurrency does not breach the cap either.
    const w2 = seedWorld({ creators });
    const prov2 = mockProvider(script);
    const s2 = await runCommentAudits({ sb: w2.store.sb, provider: prov2, classify, ledger, now: () => NOW }, w2.cands, { campaignId: 'camp-1', spendCapUsd: 0.5, concurrency: 4 });
    assert(s2.spend_usd <= 0.5 + 1e-9 && prov2.calls.length <= 4, `concurrent workers stay inside the cap (spent ${s2.spend_usd}, calls ${prov2.calls.length})`);
    // Time budget.
    let t = NOW;
    const w3 = seedWorld({ creators });
    const slow = mockProvider(script);
    const orig = slow.fetchRecentComments.bind(slow);
    slow.fetchRecentComments = async (input) => {
      t += 40_000;
      return orig(input);
    };
    const s3 = await runCommentAudits({ sb: w3.store.sb, provider: slow, classify, ledger, now: () => t }, w3.cands, { campaignId: 'camp-1', spendCapUsd: 100, concurrency: 1, timeBudgetMs: 90_000 });
    assert(s3.audited === 3 && s3.skipped_time === 7, `time budget stops the step (audited ${s3.audited}, skipped ${s3.skipped_time})`);
  }

  // ── 5. Reuse ──────────────────────────────────────────────────────────────
  {
    const { store, cands } = seedWorld({ creators: [{ u: 'fresh', score: 90 }, { u: 'stale', score: 80 }] });
    store.seed('creator_comment_audits', { id: 'aud-fresh', influencer_id: 'inf-fresh', platform: 'tiktok', posts_count: 3, comments_count: 90, negative_share: 0.4, supportive_share: 0.6, neutral_share: 0, bot_spam_share: 0, consistent_negative: true, held: true, insufficient: false, samples: [], created_at: new Date(NOW - 10 * DAY).toISOString() });
    store.seed('creator_comment_audits', { id: 'aud-stale', influencer_id: 'inf-stale', platform: 'tiktok', posts_count: 3, comments_count: 90, negative_share: 0.4, supportive_share: 0.6, neutral_share: 0, bot_spam_share: 0, consistent_negative: true, held: true, insufficient: false, samples: [], created_at: new Date(NOW - 40 * DAY).toISOString() });
    const prov = mockProvider({ fresh: [S30, S30, S30], stale: [S30, S30, S30] });
    const s = await runCommentAudits({ sb: store.sb, provider: prov, classify, ledger, now: () => NOW }, cands, { campaignId: 'camp-1' });
    assert(!prov.calls.some((c) => c.username === 'fresh'), 'an audit 10 days old is reused: no fetch');
    assert(prov.calls.some((c) => c.username === 'stale'), 'an audit 40 days old is not reused');
    assert(s.reused === 1 && s.audited === 1, `summary: 1 reused, 1 audited (got ${s.reused}/${s.audited})`);
    const ci = store.all('campaign_influencers').find((r) => r.id === 'ci-fresh') as Row;
    assert(ci.comment_audit_id === 'aud-fresh' && ci.comment_held === true && ci.composite_score === Math.round(90 * 0.85), 'the reused audit is applied to this campaign');
  }

  // ── 7. Bot feed ───────────────────────────────────────────────────────────
  {
    const { store, cands } = seedWorld({ creators: [{ u: 'spammy', score: 90 }] });
    const prov = mockProvider({ spammy: [SPAM, SPAM, SPAM] });
    await runCommentAudits({ sb: store.sb, provider: prov, classify, ledger, now: () => NOW }, cands, { campaignId: 'camp-1' });
    const inf = store.all('influencers').find((r) => r.id === 'inf-spammy') as Row;
    assert(Number(inf.bot_probability) === 0.5, `50% spam raises bot_probability from 0.1 to 0.5 (got ${inf.bot_probability})`);
    const ci = store.all('campaign_influencers').find((r) => r.id === 'ci-spammy') as Row;
    assert(ci.bot_flagged === false, '0.5 is under the 0.6 flag threshold: not bot_flagged');

    const w = seedWorld({ creators: [{ u: 'farm', score: 90 }] });
    const all = mockProvider({ farm: ['B'.repeat(25) + 'S'.repeat(5), 'B'.repeat(25) + 'S'.repeat(5), 'B'.repeat(25) + 'S'.repeat(5)] });
    await runCommentAudits({ sb: w.store.sb, provider: all, classify, ledger, now: () => NOW }, w.cands, { campaignId: 'camp-1' });
    const ci2 = w.store.all('campaign_influencers').find((r) => r.id === 'ci-farm') as Row;
    assert(ci2.bot_flagged === true, '83% spam → bot_probability 0.83 > 0.6 → bot_flagged, so it leaves the draft pool');
  }

  // ── Estimates per provider ────────────────────────────────────────────────
  {
    const a = estimateAuditRunUsd(apifyCommentsProvider());
    const sc = estimateAuditRunUsd(scrapeCreatorsProvider({ apiKey: 'k' }));
    assert(Math.abs(a - 2.2) < 0.01, `apify run estimate ≈ $2.20 (got ${a})`);
    assert(sc < a && sc > 0, `scrapecreators estimate is lower (got ${sc})`);
  }

  console.log(`\ncomment-audit-run: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
