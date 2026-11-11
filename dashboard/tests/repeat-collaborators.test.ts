// tests/repeat-collaborators.test.ts
//
// Unit tests for src/lib/repeat-collaborators.ts — the "worked before" roster.
// Pure + hermetic: no env, no DB, no network, no clock. Every fixture is
// hand-built in memory and every expected value is hand-computed below.
//
// The honesty rules get the most coverage, because they are the ones a future
// refactor is most likely to quietly break:
//   - a creator with no measured reach gets a NULL cpm, never 0
//   - pending deliveries never count as broken promises
//   - [SAMPLE] / synthetic campaigns never reach the math
//   - an out-of-scope campaign's offers are unreachable
//   - nothing in the output claims a creator moved streams
//
// Run: npx tsx tests/repeat-collaborators.test.ts

import {
  buildRepeatCollaborators,
  compareRepeatCollaborators,
  type RepeatCollaborator,
  type RosterCampaignRow,
  type RosterLinkRow,
  type RosterOfferRow,
  type RosterInfluencerRow,
  type RosterDeliveryRow,
  type RosterSnapshotRow,
} from '../src/lib/repeat-collaborators';

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

const EPS = 1e-9;
const close = (a: number | null, b: number, eps = EPS): boolean =>
  a != null && Math.abs(a - b) < eps;

// ── Fixture factories — nulls everywhere unless overridden ───────────────────

const campaign = (id: string, synthetic = false): RosterCampaignRow => ({ id, synthetic });

const link = (id: string, campaign_id: string, influencer_id: string): RosterLinkRow => ({
  id,
  campaign_id,
  influencer_id,
});

function offer(
  o: Partial<RosterOfferRow> & { id: string; campaign_id: string; campaign_influencer_id: string; status: string }
): RosterOfferRow {
  return {
    agreed_amount_usd: null,
    current_offer_usd: null,
    approved_at: null,
    paid_at: null,
    posted_at: null,
    created_at: null,
    ...o,
  };
}

function influencer(id: string, over: Partial<RosterInfluencerRow> = {}): RosterInfluencerRow {
  return {
    id,
    platform: 'tiktok',
    username: `creator_${id}`,
    display_name: `Creator ${id}`,
    follower_count: 25_000,
    avatar_url: null,
    content_genres: ['country'],
    ...over,
  };
}

const delivery = (
  id: string,
  creator_offer_id: string,
  status: string,
  spec_check: string | null = null
): RosterDeliveryRow => ({ id, creator_offer_id, status, spec_check });

const snap = (
  deal_delivery_id: string,
  captured_at: string,
  views: number | null
): RosterSnapshotRow => ({ deal_delivery_id, captured_at, views });

const byId = (r: { collaborators: RepeatCollaborator[] }, influencerId: string) =>
  r.collaborators.find((c) => c.influencer_id === influencerId);

// ── The main fixture ────────────────────────────────────────────────────────
//
// Two real campaigns (C1, C2), one synthetic (CS), and one campaign the firm
// does not own (CX — deliberately absent from `campaigns`).
//
//   I1  two closed deals across both real campaigns. One post verified with
//       reach, one post missing, one still pending.
//   I2  one closed deal, verified post with reach, spec only 'partial'.
//   I3  one closed deal, no delivery rows at all.
//   I4  one closed deal with a verified post but NO measurement, plus a
//       rejected offer that must not count.
//   I5  synthetic-campaign deal only.
//   I6  a deal under a campaign belonging to another firm.

const CAMPAIGNS = [campaign('C1'), campaign('C2'), campaign('CS', true)];

const LINKS = [
  link('L1', 'C1', 'I1'),
  link('L2', 'C2', 'I1'),
  link('L3', 'C1', 'I2'),
  link('L4', 'C1', 'I3'),
  link('L5', 'C1', 'I4'),
  link('LS', 'CS', 'I5'),
  link('LX', 'CX', 'I6'),
];

const OFFERS = [
  offer({ id: 'O1', campaign_id: 'C1', campaign_influencer_id: 'L1', status: 'measured', agreed_amount_usd: 200, posted_at: '2026-08-01T00:00:00Z' }),
  offer({ id: 'O2', campaign_id: 'C2', campaign_influencer_id: 'L2', status: 'paid', agreed_amount_usd: 100, paid_at: '2026-09-01T00:00:00Z' }),
  offer({ id: 'O3', campaign_id: 'C1', campaign_influencer_id: 'L3', status: 'posted', agreed_amount_usd: 300, posted_at: '2026-07-01T00:00:00Z' }),
  offer({ id: 'O4', campaign_id: 'C1', campaign_influencer_id: 'L4', status: 'agreed', agreed_amount_usd: 150, created_at: '2026-06-01T00:00:00Z' }),
  offer({ id: 'O5', campaign_id: 'C1', campaign_influencer_id: 'L5', status: 'rejected', agreed_amount_usd: 500, created_at: '2026-05-15T00:00:00Z' }),
  offer({ id: 'O6', campaign_id: 'C1', campaign_influencer_id: 'L5', status: 'posted', agreed_amount_usd: 250, posted_at: '2026-05-01T00:00:00Z' }),
  offer({ id: 'OS', campaign_id: 'CS', campaign_influencer_id: 'LS', status: 'measured', agreed_amount_usd: 999, posted_at: '2026-08-15T00:00:00Z' }),
  offer({ id: 'OX', campaign_id: 'CX', campaign_influencer_id: 'LX', status: 'measured', agreed_amount_usd: 888, posted_at: '2026-08-20T00:00:00Z' }),
];

