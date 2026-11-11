// tests/payout-email.test.ts
//
// The creator payout-onboarding email (src/lib/payout-email.ts) and the
// multipart send path it rides on (src/lib/resend.ts sendOutreach).
//
// Pins:
//   1. The HTML has exactly one link — the button — and its href is the stable
//      /api/payout/onboard/<id> redirect. No images, scripts, external CSS,
//      web fonts or any other URL.
//   2. The text part is always present and keeps the URL on its own line.
//   3. HTML is derived only from a body that round-trips through the template;
//      edited or pre-template bodies go out text-only.
//   4. sendOutreach: the testing-mode recipient redirect applies to the HTML
//      send unchanged, and every non-payout message stays text-only.
//   5. Both production send paths actually pass message_type (who calls this?).
//   6. Snapshot: tests/fixtures/payout-email/payout-email.html. Regenerate with
//      UPDATE_SNAPSHOT=1 after a deliberate copy/design change.
//
// Hermetic: sendOutreach runs against an in-memory firms table, a capturing
// Resend stub and a no-op audit. No env, no network.
//
// Run: npx tsx tests/payout-email.test.ts

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  PAYOUT_ONBOARDING_MESSAGE_TYPE,
  isOnboardUrl,
  outboundHtmlFor,
  parsePayoutOnboardingText,
  payoutOnboardingHtml,
  payoutOnboardingSubject,
  payoutOnboardingText,
  type PayoutEmailFields,
} from '../src/lib/payout-email';
import type { SendDeps } from '../src/lib/resend';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

const URL = 'https://app.example.com/api/payout/onboard/7c1e2f4a-93b0-4d8e-a1f2-5b6c7d8e9f01';
const FIELDS: PayoutEmailFields = {
  handle: 'maya.sings_example',
  amountUsd: 1250,
  artistName: 'Sample Single',
  onboardUrl: URL,
  termsSentence:
    "Collecting this payment confirms you're in for the agreed deliverables, per the agreement terms sent with your acceptance email on September 28, 2026.",
  signoff: 'Example Records',
};

const text = payoutOnboardingText(FIELDS);
const html = payoutOnboardingHtml(FIELDS);

