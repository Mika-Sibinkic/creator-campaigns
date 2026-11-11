import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
//
// tests/acceptance-modifiers.test.ts
//
// acceptanceGate only looked for per-unit / multiplier / add-on wording when
// the reply had a digit. "Deal if you double it", "ok deal, plus tax and fees
// on top" and "Deal, per video right?" name no number, so each was agreed at
// our last price. Only a clean, unconditional yes may auto-close.
//
// Run: npx tsx tests/acceptance-modifiers.test.ts

import { registerProvider } from '../src/lib/model-provider';
import { runNegotiationTick, runDispatchPass, COUNTER_OFFER_COLUMN, type DispatchFn } from '../src/lib/negotiation-tick';
import { acceptanceGate } from '../src/lib/stated-price';
import { makeStore, type Row } from './negotiation-harness/store';
import { auditActions } from './negotiation-harness/setup-env';

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

const NOW0 = Date.parse('2026-07-06T00:00:00.000Z');
const MIN = 60_000;
const HALF = () => 0.5;
const noopPoll = async () => ({ skipped: 'gmail_not_configured' as const });

type Out = { intent: string; counter_usd?: number | null; terms?: unknown };
let script: (user: string) => Out = () => ({ intent: 'unclear' });
registerProvider('mock', async ({ user }) =>
  JSON.stringify({ sentiment: 'neutral', confidence: 0.9, counter_usd: null, ...script(user) }),
);

type Store = ReturnType<typeof makeStore>;

function seed(store: Store) {
  store.seed('firms', { id: 'firm-1', name: 'Example Records', sender_name: null, outreach_prefs: {}, scraping_prefs: {} });
  store.seedCampaign('camp-1', null);
  store.seed('influencers', { id: 'inf-1', blocklisted: false });
  store.seed('campaign_influencers', { id: 'ci-1', campaign_id: 'camp-1', influencer_id: 'inf-1' });
  store.seedOffer({
    id: 'offer-1', campaign_influencer_id: 'ci-1', campaign_id: 'camp-1', firm_id: 'firm-1',
    status: 'offered', initial_offer_usd: 100, current_offer_usd: 100, agreed_amount_usd: null,
    ceiling_usd: 200, rounds: 0, last_message_id: null, approved_at: null, approved_by_user_id: null,
    paid_at: null, posted_at: null, post_url: null, autonomy_mode: 'auto', opening_pct: null,
    injection_flagged: false, created_at: '2026-07-06T00:00:00.000Z', updated_at: '2026-07-06T00:00:00.000Z',
  });
  store.seed('outreach_messages', {
    id: 'msg-first', campaign_influencer_id: 'ci-1', message_type: 'initial', direction: 'outbound',
    channel: 'email', subject: 'Collab', body: 'Hi, tell me what you charge for a reel and a story.', status: 'sent',
    sent_at: '2026-07-05T15:00:00.000Z', send_after: null,
  });
}

function inbound(store: Store, id: string, body: string, at: number) {
  store.seed('inbound_messages', {
    id, channel: 'email', external_id: `sim:${id}`, creator_offer_id: null, campaign_influencer_id: 'ci-1',
    from_identity: 'sim', body, received_at: new Date(at).toISOString(), status: 'classified',
    classification: { classification: 'negotiating', confidence: 0.8 },
  });
}

async function step(store: Store, dispatch: DispatchFn, id: string, body: string, out: Out, at: number) {
  inbound(store, id, body, at);
  script = () => out;
  await runNegotiationTick(store.sb, { now: at, rand: HALF, dispatch, pollGmail: noopPoll });
  for (let t = at; t <= at + 25 * MIN; t += MIN) await runDispatchPass(store.sb, { now: t, rand: HALF, dispatch });
}

/** The proof's runner: $300 ask (over the $200 ceiling) → our $150 counter
 *  goes → then `reply`. (The proof's $400 ceiling accepted the $300 ask on the
 *  first turn, so its second reply never reached the gate.) */
async function afterCounter(reply: string, out: Out) {
  const store = makeStore();
  seed(store);
  const sent: string[] = [];
  const dispatch: DispatchFn = async (_sb, m) => {
    sent.push(String(store.all('outreach_messages').find((x) => x.id === m.id)?.message_type));
    return { ok: true, provider_message_id: 'p', resolved_to: 't@x' };
  };
  await step(store, dispatch, 'i1', 'Can you come up to $300?', { intent: 'counter', counter_usd: 300 }, NOW0);
  const counter = store.all('outreach_messages').find((r) => r.message_type === 'counter' && r.status === 'sent');
  const before = auditActions.length;
  await step(store, dispatch, 'i2', reply, out, NOW0 + 60 * MIN);
  return { store, sent, counterUsd: Number(counter?.[COUNTER_OFFER_COLUMN]), escalations: auditActions.slice(before) };
}

