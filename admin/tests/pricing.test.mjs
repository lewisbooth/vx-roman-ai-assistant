import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { cwd } from "node:process";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: `export * from './admin/pricing/estimate.server'; export * from './admin/pricing/rates.server'; export * from './admin/pricing/validation';`,
    resolveDir: cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const {
  estimateModelUsage,
  estimateVoiceUsage,
  emptyCostSummary,
  addCost,
  MODEL_PRICES,
  validatePrices,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const usage = (extra = {}) => ({
  model: "gpt-5.6-luna",
  serviceTier: "priority",
  createdAt: new Date("2026-09-15T16:00:00.000Z"),
  inputTokens: 1000,
  cachedInputTokens: 400,
  cacheWriteInputTokens: 100,
  outputTokens: 200,
  ...extra,
});
const voice = (extra = {}) => ({
  model: "gpt-live-1",
  createdAt: "2026-09-15T16:00:00.000Z",
  usageSeconds: 171,
  ...extra,
});
const standard = MODEL_PRICES.find((row) => row.serviceTier === "default");
const fast = MODEL_PRICES.find((row) => row.serviceTier === "priority");
const close = (actual, expected) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `${actual} differs from ${expected}`,
  );

test("input cache reads and writes replace ordinary input; output includes reasoning once", () => {
  const result = estimateModelUsage(usage({ reasoningTokens: 100 }));
  // 500 ordinary input, 400 reads, 100 writes, 200 output at Fast prices.
  close(result.usd, 0.000746);
  assert.equal(result.rateId, fast.id);
  assert.equal(result.reason, null);
  close(estimateModelUsage(usage({ serviceTier: "default" })).usd, 0.000373);
});

test("returned tier selects Standard or Fast and unknown tier is never assumed", () => {
  const expected = estimateModelUsage(usage());
  assert.deepEqual(
    estimateModelUsage(usage({ serviceTier: "fast" })),
    expected,
  );
  for (const serviceTier of [null, "auto", "flex", "unknown"])
    assert.equal(
      estimateModelUsage(usage({ serviceTier })).reason,
      "missing_rate",
    );
  assert.equal(
    estimateModelUsage(usage({ model: "gpt-5.6-luna-other" })).reason,
    "missing_rate",
  );
});

test("long-context prices apply to the whole request only above the input threshold", () => {
  for (const rate of [standard, fast]) {
    const values = {
      serviceTier: rate.serviceTier,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 100,
    };
    close(
      estimateModelUsage(usage({ ...values, inputTokens: 272000 })).usd,
      (272000 * rate.prices.inputPerMillion +
        100 * rate.prices.outputPerMillion) /
        1e6,
    );
    close(
      estimateModelUsage(usage({ ...values, inputTokens: 272001 })).usd,
      (272001 * rate.longContext.prices.inputPerMillion +
        100 * rate.longContext.prices.outputPerMillion) /
        1e6,
    );
  }
});

test("UTC effective periods use each call start with inclusive start and exclusive end", () => {
  const boundary = "2026-10-01T12:00:00.000Z";
  const old = { ...fast, effectiveTo: boundary };
  const next = {
    ...fast,
    id: "future-fast",
    effectiveFrom: boundary,
    prices: { ...fast.prices, inputPerMillion: 2 },
  };
  const prices = [next, old];
  validatePrices(prices);
  const before = usage({
    createdAt: "2026-10-01T11:59:59.999Z",
    completedAt: boundary,
  });
  const original = estimateModelUsage(before, [fast]);
  assert.deepEqual(
    estimateModelUsage(before, prices),
    original,
    "Adding a future price preserves earlier request estimates, even when completion crosses it",
  );
  assert.equal(
    estimateModelUsage(usage({ createdAt: boundary }), prices).rateId,
    next.id,
  );
  assert.equal(
    estimateModelUsage(usage({ createdAt: fast.effectiveFrom }), prices).rateId,
    old.id,
  );
  assert.equal(
    estimateModelUsage(usage({ createdAt: "2026-09-14T23:59:59.999Z" }), prices)
      .reason,
    "missing_rate",
  );
  assert.equal(
    estimateModelUsage(usage({ createdAt: boundary }), [old]).reason,
    "missing_rate",
  );
});

test("closed gaps in rate history do not borrow a nearby or current price", () => {
  const old = { ...fast, effectiveTo: "2026-10-01T00:00:00.000Z" };
  const next = {
    ...fast,
    id: "later",
    effectiveFrom: "2026-11-01T00:00:00.000Z",
  };
  validatePrices([old, next]);
  assert.equal(
    estimateModelUsage(usage({ createdAt: "2026-10-10T00:00:00.000Z" }), [
      old,
      next,
    ]).reason,
    "missing_rate",
  );
  assert.equal(
    estimateModelUsage(usage({ createdAt: "invalid date" })).reason,
    "missing_rate",
  );
});

