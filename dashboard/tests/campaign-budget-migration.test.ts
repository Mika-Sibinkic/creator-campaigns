// tests/campaign-budget-migration.test.ts
//
// supabase/migrations/045_campaign_budget_structural.sql: the campaign total
// budget as a database invariant.
//
// WHAT THIS IS NOT: this does not execute the SQL. A concurrent overspend
// being refused by a real database is not something this file can show.
//
// WHAT IT IS: the drift guard. The trigger's notion of "committed spend" has
// to stay identical to the app's, or the database and the UI will disagree
// about what a campaign can still afford — the trigger would refuse deals the
// confirm page shows as affordable, or wave through ones it doesn't. So the
// committed-state list and the amount fold are parsed out of BOTH
// src/lib/negotiation.ts and the migration and compared. Plus the mechanical
// properties the file has to have to be applied safely at all.
//
// Hermetic: reads source files, nothing else. No env, no network, no DB.
//
// Run: npx tsx tests/campaign-budget-migration.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
// 054 supersedes 045's function body (CREATE OR REPLACE, same signature, so the
// trigger binding from 045 still points at it). The drift guard has to read the
// CURRENT definition — pinned at 045 it kept asserting against a body that no
// longer runs, which is how it would have gone quietly green while the live
// guard was wrong.
const MIGRATION = join(ROOT, 'supabase', 'migrations', '054_budget_guard_split_states.sql');
const BASE_MIGRATION = join(ROOT, 'supabase', 'migrations', '045_campaign_budget_structural.sql');
const sql = readFileSync(MIGRATION, 'utf8');
const baseSql = readFileSync(BASE_MIGRATION, 'utf8');
const negotiationSrc = readFileSync(join(ROOT, 'src', 'lib', 'negotiation.ts'), 'utf8');

/** Strip `--` line comments so prose in the header can neither satisfy nor
 *  trip a structural assertion. */
function sqlCode(src: string): string {
  return src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
}
const code = sqlCode(sql);

