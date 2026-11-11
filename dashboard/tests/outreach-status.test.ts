// tests/outreach-status.test.ts
//
// campaign_influencers.outreach_status is the spine of the /outreach screen:
// the draft pool, all seven tabs and the stat counters read it. Three live
// surfaces read it and, until this change, two of the transitions were never
// written by anything. What that produced:
//
//   1. "Generate All Drafts" queried `.in('outreach_status', ['pending'])`.
//      Discovery (api/campaigns/[id]/run/route.ts:740-760) never writes the
//      column at all — it relies entirely on the DB default. A drifted
//      database can default to 'pending', but the repo's own base schema
//      (supabase/migrations/003_base_schema.sql) says 'none'. So the pool query was pinned to one of the two defaults the
//      project actually has, and silently returned 0 on any database built from
//      the checked-in schema.
//   2. NOTHING wrote 'sent'. Both send paths — api/outreach/[id]/send (email)
//      and lib/channel-priors.markHumanQueueSent (DM queue) — advanced the
//      OTHER column (`status` -> 'contacted') and left outreach_status on
//      'draft_ready'. The Sent tab was therefore permanently empty and the
//      log-response box, gated on 'sent', never appeared.
//   3. The "No Message" tab sent status=pending to /api/outreach/list, which
//      did `.eq('outreach_status', 'pending')` — one value, for a state that
//      has four legal spellings ('pending', 'none', '', NULL).
//
// The fix is one vocabulary, in one module, shared by every reader and writer.
// These tests pin it. The centrepiece is "a freshly discovered creator is in
// the draft pool" — asserted against BOTH real column defaults, so it fails on
// whichever database the next person points this at.
//
// Hermetic: no network, no DB, no model. The fake query builder records the
// filter calls AND applies them to in-memory rows, so a pool assertion is a
// real row-matching proof rather than a string comparison.
//
// Run: npx tsx tests/outreach-status.test.ts

// MUST be the first import: rate-limit.ts and outreach.ts both pull in
// supabase.ts, which constructs a client at module-evaluation time and throws
// on missing env. setup-env sets a dummy UNREACHABLE env and stubs fetch, so
// this suite cannot touch a network or a database even by accident.
import './negotiation-harness/setup-env';

import {
  DRAFT_POOL_STATUSES,
  NO_MESSAGE_YET_OR_FILTER,
  NO_MESSAGE_YET_VALUES,
  OUTREACH_STATUS_VALUES,
  applyOutreachStatusTabFilter,
  isNoMessageYet,
  outreachStatusValuesForTab,
} from '../src/lib/outreach-status';
import {
  SEND_RATE_LIMIT_PER_WINDOW,
  SEND_RATE_WINDOW_MS,
  classifySendResponse,
  describeSendPace,
  emptyTally,
  planSendSchedule,
  summarizeSendTally,
  tallyOutcome,
} from '../src/lib/outreach-send-copy';
import { TIER_CONFIG } from '../src/lib/rate-limit';
import { draftPoolFilter, eligibleDraftFilter } from '../src/lib/outreach';

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

// ── Fake PostgREST query builder ────────────────────────────────────────────
//
// Records every filter, and can replay them against in-memory rows. Only the
// operators these routes actually use are implemented; anything else throws
// rather than silently matching, so a future filter can't sneak past the test.

type Filter =
  | { kind: 'eq'; col: string; val: unknown }
  | { kind: 'neq'; col: string; val: unknown }
  | { kind: 'in'; col: string; vals: unknown[] }
  | { kind: 'or'; clause: string };

interface Recorder {
  filters: Filter[];
  select: (s?: string) => Recorder;
  eq: (col: string, val: unknown) => Recorder;
  neq: (col: string, val: unknown) => Recorder;
  in: (col: string, vals: unknown[]) => Recorder;
  or: (clause: string) => Recorder;
}

function recorder(): Recorder {
  const r: Recorder = {
    filters: [],
    select: () => r,
    eq: (col, val) => {
      r.filters.push({ kind: 'eq', col, val });
      return r;
    },
    neq: (col, val) => {
      r.filters.push({ kind: 'neq', col, val });
      return r;
    },
    in: (col, vals) => {
      r.filters.push({ kind: 'in', col, vals });
      return r;
    },
    or: (clause) => {
      r.filters.push({ kind: 'or', clause });
      return r;
    },
  };
  return r;
}

type Row = Record<string, unknown>;

/**
 * Parse one `col.op.value` term of a PostgREST `or=(...)` logic tree. Mirrors
 * PostgREST semantics for the two operators the filter uses: `is.null` and
 * `in.(...)` with double-quoted members (including the empty string).
 */
