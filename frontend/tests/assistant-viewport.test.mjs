import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  entryPoints: ["frontend/src/assistant-viewport.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "AssistantViewport",
  platform: "browser",
});

function setup(t, { visual = true, width = 390 } = {}) {
  const dom = new JSDOM("<roman-ai-assistant></roman-ai-assistant>", {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.innerWidth = width;
  window.innerHeight = 844;
  window.matchMedia = () => ({ matches: window.innerWidth <= 1023 });
  const host = window.document.querySelector("roman-ai-assistant");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = '<textarea data-roman-composer></textarea><input aria-label="Measurement"><button>Other control</button>';
  const composer = shadow.querySelector("textarea");
  const measurement = shadow.querySelector("input");
  const viewport = Object.assign(new window.EventTarget(), {
    height: 844,
    offsetTop: 0,
    scale: 1,
  });
  if (visual)
    Object.defineProperty(window, "visualViewport", { value: viewport });
  const frames = new Map();
  let nextFrame = 0;
  window.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  window.eval(bundle.outputFiles[0].text + "\nwindow.AssistantViewport = AssistantViewport;");
  const owner = window.AssistantViewport.createAssistantViewport(host);
  t.after(() => owner.dispose());
  return {
    window, host, composer, measurement, viewport, owner, frames,
    value: (name) => host.style.getPropertyValue("--roman-" + name),
    event(target, name) {
      target.dispatchEvent(new window.Event(name));
    },
    flush() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback();
    },
  };
}

const properties = ["visible-height", "visible-top", "layout-height", "keyboard-inset"];

test("mobile composer keeps page height stable through keyboard resizing, panning and blur", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  ctx.composer.focus();
  assert.equal(ctx.host.shadowRoot.activeElement, ctx.composer);
  assert.equal(ctx.value("layout-height"), "844px");
  ctx.viewport.height = 390;
  ctx.viewport.offsetTop = 72;
  ctx.event(ctx.viewport, "resize");
  ctx.event(ctx.viewport, "scroll");
  assert.equal(ctx.frames.size, 1, "A keyboard transition batches its style writes");
  ctx.flush();
  assert.equal(ctx.value("visible-height"), "390px", "Dialogs still receive the visible height");
  assert.equal(ctx.value("visible-top"), "72px");
  assert.equal(ctx.value("layout-height"), "844px", "The page does not reflow into the keyboard viewport");
  assert.equal(ctx.value("keyboard-inset"), "382px");
  ctx.viewport.offsetTop = 100;
  ctx.event(ctx.viewport, "scroll");
  ctx.flush();
  assert.equal(ctx.value("layout-height"), "844px");
  assert.equal(ctx.value("keyboard-inset"), "354px", "Composer movement follows the visible bottom, including Safari pan");
  ctx.composer.blur();
  ctx.flush();
  assert.equal(ctx.value("layout-height"), "844px", "Blur cannot shrink the page while the keyboard is still visible");
  assert.equal(ctx.value("keyboard-inset"), "354px");
  ctx.viewport.height = 900;
  ctx.viewport.offsetTop = 0;
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  assert.equal(ctx.value("keyboard-inset"), "0px");
  assert.equal(ctx.value("layout-height"), "900px", "Keyboard recovery adopts a larger viewport in the same event, without a stale bottom gap");
  ctx.viewport.height = 800;
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  assert.equal(ctx.value("layout-height"), "800px", "Ordinary browser resizing resumes once the keyboard has closed");
});

test("focus preserves the last rendered height when an earlier viewport update is still queued", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  ctx.viewport.height = 800;
  ctx.event(ctx.viewport, "resize");
  assert.equal(ctx.frames.size, 1);
  ctx.composer.focus();
  assert.equal(ctx.frames.size, 0, "Focus cancels the stale scheduled snapshot");
  assert.equal(ctx.value("layout-height"), "844px", "Focus must not suddenly apply a queued page reflow");
  assert.equal(ctx.value("keyboard-inset"), "44px");
  ctx.viewport.height = 380;
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  assert.equal(ctx.value("layout-height"), "844px");
  assert.equal(ctx.value("keyboard-inset"), "464px");
});

test("focusout before the keyboard resize event preserves the pre-keyboard baseline", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  ctx.composer.focus();
  // Safari can expose its changed dimensions before delivering resize. The
  // blur's scheduled update must not replace the earlier focus snapshot.
  ctx.viewport.height = 390;
  ctx.composer.blur();
  ctx.flush();
  assert.equal(ctx.value("layout-height"), "844px");
  assert.equal(ctx.value("keyboard-inset"), "454px");
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  assert.equal(ctx.value("layout-height"), "844px");
  ctx.viewport.height = 844;
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  assert.equal(ctx.value("keyboard-inset"), "0px");
});

