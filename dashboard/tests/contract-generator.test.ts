// tests/contract-generator.test.ts
//
// Hermetic tests for the contract template generator
// (src/lib/contract-generator.ts). The deterministic layer is pure; the
// model-assisted layer runs against the documented registerProvider() test
// seam — no network, no DB, no real model.
//
// The centre of gravity here is VALIDATION BITING. An earlier version checked
// only structure — header, known placeholders, six deal slots — so a model
// could delete the FTC section, delete governing law, invert the license into
// a perpetual assignment of the creator's content, and make payment
// discretionary, and still be accepted with zero warnings. Those exact bodies
// are pinned below as rejections.
//
// Run: npx tsx tests/contract-generator.test.ts

process.env.MODEL_PROVIDER = 'mock';
process.env.MODEL_FALLBACK_CHAIN = ''; // single-provider mode: no failover in tests

import { registerProvider } from '../src/lib/model-provider';
import {
  BASE_CONTRACT_TEMPLATE,
  REQUIRED_PLACEHOLDERS,
  REQUIRED_SECTIONS,
  buildBaseTemplate,
  extractSectionHeadings,
  normalizeGeneratedTemplate,
  normalizeJurisdiction,
  summarizeTemplateDiff,
  generateContractTemplate,
} from '../src/lib/contract-generator';
import {
  DRAFT_TEMPLATE_HEADER,
  KNOWN_PLACEHOLDERS,
  MAX_TEMPLATE_CHARS,
  buildContractVars,
  detectPlaceholders,
  fillTemplate,
  looksLikeDraftHeader,
  templateBodyError,
} from '../src/lib/contracts';

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

// Swappable mock model (the seam model-provider documents for tests).
type MockInput = { system: string; user: string };
let mockHandler: (input: MockInput) => string | Promise<string> = () => {
  throw new Error('mock model not configured for this test');
};
const mockCalls: MockInput[] = [];
registerProvider('mock', async ({ system, user }) => {
  mockCalls.push({ system, user });
  return String(await mockHandler({ system, user }));
});

const NOW = Date.parse('2026-09-17T12:00:00.000Z');
const CTX = { firmName: 'Example Records', governingLaw: 'the State of Texas' };

// ── 1. Deterministic base template ──────────────────────────────────────────

function testBaseTemplateShape() {
  assert(
    BASE_CONTRACT_TEMPLATE.startsWith(DRAFT_TEMPLATE_HEADER),
    'base: starts with the DRAFT review marker',
  );
  assert(looksLikeDraftHeader(BASE_CONTRACT_TEMPLATE), 'base: the advisory detector sees the marker');
  assert(templateBodyError(BASE_CONTRACT_TEMPLATE) === null, 'base: passes the save-boundary guards');
  assert(BASE_CONTRACT_TEMPLATE.length < MAX_TEMPLATE_CHARS / 4, 'base: comfortably under the size ceiling');
  assert(!BASE_CONTRACT_TEMPLATE.includes('[TBD]'), 'base: no bracketed placeholder prose');

  const detected = detectPlaceholders(BASE_CONTRACT_TEMPLATE);
  const known = new Set<string>(KNOWN_PLACEHOLDERS);
  assert(
    detected.every((p) => known.has(p)),
    `base: every slot is a known placeholder (got ${JSON.stringify(detected)})`,
  );
  assert(detected.includes('firm_name') && detected.includes('governing_law'),
    'base: firm-level slots present');

  // Every required section is actually in the base (the validator's contract
  // with itself — a heading typo here would silently disable a check).
  const headings = extractSectionHeadings(BASE_CONTRACT_TEMPLATE);
  for (const section of REQUIRED_SECTIONS) {
    assert(headings.includes(section.heading), `base: section "${section.heading}" present`);
    if (section.must) {
      assert(section.must.re.test(BASE_CONTRACT_TEMPLATE),
        `base: "${section.heading}" still carries its ${section.must.what}`);
    }
  }

  assert(
    normalizeGeneratedTemplate(BASE_CONTRACT_TEMPLATE).problems.length === 0,
    'base: the base itself passes validation',
  );

  // Deterministic: same input, same output.
  assert(buildBaseTemplate() === buildBaseTemplate(), 'base: deterministic (no-arg)');
  assert(buildBaseTemplate(CTX) === buildBaseTemplate(CTX), 'base: deterministic (with firm context)');
}

