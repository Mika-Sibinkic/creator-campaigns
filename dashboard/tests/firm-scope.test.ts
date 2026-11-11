// tests/firm-scope.test.ts
//
// Proves the money-path authorization boundary that POST /api/payments/authorize
// was missing: unauthenticated is refused, cross-firm is refused, and the
// legitimate same-firm path still mints exactly one authorization row.
//
// Three layers, because each catches a different regression:
//   1. checkFirmScope   — the pure predicate. Every deny branch + the
//                         invariant that ok never fires on mismatched or
//                         blank input.
//   2. authorizePaymentForOffer — the real route core against an in-memory
//                         Supabase fake. Proves the guard is actually wired
//                         into the decision table, in the right ORDER, and
//                         that a refused call writes nothing and audits
//                         nothing.
//   3. source invariants — every route under src/app/api/payments/** calls
//                         requireSession(), and every money route firm-scopes.
//                         This is the guard against the exact drift that
//                         caused the bug: a new route added without auth.
//
// Hermetic: no env, no network, no DB. The fake store is local to this file
// (same convention as tests/spend-caps.test.ts, which forked its own rather
// than widening the shared negotiation harness).
//
// Run: npx tsx tests/firm-scope.test.ts

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkFirmScope, firmScopeErrorBody } from '../src/lib/firm-scope';
import {
  authorizePaymentForOffer,
  type AuthorizePaymentHooks,
} from '../src/lib/authorize-payment';

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

// Deliberately letter-bearing hex so .toUpperCase() is a real difference.
const FIRM_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const FIRM_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

// ───────────────────────────────────────────────────────────────────────────
// 1. checkFirmScope — the pure predicate
// ───────────────────────────────────────────────────────────────────────────
{
  // Unauthenticated: no session at all.
  const noSession = checkFirmScope(null, FIRM_A);
  assert(noSession.ok === false, 'null caller firm → refused');
  assert(
    noSession.ok === false && noSession.httpStatus === 401,
    `null caller firm → 401 (got ${noSession.ok === false ? noSession.httpStatus : 'ok'})`
  );
  assert(
    noSession.ok === false && noSession.reason === 'no_session',
    'null caller firm → reason no_session'
  );

  const undef = checkFirmScope(undefined, FIRM_A);
  assert(undef.ok === false && undef.httpStatus === 401, 'undefined caller firm → 401');

  // Authenticated but unprovisioned: getSession() returns firm_id '' for a
  // Clerk user with no firm_members row (src/lib/auth.ts:111). This is the
  // value that used to bypass the execute-path guard entirely.
  const unprovisioned = checkFirmScope('', FIRM_A);
  assert(unprovisioned.ok === false, "caller firm '' → refused");
  assert(
    unprovisioned.ok === false && unprovisioned.httpStatus === 403,
    "caller firm '' → 403"
  );
  assert(
    unprovisioned.ok === false && unprovisioned.reason === 'caller_unscoped',
    "caller firm '' → reason caller_unscoped"
  );

  // THE regression that mattered: '' must not compare equal to ''.
  const bothBlank = checkFirmScope('', '');
  assert(bothBlank.ok === false, "blank caller vs blank row → refused (NOT a match)");

  const whitespace = checkFirmScope('   ', '   ');
  assert(whitespace.ok === false, 'whitespace-only firm ids → refused');

  // Row carries no firm.
  const rowNull = checkFirmScope(FIRM_A, null);
  assert(
    rowNull.ok === false && rowNull.reason === 'row_unscoped',
    'null row firm → reason row_unscoped'
  );
  assert(rowNull.ok === false && rowNull.httpStatus === 403, 'null row firm → 403');

  // Cross-firm.
  const cross = checkFirmScope(FIRM_A, FIRM_B);
  assert(cross.ok === false, 'firm A caller vs firm B row → refused');
  assert(cross.ok === false && cross.httpStatus === 403, 'cross-firm → 403');
  assert(
    cross.ok === false && cross.reason === 'firm_mismatch',
    'cross-firm → reason firm_mismatch'
  );
  assert(
    cross.ok === false && firmScopeErrorBody(cross).error === 'forbidden',
    "cross-firm body keeps the existing { error: 'forbidden' } shape"
  );

  // No normalization: a value that needs trimming to match must not match.
  assert(checkFirmScope(` ${FIRM_A}`, FIRM_A).ok === false, 'leading-space firm id → refused');
  assert(
    checkFirmScope(FIRM_A.toUpperCase(), FIRM_A).ok === false,
    'case-differing firm id → refused (exact comparison)'
  );

  // The legitimate path.
  const match = checkFirmScope(FIRM_A, FIRM_A);
  assert(match.ok === true, 'same-firm caller → allowed');
  assert(match.ok === true && match.firmId === FIRM_A, 'allowed verdict carries the firm id');
}

