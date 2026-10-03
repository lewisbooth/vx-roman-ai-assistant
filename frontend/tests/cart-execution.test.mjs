import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  entryPoints: ["frontend/src/session/storefront-executor.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanExecutor",
  platform: "browser",
});
const cart = {
  currency: "GBP",
  itemCount: 2,
  totalPriceMinorUnits: 6000,
  items: [
    {
      lineKey: "123:abc",
      title: "Kitchen blind",
      variantId: 123,
      quantity: 2,
      linePriceMinorUnits: 6000,
    },
  ],
};
const tool = (name, args = {}) => ({
  id: "one",
  name,
  arguments: args,
  status: "pending",
});
function setup(t, execute, path = "/cart") {
  const dom = new JSDOM(
    '<body class="template-product"><app-provider><main id="main"><h1>Kitchen shade</h1><dynamic-pricing><form data-dynamic-pricing-form><input name="width" type="number" value="300"><input name="color" value="blue"></form></dynamic-pricing></main></app-provider></body>',
    {
      url: `https://hd-dev-single.myshopify.com${path}`,
      runScripts: "outside-only",
    },
  );
  dom.window.TextEncoder = TextEncoder;
  dom.window.eval(
    `${bundle.outputFiles[0].text};window.RomanExecutor = RomanExecutor;`,
  );
  const calls = [];
  const executor = dom.window.RomanExecutor.createStorefrontExecutor({
    execute: async (...args) => {
      calls.push(args);
      return execute(...args);
    },
  });
  t.after(() => {
    executor.dispose();
    dom.window.close();
  });
  return { executor, calls, window: dom.window };
}

for (const [name, args] of [
  ["set_cart_quantity", { lineKey: "123:abc", quantity: 4 }],
  ["clear_cart", {}],
])
  test(`requested ${name} executes directly under the shared queue`, async (t) => {
    const result = {
      status: "updated",
      message: "Updated.",
      cart:
        name === "clear_cart"
          ? { ...cart, itemCount: 0, items: [], totalPriceMinorUnits: 0 }
          : {
              ...cart,
              itemCount: 4,
              items: [{ ...cart.items[0], quantity: 4 }],
            },
    };
    const ctx = setup(t, async () => result);
    const outcome = await ctx.executor.execute(name, args);
    assert.equal(outcome.status, "updated");
    assert.equal(ctx.calls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls[0].slice(0, 2))), [
      name,
      args,
    ]);
  });

test("invalid quantity and clear arguments are rejected before queue execution", async (t) => {
  const ctx = setup(t, () =>
    assert.fail("Invalid input must not reach the theme"),
  );
  for (const [name, args] of [
    ["set_cart_quantity", { lineKey: "123:abc", quantity: 0 }],
    ["set_cart_quantity", { lineKey: "123:abc", quantity: 1.5 }],
    ["clear_cart", { extra: true }],
  ])
    assert.throws(() => ctx.executor.execute(name, args));
  assert.equal(ctx.calls.length, 0);
});

test("requested removal delegates one complete batch without another review", async (t) => {
  const result = {
    status: "updated",
    message: "Removed.",
    cart: { ...cart, itemCount: 0, items: [], totalPriceMinorUnits: 0 },
  };
  const ctx = setup(t, async () => result);
  const command = tool("remove_from_cart", {
    lineKeys: ["123:abc", "456:def"],
  });
  const outcome = await ctx.executor.execute(command.name, command.arguments);
  assert.equal(outcome.status, "updated");
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls[0].slice(0, 2))), [
    command.name,
    command.arguments,
  ]);
  assert.equal(ctx.calls.length, 1);
});

test("add executes the current product directly without another approval", async (t) => {
  const ctx = setup(
    t,
    async () => ({
      status: "added",
      message: "Added.",
      quantityAdded: 1,
      addedProduct: { productPath: "/products/shade", title: "Kitchen shade" },
    }),
    "/products/shade",
  );
  const command = tool("add_to_cart", { productPath: "/products/shade" });
  const result = await ctx.executor.execute(command.name, command.arguments);
  assert.equal(result.status, "added");
  assert.equal(result.addedProduct.title, "Kitchen shade");
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls[0].slice(0, 2))), [
    "add_to_cart",
    {},
  ]);
  assert.equal(ctx.calls.length, 1);
});

test("direct adds still require the matching product and supported current form", async (t) => {
  for (const change of ["path", "editing", "form", "template"]) {
    await t.test(change, async (t) => {
      const ctx = setup(
        t,
        () => assert.fail("Invalid product must not add"),
        "/products/shade",
      );
      if (change === "path")
        ctx.window.history.pushState({}, "", "/products/other");
      if (change === "editing")
        ctx.window.history.pushState({}, "", "/products/shade?line=2");
      if (change === "form") ctx.window.document.querySelector("form").remove();
      if (change === "template")
        ctx.window.document.body.classList.remove("template-product");
      await assert.rejects(
        ctx.executor.execute("add_to_cart", { productPath: "/products/shade" }),
      );
      assert.equal(ctx.calls.length, 0);
    });
  }
});

test("add checks again after foreground queue wait and never leaks model productPath into theme action", async (t) => {
  let release;
  const ctx = setup(
    t,
    async (name) =>
      name === "search_products"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : { status: "added", message: "Added.", quantityAdded: 1 },
    "/products/shade",
  );
  const command = tool("add_to_cart", { productPath: "/products/shade" });
  const result = await ctx.executor.execute(command.name, command.arguments);
  assert.equal(result.status, "added");
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls[0].slice(0, 2))), [
    "add_to_cart",
    {},
  ]);
  const searching = ctx.executor.execute("search_products", {
    queries: ["shade"],
  });
  const adding = ctx.executor.execute(command.name, command.arguments);
  await setImmediate();
  ctx.window.history.pushState({}, "", "/products/different");
  release({
    products: [],
    messages: [],
    queries: [{ query: "shade", status: "succeeded", productIds: [] }],
  });
  await searching;
  await assert.rejects(adding, /requested product/);
  assert.equal(ctx.calls.filter((call) => call[0] === "add_to_cart").length, 1);
});

test("cancelled queued cart mutation never reaches the theme", async (t) => {
  let release;
  const ctx = setup(t, async (name) =>
    name === "get_cart"
      ? cart
      : new Promise((resolve) => {
          release = resolve;
        }),
  );
  const command = tool("clear_cart");
  const searching = ctx.executor.execute("search_products", {
    queries: ["shade"],
  });
  const controller = new ctx.window.AbortController();
  const action = ctx.executor.execute(
    command.name,
    command.arguments,
    controller.signal,
  );
  const rejected = assert.rejects(action, /abort/i);
  await setImmediate();
  controller.abort();
  await rejected;
  release({
    products: [],
    messages: [],
    queries: [{ query: "shade", status: "succeeded", productIds: [] }],
  });
  await searching;
  assert.equal(
    ctx.calls.some((call) => call[0] === "clear_cart"),
    false,
  );
});
