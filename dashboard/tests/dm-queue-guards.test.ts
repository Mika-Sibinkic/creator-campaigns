// tests/dm-queue-guards.test.ts
//
// Pins the DM queue's refusal rules — src/app/outreach/dm-queue-guards.ts, the
// predicate shared by the "Mark sent" button and the route that honours it
// (src/app/api/outreach/messages/[id]/route.ts, the `mark_sent` branch).
//
// Why this is worth a suite of its own: `mark_sent` on a human_queue row is not
// a display flag. Through channel-priors.markHumanQueueSent it stamps sent_at,
// advances campaign_influencers to 'contacted', writes a social_send_events
// row, bumps the 'sent' channel prior, and opens a PRICED negotiable offer that
// the auto-negotiator immediately owns. markHumanQueueSent checks none of it —
// its contract says the caller owns the already-sent check. And there is no
// unsend path anywhere in this repo: nothing ever sets sent_at back to null.
//
// So every case below is a one-way door. The traps:
//   * dropping `status` from the route's SELECT again — that is the original
//     defect, and it silently resurrected window_closed rows for a human to
//     send by hand, the exact outcome the campaign window exists to prevent;
//   * treating a quiet-hours `send_after` as decoration, which sends a DM
//     deliberately held until 9am at 11pm tonight;
//   * keying the profile link off influencers.platform while the row is
//     addressed to a different network. A creator with
//     platform='tiktok' can still have a campaign_influencers row carrying
//     primary_channel='instagram_dm', for which NO Instagram handle exists in
//     any table. Those rows are unsendable, not "link to TikTok instead".
//
// Hermetic: pure functions, injected clock, no DB, no network, no env.
//
// Run: npx tsx tests/dm-queue-guards.test.ts

import {
  compareDmQueueOrder,
  dmMarkSentRefusal,
  parseSendAfter,
  resolveDmTarget,
  toDmChannel,
  DM_REFUSAL_HTTP_STATUS,
  type DmQueueOrderKey,
} from '../src/app/outreach/dm-queue-guards';

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

const NOW = Date.parse('2026-09-23T23:40:00.000Z');
const IN_AN_HOUR = new Date(NOW + 3_600_000).toISOString();
const AN_HOUR_AGO = new Date(NOW - 3_600_000).toISOString();

