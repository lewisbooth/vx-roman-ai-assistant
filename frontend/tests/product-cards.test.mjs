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
  return Array.from({ length: 10 }, (_, index) => `gid://shopify/Product/${start + index}`);
}

function setup(t, rows) {
  const dom = new JSDOM(
    '<div data-roman-panel><div class="roman-chat-scroll"><div class="roman-chat-history"><div id="root"></div></div></div></div>',
    { url: "https://shop.example/", pretendToBeVisual: true, runScripts: "outside-only" },
  );
  const { window } = dom;
  const observers = [];
  const catalogs = [];
  window.fetch = () => assert.fail("Cards must not fetch product pages to discover image URLs");
  window.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
    intersect(value) { this.callback([{ isIntersecting: value }]); }
  };
  const session = {
    getCachedProducts: () => [],
    loadProducts: async (selected, signal) => {
      catalogs.push({ selected, signal });
      return {
        products: selected.map((id) => {
          const number = id.split("/").at(-1);
          return {
            id, title: `Blind ${number}`, description: "",
            url: `https://shop.example/products/blind-${number}`,
            imageUrl: `https://shop.example/cdn/shop/files/listing-${number}.jpg`,
          };
        }),
        messages: [],
      };
    },
  };
  window.eval(`${bundle.outputFiles[0].text};window.CardsTest=CardsTest;`);
  const root = window.document.querySelector("#root");
  const view = window.CardsTest.mount(root, session);
  view.render(rows);
  t.after(() => { view.dispose(); window.close(); });
  return {
    ...view, window, root, observers, catalogs,
    chat: window.document.querySelector(".roman-chat-history"),
    shell: window.document.querySelector("[data-roman-panel]"),
  };
}

test("nearby carousels request every original catalogue image without a second metadata lookup", async (t) => {
  const ctx = setup(t, [{ productIds: ids() }, { productIds: ids(11) }]);
  await delay(15);
  assert.equal(ctx.catalogs.length, 0, "Distant history stays cold");
  assert.equal(ctx.observers.length, 2, "Only the carousel owns viewport gating");
  ctx.observers.forEach((observer) => observer.intersect(true));
  await until(() => ctx.root.querySelectorAll('img[src]').length === 20, "All catalogue sources start together");
  assert.equal(ctx.catalogs.length, 2);
  assert.equal(ctx.root.querySelectorAll('img[loading="eager"]').length, 20);
  assert.ok([...ctx.root.querySelectorAll("img")].every((image) =>
    image.src.includes("/listing-") && image.src.endsWith("?width=480") && image.style.visibility === "hidden"));
});

test("fresh cards load directly while reply text reveals and retain their loaded sources afterward", async (t) => {
  const row = { productIds: ids(), preload: true };
  const ctx = setup(t, [row]);
  assert.equal(ctx.observers.length, 0);
  await until(() => ctx.root.querySelectorAll('img[src]').length === 10, "Fresh cards load without intersection delay");
  assert.ok([...ctx.root.querySelectorAll("button.roman-choose-blind")].every((button) => !button.disabled));
  const images = [...ctx.root.querySelectorAll("img")];
  const urls = images.map((image) => image.src);
  images.forEach((image) => image.dispatchEvent(new ctx.window.Event("load")));
  await delay(15);
  ctx.render([{ ...row, preload: false }]);
  ctx.observers[0].intersect(true);
  await delay(15);
  assert.deepEqual([...ctx.root.querySelectorAll("img")].map((image) => image.src), urls);
  assert.equal(ctx.catalogs.length, 1, "Finishing text does not rehydrate the products");
});

test("hiding Chat, the shell or document stops unfinished image loads until visible", async (t) => {
  for (const area of ["chat", "shell", "document"]) {
    await t.test(area, async (t) => {
      const ctx = setup(t, [{ productIds: ids(), preload: true }]);
      await until(() => ctx.root.querySelectorAll('img[src]').length === 10, "Initial image sources start");
      const setHidden = (hidden) => {
        if (area !== "document") ctx[area].hidden = hidden;
        else {
          Object.defineProperty(ctx.window.document, "hidden", { configurable: true, value: hidden });
          ctx.window.document.dispatchEvent(new ctx.window.Event("visibilitychange"));
        }
      };
      setHidden(true);
      await until(() => ctx.root.querySelectorAll('img[src]').length === 0, "Hidden surface removes unfinished sources");
      setHidden(false);
      await until(() => ctx.root.querySelectorAll('img[src]').length === 10, "Returning surface restores sources");
      assert.equal(ctx.catalogs.length, 1);
      ctx.dispose();
      assert.ok(ctx.observers.every((observer) => observer.disconnected));
    });
  }
});
