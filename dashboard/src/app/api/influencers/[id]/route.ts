// src/app/api/influencers/[id]/route.ts
//
// SECURITY-OK: supabaseAdmin — PATCH writes this firm's firm_influencer_blocks row (explicit firm_id predicate), the shared `contact_email` column (sole-label or operator only), and — operator-only — the shared `blocklisted` column. Gated by session + creator-relationship check.
//
// GET / PATCH a single creator. The handlers live in
// src/lib/influencer-detail-handlers.ts so they execute in tests with injected
// auth (tests/influencer-detail-scope.test.ts); this file only wires in the
// real session, the service-role client and the audit writer.
//
// Tenancy: `requireSessionAndClient()` returns the SERVICE-ROLE client
// (src/lib/auth.ts) and post-Clerk `auth.uid()` is NULL, so migration 007's
// policies never evaluate. Every firm boundary is app-level and lives in
// the handlers; RLS is defense-in-depth only.
import { requireSessionAndClient, requireSession } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { audit } from "@/lib/audit";
import { makeInfluencerDetailHandlers } from "@/lib/influencer-detail-handlers";

export const runtime = 'nodejs';

const handlers = makeInfluencerDetailHandlers({
  requireSession,
  requireSessionAndClient,
  admin: supabaseAdmin,
  audit,
});

export const GET = handlers.GET;
export const PATCH = handlers.PATCH;
