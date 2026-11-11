// tests/firm-provisioning.test.ts
//
// Proves the cross-firm ownership hole is closed and cannot silently reopen.
//
// The bug: auth-bootstrap.ts resolved a brand-new user's firm as "the first
// firm by created_at" and wrote them in as `owner`. With one firm that is
// harmless. With more than one label on a deployment, the ONLY
// onboarding lever that exists is BOOTSTRAP_ALLOWED_DOMAINS — so the single
// action required to onboard label B (add their domain to the allowlist)
// handed label B's first user ownership of label A's firm, campaigns,
// creators and scraped contact emails.
//
// Four layers, because each catches a different regression:
//   1. parseTenancyConfig       — config parsing, including the malformed
//                                 entries that must drop rather than throw.
//   2. resolveBootstrapTarget   — the pure decision. Every branch, plus the
//                                 headline invariant: allowlisting a domain
//                                 NEVER yields access to an existing firm.
//   3. provisionFirmWithOwner   — against an in-memory Supabase fake. Proves
//                                 a firm is created with an owner, that a
//                                 failed member insert leaves NO orphan firm,
//                                 and that a retry joins instead of duplicating.
//   4. source invariants        — auth-bootstrap.ts no longer contains the
//                                 "first firm by created_at" pattern. This is
//                                 the guard against the exact drift that
//                                 caused the bug.
//
// Hermetic: no env, no network, no DB. The fake store is local to this file
// (same convention as tests/firm-scope.test.ts and tests/spend-caps.test.ts).
//
// Run: npx tsx tests/firm-provisioning.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  parseTenancyConfig,
  resolveBootstrapTarget,
  provisionFirmWithOwner,
  roleForNewMember,
  type TenancyConfig,
} from '../src/lib/firm-provisioning';
import { bootstrapMembershipByClerk } from '../src/lib/auth-bootstrap';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(msg);
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

const FIRM_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'; // the incumbent label
const FIRM_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // a second label

// ───────────────────────────────────────────────────────────────────────────
// 1. parseTenancyConfig
// ───────────────────────────────────────────────────────────────────────────
{
  const empty = parseTenancyConfig({});
  assert(empty.firmMap.size === 0, 'no env → empty firm map');

  const cfg = parseTenancyConfig({
    BOOTSTRAP_FIRM_MAP: `examplerecords.example=${FIRM_A}, Boss@LabelB.example =${FIRM_B}`,
    BOOTSTRAP_NEW_FIRM_MAP: 'newlabel.com=New Label Records',
  });
  assert(cfg.firmMap.get('examplerecords.example') === FIRM_A, 'domain entry parsed');
  assert(cfg.firmMap.get('boss@labelb.example') === FIRM_B, 'email entry lowercased + trimmed');
  assert(
    cfg.newFirmMap.get('newlabel.com') === 'New Label Records',
    'provision entry keeps display-name casing'
  );

  // Malformed entries drop rather than throw — a typo in one entry must not
  // take the whole sign-in path down, and dropping is the fail-closed
  // direction (fewer grants, not more).
  const messy = parseTenancyConfig({
    BOOTSTRAP_FIRM_MAP: `noequalssign,=orphanvalue,orphankey=,good.com=${FIRM_A}`,
  });
  assert(messy.firmMap.size === 1, 'malformed entries dropped, good one kept');
  assert(messy.firmMap.get('good.com') === FIRM_A, 'good entry survives bad neighbours');

  // A value containing '=' (not expected, but must not corrupt the key).
  const eq = parseTenancyConfig({ BOOTSTRAP_FIRM_MAP: 'a.com=x=y' });
  assert(eq.firmMap.get('a.com') === 'x=y', 'only the first = splits');
}

// ───────────────────────────────────────────────────────────────────────────
// 2. resolveBootstrapTarget — the pure decision
// ───────────────────────────────────────────────────────────────────────────
const UNCONFIGURED: TenancyConfig = parseTenancyConfig({});
const MAPPED: TenancyConfig = parseTenancyConfig({
  BOOTSTRAP_FIRM_MAP: `examplerecords.example=${FIRM_A}`,
  BOOTSTRAP_NEW_FIRM_MAP: 'labelb.example=Label B Records',
});

