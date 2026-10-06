import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["admin/conversations/turn-metrics.server.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
});

function setup() {
  let now = 0;
  const module = { exports: {} };
  const require = (name) => {
    assert.equal(name, "node:perf_hooks");
    return { performance: { now: () => now } };
  };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, module, module.exports);
  return { metrics: new module.exports.TurnMetrics(), advance: (ms) => { now += ms; } };
}

const pending = (id) => ({
  id, model: "model", serviceTier: null, status: "pending",
  inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null,
  outputTokens: null, reasoningTokens: null, totalTokens: null,
});
const completed = (id, values = {}) => ({
  ...pending(id), status: "completed", serviceTier: "priority",
  inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 0,
  outputTokens: 25, reasoningTokens: 15, totalTokens: 125, ...values,
});

test("turn metrics count each provider attempt once and preserve unknown tokens rather than treating them as zero", () => {
  const { metrics, advance } = setup();
  metrics.usage(pending("primary"));
  advance(10);
  assert.equal(metrics.snapshot().inputTokens, null);
  metrics.usage({ ...pending("primary"), status: "failed" });
  metrics.usage(pending("fallback"));
  advance(20);
  metrics.usage(completed("fallback"));
  const result = metrics.snapshot();
  assert.equal(result.completions, 2);
  assert.equal(result.modelMs, 30);
  assert.equal(result.inputTokens, null);
  assert.equal(result.cachedInputTokens, null);
  assert.equal(result.reasoningTokens, null);
  assert.equal(result.cardsReadyMs, null);
  assert.equal(result.briefingReadyMs, null);
  assert.doesNotMatch(JSON.stringify(result), /primary|fallback|"model":|priority|request|transcript/);
});

test("successful token totals retain reported zeros and terminal updates cannot extend or overwrite one attempt", () => {
  const { metrics, advance } = setup();
  metrics.usage(pending("round-1"));
  advance(5);
  metrics.usage(completed("round-1"));
  advance(40);
  metrics.usage(completed("round-1"));
  metrics.usage(pending("round-1"));
  metrics.usage(pending("round-2"));
  advance(7);
  metrics.usage(completed("round-2", { inputTokens: 50, cachedInputTokens: 0, reasoningTokens: 0 }));
  const result = metrics.snapshot();
  assert.equal(result.completions, 2);
  assert.equal(result.modelMs, 12);
  assert.equal(result.inputTokens, 150);
  assert.equal(result.cachedInputTokens, 80);
  assert.equal(result.cacheWriteInputTokens, 0);
  assert.equal(result.outputTokens, 50);
  assert.equal(result.reasoningTokens, 15);
});

test("one batch search is one operation, serial mutations remain separate and ready timestamps record first availability", () => {
  const { metrics, advance } = setup();
  metrics.activity("search_products", true);
  advance(20);
  metrics.activity("search_products", false);
  metrics.activity("configure_product", true);
  advance(10);
  metrics.activity("configure_product", false);
  metrics.activity("configure_product", true);
  advance(5);
  metrics.activity("configure_product", false);
  metrics.ready(true, true);
  advance(20);
  metrics.ready(true, true);
  const result = metrics.snapshot();
  assert.deepEqual(result.tools, {
    search_products: { calls: 1, durationMs: 20 },
    configure_product: { calls: 2, durationMs: 15 },
  });
  assert.equal(result.cardsReadyMs, 35);
  assert.equal(result.briefingReadyMs, 35);
});

test("a cancellation snapshot includes active work once without resetting or mutating its timers", () => {
  const { metrics, advance } = setup();
  metrics.usage(pending("cancelled-round"));
  metrics.activity("search_products", true);
  advance(6);
  metrics.activity("search_products", true);
  advance(4);
  assert.deepEqual(metrics.snapshot().tools, { search_products: { calls: 1, durationMs: 10 } });
  assert.equal(metrics.snapshot().modelMs, 10);
  assert.deepEqual(metrics.snapshot(), metrics.snapshot());
  advance(5);
  metrics.activity("search_products", false);
  metrics.activity("search_products", false);
  metrics.usage({ ...pending("cancelled-round"), status: "unavailable" });
  const result = metrics.snapshot();
  assert.deepEqual(result.tools, { search_products: { calls: 1, durationMs: 15 } });
  assert.equal(result.modelMs, 15);
  assert.equal(result.inputTokens, null);
});

test("phase diagnostics identify repair and checkpoint bounds without recording customer or tool content", () => {
  const {metrics} = setup();
  metrics.diagnostic({type: "request", ordinal: 1, model: "gpt-6-luna", inputItems: 100, durableInputBytes: 90000, checkpoint: true, compactionEnabled: false, allowedTools: 3, cacheMode: "implicit"});
  metrics.diagnostic({type: "repair", reason: "missing_source"});
  metrics.diagnostic({type: "checkpoint", status: "rejected", bytes: 600000, throughSequence: 99});
  const first = metrics.snapshot();
  assert.equal(first.phases[1].reason, "missing_source");
  assert.equal(first.phases[2].bytes, 600000);
  first.phases.pop();
  for (let i = 0; i < 80; i++) metrics.diagnostic({type: "repair", reason: "terminal_validation"});
  assert.equal(metrics.snapshot().phases.length, 64);
  assert.doesNotMatch(JSON.stringify(metrics.snapshot()), /instructions|arguments|PRIVATE/);
});
