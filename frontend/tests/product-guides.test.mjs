import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `export * from "./shared/product-guides.ts";
      export { getProductGuides } from "./frontend/src/tools/product-guides.ts";
      export { createAssistantTools } from "./frontend/src/tools/index.ts";`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "Guides",
  platform: "browser",
});

const origin = "https://hd-dev-single.myshopify.com";
const productPath = "/products/lottie-mojito-roman-blind";
const measuring = `${origin}/cdn/shop/files/b2g-measuring-guide-roman.pdf?v=5729100873718235920`;
const fitting = `${origin}/cdn/shop/files/b2g-install-guide-roman-all_options.pdf?v=16605275457733919450`;
const shopifyMeasuring =
  "https://cdn.shopify.com/s/files/1/0893/6659/3817/files/Measuring-for-all-Roller-blinds.pdf?v=1744119133";
const guides = [
  { kind: "measuring", url: measuring },
  { kind: "fitting", url: fitting },
];
const result = { status: "found", productPath, guides };
const id = "b4638402-dac7-4e4d-a72e-6b8c6891ae59";

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function setup(t, pagePath = productPath) {
  const dom = new JSDOM(
    `<!doctype html><html><head><base href="https://untrusted.example/"></head><body class="template-product">
    <header><a href="/pages/measuring-blinds">Measuring Guide</a></header>
    <app-provider><main id="main"><product-accordions>
      <details id="Details-measuring"><summary>Measuring</summary><a href="//hd-dev-single.myshopify.com/cdn/shop/files/b2g-measuring-guide-roman.pdf?v=5729100873718235920">Measuring Guide</a></details>
      <details id="Details-installing"><summary>Fitting</summary><a href="/cdn/shop/files/b2g-install-guide-roman-all_options.pdf?v=16605275457733919450">Fitting Guide</a></details>
    </product-accordions></main><footer><a href="/pages/fitting-guides">Fitting Guide</a></footer></app-provider>
    <roman-ai-assistant data-shop="hd-dev-single.myshopify.com"></roman-ai-assistant>
    </body></html>`,
    { url: `${origin}${pagePath}`, runScripts: "outside-only" },
  );
  const { window } = dom;
  let fetches = 0;
  window.fetch = () => {
    fetches++;
    assert.fail("Guide extraction must not fetch PDFs or any other resource.");
  };
  window.eval(`${bundle.outputFiles[0].text}; window.Guides=Guides;`);
  const navigationState = {
    url: window.location.href,
    pending: false,
    error: null,
  };
  const tools = window.Guides.createAssistantTools(
    window.document.querySelector("roman-ai-assistant"),
    {
      getSnapshot: () => navigationState,
      navigate: () => assert.fail("Guide extraction cannot navigate."),
    },
  );
  t.after(() => {
    tools.dispose();
    window.close();
  });
  return {
    window,
    api: window.Guides,
    tools,
    navigationState,
    fetches: () => fetches,
    signal: () => new window.AbortController().signal,
  };
}

test("guide extraction reads only the current product anchors and preserves full file versions", async (t) => {
  const ctx = setup(t);
  assert.deepEqual(
    plain(await ctx.api.getProductGuides(productPath, ctx.signal())),
    result,
  );
  assert.equal(ctx.fetches(), 0);
  assert.equal(ctx.window.location.pathname, productPath);
});

test("current product guide extraction preserves exact Shopify file CDN links and ignores unrelated links", async (t) => {
  const path =
    "/products/perfect-fit-chromium-thermal-blackout-black-roller-blind";
  const ctx = setup(t, path);
  const anchor = ctx.window.document.querySelector("#Details-measuring a");
  for (const href of [
    shopifyMeasuring,
    shopifyMeasuring.replace("https:", ""),
  ]) {
    anchor.setAttribute("href", href);
    const found = plain(await ctx.api.getProductGuides(path, ctx.signal()));
    const expected = {
      ...result,
      productPath: path,
      guides: [{ kind: "measuring", url: shopifyMeasuring }, guides[1]],
    };
    assert.deepEqual(found, expected);
    assert.deepEqual(
      plain(ctx.api.parseProductGuidesResult(found, origin)),
      expected,
    );
    const part = {
      type: "guides",
      version: 1,
      invocationId: id,
      productPath: path,
      guides: found.guides,
    };
    assert.deepEqual(plain(ctx.api.parseGuidePart(part, origin)), part);
  }
  anchor.remove();
  const unrelated = ctx.window.document.createElement("a");
  unrelated.href = shopifyMeasuring;
  unrelated.textContent = "Measuring Guide";
  ctx.window.document.querySelector("header").append(unrelated);
  assert.deepEqual(plain(await ctx.api.getProductGuides(path, ctx.signal())), {
    ...result,
    productPath: path,
    guides: [guides[1]],
  });
  assert.equal(ctx.fetches(), 0);
});

