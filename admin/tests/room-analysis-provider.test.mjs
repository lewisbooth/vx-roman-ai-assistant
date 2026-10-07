import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["admin/visualizations/analysis-provider.server.ts"], bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "mock-api", setup(builder) {
    builder.onResolve({ filter: /^openai$/ }, args => ({ path: args.path, namespace: "mock" }));
    builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: `export default class OpenAI {constructor(options){mock.options=options;this.responses={create:(...args)=>mock.create(...args)}}}` }));
  } }],
});
const observed = { image_kind: "other", summary: "No room is visible.", colours: [], decor_style: [], notable_features: [], windows: { visible_count: 0, count_confidence: "high", count_note: "", items: [] }, limitations: ["This is not a room photo."] };
const response = { status: "completed", model: "gpt-6-luna", service_tier: "fast", output_text: JSON.stringify(observed), usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 20 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 150 } };
function load(create) {
  const mock = { create }; const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, mock, process: { env: { OPENAI_API_KEY: "test" } } });
  return { api: module.exports, mock };
}
test("analysis uses the benchmarked narrow request, no persistence or SDK retries, and records reported usage", async () => {
  let request, options; const usage = [];
  const { api, mock } = load(async (body, settings) => { request = body; options = settings; return response; });
  const signal = new AbortController().signal;
  const result = await api.analyzeRoomPhoto(Buffer.from("private image"), { usageId: "usage", signal, onUsage: async value => usage.push(value) });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), observed);
  assert.equal(mock.options.maxRetries, 0); assert.equal(mock.options.timeout, 30000); assert.equal(options.signal, signal);
  assert.equal(request.model, "gpt-6-luna"); assert.equal(request.service_tier, "fast"); assert.equal(request.store, false); assert.equal(request.reasoning.effort, "none");
  assert.equal(request.input[0].content[1].detail, "high"); assert.equal(request.text.format.strict, true);
  assert.equal(request.max_output_tokens, 2400); assert.equal(usage[0].model, "gpt-6-luna"); assert.equal(usage[0].serviceTier, "fast"); assert.equal(usage[0].cacheWriteInputTokens, 20);
});
test("malformed or incomplete output cannot lose provider usage or become cached observations", async () => {
  for (const variant of [{ ...response, output_text: "{}" }, { ...response, status: "incomplete" }]) {
    const usage = []; const { api } = load(async () => variant);
    await assert.rejects(api.analyzeRoomPhoto(Buffer.from("private"), { usageId: "usage", signal: new AbortController().signal, onUsage: async value => usage.push(value) }));
    assert.equal(usage.length, 1); assert.equal(usage[0].inputTokens, 100);
  }
});
