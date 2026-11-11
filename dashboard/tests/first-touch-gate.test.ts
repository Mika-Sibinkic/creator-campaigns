import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
//
// tests/first-touch-gate.test.ts
//
// Mini-run limit + budget pacing (src/lib/first-touch-gate.ts).
//
//   1. A campaign with outreach_limit N contacts at most N creators. The
//      (N+1)th FIRST touch is a 409 "Campaign limit reached (N of N
//      contacted)". A reply or counter to a creator already contacted is
//      never limited.
//   2. A first touch is refused while committed + open offers + cap ×
//      contacted-without-offer + cap would pass total_budget_usd: "Budget
//      fully allocated: $X in play of $Y". Unset budget or cap → 409 naming
//      the fix. Any unreadable input → 503, nothing sent.
//   3. Pre-060 (no outreach_limit column) there is no limit and no error.
//   4. Every first-touch send path runs the gate: the manual Send route
//      (source pin — it needs Clerk), DM-queue Mark sent and the scheduled
//      dispatch pass (both EXECUTED here).
//   5. Draft-all and generate-bulk draft at most the remaining limit, highest
//      composite score first; draft-all filters bot_flagged like the others.
//
// Hermetic: in-memory store, mock provider, injected dispatch. No DB, no network.
// Run: npx tsx tests/first-touch-gate.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeStore, type Row } from './negotiation-harness/store';
import {
  FIRST_TOUCH_REFUSALS,
  classifySendResponse,
  emptyTally,
  summarizeSendTally,
} from '../src/lib/outreach-send-copy';
import {
  checkFirstTouch,
  contactedLabel,
  decideFirstTouch,
  normalizeOutreachLimit,
  openerSlots,
  outreachLimitSupported,
  pickOpenerTargets,
  readCampaignContacts,
  readOutreachLimit,
  recheckFirstTouchAfterClaim,
  type InPlay,
} from '../src/lib/first-touch-gate';
import { claimOutboundRow } from '../src/lib/outbound-claim';
import { recordHumanDmSend } from '../src/lib/dm-mark-sent';
import { CreateCampaignBody } from '../src/lib/zod-schemas';
import { runDispatchPass, type DispatchFn } from '../src/lib/negotiation-tick';

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

