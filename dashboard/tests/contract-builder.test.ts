// tests/contract-builder.test.ts
//
// Hermetic tests for the guided contract builder (src/lib/contract-builder.ts,
// src/lib/contract-builder-options.ts). No network, no DB, no real model: the
// apply path runs against the in-memory Supabase double, the polish against
// the documented registerProvider() mock seam.
//
// What is pinned:
//   1. answers → template: every chosen clause appears, every deal merge field
//      the deal flow fills is present, nothing unknown, deterministic.
//   2. the payment clause says what split settlement actually does
//      (resolveSettlementPolicy / settlementLegs / the 'posted' balance gate).
//   3. apply saves AND approves, only for the session's firm, only text that
//      derives from the answers, and the very next closed deal attaches it.
//   4. the model polish is reworded-only, its change list is surfaced, and
//      any material change falls back to the deterministic text.
//
// Run: npx tsx tests/contract-builder.test.ts

process.env.MODEL_PROVIDER = 'mock';
process.env.MODEL_FALLBACK_CHAIN = '';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerProvider } from '../src/lib/model-provider';
import {
  GUIDED_REQUIRED_FIELDS,
  applyGuidedTemplate,
  assembleGuidedTemplate,
  checkPolishAgainstBase,
  defaultAnswers,
  guidedTemplateProblems,
  paymentFromPolicy,
  paymentMatchesPolicy,
  polishGuidedTemplate,
  validateAnswers,
  type BuilderAnswers,
  type ValidatedAnswers,
} from '../src/lib/contract-builder';
import {
  KNOWN_PLACEHOLDERS,
  buildContractVars,
  detectPlaceholders,
  fillTemplate,
  generateOfferContract,
  looksLikeDraftHeader,
} from '../src/lib/contracts';
import { REQUIRED_SECTIONS, extractSectionHeadings } from '../src/lib/contract-generator';
import { resolveSettlementPolicy, settlementLegs } from '../src/lib/split-settlement';
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

let mockHandler: (user: string) => string | Promise<string> = () => {
  throw new Error('mock model not configured for this test');
};
let mockCalls = 0;
registerProvider('mock', async ({ user }) => {
  mockCalls++;
  return String(await mockHandler(user));
});

const SPLIT_50 = { splitEnabled: true, depositPct: 50 };
const NO_SPLIT = { splitEnabled: false, depositPct: 50 };

function build(mut: (a: BuilderAnswers) => void = () => {}, policy = NO_SPLIT): {
  answers: ValidatedAnswers;
  raw: BuilderAnswers;
  text: string;
} {
  const raw = defaultAnswers('Example Records LLC', policy);
  mut(raw);
  const v = validateAnswers(JSON.parse(JSON.stringify(raw)));
  if (!v.ok) throw new Error(`answers invalid: ${JSON.stringify(v.errors)}`);
  return { answers: v.answers, raw, text: assembleGuidedTemplate(v.answers) };
}

/** The text of one numbered section, by heading. */
function section(text: string, heading: string): string {
  const re = new RegExp(`^\\d+\\. ${heading.replace(/[()]/g, '\\$&')}\\. (.*)$`, 'm');
  return text.match(re)?.[1] ?? '';
}

// ── 1. Answers → template ───────────────────────────────────────────────────

