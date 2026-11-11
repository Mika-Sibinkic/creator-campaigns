// tests/deal-scope.test.ts
//
// Issues #65 + #66. The label sets the deal scope, and the negotiator cannot
// trade it away. Hermetic: in-memory Supabase mock + mock model provider, no
// network, no DB, no model call.
//
// Covers: the campaign deliverable spec (derivation, resolution, precedence);
// evaluateTermTrade escalating instead of repricing an out-of-spec package;
// the negotiator schema pinning promo_type to an enum and reporting a
// discarded terms object instead of silently falling through to a price-only
// accept; a question never dying silently; and a tampered agreed_deliverables
// freeze being detected instead of quietly re-reading as the default bundle.
//
// The two centrepiece cases:
//   10 x 600-second dance/trend videos for $150 (ceiling $200) → was accept
//   3 reels for the same money                                 → was accept
//
// Run: npx tsx tests/deal-scope.test.ts

import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub before negotiation.ts loads

import {
  PROMO_MAX_SECONDS,
  applyTermsToDeliverables,
  checkPackageAgainstSpec,
  describeSpecViolations,
  specFromPackage,
  type Deliverable,
  type DeliverableSpec,
} from '../src/lib/deliverables';
import { evaluateTermTrade } from '../src/lib/pricing-engine';
import {
  DEFAULT_DELIVERABLES,
  checkFrozenDeliverables,
  resolveCampaignSpec,
} from '../src/lib/deliverables-store';
import {
  NEGOTIATOR_OUTPUT_SCHEMA,
  parseNegotiatorOutput,
  negotiatorTermsDiscardReason,
} from '../src/lib/injection-guard';
import { autoNegotiateInbound, type CreatorOfferRow } from '../src/lib/negotiation';
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

const CURRENT: Deliverable[] = DEFAULT_DELIVERABLES;
const DERIVED: DeliverableSpec = specFromPackage(CURRENT);

// ── 1. spec derivation from the standing package ────────────────────────────

assert(DERIVED.source === 'derived', 'spec: derived from a package is marked derived');
assert(DERIVED.lines.length === 2, `spec: one line per promo type in the package (got ${DERIVED.lines.length})`);
assert(
  DERIVED.lines.every((l) => l.min_quantity === 1),
  'spec: derived floor is 1 — a creator may always narrow the package (reductions still reprice)',
);
assert(
  DERIVED.lines.find((l) => l.promo_type === 'reel')?.max_quantity === 1,
  'spec: derived quantity ceiling is what the label actually asked for',
);
assert(
  DERIVED.lines.find((l) => l.promo_type === 'reel')?.max_seconds === PROMO_MAX_SECONDS.reel,
  'spec: derived length ceiling is the platform cap, not the ask',
);
assert(PROMO_MAX_SECONDS.reel === 90, `spec: a reel caps at Instagram's 90s (got ${PROMO_MAX_SECONDS.reel})`);
assert(PROMO_MAX_SECONDS.post === null, 'spec: a feed post is length-agnostic');
assert(DERIVED.max_delivery_window_days === 14, `spec: derived window is the package window (got ${DERIVED.max_delivery_window_days})`);

// ── 2. the package check ────────────────────────────────────────────────────

