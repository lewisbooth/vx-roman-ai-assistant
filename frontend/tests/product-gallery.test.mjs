import assert from "node:assert/strict";
import { cwd } from "node:process";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { ProductGallery } from './frontend/src/chat/ProductGallery';
      export function mount(container) {
        const root = createRoot(container);
        return {
          flush: flushSync,
          render(items, extra = {}) { flushSync(() => root.render(<ProductGallery key={extra.productPath || 'blind'} title="Linen blind" items={items} {...extra} />)); },
          dispose() { flushSync(() => root.unmount()); }
        };
      }
    `,
    resolveDir: cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "GalleryTest",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

const image = (id, kind = "product") => ({
  id,
  kind,
  alt: `${id} view`,
  src: `https://cdn.shopify.com/s/files/${id}.jpg?width=1200`,
  thumbnailSrc: `https://cdn.shopify.com/s/files/${id}.jpg?width=90`,
  zoomSrc: `https://cdn.shopify.com/s/files/${id}.jpg?width=1600`,
  width: 1200,
  height: 1500,
});
const items = [image("room"), image("detail"), image("back")];

function setup(t, { reduced = false } = {}) {
  const dom = new JSDOM(
    "<!doctype html><roman-ai-assistant></roman-ai-assistant>",
    {
      url: "https://shop.example",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;
  const animations = [];
  const resizeObservers = [];
  window.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      resizeObservers.push(this);
    }
    observe(element) {
      this.element = element;
    }
    disconnect() {
      this.disconnected = true;
    }
  };
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 320,
  });
  window.matchMedia = () => ({ matches: reduced });
  window.HTMLElement.prototype.animate = function (frames, options) {
    const animation = {
      element: this,
      frames,
      options,
      cancelled: false,
      onfinish: null,
      cancel() {
        this.cancelled = true;
      },
    };
    animations.push(animation);
    return animation;
  };
  const failures = [],
    dialogs = [],
    captured = new Set();
  window.console.error = (...args) => failures.push(args);
  window.HTMLElement.prototype.setPointerCapture = (id) => captured.add(id);
  window.HTMLElement.prototype.hasPointerCapture = (id) => captured.has(id);
  window.HTMLElement.prototype.releasePointerCapture = (id) =>
    captured.delete(id);
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
    dialogs.push(this);
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const shadow = window.document
    .querySelector("roman-ai-assistant")
    .attachShadow({ mode: "open" });
  window.eval(`${bundle.outputFiles[0].text};window.GalleryTest=GalleryTest;`);
  const view = window.GalleryTest.mount(shadow);
  let disposed = false;
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      view.dispose();
    }
  };
  t.after(() => {
    dispose();
    window.close();
    assert.deepEqual(failures, []);
  });
  const click = (selector, detail = 0) =>
    view.flush(() =>
      shadow.querySelector(selector).dispatchEvent(
        new window.MouseEvent("click", {
          bubbles: true,
          composed: true,
          detail,
        }),
      ),
    );
  const key = (selector, key) =>
    view.flush(() =>
      shadow.querySelector(selector).dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  const pointer = (
    type,
    x,
    y = 20,
    pointerType = "mouse",
    selector = ".roman-gallery-viewport",
    options = {},
  ) =>
    view.flush(() => {
      const event = new window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        ...options,
      });
      Object.defineProperties(event, {
        pointerId: { value: options.pointerId ?? 1 },
        isPrimary: { value: options.isPrimary ?? true },
        pointerType: { value: pointerType },
      });
      shadow.querySelector(selector).dispatchEvent(event);
    });
  return {
    window,
    shadow,
    view,
    dialogs,
    captured,
    animations,
    resizeObservers,
    click,
    key,
    pointer,
    dispose,
    finish: (animation = animations.at(-1)) =>
      view.flush(() => animation?.onfinish?.()),
    current: () =>
      shadow.querySelector(".roman-gallery-viewport [data-current] img")?.src,
  };
}

