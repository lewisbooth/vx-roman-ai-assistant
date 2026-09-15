/** USD list-price estimates, never provider invoices or inferred usage. */
export interface TokenPrices {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  cacheWriteInputPerMillion: number;
  outputPerMillion: number;
}

interface PricePeriod {
  id: string;
  model: string;
  currency: "USD";
  effectiveFrom: string;
  /** Exclusive UTC boundary; null keeps the period open. */
  effectiveTo: string | null;
  verifiedAt: string;
  sourceUrl: string;
}

export type ModelPrice = PricePeriod &
  (
    | {
        kind: "tokens";
        serviceTier: "default" | "priority";
        prices: TokenPrices;
        longContext: { aboveInputTokens: number; prices: TokenPrices } | null;
      }
    | { kind: "voice"; serviceTier: null; perMinute: number }
  );

export interface CostEstimate {
  usd: number | null;
  rateId: string | null;
  reason: "missing_usage" | "missing_rate" | "invalid_usage" | null;
}

export interface CostSummary {
  modelUsd: number | null;
  voiceUsd: number | null;
  totalUsd: number | null;
  pricedModelCalls: number;
  unpricedModelCalls: number;
  pricedVoiceSessions: number;
  unpricedVoiceSessions: number;
}
