// tests/env.test.ts
//
// TWO PHASES, ON PURPOSE.
//
// PHASE 1 — HERMETIC. This is the part that gates CI: a unit test of the
// getEnv() contract in src/lib/env.ts, driven entirely by synthetic values
// this file writes into process.env and then restores. No .env.local, no
// network, no credentials, so it runs green on a bare checkout. Anything that
// fails here is a real regression in env.ts.
//
// PHASE 2 — LOCAL CONFIG, NON-FATAL. This file used to be ONLY phase 2: load
// .env.local, assert every required var resolves. That is a useful "is my
// laptop configured" check and a useless CI test — on any machine without
// .env.local it printed 0/10 and exited 1, so the suite could never be
// registered in CI. It is kept here as a REPORT, not an assertion: it says
// which required names are present and which are absent, and never changes the
// exit code. A var missing locally is a setup fact, not a code defect.
//
// Values are NEVER printed — only variable NAMES and present/absent. This
// output lands in CI logs.
//
// Run: npx tsx tests/env.test.ts

import { config } from 'dotenv';
import { appBaseUrl, envNumber, getEnv, OPTIONAL, REQUIRED } from '../src/lib/env';

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

// ---------------------------------------------------------------------------
// Phase 1 — hermetic contract test
// ---------------------------------------------------------------------------

// The only vars this file touches. Assigned obviously-fake values, then
// restored to their original state before phase 2 reports on them.
const SCRATCH = ['APIFY_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_FROM_EMAIL', 'NEXT_PUBLIC_APP_URL', 'NODE_ENV'] as const;
const FAKE = 'test-value';
const FAKE_FALLBACK = 'test-fallback';

function caught(fn: () => unknown): Error | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e as Error;
  }
}