test("gallery bounds loaded images to the current slide and its immediate neighbours without loading zoom media", (t) => {
  const ctx = setup(t);
  const many = [...items, image("fabric"), image("fittings")];
  ctx.view.render(many);
  assert.equal(ctx.current(), items[0].src);
  assert.equal(ctx.shadow.querySelectorAll('img[src*="width=1200"]').length, 3);
  assert.equal(ctx.shadow.querySelectorAll('img[src*="width=1600"]').length, 0);
  assert.equal(ctx.shadow.querySelectorAll('img[loading="lazy"]').length, 5);
  assert.deepEqual(
    [
      ...ctx.shadow.querySelectorAll(
        '.roman-gallery-slide[aria-hidden="true"] img',
      ),
    ].map((node) => node.src),
    [many.at(-1).src, many[1].src],
  );
  ctx.view.render(items);
  ctx.click('[aria-label="Next product image"]');
  assert.equal(ctx.current(), items[1].src);
  ctx.click('[aria-label="Show image 3: back view"]');
  assert.equal(ctx.current(), items[2].src);
  ctx.click('[aria-label="Next product image"]');
  assert.equal(ctx.current(), items[0].src);
  ctx.key(".roman-gallery-enlarge", "End");
  assert.equal(ctx.current(), items[2].src);
  ctx.key(".roman-gallery-enlarge", "Home");
  ctx.key(".roman-gallery-enlarge", "ArrowLeft");
  assert.equal(ctx.current(), items[2].src);
});

test("horizontal mouse drag and touch swipe change slides without opening zoom; vertical gestures stay native", (t) => {
  const ctx = setup(t);
  ctx.view.render(items);
  ctx.pointer("pointerdown", 140);
  ctx.pointer("pointermove", 60);
  ctx.pointer("pointerup", 60);
  ctx.finish();
  ctx.click(".roman-gallery-viewport", 1);
  assert.equal(ctx.current(), items[1].src);
  assert.equal(ctx.shadow.querySelector("dialog"), null);
  assert.equal(ctx.captured.size, 0);
  ctx.pointer("pointerdown", 60, 20, "touch");
  ctx.pointer("pointermove", 140, 22, "touch");
  ctx.pointer("pointerup", 140, 22, "touch");
  ctx.finish();
  ctx.click(".roman-gallery-viewport", 1);
  assert.equal(ctx.current(), items[0].src);
  assert.equal(ctx.shadow.querySelector("dialog"), null);
  ctx.pointer("pointerdown", 100);
  ctx.pointer("pointermove", 95, 90);
  ctx.pointer("pointerup", 90, 110);
  assert.equal(ctx.current(), items[0].src);
  ctx.pointer("pointerdown", 100);
  ctx.pointer("pointermove", 40);
  ctx.pointer("pointercancel", 40);
  assert.equal(ctx.captured.size, 0);
  assert.equal(ctx.current(), items[0].src);
  ctx.click(".roman-gallery-enlarge");
  assert.ok(ctx.shadow.querySelector("dialog[open]"));
});

test("only the zoom button opens the dialog, even after surface clicks and incomplete gestures", (t) => {
  const ctx = setup(t);
  ctx.view.render(items);
  for (const selector of [
    ".roman-gallery-viewport",
    ".roman-gallery-viewport img",
  ]) {
    ctx.click(selector, 1);
    ctx.click(selector, 2);
    ctx.key(selector, "Enter");
    ctx.key(selector, " ");
    assert.equal(ctx.shadow.querySelector("dialog"), null);
  }
  ctx.pointer("pointerdown", 100);
  ctx.pointer("pointermove", 96);
  ctx.pointer("pointerup", 96);
  ctx.click(".roman-gallery-viewport img", 1);
  assert.equal(ctx.current(), items[0].src);
  assert.equal(
    ctx.animations.length,
    0,
    "A surface click does not animate a slide",
  );
  assert.equal(ctx.shadow.querySelector("dialog"), null);
  ctx.pointer("pointerdown", 100);
  ctx.pointer("pointermove", 40);
  ctx.pointer("pointercancel", 40);
  ctx.click(".roman-gallery-viewport", 1);
  assert.equal(ctx.shadow.querySelector("dialog"), null);
  ctx.click(".roman-gallery-enlarge");
  assert.ok(ctx.shadow.querySelector("dialog[open]"));
});

