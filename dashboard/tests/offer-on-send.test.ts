// tests/offer-on-send.test.ts
//
// Pins openOfferForSentOutreach — the wire that makes the auto-negotiator
// reachable at all.
//
// THE BUG THIS EXISTS TO PREVENT RECURRING
//   createOffer() and makeInitialOffer() had zero non-test callers. The only
//   path that created a creator_offers row inserted at 'agreed' and promoted to
//   'human_approval_required'; autoNegotiateInbound no-ops on anything that is
//   not 'offered'/'counter_offered'. So ~3,150 lines of negotiation logic were
//   unreachable from the app while every negotiation suite stayed green,
//   because those suites construct an 'offered' offer as a fixture.
//
//   A test that constructs the offer cannot catch that. This one asserts on the
//   guards that protect money when the offer is created for real.
//
// Hermetic: in-memory Supabase double, no network, no model.
//
// Run: npx tsx tests/offer-on-send.test.ts

export {};

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

interface Tables {
  creator_offers: Record<string, unknown>[];
  campaigns: Record<string, unknown>[];
  campaign_influencers?: Record<string, unknown>[];
  influencers?: Record<string, unknown>[];
}

function makeFakeSupabase(tables: Tables) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];

  function from(table: string) {
    let rows = ((tables as unknown as Record<string, Record<string, unknown>[]>)[table] ?? []).slice();
    const api: Record<string, unknown> = {
      select() {
        return api;
      },
      insert(row: Record<string, unknown>) {
        inserts.push({ table, row });
        rows = [{ ...row, id: `new-${inserts.length}` }];
        return api;
      },
      update() {
        return api;
      },
      eq(col: string, val: unknown) {
        rows = rows.filter((r) => r[col] === val);
        return api;
      },
      in(col: string, vals: unknown[]) {
        rows = rows.filter((r) => vals.includes(r[col]));
        return api;
      },
      // Reads createOffer makes on the way (history, genre premiums, budget):
      // chainable no-ops so the real path runs end to end over the fixture.
      neq() { return api; },
      not() { return api; },
      is() { return api; },
      gte() { return api; },
      lte() { return api; },
      order() { return api; },
      limit() {
        return api;
      },
      maybeSingle() {
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      single() {
        return Promise.resolve({
          data: rows[0] ?? null,
          error: rows[0] ? null : { message: 'not found' },
        });
      },
      then(resolve: (v: { data: unknown; error: null }) => unknown) {
        return Promise.resolve(resolve({ data: rows, error: null }));
      },
    };
    return api as never;
  }

  return { client: { from } as never, inserts };
}

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:9';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-dummy';

  const { openOfferForSentOutreach } = await import('../src/lib/negotiation');

  const base = {
    campaign_influencer_id: 'ci-1',
    campaign_id: 'camp-1',
    firm_id: 'firm-1',
    outreach_message_id: 'msg-1',
    follower_count: 25_000,
    engagement_rate: 0.05,
  };

  // ── 1. Idempotent: an existing offer is returned, never duplicated ────────
  // The send route can be retried, and a second offer would double-count the
  // campaign budget against the DB ceiling CHECK.
  {
    const existing = { id: 'offer-existing', campaign_influencer_id: 'ci-1', status: 'offered' };
    const { client, inserts } = makeFakeSupabase({
      creator_offers: [existing],
      campaigns: [{ id: 'camp-1', per_creator_cap_usd: 500 }],
    });
    const out = await openOfferForSentOutreach(client, base);
    assert(out?.id === 'offer-existing', 'an existing offer is returned as-is');
    assert(
      inserts.filter((i) => i.table === 'creator_offers').length === 0,
      'no second offer is inserted for a creator who already has one',
    );
  }

  // ── 2. No per-creator cap → no offer, and nothing written ────────────────
  // The ceiling is enforced by a DB CHECK. Inventing one here would be
  // fabricating the single number that structural guard depends on.
  for (const cap of [null, 0, undefined, 'not-a-number']) {
    const { client, inserts } = makeFakeSupabase({
      creator_offers: [],
      campaigns: [{ id: 'camp-1', per_creator_cap_usd: cap }],
    });
    const out = await openOfferForSentOutreach(client, base);
    assert(out === null, `cap=${String(cap)} opens no offer`);
    assert(inserts.length === 0, `cap=${String(cap)} writes nothing`);
  }

  // ── 3. A missing campaign row is survivable ──────────────────────────────
  {
    const { client } = makeFakeSupabase({ creator_offers: [], campaigns: [] });
    const out = await openOfferForSentOutreach(client, base);
    assert(out === null, 'a missing campaign yields null rather than throwing');
  }

  // ── 4. Never throws ──────────────────────────────────────────────────────
  // The email has already left by the time this runs. A pricing hiccup must not
  // turn a delivered message into a 500 the operator retries — which would then
  // send a second email.
  {
    const exploding = {
      from() {
        throw new Error('database on fire');
      },
    } as never;
    let threw = false;
    let out: unknown = 'unset';
    try {
      out = await openOfferForSentOutreach(exploding, base);
    } catch {
      threw = true;
    }
    assert(!threw, 'a database failure does not propagate out of the send path');
    assert(out === null, 'and it resolves null');
  }

  // ── 5. The creator's platform reaches the pricer ─────────────────────────
  // Regression: this path never passed creator_profile, so
  // platform was null in createOffer and the engagement multiplier fell back
  // to the TikTok-calibrated curve. An Instagram creator at 20k followers and
  // 3.2% ER opened at $82 instead of $134. Driven through the real
  // openOfferForSentOutreach path, asserting on the row actually inserted.
  {
    const { calculateInitialOffer } = await import('../src/lib/pricing-engine');
    const ig = { ...base, follower_count: 20_000, engagement_rate: 0.032 };
    const expected = (platform: string | null) =>
      calculateInitialOffer({
        follower_count: 20_000,
        engagement_rate: 0.032,
        platform,
        genre: null,
        per_creator_cap_usd: 500,
      }).initial_offer_usd;
    assert(expected('instagram') === 134 && expected('tiktok') === 82, 'fixture: IG and TikTok curves differ (134 vs 82)');

    const insertedOffer = (inserts: Array<{ table: string; row: Record<string, unknown> }>) =>
      inserts.find((i) => i.table === 'creator_offers')?.row;

    // 5a. Platform loaded from the creator row (callers that do not carry it).
    {
      const { client, inserts } = makeFakeSupabase({
        creator_offers: [],
        campaigns: [{ id: 'camp-1', per_creator_cap_usd: 500 }],
        campaign_influencers: [{ id: 'ci-1', influencer_id: 'inf-1' }],
        influencers: [{ id: 'inf-1', platform: 'instagram', raw_data: null }],
      });
      await openOfferForSentOutreach(client, ig);
      const row = insertedOffer(inserts);
      assert(
        row?.initial_offer_usd === 134,
        `instagram creator (loaded) opens on the instagram curve: got ${String(row?.initial_offer_usd)}, want 134`,
      );
    }

    // 5b. Platform supplied by the caller from the creator row it already holds.
    {
      const { client, inserts } = makeFakeSupabase({
        creator_offers: [],
        campaigns: [{ id: 'camp-1', per_creator_cap_usd: 500 }],
      });
      await openOfferForSentOutreach(client, { ...ig, platform: 'instagram' });
      const row = insertedOffer(inserts);
      assert(
        row?.initial_offer_usd === 134,
        `instagram creator (passed) opens on the instagram curve: got ${String(row?.initial_offer_usd)}, want 134`,
      );
    }

    // 5c. TikTok is unchanged.
    {
      const { client, inserts } = makeFakeSupabase({
        creator_offers: [],
        campaigns: [{ id: 'camp-1', per_creator_cap_usd: 500 }],
        campaign_influencers: [{ id: 'ci-1', influencer_id: 'inf-1' }],
        influencers: [{ id: 'inf-1', platform: 'tiktok', raw_data: null }],
      });
      await openOfferForSentOutreach(client, ig);
      assert(insertedOffer(inserts)?.initial_offer_usd === 82, 'tiktok creator still opens at $82');
    }
  }

  console.log(`offer-on-send test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
