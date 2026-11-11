// src/lib/outreach-message-handlers.ts
//
// GET / PATCH / DELETE for /api/outreach/messages/[id], built from injected
// auth so the handlers EXECUTE in tests (tests/outreach-message-scope.test.ts)
// instead of being pinned by source greps. The route file only wires in
// requireSessionAndClient and re-exports these.
//
// Tenant boundary: `sb` is the SERVICE-ROLE client — RLS never evaluates — so
// every verb first proves the message belongs to session.firm_id
// (outreachMessageInFirm, src/lib/outreach-scope.ts) and answers 404 otherwise,
// before any read that returns data or any write.
//
// PATCH mark_sent: send_mode='human_queue' rows were sent BY A
// HUMAN from the firm's own DM account, so mark_sent records the fact directly
// (recordHumanDmSend). Every other row answers 409: email goes out through
// POST /api/outreach/[id]/send, which owns Resend dispatch + ledger writes.
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Session } from "./auth";
import { tieredLimit, rateLimited } from "./rate-limit";
import { readJson } from "./validate";
import { PatchOutreachMessageBody } from "./zod-schemas";
import { recordHumanDmSend } from "./dm-mark-sent";
import { editCounterDraft, editOutboundMessage } from "./counter-edit";
import { OUTREACH_NOT_FOUND, outreachMessageInFirm } from "./outreach-scope";

type Ctx = { params: Promise<{ id: string }> };

export interface OutreachMessageHandlerDeps {
  /** Resolves the session + data client, or THROWS a Response (401). */
  requireSessionAndClient: () => Promise<{ session: Session; sb: SupabaseClient }>;
}

type Authed = { session: Session; sb: SupabaseClient; id: string };

export function makeOutreachMessageHandlers(deps: OutreachMessageHandlerDeps) {
  /** Rate limit → auth → ownership. Returns the Response to send on refusal. */
  async function gate(req: NextRequest, ctx: Ctx): Promise<Authed | Response> {
    const limit = tieredLimit(req, "auth");
    if (!limit.ok) {
      const r = rateLimited(limit.resetAt);
      return NextResponse.json(r.body, r.init);
    }
    const { id } = await ctx.params;
    let sb: SupabaseClient, session: Session;
    try {
      ({ sb, session } = await deps.requireSessionAndClient());
    } catch (r) {
      return r as Response;
    }
    // Tenant gate — sb is service-role. A foreign id reads exactly like an
    // unknown one, so another label learns nothing about what exists.
    if (!(await outreachMessageInFirm(sb, id, session.firm_id))) {
      return NextResponse.json(OUTREACH_NOT_FOUND, { status: 404 });
    }
    return { session, sb, id };
  }

  // GET single message
  async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
    const g = await gate(req, ctx);
    if (g instanceof Response) return g;
    const { sb, id } = g;

    const { data, error } = await sb
      .from("outreach_messages")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) {
      return NextResponse.json(OUTREACH_NOT_FOUND, { status: 404 });
    }

    return NextResponse.json(data);
  }

  // PATCH — edit message body, mark as sent, etc.
  async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
    const g = await gate(req, ctx);
    if (g instanceof Response) return g;
    const { sb, session, id } = g;
    const body = await readJson(req, PatchOutreachMessageBody);
    if (body instanceof NextResponse) return body;

    // A queued COUNTER draft quotes a price, and the price is part of the
    // record: the edit re-derives it from the new
    // text, or requires the editor to confirm it, and saves it on the row with
    // the body (src/lib/counter-edit.ts). Every other message edits as before.
    if (body.body !== undefined && !body.mark_sent) {
      const counter = await editCounterDraft(sb, {
        messageId: id,
        body: body.body,
        subject: body.subject,
        confirmedOfferUsd: body.offer_usd ?? null,
      });
      if (counter.kind === "refused") {
        return NextResponse.json(counter.body, { status: counter.status });
      }
      if (counter.kind === "saved") {
        return NextResponse.json({ ...counter.row, offer_usd: counter.offer_usd, offer_usd_derived: counter.derived });
      }
    }

    if (body.mark_sent) {
      // A human_queue row was sent BY A HUMAN from the firm's own DM
      // account — nothing to dispatch. recordHumanDmSend (src/lib/dm-mark-sent.ts)
      // runs every gate (already sent / window closed / terminal / held →
      // ownership → per-label do-not-contact) and only then records the send:
      // sent flip + lead advance + social_send_events + 'sent' prior + a PRICED
      // offer, none of which this codebase can undo.
      const dm = await recordHumanDmSend(sb, { messageId: id, callerFirmId: session.firm_id });
      if (dm.kind === "response") {
        return NextResponse.json(dm.body, { status: dm.status });
      }
      return NextResponse.json(
        {
          error: "use_send_route",
          message: `Only queued DMs are marked sent by hand. Send this message with POST /api/outreach/${id}/send.`,
        },
        { status: 409 },
      );
    }

    if (body.body === undefined && body.subject === undefined && body.offer_usd === undefined) {
      return NextResponse.json({ error: "No updates provided" }, { status: 400 });
    }

    // Any other message an operator sends by hand records a price
    // ONLY through the optional "Price quoted" field (offer_usd; null clears
    // it), never from its text. Body, subject and price go in ONE
    // write, compare-and-swapped on the row's status, so an edit can never
    // land on a row the dispatch pass has already claimed for sending
    // (src/lib/counter-edit.ts editOutboundMessage → 409).
    const edit = await editOutboundMessage(sb, {
      messageId: id,
      body: body.body,
      subject: body.subject,
      usd: body.offer_usd,
    });
    if (edit.kind === "refused") {
      return NextResponse.json(edit.body, { status: edit.status });
    }
    if (body.body === undefined && body.subject === undefined) {
      return NextResponse.json({ id, offer_usd: edit.offer_usd ?? null });
    }
    return NextResponse.json(edit.row);
  }

  // DELETE message
  async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
    const g = await gate(req, ctx);
    if (g instanceof Response) return g;
    const { sb, id } = g;

    const { error } = await sb
      .from("outreach_messages")
      .delete()
      .eq("id", id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ deleted: true });
  }

  return { GET, PATCH, DELETE };
}
