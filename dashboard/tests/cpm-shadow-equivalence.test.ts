import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
//
// tests/cpm-shadow-equivalence.test.ts
//
// THE HARD RULE OF CPM SLICES S1 + S4:
// with firms.pricing_mode = 'formula' (the default), NOTHING a creator sees and
// NOTHING the negotiator decides may change. The shadow slices may only ADD
// data: creator_offers.pricing_basis, creator_offers.first_ask_usd and
// deal_cpm_records rows.
//
// How this proves it — three runs of the same representative flows:
//
//   GOLDEN  the trace the flows produced on the code BEFORE S1/S4 existed
//           (pinned in tests/fixtures/cpm-shadow/formula-golden.json; print a
//           fresh one with CPM_SHADOW_PRINT_GOLDEN=1).
//   PRE     today's code against a database where 061/062 are NOT applied: every
//           query naming a new column/table is refused the way PostgREST
//           refuses it (PGRST204 / PGRST205).
//   POST    today's code against a database where 061/062 ARE applied, the firm
//           is on pricing_mode='formula', the campaign carries a target/max CPM
//           and the creator has a real-shaped TikTok post history, so the
//           shadow path computes and stores a CPM price on every offer.
//
// All three traces must be byte-identical. The trace is everything a creator
// sees or the negotiator decided: every outbound body that left, the price
// recorded on each, the offer's status / opening / current / agreed / rounds /
// ceiling / opening_pct, each negotiation outcome, and every payment
// authorization amount. Shadow columns are deliberately excluded from the
// trace and asserted separately (they must appear in POST and only in POST).
//
// Flows: opener (openOfferForSentOutreach → createOffer → makeInitialOffer),
// counter, accept at the recorded sent price, a fold (second email lands while
// our counter is queued), and a creator decline.
//
// Hermetic: in-memory store, mock model provider, injected dispatch/clock/rng.
// Run: npx tsx tests/cpm-shadow-equivalence.test.ts
// Re-capture golden (only on the base commit, never to make a red run green):
//   CPM_SHADOW_PRINT_GOLDEN=1 npx tsx tests/cpm-shadow-equivalence.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { registerProvider } from '../src/lib/model-provider';
import { openOfferForSentOutreach } from '../src/lib/negotiation';
import {
  runNegotiationTick,
  runDispatchPass,
  COUNTER_OFFER_COLUMN,
  type DispatchFn,
} from '../src/lib/negotiation-tick';
import { makeStore, type Row } from './negotiation-harness/store';

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

const NOW0 = Date.parse('2026-07-06T00:00:00.000Z'); // inside the send window
const S = 1000;
const MIN = 60_000;
const DAY = 86_400_000;
const HALF = () => 0.5;
const noopPoll = async () => ({ skipped: 'gmail_not_configured' as const });

type Store = ReturnType<typeof makeStore>;
type Out = { intent: string; counter_usd?: number | null; terms?: unknown; confidence?: number };

let script: (user: string) => Out = () => ({ intent: 'unclear' });
registerProvider('mock', async ({ user }) =>
  JSON.stringify({ sentiment: 'neutral', confidence: 0.9, counter_usd: null, ...script(user) }),
);

// ── The two database shapes ─────────────────────────────────────────────────

type Mode = 'pre' | 'post';

/** Columns and tables that exist only once 061/062 are applied. */
const NEW_COLUMNS = ['pricing_basis', 'first_ask_usd', 'target_cpm_usd', 'max_cpm_usd', 'pricing_mode'];
const NEW_TABLES = ['deal_cpm_records'];

/**
 * A client that behaves like PostgREST against a database WITHOUT 061/062: any
 * query whose projection, payload or filter names a new column is refused with
 * PGRST204, and the new table with PGRST205 — nothing is written. Everything
 * else passes straight through to the in-memory store.
 */
