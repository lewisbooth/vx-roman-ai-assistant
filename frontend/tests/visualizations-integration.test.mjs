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
      const dispose=()=>{root.unmount();router.dispose();}; dispose.navigate=(...args)=>router.navigate(...args); return dispose;}
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
async function endChat(ctx) {
  ctx.container.querySelector(".roman-end-chat").click();
  await until(() => ctx.container.querySelector("[data-roman-confirm-end]"), "End Chat confirmation did not open");
  ctx.container.querySelector("[data-roman-confirm-end]").click();
  await until(() => !ctx.container.querySelector("[data-roman-confirm-end]") && !ctx.container.querySelector(".roman-end-chat")?.disabled, "End Chat did not finish");
}

async function reviewSavedWindow(ctx) {
  await ctx.selectTab("Gallery");
  const choice = () => ctx.container.querySelector('.roman-gallery [aria-label="Use Kitchen window"]');
  await until(choice, "Saved window missing from Gallery");
  choice().click();
  await until(ctx.dialog, "Saved-window review did not open");
  await ctx.loaded();
}

async function setup(t, options = {}) {
  const nativeProduct = options.nativeProduct ?? (options.active ? {path: "/products/linen", title: "Linen blind"} : null);
  const nativeMarkup = nativeProduct ? `<app-provider><main id="main"><main-product update-url="true" product-url="${nativeProduct.path}"><h1>${nativeProduct.title}</h1><dynamic-pricing><form data-dynamic-pricing-form></form></dynamic-pricing></main-product></main></app-provider>` : "";
  const dom = new JSDOM(`<!doctype html>${nativeMarkup}<roman-ai-assistant></roman-ai-assistant>`, {url: "https://shop.example" + (nativeProduct?.path ?? "/products/background"), runScripts: "outside-only", pretendToBeVisual: true});
  const {window} = dom;
  Object.assign(window, {Request, Response, Headers});
  if (nativeProduct) window.document.body.classList.add("template-product");
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
  const errors = [], calls = [], sent = [], voiceAnswers = [], activity = [], listeners = new Set();
  window.console.error = (...args) => errors.push(args);
  let state = {conversation: options.conversation ?? (options.active ? conversation({active: true}) : null), pending: !!options.pending, restoring: false, error: null, voice: {status: options.voice ? "active" : "idle", muted: false, error: null}};
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
      await options.onRefresh?.();
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
    sendVoiceAnswer: async (questionId, answer) => { voiceAnswers.push({questionId, answer}); },
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
  return {window, container, session, update, calls, sent, voiceAnswers, xhrs, activity, camera, dialog, setText, loaded,
    launchProduct(path) { return dispose.navigate("/", {state: {visualizeProduct: path, requestId: window.crypto.randomUUID()}}); },
    completeUpload(loseAck = false, analysis) { windows = [{...photo(), title: xhrs[0].body.get("title"), ...(analysis ? {analysis} : {})}]; pendingParts.push({type: "media", version: 1, kind: "window", windowId, title: windows[0].title, customerIntent: true}); if (loseAck) xhrs[0].fail(); else xhrs[0].complete(windows[0]); },
    finishAnalysis() { windows = windows.map((item) => ({...item, analysis: {...item.analysis, status: "completed", completedAt: new Date().toISOString()}})); },
    async selectTab(name) { const tab = () => [...container.querySelectorAll(".roman-view-nav a")].find((item) => item.textContent === name); tab().click(); await until(() => tab()?.getAttribute("aria-current") === "page", "Gallery did not become active"); },
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

test("camera opens a neutral upload without changing voice, pending chat or the mounted composer", async (t) => {
  const ctx = await setup(t, {voice: true, pending: true, saved: true});
  const form = ctx.container.querySelector(".roman-composer form"), voice = ctx.container.querySelector(".roman-voice-bar");
  ctx.camera().click(); await until(ctx.dialog, "Camera did not open upload");
  assert.equal(ctx.dialog().querySelector(".roman-window-choice"), null, "Upload does not duplicate saved-photo selection");
  assert.equal(ctx.dialog().querySelector('[aria-label="Your Uploads"]'), null);
  assert.equal(ctx.container.querySelector(".roman-chat").getAttribute("data-welcome-theme"), "true");
  assert.deepEqual(ctx.sent, []);
  assert.equal(ctx.container.querySelector(".roman-voice-bar"), voice);
  ctx.dialog().querySelector('[aria-label="Close"]').click(); await delay(0);
  assert.equal(ctx.container.querySelector(".roman-composer form"), form);
  assert.deepEqual(ctx.sent, []);
  assert.equal(ctx.calls.filter((call) => call.path === "/apps/roman/gallery").length, 1, "StrictMode must not duplicate bootstrap");
  await ctx.selectTab("Gallery");
  assert.equal(ctx.container.querySelector("#roman-gallery-uploads").textContent, "Your Uploads");
  assert.ok(ctx.container.querySelector('.roman-gallery [aria-label="Use Kitchen window"]'));
  assert.equal(ctx.container.querySelector(".roman-voice-bar"), voice);
  assert.deepEqual(ctx.sent, []);
});

test("the home visualization tile supplies its real intent with or without an open product while the camera stays neutral", async (t) => {
  for (const nativeProduct of [null, {path: "/products/background", title: "Background blind"}]) await t.test(nativeProduct ? "with PDP" : "without PDP", async (t) => {
    const ctx = await setup(t, {nativeProduct});
    [...ctx.container.querySelectorAll(".roman-welcome-tile")].find((tile) => tile.textContent.includes("Visualize in room")).click();
    await until(() => ctx.sent.length === 1, "Tile did not enter the canonical advisor");
    assert.equal(ctx.sent[0], "I'd like to visualize blinds in my room.");
    assert.equal(ctx.dialog(), null);
    assert.equal(ctx.calls.filter((call) => call.path.endsWith("/start")).length, 0);
    ctx.camera().click(); await until(ctx.dialog, "Camera did not remain direct");
    assert.equal(ctx.sent.length, 1);
    assert.doesNotMatch(ctx.dialog().textContent, /Visualizing/);
  });
});

test("explicit PDP entry opens upload directly and waits for matching activation without adopting a later product", async (t) => {
  const ctx = await setup(t, {saved: true, nativeProduct: {path: "/products/background", title: "Background blind"}});
  await ctx.launchProduct("/products/background"); await until(ctx.dialog, "Explicit PDP launch did not open upload");
  await until(() => ctx.sent.length === 1, "Existing advisor activation was not requested");
  assert.match(ctx.sent[0], /Background blind.*photo setup only.*Do not create a preview yet/);
  assert.doesNotMatch(ctx.sent[0], /\/products\//);
  assert.equal(ctx.dialog().querySelector(".roman-window-choice"), null);
  const picker = ctx.dialog().querySelector('[type="file"]');
  Object.defineProperty(picker, "files", {value: [new ctx.window.File(["photo"], "room.jpg", {type: "image/jpeg"})]});
  picker.dispatchEvent(new ctx.window.Event("change", {bubbles: true})); await ctx.loaded();
  assert.equal(ctx.dialog().querySelector('[type="text"]'), null);
  ctx.dialog().querySelector('[type="checkbox"]').click(); await delay(0);
  const submit = () => ctx.dialog().querySelector('[type="submit"]');
  assert.equal(submit().disabled, true);
  const active = conversation({active: true}); active.current.activeProduct = {path: "/products/background", title: "Background blind"};
  ctx.update({conversation: active}); await until(() => !submit().disabled, "Matching activation did not enable preview");
  ctx.update({conversation: conversation({active: true})}); await until(() => submit().disabled, "Product switch did not protect frozen preview");
  assert.match(ctx.dialog().textContent, /Visualizing Background blind/);
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/start")).length, 0);
  ctx.dialog().querySelector('[aria-label="Close"]').click(); await delay(0);
  await ctx.launchProduct("/products/unverified"); await delay(0);
  assert.equal(ctx.dialog(), null);
  assert.equal(ctx.sent.length, 1);
});

test("normalized restored photo pickers retain their historical words without duplicate quick answers", async (t) => {
  for (const saved of [false, true]) await t.test(saved ? "saved window picker" : "upload picker", async (t) => {
    const prompt = saved ? "Which saved window?" : "Would you like to upload a room photo?";
    const presentation = saved ? {kind: "windows", windowIds: [windowId], purpose: "selection"} : {kind: "upload", suggestedTitle: null};
    const history = conversation({active: true, parts: [{type: "text", text: prompt}, {type: "media", version: 1, ...presentation}]});
    const ctx = await setup(t, {active: true, saved, conversation: history});
    await until(() => ctx.container.querySelectorAll(".roman-window-carousel li").length === (saved ? 2 : 1), "Restored picker did not load");
    assert.equal(ctx.container.querySelector(".roman-question"), null);
    assert.equal(ctx.session.getSnapshot().conversation.current.pendingQuestion, null);
    assert.equal([...ctx.container.querySelectorAll(".roman-message-text")].filter((paragraph) => paragraph.textContent === prompt).length, 1);
    assert.equal([...ctx.container.querySelectorAll(".roman-window-carousel button")].filter((button) => button.textContent === "Upload a room photo or mood board").length, 1);
    assert.deepEqual(ctx.sent, []);
    assert.equal(ctx.calls.filter((call) => call.path.endsWith("/start")).length, 0);
  });
});

test("reference photos keep one measurement clarification actionable through the normal text and voice answer handlers", async (t) => {
  const prompt = "Your photo looks taller than it is wide, but the supplied width is larger than the height. Are your measurements correct?";
  const answers = ["My measurements are correct", "Swap width and height"];
  for (const voice of [false, true]) for (const answer of answers) await t.test(`${voice ? "voice" : "text"}: ${answer}`, async (t) => {
    const voiceReply = voice ? {voiceReply: {voiceId: ownerId, afterSequence: 0}} : {};
    const question = {type: "question", version: 1, invocationId: questionId, question: prompt, answers, ...voiceReply};
    const history = conversation({active: true, parts: [{type: "media", version: 1, kind: "windows", windowIds: [windowId], purpose: "reference", ...voiceReply}, question]});
    history.current.pendingQuestion = question;
    const ctx = await setup(t, {active: true, saved: true, voice, conversation: history});
    await until(() => ctx.container.querySelector('.roman-window-carousel img')?.getAttribute("src")?.startsWith("blob:") && ctx.container.querySelectorAll(".roman-question button").length === answers.length && [...ctx.container.querySelectorAll(".roman-question button")].every((button) => !button.disabled), "Reference photo and clarification did not become ready");
    const carousel = ctx.container.querySelector(".roman-window-carousel");
    const voiceBar = ctx.container.querySelector(".roman-voice-bar");
    const image = carousel.querySelector("img");
    assert.equal(carousel.querySelectorAll("li").length, 1, "Reference presentation shows only the requested saved photo");
    assert.equal(image.alt, "Kitchen window");
    assert.equal(carousel.querySelector("button"), null, "A reference photo offers neither upload nor selection");
    assert.equal(carousel.textContent.includes("Upload a room photo"), false);
    assert.equal(carousel.textContent.includes("Use this image"), false);
    assert.equal(ctx.container.querySelectorAll(".roman-question").length, 1);
    assert.equal([...ctx.container.querySelectorAll(".roman-message-text")].filter((paragraph) => paragraph.textContent === prompt).length, 1, "The normal QuestionPart owns the sole clarification text");
    assert.deepEqual([...ctx.container.querySelectorAll(".roman-question button")].map((button) => button.textContent), answers);
    assert.ok(ctx.calls.some((call) => call.path.endsWith(`/media/window/${windowId}`)), "The card must resolve the saved source image");
    assert.deepEqual(ctx.sent, []);
    assert.deepEqual(ctx.voiceAnswers, []);
    image.click();
    await delay(0);
    assert.equal(ctx.dialog(), null, "The source reference is read-only");
    [...ctx.container.querySelectorAll(".roman-question button")].find((button) => button.textContent === answer).click();
    await until(() => ctx.sent.length + ctx.voiceAnswers.length === 1, "Clarification answer did not use the existing question handler");
    assert.deepEqual(ctx.sent, voice ? [] : [answer]);
    assert.deepEqual(ctx.voiceAnswers, voice ? [{questionId, answer}] : []);
    assert.equal(ctx.session.getSnapshot().conversation.current.selectedWindow, null);
    assert.equal(ctx.calls.filter((call) => call.path.endsWith("/select") || call.path.endsWith("/start")).length, 0, "Showing and answering a reference does not select a photo or start a paid preview");
    assert.equal(ctx.xhrs.length, 0);
    assert.equal(ctx.container.querySelector(".roman-local-media"), null);
    if (voice) {
      assert.equal(ctx.session.getSnapshot().voice.status, "active");
      assert.equal(ctx.container.querySelector(".roman-voice-bar"), voiceBar);
    }
  });
});

test("saved-photo cards submit neutral selection rather than implicitly requesting a new paid job", async (t) => {
  const ctx = await setup(t, {active: true, saved: true, conversation: conversation({active: true, parts: [{type: "media", version: 1, kind: "windows", windowIds: [windowId], purpose: "preview"}]})});
  await until(() => ctx.container.querySelector('.roman-window-carousel [aria-label="Use Kitchen window"]'), "Saved window card did not load");
  const choices = [...ctx.container.querySelectorAll(".roman-window-carousel .roman-window-choice")];
  assert.equal(choices.length, 2);
  assert.equal(choices[0].textContent, "Upload a room photo or mood board");
  ctx.container.querySelector('.roman-window-carousel [aria-label="Use Kitchen window"]').click();
  await until(() => ctx.sent.length === 1, "Selection did not enter chat");
  assert.equal(ctx.sent[0], 'Use my uploaded image “Kitchen window”.');
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/start")).length, 0);
});

test("photo upload presentations use the same picker with or without saved windows and open only the upload review", async (t) => {
  for (const saved of [false, true]) await t.test(saved ? "with saved windows" : "without saved windows", async (t) => {
    const ctx = await setup(t, {saved, conversation: conversation({parts: [{type: "media", version: 1, kind: "upload", suggestedTitle: "Office window"}]})});
    await until(() => ctx.container.querySelector(".roman-window-carousel"), "Photo picker did not load");
    await until(() => ctx.container.querySelectorAll(".roman-window-carousel li").length === (saved ? 2 : 1), "Saved windows did not join the picker");
    const choices = [...ctx.container.querySelectorAll(".roman-window-carousel .roman-window-choice")];
    assert.equal(choices[0].textContent, "Upload a room photo or mood board");
    assert.equal(ctx.container.querySelectorAll(".roman-inline-media > .roman-media-button").length, 0);
    assert.equal(ctx.container.querySelector(".roman-question"), null);
    choices[0].click(); await until(ctx.dialog, "Upload review did not open");
    assert.equal(ctx.dialog().querySelector(".roman-window-choice"), null, "Saved photos remain in the chat carousel");
    const picker = ctx.dialog().querySelector('[type="file"]');
    Object.defineProperty(picker, "files", {value: [new ctx.window.File(["photo"], "room.jpg", {type: "image/jpeg"})]});
    picker.dispatchEvent(new ctx.window.Event("change", {bubbles: true})); await ctx.loaded();
    assert.equal(ctx.dialog().querySelector('[type="text"]'), null, "Chat uploads leave naming to Roman rather than asking again");
    assert.deepEqual(ctx.sent, []);
    assert.equal(ctx.calls.filter((call) => call.path.endsWith("/select") || call.path.endsWith("/start")).length, 0);
  });
});

test("a deleted historical photo picker remains a tombstone rather than pretending its photo is available", async (t) => {
  const ctx = await setup(t, {conversation: conversation({parts: [{type: "media", version: 1, kind: "windows", windowIds: [windowId], purpose: "selection"}]})});
  await until(() => ctx.container.textContent.includes("Uploaded images removed."), "Deleted photo state did not settle");
  assert.equal(ctx.container.querySelector(".roman-window-carousel"), null);
  assert.equal(ctx.container.querySelector(".roman-question"), null);
  assert.deepEqual(ctx.sent, []);
});

test("read-only Gallery keeps saved photo choices visible while disabling the new upload card", async (t) => {
  const ctx = await setup(t, {active: true, saved: true, enabled: false, conversation: conversation({active: true, parts: [{type: "media", version: 1, kind: "upload", suggestedTitle: null}]})});
  await until(() => ctx.container.querySelectorAll(".roman-window-carousel .roman-window-choice").length === 2, "Saved photo picker did not load");
  const choices = [...ctx.container.querySelectorAll(".roman-window-carousel .roman-window-choice")];
  assert.equal(choices[0].disabled, true);
  assert.equal(choices[1].disabled, false);
  choices[0].click();
  assert.equal(ctx.dialog(), null);
  assert.deepEqual(ctx.sent, []);
});

test("late saved-photo card selection after End Chat cannot send an intent into a new conversation", async (t) => {
  let finish; const selected = new Promise((resolve) => {finish = resolve;});
  const history = conversation({active: true, parts: [{type: "media", version: 1, kind: "windows", windowIds: [windowId], purpose: "selection"}]});
  const ctx = await setup(t, {active: true, saved: true, conversation: history, onSelect: () => selected});
  const choice = () => ctx.container.querySelector('.roman-window-carousel [aria-label="Use Kitchen window"]');
  await until(choice, "Saved photo card not ready"); choice().click();
  await until(() => ctx.calls.some((call) => call.path.endsWith("/select")), "Selection did not start");
  await ctx.session.end(); finish(); await delay(20);
  assert.deepEqual(ctx.sent, []);
  assert.equal(ctx.session.getSnapshot().conversation, null);
});

test("sample Cart navigation preserves a pending numeric question, its draft and source without a customer turn", async (t) => {
  const question = {type: "question", version: 1, invocationId: questionId, question: "What is the recess width?", answers: [], measurement: {productPath: "/products/linen", label: "Width", unit: "cm", instructions: "Use the smallest of three recess readings."}, navigationActions: [{label: "View Cart", view: "cart"}]};
  const history = conversation({active: true, parts: [question]}); history.current.pendingQuestion = question;
  const ctx = await setup(t, {active: true, conversation: history});
  const shortcut = () => [...ctx.container.querySelectorAll(".roman-question button")].find((button) => button.textContent === "View Cart");
  await until(() => shortcut() && !shortcut().disabled, "Cart shortcut did not become usable");
  const input = ctx.container.querySelector(".roman-measurement-field input"); await ctx.setText(input, "150");
  shortcut().click(); await until(() => ctx.container.querySelector('.roman-view-nav a[href="/cart"]').getAttribute("aria-current") === "page", "Cart did not open");
  await ctx.selectTab("Chat");
  assert.equal(ctx.container.querySelector(".roman-measurement-field input"), input);
  assert.equal(input.value, "150");
  assert.deepEqual(ctx.session.getSnapshot().conversation.current.pendingQuestion, question);
  assert.deepEqual(ctx.sent, []);
});

test("new photo saves before product selection, publishes immediate normalized progress and survives End Chat", async (t) => {
  const ctx = await setup(t);
  const textarea = ctx.container.querySelector("textarea");
  ctx.camera().click(); await until(ctx.dialog, "Upload dialog missing");
  const picker = ctx.dialog().querySelector('[type="file"]');
  Object.defineProperty(picker, "files", {value: [new ctx.window.File(["photo"], "room.jpg", {type: "image/jpeg"})]});
  picker.dispatchEvent(new ctx.window.Event("change", {bubbles: true}));
  await ctx.loaded();
  assert.equal(ctx.dialog().querySelector('[type="text"]'), null);
  const consent = ctx.dialog().querySelector('[type="checkbox"]'); consent.click(); await delay(0);
  ctx.dialog().querySelector("form").dispatchEvent(new ctx.window.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => ctx.xhrs.length === 1, "Upload did not start");
  assert.equal(ctx.xhrs[0].body.get("title"), "Uploaded image", "The transport uses a provisional name until Roman knows the context");
  assert.equal(ctx.xhrs[0].body.get("cleanup"), "true");
  assert.equal(ctx.dialog(), null);
  assert.equal(ctx.container.querySelector("textarea"), textarea);
  assert.equal(ctx.container.querySelector(".roman-chat").getAttribute("data-welcome-theme"), null);
  const uploadCard = ctx.container.querySelector(".roman-local-media .roman-visualization-card");
  assert.equal(uploadCard.querySelector('[role="status"]').textContent, "Uploading your image");
  assert.equal(uploadCard.querySelector(".roman-media-disclaimer"), null, "A neutral upload does not claim an AI product preview");
  assert.doesNotMatch(uploadCard.textContent, /visualization|AI preview/i);
  const card = ctx.container.querySelector(".roman-local-media .roman-visualization-card-image");
  assert.equal(card.style.aspectRatio, "864 / 1152");
  ctx.xhrs[0].upload.onprogress({lengthComputable: true, loaded: 4, total: 10}); await delay(0);
  assert.equal(ctx.container.querySelector('[role="progressbar"]').getAttribute("aria-valuenow"), "40");
  ctx.completeUpload();
  await until(() => ctx.sent.length === 1 && !ctx.container.querySelector(".roman-local-media"), "Saved photo did not continue the existing conversation once");
  assert.equal(ctx.sent[0], 'I\'ve uploaded “Uploaded image”.');
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/select")).length, 0, "Upload already selects its window without another request or photo card");
  assert.equal(ctx.session.getSnapshot().conversation.messages.flatMap((message) => message.parts).filter((part) => part.type === "media" && part.kind === "window").length, 1);
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/start")).length, 0);
  assert.ok(ctx.window.localStorage.getItem("roman-gallery-v1"));
  await endChat(ctx); await until(() => ctx.container.querySelector(".roman-welcome"), "End Chat did not clear chat");
  await ctx.selectTab("Gallery");
  assert.match(ctx.container.querySelector(".roman-gallery").textContent, /Uploaded image/);
  assert.equal(ctx.container.querySelector(".roman-local-media"), null);
  assert.equal(ctx.container.querySelector(".roman-chat").getAttribute("data-welcome-theme"), null, "Gallery never inherits the burgundy welcome");
});

test("a slow upload continuation retains only the persisted photo after a no-product upload", async (t) => {
  let finishSend;
  let sendFinished = false;
  const pending = new Promise((resolve) => { finishSend = resolve; });
  const ctx = await setup(t, {onSend: async () => { await pending; sendFinished = true; }});
  ctx.camera().click(); await until(ctx.dialog, "Upload dialog missing");
  const picker = ctx.dialog().querySelector('[type="file"]');
  Object.defineProperty(picker, "files", {value: [new ctx.window.File(["photo"], "room.jpg", {type: "image/jpeg"})]});
  picker.dispatchEvent(new ctx.window.Event("change", {bubbles: true})); await ctx.loaded();
  ctx.dialog().querySelector('[type="checkbox"]').click(); await delay(0);
  ctx.dialog().querySelector("form").dispatchEvent(new ctx.window.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => ctx.xhrs.length === 1, "Upload did not start");
  ctx.completeUpload();
  try {
    await until(() => ctx.sent.length === 1 && ctx.container.querySelector(".roman-inline-window"), "Saved image did not hand off to the advisor");
    await delay(30);
    assert.equal(sendFinished, false, "Advisor transport should still be blocked");
    assert.equal(ctx.container.querySelectorAll(".roman-inline-window").length, 1);
    assert.equal(ctx.container.querySelector(".roman-local-media"), null, "Queued slow continuation must not retain the optimistic upload card");
    assert.equal(ctx.calls.filter((call) => call.path.endsWith("/select")).length, 0);
  } finally { finishSend(); await delay(0); }
});

async function uploadRoom(ctx) {
  ctx.camera().click(); await until(ctx.dialog, "Upload dialog missing");
  await submitRoomFile(ctx);
}

async function submitRoomFile(ctx) {
  const picker = ctx.dialog().querySelector('[type="file"]');
  Object.defineProperty(picker, "files", {value: [new ctx.window.File(["photo"], "room.jpg", {type: "image/jpeg"})]});
  picker.dispatchEvent(new ctx.window.Event("change", {bubbles: true})); await ctx.loaded();
  assert.equal(ctx.dialog().querySelector('[type="text"]'), null);
  assert.equal(ctx.dialog().querySelectorAll('[type="checkbox"]').length, 1, "Only consent remains editable");
  ctx.dialog().querySelector('[type="checkbox"]').click(); await delay(0);
  ctx.dialog().querySelector("form").dispatchEvent(new ctx.window.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => ctx.xhrs.length === 1, "Upload did not start");
}

test("new photo analysis follows upload progress, ends as soon as ready and never creates a second advisor turn", async (t) => {
  const ctx = await setup(t, {voice: true});
  const composer = ctx.container.querySelector(".roman-composer form");
  await uploadRoom(ctx);
  assert.equal(ctx.container.querySelector('[aria-label="Estimated room analysis progress"]'), null);
  const queuedAt = new Date().toISOString();
  ctx.completeUpload(false, {status: "analyzing", queuedAt, startedAt: queuedAt, completedAt: null});
  await until(() => ctx.sent.length === 1 && ctx.container.querySelector('[aria-label="Estimated room analysis progress"]'), "Uploaded photo did not show analysis");
  assert.equal(ctx.container.querySelector(".roman-reply-activity").textContent, "Roman is analyzing your room...");
  assert.equal(ctx.container.querySelectorAll(".roman-inline-window").length, 1);
  assert.equal(ctx.container.querySelector(".roman-local-media"), null);
  ctx.finishAnalysis();
  await until(() => !ctx.container.querySelector('[aria-label="Estimated room analysis progress"]'), "Ready analysis retained its fake progress");
  assert.ok(Date.now() - Date.parse(queuedAt) < 3000, "Fast analysis should not enforce a three-second delay");
  assert.equal(ctx.container.querySelector(".roman-reply-activity"), null);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.session.getSnapshot().voice.status, "active");
  assert.equal(ctx.container.querySelector(".roman-composer form"), composer);
});

test("analysis starts on the upload acknowledgement without waiting for transcript refresh", async (t) => {
  let finishRefresh;
  const pending = new Promise((resolve) => { finishRefresh = resolve; });
  const ctx = await setup(t, {onRefresh: () => pending});
  await uploadRoom(ctx);
  const queuedAt = new Date().toISOString();
  ctx.completeUpload(false, {status: "analyzing", queuedAt, startedAt: queuedAt, completedAt: null});
  try {
    await until(() => ctx.container.querySelector('.roman-local-media [aria-label="Estimated room analysis progress"]'), "Uploaded card waited for transcript refresh before analysis");
    assert.equal(ctx.container.querySelector(".roman-reply-activity").textContent, "Roman is analyzing your room...");
    assert.equal(ctx.sent.length, 0);
  } finally { finishRefresh(); }
  await until(() => ctx.sent.length === 1 && !ctx.container.querySelector(".roman-local-media"), "Persisted photo did not replace its analyzing upload card");
  assert.equal(ctx.container.querySelectorAll('[aria-label="Estimated room analysis progress"]').length, 1);
});

test("analysis progress expires at ten seconds and a late result never adds a reply", async (t) => {
  const ctx = await setup(t);
  await uploadRoom(ctx);
  const queuedAt = new Date(Date.now() - 9700).toISOString();
  ctx.completeUpload(false, {status: "analyzing", queuedAt, startedAt: queuedAt, completedAt: null});
  await until(() => ctx.container.querySelector('[aria-label="Estimated room analysis progress"]'), "Analysis wait missing");
  await until(() => !ctx.container.querySelector('[aria-label="Estimated room analysis progress"]'), "Analysis wait exceeded the upload deadline");
  assert.equal(ctx.container.querySelector(".roman-reply-activity"), null);
  assert.equal(ctx.sent.length, 1);
  ctx.finishAnalysis();
  await ctx.selectTab("Gallery"); await ctx.selectTab("Chat");
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.container.querySelector('[aria-label="Estimated room analysis progress"]'), null);
});

test("a camera upload stays neutral even when a blind is selected", async (t) => {
  const ctx = await setup(t, {active: true});
  await uploadRoom(ctx);
  ctx.completeUpload();
  await until(() => ctx.sent.length === 1, "Neutral upload did not reach the advisor");
  assert.equal(ctx.sent[0], 'I\'ve uploaded “Uploaded image”.');
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/start")).length, 0);
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/select")).length, 0);
  assert.equal(ctx.container.querySelector(".roman-local-media"), null);
});

test("an explicit PDP upload starts one preview with cleanup enabled and reports the accepted job without requesting it again", async (t) => {
  const ctx = await setup(t, {active: true});
  await ctx.launchProduct("/products/linen"); await until(ctx.dialog, "Explicit PDP launch did not open upload");
  await submitRoomFile(ctx);
  ctx.completeUpload();
  await until(() => ctx.sent.length === 1, "Product-bound upload did not reach the advisor");
  assert.equal(ctx.sent[0], 'My image “Uploaded image” is uploaded and its preview with Linen blind has already started.');
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/start")).length, 1);
  assert.equal(ctx.calls.find((call) => call.path.endsWith("/start")).body.cleanup, true);
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/select")).length, 0);
  assert.equal(ctx.container.querySelector(".roman-local-media"), null);
});

test("a new customer turn during upload suppresses its stale automatic continuation", async (t) => {
  const ctx = await setup(t);
  await uploadRoom(ctx);
  const current = ctx.session.getSnapshot().conversation;
  ctx.update({conversation: historySnapshot({...current, messages: [...current.messages, row("changed-mind", "user", [{type: "text", text: "Leave the photo for now, help me with the cart."}])]})});
  ctx.completeUpload();
  await until(() => ctx.container.querySelector(".roman-inline-window") && !ctx.container.querySelector(".roman-local-media"), "Photo did not settle after the customer's interruption");
  assert.deepEqual(ctx.sent, []);
});

test("a new caption extending the same customer voice bubble suppresses the stale upload continuation", async (t) => {
  const caption = {...row("first-caption", "user", [{type: "voice", version: 1, voiceId: questionId, text: "Here is the room.", startMs: 100, endMs: 200}]), sequence: 3, sourceSequence: 3, sourceEndSequence: 3};
  const current = conversation();
  const ctx = await setup(t, {voice: true, conversation: historySnapshot({...current, messages: [caption]})});
  await uploadRoom(ctx);
  const extended = {...caption, sourceEndSequence: 6, parts: [{...caption.parts[0], text: "Here is the room. Actually, leave this for now.", endMs: 400}]};
  ctx.update({conversation: historySnapshot({...ctx.session.getSnapshot().conversation, messages: [extended]})});
  ctx.completeUpload();
  await until(() => ctx.container.querySelector(".roman-inline-window") && !ctx.container.querySelector(".roman-local-media"), "Photo did not settle after further customer speech");
  assert.deepEqual(ctx.sent, []);
  assert.equal(ctx.session.getSnapshot().voice.status, "active");
});

test("Gallery image review edits its title once and selects without creating a preview", async (t) => {
  const ctx = await setup(t, {active: true, saved: true});
  await reviewSavedWindow(ctx);
  await ctx.setText(ctx.dialog().querySelector('[type="text"]'), "Breakfast window");
  assert.equal(ctx.dialog().querySelectorAll('[type="checkbox"]').length, 0, "Saved consent must not be requested again and cleanup is not a choice");
  ctx.dialog().querySelector("form").dispatchEvent(new ctx.window.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => !ctx.dialog() && ctx.sent.length === 1, "Image review did not finish");
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/rename")).length, 1);
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/select")).length, 1);
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/start")).length, 0);
  assert.equal(ctx.sent[0], 'Use my uploaded image “Breakfast window”.');
  assert.equal(ctx.xhrs.length, 0);
});

test("Gallery uploads retain a customer-entered title without implying a visualization request", async (t) => {
  const ctx = await setup(t, {active: true});
  await ctx.selectTab("Gallery");
  [...ctx.container.querySelectorAll(".roman-gallery button")].find((button) => button.textContent === "Upload a room photo or mood board").click();
  await until(ctx.dialog, "Gallery upload did not open");
  const picker = ctx.dialog().querySelector('[type="file"]');
  Object.defineProperty(picker, "files", {value: [new ctx.window.File(["photo"], "room.jpg", {type: "image/jpeg"})]});
  picker.dispatchEvent(new ctx.window.Event("change", {bubbles: true})); await ctx.loaded();
  await ctx.setText(ctx.dialog().querySelector('[type="text"]'), "Bedroom inspiration");
  ctx.dialog().querySelector('[type="checkbox"]').click(); await delay(0);
  ctx.dialog().querySelector("form").dispatchEvent(new ctx.window.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => ctx.xhrs.length === 1, "Gallery upload did not start");
  assert.equal(ctx.xhrs[0].body.get("title"), "Bedroom inspiration");
  ctx.completeUpload();
  await until(() => ctx.sent.length === 1, "Gallery upload did not reach the advisor");
  assert.equal(ctx.sent[0], 'I\'ve uploaded “Bedroom inspiration”.');
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/start")).length, 0);
});

test("Gallery card rename and explicit retry recover a lost generation acknowledgement without another paid start", async (t) => {
  const failed = {...job(), status: "failed", error: "Generation failed"};
  const ctx = await setup(t, {active: true, saved: true, jobs: [failed], loseStart: true});
  await ctx.selectTab("Gallery");
  await until(() => ctx.container.querySelector(".roman-window-actions button"), "Saved image actions did not load");
  [...ctx.container.querySelectorAll(".roman-window-actions button")].find((button) => button.textContent === "Rename image").click();
  await until(() => ctx.container.querySelector('.roman-window-rename [type="text"]'), "Gallery title editor did not open");
  await ctx.setText(ctx.container.querySelector('.roman-window-rename [type="text"]'), "Breakfast window");
  ctx.container.querySelector(".roman-window-rename").dispatchEvent(new ctx.window.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => ctx.calls.some((call) => call.path.endsWith("/rename")) && !ctx.container.querySelector(".roman-window-rename"), "Gallery rename did not finish");
  [...ctx.container.querySelectorAll(".roman-visualization-card button")].find((button) => button.textContent === "Try again").click();
  await until(ctx.dialog, "Explicit retry did not open upload review"); await ctx.loaded();
  assert.equal(ctx.dialog().querySelectorAll('[type="checkbox"]').length, 0);
  assert.match(ctx.dialog().textContent, /Visualizing Linen blind/);
  ctx.dialog().querySelector("form").dispatchEvent(new ctx.window.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => [...ctx.container.querySelectorAll(".roman-local-media button")].some((button) => button.textContent === "Check status"), "Lost acknowledgement did not retain a recoverable draft");
  const start = ctx.calls.find((call) => call.path.endsWith("/start"));
  assert.equal(start.body.windowId, windowId);
  assert.equal(start.body.productPath, "/products/linen");
  assert.equal(start.body.cleanup, true);
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
  ctx.dialog().querySelector('[type="checkbox"]').click(); await delay(0);
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

test("lost upload acknowledgement recovery preserves a later saved-image name instead of restoring the provisional title", async (t) => {
  const ctx = await setup(t, {loseUpload: true});
  await uploadRoom(ctx);
  const requestId = ctx.xhrs[0].body.get("requestId");
  assert.equal(ctx.xhrs[0].body.get("title"), "Uploaded image");
  ctx.completeUpload(true);
  await until(() => [...ctx.container.querySelectorAll(".roman-local-media button")].some((button) => button.textContent === "Check status"), "Interrupted upload did not retain its recoverable attempt");
  await ctx.selectTab("Gallery");
  await until(() => ctx.container.querySelector('.roman-gallery [aria-label="Use Uploaded image"]'), "Saved upload did not appear in Gallery");
  [...ctx.container.querySelectorAll(".roman-window-actions button")].find((button) => button.textContent === "Rename image").click();
  await until(() => ctx.container.querySelector('.roman-window-rename [type="text"]'), "Gallery title editor did not open");
  await ctx.setText(ctx.container.querySelector('.roman-window-rename [type="text"]'), "Daughter's bedroom");
  ctx.container.querySelector(".roman-window-rename").dispatchEvent(new ctx.window.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => !ctx.container.querySelector(".roman-window-rename") && ctx.calls.some((call) => call.path.endsWith("/rename")), "Saved image rename did not finish");
  await ctx.selectTab("Chat");
  [...ctx.container.querySelectorAll(".roman-local-media button")].find((button) => button.textContent === "Check status").click();
  await until(() => !ctx.container.querySelector(".roman-local-media") && ctx.sent.length === 1, "Renamed upload did not recover");
  assert.equal(ctx.xhrs.length, 1, "A recovered upload is never submitted twice");
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/rename")).length, 1, "Recovery must not undo a later user or Roman name");
  assert.equal(ctx.sent[0], "I've uploaded “Daughter's bedroom”.");
  assert.ok(ctx.calls.filter((call) => call.path.endsWith("/upload-status")).every((call) => call.query.get("requestId") === requestId));
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/start")).length, 0);
  await ctx.selectTab("Gallery");
  assert.ok(ctx.container.querySelector('.roman-gallery [aria-label="Use Daughter\'s bedroom"]'));
  assert.equal(ctx.container.querySelector('.roman-gallery [aria-label="Use Uploaded image"]'), null);
});

test("End Chat during an accepted photo upload preserves the photo without silently creating another chat or discovery turn", async (t) => {
  const ctx = await setup(t);
  ctx.camera().click(); await until(ctx.dialog, "Upload dialog missing");
  const picker = ctx.dialog().querySelector('[type="file"]');
  Object.defineProperty(picker, "files", {value: [new ctx.window.File(["photo"], "room.jpg", {type: "image/jpeg"})]});
  picker.dispatchEvent(new ctx.window.Event("change", {bubbles: true})); await ctx.loaded();
  ctx.dialog().querySelector('[type="checkbox"]').click(); await delay(0);
  ctx.dialog().querySelector("form").dispatchEvent(new ctx.window.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => ctx.xhrs.length, "Upload did not start");
  await endChat(ctx);
  await until(() => ctx.container.querySelector(".roman-welcome"), "End Chat did not return to welcome");
  ctx.completeUpload(); await delay(30);
  assert.equal(ctx.session.getSnapshot().conversation, null);
  assert.deepEqual(ctx.sent, []);
  assert.equal(ctx.calls.filter((call) => call.path.endsWith("/select") || call.path.endsWith("/start")).length, 0);
  assert.equal(ctx.container.querySelector(".roman-local-media"), null);
  await ctx.selectTab("Gallery");
  assert.match(ctx.container.querySelector(".roman-gallery").textContent, /Uploaded image/);
});

test("late selection acknowledgement after End Chat cannot clear a new review of the same saved window", async (t) => {
  let finishSelection;
  const selected = new Promise((resolve) => { finishSelection = resolve; });
  const ctx = await setup(t, {saved: true, onSelect: () => selected});
  await reviewSavedWindow(ctx);
  ctx.dialog().querySelector("form").dispatchEvent(new ctx.window.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => ctx.calls.some((call) => call.path.endsWith("/select")), "Selection did not start");
  await endChat(ctx);
  await until(() => ctx.container.querySelector(".roman-welcome"), "End Chat did not clear chat");
  await reviewSavedWindow(ctx);
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