function hermeticPhase() {
  const saved = new Map<string, string | undefined>();
  for (const k of SCRATCH) saved.set(k, process.env[k]);

  try {
    // 1. A set required var comes back verbatim.
    process.env.APIFY_TOKEN = FAKE;
    assert(getEnv('APIFY_TOKEN') === FAKE, 'returns the value of a set required var');

    // 2. Reads are live — nothing is snapshotted at import time. Route handlers
    //    depend on this: env set after module load still resolves.
    process.env.APIFY_TOKEN = `${FAKE}-2`;
    assert(
      getEnv('APIFY_TOKEN') === `${FAKE}-2`,
      're-reads process.env on every call (no import-time caching)',
    );

    // 3. No trimming or coercion: whitespace is a value.
    process.env.APIFY_TOKEN = '   ';
    assert(getEnv('APIFY_TOKEN') === '   ', 'whitespace-only counts as set (env.ts does not trim)');

    // 4-6. A missing required var throws, and the message names the key.
    delete process.env.APIFY_TOKEN;
    const missing = caught(() => getEnv('APIFY_TOKEN'));
    assert(missing instanceof Error, 'missing required var throws an Error');
    assert(
      missing?.message === 'Missing required env var: APIFY_TOKEN',
      'throw message is "Missing required env var: <key>"',
    );

    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    assert(
      caught(() => getEnv('SUPABASE_SERVICE_ROLE_KEY'))?.message ===
        'Missing required env var: SUPABASE_SERVICE_ROLE_KEY',
      'throw message interpolates the actual key, not a constant',
    );

    // 7-8. Empty string is treated as missing, not as a value. This is the case
    //      that silently ships a blank API key if it ever regresses.
    process.env.APIFY_TOKEN = '';
    const empty = caught(() => getEnv('APIFY_TOKEN'));
    assert(empty instanceof Error, 'empty-string required var throws');
    assert(
      empty?.message === 'Missing required env var: APIFY_TOKEN',
      'empty string is reported as missing, not returned',
    );

    // 9-11. Optional var + fallback.
    delete process.env.RESEND_FROM_EMAIL;
    assert(
      getEnv('RESEND_FROM_EMAIL', FAKE_FALLBACK) === FAKE_FALLBACK,
      'absent optional var returns the fallback',
    );
    process.env.RESEND_FROM_EMAIL = FAKE;
    assert(getEnv('RESEND_FROM_EMAIL', FAKE_FALLBACK) === FAKE, 'set optional var beats the fallback');
    process.env.RESEND_FROM_EMAIL = '';
    assert(
      getEnv('RESEND_FROM_EMAIL', FAKE_FALLBACK) === FAKE_FALLBACK,
      'empty-string optional var falls back',
    );

    // 12. undefined is the only "no fallback" sentinel — an empty fallback is
    //     a legitimate fallback and must be returned rather than throwing.
    delete process.env.RESEND_FROM_EMAIL;
    assert(getEnv('RESEND_FROM_EMAIL', '') === '', 'an empty-string fallback is returned, not treated as unset');

    // 13-16. appBaseUrl(): the app origin for links in emails and redirects.
    //        NODE_ENV is typed read-only by Next, hence the cast.
    const env = process.env as Record<string, string | undefined>;
    env.NODE_ENV = 'test';
    env.NEXT_PUBLIC_APP_URL = 'https://app.example.com//';
    assert(appBaseUrl() === 'https://app.example.com', 'appBaseUrl trims trailing slashes');
    delete env.NEXT_PUBLIC_APP_URL;
    assert(appBaseUrl() === 'http://localhost:3000', 'appBaseUrl falls back to localhost outside production');
    env.NODE_ENV = 'production';
    env.NEXT_PUBLIC_APP_URL = '   ';
    assert(
      caught(() => appBaseUrl())?.message === 'NEXT_PUBLIC_APP_URL is required in production',
      'appBaseUrl throws in production when NEXT_PUBLIC_APP_URL is blank',
    );
    env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    assert(appBaseUrl() === 'https://app.example.com', 'appBaseUrl returns the configured origin in production');

    // 17-21. envNumber(): a blank or junk override falls back instead of
    //        becoming NaN, which would silently disable a spend cap.
    assert(envNumber(undefined, 5) === 5, 'envNumber: unset → fallback');
    assert(envNumber('', 5) === 5, 'envNumber: empty string → fallback (parseFloat would give NaN)');
    assert(envNumber('   ', 5) === 5, 'envNumber: whitespace → fallback');
    assert(envNumber('abc', 5) === 5, 'envNumber: non-numeric → fallback');
    assert(envNumber('7', 5) === 7, 'envNumber: a number is honoured');
  } finally {
    // Hand phase 2 the environment it would have seen if phase 1 never ran.
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — local config report. Never asserts, never changes the exit code.
// ---------------------------------------------------------------------------

function isSet(key: string): boolean {
  const v = process.env[key];
  return typeof v === 'string' && v.length > 0;
}

function localConfigPhase() {
  // Relative to cwd, which is dashboard/ for every npm script and for the
  // documented `npx tsx tests/env.test.ts` invocation.
  const loaded = config({ path: '.env.local', quiet: true });
  const fileFound = loaded.error === undefined;

  const present = REQUIRED.filter((k) => isSet(k));
  const absent = REQUIRED.filter((k) => !isSet(k));

  console.log('');
  if (!fileFound && present.length === 0) {
    console.log(
      `env test: [SKIP] local-config check — no .env.local under ${process.cwd()}, and none of the ${REQUIRED.length} required vars are set in the environment.`,
    );
    console.log('env test: [SKIP] informational only; the hermetic assertions above are what gate CI.');
    return;
  }

  console.log(
    `env test: local-config check [NON-FATAL] — source: ${fileFound ? '.env.local' : 'ambient environment (no .env.local)'}`,
  );
  console.log(`  ${present.length}/${REQUIRED.length} required vars present (names only — values are never printed)`);
  for (const k of present) console.log(`  present: ${k}`);
  for (const k of absent) console.log(`  absent:  ${k}`);
  for (const k of OPTIONAL) console.log(`  ${isSet(k) ? 'present' : 'absent '}: ${k} (optional, has a fallback)`);
  if (absent.length > 0) {
    console.log(
      `  NOTE: ${absent.length} required var(s) absent — local setup gap, not a code defect. Not failing the suite.`,
    );
  }
}

hermeticPhase();
localConfigPhase();

console.log('');
console.log(`env test: ${passed} passed, ${failed} failed`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
