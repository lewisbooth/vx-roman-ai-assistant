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

test("PDF URL validation requires this exact storefront CDN and a clean version query", (t) => {
  const { api } = setup(t);
  assert.equal(api.parseProductGuideUrl(measuring, origin), measuring);
  assert.equal(
    api.parseProductGuideUrl("/cdn/shop/files/guide.pdf", origin),
    `${origin}/cdn/shop/files/guide.pdf`,
  );
  for (const value of [
    "https://cdn.shopify.com/s/files/1/123/files/guide.pdf",
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
