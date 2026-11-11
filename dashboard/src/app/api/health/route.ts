// src/app/api/health/route.ts
//
// SECURITY-OK: supabaseAdmin — public readiness probe; whitelisted in middleware; must run without a session for cron + Vercel keep-alive.
//
// SYSTEM PATH — keeps using supabaseAdmin().
//
// Why bypass: this route is a public readiness probe (whitelisted in
// middleware) used by daily smoke crons + the Vercel keep-alive ping that
// prevents Supabase auto-pause on the free tier. It MUST work without a
// session. We touch one row in `firms` (the cheapest possible read).
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { tieredLimit, rateLimited } from "@/lib/rate-limit";

export async function GET(req: Request) {
  // Public-tier limit so an attacker can't pin Supabase via the keep-alive.
  // Cron pings + Vercel keep-alive (15-min) are well below 30/min.
  const limit = tieredLimit(req, 'public');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  const { error } = await supabaseAdmin().from("firms").select("id").limit(1);
  // 503 on a failed read: uptime checks read the status code, not the body.
  return NextResponse.json({ ok: !error, ts: new Date().toISOString() }, { status: error ? 503 : 200 });
}
