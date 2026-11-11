import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
//
// tests/dm-unsent-counter.test.ts
//
// DM counters wait in the human DM queue until a person sends them by hand
// and clicks "Mark sent". A creator reply that landed in between superseded
// the waiting counter (which the person may already have pasted into the DM)
// and agreed at the OLDER price; "Mark sent" then refused, because the draft
// was gone. Now, on a DM thread, a creator reply while a human-queue counter
// is unsent is never folded or agreed: the thread goes to manual mode and the
// draft stays in the queue, still markable as sent.
//
// (The proof used channel 'instagram', which routes to email; the DM queue is
// 'instagram_dm' / 'tiktok_dm', which is what this suite uses.)
//
// Run: npx tsx tests/dm-unsent-counter.test.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import { registerProvider } from '../src/lib/model-provider';
import { runNegotiationTick, runDispatchPass, COUNTER_OFFER_COLUMN, type DispatchFn } from '../src/lib/negotiation-tick';
import { recordHumanDmSend } from '../src/lib/dm-mark-sent';
import { resumeAutomation } from '../src/lib/negotiation-takeover';
import { isHumanTakeover } from '../src/lib/takeover-state';
import { lastSentOffer } from '../src/lib/last-sent-offer';
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

const NOW0 = Date.parse('2026-07-06T16:00:00.000Z'); // 11:00 at -5, inside the window
const MIN = 60_000;
const HALF = () => 0.5;
const noopPoll = async () => ({ skipped: 'gmail_not_configured' as const });

type Out = { intent: string; counter_usd?: number | null };
let script: (user: string) => Out = () => ({ intent: 'unclear' });
registerProvider('mock', async ({ user }) =>
  JSON.stringify({ sentiment: 'neutral', confidence: 0.9, counter_usd: null, ...script(user) }),
);

type Store = ReturnType<typeof makeStore>;

function seed(store: Store) {
  store.seed('firms', { id: 'firm-1', name: 'Example Records', sender_name: null, outreach_prefs: {}, scraping_prefs: {} });
  store.seed('campaigns', { id: 'camp-1', firm_id: 'firm-1', total_budget_usd: 1_000_000 });
  store.seed('influencers', { id: 'inf-1', blocklisted: false, platform: 'instagram' });
  store.seed('campaign_influencers', { id: 'ci-1', campaign_id: 'camp-1', influencer_id: 'inf-1', status: 'contacted' });
  store.seedOffer({
    id: 'offer-1', campaign_influencer_id: 'ci-1', campaign_id: 'camp-1', firm_id: 'firm-1',
    status: 'offered', initial_offer_usd: 100, current_offer_usd: 100, agreed_amount_usd: null,
    ceiling_usd: 200, rounds: 0, last_message_id: null, approved_at: null, approved_by_user_id: null,
    paid_at: null, posted_at: null, post_url: null, autonomy_mode: 'auto', opening_pct: null,
    injection_flagged: false, created_at: '2026-07-06T00:00:00.000Z', updated_at: '2026-07-06T00:00:00.000Z',
  });
  store.seed('outreach_messages', {
    id: 'msg-first', campaign_influencer_id: 'ci-1', message_type: 'initial', direction: 'outbound',
    channel: 'instagram_dm', subject: null, body: 'Hi, tell me what you charge', status: 'sent',
    send_mode: 'human_queue', sent_at: '2026-07-05T15:00:00.000Z', send_after: null,
  });
}

const counters = (store: Store) =>
  store.all('outreach_messages').filter((r) => r.message_type === 'counter' && r.direction === 'outbound');
const offerOf = (store: Store) => store.getOffer('offer-1') as Row;

