import type {
  ImageCostEstimate,
  ImageCostLine,
  ImagePrice,
  ImageTokenPrices,
  ImageTokenUsage,
  ModelPrice,
} from "./contracts";
import { MODEL_PRICES } from "./rates.server";
import { validatePrices } from "./validation";

function unknown(reason: ImageCostEstimate["reason"]): ImageCostEstimate {
  return { usd: null, rateId: null, reason, evidence: "unknown", lines: [] };
}

/** Pin this entire dated price before each physical provider attempt. */
export function imageRateFor(
  model: string,
  createdAt: Date | string,
  prices: readonly ModelPrice[] = MODEL_PRICES,
): ImagePrice | null {
  const time = new Date(createdAt).getTime();
  return (
    prices.find(
      (price): price is ImagePrice =>
        price.kind === "image" &&
        price.model === model &&
        Date.parse(price.effectiveFrom) <= time &&
        (price.effectiveTo === null || time < Date.parse(price.effectiveTo)),
    ) ?? null
  );
}

/** Invalid saved price evidence remains unpriced, never replaced by today's rates. */
export function parseImageRateSnapshot(json: string): ImagePrice | null {
  try {
    const value: unknown = JSON.parse(json);
    if (
      !value ||
      typeof value !== "object" ||
      !("kind" in value) ||
      value.kind !== "image"
    )
      return null;
    const price = value as ImagePrice;
    validatePrices([price]);
    return price;
  } catch {
    return null;
  }
}

export function estimateImageUsage(
  usage: ImageTokenUsage & {
    model: string;
    createdAt: Date | string;
    usageValid?: boolean;
  },
  snapshot: ImagePrice | null = imageRateFor(usage.model, usage.createdAt),
): ImageCostEstimate {
  if (usage.usageValid === false) return unknown("invalid_usage");
  const counts = [
    usage.textInputTokens,
    usage.textCachedInputTokens,
    usage.imageInputTokens,
    usage.imageCachedInputTokens,
    usage.imageOutputTokens,
  ];
  if (
    counts.some(
      (count) => count !== null && (!Number.isSafeInteger(count) || count < 0),
    ) ||
    (usage.textInputTokens !== null &&
      usage.textCachedInputTokens !== null &&
      usage.textCachedInputTokens > usage.textInputTokens) ||
    (usage.imageInputTokens !== null &&
      usage.imageCachedInputTokens !== null &&
      usage.imageCachedInputTokens > usage.imageInputTokens)
  )
    return unknown("invalid_usage");
  if (!snapshot || snapshot.model !== usage.model)
    return unknown("missing_rate");
  try {
    validatePrices([snapshot]);
  } catch {
    return unknown("missing_rate");
  }
  const line = (
    component: keyof ImageTokenPrices,
    tokens: number | null,
    estimated = false,
  ): ImageCostLine => ({
    component,
    tokens,
    ratePerMillion: snapshot.prices[component],
    usd:
      tokens === null
        ? null
        : (tokens * snapshot.prices[component]) / 1_000_000,
    estimated,
  });
  const inputLines = (
    total: number | null,
    cached: number | null,
    inputKey: keyof ImageTokenPrices,
    cacheKey: keyof ImageTokenPrices,
  ) => {
    const estimated = total !== null && cached === null;
    const assumedCached = estimated ? 0 : cached;
    return [
      line(
        inputKey,
        total === null || assumedCached === null ? null : total - assumedCached,
        estimated,
      ),
      line(cacheKey, assumedCached, estimated),
    ];
  };
  const lines = [
    ...inputLines(
      usage.textInputTokens,
      usage.textCachedInputTokens,
      "textInputPerMillion",
      "cachedTextInputPerMillion",
    ),
    ...inputLines(
      usage.imageInputTokens,
      usage.imageCachedInputTokens,
      "imageInputPerMillion",
      "cachedImageInputPerMillion",
    ),
    line("imageOutputPerMillion", usage.imageOutputTokens),
  ];
  const complete = lines.every(
    (part) => part.usd !== null && Number.isFinite(part.usd),
  );
  return {
    usd: complete ? lines.reduce((sum, part) => sum + part.usd!, 0) : null,
    rateId: snapshot.id,
    reason: complete ? null : "missing_usage",
    evidence: !complete
      ? "unknown"
      : lines.some((part) => part.estimated)
        ? "estimated"
        : "reported",
    lines,
  };
}