// ── 1. HTML: one button link, the stable URL, nothing external ──────────────
{
  const anchors = html.match(/<a\b[^>]*>/gi) ?? [];
  assert(anchors.length === 1, `html: exactly one <a> (got ${anchors.length})`);
  const href = /href="([^"]*)"/.exec(anchors[0] ?? '')?.[1];
  assert(href === URL, 'html: the one link is the stable onboard URL');
  assert(/>Set up payout<\/a>/.test(html), 'html: the button reads "Set up payout"');

  const urls = html.match(/https?:\/\/[^\s"<>]+/gi) ?? [];
  assert(urls.length > 0 && urls.every((u) => u === URL), 'html: the only URL anywhere is the onboard URL');
  for (const [re, what] of [
    [/<img\b/i, '<img>'],
    [/<script\b/i, '<script>'],
    [/<link\b/i, '<link>'],
    [/<style\b/i, '<style> block (inline CSS only)'],
    [/<iframe\b|<form\b|<video\b|<object\b/i, 'embedded content'],
    [/background(-image)?\s*:\s*url\(/i, 'background image'],
    [/@import|@font-face/i, 'web font / import'],
    [/\bon[a-z]+\s*=/i, 'inline event handler'],
    [/javascript:/i, 'javascript: URL'],
    [/display\s*:\s*none/i, 'hidden text'],
  ] as const) {
    assert(!re.test(html), `html: no ${what}`);
  }
  assert(/max-width:600px/.test(html), 'html: single 600px column');
  assert(/background-color:#ffffff/.test(html), 'html: white background');
  assert(/bgcolor="#111827"/.test(html), 'html: button cell carries bgcolor (Outlook)');

  for (const s of [
    'Hi @maya.sings_example,',
    'Your $1,250 payment for the Sample Single collab is ready.',
    'Payouts are handled securely by Stripe. Takes about 2 minutes.',
    'agreement terms sent with your acceptance email on September 28, 2026.',
    'Thanks,<br>Example Records',
  ]) {
    assert(html.includes(s.replace(/'/g, '&#39;')), `html: contains "${s}"`);
  }
  // The fallback URL is plain text under the button, not a second link.
  assert(
    html.indexOf('Set up payout</a>') < html.lastIndexOf(URL),
    'html: the plain fallback URL sits under the button',
  );
}

// ── 2. Copy hygiene (both parts) ────────────────────────────────────────────
{
  const visible = html.replace(/<[^>]+>/g, ' ');
  for (const [label, body] of [['text', text], ['html', visible]] as const) {
    assert(!/!{2,}/.test(body), `${label}: no "!!"`);
    assert(!/\b(free|act now|urgent|winner|guaranteed|click here)\b/i.test(body), `${label}: no spam-trigger words`);
    const caps = body.match(/\b[A-Z]{4,}\b/g) ?? [];
    assert(caps.length === 0, `${label}: no ALL-CAPS words (got ${caps.join(',')})`);
  }
}

// ── 3. Text part: URL on its own line, fields present ───────────────────────
{
  const lines = text.split('\n');
  assert(lines.includes(URL), 'text: the onboard URL is on its own line');
  assert(lines[0] === 'Hi @maya.sings_example,', 'text: greets the creator by handle');
  assert(lines.at(-1) === 'Example Records' && lines.at(-2) === 'Thanks,', 'text: signed by the sender');
  assert(text.includes('Payouts are handled securely by Stripe. Takes about 2 minutes.'), 'text: Stripe line');
  assert(text.includes(FIELDS.termsSentence), 'text: agreement-terms sentence kept');
  assert(
    payoutOnboardingSubject('Sample Single') === 'Set up your payout for the Sample Single collab',
    'subject: unchanged from the pre-HTML email',
  );
  const noHandle = payoutOnboardingText({ ...FIELDS, handle: null, signoff: 'your campaign team' });
  assert(noHandle.startsWith('Hi there,\n'), 'text: no handle → "Hi there,"');
  assert(noHandle.endsWith('\nYour campaign team'), 'text: sign-off is capitalised');
}

// ── 4. Round trip: HTML only for a body the template produced ───────────────
{
  const parsed = parsePayoutOnboardingText(text);
  assert(parsed !== null && JSON.stringify(parsed) === JSON.stringify(FIELDS), 'parse: canonical body round-trips');
  assert(outboundHtmlFor(PAYOUT_ONBOARDING_MESSAGE_TYPE, text) === html, 'outboundHtmlFor: payout body → the same HTML');

  const nohandle = payoutOnboardingText({ ...FIELDS, handle: null });
  assert(parsePayoutOnboardingText(nohandle)?.handle === null, 'parse: "Hi there," → handle null');

  // An operator edit to a field value is carried into the HTML (it says what the text says).
  const editedAmount = text.replace('$1,250', '$1,300');
  assert(
    outboundHtmlFor(PAYOUT_ONBOARDING_MESSAGE_TYPE, editedAmount)?.includes('Your $1,300 payment') === true,
    'parse: an edited amount shows in the HTML too',
  );
  // An edit that breaks the template → text-only.
  assert(
    outboundHtmlFor(PAYOUT_ONBOARDING_MESSAGE_TYPE, text.replace('Thanks,', 'Cheers,')) === null,
    'parse: structural edit → no HTML',
  );
  assert(
    outboundHtmlFor(PAYOUT_ONBOARDING_MESSAGE_TYPE, text + '\nP.S. extra line') === null,
    'parse: appended text → no HTML',
  );
  // A different URL in the button slot is refused.
  const foreign = text.replace(URL, 'https://bit.ly/abc123');
  assert(outboundHtmlFor(PAYOUT_ONBOARDING_MESSAGE_TYPE, foreign) === null, 'parse: non-onboard URL → no HTML');
  assert(!isOnboardUrl('https://x.test/api/payout/onboard/abc"><script>'), 'isOnboardUrl: markup rejected');
  let threw = false;
  try {
    payoutOnboardingHtml({ ...FIELDS, onboardUrl: 'https://evil.test/x' });
  } catch {
    threw = true;
  }
  assert(threw, 'payoutOnboardingHtml: refuses a non-onboard URL');

  // The pre-template body (rows queued before this change) stays text-only.
  const legacy = [
    "You're in on the Sample Single campaign — one quick step to get paid.",
    '',
    `Set up your payout here (takes ~2 minutes): ${URL}`,
    '',
    "Once that's done your $1250 payment goes out automatically.",
  ].join('\n');
  assert(outboundHtmlFor(PAYOUT_ONBOARDING_MESSAGE_TYPE, legacy) === null, 'legacy payout body → text-only');

  // Other message types never get HTML, even with a payout-shaped body.
  for (const t of ['initial', 'follow_up', 'holding_note', 'negotiation', 'promo_materials', null, undefined]) {
    assert(outboundHtmlFor(t, text) === null, `outboundHtmlFor(${String(t)}) → null`);
  }

  // Escaping: free-text fields cannot inject markup.
  const nasty = payoutOnboardingHtml({ ...FIELDS, artistName: 'A<b>&"C', signoff: '<script>x</script>' });
  assert(!nasty.includes('<b>') && nasty.includes('A&lt;b&gt;&amp;&quot;C'), 'html: artist name escaped');
  assert(!/<script/i.test(nasty), 'html: signoff escaped');
}

// ── 5. sendOutreach: multipart, testing-mode redirect unchanged ─────────────
type Payload = Record<string, unknown>;

function deps(firm: Record<string, unknown>): { deps: SendDeps; sent: Payload[] } {
  const sent: Payload[] = [];
  const query = (row: unknown) => {
    const q = {
      select: () => q,
      eq: () => q,
      single: async () => ({ data: row, error: row ? null : { message: 'none' } }),
      maybeSingle: async () => ({ data: null, error: null }),
    };
    return q;
  };
  return {
    sent,
    deps: {
      sb: { from: ((t: string) => query(t === 'firms' ? firm : null)) as never },
      resend: {
        emails: {
          send: (async (p: Payload) => {
            sent.push(p);
            return { data: { id: `re_${sent.length}` }, error: null, headers: null };
          }) as never,
        },
      },
      audit: async () => {},
    },
  };
}

const FIRM = {
  name: 'Example Records',
  sender_email: 'hello@operator.example',
  sender_name: 'Example Records',
  negotiation_inbox_email: null,
};

async function sendTests() {
  // Placeholders for supabaseAdmin(); the stubbed deps mean nothing dials out.
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:9';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-dummy';
  const { sendOutreach } = await import('../src/lib/resend');

  // Testing mode: HTML goes to the firm's test recipient, never the creator.
  {
    const d = deps({ ...FIRM, testing_mode: true, test_recipient_email: 'tester@operator.example' });
    const r = await sendOutreach(
      {
        firm_id: 'firm-1',
        to_real: 'maya@creator.test',
        subject: payoutOnboardingSubject('Sample Single'),
        body: text,
        message_type: PAYOUT_ONBOARDING_MESSAGE_TYPE,
        campaign_influencer_id: '3f9c2a1e-7b4d-4e0a-9c66-2d8f5b1a0c3e',
      },
      d.deps,
    );
    const p = d.sent[0] ?? {};
    assert(r.ok && r.test_mode, 'send(testing): ok, test_mode');
    assert(p.to === 'tester@operator.example' && r.resolved_to === 'tester@operator.example', 'send(testing): redirected to the test recipient');
    assert(!JSON.stringify(p).includes('maya@creator.test'), 'send(testing): the creator address appears nowhere in the payload');
    assert(p.text === text, 'send(testing): text part is the stored body');
    assert(p.html === html, 'send(testing): html part is the derived template');
    assert(String(p.subject).startsWith('[Creator Campaigns] '), 'send(testing): subject tag still applied');
  }
  // Testing mode with no recipient configured: refuses, sends nothing.
  {
    const prev = process.env.TEST_RECIPIENT_EMAIL;
    delete process.env.TEST_RECIPIENT_EMAIL;
    const d = deps({ ...FIRM, testing_mode: true, test_recipient_email: null });
    const r = await sendOutreach(
      { firm_id: 'firm-1', to_real: 'maya@creator.test', subject: 's', body: text, message_type: PAYOUT_ONBOARDING_MESSAGE_TYPE },
      d.deps,
    );
    if (prev !== undefined) process.env.TEST_RECIPIENT_EMAIL = prev;
    assert(!r.ok && r.error === 'no_test_recipient' && d.sent.length === 0, 'send(testing, no recipient): nothing sent');
  }
  // Live mode: HTML goes to the creator, subject untagged.
  {
    const d = deps({ ...FIRM, testing_mode: false, test_recipient_email: 'tester@operator.example' });
    await sendOutreach(
      { firm_id: 'firm-1', to_real: 'maya@creator.test', subject: 'S', body: text, message_type: PAYOUT_ONBOARDING_MESSAGE_TYPE },
      d.deps,
    );
    const p = d.sent[0] ?? {};
    assert(p.to === 'maya@creator.test' && p.html === html && p.subject === 'S', 'send(live): creator gets text + html');
  }
  // Non-payout messages: byte-identical text-only payload, no html key at all.
  for (const message_type of ['initial', 'follow_up', 'holding_note', undefined]) {
    const d = deps({ ...FIRM, testing_mode: true, test_recipient_email: 'tester@operator.example' });
    await sendOutreach(
      { firm_id: 'firm-1', to_real: null, subject: 'Collab?', body: 'Hi — quick idea.\n\nReply STOP to opt out.', message_type },
      d.deps,
    );
    const p = d.sent[0] ?? {};
    assert(!('html' in p) && p.text === 'Hi — quick idea.\n\nReply STOP to opt out.', `send(${String(message_type)}): text-only, body unchanged`);
  }
  // Payout type with a body that no longer matches the template → text-only.
  {
    const d = deps({ ...FIRM, testing_mode: true, test_recipient_email: 'tester@operator.example' });
    await sendOutreach(
      { firm_id: 'firm-1', to_real: null, subject: 'S', body: text.replace('Thanks,', 'Cheers,'), message_type: PAYOUT_ONBOARDING_MESSAGE_TYPE },
      d.deps,
    );
    assert(!('html' in (d.sent[0] ?? {})), 'send(payout, edited body): text-only');
  }
}

// ── 6. Wiring: both production send paths pass message_type ─────────────────
{
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  const route = src('src/app/api/outreach/[id]/send/route.ts');
  assert(/message_type:\s*claimed\.message_type/.test(route), 'wiring: manual Send route passes the claimed message_type');
  const tick = src('src/lib/negotiation-tick.ts');
  assert(/message_type:\s*sending\.message_type/.test(tick), 'wiring: dispatch pass hands the claimed message_type to dispatch');
  assert(/message_type:\s*msg\.message_type/.test(tick), 'wiring: realDispatch passes message_type to sendOutreach');
  const exec = src('src/lib/execute-payment.ts');
  assert(/body:\s*payoutOnboardingText\(/.test(exec), 'wiring: execute-payment queues the template body');
  assert(/message_type:\s*PAYOUT_ONBOARDING_MESSAGE_TYPE/.test(exec), 'wiring: execute-payment stamps the payout type');
  const claim = src('src/lib/outbound-claim.ts');
  assert(/CLAIM_COLUMNS[\s\S]{0,200}message_type/.test(claim), 'wiring: the claim RETURNING includes message_type');
}

// ── 7. Snapshot ─────────────────────────────────────────────────────────────
{
  const dir = join(__dirname, 'fixtures', 'payout-email');
  const file = join(dir, 'payout-email.html');
  if (process.env.UPDATE_SNAPSHOT === '1') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, html + '\n');
    console.log(`  snapshot written: ${file}`);
  }
  let snap = '';
  try {
    snap = readFileSync(file, 'utf8');
  } catch {
    /* missing fixture fails below */
  }
  assert(snap === html + '\n', 'snapshot: html matches tests/fixtures/payout-email/payout-email.html');
}

sendTests().then(() => {
  console.log(`\npayout-email: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
});
