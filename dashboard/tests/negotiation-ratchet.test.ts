// tests/negotiation-ratchet.test.ts
//
// The RATCHET INVARIANT: a counter can never quote less than the
// highest amount we have ALREADY put in front of that creator.
//
// Reproduces a failure found running the negotiation loop unattended:
//
//   1. we opened at $165 (ceiling $250) for the standing bundle
//      (1 30-second reel + 1 15-second story)
//   2. the creator replied asking $240 while narrowing to one TikTok
//   3. the tick countered "$126 for 1 30-second reel within 2 weeks"
//
// $126 is below our own standing $165, against someone asking $240. The
// mechanism was defensible in isolation (the term-trade value model re-priced
// the smaller package proportionally: 1.3/1.7 × $165 = $126) and that is
// exactly why the guard has to be structural rather than a prompt rule.
//
// Also pins the collision rule: the ratchet is a FLOOR, the ceiling is a
// CEILING, and when they cross THE CEILING WINS — the engine refuses rather
// than quoting a number it cannot honor.
//
// Hermetic: in-memory Supabase mock + deterministic mock provider. No network,
// no DB, no live model call.
//
// Run: npx tsx tests/negotiation-ratchet.test.ts

import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode
import {
  autoNegotiateInbound,
  type CreatorOfferRow,
} from '../src/lib/negotiation';
import {
  evaluateCounter,
  evaluateTermTrade,
  counterFloorUsd,
  applyCounterRatchet,
} from '../src/lib/pricing-engine';
import { counterBody } from '../src/lib/negotiation-tick';
import { DEFAULT_DELIVERABLES } from '../src/lib/deliverables-store';
import { describePackageReduction, type Deliverable } from '../src/lib/deliverables';
import { registerProvider } from '../src/lib/model-provider';
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

const NOW = '2026-09-14T00:00:00.000Z';

// The package + the creator's reply, minus the "I'd normally
// charge $300" clause: a counter naming two prices goes to a
// human (counter_price_unclear), so the ratchet is exercised on the single
// $240 ask. The two-price original is pinned in the harness fixtures.
const REEL_ONLY: Deliverable[] = [
  { promo_type: 'reel', quantity: 1, delivery_window_days: 14, min_seconds: 30 },
];
const CREATOR_REPLY =
  'I could do $240 if we keep it ' +
  'to one TikTok. Could also throw in a story if that helps. When would you need it posted by?';
const OVER_ASK_REPLY = 'I need $900 for this one, that is my rate.';

// ── Deterministic mock provider ─────────────────────────────────────────────
// Returns the negotiator read the LIVE model actually produced for that reply:
// a $240 counter that narrows the package to a single 30-second reel.
registerProvider('mock', async ({ user }) => {
  if (user.includes('keep it to one TikTok')) {
    return JSON.stringify({
      intent: 'counter',
      counter_usd: 240,
      sentiment: 'positive',
      confidence: 0.9,
      terms: { quantity: 1, promo_type: 'reel', min_seconds: 30, schedule_note: null },
    });
  }
  if (user.includes('I need $900')) {
    return JSON.stringify({
      intent: 'counter',
      counter_usd: 900,
      sentiment: 'neutral',
      confidence: 0.9,
    });
  }
  if (user.includes('$60 flat')) {
    return JSON.stringify({
      intent: 'counter',
      counter_usd: 60,
      sentiment: 'positive',
      confidence: 0.9,
    });
  }
  return JSON.stringify({
    intent: 'unclear',
    counter_usd: null,
    sentiment: 'neutral',
    confidence: 0.9,
  });
});