function matchesOrTerm(row: Row, term: string): boolean {
  const isNull = /^([a-z_]+)\.is\.null$/.exec(term.trim());
  if (isNull) return row[isNull[1]] === null || row[isNull[1]] === undefined;

  const inList = /^([a-z_]+)\.in\.\((.*)\)$/.exec(term.trim());
  if (inList) {
    const col = inList[1];
    const members = inList[2]
      .split(',')
      .map((m) => m.trim().replace(/^"(.*)"$/, '$1'));
    return members.includes(String(row[col] ?? '\u0000no-value\u0000'));
  }
  throw new Error(`fake builder cannot evaluate PostgREST term: ${term}`);
}

/**
 * Split an or=(...) clause on top-level commas. `in.(a,b)` contains commas, so
 * a naive split is wrong — track parenthesis depth.
 */
function splitOrClause(clause: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of clause) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function rowMatches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.kind === 'eq') return row[f.col] === f.val;
    if (f.kind === 'neq') return row[f.col] !== f.val;
    if (f.kind === 'in') return f.vals.includes(row[f.col]);
    return splitOrClause(f.clause).some((term) => matchesOrTerm(row, term));
  });
}

/**
 * The campaign_influencers row discovery actually writes.
 *
 * Copied field-for-field from the upsert payload in
 * src/app/api/campaigns/[id]/run/route.ts:743-757. The point of building it
 * this way is that `outreach_status` is ABSENT — discovery never sets it — so
 * the row's value comes purely from the column default, exactly like production.
 */
function freshlyDiscoveredRow(columnDefault: string | null): Row {
  const written: Row = {
    campaign_id: 'camp-1',
    influencer_id: 'inf-1',
    composite_score: 82,
    tier: 'mid',
    price_estimate_low: 100,
    price_estimate_mid: 200,
    price_estimate_high: 300,
    outreach_priority: 'standard',
    outreach_angle: 'indie-folk crossover',
    bot_flagged: false,
    primary_channel: 'email',
    channel_confidence: 0.85,
    status: 'queued',
  };
  // Columns discovery omits are filled by the DB, not the app.
  return {
    ...written,
    outreach_status: columnDefault,
    qualification_status: 'unreviewed',
  };
}

// The two column defaults a database can have. A drifted database
// reports 'pending'::text; the checked-in base schema
// (supabase/migrations/003_base_schema.sql) says 'none'. A creator discovered against
// either database must land in the draft pool.
const REAL_COLUMN_DEFAULTS: Array<[string, string | null]> = [
  ['drifted database default', 'pending'],
  ['003_base_schema.sql default', 'none'],
  ['pre-default legacy row', null],
];