async function step(store: Store, dispatch: DispatchFn, id: string, body: string, out: Out, at: number) {
  store.seed('inbound_messages', {
    id, channel: 'instagram_dm', external_id: `dm-manual:${id}`, creator_offer_id: null, campaign_influencer_id: 'ci-1',
    from_identity: '@creator', body, received_at: new Date(at).toISOString(), status: 'classified',
    classification: { classification: 'negotiating', confidence: 0.8 },
  });
  script = () => out;
  await runNegotiationTick(store.sb, { now: at, rand: HALF, dispatch, pollGmail: noopPoll });
  for (let x = at; x <= at + 25 * MIN; x += MIN) await runDispatchPass(store.sb, { now: x, rand: HALF, dispatch });
}

async function markSent(store: Store, id: string, at: number) {
  return recordHumanDmSend(store.sb as unknown as SupabaseClient, { messageId: id, callerFirmId: 'firm-1', nowMs: at });
}

async function proofScenario() {
  const store = makeStore();
  seed(store);
  const emailed: string[] = [];
  const dispatch: DispatchFn = async (_sb, m) => {
    emailed.push(m.id);
    return { ok: true, provider_message_id: 'p', resolved_to: 't@x' };
  };

  await step(store, dispatch, 'i1', 'Can you come up to $300?', { intent: 'counter', counter_usd: 300 }, NOW0);
  const c1 = counters(store)[0];
  assert(c1?.status === 'queued' && c1?.send_mode === 'human_queue', `DM: the first counter waits in the DM queue (${c1?.status}, ${c1?.send_mode})`);
  const m1 = await markSent(store, String(c1?.id), NOW0 + 30 * MIN);
  assert(m1.kind === 'response' && m1.status === 200, `DM: the person marks the first counter sent (got ${JSON.stringify(m1)})`);

  await step(store, dispatch, 'i2', 'Can you do $250?', { intent: 'counter', counter_usd: 250 }, NOW0 + 60 * MIN);
  const c2 = counters(store).find((r) => r.id !== c1?.id);
  assert(c2?.status === 'queued' && c2?.send_mode === 'human_queue', `DM: the second counter waits in the DM queue (${c2?.status})`);
  const c2Usd = Number(c2?.[COUNTER_OFFER_COLUMN]);
  assert(c2Usd > Number(c1?.[COUNTER_OFFER_COLUMN]), `DM: the second counter quotes more ($${c2Usd})`);

  // The person pastes c2 into Instagram but has not clicked Mark sent yet.
  const before = auditActions.length;
  await step(store, dispatch, 'i3', 'deal!', { intent: 'accept', counter_usd: null }, NOW0 + 90 * MIN);
  const after2 = store.all('outreach_messages').find((r) => r.id === c2?.id);
  assert(after2?.status === 'queued', `DM: the unsent counter is NOT superseded; it stays in the queue (got ${after2?.status})`);
  const o = offerOf(store);
  assert(o.agreed_amount_usd == null, `DM: "deal!" is NOT agreed at the older price (agreed ${o.agreed_amount_usd})`);
  assert(store.all('payment_authorizations').length === 0, 'DM: no payment authorization');
  assert(!store.all('outreach_messages').some((r) => r.message_type === 'agreement_confirmation'), 'DM: no agreement note queued');
  assert(store.all('inbound_messages').find((r) => r.id === 'i3')?.status === 'flagged', 'DM: the reply is held for a human');
  assert(auditActions.slice(before).includes('negotiation.dm_counter_unsent'), 'DM: escalated as dm_counter_unsent');
  assert(isHumanTakeover(o), `DM: the thread is in manual mode (autonomy_mode=${o.autonomy_mode})`);
  assert(emailed.length === 0, 'DM: nothing was ever emailed on a DM thread');

  // Mark sent still works on the kept draft, and its price becomes the last sent.
  const m2 = await markSent(store, String(c2?.id), NOW0 + 95 * MIN);
  assert(m2.kind === 'response' && m2.status === 200, `DM: Mark sent on the kept draft succeeds (got ${JSON.stringify(m2)})`);
  assert(lastSentOffer(store.all('outreach_messages')).usd === c2Usd, `DM: the last sent price is now the marked counter's $${c2Usd}`);

  // Still manual until someone resumes; then "deal!" closes at the confirmed price.
  await step(store, dispatch, 'i4', 'deal!', { intent: 'accept', counter_usd: null }, NOW0 + 100 * MIN);
  assert(offerOf(store).agreed_amount_usd == null, 'DM: still manual after Mark sent; nothing agreed until resumed');
  const r = await resumeAutomation(store.sb as unknown as SupabaseClient, {
    offerId: 'offer-1', firmId: 'firm-1', price: c2Usd, confirmed: true, actorLabel: 'user:ops@label-one.test', nowMs: NOW0 + 110 * MIN,
  });
  assert(r.status === 200, `DM: resume at $${c2Usd} → 200 (got ${r.status} ${JSON.stringify(r.body)})`);
  await step(store, dispatch, 'i5', 'deal!', { intent: 'accept', counter_usd: null }, NOW0 + 120 * MIN);
  assert(Number(offerOf(store).agreed_amount_usd) === c2Usd, `DM: after resume "deal!" is agreed at $${c2Usd} (got ${offerOf(store).agreed_amount_usd})`);
}

