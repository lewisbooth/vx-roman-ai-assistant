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
    window, host, shadow, composer, measurement, viewport, owner, frames,
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

function focusSpy(element, onFocus) {
  const calls = [];
  const focus = element.focus.bind(element);
  element.focus = (options) => {
    calls.push(options);
    if (onFocus) onFocus(options);
    else focus(options);
  };
  return calls;
}

function touch(ctx, type, {
  target = ctx.composer,
  points = [{ identifier: 1, clientX: 20, clientY: 30 }],
  remaining,
  at,
  cancelable = true,
  handled = false,
} = {}) {
  const event = new ctx.window.Event(type, { bubbles: true, composed: true, cancelable });
  Object.defineProperties(event, {
    touches: { value: remaining ?? (type === "touchend" || type === "touchcancel" ? [] : points) },
    changedTouches: { value: points },
  });
  if (at !== undefined) Object.defineProperty(event, "timeStamp", { value: at });
  if (handled) event.preventDefault();
  target.dispatchEvent(event);
  return event;
}

function blurToward(ctx, target, relatedTarget) {
  target.dispatchEvent(new ctx.window.FocusEvent("blur", { relatedTarget }));
}

test("internal shadow focus changes update viewport geometry without waiting for a host event", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  ctx.viewport.height = 800;
  ctx.event(ctx.viewport, "resize");
  assert.equal(ctx.frames.size, 1);
  Object.defineProperty(ctx.shadow, "activeElement", { get: () => ctx.composer });
  ctx.composer.dispatchEvent(new ctx.window.FocusEvent("focusin", {
    bubbles: true,
    composed: false,
    relatedTarget: ctx.measurement,
  }));
  assert.equal(ctx.frames.size, 0, "Internal focus transitions do not escape Shadow DOM to the host");
  assert.equal(ctx.value("visible-height"), "800px");
  assert.equal(ctx.value("layout-height"), "844px");
  assert.equal(ctx.value("keyboard-inset"), "44px");
});

test("mobile focus transition into the composer uses preventScroll and guards nested blur", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  const calls = focusSpy(ctx.composer, () => blurToward(ctx, ctx.measurement, ctx.composer));
  blurToward(ctx, ctx.measurement, ctx.composer);
  assert.equal(calls.length, 1, "Calling focus inside blur cannot recurse");
  assert.equal(calls[0]?.preventScroll, true);
});

test("the blur guard ignores desktop, disabled, foreign and non-composer destinations", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  const composerCalls = focusSpy(ctx.composer, () => {});
  const measurementCalls = focusSpy(ctx.measurement, () => {});
  const foreign = ctx.window.document.createElement("textarea");
  foreign.setAttribute("data-roman-composer", "");
  ctx.window.document.body.append(foreign);
  const foreignCalls = focusSpy(foreign, () => {});
  blurToward(ctx, ctx.composer, ctx.measurement);
  blurToward(ctx, ctx.measurement, foreign);
  blurToward(ctx, ctx.measurement, null);
  ctx.composer.disabled = true;
  blurToward(ctx, ctx.measurement, ctx.composer);
  ctx.composer.disabled = false;
  ctx.window.innerWidth = 1440;
  blurToward(ctx, ctx.measurement, ctx.composer);
  assert.equal(composerCalls.length, 0);
  assert.equal(measurementCalls.length, 0);
  assert.equal(foreignCalls.length, 0);
});

test("the first mobile tap focuses the composer without native page scroll, while later caret taps remain native", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  const calls = focusSpy(ctx.composer);
  assert.equal(ctx.window.document.activeElement, ctx.window.document.body);
  assert.equal(touch(ctx, "touchstart").defaultPrevented, false, "Touch start remains available to native gesture recognition");
  const end = touch(ctx, "touchend");
  assert.equal(end.defaultPrevented, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.preventScroll, true);
  assert.equal(ctx.shadow.activeElement, ctx.composer);
  touch(ctx, "touchstart");
  assert.equal(touch(ctx, "touchend").defaultPrevented, false, "Caret positioning must stay native once focused");
  assert.equal(calls.length, 1);
});