test("zoom lazily mounts high-resolution images, supports navigation, and closes before removal", (t) => {
  const ctx = setup(t);
  ctx.view.render(items);
  ctx.click(".roman-gallery-enlarge");
  const dialog = ctx.dialogs[0];
  assert.equal(dialog.open, true);
  assert.equal(
    ctx.shadow.activeElement.getAttribute("aria-label"),
    "Close enlarged image",
  );
  assert.equal(
    dialog.querySelector("[data-current] img").src,
    items[0].zoomSrc,
  );
  ctx.key("dialog", "ArrowRight");
  assert.equal(
    dialog.querySelector("[data-current] img").src,
    items[1].zoomSrc,
  );
  assert.equal(ctx.current(), items[1].src);
  ctx.view.flush(() =>
    dialog
      .querySelector("[data-current] img")
      .dispatchEvent(new ctx.window.Event("error")),
  );
  assert.equal(
    dialog.querySelector("[data-current] img").src,
    items[1].src,
    "Failed zoom falls back to regular image once",
  );
  ctx.view.flush(() =>
    dialog.dispatchEvent(new ctx.window.Event("cancel", { cancelable: true })),
  );
  assert.equal(dialog.open, false);
  assert.equal(ctx.shadow.querySelector("dialog"), null);
  ctx.click(".roman-gallery-enlarge");
  ctx.dispose();
  assert.equal(ctx.dialogs[1].open, false);
});

test("updated feature media takes focus once while unchanged snapshots preserve customer selection", (t) => {
  const ctx = setup(t);
  ctx.view.render(items);
  ctx.click('[aria-label="Next product image"]');
  ctx.view.render(structuredClone(items));
  assert.equal(ctx.current(), items[1].src);
  const upgraded = [...items, image("motor", "feature")];
  ctx.view.render(upgraded);
  assert.equal(ctx.current(), upgraded[3].src);
  ctx.click('[aria-label="Show image 1: room view"]');
  ctx.view.render(structuredClone(upgraded));
  assert.equal(ctx.current(), items[0].src);
  const changed = [...items, image("remote", "feature")];
  ctx.view.render(changed);
  assert.equal(ctx.current(), changed[3].src);
  ctx.view.render(items);
  assert.equal(
    ctx.current(),
    items[0].src,
    "Removed feature cannot leave a stale image",
  );
});

test("empty, hidden and changed selections never retain stale image resources or zoom dialogs", (t) => {
  const ctx = setup(t);
  ctx.view.render([]);
  assert.equal(ctx.shadow.querySelector("img"), null);
  assert.equal(ctx.shadow.querySelector("button"), null);
  ctx.view.render([items[0]]);
  assert.equal(ctx.shadow.querySelector(".roman-gallery-controls"), null);
  ctx.view.flush(() =>
    ctx.shadow
      .querySelector("img")
      .dispatchEvent(new ctx.window.Event("error")),
  );
  assert.match(ctx.shadow.textContent, /Image unavailable/);
  ctx.view.render(items);
  ctx.click('[aria-label="Next product image"]');
  ctx.click(".roman-gallery-enlarge");
  ctx.view.render(items, { hidden: true });
  assert.equal(ctx.shadow.querySelector("img"), null);
  assert.equal(ctx.dialogs[0].open, false);
  ctx.view.render(items);
  assert.equal(ctx.current(), items[1].src);
  assert.equal(ctx.shadow.querySelector("dialog"), null);
  ctx.view.render([image("new")], { productPath: "/products/new" });
  assert.equal(ctx.current(), image("new").src);
  assert.doesNotMatch(ctx.shadow.innerHTML, /detail.jpg/);
});

