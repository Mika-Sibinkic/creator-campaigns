// src/lib/rl-pricing.ts
//
// Reinforcement-learning skeleton for the pricing engine.
//
// The premise: trial and error is needed to learn whether higher payments to
// influencers yield better results, and a reinforcement-learning approach lets
// the model adapt to market changes over time.
//
// V1 = simple linear regression on (follower_count, payment_usd) →
// streams_per_dollar. We deliberately ship the cheapest possible model
// that gets the feedback loop wired so we can collect data, validate the
// pipeline, and prove the regression direction. Once we have ≥30-50 data
// points an upgrade to a proper learned policy (gradient-boosted trees or
// a small NN) becomes worth the complexity.
//
// Data shape — campaign_outcomes rows joined back to creator_offers:
//   { follower_count_at_post, payment_usd_amount, streams_attributed,
//     genre, engagement_at_post }
//
// Output of predict(input) — predicted streams_per_dollar at the given
// creator profile + payment. Caller decides what to do with that.

export interface OutcomeDatum {
  follower_count: number;
  payment_usd: number;
  streams_attributed: number;
  genre?: string | null;
  engagement_rate?: number | null;
}

export interface PredictInput {
  follower_count: number;
  payment_usd: number;
  genre?: string | null;
  engagement_rate?: number | null;
}

export interface PredictResult {
  predicted_streams: number;
  predicted_streams_per_dollar: number;
  confidence: number;          // 0-1, function of sample size
  method: 'linear' | 'fallback';
  sample_size: number;
}

// Threshold below which we don't trust a regression; fall back to a
// deterministic heuristic. Calibrated on a benchmark of $3000 → 1M streams
// (= 333 streams/$, with mid-tier creators being the typical buy).
const MIN_SAMPLE_FOR_REGRESSION = 8;
const FALLBACK_STREAMS_PER_DOLLAR = 333;

/**
 * Fit a 2-coefficient linear model to predict streams as a function of
 * payment_usd alone, conditioned on the creator's tier (we filter the
 * dataset to similar-follower-count creators before fitting). This is
 * intentionally crude — the goal is to have a working hook to swap a
 * better model in later, not to be the model.
 */
export function predict(
  input: PredictInput,
  history: OutcomeDatum[]
): PredictResult {
  if (history.length < MIN_SAMPLE_FOR_REGRESSION) {
    return {
      predicted_streams: Math.round(input.payment_usd * FALLBACK_STREAMS_PER_DOLLAR),
      predicted_streams_per_dollar: FALLBACK_STREAMS_PER_DOLLAR,
      confidence: 0.2,
      method: 'fallback',
      sample_size: history.length,
    };
  }

  // Filter to creators within ±50% follower band. If too few, widen.
  const lo = input.follower_count * 0.5;
  const hi = input.follower_count * 1.5;
  let band = history.filter(
    (h) => h.follower_count >= lo && h.follower_count <= hi
  );
  if (band.length < MIN_SAMPLE_FOR_REGRESSION) band = history;

  // Linear regression: streams = a + b * payment
  const n = band.length;
  const sumX = band.reduce((s, h) => s + h.payment_usd, 0);
  const sumY = band.reduce((s, h) => s + h.streams_attributed, 0);
  const sumXY = band.reduce((s, h) => s + h.payment_usd * h.streams_attributed, 0);
  const sumXX = band.reduce((s, h) => s + h.payment_usd * h.payment_usd, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) {
    // All payments identical — degenerate. Fall back.
    return {
      predicted_streams: Math.round(input.payment_usd * FALLBACK_STREAMS_PER_DOLLAR),
      predicted_streams_per_dollar: FALLBACK_STREAMS_PER_DOLLAR,
      confidence: 0.2,
      method: 'fallback',
      sample_size: n,
    };
  }
  const b = (n * sumXY - sumX * sumY) / denom;
  const a = (sumY - b * sumX) / n;
  const predicted = a + b * input.payment_usd;
  const safe = Math.max(0, predicted);
  return {
    predicted_streams: Math.round(safe),
    predicted_streams_per_dollar: input.payment_usd > 0 ? safe / input.payment_usd : 0,
    confidence: Math.min(1, n / 30), // ramps to 1 at n=30
    method: 'linear',
    sample_size: n,
  };
}
