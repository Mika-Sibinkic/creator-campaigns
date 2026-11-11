// tests/rl-opening.test.ts
//
// S3.4 — RL loop closure for the opening-offer estimator. Proves that prior
// same-firm closed negotiations (the (opening, agreed) history) actually reach
// estimateOpeningPct through createOffer, and move opening_pct in the
// direction the gap correction implies:
//
//   deals historically closing ABOVE our opening → we open HIGHER
//   deals historically closing BELOW our opening → we open LOWER
//   no history (cold start)                      → prior behavior, unchanged
//
// Hermetic: in-memory Supabase mock (the negotiation-harness store) +
// injected history arrays. No network, no DB, no model calls.
//
// Run: npx tsx tests/rl-opening.test.ts

import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub
import {
  createOffer,
  fetchNegotiationHistory,
  getOpeningPct,
  NEGOTIATION_HISTORY_LIMIT,
  type NegotiationOutcome,
} from '../src/lib/negotiation';
import type { MarketDataPoint } from '../src/lib/pricing-engine';
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

const EPS = 1e-9;

// ── Shared fixture ───────────────────────────────────────────────────────────
// One creator profile + enough (cost, output) market history to clear
// RL_OPENING_MIN_SAMPLE (5), so the estimator leaves cold start and the gap
// correction can actually fire. Linear streams=10×payment keeps every number
// deterministic and the blended pct mid-range (clamping never bites).

const CREATOR = {
  follower_count: 5000,
  engagement_rate: 0.05,
  genre: 'pop' as const,
  ceiling_usd: 500,
};

const MARKET_DATA: MarketDataPoint[] = [40, 60, 80, 100, 120, 140].map((p) => ({
  follower_count: 5000,
  engagement_rate: 0.05,
  payment_usd: p,
  streams_attributed: p * 10,
  genre: 'pop',
}));

// Deals historically closed $50 ABOVE where we opened (mean gap +0.1 of ceiling).
const UP_HISTORY: NegotiationOutcome[] = Array.from({ length: 6 }, () => ({
  opening_usd: 100,
  agreed_usd: 150,
  ceiling_usd: 500,
}));

// Mirror image: closed $50 BELOW where we opened.
const DOWN_HISTORY: NegotiationOutcome[] = Array.from({ length: 6 }, () => ({
  opening_usd: 150,
  agreed_usd: 100,
  ceiling_usd: 500,
}));

function pct(history?: NegotiationOutcome[]): number {
  return getOpeningPct({
    ...CREATOR,
    market_data: MARKET_DATA,
    negotiation_history: history,
  });
}

/** Seed a firm-scoped creator_offers row shaped like migration 009+018. */
function seedClosedOffer(
  store: ReturnType<typeof makeStore>,
  over: Partial<Row> & { id: string; firm_id: string; status: string },
): void {
  store.seedOffer({
    campaign_influencer_id: `ci-${over.id}`,
    campaign_id: 'camp-hist',
    initial_offer_usd: 100,
    current_offer_usd: 150,
    agreed_amount_usd: 150,
    ceiling_usd: 500,
    rounds: 2,
    last_message_id: null,
    approved_at: null,
    approved_by_user_id: null,
    paid_at: null,
    posted_at: null,
    post_url: null,
    autonomy_mode: 'auto',
    opening_pct: null,
    injection_flagged: false,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...over,
  });
}

const CREATE_INPUT = {
  campaign_influencer_id: 'ci-new',
  campaign_id: 'camp-new',
  follower_count: CREATOR.follower_count,
  engagement_rate: CREATOR.engagement_rate,
  genre: CREATOR.genre,
  per_creator_cap_usd: CREATOR.ceiling_usd,
  market_data: MARKET_DATA,
};

// ── 1. Estimator seam: injected history moves opening_pct directionally ─────
function scenarioEstimatorDirection() {
  const base = pct();
  const up = pct(UP_HISTORY);
  const down = pct(DOWN_HISTORY);

  assert(base > 0 && base < 1, `baseline opening_pct in (0,1) (got ${base})`);
  assert(up !== base, `up-history ≠ cold start (${up} vs ${base})`);
  assert(down !== base, `down-history ≠ cold start (${down} vs ${base})`);
  assert(up > base, `deals closing ABOVE opening ⇒ open HIGHER (${up} > ${base})`);
  assert(down < base, `deals closing BELOW opening ⇒ open LOWER (${down} < ${base})`);
  assert(
    Math.abs(up - base - (base - down)) < EPS,
    'gap correction is symmetric for mirror-image histories',
  );
}

