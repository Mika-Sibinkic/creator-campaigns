# Sentry setup

The dashboard's `src/instrumentation.ts` is already wired and no-ops cleanly
when `SENTRY_DSN` is unset. To turn it on:

## 1. Create the project (sentry.io)

1. Go to **https://sentry.io/signup** if you don't have an account.
2. Create an org (`your-org` below) or use an existing one.
3. **Projects → Create Project → Next.js**, name it `creator-campaigns`.
4. Sentry shows the DSN on the next page. It looks like
   `https://<key>@<org-id>.ingest.us.sentry.io/<project-id>`. Copy it.

## 2. Add the DSN to envs

### Local dev
```bash
cd dashboard
echo "SENTRY_DSN=<paste-it>" >> .env.local
```

### Hosted (example: Vercel preview + prod)
```bash
cd dashboard
vercel env add SENTRY_DSN preview
vercel env add SENTRY_DSN production
```
Paste the DSN at each prompt. On other hosts, set `SENTRY_DSN` in the
environment settings.

## 3. Verify

```bash
cd dashboard
npm run dev
```

In another terminal:

```bash
curl http://localhost:3000/api/health
```

Sentry initializes only when `SENTRY_DSN` is set at server start. The next
unhandled server error lands in the project's Issues view, tagged
`feature: creator-campaigns`.

## 4. (Optional) Forward CSP-Report-Only violations to Sentry

`/api/csp-report` (`src/app/api/csp-report/route.ts`) logs
Content-Security-Policy-Report-Only violations. To send them to Sentry as well,
add a `Sentry.captureMessage` call there.

## 5. Privacy

- `sendDefaultPii: false` is set in `src/instrumentation.ts`, so Sentry does
  not auto-collect IPs, headers, or user identifiers.
- `audit_log` metadata is PII-scrubbed (`src/lib/audit.ts`). Other tables,
  such as `inbound_messages` and `influencers`, store creator emails and reply
  text as received.
- Sentry sees whatever your code throws, so keep raw PII out of error
  messages (`scrubPII()` in `src/lib/audit.ts` helps).
