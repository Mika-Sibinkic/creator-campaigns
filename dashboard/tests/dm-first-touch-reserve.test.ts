import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
//
// tests/dm-first-touch-reserve.test.ts
//
// The DM queue against the campaign's outreach limit and budget pacing
// (src/lib/first-touch-gate.ts), review findings 2026-10-01:
//
//   1. Concurrent "Mark sent" (bulk fires 4 at once) must not pass the limit:
//      the human-queue flip is a claim, and a first touch re-counts after it
//      (recheckFirstTouchAfterClaim), exactly like the email paths.
//   2. Reserve-before-copy (src/lib/dm-reserve.ts): N parallel reserves with
//      limit L → exactly L slots; budget pacing likewise; across instances
//      never past L. A reserved row's Mark sent never refuses for the limit.
//   3. What needs no slot (counter, contacted creator) and what is refused
//      (other label, do-not-contact, held, sent).
//   4. A reservation lapses after 24h: uncounted at once, released + audited
//      by the tick, and Mark sent on it is gated again.
//   5. Pre-060: no column, everything as before.
//   6. The queue's copy mode and the listing's "Limit reached" stamp.
//
// Hermetic: in-memory store. No DB, no network.
// Run: npx tsx tests/dm-first-touch-reserve.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeStore, type Row } from './negotiation-harness/store';
import { recordHumanDmSend } from '../src/lib/dm-mark-sent';
import { checkFirstTouch, readCampaignContacts } from '../src/lib/first-touch-gate';
import { releaseExpiredDmReservations, reserveDmFirstTouch, stampFirstTouchSlots } from '../src/lib/dm-reserve';
import { DM_RESERVATION_TTL_MS, dmCopyMode, reservationLive, type FirstTouchSlotStamp } from '../src/lib/dm-reservation';
import { dmQueueItems } from '../src/app/outreach/dm-queue-tab';

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

