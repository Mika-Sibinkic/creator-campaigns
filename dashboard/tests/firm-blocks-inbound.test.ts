import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
//
// tests/firm-blocks-inbound.test.ts
//
// The reply-intake side of a creator's
// STOP, and the manual "Log response" door.
//
//   A. STOP vs a later-scheduled counter. Ingest blocks the creator and cancels
//      what is queued, but the negotiation tick used to negotiate the pending
//      inbound anyway — a "$300?" followed by "STOP" got a counter queued (held
//      forever by the dispatch gate) and the offer moved a round. The tick now
//      reads the per-label rule (firm-blocks.checkDoNotContact) BEFORE it
//      negotiates: blocked → no turn, no round, inbound processed with a
//      reason; unreadable list → held, retried next tick.
//   B. A retried STOP. If the outreach_messages mirror insert failed after the
//      inbound row was written, the retry was deduped on (channel, external_id)
//      and the block + cancel never ran. The opt-out now runs before that
//      insert and again, idempotently, on the dedupe path.
//   C. "Log response" of a reply that already arrived. Ingest deduped on
//      (channel, external_id) only, so pasting a reply the email provider had
//      delivered opened a second negotiation turn. An operator paste is now
//      compared by normalized body against the thread's last 14 days and
//      refused with 409 "already came in"; a provider delivery never is.
//   D. /approvals and the deal row say "Creator opted out" (or blocked, or
//      "not checked" when the list is unreadable) before anyone approves a
//      payment. Display only: no payment decision reads the flag.
//
// Hermetic: in-memory store, mock model provider, injected dispatch/clock/rng.
//
// Run: npx tsx tests/firm-blocks-inbound.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { registerProvider } from '../src/lib/model-provider';
import { runNegotiationTick, runDispatchPass, type DispatchFn } from '../src/lib/negotiation-tick';
import { ingestInboundReply, normalizeReplyForDedupe, sameReplyForDedupe, compareReplyForDedupe, type NormalizedInbound } from '../src/lib/ingest-inbound';
import { logManualEmailReply } from '../src/lib/manual-email-reply';
import { FIRM_BLOCKS_TABLE, readDoNotContactFlags } from '../src/lib/firm-blocks';
import { doNotContactForApprovals, type PendingApprovalRow } from '../src/lib/approvals-query';
import { doNotContactNotice } from '../src/lib/do-not-contact-copy';
import { isPossibleDuplicate } from '../src/lib/statuses';
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

registerProvider('mock', async ({ user }) => {
  const m = [...user.matchAll(/\$(\d{3})/g)].map((x) => Number(x[1])).filter((n) => n === 300 || n === 250);
  if (m.length) return JSON.stringify({ intent: 'counter', counter_usd: m[m.length - 1], sentiment: 'neutral', confidence: 0.9 });
  return JSON.stringify({ intent: 'unclear', counter_usd: null, sentiment: 'neutral', confidence: 0.9 });
});

const T0 = Date.parse('2026-07-06T16:00:00.000Z'); // 11:00 at -5, inside the send window
const MIN = 60_000;
const rand = () => 0.5;
const noPoll = async () => ({ skipped: 'gmail_not_configured' as const });
type Store = ReturnType<typeof makeStore>;

function world(): Store {
  const store = makeStore();
  store.seed('firms', { id: 'firm-1', name: 'Example Records', sender_name: null, outreach_prefs: {}, scraping_prefs: {} });
  store.seed('firms', { id: 'firm-2', name: 'Other label', sender_name: null, outreach_prefs: {}, scraping_prefs: {} });
  store.seed('campaigns', { id: 'camp-1', firm_id: 'firm-1', total_budget_usd: 1_000_000 });
  store.seed('campaign_influencers', {
    id: 'ci-1', campaign_id: 'camp-1', influencer_id: 'inf-1', status: 'contacted',
    last_response_at: '2026-07-05T00:00:00Z', qualification_status: 'qualified', bot_flagged: false,
  });
  store.seed('influencers', { id: 'inf-1', blocklisted: false, contact_email: 'c@x', follower_count: 40_000 });
  store.seedOffer({
    id: 'offer-1', campaign_influencer_id: 'ci-1', campaign_id: 'camp-1', firm_id: 'firm-1', status: 'offered',
    initial_offer_usd: 100, current_offer_usd: 100, agreed_amount_usd: null, ceiling_usd: 200, rounds: 0,
    last_message_id: null, approved_at: null, approved_by_user_id: null, paid_at: null, posted_at: null,
    post_url: null, autonomy_mode: 'auto', opening_pct: null, injection_flagged: false,
    created_at: '2026-07-06T00:00:00.000Z', updated_at: '2026-07-06T00:00:00.000Z',
  });
  store.seed('outreach_messages', {
    id: 'msg-first', campaign_influencer_id: 'ci-1', message_type: 'initial', direction: 'outbound',
    channel: 'email', subject: 'Collab?', body: 'hi', status: 'sent', sent_at: '2026-07-05T15:00:00.000Z', send_after: null,
  });
  return store;
}

const ingest = (sb: SupabaseClient, ext: string, body: string, at: number) =>
  ingestInboundReply(
    { channel: 'email', external_id: ext, from_identity: 'c@x', body, campaign_influencer_id: 'ci-1', received_at: new Date(at).toISOString() },
    sb,
  );

function recorder(store: Store): { sent: string[]; dispatch: DispatchFn } {
  const sent: string[] = [];
  return {
    sent,
    dispatch: async (_sb, m) => {
      sent.push(String(store.all('outreach_messages').find((r) => r.id === m.id)?.message_type));
      return { ok: true, provider_message_id: 'p', resolved_to: 't@x' };
    },
  };
}

const aiOutbound = (store: Store) =>
  store.all('outreach_messages').filter((r) => r.direction === 'outbound' && r.id !== 'msg-first');

/** Every query against `table` resolves to `error` (PostgREST shape). */
function failTable(sb: SupabaseClient, table: string, error: { code: string; message: string }): SupabaseClient {
  const res = { data: null, error };
  const node: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'lte', 'lt', 'gte']) {
    node[m] = () => node;
  }
  node.single = async () => res;
  node.maybeSingle = async () => res;
  node.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(res).then(ok, err);
  return { from: (t: string) => (t === table ? node : sb.from(t)) } as unknown as SupabaseClient;
}

