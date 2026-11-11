// src/app/api/outreach/messages/[id]/route.ts
//
// GET / PATCH / DELETE a single outreach message. The handlers live in
// src/lib/outreach-message-handlers.ts so they execute in tests with injected
// auth; this file only wires in the real session.
//
// `requireSessionAndClient()` returns the SERVICE-ROLE client (Clerk sessions
// carry no Supabase JWT), so RLS does not scope these rows. Every verb proves
// the message belongs to session.firm_id before touching it and answers 404
// otherwise (src/lib/outreach-scope.ts). Previously only the human_queue
// mark_sent branch checked ownership; any signed-in user of any label could
// read, edit or delete another label's message by id.
import { requireSessionAndClient } from "@/lib/auth";
import { makeOutreachMessageHandlers } from "@/lib/outreach-message-handlers";

export const runtime = 'nodejs';

// REMOVED: dmCadenceFor() + the `dm_cadence` field this GET attached to every
// human_queue row.
//
// It read `social_accounts`, a table with ZERO writers anywhere in the
// repository: no API route, no UI, no worker, no seed,
// no Postgres function. So it returned `{has_account:false}` on 100% of rows and
// the queue rendered "Connect a sending account to track cadence", instructing
// the operator to create something the product has no way to create. Its
// `local_hour` also came from the operator's browser clock, which this file's
// own comment admitted was a stand-in for a timezone the accounts table does
// not have.
//
// The cost was not the dead copy, it was the fan-out: the DM queue called this
// GET once per row IN PARALLEL, and each call ran up to 4 sequential DB queries.
// At ~302 rows that is ~1,200 round trips on one page load, ~180 of them 429ing
// against the 120-req/min 'auth' bucket this route shares with `Mark sent`, the
// list reload and 40+ other authed routes.
//
// The queue now shows `outreach_messages.send_after` instead — real, per-row,
// and written by negotiation-tick's quiet-hours deferral. If a sending account
// ever becomes creatable, the cadence verdict belongs in the LIST payload, not
// in an N+1 from the client.

const handlers = makeOutreachMessageHandlers({ requireSessionAndClient });

export const GET = handlers.GET;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
