import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
//
// tests/stale-dispatch.test.ts
//
// If dispatchDue sent the PASS-START body while applySentCounterPrice re-read
// offer_usd fresh, an operator edit saved while an earlier row in the same
// pass was sending would change the body and the price in the DB but not in
// the pass: the creator gets the old text, the row records the new price, and
// "Sounds good!" is answered "Deal, $240 works" for a price the creator never
// saw. So:
//   - the claim (UPDATE … WHERE status='queued' RETURNING …) is the one read
//     of the row as it leaves the queue: dispatch sends exactly its body and
//     subject, and records exactly its offer_usd;
//   - the edit route refuses a row that is no longer queued (409), so an edit
//     can never land between the claim and the send;
//   - normal flows are unchanged.
//
// Every assertion compares what the dispatcher was GIVEN with what the row
// records, never the row read back at dispatch time (that read is what hid it).
//
// Hermetic: in-memory store, mock model provider, injected dispatch/clock/rng.
// Run: npx tsx tests/stale-dispatch.test.ts

import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { registerProvider } from '../src/lib/model-provider';
import { runNegotiationTick, runDispatchPass, type DispatchFn } from '../src/lib/negotiation-tick';
import { COUNTER_OFFER_COLUMN, PRICE_RECORD_MESSAGE_TYPE, PRICE_RECORD_STATUS, applySentCounterPrice, lastSentOffer } from '../src/lib/last-sent-offer';
import { editCounterDraft, editOutboundMessage, recordManualQuotedPrice } from '../src/lib/counter-edit';
import { makeOutreachMessageHandlers } from '../src/lib/outreach-message-handlers';
import type { Session } from '../src/lib/auth';
import { makeStore, type Row } from './negotiation-harness/store';

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

const NOW0 = Date.parse('2026-07-06T15:00:00.000Z'); // 10:00 at -5, inside the send window
const MIN = 60_000;
const HALF = () => 0.5;
const noopPoll = async () => ({ skipped: 'gmail_not_configured' as const });
const FIRM = 'firm-1';

type Out = { intent: string; counter_usd?: number | null };
let script: () => Out = () => ({ intent: 'unclear' });
registerProvider('mock', async () => JSON.stringify({ sentiment: 'neutral', confidence: 0.9, counter_usd: null, ...script() }));

type Store = ReturnType<typeof makeStore>;

function seed(store: Store, o: { autonomy?: string; init?: number; ceil?: number } = {}) {
  store.seed('firms', { id: FIRM, name: 'Example Records', sender_name: null, outreach_prefs: {}, scraping_prefs: {} });
  store.seed('campaigns', { id: 'camp-1', firm_id: FIRM, total_budget_usd: 10_000 });
  store.seed('influencers', { id: 'inf-1', blocklisted: false });
  store.seed('campaign_influencers', { id: 'ci-1', campaign_id: 'camp-1', influencer_id: 'inf-1' });
  const init = o.init ?? 150;
  store.seedOffer({
    id: 'offer-1', campaign_influencer_id: 'ci-1', campaign_id: 'camp-1', firm_id: FIRM,
    status: 'offered', initial_offer_usd: init, current_offer_usd: init, agreed_amount_usd: null, ceiling_usd: o.ceil ?? 250,
    rounds: 0, last_message_id: null, approved_at: null, approved_by_user_id: null, paid_at: null, posted_at: null,
    post_url: null, autonomy_mode: o.autonomy ?? 'auto', opening_pct: null, injection_flagged: false,
    created_at: '2026-07-06T00:00:00.000Z', updated_at: '2026-07-06T00:00:00.000Z',
  });
  store.seed('outreach_messages', {
    id: 'msg-first', campaign_influencer_id: 'ci-1', message_type: 'initial', direction: 'outbound',
    channel: 'email', subject: 'Collab', body: 'Hi, paid collab. What do you charge?', status: 'sent',
    sent_at: '2026-07-05T15:00:00.000Z', send_after: null,
  });
}

