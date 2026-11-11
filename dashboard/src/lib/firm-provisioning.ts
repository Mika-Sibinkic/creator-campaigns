// src/lib/firm-provisioning.ts
//
// Which firm does a brand-new authenticated user belong to?
//
// The old answer was "the first firm by created_at, as owner"
// (auth-bootstrap.ts, pre-change). That is safe only while exactly one firm
// row exists. Creator Campaigns can serve several labels, and the ONLY
// onboarding lever that exists is BOOTSTRAP_ALLOWED_DOMAINS. So the moment
// label B's domain is added to that allowlist — the exact action required to
// onboard them — label B's first user is granted `owner` on label A's firm
// and inherits A's campaigns, creators and scraped contact emails.
//
// The allowlist answers "may this person in?". It cannot answer "into WHICH
// firm?". This module separates those two questions and makes the second one
// explicit, so that widening the allowlist can never widen firm access.
//
// Pure by construction: `resolveBootstrapTarget` does no I/O, so every branch
// (including the deny branches) is directly testable. Only
// `provisionFirmWithOwner` touches Supabase — same split as
// src/lib/firm-scope.ts and src/lib/payout-surfacing.ts.
//
// Configuration (all optional, all plain env — see README):
//   BOOTSTRAP_FIRM_MAP        "domain=firmUuid,user@host=firmUuid"
//                             Exact-email entries beat domain entries.
//   BOOTSTRAP_NEW_FIRM_MAP    "domain=Firm Display Name"
//                             Domains that should be PROVISIONED their own
//                             firm on first sign-in rather than joining one.
//
// Fail-closed: an allowlisted email with no mapping and no provision rule is
// DENIED (`no_firm_mapping`), never silently placed in someone else's firm.

import type { SupabaseClient } from '@supabase/supabase-js';

/** Why a bootstrap was refused. Stable strings — safe to assert on. */
export type BootstrapDenial =
  /** Not a usable email address at all. */
  | 'invalid_email'
  /** Email passed no allowlist rule. */
  | 'email_not_allowlisted'
  /** Allowlisted, but no rule says which firm they belong to. */
  | 'no_firm_mapping';

export type BootstrapTarget =
  /** Join an existing firm, identified explicitly by id. */
  | { kind: 'join'; firmId: string }
  /** Provision a brand-new firm for this email's domain. */
  | { kind: 'provision'; firmName: string; domain: string }
  | { kind: 'deny'; reason: BootstrapDenial };

export interface TenancyConfig {
  /** email or domain (lowercased) → firm uuid */
  firmMap: Map<string, string>;
  /** domain (lowercased) → display name for a firm to create */
  newFirmMap: Map<string, string>;
}

/**
 * Parse `a=b,c=d` into a Map, lowercasing keys and trimming both sides.
 * Malformed entries (no `=`, empty key, empty value) are dropped rather than
 * throwing: a typo in one entry must not take the whole sign-in path down,
 * and dropping is the fail-closed direction (fewer grants, not more).
 */
function parsePairs(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  for (const entry of raw.split(',')) {
    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    const key = entry.slice(0, eq).trim().toLowerCase();
    const value = entry.slice(eq + 1).trim();
    if (!key || !value) continue;
    out.set(key, value);
  }
  return out;
}

/** Read tenancy configuration out of an env-shaped bag. Pure. */
export function parseTenancyConfig(
  env: Record<string, string | undefined>
): TenancyConfig {
  return {
    firmMap: parsePairs(env.BOOTSTRAP_FIRM_MAP),
    newFirmMap: parsePairs(env.BOOTSTRAP_NEW_FIRM_MAP),
  };
}

/** Split an email into its normalized form and domain. Blank-safe. */
function normalizeEmail(email: string | null | undefined): {
  normalized: string;
  domain: string;
} | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@')) return null;
  const domain = normalized.split('@')[1] ?? '';
  if (!domain) return null;
  return { normalized, domain };
}

