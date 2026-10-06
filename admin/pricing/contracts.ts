/** USD list-price estimates, never provider invoices or inferred usage. */
export interface TokenPrices {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  cacheWriteInputPerMillion: number;
  outputPerMillion: number;
}

/** Input totals include their cached subsets; null is missing provider evidence. */
export interface ImageTokenUsage {
  textInputTokens: number | null;
  textCachedInputTokens: number | null;
  imageInputTokens: number | null;
  imageCachedInputTokens: number | null;
  imageOutputTokens: number | null;
}

export interface ImageTokenPrices {
  textInputPerMillion: number;
  cachedTextInputPerMillion: number;
  imageInputPerMillion: number;
  cachedImageInputPerMillion: number;
  imageOutputPerMillion: number;
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
    | { kind: "image"; serviceTier: null; prices: ImageTokenPrices }
  );

export interface CostEstimate {
  usd: number | null;
  rateId: string | null;
  reason: "missing_usage" | "missing_rate" | "invalid_usage" | null;
}

export interface CostSummary {
  modelUsd: number | null;
  voiceUsd: number | null;
  imageUsd: number | null;
  totalUsd: number | null;
  pricedModelCalls: number;
  unpricedModelCalls: number;
  pricedVoiceSessions: number;
  unpricedVoiceSessions: number;
  pricedImageAttempts: number;
  unpricedImageAttempts: number;
  estimatedImageAttempts: number;
}

export type ImagePrice = Extract<ModelPrice, { kind: "image" }>;
export interface ImageCostLine {
  component: keyof ImageTokenPrices;
  tokens: number | null;
  ratePerMillion: number;
  usd: number | null;
  estimated: boolean;
}
export interface ImageCostEstimate extends CostEstimate {
  evidence: "unknown" | "reported" | "estimated";
  lines: ImageCostLine[];
}