/** Two queued follow-ups on the thread: A due first, then B. */
function queueAB(store: Store, b: Row, a: Row = {}) {
  store.seed('outreach_messages', {
    id: 'A', campaign_influencer_id: 'ci-1', message_type: 'follow_up', direction: 'outbound', channel: 'email',
    subject: 'Re', body: 'Following up!', status: 'queued', send_after: new Date(NOW0 - 2 * MIN).toISOString(),
    send_mode: 'auto', edited_by_user: false, ...a,
  });
  store.seed('outreach_messages', {
    id: 'B', campaign_influencer_id: 'ci-1', direction: 'outbound', channel: 'email', subject: 'Re',
    status: 'queued', send_after: new Date(NOW0 - 1 * MIN).toISOString(), send_mode: 'auto', edited_by_user: false, ...b,
  });
}

/** Records what the dispatcher was GIVEN; runs `during(id)` before returning. */
function recorder(during: (id: string) => Promise<void> = async () => {}) {
  const sent: Array<{ id: string; subject: string | null; body: string }> = [];
  const dispatch: DispatchFn = async (_sb, m) => {
    sent.push({ id: m.id, subject: m.subject, body: String(m.body) });
    await during(m.id);
    return { ok: true, provider_message_id: 'p', resolved_to: 't@x' };
  };
  return { sent, dispatch };
}

const row = (store: Store, id: string) => store.all('outreach_messages').find((r) => r.id === id)!;
const offerOf = (store: Store) => store.getOffer('offer-1') as Row;
const thread = (store: Store) => store.all('outreach_messages').filter((r) => r.campaign_influencer_id === 'ci-1');
const dollars = (s: string) => [...s.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));

/** The creator replies "Sounds good!" (model: accept); returns what went out. */
async function soundsGood(store: Store, at: number) {
  store.seed('inbound_messages', {
    id: 'i-yes', channel: 'email', external_id: 'sim:i-yes', creator_offer_id: null, campaign_influencer_id: 'ci-1',
    from_identity: 'sim', body: 'Sounds good!', received_at: new Date(at).toISOString(), status: 'classified',
    classification: { classification: 'negotiating', confidence: 0.8 },
  });
  script = () => ({ intent: 'accept', counter_usd: null });
  const r = recorder();
  await runNegotiationTick(store.sb, { now: at, rand: HALF, dispatch: r.dispatch, pollGmail: noopPoll });
  for (let t = at; t <= at + 40 * MIN; t += MIN) await runDispatchPass(store.sb, { now: t, rand: HALF, dispatch: r.dispatch });
  return r.sent;
}

/**
 * The invariant both proofs broke: whatever price the row records for a sent
 * message, the copy the dispatcher was handed must be that copy, and an agreed
 * price must be one the creator was actually sent.
 */
function sentMatchesRecord(store: Store, sent: Array<{ id: string; body: string }>, id: string, tag: string) {
  const got = sent.find((s) => s.id === id);
  const r = row(store, id);
  assert(got != null, `${tag}: ${id} was dispatched`);
  assert(got?.body === r.body, `${tag}: ${id} — the body sent is the body on record (sent ${JSON.stringify(got?.body)}, row ${JSON.stringify(r.body)})`);
  const usd = r[COUNTER_OFFER_COLUMN];
  if (usd != null) {
    assert(dollars(String(got?.body)).includes(Number(usd)), `${tag}: ${id} records $${usd}, and the copy the creator got quotes it (sent ${JSON.stringify(got?.body)})`);
  }
}

