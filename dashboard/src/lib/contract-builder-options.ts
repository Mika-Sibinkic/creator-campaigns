// src/lib/contract-builder-options.ts
//
// The guided contract builder's question model: answer types, the closed
// option sets the tiles offer, defaults, and the check that the payment
// clause matches how this firm's payouts really settle.
//
// Split from contract-builder.ts so the client page can import it: nothing
// here reaches the model SDK (contract-builder.ts imports the template
// generator, which imports model-provider).

export const PLATFORMS = ['tiktok', 'instagram', 'youtube'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const POST_TYPES = ['short_video', 'story', 'carousel'] as const;
export type PostType = (typeof POST_TYPES)[number];

export const PLATFORM_LABEL: Record<Platform, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  youtube: 'YouTube Shorts',
};
export const POST_TYPE_LABEL: Record<PostType, string> = {
  short_video: 'short-form video',
  story: 'story',
  carousel: 'photo carousel',
};

export type PaymentStructure = 'full_on_approval' | 'deposit_balance';
export type Venue = 'courts' | 'arbitration' | 'small_claims';
export type AcceptanceMethod = 'reply_or_conduct' | 'conduct';
export type ExclusivityCategory = 'labels' | 'any_music';

export interface BuilderAnswers {
  parties: {
    legalName: string;
    address: string;
    signerName: string;
    signerTitle: string;
  };
  deliverables: {
    platforms: Platform[];
    postTypes: PostType[];
    /** 0 = "as agreed per deal" (the {{deliverables}} slot alone decides). */
    minCount: number;
    /** 0 = no minimum length. */
    minLengthSec: number;
    useSound: boolean;
    includeLink: boolean;
    includeHashtag: boolean;
  };
  timing: {
    /** 0 = the campaign window ({{schedule}}) alone. */
    deadlineDays: number;
    minLiveDays: number;
    revisionRounds: number;
  };
  payment: {
    structure: PaymentStructure;
    /** Only read for deposit_balance. Whole percent, 1-99. */
    depositPct: number;
    /** Days after the trigger (approval, or verification for the balance). */
    payWithinDays: number;
  };
  rights: {
    /** 0 = no reuse right at all. */
    usageMonths: number;
    paidAds: boolean;
    whitelisting: boolean;
    /** 0 = no exclusivity. */
    exclusivityDays: number;
    exclusivityCategory: ExclusivityCategory;
  };
  compliance: {
    noBots: boolean;
    brandSafety: boolean;
    takedown: boolean;
  };
  performance: {
    guarantee: boolean;
    minViews: number;
    measureAfterDays: number;
  };
  termination: {
    killFeePct: number;
    /** The jurisdiction as typed; normalized by normalizeJurisdiction. */
    governingLaw: string;
    venue: Venue;
  };
  acceptance: {
    method: AcceptanceMethod;
  };
}

/** Option sets the UI renders as tiles. The validator enforces the same sets,
 *  so a hand-built request cannot smuggle in a value the UI never offered. */
export const OPTIONS = {
  minCount: [0, 1, 2, 3],
  minLengthSec: [0, 15, 30, 60],
  deadlineDays: [0, 7, 14, 30],
  minLiveDays: [30, 60, 90, 180],
  revisionRounds: [0, 1, 2],
  payWithinDays: [3, 7, 14],
  usageMonths: [0, 3, 12, 24],
  exclusivityDays: [0, 7, 14, 30],
  minViews: [1000, 5000, 10000, 25000],
  measureAfterDays: [7, 14, 30],
  killFeePct: [0, 25, 50],
} as const;

/** Mirror of split-settlement.SettlementPolicy (kept structural so this file
 *  stays import-free for the client bundle). */
export interface PolicyLike {
  splitEnabled: boolean;
  depositPct: number;
}

/** The payment answer that describes what this firm's payouts actually do. */
export function paymentFromPolicy(
  policy: PolicyLike,
): Pick<BuilderAnswers['payment'], 'structure' | 'depositPct'> {
  if (policy.splitEnabled && policy.depositPct > 0 && policy.depositPct < 100) {
    return { structure: 'deposit_balance', depositPct: policy.depositPct };
  }
  return { structure: 'full_on_approval', depositPct: 50 };
}

/**
 * Does the payment clause describe what the payout engine will do for this
 * firm? Mirrors authorize-payment.ts: split off means one 'full' leg on
 * approval; split on means deposit_pct on approval and the remainder only
 * once the post is verified ('posted'). deposit_pct 100 with the split on
 * leaves an empty balance leg, which is full-on-approval in practice.
 * deposit_pct 0 with the split on is a configuration the engine cannot pay at
 * all (the deposit leg is empty and a balance needs a deposit on record), so
 * no clause matches it.
 */
export function paymentMatchesPolicy(
  payment: Pick<BuilderAnswers['payment'], 'structure' | 'depositPct'>,
  policy: PolicyLike,
): { ok: true } | { ok: false; reason: string } {
  if (policy.splitEnabled && policy.depositPct === 0) {
    return {
      ok: false,
      reason:
        'Payouts for this workspace are set to a 0% deposit, which the payment system cannot pay. ' +
        'Ask your platform operator to fix the payout split before applying a contract.',
    };
  }
  const effective = paymentFromPolicy(policy);
  if (effective.structure === 'full_on_approval') {
    if (payment.structure === 'full_on_approval') return { ok: true };
    return {
      ok: false,
      reason:
        'Payouts for this workspace pay in full when you approve a deal. A contract promising a deposit and balance ' +
        'would not match what creators actually receive. Ask your platform operator to turn on split payouts first.',
    };
  }
  if (payment.structure === 'deposit_balance' && payment.depositPct === effective.depositPct) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      `Payouts for this workspace pay a ${effective.depositPct}% deposit on approval and the rest after the post is verified. ` +
      'The contract has to say the same thing.',
  };
}

/** Sensible defaults: the curated base template's own terms where it has one,
 *  and the payment clause this firm's payouts actually perform. */
export function defaultAnswers(
  firmName = '',
  policy: PolicyLike = { splitEnabled: false, depositPct: 50 },
): BuilderAnswers {
  return {
    parties: { legalName: firmName, address: '', signerName: '', signerTitle: '' },
    deliverables: {
      platforms: ['tiktok'],
      postTypes: ['short_video'],
      minCount: 0,
      minLengthSec: 15,
      useSound: true,
      includeLink: false,
      includeHashtag: true,
    },
    timing: { deadlineDays: 0, minLiveDays: 90, revisionRounds: 0 },
    payment: { ...paymentFromPolicy(policy), payWithinDays: 7 },
    rights: {
      usageMonths: 12,
      paidAds: false,
      whitelisting: false,
      exclusivityDays: 0,
      exclusivityCategory: 'labels',
    },
    compliance: { noBots: true, brandSafety: true, takedown: true },
    performance: { guarantee: false, minViews: 5000, measureAfterDays: 14 },
    termination: { killFeePct: 0, governingLaw: 'the State of Delaware', venue: 'courts' },
    acceptance: { method: 'reply_or_conduct' },
  };
}
