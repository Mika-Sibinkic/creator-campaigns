// tests/creator-scope.test.ts
//
// Proves the cross-firm creator boundary by RUNNING it, and pins the parts
// deliberately left open so nobody mistakes this for the whole fix.
//
// Background — the mechanism matters more than the finding. An audit reported
// the `influencers` RLS policy as `USING (synthetic = false)` with no firm
// predicate. That is true (migration 007:155-165) but it is NOT the leak:
// post-Clerk `auth.uid()` is NULL and every app read goes through the
// SERVICE-ROLE client (`requireSessionAndClient`, src/lib/auth.ts:155-161),
// so migration 007's policies never evaluate. `024_firm_members_clerk_user_id.sql`
// then drops NOT NULL on `firm_members.user_id`, so even a genuine Supabase
// JWT would match nothing in `WHERE user_id = auth.uid()` — inert twice over.
// Patching the policy would have changed nothing observable while closing the
// ticket. The real boundary is app-level `.eq('firm_id', …)`.
//
// Five layers:
//   1. checkCreatorScope   — the pure write predicate, every deny branch.
//   2. countFirmCreatorRelationships — the campaign_id → campaigns.firm_id
//                            chain, against an in-memory fake.
//   3. listOutreachForFirm — THE ROUTE CORE, EXECUTED, with two real firms.
//   4. redaction           — the enumeration surface.
//   5. source invariants   — narrow, and honest about what they cannot prove.
//
// Hermetic: no env, no network, no DB.
//
// Run: npx tsx tests/creator-scope.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  checkCreatorScope,
  creatorScopeErrorBody,
  countFirmCreatorRelationships,
  firmRelatedInfluencerIds,
  redactUnrelatedCreator,
} from '../src/lib/creator-scope';
import { listOutreachForFirm } from '../src/lib/outreach-listing';

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
const CREATOR = 'cccccccc-3333-4333-8333-cccccccccccc';

// ───────────────────────────────────────────────────────────────────────────
// 1. checkCreatorScope — the pure predicate
// ───────────────────────────────────────────────────────────────────────────
{
  assert(checkCreatorScope(FIRM_A, 1).ok === true, 'a firm that worked the creator may write');
  assert(checkCreatorScope(FIRM_A, 12).ok === true, 'many relationships still allow');

  const none = checkCreatorScope(FIRM_A, 0);
  assert(none.ok === false, 'THE HEADLINE: a firm with no relationship may NOT write');
  assert(
    none.ok === false && none.reason === 'no_creator_relationship',
    'reason is no_creator_relationship'
  );
  assert(none.ok === false && none.httpStatus === 403, 'refusal is a 403');

  // Fail-closed on an unscoped caller — getSession() hands back firm_id '' for
  // an authenticated-but-unprovisioned Clerk user (src/lib/auth.ts:111), and
  // '' must never satisfy a scope check.
  for (const bad of [null, undefined, '', '   ']) {
    const v = checkCreatorScope(bad, 5);
    assert(v.ok === false, `unscoped caller ${JSON.stringify(bad)} → refused`);
    assert(
      v.ok === false && v.reason === 'caller_unscoped',
      `unscoped caller ${JSON.stringify(bad)} → caller_unscoped`
    );
  }

  // An unreadable count must deny, never authorize.
  for (const bad of [-1, NaN, Infinity, undefined as unknown as number]) {
    assert(
      checkCreatorScope(FIRM_A, bad).ok === false,
      `unusable relationship count ${String(bad)} → refused`
    );
  }

  const body = creatorScopeErrorBody(
    checkCreatorScope(FIRM_A, 0) as Extract<
      ReturnType<typeof checkCreatorScope>,
      { ok: false }
    >
  );
  assert(body.error === 'forbidden', 'error body keeps the existing { error } shape');
  assert(body.reason === 'no_creator_relationship', 'error body carries the reason');
}

// ───────────────────────────────────────────────────────────────────────────
// Shared in-memory Supabase fake
// ───────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/**
 * Chainable thenable that records filters and applies them at await time —
 * enough of postgrest-js to run the real query builders unmodified, so the
 * code under test is not reshaped to suit the test.
 */
