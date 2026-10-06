import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { catalogHttpResponse } from "./fixtures/catalog-http.mjs";

const bundle = await build({
  entryPoints: ["frontend/src/tools/catalog.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanCatalog",
  platform: "browser",
});
const profile =
  "https://cdn.shopify.com/extensions/roman/assets/roman-agent-profile.json?v=1";
const productId = "gid://shopify/Product/123";

function setup(t, handler) {
  const dom = new JSDOM(
    '<!doctype html><base href="https://unrelated.example/">',
    {
      url: "https://hd-dev-single.myshopify.com/products/test",
      runScripts: "outside-only",
    },
  );
  t.after(() => dom.window.close());
  dom.window.TextEncoder = TextEncoder;
  dom.window.TextDecoder = TextDecoder;
  const requests = [];
  dom.window.fetch = async (url, init) => {
    const request = { url: String(url), init, body: JSON.parse(init.body) };
    requests.push(request);
    return catalogHttpResponse(handler(request));
  };
  dom.window.eval(
    `${bundle.outputFiles[0].text}\nwindow.RomanCatalog = RomanCatalog;`,
  );
  return {
    window: dom.window,
    api: dom.window.RomanCatalog,
    controller: new dom.window.AbortController(),
    requests,
  };
}

function response(request, result) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: request.body.id, result }),
  };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function discoveryError(request) {
  return {
    jsonrpc: "2.0",
    id: request.body.id,
    error: {
      code: -32001,
      message: "UCP discovery failed",
      data: {
        code: "profile_malformed",
        content: "Unable to fetch agent profile: Missing services",
        continue_url: "https://hd-dev-single.myshopify.com/",
        internal: { customer: "CUSTOMER_SECRET" },
        debug: "ARBITRARY_DATA_SECRET",
      },
    },
  };
}

test("search uses the current storefront and Roman profile, returning only catalog data", async (t) => {
  const products = [
    { id: productId, title: "Roman blind", handle: "roman-blind" },
  ];
  const { api, controller, requests } = setup(t, (request) =>
    response(request, {
      structuredContent: {
        ucp: { status: "success", payment_handlers: { ignored: true } },
        products,
        pagination: { has_next_page: false },
        messages: [],
      },
    }),
  );
  const result = await api.searchProducts(
    ["  roman blinds  "],
    controller.signal,
    profile,
  );
  assert.deepEqual(plain(result), {
    products: [
      {
        id: productId,
        title: "Roman blind",
        description: "",
        url: "https://hd-dev-single.myshopify.com/products/roman-blind",
      },
    ],
    messages: [],
    queries: [
      { query: "roman blinds", status: "succeeded", productIds: [productId] },
    ],
  });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, "https://hd-dev-single.myshopify.com/api/ucp/mcp");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.mode, "same-origin");
  assert.equal(request.init.credentials, "same-origin");
  assert.notEqual(request.init.signal, controller.signal);
  assert.equal(request.init.signal.aborted, false);
  assert.deepEqual(request.body, {
    jsonrpc: "2.0",
    id: request.body.id,
    method: "tools/call",
    params: {
      name: "search_catalog",
      arguments: {
        meta: { "ucp-agent": { profile } },
        catalog: { query: "roman blinds", pagination: { limit: 10 } },
      },
    },
  });
});

test("one search batch starts all bounded queries together and retains deterministic provenance after deduplication", async (t) => {
  const pending = [];
  const { api, controller, requests } = setup(
    t,
    (request) => new Promise((resolve) => pending.push({ request, resolve })),
  );
  const searching = api.searchProducts(
    ["roller", "roman", "venetian"],
    controller.signal,
    profile,
  );
  assert.equal(
    requests.length,
    3,
    "all three independent requests start before any completes",
  );
  assert.equal(
    new Set(requests.map(({ init }) => init.signal)).size,
    1,
    "one shared deadline signal",
  );
  const product = (id, title) => ({
    id: `gid://shopify/Product/${id}`,
    title,
    handle: `blind-${id}`,
  });
  pending[2].resolve(
    response(pending[2].request, {
      structuredContent: { products: [product(3, "Venetian")] },
    }),
  );
  pending[1].resolve(
    response(pending[1].request, {
      structuredContent: {
        products: [product(2, "Roman"), product(1, "Duplicate")],
      },
    }),
  );
  pending[0].resolve(
    response(pending[0].request, {
      structuredContent: { products: [product(1, "Roller")] },
    }),
  );
  const result = plain(await searching);
  assert.deepEqual(
    result.products.map(({ title }) => title),
    ["Roller", "Roman", "Venetian"],
  );
  assert.deepEqual(result.queries, [
    {
      query: "roller",
      status: "succeeded",
      productIds: ["gid://shopify/Product/1"],
    },
    {
      query: "roman",
      status: "succeeded",
      productIds: ["gid://shopify/Product/2", "gid://shopify/Product/1"],
    },
    {
      query: "venetian",
      status: "succeeded",
      productIds: ["gid://shopify/Product/3"],
    },
  ]);
});

