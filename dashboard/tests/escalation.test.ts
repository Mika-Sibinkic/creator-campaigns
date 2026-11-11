// tests/escalation.test.ts
//
// Hermetic unit test for src/lib/escalation.ts — timed multi-channel
// escalation: try a different channel when a creator has not replied within
// a set time.
//
// Pure given (lead state, available channels, priors, prefs, window, nowMs).
// No database, no clock, no model.
//
// This suite is written as a list of things that MUST NOT happen, because
// escalation is the feature that sends unprompted messages to real creators on
// channels they did not hear from us on. Its failure mode is not "the feature
// didn't work", it is "we messaged someone we had already been told not to
// message, on a channel that sends nothing, twice."
//
//   * never message a creator who already replied
//   * never exceed the firm's per-lead contact cap
//   * never escalate a blocklisted or pool-gated creator
//   * never escalate outside the campaign window
//   * never re-pick a channel already tried
//   * never pick LinkedIn, which has no dispatch path at all
//
// The LinkedIn case is pinned deliberately. The product description names
// it; the repo cannot send one. A channel that ranks, gets selected, and then
// silently sends nothing is worse than an absent channel, because it burns the
// lead's contact budget and reports an attempt that never happened.
//
// Run: npx tsx tests/escalation.test.ts

import {
  CHANNELS_WITHOUT_DISPATCH,
  DEFAULT_MAX_FOLLOW_UPS,
  DEFAULT_SILENCE_HOURS,
  ESCALATABLE_STATUS,
  MIN_SILENCE_HOURS,
  REPLIED_OR_TERMINAL_STATUSES,
  attemptedChannels,
  escalationDecision,
  escalationPrefs,
  type EscalationInput,
  type LeadEscalationState,
} from '../src/lib/escalation';
import { deriveWindow, windowOffsets } from '../src/lib/campaign-window';
import type { ChannelPrior } from '../src/lib/contact-discovery';

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
const DAY_MS = 86_400_000;

function utc(y: number, mo: number, d: number, h = 0): number {
  return Date.UTC(y, mo - 1, d, h, 0, 0, 0);
}

// A release on 2026-06-01 with default offsets → window 2026-05-04 .. 2026-06-15.
const WINDOW = deriveWindow('2026-06-01', windowOffsets(undefined));
/** Comfortably inside the window. */
const NOW = utc(2026, 6, 1, 14);
/** The lead was contacted 10 days ago — well past any silence window. */
const LONG_AGO = new Date(NOW - 10 * DAY_MS).toISOString();

function lead(over: Partial<LeadEscalationState> = {}): LeadEscalationState {
  return {
    campaign_influencer_id: 'ci-1',
    outreach_status: ESCALATABLE_STATUS,
    primary_channel: 'email',
    channels_tried: ['email'],
    next_attempt_at: null,
    last_outreach_at: LONG_AGO,
    outbound_count: 1,
    contact_blocked: false,
    contact_block_reason: null,
    ...over,
  };
}

function input(over: Partial<EscalationInput> = {}): EscalationInput {
  return {
    lead: lead(),
    available: ['email', 'instagram_dm', 'tiktok_dm'],
    priors: null,
    prefs: escalationPrefs(undefined),
    window: WINDOW,
    nowMs: NOW,
    ...over,
  };
}

