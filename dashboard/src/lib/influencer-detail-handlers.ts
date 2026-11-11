// src/lib/influencer-detail-handlers.ts
//
// GET / PATCH for /api/influencers/[id], built from injected auth + client so
// the handlers EXECUTE in tests (tests/influencer-detail-scope.test.ts) instead
// of being pinned by source greps. The route file only wires in the real
// session and re-exports these.
//
// SECURITY-OK: service-role client. RLS never evaluates (Clerk sessions carry
// no Supabase JWT, src/lib/auth.ts), so every firm boundary below is app-level.
//
//   - GET is USER PATH. The influencer row is shared by design, but the
//     response is an allowlist (src/lib/creator-detail.ts): no column another
//     label's pipeline wrote for itself, block state as THIS label sees it,
//     and campaign appearances from the caller's own campaigns only.
//   - PATCH { blocklisted } writes THIS firm's firm_influencer_blocks row
//     (migration 056, src/lib/firm-blocks.ts); the shared `blocklisted` column
//     is operator-only ({ scope: 'global' }). Requires the caller's firm to have
//     worked the creator (src/lib/creator-scope.ts).
//   - PATCH { contact_email } writes a SHARED column: every label's outreach,
//     counters and payout mail to this creator go to it. A label may change it
//     only while it is the ONLY label working the creator; otherwise 409 and a
//     platform operator changes it (checkSharedContactWrite). Every change is
//     audited old → new with firm and user, and the write is conditional on the
//     value read, so a concurrent change is a 409 rather than a blind overwrite.
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Session } from "./auth";
import type { AuditEntry } from "./audit";
import { checkFirmScope, firmScopeErrorBody } from "./firm-scope";
import {
  checkCreatorScope,
  checkSharedContactWrite,
  creatorScopeErrorBody,
  countFirmCreatorRelationships,
  firmRelatedInfluencerIds,
  firmsRelatedToCreator,
  redactUnrelatedCreator,
} from "./creator-scope";
import { applyBlockToggle, readFirmBlocks } from "./firm-blocks";
import { firmBlockView, pickCreatorDetail } from "./creator-detail";
import { isPlatformOperator } from "./operator";
import { tieredLimit, rateLimited } from "./rate-limit";
import { PatchInfluencerBody, PatchInfluencerContactBody } from "./zod-schemas";

type Ctx = { params: Promise<{ id: string }> };

export interface InfluencerDetailHandlerDeps {
  /** Resolves the session, or THROWS a Response (401). */
  requireSession: () => Promise<Session>;
  /** Resolves the session + data client, or THROWS a Response (401). */
  requireSessionAndClient: () => Promise<{ session: Session; sb: SupabaseClient }>;
  /** The service-role client PATCH writes through. */
  admin: () => SupabaseClient;
  /** audit_log writer. Never throws. */
  audit: (entry: AuditEntry, req?: Request) => Promise<void>;
}

const CREATOR_NOT_FOUND = { error: "Creator not found" } as const;

