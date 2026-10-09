import type { CostSummary, ModelPrice } from "../pricing/contracts";
import { emptyCostSummary } from "../pricing/estimate.server";
import { MODEL_PRICES } from "../pricing/rates.server";
import { getDailyCostSummaries } from "./costs.server";
import { readSpendRange, type DailySpendReport, type SpendRange } from "./spend";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Read recorded spend by request/session start day, without loading usage rows. */
export async function getDailySpendReport(
  shop: string,
  requestedRange: SpendRange,
  prices: readonly ModelPrice[] = MODEL_PRICES,
): Promise<DailySpendReport> {
  const range = readSpendRange(
    new URLSearchParams({ from: requestedRange.from, to: requestedRange.to }),
  );
  const from = new Date(`${range.from}T00:00:00.000Z`);
  const end = new Date(`${range.to}T00:00:00.000Z`).getTime() + DAY_MS;
  const summaries = await getDailyCostSummaries(shop, from, new Date(end), prices);
  const cost = emptyCostSummary();
  const days: DailySpendReport["days"] = [];
  for (let time = from.getTime(); time < end; time += DAY_MS) {
    const day = new Date(time).toISOString().slice(0, 10);
    const summary = summaries.get(day) ?? emptyCostSummary();
    days.push({ day, cost: summary });
    accumulateCost(cost, summary);
  }
  return { ...range, days, cost };
}

function accumulateCost(total: CostSummary, day: CostSummary) {
  for (const key of ["modelUsd", "voiceUsd", "imageUsd", "totalUsd"] as const)
    if (day[key] !== null) total[key] = (total[key] ?? 0) + day[key];
  for (const key of [
    "pricedModelCalls",
    "unpricedModelCalls",
    "pricedVoiceSessions",
    "unpricedVoiceSessions",
    "pricedImageAttempts",
    "unpricedImageAttempts",
    "estimatedImageAttempts",
  ] as const)
    total[key] += day[key];
}
