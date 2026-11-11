// tests/draft-channel.test.ts
//
// generateOutreachMessage used to default its channel to
// `contact_email ? 'email' : 'dm'`, and saveOutreachMessage persisted that value
// straight into outreach_messages.channel. 'dm' is not in migration 018's CHECK
// (email | instagram_dm | tiktok_dm | linkedin_dm), so every "Generate" click on
// /outreach for an email-less creator — ~95% of the pool — was an insert the
// database rejects. The same path also stamped no send_mode, so even a legal
// DM channel would never have reached the DM queue.
//
// These tests pin the fix end to end through the two real functions the
// /api/outreach/generate and /generate-bulk routes call: the persisted channel
// is derived from the LEAD (primary_channel, platform, contact_email) and always
// lands inside the constraint, and it travels with the send_mode that routes it.
//
// The CHECK list is read out of the migration file itself, so if the
// constraint ever changes this suite follows it instead of a copy.
//
// Hermetic: no network, no DB. Mock model provider + a hand-rolled fake
// Supabase query builder.
//
// Run: npx tsx tests/draft-channel.test.ts

process.env.MODEL_PROVIDER = 'mock';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { registerProvider } from '../src/lib/model-provider';
import { generateOutreachMessage, saveOutreachMessage } from '../src/lib/outreach';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

// ── The real constraint, parsed from the migration that created it ──────────
const MIGRATION_018 = readFileSync(
  join(__dirname, '../supabase/migrations/018_negotiation_foundation.sql'),
  'utf8',
);
const checkMatch = MIGRATION_018.match(
  /ADD CONSTRAINT outreach_messages_channel_check\s+CHECK \(channel IN \(([^)]*)\)\)/,
);
const CHECK_SET: string[] = checkMatch
  ? checkMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
  : [];
assert(
  CHECK_SET.length === 4 && CHECK_SET.includes('email') && !CHECK_SET.includes('dm'),
  `parsed migration 018's channel CHECK (got ${JSON.stringify(CHECK_SET)})`,
);

// ── Clean copy from the mock model, so no draft falls back for copy reasons ──
registerProvider('mock', async ({ system }) => {
  if (system.includes('creator-qualification analyst')) {
    return JSON.stringify({ qualified: true, account_type: 'creator', reason: 'ok', confidence: 0.9 });
  }
  if (system.includes('about_promoted_release')) {
    return JSON.stringify({ about_promoted_release: false, creator_is_author: true, confidence: 0.9 });
  }
  return JSON.stringify({
    subject: 'Ada Sample collab',
    body: 'Hi, I run promo for Ada Sample. Would you make one video with her new song? Happy to talk rates.',
  });
});

// ── Fake Supabase ───────────────────────────────────────────────────────────
interface Lead {
  primary_channel: string | null;
  platform: string;
  contact_email: string | null;
}

interface Inserted {
  table: string;
  row: Record<string, unknown>;
}

function fakeSb(lead: Lead, inserts: Inserted[]): SupabaseClient {
  const from = (table: string) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const b: any = {
      select: () => b,
      eq: () => b,
      in: () => b,
      neq: () => b,
      order: () => b,
      update: () => b,
      insert: (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return b;
      },
      single: async () => {
        if (table === 'campaign_influencers') {
          return {
            data: {
              id: 'ci-1',
              campaign_id: 'camp-1',
              composite_score: 80,
              tier: 'A',
              outreach_angle: '',
              price_estimate_mid: 200,
              qualification_status: 'qualified',
              qualification_reason: null,
              bot_flagged: false,
              primary_channel: lead.primary_channel,
              influencer: {
                id: 'inf-1',
                username: 'rowan_example',
                display_name: 'Rowan',
                platform: lead.platform,
                follower_count: 20000,
                engagement_rate: 0.05,
                bio: 'Guitar covers',
                contact_email: lead.contact_email,
                verified: false,
                blocklisted: false,
                raw_data: { posts: [] },
              },
            },
            error: null,
          };
        }
        if (table === 'campaigns') {
          return {
            data: {
              id: 'camp-1',
              firm_id: 'firm-1',
              artist_name: 'Ada Sample',
              track_name: 'Sample Single',
              release_date: '2027-01-01',
              artist_data: { genre: 'country' },
              budget: 5000,
              per_influencer_cap: 300,
              special_instructions: null,
            },
            error: null,
          };
        }
        if (table === 'firm_contexts') return { data: { voice_profile: 'plain' }, error: null };
        if (table === 'outreach_messages') return { data: { id: 'msg-1' }, error: null };
        return { data: null, error: null };
      },
      maybeSingle: async () => ({ data: null, error: null }),
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null, count: 0 }).then(ok, err),
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

type Requested = 'email' | 'dm' | 'comment' | undefined;

