import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const origin = "https://hd-dev-multi.myshopify.com";
const productOne = "/products/traditional-room-darkening-zebra-shades";
const productTwo = "/products/2-inch-levolor-classic-neutral-faux-wood-blinds";
const bundle = await build({
  entryPoints: ["frontend/src/tools/index.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanTools",
  platform: "browser",
});

const cartData = {
  currency: "GBP",
  item_count: 2,
  total_price: 25000,
  token: "CART_TOKEN_SECRET",
  note: "CART_NOTE_SECRET",
  attributes: { customer_email: "CUSTOMER_EMAIL_SECRET" },
  customer: { id: "CUSTOMER_ID_SECRET" },
  items: [
    {
      title: "Room darkening shades",
      quantity: 2,
      variant_id: 12345,
      final_line_price: 25000,
      key: "12345:configured-line",
      properties: { room: "ROOM_NAME_SECRET" },
    },
  ],
};

function cartResponse(data = cartData, options = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json; charset=utf-8" },
    json: async () => data,
    ...options,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function setup(t, options = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><form><input name="Width" value="25"></form></main><roman-ai-assistant></roman-ai-assistant></body></html>',
    {
      url: options.url ?? `${origin}${productOne}`,
      runScripts: "outside-only",
    },
  );
  const { window } = dom;
  const host = window.document.querySelector("roman-ai-assistant");
  host.dataset.shop = options.shop ?? "hd-dev-multi.myshopify.com";
  host.dataset.agentProfileUrl =
    "https://cdn.shopify.com/extensions/roman/assets/roman-agent-profile.json";
  const calls = [];
  const visits = [];
  const timers = new Map();
  let timerId = 0;
  let snapshot = { url: window.location.href, pending: false, error: null };
  window.fetch = (url, request) => {
    calls.push({ url: String(url), ...request });
    return options.fetch?.(url, request) ?? Promise.resolve(cartResponse());
  };
  const originalSetTimeout = window.setTimeout.bind(window);
  const originalClearTimeout = window.clearTimeout.bind(window);
  window.setTimeout = (callback, ms, ...args) => {
    if (ms !== 20000) return originalSetTimeout(callback, ms, ...args);
    const id = --timerId;
    timers.set(id, callback);
    return id;
  };
  window.clearTimeout = (id) => {
    timers.delete(id);
    originalClearTimeout(id);
  };
  const navigation = {
    getSnapshot: () => snapshot,
    navigate: async (path, signal) => {
      visits.push(path);
      if (options.navigate)
        snapshot = await options.navigate(path, snapshot, signal);
      else
        snapshot = {
          ...snapshot,
          url: new window.URL(path, window.location.href).href,
        };
      return snapshot.pending ? "cancelled" : "navigated";
    },
  };
  window.eval(`${bundle.outputFiles[0].text}\nwindow.RomanTools = RomanTools;`);
  const instances = [];
  const measurementCalls = [];
  const measurements =
    options.measurements ??
    (async (name, args) => {
      measurementCalls.push({ name, args: plain(args) });
      return name === "set_measurements"
        ? {
            status: "saved",
            draft: { ...args, updatedAt: "2026-09-15T00:00:00.000Z" },
          }
        : { status: "not_found", productPath: args.productPath };
    });
  const create = () => {
    const instance = window.RomanTools.createAssistantTools(
      host,
      navigation,
      measurements,
      options.showView,
    );
    instances.push(instance);
    return instance;
  };
  const tools = create();
  t.after(() => {
    for (const instance of instances) instance.dispose();
    dom.window.close();
  });
  return {
    window,
    host,
    tools,
    create,
    calls,
    visits,
    measurementCalls,
    timers,
    setPage: (path, extra = {}) => {
      snapshot = {
        ...snapshot,
        ...extra,
        url: new window.URL(path, window.location.href).href,
      };
    },
  };
}

test("tool calls reject malformed arguments and unknown names before requesting or mutating anything", async (t) => {
  const { tools, calls, visits, timers } = setup(t);
  const invalid = [
    ["unknown tool", "invented_tool", {}, /Unknown Roman tool/],
    ["null arguments", "get_cart", null, /Expected an object/],
    ["array arguments", "get_cart", [], /Expected an object/],
    ["primitive arguments", "get_cart", "{}", /Expected an object/],
    ["unexpected cart arguments", "get_cart", { token: "secret" }, /only/],
    ["empty query", "search_products", { query: "  " }, /query must be/],
    ["non-string query", "search_products", { query: 42 }, /query must be/],
    [
      "oversized query",
      "search_products",
      { query: "x".repeat(501) },
      /query must be/,
    ],
    ["missing product id", "get_product", {}, /id must be/],
    [
      "extra navigation argument",
      "navigate",
      { path: "/", force: true },
      /only/,
    ],
    ["invalid navigation path", "navigate", { path: 5 }, /path must be/],
    [
      "unexpected cart mutation argument",
      "add_to_cart",
      { variantId: 123 },
      /only/,
    ],
    [
      "zero width",
      "set_measurements",
      { width: 0, height: 100, unit: "cm" },
      /positive numeric/,
    ],
    [
      "negative height",
      "set_measurements",
      { width: 100, height: -1, unit: "cm" },
      /positive numeric/,
    ],
    [
      "numeric string",
      "set_measurements",
      { width: "100", height: 100, unit: "cm" },
      /positive numeric/,
    ],
    [
      "non-finite dimension",
      "set_measurements",
      { width: Infinity, height: 100, unit: "cm" },
      /positive numeric/,
    ],
    [
      "NaN dimension",
      "set_measurements",
      { width: 100, height: NaN, unit: "cm" },
      /positive numeric/,
    ],
    [
      "unknown unit",
      "set_measurements",
      { width: 100, height: 100, unit: "ft" },
      /unit of/,
    ],
  ];
  for (const [name, tool, input, error] of invalid) {
    await t.test(name, async () => {
      await assert.rejects(tools.execute(tool, input), error);
      assert.equal(
        timers.size,
        0,
        "failed calls release their timeout and active slot",
      );
    });
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(visits, []);
  assert.deepEqual(plain(await tools.execute("get_measurements", {})), {
    status: "not_found",
    productPath: productOne,
  });
});

test("catalog lookup and cart mutation arguments are validated before any request", async (t) => {
  const { tools, calls, timers } = setup(t);
  for (const [name, tool, input, expected] of [
    [
      "missing lookup IDs",
      "lookup_catalog",
      {},
      /array of product or variant IDs/,
    ],
    [
      "lookup scalar",
      "lookup_catalog",
      { ids: "gid://shopify/Product/1" },
      /array of product or variant IDs/,
    ],
    [
      "lookup numeric ID",
      "lookup_catalog",
      { ids: [1] },
      /array of product or variant IDs/,
    ],
    ["empty lookup", "lookup_catalog", { ids: [] }, /between 1 and 10/],
    [
      "oversized lookup",
      "lookup_catalog",
      {
        ids: Array.from(
          { length: 11 },
          (_, i) => `gid://shopify/Product/${i + 1}`,
        ),
      },
      /between 1 and 10/,
    ],
    [
      "non-product GID",
      "lookup_catalog",
      { ids: ["gid://shopify/Customer/1"] },
      /product or variant GIDs/,
    ],
    [
      "mixed invalid lookup",
      "lookup_catalog",
      { ids: ["gid://shopify/Product/1", "/products/blind"] },
      /product or variant GIDs/,
    ],
    [
      "extra lookup argument",
      "lookup_catalog",
      { ids: ["gid://shopify/Product/1"], query: "blind" },
      /only/,
    ],
    ["missing removal key", "remove_from_cart", {}, /lineKey must be/],
    [
      "blank removal key",
      "remove_from_cart",
      { lineKey: "   " },
      /lineKey must be/,
    ],
    [
      "numeric removal key",
      "remove_from_cart",
      { lineKey: 123 },
      /lineKey must be/,
    ],
    [
      "extra removal argument",
      "remove_from_cart",
      { lineKey: "123:line", quantity: 0 },
      /only/,
    ],
    [
      "missing quantity key",
      "set_cart_quantity",
      { quantity: 2 },
      /lineKey must be/,
    ],
    ["extra clear argument", "clear_cart", { force: true }, /only/],
    ["unsupported mutation name", "clearCart", {}, /Unknown Roman tool/],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(tools.execute(tool, input), expected);
      assert.equal(timers.size, 0);
    });
  }
  for (const quantity of [
    undefined,
    0,
    -1,
    1.5,
    NaN,
    "2",
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
  ]) {
    await assert.rejects(
      tools.execute("set_cart_quantity", { lineKey: "123:line", quantity }),
      /positive whole-number quantity/,
    );
  }
  assert.deepEqual(calls, []);
});

test("lookup_catalog dispatches validated IDs through the real catalog client", async (t) => {
  const ids = ["gid://shopify/Product/123", "gid://shopify/ProductVariant/456"];
  const { tools, calls } = setup(t, {
    fetch: (_url, request) => {
      const body = JSON.parse(request.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            structuredContent: {
              products: [{ id: ids[0], title: "Roman blind" }],
              messages: [],
              ucp: { status: "success", private_metadata: "INTERNAL_SECRET" },
            },
          },
        }),
      };
    },
  });
  const result = await tools.execute("lookup_catalog", {
    ids: [` ${ids[0]} `, ids[1]],
  });
  assert.equal(calls.length, 1);
  const request = JSON.parse(calls[0].body);
  assert.equal(request.params.name, "lookup_catalog");
  assert.deepEqual(request.params.arguments.catalog.ids, ids);
  assert.deepEqual(plain(result), {
    products: [{ id: ids[0], title: "Roman blind" }],
    messages: [],
  });
  assert.doesNotMatch(JSON.stringify(result), /INTERNAL_SECRET/);
});