// ── A. The tick reads the block before it negotiates ────────────────────────

async function stopBeforeTick() {
  // The reviewer's exact sequence: "$300?" then STOP 30s later, one tick.
  const store = world();
  const { sent, dispatch } = recorder(store);
  await ingest(store.sb, 'resend:a', 'Can you come up to $300?', T0);
  await ingest(store.sb, 'resend:b', 'STOP', T0 + 30_000);
  assert(store.all(FIRM_BLOCKS_TABLE).length === 1, 'A: STOP wrote the per-label block at ingest');
  const t = await runNegotiationTick(store.sb, { now: T0 + MIN, rand, dispatch, pollGmail: noPoll });
  assert(aiOutbound(store).length === 0, `A: no counter and no holding note are queued for a creator who said STOP (got ${aiOutbound(store).map((r) => `${r.message_type}:${r.status}`).join(',')})`);
  const offer = store.getOffer('offer-1')!;
  assert(offer.rounds === 0 && offer.current_offer_usd === 100 && offer.status === 'offered', `A: the offer does not move (rounds ${offer.rounds}, $${offer.current_offer_usd}, ${offer.status})`);
  const inb = store.all('inbound_messages');
  assert(inb.every((r) => r.status === 'processed'), `A: both inbound rows leave the pending set (${inb.map((r) => r.status).join(',')})`);
  assert(
    inb.every((r) => (r.classification as Record<string, unknown> | null)?.negotiation_skipped === 'creator_opted_out'),
    'A: each inbound row records WHY it was not negotiated',
  );
  assert(
    inb.every((r) => (r.classification as Record<string, unknown> | null)?.classification != null),
    'A: the reason is merged in, the ingest classification is kept',
  );
  assert(t.processed === 2 && t.flagged === 0, `A: tallied as processed (processed=${t.processed}, flagged=${t.flagged})`);
  for (let s = T0 + 2 * MIN; s < T0 + 20 * MIN; s += MIN) await runDispatchPass(store.sb, { now: s, rand, dispatch });
  assert(sent.length === 0, `A: nothing is ever sent (sent=${sent.join(',')})`);
}

async function labelBlockAfterIngest() {
  // A label user blocks the creator AFTER the reply landed but before the tick.
  const store = world();
  const { dispatch } = recorder(store);
  await ingest(store.sb, 'resend:a', 'Can you come up to $300?', T0);
  store.seed(FIRM_BLOCKS_TABLE, { firm_id: 'firm-1', influencer_id: 'inf-1', source: 'label_user' });
  await runNegotiationTick(store.sb, { now: T0 + MIN, rand, dispatch, pollGmail: noPoll });
  assert(aiOutbound(store).length === 0, 'A: a label block placed after ingest still stops the turn');
  assert(store.getOffer('offer-1')!.rounds === 0, 'A: and the offer does not move');
  const r = store.all('inbound_messages')[0];
  assert(
    r.status === 'processed' && (r.classification as Record<string, unknown>)?.negotiation_skipped === 'creator_blocked',
    `A: a label block is recorded as blocked, not as an opt-out (${JSON.stringify(r.classification)})`,
  );

  // The global flag is the same rule.
  const g = world();
  await ingest(g.sb, 'resend:a', 'Can you come up to $300?', T0);
  g.all('influencers')[0].blocklisted = true;
  await runNegotiationTick(g.sb, { now: T0 + MIN, rand, dispatch: recorder(g).dispatch, pollGmail: noPoll });
  assert(aiOutbound(g).length === 0 && g.getOffer('offer-1')!.rounds === 0, 'A: a platform-wide block stops the turn too');
}

async function otherLabelsBlockDoesNotApply() {
  const store = world();
  const { dispatch } = recorder(store);
  await ingest(store.sb, 'resend:a', 'Can you come up to $300?', T0);
  store.seed(FIRM_BLOCKS_TABLE, { firm_id: 'firm-2', influencer_id: 'inf-1', source: 'creator_opt_out' });
  await runNegotiationTick(store.sb, { now: T0 + MIN, rand, dispatch, pollGmail: noPoll });
  assert(aiOutbound(store).some((r) => r.message_type === 'counter'), 'A: another label\'s block does not stop THIS label\'s negotiation');
  assert(store.getOffer('offer-1')!.rounds === 1, 'A: the offer moves one round as normal');
}

async function unreadableBlocksHold() {
  const store = world();
  const { dispatch } = recorder(store);
  await ingest(store.sb, 'resend:a', 'Can you come up to $300?', T0);
  const broken = failTable(store.sb, FIRM_BLOCKS_TABLE, { code: '57014', message: 'canceling statement due to statement timeout' });
  const t = await runNegotiationTick(broken, { now: T0 + MIN, rand, dispatch, pollGmail: noPoll });
  assert(aiOutbound(store).length === 0, 'A: an unreadable block list holds the turn (fails closed)');
  assert(store.getOffer('offer-1')!.rounds === 0, 'A: held means the offer does not move');
  const r = store.all('inbound_messages')[0];
  assert(r.status === 'classified', `A: held means still pending, retried next tick (got ${r.status})`);
  assert(r.claimed_at == null, 'A: the claim is released so the next tick does not wait out the TTL');
  assert(t.skipped === 1, `A: tallied as skipped (got ${t.skipped})`);
  // Next tick, list readable again → negotiated.
  await runNegotiationTick(store.sb, { now: T0 + 6 * MIN, rand, dispatch, pollGmail: noPoll });
  assert(aiOutbound(store).some((r2) => r2.message_type === 'counter'), 'A: once readable, the held reply is negotiated');

  // Pre-056 (table missing) is "no per-label blocks", exactly as dispatch reads it.
  const pre = world();
  await ingest(pre.sb, 'resend:a', 'Can you come up to $300?', T0);
  const missing = failTable(pre.sb, FIRM_BLOCKS_TABLE, { code: 'PGRST205', message: `Could not find the table 'public.${FIRM_BLOCKS_TABLE}' in the schema cache` });
  await runNegotiationTick(missing, { now: T0 + MIN, rand, dispatch: recorder(pre).dispatch, pollGmail: noPoll });
  assert(aiOutbound(pre).some((r2) => r2.message_type === 'counter'), 'A: pre-056 the tick negotiates as before');
}

