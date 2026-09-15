import type { ModelPrice } from "./contracts";
import { validatePrices } from "./validation";

// Initial estimate baseline verified on this date, not a claim that OpenAI
// introduced these prices then. Earlier activity deliberately has no rate.
// Preserve old periods: close effectiveTo and append a new period on a change.
export const MODEL_PRICES: readonly ModelPrice[] = [
  {
    id: "luna-standard-2026-09-15",
    model: "gpt-5.6-luna",
    kind: "tokens",
    serviceTier: "default",
    currency: "USD",
    effectiveFrom: "2026-09-15T00:00:00.000Z",
    effectiveTo: null,
    verifiedAt: "2026-09-15T15:36:00.000Z",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    prices: {
      inputPerMillion: 0.2,
      cachedInputPerMillion: 0.02,
      cacheWriteInputPerMillion: 0.25,
      outputPerMillion: 1.2,
    },
    longContext: {
      aboveInputTokens: 272_000,
      prices: {
        inputPerMillion: 0.4,
        cachedInputPerMillion: 0.04,
        cacheWriteInputPerMillion: 0.5,
        outputPerMillion: 1.8,
      },
    },
  },
  {
    id: "luna-fast-2026-09-15",
    model: "gpt-5.6-luna",
    kind: "tokens",
    serviceTier: "priority",
    currency: "USD",
    effectiveFrom: "2026-09-15T00:00:00.000Z",
    effectiveTo: null,
    verifiedAt: "2026-09-15T15:36:00.000Z",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    prices: {
      inputPerMillion: 0.4,
      cachedInputPerMillion: 0.04,
      cacheWriteInputPerMillion: 0.5,
      outputPerMillion: 2.4,
    },
    longContext: {
      aboveInputTokens: 272_000,
      prices: {
        inputPerMillion: 0.8,
        cachedInputPerMillion: 0.08,
        cacheWriteInputPerMillion: 1,
        outputPerMillion: 3.6,
      },
    },
  },
  {
    id: "live-2026-09-15",
    model: "gpt-live-1",
    kind: "voice",
    serviceTier: null,
    currency: "USD",
    effectiveFrom: "2026-09-15T00:00:00.000Z",
    effectiveTo: null,
    verifiedAt: "2026-09-15T15:36:00.000Z",
    sourceUrl: "https://developers.openai.com/api/docs/models/gpt-live-1",
    perMinute: 0.05,
  },
];

validatePrices(MODEL_PRICES);
