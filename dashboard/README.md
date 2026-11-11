# Creator Campaigns dashboard

The Next.js app: routes, the pipeline library, tests, migrations and tools. Setup,
configuration and architecture are documented at the repository root:
[README](../README.md), [QUICKSTART](../QUICKSTART.md),
[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md). Operator guides are in
[`docs/ops/`](./docs/ops/).

All npm commands run from this directory.

## Payments environment variables

Names only live in `.env.example`; values live in your host's environment. Only `src/lib/stripe-isolated.ts` reads the Stripe secrets (`tests/secret-isolation.test.ts`).

| Variable | What it is |
|---|---|
| `PAYMENTS_MODE` | The ceiling: `paper`, `stripe_test`, `stripe_live`, `paypal_sandbox`, `paypal_live`. Live Stripe is possible only with `stripe_live`. Below the ceiling, Settings → Payments picks Test or Live (migration 064, `platform_payment_settings`). Unset means `paper`. |
| `STRIPE_SECRET_KEY_TEST` | Test-mode key: `sk_test_` or a restricted `rk_test_`. |
| `STRIPE_SECRET_KEY_LIVE` | Live-mode key from your own Stripe account: `sk_live_` or, preferably, a restricted `rk_live_`. A key whose prefix does not match its mode is refused. |
| `STRIPE_WEBHOOK_SECRETS_TEST` | Comma-separated `whsec_` signing secrets of the test webhook endpoint(s). |
| `STRIPE_WEBHOOK_SECRETS_LIVE` | Comma-separated `whsec_` signing secrets of the live webhook endpoint(s). The secret that verifies a delivery decides its mode, and `event.livemode` must agree. |
| `STRIPE_SECRET_KEY` | Legacy single key, still honored: it serves the mode its prefix belongs to when the per-mode variable is unset. |
| `STRIPE_WEBHOOK_SECRET` | Legacy single signing secret, counted as Test. |
| `STRIPE_ACCOUNTS_API` | `v2` (default when unset) or `v1`: which Stripe Accounts API creates, reads and onboards creator payout accounts. v2 does not need the "Accounts v1 support" API-policy toggle. `STRIPE_ACCOUNTS_API_TEST` / `STRIPE_ACCOUNTS_API_LIVE` override it per mode. Transfers are `/v1/transfers` either way. |

Accounts v2 also emits thin events. Optionally add a Stripe event destination (Workbench → Webhooks, "Your account", thin payload) pointing at the same `/api/webhooks/stripe` URL with `v2.core.account[configuration.recipient].capability_status_updated`, `v2.core.account[requirements].updated` and `v2.core.account_link.returned`, and append its `whsec_` to the same per-mode secret list. The existing `account.updated` endpoint keeps working without it: Stripe still sends `account.updated` for v2 accounts on the Connected-accounts scope.

Switching to Live: Settings → Payments (operators only) shows the live account, its balance and a readiness checklist; the switch needs every item green and the typed confirmation `SWITCH TO LIVE`, and is audited as `payments.mode_switch`. Switching back to Test is one click.