test("manual tool resolves current collection/locale product scope but explicit model path stays exact", async (t) => {
  const ctx = setup(t, `/en-gb/collections/roman${productPath}?variant=123`);
  assert.deepEqual(
    plain(await ctx.tools.execute("get_product_guides", {})),
    result,
  );
  assert.deepEqual(
    plain(await ctx.tools.execute("get_product_guides", { productPath })),
    result,
  );
  assert.deepEqual(
    plain(
      await ctx.tools.execute("get_product_guides", {
        productPath: "/products/other",
      }),
    ),
    { status: "unavailable", productPath: "/products/other", guides: [] },
  );
  await assert.rejects(
    ctx.tools.execute("get_product_guides", { productPath, token: "private" }),
  );
  ctx.navigationState.pending = true;
  await assert.rejects(
    ctx.tools.execute("get_product_guides", {}),
    /Wait for storefront navigation/,
  );
  assert.equal(ctx.fetches(), 0);
});

test("missing, unsafe or ambiguously linked sections do not fall back to generic site guides", async (t) => {
  const ctx = setup(t);
  ctx.window.document.querySelector("#Details-measuring a").href =
    "https://other-store.example/cdn/shop/files/guide.pdf";
  assert.deepEqual(
    plain(await ctx.api.getProductGuides(productPath, ctx.signal())),
    { ...result, guides: [guides[1]] },
  );
  const fittingAnchor = ctx.window.document.querySelector(
    "#Details-installing a",
  );
  fittingAnchor.after(fittingAnchor.cloneNode(true));
  assert.deepEqual(
    plain(await ctx.api.getProductGuides(productPath, ctx.signal())),
    { status: "unavailable", productPath, guides: [] },
  );
  ctx.window.document.querySelector("product-accordions").remove();
  assert.deepEqual(
    plain(await ctx.api.getProductGuides(productPath, ctx.signal())),
    { status: "unavailable", productPath, guides: [] },
  );
  assert.equal(ctx.fetches(), 0);
});

test("product ownership and cancellation are checked without reading another page", async (t) => {
  const ctx = setup(t);
  const controller = new ctx.window.AbortController();
  controller.abort();
  await assert.rejects(
    ctx.api.getProductGuides(productPath, controller.signal),
  );
  ctx.window.document.body.classList.remove("template-product");
  assert.equal(
    (await ctx.api.getProductGuides(productPath, ctx.signal())).status,
    "unavailable",
  );
  ctx.window.document.body.classList.add("template-product");
  const root = ctx.window.document.querySelector("product-accordions");
  root.after(root.cloneNode(true));
  assert.equal(
    (await ctx.api.getProductGuides(productPath, ctx.signal())).status,
    "unavailable",
  );
  assert.equal(ctx.fetches(), 0);
});

test("guide calls and selections reject invented URLs, duplicate kinds and noncanonical paths", (t) => {
  const { api } = setup(t);
  assert.deepEqual(plain(api.parseProductGuidesCall({ productPath })), {
    productPath,
  });
  assert.deepEqual(
    plain(
      api.parseGuideSelection({ productPath, kinds: ["fitting", "measuring"] }),
    ),
    { productPath, kinds: ["fitting", "measuring"] },
  );
  for (const value of [
    {},
    { productPath, url: measuring },
    { productPath: `/collections/roman${productPath}` },
    { productPath: `${productPath}?x=1` },
  ])
    assert.throws(() => api.parseProductGuidesCall(value));
  for (const kinds of [
    [],
    ["measuring", "measuring"],
    ["measuring", "fitting", "measuring"],
    ["manufacturer"],
    "fitting",
  ])
    assert.throws(() => api.parseGuideSelection({ productPath, kinds }));
  assert.throws(() =>
    api.parseGuideSelection({ productPath, kinds: ["fitting"], url: fitting }),
  );
});

