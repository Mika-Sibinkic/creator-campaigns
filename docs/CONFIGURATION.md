# Configuration

Every variable is listed in `dashboard/.env.example`, names only.
Copy what you need into `dashboard/.env.local` (gitignored) for local work. For a
deployment, set the same names in your host's environment. "Production" means
required once the app runs with `NODE_ENV=production`.

To boot locally you need only the Supabase URL, the service-role key and
`DEV_USER_EMAIL`. The [README](../README.md#run-it) block writes all three.

| Variable | Required | What it does |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | Production | Public https origin of the app, used in links sent to creators and by `tools/_pgcron-setup.mjs`. Defaults to `http://localhost:3000` in development. |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase API URL (`supabase status` prints the local one). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | For tools | Supabase anon key. The app does not read it. `tools/preflight.mjs` and `tools/security-smoke.sh` use it to check that row-level security hides rows from the anon key. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service-role key. Every server route uses it, so it bypasses row-level security; keep it server-side. |
| `DATABASE_URL` | For tools | Postgres connection string for `tools/` scripts (`supabase status` prints the local one). |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Production | Clerk publishable key. Leave it unset locally and Clerk runs in keyless mode. |
| `CLERK_SECRET_KEY` | Production | Clerk secret key. Leave it unset locally (keyless mode). |
| `DEV_USER_EMAIL` | No | Development only: skip sign-in and act as this address. Ignored when `NODE_ENV=production`. `npm run dev` listens on localhost, so only this machine can use it. |
| `DEV_FIRM_ID` | No | Development only: the firm the bypass session belongs to. Needed when more than one firm exists. |
| `BOOTSTRAP_ALLOWED_DOMAINS` | For sign-in | Comma-separated email domains allowed to create a membership on first sign-in. |
| `BOOTSTRAP_ALLOWED_EMAILS` | For sign-in | Comma-separated exact addresses allowed to create a membership on first sign-in. |
| `BOOTSTRAP_FIRM_MAP` | For sign-in | `domain=firmUuid,user@host=firmUuid`: which existing firm an allowed address joins. |
| `BOOTSTRAP_NEW_FIRM_MAP` | For sign-in | `domain=Firm Name`: domains that get a new firm provisioned on first sign-in. |
| `OPERATOR_EMAILS` | No | Comma-separated addresses that can see operator-only screens and settings. |
| `CRON_SECRET` | Production | Bearer token every scheduled route requires. Unset is allowed only in local development. |
| `MODEL_PROVIDER` | No | `openai` (default), `gemini`, `groq` or `ollama`. |
| `MODEL_FALLBACK_CHAIN` | No | Comma-separated failover order. Empty disables failover; unset uses the built-in order. |
| `OPENAI_API_KEY` | For OpenAI | OpenAI API key (the default provider). |
| `GEMINI_API_KEY` | No | Gemini API key. |
| `GEMINI_MODEL` | No | Overrides the default Gemini model. |
| `GROQ_API_KEY` | No | Groq API key. |
| `GROQ_MODEL` | No | Overrides the default Groq model. |
| `OLLAMA_BASE_URL` | No | Local Ollama URL. Setting it is what enables Ollama in the failover chain. |
| `OLLAMA_MODEL` | No | Overrides the default Ollama model. |
| `APIFY_TOKEN` | For discovery | Apify token for the TikTok, Instagram and comment scrapers. |
| `SPOTIFY_CLIENT_ID` | For discovery | Spotify app client id, for artist and similar-artist lookup. |
| `SPOTIFY_CLIENT_SECRET` | For discovery | Spotify app client secret. |
| `SOUNDCHARTS_CLIENT_ID` | No | Soundcharts credentials for artist streaming metrics during measurement. |
| `SOUNDCHARTS_CLIENT_SECRET` | No | Soundcharts secret. |
| `SOUNDCHARTS_TEAM_ID` | No | Soundcharts team id, if your account has one. |
| `SCRAPECREATORS_API_KEY` | No | ScrapeCreators key. When set, it becomes the default comments provider. |
| `COMMENTS_PROVIDER` | No | `scrapecreators` or `apify`. Without a ScrapeCreators key it is always Apify. |
| `RESEND_API_KEY` | For email | Resend API key for sending, and for fetching inbound message bodies. |
| `RESEND_FROM_EMAIL` | For email | Sender address. Defaults to Resend's `onboarding@resend.dev`. |
| `RESEND_WEBHOOK_SECRET` | For email | Signing secret of the delivery-status webhook (`/api/webhooks/resend`). Unset rejects every delivery. |
| `RESEND_INBOUND_WEBHOOK_SECRET` | For inbound | Signing secret of the inbound webhook (`/api/webhooks/inbound-email`). Unset rejects every delivery. |
| `INBOUND_SENDER_AUTH_MODE` | No | `require` (default) or `permissive`: whether inbound mail must pass sender authentication. |
| `INBOUND_TRUSTED_AUTHSERV_IDS` | No | Comma-separated extra `Authentication-Results` authserv-ids to trust. |
| `TEST_RECIPIENT_EMAIL` | No | Last-resort test inbox for testing mode when neither the firm, the member nor the session supplies one. |
| `GMAIL_USER` | No | Mailbox the Gmail poller reads. |
| `GMAIL_QUERY` | No | Gmail search query for the poller. |
| `GMAIL_MAX_MESSAGES` | No | Cap on messages read per poll. |
| `GMAIL_CLIENT_ID` | For Gmail | Google OAuth client id (`tools/gmail-oauth-setup.mjs`). |
| `GMAIL_CLIENT_SECRET` | For Gmail | Google OAuth client secret. |
| `GMAIL_REFRESH_TOKEN` | For Gmail | Long-lived refresh token minted by `tools/gmail-oauth-setup.mjs`. |
| `GMAIL_ACCESS_TOKEN` | No | Static access token for tests and manual runs, used when no refresh token is set. |
| `GMAIL_OAUTH_PORT` | No | Local callback port for `tools/gmail-oauth-setup.mjs`. |
| `CREATOR_CAMPAIGNS_PERSONALITY` | No | Outreach voice: `warm` (default), `direct` or `playful`. |
| `OUTREACH_TZ_OFFSET_HOURS` | No | UTC offset used for quiet hours. Defaults to -5 (UTC-5); set it to your creators' region. |
| `PIPELINE_TIMEOUT_MS` | No | Wall-clock cap on one discovery run. |
| `APIFY_PER_RUN_USD_CAP` | No | Apify spend cap per discovery run. |
| `OPENAI_PER_RUN_USD_CAP` | No | Model spend cap per discovery run. |
| `DRAFT_OPENAI_USD_CAP` | No | Model spend cap per "draft all" batch. Blank or unset uses the code default. |
| `COMMENT_AUDIT_SPEND_CAP_USD` | No | Spend cap for the comment audit in one run. |
| `INSTAGRAM_MAX_CHARGE_USD` | No | Maximum charge passed to the Instagram scraper. |
| `INSTAGRAM_MAX_ITEMS` | No | Maximum items the Instagram scraper returns. |
| `INSTAGRAM_TIMEOUT_SECS` | No | Instagram scraper timeout. |
| `PAYMENTS_MODE` | No | Ceiling on payment rails: `paper` (default), `stripe_test`, `stripe_live`, `paypal_sandbox`, `paypal_live`. |
| `STRIPE_SECRET_KEY_TEST` | For Stripe | Test-mode key (`sk_test_` or `rk_test_`). |
| `STRIPE_SECRET_KEY_LIVE` | For Stripe | Live-mode key (`sk_live_` or, preferably, `rk_live_`). |
| `STRIPE_WEBHOOK_SECRETS_TEST` | For Stripe | Comma-separated `whsec_` secrets of the test webhook endpoints. |
| `STRIPE_WEBHOOK_SECRETS_LIVE` | For Stripe | Comma-separated `whsec_` secrets of the live webhook endpoints. |
| `STRIPE_SECRET_KEY` | No | Legacy single key; serves the mode its prefix belongs to. |
| `STRIPE_WEBHOOK_SECRET` | No | Legacy single signing secret, counted as test. |
| `STRIPE_ACCOUNTS_API` | No | `v2` (default) or `v1` Stripe Accounts API for creator payout accounts. |
| `STRIPE_ACCOUNTS_API_TEST` | No | Per-mode override of `STRIPE_ACCOUNTS_API`. |
| `STRIPE_ACCOUNTS_API_LIVE` | No | Per-mode override of `STRIPE_ACCOUNTS_API`. |
| `PAYPAL_CLIENT_ID` | For PayPal | PayPal REST client id. |
| `PAYPAL_CLIENT_SECRET` | For PayPal | PayPal REST client secret. |
| `PAYPAL_WEBHOOK_ID` | For PayPal | PayPal webhook id used to verify webhook signatures. |
| `SENTRY_DSN` | No | Turns on Sentry error reporting. |
| `LOG_LEVEL` | No | `debug`, `info` (default), `warn` or `error`. |

The payments variables are explained in more detail in
[dashboard/README.md](../dashboard/README.md). `NODE_ENV`, `VERCEL_ENV` and
`VERCEL_GIT_COMMIT_SHA` are also read but are set by the runtime or host. The
`tools/` scripts that write to a database additionally require
`CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1` on the command line.
