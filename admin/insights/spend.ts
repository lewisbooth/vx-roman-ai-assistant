import type { CostSummary } from "../pricing/contracts";

export interface SpendRange {
  from: string;
  to: string;
}

export interface DailySpendReport extends SpendRange {
  days: { day: string; cost: CostSummary }[];
  cost: CostSummary;
}

export interface SessionMetrics {
  sessions: number;
  voiceSessions: number;
  textSessions: number;
  visualizerSessions: number;
  sampleCartSessions: number;
  productCartSessions: number;
}

const dayMs = 86_400_000;

function parseDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
    ? null
    : date;
}

/** Inclusive UTC days, defaulting to the last 30 days including today. */
export function readSpendRange(
  params: URLSearchParams,
  now = new Date(),
): SpendRange {
  const today = now.toISOString().slice(0, 10);
  const defaultFrom = new Date(parseDay(today)!.getTime() - 29 * dayMs)
    .toISOString()
    .slice(0, 10);
  const fromValues = params.getAll("from");
  const toValues = params.getAll("to");
  if (fromValues.length > 1 || toValues.length > 1)
    throw new RangeError("Use one date for each spend range boundary.");
  const from = fromValues[0] ?? defaultFrom;
  const to = toValues[0] ?? today;
  const start = parseDay(from);
  const end = parseDay(to);
  if (
    !start ||
    !end ||
    end < start ||
    end.getTime() - start.getTime() >= 366 * dayMs
  )
    throw new RangeError("Choose a valid UTC date range of up to 366 days.");
  return { from, to };
}
