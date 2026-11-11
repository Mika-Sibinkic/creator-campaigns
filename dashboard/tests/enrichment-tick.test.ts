// tests/enrichment-tick.test.ts
//
// Pins the contact-enrichment tick and the outreach channel resolver — the two
// pieces of logic standing between "we scraped 340 creators" and "we can
// actually reach any of them".
//
// What it guards, specifically:
//   - the LLM gate. Running a model over every bio costs ~$0.10/campaign for
//     zero yield on a pool where 0 of 340 bios use obfuscated addresses.
//   - never clobbering a contact we already have.
//   - the exhaustion counter, so a bio that will never yield stops being paid
//     for on every tick, forever.
//   - resolveOutreachChannel, which decides whether a draft claims a channel it
//     can actually be sent on. The bug it replaces: draft-all hardcoded
//     channel:'email' for a pool that is ~95% email-less, and stamped no
//     send_mode — so the DM queue (it filters send_mode === 'human_queue') has
//     never held a single row.
//
// Hermetic: an in-memory Supabase double, no network, no DB, no model.
//
// Run: npx tsx tests/enrichment-tick.test.ts

export {};

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

interface FakeRow {
  id: string;
  username: string | null;
  platform: string | null;
  bio: string | null;
  raw_data: Record<string, unknown> | null;
  contact_email: string | null;
  contact_scan_attempts: number;
  contact_scanned_at: string | null;
  synthetic: boolean;
}

/**
 * Minimal Supabase double. Supports exactly the call shapes the tick uses:
 * a filtered ordered select on `influencers`, an update by id (optionally with
 * `.is('contact_email', null)`), and swallows the creator_contacts persistence
 * discoverContacts does.
 */
function makeFakeSupabase(rows: FakeRow[]) {
  const updates: Array<{ id: string; patch: Record<string, unknown>; guarded: boolean }> = [];

  function from(table: string) {
    if (table !== 'influencers') {
      // creator_contacts / channel_conversion_priors — accept and discard.
      const sink: Record<string, unknown> = {};
      const chain = new Proxy(sink, {
        get() {
          return () => chainThen;
        },
      });
      const chainThen = Object.assign(Promise.resolve({ data: [], error: null }), chain);
      return chainThen as never;
    }

    let filtered = rows.slice();
    let mode: 'select' | 'update' = 'select';
    let patch: Record<string, unknown> = {};
    let guarded = false;
    let targetId: string | null = null;

    const api: Record<string, unknown> = {
      select() {
        mode = 'select';
        return api;
      },
      update(p: Record<string, unknown>) {
        mode = 'update';
        patch = p;
        return api;
      },
      is(col: string, val: unknown) {
        if (mode === 'update' && col === 'contact_email' && val === null) guarded = true;
        else filtered = filtered.filter((r) => (r as never as Record<string, unknown>)[col] == null);
        return api;
      },
      eq(col: string, val: unknown) {
        if (mode === 'update' && col === 'id') targetId = String(val);
        else filtered = filtered.filter((r) => (r as never as Record<string, unknown>)[col] === val);
        return api;
      },
      lt(col: string, val: number) {
        filtered = filtered.filter(
          (r) => Number((r as never as Record<string, unknown>)[col] ?? 0) < val,
        );
        return api;
      },
      order() {
        return api;
      },
      limit(n: number) {
        filtered = filtered.slice(0, n);
        return Promise.resolve({ data: filtered, error: null });
      },
      then(resolve: (v: { data: unknown; error: null }) => unknown) {
        if (mode === 'update' && targetId) {
          const row = rows.find((r) => r.id === targetId);
          const blocked = guarded && row?.contact_email != null;
          if (row && !blocked) Object.assign(row, patch);
          updates.push({ id: targetId, patch, guarded });
        }
        return Promise.resolve(resolve({ data: null, error: null }));
      },
    };
    return api as never;
  }

  return { client: { from } as never, updates };
}