assert(checkPackageAgainstSpec(CURRENT, DERIVED).length === 0, 'check: the standing package is in spec against its own derivation');
{
  // A narrowed package stays in spec — this is the behaviour that already works
  // and must not regress into an escalation.
  const reelOnly: Deliverable[] = [{ promo_type: 'reel', quantity: 1, delivery_window_days: 14, min_seconds: 30 }];
  assert(checkPackageAgainstSpec(reelOnly, DERIVED).length === 0, 'check: dropping a line is in spec');
  const shorter: Deliverable[] = [{ promo_type: 'reel', quantity: 1, delivery_window_days: 14, min_seconds: 15 }];
  assert(checkPackageAgainstSpec(shorter, DERIVED).length === 0, 'check: a shorter video is in spec (it reprices down)');
}
{
  const three: Deliverable[] = [{ promo_type: 'reel', quantity: 3, delivery_window_days: 14, min_seconds: 30 }];
  const v = checkPackageAgainstSpec(three, DERIVED);
  assert(v.length === 1 && v[0].code === 'quantity_above_max', `check: 3 reels against a 1-reel ask → quantity_above_max (got ${JSON.stringify(v)})`);
}
{
  const dance: Deliverable[] = [{ promo_type: 'dance_trend', quantity: 10, delivery_window_days: 14, min_seconds: 600 }];
  const v = checkPackageAgainstSpec(dance, DERIVED);
  assert(v.some((x) => x.code === 'type_not_allowed'), `check: a type the label never asked for → type_not_allowed (got ${JSON.stringify(v)})`);
}
{
  const longReel: Deliverable[] = [{ promo_type: 'reel', quantity: 1, delivery_window_days: 14, min_seconds: 600 }];
  const v = checkPackageAgainstSpec(longReel, DERIVED);
  assert(v.some((x) => x.code === 'seconds_above_max'), `check: a 600s reel does not exist on Instagram → seconds_above_max (got ${JSON.stringify(v)})`);
}
{
  const late: Deliverable[] = [{ promo_type: 'reel', quantity: 1, delivery_window_days: 30, min_seconds: 30 }];
  const v = checkPackageAgainstSpec(late, DERIVED);
  assert(v.some((x) => x.code === 'window_above_max'), `check: a longer delivery window than the label set → window_above_max (got ${JSON.stringify(v)})`);
}
assert(checkPackageAgainstSpec([], DERIVED)[0]?.code === 'empty_package', 'check: an empty package is not a deal');
assert(
  describeSpecViolations(checkPackageAgainstSpec([{ promo_type: 'dance_trend', quantity: 10, delivery_window_days: 14, min_seconds: 600 }], DERIVED))
    .includes('dance/trend'),
  'check: the violation reads in plain English with the human label',
);

// ── 3. evaluateTermTrade ESCALATES, it does not reprice ─────────────────────
//
// THE LIVE BAD CASE. Before this change the engine returned
//   accept $150, value_ratio 21.18, fair_price $3494
// and the acceptance email said "locked in for 10 600-second dance/trend
// videos within 2 weeks."

