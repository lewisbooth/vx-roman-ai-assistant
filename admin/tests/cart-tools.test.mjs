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
  parseCartAddedProduct,
  parseCartAddedSample,
  isCartMutation,
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
      !["get_cart", "add_to_cart", "add_sample_to_cart"].includes(
        definition.name,
      ),
    );
    assert.equal(
      isCartMutation(definition.name),
      definition.name !== "get_cart",
    );
  }
  for (const [name, input] of [
    ["get_cart", {}],
    ["clear_cart", {}],
    ["add_to_cart", { productPath: "/en-gb/products/shade/" }],
    ["add_sample_to_cart", { productPath: "/en-gb/products/shade/" }],
    ["remove_from_cart", { lineKey: "123:abc" }],
    ["set_cart_quantity", { lineKey: "123:abc", quantity: 2 }],
  ]) {
    assert.equal(parseCartCall(name, input).name, name);
    assert.throws(() => parseCartCall(name, { ...input, confirmed: true }));
  }
  for (const path of [
    "/products/x?variant=123",
    "/products/x?variant=not-a-number",
    "/products/x?colour=black",
    "/products/x#sample",
    "/collections/all",
  ])
    assert.throws(
      () => parseCartCall("add_sample_to_cart", { productPath: path }),
      path,
    );
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

test("confirmed additions carry only actual bounded public product facts", () => {
  const product = {
    productPath: "/en-gb/products/shade",
    title: "Configured shade",
    measurements: { width: 34.125, height: 56.5, unit: "in" },
  };
  const result = { status: "added", message: "Added.", addedProduct: product };
  assert.deepEqual(parseCartResult("add_to_cart", result), result);
  assert.notEqual(
    parseCartAddedProduct(product).measurements,
    product.measurements,
  );
  assert.deepEqual(
    parseCartAddedProduct({ productPath: "/products/shade/", title: "Shade" }),
    {
      productPath: "/products/shade",
      title: "Shade",
    },
  );
  assert.deepEqual(
    parseCartResult("add_to_cart", {
      status: "added",
      message: "Historic addition.",
    }),
    {
      status: "added",
      message: "Historic addition.",
    },
  );
  for (const value of [
    { ...product, token: "PRIVATE_CART_TOKEN" },
    { ...product, title: " " },
    { ...product, title: "x".repeat(301) },
    { ...product, title: "Private\ncontrol" },
    { ...product, productPath: "https://other.example/products/shade" },
    { ...product, productPath: "/cart/123:1" },
    { ...product, productPath: "/products/shade?variant=123" },
    { ...product, measurements: { ...product.measurements, note: "Private" } },
    { ...product, measurements: { ...product.measurements, width: 0 } },
    { ...product, measurements: { ...product.measurements, height: Infinity } },
    { ...product, measurements: { ...product.measurements, width: "34" } },
    { ...product, measurements: { ...product.measurements, unit: "feet" } },
  ])
    assert.throws(() => parseCartAddedProduct(value));
  for (const status of [
    "handed_off",
    "uncertain",
    "cancelled",
    "needs_configuration",
  ])
    assert.throws(() => parseCartResult("add_to_cart", { ...result, status }));
  assert.throws(() =>
    parseCartResult("clear_cart", {
      status: "updated",
      message: "Updated.",
      cart,
      addedProduct: product,
    }),
  );
});