/** Resume refuses while a DM counter still waits unsent: its price is not on record. */
async function resumeRefusesWithUnsentDm() {
  const store = makeStore();
  seed(store);
  const dispatch: DispatchFn = async () => ({ ok: true, provider_message_id: 'p', resolved_to: 't@x' });
  await step(store, dispatch, 'i1', 'Can you come up to $300?', { intent: 'counter', counter_usd: 300 }, NOW0);
  await step(store, dispatch, 'i2', 'deal!', { intent: 'accept', counter_usd: null }, NOW0 + 60 * MIN);
  assert(isHumanTakeover(offerOf(store)), 'refuse: the unsent DM counter took the thread over');
  const r = await resumeAutomation(store.sb as unknown as SupabaseClient, {
    offerId: 'offer-1', firmId: 'firm-1', price: 150, confirmed: true, actorLabel: 'user:ops@label-one.test',
  });
  assert(r.status === 409 && r.body.error === 'dm_counter_unsent', `refuse: resume with a DM counter unsent → 409 (got ${r.status} ${JSON.stringify(r.body)})`);
  assert(isHumanTakeover(offerOf(store)), 'refuse: still manual');
}

/** An EMAIL thread's queued counter is still folded as before. */
async function emailStillFolds() {
  const store = makeStore();
  seed(store);
  for (const r of store.all('outreach_messages')) { r.channel = 'email'; r.send_mode = 'auto_email'; }
  const dispatch: DispatchFn = async () => ({ ok: true, provider_message_id: 'p', resolved_to: 't@x' });
  const ins = (id: string, body: string, at: number) =>
    store.seed('inbound_messages', {
      id, channel: 'email', external_id: `sim:${id}`, creator_offer_id: null, campaign_influencer_id: 'ci-1',
      from_identity: 'c@x', body, received_at: new Date(at).toISOString(), status: 'classified',
      classification: { classification: 'negotiating', confidence: 0.8 },
    });
  ins('e1', 'Can you come up to $300?', NOW0);
  script = () => ({ intent: 'counter', counter_usd: 300 });
  await runNegotiationTick(store.sb, { now: NOW0, rand: HALF, dispatch, pollGmail: noopPoll });
  ins('e2', 'Still need $300.', NOW0 + MIN);
  await runNegotiationTick(store.sb, { now: NOW0 + MIN, rand: HALF, dispatch, pollGmail: noopPoll });
  const cs = counters(store);
  assert(cs.filter((r) => r.status === 'queued').length === 1 && cs.some((r) => r.status === 'superseded'), `email: the queued counter is folded, one remains (${cs.map((r) => r.status).join(',')})`);
  assert(!isHumanTakeover(offerOf(store)), 'email: folding is not an escalation');
}

(async () => {
  console.warn = () => {};
  await proofScenario();
  await resumeRefusesWithUnsentDm();
  await emailStillFolds();
  console.log(`\ndm-unsent-counter: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
