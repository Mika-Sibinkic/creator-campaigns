# Changelog

## [1.0.0] - 2026-11-11

First public version. `git log` holds the history before this.

You give it an artist and a release. It finds micro-creators, scores them, sends
outreach, negotiates the replies to a deal, writes the contract, pays the creator
once a human approves, and measures what the posts did.

- `npm run test:negotiation` needs only Node 22 and `npm ci`: no Docker, database
  or keys. It drives the negotiator through 28 scripted creator replies against an
  in-memory database and a mock model and checks 286 assertions.
- `npx tsx tools/seed-sample-analytics.mjs --verify` checks that the analytics
  engine finds the effects planted in three synthetic campaigns, and reports no
  trend for the one factor planted with no effect.
- `npm test` runs 135 suites with no secrets, network or database. CI also runs the
  typecheck, lint, build and the `--verify` check.
- Two money limits are Postgres CHECK constraints. Testing mode is on by default,
  payments default to `paper`, and a reply that looks like prompt injection goes to
  a human.

Fixed before release:

- Clerk is the only sign-in path. The old Supabase-Auth routes are gone, including
  a public endpoint that sent mail around testing mode. Only a primary or verified
  Clerk email is trusted.
- Bio links from scraped profiles are fetched over https only, and private and
  loopback addresses are refused.
- Migration 067 drops three policies that let any authenticated Supabase token read
  every creator and contact address. 068 revokes TRUNCATE on the audit log.
- `npm audit --omit=dev` went from 50 advisories (3 critical) to 10 (5 high, none
  critical).
- `/api/health` returns 503 when the database read fails. It returned 200.
- Removed a Cloudflare Worker scheduler that was never deployed, a Playwright suite
  that did not pass against this UI, unused scripts and unused dependencies.
- One `<main>` per page, a skip link, and faint text raised to WCAG AA contrast.

Known limits:

- The tests mock every paid API. Nothing here shows the integrations work with
  your keys.
- Discovery runs in one 1,532-line route handler that no test executes.
- The firm boundary is enforced in code, not by row-level security. Creator
  profiles and contact addresses are shared across firms.
- The 5 high advisories come through `apify-client`, and `npm audit` offers no fix
  inside its current version range.
- Automated replies read as a person on the label's team and do not say a model
  wrote them.
