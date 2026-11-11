// src/lib/firm-scope.ts
//
// The firm-scope authorization predicate, extracted as a PURE function so it
// can be tested directly. No env, no I/O, no Supabase, no next/headers —
// same discipline as src/lib/payout-surfacing.ts.
//
// Why this exists: authentication (is there a session?) and authorization
// (may THIS caller act on THAT row?) were previously two different things in
// two different places. `src/middleware.ts` answers the first — it 401s any
// request without a Clerk session, and 401s a Clerk user with no
// firm_members row at all. It cannot answer the second: the edge has no idea
// which row the request is about, so its membership probe is
// `.eq('clerk_user_id', userId)` with no firm filter (middleware.ts:297-300).
// "Is a member of some firm" is NOT "is a member of the firm that owns this
// payment". Every money route therefore has to re-check ownership in-route,
// and POST /api/payments/authorize was the one that never did.
//
// Fail-closed by construction. A missing, null, empty or whitespace-only firm
// id on EITHER side is a denial, never a match:
//   - getSession() hands back firm_id '' for an authenticated-but-
//     unprovisioned Clerk user (src/lib/auth.ts:111). '' must never satisfy a
//     scope check, and must never compare equal to another '' .
//   - The previous execute-path guard was `if (opts.expectedFirmId && ...)`,
//     which SKIPPED the comparison entirely when the caller's firm was ''.
//     That is the exact shape this module exists to make unrepresentable.

/** Why a scope check was refused. Stable strings — safe to assert on. */
export type FirmScopeDenial =
  /** No session at all (caller firm id was null/undefined). */
  | 'no_session'
  /** Authenticated, but the caller carries no firm (unprovisioned member). */
  | 'caller_unscoped'
  /** The target row carries no firm id — refuse rather than guess. */
  | 'row_unscoped'
  /** Both sides are scoped, to different firms. */
  | 'firm_mismatch';

export type FirmScopeVerdict =
  | { ok: true; firmId: string }
  | {
      ok: false;
      httpStatus: 401 | 403;
      error: 'unauthorized' | 'forbidden';
      reason: FirmScopeDenial;
    };

/** A firm id is usable only if it is a non-blank string. */
function isScoped(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * May a caller belonging to `callerFirmId` act on a row owned by `rowFirmId`?
 *
 * Returns `{ ok: true, firmId }` only when both sides are non-blank strings
 * and exactly equal. Every other input — including both sides blank — is a
 * denial carrying the HTTP status and error body the route should return.
 *
 * Comparison is exact: no trimming, no case folding. Firm ids are uuids
 * (`payment_authorizations.firm_id` is `UUID NOT NULL`, migration 009), so a
 * value that needs normalizing to match is a value that should not match.
 */
export function checkFirmScope(
  callerFirmId: string | null | undefined,
  rowFirmId: string | null | undefined
): FirmScopeVerdict {
  if (callerFirmId === null || callerFirmId === undefined) {
    return { ok: false, httpStatus: 401, error: 'unauthorized', reason: 'no_session' };
  }
  if (!isScoped(callerFirmId)) {
    return { ok: false, httpStatus: 403, error: 'forbidden', reason: 'caller_unscoped' };
  }
  if (!isScoped(rowFirmId)) {
    return { ok: false, httpStatus: 403, error: 'forbidden', reason: 'row_unscoped' };
  }
  if (callerFirmId !== rowFirmId) {
    return { ok: false, httpStatus: 403, error: 'forbidden', reason: 'firm_mismatch' };
  }
  return { ok: true, firmId: callerFirmId };
}

/**
 * The JSON body a denied verdict should be returned as. Kept identical to the
 * shape the approve/reject/execute routes already emit (`{ error: 'forbidden' }`)
 * so this change is invisible to existing clients; `reason` is additive.
 */
export function firmScopeErrorBody(
  verdict: Extract<FirmScopeVerdict, { ok: false }>
): { error: string; reason: FirmScopeDenial } {
  return { error: verdict.error, reason: verdict.reason };
}