// ── 1. an operator edits a follow-up mid-pass ────
async function followUpEditedMidPass() {
  const store = makeStore();
  seed(store);
  queueAB(store, { message_type: 'follow_up', body: 'Just checking in!' });
  let edit: unknown = null;
  const { sent, dispatch } = recorder(async (id) => {
    if (id !== 'A' || edit) return;
    // The operator saves B ("Price quoted" $240) while A is sending.
    edit = await editOutboundMessage(store.sb, { messageId: 'B', body: 'We can do $240 for the reel.', usd: 240 });
  });
  await runDispatchPass(store.sb, { now: NOW0, rand: HALF, dispatch });
  assert((edit as { kind?: string })?.kind === 'saved', `1 setup: the mid-pass edit of still-queued B is saved (got ${JSON.stringify(edit)})`);
  assert(row(store, 'B').status === 'sent', '1: B went in the same pass');
  sentMatchesRecord(store, sent, 'B', '1');
  assert(sent.find((s) => s.id === 'B')?.body === 'We can do $240 for the reel.', '1: the creator got the operator\'s edited text, not the pass-start "Just checking in!"');
  const yes = await soundsGood(store, NOW0 + 5 * MIN);
  const deal = yes.find((s) => /^Deal, \$/.test(s.body));
  if (deal) {
    const agreed = dollars(deal.body)[0];
    const everSent = sent.some((s) => dollars(s.body).includes(agreed));
    assert(everSent, `1: "Deal, $${agreed} works" names a price the creator was sent (sent: ${JSON.stringify(sent.map((s) => s.body))})`);
  }
  const o = offerOf(store);
  if (o.agreed_amount_usd != null) {
    assert(sent.some((s) => dollars(s.body).includes(Number(o.agreed_amount_usd))), `1: agreed $${o.agreed_amount_usd} was quoted in a message the creator received`);
  }
}

// ── 2. a counter edited mid-pass ─────────
async function counterEditedMidPass() {
  const store = makeStore();
  seed(store);
  queueAB(store, { message_type: 'counter', [COUNTER_OFFER_COLUMN]: 175, body: 'I can do $175 for the reel.' });
  let edit: unknown = null;
  const { sent, dispatch } = recorder(async (id) => {
    if (id !== 'A' || edit) return;
    edit = await editCounterDraft(store.sb, { messageId: 'B', body: 'We can do $240 for the reel.', confirmedOfferUsd: 240 });
  });
  await runDispatchPass(store.sb, { now: NOW0, rand: HALF, dispatch });
  assert((edit as { kind?: string })?.kind === 'saved', `2 setup: the mid-pass counter edit is saved (got ${JSON.stringify(edit)})`);
  sentMatchesRecord(store, sent, 'B', '2');
  assert(!sent.some((s) => s.body === 'I can do $175 for the reel.'), '2: the stale $175 text was never sent beside a $240 record');
  const last = lastSentOffer(thread(store));
  assert(last.usd != null && dollars(sent.find((s) => s.id === 'B')!.body).includes(last.usd), `2: lastSentOffer $${last.usd} is the price in the sent copy`);
  assert(Number(offerOf(store).current_offer_usd) === 240, `2: the standing offer is the sent $240 (got ${offerOf(store).current_offer_usd})`);
  const yes = await soundsGood(store, NOW0 + 5 * MIN);
  const deal = yes.find((s) => /^Deal, \$/.test(s.body));
  assert(deal == null || dollars(deal.body)[0] === 240, `2: any "Deal" names $240, the price the creator received (got ${deal?.body})`);
}

