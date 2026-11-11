// tests/login-allowlist.test.ts
//
// Pins WHO may sign in. src/lib/auth-bootstrap.ts isAllowlisted() is the only
// gate between an authenticated Clerk session and a firm_members
// row, so a regression here either locks a label out or lets a stranger in.
//
// Hermetic: pure predicates, no DB, no network.
//
// Run: npx tsx tests/login-allowlist.test.ts

import { isAllowlisted } from '../src/lib/auth-bootstrap';
import { sessionEmail } from '../src/lib/auth';
import { isPlatformOperator } from '../src/lib/operator';

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
  const saved = {
    domains: process.env.BOOTSTRAP_ALLOWED_DOMAINS,
    emails: process.env.BOOTSTRAP_ALLOWED_EMAILS,
    operators: process.env.OPERATOR_EMAILS,
  };
  // Both unset is the fresh-install state: nobody is admitted until a
  // deployment names them (see isAllowlisted).
  delete process.env.BOOTSTRAP_ALLOWED_DOMAINS;
  delete process.env.BOOTSTRAP_ALLOWED_EMAILS;

  try {
    // ── 1. Env unset: fail closed, nobody is admitted ───────────────────────
    assert(!isAllowlisted('operator.personal@example.com'), 'unset env: a personal address is refused');
    assert(!isAllowlisted('operator@operator.example'), 'unset env: an operator address is refused');
    assert(!isAllowlisted('owner@examplerecords.example'), 'unset env: a label address is refused');
    assert(!isAllowlisted('staff@examplerecords.example'), 'unset env: a second label address is refused');
    assert(!isAllowlisted('  OPERATOR@Operator.Example '), 'unset env: case + whitespace variants are refused');
    assert(!isAllowlisted('OWNER@ExampleRecords.EXAMPLE'), 'unset env: an upper-case label address is refused');

    // ── 2. The gate still closes on malformed input ─────────────────────────
    assert(!isAllowlisted('stranger@freemail.example'), 'unset env: unrelated gmail refused');
    assert(!isAllowlisted('operator@operator.example.evil.test'), 'unset env: domain-suffix spoof refused');
    assert(!isAllowlisted('notexamplerecords.example'), 'unset env: no @ refused');
    assert(!isAllowlisted('x@sub.examplerecords.example'), 'unset env: subdomain is NOT the domain');
    assert(!isAllowlisted(''), 'unset env: empty string refused');
    assert(!isAllowlisted(null), 'unset env: null refused');
    assert(!isAllowlisted(undefined), 'unset env: undefined refused');

    // ── 3. The env vars are the only way in ─────────────────────────────────
    // A deployment sets BOTH. These pin that the configured values admit
    // exactly the named identities and nobody else.
    process.env.BOOTSTRAP_ALLOWED_DOMAINS = 'examplerecords.example';
    process.env.BOOTSTRAP_ALLOWED_EMAILS = 'operator.personal@example.com,operator@operator.example';

    assert(isAllowlisted('operator.personal@example.com'), 'env: personal email allowed');
    assert(isAllowlisted('operator@operator.example'), 'env: work email allowed');
    assert(isAllowlisted('owner@examplerecords.example'), 'env: any @examplerecords.example allowed');
    assert(isAllowlisted('staff@examplerecords.example'), 'env: a second label address allowed');
    // Case and whitespace are normalized — a real sign-in can carry either.
    assert(isAllowlisted('  OPERATOR@Operator.Example '), 'env: case + whitespace normalized');
    assert(isAllowlisted('OWNER@ExampleRecords.EXAMPLE'), 'env: label domain is case-insensitive');
    assert(!isAllowlisted('stranger@freemail.example'), 'env: unrelated address still refused');
    assert(!isAllowlisted('operator@operator.example.evil.test'), 'env: domain-suffix spoof refused');
    assert(!isAllowlisted('x@sub.examplerecords.example'), 'env: subdomain is NOT the domain');

    // ── 4. A deliberately EMPTY allowlist closes the door ───────────────────
    process.env.BOOTSTRAP_ALLOWED_DOMAINS = '';
    process.env.BOOTSTRAP_ALLOWED_EMAILS = '';
    assert(!isAllowlisted('operator.personal@example.com'), 'empty env closes the door');
    assert(!isAllowlisted('owner@examplerecords.example'), 'empty env closes the door for a label address too');

    // ── 5. Setting only ONE var does not silently drop the other ────────────
    // Each var is read on its own: setting only EMAILS leaves domains empty, so
    // every domain-admitted label stops working. Pinned so nobody "helpfully"
    // sets one var in the host and expects the other to carry over.
    delete process.env.BOOTSTRAP_ALLOWED_DOMAINS;
    process.env.BOOTSTRAP_ALLOWED_EMAILS = 'operator.personal@example.com';
    assert(
      !isAllowlisted('owner@examplerecords.example'),
      'setting only EMAILS drops the domain allowlist — both vars must be set together'
    );

    // ── 6. Only a primary or verified Clerk address reaches the gates ───────
    // Clerk lets a user attach an address they have not verified. If that
    // address were used, typing someone else's allowlisted address would be
    // enough to get in, or to become an operator.
    process.env.BOOTSTRAP_ALLOWED_DOMAINS = 'examplerecords.example';
    process.env.BOOTSTRAP_ALLOWED_EMAILS = '';
    process.env.OPERATOR_EMAILS = 'owner@examplerecords.example';
    const unverifiedOnly = {
      primaryEmailAddress: null,
      emailAddresses: [
        { emailAddress: 'owner@examplerecords.example', verification: { status: 'unverified' } },
      ],
    };
    const email = sessionEmail(unverifiedOnly);
    assert(email === null, `unverified-only user has no session email (got ${email})`);
    assert(!isAllowlisted(email), 'unverified allowlisted address gets no membership');
    assert(!isPlatformOperator(email), 'unverified operator address is not an operator');

    const verifiedSecond = {
      primaryEmailAddress: null,
      emailAddresses: [
        { emailAddress: 'owner@examplerecords.example', verification: { status: 'unverified' } },
        { emailAddress: 'staff@examplerecords.example', verification: { status: 'verified' } },
      ],
    };
    assert(
      sessionEmail(verifiedSecond) === 'staff@examplerecords.example',
      'with no primary, the first verified address is used'
    );
    assert(
      sessionEmail({ ...verifiedSecond, primaryEmailAddress: { emailAddress: 'p@examplerecords.example' } }) ===
        'p@examplerecords.example',
      'the primary address wins when there is one'
    );
    assert(sessionEmail(null) === null, 'no Clerk user → null');
  } finally {
    if (saved.operators === undefined) delete process.env.OPERATOR_EMAILS;
    else process.env.OPERATOR_EMAILS = saved.operators;
    if (saved.domains === undefined) delete process.env.BOOTSTRAP_ALLOWED_DOMAINS;
    else process.env.BOOTSTRAP_ALLOWED_DOMAINS = saved.domains;
    if (saved.emails === undefined) delete process.env.BOOTSTRAP_ALLOWED_EMAILS;
    else process.env.BOOTSTRAP_ALLOWED_EMAILS = saved.emails;
  }

  console.log(`login-allowlist test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