// ── B. A retried STOP still blocks and cancels ──────────────────────────────

/** outreach_messages INSERTs of inbound rows fail while `failing.on` is true. */
function failInboundMirror(sb: SupabaseClient, failing: { on: boolean }): SupabaseClient {
  return {
    from(t: string) {
      const q = sb.from(t) as unknown as { insert: (p: Row) => unknown };
      if (t !== 'outreach_messages') return q;
      const orig = q.insert.bind(q);
      q.insert = (p: Row) => {
        if (!failing.on || p.direction !== 'inbound') return orig(p);
        const res = Promise.resolve({ data: null, error: { code: '08006', message: 'connection failure' } });
        const node: Record<string, unknown> = {};
        node.select = () => node;
        node.single = () => res;
        node.then = (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => res.then(f, r);
        return node;
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

async function retriedStop() {
  const store = world();
  const failing = { on: true };
  const sb = failInboundMirror(store.sb, failing);
  let threw = false;
  try {
    await ingest(sb, 'resend:stop-1', 'STOP', T0);
  } catch {
    threw = true;
  }
  assert(threw, 'B: the mirror insert failure surfaces (the webhook 5xx-es and the provider retries)');
  assert(store.all('inbound_messages').length === 1, 'B: the inbound row was written before the failure');
  assert(store.all(FIRM_BLOCKS_TABLE).length === 1, 'B: the opt-out ran BEFORE the failing insert, so it is not lost');

  // Between the failed attempt and the retry, something queues a message to
  // this creator (a counter from an earlier reply, a follow-up).
  store.seed('outreach_messages', {
    id: 'late-queued', campaign_influencer_id: 'ci-1', message_type: 'counter', direction: 'outbound', channel: 'email',
    subject: 's', body: 'b', status: 'queued', send_mode: 'auto_email', send_after: new Date(T0 + 5 * MIN).toISOString(),
  });
  // The block must also hold if the first attempt's block write had been the
  // thing that failed: remove it and let the retry restore it.
  store.all(FIRM_BLOCKS_TABLE).length = 0;

  failing.on = false;
  const res = await ingest(sb, 'resend:stop-1', 'STOP', T0);
  assert(res.deduped === true, 'B: the retry is deduped on (channel, external_id)');
  assert(store.all(FIRM_BLOCKS_TABLE).length === 1, 'B: the deduped retry still writes the block (idempotent)');
  const late = store.all('outreach_messages').find((r) => r.id === 'late-queued');
  assert(late?.status === 'superseded', `B: the deduped retry cancels what was queued since (got ${late?.status})`);

  // A third delivery changes nothing and does not duplicate the block.
  await ingest(sb, 'resend:stop-1', 'STOP', T0);
  assert(store.all(FIRM_BLOCKS_TABLE).length === 1, 'B: repeated deliveries leave exactly one block row');

  // A deduped NON-opt-out reply does not block anyone.
  const s2 = world();
  await ingest(s2.sb, 'resend:x', 'Can you come up to $300?', T0);
  await ingest(s2.sb, 'resend:x', 'Can you come up to $300?', T0);
  assert(s2.all(FIRM_BLOCKS_TABLE).length === 0, 'B: a deduped ordinary reply writes no block');
}

// ── C. "Log response" of a reply that already arrived ───────────────────────

function pureNormalize() {
  const n = normalizeReplyForDedupe;
  assert(n('Can you come up to $300?') === n('  can you COME up   to $300?  '), 'C: case and whitespace are folded');
  assert(
    n('Can you come up to $300?') ===
      n('Can you come up to $300?\n\nOn Mon, Jul 6, 2026 at 11:00 AM Example Records <a@b.test> wrote:\n> Collab?\n> hi'),
    'C: the quoted chain a paste drags along is cut',
  );
  assert(n('Can you come up to $300?') === n('> earlier line\nCan you come up to $300?\n\nSent from my iPhone'), 'C: quote lines and a phone trailer are cut');
  assert(n('“Can you come up to $300?”') === n('"can you come up to $300?"'), 'C: surrounding and curly quotes are folded');
  assert(n('Can you come up to $300?') !== n('Can you come up to $250?'), 'C: a different number is a different reply');
  assert(n('> only quoted') === '' && n('   ') === '', 'C: nothing left means nothing to match');
}

function manualDeps(store: Store) {
  const loadLead = async (ciId: string) => {
    const ci = store.all('campaign_influencers').find((c) => c.id === ciId);
    if (!ci) return null;
    const camp = store.all('campaigns').find((c) => c.id === ci.campaign_id);
    return { firm_id: (camp?.firm_id as string) ?? null };
  };
  return { callerFirmId: 'firm-1', loadLead, ingest: (n: NormalizedInbound) => ingestInboundReply(n, store.sb) };
}

async function pasteAfterAutoIngest() {
  // The reviewer's sequence: the email arrives on its own, the tick answers,
  // then an operator sees it in the inbox and pastes it into "Log response".
  //
  // A paste is stamped with the real clock (the route sets no received_at), so
  // this section runs YESTERDAY at 16:00Z — 11:00 at the -5 default, inside
  // the send window — rather than on the fixed July date above, which would
  // put every paste months outside the 14-day window.
  const T0 = Date.parse(`${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}T16:00:00.000Z`);
  const store = world();
  const { sent, dispatch } = recorder(store);
  const body = 'Can you come up to $300?';
  await ingest(store.sb, 'resend:abc', body, T0);
  await runNegotiationTick(store.sb, { now: T0 + MIN, rand, dispatch, pollGmail: noPoll });
  for (let t = T0 + 2 * MIN; t < T0 + 12 * MIN; t += MIN) await runDispatchPass(store.sb, { now: t, rand, dispatch });
  const rounds1 = store.getOffer('offer-1')!.rounds;
  const inboundBefore = store.all('inbound_messages').length;

  const res = await logManualEmailReply({
    input: {
      campaign_influencer_id: 'ci-1',
      response_text: '  can you come up to $300? \n\nOn Mon, Jul 6, 2026 at 10:00 AM Example Records <a@b.test> wrote:\n> Collab?',
      submission_id: 'paste-1',
    },
    ...manualDeps(store),
  });
  assert(!res.ok && res.status === 409 && res.error === 'already_received', `C: the paste is refused as already received (got ${JSON.stringify(res)})`);
  assert(!res.ok && /already came in on [A-Z][a-z]{2} [0-9]{1,2},/.test(res.message) && /nothing new was logged/.test(res.message), `C: the message says it is in, and when (got ${!res.ok ? res.message : ''})`);
  assert(store.all('inbound_messages').length === inboundBefore, 'C: nothing new is written');
  await runNegotiationTick(store.sb, { now: T0 + 13 * MIN, rand, dispatch, pollGmail: noPoll });
  for (let t = T0 + 14 * MIN; t < T0 + 30 * MIN; t += MIN) await runDispatchPass(store.sb, { now: t, rand, dispatch });
  assert(store.getOffer('offer-1')!.rounds === rounds1, `C: no second negotiation turn (rounds ${rounds1} → ${store.getOffer('offer-1')!.rounds})`);
  assert(sent.join('>') === 'holding_note>counter', `C: the creator got one answer (sent ${sent.join('>')})`);

  // The same paste twice under two submissions: the second is refused too.
  // (over CONTENT_DEDUPE_MIN_CHARS, so it is a real match.)
  const s2 = world();
  const deps2 = manualDeps(s2);
  const DEAL = 'Deal at $300 then, send it over.';
  const first = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: DEAL, submission_id: 's-1' }, ...deps2 });
  const second = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: DEAL.toLowerCase(), submission_id: 's-2' }, ...deps2 });
  assert(first.ok && !second.ok && second.status === 409, 'C: a double paste under a fresh submission id is refused');
  // A retried submission (same id) is still the quiet external-id dedupe, not an error.
  const retry = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: DEAL, submission_id: 's-1' }, ...deps2 });
  assert(retry.ok && retry.ingest.deduped, 'C: a retried submission is still deduped quietly');

  // What is NOT a duplicate.
  const s3 = world();
  const deps3 = manualDeps(s3);
  await ingest(s3.sb, 'resend:abc', body, T0);
  const different = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: 'Can you come up to $250?', submission_id: 'd-1' }, ...deps3 });
  assert(different.ok && !different.ingest.deduped, 'C: a different reply is logged');
  const s4 = world();
  await ingest(s4.sb, 'resend:old', body, T0 - 15 * 86_400_000);
  const old = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: body, submission_id: 'o-1' }, ...manualDeps(s4) });
  assert(old.ok && !old.ingest.deduped, 'C: the same words more than 14 days later are a new reply');
  const s5 = world();
  s5.seed('campaign_influencers', { id: 'ci-2', campaign_id: 'camp-1', influencer_id: 'inf-2' });
  await ingest(s5.sb, 'resend:abc', body, T0);
  const otherThread = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-2', response_text: body, submission_id: 't-1' }, ...manualDeps(s5) });
  assert(otherThread.ok && !otherThread.ingest.deduped, 'C: the same words on another thread are not a duplicate');

  // A provider delivery is never dropped for looking like a paste: it lands
  // (it carries the evidence columns), as the canonical copy of the paste.
  const s6 = world();
  await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: body, submission_id: 'p-1' }, ...manualDeps(s6) });
  const provider = await ingest(s6.sb, 'resend:later', body, T0 + MIN);
  assert(!provider.deduped && s6.all('inbound_messages').length === 2, 'C: the provider copy still lands (it carries the evidence columns)');

  // Wire-up: the page treats 409 as "already in", not as a failure.
  const page = readFileSync(join(__dirname, '../src/app/outreach/page.tsx'), 'utf8');
  assert(/res\.status === 409[\s\S]{0,400}toast\.info/.test(page), 'C: the Log response form shows a 409 as an info toast');
}

