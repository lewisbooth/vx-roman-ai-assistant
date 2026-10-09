import type { SessionMetrics, SpendRange } from "./spend";
import { recordedNumber } from "./format";

function share(count: number, total: number): string {
  if (total === 0) return "—";
  return `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format((count / total) * 100)}%`;
}

export function SessionMetricsView({
  metrics,
  range,
}: {
  metrics: SessionMetrics;
  range: SpendRange;
}) {
  const circumference = 2 * Math.PI * 64;
  const voiceArc = metrics.sessions
    ? (metrics.voiceSessions / metrics.sessions) * circumference
    : 0;
  const adoption = [
    ["Used visualizer", metrics.visualizerSessions],
    ["Added sample to cart", metrics.sampleCartSessions],
    ["Added product to cart", metrics.productCartSessions],
  ] as const;

  return (
    <s-section heading="Session overview">
      <s-stack gap="base">
        <s-paragraph color="subdued">
          {recordedNumber(metrics.sessions)} sessions started from {range.from}{" "}
          to {range.to} (UTC). Each conversation counts once; activity includes
          its subsequent progress.
        </s-paragraph>
        <div className="grid gap-6 md:grid-cols-[minmax(240px,1fr)_2fr]">
          <div className="flex flex-wrap items-center gap-5">
            {metrics.sessions === 0 ? (
              <p className="text-sm text-gray-600">
                No sessions started in this range.
              </p>
            ) : (
              <svg
                viewBox="0 0 200 200"
                className="h-40 w-40 shrink-0"
                role="img"
                aria-label={`${metrics.voiceSessions} sessions used voice; ${metrics.textSessions} sessions were text-only`}
              >
                <circle
                  cx="100"
                  cy="100"
                  r="64"
                  fill="none"
                  stroke="#4E0E0E"
                  strokeWidth="30"
                />
                <circle
                  cx="100"
                  cy="100"
                  r="64"
                  fill="none"
                  stroke="#C6963C"
                  strokeWidth="30"
                  strokeDasharray={`${voiceArc} ${circumference - voiceArc}`}
                  transform="rotate(-90 100 100)"
                />
                <text
                  x="100"
                  y="99"
                  textAnchor="middle"
                  fontSize="27"
                  fontWeight="600"
                  fill="#1f2937"
                >
                  {recordedNumber(metrics.sessions)}
                </text>
                <text
                  x="100"
                  y="121"
                  textAnchor="middle"
                  fontSize="12"
                  fill="#6b7280"
                >
                  Sessions
                </text>
              </svg>
            )}
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 rounded-full bg-[#C6963C]"
                  />
                  Used voice
                </dt>
                <dd className="mt-1 font-semibold">
                  {recordedNumber(metrics.voiceSessions)} ·{" "}
                  {share(metrics.voiceSessions, metrics.sessions)}
                </dd>
              </div>
              <div>
                <dt className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 rounded-full bg-[#4E0E0E]"
                  />
                  Text only
                </dt>
                <dd className="mt-1 font-semibold">
                  {recordedNumber(metrics.textSessions)} ·{" "}
                  {share(metrics.textSessions, metrics.sessions)}
                </dd>
              </div>
            </dl>
          </div>
          <dl className="grid content-center gap-4 sm:grid-cols-3">
            {adoption.map(([label, count]) => (
              <div
                key={label}
                className="rounded-xl border border-gray-200 p-4"
              >
                <dt className="text-sm text-gray-600">{label}</dt>
                <dd className="mt-2 text-2xl font-semibold text-gray-900">
                  {share(count, metrics.sessions)}
                </dd>
                <dd className="mt-1 text-xs text-gray-600">
                  {recordedNumber(count)} of {recordedNumber(metrics.sessions)}{" "}
                  sessions
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <s-paragraph color="subdued">
          Sessions using both text and voice count as voice. Visualizer usage
          means a preview was requested; cart metrics require confirmed
          additions.
        </s-paragraph>
      </s-stack>
    </s-section>
  );
}
