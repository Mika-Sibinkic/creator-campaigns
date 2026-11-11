// src/lib/auth-bootstrap.ts
//
// Post-sign-in membership bootstrap for Clerk, called by /auth/clerk-bootstrap.
// Idempotent: an existing membership returns the existing row, no duplicate
// insert.
//
// SEC: every new sign-in is checked against an allowlist BEFORE we create
// a firm_members row. Allowlist sources (any match → allow):
//   1. BOOTSTRAP_ALLOWED_DOMAINS  (CSV, case-insensitive, e.g. "label-one.example,label-two.example")
//   2. BOOTSTRAP_ALLOWED_EMAILS   (CSV, case-insensitive exact match)
// With both unset (or empty) nobody can bootstrap: fail closed.
//
// SEC (tenancy): the allowlist decides WHETHER someone may in. It does not
// decide WHICH FIRM they land in — src/lib/firm-provisioning.ts does, from an
// explicit map. This used to be "the first firm by created_at, as owner",
// which meant adding label B's domain to BOOTSTRAP_ALLOWED_DOMAINS (the only
// onboarding lever there is) handed label B's first user ownership of label
// A's firm. Widening the allowlist can no longer widen firm access.
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from './supabase';
import {
  parseTenancyConfig,
  resolveBootstrapTarget,
  provisionFirmWithOwner,
  roleForNewMember,
  countFirmMembers,
  type BootstrapTarget,
} from './firm-provisioning';

export interface BootstrapResult {
  ok: boolean;
  already_member?: boolean;
  firm_id?: string;
  firm_name?: string;
  role?: string;
  error?: string;
  /** The normalized email a rejected bootstrap was evaluated against. */
  email?: string;
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** Returns true if `email` is allowed to bootstrap a firm_members row. */
export function isAllowlisted(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) return false;
  const domain = normalized.split('@')[1] ?? '';

  const domains = parseCsv(process.env.BOOTSTRAP_ALLOWED_DOMAINS);
  const emails = parseCsv(process.env.BOOTSTRAP_ALLOWED_EMAILS);

  if (emails.includes(normalized)) return true;
  if (domain && domains.includes(domain)) return true;
  return false;
}

/**
 * Turn a resolved target into a concrete `{ firmId, firmName, role }`, doing
 * the firm lookup / creation the target calls for.
 *
 * Fail-closed throughout: every path either returns a firm this email was
 * explicitly mapped to, or an error. Nothing here falls back to "whatever
 * firm happens to exist".
 */
async function materializeTarget(
  admin: SupabaseClient,
  target: BootstrapTarget,
  member: { clerkUserId?: string | null; userId?: string | null }
): Promise<
  | { ok: true; firmId: string; firmName: string; role: 'owner' | 'member'; created: boolean }
  | { ok: false; error: string }
> {
  if (target.kind === 'deny') {
    return { ok: false, error: target.reason };
  }

  if (target.kind === 'provision') {
    const provisioned = await provisionFirmWithOwner(admin, {
      firmName: target.firmName,
      domain: target.domain,
      member,
    });
    if (!provisioned.ok || !provisioned.firmId) {
      return { ok: false, error: provisioned.error ?? 'provision failed' };
    }
    return {
      ok: true,
      firmId: provisioned.firmId,
      firmName: provisioned.firmName ?? target.firmName,
      role: provisioned.role ?? 'owner',
      // Mirrors the MEMBER row, not the firm row. provisionFirmWithOwner
      // always writes one when it succeeds, so this is true — but read it
      // from the result rather than assuming, because assuming it is exactly
      // what stranded every user after the first at a new label.
      created: provisioned.memberWritten === true,
    };
  }

  // 'join' — an explicitly mapped firm id. Verify it exists rather than
  // trusting the env string; a typo'd uuid must deny, not create a dangling
  // membership row pointing at nothing.
  const { data: firm, error } = await admin
    .from('firms')
    .select('id, name')
    .eq('id', target.firmId)
    .limit(1)
    .single();
  if (error || !firm) {
    return { ok: false, error: `mapped firm not found: ${target.firmId}` };
  }
  const f = firm as { id: string; name: string };
  const joinCount = await countFirmMembers(admin, f.id);
  if (joinCount === null) {
    return { ok: false, error: 'member count unreadable' };
  }
  return {
    ok: true,
    firmId: f.id,
    firmName: f.name,
    role: roleForNewMember(joinCount),
    created: false,
  };
}

/** Resolve the bootstrap target for an email from live env. */
function targetFor(email: string): BootstrapTarget {
  return resolveBootstrapTarget({
    email,
    allowlisted: isAllowlisted(email),
    config: parseTenancyConfig(process.env),
  });
}

/**
 * Clerk-keyed bootstrap. Idempotent on `clerk_user_id`. Allowlist-gated on the
 * Clerk user's sessionEmail(), then firm-resolved from the explicit tenancy map.
 * A Clerk member row carries a null `user_id` (no Supabase auth.users row).
 */
export async function bootstrapMembershipByClerk(
  clerkUserId: string,
  email: string | null | undefined,
  /** Injectable for tests. Production callers omit it and get service-role.
   *  Same shape as authorize-payment.ts's hooks seam — this is the one seam
   *  none of the original assertions crossed, which is where B1 hid. */
  client?: SupabaseClient
): Promise<BootstrapResult> {
  if (!clerkUserId) return { ok: false, error: 'invalid clerk user id' };
  const admin = client ?? supabaseAdmin();

  const { data: existing } = await admin
    .from('firm_members')
    .select('id, firm_id, role')
    .eq('clerk_user_id', clerkUserId)
    .limit(1);
  if (existing && existing.length > 0) {
    const e = existing[0] as { id: string; firm_id: string; role: string };
    return { ok: true, already_member: true, firm_id: e.firm_id, role: e.role };
  }

  const normalized = (email ?? '').trim().toLowerCase();
  const target = targetFor(normalized);
  if (target.kind === 'deny') {
    return { ok: false, error: target.reason, email: normalized };
  }

  const resolved = await materializeTarget(admin, target, {
    clerkUserId,
    userId: null,
  });
  if (!resolved.ok) return { ok: false, error: resolved.error, email: normalized };

  // A provisioned firm already has its owner row written atomically-ish by
  // provisionFirmWithOwner; writing again would violate the partial-unique
  // index on clerk_user_id.
  if (!resolved.created) {
    const { error: insErr } = await admin.from('firm_members').insert({
      firm_id: resolved.firmId,
      clerk_user_id: clerkUserId,
      user_id: null,
      role: resolved.role,
    } as never);
    if (insErr) {
      return { ok: false, error: `firm_members insert failed: ${insErr.message}` };
    }
  }
  return {
    ok: true,
    firm_id: resolved.firmId,
    firm_name: resolved.firmName,
    role: resolved.role,
  };
}
