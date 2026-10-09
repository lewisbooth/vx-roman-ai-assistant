import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import process from "node:process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: `export { createGuideTurn, MissingMeasuringSourceError } from './admin/conversations/guide-turn.server';
      export { StorefrontTurn } from './admin/conversations/storefront-turn.server';`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: "node", format: "cjs",
  plugins: [{ name: "guide-read-only", setup(build) {
    build.onResolve({ filter: /guides\/files\.server$/ }, () => ({ path: "files", namespace: "mock" }));
    build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
      contents: "export const readProductGuideFiles=(...args)=>mock.read(...args);",
    }));
  } }],
});
const origin = "https://shop.example";
const productPath = "/products/bifold-blind";
const source = { kind: "measuring", url: `${origin}/cdn/shop/files/bifold.pdf?v=1` };
const file = { type: "input_file", detail: "high", filename: "measuring-guide.pdf",
  file_data: `data:application/pdf;base64,${Buffer.from("%PDF-1.7 fixture").toString("base64")}` };
const configuration = {
  status: "available", productPath,
  configurationId: "edc4f197-8f34-48f8-8f08-2f227b1e4287",
  controls: [{ id: "c0", kind: "radio", label: "Fitting", options: [
    { id: "o0", label: "Exact", selected: true, available: true },
  ] }],
  measurements: { unit: "mm", width: null, height: null, availableUnits: ["mm"] },
  configuredPrice: null, message: "Native setup.",
};
const browserResult = { status: "found", productPath, guides: [source], configuration };
const call = { name: "get_product_guides", call_id: "guide-read", arguments: JSON.stringify({ productPath, kinds: ["measuring"], refresh: false, library: null, readOriginals: true }) };
const plain = (value) => JSON.parse(JSON.stringify(value));
function setup({ failed = false, cached, result = browserResult, libraryReuse, onExecute } = {}) {
  const module = { exports: {} }, calls = [], reads = [], observed = [], saved = [], cleared = [], controller = new AbortController();
  const mock = { read: async (...args) => { reads.push(args); return failed
    ? { status: "unavailable", reason: "download_failed" }
    : { status: "ready", sources: [source], files: [file] }; } };
  runInNewContext(bundle.outputFiles[0].text, {
    exports: module.exports, module, require, mock, Buffer, URL, console, AbortController,
  });
  const actions = new module.exports.StorefrontTurn();
  const turn = module.exports.createGuideTurn({
    execute: async (...args) => { calls.push(args); await onExecute?.(...args); return typeof result === "function" ? result(...args) : result; },
    signal: controller.signal, storefrontOrigin: origin,
    trackTool: (_, action) => action(),
    onConfiguration: (value) => { observed.push(value); actions.observeConfiguration(value); },
    guideReuse: { cached, read: (value) => saved.push(value), clear() { cleared.push(true); } },
    libraryReuse,
  });
  return { turn, actions, calls, reads, observed, saved, cleared, controller,
    MissingMeasuringSourceError: module.exports.MissingMeasuringSourceError };
}

test("missing physical-reading evidence has a typed product-scoped recovery contract", async () => {
  const ctx = setup();
  await assert.rejects(ctx.turn.questionSource(productPath), (error) => {
    assert.ok(error instanceof ctx.MissingMeasuringSourceError);
    assert.equal(error.code, "missing_measuring_source");
    assert.equal(error.productPath, productPath);
    return true;
  });
  assert.deepEqual(plain(await ctx.turn.questionSource()), {});
  assert.equal(ctx.calls.length, 0);
});

test("failed product originals retain a recoverable evidence gap without losing native configuration", async () => {
  const ctx = setup({ failed: true });
  await ctx.turn.read(call);
  await assert.rejects(ctx.turn.questionSource(productPath), {
    name: "MissingMeasuringSourceError", code: "missing_measuring_source", productPath,
  });
  assert.equal(ctx.actions.allows("configure_product"), true);
  assert.equal(ctx.calls.length, 1);
});

test("a verified library bound to the current product satisfies the source gap independently of its wrong product link", async () => {
  const bound = { productPath, pageId: "verified-current-visit",
    source: { sourceCallId: "matching-library-read", library: "blinds" } };
  const ctx = setup({ failed: true, libraryReuse: { inventory: [], bound,
    bind: async (_source, path) => path === productPath ? bound : undefined,
  } });
  await ctx.turn.read(call);
  assert.deepEqual(plain(await ctx.turn.questionSource(productPath)), {
    sourceCallId: "matching-library-read", librarySource: bound,
  });
  await assert.rejects(ctx.turn.questionSource("/products/other"), {
    name: "MissingMeasuringSourceError", productPath: "/products/other",
  });
});

test("one fresh guide operation supplies validated configuration and never caches its capability with PDFs", async () => {
  const ctx = setup();
  const result = await ctx.turn.read(call);
  assert.deepEqual(plain(ctx.calls), [["guide-read", "get_product_guides", { productPath }]]);
  assert.deepEqual(plain(result.output.configuration), configuration);
  assert.equal(ctx.observed.length, 1);
  assert.equal(ctx.actions.allows("configure_product"), true);
  ctx.actions.before({ name: "configure_product", arguments: {
    productPath, configurationId: configuration.configurationId, controlId: "c0", optionId: "o0",
  } });
  assert.equal(ctx.actions.allows("configure_product"), false);
  assert.equal(ctx.saved.length, 1);
  assert.equal("configuration" in ctx.saved[0], false);
  assert.equal(result.output.documentStatus, "ready");
});

test("failed PDFs retain native limits/options for the fallback guide without claiming source evidence", async () => {
  const ctx = setup({ failed: true });
  const result = await ctx.turn.read(call);
  assert.equal(result.output.documentStatus, "unavailable");
  assert.deepEqual(plain(result.output.configuration), configuration);
  assert.equal(ctx.observed.length, 1);
  assert.equal(ctx.saved.length, 0);
});

test("cached originals and resumed guide reads do not reuse a stale product capability or fetch the browser", async () => {
  const ctx = setup({ cached: {
    origin, productPath, sourceCallId: "previous-guide", sourceAssistantId: "previous-assistant",
    pageId: "page", expiresAt: Date.now() + 10000, kinds: ["measuring"], sources: [source], files: [file],
  } });
  const result = await ctx.turn.read(call);
  assert.equal(result.output.documentStatus, "ready");
  assert.equal("configuration" in result.output, false);
  assert.equal(ctx.observed.length, 0);
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.actions.allows("configure_product"), false);
});

test("wrong-product configuration cannot establish a capability", async () => {
  const ctx = setup({ result: { ...browserResult, configuration: { ...configuration, productPath: "/products/other" } } });
  const result = await ctx.turn.read(call);
  assert.equal(result.output.documentStatus, "unavailable");
  assert.equal("configuration" in result.output, false);
  assert.equal(ctx.observed.length, 0);
  assert.equal(ctx.actions.allows("configure_product"), false);
});

test("cancelled guide reads publish neither configuration nor mutation authority", async () => {
  const ctx = setup();
  ctx.controller.abort();
  await assert.rejects(ctx.turn.read(call), { name: "AbortError" });
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.observed.length, 0);
  assert.equal(ctx.actions.allows("configure_product"), false);
});

const priorGuide = () => ({
  origin, productPath, sourceCallId: "earlier-original", sourceAssistantId: "earlier-assistant",
  pageId: "current-visit", expiresAt: Date.now() + 10000, kinds: ["measuring"], sources: [source], files: [file],
});
const writtenCall = (refresh = false) => ({ ...call,
  arguments: JSON.stringify({ productPath, kinds: ["measuring"], refresh, library: null, readOriginals: false }),
});

test("originals reuse this turn's verified links and source receipt without renewing configuration authority", async () => {
  const ctx = setup();
  await ctx.turn.read(writtenCall());
  assert.equal(ctx.reads.length, 0);
  await assert.rejects(ctx.turn.questionSource(productPath), { name: "MissingMeasuringSourceError" });

  const result = await ctx.turn.read({ ...call, call_id: "read-originals" });
  assert.equal(ctx.calls.length, 1, "The original request needs no second product-page lookup");
  assert.equal(ctx.reads.length, 1, "Originals are still read before measuring is authorized");
  assert.equal(result.output.documentStatus, "ready");
  assert.equal(result.output.originalsAttached, true);
  assert.equal("configuration" in result.output, false);
  assert.equal(ctx.observed.length, 1, "The old native capability is never observed again");
  assert.equal(ctx.saved[0].sourceCallId, "guide-read");
  assert.deepEqual(plain(await ctx.turn.questionSource(productPath)), { sourceCallId: "guide-read" });
});

test("operation, navigation and explicit refresh invalidate this turn's reusable links", async (t) => {
  for (const invalidation of ["operation", "navigation", "refresh"])
    await t.test(invalidation, async () => {
      const ctx = setup();
      await ctx.turn.read(writtenCall());
      if (invalidation === "operation") ctx.turn.beforeOperation();
      if (invalidation === "navigation") ctx.turn.invalidateForNavigation();
      await ctx.turn.read({ ...call, call_id: "fresh-originals",
        arguments: JSON.stringify({ productPath, kinds: ["measuring"],
          refresh: invalidation === "refresh", library: null, readOriginals: true }),
      });
      assert.equal(ctx.calls.length, 2);
      assert.equal(ctx.observed.length, 2);
      assert.equal(ctx.saved[0].sourceCallId, "fresh-originals");
    });
});

test("a failed subsequent metadata lookup cannot leave older links reusable", async () => {
  let calls = 0;
  const ctx = setup({ result: () => ++calls === 2 ? { error: "Lookup failed" } : browserResult });
  await ctx.turn.read(writtenCall());
  await ctx.turn.read({ ...writtenCall(), call_id: "failed-lookup" });
  await ctx.turn.read({ ...call, call_id: "fresh-originals" });
  assert.equal(ctx.calls.length, 3);
  assert.equal(ctx.saved[0].sourceCallId, "fresh-originals");
});

test("metadata-only lookups still read current configuration instead of cached links", async () => {
  const ctx = setup();
  await ctx.turn.read(writtenCall());
  await ctx.turn.read({ ...writtenCall(), call_id: "fresh-configuration" });
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.observed.length, 2);
  assert.equal(ctx.reads.length, 0);
});

test("cancelled original requests neither reuse nor publish this turn's link evidence", async () => {
  const ctx = setup();
  await ctx.turn.read(writtenCall());
  ctx.controller.abort();
  await assert.rejects(ctx.turn.read({ ...call, call_id: "cancelled-originals" }), { name: "AbortError" });
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.reads.length, 0);
  assert.equal(ctx.saved.length, 0);
});

test("a link/configuration lookup retains only exactly matching valid prior PDF authority", async () => {
  const cached = priorGuide();
  const ctx = setup({ cached });
  const result = await ctx.turn.read(writtenCall());
  assert.equal(result.output.originalsAttached, false);
  assert.equal(ctx.calls.length, 1, "Native capability comes from a fresh read, not cached originals");
  assert.equal(ctx.observed.length, 1);
  assert.equal(ctx.saved.length, 0);
  assert.equal(ctx.cleared.length, 0);
  assert.deepEqual(plain(await ctx.turn.questionSource(productPath)), { sourceCallId: cached.sourceCallId });
  assert.equal(ctx.turn.context().flatMap(item => Array.isArray(item.content) ? item.content : []).filter(part => part.type === "input_file").length, 0);
});

test("changed product links invalidate retained original authority during a written-only lookup", async () => {
  const ctx = setup({ cached: priorGuide(), result: { ...browserResult,
    guides: [{ ...source, url: `${origin}/cdn/shop/files/replacement.pdf?v=2` }],
  } });
  await ctx.turn.read(writtenCall());
  assert.equal(ctx.cleared.length, 1);
  assert.equal(ctx.turn.cachedSource(), undefined);
  await assert.rejects(ctx.turn.questionSource(productPath), { name: "MissingMeasuringSourceError" });
  assert.doesNotMatch(JSON.stringify(ctx.turn.context()), /priorProductRead/);
});

test("failed explicit product refresh revokes earlier PDF authority", async () => {
  const ctx = setup({ cached: priorGuide(), result: { error: "Native read failed." } });
  await ctx.turn.read(writtenCall(true));
  assert.ok(ctx.cleared.length > 0);
  assert.equal(ctx.turn.cachedSource(), undefined);
  await assert.rejects(ctx.turn.questionSource(productPath), { name: "MissingMeasuringSourceError" });
  assert.doesNotMatch(JSON.stringify(ctx.turn.context()), /priorProductRead/);
});

test("expired retained PDF evidence cannot authorize another physical reading", async () => {
  const cached = priorGuide();
  const ctx = setup({ cached });
  cached.expiresAt = Date.now() - 1;
  await assert.rejects(ctx.turn.questionSource(productPath), { name: "MissingMeasuringSourceError" });
  assert.equal(ctx.turn.cachedSource(), undefined);
  assert.equal(ctx.cleared.length, 1);
});
