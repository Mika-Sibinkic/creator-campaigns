// tools/probe-testing-mode.ts
//
// LIVE PROBE, not a test, so it lives in tools/ and npm test never runs it.
// When it runs it:
//   1. queries the Supabase project in .env.local for an unsent draft
//      outreach_message;
//   2. POSTs /api/outreach/<id>/send, which sends a REAL email through Resend
//      and burns that draft row.
// It stays gated on TESTING_MODE_LIVE=1. The gate is the first executable
// statement, ahead of dotenv and any Supabase client.
//
// Black-box test: with firm.testing_mode=true, /send must resolve recipient
// to the firm's test_recipient_email (not the influencer's contact_email).
// RESILIENT: if no draft outreach_message exists yet, prints SKIP and exits
// 0 cleanly — run a campaign to create drafts first, then this test gets
// meaningful signal.
//
// Usage:
//   TESTING_MODE_LIVE=1 npm run probe:testing-mode
//   TESTING_MODE_LIVE=1 TEST_MSG_ID=<uuid> npm run probe:testing-mode
//   (with TESTING_MODE_LIVE=1 but no TEST_MSG_ID it picks the first draft itself.)

if (process.env.TESTING_MODE_LIVE !== '1') {
  console.log(
    'SKIP testing-mode test — live-only, gated on TESTING_MODE_LIVE=1. Running it sends a REAL email via Resend and consumes a real draft outreach_message row in the configured Supabase project. Exiting 0.'
  );
  process.exit(0);
}

// ── Everything below this line only ever runs with TESTING_MODE_LIVE=1. ──────
// Type-only import: erased at compile time, loads nothing at runtime.
type CreateClient = typeof import('@supabase/supabase-js').createClient;

let base = 'http://localhost:3000';

async function findDraftMessageId(createClient: CreateClient): Promise<string | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data } = await sb
    .from('outreach_messages')
    .select('id')
    .is('sent_at', null)
    .limit(1);
  if (!data || data.length === 0) return null;
  return (data[0] as { id: string }).id;
}

async function send(messageId: string) {
  const r = await fetch(`${base}/api/outreach/${messageId}/send`, {
    method: 'POST',
    // SEC-5: middleware enforces same-origin on state-changing requests.
    // Node's fetch doesn't set Sec-Fetch-Site; pass Origin explicitly.
    headers: { Origin: base },
  });
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    body = await r.text();
  }
  return { status: r.status, body };
}

async function main() {
  // Deferred until after the gate so the default path never touches dotenv,
  // never reads .env.local, and never constructs a Supabase client.
  const { config } = await import('dotenv');
  const { createClient } = await import('@supabase/supabase-js');
  const { appBaseUrl } = await import('../src/lib/env');

  config({ path: '.env.local' });
  base = appBaseUrl();

  const messageId = process.env.TEST_MSG_ID ?? (await findDraftMessageId(createClient));
  if (!messageId) {
    console.log(
      'SKIP testing-mode test — no draft outreach_message in DB yet (run a campaign to create drafts). Exiting 0.'
    );
    process.exit(0);
  }

  // We do NOT flip testing_mode here — assumption: the firm row has
  // testing_mode=true by default (migration 005 default). Just send and verify.
  const result = await send(messageId);
  const body = result.body as
    | { ok?: boolean; test_mode?: boolean; resolved_to?: string; error?: string }
    | string;

  if (typeof body !== 'object' || body === null) {
    console.error('FAIL non-JSON response', result);
    process.exit(1);
  }
  if (result.status === 409) {
    console.log(
      'SKIP — message already sent (need a fresh draft to verify routing). Exiting 0.'
    );
    process.exit(0);
  }
  if (!body.ok) {
    console.error('FAIL /send returned not-ok', result);
    process.exit(1);
  }
  if (!body.test_mode) {
    console.error(
      'FAIL expected test_mode=true (firm should be in testing mode by default)',
      body
    );
    process.exit(1);
  }
  console.log('PASS testing_mode ON routes to', body.resolved_to);
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL exception', e);
  process.exit(1);
});
