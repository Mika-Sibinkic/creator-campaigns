// tests/negotiation-harness/run.ts
//
// The full-auto negotiation edge-case harness (spec: Negotiation safety —
// "every negotiation tactic, every response," paper-trade first). Hermetic:
// in-memory Supabase mock + deterministic mock model provider, no network, no
// DB, no real API calls.
//
// Proves, in paper mode, that the auto loop handles lowball / over-ask /
// injection / garbled / ghosting / immediate-accept / multi-round convergence /
// budget-exhaustion / manual-mode / real-money paths — and that NO path ever
// exceeds the per-creator ceiling or the campaign budget.
//
// Run: npx tsx tests/negotiation-harness/run.ts

import './setup-env'; // FIRST — dummy env + fetch stub before negotiation.ts loads
import {
  autoNegotiateInbound,
  createOffer,
  getOpeningPct,
  chooseSweetSpot,
  marginalOutputPerDollar,
  type CreatorOfferRow,
} from '../../src/lib/negotiation';
import { registerProvider } from '../../src/lib/model-provider';
import { makeStore, type Row } from './store';
import { normalizeDeliverables } from '../../src/lib/deliverables';
import { DEFAULT_DELIVERABLES } from '../../src/lib/deliverables-store';
import { bundleValueUnits } from '../../src/lib/pricing-engine';
import { SCENARIOS, type Scenario, type Step } from './fixtures';

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

const EPS = 1e-9;
const COMMITTED_STATES = [
  'agreed',
  'human_approval_required',
  'approved',
  'paid',
  'posted',
  'measured',
];

// ── Deterministic mock model provider ───────────────────────────────────────
// Maps each reply that expects a model call to its canned output. The provider
// returns the output for the longest reply-string contained in the prompt.
const modelMap = new Map<string, string>();
for (const sc of SCENARIOS) {
  for (const step of sc.steps) {
    if (step.model) {
      modelMap.set(step.inbound, step.model.rawModel ?? JSON.stringify(step.model.negotiator));
    }
  }
}
const modelCalls: string[] = [];
registerProvider('mock', async ({ user }) => {
  modelCalls.push(user);
  let bestKey = '';
  let bestOut = '';
  for (const [reply, out] of modelMap) {
    if (user.includes(reply) && reply.length > bestKey.length) {
      bestKey = reply;
      bestOut = out;
    }
  }
  // Unmapped → a safe, valid "unclear" so an accidental call can never pay out.
  return bestKey ? bestOut : '{"intent":"unclear","counter_usd":null,"sentiment":"neutral","confidence":0.9}';
});

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
const NOW = '2026-07-06T00:00:00.000Z';

function committedInCampaign(store: ReturnType<typeof makeStore>, campaignId: string): number {
  return store
    .allOffers()
    .filter((r) => r.campaign_id === campaignId && COMMITTED_STATES.includes(String(r.status)))
    .reduce((sum, r) => sum + Number(r.agreed_amount_usd ?? r.current_offer_usd ?? 0), 0);
}

function assertCaps(sc: Scenario, store: ReturnType<typeof makeStore>, offerId: string, campaignId: string) {
  const o = store.getOffer(offerId);
  if (!o) return;
  const ceil = Number(o.ceiling_usd);
  if (o.agreed_amount_usd != null) {
    assert(
      Number(o.agreed_amount_usd) <= ceil + EPS,
      `${sc.name} :: agreed $${o.agreed_amount_usd} ≤ per-creator ceiling $${ceil}`,
    );
  }
  if (o.current_offer_usd != null) {
    assert(
      Number(o.current_offer_usd) <= ceil + EPS,
      `${sc.name} :: current offer $${o.current_offer_usd} ≤ ceiling $${ceil}`,
    );
  }
  if (sc.budget != null && sc.budget > 0) {
    const committed = committedInCampaign(store, campaignId);
    assert(
      committed <= sc.budget + EPS,
      `${sc.name} :: campaign committed $${committed} ≤ budget $${sc.budget}`,
    );
  }
}

/**
 * THE RATCHET INVARIANT, checked on EVERY step of EVERY scenario
 * rather than in one dedicated case: our quoted number may never fall below
 * the highest number this creator has already seen, unless the package it is
 * quoted for strictly shrank. A single scenario proves the original bug is gone; a
 * global invariant is what stops the next counter-producing branch from
 * reintroducing it somewhere else in the state machine.
 */
function packageUnits(row: Row | undefined): number {
  const norm = normalizeDeliverables(row?.agreed_deliverables);
  return bundleValueUnits(norm.length ? norm : DEFAULT_DELIVERABLES);
}

