import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const origin = "https://hd-dev-multi.myshopify.com";
const productOne = "/products/traditional-room-darkening-zebra-shades";
const productTwo = "/products/2-inch-levolor-classic-neutral-faux-wood-blinds";
const bundle = await build({
  entryPoints: ["frontend/src/navigation/shared/index.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanNavigation",
  platform: "browser",
});
const pageBundle = await build({
  stdin: {
    contents:
      'export * from "./frontend/src/navigation/shared/page"; export { selectStore } from "./frontend/src/navigation/themes";',
    resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
    sourcefile: "navigation-test-entry.ts",
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanPage",
  platform: "browser",
});

function page(path, extra = "") {
  const template = path.startsWith("/products/")
    ? "product"
    : path.startsWith("/collections/")
      ? "collection"
      : path === "/cart"
        ? "cart"
        : "index";
  return `<!doctype html><html data-roman-preview="true"><head>
    <title>Store ${path}</title><link rel="canonical" href="${origin}${path}">
    </head><body class="template-${template}"><app-provider>
    <header><a href="/">Store header</a></header>
    <main id="main" tabindex="-1"><h1>${path}</h1>${extra}</main>
    <footer>Store footer</footer></app-provider>
    <roman-ai-assistant data-shop="hd-dev-multi.myshopify.com"></roman-ai-assistant>
    </body></html>`;
}

function response(path, options = {}) {
  return {
    ok: true,
    status: 200,
    url: new URL(path, origin).href,
    headers: {
      get: (name) =>
        name.toLowerCase() === "content-type"
          ? "text/html; charset=utf-8"
          : null,
    },
    text: async () => page(path),
    ...options,
  };
}

function setup(
  t,
  fetch = async (url) => response(new URL(url).pathname),
  options = {},
) {
  const dom = new JSDOM(options.html ?? page("/"), {
    url: options.url ?? `${origin}/`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const calls = [];
  const warnings = [];
  window.console.warn = (...args) => warnings.push(args.map(String).join(" "));
  window.fetch = (url, options) => {
    calls.push({ url: String(url), options });
    return fetch(url, options);
  };
  window.scrollTo = () => {};
  options.beforeImport?.(window);
  window.eval(
    `${bundle.outputFiles[0].text}\nwindow.RomanNavigation = RomanNavigation;`,
  );
  window.eval(
    `${pageBundle.outputFiles[0].text}\nwindow.RomanPage = RomanPage;`,
  );
  const host = window.document.querySelector("roman-ai-assistant");
  if (options.shop) host.dataset.shop = options.shop;
  host.attachShadow({ mode: "open" }).innerHTML =
    '<input aria-label="Conversation draft">';
  host.shadowRoot.querySelector("input").value = "Keep my measurements";
  const instance = {};
  host.romanInstance = instance;
  const pageApi = window.RomanPage;
  const profile = pageApi.selectStore(host.dataset.shop);
  window.RomanPage = {
    ...pageApi,
    preparePage: (html, url) => pageApi.preparePage(html, url, profile?.theme),
  };
  const navigation = window.RomanNavigation.createStorefrontNavigation(host);
  t.after(() => {
    navigation.dispose();
    dom.window.close();
  });
  return {
    window,
    document: window.document,
    host,
    instance,
    navigation,
    calls,
    warnings,
  };
}

async function until(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(message);
}

test("all five destinations replace store content without remounting Roman or its surrounding theme", async (t) => {
  const { document, window, host, instance, navigation } = setup(t);
  const provider = document.querySelector("app-provider");
  const header = document.querySelector("header");
  const footer = document.querySelector("footer");
  const shadow = host.shadowRoot;
  const input = shadow.querySelector("input");
  let previousMain = document.querySelector("main");
  let notifications = 0;
  const unsubscribe = navigation.subscribe(() => notifications++);
  t.after(unsubscribe);

  for (const path of [
    "/collections/all",
    productOne,
    productTwo,
    "/cart",
    "/",
  ]) {
    await navigation.navigate(path);
    assert.equal(navigation.getSnapshot().error, null);
    assert.equal(window.location.pathname, path);
    assert.equal(document.title, `Store ${path}`);
    assert.equal(document.querySelector("main h1").textContent, path);
    assert.notEqual(document.querySelector("main"), previousMain);
    previousMain = document.querySelector("main");
    assert.equal(document.querySelector("roman-ai-assistant"), host);
    assert.equal(host.shadowRoot, shadow);
    assert.equal(shadow.querySelector("input"), input);
    assert.equal(input.value, "Keep my measurements");
    assert.equal(host.romanInstance, instance);
    assert.equal(document.querySelector("app-provider"), provider);
    assert.equal(document.querySelector("header"), header);
    assert.equal(document.querySelector("footer"), footer);
    const template = path.startsWith("/products/")
      ? "product"
      : path.startsWith("/collections/")
        ? "collection"
        : path === "/cart"
          ? "cart"
          : "index";
    assert.equal(document.body.className, `template-${template}`);
  }
  assert.ok(notifications >= 5, "navigation subscribers observe state changes");
});

test("failed requests and invalid destination documents leave the existing page and URL usable", async (t) => {
  const cases = [
    [
      "HTTP failure",
      async () => response(productOne, { ok: false, status: 503 }),
    ],
    [
      "network failure",
      async () => {
        throw new Error("Connection interrupted");
      },
    ],
    [
      "missing content boundary",
      async () =>
        response(productOne, {
          text: async () =>
            "<html><head><title>Login</title></head><body>Sign in</body></html>",
        }),
    ],
    [
      "cross-origin redirect",
      async () =>
        response(productOne, { url: "https://accounts.shopify.com/login" }),
    ],
  ];
  for (const [name, fetch] of cases) {
    await t.test(name, async (t) => {
      const { document, window, navigation } = setup(t, fetch);
      const main = document.querySelector("main");
      await navigation.navigate(productOne);
      assert.ok(
        navigation.getSnapshot().error,
        "failure is exposed to the sidebar",
      );
      assert.equal(Boolean(navigation.getSnapshot().pending), false);
      assert.equal(document.querySelector("main"), main);
      assert.equal(window.location.href, `${origin}/`);
      assert.equal(document.title, "Store /");
    });
  }
});

test("an older response cannot overwrite a newer navigation even if fetch ignores cancellation", async (t) => {
  let resolveFirst;
  const { document, window, navigation, calls } = setup(t, (url) => {
    const path = new URL(url).pathname;
    return path === productOne
      ? new Promise((resolve) => {
          resolveFirst = resolve;
        })
      : Promise.resolve(response(path));
  });
  const first = navigation.navigate(productOne);
  await until(() => resolveFirst, "first request did not start");
  const second = navigation.navigate(productTwo);
  await second;
  assert.equal(calls[0].options.signal.aborted, true);
  resolveFirst(response(productOne));
  await first;
  assert.equal(window.location.pathname, productTwo);
  assert.equal(document.querySelector("main h1").textContent, productTwo);
  assert.equal(navigation.getSnapshot().error, null);
});

test("only supported ordinary links are intercepted while the sidebar is open", async (t) => {
  const { document, window, navigation, calls } = setup(t);
  const intercepted = [];
  // Observe the adapter's decision, then suppress jsdom's unimplemented hard navigation.
  window.addEventListener("click", (event) => {
    intercepted.push(event.defaultPrevented);
    event.preventDefault();
  });
  const click = (href, options = {}, attributes = {}) => {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = "Go";
    for (const [name, value] of Object.entries(attributes))
      link.setAttribute(name, value);
    document.querySelector("main").append(link);
    link.dispatchEvent(
      new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...options,
      }),
    );
    link.remove();
    return intercepted.at(-1);
  };
  assert.equal(
    click(productOne),
    false,
    "closed sidebar leaves normal browsing alone",
  );
  assert.equal(calls.length, 0);
  navigation.setSidebarOpen(true);
  assert.equal(
    document.documentElement.hasAttribute("data-roman-sidebar-open"),
    true,
  );
  for (const [href, options, attributes] of [
    [productOne, { ctrlKey: true }],
    [productOne, { metaKey: true }],
    [productOne, { shiftKey: true }],
    [productOne, { button: 1 }],
    ["https://example.org/"],
    ["/checkout"],
    [productOne, {}, { target: "_blank" }],
    [productOne, {}, { download: "product.html" }],
    ["#measurements"],
  ]) {
    assert.equal(
      click(href, options, attributes),
      false,
      `${href} should retain its native behavior`,
    );
  }
  assert.equal(calls.length, 0);
  assert.equal(click(productOne), true);
  await until(
    () => window.location.pathname === productOne,
    "supported link did not navigate",
  );
  assert.equal(calls.length, 1);
  navigation.setSidebarOpen(false);
  assert.equal(
    document.documentElement.hasAttribute("data-roman-sidebar-open"),
    false,
  );
  assert.equal(document.querySelector("style[data-roman-layout]"), null);
  assert.equal(click(productTwo), false);
  assert.equal(calls.length, 1);
});

test("cart forms keep their native submission behavior", (t) => {
  const { document, window, navigation, calls } = setup(t);
  navigation.setSidebarOpen(true);
  const form = document.createElement("form");
  form.action = "/cart/add";
  form.method = "post";
  document.querySelector("main").append(form);
  const submission = new window.Event("submit", {
    bubbles: true,
    cancelable: true,
  });
  form.dispatchEvent(submission);
  assert.equal(submission.defaultPrevented, false);
  assert.equal(calls.length, 0);
});

test("Back and Forward restore store pages without losing Roman state", async (t) => {
  const { document, window, host, navigation } = setup(t);
  await navigation.navigate(productOne);
  await navigation.navigate(productTwo);
  window.history.back();
  await until(
    () => document.querySelector("main h1").textContent === productOne,
    "Back did not restore the first product",
  );
  assert.equal(window.location.pathname, productOne);
  assert.equal(document.querySelector("roman-ai-assistant"), host);
  assert.equal(
    host.shadowRoot.querySelector("input").value,
    "Keep my measurements",
  );
  window.history.forward();
  await until(
    () => document.querySelector("main h1").textContent === productTwo,
    "Forward did not restore the second product",
  );
  assert.equal(window.location.pathname, productTwo);
  assert.equal(document.querySelector("roman-ai-assistant"), host);
});

test("Back restores the outgoing page scroll without discarding other history owners", async (t) => {
  const { document, window, navigation } = setup(t);
  window.history.replaceState({ themeSelection: "original" }, "", "/");
  Object.defineProperty(window, "scrollY", { value: 640, writable: true });
  const restored = [];
  window.scrollTo = (options) => restored.push(options);
  await navigation.navigate(productOne);
  window.history.back();
  await until(
    () => document.querySelector("main h1").textContent === "/",
    "Back did not restore the original page",
  );
  assert.equal(window.history.state.themeSelection, "original");
  assert.equal(restored.at(-1).top, 640);
});

test("navigation preserves variant and filter history updates made by the theme", async (t) => {
  for (const [name, path, query, state] of [
    [
      "product variant",
      productOne,
      "?variant=12345",
      { selectedVariant: 12345 },
    ],
    [
      "collection filter",
      "/collections/all",
      "?filter.p.product_type=Zebra&sort_by=price-ascending",
      { selectedFilter: "Zebra" },
    ],
  ]) {
    await t.test(name, async (t) => {
      const { document, window, navigation, calls } = setup(
        t,
        async (url) => response(new URL(url).pathname, { url: String(url) }),
        { html: page(path), url: `${origin}${path}` },
      );
      const themeUrl = `${origin}${path}${query}`;
      window.history.replaceState(state, "", themeUrl);
      await navigation.navigate(productTwo);
      window.history.back();
      await until(
        () => document.querySelector("main h1").textContent === path,
        "Back did not restore the theme's page",
      );
      assert.equal(window.location.href, themeUrl);
      assert.equal(calls.at(-1).url, themeUrl);
      for (const [key, value] of Object.entries(state)) {
        assert.equal(window.history.state[key], value);
      }
      assert.equal(navigation.getSnapshot().error, null);
    });
  }
});

test("Back restores the initial page even when it is outside the five shortcuts", async (t) => {
  const path = "/products/other-product";
  const { document, window, host, navigation } = setup(t, undefined, {
    html: page(path),
    url: `${origin}${path}`,
  });
  assert.equal(
    navigation.destinations.some((destination) => destination.path === path),
    false,
  );
  await navigation.navigate("/");
  assert.equal(document.querySelector("main h1").textContent, "/");
  window.history.back();
  await until(
    () => document.querySelector("main h1").textContent === path,
    "Back did not restore the initial product",
  );
  assert.equal(window.location.pathname, path);
  assert.equal(document.querySelector("roman-ai-assistant"), host);
  assert.equal(
    host.shadowRoot.querySelector("input").value,
    "Keep my measurements",
  );
  assert.equal(navigation.getSnapshot().error, null);
});

test("failed Back and Forward preserve their destinations for a successful retry", async (t) => {
  let failingPath;
  const { document, window, navigation } = setup(t, async (url) => {
    const path = new URL(url).pathname;
    return response(
      path,
      path === failingPath ? { ok: false, status: 503 } : {},
    );
  });
  await navigation.navigate(productOne);
  await navigation.navigate(productTwo);
  const secondProduct = document.querySelector("main");
  const historyLength = window.history.length;
  failingPath = productOne;
  window.history.back();
  await until(
    () =>
      navigation.getSnapshot().error &&
      !navigation.getSnapshot().pending &&
      window.location.pathname === productTwo,
    "failed Back did not return to the displayed product's history entry",
  );
  assert.equal(document.querySelector("main"), secondProduct);
  assert.equal(window.history.length, historyLength);

  failingPath = undefined;
  window.history.back();
  await until(
    () => document.querySelector("main h1").textContent === productOne,
    "retrying Back lost the original destination",
  );
  const firstProduct = document.querySelector("main");
  failingPath = productTwo;
  window.history.forward();
  await until(
    () =>
      navigation.getSnapshot().error &&
      !navigation.getSnapshot().pending &&
      window.location.pathname === productOne,
    "failed Forward did not return to the displayed product's history entry",
  );
  assert.equal(document.querySelector("main"), firstProduct);
  assert.equal(window.history.length, historyLength);
  failingPath = undefined;
  window.history.forward();
  await until(
    () => document.querySelector("main h1").textContent === productTwo,
    "retrying Forward lost the original destination",
  );
  assert.equal(navigation.getSnapshot().error, null);
});

test("branching after Back retains correct history positions and failure rollback", async (t) => {
  let failingPath;
  const { document, window, navigation } = setup(t, async (url) => {
    const path = new URL(url).pathname;
    return response(
      path,
      path === failingPath ? { ok: false, status: 503 } : {},
    );
  });
  await navigation.navigate(productOne);
  await navigation.navigate(productTwo);
  window.history.back();
  await until(
    () => document.querySelector("main h1").textContent === productOne,
    "Back did not reach the branch point",
  );
  await navigation.navigate("/cart");
  assert.equal(window.history.length, 3);
  failingPath = productOne;
  window.history.back();
  await until(
    () =>
      navigation.getSnapshot().error &&
      !navigation.getSnapshot().pending &&
      window.location.pathname === "/cart",
    "failed Back did not restore the new branch",
  );
  assert.equal(document.querySelector("main h1").textContent, "/cart");
  failingPath = undefined;
  window.history.go(-2);
  await until(
    () => document.querySelector("main h1").textContent === "/",
    "two-entry Back did not reach Home",
  );
  window.history.forward();
  await until(
    () => document.querySelector("main h1").textContent === productOne,
    "Forward did not reach the branch point",
  );
  window.history.forward();
  await until(
    () => document.querySelector("main h1").textContent === "/cart",
    "Forward returned to the discarded branch",
  );
  assert.equal(window.location.pathname, "/cart");
});

test("payment initialization failure keeps the inserted page and preserves previous history", async (t) => {
  const { document, window, navigation } = setup(t);
  await navigation.navigate(productOne);
  window.Shopify = {
    PaymentButton: {
      init: () => {
        throw new Error("Payment integration unavailable");
      },
    },
  };
  await navigation.navigate(productTwo);
  assert.match(
    navigation.getSnapshot().error,
    /payment controls could not initialize/,
  );
  assert.equal(navigation.getSnapshot().pending, false);
  assert.equal(document.querySelector("main h1").textContent, productTwo);
  assert.equal(window.location.pathname, productTwo);
  assert.equal(window.history.length, 3);
  window.Shopify.PaymentButton.init = () => {};
  window.history.back();
  await until(
    () => document.querySelector("main h1").textContent === productOne,
    "payment failure discarded the previous product's history",
  );
  window.history.back();
  await until(
    () => document.querySelector("main h1").textContent === "/",
    "payment failure discarded the initial page's history",
  );
  assert.equal(navigation.getSnapshot().error, null);
});

test("disposing during Back restores the displayed URL and ignores its pending response", async (t) => {
  let holdRequest = false;
  let resolveRequest;
  const { document, window, navigation, calls } = setup(t, (url) => {
    const path = new URL(url).pathname;
    return holdRequest && path === productOne
      ? new Promise((resolve) => {
          resolveRequest = resolve;
        })
      : Promise.resolve(response(path));
  });
  await navigation.navigate(productOne);
  await navigation.navigate(productTwo);
  const displayedMain = document.querySelector("main");
  holdRequest = true;
  window.history.back();
  await until(
    () => resolveRequest,
    "Back did not begin fetching its destination",
  );
  assert.equal(window.location.pathname, productOne);
  assert.equal(document.querySelector("main"), displayedMain);
  navigation.dispose();
  assert.equal(calls.at(-1).options.signal.aborted, true);
  await until(
    () => window.location.pathname === productTwo,
    "disposal left the address bar pointing at an undisplayed page",
  );
  resolveRequest(response(productOne));
  await delay(0);
  assert.equal(document.querySelector("main"), displayedMain);
  assert.equal(window.location.pathname, productTwo);
  assert.equal(window.history.length, 3);
  assert.equal(calls.length, 3);
});

test("disposal aborts pending work and removes navigation interception", async (t) => {
  let resolveRequest;
  const { document, window, navigation, calls } = setup(
    t,
    () =>
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
  );
  navigation.setSidebarOpen(true);
  const pending = navigation.navigate(productOne);
  await until(() => resolveRequest, "request did not start");
  navigation.dispose();
  assert.equal(
    document.documentElement.hasAttribute("data-roman-sidebar-open"),
    false,
  );
  assert.equal(document.querySelector("style[data-roman-layout]"), null);
  assert.equal(calls[0].options.signal.aborted, true);
  resolveRequest(response(productOne));
  await pending;
  assert.equal(window.location.pathname, "/");
  assert.equal(document.querySelector("main h1").textContent, "/");
  const link = document.createElement("a");
  link.href = productTwo;
  document.querySelector("main").append(link);
  let intercepted;
  window.addEventListener("click", (event) => {
    intercepted = event.defaultPrevented;
    event.preventDefault();
  });
  link.dispatchEvent(
    new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    }),
  );
  assert.equal(intercepted, false);
  assert.equal(calls.length, 1);
});