{
  // ── THE HEADLINE INVARIANT ────────────────────────────────────────────────
  // Label B's first user is allowlisted (their domain was added to
  // BOOTSTRAP_ALLOWED_DOMAINS, which is how you onboard them) but carries no
  // firm mapping. Before the fix this returned FIRM_A with role owner.
  const intruder = resolveBootstrapTarget({
    email: 'boss@labelb.example',
    allowlisted: true,
    config: UNCONFIGURED,
  });
  assert(intruder.kind === 'deny', 'allowlisted-but-unmapped → DENY, not the incumbent firm');
  assert(
    intruder.kind === 'deny' && intruder.reason === 'no_firm_mapping',
    `reason is no_firm_mapping (got ${intruder.kind === 'deny' ? intruder.reason : intruder.kind})`
  );
  assert(
    JSON.stringify(intruder).includes(FIRM_A) === false,
    'a denied resolution never even names the incumbent firm'
  );

  // Same person, now that someone has actually decided where they belong.
  const provisioned = resolveBootstrapTarget({
    email: 'boss@labelb.example',
    allowlisted: true,
    config: MAPPED,
  });
  assert(provisioned.kind === 'provision', 'mapped-for-provisioning → provision');
  assert(
    provisioned.kind === 'provision' && provisioned.firmName === 'Label B Records',
    'provision carries the configured firm name'
  );
  assert(
    provisioned.kind === 'provision' && provisioned.domain === 'labelb.example',
    'provision carries the domain'
  );

  // ── the incumbent keeps working, explicitly ──────────────────────────────
  const mapped = resolveBootstrapTarget({
    email: 'owner@examplerecords.example',
    allowlisted: true,
    config: MAPPED,
  });
  assert(mapped.kind === 'join', 'mapped domain → join');
  assert(mapped.kind === 'join' && mapped.firmId === FIRM_A, 'joins the firm it was mapped to');

  // A configured deployment has no fallback either: unmapped means denied.
  const mappedButUnlisted = resolveBootstrapTarget({
    email: 'someone@operator.example',
    allowlisted: true,
    config: MAPPED,
  });
  assert(mappedButUnlisted.kind === 'deny', 'configured deployment has no fallback');

  // ── exact-email beats domain ─────────────────────────────────────────────
  const both = parseTenancyConfig({
    BOOTSTRAP_FIRM_MAP: `shared.example=${FIRM_A},contractor@shared.example=${FIRM_B}`,
  });
  const byEmail = resolveBootstrapTarget({
    email: 'contractor@shared.example',
    allowlisted: true,
    config: both,
  });
  assert(
    byEmail.kind === 'join' && byEmail.firmId === FIRM_B,
    'exact-email mapping beats the domain mapping'
  );
  const byDomain = resolveBootstrapTarget({
    email: 'staff@shared.example',
    allowlisted: true,
    config: both,
  });
  assert(
    byDomain.kind === 'join' && byDomain.firmId === FIRM_A,
    'unlisted address at a mapped domain still joins the domain firm'
  );

  // ── denial precedes everything ───────────────────────────────────────────
  const notAllowed = resolveBootstrapTarget({
    email: 'owner@examplerecords.example',
    allowlisted: false,
    config: MAPPED,
  });
  assert(
    notAllowed.kind === 'deny' && notAllowed.reason === 'email_not_allowlisted',
    'not allowlisted denies even a mapped identity'
  );

  // ── junk input is a denial, never a match ────────────────────────────────
  for (const bad of [null, undefined, '', '   ', 'no-at-sign', 'trailing@']) {
    const v = resolveBootstrapTarget({
      email: bad,
      allowlisted: true,
      config: MAPPED,
    });
    assert(v.kind === 'deny', `junk email ${JSON.stringify(bad)} → deny`);
  }
  // Case + whitespace are normalized, not rejected.
  const messyCase = resolveBootstrapTarget({
    email: '  OWNER@ExampleRecords.EXAMPLE ',
    allowlisted: true,
    config: MAPPED,
  });
  assert(
    messyCase.kind === 'join' && messyCase.firmId === FIRM_A,
    'email is normalized before lookup'
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 3. roleForNewMember
// ───────────────────────────────────────────────────────────────────────────
{
  assert(roleForNewMember(0) === 'owner', 'first member of a firm is its owner');
  assert(roleForNewMember(1) === 'member', 'second member is NOT an owner');
  assert(roleForNewMember(9) === 'member', 'later members are members');
}

// ───────────────────────────────────────────────────────────────────────────
// 4. provisionFirmWithOwner — against an in-memory Supabase fake
// ───────────────────────────────────────────────────────────────────────────

interface FakeRow {
  id: string;
  name: string;
  primary_contact_email: string | null;
}

/**
 * Minimal stand-in for the subset of supabase-js this module touches:
 *   firms:        .select().like().limit()   .insert().select().single()   .delete().eq()
 *   firm_members: .insert()
 * `failMemberInsert` forces the compensating-delete path.
 */
function makeFake(
  opts: {
    failMemberInsert?: boolean;
    seed?: FakeRow[];
    /** Force countFirmMembers to be unreadable, exercising the fail-closed path. */
    countError?: boolean;
  } = {}
) {
  const firms: FakeRow[] = [...(opts.seed ?? [])];
  const members: Record<string, unknown>[] = [];
  let nextId = 1;

  const client = {
    from(table: string) {
      if (table === 'firms') {
        return {
          select() {
            return {
              like(_col: string, pattern: string) {
                const suffix = pattern.replace(/^%/, '');
                return {
                  limit() {
                    const hit = firms.filter((f) =>
                      (f.primary_contact_email ?? '').endsWith(suffix)
                    );
                    return Promise.resolve({ data: hit, error: null });
                  },
                };
              },
              // `.select('id, name').eq('id', x).limit(1).single()` — the
              // 'join' branch's existence check.
              eq(_col: string, value: string) {
                const hit = firms.find((f) => f.id === value) ?? null;
                return {
                  limit() {
                    return {
                      single() {
                        return Promise.resolve({
                          data: hit,
                          error: hit ? null : { message: 'no rows' },
                        });
                      },
                    };
                  },
                };
              },
            };
          },
          insert(row: Record<string, unknown>) {
            return {
              select() {
                return {
                  single() {
                    const created: FakeRow = {
                      id: `firm-${nextId++}`,
                      name: String(row.name),
                      primary_contact_email: (row.primary_contact_email as string) ?? null,
                    };
                    firms.push(created);
                    return Promise.resolve({ data: created, error: null });
                  },
                };
              },
            };
          },
          delete() {
            return {
              eq(_col: string, value: string) {
                const i = firms.findIndex((f) => f.id === value);
                if (i >= 0) firms.splice(i, 1);
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }
      // firm_members
      return {
        insert(row: Record<string, unknown>) {
          if (opts.failMemberInsert) {
            return Promise.resolve({ error: { message: 'duplicate key' } });
          }
          members.push(row);
          return Promise.resolve({ error: null });
        },
        select() {
          return {
            eq(col: string, value: string) {
              // Head-count form: countFirmMembers.
              if (col === 'firm_id') {
                if (opts.countError) {
                  return Promise.resolve({ count: null, error: { message: 'boom' } });
                }
                return Promise.resolve({
                  count: members.filter((m) => m.firm_id === value).length,
                  error: null,
                });
              }
              // Existing-membership probe: .eq('clerk_user_id'|'user_id').limit(1)
              return {
                limit() {
                  const hit = members.filter((m) => m[col] === value);
                  return Promise.resolve({ data: hit, error: null });
                },
              };
            },
          };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, firms, members };
}

async function runProvisioningTests() {
  // ── happy path: firm + its first owner ─────────────────────────────────
  {
    const fake = makeFake();
    const r = await provisionFirmWithOwner(fake.client, {
      firmName: 'Label B Records',
      domain: 'labelb.example',
      member: { clerkUserId: 'user_b1' },
    });
    assert(r.ok === true, 'provision succeeds');
    assert(fake.firms.length === 1, 'exactly one firm created');
    assert(fake.firms[0].name === 'Label B Records', 'firm carries the configured name');
    assert(fake.members.length === 1, 'exactly one member created');
    assert(fake.members[0].role === 'owner', 'the first member is the owner');
    assert(
      fake.members[0].firm_id === fake.firms[0].id,
      'the member is attached to the firm just created'
    );
    assert(
      fake.members[0].clerk_user_id === 'user_b1' && fake.members[0].user_id === null,
      'a Clerk member row carries a null user_id'
    );
  }

  // ── the compensating delete: NO ORPHAN FIRM ────────────────────────────
  // An ownerless firm is exactly the artefact the old "first firm by
  // created_at" query would have handed to the next person who signed in.
  {
    const fake = makeFake({ failMemberInsert: true });
    const r = await provisionFirmWithOwner(fake.client, {
      firmName: 'Doomed Records',
      domain: 'doomed.com',
      member: { clerkUserId: 'user_x' },
    });
    assert(r.ok === false, 'member-insert failure fails the whole provision');
    assert(fake.firms.length === 0, 'the firm row is rolled back — no ownerless firm survives');
    assert(fake.members.length === 0, 'no member row written');
    assert(
      (r.error ?? '').includes('firm_members insert failed'),
      `error names the failing step (got ${r.error})`
    );
  }

  // ── re-entrancy: a second user JOINS, and gets a membership row ────────
  //
  // REGRESSION (B1). This block previously asserted `members.length === 1`
  // after two users — i.e. it pinned the bug as correct. Nothing ever moves a
  // domain out of BOOTSTRAP_NEW_FIRM_MAP, so user 2, 3 and 4 at a new label
  // all resolve to `provision` and all land here. Returning ok:true without a
  // member row meant each of them was redirected to `/`, found no membership,
  // and was bounced to /sign-in with an error indistinguishable from an
  // allowlist rejection — permanently, since every retry took this branch.
  {
    const fake = makeFake();
    const first = await provisionFirmWithOwner(fake.client, {
      firmName: 'Label B Records',
      domain: 'labelb.example',
      member: { clerkUserId: 'user_b1' },
    });
    const second = await provisionFirmWithOwner(fake.client, {
      firmName: 'Label B Records',
      domain: 'labelb.example',
      member: { clerkUserId: 'user_b2' },
    });
    assert(second.ok === true, 'a second provision for the same domain succeeds');
    assert(fake.firms.length === 1, 'but creates NO second firm');
    assert(second.firmId === first.firmId, 'it resolves to the firm already made');
    assert(
      fake.members.length === 2,
      `THE B1 REGRESSION: the second user gets a membership row too (got ${fake.members.length})`
    );
    assert(
      second.memberWritten === true,
      'and the result says so, so the caller does not skip its own insert'
    );
    assert(fake.members[0].role === 'owner', 'first user is the owner');
    assert(
      fake.members[1].role === 'member',
      `second user is a member, not a second owner (got ${String(fake.members[1].role)})`
    );
    assert(
      fake.members[1].clerk_user_id === 'user_b2',
      'the second membership belongs to the second user'
    );
    assert(
      fake.members[1].firm_id === first.firmId,
      'and points at the same firm as the first'
    );
  }

  // ── crash recovery: an ownerless firm gets its owner on the next try ───
  //
  // The compensating delete only fires when the member insert RETURNS an
  // error. If the process dies between the two inserts, the firm survives
  // with no members. This path is the recovery, so it must heal rather than
  // observe the firm and return.
  {
    const fake = makeFake({
      seed: [
        {
          id: 'firm-orphan',
          name: 'Label B Records',
          primary_contact_email: 'owner@labelb.example',
        },
      ],
    });
    const r = await provisionFirmWithOwner(fake.client, {
      firmName: 'Label B Records',
      domain: 'labelb.example',
      member: { clerkUserId: 'user_b1' },
    });
    assert(r.ok === true, 'an ownerless firm is recoverable');
    assert(fake.firms.length === 1, 'no duplicate firm is minted during recovery');
    assert(fake.members.length === 1, 'the orphan firm gets a member row');
    assert(r.role === 'owner', 'and that member is its OWNER, since it had none');
  }

  // ── fail-closed: an unreadable member count denies ─────────────────────
  {
    const fake = makeFake({
      countError: true,
      seed: [
        {
          id: 'firm-existing',
          name: 'Label B Records',
          primary_contact_email: 'owner@labelb.example',
        },
      ],
    });
    const r = await provisionFirmWithOwner(fake.client, {
      firmName: 'Label B Records',
      domain: 'labelb.example',
      member: { clerkUserId: 'user_b2' },
    });
    assert(r.ok === false, 'an unreadable member count refuses the provision');
    assert(
      fake.members.length === 0,
      'and writes nothing — never defaults the count to 0 and hands out owner'
    );
  }

  // ── an existing firm is NEVER deleted by a failed member insert ────────
  // The compensating delete must not cascade away a live label's data
  // because one person's membership row failed.
  {
    const fake = makeFake({
      failMemberInsert: true,
      seed: [
        {
          id: 'firm-live',
          name: 'Label B Records',
          primary_contact_email: 'owner@labelb.example',
        },
      ],
    });
    const r = await provisionFirmWithOwner(fake.client, {
      firmName: 'Label B Records',
      domain: 'labelb.example',
      member: { clerkUserId: 'user_b9' },
    });
    assert(r.ok === false, 'the failed membership still fails the call');
    assert(
      fake.firms.length === 1,
      'but the PRE-EXISTING firm survives — compensating delete covers only what this call created'
    );
  }

  // ── a different domain is a different firm ─────────────────────────────
  {
    const fake = makeFake();
    await provisionFirmWithOwner(fake.client, {
      firmName: 'Label B',
      domain: 'labelb.example',
      member: { clerkUserId: 'b' },
    });
    await provisionFirmWithOwner(fake.client, {
      firmName: 'Label C',
      domain: 'labelc.example',
      member: { clerkUserId: 'c' },
    });
    assert(fake.firms.length === 2, 'distinct domains provision distinct firms');
    assert(
      fake.members[0].firm_id !== fake.members[1].firm_id,
      'their owners land in different firms'
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 4b. THE BOOTSTRAP SEAM — bootstrapMembershipByClerk end to end
//
// B1 lived precisely here: every unit below this seam passed, and nothing
// crossed it. These drive the real entry point against the fake, so the
// question they answer is the one that matters — "after this user signs in,
// is there a firm_members row for them?" That is what the middleware's
// membership check looks for, and its absence bounced them to /sign-in forever.
// ───────────────────────────────────────────────────────────────────────────

async function runBootstrapSeamTests() {
  // Every call below injects the in-memory fake as the client argument.

  const ENV_KEYS = [
    'BOOTSTRAP_FIRM_MAP',
    'BOOTSTRAP_NEW_FIRM_MAP',
    'BOOTSTRAP_ALLOWED_DOMAINS',
    'BOOTSTRAP_ALLOWED_EMAILS',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const restore = () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  };

  try {
    process.env.BOOTSTRAP_ALLOWED_DOMAINS = 'labelb.example';
    process.env.BOOTSTRAP_ALLOWED_EMAILS = '';
    process.env.BOOTSTRAP_NEW_FIRM_MAP = 'labelb.example=Label B Records';
    delete process.env.BOOTSTRAP_FIRM_MAP;

    const fake = makeFake();

    const u1 = await bootstrapMembershipByClerk('clerk_b1', 'owner@labelb.example', fake.client);
    assert(u1.ok === true, `label B user 1 bootstraps (err: ${u1.error})`);
    assert(fake.firms.length === 1, 'user 1 provisions the firm');
    assert(fake.members.length === 1, 'user 1 gets a membership row');
    assert(u1.role === 'owner', 'user 1 is the owner');

    // THE BUG: user 2 at the same label.
    const u2 = await bootstrapMembershipByClerk('clerk_b2', 'staff@labelb.example', fake.client);
    assert(u2.ok === true, `label B user 2 bootstraps (err: ${u2.error})`);
    assert(fake.firms.length === 1, 'user 2 does NOT mint a second firm');
    assert(
      fake.members.length === 2,
      `THE B1 REGRESSION AT THE SEAM: user 2 has a firm_members row (got ${fake.members.length})`
    );
    assert(
      fake.members.some((m) => m.clerk_user_id === 'clerk_b2'),
      'and it is keyed to user 2 — this is exactly what middleware probes for'
    );
    assert(u2.firm_id === u1.firm_id, 'both users land in the same firm');
    assert(u2.role === 'member', `user 2 is a member, not a second owner (got ${u2.role})`);

    // A third, to prove it is not an off-by-one that heals at 2.
    const u3 = await bootstrapMembershipByClerk('clerk_b3', 'sam@labelb.example', fake.client);
    assert(u3.ok === true, 'label B user 3 bootstraps');
    assert(fake.members.length === 3, 'user 3 gets a membership row too');

    // Re-signing an EXISTING member is idempotent, not a duplicate.
    const again = await bootstrapMembershipByClerk('clerk_b2', 'staff@labelb.example', fake.client);
    assert(again.ok === true && again.already_member === true, 'existing member short-circuits');
    assert(fake.members.length === 3, 'and writes no duplicate row');

    // A non-allowlisted outsider is still refused, and writes nothing.
    const outsider = await bootstrapMembershipByClerk(
      'clerk_x',
      'hacker@elsewhere.example',
      fake.client
    );
    assert(outsider.ok === false, 'a non-allowlisted email is refused at the seam');
    assert(fake.members.length === 3, 'and no membership row is written for them');
    assert(fake.firms.length === 1, 'and no firm is minted for them');

    // Allowlisted but unmapped: the headline invariant, at the seam.
    process.env.BOOTSTRAP_ALLOWED_DOMAINS = 'labelb.example,labelc.example';
    const unmapped = await bootstrapMembershipByClerk(
      'clerk_c1',
      'boss@labelc.example',
      fake.client
    );
    assert(unmapped.ok === false, 'allowlisted-but-unmapped is refused at the seam');
    assert(
      unmapped.error === 'no_firm_mapping',
      `with reason no_firm_mapping (got ${unmapped.error})`
    );
    assert(
      fake.members.length === 3,
      'and gets NO membership in the incumbent firm — the original hole, at the seam'
    );

    // Fail closed: with every bootstrap env var unset, a label address is
    // refused and nothing is written.
    for (const k of ENV_KEYS) delete process.env[k];
    const before = { firms: fake.firms.length, members: fake.members.length };
    const unset = await bootstrapMembershipByClerk('clerk_l1', 'owner@examplerecords.example', fake.client);
    assert(unset.ok === false, 'unset env: a label address is refused at the seam');
    const unsetOp = await bootstrapMembershipByClerk('clerk_o1', 'operator@operator.example', fake.client);
    assert(unsetOp.ok === false, 'unset env: an operator address is refused at the seam');
    assert(
      fake.firms.length === before.firms && fake.members.length === before.members,
      'unset env: no firm and no membership row is written'
    );
  } finally {
    restore();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 5. Source invariants — the drift guard
// ───────────────────────────────────────────────────────────────────────────
{
  const SRC = join(process.cwd(), 'src');
  const bootstrapSrc = readFileSync(join(SRC, 'lib', 'auth-bootstrap.ts'), 'utf8');

  // The exact shape of the bug: silently take the oldest firm — `.order(
  // 'created_at').limit(1).single()` — and write the caller in as its owner.
  assert(
    !/order\('created_at'/.test(bootstrapSrc),
    'auth-bootstrap never picks a firm by age'
  );
  assert(
    bootstrapSrc.includes('roleForNewMember'),
    'auth-bootstrap computes the role rather than hardcoding owner'
  );
  // Role is still literal in exactly one place — the provision branch, where
  // "first member of a brand-new firm" is true by construction.
  assert(
    (bootstrapSrc.match(/role: 'owner',/g) ?? []).length <= 1,
    'at most one literal owner role remains (the brand-new-firm branch)'
  );
  assert(
    bootstrapSrc.includes('resolveBootstrapTarget'),
    'auth-bootstrap routes firm resolution through the explicit resolver'
  );

  // The invariant is repo-wide, not file-wide: NO path may pick one firm out
  // of many by age. src/lib/auth.ts's dev bypass carried the identical shape
  // (NODE_ENV-gated, but it reads real data in any non-prod environment).
  const authSrc = readFileSync(join(SRC, 'lib', 'auth.ts'), 'utf8');
  assert(
    !/order\('created_at',\s*\{\s*ascending:\s*true\s*\}\)\s*\.limit\(1\)/.test(authSrc),
    'the dev bypass no longer silently picks the single oldest firm either'
  );
  assert(
    authSrc.includes('DEV_FIRM_ID'),
    'the dev bypass offers an explicit firm pin instead'
  );

  // The provisioning module must not grow a genre-style hardcoded default.
  const provSrc = readFileSync(join(SRC, 'lib', 'firm-provisioning.ts'), 'utf8');
  assert(
    !/order\('created_at'/.test(provSrc),
    'firm-provisioning never picks a firm by age either'
  );
  assert(
    provSrc.includes("await admin.from('firms').delete()") ||
      provSrc.includes("admin.from('firms').delete()"),
    'firm-provisioning keeps the compensating delete'
  );
}

async function main() {
  await runProvisioningTests();
  await runBootstrapSeamTests();
  if (failures.length > 0) console.error('\nFailures:\n - ' + failures.join('\n - '));
  console.log(`firm-provisioning test: ${passed}/${passed + failed} pass`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
