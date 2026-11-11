// src/lib/takeover-state.ts
//
// MANUAL MODE ON A NEGOTIATION THREAD.
// Pure and dependency-free so the deals page and thread view can render it.
//
// An escalation used to flag ONE reply and leave the offer automatic: a human
// answered the creator outside the app at, say, $190, the creator wrote
// "Deal!", and the next tick agreed at the stale $150 the thread still showed.
// Now an escalation puts the OFFER into manual mode. In manual mode nothing is
// agreed or countered automatically; every reply goes to a human. Only an
// explicit "Resume automation" in the UI leaves it, and that requires the
// operator to enter the price they last quoted, which becomes the last sent
// price (negotiation-takeover.ts).
//
// Stored in the existing creator_offers.autonomy_mode text column (migration
// 018, no CHECK; its column comment already says "non-auto modes park the
// offer for human review"), so no migration:
//
//   'auto' / 'manual'   the existing modes (manual = AI negotiates, a human
//                       approves every payout)
//   'human'             taken over from 'auto'
//   'human:manual'      taken over from 'manual' (resume restores 'manual')

export const HUMAN_TAKEOVER_MODE = 'human' as const;
const FROM_MANUAL = 'human:manual' as const;

/** Is this offer in manual mode (a human has taken the thread over)? */
export function isHumanTakeover(offer: { autonomy_mode?: string | null } | null | undefined): boolean {
  const m = String(offer?.autonomy_mode ?? '');
  return m === HUMAN_TAKEOVER_MODE || m.startsWith(`${HUMAN_TAKEOVER_MODE}:`);
}

/** The autonomy_mode value that takes over from `previous`. */
export function takeoverModeFrom(previous: string | null | undefined): string {
  if (isHumanTakeover({ autonomy_mode: previous })) return String(previous);
  return previous === 'manual' ? FROM_MANUAL : HUMAN_TAKEOVER_MODE;
}

/** The autonomy_mode a resume restores. Anything unrecognised restores
 *  'manual' (a human approves every payout), never 'auto'. */
export function resumedModeFrom(current: string | null | undefined): 'auto' | 'manual' {
  if (current === HUMAN_TAKEOVER_MODE) return 'auto';
  return 'manual';
}

/** One line for the deal row / thread header. */
export const MANUAL_MODE_LABEL = 'Manual: you are handling this negotiation';
export const MANUAL_MODE_DETAIL =
  'Nothing is agreed or countered automatically. Reply to the creator yourself, or resume automation with the price you last quoted.';

/**
 * RESUME AGAINST THE RECORD. The resume panel
 * shows the last price on record (structured offer_usd on a sent row, never
 * parsed text). When the operator enters a DIFFERENT price, or nothing is on
 * record, they are asserting they quoted the creator a new number outside
 * the app, and must say so explicitly (NEW_QUOTE_CONFIRM_LABEL) before
 * automation will agree at it.
 */
export function resumeNeedsNewQuote(enteredUsd: number, lastSentUsd: number | null | undefined): boolean {
  if (lastSentUsd == null || !Number.isFinite(Number(lastSentUsd))) return true;
  return Math.abs(Number(enteredUsd) - Number(lastSentUsd)) >= 0.005;
}

export const NEW_QUOTE_CONFIRM_LABEL = 'I quoted this new price to the creator';

/** The resume panel's "last price on record" line. */
export function lastQuotedLine(lastSentUsd: number | null | undefined): string {
  return lastSentUsd == null || !Number.isFinite(Number(lastSentUsd))
    ? 'No price on record: nothing we sent recorded one.'
    : `Last price on record: $${Number(lastSentUsd).toFixed(2)}`;
}

/** Validate the price an operator enters to resume automation. */
export type ResumePriceCheck = { ok: true; usd: number } | { ok: false; message: string };

export function checkResumePrice(raw: unknown, ceilingUsd: number | null | undefined): ResumePriceCheck {
  const s = typeof raw === 'number' ? String(raw) : String(raw ?? '').trim().replace(/^\$/, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) {
    return { ok: false, message: 'Enter the price you last quoted the creator, in dollars (for example 190 or 190.50).' };
  }
  const usd = Number(s);
  if (!Number.isFinite(usd) || usd <= 0) return { ok: false, message: 'The price must be more than $0.' };
  const ceiling = Number(ceilingUsd);
  if (Number.isFinite(ceiling) && ceiling > 0 && usd > ceiling + 0.005) {
    return {
      ok: false,
      message: `$${usd} is above this creator's ceiling ($${ceiling}). Automation can't continue from a price it is not allowed to pay; keep handling this one yourself.`,
    };
  }
  return { ok: true, usd };
}
