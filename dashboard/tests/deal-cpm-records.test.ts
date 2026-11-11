// tests/deal-cpm-records.test.ts
//
// CPM slice S4 (data capture): deal_cpm_records, written by the measurement
// tick after each performance snapshot (src/lib/deal-cpm-records.ts).
//
// Pinned:
//   - the 7-day reading is taken once, at the first snapshot ≥7 days after the
//     post, and never rewritten; latest is refreshed on every later snapshot;
//   - CPM is NULL when views are unknown (image post), zero, or the agreed
//     amount is missing — never invented, and a null 7-day reading is never
//     back-filled from a later month;
//   - synthetic ([SAMPLE]) campaigns never produce a record;
//   - pre-062 the tick runs exactly as before, minus the record;
//   - pricing_method is 'formula' for every deal until a CPM price is applied;
//   - migration 062 is additive, firm-scoped like 056, and says it is not applied.
//
// Hermetic: in-memory Supabase double, injected scrape/ledger/audit, no network.
// Run: npx tsx tests/deal-cpm-records.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeDealCpmRecord } from '../src/lib/deal-cpm-records';
import { runMeasurementTick } from '../src/lib/measurement-tick';

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

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-14T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

// ── A small PostgREST double: the call shapes the tick + writer use ─────────
type Row = Record<string, unknown>;
type Filter = { kind: 'eq' | 'in' | 'notnull' | 'notin' | 'isnull'; col: string; val?: unknown };
let seq = 0;

