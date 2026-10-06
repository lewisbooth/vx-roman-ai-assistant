import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { cwd } from "node:process";

const bundle = await build({ stdin: {contents: "export {createGalleryClient} from './frontend/src/visualizations/client';", resolveDir: cwd()}, bundle: true, write: false, format: "iife", globalName: "ProductMedia", platform: "browser" });
const id = (number) => `a0000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const preview = (number, productPath = "/products/linen", status = "completed") => ({id: id(number), windowId: id(900), windowTitle: "Kitchen window", productPath, productTitle: "Linen blind", status, width: 1024, height: 1024, createdAt: "2026-10-06T12:00:00Z", startedAt: "2026-10-06T12:00:00Z", completedAt: status === "completed" ? "2026-10-06T12:00:10Z" : null, error: null, resultAvailable: status === "completed"});
const json = (value) => new Response(JSON.stringify(value), {headers: {"content-type": "application/json"}});
async function until(condition) { for (let i = 0; i < 100; i++) { if (condition()) return; await delay(5); } assert.fail("The metadata read did not start"); }
function setup(t, {visible = [], all = visible, enabled = false, blocked = false} = {}) {
  const dom = new JSDOM("", {url: "https://shop.example", runScripts: "outside-only"}), w = dom.window;
  Object.assign(w, {Response, Headers, Request, AbortSignal, AbortController});
  let rows = visible, live = all.map((item) => item.id), selected = all, current = all[0], result, nextUrl = 0;
  const calls = [], deferred = [], urls = new Set();
  w.URL.createObjectURL = () => { const url = `blob:https://shop.example/${++nextUrl}`; urls.add(url); return url; };
  w.URL.revokeObjectURL = (url) => urls.delete(url);
  const gallery = () => ({enabled, liveWindowIds: [id(900)], liveVisualizationIds: live, windows: [], visualizations: rows, nextWindowsCursor: null, nextVisualizationsCursor: all.length > visible.length ? "older-page" : null});
  w.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url)), operation = parsed.pathname.split("/").at(-1);
    calls.push({operation, productPath: parsed.searchParams.get("productPath"), signal: init.signal});
    if (operation === "gallery") return json({credential: {ownerId: id(999), token: "a".repeat(43), apiBaseUrl: "https://roman.example/api/gallery"}, gallery: gallery()});
    if (operation === "list") return json(gallery());
    if (operation === "product-visualizations") {
      const value = result ?? {productPath: parsed.searchParams.get("productPath"), visualizations: selected.filter((item) => item.productPath === parsed.searchParams.get("productPath") && item.status === "completed" && item.resultAvailable)};
      if (blocked) return new Promise((resolve, reject) => {
        const abort = () => reject(new Error("Read aborted"));
        init.signal.addEventListener("abort", abort, {once: true});
        deferred.push(() => { init.signal.removeEventListener("abort", abort); resolve(json(value)); });
      });
      return json(value);
    }
    if (operation === "job") return json(current);
    if (operation === "delete-job") return json({});
    if (parsed.pathname.includes("/media/")) return new Response(new Uint8Array([1, 2, 3]), {headers: {"content-type": "image/jpeg"}});
    assert.fail(`Unexpected operation: ${operation}`);
  };
  w.eval(bundle.outputFiles[0].text);
  const client = w.ProductMedia.createGalleryClient({getSnapshot: () => ({conversation: null}), prepareVisualizationProduct: () => assert.fail("Reading previews must not prepare products")});
  t.after(() => { client.dispose(); assert.equal(urls.size, 0); dom.window.close(); });
  return {client, calls, deferred, urls,
    setResult(value) { result = value; },
    setCurrent(value) { current = value; },
    setGallery(value, ids = value.map((item) => item.id)) { rows = value; live = ids; },
  };
}

test("product metadata loads previous Gallery pages while disabled without generating or changing pagination", async (t) => {
  const all = Array.from({length: 30}, (_, i) => preview(i + 1));
  const other = preview(40, "/products/other"), pending = preview(41, "/products/linen", "generating");
  const ctx = setup(t, {visible: [other, pending], all: [...all, other, pending]});
  await ctx.client.loadProductVisualizations("/products/linen");
  const state = ctx.client.getSnapshot();
  assert.equal(state.enabled, false);
  assert.equal(state.visualizations.filter((item) => item.status === "completed" && item.productPath === "/products/linen").length, 30);
  assert.ok(state.visualizations.some((item) => item.id === other.id));
  assert.ok(state.visualizations.some((item) => item.id === pending.id));
  assert.equal(state.nextVisualizationsCursor, "older-page");
  assert.equal(ctx.calls.filter((call) => call.operation === "product-visualizations").length, 1);
  assert.equal(ctx.calls.filter((call) => ["claim", "prepare", "start", "list"].includes(call.operation)).length, 0);
});

test("same-path concurrent reads share one operation and a later product selection rejects the older result", async (t) => {
  const ctx = setup(t, {all: [preview(1), preview(2, "/products/other")], blocked: true});
  const first = ctx.client.loadProductVisualizations("/products/linen");
  const shared = ctx.client.loadProductVisualizations("/products/linen");
  await until(() => ctx.deferred.length === 1);
  const second = ctx.client.loadProductVisualizations("/products/other");
  await until(() => ctx.deferred.length === 2);
  assert.equal(ctx.calls.find((call) => call.operation === "product-visualizations").signal.aborted, true, "The superseded path read must release its network request");
  ctx.deferred[1](); await second;
  ctx.deferred[0](); await Promise.all([first, shared]);
  assert.deepEqual([...ctx.client.getSnapshot().visualizations].map((item) => item.id), [id(2)]);
  assert.equal(ctx.calls.filter((call) => call.operation === "product-visualizations").length, 2);
  assert.equal(ctx.client.getSnapshot().error, null, "Expected selection cancellation stays silent");
});

