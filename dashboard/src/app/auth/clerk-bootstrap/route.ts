// src/app/auth/clerk-bootstrap/route.ts
//
// Post-sign-in landing for Clerk. Clerk's <SignIn> forceRedirectUrl points
// here after authentication. We allowlist-gate the Clerk user's email and
// provision (or confirm) their firm_members row keyed on clerk_user_id, then
// redirect into the dashboard. A rejected email bounces to /sign-in with the
// not-allowed banner. This route is under /auth/* so the middleware treats it
// as public + membership-exempt (the check would otherwise bounce a brand-new
// user before they can be provisioned).
import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { bootstrapMembershipByClerk } from '@/lib/auth-bootstrap';
import { sessionEmail } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.redirect(new URL('/sign-in', req.url));
  }

  let email: string | null = null;
  try {
    email = sessionEmail(await currentUser());
  } catch {
    // Backend API hiccup — treat as no email, bootstrap will reject non-allowlisted.
  }

  const result = await bootstrapMembershipByClerk(userId, email);
  if (!result.ok) {
    const url = new URL('/sign-in', req.url);
    url.searchParams.set('error', 'not_allowed');
    return NextResponse.redirect(url);
  }

  return NextResponse.redirect(new URL('/', req.url));
}
