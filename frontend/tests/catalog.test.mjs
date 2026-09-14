import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

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
  const requests = [];
  dom.window.fetch = async (url, init) => {
    const request = { url: String(url), init, body: JSON.parse(init.body) };
    requests.push(request);
    return handler(request);
  };
  dom.window.eval(
    `${bundle.outputFiles[0].text}\nwindow.RomanCatalog = RomanCatalog;`,
  );
  return {
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
  const products = [{ id: productId, title: "Roman blind" }];
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
    "  roman blinds  ",
    controller.signal,
    profile,
  );
  assert.deepEqual(plain(result), {
    products,
    pagination: { has_next_page: false },
    messages: [],
  });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, "https://hd-dev-single.myshopify.com/api/ucp/mcp");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.mode, "same-origin");
  assert.equal(request.init.credentials, "same-origin");
  assert.equal(request.init.signal, controller.signal);
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
    plain(await api.searchProducts("nothing", controller.signal, profile)),
    { products: [] },
  );
});

test("HTTP 422 discovery failures expose actionable UCP details without unrelated response data", async (t) => {
  const { api, controller } = setup(t, (request) => ({
    ok: false,
    status: 422,
    json: async () => discoveryError(request),
  }));
  await assert.rejects(
    api.searchProducts("roman", controller.signal, profile),
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
        api.searchProducts("roman", controller.signal, profile),
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
    api.searchProducts("roman", controller.signal, profile),
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
          api.searchProducts("roman", controller.signal, profile),
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
      api.searchProducts("roman", controller.signal, profile),
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
      api.searchProducts(query, controller.signal, profile),
      /1 and 500/,
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
      api.searchProducts("roman", controller.signal, invalidProfile),
      /Publish Roman's agent profile/,
    );
  }
  assert.equal(requests.length, 0);
});

test("cancellation before and during the request remains cancellation", async (t) => {
  const initial = setup(t, () => assert.fail("Unexpected fetch"));
  initial.controller.abort();
  await assert.rejects(
    initial.api.searchProducts("roman", initial.controller.signal, profile),
    (error) => error === initial.controller.signal.reason,
  );

  const active = setup(t, async (request) => {
    active.controller.abort();
    throw request.init.signal.reason;
  });
  await assert.rejects(
    active.api.searchProducts("roman", active.controller.signal, profile),
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
    api.searchProducts("roman", controller.signal, profile),
    (error) => error === controller.signal.reason,
  );
});

test("simultaneous calls correlate their own response IDs", async (t) => {
  const pending = [];
  const { api, controller, requests } = setup(
    t,
    (request) => new Promise((resolve) => pending.push({ request, resolve })),
  );
  const first = api.searchProducts("roman", controller.signal, profile);
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
  assert.deepEqual(plain(await first), { products: [] });
});
