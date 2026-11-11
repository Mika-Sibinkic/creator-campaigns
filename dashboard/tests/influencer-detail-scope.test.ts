import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub
//
// tests/influencer-detail-scope.test.ts
//
// The cross-label boundary on /api/influencers/[id], proven by RUNNING the
// handlers (src/lib/influencer-detail-handlers.ts — the exact functions the
// route exports) against an in-memory two-label database.
//
// The gap (tenant sweep, 2026-09-30): the handlers use the SERVICE-ROLE client,
// so RLS never evaluates, and `influencers` is ONE row per creator shared by
// every label.
//
//   HIGH  PATCH { contact_email } wrote the shared column after checking only
//         that the caller's label had SOME relationship with the creator. Label
//         A could point label B's outreach, counters and payout mail for a
//         shared creator at any address it liked.
//   MED   GET returned `select *` — every column any label's pipeline wrote,
//         including the payout account id and the reply timestamp another
//         label's creator conversation stamped on the shared row.
//
// What this pins:
//   1. checkSharedContactWrite — the pure decision, every branch.
//   2. firmsRelatedToCreator — the campaign → firm chain, fail-closed.
//   3. PATCH contact_email executed: a shared creator is 409 for both labels
//      and the row is untouched; a sole-label creator updates and is audited
//      old → new with firm and user; operators may change it; an unreadable
//      relationship list is 503, never a write.
//   4. The block branch still works per label (unchanged behaviour).
//   4b. GET returns an explicit allowlist of creator fields — no payout id,
//      no reply timestamp, no scan internals, no scraped author blob, nothing
//      a future column adds — and block state as THIS label sees it.
//   5. The route wires these handlers (who calls this?).
//
// Hermetic: no DB, no network. Run: npx tsx tests/influencer-detail-scope.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Session } from '../src/lib/auth';
import type { AuditEntry } from '../src/lib/audit';
import {
  checkSharedContactWrite,
  firmsRelatedToCreator,
  type CreatorFirmsRead,
} from '../src/lib/creator-scope';
import { makeInfluencerDetailHandlers } from '../src/lib/influencer-detail-handlers';
import { CREATOR_DETAIL_FIELDS, pickCreatorDetail } from '../src/lib/creator-detail';

process.env.OPERATOR_EMAILS = 'ops@operator.test';

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
const FIRM_C = 'cccccccc-3333-4333-8333-cccccccccccc';
const OPERATOR = 'ops@operator.test';

// ───────────────────────────────────────────────────────────────────────────
// In-memory Supabase double: enough of postgrest-js to run the real handlers
// unmodified — projection, count/head, eq/in/is, single/maybeSingle, update,
// upsert, delete — plus per-table error injection and an op log.
// ───────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface DbOpts {
  failTables?: string[];
  /** Runs after a SELECT on `table` resolves — to simulate a concurrent writer. */
  afterSelect?: (table: string, tables: Tables) => void;
}

