import { useId, useRef, useState } from "react";
import type { CostSummary } from "../pricing/contracts";
import { estimatedUsd } from "./format";
import type { DailySpendReport } from "./spend";

const spendColor = "#6b733a";
const axisColor = "#716b60";
const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

function activityCount(cost: CostSummary): number {
  return (
    cost.pricedModelCalls +
    cost.unpricedModelCalls +
    cost.pricedVoiceSessions +
    cost.unpricedVoiceSessions +
    cost.pricedImageAttempts +
    cost.unpricedImageAttempts
  );
}

function unpricedCount(cost: CostSummary): number {
  return (
    cost.unpricedModelCalls +
    cost.unpricedVoiceSessions +
    cost.unpricedImageAttempts
  );
}

function recordedSpend(cost: CostSummary): number | null {
  return activityCount(cost) === 0 ? 0 : cost.totalUsd;
}

function spendDetails(cost: CostSummary): string {
  if (activityCount(cost) === 0) return "No recorded activity";
  if (cost.totalUsd === null) return "Unpriced activity only";
  if (unpricedCount(cost) > 0)
    return "Partial estimate; unpriced activity excluded";
  return "Recorded estimate";
}

function SpendPlot({ report }: { report: DailySpendReport }) {
  const descriptionId = useId();
  const points = useRef<(SVGGElement | null)[]>([]);
  const [active, setActive] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const { days } = report;
  const width = 1000;
  const height = 200;
  const left = 80;
  const right = width - 24;
  const top = 24;
  const bottom = height - 34;
  const maximum = Math.max(
    0,
    ...days.map(({ cost }) => recordedSpend(cost) ?? 0),
  );
  const ceiling = maximum > 0 ? maximum * 1.15 : 1;
  const x = (index: number) =>
    days.length === 1
      ? (left + right) / 2
      : left + (index * (right - left)) / (days.length - 1);
  const y = (amount: number) => bottom - (amount / ceiling) * (bottom - top);
  const segments: { line: string; first: number; last: number }[] = [];
  let segment: (typeof segments)[number] | null = null;
  for (const [index, { cost }] of days.entries()) {
    const amount = recordedSpend(cost);
    if (amount === null) {
      segment = null;
    } else if (segment) {
      segment.line += ` L${x(index)},${y(amount)}`;
      segment.last = index;
    } else {
      segment = {
        line: `M${x(index)},${y(amount)}`,
        first: index,
        last: index,
      };
      segments.push(segment);
    }
  }
  const tickCount = Math.min(6, days.length);
  const ticks = new Set(
    Array.from({ length: tickCount }, (_, index) =>
      tickCount === 1
        ? 0
        : Math.round((index * (days.length - 1)) / (tickCount - 1)),
    ),
  );
  const selected = days[active];

  function select(index: number) {
    setActive(index);
    setShowDetails(true);
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="block w-full min-w-[800px]"
          role="group"
          aria-label="Daily spend chart"
          aria-describedby={descriptionId}
        >
          <title>Daily spend in USD</title>
          <desc id={descriptionId}>
            Estimated daily spend for the selected UTC date range. Days with no
            recorded activity show zero. Unpriced-only days are gaps. Select a
            day for its value; use the left and right arrow keys, Home or End to
            move between days.
          </desc>
          <text x={left} y={12} fill={axisColor} fontSize={14}>
            Spend (USD)
          </text>
          {Array.from({ length: 5 }, (_, index) => {
            const amount = (ceiling * index) / 4;
            const position = y(amount);
            return (
              <g key={index} aria-hidden="true">
                <line
                  x1={left}
                  x2={right}
                  y1={position}
                  y2={position}
                  stroke="#e3e0d8"
                  strokeDasharray="3 5"
                />
                <text
                  x={left - 9}
                  y={position + 4}
                  fill={axisColor}
                  textAnchor="end"
                  fontSize={14}
                >
                  {estimatedUsd(amount, "cents").replace("USD ", "$")}
                </text>
              </g>
            );
          })}
          {[...ticks].map((index) => (
            <text
              key={index}
              x={x(index)}
              y={height - 10}
              fill={axisColor}
              textAnchor="middle"
              fontSize={14}
              aria-hidden="true"
            >
              {dateFormat.format(new Date(`${days[index].day}T00:00:00Z`))}
            </text>
          ))}
          {segments.map(({ line, first, last }) => (
            <g key={first} aria-hidden="true">
              <path
                d={`${line} L${x(last)},${bottom} L${x(first)},${bottom} Z`}
                fill={spendColor}
                fillOpacity={0.1}
              />
              <path
                d={line}
                fill="none"
                stroke={spendColor}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          ))}
          {showDetails && selected && (
            <line
              x1={x(active)}
              x2={x(active)}
              y1={top}
              y2={bottom}
              stroke="#b7a69b"
              strokeDasharray="3 4"
              aria-hidden="true"
            />
          )}
          {days.map(({ day, cost }, index) => {
            const amount = recordedSpend(cost);
            const isSelected = showDetails && index === active;
            return (
              <g
                key={day}
                ref={(element) => {
                  points.current[index] = element;
                }}
                role="button"
                tabIndex={index === active ? 0 : -1}
                aria-label={`${day}: ${estimatedUsd(amount, "cents")}. ${spendDetails(cost)}.`}
                aria-pressed={isSelected}
                className="cursor-pointer"
                onFocus={() => select(index)}
                onMouseEnter={() => select(index)}
                onClick={() => select(index)}
                onKeyDown={(event) => {
                  const next =
                    event.key === "ArrowLeft"
                      ? Math.max(0, index - 1)
                      : event.key === "ArrowRight"
                        ? Math.min(days.length - 1, index + 1)
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? days.length - 1
                            : null;
                  if (next !== null) {
                    event.preventDefault();
                    points.current[next]?.focus();
                  } else if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    select(index);
                  }
                }}
              >
                <circle
                  cx={x(index)}
                  cy={amount === null ? bottom : y(amount)}
                  r={12}
                  fill="transparent"
                />
                <circle
                  cx={x(index)}
                  cy={amount === null ? bottom : y(amount)}
                  r={isSelected ? 5 : 3}
                  fill={isSelected && amount !== null ? spendColor : "white"}
                  stroke={amount === null ? axisColor : spendColor}
                  strokeWidth={1.5}
                  strokeDasharray={amount === null ? "2 2" : undefined}
                />
              </g>
            );
          })}
        </svg>
      </div>
      <p className="flex h-12 items-center text-sm text-gray-600" role="status">
        {showDetails && selected ? (
          <span>
            <strong>{selected.day}</strong> ·{" "}
            {estimatedUsd(recordedSpend(selected.cost), "cents")} ·{" "}
            {spendDetails(selected.cost)}
          </span>
        ) : (
          "Hover or select a day to see its spend."
        )}
      </p>
    </div>
  );
}

