import './negotiation-harness/setup-env'; // FIRST — dummy env + fetch stub + paper mode + mock provider
//
// tests/greeting-dedupe.test.ts
//
// The exact-match form used for content dedupe stripped a leading greeting AND
// up to two words after it, so "Hey never mind, I can do the reel and story
// for $250" compared 'same' as "I can do the reel and story for $250", and a
// 'same' reply is DROPPED. The retraction never reached anyone. Now only the
// greeting word, plus a name the thread actually knows (creator handle, label,
// sender), and punctuation are stripped.
//
// Run: npx tsx tests/greeting-dedupe.test.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import { compareReplyForDedupe, canonicalReplyForDedupe, ingestInboundReply } from '../src/lib/ingest-inbound';
import { makeStore } from './negotiation-harness/store';

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

const BASE = 'I can do the reel and story for $250';

function pure() {
  // The proof's four pairs.
  const negations: Array<[string, string]> = [
    ['I am available for the reel at $300 this week', 'Hello not anymore: I am available for the reel at $300 this week'],
    [BASE, `Hey never mind, ${BASE}`],
    [BASE, `Yo no way. ${BASE}`],
  ];
  for (const [a, b] of negations) {
    assert(compareReplyForDedupe(a, b) !== 'same', `a negation after a greeting is never the same reply: "${b}"`);
    assert(compareReplyForDedupe(b, a) !== 'same', `…in either order: "${b}"`);
  }
  assert(
    compareReplyForDedupe('Sounds great, I can do the reel for $250', 'Sounds great, I can do the reel for $250!') === 'same',
    'a dropped "!" is still the same reply',
  );

  // More words that change meaning right after a greeting.
  for (const lead of ['Hi wait,', 'Hey actually no,', 'Hello sorry, scratch that.', 'Hey nope.', 'Hi forget it,', 'Hey cancel that,', 'Dear team, not anymore:']) {
    assert(compareReplyForDedupe(BASE, `${lead} ${BASE}`) !== 'same', `"${lead} …" is content, not a greeting`);
    assert(compareReplyForDedupe(BASE, `${lead} ${BASE}`, ['Owen', 'janecreates', 'Example Records']) !== 'same', `"${lead} …" with known names is still content`);
  }

  // What still strips: the greeting word, a KNOWN name, punctuation.
  assert(compareReplyForDedupe(BASE, `Hi, ${BASE}`) === 'same', 'a bare "Hi," is stripped');
  assert(compareReplyForDedupe(BASE, `Hey! ${BASE}`) === 'same', 'a bare "Hey!" is stripped');
  assert(compareReplyForDedupe(BASE, `Hi ${BASE}`) === 'same', 'a bare "Hi" with no punctuation is stripped');
  assert(compareReplyForDedupe(BASE, `Hi Owen, ${BASE}`, ['Owen']) === 'same', 'a greeting to a known sender name is stripped');
  assert(compareReplyForDedupe(BASE, `Hey @janecreates - ${BASE}`, ['janecreates']) === 'same', 'a greeting to the creator handle is stripped');
  assert(compareReplyForDedupe(BASE, `Hi Example Records, ${BASE}`, ['Example Records', 'Alex']) === 'same', 'a multi-word label name is stripped whole');
  assert(compareReplyForDedupe(BASE, `Hi Owen, ${BASE}`) !== 'same', 'an UNKNOWN name is not stripped (fail-safe: held or ingested, never dropped)');
  assert(compareReplyForDedupe(BASE, `Hi Owen never mind, ${BASE}`, ['Owen']) !== 'same', 'a known name followed by a negation is still content');
  assert(canonicalReplyForDedupe('His rate is $250 for the reel') === canonicalReplyForDedupe('His rate is $250 for the reel.'), '"His" is not the greeting "Hi"');
  assert(canonicalReplyForDedupe('His rate is $250 for the reel').startsWith('his '), '"His" is never cut to "s"');
}

/** End to end: a pasted retraction after a delivered reply is never dropped. */
async function throughIngest() {
  const store = makeStore();
  store.seed('firms', { id: 'firm-1', name: 'Example Records', sender_name: 'Owen Operator', outreach_prefs: {}, scraping_prefs: {} });
  store.seed('campaigns', { id: 'camp-1', firm_id: 'firm-1', total_budget_usd: 1_000_000 });
  store.seed('campaign_influencers', { id: 'ci-1', campaign_id: 'camp-1', influencer_id: 'inf-1', status: 'contacted' });
  store.seed('influencers', { id: 'inf-1', username: 'janecreates', blocklisted: false, contact_email: 'c@x' });
  const sb = store.sb as unknown as SupabaseClient;
  const at = Date.now() - 10 * 60_000;
  const send = (ext: string, body: string, t: number) =>
    ingestInboundReply(
      { channel: 'email', external_id: ext, from_identity: 'c@x', body, campaign_influencer_id: 'ci-1', received_at: new Date(t).toISOString() },
      sb,
    );
  await send('resend:first', BASE, at);
  const retraction = await send('manual:retraction', `Hey never mind, ${BASE}`, at + 60_000);
  assert(!retraction.deduped, `ingest: "Hey never mind, …" pasted after the delivered reply is NOT dropped (${JSON.stringify(retraction)})`);
  const rows = store.all('inbound_messages').filter((r) => r.campaign_influencer_id === 'ci-1');
  assert(rows.some((r) => String(r.body).startsWith('Hey never mind')), 'ingest: the retraction is on the thread');

  // The known sender's first name still makes a true repeat a duplicate.
  const repeat = await send('manual:repeat', `Hi Owen, ${BASE}`, at + 120_000);
  assert(repeat.deduped === true, `ingest: "Hi Owen, <same reply>" is still a duplicate (${JSON.stringify(repeat)})`);
}

(async () => {
  console.warn = () => {};
  pure();
  await throughIngest();
  console.log(`\ngreeting-dedupe: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
