# Creator Campaigns: architecture

## Summary

A label, artist team or brand (a "firm" in the code) enters an artist and release
context. Creator Campaigns finds relevant micro-creators, scores them, drafts
personalized outreach, sends it, and negotiates the replies to a closed deal without
a human in the loop. Each lead moves through
`queued → contacted → responded → negotiating → deal_closed`. A closed deal gets a
contract, the creator is paid through Stripe Connect or PayPal once a human approves
the payment, and the published content is measured. Every stage is a Next.js route
handler or a scheduled tick against one Postgres database. There is no separate
orchestration service.

## The pipeline, end to end

```
 artist + release context
        │
        ▼
 1. DISCOVER         Spotify (artist + similar artists) → LLM query generation
    run/route.ts     → Apify TikTok/Instagram scrapers → normalize → score
    (SSE progress)   Runs synchronously in the route handler. Writes api_ledger.
        │
        ▼
 2. QUALIFY          Deterministic pre-checks, then LLM review under a cost cap.
                     Per-firm pool gates (follower caps, exclusions) applied at read time.
        │
        ▼
 3. DRAFT            Per-creator outreach copy against the firm's voice profile.
                     Channel chosen from learned per-firm conversion priors.
        │
        ▼
 4. SEND             Resend (email) or a human-dispatched DM queue. Paced, quiet-hours aware.
        │
        ▼
 5. RECEIVE          Inbound replies normalized into ingestInboundReply(), which dedupes
                     on (channel, external_id) and classifies intent.
        │
        ▼
 6. NEGOTIATE        State machine + pricing engine, run by a scheduled tick. Bounded by
    negotiation      a deal-scope spec the negotiator cannot trade away, a floor (a new
    tick             offer never drops below one already sent), and per-deal /
                     per-campaign / per-firm spend caps.
        │
        ▼
 7. CONTRACT         Per-firm template, filled per deal and frozen onto the offer.
                     Any unfilled slot blocks the contract instead of shipping a placeholder.
        │
        ▼
 8. PAY              Human approval gate (a DB CHECK), then a Stripe Connect transfer
                     or PayPal payout to the creator. PAYMENTS_MODE=paper moves no money.
        │
        ▼
 9. MEASURE          Scheduled tick: scrape published posts, verify them against the agreed
    measurement      deliverable spec, snapshot performance, poll artist metrics from
    tick             Soundcharts when configured. Feeds CPM and per-creator performance.
```

Stages 5 to 9 depend on an inbound reply transport. Until Resend inbound
(`dashboard/docs/ops/inbound-email-setup.md`) or the Gmail poller is configured, no
reply is ever observed and leads stay in `contacted`.

## Where the work runs

Everything is either a Next.js 16 route handler or a scheduled route:

| Route | pg_cron schedule (`tools/_pgcron-setup.mjs`) | Purpose |
|---|---|---|
| `/api/negotiation/tick` | `*/5 * * * *` | read replies, advance negotiations |
| `/api/negotiation/dispatch` | `* * * * *` | send queued replies whose `send_after` has passed |
| `/api/measurement/tick` | `17 * * * *` | measure published content |
| `/api/enrichment/tick` | `37 * * * *` | harvest creator contact addresses from scraped bios |
| `/api/cron/smoke` | Vercel cron in `dashboard/vercel.json` | database heartbeat |

A scheduler calls each route with `Authorization: Bearer $CRON_SECRET`.
`tools/_pgcron-setup.mjs` installs pg_cron + pg_net jobs in your database, with the
bearer token kept in Supabase Vault. It needs `DATABASE_URL`, `CRON_SECRET`, the
deployed https origin in `NEXT_PUBLIC_APP_URL`, and
`CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1`. Every scheduled path must also be
listed in `src/lib/cron-paths.ts`; otherwise the middleware rejects the call before
the route's own `CRON_SECRET` check runs, and
`tests/cron-scheduler-reachability.test.ts` fails.

## Hard boundaries

These are enforced by code, constraints or tests.

- One model seam. Every LLM call goes through `complete()` in
  `src/lib/model-provider.ts`, the only file under `src/` that imports a model SDK. `MODEL_PROVIDER`
  picks the provider (OpenAI, Gemini, Groq or a local Ollama) and
  `MODEL_FALLBACK_CHAIN` sets failover.
