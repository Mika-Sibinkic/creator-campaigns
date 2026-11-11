// tests/measurement.test.ts — hermetic. Run: npx tsx tests/measurement.test.ts
import {
  MAX_RESOLVE_ATTEMPTS,
  isSnapshotDue,
  matchPostMetrics,
  normalizeUrl,
  resolveAttemptDue,
} from '../src/lib/measurement';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MEASUREMENT_ENDPOINT, runMeasurementTick } from '../src/lib/measurement-tick';
// Type-only, and load-bearing: ../src/lib/audit and ../src/lib/api-ledger both
// pull in ./supabase, which constructs a client at module-evaluation time and
// throws without env. A value import here would break this file's hermeticity
// at load — which is also why every case below INJECTS auditFn/recordCall.
import type { AuditEntry } from '../src/lib/audit';
import type { LedgerEntry } from '../src/lib/api-ledger';

let passed = 0, failed = 0;
const fails: string[] = [];
function assert(c: boolean, m: string) { if (c) passed++; else { failed++; fails.push(m); console.error(`  ✗ ${m}`); } }

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-07-16T00:00:00Z');

// cadence: first snapshot ~1wk after delivery
assert(!isSnapshotDue(now - 3 * DAY, null, now), 'not due 3 days after delivery');
assert(isSnapshotDue(now - 8 * DAY, null, now), 'due 8 days after delivery (first)');
// then monthly
assert(!isSnapshotDue(now - 60 * DAY, now - 10 * DAY, now), 'not due 10 days after last snapshot');
assert(isSnapshotDue(now - 60 * DAY, now - 31 * DAY, now), 'due 31 days after last snapshot (monthly)');

// url normalize
assert(normalizeUrl('https://www.tiktok.com/@x/video/123/?utm=a') === 'tiktok.com/@x/video/123', 'normalize strips proto/www/query/slash');
assert(normalizeUrl(null) === '', 'normalize null → empty');

// post matching
const posts = [
  { webVideoUrl: 'https://www.tiktok.com/@creator/video/7777', playCount: 50000, diggCount: 4000, commentCount: 120, shareCount: 60 },
  { webVideoUrl: 'https://www.tiktok.com/@creator/video/8888', playCount: 10 },
];
const m = matchPostMetrics(posts, 'https://tiktok.com/@creator/video/7777?x=1');
assert(m?.views === 50000 && m?.likes === 4000 && m?.comments === 120 && m?.shares === 60, `matched metrics (got ${JSON.stringify(m)})`);
assert(matchPostMetrics(posts, 'https://tiktok.com/@creator/video/9999') === null, 'no match → null');
assert(matchPostMetrics([], 'x') === null, 'empty posts → null');

// ── give-up policy: a post_url that never resolves must stop costing money ──
// Regression: 5 deliveries whose post_url pointed at fabricated sample handles
// could never match, so nothing was written, isSnapshotDue stayed true, and the
// same rows were re-scraped every hour forever (paid Apify
// credit). The first attempt is free; every later one has to earn its place.
const HOUR = 60 * 60 * 1000;

assert(resolveAttemptDue(0, null, now) === 'scrape', 'never attempted → scrape');
assert(resolveAttemptDue(0, now - HOUR, now) === 'scrape', 'zero attempts → scrape regardless of stamp');
assert(resolveAttemptDue(1, null, now) === 'scrape', 'attempts but no stamp → scrape (cannot compute a wait)');

// Backoff doubles: 2h after the 1st miss, 4h after the 2nd, 8h after the 3rd.
assert(resolveAttemptDue(1, now - 1 * HOUR, now) === 'wait', '1 miss, 1h ago → wait (2h backoff)');
assert(resolveAttemptDue(1, now - 2 * HOUR, now) === 'scrape', '1 miss, 2h ago → scrape');
assert(resolveAttemptDue(2, now - 3 * HOUR, now) === 'wait', '2 misses, 3h ago → wait (4h backoff)');
assert(resolveAttemptDue(2, now - 4 * HOUR, now) === 'scrape', '2 misses, 4h ago → scrape');
assert(resolveAttemptDue(3, now - 7 * HOUR, now) === 'wait', '3 misses, 7h ago → wait (8h backoff)');
assert(resolveAttemptDue(5, now - 31 * HOUR, now) === 'wait', '5 misses, 31h ago → wait (32h backoff)');