test("swipe follows the pointer, uses the compact viewport threshold and resets on cancellation", (t) => {
  const ctx = setup(t);
  ctx.view.render(items);
  const surface = ctx.shadow.querySelector(".roman-gallery-viewport");
  const track = surface.querySelector(".roman-gallery-track");
  Object.defineProperty(surface, "clientWidth", { value: 88 });
  ctx.pointer("pointerdown", 70);
  ctx.pointer("pointermove", 45);
  surface
    .querySelector("img")
    .dispatchEvent(
      new ctx.window.Event("lostpointercapture", { bubbles: true }),
    );
  assert.equal(track.style.getPropertyValue("--roman-gallery-drag"), "-25px");
  assert.equal(surface.dataset.dragging, "true");
  ctx.pointer("pointerup", 45);
  ctx.finish();
  ctx.click(".roman-gallery-viewport", 1);
  assert.equal(
    ctx.current(),
    items[1].src,
    "A 25px swipe works in the 88px mobile viewport",
  );
  assert.equal(track.style.getPropertyValue("--roman-gallery-drag"), "");
  assert.equal(surface.dataset.dragging, undefined);
  assert.equal(ctx.animations.length, 1);
  ctx.pointer("pointerdown", 70);
  ctx.pointer("pointermove", 50);
  ctx.window.dispatchEvent(new ctx.window.Event("blur"));
  assert.equal(track.style.getPropertyValue("--roman-gallery-drag"), "");
  assert.equal(ctx.captured.size, 0);
  ctx.pointer("pointerdown", 70);
  ctx.pointer("pointermove", 40);
  ctx.dispose();
  assert.equal(ctx.captured.size, 0);
  assert.equal(ctx.animations[0].cancelled, true);
});

test("the enlarged image supports touch swipes and respects reduced motion", (t) => {
  const ctx = setup(t, { reduced: true });
  ctx.view.render(items);
  ctx.click(".roman-gallery-enlarge");
  const surface = ctx.shadow.querySelector(".roman-gallery-zoom-image");
  Object.defineProperty(surface, "clientWidth", { value: 300 });
  ctx.pointer("pointerdown", 230, 30, "touch", ".roman-gallery-zoom-image");
  ctx.pointer("pointermove", 110, 32, "touch", ".roman-gallery-zoom-image");
  assert.equal(
    surface
      .querySelector(".roman-gallery-track")
      .style.getPropertyValue("--roman-gallery-drag"),
    "-120px",
  );
  ctx.pointer("pointerup", 110, 32, "touch", ".roman-gallery-zoom-image");
  assert.equal(
    surface.querySelector("[data-current] img").src,
    items[1].zoomSrc,
  );
  assert.equal(ctx.current(), items[1].src);
  assert.equal(ctx.animations.length, 0);
  ctx.pointer("pointerdown", 200, 30, "touch", ".roman-gallery-zoom-image");
  ctx.pointer("pointermove", 194, 130, "touch", ".roman-gallery-zoom-image");
  ctx.pointer("pointerup", 190, 160, "touch", ".roman-gallery-zoom-image");
  assert.equal(
    surface.querySelector("[data-current] img").src,
    items[1].zoomSrc,
    "Vertical gestures do not select slides",
  );
});

