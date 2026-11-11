import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
//
// tests/opener-price.test.ts
//
// The real opener never names a price: openai.ts forbids it, and the fallback
// copy asks the creator for their rate. lastSentOffer still fell back to the
// row's initial_offer_usd when no counter had been sent, so "Sounds good, I'm
// in!" to an opener that asked "what do you charge?" was agreed as "Deal, $150
// works", a price the creator never saw.
//
// The rule: the AI may only auto-agree at a price that literally appeared in
// a message WE SENT. Unknown → a human.
//
// Hermetic: in-memory store, mock model provider, injected dispatch/clock/rng.
//
// Run: npx tsx tests/opener-price.test.ts

import { registerProvider } from '../src/lib/model-provider';
import { runNegotiationTick, runDispatchPass, COUNTER_OFFER_COLUMN, type DispatchFn } from '../src/lib/negotiation-tick';
import { lastSentOffer, PRICE_RECORD_MESSAGE_TYPE, PRICE_RECORD_STATUS } from '../src/lib/last-sent-offer';
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

type Out = { intent: string; counter_usd?: number | null };
let script: (user: string) => Out = () => ({ intent: 'unclear' });
registerProvider('mock', async ({ user }) =>
  JSON.stringify({ sentiment: 'neutral', confidence: 0.9, counter_usd: null, ...script(user) }),
);

/** The real opener shape: asks their rate, names no price. */
const NO_PRICE_OPENER =
  'Hi @x, I am writing from Example Records. We are putting paid promotion behind the new release. It is a paid collab. Tell me what you charge for that and I will come straight back with what we can do.';

type Store = ReturnType<typeof makeStore>;

function seed(store: Store, opener: string, init = 150, ceil = 600, openerUsd: number | null = null) {
  store.seed('firms', { id: 'firm-1', name: 'Example Records', sender_name: null, outreach_prefs: {}, scraping_prefs: {} });
  store.seedCampaign('camp-1', null);
  store.seed('influencers', { id: 'inf-1', blocklisted: false });
  store.seed('campaign_influencers', { id: 'ci-1', campaign_id: 'camp-1', influencer_id: 'inf-1' });
  store.seedOffer({
    id: 'offer-1', campaign_influencer_id: 'ci-1', campaign_id: 'camp-1', firm_id: 'firm-1',
    status: 'offered', initial_offer_usd: init, current_offer_usd: init, agreed_amount_usd: null,
    ceiling_usd: ceil, rounds: 0, last_message_id: null, approved_at: null, approved_by_user_id: null,
    paid_at: null, posted_at: null, post_url: null, autonomy_mode: 'auto', opening_pct: null,
    injection_flagged: false, created_at: '2026-07-06T00:00:00.000Z', updated_at: '2026-07-06T00:00:00.000Z',
  });
  store.seed('outreach_messages', {
    id: 'msg-first', campaign_influencer_id: 'ci-1', message_type: 'initial', direction: 'outbound',
    channel: 'email', subject: 'Collab', body: opener, status: 'sent',
    sent_at: '2026-07-05T15:00:00.000Z', send_after: null,
    ...(openerUsd != null ? { [COUNTER_OFFER_COLUMN]: openerUsd } : {}),
  });
}

function inbound(store: Store, id: string, body: string, at: number) {
  store.seed('inbound_messages', {
    id, channel: 'email', external_id: `sim:${id}`, creator_offer_id: null, campaign_influencer_id: 'ci-1',
    from_identity: 'sim', body, received_at: new Date(at).toISOString(), status: 'classified',
    classification: { classification: 'negotiating', confidence: 0.8 },
  });
}

function recorder(store: Store) {
  const sent: Array<{ type: string; body: string }> = [];
  const dispatch: DispatchFn = async (_sb, m) => {
    const r = store.all('outreach_messages').find((x) => x.id === m.id);
    sent.push({ type: String(r?.message_type), body: String(r?.body ?? '') });
    return { ok: true, provider_message_id: 'p', resolved_to: 't@x' };
  };
  return { sent, dispatch };
}

async function step(store: Store, dispatch: DispatchFn, id: string, body: string, out: Out, at: number) {
  inbound(store, id, body, at);
  script = () => out;
  await runNegotiationTick(store.sb, { now: at, rand: HALF, dispatch, pollGmail: noopPoll });
  for (let t = at; t <= at + 25 * MIN; t += MIN) await runDispatchPass(store.sb, { now: t, rand: HALF, dispatch });
}

