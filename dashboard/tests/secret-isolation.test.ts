// tests/secret-isolation.test.ts
//
// Enforces the payment-secret isolation convention that stripe-isolated.ts and
// paypal-isolated.ts document in their headers: each provider secret may be
// referenced in EXACTLY ONE module. A leak (some route reading the secret
// directly, bypassing the isolated shim) fails this test.
//
// Run: npx tsx tests/secret-isolation.test.ts

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', 'src');

// secret env name → the ONE module (relative to src/) allowed to reference it.
// The needle is a substring match, so 'STRIPE_SECRET_KEY' alone would already
// catch the _TEST/_LIVE reads; each name is listed anyway so renaming one
// cannot silently drop it from the gate. The webhook signing secrets moved
// into stripe-isolated.ts with the Test/Live switch (2026-10-01).
const RULES: Array<{ secret: string; allowed: string }> = [
  { secret: 'STRIPE_SECRET_KEY', allowed: 'lib/stripe-isolated.ts' },
  { secret: 'STRIPE_SECRET_KEY_TEST', allowed: 'lib/stripe-isolated.ts' },
  { secret: 'STRIPE_SECRET_KEY_LIVE', allowed: 'lib/stripe-isolated.ts' },
  { secret: 'STRIPE_WEBHOOK_SECRET', allowed: 'lib/stripe-isolated.ts' },
  { secret: 'STRIPE_WEBHOOK_SECRETS_TEST', allowed: 'lib/stripe-isolated.ts' },
  { secret: 'STRIPE_WEBHOOK_SECRETS_LIVE', allowed: 'lib/stripe-isolated.ts' },
  { secret: 'PAYPAL_CLIENT_SECRET', allowed: 'lib/paypal-isolated.ts' },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const files = walk(SRC);
let failed = 0;

for (const { secret, allowed } of RULES) {
  const offenders: string[] = [];
  let allowedFileSawIt = false;
  // Match the actual env READ (`process.env.SECRET`), not bare mentions in
  // comments/docstrings — those are fine, reading the value elsewhere is not.
  const needle = `process.env.${secret}`;
  for (const file of files) {
    const rel = relative(SRC, file);
    if (!readFileSync(file, 'utf8').includes(needle)) continue;
    if (rel === allowed) {
      allowedFileSawIt = true;
    } else {
      offenders.push(rel);
    }
  }
  if (offenders.length > 0) {
    console.error(`✗ FAIL: ${secret} referenced outside ${allowed}: ${offenders.join(', ')}`);
    failed++;
  } else if (!allowedFileSawIt) {
    console.error(`✗ FAIL: ${secret} not found in ${allowed} — isolation module missing or renamed`);
    failed++;
  } else {
    console.log(`✓ ${secret} isolated to ${allowed}`);
  }
}

console.log(`secret-isolation test: ${RULES.length - failed}/${RULES.length} pass`);
process.exit(failed === 0 ? 0 : 1);