// ── C2. Paste-then-provider is one turn; a real repeat is not refused
//
// F3: content dedupe ran only for `manual:` ids, so a paste followed by the
// Gmail/Resend delivery of the same email opened a SECOND turn. The provider
// copy is now recorded (evidence of record) as the canonical copy of the
// paste, already answered by the paste's turn, with no mirror row and no turn.
// F5: dedupe used to refuse any same-words reply inside 14 days, so a creator
// who says "sounds good" again next week could not have it logged. Now only a
// non-trivial body matching a reply still unanswered, or one inside 48h.

async function pasteThenProvider() {
  const T0 = Date.parse(`${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}T16:00:00.000Z`);
  const body = 'Can you come up to $300? I usually get more than that.';
  // Both orders, through the real tick: one turn, one answer, same rounds.
  for (const order of [['paste', 'gmail'], ['gmail', 'paste']] as const) {
    const store = world();
    const { sent, dispatch } = recorder(store);
    let t = T0;
    const results: Array<{ deduped: boolean; canonical?: string | null; status?: number }> = [];
    for (const src of order) {
      if (src === 'paste') {
        const r = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: body, submission_id: `sub-${t}` }, ...manualDeps(store) });
        results.push(r.ok ? { deduped: r.ingest.deduped } : { deduped: true, status: r.status });
      } else {
        const r = await ingest(store.sb, 'gmail:18f00', body, t);
        results.push({ deduped: r.deduped, canonical: r.canonical_copy_of?.inbound_message_id ?? null });
      }
      await runNegotiationTick(store.sb, { now: t, rand, dispatch, pollGmail: noPoll });
      for (let u = t; u <= t + 20 * MIN; u += MIN) await runDispatchPass(store.sb, { now: u, rand, dispatch });
      t += 30 * MIN;
    }
    const o = store.getOffer('offer-1')!;
    const label = order.join('→');
    assert(Number(o.rounds) === 1, `C2 ${label}: ONE negotiation turn (rounds ${o.rounds})`);
    assert(sent.filter((x) => x === 'counter').length === 1, `C2 ${label}: the creator gets one counter (sent ${sent.join('>')})`);
    assert(Number(o.current_offer_usd) === 150, `C2 ${label}: the offer moved once, to $150 (got ${o.current_offer_usd})`);
    const inbound = store.all('inbound_messages');
    const pending = inbound.filter((r) => r.status === 'new' || r.status === 'classified');
    assert(pending.length === 0, `C2 ${label}: nothing is left pending for a later tick (${pending.length})`);
    const mirrors = store.all('outreach_messages').filter((r) => r.direction === 'inbound');
    assert(mirrors.length === 1, `C2 ${label}: the thread shows the reply once (${mirrors.length} inbound rows)`);
    if (order[0] === 'paste') {
      const gmail = inbound.find((r) => r.external_id === 'gmail:18f00');
      const paste = inbound.find((r) => String(r.external_id).startsWith('manual:'));
      assert(!!gmail, 'C2 paste→gmail: the provider copy is recorded (evidence of record)');
      assert(gmail?.status === 'processed', `C2 paste→gmail: the provider copy is not a pending turn (got ${gmail?.status})`);
      assert(gmail?.answered_by_inbound_id === paste?.id, 'C2 paste→gmail: linked to the paste whose turn answered it');
      const cls = gmail?.classification as Record<string, unknown> | undefined;
      assert(cls?.duplicate_of_paste === paste?.id, 'C2 paste→gmail: the classification says which paste it duplicates');
      assert(results[1]?.canonical === paste?.id && results[1]?.deduped === false, 'C2 paste→gmail: ingest reports the canonical copy, not a drop');
    } else {
      assert(results[1]?.status === 409, 'C2 gmail→paste: the paste is still refused as already received');
    }
  }

  // Pre-058: no link column. The copy is still recorded, processed, linked in classification.
  {
    const store = world();
    await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: body, submission_id: 'p-058' }, ...manualDeps(store) });
    const sb = {
      from(table: string) {
        const q = store.sb.from(table) as unknown as { insert: (p: Row) => unknown };
        if (table !== 'inbound_messages') return q;
        const ins = q.insert.bind(q);
        q.insert = (p: Row) =>
          'answered_by_inbound_id' in p
            ? { select: () => ({ single: async () => ({ data: null, error: { code: 'PGRST204', message: "Could not find the 'answered_by_inbound_id' column" } }) }) }
            : ins(p);
        return q;
      },
    } as unknown as SupabaseClient;
    const r = await ingest(sb, 'resend:pre058', body, T0 + MIN);
    const row = store.all('inbound_messages').find((x) => x.external_id === 'resend:pre058');
    assert(!!r.canonical_copy_of && row?.status === 'processed', 'C2 pre-058: the copy is recorded as processed without the link column');
    assert((row?.classification as Record<string, unknown>)?.duplicate_of_paste === r.canonical_copy_of?.inbound_message_id, 'C2 pre-058: the link survives in classification');
  }

  // The lookup runs on every provider delivery now: if it THROWS, the delivery
  // is still ingested as an ordinary reply, never lost.
  {
    const store = world();
    const sb = {
      from(table: string) {
        const q = store.sb.from(table) as unknown as { gte: () => unknown };
        if (table === 'inbound_messages') {
          q.gte = () => {
            throw new Error('read refused');
          };
        }
        return q;
      },
    } as unknown as SupabaseClient;
    const r = await ingest(sb, 'gmail:throws', body, T0);
    assert(!r.deduped && r.inbound_message_id != null, 'C2: a failed dedupe lookup never costs a provider delivery its ingest');
  }

  // A provider copy only folds into a PASTE, never into another provider delivery.
  {
    const store = world();
    await ingest(store.sb, 'resend:one', body, T0);
    const r = await ingest(store.sb, 'gmail:two', body, T0 + MIN);
    assert(!r.canonical_copy_of && !r.deduped, 'C2: two provider deliveries with the same words are two replies');
  }
}

