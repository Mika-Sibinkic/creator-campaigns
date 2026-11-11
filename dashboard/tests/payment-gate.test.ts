// tests/payment-gate.test.ts
//
// WHAT THIS GUARDS: the requirement on the money path —
//   * every AI-reached "yes, pay this creator" is blocked by ONE human approval
//     before any money moves;
//   * a human can stop a payment right up to the moment it moves;
//   * every money anomaly is tracked AND visible.
//
// One section per defect found by the 2026-09-30 audit:
//   1. The Stripe account.updated webhook paid approved rows without
//      re-reading the deal — a cancelled/closed/undelivered deal still paid.
//   2. An approved payment waiting on creator onboarding could not be revoked:
//      the reject route only accepted 'pending_human_review'.
//   3. The webhook and execute paths used DIFFERENT idempotency keys, so a
//      reclaimed row retried by the other path could transfer twice.
//   4. The webhook's claim did not stamp executing_at, so a stranded webhook
//      payout was invisible to the reclaimer and burned budget forever. Plus:
//      the whole execute path must keep working before migration 055.
//   5. Money anomalies that only reached audit_log/Sentry (webhook cap
//      refusal, reclaimed claim, stuck 'executing', Stripe payout.failed) were
//      not in the anomalies feed.
//
// Hermetic: in-memory store, dummy env (setup-env), paper payments mode,
// fetch stubbed, injected payout/audit/alert. No DB, no Stripe, no network.
//
// Run: npx tsx tests/payment-gate.test.ts

import './negotiation-harness/setup-env'; // FIRST — dummy env
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeStore, type Row } from './negotiation-harness/store';
import {
  payoutIdempotencyKey,
  claimForExecution,
  isOfferPayable,
  checkOfferPayable,
  OFFER_NOT_PAYABLE_REASON,
  retryRefusal,
  offerSettlementUpdate,
} from '../src/lib/payment-claim';
import {
  payOnboardedAuthorization,
  type AwaitingAuthorization,
  type OnboardingPayoutDeps,
} from '../src/lib/onboarding-payout';
import { rejectPaymentAuthorization } from '../src/lib/reject-payment';
import { cancelOffer } from '../src/lib/cancel-offer';
import { runPaymentReclaim, STALE_EXECUTING_MS } from '../src/lib/payment-reclaim';
import { executeAuthorizedPayment } from '../src/lib/execute-payment';
import {
  detectAnomalies,
  MONEY_ANOMALY_AUDIT_ACTIONS,
  OPERATOR_ONLY_ANOMALY_CATEGORIES,
  ANOMALY_CATEGORIES,
  STUCK_EXECUTING_MS,
  type AnomaliesInput,
} from '../src/lib/statuses';
import type { StripeTransferInput, StripeTransferResult } from '../src/lib/stripe-isolated';
import type { AuditEntry } from '../src/lib/audit';

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

