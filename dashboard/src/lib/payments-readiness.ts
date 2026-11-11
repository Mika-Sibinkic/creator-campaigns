// src/lib/payments-readiness.ts
//
// The Test/Live payments switch: what Settings → Payments shows an operator,
// and the server-side gate on POST /api/payments/mode.
//
// Every Stripe call goes through src/lib/stripe-isolated.ts (read-only GETs
// with the live key); every one is injectable so the checklist is testable
// without a network. The switch to Live re-runs the whole checklist on the
// server; the client's view of it is never trusted. Switching back to Test
// needs no checklist and no confirmation: it can only make payments safer.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isPlatformOperator } from './operator';
import { appBaseUrl } from './env';
import {
  ACCOUNTS_V1_BLOCKED_PATTERN,
  ACCOUNTS_V1_DISABLED,
  ACCOUNTS_V1_SETTINGS_URL,
  V2_ACCOUNT_CREATION_BLOCKED_REASONS,
} from './stripe-errors';
import {
  combinePaymentMode,
  connectAccountsApi,
  type ConnectAccountsApi,
  configuredPaymentMode,
  liveAllowedByCeiling,
  listStripeWebhookEndpoints,
  probeStripeAccount,
  probeStripeBalance,
  probeStripeConnect,
  readPlatformPaymentSetting,
  stripeKeyStatus,
  stripeWebhookSecretStatus,
  STRIPE_KEY_PREFIXES,
  type PaymentMode,
  type StripeMode,
  type StripeKeyStatus,
  type StripeAccountSummary,
  type StripeBalanceSummary,
  type StripeCallFailure,
  type StripeWebhookEndpointSummary,
} from './stripe-isolated';

/** What the operator must type to switch to Live. */
export const SWITCH_CONFIRMATION = 'SWITCH TO LIVE';

/** Events the live webhook endpoint must deliver (webhooks/stripe/route.ts). */
export const REQUIRED_WEBHOOK_EVENTS = ['account.updated', 'transfer.reversed', 'payout.failed'] as const;

/** Audit action for every switch, both directions. */
export const MODE_SWITCH_ACTION = 'payments.mode_switch';

export type ChecklistId =
  | 'ceiling'
  | 'live_key'
  | 'account'
  | 'connect'
  | 'account_creation'
  | 'webhook_endpoint'
  | 'webhook_secret'
  | 'balance'
  | 'no_test_rows';

/** A payment that would be stranded by the switch (approved or sending in Test). */
export interface StrandedPayment {
  id: string;
  firm_id: string | null;
  campaign_id: string | null;
  creator_offer_id: string | null;
  amount_usd: number;
  status: string;
  mode: string | null;
}

export interface ChecklistItem {
  id: ChecklistId;
  label: string;
  /** Passes, or cannot be known yet (see `unknown`). Only false blocks Live. */
  ok: boolean;
  /** Cannot be checked without a write; known after the first live payout. */
  unknown?: boolean;
  /** What was found, in one line. */
  detail: string | null;
  /** One line: what to do. Null when ok. */
  fix: string | null;
  /** no_test_rows only: the payments in the way. */
  rows?: StrandedPayment[];
}

export interface PaymentsStatus {
  /** The mode money moves in right now. */
  mode: PaymentMode;
  /** The platform setting (null pre-064). */
  stripe_mode: StripeMode | null;
  /** PAYMENTS_MODE as configured. */
  ceiling: string;
  live_allowed: boolean;
  /** Migration 064 is applied (the settings row exists). */
  settings_applied: boolean;
  switched_by: string | null;
  switched_at: string | null;
  /** The Stripe account behind the live key, or the test key when there is no live key. */
  account: { mode: StripeMode; id: string; display_name: string | null } | null;
  account_error: string | null;
  /** Live balance, USD. Null without a usable live key or on a failed read. */
  balance: { available_usd: number; pending_usd: number } | null;
  /** max(platform cap, approved live total): what the balance must cover. */
  balance_needed_usd: number | null;
  checklist: ChecklistItem[];
  /** Every checklist item passes: the switch to Live is allowed. */
  ready: boolean;
  webhook_url: string;
}

