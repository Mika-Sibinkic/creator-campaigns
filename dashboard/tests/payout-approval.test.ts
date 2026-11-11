// tests/payout-approval.test.ts
//
// Hermetic tests for src/lib/payout-surfacing.ts — the contract that stops a
// FAILED payout from rendering as a successful approval.
//
// The hole this closes: /api/payments/[id]/approve auto-executes the payout and
// used to answer HTTP 200 no matter what, burying the failure in
// `{ executed: { ok: false } }`. Both clients only checked `response.ok`, so the
// row silently left the approvals inbox (it no longer matches the
// status='pending_human_review' filter) and the operator saw nothing.
//
// Contract under test:
//   * approved + paid / legitimately pending  → HTTP 200
//   * approved + payout did NOT go out        → HTTP 207 Multi-Status
//   * `payout.ok === false` is always present and explicit on the failure path
//   * `payout.guidance` is an operator-facing sentence; `payout.raw_error`
//     keeps the provider's verbatim prose for the audit trail
//   * the approval row's own fields are never dropped (approval DID succeed)
//
// Run: npx tsx tests/payout-approval.test.ts

import {
  buildApproveResponse,
  summarizePayout,
  type ExecutedOutcome,
} from '../src/lib/payout-surfacing';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(msg);
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

const APPROVAL_ROW = {
  id: 'pa-1',
  firm_id: 'firm-1',
  status: 'approved',
  amount_usd: 185,
  human_approved_at: '2026-09-15T00:00:00.000Z',
};

// ── 1. Stripe failure (Connect not enabled on the platform) ────────────────
{
  const executed: ExecutedOutcome = {
    httpStatus: 502,
    body: {
      ok: false,
      provider_id: '',
      payment_mode: 'stripe_test',
      error: 'Only Stripe Connect platforms can work with other accounts.',
      reason: 'stripe_connect_not_enabled',
      guidance:
        'Stripe Connect is not enabled on this platform account. Enable Connect in the Stripe Dashboard, then retry the payout.',
    },
  };
  const res = buildApproveResponse(APPROVAL_ROW, executed);
  assert(res.httpStatus === 207, `stripe failure → 207 Multi-Status (got ${res.httpStatus})`);
  const payout = res.body.payout as Record<string, unknown>;
  assert(payout.ok === false, 'stripe failure → payout.ok === false');
  assert(payout.status === 'failed', 'stripe failure → payout.status "failed"');
  assert(payout.reason === 'stripe_connect_not_enabled', 'stripe failure → mapped reason slug');
  assert(
    typeof payout.guidance === 'string' && (payout.guidance as string).includes('Connect'),
    'stripe failure → operator-facing guidance'
  );
  assert(
    payout.raw_error === 'Only Stripe Connect platforms can work with other accounts.',
    'stripe failure → raw provider prose preserved verbatim'
  );
  assert(payout.http_status === 502, 'stripe failure → underlying execute status carried');
  assert(res.body.approved === true, 'the approval itself still reports success');
  assert(res.body.id === 'pa-1' && res.body.status === 'approved', 'approval row fields preserved');
}

// ── 2. Success still behaves as before ─────────────────────────────────────
{
  const executed: ExecutedOutcome = {
    httpStatus: 200,
    body: { ok: true, provider_id: 'tr_123', dry_run: false, payment_mode: 'stripe_test' },
  };
  const res = buildApproveResponse(APPROVAL_ROW, executed);
  assert(res.httpStatus === 200, `success → 200 (got ${res.httpStatus})`);
  const payout = res.body.payout as Record<string, unknown>;
  assert(payout.ok === true, 'success → payout.ok === true');
  assert(payout.status === 'paid', 'success → payout.status "paid"');
  assert(payout.reason === null, 'success → no reason slug');
  assert(payout.raw_error === null, 'success → no raw error');
  assert(payout.provider_id === 'tr_123', 'success → provider_id surfaced');
  // Back-compat: the pre-existing `executed` envelope is still emitted.
  const legacy = res.body.executed as Record<string, unknown>;
  assert(legacy?.ok === true, 'success → legacy `executed.ok` preserved');
  assert(legacy?.http_status === 200, 'success → legacy `executed.http_status` preserved');
  assert(legacy?.provider_id === 'tr_123', 'success → legacy `executed` still spreads the body');
}

// ── 3. Spend-cap breach is a payout failure, not a silent 200 ──────────────
{
  const executed: ExecutedOutcome = {
    httpStatus: 409,
    body: { error: 'campaign_total_budget_exceeded', campaign_budget_usd: 500, spent_usd: 480 },
  };
  const res = buildApproveResponse(APPROVAL_ROW, executed);
  assert(res.httpStatus === 207, `cap breach → 207 (got ${res.httpStatus})`);
  const payout = res.body.payout as Record<string, unknown>;
  assert(payout.ok === false, 'cap breach → payout.ok === false');
  assert(payout.reason === 'campaign_total_budget_exceeded', 'cap breach → reason is the cap code');
  assert(
    typeof payout.guidance === 'string' && /budget/i.test(payout.guidance as string),
    'cap breach → guidance names the budget'
  );
}

