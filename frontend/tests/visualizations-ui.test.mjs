import assert from "node:assert/strict";
import { cwd } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {ImageComparison} from './shared/visualizations/ImageComparison';
      import {saveVisualization} from './shared/visualizations/save-visualization';
      import {UploadModal} from './frontend/src/visualizations/UploadModal';
      import {WindowCard,WindowCarousel} from './frontend/src/visualizations/WindowCard';
      import {PrivateImage} from './frontend/src/visualizations/PrivateImage';
      import {VisualizationViewer} from './shared/visualizations/VisualizationViewer';
      import {estimatedGenerationProgress} from './frontend/src/visualizations/VisualizationCard';
      import {photoAnalysisProgress} from './frontend/src/visualizations/photo-analysis-progress';
      export {saveVisualization, estimatedGenerationProgress, photoAnalysisProgress};
      export function mount(target, kind) {
        const root=createRoot(target);
        const Component={comparison:ImageComparison,upload:UploadModal,window:WindowCard,windows:WindowCarousel,image:PrivateImage,viewer:VisualizationViewer}[kind];
        return {render(props){flushSync(()=>root.render(<Component {...props}/>));},dispose(){flushSync(()=>root.unmount());}};
      }
    `,
    resolveDir: cwd(), loader: "tsx",
  },
  bundle: true, write: false, format: "iife", globalName: "RomanMediaTest", platform: "browser", jsx: "automatic",
  loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' },
});

function setup(t, kind) {
  const dom = new JSDOM("<!doctype html><button data-roman-upload>Upload</button><div id='mount'></div>", {
    runScripts: "outside-only", url: "https://shop.example/", pretendToBeVisual: true,
  });
  const {window} = dom;
  const errors = [];
  window.console.error = (...args) => errors.push(args);
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  window.HTMLImageElement.prototype.decode = function () { return this.src.includes("unavailable") ? Promise.reject(new Error("bad")) : Promise.resolve(); };
  Object.defineProperty(window.HTMLImageElement.prototype, "naturalWidth", { get: () => 100 });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100});
  const pointers = new Set();
  window.HTMLElement.prototype.setPointerCapture = (id) => pointers.add(id);
  window.HTMLElement.prototype.hasPointerCapture = (id) => pointers.has(id);
  window.HTMLElement.prototype.releasePointerCapture = (id) => pointers.delete(id);
  const observers = [];
  window.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {} disconnect() {}
  };
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.eval(bundle.outputFiles[0].text);
  const mount = window.document.querySelector("#mount");
  const api = kind ? window.RomanMediaTest.mount(mount, kind) : null;
  t.after(() => { api?.dispose(); assert.deepEqual(errors, []); window.close(); });
  return {window, mount, api, observers, exports: window.RomanMediaTest};
}

function pointer(window, element, type, values) {
  const event = new window.Event(type, {bubbles: true, cancelable: true});
  Object.assign(event, {pointerId: 1, pointerType: "touch", button: 0, isPrimary: true, clientX: 100, clientY: 0}, values);
  element.dispatchEvent(event);
}

test("window picker offers one upload card before named photos and keeps upload and selection separate", (t) => {
  const {mount, api} = setup(t, "windows");
  const windows = [{id: "kitchen", title: "Kitchen window"}, {id: "study", title: "Study window"}];
  const selected = []; let uploads = 0;
  api.render({windows, windowSource: (photo) => `/${photo.id}.jpg`, onUpload: () => uploads++, onSelect: (photo) => selected.push(photo.id)});
  const choices = [...mount.querySelectorAll(".roman-window-carousel button")];
  assert.equal(mount.querySelector('[role="region"]').getAttribute("aria-label"), "window photos");
  assert.deepEqual(choices.map((button) => button.getAttribute("aria-label") ?? button.textContent), ["Upload a room photo", "Use Kitchen window", "Use Study window"]);
  choices[0].click();
  assert.equal(uploads, 1);
  assert.deepEqual(selected, []);
  choices[2].click();
  assert.deepEqual(selected, ["study"]);
  assert.equal(uploads, 1);
});

test("an empty window picker retains the same carousel and a usable upload card", (t) => {
  const {mount, api} = setup(t, "windows");
  let uploads = 0;
  api.render({windows: [], windowSource: () => assert.fail("No saved photo should load"), onUpload: () => uploads++, onSelect: () => assert.fail("No saved photo should be selected")});
  assert.equal(mount.querySelectorAll(".roman-product-carousel").length, 1);
  assert.equal(mount.querySelectorAll(".roman-window-carousel li").length, 1);
  mount.querySelector("button").click();
  assert.equal(uploads, 1);
});

test("reference photo carousels show the named photos without upload, selection or preview actions", (t) => {
  const {mount, api} = setup(t, "windows");
  const forbidden = () => assert.fail("Reference photos must be read-only");
  api.render({windows: [{id: "kitchen", title: "Kitchen window"}, {id: "study", title: "Study window"}], referenceOnly: true, windowSource: (photo) => `/${photo.id}.jpg`, onUpload: forbidden, onSelect: forbidden});
  assert.equal(mount.querySelectorAll(".roman-window-carousel li").length, 2);
  assert.equal(mount.querySelector("button"), null);
  assert.doesNotMatch(mount.textContent, /Upload|Use this window/);
});

test("photo analysis progress estimates three seconds but stops immediately at terminal state or the five-second deadline", (t) => {
  const {exports} = setup(t);
  const queuedAt = new Date(10_000).toISOString();
  const analysis = {status: "queued", queuedAt, startedAt: null, completedAt: null};
  assert.equal(exports.photoAnalysisProgress(analysis, 10_000), 0);
  assert.equal(exports.photoAnalysisProgress(analysis, 11_500), 47.5);
  assert.equal(exports.photoAnalysisProgress({...analysis, status: "analyzing"}, 13_000), 95);
  assert.equal(exports.photoAnalysisProgress(analysis, 14_999), 95);
  assert.equal(exports.photoAnalysisProgress(analysis, 15_000), null);
  assert.equal(exports.photoAnalysisProgress({...analysis, status: "completed"}, 10_500), null);
  assert.equal(exports.photoAnalysisProgress({...analysis, status: "failed"}, 10_500), null);
  assert.equal(exports.photoAnalysisProgress(undefined, 10_500), null);
});

test("a saved upload card reserves the same image while analysis starts and finishes", (t) => {
  const {mount, api} = setup(t, "window");
  const props = {photo: {id: "kitchen", title: "Kitchen window"}, source: "/room.jpg", onSelect() {}};
  api.render({...props, analysisProgress: 38});
  const image = mount.querySelector(".roman-window-image");
  assert.equal(mount.querySelector('[role="progressbar"]').getAttribute("aria-valuenow"), "38");
  assert.equal(mount.querySelector(".roman-window-use"), null);
  api.render({...props, analysisProgress: null});
  assert.equal(mount.querySelector(".roman-window-image"), image);
  assert.equal(mount.querySelector('[role="progressbar"]'), null);
  assert.ok(mount.querySelector(".roman-window-use"));
});

test("comparison preserves vertical touch scroll, supports horizontal dragging and keyboard bounds", async (t) => {
  const {window, mount, api} = setup(t, "comparison");
  api.render({before: "/before.jpg", after: "/after.jpg", width: 600, height: 800});
  await delay(25);
  const slider = mount.querySelector('[role="slider"]');
  assert.ok(slider);
  assert.equal(mount.firstElementChild.style.aspectRatio, "600 / 800");
  pointer(window, slider, "pointerdown", {});
  pointer(window, slider, "pointermove", {clientX: 105, clientY: 30});
  await delay(5);
  assert.equal(slider.getAttribute("aria-valuenow"), "50");
  pointer(window, slider, "pointercancel", {});
  pointer(window, slider, "pointerdown", {});
  pointer(window, slider, "pointermove", {clientX: 150, clientY: 2});
  await delay(5);
  assert.equal(slider.getAttribute("aria-valuenow"), "75");
  pointer(window, slider, "pointerup", {});
  slider.dispatchEvent(new window.KeyboardEvent("keydown", {key: "End", bubbles: true}));
  await delay(5);
  slider.dispatchEvent(new window.KeyboardEvent("keydown", {key: "ArrowRight", bubbles: true}));
  await delay(5);
  assert.equal(slider.getAttribute("aria-valuenow"), "100");
});

test("comparison keeps its reserved canvas and disables the slider if either image is unavailable", async (t) => {
  const {mount, api} = setup(t, "comparison");
  api.render({before: "/before.jpg", after: "/unavailable.jpg", width: 800, height: 600});
  await delay(25);
  assert.equal(mount.querySelector('[role="slider"]'), null);
  assert.match(mount.textContent, /unavailable/);
  assert.equal(mount.firstElementChild.style.aspectRatio, "800 / 600");
});

test("comparison releases replaced private image leases while retaining the displayed pair", async (t) => {
  const {mount, api} = setup(t, "comparison");
  const active = new Set(); let count = 0;
  const source = () => { const url = `/private-${++count}.jpg`; active.add(url); return {url, release: () => active.delete(url)}; };
  api.render({before: source, after: source});
  await delay(25);
  assert.equal(active.size, 2);
  for (const image of mount.querySelectorAll("img")) assert.ok(active.has(image.getAttribute("src")));
  api.render({before: "/borrowed-before.jpg", after: "/borrowed-after.jpg"});
  await delay(25);
  assert.equal(active.size, 0);
  assert.equal(mount.querySelector('[role="slider"]').getAttribute("aria-valuenow"), "50");
});

test("closing a comparison releases its loaded half without waiting for the other source", async (t) => {
  const {api} = setup(t, "comparison");
  const active = new Set();
  const lease = (url) => { active.add(url); return {url, release: () => active.delete(url)}; };
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  api.render({before: () => lease("/before.jpg"), after: () => pending});
  await delay(15);
  assert.equal(active.size, 1);
  api.render({before: "/replacement-before.jpg", after: "/replacement-after.jpg"});
  await delay(15);
  assert.equal(active.size, 0, "loaded half should release even while the other request is pending");
  resolve(lease("/late-after.jpg"));
  await delay(15);
  assert.equal(active.size, 0, "late response must release without being rendered");
});

test("fullscreen viewer owns image and download leases and releases them when replaced", async (t) => {
  const {window, mount, api} = setup(t, "viewer");
  const active = new Set(); let count = 0;
  const source = () => { const url = `/private-${++count}.jpg`; active.add(url); return {url, release: () => active.delete(url)}; };
  const result = () => Promise.resolve({...source(), blob: new window.Blob(["fixture"], {type: "image/jpeg"})});
  const props = {title: "Kitchen", width: 600, height: 800, filename: "kitchen.jpg", onClose() {}};
  api.render({...props, before: source, after: source, resultAsset: result});
  await delay(25);
  assert.equal(active.size, 3);
  assert.equal(mount.querySelector(".roman-visualization-save").disabled, false);
  api.render({...props, before: "/before.jpg", after: "/after.jpg", resultAsset: Promise.resolve(null)});
  await delay(25);
  assert.equal(active.size, 0);
  assert.equal(mount.querySelector(".roman-visualization-save").disabled, true);
});

test("private Gallery images resolve only near view and release decoded pixels offscreen", async (t) => {
  const {mount, api, observers} = setup(t, "image");
  let requests = 0;
  api.render({source: () => { requests++; return "/private.jpg"; }, sourceKey: "window-1", alt: "Kitchen"});
  assert.equal(requests, 0);
  observers[0].callback([{isIntersecting: true}]);
  await delay(10);
  assert.equal(requests, 1);
  assert.ok(mount.querySelector("img"));
  observers[0].callback([{isIntersecting: false}]);
  await delay(5);
  assert.equal(mount.querySelector("img"), null);
  observers[0].callback([{isIntersecting: true}]);
  await delay(5);
  assert.equal(requests, 2);
});

test("upload review requires name and consent, focuses close and saves before a product exists", async (t) => {
  const {window, mount, api} = setup(t, "upload");
  const submitted = [];
  const props = {
    draft: {file: new window.File(["jpeg"], "room.jpg", {type: "image/jpeg"}), window: null, preview: "/room.jpg", title: "Kitchen", cleanup: true, consent: false},
    windows: [], windowSource: () => null, onDraftChange() {}, onFile() {}, onSelectWindow() {}, onSubmit: (draft) => submitted.push(draft), onClose() {},
  };
  window.document.querySelector("[data-roman-upload]").focus();
  api.render(props);
  assert.equal(window.document.activeElement.getAttribute("aria-label"), "Close");
  assert.equal(mount.querySelector("[role='tablist']"), null);
  await delay(10);
  mount.querySelector("img").dispatchEvent(new window.Event("load"));
  await delay(5);
  assert.equal(mount.querySelector("button[type='submit']").disabled, true);
  api.render({...props, draft: {...props.draft, consent: true, title: "  Kitchen  "}});
  await delay(5);
  const button = mount.querySelector("button[type='submit']");
  assert.equal(button.textContent, "Save window");
  assert.equal(button.disabled, false);
  mount.querySelector("form").dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true}));
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].title, "Kitchen");
  api.dispose();
  assert.equal(window.document.activeElement.getAttribute("data-roman-upload"), "");
});

test("saved-window review reuses consent and identity without reuploading", async (t) => {
  const {window, mount, api} = setup(t, "upload");
  const photo = {id: "window-1", title: "Kitchen", revision: 3, width: 600, height: 800, cleanup: true, createdAt: "2026-10-06"};
  const submitted = [];
  api.render({draft: {file: null, window: photo, preview: "/saved.jpg", title: "Breakfast room", cleanup: true, consent: true}, windows: [],
    productTitle: "Blue blind", windowSource: () => null, onDraftChange() {}, onFile() {}, onSelectWindow() {}, onSubmit: (draft) => submitted.push(draft), onClose() {}});
  await delay(10);
  mount.querySelector("img").dispatchEvent(new window.Event("load"));
  await delay(5);
  assert.equal(mount.querySelectorAll("input[type='checkbox']").length, 1);
  assert.equal(mount.querySelector("button[type='submit']").textContent, "Visualize in your room");
  mount.querySelector("form").dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true}));
  assert.equal(submitted[0].window.id, "window-1");
  assert.equal(submitted[0].file, null);
});

test("native share cancellation never initiates a download; unsupported or failed share does", async (t) => {
  const {window, exports} = setup(t);
  let downloads = 0;
  window.HTMLAnchorElement.prototype.click = () => downloads++;
  window.navigator.canShare = () => true;
  const asset = {url: "blob:private", blob: new window.Blob(["jpeg"], {type: "image/jpeg"})};
  window.navigator.share = () => Promise.reject(new window.DOMException("cancelled", "AbortError"));
  assert.equal(await exports.saveVisualization(asset, "roman.jpg", true), "cancelled");
  assert.equal(downloads, 0);
  window.navigator.share = () => Promise.reject(new Error("unsupported"));
  assert.equal(await exports.saveVisualization(asset, "roman.jpg", true), "downloaded");
  assert.equal(downloads, 1);
  window.navigator.share = () => Promise.resolve();
  assert.equal(await exports.saveVisualization(asset, "roman.jpg", true), "shared");
  assert.equal(downloads, 1);
});

test("estimated progress remains bounded and never claims provider completion", (t) => {
  const {exports} = setup(t);
  assert.equal(exports.estimatedGenerationProgress(1000, 500), 0);
  assert.equal(exports.estimatedGenerationProgress(1000, 100000), 95);
  assert.equal(exports.estimatedGenerationProgress(NaN, 100000), 0);
});