// ── 2. Wiring: createOffer pulls same-firm closed deals from the DB ─────────
async function scenarioCreateOfferWiring() {
  // Firm WITH history: 6 closed deals across the committed-status set, all
  // opened at $100 and agreed at $150 (deals close above our opening).
  const storeH = makeStore();
  storeH.seedCampaign('camp-hist', null);
  const statuses = [
    'measured',
    'paid',
    'posted',
    'approved',
    'human_approval_required',
    'agreed',
  ];
  statuses.forEach((status, i) =>
    seedClosedOffer(storeH, {
      id: `hist-${i}`,
      firm_id: 'firm-rl',
      status,
      created_at: `2026-07-0${i + 1}T00:00:00.000Z`,
    }),
  );
  // Noise that must NOT leak into the signal:
  seedClosedOffer(storeH, {
    id: 'noise-other-firm',
    firm_id: 'firm-other',
    status: 'measured',
    initial_offer_usd: 10,
    agreed_amount_usd: 490, // huge gap — would blow up the mean if included
  });
  seedClosedOffer(storeH, {
    id: 'noise-rejected',
    firm_id: 'firm-rl',
    status: 'rejected', // not a closed deal
    initial_offer_usd: 10,
    agreed_amount_usd: 490,
  });
  seedClosedOffer(storeH, {
    id: 'noise-null-agreed',
    firm_id: 'firm-rl',
    status: 'measured',
    agreed_amount_usd: null, // no gap signal → dropped
  });
  seedClosedOffer(storeH, {
    id: 'noise-zero-ceiling',
    firm_id: 'firm-rl',
    status: 'measured',
    ceiling_usd: 0, // un-normalizable → dropped
  });

  const offerH = await createOffer(storeH.sb, { ...CREATE_INPUT, firm_id: 'firm-rl' });

  // Identical cold-start firm: zero prior offers.
  const storeC = makeStore();
  storeC.seedCampaign('camp-new', null);
  const offerC = await createOffer(storeC.sb, { ...CREATE_INPUT, firm_id: 'firm-cold' });

  const openH = Number(offerH.opening_pct);
  const openC = Number(offerC.opening_pct);

  assert(
    openH !== openC,
    `firm with closed deals gets a DIFFERENT opening_pct than a cold-start twin (${openH} vs ${openC})`,
  );
  assert(
    openH > openC,
    `history closes above opening ⇒ wired opening_pct is HIGHER (${openH} > ${openC})`,
  );
  assert(
    openC === pct(),
    `cold start (zero rows) is byte-identical to the no-history estimate (${openC})`,
  );
  assert(
    openH === pct(UP_HISTORY),
    `DB rows map to NegotiationOutcome[] exactly — wired result equals injected-history result (${openH})`,
  );

  // Injected history takes precedence over the DB fetch (pure-test seam).
  const offerInj = await createOffer(storeH.sb, {
    ...CREATE_INPUT,
    campaign_influencer_id: 'ci-inj',
    firm_id: 'firm-rl',
    negotiation_history: [],
  });
  assert(
    Number(offerInj.opening_pct) === openC,
    'explicitly injected (empty) history overrides the DB fetch → cold start',
  );
}

// ── 3. fetchNegotiationHistory: mapping, cap, zero-row safety ────────────────
async function scenarioFetchHistory() {
  // Zero rows — cold start must be a clean [].
  const empty = makeStore();
  const none = await fetchNegotiationHistory(empty.sb, 'firm-anything');
  assert(Array.isArray(none) && none.length === 0, 'zero prior offers → [] (no throw)');

  // 25 closed deals: the 5 OLDEST have agreed=$999, the 20 most recent $200.
  // The cap must keep only the 20 most recent.
  const store = makeStore();
  for (let i = 0; i < 25; i++) {
    seedClosedOffer(store, {
      id: `cap-${i}`,
      firm_id: 'firm-cap',
      status: 'measured',
      agreed_amount_usd: i < 5 ? 999 : 200,
      created_at: new Date(Date.UTC(2026, 5, 1 + i)).toISOString(), // strictly increasing
    });
  }
  const hist = await fetchNegotiationHistory(store.sb, 'firm-cap');
  assert(
    hist.length === NEGOTIATION_HISTORY_LIMIT,
    `history capped at ${NEGOTIATION_HISTORY_LIMIT} rows (got ${hist.length})`,
  );
  assert(
    hist.every((h) => h.agreed_usd === 200),
    'cap keeps the MOST RECENT rows (no $999 stragglers from the oldest 5)',
  );
  assert(
    hist.every(
      (h) =>
        typeof h.opening_usd === 'number' &&
        typeof h.agreed_usd === 'number' &&
        h.ceiling_usd > 0,
    ),
    'every mapped outcome carries numeric opening/agreed/ceiling',
  );
}

async function main() {
  const origWarn = console.warn;
  if (!process.env.DEBUG) console.warn = () => {};

  scenarioEstimatorDirection();
  await scenarioCreateOfferWiring();
  await scenarioFetchHistory();

  console.warn = origWarn;

  console.log(`rl-opening test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
