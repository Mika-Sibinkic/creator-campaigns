// src/lib/auth.ts
//
// Server-side auth helpers used by every USER-PATH route. Authentication is
// provided by Clerk; authorization (firm membership + role) is resolved from
// firm_members keyed by the Clerk user id.
//
// Exports:
//   - `getSession()` — `{ user, firm_id, role }` or null, from the Clerk
//     session + a firm_members lookup on clerk_user_id.
//   - `requireSession()` — throws a 401-shaped Response when unauthenticated.
//   - `requireSessionAndClient()` — session + the SERVICE-ROLE Supabase client.
//
// The firm boundary is in code, not in Postgres. Clerk sessions carry no
// Supabase JWT, so every user route reads with the service role and RLS never
// evaluates. Each route must filter by `session.firm_id` (firm-scope.ts,
// outreach-scope.ts, creator-scope.ts). RLS only stops someone holding the
// anon key.
//
// Dev bypass: when `NODE_ENV !== 'production'` AND `DEV_USER_EMAIL` is set,
// `getSession()` returns a synthetic session for that email even with no Clerk
// session, so the dev server is usable without signing in. Loud + prod-guarded.

import type { SupabaseClient } from '@supabase/supabase-js';
import { auth as clerkAuth, currentUser } from '@clerk/nextjs/server';
import { supabaseAdmin } from './supabase';

export interface Session {
  user: {
    id: string;
    email: string | null;
  };
  firm_id: string;
  role: string;
}

let _devBypassWarned = false;
function warnDevBypassOnce(email: string) {
  if (_devBypassWarned) return;
  _devBypassWarned = true;
  console.warn(
    `[auth] DEV BYPASS active for ${email} — ` +
      `set NODE_ENV=production or unset DEV_USER_EMAIL to disable.`
  );
}

/** The subset of a Clerk user that carries email addresses. */
export interface ClerkEmails {
  primaryEmailAddress?: { emailAddress: string } | null;
  emailAddresses?: { emailAddress: string; verification?: { status?: string | null } | null }[];
}

/**
 * The email the allowlist and operator gates may trust: the primary address,
 * else the first verified one, else null. An unverified address is never used,
 * since anyone can attach one to their Clerk account.
 */
export function sessionEmail(u: ClerkEmails | null | undefined): string | null {
  return (
    u?.primaryEmailAddress?.emailAddress ??
    u?.emailAddresses?.find((e) => e.verification?.status === 'verified')?.emailAddress ??
    null
  );
}

/**
 * Resolve the current authenticated session, if any.
 * - Reads the Clerk session (`clerkAuth()`), then looks up firm_members by
 *   clerk_user_id for firm_id + role.
 * - Authenticated-but-unprovisioned → firm_id '' + role 'unprovisioned'.
 * - Dev bypass (non-prod + DEV_USER_EMAIL) when there's no Clerk session.
 */
export async function getSession(): Promise<Session | null> {
  const { userId } = await clerkAuth();

  if (userId) {
    const admin = supabaseAdmin();
    const { data: member } = await admin
      .from('firm_members')
      .select('firm_id, role')
      .eq('clerk_user_id', userId)
      .limit(1)
      .single();

    let email: string | null = null;
    try {
      email = sessionEmail(await currentUser());
    } catch {
      // currentUser can throw if the Backend API is unreachable — email is
      // non-critical for authorization, so degrade to null.
    }

    if (member) {
      const m = member as { firm_id: string; role: string };
      return { user: { id: userId, email }, firm_id: m.firm_id, role: m.role };
    }
    return { user: { id: userId, email }, firm_id: '', role: 'unprovisioned' };
  }

  // Dev bypass — only fires when there's no Clerk session.
  if (process.env.NODE_ENV !== 'production' && process.env.DEV_USER_EMAIL) {
    const email = process.env.DEV_USER_EMAIL;
    warnDevBypassOnce(email);
    const admin = supabaseAdmin();
    // Same "first firm by created_at" shape the bootstrap used to carry, and
    // the same ambiguity: once a second label exists, "the first one" is not
    // a well-defined answer. DEV_FIRM_ID pins it explicitly; without it this
    // resolves a firm only while exactly ONE exists, and otherwise hands back
    // '' — which firm-scope.ts treats as a denial rather than a match.
    const pinned = process.env.DEV_FIRM_ID?.trim();
    let firmId = '';
    if (pinned) {
      firmId = pinned;
    } else {
      const { data: firms } = await admin
        .from('firms')
        .select('id')
        .order('created_at', { ascending: true })
        .limit(2);
      const rows = (firms as { id: string }[] | null) ?? [];
      if (rows.length === 1) {
        firmId = rows[0].id;
      } else if (rows.length > 1) {
        console.warn(
          '[auth] DEV BYPASS: more than one firm exists — set DEV_FIRM_ID to choose one. ' +
            'Continuing unscoped (every firm-scope check will deny).'
        );
      }
    }
    return {
      user: { id: 'dev-bypass', email },
      firm_id: firmId,
      role: 'dev-bypass',
    };
  }

  return null;
}

/**
 * Throw a 401 Response if no session. Use at the top of user-path routes.
 */
export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) {
    throw new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return s;
}

/**
 * Session + a Supabase client for data access. Clerk sessions carry no Supabase
 * JWT, so this returns the service-role client; authorization is enforced by
 * the caller scoping every query to `session.firm_id`.
 */
export async function requireSessionAndClient(): Promise<{
  session: Session;
  sb: SupabaseClient;
}> {
  const session = await requireSession();
  return { session, sb: supabaseAdmin() };
}
