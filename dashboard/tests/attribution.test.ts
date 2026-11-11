// tests/attribution.test.ts
//
// Hermetic tests for the attribution build:
//   1. captureArtistBaseline shape (stubbed globalThis.fetch, like
//      stripe-connect.test.ts) + graceful degrade without SOUNDCHARTS_* env.
//   2. checkDeliverableSpec pass/fail/partial + the 90% tolerance boundary.
//   3. runMeasurementTick artist polling: cadence gating (isSnapshotDue reuse),
//      3-campaigns/tick cap, env-absent skip tally — against an in-memory
//      Supabase mock (negotiation-harness store pattern + .not() support).
//   4. Spec-check persistence through the tick: spec_check stamped on
//      deal_deliveries while status semantics stay untouched.
//
// Run: npx tsx tests/attribution.test.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  captureArtistBaseline,
  latestSeriesValue,
  type ScResult,
  type ScListeningSeries,
} from '../src/lib/soundcharts';
import { MAX_RESOLVE_ATTEMPTS, checkDeliverableSpec } from '../src/lib/measurement';
import { normalizeDeliverables } from '../src/lib/deliverables';
import { MEASUREMENT_ENDPOINT, runMeasurementTick } from '../src/lib/measurement-tick';
import type { LedgerEntry } from '../src/lib/api-ledger';

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

// ── In-memory Supabase mock ─────────────────────────────────────────────────
// Same pattern as tests/negotiation-harness/store.ts, extended with the
// .not(col, 'is', null) filter the measurement tick uses. Kept local so the
// harness store stays untouched.

type Row = Record<string, unknown>;
interface Filter {
  kind: 'eq' | 'in' | 'notnull' | 'notin';
  col: string;
  val?: unknown;
}
type Tables = Record<string, Row[]>;
interface ExecResult {
  data: unknown;
  error: { message: string } | null;
}

let idSeq = 0;

class Query implements PromiseLike<ExecResult> {
  private filters: Filter[] = [];
  private op: 'select' | 'insert' | 'update' = 'select';
  private payload: Row | Row[] | null = null;
  private orderBy?: { col: string; asc: boolean };
  private limitN?: number;

  constructor(
    private tables: Tables,
    private table: string,
    private failTables: Set<string> = new Set(),
  ) {}

  private rows(): Row[] {
    if (!this.tables[this.table]) this.tables[this.table] = [];
    return this.tables[this.table];
  }