async function runScenario(sc: Scenario) {
  // Payment-mode override (proves real money never auto-pays). Restored after.
  const savedMode = process.env.PAYMENTS_MODE;
  const savedKey = process.env.STRIPE_SECRET_KEY;
  if (sc.paymentMode === 'stripe_test') {
    process.env.PAYMENTS_MODE = 'stripe_test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  } else {
    process.env.PAYMENTS_MODE = 'paper';
    delete process.env.STRIPE_SECRET_KEY;
  }

  const store = makeStore();
  const campaignId = `camp-${slug(sc.name)}`;
  store.seedCampaign(campaignId, sc.budget ?? null);

  if (sc.committedByOthers && sc.committedByOthers > 0) {
    store.seedOffer({
      id: `sibling-${slug(sc.name)}`,
      campaign_influencer_id: 'ci-sib',
      campaign_id: campaignId,
      firm_id: 'firm-1',
      status: 'paid',
      initial_offer_usd: sc.committedByOthers,
      current_offer_usd: sc.committedByOthers,
      agreed_amount_usd: sc.committedByOthers,
      ceiling_usd: 100000,
      rounds: 0,
      last_message_id: null,
      autonomy_mode: 'auto',
      opening_pct: null,
      injection_flagged: false,
      created_at: NOW,
      updated_at: NOW,
    });
  }

  const offerId = `offer-${slug(sc.name)}`;
  const seed: Row = {
    id: offerId,
    campaign_influencer_id: 'ci-1',
    campaign_id: campaignId,
    firm_id: 'firm-1',
    status: 'offered',
    initial_offer_usd: sc.currentOffer,
    current_offer_usd: sc.currentOffer,
    agreed_amount_usd: null,
    ceiling_usd: sc.ceiling,
    rounds: sc.rounds ?? 0,
    last_message_id: null,
    approved_at: null,
    approved_by_user_id: null,
    paid_at: null,
    posted_at: null,
    post_url: null,
    autonomy_mode: sc.autonomy ?? 'auto',
    opening_pct: null,
    injection_flagged: false,
    created_at: NOW,
    updated_at: NOW,
  };
  store.seedOffer(seed);

  let offer = { ...store.getOffer(offerId) } as unknown as CreatorOfferRow;
  // Ratchet bookkeeping: the highest number this creator has seen, and the
  // effort-units of the package it was quoted for.
  let highWaterUsd = Number(seed.current_offer_usd ?? 0);
  let packageUnitsBefore = packageUnits(store.getOffer(offerId));
  for (const step of sc.steps as Step[]) {
    const before = modelCalls.length;
    const res = await autoNegotiateInbound(store.sb, offer, {
      inbound_text: step.inbound,
      inbound_message_id: 'msg-1',
    });
    const called = modelCalls.length > before;

    assert(res.outcome === step.expectOutcome, `${sc.name} :: outcome=${res.outcome} (want ${step.expectOutcome})`);
    if (step.expectPaid !== undefined) {
      assert(res.paid_usd === step.expectPaid, `${sc.name} :: paid=${res.paid_usd} (want ${step.expectPaid})`);
    }
    if (step.expectModelCalled !== undefined) {
      assert(called === step.expectModelCalled, `${sc.name} :: modelCalled=${called} (want ${step.expectModelCalled})`);
    }

    const cur = store.getOffer(offerId);
    if (step.expectFinalStatus && cur) {
      assert(cur.status === step.expectFinalStatus, `${sc.name} :: status=${cur.status} (want ${step.expectFinalStatus})`);
    }
    if (step.expectInjectionFlagged !== undefined && cur) {
      assert(cur.injection_flagged === step.expectInjectionFlagged, `${sc.name} :: injection_flagged=${cur.injection_flagged} (want ${step.expectInjectionFlagged})`);
    }
    if (step.expectCurrentOffer !== undefined && cur) {
      assert(
        Number(cur.current_offer_usd) === step.expectCurrentOffer,
        `${sc.name} :: current_offer=$${cur.current_offer_usd} (want $${step.expectCurrentOffer})`,
      );
    }
    // Term-level assertions: the frozen package on the offer row.
    if (step.expectDeliverables && cur) {
      const del = Array.isArray(cur.agreed_deliverables)
        ? (cur.agreed_deliverables as Array<Record<string, unknown>>)
        : [];
      assert(
        del.length === step.expectDeliverables.length,
        `${sc.name} :: agreed_deliverables has ${step.expectDeliverables.length} line(s) (got ${del.length})`,
      );
      for (const exp of step.expectDeliverables) {
        const line = del.find((d) => d.promo_type === exp.promo_type);
        assert(!!line, `${sc.name} :: agreed_deliverables has a ${exp.promo_type} line`);
        if (line) {
          assert(
            Number(line.quantity) === exp.quantity,
            `${sc.name} :: ${exp.promo_type} quantity=${line.quantity} (want ${exp.quantity})`,
          );
          if (exp.min_seconds !== undefined) {
            assert(
              (line.min_seconds ?? null) === exp.min_seconds,
              `${sc.name} :: ${exp.promo_type} min_seconds=${line.min_seconds} (want ${exp.min_seconds})`,
            );
          }
        }
      }
    }
    if (step.expectPromptIncludes && called) {
      const prompt = modelCalls[modelCalls.length - 1] ?? '';
      for (const needle of step.expectPromptIncludes) {
        assert(
          prompt.includes(needle),
          `${sc.name} :: negotiator prompt states "${needle}"`,
        );
      }
    }
    if (step.expectDeliverablesJsonLacks && cur) {
      const json = JSON.stringify(cur.agreed_deliverables ?? null);
      for (const needle of step.expectDeliverablesJsonLacks) {
        assert(
          !json.includes(needle),
          `${sc.name} :: agreed_deliverables JSON lacks "${needle}"`,
        );
      }
    }

    assertCaps(sc, store, offerId, campaignId);

    // ── Ratchet invariant ────────────────────────────────────────────────
    const after = store.getOffer(offerId);
    const quoted = Number(after?.current_offer_usd ?? 0);
    const packageUnitsAfter = packageUnits(after);
    if (packageUnitsAfter < packageUnitsBefore - EPS) {
      // Sanctioned scope reduction: the standing number legitimately
      // re-anchors to the new, smaller quote. Everything AFTER this round is
      // measured against that.
      highWaterUsd = quoted;
    } else {
      assert(
        quoted >= highWaterUsd - EPS,
        `${sc.name} :: quoted $${quoted} never goes below our standing $${highWaterUsd} ` +
          `without the package shrinking (${packageUnitsBefore.toFixed(2)} → ${packageUnitsAfter.toFixed(2)} effort units)`,
      );
      highWaterUsd = Math.max(highWaterUsd, quoted);
    }
    packageUnitsBefore = packageUnitsAfter;

    offer = res.row;
  }

  // Restore env.
  if (savedMode === undefined) delete process.env.PAYMENTS_MODE;
  else process.env.PAYMENTS_MODE = savedMode;
  if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = savedKey;
}

