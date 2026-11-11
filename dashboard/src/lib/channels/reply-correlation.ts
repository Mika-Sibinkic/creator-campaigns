// src/lib/channels/reply-correlation.ts
//
// The outbound half of reply correlation. sendOutreach (resend.ts) stamps a
// correlated Reply-To — `<inbox-local>+lead-<campaign_influencer_id>@<domain>` —
// on every outreach/counter email; the Gmail intake poller (gmail-inbound.ts)
// extracts the id from the reply's To header via the matching `+lead-` pattern.
// Kept dependency-free so hermetic tests can import it without env/SDK side
// effects.

/**
 * Build the correlated Reply-To for a lead: `local+lead-<ciId>@domain`.
 * `base` is the negotiation inbox (the account the Gmail poller reads) —
 * Gmail/Workspace deliver any `local+tag@` to `local@`, and the poller's
 * correlator extracts the ciId from the `+lead-` tag on the reply's To header.
 * Returns null when base is not a plain email (never guess an address).
 */
export function buildCorrelatedReplyTo(
  base: string | null | undefined,
  ciId: string,
): string | null {
  if (!base) return null;
  const m = base.trim().match(/^([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})$/);
  if (!m) return null;
  // Strip any existing +tag so a plus-addressed base can't stack tags.
  const local = m[1].split('+')[0];
  return `${local}+lead-${ciId}@${m[2]}`;
}
