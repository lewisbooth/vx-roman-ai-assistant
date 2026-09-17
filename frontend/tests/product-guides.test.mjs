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
const shopifyFitting =
  "https://cdn.shopify.com/s/files/1/0893/6659/3817/files/b2g-panel-36-09.19.pdf?v=1744100480";
const primaryGuides = [
  { kind: "measuring", url: shopifyMeasuring },
  { kind: "fitting", url: shopifyFitting },
];
const guides = [
  { kind: "measuring", url: measuring },
  { kind: "fitting", url: fitting },
];
const result = { status: "found", productPath, guides };
const id = "b4638402-dac7-4e4d-a72e-6b8c6891ae59";

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function setup(t, pagePath = productPath, storefrontOrigin = origin) {
  const dom = new JSDOM(
    `<!doctype html><html><head><base href="https://untrusted.example/"></head><body class="template-product">
    <header><a href="/pages/measuring-blinds">Measuring Guide</a></header>
    <app-provider><main id="main"><product-accordions>
      <details id="Details-measuring"><summary>Measuring</summary><a href="//hd-dev-single.myshopify.com/cdn/shop/files/b2g-measuring-guide-roman.pdf?v=5729100873718235920">Measuring Guide</a></details>
      <details id="Details-installing"><summary>Fitting</summary><a href="/cdn/shop/files/b2g-install-guide-roman-all_options.pdf?v=16605275457733919450">Fitting Guide</a></details>
    </product-accordions></main><footer><a href="/pages/fitting-guides">Fitting Guide</a></footer></app-provider>
    <roman-ai-assistant data-shop="hd-dev-single.myshopify.com"></roman-ai-assistant>
    </body></html>`,
    { url: `${storefrontOrigin}${pagePath}`, runScripts: "outside-only" },
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

// The product's primary accordions keep their headings outside each collapsed
// region, inside its owning wrapper. Guide reading must not open the accordion.
function addPrimaryGuides(ctx) {
  const root = ctx.window.document.createElement("main-product");
  root.id = "template--28531254853816__main";
  root.setAttribute("section-id", root.id);
  root.setAttribute("update-url", "true");
  root.setAttribute(
    "product-url",
    ctx.window.location.pathname
      .slice(ctx.window.location.pathname.lastIndexOf("/products/"))
      .replace(/\/$/, ""),
  );
  root.innerHTML = `<section id="ProductInfo-template--28531254853816__main-after-media">
    <div id="Details-10_1">
      <label for="accordion-checkbox-10_1">
        <input type="checkbox" id="accordion-checkbox-10_1" aria-controls="accordion-content-10_1">
        <div><h2 id="accordion-title-10_1">Easy Fitting Guide</h2></div>
      </label>
      <div id="accordion-content-10_1" role="region" aria-labelledby="accordion-title-10_1" class="invisible" style="visibility:hidden">
        <div><a href="${shopifyFitting}">Download Guide</a></div>
      </div>
    </div>
    <div id="measuring_guide_accordion">
      <label for="accordion-checkbox-10_2">
        <input type="checkbox" id="accordion-checkbox-10_2" aria-controls="accordion-content-10_2">
        <div><h2 id="accordion-title-10_2">Measuring for Roller Blinds</h2></div>
      </label>
      <div id="accordion-content-10_2" role="region" aria-labelledby="accordion-title-10_2" class="invisible" style="visibility:hidden">
        <div><a href="${shopifyMeasuring}">Download Guide</a></div>
      </div>
    </div>
  </section>`;
  ctx.window.document.querySelector("main#main").prepend(root);
  return root;
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

test("collapsed primary product guides take precedence over separate legacy guide controls", async (t) => {
  const path =
    "/products/perfect-fit-chromium-thermal-blackout-black-roller-blind";
  const ctx = setup(t, path, "https://shopify-single-dev.hdecom.com");
  const legacyMeasuring =
    "https://shopify-single-dev.hdecom.com/cdn/shop/files/b2g-measuring-guide-perfect_fit_standard.pdf?v=62238";
  const legacyFitting =
    "https://shopify-single-dev.hdecom.com/cdn/shop/files/b2g-install-guide-roller-perfectfit.pdf?v=62238";
  ctx.window.document
    .querySelector("#Details-measuring a")
    .setAttribute("href", legacyMeasuring);
  ctx.window.document
    .querySelector("#Details-installing a")
    .setAttribute("href", legacyFitting);
  const root = addPrimaryGuides(ctx);
  const original = root.outerHTML;
  root.addEventListener("click", () =>
    assert.fail("Do not open the guide accordion."),
  );
  root.addEventListener("change", () =>
    assert.fail("Do not change accordion state."),
  );
  assert.deepEqual(plain(await ctx.api.getProductGuides(path, ctx.signal())), {
    status: "found",
    productPath: path,
    guides: primaryGuides,
  });
  assert.equal(root.outerHTML, original);
  assert.equal(root.querySelector("input:checked"), null);
  assert.equal(ctx.fetches(), 0);

  root.querySelector("#measuring_guide_accordion").remove();
  assert.deepEqual(
    plain(await ctx.api.getProductGuides(path, ctx.signal())),
    {
      status: "found",
      productPath: path,
      guides: [{ kind: "measuring", url: legacyMeasuring }, primaryGuides[1]],
    },
    "Only an absent primary kind may use its legacy guide",
  );
});

test("recommendation cards loaded after the PDP do not hide or replace its guides", async (t) => {
  const ctx = setup(t);
  const root = addPrimaryGuides(ctx);
  const expected = { status: "found", productPath, guides: primaryGuides };
  assert.deepEqual(
    plain(await ctx.api.getProductGuides(productPath, ctx.signal())),
    expected,
  );

  for (let index = 0; index < 8; index++) {
    const card = root.cloneNode(true);
    card.id = `recommendation-product-card-${index}`;
    // Even a matching URL and update-url flag do not make a card the PDP.
    card.setAttribute(
      "product-url",
      index % 2 ? `/products/other-${index}` : productPath,
    );
    if (index !== 0) card.setAttribute("data-product-card", "");
    card.setAttribute(
      "section-id",
      index === 1 ? "recommendations" : "product-card",
    );
    for (const anchor of card.querySelectorAll("a[href]"))
      anchor.setAttribute(
        "href",
        `${origin}/cdn/shop/files/unrelated-card.pdf?v=1`,
      );
    if (index === 7) {
      // A nested card without its own region must not lend its link to the
      // parent's measuring accordion either.
      card.innerHTML = `<a href="${origin}/cdn/shop/files/unrelated-card.pdf?v=1">Download Guide</a>`;
      root.querySelector("#accordion-content-10_2").append(card);
    } else if (index === 6) {
      root.append(card);
    } else {
      ctx.window.document.querySelector("main#main").append(card);
    }
  }
  assert.equal(
    ctx.window.document.querySelectorAll("main#main main-product").length,
    9,
  );
  assert.deepEqual(
    plain(await ctx.api.getProductGuides(productPath, ctx.signal())),
    expected,
  );
  assert.equal(ctx.fetches(), 0);
});

test("a primary product URL mismatch cannot use otherwise valid legacy guides", async (t) => {
  const ctx = setup(t);
  const root = addPrimaryGuides(ctx);
  root.setAttribute("product-url", "/products/different-blind");
  assert.deepEqual(
    plain(await ctx.api.getProductGuides(productPath, ctx.signal())),
    { status: "unavailable", productPath, guides: [] },
  );
  assert.equal(ctx.fetches(), 0);
});

test("invalid or ambiguous primary guides cannot silently fall back to legacy links", async (t) => {
  const cases = [
    [
      "duplicate primary regions",
      (root) => {
        const panel = root.querySelector("#measuring_guide_accordion");
        panel.after(panel.cloneNode(true));
      },
    ],
    [
      "duplicate primary download anchors",
      (root) => {
        const anchor = root.querySelector("#accordion-content-10_2 a");
        anchor.after(anchor.cloneNode(true));
      },
    ],
    [
      "unsupported primary URL",
      (root) => {
        root
          .querySelector("#accordion-content-10_2 a")
          .setAttribute("href", "https://other-store.example/guide.pdf");
      },
    ],
    [
      "ambiguous local heading identity",
      (root) => {
        const heading = root.querySelector("#accordion-title-10_2");
        heading.after(heading.cloneNode(true));
      },
    ],
    [
      "multiple labelled heading IDs",
      (root) => {
        root
          .querySelector("#accordion-content-10_2")
          .setAttribute(
            "aria-labelledby",
            "accordion-title-10_2 another-title",
          );
      },
    ],
  ];
  for (const [name, change] of cases)
    await t.test(name, async (t) => {
      const ctx = setup(t);
      change(addPrimaryGuides(ctx));
      assert.deepEqual(
        plain(await ctx.api.getProductGuides(productPath, ctx.signal())),
        { status: "found", productPath, guides: [primaryGuides[1]] },
      );
      assert.equal(ctx.fetches(), 0);
    });
  await t.test("multiple primary product owners", async (t) => {
    const ctx = setup(t);
    const root = addPrimaryGuides(ctx);
    root.after(root.cloneNode(true));
    assert.deepEqual(
      plain(await ctx.api.getProductGuides(productPath, ctx.signal())),
      { status: "unavailable", productPath, guides: [] },
    );
  });
});

test("primary guide headings and links stay scoped to the owning product accordion", async (t) => {
  const ctx = setup(t);
  const root = addPrimaryGuides(ctx);
  ctx.window.document.querySelector("product-accordions").remove();
  const heading = root.querySelector("#accordion-title-10_2");
  ctx.window.document.querySelector("header").append(heading);
  assert.deepEqual(
    plain(await ctx.api.getProductGuides(productPath, ctx.signal())),
    { status: "found", productPath, guides: [primaryGuides[1]] },
    "A matching global heading ID does not label this product's guide",
  );
  root.querySelector("#Details-10_1 label").append(heading);
  assert.deepEqual(
    plain(await ctx.api.getProductGuides(productPath, ctx.signal())),
    { status: "found", productPath, guides: [primaryGuides[1]] },
    "Another accordion's heading is not the missing measuring label",
  );
  root.querySelector("#measuring_guide_accordion label div").append(heading);
  ctx.window.document.querySelector("header").append(root.cloneNode(true));
  ctx.window.document.querySelector("footer").append(root);
  const looseGuide = ctx.window.document.createElement("a");
  looseGuide.href = shopifyMeasuring;
  looseGuide.textContent = "Measuring Guide";
  ctx.window.document.querySelector("main#main").append(looseGuide);
  assert.deepEqual(
    plain(await ctx.api.getProductGuides(productPath, ctx.signal())),
    { status: "unavailable", productPath, guides: [] },
    "Header, footer and unowned main-content PDF links are not product guides",
  );
  assert.equal(ctx.fetches(), 0);
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
