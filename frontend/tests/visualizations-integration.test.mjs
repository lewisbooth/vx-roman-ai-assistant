import assert from "node:assert/strict";
import { cwd } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { historySnapshot } from "./helpers/history-snapshot.mjs";

const bundle = await build({
  stdin: { contents: `
    import {StrictMode} from 'react';
    import {createRoot} from 'react-dom/client';
    import {RouterProvider} from 'react-router/dom';
    import {createAssistantRouter} from './frontend/src/app';
    export function mount(target,props){const router=createAssistantRouter(props),root=createRoot(target);
      root.render(<StrictMode><RouterProvider router={router}/></StrictMode>);
      return ()=>{root.unmount();router.dispose();};}
  `, loader: "tsx", resolveDir: cwd() },
  bundle: true, write: false, platform: "browser", format: "iife", globalName: "MediaIntegration", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
});
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const windowId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const jobId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const questionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const photo = () => ({id: windowId, title: "Kitchen window", revision: 1, cleanup: true, width: 864, height: 1152, createdAt: "2026-10-06T12:00:00Z"});
const job = (window = photo()) => ({id: jobId, windowId: window.id, windowTitle: window.title, productPath: "/products/linen", productTitle: "Linen blind", status: "generating", width: window.width, height: window.height, createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: null, error: null, resultAvailable: false});
const row = (id, role, parts) => ({id, role, parts, status: "complete", createdAt: "2026-10-06T12:00:00Z"});
function conversation({active = false, parts = []} = {}) {
  return historySnapshot({id: "conversation", status: "active", revision: 1, busy: false, tools: [],
    current: {activeProduct: active ? {path: "/products/linen", title: "Linen blind"} : null, pendingQuestion: null, hasCustomerReply: !!parts.length, selectedWindow: null},
    messages: parts.length ? [row("saved-media", "context", parts)] : [],
  });
}
async function until(condition, message) {
  for (let index = 0; index < 150; index++) { if (condition()) return; await delay(5); }
  assert.fail(message);
}

