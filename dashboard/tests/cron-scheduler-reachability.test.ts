// tests/cron-scheduler-reachability.test.ts
//
// WHAT THIS IS: the reachability drift guard for scheduled work.
//
// A scheduled tick has to clear three independent gates before it does anything:
//   1. tools/_pgcron-setup.mjs must schedule it.
//   2. src/lib/cron-paths.ts must exempt its path, or the edge middleware 401s
//      it before the route's own auth ever runs.
//   3. A route file must exist at that path and gate on authorizeCron, so the
//      exemption does not open an unauthenticated hole.
//
// Any one of the three missing produces the SAME observable: HTTP 401 with body
// {"error":"unauthorized"} — byte-identical to what an unmatched path returns.
// You cannot tell "not scheduled", "not deployed", "not exempted" and "route
// missing" apart from the response. A minute-cadence job can hit that 401 all
// day, and the only way to find out is to diff the deployed tree against the
// branch.
//
// So the three facts are parsed out of their three sources and compared here.
//
// Hermetic: reads source files, nothing else. No env, no network, no DB.
//
// Run: npx tsx tests/cron-scheduler-reachability.test.ts

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CRON_PATHS, CRON_PATH_PREFIXES, isCronPath } from '../src/lib/cron-paths';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(msg);
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

const ROOT = process.cwd();
const setupSrc = readFileSync(join(ROOT, 'tools', '_pgcron-setup.mjs'), 'utf8');
const middlewareSrc = readFileSync(join(ROOT, 'src', 'middleware.ts'), 'utf8');

/** Strip `//` line comments so prose in a header cannot satisfy an assertion. */
function jsCode(src: string): string {
  return src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');
}
const setupCode = jsCode(setupSrc);

// ───────────────────────────────────────────────────────────────────────────
// 1. What the scheduler actually schedules
// ───────────────────────────────────────────────────────────────────────────
const scheduled = [
  ...setupCode.matchAll(/\[\s*'([a-z0-9-]+)'\s*,\s*'([^']+)'\s*,\s*'(\/api\/[^']+)'\s*\]/g),
].map((m) => ({ name: m[1], schedule: m[2], path: m[3] }));

assert(scheduled.length >= 4, `_pgcron-setup.mjs schedules at least 4 jobs (found ${scheduled.length})`);
assert(
  new Set(scheduled.map((j) => j.name)).size === scheduled.length,
  'every scheduled job name is unique (cron.schedule upserts by name — a duplicate silently wins)'
);

// ───────────────────────────────────────────────────────────────────────────
// 2. Gate 2: every scheduled path is exempt from the session gate
// ───────────────────────────────────────────────────────────────────────────
for (const job of scheduled) {
  assert(
    isCronPath(job.path),
    `${job.name}: '${job.path}' is exempt in src/lib/cron-paths.ts — otherwise the ` +
      `middleware 401s it before authorizeCron runs, ${job.schedule} forever, silently`
  );
}