const ROOT = join(__dirname, '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const NOW = Date.parse('2026-07-06T15:00:00.000Z'); // inside the send window
type Store = ReturnType<typeof makeStore>;

// ── Error injection ─────────────────────────────────────────────────────────
// Any select on `table` whose column list matches `cols` answers `error`.
function failingSelect(sb: SupabaseClient, table: string, cols: RegExp, error: Record<string, unknown>): SupabaseClient {
  const errQuery: Record<string, unknown> = {};
  const self = () => errQuery;
  for (const m of ['eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'lte', 'lt', 'gte', 'select']) errQuery[m] = self;
  errQuery.single = async () => ({ data: null, error });
  errQuery.maybeSingle = async () => ({ data: null, error });
  errQuery.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
    Promise.resolve({ data: null, error }).then(ok, ko);
  return {
    from(t: string) {
      const q = sb.from(t) as unknown as { select: (c?: string) => unknown };
      if (t !== table) return q;
      const orig = q.select.bind(q);
      q.select = (c?: string) => (cols.test(c ?? '') ? errQuery : orig(c));
      return q;
    },
  } as unknown as SupabaseClient;
}
const MISSING_COLUMN = { code: 'PGRST204', message: "Could not find the 'outreach_limit' column of 'campaigns' in the schema cache" };
const TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

// ── World ───────────────────────────────────────────────────────────────────
// camp-1: budget $1,000, cap $250, limit 2. ci-1 contacted by a sent opener,
// ci-2 by its markers only, ci-3..ci-6 not yet.
function world(camp: Partial<Row> = {}): Store {
  const s = makeStore();
  s.seed('firms', { id: 'firm-1', scraping_prefs: {}, outreach_prefs: {} });
  s.seed('campaigns', {
    id: 'camp-1', firm_id: 'firm-1', total_budget_usd: 1000, per_creator_cap_usd: 250, outreach_limit: 2, release_date: null,
    ...camp,
  });
  for (const n of [1, 2, 3, 4, 5, 6]) {
    s.seed('influencers', { id: `inf-${n}`, platform: 'tiktok', username: `c${n}`, blocklisted: false, bot_flagged: false });
    s.seed('campaign_influencers', {
      id: `ci-${n}`, campaign_id: 'camp-1', influencer_id: `inf-${n}`, composite_score: 100 - n,
      outreach_status: n === 2 ? 'sent' : 'draft_ready', last_outreach_at: null, bot_flagged: false,
    });
  }
  s.seed('outreach_messages', {
    id: 'm-1', campaign_influencer_id: 'ci-1', message_type: 'initial', direction: 'outbound', channel: 'email',
    status: 'sent', sent_at: '2026-07-05T15:00:00.000Z', send_after: null,
  });
  return s;
}

function offer(s: Store, ci: string, status: string, current: number | null, agreed: number | null = null): void {
  s.seed('creator_offers', {
    id: `offer-${ci}`, campaign_influencer_id: ci, campaign_id: 'camp-1', firm_id: 'firm-1', status,
    initial_offer_usd: current, current_offer_usd: current, agreed_amount_usd: agreed, ceiling_usd: 250,
  });
}

async function main() {
  // ── 1. Pure decision ──────────────────────────────────────────────────────
  {
    const inPlay = (total: number) => async (): Promise<InPlay> => ({ committed: total, open: 0, uncovered: 0, total });
    const base = { totalBudgetRaw: 1000, perCreatorCapRaw: 250 };

    const atLimit = await decideFirstTouch({ ...base, limit: 10, contacted: 10, inPlay: inPlay(0) });
    assert(!atLimit.ok && atLimit.status === 409, 'pure: 10 of 10 → 409');
    assert(
      !atLimit.ok && atLimit.body.message === 'Campaign limit reached (10 of 10 contacted)',
      `pure: limit copy is exact (got ${JSON.stringify(!atLimit.ok && atLimit.body.message)})`,
    );
    assert(!atLimit.ok && atLimit.body.error === 'outreach_limit_reached', 'pure: limit error code');

    const under = await decideFirstTouch({ ...base, limit: 10, contacted: 9, inPlay: inPlay(0) });
    assert(under.ok && under.firstTouch, 'pure: 9 of 10 → allowed');

    const noLimit = await decideFirstTouch({ ...base, limit: null, contacted: 500, inPlay: inPlay(0) });
    assert(noLimit.ok, 'pure: null limit never refuses on count');

    const exactFit = await decideFirstTouch({ ...base, limit: null, contacted: 0, inPlay: inPlay(750) });
    assert(exactFit.ok, 'pure: $750 in play + $250 cap = $1,000 budget → allowed (not over)');

    const over = await decideFirstTouch({ ...base, limit: null, contacted: 0, inPlay: inPlay(750.01) });
    assert(!over.ok && over.status === 409 && over.body.error === 'budget_fully_allocated', 'pure: one cent over → 409');
    const full = await decideFirstTouch({ ...base, limit: null, contacted: 0, inPlay: inPlay(1000) });
    assert(
      !full.ok && full.body.message === 'Budget fully allocated: $1,000 in play of $1,000',
      `pure: budget copy is exact (got ${JSON.stringify(!full.ok && full.body.message)})`,
    );

    const noBudget = await decideFirstTouch({ totalBudgetRaw: null, perCreatorCapRaw: 250, limit: null, contacted: 0, inPlay: inPlay(0) });
    assert(
      !noBudget.ok && noBudget.status === 409 && noBudget.body.message === 'Set a campaign budget before contacting creators',
      'pure: null budget → 409 "Set a campaign budget before contacting creators"',
    );
    const zeroBudget = await decideFirstTouch({ totalBudgetRaw: 0, perCreatorCapRaw: 250, limit: null, contacted: 0, inPlay: inPlay(0) });
    assert(!zeroBudget.ok && zeroBudget.body.error === 'campaign_budget_not_set', 'pure: $0 budget is unset (spend-caps rule)');
    const noCap = await decideFirstTouch({ totalBudgetRaw: 1000, perCreatorCapRaw: null, limit: null, contacted: 0, inPlay: inPlay(0) });
    assert(!noCap.ok && noCap.body.error === 'per_creator_cap_not_set', 'pure: null cap → 409 per_creator_cap_not_set');

    const unread = await decideFirstTouch({ ...base, limit: null, contacted: 0, inPlay: async () => null });
    assert(!unread.ok && unread.status === 503, 'pure: unreadable in-play → 503 (fail closed)');

    assert(normalizeOutreachLimit(10) === 10 && normalizeOutreachLimit('10') === 10, 'limit: integers normalize');
    for (const bad of [null, undefined, '', 0, -1, 2.5, 'x']) {
      assert(normalizeOutreachLimit(bad) === null, `limit: ${JSON.stringify(bad)} → no limit`);
    }
    assert(openerSlots(null, new Set(['a'])) === null, 'slots: no limit → null');
    assert(openerSlots(10, new Set(['a', 'b', 'c'])) === 7, 'slots: 10 − 3 used = 7');
    assert(openerSlots(2, new Set(['a', 'b', 'c'])) === 0, 'slots: never negative');
    assert(contactedLabel(3, 10) === 'Contacted 3 of 10' && contactedLabel(3, null) === 'Contacted 3', 'label: "Contacted X of N"');

    const ranked = pickOpenerTargets(
      [
        { id: 'low', composite_score: 10 },
        { id: 'none', composite_score: null },
        { id: 'high', composite_score: 90 },
        { id: 'mid', composite_score: 50 },
      ],
      2,
    );
    assert(JSON.stringify(ranked.map((r) => r.id)) === '["high","mid"]', `pick: top-2 by composite score (got ${JSON.stringify(ranked.map((r) => r.id))})`);
    assert(pickOpenerTargets([{ id: 'a', composite_score: 1 }], null).length === 1, 'pick: no limit keeps everything');
    assert(pickOpenerTargets([{ id: 'a', composite_score: 1 }], 0).length === 0, 'pick: 0 slots drafts nothing');
  }

  // ── 2. checkFirstTouch against the store ──────────────────────────────────
  {
    const s = world();
    const contacts = await readCampaignContacts(s.sb, 'camp-1');
    assert(contacts.ok && contacts.contactedIds.size === 2, `contacts: sent opener + markers = 2 (got ${contacts.ok && [...contacts.contactedIds]})`);

    const v3 = await checkFirstTouch(s.sb, 'ci-3');
    assert(!v3.ok && v3.status === 409 && v3.body.message === 'Campaign limit reached (2 of 2 contacted)', `limit: the 3rd creator is refused (got ${JSON.stringify(v3)})`);

    const v1 = await checkFirstTouch(s.sb, 'ci-1');
    assert(v1.ok && !v1.firstTouch, 'limit: a creator already contacted is never limited (follow-up / counter)');

    // A thread the creator opened (an inbound reply, nothing sent) is not a first touch either.
    s.seed('inbound_messages', { id: 'in-4', campaign_influencer_id: 'ci-4', body: 'hey are you hiring?' });
    const v4 = await checkFirstTouch(s.sb, 'ci-4');
    assert(v4.ok && !v4.firstTouch, 'limit: replying to a creator who wrote first is not a first touch');
  }
  {
    // Raise the limit: budget pacing decides. $1,000 budget, $250 cap.
    const s = world({ outreach_limit: 10 });
    offer(s, 'ci-1', 'offered', 150); // open offer at its current amount → $150
    // ci-2 contacted, no offer yet → held at the cap → $250
    const ok = await checkFirstTouch(s.sb, 'ci-3');
    assert(ok.ok && ok.firstTouch, `budget: $400 in play + $250 ≤ $1,000 → allowed (got ${JSON.stringify(ok)})`);

    // A committed deal on another creator: $300 agreed → $700 in play; +$250 = $950 → allowed.
    s.seed('outreach_messages', { id: 'm-5', campaign_influencer_id: 'ci-5', status: 'sent', sent_at: '2026-07-05T15:00:00.000Z' });
    offer(s, 'ci-5', 'agreed', 300, 300);
    const ok2 = await checkFirstTouch(s.sb, 'ci-3');
    assert(ok2.ok, `budget: $700 in play + $250 = $950 → allowed (got ${JSON.stringify(ok2)})`);

    // One more contacted creator with no offer: $950 in play; +$250 = $1,200 → refused.
    s.seed('outreach_messages', { id: 'm-6', campaign_influencer_id: 'ci-6', status: 'sent', sent_at: '2026-07-05T16:00:00.000Z' });
    const no = await checkFirstTouch(s.sb, 'ci-3');
    assert(
      !no.ok && no.status === 409 && no.body.message === 'Budget fully allocated: $950 in play of $1,000',
      `budget: $950 + $250 > $1,000 → 409 (got ${JSON.stringify(no)})`,
    );

    // The $150 open offer is rejected: that creator is out of play → $800.
    const o1 = s.allOffers().find((o) => o.id === 'offer-ci-1') as Row;
    o1.status = 'rejected';
    const freed = await checkFirstTouch(s.sb, 'ci-3');
    assert(
      !freed.ok && freed.body.message === 'Budget fully allocated: $800 in play of $1,000',
      `budget: a rejected offer frees its share ($950 → $800) (got ${JSON.stringify(freed)})`,
    );
    // …and the label raising the budget to $1,050 lets the next creator in.
    (s.all('campaigns')[0] as Row).total_budget_usd = 1050;
    const again = await checkFirstTouch(s.sb, 'ci-3');
    assert(again.ok, `budget: $800 + $250 = $1,050 budget → allowed (got ${JSON.stringify(again)})`);
    (s.all('campaigns')[0] as Row).total_budget_usd = 1000;

    // A counter at $200 on that same creator instead counts at the current amount.
    o1.status = 'counter_offered';
    o1.current_offer_usd = 200;
    const atCounter = await checkFirstTouch(s.sb, 'ci-3');
    assert(
      !atCounter.ok && atCounter.body.message === 'Budget fully allocated: $1,000 in play of $1,000',
      `budget: open offers count at their CURRENT amount (got ${JSON.stringify(atCounter)})`,
    );
  }
  {
    const s = world({ outreach_limit: null, total_budget_usd: null });
    const v = await checkFirstTouch(s.sb, 'ci-3');
    assert(!v.ok && v.status === 409 && v.body.error === 'campaign_budget_not_set', 'null budget: first touch refused 409');
    const follow = await checkFirstTouch(s.sb, 'ci-1');
    assert(follow.ok && !follow.firstTouch, 'null budget: a follow-up to a contacted creator still goes');
  }
  {
    // Pre-060: the column is missing. No limit, no error; pacing still applies.
    const s = world({ outreach_limit: undefined });
    const sb = failingSelect(s.sb, 'campaigns', /outreach_limit/, MISSING_COLUMN);
    const lim = await readOutreachLimit(sb, 'camp-1');
    assert(lim.state === 'unsupported', `pre-060: limit read is 'unsupported' (got ${JSON.stringify(lim)})`);
    assert((await outreachLimitSupported(sb)) === false, 'pre-060: the probe says unsupported');
    assert((await outreachLimitSupported(s.sb)) === true, 'post-060: the probe says supported');
    const v = await checkFirstTouch(sb, 'ci-3');
    assert(v.ok && v.firstTouch, `pre-060: a first touch goes (no limit) (got ${JSON.stringify(v)})`);
  }
  {
    // Fail closed on every read the gate needs.
    const cases: Array<[string, RegExp]> = [
      ['creator_offers', /current_offer_usd/],
      ['creator_offers', /agreed_amount_usd/],
      ['campaign_influencers', /outreach_status/],
      ['outreach_messages', /sent_at/],
      ['inbound_messages', /campaign_influencer_id/],
      ['campaigns', /total_budget_usd/],
      ['campaigns', /outreach_limit/],
    ];
    for (const [table, cols] of cases) {
      const s = world({ outreach_limit: 10 });
      const v = await checkFirstTouch(failingSelect(s.sb, table, cols, TIMEOUT), 'ci-3');
      assert(!v.ok && v.status === 503, `fail closed: ${table} ${cols} unreadable → 503 (got ${JSON.stringify(v)})`);
    }
  }

  // ── 2b. The race: two first touches in flight for the last slot ───────────
  {
    // Limit 2, one contacted (ci-1; ci-2's markers cleared). ci-3 and ci-4 both
    // pass the pre-check, then both claim, then both re-count.
    const seedDraft = (s: Store, id: string, ci: string) =>
      s.seed('outreach_messages', {
        id, campaign_influencer_id: ci, message_type: 'initial', direction: 'outbound', channel: 'email',
        subject: 'Collab', body: 'Hi', status: 'draft', sent_at: null, send_after: null,
      });
    const s = world();
    (s.all('campaign_influencers').find((r) => r.id === 'ci-2') as Row).outreach_status = 'draft_ready';
    seedDraft(s, 'd-3', 'ci-3');
    seedDraft(s, 'd-4', 'ci-4');
    const pre3 = await checkFirstTouch(s.sb, 'ci-3');
    const pre4 = await checkFirstTouch(s.sb, 'ci-4');
    assert(pre3.ok && pre4.ok, 'race: both pass the pre-check (1 of 2 contacted)');
    await claimOutboundRow(s.sb, 'd-3', NOW, 'draft');
    await claimOutboundRow(s.sb, 'd-4', NOW, 'draft');
    const re3 = await recheckFirstTouchAfterClaim(s.sb, 'ci-3');
    const re4 = await recheckFirstTouchAfterClaim(s.sb, 'ci-4');
    assert(!(re3.ok && re4.ok), 'race: after both claims, they cannot BOTH send');
    assert(!re3.ok && re3.body.message === 'Campaign limit reached (2 of 2 contacted)', `race: the recount names the limit (got ${JSON.stringify(re3)})`);

    // Sequential (the bulk loop now): the first claims, re-counts and goes; the
    // second's pre-check then refuses.
    const s2 = world();
    (s2.all('campaign_influencers').find((r) => r.id === 'ci-2') as Row).outreach_status = 'draft_ready';
    seedDraft(s2, 'd-3', 'ci-3');
    seedDraft(s2, 'd-4', 'ci-4');
    assert((await checkFirstTouch(s2.sb, 'ci-3')).ok, 'sequential: first passes');
    await claimOutboundRow(s2.sb, 'd-3', NOW, 'draft');
    const reOk = await recheckFirstTouchAfterClaim(s2.sb, 'ci-3');
    assert(reOk.ok, `sequential: its own claim does not count against it (got ${JSON.stringify(reOk)})`);
    const second = await checkFirstTouch(s2.sb, 'ci-4');
    assert(!second.ok && second.status === 409, 'sequential: the next first touch is refused at 2 of 2');

    // Budget race: $1,000 / $250 cap, $500 in play (ci-1, ci-2 contacted, no offers).
    const s3 = world({ outreach_limit: null });
    seedDraft(s3, 'd-3', 'ci-3');
    seedDraft(s3, 'd-4', 'ci-4');
    seedDraft(s3, 'd-5', 'ci-5');
    assert((await checkFirstTouch(s3.sb, 'ci-4')).ok && (await checkFirstTouch(s3.sb, 'ci-5')).ok, 'budget race: both pre-pass ($500 + $250)');
    await claimOutboundRow(s3.sb, 'd-4', NOW, 'draft');
    await claimOutboundRow(s3.sb, 'd-5', NOW, 'draft');
    const b4 = await recheckFirstTouchAfterClaim(s3.sb, 'ci-4');
    const b5 = await recheckFirstTouchAfterClaim(s3.sb, 'ci-5');
    assert(b4.ok && b5.ok, 'budget race: $500 + $250 + $250 = $1,000 exactly fits, both may go');
    await claimOutboundRow(s3.sb, 'd-3', NOW, 'draft');
    const b3 = await recheckFirstTouchAfterClaim(s3.sb, 'ci-3');
    assert(
      !b3.ok && b3.body.message === 'Budget fully allocated: $1,000 in play of $1,000',
      `budget race: a third concurrent claim is refused on recount (got ${JSON.stringify(b3)})`,
    );
  }

  // ── 3. Executed send paths ────────────────────────────────────────────────
  {
    // Scheduled dispatch of an opener past the limit: not sent, stays queued.
    const s = world();
    s.seed('outreach_messages', {
      id: 'q-3', campaign_influencer_id: 'ci-3', message_type: 'initial', direction: 'outbound', channel: 'email',
      subject: 'Collab', body: 'Hi', status: 'queued', send_mode: 'auto', sent_at: null,
      send_after: new Date(NOW - 60_000).toISOString(), edited_by_user: true,
    });
    const calls: string[] = [];
    const dispatch: DispatchFn = async (_sb, m) => {
      calls.push(m.id);
      return { ok: true, provider_message_id: 'p', resolved_to: 't@x' };
    };
    const t = await runDispatchPass(s.sb, { now: NOW, rand: () => 0.5, dispatch });
    const q3 = s.all('outreach_messages').find((r) => r.id === 'q-3') as Row;
    assert(calls.length === 0 && t.sent === 0, `dispatch: an opener past the limit is not sent (calls=${JSON.stringify(calls)})`);
    assert(q3.status === 'queued' && q3.sent_at == null, 'dispatch: the refused opener stays queued, untouched');

    // Raise the limit: the same row goes on the next pass.
    (s.all('campaigns')[0] as Row).outreach_limit = 3;
    const t2 = await runDispatchPass(s.sb, { now: NOW + 60_000, rand: () => 0.5, dispatch });
    assert(t2.sent === 1 && calls[0] === 'q-3', `dispatch: under the limit the opener goes (sent=${t2.sent})`);

    // A follow-up to an already-contacted creator is never held, at any limit.
    (s.all('campaigns')[0] as Row).outreach_limit = 1;
    s.seed('outreach_messages', {
      id: 'q-1', campaign_influencer_id: 'ci-1', message_type: 'follow_up', direction: 'outbound', channel: 'email',
      subject: 'Re', body: 'Following up', status: 'queued', send_mode: 'auto', sent_at: null,
      send_after: new Date(NOW + 60_000).toISOString(), edited_by_user: true,
    });
    const t3 = await runDispatchPass(s.sb, { now: NOW + 120_000, rand: () => 0.5, dispatch });
    assert(t3.sent === 1 && calls.includes('q-1'), `dispatch: a follow-up past the limit still goes (sent=${t3.sent})`);

    // A reply-only type (a counter) on a thread with no recorded opener, offer
    // or inbound — a legacy thread — is never held as a first touch.
    s.seed('outreach_messages', {
      id: 'q-6', campaign_influencer_id: 'ci-6', message_type: 'counter', direction: 'outbound', channel: 'email',
      subject: 'Re', body: 'We can do $200', status: 'queued', send_mode: 'auto', sent_at: null,
      send_after: new Date(NOW + 150_000).toISOString(), edited_by_user: true,
    });
    const t4 = await runDispatchPass(s.sb, { now: NOW + 180_000, rand: () => 0.5, dispatch });
    assert(t4.sent === 1 && calls.includes('q-6'), `dispatch: a counter is never a first touch (sent=${t4.sent})`);
  }
  {
    // DM queue Mark sent: a first-touch DM past the limit is refused, nothing recorded.
    const s = world();
    s.seed('outreach_messages', {
      id: 'dm-3', campaign_influencer_id: 'ci-3', message_type: 'initial', direction: 'outbound', channel: 'tiktok_dm',
      subject: null, body: 'Hey', status: 'queued', send_mode: 'human_queue', send_after: null, sent_at: null,
    });
    const r = await recordHumanDmSend(s.sb, { messageId: 'dm-3', callerFirmId: 'firm-1', nowMs: NOW });
    const body = r.kind === 'response' ? r.body : {};
    assert(r.kind === 'response' && r.status === 409, `mark sent: past the limit → 409 (got ${JSON.stringify(r)})`);
    assert(
      body.message === "Campaign limit reached (2 of 2 contacted). Don't send this DM.",
      `mark sent: tells the human not to send (got ${JSON.stringify(body.message)})`,
    );
    const dm = s.all('outreach_messages').find((m) => m.id === 'dm-3') as Row;
    assert(dm.sent_at == null && dm.status === 'queued', 'mark sent: nothing recorded');
    assert(s.allOffers().length === 0, 'mark sent: no offer opened');

    (s.all('campaigns')[0] as Row).outreach_limit = 3;
    const ok = await recordHumanDmSend(s.sb, { messageId: 'dm-3', callerFirmId: 'firm-1', nowMs: NOW });
    assert(ok.kind === 'response' && ok.status === 200, `mark sent: under the limit → recorded (got ${JSON.stringify(ok)})`);
  }

  // ── 4. Wiring that needs Clerk / a browser: source pins ───────────────────
  {
    const send = src('src/app/api/outreach/[id]/send/route.ts');
    const gateAt = send.indexOf('await checkFirstTouch(sb, ciTyped.id)');
    assert(gateAt > 0, 'send route: calls checkFirstTouch');
    assert(gateAt < send.indexOf('const dmRouted ='), 'send route: gate runs BEFORE DM routing (no queueing past the limit)');
    assert(gateAt < send.indexOf('await claimAndSendManual('), 'send route: gate runs BEFORE the claim and the send');
    assert(gateAt > send.indexOf('const block = contactBlock('), 'send route: after the pool gate (ownership + DNC first)');

    const recheckAt = send.indexOf('await recheckFirstTouchAfterClaim(sb, ciTyped.id)');
    assert(
      recheckAt > send.indexOf('await claimAndSendManual(') && recheckAt < send.indexOf('await sendOutreach('),
      'send route: re-counts inside the claim callback, before the provider send',
    );
    assert(/heldAfterClaim\.refusal/.test(send), 'send route: a post-claim refusal answers the gate\'s 409, not a 500');

    const tick = src('src/lib/negotiation-tick.ts');
    assert(/threadsAlreadyContacted\(sb, dueCiIds, nowMs\)/.test(tick), 'dispatch: batch-reads which threads are already open');
    const tClaim = tick.indexOf("const claim = await claimOutboundRow(sb, row.id, nowMs, 'queued')");
    const tRe = tick.indexOf('await recheckFirstTouchAfterClaim(sb, firstTouchCi, nowMs)');
    const tSend = tick.indexOf('const out = await dispatch(sb, {');
    assert(tClaim > 0 && tRe > tClaim && tRe < tSend, 'dispatch: re-counts a first touch after its claim, before dispatch');

    const draftAll = src('src/app/api/campaigns/[id]/draft-all/route.ts');
    assert(/eligibleDraftFilter\(/.test(draftAll), 'draft-all: the ci query goes through eligibleDraftFilter (bot_flagged, excluded)');
    assert(/pickOpenerTargets\(/.test(draftAll) && /openerSlots\(/.test(draftAll), 'draft-all: drafts at most the remaining limit');
    const bulk = src('src/app/api/outreach/generate-bulk/route.ts');
    assert(/pickOpenerTargets\(/.test(bulk) && /openerSlots\(/.test(bulk), 'generate-bulk: drafts at most the remaining limit');
    assert(/composite_score/.test(bulk), 'generate-bulk: ranks by composite score');
  }

  // ── 5. Bulk-send copy ─────────────────────────────────────────────────────
  {
    const gateSrc = src('src/lib/first-touch-gate.ts');
    const gateCodes = new Set([...gateSrc.matchAll(/error: '([a-z_]+)'/g)].map((m) => m[1]));
    gateCodes.delete('first_touch_unverifiable'); // 503, not a 409
    assert(
      JSON.stringify([...gateCodes].sort()) === JSON.stringify([...FIRST_TOUCH_REFUSALS].sort()),
      `copy: FIRST_TOUCH_REFUSALS matches the gate's 409 codes (gate ${JSON.stringify([...gateCodes])})`,
    );
    for (const code of FIRST_TOUCH_REFUSALS) {
      assert(classifySendResponse(409, { error: code }) === 'held_by_limit', `copy: ${code} → held_by_limit, never "already sent"`);
    }
    const summary = summarizeSendTally({ ...emptyTally(), sent: 2, held_by_limit: 8 }, 'testing');
    assert(summary.level === 'warning' && summary.message.includes("8 not sent: the campaign's outreach limit or budget is reached"), `copy: summary names the hold (got ${summary.message})`);
    const page = src('src/app/outreach/page.tsx');
    assert(/if \(outcome === "held_by_limit"\)/.test(page), 'bulk send: stops at the first limit/budget refusal');
    assert(!/Promise\.all\(slice\.map\(sendOne\)\)/.test(page), 'bulk send: sends one at a time inside a window (no concurrent race for the last slot)');
  }

  // ── 6. Setting the limit, and pre-060 ─────────────────────────────────────
  {
    const base = { artist_name: 'A', budget: 1000, per_influencer_cap: 250 };
    assert(CreateCampaignBody.safeParse(base).success, 'create body: no limit is valid (pre-060 form)');
    assert(CreateCampaignBody.safeParse({ ...base, outreach_limit: null }).success, 'create body: null limit is valid');
    assert(CreateCampaignBody.safeParse({ ...base, outreach_limit: 10 }).success, 'create body: 10 is valid');
    for (const bad of [0, -3, 2.5, '10']) {
      assert(!CreateCampaignBody.safeParse({ ...base, outreach_limit: bad }).success, `create body: ${JSON.stringify(bad)} is rejected`);
    }

    const create = src('src/app/api/campaigns/route.ts');
    assert(/body\.outreach_limit != null \? \{ outreach_limit: body\.outreach_limit \} : \{\}/.test(create), 'create route: writes the column only when a limit was given');
    assert(/outreach_limit_unavailable/.test(create) && /isMissingColumnError\(error\)/.test(create), 'create route: a limit sent pre-060 is refused, never silently dropped');
    const confirm = src('src/app/api/campaigns/[id]/confirm/route.ts');
    assert(/if \(body\.outreach_limit !== undefined\) updates\.outreach_limit = body\.outreach_limit;/.test(confirm), 'confirm route: absent leaves the stored limit alone; null clears it');

    const get = src('src/app/api/campaigns/[id]/route.ts');
    assert(/hasOwnProperty\.call\(row, OUTREACH_LIMIT_COLUMN\)/.test(get), 'GET campaign: capability = the column is on the row');
    assert(/outreach_progress/.test(get) && /readCampaignContacts\(sb, id\)/.test(get), 'GET campaign: progress counts with the gate\'s own definition');

    const newForm = src('src/app/campaigns/new/page.tsx');
    assert(/\{limitSupported && \(/.test(newForm), 'new form: the field renders only when supported');
    assert(/outreach_limit: limitSupported && limitText !== "" \? limitNum : undefined/.test(newForm), 'new form: the key is never sent pre-060');
    assert(/Max creators to contact/.test(newForm), 'new form: labelled "Max creators to contact"');
    const confirmPage = src('src/app/campaigns/[id]/confirm/page.tsx');
    assert(/\{limitSupported && \(/.test(confirmPage) && /\.\.\.\(limitSupported \? \{ outreach_limit:/.test(confirmPage), 'edit form: field and key gated on support');
    const page = src('src/app/campaigns/[id]/page.tsx');
    assert(/contactedLabel\(progress\.contacted, progress\.limit\)/.test(page), 'campaign page: shows "Contacted X of N"');
    assert(!/from ["'][^"']*first-touch-gate["']/.test(page), 'campaign page: client bundle does not import the server gate');

    const mig = src('supabase/migrations/060_campaign_outreach_limit.sql');
    assert(/add column if not exists outreach_limit integer/.test(mig), 'migration 060: nullable integer, additive');
  }

  console.log(`\nfirst-touch-gate: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
