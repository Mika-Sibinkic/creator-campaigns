// tests/dm-reply.test.ts
//
// A creator who answers by Instagram or TikTok DM had no way into the
// negotiator. The only operator path, /api/outreach/respond, writes an inbound
// outreach_messages row and stops — it never writes inbound_messages, which is
// the ONLY table negotiation-tick reads. So a DM reply logged by hand
// classified, advanced the lead, and then nothing ever answered it.
//
// src/lib/dm-reply.ts closes that: an operator-pasted DM reply is normalized
// with the lead's DM channel and handed to ingestInboundReply — the same seam
// email and the simulator use. This suite proves, hermetically:
//
//   1. the pure pieces: channel vocabulary, the `dm-manual:` provenance marker
//      (distinct from `sim:` and from email provider ids), the default channel
//      a lead's reply is logged on, and which leads the DM queue offers;
//   2. the authorization shell: non-DM channel, empty text, unknown lead and
//      cross-firm lead are all refused BEFORE anything is written;
//   3. end to end through the real ingest + real negotiation tick: the reply
//      lands in inbound_messages on the DM channel, the negotiator answers it,
//      the answer is queued `human_queue` on that DM channel, the auto-sender
//      never touches it, and it shows up in the DM queue's own item list;
//   4. a retried submission (same submission id) is written once;
//   5. a reply for a creator no DM was sent to (in that campaign) is refused
//      409 — it would mark them contacted and let their opener skip the
//      first-touch gate.
//
// Run: npx tsx tests/dm-reply.test.ts

import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
import { registerProvider } from '../src/lib/model-provider';
import { ingestInboundReply, type NormalizedInbound } from '../src/lib/ingest-inbound';
import { runNegotiationTick, type DispatchFn, type DueOutbound } from '../src/lib/negotiation-tick';
import {
  DM_REPLY_CHANNELS,
  MANUAL_DM_EXTERNAL_ID_PREFIX,
  buildManualDmInbound,
  dmReplyLeads,
  isDmReplyChannel,
  isSentDmOutbound,
  logManualDmReply,
  readSentDmToLead,
  manualDmExternalId,
  type ManualDmLead,
} from '../src/lib/dm-reply';
import { dmQueueItems } from '../src/app/outreach/dm-queue-tab';
import { makeStore } from './negotiation-harness/store';

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

// "$300" over-ask → midpoint COUNTER (over the $200 ceiling, rounds < max).
registerProvider('mock', async ({ user }) => {
  if (user.includes('$300')) {
    return JSON.stringify({ intent: 'counter', counter_usd: 300, sentiment: 'neutral', confidence: 0.9 });
  }
  return JSON.stringify({ intent: 'unclear', counter_usd: null, sentiment: 'neutral', confidence: 0.9 });
});

const NOW0 = Date.parse('2026-09-14T15:00:00.000Z');
const HALF_RAND = () => 0.5;
const noopPoll = async () => ({ skipped: 'gmail_not_configured' as const });
const SUBMISSION = '6f1c2a4e-9b1d-4c7e-8f00-1a2b3c4d5e6f';

// ════════════════════════════════════════════════════════════════════════════
// 1. Pure pieces
// ════════════════════════════════════════════════════════════════════════════

assert(
  JSON.stringify([...DM_REPLY_CHANNELS]) === JSON.stringify(['instagram_dm', 'tiktok_dm']),
  'DM reply channels are exactly the two human-queue DM channels',
);
assert(isDmReplyChannel('instagram_dm') && isDmReplyChannel('tiktok_dm'), 'isDmReplyChannel: both DM channels');
for (const bad of ['email', 'dm', 'linkedin_dm', 'instagram', '', null, undefined]) {
  assert(!isDmReplyChannel(bad), `isDmReplyChannel refuses ${JSON.stringify(bad)}`);
}

// The provenance marker.
assert(MANUAL_DM_EXTERNAL_ID_PREFIX === 'dm-manual:', 'marker prefix is dm-manual:');
assert(manualDmExternalId(SUBMISSION) === `dm-manual:${SUBMISSION}`, 'external id = prefix + submission id');
// Distinct from every other reply source's namespace: simulator, and the
// email providers (email-inbound.ts writes `${provider}:${id}`).
for (const other of ['sim:', 'resend:', 'gmail:']) {
  assert(
    !MANUAL_DM_EXTERNAL_ID_PREFIX.startsWith(other) && !other.startsWith(MANUAL_DM_EXTERNAL_ID_PREFIX),
    `marker prefix cannot collide with ${other}`,
  );
}