/**
 * The internal contradictions the first draft shipped with (F4/F5/F6).
 * Each assertion below pins a term that a real deal depends on.
 */
function testBaseTemplateIsInternallyConsistent() {
  const b = BASE_CONTRACT_TEMPLATE;

  // F4: Section 3 needs its OWN minimum live period. It used to say "at least
  // the schedule window in Section 5" — but Section 5 is a publication
  // DEADLINE, not a duration, so the label's 12-month repost right could be
  // defeated by deleting the post the next day with no breach.
  assert(/Minimum Live Period/.test(b), 'consistency: Section 3 defines a Minimum Live Period');
  assert(/ninety \(90\) days/.test(b), 'consistency: the minimum live period is an explicit duration');
  assert(
    !/at least the schedule window/.test(b),
    'consistency: no cross-reference to Section 5 as if it were a duration',
  );
  assert(/twelve \(12\) months/.test(b), 'consistency: the 12-month repost right survives');

  // F6: payment timing must match what the product does — approve → payout →
  // promo pack on collection → creator publishes. Money moves BEFORE
  // publication, so non-publication needs a remedy.
  assert(/in advance of publication/i.test(b), 'consistency: payment timing is stated');
  assert(/\brepay the full amount\b/i.test(b), 'consistency: non-publication has a repayment remedy');
  assert(/thirty \(30\) days of written notice/.test(b), 'consistency: the remedy has a deadline');

  // F5: termination must cover breach AFTER publication, and must not permit
  // termination only pre-publication while also paying for published work.
  assert(/material breach/i.test(b), 'consistency: termination for breach exists');
  assert(/cured within ten \(10\) days/.test(b), 'consistency: breach termination has a cure period');
  assert(
    !/terminate this agreement by written notice before the deliverables are published/.test(b),
    'consistency: the self-contradicting pre-publication-only termination is gone',
  );
  assert(
    /Sections 3, 4, 6 and 8 survive termination/.test(b),
    'consistency: FTC disclosure (6) is in the survival list',
  );

  // Venue, and an acceptance mechanism payment-copy.ts already asserts to the
  // creator ("collecting this payment confirms you're in for the deliverables").
  assert(/exclusive jurisdiction/i.test(b), 'consistency: Section 8 names a venue');
  assert(
    /accepts this agreement by collecting the payment/i.test(b),
    'consistency: acceptance-by-collecting-payment is in the document itself',
  );
}

function testBaseTemplateFirmSubstitution() {
  const body = buildBaseTemplate(CTX);
  assert(body.includes('Example Records (the "Label")'), 'subst: firm name landed');
  assert(body.includes('the laws of the State of Texas'), 'subst: governing law landed');
  assert(!body.includes('{{firm_name}}') && !body.includes('{{governing_law}}'),
    'subst: no firm-level slot remains');
  assert(body.includes('{{creator_name}}') && body.includes('{{amount_usd}}'),
    'subst: deal-level slots untouched');
  assert(body.startsWith(DRAFT_TEMPLATE_HEADER), 'subst: marker survives substitution');

  const partial = buildBaseTemplate({ firmName: 'Example Records' });
  assert(partial.includes('{{governing_law}}'), 'subst: omitted governing law stays a slot');
  assert(!partial.includes('{{firm_name}}'), 'subst: provided firm name filled');
}

function testGeneratedTemplateFillsEndToEnd() {
  // A generated template with firm context supplied fills COMPLETELY with
  // deal facts — zero unresolved slots for the send gate.
  const body = buildBaseTemplate(CTX);
  const { unknown } = fillTemplate(
    body,
    buildContractVars({
      creatorName: 'Marlo Example',
      creatorHandle: '@marlo_example',
      agreedUsd: 100,
      deliverablesText: '1 30-second reel',
      scheduleText: 'within 30 days of receiving the promotional materials',
      paymentMethod: 'Stripe payout',
      artistName: 'Alex Owner',
      campaignName: '"Glass Harbor" by Alex Owner',
      nowMs: NOW,
    }),
  );
  assert(unknown.length === 0, `e2e: zero unresolved slots (got ${JSON.stringify(unknown)})`);
}

