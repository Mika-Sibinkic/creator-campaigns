// src/lib/do-not-contact-copy.ts
//
// What /approvals and the deal row SAY when the creator on a deal is on the
// label's do-not-contact list. Display only: the
// payment paths are unchanged, so a human can still approve — this exists so
// they see "this creator told you to stop" BEFORE they click, not after.
//
// Pure and client-safe (the deals page is a client component). The flag
// itself comes from firm-blocks.readDoNotContactFlags on the server.

import type { DoNotContactFlag } from './firm-blocks';

/** A flag, or 'unknown' when the list could not be read (absent ≠ clear). */
export type DoNotContactDisplay = DoNotContactFlag | 'unknown';

export interface DoNotContactNotice {
  /** Short badge text. */
  label: string;
  /** One sentence: what it means and what to do. */
  detail: string;
}

export function doNotContactNotice(
  flag: DoNotContactDisplay | null | undefined,
): DoNotContactNotice | null {
  switch (flag) {
    case 'opted_out':
      return {
        label: 'Creator opted out',
        detail:
          'This creator replied STOP to your label. Nothing more will be sent to them; check the thread before you approve a payment.',
      };
    case 'label_blocked':
      return {
        label: 'Blocked by your label',
        detail:
          'Someone on your label blocked this creator. Nothing more will be sent to them; check the thread before you approve a payment.',
      };
    case 'platform_blocked':
      return {
        label: 'Blocked',
        detail:
          'This creator is blocked for every label. Nothing more will be sent to them; check the thread before you approve a payment.',
      };
    case 'unknown':
      return {
        label: 'Opt-out not checked',
        detail:
          "We couldn't read your do-not-contact list just now, so we can't say whether this creator opted out. Check the thread before you approve.",
      };
    default:
      return null;
  }
}