const offerOf = (store: Store) => store.getOffer('offer-1') as Row;
const auths = (store: Store) => store.all('payment_authorizations').map((p) => Number(p.amount_usd));
const agreementSent = (sent: Array<{ type: string }>) => sent.some((s) => s.type === 'agreement_confirmation');

// ── A. The opener named no price: a bare yes is NOT agreed ───────────────────
async function bareYesToNoPriceOpener() {
  for (const reply of ["Sounds good, I'm in! Let's do it", 'Yes happy to do it for whatever your budget is']) {
    const store = makeStore();
    seed(store, NO_PRICE_OPENER);
    const { sent, dispatch } = recorder(store);
    const before = auditActions.length;
    await step(store, dispatch, 'i1', reply, { intent: 'accept', counter_usd: null }, NOW0);
    const o = offerOf(store);
    assert(o.agreed_amount_usd == null, `A: "${reply}" → nothing agreed (got ${o.agreed_amount_usd})`);
    assert(o.status === 'offered', `A: "${reply}" → offer stays offered (got ${o.status})`);
    assert(auths(store).length === 0, `A: "${reply}" → no payment authorization`);
    assert(!agreementSent(sent), `A: "${reply}" → no "Deal, $X works" email`);
    assert(
      auditActions.slice(before).includes('negotiation.accept_price_unclear'),
      `A: "${reply}" → escalated as accept_price_unclear`,
    );
    const inb = store.all('inbound_messages').find((r) => r.id === 'i1');
    assert(inb?.status === 'flagged', `A: "${reply}" → the reply is held for a human (got ${inb?.status})`);
  }
}

// ── B. Regression: the opener RECORDED $150, "Deal at $150" closes ──────────
// The price is the structured offer_usd on the sent opener, never
// its text. B2 below: the same text with nothing recorded escalates.
async function dealAtQuotedOpenerPrice() {
  const store = makeStore();
  seed(store, 'Hey, $150 for 1 reel + 1 story', 150, 600, 150);
  const { sent, dispatch } = recorder(store);
  await step(store, dispatch, 'i1', 'Deal at $150', { intent: 'accept', counter_usd: 150 }, NOW0);
  const o = offerOf(store);
  assert(Number(o.agreed_amount_usd) === 150, `B: "Deal at $150" after an opener quoting $150 → agreed $150 (got ${o.agreed_amount_usd})`);
  assert(auths(store).join() === '150', `B: authorization at $150 (got ${auths(store).join()})`);
  assert(agreementSent(sent), 'B: the agreement email goes');

  const s2 = makeStore();
  seed(s2, 'Hey, $150 for 1 reel + 1 story');
  const r2 = recorder(s2);
  await step(s2, r2.dispatch, 'i1', 'Deal at $150', { intent: 'accept', counter_usd: 150 }, NOW0);
  assert(offerOf(s2).agreed_amount_usd == null && !agreementSent(r2.sent), 'B2: "$150" only in the opener TEXT (nothing recorded) → not agreed');
}

// ── C. Regression: a sent counter, then "ok deal" closes at the counter ─────
async function dealAtSentCounter() {
  const store = makeStore();
  seed(store, NO_PRICE_OPENER, 100, 200);
  const { sent, dispatch } = recorder(store);
  await step(store, dispatch, 'i1', 'Can you come up to $300?', { intent: 'counter', counter_usd: 300 }, NOW0);
  const sentCounters = store.all('outreach_messages').filter((r) => r.message_type === 'counter' && r.status === 'sent');
  assert(sentCounters.length === 1, `C: the counter went (got ${sentCounters.length})`);
  const counterUsd = Number(sentCounters[0]?.[COUNTER_OFFER_COLUMN]);
  await step(store, dispatch, 'i2', 'ok deal', { intent: 'accept', counter_usd: null }, NOW0 + 60 * MIN);
  const o = offerOf(store);
  assert(Number(o.agreed_amount_usd) === counterUsd, `C: "ok deal" → agreed at the sent counter $${counterUsd} (got ${o.agreed_amount_usd})`);
  assert(agreementSent(sent), 'C: the agreement email goes');
}