const SRC = join(__dirname, '..', 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const FIRM = 'firm-1';
const CAMPAIGN = 'camp-1';
const ACCT = 'acct_123';
const NOW = new Date('2026-09-30T12:00:00.000Z');

// ── Fakes ────────────────────────────────────────────────────────────────────

interface AuditCall {
  action: string;
  target_type: string;
  target_id: string;
  firm_id?: string;
  metadata?: Record<string, unknown>;
}

function makeDeps(opts: {
  payout?: Partial<StripeTransferResult>;
  capAllowed?: boolean;
} = {}) {
  const audits: AuditCall[] = [];
  const alerts: string[] = [];
  const payouts: StripeTransferInput[] = [];
  const promos: string[] = [];
  const deps: OnboardingPayoutDeps = {
    audit: async (e) => {
      audits.push(e);
    },
    alertOnce: (key) => {
      alerts.push(key);
    },
    executePayout: async (input) => {
      payouts.push(input);
      return {
        ok: true,
        provider_id: 'tr_1',
        dry_run: false,
        raw_status: 'paid',
        settled: true,
        mode: 'stripe_test',
        ...opts.payout,
      } as StripeTransferResult;
    },
    capGate: async (sb, input) => {
      if (opts.capAllowed === false) {
        await sb
          .from('payment_authorizations')
          .update({ status: 'approved', failure_reason: 'cap:campaign' } as never)
          .eq('id', input.paymentAuthorizationId)
          .eq('status', 'executing');
        return { allowed: false, cap: 'campaign' };
      }
      return { allowed: true, artistName: 'Artist', senderName: 'Label' };
    },
    sendPromoMaterials: async (_sb, o) => {
      promos.push(o.creatorOfferId);
    },
    now: () => NOW,
  };
  return { deps, audits, alerts, payouts, promos };
}

function seedApproved(
  store: ReturnType<typeof makeStore>,
  opts: { offerStatus?: string; leg?: string | null; providerId?: string | null; paStatus?: string } = {}
): Row {
  store.seed('creator_offers', {
    id: 'offer-1',
    firm_id: FIRM,
    campaign_id: CAMPAIGN,
    campaign_influencer_id: 'ci-1',
    status: opts.offerStatus ?? 'approved',
    payout_status: 'awaiting_onboarding',
    paid_at: null,
    // Every real deal carries one (authorize-payment refuses to mint without
    // it), and execute/webhook now refuse any leg that would pay past it
    // (payment-claim.checkLegsWithinAgreed). 100 = a full leg, or 50 + 50.
    agreed_amount_usd: 100,
  });
  return store.seed('payment_authorizations', {
    id: 'pa-1',
    firm_id: FIRM,
    campaign_id: CAMPAIGN,
    creator_offer_id: 'offer-1',
    amount_usd: 100,
    status: opts.paStatus ?? 'approved',
    leg: opts.leg === undefined ? 'full' : opts.leg,
    human_approved_at: '2026-09-29T10:00:00.000Z',
    human_approved_by_user_id: 'user_approver',
    payment_provider_id: opts.providerId ?? null,
    failure_reason: null,
    executing_at: null,
  });
}

/**
 * An authorization the execute path can load end to end: the nested offer join
 * execute-payment.ts selects, plus the campaign and firm rows spend-caps reads.
 */
function seedExecutable(
  store: ReturnType<typeof makeStore>,
  opts: {
    paStatus?: string;
    failureReason?: string | null;
    providerId?: string | null;
    offerStatus?: string;
    leg?: string;
    amount?: number;
    campaignBudget?: number;
  } = {}
): Row {
  store.seed('campaigns', { id: CAMPAIGN, total_budget_usd: opts.campaignBudget ?? 10_000, artist_name: 'Artist' });
  // Firm caps 0 = disabled (migration 014's documented opt-out): their month
  // queries use PostgREST .or(), which the harness store does not model. The
  // campaign cap cannot be disabled, so it is the one the retry test drives.
  store.seed('firms', { id: FIRM, monthly_spend_cap_usd: 0, per_creator_monthly_cap_usd: 0, sender_name: 'Label' });
  const pa = seedApproved(store, {
    paStatus: opts.paStatus,
    providerId: opts.providerId,
    offerStatus: opts.offerStatus,
    leg: opts.leg,
  });
  pa.failure_reason = opts.failureReason ?? null;
  if (opts.amount != null) pa.amount_usd = opts.amount;
  store.getOffer('offer-1')!.payout_status = null;
  pa.creator_offers = {
    id: 'offer-1',
    payout_email: 'c@example.com',
    contract_text: null,
    contract_generated_at: null,
    campaign_influencer_id: 'ci-1',
    campaign_influencers: {
      influencer_id: 'inf-1',
      influencer: { contact_email: 'c@example.com', username: 'creator', stripe_connect_account_id: null },
    },
  };
  return pa;
}

/** migration 009 human_approval_required_for_execute, evaluated on every row. */
function assertCheck009(store: ReturnType<typeof makeStore>, label: string) {
  for (const r of store.all('payment_authorizations')) {
    const s = r.status as string;
    const ok =
      (['pending_human_review', 'rejected'].includes(s) && r.human_approved_at == null) ||
      (['approved', 'executing', 'completed', 'failed'].includes(s) &&
        r.human_approved_at != null &&
        r.human_approved_by_user_id != null);
    assert(ok, `${label}: row ${String(r.id)} satisfies the 009 CHECK (status=${s}, approved_at=${String(r.human_approved_at)})`);
  }
}

const AWAITING: AwaitingAuthorization = {
  id: 'pa-1',
  firm_id: FIRM,
  campaign_id: CAMPAIGN,
  amount_usd: 100,
  creator_offer_id: 'offer-1',
  leg: 'full',
  influencer_id: 'inf-1',
};

/**
 * A client whose `payment_authorizations` table predates migration 055: any
 * query that names `leg` or `executing_at` errors (as PostgREST does for an
 * unknown column) and writes nothing.
 */
function pre055(sb: SupabaseClient): SupabaseClient {
  const missing = ['leg', 'executing_at'];
  const names = (s: string) => missing.some((c) => new RegExp(`\\b${c}\\b`).test(s));
  return {
    from(table: string) {
      const q = (sb as unknown as { from: (t: string) => Record<string, unknown> }).from(table);
      if (table !== 'payment_authorizations') return q;
      let bad = false;
      const err = { data: null, error: { message: 'column does not exist', code: '42703' } };
      const proxy: Record<string, unknown> = new Proxy(q, {
        get(target, prop: string) {
          const v = target[prop];
          if (typeof v !== 'function') return v;
          return (...args: unknown[]) => {
            if (prop === 'select' && typeof args[0] === 'string' && names(args[0])) bad = true;
            if (['update', 'insert', 'upsert'].includes(prop) && args[0] && typeof args[0] === 'object') {
              if (Object.keys(args[0] as object).some((k) => missing.includes(k))) bad = true;
            }
            if (['eq', 'in', 'is', 'not', 'lte', 'lt', 'gte', 'order'].includes(prop) && missing.includes(args[0] as string)) {
              bad = true;
            }
            if (bad && (prop === 'single' || prop === 'maybeSingle')) return Promise.resolve(err);
            if (bad && prop === 'then') {
              return Promise.resolve(err).then(args[0] as never, args[1] as never);
            }
            const r = (v as (...a: unknown[]) => unknown).apply(target, args);
            return r === target ? proxy : r;
          };
        },
      }) as Record<string, unknown>;
      return proxy;
    },
  } as unknown as SupabaseClient;
}

/**
 * PostgREST's `.single()` / `.maybeSingle()` ERROR when more than one row
 * matches (PGRST116). The harness store returns the first row instead, which
 * would hide exactly the multi-leg bug under test — so wrap it.
 */
function strictSingle(sb: SupabaseClient): SupabaseClient {
  return {
    from(table: string) {
      const q = (sb as unknown as { from: (t: string) => Record<string, unknown> }).from(table);
      const proxy: Record<string, unknown> = new Proxy(q, {
        get(target, prop: string) {
          const v = target[prop];
          if (typeof v !== 'function') return v;
          if (prop === 'single' || prop === 'maybeSingle') {
            return () =>
              (target as unknown as PromiseLike<{ data: Row[]; error: unknown }>).then((r) => {
                const rows = r.data ?? [];
                if (rows.length > 1) {
                  return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
                }
                if (rows.length === 0 && prop === 'single') return { data: null, error: { message: 'no rows', code: 'PGRST116' } };
                return { data: rows[0] ?? null, error: null };
              });
          }
          return (...args: unknown[]) => {
            const r = (v as (...a: unknown[]) => unknown).apply(target, args);
            return r === target ? proxy : r;
          };
        },
      }) as Record<string, unknown>;
      return proxy;
    },
  } as unknown as SupabaseClient;
}

async function main() {
  // ══ Defect 1 — the onboarding webhook re-reads the deal before paying ══════
  console.log('— defect 1: account.updated re-checks the offer —');
  for (const status of ['rejected', 'undelivered', 'failed', 'paid']) {
    const store = makeStore();
    seedApproved(store, { offerStatus: status });
    const f = makeDeps();
    const out = await payOnboardedAuthorization(store.sb, AWAITING, ACCT, f.deps);
    const pa = store.all('payment_authorizations')[0];
    assert(f.payouts.length === 0, `offer '${status}': NO transfer attempted (got ${f.payouts.length})`);
    assert(out.outcome === 'offer_not_payable', `offer '${status}': outcome offer_not_payable (got ${out.outcome})`);
    assert(pa.status === 'failed', `offer '${status}': authorization parked in 'failed', not left claimable (got ${String(pa.status)})`);
    assert(pa.failure_reason === OFFER_NOT_PAYABLE_REASON, `offer '${status}': failure_reason ${OFFER_NOT_PAYABLE_REASON}`);
    assert(
      f.audits.some((a) => a.action === 'payment.offer_not_payable' && a.metadata?.offer_status === status),
      `offer '${status}': audited payment.offer_not_payable with the offer status`
    );
    assert(f.promos.length === 0, `offer '${status}': no promo materials sent`);
  }
  {
    const store = makeStore();
    seedApproved(store, { offerStatus: 'approved' });
    const f = makeDeps();
    const out = await payOnboardedAuthorization(store.sb, AWAITING, ACCT, f.deps);
    assert(out.outcome === 'paid', `payable offer still pays (got ${out.outcome})`);
    assert(f.payouts.length === 1, 'payable offer: exactly one transfer');
    assert(store.all('payment_authorizations')[0].status === 'completed', 'payable offer: authorization completed');
  }
  // Pure predicate: allowlist, per leg.
  assert(isOfferPayable('approved', 'full') && isOfferPayable('human_approval_required', 'deposit'), 'approved / h_a_r are payable');
  assert(isOfferPayable('posted', 'balance'), "balance leg payable from 'posted'");
  assert(!isOfferPayable('deposit_paid', 'deposit'), 'an already-paid deposit is NOT payable again');
  assert(!isOfferPayable('posted', 'full'), "'posted' is not payable for a full leg");
  assert(!isOfferPayable('some_future_status', 'full'), 'unknown statuses refuse (allowlist)');
  assert(!isOfferPayable(null, 'full'), 'missing offer refuses');
  {
    const store = makeStore();
    const v = await checkOfferPayable(store.sb, 'no-such-offer', 'full');
    assert(!v.ok, 'unreadable/missing offer fails closed');
  }
  // The execute path (approve auto-execute + manual Execute) enforces the same
  // check — a manual Execute can come days after the approval.
  {
    const store = makeStore();
    const pa = seedApproved(store, { offerStatus: 'rejected' });
    pa.creator_offers = {
      id: 'offer-1',
      payout_email: 'c@example.com',
      contract_text: null,
      contract_generated_at: null,
      campaign_influencer_id: 'ci-1',
      campaign_influencers: {
        influencer_id: 'inf-1',
        influencer: { contact_email: 'c@example.com', username: 'creator', stripe_connect_account_id: null },
      },
    };
    const out = await executeAuthorizedPayment(store.sb, 'pa-1', { expectedFirmId: FIRM });
    assert(out.httpStatus === 409 && out.body.error === 'offer_not_payable', `execute refuses a cancelled deal (got ${out.httpStatus} ${JSON.stringify(out.body)})`);
    assert(pa.status === 'failed' && pa.failure_reason === OFFER_NOT_PAYABLE_REASON, 'execute: row parked failed/offer_not_payable, not left executing');
  }

  // ══ Defect 2 — an approved, not-yet-started payment can be revoked ═════════
  console.log('— defect 2: revoke an approved payment before it moves —');
  {
    const store = makeStore();
    const pa = seedApproved(store);
    const audits: AuditCall[] = [];
    const out = await rejectPaymentAuthorization(
      store.sb,
      { id: 'pa-1', callerFirmId: FIRM, actorUserId: 'user_revoker', reason: 'creator went silent' },
      { audit: async (e: AuditCall) => void audits.push(e) }
    );
    assert(out.httpStatus === 200, `approved + no transfer → revocable (got ${out.httpStatus} ${JSON.stringify(out.body)})`);
    assert(pa.status === 'rejected', `row is 'rejected' (got ${String(pa.status)})`);
    // migration 009 human_approval_required_for_execute: 'rejected' demands
    // human_approved_at IS NULL — a revoke that kept it would be refused by
    // the real database.
    assert(pa.human_approved_at === null && pa.human_approved_by_user_id === null, "approval stamp cleared (009 CHECK: 'rejected' requires it NULL)");
    assert(store.getOffer('offer-1')?.status === 'rejected', 'deal closed');
    const a = audits.find((x) => x.action === 'payment.revoked');
    assert(!!a, 'audited payment.revoked');
    const prior = a?.metadata?.revoked_approval as Record<string, unknown> | undefined;
    assert(
      prior?.human_approved_by_user_id === 'user_approver' && prior?.human_approved_at === '2026-09-29T10:00:00.000Z',
      'the revoked approval (who + when) is preserved in the append-only audit row'
    );
    assert(a?.metadata?.revoked_by_user_id === 'user_revoker', 'audit names who revoked');
    // And the revoked row can no longer be paid by the onboarding webhook.
    const f = makeDeps();
    const later = await payOnboardedAuthorization(store.sb, AWAITING, ACCT, f.deps);
    assert(later.outcome === 'not_claimed' && f.payouts.length === 0, 'revoked row: a later account.updated does NOT pay it');
  }
  {
    const store = makeStore();
    const pa = seedApproved(store, { providerId: 'tr_already' });
    const out = await rejectPaymentAuthorization(store.sb, { id: 'pa-1', callerFirmId: FIRM, actorUserId: 'u' }, { audit: async () => {} });
    assert(out.httpStatus === 409 && out.body.error === 'payout_already_started', `approved WITH a transfer id → 409 payout_already_started (got ${out.httpStatus} ${JSON.stringify(out.body)})`);
    assert(pa.status === 'approved', 'row untouched');
  }
  for (const s of ['executing', 'completed']) {
    const store = makeStore();
    const pa = seedApproved(store, { paStatus: s });
    const out = await rejectPaymentAuthorization(store.sb, { id: 'pa-1', callerFirmId: FIRM, actorUserId: 'u' }, { audit: async () => {} });
    assert(out.httpStatus === 409, `'${s}' → 409 (got ${out.httpStatus})`);
    assert(pa.status === s, `'${s}' row untouched`);
  }
  {
    // Firm scope identical to approve: cross-firm and blank-firm both refuse.
    for (const caller of ['firm-other', '']) {
      const store = makeStore();
      const pa = seedApproved(store);
      const out = await rejectPaymentAuthorization(store.sb, { id: 'pa-1', callerFirmId: caller, actorUserId: 'u' }, { audit: async () => {} });
      assert(out.httpStatus === 403 || out.httpStatus === 404, `caller firm '${caller}' refused (got ${out.httpStatus})`);
      assert(pa.status === 'approved', `caller firm '${caller}': row untouched`);
    }
  }
  {
    // The pre-existing reject path still works.
    const store = makeStore();
    const pa = seedApproved(store, { paStatus: 'pending_human_review' });
    pa.human_approved_at = null;
    pa.human_approved_by_user_id = null;
    const audits: AuditCall[] = [];
    const out = await rejectPaymentAuthorization(store.sb, { id: 'pa-1', callerFirmId: FIRM, actorUserId: 'u', reason: 'too much' }, { audit: async (e: AuditCall) => void audits.push(e) });
    assert(out.httpStatus === 200 && pa.status === 'rejected', 'pending_human_review still rejects');
    assert(pa.failure_reason === 'too much', 'reviewer reason stored');
    assert(audits.some((a) => a.action === 'payment.rejected'), 'audited payment.rejected');
  }
  {
    const route = read('app/api/payments/[id]/reject/route.ts');
    assert(route.includes('rejectPaymentAuthorization'), 'reject route delegates to rejectPaymentAuthorization');
    assert(route.includes('requireSession') && route.includes("tieredLimit(req, 'auth')"), 'reject route keeps approve-route auth + rate limit');
    const deal = read('app/campaigns/[id]/deals/DealRow.tsx');
    assert(/Stop payment/.test(deal) && deal.includes("'revoke'"), 'DealRow exposes a Stop payment action for approved rows');
    const inbox = read('app/approvals/ApprovalActions.tsx');
    assert(/awaiting_onboarding/.test(inbox) && /Stop this payment/.test(inbox), 'ApprovalActions offers Stop this payment while awaiting onboarding');
  }

  // ══ Defect 3 — one idempotency key for both money paths ════════════════════
  console.log('— defect 3: shared idempotency key —');
  assert(payoutIdempotencyKey({ id: 'pa-1', leg: 'full' }) === 'pa-1.full', 'full leg key');
  assert(payoutIdempotencyKey({ id: 'pa-1', leg: null }) === 'pa-1.full', 'pre-055 (no leg) row keys as full — identical before and after the migration');
  assert(payoutIdempotencyKey({ id: 'pa-1', leg: 'balance' }) === 'pa-1.balance', 'balance leg key');
  {
    const store = makeStore();
    seedApproved(store, { leg: 'deposit' });
    const f = makeDeps();
    await payOnboardedAuthorization(store.sb, { ...AWAITING, leg: 'deposit' }, ACCT, f.deps);
    assert(f.payouts[0]?.idempotency_key === 'pa-1.deposit', `webhook path sends the shared key (got ${f.payouts[0]?.idempotency_key})`);
  }
  {
    const exec = read('lib/execute-payment.ts');
    const hook = read('app/api/webhooks/stripe/route.ts') + read('lib/onboarding-payout.ts');
    assert(exec.includes('payoutIdempotencyKey('), 'execute-payment builds its key with payoutIdempotencyKey');
    assert(hook.includes('payoutIdempotencyKey('), 'webhook path builds its key with payoutIdempotencyKey');
    assert(!/idempotency_key:\s*r\.id\b/.test(hook), 'webhook no longer keys on the bare row id');
    assert(!/idempotency_key:\s*`/.test(exec + hook), 'no inline template-literal keys left on either path');
  }

  // ══ Defect 4 — both claims are reclaimable; pre-055 keeps working ══════════
  console.log('— defect 4: claims stamp executing_at; pre-055 degrades —');
  {
    const store = makeStore();
    const pa = seedApproved(store);
    const c = await claimForExecution(store.sb, 'pa-1', ['approved'], { now: NOW });
    assert(c.claimed && c.executingAtStamped, 'claim stamps executing_at');
    assert(pa.status === 'executing' && pa.executing_at === NOW.toISOString(), 'row is executing with the claim time');
    const again = await claimForExecution(store.sb, 'pa-1', ['approved'], { now: NOW });
    assert(!again.claimed, 'second claim loses (compare-and-set)');
  }
  {
    const store = makeStore();
    const pa = seedApproved(store);
    const c = await claimForExecution(pre055(store.sb), 'pa-1', ['approved'], { now: NOW });
    assert(c.claimed && !c.executingAtStamped, 'pre-055: still claims, without the timestamp');
    assert(pa.status === 'executing', 'pre-055: row claimed');
  }
  {
    // Lost race on pre-055 must NOT fall through to a legacy second attempt.
    const store = makeStore();
    seedApproved(store, { paStatus: 'executing' });
    const c = await claimForExecution(pre055(store.sb), 'pa-1', ['approved'], { now: NOW });
    assert(!c.claimed, 'pre-055: a row not in a claimable state is not claimed');
  }
  {
    // A webhook payout that dies mid-transfer is recovered by the reclaimer.
    const store = makeStore();
    const pa = seedApproved(store);
    const f = makeDeps();
    f.deps.executePayout = async () => {
      throw new Error('function timeout');
    };
    let threw = false;
    try {
      await payOnboardedAuthorization(store.sb, AWAITING, ACCT, f.deps);
    } catch {
      threw = true;
    }
    assert(threw && pa.status === 'executing', 'simulated death leaves the row executing');
    assert(pa.executing_at === NOW.toISOString(), `webhook claim stamped executing_at (got ${String(pa.executing_at)})`);
    const reclaimAudits: AuditCall[] = [];
    const tally = await runPaymentReclaim(store.sb, {
      now: NOW.getTime() + STALE_EXECUTING_MS + 60_000,
      audit: async (e: AuditEntry) => void reclaimAudits.push(e as AuditCall),
    });
    assert(tally.reclaimed === 1 && pa.status === 'approved', `reclaimer recovers the webhook claim (reclaimed=${tally.reclaimed}, status=${String(pa.status)})`);
    assert(reclaimAudits.some((a) => a.action === 'payment.reclaimed_stale' && a.target_id === 'pa-1'), 'reclaim is audited (feeds the anomalies lane)');
  }
  {
    // The execute path keeps working before 055: the `leg` select and the
    // executing_at claim both degrade instead of 404/409-ing every payment.
    const store = makeStore();
    const pa = seedApproved(store, { offerStatus: 'rejected', leg: null });
    delete pa.leg;
    delete pa.executing_at;
    pa.creator_offers = {
      id: 'offer-1', payout_email: 'c@example.com', contract_text: null, contract_generated_at: null,
      campaign_influencer_id: 'ci-1',
      campaign_influencers: { influencer_id: 'inf-1', influencer: { contact_email: 'c@example.com', username: 'c', stripe_connect_account_id: null } },
    };
    const out = await executeAuthorizedPayment(pre055(store.sb), 'pa-1', { expectedFirmId: FIRM });
    assert(
      out.body.error === 'offer_not_payable',
      `pre-055 execute reaches the post-claim checks (got ${out.httpStatus} ${JSON.stringify(out.body)})`
    );
  }
  {
    const hook = read('app/api/webhooks/stripe/route.ts') + read('lib/onboarding-payout.ts');
    const exec = read('lib/execute-payment.ts');
    assert(hook.includes('claimForExecution(') && exec.includes('claimForExecution('), 'both paths claim through claimForExecution');
  }

  // ══ Defect 5 — money anomalies are in the feed ═════════════════════════════
  console.log('— defect 5: money anomalies surface —');
  {
    // Transfer failure after onboarding is audited, not just written to a column.
    const store = makeStore();
    seedApproved(store);
    const f = makeDeps({ payout: { ok: false, settled: false, error: 'insufficient funds', guidance: 'Top up the platform balance.' } });
    const out = await payOnboardedAuthorization(store.sb, AWAITING, ACCT, f.deps);
    assert(out.outcome === 'transfer_failed', 'transfer failure outcome');
    assert(store.all('payment_authorizations')[0].status === 'approved', 'transfer failure reverts to approved (retryable), as before');
    assert(f.audits.some((a) => a.action === 'payment.webhook_transfer_failed'), 'transfer failure audited payment.webhook_transfer_failed');
  }
  {
    const store = makeStore();
    seedApproved(store);
    const f = makeDeps({ capAllowed: false });
    const out = await payOnboardedAuthorization(store.sb, AWAITING, ACCT, f.deps);
    assert(out.outcome === 'cap_refused' && f.payouts.length === 0, 'cap refusal: no transfer');
  }

  assert(ANOMALY_CATEGORIES.includes('payment_anomaly'), 'payment_anomaly is a category');
  assert(STUCK_EXECUTING_MS === STALE_EXECUTING_MS, 'the stuck lane and the reclaimer agree on what stranded means');
  assert(OPERATOR_ONLY_ANOMALY_CATEGORIES.includes('payment_anomaly'), 'payment_anomaly is operator-only (label sees payment_failed, operator sees the plumbing)');
  for (const act of ['payment.webhook_cap_refused', 'payment.reclaimed_stale', 'payment.webhook_transfer_failed', 'payment.cap_check_failed']) {
    assert(MONEY_ANOMALY_AUDIT_ACTIONS.includes(act), `${act} is a money-anomaly audit action`);
  }

  const base: AnomaliesInput = {
    offers: [
      { id: 'offer-1', campaign_influencer_id: 'ci-1', campaign_id: CAMPAIGN, status: 'approved', injection_flagged: false, updated_at: NOW.toISOString(), current_offer_usd: 100, contract_generated_at: NOW.toISOString() },
    ],
    payments: [],
    deliveries: [],
    audit: [],
    inbound: [],
    cis: [{ id: 'ci-1', campaign_id: CAMPAIGN, influencer_id: 'inf-1' }],
    influencers: [{ id: 'inf-1', username: 'creator' }],
    campaigns: [{ id: CAMPAIGN, artist_name: 'Artist' }],
    hasContractTemplate: true,
  };
  const at = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
  const rows = detectAnomalies(
    {
      ...base,
      moneyAudit: [
        { id: 'a1', occurred_at: at(5), action: 'payment.webhook_cap_refused', target_type: 'payment_authorization', target_id: 'pa-1', metadata: { cap: 'campaign', campaign_id: CAMPAIGN, creator_offer_id: 'offer-1' } },
        { id: 'a2', occurred_at: at(6), action: 'payment.reclaimed_stale', target_type: 'payment_authorization', target_id: 'pa-2', metadata: { campaign_id: CAMPAIGN, creator_offer_id: 'offer-1', claimed_at: at(30) } },
        { id: 'a3', occurred_at: at(7), action: 'payment.failed', target_type: 'creator_offer', target_id: 'offer-1', metadata: { stage: 'bank_payout', guidance: 'Ask the creator to update their bank.', affected_creator_offer_ids: ['offer-1'] } },
        { id: 'a4', occurred_at: at(8), action: 'payment.webhook_transfer_failed', target_type: 'payment_authorization', target_id: 'pa-3', metadata: { campaign_id: CAMPAIGN, creator_offer_id: 'offer-1', guidance: 'Top up.' } },
        // An execute-path payment.failed (target = authorization) is already in
        // the payment_failed lane via its row status — must NOT double-list.
        { id: 'a5', occurred_at: at(9), action: 'payment.failed', target_type: 'payment_authorization', target_id: 'pa-9', metadata: {} },
      ],
      executing: [
        { id: 'pa-stuck', creator_offer_id: 'offer-1', campaign_id: CAMPAIGN, amount_usd: 100, executing_at: at(20), created_at: at(600) },
        { id: 'pa-live', creator_offer_id: 'offer-1', campaign_id: CAMPAIGN, amount_usd: 100, executing_at: at(1), created_at: at(600) },
        { id: 'pa-pre055', creator_offer_id: 'offer-1', campaign_id: CAMPAIGN, amount_usd: 100, executing_at: null, created_at: at(600) },
      ],
    },
    NOW.getTime()
  );
  const money = rows.filter((r) => r.category === 'payment_anomaly');
  const refs = new Set(money.map((r) => r.ref));
  assert(refs.has('money-a1'), 'webhook cap refusal surfaces');
  assert(refs.has('money-a2'), 'reclaimed stuck payment surfaces');
  assert(refs.has('money-a3'), 'Stripe payout.failed (bank) surfaces');
  assert(refs.has('money-a4'), 'webhook transfer failure surfaces');
  assert(!refs.has('money-a5'), 'execute-path payment.failed is not double-listed');
  assert(refs.has('stuck-pa-stuck'), 'payment stuck in executing past the threshold surfaces');
  assert(!refs.has('stuck-pa-live'), 'a claim 1 minute old is in flight, not stuck');
  assert(refs.has('stuck-pa-pre055'), 'a pre-055 executing row (no claim time) surfaces — nothing can reclaim it');
  const cap = money.find((r) => r.ref === 'money-a1');
  assert(cap?.who === '@creator' && cap?.campaign_name === 'Artist', 'money anomaly attributed to creator + campaign');
  {
    const route = read('app/api/anomalies/route.ts');
    assert(route.includes('MONEY_ANOMALY_AUDIT_ACTIONS'), 'anomalies route reads the money-anomaly audit actions');
    assert(/\.eq\('status', 'executing'\)/.test(route), 'anomalies route reads executing authorizations');
    const page = read('app/anomalies/page.tsx');
    assert(page.includes('payment_anomaly'), 'anomalies page renders the payment_anomaly lane');
  }

  // ══ Follow-up A — Retry payment is live, and only for never-sent money ═════
  // execute-payment.ts refused anything but 'approved' BEFORE the claim, so the
  // claim's 'failed' branch was dead and DealRow's "Retry payment" always 409'd.
  // The click is the human action; the original approval stays on the row
  // (009 CHECK admits 'failed' and 'executing' only with human_approved_at set).
  console.log('— follow-up A: Retry payment —');
  {
    // A failed, never-transferred payment retries and settles.
    const store = makeStore();
    const pa = seedExecutable(store, { paStatus: 'failed', failureReason: 'campaign_total_budget_exceeded' });
    const out = await executeAuthorizedPayment(store.sb, 'pa-1', { expectedFirmId: FIRM });
    assert(out.httpStatus === 200 && out.body.ok === true, `failed + no transfer → retry pays (got ${out.httpStatus} ${JSON.stringify(out.body)})`);
    assert(pa.status === 'completed', `retried row completed (got ${String(pa.status)})`);
    assert(pa.human_approved_at === '2026-09-29T10:00:00.000Z' && pa.human_approved_by_user_id === 'user_approver', 'retry keeps the ORIGINAL human approval on the row');
    assert(pa.failure_reason === null, 'retry clears the stale failure_reason on success');
    assert(store.getOffer('offer-1')?.status === 'paid', 'retried full leg settles the deal');
    assertCheck009(store, 'retry success');
  }
  for (const [label, seed] of [
    ['deal closed (offer_not_payable)', { failureReason: OFFER_NOT_PAYABLE_REASON }],
    ['cancelled by operator', { failureReason: 'cancelled_by_operator' }],
    ['transfer id on file', { failureReason: 'stripe_transfer_reversed', providerId: 'tr_reversed' }],
  ] as const) {
    const store = makeStore();
    const pa = seedExecutable(store, { paStatus: 'failed', ...seed });
    const before = { ...pa };
    const out = await executeAuthorizedPayment(store.sb, 'pa-1', { expectedFirmId: FIRM });
    assert(out.httpStatus === 409 && out.body.error === 'retry_not_allowed', `${label}: retry refused 409 retry_not_allowed (got ${out.httpStatus} ${JSON.stringify(out.body)})`);
    assert(typeof out.body.guidance === 'string' && (out.body.guidance as string).length > 0, `${label}: refusal carries operator guidance`);
    assert(pa.status === 'failed' && pa.failure_reason === before.failure_reason, `${label}: row untouched`);
    assert(store.all('paper_money_ledger').length === 0, `${label}: nothing paid`);
  }
  {
    // A revoked/rejected row is not an execute candidate at all.
    const store = makeStore();
    const pa = seedExecutable(store, { paStatus: 'rejected', failureReason: 'revoked_before_payout' });
    pa.human_approved_at = null;
    pa.human_approved_by_user_id = null;
    const out = await executeAuthorizedPayment(store.sb, 'pa-1', { expectedFirmId: FIRM });
    assert(out.httpStatus === 409 && pa.status === 'rejected', `revoked row cannot be retried (got ${out.httpStatus} ${JSON.stringify(out.body)})`);
  }
  {
    // Every cap re-runs on retry.
    const store = makeStore();
    const pa = seedExecutable(store, { paStatus: 'failed', failureReason: 'transfer_failed', campaignBudget: 50 });
    const out = await executeAuthorizedPayment(store.sb, 'pa-1', { expectedFirmId: FIRM });
    assert(out.httpStatus === 409 && out.body.error === 'campaign_total_budget_exceeded', `retry re-runs the campaign cap (got ${out.httpStatus} ${JSON.stringify(out.body)})`);
    assert(pa.status === 'failed' && pa.failure_reason === 'campaign_total_budget_exceeded', 'cap breach on retry parks the row failed with the cap reason');
    assert(store.all('paper_money_ledger').length === 0, 'cap breach on retry: nothing paid');
    assertCheck009(store, 'retry cap breach');
  }
  {
    // The deal re-check re-runs on retry.
    const store = makeStore();
    const pa = seedExecutable(store, { paStatus: 'failed', failureReason: 'transfer_failed', offerStatus: 'rejected' });
    const out = await executeAuthorizedPayment(store.sb, 'pa-1', { expectedFirmId: FIRM });
    assert(out.httpStatus === 409 && out.body.error === OFFER_NOT_PAYABLE_REASON, `retry re-checks the deal (got ${out.httpStatus} ${JSON.stringify(out.body)})`);
    assert(pa.status === 'failed' && pa.failure_reason === OFFER_NOT_PAYABLE_REASON, 'retry on a closed deal parks failed/offer_not_payable');
  }
  {
    // The retry claim is compare-and-set on what the human saw: a row that
    // gained a transfer id, or changed failure_reason, after the read loses.
    const store = makeStore();
    seedApproved(store, { paStatus: 'failed', providerId: 'tr_late' });
    const c = await claimForExecution(store.sb, 'pa-1', ['failed'], { now: NOW, guard: { noTransfer: true, failureReason: null } });
    assert(!c.claimed, 'retry claim refuses a row with a transfer id');
    const store2 = makeStore();
    const pa2 = seedApproved(store2, { paStatus: 'failed' });
    pa2.failure_reason = OFFER_NOT_PAYABLE_REASON;
    const c2 = await claimForExecution(store2.sb, 'pa-1', ['failed'], { now: NOW, guard: { noTransfer: true, failureReason: 'transfer_failed' } });
    assert(!c2.claimed && pa2.status === 'failed', 'retry claim refuses a row whose failure_reason changed since the read');
    const c3 = await claimForExecution(pre055(store2.sb), 'pa-1', ['failed'], { now: NOW, guard: { noTransfer: true, failureReason: OFFER_NOT_PAYABLE_REASON } });
    assert(c3.claimed, 'retry claim guard also applies on the pre-055 fallback');
  }
  // Pure predicate.
  assert(retryRefusal({ status: 'failed', payment_provider_id: null, failure_reason: 'transfer_failed', human_approved_at: 'x' }) === null, 'provider failure without transfer is retryable');
  assert(retryRefusal({ status: 'failed', payment_provider_id: null, failure_reason: null, human_approved_at: 'x' }) === null, 'failed with no reason is retryable');
  assert(retryRefusal({ status: 'failed', payment_provider_id: null, failure_reason: 'revoked_before_payout', human_approved_at: 'x' }) !== null, 'a human stop is never retryable');
  assert(retryRefusal({ status: 'failed', payment_provider_id: null, failure_reason: 'transfer_failed', human_approved_at: null }) !== null, 'no approval stamp → not retryable');

  // ══ Follow-up B — the onboarding webhook settles per leg ═══════════════════
  // onboarding-payout.ts wrote status 'paid' + paid_at for every leg. A deposit
  // paid there never reached 'deposit_paid', stamped paid_at (the once-only
  // gate), and left the offer unpayable for its balance leg.
  console.log('— follow-up B: onboarding webhook is leg-aware —');
  {
    const store = makeStore();
    const pa = seedApproved(store, { leg: 'deposit' });
    pa.amount_usd = 50;
    const f = makeDeps();
    const dep = await payOnboardedAuthorization(store.sb, { ...AWAITING, leg: 'deposit', amount_usd: 50 }, ACCT, f.deps);
    const offer = store.getOffer('offer-1')!;
    assert(dep.outcome === 'paid', `deposit leg pays (got ${dep.outcome})`);
    assert(offer.status === 'deposit_paid', `deposit leg → offer 'deposit_paid' (got ${String(offer.status)})`);
    assert(offer.deposit_paid_usd === 50, `deposit_paid_usd recorded (got ${String(offer.deposit_paid_usd)})`);
    assert(offer.paid_at === null, 'deposit leg does NOT stamp paid_at (the balance webhook gate)');
    assert(offer.payout_status === 'paid', 'deposit leg payout_status paid');
    assert(f.promos.length === 1, 'promo materials ship with the deposit');

    // The creator posts; the balance leg is minted and approved on its own.
    offer.status = 'posted';
    store.seed('payment_authorizations', {
      id: 'pa-2', firm_id: FIRM, campaign_id: CAMPAIGN, creator_offer_id: 'offer-1', amount_usd: 50,
      status: 'approved', leg: 'balance', human_approved_at: '2026-10-05T10:00:00.000Z',
      human_approved_by_user_id: 'user_approver', payment_provider_id: null, failure_reason: null, executing_at: null,
    });
    const bal = await payOnboardedAuthorization(store.sb, { ...AWAITING, id: 'pa-2', leg: 'balance', amount_usd: 50 }, ACCT, f.deps);
    assert(bal.outcome === 'paid', `balance leg still payable after a webhook-paid deposit (got ${bal.outcome})`);
    assert(offer.status === 'balance_paid', `balance leg → offer 'balance_paid' (got ${String(offer.status)})`);
    assert(offer.balance_paid_usd === 50 && offer.deposit_paid_usd === 50, 'both leg amounts recorded');
    assert(offer.paid_at === NOW.toISOString(), 'balance leg stamps paid_at');
    assert(f.promos.length === 1, 'balance leg does not re-send promo materials');
    assert(f.payouts.map((x) => x.idempotency_key).join(',') === 'pa-1.deposit,pa-2.balance', 'one transfer per leg, leg-scoped keys');
  }
  {
    // The full leg is unchanged: 'paid' + paid_at, guarded once-only.
    const store = makeStore();
    seedApproved(store);
    const f = makeDeps();
    await payOnboardedAuthorization(store.sb, AWAITING, ACCT, f.deps);
    const offer = store.getOffer('offer-1')!;
    assert(offer.status === 'paid' && offer.paid_at === NOW.toISOString(), 'full leg → paid + paid_at');
    assert(offer.deposit_paid_usd === undefined && offer.balance_paid_usd === undefined, 'full leg writes no split columns');
  }
  {
    // Both money paths settle through one function, so they cannot drift.
    const exec = read('lib/execute-payment.ts');
    const hook = read('lib/onboarding-payout.ts');
    assert(exec.includes('offerSettlementUpdate(') && hook.includes('offerSettlementUpdate('), 'execute and webhook both settle via offerSettlementUpdate');
    const d = offerSettlementUpdate('deposit', 50, NOW.toISOString());
    assert(d.patch.status === 'deposit_paid' && !('paid_at' in d.patch) && d.sendMaterials, 'deposit patch');
    const b = offerSettlementUpdate('balance', 50, NOW.toISOString());
    assert(b.patch.status === 'balance_paid' && b.patch.paid_at === NOW.toISOString() && !b.sendMaterials, 'balance patch');
    assert(offerSettlementUpdate(null, 100, NOW.toISOString()).patch.status === 'paid', 'no leg (pre-055) settles as full');
  }

  // ══ Follow-up C — quick-offer cancel never touches money in flight ═════════
  // The cancel route flipped ANY non-completed authorization to 'failed' —
  // including an 'executing' one mid-transfer — and read the offer's
  // authorization with .maybeSingle(), which PostgREST errors on once an offer
  // has two legs (the error was ignored, so the legs were silently skipped).
  console.log('— follow-up C: quick-offer cancel —');
  const cancel = (sb: SupabaseClient, audits: AuditCall[] = []) =>
    cancelOffer(
      strictSingle(sb),
      { campaignId: CAMPAIGN, ciId: 'ci-1', callerFirmId: FIRM, actorUserId: 'user_canceller' },
      { audit: async (e: AuditCall) => void audits.push(e) }
    );
  {
    const store = makeStore();
    const pa = seedApproved(store, { paStatus: 'executing' });
    const audits: AuditCall[] = [];
    const out = await cancel(store.sb, audits);
    assert(out.httpStatus === 409 && out.body.error === 'payout_in_progress', `executing leg → 409 payout_in_progress (got ${out.httpStatus} ${JSON.stringify(out.body)})`);
    assert(pa.status === 'executing' && pa.failure_reason === null, 'in-flight leg untouched');
    assert(store.getOffer('offer-1')?.status === 'approved', 'offer untouched while money is in flight');
    assert(audits.length === 0, 'nothing audited as cancelled');
  }
  {
    // Two legs, one already paid out (the approve route mirrors 'approved'
    // back onto the offer for the balance): money has moved → too late.
    const store = makeStore();
    const dep = seedApproved(store, { paStatus: 'completed', leg: 'deposit', providerId: 'tr_dep' });
    const bal = store.seed('payment_authorizations', {
      ...dep, id: 'pa-2', leg: 'balance', status: 'approved', payment_provider_id: null,
    });
    const out = await cancel(store.sb);
    assert(out.httpStatus === 409 && out.body.error === 'too_late', `a leg already paid → 409 too_late (got ${out.httpStatus} ${JSON.stringify(out.body)})`);
    assert(dep.status === 'completed' && bal.status === 'approved', 'no leg touched');
    assert(store.getOffer('offer-1')?.status === 'approved', 'offer untouched');
  }
  {
    // Two legs, none moved: every live leg is revoked through the reject lib.
    const store = makeStore();
    const oldFull = seedApproved(store, { paStatus: 'rejected', leg: 'full' });
    oldFull.human_approved_at = null;
    oldFull.human_approved_by_user_id = null;
    oldFull.failure_reason = 'rejected by reviewer';
    const dep = store.seed('payment_authorizations', {
      ...oldFull, id: 'pa-2', leg: 'deposit', status: 'approved', failure_reason: null,
      human_approved_at: '2026-09-29T10:00:00.000Z', human_approved_by_user_id: 'user_approver',
    });
    const audits: AuditCall[] = [];
    const out = await cancel(store.sb, audits);
    assert(out.httpStatus === 200 && out.body.ok === true, `two unmoved legs → cancelled (got ${out.httpStatus} ${JSON.stringify(out.body)})`);
    assert(dep.status === 'rejected' && dep.human_approved_at === null, 'approved leg revoked (009: rejected ⇒ approval cleared)');
    assert(dep.failure_reason === 'cancelled_by_operator', 'revoked leg carries cancelled_by_operator');
    assert(oldFull.failure_reason === 'rejected by reviewer', 'already-rejected leg untouched');
    assert(store.getOffer('offer-1')?.status === 'rejected', 'offer rejected');
    assert(audits.some((a) => a.action === 'payment.revoked' && a.target_id === 'pa-2'), 'revoke audited via the reject lib');
    const c = audits.find((a) => a.action === 'offer.cancelled');
    assert(!!c && JSON.stringify(c.metadata?.revoked) === JSON.stringify(['pa-2']), 'offer.cancelled names the revoked legs');
    assertCheck009(store, 'cancel two legs');
    const f = makeDeps();
    const later = await payOnboardedAuthorization(store.sb, { ...AWAITING, id: 'pa-2', leg: 'deposit' }, ACCT, f.deps);
    assert(later.outcome === 'not_claimed' && f.payouts.length === 0, 'cancelled leg: a later account.updated does NOT pay it');
  }
  {
    // A failed, never-sent leg is revoked too, so Retry cannot resurrect it.
    const store = makeStore();
    const pa = seedExecutable(store, { paStatus: 'failed', failureReason: 'transfer_failed' });
    const audits: AuditCall[] = [];
    const out = await cancel(store.sb, audits);
    assert(out.httpStatus === 200, `failed leg → cancel ok (got ${out.httpStatus} ${JSON.stringify(out.body)})`);
    assert(pa.status === 'rejected' && pa.human_approved_at === null, 'failed leg revoked');
    const rev = audits.find((a) => a.action === 'payment.revoked');
    assert(rev?.metadata?.prior_status === 'failed' && rev?.metadata?.prior_failure_reason === 'transfer_failed', 'revoke audit keeps the prior failure');
    const retry = await executeAuthorizedPayment(store.sb, 'pa-1', { expectedFirmId: FIRM });
    assert(retry.httpStatus === 409 && store.all('paper_money_ledger').length === 0, 'Retry after cancel pays nothing');
    assertCheck009(store, 'cancel failed leg');
  }
  {
    const store = makeStore();
    const pa = seedApproved(store, { paStatus: 'pending_human_review' });
    pa.human_approved_at = null;
    pa.human_approved_by_user_id = null;
    store.getOffer('offer-1')!.status = 'human_approval_required';
    const out = await cancel(store.sb);
    assert(out.httpStatus === 200 && pa.status === 'rejected' && pa.failure_reason === 'cancelled_by_operator', 'pending leg rejected on cancel');
  }
  for (const s of ['deposit_paid', 'balance_paid', 'undelivered', 'paid', 'posted']) {
    const store = makeStore();
    seedApproved(store, { offerStatus: s, paStatus: 'completed', providerId: 'tr_x' });
    const out = await cancel(store.sb);
    assert(out.httpStatus === 409 && out.body.error === 'too_late', `offer '${s}' → too_late (got ${out.httpStatus})`);
    assert(store.getOffer('offer-1')?.status === s, `offer '${s}' untouched`);
  }
  {
    const store = makeStore();
    store.seed('creator_offers', { id: 'offer-1', firm_id: FIRM, campaign_id: CAMPAIGN, campaign_influencer_id: 'ci-1', status: 'agreed' });
    const out = await cancel(store.sb);
    assert(out.httpStatus === 200 && store.getOffer('offer-1')?.status === 'rejected', 'no authorization yet → offer rejected');
    const other = makeStore();
    seedApproved(other);
    const x = await cancelOffer(other.sb, { campaignId: CAMPAIGN, ciId: 'ci-1', callerFirmId: 'firm-other', actorUserId: 'u' }, { audit: async () => {} });
    assert(x.httpStatus === 403 && other.getOffer('offer-1')?.status === 'approved', 'cross-firm cancel refused');
  }
  {
    // A revoke of a failed row with a transfer id on file is refused.
    const store = makeStore();
    const pa = seedApproved(store, { paStatus: 'failed', providerId: 'tr_rev' });
    const out = await rejectPaymentAuthorization(store.sb, { id: 'pa-1', callerFirmId: FIRM, actorUserId: 'u' }, { audit: async () => {} });
    assert(out.httpStatus === 409 && pa.status === 'failed', `failed WITH transfer id → not revocable (got ${out.httpStatus})`);
  }
  {
    const route = read('app/api/campaigns/[id]/quick-offer/[ci_id]/cancel/route.ts');
    assert(route.includes('cancelOffer('), 'cancel route delegates to cancelOffer');
    assert(route.includes('requireSession') && route.includes("tieredLimit(req, 'auth')"), 'cancel route keeps auth + rate limit');
    assert(!/status:\s*'failed'/.test(route + read('lib/cancel-offer.ts')), 'cancel never writes a payment to failed');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:\n' + failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
