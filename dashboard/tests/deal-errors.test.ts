// tests/deal-errors.test.ts
//
// Unit tests for src/lib/deal-errors.ts — the resolver that decides what a
// label manager reads when a deal-row action fails.
//
// There is no browser harness in this repo, so this module is the testable
// seam: DealRow.tsx and deals/page.tsx now do the lookup and nothing else.
//
// The regressions this locks down, each read off a real route:
//
//   1. PRECEDENCE. The server bakes operator guidance into the response
//      server-side (Stripe mapper → stripe-isolated → payout-surfacing). That
//      prose must win over everything here, or we would be second-guessing the
//      Stripe mapper from the client. It also must survive a 207.
//   2. `message` WAS BEING THROWN AWAY. The old client read only
//      `guidance ?? error`, so /quick-offer's `over_cap` and `creator_excluded`
//      — which both ship a written sentence — rendered as the bare slug.
//   3. NO BARE SLUGS. `over_cap`, `invalid_state`, `agreed_above_ceiling` were
//      the three that reached the screen; none of them may survive there.
//   4. REUSE, NOT A SECOND MAPPER. Every early-return guard in
//      execute-payment.ts already has copy in payout-guidance.ts. The approve
//      path surfaces it; the execute path returns the bare slug. Reading the
//      same map here means both buttons say the same thing.
//   5. AN UNMAPPED FAILURE IS NOT HIDDEN. Friendlier copy that erases the
//      original text would be worse than the slug it replaced.
//
// Run: npx tsx tests/deal-errors.test.ts

import {
  DEAL_ERROR_COPY,
  GENERIC_DEAL_ERROR,
  describeDealError,
  describeFailureReason,
} from '../src/lib/deal-errors';
import { PAYOUT_REASON_GUIDANCE } from '../src/lib/payout-guidance';

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

// ── 1. Precedence ───────────────────────────────────────────────────────────
{
  const stripeGuidance =
    'No money moved — the platform Stripe balance is too low to cover this payout.';
  assert(
    describeDealError({
      guidance: stripeGuidance,
      message: 'something else',
      error: 'balance_insufficient',
    }) === stripeGuidance,
    'server-baked guidance beats both message and error',
  );
  assert(
    describeDealError({ message: 'route prose', error: 'over_cap' }) === 'route prose',
    'route message beats the slug map',
  );
  // A 207 from /api/payments/[id]/approve carries payout.guidance; DealRow
  // forwards it through this same resolver.
  assert(
    describeDealError({ guidance: stripeGuidance }, 207) === stripeGuidance,
    '207 multi-status guidance is used verbatim',
  );
  assert(
    describeDealError({ guidance: '   ' , error: 'invalid_state' }) ===
      DEAL_ERROR_COPY.invalid_state,
    'whitespace-only guidance does not win',
  );
}

// ── 2. The three slugs that used to reach the screen ───────────────────────
{
  for (const slug of ['over_cap', 'invalid_state', 'agreed_above_ceiling']) {
    const out = describeDealError({ error: slug });
    assert(!out.includes(slug), `${slug} never reaches the screen as a slug`);
    assert(out.length > 30, `${slug} maps to a real sentence, not a word`);
    assert(/[.!]$/.test(out.trim()), `${slug} copy is a complete sentence`);
  }
}

// ── 3. Reuse of payout-guidance, not a duplicate map ────────────────────────
{
  // These slugs come out of execute-payment.ts and are already written up in
  // payout-guidance.ts. They must resolve to that exact copy.
  const reused = [
    'campaign_total_budget_exceeded',
    'firm_monthly_cap_exceeded',
    'creator_monthly_cap_exceeded',
    'no_creator_email',
    'already_executing_or_not_approved',
    'stripe_secret_key_missing',
  ];
  for (const slug of reused) {
    assert(
      describeDealError({ error: slug }) === PAYOUT_REASON_GUIDANCE[slug],
      `${slug} reuses payout-guidance copy verbatim`,
    );
    assert(
      !Object.prototype.hasOwnProperty.call(DEAL_ERROR_COPY, slug),
      `${slug} is NOT re-declared in DEAL_ERROR_COPY (would be a second mapper)`,
    );
  }
  // Where both maps have a key, DEAL_ERROR_COPY is the deliberate override.
  assert(
    describeDealError({ error: 'not_approved' }) === DEAL_ERROR_COPY.not_approved,
    'a slug present in both maps takes the deal-specific wording',
  );
}

// ── 4. Every mapped sentence is actually user-facing ────────────────────────
{
  for (const [slug, copy] of Object.entries(DEAL_ERROR_COPY)) {
    assert(!copy.includes(slug), `${slug}: copy does not echo its own slug`);
    assert(
      !/_usd\b|_id\b|creator_offers|campaign_influencers|payment_authorizations/.test(copy),
      `${slug}: copy names no raw DB column or table`,
    );
    assert(copy.trim() === copy && copy.length > 20, `${slug}: copy is trimmed prose`);
  }
}

