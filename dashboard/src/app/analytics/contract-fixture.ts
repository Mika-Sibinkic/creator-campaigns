// src/app/analytics/contract-fixture.ts
//
// Contract fixture — the CLEARLY-MARKED fallback the page uses ONLY when
// the /api/analytics/correlations endpoint is unavailable (route not
// deployed) or when forced via ?mock=1. The
// page renders a loud "CONTRACT FIXTURE" banner whenever this module supplies
// the data; it is never silently substituted for live numbers.
//
// Every value is hand-written to mirror the §8 seeder's designed signal shape
// so the page's states are all visually verifiable before real data exists:
//   - channel        → clear leader (email ≥ 1.2× next)
//   - generosity     → sweet-spot hump with ρ ≈ 0 (the chart carries what ρ can't)
//   - price-give     → visible negative trend
//   - send window    → honestly "no clear trend" (the honesty IS the feature)
//   - promo activity → one n<3 small-sample group (muted bar + explicit tag)
//   - pooled sample  → n=40 ⇒ high tier; single sample campaign ⇒ low tier
//     (the confidence ladder is itself visible in the demo)
//   - real scope     → deliberately EMPTY (0 measured deals) — the page's
//     empty state is part of the contract too.
//
// The tier thresholds + min(1, n/30) score here restate §5.4 for fixture
// purposes only; src/lib/correlation.ts is the source of truth.

import {
  FACTORS,
  type CampaignOption,
  type CategoricalFactorResult,
  type Confidence,
  type CorrelationReport,
  type CorrelationsResponse,
  type FactorId,
  type FactorResult,
  type NumericFactorResult,
} from './contract';

// ---------------------------------------------------------------------------
// confidence (fixture-local restatement of §5.4)

function conf(n: number): Confidence {
  const tier = n < 5 ? 'insufficient' : n < 15 ? 'low' : n < 40 ? 'medium' : 'high';
  const score = Math.min(1, n / 30);
  const reason =
    tier === 'insufficient'
      ? `insufficient: ${n} measured deal${n === 1 ? '' : 's'} with this factor (need 5 for low)`
      : tier === 'low'
        ? `low: ${n} measured deals with this factor (need 15 for medium)`
        : tier === 'medium'
          ? `medium: ${n} measured deals with this factor (need 40 for high)`
          : `high: ${n} measured deals with this factor`;
  return { tier, n, score, reason };
}

// ---------------------------------------------------------------------------
// builders

function reg(id: FactorId) {
  const f = FACTORS.find((f) => f.id === id);
  if (!f) throw new Error(`unknown factor ${id}`);
  return f;
}

function numeric(
  id: FactorId,
  opts: {
    n: number;
    rho: number | null;
    t: number | null;
    direction: NumericFactorResult['direction'];
    buckets: Array<[label: string, lo: number, hi: number, n: number, mean: number]>;
    notes?: string[];
  }
): NumericFactorResult {
  const { label, question, outcome } = reg(id);
  return {
    kind: 'numeric',
    factor: id,
    label,
    question,
    outcome,
    n: opts.n,
    spearman_rho: opts.rho,
    t_stat: opts.t,
    direction: opts.direction,
    buckets: opts.buckets.map(([label, lo, hi, n, mean_outcome]) => ({ label, lo, hi, n, mean_outcome })),
    confidence: conf(opts.n),
    notes: opts.notes ?? [],
  };
}

function categorical(
  id: FactorId,
  opts: {
    n: number;
    leader: string | null;
    groups: Array<[value: string, n: number, mean: number]>;
    notes?: string[];
  }
): CategoricalFactorResult {
  const { label, question, outcome } = reg(id);
  return {
    kind: 'categorical',
    factor: id,
    label,
    question,
    outcome,
    n: opts.n,
    groups: opts.groups.map(([value, n, mean_outcome]) => ({
      value,
      n,
      mean_outcome,
      small_sample: n < 3,
    })),
    leader: opts.leader,
    confidence: conf(opts.n),
    notes: opts.notes ?? [],
  };
}

// ---------------------------------------------------------------------------
// fixture campaigns (§8 shapes: 3 sample campaigns, 14+13+13 = 40 deals)

const ADA = 'fixture-ada-sample';
const RIDGELINE = 'fixture-sample-ridgeline';
const NEON = 'fixture-sample-neon';
const QUIET = 'fixture-sample-quiet';