{
  const tenDance = applyTermsToDeliverables({ promo_type: 'dance_trend', quantity: 10, min_seconds: 600 }, CURRENT);
  assert(tenDance !== null, 'trade: the 10x600s package is still parseable (the plausibility bounds let it through)');
  const d = evaluateTermTrade({
    current_offer_usd: 165, counter_usd: 150, ceiling_usd: 200, rounds: 0,
    current_deliverables: CURRENT, proposed_deliverables: tenDance!, spec: DERIVED,
  });
  assert(d.action === 'escalate', `trade: 10 x 600s dance videos for $150 must NOT auto-accept (got ${JSON.stringify(d)})`);
  assert(d.action === 'escalate' && d.violations.length > 0, 'trade: the escalation names what was out of spec');
  assert(
    d.action === 'escalate' && !('agreed_amount_usd' in d) && !('new_offer_usd' in d),
    'trade: an escalation carries no price at all — it is not a cleverly-priced acceptance',
  );
}
{
  // The same package with no spec supplied keeps the old behaviour verbatim.
  // evaluateTermTrade cannot invent the label's intent; the negotiation path
  // always supplies one (see section 6).
  const tenDance = applyTermsToDeliverables({ promo_type: 'dance_trend', quantity: 10, min_seconds: 600 }, CURRENT)!;
  const d = evaluateTermTrade({
    current_offer_usd: 165, counter_usd: 150, ceiling_usd: 200, rounds: 0,
    current_deliverables: CURRENT, proposed_deliverables: tenDance,
  });
  assert(d.action === 'accept', 'trade: without a spec the pure evaluator is unchanged (the guard is the caller supplying one)');
}
{
  // 3 reels for the same money. Before: accept $165, value_ratio 2.29.
  const threeReels = applyTermsToDeliverables({ promo_type: 'reel', quantity: 3, min_seconds: 30 }, CURRENT)!;
  const d = evaluateTermTrade({
    current_offer_usd: 165, counter_usd: 165, ceiling_usd: 200, rounds: 0,
    current_deliverables: CURRENT, proposed_deliverables: threeReels, spec: DERIVED,
  });
  assert(d.action === 'escalate', `trade: 3 reels for the same money must NOT auto-accept (got ${JSON.stringify(d)})`);
}
{
  // MONEY GUARDS UNCHANGED. A reduction at the old price still counters at the
  // proportional number, and the ratchet still binds.
  const reelOnly: Deliverable[] = [{ promo_type: 'reel', quantity: 1, delivery_window_days: 14, min_seconds: 30 }];
  const d = evaluateTermTrade({
    current_offer_usd: 100, counter_usd: 100, ceiling_usd: 200, rounds: 1,
    current_deliverables: CURRENT, proposed_deliverables: reelOnly, spec: DERIVED,
  });
  assert(d.action === 'counter' && d.new_offer_usd === 76, `trade: in-spec reduction still reprices to $76 (got ${JSON.stringify(d)})`);

  const ratchet = evaluateTermTrade({
    current_offer_usd: 165, standing_offer_usd: 165, counter_usd: 240, ceiling_usd: 200, rounds: 1,
    current_deliverables: CURRENT, proposed_deliverables: reelOnly, spec: DERIVED,
  });
  assert(
    ratchet.action === 'counter' && ratchet.new_offer_usd === 165,
    `trade: the ratchet still holds on an in-spec reduction priced upward (got ${JSON.stringify(ratchet)})`,
  );
  const ceilinged = evaluateTermTrade({
    current_offer_usd: 100, counter_usd: 500, ceiling_usd: 200, rounds: 1,
    current_deliverables: CURRENT, proposed_deliverables: reelOnly, spec: DERIVED,
  });
  assert(
    ceilinged.action === 'counter' && ceilinged.new_offer_usd <= 200,
    `trade: the ceiling still clamps every in-spec counter (got ${JSON.stringify(ceilinged)})`,
  );
}
{
  // An escalation never hides a cap breach: an out-of-spec package that would
  // ALSO breach the ceiling escalates rather than countering at the ceiling.
  const three: Deliverable[] = [{ promo_type: 'reel', quantity: 3, delivery_window_days: 14, min_seconds: 30 }];
  const d = evaluateTermTrade({
    current_offer_usd: 100, counter_usd: 500, ceiling_usd: 200, rounds: 1,
    current_deliverables: CURRENT, proposed_deliverables: three, spec: DERIVED,
  });
  assert(d.action === 'escalate', 'trade: scope is judged before price — an out-of-spec over-ask escalates, it is not countered at the ceiling');
}

// ── 4. a label-set spec overrides the derived one ───────────────────────────

{
  const wide: DeliverableSpec = {
    source: 'campaign',
    max_delivery_window_days: 21,
    lines: [
      { promo_type: 'reel', min_quantity: 1, max_quantity: 3, min_seconds: 15, max_seconds: 60 },
      { promo_type: 'story', min_quantity: 1, max_quantity: 2, min_seconds: 5, max_seconds: 30 },
    ],
  };
  const three: Deliverable[] = [{ promo_type: 'reel', quantity: 3, delivery_window_days: 14, min_seconds: 30 }];
  assert(checkPackageAgainstSpec(three, wide).length === 0, 'spec: the label can widen the scope and 3 reels becomes in spec');
  const d = evaluateTermTrade({
    current_offer_usd: 165, counter_usd: 165, ceiling_usd: 200, rounds: 0,
    current_deliverables: CURRENT, proposed_deliverables: three, spec: wide,
  });
  assert(d.action === 'accept', 'spec: with the label\'s own wider spec the same trade is accepted on price alone');
  const tooLong: Deliverable[] = [{ promo_type: 'reel', quantity: 3, delivery_window_days: 14, min_seconds: 75 }];
  assert(checkPackageAgainstSpec(tooLong, wide).some((v) => v.code === 'seconds_above_max'), 'spec: the label\'s own length ceiling still binds');
}

// ── 5. spec resolution against the DB ───────────────────────────────────────