// ── 4. Missing creator email ───────────────────────────────────────────────
{
  const executed: ExecutedOutcome = { httpStatus: 400, body: { error: 'no_creator_email' } };
  const res = buildApproveResponse(APPROVAL_ROW, executed);
  assert(res.httpStatus === 207, 'no_creator_email → 207');
  const payout = res.body.payout as Record<string, unknown>;
  assert(payout.ok === false, 'no_creator_email → payout.ok === false');
  assert(
    typeof payout.guidance === 'string' && /email/i.test(payout.guidance as string),
    'no_creator_email → guidance names the email'
  );
}

// ── 5. Awaiting creator onboarding is NOT a failure, but is NOT "paid" ─────
{
  const executed: ExecutedOutcome = {
    httpStatus: 200,
    body: { ok: true, needs_onboarding: true, status: 'awaiting_onboarding' },
  };
  const res = buildApproveResponse(APPROVAL_ROW, executed);
  assert(res.httpStatus === 200, 'awaiting onboarding → 200 (nothing failed)');
  const payout = res.body.payout as Record<string, unknown>;
  assert(payout.ok === true, 'awaiting onboarding → payout.ok === true');
  assert(payout.status === 'awaiting_onboarding', 'awaiting onboarding → distinct status');
  assert(
    typeof payout.guidance === 'string' && /set up|onboard/i.test(payout.guidance as string),
    'awaiting onboarding → operator is told money has NOT moved yet'
  );
}

// ── 6. Unknown failures still surface, never swallowed ─────────────────────
{
  const executed: ExecutedOutcome = {
    httpStatus: 500,
    body: { error: 'socket hang up' },
  };
  const res = buildApproveResponse(APPROVAL_ROW, executed);
  assert(res.httpStatus === 207, 'unmapped failure → 207');
  const payout = res.body.payout as Record<string, unknown>;
  assert(payout.ok === false, 'unmapped failure → payout.ok === false');
  assert(payout.reason === 'socket hang up', 'unmapped failure → reason falls back to the raw code');
  assert(
    typeof payout.guidance === 'string' && (payout.guidance as string).length > 0,
    'unmapped failure → still gets a guidance line'
  );
}

// A refusal with no body at all must not read as success.
{
  const res = buildApproveResponse(APPROVAL_ROW, { httpStatus: 409, body: {} });
  assert(res.httpStatus === 207, 'bodyless 409 → 207');
  assert((res.body.payout as Record<string, unknown>).ok === false, 'bodyless 409 → payout.ok false');
}

// ── 7. INVARIANT: HTTP 200 and payout.ok === false can never co-occur ──────
{
  const table: ExecutedOutcome[] = [
    { httpStatus: 200, body: { ok: true } },
    { httpStatus: 200, body: { ok: false, error: 'weird' } },
    { httpStatus: 200, body: {} },
    { httpStatus: 201, body: { ok: true } },
    { httpStatus: 400, body: { error: 'no_creator_email' } },
    { httpStatus: 403, body: { error: 'forbidden' } },
    { httpStatus: 404, body: { error: 'not_found' } },
    { httpStatus: 409, body: { error: 'already_executing_or_not_approved' } },
    { httpStatus: 409, body: { error: 'firm_monthly_cap_exceeded' } },
    { httpStatus: 409, body: { error: 'creator_monthly_cap_exceeded' } },
    { httpStatus: 502, body: { ok: false, error: 'balance_insufficient' } },
    { httpStatus: 503, body: {} },
  ];
  let violations = 0;
  let missingReason = 0;
  for (const outcome of table) {
    const { httpStatus, body } = buildApproveResponse(APPROVAL_ROW, outcome);
    const payout = body.payout as { ok: boolean; reason: string | null; guidance: string | null };
    if (httpStatus === 200 && payout.ok === false) violations++;
    if (payout.ok === false && (!payout.reason || !payout.guidance)) missingReason++;
    if (httpStatus !== 200 && httpStatus !== 207) violations++;
  }
  assert(violations === 0, `no outcome yields a success status with a failed payout (${violations} violations)`);
  assert(missingReason === 0, `every failed payout carries both a reason and guidance (${missingReason} missing)`);
}

// ── 8. summarizePayout is usable standalone (the UI reads the same shape) ──
{
  const s = summarizePayout({ httpStatus: 502, body: { ok: false, error: 'balance_insufficient' } });
  assert(s.ok === false, 'summarizePayout: standalone failure');
  assert(typeof s.guidance === 'string' && s.guidance.length > 0, 'summarizePayout: guidance present');
}

if (failures.length > 0) console.error('\nFailures:\n - ' + failures.join('\n - '));
console.log(`payout-approval test: ${passed}/${passed + failed} pass`);
process.exit(failed === 0 ? 0 : 1);