test("manual measurements delegate canonical product drafts to the conversation owner without modifying theme inputs", async (t) => {
  const { window, tools, setPage, measurementCalls, calls } = setup(t);
  const before = window.document.querySelector("form").outerHTML;
  setPage("/en-gb/collections/all" + productOne + "/?variant=123#measure");
  const result = await tools.execute("set_measurements", {
    width: 100.5,
    height: 150,
    unit: "cm",
  });
  assert.equal(result.status, "saved");
  assert.deepEqual(measurementCalls[0], {
    name: "set_measurements",
    args: {
      productPath: productOne,
      width: 100.5,
      height: 150,
      unit: "cm",
      kind: "window",
      mount: "unknown",
    },
  });
  await tools.execute("get_measurements", {});
  assert.deepEqual(measurementCalls[1], {
    name: "get_measurements",
    args: { productPath: productOne },
  });
  assert.equal(window.document.querySelector("form").outerHTML, before);
  assert.deepEqual(calls, []);
});

test("measurement tools reject non-product pages and propagate persistence failures without pretending to save", async (t) => {
  const { tools, setPage } = setup(t, {
    measurements: async () => {
      throw new Error("Storage unavailable");
    },
  });
  setPage("/collections/all");
  await assert.rejects(tools.execute("get_measurements", {}), /Open a product/);
  setPage(productOne);
  await assert.rejects(
    tools.execute("set_measurements", { width: 100, height: 200, unit: "mm" }),
    /Storage unavailable/,
  );
});

