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
const firstImage = `${origin}/cdn/shop/files/first-listing.jpg?v=1`;
const firstSized = `${firstImage}&width=480`;
const secondImage = `${origin}/cdn/shop/files/second-listing.jpg?width=400&v=2`;

function setup(t, active = true) {
  const dom = new JSDOM("<!doctype html><roman-ai-assistant></roman-ai-assistant>", {
    url: origin,
    runScripts: "outside-only",
  });
  const { window } = dom;
  const failures = [];
  window.console.error = (...args) => failures.push(args);
  window.fetch = () => assert.fail("Catalogue card imagery must not fetch a product page");
  window.eval(`${bundle.outputFiles[0].text};window.RomanImageTest=RomanImageTest;`);
  const shadow = window.document.querySelector("roman-ai-assistant").attachShadow({ mode: "open" });
  const container = window.document.createElement("div");
  shadow.append(container);
  const view = window.RomanImageTest.mount(container);
  let props = { imageUrl: firstImage, active };
  const render = (updates = {}) => {
    props = { ...props, ...updates };
    view.render(props);
  };
  t.after(() => {
    view.dispose();
    window.close();
    assert.deepEqual(failures, []);
  });
  render();
  return { window, container, render, img: () => container.querySelector("img") };
}

async function settle() {
  await delay(10);
}

test("active carousel images request the original catalogue asset immediately without a product-page lookup", async (t) => {
  const ctx = setup(t);
  assert.equal(ctx.img().src, firstSized);
  assert.equal(ctx.img().getAttribute("loading"), "eager");
  assert.equal(ctx.img().getAttribute("decoding"), "async");
  assert.equal(ctx.img().style.visibility, "hidden");
  ctx.img().dispatchEvent(new ctx.window.Event("load"));
  await settle();
  assert.equal(ctx.img().style.visibility, "");
  ctx.render();
  assert.equal(ctx.img().src, firstSized);
});

test("inactive imagery stays cold until its carousel is eligible, and loaded images remain visible", async (t) => {
  const ctx = setup(t, false);
  assert.equal(ctx.img().getAttribute("src"), null);
  assert.equal(ctx.img().getAttribute("loading"), "lazy");
  ctx.render({ active: true });
  assert.equal(ctx.img().src, firstSized);
  ctx.render({ active: false });
  assert.equal(ctx.img().getAttribute("src"), null, "Unloaded offscreen image stops requesting");
  ctx.render({ active: true });
  ctx.img().dispatchEvent(new ctx.window.Event("load"));
  await settle();
  ctx.render({ active: false });
  assert.equal(ctx.img().src, firstSized);
  assert.equal(ctx.img().style.visibility, "");
});

test("changing catalogue sources hides the prior photo until the new image loads", async (t) => {
  const ctx = setup(t);
  ctx.img().dispatchEvent(new ctx.window.Event("load"));
  await settle();
  ctx.render({ imageUrl: secondImage });
  assert.equal(ctx.img().src, secondImage, "A smaller existing Shopify size is retained");
  assert.equal(ctx.img().style.visibility, "hidden");
  ctx.img().dispatchEvent(new ctx.window.Event("load"));
  await settle();
  assert.equal(ctx.img().style.visibility, "");
});

test("failed or missing catalogue imagery keeps neutral space without retrying or fetching a fallback PDP", async (t) => {
  const ctx = setup(t);
  ctx.img().dispatchEvent(new ctx.window.Event("error"));
  await settle();
  assert.equal(ctx.img().getAttribute("src"), null);
  assert.equal(ctx.img().style.visibility, "hidden");
  ctx.render({ active: false });
  ctx.render({ active: true });
  assert.equal(ctx.img().getAttribute("src"), null);
  ctx.render({ imageUrl: undefined });
  assert.equal(ctx.img().getAttribute("src"), null);
  ctx.render({ imageUrl: secondImage });
  assert.equal(ctx.img().src, secondImage, "A different valid asset remains usable");
});

test("card sizing caps Shopify transforms without inventing a different filename or transforming non-Shopify paths", (t) => {
  const ctx = setup(t);
  for (const [imageUrl, expected] of [
    [`${origin}/cdn/shop/files/room_r.webp?v=9&width=2000`, `${origin}/cdn/shop/files/room_r.webp?v=9&width=480`],
    ["https://cdn.shopify.com/s/files/1/23/files/room_r.jpg?v=8", "https://cdn.shopify.com/s/files/1/23/files/room_r.jpg?v=8&width=480"],
    [`${origin}/images/room.jpg?v=7`, `${origin}/images/room.jpg?v=7`],
    [`${origin}/images/room.jpg?width=2000`, `${origin}/images/room.jpg?width=2000`],
    [`${origin}/cdn/shop/files/room.jpg?signature=abc&width=2000`, `${origin}/cdn/shop/files/room.jpg?signature=abc&width=2000`],
  ]) {
    ctx.render({ imageUrl });
    assert.equal(ctx.img().src, expected);
  }
});