// ── 2. Jurisdiction validation (F11 / the "the laws of Texas law" bug) ──

function testNormalizeJurisdiction() {
  const ok = normalizeJurisdiction('the State of Texas');
  assert('value' in ok && ok.value === 'the State of Texas', 'jurisdiction: clean input passes');

  const stripped = normalizeJurisdiction('the laws of Texas');
  assert(
    'value' in stripped && stripped.value === 'Texas',
    `jurisdiction: "the laws of X" is reduced to X (got ${JSON.stringify(stripped)})`,
  );

  // The clause reads "governed by the laws of {{governing_law}}", so this
  // would have rendered "the laws of Texas law".
  const bad = normalizeJurisdiction('Texas law');
  assert('error' in bad, 'jurisdiction: "Texas law" is refused, not silently doubled');
  assert(
    'error' in bad && bad.error.includes('the laws of Texas law'),
    `jurisdiction: the error shows what it would have read as (got ${JSON.stringify(bad)})`,
  );

  assert('error' in normalizeJurisdiction('   '), 'jurisdiction: blank refused');
  assert('error' in normalizeJurisdiction('California state law'), 'jurisdiction: "... state law" refused');
  const trailing = normalizeJurisdiction('England and Wales.');
  assert(
    'value' in trailing && trailing.value === 'England and Wales',
    'jurisdiction: trailing punctuation trimmed',
  );
}

// ── 3. Structural + substantive validation of model output ──────────────────

function testNormalizeGeneratedTemplate() {
  const ok = normalizeGeneratedTemplate(buildBaseTemplate(CTX));
  assert(ok.problems.length === 0, `normalize: base is valid (got ${JSON.stringify(ok.problems)})`);

  // Missing header → prepended, not fatal. (Body must still be a full template.)
  const noHeader = normalizeGeneratedTemplate(
    buildBaseTemplate(CTX).replace(`${DRAFT_TEMPLATE_HEADER}\n\n`, ''),
  );
  assert(noHeader.body.startsWith(DRAFT_TEMPLATE_HEADER), 'normalize: header prepended when missing');
  assert(noHeader.problems.length === 0, `normalize: header repair is not a problem (got ${JSON.stringify(noHeader.problems)})`);

  // Accidental code fence → stripped.
  const fenced = normalizeGeneratedTemplate('```\n' + buildBaseTemplate(CTX) + '\n```');
  assert(!fenced.body.includes('```'), 'normalize: code fences stripped');
  assert(fenced.problems.length === 0, 'normalize: an otherwise-valid fenced body is accepted');

  // Invented placeholder → rejected.
  const invented = normalizeGeneratedTemplate(buildBaseTemplate(CTX) + '\n10. VENUE. {{court_venue}}.');
  assert(
    invented.problems.includes('unknown_placeholder:court_venue'),
    `normalize: invented placeholder flagged (got ${JSON.stringify(invented.problems)})`,
  );

  // Dropped slot → rejected (every slot in the base is required).
  const dropped = normalizeGeneratedTemplate(
    buildBaseTemplate(CTX).replace(/\{\{amount_usd\}\}/g, 'a fair fee'),
  );
  assert(
    dropped.problems.includes('missing_placeholder:amount_usd'),
    `normalize: dropped {{amount_usd}} flagged (got ${JSON.stringify(dropped.problems)})`,
  );
  assert(
    REQUIRED_PLACEHOLDERS.includes('creator_handle') && REQUIRED_PLACEHOLDERS.includes('campaign_name'),
    'normalize: the required-slot list covers every deal slot, not just the obvious six',
  );
  assert(
    !REQUIRED_PLACEHOLDERS.includes('governing_law') && !REQUIRED_PLACEHOLDERS.includes('firm_name'),
    'normalize: firm-level slots are NOT required by default — generation substitutes them away',
  );

  // ...but when the firm supplies no jurisdiction, {{governing_law}} is still
  // a slot in the base handed to the model, and dropping it must be rejected.
  const noLawBase = buildBaseTemplate({ firmName: 'Example Records' });
  const droppedLaw = normalizeGeneratedTemplate(
    noLawBase.replace(/\{\{governing_law\}\}/g, 'a jurisdiction to be decided'),
    { required: detectPlaceholders(noLawBase) },
  );
  assert(
    droppedLaw.problems.includes('missing_placeholder:governing_law'),
    `normalize: an unsupplied firm slot is required when it was in the base (got ${JSON.stringify(droppedLaw.problems)})`,
  );
}