// ── INVARIANT: ok is only ever reachable for two equal, non-blank strings ──
{
  const values: Array<string | null | undefined> = [
    null,
    undefined,
    '',
    '   ',
    '\t',
    FIRM_A,
    FIRM_B,
    ` ${FIRM_A}`,
    FIRM_A.toUpperCase(),
  ];
  let violations = 0;
  let statusViolations = 0;
  let checked = 0;
  for (const caller of values) {
    for (const row of values) {
      checked++;
      const v = checkFirmScope(caller, row);
      const shouldAllow =
        typeof caller === 'string' &&
        caller.trim().length > 0 &&
        typeof row === 'string' &&
        row.trim().length > 0 &&
        caller === row;
      if (v.ok !== shouldAllow) violations++;
      if (v.ok === false && v.httpStatus !== 401 && v.httpStatus !== 403) statusViolations++;
    }
  }
  assert(checked === 81, `invariant table covered every pair (${checked}/81)`);
  assert(violations === 0, `no input allows a caller it should not (${violations} violations)`);
  assert(statusViolations === 0, `every denial is 401 or 403 (${statusViolations} violations)`);
}

// ───────────────────────────────────────────────────────────────────────────
// 2. authorizePaymentForOffer — the real route core, against a fake store
// ───────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/**
 * Drop `//` line comments and block comments, so a source-text assertion tests
 * the CODE rather than what the code says about itself.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * Minimal in-memory Supabase fake supporting exactly the chains the authorize
 * core uses:
 *   from(t).select(c).eq(c, v).single()
 *   from(t).select(c).eq(c, v).maybeSingle()
 *   from(t).insert(row).select().single()
 *   from(t).update(patch).eq(c, v).is(c, null)….select().maybeSingle()
 *
 * insert/update/is replaced upsert: the core does not
 * blind-upsert — a first mint is an INSERT, and a write to an
 * existing row is a compare-and-set UPDATE.
 *
 * `maybeSingle` and the `firms` table arrived with split settlement: the core now
 * reads the firm's deposit policy to decide which leg to reserve. A double that
 * is missing a method the production path depends on makes a correct change look
 * like a broken one, so it gets taught rather than worked around — same call as
 * commit 5548376, which had to teach `.is()` for the same reason.
 */
