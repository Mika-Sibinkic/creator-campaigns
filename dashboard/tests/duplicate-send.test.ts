// tests/duplicate-send.test.ts
//
// THE DUPLICATE SEND. Pins the one failure this whole area exists to prevent:
// a creator receiving the SAME message twice, in the SAME inbox, because two
// parts of the system disagreed about which channel the first one went out on.
//
// How it happened:
//
//   1. `resolveOutreachChannel` resolves the legacy `primary_channel='dm'` to a
//      concrete channel — tiktok_dm for a TikTok creator. Legacy
//      `campaign_influencers` rows carry 'dm' on TikTok creators.
//   2. draft-all stamps `channel='tiktok_dm'` on the MESSAGE and wrote nothing
//      back to `campaign_influencers`. `markHumanQueueSent` didn't either.
//   3. Human sends the DM, clicks Mark sent → outreach_status='sent',
//      last_outreach_at=now.
//   4. After the silence window `escalateSilentLeads` sees outreach_status
//      ='sent', primary_channel='dm', channels_tried=[] — and
//      `attemptedChannels` recorded the literal 'dm', so tried={'dm'} while
//      available=['tiktok_dm']. tiktok_dm ∉ tried → ESCALATE.
//   5. The escalation inserts a `follow_up` carrying `prev.body` VERBATIM with
//      channel='tiktok_dm', send_mode='human_queue'.
//   6. It lands in the DM queue indistinguishable from a first touch and the
//      human pastes the identical message into the same TikTok inbox.
//
// `channels_tried` is empty on every legacy row, so it had never fired. Every
// legacy 'dm' row was one Mark-sent click and one silence window away from firing.
//
// This suite is written as invariants, not as a single reproduction, because a
// single reproduction can be made to pass by special-casing tiktok. The
// load-bearing case is §5: an EXHAUSTIVE round trip asserting that for every
// (platform, email) shape, whatever `resolveOutreachChannel` would send a
// legacy 'dm' on is a channel `attemptedChannels` reports as already attempted.
// That is the invariant the bug violated, and it cannot be satisfied by a
// resolver change that forgets to update the bookkeeping, or vice versa.
//
// Also covers, in the same area:
//   * markHumanQueueSent's send-time write-back (§6) — the DATA fix, so a row
//     says what actually happened; unions channels_tried, never replaces it.
//   * outreachDispatchFields (§7) — channel + send_mode + needs_human are only
//     correct together, and 'dm' is not in migration 018's CHECK constraint.
//   * routingPriors (§8) — the router preferring observed evidence over
//     migration 020's "STARTING GUESS", without locking onto whichever channel
//     happened to be sent on first.
//
// Hermetic: pure functions plus the in-memory store. No DB, no clock, no model,
// no network, no send.
//
// Run: npx tsx tests/duplicate-send.test.ts

import {
  attemptedChannels,
  escalationDecision,
  escalationPrefs,
  type EscalationInput,
  type LeadEscalationState,
} from '../src/lib/escalation';
import {
  DM_CHANNELS,
  LEGACY_DM_CHANNEL,
  expandLegacyDmChannel,
  isLegacyDmChannel,
  outreachDispatchFields,
  resolveOutreachChannel,
} from '../src/lib/social-dispatch';
import {
  ROUTING_OBSERVED_FULL_CONFIDENCE_N,
  ROUTING_PRIOR_SCALE,
  availableChannels,
  pickBestChannel,
  priorScore,
  routingPriors,
  type ChannelPrior,
  type ContactCandidate,
  type ContactChannel,
} from '../src/lib/contact-discovery';
import { markHumanQueueSent } from '../src/lib/channel-priors';
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

const HOUR_MS = 3_600_000;
const NOW = Date.parse('2026-09-23T15:00:00.000Z');
/** Four days of silence — past the 72h default window. */
const CONTACTED_AT = new Date(NOW - 96 * HOUR_MS).toISOString();

/**
 * The shape of a legacy 'dm' lead the human has already DM'd, byte for byte:
 * outreach_status='sent' (markHumanQueueSent), primary_channel='dm' (nothing
 * wrote it back), channels_tried=[] (true of every legacy row),
 * next_attempt_at=null (never escalated), one outbound send on the books.
 */
