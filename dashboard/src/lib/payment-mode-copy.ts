// src/lib/payment-mode-copy.ts
//
// Words for the Test/Live payments switch (migration 064). Pure and
// dependency-free on purpose: statuses.ts is bundled into client pages and
// reads parseModeMismatch, and the server paths write the same strings.
//
// A payment approved in one mode is never paid in another
// (payment-claim.claimForExecution pins approved_mode). The refusal is written
// to failure_reason as `mode_mismatch:<approved>:<current>` so every surface
// can rebuild the one sentence the operator needs.

export const MODE_MISMATCH_PREFIX = 'mode_mismatch';

/** Audit action for a claim refused because the approval was in another mode.
 *  In statuses.MONEY_ANOMALY_AUDIT_ACTIONS, so it lands in /anomalies. */
export const MODE_MISMATCH_ACTION = 'payment.mode_mismatch';

const LABELS: Record<string, string> = {
  paper: 'Paper',
  stripe_test: 'Test',
  stripe_live: 'Live',
  paypal_sandbox: 'PayPal sandbox',
  paypal_live: 'PayPal live',
};

export function paymentModeLabel(mode: string | null | undefined): string {
  return (mode && LABELS[mode]) || 'an earlier mode';
}

/** failure_reason for a mode-mismatch refusal. */
export function modeMismatchReason(approvedMode: string | null | undefined, currentMode: string): string {
  return `${MODE_MISMATCH_PREFIX}:${approvedMode ?? 'unrecorded'}:${currentMode}`;
}

export function parseModeMismatch(
  reason: string | null | undefined
): { approvedMode: string | null; currentMode: string | null } | null {
  if (!reason || !reason.startsWith(MODE_MISMATCH_PREFIX)) return null;
  const [, approved, current] = reason.split(':');
  return {
    approvedMode: approved && approved !== 'unrecorded' ? approved : null,
    currentMode: current || null,
  };
}

/** "Approved in Test; re-approve to pay in Live." */
export function modeMismatchSentence(approvedMode: string | null | undefined, currentMode: string | null | undefined): string {
  const approved = approvedMode ? `Approved in ${paymentModeLabel(approvedMode)}` : 'Approved before payment modes were recorded';
  const current = currentMode ? ` in ${paymentModeLabel(currentMode)}` : '';
  return `${approved}; re-approve to pay${current}.`;
}

export type PaymentModeTone = 'paper' | 'test' | 'live';

/**
 * The operator header chip for the resolved payments mode. Live is loud on
 * purpose: it is the one state where an approval moves real money.
 */
export function paymentModeChip(mode: string | null | undefined): { label: string; tone: PaymentModeTone } {
  switch (mode) {
    case 'paper':
      return { label: 'Paper money', tone: 'paper' };
    case 'stripe_test':
      return { label: 'Stripe test', tone: 'test' };
    case 'stripe_live':
      return { label: 'LIVE', tone: 'live' };
    case 'paypal_sandbox':
      return { label: 'PayPal sandbox', tone: 'test' };
    case 'paypal_live':
      return { label: 'LIVE (PayPal)', tone: 'live' };
    default:
      return { label: 'Payments mode unknown', tone: 'test' };
  }
}

/** The operator-facing guidance on a refused claim. */
export function modeMismatchGuidance(approvedMode: string | null | undefined, currentMode: string | null | undefined): string {
  return `No money moved. ${modeMismatchSentence(approvedMode, currentMode)}`;
}
