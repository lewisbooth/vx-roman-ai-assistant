import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["shared/cart-tools.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(
  module,
  module.exports,
);
const {
  cartToolDefinitions,
  parseCartCall,
  parseCartResult,
  requiresCartConfirmation,
} = module.exports;
const cart = {
  currency: "GBP",
  itemCount: 1,
  totalPriceMinorUnits: 12345,
  items: [
    {
      lineKey: "123:abc",
      title: "Configured shade",
      variantId: 123,
      quantity: 1,
      linePriceMinorUnits: 12345,
    },
  ],
};

test("cart schemas have exact operation arguments and never accept model-supplied confirmation", () => {
  for (const definition of cartToolDefinitions) {
    assert.equal(definition.strict, true);
    assert.equal(definition.parameters.additionalProperties, false);
    assert.ok(!("confirmed" in definition.parameters.properties));
    assert.equal(
      requiresCartConfirmation(definition.name),
      definition.name !== "get_cart",
    );
  }
  for (const [name, input] of [
    ["get_cart", {}],
    ["clear_cart", {}],
    ["add_to_cart", { productPath: "/en-gb/products/shade/" }],
    ["remove_from_cart", { lineKey: "123:abc" }],
    ["set_cart_quantity", { lineKey: "123:abc", quantity: 2 }],
  ]) {
    assert.equal(parseCartCall(name, input).name, name);
    assert.throws(() => parseCartCall(name, { ...input, confirmed: true }));
  }
  for (const path of [
    "//other.example/products/x",
    "/cart/123:1",
    "/products/x?variant=123",
    "/products/x#width",
    "/products/%2f..%2fcart",
    "/account",
  ]) {
    assert.throws(
      () => parseCartCall("add_to_cart", { productPath: path }),
      path,
    );
  }
  for (const quantity of [0, -1, 1.5, "2", true, 1000, NaN])
    assert.throws(() =>
      parseCartCall("set_cart_quantity", { lineKey: "123:abc", quantity }),
    );
});

test("cart results contain only bounded public fields and preserve uncertainty", () => {
  assert.deepEqual(parseCartResult("get_cart", cart), cart);
  assert.notEqual(parseCartResult("get_cart", cart).items, cart.items);
  for (const value of [
    { ...cart, token: "PRIVATE_CART_TOKEN" },
    { ...cart, attributes: {} },
    { ...cart, currency: "invalid" },
    { ...cart, itemCount: 2 },
    { ...cart, totalPriceMinorUnits: -1 },
    { ...cart, items: [cart.items[0], cart.items[0]], itemCount: 2 },
    { ...cart, items: [{ ...cart.items[0], note: "PRIVATE_NOTE" }] },
  ])
    assert.throws(() => parseCartResult("get_cart", value));
  assert.deepEqual(
    parseCartResult("add_to_cart", {
      status: "handed_off",
      message: "Check the cart.",
    }),
    { status: "handed_off", message: "Check the cart." },
  );
  assert.equal(
    parseCartResult("clear_cart", {
      status: "uncertain",
      message: "The result was lost.",
    }).status,
    "uncertain",
  );
  assert.equal(
    parseCartResult("remove_from_cart", {
      status: "updated",
      message: "Confirmed.",
      cart,
    }).cart.itemCount,
    1,
  );
  assert.throws(() =>
    parseCartResult("get_cart", { status: "added", message: "Done" }),
  );
  assert.throws(() =>
    parseCartResult("clear_cart", { status: "added", message: "Done" }),
  );
  assert.throws(() =>
    parseCartResult("clear_cart", { status: "updated", message: "Done" }),
  );
  assert.throws(() =>
    parseCartResult("add_to_cart", {
      status: "added",
      message: "Done",
      quantityAdded: 0,
    }),
  );
});