async function testSpecResolution() {
  // Nothing configured → derived from the standing package, never unbounded.
  const bare = makeStore();
  const derived = await resolveCampaignSpec(bare.sb, { campaignId: 'camp-1', standing: CURRENT });
  assert(derived.source === 'derived', 'resolve: no campaign rows → derived spec');
  assert(
    checkPackageAgainstSpec([{ promo_type: 'dance_trend', quantity: 10, delivery_window_days: 14, min_seconds: 600 }], derived).length > 0,
    'resolve: a campaign that never configured anything is still guarded',
  );

  // Campaign-parent promo_deliverables rows win.
  const configured = makeStore();
  configured.seed('promo_deliverables', {
    id: 'pd-1', firm_id: 'firm-1', campaign_id: 'camp-1', creator_offer_id: null,
    promo_type: 'reel', quantity: 2, delivery_window_days: 10, min_seconds: 20,
    min_quantity: 1, max_quantity: 4, max_seconds: 60, unit_price_usd: null,
  });
  const fromDb = await resolveCampaignSpec(configured.sb, { campaignId: 'camp-1', standing: CURRENT });
  assert(fromDb.source === 'campaign', 'resolve: campaign rows → campaign spec');
  assert(fromDb.lines.length === 1 && fromDb.lines[0].max_quantity === 4, `resolve: bounds come from the row (got ${JSON.stringify(fromDb.lines)})`);
  assert(fromDb.max_delivery_window_days === 10, 'resolve: the delivery window is the label\'s outside date');
  assert(
    checkPackageAgainstSpec([{ promo_type: 'story', quantity: 1, delivery_window_days: 10, min_seconds: 15 }], fromDb)
      .some((v) => v.code === 'type_not_allowed'),
    'resolve: a configured spec is exhaustive — a type with no row is not on offer',
  );

  // A row with null bounds falls back to the ask / the platform cap.
  const loose = makeStore();
  loose.seed('promo_deliverables', {
    id: 'pd-2', firm_id: 'firm-1', campaign_id: 'camp-2', creator_offer_id: null,
    promo_type: 'reel', quantity: 2, delivery_window_days: 14, min_seconds: null,
    min_quantity: null, max_quantity: null, max_seconds: null, unit_price_usd: null,
  });
  const l = await resolveCampaignSpec(loose.sb, { campaignId: 'camp-2', standing: CURRENT });
  assert(l.lines[0].max_quantity === 2, 'resolve: null max_quantity falls back to the quantity the label asked for');
  assert(l.lines[0].max_seconds === PROMO_MAX_SECONDS.reel, 'resolve: null max_seconds falls back to the platform cap');
  assert(l.lines[0].min_quantity === 1, 'resolve: null min_quantity falls back to 1');
}

// ── 6. An unrecognised promo_type never becomes a silent accept ────────────

assert(
  Array.isArray((NEGOTIATOR_OUTPUT_SCHEMA.properties.terms.properties.promo_type as unknown as { enum?: readonly unknown[] }).enum),
  'schema: promo_type is an enum, not a description (same treatment as intent and sentiment)',
);
{
  const e = (NEGOTIATOR_OUTPUT_SCHEMA.properties.terms.properties.promo_type as unknown as { enum: readonly unknown[] }).enum;
  assert(e.includes('reel') && e.includes('dance_trend') && e.includes(null), 'schema: the enum carries every promo type and null');
  assert(!e.includes('livestream'), 'schema: an unknown type is not in the enum');
}
assert(negotiatorTermsDiscardReason({ promo_type: 'livestream', quantity: 1 }) !== null, 'parse: an unknown promo_type is reported as a discard, not silence');
assert(negotiatorTermsDiscardReason({ promo_type: 'reel', quantity: 2 }) === null, 'parse: valid terms report no discard');
assert(negotiatorTermsDiscardReason(null) === null, 'parse: absent terms are not a discard');
assert(negotiatorTermsDiscardReason({ quantity: -1 }) !== null, 'parse: a negative quantity is a discard');
{
  const out = parseNegotiatorOutput({
    intent: 'counter', counter_usd: 150, sentiment: 'positive', confidence: 0.9,
    terms: { promo_type: 'livestream', quantity: 1, min_seconds: null, schedule_note: null },
  });
  assert(out !== null && out.terms === null, 'parse: the terms object is still discarded (unchanged)');
  assert(out !== null && typeof out.terms_discarded === 'string', 'parse: but the output now says WHY, so the caller can escalate');
}

