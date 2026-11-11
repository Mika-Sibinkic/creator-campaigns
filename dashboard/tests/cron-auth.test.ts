// tests/cron-auth.test.ts
//
// authorizeCron is the only gate on /api/cron/* and /api/negotiation/tick (the
// middleware exempts them), so it is the only thing between the internet and
// the money and spend loop.
//
// Run: npx tsx tests/cron-auth.test.ts

import { authorizeCron } from '../src/lib/cron-auth';

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

const req = (auth?: string) => new Request('http://localhost/api/cron/x', { headers: auth === undefined ? {} : { authorization: auth } });
// NODE_ENV is typed read-only by Next, hence the cast.
const env = process.env as Record<string, string | undefined>;

env.CRON_SECRET = 'test-cron-secret';
assert(authorizeCron(req('Bearer test-cron-secret')), 'the right Bearer passes');
assert(!authorizeCron(req('Bearer test-cron-secreu')), 'a wrong secret of the same length fails');
assert(!authorizeCron(req('Bearer nope')), 'a wrong secret of a different length fails');
assert(!authorizeCron(req()), 'a missing header fails');
assert(!authorizeCron(req('test-cron-secret')), 'the secret without the Bearer prefix fails');

delete env.CRON_SECRET;
env.NODE_ENV = 'production';
assert(!authorizeCron(req()), 'no secret in production fails closed');
env.NODE_ENV = 'development';
assert(authorizeCron(req()), 'no secret in local dev passes');

console.log(`cron-auth test: ${passed} passed, ${failed} failed`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