function testDefaultsProduceASendableTemplate() {
  const { text } = build();
  assert(guidedTemplateProblems(text).length === 0, `defaults: no problems (${guidedTemplateProblems(text).join(', ')})`);
  const found = detectPlaceholders(text);
  for (const f of GUIDED_REQUIRED_FIELDS) assert(found.includes(f), `defaults: carries {{${f}}}`);
  const known = new Set<string>(KNOWN_PLACEHOLDERS);
  assert(found.every((p) => known.has(p)), 'defaults: every placeholder is one the deal fill knows');
  assert(!found.includes('governing_law'), 'defaults: governing law substituted, not left as a slot');
  assert(text.includes('governed by the laws of the State of Delaware'), 'defaults: governing law reads naturally');
  assert(!found.includes('firm_name') && text.includes('between Example Records LLC'), 'defaults: legal name substituted');
  assert(!looksLikeDraftHeader(text), 'defaults: no DRAFT header (the approve guard would refuse it)');
  assert(!text.includes('—'), 'defaults: no em dashes');
  assert(build().text === text, 'defaults: deterministic, same answers give the same bytes');

  // Every section the generic generator treats as load-bearing is present,
  // with its protective wording.
  const heads = extractSectionHeadings(text);
  for (const s of REQUIRED_SECTIONS) {
    assert(heads.includes(s.heading), `defaults: has section ${s.heading}`);
    if (s.must) assert(s.must.re.test(text), `defaults: ${s.heading} keeps the ${s.must.what}`);
  }

  // Deal-time fill: the template fills completely from ordinary deal facts.
  const filled = fillTemplate(
    text,
    buildContractVars({
      creatorName: 'Marlo Example',
      creatorHandle: '@marlo_example',
      agreedUsd: 120,
      deliverablesText: '1 TikTok video',
      scheduleText: 'within 14 days of receiving the promotional materials',
      paymentMethod: 'Stripe payout',
      artistName: 'Alex Owner',
      campaignName: '"Wildfire" by Alex Owner',
      nowMs: Date.parse('2026-10-01T12:00:00Z'),
      firmName: 'Example Records',
    }),
  );
  assert(filled.unknown.length === 0, `deal fill: nothing left unfilled (${filled.unknown.join(', ')})`);
  assert(filled.text.includes('pay the Creator $120'), 'deal fill: amount lands in the payment clause');
}

function testNoLegalNameLeavesFirmSlot() {
  const { text } = build((a) => {
    a.parties.legalName = '';
  });
  assert(detectPlaceholders(text).includes('firm_name'), 'no legal name: {{firm_name}} stays for the deal fill from firms.name');
  assert(guidedTemplateProblems(text).length === 0, 'no legal name: still sendable');
}

function testEachChosenClauseAppears() {
  const t = build((a) => {
    a.parties.address = '100 Main Street, Austin, TX';
    a.parties.signerName = 'Alex Owner';
    a.parties.signerTitle = 'Owner';
    a.deliverables.platforms = ['tiktok', 'instagram'];
    a.deliverables.postTypes = ['short_video', 'story'];
    a.deliverables.minCount = 2;
    a.deliverables.minLengthSec = 30;
    a.deliverables.includeLink = true;
    a.timing.deadlineDays = 14;
    a.timing.minLiveDays = 180;
    a.timing.revisionRounds = 2;
    a.payment.payWithinDays = 3;
    a.rights.usageMonths = 24;
    a.rights.paidAds = true;
    a.rights.whitelisting = true;
    a.rights.exclusivityDays = 30;
    a.rights.exclusivityCategory = 'any_music';
    a.performance.guarantee = true;
    a.performance.minViews = 10000;
    a.performance.measureAfterDays = 7;
    a.termination.killFeePct = 50;
    a.termination.venue = 'arbitration';
    a.acceptance.method = 'reply_or_conduct';
  }).text;

  assert(t.includes(', of 100 Main Street, Austin, TX, (the "Label")'), 'parties: address in the preamble');
  assert(t.includes('By: Alex Owner, Owner'), 'parties: signer name and title in the signature block');
  const del = section(t, 'DELIVERABLES');
  assert(del.includes('TikTok or Instagram'), 'deliverables: platforms');
  assert(del.includes('short-form video or story'), 'deliverables: post types');
  assert(del.includes('at least two (2) separate posts'), 'deliverables: count');
  assert(del.includes('at least thirty (30) seconds long'), 'deliverables: minimum length');
  assert(del.includes('use the Track as its sound'), 'deliverables: must use the sound');
  assert(del.includes('link to the Track'), 'deliverables: must include the link');
  assert(del.includes('campaign hashtag'), 'deliverables: must include the hashtag');
  assert(/paid-promotion disclosure required by Section \d+/.test(del), 'deliverables: #ad disclosure cross-referenced');
  const sched = section(t, 'SCHEDULE');
  assert(sched.includes('{{schedule}}, and in any case no later than fourteen (14) days after accepting'), 'timing: deadline cap after acceptance');
  assert(sched.includes('up to two (2) rounds of changes'), 'timing: revision rounds');
  const rights = section(t, 'CONTENT RIGHTS AND USAGE WINDOW');
  assert(rights.includes('one hundred eighty (180) days'), 'timing: minimum time live');
  assert(rights.includes('twenty-four (24) months'), 'rights: usage duration');
  assert(rights.includes('paid advertising it runs from its own accounts'), 'rights: paid-ads scope');
  assert(rights.includes('Spark Ads'), 'rights: whitelisting / Spark Ads');
  assert(section(t, 'EXCLUSIVITY').includes('thirty (30) days') && section(t, 'EXCLUSIVITY').includes('any other music release'), 'rights: exclusivity window and category');
  const conduct = section(t, 'CONDUCT AND BRAND SAFETY');
  assert(conduct.includes('bots, purchased views'), 'compliance: no bots / purchased engagement');
  assert(conduct.includes('disrepute'), 'compliance: morality / brand-safety clause');
  assert(conduct.includes('forty-eight (48) hours of a written request'), 'compliance: takedown on request');
  assert(section(t, 'DISCLOSURE (FTC)').includes('FTC Endorsement Guides'), 'compliance: FTC disclosure always present');
  const perf = section(t, 'PERFORMANCE');
  assert(perf.includes('fewer than 10,000 views') && perf.includes('seven (7) days after'), 'performance: minimum views and window');
  assert(section(t, 'TERMINATION').includes('keeps 50 percent (50%)'), 'termination: kill fee');
  assert(section(t, 'GOVERNING LAW AND VENUE').includes('binding arbitration'), 'disputes: arbitration venue');
  assert(section(t, 'ACCEPTANCE').includes('replying "I agree"'), 'signature: accept by reply');
  assert(section(t, 'PAYMENT AND TIMING').includes('within three (3) days'), 'payment: timing');
  assert(guidedTemplateProblems(t).length === 0, 'all options on: still sendable');
}