function makeStore() {
  const tables: Record<string, Row[]> = { creator_offers: [], payment_authorizations: [], firms: [] };
  let seq = 0;

  class Query implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
    private filters: Array<{ col: string; val: unknown; is?: boolean }> = [];
    private op: 'select' | 'upsert' | 'insert' | 'update' = 'select';
    private payload: Row | null = null;
    private conflictCol = 'id';
    insert(payload: Row): this {
      this.op = 'insert';
      this.payload = payload;
      return this;
    }
    update(patch: Row): this {
      this.op = 'update';
      this.payload = patch;
      return this;
    }
    /** `.is(col, null)` — the conditional-write shape. */
    is(col: string, val: unknown): this {
      this.filters.push({ col, val, is: true });
      return this;
    }
    constructor(private table: string) {}
    private rows(): Row[] {
      if (!tables[this.table]) tables[this.table] = [];
      return tables[this.table];
    }
    select(_cols?: string): this {
      void _cols;
      return this;
    }
    eq(col: string, val: unknown): this {
      this.filters.push({ col, val });
      return this;
    }
    upsert(payload: Row, opts?: { onConflict?: string }): this {
      this.op = 'upsert';
      this.payload = payload;
      if (opts?.onConflict) this.conflictCol = opts.onConflict;
      return this;
    }
    private exec(): { data: Row[]; error: { message: string } | null } {
      const rows = this.rows();
      const matches = (r: Row) => this.filters.every((f) => (f.is ? r[f.col] == null && f.val === null : r[f.col] === f.val));
      if (this.op === 'insert') {
        seq += 1;
        const row: Row = { id: `${this.table}-${seq}`, ...(this.payload as Row) };
        rows.push(row);
        return { data: [{ ...row }], error: null };
      }
      if (this.op === 'update') {
        const out: Row[] = [];
        for (const r of rows) {
          if (!matches(r)) continue;
          Object.assign(r, this.payload as Row);
          out.push({ ...r });
        }
        return { data: out, error: null };
      }
      if (this.op === 'upsert') {
        const p = this.payload as Row;
        const key = p[this.conflictCol];
        const existing = rows.find((r) => r[this.conflictCol] === key);
        if (existing) {
          Object.assign(existing, p);
          return { data: [{ ...existing }], error: null };
        }
        seq += 1;
        const row: Row = { id: `${this.table}-${seq}`, ...p };
        rows.push(row);
        return { data: [{ ...row }], error: null };
      }
      return {
        data: rows.filter(matches).map((r) => ({ ...r })),
        error: null,
      };
    }
    single() {
      const { data } = this.exec();
      if (data.length === 0) return Promise.resolve({ data: null, error: { message: 'no rows' } });
      return Promise.resolve({ data: data[0], error: null });
    }
    /** Zero rows is a null datum, NOT an error — the difference the caller relies on. */
    maybeSingle() {
      const { data } = this.exec();
      return Promise.resolve({ data: data.length === 0 ? null : data[0], error: null });
    }
    then<T1 = { data: unknown; error: { message: string } | null }, T2 = never>(
      onfulfilled?: ((v: { data: unknown; error: { message: string } | null }) => T1 | PromiseLike<T1>) | null,
      onrejected?: ((r: unknown) => T2 | PromiseLike<T2>) | null
    ): Promise<T1 | T2> {
      return Promise.resolve(this.exec()).then(onfulfilled, onrejected);
    }
  }

  const sb = { from: (t: string) => new Query(t) } as unknown as SupabaseClient;
  return {
    sb,
    tables,
    seedOffer(row: Row) {
      tables.creator_offers.push(row);
      return row;
    },
    seedFirm(row: Row) {
      tables.firms.push(row);
      return row;
    },
  };
}

function validOffer(over: Row = {}): Row {
  return {
    id: 'offer-1',
    campaign_id: 'campaign-1',
    firm_id: FIRM_A,
    status: 'human_approval_required',
    agreed_amount_usd: 185,
    ceiling_usd: 250,
    ...over,
  };
}

/** Audit spy matching the injected hook shape. */
function spyHooks(): { hooks: AuthorizePaymentHooks; calls: Row[] } {
  const calls: Row[] = [];
  return {
    calls,
    hooks: {
      audit: async (entry) => {
        calls.push(entry as unknown as Row);
      },
    },
  };
}

