// src/lib/social-dispatch.ts
//
// Channel-aware dispatch routing.
// The existing tick sends every queued outreach_message via email regardless of its
// channel; this resolves the correct SEND MODE so social channels route to the
// computer-use worker (when a credible account is available + cadence allows) or to
// the human-send queue as the safety-valve fallback. Pure — the caller does the DB.

import type { ContactChannel } from './contact-discovery';
import type { SocialPlatform, AccountState, SendDecision } from './social-cadence';

export type SendMode = 'auto_email' | 'computer_use' | 'human_queue';

export function channelToPlatform(channel: ContactChannel): SocialPlatform | null {
  if (channel === 'instagram_dm') return 'instagram';
  if (channel === 'tiktok_dm') return 'tiktok';
  return null;
}

// ── Legacy 'dm': ONE definition of what it means, used by every reader ───────
//
// `campaign_influencers.primary_channel` can carry the pre-split value 'dm' on
// older rows (mostly TikTok creators with no email). It is NOT a channel — it is "no email address was found" — and every
// place that has to answer "which concrete channel is this" must answer the
// same way, or the system contradicts itself.
//
// It has already contradicted itself once, and it was a duplicate send.
// `resolveOutreachChannel` (below) resolves 'dm' → tiktok_dm and stamps that on
// the draft; `escalation.attemptedChannels` recorded the literal 'dm' as the
// attempted channel. So tiktok_dm looked UNTRIED on a lead that had just been
// DM'd on TikTok, and escalation re-queued the identical body to the same
// inbox. The resolver's own comment said 'dm' "does not mask instagram_dm or
// tiktok_dm" — true only while 'dm' was unroutable, which stopped being true
// the moment the resolver learned to route it.
//
// These three exports are that single definition. `expandLegacyDmChannel` is
// the inverse of `resolveOutreachChannel`'s 'dm' branch, arm for arm: the
// resolver returns `platformDm ?? 'email'`, so a legacy 'dm' masks the DM
// channels the creator is reachable on, and masks 'email' when there are none.
export const LEGACY_DM_CHANNEL = 'dm';

/** The concrete DM channels. `linkedin_dm` is excluded on purpose — nothing
 *  discovers or sends it, so a legacy 'dm' can never have meant it. */
export const DM_CHANNELS: readonly ContactChannel[] = ['instagram_dm', 'tiktok_dm'];

/** True for the pre-split `primary_channel` / `channel` value 'dm'. */
export function isLegacyDmChannel(value: string | null | undefined): boolean {
  return value === LEGACY_DM_CHANNEL;
}

/**
 * The concrete channels a legacy 'dm' could have been sent on, given the
 * channels this creator is actually reachable on.
 *
 * Fail closed by construction: when `available` names more than one DM channel
 * we cannot know which one was used, so BOTH are treated as attempted. Sending
 * a second message on a channel we may already have used is the failure this
 * function exists to prevent; declining to escalate is not.
 */
export function expandLegacyDmChannel(available: readonly string[]): string[] {
  const dms = available.filter((ch) => (DM_CHANNELS as readonly string[]).includes(ch));
  // No DM channel reachable ⇒ resolveOutreachChannel's `platformDm ?? 'email'`
  // fell through to email, so email is what was attempted.
  return dms.length > 0 ? dms : ['email'];
}

export interface SendPlan {
  mode: SendMode;
  needs_human: boolean;
  reason: string;
}

/**
 * Resolve how a queued message on `channel` should be dispatched.
 *   - email                 → auto_email (Resend, the existing path)
 *   - instagram/tiktok DM    → computer_use when a credible account is active AND
 *                              the cadence governor allows a send right now;
 *                              otherwise human_queue (draft ready, one-click human
 *                              send in the dashboard) — the permanent fallback.
 */
