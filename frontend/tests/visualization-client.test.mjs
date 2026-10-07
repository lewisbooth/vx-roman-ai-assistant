import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { setImmediate as nextTick } from "node:timers/promises";
import { build } from "esbuild";

const bundle = await build({ stdin: { contents: "export {createGalleryClient} from './frontend/src/visualizations/client'", resolveDir: process.cwd() }, bundle: true, write: false, format: "cjs", platform: "browser" });
const ownerId = randomUUID();
const photoId = randomUUID();
const photo = { id: photoId, title: "Kitchen", revision: 1, cleanup: true, width: 1024, height: 1024, createdAt: "2026-10-06T12:00:00Z" };
const gallery = { enabled: true, liveWindowIds: [photoId], liveVisualizationIds: [], windows: [photo], visualizations: [], nextWindowsCursor: null, nextVisualizationsCursor: null };
function setup(t, respond) {
  const calls = [];
  const storage = new Map();
  let conversation = { id: randomUUID() };
  let prepared = 0;
  let contextRefreshes = 0;
  const module = { exports: {} };
  const ctx = { module, exports: module.exports, AbortController, AbortSignal, URL, URLSearchParams, crypto: { randomUUID }, FormData, XMLHttpRequest: class {}, navigator: {}, document: { hidden: false, addEventListener() {}, removeEventListener() {} }, localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, location: { origin: "https://shopify-single-dev.hdecom.com" }, fetch: async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/apps/roman/gallery")) return Response.json({ credential: { ownerId, token: "x".repeat(43), apiBaseUrl: "https://roman.example/api/gallery" }, gallery });
    if (url.endsWith("/link")) return Response.json({ conversationId: conversation?.id });
    return respond(url, init, calls);
  }, window: { clearTimeout() {}, setTimeout() { return 1; } } };
  runInNewContext(bundle.outputFiles[0].text, ctx);
  const client = module.exports.createGalleryClient({ getSnapshot: () => ({ conversation }), ensureMediaConversation: async () => ({ conversationId: conversation.id, conversationToken: "c".repeat(43) }), refreshMediaContext: async () => { contextRefreshes++; }, prepareVisualizationProduct: async (path) => { prepared++; return { productPath: path, references: [{ url: "https://cdn.shopify.com/s/files/1/files/blind.jpg", role: "unknown", alt: "Blind" }] }; } });
  t.after(() => client.dispose());
  return { client, calls, storage, end: () => { conversation = null; }, prepared: () => prepared, contextRefreshes: () => contextRefreshes };
}
test("Gallery capability survives End Chat and reads independently", async (t) => {
  const { client, calls, storage, end } = setup(t, async () => Response.json(gallery));
  await client.initialize();
  end();
  await client.refresh();
  assert.equal(client.getSnapshot().windows[0].id, photoId);
  assert.equal(JSON.parse(storage.get("roman-gallery-v1")).ownerId, ownerId);
  assert.equal(calls.filter((call) => call.url.endsWith("/link")).length, 1);
  assert.equal(calls.at(-1).init.headers.Authorization, `Bearer ${"x".repeat(43)}`);
  assert.ok(!calls.at(-1).url.includes("token"));
});
test("A lost start acknowledgement recovers the exact request without another paid start", async (t) => {
  const id = randomUUID();
  const requestId = randomUUID();
  const job = { id, windowId: photoId, windowTitle: "Kitchen", productPath: "/products/blind", productTitle: "Blind", status: "generating", width: 1024, height: 1024, createdAt: photo.createdAt, startedAt: photo.createdAt, completedAt: null, error: null, resultAvailable: false };
  let starts = 0;
  const { client, contextRefreshes } = setup(t, async (url, init) => {
    if (url.endsWith("/start")) { assert.equal(JSON.parse(init.body).cleanup, true); starts++; throw new TypeError("Lost acknowledgement"); }
    assert.ok(url.endsWith(`/request-status?requestId=${requestId}`));
    return Response.json({ job });
  });
  const result = await client.start({ ...photo, cleanup: false }, job.productPath, requestId);
  assert.equal(result.id, id);
  assert.equal(starts, 1);
  assert.equal((await client.recoverStart(requestId)).id, id);
  assert.equal(starts, 1);
  assert.equal(contextRefreshes(), 2, "Both accepted and recovered jobs refresh their durable inline event");
});

test("A disabled Gallery reads pending jobs without starting product preparation", async (t) => {
  const job = { id: randomUUID(), windowId: photoId, windowTitle: "Kitchen", productPath: "/products/blind", productTitle: "Blind", status: "awaiting_product", width: 1024, height: 1024, createdAt: photo.createdAt, startedAt: null, completedAt: null, error: null, resultAvailable: false };
  const { client, calls, prepared } = setup(t, async () => Response.json({ ...gallery, enabled: false, liveVisualizationIds: [job.id], visualizations: [job] }));
  await client.refresh();
  for (let i = 0; i < 3; i++) await nextTick();
  assert.equal(client.getSnapshot().enabled, false);
  assert.equal(prepared(), 0);
  assert.equal(calls.filter((call) => call.url.endsWith("/claim")).length, 0);
});

test("Gallery refresh removes photos deleted elsewhere and rejects late private-image cache writes", async (t) => {
  let finishImage;
  const { client, calls } = setup(t, async (url) => {
    if (url.includes(`/media/window/${photoId}`)) return new Promise((resolve) => { finishImage = resolve; });
    return Response.json({ ...gallery, liveWindowIds: [], windows: [] });
  });
  await client.initialize();
  const image = client.windowSource(photo);
  await nextTick();
  const fetch = calls.find((call) => call.url.includes(`/media/window/${photoId}`));
  assert.ok(fetch);
  await client.refresh();
  assert.equal(client.getSnapshot().windows.length, 0);
  assert.equal(fetch.init.signal.aborted, true);
  finishImage(new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } }));
  assert.equal(await image, null, "A response completing after deletion must not create a cached object URL");
});
test("Awaiting-product preflight claims once and returns immutable target references", async (t) => {
  const id = randomUUID();
  const job = { id, windowId: photoId, windowTitle: "Kitchen", productPath: "/products/blind", productTitle: "Blind", status: "awaiting_product", width: 1024, height: 1024, createdAt: photo.createdAt, startedAt: null, completedAt: null, error: null, resultAvailable: false };
  const { client, calls, prepared } = setup(t, async (url) => {
    if (url.endsWith("/start")) return Response.json(job);
    if (url.endsWith("/claim")) return Response.json({ claim: { token: "a".repeat(43), productPath: job.productPath } });
    if (url.endsWith("/prepare")) return Response.json({ ...job, status: "generating" });
    return Response.json({ ...gallery, liveVisualizationIds: [job.id], visualizations: [job] });
  });
  await client.start(photo, job.productPath);
  for (let i = 0; i < 5; i++) await nextTick();
  assert.equal(prepared(), 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/claim")).length, 1);
  const submission = JSON.parse(calls.find((call) => call.url.endsWith("/prepare")).init.body);
  assert.equal(submission.preparation.productPath, job.productPath);
  assert.equal(client.getSnapshot().visualizations[0].status, "generating");
});