// ── 3. An edit that arrives AFTER the claim is refused (409), never applied ─
function session(): Session {
  return { user: { id: 'user-1', email: 'op@label.test' }, firm_id: FIRM, role: 'owner' };
}
let ipSeq = 0;
function req(body: unknown): NextRequest {
  ipSeq += 1;
  return new NextRequest('http://localhost/api/outreach/messages/x', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.${Math.floor(ipSeq / 250)}.${ipSeq % 250}` },
    body: JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function editBetweenClaimAndSend() {
  for (const kind of ['counter', 'follow_up'] as const) {
    const store = makeStore();
    seed(store);
    const isCounter = kind === 'counter';
    queueAB(store, isCounter
      ? { message_type: 'counter', [COUNTER_OFFER_COLUMN]: 175, body: 'I can do $175 for the reel.' }
      : { message_type: 'follow_up', body: 'Just checking in!' });
    const h = makeOutreachMessageHandlers({ requireSessionAndClient: async () => ({ session: session(), sb: store.sb as SupabaseClient }) });
    let status = 0;
    let errBody: Record<string, unknown> = {};
    const { sent, dispatch } = recorder(async (id) => {
      if (id !== 'B') return;
      // B is claimed and its copy handed to the dispatcher; the operator's
      // Save lands now, through the real PATCH handler.
      const res = await h.PATCH(req({ body: 'We can do $240 for the reel.', offer_usd: 240 }), ctx('B'));
      status = res.status;
      errBody = (await res.json()) as Record<string, unknown>;
    });
    await runDispatchPass(store.sb, { now: NOW0, rand: HALF, dispatch });
    const tag = `3 (${kind})`;
    assert(status === 409, `${tag}: an edit after the claim → 409 (got ${status} ${JSON.stringify(errBody)})`);
    assert(errBody.error === 'already_sent', `${tag}: refusal says already sending/sent (got ${JSON.stringify(errBody)})`);
    const b = row(store, 'B');
    assert(b.body === sent.find((s) => s.id === 'B')?.body, `${tag}: the row still holds the body that was sent (got ${JSON.stringify(b.body)})`);
    assert(isCounter ? Number(b[COUNTER_OFFER_COLUMN]) === 175 : b[COUNTER_OFFER_COLUMN] == null, `${tag}: the recorded price is unchanged (got ${b[COUNTER_OFFER_COLUMN]})`);
    assert(b.edited_by_user !== true, `${tag}: the row is not marked human-edited after the fact`);
    assert(Number(offerOf(store).current_offer_usd) === 150, `${tag}: the standing offer did not move to an unsent $240 (got ${offerOf(store).current_offer_usd})`);
  }
  // Every non-queued, non-draft status refuses through the handler too.
  for (const st of ['sent', 'superseded', 'window_closed', 'failed']) {
    const store = makeStore();
    seed(store);
    queueAB(store, { message_type: 'follow_up', body: 'Just checking in!', status: st });
    const h = makeOutreachMessageHandlers({ requireSessionAndClient: async () => ({ session: session(), sb: store.sb as SupabaseClient }) });
    const res = await h.PATCH(req({ body: 'changed' }), ctx('B'));
    assert(res.status === 409 && row(store, 'B').body === 'Just checking in!', `3: PATCH body on a '${st}' row → 409, untouched (got ${res.status})`);
  }
  // Drafts and queued rows still edit.
  for (const st of ['draft', 'queued', null]) {
    const store = makeStore();
    seed(store);
    queueAB(store, { message_type: 'initial', body: 'old', status: st });
    const h = makeOutreachMessageHandlers({ requireSessionAndClient: async () => ({ session: session(), sb: store.sb as SupabaseClient }) });
    const res = await h.PATCH(req({ body: 'new copy', subject: 'S' }), ctx('B'));
    assert(res.status === 200 && row(store, 'B').body === 'new copy' && row(store, 'B').subject === 'S', `3: PATCH on a '${st}' row still saves (got ${res.status})`);
  }
}

// ── 4. The claim's row decides; snapshot-only gates cannot misfire ──────────
async function claimedRowDecides() {
  // 4a. Routed to the DM queue after the pass-start SELECT → never emailed.
  {
    const store = makeStore();
    seed(store);
    queueAB(store, { message_type: 'follow_up', body: 'Just checking in!' });
    const { sent, dispatch } = recorder(async (id) => {
      if (id === 'A') await store.sb.from('outreach_messages').update({ send_mode: 'human_queue' } as never).eq('id', 'B');
    });
    await runDispatchPass(store.sb, { now: NOW0, rand: HALF, dispatch });
    const b = row(store, 'B');
    assert(!sent.some((s) => s.id === 'B'), '4a: a row routed to the DM queue mid-pass is not emailed');
    assert(b.status === 'queued' && b.sent_at == null, `4a: its claim is released (status ${b.status}, sent_at ${b.sent_at})`);
  }
  // 4b. A thread a human took over: an edit saved mid-pass makes B a
  //     human message, so the snapshot's "AI reply" verdict must not withdraw it.
  {
    const store = makeStore();
    seed(store, { autonomy: 'human' });
    queueAB(store, { message_type: 'follow_up', body: 'Just checking in!' }, { edited_by_user: true });
    const { sent, dispatch } = recorder(async (id) => {
      if (id === 'A') await editOutboundMessage(store.sb, { messageId: 'B', body: 'Personal note from me.' });
    });
    await runDispatchPass(store.sb, { now: NOW0, rand: HALF, dispatch });
    assert(row(store, 'B').status === 'queued', `4b: the human-edited B is not withdrawn (got ${row(store, 'B').status})`);
    await runDispatchPass(store.sb, { now: NOW0 + MIN, rand: HALF, dispatch });
    assert(sent.some((s) => s.id === 'B' && s.body === 'Personal note from me.'), '4b: and it goes, with the human\'s text, on the next pass');
  }
  // 4c. The price recorded is the claimed row's, never a later re-read: the
  //     dispatch pass hands applySentCounterPrice the row it sent.
  {
    const store = makeStore();
    seed(store);
    store.seed('outreach_messages', {
      id: 'C', campaign_influencer_id: 'ci-1', message_type: 'counter', direction: 'outbound', channel: 'email',
      body: 'We can do $200.', status: 'sent', edited_by_user: true, [COUNTER_OFFER_COLUMN]: 230,
    });
    await applySentCounterPrice(store.sb, 'C', {
      campaign_influencer_id: 'ci-1', message_type: 'counter', status: 'sent', edited_by_user: true, [COUNTER_OFFER_COLUMN]: 200,
    });
    assert(Number(offerOf(store).current_offer_usd) === 200, `4c: the standing offer is the sent row's $200, not a re-read $230 (got ${offerOf(store).current_offer_usd})`);
  }
}