test("failed and malformed queries keep successful siblings without exposing provider exception content", async (t) => {
  const { api, controller } = setup(t, (request) => {
    const query = request.body.params.arguments.catalog.query;
    if (query === "failed") throw new Error("SECRET_PROVIDER_BODY");
    return response(request, {
      structuredContent: {
        products:
          query === "malformed"
            ? [
                {
                  id: productId,
                  title: "Bad URL",
                  url: "https://attacker.example/products/test",
                },
              ]
            : [{ id: productId, title: "Good", handle: "good" }],
      },
    });
  });
  const result = plain(
    await api.searchProducts(
      ["good", "failed", "malformed"],
      controller.signal,
      profile,
    ),
  );
  assert.equal(result.products.length, 1);
  assert.deepEqual(result.queries, [
    { query: "good", status: "succeeded", productIds: [productId] },
    {
      query: "failed",
      status: "failed",
      productIds: [],
      error: "request_failed",
    },
    {
      query: "malformed",
      status: "failed",
      productIds: [],
      error: "invalid_response",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|attacker/);
});

test("HTTP failures retain safe categories alongside successful candidates without retrying", async (t) => {
  const { api, controller, requests } = setup(t, (request) => {
    const query = request.body.params.arguments.catalog.query;
    if (query === "good")
      return response(request, {
        structuredContent: {
          products: [{ id: productId, title: "Good", handle: "good" }],
        },
      });
    return {
      ok: false,
      status: query === "limited" ? 429 : 403,
      json: async () => ({
        jsonrpc: "2.0",
        id: request.body.id,
        error: {
          message: "SECRET_PROVIDER_BODY https://upstream.example/private",
          data: { content: "PRIVATE_CONTENT", continue_url: "PRIVATE_URL" },
        },
      }),
    };
  });
  const result = plain(
    await api.searchProducts(
      ["good", "limited", "denied"],
      controller.signal,
      profile,
    ),
  );
  assert.deepEqual(result.queries, [
    { query: "good", status: "succeeded", productIds: [productId] },
    {
      query: "limited",
      status: "failed",
      productIds: [],
      error: "rate_limited",
    },
    {
      query: "denied",
      status: "failed",
      productIds: [],
      error: "unauthorized",
    },
  ]);
  assert.equal(result.products.length, 1);
  assert.equal(requests.length, 3, "each query is dispatched once");
  assert.equal(new Set(requests.map(({ init }) => init.signal)).size, 1);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE|upstream/);
});

test("HTTP status determines the search category even with unusable or misleading bodies", async (t) => {
  for (const [status, error] of [
    [401, "unauthorized"],
    [403, "unauthorized"],
    [429, "rate_limited"],
    [500, "service_unavailable"],
    [502, "service_unavailable"],
    [503, "service_unavailable"],
    [504, "service_unavailable"],
    [404, "request_failed"],
    [422, "request_failed"],
  ]) {
    await t.test(`HTTP ${status}`, async (t) => {
      const { api, controller, requests } = setup(t, (request) => ({
        ok: false,
        status,
        json: async () => {
          if (status % 2) throw new SyntaxError("<html>PRIVATE_BODY</html>");
          // A plausible success or a body saying "rate limited" cannot override HTTP.
          return {
            jsonrpc: "2.0",
            id: request.body.id,
            result: { structuredContent: { products: [] } },
            debug: "rate limited PRIVATE_URL",
          };
        },
      }));
      const result = plain(
        await api.searchProducts(["blinds"], controller.signal, profile),
      );
      assert.deepEqual(result, {
        products: [],
        messages: [],
        queries: [{ query: "blinds", status: "failed", productIds: [], error }],
      });
      assert.equal(requests.length, 1);
    });
  }
});

test("a successful empty search and unavailable service stay distinct in the same batch", async (t) => {
  const { api, controller } = setup(t, (request) => {
    if (request.body.params.arguments.catalog.query === "empty")
      return response(request, { structuredContent: { products: [] } });
    return { ok: false, status: 503 };
  });
  const result = plain(
    await api.searchProducts(["empty", "unavailable"], controller.signal, profile),
  );
  assert.deepEqual(result.queries, [
    { query: "empty", status: "succeeded", productIds: [] },
    {
      query: "unavailable",
      status: "failed",
      productIds: [],
      error: "service_unavailable",
    },
  ]);
});

test("malformed successful responses are invalid results rather than empty matches", async (t) => {
  for (const [name, reply] of [
    [
      "non-JSON",
      () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("PRIVATE_BODY");
        },
      }),
    ],
    [
      "wrong request ID",
      () => ({
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: -1, result: {} }),
      }),
    ],
    [
      "missing products",
      (request) => response(request, { structuredContent: { products: null } }),
    ],
    [
      "invalid structured content",
      (request) => response(request, { structuredContent: null }),
    ],
  ]) {
    await t.test(name, async (t) => {
      const { api, controller } = setup(t, reply);
      assert.deepEqual(
        plain(await api.searchProducts(["blinds"], controller.signal, profile)),
        {
          products: [],
          messages: [],
          queries: [
            {
              query: "blinds",
              status: "failed",
              productIds: [],
              error: "invalid_response",
            },
          ],
        },
      );
    });
  }
});