function makeQuery(
  rows: Row[],
  opts: { error?: boolean; countMode?: boolean; inLimit?: number } = {}
) {
  const eqs: [string, unknown][] = [];
  const ins: [string, unknown[]][] = [];
  const api: Record<string, unknown> = {
    select(_cols?: string, o?: { count?: string; head?: boolean }) {
      if (o?.count) opts.countMode = true;
      return api;
    },
    eq(col: string, val: unknown) {
      eqs.push([col, val]);
      return api;
    },
    in(col: string, vals: unknown[]) {
      ins.push([col, vals]);
      return api;
    },
    or() {
      return api;
    },
    order() {
      return api;
    },
    limit() {
      return api;
    },
    then(resolve: (r: Record<string, unknown>) => unknown) {
      // Real PostgREST puts `.in()` in the URL; past a few hundred UUIDs the
      // request is rejected. Model that so an unchunked caller fails here too.
      const overflow = opts.inLimit != null && ins.some(([, vs]) => vs.length > opts.inLimit!);
      if (opts.error || overflow) {
        return Promise.resolve(
          resolve({ data: null, count: null, error: { message: 'boom' } })
        );
      }
      const out = rows.filter(
        (r) =>
          eqs.every(([c, v]) => r[c] === v) &&
          ins.every(([c, vs]) => vs.includes(r[c] as never))
      );
      return Promise.resolve(
        resolve(
          opts.countMode
            ? { count: out.length, data: out, error: null }
            : { data: out, error: null }
        )
      );
    },
  };
  return api;
}

function makeDb(
  tables: Record<string, Row[]>,
  errorTables: string[] = [],
  inLimit?: number
): SupabaseClient {
  return {
    from(table: string) {
      return makeQuery(tables[table] ?? [], { error: errorTables.includes(table), inLimit });
    },
  } as unknown as SupabaseClient;
}

const CAMP_A = 'camp-a1';
const CAMP_A2 = 'camp-a2';
const CAMP_B = 'camp-b1';

// ───────────────────────────────────────────────────────────────────────────
// 2. countFirmCreatorRelationships — the campaign → firm chain
// ───────────────────────────────────────────────────────────────────────────
function relationshipWorld(errorTables: string[] = []) {
  return makeDb(
    {
      campaigns: [
        { id: CAMP_A, firm_id: FIRM_A },
        { id: CAMP_A2, firm_id: FIRM_A },
        { id: CAMP_B, firm_id: FIRM_B },
      ],
      campaign_influencers: [
        { id: 'ci-a1', campaign_id: CAMP_A, influencer_id: CREATOR },
        { id: 'ci-a2', campaign_id: CAMP_A2, influencer_id: CREATOR },
      ],
    },
    errorTables
  );
}

async function runChainTests() {
  const a = await countFirmCreatorRelationships(relationshipWorld(), FIRM_A, CREATOR);
  assert(a === 2, `firm A worked this creator twice (got ${a})`);

  const b = await countFirmCreatorRelationships(relationshipWorld(), FIRM_B, CREATOR);
  assert(b === 0, `THE HEADLINE: firm B never worked this creator, so it gets 0 (got ${b})`);
  assert(
    checkCreatorScope(FIRM_B, b).ok === false,
    "which means firm B cannot blocklist firm A's creator"
  );
  assert(
    checkCreatorScope(FIRM_A, a).ok === true,
    'while firm A still can — the existing single-tenant flow is unchanged'
  );

  const fresh = await countFirmCreatorRelationships(relationshipWorld(), 'firm-new', CREATOR);
  assert(fresh === 0, 'a firm with no campaigns has no creator relationships');

  // Errors deny. A DB hiccup must not become an authorization.
  const campErr = await countFirmCreatorRelationships(
    relationshipWorld(['campaigns']),
    FIRM_A,
    CREATOR
  );
  assert(campErr === 0, 'a campaigns-query error fails closed to 0');
  const linkErr = await countFirmCreatorRelationships(
    relationshipWorld(['campaign_influencers']),
    FIRM_A,
    CREATOR
  );
  assert(linkErr === 0, 'a link-query error fails closed to 0');
}