const DELIVERIES = [
  delivery('D1', 'O1', 'verified', 'pass'),
  delivery('D2', 'O1', 'missing', null),
  delivery('D3', 'O2', 'pending', null),
  delivery('D4', 'O3', 'verified', 'partial'),
  delivery('D5', 'O6', 'verified', 'pass'),
  delivery('DS', 'OS', 'verified', 'pass'),
];

const SNAPSHOTS = [
  // Same post measured twice — only the newest may count.
  snap('D1', '2026-08-02T00:00:00Z', 10_000),
  snap('D1', '2026-08-09T00:00:00Z', 40_000),
  snap('D4', '2026-07-05T00:00:00Z', 20_000),
  // D5 has no snapshot at all → I4 has no realized CPM.
  snap('DS', '2026-08-16T00:00:00Z', 5_000_000),
];

const INFLUENCERS = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6'].map((id) => influencer(id));

const R = buildRepeatCollaborators({
  campaigns: CAMPAIGNS,
  links: LINKS,
  offers: OFFERS,
  influencers: INFLUENCERS,
  deliveries: DELIVERIES,
  snapshots: SNAPSHOTS,
});

// ── 1. Membership: only closed deals, only in-scope, only real ──────────────
{
  const ids = R.collaborators.map((c) => c.influencer_id).sort();
  assert(
    JSON.stringify(ids) === JSON.stringify(['I1', 'I2', 'I3', 'I4']),
    `roster is exactly I1-I4 (got ${JSON.stringify(ids)})`
  );
  assert(byId(R, 'I5') === undefined, 'synthetic-campaign creator is not on the roster');
  assert(byId(R, 'I6') === undefined, 'out-of-firm-scope creator is not on the roster');
  assert(R.excluded_synthetic_campaigns === 1, `1 synthetic campaign excluded (got ${R.excluded_synthetic_campaigns})`);
  assert(R.excluded_synthetic_offers === 1, `1 synthetic offer excluded (got ${R.excluded_synthetic_offers})`);
}

// ── 2. A rejected offer never becomes a closed deal ─────────────────────────
{
  const i4 = byId(R, 'I4');
  assert(i4?.deals_closed === 1, `I4 has 1 closed deal, not 2 (got ${i4?.deals_closed})`);
  assert(close(i4?.total_spend_usd ?? null, 250), `I4 spend excludes the rejected $500 (got ${i4?.total_spend_usd})`);
}

// ── 3. Counts, spend, median agreed price ───────────────────────────────────
{
  const i1 = byId(R, 'I1');
  assert(i1?.deals_closed === 2, `I1 deals_closed = 2 (got ${i1?.deals_closed})`);
  assert(i1?.campaigns_worked === 2, `I1 worked across 2 campaigns (got ${i1?.campaigns_worked})`);
  assert(close(i1?.total_spend_usd ?? null, 300), `I1 spend 200+100 = 300 (got ${i1?.total_spend_usd})`);
  // Even count → mean of the two middle values.
  assert(close(i1?.median_agreed_usd ?? null, 150), `I1 median of [100,200] = 150 (got ${i1?.median_agreed_usd})`);

  const i3 = byId(R, 'I3');
  assert(close(i3?.median_agreed_usd ?? null, 150), `I3 median of [150] = 150 (got ${i3?.median_agreed_usd})`);
}

// ── 4. Spend falls back to the standing offer, and an absent price is null ──
{
  const r = buildRepeatCollaborators({
    campaigns: [campaign('C')],
    links: [link('L', 'C', 'I')],
    offers: [
      offer({ id: 'O', campaign_id: 'C', campaign_influencer_id: 'L', status: 'agreed', agreed_amount_usd: null, current_offer_usd: 175 }),
    ],
    influencers: [influencer('I')],
    deliveries: [],
    snapshots: [],
  });
  const c = r.collaborators[0];
  assert(close(c.total_spend_usd, 175), `spend falls back to the standing offer (got ${c.total_spend_usd})`);
  assert(
    c.median_agreed_usd === null,
    `no agreed amount → median is NULL, not 0 (got ${c.median_agreed_usd})`
  );
  assert(
    c.unknowns.some((u) => u.includes('median price is unknown')),
    'the missing median is named in unknowns'
  );
}