async function setup(t, options = {}) {
  const dom = new JSDOM("<!doctype html><roman-ai-assistant></roman-ai-assistant>", {url: "https://shop.example/products/background", runScripts: "outside-only", pretendToBeVisual: true});
  const {window} = dom;
  Object.assign(window, {Request, Response, Headers});
  window.document.documentElement.setAttribute("data-roman-open", "");
  window.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}});
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  window.HTMLImageElement.prototype.decode = async () => {};
  Object.defineProperty(window.HTMLImageElement.prototype, "naturalWidth", {get: () => 600});
  Object.defineProperty(window.HTMLImageElement.prototype, "naturalHeight", {get: () => 800});
  window.IntersectionObserver = class { constructor(callback) { this.callback = callback; } observe() { queueMicrotask(() => this.callback([{isIntersecting: true}])); } disconnect() {} };
  let urlCounter = 0;
  window.URL.createObjectURL = () => `blob:https://shop.example/${++urlCounter}`;
  window.URL.revokeObjectURL = () => {};
  const xhrs = [];
  window.XMLHttpRequest = class {
    constructor() { this.upload = {}; xhrs.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    send(body) { this.body = body; }
    abort() { this.onabort?.(); this.onloadend?.(); }
    complete(value) { this.status = 200; this.responseText = JSON.stringify(value); this.onload?.(); this.onloadend?.(); }
    fail() { this.onerror?.(); this.onloadend?.(); }
  };
  const errors = [], calls = [], sent = [], activity = [], listeners = new Set();
  window.console.error = (...args) => errors.push(args);
  let state = {conversation: options.active ? conversation({active: true}) : null, pending: !!options.pending, restoring: false, error: null, voice: {status: options.voice ? "active" : "idle", muted: false, error: null}};
  let windows = options.saved ? [photo()] : [], visualizations = options.jobs ?? [], historicalJobs = options.productJobs ?? [], pendingParts = [];
  let loseStart = !!options.loseStart, loseStatus = !!options.loseStart, loseUploadStatus = !!options.loseUpload;
  const update = (patch) => { state = {...state, ...patch}; listeners.forEach((listener) => listener()); };
  const snapshot = () => ({enabled: options.enabled ?? true, liveWindowIds: windows.map((item) => item.id), liveVisualizationIds: [...new Set([...visualizations, ...historicalJobs].map((item) => item.id))], windows, visualizations, nextWindowsCursor: null, nextVisualizationsCursor: historicalJobs.length ? "older-page" : null});
  const respond = (value) => new Response(JSON.stringify(value), {headers: {"Content-Type": "application/json"}});
  window.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url)), path = parsed.pathname, body = init.body ? JSON.parse(init.body) : null;
    calls.push({path, query: parsed.searchParams, body});
    if (path === "/cart.js") return respond({currency: "GBP", item_count: 0, total_price: 0, items: []});
    if (path === "/apps/roman/gallery") return respond({credential: {ownerId, token: "a".repeat(43), apiBaseUrl: "https://roman.example/api/gallery"}, gallery: snapshot()});
    const operation = path.split("/").at(-1);
    if (operation === "link") return respond({});
    if (operation === "list") return respond(snapshot());
    if (operation === "product-visualizations") {
      await options.onProductRead?.();
      const productPath = parsed.searchParams.get("productPath");
      return respond({productPath, visualizations: [...new Map([...historicalJobs, ...visualizations].map((item) => [item.id, item])).values()].filter((item) => item.productPath === productPath && item.status === "completed" && item.resultAvailable)});
    }
    if (operation === "references") return respond({windows: windows.filter((item) => body.windowIds.includes(item.id)), visualizations: visualizations.filter((item) => body.jobIds.includes(item.id))});
    if (operation === "select") {
      update({conversation: {...state.conversation, current: {...state.conversation.current, selectedWindow: windows.find((item) => item.id === body.windowId)}}});
      await options.onSelect?.();
      return respond(windows.find((item) => item.id === body.windowId));
    }
    if (operation === "rename") {
      assert.equal(body.revision, windows[0].revision);
      windows = [{...windows[0], title: body.title, revision: body.revision + 1}];
      pendingParts.push({type: "media", version: 1, kind: "renamed", windowId, previousTitle: "Kitchen window", title: body.title});
      return respond(windows[0]);
    }
    if (operation === "start") {
      visualizations = [job(windows[0])];
      pendingParts.push({type: "media", version: 1, kind: "visualization", jobId, customerIntent: true});
      if (loseStart) { loseStart = false; throw new Error("Start acknowledgement lost"); }
      return respond(visualizations[0]);
    }
    if (operation === "request-status") {
      if (loseStatus) { loseStatus = false; throw new Error("Status temporarily unavailable"); }
      return respond({job: visualizations[0] ?? null});
    }
    if (operation === "upload-status") {
      if (loseUploadStatus) { loseUploadStatus = false; throw new Error("Upload status temporarily unavailable"); }
      return respond(windows.length ? {status: "saved", window: windows[0]} : {status: "not_found"});
    }
    if (operation === "job") return respond(visualizations[0]);
    if (operation === "delete-window") { windows = []; visualizations = []; return respond({}); }
    if (operation === "delete-job") { visualizations = visualizations.filter((item) => item.id !== body.jobId); historicalJobs = historicalJobs.filter((item) => item.id !== body.jobId); return respond({}); }
    if (path.includes("/media/")) return new Response(new Uint8Array([1, 2]), {headers: {"Content-Type": "image/jpeg"}});
    assert.fail(`Unexpected media operation: ${path}`);
  };
  const session = {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    clearError() {}, getCachedProducts: () => [], loadProducts: async () => ({products: [], messages: []}), loadOlderHistory: async () => {},
    ensureMediaConversation: async () => { if (!state.conversation) update({conversation: conversation()}); return {conversationId: "conversation", conversationToken: "token"}; },
    refreshMediaContext: async () => {
      if (pendingParts.length && state.conversation) {
        const parts = pendingParts; pendingParts = [];
        update({conversation: historySnapshot({...state.conversation, revision: state.conversation.revision + 1,
          current: {...state.conversation.current, selectedWindow: parts.some((part) => part.kind === "window") ? windows[0] : state.conversation.current.selectedWindow, hasCustomerReply: state.conversation.current.hasCustomerReply || parts.some((part) => part.customerIntent)},
          messages: [...state.conversation.messages, row(`context-${state.conversation.revision}`, "context", parts)]})});
      }
    },
    noteMediaActivity: () => activity.push("activity"),
    prepareVisualizationProduct: async () => assert.fail("Known generating jobs must not reprepare"),
    sendMessage: async (text) => { sent.push(text); await options.onSend?.(); },
    startVoice: async () => {}, stopVoice: async () => {},
    end: async () => update({conversation: null, voice: {status: "idle", muted: false, error: null}}),
  };
  window.eval(`${bundle.outputFiles[0].text};window.MediaIntegration=MediaIntegration;`);
  const container = window.document.querySelector("roman-ai-assistant").attachShadow({mode: "open"});
  const page = {url: window.location.href, pending: false, error: null};
  const dispose = window.MediaIntegration.mount(container, {logoUrl: "/logo.svg", session,
    navigation: {getSnapshot: () => page, subscribe: () => () => {}, navigate: async () => {}}, onReady() {}, onError: (error) => errors.push(error)});
  t.after(async () => { dispose(); await delay(0); window.close(); assert.deepEqual(errors, []); });
  if (options.enabled === false) await until(() => calls.some((call) => call.path.endsWith("/product-visualizations")), "Read-only Gallery did not load product metadata");
  else await until(() => container.querySelector("[data-roman-upload]"), "Independent Gallery bootstrap did not enable the camera");
  const camera = () => container.querySelector("[data-roman-upload]");
  const dialog = () => container.querySelector(".roman-visualization-dialog");
  const setText = async (input, text) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, text); input.dispatchEvent(new window.Event("input", {bubbles: true})); await delay(0); };
  const loaded = async () => { await until(() => dialog()?.querySelector(".roman-photo-preview img"), "Review preview did not load"); dialog().querySelector(".roman-photo-preview img").dispatchEvent(new window.Event("load")); await delay(0); };
  return {window, container, session, update, calls, sent, xhrs, activity, camera, dialog, setText, loaded,
    completeUpload(loseAck = false) { windows = [photo()]; pendingParts.push({type: "media", version: 1, kind: "window", windowId, title: windows[0].title, customerIntent: true}); if (loseAck) xhrs[0].fail(); else xhrs[0].complete(windows[0]); },
    async selectTab(name) { const tab = [...container.querySelectorAll(".roman-view-nav a")].find((item) => item.textContent === name); tab.click(); await until(() => tab.getAttribute("aria-current") === "page", "Gallery did not become active"); },
    setCompletedJob() { visualizations = [{...job(), status: "completed", resultAvailable: true, completedAt: new Date().toISOString()}]; },
  };
}