async function legitimateRepeats() {
  const T0 = Date.parse(`${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}T16:00:00.000Z`);
  const DAY = 86_400_000;
  // F5 (a): a short reply repeated is never refused, even minutes apart.
  {
    const store = world();
    await ingest(store.sb, 'resend:a', 'Sounds good!', T0 - 3 * DAY);
    const again = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: 'Sounds good!', submission_id: 'sg-1' }, ...manualDeps(store) });
    assert(again.ok && !again.ingest.deduped, 'C2/F5: "Sounds good!" again, days later, is logged');
    const soon = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: 'Sounds good!', submission_id: 'sg-2' }, ...manualDeps(store) });
    assert(soon.ok && !soon.ingest.deduped, 'C2/F5: a short reply is never refused, even inside 48h');
    const store2 = world();
    await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: 'ok works for me', submission_id: 'ok-1' }, ...manualDeps(store2) });
    const p = await ingest(store2.sb, 'gmail:ok', 'ok works for me', T0 + MIN);
    assert(!p.canonical_copy_of, 'C2/F5: a short provider reply is never folded into a short paste');
  }
  // F5 (b): a non-trivial reply ANSWERED more than 48h ago, repeated, is a new reply.
  {
    const store = world();
    const long = 'Can you come up to $300? I usually get more than that.';
    const earlier = await ingest(store.sb, 'resend:old', long, T0 - 3 * DAY);
    const row = store.all('inbound_messages').find((r) => r.id === earlier.inbound_message_id);
    if (row) row.status = 'processed';
    const again = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: long, submission_id: 'r-1' }, ...manualDeps(store) });
    assert(again.ok && !again.ingest.deduped, 'C2/F5: an answered reply from 3 days ago, repeated, is logged');
  }
  // F5 (c): …but one still UNANSWERED (pending or held for a human) is the same reply.
  for (const status of ['classified', 'flagged']) {
    const store = world();
    const long = 'Can you come up to $300? I usually get more than that.';
    const earlier = await ingest(store.sb, 'resend:old', long, T0 - 3 * DAY);
    const row = store.all('inbound_messages').find((r) => r.id === earlier.inbound_message_id);
    if (row) row.status = status;
    const again = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: long, submission_id: 'r-2' }, ...manualDeps(store) });
    assert(!again.ok && again.status === 409, `C2/F5: a ${status} reply from 3 days ago, pasted, is still refused`);
  }
  // F5 (d): answered inside 48h is still a duplicate (the reviewer's paste case).
  {
    const store = world();
    const long = 'Can you come up to $300? I usually get more than that.';
    // A paste is stamped with the real clock, so "40h ago" is measured from now.
    const earlier = await ingest(store.sb, 'resend:recent', long, Date.now() - 40 * 3_600_000);
    const row = store.all('inbound_messages').find((r) => r.id === earlier.inbound_message_id);
    if (row) row.status = 'processed';
    const again = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: long, submission_id: 'r-3' }, ...manualDeps(store) });
    assert(!again.ok && again.status === 409, 'C2/F5: an answered reply from 40h ago, pasted, is refused');
  }
}

