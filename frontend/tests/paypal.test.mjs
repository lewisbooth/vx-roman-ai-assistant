import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const origin = "https://hd-dev-multi.myshopify.com";
const sdk =
  "https://www.paypal.com/sdk/js?client-id=test-merchant&components=buttons,messages&locale=en_US";
const bundle = await build({
  stdin: {
    contents:
      'export * from "./frontend/src/navigation/shared/page"; export { selectStore } from "./frontend/src/navigation/themes";',
    resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
    sourcefile: "paypal-test-entry.ts",
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanPage",
  platform: "browser",
});

function sdkTag(src = sdk, attributes = 'id="paypal-script" defer', body = "") {
  return `<script src="${src}" ${attributes}>${body}</script>`;
}

function themePage(path, extra = "", storeOrigin = origin) {
  return `<!doctype html><html><head><title>Store ${path}</title>
    <script type="module" src="${storeOrigin}/cdn/shop/t/370/assets/-app-provider.js"></script>
    <script>window.__ADMIN_COLLECTION_ID__ = '';
      window.__CART__ = {"items":[]}; window.__CART_COLOR_SWATCHES__ = {};</script>
    <script>var meta = {"currency":"USD","page":{"pageType":"product"}};
      for (var attr in meta) window.ShopifyAnalytics.meta[attr] = meta[attr];</script>
    </head><body class="template-product"><app-provider>
    <header>Store header</header><main id="main"><h1>${path}</h1>${extra}</main>
    <footer>Store footer</footer></app-provider></body></html>`;
}

function readySdk(window) {
  window.paypal = {
    Buttons() {
      assert.fail("Roman must not create PayPal checkout buttons");
    },
    Messages() {
      assert.fail("The theme and PayPal SDK own message rendering");
    },
  };
}

function setup(
  t,
  {
    storeOrigin = origin,
    html = themePage("/", "", storeOrigin),
    beforeImport,
    shop = "hd-dev-multi.myshopify.com",
  } = {},
) {
  const dom = new JSDOM(html, {
    url: `${storeOrigin}/`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  const errors = [];
  window.console.error = (...args) => errors.push(args);
  const initialScripts = new Set(document.querySelectorAll("script[src]"));
  const insertedScripts = new Set();
  const observer = new window.MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (
          node instanceof window.HTMLScriptElement &&
          isSdk(node) &&
          !initialScripts.has(node)
        ) {
          insertedScripts.add(node);
        }
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  beforeImport?.(window);
  window.eval(`${bundle.outputFiles[0].text}\nwindow.RomanPage = RomanPage;`);
  const theme = window.RomanPage.selectStore(shop).theme;
  t.after(() => {
    observer.disconnect();
    window.close();
  });
  return {
    window,
    document,
    insertedScripts,
    errors,
    prepare: (path, extra = sdkTag()) =>
      window.RomanPage.preparePage(
        themePage(path, extra, storeOrigin),
        new window.URL(path, storeOrigin),
        theme,
      ),
    load: (page, signal = new window.AbortController().signal) =>
      window.RomanPage.loadPageAssets(page, signal),
    commit: (page) => window.RomanPage.commitPage(page),
  };
}

function isSdk(script) {
  return script.src.startsWith("https://www.paypal.com/sdk/js?");
}

function pendingSdk(document) {
  return [...document.querySelectorAll("script[src]")].find(isSdk);
}

async function until(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(message);
}

test("known PayPal scripts are prepared without activating the theme's unpriced message", async (t) => {
  const { prepare, load, document, window } = setup(t);
  for (const script of [
    sdkTag(),
    sdkTag(sdk.replace("buttons,messages", "messages,buttons")),
    sdkTag(
      `${sdk}&currency=USD`,
      'id="paypal-script" type="text/javascript" async',
    ),
  ]) {
    const prepared = prepare(
      "/products/one",
      `${script}<div data-pp-container data-pp-amount=""></div>
      <script type="application/json">{"variant":123}</script>`,
    );
    assert.ok(prepared.paypalSdk instanceof window.URL);
    assert.equal(prepared.main.querySelector("script[src]"), null);
    assert.equal(prepared.main.querySelector("[data-pp-message]"), null);
    assert.equal(
      prepared.main.querySelector('script[type="application/json"]')
        .textContent,
      '{"variant":123}',
    );
  }
  const withoutSdk = prepare("/", "");
  assert.equal(withoutSdk.paypalSdk, null);
  await load(withoutSdk);
  assert.equal(pendingSdk(document), undefined);
});

test("the PayPal exception rejects unknown scripts, SDK options and unsupported attributes", (t) => {
  const { prepare, document } = setup(t);
  const main = document.querySelector("main");
  const unsupported = [
    sdkTag(sdk, 'id="unrelated-script"'),
    sdkTag(sdk.replace("https:", "http:")),
    sdkTag(sdk.replace("www.paypal.com", "www.paypal.com.example.org")),
    sdkTag(sdk.replace("/sdk/js?", "/sdk/other?")),
    sdkTag(sdk.replace("test-merchant", "")),
    sdkTag(sdk.replace("buttons,messages", "messages")),
    sdkTag(sdk.replace("buttons,messages", "buttons,messages,card-fields")),
    sdkTag(`${sdk}&unknown-option=true`),
    sdkTag(`${sdk}&client-id=another-merchant`),
    sdkTag(sdk, 'id="paypal-script" type="module"'),
    ...[
      "data-namespace",
      "data-uid-auto",
      "nonce",
      "crossorigin",
      "referrerpolicy",
      "onload",
    ].map((name) => sdkTag(sdk, `id="paypal-script" ${name}="unsupported"`)),
    sdkTag(sdk, 'id="paypal-script"', "window.inlineRan = true;"),
  ];
  for (const script of unsupported) {
    assert.throws(() => prepare("/products/one", script), undefined, script);
    assert.equal(document.querySelector("main"), main);
  }
});

test("an initialized SDK survives removal of its original product-page script", async (t) => {
  const context = setup(t, {
    html: themePage("/products/one", sdkTag()),
    beforeImport: readySdk,
  });
  const { prepare, load, commit, document, insertedScripts } = context;
  const original = pendingSdk(document);
  const home = prepare("/", "");
  await load(home);
  commit(home);
  original.remove();
  assert.equal(original.isConnected, false);
  const product = prepare("/products/two");
  await load(product);
  commit(product);
  await delay(0);
  assert.equal(insertedScripts.size, 0);
  assert.equal(document.querySelector("h1").textContent, "/products/two");
});

test("an initial SDK's own runtime marker does not prevent reuse", async (t) => {
  const { prepare, load, commit, insertedScripts } = setup(t, {
    html: themePage("/products/one", sdkTag()),
    beforeImport(window) {
      pendingSdk(window.document).setAttribute(
        "data-uid-auto",
        "sdk-assigned-id",
      );
      readySdk(window);
    },
  });
  const product = prepare("/products/two");
  await load(product);
  commit(product);
  await delay(0);
  assert.equal(insertedScripts.size, 0);
});

test("a pending initial UK SDK survives a visit to Home and serves the next product", async (t) => {
  const storeOrigin = "https://shop.blinds-2go.co.uk";
  const { window, document, prepare, load, commit, insertedScripts } = setup(
    t,
    {
      shop: "blinds-2go.myshopify.com",
      storeOrigin,
      html: themePage("/products/one", sdkTag(), storeOrigin),
    },
  );
  const original = pendingSdk(document);
  const home = prepare("/", "");
  await load(home);
  commit(home);
  assert.equal(original.isConnected, true);
  assert.equal(document.querySelector("main").contains(original), false);
  const product = prepare("/products/two");
  let loaded = false;
  const loading = load(product).then(() => {
    loaded = true;
  });
  await delay(0);
  assert.equal(loaded, false);
  assert.equal(pendingSdk(document), original);
  readySdk(window);
  original.dispatchEvent(new window.Event("load"));
  await loading;
  commit(product);
  assert.equal(insertedScripts.size, 0);
  assert.equal(document.querySelector("h1").textContent, "/products/two");
});

test("SDK readiness precedes product connection and the same SDK serves later products", async (t) => {
  const { window, document, prepare, load, commit, insertedScripts } = setup(t);
  const connected = [];
  window.customElements.define(
    "paypal-product-probe",
    class extends window.HTMLElement {
      connectedCallback() {
        connected.push({ page: this.id, ready: !!window.paypal?.Messages });
      }
    },
  );
  const first = prepare(
    "/products/one",
    `${sdkTag()}<paypal-product-probe id="one"></paypal-product-probe>`,
  );
  let loaded = false;
  const loading = load(first).then(() => {
    loaded = true;
  });
  await until(() => pendingSdk(document), "PayPal SDK was not requested");
  assert.equal(loaded, false);
  assert.deepEqual(connected, []);
  assert.equal(document.querySelector("h1").textContent, "/");
  readySdk(window);
  pendingSdk(document).dispatchEvent(new window.Event("load"));
  await loading;
  commit(first);

  const equivalentSdk =
    "https://www.paypal.com/sdk/js?locale=en_US&components=messages,buttons&client-id=test-merchant";
  const second = prepare(
    "/products/two",
    `${sdkTag(equivalentSdk)}<paypal-product-probe id="two"></paypal-product-probe>`,
  );
  await load(second);
  commit(second);
  await delay(0);
  assert.equal(insertedScripts.size, 1);
  assert.deepEqual(connected, [
    { page: "one", ready: true },
    { page: "two", ready: true },
  ]);
});

test("canceling one navigation leaves the shared SDK load available to another", async (t) => {
  const { window, document, prepare, load, insertedScripts } = setup(t);
  const firstController = new window.AbortController();
  const first = load(prepare("/products/one"), firstController.signal);
  const canceled = assert.rejects(
    first,
    (error) => error.name === "AbortError",
  );
  await until(() => pendingSdk(document), "PayPal SDK was not requested");
  const second = load(prepare("/products/two"));
  firstController.abort();
  await canceled;
  readySdk(window);
  pendingSdk(document).dispatchEvent(new window.Event("load"));
  await second;
  assert.equal(insertedScripts.size, 1);
});

for (const failure of ["network", "timeout", "missing API"]) {
  test(`PayPal ${failure} failure preserves the page and requires reload before retry`, async (t) => {
    let timeout;
    const { window, document, prepare, load, insertedScripts } = setup(t, {
      beforeImport(window) {
        if (failure !== "timeout") return;
        const setTimeout = window.setTimeout.bind(window);
        window.setTimeout = (callback, milliseconds, ...args) => {
          if (milliseconds === 15000) {
            timeout = callback;
            return 0;
          }
          return setTimeout(callback, milliseconds, ...args);
        };
      },
    });
    const main = document.querySelector("main");
    const product = prepare("/products/one");
    const rejected = assert.rejects(load(product), /reload/i);
    await until(() => pendingSdk(document), "PayPal SDK was not requested");
    if (failure === "timeout") {
      assert.equal(typeof timeout, "function");
      timeout();
    } else {
      if (failure === "missing API") window.paypal = { Buttons() {} };
      pendingSdk(document).dispatchEvent(
        new window.Event(failure === "network" ? "error" : "load"),
      );
    }
    await rejected;
    await assert.rejects(load(product), /reload/i);
    await delay(0);
    assert.equal(document.querySelector("main"), main);
    assert.equal(insertedScripts.size, 1);
  });
}

test("a page cannot replace the initialized SDK with a different merchant or locale", async (t) => {
  const { prepare, load, document, insertedScripts } = setup(t, {
    html: themePage("/products/one", sdkTag()),
    beforeImport: readySdk,
  });
  const main = document.querySelector("main");
  for (const different of [
    sdk.replace("test-merchant", "different-merchant"),
    sdk.replace("en_US", "en_GB"),
    `${sdk}&currency=GBP`,
  ]) {
    await assert.rejects(
      async () => load(prepare("/products/two", sdkTag(different))),
      /PayPal/i,
    );
    assert.equal(document.querySelector("main"), main);
  }
  assert.equal(insertedScripts.size, 0);
});

test("shared PayPal support is optional across stores and retains SDK configuration guards", async (t) => {
  for (const { shop, storeOrigin, products } of [
    {
      shop: "hd-dev-multi.myshopify.com",
      storeOrigin: origin,
      products: [
        "/products/traditional-room-darkening-zebra-shades",
        "/products/2-inch-levolor-classic-neutral-faux-wood-blinds",
      ],
    },
    {
      shop: "hd-dev-single.myshopify.com",
      storeOrigin: "https://hd-dev-single.myshopify.com",
      products: [
        "/products/lottie-mojito-roman-blind",
        "/products/bifold-clickfit-duoshade-obsidian-pleated-blind",
      ],
    },
    {
      shop: "select-blinds-us.myshopify.com",
      storeOrigin: "https://www.selectblinds.com",
      products: ["/products/classic-roman-shades"],
    },
    {
      shop: "blinds-2go.myshopify.com",
      storeOrigin: "https://shop.blinds-2go.co.uk",
      products: ["/products/sevilla-blackout-grey-roller-blind"],
    },
    {
      shop: "blinds2go-ireland.myshopify.com",
      storeOrigin: "https://www.blinds-2go.ie",
      products: ["/products/sevilla-blackout-grey-roller-blind"],
    },
  ]) {
    await t.test(shop, async (t) => {
      const {
        prepare,
        load,
        commit,
        window,
        document,
        insertedScripts,
        errors,
      } = setup(t, { shop, storeOrigin });
      await load(prepare("/", ""));
      assert.equal(pendingSdk(document), undefined);
      assert.equal(insertedScripts.size, 0);
      for (const path of products) {
        const main = document.querySelector("main");
        const product = prepare(path);
        const loading = load(product);
        if (!window.paypal) {
          await until(
            () => pendingSdk(document),
            "shared PayPal SDK was not requested",
          );
          assert.equal(document.querySelector("main"), main);
          readySdk(window);
          pendingSdk(document).dispatchEvent(new window.Event("load"));
        }
        await loading;
        commit(product);
        assert.equal(document.querySelector("h1").textContent, path);
      }
      const home = prepare("/", "");
      assert.equal(home.paypalSdk, null);
      await load(home);
      commit(home);
      await delay(0);
      assert.equal(insertedScripts.size, 1);
      assert.deepEqual(errors, []);
      const main = document.querySelector("main");
      assert.throws(
        () => prepare(products[0], sdkTag(`${sdk}&unknown-option=true`)),
        /unsupported PayPal SDK configuration/,
      );
      assert.throws(
        () => prepare(products[0], sdkTag() + sdkTag()),
        /multiple PayPal SDK scripts/,
      );
      assert.equal(document.querySelector("main"), main);
      assert.equal(insertedScripts.size, 1);
    });
  }
});
