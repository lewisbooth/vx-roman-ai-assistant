import assert from "node:assert/strict";
import { cwd } from "node:process";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents:
      "export * from './frontend/src/tools/product-image'; export * from './frontend/src/tools/product-references'; export {createStorefrontExecutor} from './frontend/src/session/storefront-executor';",
    resolveDir: cwd(),
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
});
const origin = "https://store.example";
const page = `${origin}/products/shade`;
const sourceMain = `${origin}/cdn/shop/files/room.webp?v=12&width=1600`;
const main = `${origin}/cdn/shop/files/room.webp?v=12&width=480`;
const swatch = `${origin}/cdn/shop/files/swatch.webp?v=1`;
const gallery = (src = sourceMain) =>
  `<swiper-with-media data-main-product-media-gallery><swiper-container id="MediaGallery-template-main-swiper-initial"><swiper-slide><img data-feature-option-slide-image src=""></swiper-slide><swiper-slide><img data-testid="pdp-product-image-main" src="${src}"></swiper-slide><swiper-slide><img data-testid="pdp-product-image-main" src="${swatch}"></swiper-slide></swiper-container></swiper-with-media>`;
const html = (url = page, contents = gallery()) =>
  `<!doctype html><html><head><link rel="canonical" href="${url}"></head><body><app-provider><main id="main"><img src="${swatch}"><swiper-container id="gallery-main-swiper-zoom"><img src="${swatch}" data-testid="pdp-product-image-main"></swiper-container>${contents}</main></app-provider></body></html>`;
const response = (body = html(), options = {}) =>
  new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
    ...options,
  });

async function until(predicate, message = "Work did not start") {
  for (let n = 0; n < 50; n++) {
    if (predicate()) return;
    await setImmediate();
  }
  assert.fail(message);
}

function setup(
  t,
  fetcher = async () => response(),
  initial = "<!doctype html>",
  url = `${origin}/`,
) {
  const dom = new JSDOM(initial, { url, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const calls = [],
    timers = new Map(),
    clock = { now: Date.now() };
  let timerId = 0;
  dom.window.setTimeout = (callback, delay) => {
    timers.set(++timerId, { callback, delay });
    return timerId;
  };
  dom.window.clearTimeout = (id) => timers.delete(id);
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    window: dom.window,
    document: dom.window.document,
    URL,
    Intl,
    AbortController,
    DOMException,
    TextDecoder,
    TextEncoder,
    Date: class extends Date {
      static now() {
        return clock.now;
      }
    },
    fetch: (...args) => {
      calls.push(args);
      return fetcher(...args);
    },
    console,
  });
  return {
    ...module.exports,
    window: dom.window,
    calls,
    timers,
    clock,
    async loadImage(url, signal, maxWidth = 480) {
      const gallery = await module.exports.loadProductPageGallery(url, signal);
      const image = gallery?.items.find((item) => item.kind === "product");
      return image && module.exports.productImageWidth(image.src, maxWidth);
    },
  };
}

test("the actual HD gallery structure selects its first main PDP image, not swatch, zoom or later media", async (t) => {
  const ctx = setup(t, async () =>
    response(html(page, `${gallery()}${gallery()}`)),
  );
  assert.equal(await ctx.loadImage(page, new AbortController().signal), main);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0][0], page);
  const options = ctx.calls[0][1];
  assert.equal(options.credentials, "same-origin");
  assert.equal(options.redirect, "error");
  assert.equal(options.cache, "no-store");
  assert.equal(ctx.timers.size, 0);
});

test("the matching current PDP is reused, including collection-scoped paths, without fetching", async (t) => {
  const ctx = setup(
    t,
    () => assert.fail("Current product must not fetch"),
    html(),
    `${origin}/collections/roman/products/shade`,
  );
  assert.equal(await ctx.loadImage(page, new AbortController().signal), main);
  assert.equal(ctx.calls.length, 0);
});

