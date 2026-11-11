import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
//
// tests/manual-mode-withdraw.test.ts
//
// Manual mode and held replies stopped the next negotiation TURN, but not the
// counter an earlier turn had already queued: the thread went manual, and the
// dispatch pass sent "I can do $200" a few minutes later anyway. Now:
//   - entering manual mode / holding a reply withdraws every queued AI reply
//     on the thread (counter, acceptance, holding note, follow-up);
//   - the dispatch pass re-checks manual mode + held replies per row, right
//     before the claim, and withdraws instead of sending;
//   - human-authored queued sends (edited_by_user, the DM queue) are untouched.
//
// Hermetic: in-memory store, mock model provider, injected dispatch/clock/rng.
//
// Run: npx tsx tests/manual-mode-withdraw.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerProvider } from '../src/lib/model-provider';
import { runNegotiationTick, runDispatchPass, type DispatchFn } from '../src/lib/negotiation-tick';
import { withdrawQueuedAiReplies, dispatchThreadState, isAutoAiReply } from '../src/lib/negotiation-takeover';
import { HOLDING_NOTE_MESSAGE_TYPE, HOLDING_NOTE_SUPERSEDED_STATUS } from '../src/lib/holding-note';
import { ingestInboundReply } from '../src/lib/ingest-inbound';
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

const NOW0 = Date.parse('2026-07-06T15:00:00.000Z'); // 10:00 at -5, inside the send window
const MIN = 60_000;
const HALF = () => 0.5;
const noopPoll = async () => ({ skipped: 'gmail_not_configured' as const });

type Out = { intent: string; counter_usd?: number | null };
let script: (user: string) => Out = () => ({ intent: 'unclear' });
registerProvider('mock', async ({ user }) =>
  JSON.stringify({ sentiment: 'neutral', confidence: 0.9, counter_usd: null, ...script(user) }),
);

type Store = ReturnType<typeof makeStore>;

function seed(store: Store, autonomy = 'auto') {
  store.seed('firms', { id: 'firm-1', name: 'Example Records', sender_name: null, outreach_prefs: {}, scraping_prefs: {} });
  store.seedCampaign('camp-1', null);
  store.seed('influencers', { id: 'inf-1', blocklisted: false });
  store.seed('campaign_influencers', { id: 'ci-1', campaign_id: 'camp-1', influencer_id: 'inf-1' });
  store.seedOffer({
    id: 'offer-1', campaign_influencer_id: 'ci-1', campaign_id: 'camp-1', firm_id: 'firm-1',
    status: 'offered', initial_offer_usd: 150, current_offer_usd: 150, agreed_amount_usd: null,
    ceiling_usd: 250, rounds: 0, last_message_id: null, approved_at: null, approved_by_user_id: null,
    paid_at: null, posted_at: null, post_url: null, autonomy_mode: autonomy, opening_pct: null,
    injection_flagged: false, created_at: '2026-07-06T00:00:00.000Z', updated_at: '2026-07-06T00:00:00.000Z',
  });
  store.seed('outreach_messages', {
    id: 'msg-first', campaign_influencer_id: 'ci-1', message_type: 'initial', direction: 'outbound',
    channel: 'email', subject: 'Collab', body: 'Hi @x, I am writing from Example Records. Paid collab. Tell me what you charge.',
    status: 'sent', sent_at: '2026-07-05T15:00:00.000Z', send_after: null,
  });
}

function inbound(store: Store, id: string, body: string, at: number, status = 'classified') {
  store.seed('inbound_messages', {
    id, channel: 'email', external_id: `sim:${id}`, creator_offer_id: null, campaign_influencer_id: 'ci-1',
    from_identity: 'sim', body, received_at: new Date(at).toISOString(), status,
    classification: { classification: 'negotiating', confidence: 0.8 },
  });
}

