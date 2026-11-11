import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub
//
// tests/cpm-shadow.test.ts
//
// The shadow WRITES of CPM slices S1/S4 (src/lib/cpm-shadow.ts):
// pricing_basis at offer creation and first_ask_usd at the first validated
// counter. What is pinned:
//
//   - the basis is computed from the creator's own stored post history, loaded
//     here because the send paths only carry followers/engagement;
//   - cold start: no campaign target → the formula-implied pool CPM → constant;
//   - pre-061/062 the write is skipped, nothing throws, nothing else is written;
//   - a database that throws cannot escape into the money path;
//   - first_ask_usd is written once and never overwritten.
//
// Hermetic. Run: npx tsx tests/cpm-shadow.test.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  recordShadowPricingBasis,
  recordFirstAsk,
  isMissingSchemaError,
  resetCpmShadowCaches,
} from '../src/lib/cpm-shadow';
import { createOffer } from '../src/lib/negotiation';
import { COLD_START_TARGET_CPM_USD } from '../src/lib/cpm-pricing';
import { makeStore, type Row } from './negotiation-harness/store';

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

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-01T12:00:00Z');
const posts = (plays: number[]) =>
  plays.map((p, i) => ({ playCount: p, createTime: Math.floor((NOW - (5 + i) * DAY) / 1000) }));

type Store = ReturnType<typeof makeStore>;

function seed(store: Store, opts: { target?: number | null; max?: number | null; platform?: string; plays?: number[] } = {}) {
  store.seed('firms', { id: 'firm-1', scraping_prefs: {}, pricing_mode: 'formula' });
  store.seedCampaign('camp-1', null);
  const c = store.all('campaigns')[0] as Row;
  c.target_cpm_usd = opts.target ?? null;
  c.max_cpm_usd = opts.max ?? null;
  store.seed('influencers', {
    id: 'inf-1',
    platform: opts.platform ?? 'tiktok',
    follower_count: 25_000,
    // The calibrated TikTok median (pricing-engine.ts): the
    // engagement multiplier is exactly 1.0x here, so formula = tier base.
    engagement_rate: 0.0813,
    raw_data: { posts: posts(opts.plays ?? [20_000, 20_000, 20_000, 20_000]) },
  });
  store.seed('campaign_influencers', { id: 'ci-1', campaign_id: 'camp-1', influencer_id: 'inf-1', composite_score: 0.8 });
  store.seedOffer({ id: 'offer-1', campaign_id: 'camp-1', campaign_influencer_id: 'ci-1', status: 'queued', initial_offer_usd: 150 });
}

const base = {
  offer_id: 'offer-1',
  campaign_id: 'camp-1',
  campaign_influencer_id: 'ci-1',
  genre: null,
  per_creator_cap_usd: 500,
  formula_price_usd: 150,
  now_ms: NOW,
};

/** Refuses any query naming the given columns, PostgREST-style. */
function refusing(store: Store, cols: string[]): SupabaseClient {
  return {
    from(table: string) {
      const q = store.sb.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
      let refused = false;
      const touch = (s: unknown) => {
        if (typeof s === 'string' && cols.some((c) => s.includes(c))) refused = true;
      };
      const wrap: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'in', 'not', 'limit', 'order']) {
        wrap[m] = (...a: unknown[]) => {
          touch(a[0]);
          q[m](...a);
          return wrap;
        };
      }
      for (const m of ['update', 'insert', 'upsert']) {
        wrap[m] = (...a: unknown[]) => {
          for (const k of Object.keys((a[0] as Row) ?? {})) touch(k);
          q[m](...a);
          return wrap;
        };
      }
      const err = { code: 'PGRST204', message: "Could not find the column in the schema cache" };
      wrap.maybeSingle = () => (refused ? Promise.resolve({ data: null, error: err }) : q.maybeSingle());
      wrap.single = () => (refused ? Promise.resolve({ data: null, error: err }) : q.single());
      wrap.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        (refused ? Promise.resolve({ data: null, error: err }) : (q as unknown as PromiseLike<unknown>)).then(res, rej);
      return wrap;
    },
  } as unknown as SupabaseClient;
}