// ───────────────────────────────────────────────────────────────────────────
// 1. The drift guard: committed states must match negotiation.ts exactly
// ───────────────────────────────────────────────────────────────────────────
{
  const tsBlock = negotiationSrc.match(/const COMMITTED_STATES:[^=]*=\s*\[([^\]]*)\]/);
  assert(tsBlock !== null, 'COMMITTED_STATES found in src/lib/negotiation.ts');
  const tsStates = (tsBlock?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);

  // 9 since migration 052 added the split-settlement states. If this number
  // changes again, the migration that changes it must ship in the same commit.
  assert(tsStates.length === 9, `negotiation.ts lists 9 committed states (got ${tsStates.length})`);

  // Every `array[...]` of states in the migration must be the same set.
  // No `s` flag: the tsconfig target predates it, and `[^\]]` already spans
  // newlines anyway.
  const sqlArrays = [...code.matchAll(/array\s*\[\s*([^\]]*?)\s*\]/gi)]
    .map((m) =>
      m[1]
        .split(',')
        .map((s) => s.trim().replace(/^'|'$/g, ''))
        .filter(Boolean)
    )
    .filter((arr) => arr.includes('agreed'));

  assert(
    sqlArrays.length === 2,
    `migration declares the committed-state list twice (guard + audit block); found ${sqlArrays.length}`
  );

  for (const [i, arr] of sqlArrays.entries()) {
    assert(
      arr.length === tsStates.length && arr.every((s, j) => s === tsStates[j]),
      `SQL committed-state list #${i + 1} matches negotiation.ts COMMITTED_STATES exactly ` +
        `(app: [${tsStates.join(', ')}] vs sql: [${arr.join(', ')}])`
    );
  }

  // The exclusion that matters most. If these ever became
  // committed, the trigger would refuse deals the UI shows as affordable.
  for (const excluded of ['offered', 'counter_offered']) {
    assert(!tsStates.includes(excluded), `app excludes '${excluded}' from committed spend`);
    for (const arr of sqlArrays) {
      assert(!arr.includes(excluded), `migration excludes '${excluded}' from committed spend`);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 2. The amount fold must match `agreed_amount_usd ?? current_offer_usd ?? 0`
// ───────────────────────────────────────────────────────────────────────────
{
  assert(
    negotiationSrc.includes('row.agreed_amount_usd ?? row.current_offer_usd ?? 0'),
    'app folds agreed ?? current ?? 0 (committedContribution)'
  );
  const folds = [...code.matchAll(/coalesce\(\s*(?:o|NEW|OLD)\.agreed_amount_usd\s*,\s*(?:o|NEW|OLD)\.current_offer_usd\s*,\s*0\s*\)/gi)];
  assert(folds.length >= 3, `migration uses the same COALESCE fold everywhere (found ${folds.length})`);

  // An undelivered deal contributes only the deposit that actually left. Both
  // sides must agree, or the structural ceiling and the app disagree about how
  // much budget a non-delivery frees.
  assert(
    negotiationSrc.includes("row.status === 'undelivered'") &&
      negotiationSrc.includes('row.deposit_paid_usd ?? 0'),
    'app contributes only the deposit for an undelivered deal'
  );
  const depositFolds = [
    ...code.matchAll(/when\s+(?:o|NEW|OLD)\.status\s*=\s*'undelivered'\s*then\s*coalesce\(\s*(?:o|NEW|OLD)\.deposit_paid_usd\s*,\s*0\s*\)/gi),
  ];
  assert(
    depositFolds.length >= 3,
    `migration contributes only the deposit for undelivered, everywhere (found ${depositFolds.length})`
  );
  // And 045's original body must still be the thing 054 replaces, so nobody
  // "fixes" a drift failure by editing the superseded file instead.
  assert(
    /create or replace function public\.creator_offers_campaign_budget_guard/i.test(baseSql),
    '045 still declares the guard that 054 replaces'
  );
  assert(
    !/coalesce\(\s*o\.current_offer_usd\s*,\s*o\.agreed_amount_usd/i.test(code),
    'the fold is never inverted (agreed wins over current, as in the app)'
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 3. It actually closes the race
// ───────────────────────────────────────────────────────────────────────────
{
  assert(
    /pg_advisory_xact_lock/.test(code),
    'takes a transaction-scoped advisory lock — without it the trigger is still read-then-write'
  );
  // Nested parens in the key expression, so match across them rather than
  // stopping at the first ')'.
  assert(
    /pg_advisory_xact_lock\([\s\S]{0,200}?campaign_id/i.test(code),
    'the advisory lock is keyed on the campaign, not global'
  );
  assert(
    !/pg_advisory_lock\s*\(/.test(code),
    'uses the xact-scoped lock, never the session-scoped one (which would leak on a pooled connection)'
  );
  assert(
    /before\s+insert\s+or\s+update\s+on\s+public\.creator_offers/i.test(code),
    'fires BEFORE INSERT OR UPDATE on creator_offers'
  );
  assert(/for\s+each\s+row/i.test(code), 'is a row-level trigger');
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Additive + safe on existing rows
// ───────────────────────────────────────────────────────────────────────────
{
  assert(
    /new_contrib\s*<=\s*old_contrib/.test(code),
    'never blocks a write that does not increase committed spend (safe on already-over-budget campaigns)'
  );
  assert(
    /budget\s+is\s+null\s+or\s+budget\s*<=\s*0/i.test(code),
    'treats a NULL/0 total_budget_usd as "no cap", matching computeEffectiveCeiling'
  );
  assert(/raise\s+notice/i.test(code), 'reports pre-existing offenders instead of aborting');
  assert(
    !/raise\s+exception[\s\S]{0,400}?already\s+over/i.test(code),
    'the existing-row audit never raises'
  );
  assert(
    /drop\s+trigger\s+if\s+exists/i.test(code) && /create\s+or\s+replace\s+function/i.test(code),
    're-runnable (drop trigger if exists + create or replace function)'
  );
  // Destructive DDL has no place in an additive migration.
  for (const forbidden of [/drop\s+table/i, /drop\s+column/i, /truncate/i, /delete\s+from/i]) {
    assert(!forbidden.test(code), `migration contains no ${String(forbidden)}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 5. Mechanical constraints of tools/_apply-file.mjs
// ───────────────────────────────────────────────────────────────────────────
{
  // The splitter toggles dollar-quoting on a literal `$$` and does not
  // understand tagged delimiters, so `$func$` would be shredded at the
  // first semicolon inside the body.
  const tagged = code.match(/\$[A-Za-z_][A-Za-z0-9_]*\$/g);
  assert(tagged === null, `only bare $$ dollar-quoting (found ${JSON.stringify(tagged)})`);

  const dollars = (code.match(/\$\$/g) ?? []).length;
  assert(dollars > 0 && dollars % 2 === 0, `dollar quotes are balanced (found ${dollars})`);

  // The applier continues past failures, so a wrapping transaction would turn
  // one failed statement into a cascade of aborted ones.
  assert(
    !/^\s*begin\s*;/im.test(code) && !/^\s*commit\s*;/im.test(code),
    'not wrapped in an explicit transaction (037 precedent, safer under the applier)'
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 6. Header conventions
// ───────────────────────────────────────────────────────────────────────────
{
  assert(/Rollback:/.test(sql), 'documents a rollback');
  assert(/tools\/_apply-file\.mjs/.test(sql), 'names the applier');
  assert(
    /errcode\s*=\s*'check_violation'/.test(code),
    'raises SQLSTATE 23514, the same class as the per-creator ceiling CHECK'
  );
  assert(
    /campaign_total_budget_exceeded/.test(code),
    'uses the campaign_total_budget_exceeded slug, which already has operator copy in statuses.ts'
  );
  assert(
    readFileSync(join(ROOT, 'src', 'lib', 'statuses.ts'), 'utf8').includes(
      'campaign_total_budget_exceeded'
    ),
    'that slug really does have copy in statuses.ts'
  );

  // The fix stays out of the negotiation module: the invariant lives in the
  // database, not in application code.
  assert(
    !negotiationSrc.includes('pg_advisory'),
    'src/lib/negotiation.ts was not touched — the invariant stays in the database'
  );
}

if (failures.length > 0) console.error('\nFailures:\n - ' + failures.join('\n - '));
console.log(`campaign-budget-migration test: ${passed}/${passed + failed} pass`);
process.exit(failed === 0 ? 0 : 1);