test("the existing Shopify width transform is capped without changing asset identity or other parameters", async (t) => {
  for (const [query, expected] of [
    ["v=12&width=1600&height=300", "v=12&width=480&height=300"],
    ["v=12&width=240", "v=12&width=240"],
    ["v=12", "v=12"],
  ]) {
    const src = `${origin}/cdn/shop/files/room.webp?${query}`;
    const ctx = setup(t, async () => response(html(page, gallery(src))));
    assert.equal(
      await ctx.loadImage(page, new AbortController().signal),
      `${origin}/cdn/shop/files/room.webp?${expected}`,
    );
  }
});

test("fetched content remains inert and remote base tags cannot redirect image selection", async (t) => {
  const ctx = setup(t, async () =>
    response(
      html(
        page,
        `<base href="https://other.example/"><script>window.executed=true</script><remote-element></remote-element>${gallery("/cdn/shop/files/room.webp")}`,
      ),
    ),
  );
  let connected = 0;
  ctx.window.customElements.define(
    "remote-element",
    class extends ctx.window.HTMLElement {
      constructor() {
        super();
        connected++;
      }
    },
  );
  assert.equal(
    await ctx.loadImage(page, new AbortController().signal),
    `${origin}/cdn/shop/files/room.webp`,
  );
  assert.equal(connected, 0);
  assert.equal(ctx.window.executed, undefined);
  assert.equal(ctx.window.document.querySelector("remote-element"), null);
});

test("unsupported markup, wrong canonical pages and unsafe images leave the catalog fallback untouched", async (t) => {
  for (const [name, body] of [
    [
      "missing gallery",
      html(page, `<img src="${main}" data-testid="pdp-product-image-main">`),
    ],
    [
      "conflicting galleries",
      html(page, gallery() + gallery(`${origin}/cdn/shop/files/other.webp`)),
    ],
    ["wrong product", html(`${origin}/products/other`)],
    ["missing canonical", html().replace(/<link[^>]+>/, "")],
    ...[
      "https://other.example/room.webp",
      "https://user:secret@cdn.shopify.com/s/files/room.webp",
      `${origin}/cart/clear`,
      `${origin}/account/logout`,
      "https://cdn.shopify.com/cart/clear",
      "http://cdn.shopify.com/s/files/room.webp",
    ].map((src) => [src, html(page, gallery(src))]),
  ])
    await t.test(name, async (t) => {
      const ctx = setup(t, async () => response(body));
      assert.equal(
        await ctx.loadImage(page, new AbortController().signal),
        undefined,
      );
    });
});

test("invalid product destinations are rejected before any request", async (t) => {
  const ctx = setup(t, () => assert.fail("Invalid destination fetched"));
  for (const url of [
    "https://other.example/products/shade",
    `${origin}/cart`,
    `${page}?variant=1`,
    `${page}#details`,
    `https://user:secret@store.example/products/shade`,
    `${origin}/products/../cart`,
    "javascript:alert(1)",
  ])
    await assert.rejects(ctx.loadImage(url, new AbortController().signal));
  assert.equal(ctx.calls.length, 0);
});

test("HTTP failures, non-HTML, oversized pages and a timed-out read fall back without retry", async (t) => {
  for (const [name, makeResponse] of [
    ["HTTP", () => response("Unavailable", { status: 503 })],
    [
      "MIME",
      () => response("{}", { headers: { "Content-Type": "application/json" } }),
    ],
    [
      "declared oversize",
      () =>
        response(html(), {
          headers: {
            "Content-Type": "text/html",
            "Content-Length": String(2 * 1024 * 1024 + 1),
          },
        }),
    ],
    ["stream oversize", () => response("x".repeat(2 * 1024 * 1024 + 1))],
  ])
    await t.test(name, async (t) => {
      const ctx = setup(t, async () => makeResponse());
      assert.equal(
        await ctx.loadImage(page, new AbortController().signal),
        undefined,
      );
      assert.equal(ctx.calls.length, 1);
      assert.equal(ctx.timers.size, 0);
    });
  await t.test("deadline", async (t) => {
    const ctx = setup(
      t,
      (_url, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
    );
    const loading = ctx.loadImage(page, new AbortController().signal);
    const timer = [...ctx.timers.values()][0];
    assert.equal(timer.delay, 5000);
    timer.callback();
    assert.equal(await loading, undefined);
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.timers.size, 0);
  });
});