// ── 6. "Price quoted" cannot rewrite the Resume price record ────────────────
// recordManualQuotedPrice guarded only on status <> 'sent', so it accepted the
// Resume record (status 'recorded'): a PATCH could change the price an
// operator quoted outside the app, which is the thread's last quoted price.
async function priceRecordOnlyThroughResume() {
  const seedRecord = (store: Store, status: string) =>
    store.seed('outreach_messages', {
      id: 'rec-1', campaign_influencer_id: 'ci-1', message_type: PRICE_RECORD_MESSAGE_TYPE, direction: 'outbound',
      channel: 'email', subject: null, body: 'Quoted $180 by phone.', status, sent_at: null,
      [COUNTER_OFFER_COLUMN]: 180,
    });
  for (const st of [PRICE_RECORD_STATUS, 'draft', 'queued']) {
    const store = makeStore();
    seed(store);
    seedRecord(store, st);
    for (const usd of [240, null]) {
      const r = await recordManualQuotedPrice(store.sb, { messageId: 'rec-1', usd });
      assert(r.kind === 'refused' && r.status === 409, `6 (${st}): recordManualQuotedPrice(${usd}) on the Resume record → 409 (got ${JSON.stringify(r)})`);
    }
    assert(Number(row(store, 'rec-1')[COUNTER_OFFER_COLUMN]) === 180, `6 (${st}): the recorded $180 is untouched (got ${row(store, 'rec-1')[COUNTER_OFFER_COLUMN]})`);
    const h = makeOutreachMessageHandlers({ requireSessionAndClient: async () => ({ session: session(), sb: store.sb as SupabaseClient }) });
    const res = await h.PATCH(req({ body: 'Quoted $240 by phone.', offer_usd: 240 }), ctx('rec-1'));
    assert(res.status === 409 && row(store, 'rec-1').body === 'Quoted $180 by phone.', `6 (${st}): PATCH on the Resume record → 409, body untouched (got ${res.status})`);
    const last = lastSentOffer(thread(store));
    assert(last.usd === 180 || st !== PRICE_RECORD_STATUS, `6 (${st}): lastSentOffer is still the operator's $180 (got ${JSON.stringify(last)})`);
  }
  // Control: a queued manual follow-up still takes a quoted price.
  {
    const store = makeStore();
    seed(store);
    queueAB(store, { message_type: 'follow_up', body: 'We can do $180.', edited_by_user: true });
    const r = await recordManualQuotedPrice(store.sb, { messageId: 'B', usd: 180 });
    assert(r.kind === 'saved' && Number(row(store, 'B')[COUNTER_OFFER_COLUMN]) === 180, `6: a queued follow-up still records "Price quoted" (got ${JSON.stringify(r)})`);
  }
}

