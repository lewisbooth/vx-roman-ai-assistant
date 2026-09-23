import { randomUUID } from "node:crypto";
import prisma from "../db.server";

export type ApiAvailability = "healthy" | "fallback" | "outage";
type IncidentKind = Exclude<ApiAvailability, "healthy">;

export interface ApiErrorRange {
  from: string;
  to: string;
}

export interface ApiErrorReport extends ApiErrorRange {
  generatedAt: string;
  current: { state: ApiAvailability; since: string | null };
  days: { day: string; fallback: number; outage: number }[];
  totals: { fallback: number; outage: number };
  incidents: {
    id: string;
    kind: IncidentKind;
    startedAt: string;
    endedAt: string | null;
  }[];
  hasMoreIncidents: boolean;
}

const dayMs = 86_400_000;
const maxDays = 366;

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || utcDay(date) !== value ? null : date;
}

function incidentKind(value: string): IncidentKind {
  if (value === "fallback" || value === "outage") return value;
  throw new Error("Invalid stored API incident kind.");
}

export function readApiErrorRange(
  params: URLSearchParams,
  now = new Date(),
): ApiErrorRange {
  const today = utcDay(now);
  const defaultFrom = utcDay(new Date(parseDay(today)!.getTime() - 29 * dayMs));
  const fromValues = params.getAll("from");
  const toValues = params.getAll("to");
  if (fromValues.length > 1 || toValues.length > 1)
    throw new RangeError("Use one date for each API Errors range boundary.");
  const from = fromValues[0] ?? defaultFrom;
  const to = toValues[0] ?? today;
  const start = parseDay(from);
  const end = parseDay(to);
  if (!start || !end || end < start || end.getTime() - start.getTime() >= maxDays * dayMs)
    throw new RangeError("Choose a valid UTC date range of up to 366 days.");
  return { from, to };
}

// The caller owns the service state. A database failure must not prevent a
// switch to fallback or suspension; the caller logs a fixed category for it.
export async function setApiAvailability(state: ApiAvailability): Promise<void> {
  if (state !== "healthy" && state !== "fallback" && state !== "outage")
    throw new RangeError("Invalid API availability state.");
  const at = new Date();
  await prisma.$transaction(async (transaction) => {
    const open = await transaction.apiIncident.findFirst({
      where: { endedAt: null },
      select: { id: true, kind: true, startedAt: true },
    });
    if (open?.kind === state || (!open && state === "healthy")) return;
    if (open)
      await transaction.apiIncident.update({
        where: { id: open.id },
        data: { endedAt: new Date(Math.max(at.getTime(), open.startedAt.getTime())) },
      });
    if (state !== "healthy")
      await transaction.apiIncident.create({
        data: {
          id: randomUUID(),
          kind: state,
          startedAt: at,
          startedDayUtc: utcDay(at),
        },
      });
  });
}

export async function getApiAvailability(): Promise<ApiAvailability> {
  const open = await prisma.apiIncident.findFirst({
    where: { endedAt: null },
    select: { kind: true },
  });
  return open ? incidentKind(open.kind) : "healthy";
}

export async function getApiErrorReport({
  from,
  to,
}: ApiErrorRange): Promise<ApiErrorReport> {
  // Validate again so internal callers cannot accidentally request an unbounded report.
  const range = readApiErrorRange(new URLSearchParams({ from, to }));
  const [open, groups, rows] = await Promise.all([
    prisma.apiIncident.findFirst({
      where: { endedAt: null },
      select: { kind: true, startedAt: true },
    }),
    prisma.apiIncident.groupBy({
      by: ["startedDayUtc", "kind"],
      where: { startedDayUtc: { gte: range.from, lte: range.to } },
      _count: { _all: true },
    }),
    prisma.apiIncident.findMany({
      where: { startedDayUtc: { gte: range.from, lte: range.to } },
      select: { id: true, kind: true, startedAt: true, endedAt: true },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: 51,
    }),
  ]);
  const counts = new Map<string, { fallback: number; outage: number }>();
  for (const group of groups) {
    const kind = incidentKind(group.kind);
    const current = counts.get(group.startedDayUtc) ?? { fallback: 0, outage: 0 };
    current[kind] = group._count._all;
    counts.set(group.startedDayUtc, current);
  }
  const days: ApiErrorReport["days"] = [];
  const start = parseDay(range.from)!;
  const end = parseDay(range.to)!;
  for (let time = start.getTime(); time <= end.getTime(); time += dayMs) {
    const day = utcDay(new Date(time));
    days.push({ day, ...(counts.get(day) ?? { fallback: 0, outage: 0 }) });
  }
  return {
    ...range,
    generatedAt: new Date().toISOString(),
    current: open
      ? { state: incidentKind(open.kind), since: open.startedAt.toISOString() }
      : { state: "healthy", since: null },
    days,
    totals: days.reduce(
      (sum, day) => ({
        fallback: sum.fallback + day.fallback,
        outage: sum.outage + day.outage,
      }),
      { fallback: 0, outage: 0 },
    ),
    incidents: rows.slice(0, 50).map((row) => ({
      id: row.id,
      kind: incidentKind(row.kind),
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
    })),
    hasMoreIncidents: rows.length > 50,
  };
}