test("cart reads use the locale-aware same-origin endpoint and return only useful non-sensitive fields", async (t) => {
  const { window, tools, calls } = setup(t);
  window.Shopify = { routes: { root: "/en-gb/" } };
  const result = await tools.execute("get_cart", {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${origin}/en-gb/cart.js`);
  assert.equal(calls[0].credentials, "same-origin");
  assert.equal(calls[0].cache, "no-store");
  assert.equal(calls[0].redirect, "error");
  assert.equal(calls[0].headers.Accept, "application/json");
  assert.equal(calls[0].signal.aborted, false);
  assert.deepEqual(plain(result), {
    currency: "GBP",
    itemCount: 2,
    totalPriceMinorUnits: 25000,
    items: [
      {
        title: "Room darkening shades",
        variantId: 12345,
        lineKey: "12345:configured-line",
        quantity: 2,
        linePriceMinorUnits: 25000,
      },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /SECRET|token|attributes|properties|customer|note/,
  );

  delete window.Shopify;
  await tools.execute("get_cart", {});
  assert.equal(calls[1].url, `${origin}/cart.js`);
});

test("cart reads parse real JSON bodies served with Shopify JavaScript or JSON MIME types", async (t) => {
  for (const contentType of [
    "text/javascript; charset=utf-8",
    "application/javascript",
    "application/json",
  ]) {
    await t.test(contentType, async (t) => {
      const { tools } = setup(t, {
        fetch: () =>
          new Response(JSON.stringify(cartData), {
            headers: { "Content-Type": contentType },
          }),
      });
      const result = await tools.execute("get_cart", {});
      assert.deepEqual(plain(result), {
        currency: "GBP",
        itemCount: 2,
        totalPriceMinorUnits: 25000,
        items: [
          {
            title: "Room darkening shades",
            variantId: 12345,
            lineKey: "12345:configured-line",
            quantity: 2,
            linePriceMinorUnits: 25000,
          },
        ],
      });
      assert.doesNotMatch(
        JSON.stringify(result),
        /SECRET|token|attributes|properties|customer|note/,
      );
    });
  }
});

test("malformed JSON and executable JavaScript cart bodies are rejected without execution or body disclosure", async (t) => {
  for (const [name, contentType, body, expected] of [
    [
      "malformed JSON",
      "application/json",
      '{"RAW_BODY_SECRET":',
      /invalid cart JSON/,
    ],
    [
      "JavaScript source",
      "text/javascript",
      'window.cartScriptExecuted = "RAW_BODY_SECRET";',
      /invalid cart JSON/,
    ],
    [
      "wrong JSON shape",
      "application/javascript",
      '{"debug":"RAW_BODY_SECRET"}',
      /invalid cart data/,
    ],
  ]) {
    await t.test(name, async (t) => {
      const { window, tools, timers } = setup(t, {
        fetch: () =>
          new Response(body, { headers: { "Content-Type": contentType } }),
      });
      await assert.rejects(tools.execute("get_cart", {}), (error) => {
        assert.match(error.message, expected);
        assert.doesNotMatch(
          error.message,
          /RAW_BODY_SECRET|cartScriptExecuted/,
        );
        return true;
      });
      assert.equal(window.cartScriptExecuted, undefined);
      assert.equal(timers.size, 0);
    });
  }
});

test("cancellation during real cart JSON parsing keeps the abort reason for valid and malformed bodies", async (t) => {
  for (const malformed of [false, true]) {
    await t.test(malformed ? "malformed body" : "valid body", async (t) => {
      let streamController;
      let markReading;
      const reading = new Promise((resolve) => {
        markReading = resolve;
      });
      const response = new Response(
        new ReadableStream({
          start(controller) {
            streamController = controller;
          },
        }),
        { headers: { "Content-Type": "text/javascript" } },
      );
      const parse = response.json.bind(response);
      response.json = () => {
        markReading();
        return parse();
      };
      const { tools, calls, timers } = setup(t, { fetch: () => response });
      const pending = tools.execute("get_cart", {});
      await reading;
      tools.dispose();
      const reason = calls[0].signal.reason;
      assert.equal(reason.name, "AbortError");
      streamController.enqueue(
        new TextEncoder().encode(
          malformed ? '{"RAW_BODY_SECRET":' : JSON.stringify(cartData),
        ),
      );
      streamController.close();
      await assert.rejects(pending, (error) => error === reason);
      assert.equal(timers.size, 0);
    });
  }
});

test("invalid cart route roots fail before any request", async (t) => {
  const { window, tools, calls } = setup(t);
  for (const root of [
    "https://example.org/",
    "//example.org/",
    `${origin.replace("https://", "https://user:password@")}/`,
    "/en-gb",
    "/en-gb/?token=secret",
    "/en-gb/#cart",
  ]) {
    window.Shopify = { routes: { root } };
    await assert.rejects(
      tools.execute("get_cart", {}),
      /cart route is invalid/,
    );
  }
  assert.deepEqual(calls, []);
});

test("cart reads reject missing or invalid line keys instead of offering unusable mutation targets", async (t) => {
  for (const key of [undefined, null, "", "   ", 123]) {
    const { tools } = setup(t, {
      fetch: () =>
        cartResponse({ ...cartData, items: [{ ...cartData.items[0], key }] }),
    });
    await assert.rejects(tools.execute("get_cart", {}), /invalid cart item/);
  }
});

test("cart HTTP, login and malformed response errors are surfaced and release the tool slot", async (t) => {
  const cases = [
    [
      "HTTP failure",
      () => cartResponse(undefined, { ok: false, status: 503 }),
      /failed \(503\)/,
    ],
    [
      "login HTML",
      () =>
        new Response(
          "<html><title>Sign in</title><body>LOGIN_BODY_SECRET</body></html>",
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        ),
      /Check your storefront login/,
    ],
    ["missing cart", () => cartResponse(null), /invalid cart data/],
    ["missing totals", () => cartResponse({ items: [] }), /invalid cart data/],
    [
      "invalid line item",
      () => cartResponse({ ...cartData, items: [{ title: "Blind" }] }),
      /invalid cart item/,
    ],
    [
      "network failure",
      () => {
        throw new Error("Connection interrupted");
      },
      /cart request could not be completed/,
    ],
  ];
  for (const [name, fetch, error] of cases) {
    await t.test(name, async (t) => {
      const { tools, timers } = setup(t, { fetch });
      await assert.rejects(tools.execute("get_cart", {}), (cause) => {
        assert.match(cause.message, error);
        assert.doesNotMatch(cause.message, /LOGIN_BODY_SECRET|<html>/);
        return true;
      });
      assert.equal(timers.size, 0);
      assert.equal(
        (await tools.execute("get_measurements", {})).status,
        "not_found",
      );
    });
  }
});

test("live Shopify tools are unavailable in the local preview and on unconfigured stores", async (t) => {
  for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
    await t.test(hostname, async (t) => {
      const { tools, calls } = setup(t, {
        url: `http://${hostname}:5173${productOne}`,
      });
      for (const [name, input] of [
        ["search_products", { query: "blind" }],
        ["get_product", { id: "123" }],
        ["lookup_catalog", { ids: ["gid://shopify/Product/123"] }],
        ["get_cart", {}],
        ["add_to_cart", {}],
        ["remove_from_cart", { lineKey: "123:line" }],
        ["set_cart_quantity", { lineKey: "123:line", quantity: 2 }],
        ["clear_cart", {}],
      ]) {
        await assert.rejects(
          tools.execute(name, input),
          /local preview has no Shopify session/,
        );
      }
      const stored = await tools.execute("set_measurements", {
        width: 100,
        height: 120,
        unit: "cm",
      });
      assert.equal(stored.draft.width, 100);
      assert.deepEqual(calls, []);
    });
  }
  const { tools, calls } = setup(t, { shop: "unrecognized.myshopify.com" });
  await assert.rejects(tools.execute("get_cart", {}), /not configured/);
  assert.deepEqual(calls, []);
});