test("invalid product metadata is rejected atomically and cannot inject another product or a pending result", async (t) => {
  const ctx = setup(t, {visible: [preview(1)]});
  await ctx.client.initialize();
  for (const value of [
    {productPath: "/products/other", visualizations: [preview(2)]},
    {productPath: "/products/linen", visualizations: [preview(2, "/products/other")]},
    {productPath: "/products/linen", visualizations: [preview(2, "/products/linen", "generating")]},
    {productPath: "/products/linen", visualizations: [{...preview(2), resultAvailable: false}]},
    {productPath: "/products/linen", visualizations: [preview(2), preview(2)]},
    {productPath: "/products/linen", visualizations: Array.from({length: 501}, (_, i) => preview(i + 2))},
  ]) {
    ctx.setResult(value);
    await assert.rejects(ctx.client.loadProductVisualizations("/products/linen"), /invalid product previews/);
    assert.deepEqual([...ctx.client.getSnapshot().visualizations].map((item) => item.id), [id(1)]);
  }
  await assert.rejects(ctx.client.loadProductVisualizations("/collections/blinds"), /canonical/);
});

test("missing completed matches release private consumers while unrelated and pending rows remain", async (t) => {
  const completed = preview(1), other = preview(2, "/products/other"), pending = preview(3, "/products/linen", "generating");
  const ctx = setup(t, {visible: [completed, other, pending]});
  const lease = await ctx.client.resultSource(completed);
  assert.ok(lease); assert.equal(ctx.urls.size, 1);
  ctx.setResult({productPath: "/products/linen", visualizations: []});
  await ctx.client.loadProductVisualizations("/products/linen");
  assert.deepEqual([...ctx.client.getSnapshot().visualizations].map((item) => item.id).sort(), [other.id, pending.id].sort());
  assert.equal(ctx.urls.size, 0);
  lease.release();
});

test("a completion arriving during the metadata read remains in the live product gallery", async (t) => {
  const pending = preview(1, "/products/linen", "generating");
  const ctx = setup(t, {visible: [pending], blocked: true});
  const loading = ctx.client.loadProductVisualizations("/products/linen");
  await until(() => ctx.deferred.length === 1);
  ctx.setCurrent(preview(1)); await ctx.client.check(pending);
  ctx.deferred[0](); await loading;
  assert.equal(ctx.client.getSnapshot().visualizations[0].status, "completed");
});

test("metadata captured before local deletion cannot restore the removed preview", async (t) => {
  const completed = preview(1), ctx = setup(t, {visible: [completed], blocked: true});
  const loading = ctx.client.loadProductVisualizations("/products/linen");
  await until(() => ctx.deferred.length === 1);
  await ctx.client.deleteVisualization(completed);
  ctx.deferred[0](); await loading;
  assert.equal(ctx.client.getSnapshot().visualizations.length, 0);
});

test("deleting another product does not cancel the selected product's older previews", async (t) => {
  const older = preview(1), unrelated = preview(2, "/products/other");
  const ctx = setup(t, {visible: [unrelated], all: [older, unrelated], blocked: true});
  const loading = ctx.client.loadProductVisualizations("/products/linen");
  await until(() => ctx.deferred.length === 1);
  await ctx.client.deleteVisualization(unrelated);
  assert.equal(ctx.calls.find((call) => call.operation === "product-visualizations").signal.aborted, false);
  ctx.deferred[0](); await loading;
  assert.deepEqual([...ctx.client.getSnapshot().visualizations].map((item) => item.id), [older.id]);
});

test("private metadata failures are visible only in Gallery diagnostics and settle on a successful retry", async (t) => {
  const ctx = setup(t, {visible: [preview(1)]});
  ctx.setResult({productPath: "/products/wrong", visualizations: []});
  await assert.rejects(ctx.client.loadProductVisualizations("/products/linen"), /invalid product previews/);
  assert.match(ctx.client.getSnapshot().error, /invalid product previews/);
  ctx.setResult({productPath: "/products/linen", visualizations: [preview(1)]});
  await ctx.client.loadProductVisualizations("/products/linen");
  assert.equal(ctx.client.getSnapshot().error, null);
});

test("disposing the Gallery owner cancels its optional product read", async (t) => {
  const ctx = setup(t, {all: [preview(1)], blocked: true});
  const loading = ctx.client.loadProductVisualizations("/products/linen");
  await until(() => ctx.deferred.length === 1);
  ctx.client.dispose(); await loading;
  assert.equal(ctx.calls.find((call) => call.operation === "product-visualizations").signal.aborted, true);
  assert.equal(ctx.client.getSnapshot().visualizations.length, 0);
});

test("a refreshed live-ID set rejects a deleted older preview that was not in the first page", async (t) => {
  const completed = preview(1), ctx = setup(t, {visible: [], all: [completed], blocked: true});
  const loading = ctx.client.loadProductVisualizations("/products/linen");
  await until(() => ctx.deferred.length === 1);
  ctx.setGallery([], []); await ctx.client.refresh();
  ctx.deferred[0](); await loading;
  assert.equal(ctx.client.getSnapshot().visualizations.length, 0);
});