function testOffChoicesSayTheOpposite() {
  const t = build((a) => {
    a.rights.usageMonths = 0;
    a.rights.whitelisting = false;
    a.compliance = { noBots: false, brandSafety: false, takedown: false };
    a.performance.guarantee = false;
    a.termination.venue = 'small_claims';
    a.acceptance.method = 'conduct';
    a.deliverables.minLengthSec = 0;
  }).text;
  const heads = extractSectionHeadings(t);
  assert(!heads.includes('CONDUCT AND BRAND SAFETY'), 'compliance off: no conduct section');
  assert(!heads.includes('EXCLUSIVITY'), 'exclusivity none: no exclusivity section');
  assert(section(t, 'PERFORMANCE').includes('Views are not guaranteed'), 'performance default: no guarantee');
  assert(section(t, 'CONTENT RIGHTS AND USAGE WINDOW').includes('no right to repost'), 'usage none: no reuse right');
  assert(section(t, 'CONTENT RIGHTS AND USAGE WINDOW').includes('will not run ads from the Creator'), 'whitelisting off: said explicitly');
  assert(section(t, 'GOVERNING LAW AND VENUE').includes('small-claims court'), 'disputes: small claims');
  assert(!section(t, 'ACCEPTANCE').includes('I agree'), 'signature: conduct only');
  assert(!section(t, 'DELIVERABLES').includes('seconds long'), 'length none: no minimum length sentence');
  // Cross-references follow the renumbering.
  const payN = t.match(/^(\d+)\. PAYMENT AND TIMING\./m)?.[1];
  const termN = t.match(/^(\d+)\. TERMINATION\./m)?.[1];
  assert(section(t, 'TERMINATION').includes(`repaid under Section ${payN}`), 'renumbering: termination points at payment');
  assert(section(t, 'ACCEPTANCE').includes(`payment described in Section ${payN}`), 'renumbering: acceptance points at payment');
  assert(Number(termN) === heads.indexOf('TERMINATION') + 1, 'renumbering: sections are numbered in order');
  const nums = extractSectionHeadings(t).length;
  assert(nums === 10, `compliance and exclusivity off: ten sections (${nums})`);
}