test("each missing token component leaves a request unpriced, including historic cache writes", () => {
  for (const field of [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
  ]) {
    assert.deepEqual(estimateModelUsage(usage({ [field]: null })), {
      usd: null,
      rateId: null,
      reason: "missing_usage",
    });
  }
  const result = estimateModelUsage(
    usage({
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
    }),
  );
  assert.equal(result.usd, 0);
  assert.equal(result.reason, null);
});

test("invalid counts cannot yield a negative or misleading cost", () => {
  for (const invalid of [
    { inputTokens: -1 },
    { inputTokens: 0.5 },
    { outputTokens: Infinity },
    { cachedInputTokens: NaN },
    { cacheWriteInputTokens: 1001 },
    { cachedInputTokens: 900, cacheWriteInputTokens: 101 },
  ])
    assert.equal(estimateModelUsage(usage(invalid)).reason, "invalid_usage");
});

test("voice uses fractional provider seconds and rate at connection start, not rounded minutes", () => {
  close(estimateVoiceUsage(voice()).usd, 0.1425);
  close(estimateVoiceUsage(voice({ usageSeconds: 0.5 })).usd, 0.05 / 120);
  assert.equal(estimateVoiceUsage(voice({ usageSeconds: 0 })).usd, 0);
  assert.equal(
    estimateVoiceUsage(voice({ usageSeconds: null })).reason,
    "missing_usage",
  );
  assert.equal(
    estimateVoiceUsage(voice({ model: null })).reason,
    "missing_rate",
  );
  assert.equal(
    estimateVoiceUsage(voice({ createdAt: "2026-09-14T23:59:59.999Z" })).reason,
    "missing_rate",
  );
  for (const usageSeconds of [-1, NaN, Infinity])
    assert.equal(
      estimateVoiceUsage(voice({ usageSeconds })).reason,
      "invalid_usage",
    );
  const rate = MODEL_PRICES.find((row) => row.kind === "voice");
  const old = { ...rate, effectiveTo: "2026-10-01T00:00:00.000Z" };
  const next = {
    ...rate,
    id: "new-voice",
    effectiveFrom: old.effectiveTo,
    perMinute: 0.1,
  };
  validatePrices([old, next]);
  const crossed = voice({
    createdAt: "2026-09-30T23:59:50.000Z",
    closedAt: "2026-10-01T00:02:41.000Z",
  });
  close(estimateVoiceUsage(crossed, [old, next]).usd, 0.1425);
});

test("coverage preserves unknowns, reported zero and unrounded combined costs", () => {
  const summary = emptyCostSummary();
  assert.equal(summary.totalUsd, null);
  addCost(
    summary,
    "model",
    estimateModelUsage(usage({ cacheWriteInputTokens: null })),
  );
  assert.equal(summary.totalUsd, null);
  assert.equal(summary.unpricedModelCalls, 1);
  for (let i = 0; i < 100; i++)
    addCost(summary, "model", estimateModelUsage(usage()));
  addCost(summary, "voice", estimateVoiceUsage(voice()));
  addCost(summary, "voice", estimateVoiceUsage(voice({ usageSeconds: 0 })));
  addCost(summary, "voice", estimateVoiceUsage(voice({ usageSeconds: null })));
  close(summary.modelUsd, 0.0746);
  close(summary.voiceUsd, 0.1425);
  close(summary.totalUsd, 0.2171);
  assert.equal(summary.pricedModelCalls, 100);
  assert.equal(summary.pricedVoiceSessions, 2);
  assert.equal(summary.unpricedVoiceSessions, 1);
});

test("pricing history rejects duplicate IDs, overlapping ranges and invalid rates", () => {
  validatePrices(MODEL_PRICES);
  const overlap = {
    ...fast,
    id: "overlap",
    effectiveFrom: "2026-10-01T00:00:00.000Z",
  };
  assert.throws(() => validatePrices([fast, overlap]), /overlap/);
  assert.throws(() => validatePrices([fast, { ...fast }]), /unique|overlap/);
  for (const extra of [
    { effectiveFrom: "2026-02-30T00:00:00.000Z" },
    { effectiveTo: fast.effectiveFrom },
    { effectiveTo: "2026-09-14T00:00:00.000Z" },
    { effectiveFrom: "2026-09-15" },
    { verifiedAt: "unknown" },
    { currency: "GBP" },
    { sourceUrl: "http://example.com" },
    { prices: { ...fast.prices, cacheWriteInputPerMillion: -1 } },
    { prices: { ...fast.prices, inputPerMillion: Infinity } },
    { longContext: { aboveInputTokens: -1, prices: fast.prices } },
  ])
    assert.throws(() => validatePrices([{ ...fast, ...extra }]));
});