test("a protocol business error does not imply an HTTP category from remote wording", async (t) => {
  const { api, controller } = setup(t, (request) => ({
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: "2.0",
      id: request.body.id,
      error: { message: "Rate limited: unauthorized PRIVATE_URL" },
    }),
  }));
  const result = plain(
    await api.searchProducts(["blinds"], controller.signal, profile),
  );
  assert.deepEqual(result.queries, [
    {
      query: "blinds",
      status: "failed",
      productIds: [],
      error: "request_failed",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /Rate limited|PRIVATE_URL/);
});

test("caller cancellation during an HTTP failure rejects the batch instead of reporting empty failures", async (t) => {
  const { api, controller, requests } = setup(t, () => ({
    ok: false,
    status: 429,
    json: async () => {
      controller.abort(new Error("Cancelled by customer"));
      throw new SyntaxError("PRIVATE_BODY");
    },
  }));
  await assert.rejects(
    api.searchProducts(["roller", "roman", "venetian"], controller.signal, profile),
    (error) => error === controller.signal.reason,
  );
  assert.equal(requests.length, 3);
  assert.ok(requests.every(({ init }) => init.signal.aborted));
});

test("the shared deadline ends unfinished queries and preserves completed results", async (t) => {
  const { api, controller, window, requests } = setup(t, (request) => {
    if (request.body.params.arguments.catalog.query === "quick")
      return response(request, {
        structuredContent: {
          products: [{ id: productId, title: "Quick", handle: "quick" }],
        },
      });
    return new Promise((_resolve, reject) =>
      request.init.signal.addEventListener(
        "abort",
        () => reject(request.init.signal.reason),
        { once: true },
      ),
    );
  });
  const timers = new Map();
  window.setTimeout = (callback, ms) => {
    assert.equal(ms, 20000);
    timers.set(1, callback);
    return 1;
  };
  window.clearTimeout = (id) => timers.delete(id);
  const searching = api.searchProducts(
    ["quick", "slow", "slowest"],
    controller.signal,
    profile,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.size, 1);
  timers.get(1)();
  const result = plain(await searching);
  assert.equal(result.products.length, 1);
  assert.deepEqual(
    result.queries.map(({ status, error }) => [status, error]),
    [
      ["succeeded", undefined],
      ["failed", "timeout"],
      ["failed", "timeout"],
    ],
  );
  assert.equal(
    requests.every(({ init }) => init.signal.aborted),
    true,
  );
  assert.equal(
    controller.signal.aborted,
    false,
    "deadline is distinct from caller cancellation",
  );
  assert.equal(timers.size, 0);
});

