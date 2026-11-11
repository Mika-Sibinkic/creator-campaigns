import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
//
// tests/manual-send-claim.test.ts
//
// The manual Send route (POST /api/outreach/[id]/send) never claimed the row:
// it read the body, sent it, flipped the row to sent with no status check, and
// re-read offer_usd afterwards. An edit landing mid-send left the creator with
// the old text while the row recorded the new price, and "Sounds good!" was
// answered "Deal, $240 works" for a price the creator never saw. The Send
// button on a queued row and the dispatch pass could also both email it.
//
// Now the route takes the SAME claim the dispatch pass takes
// (src/lib/outbound-claim.ts): conditional on the status it read, RETURNING the
// row; it sends and records exactly what the claim returned; a lost claim is a
// 409; a failed send releases the row.
//
// The route itself needs Clerk + Resend, so this runs its steps in its own
// order against the in-memory store: loadSendableMessage (the real firm gate —
// the campaign is seeded WITH its firm, the proof bypassed the gate), then
// claimAndSendManual with the route's own `from`. A source check pins that the
// route really is wired that way.
//
// Hermetic: in-memory store, mock model provider, injected send/dispatch/clock.
// Run: npx tsx tests/manual-send-claim.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { registerProvider } from '../src/lib/model-provider';
import { runNegotiationTick, runDispatchPass, type DispatchFn } from '../src/lib/negotiation-tick';
import { lastSentOffer } from '../src/lib/last-sent-offer';
import { editOutboundMessage } from '../src/lib/counter-edit';
import { loadSendableMessage } from '../src/lib/outreach-send-gate';
import {
  MANUAL_SEND_LOST,
  claimAndSendManual,
  type ClaimedOutbound,
  type ManualSendOutcome,
} from '../src/lib/outbound-claim';
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

const NOW0 = Date.parse('2026-07-06T15:00:00.000Z'); // 10:00 at -5, inside the send window
const MIN = 60_000;
const HALF = () => 0.5;
const FIRM = 'firm-1';

type Out = { intent: string; counter_usd?: number | null };
let script: () => Out = () => ({ intent: 'unclear' });
registerProvider('mock', async () => JSON.stringify({ sentiment: 'neutral', confidence: 0.9, counter_usd: null, ...script() }));

type Store = ReturnType<typeof makeStore>;
type ProviderResult = { ok: boolean; message_id?: string | null; resolved_to: string; error?: string };

function world(b: Partial<Row> = {}): Store {
  const store = makeStore();
  store.seed('firms', { id: FIRM, name: 'Example Records', sender_name: null, outreach_prefs: {}, scraping_prefs: {} });
  // Seeded WITH its firm, so the real ownership gate passes (the r9 proof's
  // seedCampaign left firm_id unset and the gate 404'd).
  store.seed('campaigns', { id: 'camp-1', firm_id: FIRM, total_budget_usd: 1_000_000 });
  store.seed('influencers', { id: 'inf-1', blocklisted: false });
  store.seed('campaign_influencers', { id: 'ci-1', campaign_id: 'camp-1', influencer_id: 'inf-1' });
  store.seedOffer({
    id: 'offer-1', campaign_influencer_id: 'ci-1', campaign_id: 'camp-1', firm_id: FIRM,
    status: 'offered', initial_offer_usd: 150, current_offer_usd: 150, agreed_amount_usd: null, ceiling_usd: 250,
    rounds: 0, last_message_id: null, approved_at: null, approved_by_user_id: null, paid_at: null, posted_at: null,
    post_url: null, autonomy_mode: 'auto', opening_pct: null, injection_flagged: false,
    created_at: '2026-07-06T00:00:00.000Z', updated_at: '2026-07-06T00:00:00.000Z',
  });
  store.seed('outreach_messages', {
    id: 'msg-first', campaign_influencer_id: 'ci-1', message_type: 'initial', direction: 'outbound',
    channel: 'email', subject: 'Collab', body: 'Hi, paid collab. What do you charge?', status: 'sent',
    sent_at: '2026-07-05T15:00:00.000Z', send_after: null,
  });
  store.seed('outreach_messages', {
    id: 'B', campaign_influencer_id: 'ci-1', message_type: 'follow_up', direction: 'outbound',
    channel: 'email', subject: 'Re', body: 'Just checking in!', status: 'queued', sent_at: null,
    send_after: new Date(NOW0 + 3 * MIN).toISOString(), send_mode: 'auto', edited_by_user: false,
    created_at: '2026-07-06T00:00:00.000Z',
    ...b,
  });
  return store;
}

