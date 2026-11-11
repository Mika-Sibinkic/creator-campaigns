#!/usr/bin/env node
// tools/seed-sample-analytics.mjs
//
// Synthetic sample-data seeder for the /analytics correlation demo.
//
// Seeds 3 clearly-labeled fake campaigns × 40 measured deals with ENGINEERED
// spreads so the correlation engine (src/lib/correlation.ts) demonstrably
// finds what it should — and refuses to find what isn't there:
//   * email leads the channel factor
//   * 25k–80k followers is the efficiency sweet spot (hump, not monotone)
//   * perceived generosity has a hump at 1.0–1.3× tier base
//   * price-give has a visible NEGATIVE slope
//   * hip-hop (off-genre control) converts worst
//   * send window is DELIBERATELY null-effect — the card must honestly say
//     "no clear trend" (the honesty IS the feature)
//   * pooled 40 deals reach the 'high' confidence tier while each single
//     sample campaign (13–14 deals) sits at 'low' — the ladder is visible
//
// Every synthetic row is triple-labeled:
//   1. campaigns.synthetic = true (+ influencers.synthetic = true)
//   2. '[SAMPLE]' prefix on every human-visible name/subject
//   3. campaign_outcomes.streams_attribution_method = 'synthetic_sample'
// plus namespace ownership: usernames 'sample_demo_*'.
//
// DETERMINISTIC: fixed-seed mulberry32 PRNG — every run generates identical
// data; lookup-then-insert on natural keys makes re-runs converge to no-ops.
// Timestamps derive from a fixed base date, never Date.now().
//
// Usage (seed and remove also need CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1):
//   npx tsx tools/seed-sample-analytics.mjs            # seed + verify
//   npx tsx tools/seed-sample-analytics.mjs --verify   # offline engine check only (no DB)
//   npx tsx tools/seed-sample-analytics.mjs --remove   # delete everything this seeder owns
//   ... --firm <uuid>                                  # pick the firm; required when more than one exists

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

import { requireProdWriteConsent } from './_guard.mjs';

const MODE = process.argv.includes('--remove')
  ? 'remove'
  : process.argv.includes('--verify')
    ? 'verify'
    : 'seed';

// ─── Deterministic PRNG (mulberry32, fixed seed) ──────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 0xa53a17;

// ─── Engineered-spread constants ──────────────────────────────────────────
// Multiplier table, with three empirically-tuned deviations from the first
// illustrative constants (the spreads must actually produce the designed
// correlations THROUGH the committed engine, and that requirement wins):
//   * GIVE_SLOPE 0.4 → 1.7 + bimodal give targets: with five independent
//     multipliers stacked, the original 0.4 slope left marginal Spearman
//     ρ ≈ −0.1 (t < 1) — a real effect the engine (correctly) refused to
//     call a trend. 1.7 lands ρ ≈ −0.58 through the engine.
//   * noise ±25% → ±15% for the same reason.
//   * hip-hop 0.7 → 0.55: at n = 5 the off-genre control needs more
//     separation to sit lowest against cross-factor luck.
const BASE_STREAMS_PER_DOLLAR = 300; // near rl-pricing's 333 fallback — plausible, never real
const GIVE_SLOPE = 1.7;
const NOISE_MIN = 0.85;
const NOISE_SPAN = 0.3;

const CAMPAIGNS = [
  { artist: '[SAMPLE] Ridgeline Drive', genre: 'indie' },
  { artist: '[SAMPLE] Neon Harbor', genre: 'pop' },
  { artist: '[SAMPLE] Quiet Mile', genre: 'folk' },
];
const N_DEALS = 40; // 14 + 13 + 13 across the three campaigns

// Mirrors pricing-engine.ts TIER_TABLE (strict <). Inlined because this
// seeder must run under plain `node` where the .ts import is unavailable.
function tierBaseUsd(fc) {
  if (fc < 10_000) return 50;
  if (fc < 50_000) return 100;
  if (fc < 250_000) return 250;
  return 500;
}

