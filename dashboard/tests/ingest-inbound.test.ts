// tests/ingest-inbound.test.ts
//
// Unit test for src/lib/ingest-inbound.ts. A minimal chainable Supabase mock
// records the insert/update payloads so we can assert the normalized → row
// mapping without a database. Covers: matched-CI dual write + CI advancement,
// received_at (ghoster backdating) passthrough, dedupe short-circuit, and the
// unmatched (no campaign_influencer) queue-only path.
//
// Run: npx tsx tests/ingest-inbound.test.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import { ingestInboundReply, type NormalizedInbound } from '../src/lib/ingest-inbound';

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

function need<T>(v: T | undefined, message: string): T {
  if (v === undefined) {
    console.error(`  ✗ FAIL (missing): ${message}`);
    process.exit(1);
  }
  return v;
}

interface Recorded {
  inbound_messages_insert?: Record<string, unknown>;
  outreach_messages_insert?: Record<string, unknown>;
  campaign_influencers_update?: Record<string, unknown>;
}

// Builds a Supabase-client-shaped mock supporting exactly the call chains
// ingestInboundReply (and the channel-priors helpers it calls) use:
//   from('inbound_messages').select().eq().eq().maybeSingle()  → dedupe probe
//   from(t).select(cols).eq('id', v).maybeSingle()             → first-reply /
//       firm-id / priors lookups — ONE eq, then maybeSingle
//   from(t).insert(row).select('id').single()                  → inbound/outreach inserts
//   from(t).insert(row)                                        → priors insert, no .select()
//   from(t).update(patch).eq('id', v)                          → CI advancement
//
// The eq() chain is RECURSIVE on purpose: eq() returns a node exposing BOTH
// eq() and maybeSingle(), so one- and two-eq chains both terminate. The
// original mock only exposed maybeSingle() after the SECOND eq, so the
// single-eq first-reply probe in ingest-inbound.ts blew up with
// "maybeSingle is not a function" and the whole suite died before asserting
// anything — which is why it was never registered.
//
// Only the dedupe probe against inbound_messages resolves to `existing`; every
// other maybeSingle() resolves to null, which keeps the priors side-path inert
// (it is wrapped in its own try/catch and never throws into the caller).
function makeMock(opts: { existing?: { id: string; status: string } | null }): {
  sb: SupabaseClient;
  rec: Recorded;
} {
  const rec: Recorded = {};
  const existing = opts.existing ?? null;
  let idCounter = 0;

  const api = {
    from(table: string) {
      const eqNode = () => {
        const node: Record<string, unknown> = {
          eq: () => eqNode(),
          async maybeSingle() {
            return {
              data: table === 'inbound_messages' ? existing : null,
              error: null,
            };
          },
        };
        return node;
      };
      return {
        select() {
          return { eq: () => eqNode() };
        },
        insert(row: Record<string, unknown>) {
          if (table === 'inbound_messages') rec.inbound_messages_insert = row;
          if (table === 'outreach_messages') rec.outreach_messages_insert = row;
          return {
            select() {
              return {
                async single() {
                  idCounter += 1;
                  return { data: { id: `${table}-${idCounter}` }, error: null };
                },
              };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          if (table === 'campaign_influencers') rec.campaign_influencers_update = patch;
          return {
            async eq() {
              return { data: null, error: null };
            },
          };
        },
      };
    },
  };

  return { sb: api as unknown as SupabaseClient, rec };
}

async function main() {
  const RECEIVED_AT = '2026-07-01T00:00:00.000Z';
  const base: NormalizedInbound = {
    channel: 'email',
    external_id: 'sim:abc',
    from_identity: 'simulator:spot_on_yes',
    body: "yes I'm in, send the track and I'll line up a post",
    campaign_influencer_id: 'ci-1',
    received_at: RECEIVED_AT,
  };

  // ── Case 1: matched CI → writes both tables, advances CI, correct mapping ──
  {
    const { sb, rec } = makeMock({ existing: null });
    const r = await ingestInboundReply(base, sb);

    assert(r.deduped === false, 'case1: not deduped');
    assert(r.inbound_message_id === 'inbound_messages-1', 'case1: inbound_messages id returned');
    assert(r.outreach_message_id === 'outreach_messages-2', 'case1: outreach_messages id returned');
    assert(r.status === 'classified', 'case1: status classified');
    assert(r.campaign_influencer_advanced === true, 'case1: CI advanced');
    assert(r.classification === 'interested', 'case1: classified interested');
    assert(typeof r.confidence === 'number' && r.confidence > 0, 'case1: confidence numeric');

    // inbound_messages row mapping
    const im = need(rec.inbound_messages_insert, 'inbound_messages insert recorded');
    assert(im.channel === 'email', 'case1: im.channel = email');
    assert(im.external_id === 'sim:abc', 'case1: im.external_id passthrough');
    assert(im.from_identity === 'simulator:spot_on_yes', 'case1: im.from_identity passthrough');
    assert(im.body === base.body, 'case1: im.body passthrough');
    assert(im.campaign_influencer_id === 'ci-1', 'case1: im.campaign_influencer_id passthrough');
    assert(im.received_at === RECEIVED_AT, 'case1: im.received_at passthrough (backdating preserved)');
    assert(im.status === 'classified', 'case1: im.status classified');
    const imClass = im.classification as { classification?: string; confidence?: number };
    assert(imClass?.classification === 'interested', 'case1: im.classification embeds verdict');
    assert(typeof imClass?.confidence === 'number', 'case1: im.classification embeds confidence');

    // outreach_messages inbound row mapping (behavior-preserving)
    const om = need(rec.outreach_messages_insert, 'outreach_messages insert recorded');
    assert(om.campaign_influencer_id === 'ci-1', 'case1: om.campaign_influencer_id');
    assert(om.message_type === 'response', 'case1: om.message_type = response');
    assert(om.direction === 'inbound', 'case1: om.direction = inbound');
    assert(om.channel === 'email', 'case1: om.channel = email');
    assert(om.body === base.body, 'case1: om.body passthrough');
    assert(om.classification === 'interested', 'case1: om.classification');
    assert(typeof om.classification_confidence === 'number', 'case1: om.classification_confidence');
    assert(om.sent_at === RECEIVED_AT, 'case1: om.sent_at = received_at (ghoster backdating preserved)');

    // campaign_influencers advancement mapping
    const ci = need(rec.campaign_influencers_update, 'campaign_influencers update recorded');
    assert(ci.response_classification === 'interested', 'case1: ci.response_classification');
    assert(ci.outreach_status === 'responded', 'case1: ci.outreach_status = responded');
    assert(ci.status === 'responded', 'case1: ci.status mapped via classificationToStatus');
    assert(ci.last_response_at === RECEIVED_AT, 'case1: ci.last_response_at = received_at');
  }

  // ── Case 2: decline maps outreach_status to rejected ──
  {
    const { sb, rec } = makeMock({ existing: null });
    await ingestInboundReply(
      { ...base, external_id: 'sim:decline', body: 'not interested, no thanks — please pass' },
      sb,
    );
    const om = need(rec.outreach_messages_insert, 'case2: outreach insert recorded');
    assert(om.classification === 'not_interested', 'case2: classified not_interested');
    const ci = need(rec.campaign_influencers_update, 'case2: CI update recorded');
    assert(ci.outreach_status === 'rejected', 'case2: decline → outreach_status rejected');
  }

  // ── Case 3: dedupe short-circuit (existing row) ──
  {
    const { sb, rec } = makeMock({ existing: { id: 'dup-1', status: 'classified' } });
    const r = await ingestInboundReply(base, sb);
    assert(r.deduped === true, 'case3: deduped true');
    assert(r.inbound_message_id === 'dup-1', 'case3: returns existing inbound id');
    assert(r.outreach_message_id === null, 'case3: no new outreach row');
    assert(r.campaign_influencer_advanced === false, 'case3: no CI advancement on dedupe');
    assert(rec.inbound_messages_insert === undefined, 'case3: no inbound insert on dedupe');
    assert(rec.outreach_messages_insert === undefined, 'case3: no outreach insert on dedupe');
  }

  // ── Case 4: unmatched (no campaign_influencer) → queue-only ──
  {
    const { sb, rec } = makeMock({ existing: null });
    const r = await ingestInboundReply({ ...base, campaign_influencer_id: null }, sb);
    assert(r.inbound_message_id === 'inbound_messages-1', 'case4: inbound row still written');
    assert(r.outreach_message_id === null, 'case4: no outreach row when unmatched');
    assert(r.campaign_influencer_advanced === false, 'case4: CI not advanced when unmatched');
    assert(rec.outreach_messages_insert === undefined, 'case4: no outreach insert when unmatched');
    assert(rec.campaign_influencers_update === undefined, 'case4: no CI update when unmatched');
    const im = need(rec.inbound_messages_insert, 'case4: inbound insert recorded');
    assert(im.campaign_influencer_id === null, 'case4: im.campaign_influencer_id is null');
  }

  // ── Case 5: received_at omitted → ingest supplies an ISO timestamp ──
  {
    const { sb, rec } = makeMock({ existing: null });
    await ingestInboundReply(
      {
        channel: 'email',
        external_id: 'sim:nots',
        from_identity: 'x',
        body: 'yes definitely interested',
        campaign_influencer_id: 'ci-9',
      },
      sb,
    );
    const im = need(rec.inbound_messages_insert, 'case5: inbound insert recorded');
    assert(
      typeof im.received_at === 'string' && !Number.isNaN(Date.parse(im.received_at as string)),
      'case5: received_at defaulted to a valid ISO timestamp',
    );
  }

  console.log(`ingest-inbound test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