test("a first keyboard resize uses the last full height when composer focus was not delivered as an event", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  // Focus can predate the owner's listener or arrive through a browser path
  // without focusin. Its authoritative ShadowRoot state still identifies it.
  Object.defineProperty(ctx.host.shadowRoot, "activeElement", { get: () => ctx.composer });
  ctx.viewport.height = 390;
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  assert.equal(ctx.value("layout-height"), "844px");
  assert.equal(ctx.value("keyboard-inset"), "454px");
});

test("width changes reset the compact layout baseline instead of retaining portrait height", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  ctx.composer.focus();
  ctx.viewport.height = 390;
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  ctx.window.innerWidth = 844;
  ctx.viewport.height = 300;
  ctx.event(ctx.window, "resize");
  ctx.flush();
  assert.equal(ctx.value("layout-height"), "300px");
  assert.equal(ctx.value("keyboard-inset"), "0px");
  ctx.viewport.height = 250;
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  assert.equal(ctx.value("layout-height"), "300px");
  assert.equal(ctx.value("keyboard-inset"), "50px");
});

test("ordinary mobile resizing and non-composer input focus do not freeze page height", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  ctx.viewport.height = 800;
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  assert.equal(ctx.value("layout-height"), "800px");
  ctx.measurement.focus();
  ctx.viewport.height = 390;
  ctx.viewport.offsetTop = 30;
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  assert.equal(ctx.value("layout-height"), "420px");
  assert.equal(ctx.value("keyboard-inset"), "0px");
});

test("desktop keeps following the visible viewport and never lifts the composer", (t) => {
  const ctx = setup(t, { width: 1440 });
  ctx.owner.setOpen(true);
  ctx.composer.focus();
  ctx.viewport.height = 600;
  ctx.viewport.offsetTop = 15;
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  assert.equal(ctx.value("visible-height"), "600px");
  assert.equal(ctx.value("visible-top"), "15px");
  assert.equal(ctx.value("layout-height"), "615px");
  assert.equal(ctx.value("keyboard-inset"), "0px");
});

test("closing cancels pending work and removes viewport and focus listeners; reopening starts cleanly", (t) => {
  const ctx = setup(t);
  ctx.event(ctx.viewport, "resize");
  ctx.composer.focus();
  assert.equal(ctx.frames.size, 0);
  for (const name of properties) assert.equal(ctx.value(name), "");
  ctx.composer.blur();
  ctx.owner.setOpen(true);
  ctx.composer.focus();
  ctx.viewport.height = 370;
  ctx.event(ctx.viewport, "resize");
  assert.equal(ctx.frames.size, 1);
  ctx.owner.setOpen(false);
  assert.equal(ctx.frames.size, 0);
  for (const name of properties) assert.equal(ctx.value(name), "");
  ctx.composer.blur();
  ctx.measurement.focus();
  for (const target of [ctx.viewport, ctx.window]) ctx.event(target, "resize");
  ctx.event(ctx.viewport, "scroll");
  assert.equal(ctx.frames.size, 0);
  ctx.owner.setOpen(true);
  assert.equal(ctx.value("layout-height"), "370px", "Reopening does not reuse an obsolete editing baseline");
  assert.equal(ctx.value("keyboard-inset"), "0px");
  ctx.composer.focus();
  ctx.event(ctx.viewport, "resize");
  ctx.owner.dispose();
  ctx.composer.blur();
  ctx.event(ctx.viewport, "scroll");
  ctx.event(ctx.window, "resize");
  assert.equal(ctx.frames.size, 0);
  for (const name of properties) assert.equal(ctx.value(name), "");
});

test("pinch zoom clears all owned geometry and returns to the unzoomed editing layout", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  ctx.composer.focus();
  ctx.viewport.scale = 2;
  ctx.viewport.height = 422;
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  for (const name of properties) assert.equal(ctx.value(name), "");
  ctx.viewport.scale = 1;
  ctx.viewport.height = 844;
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  assert.equal(ctx.value("layout-height"), "844px");
  assert.equal(ctx.value("keyboard-inset"), "0px");
});

test("without VisualViewport, window resizing remains supported in normal and editing modes", (t) => {
  const ctx = setup(t, { visual: false });
  ctx.owner.setOpen(true);
  assert.equal(ctx.value("visible-height"), "844px");
  ctx.window.innerHeight = 500;
  ctx.event(ctx.window, "resize");
  ctx.flush();
  assert.equal(ctx.value("layout-height"), "500px");
  ctx.composer.focus();
  ctx.window.innerHeight = 300;
  ctx.event(ctx.window, "resize");
  ctx.flush();
  assert.equal(ctx.value("layout-height"), "500px");
  assert.equal(ctx.value("visible-height"), "300px");
  assert.equal(ctx.value("keyboard-inset"), "200px");
});