// ── 7. A no-op Save leaves an AI draft an AI draft ──────────────────────────
// Every Save set edited_by_user = true, so opening an AI counter and pressing
// Save unchanged made it "human-authored": manual mode no longer withdrew it,
// and it went out on a thread a human had taken over.
async function noOpSaveStaysAi() {
  const cases: Array<{ tag: string; b: Row; patch: Record<string, unknown>; edited: boolean }> = [
    { tag: 'counter, unchanged', b: { message_type: 'counter', [COUNTER_OFFER_COLUMN]: 175, body: 'I can do $175 for the reel.' },
      patch: { body: 'I can do $175 for the reel.', subject: 'Re', offer_usd: 175 }, edited: false },
    { tag: 'counter, no subject sent', b: { message_type: 'counter', [COUNTER_OFFER_COLUMN]: 175, body: 'I can do $175 for the reel.' },
      patch: { body: 'I can do $175 for the reel.', offer_usd: 175 }, edited: false },
    { tag: 'counter, pre-059 row priced by the offer', b: { message_type: 'counter', body: 'I can do $150 for the reel.' },
      patch: { body: 'I can do $150 for the reel.', offer_usd: 150 }, edited: false },
    { tag: 'counter, text changed', b: { message_type: 'counter', [COUNTER_OFFER_COLUMN]: 175, body: 'I can do $175 for the reel.' },
      patch: { body: 'I can do $175 for the reel and a story.', offer_usd: 175 }, edited: true },
    { tag: 'counter, price changed', b: { message_type: 'counter', [COUNTER_OFFER_COLUMN]: 175, body: 'I can do $175 for the reel.' },
      patch: { body: 'I can do $180 for the reel.', offer_usd: 180 }, edited: true },
    { tag: 'counter, subject changed', b: { message_type: 'counter', [COUNTER_OFFER_COLUMN]: 175, body: 'I can do $175 for the reel.' },
      patch: { body: 'I can do $175 for the reel.', subject: 'Re: our rate', offer_usd: 175 }, edited: true },
    { tag: 'follow-up, unchanged', b: { message_type: 'follow_up', body: 'Just checking in!' },
      patch: { body: 'Just checking in!', subject: 'Re' }, edited: false },
    { tag: 'follow-up, text changed', b: { message_type: 'follow_up', body: 'Just checking in!' },
      patch: { body: 'Just checking in, any thoughts?' }, edited: true },
    { tag: 'follow-up, price quoted added', b: { message_type: 'follow_up', body: 'Just checking in!' },
      patch: { body: 'Just checking in!', offer_usd: 160 }, edited: true },
  ];
  for (const c of cases) {
    const store = makeStore();
    seed(store);
    queueAB(store, c.b);
    const h = makeOutreachMessageHandlers({ requireSessionAndClient: async () => ({ session: session(), sb: store.sb as SupabaseClient }) });
    const res = await h.PATCH(req(c.patch), ctx('B'));
    const b = row(store, 'B');
    assert(res.status === 200, `7 (${c.tag}): Save → 200 (got ${res.status})`);
    assert((b.edited_by_user === true) === c.edited, `7 (${c.tag}): edited_by_user is ${c.edited} (got ${b.edited_by_user})`);
    // Then a human takes the thread over: an unchanged AI draft is withdrawn,
    // a really-edited one is the human's and still goes.
    (offerOf(store) as Row).autonomy_mode = 'human';
    const { sent, dispatch } = recorder();
    await runDispatchPass(store.sb, { now: NOW0, rand: HALF, dispatch });
    const went = sent.some((s) => s.id === 'B');
    assert(went === c.edited, `7 (${c.tag}): after takeover B ${c.edited ? 'goes (human-edited)' : 'is withdrawn (still the AI\'s)'} (sent: ${went}, status ${row(store, 'B').status})`);
  }
  // An already human-edited draft stays human-edited on a no-op Save.
  {
    const store = makeStore();
    seed(store);
    queueAB(store, { message_type: 'follow_up', body: 'Mine.', edited_by_user: true });
    const h = makeOutreachMessageHandlers({ requireSessionAndClient: async () => ({ session: session(), sb: store.sb as SupabaseClient }) });
    await h.PATCH(req({ body: 'Mine.' }), ctx('B'));
    assert(row(store, 'B').edited_by_user === true, '7: a no-op Save never un-marks a human edit');
  }
}