function testValidationRejects() {
  const bad = (mut: (a: Record<string, Record<string, unknown>>) => void, key: string, msg: string) => {
    const a = JSON.parse(JSON.stringify(defaultAnswers('X'))) as Record<string, Record<string, unknown>>;
    mut(a);
    const v = validateAnswers(a);
    assert(!v.ok && key in v.errors, msg);
  };
  bad((a) => { a.deliverables.platforms = []; }, 'deliverables', 'validate: no platform rejected');
  bad((a) => { a.deliverables.minLengthSec = 45; }, 'deliverables', 'validate: an option the UI never offered is rejected');
  bad((a) => { a.timing.minLiveDays = 1; }, 'timing', 'validate: off-list minimum live period rejected');
  bad((a) => { a.payment.structure = 'deposit_balance'; a.payment.depositPct = 0; }, 'payment', 'validate: 0% deposit rejected');
  bad((a) => { a.payment.structure = 'deposit_balance'; a.payment.depositPct = 100; }, 'payment', 'validate: 100% deposit rejected');
  bad((a) => { a.payment.structure = 'full_on_delivery'; }, 'payment', 'validate: full-on-delivery (not payable today) rejected');
  bad((a) => { a.termination.governingLaw = 'Texas law'; }, 'termination', 'validate: "Texas law" rejected by normalizeJurisdiction');
  bad((a) => { a.termination.venue = 'mars'; }, 'termination', 'validate: unknown venue rejected');
  bad((a) => { a.acceptance.method = 'docusign'; }, 'acceptance', 'validate: unknown acceptance method rejected');

  // Free text cannot mint a merge field.
  const { text } = build((a) => {
    a.parties.legalName = 'Evil {{amount_usd}} Records';
    a.parties.address = '{{governing_law}} Street';
  });
  assert(text.includes('Evil amount_usd Records'), 'free text: braces stripped from legal name');
  assert(detectPlaceholders(text).filter((p) => p === 'amount_usd').length === 1, 'free text: no extra slot minted');
  assert(guidedTemplateProblems(text).length === 0, 'free text: still sendable');
}

// ── 2. Payment vs split settlement ─────────────────────────────────────────

function testPaymentMatchesSplitSettlement() {
  // A split-on firm at 30% deposit.
  const firmRow = { require_delivery_before_balance: true, deposit_pct: 30 };
  const policy = resolveSettlementPolicy(firmRow);
  const pre = paymentFromPolicy(policy);
  assert(pre.structure === 'deposit_balance' && pre.depositPct === 30, 'policy → default answer: deposit 30%');
  const { text } = build((a) => {
    a.payment.structure = 'deposit_balance';
    a.payment.depositPct = 30;
  }, policy);
  const pay = section(text, 'PAYMENT AND TIMING');
  const legs = settlementLegs(100, policy);
  assert(legs.depositUsd === 30 && legs.balanceUsd === 70, 'settlementLegs: 30/70 on $100');
  assert(pay.includes(`Deposit: ${legs.depositUsd} percent (${legs.depositUsd}%)`), 'contract deposit % equals the engine deposit leg');
  assert(pay.includes(`remaining ${legs.balanceUsd} percent (${legs.balanceUsd}%)`), 'contract balance % equals the engine balance leg');
  assert(/Deposit:.*after the Label approves the deal/.test(pay), 'deposit is paid on approval (deposit leg mints from human_approval_required)');
  assert(/Balance:.*after the Label verifies that the deliverables/.test(pay), "balance is paid after verification (balance leg mints only from 'posted')");
  assert(/Balance is not owed for deliverables that are not published/.test(pay), 'non-delivery: balance never paid (expiry closes the deal undelivered)');
  assert(/\brepay\b/.test(pay), 'payment keeps a repayment remedy');

  assert(paymentMatchesPolicy({ structure: 'deposit_balance', depositPct: 30 }, policy).ok, 'match: 30% split firm, 30% clause');
  assert(!paymentMatchesPolicy({ structure: 'deposit_balance', depositPct: 50 }, policy).ok, 'mismatch: 30% split firm, 50% clause');
  assert(!paymentMatchesPolicy({ structure: 'full_on_approval', depositPct: 50 }, policy).ok, 'mismatch: split firm, full-on-approval clause');

  const off = resolveSettlementPolicy({ require_delivery_before_balance: false, deposit_pct: 50 });
  assert(paymentMatchesPolicy({ structure: 'full_on_approval', depositPct: 50 }, off).ok, 'match: split off, full on approval');
  assert(!paymentMatchesPolicy({ structure: 'deposit_balance', depositPct: 50 }, off).ok, 'mismatch: split off, deposit clause');
  assert(settlementLegs(100, off).depositUsd === 100, 'split off pays everything as one leg on approval');
  const full = section(build().text, 'PAYMENT AND TIMING');
  assert(full.includes('issued in advance of publication') && full.includes('after the Label approves the deal'), 'full clause: paid on approval, before publication');

  const hundred = resolveSettlementPolicy({ require_delivery_before_balance: true, deposit_pct: 100 });
  assert(paymentMatchesPolicy({ structure: 'full_on_approval', depositPct: 50 }, hundred).ok, '100% deposit is full on approval in practice');
  const zero = resolveSettlementPolicy({ require_delivery_before_balance: true, deposit_pct: 0 });
  assert(
    !paymentMatchesPolicy({ structure: 'full_on_approval', depositPct: 50 }, zero).ok &&
      !paymentMatchesPolicy({ structure: 'deposit_balance', depositPct: 1 }, zero).ok,
    '0% deposit split: no clause matches (the engine cannot pay it)',
  );
}