export interface ReadinessDeps {
  keyStatus: (mode: StripeMode) => StripeKeyStatus;
  liveAllowed: () => boolean;
  webhookSecretStatus: (mode: StripeMode) => { count: number; all_whsec: boolean };
  probeAccount: (mode: StripeMode) => Promise<StripeAccountSummary | StripeCallFailure>;
  probeBalance: (mode: StripeMode) => Promise<StripeBalanceSummary | StripeCallFailure>;
  probeConnect: (mode: StripeMode) => Promise<{ ok: true } | (StripeCallFailure & { reason: string; guidance: string })>;
  listWebhookEndpoints: (
    mode: StripeMode
  ) => Promise<{ ok: true; endpoints: StripeWebhookEndpointSummary[] } | StripeCallFailure>;
  webhookUrl: () => string;
  /** Which Accounts API creates creator accounts in a mode. Default: env
   *  (connectAccountsApi). */
  accountsApi?: (mode: StripeMode) => ConnectAccountsApi;
}

export function defaultReadinessDeps(): ReadinessDeps {
  return {
    keyStatus: stripeKeyStatus,
    liveAllowed: liveAllowedByCeiling,
    webhookSecretStatus: stripeWebhookSecretStatus,
    probeAccount: probeStripeAccount,
    probeBalance: probeStripeBalance,
    probeConnect: probeStripeConnect,
    listWebhookEndpoints: listStripeWebhookEndpoints,
    accountsApi: connectAccountsApi,
    webhookUrl: () => `${appBaseUrl()}/api/webhooks/stripe`,
  };
}

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const normUrl = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();

/** Rows a switch to Live would strand, plus the total already approved in Live. */
async function inFlightPayments(
  sb: SupabaseClient,
  settingsApplied: boolean
): Promise<{ ok: true; stranded: StrandedPayment[]; approvedLiveUsd: number } | { ok: false; error: string }> {
  const cols = 'id, firm_id, campaign_id, creator_offer_id, amount_usd, status, payment_mode';
  const { data, error } = await sb
    .from('payment_authorizations')
    .select(settingsApplied ? `${cols}, approved_mode` : cols)
    .in('status', ['approved', 'executing'])
    .limit(1000);
  if (error) return { ok: false, error: error.message };
  const rows = (data ?? []) as unknown as {
    id: string;
    firm_id: string | null;
    campaign_id: string | null;
    creator_offer_id: string | null;
    amount_usd: number | string | null;
    status: string;
    payment_mode?: string | null;
    approved_mode?: string | null;
  }[];
  const stranded: StrandedPayment[] = [];
  let liveCents = 0;
  for (const r of rows) {
    // An approved row pays in the mode it was approved in; a sending row was
    // stamped with the mode of its claim.
    const mode = r.status === 'executing' ? (r.payment_mode ?? r.approved_mode ?? null) : (r.approved_mode ?? null);
    const amount = Number(r.amount_usd ?? 0);
    if (mode === 'stripe_live') {
      liveCents += Number.isFinite(amount) ? Math.round(amount * 100) : 0;
      continue;
    }
    stranded.push({
      id: r.id,
      firm_id: r.firm_id,
      campaign_id: r.campaign_id,
      creator_offer_id: r.creator_offer_id,
      amount_usd: Number.isFinite(amount) ? amount : 0,
      status: r.status,
      mode,
    });
  }
  return { ok: true, stranded, approvedLiveUsd: liveCents / 100 };
}

/** The platform cap: the largest firm monthly spend cap, i.e. the most one
 *  label can pay out in a month. 0 disables a firm's cap and contributes 0. */