/** Generate + save exactly as /api/outreach/generate does; return the row. */
async function draftRow(lead: Lead, requested: Requested, messageType: 'initial' | 'follow_up' = 'initial') {
  const inserts: Inserted[] = [];
  const sb = fakeSb(lead, inserts);
  const message = await generateOutreachMessage({
    sb,
    campaign_influencer_id: 'ci-1',
    message_type: messageType,
    channel: requested,
  });
  await saveOutreachMessage(sb, 'ci-1', message, messageType);
  const row = inserts.find((i) => i.table === 'outreach_messages')?.row ?? {};
  return { message, row };
}

async function main() {
  // 1. The reported bug: an email-less TikTok creator, no channel requested.
  {
    const { message, row } = await draftRow(
      { primary_channel: null, platform: 'tiktok', contact_email: null },
      undefined,
    );
    assert(row.channel !== 'dm', `email-less creator: persisted channel is not 'dm' (got ${String(row.channel)})`);
    assert(row.channel === 'tiktok_dm', `email-less TikTok creator → tiktok_dm (got ${String(row.channel)})`);
    assert(message.channel === 'tiktok_dm', 'the returned message carries the same channel it persisted');
    assert(
      row.send_mode === 'human_queue' && row.needs_human === true,
      `a DM draft is stamped for the DM queue (send_mode=${String(row.send_mode)}, needs_human=${String(row.needs_human)})`,
    );
  }

  // 2. Discovery's explicit DM stamp on the lead wins over the platform.
  {
    const { row } = await draftRow(
      { primary_channel: 'instagram_dm', platform: 'tiktok', contact_email: null },
      undefined,
    );
    assert(row.channel === 'instagram_dm', `primary_channel instagram_dm → instagram_dm (got ${String(row.channel)})`);
  }

  // 3. Legacy primary_channel 'dm' (315 rows predate the split) resolves by platform.
  {
    const { row } = await draftRow(
      { primary_channel: 'dm', platform: 'instagram', contact_email: null },
      undefined,
    );
    assert(row.channel === 'instagram_dm', `legacy primary_channel 'dm' + instagram → instagram_dm (got ${String(row.channel)})`);
  }

  // 4. Email creators are unchanged: email, auto-sent path.
  {
    const { row } = await draftRow(
      { primary_channel: null, platform: 'tiktok', contact_email: 'rowan@example.com' },
      undefined,
    );
    assert(row.channel === 'email', `creator with an address → email (got ${String(row.channel)})`);
    assert(
      row.send_mode === 'auto_email' && row.needs_human === false,
      `email draft → auto_email (send_mode=${String(row.send_mode)})`,
    );
  }

  // 5. A caller asking for 'dm' gets the lead's DM channel, never the literal.
  {
    const { row } = await draftRow(
      { primary_channel: null, platform: 'tiktok', contact_email: 'rowan@example.com' },
      'dm',
    );
    assert(row.channel === 'tiktok_dm', `requested 'dm' → the lead's DM channel (got ${String(row.channel)})`);
  }

  // 6. An explicit 'email' request is still honoured.
  {
    const { row } = await draftRow(
      { primary_channel: 'tiktok_dm', platform: 'tiktok', contact_email: 'rowan@example.com' },
      'email',
    );
    assert(row.channel === 'email', `requested 'email' → email (got ${String(row.channel)})`);
  }

  // 7. The property: every lead shape × every requested value × both paths
  //    persists a channel the constraint accepts, with a send_mode.
  {
    const leads: Lead[] = [
      { primary_channel: null, platform: 'tiktok', contact_email: null },
      { primary_channel: null, platform: 'instagram', contact_email: null },
      { primary_channel: null, platform: 'youtube', contact_email: null },
      { primary_channel: 'dm', platform: 'tiktok', contact_email: null },
      { primary_channel: 'dm', platform: 'youtube', contact_email: null },
      { primary_channel: 'comment', platform: 'tiktok', contact_email: null },
      { primary_channel: 'instagram_dm', platform: 'tiktok', contact_email: 'a@b.example' },
      { primary_channel: 'email', platform: 'tiktok', contact_email: 'a@b.example' },
      { primary_channel: null, platform: 'tiktok', contact_email: 'a@b.example' },
    ];
    const requests: Requested[] = [undefined, 'email', 'dm', 'comment'];
    let illegal = 0;
    let unrouted = 0;
    const bad: string[] = [];
    for (const lead of leads) {
      for (const req of requests) {
        for (const mt of ['initial', 'follow_up'] as const) {
          const { row } = await draftRow(lead, req, mt);
          if (!CHECK_SET.includes(String(row.channel))) {
            illegal++;
            bad.push(`${JSON.stringify(lead)} req=${String(req)} ${mt} → ${String(row.channel)}`);
          }
          if (!row.send_mode) unrouted++;
        }
      }
    }
    assert(illegal === 0, `every persisted channel satisfies migration 018's CHECK (${illegal} illegal: ${bad.slice(0, 3).join(' | ')})`);
    assert(unrouted === 0, `every persisted draft carries a send_mode (${unrouted} with none)`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