// ── C3. Near-duplicates ──────────────────────────────────────────
// The comparison was exact after normalizing, so a provider copy carrying a
// sign-off ("Thanks,\nJane") missed the paste of the same email and opened a
// second turn. Now: quoted history and signatures are cut, then containment
// (only a short, figure-free greeting or sign-off left over) or token
// similarity >= 0.9 with every figure identical. Same thread, same 48h /
// unanswered window, same > 20-char floor.
//
// Only EXACT equality after stripping greeting, sign-off,
// quoted history, whitespace, punctuation and case may drop a reply. A looser
// near-match would also match "I am NOT able" and "next week" for "this week", so a
// near-match is now 'similar': recorded, never dropped, never negotiated, and
// the thread goes to a human (see nearDuplicatesRound6).
async function nearDuplicates() {
  const same = sameReplyForDedupe;
  const paste = 'Ok, $180 works for me, send over the details.';
  assert(same('Ok, $180 works for me, send over the details.\n\nThanks,\nJane\n@janecreates', paste), 'C3: a sign-off and handle under the reply still match');
  assert(same('Ok, $180 works for me, send over the details.\n\nThanks,\nJane\n@janecreates\n\nOn Mon, Sep 29, 2026 at 3:14 PM Example Records <deals@label-one.example> wrote:\n> I can do $150', paste), 'C3: sign-off plus quoted history still match');
  assert(same('Ok, $180 works for me, send over the details.\n\nSent from my iPhone', paste), 'C3: a phone trailer still matches');
  assert(same('Ok, $180 works for me,\nsend over the details.', 'Ok, $180 works for me, send over the details'), 'C3: line wrap and a dropped full stop still match');
  // Only the greeting word and a KNOWN name (creator, label, sender) are stripped.
  assert(same('Hi Owen,\n\nOk, $180 works for me, send over the details.', paste, ['Owen']), 'C3: a greeting to a known name the paste left out still matches');
  assert(!same('Hi Owen,\n\nOk, $180 works for me, send over the details.', paste), 'C3/r7: a name nobody told the comparator about is content, never stripped');
  assert(same('Best,\nJane', 'Best,\nJane') === false, 'C3: nothing left after the sign-off is never a match');
  const long = 'Can you come up to $300? I usually get more than that for one reel and one story, but I like the song a lot.';
  assert(!same(long, long.replace('I like', 'I really like')) && compareReplyForDedupe(long, long.replace('I like', 'I really like')) === 'similar', 'C3/r6: one extra word in a long reply is SIMILAR, not the same (a human reviews it)');
  // Not the same reply.
  assert(!same('Ok, $190 works for me, send over the details.', paste), 'C3: a different figure is never the same reply');
  assert(!same(long, long.replace('$300', '$250')), 'C3: a changed figure in a long reply is never the same reply, however similar');
  assert(!same(`${paste} Also could we swap the story for a second reel next week?`, paste), 'C3: new content after the pasted text is a different reply');
  assert(!same(`${paste}\nThanks!\nActually, could we do two reels instead of the story, would that be possible for you?`, paste), 'C3: a sign-off followed by real content is not cut');
  assert(!same(`${paste} I can post 2 reels.`, paste), 'C3: extra content with a figure is a different reply');
  assert(!same('ok works for me', 'ok works for me, thanks'), 'C3: short replies stay exact-only (<= 20 chars never match)');
  assert(!same('Can you do $300 for the reel?', 'Can you do $300 for the story and a reel? And when do you need it by?'), 'C3: overlapping but different asks do not match');
  assert(same('Ok, $180 works for me, send over the details.\n\nThanks,\nJane Doe\nCreator, Lifestyle & Music\n@janecreates | janecreates.com', paste), 'C3: a multi-line signature under a sign-off is cut');
  assert(!same(`${paste} Actually not yet`, paste), 'C3: a few extra words that change the meaning are a different reply');
  assert(!same(long, 'Can you come up to $300? I usually get more than that for one reel and one story, and I would need the audio first.'), 'C3: ~0.7 similar with the same figure is still a different reply');

  // Through ingest, both orders.
  const T1 = Date.parse(`${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}T16:00:00.000Z`);
  const signed = 'Ok, $180 works for me, send over the details.\n\nThanks,\nJane\n@janecreates';
  {
    const store = world();
    const p = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: paste, submission_id: 'nd-1' }, ...manualDeps(store) });
    assert(p.ok && !p.ingest.deduped, 'C3 paste→provider: the paste is logged');
    const r = await ingest(store.sb, 'gmail:nd', signed, T1 + MIN);
    assert(!!r.canonical_copy_of && !r.deduped, `C3 paste→provider: the signed provider copy is the paste's canonical copy (got ${JSON.stringify(r.canonical_copy_of)})`);
    const row = store.all('inbound_messages').find((x) => x.external_id === 'gmail:nd');
    assert(row?.status === 'processed', `C3 paste→provider: no second turn (status ${row?.status})`);
    // A greeting the paste left out as well: only the comparator, not the
    // normalizer, can see these are one email.
    const s2 = world();
    const firm = s2.all('firms').find((f) => f.id === 'firm-1');
    if (firm) firm.sender_name = 'Owen'; // The sender the greeting names
    await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: paste, submission_id: 'nd-1b' }, ...manualDeps(s2) });
    const g = await ingest(s2.sb, 'gmail:nd-hi', `Hi Owen,\n\n${signed}`, T1 + MIN);
    assert(!!g.canonical_copy_of, 'C3 paste→provider: a greeting plus sign-off copy is the paste\'s canonical copy');
  }
  {
    const store = world();
    await ingest(store.sb, 'resend:nd', signed, Date.now() - 10 * MIN);
    const p = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: paste, submission_id: 'nd-2' }, ...manualDeps(store) });
    assert(!p.ok && p.status === 409, `C3 provider→paste: pasting the unsigned text of a signed delivery is refused (got ${p.ok ? 'logged' : p.status})`);
  }
  {
    // Outside the window: answered more than 48h ago → a real repeat, logged.
    const store = world();
    const earlier = await ingest(store.sb, 'resend:old-nd', signed, Date.now() - 3 * 86_400_000);
    const row = store.all('inbound_messages').find((r) => r.id === earlier.inbound_message_id);
    if (row) row.status = 'processed';
    const p = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: paste, submission_id: 'nd-3' }, ...manualDeps(store) });
    assert(p.ok && !p.ingest.deduped, 'C3: a near-duplicate answered 3 days ago is a new reply');
  }
  {
    // Another thread never matches.
    const store = world();
    store.seed('campaign_influencers', { id: 'ci-2', campaign_id: 'camp-1', influencer_id: 'inf-1', status: 'contacted' });
    await ingestInboundReply({ channel: 'email', external_id: 'resend:other', from_identity: 'c@x', body: signed, campaign_influencer_id: 'ci-2', received_at: new Date(Date.now() - MIN).toISOString() }, store.sb);
    const p = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: paste, submission_id: 'nd-4' }, ...manualDeps(store) });
    assert(p.ok && !p.ingest.deduped, 'C3: the same words on another thread are not a duplicate');
  }
}

