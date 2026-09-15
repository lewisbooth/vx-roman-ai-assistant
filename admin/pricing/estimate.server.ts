import type {
  CostEstimate,
  CostSummary,
  ModelPrice,
  TokenPrices,
} from "./contracts";
import { MODEL_PRICES } from "./rates.server";

interface ModelUsage {
  model: string;
  serviceTier: string | null;
  createdAt: Date | string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
}

interface VoiceUsage {
  model: string | null;
  createdAt: Date | string;
  usageSeconds: number | null;
}

function unpriced(reason: CostEstimate["reason"]): CostEstimate {
  return { usd: null, rateId: null, reason };
}

function rateFor(
  kind: ModelPrice["kind"],
  model: string | null,
  serviceTier: string | null,
  createdAt: Date | string,
  prices: readonly ModelPrice[],
): ModelPrice | undefined {
  const time = new Date(createdAt).getTime();
  // Fast is the request spelling; Responses currently returns priority.
  const tier = serviceTier === "fast" ? "priority" : serviceTier;
  return prices.find(
    (price) =>
      price.kind === kind &&
      price.model === model &&
      price.serviceTier === tier &&
      Date.parse(price.effectiveFrom) <= time &&
      (price.effectiveTo === null || time < Date.parse(price.effectiveTo)),
  );
}

/** Linear charge calculation, after each request's rate band and counts are validated. */
export function tokenCostUsd(
  counts: {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
  },
  charges: TokenPrices,
): number {
  return (
    ((counts.inputTokens -
      counts.cachedInputTokens -
      counts.cacheWriteInputTokens) *
      charges.inputPerMillion +
      counts.cachedInputTokens * charges.cachedInputPerMillion +
      counts.cacheWriteInputTokens * charges.cacheWriteInputPerMillion +
      counts.outputTokens * charges.outputPerMillion) /
    1_000_000
  );
}

export function estimateModelUsage(
  usage: ModelUsage,
  prices: readonly ModelPrice[] = MODEL_PRICES,
): CostEstimate {
  const {
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: written,
    outputTokens: output,
  } = usage;
  if (input == null || cached == null || written == null || output == null)
    return unpriced("missing_usage");
  if (
    [input, cached, written, output].some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    ) ||
    cached + written > input
  )
    return unpriced("invalid_usage");
  const rate = rateFor(
    "tokens",
    usage.model,
    usage.serviceTier,
    usage.createdAt,
    prices,
  );
  if (!rate || rate.kind !== "tokens") return unpriced("missing_rate");
  const charges =
    rate.longContext && input > rate.longContext.aboveInputTokens
      ? rate.longContext.prices
      : rate.prices;
  // Cache reads/writes are subsets of input. Reasoning is already in output.
  const usd = tokenCostUsd(
    {
      inputTokens: input,
      cachedInputTokens: cached,
      cacheWriteInputTokens: written,
      outputTokens: output,
    },
    charges,
  );
  return Number.isFinite(usd)
    ? { usd, rateId: rate.id, reason: null }
    : unpriced("invalid_usage");
}

export function estimateVoiceUsage(
  usage: VoiceUsage,
  prices: readonly ModelPrice[] = MODEL_PRICES,
): CostEstimate {
  if (usage.usageSeconds == null) return unpriced("missing_usage");
  if (!Number.isFinite(usage.usageSeconds) || usage.usageSeconds < 0)
    return unpriced("invalid_usage");
  const rate = rateFor("voice", usage.model, null, usage.createdAt, prices);
  if (!rate || rate.kind !== "voice") return unpriced("missing_rate");
  // Provider cumulative seconds, not wall-clock duration or rounded-up minutes.
  const usd = (usage.usageSeconds * rate.perMinute) / 60;
  return Number.isFinite(usd)
    ? { usd, rateId: rate.id, reason: null }
    : unpriced("invalid_usage");
}

export function emptyCostSummary(): CostSummary {
  return {
    modelUsd: null,
    voiceUsd: null,
    totalUsd: null,
    pricedModelCalls: 0,
    unpricedModelCalls: 0,
    pricedVoiceSessions: 0,
    unpricedVoiceSessions: 0,
  };
}

/** Accumulate unrounded amounts; only presentation rounds currency. */
export function addCost(
  summary: CostSummary,
  kind: "model" | "voice",
  estimate: CostEstimate,
): void {
  if (estimate.usd === null) {
    if (kind === "model") summary.unpricedModelCalls++;
    else summary.unpricedVoiceSessions++;
    return;
  }
  if (kind === "model") {
    summary.pricedModelCalls++;
    summary.modelUsd = (summary.modelUsd ?? 0) + estimate.usd;
  } else {
    summary.pricedVoiceSessions++;
    summary.voiceUsd = (summary.voiceUsd ?? 0) + estimate.usd;
  }
  summary.totalUsd = (summary.totalUsd ?? 0) + estimate.usd;
}