/**
 * REGRESSION (F2). The reviewer fed the old validator a body with the FTC and
 * governing-law sections deleted, the license inverted into a perpetual
 * worldwide assignment, and payment made discretionary and clawback-able. It
 * returned problems: [] and source: 'llm'. Every one of those must now be a
 * rejection.
 */
function testGuttedSectionsAreRejected() {
  const base = buildBaseTemplate(CTX);

  // Delete the FTC section outright.
  const noFtc = base.replace(/^6\. DISCLOSURE \(FTC\)\..*$/m, '');
  assert(
    normalizeGeneratedTemplate(noFtc).problems.some((p) => p.startsWith('missing_section:DISCLOSURE (FTC)')),
    `gutted: deleting the FTC section is rejected (got ${JSON.stringify(normalizeGeneratedTemplate(noFtc).problems)})`,
  );

  // Delete governing law.
  const noLaw = base.replace(/^8\. GOVERNING LAW AND VENUE\..*$/m, '');
  const noLawProblems = normalizeGeneratedTemplate(noLaw).problems;
  assert(
    noLawProblems.some((p) => p.startsWith('missing_section:GOVERNING LAW AND VENUE')),
    `gutted: deleting governing law is rejected (got ${JSON.stringify(noLawProblems)})`,
  );

  // Invert the license into an assignment — keeps the heading, loses the limit.
  const assigned = base.replace(
    /^2\. LICENSE TO THE CREATOR\..*$/m,
    '2. LICENSE TO THE CREATOR. The Creator irrevocably assigns to the Label all rights, title and interest in the content, worldwide and in perpetuity.',
  );
  assert(
    normalizeGeneratedTemplate(assigned).problems.some((p) =>
      p.startsWith('section_gutted:LICENSE TO THE CREATOR'),
    ),
    `gutted: an inverted license is rejected even though the heading survives (got ${JSON.stringify(normalizeGeneratedTemplate(assigned).problems)})`,
  );

  // Make payment discretionary and reclaimable — heading survives, remedy dies.
  const discretionary = base.replace(
    /^4\. PAYMENT AND TIMING\..*$/m,
    '4. PAYMENT AND TIMING. The Label may pay the Creator {{amount_usd}} via {{payment_method}} at its sole discretion, and may reclaim it at any time.',
  );
  assert(
    normalizeGeneratedTemplate(discretionary).problems.some((p) =>
      p.startsWith('section_gutted:PAYMENT AND TIMING'),
    ),
    'gutted: discretionary/reclaimable payment is rejected',
  );

  // Strip the creator's ownership of their own content.
  const noOwnership = base.replace(/The Creator retains ownership of the content they create\. /, '');
  assert(
    normalizeGeneratedTemplate(noOwnership).problems.some((p) =>
      p.startsWith('section_gutted:CONTENT RIGHTS AND USAGE WINDOW'),
    ),
    'gutted: removing creator ownership is rejected',
  );

  // Renaming a section counts as removing it — a reviewer scanning headings
  // would not notice "FTC DISCLOSURE" is not "DISCLOSURE (FTC)".
  const renamed = base.replace('6. DISCLOSURE (FTC).', '6. FTC DISCLOSURE.');
  assert(
    normalizeGeneratedTemplate(renamed).problems.some((p) => p.startsWith('missing_section:')),
    'gutted: a renamed required section is rejected',
  );
}

