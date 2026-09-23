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
      import { ProductCards } from './frontend/src/chat/ProductCards';
      export function mount(container, session) {
        const root = createRoot(container);
        const change = () => {};
        const choose = async () => {};
        return {
          render(rows) { flushSync(() => root.render(<ol>{rows.map((row, index) =>
            <li key={index}>
              <ProductCards {...row} carouselId={String(index)} session={session} onChoose={choose} onContentChange={change} />
            </li>)}</ol>)); },
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
  globalName: "CardsTest",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

async function until(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(message);
}

function ids(start = 1) {
  return Array.from(
    { length: 10 },
    (_, index) => `gid://shopify/Product/${start + index}`,
  );
}

function setup(t, rows) {
  const dom = new JSDOM(
    '<div data-roman-panel><div class="roman-chat-scroll"><div class="roman-chat-history"><div id="root"></div></div></div></div>',
    {
      url: "https://shop.example/",
      pretendToBeVisual: true,
      runScripts: "outside-only",
    },
  );
  const { window } = dom;
  const observers = [];
  const images = [];
  const catalogs = [];
  window.fetch = () => assert.fail("Cards use the owned display loaders");
  window.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(target) {
      this.target = target;
    }
    disconnect() {
      this.disconnected = true;
    }
    intersect(value) {
      this.callback([{ isIntersecting: value }]);
    }
  };
  const session = {
    getCachedProducts: () => [],
    loadProducts: async (selected, signal) => {
      catalogs.push({ selected, signal });
      return {
        products: selected.map((id) => {
          const number = id.split("/").at(-1);
          return {
            id,
            title: `Blind ${number}`,
            description: "",
            url: `https://shop.example/products/blind-${number}`,
            imageUrl: `https://shop.example/cdn/shop/files/swatch-${number}.jpg`,
          };
        }),
        messages: [],
      };
    },
    loadProductImage: (url, signal) =>
      new Promise((resolve, reject) => {
        const call = {
          url,
          signal,
          done: false,
          resolve: () => {
            call.done = true;
            resolve(
              `https://shop.example/cdn/shop/files/${url.split("/").at(-1)}.jpg`,
            );
          },
        };
        images.push(call);
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  };
  window.eval(`${bundle.outputFiles[0].text};window.CardsTest=CardsTest;`);
  const root = window.document.querySelector("#root");
  const view = window.CardsTest.mount(root, session);
  view.render(rows);
  t.after(() => {
    view.dispose();
    window.close();
  });
  return {
    ...view,
    window,
    root,
    observers,
    images,
    catalogs,
    chat: window.document.querySelector(".roman-chat-history"),
    shell: window.document.querySelector("[data-roman-panel]"),
    outstanding: () =>
      images.filter((call) => !call.done && !call.signal.aborted),
  };
}

test("nearby carousels warm every horizontal image through two metadata slots each", async (t) => {
  const ctx = setup(t, [{ productIds: ids() }, { productIds: ids(11) }]);
  await delay(15);
  assert.equal(ctx.catalogs.length, 0, "Distant history stays cold");
  assert.equal(
    ctx.observers.length,
    2,
    "One viewport observer per carousel, none per image",
  );
  ctx.observers.forEach((observer) => observer.intersect(true));
  await until(
    () => ctx.images.length === 4,
    "Each carousel starts only two metadata lookups",
  );
  for (let index = 0; index < 20; index++) {
    await until(
      () => ctx.images[index],
      "Next offscreen image was not admitted",
    );
    assert.ok(
      ctx.outstanding().length <= 4,
      "Two ten-card rows leave room for foreground tools and the active gallery",
    );
    ctx.images[index].resolve();
  }
  await until(
    () =>
      [...ctx.root.querySelectorAll("img")].every((image) =>
        image.hasAttribute("src"),
      ),
    "All ten images per row preload without horizontal scrolling or native load events",
  );
  assert.equal(ctx.images.length, 20);
  assert.equal(ctx.root.querySelectorAll('img[loading="eager"]').length, 20);
  assert.ok(
    [...ctx.root.querySelectorAll("img")].every(
      (image) =>
        !image.src.includes("swatch") && image.style.visibility === "hidden",
    ),
  );
});

test("a fresh carousel preloads visibly without restarting image work", async (t) => {
  const row = { productIds: ids(), preload: true };
  const ctx = setup(t, [row]);
  assert.equal(
    ctx.observers.length,
    0,
    "Fresh cards preload without waiting for an intersection",
  );
  await until(
    () => ctx.images.length === 2,
    "Fresh cards start preloading while visible",
  );
  assert.equal(ctx.root.querySelector("button").closest("[hidden]"), null);
  assert.ok(
    [...ctx.root.querySelectorAll("button.roman-choose-blind")].every(
      (button) => !button.disabled,
    ),
  );
  ctx.render([{ ...row, preload: false }]);
  await delay(15);
  assert.equal(ctx.images.length, 2);
  assert.ok(
    ctx.images.every((call) => !call.signal.aborted),
    "Finishing text does not restart the metadata requests",
  );
  ctx.observers[0].intersect(true);
  assert.equal(ctx.root.querySelector("button").closest("[hidden]"), null);
  ctx.images[0].resolve();
  await until(
    () => ctx.images.length === 3,
    "Next offscreen card warms after metadata resolves",
  );
  assert.equal(ctx.catalogs.length, 1);
});

test("actual Chat or shell hiding aborts fresh lookups and does not admit more until visible", async (t) => {
  for (const area of ["chat", "shell", "document"]) {
    await t.test(area, async (t) => {
      const ctx = setup(t, [{ productIds: ids(), preload: true }]);
      await until(() => ctx.images.length === 2, "Initial image lookups start");
      const setHidden = (hidden) => {
        if (area !== "document") ctx[area].hidden = hidden;
        else {
          Object.defineProperty(ctx.window.document, "hidden", {
            configurable: true,
            value: hidden,
          });
          ctx.window.document.dispatchEvent(
            new ctx.window.Event("visibilitychange"),
          );
        }
      };
      setHidden(true);
      await until(
        () => ctx.images.every((call) => call.signal.aborted),
        "Hidden surface releases optional work",
      );
      ctx.images[0].resolve();
      await delay(15);
      assert.equal(ctx.images.length, 2);
      assert.equal(ctx.root.querySelector("img").getAttribute("src"), null);
      setHidden(false);
      await until(
        () => ctx.images.length === 4,
        "Returning surface resumes its two admission slots",
      );
      ctx.dispose();
      assert.ok(ctx.images.every((call) => call.signal.aborted));
      assert.ok(ctx.observers.every((observer) => observer.disconnected));
    });
  }
});
