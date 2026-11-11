#!/usr/bin/env node
// tools/preflight.mjs
//
// Deploy gate. Run BEFORE `vercel deploy` (preview or prod):
//
//   node tools/preflight.mjs
//
// Exits 0 only if every external dependency is reachable AND every
// required env var is set. Each external check is cheap (read-only,
// no actor runs, no API spend) and capped at 8s.

import { config } from 'dotenv';
import process from 'node:process';

config({ path: '.env.local' });

const REQUIRED = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OPENAI_API_KEY',
  'APIFY_TOKEN',
  'RESEND_API_KEY',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
];
// Optional (warn, don't fail). Production deploys should have all of these
// before going live; local dev can run without.
const OPTIONAL = [
  'RESEND_FROM_EMAIL',
  'RESEND_WEBHOOK_SECRET',
  'CRON_SECRET',
  'SENTRY_DSN',
  'DATABASE_URL', // for tools/ migration runners
  'TEST_RECIPIENT_EMAIL',
];

let pass = 0;
let fail = 0;
let warn = 0;
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[0m';
const ok = (m) => { console.log(`  ${G}✓${D} ${m}`); pass++; };
const bad = (m, r) => { console.error(`  ${R}✗${D} ${m}\n    └─ ${r}`); fail++; };
const wn = (m) => { console.log(`  ${Y}~${D} ${m}`); warn++; };
const title = (m) => console.log(`\n── ${m} ─────────`);

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout 8s')), 8000)),
    ]);
    ok(`${label} (${Date.now() - t0}ms)`);
  } catch (e) {
    bad(label, e.message);
  }
}

title('1. Environment inventory');

for (const k of REQUIRED) {
  if (process.env[k]) ok(`${k} set`);
  else bad(`${k} missing`, 'required for production');
}
for (const k of OPTIONAL) {
  if (process.env[k]) ok(`${k} set (optional)`);
  else wn(`${k} unset (optional — fine for dev)`);
}

title('2. Supabase reachability');

await timed('Supabase /rest/v1/firms (anon read)', async () => {
  const r = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/firms?select=id&limit=1`,
    { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY } }
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  if (!Array.isArray(data)) throw new Error('non-array response');
});

title('3. OpenAI');
await timed('OpenAI /v1/models (key valid)', async () => {
  const r = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });
  if (r.status === 401) throw new Error('OPENAI_API_KEY rejected (401)');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
});

title('4. Apify');
await timed('Apify /v2/users/me (token valid)', async () => {
  const r = await fetch(
    `https://api.apify.com/v2/users/me?token=${encodeURIComponent(process.env.APIFY_TOKEN)}`
  );
  if (r.status === 401) throw new Error('APIFY_TOKEN rejected (401)');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
});

title('5. Resend');
await timed('Resend /domains (key valid)', async () => {
  const r = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
  });
  if (r.status === 401) throw new Error('RESEND_API_KEY rejected (401)');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
});

title('6. Spotify');
await timed('Spotify client-credentials grant', async () => {
  const auth = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('no access_token in response');
});

console.log(
  `\n═══════════════════════════════════════\n` +
    `Result: ${G}${pass} pass${D}, ${R}${fail} fail${D}, ${Y}${warn} warn${D}\n` +
    `═══════════════════════════════════════`
);
if (fail > 0) {
  console.error('\nDeploy gate FAILED. Resolve the above before vercel deploy.');
  process.exit(1);
}
console.log('Deploy gate green. Safe to `vercel deploy`.');