function testSummarizeTemplateDiff() {
  const base = buildBaseTemplate(CTX);
  const mutated =
    base.replace('6. DISCLOSURE (FTC).', '6. FTC DISCLOSURE.').replace(/\{\{campaign_name\}\}/g, 'the campaign') +
    '\n\n10. EXCLUSIVITY. The Creator will not promote competing releases for thirty (30) days.';
  const d = summarizeTemplateDiff(base, mutated);
  assert(d.removedSections.includes('DISCLOSURE (FTC)'), 'diff: the renamed-away section is listed as removed');
  assert(d.addedSections.includes('FTC DISCLOSURE'), 'diff: the new name is listed as added');
  assert(d.addedSections.includes('EXCLUSIVITY'), 'diff: a genuinely new section is listed');
  assert(
    d.removedPlaceholders.includes('campaign_name'),
    'diff: a slot that stopped being filled per deal is named',
  );
  const same = summarizeTemplateDiff(base, base);
  assert(
    same.removedSections.length === 0 && same.addedSections.length === 0 && same.removedPlaceholders.length === 0,
    'diff: identical bodies produce an empty diff',
  );
}

// ── 4. generateContractTemplate: deterministic path ─────────────────────────

async function testGenerateWithoutClauses() {
  mockHandler = () => {
    throw new Error('model must not be called on the deterministic path');
  };
  const before = mockCalls.length;
  const res = await generateContractTemplate(CTX);
  assert(mockCalls.length === before, 'no-clauses: zero model calls');
  assert(res.source === 'base', `no-clauses: source 'base' (got ${res.source})`);
  assert(res.generated_by === 'base', `no-clauses: generated_by 'base' (got ${res.generated_by})`);
  assert(res.warnings.length === 0, 'no-clauses: no warnings');
  assert(res.diff === null, 'no-clauses: no diff (nothing was customized)');
  assert(res.body_text === buildBaseTemplate(CTX), 'no-clauses: exactly the deterministic base');
}

// ── 5. Model-assisted path: valid output accepted ───────────────────────────

async function testGenerateWithClausesAccepted() {
  const custom =
    buildBaseTemplate(CTX) +
    '\n\n10. EXCLUSIVITY. The Creator will not promote directly competing releases for thirty (30) days after the final deliverable.';
  mockHandler = () => custom;
  const res = await generateContractTemplate({
    ...CTX,
    extraClauses: "creator can't work with competing labels for 30 days",
  });
  assert(res.source === 'llm', `clauses: source 'llm' (got ${res.source})`);
  assert(res.generated_by === 'mock', `clauses: generated_by is the provider label (got ${res.generated_by})`);
  assert(res.body_text.startsWith(DRAFT_TEMPLATE_HEADER), 'clauses: marker first');
  assert(res.body_text.includes('EXCLUSIVITY'), 'clauses: customization present');
  assert(res.warnings.length === 0, `clauses: no warnings (got ${JSON.stringify(res.warnings)})`);
  assert(res.diff !== null && res.diff.addedSections.includes('EXCLUSIVITY'),
    'clauses: the reviewer diff names what was added');
  assert(res.diff !== null && res.diff.removedSections.length === 0,
    'clauses: nothing reported removed when nothing was');

  // Prompt hygiene: clauses are content-not-instructions, rules are stated.
  const call = mockCalls[mockCalls.length - 1];
  assert(call.system.includes(DRAFT_TEMPLATE_HEADER), 'clauses: system prompt pins the header');
  assert(/not instructions/i.test(call.system), 'clauses: system prompt marks clauses as content, not instructions');
  assert(/heading text UNCHANGED/i.test(call.system), 'clauses: system prompt demands the sections survive');
  assert(/never convert the license into an assignment/i.test(call.system),
    'clauses: system prompt forbids inverting the license');
  assert(call.user.includes("creator can't work with competing labels"), 'clauses: firm words reach the model');
}