// ── 5. Delivery reliability — pending is not a broken promise ───────────────
{
  const i1 = byId(R, 'I1');
  assert(i1?.delivery.promised === 3, `I1 promised 3 posts (got ${i1?.delivery.promised})`);
  assert(i1?.delivery.verified === 1, `I1 verified 1 (got ${i1?.delivery.verified})`);
  assert(i1?.delivery.missing === 1, `I1 missing 1 (got ${i1?.delivery.missing})`);
  assert(i1?.delivery.pending === 1, `I1 pending 1 (got ${i1?.delivery.pending})`);
  // 1 verified / (1 verified + 1 missing) = 0.5. The pending row is NOT in the
  // denominator — 1/3 = 0.33 would be a fabricated failure.
  assert(close(i1?.delivery.rate ?? null, 0.5), `I1 reliability = 1/2 = 0.5, pending excluded (got ${i1?.delivery.rate})`);
  assert(
    i1?.unknowns.some((u) => u.includes('still outstanding')) === true,
    'the outstanding post is disclosed in unknowns'
  );

  const i4 = byId(R, 'I4');
  assert(close(i4?.delivery.rate ?? null, 1), `I4 reliability = 1/1 = 1 (got ${i4?.delivery.rate})`);
}

// ── 6. Reliability is NULL, never 0, when nothing has resolved ──────────────
{
  const i3 = byId(R, 'I3');
  assert(i3?.delivery.promised === 0, `I3 has no delivery rows (got ${i3?.delivery.promised})`);
  assert(i3?.delivery.rate === null, `I3 reliability is NULL, not 0 (got ${i3?.delivery.rate})`);
  assert(
    i3?.unknowns.some((u) => u.includes('delivery reliability is unknown')) === true,
    'I3 names the unknown reliability'
  );

  // All-pending is also unknown, not zero.
  const r = buildRepeatCollaborators({
    campaigns: [campaign('C')],
    links: [link('L', 'C', 'I')],
    offers: [offer({ id: 'O', campaign_id: 'C', campaign_influencer_id: 'L', status: 'paid', agreed_amount_usd: 100 })],
    influencers: [influencer('I')],
    deliveries: [delivery('D', 'O', 'pending')],
    snapshots: [],
  });
  assert(r.collaborators[0].delivery.rate === null, `all-pending reliability is NULL, not 0 (got ${r.collaborators[0].delivery.rate})`);
  assert(r.collaborators[0].delivery.pending === 1, 'the pending row is still reported');
}

// ── 7. spec_check tallies and pass rate ─────────────────────────────────────
{
  const i1 = byId(R, 'I1');
  assert(i1?.delivery.spec_pass === 1 && i1?.delivery.spec_partial === 0 && i1?.delivery.spec_fail === 0, 'I1 spec tally: 1 pass');
  assert(close(i1?.delivery.spec_pass_rate ?? null, 1), `I1 spec pass rate = 1/1 (got ${i1?.delivery.spec_pass_rate})`);

  const i2 = byId(R, 'I2');
  assert(i2?.delivery.spec_partial === 1, `I2 has 1 partial spec check (got ${i2?.delivery.spec_partial})`);
  // 'partial' is checked but is not a pass — a real 0, not a null.
  assert(close(i2?.delivery.spec_pass_rate ?? null, 0), `I2 spec pass rate = 0/1 = 0 (got ${i2?.delivery.spec_pass_rate})`);

  const i3 = byId(R, 'I3');
  assert(i3?.delivery.spec_pass_rate === null, `I3 spec pass rate is NULL when nothing was checked (got ${i3?.delivery.spec_pass_rate})`);
}

// ── 8. Realized label CPM — measured only, latest snapshot only ─────────────
{
  const i1 = byId(R, 'I1');
  // O1 spend $200, reach = latest D1 snapshot 40,000 (NOT 10k+40k=50k).
  // O2 contributed no measurement, so its $100 is out of the numerator.
  // 200 / (40000/1000) = 5.00
  assert(close(i1?.realized_label_cpm ?? null, 5), `I1 CPM = 200/(40k/1000) = 5.00 (got ${i1?.realized_label_cpm})`);
  assert(i1?.cpm_basis?.reach === 40_000, `I1 reach is the LATEST snapshot only, not the sum (got ${i1?.cpm_basis?.reach})`);
  assert(i1?.cpm_basis?.deals === 1, `I1 CPM rests on 1 of 2 deals (got ${i1?.cpm_basis?.deals})`);
  assert(close(i1?.cpm_basis?.spend_usd ?? null, 200), `I1 CPM numerator excludes the unmeasured deal (got ${i1?.cpm_basis?.spend_usd})`);
  assert(
    i1?.unknowns.some((u) => u.includes('covers 1 of 2 deals')) === true,
    'the partial CPM basis is disclosed in unknowns'
  );

  const i2 = byId(R, 'I2');
  assert(close(i2?.realized_label_cpm ?? null, 15), `I2 CPM = 300/(20k/1000) = 15.00 (got ${i2?.realized_label_cpm})`);
  assert(
    i2?.unknowns.some((u) => u.includes('single deal')) === true,
    'a one-deal CPM is flagged as thin evidence'
  );
}