// ── 3. Apply: save + approve, firm-scoped ──────────────────────────────────

async function testApplySavesApprovesFirmScoped() {
  const store = makeStore();
  store.seed('firms', { id: 'firm-a', name: 'Example Records', require_delivery_before_balance: true, deposit_pct: 50 });
  store.seed('firms', { id: 'firm-b', name: 'Other Label', require_delivery_before_balance: false, deposit_pct: 50 });
  store.seed('contract_templates', { id: 'tpl-b', firm_id: 'firm-b', body_text: 'B terms', approved_at: '2026-09-01T00:00:00Z', approved_by: 'user:b' });
  store.seed('contract_templates', { id: 'tpl-a', firm_id: 'firm-a', body_text: 'SAMPLE AGREEMENT, REPLACE', approved_at: null, approved_by: null });

  const { raw, text } = build(() => {}, SPLIT_50);
  const NOW = '2026-10-01T15:00:00.000Z';

  const noFirm = await applyGuidedTemplate(store.sb, { firmId: '', rawAnswers: raw, bodyText: text, approvedBy: 'user:x', nowIso: NOW });
  assert(!noFirm.ok && noFirm.status === 403, 'apply: unprovisioned session (no firm) refused');

  const tampered = text.replace('within seven (7) days after the Label approves', 'within 90 days after the Label approves');
  const t1 = await applyGuidedTemplate(store.sb, { firmId: 'firm-a', rawAnswers: raw, bodyText: tampered, approvedBy: 'user:a', nowIso: NOW });
  assert(!t1.ok && t1.code === 'body_mismatch', 'apply: text that changed a number vs the answers is refused');
  const arbitrary = await applyGuidedTemplate(store.sb, { firmId: 'firm-a', rawAnswers: raw, bodyText: 'I owe you nothing.', approvedBy: 'user:a', nowIso: NOW });
  assert(!arbitrary.ok && arbitrary.code === 'body_mismatch', 'apply: arbitrary text cannot be approved through this path');

  const wrongPay = build((a) => { a.payment.structure = 'full_on_approval'; }, SPLIT_50);
  const t2 = await applyGuidedTemplate(store.sb, { firmId: 'firm-a', rawAnswers: wrongPay.raw, bodyText: wrongPay.text, approvedBy: 'user:a', nowIso: NOW });
  assert(!t2.ok && t2.status === 409 && t2.code === 'payment_mismatch', 'apply: payment clause disagreeing with the firm split is refused');
  const aRowBefore = store.all('contract_templates').find((r) => r.firm_id === 'firm-a');
  assert(aRowBefore?.body_text === 'SAMPLE AGREEMENT, REPLACE' && aRowBefore.approved_at === null, 'apply: refusals write nothing');

  const ok = await applyGuidedTemplate(store.sb, { firmId: 'firm-a', rawAnswers: raw, bodyText: text, approvedBy: 'user:operator@example.com', nowIso: NOW });
  assert(ok.ok, `apply: deterministic text for the right firm succeeds (${ok.ok ? '' : ok.code})`);
  const rows = store.all('contract_templates');
  const a = rows.filter((r) => r.firm_id === 'firm-a');
  const b = rows.find((r) => r.firm_id === 'firm-b');
  assert(a.length === 1, 'apply: one template per firm (upsert on firm_id, the sample is replaced)');
  assert(a[0].body_text === text, 'apply: saved exactly the previewed text');
  assert(a[0].approved_at === NOW && a[0].approved_by === 'user:operator@example.com', 'apply: approved_at and approved_by set in the same write');
  assert(Array.isArray(a[0].placeholders_detected) && (a[0].placeholders_detected as string[]).includes('amount_usd'), 'apply: placeholders_detected recorded');
  assert(b?.body_text === 'B terms' && b.approved_by === 'user:b', "apply: another firm's template is untouched");
  if (ok.ok) assert(ok.source === 'deterministic', 'apply: source reported as deterministic');

  // The next closed deal attaches it: the existing send path ships the contract.
  store.seed('influencers', { id: 'inf-1', display_name: 'Marlo Example', username: 'marlo_example' });
  store.seed('campaign_influencers', { id: 'ci-1', influencer_id: 'inf-1' });
  store.seed('campaigns', { id: 'camp-1', artist_name: 'Alex Owner', track_name: 'Wildfire', duration_days: 14 });
  store.seedOffer({ id: 'off-1', firm_id: 'firm-a', campaign_id: 'camp-1', campaign_influencer_id: 'ci-1', agreed_amount_usd: 120, current_offer_usd: 120, status: 'agreed' });
  const outcome = await generateOfferContract(
    store.sb,
    { id: 'off-1', firm_id: 'firm-a', campaign_id: 'camp-1', campaign_influencer_id: 'ci-1', agreed_amount_usd: 120, current_offer_usd: 120 },
    { deliverablesText: '1 TikTok video', nowMs: Date.parse(NOW) },
  );
  assert(outcome.blocked === null && typeof outcome.text === 'string', `deal flow: contract ships from the applied template (${outcome.message ?? ''})`);
  assert(Boolean(outcome.text?.includes('Marlo Example (@marlo_example)')) && Boolean(outcome.text?.includes('$120')), 'deal flow: creator and amount filled');
  assert(store.getOffer('off-1')?.contract_text === outcome.text, 'deal flow: filled copy frozen on the deal');
}