test("restored product previews include previous Gallery pages and remain readable with generation disabled", async (t) => {
  const completed = {...job(), status: "completed", completedAt: "2026-10-06T12:00:01Z", resultAvailable: true};
  const unrelated = {...completed, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", productPath: "/products/other", productTitle: "Other blind"};
  const ctx = await setup(t, {active: true, saved: true, enabled: false, productJobs: [completed, unrelated]});
  await until(() => ctx.container.querySelector('.roman-gallery-thumbnails [aria-label*="AI preview for Kitchen window"]'), "The selected product did not receive its older private preview");
  assert.equal(ctx.camera(), null);
  assert.equal(ctx.container.querySelectorAll(".roman-gallery-preview-star").length, 1);
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/product-visualizations")).length, 1, "StrictMode and metadata arrival should not repeat the lookup");
  assert.equal(ctx.session.getSnapshot().conversation.current.activeProduct.path, "/products/linen");
  assert.deepEqual(ctx.sent, []);
  ctx.container.querySelector('.roman-gallery-enlarge').click();
  await until(() => ctx.dialog()?.classList.contains("roman-visualization-fullscreen"), "Private preview did not open the A/B viewer");
  assert.match(ctx.dialog().querySelector("h2").textContent, /Kitchen window.*Linen blind/);
  ctx.dialog().querySelector('[aria-label="Close"]').click();
  await delay(0);
  assert.equal(ctx.dialog(), null);
});

test("newly completed and removed previews update the selected gallery without another product lookup", async (t) => {
  const ctx = await setup(t, {active: true, saved: true});
  await until(() => ctx.calls.some((call) => call.path.endsWith("/product-visualizations")), "Initial optional read did not run");
  const active = ctx.session.getSnapshot().conversation.current.activeProduct;
  ctx.setCompletedJob();
  await ctx.selectTab("Gallery");
  await until(() => ctx.container.querySelector(".roman-gallery .roman-visualization-card"), "Gallery refresh did not publish the completed preview");
  await ctx.selectTab("Chat");
  await until(() => ctx.container.querySelector('.roman-gallery-thumbnails [aria-label*="AI preview"]'), "Completed preview did not reach the product pane");
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/product-visualizations")).length, 1);
  assert.deepEqual(ctx.session.getSnapshot().conversation.current.activeProduct, active);
  await ctx.selectTab("Gallery");
  ctx.container.querySelector('.roman-gallery .roman-visualization-card .roman-media-delete').click();
  await until(() => !ctx.container.querySelector(".roman-gallery .roman-visualization-card"), "Deleted preview stayed in Gallery");
  await ctx.selectTab("Chat");
  assert.equal(ctx.container.querySelector('.roman-gallery-thumbnails [aria-label*="AI preview"]'), null);
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/product-visualizations")).length, 1);
});

test("an optional preview read failure retries once when Gallery is opened and leaves chat available", async (t) => {
  let fail = true;
  const completed = {...job(), status: "completed", completedAt: "2026-10-06T12:00:01Z", resultAvailable: true};
  const ctx = await setup(t, {active: true, saved: true, productJobs: [completed], onProductRead: () => { if (fail) { fail = false; throw new Error("Product metadata temporarily unavailable"); } }});
  await until(() => ctx.calls.some((call) => call.path.endsWith("/product-visualizations")), "Optional preview read did not run");
  await delay(10);
  assert.equal(ctx.container.querySelector("textarea").disabled, false);
  await ctx.selectTab("Gallery");
  await until(() => ctx.calls.filter((call) => call.path.endsWith("/product-visualizations")).length === 2 && ctx.container.querySelector(".roman-gallery .roman-visualization-card"), "Opening Gallery did not retry the failed preview read");
  await delay(25);
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/product-visualizations")).length, 2);
  assert.equal(ctx.container.querySelector('.roman-gallery [role="alert"]'), null);
});

test("camera and visualizer welcome open the same non-conversational modal while voice and pending chat retain their state", async (t) => {
  const ctx = await setup(t, {voice: true, pending: true});
  const form = ctx.container.querySelector(".roman-composer form"), voice = ctx.container.querySelector(".roman-voice-bar");
  ctx.camera().click(); await until(ctx.dialog, "Camera did not open upload");
  assert.equal(ctx.container.querySelector(".roman-chat").getAttribute("data-welcome-theme"), "true");
  assert.deepEqual(ctx.sent, []);
  assert.equal(ctx.container.querySelector(".roman-voice-bar"), voice);
  ctx.dialog().querySelector('[aria-label="Close"]').click(); await delay(0);
  [...ctx.container.querySelectorAll(".roman-welcome-tile")].find((tile) => tile.textContent.includes("Visualize in room")).click();
  await until(ctx.dialog, "Welcome did not open the shared upload modal");
  assert.equal(ctx.container.querySelector(".roman-composer form"), form);
  assert.deepEqual(ctx.sent, []);
  assert.equal(ctx.calls.filter((call) => call.path === "/apps/roman/gallery").length, 1, "StrictMode must not duplicate bootstrap");
});

test("new photo saves before product selection, publishes immediate normalized progress and survives End Chat", async (t) => {
  const ctx = await setup(t);
  const textarea = ctx.container.querySelector("textarea");
  ctx.camera().click(); await until(ctx.dialog, "Upload dialog missing");
  const picker = ctx.dialog().querySelector('[type="file"]');
  Object.defineProperty(picker, "files", {value: [new ctx.window.File(["photo"], "room.jpg", {type: "image/jpeg"})]});
  picker.dispatchEvent(new ctx.window.Event("change", {bubbles: true}));
  await ctx.loaded();
  await ctx.setText(ctx.dialog().querySelector('[type="text"]'), "Kitchen window");
  const consent = ctx.dialog().querySelectorAll('[type="checkbox"]')[1]; consent.click(); await delay(0);
  ctx.dialog().querySelector("form").dispatchEvent(new ctx.window.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => ctx.xhrs.length === 1, "Upload did not start");
  assert.equal(ctx.dialog(), null);
  assert.equal(ctx.container.querySelector("textarea"), textarea);
  assert.equal(ctx.container.querySelector(".roman-chat").getAttribute("data-welcome-theme"), null);
  const card = ctx.container.querySelector(".roman-local-media .roman-visualization-card-image");
  assert.equal(card.style.aspectRatio, "864 / 1152");
  ctx.xhrs[0].upload.onprogress({lengthComputable: true, loaded: 4, total: 10}); await delay(0);
  assert.equal(ctx.container.querySelector('[role="progressbar"]').getAttribute("aria-valuenow"), "40");
  ctx.completeUpload();
  await until(() => ctx.sent.length === 1 && !ctx.container.querySelector(".roman-local-media"), "Saved photo did not continue discovery once");
  assert.match(ctx.sent[0], /choose a blind.*Kitchen window.*visualize/);
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/select")).length, 0, "Upload already selects its window without another request or photo card");
  assert.equal(ctx.session.getSnapshot().conversation.messages.flatMap((message) => message.parts).filter((part) => part.type === "media" && part.kind === "window").length, 1);
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/start")).length, 0);
  assert.ok(ctx.window.localStorage.getItem("roman-gallery-v1"));
  ctx.container.querySelector(".roman-end-chat").click(); await until(() => ctx.container.querySelector(".roman-welcome"), "End Chat did not clear chat");
  await ctx.selectTab("Gallery");
  assert.match(ctx.container.querySelector(".roman-gallery").textContent, /Kitchen window/);
  assert.equal(ctx.container.querySelector(".roman-local-media"), null);
  assert.equal(ctx.container.querySelector(".roman-chat").getAttribute("data-welcome-theme"), null, "Gallery never inherits the burgundy welcome");
});

test("a slow discovery message retains only the persisted photo after a no-product upload", async (t) => {
  let finishSend;
  let sendFinished = false;
  const pending = new Promise((resolve) => { finishSend = resolve; });
  const ctx = await setup(t, {onSend: async () => { await pending; sendFinished = true; }});
  ctx.camera().click(); await until(ctx.dialog, "Upload dialog missing");
  const picker = ctx.dialog().querySelector('[type="file"]');
  Object.defineProperty(picker, "files", {value: [new ctx.window.File(["photo"], "room.jpg", {type: "image/jpeg"})]});
  picker.dispatchEvent(new ctx.window.Event("change", {bubbles: true})); await ctx.loaded();
  await ctx.setText(ctx.dialog().querySelector('[type="text"]'), "Kitchen window");
  ctx.dialog().querySelectorAll('[type="checkbox"]')[1].click(); await delay(0);
  ctx.dialog().querySelector("form").dispatchEvent(new ctx.window.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => ctx.xhrs.length === 1, "Upload did not start");
  ctx.completeUpload();
  try {
    await until(() => ctx.sent.length === 1 && ctx.container.querySelector(".roman-inline-window"), "Saved window did not hand off to discovery");
    await delay(30);
    assert.equal(sendFinished, false, "Discovery transport should still be blocked");
    assert.equal(ctx.container.querySelectorAll(".roman-inline-window").length, 1);
    assert.equal(ctx.container.querySelector(".roman-local-media"), null, "Queued slow discovery must not retain the optimistic upload card");
    assert.equal(ctx.calls.filter((call) => call.path.endsWith("/select")).length, 0);
  } finally { finishSend(); await delay(0); }
});

test("saved photo rename is committed once and lost generation acknowledgements recover the original job without another paid start", async (t) => {
  const ctx = await setup(t, {active: true, saved: true, loseStart: true});
  ctx.camera().click(); await until(ctx.dialog, "Upload dialog missing");
  await until(() => ctx.dialog().querySelector(".roman-window-choice"), "Saved photo missing");
  ctx.dialog().querySelector(".roman-window-choice").click(); await ctx.loaded();
  await ctx.setText(ctx.dialog().querySelector('[type="text"]'), "Breakfast window");
  assert.equal(ctx.dialog().querySelectorAll('[type="checkbox"]').length, 1, "Saved consent must not be requested again");
  ctx.dialog().querySelector("form").dispatchEvent(new ctx.window.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => [...ctx.container.querySelectorAll(".roman-local-media button")].some((button) => button.textContent === "Check status"), "Lost acknowledgement did not retain a recoverable draft");
  const start = ctx.calls.find((call) => call.path.endsWith("/start"));
  assert.equal(start.body.windowId, windowId);
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/rename")).length, 1);
  assert.equal(ctx.xhrs.length, 0);
  [...ctx.container.querySelectorAll(".roman-local-media button")].find((button) => button.textContent === "Check status").click();
  await until(() => !ctx.container.querySelector(".roman-local-media"), "Accepted original job did not recover");
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/start")).length, 1, "Status recovery never starts another generation");
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/rename")).length, 1);
  assert.deepEqual(ctx.sent, []);
  assert.ok(ctx.calls.some((call) => call.path.endsWith("/request-status") && call.query.get("requestId") === start.body.requestId));
  await until(() => ctx.container.querySelector(".roman-inline-media .roman-visualization-card"), "Recovered job did not hydrate its persisted inline widget");
});

test("lost upload acknowledgements keep the original file and request identity until status recovery without reuploading", async (t) => {
  const ctx = await setup(t, {loseUpload: true});
  ctx.camera().click(); await until(ctx.dialog, "Upload dialog missing");
  const picker = ctx.dialog().querySelector('[type="file"]');
  Object.defineProperty(picker, "files", {value: [new ctx.window.File(["photo"], "room.jpg", {type: "image/jpeg"})]});
  picker.dispatchEvent(new ctx.window.Event("change", {bubbles: true})); await ctx.loaded();
  await ctx.setText(ctx.dialog().querySelector('[type="text"]'), "Kitchen window");
  ctx.dialog().querySelectorAll('[type="checkbox"]')[1].click(); await delay(0);
  ctx.dialog().querySelector("form").dispatchEvent(new ctx.window.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => ctx.xhrs.length, "Upload did not start");
  const requestId = ctx.xhrs[0].body.get("requestId");
  ctx.completeUpload(true);
  await until(() => [...ctx.container.querySelectorAll(".roman-local-media button")].some((button) => button.textContent === "Check status"), "Interrupted upload lost its recoverable card");
  ctx.camera().click(); await until(ctx.dialog, "Recoverable upload draft was lost"); await ctx.loaded();
  ctx.dialog().querySelector("form").dispatchEvent(new ctx.window.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => !ctx.container.querySelector(".roman-local-media") && ctx.sent.length === 1, "Saved upload did not recover and continue discovery");
  assert.equal(ctx.xhrs.length, 1, "A successful but unacknowledged upload must not be resubmitted");
  assert.ok(ctx.calls.filter((call) => call.path.endsWith("/upload-status")).every((call) => call.query.get("requestId") === requestId));
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.session.getSnapshot().conversation.messages.flatMap((message) => message.parts).filter((part) => part.type === "media" && part.kind === "window").length, 1, "Status recovery must retain one uploaded-photo card");
});

