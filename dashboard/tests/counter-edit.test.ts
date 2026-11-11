import { auditActions, auditRows } from './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
//
// tests/counter-edit.test.ts
//
// A HUMAN-EDITED COUNTER.
//
// Two findings, both confirmed with proofs:
//
//   E1  scheduleCounter recorded the engine's price, and editing the draft
//       never touched it. A label that rewrote $175 as $160 sent $160, while
//       "Last price sent" said $175 and a following "Sure, deal!" was agreed
//       and authorized at the engine's number.
//   E2  the fold skipped edited drafts, so a creator writing again while an
//       edited counter was queued got TWO counters.
//
// Now: an edit re-derives the quoted price from the edited body (or requires
// the editor to confirm it), records it on the row, and the send paths make it
// the offer's standing price. A fold supersedes an edited draft like any other
// and hands its text to a human instead of sending a second counter.
//
// Hermetic: in-memory store, mock model provider, injected dispatch/clock/rng.
//
// Run: npx tsx tests/counter-edit.test.ts

import { registerProvider } from '../src/lib/model-provider';
import { runNegotiationTick, runDispatchPass, COUNTER_OFFER_COLUMN, type DispatchFn } from '../src/lib/negotiation-tick';
import { editCounterDraft } from '../src/lib/counter-edit';
import { checkCounterEditPrice } from '../src/lib/stated-price';
import { applySentCounterPrice, readLastSentOffers } from '../src/lib/last-sent-offer';
import { HOLDING_NOTE_SUPERSEDED_STATUS } from '../src/lib/holding-note';
import { ESCALATION_AUDIT_ACTIONS } from '../src/lib/negotiation';
import { ESCALATION_AUDIT_ACTIONS as SURFACED_ACTIONS } from '../src/lib/statuses';
import { makeStore, type Row } from './negotiation-harness/store';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
const S = 1000;
const MIN = 60_000;
const HALF = () => 0.5;
const noopPoll = async () => ({ skipped: 'gmail_not_configured' as const });

type Store = ReturnType<typeof makeStore>;
type Out = { intent: string; counter_usd?: number | null };
let script: (user: string) => Out = () => ({ intent: 'unclear' });
const prompts: string[] = [];
registerProvider('mock', async ({ user }) => {
  prompts.push(user);
  return JSON.stringify({ sentiment: 'neutral', confidence: 0.9, counter_usd: null, ...script(user) });
});

function seed(store: Store): void {
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
    channel: 'email', subject: 'Collab', body: 'Hey, $100 for 1 reel + 1 story', status: 'sent',
    sent_at: '2026-07-05T15:00:00.000Z', send_after: null,
  });
}

