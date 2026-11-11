import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub
//
// tests/outreach-message-scope.test.ts
//
// The cross-label boundary on /api/outreach/messages/[id] and the two
// draft-generation routes, proven by RUNNING the handlers.
//
// The gap: requireSessionAndClient() hands every route the SERVICE-ROLE client
// (src/lib/auth.ts), so RLS never evaluates. GET, PATCH (body edit, counter
// edit, subject edit, email mark_sent) and DELETE loaded the message by id with
// no firm check — any signed-in user of any label could read, rewrite or
// delete another label's outreach. Only the human_queue mark_sent branch was
// gated (src/lib/dm-mark-sent.ts).
//
// What this pins:
//   1. The real GET/PATCH/DELETE handlers (src/lib/outreach-message-handlers.ts,
//      the exact functions the route exports) against an in-memory Supabase
//      double with two labels: firm B gets 404 on every verb and branch, the
//      row is untouched, nothing else is read or written; firm A still works.
//   2. A foreign 404 is byte-identical to an unknown-id 404 (no existence
//      oracle), an unscoped caller and an orphan message fail closed, and a
//      platform operator gets no cross-label access (repo convention).
//   3. leadInFirm / campaignInFirm — the gates added to /api/outreach/generate
//      and /generate-bulk — and the wire-up that those routes call them before
//      any model spend.
//
// Hermetic: no DB, no network. Run: npx tsx tests/outreach-message-scope.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeStore } from './negotiation-harness/store';
import type { Session } from '../src/lib/auth';
import { makeOutreachMessageHandlers } from '../src/lib/outreach-message-handlers';
import { campaignInFirm, leadInFirm, outreachMessageInFirm } from '../src/lib/outreach-scope';

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

type Store = ReturnType<typeof makeStore>;