// ── 7. tamper-evident freeze ────────────────────────────────────────────────

assert(checkFrozenDeliverables(null).ok, 'freeze: nothing frozen is not tampering');
assert(checkFrozenDeliverables([{ promo_type: 'reel', quantity: 1, delivery_window_days: 14, min_seconds: 30 }]).ok, 'freeze: a well-formed freeze passes');
assert(!checkFrozenDeliverables([]).ok, 'freeze: an empty array is a corrupted freeze, not "no package"');
assert(!checkFrozenDeliverables({ promo_type: 'reel' }).ok, 'freeze: a non-array freeze is corruption');
assert(!checkFrozenDeliverables([{ promo_type: 'livestream', quantity: 1 }]).ok, 'freeze: an unrecognised line is corruption, not a line to silently drop');
assert(
  !checkFrozenDeliverables([
    { promo_type: 'reel', quantity: 1, delivery_window_days: 14 },
    { promo_type: 'nonsense', quantity: 1, delivery_window_days: 14 },
  ]).ok,
  'freeze: a partially-readable freeze is corruption — today it quietly became "1 reel"',
);
{
  const bad = checkFrozenDeliverables([]);
  assert(!bad.ok && typeof bad.reason === 'string', 'freeze: corruption comes with a reason to log');
}

// ── 8. end to end: the loop escalates instead of agreeing ───────────────────

const modelMap = new Map<string, string>();
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
  return bestKey ? bestOut : '{"intent":"unclear","counter_usd":null,"sentiment":"neutral","confidence":0.9}';
});

function seedOffer(store: ReturnType<typeof makeStore>, id: string, ci: string): Row {
  return store.seed('creator_offers', {
    id,
    campaign_influencer_id: ci,
    campaign_id: 'camp-e2e',
    firm_id: 'firm-1',
    status: 'offered',
    initial_offer_usd: 165,
    current_offer_usd: 165,
    agreed_amount_usd: null,
    ceiling_usd: 200,
    rounds: 0,
    last_message_id: null,
    approved_at: null,
    approved_by_user_id: null,
    paid_at: null,
    posted_at: null,
    post_url: null,
    autonomy_mode: 'auto',
    opening_pct: null,
    injection_flagged: false,
    agreed_deliverables: null,
    created_at: '2026-09-17T00:00:00.000Z',
    updated_at: '2026-09-17T00:00:00.000Z',
  });
}

async function testLoopEscalates() {
  const DANCE_REPLY = 'Happy to do ten 600 second dance videos for $150 total.';
  modelMap.set(
    DANCE_REPLY,
    JSON.stringify({
      intent: 'counter', counter_usd: 150, sentiment: 'positive', confidence: 0.95,
      terms: { promo_type: 'dance_trend', quantity: 10, min_seconds: 600, schedule_note: null },
    }),
  );
  const store = makeStore();
  store.seedCampaign('camp-e2e', null);
  const offer = seedOffer(store, 'offer-e2e', 'ci-e2e') as unknown as CreatorOfferRow;

  const res = await autoNegotiateInbound(store.sb, offer, {
    inbound_text: DANCE_REPLY,
    inbound_message_id: 'inb-e2e',
  });
  assert(res.outcome === 'needs_human', `loop: the live bad case is escalated, not agreed (got ${res.outcome}: ${res.reason})`);
  const after = store.getOffer('offer-e2e');
  assert(after?.status === 'offered', `loop: an escalation never advances the state machine (got ${after?.status})`);
  assert(after?.agreed_amount_usd == null, 'loop: nothing was agreed');
  assert(Number(after?.rounds) === 0, 'loop: an escalation does not burn a negotiation round');
  assert(after?.agreed_deliverables == null, 'loop: the out-of-spec package was never frozen onto the deal');
  assert(res.escalation?.kind === 'out_of_spec', `loop: the escalation is labelled out_of_spec (got ${JSON.stringify(res.escalation)})`);
  assert((res.escalation?.violations ?? []).length > 0, 'loop: the escalation carries the violations a human needs to judge it');
}

