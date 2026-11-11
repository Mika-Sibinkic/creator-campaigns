// src/app/analytics/contract.ts
//
// The page's data contract for GET /api/analytics/correlations. Engine shapes
// come straight from src/lib/correlation.ts, the single source of truth. Only
// the response envelope is declared here, because the route doesn't export it.

export { FACTORS } from '@/lib/correlation';
export type {
  CategoricalFactorResult,
  Confidence,
  ConfidenceTier,
  CorrelationReport,
  CorrelationScope,
  FactorId,
  FactorResult,
  NumericFactorResult,
  OutcomeMetric,
} from '@/lib/correlation';

/** §6 response envelope. */
export interface CampaignOption {
  id: string;
  artist_name: string;
  synthetic: boolean;
  deals_measured: number;
}

export interface CorrelationsResponse {
  campaigns: CampaignOption[];
  report: import('@/lib/correlation').CorrelationReport;
}
