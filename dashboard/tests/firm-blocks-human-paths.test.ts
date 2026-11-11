import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub
//
// tests/firm-blocks-human-paths.test.ts
//
// The two contact paths the per-label do-not-contact rule (src/lib/firm-blocks.ts)
// did not reach:
//
//   A. The human DM queue. A creator who said STOP to this label still showed
//      up in /outreach → DM queue with a live "Mark sent", and Mark sent opens
//      a PRICED offer the negotiator then owns. Now:
//        * the listing stamps every row with the do-not-contact verdict,
//        * the queue hides 'blocked' rows and HOLDS 'unknown' ones (fail
//          closed), counting both so nothing vanishes silently,
//        * Mark sent refuses a blocked creator (409) and an unreadable block
//          list (503) — including rows queued BEFORE the block — writing nothing.
//   B. The post-payment promo-materials email. It mailed whoever the offer
//      named. Now it checks the same rule first and holds on 'blocked' or
//      'unknown', never calling the sender.
//
// Everything here EXECUTES the production function against an in-memory
// Supabase double; the only source assertion is the one route wire-up that
// needs Clerk to run.
//
// Hermetic: no DB, no network. Run: npx tsx tests/firm-blocks-human-paths.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeStore } from './negotiation-harness/store';
import {
  FIRM_BLOCKS_TABLE,
  checkDoNotContact,
  doNotContactVerdict,
} from '../src/lib/firm-blocks';
import { listOutreachForFirm } from '../src/lib/outreach-listing';
import { ingestInboundReply, type NormalizedInbound } from '../src/lib/ingest-inbound';
import { MANUAL_EMAIL_EXTERNAL_ID_PREFIX, logManualEmailReply } from '../src/lib/manual-email-reply';
import { recordHumanDmSend } from '../src/lib/dm-mark-sent';
import { dmQueueWithholdReason } from '../src/app/outreach/dm-queue-guards';
import { dmQueueItems, dmQueueWithheld, type DmQueueEntry } from '../src/app/outreach/dm-queue-tab';
import { resendHeldPromo, sendPromoMaterials } from '../src/lib/promo-materials';
import {
  MONEY_ANOMALY_AUDIT_ACTIONS,
  OPERATOR_ONLY_ANOMALY_CATEGORIES,
  PROMO_HELD_ACTION,
  PROMO_WITHHELD_ACTION,
  detectAnomalies,
  type ThreadAuditRow,
} from '../src/lib/statuses';

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
const NOW = Date.parse('2026-09-30T18:00:00Z');

const MISSING_TABLE = {
  code: 'PGRST205',
  message: `Could not find the table 'public.${FIRM_BLOCKS_TABLE}' in the schema cache`,
};
const TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

/** Every query against ONE table resolves to `error`. */
function failTable(sb: SupabaseClient, table: string, error: { code: string; message: string }): SupabaseClient {
  const res = { data: null, error };
  const node: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'lte', 'lt', 'gte']) {
    node[m] = () => node;
  }
  node.single = async () => res;
  node.maybeSingle = async () => res;
  node.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(res).then(ok, err);
  return {
    from(t: string) {
      return t === table ? node : sb.from(t);
    },
    storage: (sb as unknown as { storage?: unknown }).storage,
  } as unknown as SupabaseClient;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

type Store = ReturnType<typeof makeStore>;

/**
 * Two labels, one creator (inf-1). firm-A: camp-A / ci-A. firm-B: camp-B / ci-B.
 * A second creator inf-2 on camp-A (ci-A2) that nobody has blocked.
 * m-A is a human_queue DM to inf-1 for firm-A, queued BEFORE any block.
 */