// ── 9. NULL over a fabricated zero — the load-bearing honesty rule ──────────
{
  const i3 = byId(R, 'I3');
  const i4 = byId(R, 'I4');
  assert(i3?.realized_label_cpm === null, `I3 CPM is NULL (got ${i3?.realized_label_cpm})`);
  assert(i4?.realized_label_cpm === null, `I4 CPM is NULL even with a VERIFIED post but no measurement (got ${i4?.realized_label_cpm})`);
  assert(i4?.cpm_basis === null, 'cpm_basis is null exactly when the CPM is null');
  assert(
    i4?.unknowns.some((u) => u.includes('cost per 1,000 views is unknown')) === true,
    'I4 names the unknown CPM in plain English'
  );

  // A measured ZERO is still not a CPM — you cannot divide by no reach.
  const r = buildRepeatCollaborators({
    campaigns: [campaign('C')],
    links: [link('L', 'C', 'I')],
    offers: [offer({ id: 'O', campaign_id: 'C', campaign_influencer_id: 'L', status: 'measured', agreed_amount_usd: 100 })],
    influencers: [influencer('I')],
    deliveries: [delivery('D', 'O', 'verified', 'pass')],
    snapshots: [snap('D', '2026-08-01T00:00:00Z', 0)],
  });
  assert(r.collaborators[0].realized_label_cpm === null, `zero measured views → NULL CPM, never 0 (got ${r.collaborators[0].realized_label_cpm})`);

  // A null views field is likewise unknown, not zero.
  const r2 = buildRepeatCollaborators({
    campaigns: [campaign('C')],
    links: [link('L', 'C', 'I')],
    offers: [offer({ id: 'O', campaign_id: 'C', campaign_influencer_id: 'L', status: 'measured', agreed_amount_usd: 100 })],
    influencers: [influencer('I')],
    deliveries: [delivery('D', 'O', 'verified', 'pass')],
    snapshots: [snap('D', '2026-08-01T00:00:00Z', null)],
  });
  assert(r2.collaborators[0].realized_label_cpm === null, 'a null views reading → NULL CPM');
}

// ── 10. Whole-roster invariant: no row ever publishes a fabricated metric ───
{
  const bad = R.collaborators.filter(
    (c) =>
      (c.realized_label_cpm === null) !== (c.cpm_basis === null) ||
      // A 0.00 CPM is only honest when the spend really was 0. Any other route
      // to it — an absent price coalesced to $0 — is a fabrication.
      (c.realized_label_cpm === 0 && (c.cpm_basis?.spend_usd ?? -1) !== 0) ||
      (c.cpm_basis !== null && c.cpm_basis.reach <= 0)
  );
  assert(bad.length === 0, `no row carries a fabricated/half-populated CPM (${bad.length} bad rows)`);

  const missingDisclaimer = R.collaborators.filter(
    (c) => !c.unknowns.some((u) => u.includes('streaming lift'))
  );
  assert(
    missingDisclaimer.length === 0,
    `every row disclaims per-creator stream attribution (${missingDisclaimer.length} missing)`
  );

  const asJson = JSON.stringify(R);
  assert(!asJson.includes('streams_attributed'), 'the payload never carries streams_attributed');
  assert(!/stream[s_]*lift|attributed_streams/i.test(asJson.replace(/streaming lift/gi, '')), 'no field claims a per-creator stream lift');
}

// ── 11. last_worked_at takes the most recent deal, and names its basis ──────
{
  const i1 = byId(R, 'I1');
  assert(i1?.last_worked_at === '2026-09-01T00:00:00Z', `I1 last worked = the later of the two deals (got ${i1?.last_worked_at})`);
  assert(i1?.last_worked_basis === 'paid', `I1 basis is 'paid', the most concrete fact on that deal (got ${i1?.last_worked_basis})`);

  const i3 = byId(R, 'I3');
  assert(i3?.last_worked_basis === 'agreed', `I3 only ever agreed — basis must not overclaim 'posted' (got ${i3?.last_worked_basis})`);

  // posted_at outranks paid_at on the same row.
  const r = buildRepeatCollaborators({
    campaigns: [campaign('C')],
    links: [link('L', 'C', 'I')],
    offers: [
      offer({ id: 'O', campaign_id: 'C', campaign_influencer_id: 'L', status: 'posted', agreed_amount_usd: 100, paid_at: '2026-01-01T00:00:00Z', posted_at: '2026-02-01T00:00:00Z' }),
    ],
    influencers: [influencer('I')],
    deliveries: [],
    snapshots: [],
  });
  assert(r.collaborators[0].last_worked_basis === 'posted', 'posted_at outranks paid_at');
}