const rowB = (s: Store) => s.all('outreach_messages').find((r) => r.id === 'B') as Row;
const offer = (s: Store) => s.getOffer('offer-1') as Row;
const thread = (s: Store) => s.all('outreach_messages').filter((r) => r.campaign_influencer_id === 'ci-1');

/** The route's step 1: the real firm-first gate. */
async function gate(sb: SupabaseClient, id = 'B') {
  const g = await loadSendableMessage(sb, id, FIRM);
  assert(g.ok, `gate: the owner's own message passes the firm gate (got ${JSON.stringify(g)})`);
  if (!g.ok) throw new Error('gate refused');
  return g.message;
}

/** The route's step 3, with the `from` the route passes. */
function manualSend(
  sb: SupabaseClient,
  m: { status: string | null; send_after: string | null },
  send: (row: ClaimedOutbound) => Promise<ProviderResult>,
  nowMs = NOW0,
): Promise<ManualSendOutcome<ProviderResult>> {
  return claimAndSendManual(sb, { messageId: 'B', from: { status: m.status, send_after: m.send_after }, nowMs }, send);
}

async function main() {
  // ── 1. The r9 race: an edit lands while the manual send is in flight ──────
  {
    const s = world();
    const sb = s.sb;
    const m = await gate(sb);
    const creatorGot: string[] = [];
    let edit: Awaited<ReturnType<typeof editOutboundMessage>> | null = null;
    const out = await manualSend(sb, m, async (row) => {
      // The PATCH handler runs while Resend is in flight.
      edit = await editOutboundMessage(sb, { messageId: 'B', body: 'We can do $240 for the reel.', usd: 240 });
      creatorGot.push(row.body);
      return { ok: true, message_id: 'p-1', resolved_to: 't@x' };
    });
    const e = edit as Awaited<ReturnType<typeof editOutboundMessage>> | null;
    assert(out.kind === 'sent', `race: the send goes (got ${out.kind})`);
    assert(e?.kind === 'refused' && e.status === 409 && e.body.error === 'already_sent', `race: the mid-send edit is refused 409 already_sent (got ${JSON.stringify(e)})`);
    assert(JSON.stringify(creatorGot) === JSON.stringify(['Just checking in!']), `race: creator got the claimed text (got ${JSON.stringify(creatorGot)})`);
    const B = rowB(s);
    assert(B.body === 'Just checking in!', `race: the row records the text that was sent (got ${JSON.stringify(B.body)})`);
    assert(B.offer_usd == null, `race: the row records no unsent price (got ${String(B.offer_usd)})`);
    assert(B.status === 'sent' && B.sent_to === 't@x' && B.provider_message_id === 'p-1', 'race: final flip stamps sent_to + provider_message_id');
    assert(Number(offer(s).current_offer_usd) === 150, `race: standing offer unchanged (got ${String(offer(s).current_offer_usd)})`);
    const last = lastSentOffer(thread(s) as never);
    assert(last.usd !== 240, `race: lastSentOffer is not the unsent $240 (got ${JSON.stringify(last)})`);

    // The continuation from the proof: the creator says yes to what they saw.
    s.seed('inbound_messages', {
      id: 'i1', channel: 'email', external_id: 'sim:i1', creator_offer_id: null, campaign_influencer_id: 'ci-1',
      from_identity: 'sim', body: 'Sounds good!', received_at: new Date(NOW0 + 5 * MIN).toISOString(), status: 'classified',
      classification: { classification: 'negotiating', confidence: 0.8 },
    });
    script = () => ({ intent: 'accept', counter_usd: null });
    const sent2: string[] = [];
    const d2: DispatchFn = async (_sb, mm) => {
      sent2.push(String(mm.body));
      return { ok: true, provider_message_id: 'p', resolved_to: 't@x' };
    };
    await runNegotiationTick(sb, { now: NOW0 + 5 * MIN, rand: HALF, dispatch: d2, pollGmail: async () => ({ skipped: 'gmail_not_configured' as const }) });
    for (let t = NOW0 + 5 * MIN; t <= NOW0 + 40 * MIN; t += MIN) await runDispatchPass(sb, { now: t, rand: HALF, dispatch: d2 });
    const o = offer(s);
    assert(Number(o.agreed_amount_usd) !== 240 && Number(o.current_offer_usd) !== 240, `race: no deal at the unsent $240 (agreed=${String(o.agreed_amount_usd)} current=${String(o.current_offer_usd)})`);
    assert(!sent2.some((x) => x.includes('$240')), `race: nothing sent quotes $240 (got ${JSON.stringify(sent2)})`);
    script = () => ({ intent: 'unclear' });
  }

  // ── 2. The edit lands after the gate read but before the claim ────────────
  {
    const s = world();
    const sb = s.sb;
    const m = await gate(sb);
    const edit = await editOutboundMessage(sb, { messageId: 'B', body: 'We can do $240 for the reel.', usd: 240 });
    assert(edit.kind === 'saved', 'pre-claim edit: saved (the row is still queued)');
    const creatorGot: string[] = [];
    const out = await manualSend(sb, m, async (row) => {
      creatorGot.push(row.body);
      return { ok: true, message_id: 'p-2', resolved_to: 't@x' };
    });
    assert(out.kind === 'sent', 'pre-claim edit: the send goes');
    assert(creatorGot[0] === 'We can do $240 for the reel.', `pre-claim edit: the creator got the EDITED text, not the gate's stale read (got ${JSON.stringify(creatorGot)})`);
    assert(Number(rowB(s).offer_usd) === 240 && Number(offer(s).current_offer_usd) === 240, 'pre-claim edit: the price recorded is the price sent ($240)');
  }

  // ── 3. Double send: the dispatch pass claims between the gate and the claim
  {
    const s = world({ send_after: new Date(NOW0 - MIN).toISOString() });
    const sb = s.sb;
    const provider: string[] = [];
    const d: DispatchFn = async (_sb, mm) => {
      provider.push(`dispatch:${mm.id}`);
      return { ok: true, provider_message_id: 'pd', resolved_to: 't@x' };
    };
    const m = await gate(sb); // the button's request read the row as queued …
    await runDispatchPass(sb, { now: NOW0, rand: HALF, dispatch: d }); // … the minute pass sends it …
    const out = await manualSend(sb, m, async (row) => {
      provider.push(`manual:${row.id}`);
      return { ok: true, message_id: 'pm', resolved_to: 't@x' };
    });
    assert(out.kind === 'lost', `double (dispatch first): the manual claim is lost (got ${out.kind})`);
    assert(JSON.stringify(provider) === JSON.stringify(['dispatch:B']), `double (dispatch first): exactly one provider send (got ${JSON.stringify(provider)})`);
    assert(MANUAL_SEND_LOST.error === 'already sent', "double: the lost claim answers the client's 'already sent' key");
    assert(rowB(s).provider_message_id === 'pd', 'double (dispatch first): the dispatcher\'s stamp is not overwritten');
    const again = await loadSendableMessage(sb, 'B', FIRM);
    assert(!again.ok && again.status === 409, 'double (dispatch first): a retry click is refused by the gate');
  }
  {
    const s = world({ send_after: new Date(NOW0 - MIN).toISOString() });
    const sb = s.sb;
    const provider: string[] = [];
    const d: DispatchFn = async (_sb, mm) => {
      provider.push(`dispatch:${mm.id}`);
      return { ok: true, provider_message_id: 'pd', resolved_to: 't@x' };
    };
    const m = await gate(sb);
    const out = await manualSend(sb, m, async (row) => {
      // The minute pass fires while Resend is in flight for the button.
      await runDispatchPass(sb, { now: NOW0, rand: HALF, dispatch: d });
      provider.push(`manual:${row.id}`);
      return { ok: true, message_id: 'pm', resolved_to: 't@x' };
    });
    assert(out.kind === 'sent', 'double (manual first): the manual send goes');
    assert(JSON.stringify(provider) === JSON.stringify(['manual:B']), `double (manual first): exactly one provider send (got ${JSON.stringify(provider)})`);
    assert(rowB(s).provider_message_id === 'pm', 'double (manual first): the manual stamp is on the row');
  }
  {
    // Two clicks (two tabs) whose gate reads both saw the row queued.
    const s = world();
    const sb = s.sb;
    const provider: string[] = [];
    const m1 = await gate(sb);
    const m2 = await gate(sb);
    const send = async (row: ClaimedOutbound) => {
      provider.push(row.id);
      return { ok: true, message_id: 'pm', resolved_to: 't@x' };
    };
    const [a, b] = await Promise.all([manualSend(sb, m1, send), manualSend(sb, m2, send)]);
    assert([a.kind, b.kind].sort().join(',') === 'lost,sent', `double (two clicks): one sent, one lost (got ${a.kind},${b.kind})`);
    assert(provider.length === 1, `double (two clicks): exactly one provider send (got ${provider.length})`);
  }

  // ── 4. A failed send releases the row exactly as it was ──────────────────
  {
    const due = new Date(NOW0 + 3 * MIN).toISOString();
    const s = world({ send_after: due });
    const sb = s.sb;
    const m = await gate(sb);
    const out = await manualSend(sb, m, async () => ({ ok: false, resolved_to: '', error: 'resend 500' }));
    const B = rowB(s);
    assert(out.kind === 'failed', 'failure: reported as failed');
    assert(B.status === 'queued' && B.sent_at == null && B.send_after === due, `failure: released to queued with its schedule (got ${B.status}/${String(B.sent_at)}/${String(B.send_after)})`);
    const provider: string[] = [];
    await runDispatchPass(sb, { now: NOW0 + 3 * MIN, rand: HALF, dispatch: async (_sb, mm) => { provider.push(mm.id); return { ok: true, provider_message_id: 'pd', resolved_to: 't@x' }; } });
    assert(JSON.stringify(provider) === JSON.stringify(['B']), 'failure: the released queued row is dispatched on schedule, once');
  }
  {
    const s = world({ status: 'draft', send_after: null });
    const sb = s.sb;
    const m = await gate(sb);
    await manualSend(sb, m, async () => ({ ok: false, resolved_to: '', error: 'resend 500' }));
    const B = rowB(s);
    assert(B.status === 'draft' && B.sent_at == null, `failure: a draft is released back to draft (got ${B.status})`);
    const ok = await manualSend(sb, await gate(sb), async () => ({ ok: true, message_id: 'p', resolved_to: 't@x' }));
    assert(ok.kind === 'sent' && rowB(s).status === 'sent', 'failure: the released draft can be sent on retry');
  }
  {
    // A NULL status (the column default predates most writers) is claimable.
    const s = world({ status: null, send_after: null });
    const out = await manualSend(s.sb, await gate(s.sb), async () => ({ ok: true, message_id: 'p', resolved_to: 't@x' }));
    assert(out.kind === 'sent' && rowB(s).status === 'sent', 'null status: claimed and sent');
  }

  // ── 5. Statuses no path may send are never claimed ───────────────────────
  for (const st of ['failed', 'recorded']) {
    const s = world({ status: st, send_after: null });
    const sb = s.sb;
    const m = await gate(sb);
    let calls = 0;
    const out = await manualSend(sb, m, async () => { calls++; return { ok: true, resolved_to: 't@x' }; });
    assert(out.kind === 'not_sendable' && calls === 0 && rowB(s).status === st, `${st}: not sendable, nothing sent, row untouched`);
  }

  // ── 6. The claimed row turned DM-routed after the gate read ──────────────
  {
    const s = world();
    const sb = s.sb;
    const m = await gate(sb);
    rowB(s).send_mode = 'human_queue';
    let calls = 0;
    const out = await manualSend(sb, m, async () => { calls++; return { ok: true, resolved_to: 't@x' }; });
    assert(out.kind === 'not_email' && calls === 0 && rowB(s).status === 'queued' && rowB(s).sent_at == null, 'dm-routed since the read: released, nothing emailed');
  }

  // ── 7. Wiring: the route really runs these steps ─────────────────────────
  {
    const route = readFileSync(join(__dirname, '..', 'src/app/api/outreach/[id]/send/route.ts'), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    const gateAt = route.search(/loadSendableMessage\(sb, messageId, session\.firm_id\)/);
    const claimAt = route.search(/claimAndSendManual\(/);
    assert(gateAt > 0 && claimAt > gateAt, 'wire: the route gates first, then claims with claimAndSendManual');
    assert(/from: \{ status: m\.status, send_after: m\.send_after \}/.test(route), 'wire: the claim is conditional on the status the gate read');
    assert(/body: claimed\.body/.test(route) && /subject: claimed\.subject/.test(route), 'wire: the route sends the claimed body + subject');
    assert(!/body: m\.body/.test(route) && !/subject: m\.subject/.test(route), 'wire: never the pre-claim read');
    assert(!/status: 'sent'/.test(route.replace(/outreach_status: 'sent'/g, '')), 'wire: the route never flips a message to sent itself');
    assert(!/applySentCounterPrice\(/.test(route), 'wire: the price is recorded from the claim, never re-read by the route');
    assert(/MANUAL_SEND_LOST, \{ status: 409 \}/.test(route), 'wire: a lost claim is a 409');
    const tick = readFileSync(join(__dirname, '..', 'src/lib/negotiation-tick.ts'), 'utf8');
    assert(/claimOutboundRow\(sb, row\.id, nowMs, 'queued'\)/.test(tick) && !/async function claimQueuedRow/.test(tick), 'wire: the dispatch pass uses the same shared claim');
  }

  if (failures.length > 0) console.error('\nFailures:\n - ' + failures.join('\n - '));
  console.log(`manual-send-claim test: ${passed}/${passed + failed} pass`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