function preMigrationClient(store: Store): SupabaseClient {
  return {
    from(table: string) {
      const target = store.sb.from(table) as unknown as Record<string | symbol, unknown>;
      let refusal: { code: string; message: string } | null = NEW_TABLES.includes(table)
        ? { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` }
        : null;
      const check = (s: unknown) => {
        if (typeof s !== 'string') return;
        for (const c of NEW_COLUMNS) {
          if (s.includes(c) && !refusal) {
            refusal = { code: 'PGRST204', message: `Could not find the '${c}' column of '${table}' in the schema cache` };
          }
        }
      };
      const proxy: unknown = new Proxy(target, {
        get(t, prop) {
          const v = t[prop];
          if (prop === 'then' || prop === 'single' || prop === 'maybeSingle') {
            if (refusal) {
              const err = refusal;
              if (prop === 'then') {
                return (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) =>
                  Promise.resolve({ data: null, error: err }).then(res, rej);
              }
              return () => Promise.resolve({ data: null, error: err });
            }
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
          }
          if (typeof v !== 'function') return v;
          return (...args: unknown[]) => {
            if (prop === 'select') check(args[0]);
            if (prop === 'insert' || prop === 'update' || prop === 'upsert') {
              const rows = Array.isArray(args[0]) ? args[0] : [args[0]];
              for (const r of rows) for (const k of Object.keys((r as Row) ?? {})) check(k);
            }
            if (['eq', 'neq', 'is', 'in', 'not', 'lte', 'lt', 'gte', 'order'].includes(String(prop))) check(args[0]);
            const r = (v as (...a: unknown[]) => unknown).apply(t, args);
            return r === t ? proxy : r;
          };
        },
      });
      return proxy;
    },
  } as unknown as SupabaseClient;
}

/** A TikTok post history shaped like the Apify payload stored in raw_data. */
function tiktokPosts(): Row[] {
  const plays = [12_000, 8_000, 15_000, 9_500, 11_000, 30_000, 7_000, 10_000];
  // All comfortably older than the 3-day freshness cut, in real time, so the
  // shadow estimate is deterministic whatever day the suite runs.
  const base = Date.parse('2026-06-01T00:00:00Z');
  return plays.map((p, i) => ({
    playCount: p,
    diggCount: Math.round(p / 10),
    commentCount: 12,
    createTime: Math.floor((base - i * 2 * DAY) / 1000),
    webVideoUrl: `https://www.tiktok.com/@creator/video/${1000 + i}`,
  }));
}

function seed(store: Store, mode: Mode, opts: { openerNamesPrice: boolean }) {
  store.seed('firms', {
    id: 'firm-1',
    name: 'Example Records',
    sender_name: null,
    outreach_prefs: {},
    // The engagement curve (pricing-engine.ts) tops out at 1.4x. The creator
    // sits above p90 (1.4x) and the firm carries a country premium of 1.0715,
    // so the opener is 100 × 1.4 × 1.0715 = $150 and every flow replays
    // byte-for-byte against the golden.
    scraping_prefs: { genre_premiums: { country: 1.0715 } },
    ...(mode === 'post' ? { pricing_mode: 'formula' } : {}),
  });
  store.seedCampaign('camp-1', null);
  const camp = store.all('campaigns').find((c) => c.id === 'camp-1') as Row;
  camp.firm_id = 'firm-1';
  camp.per_creator_cap_usd = 200;
  camp.genre = 'country';
  if (mode === 'post') {
    camp.target_cpm_usd = 8;
    camp.max_cpm_usd = 12;
  }
  store.seed('influencers', {
    id: 'inf-1',
    platform: 'tiktok',
    username: 'creator',
    blocklisted: false,
    follower_count: 25_000,
    engagement_rate: 0.2,
    raw_data: { posts: tiktokPosts() },
  });
  store.seed('campaign_influencers', { id: 'ci-1', campaign_id: 'camp-1', influencer_id: 'inf-1' });
  store.seed('outreach_messages', {
    id: 'msg-open',
    campaign_influencer_id: 'ci-1',
    message_type: 'initial',
    direction: 'outbound',
    channel: 'email',
    subject: 'Collab',
    body: opts.openerNamesPrice ? 'Hey, $150 for 1 reel + 1 story' : 'Hey, would you be up for a collab?',
    status: 'sent',
    [COUNTER_OFFER_COLUMN]: opts.openerNamesPrice ? 150 : null,
    sent_at: '2026-07-05T15:00:00.000Z',
    send_after: null,
  });
}

function seedInbound(store: Store, id: string, body: string, at: number): Row {
  return store.seed('inbound_messages', {
    id,
    channel: 'email',
    external_id: `sim:${id}`,
    creator_offer_id: null,
    campaign_influencer_id: 'ci-1',
    from_identity: 'sim',
    body,
    received_at: new Date(at).toISOString(),
    status: 'classified',
    classification: { classification: 'negotiating', confidence: 0.8 },
  });
}

interface Exchange {
  body: string;
  out: Out;
  /** Seconds after the previous exchange; a short gap lands while our counter is still queued (a fold). */
  gapS: number;
}

interface Flow {
  name: string;
  openerNamesPrice: boolean;
  exchanges: Exchange[];
}

const ASK_300: Out = { intent: 'counter', counter_usd: 300 };