const themeAsset = (name) => `${origin}/cdn/shop/t/118/assets/${name}`;

function themePage(
  path,
  { meta = {}, collectionId = "", extra = "", assets = "" } = {},
) {
  return page(path, extra)
    .replace('data-roman-preview="true"', 'data-roman-preview="false"')
    .replace(
      "</head>",
      `<script type="module" src="${themeAsset("-app-provider.js")}"></script>
      <script>window.__ADMIN_COLLECTION_ID__ = '${collectionId}';
      window.__CART__ = {"items":[]}; window.__CART_COLOR_SWATCHES__ = {};</script>
      <script>var meta = ${JSON.stringify(meta)};
      window.ShopifyAnalytics.meta[attr] = meta[attr];</script>${assets}</head>`,
    );
}

test("page commits replace stale product metadata while preserving store context and JSON configuration", (t) => {
  const { window, document } = setup(t, undefined, {
    html: themePage("/", { meta: { currency: "USD" } }),
    beforeImport: (window) => {
      window.ShopifyAnalytics = {
        meta: {
          currency: "USD",
          shop: { id: 7 },
          product: { id: "old-product" },
        },
      };
    },
  });
  const metadata = window.ShopifyAnalytics.meta;
  const provider = document.querySelector("app-provider");
  provider.cart = { items: [{ id: "stale-cart-line" }] };
  document.body.classList.add("theme-ready");
  const product = window.RomanPage.preparePage(
    themePage(productOne, {
      meta: {
        currency: "USD",
        product: {
          id: "new-product",
          description: 'Contains braces } and quotes "',
        },
      },
      extra:
        '<script type="application/json" data-selected-variant>{"id":123}</script>',
      assets:
        '<meta property="product:price:amount" content="42"><meta name="description" content="Product description">',
    }),
    new window.URL(productOne, origin),
  );
  window.RomanPage.commitPage(product);
  assert.equal(window.ShopifyAnalytics.meta, metadata);
  assert.equal(metadata.product.id, "new-product");
  assert.equal(metadata.shop.id, 7);
  assert.equal(
    document.querySelector("[data-selected-variant]").textContent,
    '{"id":123}',
  );
  assert.equal(
    document.querySelector('meta[property="product:price:amount"]').content,
    "42",
  );

  const collection = window.RomanPage.preparePage(
    themePage("/collections/all", {
      meta: { currency: "USD", collection: { id: "collection-one" } },
      collectionId: "1234",
    }),
    new window.URL("/collections/all", origin),
  );
  window.RomanPage.commitPage(collection);
  assert.equal(
    metadata.product,
    undefined,
    "old product context cannot follow the shopper to a collection",
  );
  assert.equal(metadata.collection.id, "collection-one");
  assert.equal(metadata.currency, "USD");
  assert.equal(metadata.shop.id, 7);
  assert.equal(window.__ADMIN_COLLECTION_ID__, "1234");
  assert.equal(provider.cart, window.__CART__);
  assert.equal(provider.cart.items.length, 0);
  assert.equal(
    document.querySelector('meta[property="product:price:amount"]'),
    null,
  );
  assert.equal(document.querySelector('meta[name="description"]'), null);
  assert.equal(
    document.querySelector('link[rel="canonical"]').href,
    `${origin}/collections/all`,
  );
  assert.equal(document.body.classList.contains("theme-ready"), true);
  assert.equal(document.body.classList.contains("template-product"), false);
});

