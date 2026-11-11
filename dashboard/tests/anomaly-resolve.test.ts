import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
//
// tests/anomaly-resolve.test.ts
//
// Held / flagged replies never left /anomalies, and neither did injection
// flags or escalation rows: nothing could take them off. Now "Resolve" marks
// one reviewed, or sends a held reply back to the negotiator ("process
// normally", which respects manual mode), and every resolution is audited.
//
// Run: npx tsx tests/anomaly-resolve.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { registerProvider } from '../src/lib/model-provider';
import { runNegotiationTick, type DispatchFn } from '../src/lib/negotiation-tick';
import { resolveAnomaly, type ResolveAction } from '../src/lib/anomaly-resolve';
import { detectAnomalies, resolvedFromAudit, resolveOptionsFor, type ThreadAuditRow } from '../src/lib/statuses';
import { makeStore, type Row } from './negotiation-harness/store';
import { auditRows } from './negotiation-harness/setup-env';

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

const NOW0 = Date.parse('2026-07-06T16:00:00.000Z');
const HALF = () => 0.5;
const noopPoll = async () => ({ skipped: 'gmail_not_configured' as const });
const dispatch: DispatchFn = async () => ({ ok: true, provider_message_id: 'p', resolved_to: 't@x' });

let script: () => Record<string, unknown> = () => ({ intent: 'unclear' });
registerProvider('mock', async () => JSON.stringify({ sentiment: 'neutral', confidence: 0.9, counter_usd: null, ...script() }));

type Store = ReturnType<typeof makeStore>;

function world(autonomy = 'auto'): Store {
  const store = makeStore();
  store.seed('firms', { id: 'firm-1', name: 'Example Records', sender_name: null, outreach_prefs: {}, scraping_prefs: {} });
  store.seed('campaigns', { id: 'camp-1', firm_id: 'firm-1', total_budget_usd: 1_000_000 });
  store.seed('campaigns', { id: 'camp-2', firm_id: 'firm-2', total_budget_usd: 1_000_000 });
  store.seed('influencers', { id: 'inf-1', username: 'creator', blocklisted: false });
  store.seed('campaign_influencers', { id: 'ci-1', campaign_id: 'camp-1', influencer_id: 'inf-1' });
  store.seedOffer({
    id: 'offer-1', campaign_influencer_id: 'ci-1', campaign_id: 'camp-1', firm_id: 'firm-1',
    status: 'offered', initial_offer_usd: 100, current_offer_usd: 100, agreed_amount_usd: null,
    ceiling_usd: 200, rounds: 0, last_message_id: null, approved_at: null, approved_by_user_id: null,
    paid_at: null, posted_at: null, post_url: null, autonomy_mode: autonomy, opening_pct: null,
    injection_flagged: true, created_at: '2026-07-06T00:00:00.000Z', updated_at: '2026-07-06T00:00:00.000Z',
  });
  store.seed('outreach_messages', {
    id: 'msg-first', campaign_influencer_id: 'ci-1', message_type: 'initial', direction: 'outbound',
    channel: 'email', subject: 'Collab', body: 'Hey, $100 for 1 reel + 1 story', status: 'sent',
    sent_at: '2026-07-05T15:00:00.000Z', send_after: null,
  });
  store.seed('inbound_messages', {
    id: 'held', channel: 'email', external_id: 'sim:held', creator_offer_id: 'offer-1', campaign_influencer_id: 'ci-1',
    from_identity: 'c@x', body: 'Can you do $180?', received_at: new Date(NOW0 - 3_600_000).toISOString(),
    status: 'flagged', classification: { classification: 'negotiating', possible_duplicate_of: 'x' }, claimed_at: new Date(NOW0 - 3_600_000).toISOString(),
  });
  store.seed('audit_log', {
    id: 'esc-1', firm_id: 'firm-1', action: 'negotiation.accept_price_unclear', target_type: 'creator_offer',
    target_id: 'offer-1', occurred_at: new Date(NOW0).toISOString(), metadata: { inbound_message_id: 'held', detail: 'x' },
  });
  store.seed('audit_log', {
    id: 'esc-other', firm_id: 'firm-2', action: 'negotiation.accept_price_unclear', target_type: 'creator_offer',
    target_id: 'offer-x', occurred_at: new Date(NOW0).toISOString(), metadata: {},
  });
  store.seed('audit_log', {
    id: 'fishy-1', firm_id: 'firm-1', action: 'negotiation.low_confidence_flagged', target_type: 'creator_offer',
    target_id: 'offer-1', occurred_at: new Date(NOW0).toISOString(), metadata: {},
  });
  return store;
}

