import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { cwd } from "node:process";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: `export * from './admin/pricing/image-estimate.server'; export * from './admin/pricing/estimate.server'; export * from './admin/pricing/validation';`,
    resolveDir: cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const {
  estimateImageUsage,
  imageRateFor,
  parseImageRateSnapshot,
  addCost,
  emptyCostSummary,
  validatePrices,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const usage = (extra = {}) => ({
  model: "gpt-image-2.5-sunburst",
  createdAt: "2026-10-06T12:00:00.000Z",
  textInputTokens: 100,
  textCachedInputTokens: 20,
  imageInputTokens: 500,
  imageCachedInputTokens: 100,
  imageOutputTokens: 1000,
  usageValid: true,
  ...extra,
});
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test("image pricing uses five modality rates and subtracts cache subsets once", () => {
  const result = estimateImageUsage(usage());
  close(result.usd, (80 * 5 + 20 * 1.25 + 400 * 8 + 100 * 2 + 1000 * 30) / 1e6);
  assert.equal(result.evidence, "reported");
  assert.equal(result.lines.length, 5);
  const flare = estimateImageUsage(usage({ model: "gpt-image-2.5-flare" }));
  close(flare.usd, result.usd);
  assert.notEqual(flare.rateId, result.rateId);
});

test("missing cache splits are labelled estimates without overwriting observed usage", () => {
  const input = usage({
    textCachedInputTokens: null,
    imageCachedInputTokens: null,
  });
  const result = estimateImageUsage(input);
  close(result.usd, (100 * 5 + 500 * 8 + 1000 * 30) / 1e6);
  assert.equal(result.evidence, "estimated");
  assert.deepEqual(
    result.lines.map((line) => line.estimated),
    [true, true, true, true, false],
  );
  assert.equal(input.textCachedInputTokens, null);
  assert.equal(input.imageCachedInputTokens, null);
});

test("partial modality usage never masquerades as a full cost or measured zero", () => {
  for (const field of [
    "textInputTokens",
    "imageInputTokens",
    "imageOutputTokens",
  ]) {
    const result = estimateImageUsage(usage({ [field]: null }));
    assert.equal(result.usd, null);
    assert.equal(result.reason, "missing_usage");
    assert.equal(result.evidence, "unknown");
  }
  const zero = estimateImageUsage(
    usage({
      textInputTokens: 0,
      textCachedInputTokens: 0,
      imageInputTokens: 0,
      imageCachedInputTokens: 0,
      imageOutputTokens: 0,
    }),
  );
  assert.equal(zero.usd, 0);
  assert.equal(zero.evidence, "reported");
});

test("contradictory, fractional, negative or malformed evidence remains unpriced", () => {
  for (const change of [
    { textCachedInputTokens: 101 },
    { imageCachedInputTokens: 501 },
    { imageOutputTokens: -1 },
    { imageInputTokens: 0.5 },
    { imageOutputTokens: Infinity },
    { imageInputTokens: "500" },
    { usageValid: false },
  ]) {
    const result = estimateImageUsage(usage(change));
    assert.equal(result.usd, null);
    assert.equal(result.reason, "invalid_usage");
  }
});

test("saved dated price is immutable and malformed snapshots don't reprice", () => {
  const original = imageRateFor(usage().model, usage().createdAt);
  const pinned = parseImageRateSnapshot(JSON.stringify(original));
  assert.deepEqual(pinned, original);
  const next = {
    ...original,
    id: "new-rate",
    prices: { ...original.prices, imageOutputPerMillion: 60 },
  };
  close(
    estimateImageUsage(usage(), pinned).usd,
    estimateImageUsage(usage()).usd,
  );
  assert.notEqual(
    estimateImageUsage(usage(), next).usd,
    estimateImageUsage(usage(), pinned).usd,
  );
  for (const json of [
    "null",
    "{}",
    "bad",
    JSON.stringify({ ...original, prices: {} }),
    JSON.stringify({
      ...original,
      prices: { ...original.prices, imageOutputPerMillion: -1 },
    }),
  ])
    assert.equal(parseImageRateSnapshot(json), null);
  assert.equal(estimateImageUsage(usage(), null).reason, "missing_rate");
  assert.equal(
    estimateImageUsage(usage({ model: "unknown" }), pinned).reason,
    "missing_rate",
  );
  assert.equal(imageRateFor(usage().model, "2026-10-05T23:59:59.999Z"), null);
  assert.throws(
    () => validatePrices([original, { ...original, id: "duplicate-period" }]),
    /overlap/,
  );
});

test("each physical attempt including failed/storage outcomes adds cost only once", () => {
  const summary = emptyCostSummary();
  addCost(summary, "image", estimateImageUsage(usage()));
  addCost(
    summary,
    "image",
    estimateImageUsage(
      usage({ textCachedInputTokens: null, imageCachedInputTokens: null }),
    ),
  );
  addCost(
    summary,
    "image",
    estimateImageUsage(usage({ imageOutputTokens: null })),
  );
  assert.equal(summary.pricedImageAttempts, 2);
  assert.equal(summary.unpricedImageAttempts, 1);
  assert.equal(summary.estimatedImageAttempts, 1);
  close(summary.totalUsd, summary.imageUsd);
});
