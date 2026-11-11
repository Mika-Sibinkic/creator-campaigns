// tests/resend-correlation.test.ts
//
// Hermetic tests for the Resend delivery-correlation fix:
//   - src/lib/resend-events.ts: event→status mapping + the no-downgrade rank
//   - src/lib/statuses.ts: the bounced_email anomaly lane
//
// Run: npx tsx tests/resend-correlation.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resendEventToStatus,
  mayOverwriteStatus,
  allowedPreviousDeliveryStatuses,
} from '../src/lib/resend-events';
import { detectAnomalies, type AnomaliesInput } from '../src/lib/statuses';

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

async function main() {
  // ── Event mapping ────────────────────────────────────────────────────────
  assert(resendEventToStatus('email.delivered') === 'delivered', 'delivered maps');
  assert(resendEventToStatus('email.opened') === 'opened', 'opened maps');
  assert(resendEventToStatus('email.clicked') === 'clicked', 'clicked maps');
  assert(resendEventToStatus('email.bounced') === 'bounced', 'bounced maps');
  assert(resendEventToStatus('email.bounce') === 'bounced', 'legacy bounce alias maps');
  assert(resendEventToStatus('email.complained') === 'complained', 'complained maps');
  assert(resendEventToStatus('email.sent') === null, 'unknown event → null (no write)');
  assert(resendEventToStatus('') === null, 'empty event → null');

  // ── No-downgrade rank ────────────────────────────────────────────────────
  assert(mayOverwriteStatus('sent', 'delivered'), 'sent → delivered allowed');
  assert(mayOverwriteStatus(null, 'delivered'), 'null → delivered allowed');
  assert(mayOverwriteStatus('delivered', 'opened'), 'delivered → opened allowed');
  assert(mayOverwriteStatus('opened', 'clicked'), 'opened → clicked allowed');
  assert(mayOverwriteStatus('delivered', 'bounced'), 'delivered → bounced allowed');
  assert(!mayOverwriteStatus('opened', 'delivered'), 'late delivered never erases opened');
  assert(!mayOverwriteStatus('bounced', 'delivered'), 'nothing downgrades bounced');
  assert(!mayOverwriteStatus('complained', 'opened'), 'nothing downgrades complained');
  assert(mayOverwriteStatus('bounced', 'complained'), 'terminal-bad peers may swap');
  assert(mayOverwriteStatus('delivered', 'delivered'), 'retried same-status write is idempotent-allowed');

  // ── bounced_email anomaly lane ───────────────────────────────────────────
  const NOW = Date.parse('2026-09-17T12:00:00.000Z');
  const base: AnomaliesInput = {
    offers: [],
    payments: [],
    deliveries: [],
    audit: [],
    inbound: [],
    cis: [{ id: 'ci-1', campaign_id: 'camp-1', influencer_id: 'inf-1' }],
    influencers: [{ id: 'inf-1', username: 'creatrix' }],
    campaigns: [{ id: 'camp-1', artist_name: 'Ada Sample' }],
    hasContractTemplate: false,
  };

  {
    const rows = detectAnomalies(
      {
        ...base,
        bounced: [
          {
            id: 'om-1',
            campaign_influencer_id: 'ci-1',
            delivery_status: 'bounced',
            sent_to: 'dead@example.com',
            sent_at: '2026-09-17T10:00:00.000Z',
            created_at: '2026-09-17T09:00:00.000Z',
          },
          {
            id: 'om-2',
            campaign_influencer_id: 'ci-1',
            delivery_status: 'complained',
            sent_to: 'angry@example.com',
            sent_at: null,
            created_at: '2026-09-17T09:30:00.000Z',
          },
        ],
      },
      NOW,
    );
    assert(rows.length === 2, 'one anomaly per bounced/complained message');
    const bounce = rows.find((r) => r.ref === 'bounce-om-1');
    const spam = rows.find((r) => r.ref === 'bounce-om-2');
    assert(bounce?.category === 'bounced_email', 'bounce categorized bounced_email');
    assert(bounce?.what.includes('bounced') === true, 'bounce copy names the bounce');
    assert(bounce?.detail === 'Sent to dead@example.com', 'bounce detail carries the address');
    assert(bounce?.who === '@creatrix', 'bounce attributed to the creator');
    assert(bounce?.campaign_id === 'camp-1', 'bounce attributed to the campaign');
    assert(bounce?.at === '2026-09-17T10:00:00.000Z', 'bounce uses sent_at when present');
    assert(spam?.what.includes('spam') === true, 'complaint copy names spam');
    assert(spam?.at === '2026-09-17T09:30:00.000Z', 'complaint falls back to created_at');
  }
  {
    const rows = detectAnomalies({ ...base }, NOW);
    assert(rows.length === 0, 'absent bounced input stays silent');
  }

  // ── The atomic rank guard ─────────────────────────
  // mayOverwriteStatus alone is a SELECT-then-decide check: two concurrent
  // Svix deliveries can both read the same pre-state and both conclude they
  // may write. allowedPreviousDeliveryStatuses turns the same rule into a
  // predicate the DATABASE enforces on the UPDATE.
  {
    const vocabulary = ['delivered', 'opened', 'clicked', 'bounced', 'complained'];
    for (const next of vocabulary) {
      const allowed = allowedPreviousDeliveryStatuses(next);
      // The predicate must agree with the JS guard on every pair — if these
      // ever diverge, one of the two silently stops protecting anything.
      for (const prev of vocabulary) {
        assert(
          allowed.includes(prev) === mayOverwriteStatus(prev, next),
          `rank predicate agrees with mayOverwriteStatus for ${prev} -> ${next}`,
        );
      }
      assert(allowed.includes(next), `${next} may overwrite itself — retries stay idempotent`);
    }
    assert(
      !allowedPreviousDeliveryStatuses('delivered').includes('opened'),
      'a late delivered may NOT overwrite an opened — the downgrade the guard exists to stop',
    );
    assert(
      !allowedPreviousDeliveryStatuses('opened').includes('bounced'),
      'nothing may overwrite a terminal bounced',
    );
    assert(
      allowedPreviousDeliveryStatuses('complained').includes('bounced'),
      'bounced and complained are equal-rank terminal-bad and may replace each other',
    );
  }

  // ── Source guard: delivery events must never target `status` ────────────
  // This is the most important rule here, and it cannot
  // be caught behaviorally from here — the write is inline in the route. So
  // assert it against the source. outreach_messages.status is the SEND
  // lifecycle and six analytics/performance readers use status='sent' as a
  // denominator; writing 'opened' there removes engaged creators from the
  // denominator while leaving them in the numerator.
  {
    const routePath = join(process.cwd(), 'src/app/api/webhooks/resend/route.ts');
    const src = readFileSync(routePath, 'utf8');
    assert(
      /delivery_status:\s*deliveryStatus/.test(src),
      'webhook writes the event into delivery_status',
    );
    assert(
      !/\.update\(\{\s*status[,:]/.test(src),
      'webhook UPDATE payload never sets a bare `status` key',
    );
    assert(
      !/\bstatus:\s*(status|deliveryStatus)\b/.test(src),
      'no delivery value is ever assigned to a `status` field',
    );
    assert(
      src.includes("delivery_status.is.null"),
      'the UPDATE carries the rank predicate, including the NULL arm (SQL IN never matches NULL)',
    );
    assert(
      /kind:\s*'retryable'/.test(src) && src.includes('503'),
      'DB failures surface as a retryable 5xx so Svix redelivers instead of the event being lost',
    );
  }

  console.log(`resend-correlation test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
