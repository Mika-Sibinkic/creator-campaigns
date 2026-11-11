// src/lib/env.ts
export const REQUIRED = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OPENAI_API_KEY',
  'APIFY_TOKEN',
  'RESEND_API_KEY',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
] as const;

export const OPTIONAL = [
  'RESEND_FROM_EMAIL',
  'TEST_RECIPIENT_EMAIL',
] as const;

type Required = (typeof REQUIRED)[number];
type Optional = (typeof OPTIONAL)[number];

export function getEnv(key: Required): string;
export function getEnv(key: Optional, fallback: string): string;
export function getEnv(key: Required | Optional, fallback?: string): string {
  const v = process.env[key];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${key}`);
}

/**
 * A numeric env override, or `fallback` when it is unset, blank or not a
 * finite number.
 *
 * `parseFloat(process.env.X ?? '5')` looks safe and is not: `??` only catches
 * undefined, so `X=""` reaches parseFloat and yields NaN. NaN then defeats
 * every comparison that guards it (`NaN <= 0` and `NaN > 0` are both false),
 * so a spend cap read that way silently stops capping.
 */
export function envNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Public origin of the app, used to build links that leave the server (Stripe
 * return URLs, payout links, webhook URLs). Production refuses to guess one.
 */
export function appBaseUrl(): string {
  const v = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim().replace(/\/+$/, '');
  if (v) return v;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('NEXT_PUBLIC_APP_URL is required in production');
  }
  return 'http://localhost:3000';
}