test("End Chat during an accepted photo upload preserves the photo without silently creating another chat or discovery turn", async (t) => {
  const ctx = await setup(t);
  ctx.camera().click(); await until(ctx.dialog, "Upload dialog missing");
  const picker = ctx.dialog().querySelector('[type="file"]');
  Object.defineProperty(picker, "files", {value: [new ctx.window.File(["photo"], "room.jpg", {type: "image/jpeg"})]});
  picker.dispatchEvent(new ctx.window.Event("change", {bubbles: true})); await ctx.loaded();
  await ctx.setText(ctx.dialog().querySelector('[type="text"]'), "Kitchen window");
  ctx.dialog().querySelectorAll('[type="checkbox"]')[1].click(); await delay(0);
  ctx.dialog().querySelector("form").dispatchEvent(new ctx.window.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => ctx.xhrs.length, "Upload did not start");
  ctx.container.querySelector(".roman-end-chat").click();
  await until(() => ctx.container.querySelector(".roman-welcome"), "End Chat did not return to welcome");
  ctx.completeUpload(); await delay(30);
  assert.equal(ctx.session.getSnapshot().conversation, null);
  assert.deepEqual(ctx.sent, []);
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/select") || call.path.endsWith("/start")).length, 0);
  assert.equal(ctx.container.querySelector(".roman-local-media"), null);
  await ctx.selectTab("Gallery");
  assert.match(ctx.container.querySelector(".roman-gallery").textContent, /Kitchen window/);
});