// ── 5. Normal flows unchanged ───────────────────────────────────────────────
async function step(store: Store, dispatch: DispatchFn, id: string, body: string, out: Out, at: number) {
  store.seed('inbound_messages', {
    id, channel: 'email', external_id: `sim:${id}`, creator_offer_id: null, campaign_influencer_id: 'ci-1',
    from_identity: 'sim', body, received_at: new Date(at).toISOString(), status: 'classified',
    classification: { classification: 'negotiating', confidence: 0.8 },
  });
  script = () => out;
  await runNegotiationTick(store.sb, { now: at, rand: HALF, dispatch, pollGmail: noopPoll });
  for (let t = at; t <= at + 25 * MIN; t += MIN) await runDispatchPass(store.sb, { now: t, rand: HALF, dispatch });
}

async function normalFlows() {
  // Sent counter → "deal" closes at the counter.
  {
    const T = Date.parse('2026-07-05T18:00:00.000Z');
    const store = makeStore();
    seed(store, { init: 100, ceil: 200 });
    const { sent, dispatch } = recorder();
    await step(store, dispatch, 'i1', 'Can you come up to $300?', { intent: 'counter', counter_usd: 300 }, T);
    const counter = store.all('outreach_messages').find((r) => r.message_type === 'counter' && r.status === 'sent');
    const quoted = Number(counter?.[COUNTER_OFFER_COLUMN]);
    assert(counter != null && Number.isFinite(quoted), `5 setup: an AI counter went (got ${quoted})`);
    sentMatchesRecord(store, sent, String(counter?.id), '5');
    await step(store, dispatch, 'i2', 'ok deal', { intent: 'accept', counter_usd: null }, T + 60 * MIN);
    assert(Number(offerOf(store).agreed_amount_usd) === quoted, `5: "deal" → closed at the sent counter $${quoted} (got ${offerOf(store).agreed_amount_usd})`);
  }
  // "$250?" after a counter → a second counter, no agreement.
  {
    const T = Date.parse('2026-07-06T00:00:00.000Z');
    const store = makeStore();
    seed(store, { init: 100, ceil: 200 });
    const { dispatch } = recorder();
    await step(store, dispatch, 'i1', 'Can you come up to $300?', { intent: 'counter', counter_usd: 300 }, T);
    await step(store, dispatch, 'i2', '$250?', { intent: 'counter', counter_usd: 250 }, T + 60 * MIN);
    const counters = store.all('outreach_messages').filter((r) => r.message_type === 'counter' && r.status === 'sent');
    assert(offerOf(store).agreed_amount_usd == null && counters.length === 2, `5: "$250?" → a second counter, nothing agreed (got ${counters.length})`);
  }
}

(async () => {
  console.warn = () => {};
  await followUpEditedMidPass();
  await counterEditedMidPass();
  await editBetweenClaimAndSend();
  await claimedRowDecides();
  await priceRecordOnlyThroughResume();
  await noOpSaveStaysAi();
  await normalFlows();
  console.log(`\nstale-dispatch: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