test("unsupported scripts and incompatible cart modules are rejected before modifying the page", (t) => {
  const { document, window } = setup(t, undefined, {
    html: themePage("/", {
      assets: `<script type="module" src="${themeAsset("-core-cart-sections.js")}"></script>`,
    }),
  });
  const main = document.querySelector("main");
  for (const extra of [
    "<script>window.arbitraryInlineRan = true;</script>",
    '<script type="module" src="https://example.org/unrelated.js"></script>',
    `<script src="${themeAsset("legacy.js")}"></script>`,
  ]) {
    assert.throws(
      () =>
        window.RomanPage.preparePage(
          themePage(productOne, { extra }),
          new window.URL(productOne, origin),
        ),
      /Open it with normal navigation/,
    );
    assert.equal(document.querySelector("main"), main);
  }
  assert.throws(
    () =>
      window.RomanPage.preparePage(
        themePage("/cart", {
          assets: `<script type="module" src="${themeAsset("-core-cart-sections-foundation.js")}"></script>`,
        }),
        new window.URL("/cart", origin),
      ),
    /incompatible cart/,
  );
  assert.equal(document.querySelector("main"), main);
  assert.equal(window.arbitraryInlineRan, undefined);
});

test("theme modules load once across repeated page asset preparation", async (t) => {
  const { document, window } = setup(t, undefined, { html: themePage("/") });
  const source = `<script type="module" src="${themeAsset("-product.js")}"></script>`;
  const prepared = window.RomanPage.preparePage(
    themePage(productOne, { assets: source + source }),
    new window.URL(productOne, origin),
  );
  const signal = new window.AbortController().signal;
  const loading = window.RomanPage.loadPageAssets(prepared, signal);
  const selector = `script[src="${themeAsset("-product.js")}"]`;
  await until(
    () => document.querySelector(selector),
    "theme module was not requested",
  );
  assert.equal(document.querySelectorAll(selector).length, 1);
  document.querySelector(selector).dispatchEvent(new window.Event("load"));
  await loading;
  await window.RomanPage.loadPageAssets(prepared, signal);
  assert.equal(document.querySelectorAll(selector).length, 1);
});

