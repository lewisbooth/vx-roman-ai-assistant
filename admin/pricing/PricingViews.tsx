import type {
  CostEstimate,
  CostSummary,
  ModelPrice,
  TokenPrices,
} from "./contracts";
import {
  estimatedUsd,
  priceBoundary,
  recordedNumber,
  serviceTierLabel,
} from "../insights/format";

export function EstimatedCosts({ cost }: { cost: CostSummary }) {
  const partial = cost.unpricedModelCalls > 0 || cost.unpricedVoiceSessions > 0;
  const estimates: [string, number | null][] = [
    ["Total estimate", cost.totalUsd],
    ["Model calls", cost.modelUsd],
    ["Voice sessions", cost.voiceUsd],
  ];
  return (
    <s-stack gap="base">
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {estimates.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="mt-1 font-semibold">{estimatedUsd(value)}</dd>
          </div>
        ))}
      </dl>
      <s-paragraph color="subdued">
        {partial ? "Partial estimate. " : ""}
        Priced {cost.pricedModelCalls} of{" "}
        {cost.pricedModelCalls + cost.unpricedModelCalls} model calls and{" "}
        {cost.pricedVoiceSessions} of{" "}
        {cost.pricedVoiceSessions + cost.unpricedVoiceSessions} voice sessions.
        {partial ? " Unpriced activity is excluded from the totals." : ""} USD
        list-price estimates use reported usage and the rate period at the start
        of each call or voice session. They are not invoices.
      </s-paragraph>
    </s-stack>
  );
}

const reasonLabels = {
  missing_usage: "Required usage not recorded",
  missing_rate: "No rate for this model, tier or date",
  invalid_usage: "Usage is inconsistent; cannot estimate",
};

export function CostValue({ cost }: { cost: CostEstimate }) {
  return (
    <div>
      <span>{estimatedUsd(cost.usd)}</span>
      {cost.reason && (
        <div className="text-xs text-gray-600">{reasonLabels[cost.reason]}</div>
      )}
      {cost.rateId && (
        <div className="break-words text-xs text-gray-600">
          Rate: {cost.rateId}
        </div>
      )}
    </div>
  );
}

function TokenRate({ prices }: { prices: TokenPrices }) {
  return (
    <dl className="grid grid-cols-[auto_auto] gap-x-3 text-sm">
      <dt>Input</dt>
      <dd>{estimatedUsd(prices.inputPerMillion)}</dd>
      <dt>Cached input</dt>
      <dd>{estimatedUsd(prices.cachedInputPerMillion)}</dd>
      <dt>Cache-write input</dt>
      <dd>{estimatedUsd(prices.cacheWriteInputPerMillion)}</dd>
      <dt>Output</dt>
      <dd>{estimatedUsd(prices.outputPerMillion)}</dd>
    </dl>
  );
}

export function PricingHistory({ prices }: { prices: readonly ModelPrice[] }) {
  if (prices.length === 0)
    return <s-paragraph>No pricing periods configured.</s-paragraph>;
  return (
    <s-stack gap="base">
      <s-paragraph color="subdued">
        Rate periods start at the inclusive From time and end before the
        exclusive Until time, in UTC. Token rates are USD per million tokens.
        Short and long context rates apply to the whole request, not just tokens
        above the threshold. Voice uses provider-reported seconds at the
        per-minute rate divided by 60.
      </s-paragraph>
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Model / tier</s-table-header>
          <s-table-header>From (inclusive)</s-table-header>
          <s-table-header>Until (exclusive)</s-table-header>
          <s-table-header>USD rates</s-table-header>
          <s-table-header>Verified / source</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {prices.map((price) => (
            <s-table-row key={price.id}>
              <s-table-cell>
                <div>{price.model}</div>
                {price.kind === "tokens" && (
                  <div>{serviceTierLabel(price.serviceTier)}</div>
                )}
                <div className="text-xs text-gray-600">{price.id}</div>
              </s-table-cell>
              <s-table-cell>
                <time dateTime={price.effectiveFrom}>
                  {priceBoundary(price.effectiveFrom)}
                </time>
              </s-table-cell>
              <s-table-cell>
                {price.effectiveTo ? (
                  <time dateTime={price.effectiveTo}>
                    {priceBoundary(price.effectiveTo)}
                  </time>
                ) : (
                  "Open ended"
                )}
              </s-table-cell>
              <s-table-cell>
                {price.kind === "voice" ? (
                  <span>{estimatedUsd(price.perMinute)} per minute</span>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <p className="font-semibold">
                        {price.longContext
                          ? `Short context: up to ${recordedNumber(price.longContext.aboveInputTokens)} input tokens`
                          : "All requests"}
                      </p>
                      <TokenRate prices={price.prices} />
                    </div>
                    {price.longContext && (
                      <div>
                        <p className="font-semibold">
                          Long context: over{" "}
                          {recordedNumber(price.longContext.aboveInputTokens)}{" "}
                          input tokens
                        </p>
                        <TokenRate prices={price.longContext.prices} />
                      </div>
                    )}
                  </div>
                )}
              </s-table-cell>
              <s-table-cell>
                <div>
                  <time dateTime={price.verifiedAt}>
                    {priceBoundary(price.verifiedAt)}
                  </time>
                </div>
                <s-link href={price.sourceUrl} target="_blank">
                  Pricing source
                </s-link>
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-stack>
  );
}