const NOW = Date.parse('2026-07-06T15:00:00.000Z');
type Store = ReturnType<typeof makeStore>;
const ROOT = join(__dirname, '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// Any select on `table` whose column list matches `cols` answers `error`.
function failingSelect(sb: SupabaseClient, table: string, cols: RegExp, error: Record<string, unknown>): SupabaseClient {
  const errQuery: Record<string, unknown> = {};
  const self = () => errQuery;
  for (const m of ['eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'lte', 'lt', 'gte', 'select']) errQuery[m] = self;
  errQuery.single = async () => ({ data: null, error });
  errQuery.maybeSingle = async () => ({ data: null, error });
  errQuery.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve({ data: null, error }).then(ok, ko);
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
const MISSING_COLUMN = { code: 'PGRST204', message: "Could not find the 'dm_reserved_at' column of 'outreach_messages' in the schema cache" };

const reserve = (s: Store, messageId: string, o: { nowMs?: number; firm?: string; serialize?: boolean } = {}) =>
  reserveDmFirstTouch(s.sb, { messageId, callerFirmId: o.firm ?? 'firm-1', nowMs: o.nowMs ?? NOW, serialize: o.serialize });

/**
 * limit `limit`; ci-1 already contacted (outreach_status 'sent') unless
 * contactedFirst is false, in which case ci-1 has no opener either;
 * ci-2..ci-N each with a queued first-touch DM.
 */
function world(opts: { limit: number | null; creators: number; budget?: number; cap?: number; contactedFirst?: boolean }): Store {
  const contactedFirst = opts.contactedFirst !== false;
  const s = makeStore();
  s.seed('firms', { id: 'firm-1', scraping_prefs: {}, outreach_prefs: {} });
  s.seed('campaigns', {
    id: 'camp-1', firm_id: 'firm-1', total_budget_usd: opts.budget ?? 100000, per_creator_cap_usd: opts.cap ?? 250,
    outreach_limit: opts.limit, release_date: null,
  });
  for (let n = 1; n <= opts.creators; n++) {
    s.seed('influencers', {
      id: `inf-${n}`, platform: 'tiktok', username: `c${n}`, blocklisted: false, bot_flagged: false,
      follower_count: 20000, engagement_rate: 0.05,
    });
    s.seed('campaign_influencers', {
      id: `ci-${n}`, campaign_id: 'camp-1', influencer_id: `inf-${n}`, composite_score: 100 - n,
      outreach_status: n === 1 && contactedFirst ? 'sent' : 'draft_ready', last_outreach_at: null, bot_flagged: false,
    });
    if (n > 1) {
      s.seed('outreach_messages', {
        id: `dm-${n}`, campaign_influencer_id: `ci-${n}`, message_type: 'initial', direction: 'outbound',
        channel: 'tiktok_dm', subject: null, body: `Hey c${n}`, status: 'queued', send_mode: 'human_queue',
        send_after: null, sent_at: null,
      });
    }
  }
  return s;
}

async function contacted(s: Store): Promise<number> {
  const c = await readCampaignContacts(s.sb, 'camp-1', NOW);
  return c.ok ? c.contactedIds.size : -1;
}

async function main() {
  // ── 1. Concurrent Mark sent ──────────────────
  {
    // Limit 2, one contacted: exactly ONE more DM may be recorded. Two
    // Mark-sent clicks land together.
    const s = world({ limit: 2, creators: 3 });
    const [a, b] = await Promise.all([
      recordHumanDmSend(s.sb, { messageId: 'dm-2', callerFirmId: 'firm-1', nowMs: NOW }),
      recordHumanDmSend(s.sb, { messageId: 'dm-3', callerFirmId: 'firm-1', nowMs: NOW }),
    ]);
    const statuses = [a, b].map((r) => (r.kind === 'response' ? r.status : 0));
    assert((await contacted(s)) <= 2, `race: concurrent Mark sent never passes the limit (contacted ${await contacted(s)} of 2)`);
    assert(s.allOffers().length <= 1, `race: at most one offer opened (got ${s.allOffers().length})`);
    assert(statuses.filter((x) => x === 200).length <= 1, `race: at most one 200 (got ${JSON.stringify(statuses)})`);
    for (const r of [a, b]) {
      if (r.kind === 'response' && r.status === 409) {
        assert(
          String(r.body.message).startsWith('Campaign limit reached (') && String(r.body.message).endsWith("Don't send this DM."),
          `race: the refusal tells the human not to send (got ${JSON.stringify(r.body.message)})`,
        );
      }
    }
    // A refused row is released exactly as it was: queued, unsent, no ledger trace.
    for (const id of ['dm-2', 'dm-3']) {
      const m = s.all('outreach_messages').find((r) => r.id === id) as Row;
      const ok = [a, b][id === 'dm-2' ? 0 : 1];
      if (ok.kind === 'response' && ok.status !== 200) {
        assert(m.status === 'queued' && m.sent_at == null && m.sent_to == null, `race: refused ${id} is back to queued/unsent (got ${m.status}/${m.sent_at})`);
      }
    }
    const ci = (id: string) => s.all('campaign_influencers').find((r) => r.id === id) as Row;
    const advanced = ['ci-2', 'ci-3'].filter((id) => ci(id).outreach_status === 'sent');
    assert(advanced.length <= 1, `race: at most one lead advanced to sent (got ${JSON.stringify(advanced)})`);

    // Four at once (the bulk batch size) against one free slot.
    const s4 = world({ limit: 2, creators: 5 });
    await Promise.all(
      ['dm-2', 'dm-3', 'dm-4', 'dm-5'].map((id) => recordHumanDmSend(s4.sb, { messageId: id, callerFirmId: 'firm-1', nowMs: NOW })),
    );
    assert((await contacted(s4)) <= 2, `race: a bulk batch of 4 never passes the limit (contacted ${await contacted(s4)} of 2)`);

    // Sequential still works: under the limit the first goes, the next is refused.
    const s2 = world({ limit: 2, creators: 3 });
    const first = await recordHumanDmSend(s2.sb, { messageId: 'dm-2', callerFirmId: 'firm-1', nowMs: NOW });
    assert(first.kind === 'response' && first.status === 200, `sequential: the free slot is taken (got ${JSON.stringify(first)})`);
    const second = await recordHumanDmSend(s2.sb, { messageId: 'dm-3', callerFirmId: 'firm-1', nowMs: NOW });
    assert(second.kind === 'response' && second.status === 409, 'sequential: the next first touch is refused');
  }

  // ── 2. Reserve & copy: N parallel reserves against L slots ────────────────
  {
    // Limit 3, nobody contacted, 8 openers reserved at once → exactly 3 slots.
    const s = world({ limit: 3, creators: 9, contactedFirst: false });
    const ids = [2, 3, 4, 5, 6, 7, 8, 9].map((n) => `dm-${n}`);
    const outs = await Promise.all(ids.map((id) => reserve(s, id)));
    const won = outs.filter((o) => o.status === 200 && o.body.reserved === true);
    assert(won.length === 3, `reserve: 8 parallel with limit 3 → exactly 3 reserved (got ${won.length}; ${JSON.stringify(outs.map((o) => o.status))})`);
    const lost = outs.filter((o) => o.status === 409);
    assert(
      lost.length === 5 && lost.every((o) => o.body.error === 'outreach_limit_reached' && !('body' in o.body && typeof o.body.body === 'string')),
      'reserve: the other 5 are refused for the limit and get no text',
    );
    assert(won.every((o) => typeof o.body.body === 'string' && String(o.body.body).startsWith('Hey c')), 'reserve: a winner gets the draft text back');
    assert(
      won.every((o) => o.body.expires_at === new Date(NOW + 24 * 3600_000).toISOString()),
      `reserve: the slot is held 24h (got ${JSON.stringify(won.map((o) => o.body.expires_at))})`,
    );
    assert((await contacted(s)) === 3, `reserve: reservations count toward the limit (contacted ${await contacted(s)})`);
    const stamped = s.all('outreach_messages').filter((m) => m.dm_reserved_at);
    assert(stamped.length === 3, `reserve: exactly 3 rows carry dm_reserved_at (got ${stamped.length})`);

    // Mark sent on a reserved row never refuses for the limit: the slot is held.
    const wonIds = stamped.map((m) => m.id as string);
    const marks = await Promise.all(wonIds.map((id) => recordHumanDmSend(s.sb, { messageId: id, callerFirmId: 'firm-1', nowMs: NOW + 60_000 })));
    assert(marks.every((m) => m.kind === 'response' && m.status === 200), `mark sent: every reserved row records at a full limit (got ${JSON.stringify(marks.map((m) => m.kind === 'response' && m.status))})`);
    assert((await contacted(s)) === 3 && s.allOffers().length === 3, 'mark sent: 3 contacted, 3 offers — never past the limit');
    // The slot is held, so Mark sent does not even consult the gate: a gate
    // read that fails (503 for an unreserved opener) cannot refuse it.
    const g = world({ limit: 1, creators: 3, contactedFirst: false });
    await reserve(g, 'dm-2');
    const TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };
    const broken = failingSelect(g.sb, 'campaign_influencers', /outreach_status/, TIMEOUT);
    const unres = await recordHumanDmSend(broken, { messageId: 'dm-3', callerFirmId: 'firm-1', nowMs: NOW });
    assert(unres.kind === 'response' && unres.status === 503, 'mark sent: an unreserved opener with an unreadable gate → 503');
    const res = await recordHumanDmSend(broken, { messageId: 'dm-2', callerFirmId: 'firm-1', nowMs: NOW });
    assert(res.kind === 'response' && res.status === 200, `mark sent: a reserved opener records without the gate (got ${JSON.stringify(res)})`);
    // An unreserved opener is still gated at Mark sent.
    const other = ids.find((id) => !wonIds.includes(id)) as string;
    const refused = await recordHumanDmSend(s.sb, { messageId: other, callerFirmId: 'firm-1', nowMs: NOW + 60_000 });
    assert(refused.kind === 'response' && refused.status === 409, 'mark sent: an unreserved opener past the limit is refused');
  }
  {
    // Budget pacing: $1,000, $250 cap, no limit → exactly 4 of 6.
    const s = world({ limit: null, creators: 7, contactedFirst: false, budget: 1000, cap: 250 });
    const outs = await Promise.all([2, 3, 4, 5, 6, 7].map((n) => reserve(s, `dm-${n}`)));
    const won = outs.filter((o) => o.status === 200 && o.body.reserved === true).length;
    assert(won === 4, `reserve: budget $1,000 / $250 cap → exactly 4 of 6 reserved (got ${won})`);
    assert(outs.filter((o) => o.body.error === 'budget_fully_allocated').length === 2, 'reserve: the rest are refused for the budget');
  }
  {
    // Different server instances (no in-process lock): Postgres arbitrates via
    // the claim + recount. Never past the limit; possibly fewer.
    const s = world({ limit: 3, creators: 9, contactedFirst: false });
    const outs = await Promise.all([2, 3, 4, 5, 6, 7, 8, 9].map((n) => reserve(s, `dm-${n}`, { serialize: false })));
    const won = outs.filter((o) => o.status === 200 && o.body.reserved === true).length;
    assert(won <= 3, `reserve (cross-instance): never more than the limit (got ${won})`);
    assert((await contacted(s)) <= 3, 'reserve (cross-instance): refused claims are released');
    const after = await reserve(s, 'dm-2');
    const live = s.all('outreach_messages').filter((m) => m.dm_reserved_at).length;
    assert(live <= 3 && (after.status === 200 || after.status === 409), `reserve (cross-instance): a retry is decided against what is held (live ${live})`);
  }

  // ── 3. Reserve: what needs no slot, and what is refused ───────────────────
  {
    const s = world({ limit: 2, creators: 4 });
    const a = await reserve(s, 'dm-2');
    const again = await reserve(s, 'dm-2', { nowMs: NOW + 5 * 60_000 });
    assert(
      again.status === 200 && again.body.reserved === true && again.body.reserved_at === a.body.reserved_at && again.body.already_held === true && a.body.already_held === undefined,
      `reserve: re-copying a reserved row returns the same slot, not a new one (got ${JSON.stringify(again.body.reserved_at)})`,
    );
    // Limit 2 now full (ci-1 contacted + dm-2 reserved).
    const full = await reserve(s, 'dm-3');
    assert(full.status === 409 && full.body.message === 'Campaign limit reached (2 of 2 contacted)', `reserve: past the limit → 409 with the gate's copy (got ${JSON.stringify(full.body)})`);

    // A counter / reply-only draft never needs a slot.
    s.seed('outreach_messages', {
      id: 'c-4', campaign_influencer_id: 'ci-4', message_type: 'counter', direction: 'outbound', channel: 'tiktok_dm',
      subject: null, body: 'We can do $200', status: 'queued', send_mode: 'human_queue', send_after: null, sent_at: null,
    });
    const counter = await reserve(s, 'c-4');
    assert(counter.status === 200 && counter.body.reserved === false && counter.body.body === 'We can do $200', 'reserve: a counter copies with no slot, even at a full limit');
    // A follow-up to a creator already contacted: no slot.
    s.seed('outreach_messages', {
      id: 'f-1', campaign_influencer_id: 'ci-1', message_type: 'follow_up', direction: 'outbound', channel: 'tiktok_dm',
      subject: null, body: 'Following up', status: 'queued', send_mode: 'human_queue', send_after: null, sent_at: null,
    });
    const follow = await reserve(s, 'f-1');
    assert(follow.status === 200 && follow.body.reserved === false, 'reserve: a follow-up to a contacted creator copies with no slot');
    assert(!(s.all('outreach_messages').find((m) => m.id === 'f-1') as Row).dm_reserved_at, 'reserve: …and stamps nothing');

    const foreign = await reserve(s, 'dm-3', { firm: 'firm-2' });
    assert(foreign.status === 403, 'reserve: another label → 403');
    (s.all('influencers').find((r) => r.id === 'inf-4') as Row).blocklisted = true;
    s.seed('outreach_messages', {
      id: 'dm-4b', campaign_influencer_id: 'ci-4', message_type: 'initial', direction: 'outbound', channel: 'tiktok_dm',
      subject: null, body: 'Hey', status: 'queued', send_mode: 'human_queue', send_after: null, sent_at: null,
    });
    const blocked = await reserve(s, 'dm-4b');
    assert(blocked.status === 409 && blocked.body.error === 'do_not_contact', 'reserve: do-not-contact → 409, before any slot');
    const held = world({ limit: 5, creators: 2 });
    (held.all('outreach_messages')[0] as Row).send_after = new Date(NOW + 3600_000).toISOString();
    const h = await reserve(held, 'dm-2');
    assert(h.status === 409 && h.body.error === 'held', 'reserve: a DM held for later is not reservable yet');
    const sent = world({ limit: 5, creators: 2 });
    (sent.all('outreach_messages')[0] as Row).sent_at = new Date(NOW).toISOString();
    assert((await reserve(sent, 'dm-2')).status === 409, 'reserve: an already-sent DM → 409');
  }

  // ── 4. Expiry: lapsed after 24h, released and audited ─────────────────────
  {
    const s = world({ limit: 2, creators: 4 });
    const r = await reserve(s, 'dm-2');
    assert(r.status === 200 && r.body.reserved === true, 'expiry: slot reserved');
    const LATER = NOW + 25 * 3600_000;
    const atLater = await readCampaignContacts(s.sb, 'camp-1', LATER);
    assert(atLater.ok && !atLater.contactedIds.has('ci-2'), 'expiry: a lapsed reservation stops counting at once (lazy on read)');
    // Not yet released: the tick has not run. Another opener may take the slot.
    const taken = await reserve(s, 'dm-3', { nowMs: LATER });
    assert(taken.status === 200 && taken.body.reserved === true, 'expiry: the lapsed slot is free for another opener');
    // Mark sent on the lapsed row now goes through the gate (and the limit is full again).
    const late = await recordHumanDmSend(s.sb, { messageId: 'dm-2', callerFirmId: 'firm-1', nowMs: LATER });
    assert(late.kind === 'response' && late.status === 409, 'expiry: Mark sent on a lapsed reservation is gated like any first touch');

    const audits: Array<Record<string, unknown>> = [];
    const n = await releaseExpiredDmReservations(s.sb, LATER, async (e) => {
      audits.push(e as unknown as Record<string, unknown>);
    });
    assert(n === 1, `expiry: the tick releases exactly the lapsed reservation (got ${n})`);
    const dm2 = s.all('outreach_messages').find((m) => m.id === 'dm-2') as Row;
    const dm3 = s.all('outreach_messages').find((m) => m.id === 'dm-3') as Row;
    assert(dm2.dm_reserved_at == null && typeof dm3.dm_reserved_at === 'string', 'expiry: the live one is untouched');
    assert(
      audits.length === 1 && audits[0].action === 'outreach.dm_reservation.released' && audits[0].target_id === 'dm-2' && audits[0].firm_id === 'firm-1',
      `expiry: one audit row per release (got ${JSON.stringify(audits)})`,
    );
    assert((await releaseExpiredDmReservations(s.sb, LATER, async () => {})) === 0, 'expiry: idempotent');
    // Re-reserved between the release's read and its write: left alone, not audited.
    const s3 = world({ limit: 2, creators: 3 });
    await reserve(s3, 'dm-2');
    const row3 = s3.all('outreach_messages').find((m) => m.id === 'dm-2') as Row;
    const fresh = new Date(LATER).toISOString();
    const racing = {
      from(t: string) {
        const q = s3.sb.from(t) as unknown as { update: (p: Row) => unknown };
        if (t === 'outreach_messages') {
          const orig = q.update.bind(q);
          q.update = (p: Row) => {
            row3.dm_reserved_at = fresh; // a Reserve & copy lands first
            return orig(p);
          };
        }
        return q;
      },
    } as unknown as SupabaseClient;
    const audits3: unknown[] = [];
    const n3 = await releaseExpiredDmReservations(racing, LATER, async (e) => {
      audits3.push(e);
    });
    assert(n3 === 0 && audits3.length === 0 && row3.dm_reserved_at === fresh, `expiry: a slot re-reserved mid-release is kept, not audited (released ${n3})`);
    // A reserved row that WAS marked sent is never released.
    const s2 = world({ limit: 2, creators: 3 });
    await reserve(s2, 'dm-2');
    await recordHumanDmSend(s2.sb, { messageId: 'dm-2', callerFirmId: 'firm-1', nowMs: NOW + 60_000 });
    assert((await releaseExpiredDmReservations(s2.sb, LATER, async () => {})) === 0, 'expiry: a sent row is never released');
  }

  // ── 5. Pre-060: no column, everything as before ───────────────────────────
  {
    const s = world({ limit: null, creators: 3 });
    const sb = failingSelect(s.sb, 'outreach_messages', /dm_reserved_at/, MISSING_COLUMN);
    const r = await reserveDmFirstTouch(sb, { messageId: 'dm-2', callerFirmId: 'firm-1', nowMs: NOW });
    assert(r.status === 409 && r.body.error === 'reservation_unavailable', 'pre-060: reserve answers reservation_unavailable');
    const gate = await checkFirstTouch(sb, 'ci-2', NOW);
    assert(gate.ok && gate.firstTouch, `pre-060: the gate still reads (no 503) (got ${JSON.stringify(gate)})`);
    const mark = await recordHumanDmSend(sb, { messageId: 'dm-2', callerFirmId: 'firm-1', nowMs: NOW });
    assert(mark.kind === 'response' && mark.status === 200, 'pre-060: Mark sent records as before');
    assert((await releaseExpiredDmReservations(sb, NOW, async () => {})) === 0, 'pre-060: release is a no-op');
  }

  // ── 6. The queue: copy mode and the listing stamp ─────────────────────────
  {
    const post060 = { message_type: 'initial', dm_reserved_at: null };
    assert(dmCopyMode({ message_type: 'initial' }, { state: 'open' }, NOW) === 'plain', 'mode: pre-060 (no key) → plain copy');
    assert(dmCopyMode(post060, { state: 'open' }, NOW) === 'reserve', 'mode: open slot → Reserve & copy');
    assert(dmCopyMode(post060, undefined, NOW) === 'reserve', 'mode: no stamp → Reserve & copy (server decides)');
    assert(dmCopyMode(post060, { state: 'limit_reached', message: 'x' }, NOW) === 'limit', 'mode: limit reached → no copy');
    assert(dmCopyMode(post060, { state: 'contacted' }, NOW) === 'plain', 'mode: already contacted → plain');
    assert(dmCopyMode({ message_type: 'counter', dm_reserved_at: null }, { state: 'limit_reached', message: 'x' }, NOW) === 'plain', 'mode: a counter is never limited');
    const live = { message_type: 'initial', dm_reserved_at: new Date(NOW - 3600_000).toISOString() };
    assert(dmCopyMode(live, { state: 'limit_reached', message: 'x' }, NOW) === 'reserved', 'mode: a held slot wins over "limit reached"');
    const lapsed = { message_type: 'initial', dm_reserved_at: new Date(NOW - 25 * 3600_000).toISOString() };
    assert(dmCopyMode(lapsed, { state: 'open' }, NOW) === 'reserve', 'mode: a lapsed slot must be reserved again');
    assert(reservationLive(new Date(NOW - DM_RESERVATION_TTL_MS + 1).toISOString(), NOW) && !reservationLive(new Date(NOW - DM_RESERVATION_TTL_MS).toISOString(), NOW), 'ttl: live strictly under 24h');

    const entry = (id: string, slot: FirstTouchSlotStamp | undefined) => ({
      id, do_not_contact: 'clear' as const, first_touch_slot: slot,
      influencer: { username: id, display_name: id, platform: 'tiktok', profile_url: `https://www.tiktok.com/@${id}` },
      campaign: { artist_name: 'A' },
      messages: [{ id: `m-${id}`, subject: null, body: 'Hey', channel: 'tiktok_dm', direction: 'outbound', sent_at: null, created_at: '2026-07-01T00:00:00.000Z', message_type: 'initial', send_mode: 'human_queue', status: 'queued', send_after: null, dm_reserved_at: null }],
    });
    const items = dmQueueItems([entry('open1', { state: 'open' }), entry('full1', { state: 'limit_reached', message: 'Campaign limit reached (2 of 2 contacted)' })], NOW);
    const full = items.find((i) => i.entry.id === 'full1');
    const open = items.find((i) => i.entry.id === 'open1');
    assert(full?.copyMode === 'limit' && full.blocked && full.limitMessage === 'Campaign limit reached (2 of 2 contacted)', 'queue: a limit-reached opener is blocked with the reason');
    assert(open?.copyMode === 'reserve' && !open.blocked, 'queue: an open opener offers Reserve & copy');
    assert(items[items.length - 1]?.entry.id === 'full1', 'queue: limit-reached rows sort to the bottom with the other unsendable rows');
  }
  {
    // stampFirstTouchSlots against the store: limit 2, ci-1 contacted, dm-2 reserved.
    const s = world({ limit: 2, creators: 4 });
    for (const m of s.all('outreach_messages')) m.dm_reserved_at = null;
    await reserve(s, 'dm-2');
    const rows = ['ci-1', 'ci-2', 'ci-3', 'ci-4'].map((id) => ({
      id, campaign_id: 'camp-1',
      messages: s.all('outreach_messages').filter((m) => m.campaign_influencer_id === id).map((m) => ({ ...m })),
    })) as Array<Record<string, unknown>>;
    (rows[0].messages as Row[]).push({ id: 'f-1', direction: 'outbound', send_mode: 'human_queue', sent_at: null, message_type: 'follow_up', dm_reserved_at: null });
    await stampFirstTouchSlots(s.sb, rows, NOW);
    const slot = (i: number) => rows[i].first_touch_slot as FirstTouchSlotStamp | undefined;
    assert(slot(0)?.state === 'contacted', `stamp: ci-1 (contacted) → contacted (got ${JSON.stringify(slot(0))})`);
    assert(slot(1) === undefined, 'stamp: ci-2 holds a live slot — nothing waiting, no stamp');
    assert(slot(2)?.state === 'limit_reached' && slot(3)?.state === 'limit_reached', `stamp: ci-3/ci-4 → limit reached (got ${JSON.stringify(slot(2))})`);
    (s.all('campaigns')[0] as Row).outreach_limit = 5;
    delete rows[2].first_touch_slot;
    await stampFirstTouchSlots(s.sb, rows, NOW);
    assert(slot(2)?.state === 'open', 'stamp: under the limit → open');
    const pre = [{ id: 'ci-3', campaign_id: 'camp-1', messages: [{ id: 'x', direction: 'outbound', send_mode: 'human_queue', sent_at: null, message_type: 'initial' }] }] as Array<Record<string, unknown>>;
    await stampFirstTouchSlots(s.sb, pre, NOW);
    assert(pre[0].first_touch_slot === undefined, 'stamp: pre-060 rows (no dm_reserved_at key) are never stamped');
  }

  // ── 7. Wiring ─────────────────────────────────────────────────────────────
  {
    const route = src('src/app/api/outreach/messages/[id]/reserve/route.ts');
    const tenant = route.indexOf('outreachMessageInFirm(');
    const call = route.indexOf('reserveDmFirstTouch(');
    assert(tenant > 0 && call > tenant, 'route: tenant gate before the reserve');
    assert(/tieredLimit\(req, ['"]auth['"]\)/.test(route), 'route: rate-limited like the other DM queue writes');
    assert(/export async function POST/.test(route), 'route: POST');
    const tick = src('src/lib/negotiation-tick.ts');
    assert(/releaseExpiredDmReservations\(sb, clock\(\)\)/.test(tick), 'tick: releases lapsed reservations');
    const listing = src('src/lib/outreach-listing.ts');
    assert(/await stampFirstTouchSlots\(sb, rows, nowMs\)/.test(listing) && /awaitsFirstTouchSlot\(r, nowMs\)/.test(listing), 'listing: stamps first-touch slots when a DM opener is waiting');
    const tab = src('src/app/outreach/dm-queue-tab.tsx');
    assert(/\/reserve`/.test(tab) && /Reserve &amp; copy|Reserve & copy/.test(tab), 'tab: Reserve & copy calls the reserve endpoint');
    assert(/Limit reached/.test(tab), 'tab: shows "Limit reached"');
    const mig = src('supabase/migrations/060_campaign_outreach_limit.sql');
    assert(/alter table public\.outreach_messages\s+add column if not exists dm_reserved_at timestamptz/i.test(mig), 'migration 060: adds outreach_messages.dm_reserved_at');
  }

  console.log(`\ndm-first-touch-reserve: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
