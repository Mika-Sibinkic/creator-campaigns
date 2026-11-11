import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
//
// tests/structured-sent-price.test.ts
//
// The root cause across four rounds: reading prices out of free text WE sent.
//   - "The new single drops October 24" in the opener → "Deal, $24 works"
//   - a firm named "Studio 54" signing the holding note → "Deal, $54 works"
// The last sent price now comes ONLY from outreach_messages.offer_usd on sent
// rows, written when the system or a human explicitly quotes a price. Nothing
// structured → unknown → no auto-agree, a human decides.
//
// Normal flows are pinned alongside: an AI counter of $175 then "deal" closes
// at $175; "Deal at $150" against a structured $150 closes; "$250?" counters.
//
// Hermetic: in-memory store, mock model provider, injected dispatch/clock/rng.
//
// Run: npx tsx tests/structured-sent-price.test.ts

import { registerProvider } from '../src/lib/model-provider';
import { runNegotiationTick, runDispatchPass, COUNTER_OFFER_COLUMN, type DispatchFn } from '../src/lib/negotiation-tick';
import { lastSentOffer, readLastSentOffers, manualQuotedPayload } from '../src/lib/last-sent-offer';
import { recordManualQuotedPrice } from '../src/lib/counter-edit';
import { HOLDING_NOTE_MESSAGE_TYPE } from '../src/lib/holding-note';
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

const MIN = 60_000;
const HALF = () => 0.5;
const noopPoll = async () => ({ skipped: 'gmail_not_configured' as const });

type Out = { intent: string; counter_usd?: number | null };
let script: (user: string) => Out = () => ({ intent: 'unclear' });
registerProvider('mock', async ({ user }) =>
  JSON.stringify({ sentiment: 'neutral', confidence: 0.9, counter_usd: null, ...script(user) }),
);

type Store = ReturnType<typeof makeStore>;

const DATE_OPENER =
  "Hi @x, I'm with Example Records. The new single drops October 24 and we'd love a paid collab with you. What do you charge for one reel?";
const TITLE_OPENER = "Hi @x, I'm with Example Records. We're promoting 'Room 214', the new single. Paid collab, what would you charge?";
const PLAIN_OPENER = 'Hi @x, I am writing from Example Records. Paid collab. Tell me what you charge.';

