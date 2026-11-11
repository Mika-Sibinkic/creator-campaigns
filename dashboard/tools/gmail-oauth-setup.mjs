#!/usr/bin/env node
// tools/gmail-oauth-setup.mjs — one-time Gmail OAuth bootstrap.
//
// Walks the Google OAuth consent flow ONCE, locally, and prints the
// long-lived GMAIL_REFRESH_TOKEN that production uses to mint fresh access
// tokens forever after (src/lib/channels/gmail-inbound.ts exchanges it per
// ~45 min).
//
// TOKEN LIFETIME — READ THIS BEFORE RELYING ON IT. The "no timer" rule applies
// only to an app whose publishing status is PRODUCTION. While the app sits in
// TESTING (which is what the prereqs below set up), Google expires the refresh
// token after SEVEN DAYS, and the poller then fails until someone re-consents.
// "Internal" is not an option here: the target inbox is a consumer Gmail
// account, not a Workspace one. So either publish the app, or expect to redo
// this weekly.
//
// PREREQS (one-time, in Google Cloud Console — console.cloud.google.com):
//   1. APIs & Services → Library → enable "Gmail API".
//   2. APIs & Services → OAuth consent screen → External → add the Gmail
//      account that receives [Creator Campaigns] replies as a Test user.
//   3. APIs & Services → Credentials → Create credentials → OAuth client ID.
//      EITHER type "Desktop app" (allows any localhost redirect, simplest)
//      OR type "Web application" with authorized redirect URI
//      http://localhost:53682/oauth2callback
//   4. Put the client id + secret into .env.local:
//        GMAIL_CLIENT_ID=<from step 3>
//        GMAIL_CLIENT_SECRET=<from step 3>
//
// RUN (from dashboard/):
//   node tools/gmail-oauth-setup.mjs
//
// The script prints a consent URL — open it in a browser signed into the
// inbox account and approve. Then EITHER:
//   a. the localhost callback server catches the redirect automatically, OR
//   b. (headless / remote box) the redirect page fails to load — that's fine;
//      copy the full localhost URL from the browser's address bar (it carries
//      ?code=...) and paste it at the prompt.
//
// It exchanges the code, VERIFIES the refresh token by minting an access
// token with it, and prints the GMAIL_REFRESH_TOKEN line plus the exact
// Vercel steps. Scope requested: gmail.readonly (poller only reads).

import { config } from 'dotenv';
import http from 'node:http';
import crypto from 'node:crypto';
import readline from 'node:readline';
import process from 'node:process';

config({ path: '.env.local' });

const PORT = Number(process.env.GMAIL_OAUTH_PORT || 53682);
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const clientId = process.env.GMAIL_CLIENT_ID?.trim();
const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim();

if (!clientId || !clientSecret) {
  console.error(
    'GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET missing from .env.local.\n' +
      'Create an OAuth client first (see the PREREQS comment block at the top\n' +
      'of this script), add both values to .env.local, then re-run.',
  );
  process.exit(1);
}

const state = crypto.randomBytes(16).toString('hex');
const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString();

console.log('\n1. Open this URL in a browser signed into the [Creator Campaigns] inbox account:\n');
console.log(`   ${authUrl}\n`);
console.log(`2. Approve. Waiting for the redirect on ${REDIRECT_URI} ...`);
console.log('   (Headless/remote? Paste the full redirect URL — or just the code — below.)\n');

// Extract an auth code from raw pasted input: a full redirect URL, a
// querystring fragment, or the bare code itself.
function codeFromPaste(input) {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const pastedState = url.searchParams.get('state');
    if (pastedState && pastedState !== state) {
      console.error('   state mismatch on pasted URL — paste the URL from THIS run.');
      return null;
    }
    return url.searchParams.get('code');
  } catch {
    /* not a URL — fall through */
  }
  const m = raw.match(/code=([^&\s]+)/);
  if (m) return decodeURIComponent(m[1]);
  return raw; // assume bare code
}

// Race: localhost callback server vs pasted input. First code wins.
function waitForCode() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      server.close(() => {});
      rl.close();
      fn(value);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');
      if (err || !code || gotState !== state) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end('<h3>Creator Campaigns Gmail auth failed — check the terminal.</h3>');
        settle(reject, new Error(err ? `consent error: ${err}` : 'callback missing code or state mismatch'));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h3>Creator Campaigns Gmail auth complete — return to the terminal.</h3>');
      settle(resolve, code);
    });
    server.on('error', (e) => {
      console.error(`   callback server failed (${e.message}) — paste the redirect URL instead.`);
    });
    server.listen(PORT);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = () => {
      rl.question('Paste redirect URL / code (or just wait for the browser callback): ', (answer) => {
        const code = codeFromPaste(answer);
        if (code) settle(resolve, code);
        else if (!settled) prompt();
      });
    };
    prompt();
  });
}

const code = await waitForCode();
console.log('\nGot the auth code. Exchanging for tokens ...');

const tokenRes = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
  }).toString(),
});
const tokenJson = await tokenRes.json().catch(() => ({}));
if (!tokenRes.ok) {
  console.error(`Token exchange failed: HTTP ${tokenRes.status} ${JSON.stringify(tokenJson)}`);
  process.exit(1);
}
const refreshToken = tokenJson.refresh_token;
if (!refreshToken) {
  console.error(
    'No refresh_token in the response. Google only issues one on a FRESH\n' +
      'consent grant. Revoke this app at https://myaccount.google.com/permissions\n' +
      'and re-run this script.',
  );
  process.exit(1);
}

// Verify end-to-end: mint an access token with the refresh token (this is the
// exact call production makes). The access token itself is NOT printed.
const verifyRes = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  }).toString(),
});
const verifyJson = await verifyRes.json().catch(() => ({}));
if (verifyRes.ok && typeof verifyJson.access_token === 'string') {
  console.log('✓ refresh token verified — access token minted successfully (not shown).');
} else {
  console.error(`✗ verification exchange failed (HTTP ${verifyRes.status}). Token printed anyway; re-check before shipping.`);
}

// The refresh token is written straight to .env.local rather than printed.
// Printing it would persist a long-lived credential into terminal scrollback,
// shell history and any agent transcript driving this script.
{
  const envPath = '.env.local';
  const fs = await import('node:fs');
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `GMAIL_REFRESH_TOKEN=${refreshToken}`;
  const re = /^GMAIL_REFRESH_TOKEN=.*$/m;
  env = re.test(env)
    ? env.replace(re, line)
    : (env === '' || env.endsWith('\n') ? env + line + '\n' : env + '\n' + line + '\n');
  fs.writeFileSync(envPath, env, { mode: 0o600 });
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`✓ GMAIL_REFRESH_TOKEN written to ${envPath} (${refreshToken.length} chars, not shown).`);
  console.log('════════════════════════════════════════════════════════════');
}
console.log(`
Next steps:

  1. Nothing — .env.local now holds GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET
     and GMAIL_REFRESH_TOKEN.

  2. Push all three vars to Vercel production without echoing them:
       node tools/push-gmail-env.mjs production
     (reads .env.local and pipes each value straight into vercel env add,
     so no secret ever appears in a command line or in shell history).

  3. Remove any stale GMAIL_ACCESS_TOKEN from Vercel — the refresh path
     supersedes it:
       vercel env rm GMAIL_ACCESS_TOKEN production --yes

  4. Redeploy, then verify: the next negotiation tick's gmail tally should
     show fetched/ingested counts instead of skipped:'error'.
`);