async function testUnknownTypeEscalates() {
  const LIVE_REPLY = 'I can do a livestream shoutout instead, $150 works.';
  modelMap.set(
    LIVE_REPLY,
    JSON.stringify({
      intent: 'counter', counter_usd: 150, sentiment: 'positive', confidence: 0.95,
      terms: { promo_type: 'livestream', quantity: 1, min_seconds: null, schedule_note: null },
    }),
  );
  const store = makeStore();
  store.seedCampaign('camp-e2e', null);
  const offer = seedOffer(store, 'offer-live', 'ci-live') as unknown as CreatorOfferRow;

  const res = await autoNegotiateInbound(store.sb, offer, {
    inbound_text: LIVE_REPLY,
    inbound_message_id: 'inb-live',
  });
  assert(res.outcome === 'needs_human', `loop(#66): an unrecognised term escalates instead of a price-only accept (got ${res.outcome}: ${res.reason})`);
  const after = store.getOffer('offer-live');
  assert(after?.agreed_amount_usd == null, 'loop(#66): the creator is NOT silently sold a reel and a story');
  assert(res.escalation?.kind === 'terms_discarded', `loop(#66): the discard is surfaced, not swallowed (got ${JSON.stringify(res.escalation)})`);
  assert(res.negotiator?.terms_discarded != null, 'loop(#66): the parse reports why the terms were dropped');
}

async function testQuestionIsVisible() {
  const Q = 'Sounds good, when do you need it?';
  modelMap.set(Q, JSON.stringify({ intent: 'question', counter_usd: null, sentiment: 'positive', confidence: 0.95 }));
  const store = makeStore();
  store.seedCampaign('camp-e2e', null);
  const offer = seedOffer(store, 'offer-q', 'ci-q') as unknown as CreatorOfferRow;

  const res = await autoNegotiateInbound(store.sb, offer, { inbound_text: Q, inbound_message_id: 'inb-q' });
  assert(res.outcome === 'needs_human', `loop: the most common friendly reply is surfaced, not silently dead (got ${res.outcome})`);
  assert(res.escalation?.kind === 'question_unanswered', `loop: the question is labelled for a human (got ${JSON.stringify(res.escalation)})`);
  assert(store.getOffer('offer-q')?.injection_flagged !== true, 'loop: a benign question is NOT labelled a prompt-injection attempt');
}

async function testInSpecStillNegotiates() {
  const REPLY = 'I can just do the one reel, $100.';
  modelMap.set(
    REPLY,
    JSON.stringify({
      intent: 'counter', counter_usd: 100, sentiment: 'positive', confidence: 0.95,
      terms: { promo_type: 'reel', quantity: 1, min_seconds: 30, schedule_note: null },
    }),
  );
  const store = makeStore();
  store.seedCampaign('camp-e2e', null);
  const offer = seedOffer(store, 'offer-ok', 'ci-ok') as unknown as CreatorOfferRow;

  const res = await autoNegotiateInbound(store.sb, offer, { inbound_text: REPLY, inbound_message_id: 'inb-ok' });
  assert(
    // 'accepted_paid' is gone from AutoOutcome: every agreement now
    // parks at the human approval gate, so the in-spec path is approval-or-counter.
    res.outcome === 'accepted_pending_approval' || res.outcome === 'countered',
    `loop: an IN-SPEC term trade still negotiates normally (got ${res.outcome}: ${res.reason})`,
  );
  assert(res.outcome !== 'needs_human', 'loop: the guard does not escalate the ordinary narrowing reply');
}

async function main() {
  const origWarn = console.warn;
  if (!process.env.DEBUG) console.warn = () => {};

  await testSpecResolution();
  await testLoopEscalates();
  await testUnknownTypeEscalates();
  await testQuestionIsVisible();
  await testInSpecStillNegotiates();

  console.warn = origWarn;

  console.log(`deal-scope test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