// CJS output (package.json has no "type": "module"), so the awaiting blocks
// live in a function rather than at top level.
async function runCoreTests() {
// ── 2a. Unauthenticated caller (no session → firm id null) is refused ──────
{
  const store = makeStore();
  store.seedOffer(validOffer());
  const { hooks, calls } = spyHooks();
  const out = await authorizePaymentForOffer(
    store.sb,
    { creatorOfferId: 'offer-1', callerFirmId: null },
    hooks
  );
  assert(out.httpStatus === 401, `unauthenticated authorize → 401 (got ${out.httpStatus})`);
  assert(out.body.error === 'unauthorized', 'unauthenticated authorize → error unauthorized');
  assert(
    store.tables.payment_authorizations.length === 0,
    'unauthenticated authorize writes NO payment_authorizations row'
  );
  assert(calls.length === 0, 'unauthenticated authorize writes no audit row');
}

// ── 2b. Unprovisioned caller (firm_id '') is refused, not waved through ────
{
  const store = makeStore();
  store.seedOffer(validOffer());
  const { hooks } = spyHooks();
  const out = await authorizePaymentForOffer(
    store.sb,
    { creatorOfferId: 'offer-1', callerFirmId: '' },
    hooks
  );
  assert(out.httpStatus === 403, `unprovisioned caller → 403 (got ${out.httpStatus})`);
  assert(
    store.tables.payment_authorizations.length === 0,
    'unprovisioned caller writes NO payment_authorizations row'
  );
}

// ── 2c. THE BUG: cross-firm caller is refused ─────────────────────────────
{
  const store = makeStore();
  store.seedOffer(validOffer({ firm_id: FIRM_B }));
  const { hooks, calls } = spyHooks();
  const out = await authorizePaymentForOffer(
    store.sb,
    { creatorOfferId: 'offer-1', callerFirmId: FIRM_A, actorUserId: 'user_attacker' },
    hooks
  );
  assert(out.httpStatus === 403, `firm A acting on firm B's offer → 403 (got ${out.httpStatus})`);
  assert(out.body.error === 'forbidden', "cross-firm → error 'forbidden'");
  assert(out.body.reason === 'firm_mismatch', 'cross-firm → reason firm_mismatch');
  assert(
    store.tables.payment_authorizations.length === 0,
    'cross-firm authorize mints NO authorization row into the victim firm queue'
  );
  assert(calls.length === 0, 'cross-firm authorize writes no audit row');
}

// ── 2d. Guard ORDER: firm check precedes every state check ────────────────
// A cross-firm caller must not be able to read another firm's offer state off
// the 400/409 responses. Every one of these is firm B's offer in a state that
// would otherwise produce a distinctive error.
{
  const cases: Array<{ label: string; over: Row }> = [
    { label: 'wrong status', over: { status: 'negotiating' } },
    { label: 'no agreed amount', over: { agreed_amount_usd: null } },
    { label: 'above ceiling', over: { agreed_amount_usd: 900, ceiling_usd: 250 } },
  ];
  let leaks = 0;
  for (const c of cases) {
    const store = makeStore();
    store.seedOffer(validOffer({ firm_id: FIRM_B, ...c.over }));
    const { hooks } = spyHooks();
    const out = await authorizePaymentForOffer(
      store.sb,
      { creatorOfferId: 'offer-1', callerFirmId: FIRM_A },
      hooks
    );
    if (out.httpStatus !== 403) leaks++;
  }
  assert(leaks === 0, `cross-firm caller always gets 403, never a state-revealing code (${leaks} leaks)`);
}

// ── 2e. Unknown offer → 404 ───────────────────────────────────────────────
{
  const store = makeStore();
  const { hooks } = spyHooks();
  const out = await authorizePaymentForOffer(
    store.sb,
    { creatorOfferId: 'nope', callerFirmId: FIRM_A },
    hooks
  );
  assert(out.httpStatus === 404, `unknown offer → 404 (got ${out.httpStatus})`);
}

// ── 2f. The legitimate path still works ───────────────────────────────────
{
  const store = makeStore();
  store.seedOffer(validOffer());
  const { hooks, calls } = spyHooks();
  const out = await authorizePaymentForOffer(
    store.sb,
    { creatorOfferId: 'offer-1', callerFirmId: FIRM_A, actorUserId: 'user_operator' },
    hooks
  );
  assert(out.httpStatus === 200, `same-firm authorize → 200 (got ${out.httpStatus})`);
  assert(
    store.tables.payment_authorizations.length === 1,
    'same-firm authorize mints exactly one authorization row'
  );
  const row = store.tables.payment_authorizations[0];
  assert(row.status === 'pending_human_review', "minted row starts in 'pending_human_review'");
  assert(row.firm_id === FIRM_A, 'minted row carries the OFFER firm id');
  assert(row.amount_usd === 185, 'minted row carries the agreed amount, not a caller-supplied one');
  assert(row.creator_offer_id === 'offer-1', 'minted row links the creator offer');
  assert(
    row.human_approved_at == null && row.human_approved_by_user_id == null,
    'minted row carries NO human approval — the CHECK-constrained gate is untouched'
  );
  assert(calls.length === 1, 'legitimate authorize writes exactly one audit row');
  assert(
    calls[0].action === 'payment.authorization_created',
    'audit action is payment.authorization_created'
  );
  assert(
    calls[0].actor_user_id === 'user_operator',
    'audit row attributes the caller (was blank before the auth fix)'
  );
}

// ── 2g. Idempotent: a double-click does not mint a second row ─────────────
{
  const store = makeStore();
  store.seedOffer(validOffer());
  const { hooks } = spyHooks();
  const input = { creatorOfferId: 'offer-1', callerFirmId: FIRM_A, actorUserId: 'user_operator' };
  const first = await authorizePaymentForOffer(store.sb, input, hooks);
  const second = await authorizePaymentForOffer(store.sb, input, hooks);
  assert(first.httpStatus === 200 && second.httpStatus === 200, 'double authorize both 200');
  assert(
    store.tables.payment_authorizations.length === 1,
    'double authorize still yields exactly one row (the second is a compare-and-set refresh of the first)'
  );
}

}

