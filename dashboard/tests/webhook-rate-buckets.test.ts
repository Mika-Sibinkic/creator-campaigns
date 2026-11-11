// tests/webhook-rate-buckets.test.ts
//
// Resend sends delivery-status events and inbound creator replies from the
// same sender IPs. A burst of status events must not rate-limit the next
// inbound reply. Calls the real route handlers; both reject unsigned requests
// before touching the database, so no env or network is needed.
//
// Run: npx tsx tests/webhook-rate-buckets.test.ts

export {}; // a module, so main() does not clash with other scripts' globals

delete process.env.RESEND_WEBHOOK_SECRET;
delete process.env.RESEND_INBOUND_WEBHOOK_SECRET;

const IP = '44.228.126.217';
const post = (path: string) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'x-forwarded-for': IP, 'content-type': 'application/json' },
    body: '{}',
  });

async function main() {
  const status = await import('../src/app/api/webhooks/resend/route');
  const inbound = await import('../src/app/api/webhooks/inbound-email/route');

  const codes: number[] = [];
  for (let i = 0; i < 40; i++) codes.push((await status.POST(post('/api/webhooks/resend'))).status);
  const after = (await inbound.POST(post('/api/webhooks/inbound-email'))).status;

  const failures: string[] = [];
  if (codes.includes(429)) failures.push(`status webhook returned 429 within 40 calls: ${codes.join(',')}`);
  if (after === 429) failures.push('inbound-email returned 429 after 40 status events from the same IP');
  if (after !== 401) failures.push(`inbound-email unsigned request: expected 401, got ${after}`);

  if (failures.length) {
    for (const f of failures) console.error(`  ✗ FAIL: ${f}`);
    process.exit(1);
  }
  console.log(`✓ 40 status events, then inbound-email still ${after} (not 429)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