// ── C4. A near-duplicate is never dropped and never negotiated ─────
// The pairs: a looser near-match would drop the second of each as a
// duplicate of the first, although each one says something different.
const NEAR_PAIRS: Array<[string, string]> = [
  ['Hey! I am able to do the reel and the story for $180, I can post it next week once I get the audio file from you.',
   'Hey! I am not able to do the reel and the story for $180, I can post it next week once I get the audio file from you.'],
  ['Sounds good, I can do the reel and story for $180 and post it next Tuesday after I get the track and the brief.',
   'Sounds good, I cannot do the reel and story for $180 and post it next Tuesday after I get the track and the brief.'],
  ['Yes $180 works for the reel and the story, I will post it next week after I get the track from you guys.',
   'No $180 works for the reel only, not the story, I will post it next week after I get the track from you guys.'],
  ['Ok $180 works for me, send over the details and the contract and I will get it posted this week.',
   'Ok $180 works for me, send over the details and the contract and I will get it posted next week.'],
  ['Ok $180 works for me for the reel, send over the details and the contract and I will get it posted this week.',
   'Ok $180 works for me for the story, send over the details and the contract and I will get it posted this week.'],
];
async function nearDuplicatesRound6() {
  for (const [a, b] of NEAR_PAIRS) {
    assert(!sameReplyForDedupe(a, b), `C4: never the same reply: ${JSON.stringify(b.slice(0, 50))}`);
  }
  // Exact after stripping greeting / sign-off / punctuation / case → same.
  assert(compareReplyForDedupe('Hi Owen,\nOK, $180 works for me -- send over the details!\n\nThanks,\nJane', 'ok $180 works for me send over the details', ['Owen']) === 'same', 'C4: greeting, sign-off, punctuation and case are stripped for the exact match');
  assert(compareReplyForDedupe('Deal at $1.5k for the reel and the story, thanks', 'Deal at $15k for the reel and the story, thanks') !== 'same', 'C4: a decimal point is not punctuation');

  const T1 = Date.now() - 30 * MIN;
  for (const [a, b] of NEAR_PAIRS) {
    const tag = `C4 ${JSON.stringify(b.slice(0, 40))}`;
    // Paste then paste.
    const store = world();
    const p1 = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: a, submission_id: 'r6-a' }, ...manualDeps(store) });
    const p2 = await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: b, submission_id: 'r6-b' }, ...manualDeps(store) });
    assert(p1.ok && p2.ok && !p2.ingest.deduped, `${tag}: the second paste is recorded, not dropped`);
    const rows = store.all('inbound_messages');
    const rb = rows.find((r) => r.body === b);
    const ra = rows.find((r) => r.body === a);
    assert(!!rb, `${tag}: the second reply is on the thread`);
    if (compareReplyForDedupe(a, b) === 'similar') {
      const cls = (rb?.classification ?? {}) as Record<string, unknown>;
      assert(rb?.status === 'flagged' && cls.possible_duplicate_of === ra?.id, `${tag}: held for a human as a possible duplicate (status ${rb?.status})`);
      assert(isPossibleDuplicate(rb?.classification) && !isPossibleDuplicate(ra?.classification), `${tag}: /anomalies labels it "possible duplicate"`);
      assert(ra?.status === 'flagged', `${tag}: the unanswered first reply is held too (status ${ra?.status})`);
      assert(p2.ok && p2.ingest.possible_duplicate_of?.inbound_message_id === ra?.id, `${tag}: ingest reports the possible duplicate`);
      // No negotiation turn on the thread.
      const before = Number(store.getOffer('offer-1')?.rounds);
      await runNegotiationTick(store.sb, { now: T1 + 60 * MIN, rand: () => 0.5, dispatch: async () => ({ ok: true }), pollGmail: async () => ({ skipped: 'gmail_not_configured' as const }) });
      assert(Number(store.getOffer('offer-1')?.rounds) === before && store.all('outreach_messages').every((m) => m.message_type !== 'counter'), `${tag}: nothing is negotiated`);
    }
    // Paste then a SIMILAR provider delivery: recorded for review, not folded.
    if (compareReplyForDedupe(a, b) === 'similar') {
      const s2 = world();
      await logManualEmailReply({ input: { campaign_influencer_id: 'ci-1', response_text: a, submission_id: 'r6-c' }, ...manualDeps(s2) });
      const r = await ingest(s2.sb, `gmail:r6-${b.length}`, b, Date.now() - MIN);
      const row = s2.all('inbound_messages').find((x) => x.external_id === `gmail:r6-${b.length}`);
      assert(!r.deduped && !r.canonical_copy_of && row?.status === 'flagged', `${tag}: a similar provider copy is recorded and held, not folded into the paste (status ${row?.status})`);
    }
  }
}