// ── 12. Ranking: buckets first, then the bucket's own signal ───────────────
{
  const order = R.collaborators.map((c) => c.influencer_id);
  // I1 (cpm 5) → I2 (cpm 15) → I4 (reliability, no cpm) → I3 (deal count only)
  assert(
    JSON.stringify(order) === JSON.stringify(['I1', 'I2', 'I4', 'I3']),
    `best repeat bet first: I1,I2,I4,I3 (got ${JSON.stringify(order)})`
  );
  assert(byId(R, 'I1')?.rank_basis === 'realized_cpm', 'I1 ranked on realized CPM');
  assert(byId(R, 'I4')?.rank_basis === 'delivery_reliability', 'I4 ranked on delivery reliability');
  assert(byId(R, 'I3')?.rank_basis === 'deal_count', 'I3 ranked on deal count only');

  // A creator with a measured CPM is never outranked by one without, even when
  // the CPM-less creator has more deals — the two are not comparable, so the
  // stronger evidence wins the bucket.
  const r = buildRepeatCollaborators({
    campaigns: [campaign('C')],
    links: [link('LA', 'C', 'A'), link('LB', 'C', 'B')],
    offers: [
      offer({ id: 'OA', campaign_id: 'C', campaign_influencer_id: 'LA', status: 'measured', agreed_amount_usd: 400 }),
      offer({ id: 'OB1', campaign_id: 'C', campaign_influencer_id: 'LB', status: 'paid', agreed_amount_usd: 100 }),
      offer({ id: 'OB2', campaign_id: 'C', campaign_influencer_id: 'LB', status: 'paid', agreed_amount_usd: 100 }),
      offer({ id: 'OB3', campaign_id: 'C', campaign_influencer_id: 'LB', status: 'paid', agreed_amount_usd: 100 }),
    ],
    influencers: [influencer('A'), influencer('B')],
    deliveries: [delivery('DA', 'OA', 'verified', 'pass')],
    snapshots: [snap('DA', '2026-08-01T00:00:00Z', 10_000)],
  });
  assert(
    r.collaborators[0].influencer_id === 'A',
    `measured CPM outranks a bigger deal count (got ${r.collaborators[0].influencer_id})`
  );
}

// ── 13. Lower CPM sorts first; higher reliability sorts first ───────────────
{
  const r = buildRepeatCollaborators({
    campaigns: [campaign('C')],
    links: [link('LA', 'C', 'A'), link('LB', 'C', 'B')],
    offers: [
      offer({ id: 'OA', campaign_id: 'C', campaign_influencer_id: 'LA', status: 'measured', agreed_amount_usd: 100 }),
      offer({ id: 'OB', campaign_id: 'C', campaign_influencer_id: 'LB', status: 'measured', agreed_amount_usd: 900 }),
    ],
    influencers: [influencer('A'), influencer('B')],
    deliveries: [delivery('DA', 'OA', 'verified'), delivery('DB', 'OB', 'verified')],
    snapshots: [snap('DA', '2026-08-01T00:00:00Z', 50_000), snap('DB', '2026-08-01T00:00:00Z', 50_000)],
  });
  assert(r.collaborators[0].influencer_id === 'A', 'cheaper cost per 1,000 views ranks first');
  assert(close(r.collaborators[0].realized_label_cpm, 2), `A CPM = 100/50 = 2 (got ${r.collaborators[0].realized_label_cpm})`);
  assert(close(r.collaborators[1].realized_label_cpm, 18), `B CPM = 900/50 = 18 (got ${r.collaborators[1].realized_label_cpm})`);

  const r2 = buildRepeatCollaborators({
    campaigns: [campaign('C')],
    links: [link('LA', 'C', 'A'), link('LB', 'C', 'B')],
    offers: [
      offer({ id: 'OA', campaign_id: 'C', campaign_influencer_id: 'LA', status: 'posted', agreed_amount_usd: 100 }),
      offer({ id: 'OB', campaign_id: 'C', campaign_influencer_id: 'LB', status: 'posted', agreed_amount_usd: 100 }),
    ],
    influencers: [influencer('A'), influencer('B')],
    deliveries: [
      delivery('DA1', 'OA', 'verified'),
      delivery('DA2', 'OA', 'missing'),
      delivery('DB1', 'OB', 'verified'),
      delivery('DB2', 'OB', 'verified'),
    ],
    snapshots: [],
  });
  assert(r2.collaborators[0].influencer_id === 'B', 'higher delivery reliability ranks first');
  assert(close(r2.collaborators[0].delivery.rate, 1) && close(r2.collaborators[1].delivery.rate, 0.5), 'reliability rates 1.0 then 0.5');
}