test("caller cancellation aborts every query and rejects partial results", async (t) => {
  const { api, controller, requests } = setup(
    t,
    (request) =>
      new Promise((_resolve, reject) =>
        request.init.signal.addEventListener(
          "abort",
          () => reject(request.init.signal.reason),
          { once: true },
        ),
      ),
  );
  const searching = api.searchProducts(
    ["roller", "roman", "venetian"],
    controller.signal,
    profile,
  );
  controller.abort(new Error("Cancelled by customer"));
  await assert.rejects(
    searching,
    (error) => error === controller.signal.reason,
  );
  assert.equal(requests.length, 3);
  assert.ok(requests.every(({ init }) => init.signal.aborted));
});

test("batch query validation rejects empty, repeated, excessive and retired arguments before requests", async (t) => {
  const { api, controller, requests } = setup(t, () =>
    assert.fail("No request permitted"),
  );
  for (const queries of [
    [],
    [" "],
    [42],
    ["a", "b", "c", "d"],
    ["same", " same "],
    "retired single query",
    ["x".repeat(501)],
  ])
    await assert.rejects(
      api.searchProducts(queries, controller.signal, profile),
      /catalog tool or its arguments/,
    );
  assert.equal(requests.length, 0);
});

test("batch results admit thirty candidates but keep multibyte payloads bounded", async (t) => {
  for (const oversized of [false, true]) {
    const { api, controller } = setup(t, (request) => {
      const group = Number(request.body.params.arguments.catalog.query);
      return response(request, {
        structuredContent: {
          products: Array.from({ length: 10 }, (_, i) => ({
            id: `gid://shopify/Product/${group * 10 + i + 1}`,
            title: `Blind ${i}`,
            handle: `blind-${group}-${i}`,
            description: {
              plain: oversized ? "織".repeat(2000) : "Useful catalog evidence",
            },
          })),
        },
      });
    });
    const result = plain(
      await api.searchProducts(["0", "1", "2"], controller.signal, profile),
    );
    assert.ok(
      new TextEncoder().encode(JSON.stringify(result)).byteLength <= 120 * 1024,
    );
    assert.equal(result.products.length, 30);
    assert.deepEqual(
      result.queries.map(({ productIds }) => productIds.length),
      [10, 10, 10],
      "Payload bounds preserve every category's candidates",
    );
    assert.equal(
      result.queries.flatMap(({ productIds }) => productIds).length,
      result.products.length,
    );
    if (oversized) {
      assert.equal(result.messages.at(-1).code, "result_size_limit");
      assert.ok(
        result.products.every(
          ({ description }) =>
            description.length > 0 && description.length < 2000,
        ),
      );
      assert.equal(
        new Set(result.products.map(({ description }) => description.length))
          .size,
        1,
      );
    }
  }
});

test("oversized optional imagery is omitted before verified product references or query coverage", async (t) => {
  const origin = "https://hd-dev-single.myshopify.com";
  const { api, controller } = setup(t, (request) => {
    const group = Number(request.body.params.arguments.catalog.query);
    return response(request, {
      structuredContent: {
        products: Array.from({ length: 10 }, (_, index) => ({
          id: `gid://shopify/Product/${group * 10 + index + 1}`,
          title: "\u754c".repeat(200),
          url: `${origin}/products/${group}-${index}-${"x".repeat(1950)}`,
          description: { plain: "Useful evidence" },
          media: [
            {
              type: "image",
              url: `https://cdn.shopify.com/${"x".repeat(1980)}`,
            },
          ],
        })),
      },
    });
  });
  const result = plain(
    await api.searchProducts(["0", "1", "2"], controller.signal, profile),
  );
  assert.equal(result.products.length, 30);
  assert.deepEqual(
    result.queries.map(({ productIds }) => productIds.length),
    [10, 10, 10],
  );
  assert.ok(
    result.products.every(
      ({ title, url, imageUrl, description }) =>
        title === "\u754c".repeat(200) &&
        url.length > 1950 &&
        imageUrl === undefined &&
        description === "Useful evidence",
    ),
  );
  assert.equal(result.messages.at(-1).code, "result_size_limit");
  assert.ok(
    new TextEncoder().encode(JSON.stringify(result)).byteLength <= 120 * 1024,
  );
});