function main() {
  // ══ 1. CENTREPIECE ════════════════════════════════════════════════════════
  // A freshly discovered creator is in the draft pool.

  for (const [label, columnDefault] of REAL_COLUMN_DEFAULTS) {
    const row = freshlyDiscoveredRow(columnDefault);

    assert(
      isNoMessageYet(row.outreach_status as string | null),
      `[${label}] a freshly discovered creator counts as "no message yet"`,
    );

    // draftPoolFilter is the exact function /api/outreach/generate-bulk calls
    // — not a reconstruction of it — so reverting the route fails this test.
    const q = draftPoolFilter(
      recorder().select('id, tier, outreach_status'),
    ) as unknown as Recorder;

    assert(
      rowMatches(row, q.filters),
      `[${label}] a freshly discovered creator IS returned by the Generate All Drafts pool query`,
    );
  }

  // The bug that was there: pinning the pool to a single spelling drops two of
  // the three real defaults. This asserts the OLD query was wrong, so nobody
  // "simplifies" it back.
  const oldPool: Filter[] = [{ kind: 'in', col: 'outreach_status', vals: ['pending'] }];
  assert(
    !rowMatches(freshlyDiscoveredRow('none'), oldPool),
    'regression pin: .in(outreach_status,["pending"]) misses a creator discovered against the checked-in schema default',
  );
  assert(
    !rowMatches(freshlyDiscoveredRow(null), oldPool),
    'regression pin: .in(outreach_status,["pending"]) misses a legacy NULL row',
  );

  // ══ 2. The pool excludes creators that already have a message ═════════════

  for (const done of ['draft_ready', 'sent', 'responded', 'negotiating', 'rejected', 'deal_closed']) {
    const q = draftPoolFilter(recorder().select('id')) as unknown as Recorder;
    const row = { ...freshlyDiscoveredRow('pending'), outreach_status: done };
    assert(
      !rowMatches(row, q.filters),
      `the draft pool does not re-draft a creator already at '${done}'`,
    );
  }

  // ══ 3. The draft-pool guarantees survive the pool change ════════════════════════

  {
    const q = draftPoolFilter(recorder().select('id')) as unknown as Recorder;

    const excluded = { ...freshlyDiscoveredRow('pending'), qualification_status: 'excluded' };
    assert(
      !rowMatches(excluded, q.filters),
      'preserved: a qualification_status=excluded creator stays out of the pool',
    );

    const bot = { ...freshlyDiscoveredRow('pending'), bot_flagged: true };
    assert(
      !rowMatches(bot, q.filters),
      'preserved: a bot_flagged creator stays out of the pool',
    );

    const unreviewed = freshlyDiscoveredRow('pending');
    assert(
      rowMatches(unreviewed, q.filters),
      'preserved: an unreviewed creator is still in the pool (qualified on demand)',
    );
  }

  {
    // The pool must still BE the eligibility gate plus the status filter — if
    // someone drops eligibleDraftFilter from draftPoolFilter, the guarantees in
    // section 3 would still pass against a hand-built query but not this.
    const pool = draftPoolFilter(recorder()) as unknown as Recorder;
    const gate = eligibleDraftFilter(recorder()) as unknown as Recorder;
    assert(
      gate.filters.every((g) =>
        pool.filters.some(
          (p) => p.kind === g.kind && JSON.stringify(p) === JSON.stringify(g),
        ),
      ),
      'the draft pool still applies every filter eligibleDraftFilter applies',
    );
    assert(
      pool.filters.some((f) => f.kind === 'or'),
      'the draft pool applies the no-message-yet or-filter',
    );
  }

  // ══ 4. The or-filter is a PostgREST clause that actually parses ═══════════
  //
  // Against PostgREST this exact
  // clause returns HTTP 200, while a malformed one returns 400 (PGRST100) and
  // an unknown column returns 400 (42703). Pinning the literal here means a
  // future edit that breaks the syntax fails locally, not in front of a label.

  assert(
    NO_MESSAGE_YET_OR_FILTER ===
      'outreach_status.is.null,outreach_status.in.("pending","none","")',
    'the no-message-yet clause is the exact string verified against live PostgREST',
  );
  assert(
    NO_MESSAGE_YET_VALUES.every((v) => isNoMessageYet(v)),
    'every declared no-message-yet value passes isNoMessageYet',
  );
  assert(
    isNoMessageYet(null) && isNoMessageYet(undefined) && isNoMessageYet(''),
    'null, undefined and empty string all count as "no message yet"',
  );
  assert(
    !isNoMessageYet('draft_ready') && !isNoMessageYet('sent'),
    'a creator with a draft or a send is not "no message yet"',
  );

  // ══ 5. Tab -> DB value mapping (the .eq bug) ══════════════════════════════

  {
    const pendingValues = outreachStatusValuesForTab('pending');
    assert(
      pendingValues !== null &&
        ['pending', 'none', ''].every((v) => pendingValues.includes(v)),
      'the "No Message" tab covers every spelling of the no-message-yet state',
    );

    // Server-side filtering must agree with the page's own client-side count,
    // which treats negotiating as part of Responded (page.tsx:796).
    const respondedValues = outreachStatusValuesForTab('responded');
    assert(
      respondedValues !== null &&
        respondedValues.includes('responded') &&
        respondedValues.includes('negotiating'),
      'the "Responded" tab covers both responded and negotiating, matching the tab badge count',
    );

    assert(
      outreachStatusValuesForTab('all') === null,
      'the "All" tab applies no outreach_status filter',
    );
    assert(
      outreachStatusValuesForTab('dm_queue') === null,
      'dm_queue is not an outreach_status and applies no server-side filter',
    );

    const sentValues = outreachStatusValuesForTab('sent');
    assert(
      sentValues !== null && sentValues.length === 1 && sentValues[0] === 'sent',
      'the "Sent" tab filters on exactly sent',
    );
  }

  {
    // The applied filter must round-trip: a row in the tab's state matches.
    const noMsg = applyOutreachStatusTabFilter(recorder(), 'pending') as unknown as Recorder;
    assert(
      rowMatches(freshlyDiscoveredRow('none'), noMsg.filters) &&
        rowMatches(freshlyDiscoveredRow('pending'), noMsg.filters) &&
        rowMatches(freshlyDiscoveredRow(null), noMsg.filters),
      'the No Message tab returns creators in all three real default states',
    );
    assert(
      !rowMatches({ outreach_status: 'sent' }, noMsg.filters),
      'the No Message tab does not return a creator who was already sent to',
    );

    const sentTab = applyOutreachStatusTabFilter(recorder(), 'sent') as unknown as Recorder;
    assert(
      rowMatches({ outreach_status: 'sent' }, sentTab.filters),
      'the Sent tab returns a creator whose outreach_status is sent',
    );

    const respondedTab = applyOutreachStatusTabFilter(recorder(), 'responded') as unknown as Recorder;
    assert(
      rowMatches({ outreach_status: 'responded' }, respondedTab.filters) &&
        rowMatches({ outreach_status: 'negotiating' }, respondedTab.filters),
      'the Responded tab returns both responded and negotiating creators',
    );

    const allTab = applyOutreachStatusTabFilter(recorder(), 'all') as unknown as Recorder;
    assert(
      allTab.filters.length === 0,
      'the All tab adds no filter at all',
    );
  }

  // ══ 6. The vocabulary is closed and the draft pool is part of it ══════════

  assert(
    OUTREACH_STATUS_VALUES.includes('sent'),
    "'sent' is a declared state — the Sent tab has something to show",
  );
  assert(
    DRAFT_POOL_STATUSES.includes('pending'),
    'the canonical draft-pool state is the canonical default',
  );
  for (const v of OUTREACH_STATUS_VALUES) {
    assert(
      typeof v === 'string' && v.length > 0,
      `declared outreach status '${v}' is a non-empty string`,
    );
  }

  // ══ 7. Send pacing ════════════════════════════════════════════
  //
  // /api/outreach/[id]/send is on the 'expensive' tier. The page used to fire
  // batches of 3 with no delay, so on a 5-per-minute tier drafts 6+ came back
  // 429 and were tallied as `failed` — a rate limit reported as an outage.

  assert(
    SEND_RATE_LIMIT_PER_WINDOW === TIER_CONFIG.expensive.limit,
    'the send pacer uses the real expensive-tier limit, not a guess',
  );
  assert(
    SEND_RATE_WINDOW_MS === TIER_CONFIG.expensive.windowMs,
    'the send pacer uses the real expensive-tier window, not a guess',
  );

  {
    // The exact case in the finding: "Send All Drafts (20)".
    const plan = planSendSchedule(20);
    assert(
      plan.batches.every((b) => b <= SEND_RATE_LIMIT_PER_WINDOW),
      'no scheduled batch exceeds the server rate limit',
    );
    assert(
      plan.batches.reduce((a, b) => a + b, 0) === 20,
      'the schedule sends all 20 drafts, not just the first window',
    );
    assert(
      plan.batches.length === 4,
      '20 drafts at 5 per window is 4 windows',
    );
    assert(
      plan.waitMsBetweenBatches >= SEND_RATE_WINDOW_MS,
      'the pacer waits at least one full window between batches',
    );
    assert(
      plan.estimatedMs >= 3 * SEND_RATE_WINDOW_MS,
      'the estimate accounts for the three waits between four batches',
    );

    const small = planSendSchedule(3);
    assert(
      small.batches.length === 1 && small.estimatedMs === 0,
      'a send that fits in one window has no wait at all',
    );

    assert(
      planSendSchedule(0).batches.length === 0,
      'an empty send schedules nothing',
    );
  }

  {
    // Operator-facing: the confirm dialog states the time cost up front.
    const pace = describeSendPace(20);
    assert(
      /\b4\b/.test(pace) && /minute/i.test(pace),
      `the confirm copy states how long 20 drafts will take (got: ${pace})`,
    );
    assert(
      describeSendPace(3) === '',
      'a send that fits in one window says nothing about pacing',
    );
  }

  // ══ 8. A throttle is a throttle, not a failure ════════════════════════════

  assert(
    classifySendResponse(429, { error: 'rate_limited' }) === 'rate_limited',
    'HTTP 429 is classified as rate_limited, never as failed',
  );
  assert(
    classifySendResponse(500, { error: 'boom' }) === 'failed',
    'a real 500 is still a failure',
  );
  assert(
    classifySendResponse(200, null) === 'sent',
    'a 2xx is still a send',
  );
  // The 409 separations must survive.
  assert(
    classifySendResponse(409, { error: 'dm_queue' }) === 'dm_queue' &&
      classifySendResponse(409, { error: 'stale_draft' }) === 'stale_draft' &&
      classifySendResponse(409, { error: 'already sent' }) === 'already_sent',
    'preserved: 409 still splits into dm_queue / stale_draft / already_sent',
  );

  {
    const tally = emptyTally();
    tallyOutcome(tally, 'sent');
    tallyOutcome(tally, 'sent');
    tallyOutcome(tally, 'rate_limited');
    const summary = summarizeSendTally(tally, 'testing');
    assert(
      /rate limit|throttl/i.test(summary.message),
      `a throttled send is named as a throttle (got: ${summary.message})`,
    );
    assert(
      !/\bfailed\b/.test(summary.message),
      `a throttled send is not reported as failed (got: ${summary.message})`,
    );
    assert(
      summary.level === 'warning',
      'a run with throttled sends is a warning, not a success',
    );
  }

  console.log(`\noutreach-status test: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main();