function main() {
  // ── 1. A clean draft is sendable ──────────────────────────────────────────
  assert(dmMarkSentRefusal({}, NOW) === null, 'an empty row (no status, no schedule) is sendable');
  assert(
    dmMarkSentRefusal({ status: null, sent_at: null, send_after: null }, NOW) === null,
    'explicit nulls are sendable — status defaults predate most writers',
  );
  assert(dmMarkSentRefusal({ status: 'draft' }, NOW) === null, "status 'draft' is sendable");
  assert(dmMarkSentRefusal({ status: 'queued' }, NOW) === null, "status 'queued' is sendable");

  // ── 2. Already sent — idempotency, and the double-click ───────────────────
  const sent = dmMarkSentRefusal({ status: 'draft', sent_at: AN_HOUR_AGO }, NOW);
  assert(sent?.kind === 'already_sent', 'a row with sent_at is refused');
  assert(
    sent?.error === 'already sent',
    "the already-sent error string stays 'already sent' — the client and the email send route both key on it",
  );

  // ── 3. window_closed. THE defect this module exists for ───────────────────
  const closed = dmMarkSentRefusal({ status: 'window_closed' }, NOW);
  assert(closed?.kind === 'window_closed', 'a window_closed row is refused');
  assert(
    closed?.error === 'window_closed',
    "the error code matches the email send route's 'window_closed', so one client handles both",
  );
  assert(
    (closed?.message ?? '').toLowerCase().includes('window'),
    'the window_closed refusal explains itself in words, not as a raw column value',
  );
  assert(
    !(closed?.message ?? '').includes('window_closed'),
    'the refusal never renders the raw status token at a human',
  );

  // ── 4. The other terminal states ──────────────────────────────────────────
  const failedRow = dmMarkSentRefusal({ status: 'failed' }, NOW);
  assert(failedRow?.kind === 'terminal', "status 'failed' is refused — the email route's window-only guard misses it");
  assert(
    (failedRow?.message ?? '').includes('failed'),
    'the terminal refusal names the state in label form',
  );
  assert(
    dmMarkSentRefusal({ status: 'sent', sent_at: null }, NOW)?.kind === 'terminal',
    "status 'sent' with a null sent_at is still refused — an inconsistent row is not an invitation",
  );

  // ── 5. send_after: a DM deliberately held out of quiet hours ──────────────
  const held = dmMarkSentRefusal({ status: 'queued', send_after: IN_AN_HOUR }, NOW);
  assert(held?.kind === 'held', 'a future send_after is refused');
  assert(held?.error === 'held', "the held error code is 'held'");
  assert(
    held?.send_after === new Date(Date.parse(IN_AN_HOUR)).toISOString(),
    'the refusal echoes the exact instant the row unlocks, so the UI can show it',
  );
  assert(
    dmMarkSentRefusal({ status: 'queued', send_after: AN_HOUR_AGO }, NOW) === null,
    'a send_after in the past does not block — the hold has expired',
  );
  assert(
    dmMarkSentRefusal({ status: 'queued', send_after: new Date(NOW).toISOString() }, NOW) === null,
    'send_after exactly now does not block (strictly greater, so the hold cannot stick)',
  );
  assert(
    dmMarkSentRefusal({ status: 'queued', send_after: 'not a date' }, NOW) === null,
    'an unparseable send_after does not block a legitimate send',
  );
  assert(
    dmMarkSentRefusal({ status: 'queued', send_after: '' }, NOW) === null,
    'an empty send_after does not block',
  );

  // ── 6. Precedence — the worst thing about the row wins ────────────────────
  assert(
    dmMarkSentRefusal({ status: 'window_closed', sent_at: AN_HOUR_AGO }, NOW)?.kind === 'already_sent',
    'sent_at is reported before the window, because it is the common double-click',
  );
  assert(
    dmMarkSentRefusal({ status: 'window_closed', send_after: IN_AN_HOUR }, NOW)?.kind === 'window_closed',
    'a terminal status outranks a schedule — "later" would imply it could ever send',
  );
  assert(
    dmMarkSentRefusal({ status: 'failed', send_after: IN_AN_HOUR }, NOW)?.kind === 'terminal',
    'failed outranks a schedule too',
  );

  // ── 7. Every refusal is presentable and returnable ────────────────────────
  const allRefusals = [
    dmMarkSentRefusal({ sent_at: AN_HOUR_AGO }, NOW),
    dmMarkSentRefusal({ status: 'window_closed' }, NOW),
    dmMarkSentRefusal({ status: 'failed' }, NOW),
    dmMarkSentRefusal({ send_after: IN_AN_HOUR }, NOW),
  ];
  assert(allRefusals.every((r) => r !== null), 'all four refusal conditions actually refuse');
  assert(
    allRefusals.every((r) => (r?.message ?? '').length > 20 && /[.!]$/.test(r?.message ?? '')),
    'every refusal is a finished sentence an operator can act on',
  );
  assert(
    allRefusals.every((r) => (r?.error ?? '').length > 0),
    'every refusal carries a machine-readable error code',
  );
  assert(DM_REFUSAL_HTTP_STATUS === 409, 'refusals are 409, matching the email send route');

  // ── 8. parseSendAfter ─────────────────────────────────────────────────────
  assert(parseSendAfter(null) === null, 'parseSendAfter(null) is null');
  assert(parseSendAfter(undefined) === null, 'parseSendAfter(undefined) is null');
  assert(parseSendAfter('nope') === null, 'parseSendAfter refuses garbage rather than returning NaN');
  assert(parseSendAfter(AN_HOUR_AGO) === NOW - 3_600_000, 'parseSendAfter round-trips an ISO instant');

  // ── 9. toDmChannel ────────────────────────────────────────────────────────
  assert(toDmChannel('instagram_dm') === 'instagram_dm', 'instagram_dm maps to itself');
  assert(toDmChannel('tiktok_dm') === 'tiktok_dm', 'tiktok_dm maps to itself');
  assert(toDmChannel('instagram') === 'instagram_dm', 'the bare platform spelling maps to the DM channel');
  assert(toDmChannel('tiktok') === 'tiktok_dm', 'tiktok maps to tiktok_dm');
  assert(toDmChannel('email') === null, 'email is not a DM channel');
  assert(toDmChannel('dm') === null, "legacy 'dm' carries no network, so it resolves to nothing here");
  assert(toDmChannel(null) === null, 'null is not a DM channel');

  // ── 10. resolveDmTarget: the happy path ───────────────────────────────────
  const tiktok = resolveDmTarget({
    channel: 'tiktok_dm',
    platform: 'tiktok',
    username: 'citybeats_example',
    profileUrl: 'https://www.tiktok.com/@citybeats_example',
  });
  assert(tiktok.sendable, 'tiktok_dm + a tiktok handle is sendable');
  assert(tiktok.url === 'https://www.tiktok.com/@citybeats_example', 'the tiktok link is built from the handle');
  assert(tiktok.channel === 'tiktok_dm', 'the resolved channel is the message channel');
  assert(!tiktok.inferred, 'a DM-specific channel is not inferred');
  assert(tiktok.label === 'TikTok DM', 'the badge names the channel, not the creator platform');

  const instagram = resolveDmTarget({
    channel: 'instagram_dm',
    platform: 'instagram',
    username: 'someone',
    profileUrl: null,
  });
  assert(
    instagram.sendable && instagram.url === 'https://www.instagram.com/someone',
    'instagram_dm + an instagram handle links to instagram',
  );

  // ── 11. THE defect: instagram_dm on a tiktok-only creator ─────────────────
  const mismatch = resolveDmTarget({
    channel: 'instagram_dm',
    platform: 'tiktok',
    username: 'tiktokonly',
    profileUrl: 'https://www.tiktok.com/@tiktokonly',
  });
  assert(!mismatch.sendable, 'an Instagram DM to a creator we only know on TikTok is UNSENDABLE');
  assert(
    mismatch.url === null,
    'and it links NOWHERE — the old code sent the operator to TikTok for an Instagram DM',
  );
  assert(mismatch.channel === 'instagram_dm', 'the row still reports the channel it is addressed to');
  assert(
    (mismatch.blockedReason ?? '').includes('Instagram') &&
      (mismatch.blockedReason ?? '').includes('TikTok'),
    'the reason names both networks — what it needs, and what we actually hold',
  );
  assert(
    (mismatch.blockedReason ?? '').includes('@tiktokonly'),
    'the reason shows the handle we DO hold, so the operator can re-route the lead',
  );

  // ── 12. Inference for rows that carry no DM channel ───────────────────────
  // Legacy rows have exactly this shape: channel='email' on creators with no
  // email address, because draft-all hardcoded 'email' before channel routing.
  const rerouted = resolveDmTarget({
    channel: 'email',
    platform: 'tiktok',
    username: 'creator',
    profileUrl: null,
  });
  assert(rerouted.channel === 'tiktok_dm', "channel='email' falls back to the creator's platform");
  assert(rerouted.inferred, 'and says the channel was inferred rather than stated');
  assert(rerouted.sendable && rerouted.url === 'https://www.tiktok.com/@creator', 'the inferred row is sendable');

  const legacyDm = resolveDmTarget({
    channel: 'dm',
    platform: 'tiktok',
    username: 'creator',
    profileUrl: null,
  });
  assert(
    legacyDm.channel === 'tiktok_dm' && legacyDm.inferred,
    "legacy channel 'dm' also infers from the platform (legacy rows carry primary_channel='dm')",
  );

  // ── 13. Nothing to go on at all ───────────────────────────────────────────
  const onlyUrl = resolveDmTarget({
    channel: 'email',
    platform: 'youtube',
    username: 'x',
    profileUrl: 'https://example.test/x',
  });
  assert(
    onlyUrl.channel === null && onlyUrl.sendable && onlyUrl.url === 'https://example.test/x',
    'an unknown platform falls back to the scraped profile url',
  );
  const nothing = resolveDmTarget({
    channel: 'email',
    platform: 'youtube',
    username: 'x',
    profileUrl: null,
  });
  assert(!nothing.sendable && nothing.url === null, 'no channel, no platform and no url is unsendable');
  assert(
    (nothing.blockedReason ?? '').length > 20,
    'and it says why, instead of rendering a dead button',
  );

  // ── 14. Handle hygiene ────────────────────────────────────────────────────
  assert(
    resolveDmTarget({ channel: 'tiktok_dm', platform: 'tiktok', username: '@leading', profileUrl: null })
      .url === 'https://www.tiktok.com/@leading',
    'a stored handle with a leading @ does not produce tiktok.com/@@leading',
  );
  assert(
    !resolveDmTarget({ channel: 'tiktok_dm', platform: 'tiktok', username: '   ', profileUrl: 'x' })
      .sendable,
    'a blank handle on a DM channel is unsendable, not a link to tiktok.com/@',
  );
  assert(
    !resolveDmTarget({ channel: 'tiktok_dm', platform: 'tiktok', username: null, profileUrl: 'x' })
      .sendable,
    'a null handle on a DM channel is unsendable',
  );
  assert(
    resolveDmTarget({ channel: 'tiktok_dm', platform: 'tiktok', username: 'a b/c', profileUrl: null })
      .url === 'https://www.tiktok.com/@a%20b%2Fc',
    'a handle is percent-encoded — a stray slash must not retarget the link',
  );

  // ── 15. Property: a sendable row always has somewhere to go, and a resolved
  //        DM channel never links to the other network ────────────────────────
  const platforms = ['tiktok', 'instagram', 'youtube', null];
  const channels = ['tiktok_dm', 'instagram_dm', 'email', 'dm', null];
  let urlOk = true;
  let hostOk = true;
  for (const platform of platforms) {
    for (const channel of channels) {
      for (const username of ['handle', null]) {
        for (const profileUrl of ['https://www.tiktok.com/@handle', null]) {
          const t = resolveDmTarget({ channel, platform, username, profileUrl });
          if (t.sendable !== (t.url !== null)) urlOk = false;
          if (t.channel === 'instagram_dm' && t.url && !t.url.includes('instagram.com')) hostOk = false;
          if (t.channel === 'tiktok_dm' && t.url && !t.url.includes('tiktok.com')) hostOk = false;
        }
      }
    }
  }
  assert(urlOk, 'sendable is true exactly when a url exists, across every channel/platform combination');
  assert(hostOk, 'a resolved DM channel never links to the other network — the original bug, as a property');

  // ── 16. Working order ─────────────────────────────────────────────────────
  const key = (o: Partial<DmQueueOrderKey>): DmQueueOrderKey => ({
    blocked: false,
    compositeScore: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    id: 'a',
    ...o,
  });

  assert(
    compareDmQueueOrder(key({ blocked: true, compositeScore: 99 }), key({ compositeScore: 1 })) > 0,
    'a blocked row sinks below a sendable one even with a far better score',
  );
  assert(
    compareDmQueueOrder(key({ compositeScore: 90 }), key({ compositeScore: 40 })) < 0,
    'higher composite_score comes first — the point of the reorder',
  );
  assert(
    compareDmQueueOrder(key({ compositeScore: null }), key({ compositeScore: 0 })) > 0,
    'an unscored row sorts below a zero-scored one rather than to the top',
  );
  assert(
    compareDmQueueOrder(
      key({ compositeScore: 50, createdAt: '2026-09-01T00:00:00.000Z' }),
      key({ compositeScore: 50, createdAt: '2026-09-02T00:00:00.000Z' }),
    ) < 0,
    'ties break to the older draft, so nothing ages out at the bottom',
  );
  assert(
    compareDmQueueOrder(key({ id: 'a' }), key({ id: 'b' })) < 0 &&
      compareDmQueueOrder(key({ id: 'b' }), key({ id: 'a' })) > 0 &&
      compareDmQueueOrder(key({ id: 'a' }), key({ id: 'a' })) === 0,
    'identical rows break by id, so the order is total and a re-render cannot reshuffle the page',
  );
  assert(
    compareDmQueueOrder(key({ createdAt: 'garbage', id: 'a' }), key({ createdAt: 'garbage', id: 'b' })) < 0,
    'an unparseable created_at degrades to the id tiebreak rather than producing NaN',
  );

  // A full sort is deterministic regardless of input order.
  const rows: DmQueueOrderKey[] = [
    key({ id: 'blocked-high', blocked: true, compositeScore: 100 }),
    key({ id: 'low', compositeScore: 10 }),
    key({ id: 'high', compositeScore: 80 }),
    key({ id: 'unscored', compositeScore: null }),
  ];
  const forward = [...rows].sort(compareDmQueueOrder).map((r) => r.id).join(',');
  const backward = [...rows].reverse().sort(compareDmQueueOrder).map((r) => r.id).join(',');
  assert(forward === 'high,low,unscored,blocked-high', `sorted by value then blocked (got ${forward})`);
  assert(forward === backward, 'the sort is order-independent — paging cannot show a row twice');

  console.log(`dm-queue-guards test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main();
