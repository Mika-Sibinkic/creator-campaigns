// src/lib/payout-guidance.ts
//
// Operator-facing guidance for the NON-provider payout refusals — the machine
// error codes this app itself emits from src/lib/execute-payment.ts. Stripe's
// own errors are mapped separately in src/lib/stripe-errors.ts (keyed on
// error.code / error.type).
//
// Rule: an operator staring at the approvals inbox must be able to read one
// sentence and know (a) whether money moved and (b) what to do next. A bare
// slug like `creator_monthly_cap_exceeded` fails that test.
//
// Pure data. No env, no I/O.

/** execute-payment machine code → what the operator should read. */
export const PAYOUT_REASON_GUIDANCE: Record<string, string> = {
  // ── Spend caps (src/lib/spend-caps.ts CAP_FAILURE_REASON) ──
  campaign_total_budget_exceeded:
    'No money moved: this payout would push the campaign past its total budget. Raise the campaign budget or drop the amount, then retry from the Deals page.',
  firm_monthly_cap_exceeded:
    'No money moved: this payout would push the firm past its monthly spend cap. Raise the monthly cap or wait for the next month, then retry from the Deals page.',
  creator_monthly_cap_exceeded:
    'No money moved: this creator has already hit their monthly payout cap. Raise the per-creator cap or wait for the next month, then retry from the Deals page.',
  // Older/alternate cap slugs written by the webhook gate.
  'cap:campaign':
    'No money moved: the campaign total budget cap refused this payout. Raise the campaign budget, then retry from the Deals page.',
  'cap:firm_monthly':
    'No money moved: the firm monthly spend cap refused this payout. Raise the monthly cap, then retry from the Deals page.',
  'cap:creator_monthly':
    'No money moved: the per-creator monthly cap refused this payout. Raise the per-creator cap, then retry from the Deals page.',

  // ── Recipient / state ──
  no_creator_email:
    'No money moved: this creator has no payout email on file. Add their contact email on the Deals page, then retry the payout.',
  not_approved:
    'No money moved: the authorization was not in an approved state when the payout ran. Reload the page to see its current state.',
  already_executing_or_not_approved:
    'No money moved from this click: another execution already claimed this payout. Check the Deals page for its current state before retrying.',
  forbidden:
    'No money moved: this payment authorization belongs to another firm. Nothing was charged.',
  not_found:
    'No money moved: the payment authorization could not be loaded. Reload the page; if it persists the row may have been deleted.',
  stripe_secret_key_missing:
    'No money moved: the Stripe key for the current payments mode is not configured on this deployment. Set STRIPE_SECRET_KEY_TEST or STRIPE_SECRET_KEY_LIVE in the environment, then retry the payout.',
};

/** Last-resort guidance keyed on the execute core's HTTP status. */
export const HTTP_STATUS_GUIDANCE: Record<number, string> = {
  400: 'No money moved: the payout request was rejected as invalid. Check the deal details on the Deals page, then retry.',
  403: 'No money moved: this payout was refused as not permitted. Nothing was charged.',
  404: 'No money moved: the payment authorization could not be found. Reload the page.',
  409: 'No money moved: the payout was refused because the authorization was not in a payable state. Reload the page to see its current state.',
  500: 'No money moved: the payout hit an internal error. Retry it from the Deals page; if it repeats, check the audit log.',
  502: 'No money moved: the payment provider refused or could not be reached. Retry it from the Deals page.',
  503: 'No money moved: the payment provider was unavailable. Retry it from the Deals page in a few minutes.',
};