// ── 14. Deterministic: identical input, identical order, no clock or rng ────
{
  const again = buildRepeatCollaborators({
    campaigns: CAMPAIGNS,
    links: LINKS,
    offers: OFFERS,
    influencers: INFLUENCERS,
    deliveries: DELIVERIES,
    snapshots: SNAPSHOTS,
  });
  assert(JSON.stringify(again) === JSON.stringify(R), 'the same rows always produce the same roster');

  // Fully tied rows fall back to influencer_id so the order is total.
  const tied = buildRepeatCollaborators({
    campaigns: [campaign('C')],
    links: [link('LZ', 'C', 'Z'), link('LA', 'C', 'A')],
    offers: [
      offer({ id: 'OZ', campaign_id: 'C', campaign_influencer_id: 'LZ', status: 'agreed', agreed_amount_usd: 100 }),
      offer({ id: 'OA', campaign_id: 'C', campaign_influencer_id: 'LA', status: 'agreed', agreed_amount_usd: 100 }),
    ],
    influencers: [influencer('Z'), influencer('A')],
    deliveries: [],
    snapshots: [],
  });
  assert(
    tied.collaborators.map((c) => c.influencer_id).join(',') === 'A,Z',
    `fully tied rows break on influencer_id (got ${tied.collaborators.map((c) => c.influencer_id).join(',')})`
  );
}

// ── 15. Firm totals describe the whole roster ───────────────────────────────
{
  assert(R.totals.creators === 4, `totals.creators = 4 (got ${R.totals.creators})`);
  assert(R.totals.deals_closed === 5, `totals.deals_closed = 5 closed deals (got ${R.totals.deals_closed})`);
  // 300 (I1) + 300 (I2) + 150 (I3) + 250 (I4) = 1000. The $999 synthetic deal
  // and the $888 out-of-scope deal are both absent.
  assert(close(R.totals.total_spend_usd, 1000), `totals.total_spend_usd = 1000, synthetic and out-of-scope excluded (got ${R.totals.total_spend_usd})`);
  assert(R.totals.with_realized_cpm === 2, `2 creators have a measured CPM (got ${R.totals.with_realized_cpm})`);
}

// ── 16. Creator identity is carried through for the surface ────────────────
{
  const i1 = byId(R, 'I1');
  assert(i1?.username === 'creator_I1' && i1?.platform === 'tiktok', 'handle and platform are carried through');
  assert(i1?.follower_count === 25_000, `follower_count carried through (got ${i1?.follower_count})`);

  // A creator row that never arrived still yields a roster entry from the deal
  // history — with null identity fields rather than invented ones.
  const r = buildRepeatCollaborators({
    campaigns: [campaign('C')],
    links: [link('L', 'C', 'GHOST')],
    offers: [offer({ id: 'O', campaign_id: 'C', campaign_influencer_id: 'L', status: 'agreed', agreed_amount_usd: 100 })],
    influencers: [],
    deliveries: [],
    snapshots: [],
  });
  assert(r.collaborators.length === 1, 'a deal with no influencer row still counts as a closed deal');
  assert(r.collaborators[0].username === null && r.collaborators[0].platform === null, 'missing identity is null, never invented');
}

// ── 17. Empty input is an empty roster, not a crash ─────────────────────────
{
  const r = buildRepeatCollaborators({
    campaigns: [],
    links: [],
    offers: [],
    influencers: [],
    deliveries: [],
    snapshots: [],
  });
  assert(r.collaborators.length === 0, 'empty input → empty roster');
  assert(r.totals.creators === 0 && r.totals.total_spend_usd === 0, 'empty totals are real zeros');
}

// ── 18. An unpriced deal is NOT a $0 deal ──────────────────────────────────
//
// Both price columns are nullable (migration 009) with no CHECK tying either
// to a closed status, so an unpriced closed deal is representable. Coalescing
// to 0 made it the best possible CPM numerator.
{
  const r = buildRepeatCollaborators({
    campaigns: [campaign('C')],
    links: [link('LA', 'C', 'A'), link('LB', 'C', 'B')],
    offers: [
      // A: measured reach, no price recorded at all.
      offer({ id: 'OA', campaign_id: 'C', campaign_influencer_id: 'LA', status: 'measured', agreed_amount_usd: null, current_offer_usd: null }),
      // B: a genuinely excellent deal — 1,000,000 views for $100.
      offer({ id: 'OB', campaign_id: 'C', campaign_influencer_id: 'LB', status: 'measured', agreed_amount_usd: 100 }),
    ],
    influencers: [influencer('A'), influencer('B')],
    deliveries: [delivery('DA', 'OA', 'verified', 'pass'), delivery('DB', 'OB', 'verified', 'pass')],
    snapshots: [
      snap('DA', '2026-08-01T00:00:00Z', 1_000),
      snap('DB', '2026-08-01T00:00:00Z', 1_000_000),
    ],
  });
  const a = byId(r, 'A');
  const b = byId(r, 'B');

  assert(a?.realized_label_cpm === null, `an unpriced deal yields a NULL cpm, not $0.00 (got ${a?.realized_label_cpm})`);
  assert(a?.cpm_basis === null, 'an unpriced deal never forms a CPM basis');
  assert(a?.deals_unpriced === 1, `the unpriced deal is counted (got ${a?.deals_unpriced})`);
  assert(a?.rank_basis === 'delivery_reliability', `with no usable CPM, A drops to the reliability bucket (got ${a?.rank_basis})`);
  assert(
    a?.unknowns.some((u) => u.includes('no price on record')) === true,
    'the missing price is disclosed in unknowns'
  );
  assert(close(b?.realized_label_cpm ?? null, 0.1), `B CPM = 100/(1M/1000) = 0.10 (got ${b?.realized_label_cpm})`);
  assert(
    r.collaborators[0].influencer_id === 'B',
    `the real performer outranks the unpriced row (got ${r.collaborators[0].influencer_id})`
  );
}

