import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub (audit is lazily imported by ingest)
//
// tests/firm-blocks.test.ts
//
// A creator's STOP, and a label's Block, apply to ONE label (migration 056).
//
// What is pinned, and why each is load-bearing:
//
//   1. isMissingTableError recognises the pre-056 state and nothing else — a
//      misclassified real error would silently turn "unreadable" into "no
//      blocks" and let a send through.
//   2. STOP → a firm_influencer_blocks row for the CAMPAIGN'S firm; the shared
//      influencers.blocklisted column is untouched. Idempotent across repeats.
//   3. PRE-056: STOP with the table missing falls back to the global column, so
//      the opt-out is never lost, and says so in the log. Same for a failed
//      per-firm write and an unresolvable firm.
//   4. The fallback failing too logs OPT-OUT NOT HONOURED (the loud error).
//   5. DISPATCH: a queued message to a creator who just said STOP to this label
//      does not send — end to end, through the real ingest and dispatch pass.
//      Another label's queued message to the same creator DOES send.
//   6. Dispatch fails CLOSED when the block table is unreadable (held, stays
//      queued), and pre-056 it gates on the global column exactly as before.
//   7. The PATCH toggle: label users write their own firm's row only; the
//      global column is operator-only; pre-056 keeps today's global write.
//   8. Every route that gates a firm's pool reads the per-firm table (source
//      assertions — those handlers need Clerk and cannot execute here).
//
// Hermetic: in-memory store, dummy env, stubbed fetch. No DB, no network.
//
// Run: npx tsx tests/firm-blocks.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeStore, type Row } from './negotiation-harness/store';
import {
  FIRM_BLOCKS_TABLE,
  applyBlockToggle,
  honourOptOut,
  isMissingTableError,
  readFirmBlocks,
  readFirmBlocksForPairs,
  firmBlockKey,
} from '../src/lib/firm-blocks';
import { ingestInboundReply } from '../src/lib/ingest-inbound';
import { runDispatchPass, type DispatchFn } from '../src/lib/negotiation-tick';
import { inSendWindow } from '../src/lib/quiet-hours';

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

const ROOT = join(__dirname, '..');
const NOW = Date.parse('2026-09-24T18:00:00Z'); // 13:00 at -5: send window open
const rand = () => 0.5;

const MISSING_TABLE = {
  code: 'PGRST205',
  message: `Could not find the table 'public.${FIRM_BLOCKS_TABLE}' in the schema cache`,
};
const TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

/**
 * Wrap a store client so every query against ONE table resolves to `error`.
 * Every chain method returns the same node, and awaiting it (or .single /
 * .maybeSingle) yields { data: null, error } — the shape PostgREST returns.
 */
function failTable(sb: SupabaseClient, table: string, error: { code: string; message: string }): SupabaseClient {
  const res = { data: null, error };
  const node: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'lte', 'lt', 'gte']) {
    node[m] = () => node;
  }
  node.single = async () => res;
  node.maybeSingle = async () => res;
  node.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(res).then(ok, err);
  return {
    from(t: string) {
      return t === table ? node : sb.from(t);
    },
  } as unknown as SupabaseClient;
}

/** Wrap a store client so updates to `influencers` fail (the global fallback). */
function failGlobalWrite(sb: SupabaseClient): SupabaseClient {
  return {
    from(t: string) {
      const q = sb.from(t);
      if (t !== 'influencers') return q;
      return new Proxy(q as object, {
        get(target, prop, recv) {
          if (prop === 'update') {
            return () => ({
              eq: async () => ({ data: null, error: { code: '42501', message: 'permission denied' } }),
            });
          }
          return Reflect.get(target, prop, recv);
        },
      });
    },
  } as unknown as SupabaseClient;
}

/** Capture console.warn / console.error lines emitted during `fn`. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; warns: string[]; errors: string[] }> {
  const warns: string[] = [];
  const errors: string[] = [];
  const w = console.warn;
  const e = console.error;
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => errors.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  try {
    const result = await fn();
    return { result, warns, errors };
  } finally {
    console.warn = w;
    console.error = e;
  }
}

type Store = ReturnType<typeof makeStore>;

/**
 * Two labels, one creator. firm-A runs camp-A (lead ci-A), firm-B runs camp-B
 * (lead ci-B). Both leads point at the same shared influencer row.
 */