const FLOWS: Flow[] = [
  {
    name: 'opener → counter → accept at the sent counter',
    openerNamesPrice: true,
    exchanges: [
      { body: 'Can you come up to $300?', out: ASK_300, gapS: 0 },
      { body: 'Deal, that works for me.', out: { intent: 'accept', counter_usd: null }, gapS: 3600 },
    ],
  },
  {
    name: 'opener → immediate accept at the opening price',
    openerNamesPrice: true,
    exchanges: [{ body: 'Sounds good, deal.', out: { intent: 'accept', counter_usd: null }, gapS: 0 }],
  },
  {
    name: 'opener (no price named) → counter → repeat ask',
    openerNamesPrice: false,
    exchanges: [
      { body: 'Can you come up to $300?', out: ASK_300, gapS: 0 },
      { body: 'Still need $300.', out: ASK_300, gapS: 3600 },
    ],
  },
  {
    name: 'fold: second email lands while our counter is queued',
    openerNamesPrice: true,
    exchanges: [
      { body: 'Can you come up to $300?', out: ASK_300, gapS: 0 },
      { body: 'Seriously, $300 is my rate.', out: ASK_300, gapS: 60 },
      { body: 'Still need $300.', out: ASK_300, gapS: 3600 },
    ],
  },
  {
    name: 'fold into an accept of the price they saw',
    openerNamesPrice: true,
    exchanges: [
      { body: 'Can you come up to $300?', out: ASK_300, gapS: 0 },
      { body: 'Actually never mind, $150 works for me, send it over.', out: { intent: 'accept', counter_usd: null }, gapS: 60 },
    ],
  },
  {
    name: 'counter inside the ceiling is accepted at their number',
    openerNamesPrice: true,
    exchanges: [{ body: 'ok how about $180 and we are done', out: { intent: 'counter', counter_usd: 180 }, gapS: 0 }],
  },
  {
    name: 'creator declines',
    openerNamesPrice: true,
    exchanges: [{ body: 'No thanks, not interested.', out: { intent: 'reject', counter_usd: null }, gapS: 0 }],
  },
];

const OFFER_FIELDS = [
  'status',
  'initial_offer_usd',
  'current_offer_usd',
  'agreed_amount_usd',
  'ceiling_usd',
  'rounds',
  'opening_pct',
  'autonomy_mode',
  'injection_flagged',
  'agreed_deliverables',
] as const;

function pick(row: Row | undefined, fields: readonly string[]): Row {
  const out: Row = {};
  for (const f of fields) out[f] = row?.[f] ?? null;
  return out;
}

interface RunResult {
  trace: unknown;
  offer: Row | undefined;
}

async function runFlow(flow: Flow, mode: Mode): Promise<RunResult> {
  const store = makeStore();
  seed(store, mode, { openerNamesPrice: flow.openerNamesPrice });
  const sb = mode === 'pre' ? preMigrationClient(store) : store.sb;

  const sent: Row[] = [];
  const dispatch: DispatchFn = async (_sb, m) => {
    const r = store.all('outreach_messages').find((x) => x.id === m.id);
    sent.push({ type: r?.message_type ?? null, body: r?.body ?? null, offer_usd: r?.[COUNTER_OFFER_COLUMN] ?? null });
    return { ok: true, provider_message_id: 'p', resolved_to: 't@x' };
  };

  // The opener: sending outreach IS the initial offer (the production wire).
  const opened = await openOfferForSentOutreach(sb, {
    campaign_influencer_id: 'ci-1',
    campaign_id: 'camp-1',
    firm_id: 'firm-1',
    outreach_message_id: 'msg-open',
    follower_count: 25_000,
    engagement_rate: 0.2,
    genre: 'country',
  });
  const offerId = opened?.id;
  const steps: Row[] = [
    { step: 'opener', offer: pick(opened as unknown as Row, OFFER_FIELDS) },
  ];

  let t = NOW0;
  let k = 1;
  for (const ex of flow.exchanges) {
    t += ex.gapS * S;
    seedInbound(store, `inb-${k++}`, ex.body, t);
    const out = ex.out;
    script = () => out;
    const tally = await runNegotiationTick(sb, { now: t, rand: HALF, dispatch, pollGmail: noopPoll });
    steps.push({
      step: ex.body,
      tally: pick(tally as unknown as Row, ['processed', 'sent', 'flagged', 'skipped']),
      offer: pick(store.allOffers().find((o) => o.id === offerId), OFFER_FIELDS),
    });
    // A fold needs our counter still queued when the next email lands; any
    // other gap lets the dispatcher send what is due.
    const next = flow.exchanges[flow.exchanges.indexOf(ex) + 1];
    if (!next || next.gapS >= 1800) {
      for (let d = t; d <= t + 25 * MIN; d += MIN) await runDispatchPass(sb, { now: d, rand: HALF, dispatch });
    }
  }

  const offer = store.allOffers().find((o) => o.id === offerId);
  const trace = {
    flow: flow.name,
    steps,
    sent,
    outbound: store
      .all('outreach_messages')
      .filter((r) => r.direction === 'outbound')
      .map((r) => pick(r, ['message_type', 'status', 'channel', 'body', COUNTER_OFFER_COLUMN])),
    inbound: store.all('inbound_messages').map((r) => pick(r, ['status'])),
    payments: store.all('payment_authorizations').map((r) => pick(r, ['amount_usd', 'status'])),
    final: pick(offer, OFFER_FIELDS),
  };
  return { trace, offer };
}

