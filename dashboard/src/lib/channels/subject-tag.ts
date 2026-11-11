// src/lib/channels/subject-tag.ts
//
// Single source of truth for the `[Creator Campaigns]` subject tag.
// Outbound outreach in testing-mode is prefixed with this tag so creator
// replies self-filter: the Gmail intake adapter only acts on threads whose
// subject starts with `[Creator Campaigns]`, and the send path stamps it on the way
// out. Kept tiny + dependency-free so the send path (resend.ts), the tick
// dispatcher (negotiation-tick.ts) and the Gmail poller all share one constant.

export const SUBJECT_TAG = '[Creator Campaigns]';

/** True when a subject already carries the tag (anywhere, case-insensitive). */
export function hasSubjectTag(subject: string | null | undefined): boolean {
  if (!subject) return false;
  return subject.toLowerCase().includes(SUBJECT_TAG.toLowerCase());
}

/**
 * Ensure a subject is prefixed with the `[Creator Campaigns]` tag. Idempotent: a
 * subject that already contains the tag (e.g. a threaded "Re: [Creator Campaigns] …")
 * is returned unchanged, so re-sends + replies never double-tag.
 */
export function ensureSubjectTagPrefix(subject: string | null | undefined): string {
  const s = (subject ?? '').trim();
  if (hasSubjectTag(s)) return s;
  return s ? `${SUBJECT_TAG} ${s}` : SUBJECT_TAG;
}

/**
 * Remove the `[Creator Campaigns]` tag from a subject, wherever it sits.
 *
 * WHY THIS HAS TO EXIST
 *
 * `ensureSubjectTagPrefix` was being called at INSERT time by the
 * counter and acceptance schedulers, unconditionally — so the tag was
 * persisted into `outreach_messages.subject`. The send path's testing-mode
 * fork (buildOutboundEnvelope) then had nothing left to protect: it only
 * declines to ADD the tag in live mode, and the subject arrived already
 * carrying it. Worse, threaded rounds reuse the stored subject, so one tagged
 * insert propagated `[Creator Campaigns]` through every later message on that thread.
 *
 * Strips every occurrence (a subject could carry two after a round-trip
 * through a client that re-prefixed "Re:"), collapses the whitespace it
 * leaves behind, and preserves a leading reply/forward marker so
 * "Re: [Creator Campaigns] Terms" becomes "Re: Terms" rather than "Terms".
 */
export function stripSubjectTag(subject: string | null | undefined): string {
  if (!subject) return '';
  const tag = SUBJECT_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return subject
    .replace(new RegExp(tag, 'gi'), ' ')
    .replace(/\s{2,}/g, ' ')
    // A stripped tag can leave "Re:  : Terms" style debris only if the caller
    // built the subject oddly; normalise the common "Re: " spacing.
    .replace(/^\s*((?:re|fwd?)\s*:\s*)+/i, (m) => m.replace(/\s+/g, ' ').trimStart())
    .trim();
}

/**
 * THE decision point for the tag: tag in testing mode, strip in live mode.
 *
 * Callers must use this instead of `ensureSubjectTagPrefix` anywhere a
 * subject is written down or put on the wire. The one-way helper above cannot
 * express "and remove it if we are live", which is exactly the hole real
 * creators fell through. Idempotent in both directions.
 */
export function applySubjectTag(
  subject: string | null | undefined,
  testingMode: boolean,
): string {
  return testingMode
    ? ensureSubjectTagPrefix(subject)
    : stripSubjectTag(subject);
}