export function resolveSendPlan(
  channel: ContactChannel,
  opts: { account?: AccountState | null; sendDecision?: SendDecision } = {},
): SendPlan {
  if (channel === 'email') {
    return { mode: 'auto_email', needs_human: false, reason: 'email' };
  }
  const { account, sendDecision } = opts;
  if (!account) {
    return { mode: 'human_queue', needs_human: true, reason: 'no_credible_account' };
  }
  if (account.status !== 'active') {
    return { mode: 'human_queue', needs_human: true, reason: `account_${account.status}` };
  }
  if (sendDecision && !sendDecision.allowed) {
    // Cap reached / cooling / too-soon / off-hours → hand to a human rather than
    // push the account past a human ceiling. The worker retries computer_use later.
    return { mode: 'human_queue', needs_human: true, reason: sendDecision.reason };
  }
  return { mode: 'computer_use', needs_human: false, reason: 'account_available' };
}

/**
 * Which channel should the FIRST outreach message to this creator go out on?
 *
 * Until now `draft-all` hardcoded `channel: 'email'` and stamped no send_mode,
 * so every draft claimed to be an email — including for the ~95% of the pool
 * with no email address — and `send_mode` stayed NULL. The dashboard's DM queue
 * filters on `send_mode === 'human_queue'`, which is why that queue has never
 * held a single row while hundreds of leads sat unreachable.
 *
 * Resolution order:
 *   1. An explicit DM channel stamped by contact discovery wins.
 *   2. The legacy `'dm'` value (315 rows predate the split) resolves from the
 *      creator's platform. `sendModeFor()` in negotiation-tick does NOT handle
 *      it and silently falls through to email, so it is handled here.
 *   3. A real email address → email.
 *   4. Otherwise fall back to the platform's DM. Never route to email when
 *      there is no address to route to — that produces a draft that looks
 *      sendable and cannot be sent.
 */
export function resolveOutreachChannel(input: {
  primaryChannel: string | null | undefined;
  platform: string | null | undefined;
  contactEmail: string | null | undefined;
}): ContactChannel {
  const { primaryChannel, platform, contactEmail } = input;

  if (primaryChannel === 'instagram_dm' || primaryChannel === 'tiktok_dm') {
    return primaryChannel;
  }

  const platformDm: ContactChannel | null =
    platform === 'instagram' ? 'instagram_dm' : platform === 'tiktok' ? 'tiktok_dm' : null;

  if (primaryChannel === 'dm') {
    return platformDm ?? 'email';
  }
  if (primaryChannel === 'email') {
    return 'email';
  }

  const hasEmail = typeof contactEmail === 'string' && contactEmail.includes('@');
  if (hasEmail) return 'email';
  return platformDm ?? 'email';
}

/** The three columns every `outreach_messages` insert must carry together. */
export interface OutreachDispatchFields {
  channel: ContactChannel;
  send_mode: SendMode;
  needs_human: boolean;
}

/**
 * Channel + send mode for a new outbound message, as one spreadable object.
 *
 * Exists because the three fields are only correct TOGETHER, and the two draft
 * paths that computed them separately each got it wrong in a different way:
 *
 *   * draft-all hardcoded channel='email' on a pool that is ~95% email-less and
 *     stamped no send_mode, so the DM queue (it filters send_mode='human_queue')
 *     was empty while the leads sat unreachable;
 *   * saveOutreachMessage (src/lib/outreach.ts) wrote `channel` alone with no
 *     send_mode and no needs_human, defaulting to
 *     `contact_email ? 'email' : 'dm'` — and 'dm' is not in migration 018's
 *     CHECK constraint on outreach_messages.channel, so that insert either
 *     violated the constraint or landed with send_mode NULL and never reached
 *     any queue, so no outreach_messages row it wrote ever carried
 *     send_mode='human_queue'. It now spreads this too (resolveDraftDispatch in
 *     outreach.ts; pinned by tests/draft-channel.test.ts).
 *
 * A caller that spreads this cannot produce a message that claims a channel it
 * cannot be sent on, or one no queue will pick up.
 */
export function outreachDispatchFields(
  input: {
    primaryChannel: string | null | undefined;
    platform: string | null | undefined;
    contactEmail: string | null | undefined;
  },
  opts: { account?: AccountState | null; sendDecision?: SendDecision } = {},
): OutreachDispatchFields {
  const channel = resolveOutreachChannel(input);
  const plan = resolveSendPlan(channel, opts);
  return { channel, send_mode: plan.mode, needs_human: plan.needs_human };
}