test("caller cancellation propagates and removes request resources", async (t) => {
  const ctx = setup(
    t,
    (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
  );
  const controller = new AbortController();
  const loading = ctx.loadImage(page, controller.signal);
  controller.abort(new Error("Card left the viewport"));
  await assert.rejects(loading, /left the viewport/);
  assert.equal(ctx.calls[0][1].signal.aborted, true);
  assert.equal(ctx.timers.size, 0);
});

test("image reads yield to both model tools and uncached card hydration, then resume safely", async (t) => {
  for (const kind of ["foreground", "display"])
    await t.test(kind, async (t) => {
      let first = true;
      const order = [];
      const ctx = setup(t, async (_url, { signal }) => {
        order.push("image");
        if (first) {
          first = false;
          return new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        }
        return response();
      });
      const executor = ctx.createStorefrontExecutor({
        execute: async () => {
          order.push(kind);
          return { products: [], messages: [], queries: [{query:"shade",status:"succeeded",productIds:[]}] };
        },
      });
      t.after(() => executor.dispose());
      const image = executor.loadProductImage(
        page,
        new AbortController().signal,
      );
      await until(() => ctx.calls.length === 1);
      const important =
        kind === "foreground"
          ? executor.execute("search_products", { queries: ["shade"] })
          : executor.loadProducts(["gid://shopify/Product/123"]);
      await important;
      assert.equal(ctx.calls[0][1].signal.aborted, true);
      assert.equal(await image, main);
      assert.deepEqual(order, ["image", kind, "image"]);
    });
});

test("image cache deduplicates concurrent requests, expires at60s and retains at most60 entries", async (t) => {
  const ctx = setup(t, async (url) => response(html(url)));
  const executor = ctx.createStorefrontExecutor({
    execute: () => assert.fail("Image read used catalog"),
  });
  t.after(() => executor.dispose());
  const signal = new AbortController().signal;
  assert.deepEqual(
    await Promise.all([
      executor.loadProductImage(page, signal),
      executor.loadProductImage(page, signal),
    ]),
    [main, main],
  );
  assert.equal(ctx.calls.length, 1);
  ctx.clock.now += 59_999;
  await executor.loadProductImage(page, signal);
  assert.equal(ctx.calls.length, 1);
  ctx.clock.now++;
  await executor.loadProductImage(page, signal);
  assert.equal(ctx.calls.length, 2);
  for (let n = 0; n < 60; n++)
    await executor.loadProductImage(`${origin}/products/shade-${n}`, signal);
  assert.equal(ctx.calls.length, 62);
  await executor.loadProductImage(page, signal);
  assert.equal(ctx.calls.length, 63);
});

test("unavailable images are cached briefly; cancelled and disposed reads never complete or restart", async (t) => {
  const ctx = setup(t, async () => response("No supported gallery"));
  const executor = ctx.createStorefrontExecutor({
    execute: () => assert.fail("Image read used catalog"),
  });
  const signal = new AbortController().signal;
  assert.equal(await executor.loadProductImage(page, signal), undefined);
  assert.equal(await executor.loadProductImage(page, signal), undefined);
  assert.equal(ctx.calls.length, 1);
  executor.dispose();
  await assert.rejects(executor.loadProductImage(page, signal), /removed/);
  const pending = setup(
    t,
    (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
  );
  const other = pending.createStorefrontExecutor({
    execute: async () => ({ products: [] }),
  });
  const active = other.loadProductImage(page, signal);
  const queued = other.loadProductImage(`${origin}/products/next`, signal);
  const rejected = Promise.all([
    assert.rejects(active),
    assert.rejects(queued),
  ]);
  await until(() => pending.calls.length === 1);
  other.dispose();
  await rejected;
  assert.equal(pending.calls.length, 1);
  assert.equal(pending.calls[0][1].signal.aborted, true);
});

test("active-product recovery and carousel sizing reuse one gallery metadata request", async (t) => {
  const ctx = setup(t);
  const executor = ctx.createStorefrontExecutor({
    execute: () => assert.fail("Image recovery must not request catalog"),
  });
  t.after(() => executor.dispose());
  const signal = new AbortController().signal;
  assert.equal(await executor.loadProductImage(page, signal), main);
  assert.equal(
    await executor.loadProductImage(page, signal, 1200),
    `${origin}/cdn/shop/files/room.webp?v=12&width=1200`,
  );
  assert.equal(
    await executor.loadProductImage(page, signal, 1200),
    `${origin}/cdn/shop/files/room.webp?v=12&width=1200`,
  );
  assert.equal(await executor.loadProductImage(page, signal), main);
  assert.equal((await executor.loadProductGallery(page, signal)).items.length, 2);
  assert.equal(ctx.calls.length, 1);
});

test("missing PDP imagery falls back only to the matching fresh normalized Shopify catalog image", async (t) => {
  const ctx = setup(t, async () =>
    response("Unavailable PDP", { status: 404 }),
  );
  let catalogReads = 0;
  const catalogImage = `${origin}/cdn/shop/files/catalog-main.webp`;
  const executor = ctx.createStorefrontExecutor({
    execute: async () => {
      catalogReads++;
      return {
        products: [
          {
            id: "gid://shopify/Product/123",
            title: "Shopify blind",
            url: page,
            description: "",
            imageUrl: catalogImage,
          },
        ],
        messages: [], queries: [{query:"shade",status:"succeeded",productIds:["gid://shopify/Product/123"]}],
      };
    },
  });
  t.after(() => executor.dispose());
  const signal = new AbortController().signal;
  await executor.execute("search_products", { queries: ["shade"] });
  assert.equal(
    await executor.loadProductImage(page, signal, 1200),
    catalogImage,
  );
  assert.equal(
    await executor.loadProductImage(page, signal, 1200),
    catalogImage,
  );
  assert.equal(
    catalogReads,
    1,
    "No additional catalog lookup for display fallback",
  );
  assert.equal(ctx.calls.length, 1);
  assert.equal(
    await executor.loadProductImage(`${origin}/products/other`, signal, 1200),
    undefined,
  );
  ctx.clock.now += 60_000;
  assert.equal(
    await executor.loadProductImage(page, signal, 1200),
    undefined,
    "Expired catalog entries do not become authority for a restored choice",
  );
});

test("PDP gallery imagery stays preferred over the listing image when both are available", async (t) => {
  const ctx = setup(t);
  const executor = ctx.createStorefrontExecutor({
    execute: async () => ({
      products: [
        {
          id: "gid://shopify/Product/123",
          title: "Shopify blind",
          url: page,
          description: "",
          imageUrl: swatch,
        },
      ],
      messages: [], queries: [{query:"shade",status:"succeeded",productIds:["gid://shopify/Product/123"]}],
    }),
  });
  t.after(() => executor.dispose());
  await executor.execute("search_products", { queries: ["shade"] });
  assert.equal(
    await executor.loadProductImage(page, new AbortController().signal, 1200),
    `${origin}/cdn/shop/files/room.webp?v=12&width=1200`,
  );
});

test("gallery preserves native order and thumbnail/zoom assets, deduplicating responsive copies", async (t) => {
  const ctx = setup(t, async () => response(html(page, `
    <main-product update-url="true" product-url="/products/shade">
      ${gallery()}${gallery()}
      <swiper-container id="MediaGallery-template-thumbs-swiper-initial"><img src="${sourceMain.replace('width=1600', 'width=90')}"></swiper-container>
      <swiper-container id="MediaGallery-template-main-swiper-zoom"><img src="${sourceMain.replace('width=1600', 'width=1800')}"></swiper-container>
      <main-product product-url="/products/other">${gallery(`${origin}/cdn/shop/files/other.webp`)}</main-product>
    </main-product>`)));
  const result = await ctx.loadProductPageGallery(page, new AbortController().signal);
  assert.equal(result.productPath, '/products/shade');
  assert.equal(result.items.length, 2);
  const [first, second] = result.items;
  assert.equal(first.src, sourceMain.replace('width=1600', 'width=1200'));
  assert.equal(first.thumbnailSrc, sourceMain.replace('width=1600', 'width=90'));
  assert.equal(first.zoomSrc, sourceMain.replace('width=1600', 'width=1800'));
  assert.equal(first.kind, 'product');
  assert.equal(second.src, swatch);
  assert.equal(ctx.calls.length, 1, 'Media URLs are extracted without fetching images');
});

test("only the matching primary product can supply gallery media", async (t) => {
  const ctx = setup(t, async () => response(html(page,
    `<main-product update-url="true" product-url="/products/other">${gallery()}</main-product>`)));
  assert.equal(await ctx.loadProductPageGallery(page, new AbortController().signal), undefined);
});

test("native feature imagery updates only when enabled and never enters the shared static cache", async (t) => {
  const feature = `${origin}/cdn/shop/files/motor.jpg?v=3&width=1500`;
  const markup = html(page, gallery().replace(
    '<swiper-slide><img data-feature-option-slide-image src=""></swiper-slide>',
    `<swiper-slide data-feature-option-slide-holder class="hidden"><img data-feature-option-slide-image src="${feature}"></swiper-slide>`));
  const ctx = setup(t, () => assert.fail('Current PDP must not fetch'), markup, page);
  const read = () => ctx.readProductGallery(ctx.window.document, page);
  assert.equal(read().items.length, 2, 'A hidden native feature must not appear');
  const holder = ctx.window.document.querySelector('[data-feature-option-slide-holder]');
  holder.classList.remove('hidden');
  assert.equal(read().items[0].kind, 'feature');
  assert.equal(read().items[0].src, feature.replace('1500', '1200'));
  const executor = ctx.createStorefrontExecutor({execute: () => assert.fail('No catalog call')});
  t.after(() => executor.dispose());
  const signal = new AbortController().signal;
  assert.equal((await executor.loadProductGallery(page, signal)).items.length, 3);
  ctx.window.history.replaceState(null, '', '/cart');
  ctx.window.document.body.innerHTML = '';
  const restored = await executor.loadProductGallery(page, signal);
  assert.equal(restored.items.length, 2, 'Path-only cache contains no configuration-specific image');
  assert.equal(restored.items.every(item => item.kind === 'product'), true);
});

test("simultaneous thumbnail and active gallery requests share one fetched snapshot", async (t) => {
  const ctx = setup(t);
  const executor = ctx.createStorefrontExecutor({execute: () => assert.fail('No catalog call')});
  t.after(() => executor.dispose());
  const signal = new AbortController().signal;
  const [image, result] = await Promise.all([
    executor.loadProductImage(page, signal),
    executor.loadProductGallery(page, signal),
  ]);
  assert.equal(image, main);
  assert.equal(result.items.length, 2);
  assert.equal(ctx.calls.length, 1);
});

test("visualization image roles use inspected Shopify labels rather than generic room or fabric words", (t) => {
  const ctx = setup(t);
  for (const [file, alt, role] of [
    ["Product2600_Color2092_Zoom.jpg", "", "unknown"],
    ["blind_Z.jpg", "Room fabric close-up", "unknown"],
    ["blind.jpg", "Colorized", "installation"],
    ["blind.jpg", " ColorizedRoomAngle view ", "installation"],
    ["blind.jpg", "ColorizedFullRoom", "installation"],
    ["blind.jpg", "ColorizedFabricZoom cloth", "detail"],
    ["blind.jpg", "ColorizedPLA sample", "detail"],
    ["blind_FR.jpg", "", "installation"],
    ["blind_RoomAngle_1.jpg", "", "installation"],
    ["PID-123_CID-456_R.jpg", "", "installation"],
    ["blind_FZ.jpg", "", "detail"],
    ["blind_FabricZoom_2.jpg", "", "detail"],
    ["blind_FR.jpg", "ColorizedFabricZoom", "unknown"],
    ["blind_FZ.jpg", "ColorizedFullRoom", "unknown"],
  ]) {
    assert.equal(ctx.classifyShopifyImage({ url: `${origin}/cdn/shop/files/${file}`, alt }), role, `${file}: ${alt}`);
  }
});

const referenceImage = (file, alt = "", kind = "product") => ({
  id: file, kind, alt,
  src: `${origin}/cdn/shop/files/${file}?width=1200`,
  thumbnailSrc: `${origin}/cdn/shop/files/${file}?width=90`,
  zoomSrc: `${origin}/cdn/shop/files/${file}?width=1800`,
});

test("visualization references classify all photos before the cap, promoting installation and preserving detail", (t) => {
  const ctx = setup(t);
  const result = ctx.selectVisualizationProductReferences([
    referenceImage("feature_FR.jpg", "", "feature"),
    ...["first_Z.jpg", "second_Z.jpg", "third_Z.jpg", "fourth_Z.jpg", "fifth_Z.jpg"].map(file => referenceImage(file)),
    referenceImage("late_FZ.jpg"), referenceImage("late_FR.jpg"),
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.map(({url, role}) => ({file: new URL(url).pathname.split("/").at(-1), role})))), [
    {file: "late_FR.jpg", role: "installation"},
    {file: "first_Z.jpg", role: "unknown"},
    {file: "second_Z.jpg", role: "unknown"},
    {file: "late_FZ.jpg", role: "detail"},
  ]);
  assert.equal(result.every(image => image.url.endsWith("?width=1800")), true);
});

test("unknown visualization photos retain gallery order, deduplicate and bound alt payloads", (t) => {
  const ctx = setup(t);
  const images = [referenceImage("a_Z.jpg"), referenceImage("b_Z.jpg"), referenceImage("a_Z.jpg", "x".repeat(300)), referenceImage("c_Z.jpg"), referenceImage("d_Z.jpg"), referenceImage("e_Z.jpg")];
  const result = ctx.selectVisualizationProductReferences(images);
  assert.deepEqual(JSON.parse(JSON.stringify(result.map(image => image.url))), [images[0].zoomSrc, images[1].zoomSrc, images[3].zoomSrc, images[4].zoomSrc]);
  assert.equal(result.every(image => image.role === "unknown"), true);
  assert.equal(result[0].alt, "x".repeat(200));
});

test("visualization preparation selects later references from validated gallery in one owner operation", async (t) => {
  const media = [
    `<swiper-slide data-feature-option-slide-holder><img data-feature-option-slide-image src="${origin}/cdn/shop/files/feature_FR.jpg"></swiper-slide>`,
    ...["first_Z.jpg", "second_Z.jpg", "third_Z.jpg", "fourth_Z.jpg", "late_FZ.jpg", "late_FR.jpg"].map(file =>
      `<swiper-slide><img data-testid="pdp-product-image-main" src="${origin}/cdn/shop/files/${file}?width=1800"></swiper-slide>`),
  ].join("");
  const ctx = setup(t, async () => response(html(page, `<swiper-with-media data-main-product-media-gallery><swiper-container id="MediaGallery-template-main-swiper-initial">${media}</swiper-container></swiper-with-media>`)));
  const executor = ctx.createStorefrontExecutor({execute: () => assert.fail("No catalog call")});
  t.after(() => executor.dispose());
  const result = await executor.prepareVisualizationProduct("/products/shade", new AbortController().signal);
  assert.equal(result.productPath, "/products/shade");
  assert.deepEqual(JSON.parse(JSON.stringify(result.references.map(image => image.role))), ["installation", "unknown", "unknown", "detail"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.references.map(image => new URL(image.url).pathname.split("/").at(-1)))), ["late_FR.jpg", "first_Z.jpg", "second_Z.jpg", "late_FZ.jpg"]);
  assert.equal(ctx.calls.length, 1);
  await executor.loadProductGallery(page, new AbortController().signal);
  assert.equal(ctx.calls.length, 1, "Preparation shares the gallery cache");
});

test("cancelled visualization preparation does not retain stale photos or block the next operation", async (t) => {
  let attempts = 0;
  const ctx = setup(t, (_url, options) => {
    attempts++;
    if (attempts > 1) return Promise.resolve(response());
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), {once: true}));
  });
  const executor = ctx.createStorefrontExecutor({execute: () => assert.fail("No catalog call")});
  t.after(() => executor.dispose());
  const controller = new AbortController();
  const pending = executor.prepareVisualizationProduct("/products/shade", controller.signal);
  const rejected = assert.rejects(pending, {name: "AbortError"});
  await until(() => ctx.calls.length === 1);
  controller.abort();
  await rejected;
  const result = await executor.prepareVisualizationProduct("/products/shade", new AbortController().signal);
  assert.equal(result.references.length, 2);
  assert.equal(ctx.calls.length, 2, "Aborted preparation must not populate the cache");
  assert.equal(ctx.timers.size, 0);
});