test("drag reveals existing neighbour images, then settles before preserving the incoming image node", (t) => {
  const ctx = setup(t);
  ctx.view.render(items);
  const surface = ctx.shadow.querySelector(".roman-gallery-viewport");
  const track = surface.querySelector(".roman-gallery-track");
  const incoming = track.lastElementChild.querySelector("img");
  surface.getBoundingClientRect = () => ({ left: 0, width: 320.5 });
  assert.equal(incoming.src, items[1].src);
  assert.notEqual(
    incoming.loading,
    "lazy",
    "The incoming full-size image starts loading before the gesture",
  );
  assert.equal(track.children.length, 3);

  ctx.pointer("pointerdown", 220);
  ctx.pointer("pointermove", 100);
  assert.equal(track.style.getPropertyValue("--roman-gallery-drag"), "-120px");
  assert.equal(track.lastElementChild.querySelector("img"), incoming);
  assert.equal(
    ctx.current(),
    items[0].src,
    "The semantic selection remains stable during the drag",
  );
  ctx.pointer("pointerup", 100);
  const snap = ctx.animations.at(-1);
  assert.equal(snap.element, track);
  assert.equal(
    snap.frames[0].transform,
    "translate3d(calc(-100% + -120px), 0, 0)",
  );
  assert.equal(
    snap.frames[1].transform,
    "translate3d(calc(-100% + -320.5px), 0, 0)",
  );
  assert.equal(
    ctx.current(),
    items[0].src,
    "Do not swap images before the settle finishes",
  );
  ctx.pointer("pointerleave", 100);
  assert.equal(
    snap.cancelled,
    false,
    "Leaving after release must not cancel the settle",
  );
  ctx.finish(snap);
  assert.equal(surface.querySelector("[data-current] img"), incoming);
  assert.equal(track.style.getPropertyValue("--roman-gallery-drag"), "");
  assert.equal(snap.cancelled, true);
  assert.equal(snap.onfinish, null);
  assert.equal(surface.querySelectorAll('[aria-hidden="true"]').length, 2);
});

test("short drags animate back without advancing or recreating the current image", (t) => {
  const ctx = setup(t);
  ctx.view.render(items);
  const current = ctx.shadow.querySelector(
    ".roman-gallery-viewport [data-current] img",
  );
  const track = ctx.shadow.querySelector(".roman-gallery-track");
  ctx.pointer("pointerdown", 180);
  ctx.pointer("pointermove", 150);
  ctx.pointer("pointerup", 150);
  const snap = ctx.animations.at(-1);
  assert.equal(
    snap.frames[1].transform,
    "translate3d(calc(-100% + 0px), 0, 0)",
  );
  ctx.finish(snap);
  assert.equal(
    ctx.shadow.querySelector(".roman-gallery-viewport [data-current] img"),
    current,
  );
  assert.equal(ctx.current(), items[0].src);
  assert.equal(track.style.getPropertyValue("--roman-gallery-drag"), "");
});

test("two-image galleries wrap in either direction with both neighbours present", (t) => {
  const ctx = setup(t);
  ctx.view.render(items.slice(0, 2));
  const surface = ctx.shadow.querySelector(".roman-gallery-viewport");
  for (const direction of [1, 1, -1, -1]) {
    const before = ctx.current();
    const next = before === items[0].src ? items[1].src : items[0].src;
    assert.deepEqual(
      [...surface.querySelectorAll('[aria-hidden="true"] img')].map(
        (node) => node.src,
      ),
      [next, next],
    );
    ctx.pointer("pointerdown", 150);
    ctx.pointer("pointermove", 150 - direction * 100);
    ctx.pointer("pointerup", 150 - direction * 100);
    ctx.finish();
    assert.equal(ctx.current(), next);
    assert.equal(surface.querySelectorAll(".roman-gallery-slide").length, 3);
    assert.equal(surface.querySelectorAll("[data-current]").length, 1);
  }
});