// ── D. "Creator opted out" on /approvals and the deal row (display only) ───

async function optOutFlags() {
  const store = makeStore();
  for (const id of ['inf-opt', 'inf-lab', 'inf-glob', 'inf-clear', 'inf-other']) {
    store.seed('influencers', { id, blocklisted: id === 'inf-glob' });
  }
  store.seed(FIRM_BLOCKS_TABLE, { firm_id: 'firm-1', influencer_id: 'inf-opt', source: 'creator_opt_out' });
  store.seed(FIRM_BLOCKS_TABLE, { firm_id: 'firm-1', influencer_id: 'inf-lab', source: 'label_user' });
  store.seed(FIRM_BLOCKS_TABLE, { firm_id: 'firm-2', influencer_id: 'inf-other', source: 'creator_opt_out' });
  const ids = ['inf-opt', 'inf-lab', 'inf-glob', 'inf-clear', 'inf-other'];
  const r = await readDoNotContactFlags(store.sb, 'firm-1', ids);
  assert(r.state === 'ok', 'D: both lists read');
  assert(r.flags.get('inf-opt') === 'opted_out', 'D: a STOP reads as opted out');
  assert(r.flags.get('inf-lab') === 'label_blocked', "D: the label's own Block reads as blocked by the label");
  assert(r.flags.get('inf-glob') === 'platform_blocked', 'D: the global column reads as blocked');
  assert(!r.flags.has('inf-clear'), 'D: a clear creator carries no flag');
  assert(!r.flags.has('inf-other'), "D: another label's opt-out is not this label's flag");

  const broken = failTable(store.sb, FIRM_BLOCKS_TABLE, { code: '57014', message: 'timeout' });
  const u = await readDoNotContactFlags(broken, 'firm-1', ids);
  assert(u.state === 'unreadable', 'D: an unreadable per-label list is reported, not read as clear');
  assert(u.flags.get('inf-glob') === 'platform_blocked', 'D: a block known from the global column survives an unreadable per-label list');
  const missing = failTable(store.sb, FIRM_BLOCKS_TABLE, { code: 'PGRST205', message: `Could not find the table 'public.${FIRM_BLOCKS_TABLE}' in the schema cache` });
  const m = await readDoNotContactFlags(missing, 'firm-1', ids);
  assert(m.state === 'ok' && m.flags.size === 1, 'D: pre-056 reads the global column only, as the send paths do');

  // /approvals: rows → flags, keyed by payment authorization id.
  const row = (id: string, inf: string) =>
    ({ id, creator_offers: { campaign_influencers: { influencer_id: inf } } }) as unknown as PendingApprovalRow;
  const rows = [row('pa-1', 'inf-opt'), row('pa-2', 'inf-clear')];
  const flags = await doNotContactForApprovals(store.sb, 'firm-1', rows);
  assert(flags.get('pa-1') === 'opted_out' && !flags.has('pa-2'), 'D: approvals flags the opted-out creator and only them');
  const uflags = await doNotContactForApprovals(broken, 'firm-1', rows);
  assert(uflags.get('pa-2') === 'unknown' && uflags.get('pa-1') === 'unknown', 'D: approvals says "not checked" when the list is unreadable');
  assert(doNotContactNotice('opted_out')?.label === 'Creator opted out', 'D: the badge reads "Creator opted out"');
  assert(/STOP/.test(doNotContactNotice('opted_out')?.detail ?? '') && /before you approve/.test(doNotContactNotice('opted_out')?.detail ?? ''), 'D: the detail says what happened and what to do');
  assert(doNotContactNotice(null) === null && doNotContactNotice(undefined) === null, 'D: clear shows nothing');

  // Wire-up. The flag is rendered, and it feeds NO payment decision.
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  const page = src('src/app/approvals/page.tsx');
  assert(/doNotContactForApprovals\(sb, session\.firm_id, rows\)/.test(page) && /doNotContactNotice\(dnc\.get\(r\.id\)\)/.test(page), 'D: /approvals reads and renders the flag per card');
  assert(!/<ApprovalActions[\s\S]{0,600}optOut/.test(page), 'D: the flag is not passed to the Approve / Reject actions (display only)');
  const q = src('src/lib/approvals-query.ts');
  const fetchBody = q.slice(q.indexOf('export async function fetchPendingApprovals'), q.indexOf('export async function doNotContactForApprovals'));
  assert(!/DoNotContact|readDoNotContactFlags/.test(fetchBody), 'D: payable / blocked_reason are computed without the flag');
  const route = src('src/app/api/campaigns/[id]/deals/route.ts');
  assert(/readDoNotContactFlags\(sb, session\.firm_id/.test(route) && /do_not_contact:/.test(route), 'D: the deals API carries do_not_contact per row');
  const deals = src('src/app/campaigns/[id]/deals/page.tsx');
  assert(/doNotContactNotice\(d\.do_not_contact\)/.test(deals) && /optOut\.label/.test(deals), 'D: the deal row renders the flag');
}

async function main() {
  const origWarn = console.warn;
  if (!process.env.DEBUG) console.warn = () => {};

  await stopBeforeTick();
  await labelBlockAfterIngest();
  await otherLabelsBlockDoesNotApply();
  await unreadableBlocksHold();
  await retriedStop();
  pureNormalize();
  await pasteAfterAutoIngest();
  await pasteThenProvider();
  await legitimateRepeats();
  await nearDuplicates();
  await nearDuplicatesRound6();
  await optOutFlags();

  console.warn = origWarn;
  console.log(`firm-blocks-inbound test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