test("catalog transport rejects advertised and streamed bodies over 1 MiB and cancels their readers", async (t) => {
  for (const advertised of [true, false]) {
    let cancelled = 0;
    const { api, controller } = setup(t, (request) => {
      if (request.body.params.arguments.catalog.query === "good")
        return response(request, {
          structuredContent: {
            products: [{ id: productId, title: "Good", handle: "good" }],
          },
        });
      return {
        ok: true,
        headers: new Headers(
          advertised ? { "content-length": String(1024 * 1024 + 1) } : {},
        ),
        body: new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(512 * 1024));
          },
          cancel() {
            cancelled++;
          },
        }),
      };
    });
    const result = await api.searchProducts(
      ["oversize", "good"],
      controller.signal,
      profile,
    );
    assert.equal(cancelled, 1);
    assert.equal(result.queries[0].status, "failed");
    assert.equal(result.products[0].title, "Good");
  }
});

test("product details use get_product with the supplied Shopify identifier", async (t) => {
  const product = {
    id: productId,
    description: { html: "<script>untrusted()</script>" },
  };
  const { api, controller, requests } = setup(t, (request) =>
    response(request, {
      structuredContent: { product, messages: [] },
    }),
  );
  assert.deepEqual(
    plain(await api.getProduct(productId, controller.signal, profile)),
    {
      product,
      messages: [],
    },
  );
  assert.equal(requests[0].body.params.name, "get_product");
  assert.deepEqual(requests[0].body.params.arguments.catalog, {
    id: productId,
  });
});

test("catalog lookup batches product and variant GIDs, preserving matches and missing IDs", async (t) => {
  const variantId = "gid://shopify/ProductVariant/456";
  const missingId = "gid://shopify/Product/999";
  const products = [
    {
      id: productId,
      variants: [
        {
          id: variantId,
          inputs: [
            { id: productId, match: "featured" },
            { id: variantId, match: "exact" },
          ],
        },
      ],
    },
  ];
  const messages = [{ type: "info", code: "not_found", content: missingId }];
  const { api, controller, requests } = setup(t, (request) =>
    response(request, {
      structuredContent: {
        ucp: { status: "success", payment_handlers: { ignored: true } },
        products,
        messages,
      },
    }),
  );
  assert.deepEqual(
    plain(
      await api.lookupCatalog(
        [` ${productId} `, variantId, missingId],
        controller.signal,
        profile,
      ),
    ),
    { products, messages },
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.params.name, "lookup_catalog");
  assert.deepEqual(requests[0].body.params.arguments, {
    meta: { "ucp-agent": { profile } },
    catalog: { ids: [productId, variantId, missingId] },
  });
});

test("lookup accepts the Storefront MCP ten-identifier limit and reports no matches", async (t) => {
  const ids = Array.from(
    { length: 10 },
    (_, index) => `gid://shopify/Product/${index + 1}`,
  );
  const messages = ids.map((id) => ({
    type: "info",
    code: "not_found",
    content: id,
  }));
  const { api, controller, requests } = setup(t, (request) =>
    response(request, {
      structuredContent: { products: [], messages },
    }),
  );
  assert.deepEqual(
    plain(await api.lookupCatalog(ids, controller.signal, profile)),
    { products: [], messages },
  );
  assert.deepEqual(requests[0].body.params.arguments.catalog, { ids });
});

test("lookup rejects unsupported identifiers and batch sizes before requesting Shopify", async (t) => {
  const { api, controller, requests } = setup(t, () =>
    assert.fail("Unexpected fetch"),
  );
  for (const ids of [
    [],
    Array(11).fill(productId),
    ["https://hd-dev-single.myshopify.com/products/roman"],
    ["123"],
    ["gid://shopify/Collection/123"],
    ["gid://shopify/p/123"],
    [productId, " "],
    [productId, 123],
    [productId, null],
    productId,
    null,
  ]) {
    await assert.rejects(
      api.lookupCatalog(ids, controller.signal, profile),
      /between 1 and 10 Shopify product or variant GIDs/,
    );
  }
  assert.equal(requests.length, 0);
});

test("lookup does not treat malformed data or business errors as an empty match", async (t) => {
  for (const [data, expected] of [
    [{ products: null }, /without products/],
    [
      {
        products: [],
        messages: [
          { type: "error", content: "Catalog temporarily unavailable" },
        ],
      },
      /Catalog temporarily unavailable/,
    ],
  ]) {
    const { api, controller } = setup(t, (request) =>
      response(request, { structuredContent: data }),
    );
    await assert.rejects(
      api.lookupCatalog([productId], controller.signal, profile),
      expected,
    );
  }
});