function makeDb(tables: Tables, opts: DbOpts = {}) {
  const ops: string[] = [];
  const fail = new Set(opts.failTables ?? []);

  function from(table: string) {
    if (!tables[table]) tables[table] = [];
    const rows = tables[table];
    let op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
    let payload: Row | Row[] | null = null;
    let cols: string | undefined;
    let countMode = false;
    let conflict: string[] = [];
    let ignoreDup = false;
    const filters: Array<(r: Row) => boolean> = [];

    const project = (r: Row): Row => {
      if (!cols || cols.includes('*') || cols.includes('(')) return { ...r };
      const out: Row = {};
      for (const c of cols.split(',').map((s) => s.trim()).filter(Boolean)) out[c] = r[c];
      return out;
    };

    function exec(): { data: unknown; error: { message: string } | null; count?: number | null } {
      ops.push(`${table}.${op}`);
      if (fail.has(table)) return { data: null, error: { message: 'boom' }, count: null };
      const match = (r: Row) => filters.every((f) => f(r));
      if (op === 'insert') {
        const list = Array.isArray(payload) ? payload : [payload as Row];
        for (const r of list) rows.push({ ...r });
        return { data: list, error: null };
      }
      if (op === 'upsert') {
        const list = Array.isArray(payload) ? payload : [payload as Row];
        for (const r of list) {
          const hit = rows.find((e) => conflict.length > 0 && conflict.every((c) => e[c] === r[c]));
          if (hit) {
            if (!ignoreDup) Object.assign(hit, r);
          } else rows.push({ ...r });
        }
        return { data: list, error: null };
      }
      if (op === 'delete') {
        const removed: Row[] = [];
        for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i])) removed.push(...rows.splice(i, 1));
        return { data: removed, error: null };
      }
      if (op === 'update') {
        const out: Row[] = [];
        for (const r of rows) {
          if (match(r)) {
            Object.assign(r, payload as Row);
            out.push(project(r));
          }
        }
        return { data: out, error: null };
      }
      const out = rows.filter(match).map(project);
      const res = countMode ? { data: out, error: null, count: out.length } : { data: out, error: null };
      opts.afterSelect?.(table, tables);
      return res;
    }

    const api: Record<string, unknown> = {
      select(c?: string, o?: { count?: string }) {
        cols = c;
        if (o?.count) countMode = true;
        return api;
      },
      insert(p: Row | Row[]) {
        op = 'insert';
        payload = p;
        return api;
      },
      update(p: Row) {
        op = 'update';
        payload = p;
        return api;
      },
      upsert(p: Row | Row[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        op = 'upsert';
        payload = p;
        conflict = (o?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        ignoreDup = o?.ignoreDuplicates === true;
        return api;
      },
      delete() {
        op = 'delete';
        return api;
      },
      eq(c: string, v: unknown) {
        filters.push((r) => r[c] === v);
        return api;
      },
      in(c: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[c]));
        return api;
      },
      is(c: string, v: unknown) {
        filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v));
        return api;
      },
      order() {
        return api;
      },
      limit() {
        return api;
      },
      single() {
        const r = exec();
        const arr = (r.data as Row[] | null) ?? [];
        if (r.error) return Promise.resolve({ data: null, error: r.error });
        return Promise.resolve(arr.length ? { data: arr[0], error: null } : { data: null, error: { message: 'no rows' } });
      },
      maybeSingle() {
        const r = exec();
        const arr = (r.data as Row[] | null) ?? [];
        if (r.error) return Promise.resolve({ data: null, error: r.error });
        return Promise.resolve({ data: arr.length ? arr[0] : null, error: null });
      },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
        return Promise.resolve(exec()).then(res, rej);
      },
    };
    return api;
  }

  return { sb: { from } as unknown as SupabaseClient, ops, tables };
}

// ── The two-label world ─────────────────────────────────────────────────────
function world(): Tables {
  return {
    campaigns: [
      { id: 'camp-A', firm_id: FIRM_A, artist_name: 'A artist' },
      { id: 'camp-A2', firm_id: FIRM_A, artist_name: 'A artist 2' },
      { id: 'camp-B', firm_id: FIRM_B, artist_name: 'B secret artist' },
      { id: 'camp-null', firm_id: null, artist_name: 'legacy' },
    ],
    campaign_influencers: [
      { id: 'ci-A-shared', campaign_id: 'camp-A', influencer_id: 'inf-shared' },
      { id: 'ci-B-shared', campaign_id: 'camp-B', influencer_id: 'inf-shared' },
      { id: 'ci-A-sole', campaign_id: 'camp-A', influencer_id: 'inf-soleA' },
      { id: 'ci-A2-sole', campaign_id: 'camp-A2', influencer_id: 'inf-soleA' },
      { id: 'ci-B-sole', campaign_id: 'camp-B', influencer_id: 'inf-soleB' },
      { id: 'ci-A-legacy', campaign_id: 'camp-A', influencer_id: 'inf-legacy' },
      { id: 'ci-null-legacy', campaign_id: 'camp-null', influencer_id: 'inf-legacy' },
    ],
    influencers: [
      creator('inf-shared', 'real@creator.test'),
      creator('inf-soleA', 'old@creator.test'),
      creator('inf-soleB', 'b-only@creator.test'),
      creator('inf-legacy', 'legacy@creator.test'),
      creator('inf-orphan', null),
    ],
    firm_influencer_blocks: [],
  };
}

