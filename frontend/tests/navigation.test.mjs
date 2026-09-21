import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import jsdomInternals from "jsdom/lib/jsdom/living/generated/utils.js";
import {
  productOne,
  productTwo,
  storeFixtures,
} from "./helpers/navigation-stores.mjs";

const origin = storeFixtures.devMulti.origin;
const stores = Object.values(storeFixtures);
const bundle = await build({
  stdin: {
    contents: `
      export * from "./frontend/src/navigation/shared/index";
      export { createStorefrontScroll } from "./frontend/src/storefront-scroll";
    `,
    resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
    loader: "ts",
  },
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

test("automatic navigation blocks mutation paths and never follows redirects or native fallback", async (t) => {
  const ctx = setup(t, async (_url, options) => {
    assert.equal(options.redirect, "error");
    throw new TypeError("Redirect blocked");
  });
  for (const path of ["/cart/123:1?storefront=true", "/cart/clear", "/en-gb/%63art/add", "/apps/redirect"]) {
    assert.equal(await ctx.navigation.navigate(path, undefined, { source: "model" }), "failed");
  }
  assert.equal(ctx.calls.length, 0);
  assert.equal(await ctx.navigation.navigate(productOne, undefined, { source: "model" }), "failed");
  assert.equal(ctx.calls.length, 1);
  assert.deepEqual(ctx.native, []);
  assert.equal(ctx.window.location.href, `${origin}/`);
});

test("automatic navigation still commits an ordinary product page", async (t) => {
  const ctx = setup(t);
  assert.equal(await ctx.navigation.navigate(productOne, undefined, { source: "model" }), "navigated");
  assert.equal(ctx.calls[0].options.redirect, "error");
  assert.equal(ctx.window.location.pathname, productOne);
  assert.deepEqual(ctx.native, []);
});



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
  const native = captureNativeNavigation(window);
  const calls = [];
  const warnings = [];
  const errors = [];
  window.console.warn = (...args) => warnings.push(args.map(String).join(" "));
  window.console.error = (...args) => errors.push(args);
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
  const storefrontScroll = options.lockedScroll
    ? window.RomanNavigation.createStorefrontScroll()
    : undefined;
  storefrontScroll?.setLocked(true);
  const navigation = window.RomanNavigation.createStorefrontNavigation(
    host,
    storefrontScroll,
  );
  t.after(() => {
    navigation.dispose();
    storefrontScroll?.dispose();
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
    errors,
    native,
    storefrontScroll,
  };
}

async function until(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(message);
}

function captureNativeNavigation(window) {
  // Location methods cannot be replaced on the public DOM object in JSDOM.
  // Observe its implementation so tests never attempt real page navigation.
  const location = jsdomInternals.implForWrapper(window.location);
  const calls = [];
  for (const method of ["assign", "replace", "reload"]) {
    location[method] = (url) =>
      calls.push({ method, url: url ?? window.location.href });
  }
  return calls;
}

function installThemeHeader(
  t,
  window,
  { scrollTop = 640, hasReset = true } = {},
) {
  const { document } = window;
  const header = document.createElement("main-header");
  const content = document.querySelector("header");
  content.replaceWith(header);
  header.append(content);
  const hiddenClasses = [
    "opacity-0",
    "pointer-events-none",
    "sticky",
    "top-0",
    "invisible",
  ];
  const hide = () => {
    content.classList.add(...hiddenClasses);
    document.documentElement.style.setProperty("--header-height", "0px");
  };
  hide();
  let top = scrollTop;
  const root = document.documentElement;
  Object.defineProperties(window, {
    scrollY: { configurable: true, get: () => top },
    pageYOffset: { configurable: true, get: () => top },
  });
  Object.defineProperties(root, {
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value) => {
        top = value;
      },
    },
    scrollHeight: {
      configurable: true,
      get: () => Number(document.querySelector("main").dataset.height ?? 3000),
    },
    scrollWidth: {
      configurable: true,
      get: () => Number(document.querySelector("main").dataset.width ?? 1280),
    },
  });
  header.currentScrollTop = top;
  header.initialHeight = root.scrollHeight;
  header.initialWidth = root.scrollWidth;
  const resets = [];
  if (hasReset) {
    header.reset = () => {
      resets.push({
        main: document.querySelector("main"),
        top,
        pathname: window.location.pathname,
      });
      content.classList.remove(...hiddenClasses);
      // Theme reset returns the header to normal flow, clearing reserved sticky height.
      root.style.setProperty("--header-height", "0px");
    };
  }
  const observed = { dimensionSkips: 0, scrollEvents: 0 };
  const onScroll = () => {
    observed.scrollEvents++;
    // The real theme skips visibility handling on its first event after a
    // page-size change, which can leave an already-hidden header at scroll 0.
    if (
      header.initialHeight !== root.scrollHeight ||
      header.initialWidth !== root.scrollWidth
    ) {
      header.initialHeight = root.scrollHeight;
      header.initialWidth = root.scrollWidth;
      observed.dimensionSkips++;
      return;
    }
    if (top <= 0) header.reset?.();
    else if (top > header.currentScrollTop) hide();
    header.currentScrollTop = top;
  };
  window.addEventListener("scroll", onScroll);
  t.after(() => window.removeEventListener("scroll", onScroll));
  window.scrollTo = ({ top: nextTop }) => {
    top = nextTop;
    window.dispatchEvent(new window.Event("scroll"));
  };
  return { header, content, resets, observed, hide };
}