async function main() {
  // ── 0. The happy path exists at all ──────────────────────────────────────
  {
    const d = escalationDecision(input());
    assert(d.action === 'escalate', 'a contacted, silent, in-window lead does escalate');
    assert(
      d.action === 'escalate' && d.channel === 'instagram_dm',
      'with no priors it takes the cold-start next channel after email',
    );
    assert(
      d.action === 'escalate' && d.next_channels_tried.includes('email'),
      'the already-tried channel stays recorded',
    );
    assert(
      d.action === 'escalate' && d.next_channels_tried.includes('instagram_dm'),
      'the newly-picked channel is added to channels_tried',
    );
    assert(
      d.action === 'escalate' && d.next_attempt_ms === NOW + DEFAULT_SILENCE_HOURS * HOUR_MS,
      'next_attempt_at is pushed one full silence window into the future',
    );
  }

  // ── 1. NEVER escalate a lead that replied ────────────────────────────────
  {
    for (const status of REPLIED_OR_TERMINAL_STATUSES) {
      const d = escalationDecision(input({ lead: lead({ outreach_status: status }) }));
      assert(
        d.action === 'skip' && d.reason === 'already_replied',
        `a lead at '${status}' is never escalated — they already engaged`,
      );
    }
    // And the not-yet-contacted states belong to the send path, not here.
    for (const status of ['pending', 'draft_ready', 'none', '', null]) {
      const d = escalationDecision(input({ lead: lead({ outreach_status: status }) }));
      assert(
        d.action === 'skip' && d.reason === 'not_contacted_yet',
        `a lead at '${status}' has no first touch to escalate from`,
      );
    }
    assert(
      ESCALATABLE_STATUS === 'sent',
      'only the contacted-and-silent state is escalatable, and it is "sent"',
    );
  }

  // ── 2. NEVER escalate a blocklisted or pool-gated creator ────────────────
  {
    const d = escalationDecision({
      ...input(),
      lead: lead({ contact_blocked: true, contact_block_reason: 'blocklisted by the firm' }),
    });
    assert(
      d.action === 'skip' && d.reason === 'contact_blocked',
      'a blocklisted or gated creator is never escalated to',
    );
    assert(
      d.action === 'skip' && d.detail === 'blocklisted by the firm',
      'and the block reason is carried through so the skip is inspectable',
    );
  }

  // ── 3. NEVER exceed the per-lead contact cap ─────────────────────────────
  {
    // Default cap: 1 initial + 2 follow-ups = 3 outbound messages.
    const prefs = escalationPrefs(undefined);
    assert(prefs.max_follow_ups === DEFAULT_MAX_FOLLOW_UPS, 'default cap is 2 follow-ups');

    for (const count of [1, 2]) {
      const d = escalationDecision(input({ lead: lead({ outbound_count: count }) }));
      assert(
        d.action === 'escalate',
        `at ${count} real outbound message(s) the lead is under the cap and may escalate`,
      );
    }
    const atCap = escalationDecision(input({ lead: lead({ outbound_count: 3 }) }));
    assert(
      atCap.action === 'skip' && atCap.reason === 'cap_reached',
      'at 1 + max_follow_ups messages the lead is capped and never escalated again',
    );
    const overCap = escalationDecision(input({ lead: lead({ outbound_count: 99 }) }));
    assert(
      overCap.action === 'skip' && overCap.reason === 'cap_reached',
      'a lead already over the cap stays capped',
    );

    // FAIL CLOSED on an unknown count. The previous version read
    // campaign_influencers.message_count, which is 0 on every lead, so
    // `0 >= 1 + max_follow_ups` was false for every configuration and the cap
    // never bound at all. An unreadable count must refuse, not wave through.
    const unknown = escalationDecision(input({ lead: lead({ outbound_count: null }) }));
    assert(
      unknown.action === 'skip' && unknown.reason === 'cap_unknown',
      'an unreadable outbound count refuses the escalation rather than escalating blind',
    );

    // max_follow_ups: 0 means "one message only" and must be honoured, not
    // swallowed as falsy.
    const zero = escalationPrefs({ max_follow_ups: 0 });
    assert(zero.max_follow_ups === 0, 'max_follow_ups of 0 survives as 0, not as the default');
    const noFollowUp = escalationDecision(
      input({ prefs: zero, lead: lead({ outbound_count: 1 }) }),
    );
    assert(
      noFollowUp.action === 'skip' && noFollowUp.reason === 'cap_reached',
      'a firm that set "one message only" never gets an escalation',
    );
  }

  // ── 4. The silence window ────────────────────────────────────────────────
  {
    // next_attempt_at in the future → wait.
    const future = new Date(NOW + 2 * DAY_MS).toISOString();
    const d = escalationDecision(input({ lead: lead({ next_attempt_at: future }) }));
    assert(
      d.action === 'skip' && d.reason === 'too_soon',
      'a lead whose next_attempt_at has not arrived is not escalated',
    );

    // next_attempt_at in the past → go.
    const past = new Date(NOW - HOUR_MS).toISOString();
    const d2 = escalationDecision(input({ lead: lead({ next_attempt_at: past }) }));
    assert(d2.action === 'escalate', 'once next_attempt_at has passed the lead escalates');

    // No next_attempt_at (rows predating migration 049) → derive from last touch.
    const recent = new Date(NOW - 2 * HOUR_MS).toISOString();
    const d3 = escalationDecision(
      input({ lead: lead({ next_attempt_at: null, last_outreach_at: recent }) }),
    );
    assert(
      d3.action === 'skip' && d3.reason === 'too_soon',
      'without next_attempt_at the silence window is derived from last_outreach_at, so a lead contacted 2h ago waits',
    );

    // Neither timestamp → fail closed rather than double-tap immediately.
    const d4 = escalationDecision(
      input({ lead: lead({ next_attempt_at: null, last_outreach_at: null }) }),
    );
    assert(
      d4.action === 'skip' && d4.reason === 'too_soon',
      'with no timestamp at all we cannot prove the silence elapsed, so we wait rather than risk an instant second message',
    );
    const d5 = escalationDecision(
      input({ lead: lead({ next_attempt_at: 'garbage', last_outreach_at: 'garbage' }) }),
    );
    assert(
      d5.action === 'skip' && d5.reason === 'too_soon',
      'unparseable timestamps fail closed too',
    );
  }

  // ── 5. Silence window is firm-configurable ───────────────────────────────
  {
    assert(
      escalationPrefs(undefined).silence_hours === DEFAULT_SILENCE_HOURS,
      'the default silence window is 72 hours',
    );
    assert(
      escalationPrefs({ escalation_silence_hours: 120 }).silence_hours === 120,
      'a firm may set escalation_silence_hours directly',
    );
    // Falls back to the EXISTING follow-up cadence rather than demanding a
    // second setting from a firm that already tuned one.
    assert(
      escalationPrefs({ follow_up_cadence_days: 5 }).silence_hours === 120,
      'with no explicit setting it reuses the firm follow_up_cadence_days (5d = 120h)',
    );
    assert(
      escalationPrefs({ escalation_silence_hours: 24, follow_up_cadence_days: 5 })
        .silence_hours === 24,
      'the explicit escalation setting wins over the cadence fallback',
    );
    // Non-positive is not a setting, it is a mistake — both fall back to the
    // default rather than being taken literally as "escalate immediately".
    assert(
      escalationPrefs({ escalation_silence_hours: 0 }).silence_hours === DEFAULT_SILENCE_HOURS,
      'a zero silence window falls back to the default — escalation never becomes an instant double-tap',
    );
    assert(
      escalationPrefs({ escalation_silence_hours: -5 }).silence_hours === DEFAULT_SILENCE_HOURS,
      'a negative silence window falls back to the default',
    );
    // A small-but-positive value IS a real setting, and it is floored rather
    // than ignored, so a firm asking for 1 hour gets the 12-hour floor.
    assert(
      escalationPrefs({ escalation_silence_hours: 1 }).silence_hours === MIN_SILENCE_HOURS,
      'a positive silence window below the floor is raised to the floor, not honoured literally',
    );
    assert(
      escalationPrefs('nonsense').silence_hours === DEFAULT_SILENCE_HOURS,
      'non-object prefs fall back rather than throwing',
    );

    // The configured window is the one actually applied.
    const prefs = escalationPrefs({ escalation_silence_hours: 240 }); // 10 days
    const d = escalationDecision(
      input({ prefs, lead: lead({ last_outreach_at: new Date(NOW - 5 * DAY_MS).toISOString() }) }),
    );
    assert(
      d.action === 'skip' && d.reason === 'too_soon',
      'a 10-day silence window really does hold a lead contacted 5 days ago',
    );
  }

  // ── 6. The campaign window gates escalation ──────────────────────────────
  {
    if (!WINDOW) throw new Error('fixture window should exist');

    // The lead must have been contacted BEFORE the instant under test,
    // otherwise the silence check short-circuits and we would never reach the
    // window check we are actually asserting on.
    const beforeMs = WINDOW.start_ms - DAY_MS;
    const before = escalationDecision(
      input({
        nowMs: beforeMs,
        lead: lead({ last_outreach_at: new Date(beforeMs - 10 * DAY_MS).toISOString() }),
      }),
    );
    assert(
      before.action === 'skip' && before.reason === 'outside_window',
      'no escalation before the campaign window opens',
    );

    const after = escalationDecision(input({ nowMs: WINDOW.end_ms + DAY_MS }));
    assert(
      after.action === 'skip' && after.reason === 'outside_window',
      'no escalation after the campaign window closes — an escalation OPENS a thread, so it gets the hard gate, not the in-thread grace',
    );

    const lastMoment = escalationDecision(input({ nowMs: WINDOW.end_ms }));
    assert(lastMoment.action === 'escalate', 'the final instant of the window still escalates');

    // No release date → no window → escalation is NOT blocked. The
    // non-regression property: untimed campaigns keep working.
    const untimed = escalationDecision(input({ window: null, nowMs: utc(2030, 1, 1) }));
    assert(
      untimed.action === 'escalate',
      'a campaign with no release_date is ungated and still escalates',
    );
  }

  // ── 7. Channel selection: next-best UNTRIED, via the existing ranking ────
  {
    // Already tried email and IG → only TikTok is left.
    const d = escalationDecision(
      input({ lead: lead({ channels_tried: ['email', 'instagram_dm'] }) }),
    );
    assert(
      d.action === 'escalate' && d.channel === 'tiktok_dm',
      'a channel already tried is never re-picked',
    );

    // Everything tried → nothing to escalate to.
    const exhausted = escalationDecision(
      input({ lead: lead({ channels_tried: ['email', 'instagram_dm', 'tiktok_dm'] }) }),
    );
    assert(
      exhausted.action === 'skip' && exhausted.reason === 'no_untried_channel',
      'once every reachable channel has been tried the lead stops escalating',
    );

    // Only reachable on email, already tried → nothing left.
    const emailOnly = escalationDecision(
      input({ available: ['email'], lead: lead({ channels_tried: ['email'] }) }),
    );
    assert(
      emailOnly.action === 'skip' && emailOnly.reason === 'no_untried_channel',
      'a creator reachable only by email never escalates anywhere',
    );

    // Priors change the pick — the SAME ranking channel routing uses.
    const priors: ChannelPrior[] = [
      { channel: 'instagram_dm', sent: 100, replies: 1, deals: 0 },
      { channel: 'tiktok_dm', sent: 100, replies: 60, deals: 30 },
    ];
    const ranked = escalationDecision(input({ priors }));
    assert(
      ranked.action === 'escalate' && ranked.channel === 'tiktok_dm',
      'escalation follows the firm channel priors, not a hardcoded order — TikTok converts far better here',
    );
    assert(
      ranked.action === 'escalate' && ranked.source === 'priors',
      'and it reports that the priors produced the pick',
    );
    const cold = escalationDecision(input({ priors: [] }));
    assert(
      cold.action === 'escalate' && cold.source === 'cold_start',
      'with no prior data it falls back to the cold-start order and says so',
    );
  }

  // ── 8. primary_channel counts as tried, even without migration 049 ───────
  {
    // The first touch predates channels_tried. If primary_channel were ignored,
    // every pre-migration lead would "escalate" onto the channel it was already
    // contacted on — a duplicate message to a real creator.
    const legacy = lead({ channels_tried: null, primary_channel: 'instagram_dm' });
    assert(
      attemptedChannels(legacy).includes('instagram_dm'),
      'primary_channel is folded into the attempted set for rows predating migration 049',
    );
    const d = escalationDecision(input({ lead: legacy }));
    assert(
      d.action === 'escalate' && d.channel !== 'instagram_dm',
      'a legacy lead never escalates onto the channel it was already contacted on',
    );
    assert(
      attemptedChannels(lead({ channels_tried: [], primary_channel: null })).length === 0,
      'with neither field there is nothing attempted yet',
    );
    assert(
      attemptedChannels(lead({ channels_tried: ['email'], primary_channel: 'email' })).length === 1,
      'the attempted set is deduplicated',
    );
  }

  // ── 9. LinkedIn: named in the pitch, absent from the repo, excluded here ──
  {
    assert(
      'linkedin_dm' in CHANNELS_WITHOUT_DISPATCH,
      'linkedin_dm is registered as a channel with no dispatch path',
    );
    assert(
      CHANNELS_WITHOUT_DISPATCH.linkedin_dm.toLowerCase().includes('no dispatch path'),
      'and the registry says WHY, so nobody re-adds it without a sender',
    );

    // Even when LinkedIn is the only untried channel and priors love it, it is
    // never selected — because selecting it would send nothing while consuming
    // the lead's contact budget.
    const priors: ChannelPrior[] = [
      { channel: 'linkedin_dm', sent: 100, replies: 90, deals: 80 },
    ];
    const d = escalationDecision({
      ...input({ priors }),
      available: ['email', 'linkedin_dm'] as never,
      lead: lead({ channels_tried: ['email'] }),
    });
    assert(
      d.action === 'skip' && d.reason === 'no_untried_channel',
      'LinkedIn is never escalated to even as the last untried channel with perfect priors — there is no dispatcher behind it',
    );

    const d2 = escalationDecision({
      ...input(),
      available: ['email', 'linkedin_dm', 'tiktok_dm'] as never,
      lead: lead({ channels_tried: ['email'] }),
    });
    assert(
      d2.action === 'escalate' && d2.channel === 'tiktok_dm',
      'a real channel is picked over LinkedIn rather than the lead being skipped',
    );
  }

  // ── 10. Decision order: the absolute refusals come first ─────────────────
  {
    // A replied lead that is ALSO capped, blocked and out of window must report
    // the reply — the strongest reason, and the one a human needs to see.
    const d = escalationDecision({
      ...input({ nowMs: utc(2030, 1, 1) }),
      lead: lead({
        outreach_status: 'deal_closed',
        outbound_count: 99,
        contact_blocked: true,
      }),
    });
    assert(
      d.action === 'skip' && d.reason === 'already_replied',
      'the reply guard is evaluated before the cap, the block and the window',
    );
    // A blocked lead that is also out of window reports the block.
    const d2 = escalationDecision({
      ...input({ nowMs: utc(2030, 1, 1) }),
      lead: lead({ contact_blocked: true }),
    });
    assert(
      d2.action === 'skip' && d2.reason === 'contact_blocked',
      'the pool-gate/blocklist guard is evaluated before the window',
    );
  }

  console.log(`escalation test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