function seed(
  store: Store,
  o: { firmName?: string; opener?: string; openerUsd?: number | null; init?: number; ceil?: number } = {},
) {
  const init = o.init ?? 150;
  store.seed('firms', { id: 'firm-1', name: o.firmName ?? 'Example Records', sender_name: null, outreach_prefs: {}, scraping_prefs: {} });
  store.seedCampaign('camp-1', null);
  store.seed('influencers', { id: 'inf-1', blocklisted: false });
  store.seed('campaign_influencers', { id: 'ci-1', campaign_id: 'camp-1', influencer_id: 'inf-1' });
  store.seedOffer({
    id: 'offer-1', campaign_influencer_id: 'ci-1', campaign_id: 'camp-1', firm_id: 'firm-1',
    status: 'offered', initial_offer_usd: init, current_offer_usd: init, agreed_amount_usd: null,
    ceiling_usd: o.ceil ?? 250, rounds: 0, last_message_id: null, approved_at: null, approved_by_user_id: null,
    paid_at: null, posted_at: null, post_url: null, autonomy_mode: 'auto', opening_pct: null,
    injection_flagged: false, created_at: '2026-07-06T00:00:00.000Z', updated_at: '2026-07-06T00:00:00.000Z',
  });
  store.seed('outreach_messages', {
    id: 'msg-first', campaign_influencer_id: 'ci-1', message_type: 'initial', direction: 'outbound',
    channel: 'email', subject: 'Collab', body: o.opener ?? PLAIN_OPENER, status: 'sent',
    sent_at: '2026-07-05T15:00:00.000Z', send_after: null,
    ...(o.openerUsd != null ? { [COUNTER_OFFER_COLUMN]: o.openerUsd } : {}),
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

const tick = (store: Store, at: number, dispatch: DispatchFn) =>
  runNegotiationTick(store.sb, { now: at, rand: HALF, dispatch, pollGmail: noopPoll });
async function drain(store: Store, from: number, to: number, dispatch: DispatchFn) {
  for (let t = from; t <= to; t += MIN) await runDispatchPass(store.sb, { now: t, rand: HALF, dispatch });
}
async function step(store: Store, dispatch: DispatchFn, id: string, body: string, out: Out, at: number) {
  inbound(store, id, body, at);
  script = () => out;
  await tick(store, at, dispatch);
  await drain(store, at, at + 25 * MIN, dispatch);
}

const offerOf = (store: Store) => store.getOffer('offer-1') as Row;
const auths = (store: Store) => store.all('payment_authorizations').map((p) => Number(p.amount_usd));
const agreementSent = (sent: Array<{ type: string }>) => sent.some((s) => s.type === 'agreement_confirmation');
const dollars = (s: string) => [...s.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));

/**
 * The reviewer's fold scenario:
 * "$300?" → holding note + counter queued; dispatch until ONLY the note has
 * gone; then "Sounds good!" (model: accept) folds the queued counter.
 */
async function foldAfterNote(o: { firmName?: string; opener?: string }) {
  const NOW0 = Date.parse('2026-07-06T15:00:00.000Z');
  const store = makeStore();
  seed(store, o);
  const { sent, dispatch } = recorder(store);
  inbound(store, 'i1', 'Can you do $300?', NOW0);
  script = () => ({ intent: 'counter', counter_usd: 300 });
  await tick(store, NOW0, dispatch);
  let t = NOW0;
  for (; t <= NOW0 + 40 * MIN; t += MIN) {
    await runDispatchPass(store.sb, { now: t, rand: HALF, dispatch });
    if (store.all('outreach_messages').some((r) => r.message_type === HOLDING_NOTE_MESSAGE_TYPE && r.status === 'sent')) break;
  }
  const noteWent = store.all('outreach_messages').some((r) => r.message_type === HOLDING_NOTE_MESSAGE_TYPE && r.status === 'sent');
  const counterQueued = store.all('outreach_messages').some((r) => r.message_type === 'counter' && r.status === 'queued');
  const before = auditActions.length;
  inbound(store, 'i2', 'Sounds good!', t + MIN);
  script = () => ({ intent: 'accept', counter_usd: null });
  await tick(store, t + MIN, dispatch);
  await drain(store, t + MIN, t + 40 * MIN, dispatch);
  return { store, sent, noteWent, counterQueued, audits: auditActions.slice(before) };
}

// ── A. "drops October 24" is not $24 ────────────────
async function openerDateIsNotAPrice() {
  const r = await foldAfterNote({ opener: DATE_OPENER });
  assert(r.noteWent && r.counterQueued, 'A setup: the holding note went, the counter is still queued');
  const o = offerOf(r.store);
  assert(o.agreed_amount_usd == null, `A: "Sounds good!" after an opener saying "October 24" → nothing agreed (got ${o.agreed_amount_usd})`);
  assert(o.status === 'offered', `A: the offer stays offered (got ${o.status})`);
  assert(!agreementSent(r.sent), 'A: no "Deal, $X works" goes out');
  assert(!r.sent.some((s) => dollars(s.body).includes(24)), 'A: no message ever names $24');
  assert(auths(r.store).length === 0, 'A: no payment authorization');
  assert(Number(o.current_offer_usd) !== 24, `A: the standing offer never becomes the parsed $24 (got ${o.current_offer_usd})`);
  assert(r.audits.includes('negotiation.accept_price_unclear'), `A: escalated as accept_price_unclear (got ${r.audits})`);
  assert(r.store.all('inbound_messages').find((x) => x.id === 'i2')?.status === 'flagged', 'A: the reply is held for a human');
}

// ── B. firm "Studio 54" is not $54 ──────────────────────
async function signoffNameIsNotAPrice() {
  const r = await foldAfterNote({ firmName: 'Studio 54' });
  const note = r.store.all('outreach_messages').find((x) => x.message_type === HOLDING_NOTE_MESSAGE_TYPE && x.status === 'sent');
  assert(/Studio 54/.test(String(note?.body ?? '')), 'B setup: the sent holding note is signed "Studio 54"');
  const o = offerOf(r.store);
  assert(o.agreed_amount_usd == null, `B: "Sounds good!" after a note signed "Studio 54" → nothing agreed (got ${o.agreed_amount_usd})`);
  assert(!agreementSent(r.sent), 'B: no "Deal, $54 works" goes out');
  assert(!r.sent.some((s) => s.type !== HOLDING_NOTE_MESSAGE_TYPE && dollars(s.body).includes(54)), 'B: no message ever quotes $54');
  assert(auths(r.store).length === 0, 'B: no payment authorization');
  assert(Number(o.current_offer_usd) !== 54, `B: the standing offer never becomes the parsed $54 (got ${o.current_offer_usd})`);
  assert(r.audits.includes('negotiation.accept_price_unclear'), `B: escalated (got ${r.audits})`);
}

// ── C. a bare yes to openers with numbers in them ───────
async function bareYesToNumberedOpeners() {
  for (const opener of [DATE_OPENER, TITLE_OPENER]) {
    const NOW0 = Date.parse('2026-07-06T00:00:00.000Z');
    const store = makeStore();
    seed(store, { opener, ceil: 600 });
    const { sent, dispatch } = recorder(store);
    await step(store, dispatch, 'i1', "Sounds good, I'm in!", { intent: 'accept', counter_usd: null }, NOW0);
    const o = offerOf(store);
    const tag = opener === DATE_OPENER ? 'October 24' : 'Room 214';
    assert(o.agreed_amount_usd == null && auths(store).length === 0, `C: bare yes to the "${tag}" opener → nothing agreed (got ${o.agreed_amount_usd})`);
    assert(!agreementSent(sent), `C: "${tag}" → no agreement email`);
    assert(Number(o.current_offer_usd) === 150, `C: "${tag}" → the standing offer is untouched (got ${o.current_offer_usd})`);
  }
}

// ── D. no text we sent yields a price ─────────────────────
function noTextYieldsAPrice() {
  const texts = [
    "Hi @x, the new single drops October 24 and we'd love a paid collab. What do you charge?",
    "Hi @x, the single is out on 10/24. What's your rate for one reel?",
    "Hey! Loved your last 30 videos. Paid collab for our new track, what's your rate?",
    "Hi, we're promoting a 15 second hook. Paid collab, what do you charge?",
    'Hi @x, following up on my note from last week. We have 12 creators already on board.',
    "Thanks, give me 20 minutes and I'll come back to you.",
    "Hi @x, track is called 'Room 214'. What would you charge?",
    "Release is in 2 weeks; we're working with 25 creators. What's your rate?",
    'Hi! Your 45K followers are a great fit. What do you charge?',
    'We can do 150 for one reel.',
    'Hey, $150 for 1 reel + 1 story',
    'Hi, Example Records here, budget is €200 for a reel.',
    'Hi, Example Records here, we can offer £200 for a reel.',
    'Hi, we can offer 200 EUR for a reel.',
    'Hi, we can offer CA$200 for a reel.',
    'Thanks!\n\nStudio 54',
  ];
  for (const type of ['initial', HOLDING_NOTE_MESSAGE_TYPE, 'follow_up']) {
    for (const body of texts) {
      const r = lastSentOffer([{ message_type: type, direction: 'outbound', status: 'sent', sent_at: '2026-01-01T00:00:00Z', body }]);
      assert(r.usd === null && r.source === 'none', `D: ${type} "${body.slice(0, 40)}" → no price (got ${JSON.stringify(r)})`);
    }
  }
  // Structured is the only source, and a pre-059 read knows nothing at all.
  const rows = [
    { message_type: 'initial', direction: 'outbound', status: 'sent', sent_at: '2026-01-01T00:00:00Z', body: 'October 24', [COUNTER_OFFER_COLUMN]: 140 },
  ];
  assert(lastSentOffer(rows).usd === 140, 'D: a structured offer_usd on a sent opener IS the price (not its text)');
  const pre = lastSentOffer(rows, { priceColumn: false });
  assert(pre.usd === null && pre.source === 'unknown', 'D: thread read without the 059 column → unknown');
}

// ── E. Normal flows keep working ────────────────────────────────────────────
async function normalFlows() {
  // E1: AI counters $150 then $175 (both structured); "deal" closes at $175.
  {
    const NOW0 = Date.parse('2026-07-05T18:00:00.000Z'); // 13:00 at -5: all three turns inside the send window
    const store = makeStore();
    seed(store, { init: 100, ceil: 200 });
    const { sent, dispatch } = recorder(store);
    await step(store, dispatch, 'i1', 'Can you come up to $300?', { intent: 'counter', counter_usd: 300 }, NOW0);
    await step(store, dispatch, 'i2', 'Still need $300.', { intent: 'counter', counter_usd: 300 }, NOW0 + 60 * MIN);
    const sentCounters = store.all('outreach_messages').filter((r) => r.message_type === 'counter' && r.status === 'sent');
    const last = Number(sentCounters.at(-1)?.[COUNTER_OFFER_COLUMN]);
    assert(last === 175, `E1 setup: the second AI counter quotes $175 (got ${sentCounters.map((r) => r[COUNTER_OFFER_COLUMN])})`);
    await step(store, dispatch, 'i3', 'ok deal', { intent: 'accept', counter_usd: null }, NOW0 + 120 * MIN);
    assert(Number(offerOf(store).agreed_amount_usd) === 175, `E1: "deal" → auto-closed at $175 (got ${offerOf(store).agreed_amount_usd})`);
    assert(auths(store).join() === '175', `E1: authorized at $175 (got ${auths(store)})`);
    const conf = sent.find((s) => s.type === 'agreement_confirmation');
    assert(conf != null && dollars(conf.body)[0] === 175, `E1: "Deal, $175 works" (got ${conf?.body})`);
  }
  // E2: last structured sent price is $150 (an opener that recorded it).
  {
    const store = makeStore();
    seed(store, { opener: 'Hey, $150 for 1 reel + 1 story', openerUsd: 150, ceil: 600 });
    const { sent, dispatch } = recorder(store);
    await step(store, dispatch, 'i1', 'Deal at $150', { intent: 'accept', counter_usd: 150 }, Date.parse('2026-07-06T00:00:00.000Z'));
    assert(Number(offerOf(store).agreed_amount_usd) === 150, `E2: "Deal at $150" vs structured $150 → closed at $150 (got ${offerOf(store).agreed_amount_usd})`);
    assert(agreementSent(sent), 'E2: the agreement email goes');
  }
  // E3: "$250?" after a counter is still a counter.
  {
    const NOW0 = Date.parse('2026-07-06T00:00:00.000Z');
    const store = makeStore();
    seed(store, { init: 100, ceil: 200 });
    const { dispatch } = recorder(store);
    await step(store, dispatch, 'i1', 'Can you come up to $300?', { intent: 'counter', counter_usd: 300 }, NOW0);
    await step(store, dispatch, 'i2', '$250?', { intent: 'counter', counter_usd: 250 }, NOW0 + 60 * MIN);
    const sentCounters = store.all('outreach_messages').filter((r) => r.message_type === 'counter' && r.status === 'sent');
    assert(offerOf(store).agreed_amount_usd == null && sentCounters.length === 2, `E3: "$250?" → a second counter, no agreement (got ${sentCounters.length})`);
  }
}

// ── F. Operator manual send with an explicit "Price quoted" ─────────────────
async function manualQuotedPrice() {
  const NOW0 = Date.parse('2026-07-06T00:00:00.000Z');
  const queueManual = (store: Store, body: string) =>
    store.seed('outreach_messages', {
      id: 'manual-1', campaign_influencer_id: 'ci-1', message_type: 'follow_up', direction: 'outbound',
      channel: 'email', subject: 'Re: Collab', body, status: 'queued', send_mode: 'auto_email',
      send_after: new Date(NOW0).toISOString(), edited_by_user: true,
    });
  // F1: field filled → recorded, sent, becomes the standing offer, "deal" closes at it.
  {
    const store = makeStore();
    seed(store, { init: 150, ceil: 250 });
    const { sent, dispatch } = recorder(store);
    queueManual(store, 'Hi! We can do $180 for the reel + story, posting after October 24.');
    const rec = await recordManualQuotedPrice(store.sb, { messageId: 'manual-1', usd: 180 });
    assert(rec.kind === 'saved' && rec.offer_usd === 180, `F1: the "Price quoted" $180 is recorded (got ${JSON.stringify(rec)})`);
    await drain(store, NOW0, NOW0 + 5 * MIN, dispatch);
    assert(sent.some((s) => s.type === 'follow_up'), 'F1: the manual message went');
    assert(Number(offerOf(store).current_offer_usd) === 180, `F1: the standing offer is the $180 quoted (got ${offerOf(store).current_offer_usd})`);
    const shown = await readLastSentOffers(store.sb, [{ campaign_influencer_id: 'ci-1' }]);
    assert(shown.get('ci-1') === 180, `F1: "Last price sent" reads $180 (got ${shown.get('ci-1')})`);
    await step(store, dispatch, 'i1', 'Deal!', { intent: 'accept', counter_usd: null }, NOW0 + 60 * MIN);
    assert(Number(offerOf(store).agreed_amount_usd) === 180, `F1: "Deal!" → closed at the $180 quoted (got ${offerOf(store).agreed_amount_usd})`);
  }
  // F2: same text, field left empty → nothing on record → a human decides.
  {
    const store = makeStore();
    seed(store, { init: 150, ceil: 250 });
    const { sent, dispatch } = recorder(store);
    queueManual(store, 'Hi! We can do $180 for the reel + story.');
    await drain(store, NOW0, NOW0 + 5 * MIN, dispatch);
    const before = auditActions.length;
    await step(store, dispatch, 'i1', 'Deal!', { intent: 'accept', counter_usd: null }, NOW0 + 60 * MIN);
    assert(offerOf(store).agreed_amount_usd == null && !agreementSent(sent), 'F2: "$180" only in the text → nothing agreed');
    assert(auditActions.slice(before).includes('negotiation.accept_price_unclear'), 'F2: escalated to a human');
  }
  // F3: refusals.
  {
    const store = makeStore();
    seed(store, { init: 150, ceil: 250 });
    queueManual(store, 'x');
    const over = await recordManualQuotedPrice(store.sb, { messageId: 'manual-1', usd: 300 });
    assert(over.kind === 'refused' && over.body.error === 'above_ceiling', `F3: above the $250 ceiling → refused (got ${JSON.stringify(over)})`);
    const cleared = await recordManualQuotedPrice(store.sb, { messageId: 'manual-1', usd: null });
    assert(cleared.kind === 'saved' && cleared.offer_usd === null, 'F3: null clears the price');
    const sentRow = await recordManualQuotedPrice(store.sb, { messageId: 'msg-first', usd: 150 });
    assert(sentRow.kind === 'refused' && sentRow.body.error === 'already_sent', 'F3: a message that already went cannot gain a price');
  }
  // F4: the UI payload helper.
  assert(JSON.stringify(manualQuotedPayload(false, '180', null)) === '{"offer_usd":180}', 'F4: typed price → offer_usd');
  assert(JSON.stringify(manualQuotedPayload(false, '', null)) === '{}', 'F4: empty with none before → nothing sent');
  assert(JSON.stringify(manualQuotedPayload(false, '', 180)) === '{"offer_usd":null}', 'F4: emptied → cleared');
  assert(manualQuotedPayload(false, 'abc', null) === 'invalid' && manualQuotedPayload(false, '0', null) === 'invalid', 'F4: junk / zero → invalid');
  assert(JSON.stringify(manualQuotedPayload(true, '180', null)) === '{}', 'F4: a counter uses its own field');
}

// ── G. Creator replies in another currency still escalate (#4) ─────────────
async function nonUsdCreatorReplies() {
  const NOW0 = Date.parse('2026-07-06T00:00:00.000Z');
  for (const [reply, out] of [
    ['Deal at €150', { intent: 'accept', counter_usd: 150 }],
    ['Can you do £250?', { intent: 'counter', counter_usd: 250 }],
  ] as Array<[string, Out]>) {
    const store = makeStore();
    seed(store, { opener: 'Hey, $150 for 1 reel + 1 story', openerUsd: 150, ceil: 600 });
    const { sent, dispatch } = recorder(store);
    const before = auditActions.length;
    await step(store, dispatch, 'i1', reply, out, NOW0);
    const esc = auditActions.slice(before);
    assert(offerOf(store).agreed_amount_usd == null && !agreementSent(sent), `G: "${reply}" → nothing agreed`);
    assert(!sent.some((s) => s.type === 'counter'), `G: "${reply}" → no automated counter`);
    assert(esc.some((a) => a === 'negotiation.accept_price_unclear' || a === 'negotiation.counter_price_unclear'), `G: "${reply}" → escalated (got ${esc})`);
  }
}

(async () => {
  console.warn = () => {};
  noTextYieldsAPrice();
  await openerDateIsNotAPrice();
  await signoffNameIsNotAPrice();
  await bareYesToNumberedOpeners();
  await normalFlows();
  await manualQuotedPrice();
  await nonUsdCreatorReplies();
  console.log(`\nstructured-sent-price: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