// ── 4. LLM polish, mocked ──────────────────────────────────────────────────

async function testPolishRewordsOnlyAndSurfacesTheDiff() {
  const { raw, text } = build(() => {}, SPLIT_50);

  mockHandler = (user) => user.replace('The Creator will create and publish the following content', 'The Creator shall create and publish this content');
  const good = await polishGuidedTemplate(text);
  assert(good.source === 'polished', `polish: a pure rewording is accepted (${good.warnings.join(', ')})`);
  assert(good.reworded_sections.length === 1 && good.reworded_sections[0] === 'DELIVERABLES', 'polish: the reworded section is named');
  assert(Boolean(good.diff) && good.diff!.removedSections.length === 0 && good.diff!.removedPlaceholders.length === 0, 'polish: diff surfaced and shows nothing removed');
  assert(checkPolishAgainstBase(text, good.body_text).length === 0, 'polish: accepted text passes the same check apply uses');

  const store = makeStore();
  store.seed('firms', { id: 'firm-a', require_delivery_before_balance: true, deposit_pct: 50 });
  const applied = await applyGuidedTemplate(store.sb, { firmId: 'firm-a', rawAnswers: raw, bodyText: good.body_text, approvedBy: 'user:a', nowIso: '2026-10-01T00:00:00Z' });
  assert(applied.ok && applied.source === 'polished', 'apply: a validated polish can be approved and is labelled polished');

  mockHandler = (user) => user.replace('thirty (30) days of written notice', 'fourteen (14) days of written notice');
  const numbers = await polishGuidedTemplate(text);
  assert(numbers.source === 'deterministic' && numbers.body_text === text, 'polish: a changed number falls back to the deterministic text');
  assert(numbers.warnings.some((w) => w.includes('numbers_changed')), 'polish: the reason is reported');

  mockHandler = (user) => user.replace(/^\d+\. PERFORMANCE\..*$/m, '');
  const dropped = await polishGuidedTemplate(text);
  assert(dropped.source === 'deterministic' && dropped.warnings.some((w) => w.includes('sections_changed')), 'polish: a dropped section is rejected');

  mockHandler = (user) => user.replace('promotional use only', 'any use');
  const gutted = await polishGuidedTemplate(text);
  assert(gutted.source === 'deterministic' && gutted.warnings.some((w) => w.includes('section_gutted')), 'polish: a gutted protection is rejected');

  mockHandler = (user) => user.replace('{{deliverables}}', 'the agreed content');
  const slot = await polishGuidedTemplate(text);
  assert(slot.source === 'deterministic' && slot.warnings.some((w) => w.includes('placeholders_changed')), 'polish: a dropped merge field is rejected');

  mockHandler = (user) => '```\n' + user.replace('Label', 'Label') + '\n```';
  const fenced = await polishGuidedTemplate(text);
  assert(fenced.source === 'polished' && fenced.body_text === text && fenced.reworded_sections.length === 0, 'polish: code fences stripped, nothing reworded');

  mockHandler = () => {
    throw new Error('quota exceeded');
  };
  const down = await polishGuidedTemplate(text);
  assert(down.source === 'deterministic' && down.warnings[0].startsWith('model_unavailable'), 'polish: model down falls back');
  assert(mockCalls >= 7, 'polish: the mock provider was actually called');
}

