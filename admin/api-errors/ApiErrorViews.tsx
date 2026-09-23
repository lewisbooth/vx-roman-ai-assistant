import type { ApiErrorReport } from "./repository.server";

type ChartBucket = { label: string; fallback: number; outage: number };

function shortDay(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function bucketStart(day: string, grouping: "day" | "week" | "month") {
  if (grouping === "day") return day;
  if (grouping === "month") return `${day.slice(0, 7)}-01`;
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function chartBuckets(report: ApiErrorReport): {
  grouping: "day" | "week" | "month";
  buckets: ChartBucket[];
} {
  const grouping =
    report.days.length > 120
      ? "month"
      : report.days.length > 45
        ? "week"
        : "day";
  const byStart = new Map<string, ChartBucket>();
  for (const day of report.days) {
    const start = bucketStart(day.day, grouping);
    const bucket = byStart.get(start) ?? {
      label: grouping === "month" ? start.slice(0, 7) : shortDay(start),
      fallback: 0,
      outage: 0,
    };
    bucket.fallback += day.fallback;
    bucket.outage += day.outage;
    byStart.set(start, bucket);
  }
  return { grouping, buckets: [...byStart.values()] };
}

function recordedAt(value: string): string {
  return (
    new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(value)) + " UTC"
  );
}

function duration(start: string, end: string): string {
  const seconds = Math.max(
    0,
    Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function IncidentChart({ report }: { report: ApiErrorReport }) {
  const { grouping, buckets } = chartBuckets(report);
  const max = Math.max(1, ...buckets.map((bucket) => bucket.fallback + bucket.outage));
  const left = 38;
  const top = 12;
  const plotHeight = 142;
  const plotWidth = 698;
  const band = plotWidth / buckets.length;
  const barWidth = Math.max(4, Math.min(28, band * 0.66));
  const tickIndexes = new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1]);

  return (
    <figure className="rounded-xl border border-gray-200 bg-white p-4">
      <figcaption className="mb-3 text-sm font-semibold text-gray-800">
        Incident starts by {grouping} · UTC
      </figcaption>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-700" aria-hidden="true">
        <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-sm bg-amber-400" />Fallback model</span>
        <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-sm bg-rose-500" />Complete outage</span>
      </div>
      {report.totals.fallback + report.totals.outage === 0 ? (
        <p className="py-12 text-center text-sm text-gray-600">No incidents started in this range.</p>
      ) : (
        <svg
          className="mt-3 h-auto w-full"
          viewBox="0 0 752 190"
          role="img"
          aria-label={`${report.totals.fallback} fallback periods and ${report.totals.outage} complete outages started in the selected date range`}
        >
          {[0, 0.5, 1].map((fraction) => {
            const y = top + plotHeight * (1 - fraction);
            return (
              <g key={fraction}>
                <line x1={left} x2={left + plotWidth} y1={y} y2={y} stroke="#e5e7eb" strokeDasharray={fraction === 0 ? undefined : "3 4"} />
                <text x={left - 7} y={y + 4} textAnchor="end" fill="#6b7280" fontSize="10">{Math.round(max * fraction)}</text>
              </g>
            );
          })}
          {buckets.map((bucket, index) => {
            const x = left + band * (index + 0.5) - barWidth / 2;
            const fallbackHeight = (bucket.fallback / max) * plotHeight;
            const outageHeight = (bucket.outage / max) * plotHeight;
            return (
              <g key={`${bucket.label}-${index}`}>
                <title>{`${bucket.label}: ${bucket.fallback} fallback, ${bucket.outage} outage`}</title>
                <rect x={x} y={top + plotHeight - fallbackHeight} width={barWidth} height={fallbackHeight} rx="2" fill="#fbbf24" />
                <rect x={x} y={top + plotHeight - fallbackHeight - outageHeight} width={barWidth} height={outageHeight} rx="2" fill="#f43f5e" />
                {tickIndexes.has(index) && (
                  <text x={x + barWidth / 2} y="178" textAnchor="middle" fill="#6b7280" fontSize="10">{bucket.label}</text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </figure>
  );
}

export function ApiErrorsView({ report }: { report: ApiErrorReport }) {
  const current = report.current;
  const stateLabel =
    current.state === "healthy"
      ? "Available"
      : current.state === "fallback"
        ? "Using GPT-5.6 Luna fallback"
        : "Roman is currently unavailable";
  return (
    <>
      <s-section heading="Current API status">
        <s-stack gap="base">
          <p className={`inline-flex w-fit rounded-full px-3 py-1 text-sm font-semibold ${current.state === "healthy" ? "bg-emerald-100 text-emerald-900" : current.state === "fallback" ? "bg-amber-100 text-amber-950" : "bg-rose-100 text-rose-950"}`}>
            {stateLabel}
          </p>
          {current.since && <s-paragraph>Since {recordedAt(current.since)}</s-paragraph>}
          <s-paragraph color="subdued">Status reflects the server’s latest recorded transition. Refresh to see recovery.</s-paragraph>
        </s-stack>
      </s-section>
      <s-section heading="API Errors">
        <s-stack gap="base">
          <form method="get" className="flex flex-wrap items-end gap-3" aria-label="API Errors date range">
            <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
              From (UTC)
              <input type="date" name="from" defaultValue={report.from} required className="rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900" />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
              To (UTC)
              <input type="date" name="to" defaultValue={report.to} required className="rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900" />
            </label>
            <button type="submit" className="rounded-md bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">Apply range</button>
          </form>
          <p className="text-sm text-gray-700">
            <strong>{report.totals.fallback}</strong> fallback periods · <strong>{report.totals.outage}</strong> complete outages started from {report.from} to {report.to} (UTC)
          </p>
          <IncidentChart report={report} />
        </s-stack>
      </s-section>
      <s-section heading="Recent incident periods">
        <s-stack gap="base">
          {report.incidents.length === 0 ? (
            <s-paragraph>No incidents started in the selected range.</s-paragraph>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead><tr className="border-b border-gray-200 text-gray-600"><th className="py-2 pr-4">Issue</th><th className="py-2 pr-4">Started (UTC)</th><th className="py-2 pr-4">Ended (UTC)</th><th className="py-2">Duration</th></tr></thead>
                <tbody>
                  {report.incidents.map((incident) => (
                    <tr key={incident.id} className="border-b border-gray-100">
                      <td className="py-2 pr-4 font-medium">{incident.kind === "fallback" ? "Fallback model" : "Complete outage"}</td>
                      <td className="py-2 pr-4">{recordedAt(incident.startedAt)}</td>
                      <td className="py-2 pr-4">{incident.endedAt ? recordedAt(incident.endedAt) : "Ongoing"}</td>
                      <td className="py-2">{duration(incident.startedAt, incident.endedAt ?? report.generatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {report.hasMoreIncidents && <s-paragraph color="subdued">Showing the 50 most recent periods in this range.</s-paragraph>}
          <s-paragraph color="subdued">A period begins when Roman switches to GPT-5.6 Luna or suspends service, and ends on the next state change. Recovery probes do not create rows.</s-paragraph>
        </s-stack>
      </s-section>
    </>
  );
}
