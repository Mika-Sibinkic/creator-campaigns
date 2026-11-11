// src/lib/cron-auth.ts
//
// Shared authentication for scheduler-driven routes (/api/cron/*,
// /api/negotiation/tick). These paths are exempt from the session/CSRF
// middleware gate (they carry no user session), so this IS the only gate —
// it must be strict.
//
// Trust model:
//   - The ONLY accepted credential is `Authorization: Bearer $CRON_SECRET`,
//     compared in constant time. Vercel Cron sends exactly this header when a
//     CRON_SECRET env var is set (its documented behavior), and the external
//     minute-pinger sends it too — so nothing legitimate needs anything else.
//   - We deliberately do NOT trust an `x-vercel-cron` header on its own: it is
//     client-suppliable off-Vercel (or behind a header-forwarding proxy), and
//     trusting it would let anyone drive the money/spend loop unauthenticated.
//     It matters most because the middleware exemption removes the session
//     backstop for these routes.
//   - With no CRON_SECRET configured, we open ONLY in local non-production dev
//     (so `npm run dev` + local e2e can drive the loop); a DEPLOYED build with
//     CRON_SECRET unset fails closed.

import { timingSafeEqual } from 'node:crypto';

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function authorizeCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') ?? '';
    return constantTimeEquals(auth, `Bearer ${secret}`);
  }
  // No secret set: safe only for local dev. A deployed build (NODE_ENV
  // 'production') with no secret is a misconfiguration — fail closed.
  return process.env.NODE_ENV !== 'production';
}