async function main() {
  // Silence executePayout's paper-mode console.warn so the summary stays clean.
  // Assertion failures still print (they use console.error).
  const origWarn = console.warn;
  if (!process.env.DEBUG) console.warn = () => {};

  for (const sc of SCENARIOS) {
    await runScenario(sc);
  }

  // ── createOffer persists opening_pct + autonomy default ───────────────────
  {
    const store = makeStore();
    const created = await createOffer(store.sb, {
      campaign_influencer_id: 'ci',
      campaign_id: 'c',
      firm_id: 'f',
      follower_count: 5000,
      engagement_rate: 0.05,
      genre: 'pop',
      per_creator_cap_usd: 500,
    });
    assert(created.opening_pct != null, 'createOffer: opening_pct stored');
    assert(
      created.opening_pct !== null && created.opening_pct >= 0 && created.opening_pct <= 1,
      'createOffer: opening_pct in [0,1]',
    );
    assert(created.autonomy_mode === 'auto', 'createOffer: autonomy_mode defaults to auto');
  }

  // ── getOpeningPct seam ────────────────────────────────────────────────────
  assert(
    getOpeningPct({ follower_count: 5000, engagement_rate: 0.05, genre: 'pop', ceiling_usd: 500 }) > 0,
    'getOpeningPct: positive fraction for a normal creator',
  );
  assert(
    getOpeningPct({ follower_count: 5000, engagement_rate: 0.05, ceiling_usd: 0 }) === 0,
    'getOpeningPct: 0 when ceiling is 0',
  );

  // ── Marginal-output heuristic (the 1,500@$20 vs 5,000@$25 example) ────────
  assert(
    marginalOutputPerDollar({ cost_usd: 20, expected_output: 100 }, { cost_usd: 25, expected_output: 145 }) === 9,
    'marginalOutputPerDollar: +45 output / +$5 = 9',
  );
  assert(
    chooseSweetSpot([
      { cost_usd: 20, expected_output: 100 },
      { cost_usd: 25, expected_output: 145 },
    ]) === 1,
    'chooseSweetSpot: rides up when marginal output clears the bar',
  );
  assert(
    chooseSweetSpot([
      { cost_usd: 20, expected_output: 100 },
      { cost_usd: 25, expected_output: 145 },
      { cost_usd: 60, expected_output: 150 },
    ]) === 1,
    'chooseSweetSpot: stops at diminishing returns',
  );
  assert(chooseSweetSpot([]) === -1, 'chooseSweetSpot: empty → -1');

  console.warn = origWarn;

  console.log(`negotiation-harness: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