- One secret seam per payment rail. Only `src/lib/stripe-isolated.ts` reads Stripe
  secrets and only `src/lib/paypal-isolated.ts` reads PayPal secrets.
  `tests/secret-isolation.test.ts` enforces both.
- Two money limits are Postgres CHECK constraints (migration 009): the offer's
  agreed amount stays at or under `ceiling_usd`, and a payment cannot reach
  `approved` without an approver id and timestamp. They catch a code path that
  forgets the ceiling or the approval step. They do not catch one that raises the
  ceiling, writes a made-up approver id, or pays an amount that differs from the
  offer.
- Payment mode fails safe. An unknown, missing, or mismatched Stripe key resolves
  to `paper`, which records the payment and moves no money.
- Testing mode is on by default. `firms.testing_mode` defaults to `true`
  (migration 004), and while it is on every outbound email is rerouted to the
  firm's test inbox.
- The audit log is append-only. Triggers reject UPDATE and DELETE (migration 008)
  and TRUNCATE is revoked from the API roles (migration 068). The table owner can
  still truncate it.
- Creator replies are untrusted model input. `src/lib/injection-guard.ts` wraps
  each reply in a data fence and flags injection attempts. A flagged reply goes to a
  human and is never auto-countered. The negotiator model has no tools and must
  return one strictly validated JSON object.
- Null over fabrication. Analytics refuse to state a number they do not have.
  CPM is omitted when there is no verified reach, trends are refused without enough
  data points, and per-creator causal stream attribution is refused outright as
  unidentifiable. Read the doctrine comments at the top of `src/lib/stream-lift.ts`
  before adding any attribution claim.
- Synthetic data never blends with real. `[SAMPLE]` and `synthetic` rows are
  excluded from every analytic and from the learning signal. The creator list and
  dashboard routes filter them in code (`tests/synthetic-quarantine.test.ts`).

## Data

One Supabase Postgres database. Migrations live in `dashboard/supabase/migrations/`,
are numbered, and are additive; `supabase db reset` applies them in order to a local
database, followed by `dashboard/supabase/seed.sql` (one `[SAMPLE]` demo firm). Against a hosted database, apply a single
file with `tools/_apply-file.mjs`, which refuses to run without
`CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1`.

The firm boundary is in code. Route handlers use the service-role client, which
bypasses row-level security, so each user route must filter by the session's
`firm_id` itself. `src/lib/firm-scope.ts` holds the fail-closed check for money
routes, and `outreach-scope.ts` and `creator-scope.ts` cover outreach and creators.
The `tests/*-scope.test.ts` suites check those routes. Nothing checks every route.
Row-level security is on, but it only stops a client holding the anon key.
`influencers` and `creator_contacts` are deliberately shared across firms, so
creators and contact addresses discovered by one firm are visible to others. Firm scoping therefore runs through each firm's own
campaigns, not through the creator row.

## Auth

Sign-in is Clerk. A signed-in user reaches the app only through a `firm_members` row.
The first sign-in for an address creates that row only when the address is listed in
`BOOTSTRAP_ALLOWED_EMAILS` or its domain in `BOOTSTRAP_ALLOWED_DOMAINS`, and
`BOOTSTRAP_FIRM_MAP` (join an existing firm) or `BOOTSTRAP_NEW_FIRM_MAP` (provision a
new one) says which firm it lands in. An allowlisted address with no mapping is refused.
Operator-only screens require the address to be in `OPERATOR_EMAILS`. There are no
built-in identities: with these variables unset, nobody bootstraps and nobody is an
operator. In development, `DEV_USER_EMAIL` bypasses sign-in (never in production).

## Observability

- `audit_log`: append-only, metadata PII-scrubbed, request-id threaded. The forensic timeline
  at `/audit`.
- `api_ledger`: external spend and latency per call (Apify, Spotify, Soundcharts,
  model calls).
- `/anomalies`: the needs-attention surface (injection flags, failed payments, stalled
  negotiations, spec failures, missing contracts, unattributed inbound).
- Sentry: wired, a no-op until `SENTRY_DSN` is set
  (`dashboard/docs/ops/sentry-setup.md`).

## Testing

Hermetic suites in `dashboard/tests/` run with plain `tsx`, with no runner
framework, no secrets and no network. Run them with `npm test` from `dashboard/`. It
runs every `tests/*.test.ts` file plus the negotiation harness. Suite count and run time are in the
[README Tests section](../README.md#tests).