// The normalized row handed to ingestInboundReply.
{
  const n = buildManualDmInbound({
    campaignInfluencerId: 'ci-1',
    channel: 'instagram_dm',
    text: '  Can you do $300?  ',
    submissionId: SUBMISSION,
    creatorHandle: '@rowan_example',
  });
  assert(n.channel === 'instagram_dm', 'normalized: channel is the DM channel');
  assert(n.external_id === `dm-manual:${SUBMISSION}`, 'normalized: external_id carries the marker');
  assert(n.from_identity === '@rowan_example', `normalized: from_identity is the creator handle (got ${n.from_identity})`);
  assert(n.body === 'Can you do $300?', 'normalized: body is trimmed');
  assert(n.campaign_influencer_id === 'ci-1', 'normalized: matched to the lead, so ingest mirrors + advances it');
  assert(n.raw_body == null && n.sender_authenticated == null, 'normalized: no provider evidence is claimed for a hand-typed reply');
}
{
  const n = buildManualDmInbound({
    campaignInfluencerId: 'ci-1',
    channel: 'tiktok_dm',
    text: 'yes',
    submissionId: SUBMISSION,
    creatorHandle: null,
  });
  assert(n.from_identity === 'dm-manual', `normalized: no handle → a non-empty marker identity (got ${n.from_identity})`);
}
{
  let threw = false;
  try {
    buildManualDmInbound({
      campaignInfluencerId: 'ci-1',
      channel: 'email' as never,
      text: 'yes',
      submissionId: SUBMISSION,
      creatorHandle: null,
    });
  } catch {
    threw = true;
  }
  assert(threw, 'buildManualDmInbound refuses a non-DM channel outright');
}

// The lead view's default: the channel we last actually DM'd this lead on
// (outreach/page.tsx calls dmReplyLeads([entry])[0]?.channel).
{
  const one = (messages: Array<{ direction: string; channel: string; sent_at: string | null; created_at: string }>) =>
    dmReplyLeads([
      { id: 'ci-x', influencer: { username: 'x', platform: 'tiktok' }, campaign: null, messages },
    ])[0]?.channel ?? null;
  assert(
    one([
      { direction: 'outbound', channel: 'tiktok_dm', sent_at: '2026-09-01T00:00:00Z', created_at: '2026-09-01T00:00:00Z' },
      { direction: 'outbound', channel: 'instagram_dm', sent_at: '2026-09-03T00:00:00Z', created_at: '2026-09-03T00:00:00Z' },
      { direction: 'outbound', channel: 'tiktok_dm', sent_at: null, created_at: '2026-09-04T00:00:00Z' },
      { direction: 'inbound', channel: 'tiktok_dm', sent_at: '2026-09-05T00:00:00Z', created_at: '2026-09-05T00:00:00Z' },
    ]) === 'instagram_dm',
    'lead default: the most recent SENT outbound DM wins (not a draft, not an inbound)',
  );
  assert(
    one([{ direction: 'outbound', channel: 'email', sent_at: '2026-09-01T00:00:00Z', created_at: '2026-09-01T00:00:00Z' }]) === null,
    'lead default: an email-only lead is not a DM lead, so the form keeps defaulting to email',
  );
}

// Which leads the DM queue offers for logging a reply.
{
  const entries = [
    {
      id: 'ci-sent-ig',
      influencer: { username: 'ig_one', platform: 'tiktok' },
      campaign: { artist_name: 'Ada Sample' },
      messages: [{ direction: 'outbound', channel: 'instagram_dm', sent_at: '2026-09-02T00:00:00Z', created_at: '2026-09-02T00:00:00Z' }],
    },
    {
      id: 'ci-draft-only',
      influencer: { username: 'draft', platform: 'tiktok' },
      campaign: { artist_name: 'Ada Sample' },
      messages: [{ direction: 'outbound', channel: 'tiktok_dm', sent_at: null, created_at: '2026-09-02T00:00:00Z' }],
    },
    {
      id: 'ci-email',
      influencer: { username: 'mail', platform: 'tiktok' },
      campaign: { artist_name: 'Ada Sample' },
      messages: [{ direction: 'outbound', channel: 'email', sent_at: '2026-09-02T00:00:00Z', created_at: '2026-09-02T00:00:00Z' }],
    },
    {
      id: 'ci-sent-tt',
      influencer: { username: 'tt_two', platform: 'tiktok' },
      campaign: null,
      messages: [{ direction: 'outbound', channel: 'tiktok_dm', sent_at: '2026-09-05T00:00:00Z', created_at: '2026-09-05T00:00:00Z' }],
    },
  ];
  const leads = dmReplyLeads(entries);
  assert(
    JSON.stringify(leads.map((l) => l.id)) === JSON.stringify(['ci-sent-tt', 'ci-sent-ig']),
    `dmReplyLeads: only leads with a SENT DM, most recent first (got ${JSON.stringify(leads.map((l) => l.id))})`,
  );
  assert(leads[1].channel === 'instagram_dm' && leads[1].username === 'ig_one', 'dmReplyLeads: carries the default channel + handle');
}