async function platformCapUsd(sb: SupabaseClient): Promise<{ ok: true; usd: number } | { ok: false; error: string }> {
  const { data, error } = await sb.from('firms').select('id, monthly_spend_cap_usd');
  if (error) return { ok: false, error: error.message };
  let max = 0;
  for (const f of (data ?? []) as { monthly_spend_cap_usd?: number | string | null }[]) {
    const n = Number(f.monthly_spend_cap_usd ?? 0);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return { ok: true, usd: max };
}

/**
 * Can this platform create connected accounts? Stripe has no read-only probe
 * for it: the only test is POST /v1/accounts, which creates an account, and a
 * status page must never write to Stripe. So the answer comes from evidence:
 *   - a creator already holds a Live connected account → allowed;
 *   - the newest Accounts-v1 refusal on record was in Live → blocked;
 *   - otherwise unknown until the first live payout (with the newest refusal,
 *     from any mode, surfaced so the operator can fix the account first).
 */
async function accountCreationEvidence(
  sb: SupabaseClient,
  settingsApplied: boolean,
  api: ConnectAccountsApi = 'v1'
): Promise<{ state: 'allowed' | 'blocked' | 'unknown'; lastError: { at: string; mode: string | null; message: string } | null }> {
  if (settingsApplied) {
    const { data } = await sb
      .from('influencers')
      .select('id')
      .eq('stripe_connect_account_mode', 'stripe_live')
      .not('stripe_connect_account_id', 'is', null)
      .limit(1);
    if (Array.isArray(data) && data.length > 0) return { state: 'allowed', lastError: null };
  }
  const { data: audits } = await sb
    .from('audit_log')
    .select('action, metadata, occurred_at')
    .in('action', ['payment.failed', 'payment.webhook_transfer_failed', 'payment.approved_payout_failed'])
    .order('occurred_at', { ascending: false })
    .limit(200);
  for (const a of (audits ?? []) as { metadata?: Record<string, unknown> | null; occurred_at: string }[]) {
    const m = a.metadata ?? {};
    if (api === 'v2') {
      // Accounts v2 creates through /v2/core/accounts: a recorded Accounts-v1
      // refusal says nothing about it. Only a v2 platform-setup refusal counts.
      const reason = typeof m.reason === 'string' ? m.reason : '';
      if ((V2_ACCOUNT_CREATION_BLOCKED_REASONS as readonly string[]).includes(reason)) {
        const mode = typeof m.payment_mode === 'string' ? m.payment_mode : null;
        return {
          state: mode === 'stripe_live' ? 'blocked' : 'unknown',
          lastError: {
            at: a.occurred_at,
            mode,
            message: typeof m.guidance === 'string' ? m.guidance : typeof m.error === 'string' ? m.error : reason,
          },
        };
      }
      continue;
    }
    const text = [m.reason, m.error, m.raw_error].filter((v) => typeof v === 'string').join(' ');
    if (m.reason === ACCOUNTS_V1_DISABLED.reason || ACCOUNTS_V1_BLOCKED_PATTERN.test(text)) {
      const mode = typeof m.payment_mode === 'string' ? m.payment_mode : null;
      return {
        state: mode === 'stripe_live' ? 'blocked' : 'unknown',
        lastError: { at: a.occurred_at, mode, message: typeof m.error === 'string' ? m.error : ACCOUNTS_V1_DISABLED.guidance },
      };
    }
  }
  return { state: 'unknown', lastError: null };
}

function item(id: ChecklistId, label: string, ok: boolean, detail: string | null, fix: string | null): ChecklistItem {
  return { id, label, ok, detail, fix: ok ? null : fix };
}

/**
 * The full status: current mode, the live account and balance, and the
 * readiness checklist. Read-only: GETs against Stripe and the database.
 */
export async function readPaymentsStatus(
  sb: SupabaseClient,
  deps: ReadinessDeps = defaultReadinessDeps()
): Promise<PaymentsStatus> {
  const setting = await readPlatformPaymentSetting(sb);
  const active = combinePaymentMode(setting);
  const settingsApplied = setting.state !== 'absent';
  const liveKey = deps.keyStatus('stripe_live');
  const testKey = deps.keyStatus('stripe_test');
  const webhookUrl = deps.webhookUrl();
  const haveLive = liveKey.usable;
  const accountMode: StripeMode | null = haveLive ? 'stripe_live' : testKey.usable ? 'stripe_test' : null;
  const liveAccountsApi = (deps.accountsApi ?? connectAccountsApi)('stripe_live');

  const [account, balance, connect, endpoints, inFlight, cap, creation] = await Promise.all([
    accountMode ? deps.probeAccount(accountMode) : Promise.resolve(null),
    haveLive ? deps.probeBalance('stripe_live') : Promise.resolve(null),
    haveLive ? deps.probeConnect('stripe_live') : Promise.resolve(null),
    haveLive ? deps.listWebhookEndpoints('stripe_live') : Promise.resolve(null),
    inFlightPayments(sb, settingsApplied),
    platformCapUsd(sb),
    accountCreationEvidence(sb, settingsApplied, liveAccountsApi),
  ]);

  const needsLiveKey = 'Needs a usable live key first.';
  const checklist: ChecklistItem[] = [];

  const liveAllowed = deps.liveAllowed();
  checklist.push(
    item(
      'ceiling',
      'PAYMENTS_MODE allows Live',
      liveAllowed,
      `PAYMENTS_MODE is ${active.ceiling}.`,
      'Set PAYMENTS_MODE=stripe_live in Vercel and redeploy. Payments stay in Test until you switch here.'
    )
  );

  const prefixes = STRIPE_KEY_PREFIXES.stripe_live.join(' or ');
  checklist.push(
    item(
      'live_key',
      'Live API key',
      haveLive,
      haveLive
        ? `${liveKey.kind === 'restricted' ? 'Restricted' : 'Secret'} live key set${liveKey.source === 'legacy' ? ' (legacy STRIPE_SECRET_KEY)' : ''}.`
        : liveKey.present
          ? `The live key does not start with ${prefixes}.`
          : 'No live key is set.',
      liveKey.present
        ? `Replace STRIPE_SECRET_KEY_LIVE with a key starting ${prefixes}.`
        : "Add the label's restricted live key as STRIPE_SECRET_KEY_LIVE in Vercel."
    )
  );

  const liveAccount = haveLive && account && account.ok ? account : null;
  checklist.push(
    item(
      'account',
      'Live Stripe account reachable',
      !!liveAccount,
      liveAccount
        ? `${liveAccount.display_name ?? 'Unnamed account'} (${liveAccount.id}).`
        : haveLive && account && !account.ok
          ? `Stripe refused the live key: ${account.error}.`
          : needsLiveKey,
      haveLive ? 'Check the live key is active and allowed to read the account.' : needsLiveKey
    )
  );

  checklist.push(
    item(
      'connect',
      'Stripe Connect enabled',
      !!connect && connect.ok,
      connect ? (connect.ok ? 'Connect is enabled on the live account.' : `Stripe answered: ${connect.error}.`) : needsLiveKey,
      !connect
        ? needsLiveKey
        : !connect.ok && connect.reason === 'stripe_connect_not_enabled'
          ? 'Enable Connect in the Stripe Dashboard (Connect, Get started), then reload.'
          : 'Give the live key Connect read access (Accounts), then reload.'
    )
  );

  if (liveAccountsApi === 'v2') {
    // Accounts v2: creator accounts are created through /v2/core/accounts, so
    // the "Accounts v1 support" API-policy toggle is not needed. Still no
    // read-only probe for creation; only a v2 platform-setup refusal recorded
    // in Live blocks, and one recorded in Test is surfaced.
    const last = creation.lastError;
    const v2Line = 'Creator payout accounts use Stripe Accounts v2; the Accounts v1 API-policy toggle is not needed.';
    const it = item(
      'account_creation',
      'Connected-account creation allowed',
      creation.state !== 'blocked',
      creation.state === 'allowed'
        ? `A creator already holds a live connected account. ${v2Line}`
        : creation.state === 'blocked'
          ? `Last refusal ${last?.at.slice(0, 10) ?? ''} in Live: ${last?.message ?? 'Stripe refused to create a connected account.'}`
          : last
            ? `${v2Line} Last refusal ${last.at.slice(0, 10)}${last.mode === 'stripe_test' ? ' in Test' : ''}: ${last.message}`
            : v2Line,
      last?.message ?? 'Fix the platform setup Stripe named, then retry the payout.'
    );
    if (creation.state === 'unknown' && last) {
      it.unknown = true;
      it.fix = last.message;
    }
    checklist.push(it);
  } else {
    // No read-only probe exists (see accountCreationEvidence): unknown does not
    // block the switch; a refusal recorded in Live does.
    const fixV1 = `Turn on Accounts v1 support in Stripe (Settings → Developers → API policies), or set STRIPE_ACCOUNTS_API=v2: ${ACCOUNTS_V1_SETTINGS_URL}`;
    const last = creation.lastError;
    const lastLine = last
      ? `Last refusal ${last.at.slice(0, 10)}${last.mode ? ` in ${last.mode === 'stripe_live' ? 'Live' : last.mode === 'stripe_test' ? 'Test' : last.mode}` : ''}: Stripe blocked creating a connected account (Accounts v1 is off).`
      : null;
    const it = item(
      'account_creation',
      'Connected-account creation allowed',
      creation.state !== 'blocked',
      creation.state === 'allowed'
        ? 'A creator already holds a live connected account.'
        : creation.state === 'blocked'
          ? lastLine
          : `Unknown until the first live payout${lastLine ? `. ${lastLine}` : '.'}`,
      fixV1
    );
    if (creation.state === 'unknown') {
      it.unknown = true;
      if (last) it.fix = fixV1;
    }
    checklist.push(it);
  }

  {
    let ok = false;
    let detail: string = needsLiveKey;
    let fix: string = needsLiveKey;
    if (endpoints && !endpoints.ok) {
      detail = `Could not list webhook endpoints: ${endpoints.error}.`;
      fix = 'Give the live key Webhook Endpoints read access, then reload.';
    } else if (endpoints && endpoints.ok) {
      const ours = endpoints.endpoints.filter((e) => normUrl(e.url) === normUrl(webhookUrl));
      const enabled = ours.find((e) => e.status === 'enabled');
      if (ours.length === 0) {
        detail = `No live endpoint for ${webhookUrl}.`;
        fix = `In Stripe (Developers, Webhooks), add a live endpoint for ${webhookUrl} listening to connected accounts with ${REQUIRED_WEBHOOK_EVENTS.join(', ')}.`;
      } else if (!enabled) {
        detail = `The live endpoint for ${webhookUrl} is disabled.`;
        fix = 'Enable the live webhook endpoint in Stripe (Developers, Webhooks).';
      } else {
        const events = enabled.enabled_events;
        const missing = events.includes('*') ? [] : REQUIRED_WEBHOOK_EVENTS.filter((e) => !events.includes(e));
        ok = missing.length === 0;
        detail = ok ? `Enabled for ${REQUIRED_WEBHOOK_EVENTS.join(', ')}.` : `Missing ${missing.join(', ')}.`;
        fix = `Add ${missing.join(', ')} to the live webhook endpoint in Stripe.`;
      }
    }
    checklist.push(item('webhook_endpoint', 'Live webhook endpoint', ok, detail, fix));
  }

  {
    const s = deps.webhookSecretStatus('stripe_live');
    const ok = s.count > 0 && s.all_whsec;
    checklist.push(
      item(
        'webhook_secret',
        'Live webhook signing secret',
        ok,
        s.count === 0 ? 'No live signing secret is set.' : ok ? `${s.count} live signing secret${s.count === 1 ? '' : 's'} set.` : 'A live signing secret does not start with whsec_.',
        "Set STRIPE_WEBHOOK_SECRETS_LIVE to the live endpoint's whsec_ signing secret in Vercel."
      )
    );
  }

  let balanceNeeded: number | null = null;
  const liveBalance = balance && balance.ok ? balance : null;
  {
    let ok = false;
    let detail: string = needsLiveKey;
    let fix: string = needsLiveKey;
    if (!inFlight.ok || !cap.ok) {
      detail = `Could not read what the balance must cover: ${!inFlight.ok ? inFlight.error : (cap as { error: string }).error}.`;
      fix = 'Reload in a moment.';
    } else {
      balanceNeeded = Math.max(cap.usd, inFlight.approvedLiveUsd);
      if (balance && !balance.ok) {
        detail = `Could not read the live balance: ${balance.error}.`;
        fix = 'Give the live key Balance read access, then reload.';
      } else if (liveBalance) {
        ok = liveBalance.available_usd >= balanceNeeded;
        detail = `${usd(liveBalance.available_usd)} available, ${usd(balanceNeeded)} needed (the larger of the monthly cap and payments approved in Live).`;
        fix = `Add ${usd(Math.max(0, balanceNeeded - liveBalance.available_usd))} to the platform balance in Stripe (Balance, Add funds). Bank top-ups take about 5 business days.`;
      }
    }
    checklist.push(item('balance', 'Available balance covers payouts', ok, detail, fix));
  }

  {
    const stranded = inFlight.ok ? inFlight.stranded : [];
    const ok = inFlight.ok && stranded.length === 0;
    const total = stranded.reduce((s, r) => s + r.amount_usd, 0);
    const it = item(
      'no_test_rows',
      'No Test payments in flight',
      ok,
      !inFlight.ok
        ? `Could not read payments: ${inFlight.error}.`
        : ok
          ? 'Nothing is approved or sending in Test.'
          : `${stranded.length} payment${stranded.length === 1 ? '' : 's'} (${usd(total)}) approved or sending outside Live.`,
      inFlight.ok
        ? 'Pay, reject or finish these first. A Test approval cannot pay in Live.'
        : 'Reload in a moment.'
    );
    if (!ok && inFlight.ok) it.rows = stranded;
    checklist.push(it);
  }

  return {
    mode: active.mode,
    stripe_mode: setting.stripe_mode,
    ceiling: active.ceiling,
    live_allowed: liveAllowed,
    settings_applied: settingsApplied,
    switched_by: setting.switched_by,
    switched_at: setting.switched_at,
    account: accountMode && account && account.ok ? { mode: accountMode, id: account.id, display_name: account.display_name } : null,
    account_error: account && !account.ok ? account.error : null,
    balance: liveBalance ? { available_usd: liveBalance.available_usd, pending_usd: liveBalance.pending_usd } : null,
    balance_needed_usd: balanceNeeded,
    checklist,
    ready: checklist.every((c) => c.ok),
    webhook_url: webhookUrl,
  };
}

export interface SwitchInput {
  session: { user: { id: string; email: string | null } };
  target: unknown;
  confirmation?: unknown;
}

export interface SwitchHooks {
  audit: (entry: { action: string; target_type: string; target_id?: string; metadata?: Record<string, unknown> }) => Promise<void>;
  now?: () => Date;
  deps?: ReadinessDeps;
}

export type SwitchOutcome = { httpStatus: number; body: Record<string, unknown> };

/**
 * POST /api/payments/mode. Operator only (403 otherwise). To Live: the typed
 * confirmation must be exactly SWITCH_CONFIRMATION, and the checklist is
 * re-run here and must be all green. To Test: always allowed. Every switch is
 * audited as payments.mode_switch.
 */
export async function switchPaymentsMode(sb: SupabaseClient, input: SwitchInput, hooks: SwitchHooks): Promise<SwitchOutcome> {
  if (!isPlatformOperator(input.session.user.email)) {
    return { httpStatus: 403, body: { error: 'operator_only' } };
  }
  const target = input.target;
  if (target !== 'stripe_test' && target !== 'stripe_live') {
    return { httpStatus: 400, body: { error: 'invalid_mode', expected: ['stripe_test', 'stripe_live'] } };
  }
  const before = await readPlatformPaymentSetting(sb);
  if (before.state === 'absent') {
    return {
      httpStatus: 409,
      body: {
        error: 'settings_not_applied',
        guidance: 'Apply migration 064 (platform_payment_settings) before switching modes.',
      },
    };
  }
  if (before.state === 'error') {
    return { httpStatus: 503, body: { error: 'settings_unreadable', guidance: 'The payments setting could not be read. Try again in a moment.' } };
  }

  let checklist: ChecklistItem[] | null = null;
  if (target === 'stripe_live') {
    if (input.confirmation !== SWITCH_CONFIRMATION) {
      return {
        httpStatus: 400,
        body: { error: 'confirmation_required', guidance: `Type ${SWITCH_CONFIRMATION} to confirm.` },
      };
    }
    const status = await readPaymentsStatus(sb, hooks.deps ?? defaultReadinessDeps());
    checklist = status.checklist;
    if (!status.ready) {
      return {
        httpStatus: 409,
        body: {
          error: 'checklist_failed',
          guidance: 'Live stays off until every checklist item passes.',
          failing: status.checklist.filter((c) => !c.ok).map((c) => c.id),
          checklist: status.checklist,
        },
      };
    }
  }

  const nowIso = (hooks.now ?? (() => new Date()))().toISOString();
  const switchedBy = input.session.user.email ?? input.session.user.id;
  const { data, error } = await sb
    .from('platform_payment_settings')
    .update({ stripe_mode: target, switched_by: switchedBy, switched_at: nowIso } as never)
    .eq('id', true)
    .select('stripe_mode')
    .maybeSingle();
  if (error || !data) {
    return { httpStatus: 500, body: { error: 'switch_failed', detail: error?.message ?? 'no settings row updated' } };
  }

  await hooks.audit({
    action: MODE_SWITCH_ACTION,
    target_type: 'platform_payment_settings',
    metadata: {
      from: before.stripe_mode,
      to: target,
      ceiling: configuredPaymentMode(),
      switched_by: switchedBy,
      ...(checklist ? { checklist: checklist.map((c) => ({ id: c.id, ok: c.ok, detail: c.detail })) } : {}),
    },
  });

  const after = combinePaymentMode(await readPlatformPaymentSetting(sb));
  return {
    httpStatus: 200,
    body: { ok: true, stripe_mode: target, mode: after.mode, switched_by: switchedBy, switched_at: nowIso },
  };
}
