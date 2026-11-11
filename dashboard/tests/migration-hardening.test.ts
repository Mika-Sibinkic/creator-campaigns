// tests/migration-hardening.test.ts
//
// Migrations 067 and 068 close access paths that older migrations opened.
// Those older files stay as shipped (migrations are never edited), so these two
// are the only thing removing the paths. This reads their text; it does not run
// SQL. Checked against a real database by hand: see the commit that added them.
//
// Run: npx tsx tests/migration-hardening.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

const sql = (f: string) =>
  readFileSync(join(process.cwd(), 'supabase/migrations', f), 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .toLowerCase();

const m067 = sql('067_drop_unused_read_policies.sql');
for (const [policy, table] of [
  ['influencers_select_real', 'influencers'],
  ['reply_templates_select_all', 'reply_templates'],
  ['creator_contacts_select_all', 'creator_contacts'],
]) {
  assert(
    m067.includes(`drop policy if exists ${policy} on public.${table}`),
    `067 drops ${policy}`
  );
}
assert(m067.includes('drop function if exists public.rl_check_and_increment(text, int, int)'), '067 drops rl_check_and_increment');
assert(m067.includes('drop table if exists public.rate_limit_buckets'), '067 drops rate_limit_buckets');

const m068 = sql('068_audit_log_no_truncate.sql');
assert(
  /revoke truncate on public\.audit_log from anon, authenticated, service_role/.test(m068),
  '068 revokes TRUNCATE on audit_log from every API role'
);

console.log(`migration-hardening test: ${passed}/${passed + failed} pass`);
process.exit(failed === 0 ? 0 : 1);