// ════════════════════════════════════════════════════════════════════════════
// 2. The authorization shell refuses before anything is written
// ════════════════════════════════════════════════════════════════════════════

async function shell() {
  const lead: ManualDmLead = { firm_id: 'firm-1', username: 'rowan_example', has_offer: true, sent_dm: true };
  let ingested: NormalizedInbound[] = [];
  const ingest = async (n: NormalizedInbound) => {
    ingested.push(n);
    return {
      deduped: false,
      inbound_message_id: 'inb-1',
      outreach_message_id: 'om-1',
      classification: 'negotiating',
      confidence: 0.8,
      status: 'classified' as const,
      campaign_influencer_advanced: true,
    };
  };
  const base = {
    input: { campaign_influencer_id: 'ci-1', channel: 'instagram_dm', text: 'Can you do $300?', submission_id: SUBMISSION },
    callerFirmId: 'firm-1',
    loadLead: async () => lead,
    ingest,
  };

  const email = await logManualDmReply({ ...base, input: { ...base.input, channel: 'email' } });
  assert(!email.ok && email.status === 400, 'shell: an email channel is refused 400 — this path is DM only');
  const blank = await logManualDmReply({ ...base, input: { ...base.input, text: '   ' } });
  assert(!blank.ok && blank.status === 400, 'shell: whitespace-only text is refused 400');
  const missing = await logManualDmReply({ ...base, loadLead: async () => null });
  assert(!missing.ok && missing.status === 404, 'shell: a lead the caller cannot see is 404');
  const other = await logManualDmReply({ ...base, loadLead: async () => ({ ...lead, firm_id: 'firm-2' }) });
  assert(!other.ok && other.status === 403, 'shell: a lead owned by another firm is 403');
  const unscoped = await logManualDmReply({ ...base, callerFirmId: '' });
  assert(!unscoped.ok && unscoped.status === 403, 'shell: an unprovisioned caller (firm "") is 403');
  assert(ingested.length === 0, `shell: no refusal wrote anything (got ${ingested.length} ingests)`);

  ingested = [];
  const ok = await logManualDmReply(base);
  assert(ok.ok, 'shell: a valid DM reply for the caller\'s own lead is accepted');
  assert(ingested.length === 1, 'shell: exactly one ingest');
  assert(
    ingested[0]?.channel === 'instagram_dm' && ingested[0]?.external_id === `dm-manual:${SUBMISSION}` && ingested[0]?.from_identity === '@rowan_example',
    'shell: ingest receives the DM channel, the marker and the handle',
  );
  assert(ok.ok && ok.negotiator_will_answer === true, 'shell: reports the negotiator will answer when an offer exists');

  const noOffer = await logManualDmReply({ ...base, loadLead: async () => ({ ...lead, has_offer: false }) });
  assert(noOffer.ok && noOffer.negotiator_will_answer === false, 'shell: says so when there is no offer for the negotiator to work');

  // Regression: a "reply" for a creator who never got a DM
  // would mark them contacted, so their opener later skipped the first-touch
  // gate. Refused 409 unless a DM was sent to them in this campaign.
  ingested = [];
  const neverDmd = await logManualDmReply({ ...base, loadLead: async () => ({ ...lead, has_offer: false, sent_dm: false }) });
  assert(!neverDmd.ok && neverDmd.status === 409 && neverDmd.error === 'no_dm_sent', `shell: no DM sent to this creator → 409 no_dm_sent (got ${JSON.stringify(neverDmd)})`);
  const unreadable = await logManualDmReply({ ...base, loadLead: async () => ({ ...lead, sent_dm: null }) });
  assert(!unreadable.ok && unreadable.status === 503, 'shell: DM history unreadable → 503, fail closed');
  assert(ingested.length === 0, `shell: neither wrote anything (got ${ingested.length} ingests)`);
}

