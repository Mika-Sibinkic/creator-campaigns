#!/usr/bin/env node
// tools/_apply-file.mjs — apply ONE migration file to the database in DATABASE_URL.
//
// Top-level statement splitter plus an idempotent "already exists" skip, for an
// arbitrary migration path passed on the CLI. Reads DATABASE_URL (env or
// .env.local) and executes the EXACT file contents — never a hand-retyped copy.
// On a local stack, `supabase db reset` applies the whole chain instead.
//
// USAGE:  CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/018_negotiation_foundation.sql

import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { dbClient } from './_db.mjs';

import { requireProdWriteConsent } from './_guard.mjs';
requireProdWriteConsent({
  tool: '_apply-file',
  writes: ['(arbitrary DDL from the file you pass)'],
  target: 'the database in DATABASE_URL — schema changes are not reversible by re-running',
});

config({ path: '.env.local' });

const rel = process.argv[2];
if (!rel) {
  console.error('usage: node tools/_apply-file.mjs <path-to-migration.sql>');
  process.exit(1);
}
const abs = path.resolve(process.cwd(), rel);

const sql = readFileSync(abs, 'utf8');

function splitTopLevelStatements(text) {
  const out = []; let buf = ''; let i = 0;
  let inDollar = false; let inSingle = false;
  while (i < text.length) {
    const ch = text[i]; const next = text[i + 1];
    if (!inDollar && !inSingle && ch === '-' && next === '-') {
      while (i < text.length && text[i] !== '\n') i++; continue;
    }
    if (!inDollar && !inSingle && ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      if (i < text.length) i += 2;
      continue;
    }
    if (!inSingle && ch === '$' && next === '$') {
      inDollar = !inDollar; buf += '$$'; i += 2; continue;
    }
    if (!inDollar && ch === "'") {
      if (inSingle && next === "'") { buf += "''"; i += 2; continue; }
      inSingle = !inSingle; buf += ch; i++; continue;
    }
    if (!inDollar && !inSingle && ch === ';') {
      const stmt = buf.trim();
      if (stmt.length > 0) out.push(stmt);
      buf = ''; i++; continue;
    }
    buf += ch; i++;
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

const stmts = splitTopLevelStatements(sql);
console.log(`Applying ${stmts.length} statements from ${path.basename(abs)}`);

const client = dbClient();

// Surface server NOTICEs. node-postgres discards them unless you listen, and a
// migration's `raise notice` is often the only thing it was written to tell you:
// 054's audit block names every campaign already over budget under the new fold,
// and without this listener the run prints a clean "ok" while that report is
// thrown away. A dropped NOTICE is a silent migration, not a quiet one.
let notices = 0;
client.on('notice', (n) => {
  notices++;
  const where = n.severity && n.severity !== 'NOTICE' ? ` ${n.severity}` : '';
  console.log(`\n  ⓘ${where} ${String(n.message ?? n).trim()}`);
});

await client.connect();
let ok = 0, skipped = 0, failed = 0;
for (const [i, stmt] of stmts.entries()) {
  try {
    await client.query(stmt);
    ok++; process.stdout.write('.');
  } catch (e) {
    const msg = String(e.message || e);
    if (/already exists/i.test(msg) || /duplicate_object/i.test(msg)) {
      skipped++; process.stdout.write('s'); continue;
    }
    failed++;
    console.error(`\n[${i}] FAILED:\n  ${stmt.slice(0, 200)}\n  → ${msg}`);
  }
}
console.log(`\n${ok} ok, ${skipped} skipped, ${failed} failed, ${notices} notice(s).`);
await client.end();
process.exit(failed > 0 ? 1 : 0);