function liveDmLead(over: Partial<LeadEscalationState> = {}): LeadEscalationState {
  return {
    campaign_influencer_id: 'ci-live',
    outreach_status: 'sent',
    primary_channel: LEGACY_DM_CHANNEL,
    channels_tried: [],
    next_attempt_at: null,
    last_outreach_at: CONTACTED_AT,
    outbound_count: 1,
    contact_blocked: false,
    ...over,
  };
}

function input(over: Partial<EscalationInput> = {}): EscalationInput {
  return {
    lead: liveDmLead(),
    available: ['tiktok_dm'],
    priors: null,
    prefs: escalationPrefs(undefined),
    window: null,
    nowMs: NOW,
    ...over,
  };
}

function emailCandidate(address: string): ContactCandidate {
  return { channel: 'email', address, source: 'profile', confidence: 1 };
}

async function main() {
  // ── 1. THE TEST THAT MATTERS ───────────────────────────────────────────────
  //
  // A lead with primary_channel='dm' on a TikTok creator, already contacted by
  // DM, must not be escalated onto tiktok_dm again. This is the legacy 'dm'
  // shape; nothing else in this file matters if this regresses.
  {
    const available = availableChannels([], 'tiktok');
    assert(
      available.length === 1 && available[0] === 'tiktok_dm',
      `the live creator shape (TikTok, no email) is reachable only on tiktok_dm (got ${JSON.stringify(available)})`,
    );

    const tried = attemptedChannels(liveDmLead(), available);
    assert(
      tried.includes('tiktok_dm'),
      'a legacy primary_channel=\'dm\' on a TikTok creator counts tiktok_dm as ALREADY ATTEMPTED',
    );

    const d = escalationDecision(input({ available }));
    assert(
      d.action === 'skip',
      `a TikTok \'dm\' lead already DM\'d is NOT escalated (got ${d.action === 'escalate' ? `escalate→${d.channel}` : 'skip'})`,
    );
    assert(
      d.action === 'skip' && d.reason === 'no_untried_channel',
      'and the refusal names the real reason: every channel this creator has was already tried',
    );
  }

  // ── 2. Same for Instagram — not a tiktok special case ─────────────────────
  {
    const available = availableChannels([], 'instagram');
    const d = escalationDecision({ ...input({ available }) });
    assert(
      d.action === 'skip' && d.reason === 'no_untried_channel',
      'an Instagram \'dm\' lead is not escalated onto instagram_dm either',
    );
  }

  // ── 3. The fix does not over-block: a real untried channel still escalates ─
  //
  // Some legacy 'dm' rows DO have an email. resolveOutreachChannel's 'dm'
  // branch runs BEFORE its email branch, so those were DM'd, not emailed —
  // email is genuinely untried and escalating to it is the feature working.
  {
    const available = availableChannels([emailCandidate('a@b.example')], 'tiktok');
    assert(
      available.includes('email') && available.includes('tiktok_dm'),
      'a TikTok creator with an email is reachable on both',
    );
    const d = escalationDecision(input({ available }));
    assert(
      d.action === 'escalate' && d.channel === 'email',
      `a \'dm\' lead with an untried email escalates to EMAIL (got ${d.action === 'escalate' ? d.channel : `skip:${d.reason}`})`,
    );
    assert(
      d.action === 'escalate' && d.next_channels_tried.includes('tiktok_dm'),
      'and the persisted channels_tried carries the expanded concrete channel, so the row stops being legacy',
    );
  }

  // ── 4. Ambiguity fails CLOSED, both DMs masked ────────────────────────────
  //
  // Nothing in the data model reaches a creator on two DM channels today (one
  // platform per influencers row), but 'dm' names no platform, so if it ever
  // does we cannot know which inbox got the message. Masking both is the only
  // answer that cannot send a second copy.
  {
    const d = escalationDecision(
      input({ available: ['email', 'instagram_dm', 'tiktok_dm'] }),
    );
    assert(
      d.action === 'escalate' && d.channel === 'email',
      `with both DM channels reachable a legacy \'dm\' masks BOTH and only email is left (got ${d.action === 'escalate' ? d.channel : `skip:${d.reason}`})`,
    );

    // And with no email at all there is nothing safe to escalate to.
    const d2 = escalationDecision(input({ available: ['instagram_dm', 'tiktok_dm'] }));
    assert(
      d2.action === 'skip' && d2.reason === 'no_untried_channel',
      'ambiguous \'dm\' with no email refuses rather than guessing an inbox',
    );

    // An unroutable 'dm' (no platform, no email) resolved to email in the
    // resolver's `platformDm ?? 'email'` fallback — so email is attempted.
    assert(
      expandLegacyDmChannel(['email']).includes('email'),
      'a \'dm\' on a creator with no DM channel at all masks email, matching the resolver fallback',
    );
    const d3 = escalationDecision(input({ available: ['email'] }));
    assert(
      d3.action === 'skip' && d3.reason === 'no_untried_channel',
      'and such a lead is not re-emailed',
    );
  }

  // ── 5. THE INVARIANT — resolver and bookkeeping cannot drift apart ────────
  //
  // For EVERY creator shape: the channel resolveOutreachChannel would send a
  // legacy 'dm' on must be in the attempted set, and must never be the channel
  // escalation picks. This is what makes the fix un-reintroducible — a future
  // change to either side that is not mirrored in the other fails here.
  {
    const platforms = [null, 'tiktok', 'instagram', 'youtube', ''];
    const emails = [null, '', 'creator@example.com', 'not-an-email'];
    let drift = 0;
    let repick = 0;
    let cases = 0;

    for (const platform of platforms) {
      for (const contactEmail of emails) {
        cases++;
        const sentOn = resolveOutreachChannel({
          primaryChannel: LEGACY_DM_CHANNEL,
          platform,
          contactEmail,
        });
        const candidates =
          typeof contactEmail === 'string' && contactEmail.includes('@')
            ? [emailCandidate(contactEmail)]
            : [];
        const available = availableChannels(candidates, platform);
        const tried = attemptedChannels(liveDmLead(), available);
        if (!tried.includes(sentOn)) {
          drift++;
          console.error(
            `    drift: platform=${platform} email=${contactEmail} → sent on ${sentOn}, attempted=${JSON.stringify(tried)}`,
          );
        }
        const d = escalationDecision(input({ available }));
        if (d.action === 'escalate' && d.channel === sentOn) {
          repick++;
          console.error(
            `    repick: platform=${platform} email=${contactEmail} → escalated onto ${sentOn}`,
          );
        }
      }
    }

    assert(cases === 20, `the round trip covers every shape (got ${cases})`);
    assert(
      drift === 0,
      `the channel a legacy 'dm' is SENT on is always reported as ATTEMPTED (${drift} shapes drifted)`,
    );
    assert(
      repick === 0,
      `escalation never re-picks the channel a legacy 'dm' was sent on (${repick} shapes re-picked)`,
    );
  }

  // ── 5b. The legacy value survives in the attempted set ───────────────────
  {
    const tried = attemptedChannels(liveDmLead(), ['tiktok_dm']);
    assert(
      tried.includes(LEGACY_DM_CHANNEL),
      'the literal \'dm\' is kept alongside its expansion — it is a true record of what the row said',
    );
    // A legacy 'dm' that somehow reached channels_tried is expanded too, not
        // only one sitting in primary_channel.
    const viaTried = attemptedChannels(
      liveDmLead({ primary_channel: null, channels_tried: ['dm'] }),
      ['tiktok_dm'],
    );
    assert(
      viaTried.includes('tiktok_dm'),
      'a legacy \'dm\' inside channels_tried is expanded as well as one in primary_channel',
    );
    assert(
      isLegacyDmChannel('dm') &&
        !isLegacyDmChannel('tiktok_dm') &&
        !isLegacyDmChannel(null),
      'isLegacyDmChannel matches only the pre-split value',
    );
    assert(
      !DM_CHANNELS.includes('linkedin_dm' as ContactChannel),
      'linkedin_dm is not a DM channel a legacy \'dm\' could have meant — nothing discovers or sends it',
    );
    // Backward compatible: the one-argument form still works for callers that
    // have no `available` to hand.
    assert(
      attemptedChannels(liveDmLead()).includes('dm'),
      'attemptedChannels(lead) with no available list still compiles and records the raw value',
    );
  }

  // ── 6. markHumanQueueSent writes the resolved channel back ────────────────
  //
  // The send-time half. escalation.ts's expansion makes the READ safe on the
  // rows that already exist; this makes the DATA true going forward, and is
  // the ONLY fix for rows where primary_channel is NULL — a NULL
  // expands to nothing, so those rows would escalate onto the channel they were
  // contacted on with no legacy value to expand.
  {
    const store = makeStore();
    store.seed('campaign_influencers', {
      id: 'ci-dm',
      status: 'draft_ready',
      outreach_status: 'draft_ready',
      primary_channel: 'dm',
      channels_tried: [],
      last_outreach_at: null,
    });
    store.seed('outreach_messages', {
      id: 'om-dm',
      campaign_influencer_id: 'ci-dm',
      channel: 'tiktok_dm',
      direction: 'outbound',
      status: 'queued',
      send_mode: 'human_queue',
      sent_at: null,
      body: 'hey — loved your last post',
    });

    const res = await markHumanQueueSent(store.sb, {
      messageId: 'om-dm',
      campaignInfluencerId: 'ci-dm',
      firmId: 'firm-1',
      channel: 'tiktok_dm',
      nowMs: NOW,
    });
    assert(res.ok, 'mark_sent: succeeds');

    const ci = store.all('campaign_influencers').find((r) => r.id === 'ci-dm');
    assert(
      ci?.primary_channel === 'tiktok_dm',
      `mark_sent rewrites the legacy 'dm' to the concrete channel (got ${String(ci?.primary_channel)})`,
    );
    assert(
      Array.isArray(ci?.channels_tried) &&
        (ci?.channels_tried as string[]).includes('tiktok_dm'),
      `mark_sent records the channel in channels_tried (got ${JSON.stringify(ci?.channels_tried)})`,
    );
    assert(ci?.outreach_status === 'sent', 'mark_sent still advances outreach_status');

    // And the resulting row is inert for escalation without needing the legacy
    // expansion at all — belt and braces.
    const d = escalationDecision(
      input({
        lead: liveDmLead({
          primary_channel: ci?.primary_channel as string,
          channels_tried: ci?.channels_tried as string[],
        }),
        available: ['tiktok_dm'],
      }),
    );
    assert(
      d.action === 'skip' && d.reason === 'no_untried_channel',
      'a row mark_sent has written back is not escalatable onto its own channel',
    );
  }

  // ── 6b. channels_tried is UNIONED, never replaced ─────────────────────────
  //
  // An escalation writes [ch1, ch2] at insert time. Replacing that with [ch2]
  // when the human marks ch2 sent would drop ch1 and re-open the duplicate on
  // the FIRST channel — the exact bug, one channel over.
  {
    const store = makeStore();
    store.seed('campaign_influencers', {
      id: 'ci-esc',
      status: 'contacted',
      outreach_status: 'sent',
      primary_channel: 'email',
      channels_tried: ['email'],
      last_outreach_at: CONTACTED_AT,
    });
    store.seed('outreach_messages', {
      id: 'om-esc',
      campaign_influencer_id: 'ci-esc',
      channel: 'instagram_dm',
      direction: 'outbound',
      status: 'queued',
      send_mode: 'human_queue',
      sent_at: null,
      body: 'following up',
    });

    await markHumanQueueSent(store.sb, {
      messageId: 'om-esc',
      campaignInfluencerId: 'ci-esc',
      firmId: 'firm-1',
      channel: 'instagram_dm',
      nowMs: NOW,
    });

    const ci = store.all('campaign_influencers').find((r) => r.id === 'ci-esc');
    const tried = (ci?.channels_tried ?? []) as string[];
    assert(
      tried.includes('email') && tried.includes('instagram_dm'),
      `mark_sent unions channels_tried rather than replacing it (got ${JSON.stringify(tried)})`,
    );
    assert(
      ci?.primary_channel === 'email',
      `mark_sent never clobbers a concrete primary_channel (got ${String(ci?.primary_channel)})`,
    );
  }

  // ── 7. Channel + send_mode + needs_human are only correct together ────────
  //
  // Migration 018's CHECK on outreach_messages.channel permits exactly
  // email|instagram_dm|tiktok_dm|linkedin_dm. 'dm' and 'comment' — both of
  // which src/lib/outreach.ts used to persist — are constraint violations.
  {
    const CHECK_SET = ['email', 'instagram_dm', 'tiktok_dm', 'linkedin_dm'];
    const shapes = [
      { primaryChannel: 'dm', platform: 'tiktok', contactEmail: null },
      { primaryChannel: 'dm', platform: 'instagram', contactEmail: null },
      { primaryChannel: 'dm', platform: null, contactEmail: null },
      { primaryChannel: 'comment', platform: 'tiktok', contactEmail: null },
      { primaryChannel: null, platform: 'tiktok', contactEmail: null },
      { primaryChannel: null, platform: 'tiktok', contactEmail: 'a@b.example' },
      { primaryChannel: 'email', platform: 'tiktok', contactEmail: 'a@b.example' },
      { primaryChannel: 'tiktok_dm', platform: 'tiktok', contactEmail: 'a@b.example' },
    ];
    let illegal = 0;
    let unqueued = 0;
    for (const s of shapes) {
      const f = outreachDispatchFields(s);
      if (!CHECK_SET.includes(f.channel)) illegal++;
      if (!f.send_mode) unqueued++;
    }
    assert(
      illegal === 0,
      `outreachDispatchFields only ever produces a channel migration 018 allows (${illegal} illegal)`,
    );
    assert(
      unqueued === 0,
      `and never a NULL send_mode, which is what keeps a draft out of every queue (${unqueued} unqueued)`,
    );

    const tt = outreachDispatchFields({
      primaryChannel: 'dm',
      platform: 'tiktok',
      contactEmail: null,
    });
    assert(
      tt.channel === 'tiktok_dm' && tt.send_mode === 'human_queue' && tt.needs_human,
      'a TikTok DM draft is routed to the human queue, not claimed as an auto-email',
    );
    const em = outreachDispatchFields({
      primaryChannel: 'email',
      platform: 'tiktok',
      contactEmail: 'a@b.example',
    });
    assert(
      em.channel === 'email' && em.send_mode === 'auto_email' && !em.needs_human,
      'the email path is unchanged: auto_email, no human needed',
    );
  }

  // ── 8. The router prefers observed evidence over the 020 seed ─────────────
  {
    /** Rows as the 020 seed leaves them: seeded 100-scale, observed all zero. */
    const live = (
      obs: Partial<Record<'email' | 'instagram_dm' | 'tiktok_dm', [number, number, number]>> = {},
    ): ChannelPrior[] =>
      (
        [
          ['email', 100, 8, 0],
          ['instagram_dm', 100, 3, 0],
          ['tiktok_dm', 100, 2, 0],
        ] as const
      ).map(([channel, sent, replies, deals]) => {
        const o = obs[channel as 'email'] ?? [0, 0, 0];
        return {
          channel,
          sent,
          replies,
          deals,
          observed_sent: o[0],
          observed_replies: o[1],
          observed_deals: o[2],
        };
      });

    // Cold start: the seeded ORDER is preserved exactly, and provenance stays
    // 'priors' — the seed still does its job of giving day-one ranking.
    const cold = routingPriors(live())!;
    const score = (rows: ChannelPrior[], ch: string) =>
      priorScore(rows.find((r) => r.channel === ch)) ?? -1;
    assert(
      score(cold, 'email') > score(cold, 'instagram_dm') &&
        score(cold, 'instagram_dm') > score(cold, 'tiktok_dm'),
      'with no observed events the seeded order email > instagram_dm > tiktok_dm is unchanged',
    );
    assert(
      pickBestChannel(['email', 'instagram_dm', 'tiktok_dm'], cold).source === 'priors',
      'and the ranking is still reported as priors-driven, not cold_start',
    );
    assert(
      cold.every((r, i) => r === live()[i] || r.sent === 100),
      'a row with nothing observed is returned untouched — the cold start is byte-for-byte the seed',
    );
    assert(
      routingPriors(live())!.every((r) => r.sent === ROUTING_PRIOR_SCALE),
      `every routing prior is expressed on the same ${ROUTING_PRIOR_SCALE}-send denominator, so priorScore compares rate against rate`,
    );

    // Real evidence moves the ranking. 12 tiktok_dm sends with 4 replies (33%)
    // must beat a seeded email baseline of 8%. This is the case that killed the
    // first attempt at this fix (re-weighting the seed to 10 pseudo-sends): the
    // 33% channel scored BELOW the 8% guess, because priorScore's fixed +1/+2
    // smoothing dominates a small denominator.
    const learned = routingPriors(live({ tiktok_dm: [12, 4, 0] }))!;
    assert(
      pickBestChannel(['email', 'tiktok_dm'], learned).channel === 'tiktok_dm',
      `a measured 4/12 on tiktok_dm outranks the seeded 8/100 email guess (tt=${score(learned, 'tiktok_dm').toFixed(4)} vs email=${score(learned, 'email').toFixed(4)})`,
    );
    assert(
      score(learned, 'tiktok_dm') > score(cold, 'tiktok_dm'),
      'and observed replies raise the channel\'s own score rather than being diluted 1:100',
    );

    // A single closed deal flips it — "replace by evidence", as migration 020
    // intended, at a reachable sample size.
    const oneDeal = routingPriors(live({ tiktok_dm: [1, 1, 1] }))!;
    assert(
      pickBestChannel(['email', 'tiktok_dm'], oneDeal).channel === 'tiktok_dm',
      'one real closed deal on tiktok_dm overrides the seeded email baseline',
    );

    // Full confidence: at ROUTING_OBSERVED_FULL_CONFIDENCE_N observed sends the
    // seed carries no weight, so the measured rate is what ranks.
    const full = routingPriors(live({ tiktok_dm: [30, 0, 0] }))!;
    assert(
      score(full, 'tiktok_dm') < score(cold, 'tiktok_dm'),
      `${ROUTING_OBSERVED_FULL_CONFIDENCE_N} sends with zero replies drops the channel BELOW its seeded guess — the seed is fully displaced`,
    );

    // NO LOCKING. The failure mode of a naive "prefer observed when there is
    // any" switch: one email send with zero replies scores (0+1)/(1+2)=0.333
    // under Laplace smoothing and would beat every unsent channel forever.
    const oneDudSend = routingPriors(live({ email: [1, 0, 0] }))!;
    assert(
      score(oneDudSend, 'email') < 0.05,
      `a single reply-less send does not become a 0.33 score that locks routing (got ${score(oneDudSend, 'email').toFixed(4)})`,
    );
    assert(
      Math.abs(score(oneDudSend, 'email') - score(cold, 'email')) < 0.002,
      'and at 1 of 30 observed sends the seed still carries almost all the weight — no cliff',
    );
    const afterRealRun = routingPriors(live({ email: [20, 0, 0], tiktok_dm: [20, 5, 0] }))!;
    assert(
      pickBestChannel(['email', 'tiktok_dm'], afterRealRun).channel === 'tiktok_dm',
      '20 sends each: 5 replies on tiktok_dm beats 0 on email — evidence, not the seed, is ranking',
    );

    // Pre-043 / hand-injected rows carry no observed columns and are passed
    // through untouched, so tests and callers that build priors by hand keep
    // their exact semantics.
    const legacyRows: ChannelPrior[] = [
      { channel: 'email', sent: 100, replies: 7, deals: 0 },
      { channel: 'tiktok_dm', sent: 20, replies: 10, deals: 6 },
    ];
    const passthrough = routingPriors(legacyRows)!;
    assert(
      passthrough[0].sent === 100 && passthrough[1].sent === 20,
      'rows with no observed_* columns at all are returned unchanged (pre-043, or injected by a caller)',
    );
    assert(routingPriors(null) === null, 'routingPriors(null) is null, not an empty list');

    // A row with observed evidence but no seeded denominator gets a 0% prior
    // rate, not an invented industry number — and a reply-less send on such a
    // channel therefore cannot outrank a seeded one.
    const noSeed = routingPriors([
      { channel: 'tiktok_dm', sent: 0, replies: 0, deals: 0, observed_sent: 1, observed_replies: 0, observed_deals: 0 },
      { channel: 'email', sent: 100, replies: 8, deals: 0, observed_sent: 0, observed_replies: 0, observed_deals: 0 },
    ])!;
    assert(
      noSeed[0].sent === ROUTING_PRIOR_SCALE && noSeed[0].replies === 0,
      `an unseeded cold row gets a 0% prior rate on the shared denominator (got ${noSeed[0].sent}/${noSeed[0].replies})`,
    );
    assert(
      pickBestChannel(['email', 'tiktok_dm'], noSeed).channel === 'email',
      'so one reply-less send on an unseeded channel does not capture the router',
    );
  }

  console.log(`duplicate-send test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