const resolve = (store: Store, ref: string, action: ResolveAction, opts: { firm?: string; operator?: boolean } = {}) =>
  resolveAnomaly(store.sb as unknown as SupabaseClient, {
    ref, action, firmId: opts.firm ?? 'firm-1', isOperator: opts.operator ?? true, actorLabel: 'user:ops@null.test', nowMs: NOW0,
  });
const inbound = (store: Store, id: string) => store.all('inbound_messages').find((r) => r.id === id) as Row;

async function scopeAndRoles() {
  const store = world();
  assert((await resolve(store, 'flagged-held', 'reviewed', { operator: false })).status === 403, 'scope: a label cannot resolve an operator-only flagged reply');
  assert((await resolve(store, 'injection-offer-1', 'reviewed', { operator: false })).status === 403, 'scope: a label cannot clear an injection flag');
  assert((await resolve(store, 'fishy-fishy-1', 'reviewed', { operator: false })).status === 403, 'scope: a label cannot resolve a fishy row');
  assert((await resolve(store, 'flagged-held', 'reviewed', { firm: 'firm-2' })).status === 404, 'scope: another label\'s reply is not found');
  assert((await resolve(store, 'injection-offer-1', 'reviewed', { firm: 'firm-2' })).status === 404, 'scope: another label\'s offer is not found');
  assert((await resolve(store, 'escalation-esc-other', 'reviewed')).status === 404, 'scope: another label\'s escalation is not found');
  assert((await resolve(store, 'payment-p1', 'reviewed')).status === 422, 'scope: an unresolvable lane is refused');
  assert(inbound(store, 'held').status === 'flagged' && store.getOffer('offer-1')?.injection_flagged === true, 'scope: refusals change nothing');
}

async function reviewedFlaggedReply() {
  const store = world();
  const before = auditRows.length;
  const r = await resolve(store, 'flagged-held', 'reviewed');
  assert(r.status === 200, `reviewed: 200 (got ${r.status} ${JSON.stringify(r.body)})`);
  const row = inbound(store, 'held');
  assert(row.status === 'processed', `reviewed: the held reply leaves the flagged lane (status ${row.status})`);
  const res = (row.classification as Record<string, unknown>)?.operator_resolution as Record<string, unknown> | undefined;
  assert(res?.by === 'user:ops@null.test' && res?.via === 'resolve', `reviewed: who and how are on the row (${JSON.stringify(res)})`);
  const a = auditRows.slice(before).find((x) => x.action === 'anomaly.resolved');
  assert(a?.metadata?.ref === 'flagged-held' && a?.metadata?.resolution === 'reviewed', 'reviewed: audited as anomaly.resolved');
  assert((await resolve(store, 'flagged-held', 'reviewed')).status === 409, 'reviewed: resolving twice is a 409, not a second write');
}

async function processNormallyRespectsManualMode() {
  const store = world('human');
  const r = await resolve(store, 'flagged-held', 'process_normally');
  assert(r.status === 409 && r.body.error === 'thread_in_manual_mode', `manual: process normally is refused while a human has the thread (got ${r.status})`);
  assert(inbound(store, 'held').status === 'flagged', 'manual: the reply stays held');

  // Another reply still held on the thread also counts as a human handling it.
  const s2 = world();
  s2.seed('inbound_messages', {
    id: 'held-2', channel: 'email', external_id: 'sim:held-2', creator_offer_id: 'offer-1', campaign_influencer_id: 'ci-1',
    from_identity: 'c@x', body: 'hello?', received_at: new Date(NOW0).toISOString(), status: 'flagged', classification: {},
  });
  const r2 = await resolve(s2, 'flagged-held', 'process_normally');
  assert(r2.status === 409, `manual: another held reply on the thread → 409 (got ${r2.status})`);
}

async function processNormallyNegotiates() {
  const store = world();
  const r = await resolve(store, 'flagged-held', 'process_normally');
  assert(r.status === 200, `process: 200 (got ${r.status} ${JSON.stringify(r.body)})`);
  const row = inbound(store, 'held');
  assert(row.status === 'classified' && row.claimed_at == null, `process: back in the queue, stale claim cleared (${row.status}, ${row.claimed_at})`);
  script = () => ({ intent: 'counter', counter_usd: 180 });
  await runNegotiationTick(store.sb, { now: NOW0, rand: HALF, dispatch, pollGmail: noopPoll });
  assert(inbound(store, 'held').status === 'processed', `process: the next tick negotiated it (status ${inbound(store, 'held').status})`);
  const o = store.getOffer('offer-1') as Row;
  assert(Number(o.rounds) === 1, `process: and the negotiator took the turn (rounds ${o.rounds}, status ${o.status})`);
}