test("representative destinations replace store content without remounting Roman or its surrounding theme", async (t) => {
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
    assert.equal(await navigation.navigate(path), "navigated");
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

test("repeating the idle current URL preserves page state without fetching, scrolling or changing history", async (t) => {
  const current = `${origin}${productOne}?preview_theme_id=118#details`;
  const { document, window, navigation, calls, native } = setup(t, undefined, {
    html: page(productOne, '<input id="measurement" value="300">'),
    url: `${origin}${productOne}`,
  });
  // Theme-owned URL changes can leave Roman's snapshot behind the browser.
  const state = { selectedVariant: 123 };
  window.history.replaceState(state, "", current);
  await navigation.navigate("https://example.org/products/other");
  assert.ok(navigation.getSnapshot().error);
  const main = document.querySelector("main");
  const input = document.querySelector("#measurement");
  input.value = "400";
  input.focus();
  const markup = document.documentElement.outerHTML;
  const historyLength = window.history.length;
  const restoration = window.history.scrollRestoration;
  for (const method of ["pushState", "replaceState"]) {
    window.history[method] = () =>
      assert.fail("Same-page navigation changed history");
  }
  window.scrollTo = () => assert.fail("Same-page navigation changed scroll");
  let journeyEvents = 0;
  document.addEventListener("roman:navigation", () => journeyEvents++);

  // Inherited preview_theme_id must be included in the exact comparison.
  assert.equal(await navigation.navigate(`${productOne}#details`), "navigated");
  assert.equal(calls.length, 0);
  assert.deepEqual(native, []);
  assert.equal(document.querySelector("main"), main);
  assert.equal(document.documentElement.outerHTML, markup);
  assert.equal(document.activeElement, input);
  assert.equal(input.value, "400");
  assert.equal(window.location.href, current);
  assert.equal(window.history.length, historyLength);
  assert.equal(window.history.state, state);
  assert.equal(window.history.scrollRestoration, restoration);
  assert.equal(journeyEvents, 0);
  assert.equal(navigation.getSnapshot().url, current);
  assert.equal(navigation.getSnapshot().pending, false);
  assert.equal(navigation.getSnapshot().error, null);
});

test("query and fragment changes are not treated as repeated current-page requests", async (t) => {
  for (const suffix of ["?variant=123", "#details"]) {
    await t.test(suffix, async (t) => {
      const { document, window, navigation, calls } = setup(
        t,
        async (url) => response(productOne, { url: String(url) }),
        { html: page(productOne), url: `${origin}${productOne}` },
      );
      const main = document.querySelector("main");
      assert.equal(
        await navigation.navigate(`${productOne}${suffix}`),
        "navigated",
      );
      assert.equal(calls.length, 1);
      assert.equal(window.location.href, `${origin}${productOne}${suffix}`);
      assert.notEqual(document.querySelector("main"), main);
      assert.equal(window.history.length, 2);
    });
  }
});

test("a current-URL request supersedes pending navigation instead of leaving it active", async (t) => {
  let finish;
  const { document, window, navigation, calls, native } = setup(t, (url) => {
    const path = new URL(url).pathname;
    return path === productOne
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(response(path));
  });
  const pending = navigation.navigate(productOne);
  await until(() => finish, "The pending request did not start");
  assert.equal(navigation.getSnapshot().pending, true);
  assert.equal(await navigation.navigate("/"), "navigated");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.signal.aborted, true);
  finish(response(productOne));
  assert.equal(await pending, "cancelled");
  assert.equal(window.location.pathname, "/");
  assert.equal(document.querySelector("main h1").textContent, "/");
  assert.equal(navigation.getSnapshot().pending, false);
  assert.deepEqual(native, []);
});

test("failed requests and invalid destination documents load the trusted destination normally", async (t) => {
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
    [
      "same-origin authentication redirect",
      async () =>
        response("/password", {
          text: async () =>
            '<html><head><title>Sign in</title></head><body class="template-password"></body></html>',
        }),
      "/password",
    ],
    [
      "same-origin redirected HTTP failure",
      async () => response("/pages/unavailable", { ok: false, status: 500 }),
      "/pages/unavailable",
    ],
    [
      "non-HTML response",
      async () =>
        response(productOne, { headers: { get: () => "application/json" } }),
    ],
  ];
  for (const [name, fetch, expected = productOne] of cases) {
    await t.test(name, async (t) => {
      const { document, window, navigation, errors } = setup(t, fetch);
      const native = captureNativeNavigation(window);
      const main = document.querySelector("main");
      await navigation.navigate(productOne);
      assert.equal(navigation.getSnapshot().error, null);
      assert.equal(Boolean(navigation.getSnapshot().pending), false);
      assert.equal(document.querySelector("main"), main);
      assert.equal(window.location.href, `${origin}/`);
      assert.equal(document.title, "Store /");
      assert.deepEqual(native, [
        { method: "assign", url: `${origin}${expected}` },
      ]);
      assert.equal(errors.length, 1);
      assert.match(
        errors[0][0],
        /Storefront navigation failed; loading the full page/,
      );
      assert.equal(errors[0][1].destination, `${origin}${expected}`);
    });
  }
});

test("invalid destination URLs neither fetch nor invoke normal navigation", async (t) => {
  const { document, window, navigation, calls, native, errors } = setup(t);
  const main = document.querySelector("main");
  const historyLength = window.history.length;
  for (const target of [
    "https://other-store.example/products/new",
    "//other-store.example/cart",
    `https://user:SECRET@${new URL(origin).host}/products/new`,
    "javascript:alert(1)",
    `blob:${origin}/opaque-id`,
    "data:text/html,hello",
    "http://",
  ]) {
    await navigation.navigate(target);
    assert.ok(navigation.getSnapshot().error);
    assert.equal(document.querySelector("main"), main);
    assert.equal(window.location.href, `${origin}/`);
  }
  assert.equal(calls.length, 0);
  assert.equal(window.history.length, historyLength);
  assert.deepEqual(native, []);
  assert.deepEqual(errors, []);
});

test("partial rendering requests and a missing current page shell use trusted native navigation", async (t) => {
  for (const mode of ["sections", "section_id", "missing main"]) {
    await t.test(mode, async (t) => {
      const { document, window, navigation, calls, native, errors } = setup(t);
      const target =
        mode === "missing main"
          ? "/pages/help"
          : `/collections/new?${mode}=grid`;
      if (mode === "missing main") document.querySelector("main").remove();
      const oldRestoration = window.history.scrollRestoration;
      await navigation.navigate(target);
      assert.deepEqual(native, [{ method: "assign", url: origin + target }]);
      assert.equal(calls.length, 0);
      assert.equal(errors.length, 1);
      assert.equal(window.history.scrollRestoration, oldRestoration);
    });
  }
});

test("fetch deadlines fall back once and scrub URL secrets from the diagnostic", async (t) => {
  let expire;
  const { window, navigation, native, errors } = setup(
    t,
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(options.signal.reason),
        );
      }),
  );
  const setTimeout = window.setTimeout.bind(window);
  window.setTimeout = (callback, ms, ...args) => {
    if (ms === 15000) {
      expire = callback;
      return 123456;
    }
    return setTimeout(callback, ms, ...args);
  };
  const target = "/products/new?token=QUERY_SECRET#FRAGMENT_SECRET";
  const pending = navigation.navigate(target);
  expire();
  assert.equal(await pending, "handed_off");
  assert.deepEqual(native, [{ method: "assign", url: origin + target }]);
  assert.match(errors[0][1].reason, /timed out/);
  assert.doesNotMatch(JSON.stringify(errors), /SECRET|\?|#/);
  navigation.dispose();
  assert.equal(native.length, 1);
});