function queued(store: Store, id: string, over: Row) {
  return store.seed('outreach_messages', {
    id, campaign_influencer_id: 'ci-1', direction: 'outbound', channel: 'email', subject: 'Re: Collab',
    body: 'x', status: 'queued', send_mode: 'auto_email', send_after: new Date(NOW0).toISOString(), ...over,
  });
}

function recorder(store: Store) {
  const sent: Array<{ id: string; type: string; body: string }> = [];
  const dispatch: DispatchFn = async (_sb, m) => {
    const r = store.all('outreach_messages').find((x) => x.id === m.id);
    sent.push({ id: String(m.id), type: String(r?.message_type), body: String(r?.body ?? '') });
    return { ok: true, provider_message_id: 'p', resolved_to: 't@x' };
  };
  return { sent, dispatch };
}
async function drain(store: Store, from: number, to: number, dispatch: DispatchFn) {
  for (let t = from; t <= to; t += MIN) await runDispatchPass(store.sb, { now: t, rand: HALF, dispatch });
}
const row = (store: Store, id: string) => store.all('outreach_messages').find((r) => r.id === id) as Row;

// ── A. end to end ────────────────────────────────
async function reviewerScenario() {
  const store = makeStore();
  seed(store);
  const { sent, dispatch } = recorder(store);
  inbound(store, 'i1', 'Can you do $300?', NOW0);
  script = () => ({ intent: 'counter', counter_usd: 300 });
  await runNegotiationTick(store.sb, { now: NOW0, rand: HALF, dispatch, pollGmail: noopPoll });
  let t = NOW0;
  for (; t <= NOW0 + 40 * MIN; t += MIN) {
    await runDispatchPass(store.sb, { now: t, rand: HALF, dispatch });
    if (store.all('outreach_messages').some((r) => r.message_type === HOLDING_NOTE_MESSAGE_TYPE && r.status === 'sent')) break;
  }
  const counter = store.all('outreach_messages').find((r) => r.message_type === 'counter');
  assert(counter?.status === 'queued', 'A setup: the holding note went, the $200 counter is still queued');
  // A reply is held for a human (e.g. ingest flagged a possible duplicate),
  // then another reply arrives: the tick holds the thread for the human.
  inbound(store, 'i2', 'Can you do $300? I really need $300 for this one', t + MIN, 'flagged');
  inbound(store, 'i3', 'Hello?', t + 2 * MIN);
  const before = auditActions.length;
  await runNegotiationTick(store.sb, { now: t + 2 * MIN, rand: HALF, dispatch, pollGmail: noopPoll });
  assert(String((store.getOffer('offer-1') as Row).autonomy_mode) === 'human', 'A: the thread is in manual mode');
  assert(counter?.status === HOLDING_NOTE_SUPERSEDED_STATUS, `A: the queued AI counter is withdrawn when the thread goes manual (got ${counter?.status})`);
  assert(auditActions.slice(before).includes('negotiation.ai_replies_withdrawn'), 'A: the withdrawal is audited');
  await drain(store, t + 2 * MIN, t + 40 * MIN, dispatch);
  assert(!sent.some((s) => s.type === 'counter'), `A: no counter is ever sent on a manual thread (sent ${sent.map((s) => s.type)})`);
  assert(!sent.some((s) => /\$200/.test(s.body)), 'A: "$200" never reaches the creator');
}

// ── B. Dispatch re-check alone: manual mode set with a counter still queued ──
async function dispatchRecheckManual() {
  const store = makeStore();
  seed(store, 'human');
  const { sent, dispatch } = recorder(store);
  queued(store, 'c1', { message_type: 'counter', body: 'I can do $200 for the reel.' });
  queued(store, 'a1', { message_type: 'agreement_confirmation', body: 'Deal, $150 works.' });
  queued(store, 'f1', { message_type: 'follow_up', body: 'Just checking in!' });
  await drain(store, NOW0, NOW0 + 5 * MIN, dispatch);
  assert(sent.length === 0, `B: nothing automated is sent while the offer is manual (sent ${sent.map((s) => s.type)})`);
  for (const id of ['c1', 'a1', 'f1']) {
    assert(row(store, id).status === HOLDING_NOTE_SUPERSEDED_STATUS, `B: ${id} is withdrawn at dispatch, not left queued (got ${row(store, id).status})`);
  }
}