function seedInbound(store: Store, id: string, body: string, at: number): Row {
  return store.seed('inbound_messages', {
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
const dollars = (s: string) => [...s.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
const counters = (store: Store) => store.all('outreach_messages').filter((r) => r.message_type === 'counter');
const queuedCounters = (store: Store) => counters(store).filter((r) => r.status === 'queued');
const offer = (store: Store) => store.getOffer('offer-1') as Row;

/** The creator asks $300; our $175 counter is drafted and still queued. */
async function draftedCounter() {
  const store = makeStore();
  seed(store);
  const rec = recorder(store);
  seedInbound(store, 'inb-1', 'Can you come up to $300?', NOW0);
  script = () => ({ intent: 'counter', counter_usd: 300 });
  await runNegotiationTick(store.sb, { now: NOW0, rand: HALF, dispatch: rec.dispatch, pollGmail: noopPoll });
  const draft = queuedCounters(store)[0];
  return { store, draft, ...rec };
}

// ── 1. The edit records the price its text quotes ───────────────────────────
async function editRecordsPrice() {
  {
    const { store, draft } = await draftedCounter();
    assert(Number(draft?.[COUNTER_OFFER_COLUMN]) === 150, `setup: the engine drafted $150 (got ${draft?.[COUNTER_OFFER_COLUMN]})`);
    // The text never supplies the price, even when it plainly names
    // one. Without the price field the edit is refused.
    const bare = await editCounterDraft(store.sb, { messageId: draft.id as string, body: 'Hi! We can stretch to $160 for the reel + story.' });
    assert(bare.kind === 'refused' && bare.body.error === 'price_confirmation_required' && Number(draft[COUNTER_OFFER_COLUMN]) === 150,
      `edit: "$160" in the text alone is NOT recorded; the price field is required (got ${JSON.stringify(bare)})`);
    const r = await editCounterDraft(store.sb, { messageId: draft.id as string, body: 'Hi! We can stretch to $160 for the reel + story.', confirmedOfferUsd: 160 });
    assert(r.kind === 'saved' && r.offer_usd === 160 && !r.derived, `edit: the confirmed $160 is recorded (got ${JSON.stringify(r)})`);
    assert(Number(draft[COUNTER_OFFER_COLUMN]) === 160 && draft.edited_by_user === true, `edit: the row carries $160 and is marked edited (got ${draft[COUNTER_OFFER_COLUMN]})`);
    assert(/\$160/.test(String(draft.body)), 'edit: the body is saved');
  }
  // The text no longer names a price → the editor must confirm one.
  {
    const { store, draft } = await draftedCounter();
    const r = await editCounterDraft(store.sb, { messageId: draft.id as string, body: 'Let me check with the label and come back to you.' });
    assert(r.kind === 'refused' && r.status === 422 && r.body.error === 'price_confirmation_required' && r.body.suggested_offer_usd === 150,
      `confirm: no price in the text → refused, prefilled with the draft's $150 (got ${JSON.stringify(r)})`);
    assert(!/check with the label/.test(String(draft.body)) && Number(draft[COUNTER_OFFER_COLUMN]) === 150, 'confirm: nothing is written until the price is confirmed');
    const ok = await editCounterDraft(store.sb, { messageId: draft.id as string, body: 'Let me check with the label and come back to you.', confirmedOfferUsd: 150 });
    assert(ok.kind === 'saved' && ok.offer_usd === 150 && !ok.derived, `confirm: a confirmed $150 saves (got ${JSON.stringify(ok)})`);
  }
  // Two prices in the text → not certain → confirm.
  {
    const { store, draft } = await draftedCounter();
    const body = 'I know you asked for $300; the best we can do is $170.';
    const r = await editCounterDraft(store.sb, { messageId: draft.id as string, body });
    assert(r.kind === 'refused' && r.body.error === 'price_confirmation_required', `confirm: two prices in the text need confirming (got ${JSON.stringify(r)})`);
    const ok = await editCounterDraft(store.sb, { messageId: draft.id as string, body, confirmedOfferUsd: 170 });
    assert(ok.kind === 'saved' && Number(draft[COUNTER_OFFER_COLUMN]) === 170, `confirm: confirmed $170 is recorded (got ${draft[COUNTER_OFFER_COLUMN]})`);
  }
  // A confirmation that contradicts the text is refused.
  {
    const { store, draft } = await draftedCounter();
    const r = await editCounterDraft(store.sb, { messageId: draft.id as string, body: 'We can do $160.', confirmedOfferUsd: 170 });
    assert(r.kind === 'refused' && r.body.error === 'price_mismatch' && r.body.suggested_offer_usd === 150, `mismatch: text $160 vs field $170 is refused (got ${JSON.stringify(r)})`);
    assert(Number(draft[COUNTER_OFFER_COLUMN]) === 150, 'mismatch: nothing written');
  }
  // Above the ceiling is refused.
  {
    const { store, draft } = await draftedCounter();
    const r = await editCounterDraft(store.sb, { messageId: draft.id as string, body: 'Fine, $250 it is.', confirmedOfferUsd: 250 });
    assert(r.kind === 'refused' && r.body.error === 'above_ceiling', `ceiling: $250 over a $200 ceiling is refused (got ${JSON.stringify(r)})`);
  }
  // Under the creator ceiling but over what the CAMPAIGN has left
  // (same computation finalizeAgreement checks) is refused too.
  {
    const { store, draft } = await draftedCounter();
    const camp = store.all('campaigns').find((c) => c.id === 'camp-1')!;
    camp.total_budget_usd = 1000;
    store.seedOffer({ id: 'offer-sib', campaign_influencer_id: 'ci-sib', campaign_id: 'camp-1', firm_id: 'firm-1', status: 'agreed', initial_offer_usd: 850, current_offer_usd: 850, agreed_amount_usd: 850, ceiling_usd: 900, rounds: 1 });
    const over = await editCounterDraft(store.sb, { messageId: draft.id as string, body: 'We can stretch to $160.', confirmedOfferUsd: 160 });
    assert(over.kind === 'refused' && over.body.error === 'above_budget', `budget: $160 with $150 of campaign budget left is refused (got ${JSON.stringify(over)})`);
    assert(Number(draft[COUNTER_OFFER_COLUMN]) === 150 && !/\$160/.test(String(draft.body)), 'budget: nothing written');
    const ok = await editCounterDraft(store.sb, { messageId: draft.id as string, body: 'We can hold at $150.', confirmedOfferUsd: 150 });
    assert(ok.kind === 'saved' && ok.offer_usd === 150, `budget: $150, inside what is left, saves (got ${JSON.stringify(ok)})`);
    camp.total_budget_usd = null;
    const unset = await editCounterDraft(store.sb, { messageId: draft.id as string, body: 'We can hold at $150.', confirmedOfferUsd: 150 });
    assert(unset.kind === 'refused' && unset.body.error === 'budget_unverifiable', `budget: no campaign budget → refused, fail closed (got ${JSON.stringify(unset)})`);
  }
  // No active offer → refused (fail closed), never saved unbounded.
  {
    const { store, draft } = await draftedCounter();
    offer(store).status = 'rejected';
    const r = await editCounterDraft(store.sb, { messageId: draft.id as string, body: 'We can do $160.', confirmedOfferUsd: 160 });
    assert(r.kind === 'refused' && r.status === 409 && r.body.error === 'no_active_offer', `no offer: refused (got ${JSON.stringify(r)})`);
    assert(!/\$160/.test(String(draft.body)), 'no offer: nothing written');
  }
  // Pre-059: the price cannot be recorded on the row. Keeping the standing
  // price saves; changing it is refused rather than leaving a wrong record.
  {
    const { store, draft } = await draftedCounter();
    delete draft[COUNTER_OFFER_COLUMN];
    const missing = { data: null, error: { code: 'PGRST204', message: `Could not find the '${COUNTER_OFFER_COLUMN}' column` } };
    const pre = {
      from(table: string) {
        const q = store.sb.from(table) as unknown as { select: (c?: string) => unknown; update: (p: Row) => unknown };
        if (table !== 'outreach_messages') return q;
        const sel = q.select.bind(q);
        q.select = (c?: string) => {
          if (!c || !c.includes(COUNTER_OFFER_COLUMN)) return sel(c);
          const chain: Record<string, unknown> = { maybeSingle: () => Promise.resolve(missing) };
          chain.eq = () => chain;
          return chain;
        };
        const upd = q.update.bind(q);
        q.update = (p: Row) => {
          if (!(COUNTER_OFFER_COLUMN in p)) return upd(p);
          const chain: Record<string, unknown> = { maybeSingle: () => Promise.resolve(missing) };
          chain.eq = () => chain;
          chain.select = () => chain;
          return chain;
        };
        return q;
      },
    } as unknown as Store['sb'];
    const changed = await editCounterDraft(pre, { messageId: draft.id as string, body: 'We can do $160.', confirmedOfferUsd: 160 });
    assert(changed.kind === 'refused' && changed.status === 409 && changed.body.error === 'price_not_recordable', `pre-059: a changed price is refused (got ${JSON.stringify(changed)})`);
    assert(!/\$160/.test(String(draft.body)), 'pre-059: nothing written on refusal');
    const same = await editCounterDraft(pre, { messageId: draft.id as string, body: 'Honestly, $150 is the best we can do.', confirmedOfferUsd: 150 });
    assert(same.kind === 'saved' && /best we can do/.test(String(draft.body)), `pre-059: an edit keeping the $150 standing price saves (got ${JSON.stringify(same)})`);
  }
  // Not a queued counter → edited as before.
  {
    const { store } = await draftedCounter();
    const r = await editCounterDraft(store.sb, { messageId: 'msg-first', body: 'x' });
    assert(r.kind === 'not_counter', `scope: an initial message is not a counter draft (got ${r.kind})`);
  }
}

// ── 2. Sent: the standing price, "Last price sent" and a "deal" all read $160 ──
async function editedCounterSentThenDeal() {
  const { store, draft, sent, dispatch } = await draftedCounter();
  await editCounterDraft(store.sb, { messageId: draft.id as string, body: 'Hi! We can stretch to $160 for the reel + story.', confirmedOfferUsd: 160 });
  for (let t = NOW0; t <= NOW0 + 25 * MIN; t += MIN) await runDispatchPass(store.sb, { now: t, rand: HALF, dispatch });
  assert(sent.filter((s) => s.type === 'counter').map((s) => dollars(s.body)[0]).join(',') === '160', 'sent: the edited $160 counter went');
  assert(Number(offer(store).current_offer_usd) === 160, `sent: the offer's standing price is the $160 sent (got ${offer(store).current_offer_usd})`);
  const shown = await readLastSentOffers(store.sb, [{ campaign_influencer_id: 'ci-1' }]);
  assert(shown.get('ci-1') === 160, `display: "Last price sent" reads $160 (got ${shown.get('ci-1')})`);

  const t2 = NOW0 + 60 * MIN;
  seedInbound(store, 'inb-2', 'Sure, deal!', t2);
  script = () => ({ intent: 'accept', counter_usd: null });
  await runNegotiationTick(store.sb, { now: t2, rand: HALF, dispatch, pollGmail: noopPoll });
  for (let t = t2; t <= t2 + 25 * MIN; t += MIN) await runDispatchPass(store.sb, { now: t, rand: HALF, dispatch });
  const conf = sent.find((s) => s.type === 'agreement_confirmation');
  assert(Number(offer(store).agreed_amount_usd) === 160, `deal: agreed at the $160 sent (got ${offer(store).agreed_amount_usd})`);
  assert(conf != null && dollars(conf.body)[0] === 160, `deal: confirmed as $160 (got ${conf?.body})`);
  const pa = store.all('payment_authorizations').map((p) => Number(p.amount_usd));
  assert(pa.length > 0 && pa.every((a) => a === 160), `deal: authorized at $160 (got ${pa})`);
}

// applySentCounterPrice on its own: every send path calls it.
async function sentPriceUnit() {
  const store = makeStore();
  seed(store);
  store.seed('outreach_messages', { id: 'c1', campaign_influencer_id: 'ci-1', message_type: 'counter', direction: 'outbound', status: 'sent', sent_at: '2026-07-06T01:00:00.000Z', edited_by_user: true, [COUNTER_OFFER_COLUMN]: 140 });
  await applySentCounterPrice(store.sb, 'c1');
  assert(Number(offer(store).current_offer_usd) === 140, `unit: a sent edited counter sets the standing price (got ${offer(store).current_offer_usd})`);
  store.seed('outreach_messages', { id: 'c2', campaign_influencer_id: 'ci-1', message_type: 'counter', direction: 'outbound', status: 'queued', edited_by_user: true, [COUNTER_OFFER_COLUMN]: 190 });
  await applySentCounterPrice(store.sb, 'c2');
  assert(Number(offer(store).current_offer_usd) === 140, 'unit: an unsent counter does not');
  offer(store).status = 'human_approval_required';
  store.seed('outreach_messages', { id: 'c3', campaign_influencer_id: 'ci-1', message_type: 'counter', direction: 'outbound', status: 'sent', sent_at: '2026-07-06T02:00:00.000Z', edited_by_user: true, [COUNTER_OFFER_COLUMN]: 190 });
  await applySentCounterPrice(store.sb, 'c3');
  assert(Number(offer(store).current_offer_usd) === 140, 'unit: an offer past negotiation is never moved');

  // Wire: the manual Send route and the DM queue's Mark sent call it too.
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  // Via claimAndSendManual, from the claimed row (tests/manual-send-claim.test.ts runs it).
  assert(/claimAndSendManual\(/.test(src('src/app/api/outreach/[id]/send/route.ts')), 'wire: the manual Send route records the sent counter price (claimAndSendManual)');
  assert(/applySentCounterPrice\(sb, row\.id, \{ \.\.\.row, status: 'sent' \}\)/.test(src('src/lib/outbound-claim.ts')), 'wire: claimAndSendManual records it from the claimed row');
  assert(/applySentCounterPrice\(sb, mr\.id\)/.test(src('src/lib/dm-mark-sent.ts')), 'wire: DM Mark sent records the sent counter price');
  // From the claimed row, never a fresh read (tests/stale-dispatch.test.ts runs it).
  assert(/applySentCounterPrice\(sb, row\.id, \{ \.\.\.sending, status: 'sent' \}\)/.test(src('src/lib/negotiation-tick.ts')), 'wire: the dispatch pass records the sent counter price from the claimed row');
  const route = src('src/lib/outreach-message-handlers.ts'); // the messages/[id] route's handlers
  assert(/editCounterDraft\(/.test(route) && /offer_usd/.test(route), 'wire: the edit route re-derives the counter price');
  const zod = src('src/lib/zod-schemas.ts');
  assert(/PatchOutreachMessageBody[\s\S]{0,300}offer_usd/.test(zod), 'wire: PATCH accepts a confirmed offer_usd');
  for (const ui of ['src/app/outreach/page.tsx', 'src/app/outreach/dm-queue-tab.tsx']) {
    const u = src(ui);
    assert(/offer_usd: /.test(u) && /readStatedPrice\(/.test(u) && /message_type === "counter"/.test(u), `wire: ${ui} shows a prefilled price field on a counter edit and sends it`);
    // The prefilled price is never sent on its own.
    assert(/checkCounterEditPrice\(editBody, editPrice\)/.test(u), `wire: ${ui} checks the edited text against the price field`);
    assert(/offer_usd: editCheck\.usd/.test(u) && !/offer_usd: Number\(editPrice\)/.test(u), `wire: ${ui} sends the checked price, not the raw prefilled field`);
    assert(/disabled=\{saving \|\| editBlocked\}/.test(u) && /if \(editBlocked\)/.test(u), `wire: ${ui} blocks Save until the price is confirmed or matches`);
    assert(/editCheck\.kind === "confirm" && !editPriceConfirmed/.test(u) && /setEditPriceConfirmed\(e\.target\.checked\)/.test(u), `wire: ${ui} asks for an explicit confirmation`);
    assert((u.match(/setEditPriceConfirmed\(false\)/g) ?? []).length >= 3, `wire: ${ui} clears the confirmation when the text, price or draft changes`);
  }
}

// The form's price check, pure.
function editFormCheck() {
  const k = (body: string, field: string) => checkCounterEditPrice(body, field).kind;
  assert(k('We can do $160 for the reel + story.', '160') === 'ok', 'form: the text states the field price → saves without a question');
  assert(k('Let me check with the label and come back to you.', '150') === 'confirm', 'form: no price in the text → explicit confirmation required');
  assert(k('I know you asked for $300; the best we can do is $170.', '170') === 'confirm', 'form: two prices in the text → explicit confirmation required');
  assert(k('We can do $160.', '170') === 'mismatch', 'form: text and field disagree → blocked');
  assert(k('We can do $160.', '') === 'missing' && k('We can do $160.', '0') === 'missing', 'form: no price in the field → blocked');
}

// ── 3. The fold supersedes an edited draft too: never two counters ──────────
async function editedDraftSuperseded() {
  const { store, draft, sent, dispatch } = await draftedCounter();
  await editCounterDraft(store.sb, { messageId: draft.id as string, body: 'Hi! We can do $160 for the reel + story.', confirmedOfferUsd: 160 });
  seedInbound(store, 'inb-2', 'Seriously, $300 is my rate.', NOW0 + 60 * S);
  script = () => ({ intent: 'counter', counter_usd: 300 });
  prompts.length = 0;
  auditActions.length = 0;
  let maxQueued = 0;
  const watch: DispatchFn = async (sb, m) => {
    maxQueued = Math.max(maxQueued, queuedCounters(store).length);
    return dispatch(sb, m);
  };
  await runNegotiationTick(store.sb, { now: NOW0 + 60 * S, rand: HALF, dispatch: watch, pollGmail: noopPoll });
  maxQueued = Math.max(maxQueued, queuedCounters(store).length);
  for (let t = NOW0; t <= NOW0 + 30 * MIN; t += MIN) await runDispatchPass(store.sb, { now: t, rand: HALF, dispatch: watch });

  assert(sent.filter((s) => s.type === 'counter').length === 0, `fold: no counter goes out automatically (sent ${sent.map((s) => s.type)})`);
  assert(draft.status === HOLDING_NOTE_SUPERSEDED_STATUS, `fold: the edited draft is withdrawn (got ${draft.status})`);
  assert(maxQueued <= 1, `fold: never two unsent counters on the thread (max ${maxQueued})`);
  assert(prompts.length === 0, 'fold: no model turn is taken over a human edit');
  assert(store.all('inbound_messages').find((r) => r.id === 'inb-2')?.status === 'flagged', 'fold: the new reply is in front of a human');
  assert(auditActions.includes('negotiation.edited_counter_superseded'), `fold: an anomaly is recorded (got ${auditActions})`);
  assert(Number(offer(store).rounds) === 0, `fold: the withdrawn round is given back (got ${offer(store).rounds})`);
  assert(Number(offer(store).current_offer_usd) === 100, `fold: the standing price is the $100 they saw (got ${offer(store).current_offer_usd})`);
  assert(ESCALATION_AUDIT_ACTIONS.edited_counter_superseded === 'negotiation.edited_counter_superseded', 'wire: escalation action named');
  assert(SURFACED_ACTIONS.includes('negotiation.edited_counter_superseded'), 'wire: /anomalies lists it');
}

/** The edited text reaches the human: it rides the audit detail the anomaly feed shows. */
async function editedTextInDetail() {
  const { store, draft } = await draftedCounter();
  await editCounterDraft(store.sb, { messageId: draft.id as string, body: 'Hi! We can do $160 for the reel + story.', confirmedOfferUsd: 160 });
  seedInbound(store, 'inb-2', 'Seriously, $300 is my rate.', NOW0 + 60 * S);
  script = () => ({ intent: 'counter', counter_usd: 300 });
  auditRows.length = 0;
  await runNegotiationTick(store.sb, { now: NOW0 + 60 * S, rand: HALF, dispatch: recorder(store).dispatch, pollGmail: noopPoll });
  const row = auditRows.find((r) => r.action === 'negotiation.edited_counter_superseded');
  const detail = String(row?.metadata?.detail ?? '');
  assert(/We can do \$160/.test(detail), `detail: the edited text is in the anomaly detail (got ${detail})`);
  assert(Number(row?.metadata?.edited_offer_usd) === 160, `detail: the edited price is recorded (got ${row?.metadata?.edited_offer_usd})`);
}

async function main() {
  const origWarn = console.warn;
  if (!process.env.DEBUG) console.warn = () => {};
  await editRecordsPrice();
  editFormCheck();
  await editedCounterSentThenDeal();
  await sentPriceUnit();
  await editedDraftSuperseded();
  await editedTextInDetail();
  console.warn = origWarn;
  console.log(`counter-edit test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