const FIXTURE_CAMPAIGNS: CampaignOption[] = [
  { id: ADA, artist_name: 'Ada Sample', synthetic: false, deals_measured: 0 },
  { id: RIDGELINE, artist_name: '[SAMPLE] Ridgeline Drive', synthetic: true, deals_measured: 14 },
  { id: NEON, artist_name: '[SAMPLE] Neon Harbor', synthetic: true, deals_measured: 13 },
  { id: QUIET, artist_name: '[SAMPLE] Quiet Mile', synthetic: true, deals_measured: 13 },
];

// ---------------------------------------------------------------------------
// pooled sample report — n=40 ⇒ high tier, every designed signal visible

function sampleFactors(): FactorResult[] {
  return [
    // hump at 24k–78k; monotone ρ near 0 ⇒ the bucket chart carries the story
    numeric('follower_count', {
      n: 40,
      rho: -0.21,
      t: 1.32,
      direction: 'none',
      buckets: [
        ['3k–24k', 3_000, 24_000, 10, 246],
        ['24k–78k', 24_000, 78_000, 10, 392],
        ['78k–150k', 78_000, 150_000, 10, 297],
        ['150k–300k', 150_000, 300_000, 10, 181],
      ],
    }),
    numeric('engagement_rate', {
      n: 40,
      rho: 0.18,
      t: 1.13,
      direction: 'none',
      buckets: [
        ['1.5–2.9%', 0.015, 0.029, 10, 268],
        ['2.9–4.4%', 0.029, 0.044, 10, 291],
        ['4.4–6.1%', 0.044, 0.061, 10, 305],
        ['6.1–8.0%', 0.061, 0.08, 10, 322],
      ],
    }),
    // top two genres within 20% ⇒ no leader call (§5.3 rule)
    categorical('genre', {
      n: 40,
      leader: null,
      groups: [
        ['indie', 12, 358],
        ['indie-pop', 8, 341],
        ['folk', 8, 296],
        ['pop', 7, 262],
        ['hip-hop', 5, 174],
      ],
      notes: ['top two groups are within 20% of each other, so no leader is claimed'],
    }),
    // raw streams outcome (spd would be mechanically negative — §5.2 rationale)
    numeric('price_usd', {
      n: 40,
      rho: 0.56,
      t: 4.17,
      direction: 'positive',
      buckets: [
        ['$52–$78', 52, 78, 10, 22_400],
        ['$78–$102', 78, 102, 10, 30_150],
        ['$102–$148', 102, 148, 10, 39_800],
        ['$148–$230', 148, 230, 10, 47_600],
      ],
    }),
    // the sweet-spot demo: middle bucket strictly greatest, ρ ≈ 0
    numeric('perceived_generosity', {
      n: 40,
      rho: -0.05,
      t: 0.31,
      direction: 'none',
      buckets: [
        ['0.62–0.84', 0.62, 0.84, 10, 243],
        ['0.84–1.05', 0.84, 1.05, 10, 296],
        ['1.05–1.31', 1.05, 1.31, 10, 372],
        ['1.31–1.72', 1.31, 1.72, 10, 214],
      ],
    }),
    // visible negative trend: the more we conceded, the less efficient the deal
    numeric('price_give_pct', {
      n: 40,
      rho: -0.44,
      t: 3.02,
      direction: 'negative',
      buckets: [
        ['−5–8%', -0.05, 0.08, 10, 349],
        ['8–18%', 0.08, 0.18, 10, 306],
        ['18–30%', 0.18, 0.3, 10, 258],
        ['30–45%', 0.3, 0.45, 10, 205],
      ],
    }),
    // the clear-leader demo: email ≥ 1.2× next
    categorical('channel', {
      n: 40,
      leader: 'email',
      groups: [
        ['email', 20, 361],
        ['instagram_dm', 12, 252],
        ['tiktok_dm', 8, 178],
      ],
    }),
    // Deliberately null-effect — the tool must say "no clear trend"
    categorical('send_window', {
      n: 40,
      leader: null,
      groups: [
        ['morning 6–11', 11, 307],
        ['evening 18–23', 10, 298],
        ['afternoon 12–17', 12, 291],
        ['night 0–5', 7, 280],
      ],
      notes: ['top two groups are within 20% of each other, so no leader is claimed'],
    }),
    // small-sample group demo: youtube tops the sort at n=2 ⇒ muted, no leader
    categorical('promo_activity', {
      n: 34,
      leader: null,
      groups: [
        ['youtube post', 2, 344],
        ['tiktok post', 26, 302],
        ['instagram post', 6, 271],
      ],
      notes: ['top group has fewer than 3 deals, so no leader is claimed'],
    }),
  ];
}

