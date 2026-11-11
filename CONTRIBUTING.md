# Contributing

Bug reports, fixes and improvements are welcome. Open an issue to discuss anything
larger than a small fix before you build it. Report security problems privately as
described in [SECURITY.md](./SECURITY.md), not in an issue.

## Setup

Follow [QUICKSTART.md](./QUICKSTART.md) to get a local database and dev server. All
npm commands run from `dashboard/`.

## Before you open a pull request

```bash
cd dashboard
npx tsc --noEmit
npm run lint
npm test
```

CI runs the same three steps on every pull request.

## Tests

- Suites live in `dashboard/tests/` and run with plain `tsx`. They are hermetic: no
  secrets, no network, no database. Keep them that way. Stub `fetch` and the database
  client instead of calling real services.
- A new suite that needs a Supabase fake uses the in-memory client in
  `tests/negotiation-harness/store.ts`, like the existing suites do. Extend it when
  you need a call chain it does not support yet.
- `npm test` (and CI) runs every `tests/*.test.ts` file, each in its own `tsx`
  process. Name a new suite `<name>.test.ts` and it runs. Run one with
  `npx tsx tests/<name>.test.ts`. Live probes that touch real services go in
  `dashboard/tools/`, not `tests/`.
- Known gap: almost no test executes a route handler (`webhook-rate-buckets` calls
  two). Suites test the library code the routes call, and some read a route's source
  to check it uses the right helper.
  A bug in a route's own wiring (parsing, auth checks, the response) is not caught.
  Keep logic out of routes and in `src/lib/`, where it is tested.
- `tests/no-em-dash.test.ts` keeps em dashes out of creator-facing copy.

## Rules the code depends on

- Negotiation policy lives in `dashboard/src/lib/negotiation.ts` (offers, counters,
  ceilings) and `dashboard/src/lib/negotiation-tick.ts` (the scheduled loop). Both
  are large and heavily tested. Change policy there, with a test, not in a route.
- Model calls go through `complete()` in `dashboard/src/lib/model-provider.ts`.
  Do not import a model vendor SDK anywhere else; add a provider there instead.
- Stripe secrets are read only in `dashboard/src/lib/stripe-isolated.ts` (PayPal
  secrets only in `paypal-isolated.ts`). `tests/secret-isolation.test.ts` fails if
  another file reads them.
- Keep the two money CHECK constraints (migration 009) in the database.
  [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md#hard-boundaries) says what they
  catch and what they do not.
- Migrations in `dashboard/supabase/migrations/` are numbered and additive. Add a
  new file with the next number; never rename, renumber or edit one that exists.
  Several tests read migrations by file name. The numbering has gaps on purpose
  (numbers that were never shipped are not reused); do not fill them.
- Scripts in `dashboard/tools/` that write to a database refuse to run without
  `CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1`. Keep that guard on any new writing script.
- Testing mode (`firms.testing_mode`, on by default) reroutes every outbound
  email to the firm's test inbox. New send paths must go through the existing
  send helpers so they inherit it.
- Scheduled routes must be listed in `dashboard/src/lib/cron-paths.ts` as well as
  in the scheduler, or the middleware rejects them.
- Next.js 16 has breaking changes from earlier versions. Check the guides in
  `dashboard/node_modules/next/dist/docs/` before relying on an older API.

## Commits and pull requests

- Keep each pull request to one change, with a description of what it changes and
  how you tested it.
- Stage files by name. Do not use `git add -A`; it sweeps in local files such as
  `.env.local`.
- Never commit secrets, `.env.local`, or real personal data. Test fixtures use
  clearly synthetic names, handles and `example.com`-style addresses.

By contributing you agree that your contributions are licensed under the MIT License
in [LICENSE](./LICENSE).