function seedWorld(store: Store, opts: { globalBlocked?: boolean } = {}): void {
  store.seed('firms', { id: 'firm-A', scraping_prefs: {}, outreach_prefs: {} });
  store.seed('firms', { id: 'firm-B', scraping_prefs: {}, outreach_prefs: {} });
  // Both caps, as every confirmed campaign has (migration 037): Mark sent's
  // first-touch gate (src/lib/first-touch-gate.ts) refuses without them.
  const caps = { total_budget_usd: 10_000, per_creator_cap_usd: 250 };
  store.seed('campaigns', { id: 'camp-A', firm_id: 'firm-A', artist_name: 'Artist A', genre: 'pop', status: 'active', ...caps });
  store.seed('campaigns', { id: 'camp-B', firm_id: 'firm-B', artist_name: 'Artist B', genre: 'pop', status: 'active', ...caps });
  const inf1 = {
    id: 'inf-1',
    platform: 'tiktok',
    username: 'creator1',
    display_name: 'Creator One',
    profile_url: null,
    contact_email: 'creator1@example.com',
    follower_count: 40_000,
    engagement_rate: 0.05,
    bot_flagged: false,
    blocklisted: opts.globalBlocked === true,
  };
  const inf2 = { ...inf1, id: 'inf-2', username: 'creator2', contact_email: 'creator2@example.com', blocklisted: false };
  store.seed('influencers', inf1);
  store.seed('influencers', inf2);
  const ciRows: Array<[string, string, typeof inf1, number]> = [
    ['ci-A', 'camp-A', inf1, 90],
    ['ci-A2', 'camp-A', inf2, 80],
    ['ci-B', 'camp-B', inf1, 70],
  ];
  for (const [id, camp, inf, score] of ciRows) {
    store.seed('campaign_influencers', {
      id,
      campaign_id: camp,
      influencer_id: inf.id,
      bot_flagged: false,
      composite_score: score,
      outreach_status: 'draft_ready',
      status: 'discovered',
      // The listing's embedded selects — the double ignores projection, so the
      // joined objects ride on the row the way PostgREST would return them.
      influencer: { ...inf },
      campaign: { id: camp, artist_name: camp === 'camp-A' ? 'Artist A' : 'Artist B', status: 'active' },
    });
  }
  for (const [id, ci] of [['m-A', 'ci-A'], ['m-A2', 'ci-A2'], ['m-B', 'ci-B']] as const) {
    store.seed('outreach_messages', {
      id,
      campaign_influencer_id: ci,
      subject: 'collab',
      body: 'Hey — want to post a clip?',
      channel: 'tiktok_dm',
      direction: 'outbound',
      message_type: 'initial',
      status: 'queued',
      send_mode: 'human_queue',
      send_after: null,
      sent_at: null,
      created_at: '2026-09-29T10:00:00.000Z',
    });
  }
}

function blockFor(store: Store, firm: string, inf: string): void {
  store.seed(FIRM_BLOCKS_TABLE, { firm_id: firm, influencer_id: inf, source: 'creator_opt_out' });
}

function msg(store: Store, id: string) {
  return store.all('outreach_messages').find((m) => m.id === id);
}