/**
 * Decide which firm an allowlisted email belongs in.
 *
 * `allowlisted` is passed in rather than recomputed so this stays pure and so
 * the two questions ("may they in?" / "into which firm?") remain visibly
 * separate. Order is deliberate — most specific rule wins:
 *   1. exact-email entry in BOOTSTRAP_FIRM_MAP        → join that firm
 *   2. domain entry in BOOTSTRAP_FIRM_MAP             → join that firm
 *   3. domain entry in BOOTSTRAP_NEW_FIRM_MAP         → provision a firm
 *   4. otherwise                                      → DENY
 */
export function resolveBootstrapTarget(opts: {
  email: string | null | undefined;
  allowlisted: boolean;
  config: TenancyConfig;
}): BootstrapTarget {
  const parsed = normalizeEmail(opts.email);
  if (!parsed) return { kind: 'deny', reason: 'invalid_email' };
  if (!opts.allowlisted) {
    return { kind: 'deny', reason: 'email_not_allowlisted' };
  }

  const { normalized, domain } = parsed;
  const { firmMap, newFirmMap } = opts.config;

  const exact = firmMap.get(normalized);
  if (exact) return { kind: 'join', firmId: exact };

  const byDomain = firmMap.get(domain);
  if (byDomain) return { kind: 'join', firmId: byDomain };

  const provisionName = newFirmMap.get(domain);
  if (provisionName) {
    return { kind: 'provision', firmName: provisionName, domain };
  }

  return { kind: 'deny', reason: 'no_firm_mapping' };
}

/**
 * The role a new member should get.
 *
 * First human in a firm is its owner; everyone after that is a member.
 * Previously EVERY bootstrapped user was written as `owner`, so a label's
 * second employee silently got the same authority as its first.
 *
 * NOTE: `firm_members.role` is free text (migration 007 sets
 * `role text NOT NULL DEFAULT 'owner'`, no CHECK) and no route currently
 * branches on it. This makes the stored value truthful ahead of the first
 * route that does; it is not, by itself, an enforcement point.
 */
export function roleForNewMember(existingMemberCount: number): 'owner' | 'member' {
  return existingMemberCount === 0 ? 'owner' : 'member';
}

export interface ProvisionResult {
  ok: boolean;
  firmId?: string;
  firmName?: string;
  /** The role the member row was written with. Only set when ok. */
  role?: 'owner' | 'member';
  /**
   * TRUE only when a `firm_members` row for this caller now exists because
   * THIS call wrote it. The caller uses this to decide whether it still needs
   * to write one, so it must describe the MEMBER row, never the firm row.
   *
   * An earlier version returned ok:true from the idempotency branch without
   * writing a member row, and the caller read that as "membership handled".
   * Every user after the first at a new label was therefore provisioned into
   * a firm with no membership row, redirected to `/`, and bounced straight
   * back to /sign-in by the middleware — permanently, since every retry took
   * the same branch.
   */
  memberWritten?: boolean;
  error?: string;
}

/**
 * How many members a firm already has.
 *
 * Returns `null` — NOT 0 — when the count cannot be read. A count that failed
 * is not a count of zero, and treating it as zero would hand out `owner`.
 * Every caller must fail closed on null.
 */
export async function countFirmMembers(
  admin: SupabaseClient,
  firmId: string
): Promise<number | null> {
  const { count, error } = await admin
    .from('firm_members')
    .select('id', { count: 'exact', head: true })
    .eq('firm_id', firmId);
  if (error) return null;
  return count ?? null;
}

