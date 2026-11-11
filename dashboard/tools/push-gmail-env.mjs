#!/usr/bin/env node
// tools/push-gmail-env.mjs — push the Gmail OAuth trio to a Vercel environment
// WITHOUT ever placing a secret on a command line.
//
// `vercel env add <NAME> <target>` reads the value from stdin, so each value is
// piped directly from .env.local into the child process. Nothing lands in shell
// history, in an agent transcript, or in `ps` output.
//
//   node tools/push-gmail-env.mjs production
//
// Re-running is safe: an existing variable is removed first, then re-added.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';

const target = process.argv[2] ?? 'production';
const VARS = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];

if (!fs.existsSync('.env.local')) {
  console.error('.env.local not found — run this from dashboard/');
  process.exit(1);
}

const env = Object.fromEntries(
  fs
    .readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

function run(args, stdin) {
  return new Promise((resolve) => {
    const child = spawn('vercel', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

let failed = false;
for (const name of VARS) {
  const value = env[name];
  if (!value) {
    console.error(`✗ ${name} missing from .env.local — skipped`);
    failed = true;
    continue;
  }
  await run(['env', 'rm', name, target, '--yes']); // ignore "not found"
  const { code, out } = await run(['env', 'add', name, target], value);
  if (code === 0) {
    console.log(`✓ ${name} → ${target} (${value.length} chars, not shown)`);
  } else {
    failed = true;
    console.error(`✗ ${name} → ${target} failed:\n${out}`);
  }
}

process.exit(failed ? 1 : 0);
