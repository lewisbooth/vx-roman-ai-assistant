import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["frontend/src/session/catalog-executor.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
});
const origin = "https://hd-dev-single.myshopify.com";
const product = {
  id: "gid://shopify/Product/123",
  title: "Live shade",
  url: `${origin}/products/shade`,
  description: { html: "" },
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(execute) {
  const module = { exports: {} };
  const warnings = [];
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    window: { location: { origin } },
    URL,
    Intl,
    console: { warn: (...args) => warnings.push(args) },
  });
  const calls = [];
  const executor = module.exports.createCatalogExecutor({
    execute: (...args) => {
      calls.push(args);
      return execute(...args);
    },
  });
  return { executor, calls, warnings };
}

test("rejected product data logs the failing field without dumping the catalog", async () => {
  const { executor, warnings } = setup(async () => ({
    products: [{ ...product, url: "https://private.example/products/shade" }],
  }));
  await assert.rejects(
    executor.execute("search_products", { query: "shade" }),
    /products\[0\]\.url expected/,
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "[Roman] Catalog response rejected.");
  assert.equal(warnings[0][1].tool, "search_products");
  assert.match(warnings[0][1].reason, /products\[0\]\.url expected/);
  assert.doesNotMatch(JSON.stringify(warnings), /private\.example|Live shade/);
});

test("model search and product-card lookups share serial execution and fresh projection", async () => {
  const gate = deferred();
  let count = 0;
  const { executor, calls } = setup(async () => {
    count++;
    if (count === 1) return gate.promise;
    return { products: [{ ...product, title: `Current shade ${count}` }] };
  });
  const search = executor.execute("search_products", { query: " no drill " });
  const lookup = executor.execute("lookup_catalog", { ids: [product.id] });
  await flush();
  assert.deepEqual(plain(calls), [["search_products", { query: "no drill" }]]);
  gate.resolve({
    products: [product],
    ucp: { private: "NEGOTIATION_METADATA" },
  });
  assert.deepEqual(plain(await search), {
    products: [
      {
        id: product.id,
        title: product.title,
        description: "",
        url: product.url,
      },
    ],
    messages: [],
  });
  assert.equal((await lookup).products[0].title, "Current shade 2");
  assert.equal(
    (await executor.execute("lookup_catalog", { ids: [product.id] }))
      .products[0].title,
    "Current shade 3",
  );
  assert.equal(
    calls.length,
    3,
    "a later lookup does not reuse cached products",
  );
});

test("handle-based search and card hydration return same-store links without catalog URLs", async () => {
  const handles = Array.from({ length: 10 }, (_, index) => ({
    id: `gid://shopify/Product/${index + 1}`,
    title: `No drill shade ${index + 1}`,
    handle: `no-drill-shade-${index + 1}`,
  }));
  const { executor, warnings } = setup(async () => ({
    products: handles,
    messages: [],
  }));
  const search = await executor.execute("search_products", {
    query: "no drill",
  });
  const cards = await executor.execute("lookup_catalog", {
    ids: search.products.map((item) => item.id),
  });
  for (const result of [search, cards]) {
    assert.equal(result.products.length, 10);
    result.products.forEach((item, index) => {
      assert.equal(item.url, `${origin}/products/${handles[index].handle}`);
    });
  }
  assert.deepEqual(warnings, []);
});

test("the queue bounds accepted lookups and releases capacity after completion", async () => {
  const gate = deferred();
  let count = 0;
  const { executor, calls } = setup(async () => {
    if (++count === 1) await gate.promise;
    return { products: [] };
  });
  const pending = Array.from({ length: 12 }, () =>
    executor.execute("search_products", { query: "shade" }),
  );
  await assert.rejects(
    executor.execute("search_products", { query: "overflow" }),
    /wait for the current product lookups/,
  );
  assert.equal(calls.length, 1);
  gate.resolve();
  await Promise.all(pending);
  assert.equal(calls.length, 12);
  await executor.execute("search_products", { query: "after completion" });
  assert.equal(calls.length, 13);
});

test("one failed lookup is not replayed and does not poison later queued work", async () => {
  const gate = deferred();
  let count = 0;
  const { executor, calls } = setup(async () => {
    if (++count === 1) return gate.promise;
    return { product };
  });
  const first = executor.execute("search_products", { query: "shade" });
  const rejected = assert.rejects(first, /catalog unavailable/);
  const next = executor.execute("get_product", { id: product.id });
  gate.reject(new Error("catalog unavailable"));
  await rejected;
  assert.equal((await next).products[0].id, product.id);
  assert.deepEqual(
    calls.map(([name]) => name),
    ["search_products", "get_product"],
  );
});

test("only validated read-only catalog calls reach the shared browser tool owner", async () => {
  const { executor, calls } = setup(async () => ({ products: [] }));
  for (const [name, args] of [
    ["clear_cart", {}],
    ["navigate", { path: "/cart" }],
    ["search_products", { query: "shade", shop: "other" }],
    ["lookup_catalog", { ids: [] }],
  ]) {
    assert.throws(() => executor.execute(name, args), /not supported/);
  }
  await executor.execute("lookup_catalog", { ids: [product.id, product.id] });
  assert.deepEqual(plain(calls), [["lookup_catalog", { ids: [product.id] }]]);
});

test("disposal rejects late results and queued calls without dispatching more browser work", async () => {
  const gate = deferred();
  const { executor, calls } = setup(() => gate.promise);
  const first = executor.execute("search_products", { query: "shade" });
  const second = executor.execute("lookup_catalog", { ids: [product.id] });
  const rejectedFirst = assert.rejects(first, /removed/);
  const rejectedSecond = assert.rejects(second, /removed/);
  await flush();
  assert.equal(calls.length, 1);
  executor.dispose();
  await assert.rejects(
    executor.execute("get_product", { id: product.id }),
    /wait for the current product lookups/,
  );
  gate.resolve({ products: [product] });
  await Promise.all([rejectedFirst, rejectedSecond]);
  assert.equal(calls.length, 1);
});