const GOLDEN_PATH = join(__dirname, 'fixtures', 'cpm-shadow', 'formula-golden.json');

async function main() {
  const origWarn = console.warn;
  const origInfo = console.info;
  const origLog = console.log;
  if (!process.env.DEBUG) {
    console.warn = () => {};
    console.info = () => {};
  }

  const pre: unknown[] = [];
  const post: unknown[] = [];
  const postOffers: Array<Row | undefined> = [];
  const preOffers: Array<Row | undefined> = [];
  for (const flow of FLOWS) {
    const a = await runFlow(flow, 'pre');
    const b = await runFlow(flow, 'post');
    pre.push(a.trace);
    post.push(b.trace);
    preOffers.push(a.offer);
    postOffers.push(b.offer);
  }
  console.warn = origWarn;
  console.info = origInfo;
  console.log = origLog;

  if (process.env.CPM_SHADOW_PRINT_GOLDEN) {
    console.log(JSON.stringify(pre, null, 2));
    process.exit(0);
  }

  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as unknown[];
  assert(golden.length === FLOWS.length, `golden covers every flow (${golden.length} vs ${FLOWS.length})`);

  for (let i = 0; i < FLOWS.length; i++) {
    const name = FLOWS[i].name;
    const g = JSON.stringify(golden[i]);
    const a = JSON.stringify(pre[i]);
    const b = JSON.stringify(post[i]);
    assert(a === g, `${name} :: pre-061/062 trace is identical to the pre-change golden`);
    assert(b === g, `${name} :: formula-mode trace WITH shadow data is identical to the pre-change golden`);
    if (b !== g) {
      console.error(`    golden: ${g}\n    post:   ${b}`);
    }
  }

  // Sanity: the flows really exercised every decision this rule is about.
  const finals = (golden as Array<{ final: Row; sent: Row[] }>).map((t) => t.final.status);
  assert(finals.includes('human_approval_required'), 'flows reach an agreement (human gate)');
  assert(finals.includes('rejected'), 'flows reach a decline');
  assert(
    (golden as Array<{ sent: Row[] }>).some((t) => t.sent.some((s) => s.type === 'counter')),
    'flows send at least one counter',
  );
  assert(
    (golden as Array<{ outbound: Row[] }>).some((t) => t.outbound.some((s) => s.status === 'superseded' || String(s.status).includes('supersed'))),
    'flows include a real fold (a superseded draft)',
  );

  // The shadow data exists only where the schema does, and nowhere it could be read back as a decision.
  const opener = postOffers[0];
  const basis = opener?.pricing_basis as Row | undefined;
  assert(!!basis, 'post: the opened offer carries a pricing_basis');
  assert(basis?.method === 'cpm', `post: TikTok history with ≥3 eligible posts prices by CPM in shadow (got ${basis?.method})`);
  assert(
    Number(basis?.formula_price) === Number(opener?.initial_offer_usd),
    'post: pricing_basis records the formula price that was actually used',
  );
  assert(basis?.applied === false, 'post: pricing_basis is marked as not applied (shadow)');
  assert(Number(opener?.first_ask_usd) === 300, `post: first_ask_usd captured from the validated $300 counter (got ${opener?.first_ask_usd})`);
  const repeat = postOffers[2];
  assert(Number(repeat?.first_ask_usd) === 300, 'post: first_ask_usd is set once and not overwritten by a later ask');
  const accepted = postOffers[1];
  assert(accepted?.first_ask_usd == null, 'post: an acceptance is not an ask — first_ask_usd stays null');
  for (const o of preOffers) {
    assert(o?.pricing_basis === undefined, 'pre: no pricing_basis is written before 061');
    assert(o?.first_ask_usd === undefined, 'pre: no first_ask_usd is written before 062');
  }

  console.log(`cpm-shadow-equivalence: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