// ───────────────────────────────────────────────────────────────────────────
// 3. THE ROUTE CORE, EXECUTED — listOutreachForFirm with two real firms
//
// The previous version of this section was 9 `String.includes()` checks over
// route source text. Those passed while two mutations fully reopened the
// leak: folding the `.in('campaign_id', …)` into the optional
// `if (campaign_id)` branch, and dropping the scope verdict on the floor. A
// grep cannot distinguish a filter that is PRESENT from one that is APPLIED.
// These run the code and assert on the rows that come back.
// ───────────────────────────────────────────────────────────────────────────

function twoFirmWorld() {
  return makeDb({
    campaigns: [
      { id: CAMP_A, firm_id: FIRM_A, artist_name: "A's artist" },
      { id: CAMP_B, firm_id: FIRM_B, artist_name: "B's artist" },
    ],
    campaign_influencers: [
      {
        id: 'ci-a',
        campaign_id: CAMP_A,
        bot_flagged: false,
        outreach_status: 'sent',
        influencer: { id: CREATOR, username: 'a_creator', contact_email: 'a@creator.example' },
        campaign: { id: CAMP_A, artist_name: "A's artist" },
      },
      {
        id: 'ci-b',
        campaign_id: CAMP_B,
        bot_flagged: false,
        outreach_status: 'sent',
        influencer: { id: 'inf-b', username: 'b_creator', contact_email: 'b@creator.example' },
        campaign: { id: CAMP_B, artist_name: "B's artist" },
      },
    ],
    outreach_messages: [
      { id: 'm-a', campaign_influencer_id: 'ci-a', body: "A's message" },
      { id: 'm-b', campaign_influencer_id: 'ci-b', body: "B's message" },
    ],
  });
}