test("late selection acknowledgement after End Chat cannot clear a new review of the same saved window", async (t) => {
  let finishSelection;
  const selected = new Promise((resolve) => { finishSelection = resolve; });
  const ctx = await setup(t, {saved: true, onSelect: () => selected});
  ctx.camera().click(); await until(ctx.dialog, "Upload dialog missing");
  await until(() => ctx.dialog().querySelector(".roman-window-choice"), "Saved window missing");
  ctx.dialog().querySelector(".roman-window-choice").click(); await ctx.loaded();
  ctx.dialog().querySelector("form").dispatchEvent(new ctx.window.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => ctx.calls.some((call) => call.path.endsWith("/select")), "Selection did not start");
  ctx.container.querySelector(".roman-end-chat").click();
  await until(() => ctx.container.querySelector(".roman-welcome"), "End Chat did not clear chat");
  ctx.camera().click(); await until(ctx.dialog, "New upload dialog missing");
  await until(() => ctx.dialog().querySelector(".roman-window-choice"), "Saved window missing after End Chat");
  ctx.dialog().querySelector(".roman-window-choice").click(); await ctx.loaded();
  await ctx.setText(ctx.dialog().querySelector('[type="text"]'), "Next room");
  finishSelection(); await delay(40);
  assert.ok(ctx.dialog().querySelector(".roman-photo-preview img"), "Old selection completion must not clear the new window review");
  assert.equal(ctx.dialog().querySelector('[type="text"]').value, "Next room");
  assert.deepEqual(ctx.sent, [], "Old selection must not start discovery after End Chat");
  assert.equal(ctx.session.getSnapshot().conversation, null);
});

