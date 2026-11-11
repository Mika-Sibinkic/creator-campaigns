# Creator Campaigns

Creator Campaigns runs micro-creator promotion for a music release. You give it an
artist and a release. It finds creators, scores them, sends outreach, negotiates
the replies to a deal, writes the contract, pays the creator once a human approves,
and measures what the posts did.

I built it for labels and artist teams that want many small creator deals without
working each one by hand. It is a Next.js 16 app on Supabase Postgres, with Clerk
for sign-in, Resend for email, Stripe Connect or PayPal for payouts, and Apify and
Spotify for discovery. It is MIT licensed.

## Run it

The fastest check needs only Node.js 22. No Docker, no database, no keys:

```bash
git clone <your-fork-or-clone-url> creator-campaigns
cd creator-campaigns/dashboard
npm ci
npm run test:negotiation
```

It drives the negotiator through 28 scripted creator replies (lowball, over-ask,
injection, ghosting, budget exhaustion and more) against an in-memory database and
a mock model, and prints:

```
negotiation-harness: 286 passed, 0 failed
```

After `npm ci` it took 0.5 to 0.6 s across three runs (`time`, Apple M4, Node 22.22.3).
[QUICKSTART.md](./QUICKSTART.md#try-it-without-accounts) has a second check that
needs no accounts, for the analytics engine.

### Run the app

This also needs Docker (running) and the Supabase CLI. From `creator-campaigns/dashboard`:

```bash
supabase start
supabase status -o env \
  --override-name api.url=NEXT_PUBLIC_SUPABASE_URL \
  --override-name auth.service_role_key=SUPABASE_SERVICE_ROLE_KEY \
  --override-name db.url=DATABASE_URL > .env.local
echo "DEV_USER_EMAIL=you@example.com" >> .env.local
npm run dev
```

Open `http://localhost:3000`. A new workspace opens on setup. Fill in a sender name
and email and press Finish setup to reach the dashboard. In a second terminal,
`curl -s http://localhost:3000/api/health` returns status 200 and prints:

```
{"ok":true,"ts":"2026-11-11T10:43:20.654Z"}
```

I ran this block in a fresh clone (Node 22.22.3, Supabase CLI 2.98.2, Apple M4). With
the Docker images already pulled, `supabase start` took 27 s to apply 63 migrations
and the seed. A first run also downloads the images, which takes longer.

`supabase start` applies every migration and loads `supabase/seed.sql`, one
`[SAMPLE]` demo firm with testing mode on. `supabase status` writes the local URL and
keys into `.env.local`.

Locally, Clerk runs in keyless mode. You need no Clerk account: the dev server
contacts Clerk once to make a temporary app. `DEV_USER_EMAIL` signs you in as that
address. `npm run dev` listens on localhost only, so the bypass is reachable only
from this machine.

Discovery, sending, payments and a real sign-in need more keys.
[QUICKSTART.md](./QUICKSTART.md) walks through them, and
[docs/CONFIGURATION.md](./docs/CONFIGURATION.md) lists every variable.

## How a campaign runs

1. Discover: Spotify (the artist and similar artists) seeds LLM-written search
   queries, and Apify scrapers return candidate creators.
2. Qualify: deterministic checks run first, then an LLM review under a cost cap.
   Per-firm gates such as follower caps and exclusions apply.
3. Draft: each creator gets outreach in the firm's voice, on the channel the
   firm's past conversions favor.
4. Send: email goes through Resend, or into a DM queue a human dispatches. Sends
   are paced and wait out quiet hours.
5. Receive: inbound replies are normalized, deduplicated and classified by intent.
6. Negotiate: a state machine and pricing engine run on a scheduled tick. A
   deal-scope spec and spend caps bound them, and a new offer for the same package
   never drops below one already sent.
7. Contract: the firm's template is filled per deal and frozen onto the offer. An
   unfilled slot blocks the contract.
8. Pay: after a human approves, the creator is paid by Stripe Connect transfer or
   PayPal payout.
9. Measure: published posts are scraped, checked against the agreed deliverables
   and snapshotted. Soundcharts artist metrics are optional.

[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) has the full pipeline, the scheduled
routes and the boundaries the code enforces.

## Why it is built this way

This code negotiates and pays real people. These decisions follow from that.

- Two money limits are Postgres CHECK constraints (migration 009): an offer's agreed
  amount stays at or under its ceiling, and a payment cannot reach `approved` without
  an approver id and timestamp. They catch a code path that forgets the ceiling or the
  approval step. They do not catch one that raises the ceiling, writes a made-up
  approver id, or pays an amount that differs from the offer.
- Testing mode is on by default, so every outbound email goes to the firm's test
  inbox. A new install cannot email a real creator by accident.
- Payments default to `paper`, which records the payment and moves no money. An
  unknown or mismatched Stripe key falls back to it.
- A creator reply that looks like prompt injection goes to a human and never gets an
  automatic counter.
- Spend caps bound each discovery run, drafting batch and comment audit, and
  negotiation has per-deal, per-campaign and per-firm caps. A loop that misbehaves
  runs out of budget before it runs up a bill.

The rest, including the firm boundary (enforced in code, not by row-level security)
and the append-only audit log, is in
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md#hard-boundaries).

## Where to change things

All paths are under `dashboard/src/lib/`.

| To change | Edit |
|---|---|
| How creators are scored (the sub-score weights) | `scoring.ts` |
| The outreach voice (`warm`, `direct`, `playful`) | `personality.ts` |
| The search-query and outreach-draft prompts | `openai.ts` |
| First offers and how counters are priced | `pricing-engine.ts` |
| Genre premiums and genre resolution | `genre-config.ts` |
| The model vendor, or adding one | `model-provider.ts` |

## Limits

The test suites are hermetic and mock every paid API. Nothing here shows the
integrations work with your keys. Before you trust discovery, sending or payouts,
run each once against your own accounts with a small cap.

Discovery, the stage that spends Apify and model money, runs inside one route
handler that no test executes (`dashboard/src/app/api/campaigns/[id]/run/route.ts`,
1,532 lines). The `src/lib/` helpers it calls are tested. The handler itself is not,
including the per-firm daily Apify cap it checks inline.

Automated replies are written to read as a person on the label's team, and they do
not say a model wrote them (`HUMAN_COUNTER_SYSTEM` in
`dashboard/src/lib/negotiation-tick.ts`). Check the disclosure rules where you
operate before you turn on auto-negotiation.

## Tests

```bash
cd dashboard
npm test
```

It ends with `135 suites, 0 failed`. In a fresh clone after `npm ci`, `time npm test`
took 36.0 s and 33.6 s on two runs (Apple M4, Node 22.22.3). The suites run one after
another, each in its own `tsx` process.

`npm test` runs every `tests/*.test.ts` file plus the negotiation harness, the same
command CI runs. CI also runs `npx tsc --noEmit`, `npm run lint`, `npm run build` and the
sample-data check from [QUICKSTART.md](./QUICKSTART.md). There is no browser test
suite; the UI is checked by hand.

## Layout

```
creator-campaigns/
├── dashboard/                 the application (all npm work happens here)
│   ├── src/                   routes, pipeline library, components
│   ├── tests/                 hermetic test suites and fixtures
│   ├── supabase/              config, migrations, seed.sql
│   ├── tools/                 setup, scheduling, seeding and live-probe scripts
│   ├── docs/ops/              operator guides
│   └── .env.example           every variable, names only
├── docs/
│   ├── ARCHITECTURE.md
│   └── CONFIGURATION.md
├── QUICKSTART.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CHANGELOG.md
└── LICENSE
```

## License

MIT. See [LICENSE](./LICENSE).