function creator(id: string, email: string | null): Row {
  return {
    id,
    platform: 'tiktok',
    username: `u_${id}`,
    display_name: `Creator ${id}`,
    profile_url: `https://tiktok.com/@u_${id}`,
    follower_count: 12000,
    engagement_rate: 0.08,
    bio: 'public bio',
    verified: false,
    avatar_url: null,
    content_genres: null,
    contact_email: email,
    bot_probability: 0.1,
    bot_flagged: false,
    blocklisted: false,
    score_breakdown: { audience_fit: 91 },
    posting_cadence: null,
    follower_following_ratio: 3.2,
    raw_data: { posts: [{ text: 'post one' }], authorMeta: { signature: 'bio', privateNote: 'x' } },
    created_at: '2026-09-01T00:00:00Z',
    synthetic: false,
    stripe_connect_account_id: 'acct_label_B_payout',
    contact_scanned_at: '2026-09-20T00:00:00Z',
    contact_scan_attempts: 2,
    last_response: '2026-09-29T12:00:00Z',
  };
}

function session(firmId: string, email: string | null = 'someone@label.test'): Session {
  return { user: { id: `user_${firmId.slice(0, 4)}`, email }, firm_id: firmId, role: 'owner' };
}

function harness(tables: Tables, sess: Session, opts: DbOpts = {}) {
  const db = makeDb(tables, opts);
  const audits: AuditEntry[] = [];
  const h = makeInfluencerDetailHandlers({
    requireSession: async () => sess,
    requireSessionAndClient: async () => ({ session: sess, sb: db.sb }),
    admin: () => db.sb,
    audit: async (e: AuditEntry) => {
      audits.push(e);
    },
  });
  return { h, ops: db.ops, audits };
}