function sampleReport(): CorrelationReport {
  return {
    scope: { kind: 'pool', campaign_ids: [RIDGELINE, NEON, QUIET], synthetic: true },
    deals_measured: 40,
    totals: { streams: 1_572_000, spend_usd: 5_240, streams_per_dollar: 300 },
    factors: sampleFactors(),
  };
}

// ---------------------------------------------------------------------------
// empty report (real scope before any outcome is recorded, or unknown campaign)

function emptyFactors(): FactorResult[] {
  return FACTORS.map((f): FactorResult => {
    const base = {
      factor: f.id,
      label: f.label,
      question: f.question,
      outcome: f.outcome,
      n: 0,
      confidence: conf(0),
      notes: ['no measured deals'],
    };
    return f.kind === 'numeric'
      ? { kind: 'numeric', ...base, spearman_rho: null, t_stat: null, direction: 'none', buckets: [] }
      : { kind: 'categorical', ...base, groups: [], leader: null };
  });
}

function emptyReport(scope: CorrelationReport['scope']): CorrelationReport {
  return {
    scope,
    deals_measured: 0,
    totals: { streams: 0, spend_usd: 0, streams_per_dollar: null },
    factors: emptyFactors(),
  };
}

// ---------------------------------------------------------------------------
// single sample campaign — the pooled factors scaled down to n≈14 so the
// confidence ladder (pool=high vs single=low) is visible. Directions drop to
// 'none' (conservative: at n≈14 the t-gate rarely clears) and leaders are
// re-derived with the §5.3 rule against the scaled group sizes.

function scaleFactor(f: FactorResult, s: number): FactorResult {
  const n = Math.round(f.n * s);
  if (f.kind === 'numeric') {
    return {
      ...f,
      n,
      t_stat: null,
      direction: 'none',
      buckets: f.buckets.slice(0, 3).map((b) => ({ ...b, n: Math.max(1, Math.round(b.n * s)) })),
      confidence: conf(n),
    };
  }
  const groups = f.groups.map((g) => {
    const gn = Math.max(1, Math.round(g.n * s));
    return { ...g, n: gn, small_sample: gn < 3 };
  });
  const leader =
    groups.length >= 2 &&
    groups[0].n >= 3 &&
    groups[1].n >= 3 &&
    groups[0].mean_outcome >= 1.2 * groups[1].mean_outcome
      ? groups[0].value
      : null;
  return { ...f, n, groups, leader, confidence: conf(n) };
}

function sampleCampaignReport(c: CampaignOption): CorrelationReport {
  const s = c.deals_measured / 40;
  return {
    scope: { kind: 'campaign', campaign_ids: [c.id], synthetic: true },
    deals_measured: c.deals_measured,
    totals: {
      streams: Math.round(1_572_000 * s),
      spend_usd: Math.round(5_240 * s),
      streams_per_dollar: 300,
    },
    factors: sampleFactors().map((f) => scaleFactor(f, s)),
  };
}

// ---------------------------------------------------------------------------
// entry point — mirrors the §6 route's scope mapping

export function fixtureResponse(scope: string): CorrelationsResponse {
  if (scope === 'sample') {
    return { campaigns: FIXTURE_CAMPAIGNS, report: sampleReport() };
  }
  if (scope === 'real') {
    return {
      campaigns: FIXTURE_CAMPAIGNS,
      report: emptyReport({ kind: 'pool', campaign_ids: [ADA], synthetic: false }),
    };
  }
  const c = FIXTURE_CAMPAIGNS.find((c) => c.id === scope);
  if (c?.synthetic) return { campaigns: FIXTURE_CAMPAIGNS, report: sampleCampaignReport(c) };
  return {
    campaigns: FIXTURE_CAMPAIGNS,
    report: emptyReport({ kind: 'campaign', campaign_ids: [scope], synthetic: false }),
  };
}