// ───────────────────────────────────────────────────────────────────────────
// 3. Source invariants — the drift guard
// ───────────────────────────────────────────────────────────────────────────
{
  const API = join(__dirname, '..', 'src', 'app', 'api');
  const SRC = join(__dirname, '..', 'src');

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  const routeFiles = walk(API).filter((f) => f.endsWith(`${sep}route.ts`));
  const norm = (f: string) => relative(SRC, f).split(sep).join('/');

  // Every route under api/payments/** must authenticate in-route. The edge
  // session gate in middleware.ts is real, but it is ONE layer and it cannot
  // express firm ownership — a money route must not depend on it alone.
  //
  // api/payout/onboard/[pa_id] is deliberately excluded: creators are not app
  // users, they arrive from an email, and the middleware exempts it
  // (middleware.ts:84). Its guards are the unguessable v4 pa_id plus strict
  // state checks; adding a session requirement would break the flow.
  const PUBLIC_BY_DESIGN = new Set(['app/api/payout/onboard/[pa_id]/route.ts']);

  const paymentRoutes = routeFiles.filter((f) => {
    const n = norm(f);
    return n.startsWith('app/api/payments/') || n.startsWith('app/api/payout/');
  });
  assert(paymentRoutes.length >= 6, `found the payments/payout routes (${paymentRoutes.length})`);

  const unauthed: string[] = [];
  for (const f of paymentRoutes) {
    const n = norm(f);
    if (PUBLIC_BY_DESIGN.has(n)) continue;
    const src = readFileSync(f, 'utf8');
    if (!src.includes('requireSession')) unauthed.push(n);
  }
  assert(
    unauthed.length === 0,
    `every non-public payments/payout route calls requireSession (missing: ${unauthed.join(', ') || 'none'})`
  );

  // Every route that mutates a payment_authorizations row must firm-scope it.
  // Reads of pure env (payments/mode) are exempt: they touch no row.
  const MUTATORS = [
    'app/api/payments/authorize/route.ts',
    'app/api/payments/[id]/approve/route.ts',
    'app/api/payments/[id]/reject/route.ts',
    'app/api/payments/[id]/execute/route.ts',
  ];
  const unscoped: string[] = [];
  for (const rel of MUTATORS) {
    const f = join(SRC, ...rel.split('/'));
    const src = readFileSync(f, 'utf8');
    // Either the route checks scope itself, or it delegates to a core that
    // does (execute-payment.ts / authorize-payment.ts, both asserted below).
    const scopes =
      src.includes('checkFirmScope') ||
      src.includes('expectedFirmId') ||
      src.includes('callerFirmId');
    if (!scopes) unscoped.push(rel);
  }
  assert(
    unscoped.length === 0,
    `every payment_authorizations mutator firm-scopes (missing: ${unscoped.join(', ') || 'none'})`
  );

  for (const core of ['lib/authorize-payment.ts', 'lib/execute-payment.ts']) {
    const src = readFileSync(join(SRC, ...core.split('/')), 'utf8');
    assert(src.includes('checkFirmScope'), `${core} routes its firm check through checkFirmScope`);
  }

  // The old fail-open shape must not come back.
  const exec = readFileSync(join(SRC, 'lib', 'execute-payment.ts'), 'utf8');
  // Executable lines only — the docstring deliberately quotes the old shape.
  const execCode = exec
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
  assert(
    !execCode.includes('opts.expectedFirmId && '),
    'execute-payment no longer short-circuits its firm guard on a falsy firm id'
  );
  assert(
    /expectedFirmId: string;/.test(exec),
    'expectedFirmId is required in the type, so tsc forces every call site to supply it'
  );

  // The human-approval gate and the spend caps must still be in the path.
  assert(
    exec.includes('checkSpendCaps'),
    'execute-payment still runs the spend caps'
  );
  assert(
    exec.includes("!p.human_approved_at"),
    'execute-payment still requires human_approved_at before dispatch'
  );
  const authorizeSrc = readFileSync(join(SRC, 'lib', 'authorize-payment.ts'), 'utf8');
  assert(
    authorizeSrc.includes("status: 'pending_human_review'"),
    'authorize still mints rows in pending_human_review (never pre-approved)'
  );
  // Strip comments before the negative assertion. It is a source-text check, so
  // prose EXPLAINING why this module must not pre-approve would otherwise fail
  // it — documentation tripping the guard that documentation exists to support.
  // Same reason tests/campaign-budget-migration.test.ts strips SQL comments
  // before its structural assertions. The invariant itself is unchanged and
  // still the important one: nothing here may mint an already-approved row.
  //
  // The mint WRITES human_approved_at — as null: a
  // re-mint over a failed row must clear the old stamp or the 009 CHECK 500s.
  // It also READS the old stamp into the audit (prior_approval). So the check is
  // now: every `human_approved_at:` / `human_approved_by_user_id:` written
  // outside that audit block is the literal null.
  const authorizeCode = stripComments(authorizeSrc).replace(/prior_approval:\s*\{[^}]*\}/g, '');
  const stampWrites = authorizeCode.match(/human_approved_(at|by_user_id)\s*:\s*[^,\n}]+/g) ?? [];
  assert(
    stampWrites.length >= 2 && stampWrites.every((w) => /:\s*null$/.test(w.trim())),
    `authorize never writes a non-null human-approval stamp (got ${JSON.stringify(stampWrites)})`
  );
}

async function main() {
  await runCoreTests();
  if (failures.length > 0) console.error('\nFailures:\n - ' + failures.join('\n - '));
  console.log(`firm-scope test: ${passed}/${passed + failed} pass`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
