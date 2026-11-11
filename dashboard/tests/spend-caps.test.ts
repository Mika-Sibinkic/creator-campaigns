// tests/spend-caps.test.ts
//
// Hermetic tests for src/lib/spend-caps.ts — the three spend caps extracted
// from the execute route (#25) and now enforced on every money-out path,
// including the Stripe account.updated webhook.
//
// In-memory Supabase stub mirroring tests/negotiation-harness/store.ts, plus
// the two chains spend-caps needs that the harness store doesn't have:
//   .or('executed_at.gte.<iso>,executed_at.is.null')   (month window)
//   .eq('creator_offers.campaign_influencers.influencer_id', x)  (join filter,
//       resolved against nested objects on the seeded row)
//
// Covers: each cap trips strictly above its boundary (landing exactly on the
// cap passes), executing rows with NULL executed_at count as month spend, the
// current row is excluded (.neq), non-spent statuses don't count, lookup
// failures fail closed, and the webhook gate refuses the transfer + reverts
// the row to 'approved' (tested through a thin webhook-shaped harness: claim →
// gate → transfer-only-if-allowed).
//
// CENTREPIECE (caps-fail-closed): an unset campaign budget must BLOCK spend.
// campaigns.total_budget_usd NULL / 0 / negative / non-numeric used to disable
// the campaign cap entirely (`if (totalBudget > 0 && ...)`) — fail-open on
// money. It now fails CLOSED with reason 'campaign_budget_not_set'. The firm
// caps keep their documented "0 disables" opt-out (migration 014 COMMENT, NOT
// NULL DEFAULT 1000/500, exposed in /settings), but a NULL read — an
// unverifiable cap, not a chosen one — now fails closed too.
//
// Run: npx tsx tests/spend-caps.test.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  checkSpendCaps,
  webhookCapGate,
  resolveCampaignBudget,
  campaignCapsConfigured,
  SPENT_STATES,
  CAP_FAILURE_REASON,
  type SpendCapsInput,
  type WebhookCapGateHooks,
} from '../src/lib/spend-caps';

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

// ── In-memory Supabase stub ─────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface Filter {
  kind: 'eq' | 'neq' | 'in' | 'or';
  col: string;
  val: unknown;
}

interface ExecResult {
  data: unknown;
  error: { message: string } | null;
}

/** Resolve 'a.b.c' against nested plain objects (PostgREST embedded filter). */
function getPath(row: Row, path: string): unknown {
  let cur: unknown = row;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Row)[part];
  }
  return cur;
}

class Query implements PromiseLike<ExecResult> {
  private filters: Filter[] = [];
  private op: 'select' | 'update' = 'select';
  private payload: Row | null = null;

  constructor(
    private tables: Tables,
    private table: string
  ) {}

  private rows(): Row[] {
    if (!this.tables[this.table]) this.tables[this.table] = [];
    return this.tables[this.table];
  }

  select(cols?: string): this {
    void cols; // projection ignored; full rows returned (like the harness store)
    return this;
  }
  update(patch: Row): this {
    this.op = 'update';
    this.payload = patch;
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push({ kind: 'eq', col, val });
    return this;
  }
  neq(col: string, val: unknown): this {
    this.filters.push({ kind: 'neq', col, val });
    return this;
  }
  in(col: string, val: unknown[]): this {
    this.filters.push({ kind: 'in', col, val });
    return this;
  }
  /** Supports the exact shape spend-caps uses:
   *  'col.gte.<value>,col.is.null' — match if ANY condition holds. */
  or(expr: string): this {
    this.filters.push({ kind: 'or', col: '', val: expr });
    return this;
  }

  private matchOr(row: Row, expr: string): boolean {
    return expr.split(',').some((cond) => {
      const firstDot = cond.indexOf('.');
      const secondDot = cond.indexOf('.', firstDot + 1);
      const col = cond.slice(0, firstDot);
      const op = cond.slice(firstDot + 1, secondDot);
      const val = cond.slice(secondDot + 1);
      const cell = getPath(row, col);
      if (op === 'is' && val === 'null') return cell == null;
      if (op === 'gte') return cell != null && String(cell) >= val;
      throw new Error(`stub or(): unsupported condition ${cond}`);
    });
  }

  private match(row: Row): boolean {
    return this.filters.every((f) => {
      if (f.kind === 'or') return this.matchOr(row, f.val as string);
      const cell = getPath(row, f.col);
      if (f.kind === 'eq') return cell === f.val;
      if (f.kind === 'neq') return cell !== f.val;
      return (f.val as unknown[]).includes(cell);
    });
  }