function seedTwoLabels(store: Store): void {
  store.seed('firms', { id: 'firm-A', scraping_prefs: {}, outreach_prefs: {} });
  store.seed('firms', { id: 'firm-B', scraping_prefs: {}, outreach_prefs: {} });
  // Both caps, as every confirmed campaign has (migration 037): the dispatch
  // pass's first-touch gate (src/lib/first-touch-gate.ts) refuses without them.
  store.seed('campaigns', { id: 'camp-A', firm_id: 'firm-A', release_date: null, created_at: new Date(NOW - 86_400_000).toISOString(), total_budget_usd: 1_000_000, per_creator_cap_usd: 250 });
  store.seed('campaigns', { id: 'camp-B', firm_id: 'firm-B', release_date: null, created_at: new Date(NOW - 86_400_000).toISOString(), total_budget_usd: 1_000_000, per_creator_cap_usd: 250 });
  store.seed('influencers', {
    id: 'inf-1',
    platform: 'tiktok',
    username: 'creator1',
    contact_email: 'creator@example.com',
    follower_count: 40_000,
    bot_flagged: false,
    blocklisted: false,
  });
  for (const [ci, camp] of [['ci-A', 'camp-A'], ['ci-B', 'camp-B']] as const) {
    store.seed('campaign_influencers', {
      id: ci,
      campaign_id: camp,
      influencer_id: 'inf-1',
      qualification_status: 'qualified',
      qualification_reason: null,
      bot_flagged: false,
      score_breakdown: { audience_fit: 0.8 },
      last_response_at: null,
    });
  }
}

function seedQueued(store: Store, id: string, ci: string): Row {
  return store.seed('outreach_messages', {
    id,
    campaign_influencer_id: ci,
    subject: 'Re: collab',
    body: 'Following up.',
    channel: 'email',
    direction: 'outbound',
    status: 'queued',
    send_mode: null,
    send_after: new Date(NOW - 60_000).toISOString(),
    sent_at: null,
    sent_to: null,
    provider_message_id: null,
  });
}

function stop(ci: string, ext: string, body = 'STOP') {
  return {
    channel: 'email',
    external_id: ext,
    from_identity: 'creator@example.com',
    body,
    campaign_influencer_id: ci,
    received_at: new Date(NOW - 120_000).toISOString(),
  };
}