test("a fresh drag reverses an in-flight settle from its visible track offset", (t) => {
  const ctx = setup(t);
  ctx.view.render(items);
  const surface = ctx.shadow.querySelector(".roman-gallery-viewport");
  const track = surface.querySelector(".roman-gallery-track");
  surface.getBoundingClientRect = () => ({ left: 20 });
  track.getBoundingClientRect = () => ({ left: 20 - 320 - 120 });
  ctx.pointer("pointerdown", 220);
  ctx.pointer("pointermove", 140);
  ctx.pointer("pointerup", 140);
  const first = ctx.animations.at(-1);
  ctx.pointer("pointerdown", 100);
  assert.equal(track.style.getPropertyValue("--roman-gallery-drag"), "-120px");
  assert.equal(first.cancelled, true);
  assert.equal(first.onfinish, null);
  ctx.pointer("pointermove", 300);
  assert.equal(track.style.getPropertyValue("--roman-gallery-drag"), "80px");
  ctx.pointer("pointerup", 300);
  ctx.finish();
  assert.equal(
    ctx.current(),
    items[2].src,
    "The reversal selects the previous slide, not the abandoned next slide",
  );
});

test("selection changes, viewport resize and removal cancel pending settles and stale completions", (t) => {
  const ctx = setup(t);
  ctx.view.render(items);
  const start = () => {
    ctx.pointer("pointerdown", 220);
    ctx.pointer("pointermove", 100);
    ctx.pointer("pointerup", 100);
    return ctx.animations.at(-1);
  };
  const unchanged = start();
  ctx.view.render(structuredClone(items));
  assert.equal(
    unchanged.cancelled,
    false,
    "An identical store snapshot does not interrupt dragging",
  );
  ctx.click('[aria-label="Show image 3: back view"]');
  assert.equal(unchanged.cancelled, true);
  assert.equal(unchanged.onfinish, null);
  ctx.finish(unchanged);
  assert.equal(ctx.current(), items[2].src);

  const changed = start();
  ctx.view.render([...items, image("motor", "feature")]);
  assert.equal(changed.cancelled, true);
  assert.equal(changed.onfinish, null);
  ctx.finish(changed);
  assert.equal(ctx.current(), image("motor", "feature").src);

  const resized = start();
  ctx.view.flush(() => ctx.resizeObservers[0].callback());
  assert.equal(resized.cancelled, true);
  assert.equal(resized.onfinish, null);
  ctx.finish(resized);
  assert.equal(ctx.current(), image("motor", "feature").src);

  const removed = start();
  ctx.dispose();
  assert.equal(removed.cancelled, true);
  assert.equal(removed.onfinish, null);
  assert.equal(ctx.resizeObservers[0].disconnected, true);
  ctx.finish(removed);
  assert.equal(ctx.shadow.textContent, "");
});

test("pinching, pointer cancellation and lost mouse buttons release capture without selecting or zooming", (t) => {
  const ctx = setup(t);
  ctx.view.render(items);
  const track = ctx.shadow.querySelector(".roman-gallery-track");
  ctx.pointer("pointerdown", 180, 20, "touch");
  ctx.pointer("pointermove", 80, 20, "touch");
  assert.equal(ctx.captured.size, 1);
  ctx.pointer("pointerdown", 240, 20, "touch", ".roman-gallery-viewport", {
    pointerId: 2,
    isPrimary: false,
  });
  assert.equal(ctx.captured.size, 0);
  assert.equal(track.style.getPropertyValue("--roman-gallery-drag"), "");
  ctx.pointer("pointerup", 80, 20, "touch");
  assert.equal(ctx.animations.length, 0);

  ctx.pointer("pointerdown", 180);
  ctx.pointer("pointermove", 80);
  ctx.pointer("pointermove", 70, 20, "mouse", ".roman-gallery-viewport", {
    buttons: 0,
  });
  assert.equal(ctx.captured.size, 0);
  assert.equal(track.style.getPropertyValue("--roman-gallery-drag"), "");
  assert.equal(ctx.current(), items[0].src);
  assert.equal(ctx.animations.length, 0);
  assert.equal(ctx.shadow.querySelector("dialog"), null);
});