test("confirmed sample additions remain distinct from full product additions", () => {
  const sample = {
    productPath: "/en-gb/products/shade",
    title: "BiFold Matte Black Venetian - 16mm Slat",
  };
  const result = {
    status: "added",
    message: "The theme confirmed the sample addition.",
    addedSample: sample,
  };
  assert.deepEqual(parseCartResult("add_sample_to_cart", result), result);
  assert.notEqual(parseCartAddedSample(sample), sample);
  assert.deepEqual(
    parseCartResult("add_sample_to_cart", {
      status: "unsupported",
      message: "Samples are not available for this product.",
    }),
    {
      status: "unsupported",
      message: "Samples are not available for this product.",
    },
  );
  assert.deepEqual(
    parseCartResult("add_sample_to_cart", {
      status: "already_in_cart",
      message: "That sample is already in your cart.",
    }),
    {
      status: "already_in_cart",
      message: "That sample is already in your cart.",
    },
  );
  for (const value of [
    { status: "added", message: "Missing sample." },
    { ...result, quantityAdded: 1 },
    {
      ...result,
      addedProduct: { productPath: "/products/shade", title: "Blind" },
    },
    {
      ...result,
      addedSample: { ...sample, productPath: "/products/shade?variant=no" },
    },
    { ...result, addedSample: { ...sample, title: " " } },
  ])
    assert.throws(() => parseCartResult("add_sample_to_cart", value));
  assert.throws(() =>
    parseCartResult("add_to_cart", {
      status: "unsupported",
      message: "Not a full-product outcome.",
    }),
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

test("cart discount metadata preserves reported rounding and allocation scopes without repricing", () => {
  const discounted = {
    ...cart,
    originalTotalPriceMinorUnits: 69195,
    totalPriceMinorUnits: 34598,
    totalDiscountMinorUnits: 34597,
    cartDiscounts: [],
    items: [
      {
        ...cart.items[0],
        originalLinePriceMinorUnits: 69195,
        linePriceMinorUnits: 34598,
        lineDiscounts: [
          { title: "50 off test", amountMinorUnits: 34597, percentage: 50 },
        ],
      },
    ],
  };
  const parsed = parseCartResult("get_cart", discounted);
  assert.deepEqual(parsed, discounted);
  assert.notEqual(
    parsed.items[0].lineDiscounts[0],
    discounted.items[0].lineDiscounts[0],
  );
  assert.deepEqual(
    parseCartResult("set_cart_quantity", {
      status: "updated",
      message: "Updated.",
      cart: discounted,
    }).cart,
    discounted,
  );

  const combined = {
    ...cart,
    originalTotalPriceMinorUnits: 12345,
    totalPriceMinorUnits: 11145,
    totalDiscountMinorUnits: 1200,
    cartDiscounts: [{ title: "Cart offer", amountMinorUnits: 200 }],
    items: [
      {
        ...cart.items[0],
        originalLinePriceMinorUnits: 12345,
        linePriceMinorUnits: 11345,
        lineDiscounts: [{ title: "Product offer", amountMinorUnits: 1000 }],
      },
    ],
  };
  assert.deepEqual(parseCartResult("get_cart", combined), combined);
});

test("cart metadata distinguishes missing details from explicitly no discount", () => {
  const unknown = parseCartResult("get_cart", cart);
  assert.equal(Object.hasOwn(unknown, "totalDiscountMinorUnits"), false);
  assert.equal(Object.hasOwn(unknown, "cartDiscounts"), false);
  assert.equal(Object.hasOwn(unknown.items[0], "lineDiscounts"), false);
  const none = {
    ...cart,
    originalTotalPriceMinorUnits: 12345,
    totalDiscountMinorUnits: 0,
    cartDiscounts: [],
    items: [
      {
        ...cart.items[0],
        originalLinePriceMinorUnits: 12345,
        lineDiscounts: [],
      },
    ],
  };
  assert.deepEqual(parseCartResult("get_cart", none), none);
});

test("cart discount boundary rejects malformed, excessive, private and contradictory metadata", () => {
  const discount = { title: "Offer", amountMinorUnits: 200, percentage: 10 };
  const valid = {
    ...cart,
    originalTotalPriceMinorUnits: 12545,
    totalDiscountMinorUnits: 200,
    cartDiscounts: [discount],
  };
  assert.deepEqual(parseCartResult("get_cart", valid), valid);
  for (const malformed of [
    { ...discount, title: "" },
    { ...discount, title: "x".repeat(301) },
    { ...discount, title: "Offer\nPRIVATE" },
    { ...discount, amountMinorUnits: -1 },
    { ...discount, amountMinorUnits: 0.5 },
    { ...discount, amountMinorUnits: Number.MAX_SAFE_INTEGER + 1 },
    { ...discount, percentage: "10" },
    { ...discount, percentage: null },
    { ...discount, percentage: -1 },
    { ...discount, percentage: 101 },
    { ...discount, percentage: Infinity },
    { ...discount, customerId: "PRIVATE" },
  ])
    assert.throws(() =>
      parseCartResult("get_cart", { ...valid, cartDiscounts: [malformed] }),
    );
  for (const malformed of [
    { ...valid, originalTotalPriceMinorUnits: null },
    { ...valid, originalTotalPriceMinorUnits: 12344 },
    { ...valid, originalTotalPriceMinorUnits: 12544 },
    { ...valid, totalDiscountMinorUnits: 199 },
    { ...valid, cartDiscounts: null },
    { ...valid, cartDiscounts: Array(51).fill(discount) },
    { ...valid, cartDiscounts: [{ ...discount, amountMinorUnits: 201 }] },
    {
      ...cart,
      items: [{ ...cart.items[0], originalLinePriceMinorUnits: 12344 }],
    },
    {
      ...cart,
      items: [
        {
          ...cart.items[0],
          originalLinePriceMinorUnits: 12445,
          lineDiscounts: [discount],
        },
      ],
    },
  ])
    assert.throws(() => parseCartResult("get_cart", malformed));
});
