# Quickstart

This runs Creator Campaigns on your machine against your own local Supabase, then
covers what changes for a deployment. Every account and database here is yours.

## Try it without accounts

You need only Node.js 22 and npm. No Docker, no database, no keys.

```bash
git clone <your-fork-or-clone-url> creator-campaigns
cd creator-campaigns/dashboard
npm ci
npx tsx tools/seed-sample-analytics.mjs --verify
```

This builds the synthetic sample campaigns in memory and checks that the
correlation engine finds the effects planted in them. One factor, the send window,
is planted with no effect, and the check expects the engine to report no trend for
it. In a fresh clone it printed this, in under a second:

```
── engine verification (pooled sample scope, n=40) ──
  follower_count        n=40  tier=high         direction=negative (ρ=-0.38)
  engagement_rate       n=40  tier=high         direction=none (ρ=-0.09)
  genre                 n=40  tier=high         leader=none
  price_usd             n=40  tier=high         direction=positive (ρ=0.48)
  perceived_generosity  n=40  tier=high         direction=none (ρ=0.21)
  price_give_pct        n=40  tier=high         direction=negative (ρ=-0.58)
  channel               n=40  tier=high         leader=email
  send_window           n=40  tier=high         leader=none
  promo_activity        n=40  tier=high         leader=none
  [SAMPLE] Ridgeline Drive: deals_measured=14, channel tier=low
  [SAMPLE] Neon Harbor: deals_measured=13, channel tier=low
  [SAMPLE] Quiet Mile: deals_measured=13, channel tier=low

  ✓ all 17 engineered-spread assertions pass through the committed engine
```

