// src/app/outreach/dm-queue-guards.ts
//
// The DM queue's refusal rules and target resolution, as PURE functions shared
// by both callers: the UI that renders "Mark sent" (./dm-queue-tab.tsx) and the
// route that honours the click (src/app/api/outreach/messages/[id]/route.ts).
//
// One predicate, two callers, on purpose: the button is disabled for exactly
// the reasons the server refuses, so the UI can never offer an action the API
// will reject — and the API never trusts the UI to have checked.
//
// ── Why the refusals exist ──────────────────────────────────────────────────
//
// `mark_sent` on a send_mode='human_queue' row is not a UI flag. Via
// channel-priors.markHumanQueueSent it stamps status='sent' + sent_at, clears
// send_after, advances campaign_influencers to outreach_status='sent' /
// status='contacted', writes a social_send_events audit row, bumps the 'sent'
// channel prior, and — through negotiation.openOfferForSentOutreach — OPENS A
// PRICED NEGOTIABLE OFFER that the auto-negotiator immediately owns
// (creator_offers.status='offered', picked up by negotiation-tick). One click
// on the wrong row therefore starts a live money conversation with a creator
// who was never contacted.
//
// markHumanQueueSent deliberately checks none of this itself — its own comment
// says "The CALLER owns authorization and the already-sent check". This file is
// that caller's checklist.
//
// The email send route refuses a window_closed row
// (api/outreach/[id]/send/route.ts:92) specifically so such a row cannot be
// "silently resurrected into the DM queue for a human to send by hand, which is
// precisely the outcome the window exists to prevent". The DM queue then did
// exactly that through the other door: it never selected `status` at all.
//
// And there is NO unsend path anywhere in this repository — nothing in src/,
// tools/ or any migration ever sets outreach_messages.sent_at back to
// null. Every refusal below is a one-way door held shut, not an inconvenience.
//
// Pure: no DB, no network, no clock of its own (nowMs is injected), no React.
// Hermetically tested in tests/dm-queue-guards.test.ts.

import {
  isSendableMessageStatus,
  isWindowClosed,
  messageStatusLabel,
} from '@/lib/message-status';

// ────────────────────────────────────────────────────────────────────────────
// 1. Can this row be marked sent?
// ────────────────────────────────────────────────────────────────────────────

export type DmRefusalKind = 'already_sent' | 'window_closed' | 'terminal' | 'held';

/** The columns a refusal decision needs. A superset is fine. */
export interface DmMarkSentRow {
  status?: string | null;
  sent_at?: string | null;
  send_after?: string | null;
}

export interface DmRefusal {
  kind: DmRefusalKind;
  /** Machine-readable `error` field; the API mirrors it in its response body. */
  error: string;
  /** One operator-facing sentence: what happened, and what to do instead. */
  message: string;
  /** For 'held' only: the ISO instant this row becomes sendable. */
  send_after?: string;
}

/**
 * Every refusal is a 409, matching the email send route's vocabulary for the
 * same conditions ('already sent', 'window_closed'). A DM queue client that
 * already handles 409 keeps working.
 */
export const DM_REFUSAL_HTTP_STATUS = 409;

/** `send_after` as ms-epoch, or null when unset/unparseable. */
export function parseSendAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The single gate on "mark this DM sent". Returns null when the click is
 * legitimate, else the refusal to show and to return.
 *
 * Order matters: `sent_at` first (idempotency — the common double-click, and
 * the cheapest check), then the terminal statuses (a row that must never be
 * sent by any path), then the schedule (a row that must not be sent YET).
 */
