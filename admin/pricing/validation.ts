import type { ModelPrice, TokenPrices } from "./contracts";

function instant(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
    throw new Error("Model prices require canonical UTC timestamps.");
  return time;
}

function validateTokenPrices(prices: TokenPrices) {
  for (const value of [
    prices.inputPerMillion,
    prices.cachedInputPerMillion,
    prices.cacheWriteInputPerMillion,
    prices.outputPerMillion,
  ]) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error("Model prices must be finite, non-negative USD rates.");
  }
}

/** Reject ambiguous history at startup, rather than choosing a rate by order. */
export function validatePrices(prices: readonly ModelPrice[]): void {
  const ids = new Set<string>();
  for (const price of prices) {
    if (
      !price.id ||
      ids.has(price.id) ||
      !price.model ||
      price.currency !== "USD"
    )
      throw new Error(
        "Model prices require unique IDs, a model and USD currency.",
      );
    ids.add(price.id);
    const from = instant(price.effectiveFrom);
    const to =
      price.effectiveTo === null ? Infinity : instant(price.effectiveTo);
    instant(price.verifiedAt);
    if (to <= from)
      throw new Error("Model price periods must have positive length.");
    if (new URL(price.sourceUrl).protocol !== "https:")
      throw new Error("Model prices require an HTTPS source.");
    if (price.kind === "tokens") {
      if (!["default", "priority"].includes(price.serviceTier))
        throw new Error(
          "Token pricing requires an explicit supported service tier.",
        );
      validateTokenPrices(price.prices);
      if (price.longContext) {
        if (
          !Number.isSafeInteger(price.longContext.aboveInputTokens) ||
          price.longContext.aboveInputTokens < 0
        )
          throw new Error(
            "Long-context pricing requires a valid input threshold.",
          );
        validateTokenPrices(price.longContext.prices);
      }
    } else if (
      price.kind !== "voice" ||
      price.serviceTier !== null ||
      !Number.isFinite(price.perMinute) ||
      price.perMinute < 0
    ) {
      throw new Error(
        "Voice pricing requires a finite, non-negative per-minute rate.",
      );
    }
    for (const other of prices) {
      if (
        other !== price &&
        other.kind === price.kind &&
        other.model === price.model &&
        other.serviceTier === price.serviceTier &&
        from <
          (other.effectiveTo === null
            ? Infinity
            : instant(other.effectiveTo)) &&
        instant(other.effectiveFrom) < to
      )
        throw new Error(
          "Model price periods overlap for the same model and tier.",
        );
    }
  }
}
