# Receiving creator replies by email (operator guide)

One MX record plus one webhook turns creator replies into rows in the reply queue.
Without it, four pipeline stages (`contacted → responded → negotiating →
deal_closed`) can never advance, because nothing can observe that a creator
answered.

This is the recommended transport. Gmail polling also works, but it needs OAuth
access to the mailbox, so every label using the app would have to hand over its
inbox. An MX record needs nothing from the label, and one Resend account serves
every tenant.

Transport: Resend Receiving, event `email.received`.
Docs: <https://resend.com/docs/dashboard/receiving/introduction>

DNS changes affect everything else on your domain, including its sending records,
so run and check each step yourself.

The examples use `example.com` for your domain and `inbound.example.com` for the
receiving subdomain. Substitute your own.

## Use a subdomain, never the apex

Once receiving is enabled on a domain, Resend receives every email sent to it, and
only if its MX record is the lowest-priority MX on that domain.

If `example.com` is a working mailbox, a Resend MX on the apex either receives
nothing (the existing MX wins) or takes over your real email (the Resend one wins).
Resend says so directly:

> "we strongly recommend verifying a subdomain (`subdomain.example.com`) instead of
> the root domain (`example.com`)."

**Use a subdomain such as `inbound.example.com`, never the apex.**

## Before you start: two values you'll need

1. Your app's URL: the deployed https origin of the dashboard, e.g.
   `https://app.example.com`. The webhook path is `/api/webhooks/inbound-email`.
2. The MX value Resend shows you. It depends on the region, so copy it from the
   dashboard, not from this document. The example below is `us-east-1`.

## Step 1: Add the receiving subdomain in Resend

In Resend, go to Domains, then Add Domain, and add:

```
inbound.example.com
```

Enable Receiving on it. Resend shows one MX record to add.

To test before touching DNS, use the free `<id>.resend.app` subdomain every Resend
account has. It receives mail at once, so you can prove the webhook end to end and
do the DNS afterwards.

## Step 2: Add the MX record at your DNS provider

Add exactly one record on the `inbound` subdomain. This is the shape only; take the
real value from the Resend dashboard:

| Field | Value |
|---|---|
| Type | `MX` |
| Name | `inbound` |
| Value / Content | `inbound-smtp.us-east-1.amazonaws.com` |
| Priority | `10` |

Check two things before you move on:

- The record is on `inbound`, not on `@` or the root.
- It is the lowest priority number of any MX on `inbound.example.com` (it should be
  the only one).

The sending-side SPF/bounce MX, `feedback-smtp.us-east-1.amazonses.com`, is a
different host with a different purpose.

Click "I've added the record" in Resend and wait for it to verify.

## Step 3: Create the webhook endpoint

In Resend, go to Webhooks, then Add Webhook:

- URL: `https://<your-app-domain>/api/webhooks/inbound-email`
- Event: `email.received` (this one only)

Resend shows a signing secret that starts with `whsec_`. Copy it now; the app
verifies every request against it.

This endpoint is separate from the delivery-status webhook (`/api/webhooks/resend`,
which handles `bounced`, `delivered` and `opened`). Each Resend endpoint has its own
signing secret, so the two cannot share one.

## Step 4: Set the environment variables

Both are server-side. `RESEND_API_KEY` is already set; the inbound path needs it
because Resend's webhook carries no message body, so the app fetches it with a
second call.

Set them wherever your deployment reads its environment (on Vercel: Project,
Settings, Environment Variables):

| Variable | Value | Already set? |
|---|---|---|
| `RESEND_INBOUND_WEBHOOK_SECRET` | the `whsec_…` from Step 3 | no, this is new |
| `RESEND_API_KEY` | existing Resend API key | yes |

Paste the secret into your host's settings UI directly. Do not echo it into a
shell, a command flag, or a commit.

**If `RESEND_INBOUND_WEBHOOK_SECRET` is unset, the route refuses every request with
401** and logs `RESEND_INBOUND_WEBHOOK_SECRET is unset`. Without the secret there is
no way to tell a real Resend delivery from anyone else posting to the URL.

Redeploy after setting it. On most hosts, env changes do not reach a running
deployment.

## Step 5: Point the firm's reply address at the new subdomain

Step 5 is what routes replies. Outbound stamps a per-lead `Reply-To` built from the
firm's negotiation inbox: `<local>+lead-<campaign_influencer_id>@<domain>`. If that
address still points at your ordinary mailbox, replies land there and the webhook
never fires.

Set the firm's `negotiation_inbox_email` (Settings UI, or
`firms.negotiation_inbox_email`) to an address on the receiving subdomain:

```
replies@inbound.example.com
```

Outbound then stamps `replies+lead-<id>@inbound.example.com`, which lands on the
Resend MX, and the route maps the address back to the firm. Mail is still sent from
`RESEND_FROM_EMAIL`; only the reply address moves.

Each additional label gets its own address on the same subdomain
(`acme@inbound.example.com`), set on its own firm row. The route resolves recipient
to firm on every message, so several labels work with no code change.

## Step 6: Verify it works

Mail from an unknown address is refused by design; test with a real reply. The
endpoint is internet-writable and feeds a loop that can agree deals, so a message
must show one of two things before it is stored:

- it was sent to a `+lead-<id>` reply address (only someone who received a real
  outreach email has one), or
- its From is an address already on file for a creator.

Find a lead in `contacted` state and reply to the outreach email it generated. Any
outreach email the app sent works too; its `Reply-To` already carries the tag.

Then check, in order:

1. In Resend, open Webhooks, your endpoint, deliveries. `200` means the app accepted
   the delivery, `401` means the secret is wrong or unset, and `503` means the app
   could not fetch the body (check `RESEND_API_KEY`).
2. The `inbound_messages` table should have a new row with `channel = 'email'` and
   `external_id` starting `resend:`.

A reply that carries the `+lead-` tag and comes from the creator's known address
gets `campaign_influencer_id` filled and advances the lead. A reply that carries the
tag but comes from another address is stored unattributed, and a human decides.
That is the thread-hijack guard: the id travels in the `Reply-To` of every outreach
email, so it leaks through forwards, bounces and auto-replies, and holding it must
never be enough to move money.

Testing-mode dry runs are the one exception. When the lead's firm has
`testing_mode` on, every outbound went to the firm's test inbox
(`firms.test_recipient_email`, or a member's `firm_members.test_recipient_email`
override), so you reply from that inbox playing the creator. A tagged reply whose
From is exactly one of those addresses is attributed and drives the negotiator like
a real creator reply. The row is marked
`sender_auth_outcome = 'testing_mode_attribution'`, and the audit line carries
`testing_mode_attribution: true`. The exception never applies with testing mode
off, without the `+lead-` tag, or from any other address, and it is refused if the
reply reached a different firm's inbox. It is safe for a dry run because in testing
mode the tag was only ever mailed to the test inbox.

To watch a refusal, send a message from an unknown address to the inbox. The
delivery is `200` with `"ignored": "not_ours"`, and nothing is stored.

## What it costs

Resend counts sent and received email against the same quota, so each creator reply
uses quota just as each send does. Check Resend's pricing page for your plan's
limits.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Every delivery is `401` | `RESEND_INBOUND_WEBHOOK_SECRET` is unset, wrong, or set on the wrong environment of your host. Redeploy after setting it. |
| Deliveries are `200` but say `ignored: "not_ours"` | The message had no `+lead-` tag on its envelope recipient, and its From is not a known creator address. Usually a plain test email; see Step 6. If a real creator hits this, add their address to the influencer record. |
| Rows appear but `campaign_influencer_id` is null, and logs say `sender does not match the correlated creator` | The reply carried a valid tag but came from a different address than the one on file (a creator's second account, or someone replaying a leaked id). It is queued for a human and does not advance the lead. Add the second address to the creator's record if it is genuine. |
| Deliveries say `ignored: "content_too_large"` | The body exceeded `MAX_CONTENT_BYTES` in `src/lib/channels/resend-inbound.ts`, so it was refused without parsing. |
| Deliveries are `503` | The body fetch failed. Check `RESEND_API_KEY`. Resend retries failed deliveries. |
| Some deliveries are `429` | More inbound deliveries arrived from one Resend IP in a minute than the `public` tier in `src/lib/rate-limit.ts` allows (30). Resend retries on a backoff, so the reply is delayed, not lost, until its retries run out. |
| No delivery at all | DNS. Confirm the MX is on `inbound`, resolves, and is lowest priority. |
| Your normal email stopped arriving | The MX went on the apex instead of `inbound`. Remove it now. |

To confirm the MX from a terminal:

```bash
dig +short MX inbound.example.com
```

## The Gmail transport

Without `GMAIL_REFRESH_TOKEN` (or `GMAIL_ACCESS_TOKEN`), `pollGmailInbound()`
returns `{ skipped: 'gmail_not_configured' }` on every negotiation tick. The Gmail
path still works if you supply credentials (`tools/gmail-oauth-setup.mjs` mints the
refresh token). This guide sets up a second, independent transport alongside it.
