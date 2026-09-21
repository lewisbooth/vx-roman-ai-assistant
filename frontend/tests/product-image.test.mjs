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
      import { ProductImage } from './frontend/src/chat/ProductImage';
      export function mount(container) {
        const root = createRoot(container);
        return {
          render(props) { flushSync(() => root.render(<ProductImage {...props} />)); },
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
  globalName: "RomanImageTest",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

const origin = "https://hd-dev-single.myshopify.com";
const firstProduct = `${origin}/products/first-blind`;
const firstFallback = `${origin}/cdn/shop/files/first-catalog.jpg`;
const firstResolved = `${origin}/cdn/shop/files/first-room.jpg`;
const secondProduct = `${origin}/products/second-blind`;
const secondFallback = `${origin}/cdn/shop/files/second-catalog.jpg`;
const secondResolved = `${origin}/cdn/shop/files/second-room.jpg`;

async function until(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(message);
}

function setup(t, { intersectionObserver = true, active = true } = {}) {
  const dom = new JSDOM(
    "<!doctype html><roman-ai-assistant></roman-ai-assistant>",
    {
      url: origin,
      runScripts: "outside-only",
    },
  );
  const { window } = dom;
  const observers = [];
  const calls = [];
  const failures = [];
  window.console.error = (...args) => failures.push(args);
  window.fetch = () =>
    assert.fail("ProductImage must use its owned loader, not fetch directly");
  if (intersectionObserver) {
    window.IntersectionObserver = class {
      constructor(callback, options) {
        this.callback = callback;
        this.options = options;
        this.disconnected = false;
        observers.push(this);
      }
      observe(target) {
        this.target = target;
      }
      disconnect() {
        this.disconnected = true;
      }
      intersect(isIntersecting) {
        this.callback([{ target: this.target, isIntersecting }]);
      }
    };
  }
  window.eval(
    `${bundle.outputFiles[0].text};window.RomanImageTest=RomanImageTest;`,
  );
  const shadow = window.document
    .querySelector("roman-ai-assistant")
    .attachShadow({ mode: "open" });
  const carousel = window.document.createElement("div");
  carousel.className = "roman-product-scroll";
  const container = window.document.createElement("div");
  carousel.append(container);
  shadow.append(carousel);
  const view = window.RomanImageTest.mount(container);
  let mounted = true;
  let props = {
    productUrl: firstProduct,
    fallback: firstFallback,
    active,
    session: {
      loadProductImage: (url, signal) =>
        new Promise((resolve, reject) => {
          calls.push({ url, signal, resolve, reject });
        }),
    },
  };
  const render = (updates = {}) => {
    props = { ...props, ...updates };
    view.render(props);
  };
  const dispose = () => {
    if (!mounted) return;
    mounted = false;
    view.dispose();
  };
  t.after(() => {
    dispose();
    window.close();
    assert.deepEqual(failures, []);
  });
  render();
  return {
    window,
    container,
    carousel,
    calls,
    observers,
    render,
    dispose,
    img: () => container.querySelector("img"),
  };
}

test("neutral image space remains while viewport gates defer the main-image lookup", async (t) => {
  const ctx = setup(t, { active: false });
  assert.equal(ctx.img().getAttribute("src"), null);
  assert.equal(ctx.img().style.visibility, "hidden");
  assert.equal(ctx.img().getAttribute("loading"), "lazy");
  assert.equal(ctx.observers.length, 1);
  assert.equal(ctx.observers[0].options.root, ctx.carousel);
  assert.equal(ctx.observers[0].options.rootMargin, "0px 80px");
  assert.equal(ctx.observers[0].target, ctx.img());
  await delay(0);
  assert.equal(ctx.calls.length, 0);
  ctx.observers[0].intersect(true);
  await delay(10);
  assert.equal(
    ctx.calls.length,
    0,
    "horizontal visibility alone must not load a distant carousel",
  );
  ctx.observers[0].intersect(false);
  await delay(10);
  ctx.render({ active: true });
  await delay(0);
  assert.equal(
    ctx.calls.length,
    0,
    "an active carousel must not load its distant horizontal cards",
  );
  ctx.observers[0].intersect(true);
  await until(() => ctx.calls.length === 1, "Visible image was not requested");
  assert.equal(ctx.calls[0].url, firstProduct);
  assert.equal(ctx.calls[0].signal.aborted, false);
  assert.equal(
    ctx.img().getAttribute("src"),
    null,
    "pending lookup must not briefly display a different catalog image",
  );
});

test("only the resolved main photo paints, after it loads, without a catalog preview", async (t) => {
  const ctx = setup(t);
  ctx.observers[0].intersect(true);
  await until(() => ctx.calls.length === 1, "Image lookup did not start");
  assert.equal(ctx.img().getAttribute("src"), null);
  ctx.calls[0].resolve(firstResolved);
  await until(
    () => ctx.img().src === firstResolved,
    "Main photo not requested",
  );
  assert.equal(ctx.img().style.visibility, "hidden");
  ctx.img().dispatchEvent(new ctx.window.Event("load"));
  await until(
    () => ctx.img().style.visibility === "",
    "Loaded image not revealed",
  );
  ctx.render();
  assert.equal(ctx.img().src, firstResolved);
  assert.equal(ctx.calls.length, 1);
});

test("a failed main photo uses the catalog fallback once without an automatic request loop", async (t) => {
  const ctx = setup(t);
  ctx.observers[0].intersect(true);
  await until(() => ctx.calls.length === 1, "Image lookup did not start");
  ctx.calls[0].resolve(firstResolved);
  await until(
    () => ctx.img().src === firstResolved,
    "Verified image did not load",
  );
  ctx.img().dispatchEvent(new ctx.window.Event("error"));
  await until(
    () => ctx.img().src === firstFallback,
    "Failed image did not restore fallback",
  );
  assert.equal(ctx.img().style.visibility, "hidden");
  ctx.img().dispatchEvent(new ctx.window.Event("load"));
  await until(() => ctx.img().style.visibility === "", "Fallback not revealed");
  ctx.render();
  ctx.observers[0].intersect(false);
  await delay(10);
  ctx.observers[0].intersect(true);
  await delay(10);
  assert.equal(
    ctx.calls.length,
    1,
    "a failed resolved image must not cause an automatic request loop",
  );
  assert.equal(ctx.img().src, firstFallback);
});

test("missing or rejected optional image results leave the catalog image usable", async (t) => {
  for (const outcome of ["missing", "rejected"])
    await t.test(outcome, async (t) => {
      const ctx = setup(t);
      ctx.observers[0].intersect(true);
      await until(() => ctx.calls.length === 1, "Image lookup did not start");
      if (outcome === "missing") ctx.calls[0].resolve(undefined);
      else ctx.calls[0].reject(new ctx.window.Error("Page image unavailable"));
      await delay(10);
      assert.equal(ctx.img().src, firstFallback);
      ctx.render();
      ctx.observers[0].intersect(false);
      await delay(10);
      ctx.observers[0].intersect(true);
      await delay(10);
      assert.equal(ctx.calls.length, 1);
    });
});

test("leaving either viewport aborts pending lookup and ignores its late result", async (t) => {
  for (const gate of ["horizontal", "carousel"])
    await t.test(gate, async (t) => {
      const ctx = setup(t);
      ctx.observers[0].intersect(true);
      await until(() => ctx.calls.length === 1, "Image lookup did not start");
      if (gate === "horizontal") ctx.observers[0].intersect(false);
      else ctx.render({ active: false });
      await until(
        () => ctx.calls[0].signal.aborted,
        "Offscreen lookup was not cancelled",
      );
      ctx.calls[0].resolve(firstResolved);
      await delay(10);
      assert.equal(ctx.img().getAttribute("src"), null);
      if (gate === "horizontal") ctx.observers[0].intersect(true);
      else ctx.render({ active: true });
      await until(
        () => ctx.calls.length === 2,
        "Returning image did not receive a fresh owned request",
      );
      ctx.calls[1].resolve(firstResolved);
      await until(
        () => ctx.img().src === firstResolved,
        "Returning image did not resolve",
      );
    });
});

test("unmount disconnects horizontal observation and aborts pending image work", async (t) => {
  const ctx = setup(t);
  ctx.observers[0].intersect(true);
  await until(() => ctx.calls.length === 1, "Image lookup did not start");
  ctx.dispose();
  assert.equal(ctx.observers[0].disconnected, true);
  assert.equal(ctx.calls[0].signal.aborted, true);
  ctx.calls[0].resolve(firstResolved);
  await delay(10);
  assert.equal(ctx.container.childElementCount, 0);
});

test("a late old-product lookup cannot overwrite a newly rendered product image", async (t) => {
  const ctx = setup(t);
  ctx.observers[0].intersect(true);
  await until(() => ctx.calls.length === 1, "First image lookup did not start");
  ctx.render({ productUrl: secondProduct, fallback: secondFallback });
  assert.equal(ctx.img().getAttribute("src"), null);
  assert.equal(ctx.calls[0].signal.aborted, true);
  await until(
    () => ctx.calls.length === 2,
    "Replacement product did not start its lookup",
  );
  assert.equal(ctx.calls[1].url, secondProduct);
  ctx.calls[1].resolve(secondResolved);
  await until(
    () => ctx.img().src === secondResolved,
    "Replacement image did not resolve",
  );
  ctx.calls[0].resolve(firstResolved);
  await delay(10);
  assert.equal(ctx.img().src, secondResolved);
});

test("changing products hides the previous photo until the new main image loads", async (t) => {
  const ctx = setup(t, { intersectionObserver: false });
  await until(() => ctx.calls.length === 1, "First lookup did not start");
  ctx.calls[0].resolve(firstResolved);
  await until(
    () => ctx.img().src === firstResolved,
    "First image not requested",
  );
  ctx.img().dispatchEvent(new ctx.window.Event("load"));
  await until(() => ctx.img().style.visibility === "", "First photo not shown");
  ctx.render({ productUrl: secondProduct, fallback: secondFallback });
  assert.equal(ctx.img().getAttribute("src"), null);
  assert.equal(ctx.img().style.visibility, "hidden");
  await until(() => ctx.calls.length === 2, "Second lookup did not start");
  ctx.calls[1].resolve(secondResolved);
  await until(
    () => ctx.img().src === secondResolved,
    "Second image not requested",
  );
  assert.equal(ctx.img().style.visibility, "hidden");
  ctx.img().dispatchEvent(new ctx.window.Event("load"));
  await until(
    () => ctx.img().style.visibility === "",
    "Second photo not shown",
  );
});

test("unavailable main and catalog images leave neutral space rather than a broken image", async (t) => {
  const ctx = setup(t, { intersectionObserver: false });
  await until(() => ctx.calls.length === 1, "Image lookup did not start");
  ctx.calls[0].resolve(undefined);
  await until(() => ctx.img().src === firstFallback, "Fallback not requested");
  ctx.img().dispatchEvent(new ctx.window.Event("error"));
  await delay(10);
  assert.equal(ctx.img().style.visibility, "hidden");
  assert.equal(ctx.calls.length, 1);
});

test("browsers without IntersectionObserver load only when the carousel becomes active", async (t) => {
  const ctx = setup(t, { intersectionObserver: false, active: false });
  await delay(0);
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.img().getAttribute("src"), null);
  ctx.render({ active: true });
  await until(
    () => ctx.calls.length === 1,
    "Active fallback-browser image did not load",
  );
  ctx.calls[0].resolve(firstResolved);
  await until(
    () => ctx.img().src === firstResolved,
    "Fallback-browser image did not resolve",
  );
});