async function injectionFlag() {
  const store = world();
  const r = await resolve(store, 'injection-offer-1', 'reviewed');
  assert(r.status === 200 && store.getOffer('offer-1')?.injection_flagged === false, `injection: the flag is cleared (got ${r.status})`);
  assert((await resolve(store, 'injection-offer-1', 'reviewed')).status === 409, 'injection: clearing twice is a 409');
}

async function escalationRowReleasesItsReply() {
  const store = world();
  const r = await resolve(store, 'escalation-esc-1', 'reviewed', { operator: false });
  assert(r.status === 200, `escalation: a label resolves its own needs-decision row (got ${r.status} ${JSON.stringify(r.body)})`);
  assert(inbound(store, 'held').status === 'processed', 'escalation: the reply it was about is released too');
  const again = await resolve(store, 'escalation-esc-1', 'reviewed', { operator: false });
  assert(again.status === 200, 'escalation: reviewing a row whose reply is already released still retires it');
}

function retiredRowsLeaveTheFeed() {
  const audit: ThreadAuditRow[] = [
    { id: 'esc-1', occurred_at: '2026-07-06T00:00:00Z', action: 'negotiation.accept_price_unclear', target_type: 'creator_offer', target_id: 'o', metadata: { inbound_message_id: 'held', detail: 'd' } },
    { id: 'esc-2', occurred_at: '2026-07-06T00:00:00Z', action: 'negotiation.manual_mode_reply', target_type: 'creator_offer', target_id: 'o', metadata: { inbound_message_id: 'other', detail: 'd' } },
    { id: 'f-1', occurred_at: '2026-07-06T00:00:00Z', action: 'negotiation.fishy_flagged', target_type: 'creator_offer', target_id: 'o', metadata: {} },
  ] as ThreadAuditRow[];
  const base = {
    offers: [], payments: [], deliveries: [], audit, inbound: [], cis: [], influencers: [], campaigns: [], hasContractTemplate: true,
  };
  const refs = (resolved?: ReturnType<typeof resolvedFromAudit>) => detectAnomalies({ ...base, resolved }, NOW0).map((r) => r.ref).sort();
  assert(refs().join() === 'escalation-esc-1,escalation-esc-2,fishy-f-1', `feed: unresolved rows show (${refs().join()})`);
  const resolution = resolvedFromAudit([
    { id: 'r1', occurred_at: '', action: 'anomaly.resolved', target_type: 'audit_log', target_id: 'f-1', metadata: { ref: 'fishy-f-1', inbound_ids: [] } },
    { id: 'r2', occurred_at: '', action: 'negotiation.automation_resumed', target_type: 'creator_offer', target_id: 'o', metadata: { resolved_inbound_ids: ['held'] } },
  ] as ThreadAuditRow[]);
  assert(refs(resolution).join() === 'escalation-esc-2', `feed: a resolved ref and a reply reviewed on resume retire their rows (${refs(resolution).join()})`);
  assert(resolveOptionsFor({ category: 'flagged_inbound' }).processNormally && !resolveOptionsFor({ category: 'needs_decision' }).processNormally, 'feed: process normally is offered on held replies only');
  assert(!resolveOptionsFor({ category: 'payment_failed' }).reviewed, 'feed: money lanes are not resolvable from here');
}

function wiring() {
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  assert(/resolveAnomaly\(/.test(src('src/app/api/anomalies/resolve/route.ts')), 'wire: the resolve route runs resolveAnomaly');
  assert(/resolved,/.test(src('src/app/api/anomalies/route.ts')) && /resolvedFromAudit\(/.test(src('src/app/api/anomalies/route.ts')), 'wire: the feed reads resolutions back');
  const page = src('src/app/anomalies/page.tsx');
  assert(/\/api\/anomalies\/resolve/.test(page) && /Mark reviewed/.test(page) && /Process normally/.test(page), 'wire: the page offers Mark reviewed / Process normally');
}

(async () => {
  console.warn = () => {};
  await scopeAndRoles();
  await reviewedFlaggedReply();
  await processNormallyRespectsManualMode();
  await processNormallyNegotiates();
  await injectionFlag();
  await escalationRowReleasesItsReply();
  retiredRowsLeaveTheFeed();
  wiring();
  console.log(`\nanomaly-resolve: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