// Follower strata — deliberate mass in every tier (i % 4 → 10 rows each).
// Quartile edges of the pooled distribution then land on the band borders,
// so the engine's k=4 quantile buckets reproduce the engineered bands.
const FOLLOWER_STRATA = [
  [3_000, 24_000], // below the sweet spot  → M 0.8
  [25_000, 79_000], // the sweet spot        → M 1.3
  [81_000, 149_000], // above it              → M 1.0
  [151_000, 299_000], // way above             → M 0.6
];

// Cycle lengths 4 / 5 / 7 / 11 are pairwise coprime-ish → categorical
// factors stay quasi-orthogonal to the follower strata and to each other,
// so each factor's marginal signal isn't confounded by the others.
const CHANNELS = ['email', 'instagram_dm', 'email', 'tiktok_dm', 'email']; // i % 5 → 24/8/8
const GENRES = ['indie', 'pop', 'indie-pop', 'folk', 'indie', 'hip-hop', 'indie-pop']; // i % 7
const GENEROSITY_TARGETS = [0.72, 1.12, 0.85, 1.22, 0.66, 1.18, 1.05, 0.92, 1.28]; // i % 9 — mass at 1.0–1.3
const GIVE_TARGETS = [-0.04, 0.42, 0.02, 0.38, 0.0, 0.44, 0.06, 0.4, 0.04, 0.36, 0.2]; // i % 11 — spans −0.05…0.45, bimodal for rank separation
// Send window — deliberately NO effect on streams. Assigned by
// floor(i/4) % 4 so each window draws evenly from every follower stratum.
const SEND_WINDOWS = [
  { label: 'night', hour: 3 },
  { label: 'morning', hour: 9 },
  { label: 'afternoon', hour: 14 },
  { label: 'evening', hour: 20 },
];
const PROMO_PLATFORMS = ['tiktok', 'tiktok', 'instagram', 'tiktok', 'tiktok', 'youtube', 'tiktok', 'tiktok', 'instagram', 'tiktok']; // i % 10 → 28/8/4

const USERNAME_WORDS = ['cedar', 'dune', 'harbor', 'mile', 'ridge', 'pine', 'creek', 'vale', 'sage', 'flint'];