// ── 5. Unmapped failures stay visible ───────────────────────────────────────
{
  const unknownSlug = describeDealError({ error: 'some_new_slug' });
  assert(
    unknownSlug.includes('some_new_slug'),
    'an unmapped slug is kept visible, not erased by generic copy',
  );
  assert(
    unknownSlug.startsWith(GENERIC_DEAL_ERROR),
    'an unmapped slug is wrapped in the generic sentence',
  );

  // Raw Postgres prose comes back in `error` on the 500 paths. It has spaces,
  // so it is prose, not a slug — keep it readable rather than bracketed.
  const pg = 'duplicate key value violates unique constraint "creator_offers_pkey"';
  const out = describeDealError({ error: pg });
  assert(out.includes(pg), 'raw provider/DB prose is preserved in full');
  assert(!out.includes('('), 'prose is not wrapped in slug brackets');
}

// ── 6. Degenerate inputs ────────────────────────────────────────────────────
{
  assert(describeDealError(null) === GENERIC_DEAL_ERROR, 'null payload → generic');
  assert(describeDealError(undefined) === GENERIC_DEAL_ERROR, 'undefined payload → generic');
  assert(describeDealError({}) === GENERIC_DEAL_ERROR, 'empty payload → generic');
  assert(
    describeDealError({}, 500) === `${GENERIC_DEAL_ERROR} (error 500)`,
    'bodyless failure still names the status so it stays diagnosable',
  );
  assert(
    describeDealError({ error: '' }, 502).includes('502'),
    'empty error string falls through to the status',
  );
  // Never leak the phrase "HTTP 500" at a user — that was the old fallback.
  assert(
    !describeDealError({}, 500).includes('HTTP'),
    'the old bare `HTTP <status>` string is gone',
  );
}

// ── 7. A refused cap is reported as a refusal, not as a system fault ────────
{
  const capCopy = describeDealError({ error: 'campaign_budget_not_set' });
  assert(
    capCopy.startsWith('No money moved'),
    'an unset campaign budget says plainly that no money moved',
  );
  assert(
    /budget/i.test(capCopy) && /confirm/i.test(capCopy),
    'it points at the confirm page, where the budget is actually set',
  );
  assert(
    describeDealError({ error: 'over_cap' }).toLowerCase().includes('limit'),
    'over_cap explains it is a limit doing its job',
  );
}

// ── 8. Stored failure_reason is a different animal from a live response ────
//
// payment_authorizations.failure_reason holds three different kinds of value,
// written by four different code paths. Verified writers:
//   execute-payment.ts:173  CAP_FAILURE_REASON[cap]      → slug
//   execute-payment.ts:221  'no_creator_email'           → slug
//   quick-offer/.../cancel  'cancelled_by_operator'      → slug
//   payments/[id]/reject    body.reason ?? 'rejected by reviewer'
//                                                        → a HUMAN's own words
//   webhooks/stripe:218     payout.guidance              → already-mapped prose
{
  assert(describeFailureReason(null) === '', 'a null reason renders nothing');
  assert(describeFailureReason(undefined) === '', 'an undefined reason renders nothing');
  assert(describeFailureReason('   ') === '', 'a whitespace reason renders nothing');

  assert(
    describeFailureReason('no_creator_email') === PAYOUT_REASON_GUIDANCE.no_creator_email,
    'a slug written by execute-payment maps to its existing copy',
  );
  assert(
    describeFailureReason('campaign_total_budget_exceeded') ===
      PAYOUT_REASON_GUIDANCE.campaign_total_budget_exceeded,
    'a cap slug maps to its existing copy',
  );
  assert(
    describeFailureReason('cancelled_by_operator') === DEAL_ERROR_COPY.cancelled_by_operator,
    'the cancel route slug is mapped',
  );
  assert(
    describeFailureReason('rejected by reviewer') ===
      DEAL_ERROR_COPY['rejected by reviewer'],
    'the reject route default is mapped even though it contains spaces',
  );

  // The Stripe webhook stores already-mapped guidance. Re-wrapping it would
  // read "That did not go through: No money moved — ...".
  const guidance =
    "No money moved — the creator hasn't finished their Stripe payout onboarding, so payouts are still disabled on their account.";
  assert(
    describeFailureReason(guidance) === guidance,
    'already-mapped guidance is shown verbatim, never re-framed',
  );

  // A reviewer's own note is a human fact. Rewriting it would be a lie.
  assert(
    describeFailureReason('too expensive for this release') ===
      'too expensive for this release',
    "a reviewer's typed reason is shown exactly as typed",
  );

  // An unmapped slug is still machine-shaped and gets framed, not hidden.
  const unknown = describeFailureReason('paypal_denied');
  assert(unknown.includes('paypal_denied'), 'an unmapped slug stays visible');
  assert(
    unknown.startsWith(GENERIC_DEAL_ERROR),
    'an unmapped slug is framed by the generic sentence',
  );
}

console.log(`deal-errors test: ${passed} passed, ${failed} failed`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