async function main() {
  // ── 1. The verdict (pure) ─────────────────────────────────────────────────
  {
    const ok = (ids: string[]) => ({ state: 'ok' as const, ids: new Set(ids) });
    assert(doNotContactVerdict(false, 'inf-1', ok([])) === 'clear', 'verdict: nothing blocks → clear');
    assert(doNotContactVerdict(false, 'inf-1', ok(['inf-1'])) === 'blocked', 'verdict: a per-firm row → blocked');
    assert(doNotContactVerdict(true, 'inf-1', ok([])) === 'blocked', 'verdict: the global flag → blocked');
    assert(
      doNotContactVerdict(false, 'inf-1', { state: 'unreadable', ids: new Set() }) === 'unknown',
      'verdict: an unreadable list → unknown, never clear',
    );
    assert(
      doNotContactVerdict(true, 'inf-1', { state: 'unreadable', ids: new Set() }) === 'blocked',
      'verdict: global block is known without the table → blocked even when unreadable',
    );
    assert(
      doNotContactVerdict(false, 'inf-1', { state: 'table_missing', ids: new Set() }) === 'clear',
      'verdict: pre-056 missing table → global flag alone decides',
    );
    assert(doNotContactVerdict(false, null, ok([])) === 'unknown', 'verdict: no creator id → unknown');
  }

  // ── 2. checkDoNotContact (the send-boundary read) ─────────────────────────
  {
    const store = makeStore();
    seedWorld(store);
    blockFor(store, 'firm-A', 'inf-1');
    const a = await checkDoNotContact(store.sb, { firmId: 'firm-A', campaignInfluencerId: 'ci-A' });
    assert(a.verdict === 'blocked' && a.influencerId === 'inf-1', "check: firm A's own block → blocked");
    const b = await checkDoNotContact(store.sb, { firmId: 'firm-B', campaignInfluencerId: 'ci-B' });
    assert(b.verdict === 'clear', "check: firm A's block does not reach firm B");
    const a2 = await checkDoNotContact(store.sb, { firmId: 'firm-A', campaignInfluencerId: 'ci-A2' });
    assert(a2.verdict === 'clear', 'check: an unblocked creator is clear');

    const broken = await checkDoNotContact(failTable(store.sb, FIRM_BLOCKS_TABLE, TIMEOUT), {
      firmId: 'firm-B',
      campaignInfluencerId: 'ci-B',
    });
    assert(broken.verdict === 'unknown', 'check: unreadable block list → unknown (hold)');
    const missing = await checkDoNotContact(failTable(store.sb, FIRM_BLOCKS_TABLE, MISSING_TABLE), {
      firmId: 'firm-B',
      campaignInfluencerId: 'ci-B',
    });
    assert(missing.verdict === 'clear', 'check: pre-056 → global flag alone (clear here)');
    const infDown = await checkDoNotContact(failTable(store.sb, 'influencers', TIMEOUT), {
      firmId: 'firm-B',
      campaignInfluencerId: 'ci-B',
    });
    assert(infDown.verdict === 'unknown', 'check: the global flag unreadable → unknown');
    const noLead = await checkDoNotContact(store.sb, { firmId: 'firm-A', campaignInfluencerId: 'ci-nope' });
    assert(noLead.verdict === 'unknown', 'check: a lead that resolves to no creator → unknown');
    const noFirm = await checkDoNotContact(store.sb, { firmId: null, campaignInfluencerId: 'ci-A2' });
    assert(noFirm.verdict === 'unknown', 'check: no firm → unknown (the per-firm rule cannot be applied)');

    const g = makeStore();
    seedWorld(g, { globalBlocked: true });
    const gv = await checkDoNotContact(g.sb, { firmId: 'firm-B', campaignInfluencerId: 'ci-B' });
    assert(gv.verdict === 'blocked', 'check: a platform-wide block applies to every label');
  }

  // ── 3. The listing stamps every row ───────────────────────────────────────
  {
    const store = makeStore();
    seedWorld(store);
    blockFor(store, 'firm-A', 'inf-1');
    const res = await listOutreachForFirm(store.sb, 'firm-A');
    assert(res.ok === true, 'list: firm A lists');
    if (res.ok) {
      const byId = new Map(res.rows.map((r) => [r.id as string, r]));
      assert(byId.get('ci-A')?.do_not_contact === 'blocked', 'list: the STOPped creator is stamped blocked');
      assert(byId.get('ci-A2')?.do_not_contact === 'clear', 'list: an unblocked creator is stamped clear');
      assert(res.rows.length === 2, 'list: rows are stamped, not dropped (other tabs keep showing exclusions)');
    }
    const resB = await listOutreachForFirm(store.sb, 'firm-B');
    assert(
      resB.ok === true && resB.rows.find((r) => r.id === 'ci-B')?.do_not_contact === 'clear',
      "list: firm B's row for the same creator is clear",
    );
    const unread = await listOutreachForFirm(failTable(store.sb, FIRM_BLOCKS_TABLE, TIMEOUT), 'firm-A');
    assert(
      unread.ok === true && unread.rows.every((r) => r.do_not_contact === 'unknown'),
      'list: an unreadable block list stamps every row unknown (never clear)',
    );
    const pre056 = await listOutreachForFirm(failTable(store.sb, FIRM_BLOCKS_TABLE, MISSING_TABLE), 'firm-A');
    assert(
      pre056.ok === true && pre056.rows.every((r) => r.do_not_contact === 'clear'),
      'list: pre-056 falls back to the global flag (clear here)',
    );
    const g = makeStore();
    seedWorld(g, { globalBlocked: true });
    const gl = await listOutreachForFirm(failTable(g.sb, FIRM_BLOCKS_TABLE, TIMEOUT), 'firm-A');
    assert(
      gl.ok === true && gl.rows.find((r) => r.id === 'ci-A')?.do_not_contact === 'blocked',
      'list: a globally blocked creator stays blocked even when the per-firm list is unreadable',
    );
  }

  // ── 4. The DM queue hides and holds ───────────────────────────────────────
  {
    const entry = (id: string, dnc: unknown, globalBlocked = false): DmQueueEntry =>
      ({
        id,
        do_not_contact: dnc,
        composite_score: 50,
        influencer: {
          username: id,
          display_name: id,
          platform: 'tiktok',
          profile_url: null,
          blocklisted: globalBlocked,
        },
        campaign: { artist_name: 'A' },
        messages: [
          {
            id: `m-${id}`,
            subject: null,
            body: 'hi',
            channel: 'tiktok_dm',
            direction: 'outbound',
            sent_at: null,
            created_at: '2026-09-29T10:00:00.000Z',
            message_type: 'initial',
            send_mode: 'human_queue',
            status: 'queued',
            send_after: null,
          },
        ],
      }) as DmQueueEntry;

    assert(dmQueueWithholdReason({ do_not_contact: 'clear' }) === null, 'queue: clear is shown');
    assert(dmQueueWithholdReason({ do_not_contact: 'blocked' }) === 'do_not_contact', 'queue: blocked is withheld');
    assert(dmQueueWithholdReason({ do_not_contact: 'unknown' }) === 'unconfirmed', 'queue: unknown is held');
    assert(dmQueueWithholdReason({}) === 'unconfirmed', 'queue: no verdict at all is held (fail closed)');
    assert(
      dmQueueWithholdReason({ do_not_contact: 'clear', influencer: { blocklisted: true } }) === 'do_not_contact',
      'queue: the global flag on the row wins over a stale clear',
    );

    const entries = [
      entry('ok', 'clear'),
      entry('stop', 'blocked'),
      entry('unk', 'unknown'),
      entry('missing', undefined),
      entry('global', 'clear', true),
    ];
    const items = dmQueueItems(entries, NOW);
    assert(
      items.length === 1 && items[0].msg.id === 'm-ok',
      `queue: only the clear creator is listed (got ${items.map((i) => i.msg.id).join(',')})`,
    );
    const w = dmQueueWithheld(entries);
    assert(w.doNotContact === 2, `queue: two withheld as do-not-contact (got ${w.doNotContact})`);
    assert(w.unconfirmed === 2, `queue: two held as unconfirmed (got ${w.unconfirmed})`);

    // Already-sent rows and non-queue rows are not counted as withheld.
    const sentStop = entry('sent', 'blocked');
    sentStop.messages[0].sent_at = '2026-09-29T11:00:00.000Z';
    const w2 = dmQueueWithheld([sentStop]);
    assert(w2.doNotContact === 0 && w2.unconfirmed === 0, 'queue: a sent DM is not counted as withheld');
  }

  // ── 5. Mark sent refuses — executed, nothing written ──────────────────────
  {
    // 5a. Blocked for this label, row queued BEFORE the block.
    const store = makeStore();
    seedWorld(store);
    blockFor(store, 'firm-A', 'inf-1');
    const r = await recordHumanDmSend(store.sb, { messageId: 'm-A', callerFirmId: 'firm-A', nowMs: NOW });
    assert(r.kind === 'response' && r.status === 409, `mark sent: blocked creator → 409 (got ${JSON.stringify(r)})`);
    assert(r.kind === 'response' && r.body.error === 'do_not_contact', 'mark sent: error is do_not_contact');
    assert(msg(store, 'm-A')?.sent_at == null, 'mark sent: blocked → sent_at untouched');
    assert(store.all('creator_offers').length === 0, 'mark sent: blocked → no priced offer opened');
    assert(store.all('social_send_events').length === 0, 'mark sent: blocked → no send event');
    const ci = store.all('campaign_influencers').find((c) => c.id === 'ci-A');
    assert(ci?.outreach_status === 'draft_ready', 'mark sent: blocked → lead not advanced');

    // 5b. Unreadable block list → 503, nothing written.
    const s2 = makeStore();
    seedWorld(s2);
    const r2 = await recordHumanDmSend(failTable(s2.sb, FIRM_BLOCKS_TABLE, TIMEOUT), {
      messageId: 'm-A',
      callerFirmId: 'firm-A',
      nowMs: NOW,
    });
    assert(r2.kind === 'response' && r2.status === 503, `mark sent: unreadable → 503 (got ${JSON.stringify(r2)})`);
    assert(r2.kind === 'response' && r2.body.error === 'block_list_unreadable', 'mark sent: error is block_list_unreadable');
    assert(msg(s2, 'm-A')?.sent_at == null, 'mark sent: unreadable → sent_at untouched');

    // 5c. Global block → 409.
    const s3 = makeStore();
    seedWorld(s3, { globalBlocked: true });
    const r3 = await recordHumanDmSend(s3.sb, { messageId: 'm-B', callerFirmId: 'firm-B', nowMs: NOW });
    assert(r3.kind === 'response' && r3.status === 409, 'mark sent: platform-wide block → 409');

    // 5d. Another label's block does not stop this label.
    const s4 = makeStore();
    seedWorld(s4);
    blockFor(s4, 'firm-A', 'inf-1');
    const r4 = await recordHumanDmSend(s4.sb, { messageId: 'm-B', callerFirmId: 'firm-B', nowMs: NOW });
    assert(r4.kind === 'response' && r4.status === 200, `mark sent: firm B unaffected by A's block (got ${JSON.stringify(r4)})`);
    assert(msg(s4, 'm-B')?.sent_at != null, 'mark sent: firm B → recorded');

    // 5e. Pre-056 → global alone, proceeds.
    const s5 = makeStore();
    seedWorld(s5);
    const r5 = await recordHumanDmSend(failTable(s5.sb, FIRM_BLOCKS_TABLE, MISSING_TABLE), {
      messageId: 'm-A2',
      callerFirmId: 'firm-A',
      nowMs: NOW,
    });
    assert(r5.kind === 'response' && r5.status === 200, 'mark sent: pre-056 proceeds on the global flag');

    // 5f. The existing guards still hold, and ownership is checked BEFORE the
    // block list — a foreign caller learns nothing about another label's blocks.
    const s6 = makeStore();
    seedWorld(s6);
    blockFor(s6, 'firm-A', 'inf-1');
    const foreign = await recordHumanDmSend(s6.sb, { messageId: 'm-A', callerFirmId: 'firm-B', nowMs: NOW });
    assert(foreign.kind === 'response' && foreign.status === 403, 'mark sent: foreign caller → 403, not the block verdict');
    const notDm = makeStore();
    seedWorld(notDm);
    notDm.all('outreach_messages').find((m) => m.id === 'm-A')!.send_mode = null;
    const nd = await recordHumanDmSend(notDm.sb, { messageId: 'm-A', callerFirmId: 'firm-A', nowMs: NOW });
    assert(nd.kind === 'not_human_queue', 'mark sent: a non-queue row falls through to the email path');

    // 5g. The route actually delegates to it (its handlers live in
    // src/lib/outreach-message-handlers.ts since the tenant-gate fix).
    const route = stripComments(
      readFileSync(join(ROOT, 'src/lib/outreach-message-handlers.ts'), 'utf8'),
    );
    assert(/recordHumanDmSend\(/.test(route), 'route: PATCH mark_sent calls recordHumanDmSend');
    assert(!/markHumanQueueSent\(/.test(route), 'route: no direct markHumanQueueSent call that bypasses the gate');
  }

  // ── 6. Promo materials hold on do-not-contact ─────────────────────────────
  {
    const seedOffer = (store: Store) =>
      store.seed('creator_offers', {
        id: 'offer-1',
        firm_id: 'firm-A',
        campaign_id: 'camp-A',
        campaign_influencer_id: 'ci-A',
        agreed_deliverables: null,
        contract_text: null,
        contract_generated_at: null,
        payout_email: 'payme@example.com',
      });
    const spy = () => {
      const calls: unknown[] = [];
      return {
        calls,
        sendOutreach: async (input: unknown) => {
          calls.push(input);
          return { ok: true, resolved_to: 'test@label.example', message_id: 'prov-1', test_mode: true };
        },
      };
    };

    // Blocked for this label → no email, no row.
    const s1 = makeStore();
    seedWorld(s1);
    seedOffer(s1);
    blockFor(s1, 'firm-A', 'inf-1');
    const sp1 = spy();
    const o1 = await sendPromoMaterials(s1.sb, { creatorOfferId: 'offer-1' }, { sendOutreach: sp1.sendOutreach as never });
    assert(sp1.calls.length === 0, 'promo: blocked creator → sender never called');
    assert(o1.outcome === 'held_do_not_contact', `promo: outcome held_do_not_contact (got ${o1.outcome})`);
    assert(
      s1.all('outreach_messages').every((m) => m.message_type !== 'promo_materials'),
      'promo: blocked → no promo_materials row written',
    );

    // Unreadable → held, no email.
    const s2 = makeStore();
    seedWorld(s2);
    seedOffer(s2);
    const sp2 = spy();
    const o2 = await sendPromoMaterials(
      failTable(s2.sb, FIRM_BLOCKS_TABLE, TIMEOUT),
      { creatorOfferId: 'offer-1' },
      { sendOutreach: sp2.sendOutreach as never },
    );
    assert(sp2.calls.length === 0, 'promo: unreadable block list → sender never called');
    assert(o2.outcome === 'held_unconfirmed', `promo: outcome held_unconfirmed (got ${o2.outcome})`);

    // Global block → held.
    const s3 = makeStore();
    seedWorld(s3, { globalBlocked: true });
    seedOffer(s3);
    const sp3 = spy();
    const o3 = await sendPromoMaterials(s3.sb, { creatorOfferId: 'offer-1' }, { sendOutreach: sp3.sendOutreach as never });
    assert(sp3.calls.length === 0 && o3.outcome === 'held_do_not_contact', 'promo: platform-wide block → held');

    // Clear → sends once, row recorded. (The control: the gate is not just
    // refusing everything.)
    const s4 = makeStore();
    seedWorld(s4);
    seedOffer(s4);
    blockFor(s4, 'firm-B', 'inf-1'); // another label's block — irrelevant here
    const sp4 = spy();
    const o4 = await sendPromoMaterials(s4.sb, { creatorOfferId: 'offer-1' }, { sendOutreach: sp4.sendOutreach as never });
    assert(sp4.calls.length === 1, `promo: clear creator → sent once (got ${sp4.calls.length})`);
    assert(o4.outcome === 'sent', `promo: outcome sent (got ${o4.outcome})`);
    assert(
      s4.all('outreach_messages').filter((m) => m.message_type === 'promo_materials').length === 1,
      'promo: clear → one promo_materials row',
    );
  }


  // ── 7. A held promo pack is an operator anomaly, and resendable ───────────
  {
    const seedOffer = (store: Store) =>
      store.seed('creator_offers', {
        id: 'offer-1',
        firm_id: 'firm-A',
        campaign_id: 'camp-A',
        campaign_influencer_id: 'ci-A',
        agreed_deliverables: null,
        contract_text: null,
        contract_generated_at: null,
        payout_email: 'payme@example.com',
      });
    /** Writes audit rows into the store, the way audit() writes audit_log. */
    const auditInto = (store: Store) => async (e: {
      action: string;
      target_type?: string;
      target_id?: string;
      firm_id?: string | null;
      metadata?: Record<string, unknown>;
    }) => {
      store.seed('audit_log', {
        action: e.action,
        target_type: e.target_type ?? null,
        target_id: e.target_id ?? null,
        firm_id: e.firm_id ?? null,
        metadata: e.metadata ?? null,
        occurred_at: new Date().toISOString(),
      });
    };
    const sender = () => {
      const calls: unknown[] = [];
      return {
        calls,
        fn: (async (input: unknown) => {
          calls.push(input);
          return { ok: true, resolved_to: 'test@label.example', message_id: 'prov-1', test_mode: true };
        }) as never,
      };
    };
    const held = (store: Store) =>
      store.all('audit_log').filter((a) => a.action === PROMO_HELD_ACTION);

    // 7a. The hold is recorded as an audit row carrying what a re-run needs.
    const s = makeStore();
    seedWorld(s);
    seedOffer(s);
    const snd = sender();
    const o = await sendPromoMaterials(
      failTable(s.sb, FIRM_BLOCKS_TABLE, TIMEOUT),
      { creatorOfferId: 'offer-1' },
      { sendOutreach: snd.fn, audit: auditInto(s) },
    );
    assert(o.outcome === 'held_unconfirmed', 'held: outcome held_unconfirmed');
    const h = held(s);
    assert(h.length === 1, `held: one ${PROMO_HELD_ACTION} audit row (got ${h.length})`);
    assert(
      h[0]?.target_type === 'creator_offer' && h[0]?.target_id === 'offer-1' && h[0]?.firm_id === 'firm-A',
      'held: audit row targets the offer, scoped to its firm',
    );
    const meta = (h[0]?.metadata ?? {}) as Record<string, unknown>;
    assert(
      meta.campaign_id === 'camp-A' && meta.campaign_influencer_id === 'ci-A',
      'held: audit metadata carries campaign + lead for the re-run and deep link',
    );

    // 7b. It surfaces in the operator-only payment_anomaly lane with the action.
    const auditRows = (st: Store) =>
      st.all('audit_log').map((a, i) => ({
        id: `a-${i}`,
        occurred_at: String(a.occurred_at),
        action: String(a.action),
        target_type: (a.target_type as string | null) ?? null,
        target_id: (a.target_id as string | null) ?? null,
        metadata: (a.metadata as Record<string, unknown> | null) ?? null,
      })) as ThreadAuditRow[];
    const baseInput = {
      offers: [
        {
          id: 'offer-1',
          campaign_influencer_id: 'ci-A',
          campaign_id: 'camp-A',
          status: 'paid',
          injection_flagged: false,
          updated_at: '2026-09-30T00:00:00Z',
          current_offer_usd: 100,
          contract_generated_at: null,
        },
      ],
      payments: [],
      deliveries: [],
      audit: [],
      inbound: [],
      cis: [{ id: 'ci-A', campaign_id: 'camp-A', influencer_id: 'inf-1' }],
      influencers: [{ id: 'inf-1', username: 'creator1' }],
      campaigns: [{ id: 'camp-A', artist_name: 'Artist A' }],
      hasContractTemplate: true,
    } as unknown as Parameters<typeof detectAnomalies>[0];
    const lane = detectAnomalies({ ...baseInput, moneyAudit: auditRows(s) }, NOW).filter(
      (r) => r.resend_promo_offer_id != null,
    );
    assert(lane.length === 1, `lane: one resendable row (got ${lane.length})`);
    assert(lane[0]?.category === 'payment_anomaly', 'lane: in payment_anomaly');
    assert(OPERATOR_ONLY_ANOMALY_CATEGORIES.includes('payment_anomaly'), 'lane: operator-only');
    assert(lane[0]?.resend_promo_offer_id === 'offer-1', 'lane: row carries the offer id to re-run');
    assert(lane[0]?.campaign_influencer_id === 'ci-A' && lane[0]?.who === '@creator1', 'lane: attributed to the lead');

    // Two holds for one offer → one row. A sent pack or a later withheld → gone.
    const twice = [...auditRows(s), { ...auditRows(s)[0], id: 'a-dup', occurred_at: '2026-09-30T19:00:00Z' }];
    assert(
      detectAnomalies({ ...baseInput, moneyAudit: twice }, NOW).filter((r) => r.resend_promo_offer_id).length === 1,
      'lane: repeated holds for one deal show as one row',
    );
    // Same timestamp twice (one clock tick) is still one row.
    const sameTick = [...auditRows(s), { ...auditRows(s)[0], id: 'a-same' }];
    assert(
      detectAnomalies({ ...baseInput, moneyAudit: sameTick }, NOW).filter((r) => r.resend_promo_offer_id).length === 1,
      'lane: two holds in the same tick show as one row',
    );
    // The row shown is the NEWEST hold, even when an older one comes first.
    const olderFirst = [
      { ...auditRows(s)[0], id: 'a-old', occurred_at: '2026-09-01T00:00:00Z' },
      { ...auditRows(s)[0], id: 'a-new', occurred_at: '2026-09-30T19:00:00Z' },
    ];
    const shown = detectAnomalies({ ...baseInput, moneyAudit: olderFirst }, NOW).filter((r) => r.resend_promo_offer_id);
    assert(shown.length === 1 && shown[0].at === '2026-09-30T19:00:00Z', 'lane: the newest hold is the one shown');
    assert(MONEY_ANOMALY_AUDIT_ACTIONS.includes(PROMO_HELD_ACTION), 'lane: the route query fetches held promo rows');
    assert(
      detectAnomalies({ ...baseInput, moneyAudit: auditRows(s), promoSentCiIds: ['ci-A'] }, NOW).filter(
        (r) => r.resend_promo_offer_id,
      ).length === 0,
      'lane: resolved once a promo_materials message exists for the lead',
    );
    const withheld = [
      ...auditRows(s),
      {
        id: 'a-wh',
        occurred_at: '2099-01-01T00:00:00Z',
        action: PROMO_WITHHELD_ACTION,
        target_type: 'creator_offer',
        target_id: 'offer-1',
        metadata: {},
      },
    ] as ThreadAuditRow[];
    assert(
      detectAnomalies({ ...baseInput, moneyAudit: withheld }, NOW).filter((r) => r.resend_promo_offer_id).length === 0,
      'lane: resolved by a later withheld-do-not-contact decision',
    );
    assert(
      detectAnomalies({ ...baseInput, moneyAudit: withheld }, NOW).every((r) => !/withheld/i.test(r.ref)),
      'lane: the withheld audit row itself is not an anomaly',
    );

    // 7c. Resend — same block check, firm-scoped, only for a held deal.
    const foreign = await resendHeldPromo(s.sb, { offerId: 'offer-1', firmId: 'firm-B' }, { sendOutreach: snd.fn, audit: auditInto(s) });
    assert(foreign.status === 404, `resend: another firm's deal → 404 (got ${foreign.status})`);

    const fresh = makeStore();
    seedWorld(fresh);
    seedOffer(fresh);
    const neverHeld = await resendHeldPromo(fresh.sb, { offerId: 'offer-1', firmId: 'firm-A' }, { sendOutreach: snd.fn, audit: auditInto(fresh) });
    assert(neverHeld.status === 409 && neverHeld.body.error === 'not_held', 'resend: a deal with no hold → 409 not_held');
    assert(snd.calls.length === 0, 'resend: nothing sent for a deal that was never held');

    const still = await resendHeldPromo(
      failTable(s.sb, FIRM_BLOCKS_TABLE, TIMEOUT),
      { offerId: 'offer-1', firmId: 'firm-A' },
      { sendOutreach: snd.fn, audit: auditInto(s) },
    );
    assert(still.status === 503 && snd.calls.length === 0, 'resend: list still unreadable → 503, not sent');
    assert(held(s).length === 2, 'resend: a second hold is recorded again');

    const blockedStore = makeStore();
    seedWorld(blockedStore);
    seedOffer(blockedStore);
    await auditInto(blockedStore)({ action: PROMO_HELD_ACTION, target_type: 'creator_offer', target_id: 'offer-1', firm_id: 'firm-A' });
    blockFor(blockedStore, 'firm-A', 'inf-1');
    const nowBlocked = await resendHeldPromo(blockedStore.sb, { offerId: 'offer-1', firmId: 'firm-A' }, { sendOutreach: snd.fn, audit: auditInto(blockedStore) });
    assert(nowBlocked.status === 409 && nowBlocked.body.error === 'do_not_contact', 'resend: creator now blocked → 409 do_not_contact');
    assert(snd.calls.length === 0, 'resend: blocked → not sent');
    assert(
      blockedStore.all('audit_log').some((a) => a.action === PROMO_WITHHELD_ACTION && a.target_id === 'offer-1'),
      'resend: blocked → withheld decision recorded (resolves the lane row)',
    );

    const ok = await resendHeldPromo(s.sb, { offerId: 'offer-1', firmId: 'firm-A' }, { sendOutreach: snd.fn, audit: auditInto(s) });
    assert(ok.status === 200 && ok.body.outcome === 'sent', `resend: list readable + clear → sent (got ${JSON.stringify(ok)})`);
    assert(snd.calls.length === 1, 'resend: sent exactly once');
    const again = await resendHeldPromo(s.sb, { offerId: 'offer-1', firmId: 'firm-A' }, { sendOutreach: snd.fn, audit: auditInto(s) });
    assert(again.status === 409 && again.body.error === 'already_sent', 'resend: a second click → 409 already_sent');
    assert(snd.calls.length === 1, 'resend: a second click sends nothing');

    // 7d. Wire-up (these handlers need Clerk).
    const route = stripComments(readFileSync(join(ROOT, 'src/app/api/anomalies/promo-resend/route.ts'), 'utf8'));
    assert(/requireOperator\(/.test(route), 'route: promo resend is operator-only');
    assert(/resendHeldPromo\(/.test(route), 'route: promo resend delegates to resendHeldPromo');
    assert(/session\.firm_id/.test(route), 'route: promo resend is scoped to the caller firm');
    const anomalies = stripComments(readFileSync(join(ROOT, 'src/app/api/anomalies/route.ts'), 'utf8'));
    assert(/PROMO_WITHHELD_ACTION/.test(anomalies), 'anomalies: reads withheld decisions');
    assert(
      /detectAnomalies\([\s\S]*promoSentCiIds[\s\S]*Date\.now\(\)/.test(anomalies),
      'anomalies: passes sent promo leads into detectAnomalies for resolution',
    );
  }

  // ── 8. A manually logged EMAIL reply (/outreach → Log response) ───────────
  // A pasted STOP must be recorded as a block, not just classified and stored,
  // or the creator's queued messages still dispatch. The route checks the firm.
  {
    const store = makeStore();
    seedWorld(store);
    // An automated email counter is queued to inf-1 for firm-A too.
    store.seed('outreach_messages', {
      id: 'm-A-counter', campaign_influencer_id: 'ci-A', message_type: 'counter', direction: 'outbound',
      channel: 'email', subject: 'collab', body: 'How about $150?', status: 'queued', send_mode: 'auto_email',
      send_after: new Date(NOW + 5 * 60_000).toISOString(), sent_at: null,
    });
    const loadLead = async (ciId: string) => {
      const ci = store.all('campaign_influencers').find((c) => c.id === ciId);
      if (!ci) return null;
      const camp = store.all('campaigns').find((c) => c.id === ci.campaign_id);
      return { firm_id: (camp?.firm_id as string) ?? null };
    };
    const ingest = (n: NormalizedInbound) => ingestInboundReply(n, store.sb);

    const other = await logManualEmailReply({
      input: { campaign_influencer_id: 'ci-A', response_text: 'STOP', submission_id: 'sub-x' },
      callerFirmId: 'firm-B', loadLead, ingest,
    });
    assert(!other.ok && other.status === 403, `manual email: another label's lead → 403 (got ${JSON.stringify(other)})`);
    assert(store.all('inbound_messages').length === 0, 'manual email: a refused request writes nothing');
    const missing = await logManualEmailReply({
      input: { campaign_influencer_id: 'ci-nope', response_text: 'STOP', submission_id: 'sub-y' },
      callerFirmId: 'firm-A', loadLead, ingest,
    });
    assert(!missing.ok && missing.status === 404, 'manual email: unknown lead → 404');
    const dm = await logManualEmailReply({
      input: { campaign_influencer_id: 'ci-A', response_text: 'STOP', submission_id: 'sub-z', channel: 'instagram_dm' },
      callerFirmId: 'firm-A', loadLead, ingest,
    });
    assert(!dm.ok && dm.status === 400, 'manual email: a DM channel is refused here (it belongs to /api/outreach/dm-reply)');

    const res = await logManualEmailReply({
      input: { campaign_influencer_id: 'ci-A', response_text: 'STOP', submission_id: 'sub-1' },
      callerFirmId: 'firm-A', loadLead, ingest,
    });
    assert(res.ok, `manual email: STOP from the lead's own label is accepted (got ${JSON.stringify(res)})`);
    const inb = store.all('inbound_messages');
    assert(inb.length === 1 && inb[0].external_id === `${MANUAL_EMAIL_EXTERNAL_ID_PREFIX}sub-1`, `manual email: ingested with a manual: external_id (got ${inb[0]?.external_id})`);
    assert(MANUAL_EMAIL_EXTERNAL_ID_PREFIX === 'manual:', 'manual email: prefix is manual:, distinct from sim: and dm-manual:');
    assert(inb[0].channel === 'email' && inb[0].status === 'classified', 'manual email: queued for the negotiator exactly like real inbound email');
    assert(
      store.all(FIRM_BLOCKS_TABLE).some((b) => b.firm_id === 'firm-A' && b.influencer_id === 'inf-1'),
      'manual email: STOP → per-label block for firm-A',
    );
    assert(
      !store.all(FIRM_BLOCKS_TABLE).some((b) => b.firm_id === 'firm-B'),
      "manual email: firm-A's opt-out does not block the creator for firm-B",
    );
    assert(msg(store, 'm-A-counter')?.status === 'superseded', `manual email: the queued email counter to the blocked creator is cancelled (got ${msg(store, 'm-A-counter')?.status})`);
    assert(msg(store, 'm-A')?.status === 'superseded', `manual email: the queued DM to the blocked creator is cancelled (got ${msg(store, 'm-A')?.status})`);
    assert(msg(store, 'm-A2')?.status === 'queued', 'manual email: another creator on the same campaign is untouched');
    assert(msg(store, 'm-B')?.status === 'queued', "manual email: the same creator's thread with ANOTHER label is untouched");

    const again = await logManualEmailReply({
      input: { campaign_influencer_id: 'ci-A', response_text: 'STOP', submission_id: 'sub-1' },
      callerFirmId: 'firm-A', loadLead, ingest,
    });
    assert(again.ok && again.ingest.deduped && store.all('inbound_messages').length === 1, 'manual email: a retried submission dedupes');

    // Wire-up (the handler needs Clerk).
    const route = stripComments(readFileSync(join(ROOT, 'src/app/api/outreach/respond/route.ts'), 'utf8'));
    assert(/logManualEmailReply\(/.test(route) && /ingestInboundReply\(/.test(route), 'route: respond routes through logManualEmailReply → ingestInboundReply');
    assert(/session\.firm_id/.test(route), 'route: respond passes the caller firm for the ownership check');
    assert(!/\.insert\(/.test(route), 'route: respond no longer writes outreach_messages itself (ingest owns the write)');
    const page = readFileSync(join(ROOT, 'src/app/outreach/page.tsx'), 'utf8');
    assert(/\/api\/outreach\/respond[\s\S]{0,400}submission_id/.test(page), 'page: the email log form sends a submission id so retries dedupe');
  }

  console.log(`firm-blocks-human-paths test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