export function DailySpend({
  report,
  page,
}: {
  report: DailySpendReport;
  page: number;
}) {
  const rangeId = useId();
  const partial = unpricedCount(report.cost) > 0;
  const totals: [string, number | null, number][] = [
    [
      "Model calls",
      report.cost.modelUsd,
      report.cost.pricedModelCalls + report.cost.unpricedModelCalls,
    ],
    [
      "Voice",
      report.cost.voiceUsd,
      report.cost.pricedVoiceSessions + report.cost.unpricedVoiceSessions,
    ],
    [
      "Images",
      report.cost.imageUsd,
      report.cost.pricedImageAttempts + report.cost.unpricedImageAttempts,
    ],
  ];

  return (
    <s-section heading="Daily spend">
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <p className="text-sm text-gray-600">
            USD · {report.from} to {report.to}
          </p>
          <dl className="flex flex-wrap gap-x-6 gap-y-3">
            <div>
              <dt className="text-xs text-gray-600">Total spend</dt>
              <dd className="mt-1 font-semibold">
                {estimatedUsd(recordedSpend(report.cost), "cents")}
              </dd>
            </div>
            {totals
              .filter(([, , count]) => count > 0)
              .map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-gray-600">{label}</dt>
                  <dd className="mt-1 font-semibold">
                    {estimatedUsd(value, "cents")}
                  </dd>
                </div>
              ))}
          </dl>
        </div>
        <form
          method="get"
          key={`range:${report.from}/${report.to}`}
          className="flex flex-wrap items-end gap-3"
        >
          {page > 1 && <input type="hidden" name="page" value={page} />}
          <div>
            <label htmlFor={`${rangeId}-from`} className="mb-1 block text-sm">
              From (UTC)
            </label>
            <input
              type="date"
              id={`${rangeId}-from`}
              name="from"
              required
              defaultValue={report.from}
              className="rounded border border-gray-300 bg-white px-3 py-2"
            />
          </div>
          <div>
            <label htmlFor={`${rangeId}-to`} className="mb-1 block text-sm">
              To (UTC)
            </label>
            <input
              type="date"
              id={`${rangeId}-to`}
              name="to"
              required
              defaultValue={report.to}
              className="rounded border border-gray-300 bg-white px-3 py-2"
            />
          </div>
          <button
            type="submit"
            className="rounded border border-gray-300 bg-white px-4 py-2 font-medium"
          >
            Apply range
          </button>
        </form>
        <p className="text-sm text-gray-600">
          Dates are inclusive, in UTC. Defaults to the last 30 days; select up
          to 366 days.
        </p>
        <SpendPlot report={report} key={`plot:${report.from}/${report.to}`} />
        {activityCount(report.cost) === 0 && (
          <p>No recorded activity in this range.</p>
        )}
        <p className="text-sm text-gray-600">
          {partial &&
            `${report.cost.totalUsd === null ? "Estimate unavailable." : "Partial estimate."} Unpriced activity is excluded from totals; unpriced-only days are gaps. `}
          USD list-price estimates use recorded usage and the rate at the start
          of each request. They are not invoices.
          {report.cost.estimatedImageAttempts > 0 &&
            " Some image attempts use a no-cache-discount estimate."}
        </p>
      </div>
    </s-section>
  );
}