// ── C. Dispatch re-check: a reply held for a human, mode not (yet) manual ───
async function dispatchRecheckHeldReply() {
  const store = makeStore();
  seed(store);
  const { sent, dispatch } = recorder(store);
  inbound(store, 'held', 'Hmm, can you do $300 or $280?', NOW0 - 10 * MIN, 'flagged');
  queued(store, 'c1', { message_type: 'counter', body: 'I can do $200 for the reel.' });
  await drain(store, NOW0, NOW0 + 5 * MIN, dispatch);
  assert(sent.length === 0 && row(store, 'c1').status === HOLDING_NOTE_SUPERSEDED_STATUS, 'C: a held reply on the thread stops the queued counter at dispatch');
}

// ── D. Human-authored queued sends are untouched ────────────────────────────
async function humanSendsUntouched() {
  const store = makeStore();
  seed(store, 'human');
  const { sent, dispatch } = recorder(store);
  queued(store, 'h1', { message_type: 'follow_up', body: 'Hi! I can do $190, how does that sound?', edited_by_user: true, offer_usd: 190 });
  queued(store, 'dm1', { message_type: 'counter', channel: 'instagram_dm', send_mode: 'human_queue', body: 'DM: $180?' });
  const withdrawn = await withdrawQueuedAiReplies(store.sb, 'ci-1', { reason: 'test' });
  assert(withdrawn.length === 0, `D: withdraw leaves human-authored and DM-queue rows alone (withdrew ${withdrawn})`);
  await drain(store, NOW0, NOW0 + 5 * MIN, dispatch);
  assert(sent.some((s) => s.id === 'h1'), 'D: the operator\'s own queued message still goes in manual mode');
  assert(row(store, 'dm1').status === 'queued', 'D: the DM-queue counter stays for the human to send');
  assert(!isAutoAiReply({ message_type: 'counter', edited_by_user: true }), 'D: an edited counter is human-authored');
  assert(isAutoAiReply({ message_type: HOLDING_NOTE_MESSAGE_TYPE }), 'D: a holding note is an AI reply');
  assert(!isAutoAiReply({ message_type: 'payout_onboarding' }), 'D: payout onboarding is not a negotiation reply');
}

// ── E. Holding notes go with the reply they announce ────────────────────────
async function holdingNotes() {
  {
    const store = makeStore();
    seed(store);
    queued(store, 'n1', { message_type: HOLDING_NOTE_MESSAGE_TYPE, body: 'Give me a few minutes.' });
    queued(store, 'c1', { message_type: 'counter', body: 'I can do $200.' });
    const w = await withdrawQueuedAiReplies(store.sb, 'ci-1', { reason: 'test' });
    assert(w.includes('n1') && w.includes('c1'), `E: the note and the AI counter it announces are both withdrawn (got ${w})`);
  }
  {
    const store = makeStore();
    seed(store);
    queued(store, 'n1', { message_type: HOLDING_NOTE_MESSAGE_TYPE, body: 'Give me a few minutes.' });
    queued(store, 'c1', { message_type: 'counter', body: 'I can do $175.', edited_by_user: true, offer_usd: 175 });
    const w = await withdrawQueuedAiReplies(store.sb, 'ci-1', { reason: 'test' });
    assert(w.length === 0, `E: a note announcing a HUMAN-edited reply stays with it (got ${w})`);
  }
}