function seed(opts: {
  campaignId: string;
  budget: number | null;
  offerId: string;
  initial: number;
  current: number;
  ceiling: number;
  rounds: number;
  committedByOthers?: number;
}) {
  const store = makeStore();
  store.seedCampaign(opts.campaignId, opts.budget);
  if (opts.committedByOthers && opts.committedByOthers > 0) {
    store.seedOffer({
      id: `${opts.offerId}-sibling`,
      campaign_influencer_id: 'ci-sib',
      campaign_id: opts.campaignId,
      firm_id: 'firm-1',
      status: 'paid',
      initial_offer_usd: opts.committedByOthers,
      current_offer_usd: opts.committedByOthers,
      agreed_amount_usd: opts.committedByOthers,
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
  const row: Row = {
    id: opts.offerId,
    campaign_influencer_id: 'ci-1',
    campaign_id: opts.campaignId,
    firm_id: 'firm-1',
    status: 'offered',
    initial_offer_usd: opts.initial,
    current_offer_usd: opts.current,
    agreed_amount_usd: null,
    ceiling_usd: opts.ceiling,
    rounds: opts.rounds,
    last_message_id: null,
    approved_at: null,
    approved_by_user_id: null,
    paid_at: null,
    posted_at: null,
    post_url: null,
    autonomy_mode: 'auto',
    opening_pct: null,
    injection_flagged: false,
    created_at: NOW,
    updated_at: NOW,
  };
  store.seedOffer(row);
  return { store, offer: { ...store.getOffer(opts.offerId) } as unknown as CreatorOfferRow };
}

async function main() {
  const origWarn = console.warn;
  if (!process.env.DEBUG) console.warn = () => {};

  // ── 1. THE ORIGINAL SEQUENCE ──────────────────────────────────────────────
  // $165 standing → creator asks $240 while narrowing to one TikTok.
  {
    const { store, offer } = seed({
      campaignId: 'camp-ada-sample',
      budget: null,
      offerId: 'offer-ratchet-1',
      initial: 165,
      current: 165,
      ceiling: 250,
      rounds: 1,
    });

    const res = await autoNegotiateInbound(store.sb, offer, {
      inbound_text: CREATOR_REPLY,
      inbound_message_id: 'inb-1',
    });

    const quoted = Number(store.getOffer('offer-ratchet-1')?.current_offer_usd);
    assert(
      res.outcome === 'countered',
      `live: outcome is a counter (got ${res.outcome})`,
    );
    assert(
      quoted >= 165,
      `live: counter $${quoted} is NOT below our own standing $165 (the $126 bug)`,
    );
    assert(quoted !== 126, `live: the exact live regression value $126 is gone (got $${quoted})`);
    assert(
      quoted <= 250,
      `live: counter $${quoted} still respects the per-creator ceiling $250`,
    );
  }

  // ── 2. PRICE-ONLY PATH — the same class of bug, no package change ─────────
  // Standing $165, but the campaign budget leaves only $180 of headroom. The
  // midpoint of (165, 180) is fine; the point here is the ratchet holds on the
  // branch that has nothing to do with terms.
  {
    const { store, offer } = seed({
      campaignId: 'camp-price-only',
      budget: 1000,
      offerId: 'offer-price-only',
      initial: 165,
      current: 165,
      ceiling: 250,
      rounds: 1,
    });
    const res = await autoNegotiateInbound(store.sb, offer, {
      inbound_text: OVER_ASK_REPLY,
      inbound_message_id: 'inb-2',
    });
    const quoted = Number(store.getOffer('offer-price-only')?.current_offer_usd);
    assert(res.outcome === 'countered', `price-only: countered (got ${res.outcome})`);
    assert(quoted >= 165, `price-only: counter $${quoted} not below standing $165`);
  }

  // ── 3. RATCHET ∧ CEILING COLLISION — the ceiling wins, engine REFUSES ─────
  // Standing $165 already communicated, but sibling spend has eaten the
  // campaign budget down to $100 of headroom. We may not quote $165 (breaches
  // the cap) and we may not quote $100 (below our own standing number). The
  // only honest move is to refuse.
  {
    const { store, offer } = seed({
      campaignId: 'camp-collision',
      budget: 1000,
      offerId: 'offer-collision',
      initial: 165,
      current: 165,
      ceiling: 250,
      rounds: 1,
      committedByOthers: 900, // remaining = $100 < standing $165
    });
    const res = await autoNegotiateInbound(store.sb, offer, {
      inbound_text: OVER_ASK_REPLY,
      inbound_message_id: 'inb-3',
    });
    const row = store.getOffer('offer-collision');
    assert(
      res.outcome === 'rejected',
      `collision: engine refuses rather than quoting an impossible number (got ${res.outcome})`,
    );
    assert(
      Number(row?.current_offer_usd) === 165,
      `collision: standing offer untouched at $165 (got $${row?.current_offer_usd})`,
    );
    assert(
      row?.agreed_amount_usd == null,
      'collision: nothing was agreed',
    );
  }

  // ── 4. CORRUPTED ROW RECOVERY ─────────────────────────────────────────────
  // The stored row already carries the damage: current_offer_usd = $126 after the
  // bad counter, initial_offer_usd = $165. The floor is the HIGHEST number ever
  // communicated, not the last one, so the next round cannot compound the drop.
  {
    const { store, offer } = seed({
      campaignId: 'camp-corrupted',
      budget: null,
      offerId: 'offer-corrupted',
      initial: 165,
      current: 126, // ← what the bug wrote
      ceiling: 250,
      rounds: 1,
    });
    const res = await autoNegotiateInbound(store.sb, offer, {
      inbound_text: CREATOR_REPLY,
      inbound_message_id: 'inb-4',
    });
    const quoted = Number(store.getOffer('offer-corrupted')?.current_offer_usd);
    assert(
      res.outcome === 'countered',
      `corrupted: countered (got ${res.outcome})`,
    );
    assert(
      quoted >= 165,
      `corrupted: floor is the HIGHEST communicated number ($165), not the last ($126) — got $${quoted}`,
    );
  }

  // ── 4b. A CAP REFUSES, IT DOES NOT QUIETLY PAY LESS ──────────────────────
  // The creator lowballs $60 against our $165, but sibling spend leaves only
  // $50 of campaign headroom. The old code did Math.min(agreed, ceiling) and
  // would have recorded "agreed $50" and auto-paid it — a number the creator
  // never said. Same class as the ratchet: a recomputation producing a
  // worse-for-the-creator figure than the one on the table.
  {
    const { store, offer } = seed({
      campaignId: 'camp-accept-clamp',
      budget: 1000,
      offerId: 'offer-accept-clamp',
      initial: 165,
      current: 165,
      ceiling: 250,
      rounds: 1,
      committedByOthers: 950, // remaining = $50 < the $60 they asked for
    });
    const res = await autoNegotiateInbound(store.sb, offer, {
      inbound_text: 'I can do it for $60 flat, that is my rate for a quick one.',
      inbound_message_id: 'inb-5',
    });
    const row = store.getOffer('offer-accept-clamp');
    assert(
      res.outcome === 'rejected',
      `accept-clamp: unaffordable acceptance refuses (got ${res.outcome})`,
    );
    assert(
      row?.agreed_amount_usd == null,
      `accept-clamp: never records an agreement the creator did not make (got $${row?.agreed_amount_usd})`,
    );
    assert(res.paid_usd === null, `accept-clamp: nothing paid (got ${res.paid_usd})`);
  }

  // ── 5. PURE: counterFloorUsd ──────────────────────────────────────────────
  {
    assert(
      counterFloorUsd({ standing_offer_usd: 165, ceiling_usd: 250, asked_usd: 240, package_reduced: true }) === 165,
      'floor: narrowing the package while asking MORE does not unlock a lower quote',
    );
    assert(
      counterFloorUsd({ standing_offer_usd: 165, ceiling_usd: 250, asked_usd: 500, package_reduced: false }) === 165,
      'floor: price-only round is floored at the standing number',
    );
    assert(
      counterFloorUsd({ standing_offer_usd: 100, ceiling_usd: 200, asked_usd: 100, package_reduced: true }) === 0,
      'floor: a genuine scope reduction the creator has not repriced upward may quote lower',
    );
    assert(
      counterFloorUsd({ standing_offer_usd: 100, ceiling_usd: 200, asked_usd: null, package_reduced: true }) === 0,
      'floor: scope reduction with no asked price may quote lower',
    );
    assert(
      counterFloorUsd({ standing_offer_usd: 0, ceiling_usd: 200, asked_usd: 50, package_reduced: false }) === 0,
      'floor: nothing communicated yet ⇒ no floor',
    );
  }

  // ── 6. PURE: applyCounterRatchet — floor raises, ceiling still wins ───────
  {
    const raised = applyCounterRatchet(126, {
      standing_offer_usd: 165,
      ceiling_usd: 250,
      asked_usd: 240,
      package_reduced: true,
    });
    assert(raised.ok && raised.amount === 165, 'ratchet: $126 is raised to the $165 floor');

    const clamped = applyCounterRatchet(400, {
      standing_offer_usd: 165,
      ceiling_usd: 250,
      asked_usd: 900,
      package_reduced: false,
    });
    assert(clamped.ok && clamped.amount === 250, 'ratchet: ceiling clamp preserved exactly');

    const collision = applyCounterRatchet(100, {
      standing_offer_usd: 165,
      ceiling_usd: 100,
      asked_usd: 900,
      package_reduced: false,
    });
    assert(
      !collision.ok,
      'ratchet: floor above ceiling REFUSES, it does not quote the ceiling',
    );
  }

  // ── 7. PURE: evaluateTermTrade ────────────────────────────────────────────
  {
    const live = evaluateTermTrade({
      current_offer_usd: 165,
      standing_offer_usd: 165,
      counter_usd: 240,
      ceiling_usd: 250,
      rounds: 2,
      current_deliverables: DEFAULT_DELIVERABLES,
      proposed_deliverables: REEL_ONLY,
    });
    assert(
      live.action === 'counter' && live.new_offer_usd === 165,
      `term-trade: live sequence counters at the $165 floor (got ${JSON.stringify(live)})`,
    );

    // Scope reduction the creator priced DOWN themselves — the value model is
    // still allowed to reduce the number.
    const honest = evaluateTermTrade({
      current_offer_usd: 100,
      standing_offer_usd: 100,
      counter_usd: 100,
      ceiling_usd: 200,
      rounds: 1,
      current_deliverables: DEFAULT_DELIVERABLES,
      proposed_deliverables: REEL_ONLY,
    });
    assert(
      honest.action === 'counter' && honest.new_offer_usd === 76,
      `term-trade: an unrepriced scope cut still values down to $76 (got ${JSON.stringify(honest)})`,
    );

    // Collision inside the term-trade branch.
    const collide = evaluateTermTrade({
      current_offer_usd: 165,
      standing_offer_usd: 165,
      counter_usd: 240,
      ceiling_usd: 120,
      rounds: 2,
      current_deliverables: DEFAULT_DELIVERABLES,
      proposed_deliverables: REEL_ONLY,
    });
    assert(
      collide.action === 'reject',
      `term-trade: floor $165 above ceiling $120 rejects (got ${JSON.stringify(collide)})`,
    );
  }

  // ── 8. PURE: evaluateCounter ──────────────────────────────────────────────
  {
    // Effective ceiling BELOW the standing offer: the midpoint formula
    // (165 + 50) / 2 = $108 would have quoted backwards.
    const collide = evaluateCounter({
      current_offer_usd: 165,
      standing_offer_usd: 165,
      counter_offer_usd: 900,
      ceiling_usd: 50,
      rounds: 1,
    });
    assert(
      collide.action === 'reject',
      `price-only: midpoint below standing refuses instead of quoting $108 (got ${JSON.stringify(collide)})`,
    );

    const normal = evaluateCounter({
      current_offer_usd: 100,
      standing_offer_usd: 100,
      counter_offer_usd: 500,
      ceiling_usd: 200,
      rounds: 1,
    });
    assert(
      normal.action === 'counter' && normal.new_offer_usd === 150,
      `price-only: ordinary midpoint unchanged at $150 (got ${JSON.stringify(normal)})`,
    );

    // Creator's own lower number is still accepted — the ratchet floors what WE
    // quote, never what they offer.
    const lowball = evaluateCounter({
      current_offer_usd: 165,
      standing_offer_usd: 165,
      counter_offer_usd: 60,
      ceiling_usd: 250,
      rounds: 1,
    });
    assert(
      lowball.action === 'accept' && lowball.agreed_amount_usd === 60,
      `price-only: creator's own lowball still accepted (got ${JSON.stringify(lowball)})`,
    );
  }

  // ── 9. COPY: a shrunk package that moved the number must SAY so ───────────
  {
    const removed = describePackageReduction(DEFAULT_DELIVERABLES, REEL_ONLY);
    assert(
      removed === '1 15-second story',
      `copy: names exactly what was removed (got ${JSON.stringify(removed)})`,
    );
    assert(
      describePackageReduction(DEFAULT_DELIVERABLES, DEFAULT_DELIVERABLES) === null,
      'copy: no reduction ⇒ nothing to explain',
    );

    const body = counterBody(76, 'warm', '1 30-second reel within 2 weeks', {
      removed_text: '1 15-second story',
      previous_amount_usd: 100,
    });
    assert(body.includes('$76'), `copy: quotes the new number ("${body}")`);
    assert(body.includes('$100'), `copy: names the number it moved from ("${body}")`);
    assert(
      body.includes('1 15-second story'),
      `copy: names what was removed ("${body}")`,
    );
    assert(!/[—–]/.test(body), `copy: no em/en dashes ("${body}")`);

    // The prior fix (counter copy may not claim finality below the ceiling)
    // must not regress: the deterministic template never claims finality.
    const FINALITY =
      /\b(final offer|best (we|i) can (do|offer)|(the )?most (we|i) can (do|pay|offer)|all (we|i) can (do|offer)|what (we|i) can (offer|do|pay)|our (max|maximum|cap|ceiling|limit)|can'?t go (any )?higher|top of (our|my) (budget|range))\b/i;
    assert(!FINALITY.test(body), `copy: reduction copy claims no finality ("${body}")`);

    const plain = counterBody(165, 'warm', '1 30-second reel within 2 weeks', null);
    assert(plain.includes('$165'), `copy: plain template unchanged ("${plain}")`);
    assert(
      !plain.includes('down to'),
      `copy: no reduction language when nothing shrank ("${plain}")`,
    );
  }

  console.warn = origWarn;
  console.log(`negotiation-ratchet: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
