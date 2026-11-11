// src/lib/social-cadence.ts
//
// Human-cadence rate governor for social-DM outreach. Encodes the survivable-volume +
// pacing spec from the 2026 low-cost research so the send worker never trips a
// platform's behavioral flags. Pure + deterministic given its inputs (the RNG is
// injectable) so it unit-tests without a clock or network.
//
// The binding constraint is COLD DMs to non-followers ("message requests"), which
// is far lower than total DM capacity. Numbers are the researched sustainable
// ceilings, not the theoretical max — we deliberately stay under.

export type SocialPlatform = 'instagram' | 'tiktok';

export interface PlatformCadence {
  dailyStart: number;   // ramp floor for a freshly-enrolled account
  dailySteady: number;  // sustainable cold-DM/day after ramp
  dailyCeiling: number; // never exceed, even fully ramped
  hourlyMax: number;
  minGapMs: number;     // randomized inter-DM gap lower bound
  maxGapMs: number;     // upper bound
  activeStartHour: number; // local hour outreach may start (no 3am activity)
  activeEndHour: number;   // local hour outreach must stop by
}

const MIN = 60_000;

// The researched human-activity window, shared by every outreach channel: no
// outbound before 9am or after 9pm in the recipient-market timezone. The DM
// cadence table below uses it, and src/lib/quiet-hours.ts applies the SAME
// window to auto-emailed counters (an email counter sent at 3am is the same
// human-tell a 3am DM is).
export const ACTIVE_START_HOUR = 9;
export const ACTIVE_END_HOUR = 21;

// Sourced from the low-cost research pass (IG cold-request cap ~20-30/day, 40
// ceiling; TikTok 30-40/day, 60 ceiling; 3-5/hr; randomized 3-12 min gaps;
// 6-8 active hours, timezone-matched).
export const CADENCE: Record<SocialPlatform, PlatformCadence> = {
  instagram: { dailyStart: 12, dailySteady: 25, dailyCeiling: 40, hourlyMax: 5, minGapMs: 3 * MIN, maxGapMs: 12 * MIN, activeStartHour: ACTIVE_START_HOUR, activeEndHour: ACTIVE_END_HOUR },
  tiktok:    { dailyStart: 18, dailySteady: 35, dailyCeiling: 60, hourlyMax: 6, minGapMs: 3 * MIN, maxGapMs: 12 * MIN, activeStartHour: ACTIVE_START_HOUR, activeEndHour: ACTIVE_END_HOUR },
};

export const SOFT_BLOCK_BACKOFF_MS = 48 * 60 * MIN; // stop an account 48h after any block/challenge

export type AccountStatus = 'warming' | 'active' | 'cooling' | 'blocked';

export interface AccountState {
  platform: SocialPlatform;
  status: AccountStatus;
  daily_cap: number;        // operator/ramp override; effective cap = min(this, ceiling)
  sends_today: number;
  sends_today_date: string | null; // 'YYYY-MM-DD' the counter belongs to
  last_send_at: string | null;     // ISO
  cooling_until?: string | null;   // ISO; set when backing off a block
}

export interface SendDecision {
  allowed: boolean;
  reason:
    | 'ok'
    | 'status_not_active'
    | 'cooling_off'
    | 'daily_cap_reached'
    | 'too_soon'          // inside the randomized inter-DM gap
    | 'outside_active_hours';
  /** When another send could be eligible (ISO), when knowable — for scheduling. */
  nextEligibleAt?: string;
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Decide whether `account` may send a cold DM at `now`. `localHour` is the hour
 * (0-23) in the ACCOUNT's timezone — the caller resolves it (the worker knows the
 * account's tz); defaulting to now's UTC hour is acceptable only in tests.
 */
export function evaluateSend(account: AccountState, now: Date, localHour: number): SendDecision {
  if (account.status !== 'active') return { allowed: false, reason: 'status_not_active' };

  if (account.cooling_until) {
    const until = new Date(account.cooling_until);
    if (now < until) return { allowed: false, reason: 'cooling_off', nextEligibleAt: until.toISOString() };
  }

  const cad = CADENCE[account.platform];
  if (localHour < cad.activeStartHour || localHour >= cad.activeEndHour) {
    return { allowed: false, reason: 'outside_active_hours' };
  }

  // Effective daily cap = operator cap clamped to the researched ceiling. Counter
  // only counts if it belongs to today (else it's a stale day → treated as 0).
  const cap = Math.min(account.daily_cap, cad.dailyCeiling);
  const todaysSends = account.sends_today_date === ymd(now) ? account.sends_today : 0;
  if (todaysSends >= cap) return { allowed: false, reason: 'daily_cap_reached' };

  // Inter-DM gap: enforce at least minGapMs since the last send (the worker adds
  // the extra jitter up to maxGapMs when it schedules the next one).
  if (account.last_send_at) {
    const since = now.getTime() - new Date(account.last_send_at).getTime();
    if (since < cad.minGapMs) {
      return { allowed: false, reason: 'too_soon', nextEligibleAt: new Date(new Date(account.last_send_at).getTime() + cad.minGapMs).toISOString() };
    }
  }

  return { allowed: true, reason: 'ok' };
}

/** Randomized human inter-DM delay (3-12 min). rng injectable for tests. */
export function nextGapMs(platform: SocialPlatform, rng: () => number = Math.random): number {
  const cad = CADENCE[platform];
  return Math.round(cad.minGapMs + rng() * (cad.maxGapMs - cad.minGapMs));
}

/** The effective per-day cap for an account (operator cap clamped to the ceiling). */
export function effectiveDailyCap(account: Pick<AccountState, 'platform' | 'daily_cap'>): number {
  return Math.min(account.daily_cap, CADENCE[account.platform].dailyCeiling);
}
