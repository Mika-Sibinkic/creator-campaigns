// tests/social-outreach.test.ts
// Unit tests for the social-DM cadence governor + dispatch routing.
// Run: npx tsx tests/social-outreach.test.ts

import { evaluateSend, nextGapMs, effectiveDailyCap, CADENCE, type AccountState } from '../src/lib/social-cadence';
import { resolveSendPlan, channelToPlatform } from '../src/lib/social-dispatch';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

const NOON = new Date('2026-07-22T12:00:00Z');
function acct(over: Partial<AccountState> = {}): AccountState {
  return { platform: 'instagram', status: 'active', daily_cap: 25, sends_today: 0, sends_today_date: '2026-07-22', last_send_at: null, ...over };
}

// ── cadence: happy path ──
assert(evaluateSend(acct(), NOON, 12).allowed, 'active account, under cap, active hours, no recent send → allowed');

// ── status gate ──
assert(!evaluateSend(acct({ status: 'warming' }), NOON, 12).allowed, 'warming account blocked');
assert(evaluateSend(acct({ status: 'blocked' }), NOON, 12).reason === 'status_not_active', 'blocked → status_not_active');

// ── active hours ──
assert(evaluateSend(acct(), NOON, 3).reason === 'outside_active_hours', '3am blocked (no night activity)');
assert(evaluateSend(acct(), NOON, 22).reason === 'outside_active_hours', '10pm blocked (>= end hour)');
assert(evaluateSend(acct(), NOON, 9).allowed, '9am allowed (start hour inclusive)');

// ── daily cap (clamped to ceiling) ──
assert(evaluateSend(acct({ sends_today: 25 }), NOON, 12).reason === 'daily_cap_reached', 'at cap → blocked');
assert(effectiveDailyCap({ platform: 'instagram', daily_cap: 999 }) === CADENCE.instagram.dailyCeiling, 'daily cap clamped to IG ceiling (40)');
assert(evaluateSend(acct({ daily_cap: 999, sends_today: 40 }), NOON, 12).reason === 'daily_cap_reached', 'ceiling enforced even if operator cap huge');
// stale counter (yesterday) treated as 0
assert(evaluateSend(acct({ sends_today: 100, sends_today_date: '2026-07-21' }), NOON, 12).allowed, 'yesterday count ignored → allowed today');

// ── inter-DM gap ──
const oneMinAgo = new Date(NOON.getTime() - 60_000).toISOString();
assert(evaluateSend(acct({ last_send_at: oneMinAgo }), NOON, 12).reason === 'too_soon', '1 min since last send < 3 min min gap → too_soon');
const tenMinAgo = new Date(NOON.getTime() - 10 * 60_000).toISOString();
assert(evaluateSend(acct({ last_send_at: tenMinAgo }), NOON, 12).allowed, '10 min since last send → allowed');

// ── cooling backoff ──
const coolUntil = new Date(NOON.getTime() + 60 * 60_000).toISOString();
assert(evaluateSend(acct({ cooling_until: coolUntil }), NOON, 12).reason === 'cooling_off', 'cooling_until in future → blocked');

// ── jitter bounds ──
for (let i = 0; i < 50; i++) {
  const g = nextGapMs('instagram', () => i / 50);
  assert(g >= CADENCE.instagram.minGapMs && g <= CADENCE.instagram.maxGapMs, 'gap within 3-12 min bounds');
}

// ── dispatch routing ──
assert(channelToPlatform('instagram_dm') === 'instagram' && channelToPlatform('tiktok_dm') === 'tiktok' && channelToPlatform('email') === null, 'channel→platform map');
assert(resolveSendPlan('email').mode === 'auto_email', 'email → auto_email');
assert(resolveSendPlan('instagram_dm', {}).mode === 'human_queue', 'social + no account → human_queue');
assert(resolveSendPlan('instagram_dm', { account: acct(), sendDecision: { allowed: true, reason: 'ok' } }).mode === 'computer_use', 'social + active account + allowed → computer_use');
assert(resolveSendPlan('instagram_dm', { account: acct({ status: 'cooling' }) }).mode === 'human_queue', 'social + cooling account → human_queue');
assert(resolveSendPlan('tiktok_dm', { account: acct({ platform: 'tiktok' }), sendDecision: { allowed: false, reason: 'daily_cap_reached' } }).needs_human, 'social + cap reached → needs_human');

console.log(`social-outreach test: ${passed}/${passed + failed} pass`);
process.exit(failed === 0 ? 0 : 1);