The negotiation check, `npm run test:negotiation`, is in the
[README](./README.md#run-it). Neither touches discovery or sending, which need the
paid APIs in step 7.

## 1. Prerequisites

- Node.js 22 (the version CI uses) and npm
- Docker, running (the local Supabase stack runs in containers)
- The Supabase CLI (`brew install supabase/tap/supabase`, or see the Supabase docs
  for other platforms)
- git

## 2. Get the code and install

```bash
git clone <your-fork-or-clone-url> creator-campaigns
cd creator-campaigns/dashboard
npm ci
```

All npm commands run from `dashboard/`. There is no root `package.json`.

## 3. Start a local database

```bash
supabase start
supabase status -o env \
  --override-name api.url=NEXT_PUBLIC_SUPABASE_URL \
  --override-name auth.service_role_key=SUPABASE_SERVICE_ROLE_KEY \
  --override-name db.url=DATABASE_URL > .env.local
```

`supabase start` pulls and starts the local stack. On a fresh project it applies
every migration in `supabase/migrations/` in order and then `supabase/seed.sql`,
which creates one demo firm, `[SAMPLE] Example Records`, with testing mode on and
`test-inbox@example.com` as its test inbox.

`supabase status` writes the local API URL, service-role key and database URL into
`.env.local` under the names the app reads. `.env.local` is gitignored. Never commit
it. Every other variable is in [docs/CONFIGURATION.md](./docs/CONFIGURATION.md).

## 4. Sign in locally

```bash
echo "DEV_USER_EMAIL=you@example.com" >> .env.local
```

You need no Clerk account or keys locally; [Run the app](./README.md#run-the-app) in
the README explains the keyless mode and the bypass. The bypass is off whenever
`NODE_ENV` is `production`.

The session joins the only firm in the database (the seeded demo firm). If you
create a second firm, also set `DEV_FIRM_ID` to the firm you want.

To sign in for real, remove `DEV_USER_EMAIL` and grant your address access. There
are no built-in identities, so with these unset nobody can sign in and nobody is an
operator:

```
BOOTSTRAP_ALLOWED_EMAILS=you@example.com
BOOTSTRAP_FIRM_MAP=you@example.com=00000000-0000-4000-8000-0000000000f1
OPERATOR_EMAILS=you@example.com
```

`BOOTSTRAP_FIRM_MAP` above points your address at the seeded demo firm. Use
`BOOTSTRAP_NEW_FIRM_MAP=example.com=Your Label` instead to have a new firm created on
your first sign-in. A deployment needs the keys of your own Clerk instance in
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`.

## 5. Load sample data (optional)

```bash
CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 npx tsx tools/seed-sample-analytics.mjs
```

This writes three `[SAMPLE]` campaigns of measured deals into the demo firm, so
`/analytics` has something to show. Every row is marked `synthetic`, so none of it
mixes into real analytics or the learning signal. To see it, pick a `[SAMPLE]`
campaign under "Results for" on `/analytics`. It shows under a sample-data banner.

The guard variable is needed even locally. Every `tools/` script that writes reads
whatever database `.env.local` points at, and it cannot tell your laptop from a real
deployment, so it refuses to write until you say so. To undo:

```bash
CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 npx tsx tools/seed-sample-analytics.mjs --remove
```

## 6. Run it

```bash
npm run dev
```

Open `http://localhost:3000`. A new workspace opens on setup. Fill in a sender name
and email and press Finish setup to reach the dashboard.

## 7. Run a discovery (optional, uses paid APIs)

Discovery calls external services, and some of them bill you. Add to `.env.local`:

- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` from a Spotify developer app
- `APIFY_TOKEN` from your Apify account (scraping spends Apify credit)
- a model provider: `OPENAI_API_KEY`, or `MODEL_PROVIDER=gemini` / `groq` with that
  provider's key, or `MODEL_PROVIDER=ollama` with `OLLAMA_BASE_URL` pointing at a
  local Ollama

Restart `npm run dev`, create a campaign and run discovery from its page. The
`*_USD_CAP` variables in [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) bound what
one run can spend.

The demo firm has testing mode on, so any outreach you send goes to its test inbox,
never to a creator. Sending needs `RESEND_API_KEY` and a verified sender in
`RESEND_FROM_EMAIL`. Replies need an inbound transport:
`dashboard/docs/ops/inbound-email-setup.md`.

## 8. Run the tests

```bash
npm test
npx tsc --noEmit
npm run lint
```

The test suites are hermetic and need none of the keys above. CI runs these three,
then `npm run build` and the `--verify` check from "Try it without accounts".

## 9. Stop, or reset to a clean demo

```bash
supabase stop
```

To throw away everything you did and start from the seeded demo firm again:

```bash
supabase db reset
```

This reapplies every migration and `supabase/seed.sql`. It deletes the sample data
from step 5 too.

## Deploying

1. Create a hosted Supabase project and apply each migration in order:
   ```bash
   CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/<file>
   ```
   with `DATABASE_URL` set to that project's connection string. Do not load
   `supabase/seed.sql` into a real deployment.
2. Deploy `dashboard/` to any Next.js host. Set every variable you need from
   [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) in the host's environment,
   including `NEXT_PUBLIC_APP_URL`, `CRON_SECRET` and production Clerk keys. Do not
   set `DEV_USER_EMAIL`.
3. Schedule the ticks with `tools/_pgcron-setup.mjs` (see "Where the work runs" in
   [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)).
4. Optional: inbound email (`docs/ops/inbound-email-setup.md`), Sentry
   (`docs/ops/sentry-setup.md`), and Stripe or PayPal (`dashboard/README.md`).
   Payments stay in `paper` mode until you change `PAYMENTS_MODE`.

## Making changes

Work on a branch and stage the files you changed by name (`git add <path>`), not
with `git add -A`, so local files such as `.env.local` never get swept in. See
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing required env var: <NAME>` | Set `<NAME>` in `.env.local` and restart `npm run dev`. |
| Pages load empty and the server logs `DEV BYPASS: more than one firm exists` | Set `DEV_FIRM_ID` to the firm you want. |
| `supabase start` hangs or fails | Start Docker Desktop and free disk space. |
| Sign-in succeeds but you are refused access | Your address is not in `BOOTSTRAP_ALLOWED_EMAILS` / `BOOTSTRAP_ALLOWED_DOMAINS`, or no `BOOTSTRAP_FIRM_MAP` / `BOOTSTRAP_NEW_FIRM_MAP` entry says which firm it joins. |
| Outreach never reaches a creator | Testing mode is on for the firm, which reroutes every message to the test inbox. It is a per-firm setting in Settings. |
| Scheduled routes return `401` | The scheduler's token does not match `CRON_SECRET`, or the path is missing from `src/lib/cron-paths.ts`. |
| `tools/` script refuses to run | Add `CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1` after checking `DATABASE_URL` points where you mean. |
