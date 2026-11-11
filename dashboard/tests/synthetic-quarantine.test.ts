// tests/synthetic-quarantine.test.ts
//
// Sample rows (synthetic = true) must never reach the creator list or the
// dashboard. Migration 067 dropped the RLS policy that used to say so, and the
// service-role client would bypass it anyway, so the .eq('synthetic', false)
// filter in each route is the only guard. Both handlers need Clerk and cannot
// run here, so this checks the source with comments stripped.
//
// Run: npx tsx tests/synthetic-quarantine.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const FILTER = /\.eq\(\s*["']synthetic["']\s*,\s*false\s*\)/;
const routes = ['src/app/api/influencers/route.ts', 'src/app/api/dashboard/route.ts'];

const missing = routes.filter((file) => {
  const src = readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return !FILTER.test(src);
});

if (missing.length) {
  for (const file of missing) console.error(`  ✗ FAIL: ${file} no longer filters .eq('synthetic', false)`);
  process.exit(1);
}
console.log(`✓ ${routes.length} routes filter out synthetic rows`);