// And the middleware really does delegate to that module rather than keeping its
// own copy. A second local list is how the two drift apart again.
{
  assert(
    /import\s*\{[^}]*\bisCronPath\b[^}]*\}\s*from\s*'@\/lib\/cron-paths'/.test(middlewareSrc),
    "src/middleware.ts imports isCronPath from '@/lib/cron-paths'"
  );
  assert(
    !/function\s+isCronPath\s*\(/.test(middlewareSrc),
    'src/middleware.ts does not redeclare isCronPath locally (that copy would drift)'
  );
  // The exemption has to reach all three gates the middleware applies.
  for (const gate of ['isPublic', 'isCsrfExempt', 'isMembershipCheckExempt']) {
    const body = middlewareSrc.match(new RegExp(`function ${gate}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`));
    assert(body !== null, `${gate} found in middleware`);
    assert(
      (body?.[1] ?? '').includes('isCronPath('),
      `${gate} consults isCronPath — a cron path exempted from only some gates still fails`
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Gate 3: the route exists and authenticates itself
// ───────────────────────────────────────────────────────────────────────────
for (const job of scheduled) {
  const routeFile = join(ROOT, 'src', 'app', job.path.replace(/^\//, ''), 'route.ts');
  assert(existsSync(routeFile), `${job.name}: route file exists at ${job.path}`);
  if (!existsSync(routeFile)) continue;
  const routeSrc = readFileSync(routeFile, 'utf8');
  assert(
    routeSrc.includes('authorizeCron'),
    `${job.path} gates on authorizeCron — the middleware exemption removes the session backstop, ` +
      `so this IS the only gate`
  );
  assert(
    /if\s*\(\s*!\s*authorizeCron\(req\)\s*\)/.test(routeSrc),
    `${job.path} rejects on !authorizeCron(req) (calling it without acting on it is not a gate)`
  );
}

// Reverse direction: an entry in CRON_PATHS with no route is an open exemption
// on a path that may later be claimed by something else.
for (const p of CRON_PATHS) {
  const routeFile = join(ROOT, 'src', 'app', p.replace(/^\//, ''), 'route.ts');
  assert(existsSync(routeFile), `CRON_PATHS entry '${p}' has a route file (stale exemptions are holes)`);
}
assert(
  CRON_PATH_PREFIXES.includes('/api/cron/'),
  'the /api/cron/ subtree stays exempt (cron/smoke is the launch heartbeat)'
);

// ───────────────────────────────────────────────────────────────────────────
// 4. The scheduler points at the deployed app, never a placeholder
// ───────────────────────────────────────────────────────────────────────────
{
  // BASE comes from the environment, and a strict origin guard refuses anything
  // that is not a deployed https origin. BASE is interpolated into the SQL that
  // cron.schedule stores, so the same guard is also the injection guard.
  assert(
    /const BASE\s*=\s*\(process\.env\.NEXT_PUBLIC_APP_URL\b/.test(setupCode),
    '_pgcron-setup.mjs reads BASE from process.env.NEXT_PUBLIC_APP_URL'
  );
  assert(
    !/const BASE\s*=\s*['"`]/.test(setupCode),
    '_pgcron-setup.mjs has no hardcoded BASE url'
  );
  const guard = setupCode.match(/if\s*\(\s*!(\/\^https:[^\n]*?\/i)\.test\(BASE\)\s*\|\|\s*(\/[^\n]*?\/i)\.test\(BASE\)\s*\)/);
  assert(guard !== null, 'the BASE guard tests an ^https: origin regex and a placeholder regex');
  assert(/process\.exit\(1\)/.test(setupCode), 'a refused BASE exits non-zero');
  const placeholders = guard?.[2] ?? '';
  for (const p of ['localhost', '127\\.0\\.0\\.1', 'example\\.', 'your-', 'REPLACE']) {
    assert(placeholders.includes(p), `the guard refuses '${p}'`);
  }
  // Execute the guard's own regexes against sample origins.
  const toRe = (lit: string) => new RegExp(lit.slice(1, lit.lastIndexOf('/')), lit.slice(lit.lastIndexOf('/') + 1));
  if (guard) {
    const origin = toRe(guard[1]);
    const placeholder = toRe(guard[2]);
    const ok = (b: string) => origin.test(b) && !placeholder.test(b);
    assert(ok('https://campaigns.acme-records.net'), 'guard: a deployed https origin passes');
    assert(ok('https://campaigns.acme-records.net:8443'), 'guard: an explicit port passes');
    for (const bad of [
      '',
      'http://campaigns.acme-records.net',
      'https://localhost:3000',
      'https://127.0.0.1',
      'https://app.example.com',
      'https://your-app.example.com',
      'https://REPLACE_ME.net',
      'https://campaigns.acme-records.net/api',
      "https://campaigns.acme-records.net'; select 1; --",
    ]) {
      assert(!ok(bad), `guard: refuses ${JSON.stringify(bad)}`);
    }
  }
  // pg_net's default 5s timeout abandons exactly the ticks that had work to do.
  assert(
    /timeout_milliseconds\s*:=\s*(\d+)/.test(setupCode),
    '_pgcron-setup.mjs sets an explicit pg_net timeout (the 5000ms default drops working ticks)'
  );
  const timeout = Number(setupCode.match(/timeout_milliseconds\s*:=\s*(\d+)/)?.[1] ?? 0);
  assert(timeout >= 30_000, `pg_net timeout is at least 30s (got ${timeout}ms)`);
}

// ───────────────────────────────────────────────────────────────────────────
// 5. The dispatch cadence has to be able to express the jitter band
// ───────────────────────────────────────────────────────────────────────────
{
  const dispatch = scheduled.find((j) => j.path === '/api/negotiation/dispatch');
  assert(dispatch !== undefined, 'the dispatch pass is scheduled');
  // send_after is only honoured by the dispatch pass. A reply delay of 60-180s
  // inside a 5-minute beat is swallowed whole: latency lands anywhere in 0-5 min
  // regardless of what was computed, and every reply scheduled in one tick
  // leaves in the same batch. Minute cadence is what makes the band real.
  assert(
    dispatch?.schedule === '* * * * *',
    `dispatch runs every minute (got '${dispatch?.schedule}') — a slower beat swallows the ` +
      `60-180s acceptance jitter and lands replies in lockstep on the beat`
  );
}

if (failures.length > 0) console.error('\nFailures:\n - ' + failures.join('\n - '));
console.log(`cron-scheduler-reachability test: ${passed}/${passed + failed} pass`);
process.exit(failed === 0 ? 0 : 1);