/**
 * Ensure a firm exists for this domain AND that this caller is a member of it.
 *
 * Both halves, always. The function is named for the first-user case because
 * that is what it usually does, but it is the join path for every subsequent
 * user at that label too: nothing ever moves a domain out of
 * BOOTSTRAP_NEW_FIRM_MAP, so user 2, 3 and 4 all resolve to `provision` and
 * all arrive here. If this returned early without writing a member row they
 * would each be redirected to `/`, find no membership, and be bounced to
 * /sign-in with an error indistinguishable from an allowlist rejection —
 * forever, because every retry takes the same branch.
 *
 * Order is deliberate:
 *   1. find the firm for this domain, or create it
 *   2. count its existing members (FAIL CLOSED — an unreadable count denies)
 *   3. insert the member row with the role that count implies
 *
 * Step 3 runs on both paths, which also makes this the RECOVERY path for a
 * crash between the two inserts: a firm left ownerless by process death is
 * found in step 1, counted at 0 members in step 2, and given its owner in
 * step 3. The compensating delete only covers an *errored* member insert, so
 * without this it would have stayed ownerless permanently.
 *
 * Supabase-js has no client-side transaction, so a create is still
 * create-then-link with a COMPENSATING DELETE on failure. True atomicity
 * needs a SECURITY DEFINER RPC doing both inserts in one statement; that
 * requires a migration, deliberately not created here (numbers are allocated
 * centrally).
 */
export async function provisionFirmWithOwner(
  admin: SupabaseClient,
  opts: {
    firmName: string;
    domain: string;
    member: { clerkUserId?: string | null; userId?: string | null };
  }
): Promise<ProvisionResult> {
  const marker = `@${opts.domain}`;

  // 1. Re-entrancy: a retried or subsequent bootstrap for the same domain
  //    must JOIN the firm already made, never mint a second one. Without a
  //    UNIQUE constraint this is check-then-act; the recommended
  //    `firms.domain` unique index closes the remaining window properly.
  const { data: existing, error: lookupErr } = await admin
    .from('firms')
    .select('id, name')
    .like('primary_contact_email', `%${marker}`)
    .limit(1);
  if (lookupErr) {
    return { ok: false, error: `firm lookup failed: ${lookupErr.message}` };
  }

  let firm: { id: string; name: string } | null =
    existing && existing.length > 0 ? (existing[0] as { id: string; name: string }) : null;
  const firmWasCreated = firm === null;

  if (!firm) {
    const { data: created, error: firmErr } = await admin
      .from('firms')
      .insert({
        name: opts.firmName,
        // Domain marker — how a retry recognises the firm it already made.
        primary_contact_email: `owner${marker}`,
      } as never)
      .select('id, name')
      .single();
    if (firmErr || !created) {
      return { ok: false, error: `firm insert failed: ${firmErr?.message ?? 'no rows'}` };
    }
    firm = created as { id: string; name: string };
  }

  // 2. A firm we just created provably has no members. An existing one must
  //    be counted, and an unreadable count denies rather than defaulting to
  //    0 (which would silently hand out a second `owner`).
  let existingMembers: number;
  if (firmWasCreated) {
    existingMembers = 0;
  } else {
    const counted = await countFirmMembers(admin, firm.id);
    if (counted === null) {
      return { ok: false, error: 'member count unreadable' };
    }
    existingMembers = counted;
  }
  const role = roleForNewMember(existingMembers);

  // 3. Always write the membership.
  const { error: memberErr } = await admin.from('firm_members').insert({
    firm_id: firm.id,
    clerk_user_id: opts.member.clerkUserId ?? null,
    user_id: opts.member.userId ?? null,
    role,
  } as never);

  if (memberErr) {
    // Compensating delete — but ONLY for a firm this call created. Deleting
    // an existing firm because one person's membership failed would cascade
    // away that label's entire dataset (firm_members, campaigns, everything
    // ON DELETE CASCADE from firms).
    if (firmWasCreated) {
      await admin.from('firms').delete().eq('id', firm.id);
    }
    return { ok: false, error: `firm_members insert failed: ${memberErr.message}` };
  }

  return {
    ok: true,
    firmId: firm.id,
    firmName: firm.name,
    role,
    memberWritten: true,
  };
}