// The hard stop. This is the line that makes the leak finite.
assert(
  resolveAttemptDue(MAX_RESOLVE_ATTEMPTS, now - 365 * DAY, now) === 'give_up',
  'at the attempt ceiling → give_up, however long ago the last try was',
);
assert(
  resolveAttemptDue(MAX_RESOLVE_ATTEMPTS + 4, now - 365 * DAY, now) === 'give_up',
  'past the ceiling → still give_up',
);
assert(MAX_RESOLVE_ATTEMPTS > 0 && MAX_RESOLVE_ATTEMPTS <= 10, 'attempt ceiling is a small finite number');

// Total spend for one unresolvable row is bounded, which is the whole point.
{
  let attempts = 0;
  let last: number | null = null;
  let clock = now;
  let scrapes = 0;
  // Simulate the hourly tick for a full year against a row that never matches.
  for (let h = 0; h < 24 * 365; h++) {
    const d = resolveAttemptDue(attempts, last, clock);
    if (d === 'give_up') break;
    if (d === 'scrape') {
      scrapes++;
      attempts++;
      last = clock;
    }
    clock += HOUR;
  }
  assert(
    scrapes === MAX_RESOLVE_ATTEMPTS,
    `one unresolvable row costs exactly ${MAX_RESOLVE_ATTEMPTS} scrapes, ever (got ${scrapes})`,
  );
}

// ── Delivery audit trail through runMeasurementTick ────────────────────────
//
// Every deal_deliveries status flip (→pending, →verified, →missing) now writes
// one audit_log row. Before this the table produced none at all, so
// statuses.ts had to synthesize `delivery.*` timeline events out of the row's
// CURRENT status — which can answer "what is it now" and never "when did it
// flip, and why".
//
// The property under test is therefore not "a row was written", it is "a row
// was written ONCE, at the flip". This tick runs hourly against the same rows
// forever; a transition audit that re-fires every pass turns the trail into
// noise and makes "when did this actually flip" unanswerable — strictly worse
// than no trail, because it still looks authoritative.
//
// Hermetic: in-memory Supabase (same shape as tests/attribution.test.ts, kept
// local so no other test file is touched), with scrape / recordCall / auditFn
// all injected. No network, no real audit(), no wall clock in any assertion.

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
interface Filter {
  kind: 'eq' | 'notnull' | 'notin' | 'in';
  col: string;
  val?: unknown;
}
interface ExecResult {
  data: unknown;
  error: { message: string } | null;
}

let rowSeq = 0;

class MemQuery implements PromiseLike<ExecResult> {
  private filters: Filter[] = [];
  private op: 'select' | 'insert' | 'update' = 'select';
  private payload: Row | Row[] | null = null;
  private orderBy?: { col: string; asc: boolean };
  private limitN?: number;