const M_CHANNEL = { email: 1.0, instagram_dm: 0.7, tiktok_dm: 0.5 };
const M_GENRE = { indie: 1.2, 'indie-pop': 1.2, folk: 1.1, pop: 1.0, 'hip-hop': 0.55 };
function mFollower(fc) {
  if (fc < 25_000) return 0.8;
  if (fc < 80_000) return 1.3;
  if (fc < 150_000) return 1.0;
  return 0.6;
}
function mGenerosity(g) {
  if (g < 0.8) return 0.8;
  if (g < 1.0) return 1.0;
  if (g <= 1.3) return 1.25; // the sweet spot
  if (g <= 1.6) return 1.0;
  return 0.7; // overshooting generosity buys nothing
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const pad2 = (n) => String(n).padStart(2, '0');

// ─── Pure deterministic dataset (shared by seed / verify / remove) ────────
export function generateSampleData() {
  const rand = mulberry32(SEED);
  const deals = [];
  for (let i = 0; i < N_DEALS; i++) {
    // Fixed number of PRNG draws per row so tuning any constant never
    // shifts the random stream of later rows.
    const draws = [rand(), rand(), rand(), rand(), rand()];
    const [fFrac, engFrac, gJit, noiseFrac, urlFrac] = draws;

    const campaignIdx = i % 3; // 14 / 13 / 13
    const [fLo, fHi] = FOLLOWER_STRATA[i % 4];
    const follower_count = Math.round(fLo + fFrac * (fHi - fLo));
    const tierBase = tierBaseUsd(follower_count);
    const channel = CHANNELS[i % 5];
    const genre = GENRES[i % 7];
    const window = SEND_WINDOWS[Math.floor(i / 4) % 4];
    const engagement_rate = Math.round((0.015 + engFrac * 0.065) * 10_000) / 10_000;

    // Generosity target, clamped to what the tier can plausibly reach with
    // ceiling $250 (mid tier can't exceed 1.0×base without busting the cap).
    let g = GENEROSITY_TARGETS[i % 9] + (gJit - 0.5) * 0.1;
    if (tierBase === 250) g = clamp(g, 0.65, 1.0);
    else if (tierBase === 500) g = clamp(g, 0.42, 0.5);
    else g = clamp(g, 0.5, 2.0);

    const ceiling_usd = 250;
    const agreed_amount_usd = clamp(Math.round(g * tierBase), 20, ceiling_usd);
    // Derive the opening from the give target (initial = agreed − give×ceiling)
    // so give and generosity stay independently spread; clamp the opening to a
    // plausible band and recompute the actual give from what survived.
    const giveTarget = GIVE_TARGETS[i % 11];
    let initial_offer_usd = Math.round(agreed_amount_usd - giveTarget * ceiling_usd);
    initial_offer_usd = clamp(initial_offer_usd, Math.max(15, Math.round(0.35 * tierBase)), Math.min(Math.round(0.95 * tierBase), 240));

    // Same formulas as src/lib/deal-economics.ts computeDealEconomics —
    // pre-stamped so the demo needs no negotiation tick.
    const perceived_generosity = agreed_amount_usd / tierBase;
    const price_give_pct = (agreed_amount_usd - initial_offer_usd) / ceiling_usd;

    // Engineered outcome (multiplier table above; send window absent on purpose).
    const noise = NOISE_MIN + NOISE_SPAN * noiseFrac;
    const mGive = 1 - GIVE_SLOPE * clamp(price_give_pct, 0, 1);
    const streams = Math.round(
      agreed_amount_usd * BASE_STREAMS_PER_DOLLAR *
        mFollower(follower_count) * M_CHANNEL[channel] *
        mGenerosity(perceived_generosity) * mGive * M_GENRE[genre] * noise,
    );

    // Fixed-base timestamps (never Date.now): sent early June 2026 in the
    // assigned UTC window, paid → posted → measured later that month.
    const sentDay = 3 + (i % 9);
    const sent_at = `2026-06-${pad2(sentDay)}T${pad2(window.hour)}:${pad2((i * 7) % 60)}:00.000Z`;
    const paid_at = `2026-06-${pad2(sentDay + 7)}T15:00:00.000Z`;
    const posted_at = `2026-06-${pad2(sentDay + 9)}T18:00:00.000Z`;
    const measured_at = '2026-07-05T12:00:00.000Z';

    const username = `sample_demo_${USERNAME_WORDS[i % 10]}${pad2(i)}`;
    const promoPlatform = PROMO_PLATFORMS[i % 10];
    const videoId = `7${String(Math.floor(urlFrac * 1e9)).padStart(9, '0')}`;
    const post_url =
      promoPlatform === 'tiktok'
        ? `https://www.tiktok.com/@${username}/video/${videoId}`
        : promoPlatform === 'instagram'
          ? `https://www.instagram.com/p/SAMPLE${pad2(i)}/`
          : `https://www.youtube.com/watch?v=SAMPLE${pad2(i)}`;

    deals.push({
      i,
      campaignIdx,
      username,
      display_name: `[SAMPLE] ${USERNAME_WORDS[i % 10][0].toUpperCase()}${USERNAME_WORDS[i % 10].slice(1)} ${pad2(i)}`,
      follower_count,
      engagement_rate,
      genre,
      channel,
      send_window: window.label,
      sent_at,
      paid_at,
      posted_at,
      measured_at,
      ceiling_usd,
      initial_offer_usd,
      agreed_amount_usd,
      rounds: 1 + (i % 3),
      opening_pct: Math.round((initial_offer_usd / ceiling_usd) * 10_000) / 10_000,
      perceived_generosity: Math.round(perceived_generosity * 10_000) / 10_000,
      price_give_pct: Math.round(price_give_pct * 10_000) / 10_000,
      post_url,
      streams,
    });
  }
  return deals;
}

// ─── Offline engine verification ──────────────────────────────────────────
// Assembles the exact rows the API route would build and runs the COMMITTED
// engine over them — asserting every engineered direction + confidence tier.
// Run it with tsx (the engine is TypeScript). A failed import throws, so the
// CI demo check cannot pass without running the engine.
async function verifyThroughEngine(deals) {
  const { buildDealFactorRows, computeCorrelationReport } = await import(
    new URL('../src/lib/correlation.ts', import.meta.url).href
  );

  const input = {
    campaigns: CAMPAIGNS.map((_, k) => ({ id: `camp-${k}`, synthetic: true })),
    offers: deals.map((d) => ({
      id: `offer-${d.i}`,
      campaign_id: `camp-${d.campaignIdx}`,
      campaign_influencer_id: `ci-${d.i}`,
      agreed_amount_usd: d.agreed_amount_usd,
      initial_offer_usd: d.initial_offer_usd,
      ceiling_usd: d.ceiling_usd,
      perceived_generosity: d.perceived_generosity,
      price_give_pct: d.price_give_pct,
      post_url: d.post_url,
    })),
    outcomes: deals.map((d) => ({
      creator_offer_id: `offer-${d.i}`,
      streams_attributed: d.streams,
      payment_usd_amount: d.agreed_amount_usd,
      follower_count_at_post: d.follower_count,
      engagement_at_post: d.engagement_rate,
    })),
    cis: deals.map((d) => ({
      id: `ci-${d.i}`,
      campaign_id: `camp-${d.campaignIdx}`,
      influencer_id: `inf-${d.i}`,
      primary_channel: d.channel,
    })),
    influencers: deals.map((d) => ({
      id: `inf-${d.i}`,
      follower_count: d.follower_count,
      engagement_rate: d.engagement_rate,
      content_genres: [d.genre],
    })),
    firstSends: deals.map((d) => ({
      campaign_influencer_id: `ci-${d.i}`,
      channel: d.channel,
      sent_at: d.sent_at,
    })),
  };

  const rows = buildDealFactorRows(input);
  const pooled = computeCorrelationReport(rows, {
    kind: 'pool',
    campaign_ids: CAMPAIGNS.map((_, k) => `camp-${k}`),
    synthetic: true,
  });
  const perCampaign = CAMPAIGNS.map((_, k) =>
    computeCorrelationReport(
      rows.filter((r) => r.campaign_id === `camp-${k}`),
      { kind: 'campaign', campaign_ids: [`camp-${k}`], synthetic: true },
    ),
  );

  const f = (id) => pooled.factors.find((x) => x.factor === id);
  const claim = (r) =>
    r.kind === 'numeric' ? `direction=${r.direction}${r.spearman_rho != null ? ` (ρ=${r.spearman_rho.toFixed(2)})` : ''}` : `leader=${r.leader ?? 'none'}`;

  console.log('');
  console.log('── engine verification (pooled sample scope, n=40) ──');
  for (const r of pooled.factors) {
    console.log(`  ${r.factor.padEnd(21)} n=${String(r.n).padEnd(3)} tier=${r.confidence.tier.padEnd(12)} ${claim(r)}`);
  }
  for (const [k, rep] of perCampaign.entries()) {
    const ch = rep.factors.find((x) => x.factor === 'channel');
    console.log(`  ${CAMPAIGNS[k].artist}: deals_measured=${rep.deals_measured}, channel tier=${ch.confidence.tier}`);
  }

  const failures = [];
  let checked = 0;
  const assert = (cond, msg) => {
    checked++;
    if (!cond) failures.push(msg);
  };

  assert(pooled.deals_measured === 40, `pooled deals_measured 40, got ${pooled.deals_measured}`);

  // email leads the channel factor at high confidence
  const channel = f('channel');
  assert(channel.leader === 'email', `channel leader email, got ${channel.leader}`);
  assert(channel.confidence.tier === 'high', `channel tier high, got ${channel.confidence.tier}`);

  // follower sweet spot: max-mean bucket overlaps 25k–80k and beats both edges (hump)
  const fol = f('follower_count');
  assert(fol.confidence.tier === 'high', `follower tier high, got ${fol.confidence.tier}`);
  const folMax = fol.buckets.reduce((a, b) => (b.mean_outcome > a.mean_outcome ? b : a));
  assert(folMax.lo < 80_000 && folMax.hi > 25_000, `follower max-mean bucket overlaps 25k–80k, got ${folMax.label}`);
  assert(
    folMax.mean_outcome > fol.buckets[0].mean_outcome && folMax.mean_outcome > fol.buckets[fol.buckets.length - 1].mean_outcome,
    'follower sweet-spot bucket beats both edge buckets',
  );

  // generosity hump at 1.0–1.3
  const gen = f('perceived_generosity');
  const genMax = gen.buckets.reduce((a, b) => (b.mean_outcome > a.mean_outcome ? b : a));
  assert(genMax.lo < 1.3 && genMax.hi > 1.0, `generosity max-mean bucket overlaps 1.0–1.3, got ${genMax.label}`);

  // price-give: visible negative slope
  const give = f('price_give_pct');
  assert(give.direction === 'negative', `price_give direction negative, got ${give.direction} (ρ=${give.spearman_rho?.toFixed(2)})`);

  // send window: deliberately null-effect — no leader may be named
  const sw = f('send_window');
  assert(sw.leader === null, `send_window leader null (no clear trend), got ${sw.leader}`);
  assert(sw.confidence.tier === 'high', `send_window tier high (n=40 honesty at full confidence), got ${sw.confidence.tier}`);

  // off-genre control: hip-hop converts worst among named groups
  const genreF = f('genre');
  const hip = genreF.groups.find((x) => x.value === 'hip-hop');
  assert(hip != null && hip.n >= 3, 'hip-hop control group present with n ≥ 3');
  if (hip) assert(genreF.groups.every((x) => x.value === 'hip-hop' || x.mean_outcome > hip.mean_outcome), 'hip-hop has the lowest group mean');

  // paying more buys more raw output (price vs raw streams — positive by construction)
  const price = f('price_usd');
  assert(price.direction === 'positive', `price_usd direction positive, got ${price.direction}`);

  // the confidence ladder itself: pooled high, each single campaign low
  for (const [k, rep] of perCampaign.entries()) {
    const ch = rep.factors.find((x) => x.factor === 'channel');
    assert(ch.confidence.tier === 'low', `${CAMPAIGNS[k].artist} channel tier low (n=${ch.n}), got ${ch.confidence.tier}`);
  }
  const measuredCounts = perCampaign.map((r) => r.deals_measured).join('/');
  assert(measuredCounts === '14/13/13', `per-campaign deals 14/13/13, got ${measuredCounts}`);

  console.log('');
  if (failures.length === 0) {
    console.log(`  ✓ all ${checked} engineered-spread assertions pass through the committed engine`);
    return true;
  }
  for (const m of failures) console.error(`  ✗ ${m}`);
  return false;
}

// ─── DB helpers ────────────────────────────────────────────────────────────
function adminClient() {
  config({ path: '.env.local' });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required');
    process.exit(1);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// --firm <uuid> picks the firm; without it there must be exactly one.
async function loadFirm(sb) {
  const flag = process.argv.indexOf('--firm');
  const firmId = flag > -1 ? process.argv[flag + 1] : null;
  if (flag > -1 && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(firmId ?? '')) {
    console.error('--firm needs a firm uuid');
    process.exit(1);
  }
  const base = sb.from('firms').select('id, name');
  const { data: firms, error } = await (firmId ? base.eq('id', firmId) : base.limit(2));
  if (error || !firms?.length) {
    console.error('Could not load firm:', error?.message ?? (firmId ? `no firm ${firmId}` : 'no firm rows'));
    process.exit(1);
  }
  if (firms.length > 1) {
    console.error('More than one firm exists; pass --firm <uuid> to choose one.');
    process.exit(1);
  }
  return firms[0];
}

const die = (label, error) => {
  console.error(`${label} failed:`, error.message);
  process.exit(1);
};

// ─── Seed ──────────────────────────────────────────────────────────────────
async function seed() {
  requireProdWriteConsent({ tool: 'seed-sample-analytics', writes: ['campaigns', 'influencers', 'campaign_influencers', 'outreach_messages', 'creator_offers', 'campaign_outcomes'], target: 'the firm it resolves (--firm or the only firm)' });
  const sb = adminClient();
  const firm = await loadFirm(sb);
  console.log(`firm: ${firm.name} (${firm.id})`);
  const deals = generateSampleData();
  const counts = {};

  // 1. Campaigns — natural key (firm_id, artist_name).
  const names = CAMPAIGNS.map((c) => c.artist);
  const { data: existingCamps, error: cErr } = await sb
    .from('campaigns')
    .select('id, artist_name')
    .eq('firm_id', firm.id)
    .in('artist_name', names);
  if (cErr) die('campaign lookup', cErr);
  const campIdByName = new Map((existingCamps ?? []).map((c) => [c.artist_name, c.id]));
  counts.campaigns = { created: 0, existing: campIdByName.size };
  for (const c of CAMPAIGNS) {
    const row = {
      firm_id: firm.id,
      artist_name: c.artist,
      synthetic: true,
      status: 'completed', // never hijacks the Pipeline hero pick
      confirmed_at: '2026-06-02T12:00:00.000Z',
      total_budget_usd: 4000,
      per_creator_cap_usd: 250,
      target_platforms: ['tiktok'],
      artist_data: { note: 'Fabricated sample campaign for the analytics demo. Every row is synthetic.' },
      special_instructions: '[SAMPLE] Fabricated demo data — not a real campaign.',
    };
    if (campIdByName.has(c.artist)) {
      const { error } = await sb.from('campaigns').update(row).eq('id', campIdByName.get(c.artist));
      if (error) die(`campaign update ${c.artist}`, error);
    } else {
      const { data, error } = await sb.from('campaigns').insert(row).select('id').single();
      if (error) die(`campaign insert ${c.artist}`, error);
      campIdByName.set(c.artist, data.id);
      counts.campaigns.created++;
    }
  }
  const campaignIds = CAMPAIGNS.map((c) => campIdByName.get(c.artist));

  // 2. Influencers — natural key (platform, username).
  const usernames = deals.map((d) => d.username);
  const { data: existingInf, error: iErr } = await sb
    .from('influencers')
    .select('id, username')
    .eq('platform', 'tiktok')
    .in('username', usernames);
  if (iErr) die('influencer lookup', iErr);
  const infIdByUsername = new Map((existingInf ?? []).map((r) => [r.username, r.id]));
  counts.influencers = { created: 0, existing: infIdByUsername.size };
  for (const d of deals) {
    const row = {
      platform: 'tiktok',
      username: d.username,
      display_name: d.display_name,
      profile_url: `https://www.tiktok.com/@${d.username}`,
      follower_count: d.follower_count,
      engagement_rate: d.engagement_rate,
      content_genres: [d.genre],
      bio: '[SAMPLE] Fabricated creator profile for the analytics demo.',
      synthetic: true,
    };
    if (infIdByUsername.has(d.username)) {
      const { error } = await sb.from('influencers').update(row).eq('id', infIdByUsername.get(d.username));
      if (error) die(`influencer update ${d.username}`, error);
    } else {
      const { data, error } = await sb.from('influencers').insert(row).select('id').single();
      if (error) die(`influencer insert ${d.username}`, error);
      infIdByUsername.set(d.username, data.id);
      counts.influencers.created++;
    }
  }

  // 3. campaign_influencers — natural key (campaign_id, influencer_id).
  const { data: existingCi, error: ciErr } = await sb
    .from('campaign_influencers')
    .select('id, campaign_id, influencer_id')
    .in('campaign_id', campaignIds);
  if (ciErr) die('campaign_influencer lookup', ciErr);
  const ciIdByKey = new Map((existingCi ?? []).map((r) => [`${r.campaign_id}:${r.influencer_id}`, r.id]));
  counts.campaign_influencers = { created: 0, existing: ciIdByKey.size };
  for (const d of deals) {
    const campaign_id = campaignIds[d.campaignIdx];
    const influencer_id = infIdByUsername.get(d.username);
    const key = `${campaign_id}:${influencer_id}`;
    const row = {
      campaign_id,
      influencer_id,
      status: 'contacted',
      outreach_status: 'responded',
      primary_channel: d.channel,
    };
    if (ciIdByKey.has(key)) {
      const { error } = await sb.from('campaign_influencers').update(row).eq('id', ciIdByKey.get(key));
      if (error) die(`ci update ${d.username}`, error);
    } else {
      const { data, error } = await sb.from('campaign_influencers').insert(row).select('id').single();
      if (error) die(`ci insert ${d.username}`, error);
      ciIdByKey.set(key, data.id);
      counts.campaign_influencers.created++;
    }
  }
  const ciIdFor = (d) => ciIdByKey.get(`${campaignIds[d.campaignIdx]}:${infIdByUsername.get(d.username)}`);

  // 4. outreach_messages — exactly one outbound per CI (natural key: the CI).
  const allCiIds = deals.map((d) => ciIdFor(d));
  const { data: existingMsgs, error: mErr } = await sb
    .from('outreach_messages')
    .select('id, campaign_influencer_id')
    .in('campaign_influencer_id', allCiIds)
    .eq('direction', 'outbound');
  if (mErr) die('outreach lookup', mErr);
  const msgIdByCi = new Map((existingMsgs ?? []).map((r) => [r.campaign_influencer_id, r.id]));
  counts.outreach_messages = { created: 0, existing: msgIdByCi.size };
  for (const d of deals) {
    const ci = ciIdFor(d);
    const row = {
      campaign_influencer_id: ci,
      message_type: 'outreach',
      direction: 'outbound',
      status: 'sent',
      channel: d.channel,
      subject: `[SAMPLE] collab — ${CAMPAIGNS[d.campaignIdx].artist.replace('[SAMPLE] ', '')}`,
      body: 'This is a fabricated sample outreach message generated by tools/seed-sample-analytics.mjs for the analytics demo. It was never sent to anyone.',
      sent_at: d.sent_at,
    };
    if (msgIdByCi.has(ci)) {
      const { error } = await sb.from('outreach_messages').update(row).eq('id', msgIdByCi.get(ci));
      if (error) die(`outreach update ${d.username}`, error);
    } else {
      const { error } = await sb.from('outreach_messages').insert(row);
      if (error) die(`outreach insert ${d.username}`, error);
      counts.outreach_messages.created++;
    }
  }

  // 5. creator_offers — one per CI, pre-stamped economics (the
  //    demo needs no tick; formulas mirror deal-economics.ts exactly).
  const { data: existingOffers, error: oErr } = await sb
    .from('creator_offers')
    .select('id, campaign_influencer_id')
    .in('campaign_influencer_id', allCiIds);
  if (oErr) die('offer lookup', oErr);
  const offerIdByCi = new Map((existingOffers ?? []).map((r) => [r.campaign_influencer_id, r.id]));
  counts.creator_offers = { created: 0, existing: offerIdByCi.size };
  for (const d of deals) {
    const ci = ciIdFor(d);
    const row = {
      campaign_influencer_id: ci,
      campaign_id: campaignIds[d.campaignIdx],
      firm_id: firm.id,
      status: 'measured',
      initial_offer_usd: d.initial_offer_usd,
      current_offer_usd: d.agreed_amount_usd,
      agreed_amount_usd: d.agreed_amount_usd,
      ceiling_usd: d.ceiling_usd,
      rounds: d.rounds,
      opening_pct: d.opening_pct,
      post_url: d.post_url,
      posted_at: d.posted_at,
      paid_at: d.paid_at,
      autonomy_mode: 'manual',
      perceived_generosity: d.perceived_generosity,
      price_give_pct: d.price_give_pct,
      economics_computed_at: d.measured_at,
    };
    if (offerIdByCi.has(ci)) {
      const { error } = await sb.from('creator_offers').update(row).eq('id', offerIdByCi.get(ci));
      if (error) die(`offer update ${d.username}`, error);
    } else {
      const { data, error } = await sb.from('creator_offers').insert(row).select('id').single();
      if (error) die(`offer insert ${d.username}`, error);
      offerIdByCi.set(ci, data.id);
      counts.creator_offers.created++;
    }
  }

  // 6. campaign_outcomes — unique on creator_offer_id (migration 012) →
  //    true upsert. streams_attribution_method = 'synthetic_sample' is the
  //    third leg of the triple label.
  counts.campaign_outcomes = { created: 0, existing: 0 };
  for (const d of deals) {
    const creator_offer_id = offerIdByCi.get(ciIdFor(d));
    const { data: existing } = await sb
      .from('campaign_outcomes')
      .select('id')
      .eq('creator_offer_id', creator_offer_id)
      .maybeSingle();
    if (existing) counts.campaign_outcomes.existing++;
    else counts.campaign_outcomes.created++;
    const { error } = await sb.from('campaign_outcomes').upsert(
      {
        campaign_id: campaignIds[d.campaignIdx],
        creator_offer_id,
        streams_attributed: d.streams,
        streams_attribution_method: 'synthetic_sample',
        follower_count_at_post: d.follower_count,
        engagement_at_post: d.engagement_rate,
        payment_usd_amount: d.agreed_amount_usd,
        measured_at: d.measured_at,
      },
      { onConflict: 'creator_offer_id' },
    );
    if (error) die(`outcome upsert ${d.username}`, error);
  }

  console.log('');
  console.log('seeded (created / already-present):');
  for (const [table, c] of Object.entries(counts)) {
    console.log(`  ${table.padEnd(21)} ${c.created} created, ${c.existing} existing`);
  }

  const ok = await verifyThroughEngine(deals);
  console.log('');
  // 'Sample data (multi-campaign demo)' is operator-only; every user sees the campaigns.
  console.log("open /analytics and pick a [SAMPLE] campaign under 'Results for'");
  if (!ok) process.exit(1);
}

// ─── Remove — fully reversible, touches ONLY this seeder's namespaces ─────
async function remove() {
  requireProdWriteConsent({ tool: 'seed-sample-analytics --remove', writes: ['campaigns', 'influencers', 'campaign_influencers', 'outreach_messages', 'creator_offers', 'campaign_outcomes'], target: 'the [SAMPLE] rows this seeder owns' });
  const sb = adminClient();
  const firm = await loadFirm(sb);
  console.log(`firm: ${firm.name} (${firm.id})`);

  const { data: camps, error: cErr } = await sb
    .from('campaigns')
    .select('id, artist_name')
    .eq('firm_id', firm.id)
    .eq('synthetic', true)
    .like('artist_name', '[SAMPLE]%');
  if (cErr) die('campaign lookup', cErr);
  const campaignIds = (camps ?? []).map((c) => c.id);

  const deleted = {};
  const del = async (table, build) => {
    const { data, error } = await build(sb.from(table).delete()).select('id');
    if (error) die(`${table} delete`, error);
    deleted[table] = (data ?? []).length;
  };

  if (campaignIds.length > 0) {
    const { data: cis, error: ciErr } = await sb
      .from('campaign_influencers')
      .select('id')
      .in('campaign_id', campaignIds);
    if (ciErr) die('ci lookup', ciErr);
    const ciIds = (cis ?? []).map((r) => r.id);

    // FK order: outcomes → offers → messages → CIs → campaigns.
    await del('campaign_outcomes', (q) => q.in('campaign_id', campaignIds));
    await del('creator_offers', (q) => q.in('campaign_id', campaignIds));
    if (ciIds.length > 0) await del('outreach_messages', (q) => q.in('campaign_influencer_id', ciIds));
    else deleted.outreach_messages = 0;
    await del('campaign_influencers', (q) => q.in('campaign_id', campaignIds));
    await del('campaigns', (q) => q.in('id', campaignIds));
  } else {
    Object.assign(deleted, { campaign_outcomes: 0, creator_offers: 0, outreach_messages: 0, campaign_influencers: 0, campaigns: 0 });
  }

  // Influencers by their own namespace (synthetic AND sample_demo_*).
  await del('influencers', (q) => q.eq('synthetic', true).like('username', 'sample_demo_%'));

  console.log('');
  console.log('removed:');
  for (const [table, n] of Object.entries(deleted)) console.log(`  ${table.padEnd(21)} ${n}`);
}

// ─── Entry (skipped when imported — generateSampleData is side-effect free) ─
const isMain =
  process.argv[1] != null &&
  import.meta.url === new URL(`file://${process.argv[1].startsWith('/') ? '' : '/'}${process.argv[1]}`).href;
if (isMain) {
  if (MODE === 'verify') {
    const ok = await verifyThroughEngine(generateSampleData());
    process.exit(ok ? 0 : 1);
  } else if (MODE === 'remove') {
    await remove();
  } else {
    await seed();
  }
}