function seedWorld(): Store {
  const s = makeStore();
  s.seed('campaigns', { id: 'camp-A', firm_id: FIRM_A, total_budget_usd: 10_000 });
  // An open offer for the counter: an edited counter price is
  // checked against it (ceiling + remaining budget) and refused without one.
  s.seed('creator_offers', {
    id: 'offer-A', campaign_influencer_id: 'ci-A', campaign_id: 'camp-A', firm_id: FIRM_A,
    status: 'offered', initial_offer_usd: 150, current_offer_usd: 150, ceiling_usd: 300,
  });
  s.seed('campaigns', { id: 'camp-B', firm_id: FIRM_B });
  s.seed('campaign_influencers', { id: 'ci-A', campaign_id: 'camp-A', influencer_id: 'inf-1' });
  s.seed('campaign_influencers', { id: 'ci-B', campaign_id: 'camp-B', influencer_id: 'inf-2' });
  s.seed('outreach_messages', {
    id: 'm-A',
    campaign_influencer_id: 'ci-A',
    subject: 'Label A pitch',
    body: 'Label A secret pitch copy',
    message_type: 'initial',
    direction: 'outbound',
    status: 'queued',
    channel: 'email',
    send_mode: null,
    sent_at: null,
  });
  s.seed('outreach_messages', {
    id: 'm-A-counter',
    campaign_influencer_id: 'ci-A',
    body: 'We can do $150.',
    message_type: 'counter',
    direction: 'outbound',
    status: 'queued',
    channel: 'email',
    sent_at: null,
  });
  s.seed('outreach_messages', { id: 'm-orphan', campaign_influencer_id: null, body: 'orphan' });
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

function session(firmId: string, email = 'someone@label.test'): Session {
  return { user: { id: `user-${firmId}`, email }, firm_id: firmId, role: 'owner' };
}

function harness(store: Store, sess: Session) {
  const spy = spyClient(store.sb);
  const h = makeOutreachMessageHandlers({
    requireSessionAndClient: async () => ({ session: sess, sb: spy.sb }),
  });
  return { h, ops: spy.ops };
}

let ipSeq = 0;
function req(method: string, body?: unknown): NextRequest {
  // A fresh IP per request so the in-memory 'auth' bucket never binds.
  ipSeq += 1;
  return new NextRequest(`http://localhost/api/outreach/messages/x`, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.${ipSeq >> 8}.${ipSeq & 255}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const WRITE_OPS = /\.(insert|update|upsert|delete)$/;

// ───────────────────────────────────────────────────────────────────────────
// 1. Firm B against firm A's message — every verb, every PATCH branch
// ───────────────────────────────────────────────────────────────────────────
async function foreignCallerGets404() {
  const cases: Array<{ name: string; run: (h: ReturnType<typeof harness>['h']) => Promise<Response>; id: string }> = [
    { name: 'GET', id: 'm-A', run: (h) => h.GET(req('GET'), ctx('m-A')) },
    { name: 'PATCH body edit', id: 'm-A', run: (h) => h.PATCH(req('PATCH', { body: 'hijacked' }), ctx('m-A')) },
    { name: 'PATCH subject edit', id: 'm-A', run: (h) => h.PATCH(req('PATCH', { subject: 'hijacked' }), ctx('m-A')) },
    {
      name: 'PATCH counter edit (editCounterDraft)',
      id: 'm-A-counter',
      run: (h) => h.PATCH(req('PATCH', { body: 'We can do $9999.', offer_usd: 9999 }), ctx('m-A-counter')),
    },
    { name: 'PATCH mark_sent (email)', id: 'm-A', run: (h) => h.PATCH(req('PATCH', { mark_sent: true }), ctx('m-A')) },
    { name: 'DELETE', id: 'm-A', run: (h) => h.DELETE(req('DELETE'), ctx('m-A')) },
  ];

  for (const c of cases) {
    const store = seedWorld();
    const before = JSON.stringify(store.all('outreach_messages'));
    const hb = harness(store, session(FIRM_B));
    const res = await c.run(hb.h);
    const text = await res.text();
    assert(res.status === 404, `firm B ${c.name} on firm A's message → 404 (got ${res.status})`);
    assert(!text.includes('Label A'), `firm B ${c.name}: response carries none of firm A's content`);
    assert(JSON.stringify(store.all('outreach_messages')) === before, `firm B ${c.name}: firm A's rows are untouched`);
    assert(!hb.ops.some((o) => WRITE_OPS.test(o)), `firm B ${c.name}: zero writes (ops: ${hb.ops.join(', ')})`);
    assert(
      !hb.ops.some((o) => o.startsWith('creator_offers') || o.startsWith('social_send_events')),
      `firm B ${c.name}: gate runs before any branch-specific read`,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 2. Firm A on its own message — unchanged behaviour
// ───────────────────────────────────────────────────────────────────────────
async function ownerStillWorks() {
  {
    const store = seedWorld();
    const { h } = harness(store, session(FIRM_A));
    const res = await h.GET(req('GET'), ctx('m-A'));
    const j = (await res.json()) as { body?: string };
    assert(res.status === 200 && j.body === 'Label A secret pitch copy', `firm A GET own message → 200 with body (got ${res.status})`);
  }
  {
    const store = seedWorld();
    const { h } = harness(store, session(FIRM_A));
    const res = await h.PATCH(req('PATCH', { body: 'edited by A', subject: 'new subj' }), ctx('m-A'));
    const row = store.all('outreach_messages').find((m) => m.id === 'm-A')!;
    assert(res.status === 200, `firm A PATCH body → 200 (got ${res.status})`);
    assert(row.body === 'edited by A' && row.edited_by_user === true && row.subject === 'new subj', 'firm A PATCH body: row updated');
  }
  {
    const store = seedWorld();
    const { h } = harness(store, session(FIRM_A));
    const res = await h.PATCH(req('PATCH', { body: 'We can do $175 for the reel.', offer_usd: 175 }), ctx('m-A-counter'));
    const row = store.all('outreach_messages').find((m) => m.id === 'm-A-counter')!;
    assert(res.status === 200, `firm A PATCH counter → 200 (got ${res.status})`);
    assert(row.body === 'We can do $175 for the reel.', 'firm A PATCH counter: body saved via editCounterDraft');
  }
  {
    const store = seedWorld();
    const before = JSON.stringify(store.all('outreach_messages'));
    const hA = harness(store, session(FIRM_A));
    const res = await hA.h.PATCH(req('PATCH', { mark_sent: true }), ctx('m-A'));
    const j = (await res.json()) as { error?: string; message?: string };
    assert(res.status === 409, `firm A PATCH mark_sent on an email row → 409 (got ${res.status})`);
    assert(j.error === 'use_send_route', `409 names the reason (got ${j.error})`);
    assert(j.message?.includes('POST /api/outreach/m-A/send') === true, '409 tells the caller which route sends it');
    assert(JSON.stringify(store.all('outreach_messages')) === before, 'email mark_sent writes nothing');
    assert(!hA.ops.some((o) => WRITE_OPS.test(o)), `email mark_sent: zero writes (ops: ${hA.ops.join(', ')})`);
  }
  {
    const store = seedWorld();
    const { h } = harness(store, session(FIRM_A));
    const res = await h.DELETE(req('DELETE'), ctx('m-A'));
    assert(res.status === 200, `firm A DELETE → 200 (got ${res.status})`);
    assert(!store.all('outreach_messages').some((m) => m.id === 'm-A'), 'firm A DELETE: row removed');
  }
  {
    const store = seedWorld();
    const { h } = harness(store, session(FIRM_A));
    const res = await h.PATCH(req('PATCH', {}), ctx('m-A'));
    assert(res.status === 400, `firm A PATCH with no fields → still 400 (got ${res.status})`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 3. No oracle, fail-closed edges, operator convention, auth passthrough
// ───────────────────────────────────────────────────────────────────────────
async function edges() {
  const store = seedWorld();
  const foreign = await harness(store, session(FIRM_B)).h.GET(req('GET'), ctx('m-A'));
  const unknown = await harness(store, session(FIRM_B)).h.GET(req('GET'), ctx('no-such-id'));
  assert(foreign.status === unknown.status, 'foreign id and unknown id share a status');
  assert((await foreign.text()) === (await unknown.text()), 'foreign id and unknown id share a body (no existence oracle)');

  for (const bad of ['', '   ']) {
    const r = await harness(seedWorld(), session(bad)).h.GET(req('GET'), ctx('m-A'));
    assert(r.status === 404, `unscoped caller ${JSON.stringify(bad)} → 404`);
  }
  const orphan = await harness(seedWorld(), session(FIRM_A)).h.DELETE(req('DELETE'), ctx('m-orphan'));
  assert(orphan.status === 404, 'a message with no lead has no owner → 404 even for a real firm');

  // Operators: every other tenant route pins them to session.firm_id too.
  const prevOps = process.env.OPERATOR_EMAILS;
  process.env.OPERATOR_EMAILS = 'ops@null.test';
  const op = await harness(seedWorld(), session(FIRM_B, 'ops@null.test')).h.GET(req('GET'), ctx('m-A'));
  assert(op.status === 404, 'a platform operator in firm B gets no cross-label read');
  if (prevOps === undefined) delete process.env.OPERATOR_EMAILS;
  else process.env.OPERATOR_EMAILS = prevOps;

  const h401 = makeOutreachMessageHandlers({
    requireSessionAndClient: async () => {
      throw new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    },
  });
  assert((await h401.GET(req('GET'), ctx('m-A'))).status === 401, 'no session → the 401 from auth passes through');
}

// ───────────────────────────────────────────────────────────────────────────
// 4. The gates on /generate and /generate-bulk
// ───────────────────────────────────────────────────────────────────────────
async function generateGates() {
  const store = seedWorld();
  assert((await leadInFirm(store.sb, 'ci-A', FIRM_A)) === true, 'leadInFirm: own lead → true');
  assert((await leadInFirm(store.sb, 'ci-A', FIRM_B)) === false, "leadInFirm: another label's lead → false");
  assert((await leadInFirm(store.sb, 'ci-none', FIRM_A)) === false, 'leadInFirm: unknown lead → false');
  assert((await leadInFirm(store.sb, 'ci-A', '')) === false, 'leadInFirm: unscoped caller → false');
  assert((await campaignInFirm(store.sb, 'camp-A', FIRM_A)) === true, 'campaignInFirm: own campaign → true');
  assert((await campaignInFirm(store.sb, 'camp-A', FIRM_B)) === false, "campaignInFirm: another label's campaign → false");
  assert((await campaignInFirm(store.sb, 'camp-none', FIRM_A)) === false, 'campaignInFirm: unknown → false');
  assert((await outreachMessageInFirm(store.sb, 'm-A', FIRM_A)) === true, 'outreachMessageInFirm: own → true');
  assert((await outreachMessageInFirm(store.sb, 'm-A', FIRM_B)) === false, 'outreachMessageInFirm: foreign → false');

  // Those two routes need Clerk + a model to run end to end, so their wiring
  // is pinned by source: the gate is called, and before any model spend.
  const ROOT = join(__dirname, '..');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const gen = strip(readFileSync(join(ROOT, 'src/app/api/outreach/generate/route.ts'), 'utf8'));
  const gi = gen.indexOf('leadInFirm(sb, campaign_influencer_id, session.firm_id)');
  assert(gi > 0, 'generate: calls leadInFirm with the session firm');
  assert(gi > 0 && gi < gen.indexOf('generateOutreachMessage({'), 'generate: gate precedes the model call');
  const bulk = strip(readFileSync(join(ROOT, 'src/app/api/outreach/generate-bulk/route.ts'), 'utf8'));
  const bi = bulk.indexOf('campaignInFirm(sb, campaign_id, session.firm_id)');
  assert(bi > 0, 'generate-bulk: calls campaignInFirm with the session firm');
  assert(bi > 0 && bi < bulk.indexOf('draftPoolFilter('), 'generate-bulk: gate precedes the target query');

  const route = strip(readFileSync(join(ROOT, 'src/app/api/outreach/messages/[id]/route.ts'), 'utf8'));
  assert(/makeOutreachMessageHandlers\(\{ requireSessionAndClient \}\)/.test(route), 'messages route: wires the real session into the tested handlers');
  for (const verb of ['GET', 'PATCH', 'DELETE']) {
    assert(new RegExp(`export const ${verb} = handlers\\.${verb};`).test(route), `messages route: exports the tested ${verb}`);
  }
}

async function main() {
  await foreignCallerGets404();
  await ownerStillWorks();
  await edges();
  await generateGates();
  if (failures.length > 0) console.error('\nFailures:\n - ' + failures.join('\n - '));
  console.log(`outreach-message-scope test: ${passed}/${passed + failed} pass`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