export function dmMarkSentRefusal(row: DmMarkSentRow, nowMs: number): DmRefusal | null {
  if (row.sent_at) {
    return {
      kind: 'already_sent',
      error: 'already sent',
      message: 'This DM is already marked sent. Nothing was recorded twice.',
    };
  }

  if (isWindowClosed(row.status)) {
    return {
      kind: 'window_closed',
      error: 'window_closed',
      message:
        'This campaign’s outreach window has closed, so this DM must not be sent. ' +
        'Reopen the window (or adjust the release date) if it should still go out.',
    };
  }

  // 'failed' is terminal too, and the email route's window-only guard misses it.
  if (!isSendableMessageStatus(row.status)) {
    return {
      kind: 'terminal',
      error: 'terminal_status',
      message:
        `This draft is ${messageStatusLabel(row.status)}, which is final, so it can’t be sent. ` +
        'Write a fresh draft for this creator instead.',
    };
  }

  const after = parseSendAfter(row.send_after);
  if (after !== null && after > nowMs) {
    return {
      kind: 'held',
      error: 'held',
      message:
        'This DM is deliberately scheduled for later: it was deferred out of quiet hours, ' +
        'so sending it now would land in the middle of the creator’s night. ' +
        'It unlocks by itself at the time shown.',
      send_after: new Date(after).toISOString(),
    };
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// 1b. Is this creator on the label's do-not-contact list?
// ────────────────────────────────────────────────────────────────────────────
//
// The listing (src/lib/outreach-listing.ts) stamps each lead with the verdict
// from src/lib/firm-blocks.ts. Unlike the refusals above, a do-not-contact row
// is HIDDEN from the queue, not shown disabled: the queue is a list of things
// to paste into Instagram, and a visible draft to someone who said STOP is one
// copy-paste from a broken opt-out that no server check can see. Hidden rows
// are counted, so nothing vanishes silently. The server re-checks at Mark sent
// (src/lib/dm-mark-sent.ts) regardless.

export type DmWithholdReason = 'do_not_contact' | 'unconfirmed';

export interface DmWithholdInput {
  /** Stamped by the listing. Absent = not confirmed = held (fail closed). */
  do_not_contact?: unknown;
  influencer?: { blocklisted?: boolean | null } | null;
}

export function dmQueueWithholdReason(entry: DmWithholdInput): DmWithholdReason | null {
  if (entry.influencer?.blocklisted === true) return 'do_not_contact';
  if (entry.do_not_contact === 'blocked') return 'do_not_contact';
  if (entry.do_not_contact === 'clear') return null;
  return 'unconfirmed';
}

// ────────────────────────────────────────────────────────────────────────────
// 2. Where does a human actually send this?
// ────────────────────────────────────────────────────────────────────────────
//
// The queue used to key its link off `influencers.platform` while its badge
// showed `outreach_messages.channel`. A creator scraped from TikTok has
// platform='tiktok', yet campaign_influencers can carry primary_channel=
// 'instagram_dm' for them, which resolveOutreachChannel stamps onto the
// message as channel='instagram_dm'. Those rows told the operator "instagram"
// and sent them to TikTok, showing a TikTok handle for an Instagram DM.
//
// The schema has no Instagram handle for such a creator: creator_contacts
// rarely carries an instagram_dm entry, and no other table has a per-creator
// Instagram identifier. So that row is not
// "link somewhere else" — it is UNSENDABLE, and the queue must say so.

export type DmChannel = 'instagram_dm' | 'tiktok_dm';

export interface DmTargetInput {
  /** outreach_messages.channel. 'email' on drafts written before channel
   *  routing, and on anything rerouted off the email path. */
  channel: string | null | undefined;
  /** influencers.platform — the ONE network we hold a handle for. */
  platform: string | null | undefined;
  /** influencers.username — the handle on `platform`, NOT on `channel`. */
  username: string | null | undefined;
  /** influencers.profile_url — scraped, and always on `platform`. */
  profileUrl: string | null | undefined;
}

export interface DmTarget {
  /** The channel this message is addressed to, once resolved. */
  channel: DmChannel | null;
  /** "Instagram DM" / "TikTok DM" / "DM". */
  label: string;
  /** A PROFILE page for the resolved channel — never a DM inbox: no public URL
   *  opens someone's inbox, and claiming otherwise is what the old comment did. */
  url: string | null;
  /** Button text that says what the link really opens. */
  urlLabel: string;
  /** True when the message's channel had to be inferred from the creator's
   *  platform because the row carries a non-DM channel (e.g. 'email'). */
  inferred: boolean;
  /** False when nothing in the database can reach this creator on `channel`. */
  sendable: boolean;
  /** Why not, in one sentence, when sendable is false. */
  blockedReason: string | null;
}

const NETWORK_LABEL: Record<DmChannel, string> = {
  instagram_dm: 'Instagram',
  tiktok_dm: 'TikTok',
};

/** Channel-ish string → DM channel. Accepts the bare platform spellings too. */
export function toDmChannel(value: string | null | undefined): DmChannel | null {
  if (value === 'instagram_dm' || value === 'instagram') return 'instagram_dm';
  if (value === 'tiktok_dm' || value === 'tiktok') return 'tiktok_dm';
  return null;
}

function cleanHandle(username: string | null | undefined): string | null {
  const h = (username ?? '').trim().replace(/^@+/, '');
  return h.length > 0 ? h : null;
}

function profileUrlFor(channel: DmChannel, handle: string): string {
  const h = encodeURIComponent(handle);
  return channel === 'instagram_dm'
    ? `https://www.instagram.com/${h}`
    : `https://www.tiktok.com/@${h}`;
}

/**
 * Resolve the DM target for one queue row: which network it is addressed to,
 * whether we hold a handle there, and where the operator should click.
 *
 * Keyed off the MESSAGE's channel, falling back to the creator's platform only
 * when the channel carries no DM information.
 */
export function resolveDmTarget(input: DmTargetInput): DmTarget {
  const handle = cleanHandle(input.username);
  const platformChannel = toDmChannel(input.platform);
  const fromChannel = toDmChannel(input.channel);
  const channel = fromChannel ?? platformChannel;

  // Nothing says which network this is. Fall back to whatever profile we
  // scraped; if there is not even that, the row is a dead end.
  if (!channel) {
    return {
      channel: null,
      label: 'DM',
      url: input.profileUrl ?? null,
      urlLabel: 'Open profile',
      inferred: true,
      sendable: Boolean(input.profileUrl),
      blockedReason: input.profileUrl
        ? null
        : 'No channel, handle or profile link is stored for this creator, so there is ' +
          'nowhere to send this draft. Re-run contact discovery for them before sending.',
    };
  }

  const network = NETWORK_LABEL[channel];

  // The handle we hold belongs to `platform`. If that is a different network
  // from the one this message is addressed to, we hold no address at all.
  if (!handle || platformChannel !== channel) {
    const held =
      handle && platformChannel
        ? `we only hold their ${NETWORK_LABEL[platformChannel]} handle (@${handle})`
        : 'we hold no handle for them on any network';
    return {
      channel,
      label: `${network} DM`,
      url: null,
      urlLabel: `Open ${network} profile`,
      inferred: fromChannel === null,
      sendable: false,
      blockedReason:
        `This draft is addressed to a ${network} DM, but ${held}, so nothing stored can ` +
        `reach them there. Re-route this lead to a ${
          platformChannel ? NETWORK_LABEL[platformChannel] : 'reachable'
        } DM, or add their ${network} handle, before marking anything sent.`,
    };
  }

  return {
    channel,
    label: `${network} DM`,
    url: profileUrlFor(channel, handle),
    urlLabel: `Open ${network} profile`,
    inferred: fromChannel === null,
    sendable: true,
    blockedReason: null,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 3. What order does a human work 300 of these in?
// ────────────────────────────────────────────────────────────────────────────

export interface DmQueueOrderKey {
  /** True when this row cannot be sent (refused, or no address). */
  blocked: boolean;
  /** campaign_influencers.composite_score — the pool's own value ranking. */
  compositeScore: number | null;
  /** outreach_messages.created_at, ISO. */
  createdAt: string;
  /** outreach_messages.id — the stable final tiebreak. */
  id: string;
}

/**
 * Highest-value sendable row first.
 *
 * The queue used to sort created_at ascending, which after one "Generate all
 * drafts" run over 300 creators is the order the bulk loop happened to insert
 * in — i.e. arbitrary. A human who gets through 40 of 300 rows should have
 * spent that hour on the 40 best creators, so composite_score leads.
 *
 * Blocked rows sink to the bottom rather than being hidden: a row that
 * disappears silently is how 8 unsendable leads stay invisible for a month.
 */
export function compareDmQueueOrder(a: DmQueueOrderKey, b: DmQueueOrderKey): number {
  if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
  const sa = a.compositeScore ?? Number.NEGATIVE_INFINITY;
  const sb = b.compositeScore ?? Number.NEGATIVE_INFINITY;
  if (sa !== sb) return sb - sa;
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  const va = Number.isFinite(ta) ? ta : 0;
  const vb = Number.isFinite(tb) ? tb : 0;
  if (va !== vb) return va - vb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