async function runRouteCoreTests() {
  const a = await listOutreachForFirm(twoFirmWorld(), FIRM_A);
  assert(a.ok === true, 'firm A gets a result');
  if (a.ok) {
    assert(a.rows.length === 1, `firm A sees exactly its own row (got ${a.rows.length})`);
    assert(a.rows[0].id === 'ci-a', "and it is firm A's row");
    const serialized = JSON.stringify(a.rows);
    assert(
      !serialized.includes('b@creator.example'),
      "THE HEADLINE: firm A never receives firm B's scraped contact email"
    );
    assert(
      !serialized.includes("B's artist"),
      'firm A never learns which artist firm B is working'
    );
    assert(
      !serialized.includes("B's message"),
      "firm A never receives firm B's outreach message bodies"
    );
    assert(
      JSON.stringify(a.rows[0].messages).includes("A's message"),
      'but it does still get its OWN messages — the feature still works'
    );
  }

  const b = await listOutreachForFirm(twoFirmWorld(), FIRM_B);
  assert(b.ok === true && b.rows.length === 1, 'firm B sees exactly its own row');
  if (b.ok) {
    assert(
      !JSON.stringify(b.rows).includes('a@creator.example'),
      "firm B never receives firm A's scraped contact email"
    );
  }

  // The boundary must survive every optional filter. Mutation #1 was folding
  // the tenant `.in()` into the campaign_id branch, which would make an
  // explicit campaign_id the way to escape scoping.
  const aFiltered = await listOutreachForFirm(twoFirmWorld(), FIRM_A, {
    campaign_id: CAMP_A,
  });
  assert(
    aFiltered.ok === true && aFiltered.rows.length === 1 && aFiltered.rows[0].id === 'ci-a',
    'an explicit own-campaign filter still returns only own rows'
  );
  const aStatus = await listOutreachForFirm(twoFirmWorld(), FIRM_A, { status: 'sent' });
  assert(
    aStatus.ok === true && aStatus.rows.every((r) => r.campaign_id === CAMP_A),
    'a status-tab filter cannot widen the boundary'
  );
  const aSearch = await listOutreachForFirm(twoFirmWorld(), FIRM_A, { search: 'creator' });
  assert(
    aSearch.ok === true && aSearch.rows.every((r) => r.campaign_id === CAMP_A),
    'a search filter cannot widen the boundary — it filters in memory, after scoping'
  );

  const cross = await listOutreachForFirm(twoFirmWorld(), FIRM_B, { campaign_id: CAMP_A });
  assert(cross.ok === false, "firm B cannot request firm A's campaign");
  assert(
    cross.ok === false && cross.httpStatus === 403,
    `cross-firm campaign_id → 403 (got ${cross.ok === false ? cross.httpStatus : 'ok'})`
  );

  const fresh = await listOutreachForFirm(twoFirmWorld(), 'firm-brand-new');
  assert(
    fresh.ok === true && fresh.rows.length === 0,
    "a firm with no campaigns gets [], not every other firm's rows"
  );

  for (const bad of [null, undefined, '', '   ']) {
    const v = await listOutreachForFirm(twoFirmWorld(), bad);
    assert(v.ok === false, `unscoped caller ${JSON.stringify(bad)} → refused`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Redaction — the enumeration surface
// ───────────────────────────────────────────────────────────────────────────
{
  const related = new Set([CREATOR]);
  const mine = redactUnrelatedCreator(
    {
      id: CREATOR,
      username: 'x',
      contact_email: 'x@y.example',
      stripe_connect_account_id: 'acct_1',
    },
    related
  );
  assert(mine.contact_email === 'x@y.example', 'a creator this firm worked keeps its contact email');
  assert(mine.stripe_connect_account_id === 'acct_1', 'and its payout account id');

  const theirs = redactUnrelatedCreator(
    {
      id: 'other',
      username: 'z',
      contact_email: 'z@y.example',
      stripe_connect_account_id: 'acct_9',
    },
    related
  );
  assert(
    theirs.contact_email === null,
    "THE HEADLINE: an unrelated creator's scraped email is redacted"
  );
  assert(theirs.stripe_connect_account_id === null, 'and so is their payout account id');
  assert(theirs.username === 'z', 'but public profile fields are untouched — creators stay shared');
  assert('contact_email' in theirs, 'redacted to null, not omitted — response shape is stable');

  const noId = redactUnrelatedCreator(
    { contact_email: 'q@y.example' } as Record<string, unknown>,
    related
  );
  assert(noId.contact_email === null, 'a row with no id is treated as unrelated');
  const emptySet = redactUnrelatedCreator(
    { id: CREATOR, contact_email: 'x@y.example' },
    new Set<string>()
  );
  assert(
    emptySet.contact_email === null,
    'an empty relationship set (the fail-closed error value) redacts everything'
  );
}

async function runRedactionChainTests() {
  const db = makeDb({
    campaigns: [
      { id: CAMP_A, firm_id: FIRM_A },
      { id: CAMP_B, firm_id: FIRM_B },
    ],
    campaign_influencers: [
      { id: 'ci-a', campaign_id: CAMP_A, influencer_id: CREATOR },
      { id: 'ci-b', campaign_id: CAMP_B, influencer_id: 'inf-b' },
    ],
  });
  const aIds = await firmRelatedInfluencerIds(db, FIRM_A);
  assert(aIds.has(CREATOR), 'firm A is related to the creator it worked');
  assert(!aIds.has('inf-b'), "and not to firm B's creator");

  const none = await firmRelatedInfluencerIds(db, 'firm-brand-new');
  assert(none.size === 0, 'a firm with no campaigns is related to nobody');
  const blank = await firmRelatedInfluencerIds(db, '');
  assert(blank.size === 0, 'a blank firm id resolves to the empty set, not everything');

  const errored = await firmRelatedInfluencerIds(
    makeDb(
      {
        campaigns: [{ id: CAMP_A, firm_id: FIRM_A }],
        campaign_influencers: [{ id: 'ci-a', campaign_id: CAMP_A, influencer_id: CREATOR }],
      },
      ['campaign_influencers']
    ),
    FIRM_A
  );
  assert(errored.size === 0, 'a query error redacts everything rather than exposing everything');
}

// ───────────────────────────────────────────────────────────────────────────
// 5. Source invariants — narrow, and honest about what they cannot prove
//
// These catch "someone stopped calling the scoped helper", which execution
// cannot. They do NOT prove the boundary works; section 3 does that. Comments
// are stripped first, because the fix deliberately quotes the old broken
// claims and matching those would make the guard unfalsifiable.
// ───────────────────────────────────────────────────────────────────────────
{
  const stripComments = (src: string): string =>
    src
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');

  const API = join(process.cwd(), 'src', 'app', 'api');
  const outreachList = stripComments(
    readFileSync(join(API, 'outreach', 'list', 'route.ts'), 'utf8')
  );
  // The route only wires handlers; the logic lives in the handler module
  // (executed end to end by tests/influencer-detail-scope.test.ts).
  const influencerDetail = stripComments(
    readFileSync(join(process.cwd(), 'src', 'lib', 'influencer-detail-handlers.ts'), 'utf8')
  );
  const influencerList = stripComments(
    readFileSync(join(API, 'influencers', 'route.ts'), 'utf8')
  );

  assert(
    outreachList.includes('listOutreachForFirm'),
    'outreach/list delegates to the scoped, executable-tested core'
  );
  assert(
    !/\.from\(["']campaign_influencers["']\)/.test(outreachList),
    'and builds no campaign_influencers query of its own that could bypass it'
  );
  assert(
    influencerDetail.includes('countFirmCreatorRelationships') &&
      influencerDetail.includes('checkCreatorScope'),
    'influencer PATCH gates writes on a real creator relationship'
  );
  assert(
    /if \(!creatorScope\.ok\)/.test(influencerDetail),
    'and ACTS on the verdict rather than discarding it'
  );
  assert(
    influencerDetail.includes('redactUnrelatedCreator'),
    'influencer detail redacts scraped contact detail on unrelated creators'
  );
  assert(
    influencerDetail.includes('.in("campaign_id", ownCampaignIds)'),
    "influencer detail scopes campaign appearances to the caller's campaigns"
  );
  assert(
    influencerList.includes('redactUnrelatedCreator'),
    'the influencer LIST — the enumeration surface — redacts too'
  );

  const scopeSrc = readFileSync(join(process.cwd(), 'src', 'lib', 'creator-scope.ts'), 'utf8');
  assert(
    !scopeSrc.includes('process.env'),
    'creator-scope reads no env — it is pure predicates plus injected queries'
  );
  assert(
    !scopeSrc.includes("from './supabase'") && !scopeSrc.includes('supabaseAdmin'),
    'creator-scope never constructs its own client; the caller passes one in'
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 3b. ALL-CAMPAIGNS VIEW AT PRODUCTION SIZE
//
// With a few hundred leads, one `.in()` over every id overflows the URL. If
// that error is ignored, every lead comes back with zero messages and the DM
// queue reads "No DMs waiting" while sent DMs exist. The fake rejects any
// `.in()` longer than 250 ids, like the proxy.
// ───────────────────────────────────────────────────────────────────────────

async function runLargeListTests() {
  const N = 457;
  const cis: Row[] = [];
  const msgs: Row[] = [];
  for (let i = 0; i < N; i++) {
    cis.push({
      id: `ci-${i}`,
      campaign_id: CAMP_A,
      bot_flagged: false,
      outreach_status: 'sent',
      influencer: { id: `inf-${i}`, username: `c${i}` },
      campaign: { id: CAMP_A, artist_name: "A's artist" },
    });
    msgs.push({ id: `m-${i}`, campaign_influencer_id: `ci-${i}`, created_at: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}` });
  }
  const tables = { campaigns: [{ id: CAMP_A, firm_id: FIRM_A }], campaign_influencers: cis, outreach_messages: msgs };

  const big = await listOutreachForFirm(makeDb(tables, [], 250), FIRM_A);
  assert(big.ok === true, `${N} leads list without error`);
  if (big.ok) {
    const withMsgs = big.rows.filter((r) => (r.messages as unknown[]).length === 1).length;
    assert(withMsgs === N, `every one of ${N} leads keeps its message (got ${withMsgs})`);
  }

  const broken = await listOutreachForFirm(makeDb(tables, ['outreach_messages']), FIRM_A);
  assert(
    broken.ok === false && broken.httpStatus === 500,
    'a failed message lookup is an error, not a silently empty queue'
  );
}

async function main() {
  await runChainTests();
  await runRouteCoreTests();
  await runLargeListTests();
  await runRedactionChainTests();
  if (failures.length > 0) console.error('\nFailures:\n - ' + failures.join('\n - '));
  console.log(`creator-scope test: ${passed}/${passed + failed} pass`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