test("failed styles and scripts warn while the page waits for every remaining asset", async (t) => {
  const failedStyle = `${themeAsset("missing.css")}?token=fixture-secret`;
  const readyStyle = themeAsset("product.css");
  const failedScript = `${themeAsset("-missing-feature.js")}?token=fixture-secret`;
  const readyScript = themeAsset("-product-feature.js");
  const { document, window, navigation, warnings } = setup(
    t,
    async (url) =>
      response(new URL(url).pathname, {
        text: async () =>
          themePage(new URL(url).pathname, {
            assets: `<link rel="stylesheet" href="${failedStyle}"><link rel="stylesheet" href="${readyStyle}">
          <script type="module" src="${failedScript}"></script><script type="module" src="${readyScript}"></script>`,
          }),
      }),
    { html: themePage("/") },
  );
  const main = document.querySelector("main");
  const visiting = navigation.navigate(productOne);
  await until(
    () => document.querySelector(`link[href="${readyStyle}"]`),
    "styles were not requested",
  );
  document
    .querySelector(`link[href="${failedStyle}"]`)
    .dispatchEvent(new window.Event("error"));
  await delay(0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[Roman\].*Could not load.*style/);
  assert.ok(warnings[0].includes(themeAsset("missing.css")));
  assert.equal(document.querySelector("main"), main);
  assert.equal(navigation.getSnapshot().pending, true);
  document
    .querySelector(`link[href="${readyStyle}"]`)
    .dispatchEvent(new window.Event("load"));
  await until(
    () => document.querySelector(`script[src="${readyScript}"]`),
    "scripts were not requested after styles settled",
  );
  document
    .querySelector(`script[src="${failedScript}"]`)
    .dispatchEvent(new window.Event("error"));
  await delay(0);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /^\[Roman\].*Could not load.*script/);
  assert.ok(warnings[1].includes(themeAsset("-missing-feature.js")));
  assert.equal(document.querySelector("main"), main);
  assert.equal(navigation.getSnapshot().pending, true);
  document
    .querySelector(`script[src="${readyScript}"]`)
    .dispatchEvent(new window.Event("load"));
  await visiting;
  assert.equal(navigation.getSnapshot().error, null);
  assert.equal(navigation.getSnapshot().pending, false);
  assert.equal(window.location.pathname, productOne);
  assert.notEqual(document.querySelector("main"), main);
  assert.ok(document.querySelector(`link[href="${readyStyle}"]`));
  assert.ok(document.querySelector(`script[src="${readyScript}"]`));
  assert.equal(document.querySelector(`link[href="${failedStyle}"]`), null);
  assert.equal(document.querySelector(`script[src="${failedScript}"]`), null);
  for (const warning of warnings) {
    assert.equal(warning.includes("fixture-secret"), false);
    assert.equal(warning.includes(productOne), false);
  }
});