// ── 5. Wiring ──────────────────────────────────────────────────────────────

function testWiring() {
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  const apply = src('src/app/api/firm/contract-template/builder/apply/route.ts');
  assert(/requireSession\(\)/.test(apply), 'wire: apply is session-gated');
  assert(/firmId: session\.firm_id/.test(apply), 'wire: apply scopes to the session firm, never a body field');
  assert(/approvedBy: `user:\$\{session\.user\.email/.test(apply), 'wire: approved_by derived from the session');
  assert(/firm\.contract_template\.approved/.test(apply) && /firm\.contract_template\.updated/.test(apply), 'wire: same audit actions as the PUT + approve routes');
  const preview = src('src/app/api/firm/contract-template/builder/preview/route.ts');
  assert(/requireSession\(\)/.test(preview) && /polishGuidedTemplate\(/.test(preview), 'wire: preview is session-gated and runs the guarded polish');
  const page = src('src/app/settings/contract/builder/page.tsx');
  assert(/<ContractBuilder \/>/.test(page), 'wire: the builder route renders the builder');
  const ui = src('src/components/contract-builder/ContractBuilder.tsx');
  assert(/\/api\/firm\/contract-template\/builder\/apply/.test(ui), 'wire: the builder calls apply');
  assert(ui.includes('Template, not legal advice. Have counsel review before live use.'), 'wire: disclaimer shown');
  assert(!/—/.test(ui), 'wire: no em dashes in builder copy');
  assert(!/from ["']@\/lib\/contract-builder["']/.test(ui), 'wire: the client imports only the model-free options module');
  const card = src('src/components/ContractTemplateCard.tsx');
  assert(/\/settings\/contract\/builder/.test(card), 'wire: settings links to the builder');
}

async function main() {
  testDefaultsProduceASendableTemplate();
  testNoLegalNameLeavesFirmSlot();
  testEachChosenClauseAppears();
  testOffChoicesSayTheOpposite();
  testValidationRejects();
  testPaymentMatchesSplitSettlement();
  await testApplySavesApprovesFirmScoped();
  await testPolishRewordsOnlyAndSurfacesTheDiff();
  testWiring();

  console.log(`\ncontract-builder: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
