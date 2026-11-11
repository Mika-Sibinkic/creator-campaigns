// tests/personality.test.ts
//
// Unit tests for src/lib/personality.ts. Fully hermetic (no network, no DB).
// Covers the firm/env/default resolution priority and the shape of each voice.
//
// Run: npx tsx tests/personality.test.ts

import {
  PERSONALITY,
  DEFAULT_PERSONALITY,
  resolvePersonality,
  resolvePersonalityFromPrefs,
  personalityDirective,
  isPersonalityKey,
  type PersonalityKey,
} from '../src/lib/personality';

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

const KEYS: PersonalityKey[] = ['warm', 'direct', 'playful'];

// ── 1. Every voice is well-formed and steers away from AI tells ─────────────
for (const k of KEYS) {
  const v = PERSONALITY[k];
  assert(v.key === k, `personality: ${k} key matches`);
  assert(v.directive.length > 10, `personality: ${k} has a directive`);
  assert(!v.directive.includes('—') && !v.directive.includes('–'), `personality: ${k} directive has no em/en dash`);
  assert(Array.isArray(v.counterOpeners) && v.counterOpeners.length > 0, `personality: ${k} has counter openers`);
  assert(
    v.counterOpeners.every((o) => !o.includes('—') && !o.includes('–')),
    `personality: ${k} counter openers have no em/en dash`,
  );
}

// ── 2. isPersonalityKey guards ──────────────────────────────────────────────
assert(isPersonalityKey('warm'), 'guard: warm is a key');
assert(!isPersonalityKey('grumpy'), 'guard: grumpy is not a key');
assert(!isPersonalityKey(undefined), 'guard: undefined is not a key');
assert(!isPersonalityKey(42), 'guard: number is not a key');

// ── 3. Resolution priority: explicit firm → env → default ───────────────────
const savedEnv = process.env.CREATOR_CAMPAIGNS_PERSONALITY;
delete process.env.CREATOR_CAMPAIGNS_PERSONALITY;

assert(resolvePersonality('direct') === 'direct', 'resolve: explicit firm setting wins');
assert(resolvePersonality('playful') === 'playful', 'resolve: explicit playful');
assert(resolvePersonality(undefined) === DEFAULT_PERSONALITY, 'resolve: falls back to default when unset');
assert(resolvePersonality('nonsense') === DEFAULT_PERSONALITY, 'resolve: unknown firm value falls back to default');
assert(DEFAULT_PERSONALITY === 'warm', 'default: warm');

process.env.CREATOR_CAMPAIGNS_PERSONALITY = 'playful';
assert(resolvePersonality(undefined) === 'playful', 'resolve: env dial used when no firm setting');
assert(resolvePersonality('direct') === 'direct', 'resolve: firm setting still beats env dial');
process.env.CREATOR_CAMPAIGNS_PERSONALITY = 'garbage';
assert(resolvePersonality(undefined) === DEFAULT_PERSONALITY, 'resolve: unknown env value falls back to default');

// restore env
if (savedEnv === undefined) delete process.env.CREATOR_CAMPAIGNS_PERSONALITY;
else process.env.CREATOR_CAMPAIGNS_PERSONALITY = savedEnv;

// ── 4. personalityDirective returns the directive ───────────────────────────
assert(personalityDirective('warm') === PERSONALITY.warm.directive, 'directive: warm');
assert(personalityDirective('direct').length > 0, 'directive: direct non-empty');

// ── 5. resolvePersonalityFromPrefs: firms.outreach_prefs jsonb → key ────────
const savedEnvPrefs = process.env.CREATOR_CAMPAIGNS_PERSONALITY;
delete process.env.CREATOR_CAMPAIGNS_PERSONALITY;

assert(resolvePersonalityFromPrefs({ personality: 'direct' }) === 'direct', 'prefs: valid personality key wins');
assert(resolvePersonalityFromPrefs({ personality: 'playful' }) === 'playful', 'prefs: playful');
assert(resolvePersonalityFromPrefs({ personality: 'grumpy' }) === DEFAULT_PERSONALITY, 'prefs: unknown key falls back to default');
assert(resolvePersonalityFromPrefs({}) === DEFAULT_PERSONALITY, 'prefs: empty jsonb falls back to default');
assert(resolvePersonalityFromPrefs(null) === DEFAULT_PERSONALITY, 'prefs: null falls back to default');
assert(resolvePersonalityFromPrefs(undefined) === DEFAULT_PERSONALITY, 'prefs: undefined falls back to default');
assert(resolvePersonalityFromPrefs('direct') === DEFAULT_PERSONALITY, 'prefs: non-object jsonb falls back to default');
assert(resolvePersonalityFromPrefs({ personality: 42 }) === DEFAULT_PERSONALITY, 'prefs: non-string personality falls back to default');

process.env.CREATOR_CAMPAIGNS_PERSONALITY = 'playful';
assert(resolvePersonalityFromPrefs({}) === 'playful', 'prefs: unset pref defers to env dial');
assert(resolvePersonalityFromPrefs({ personality: 'direct' }) === 'direct', 'prefs: stored pref beats env dial');

if (savedEnvPrefs === undefined) delete process.env.CREATOR_CAMPAIGNS_PERSONALITY;
else process.env.CREATOR_CAMPAIGNS_PERSONALITY = savedEnvPrefs;

console.log(`personality test: ${passed} passed, ${failed} failed`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