test("asset timeouts warn and continue after the document request timer has been cleared", async (t) => {
  for (const kind of ["script", "style"]) {
    await t.test(kind, async (t) => {
      const timers = new Map();
      let nextTimer = 900000;
      const assetUrl = `${themeAsset(`timeout.${kind === "script" ? "js" : "css"}`)}?token=fixture-secret`;
      const selector =
        kind === "script"
          ? `script[src="${assetUrl}"]`
          : `link[href="${assetUrl}"]`;
      const asset =
        kind === "script"
          ? `<script type="module" src="${assetUrl}"></script>`
          : `<link rel="stylesheet" href="${assetUrl}">`;
      const { document, window, navigation, warnings } = setup(
        t,
        async (url) =>
          response(new URL(url).pathname, {
            text: async () =>
              themePage(new URL(url).pathname, { assets: asset }),
          }),
        {
          html: themePage("/"),
          beforeImport: (window) => {
            const setTimeout = window.setTimeout.bind(window);
            const clearTimeout = window.clearTimeout.bind(window);
            window.setTimeout = (callback, milliseconds, ...args) => {
              if (milliseconds !== 15000)
                return setTimeout(callback, milliseconds, ...args);
              const id = nextTimer++;
              timers.set(id, () => callback(...args));
              return id;
            };
            window.clearTimeout = (id) => {
              if (!timers.delete(id)) clearTimeout(id);
            };
          },
        },
      );
      const visiting = navigation.navigate(productOne);
      await until(
        () => document.querySelector(selector),
        "asset was not requested",
      );
      assert.equal(
        timers.size,
        1,
        "only the asset timeout should remain after the document has arrived",
      );
      const [id, timeout] = timers.entries().next().value;
      timers.delete(id);
      timeout();
      await visiting;
      assert.equal(navigation.getSnapshot().error, null);
      assert.equal(navigation.getSnapshot().pending, false);
      assert.equal(window.location.pathname, productOne);
      assert.equal(document.querySelector("main h1").textContent, productOne);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /^\[Roman\].*Timed out/);
      assert.ok(warnings[0].includes(assetUrl.split("?")[0]));
      assert.equal(warnings[0].includes("fixture-secret"), false);
      assert.equal(timers.size, 0);
    });
  }
});

test("superseding or disposing asset loading produces no warning or stale page commit", async (t) => {
  for (const kind of ["script", "style"]) {
    for (const action of ["supersede", "dispose"]) {
      await t.test(`${action} pending ${kind}`, async (t) => {
        const assetUrl = themeAsset(
          `pending.${kind === "script" ? "js" : "css"}`,
        );
        const selector =
          kind === "script"
            ? `script[src="${assetUrl}"]`
            : `link[href="${assetUrl}"]`;
        const asset =
          kind === "script"
            ? `<script type="module" src="${assetUrl}"></script>`
            : `<link rel="stylesheet" href="${assetUrl}">`;
        const { document, window, navigation, warnings } = setup(
          t,
          async (url) => {
            const path = new URL(url).pathname;
            return response(path, {
              text: async () =>
                themePage(path, { assets: path === productOne ? asset : "" }),
            });
          },
          { html: themePage("/") },
        );
        const visiting = navigation.navigate(productOne);
        await until(
          () => document.querySelector(selector),
          "asset was not requested",
        );
        const pendingAsset = document.querySelector(selector);
        if (action === "dispose") navigation.dispose();
        else {
          pendingAsset.dispatchEvent(new window.Event("error"));
          await navigation.navigate(productTwo);
        }
        pendingAsset.dispatchEvent(new window.Event("error"));
        pendingAsset.dispatchEvent(new window.Event("load"));
        await visiting;
        assert.equal(pendingAsset.isConnected, false);
        assert.deepEqual(warnings, []);
        const expectedPath = action === "dispose" ? "/" : productTwo;
        assert.equal(window.location.pathname, expectedPath);
        assert.equal(
          document.querySelector("main h1").textContent,
          expectedPath,
        );
      });
    }
  }
});

test("unexpected stylesheet insertion failure cancels sibling assets without warning or committing", async (t) => {
  const pendingUrl = themeAsset("pending.css");
  const brokenUrl = themeAsset("cannot-insert.css");
  const { document, window, navigation, warnings } = setup(
    t,
    async (url) =>
      response(new URL(url).pathname, {
        text: async () =>
          themePage(new URL(url).pathname, {
            assets: `<link rel="stylesheet" href="${pendingUrl}"><link rel="stylesheet" href="${brokenUrl}">`,
          }),
      }),
    { html: themePage("/") },
  );
  const main = document.querySelector("main");
  const append = document.head.append.bind(document.head);
  const assets = [];
  document.head.append = (...nodes) => {
    for (const node of nodes) {
      if (node instanceof window.HTMLLinkElement) {
        assets.push(node);
        if (node.href === brokenUrl)
          throw new window.Error("Cannot insert stylesheet");
      }
    }
    append(...nodes);
  };
  await navigation.navigate(productOne);
  assert.match(navigation.getSnapshot().error, /Cannot insert stylesheet/);
  assert.equal(navigation.getSnapshot().pending, false);
  assert.equal(document.querySelector("main"), main);
  assert.equal(window.location.pathname, "/");
  assert.equal(assets.length, 2);
  for (const asset of assets) {
    assert.equal(asset.isConnected, false);
    assert.equal(asset.onload, null);
    assert.equal(asset.onerror, null);
    asset.dispatchEvent(new window.Event("error"));
  }
  assert.deepEqual(warnings, []);
});

test("theme module initialization errors cancel pending assets and keep existing page content", async (t) => {
  const { document, window, warnings } = setup(t, undefined, {
    html: themePage("/"),
  });
  const main = document.querySelector("main");
  const moduleUrl = themeAsset("-product-with-error.js");
  const prepared = window.RomanPage.preparePage(
    themePage(productOne, {
      assets: `<script type="module" src="${moduleUrl}"></script>`,
    }),
    new window.URL(productOne, origin),
  );
  const loading = window.RomanPage.loadPageAssets(
    prepared,
    new window.AbortController().signal,
  );
  const selector = `script[src="${moduleUrl}"]`;
  await until(
    () => document.querySelector(selector),
    "theme module was not requested",
  );
  window.dispatchEvent(
    new window.ErrorEvent("error", {
      filename: moduleUrl,
      message: "Custom element was already registered",
    }),
  );
  await assert.rejects(loading, /failed to initialize.*already registered/);
  assert.equal(document.querySelector(selector), null);
  assert.equal(document.querySelector("main"), main);
  assert.deepEqual(warnings, []);
});