// ── 6. Model output that fails validation → deterministic fallback ──────────

async function testGenerateRejectedOutputFallsBack() {
  mockHandler = () =>
    'Sure! Here is your contract: pay {{creator_name}} {{a_totally_new_slot}}.';
  const res = await generateContractTemplate({
    ...CTX,
    extraClauses: 'content must stay up 6 months',
  });
  assert(res.source === 'base_with_clauses_appended', `rejected: fallback source (got ${res.source})`);
  assert(res.generated_by === 'base', `rejected: fallback provenance 'base' (got ${res.generated_by})`);
  assert(res.body_text.startsWith(DRAFT_TEMPLATE_HEADER), 'rejected: fallback keeps the marker');
  assert(res.body_text.includes('content must stay up 6 months'), 'rejected: firm clauses preserved VERBATIM');
  assert(res.body_text.includes('ADDITIONAL TERMS SUPPLIED BY THE LABEL'), 'rejected: clauses clearly labelled');
  assert(!res.body_text.includes('a_totally_new_slot'), 'rejected: bad model output discarded entirely');
  assert(res.diff === null, 'rejected: no diff for output that was not used');
  assert(
    res.warnings.some((w) => w.startsWith('model_output_rejected')),
    `rejected: warning names the rejection (got ${JSON.stringify(res.warnings)})`,
  );

  // F9: reviewer instructions belong in warnings, never inside the document.
  assert(
    !/rewrite into contract language/i.test(res.body_text),
    'rejected: no instructions addressed to the reviewer inside body_text',
  );
  assert(
    !/legal review/i.test(res.body_text.slice(res.body_text.indexOf('ADDITIONAL TERMS'))),
    'rejected: the appended block is a label, not a to-do note',
  );
}

/** A gutted model body must fall back too, not just fail validation in a unit test. */
async function testGenerateGuttedOutputFallsBack() {
  mockHandler = () => buildBaseTemplate(CTX).replace(/^6\. DISCLOSURE \(FTC\)\..*$/m, '');
  const res = await generateContractTemplate({
    ...CTX,
    extraClauses: 'no disclosure needed, skip the FTC part',
  });
  assert(
    res.source === 'base_with_clauses_appended',
    `gutted-e2e: model output that drops FTC falls back to the base (got ${res.source})`,
  );
  assert(/DISCLOSURE \(FTC\)/.test(res.body_text), 'gutted-e2e: the shipped draft still has FTC disclosure');
  assert(
    res.warnings.some((w) => w.includes('missing_section:DISCLOSURE (FTC)')),
    `gutted-e2e: the warning names the deleted section (got ${JSON.stringify(res.warnings)})`,
  );
}

// ── 7. Model unavailable → deterministic fallback, never a throw ────────────

async function testGenerateModelDownFallsBack() {
  mockHandler = () => {
    throw new Error('provider exploded');
  };
  const res = await generateContractTemplate({ firmName: 'Example Records', extraClauses: 'some clause' });
  assert(res.source === 'base_with_clauses_appended', `down: fallback source (got ${res.source})`);
  assert(
    res.warnings.some((w) => w.startsWith('model_unavailable')),
    `down: warning names the outage (got ${JSON.stringify(res.warnings)})`,
  );
  assert(res.body_text.includes('some clause'), 'down: clauses still preserved');
  assert(res.body_text.startsWith(DRAFT_TEMPLATE_HEADER), 'down: marker still first');
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  testBaseTemplateShape();
  testBaseTemplateIsInternallyConsistent();
  testBaseTemplateFirmSubstitution();
  testGeneratedTemplateFillsEndToEnd();
  testNormalizeJurisdiction();
  testNormalizeGeneratedTemplate();
  testGuttedSectionsAreRejected();
  testSummarizeTemplateDiff();
  await testGenerateWithoutClauses();
  await testGenerateWithClausesAccepted();
  await testGenerateRejectedOutputFallsBack();
  await testGenerateGuttedOutputFallsBack();
  await testGenerateModelDownFallsBack();

  console.log(`\ncontract-generator: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