// ── 19. The silent 2x understatement: one priced + one unpriced deal ────────
//
// $500 over 100k views is a CPM of 5.00. Letting the unpriced deal's reach
// into the denominator with $0 against it reported 2.50 — and BOTH disclosure
// lines stayed silent, because one agreed price is not "no agreed price" and
// cpmDeals === dealsClosed suppressed the "covers N of M" line.
{
  const r = buildRepeatCollaborators({
    campaigns: [campaign('C')],
    links: [link('L', 'C', 'I')],
    offers: [
      offer({ id: 'O1', campaign_id: 'C', campaign_influencer_id: 'L', status: 'measured', agreed_amount_usd: 500 }),
      offer({ id: 'O2', campaign_id: 'C', campaign_influencer_id: 'L', status: 'measured', agreed_amount_usd: null, current_offer_usd: null }),
    ],
    influencers: [influencer('I')],
    deliveries: [delivery('D1', 'O1', 'verified', 'pass'), delivery('D2', 'O2', 'verified', 'pass')],
    snapshots: [
      snap('D1', '2026-08-01T00:00:00Z', 100_000),
      snap('D2', '2026-08-01T00:00:00Z', 100_000),
    ],
  });
  const c = r.collaborators[0];

  assert(close(c.realized_label_cpm, 5), `CPM is 5.00, not the 2.50 the $0 coalesce produced (got ${c.realized_label_cpm})`);
  assert(c.cpm_basis?.deals === 1, `only the priced deal forms the basis (got ${c.cpm_basis?.deals})`);
  assert(c.cpm_basis?.reach === 100_000, `the unpriced deal's reach stays out of the denominator (got ${c.cpm_basis?.reach})`);
  assert(close(c.total_spend_usd, 500), `spend counts only the priced deal (got ${c.total_spend_usd})`);
  assert(c.deals_unpriced === 1, `deals_unpriced = 1 (got ${c.deals_unpriced})`);
  // The two lines that were previously both suppressed.
  assert(
    c.unknowns.some((u) => u.includes('covers 1 of 2 deals')),
    'the partial CPM basis is now disclosed'
  );
  assert(
    c.unknowns.some((u) => u.includes('1 of 2 deals have no price on record')),
    'the unpriced deal is now disclosed'
  );
}