test("a failed fetch diagnostic removes credentials and queries from exception URLs", async (t) => {
  let window;
  const env = setup(t, async () => {
    throw new window.Error(
      `Failed to fetch https://USERNAME_SECRET:PASSWORD_SECRET@${new URL(origin).host}/products/new?token=QUERY_SECRET#FRAGMENT_SECRET`,
    );
  });
  window = env.window;
  await env.navigation.navigate("/products/new");
  assert.equal(env.native.length, 1);
  assert.match(env.errors[0][1].reason, /Failed to fetch/);
  assert.doesNotMatch(JSON.stringify(env.errors), /SECRET|\?|#/);
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
  assert.equal(await second, "navigated");
  assert.equal(calls[0].options.signal.aborted, true);
  resolveFirst(response(productOne));
  assert.equal(await first, "cancelled");
  assert.equal(window.location.pathname, productTwo);
  assert.equal(document.querySelector("main h1").textContent, productTwo);
  assert.equal(navigation.getSnapshot().error, null);
});

test("ending a model turn cancels its page fetch without committing or falling back to a full refresh", async (t) => {
  let finish;
  const { navigation, window, document, calls, native, errors } = setup(
    t,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new window.AbortController();
  const previousMain = document.querySelector("main");
  const pending = navigation.navigate(productOne, controller.signal);
  await until(() => finish, "Page fetch did not start");
  controller.abort();
  assert.equal(calls[0].options.signal.aborted, true);
  finish(response(productOne));
  assert.equal(await pending, "cancelled");
  assert.equal(document.querySelector("main"), previousMain);
  assert.equal(window.location.pathname, "/");
  assert.equal(navigation.getSnapshot().pending, false);
  assert.deepEqual(native, []);
  assert.deepEqual(errors, []);
  assert.equal(
    await navigation.navigate(productTwo, controller.signal),
    "cancelled",
  );
  assert.equal(calls.length, 1, "Already-cancelled navigation never fetches");
});

test("ordinary same-origin links are intercepted only while the sidebar is open", async (t) => {
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
  for (const [href, options, attributes] of [
    [productOne, { ctrlKey: true }],
    [productOne, { metaKey: true }],
    [productOne, { shiftKey: true }],
    [productOne, { button: 1 }],
    ["https://example.org/"],
    ["javascript:alert(1)"],
    [`https://user:secret@${new URL(origin).host}/products/test`],
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
  assert.equal(click("/pages/measuring-guide"), true);
  await until(
    () => window.location.pathname === "/pages/measuring-guide",
    "arbitrary same-origin link did not navigate",
  );
  assert.equal(calls.length, 1);
  navigation.setSidebarOpen(false);
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

test("navigation leaves the fullscreen shell's layout resources untouched", (t) => {
  const { document, navigation } = setup(t);
  const layout = document.createElement("style");
  layout.dataset.romanLayout = "";
  document.head.append(layout);
  document.documentElement.setAttribute("data-roman-open", "");
  navigation.setSidebarOpen(true);
  navigation.setSidebarOpen(false);
  navigation.dispose();
  assert.equal(
    document.documentElement.hasAttribute("data-roman-open"),
    true,
  );
  assert.equal(document.querySelector("style[data-roman-layout]"), layout);
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

function fixedBodyScroll(window, initialTop = 640) {
  let top = initialTop;
  const calls = [];
  const physicalTop = () =>
    window.document.body.style.position === "fixed" ? 0 : top;
  Object.defineProperties(window, {
    scrollX: { configurable: true, get: () => 0 },
    scrollY: { configurable: true, get: physicalTop },
    pageYOffset: { configurable: true, get: physicalTop },
  });
  Object.defineProperty(window.document.documentElement, "scrollTop", {
    configurable: true,
    get: physicalTop,
  });
  window.scrollTo = (options) => {
    calls.push({ ...options });
    top = options.top;
  };
  return calls;
}

test("locked background navigation records logical history and restores it only when Roman closes", async (t) => {
  let nativeScrolls;
  const ctx = setup(t, undefined, {
    lockedScroll: true,
    beforeImport(window) {
      nativeScrolls = fixedBodyScroll(window);
    },
  });
  const { document, window, navigation, storefrontScroll } = ctx;
  const header = document.createElement("main-header");
  const resets = [];
  header.reset = () => resets.push(storefrontScroll.getPosition()[1]);
  document.querySelector("header").replaceWith(header);
  window.history.replaceState({ themeSelection: "original" }, "", "/");
  assert.equal(window.scrollY, 0, "fixed body has no physical document scroll");
  assert.equal(storefrontScroll.getPosition()[1], 640);

  assert.equal(
    await navigation.navigate(productOne, undefined, { source: "model" }),
    "navigated",
  );
  assert.equal(storefrontScroll.getPosition()[1], 0);
  storefrontScroll.scrollTo([0, 320]);
  await navigation.navigate(productTwo);
  assert.equal(storefrontScroll.getPosition()[1], 0);
  assert.deepEqual(resets, [0, 0]);

  window.history.back();
  await until(
    () => document.querySelector("main h1").textContent === productOne,
    "Back did not restore the first hidden product",
  );
  assert.equal(storefrontScroll.getPosition()[1], 320);
  assert.equal(window.history.state.__romanNavigation.scroll[1], 320);
  assert.deepEqual(resets, [0, 0], "deep history does not reset the theme header");
  window.history.back();
  await until(
    () => document.querySelector("main h1").textContent === "/",
    "Back did not restore the initial hidden page",
  );
  assert.equal(storefrontScroll.getPosition()[1], 640);
  assert.equal(window.history.state.themeSelection, "original");
  assert.equal(document.body.style.position, "fixed");
  assert.deepEqual(nativeScrolls, [], "locked navigation never pans the document");

  storefrontScroll.setLocked(false);
  assert.equal(document.body.style.position, "");
  assert.equal(window.scrollY, 640);
  assert.deepEqual(nativeScrolls, [{ left: 0, top: 640, behavior: "instant" }]);
});

test("locked anchor navigation uses the target geometry and scroll margin without native scrolling", async (t) => {
  let nativeScrolls;
  const ctx = setup(
    t,
    async (url) => {
      const path = new URL(url).pathname;
      return response(path, {
        url: String(url),
        text: async () =>
          page(
            path,
            '<div id="measurements" style="scroll-margin-top:24px">Measuring guide</div>',
          ),
      });
    },
    {
      lockedScroll: true,
      beforeImport(window) {
        nativeScrolls = fixedBodyScroll(window);
        const rect = window.HTMLElement.prototype.getBoundingClientRect;
        window.HTMLElement.prototype.getBoundingClientRect = function () {
          if (this.id !== "measurements") return rect.call(this);
          return {
            top: 900 + Number.parseFloat(window.document.body.style.top || "0"),
          };
        };
      },
    },
  );
  const { document, window, navigation, storefrontScroll } = ctx;
  const header = document.createElement("main-header");
  header.reset = () => assert.fail("A deep anchor must not reset the header");
  document.querySelector("header").replaceWith(header);
  assert.equal(
    await navigation.navigate(`${productOne}#measurements`),
    "navigated",
  );
  assert.equal(window.scrollY, 0);
  assert.equal(storefrontScroll.getPosition()[1], 876);
  assert.equal(document.body.style.top, "-876px");
  assert.deepEqual(nativeScrolls, []);
  storefrontScroll.setLocked(false);
  assert.equal(window.scrollY, 876);
  assert.deepEqual(nativeScrolls, [{ left: 0, top: 876, behavior: "instant" }]);
});

test("header reset trusts logical scroll even if the physical viewport reports keyboard drift", async (t) => {
  const { window, document } = setup(t);
  const { content, resets, hide } = installThemeHeader(t, window, {
    scrollTop: 140,
  });
  window.RomanPage.resetHeaderAtTop(0);
  assert.equal(resets.length, 1);
  assert.equal(window.scrollY, 140);
  assert.equal(content.classList.contains("invisible"), false);

  hide();
  document.documentElement.scrollTop = 0;
  window.RomanPage.resetHeaderAtTop(640);
  assert.equal(resets.length, 1);
  assert.equal(content.classList.contains("invisible"), true);
});

test("top navigation restores the existing theme header after new page dimensions bypass its scroll reset", async (t) => {
  const { document, window, navigation } = setup(t, async (url) => {
    const path = new URL(url).pathname;
    return response(path, {
      text: async () =>
        page(path).replace(
          '<main id="main"',
          '<main id="main" data-height="1800" data-width="1200"',
        ),
    });
  });
  const { header, content, resets, observed } = installThemeHeader(t, window);
  const previousMain = document.querySelector("main");

  await navigation.navigate(productOne);

  assert.equal(window.scrollY, 0);
  assert.equal(
    observed.dimensionSkips,
    1,
    "the theme's original dimension guard reproduced the missed reset",
  );
  assert.equal(resets.length, 1);
  assert.notEqual(resets[0].main, previousMain);
  assert.equal(resets[0].main, document.querySelector("main"));
  assert.equal(resets[0].pathname, productOne);
  assert.equal(
    resets[0].top,
    0,
    "theme reset runs after the destination scroll is applied",
  );
  assert.equal(content.className, "");
  assert.equal(
    document.documentElement.style.getPropertyValue("--header-height"),
    "0px",
  );
  assert.equal(header.currentScrollTop, 0);
  assert.equal(header.initialHeight, 1800);
  assert.equal(header.initialWidth, 1200);
  assert.equal(document.querySelector("main-header"), header);
  assert.equal(document.querySelector("header"), content);

  window.scrollTo({ top: 700 });
  assert.equal(observed.scrollEvents, 2);
  assert.equal(
    content.classList.contains("invisible"),
    true,
    "the same theme scroll listener still controls subsequent scrolling",
  );
});

test("a header without the theme reset API is left alone during successful navigation", async (t) => {
  const { document, window, navigation } = setup(t);
  const { header, content, resets } = installThemeHeader(t, window, {
    hasReset: false,
  });
  const classes = content.className;
  await navigation.navigate(productOne);
  assert.equal(navigation.getSnapshot().error, null);
  assert.equal(window.scrollY, 0);
  assert.equal(document.querySelector("main-header"), header);
  assert.equal(content.className, classes);
  assert.equal(
    document.documentElement.style.getPropertyValue("--header-height"),
    "0px",
  );
  assert.deepEqual(resets, []);
});

test("deep restored history and anchors keep the theme header's existing scroll visibility", async (t) => {
  for (const destination of ["history", "anchor"]) {
    await t.test(destination, async (t) => {
      const { document, window, navigation } = setup(t, async (url) => {
        const path = new URL(url).pathname;
        return response(path, {
          url: String(url),
          text: async () =>
            page(path, '<div id="measurements">Measuring guide</div>'),
        });
      });
      const { content, resets, hide } = installThemeHeader(t, window);
      if (destination === "history") {
        await navigation.navigate(productOne);
        hide();
        resets.length = 0;
        window.history.back();
        await until(
          () => document.querySelector("main h1").textContent === "/",
          "Back did not restore the scrolled page",
        );
      } else {
        window.HTMLElement.prototype.scrollIntoView = function () {
          assert.equal(this.id, "measurements");
          window.scrollTo({ top: 900 });
        };
        await navigation.navigate(`${productOne}#measurements`);
      }
      assert.equal(window.scrollY, destination === "history" ? 640 : 900);
      assert.deepEqual(resets, []);
      assert.equal(content.classList.contains("invisible"), true);
      assert.equal(
        document.documentElement.style.getPropertyValue("--header-height"),
        "0px",
      );
      assert.equal(navigation.getSnapshot().error, null);
    });
  }
});

test("failed, canceled and native-fallback navigation never reset the retained theme header", async (t) => {
  for (const outcome of ["HTTP failure", "canceled", "native conflict"]) {
    await t.test(outcome, async (t) => {
      let resolveRequest;
      const { document, window, navigation } = setup(
        t,
        () =>
          outcome === "canceled"
            ? new Promise((resolve) => {
                resolveRequest = resolve;
              })
            : Promise.resolve(
                response(
                  "/cart",
                  outcome === "HTTP failure"
                    ? { ok: false, status: 503 }
                    : {
                        text: async () =>
                          themePage("/cart", {
                            assets: `<script type="module" src="${themeAsset("-core-cart-sections-foundation.js")}"></script>`,
                          }),
                      },
                ),
              ),
        {
          html: themePage("/", {
            assets: `<script type="module" src="${themeAsset("-core-cart-sections.js")}"></script>`,
          }),
        },
      );
      const native = captureNativeNavigation(window);
      const { header, content, resets, observed } = installThemeHeader(
        t,
        window,
        { scrollTop: 0 },
      );
      const previousMain = document.querySelector("main");
      const classes = content.className;
      const pending = navigation.navigate("/cart");
      if (outcome === "canceled") {
        await until(
          () => resolveRequest,
          "cancelable navigation did not start",
        );
        navigation.dispose();
        resolveRequest(
          response("/cart", { text: async () => themePage("/cart") }),
        );
      }
      await pending;
      assert.deepEqual(resets, []);
      assert.equal(observed.scrollEvents, 0);
      assert.equal(document.querySelector("main-header"), header);
      assert.equal(document.querySelector("main"), previousMain);
      assert.equal(content.className, classes);
      assert.equal(
        document.documentElement.style.getPropertyValue("--header-height"),
        "0px",
      );
      assert.equal(native.length, outcome === "canceled" ? 0 : 1);
    });
  }
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

test("Back restores an arbitrary initial product page", async (t) => {
  const path = "/products/other-product";
  const { document, window, host, navigation } = setup(t, undefined, {
    html: page(path),
    url: `${origin}${path}`,
  });
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

test("failed Back and Forward reload arbitrary destinations without rolling history back", async (t) => {
  for (const direction of ["back", "forward"]) {
    await t.test(direction, async (t) => {
      const first = "/pages/measuring-guide";
      const second = "/collections/new-collection";
      let failingPath;
      const { document, window, navigation, native, errors } = setup(
        t,
        async (url) => {
          const path = new URL(url).pathname;
          return response(
            path,
            path === failingPath ? { ok: false, status: 503 } : {},
          );
        },
      );
      await navigation.navigate(first);
      await navigation.navigate(second);
      if (direction === "forward") {
        window.history.back();
        await until(
          () => document.querySelector("main h1").textContent === first,
          "Back did not establish Forward",
        );
      }
      const previousMain = document.querySelector("main");
      const length = window.history.length;
      failingPath = direction === "back" ? first : second;
      window.history[direction]();
      await until(
        () => native.length,
        "Failed history destination did not reload",
      );
      assert.deepEqual(native, [
        { method: "reload", url: origin + failingPath },
      ]);
      assert.equal(window.location.pathname, failingPath);
      assert.equal(window.history.length, length);
      assert.equal(document.querySelector("main"), previousMain);
      assert.match(errors[0][1].reason, /HTTP 503/);
      navigation.dispose();
      assert.equal(
        native.length,
        1,
        "disposal must not undo the native handoff",
      );
    });
  }
});

test("branching after Back retains arbitrary route history positions", async (t) => {
  const { document, window, navigation } = setup(t);
  await navigation.navigate(productOne);
  await navigation.navigate(productTwo);
  window.history.back();
  await until(
    () => document.querySelector("main h1").textContent === productOne,
    "Back did not reach branch point",
  );
  const branch = "/pages/fitting-guide";
  await navigation.navigate(branch);
  assert.equal(window.history.length, 3);
  window.history.go(-2);
  await until(
    () => document.querySelector("main h1").textContent === "/",
    "Two-entry Back did not reach Home",
  );
  window.history.forward();
  await until(
    () => document.querySelector("main h1").textContent === productOne,
    "Forward did not reach branch point",
  );
  window.history.forward();
  await until(
    () => document.querySelector("main h1").textContent === branch,
    "Forward returned to discarded branch",
  );
  assert.equal(window.location.pathname, branch);
});

test("payment initialization failure reloads the inserted destination without adding another history entry", async (t) => {
  const { document, window, navigation, native, errors } = setup(t);
  await navigation.navigate(productOne);
  window.Shopify = {
    PaymentButton: {
      init: () => {
        throw new Error("Payment integration unavailable");
      },
    },
  };
  assert.equal(await navigation.navigate(productTwo), "handed_off");
  assert.match(errors[0][1].reason, /payment controls could not initialize/);
  assert.equal(navigation.getSnapshot().pending, false);
  assert.equal(document.querySelector("main h1").textContent, productTwo);
  assert.equal(window.location.pathname, productTwo);
  assert.equal(window.history.length, 3);
  assert.deepEqual(native, [{ method: "reload", url: origin + productTwo }]);
  window.Shopify.PaymentButton.init = () => {};
  window.history.back();
  await until(
    () => document.querySelector("main h1").textContent === productOne,
    "Payment fallback lost previous history",
  );
  window.history.back();
  await until(
    () => document.querySelector("main h1").textContent === "/",
    "Payment fallback lost initial history",
  );
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

test("a cart component conflict uses native navigation with the complete destination and a redacted diagnostic", async (t) => {
  const destination = "/cart?cart_token=QUERY_SECRET#FRAGMENT_SECRET";
  const { document, window, host, instance, navigation, calls, errors } = setup(
    t,
    async (url) => {
      const finalUrl = new URL(url);
      finalUrl.hash = ""; // Fetch Response.url excludes the requested fragment.
      return response("/cart", {
        url: finalUrl.href,
        text: async () =>
          themePage("/cart", {
            assets: `<script type="module" src="${themeAsset("-core-cart-sections-foundation.js")}"></script>
              <link rel="stylesheet" href="${themeAsset("cart.css")}">`,
          }),
      });
    },
    {
      html: themePage("/", {
        assets: `<script type="module" src="${themeAsset("-core-cart-sections.js")}"></script>`,
      }),
      url: `${origin}/?preview_theme_id=PREVIEW_SECRET`,
    },
  );
  const native = captureNativeNavigation(window);
  const previousMain = document.querySelector("main");
  const input = host.shadowRoot.querySelector("input");
  const previousAssets = [
    ...document.querySelectorAll("script[src], link[href]"),
  ];
  const assetAttempts = [];
  const observer = new window.MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (
          node instanceof window.HTMLScriptElement ||
          node instanceof window.HTMLLinkElement
        )
          assetAttempts.push(node);
      }
    }
  });
  observer.observe(document.head, { childList: true });
  t.after(() => observer.disconnect());
  const changes = [];
  document.addEventListener("roman:navigation", (event) => changes.push(event));

  await navigation.navigate(destination);

  assert.deepEqual(native, [
    {
      method: "assign",
      url: `${origin}/cart?cart_token=QUERY_SECRET&preview_theme_id=PREVIEW_SECRET#FRAGMENT_SECRET`,
    },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(document.querySelector("main"), previousMain);
  assert.deepEqual(
    [...document.querySelectorAll("script[src], link[href]")],
    previousAssets,
  );
  assert.equal(document.querySelector("roman-ai-assistant"), host);
  assert.equal(host.romanInstance, instance);
  assert.equal(host.shadowRoot.querySelector("input"), input);
  assert.equal(input.value, "Keep my measurements");
  assert.deepEqual(changes, []);
  assert.deepEqual(
    assetAttempts,
    [],
    "the preflight conflict starts no asset loading",
  );
  assert.equal(
    window.history.length,
    1,
    "native navigation owns the new history entry",
  );
  assert.equal(errors.length, 1);
  const diagnostic = JSON.stringify(errors[0]);
  assert.match(diagnostic, /\[Roman\]/);
  assert.ok(diagnostic.includes(`${origin}/cart`));
  assert.match(diagnostic, /incompatible cart/i);
  assert.doesNotMatch(diagnostic, /SECRET|Keep my measurements|\?|#/);
});

test("component conflicts during Back and Forward reload the destination history entry without rolling back", async (t) => {
  for (const direction of ["back", "forward"]) {
    await t.test(direction, async (t) => {
      let conflictPath;
      const { document, window, navigation, errors } = setup(
        t,
        async (url) => {
          const path = new URL(url).pathname;
          return response(path, {
            text: async () =>
              themePage(path, {
                assets:
                  path === conflictPath
                    ? `<script type="module" src="${themeAsset("-core-cart-sections-foundation.js")}"></script>`
                    : "",
              }),
          });
        },
        {
          html: themePage("/", {
            assets: `<script type="module" src="${themeAsset("-core-cart-sections.js")}"></script>`,
          }),
        },
      );
      const native = captureNativeNavigation(window);
      await navigation.navigate(productOne);
      await navigation.navigate(productTwo);
      if (direction === "forward") {
        window.history.back();
        await until(
          () => document.querySelector("main h1").textContent === productOne,
          "Back did not establish the Forward destination",
        );
      }
      conflictPath = direction === "back" ? productOne : productTwo;
      const previousMain = document.querySelector("main");
      const length = window.history.length;
      window.history[direction]();
      await until(
        () => native.length,
        "the conflicting history destination did not reload",
      );

      assert.deepEqual(native, [
        { method: "reload", url: `${origin}${conflictPath}` },
      ]);
      assert.equal(window.location.href, `${origin}${conflictPath}`);
      assert.equal(window.history.length, length);
      assert.equal(
        window.history.state.__romanNavigation.index,
        direction === "back" ? 1 : 2,
      );
      assert.equal(document.querySelector("main"), previousMain);
      assert.equal(errors.length, 1);
      navigation.dispose();
      await delay(10);
      assert.equal(
        window.location.href,
        `${origin}${conflictPath}`,
        "disposal must not undo the pending native history load",
      );
      assert.equal(native.length, 1);
    });
  }
});

test("a redirected conflicting history destination replaces its current entry", async (t) => {
  let redirect = false;
  const { document, window, navigation } = setup(
    t,
    async (url) => {
      const path = new URL(url).pathname;
      return response(path, {
        url: redirect ? `${origin}/cart?redirect=QUERY_SECRET` : String(url),
        text: async () =>
          themePage(redirect ? "/cart" : path, {
            assets: redirect
              ? `<script type="module" src="${themeAsset("-core-cart-sections-foundation.js")}"></script>`
              : "",
          }),
      });
    },
    {
      html: themePage("/", {
        assets: `<script type="module" src="${themeAsset("-core-cart-sections.js")}"></script>`,
      }),
    },
  );
  const native = captureNativeNavigation(window);
  await navigation.navigate(productOne);
  await navigation.navigate(productTwo);
  const previousMain = document.querySelector("main");
  redirect = true;
  window.history.back();
  await until(
    () => native.length,
    "the redirected history conflict did not use native navigation",
  );
  assert.deepEqual(native, [
    { method: "replace", url: `${origin}/cart?redirect=QUERY_SECRET` },
  ]);
  assert.equal(window.history.length, 3);
  assert.equal(window.history.state.__romanNavigation.index, 1);
  assert.equal(document.querySelector("main"), previousMain);
});

test("late conflict responses from superseded or disposed navigation cannot trigger native fallback", async (t) => {
  for (const action of ["supersede", "dispose"]) {
    await t.test(action, async (t) => {
      let resolveConflict;
      const { document, window, navigation, calls, errors } = setup(
        t,
        (url) =>
          new URL(url).pathname === "/cart"
            ? new Promise((resolve) => {
                resolveConflict = resolve;
              })
            : Promise.resolve(
                response(productOne, {
                  text: async () => themePage(productOne),
                }),
              ),
        {
          html: themePage("/", {
            assets: `<script type="module" src="${themeAsset("-core-cart-sections.js")}"></script>`,
          }),
        },
      );
      const native = captureNativeNavigation(window);
      const pending = navigation.navigate("/cart");
      await until(() => resolveConflict, "conflicting request did not start");
      if (action === "supersede") await navigation.navigate(productOne);
      else navigation.dispose();
      const displayedMain = document.querySelector("main");
      assert.equal(calls[0].options.signal.aborted, true);
      resolveConflict(
        response("/cart", {
          text: async () =>
            themePage("/cart", {
              assets: `<script type="module" src="${themeAsset("-core-cart-sections-foundation.js")}"></script>`,
            }),
        }),
      );
      await pending;
      assert.deepEqual(native, []);
      assert.deepEqual(errors, []);
      assert.equal(document.querySelector("main"), displayedMain);
    });
  }
});

test("a cached page can resume Roman navigation after a native conflict handoff", async (t) => {
  const { document, window, navigation, calls } = setup(
    t,
    async (url) => {
      const path = new URL(url).pathname;
      return response(path, {
        text: async () =>
          themePage(path, {
            assets:
              path === "/cart"
                ? `<script type="module" src="${themeAsset("-core-cart-sections-foundation.js")}"></script>`
                : "",
          }),
      });
    },
    {
      html: themePage("/", {
        assets: `<script type="module" src="${themeAsset("-core-cart-sections.js")}"></script>`,
      }),
      beforeImport: (window) => {
        window.history.scrollRestoration = "auto";
      },
    },
  );
  const native = captureNativeNavigation(window);
  await navigation.navigate("/cart");
  assert.equal(native.length, 1);
  assert.equal(window.history.scrollRestoration, "auto");
  await navigation.navigate(productOne);
  assert.equal(
    calls.length,
    1,
    "no second navigation can race the native handoff",
  );
  window.dispatchEvent(
    new window.PageTransitionEvent("pageshow", { persisted: false }),
  );
  await navigation.navigate(productOne);
  assert.equal(calls.length, 1);

  window.dispatchEvent(
    new window.PageTransitionEvent("pageshow", { persisted: true }),
  );
  assert.equal(window.history.scrollRestoration, "manual");
  await navigation.navigate(productOne);
  assert.equal(calls.length, 2);
  assert.equal(document.querySelector("main h1").textContent, productOne);
  assert.equal(window.location.pathname, productOne);
  assert.equal(native.length, 1);
  assert.equal(navigation.getSnapshot().error, null);
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

test("unexpected stylesheet insertion failure cancels sibling assets and loads the full page", async (t) => {
  const pendingUrl = themeAsset("pending.css");
  const brokenUrl = themeAsset("cannot-insert.css");
  const { document, window, navigation, warnings, errors, native } = setup(
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
  assert.match(errors[0][1].reason, /Cannot insert stylesheet/);
  assert.deepEqual(native, [
    { method: "assign", url: `${origin}${productOne}` },
  ]);
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

test("all observed theme initialization errors load the full page with a diagnostic", async (t) => {
  const cases = [
    {
      name: "duplicate registry definition",
      errorName: "NotSupportedError",
      message:
        "Failed to execute 'define' on 'CustomElementRegistry': the name \"cart-remove-toggle\" has already been used with this registry",
    },
    {
      name: "unrelated unsupported operation",
      errorName: "NotSupportedError",
      message: "The requested operation is not supported",
    },
    {
      name: "ordinary initialization exception",
      errorName: "TypeError",
      message: "Cannot read properties of undefined",
    },
    {
      name: "unconfirmed duplicate wording",
      errorName: "Error",
      message: "Custom element was already registered",
    },
  ];
  for (const { name, errorName, message } of cases) {
    await t.test(name, async (t) => {
      const moduleUrl = `${themeAsset("-new-product.js")}?asset=ASSET_SECRET`;
      const { document, window, navigation, errors, warnings } = setup(
        t,
        async (url) =>
          response(productOne, {
            url: String(url),
            text: async () =>
              themePage(productOne, {
                assets: `<script type="module" src="${moduleUrl}"></script>
              <script type="module" src="${themeAsset("-pending-sibling.js")}"></script>`,
              }),
          }),
        { html: themePage("/") },
      );
      const native = captureNativeNavigation(window);
      const previousMain = document.querySelector("main");
      const destination = `${productOne}?variant=QUERY_SECRET#FRAGMENT_SECRET`;
      const pending = navigation.navigate(destination);
      await until(
        () => document.querySelector(`script[src="${moduleUrl}"]`),
        "runtime module was not requested",
      );
      window.dispatchEvent(
        new window.ErrorEvent("error", {
          filename: moduleUrl,
          message,
          error: new window.DOMException(message, errorName),
        }),
      );
      await pending;

      assert.deepEqual(native, [
        { method: "assign", url: `${origin}${destination}` },
      ]);
      assert.equal(document.querySelector("main"), previousMain);
      assert.equal(window.location.href, `${origin}/`);
      assert.equal(window.history.length, 1);
      assert.equal(document.querySelector(`script[src="${moduleUrl}"]`), null);
      assert.equal(
        document.querySelector(
          `script[src="${themeAsset("-pending-sibling.js")}"]`,
        ),
        null,
      );
      assert.deepEqual(warnings, []);
      assert.equal(errors.length, 1);
      assert.doesNotMatch(JSON.stringify(errors), /SECRET|\?|#/);
      assert.ok(JSON.stringify(errors).includes(`${origin}${productOne}`));
    });
  }
});

test("duplicate-registration events after cancellation cannot fall back or disturb the newer page", async (t) => {
  for (const action of ["supersede", "dispose"]) {
    await t.test(action, async (t) => {
      const moduleUrl = themeAsset("-cancelled-product.js");
      const nextModuleUrl = themeAsset("-next-product.js");
      const { document, window, navigation, errors } = setup(
        t,
        async (url) => {
          const path = new URL(url).pathname;
          return response(path, {
            text: async () =>
              themePage(path, {
                assets: `<script type="module" src="${path === productOne ? moduleUrl : nextModuleUrl}"></script>`,
              }),
          });
        },
        { html: themePage("/") },
      );
      const native = captureNativeNavigation(window);
      const pending = navigation.navigate(productOne);
      await until(
        () => document.querySelector(`script[src="${moduleUrl}"]`),
        "cancelled module was not requested",
      );
      let nextNavigation;
      if (action === "supersede") {
        nextNavigation = navigation.navigate(productTwo);
        await until(
          () => document.querySelector(`script[src="${nextModuleUrl}"]`),
          "next navigation did not begin loading its module",
        );
        document
          .querySelector(`script[src="${nextModuleUrl}"]`)
          .dispatchEvent(new window.Event("load"));
        await nextNavigation;
      } else navigation.dispose();
      await pending;
      const displayedMain = document.querySelector("main");
      const message =
        "Failed to execute 'define' on 'CustomElementRegistry': the name \"cart-remove-toggle\" has already been used with this registry";
      window.dispatchEvent(
        new window.ErrorEvent("error", {
          filename: moduleUrl,
          message,
          error: new window.DOMException(message, "NotSupportedError"),
        }),
      );
      await delay(0);
      assert.deepEqual(native, []);
      assert.deepEqual(errors, []);
      assert.equal(document.querySelector("main"), displayedMain);
      if (nextNavigation) {
        assert.equal(document.querySelector("main h1").textContent, productTwo);
        assert.equal(navigation.getSnapshot().error, null);
        assert.deepEqual(native, []);
      }
    });
  }
});

function storePage(store, path, options = {}) {
  return themePage(path, options).replaceAll(origin, store.origin);
}

test("unsafe-script diagnostics identify every blocker without exposing customer data or changing the page", async (t) => {
  const store = storeFixtures.devSingle;
  const path = "/products/lottie-mojito-roman-blind";
  const destination = `${path}?variant=PAGE_QUERY_SECRET#PAGE_FRAGMENT_SECRET`;
  const safeModule = `${store.origin}/cdn/shop/t/118/assets/-safe-component.js?token=ASSET_QUERY_SECRET`;
  const html = storePage(store, path, {
    assets: `<script type="module" data-case="head-module" src="https://app-cdn.example.org/head-sdk.js?token=HEAD_QUERY_SECRET#HEAD_FRAGMENT_SECRET"></script>
      <link rel="stylesheet" href="${store.origin}/cdn/shop/t/118/assets/product.css?token=STYLE_QUERY_SECRET">`,
    extra: `<div id="PRIVATE_ID_SECRET" class="PRIVATE_CLASS_SECRET" data-customer="ATTRIBUTE_VALUE_SECRET">
      <script type="module" src="${safeModule}"></script>
      <script type="application/json">{"customer":"JSON_BODY_SECRET"}</script>
      <script type="module" data-case="external-module" src="https://CREDENTIAL_USER_SECRET:CREDENTIAL_PASSWORD_SECRET@app-cdn.example.org/widget.js?token=MODULE_QUERY_SECRET#MODULE_FRAGMENT_SECRET"></script>
      <script type=" TEXT/JAVASCRIPT " data-case="inline-script">window.inlineLeak = 'INLINE_BODY_SECRET';</script>
      <script type="CUSTOM_TYPE_SECRET" data-case="unknown-type">window.unknownLeak = 'UNKNOWN_BODY_SECRET';</script>
      <script type="text/javascript" data-case="data-script" src="data:text/javascript,window.dataLeak='DATA_BODY_SECRET'" onerror="window.handlerLeak='HANDLER_VALUE_SECRET'">SCRIPT_BODY_SECRET</script>
      <a data-case="javascript-link" href="javascript:window.linkLeak='JAVASCRIPT_URL_SECRET'">CUSTOMER_TEXT_SECRET</a>
      <iframe data-case="frame" srcdoc="&lt;p&gt;SRCDOC_VALUE_SECRET&lt;/p&gt;"></iframe>
      <button data-case="button" onclick="window.buttonLeak='BUTTON_HANDLER_SECRET'" onfocus="window.focusLeak='FOCUS_HANDLER_SECRET'">Continue</button>
    </div>`,
  }).replace(
    '<main id="main"',
    '<main id="main" data-case="main" onkeydown="window.mainLeak=\'MAIN_HANDLER_SECRET\'"',
  );
  const {
    document,
    window,
    host,
    instance,
    navigation,
    calls,
    warnings,
    errors,
  } = setup(
    t,
    async (url) => response(path, { url: String(url), text: async () => html }),
    {
      shop: store.shop,
      url: `${store.origin}/?session=OUTGOING_QUERY_SECRET`,
      html: storePage(store, "/"),
    },
  );
  const native = captureNativeNavigation(window);
  const main = document.querySelector("main");
  const input = host.shadowRoot.querySelector("input");
  const previousUrl = window.location.href;
  const initialAssets = [
    ...document.querySelectorAll("script[src], link[rel=stylesheet]"),
  ];
  const assetAttempts = [];
  const observer = new window.MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (
          node instanceof window.HTMLScriptElement ||
          node instanceof window.HTMLLinkElement
        )
          assetAttempts.push(node);
      }
    }
  });
  observer.observe(document.head, { childList: true });
  t.after(() => observer.disconnect());
  await navigation.navigate(destination);
  assert.match(
    errors[1][1].reason,
    /unsupported integration \(\/head-sdk\.js\)/,
  );
  assert.equal(errors.length, 2);
  const [message, details] = errors[0];
  assert.equal(
    message,
    "[Roman] Unsafe storefront scripts blocked navigation.",
  );
  assert.deepEqual(Object.keys(details).sort(), ["blocked", "page", "theme"]);
  assert.equal(details.page, `${store.origin}${path}`);
  assert.equal(
    details.theme,
    window.RomanPage.selectStore(store.shop).theme.id,
  );
  assert.equal(details.blocked.length, 11);
  const source = new window.DOMParser().parseFromString(html, "text/html");
  const byCase = new Map();
  const permittedFields = new Set([
    "reason",
    "element",
    "type",
    "src",
    "attribute",
  ]);
  for (const blocked of details.blocked) {
    assert.ok(Object.keys(blocked).every((key) => permittedFields.has(key)));
    assert.ok(
      Object.values(blocked).every((value) => typeof value === "string"),
    );
    assert.ok(blocked.reason.length > 0);
    assert.match(
      blocked.element,
      /^[a-z][a-z0-9-]*(?::nth-of-type\([1-9]\d*\))?(?:\s*>\s*[a-z][a-z0-9-]*(?::nth-of-type\([1-9]\d*\))?)*$/,
    );
    const matches = source.querySelectorAll(blocked.element);
    assert.equal(
      matches.length,
      1,
      "each diagnostic must locate exactly one element in the fetched HTML",
    );
    const element = matches[0];
    const fixtureCase = element.getAttribute("data-case");
    assert.ok(fixtureCase, "safe modules and JSON must not become blockers");
    byCase.set(fixtureCase, [...(byCase.get(fixtureCase) ?? []), blocked]);
    if (element.localName !== "script") assert.equal(blocked.type, undefined);
  }
  assert.deepEqual(
    new Set(byCase.keys()),
    new Set([
      "head-module",
      "external-module",
      "main",
      "inline-script",
      "unknown-type",
      "data-script",
      "javascript-link",
      "frame",
      "button",
    ]),
  );
  assert.equal(byCase.get("head-module").length, 1);
  assert.equal(
    byCase.get("external-module").length,
    1,
    "an unsupported external module must not be logged twice",
  );
  assert.equal(
    byCase.get("external-module")[0].src,
    "https://app-cdn.example.org/widget.js",
  );
  assert.equal(byCase.get("external-module")[0].type, "module");
  assert.equal(byCase.get("inline-script")[0].type, "text/javascript");
  assert.equal(byCase.get("inline-script")[0].src, "inline");
  const dataBlockers = byCase.get("data-script");
  assert.equal(
    dataBlockers.length,
    2,
    "an unsafe handler and script source are distinct blockers",
  );
  assert.equal(new Set(dataBlockers.map(({ reason }) => reason)).size, 2);
  assert.ok(dataBlockers.every(({ src }) => src === "data:[redacted]"));
  assert.ok(dataBlockers.some(({ attribute }) => attribute === "onerror"));
  assert.deepEqual(
    new Set(byCase.get("button").map(({ attribute }) => attribute)),
    new Set(["onclick", "onfocus"]),
  );
  assert.equal(byCase.get("main")[0].attribute, "onkeydown");
  assert.equal(byCase.get("javascript-link")[0].attribute, "href");
  assert.equal(byCase.get("frame")[0].attribute, "srcdoc");
  assert.doesNotMatch(JSON.stringify(errors), /SECRET|Keep my measurements/i);
  assert.deepEqual(warnings, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(assetAttempts, []);
  assert.deepEqual(
    [...document.querySelectorAll("script[src], link[rel=stylesheet]")],
    initialAssets,
  );
  assert.equal(document.querySelector("main"), main);
  assert.equal(window.location.href, previousUrl);
  assert.deepEqual(native, [
    { method: "assign", url: `${store.origin}${destination}` },
  ]);
  assert.equal(document.querySelector("roman-ai-assistant"), host);
  assert.equal(host.romanInstance, instance);
  assert.equal(host.shadowRoot.querySelector("input"), input);
  assert.equal(input.value, "Keep my measurements");
  assert.equal(window.inlineLeak, undefined);
});

test("safe theme modules and JSON configuration navigate without unsafe-script diagnostics", async (t) => {
  const store = storeFixtures.devSingle;
  const path = "/products/lottie-mojito-roman-blind";
  const moduleUrl = `${store.origin}/cdn/shop/t/118/assets/-safe-component.js`;
  const { document, window, navigation, errors } = setup(
    t,
    async (url) =>
      response(path, {
        url: String(url),
        text: async () =>
          storePage(store, path, {
            extra: `<script type="module" src="${moduleUrl}"></script>
          <script type="application/json" data-json>{"note":"window.jsonIsData=true"}</script>
          <script type="application/ld+json" data-linked-json>{"@type":"Product"}</script>`,
          }),
      }),
    { shop: store.shop, url: `${store.origin}/`, html: storePage(store, "/") },
  );
  const visiting = navigation.navigate(path);
  await until(
    () => document.querySelector(`script[src="${moduleUrl}"]`),
    "safe theme module was not requested",
  );
  document
    .querySelector(`script[src="${moduleUrl}"]`)
    .dispatchEvent(new window.Event("load"));
  await visiting;
  assert.equal(navigation.getSnapshot().error, null);
  assert.deepEqual(errors, []);
  assert.equal(window.location.pathname, path);
  assert.equal(
    document.querySelector("[data-json]").textContent,
    '{"note":"window.jsonIsData=true"}',
  );
  assert.equal(
    document.querySelector("[data-linked-json]").textContent,
    '{"@type":"Product"}',
  );
  assert.equal(window.jsonIsData, undefined);
});

test("unsafe attribute diagnostics retain original selectors when a theme hook replaces an earlier button", (t) => {
  const store = storeFixtures.devSingle;
  const html = storePage(store, "/cart", {
    extra: `<button onclick="if(history.length>1){history.back()}else{window.location.href='/'}">Continue shopping</button>
      <button data-case="unsafe" onclick="window.unexpectedInline = true">Other action</button>`,
  });
  const { window, document, errors } = setup(t, undefined, {
    shop: store.shop,
    url: `${store.origin}/`,
    html: storePage(store, "/"),
  });
  const main = document.querySelector("main");
  assert.throws(
    () =>
      window.RomanPage.preparePage(html, new window.URL("/cart", store.origin)),
    /inline JavaScript/,
  );
  assert.equal(errors.length, 1);
  const blocked = errors[0][1].blocked;
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].attribute, "onclick");
  const source = new window.DOMParser().parseFromString(html, "text/html");
  assert.equal(
    source.querySelector(blocked[0].element),
    source.querySelector('[data-case="unsafe"]'),
  );
  assert.equal(document.querySelector("main"), main);
});

test("both hd-dev-single products use the shared PayPal loader without remounting Roman", async (t) => {
  const store = storeFixtures.devSingle;
  const products = [
    "/products/lottie-mojito-roman-blind",
    "/products/bifold-clickfit-duoshade-obsidian-pleated-blind",
  ];
  const sdk =
    "https://www.paypal.com/sdk/js?client-id=test-merchant&components=buttons,messages&locale=en_GB";
  const { document, window, host, instance, navigation, errors } = setup(
    t,
    async (url) => {
      const path = new URL(url).pathname;
      return response(path, {
        url: String(url),
        text: async () =>
          storePage(store, path, {
            extra: products.includes(path)
              ? `<script id="paypal-script" defer src="${sdk}"></script><div data-pp-container data-pp-amount=""></div>`
              : "",
          }),
      });
    },
    { shop: store.shop, url: `${store.origin}/`, html: storePage(store, "/") },
  );
  const input = host.shadowRoot.querySelector("input");
  const sdkSelector = 'script[src^="https://www.paypal.com/sdk/js?"]';
  for (const path of products) {
    const main = document.querySelector("main");
    const visiting = navigation.navigate(path);
    if (!window.paypal) {
      await until(
        () => document.querySelector(sdkSelector),
        "PayPal was not requested for hd-dev-single",
      );
      assert.equal(document.querySelector("main"), main);
      window.paypal = {
        Buttons: () => assert.fail("The storefront owns checkout buttons"),
        Messages: () => assert.fail("The SDK owns price message rendering"),
      };
      document
        .querySelector(sdkSelector)
        .dispatchEvent(new window.Event("load"));
    }
    await visiting;
    assert.equal(navigation.getSnapshot().error, null);
    assert.equal(window.location.pathname, path);
    assert.equal(document.querySelector("main h1").textContent, path);
    assert.equal(document.querySelectorAll(sdkSelector).length, 1);
    assert.equal(host.romanInstance, instance);
    assert.equal(host.shadowRoot.querySelector("input"), input);
    assert.equal(input.value, "Keep my measurements");
  }
  await navigation.navigate("/");
  assert.equal(navigation.getSnapshot().error, null);
  assert.equal(document.querySelectorAll(sdkSelector).length, 1);
  assert.deepEqual(errors, []);
});

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
      const destination = store.routes.find((path) =>
        path.startsWith("/products/"),
      );
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
      for (const path of store.routes.filter((path) => path !== "/")) {
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

test("development stores accept arbitrary same-origin routes and reject other origins", async (t) => {
  for (const { store, foreignStore } of [
    {
      store: storeFixtures.devMulti,
      foreignStore: storeFixtures.devSingle,
    },
    {
      store: storeFixtures.devSingle,
      foreignStore: storeFixtures.devMulti,
    },
  ]) {
    await t.test(store.shop, async (t) => {
      const { document, window, navigation, calls } = setup(
        t,
        async (url) =>
          response(new URL(url).pathname, {
            url: String(url),
            text: async () => storePage(store, new URL(url).pathname),
          }),
        {
          shop: store.shop,
          url: `${store.origin}/`,
          html: storePage(store, "/"),
        },
      );
      const product = store.routes.find((path) =>
        path.startsWith("/products/"),
      );
      const scopedProduct = `/collections/all${product}`;
      await navigation.navigate(scopedProduct);
      assert.equal(navigation.getSnapshot().error, null);
      assert.equal(window.location.pathname, scopedProduct);
      for (const path of foreignStore.routes.flatMap((path) =>
        path.startsWith("/products/")
          ? [path, `/collections/all${path}`]
          : [path],
      )) {
        await navigation.navigate(path);
        assert.equal(navigation.getSnapshot().error, null);
        assert.equal(window.location.pathname, path);
        assert.equal(document.querySelector("main h1").textContent, path);
      }
      const main = document.querySelector("main");
      const fetched = calls.length;
      const current = window.location.href;
      await navigation.navigate(`${foreignStore.origin}/collections/all`);
      assert.match(navigation.getSnapshot().error, /same-origin/);
      assert.equal(calls.length, fetched);
      assert.equal(document.querySelector("main"), main);
      assert.equal(window.location.href, current);
    });
  }
});

test("an unrecognized Shopify identity remains inert without changing history or intercepting browsing", async (t) => {
  const { document, window, navigation, calls } = setup(t, undefined, {
    shop: "unrecognized-store.myshopify.com",
    html: themePage("/"),
  });
  const main = document.querySelector("main");
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

test("navigation uses the full page for a different theme revision before committing", async (t) => {
  const { document, window, navigation, errors } = setup(
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
  const native = captureNativeNavigation(window);
  const main = document.querySelector("main");
  await navigation.navigate(productOne);
  assert.equal(errors.length, 2);
  assert.equal(document.querySelector("main"), main);
  assert.equal(window.location.pathname, "/");
  assert.equal(document.querySelector('script[src*="/cdn/shop/t/999/"]'), null);
  assert.deepEqual(native, [
    { method: "assign", url: `${origin}${productOne}` },
  ]);
});

test("a page requiring a missing cart drawer uses native navigation without changing the current shell", async (t) => {
  const { document, window, navigation, errors } = setup(
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
  const native = captureNativeNavigation(window);
  const main = document.querySelector("main");
  await navigation.navigate(productOne);
  assert.deepEqual(native, [
    { method: "assign", url: `${origin}${productOne}` },
  ]);
  assert.equal(errors.length, 1);
  assert.match(JSON.stringify(errors), /missing.*cart drawer/i);
  assert.equal(document.querySelector("main"), main);
  assert.equal(window.location.pathname, "/cart");
  assert.equal(
    document.querySelector("#shopify-section-cart-drawer-dialog"),
    null,
  );
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
  for (const store of [storeFixtures.blinds2goUk, storeFixtures.blinds2goIe]) {
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
      const product = store.routes.find((path) =>
        path.startsWith("/products/"),
      );
      assert.ok(product);
      navigation.setSidebarOpen(true);
      await navigation.navigate(product);
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
        () => document.querySelector("main h1").textContent === product,
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
  for (const store of [storeFixtures.blinds2goUk, storeFixtures.blinds2goIe]) {
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

test("collection-scoped URLs can reach arbitrary products", async (t) => {
  const { document, window, navigation, calls } = setup(t, async (url) =>
    response(new URL(url).pathname),
  );
  const scoped = `/collections/all${productOne}`;
  await navigation.navigate(scoped);
  assert.equal(navigation.getSnapshot().error, null);
  assert.equal(window.location.pathname, scoped);
  assert.equal(document.querySelector("main h1").textContent, scoped);
  await navigation.navigate("/collections/all/products/unknown-product");
  assert.equal(navigation.getSnapshot().error, null);
  assert.equal(calls.length, 2);
  assert.equal(
    document.querySelector("main h1").textContent,
    "/collections/all/products/unknown-product",
  );
  assert.equal(
    window.location.pathname,
    "/collections/all/products/unknown-product",
  );
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
  for (const store of [storeFixtures.selectBlinds, storeFixtures.blinds2goUk]) {
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

test("wallet network, registration and initialization failures load the full page", async (t) => {
  const store = storeFixtures.blinds2goUk;
  for (const failure of ["network", "missing registration", "initialization"]) {
    await t.test(failure, async (t) => {
      const { document, window, navigation, warnings, errors, native } = setup(
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
      assert.deepEqual(native, [
        { method: "assign", url: `${store.origin}/cart` },
      ]);
      assert.equal(navigation.getSnapshot().pending, false);
      assert.equal(document.querySelector("main"), main);
      assert.equal(window.location.href, `${store.origin}/`);
      if (failure === "network") {
        assert.match(
          errors[0][1].reason,
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
  const store = storeFixtures.blinds2goUk;
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
    [storeFixtures.blinds2goUk, `https://example.org${walletPath}`],
    [
      storeFixtures.blinds2goUk,
      `${storeFixtures.blinds2goUk.origin}/cdn/shopifycloud/other-sdk.js`,
    ],
    [
      storeFixtures.blinds2goIe,
      `${storeFixtures.blinds2goIe.origin}${walletPath}`,
    ],
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