test("a slight tap movement is allowed but scrolling, multitouch, cancellation and context menus cancel focus", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  const calls = focusSpy(ctx.composer);
  const point = (x, y, identifier = 1) => ({ identifier, clientX: x, clientY: y });
  touch(ctx, "touchstart");
  touch(ctx, "touchmove", { points: [point(24, 33)] });
  assert.equal(touch(ctx, "touchend", { points: [point(24, 33)] }).defaultPrevented, true);
  assert.equal(calls.length, 1);
  ctx.composer.blur();
  for (const cancel of [
    () => touch(ctx, "touchmove", { points: [point(29, 30)] }),
    () => touch(ctx, "touchmove", { points: [point(20, 39)] }),
    () => touch(ctx, "touchstart", { points: [point(20, 30), point(21, 31, 2)] }),
    () => touch(ctx, "touchmove", { points: [point(20, 30), point(21, 31, 2)] }),
    () => touch(ctx, "touchcancel"),
    () => ctx.composer.dispatchEvent(new ctx.window.Event("contextmenu", { bubbles: true, composed: true })),
  ]) {
    touch(ctx, "touchstart");
    cancel();
    assert.equal(touch(ctx, "touchend").defaultPrevented, false);
    assert.equal(calls.length, 1, "An abandoned touch must not focus or summon the keyboard");
  }
});

test("touch fallback requires an unhandled cancelable end on the same enabled mobile composer", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  const calls = focusSpy(ctx.composer);
  const measurementCalls = focusSpy(ctx.measurement);
  assert.equal(touch(ctx, "touchend").defaultPrevented, false, "An orphaned end is not a tap");
  touch(ctx, "touchstart");
  touch(ctx, "touchend", { handled: true });
  touch(ctx, "touchstart");
  assert.equal(touch(ctx, "touchend", { cancelable: false }).defaultPrevented, false);
  touch(ctx, "touchstart");
  assert.equal(touch(ctx, "touchend", { remaining: [{ identifier: 2, clientX: 20, clientY: 30 }] }).defaultPrevented, false);
  touch(ctx, "touchstart");
  assert.equal(touch(ctx, "touchend", { target: ctx.measurement }).defaultPrevented, false);
  touch(ctx, "touchstart", { target: ctx.measurement });
  assert.equal(touch(ctx, "touchend", { target: ctx.measurement }).defaultPrevented, false);
  ctx.composer.disabled = true;
  touch(ctx, "touchstart");
  assert.equal(touch(ctx, "touchend").defaultPrevented, false);
  ctx.composer.disabled = false;
  touch(ctx, "touchstart");
  ctx.composer.disabled = true;
  assert.equal(touch(ctx, "touchend").defaultPrevented, false);
  ctx.composer.disabled = false;
  ctx.window.innerWidth = 1440;
  touch(ctx, "touchstart");
  assert.equal(touch(ctx, "touchend").defaultPrevented, false);
  assert.equal(calls.length, 0);
  assert.equal(measurementCalls.length, 0);
});

test("native focus arriving between touchstart and touchend is never overridden", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  const calls = focusSpy(ctx.composer);
  touch(ctx, "touchstart");
  ctx.composer.focus();
  assert.equal(touch(ctx, "touchend").defaultPrevented, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], undefined, "Only the original native focus request ran");
});

test("a tap from another Roman control uses the blur guard, without consuming the native touch end", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  const button = ctx.shadow.querySelector("button");
  button.focus();
  const calls = focusSpy(ctx.composer);
  touch(ctx, "touchstart");
  assert.equal(touch(ctx, "touchend").defaultPrevented, false);
  assert.equal(calls.length, 0, "The body-only touch fallback must not replace ordinary control transitions");
  blurToward(ctx, button, ctx.composer);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.preventScroll, true);
  assert.equal(ctx.shadow.activeElement, ctx.composer);
});

test("long presses remain native even without a contextmenu event, while short taps can focus", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  const calls = focusSpy(ctx.composer);
  for (const duration of [500, 1500]) {
    touch(ctx, "touchstart", { at: 1000 });
    assert.equal(touch(ctx, "touchend", { at: 1000 + duration }).defaultPrevented, false);
    assert.equal(calls.length, 0);
  }
  touch(ctx, "touchstart", { at: 3000 });
  assert.equal(touch(ctx, "touchend", { at: 3499 }).defaultPrevented, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.preventScroll, true);
});

