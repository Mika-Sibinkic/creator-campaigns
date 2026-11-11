import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub
//
// tests/outreach-send-scope.test.ts
//
// POST /api/outreach/[id]/send must not tell another label anything about a
// message it does not own.
//
// The gap (tenant sweep, 2026-09-30): the route loaded the message by id on the
// service-role client and answered 409 "already sent", 409 window_closed,
// 409 superseded and 409 dm_queue BEFORE its firm check (which came ~110 lines
// later, after the campaign lookup and the stale-draft 409). Label B could
// probe label A's message ids and learn which exist and what state each is in.
//
// What this pins, by EXECUTING loadSendableMessage (src/lib/outreach-send-gate.ts,
// the first thing the route does after auth) against two labels:
//   1. A foreign id in every state is a 404 byte-identical to an unknown id,
//      and nothing is written.
//   2. The owner still gets every original refusal, unchanged.
//   3. Unscoped callers and orphan messages fail closed.
//   4. The route calls the gate before any query of its own and no longer
//      carries the status refusals itself (who calls this?).
//
// Hermetic: no DB, no network. Run: npx tsx tests/outreach-send-scope.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeStore } from './negotiation-harness/store';
import { loadSendableMessage } from '../src/lib/outreach-send-gate';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(msg);
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

const FIRM_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const FIRM_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const STATES: Array<{ id: string; row: Record<string, unknown>; ownerStatus: number; ownerError?: string }> = [
  { id: 'm-sent', row: { sent_at: '2026-09-29T10:00:00Z', status: 'sent' }, ownerStatus: 409, ownerError: 'already sent' },
  { id: 'm-window', row: { status: 'window_closed' }, ownerStatus: 409, ownerError: 'window_closed' },
  { id: 'm-superseded', row: { status: 'superseded' }, ownerStatus: 409, ownerError: 'superseded' },
  { id: 'm-dm', row: { status: 'queued', send_mode: 'human_queue' }, ownerStatus: 409, ownerError: 'dm_queue' },
  { id: 'm-queued', row: { status: 'queued' }, ownerStatus: 200 },
];

function seedWorld() {
  const s = makeStore();
  s.seed('campaigns', { id: 'camp-A', firm_id: FIRM_A });
  s.seed('campaigns', { id: 'camp-B', firm_id: FIRM_B });
  s.seed('campaign_influencers', { id: 'ci-A', campaign_id: 'camp-A', influencer_id: 'inf-1' });
  for (const st of STATES) {
    s.seed('outreach_messages', {
      id: st.id,
      campaign_influencer_id: 'ci-A',
      subject: 'Label A subject',
      body: 'Label A pitch',
      sent_at: null,
      created_at: '2026-09-28T00:00:00Z',
      message_type: 'initial',
      channel: 'email',
      send_mode: null,
      ...st.row,
    });
  }
  s.seed('outreach_messages', { id: 'm-orphan', campaign_influencer_id: null, body: 'orphan', sent_at: '2026-09-01T00:00:00Z' });
  return s;
}

/** Wrap the store's client so every op is observable. */
function spyClient(sb: SupabaseClient) {
  const ops: string[] = [];
  const wrapped = {
    from(table: string) {
      const q = sb.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
      return new Proxy(q, {
        get(target, prop, recv) {
          const v = Reflect.get(target, prop, recv);
          if (typeof v !== 'function') return v;
          if (['select', 'insert', 'update', 'upsert', 'delete'].includes(String(prop))) {
            return (...args: unknown[]) => {
              ops.push(`${table}.${String(prop)}`);
              v.apply(target, args);
              return recv;
            };
          }
          return (...args: unknown[]) => {
            const out = v.apply(target, args);
            return out === target ? recv : out;
          };
        },
      });
    },
  } as unknown as SupabaseClient;
  return { sb: wrapped, ops };
}

const WRITE = /\.(insert|update|upsert|delete)$/;

async function main() {
  // Baseline: what an id that does not exist looks like to label B.
  const unknown = await loadSendableMessage(seedWorld().sb, 'm-does-not-exist', FIRM_B);
  const unknownBody = unknown.ok ? '' : JSON.stringify(unknown.body);
  assert(!unknown.ok && unknown.status === 404, 'unknown id → 404');

  // 1. Label B against every one of label A's messages.
  for (const st of STATES) {
    const store = seedWorld();
    const spy = spyClient(store.sb);
    const before = JSON.stringify(store.all('outreach_messages'));
    const g = await loadSendableMessage(spy.sb, st.id, FIRM_B);
    assert(!g.ok && g.status === 404, `label B on A's ${st.id} → 404 (got ${g.ok ? 200 : g.status})`);
    assert(!g.ok && JSON.stringify(g.body) === unknownBody, `label B on A's ${st.id}: body identical to an unknown id`);
    assert(!g.ok && !JSON.stringify(g.body).includes('Label A'), `label B on A's ${st.id}: no content leaks`);
    assert(!spy.ops.some((o) => WRITE.test(o)), `label B on A's ${st.id}: zero writes`);
    assert(JSON.stringify(store.all('outreach_messages')) === before, `label B on A's ${st.id}: rows untouched`);
  }

  // 2. Label A on its own messages: the original refusals, unchanged.
  for (const st of STATES) {
    const g = await loadSendableMessage(seedWorld().sb, st.id, FIRM_A);
    if (st.ownerStatus === 200) {
      assert(g.ok && g.message.id === st.id && g.message.body === 'Label A pitch', `label A ${st.id} → sendable, message returned`);
    } else {
      assert(!g.ok && g.status === st.ownerStatus, `label A ${st.id} → ${st.ownerStatus} (got ${g.ok ? 200 : g.status})`);
      assert(!g.ok && g.body.error === st.ownerError, `label A ${st.id}: error '${st.ownerError}' kept (got ${g.ok ? '' : String(g.body.error)})`);
    }
  }
  {
    const g = await loadSendableMessage(seedWorld().sb, 'm-window', FIRM_A);
    assert(!g.ok && typeof g.body.message === 'string' && /window/i.test(g.body.message as string), 'window_closed keeps its human message');
  }

  // 3. Fail closed.
  for (const bad of ['', '   ']) {
    const g = await loadSendableMessage(seedWorld().sb, 'm-sent', bad);
    assert(!g.ok && g.status === 404 && JSON.stringify(g.body) === unknownBody, `unscoped caller ${JSON.stringify(bad)} → 404`);
  }
  {
    const g = await loadSendableMessage(seedWorld().sb, 'm-orphan', FIRM_A);
    assert(!g.ok && g.status === 404, 'orphan message (no lead) → 404, not "already sent"');
  }

  // 4. Wiring.
  const route = readFileSync(join(process.cwd(), 'src', 'app', 'api', 'outreach', '[id]', 'send', 'route.ts'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  const gateAt = route.search(/loadSendableMessage\(sb, messageId, session\.firm_id\)/);
  const firstQuery = route.search(/\.from\(/);
  assert(gateAt > 0, 'route calls loadSendableMessage(sb, messageId, session.firm_id)');
  assert(firstQuery > gateAt, 'and before any query of its own');
  assert(!/'already sent'/.test(route), "route no longer answers 'already sent' itself");
  assert(!/error: 'window_closed'/.test(route) && !/error: 'superseded'/.test(route), 'nor window_closed / superseded');
  assert(!/status: 403/.test(route), 'the late firm check is a 404 too, not a distinguishable 403');

  if (failures.length > 0) console.error('\nFailures:\n - ' + failures.join('\n - '));
  console.log(`outreach-send-scope test: ${passed}/${passed + failed} pass`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