  select(_cols?: string): this {
    return this;
  }
  insert(payload: Row | Row[]): this {
    this.op = 'insert';
    this.payload = payload;
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
  in(col: string, val: unknown[]): this {
    this.filters.push({ kind: 'in', col, val });
    return this;
  }
  not(col: string, op: string, val: unknown): this {
    if (op === 'is' && val === null) this.filters.push({ kind: 'notnull', col });
    // PostgREST spells a NOT IN list as the literal string "(a,b,c)" — that is
    // what the synthetic-campaign exclusion passes, so the mock has to parse it
    // rather than take an array.
    if (op === 'in' && typeof val === 'string') {
      const ids = val.replace(/^\(/, '').replace(/\)$/, '').split(',').filter(Boolean);
      this.filters.push({ kind: 'notin', col, val: ids });
    }
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderBy = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  private match(row: Row): boolean {
    return this.filters.every((f) => {
      if (f.kind === 'eq') return row[f.col] === f.val;
      if (f.kind === 'notnull') return row[f.col] != null;
      if (f.kind === 'notin') return !(f.val as unknown[]).includes(row[f.col]);
      return (f.val as unknown[]).includes(row[f.col]);
    });
  }

  private exec(): ExecResult {
    // Injected read failure, for the fail-closed paths: the tick must spend
    // nothing when it cannot prove which campaigns are fabricated or how many
    // times a post has already failed to resolve.
    if (this.failTables.has(this.table)) {
      return { data: null, error: { message: `injected failure: ${this.table}` } };
    }
    const rows = this.rows();
    if (this.op === 'insert') {
      const toInsert = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const inserted = toInsert.map((r) => {
        idSeq += 1;
        const row: Row = { id: `${this.table}-${idSeq}`, ...r };
        rows.push(row);
        return { ...row };
      });
      return { data: inserted, error: null };
    }
    if (this.op === 'update') {
      const patch = this.payload as Row;
      const updated: Row[] = [];
      for (const row of rows) {
        if (this.match(row)) {
          Object.assign(row, patch);
          updated.push({ ...row });
        }
      }
      return { data: updated, error: null };
    }
    let selected = rows.filter((r) => this.match(r)).map((r) => ({ ...r }));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      selected = selected.sort((a, b) => {
        const av = a[col] as string | number;
        const bv = b[col] as string | number;
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (asc ? 1 : -1);
      });
    }
    if (this.limitN != null) selected = selected.slice(0, this.limitN);
    return { data: selected, error: null };
  }

  single(): Promise<ExecResult> {
    const arr = this.exec().data as Row[];
    if (arr.length === 0) return Promise.resolve({ data: null, error: { message: 'no rows' } });
    return Promise.resolve({ data: arr[0], error: null });
  }
  maybeSingle(): Promise<ExecResult> {
    const arr = this.exec().data as Row[];
    return Promise.resolve({ data: arr.length ? arr[0] : null, error: null });
  }
  then<T1 = ExecResult, T2 = never>(
    onfulfilled?: ((value: ExecResult) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return Promise.resolve(this.exec()).then(onfulfilled, onrejected);
  }
}

function makeStore() {
  const tables: Tables = {};
  const failTables = new Set<string>();
  const sb = {
    from(table: string) {
      return new Query(tables, table, failTables);
    },
  } as unknown as SupabaseClient;
  return {
    sb,
    seed(table: string, row: Row): Row {
      if (!tables[table]) tables[table] = [];
      tables[table].push(row);
      return row;
    },
    all(table: string): Row[] {
      return tables[table] ?? [];
    },
    /** Make every read of `table` return a PostgREST error. */
    failReadsOn(table: string) {
      failTables.add(table);
    },
  };
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-14T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** A scraper that finds nothing, for the artist-poll cases that don't care
 *  about the delivery pass. `costUsd` is now part of the contract because the
 *  tick has to ledger what it spends. */
const noScrape = async () => ({ profiles: [], costUsd: 0 });

// ── 1a. Baseline degrade: no SOUNDCHARTS_* env → errors, never throws ───────
async function baselineDegraded() {
  delete process.env.SOUNDCHARTS_CLIENT_ID;
  delete process.env.SOUNDCHARTS_CLIENT_SECRET;
  const b = await captureArtistBaseline('uuid-degraded', NOW);
  assert(b.source === 'soundcharts', 'degraded: source stamped');
  assert(b.soundcharts_uuid === 'uuid-degraded', 'degraded: uuid stamped');
  assert(b.spotify_listeners === null, 'degraded: listeners null without env');
  assert(b.artist === null, 'degraded: no metadata without env');
  assert(b.pre_window === null, 'degraded: no pre-window without env');
  assert((b.errors ?? []).length >= 2, 'degraded: both sub-fetch errors recorded');
  assert(b.captured_at === iso(NOW), 'degraded: captured_at from the injected clock');
}

// ── 1b. Baseline happy path against a stubbed fetch ─────────────────────────
const realFetch = globalThis.fetch;
async function baselineShape() {
  process.env.SOUNDCHARTS_CLIENT_ID = 'sc-id';
  process.env.SOUNDCHARTS_CLIENT_SECRET = 'sc-secret';
  const urls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    urls.push(u);
    const json = (body: unknown) =>
      ({ ok: true, status: 200, json: async () => body }) as Response;
    if (u.includes('/oauth/token')) return json({ access_token: 'tok', expires_in: 3600 });
    if (u.includes('/api/v2.9/artist/')) {
      return json({ object: { name: 'Artist X', imageUrl: 'https://img.example/x.jpg', countryCode: 'US' } });
    }
    if (u.includes('/streaming/spotify/listening')) {
      return json({
        items: [
          { date: '2026-09-10', value: 123456 },
          { date: '2026-09-01', value: 100000 },
        ],
      });
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as typeof fetch;

  const b = await captureArtistBaseline('00000000-0000-4000-8000-00000000a001', NOW);
  assert(b.source === 'soundcharts', 'baseline: source soundcharts');
  assert(b.soundcharts_uuid === '00000000-0000-4000-8000-00000000a001', 'baseline: uuid persisted');
  assert(b.spotify_listeners === 123456, 'baseline: latest listeners value (max date, not array order)');
  assert(b.listeners_date === '2026-09-10', 'baseline: listeners_date is the series date');
  assert(b.artist?.name === 'Artist X', 'baseline: artist name trimmed from metadata');
  assert(b.artist?.country_code === 'US', 'baseline: country code kept');
  assert(b.errors === undefined, `baseline: no errors on the happy path (got ${JSON.stringify(b.errors)})`);
  assert(b.captured_at === iso(NOW), 'baseline: captured_at ISO from injected clock');
  assert(urls.some((u) => u.includes('/oauth/token')), 'baseline: OAuth token fetched');

  // The Soundcharts API serves /listening, not /listeners. The old path
  // 404'd and that 404 was read for months as a plan limit.
  assert(
    urls.some((u) => u.includes('/streaming/spotify/listening')),
    `baseline: hits the /listening path (urls: ${JSON.stringify(urls)})`,
  );
  assert(
    !urls.some((u) => /\/streaming\/spotify\/listeners(\?|$)/.test(u)),
    'baseline: never calls the dead /listeners path',
  );

  // The counterfactual anchor rides along on the same call.
  assert(b.pre_window != null, 'baseline: pre-campaign window captured');
  assert(b.pre_window?.end === '2026-09-14', `baseline: pre-window ends today (got ${b.pre_window?.end})`);
  assert(b.pre_window?.points.length === 2, `baseline: pre-window points kept (got ${b.pre_window?.points.length})`);
  assert(
    b.pre_window?.points[0].date === '2026-09-01' && b.pre_window?.points[1].date === '2026-09-10',
    'baseline: pre-window points sorted ascending',
  );
  assert(
    urls.filter((u) => u.includes('/streaming/')).length === 1,
    'baseline: pre-window costs no extra API call',
  );

  globalThis.fetch = realFetch;
  delete process.env.SOUNDCHARTS_CLIENT_ID;
  delete process.env.SOUNDCHARTS_CLIENT_SECRET;
}

// ── 1c. latestSeriesValue edge cases ─────────────────────────────────────────
function seriesHelper() {
  assert(latestSeriesValue([]) === null, 'series: empty → null');
  assert(latestSeriesValue(null) === null, 'series: null → null');
  const v = latestSeriesValue([
    { date: '2026-01-02', value: 2 },
    { date: '2026-01-03', value: 3 },
    { date: '2026-01-01', value: 1 },
  ]);
  assert(v?.value === 3 && v?.date === '2026-01-03', 'series: picks max date');
  assert(
    latestSeriesValue([{ date: '2026-01-01' }, { value: 5 }]) === null,
    'series: malformed points dropped',
  );
}

// ── 2. Deliverable spec check: pass/fail/partial + tolerance boundary ───────
function specCheck() {
  const reel30 = normalizeDeliverables([
    { promo_type: 'reel', quantity: 1, delivery_window_days: 14, min_seconds: 30 },
  ]);

  assert(checkDeliverableSpec([], { videoMeta: { duration: 30 } }) === null, 'spec: no agreed lines → null (nothing stamped)');

  const storyOnly = normalizeDeliverables([
    { promo_type: 'story', quantity: 2, delivery_window_days: 7, min_seconds: 15 },
  ]);
  const st = checkDeliverableSpec(storyOnly, { videoMeta: { duration: 20 } });
  assert(st?.check === 'partial', `spec: story-only bundle → partial (got ${st?.check})`);
  assert(/story/.test(st?.detail ?? ''), 'spec: story-only detail names the limitation');

  // Length-agnostic feed post: type-level pass (a TikTok scrape only proves
  // "a video exists in the feed" — documented limitation).
  const postOnly = normalizeDeliverables([
    { promo_type: 'post', quantity: 1, delivery_window_days: 14 },
  ]);
  const po = checkDeliverableSpec(postOnly, {});
  assert(po?.check === 'pass', `spec: no min length agreed → pass (got ${po?.check})`);

  const pass = checkDeliverableSpec(reel30, { videoMeta: { duration: 45 } });
  assert(pass?.check === 'pass', `spec: 45s vs 30s ask → pass (got ${pass?.check})`);

  // Tolerance boundary: >= 90% of min_seconds passes. 27/30 exactly on it.
  const boundary = checkDeliverableSpec(reel30, { videoMeta: { duration: 27 } });
  assert(boundary?.check === 'pass', `spec: 27s vs 30s ask (exactly 90%) → pass (got ${boundary?.check})`);
  const below = checkDeliverableSpec(reel30, { videoMeta: { duration: 26 } });
  assert(below?.check === 'fail', `spec: 26s vs 30s ask (below 90%) → fail (got ${below?.check})`);

  // The example from the ask: a 5s post against a 30s ask fails.
  const short = checkDeliverableSpec(reel30, { videoMeta: { duration: 5 } });
  assert(short?.check === 'fail', `spec: 5s vs 30s ask → fail (got ${short?.check})`);
  assert(/5s/.test(short?.detail ?? '') && /30s/.test(short?.detail ?? ''), 'spec: fail detail carries both numbers');

  const noDuration = checkDeliverableSpec(reel30, {});
  assert(noDuration?.check === 'partial', `spec: no duration in payload → partial (got ${noDuration?.check})`);
  assert(/duration/.test(noDuration?.detail ?? ''), 'spec: partial detail says duration was missing');

  // Multi-line bundle: duration checked against the MOST LENIENT feed ask
  // (can't tell which line the post fulfils; only certain fails are fails).
  const mixed = normalizeDeliverables([
    { promo_type: 'reel', quantity: 1, delivery_window_days: 14, min_seconds: 30 },
    { promo_type: 'dance_trend', quantity: 1, delivery_window_days: 14, min_seconds: 60 },
    { promo_type: 'story', quantity: 1, delivery_window_days: 7, min_seconds: 15 },
  ]);
  const mixedPass = checkDeliverableSpec(mixed, { videoMeta: { duration: 28 } });
  assert(mixedPass?.check === 'pass', `spec: 28s vs min(30,60) ask → pass (story line ignored) (got ${mixedPass?.check})`);
  const mixedFail = checkDeliverableSpec(mixed, { videoMeta: { duration: 10 } });
  assert(mixedFail?.check === 'fail', `spec: 10s fails even the most lenient 30s ask (got ${mixedFail?.check})`);
}

// ── 3. Measurement tick — artist poll: daily cadence, backfill, dedupe, cap ─
function seedCampaign(store: ReturnType<typeof makeStore>, id: string, confirmedMs: number) {
  store.seed('campaigns', {
    id,
    firm_id: 'firm-1',
    artist_soundcharts_uuid: `uuid-${id}`,
    confirmed_at: iso(confirmedMs),
    created_at: iso(confirmedMs - DAY),
  });
}

/** Two-point series, mirroring the real (gappy, descending) Soundcharts shape. */
const okSeries = (value: number): ScResult<ScListeningSeries> => ({
  ok: true,
  data: {
    items: [
      { date: '2026-09-12T00:00:00+00:00', value },
      { date: '2026-09-01T00:00:00+00:00', value: value - 10 },
    ],
  },
});

const noopRecord = async () => {};

async function artistPolling() {
  const store = makeStore();
  seedCampaign(store, 'camp-due', NOW - 8 * DAY);
  store.seed('campaigns', {
    id: 'camp-freetext',
    firm_id: 'firm-1',
    artist_soundcharts_uuid: null,
    confirmed_at: iso(NOW - 30 * DAY),
    created_at: iso(NOW - 31 * DAY),
  });

  const calls: Array<{ uuid: string; start?: string; end?: string }> = [];
  const fetchListeners = async (uuid: string, start?: string, end?: string) => {
    calls.push({ uuid, start, end });
    return okSeries(75_000);
  };

  const t1 = await runMeasurementTick(store.sb, {
    expireUndelivered: false,
    now: NOW,
    scrape: noScrape,
    fetchListeners,
    recordCall: noopRecord,
    soundchartsEnabled: true,
  });
  assert(t1.artistPolls === 1, `poll: only the uuid-carrying campaign polled (got ${t1.artistPolls})`);
  assert(calls[0]?.uuid === 'uuid-camp-due', 'poll: fetch called with the campaign uuid');
  assert(calls[0]?.end === '2026-09-14', `poll: end date is today (got ${calls[0]?.end})`);
  assert(calls[0]?.start === '2026-09-06', `poll: start clamped to confirm date (got ${calls[0]?.start})`);

  // Backfill: BOTH series points land, not just the newest one.
  const snaps = store.all('artist_metric_snapshots');
  assert(snaps.length === 2, `poll: whole window backfilled (got ${snaps.length})`);
  assert(t1.artistSnapshots === 2, `poll: tally counts rows written (got ${t1.artistSnapshots})`);
  const byDay = Object.fromEntries(snaps.map((r) => [r.metric_date as string, r.value]));
  assert(byDay['2026-09-12'] === 75_000, 'poll: newest point keyed to its own day');
  assert(byDay['2026-09-01'] === 74_990, 'poll: older point kept, not overwritten by the newest');
  assert(snaps[0].campaign_id === 'camp-due' && snaps[0].firm_id === 'firm-1', 'poll: keyed to campaign + firm');
  assert(snaps[0].source === 'soundcharts' && snaps[0].metric === 'spotify_listeners', 'poll: source/metric stamped');
  assert(snaps[0].captured_at === iso(NOW), 'poll: captured_at is poll time, from the injected clock');
  assert(snaps[0].metric_date !== snaps[0].captured_at, 'poll: metric_date is a day, not the poll timestamp');

  // Next hourly tick — inside the daily interval, so no call at all.
  const t2 = await runMeasurementTick(store.sb, {
    expireUndelivered: false,
    now: NOW + 60 * 60 * 1000,
    scrape: noScrape,
    fetchListeners,
    recordCall: noopRecord,
    soundchartsEnabled: true,
  });
  assert(t2.artistPolls === 0, `poll: hourly re-tick gated to daily (got ${t2.artistPolls})`);
  assert(calls.length === 1, 'poll: quota not spent inside the day');

  // A day later — due, called, but the series has nothing new, so nothing is written.
  const t3 = await runMeasurementTick(store.sb, {
    expireUndelivered: false,
    now: NOW + 21 * 60 * 60 * 1000,
    scrape: noScrape,
    fetchListeners,
    recordCall: noopRecord,
    soundchartsEnabled: true,
  });
  assert(t3.artistPolls === 1, `poll: due again after ~a day (got ${t3.artistPolls})`);
  assert(t3.artistSnapshots === 0, `poll: already-held days are not rewritten (got ${t3.artistSnapshots})`);
  assert(store.all('artist_metric_snapshots').length === 2, 'poll: no duplicate rows');

  // A genuinely new day does get written.
  const t4 = await runMeasurementTick(store.sb, {
    expireUndelivered: false,
    now: NOW + 2 * DAY,
    scrape: noScrape,
    fetchListeners: async () => ({
      ok: true,
      data: { items: [{ date: '2026-09-15T00:00:00+00:00', value: 76_500 }] },
    }),
    recordCall: noopRecord,
    soundchartsEnabled: true,
  });
  assert(t4.artistSnapshots === 1, `poll: one new day appended (got ${t4.artistSnapshots})`);
  assert(store.all('artist_metric_snapshots').length === 3, 'poll: series grew to 3 points');
}

async function artistPollCap() {
  const store = makeStore();
  for (let i = 1; i <= 4; i++) seedCampaign(store, `camp-${i}`, NOW - 10 * DAY);
  const calls: string[] = [];
  const t = await runMeasurementTick(store.sb, {
    expireUndelivered: false,
    now: NOW,
    scrape: noScrape,
    fetchListeners: async (uuid) => {
      calls.push(uuid);
      return okSeries(1000);
    },
    recordCall: noopRecord,
    soundchartsEnabled: true,
  });
  assert(t.artistPolls === 3, `cap: 4 due campaigns, max 3 polls/tick (got ${t.artistPolls})`);
  assert(calls.length === 3, `cap: exactly 3 Soundcharts fetches (got ${calls.length})`);
  assert(store.all('artist_metric_snapshots').length === 6, 'cap: 3 campaigns x 2 backfilled days');
}

async function artistPollEnvAbsent() {
  const store = makeStore();
  seedCampaign(store, 'camp-due', NOW - 8 * DAY);
  const calls: string[] = [];
  const t = await runMeasurementTick(store.sb, {
    expireUndelivered: false,
    now: NOW,
    scrape: noScrape,
    fetchListeners: async (uuid) => {
      calls.push(uuid);
      return okSeries(1);
    },
    recordCall: noopRecord,
    soundchartsEnabled: false, // SOUNDCHARTS_* env absent
  });
  assert(t.artistPolls === 0, 'env-absent: no polls');
  assert(t.artistSkipped === 1, `env-absent: due campaign tallied as skipped (got ${t.artistSkipped})`);
  assert(calls.length === 0, 'env-absent: Soundcharts never called');
  assert(store.all('artist_metric_snapshots').length === 0, 'env-absent: no snapshot rows');
}

/** A long-finished campaign must stop costing quota — and must not read as broken. */
async function artistPollWindowClosed() {
  const store = makeStore();
  seedCampaign(store, 'camp-old', NOW - 200 * DAY);
  const calls: string[] = [];
  const t = await runMeasurementTick(store.sb, {
    expireUndelivered: false,
    now: NOW,
    scrape: noScrape,
    fetchListeners: async (uuid) => {
      calls.push(uuid);
      return okSeries(1);
    },
    recordCall: noopRecord,
    soundchartsEnabled: true,
  });
  assert(calls.length === 0, 'closed-window: a 200-day-old campaign is not polled');
  assert(t.artistPolls === 0, 'closed-window: no polls');
  assert(t.artistSkipped === 0, 'closed-window: counted as done, NOT as a skipped gap');
}

/** Every Soundcharts call lands in api_ledger — nothing tracked the shared quota before. */
async function artistPollLedger() {
  const store = makeStore();
  seedCampaign(store, 'camp-due', NOW - 8 * DAY);
  const ledger: Array<Record<string, unknown>> = [];
  await runMeasurementTick(store.sb, {
    expireUndelivered: false,
    now: NOW,
    scrape: noScrape,
    fetchListeners: async () => okSeries(500),
    recordCall: async (e) => {
      ledger.push(e as unknown as Record<string, unknown>);
    },
    soundchartsEnabled: true,
  });
  assert(ledger.length === 1, `ledger: one row per Soundcharts call (got ${ledger.length})`);
  assert(ledger[0]?.source === 'soundcharts', `ledger: source tagged (got ${ledger[0]?.source})`);
  assert(ledger[0]?.campaign_id === 'camp-due', 'ledger: attributed to the campaign');
  assert(ledger[0]?.cost_usd === 0, 'ledger: flat-rate plan, so cost is honestly 0');
  assert(ledger[0]?.records_returned === 2, 'ledger: records_returned is the quota-visible signal');

  // A failed call still gets a ledger row — it spent quota either way.
  const store2 = makeStore();
  seedCampaign(store2, 'camp-fail', NOW - 8 * DAY);
  const ledger2: Array<Record<string, unknown>> = [];
  const t = await runMeasurementTick(store2.sb, {
    expireUndelivered: false,
    now: NOW,
    scrape: noScrape,
    fetchListeners: async () => ({ ok: false, status: 404, error: 'Not found.' }),
    recordCall: async (e) => {
      ledger2.push(e as unknown as Record<string, unknown>);
    },
    soundchartsEnabled: true,
  });
  assert(ledger2.length === 1, 'ledger: a 404 still spent a call and is recorded');
  assert(t.artistSkipped === 1, 'ledger: failed fetch tallied as skipped');
  assert(store2.all('artist_metric_snapshots').length === 0, 'ledger: no snapshot from a failed fetch');
}

/**
 * Simulates a pre-migration-038 database: `metric_date` does not exist, so
 * PostgREST rejects any select or insert that names it. Wraps the in-memory
 * store rather than replacing it, so the surviving queries still behave.
 */
function rejectingQuery(message: string): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.select = self;
  q.eq = self;
  q.in = self;
  q.not = self;
  q.order = self;
  q.limit = self;
  q.then = (f: (v: ExecResult) => unknown) =>
    Promise.resolve(f({ data: null, error: { message } }));
  q.maybeSingle = () => Promise.resolve({ data: null, error: { message } });
  return q;
}

function preMigration038(store: ReturnType<typeof makeStore>): SupabaseClient {
  const MSG = 'column "metric_date" does not exist';
  const real = store.sb as unknown as { from(t: string): Record<string, unknown> };
  return {
    from(table: string) {
      const q = real.from(table);
      if (table !== 'artist_metric_snapshots') return q;
      const origSelect = q.select as (c?: string) => unknown;
      const origInsert = q.insert as (p: unknown) => unknown;
      q.select = (cols?: string) =>
        cols && cols.includes('metric_date') ? rejectingQuery(MSG) : origSelect.call(q, cols);
      q.insert = (payload: unknown) => {
        const arr = (Array.isArray(payload) ? payload : [payload]) as Array<
          Record<string, unknown>
        >;
        return arr.some((r) => 'metric_date' in r)
          ? rejectingQuery(MSG)
          : origInsert.call(q, payload);
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

/**
 * The code ships before migration 038 is applied. The fallback must keep
 * working AND must keep the daily gate — without it `lastMs` reads null every
 * tick and the daily poll silently becomes an hourly one against a shared quota.
 */
async function artistPollPreMigration038() {
  const store = makeStore();
  seedCampaign(store, 'camp-due', NOW - 8 * DAY);
  const sb = preMigration038(store);
  const calls: string[] = [];
  const fetchListeners = async (uuid: string) => {
    calls.push(uuid);
    return okSeries(900);
  };

  const t1 = await runMeasurementTick(sb, {
    expireUndelivered: false,
    now: NOW,
    scrape: noScrape,
    fetchListeners,
    recordCall: noopRecord,
    soundchartsEnabled: true,
  });
  assert(t1.artistPolls === 1, `pre-038: campaign still polled (got ${t1.artistPolls})`);
  assert(t1.artistSnapshots === 1, `pre-038: newest point only (got ${t1.artistSnapshots})`);
  const snaps = store.all('artist_metric_snapshots');
  assert(snaps.length === 1, `pre-038: one legacy-shaped row (got ${snaps.length})`);
  assert(snaps[0].metric_date === undefined, 'pre-038: row carries no metric_date');
  assert(snaps[0].value === 900, `pre-038: newest value stored (got ${snaps[0].value})`);

  const t2 = await runMeasurementTick(sb, {
    expireUndelivered: false,
    now: NOW + 60 * 60 * 1000,
    scrape: noScrape,
    fetchListeners,
    recordCall: noopRecord,
    soundchartsEnabled: true,
  });
  assert(
    t2.artistPolls === 0,
    `pre-038: daily gate survives the missing column — no hourly polling (got ${t2.artistPolls})`,
  );
  assert(calls.length === 1, 'pre-038: quota not burned by the fallback');
}

// ── 4. Spec check persisted through the tick; status semantics untouched ────
function seedPostedDeal(store: ReturnType<typeof makeStore>, minSeconds: number | null) {
  store.seed('creator_offers', {
    id: 'offer-1',
    firm_id: 'firm-1',
    campaign_influencer_id: 'ci-1',
    post_url: 'https://www.tiktok.com/@creator/video/12345',
    posted_at: iso(NOW - 8 * DAY), // snapshot due (first ~1wk)
    agreed_deliverables: [
      { promo_type: 'reel', quantity: 1, delivery_window_days: 14, min_seconds: minSeconds },
    ],
  });
  store.seed('campaign_influencers', { id: 'ci-1', influencer_id: 'inf-1' });
  store.seed('influencers', { id: 'inf-1', username: 'creator' });
}

async function tickSpecScenario(duration: number | undefined) {
  const store = makeStore();
  seedPostedDeal(store, 30);
  const post: Record<string, unknown> = {
    webVideoUrl: 'https://www.tiktok.com/@creator/video/12345',
    playCount: 9000,
    diggCount: 900,
    commentCount: 90,
    shareCount: 9,
  };
  if (duration !== undefined) post.videoMeta = { duration };
  const ledger: LedgerEntry[] = [];
  const tally = await runMeasurementTick(store.sb, {
    expireUndelivered: false,
    now: NOW,
    scrape: async () => ({ profiles: [post], costUsd: 0.011, runId: 'run-spec' }),
    // Injected, not defaulted: the real writer imports ./supabase, which
    // constructs a client at module load and throws without env. The tick now
    // treats an unbookable scrape as fail-closed, so an uninjected recordCall
    // would (correctly) abort the delivery pass instead of testing it.
    recordCall: async (e) => {
      ledger.push(e);
    },
    fetchListeners: async () => okSeries(1),
    soundchartsEnabled: false,
  });
  return { store, tally, ledger };
}

async function specThroughTick() {
  // pass: 45s against a 30s ask
  const ok = await tickSpecScenario(45);
  const okDel = ok.store.all('deal_deliveries')[0];
  assert(ok.tally.verified === 1, 'tick: post found → verified tally');
  assert(okDel?.status === 'verified', `tick: delivery status verified (got ${okDel?.status})`);
  assert(okDel?.spec_check === 'pass', `tick: spec_check pass (got ${okDel?.spec_check})`);
  assert(ok.store.all('deal_performance_snapshots').length === 1, 'tick: performance snapshot still written');
  // The scrape that produced all of the above cost real money.
  const okLedger = ok.ledger.filter((e) => e.endpoint === MEASUREMENT_ENDPOINT);
  assert(okLedger.length === 1, `tick: the delivery scrape is ledgered (got ${okLedger.length} rows)`);
  assert(okLedger[0]?.source === 'apify', 'tick: ledgered under source=apify so the daily cap sums it');
  assert(okLedger[0]?.cost_usd === 0.011, `tick: real costUsd reaches the ledger (got ${okLedger[0]?.cost_usd})`);
  assert(
    (okLedger[0]?.request_meta as Record<string, unknown>)?.matched === true,
    'tick: a hit is recorded as matched:true so it never counts against the retry ceiling',
  );
  assert(ok.tally.costUsd === 0.011, `tick: tally reports the spend (got ${ok.tally.costUsd})`);

  // fail: 5s against a 30s ask — status must STAY 'verified' (existence),
  // only the spec fields flag the mismatch.
  const bad = await tickSpecScenario(5);
  const badDel = bad.store.all('deal_deliveries')[0];
  assert(badDel?.spec_check === 'fail', `tick: 5s vs 30s ask → spec fail (got ${badDel?.spec_check})`);
  assert(badDel?.status === 'verified', `tick: spec fail does NOT change status (got ${badDel?.status})`);
  assert(typeof badDel?.spec_check_detail === 'string' && (badDel.spec_check_detail as string).length > 0, 'tick: fail detail persisted');

  // partial: scrape payload without videoMeta.duration
  const part = await tickSpecScenario(undefined);
  const partDel = part.store.all('deal_deliveries')[0];
  assert(partDel?.spec_check === 'partial', `tick: missing duration → partial (got ${partDel?.spec_check})`);
  assert(partDel?.status === 'verified', 'tick: partial keeps status verified');
}

// ── 5. The measurement tick must not burn money on fake rows ───────────────
//
// Live state that produced this section (2026-09-17): 110 Apify actor runs on
// 09-16 costing $0.5170 and 90 by 18:00 on 09-17 costing $0.4230, all of them
// re-scraping five deal_deliveries whose post_url pointed at fabricated
// [SAMPLE] handles. 43 deliveries sat at status='verified' with 0 performance
// snapshots behind them. None of it appeared in api_ledger.

/** One posted offer, on `campaignId`, whose post will or won't be found. */
function seedOffer(
  store: ReturnType<typeof makeStore>,
  opts: { offerId: string; campaignId: string; postUrl: string },
) {
  store.seed('creator_offers', {
    id: opts.offerId,
    firm_id: 'firm-1',
    campaign_id: opts.campaignId,
    campaign_influencer_id: `ci-${opts.offerId}`,
    post_url: opts.postUrl,
    posted_at: iso(NOW - 8 * DAY), // snapshot due
    agreed_deliverables: null,
  });
  store.seed('campaign_influencers', { id: `ci-${opts.offerId}`, influencer_id: `inf-${opts.offerId}` });
  store.seed('influencers', { id: `inf-${opts.offerId}`, username: `creator_${opts.offerId}` });
}

/** Run the delivery pass with a scrape spy, artist polling off. */
async function runDeliveryPass(
  store: ReturnType<typeof makeStore>,
  extra: Parameters<typeof runMeasurementTick>[1] = {},
) {
  const handles: string[] = [];
  const ledger: LedgerEntry[] = [];
  const tally = await runMeasurementTick(store.sb, {
    expireUndelivered: false,
    now: NOW,
    soundchartsEnabled: false,
    scrape: async (handle: string) => {
      handles.push(handle);
      return { profiles: [], costUsd: 0.005, runId: 'run-x' };
    },
    recordCall: async (e) => {
      ledger.push(e);
    },
    ...extra,
  });
  return { tally, handles, ledger };
}

async function syntheticNeverScraped() {
  const store = makeStore();
  store.seed('campaigns', { id: 'camp-sample', firm_id: 'firm-1', synthetic: true });
  store.seed('campaigns', { id: 'camp-real', firm_id: 'firm-1', synthetic: false });
  seedOffer(store, {
    offerId: 'fake',
    campaignId: 'camp-sample',
    postUrl: 'https://www.tiktok.com/@sample_demo_mile33/video/7947910979',
  });
  seedOffer(store, {
    offerId: 'real',
    campaignId: 'camp-real',
    postUrl: 'https://www.tiktok.com/@realcreator/video/7388',
  });

  const { tally, handles } = await runDeliveryPass(store);
  assert(handles.length === 1, `synthetic: exactly one scrape happened (got ${handles.length})`);
  assert(handles[0] === 'creator_real', `synthetic: the REAL offer is the one scraped (got ${handles[0]})`);
  assert(
    !handles.includes('creator_fake'),
    'synthetic: a [SAMPLE] campaign offer is never scraped',
  );
  // Excluded in the query, so it never even occupies a maxScrapes slot — the
  // half of the bug that starved real deals behind five fabricated ones.
  assert(tally.considered === 1, `synthetic: fabricated offer never reaches the loop (considered ${tally.considered})`);
}

async function syntheticLookupFailsClosed() {
  const store = makeStore();
  store.seed('campaigns', { id: 'camp-real', firm_id: 'firm-1', synthetic: false });
  seedOffer(store, { offerId: 'real', campaignId: 'camp-real', postUrl: 'https://tiktok.com/@a/video/1' });
  store.failReadsOn('campaigns');

  const { tally, handles } = await runDeliveryPass(store);
  assert(handles.length === 0, `fail-closed: unreadable synthetic set → zero scrapes (got ${handles.length})`);
  assert(tally.costUsd === 0, 'fail-closed: nothing spent when cleanliness cannot be proven');
}

async function ledgerLookupFailsClosed() {
  const store = makeStore();
  store.seed('campaigns', { id: 'camp-real', firm_id: 'firm-1', synthetic: false });
  seedOffer(store, { offerId: 'real', campaignId: 'camp-real', postUrl: 'https://tiktok.com/@a/video/1' });
  store.failReadsOn('api_ledger');

  const { handles } = await runDeliveryPass(store);
  assert(
    handles.length === 0,
    `fail-closed: unreadable attempt history → zero scrapes (got ${handles.length})`,
  );
}

async function missIsLedgeredAndBacksOff() {
  const store = makeStore();
  store.seed('campaigns', { id: 'camp-real', firm_id: 'firm-1', synthetic: false });
  seedOffer(store, {
    offerId: 'ghost',
    campaignId: 'camp-real',
    postUrl: 'https://www.tiktok.com/@realcreator/video/9999',
  });

  // First tick: nothing found. The spend must still be on the books.
  const first = await runDeliveryPass(store);
  assert(first.handles.length === 1, 'miss: first attempt scrapes');
  assert(first.ledger.length === 1, `miss: an unmatched scrape is ledgered too (got ${first.ledger.length})`);
  assert(first.ledger[0]?.cost_usd === 0.005, 'miss: the miss carries its real cost');
  assert(
    (first.ledger[0]?.request_meta as Record<string, unknown>)?.matched === false,
    'miss: recorded as matched:false — this is the retry memory',
  );
  assert(first.tally.costUsd === 0.005, 'miss: tally reports the spend');
  assert(store.all('deal_performance_snapshots').length === 0, 'miss: no snapshot invented');

  // Replay that ledger row into the store and tick again an hour later. The
  // old code re-scraped identically here, forever.
  store.seed('api_ledger', {
    source: 'apify',
    endpoint: MEASUREMENT_ENDPOINT,
    created_at: iso(NOW),
    request_meta: { creator_offer_id: 'ghost', matched: false },
  });
  const second = await runDeliveryPass(store, { now: NOW + 60 * 60 * 1000 });
  assert(second.handles.length === 0, `backoff: one hour later, no re-scrape (got ${second.handles.length})`);
  assert(second.tally.backoff === 1, `backoff: counted as backed off (got ${second.tally.backoff})`);
  assert(second.tally.costUsd === 0, 'backoff: a backed-off tick spends nothing');

  // Three hours later the 2h window has elapsed — one retry, not an hourly one.
  const third = await runDeliveryPass(store, { now: NOW + 3 * 60 * 60 * 1000 });
  assert(third.handles.length === 1, 'backoff: retries once the window elapses');
}

async function giveUpMarksMissing() {
  const store = makeStore();
  store.seed('campaigns', { id: 'camp-real', firm_id: 'firm-1', synthetic: false });
  seedOffer(store, {
    offerId: 'ghost',
    campaignId: 'camp-real',
    postUrl: 'https://www.instagram.com/p/SAMPLE38/',
  });
  for (let i = 0; i < MAX_RESOLVE_ATTEMPTS; i++) {
    store.seed('api_ledger', {
      source: 'apify',
      endpoint: MEASUREMENT_ENDPOINT,
      created_at: iso(NOW - (MAX_RESOLVE_ATTEMPTS - i) * 24 * 60 * 60 * 1000),
      request_meta: { creator_offer_id: 'ghost', matched: false },
    });
  }

  const { tally, handles } = await runDeliveryPass(store, { now: NOW + 365 * DAY });
  assert(handles.length === 0, `give up: at the ceiling nothing is scraped (got ${handles.length})`);
  assert(tally.unresolvable === 1, `give up: counted as unresolvable (got ${tally.unresolvable})`);
  const del = store.all('deal_deliveries')[0];
  assert(del?.status === 'missing', `give up: delivery marked 'missing', not re-queued (got ${del?.status})`);

  // And it stays given up — the marker is terminal, not a pause, and the tick
  // short-circuits on it rather than re-deriving the same verdict every hour.
  const again = await runDeliveryPass(store, { now: NOW + 730 * DAY });
  assert(again.handles.length === 0, 'give up: still nothing scraped on a later tick');
  assert(again.tally.costUsd === 0, 'give up: an unresolvable row costs nothing, forever');
  assert(
    again.tally.unresolvable === 0,
    `give up: an already-'missing' row is not re-counted every tick (got ${again.tally.unresolvable})`,
  );
}

async function giveUpNeverDowngradesVerified() {
  const store = makeStore();
  store.seed('campaigns', { id: 'camp-real', firm_id: 'firm-1', synthetic: false });
  seedOffer(store, { offerId: 'ghost', campaignId: 'camp-real', postUrl: 'https://tiktok.com/@a/video/1' });
  store.seed('deal_deliveries', {
    id: 'del-verified',
    creator_offer_id: 'ghost',
    firm_id: 'firm-1',
    post_url: 'https://tiktok.com/@a/video/1',
    status: 'verified',
    detected_at: iso(NOW - 8 * DAY),
  });
  for (let i = 0; i < MAX_RESOLVE_ATTEMPTS; i++) {
    store.seed('api_ledger', {
      source: 'apify',
      endpoint: MEASUREMENT_ENDPOINT,
      created_at: iso(NOW - (i + 1) * DAY),
      request_meta: { creator_offer_id: 'ghost', matched: false },
    });
  }
  await runDeliveryPass(store, { now: NOW + 365 * DAY });
  const del = store.all('deal_deliveries').find((r) => r.id === 'del-verified');
  assert(
    del?.status === 'verified',
    `give up: a already-verified delivery is never downgraded to 'missing' (got ${del?.status})`,
  );
}

async function main() {
  await baselineDegraded();
  await baselineShape();
  seriesHelper();
  specCheck();
  await artistPolling();
  await artistPollCap();
  await artistPollEnvAbsent();
  await artistPollWindowClosed();
  await artistPollLedger();
  await artistPollPreMigration038();
  await specThroughTick();
  await syntheticNeverScraped();
  await syntheticLookupFailsClosed();
  await ledgerLookupFailsClosed();
  await missIsLedgeredAndBacksOff();
  await giveUpMarksMissing();
  await giveUpNeverDowngradesVerified();

  console.log(`attribution test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
