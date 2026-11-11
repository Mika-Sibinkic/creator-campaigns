# Security policy

## Reporting a vulnerability

Report security issues privately: open the repository's **Security** tab on GitHub
and choose **Report a vulnerability**. That is the only channel.

A useful report says which component is affected, how to reproduce the issue, and
what an attacker could do with it.

## Supported versions

Only the latest commit on `main` is supported. There is no separate release line.

## Scope

In scope:

- The Next.js app in `dashboard/`, including its API routes
- The scheduled routes (`/api/cron/*`, `/api/negotiation/*`, `/api/measurement/tick`,
  `/api/enrichment/tick`) and webhook routes (`/api/webhooks/*`)
- The database migrations in `dashboard/supabase/migrations/`, including row-level
  security policies and the append-only audit log
- The scripts in `dashboard/tools/`

Out of scope:

- Vulnerabilities in third-party services (Supabase, Clerk, Resend, Stripe, PayPal,
  Apify, model providers). Report those to the vendor.
- Problems that exist only in your own deployment's configuration, such as a leaked
  secret or a missing environment variable
- Volumetric denial of service

## Security design

The main controls, by file, so a report can say which one failed. What each
boundary does and does not guarantee is in
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md#hard-boundaries).

- Sign-in is Clerk, and access requires a `firm_members` row. First-sign-in
  bootstrap is allowlisted by `BOOTSTRAP_ALLOWED_EMAILS` / `BOOTSTRAP_ALLOWED_DOMAINS`
  and mapped to a firm explicitly. There are no built-in identities.
- The firm boundary is in code, not row-level security: `src/lib/firm-scope.ts`,
  `outreach-scope.ts` and `creator-scope.ts`, checked by `tests/*-scope.test.ts`.
  Creator profiles and contact addresses are shared across firms.
- Zod validation of request bodies. Rate limits (`src/lib/rate-limit.ts`) are an
  in-memory fixed window per instance, keyed on the first `X-Forwarded-For` address.
  That assumes a proxy in front that overwrites the header, as Vercel does.
- Same-origin enforcement on state-changing requests in `src/middleware.ts`.
  Webhooks and scheduled routes are exempt and verify their own signatures or bearer
  token.
- Webhook signature verification for Resend, Stripe and PayPal. The Resend routes
  reject every delivery while their signing secret is unset.
- `audit_log` is append-only (triggers in migration 008, TRUNCATE revoked in 068).
- Default response headers (`X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Permissions-Policy`, HSTS in production).
- Only `src/lib/stripe-isolated.ts` reads Stripe secrets and only
  `src/lib/paypal-isolated.ts` reads PayPal secrets, enforced by
  `tests/secret-isolation.test.ts`.
- Creator replies are untrusted model input (`src/lib/injection-guard.ts`).

`dashboard/tools/security-smoke.sh` runs a battery of these checks against a running
app.

## Known issues

On 2026-11-11, `npm audit --omit=dev` in `dashboard/` reported 10 advisories, all in
transitive dependencies of two production packages:

- `apify-client`: high, through its proxy chain (`proxy-agent`, `pac-proxy-agent`,
  `get-uri`, `basic-ftp`).
- `@sentry/nextjs`: moderate, through its build plugins (`@sentry/bundler-plugins`,
  `@sentry/webpack-plugin`, `glob`, `minimatch`).

Plain `npm audit` reported 22; the other 12 are in dev-only packages. Run it yourself
for the current list.

## Secrets

Secrets belong in `dashboard/.env.local` (gitignored) or your host's environment,
never in the repository. If you find a committed secret, report it through the
Security tab as above.