// ════════════════════════════════════════════════════════════════════════════
// 2b. "Was a DM sent to this creator in this campaign?" against the store
// ════════════════════════════════════════════════════════════════════════════

async function sentDmRead() {
  const s = makeStore();
  const om = (row: Record<string, unknown>) =>
    s.seed('outreach_messages', { direction: 'outbound', body: 'x', message_type: 'initial', created_at: '2026-09-14T00:00:00.000Z', ...row });
  om({ id: 'q-1', campaign_influencer_id: 'ci-1', channel: 'tiktok_dm', send_mode: 'human_queue', status: 'queued', sent_at: null });
  om({ id: 'e-1', campaign_influencer_id: 'ci-1', channel: 'email', send_mode: 'auto', status: 'sent', sent_at: '2026-09-14T00:00:00.000Z' });
  om({ id: 'in-1', campaign_influencer_id: 'ci-1', direction: 'inbound', channel: 'instagram_dm', sent_at: '2026-09-14T00:00:00.000Z' });
  assert((await readSentDmToLead(s.sb, 'ci-1')) === false, 'sent-dm: a queued DM, a sent email and an inbound row are not a sent DM');

  om({ id: 'q-2', campaign_influencer_id: 'ci-2', channel: 'instagram_dm', send_mode: 'human_queue', status: 'sent', sent_at: '2026-09-14T00:00:00.000Z' });
  assert((await readSentDmToLead(s.sb, 'ci-2')) === true, 'sent-dm: a hand-sent DM counts');
  // A draft rerouted from the email path keeps channel 'email' but is human_queue.
  om({ id: 'q-3', campaign_influencer_id: 'ci-3', channel: 'email', send_mode: 'human_queue', status: 'sent', sent_at: '2026-09-14T00:00:00.000Z' });
  assert((await readSentDmToLead(s.sb, 'ci-3')) === true, 'sent-dm: a rerouted human_queue row counts');
  // Another campaign's lead for the same creator is a different campaign_influencers row.
  assert((await readSentDmToLead(s.sb, 'ci-9')) === false, 'sent-dm: nothing for this lead → false');

  assert(isSentDmOutbound({ direction: 'outbound', channel: 'dm', send_mode: null, sent_at: 'x', status: 'sent' }), 'sent-dm: legacy dm channel counts');
  assert(!isSentDmOutbound({ direction: 'outbound', channel: 'tiktok_dm', send_mode: 'human_queue', sent_at: null, status: 'queued' }), 'sent-dm: unsent never counts');
}

// ════════════════════════════════════════════════════════════════════════════
// 3 + 4. End to end: real ingest, real tick
// ════════════════════════════════════════════════════════════════════════════