test("pinch zoom leaves focus native at blur, touchstart and touchend", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  const calls = focusSpy(ctx.composer);
  ctx.viewport.scale = 1.5;
  blurToward(ctx, ctx.measurement, ctx.composer);
  touch(ctx, "touchstart");
  assert.equal(touch(ctx, "touchend").defaultPrevented, false);
  touch(ctx, "touchstart");
  ctx.viewport.scale = 1;
  assert.equal(touch(ctx, "touchend").defaultPrevented, false, "A touch begun during zoom cannot become a guarded tap");
  touch(ctx, "touchstart");
  ctx.viewport.scale = 1.5;
  assert.equal(touch(ctx, "touchend").defaultPrevented, false, "Zoom beginning before release cancels the pending focus");
  ctx.viewport.scale = 1;
  touch(ctx, "touchstart");
  ctx.window.innerWidth = 1440;
  assert.equal(touch(ctx, "touchend").defaultPrevented, false, "A gesture no longer in compact layout is left native");
  assert.equal(calls.length, 0);
});

test("closing clears touch intent and removes focus guards until reopening", (t) => {
  const ctx = setup(t);
  const calls = focusSpy(ctx.composer);
  ctx.owner.setOpen(true);
  touch(ctx, "touchstart");
  ctx.owner.setOpen(false);
  assert.equal(touch(ctx, "touchend").defaultPrevented, false);
  blurToward(ctx, ctx.measurement, ctx.composer);
  assert.equal(calls.length, 0);
  ctx.owner.setOpen(true);
  assert.equal(touch(ctx, "touchend").defaultPrevented, false, "Reopening cannot finish a gesture from the previous opening");
  touch(ctx, "touchstart");
  assert.equal(touch(ctx, "touchend").defaultPrevented, true);
  assert.equal(calls.length, 1);
  ctx.composer.blur();
  touch(ctx, "touchstart");
  ctx.owner.dispose();
  assert.equal(touch(ctx, "touchend").defaultPrevented, false);
  blurToward(ctx, ctx.measurement, ctx.composer);
  assert.equal(calls.length, 1);
});

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
  assert.equal(ctx.value("keyboard-inset"), "454px");
  ctx.viewport.offsetTop = 100;
  ctx.event(ctx.viewport, "scroll");
  ctx.flush();
  assert.equal(ctx.value("layout-height"), "844px");
  assert.equal(ctx.value("keyboard-inset"), "454px", "Safari pan repositions the frame without changing the composer's lift within it");
  ctx.composer.blur();
  ctx.flush();
  assert.equal(ctx.value("layout-height"), "844px", "Blur cannot shrink the page while the keyboard is still visible");
  assert.equal(ctx.value("keyboard-inset"), "454px");
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

test("offset-only Safari panning never changes page height, composer lift or keyboard recovery state", (t) => {
  const ctx = setup(t);
  ctx.viewport.offsetTop = 72;
  ctx.owner.setOpen(true);
  assert.equal(ctx.value("visible-top"), "72px");
  assert.equal(ctx.value("layout-height"), "844px", "A page pan is not part of its available height");
  assert.equal(ctx.value("keyboard-inset"), "0px");
  ctx.composer.focus();
  ctx.viewport.height = 390;
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  ctx.composer.blur();
  ctx.flush();
  // A large pan must not look like keyboard closure just because offset+height
  // exceeds the old layout height. No resize event accompanies these changes.
  for (const offset of [100, 600, 0, 72]) {
    ctx.viewport.offsetTop = offset;
    ctx.event(ctx.viewport, "scroll");
    ctx.flush();
    assert.equal(ctx.value("visible-top"), `${offset}px`);
    assert.equal(ctx.value("visible-height"), "390px");
    assert.equal(ctx.value("layout-height"), "844px");
    assert.equal(ctx.value("keyboard-inset"), "454px");
  }
  ctx.viewport.height = 844;
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  assert.equal(ctx.value("layout-height"), "844px");
  assert.equal(ctx.value("keyboard-inset"), "0px");
  ctx.viewport.offsetTop = 200;
  ctx.event(ctx.viewport, "scroll");
  ctx.flush();
  assert.equal(ctx.value("visible-top"), "200px");
  assert.equal(ctx.value("layout-height"), "844px", "Ordinary unfocused panning cannot inflate the page either");
  assert.equal(ctx.value("keyboard-inset"), "0px");
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
  assert.equal(ctx.value("layout-height"), "390px");
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
  assert.equal(ctx.value("layout-height"), "600px");
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