export function makeInfluencerDetailHandlers(deps: InfluencerDetailHandlerDeps) {
  async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
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
    const scope = checkFirmScope(session.firm_id, session.firm_id);
    if (!scope.ok) {
      return NextResponse.json(firmScopeErrorBody(scope), { status: scope.httpStatus });
    }

    // `*` at the query, allowlist at the response (pickCreatorDetail). The
    // projection is enforced in code so a column that has drifted on the live
    // table cannot 404 the page, and a column added later stays private.
    const { data: influencer, error } = await sb
      .from("influencers")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error || !influencer) {
      return NextResponse.json(CREATOR_NOT_FOUND, { status: 404 });
    }
    const row = influencer as Record<string, unknown>;

    // The creator row is shared by design, but not every column on it is:
    // only allowlisted fields go out, and the scraped contact address only to
    // a firm that has worked this creator.
    const relatedIds = await firmRelatedInfluencerIds(sb, session.firm_id);
    const visibleInfluencer = redactUnrelatedCreator(pickCreatorDetail(row), relatedIds);

    // Campaign appearances — THIS FIRM's only. `sb` is service-role, so
    // filtering by influencer_id alone returned every label's campaign rows
    // (artist names, pursuit status, negotiation state).
    const { data: ownCampaigns, error: campErr } = await sb
      .from("campaigns")
      .select("id")
      .eq("firm_id", session.firm_id);
    if (campErr) {
      return NextResponse.json({ error: campErr.message }, { status: 500 });
    }
    const ownCampaignIds = (ownCampaigns ?? []).map((c) => (c as { id: string }).id);

    let campaigns: unknown[] = [];
    if (ownCampaignIds.length > 0) {
      const { data } = await sb
        .from("campaign_influencers")
        .select(`
        *,
        campaign:campaigns(id, artist_name, status, created_at)
      `)
        .eq("influencer_id", id)
        .in("campaign_id", ownCampaignIds)
        .order("created_at", { ascending: false });
      campaigns = data ?? [];
    }

    // Block state as THIS label sees it: its own block/STOP (migration 056)
    // and the platform block every label honours. Never another label's rows,
    // reasons or sources.
    const firmBlocks = await readFirmBlocks(sb, session.firm_id, [id]);

    return NextResponse.json({
      ...visibleInfluencer,
      ...firmBlockView(id, row.blocklisted, firmBlocks),
      campaign_appearances: campaigns,
    });
  }

  async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
    const limit = tieredLimit(req, "auth");
    if (!limit.ok) {
      const r = rateLimited(limit.resetAt);
      return NextResponse.json(r.body, r.init);
    }
    const { id } = await ctx.params;
    let session: Session;
    try {
      session = await deps.requireSession();
    } catch (r) {
      return r as Response;
    }

    // Peek at the raw body to dispatch — both schemas accept disjoint key sets.
    let raw: Record<string, unknown>;
    try {
      raw = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    if (raw === null || typeof raw !== "object") {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    const admin = deps.admin();

    if ("contact_email" in raw) {
      return patchContactEmail(req, admin, session, id, raw);
    }

    // Block toggle. A label's block is per-firm since migration 056 but is
    // still only meaningful for a creator this firm has worked, and an
    // operator's global block mutates a shared column — so both require the
    // relationship.
    const relationships = await countFirmCreatorRelationships(admin, session.firm_id, id);
    const creatorScope = checkCreatorScope(session.firm_id, relationships);
    if (!creatorScope.ok) {
      return NextResponse.json(creatorScopeErrorBody(creatorScope), {
        status: creatorScope.httpStatus,
      });
    }

    const parsed = PatchInfluencerBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "validation_failed", issues: parsed.error.issues },
        { status: 422 }
      );
    }
    const scope = parsed.data.scope ?? "firm";

    const result = await applyBlockToggle(admin, {
      firmId: session.firm_id,
      influencerId: id,
      blocked: parsed.data.blocklisted,
      scope,
      isOperator: isPlatformOperator(session.user.email),
      userId: session.user.id,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, ...(result.message ? { message: result.message } : {}) },
        { status: result.httpStatus }
      );
    }

    await deps.audit(
      {
        action: "influencer.blocklist.update",
        target_type: "influencer",
        target_id: id,
        firm_id: session.firm_id,
        metadata: { blocklisted: parsed.data.blocklisted, scope: result.applied },
      },
      req
    );

    return NextResponse.json({ updated: true, scope: result.applied });
  }

  async function patchContactEmail(
    req: NextRequest,
    admin: SupabaseClient,
    session: Session,
    id: string,
    raw: Record<string, unknown>
  ): Promise<Response> {
    const parsed = PatchInfluencerContactBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "validation_failed", issues: parsed.error.issues },
        { status: 422 }
      );
    }
    // '' → null so the column can be cleared by blanking the input.
    const next = parsed.data.contact_email === "" ? null : parsed.data.contact_email;

    const isOperator = isPlatformOperator(session.user.email);
    const verdict = checkSharedContactWrite({
      callerFirmId: session.firm_id,
      isOperator,
      related: isOperator ? null : await firmsRelatedToCreator(admin, id),
    });
    if (!verdict.ok) {
      const body =
        verdict.httpStatus === 403
          ? creatorScopeErrorBody(verdict)
          : { error: verdict.error, message: verdict.message };
      return NextResponse.json(body, { status: verdict.httpStatus });
    }

    const { data: current, error: readErr } = await admin
      .from("influencers")
      .select("id, contact_email")
      .eq("id", id)
      .maybeSingle();
    if (readErr) {
      return NextResponse.json({ error: "read_failed" }, { status: 500 });
    }
    if (!current) {
      return NextResponse.json(CREATOR_NOT_FOUND, { status: 404 });
    }
    const prevRaw = (current as { contact_email?: unknown }).contact_email;
    const prev = typeof prevRaw === "string" ? prevRaw : null;
    if (prev === next) {
      return NextResponse.json({ updated: false, contact_email: next });
    }

    // Conditional on the value just read: a concurrent change (another
    // operator, the enrichment tick's backfill) turns into a 409 instead of
    // being overwritten, and the audit's old → new stays true.
    const base = admin
      .from("influencers")
      .update({ contact_email: next } as never)
      .eq("id", id);
    const guarded = prev === null ? base.is("contact_email", null) : base.eq("contact_email", prev);
    const { data: written, error: writeErr } = await guarded.select("id");
    if (writeErr) {
      return NextResponse.json({ error: "write_failed" }, { status: 500 });
    }
    if (!Array.isArray(written) || written.length === 0) {
      return NextResponse.json(
        {
          error: "contact_changed",
          message: "This creator's contact email was changed while you were editing it. Reload and try again.",
        },
        { status: 409 }
      );
    }

    await deps.audit(
      {
        action: "influencer.contact_email.update",
        target_type: "influencer",
        target_id: id,
        firm_id: session.firm_id || null,
        actor_user_id: session.user.id,
        actor_label: `user:${session.user.email ?? session.user.id}`,
        metadata: {
          old_contact_email: prev,
          new_contact_email: next,
          // Kept for readers of the older row shape.
          contact_email: next,
          firm_id: session.firm_id || null,
          changed_by_user_id: session.user.id,
          changed_by_email: session.user.email,
          basis: verdict.basis,
        },
      },
      req
    );
    return NextResponse.json({ updated: true, contact_email: next });
  }

  return { GET, PATCH };
}