async function endToEnd() {
  const store = makeStore();
  store.seedCampaign('camp-DM', null);
  store.seed('campaign_influencers', {
    id: 'ci-DM',
    campaign_id: 'camp-DM',
    influencer_id: 'inf-DM',
    status: 'contacted',
    outreach_status: 'sent',
    last_response_at: null,
  });
  store.seed('creator_offers', {
    id: 'offer-DM',
    campaign_influencer_id: 'ci-DM',
    campaign_id: 'camp-DM',
    firm_id: 'firm-1',
    status: 'offered',
    initial_offer_usd: 100,
    current_offer_usd: 100,
    agreed_amount_usd: null,
    ceiling_usd: 200,
    rounds: 0,
    last_message_id: null,
    approved_at: null,
    approved_by_user_id: null,
    paid_at: null,
    posted_at: null,
    post_url: null,
    autonomy_mode: 'auto',
    opening_pct: null,
    injection_flagged: false,
    created_at: '2026-09-14T00:00:00.000Z',
    updated_at: '2026-09-14T00:00:00.000Z',
  });

  const dispatchCalls: DueOutbound[] = [];
  const dispatch: DispatchFn = async (_sb, msg) => {
    dispatchCalls.push(msg);
    return { ok: true, provider_message_id: 'prov-x', resolved_to: 'x@example.com' };
  };

  const run = () =>
    logManualDmReply({
      input: {
        campaign_influencer_id: 'ci-DM',
        channel: 'instagram_dm',
        text: 'Honestly I need $300 for a reel',
        submission_id: SUBMISSION,
      },
      callerFirmId: 'firm-1',
      loadLead: async () => ({ firm_id: 'firm-1', username: 'rowan_example', has_offer: true, sent_dm: true }),
      ingest: (n) => ingestInboundReply(n, store.sb),
    });

  const first = await run();
  assert(first.ok && first.ingest.deduped === false, 'e2e: first submission is written');

  const inbound = store.all('inbound_messages');
  assert(inbound.length === 1, `e2e: one inbound_messages row — the table the negotiator reads (got ${inbound.length})`);
  assert(inbound[0]?.channel === 'instagram_dm', `e2e: inbound row is on the DM channel (got ${String(inbound[0]?.channel)})`);
  assert(
    String(inbound[0]?.external_id).startsWith(MANUAL_DM_EXTERNAL_ID_PREFIX),
    `e2e: inbound row carries the dm-manual: marker (got ${String(inbound[0]?.external_id)})`,
  );
  assert(inbound[0]?.campaign_influencer_id === 'ci-DM', 'e2e: inbound row is matched to the lead');

  const mirrored = store.all('outreach_messages').filter((m) => m.direction === 'inbound');
  assert(mirrored.length === 1 && mirrored[0].channel === 'instagram_dm', 'e2e: thread shows the reply on the DM channel');
  const ci = store.all('campaign_influencers').find((r) => r.id === 'ci-DM');
  assert(ci?.outreach_status === 'responded', `e2e: lead advanced to responded (got ${String(ci?.outreach_status)})`);

  // 4. A retried submission (network blip, double click) is written once.
  const again = await run();
  assert(again.ok && again.ingest.deduped === true, 'e2e: the same submission id dedupes');
  assert(store.all('inbound_messages').length === 1, 'e2e: still exactly one inbound row after the retry');

  // The negotiator answers it.
  const t1 = await runNegotiationTick(store.sb, { now: NOW0, rand: HALF_RAND, dispatch, pollGmail: noopPoll });
  assert(t1.processed === 1, `e2e: the tick processed the DM reply (processed=${t1.processed}, skipped=${t1.skipped})`);
  const counters = store.all('outreach_messages').filter((m) => m.direction === 'outbound');
  assert(counters.length === 1, `e2e: the negotiator drafted one answer (got ${counters.length})`);
  const counter = counters[0];
  assert(counter?.channel === 'instagram_dm', `e2e: the answer stays on the DM channel (got ${String(counter?.channel)})`);
  assert(counter?.send_mode === 'human_queue', `e2e: the answer is human_queue (got ${String(counter?.send_mode)})`);
  assert(counter?.needs_human === true, 'e2e: the answer needs a human');

  // Never auto-sent, even well past its send_after.
  const t2 = await runNegotiationTick(store.sb, {
    now: NOW0 + 6 * 3600_000,
    rand: HALF_RAND,
    dispatch,
    pollGmail: noopPoll,
  });
  assert(t2.sent === 0 && dispatchCalls.length === 0, 'e2e: the auto-sender never touches the DM answer');
  const after = store.all('outreach_messages').find((m) => m.id === counter?.id);
  assert(after?.sent_at == null && after?.status === 'queued', 'e2e: the DM answer is still queued, unsent');

  // And it is in the DM queue, as the operator will see it.
  const items = dmQueueItems(
    [
      {
        id: 'ci-DM',
        // Stamped by the listing (src/lib/outreach-listing.ts); without it the
        // queue holds the row — do-not-contact is fail-closed.
        do_not_contact: 'clear',
        influencer: { username: 'rowan_example', display_name: 'Rowan', platform: 'instagram', profile_url: null },
        campaign: { artist_name: 'Ada Sample' },
        messages: store.all('outreach_messages').map((m) => ({
          id: String(m.id),
          subject: (m.subject as string | null) ?? null,
          body: String(m.body ?? ''),
          channel: String(m.channel),
          direction: String(m.direction),
          sent_at: (m.sent_at as string | null) ?? null,
          created_at: String(m.created_at ?? '2026-09-14T15:00:00.000Z'),
          message_type: String(m.message_type),
          send_mode: (m.send_mode as string | null) ?? null,
          status: (m.status as string | null) ?? null,
          send_after: (m.send_after as string | null) ?? null,
        })),
      },
    ],
    NOW0 + 6 * 3600_000,
  );
  assert(items.length === 1 && items[0].msg.id === counter?.id, `e2e: the answer is the one DM queue item (got ${items.length})`);
  assert(items[0]?.target.channel === 'instagram_dm', 'e2e: the queue addresses it to Instagram');
}

async function main() {
  await shell();
  await sentDmRead();
  await endToEnd();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
