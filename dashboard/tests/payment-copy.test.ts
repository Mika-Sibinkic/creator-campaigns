// tests/payment-copy.test.ts
//
// Creator payment emails said "Legal terms: [TBD]" while asserting
// a binding obligation at the moment money moved. These tests pin the fix:
//
//   1. With a frozen contract on the deal → the copy references the agreement
//      terms and the date they were sent (inline with the acceptance email —
//      never "a separate email" / "an attachment", which was false).
//   2. Without one → NO binding-obligation assertion; the copy states plainly
//      that the agreement terms follow.
//   3. The literal string "[TBD]" survives nowhere in src/ — not in sent copy,
//      not in anything that could become sent copy.
//
// Hermetic: pure functions + a local filesystem scan. No network, no DB.
//
// Run: npx tsx tests/payment-copy.test.ts

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { agreementTermsSentence, contractSentAt } from '../src/lib/payment-copy';

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

// ── 1. Frozen contract → reference the terms actually sent ──────────────────

function testWithFrozenContract() {
  const s = agreementTermsSentence('2026-09-14T12:00:00.000Z', 'the deliverables above');
  assert(
    s ===
      "Collecting this payment confirms you're in for the deliverables above, " +
        'per the agreement terms sent with your acceptance email on September 14, 2026.',
    `contract: exact sentence (got "${s}")`,
  );
  assert(!s.includes('[TBD]'), 'contract: no [TBD]');
  assert(!/separate email|attachment/i.test(s), 'contract: no false "separate email"/"attachment" claim');
  assert(s.includes('September 14, 2026'), 'contract: date formatted deterministically (UTC)');

  // The caller's noun phrase lands verbatim.
  const s2 = agreementTermsSentence('2026-01-02T00:00:00.000Z', 'the agreed deliverables');
  assert(s2.includes('the agreed deliverables'), 'contract: deliverables phrase in context');
  assert(s2.includes('January 2, 2026'), 'contract: second date correct');
}

// ── 2. No contract → no binding assertion, terms follow ─────────────────────

function testWithoutContract() {
  for (const v of [null, undefined, '', 'not-a-date'] as const) {
    const s = agreementTermsSentence(v as string | null | undefined, 'the deliverables above');
    assert(
      s === 'The deliverables and amount above are the agreed terms for this collaboration.',
      `no-contract(${JSON.stringify(v)}): plain terms-follow sentence (got "${s}")`,
    );
    assert(!s.includes('[TBD]'), `no-contract(${JSON.stringify(v)}): no [TBD]`);
    assert(
      !/binds|confirms|legally|obligat/i.test(s),
      `no-contract(${JSON.stringify(v)}): no binding-obligation assertion`,
    );
  }
}

// ── contractSentAt: timestamp only counts when the text is frozen ───────────

function testContractSentAtGate() {
  assert(
    contractSentAt({ contract_text: 'Agreement…', contract_generated_at: '2026-09-14T12:00:00Z' }) ===
      '2026-09-14T12:00:00Z',
    'gate: text + timestamp → timestamp',
  );
  assert(
    contractSentAt({ contract_text: null, contract_generated_at: '2026-09-14T12:00:00Z' }) === null,
    'gate: timestamp without frozen text is ignored (never reference terms that were not sent)',
  );
  assert(
    contractSentAt({ contract_text: '   ', contract_generated_at: '2026-09-14T12:00:00Z' }) === null,
    'gate: blank text is no text',
  );
  assert(contractSentAt({ contract_text: 'x', contract_generated_at: null }) === null, 'gate: text without timestamp → null (sentence degrades to terms-follow)');
  // …and the degraded value produces the safe sentence, not a crash.
  const s = agreementTermsSentence(contractSentAt({}), 'the deliverables above');
  assert(s.includes('are the agreed terms'), 'gate: empty offer → self-contained terms sentence');
}

// ── 3. "[TBD]" survives nowhere in src/ ─────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function testNoTbdAnywhereInSrc() {
  const root = join(__dirname, '..', 'src');
  const offenders = walk(root).filter((f) => readFileSync(f, 'utf8').includes('[TBD]'));
  assert(
    offenders.length === 0,
    `no "[TBD]" anywhere in src/ (found in: ${offenders.join(', ')})`,
  );
}

// ── Run ─────────────────────────────────────────────────────────────────────

testWithFrozenContract();
testWithoutContract();
testContractSentAtGate();
testNoTbdAnywhereInSrc();

console.log(`\npayment-copy: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