let ipSeq = 0;
function req(method: string, body?: unknown): NextRequest {
  ipSeq += 1;
  return new NextRequest('http://localhost/api/influencers/x', {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.7.${ipSeq >> 8}.${ipSeq & 255}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const emailOf = (t: Tables, id: string) => t.influencers.find((r) => r.id === id)?.contact_email;
const influencerWrites = (ops: string[]) => ops.filter((o) => o === 'influencers.update' || o === 'influencers.upsert');

// ───────────────────────────────────────────────────────────────────────────
// 1. checkSharedContactWrite — the pure decision
// ───────────────────────────────────────────────────────────────────────────
{
  const read = (ids: string[], unscoped = 0): CreatorFirmsRead => ({ ok: true, firmIds: new Set(ids), unscopedCampaigns: unscoped });

  const sole = checkSharedContactWrite({ callerFirmId: FIRM_A, isOperator: false, related: read([FIRM_A]) });
  assert(sole.ok === true && sole.basis === 'sole_firm', 'sole label → may write (basis sole_firm)');

  const shared = checkSharedContactWrite({ callerFirmId: FIRM_A, isOperator: false, related: read([FIRM_A, FIRM_B]) });
  assert(!shared.ok && shared.httpStatus === 409, 'THE HEADLINE: a creator another label also works → 409');
  assert(!shared.ok && shared.error === 'shared_creator_contact', 'error is shared_creator_contact');
  assert(
    !shared.ok && 'message' in shared && /operator/i.test(shared.message),
    'the 409 tells the user an operator must change it'
  );
  assert(
    !shared.ok && 'message' in shared && !shared.message.includes(FIRM_B),
    'the 409 does not name the other label'
  );

  const legacy = checkSharedContactWrite({ callerFirmId: FIRM_A, isOperator: false, related: read([FIRM_A], 1) });
  assert(!legacy.ok && legacy.httpStatus === 409, 'a linked campaign with no firm is unknown ownership → 409 (fail closed)');

  const none = checkSharedContactWrite({ callerFirmId: FIRM_A, isOperator: false, related: read([FIRM_B]) });
  assert(!none.ok && none.httpStatus === 403 && 'reason' in none && none.reason === 'no_creator_relationship', 'no relationship → 403 no_creator_relationship');

  const empty = checkSharedContactWrite({ callerFirmId: FIRM_A, isOperator: false, related: read([]) });
  assert(!empty.ok && empty.httpStatus === 403, 'creator no label works → 403');

  const unreadable = checkSharedContactWrite({ callerFirmId: FIRM_A, isOperator: false, related: { ok: false, message: 'boom' } });
  assert(!unreadable.ok && unreadable.httpStatus === 503, 'unreadable relationships → 503, never an authorization');
  const unread = checkSharedContactWrite({ callerFirmId: FIRM_A, isOperator: false, related: null });
  assert(!unread.ok && unread.httpStatus === 503, 'relationships not read at all → 503');

  for (const bad of ['', '   ', null, undefined]) {
    const v = checkSharedContactWrite({ callerFirmId: bad, isOperator: false, related: read([FIRM_A]) });
    assert(!v.ok && v.httpStatus === 403 && 'reason' in v && v.reason === 'caller_unscoped', `unscoped caller ${JSON.stringify(bad)} → 403`);
  }

  const op = checkSharedContactWrite({ callerFirmId: FIRM_C, isOperator: true, related: null });
  assert(op.ok === true && op.basis === 'operator', 'a platform operator may change a shared contact');
}

// ───────────────────────────────────────────────────────────────────────────
// 2. firmsRelatedToCreator — campaign_influencers → campaigns.firm_id
// ───────────────────────────────────────────────────────────────────────────
async function chainTests() {
  {
    const r = await firmsRelatedToCreator(makeDb(world()).sb, 'inf-shared');
    assert(r.ok && r.firmIds.size === 2 && r.firmIds.has(FIRM_A) && r.firmIds.has(FIRM_B), 'shared creator → both labels');
  }
  {
    const r = await firmsRelatedToCreator(makeDb(world()).sb, 'inf-soleA');
    assert(r.ok && r.firmIds.size === 1 && r.firmIds.has(FIRM_A) && r.unscopedCampaigns === 0, 'two campaigns of one label → one label');
  }
  {
    const r = await firmsRelatedToCreator(makeDb(world()).sb, 'inf-legacy');
    assert(r.ok && r.unscopedCampaigns === 1, 'a firm-less campaign is counted, not dropped');
  }
  {
    const t = world();
    t.campaign_influencers.push({ id: 'ci-ghost', campaign_id: 'camp-missing', influencer_id: 'inf-soleA' });
    const r = await firmsRelatedToCreator(makeDb(t).sb, 'inf-soleA');
    assert(r.ok && r.unscopedCampaigns === 1, 'a linked campaign that cannot be read is unknown ownership');
  }
  {
    const r = await firmsRelatedToCreator(makeDb(world()).sb, 'inf-orphan');
    assert(r.ok && r.firmIds.size === 0, 'creator nobody works → empty');
  }
  for (const t of ['campaign_influencers', 'campaigns']) {
    const r = await firmsRelatedToCreator(makeDb(world(), { failTables: [t] }).sb, 'inf-shared');
    assert(!r.ok, `${t} unreadable → not ok (fail closed)`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 3. PATCH contact_email — executed
// ───────────────────────────────────────────────────────────────────────────
async function contactPatchTests() {
  // 3a. Shared creator: refused for BOTH labels, row untouched, nothing audited.
  for (const firm of [FIRM_A, FIRM_B]) {
    const t = world();
    const { h, ops, audits } = harness(t, session(firm));
    const res = await h.PATCH(req('PATCH', { contact_email: 'attacker@evil.test' }), ctx('inf-shared'));
    const j = (await res.json()) as { error?: string; message?: string };
    const who = firm === FIRM_A ? 'A' : 'B';
    assert(res.status === 409, `label ${who} on a shared creator → 409 (got ${res.status})`);
    assert(j.error === 'shared_creator_contact' && /operator/i.test(j.message ?? ''), `label ${who}: body names the operator path`);
    assert(emailOf(t, 'inf-shared') === 'real@creator.test', `label ${who}: shared contact_email untouched`);
    assert(influencerWrites(ops).length === 0, `label ${who}: zero writes to influencers (ops: ${ops.join(', ')})`);
    assert(audits.length === 0, `label ${who}: nothing audited for a refused change`);
  }

  // 3b. Blanking a shared creator's email is a change too.
  {
    const t = world();
    const { h } = harness(t, session(FIRM_A));
    const res = await h.PATCH(req('PATCH', { contact_email: '' }), ctx('inf-shared'));
    assert(res.status === 409 && emailOf(t, 'inf-shared') === 'real@creator.test', 'clearing a shared contact → 409, untouched');
  }

  // 3c. Sole label: updates, audited old → new with firm and user.
  {
    const t = world();
    const { h, audits } = harness(t, session(FIRM_A, 'mgr@labela.test'));
    const res = await h.PATCH(req('PATCH', { contact_email: 'new@creator.test' }), ctx('inf-soleA'));
    const j = (await res.json()) as { updated?: boolean; contact_email?: string };
    assert(res.status === 200 && j.updated === true && j.contact_email === 'new@creator.test', `sole label → 200 updated (got ${res.status})`);
    assert(emailOf(t, 'inf-soleA') === 'new@creator.test', 'sole label: row updated');
    assert(audits.length === 1, `sole label: exactly one audit row (got ${audits.length})`);
    const a = audits[0];
    const md = (a?.metadata ?? {}) as Record<string, unknown>;
    assert(a?.action === 'influencer.contact_email.update' && a.target_id === 'inf-soleA', 'audit: action + target');
    assert(md.old_contact_email === 'old@creator.test' && md.new_contact_email === 'new@creator.test', 'audit: old → new');
    assert(a?.firm_id === FIRM_A && md.firm_id === FIRM_A, 'audit: firm');
    assert(md.changed_by_user_id === session(FIRM_A).user.id && md.changed_by_email === 'mgr@labela.test', 'audit: user id + email');
    assert(typeof a?.actor_label === 'string' && a.actor_label.includes('mgr@labela.test'), 'audit: actor label is the user');
    assert(md.basis === 'sole_firm', 'audit: basis sole_firm');
  }

  // 3d. Sole label clears the email: '' → null, audited old → null.
  {
    const t = world();
    const { h, audits } = harness(t, session(FIRM_A));
    const res = await h.PATCH(req('PATCH', { contact_email: '' }), ctx('inf-soleA'));
    assert(res.status === 200 && emailOf(t, 'inf-soleA') === null, "sole label clears with '' → null");
    const md = (audits[0]?.metadata ?? {}) as Record<string, unknown>;
    assert(md.old_contact_email === 'old@creator.test' && md.new_contact_email === null, 'audit: old → null');
  }

  // 3e. Another label's sole creator: 403, untouched.
  {
    const t = world();
    const { h, ops, audits } = harness(t, session(FIRM_A));
    const res = await h.PATCH(req('PATCH', { contact_email: 'x@evil.test' }), ctx('inf-soleB'));
    assert(res.status === 403, `label A on label B's creator → 403 (got ${res.status})`);
    assert(emailOf(t, 'inf-soleB') === 'b-only@creator.test' && influencerWrites(ops).length === 0 && audits.length === 0, "label B's creator untouched");
  }

  // 3f. Legacy creator linked to a firm-less campaign: fail closed.
  {
    const t = world();
    const { h } = harness(t, session(FIRM_A));
    const res = await h.PATCH(req('PATCH', { contact_email: 'x@creator.test' }), ctx('inf-legacy'));
    assert(res.status === 409 && emailOf(t, 'inf-legacy') === 'legacy@creator.test', 'firm-less co-owner → 409, untouched');
  }

  // 3g. Relationship read fails → 503, no write.
  {
    const t = world();
    const { h, ops } = harness(t, session(FIRM_A), { failTables: ['campaigns'] });
    const res = await h.PATCH(req('PATCH', { contact_email: 'x@creator.test' }), ctx('inf-soleA'));
    assert(res.status === 503, `unreadable relationships → 503 (got ${res.status})`);
    assert(emailOf(t, 'inf-soleA') === 'old@creator.test' && influencerWrites(ops).length === 0, 'unreadable: no write');
  }

  // 3h. Unscoped caller → 403.
  {
    const t = world();
    const { h } = harness(t, session(''));
    const res = await h.PATCH(req('PATCH', { contact_email: 'x@creator.test' }), ctx('inf-soleA'));
    assert(res.status === 403 && emailOf(t, 'inf-soleA') === 'old@creator.test', 'unscoped caller → 403, untouched');
  }

  // 3i. Operator may change a shared creator — even from a label with no relationship.
  for (const firm of [FIRM_A, FIRM_C]) {
    const t = world();
    const { h, audits } = harness(t, session(firm, OPERATOR));
    const res = await h.PATCH(req('PATCH', { contact_email: 'fixed@creator.test' }), ctx('inf-shared'));
    assert(res.status === 200 && emailOf(t, 'inf-shared') === 'fixed@creator.test', `operator (firm ${firm.slice(0, 4)}) changes a shared contact → 200`);
    const md = (audits[0]?.metadata ?? {}) as Record<string, unknown>;
    assert(
      md.basis === 'operator' && md.old_contact_email === 'real@creator.test' && md.new_contact_email === 'fixed@creator.test',
      'operator change audited old → new, basis operator'
    );
  }

  // 3j. Operator on an unknown creator → 404, no write.
  {
    const t = world();
    const { h, ops } = harness(t, session(FIRM_A, OPERATOR));
    const res = await h.PATCH(req('PATCH', { contact_email: 'x@creator.test' }), ctx('inf-nope'));
    assert(res.status === 404 && influencerWrites(ops).length === 0, 'operator on an unknown creator → 404, no write');
  }

  // 3k. Same value → no write, no audit row.
  {
    const t = world();
    const { h, ops, audits } = harness(t, session(FIRM_A));
    const res = await h.PATCH(req('PATCH', { contact_email: 'old@creator.test' }), ctx('inf-soleA'));
    assert(res.status === 200 && influencerWrites(ops).length === 0 && audits.length === 0, 'unchanged value → 200, no write, no audit');
  }

  // 3l. Someone else changed it between read and write → 409, not a blind overwrite.
  {
    const t = world();
    let fired = false;
    const { h, audits } = harness(t, session(FIRM_A), {
      afterSelect: (table, tables) => {
        if (table !== 'influencers' || fired) return;
        fired = true;
        const row = tables.influencers.find((r) => r.id === 'inf-soleA');
        if (row) row.contact_email = 'concurrent@creator.test';
      },
    });
    const res = await h.PATCH(req('PATCH', { contact_email: 'new@creator.test' }), ctx('inf-soleA'));
    assert(res.status === 409, `concurrent change → 409 (got ${res.status})`);
    assert(emailOf(t, 'inf-soleA') === 'concurrent@creator.test' && audits.length === 0, 'concurrent change: the other write survives, nothing audited');
  }

  // 3m. Validation still runs.
  {
    const t = world();
    const { h } = harness(t, session(FIRM_A));
    const res = await h.PATCH(req('PATCH', { contact_email: 'not-an-email' }), ctx('inf-soleA'));
    assert(res.status === 422 && emailOf(t, 'inf-soleA') === 'old@creator.test', 'invalid email → 422');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Block branch — unchanged, per label
// ───────────────────────────────────────────────────────────────────────────
async function blockBranchTests() {
  {
    const t = world();
    const { h, audits } = harness(t, session(FIRM_A));
    const res = await h.PATCH(req('PATCH', { blocklisted: true }), ctx('inf-shared'));
    const j = (await res.json()) as { scope?: string };
    assert(res.status === 200 && j.scope === 'firm', `label A blocks a shared creator for itself → 200 firm (got ${res.status})`);
    assert(
      t.firm_influencer_blocks.length === 1 && t.firm_influencer_blocks[0].firm_id === FIRM_A,
      "the block is label A's row only"
    );
    assert(t.influencers.find((r) => r.id === 'inf-shared')?.blocklisted === false, 'the shared global flag is untouched');
    assert(audits[0]?.action === 'influencer.blocklist.update', 'block audited');
  }
  {
    const t = world();
    const { h } = harness(t, session(FIRM_A));
    const res = await h.PATCH(req('PATCH', { blocklisted: true }), ctx('inf-soleB'));
    assert(res.status === 403 && t.firm_influencer_blocks.length === 0, 'block on a creator label A never worked → 403');
  }
  {
    const t = world();
    const { h } = harness(t, session(FIRM_A));
    const res = await h.PATCH(req('PATCH', { blocklisted: true, scope: 'global' }), ctx('inf-shared'));
    assert(res.status === 403 && t.influencers.find((r) => r.id === 'inf-shared')?.blocklisted === false, 'a label cannot set the global block');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 4b. GET — an explicit allowlist, this label's block view, this label's rows
// ───────────────────────────────────────────────────────────────────────────
const FIRM_VIEW_KEYS = ['blocklisted', 'firm_blocked', 'do_not_contact', 'campaign_appearances'];

async function getJson(t: Tables, firm: string, id: string) {
  const { h } = harness(t, session(firm));
  const res = await h.GET(req('GET'), ctx(id));
  const text = await res.text();
  return { status: res.status, text, j: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

async function getTests() {
  // Label A has STOP-blocked the shared creator; the row carries label B's
  // payout account and another label's reply timestamp.
  const seeded = () => {
    const t = world();
    t.firm_influencer_blocks.push({
      firm_id: FIRM_A,
      influencer_id: 'inf-shared',
      source: 'creator_opt_out',
      reason: 'STOP reply to label A',
      created_by_user_id: null,
    });
    const shared = t.influencers.find((r) => r.id === 'inf-shared')!;
    shared.future_private_column = 'written by some other pipeline';
    return t;
  };

  for (const firm of [FIRM_A, FIRM_B, FIRM_C]) {
    const who = firm === FIRM_A ? 'A' : firm === FIRM_B ? 'B' : 'C';
    const { status, text, j } = await getJson(seeded(), firm, 'inf-shared');
    assert(status === 200, `label ${who} GET shared creator → 200 (got ${status})`);
    const allowed = new Set<string>([...CREATOR_DETAIL_FIELDS, ...FIRM_VIEW_KEYS]);
    const extra = Object.keys(j).filter((k) => !allowed.has(k));
    assert(extra.length === 0, `label ${who}: only allowlisted keys (extra: ${extra.join(', ')})`);
    for (const k of [
      'stripe_connect_account_id',
      'last_response',
      'contact_scanned_at',
      'contact_scan_attempts',
      'score_breakdown',
      'synthetic',
      'future_private_column',
    ]) {
      assert(!(k in j), `label ${who}: ${k} is not returned`);
    }
    assert(!text.includes('acct_label_B_payout'), `label ${who}: no payout account id anywhere in the body`);
    assert(!text.includes('STOP reply to label A'), `label ${who}: no block reason anywhere in the body`);
    assert(!text.includes('privateNote'), `label ${who}: raw_data carries posts only, not the scraped author blob`);
    const rd = j.raw_data as { posts?: unknown[] } | null;
    assert(Array.isArray(rd?.posts) && rd!.posts!.length === 1, `label ${who}: raw_data.posts still returned for the posts grid`);
    assert(j.username === 'u_inf-shared' && j.follower_count === 12000, `label ${who}: public profile fields present`);
    if (firm !== FIRM_B) assert(!text.includes('B secret artist'), `label ${who}: none of label B's campaigns`);
  }

  // Block state is THIS label's view.
  {
    const a = (await getJson(seeded(), FIRM_A, 'inf-shared')).j;
    assert(a.firm_blocked === true && a.do_not_contact === 'blocked', "label A sees its own opt-out");
    const b = (await getJson(seeded(), FIRM_B, 'inf-shared')).j;
    assert(b.firm_blocked === false && b.do_not_contact === 'clear', "label B does not see label A's opt-out");
    assert(b.blocklisted === false, 'no platform block → blocklisted false');
  }
  {
    const t = seeded();
    t.influencers.find((r) => r.id === 'inf-shared')!.blocklisted = true;
    const b = (await getJson(t, FIRM_B, 'inf-shared')).j;
    assert(b.blocklisted === true && b.do_not_contact === 'blocked', 'the platform block gates every label, so every label sees it');
  }
  {
    const t = seeded();
    const { h } = harness(t, session(FIRM_A), { failTables: ['firm_influencer_blocks'] });
    const res = await h.GET(req('GET'), ctx('inf-shared'));
    const j = (await res.json()) as Record<string, unknown>;
    assert(res.status === 200 && j.do_not_contact === 'unknown', 'unreadable block list → do_not_contact unknown, never clear');
  }

  // Contact: related labels see where their mail goes; an unrelated label does not.
  {
    const a = (await getJson(seeded(), FIRM_A, 'inf-shared')).j;
    const c = (await getJson(seeded(), FIRM_C, 'inf-shared')).j;
    assert(a.contact_email === 'real@creator.test', 'a label that works the creator sees the address its outreach uses');
    assert(c.contact_email === null, 'a label that never worked the creator gets contact_email null');
  }

  // Appearances are this label's only.
  {
    const b = (await getJson(seeded(), FIRM_B, 'inf-shared')).j;
    const ids = (b.campaign_appearances as Row[]).map((r) => r.id);
    assert(ids.length === 1 && ids[0] === 'ci-B-shared', `label B sees only its own appearance (got ${ids.join(', ')})`);
    const c = (await getJson(seeded(), FIRM_C, 'inf-shared')).j;
    assert((c.campaign_appearances as Row[]).length === 0, 'an unrelated label sees no appearances');
  }

  // Unknown id: 404 with no database error text.
  {
    const { status, text } = await getJson(world(), FIRM_A, 'inf-nope');
    assert(status === 404 && !/rows|boom|PGRST/i.test(text), `unknown creator → generic 404 (got ${status} ${text})`);
  }

  // Pure helper: allowlist ignores unknown columns and normalises raw_data.
  {
    const out = pickCreatorDetail({ id: 'x', username: 'u', stripe_connect_account_id: 'acct', raw_data: 'junk' });
    assert(!('stripe_connect_account_id' in out) && out.username === 'u', 'pickCreatorDetail drops non-allowlisted columns');
    assert(out.raw_data === null, 'pickCreatorDetail: non-object raw_data → null');
    assert(out.display_name === null, 'pickCreatorDetail: absent allowlisted field → null (stable shape)');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 5. Wiring — the route exports these handlers
// ───────────────────────────────────────────────────────────────────────────
function wiringTests() {
  const route = readFileSync(join(process.cwd(), 'src', 'app', 'api', 'influencers', '[id]', 'route.ts'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  assert(/makeInfluencerDetailHandlers\(/.test(route), 'route builds its handlers from makeInfluencerDetailHandlers');
  assert(/export const GET = handlers\.GET/.test(route) && /export const PATCH = handlers\.PATCH/.test(route), 'route exports GET and PATCH from them');
  assert(!/\.from\(/.test(route), 'route runs no query of its own that could bypass the handlers');
}

async function main() {
  await chainTests();
  await contactPatchTests();
  await blockBranchTests();
  await getTests();
  wiringTests();
  if (failures.length > 0) console.error('\nFailures:\n - ' + failures.join('\n - '));
  console.log(`influencer-detail-scope test: ${passed}/${passed + failed} pass`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