// ── 20. The comparator is a TOTAL ORDER ────────────────────────────────────
//
// lastWorkedMs returns -Infinity for a creator with no date, so exactly one
// side missing gave ±Infinity, which the old Number.isFinite guard discarded
// as a tie and fell through to the id compare. That was intransitive.
{
  const r = buildRepeatCollaborators({
    campaigns: [campaign('C')],
    links: [link('Lb', 'C', 'b'), link('La', 'C', 'a'), link('Lc', 'C', 'c')],
    offers: [
      // id 'b' — no timestamp anywhere, so last_worked_at is null.
      offer({ id: 'Ob', campaign_id: 'C', campaign_influencer_id: 'Lb', status: 'agreed', agreed_amount_usd: 100 }),
      offer({ id: 'Oa', campaign_id: 'C', campaign_influencer_id: 'La', status: 'agreed', agreed_amount_usd: 100, created_at: '2026-01-01T00:00:00Z' }),
      offer({ id: 'Oc', campaign_id: 'C', campaign_influencer_id: 'Lc', status: 'agreed', agreed_amount_usd: 100, created_at: '2026-02-01T00:00:00Z' }),
    ],
    influencers: [influencer('a'), influencer('b'), influencer('c')],
    deliveries: [],
    snapshots: [],
  });

  const A = byId(r, 'b')!; // no date
  const B = byId(r, 'a')!; // Jan
  const C = byId(r, 'c')!; // Feb
  assert(A.last_worked_at === null, 'the fixture really does produce a null last_worked_at');

  const sign = (x: RepeatCollaborator, y: RepeatCollaborator) =>
    Math.sign(compareRepeatCollaborators(x, y));

  // The exact 3-cycle from the review: previously +1, +1, -1.
  assert(sign(A, B) === 1, `cmp(no-date, Jan) puts the dated row first (got ${sign(A, B)})`);
  assert(sign(B, C) === 1, `cmp(Jan, Feb) puts the newer row first (got ${sign(B, C)})`);
  assert(sign(A, C) === 1, `cmp(no-date, Feb) is +1, not the -1 that formed the cycle (got ${sign(A, C)})`);

  // Antisymmetry and transitivity over every ordered pair/triple.
  const all = [A, B, C];
  let antisym = true;
  let transitive = true;
  for (const x of all) {
    for (const y of all) {
      if (sign(x, y) !== -sign(y, x)) antisym = false;
      for (const z of all) {
        if (sign(x, y) <= 0 && sign(y, z) <= 0 && !(sign(x, z) <= 0)) transitive = false;
      }
    }
  }
  assert(antisym, 'comparator is antisymmetric: sign(x,y) === -sign(y,x)');
  assert(transitive, 'comparator is transitive: x<=y and y<=z implies x<=z');

  assert(
    r.collaborators.map((c) => c.influencer_id).join(',') === 'c,a,b',
    `newest first, undated last (got ${r.collaborators.map((c) => c.influencer_id).join(',')})`
  );

  // Two undated rows are a genuine tie and still fall through to id.
  const tied = buildRepeatCollaborators({
    campaigns: [campaign('C')],
    links: [link('LZ', 'C', 'Z'), link('LA', 'C', 'A')],
    offers: [
      offer({ id: 'OZ', campaign_id: 'C', campaign_influencer_id: 'LZ', status: 'agreed', agreed_amount_usd: 100 }),
      offer({ id: 'OA', campaign_id: 'C', campaign_influencer_id: 'LA', status: 'agreed', agreed_amount_usd: 100 }),
    ],
    influencers: [influencer('Z'), influencer('A')],
    deliveries: [],
    snapshots: [],
  });
  assert(
    tied.collaborators.map((c) => c.influencer_id).join(',') === 'A,Z',
    'both-undated is still a tie broken on id'
  );
}

// ── 21. The §10 invariant, driven with unpriced deals in the mix ───────────
{
  const r = buildRepeatCollaborators({
    campaigns: [campaign('C')],
    links: [link('L1', 'C', 'P1'), link('L2', 'C', 'P2'), link('L3', 'C', 'P3')],
    offers: [
      offer({ id: 'X1', campaign_id: 'C', campaign_influencer_id: 'L1', status: 'measured', agreed_amount_usd: null, current_offer_usd: null }),
      offer({ id: 'X2', campaign_id: 'C', campaign_influencer_id: 'L2', status: 'measured', agreed_amount_usd: 0 }),
      offer({ id: 'X3', campaign_id: 'C', campaign_influencer_id: 'L3', status: 'measured', agreed_amount_usd: 250 }),
    ],
    influencers: [influencer('P1'), influencer('P2'), influencer('P3')],
    deliveries: [
      delivery('E1', 'X1', 'verified', 'pass'),
      delivery('E2', 'X2', 'verified', 'pass'),
      delivery('E3', 'X3', 'verified', 'pass'),
    ],
    snapshots: [
      snap('E1', '2026-08-01T00:00:00Z', 50_000),
      snap('E2', '2026-08-01T00:00:00Z', 50_000),
      snap('E3', '2026-08-01T00:00:00Z', 50_000),
    ],
  });

  const bad = r.collaborators.filter(
    (c) =>
      (c.realized_label_cpm === null) !== (c.cpm_basis === null) ||
      (c.cpm_basis !== null && c.cpm_basis.reach <= 0) ||
      (c.deals_unpriced > 0 && !c.unknowns.some((u) => u.includes('no price on record')))
  );
  assert(bad.length === 0, `no half-populated or undisclosed row with unpriced deals (${bad.length} bad)`);

  // A RECORDED $0 is a real measurement and keeps its (zero) CPM; an ABSENT
  // price is unknown and gets null. The two must not be conflated.
  assert(byId(r, 'P1')?.realized_label_cpm === null, 'absent price → null CPM');
  assert(byId(r, 'P1')?.deals_unpriced === 1, 'absent price counted as unpriced');
  assert(byId(r, 'P2')?.realized_label_cpm === 0, `a recorded $0 is a real 0.00 CPM (got ${byId(r, 'P2')?.realized_label_cpm})`);
  assert(byId(r, 'P2')?.deals_unpriced === 0, 'a recorded $0 is NOT an unpriced deal');
  assert(close(byId(r, 'P3')?.realized_label_cpm ?? null, 5), `P3 CPM = 250/50 = 5.00 (got ${byId(r, 'P3')?.realized_label_cpm})`);
}

console.log(`repeat-collaborators test: ${passed} passed, ${failed} failed`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