test("MCP JSON text content is accepted when structuredContent is absent", async (t) => {
  const { api, controller } = setup(t, (request) =>
    response(request, {
      content: [{ type: "text", text: JSON.stringify({ products: [] }) }],
    }),
  );
  assert.deepEqual(
    plain(await api.searchProducts(["nothing"], controller.signal, profile)),
    {
      products: [],
      messages: [],
      queries: [{ query: "nothing", status: "succeeded", productIds: [] }],
    },
  );
});

test("HTTP 422 discovery failures expose actionable UCP details without unrelated response data", async (t) => {
  const { api, controller } = setup(t, (request) => ({
    ok: false,
    status: 422,
    json: async () => discoveryError(request),
  }));
  await assert.rejects(
    api.lookupCatalog([productId], controller.signal, profile),
    (error) => {
      assert.match(error.message, /HTTP 422/);
      assert.match(error.message, /UCP discovery failed/);
      assert.match(
        error.message,
        /Unable to fetch agent profile: Missing services/,
      );
      assert.match(error.message, /profile_malformed/);
      assert.doesNotMatch(
        error.message,
        /continue_url|https:\/\/hd-dev-single|SECRET|\[object Object\]/,
      );
      return true;
    },
  );
});

test("HTTP failures without a usable JSON error retain the HTTP diagnostic", async (t) => {
  for (const [name, reply] of [
    [
      "non-JSON body",
      () => ({
        ok: false,
        status: 503,
        json: async () => {
          throw new SyntaxError("<html>SERVER_SECRET</html>");
        },
      }),
    ],
    ["missing body", () => ({ ok: false, status: 503 })],
    [
      "unstructured JSON body",
      () => ({
        ok: false,
        status: 503,
        json: async () => ({ debug: "SERVER_SECRET" }),
      }),
    ],
  ]) {
    await t.test(name, async (t) => {
      const { api, controller } = setup(t, reply);
      await assert.rejects(
        api.lookupCatalog([productId], controller.signal, profile),
        (error) => {
          assert.match(error.message, /HTTP 503/);
          assert.doesNotMatch(error.message, /SERVER_SECRET|<html>/);
          return true;
        },
      );
    });
  }
});

test("a valid success envelope cannot turn a failed HTTP response into catalog success", async (t) => {
  const { api, controller } = setup(t, (request) => ({
    ...response(request, {
      structuredContent: { products: [{ id: productId }] },
    }),
    ok: false,
    status: 502,
  }));
  await assert.rejects(
    api.lookupCatalog([productId], controller.signal, profile),
    /HTTP 502/,
  );
});

test("cancellation while reading an HTTP error body remains cancellation", async (t) => {
  for (const parseFails of [false, true]) {
    await t.test(
      parseFails ? "JSON parsing rejects" : "JSON parsing resolves",
      async (t) => {
        const { api, controller } = setup(t, (request) => ({
          ok: false,
          status: 422,
          json: async () => {
            controller.abort();
            if (parseFails) throw new SyntaxError("Invalid JSON");
            return discoveryError(request);
          },
        }));
        await assert.rejects(
          api.lookupCatalog([productId], controller.signal, profile),
          (error) => error === controller.signal.reason,
        );
      },
    );
  }
});

