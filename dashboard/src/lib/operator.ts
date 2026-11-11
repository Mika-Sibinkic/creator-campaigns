// src/lib/operator.ts
//
// "Platform operator" — the staff running Creator Campaigns, as opposed to
// the record label using it.
//
// This is deliberately NOT `firm_members.role`. A label's own admin is
// `role = 'owner'` on their firm and must still never see the developer
// surfaces: the reply simulator, testing-mode switches, mock data toggles,
// payment-mode chips, raw ids, scraper debug. Those are our tools for running
// the product, not features of the product.
//
// It is also deliberately NOT `isAllowlisted` (src/lib/auth-bootstrap.ts).
// That predicate grows every time a label is onboarded; this one must not.
// Onboarding a new label can never hand them operator surfaces.
//
// Source of truth: OPERATOR_EMAILS (CSV, exact match, case-insensitive).
// With the var unset nobody is an operator: the fallback list is empty, matching
// auth-bootstrap (no built-in identities, fail closed).
//
// Exact emails only — no domain matching. A domain rule would silently make
// every future address on that domain an operator, and operator access
// should be a deliberate, enumerated act.

const FALLBACK_OPERATOR_EMAILS: string[] = [];

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Is this email a platform operator?
 *
 * Fail-closed: a null/blank/malformed email is never an operator. That matters
 * because `getSession()` degrades `email` to null when the Clerk Backend API is
 * unreachable — a Clerk outage hides operator surfaces rather than exposing
 * them to whoever is signed in.
 */
export function isPlatformOperator(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@')) return false;

  // An explicitly empty OPERATOR_EMAILS closes the door rather than falling
  // back to the built-ins — same trap the login allowlist already pins.
  const configured =
    process.env.OPERATOR_EMAILS === undefined
      ? FALLBACK_OPERATOR_EMAILS
      : parseCsv(process.env.OPERATOR_EMAILS);

  return configured.includes(normalized);
}

/**
 * Throw a 403-shaped Response unless the session belongs to an operator.
 * Use at the top of any route that exists to run the product rather than to
 * use it.
 */
export function requireOperator(session: { user: { email: string | null } }): void {
  if (!isPlatformOperator(session.user.email)) {
    throw new Response(JSON.stringify({ error: 'operator_only' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
}