const stores = [
  { shop: "hd-dev-multi.myshopify.com", origin },
  {
    shop: "select-blinds-us.myshopify.com",
    origin: "https://www.selectblinds.com",
  },
  { shop: "blinds-2go.myshopify.com", origin: "https://shop.blinds-2go.co.uk" },
  {
    shop: "blinds2go-ireland.myshopify.com",
    origin: "https://www.blinds-2go.ie",
  },
];

function storePage(store, path, options = {}) {
  return themePage(path, options).replaceAll(origin, store.origin);
}

test("the LEVOLOR missing module is requested and warned about before navigation continues", async (t) => {
  const connected = [];
  const moduleUrl = `${themeAsset("-cart-remove-toggle.js")}?v=76316`;
  const { document, window, host, instance, navigation, warnings } = setup(
    t,
    async (url) =>
      response(new URL(url).pathname, {
        text: async () =>
          themePage(new URL(url).pathname, {
            extra: `<script defer="" type="module" src="${moduleUrl.replace("https:", "")}"></script><cart-remove-toggle></cart-remove-toggle>`,
          }),
      }),
    {
      html: themePage("/"),
      beforeImport: (window) =>
        window.customElements.define(
          "cart-remove-toggle",
          class extends window.HTMLElement {
            connectedCallback() {
              connected.push(this);
            }
          },
        ),
    },
  );
  const originalMain = document.querySelector("main");
  const component = window.customElements.get("cart-remove-toggle");
  const visiting = navigation.navigate(productTwo);
  await until(
    () => document.querySelector(`script[src="${moduleUrl}"]`),
    "the module must be requested even when its component is registered",
  );
  document
    .querySelector(`script[src="${moduleUrl}"]`)
    .dispatchEvent(new window.Event("error"));
  await visiting;
  assert.equal(navigation.getSnapshot().error, null);
  assert.equal(window.location.pathname, productTwo);
  assert.notEqual(document.querySelector("main"), originalMain);
  assert.equal(document.querySelector(`script[src="${moduleUrl}"]`), null);
  assert.equal(window.customElements.get("cart-remove-toggle"), component);
  assert.deepEqual(connected, [document.querySelector("cart-remove-toggle")]);
  assert.equal(document.querySelector("roman-ai-assistant"), host);
  assert.equal(host.romanInstance, instance);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[Roman\].*Could not load.*script/);
  assert.ok(warnings[0].includes(themeAsset("-cart-remove-toggle.js")));
  assert.equal(warnings[0].includes("v=76316"), false);
  assert.equal(warnings[0].includes(productTwo), false);
});

test("all storefront profiles warn and continue for an ordinary missing module", async (t) => {
  for (const store of stores) {
    await t.test(store.shop, async (t) => {
      const moduleUrl = `${store.origin}/cdn/shop/t/118/assets/-missing-product-feature.js`;
      const { document, window, navigation, warnings } = setup(
        t,
        async (url) =>
          response(new URL(url).pathname, {
            url: String(url),
            text: async () =>
              storePage(store, new URL(url).pathname, {
                extra: `<script type="module" src="${moduleUrl}"></script>`,
              }),
          }),
        {
          shop: store.shop,
          url: `${store.origin}/`,
          html: storePage(store, "/"),
        },
      );
      const main = document.querySelector("main");
      const destination = navigation.destinations.find(({ path }) =>
        path.startsWith("/products/"),
      ).path;
      const visiting = navigation.navigate(destination);
      const selector = `script[src="${moduleUrl}"]`;
      await until(
        () => document.querySelector(selector),
        "required module must still be requested",
      );
      assert.equal(document.querySelector("main"), main);
      document.querySelector(selector).dispatchEvent(new window.Event("error"));
      await visiting;
      assert.equal(navigation.getSnapshot().error, null);
      assert.equal(navigation.getSnapshot().pending, false);
      assert.notEqual(document.querySelector("main"), main);
      assert.equal(window.location.href, `${store.origin}${destination}`);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /^\[Roman\].*Could not load.*script/);
      assert.ok(warnings[0].includes(moduleUrl));
    });
  }
});

test("asset warnings do not relax theme directory or inline-handler validation", (t) => {
  const { document, window } = setup(t, undefined, {
    html: themePage("/"),
  });
  const main = document.querySelector("main");
  for (const [extra, expectedError] of [
    [
      `<script type="module" src="${origin}/cdn/shop/t/999/assets/-product-feature.js"></script>`,
      /unsupported integration/,
    ],
    [
      `<script type="module" src="${themeAsset("-product-feature.js")}" onerror="window.unexpectedCodeRan = true"></script>`,
      /inline JavaScript/,
    ],
  ]) {
    assert.throws(
      () =>
        window.RomanPage.preparePage(
          themePage(productTwo, { extra }),
          new window.URL(productTwo, origin),
        ),
      expectedError,
    );
  }
  assert.equal(window.unexpectedCodeRan, undefined);
  assert.equal(document.querySelector("main"), main);
  assert.equal(
    document.querySelector('script[src$="-product-feature.js"]'),
    null,
  );
});

test("verified Shopify identities select working shared navigation on their storefront origins", async (t) => {
  for (const store of stores) {
    await t.test(store.shop, async (t) => {
      const { document, window, host, navigation, calls } = setup(
        t,
        async (url) => {
          const path = new URL(url).pathname;
          return response(path, {
            url: String(url),
            text: async () => storePage(store, path),
          });
        },
        {
          shop: store.shop,
          url: `${store.origin}/`,
          html: storePage(store, "/"),
        },
      );
      assert.equal(document.documentElement.dataset.romanPreview, "false");
      assert.equal(window.RomanPage.selectStore(store.shop).shop, store.shop);
      const provider = document.querySelector("app-provider");
      assert.ok(navigation.destinations.some(({ path }) => path === "/"));
      assert.ok(navigation.destinations.some(({ path }) => path === "/cart"));
      for (const { path } of navigation.destinations.filter(
        ({ path }) => path !== "/",
      )) {
        await navigation.navigate(path);
        assert.equal(navigation.getSnapshot().error, null);
        assert.equal(window.location.origin, store.origin);
        assert.equal(window.location.pathname, path);
        assert.equal(document.querySelector("main h1").textContent, path);
        assert.equal(document.querySelector("roman-ai-assistant"), host);
        assert.equal(document.querySelector("app-provider"), provider);
        assert.equal(
          host.shadowRoot.querySelector("input").value,
          "Keep my measurements",
        );
      }
      const previousPath = new URL(calls.at(-2).url).pathname;
      window.history.back();
      await until(
        () => document.querySelector("main h1").textContent === previousPath,
        "profile navigation did not restore its previous page",
      );
      assert.equal(window.location.pathname, previousPath);
      assert.ok(calls.every(({ url }) => new URL(url).origin === store.origin));
    });
  }
});