async function modifiersEscalate() {
  for (const reply of ['Deal if you double it', 'ok deal, plus tax and fees on top', 'Deal, per video right?']) {
    const r = await afterCounter(reply, { intent: 'accept', counter_usd: null });
    const o = r.store.getOffer('offer-1') as Row;
    assert(o.agreed_amount_usd == null, `"${reply}" → nothing agreed (got ${o.agreed_amount_usd})`);
    assert(r.store.all('payment_authorizations').length === 0, `"${reply}" → no payment authorization`);
    assert(!r.sent.includes('agreement_confirmation'), `"${reply}" → no agreement email`);
    assert(r.escalations.includes('negotiation.accept_price_unclear'), `"${reply}" → escalated as accept_price_unclear`);
    const inb = r.store.all('inbound_messages').find((x) => x.id === 'i2');
    assert(inb?.status === 'flagged', `"${reply}" → held for a human (got ${inb?.status})`);
  }
}

async function cleanYesStillCloses() {
  for (const reply of ['ok deal', 'Deal!', "Sounds great, I'm in. Let's do it", 'I would love to, deal']) {
    const r = await afterCounter(reply, { intent: 'accept', counter_usd: null });
    const o = r.store.getOffer('offer-1') as Row;
    assert(Number(o.agreed_amount_usd) === r.counterUsd, `"${reply}" → agreed at the sent counter $${r.counterUsd} (got ${o.agreed_amount_usd})`);
    assert(r.sent.includes('agreement_confirmation'), `"${reply}" → the agreement email goes`);
  }
  const r = await afterCounter(`Deal at $150`, { intent: 'accept', counter_usd: 150 });
  const o = r.store.getOffer('offer-1') as Row;
  assert(r.counterUsd === 150 && Number(o.agreed_amount_usd) === 150, `"Deal at $150" after a sent $150 → agreed $150 (got ${o.agreed_amount_usd})`);
}

/** A qualified yes that proposes a package may COUNTER through the term trade
 * , but never auto-close, even when the package is worth more. */
async function qualifiedYesWithPackageNeverCloses() {
  const reply = "Deal, but I'll make the reel a full minute instead";
  const r = await afterCounter(reply, {
    intent: 'accept', counter_usd: null,
    terms: { quantity: 1, promo_type: 'reel', min_seconds: 60, schedule_note: null },
  });
  const o = r.store.getOffer('offer-1') as Row;
  assert(o.agreed_amount_usd == null, `"${reply}" → nothing agreed (got ${o.agreed_amount_usd}, status ${o.status})`);
  assert(r.store.all('payment_authorizations').length === 0, `"${reply}" → no payment authorization`);
  assert(!r.sent.includes('agreement_confirmation'), `"${reply}" → no agreement email`);
  assert(
    r.escalations.includes('negotiation.accept_price_unclear') || r.escalations.includes('negotiation.out_of_spec_flagged'),
    `"${reply}" → a human decides (got ${r.escalations.join(', ')})`,
  );
}

function pureGate() {
  const no = [
    'Deal if you double it', 'ok deal, plus tax and fees on top', 'Deal, per video right?',
    'Deal at twice that', 'Triple it and we have a deal', 'Deal, half now', 'Deal, plus shipping',
    'Deal, with a little extra on top', 'Yes, $150 each', 'deal, every post', 'Deal, only if I keep the rights',
    'Deal as long as it is paid upfront', 'Deal but I need a week more', 'Deal, except the story',
    'Yes, assuming you cover travel', 'Deal, provided the song is clean', 'Deal?', 'ok deal unless the date moves',
    'Sounds good, though I would want a bonus', 'Probably yes', 'Deal, conditional on approval',
  ];
  for (const t of no) {
    const g = acceptanceGate(t, 150);
    assert(!g.ok, `pure: "${t}" → not a clean yes (got ${JSON.stringify(g)})`);
  }
  const yes = ['ok deal', 'Deal!', "Sounds good, I'm in!", 'Deal at $150', 'Yes, $150 works', 'I would love to', 'Perfect, let us do it.'];
  for (const t of yes) {
    const g = acceptanceGate(t, 150);
    assert(g.ok, `pure: "${t}" → clean yes (got ${JSON.stringify(g)})`);
  }
  // Our own quoted text does not count against the creator's yes.
  assert(acceptanceGate('Deal!\n\n> Can you do $150 per video?', 150).ok, 'pure: a "?" or "per" in quoted history is not theirs');
}

(async () => {
  console.warn = () => {};
  pureGate();
  await modifiersEscalate();
  await cleanYesStillCloses();
  await qualifiedYesWithPackageNeverCloses();
  console.log(`\nacceptance-modifiers: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
