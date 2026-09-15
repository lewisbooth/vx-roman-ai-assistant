import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["frontend/src/session/storefront-executor.ts"],
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
  const location = { origin, href: `${origin}/` };
  const clock = { now: Date.now() };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    window: { location },
    URL,
    Intl,
    AbortController,
    DOMException,
    Date: class extends Date {
      static now() {
        return clock.now;
      }
    },
    console: { warn: (...args) => warnings.push(args) },
  });
  const calls = [];
  const executor = module.exports.createStorefrontExecutor({
    execute: (...args) => {
      calls.push(args.slice(0, 2));
      return execute(...args);
    },
  });
  return { executor, calls, warnings, location, clock };
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

test("model catalog tools share serial execution and always fetch fresh projections", async () => {
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

test("display hydration reuses a pending search and concurrent card lookups without exposing mutable cache data", async () => {
  const gate = deferred();
  const { executor, calls } = setup(() => gate.promise);
  const search = executor.execute("search_products", { query: "shade" });
  const first = executor.loadProducts([product.id]);
  const second = executor.loadProducts([product.id]);
  gate.resolve({
    products: [product],
    messages: [{ type: "warning", content: "Starting price only." }],
  });
  const modelResult = await search;
  modelResult.products[0].title = "Changed outside the cache";
  const firstCards = await first;
  firstCards.products[0].title = "Changed by one carousel";
  firstCards.messages[0].text = "Changed warning";
  const secondCards = await second;
  assert.equal(secondCards.products[0].title, product.title);
  assert.equal(secondCards.messages[0].text, "Starting price only.");
  assert.equal(calls.length, 1, "two carousels reuse the one real search");
});

test("display hydration fetches only missing IDs and preserves requested order without duplicate or unrelated cards", async () => {
  const other = {
    ...product,
    id: "gid://shopify/Product/456",
    title: "Other shade",
  };
  const unrelated = { ...product, id: "gid://shopify/Product/999" };
  const absent = "gid://shopify/Product/789";
  let count = 0;
  const { executor, calls } = setup(async () => ({
    products: ++count === 1 ? [product] : [unrelated, other, other],
    messages: [{ type: "warning", content: "Starting price only." }],
  }));
  await executor.execute("search_products", { query: "shade" });
  const cards = await executor.loadProducts([
    other.id,
    product.id,
    other.id,
    absent,
  ]);
  assert.deepEqual(plain(calls[1]), [
    "lookup_catalog",
    { ids: [other.id, absent] },
  ]);
  assert.deepEqual(plain(cards.products.map((item) => item.id)), [
    other.id,
    product.id,
  ]);
  assert.deepEqual(plain(cards.messages), [
    { type: "warning", text: "Starting price only." },
  ]);
});

test("cached cards render while unrelated network work is pending and expire without renewal on read", async () => {
  const gate = deferred();
  let count = 0;
  const { executor, calls, clock } = setup(async () => {
    if (++count === 2) return gate.promise;
    return { products: [{ ...product, title: `Shade ${count}` }] };
  });
  await executor.execute("search_products", { query: "shade" });
  clock.now += 59_999;
  const working = executor.execute("search_products", { query: "other" });
  assert.equal(
    (await executor.loadProducts([product.id])).products[0].title,
    "Shade 1",
  );
  assert.equal(
    calls.length,
    2,
    "cached cards do not wait for the unrelated lookup",
  );
  gate.resolve({ products: [] });
  await working;
  clock.now++;
  assert.equal(
    (await executor.loadProducts([product.id])).products[0].title,
    "Shade 3",
  );
  assert.deepEqual(plain(calls[2]), ["lookup_catalog", { ids: [product.id] }]);
});

test("the display cache evicts older products after sixty entries", async () => {
  let page = 0;
  const products = Array.from({ length: 70 }, (_, index) => ({
    ...product,
    id: `gid://shopify/Product/${index + 1}`,
  }));
  const { executor, calls } = setup(async (name) => ({
    products:
      name === "search_products"
        ? products.slice(page++ * 10, page * 10)
        : [products[0]],
  }));
  for (let index = 0; index < 7; index++)
    await executor.execute("search_products", { query: `page ${index}` });
  assert.equal(
    (await executor.loadProducts([products[10].id, products[69].id])).products
      .length,
    2,
  );
  assert.equal(calls.length, 7);
  await executor.loadProducts([products[0].id]);
  assert.equal(calls.length, 8, "the oldest evicted product is fetched again");
});

test("fresh tool failures and missing products never fall back to older display data", async () => {
  let count = 0;
  const { executor, calls } = setup(async () => {
    if (++count === 1) return { products: [product] };
    if (count === 2) throw new Error("Shopify unavailable");
    return { products: [] };
  });
  await executor.execute("search_products", { query: "shade" });
  await assert.rejects(
    executor.execute("get_product", { id: product.id }),
    /Shopify unavailable/,
  );
  assert.deepEqual(plain(await executor.loadProducts([product.id])), {
    products: [],
    messages: [],
  });
  assert.equal(
    calls.length,
    3,
    "a failed targeted refresh evicts older display data",
  );
});

test("display data stays within one storefront runtime and disposal rejects late hydration", async () => {
  const ctx = setup(async () => ({ products: [product] }));
  await ctx.executor.execute("search_products", { query: "shade" });
  ctx.location.origin = "https://another-store.myshopify.com";
  await assert.rejects(
    ctx.executor.loadProducts([product.id]),
    /storefront changed/,
  );
  ctx.location.origin = origin;
  ctx.executor.dispose();
  await assert.rejects(ctx.executor.loadProducts([product.id]), /removed/);

  const gate = deferred();
  const fresh = setup(() => gate.promise);
  const hydration = fresh.executor.loadProducts([product.id]);
  const rejected = assert.rejects(hydration, /removed/);
  await flush();
  fresh.executor.dispose();
  gate.resolve({ products: [product] });
  await rejected;
  assert.equal(
    fresh.calls.length,
    1,
    "a new runtime cannot reuse the old cache",
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
    /wait for the current storefront tools/,
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

test("only validated automatic tools reach the shared browser tool owner without approval", async () => {
  const { executor, calls } = setup(async () => ({ products: [] }));
  assert.throws(() => executor.execute("clear_cart", {}), /confirmation/);
  for (const [name, args] of [
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
    /wait for the current storefront tools/,
  );
  gate.resolve({ products: [product] });
  await Promise.all([rejectedFirst, rejectedSecond]);
  assert.equal(calls.length, 1);
});

test("navigation uses the existing owner and reports its completed current path without catalog parsing", async () => {
  const ctx = setup(async () => {
    ctx.location.href = `${origin}/products/redirected?variant=123#measure`;
    return { status: "navigated", url: ctx.location.href, pending: false };
  });
  const result = await ctx.executor.execute("navigate", {
    path: "/products/shade?variant=123#measure",
  });
  assert.deepEqual(plain(ctx.calls), [
    ["navigate", { path: "/products/shade?variant=123#measure" }],
  ]);
  assert.deepEqual(plain(result), {
    status: "navigated",
    path: "/products/redirected?variant=123#measure",
  });
  assert.deepEqual(ctx.warnings, []);
});

test("unsafe model navigation paths never reach the storefront owner", () => {
  const { executor, calls } = setup(() => assert.fail("Must not navigate"));
  for (const path of [
    "",
    "//other.example/cart",
    "https://other.example/cart",
    "/\\other.example",
    "/cart\n",
    "/" + "x".repeat(2048),
  ])
    assert.throws(
      () => executor.execute("navigate", { path }),
      /current-storefront path/,
    );
  assert.deepEqual(calls, []);
});

test("handoff, cancellation, stale URLs and pending navigation never report successful completion", async () => {
  for (const raw of [
    { status: "handed_off", url: `${origin}/`, pending: false },
    { status: "cancelled", url: `${origin}/`, pending: false },
    { status: "failed", url: `${origin}/`, pending: false },
    { status: "navigated", url: `${origin}/`, pending: true },
    { status: "navigated", url: `${origin}/other`, pending: false },
    { status: "navigated", url: "https://other.example/cart", pending: false },
    { status: "navigated", url: "invalid", pending: false },
  ]) {
    const { executor, calls, warnings } = setup(async () => raw);
    await assert.rejects(
      executor.execute("navigate", { path: "/cart" }),
      /navigation (did not finish|returned an invalid page URL)/,
    );
    assert.equal(calls.length, 1, "navigation is never automatically replayed");
    assert.deepEqual(
      warnings,
      [],
      "navigation failures are not catalog errors",
    );
  }
});

test("ending a queued navigation prevents dispatch after a card lookup releases the executor", async () => {
  const gate = deferred();
  const controller = new AbortController();
  const { executor, calls } = setup(() => gate.promise);
  const lookup = executor.execute("lookup_catalog", { ids: [product.id] });
  const navigation = executor.execute(
    "navigate",
    { path: "/cart" },
    controller.signal,
  );
  const rejected = assert.rejects(navigation, { name: "AbortError" });
  await flush();
  assert.equal(calls.length, 1);
  controller.abort();
  gate.resolve({ products: [] });
  await Promise.all([lookup, rejected]);
  assert.equal(calls.length, 1);
});

test("a completed navigation cannot publish a result after its session is cancelled", async () => {
  const gate = deferred();
  const controller = new AbortController();
  const { executor, calls } = setup((_name, _args, signal) => {
    assert.equal(signal.aborted, false);
    controller.signal.addEventListener("abort", () =>
      assert.equal(signal.aborted, true),
    );
    return gate.promise;
  });
  const navigation = executor.execute(
    "navigate",
    { path: "/" },
    controller.signal,
  );
  const rejected = assert.rejects(navigation, { name: "AbortError" });
  await flush();
  controller.abort();
  gate.resolve({ status: "navigated", url: `${origin}/`, pending: false });
  await rejected;
  assert.equal(calls.length, 1);
});

test("twenty historical carousels cannot reject or delay a foreground tool behind display reads", async () => {
  let running = 0;
  let maximum = 0;
  let firstSignal;
  const { executor, calls } = setup(async (name, _args, signal) => {
    running++;
    maximum = Math.max(maximum, running);
    try {
      if (name === "lookup_catalog" && !firstSignal) {
        firstSignal = signal;
        await new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      }
      return { products: [product] };
    } finally {
      running--;
    }
  });
  const cards = Array.from({ length: 20 }, () =>
    executor.loadProducts([product.id]),
  );
  await flush();
  const foreground = executor.execute("search_products", { query: "shade" });
  assert.equal(firstSignal.aborted, true);
  assert.equal((await foreground).products[0].id, product.id);
  const results = await Promise.all(cards);
  assert.equal(results.length, 20);
  assert.ok(results.every((value) => value.products[0].id === product.id));
  assert.deepEqual(
    calls.map(([name]) => name),
    ["lookup_catalog", "search_products"],
  );
  assert.equal(
    maximum,
    1,
    "The cancelled physical request settles before foreground dispatch",
  );
});

test("obsolete active and queued card requests cancel without blocking later work", async () => {
  let first = true;
  const { executor, calls } = setup(async (_name, _args, signal) => {
    if (first) {
      first = false;
      await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    }
    return { products: [product] };
  });
  const active = new AbortController();
  const queued = new AbortController();
  const firstResult = executor.loadProducts([product.id], active.signal);
  const secondResult = executor.loadProducts([product.id], queued.signal);
  const rejected = [
    assert.rejects(firstResult, { name: "AbortError" }),
    assert.rejects(secondResult, { name: "AbortError" }),
  ];
  await flush();
  queued.abort();
  active.abort();
  await Promise.all(rejected);
  await executor.execute("search_products", { query: "shade" });
  assert.equal(calls.length, 2);
});

test("model navigation carries its restricted source through the storefront owner", async () => {
  const { executor } = setup(async (name, _args, _signal, options) => {
    assert.equal(name, "navigate");
    assert.deepEqual(plain(options), { navigationSource: "model" });
    return { status: "navigated", url: `${origin}/`, pending: false };
  });
  assert.equal(
    (await executor.execute("navigate", { path: "/" })).status,
    "navigated",
  );
});