for (const [label, reply, expected] of [
  ["HTTP failure", () => ({ ok: false, status: 429 }), /HTTP 429/],
  [
    "network failure",
    () => {
      throw new TypeError("Failed to fetch");
    },
    /Could not reach/,
  ],
  [
    "non-JSON storefront response",
    () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError();
      },
    }),
    /did not return JSON/,
  ],
  [
    "wrong JSON-RPC request ID",
    () => ({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: -1, result: {} }),
    }),
    /invalid catalog protocol/,
  ],
  [
    "JSON-RPC error",
    (request) => ({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: request.body.id,
        error: { code: -32602, message: "Profile unavailable" },
      }),
    }),
    /Profile unavailable/,
  ],
  [
    "MCP tool failure",
    (request) =>
      response(request, {
        isError: true,
        content: [{ type: "text", text: "Failed" }],
      }),
    /could not run the catalog tool/,
  ],
  [
    "UCP negotiation failure",
    (request) =>
      response(request, {
        structuredContent: { ucp: { status: "error" }, messages: [] },
      }),
    /UCP negotiation/,
  ],
  [
    "UCP business error",
    (request) =>
      response(request, {
        structuredContent: {
          ucp: { status: "success" },
          products: [],
          messages: [{ type: "error", content: "This catalog is unavailable" }],
        },
      }),
    /This catalog is unavailable/,
  ],
  [
    "malformed structured content",
    (request) =>
      response(request, {
        structuredContent: null,
        content: [{ type: "text", text: '{"products":[]}' }],
      }),
    /invalid catalog response/,
  ],
  [
    "remote markup instead of data",
    (request) =>
      response(request, {
        content: [{ type: "text", text: "<html>Store login</html>" }],
      }),
    /invalid catalog response/,
  ],
  [
    "missing products",
    (request) => response(request, { structuredContent: { products: null } }),
    /without products/,
  ],
]) {
  test(`catalog rejects ${label}`, async (t) => {
    const { api, controller } = setup(t, reply);
    await assert.rejects(
      api.lookupCatalog([productId], controller.signal, profile),
      expected,
    );
  });
}

test("missing products are not reported as successful product lookups", async (t) => {
  const { api, controller } = setup(t, (request) =>
    response(request, {
      structuredContent: { product: null, messages: [] },
    }),
  );
  await assert.rejects(
    api.getProduct(productId, controller.signal, profile),
    /did not return this product/,
  );
});

test("invalid user inputs and unpublished profiles fail before requesting Shopify", async (t) => {
  const { api, controller, requests } = setup(t, () =>
    assert.fail("Unexpected fetch"),
  );
  for (const query of ["   ", "r".repeat(501)]) {
    await assert.rejects(
      api.searchProducts([query], controller.signal, profile),
      /catalog tool or its arguments/,
    );
  }
  await assert.rejects(
    api.getProduct(
      "https://another-shop.example/products/test",
      controller.signal,
      profile,
    ),
    /Shopify product or variant GID/,
  );
  for (const invalidProfile of [
    undefined,
    "",
    "http://localhost/profile.json",
    "https://user:secret@example.com/profile.json",
  ]) {
    await assert.rejects(
      api.searchProducts(["roman"], controller.signal, invalidProfile),
      /Publish Roman's agent profile/,
    );
  }
  assert.equal(requests.length, 0);
});

test("cancellation before and during the request remains cancellation", async (t) => {
  const initial = setup(t, () => assert.fail("Unexpected fetch"));
  initial.controller.abort();
  await assert.rejects(
    initial.api.searchProducts(["roman"], initial.controller.signal, profile),
    (error) => error === initial.controller.signal.reason,
  );

  const active = setup(t, async (request) => {
    active.controller.abort();
    throw request.init.signal.reason;
  });
  await assert.rejects(
    active.api.searchProducts(["roman"], active.controller.signal, profile),
    (error) => error === active.controller.signal.reason,
  );
});

test("cancellation while reading JSON cannot publish a stale success", async (t) => {
  const { api, controller } = setup(t, (request) => ({
    ok: true,
    json: async () => {
      controller.abort();
      return {
        jsonrpc: "2.0",
        id: request.body.id,
        result: { structuredContent: { products: [] } },
      };
    },
  }));
  await assert.rejects(
    api.searchProducts(["roman"], controller.signal, profile),
    (error) => error === controller.signal.reason,
  );
});

test("simultaneous calls correlate their own response IDs", async (t) => {
  const pending = [];
  const { api, controller, requests } = setup(
    t,
    (request) => new Promise((resolve) => pending.push({ request, resolve })),
  );
  const first = api.searchProducts(["roman"], controller.signal, profile);
  const second = api.getProduct(productId, controller.signal, profile);
  assert.notEqual(requests[0].body.id, requests[1].body.id);
  pending[1].resolve(
    response(pending[1].request, {
      structuredContent: { product: { id: productId } },
    }),
  );
  pending[0].resolve(
    response(pending[0].request, { structuredContent: { products: [] } }),
  );
  assert.deepEqual(plain(await second), { product: { id: productId } });
  assert.deepEqual(plain(await first), {
    products: [],
    messages: [],
    queries: [{ query: "roman", status: "succeeded", productIds: [] }],
  });
});