test("an unrecognized Shopify identity remains inert without changing history or intercepting browsing", async (t) => {
  const { document, window, navigation, calls } = setup(t, undefined, {
    shop: "unrecognized-store.myshopify.com",
    html: themePage("/"),
  });
  const main = document.querySelector("main");
  assert.equal(navigation.destinations.length, 0);
  assert.ok(navigation.getSnapshot().error);
  navigation.setSidebarOpen(true);
  await navigation.navigate(productOne);
  assert.equal(calls.length, 0);
  assert.equal(document.querySelector("main"), main);
  assert.equal(window.location.href, `${origin}/`);
  assert.equal(window.history.length, 1);
  let intercepted;
  window.addEventListener("click", (event) => {
    intercepted = event.defaultPrevented;
    event.preventDefault();
  });
  const anchor = document.createElement("a");
  anchor.href = productOne;
  main.append(anchor);
  anchor.dispatchEvent(
    new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    }),
  );
  assert.equal(intercepted, false);
});

test("navigation rejects destination modules from a different theme revision before committing", async (t) => {
  const { document, window, navigation } = setup(
    t,
    async () =>
      response(productOne, {
        text: async () =>
          themePage(productOne).replaceAll(
            "/cdn/shop/t/118/",
            "/cdn/shop/t/999/",
          ),
      }),
    { html: themePage("/") },
  );
  const main = document.querySelector("main");
  await navigation.navigate(productOne);
  assert.ok(navigation.getSnapshot().error);
  assert.equal(document.querySelector("main"), main);
  assert.equal(window.location.pathname, "/");
  assert.equal(document.querySelector('script[src*="/cdn/shop/t/999/"]'), null);
});

test("a page cannot inherit a shell missing its required cart drawer", async (t) => {
  const { document, window, navigation } = setup(
    t,
    async () =>
      response(productOne, {
        text: async () =>
          themePage(productOne).replace(
            "</app-provider>",
            '<div id="shopify-section-cart-drawer-dialog">Cart drawer</div></app-provider>',
          ),
      }),
    { html: themePage("/cart"), url: `${origin}/cart` },
  );
  const main = document.querySelector("main");
  await navigation.navigate(productOne);
  assert.ok(navigation.getSnapshot().error);
  assert.equal(document.querySelector("main"), main);
  assert.equal(window.location.pathname, "/cart");
});

test("a forward page visit changes the browser URL only once", async (t) => {
  const { window, navigation } = setup(t);
  const changes = [];
  for (const method of ["pushState", "replaceState"]) {
    const original = window.history[method].bind(window.history);
    window.history[method] = (...args) => {
      const previous = window.location.href;
      original(...args);
      if (window.location.href !== previous) changes.push(window.location.href);
    };
  }
  await navigation.navigate(productOne);
  assert.deepEqual(changes, [`${origin}${productOne}`]);
});

