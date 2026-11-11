// tests/operator-gate.test.ts
//
// Pins WHO sees the developer surfaces. src/lib/operator.ts is the only thing
// standing between a record label and the reply simulator, testing-mode
// switches, mock-data toggles and scraper debug. A regression here either
// shows a label the operator tooling or locks the operator out of it.
//
// The trap this exists to catch: someone "fixing" the operator check by
// reusing isAllowlisted() or firm_members.role. Both grow when a label is
// onboarded. This predicate must not.
//
// Hermetic: pure predicate, no DB, no network, no env required.
//
// Run: npx tsx tests/operator-gate.test.ts

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

async function main() {
  const saved = process.env.OPERATOR_EMAILS;
  delete process.env.OPERATOR_EMAILS;

  const { isPlatformOperator, requireOperator } = await import('../src/lib/operator');

  try {
    // ── 1. Env unset: fail closed, nobody is an operator ────────────────────
    assert(!isPlatformOperator('operator.personal@example.com'), 'unset env: personal email is not an operator');
    assert(!isPlatformOperator('operator@operator.example'), 'unset env: work email is not an operator');
    assert(!isPlatformOperator('  OPERATOR@Operator.Example '), 'unset env: case + whitespace variant is not an operator');

    // Every case below runs against a configured operator list.
    process.env.OPERATOR_EMAILS = 'operator.personal@example.com,operator@operator.example';
    assert(isPlatformOperator('operator.personal@example.com'), 'env: personal email is operator');
    assert(isPlatformOperator('operator@operator.example'), 'env: work email is operator');
    assert(isPlatformOperator('  OPERATOR@Operator.Example '), 'env: case + whitespace normalized');

    // ── 2. A label is NOT an operator ───────────────────────────────────────
    // This is the whole point of the module. Every one of these addresses can
    // sign in (isAllowlisted says yes) and a label admin holds role 'owner' on
    // their own firm — none of that grants operator surfaces.
    assert(!isPlatformOperator('owner@examplerecords.example'), 'label address is not an operator');
    assert(!isPlatformOperator('staff@examplerecords.example'), 'a second label address is not an operator');

    // ── 3. No domain matching ───────────────────────────────────────────────
    // A domain rule would silently promote every future hire at the company.
    assert(
      !isPlatformOperator('someoneelse@operator.example'),
      'the operator domain does not grant operator status — exact emails only'
    );

    // ── 4. Fail closed ──────────────────────────────────────────────────────
    // getSession() degrades email to null when the Clerk Backend API is
    // unreachable. A Clerk outage must hide operator chrome, not expose it.
    assert(!isPlatformOperator(null), 'null email is not an operator');
    assert(!isPlatformOperator(undefined), 'undefined email is not an operator');
    assert(!isPlatformOperator(''), 'empty email is not an operator');
    assert(!isPlatformOperator('operator.personal'), 'a string with no @ is not an operator');

    // ── 5. Suffix and subdomain spoofs ──────────────────────────────────────
    assert(
      !isPlatformOperator('operator@operator.example.evil.test'),
      'domain-suffix spoof refused'
    );
    assert(
      !isPlatformOperator('operator@sub.operator.example'),
      'subdomain spoof refused'
    );
    assert(
      !isPlatformOperator('xoperator.personal@example.com'),
      'local-part prefix spoof refused'
    );

    // ── 6. Env is the whole list ────────────────────────────────────────────
    process.env.OPERATOR_EMAILS = 'ops@operator.example';
    assert(isPlatformOperator('ops@operator.example'), 'env: configured email is operator');
    assert(
      !isPlatformOperator('operator.personal@example.com'),
      'env: an address the var does not name is not an operator'
    );

    // ── 7. An empty var closes the door ─────────────────────────────────────
    // Same trap the login allowlist pins: a deliberate blank must not silently
    // re-open the built-in defaults.
    process.env.OPERATOR_EMAILS = '';
    assert(
      !isPlatformOperator('operator.personal@example.com'),
      'an empty OPERATOR_EMAILS grants nobody, rather than falling back'
    );

    process.env.OPERATOR_EMAILS = '  , ,  ';
    assert(
      !isPlatformOperator('operator.personal@example.com'),
      'a whitespace-only OPERATOR_EMAILS grants nobody'
    );

    // ── 8. requireOperator throws a 403 Response, not an Error ──────────────
    // Route handlers catch it and return it directly; an Error would become a
    // 500 and leak a stack instead of a clean refusal.
    process.env.OPERATOR_EMAILS = 'operator@operator.example';
    let threw: unknown = null;
    try {
      requireOperator({ user: { email: 'owner@examplerecords.example' } });
    } catch (e) {
      threw = e;
    }
    assert(threw instanceof Response, 'requireOperator throws a Response for a non-operator');
    assert(
      threw instanceof Response && threw.status === 403,
      'requireOperator throws status 403'
    );
    if (threw instanceof Response) {
      const body = (await threw.clone().json()) as { error?: string };
      assert(body.error === 'operator_only', 'requireOperator body names the reason');
    }

    let operatorThrew = false;
    try {
      requireOperator({ user: { email: 'operator@operator.example' } });
    } catch {
      operatorThrew = true;
    }
    assert(!operatorThrew, 'requireOperator passes an operator through');
  } finally {
    if (saved === undefined) delete process.env.OPERATOR_EMAILS;
    else process.env.OPERATOR_EMAILS = saved;
  }

  console.log(`operator-gate test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
