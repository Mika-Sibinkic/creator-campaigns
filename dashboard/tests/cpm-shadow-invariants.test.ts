import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode
//
// tests/cpm-shadow-invariants.test.ts
//
// The invariants CPM slices S1 + S4 must not touch:
//
//   1. the human approval gate (agreed → human_approval_required, unconditional);
//   2. computeEffectiveCeiling — min(per-creator ceiling, remaining budget);
//   3. accept only at the recorded sent price (lastSentOffer + the accept gate).
//
// Two kinds of proof:
//
//   SOURCE PINS — the exact text of each guard, hashed.
//   A shadow slice has no business editing any of them, so ANY edit fails here.
//   A later slice that changes one on purpose (S2 lowers the ceiling by CPM)
//   updates the pin in the same commit — that is
//   the point: the change has to be deliberate and visible in review.
//
//   BEHAVIOUR — the same guards produce the same numbers whether or not the
//   shadow data (pricing_basis, first_ask_usd, campaign CPM targets) exists, and
//   none of the decision functions so much as names a shadow field.
//
// Hermetic. Run: npx tsx tests/cpm-shadow-invariants.test.ts
// Print current hashes: CPM_SHADOW_PRINT_PINS=1 npx tsx tests/cpm-shadow-invariants.test.ts

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeEffectiveCeiling, canTransition, type CreatorOfferRow } from '../src/lib/negotiation';
import { lastSentOffer, COUNTER_OFFER_COLUMN } from '../src/lib/last-sent-offer';
import { makeStore } from './negotiation-harness/store';

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

const SRC = join(__dirname, '..', 'src', 'lib');
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

/** A top-level declaration: from its signature to the first column-0 closing brace. */
function topLevel(file: string, signature: string): string {
  const src = read(file);
  const start = src.indexOf(signature);
  if (start < 0) return `<<missing: ${signature}>>`;
  const end = src.indexOf('\n}', start);
  return src.slice(start, end + 2);
}