  constructor(
    private tables: Tables,
    private table: string,
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
  /** Added for the campaign-window lookup, which scopes its
   *  campaigns/firms reads to the offers actually in hand via `.in()`. */
  in(col: string, val: unknown[]): this {
    this.filters.push({ kind: 'in', col, val });
    return this;
  }
  not(col: string, op: string, val: unknown): this {
    if (op === 'is' && val === null) this.filters.push({ kind: 'notnull', col });
    // PostgREST spells NOT IN as the literal string "(a,b,c)".
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
      if (f.kind === 'in') return (f.val as unknown[]).includes(row[f.col]);
      return !(f.val as unknown[]).includes(row[f.col]);
    });
  }

  private exec(): ExecResult {
    const rows = this.rows();
    if (this.op === 'insert') {
      const toInsert = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const inserted = toInsert.map((r) => {
        rowSeq += 1;
        const row: Row = { id: `${this.table}-${rowSeq}`, ...r };
        rows.push(row);
        return { ...row };
      });
      return { data: inserted, error: null };
    }
    if (this.op === 'update') {
      // Faithful to the `.eq('status','pending')` guard the tick relies on: a
      // row that no longer matches is simply not patched, and the call is a
      // silent no-op rather than an error. That no-op is exactly the case the
      // audit gate has to agree with.
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
  const sb = {
    from(table: string) {
      return new MemQuery(tables, table);
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
  };
}

const TICK_NOW = Date.parse('2026-09-14T00:00:00.000Z');
const isoAt = (ms: number) => new Date(ms).toISOString();
const AUDIT_POST_URL = 'https://www.tiktok.com/@auditcreator/video/7001';
const FOUND_POST = {
  webVideoUrl: AUDIT_POST_URL,
  playCount: 4200,
  diggCount: 300,
  commentCount: 20,
  shareCount: 5,
};

type AuditStore = ReturnType<typeof makeStore>;

/** One posted offer whose post is 8 days old, so a snapshot is due. */
function seedAuditOffer(store: AuditStore, deliveryStatus?: string | null) {
  store.seed('campaigns', { id: 'camp-audit', firm_id: 'firm-audit', synthetic: false });
  store.seed('creator_offers', {
    id: 'offer-audit',
    firm_id: 'firm-audit',
    campaign_id: 'camp-audit',
    campaign_influencer_id: 'ci-audit',
    post_url: AUDIT_POST_URL,
    posted_at: isoAt(TICK_NOW - 8 * DAY),
    agreed_deliverables: null,
  });
  store.seed('campaign_influencers', { id: 'ci-audit', influencer_id: 'inf-audit' });
  store.seed('influencers', { id: 'inf-audit', username: 'auditcreator' });
  if (deliveryStatus !== undefined) {
    store.seed('deal_deliveries', {
      id: 'del-audit',
      creator_offer_id: 'offer-audit',
      firm_id: 'firm-audit',
      post_url: AUDIT_POST_URL,
      status: deliveryStatus,
      detected_at: isoAt(TICK_NOW - 8 * DAY),
    });
  }
}

/** Seed `n` unmatched measurement scrapes, so the give-up ceiling is reached. */
function seedResolveMisses(store: AuditStore, n: number) {
  for (let i = 0; i < n; i++) {
    store.seed('api_ledger', {
      source: 'apify',
      endpoint: MEASUREMENT_ENDPOINT,
      created_at: isoAt(TICK_NOW - (n - i) * DAY),
      request_meta: { creator_offer_id: 'offer-audit', matched: false },
    });
  }
}

/** Drive one tick, collecting audit rows the way attribution.test.ts collects
 *  ledger rows. Artist polling off; every external writer injected. */
async function tickWithAudit(
  store: AuditStore,
  opts: {
    now?: number;
    found?: boolean;
    auditFn?: (e: AuditEntry) => Promise<void>;
  } = {},
) {
  const audits: AuditEntry[] = [];
  const ledger: LedgerEntry[] = [];
  const tally = await runMeasurementTick(store.sb, {
    expireUndelivered: false,
    now: opts.now ?? TICK_NOW,
    soundchartsEnabled: false,
    scrape: async () => ({
      profiles: opts.found === false ? [] : [FOUND_POST],
      costUsd: 0.004,
      runId: 'run-audit',
    }),
    recordCall: async (e) => {
      ledger.push(e);
    },
    auditFn:
      opts.auditFn ??
      (async (e) => {
        audits.push(e);
      }),
  });
  return { tally, audits, ledger };
}

const forDelivery = (audits: AuditEntry[], id: string) =>
  audits.filter((a) => a.target_id === id);

// delivery.pending — written when the row is CREATED, and only then.
async function auditPendingOnCreateOnly() {
  const store = makeStore();
  seedAuditOffer(store); // no deal_deliveries row yet
  const first = await tickWithAudit(store, { found: false });

  const deliveryId = String(store.all('deal_deliveries')[0]?.id ?? '');
  assert(deliveryId !== '', 'audit: the tick created the delivery row it audits');
  assert(
    first.audits.length === 1,
    `audit: a newly created delivery writes exactly one transition row (got ${first.audits.length})`,
  );
  const pending = first.audits[0];
  assert(pending?.action === 'delivery.pending', `audit: action is delivery.pending (got ${pending?.action})`);
  assert(
    pending?.actor_label === 'system:measurement-tick',
    `audit: delivery.pending is attributed to system:measurement-tick (got ${pending?.actor_label})`,
  );
  assert(
    pending?.target_type === 'deal_delivery',
    `audit: delivery.pending targets deal_delivery (got ${pending?.target_type})`,
  );
  assert(pending?.target_id === deliveryId, 'audit: delivery.pending carries the delivery id as target_id');
  assert(pending?.firm_id === 'firm-audit', `audit: delivery.pending is firm-scoped (got ${pending?.firm_id})`);
  assert(
    pending?.metadata?.creator_offer_id === 'offer-audit',
    'audit: delivery.pending metadata names the creator_offer it came from',
  );
  assert(
    pending?.metadata?.post_url === AUDIT_POST_URL,
    'audit: delivery.pending metadata carries the claimed post_url',
  );

  // The `created` flag exists for exactly this: the next hourly tick finds the
  // same row already pending and must not invent a second "it became pending".
  const second = await tickWithAudit(store, { found: false, now: TICK_NOW + HOUR });
  assert(
    second.audits.length === 0,
    `audit: a re-run over an existing pending delivery writes no second delivery.pending (got ${second.audits.length})`,
  );
  assert(
    store.all('deal_deliveries').length === 1,
    'audit: the re-run reused the delivery row rather than creating another',
  );
}

// delivery.verified — written when the scrape actually finds the post.
async function auditVerifiedOnFlip() {
  const store = makeStore();
  seedAuditOffer(store);
  const { tally, audits } = await tickWithAudit(store);

  const deliveryId = String(store.all('deal_deliveries')[0]?.id ?? '');
  assert(tally.verified === 1, `audit: the post was found, so the tick verified it (got ${tally.verified})`);
  assert(
    audits.map((a) => a.action).join(',') === 'delivery.pending,delivery.verified',
    `audit: a create-then-verify tick writes both transitions in order (got ${audits.map((a) => a.action).join(',')})`,
  );
  const verified = audits[1];
  assert(
    verified?.actor_label === 'system:measurement-tick',
    `audit: delivery.verified is attributed to system:measurement-tick (got ${verified?.actor_label})`,
  );
  assert(
    verified?.target_type === 'deal_delivery',
    `audit: delivery.verified targets deal_delivery (got ${verified?.target_type})`,
  );
  assert(verified?.target_id === deliveryId, 'audit: delivery.verified carries the delivery id as target_id');
  assert(verified?.firm_id === 'firm-audit', `audit: delivery.verified is firm-scoped (got ${verified?.firm_id})`);
  assert(
    verified?.metadata?.creator_offer_id === 'offer-audit',
    'audit: delivery.verified metadata names the creator_offer it verified',
  );
  assert(
    verified?.metadata?.post_url === AUDIT_POST_URL,
    'audit: delivery.verified metadata carries the post_url that was matched',
  );
  assert(
    forDelivery(audits, deliveryId).length === 2,
    'audit: both rows point at the same delivery — one trail, not two',
  );
  assert(
    store.all('deal_deliveries')[0]?.status === 'verified',
    `audit: the audited flip matches the row it describes (got ${store.all('deal_deliveries')[0]?.status})`,
  );
}

// THE IDEMPOTENCE PROPERTY, verified branch: an already-'verified' delivery is
// re-scraped monthly forever (that is the snapshot cadence, by design). Every
// one of those passes re-runs the same UPDATE ... .eq('status','pending'),
// which no-ops. The audit gate mirrors that guard, so a delivery flips to
// verified in the trail exactly once, on the hour it actually flipped.
async function auditVerifiedNeverRepeats() {
  const store = makeStore();
  seedAuditOffer(store);
  const first = await tickWithAudit(store);
  const deliveryId = String(store.all('deal_deliveries')[0]?.id ?? '');
  assert(
    forDelivery(first.audits, deliveryId).some((a) => a.action === 'delivery.verified'),
    'audit: the first tick is the one that records the verified flip',
  );

  // 31 days on: the monthly snapshot is due again, so the tick goes all the way
  // back through scrape → match → update → audit gate. A zero here means the
  // gate declined, NOT that the tick short-circuited early — the snapshot
  // assertion below is what proves the work still happened.
  const second = await tickWithAudit(store, { now: TICK_NOW + 31 * DAY });
  assert(
    second.tally.scraped === 1,
    `idempotence: the later tick really did re-scrape the verified delivery (got ${second.tally.scraped})`,
  );
  assert(
    store.all('deal_performance_snapshots').length === 2,
    `idempotence: the later tick still wrote its performance snapshot (got ${store.all('deal_performance_snapshots').length})`,
  );
  assert(
    second.audits.length === 0,
    `idempotence: an already-verified delivery emits NO second transition audit on a later tick (got ${second.audits.length})`,
  );
  assert(
    store.all('deal_deliveries')[0]?.status === 'verified',
    'idempotence: the delivery is still verified — the trail is silent because nothing changed',
  );
}

// delivery.missing — written when a pending delivery becomes unresolvable.
async function auditMissingOnGiveUp() {
  const store = makeStore();
  seedAuditOffer(store, 'pending'); // row already exists and is pending
  seedResolveMisses(store, MAX_RESOLVE_ATTEMPTS);

  const { tally, audits } = await tickWithAudit(store, {
    found: false,
    now: TICK_NOW + 365 * DAY,
  });
  assert(tally.unresolvable === 1, `audit: the delivery hit the attempt ceiling (got ${tally.unresolvable})`);
  assert(
    store.all('deal_deliveries')[0]?.status === 'missing',
    `audit: the delivery row was flipped to missing (got ${store.all('deal_deliveries')[0]?.status})`,
  );
  assert(
    audits.length === 1,
    `audit: giving up on an existing pending delivery writes exactly one row (got ${audits.length})`,
  );
  const missing = audits[0];
  assert(missing?.action === 'delivery.missing', `audit: action is delivery.missing (got ${missing?.action})`);
  assert(
    missing?.actor_label === 'system:measurement-tick',
    `audit: delivery.missing is attributed to system:measurement-tick (got ${missing?.actor_label})`,
  );
  assert(
    missing?.target_type === 'deal_delivery',
    `audit: delivery.missing targets deal_delivery (got ${missing?.target_type})`,
  );
  assert(missing?.target_id === 'del-audit', 'audit: delivery.missing carries the delivery id as target_id');
  assert(missing?.firm_id === 'firm-audit', `audit: delivery.missing is firm-scoped (got ${missing?.firm_id})`);
  assert(
    missing?.metadata?.creator_offer_id === 'offer-audit',
    'audit: delivery.missing metadata names the creator_offer that never resolved',
  );
  assert(
    missing?.metadata?.resolve_attempts === MAX_RESOLVE_ATTEMPTS,
    `audit: delivery.missing records how many attempts it took to give up (got ${missing?.metadata?.resolve_attempts})`,
  );

  // THE IDEMPOTENCE PROPERTY, missing branch: 'missing' is terminal. The tick
  // sees it every hour for the life of the row and must stay silent.
  const later = await tickWithAudit(store, { found: false, now: TICK_NOW + 730 * DAY });
  assert(
    later.audits.length === 0,
    `idempotence: an already-missing delivery emits NO second transition audit on a later tick (got ${later.audits.length})`,
  );
  assert(
    later.tally.unresolvable === 0,
    'idempotence: a terminal delivery is not re-counted as newly unresolvable either',
  );
}

// An audit write that never happens must not fabricate a transition either:
// the gate is the row's prior status, so a delivery that was never pending
// (someone else already verified it) produces no row at all.
async function auditNeverFabricatesOnNoOpUpdate() {
  const store = makeStore();
  seedAuditOffer(store, 'verified'); // pre-existing, already verified elsewhere
  const { audits, tally } = await tickWithAudit(store);
  assert(
    tally.scraped === 1,
    `audit: the tick did reach the update for a pre-verified delivery (got ${tally.scraped})`,
  );
  assert(
    audits.length === 0,
    `audit: a no-op status UPDATE writes no transition row (got ${audits.length})`,
  );
}

// Write-then-don't-throw has to hold for the INJECTED writer too, not just the
// default one. It briefly did not: the guard lived inside the default writer,
// so a caller-supplied auditFn that rejected propagated into the per-offer try
// and the whole offer was counted `skipped`. The expensive case was a throw on
// the `verified` transition — that runs after the Apify scrape is already paid
// for and ledgered, so the failure discarded a result we had bought, and since
// the row was now `verified` the audit gate suppressed it forever while the
// next tick paid for the scrape again. The guard now sits on the call site, so
// a broken trail costs the trail and nothing else. These assertions pin that.
async function auditWriterThatThrowsDoesNotKillTheTick() {
  const boom = async () => {
    throw new Error('audit_log unreachable');
  };

  // Case 1: throw at the delivery.pending call site (measurement-tick.ts:243).
  const created = makeStore();
  seedAuditOffer(created);
  let threw = false;
  let firstTally: Awaited<ReturnType<typeof tickWithAudit>>['tally'] | null = null;
  try {
    firstTally = (await tickWithAudit(created, { auditFn: boom })).tally;
  } catch {
    threw = true;
  }
  assert(!threw, 'throwing audit: runMeasurementTick still completes — the tick never propagates an audit failure');
  assert(firstTally != null, 'throwing audit: the tick still returns a tally');
  assert(
    firstTally?.skipped === 0,
    `throwing audit: the offer is NOT skipped — a dead audit_log must not cost a measurement (got skipped=${firstTally?.skipped})`,
  );
  assert(
    firstTally?.scraped === 1 && firstTally?.snapshots === 1,
    `throwing audit: the offer is still scraped and snapshotted despite the failed delivery.pending write (got scraped=${firstTally?.scraped}, snapshots=${firstTally?.snapshots})`,
  );

  // Case 2: throw at the delivery.verified call site (measurement-tick.ts:371),
  // which runs AFTER the status UPDATE and after the scrape has been paid for.
  const pending = makeStore();
  seedAuditOffer(pending, 'pending');
  let threw2 = false;
  let second: Awaited<ReturnType<typeof tickWithAudit>> | null = null;
  try {
    second = await tickWithAudit(pending, { auditFn: boom });
  } catch {
    threw2 = true;
  }
  assert(!threw2, 'throwing audit: a failure on the verified transition also never escapes the tick');
  assert(
    pending.all('deal_deliveries')[0]?.status === 'verified',
    `throwing audit: the status UPDATE landed before the audit write (got ${pending.all('deal_deliveries')[0]?.status})`,
  );
  assert(
    second?.ledger.length === 1 && second?.tally.costUsd === 0.004,
    'throwing audit: the scrape was made and booked — that spend is real',
  );
  assert(
    second?.tally.verified === 1 && pending.all('deal_performance_snapshots').length === 1,
    `throwing audit: the paid-for scrape is still counted and snapshotted — the spend is never wasted on a trail failure (got verified=${second?.tally.verified}, snapshots=${pending.all('deal_performance_snapshots').length})`,
  );
}


// ── Campaign window — gates the REFRESH, never the RESOLUTION ───
//
// A review caught that the first version of the window gate excluded
// window-closed campaigns from the offers query entirely, which made
// `deal_deliveries.status = 'missing'` unreachable: its only writer lives
// inside that loop. A creator who took payment and never posted would read as
// "still pending" forever, and `missing` — the only honest non-delivery
// signal the CPM ranking has — would stay permanently 0.
//
// These two tests pin the corrected split.

/** A campaign whose measurement window is long closed (release + 14d + 30d tail). */
function seedWindowClosedCampaign(store: AuditStore) {
  store.seed('firms', { id: 'firm-audit', outreach_prefs: {} });
  const camp = store.all('campaigns').find((c) => c.id === 'camp-audit');
  if (camp) {
    // Created after the enforcement epoch and inside its own window, so the
    // window is genuinely ENFORCED rather than grandfathered away.
    camp.release_date = '2026-09-20';
    camp.created_at = '2026-09-19T00:00:00.000Z';
  }
}

// A PENDING delivery on a window-closed campaign must still terminalize.
async function windowClosedStillTerminalizesPending() {
  const store = makeStore();
  seedAuditOffer(store, 'pending');
  seedWindowClosedCampaign(store);
  seedResolveMisses(store, MAX_RESOLVE_ATTEMPTS);

  // Far past release + 14d + 30d, so measurement is definitively closed.
  const { tally } = await tickWithAudit(store, {
    found: false,
    now: Date.parse('2027-06-01T00:00:00.000Z'),
  });

  assert(
    store.all('deal_deliveries')[0]?.status === 'missing',
    `window: a pending delivery on a window-CLOSED campaign still reaches 'missing' (got ${store.all('deal_deliveries')[0]?.status})`,
  );
  assert(
    tally.unresolvable === 1,
    `window: and it is counted as unresolvable exactly once (got ${tally.unresolvable})`,
  );
}

// An ALREADY-VERIFIED delivery on a window-closed campaign stops being
// re-scraped. This is the unbounded cost the window exists to stop: without
// it, isSnapshotDue says "monthly" forever and a campaign from last year keeps
// spending Apify credit permanently.
async function windowClosedStopsRefreshingVerified() {
  const store = makeStore();
  seedAuditOffer(store, 'verified');
  seedWindowClosedCampaign(store);

  const { tally } = await tickWithAudit(store, {
    now: Date.parse('2027-06-01T00:00:00.000Z'),
  });
  assert(
    tally.scraped === 0,
    `window: a verified delivery on a closed campaign is NOT re-scraped (got scraped=${tally.scraped})`,
  );
  assert(
    tally.costUsd === 0,
    `window: so it costs nothing (got ${tally.costUsd})`,
  );

  // Control: the identical fixture with no release_date IS still refreshed,
  // proving the skip above came from the window and not from some other guard.
  const open = makeStore();
  seedAuditOffer(open, 'verified');
  const openTally = (
    await tickWithAudit(open, { now: Date.parse('2027-06-01T00:00:00.000Z') })
  ).tally;
  assert(
    openTally.scraped === 1,
    `window CONTROL: an ungated campaign with the same fixture IS re-scraped (got ${openTally.scraped})`,
  );
}

async function main() {
  await auditPendingOnCreateOnly();
  await auditVerifiedOnFlip();
  await auditVerifiedNeverRepeats();
  await auditMissingOnGiveUp();
  await windowClosedStillTerminalizesPending();
  await windowClosedStopsRefreshingVerified();
  await auditNeverFabricatesOnNoOpUpdate();
  await auditWriterThatThrowsDoesNotKillTheTick();

  console.log(`measurement test: ${passed} passed, ${failed} failed`);
  if (fails.length) console.error('Failures:\n  - ' + fails.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