test("inline visualization and full screen comparison appear before text reveal and quick answers, with no implicit customer turn", async (t) => {
  const ctx = await setup(t, {active: true, saved: true});
  ctx.setCompletedJob();
  const question = {type: "question", version: 1, invocationId: questionId, question: "What would you like next?", answers: ["Keep shopping", "View cart"]};
  const reply = row("reply", "assistant", [{type: "text", text: "Here is your room preview. ".repeat(80)}, {type: "media", version: 1, kind: "visualization", jobId, customerIntent: false}, question]);
  const next = conversation({active: true});
  next.current = {...next.current, hasCustomerReply: true, pendingQuestion: question};
  next.messages = [row("customer", "user", [{type: "text", text: "Show me the preview."}])];
  ctx.update({conversation: historySnapshot({...next, current: {...next.current, pendingQuestion: null}})});
  await until(() => ctx.container.querySelector(".roman-message-user"), "Customer row did not mount the timeline");
  next.messages = [...next.messages, reply];
  ctx.update({conversation: historySnapshot(next)});
  await until(() => ctx.container.querySelector(".roman-inline-media .roman-visualization-card"), "Inline result waited for typewriter text");
  assert.ok(ctx.container.querySelector('.roman-question').closest('[data-question-reveal-pending="true"][aria-hidden="true"]'), "Quick answers must wait for reply reveal");
  ctx.container.querySelector(".roman-inline-media .roman-window-choice").click();
  await until(() => ctx.container.querySelector('.roman-visualization-fullscreen [role="slider"]'), "Full screen comparison did not resolve its private assets");
  assert.equal(ctx.container.querySelector('.roman-visualization-fullscreen input[type="file"]'), null);
  assert.deepEqual(ctx.sent, []);
  assert.ok(ctx.calls.filter((call) => call.path.includes("/media/")).every((call) => !call.query.size), "Private URLs must not expose capability tokens");
});