// ── D. Regression: "$250?" after a counter is still a counter ───────────────
async function counterStillCounters() {
  const store = makeStore();
  seed(store, NO_PRICE_OPENER, 100, 200);
  const { dispatch } = recorder(store);
  await step(store, dispatch, 'i1', 'Can you come up to $300?', { intent: 'counter', counter_usd: 300 }, NOW0);
  await step(store, dispatch, 'i2', 'Can you do $250?', { intent: 'counter', counter_usd: 250 }, NOW0 + 60 * MIN);
  const o = offerOf(store);
  const sentCounters = store.all('outreach_messages').filter((r) => r.message_type === 'counter' && r.status === 'sent');
  assert(o.agreed_amount_usd == null && o.status === 'offered', `D: "$250?" → no agreement (status ${o.status})`);
  assert(sentCounters.length === 2, `D: "$250?" → a second counter went (got ${sentCounters.length})`);
}

// ── E. Pure: which messages count as having quoted a price ──────────────────
function pure() {
  const at = (h: number) => new Date(NOW0 + h * 3_600_000).toISOString();
  const msg = (over: Row) => ({ direction: 'outbound', status: 'sent', sent_at: at(0), ...over });
  assert(lastSentOffer([]).source === 'none' && lastSentOffer([]).usd === null, 'E: an empty thread → none (never the opening offer)');
  assert(
    lastSentOffer([msg({ message_type: 'initial', body: NO_PRICE_OPENER })]).usd === null,
    'E: an opener that asks their rate → unknown',
  );
  const quoted = lastSentOffer([msg({ message_type: 'initial', body: 'Hey, $150 for 1 reel + 1 story', [COUNTER_OFFER_COLUMN]: 150 })]);
  assert(quoted.usd === 150 && quoted.source === 'message', 'E: an opener that RECORDED $150 → $150');
  const textOnly = lastSentOffer([msg({ message_type: 'initial', body: 'Hey, $150 for 1 reel + 1 story' })]);
  assert(textOnly.usd === null && textOnly.source === 'none', 'E: "$150" only in an opener\'s text → none, never parsed');
  assert(
    lastSentOffer([msg({ message_type: 'initial', body: 'Hey, $150 for 1 reel + 1 story', status: 'queued' })]).usd === null,
    'E: a QUEUED opener never reached them → unknown',
  );
  assert(
    lastSentOffer([msg({ message_type: 'initial', body: 'Between $150 and $200 for a reel?' })]).usd === null,
    'E: an opener with two prices → unknown, not either one',
  );
  assert(
    lastSentOffer([
      msg({ message_type: 'initial', body: 'Hey, $150 for 1 reel + 1 story', [COUNTER_OFFER_COLUMN]: 150, sent_at: at(0) }),
      msg({ message_type: 'holding_note', body: "I'll reply in the next 15 minutes", sent_at: at(1) }),
    ]).usd === 150,
    'E: a later holding note quotes nothing; the opener price still stands',
  );
  assert(
    lastSentOffer([
      msg({ message_type: 'initial', body: 'Hey, $150 for 1 reel + 1 story', sent_at: at(0) }),
      msg({ message_type: 'counter', [COUNTER_OFFER_COLUMN]: 175, body: 'I can do $175', sent_at: at(2) }),
    ]).usd === 175,
    'E: a later sent counter wins',
  );
  assert(
    lastSentOffer([
      msg({ message_type: 'counter', [COUNTER_OFFER_COLUMN]: 175, sent_at: at(2) }),
      msg({ message_type: PRICE_RECORD_MESSAGE_TYPE, status: PRICE_RECORD_STATUS, [COUNTER_OFFER_COLUMN]: 190, sent_at: at(3) }),
    ]).usd === 190,
    'E: a later operator price record wins',
  );
  assert(
    lastSentOffer([
      msg({ message_type: PRICE_RECORD_MESSAGE_TYPE, status: PRICE_RECORD_STATUS, body: 'Price quoted outside Creator Campaigns: $190', sent_at: at(3) }),
    ]).source === 'unknown',
    'E: an operator price record without the 059 column is UNKNOWN, never read from its text',
  );
  assert(
    lastSentOffer([msg({ message_type: 'counter', sent_at: at(2) }), msg({ message_type: 'initial', body: '$150', sent_at: at(0) })]).usd === null,
    'E: the newest priced message is a counter with no recorded price → unknown, never the older opener',
  );
}

(async () => {
  console.warn = () => {};
  pure();
  await bareYesToNoPriceOpener();
  await dealAtQuotedOpenerPrice();
  await dealAtSentCounter();
  await counterStillCounters();
  console.log(`\nopener-price: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