  private exec(): ExecResult {
    const rows = this.rows();
    if (this.op === 'update') {
      const updated: Row[] = [];
      for (const row of rows) {
        if (this.match(row)) {
          Object.assign(row, this.payload as Row);
          updated.push({ ...row });
        }
      }
      return { data: updated, error: null };
    }
    return { data: rows.filter((r) => this.match(r)).map((r) => ({ ...r })), error: null };
  }

  single(): Promise<ExecResult> {
    const { data } = this.exec();
    const arr = data as Row[];
    if (arr.length === 0) return Promise.resolve({ data: null, error: { message: 'no rows' } });
    return Promise.resolve({ data: arr[0], error: null });
  }
  maybeSingle(): Promise<ExecResult> {
    const { data } = this.exec();
    const arr = data as Row[];
    return Promise.resolve({ data: arr.length ? arr[0] : null, error: null });
  }
  then<TResult1 = ExecResult, TResult2 = never>(
    onfulfilled?: ((value: ExecResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.exec()).then(onfulfilled, onrejected);
  }
}

interface Store {
  sb: SupabaseClient;
  seed(table: string, row: Row): Row;
  get(table: string, id: string): Row | undefined;
}

function makeStore(): Store {
  const tables: Tables = {};
  const sb = {
    from(table: string) {
      return new Query(tables, table);
    },
  } as unknown as SupabaseClient;
  return {
    sb,
    seed(table, row) {
      if (!tables[table]) tables[table] = [];
      tables[table].push(row);
      return row;
    },
    get(table, id) {
      return (tables[table] ?? []).find((r) => r.id === id);
    },
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

// Fixed clock so the month window is deterministic: Sep 2026.
const NOW = new Date('2026-09-14T12:00:00.000Z');
const THIS_MONTH = '2026-09-05T00:00:00.000Z';
const LAST_MONTH = '2026-08-20T00:00:00.000Z';

const INPUT: SpendCapsInput = {
  paymentAuthorizationId: 'pa-cur',
  firmId: 'firm-1',
  campaignId: 'camp-1',
  creatorInfluencerId: 'inf-1',
  amountUsd: 100,
};

interface SeedOpts {
  totalBudget?: number | null;
  firmMonthlyCap?: number | null;
  creatorMonthlyCap?: number | null;
  currentStatus?: string;
}

/** Campaign + firm + the current (already-claimed) authorization row. */
function seedBase(store: Store, opts: SeedOpts = {}) {
  store.seed('campaigns', {
    id: 'camp-1',
    // Default is a real, generous budget: the campaign cap is no longer
    // disableable, so scenarios that exercise the firm caps need one set.
    total_budget_usd: opts.totalBudget === undefined ? 1_000_000 : opts.totalBudget,
    artist_name: 'Nova Blue',
  });
  store.seed('firms', {
    id: 'firm-1',
    monthly_spend_cap_usd: opts.firmMonthlyCap ?? 0,
    per_creator_monthly_cap_usd: opts.creatorMonthlyCap ?? 0,
    sender_name: 'Example Records Team',
  });
  // The row under check — claimed to 'executing' before the cap reads, with
  // executed_at still NULL. It sits inside SPENT_STATES + the month window on
  // purpose: the .neq(id) exclusion is what keeps it from double-counting.
  seedPa(store, {
    id: 'pa-cur',
    status: opts.currentStatus ?? 'executing',
    amount_usd: INPUT.amountUsd,
    executed_at: null,
  });
}

function seedPa(
  store: Store,
  row: {
    id: string;
    status: string;
    amount_usd: number;
    executed_at?: string | null;
    campaign_id?: string;
    firm_id?: string;
    influencer_id?: string;
  }
) {
  return store.seed('payment_authorizations', {
    id: row.id,
    firm_id: row.firm_id ?? 'firm-1',
    campaign_id: row.campaign_id ?? 'camp-1',
    amount_usd: row.amount_usd,
    status: row.status,
    executed_at: row.executed_at ?? null,
    failure_reason: null,
    creator_offers: {
      campaign_influencers: { influencer_id: row.influencer_id ?? 'inf-1' },
    },
  });
}

// ── Scenarios ───────────────────────────────────────────────────────────────

async function scenarioUnsetCampaignBudgetBlocks() {
  console.log('— CENTREPIECE: an unset campaign budget BLOCKS spend —');

  // NULL total_budget_usd — a state real campaigns can be in. Zero prior spend, so nothing is "exceeded": the refusal is
  // purely "this campaign has no enforceable ceiling".
  const nul = makeStore();
  seedBase(nul, { totalBudget: null });
  const nulRes = await checkSpendCaps(nul.sb, INPUT, { now: NOW });
  assert(
    !nulRes.ok && nulRes.cap === 'campaign',
    `NULL budget: BLOCKED (got ${JSON.stringify(nulRes)})`
  );
  if (!nulRes.ok && nulRes.cap === 'campaign') {
    assert(nulRes.detail.reason === 'campaign_budget_not_set', 'NULL budget: reason names the unset cap');
    assert(nulRes.detail.budget_configured === false, 'NULL budget: budget_configured false in audit detail');
    assert(nulRes.detail.total_budget_usd === null, 'NULL budget: detail reports null, not a fabricated 0');
    assert(nulRes.detail.spent_usd === 0, 'NULL budget: nothing was actually spent — this is not an overage');
    assert(nulRes.detail.current_usd === 100, 'NULL budget: detail.current_usd');
  }

  // 0 is the same fail-open hole (the old code did Number(null ?? 0) === 0).
  const zero = makeStore();
  seedBase(zero, { totalBudget: 0 });
  const zeroRes = await checkSpendCaps(zero.sb, INPUT, { now: NOW });
  assert(!zeroRes.ok && zeroRes.cap === 'campaign', 'zero budget: BLOCKED');
  if (!zeroRes.ok && zeroRes.cap === 'campaign') {
    assert(zeroRes.detail.reason === 'campaign_budget_not_set', 'zero budget: reason names the unset cap');
  }

  // A $1M prior spend against an unset budget is the disaster case the old
  // `totalBudget > 0 &&` guard waved straight through.
  const rich = makeStore();
  seedBase(rich, { totalBudget: null });
  seedPa(rich, { id: 'pa-old', status: 'completed', amount_usd: 1_000_000, executed_at: THIS_MONTH });
  const richRes = await checkSpendCaps(rich.sb, INPUT, { now: NOW });
  assert(!richRes.ok && richRes.cap === 'campaign', 'unset budget + $1M prior spend: still BLOCKED');

  // Garbage values must not resolve to "unlimited" either.
  for (const bad of [-1, Number.NaN, 'not-a-number']) {
    const bs = makeStore();
    bs.seed('campaigns', { id: 'camp-1', total_budget_usd: bad, artist_name: 'Nova Blue' });
    bs.seed('firms', { id: 'firm-1', monthly_spend_cap_usd: 0, per_creator_monthly_cap_usd: 0, sender_name: 'Example Records Team' });
    seedPa(bs, { id: 'pa-cur', status: 'executing', amount_usd: 100, executed_at: null });
    const r = await checkSpendCaps(bs.sb, INPUT, { now: NOW });
    assert(!r.ok && r.cap === 'campaign', `budget ${String(bad)}: BLOCKED, not treated as unlimited`);
  }

  // The pure resolver the confirm route and the cap check share.
  assert(resolveCampaignBudget(null).ok === false, 'resolveCampaignBudget: null → not configured');
  assert(resolveCampaignBudget(undefined).ok === false, 'resolveCampaignBudget: undefined → not configured');
  assert(resolveCampaignBudget(0).ok === false, 'resolveCampaignBudget: 0 → not configured');
  assert(resolveCampaignBudget(-5).ok === false, 'resolveCampaignBudget: negative → not configured');
  assert(resolveCampaignBudget('abc').ok === false, 'resolveCampaignBudget: non-numeric → not configured');
  const good = resolveCampaignBudget('5600.00');
  assert(
    good.ok === true && good.totalBudgetUsd === 5600,
    'resolveCampaignBudget: numeric string from PostgREST parses'
  );
  assert(
    campaignCapsConfigured({ total_budget_usd: 5600, per_creator_cap_usd: 500 }).ok === true,
    'campaignCapsConfigured: both caps positive → ok'
  );
  const missingCap = campaignCapsConfigured({ total_budget_usd: 5600, per_creator_cap_usd: null });
  assert(
    missingCap.ok === false && missingCap.missing.includes('per_creator_cap_usd'),
    'campaignCapsConfigured: NULL per-creator cap is named as missing'
  );
  const missingBoth = campaignCapsConfigured({ total_budget_usd: null, per_creator_cap_usd: 0 });
  assert(
    missingBoth.ok === false && missingBoth.missing.length === 2,
    'campaignCapsConfigured: both missing → both named'
  );
}

async function scenarioFirmCapOptOutStillWorks() {
  console.log('— firm caps: explicit 0 still disables, NULL fails closed —');

  // firms.monthly_spend_cap_usd / per_creator_monthly_cap_usd are NOT NULL
  // DEFAULT 1000/500 and documented "0 disables" (migration 014). A typed 0 is
  // an affirmative opt-out and stays honoured — but the CAMPAIGN cap is no
  // longer disableable, so a payout is never left with zero enforceable
  // ceiling. That is the structural guarantee this pair of assertions pins.
  const optOut = makeStore();
  seedBase(optOut, { totalBudget: 1000, firmMonthlyCap: 0, creatorMonthlyCap: 0 });
  seedPa(optOut, { id: 'pa-old', status: 'completed', amount_usd: 500, executed_at: THIS_MONTH });
  const optOutRes = await checkSpendCaps(optOut.sb, INPUT, { now: NOW });
  assert(optOutRes.ok === true, 'firm caps 0: opt-out honoured, campaign cap still governs');
  if (optOutRes.ok) {
    assert(optOutRes.artistName === 'Nova Blue', 'firm caps 0: artist name surfaced for payout copy');
    assert(optOutRes.senderName === 'Example Records Team', 'firm caps 0: sender name surfaced for payout copy');
  }

  // …but the campaign cap underneath it is NOT disableable any more.
  const noCeiling = makeStore();
  seedBase(noCeiling, { totalBudget: null, firmMonthlyCap: 0, creatorMonthlyCap: 0 });
  const noCeilingRes = await checkSpendCaps(noCeiling.sb, INPUT, { now: NOW });
  assert(
    !noCeilingRes.ok,
    'every firm cap opted out + unset campaign budget: BLOCKED — no payout with zero enforceable ceiling'
  );

  // NULL firm cap = unverifiable, not opted out → fail closed.
  const nullFirm = makeStore();
  nullFirm.seed('campaigns', { id: 'camp-1', total_budget_usd: 1000, artist_name: 'Nova Blue' });
  nullFirm.seed('firms', {
    id: 'firm-1',
    monthly_spend_cap_usd: null,
    per_creator_monthly_cap_usd: 500,
    sender_name: null,
  });
  seedPa(nullFirm, { id: 'pa-cur', status: 'executing', amount_usd: 100, executed_at: null });
  const nullFirmRes = await checkSpendCaps(nullFirm.sb, INPUT, { now: NOW });
  assert(
    !nullFirmRes.ok &&
      nullFirmRes.cap === 'lookup_failed' &&
      nullFirmRes.detail.error === 'firm_monthly_cap_not_set',
    `NULL firm monthly cap: fails closed (got ${JSON.stringify(nullFirmRes)})`
  );

  const nullCreator = makeStore();
  nullCreator.seed('campaigns', { id: 'camp-1', total_budget_usd: 1000, artist_name: 'Nova Blue' });
  nullCreator.seed('firms', {
    id: 'firm-1',
    monthly_spend_cap_usd: 1000,
    per_creator_monthly_cap_usd: null,
    sender_name: null,
  });
  seedPa(nullCreator, { id: 'pa-cur', status: 'executing', amount_usd: 100, executed_at: null });
  const nullCreatorRes = await checkSpendCaps(nullCreator.sb, INPUT, { now: NOW });
  assert(
    !nullCreatorRes.ok &&
      nullCreatorRes.cap === 'lookup_failed' &&
      nullCreatorRes.detail.error === 'creator_monthly_cap_not_set',
    `NULL per-creator monthly cap: fails closed (got ${JSON.stringify(nullCreatorRes)})`
  );

  // Name fallbacks still work on the happy path with a configured budget.
  const names = makeStore();
  names.seed('campaigns', { id: 'camp-1', total_budget_usd: 1000, artist_name: null });
  names.seed('firms', {
    id: 'firm-1',
    monthly_spend_cap_usd: 0,
    per_creator_monthly_cap_usd: 0,
    sender_name: null,
  });
  seedPa(names, { id: 'pa-cur', status: 'executing', amount_usd: 100, executed_at: null });
  const namesRes = await checkSpendCaps(names.sb, INPUT, { now: NOW });
  assert(namesRes.ok === true, 'name fallbacks: configured budget passes');
  if (namesRes.ok) {
    assert(namesRes.artistName === 'the artist', 'NULL artist_name → "the artist" fallback');
    assert(namesRes.senderName === 'your campaign team', 'NULL sender_name → "your campaign team" fallback');
  }
}

async function scenarioCampaignCap() {
  console.log('— campaign total budget —');
  // Boundary: 900 spent + 100 current == 1000 budget → passes (strict >).
  const at = makeStore();
  seedBase(at, { totalBudget: 1000 });
  seedPa(at, { id: 'pa-1', status: 'completed', amount_usd: 900, executed_at: THIS_MONTH });
  const atRes = await checkSpendCaps(at.sb, INPUT, { now: NOW });
  assert(atRes.ok === true, 'campaign: landing exactly on the budget passes');

  // One cent over → breach.
  const over = makeStore();
  seedBase(over, { totalBudget: 1000 });
  seedPa(over, { id: 'pa-1', status: 'completed', amount_usd: 900.01, executed_at: THIS_MONTH });
  const overRes = await checkSpendCaps(over.sb, INPUT, { now: NOW });
  assert(!overRes.ok && overRes.cap === 'campaign', 'campaign: one cent over trips the cap');
  if (!overRes.ok && overRes.cap === 'campaign') {
    assert(overRes.detail.spent_usd === 900.01, `campaign: detail.spent_usd (got ${overRes.detail.spent_usd})`);
    assert(overRes.detail.current_usd === 100, 'campaign: detail.current_usd');
    assert(overRes.detail.total_budget_usd === 1000, 'campaign: detail.total_budget_usd');
    assert(
      CAP_FAILURE_REASON[overRes.cap] === 'campaign_total_budget_exceeded',
      'campaign: failure reason string matches the historical route response'
    );
  }

  // The current (claimed) row must NOT count against its own budget.
  const self = makeStore();
  seedBase(self, { totalBudget: 100 });
  const selfRes = await checkSpendCaps(self.sb, INPUT, { now: NOW });
  assert(selfRes.ok === true, 'campaign: the claimed row itself is excluded via .neq(id)');

  // Spend in another campaign doesn't count against this one.
  const other = makeStore();
  seedBase(other, { totalBudget: 1000 });
  seedPa(other, { id: 'pa-1', status: 'completed', amount_usd: 5000, executed_at: THIS_MONTH, campaign_id: 'camp-2' });
  const otherRes = await checkSpendCaps(other.sb, INPUT, { now: NOW });
  assert(otherRes.ok === true, 'campaign: other-campaign spend not counted');

  // Non-spent statuses don't count.
  const idle = makeStore();
  seedBase(idle, { totalBudget: 1000 });
  for (const [i, status] of ['failed', 'approved', 'pending_human_review', 'rejected'].entries()) {
    seedPa(idle, { id: `pa-${status}-${i}`, status, amount_usd: 10_000 });
  }
  const idleRes = await checkSpendCaps(idle.sb, INPUT, { now: NOW });
  assert(idleRes.ok === true, 'campaign: failed/approved/pending/rejected rows are not spend');
  assert(
    SPENT_STATES.includes('executing') && SPENT_STATES.includes('completed'),
    'SPENT_STATES still counts executing + completed'
  );
}

async function scenarioFirmMonthlyCap() {
  console.log('— firm monthly cap —');
  // In-flight executing row (executed_at NULL) MUST count as month spend.
  const inflight = makeStore();
  seedBase(inflight, { firmMonthlyCap: 500 });
  seedPa(inflight, {
    id: 'pa-inflight',
    status: 'executing',
    amount_usd: 450,
    executed_at: null,
    campaign_id: 'camp-2', // different campaign, same firm — still counts
  });
  const inflightRes = await checkSpendCaps(inflight.sb, INPUT, { now: NOW });
  assert(
    !inflightRes.ok && inflightRes.cap === 'firm_monthly',
    `firm_monthly: executing row with NULL executed_at counted (got ${JSON.stringify(inflightRes)})`
  );
  if (!inflightRes.ok && inflightRes.cap === 'firm_monthly') {
    assert(inflightRes.detail.spent_usd === 450, 'firm_monthly: detail.spent_usd includes the in-flight row');
    assert(inflightRes.detail.monthly_cap_usd === 500, 'firm_monthly: detail.monthly_cap_usd');
    assert(inflightRes.detail.period === '2026-09', `firm_monthly: period YYYY-MM (got ${inflightRes.detail.period})`);
  }

  // Boundary: 450 + 50 == 500 → passes.
  const at = makeStore();
  seedBase(at, { firmMonthlyCap: 500 });
  seedPa(at, { id: 'pa-inflight', status: 'executing', amount_usd: 450, executed_at: null, campaign_id: 'camp-2' });
  const atRes = await checkSpendCaps(at.sb, { ...INPUT, amountUsd: 50 }, { now: NOW });
  assert(atRes.ok === true, 'firm_monthly: landing exactly on the cap passes');

  // Last month's settled spend is outside the window.
  const lastMonth = makeStore();
  seedBase(lastMonth, { firmMonthlyCap: 500 });
  seedPa(lastMonth, { id: 'pa-aug', status: 'completed', amount_usd: 450, executed_at: LAST_MONTH, campaign_id: 'camp-2' });
  const lastMonthRes = await checkSpendCaps(lastMonth.sb, INPUT, { now: NOW });
  assert(lastMonthRes.ok === true, 'firm_monthly: last-month spend excluded from the window');

  // Same row executed this month → counted.
  const thisMonth = makeStore();
  seedBase(thisMonth, { firmMonthlyCap: 500 });
  seedPa(thisMonth, { id: 'pa-sep', status: 'completed', amount_usd: 450, executed_at: THIS_MONTH, campaign_id: 'camp-2' });
  const thisMonthRes = await checkSpendCaps(thisMonth.sb, INPUT, { now: NOW });
  assert(!thisMonthRes.ok && thisMonthRes.cap === 'firm_monthly', 'firm_monthly: this-month spend counted');
}

async function scenarioCreatorMonthlyCap() {
  console.log('— per-creator monthly cap —');
  const store = makeStore();
  seedBase(store, { creatorMonthlyCap: 300 });
  seedPa(store, { id: 'pa-same', status: 'completed', amount_usd: 250, executed_at: THIS_MONTH, influencer_id: 'inf-1' });
  seedPa(store, { id: 'pa-otherinf', status: 'completed', amount_usd: 5000, executed_at: THIS_MONTH, influencer_id: 'inf-2' });

  const res = await checkSpendCaps(store.sb, INPUT, { now: NOW });
  assert(!res.ok && res.cap === 'creator_monthly', 'creator_monthly: same-influencer spend trips the cap');
  if (!res.ok && res.cap === 'creator_monthly') {
    assert(res.detail.spent_usd === 250, 'creator_monthly: other influencers excluded from spent_usd');
    assert(res.detail.monthly_cap_usd === 300, 'creator_monthly: detail.monthly_cap_usd');
    assert(res.detail.period === '2026-09', 'creator_monthly: period YYYY-MM');
  }

  // Boundary: 250 + 50 == 300 → passes.
  const atRes = await checkSpendCaps(store.sb, { ...INPUT, amountUsd: 50 }, { now: NOW });
  assert(atRes.ok === true, 'creator_monthly: landing exactly on the cap passes');

  // No influencer id → the per-creator check is skipped (route semantics).
  const nullRes = await checkSpendCaps(store.sb, { ...INPUT, creatorInfluencerId: null }, { now: NOW });
  assert(nullRes.ok === true, 'creator_monthly: skipped when creatorInfluencerId is null');
}

async function scenarioOrderingAndLookups() {
  console.log('— check ordering + lookup failures fail closed —');
  // Campaign breach is reported first even when the firm cap would also trip.
  const both = makeStore();
  seedBase(both, { totalBudget: 100, firmMonthlyCap: 100 });
  seedPa(both, { id: 'pa-1', status: 'completed', amount_usd: 100, executed_at: THIS_MONTH });
  const bothRes = await checkSpendCaps(both.sb, INPUT, { now: NOW });
  assert(!bothRes.ok && bothRes.cap === 'campaign', 'ordering: campaign checked before firm_monthly');

  const noCamp = makeStore();
  noCamp.seed('firms', { id: 'firm-1', monthly_spend_cap_usd: 0, per_creator_monthly_cap_usd: 0, sender_name: null });
  const noCampRes = await checkSpendCaps(noCamp.sb, INPUT, { now: NOW });
  assert(
    !noCampRes.ok && noCampRes.cap === 'lookup_failed' && noCampRes.detail.error === 'campaign_not_found' && noCampRes.detail.status === 404,
    'lookup: missing campaign → campaign_not_found / 404'
  );

  const noFirm = makeStore();
  // Budget must be SET for the check to reach the firm lookup at all — an
  // unset budget now short-circuits at the campaign cap.
  noFirm.seed('campaigns', { id: 'camp-1', total_budget_usd: 1000, artist_name: 'X' });
  const noFirmRes = await checkSpendCaps(noFirm.sb, INPUT, { now: NOW });
  assert(
    !noFirmRes.ok && noFirmRes.cap === 'lookup_failed' && noFirmRes.detail.error === 'firm_not_found' && noFirmRes.detail.status === 404,
    'lookup: missing firm → firm_not_found / 404'
  );
}

// ── Webhook-shaped harness ──────────────────────────────────────────────────
// Mirrors exactly what the account.updated handler does per row: atomic
// approved → executing claim, then the cap gate, then transfer ONLY if
// allowed. Proves a breach refuses the transfer and reverts the row.

interface HookSpies {
  hooks: WebhookCapGateHooks;
  auditCalls: Array<{ action: string; metadata?: Record<string, unknown> }>;
  alertCalls: Array<{ key: string; message: string }>;
}

function makeHookSpies(): HookSpies {
  const auditCalls: HookSpies['auditCalls'] = [];
  const alertCalls: HookSpies['alertCalls'] = [];
  return {
    auditCalls,
    alertCalls,
    hooks: {
      audit: async (entry) => {
        auditCalls.push({ action: entry.action, metadata: entry.metadata });
      },
      alertOnce: (key, _level, message) => {
        alertCalls.push({ key, message });
      },
    },
  };
}

async function webhookHarness(store: Store, input: SpendCapsInput, hooks: WebhookCapGateHooks) {
  let transferAttempted = false;
  // Atomic claim, verbatim from the webhook handler.
  const { data: claimed } = await store.sb
    .from('payment_authorizations')
    .update({ status: 'executing' } as never)
    .eq('id', input.paymentAuthorizationId)
    .eq('status', 'approved')
    .select('id')
    .maybeSingle();
  if (!claimed) return { claimed: false, transferAttempted };

  const gate = await webhookCapGate(store.sb, input, hooks, { now: NOW });
  if (gate.allowed) {
    transferAttempted = true; // stands in for executePayout(...)
  }
  return { claimed: true, transferAttempted, gate };
}

async function scenarioWebhookBreachRefusesTransfer() {
  console.log('— webhook gate: breach refuses transfer + reverts to approved —');
  const store = makeStore();
  seedBase(store, { totalBudget: 1000, currentStatus: 'approved' });
  seedPa(store, { id: 'pa-1', status: 'completed', amount_usd: 950, executed_at: THIS_MONTH });
  const spies = makeHookSpies();

  const out = await webhookHarness(store, INPUT, spies.hooks);
  assert(out.claimed === true, 'webhook breach: claim succeeded from approved');
  assert(out.transferAttempted === false, 'webhook breach: NO transfer attempted');
  assert(out.gate !== undefined && !out.gate.allowed && out.gate.cap === 'campaign', 'webhook breach: gate names the cap');

  const row = store.get('payment_authorizations', 'pa-cur');
  assert(row?.status === 'approved', `webhook breach: row reverted to approved (got ${row?.status})`);
  assert(row?.failure_reason === 'cap:campaign', `webhook breach: failure_reason cap:campaign (got ${row?.failure_reason})`);
  assert(
    spies.auditCalls.length === 1 && spies.auditCalls[0].action === 'payment.webhook_cap_refused',
    'webhook breach: audited payment.webhook_cap_refused'
  );
  assert(spies.auditCalls[0]?.metadata?.cap === 'campaign', 'webhook breach: audit metadata names the cap');
  assert(spies.alertCalls.length === 1, 'webhook breach: alertOnce fired exactly once');

  // The refusal is retryable: room frees up → the same flow now pays out.
  const retryStore = makeStore();
  seedBase(retryStore, { totalBudget: 1000, currentStatus: 'approved' });
  seedPa(retryStore, { id: 'pa-1', status: 'completed', amount_usd: 900, executed_at: THIS_MONTH });
  const retrySpies = makeHookSpies();
  const retry = await webhookHarness(retryStore, INPUT, retrySpies.hooks);
  assert(retry.transferAttempted === true, 'webhook retry: transfer proceeds once there is room');
  assert(retryStore.get('payment_authorizations', 'pa-cur')?.status === 'executing', 'webhook retry: row stays executing for the transfer');
  assert(retrySpies.auditCalls.length === 0 && retrySpies.alertCalls.length === 0, 'webhook retry: no refusal side effects on the happy path');
}

async function scenarioWebhookLookupFailureFailsClosed() {
  console.log('— webhook gate: unverifiable caps fail closed —');
  const store = makeStore();
  // Campaign exists (with a real budget) but the firm row is missing → the
  // remaining caps can't be verified.
  store.seed('campaigns', { id: 'camp-1', total_budget_usd: 1000, artist_name: 'X' });
  seedPa(store, { id: 'pa-cur', status: 'approved', amount_usd: 100 });
  const spies = makeHookSpies();

  const out = await webhookHarness(store, INPUT, spies.hooks);
  assert(out.transferAttempted === false, 'webhook lookup-fail: NO transfer when caps are unverifiable');
  const row = store.get('payment_authorizations', 'pa-cur');
  assert(row?.status === 'approved', 'webhook lookup-fail: row reverted to approved');
  assert(
    row?.failure_reason === 'cap_check_failed:firm_not_found',
    `webhook lookup-fail: failure_reason records the cause (got ${row?.failure_reason})`
  );
  assert(spies.auditCalls[0]?.action === 'payment.webhook_cap_refused', 'webhook lookup-fail: refusal audited');
}

async function scenarioWebhookUnsetBudgetRefusesTransfer() {
  console.log('— webhook gate: unset campaign budget refuses the transfer —');
  // The Stripe account.updated path is the one that moves money with no human
  // in the loop at that instant. An unset campaign budget must stop it dead.
  const store = makeStore();
  seedBase(store, { totalBudget: null, currentStatus: 'approved' });
  const spies = makeHookSpies();

  const out = await webhookHarness(store, INPUT, spies.hooks);
  assert(out.claimed === true, 'webhook unset budget: claim succeeded from approved');
  assert(out.transferAttempted === false, 'webhook unset budget: NO transfer attempted');
  assert(
    out.gate !== undefined && !out.gate.allowed && out.gate.cap === 'campaign',
    'webhook unset budget: gate names the campaign cap'
  );

  const row = store.get('payment_authorizations', 'pa-cur');
  // 'approved', not 'failed': a human already approved this payout, and it
  // becomes payable the moment someone sets a budget. Retryable by design.
  assert(row?.status === 'approved', `webhook unset budget: row reverted to approved (got ${row?.status})`);
  assert(row?.failure_reason === 'cap:campaign', `webhook unset budget: failure_reason (got ${row?.failure_reason})`);
  assert(
    spies.auditCalls.length === 1 && spies.auditCalls[0].action === 'payment.webhook_cap_refused',
    'webhook unset budget: refusal audited'
  );
  assert(
    spies.auditCalls[0]?.metadata?.reason === 'campaign_budget_not_set',
    'webhook unset budget: audit metadata carries the real reason, not a fake overage'
  );
  assert(
    spies.auditCalls[0]?.metadata?.budget_configured === false,
    'webhook unset budget: audit metadata flags the missing config'
  );
  assert(spies.alertCalls.length === 1, 'webhook unset budget: alertOnce fired exactly once');

  // Setting a budget makes the same authorization payable — proof the refusal
  // is a gate, not a dead end.
  const fixed = makeStore();
  seedBase(fixed, { totalBudget: 1000, currentStatus: 'approved' });
  const fixedSpies = makeHookSpies();
  const fixedOut = await webhookHarness(fixed, INPUT, fixedSpies.hooks);
  assert(fixedOut.transferAttempted === true, 'webhook unset budget: transfer proceeds once a budget is set');
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  await scenarioUnsetCampaignBudgetBlocks();
  await scenarioFirmCapOptOutStillWorks();
  await scenarioCampaignCap();
  await scenarioFirmMonthlyCap();
  await scenarioCreatorMonthlyCap();
  await scenarioOrderingAndLookups();
  await scenarioWebhookBreachRefusesTransfer();
  await scenarioWebhookLookupFailureFailsClosed();
  await scenarioWebhookUnsetBudgetRefusesTransfer();

  console.log(`\nspend-caps test: ${passed}/${passed + failed} assertions pass`);
  if (failed > 0) {
    console.error(`\n${failed} FAILURES:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('spend-caps test crashed:', e);
  process.exit(1);
});