function recorder(): { calls: string[]; dispatch: DispatchFn } {
  const calls: string[] = [];
  return {
    calls,
    dispatch: async (_sb, msg) => {
      calls.push(msg.id);
      return { ok: true, resolved_to: 'creator@example.com', provider_message_id: `prov-${msg.id}` };
    },
  };
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

async function main() {
  assert(inSendWindow(NOW), 'fixed clock is inside the send window (else dispatch cases test deferral)');

  // ── 1. Missing-table detection ────────────────────────────────────────────
  assert(isMissingTableError(MISSING_TABLE), 'missing table: PGRST205 is the pre-056 state');
  assert(isMissingTableError({ code: '42P01', message: 'relation does not exist' }), 'missing table: 42P01 undefined_table');
  assert(
    isMissingTableError({ message: `relation "public.${FIRM_BLOCKS_TABLE}" does not exist` }),
    'missing table: message-only form naming this table',
  );
  assert(!isMissingTableError(TIMEOUT), 'missing table: a timeout is NOT the pre-056 state');
  assert(!isMissingTableError({ message: 'relation "public.other" does not exist' }), 'missing table: another table missing is not ours');
  assert(!isMissingTableError(null), 'missing table: null is not an error');

  // ── 2. Reads are firm-scoped ──────────────────────────────────────────────
  {
    const store = makeStore();
    store.seed(FIRM_BLOCKS_TABLE, { firm_id: 'firm-A', influencer_id: 'inf-1', source: 'label_user' });
    const a = await readFirmBlocks(store.sb, 'firm-A', ['inf-1', 'inf-2']);
    const b = await readFirmBlocks(store.sb, 'firm-B', ['inf-1']);
    assert(a.state === 'ok' && a.ids.has('inf-1') && !a.ids.has('inf-2'), 'read: firm A sees its own block');
    assert(b.state === 'ok' && b.ids.size === 0, "read: firm B does not see firm A's block");
    const pairs = await readFirmBlocksForPairs(store.sb, ['firm-A', 'firm-B'], ['inf-1']);
    assert(pairs.keys.has(firmBlockKey('firm-A', 'inf-1')), 'pairs: (A, inf-1) is blocked');
    assert(!pairs.keys.has(firmBlockKey('firm-B', 'inf-1')), 'pairs: (B, inf-1) is not');

    const missing = await readFirmBlocks(failTable(store.sb, FIRM_BLOCKS_TABLE, MISSING_TABLE), 'firm-A', ['inf-1']);
    assert(missing.state === 'table_missing' && missing.ids.size === 0, 'read: pre-056 reads as table_missing, no ids');
    const broken = await readFirmBlocks(failTable(store.sb, FIRM_BLOCKS_TABLE, TIMEOUT), 'firm-A', ['inf-1']);
    assert(broken.state === 'unreadable', 'read: a real failure is unreadable, not "no blocks"');
  }

  // ── 3. STOP → per-firm row, global untouched, idempotent ──────────────────
  {
    const store = makeStore();
    seedTwoLabels(store);
    const r1 = await ingestInboundReply(stop('ci-A', 'ext-1'), store.sb);
    assert(r1.campaign_influencer_advanced === true, 'stop: the reply is still ingested and the lead advanced');
    const rows = store.all(FIRM_BLOCKS_TABLE);
    assert(rows.length === 1, `stop: exactly one per-firm block row (got ${rows.length})`);
    assert(rows[0]?.firm_id === 'firm-A', "stop: the row is for the CAMPAIGN'S firm");
    assert(rows[0]?.influencer_id === 'inf-1', 'stop: the row names the creator');
    assert(rows[0]?.source === 'creator_opt_out', 'stop: source records it was the creator');
    const inf = store.all('influencers').find((r) => r.id === 'inf-1');
    assert(inf?.blocklisted === false, 'stop: the SHARED influencers.blocklisted column is not written');

    await ingestInboundReply(stop('ci-A', 'ext-2', 'unsubscribe'), store.sb);
    assert(store.all(FIRM_BLOCKS_TABLE).length === 1, 'stop: a second opt-out is idempotent (still one row)');

    // A non-opt-out reply writes no block at all.
    const s2 = makeStore();
    seedTwoLabels(s2);
    await ingestInboundReply(stop('ci-A', 'ext-3', "I can't stop listening to this, count me in"), s2.sb);
    assert(s2.all(FIRM_BLOCKS_TABLE).length === 0, 'stop: a keen reply containing "stop" blocks nobody');
  }

  // ── 4. Pre-056 fallback: the opt-out is never lost ────────────────────────
  {
    const store = makeStore();
    seedTwoLabels(store);
    const sb = failTable(store.sb, FIRM_BLOCKS_TABLE, MISSING_TABLE);
    const { warns } = await captureLogs(() => ingestInboundReply(stop('ci-A', 'ext-pre'), sb));
    const inf = store.all('influencers').find((r) => r.id === 'inf-1');
    assert(inf?.blocklisted === true, 'pre-056: STOP falls back to the global column');
    assert(
      warns.some((w) => /056/.test(w) && /GLOBAL/.test(w)),
      'pre-056: the fallback is logged, naming the migration and the global effect',
    );
  }
  {
    const store = makeStore();
    seedTwoLabels(store);
    const sb = failTable(store.sb, FIRM_BLOCKS_TABLE, TIMEOUT);
    const { result, errors } = await captureLogs(() =>
      honourOptOut(sb, { influencerId: 'inf-1', firmId: 'firm-A' }),
    );
    assert(
      result.scope === 'global_fallback' && result.why === 'firm_write_failed',
      'write failure: falls back to global, reason recorded',
    );
    assert(store.all('influencers')[0]?.blocklisted === true, 'write failure: global column set');
    assert(errors.some((e) => /FAILED/.test(e)), 'write failure: logged loudly');
  }
  {
    const store = makeStore();
    seedTwoLabels(store);
    const { result } = await captureLogs(() => honourOptOut(store.sb, { influencerId: 'inf-1', firmId: null }));
    assert(result.scope === 'global_fallback' && result.why === 'firm_unknown', 'unknown firm: falls back to global');
    assert(store.all('influencers')[0]?.blocklisted === true, 'unknown firm: global column set');
  }

  // ── 5. Both writes fail → the loud OPT-OUT NOT HONOURED log ───────────────
  {
    const store = makeStore();
    seedTwoLabels(store);
    const sb = failGlobalWrite(failTable(store.sb, FIRM_BLOCKS_TABLE, MISSING_TABLE));
    const { result, errors } = await captureLogs(() => honourOptOut(sb, { influencerId: 'inf-1', firmId: 'firm-A' }));
    assert(result.scope === 'not_honoured', 'total failure: reported as not honoured');
    assert(errors.some((e) => /OPT-OUT NOT HONOURED/.test(e)), 'total failure: the loud error log is kept');
  }

  // ── 6. Dispatch: STOP to label A holds A's queue, not B's ─────────────────
  {
    const store = makeStore();
    seedTwoLabels(store);
    seedQueued(store, 'msg-A', 'ci-A');
    seedQueued(store, 'msg-B', 'ci-B');
    await ingestInboundReply(stop('ci-A', 'ext-d'), store.sb);

    // A row queued to A AFTER the STOP (e.g. a stale draft re-queued) is still
    // held by the dispatch gate itself.
    seedQueued(store, 'msg-A-late', 'ci-A');

    const r = recorder();
    const tally = await runDispatchPass(store.sb, { now: NOW, rand, dispatch: r.dispatch });
    assert(!r.calls.includes('msg-A'), 'dispatch: a queued message to a creator who said STOP to THIS label is not sent');
    assert(r.calls.includes('msg-B'), "dispatch: another label's queued message to the same creator still sends");
    assert(!r.calls.includes('msg-A-late'), 'dispatch: a row queued after the STOP is held by the gate');
    assert(tally.sent === 1 && tally.skipped === 1, `dispatch: one sent, the late row held (sent=${tally.sent} skipped=${tally.skipped})`);
    // Held is not cancelled. The STOP itself
    // cancels what was queued, so no stale offer stays live for a Send click
    // or a lifted block. Terminal and unsent, still inspectable, not deleted.
    const a = store.all('outreach_messages').find((m) => m.id === 'msg-A');
    assert(a?.status === 'superseded', `dispatch: the row queued before the STOP is cancelled ('superseded'), not deleted (got ${a?.status})`);
    const late = store.all('outreach_messages').find((m) => m.id === 'msg-A-late');
    assert(late?.status === 'queued', 'dispatch: the gate-held row stays queued and inspectable');
  }
  {
    // The global flag still gates EVERY label.
    const store = makeStore();
    seedTwoLabels(store);
    (store.all('influencers')[0] as Row).blocklisted = true;
    seedQueued(store, 'msg-A', 'ci-A');
    seedQueued(store, 'msg-B', 'ci-B');
    const r = recorder();
    await runDispatchPass(store.sb, { now: NOW, rand, dispatch: r.dispatch });
    assert(r.calls.length === 0, 'dispatch: a platform-level (global) block still holds every label');
  }

  // ── 7. Dispatch under a broken or missing table ───────────────────────────
  {
    const store = makeStore();
    seedTwoLabels(store);
    seedQueued(store, 'msg-A', 'ci-A');
    const r = recorder();
    const tally = await runDispatchPass(failTable(store.sb, FIRM_BLOCKS_TABLE, TIMEOUT), {
      now: NOW,
      rand,
      dispatch: r.dispatch,
    });
    assert(r.calls.length === 0, 'dispatch: an UNREADABLE block list holds the send (fail closed)');
    assert(tally.skipped === 1, 'dispatch: held rows are counted as skipped, retried next minute');
  }
  {
    const store = makeStore();
    seedTwoLabels(store);
    seedQueued(store, 'msg-A', 'ci-A');
    const r = recorder();
    await captureLogs(() =>
      runDispatchPass(failTable(store.sb, FIRM_BLOCKS_TABLE, MISSING_TABLE), { now: NOW, rand, dispatch: r.dispatch }),
    );
    assert(r.calls.includes('msg-A'), 'dispatch: pre-056 an un-blocked creator still sends (no regression)');
  }

  // ── 8. PATCH toggle ───────────────────────────────────────────────────────
  {
    const store = makeStore();
    seedTwoLabels(store);
    const base = { influencerId: 'inf-1', isOperator: false, userId: 'user_abc' };
    const r1 = await applyBlockToggle(store.sb, { ...base, firmId: 'firm-A', blocked: true, scope: 'firm' });
    assert(r1.ok && r1.applied === 'firm', 'toggle: a label user blocks for their own firm');
    const rows = store.all(FIRM_BLOCKS_TABLE);
    assert(rows.length === 1 && rows[0].firm_id === 'firm-A', 'toggle: one row, for the caller firm');
    assert(rows[0].source === 'label_user' && rows[0].created_by_user_id === 'user_abc', 'toggle: provenance recorded');
    assert(store.all('influencers')[0].blocklisted === false, 'toggle: label block never writes the shared column');

    await applyBlockToggle(store.sb, { ...base, firmId: 'firm-B', blocked: true, scope: 'firm' });
    await applyBlockToggle(store.sb, { ...base, firmId: 'firm-A', blocked: false, scope: 'firm' });
    const left = store.all(FIRM_BLOCKS_TABLE);
    assert(
      left.length === 1 && left[0].firm_id === 'firm-B',
      "toggle: firm A's unblock removes only firm A's row — firm B's block survives",
    );

    const denied = await applyBlockToggle(store.sb, { ...base, firmId: 'firm-A', blocked: true, scope: 'global' });
    assert(!denied.ok && denied.httpStatus === 403 && denied.error === 'operator_only', 'toggle: global scope is operator-only');
    assert(store.all('influencers')[0].blocklisted === false, 'toggle: a refused global write writes nothing');

    const op = await applyBlockToggle(store.sb, { ...base, isOperator: true, firmId: 'firm-A', blocked: true, scope: 'global' });
    assert(op.ok && op.applied === 'global', 'toggle: an operator can set the platform-wide block');
    assert(store.all('influencers')[0].blocklisted === true, 'toggle: operator global write lands on the shared column');
  }
  {
    const store = makeStore();
    seedTwoLabels(store);
    const sb = failTable(store.sb, FIRM_BLOCKS_TABLE, MISSING_TABLE);
    const { result } = await captureLogs(() =>
      applyBlockToggle(sb, { influencerId: 'inf-1', isOperator: false, userId: null, firmId: 'firm-A', blocked: true, scope: 'firm' }),
    );
    assert(result.ok && result.applied === 'global_fallback', 'toggle: pre-056 keeps the pre-056 global write');
    assert(store.all('influencers')[0].blocklisted === true, 'toggle: pre-056 block lands on the global column');

    const broken = await applyBlockToggle(failTable(store.sb, FIRM_BLOCKS_TABLE, TIMEOUT), {
      influencerId: 'inf-1',
      isOperator: false,
      userId: null,
      firmId: 'firm-A',
      blocked: false,
      scope: 'firm',
    });
    assert(!broken.ok && broken.httpStatus === 500, 'toggle: a real write failure is a 500, never a silent global write');
  }

  // ── 9. Every firm-pool reader consults the per-firm table ─────────────────
  const readers: Array<[string, RegExp]> = [
    ['src/app/api/campaigns/[id]/run/route.ts', /readFirmBlocks\(/],
    ['src/app/api/campaigns/[id]/draft-all/route.ts', /readFirmBlocks\(/],
    ['src/app/api/campaigns/[id]/qualify/route.ts', /readFirmBlocks\(/],
    ['src/app/api/outreach/[id]/send/route.ts', /readFirmBlocks\(/],
    ['src/app/api/influencers/roster/route.ts', /readFirmBlocks\(/],
    ['src/app/api/influencers/route.ts', /readFirmBlocks\(/],
    ['src/lib/influencer-detail-handlers.ts', /readFirmBlocks\(/],
    ['src/lib/influencer-detail-handlers.ts', /applyBlockToggle\(/],
    ['src/lib/outreach.ts', /readFirmBlocks\(/],
    ['src/lib/negotiation-tick.ts', /readFirmBlocksForPairs\(/],
    ['src/lib/ingest-inbound.ts', /honourOptOut\(/],
  ];
  for (const [file, re] of readers) {
    const src = stripComments(readFileSync(join(ROOT, file), 'utf8'));
    assert(re.test(src), `reader: ${file} calls ${re.source.replace('\\(', '')}`);
  }
  {
    const src = stripComments(readFileSync(join(ROOT, 'src/lib/ingest-inbound.ts'), 'utf8'));
    assert(
      !/update\(\s*\{\s*blocklisted:\s*true/.test(src),
      'ingest: no direct global blocklisted write left in ingest (only the logged fallback in firm-blocks.ts)',
    );
  }
  {
    const src = stripComments(readFileSync(join(ROOT, 'src/app/api/outreach/[id]/send/route.ts'), 'utf8'));
    assert(/unreadable/.test(src), 'send: the send boundary handles an unreadable block list (fail closed)');
  }

  console.log(`firm-blocks test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