test("PDF URL validation requires an exact supported storefront or Shopify CDN path and clean version query", (t) => {
  const { api } = setup(t);
  assert.equal(api.parseProductGuideUrl(measuring, origin), measuring);
  assert.equal(
    api.parseProductGuideUrl(shopifyMeasuring, origin),
    shopifyMeasuring,
  );
  assert.equal(
    api.parseProductGuideUrl(shopifyMeasuring.replace("https:", ""), origin),
    shopifyMeasuring,
  );
  assert.equal(
    api.parseProductGuideUrl(shopifyMeasuring.split("?")[0], origin),
    shopifyMeasuring.split("?")[0],
  );
  const olderShopifyUrl =
    "https://cdn.shopify.com/s/files/1/2637/1970/files/specifications.pdf?v=1750477634";
  assert.equal(
    api.parseProductGuideUrl(olderShopifyUrl, origin),
    olderShopifyUrl,
  );
  assert.equal(
    api.parseProductGuideUrl("/cdn/shop/files/guide.pdf", origin),
    `${origin}/cdn/shop/files/guide.pdf`,
  );
  for (const value of [
    "https://cdn.shopify.com/s/files/1/123/files/guide.pdf",
    ...[
      shopifyMeasuring.replace(
        "cdn.shopify.com",
        "cdn.shopify.com.evil.example",
      ),
      shopifyMeasuring.replace("cdn.shopify.com", "files.cdn.shopify.com"),
      shopifyMeasuring.replace("cdn.shopify.com", "cdn.shopify.com."),
      shopifyMeasuring.replace("cdn.shopify.com", "cdn.shopify.com:444"),
      shopifyMeasuring.replace("cdn.shopify.com", "cdn.shopify.com:80"),
      shopifyMeasuring.replace("https:", "http:"),
      shopifyMeasuring.replace("https://", "https://user:secret@"),
      shopifyMeasuring.replace("/s/files/1/", "/s/files/2/"),
      shopifyMeasuring.replace("/0893/", "/shop/"),
      shopifyMeasuring.replace("/6659/", "/1234567890123/"),
      shopifyMeasuring.replace("/0893/6659/3817/", "/0893/"),
      shopifyMeasuring.replace("/0893/6659/3817/", "/1/2/3/4/5/"),
      shopifyMeasuring.replace("/3817/files/", "/3817/products/"),
      shopifyMeasuring.replace("/Measuring-", "/nested/Measuring-"),
      shopifyMeasuring.replace(".pdf?", ".html?"),
      shopifyMeasuring.replace("/Measuring-", "/../files/Measuring-"),
      shopifyMeasuring.replace("/Measuring-", "/%2e%2e/Measuring-"),
      shopifyMeasuring.replace("Measuring-", "Measuring%2f"),
      `${shopifyMeasuring}#page=1`,
      `${shopifyMeasuring}&download=1`,
      `${shopifyMeasuring}&v=2`,
      shopifyMeasuring.replace("v=1744119133", "v=wrong"),
    ],
    "https://other.example/cdn/shop/files/guide.pdf",
    `${origin}/pages/measuring-blinds`,
    `${origin}/cdn/shop/files/guide.html`,
    `${origin}/cdn/shop/files/guide.pdf#page=1`,
    `${origin}/cdn/shop/files/guide.pdf?download=1`,
    `${origin}/cdn/shop/files/guide.pdf?v=1&v=2`,
    `${origin}/cdn/shop/files/guide.pdf?v=x`,
    `${origin}/cdn/shop/files/guide.pdf?&&`,
    `${origin}/cdn/shop/files/../files/guide.pdf`,
    `${origin}/cdn/shop/files/%2e%2e/guide.pdf`,
    `${origin}/cdn/shop/files/a%2fb.pdf`,
    `https://user:secret@hd-dev-single.myshopify.com/cdn/shop/files/guide.pdf`,
    `http://hd-dev-single.myshopify.com/cdn/shop/files/guide.pdf`,
    `javascript:alert(1)`,
    `/cdn/shop/files/a\\b.pdf`,
    `${origin}/cdn/shop/files/${"a".repeat(2048)}.pdf`,
  ])
    assert.throws(() => api.parseProductGuideUrl(value, origin), value);
});

test("browser results and durable guide parts reject unknown/private fields and bind voice metadata", (t) => {
  const { api } = setup(t);
  assert.deepEqual(plain(api.parseProductGuidesResult(result, origin)), result);
  for (const value of [
    { ...result, token: "private" },
    { ...result, status: "unavailable" },
    { ...result, guides: [] },
    { ...result, guides: [guides[0], guides[0]] },
    {
      ...result,
      guides: [{ ...guides[0], instructions: "invented fitting steps" }],
    },
  ])
    assert.throws(() => api.parseProductGuidesResult(value, origin));
  const part = {
    type: "guides",
    version: 1,
    invocationId: id,
    productPath,
    guides,
    voiceReply: { voiceId: id, afterSequence: 5 },
  };
  assert.deepEqual(plain(api.parseGuidePart(part, origin)), part);
  for (const change of [
    { invocationId: "provider-call-id" },
    { version: 2 },
    { rawPdf: "private" },
    { guides: [] },
    { voiceReply: { voiceId: id, afterSequence: -1 } },
    { voiceReply: { voiceId: id, afterSequence: 1.5 } },
    { voiceReply: { voiceId: id, afterSequence: 5, heard: true } },
  ])
    assert.throws(() => api.parseGuidePart({ ...part, ...change }, origin));
});
