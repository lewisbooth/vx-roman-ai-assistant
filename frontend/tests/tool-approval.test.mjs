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

test("cart reads project public data but mutation execution requires one locally owned review", async (t) => {
  const ctx = setup(t, async (name) =>
    name === "get_cart"
      ? cart
      : {
          status: "updated",
          message: "Removed.",
          cart: { ...cart, itemCount: 0, items: [], totalPriceMinorUnits: 0 },
        },
  );
  const command = tool("remove_from_cart", { lineKey: "123:abc" });
  assert.throws(
    () => ctx.executor.execute(command.name, command.arguments),
    /confirmation/,
  );
  const approval = await ctx.executor.prepareApproval(command);
  assert.deepEqual(
    ctx.calls.map((call) => call[0]),
    ["get_cart"],
  );
  assert.match(approval.details.join(" "), /Kitchen blind.*all 2/);
  await assert.rejects(
    ctx.executor.executeApproved(command, { ...approval }),
    /fresh review/,
  );
  const result = await ctx.executor.executeApproved(command, approval);
  assert.equal(result.status, "updated");
  assert.deepEqual(
    ctx.calls.map((call) => call[0]),
    ["get_cart", "get_cart", "remove_from_cart"],
  );
  await assert.rejects(
    ctx.executor.executeApproved(command, approval),
    /fresh review/,
  );
});

test("cart changes while confirmation waits cause no mutation", async (t) => {
  let current = cart;
  const ctx = setup(t, async (name) => {
    assert.equal(name, "get_cart");
    return current;
  });
  const command = tool("set_cart_quantity", {
    lineKey: "123:abc",
    quantity: 4,
  });
  const approval = await ctx.executor.prepareApproval(command);
  current = {
    ...cart,
    itemCount: 3,
    items: [{ ...cart.items[0], quantity: 3 }],
  };
  await assert.rejects(
    ctx.executor.executeApproved(command, approval),
    /changed after review/,
  );
  assert.deepEqual(
    ctx.calls.map((call) => call[0]),
    ["get_cart", "get_cart"],
  );
});

test("missing cart lines and empty carts are unavailable to approve", async (t) => {
  const ctx = setup(t, async () => ({
    ...cart,
    itemCount: 0,
    totalPriceMinorUnits: 0,
    items: [],
  }));
  await assert.rejects(
    ctx.executor.prepareApproval(
      tool("remove_from_cart", { lineKey: "123:abc" }),
    ),
    /no longer/,
  );
  await assert.rejects(
    ctx.executor.prepareApproval(tool("clear_cart")),
    /already empty/,
  );
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
  await assert.rejects(
    ctx.executor.prepareApproval(command),
    /does not need approval/,
  );
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
  const searching = ctx.executor.execute("search_products", { query: "shade" });
  const adding = ctx.executor.execute(command.name, command.arguments);
  await setImmediate();
  ctx.window.history.pushState({}, "", "/products/different");
  release({ products: [] });
  await searching;
  await assert.rejects(adding, /requested product/);
  assert.equal(ctx.calls.filter((call) => call[0] === "add_to_cart").length, 1);
});

test("cancelled queued approval never reaches the theme mutation", async (t) => {
  let release;
  const ctx = setup(t, async (name) =>
    name === "get_cart"
      ? cart
      : new Promise((resolve) => {
          release = resolve;
        }),
  );
  const command = tool("clear_cart");
  const approval = await ctx.executor.prepareApproval(command);
  const searching = ctx.executor.execute("search_products", { query: "shade" });
  const controller = new ctx.window.AbortController();
  const action = ctx.executor.executeApproved(
    command,
    approval,
    controller.signal,
  );
  const rejected = assert.rejects(action, /abort/i);
  await setImmediate();
  controller.abort();
  await rejected;
  release({ products: [] });
  await searching;
  assert.equal(
    ctx.calls.some((call) => call[0] === "clear_cart"),
    false,
  );
});
