import assert from "node:assert/strict";
import { cwd } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { ProductCarousel } from './frontend/src/chat/ProductCarousel';
      import { StorefrontLink } from './frontend/src/chat/StorefrontLink';
      export function mount(container, navigate) {
        const root = createRoot(container);
        return {
          flush: flushSync,
          render(count = 6) { flushSync(() => root.render(<ProductCarousel>
            <ul className="roman-product-list">{Array.from({length: count}, (_, index) => <li key={index}>
              <StorefrontLink url={'/products/blind-' + index} navigation={{navigate}} className="roman-product-card">
                <img alt="" src="/fixture.jpg" /><span>Blind {index}</span>
              </StorefrontLink>
            </li>)}</ul>
          </ProductCarousel>)); },
          dispose() { flushSync(() => root.unmount()); },
        };
      }
    `,
    resolveDir: cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanCarouselTest",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

function setup(
  t,
  { width = 300, content = 900, reduced = false, observer = true } = {},
) {
  const dom = new JSDOM(
    "<!doctype html><roman-ai-assistant></roman-ai-assistant>",
    {
      url: "https://hd-dev-single.myshopify.com/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;
  const sizes = { width, content };
  const observers = [];
  const navigation = [];
  const nativeClicks = [];
  const scrolling = [];
  const failures = [];
  const captured = new Set();
  window.console.error = (...args) => failures.push(args);
  window.fetch = () =>
    assert.fail("Carousel interaction must not fetch products");
  window.matchMedia = () => ({ matches: reduced });
  Object.defineProperties(window.HTMLElement.prototype, {
    clientWidth: {
      get() {
        return sizes.width;
      },
      configurable: true,
    },
    scrollWidth: {
      get() {
        return sizes.content;
      },
      configurable: true,
    },
    scrollLeft: {
      get() {
        return this._left || 0;
      },
      set(value) {
        this._left = Math.max(0, Math.min(value, sizes.content - sizes.width));
      },
      configurable: true,
    },
  });
  window.HTMLElement.prototype.scrollBy = function (options) {
    scrolling.push(options);
    this.scrollLeft += options.left;
    this.dispatchEvent(new window.Event("scroll"));
  };
  window.HTMLElement.prototype.setPointerCapture = (id) => captured.add(id);
  window.HTMLElement.prototype.hasPointerCapture = (id) => captured.has(id);
  window.HTMLElement.prototype.releasePointerCapture = function (id) {
    captured.delete(id);
    this.dispatchEvent(new window.Event("lostpointercapture"));
  };
  if (observer)
    window.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.targets = [];
        this.disconnected = false;
        observers.push(this);
      }
      observe(target) {
        this.targets.push(target);
      }
      disconnect() {
        this.disconnected = true;
      }
    };
  window.addEventListener("click", (event) => {
    if (
      event.composedPath().some((node) => node.tagName === "A") &&
      !event.defaultPrevented
    ) {
      nativeClicks.push(event);
      event.preventDefault(); // Avoid JSDOM's unsupported native navigation.
    }
  });
  const shadow = window.document
    .querySelector("roman-ai-assistant")
    .attachShadow({ mode: "open" });
  const container = window.document.createElement("div");
  shadow.append(container);
  window.eval(
    `${bundle.outputFiles[0].text};window.RomanCarouselTest=RomanCarouselTest;`,
  );
  const view = window.RomanCarouselTest.mount(container, (href) =>
    navigation.push(href),
  );
  let mounted = true;
  const dispose = () => {
    if (mounted) {
      mounted = false;
      view.dispose();
    }
  };
  view.render();
  const carousel = container.querySelector(".roman-product-scroll");
  t.after(() => {
    dispose();
    window.close();
    assert.deepEqual(failures, []);
  });
  const pointer = (
    type,
    {
      target = carousel,
      x = 200,
      y = 10,
      pointerType = "mouse",
      pointerId = 1,
      ...rest
    } = {},
  ) => {
    const event = new window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      ...rest,
    });
    Object.defineProperties(event, {
      pointerType: { value: pointerType },
      pointerId: { value: pointerId },
    });
    target.dispatchEvent(event);
    return event;
  };
  const click = (target = container.querySelector("a"), options = {}) => {
    const event = new window.MouseEvent("click", {
      bubbles: true,
      composed: true,
      cancelable: true,
      detail: 1,
      button: 0,
      ...options,
    });
    target.dispatchEvent(event);
    return event;
  };
  return {
    window,
    container,
    carousel,
    sizes,
    observers,
    navigation,
    nativeClicks,
    scrolling,
    captured,
    pointer,
    click,
    dispose,
    flush: view.flush,
    render: view.render,
    frame: () => container.querySelector(".roman-product-carousel"),
    button: (label) =>
      container.querySelector(`button[aria-label="${label} products"]`),
    resize: () => {
      observers[0]?.callback();
      window.dispatchEvent(new window.Event("resize"));
    },
  };
}

test("overflow cues and accessible directional controls follow scrolling, resize and content changes", (t) => {
  const ctx = setup(t);
  assert.equal(ctx.frame().dataset.left, "false");
  assert.equal(ctx.frame().dataset.right, "true");
  assert.equal(ctx.button("Previous").disabled, true);
  assert.equal(ctx.button("Next").disabled, false);
  assert.equal(ctx.carousel.tabIndex, 0);
  assert.equal(ctx.observers[0].targets.length, 2);
  ctx.flush(() => ctx.button("Next").click());
  assert.equal(ctx.carousel.scrollLeft, 240);
  assert.equal(ctx.frame().dataset.left, "true");
  assert.equal(ctx.frame().dataset.right, "true");
  // Native listeners schedule React state; commit it before inspecting the DOM.
  ctx.flush(() => {
    ctx.carousel.scrollLeft = 600;
    ctx.carousel.dispatchEvent(new ctx.window.Event("scroll"));
  });
  assert.equal(ctx.frame().dataset.right, "false");
  assert.equal(ctx.button("Next").disabled, true);
  ctx.sizes.content = 250;
  ctx.carousel.scrollLeft = 0;
  ctx.render(1);
  assert.equal(ctx.button("Next"), null);
  assert.equal(ctx.frame().dataset.left, "false");
  ctx.sizes.content = 900;
  ctx.flush(() => ctx.resize());
  assert.equal(ctx.frame().dataset.right, "true");
});

test("a horizontal mouse drag from a card image scrolls and suppresses only its resulting click", async (t) => {
  const ctx = setup(t);
  const image = ctx.container.querySelector("img");
  ctx.pointer("pointerdown", { target: image });
  ctx.pointer("pointermove", { x: 195 });
  assert.equal(ctx.carousel.scrollLeft, 0);
  assert.equal(ctx.captured.size, 0);
  ctx.pointer("pointerup", { x: 195 });
  ctx.click(image);
  assert.equal(
    ctx.navigation.length,
    1,
    "sub-threshold movement stays an ordinary product click",
  );
  ctx.pointer("pointerdown", { target: image });
  const movement = ctx.pointer("pointermove", { x: 60 });
  assert.equal(movement.defaultPrevented, true);
  assert.equal(ctx.carousel.scrollLeft, 140);
  assert.equal(ctx.captured.has(1), true);
  ctx.render(); // An unrelated parent snapshot must not abandon an active drag.
  ctx.pointer("pointermove", { x: 40 });
  assert.equal(ctx.carousel.scrollLeft, 160);
  ctx.pointer("pointerup", { x: 40 });
  assert.equal(ctx.click(image).defaultPrevented, true);
  assert.equal(ctx.navigation.length, 1);
  assert.equal(ctx.captured.size, 0);
  assert.equal(ctx.carousel.dataset.dragging, undefined);
  ctx.pointer("pointerdown", { target: image });
  ctx.pointer("pointerup");
  ctx.click(image);
  assert.equal(ctx.navigation.length, 2, "a later click must not be swallowed");
  await delay(0);
});

test("touch, vertical intent, modified clicks and keyboard activation keep their native behavior", async (t) => {
  const ctx = setup(t);
  const link = ctx.container.querySelector("a");
  for (const pointerType of ["touch", "pen"]) {
    ctx.pointer("pointerdown", { pointerType, target: link });
    assert.equal(
      ctx.pointer("pointermove", { pointerType, x: 20, y: 200 })
        .defaultPrevented,
      false,
    );
    ctx.pointer("pointerup", { pointerType });
  }
  ctx.pointer("pointerdown");
  assert.equal(
    ctx.pointer("pointermove", { x: 180, y: 90 }).defaultPrevented,
    false,
  );
  ctx.pointer("pointerup");
  ctx.pointer("pointerdown", { ctrlKey: true });
  assert.equal(
    ctx.pointer("pointermove", { x: 20, ctrlKey: true }).defaultPrevented,
    false,
  );
  ctx.pointer("pointerup", { ctrlKey: true });
  ctx.click(link, { ctrlKey: true });
  assert.equal(
    ctx.nativeClicks.length,
    1,
    "the modified click reaches the native navigation boundary",
  );
  assert.equal(ctx.navigation.length, 0);
  assert.equal(ctx.carousel.scrollLeft, 0);
  ctx.click(link, { detail: 0 });
  assert.equal(ctx.navigation.length, 1);
  const nativeDrag = new ctx.window.Event("dragstart", {
    bubbles: true,
    cancelable: true,
  });
  ctx.container.querySelector("img").dispatchEvent(nativeDrag);
  assert.equal(nativeDrag.defaultPrevented, true);
  await delay(0);
});

for (const reason of [
  "pointercancel",
  "lostpointercapture",
  "hidden",
  "blur",
  "unmount",
])
  test(`${reason} cancels owned dragging without blocking future product clicks`, async (t) => {
    const ctx = setup(t);
    ctx.pointer("pointerdown");
    ctx.pointer("pointermove", { x: 100 });
    assert.equal(ctx.captured.size, 1);
    if (reason === "hidden") {
      ctx.sizes.width = 0;
      ctx.resize();
    } else if (reason === "blur")
      ctx.window.dispatchEvent(new ctx.window.Event("blur"));
    else if (reason === "unmount") ctx.dispose();
    else ctx.carousel.dispatchEvent(new ctx.window.Event(reason));
    assert.equal(ctx.captured.size, 0);
    assert.equal(ctx.carousel.dataset.dragging, undefined);
    const left = ctx.carousel.scrollLeft;
    ctx.pointer("pointermove", { x: 0 });
    assert.equal(ctx.carousel.scrollLeft, left);
    if (reason === "unmount") assert.equal(ctx.observers[0].disconnected, true);
    else {
      ctx.click();
      assert.equal(ctx.navigation.length, 1);
    }
    await delay(0);
  });

test("a carousel with no overflow does not convert product clicks to drags", async (t) => {
  const ctx = setup(t, { content: 176 });
  assert.equal(ctx.button("Next"), null);
  ctx.pointer("pointerdown");
  ctx.pointer("pointermove", { x: 20 });
  ctx.pointer("pointerup");
  ctx.click();
  assert.equal(ctx.navigation.length, 1);
  assert.equal(ctx.captured.size, 0);
  await delay(0);
});

test("button scrolling stays smooth and missing ResizeObserver retains the resize fallback", (t) => {
  const ctx = setup(t, { reduced: true, observer: false });
  ctx.button("Next").click();
  assert.equal(ctx.scrolling[0].behavior, "smooth");
  ctx.sizes.width = 900;
  ctx.carousel.scrollLeft = 0;
  ctx.flush(() => ctx.resize());
  assert.equal(ctx.button("Next"), null);
});

test("leaving before the drag threshold retires the candidate while captured drags continue outside", async (t) => {
  const ctx = setup(t);
  ctx.pointer("pointerdown");
  ctx.pointer("pointermove", { x: 198 });
  ctx.carousel.dispatchEvent(new ctx.window.Event("pointerleave"));
  ctx.pointer("pointermove", { x: 20 });
  assert.equal(ctx.carousel.scrollLeft, 0);
  assert.equal(ctx.captured.size, 0);
  ctx.pointer("pointerup");
  ctx.click();
  assert.equal(ctx.navigation.length, 1);
  ctx.pointer("pointerdown");
  ctx.pointer("pointermove", { x: 100 });
  ctx.carousel.dispatchEvent(new ctx.window.Event("pointerleave"));
  ctx.pointer("pointermove", { x: 20 });
  assert.equal(ctx.carousel.scrollLeft, 180);
  ctx.pointer("pointerup");
  await delay(0);
});