async function main() {
  // ── campaign target ──────────────────────────────────────────────────────
  {
    resetCpmShadowCaches();
    const store = makeStore();
    seed(store, { target: 8, max: 12 });
    const r = await recordShadowPricingBasis(store.sb, base);
    const basis = store.getOffer('offer-1')?.pricing_basis as Row | undefined;
    assert(r.outcome === 'written', `campaign target: written (got ${r.outcome})`);
    // 20000 × 0.75 × 8 / 1000 = 120; walk-away × 12 = 180
    assert(basis?.method === 'cpm' && basis?.price === 120 && basis?.walkaway === 180, `campaign target: 120 / 180 (got ${JSON.stringify(basis)})`);
    assert(basis?.target_source === 'campaign', 'campaign target: source recorded');
    assert(basis?.formula_price === 150 && basis?.applied === false, 'formula price alongside, not applied');
    assert(store.getOffer('offer-1')?.initial_offer_usd === 150, 'the formula price on the row is untouched');
  }

  // ── cold start from the scored pool ──────────────────────────────────────
  {
    resetCpmShadowCaches();
    const store = makeStore();
    seed(store);
    // Two more scored creators + one unscored (excluded from the pool).
    for (const [id, followers, plays] of [
      ['inf-2', 5_000, 10_000],
      ['inf-3', 100_000, 40_000],
      ['inf-4', 100_000, 1],
    ] as Array<[string, number, number]>) {
      store.seed('influencers', { id, platform: 'tiktok', follower_count: followers, engagement_rate: 0.0813, raw_data: { posts: posts([plays, plays, plays]) } });
      store.seed('campaign_influencers', {
        id: `ci-${id}`,
        campaign_id: 'camp-1',
        influencer_id: id,
        composite_score: id === 'inf-4' ? null : 0.5,
      });
    }
    const r = await recordShadowPricingBasis(store.sb, base);
    const b = r.basis;
    // Formula prices (1.0x engagement): inf-1 25k → 100, inf-2 5k → 50, inf-3 100k → 250.
    // Implied CPM on views×0.75: 100/15 = 6.67, 50/7.5 = 6.67, 250/30 = 8.33 → median 6.67.
    assert(b?.target_source === 'pool' && b?.target === 6.67 && b?.target_n === 3, `cold start: pool median 6.67 over 3 scored creators (got ${JSON.stringify(b)})`);
    assert(b?.price === 100, `cold start: a pool-median creator prices at its formula price (got ${b?.price})`);
  }

  // ── no pool, no target → constant ────────────────────────────────────────
  {
    resetCpmShadowCaches();
    const store = makeStore();
    seed(store);
    const r = await recordShadowPricingBasis(store.sb, base);
    assert(r.basis?.target_source === 'default' && r.basis?.target === COLD_START_TARGET_CPM_USD, 'thin pool → constant target');
  }

  // ── Instagram / thin history → formula fallback, still recorded ──────────
  {
    resetCpmShadowCaches();
    const store = makeStore();
    seed(store, { platform: 'instagram', target: 8 });
    const r = await recordShadowPricingBasis(store.sb, base);
    assert(r.basis?.method === 'formula' && r.basis?.views === null && r.basis?.walkaway === null, 'Instagram → formula fallback, no invented views or walk-away');
    const store2 = makeStore();
    seed(store2, { plays: [5_000, 6_000], target: 8 });
    const r2 = await recordShadowPricingBasis(store2.sb, base);
    assert(r2.basis?.method === 'formula', 'two posts → formula fallback');
  }

  // ── a supplied profile is used as-is (no second read) ────────────────────
  {
    resetCpmShadowCaches();
    const store = makeStore();
    seed(store, { target: 8 });
    const r = await recordShadowPricingBasis(store.sb, {
      ...base,
      creator_profile: { platform: 'tiktok', raw_data: { posts: posts([40_000, 40_000, 40_000]) } },
    });
    assert(r.basis?.views === 40_000, `supplied creator_profile wins (got ${r.basis?.views})`);
  }

  // ── pre-061: skipped, nothing written, nothing thrown ────────────────────
  {
    resetCpmShadowCaches();
    const store = makeStore();
    seed(store, { target: 8 });
    const sb = refusing(store, ['target_cpm_usd', 'max_cpm_usd', 'pricing_basis']);
    const r = await recordShadowPricingBasis(sb, base);
    assert(r.outcome === 'unavailable' && r.basis === null, `pre-061: unavailable (got ${r.outcome})`);
    assert(store.getOffer('offer-1')?.pricing_basis === undefined, 'pre-061: nothing written');
    // Only the basis column missing (campaign columns present): same outcome.
    const sb2 = refusing(store, ['pricing_basis']);
    const r2 = await recordShadowPricingBasis(sb2, base);
    assert(r2.outcome === 'unavailable', 'pricing_basis refused → unavailable');
  }

  // ── a database on fire cannot escape ─────────────────────────────────────
  {
    const exploding = {
      from() {
        throw new Error('database on fire');
      },
    } as unknown as SupabaseClient;
    let threw = false;
    try {
      const r = await recordShadowPricingBasis(exploding, base);
      assert(r.outcome === 'failed', 'exploding DB → failed outcome');
      const f = await recordFirstAsk(exploding, { id: 'offer-1' }, 300);
      assert(f === 'failed', 'exploding DB → first ask failed outcome');
    } catch {
      threw = true;
    }
    assert(!threw, 'shadow writes never throw');
  }

  // ── createOffer: the returned row and the stored price are the formula's ─
  {
    resetCpmShadowCaches();
    const store = makeStore();
    seed(store, { target: 1, max: 2 }); // absurd CPM that would gut the price if anything used it
    const row = await createOffer(store.sb, {
      campaign_influencer_id: 'ci-1',
      campaign_id: 'camp-1',
      firm_id: 'firm-1',
      follower_count: 25_000,
      engagement_rate: 0.0813,
      per_creator_cap_usd: 500,
      genre_premiums: {},
      negotiation_history: [],
    });
    const stored = store.getOffer(row.id);
    assert(row.initial_offer_usd === 100 && row.current_offer_usd === 100, `createOffer returns the formula price (got ${row.initial_offer_usd})`);
    assert(stored?.initial_offer_usd === 100 && stored?.current_offer_usd === 100, 'createOffer stores the formula price');
    const basis = stored?.pricing_basis as Row | undefined;
    assert(basis?.price === 15 && basis?.formula_price === 100, `pricing_basis holds the CPM price beside it (got ${JSON.stringify(basis)})`);
  }

  // ── first_ask_usd ────────────────────────────────────────────────────────
  {
    const store = makeStore();
    seed(store);
    assert((await recordFirstAsk(store.sb, { id: 'offer-1' }, 300)) === 'written', 'first ask written');
    assert(store.getOffer('offer-1')?.first_ask_usd === 300, 'first ask = 300');
    // The caller's row is stale (it says null): the conditional write still refuses to overwrite.
    await recordFirstAsk(store.sb, { id: 'offer-1', first_ask_usd: null }, 250);
    assert(store.getOffer('offer-1')?.first_ask_usd === 300, 'a later ask never overwrites the first (DB-side conditional)');
    assert((await recordFirstAsk(store.sb, { id: 'offer-1', first_ask_usd: 300 }, 250)) === 'skipped', 'a row that already has one is skipped without a write');
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert((await recordFirstAsk(store.sb, { id: 'offer-1' }, bad)) === 'skipped', `non-positive/non-finite ask ${bad} is skipped`);
    }
    const store2 = makeStore();
    seed(store2);
    assert((await recordFirstAsk(refusing(store2, ['first_ask_usd']), { id: 'offer-1' }, 300)) === 'unavailable', 'pre-062 → unavailable');
    assert(store2.getOffer('offer-1')?.first_ask_usd === undefined, 'pre-062 → nothing written');
  }

  // ── schema-miss detection ────────────────────────────────────────────────
  for (const code of ['PGRST204', 'PGRST205', '42703', '42P01']) {
    assert(isMissingSchemaError({ code }), `${code} is a missing-schema error`);
  }
  assert(!isMissingSchemaError({ code: '23514', message: 'violates check constraint' }), 'a CHECK violation is not a missing-schema error');
  assert(!isMissingSchemaError(null), 'no error is not a missing-schema error');

  console.log(`cpm-shadow test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