class Q implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Filter[] = [];
  private op: 'select' | 'insert' | 'update' | 'upsert' = 'select';
  private payload: Row | Row[] | null = null;
  private conflict: string[] = [];
  private orderBy?: { col: string; asc: boolean };
  private limitN?: number;
  constructor(
    private db: Db,
    private table: string,
  ) {}
  private rows(): Row[] {
    return (this.db.tables[this.table] ??= []);
  }
  select() {
    return this;
  }
  insert(p: Row | Row[]) {
    this.op = 'insert';
    this.payload = p;
    return this;
  }
  update(p: Row) {
    this.op = 'update';
    this.payload = p;
    return this;
  }
  upsert(p: Row | Row[], o?: { onConflict?: string }) {
    this.op = 'upsert';
    this.payload = p;
    this.conflict = (o?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ kind: 'eq', col, val });
    return this;
  }
  in(col: string, val: unknown[]) {
    this.filters.push({ kind: 'in', col, val });
    return this;
  }
  is(col: string, val: unknown) {
    if (val === null) this.filters.push({ kind: 'isnull', col });
    return this;
  }
  not(col: string, op: string, val: unknown) {
    if (op === 'is' && val === null) this.filters.push({ kind: 'notnull', col });
    if (op === 'in' && typeof val === 'string') {
      this.filters.push({ kind: 'notin', col, val: val.replace(/^\(|\)$/g, '').split(',').filter(Boolean) });
    }
    return this;
  }
  order(col: string, o?: { ascending?: boolean }) {
    this.orderBy = { col, asc: o?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  private match(r: Row) {
    return this.filters.every((f) => {
      if (f.kind === 'eq') return r[f.col] === f.val;
      if (f.kind === 'in') return (f.val as unknown[]).includes(r[f.col]);
      if (f.kind === 'notnull') return r[f.col] != null;
      if (f.kind === 'isnull') return r[f.col] == null;
      return !(f.val as unknown[]).includes(r[f.col]);
    });
  }
  private exec(): { data: unknown; error: unknown } {
    const refusal = this.db.refuse?.(this.table, this.op, this.payload);
    if (refusal) return { data: null, error: refusal };
    const rows = this.rows();
    if (this.op === 'insert' || this.op === 'upsert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const out: Row[] = [];
      for (const p of list) {
        const hit = this.op === 'upsert' && this.conflict.length ? rows.find((r) => this.conflict.every((c) => r[c] === p[c])) : undefined;
        if (hit) {
          Object.assign(hit, p);
          out.push({ ...hit });
        } else {
          const row = { id: `${this.table}-${++seq}`, ...p };
          rows.push(row);
          out.push({ ...row });
        }
      }
      return { data: out, error: null };
    }
    if (this.op === 'update') {
      const out: Row[] = [];
      for (const r of rows) if (this.match(r)) {
        Object.assign(r, this.payload as Row);
        out.push({ ...r });
      }
      return { data: out, error: null };
    }
    let sel = rows.filter((r) => this.match(r)).map((r) => ({ ...r }));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      sel = sel.sort((a, b) => ((a[col] as string) < (b[col] as string) ? -1 : (a[col] as string) > (b[col] as string) ? 1 : 0) * (asc ? 1 : -1));
    }
    if (this.limitN != null) sel = sel.slice(0, this.limitN);
    return { data: sel, error: null };
  }
  maybeSingle() {
    const r = this.exec();
    if (r.error) return Promise.resolve(r);
    const arr = r.data as Row[];
    return Promise.resolve({ data: arr[0] ?? null, error: null });
  }
  single() {
    const r = this.exec();
    if (r.error) return Promise.resolve(r);
    const arr = r.data as Row[];
    return Promise.resolve(arr[0] ? { data: arr[0], error: null } : { data: null, error: { message: 'no rows' } });
  }
  then<A = { data: unknown; error: unknown }, B = never>(
    ok?: ((v: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return Promise.resolve(this.exec()).then(ok, bad);
  }
}

interface Db {
  tables: Record<string, Row[]>;
  refuse?: (table: string, op: string, payload: unknown) => { code: string; message: string } | null;
}

function makeDb(opts: { pre062?: boolean } = {}) {
  const db: Db = { tables: {} };
  if (opts.pre062) {
    db.refuse = (table) =>
      table === 'deal_cpm_records' ? { code: 'PGRST205', message: "Could not find the table 'public.deal_cpm_records' in the schema cache" } : null;
  }
  const sb = { from: (t: string) => new Q(db, t) } as unknown as SupabaseClient;
  return {
    db,
    sb,
    seed(t: string, r: Row) {
      (db.tables[t] ??= []).push(r);
      return r;
    },
    all(t: string) {
      return db.tables[t] ?? [];
    },
  };
}

type Store = ReturnType<typeof makeDb>;

function seedDeal(store: Store, opts: { id?: string; campaign?: string; agreed?: number | null; basis?: unknown; postedDaysAgo?: number } = {}) {
  const id = opts.id ?? 'offer-1';
  const camp = opts.campaign ?? 'camp-1';
  if (!store.all('campaigns').some((c) => c.id === camp)) {
    store.seed('campaigns', { id: camp, firm_id: 'firm-1', synthetic: camp.startsWith('sample'), created_at: iso(NOW - 30 * DAY), release_date: null });
  }
  store.seed('outreach_messages', { id: `msg-${id}`, channel: 'instagram_dm' });
  store.seed('creator_offers', {
    id,
    firm_id: 'firm-1',
    campaign_id: camp,
    campaign_influencer_id: `ci-${id}`,
    status: 'paid',
    agreed_amount_usd: opts.agreed === undefined ? 150 : opts.agreed,
    last_message_id: `msg-${id}`,
    post_url: `https://www.tiktok.com/@creator/video/${id}`,
    posted_at: iso(NOW - (opts.postedDaysAgo ?? 8) * DAY),
    agreed_deliverables: null,
    ...(opts.basis !== undefined ? { pricing_basis: opts.basis } : {}),
  });
  store.seed('campaign_influencers', { id: `ci-${id}`, influencer_id: 'inf-1' });
  if (!store.all('influencers').length) store.seed('influencers', { id: 'inf-1', username: 'creator' });
}

const write = (store: Store, over: Partial<Parameters<typeof writeDealCpmRecord>[1]> = {}) =>
  writeDealCpmRecord(store.sb, {
    offer_id: 'offer-1',
    firm_id: 'firm-1',
    campaign_id: 'camp-1',
    platform: 'tiktok',
    views: 20_000,
    posted_at_ms: NOW - 8 * DAY,
    now_ms: NOW,
    ...over,
  });

async function writerUnit() {
  // 7-day capture, then latest only.
  {
    const store = makeDb();
    seedDeal(store, { basis: { method: 'cpm', views: 18_000, applied: false } });
    assert((await write(store)) === 'created', 'first ≥7d snapshot creates the record');
    const r = store.all('deal_cpm_records')[0] ?? {};
    assert(r.views_7d === 20_000 && r.cpm_7d === 7.5, `7-day reading: 20000 views, $150 → CPM 7.5 (got ${r.views_7d}/${r.cpm_7d})`);
    assert(r.views_latest === 20_000 && r.cpm_latest === 7.5, 'latest starts equal to the 7-day reading');
    assert(r.expected_views === 18_000, 'expected_views comes from pricing_basis');
    assert(r.channel === 'instagram_dm' && r.platform === 'tiktok', `channel from the deal's last outbound, platform as measured (got ${r.channel}/${r.platform})`);
    assert(r.pricing_method === 'formula', 'a shadow basis (applied=false) records pricing_method formula');
    assert(r.agreed_usd === 150 && r.firm_id === 'firm-1' && r.campaign_id === 'camp-1', 'agreed, firm and campaign recorded');

    assert((await write(store, { views: 50_000, now_ms: NOW + 30 * DAY })) === 'updated', 'a later snapshot updates');
    const r2 = store.all('deal_cpm_records')[0] ?? {};
    assert(r2.views_7d === 20_000 && r2.cpm_7d === 7.5, '7-day reading is never rewritten');
    assert(r2.views_latest === 50_000 && r2.cpm_latest === 3, `latest refreshed (got ${r2.views_latest}/${r2.cpm_latest})`);
    assert(store.all('deal_cpm_records').length === 1, 'one row per deal');
  }
  // Image post: null views → null CPM, and no later back-fill of the 7-day reading.
  {
    const store = makeDb();
    seedDeal(store);
    await write(store, { views: null });
    const r = store.all('deal_cpm_records')[0] ?? {};
    assert(r.views_7d === null && r.cpm_7d === null && r.cpm_latest === null, 'null views → null CPM, never invented');
    await write(store, { views: 9_000, now_ms: NOW + 30 * DAY });
    const r2 = store.all('deal_cpm_records')[0] ?? {};
    assert(r2.views_7d === null && r2.cpm_7d === null, 'a null 7-day reading is not back-filled from a later month');
    assert(r2.views_latest === 9_000, 'latest still refreshes');
  }
  // Zero views / missing agreed amount → null CPM.
  {
    const store = makeDb();
    seedDeal(store);
    await write(store, { views: 0 });
    assert(store.all('deal_cpm_records')[0]?.cpm_7d === null, 'zero views → null CPM (no divide by zero)');
    const s2 = makeDb();
    seedDeal(s2, { agreed: null });
    await write(s2);
    const r = s2.all('deal_cpm_records')[0] ?? {};
    assert(r.cpm_7d === null && r.agreed_usd === null && r.views_7d === 20_000, 'no agreed amount → null CPM, views still kept');
  }
  // Too young → nothing.
  {
    const store = makeDb();
    seedDeal(store);
    assert((await write(store, { posted_at_ms: NOW - 3 * DAY })) === 'skipped', 'a post under 7 days old creates nothing');
    assert((await write(store, { posted_at_ms: null })) === 'skipped', 'unknown post time creates nothing');
    assert(store.all('deal_cpm_records').length === 0, '…and nothing was written');
  }
  // Regression: when 062 is applied, deals measured long ago get
  // their first record at today's views. views_7d comes only from a snapshot
  // taken ≤ 8 days after the post (this one, or the latest earlier one);
  // otherwise it stays null and only latest is filled.
  {
    const store = makeDb();
    seedDeal(store, { postedDaysAgo: 30 });
    assert((await write(store, { posted_at_ms: NOW - 30 * DAY, views: 90_000, deal_delivery_id: 'del-1' })) === 'created', 'old deal: first record created');
    const r = store.all('deal_cpm_records')[0] ?? {};
    assert(r.views_7d === null && r.cpm_7d === null, `old deal, no early snapshot: views_7d stays null (got ${r.views_7d}/${r.cpm_7d})`);
    assert(r.views_latest === 90_000 && r.cpm_latest === 1.67, `old deal: latest is today's reading (got ${r.views_latest}/${r.cpm_latest})`);
  }
  {
    const store = makeDb();
    seedDeal(store, { postedDaysAgo: 30 });
    const posted = NOW - 30 * DAY;
    store.seed('deal_performance_snapshots', { deal_delivery_id: 'del-1', views: 9_000, captured_at: iso(posted + 5 * DAY) });
    store.seed('deal_performance_snapshots', { deal_delivery_id: 'del-1', views: 12_000, captured_at: iso(posted + 7.5 * DAY) });
    store.seed('deal_performance_snapshots', { deal_delivery_id: 'del-1', views: 30_000, captured_at: iso(posted + 8.5 * DAY) });
    store.seed('deal_performance_snapshots', { deal_delivery_id: 'del-other', views: 1, captured_at: iso(posted + 7.9 * DAY) });
    store.seed('deal_performance_snapshots', { deal_delivery_id: 'del-1', views: 90_000, captured_at: iso(NOW) });
    await write(store, { posted_at_ms: posted, views: 90_000, deal_delivery_id: 'del-1' });
    const r = store.all('deal_cpm_records')[0] ?? {};
    assert(r.views_7d === 12_000 && r.cpm_7d === 12.5, `old deal: views_7d from the day-7.5 snapshot, not day 8.5 or today (got ${r.views_7d}/${r.cpm_7d})`);
    assert(r.views_latest === 90_000, 'old deal: latest is still today');
  }
  {
    const store = makeDb();
    seedDeal(store, { postedDaysAgo: 30 });
    const posted = NOW - 30 * DAY;
    store.seed('deal_performance_snapshots', { deal_delivery_id: 'del-1', views: 9_000, captured_at: iso(posted + 5 * DAY) });
    await write(store, { posted_at_ms: posted, views: 90_000, deal_delivery_id: 'del-1' });
    assert(store.all('deal_cpm_records')[0]?.views_7d === 9_000, 'old deal: with nothing in 7–8 days, the nearest snapshot ≤ day 8 is used');
  }
  {
    // This snapshot itself just past day 8, no history: null.
    const store = makeDb();
    seedDeal(store);
    await write(store, { posted_at_ms: NOW - 8.5 * DAY, deal_delivery_id: 'del-1' });
    assert(store.all('deal_cpm_records')[0]?.views_7d === null, 'a first snapshot at day 8.5 is not a 7-day reading');
    const s2 = makeDb();
    seedDeal(s2);
    await write(s2, { posted_at_ms: NOW - 7 * DAY });
    assert(s2.all('deal_cpm_records')[0]?.views_7d === 20_000, 'a snapshot at exactly day 7 is the 7-day reading');
  }
  // Synthetic campaign → never.
  {
    const store = makeDb();
    seedDeal(store, { campaign: 'sample-camp' });
    const out = await write(store, { campaign_id: 'sample-camp', synthetic_campaign_ids: ['sample-camp'] });
    assert(out === 'skipped' && store.all('deal_cpm_records').length === 0, 'a synthetic campaign never produces a record');
  }
  // Applied CPM price → 'cpm'.
  {
    const store = makeDb();
    seedDeal(store, { basis: { method: 'cpm', views: 18_000, applied: true } });
    await write(store);
    assert(store.all('deal_cpm_records')[0]?.pricing_method === 'cpm', 'pricing_method cpm only when a CPM price was applied');
  }
  // Pre-062 / exploding DB → no throw.
  {
    const store = makeDb({ pre062: true });
    seedDeal(store);
    assert((await write(store)) === 'unavailable', 'pre-062 → unavailable');
    const exploding = { from() { throw new Error('database on fire'); } } as unknown as SupabaseClient;
    let threw = false;
    try {
      const out = await writeDealCpmRecord(exploding, { offer_id: 'o', firm_id: 'f', campaign_id: null, platform: 'tiktok', views: 1, posted_at_ms: 0, now_ms: NOW });
      assert(out === 'failed', 'exploding DB → failed');
    } catch {
      threw = true;
    }
    assert(!threw, 'the writer never throws');
  }
}

// ── Through the real measurement tick ───────────────────────────────────────
async function tick(store: Store, now = NOW, plays: number | null = 20_000) {
  return runMeasurementTick(store.sb, {
    now,
    expireUndelivered: false,
    soundchartsEnabled: false,
    maxScrapes: 10,
    scrape: async () => ({
      profiles: store
        .all('creator_offers')
        .map((o) => ({ webVideoUrl: String(o.post_url), ...(plays == null ? {} : { playCount: plays }), diggCount: 10, commentCount: 1, shareCount: 0 })),
      costUsd: 0.004,
    }),
    recordCall: async () => {},
    auditFn: async () => {},
  });
}

async function throughTheTick() {
  const origErr = console.error;
  console.error = () => {}; // the reclaim pass logs against the double; not under test
  try {
    // A real deal is recorded; a synthetic one never is.
    {
      const store = makeDb();
      seedDeal(store, { id: 'offer-real' });
      seedDeal(store, { id: 'offer-sample', campaign: 'sample-camp' });
      const t = await tick(store);
      const recs = store.all('deal_cpm_records');
      assert(t.snapshots === 1, `tick: only the real deal was measured (got ${t.snapshots})`);
      assert(recs.length === 1 && recs[0].offer_id === 'offer-real', `tick: one record, for the real deal (got ${recs.map((r) => r.offer_id)})`);
      assert(recs[0]?.cpm_7d === 7.5, `tick: 7-day CPM recorded (got ${recs[0]?.cpm_7d})`);
      assert(t.dealCpmRecords === 1, 'tick: tally counts the record');

      // A month later the latest moves; the 7-day reading stays.
      const t2 = await tick(store, NOW + 31 * DAY, 60_000);
      const r = store.all('deal_cpm_records')[0] ?? {};
      assert(t2.snapshots === 1 && r.cpm_7d === 7.5 && r.cpm_latest === 2.5, `tick: latest refreshed on the monthly snapshot (got ${r.cpm_7d}/${r.cpm_latest})`);
    }
    // Pre-062: identical tick, no record, no error.
    {
      const a = makeDb();
      seedDeal(a);
      const b = makeDb({ pre062: true });
      seedDeal(b);
      const ta = await tick(a);
      const tb = await tick(b);
      const strip = (t: Record<string, unknown>) => ({ ...t, dealCpmRecords: 0 });
      assert(JSON.stringify(strip({ ...ta })) === JSON.stringify(strip({ ...tb })), 'pre-062: the tick tally is otherwise identical');
      assert(tb.dealCpmRecords === 0 && b.all('deal_cpm_records').length === 0, 'pre-062: nothing recorded');
      assert(
        JSON.stringify(a.all('deal_performance_snapshots').map((s) => s.views)) ===
          JSON.stringify(b.all('deal_performance_snapshots').map((s) => s.views)),
        'pre-062: the performance snapshot is written exactly as before',
      );
    }
    // A deal posted 40 days ago, first measured now (062 applied late): no
    // 7-day reading is invented from today's views.
    {
      const store = makeDb();
      seedDeal(store, { postedDaysAgo: 40 });
      await tick(store, NOW, 70_000);
      const r = store.all('deal_cpm_records')[0] ?? {};
      assert(store.all('deal_cpm_records').length === 1 && r.views_7d === null && r.cpm_7d === null && r.views_latest === 70_000,
        `tick: an old deal's first record has latest only (got ${r.views_7d}/${r.views_latest})`);
    }
    // Measured at day 8 before 062 existed, then 062 applied and the monthly
    // snapshot lands: the 7-day reading is the day-8 snapshot, not today's.
    {
      const store = makeDb({ pre062: true });
      seedDeal(store);
      await tick(store, NOW, 20_000);
      assert(store.all('deal_cpm_records').length === 0 && store.all('deal_performance_snapshots').length === 1, 'tick: pre-062 the day-8 snapshot lands, no record');
      store.db.refuse = undefined; // 062 applied
      await tick(store, NOW + 31 * DAY, 60_000);
      const r = store.all('deal_cpm_records')[0] ?? {};
      assert(r.views_7d === 20_000 && r.cpm_7d === 7.5 && r.views_latest === 60_000 && r.cpm_latest === 2.5,
        `tick: a late first record takes views_7d from the day-8 snapshot (got ${r.views_7d}/${r.cpm_7d}, latest ${r.views_latest})`);
    }
    // Image post through the tick: snapshot lands, CPM stays null.
    {
      const store = makeDb();
      seedDeal(store);
      await tick(store, NOW, null);
      const r = store.all('deal_cpm_records')[0] ?? {};
      assert(store.all('deal_cpm_records').length === 1 && r.cpm_7d === null && r.views_7d === null, 'tick: an image post records a null CPM');
    }
  } finally {
    console.error = origErr;
  }
}

function migration062() {
  const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '062_deal_cpm_records.sql'), 'utf8');
  const code = sql.replace(/--.*$/gm, '').toLowerCase();
  assert(/create table if not exists public\.deal_cpm_records/.test(code), 'migration 062: creates deal_cpm_records');
  for (const col of ['offer_id', 'firm_id', 'campaign_id', 'platform', 'channel', 'agreed_usd', 'expected_views', 'views_7d', 'views_latest', 'cpm_7d', 'cpm_latest', 'pricing_method', 'created_at', 'updated_at']) {
    assert(new RegExp(`\\n\\s*${col}\\s`).test(code), `migration 062: has ${col}`);
  }
  assert(/unique index if not exists deal_cpm_records_offer_id_key\s+on public\.deal_cpm_records \(offer_id\)/.test(code), 'migration 062: offer_id is unique');
  assert(/enable row level security/.test(code), 'migration 062: RLS on');
  assert(/firm_id in \(select firm_id from public\.firm_members where user_id = auth\.uid\(\)\)/.test(code), 'migration 062: member SELECT policy scoped by firm (056 pattern)');
  assert(!/for (insert|update|delete|all)/.test(code), 'migration 062: no write policies (service-role only)');
  assert(/add column if not exists first_ask_usd numeric/.test(code), 'migration 062: creator_offers.first_ask_usd numeric');
  assert(!/\bdrop (table|column)\b/.test(code) && !/\bdelete from\b/.test(code), 'migration 062: additive only');

  const s61 = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '061_cpm_pricing_shadow.sql'), 'utf8');
  const c61 = s61.replace(/--.*$/gm, '').toLowerCase();
  assert(/add column if not exists target_cpm_usd numeric/.test(c61) && /add column if not exists max_cpm_usd numeric/.test(c61), 'migration 061: campaign CPM targets, nullable');
  assert(/add column if not exists pricing_basis jsonb/.test(c61), 'migration 061: creator_offers.pricing_basis jsonb');
  assert(/add column if not exists pricing_mode text not null default 'formula'/.test(c61), "migration 061: firms.pricing_mode defaults to 'formula'");
  assert(/check \(pricing_mode in \('formula', 'cpm'\)\)/.test(c61), 'migration 061: pricing_mode constrained');
  assert(!/\bdrop (table|column)\b/.test(c61) && !/\bdelete from\b/.test(c61), 'migration 061: additive only');
}

async function main() {
  const origLog = console.log;
  await writerUnit();
  await throughTheTick();
  migration062();
  console.log = origLog;
  console.log(`deal-cpm-records test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