test("tool execution prevents overlapping actions and disposal aborts the owner without accepting late data", async (t) => {
  let resolveFetch;
  const { tools, calls, timers } = setup(t, {
    fetch: () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
  });
  const pending = tools.execute("get_cart", {});
  assert.equal(calls.length, 1);
  assert.equal(timers.size, 1);
  await assert.rejects(
    tools.execute("get_cart", {}),
    /Another tool is still running/,
  );
  assert.equal(calls.length, 1);
  tools.dispose();
  assert.equal(calls[0].signal.aborted, true);
  resolveFetch(cartResponse());
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(timers.size, 0);
  await assert.rejects(tools.execute("get_measurements", {}), /disposed/);
});

test("tool timeout aborts the request and allows a later independent call", async (t) => {
  const { tools, calls, timers } = setup(t, {
    fetch: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  const pending = tools.execute("get_cart", {});
  assert.equal(timers.size, 1);
  const expire = [...timers.values()][0];
  expire();
  await assert.rejects(
    pending,
    /tool timed out.*before retrying a cart action/,
  );
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(timers.size, 0);
  assert.equal(
    (await tools.execute("get_measurements", {})).status,
    "not_found",
  );
});

test("aborting an already-submitted cart action preserves its handed-off outcome", async (t) => {
  for (const outcome of ["dispose", "timeout"]) {
    await t.test(outcome, async (t) => {
      const { window, tools, calls, timers } = setup(t);
      window.customElements.define(
        "app-provider",
        class extends window.HTMLElement {},
      );
      window.customElements.define(
        "cart-sections",
        class extends window.HTMLElement {},
      );
      const main = window.document.querySelector("main");
      const provider = window.document.createElement("app-provider");
      main.replaceWith(provider);
      provider.append(main);
      const owner = window.document.createElement("cart-sections");
      owner.cart = cartData;
      main.append(owner);
      let markSubmitted;
      let finishTheme;
      const submitted = new Promise((resolve) => {
        markSubmitted = resolve;
      });
      let submissions = 0;
      owner.clearCart = () => {
        submissions++;
        markSubmitted();
        return new Promise((resolve) => {
          finishTheme = resolve;
        });
      };
      const pending = tools.execute("clear_cart", {});
      await submitted;
      assert.equal(submissions, 1);
      if (outcome === "dispose") tools.dispose();
      else [...timers.values()][0]();
      const result = await pending;
      assert.equal(result.status, "handed_off");
      assert.match(result.message, /check the cart before trying again/i);
      assert.equal(
        result.cart,
        undefined,
        "an unconfirmed mutation must not invent an updated cart",
      );
      assert.equal(calls[0].signal.aborted, true);
      assert.equal(calls.length, 1);
      assert.equal(submissions, 1);
      assert.equal(timers.size, 0);
      finishTheme();
    });
  }
});

test("navigation tools delegate to the storefront owner and surface its failures", async (t) => {
  const { tools, visits, setPage, calls } = setup(t, {
    navigate: async (_path, state) => ({
      ...state,
      error: "Navigation must stay on the current storefront.",
    }),
  });
  await assert.rejects(
    tools.execute("navigate", {
      path: " https://other-store.example/products/blind ",
    }),
    /must stay on the current storefront/,
  );
  assert.deepEqual(visits, ["https://other-store.example/products/blind"]);
  setPage(productOne, { pending: true, error: null });
  for (const [name, input] of [
    ["add_to_cart", {}],
    ["remove_from_cart", { lineKey: "123:line" }],
    ["set_cart_quantity", { lineKey: "123:line", quantity: 2 }],
    ["clear_cart", {}],
  ])
    await assert.rejects(
      tools.execute(name, input),
      /Wait for storefront navigation/,
    );
  assert.deepEqual(calls, []);
});

test("pending navigation keeps its own deadline and disposed tools reject late navigation results", async (t) => {
  for (const disposed of [false, true]) {
    await t.test(disposed ? "disposed" : "result returned", async (t) => {
      let finishNavigation;
      const { tools, timers, visits } = setup(t, {
        navigate: () =>
          new Promise((resolve) => {
            finishNavigation = resolve;
          }),
      });
      const pending = tools.execute("navigate", { path: "/cart" });
      assert.deepEqual(visits, ["/cart"]);
      assert.equal(
        timers.size,
        0,
        "the tool must not add a deadline that cannot cancel storefront navigation",
      );
      await assert.rejects(
        tools.execute("get_measurements", {}),
        /Another tool is still running/,
      );
      if (disposed) tools.dispose();
      finishNavigation({ url: `${origin}/cart`, pending: true, error: null });
      if (disposed)
        await assert.rejects(pending, (error) => error.name === "AbortError");
      else
        assert.deepEqual(plain(await pending), {
          status: "cancelled",
          url: `${origin}/cart`,
          pending: true,
        });
      assert.equal(timers.size, 0);
    });
  }
});

test("navigation tools support complete model paths up to 2048 characters", async (t) => {
  const { tools, visits } = setup(t);
  const path = "/search?q=" + "x".repeat(2038);
  assert.equal(path.length, 2048);
  assert.deepEqual(plain(await tools.execute("navigate", { path })), {
    status: "navigated",
    url: origin + path,
    pending: false,
  });
  await assert.rejects(
    tools.execute("navigate", { path: path + "x" }),
    /path must be/,
  );
  assert.deepEqual(visits, [path]);
});

test("ending model navigation aborts the navigator request through the existing tool owner", async (t) => {
  let navigationSignal;
  const { tools, window, visits } = setup(t, {
    navigate: (_path, _state, signal) =>
      new Promise((_resolve, reject) => {
        navigationSignal = signal;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  const controller = new window.AbortController();
  const pending = tools.execute(
    "navigate",
    { path: "/cart" },
    controller.signal,
  );
  const rejected = assert.rejects(
    pending,
    (error) => error.name === "AbortError",
  );
  controller.abort();
  assert.equal(navigationSignal.aborted, true);
  await rejected;
  assert.deepEqual(visits, ["/cart"]);
  await tools.execute("get_measurements", {});
});

for (const opened of [true, false]) test('checkout shows Cart and reports its actual new-tab outcome: '+opened, async (t) => {
 const views=[]; const ctx=setup(t,{showView: async view=>views.push(view)}); const operations=[];
 const tab={set opener(value){operations.push(['opener',value])},location:{replace(url){operations.push(['navigate',url])}},close(){operations.push(['close'])}};
 ctx.window.open=(...args)=>{operations.push(['open',...args]);return opened?tab:null};
 assert.deepEqual(plain(await ctx.tools.execute('open_checkout',{})),{status:opened?'opened':'blocked'});
 assert.deepEqual(views,['cart']);
 assert.deepEqual(operations,opened?[['open','about:blank','_blank'],['opener',null],['navigate',origin+'/checkout']]:[['open','about:blank','_blank']]);
 assert.deepEqual(ctx.visits,[]); assert.deepEqual(ctx.calls,[]); assert.equal(ctx.window.location.href,origin+productOne);
});
test('checkout rejects arbitrary destinations and closes a blank tab if navigation fails', async (t) => {
 const ctx=setup(t,{showView:async()=>{}});let opens=0,closed=0;
 ctx.window.open=()=>{opens++;return{opener:'Roman',location:{replace(){throw Error('navigation denied')}},close(){closed++}}};
 for(const input of [null,[],{url:'https://other.example/checkout'},{path:'/checkout'},{payment:'secret'}])await assert.rejects(ctx.tools.execute('open_checkout',input));
 assert.equal(opens,0);
 await assert.rejects(ctx.tools.execute('open_checkout',{}),/navigation denied/);assert.equal(opens,1);assert.equal(closed,1);
});
test('checkout cannot open a tab after cancellation while changing views', async(t)=>{
 const controller=new AbortController();const ctx=setup(t,{showView:async()=>controller.abort()});ctx.window.open=()=>assert.fail('Cancelled request cannot open a tab');
 await assert.rejects(ctx.tools.execute('open_checkout',{},controller.signal),{name:'AbortError'});
});