test("UK and Ireland cart return controls use managed Back after closing Roman and retain native fallback after disposal", async (t) => {
  for (const store of stores.slice(2)) {
    await t.test(store.shop, async (t) => {
      const handler =
        store.shop === "blinds2go-ireland.myshopify.com"
          ? "history.back();"
          : `if (history.length > 1) { history.back(); } else { window.location.href = '${store.origin}'; }`;
      const { document, window, host, navigation } = setup(
        t,
        async (url) => {
          const path = new URL(url).pathname;
          return response(path, {
            url: String(url),
            text: async () =>
              storePage(store, path, {
                extra:
                  path === "/cart"
                    ? `<button id="continue-shopping" type="button" onclick="${handler}">Continue shopping</button>`
                    : "",
              }),
          });
        },
        {
          shop: store.shop,
          url: `${store.origin}/`,
          html: storePage(store, "/"),
        },
      );
      const product = navigation.destinations.find(({ path }) =>
        path.startsWith("/products/"),
      );
      assert.ok(product);
      navigation.setSidebarOpen(true);
      await navigation.navigate(product.path);
      await navigation.navigate("/cart");
      assert.equal(navigation.getSnapshot().error, null);
      const control = document.querySelector("#continue-shopping");
      assert.equal(control.tagName, "A");
      assert.equal(control.getAttribute("onclick"), null);
      assert.equal(control.href, `${store.origin}/`);
      navigation.setSidebarOpen(false);
      let intercepted;
      window.addEventListener("click", (event) => {
        intercepted = event.defaultPrevented;
        event.preventDefault();
      });
      control.dispatchEvent(
        new window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
      assert.equal(intercepted, true);
      await until(
        () => document.querySelector("main h1").textContent === product.path,
        "cart return control did not restore the previous product",
      );
      assert.equal(document.querySelector("roman-ai-assistant"), host);
      assert.equal(
        host.shadowRoot.querySelector("input").value,
        "Keep my measurements",
      );
      await navigation.navigate("/cart");
      navigation.dispose();
      const nativeControl = document.querySelector("#continue-shopping");
      nativeControl.dispatchEvent(
        new window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
      assert.equal(intercepted, false);
      assert.equal(nativeControl.href, `${store.origin}/`);
    });
  }
});

test("cart handler normalization refuses extra code and cross-origin fallback destinations", (t) => {
  for (const store of stores.slice(2)) {
    const { window, document } = setup(t, undefined, {
      shop: store.shop,
      url: `${store.origin}/`,
      html: storePage(store, "/"),
    });
    const main = document.querySelector("main");
    for (const handler of [
      "history.back(); window.unexpectedCodeRan = true;",
      "if (history.length > 1) { history.back(); } else { window.location.href = 'https://example.org'; }",
    ]) {
      assert.throws(
        () =>
          window.RomanPage.preparePage(
            storePage(store, "/cart", {
              extra: `<button onclick="${handler}">Continue shopping</button>`,
            }),
            new window.URL("/cart", store.origin),
          ),
        /inline JavaScript/,
      );
      assert.equal(document.querySelector("main"), main);
      assert.equal(window.unexpectedCodeRan, undefined);
    }
  }
});

test("collection-scoped URLs can reach configured products but cannot expand the destination allowlist", async (t) => {
  const { document, window, navigation, calls } = setup(t, async (url) =>
    response(new URL(url).pathname),
  );
  const scoped = `/collections/all${productOne}`;
  await navigation.navigate(scoped);
  assert.equal(navigation.getSnapshot().error, null);
  assert.equal(window.location.pathname, scoped);
  assert.equal(document.querySelector("main h1").textContent, scoped);
  const main = document.querySelector("main");
  await navigation.navigate("/collections/all/products/unknown-product");
  assert.ok(navigation.getSnapshot().error);
  assert.equal(calls.length, 1);
  assert.equal(document.querySelector("main"), main);
  assert.equal(window.location.pathname, scoped);
});

const walletPath =
  "/cdn/shopifycloud/portable-wallets/latest/portable-wallets.en.js";

function walletPage(
  store,
  path,
  {
    walletUrl = `${store.origin}${walletPath}`,
    walletAttributes = 'onerror="portableWalletsCleanup(this)" crossorigin="anonymous"',
    duplicate = false,
  } = {},
) {
  const cartModule = `<script type="module" src="${store.origin}/cdn/shop/t/118/assets/-core-cart-sections-foundation.js"></script>`;
  const walletModule = `<script type="module" src="${walletUrl}" ${walletAttributes}></script>`;
  return storePage(store, path, {
    assets:
      cartModule +
      (path === "/cart" ? walletModule.repeat(duplicate ? 2 : 1) : ""),
    extra:
      path === "/cart"
        ? "<shopify-accelerated-checkout-cart></shopify-accelerated-checkout-cart>"
        : "",
  });
}

test("SelectBlinds and UK wallet modules load once before their cart components connect", async (t) => {
  for (const store of stores.slice(1, 3)) {
    await t.test(store.shop, async (t) => {
      const { document, window, navigation } = setup(
        t,
        async (url) =>
          response(new URL(url).pathname, {
            url: String(url),
            text: async () =>
              walletPage(store, new URL(url).pathname, { duplicate: true }),
          }),
        {
          shop: store.shop,
          url: `${store.origin}/`,
          html: walletPage(store, "/"),
        },
      );
      const main = document.querySelector("main");
      const connected = [];
      const selector = `script[src="${store.origin}${walletPath}"]`;
      const visiting = navigation.navigate("/cart");
      await until(
        () => document.querySelector(selector),
        "wallet SDK was not requested",
      );
      assert.equal(document.querySelector("main"), main);
      assert.equal(document.querySelectorAll(selector).length, 1);
      assert.equal(
        document.querySelector(selector).getAttribute("onerror"),
        null,
      );
      assert.equal(navigation.getSnapshot().pending, true);
      window.customElements.define(
        "shopify-accelerated-checkout-cart",
        class extends window.HTMLElement {
          connectedCallback() {
            connected.push(document.querySelector("main h1").textContent);
          }
        },
      );
      assert.deepEqual(connected, []);
      document.querySelector(selector).dispatchEvent(new window.Event("load"));
      await visiting;
      assert.equal(navigation.getSnapshot().error, null);
      assert.deepEqual(connected, ["/cart"]);
      assert.equal(window.location.pathname, "/cart");
      await navigation.navigate("/");
      await navigation.navigate("/cart");
      assert.equal(navigation.getSnapshot().error, null);
      assert.equal(document.querySelectorAll(selector).length, 1);
      assert.deepEqual(connected, ["/cart", "/cart"]);
    });
  }
});

test("wallet network, registration and initialization failures preserve the current page", async (t) => {
  const store = stores[2];
  for (const failure of ["network", "missing registration", "initialization"]) {
    await t.test(failure, async (t) => {
      const { document, window, navigation, warnings } = setup(
        t,
        async (url) =>
          response(new URL(url).pathname, {
            url: String(url),
            text: async () => walletPage(store, new URL(url).pathname),
          }),
        {
          shop: store.shop,
          url: `${store.origin}/`,
          html: walletPage(store, "/"),
        },
      );
      const main = document.querySelector("main");
      window.portableWalletsCleanup = () =>
        assert.fail(
          "Fetched wallet cleanup must not run against the current page",
        );
      const visiting = navigation.navigate("/cart");
      const selector = `script[src="${store.origin}${walletPath}"]`;
      await until(
        () => document.querySelector(selector),
        "wallet SDK was not requested",
      );
      if (failure === "initialization") {
        window.customElements.define(
          "shopify-accelerated-checkout-cart",
          class extends window.HTMLElement {},
        );
        window.dispatchEvent(
          new window.ErrorEvent("error", {
            filename: `${store.origin}${walletPath}`,
            message: "Wallet initialization failed after registration",
          }),
        );
      } else {
        document
          .querySelector(selector)
          .dispatchEvent(
            new window.Event(failure === "network" ? "error" : "load"),
          );
      }
      await visiting;
      assert.ok(navigation.getSnapshot().error);
      assert.equal(navigation.getSnapshot().pending, false);
      assert.equal(document.querySelector("main"), main);
      assert.equal(window.location.href, `${store.origin}/`);
      if (failure === "network") {
        assert.match(
          navigation.getSnapshot().error,
          /wallet components did not initialize/,
        );
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /^\[Roman\].*Could not load.*script/);
        assert.ok(warnings[0].includes(`${store.origin}${walletPath}`));
      } else assert.deepEqual(warnings, []);
    });
  }
});

test("wallet cleanup and CORS attributes are optional and strictly bounded", (t) => {
  const store = stores[2];
  const { document, window } = setup(t, undefined, {
    shop: store.shop,
    url: `${store.origin}/`,
    html: walletPage(store, "/"),
  });
  const main = document.querySelector("main");
  const prepare = (walletAttributes) =>
    window.RomanPage.preparePage(
      walletPage(store, "/cart", { walletAttributes }),
      new window.URL("/cart", store.origin),
    );
  for (const attributes of [
    "",
    'crossorigin="anonymous"',
    'onerror=" portableWalletsCleanup(this); "',
  ]) {
    const prepared = prepare(attributes);
    assert.equal(prepared.integration.modules.length, 1);
    assert.equal(prepared.main.querySelector("script[onerror]"), null);
  }
  for (const attributes of [
    'onerror="window.unexpectedCodeRan = true" crossorigin="anonymous"',
    'onerror="portableWalletsCleanup(this); window.unexpectedCodeRan = true"',
    'onerror="portableWalletsCleanup(this)" crossorigin="use-credentials"',
    'crossorigin="unexpected"',
  ]) {
    assert.throws(
      () => prepare(attributes),
      /unsupported Shopify wallet configuration/,
    );
  }
  assert.equal(window.unexpectedCodeRan, undefined);
  assert.equal(document.querySelector("main"), main);
  assert.equal(
    document.querySelector(`script[src="${store.origin}${walletPath}"]`),
    null,
  );
});

test("wallet support does not allow unrecognized hosts, SDK endpoints or Ireland integrations", (t) => {
  for (const [store, walletUrl] of [
    [stores[2], `https://example.org${walletPath}`],
    [stores[2], `${stores[2].origin}/cdn/shopifycloud/other-sdk.js`],
    [stores[3], `${stores[3].origin}${walletPath}`],
  ]) {
    const { document, window } = setup(t, undefined, {
      shop: store.shop,
      url: `${store.origin}/`,
      html: walletPage(store, "/"),
    });
    const main = document.querySelector("main");
    assert.throws(
      () =>
        window.RomanPage.preparePage(
          walletPage(store, "/cart", { walletUrl }),
          new window.URL("/cart", store.origin),
        ),
      /unsupported integration/,
    );
    assert.equal(document.querySelector("main"), main);
    assert.equal(document.querySelector(`script[src="${walletUrl}"]`), null);
  }
});