function row(over: Partial<FakeRow> = {}): FakeRow {
  return {
    id: over.id ?? 'inf-1',
    username: over.username ?? 'creator',
    platform: over.platform ?? 'tiktok',
    bio: over.bio ?? '',
    raw_data: over.raw_data ?? null,
    contact_email: over.contact_email ?? null,
    contact_scan_attempts: over.contact_scan_attempts ?? 0,
    contact_scanned_at: over.contact_scanned_at ?? null,
    synthetic: over.synthetic ?? false,
  };
}

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:9';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-dummy';

  const { hasContactIntent, runEnrichmentTick, CONTACT_SCAN_MAX_ATTEMPTS } = await import(
    '../src/lib/enrichment-tick'
  );
  const { resolveOutreachChannel, resolveSendPlan } = await import('../src/lib/social-dispatch');

  // ── 1. The LLM gate ───────────────────────────────────────────────────────
  assert(hasContactIntent('booking: hi (at) me dot com'), 'obfuscated address shows intent');
  assert(hasContactIntent('business inquiries below'), '"business inquiries" shows intent');
  assert(hasContactIntent('mgmt/manager: someone'), '"manager" shows intent');
  assert(hasContactIntent('collab? DM me'), '"collab" shows intent');
  assert(!hasContactIntent('just vibes ✨ 21 | austin'), 'a plain bio shows no intent');
  assert(!hasContactIntent(''), 'an empty bio shows no intent');
  assert(!hasContactIntent(null), 'a null bio shows no intent');

  // ── 2. A found address is written, and the attempt counter resets ─────────
  {
    const rows = [row({ id: 'a', bio: 'bookings: real@label.test' })];
    const { client, updates } = makeFakeSupabase(rows);
    const tally = await runEnrichmentTick(client, { batchSize: 10 });
    assert(tally.scanned === 1, 'scanned the one candidate');
    assert(tally.emails_found === 1, 'found the address in the bio');
    assert(rows[0].contact_email === 'real@label.test', 'wrote the address onto the creator');
    assert(rows[0].contact_scan_attempts === 0, 'a hit resets the attempt counter');
    assert(
      updates.every((u) => u.id !== 'a' || u.guarded),
      'the write is guarded on contact_email IS NULL so it can never clobber',
    );
  }

  // ── 3. A miss increments, and eventually exhausts ─────────────────────────
  {
    const rows = [row({ id: 'b', bio: 'just vibes', contact_scan_attempts: 0 })];
    const { client } = makeFakeSupabase(rows);
    const t1 = await runEnrichmentTick(client, { batchSize: 10 });
    assert(t1.emails_found === 0, 'a bio with no address yields nothing');
    assert(rows[0].contact_scan_attempts === 1, 'a miss increments the attempt counter');
    assert(t1.llm_calls === 0, 'no model call on a bio with no contact intent — the cost gate');

    rows[0].contact_scan_attempts = CONTACT_SCAN_MAX_ATTEMPTS - 1;
    const t2 = await runEnrichmentTick(client, { batchSize: 10 });
    assert(t2.exhausted === 1, 'the final miss marks the creator exhausted');
    assert(
      rows[0].contact_scan_attempts === CONTACT_SCAN_MAX_ATTEMPTS,
      'attempts stop at the ceiling',
    );
  }

  // ── 4. Exhausted and already-contacted creators are not selected ──────────
  {
    const rows = [
      row({ id: 'c', bio: 'x', contact_scan_attempts: CONTACT_SCAN_MAX_ATTEMPTS }),
      row({ id: 'd', bio: 'y', contact_email: 'already@known.test' }),
      row({ id: 'e', bio: 'z', synthetic: true }),
    ];
    const { client } = makeFakeSupabase(rows);
    const tally = await runEnrichmentTick(client, { batchSize: 10 });
    assert(tally.scanned === 0, 'exhausted, already-contacted and synthetic creators are skipped');
  }

  // ── 5. An empty pool is one query and no writes ───────────────────────────
  {
    const { client, updates } = makeFakeSupabase([]);
    const tally = await runEnrichmentTick(client, { batchSize: 10 });
    assert(tally.scanned === 0 && updates.length === 0, 'an exhausted pool costs nothing');
  }

  // ── 6. resolveOutreachChannel ─────────────────────────────────────────────
  assert(
    resolveOutreachChannel({
      primaryChannel: 'instagram_dm',
      platform: 'instagram',
      contactEmail: 'has@mail.test',
    }) === 'instagram_dm',
    'an explicit DM channel wins even when an address exists',
  );
  assert(
    resolveOutreachChannel({ primaryChannel: null, platform: 'tiktok', contactEmail: 'a@b.test' }) ===
      'email',
    'with an address and no stamped channel, email',
  );
  // The bug this replaces: with no address, the old code still said 'email'.
  assert(
    resolveOutreachChannel({ primaryChannel: null, platform: 'tiktok', contactEmail: null }) ===
      'tiktok_dm',
    'no address falls back to the platform DM rather than claiming email',
  );
  assert(
    resolveOutreachChannel({ primaryChannel: null, platform: 'instagram', contactEmail: null }) ===
      'instagram_dm',
    'same for Instagram',
  );
  // Legacy rows carry the pre-split value. sendModeFor() in
  // negotiation-tick does not handle it and silently falls through to email.
  assert(
    resolveOutreachChannel({ primaryChannel: 'dm', platform: 'tiktok', contactEmail: null }) ===
      'tiktok_dm',
    "the legacy 'dm' channel resolves from the platform",
  );
  assert(
    resolveOutreachChannel({ primaryChannel: 'dm', platform: 'instagram', contactEmail: null }) ===
      'instagram_dm',
    "legacy 'dm' on Instagram too",
  );

  // ── 7. The channel a draft gets decides whether it reaches the DM queue ───
  assert(resolveSendPlan('email').mode === 'auto_email', 'email drafts send themselves');
  assert(
    resolveSendPlan('tiktok_dm').mode === 'human_queue',
    'a DM draft lands in the human queue — the queue that had zero rows because nothing was ever stamped for it',
  );
  assert(resolveSendPlan('tiktok_dm').needs_human, 'and it is flagged as needing a human');

  console.log(`enrichment-tick test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