/** A region between two literal markers (inclusive of both). */
function region(file: string, from: string, to: string): string {
  const src = read(file);
  const a = src.indexOf(from);
  if (a < 0) return `<<missing: ${from}>>`;
  const b = src.indexOf(to, a);
  if (b < 0) return `<<missing: ${to}>>`;
  return src.slice(a, b + to.length);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const GUARDS: Array<{ name: string; text: () => string; pin: string }> = [
  {
    name: 'state graph (VALID_TRANSITIONS: agreed may only reach human_approval_required)',
    text: () => region('negotiation.ts', 'const VALID_TRANSITIONS', '\n};'),
    pin: 'c4681caa48614b5c',
  },
  {
    name: 'unconditional human gate in finalizeAgreement',
    text: () =>
      region(
        'negotiation.ts',
        '// UNCONDITIONAL human gate',
        "const row = await applyTransition(sb, offer.id, 'human_approval_required', {});",
      ),
    pin: 'ef85d3594c6f3dee',
  },
  {
    name: 'computeEffectiveCeiling',
    text: () => topLevel('negotiation.ts', 'export async function computeEffectiveCeiling('),
    pin: '028e230f95abc2a7',
  },
  {
    name: 'accept gate: an acceptance is priced only at the last price sent',
    text: () => region('negotiation.ts', "if (neg.intent === 'accept') {", 'acceptAtUsd = lastSentUsd;'),
    pin: '0a185cf9202bfa87',
  },
  {
    name: 'lastSentOffer',
    text: () => topLevel('last-sent-offer.ts', 'export function lastSentOffer('),
    pin: '82ad86e0220439c8',
  },
];

const SHADOW_FIELDS = ['pricing_basis', 'first_ask_usd', 'target_cpm_usd', 'max_cpm_usd', 'pricing_mode', 'deal_cpm_records', 'cpm-pricing', 'expected-views'];

async function main() {
  if (process.env.CPM_SHADOW_PRINT_PINS) {
    for (const g of GUARDS) console.log(`${g.name}: ${sha(g.text())}`);
    process.exit(0);
  }

  // ── Source pins ──────────────────────────────────────────────────────────
  for (const g of GUARDS) {
    const text = g.text();
    assert(!text.startsWith('<<missing'), `${g.name} :: still present (${text.slice(0, 80)})`);
    assert(sha(text) === g.pin, `${g.name} :: untouched (pin ${g.pin}, now ${sha(text)})`);
  }

  // ── No decision function reads shadow data ───────────────────────────────
  const decisionBodies: Array<[string, string]> = [
    ['computeEffectiveCeiling', topLevel('negotiation.ts', 'export async function computeEffectiveCeiling(')],
    ['lastSentOffer', topLevel('last-sent-offer.ts', 'export function lastSentOffer(')],
    ['calculateInitialOffer', topLevel('pricing-engine.ts', 'export function calculateInitialOffer(')],
    ['evaluateCounter', topLevel('pricing-engine.ts', 'export function evaluateCounter(')],
    ['evaluateTermTrade', topLevel('pricing-engine.ts', 'export function evaluateTermTrade(')],
    ['finalizeAgreement', topLevel('negotiation.ts', 'async function finalizeAgreement(')],
  ];
  for (const [name, body] of decisionBodies) {
    const hit = SHADOW_FIELDS.find((f) => body.includes(f));
    assert(!hit, `${name} does not read shadow pricing data (found ${hit})`);
  }
  // The pricing engine and the negotiation-tick send path never import the CPM modules.
  for (const f of ['pricing-engine.ts', 'negotiation-tick.ts', 'last-sent-offer.ts', 'stated-price.ts', 'spend-caps.ts']) {
    const src = read(f);
    assert(!/cpm-pricing|expected-views|cpm-shadow/.test(src), `${f} does not import the shadow CPM modules`);
  }

  // ── Human gate, behaviourally ────────────────────────────────────────────
  assert(!canTransition('agreed', 'approved'), 'agreed cannot skip to approved');
  assert(!canTransition('agreed', 'paid'), 'agreed cannot skip to paid');
  assert(canTransition('agreed', 'human_approval_required'), 'agreed → human_approval_required is the path');

  // ── computeEffectiveCeiling: identical with and without shadow data ──────
  const offer = (extra: Record<string, unknown>) =>
    ({
      id: 'o-1',
      campaign_influencer_id: 'ci-1',
      campaign_id: 'camp-1',
      firm_id: 'firm-1',
      status: 'offered',
      initial_offer_usd: 150,
      current_offer_usd: 150,
      agreed_amount_usd: null,
      ceiling_usd: 200,
      rounds: 1,
      ...extra,
    }) as unknown as CreatorOfferRow;
  for (const budget of [1_000, 260, 120, 0]) {
    const plain = makeStore();
    plain.seedCampaign('camp-1', budget || null);
    if (budget === 0) (plain.all('campaigns')[0] as Record<string, unknown>).total_budget_usd = null;
    plain.seedOffer({ id: 'sib', campaign_id: 'camp-1', status: 'paid', agreed_amount_usd: 100, current_offer_usd: 100 });
    const shadow = makeStore();
    shadow.seedCampaign('camp-1', budget || null);
    const c = shadow.all('campaigns')[0] as Record<string, unknown>;
    if (budget === 0) c.total_budget_usd = null;
    c.target_cpm_usd = 1; // absurdly low: would cut the ceiling if anything read it
    c.max_cpm_usd = 2;
    shadow.seedOffer({ id: 'sib', campaign_id: 'camp-1', status: 'paid', agreed_amount_usd: 100, current_offer_usd: 100 });
    const a = await computeEffectiveCeiling(plain.sb, offer({}));
    const b = await computeEffectiveCeiling(
      shadow.sb,
      offer({ pricing_basis: { method: 'cpm', price: 5, walkaway: 6, applied: false }, first_ask_usd: 9_999 }),
    );
    assert(JSON.stringify(a) === JSON.stringify(b), `computeEffectiveCeiling(budget=${budget}) is identical with shadow data present`);
  }

  // ── Accept only at the recorded sent price ───────────────────────────────
  const sent = (usd: number | null, at: string) => ({
    message_type: 'counter',
    status: 'sent',
    sent_at: at,
    body: usd == null ? 'no price' : `I can do $${usd}`,
    [COUNTER_OFFER_COLUMN]: usd,
    first_ask_usd: 9_999,
    pricing_basis: { price: 1 },
  });
  assert(
    lastSentOffer([sent(150, '2026-07-06T00:00:00Z'), sent(175, '2026-07-06T02:00:00Z')]).usd === 175,
    'lastSentOffer is the last recorded sent price, whatever shadow fields ride along',
  );
  assert(lastSentOffer([sent(null, '2026-07-06T00:00:00Z')]).usd === null, 'an unrecorded sent price is unknown, never a shadow number');

  console.log(`cpm-shadow-invariants: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