// ── F. Normal flow: a clear thread still sends its counter ──────────────────
async function clearThreadSends() {
  const store = makeStore();
  seed(store);
  const { sent, dispatch } = recorder(store);
  inbound(store, 'i1', 'Can you do $300?', NOW0);
  script = () => ({ intent: 'counter', counter_usd: 300 });
  await runNegotiationTick(store.sb, { now: NOW0, rand: HALF, dispatch, pollGmail: noopPoll });
  await drain(store, NOW0, NOW0 + 30 * MIN, dispatch);
  assert(sent.some((s) => s.type === 'counter'), 'F: on a clear thread the AI counter goes as before');
  assert((await dispatchThreadState(store.sb, 'ci-1')) === 'clear', 'F: a clear thread reads clear');
}

// ── G. Unreadable at dispatch → not sent, still queued for the next pass ────
async function unreadableHolds() {
  const store = makeStore();
  seed(store);
  const { sent, dispatch } = recorder(store);
  queued(store, 'c1', { message_type: 'counter', body: 'I can do $200.' });
  const sb = {
    from(table: string) {
      if (table !== 'creator_offers') return store.sb.from(table);
      const refused = Promise.resolve({ data: null, error: { message: 'boom' } });
      const chain: Record<string, unknown> = { then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => refused.then(f, r) };
      for (const m of ['select', 'eq', 'in', 'is', 'neq']) chain[m] = () => chain;
      return chain;
    },
  } as unknown as Store['sb'];
  await runDispatchPass(sb, { now: NOW0 + MIN, rand: HALF, dispatch });
  assert(sent.length === 0 && row(store, 'c1').status === 'queued', 'G: an unreadable thread state sends nothing and leaves the row for a retry');
}

// ── I. Ingest holds a possible duplicate → the queued AI counter is pulled ──
async function ingestHeldReplyWithdraws() {
  const store = makeStore();
  seed(store);
  queued(store, 'c1', { message_type: 'counter', body: 'I can do $200 for the reel.' });
  queued(store, 'h1', { message_type: 'follow_up', body: 'My own note', edited_by_user: true });
  const at = new Date(NOW0 - 5 * MIN).toISOString();
  const base = { channel: 'email', from_identity: 'creator@x.test', campaign_influencer_id: 'ci-1', received_at: at };
  await ingestInboundReply({ ...base, external_id: 'manual:r8-a', body: 'Ok $180 works for me, send over the details and the contract and I will get it posted this week.' }, store.sb);
  assert(row(store, 'c1').status === 'queued', 'I setup: the first reply holds nothing');
  const r = await ingestInboundReply({ ...base, external_id: 'manual:r8-b', body: 'Ok $180 works for me, send over the details and the contract and I will get it posted next week.' }, store.sb);
  assert(r.possible_duplicate_of != null, 'I setup: ingest holds the second reply as a possible duplicate');
  assert(row(store, 'c1').status === HOLDING_NOTE_SUPERSEDED_STATUS, `I: the queued AI counter is withdrawn the moment a reply is held (got ${row(store, 'c1').status})`);
  assert(row(store, 'h1').status === 'queued', 'I: the human-authored queued message is untouched');
}

// ── H. Wiring ───────────────────────────────────────────────────────────────
function wiring() {
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  const ingest = src('src/lib/ingest-inbound.ts');
  assert(/possibleDuplicateOf && campaignInfluencerId\)[\s\S]{0,400}withdrawQueuedAiReplies\(/.test(ingest), 'H: a reply ingest holds for a human withdraws the queued AI replies');
  const takeover = src('src/lib/negotiation-takeover.ts');
  assert(/enterHumanTakeover[\s\S]{0,400}withdrawQueuedAiReplies\(/.test(takeover), 'H: every escalation into manual mode withdraws them');
}

(async () => {
  console.warn = () => {};
  await reviewerScenario();
  await dispatchRecheckManual();
  await dispatchRecheckHeldReply();
  await humanSendsUntouched();
  await holdingNotes();
  await clearThreadSends();
  await unreadableHolds();
  await ingestHeldReplyWithdraws();
  wiring();
  console.log(`\nmanual-mode-withdraw: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
