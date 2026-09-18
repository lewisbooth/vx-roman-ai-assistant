import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["frontend/src/tools/cart.ts"],
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
const { summarizeCart, validateStoreCart } = module.exports;

const cart = {
  currency: "GBP",
  item_count: 1,
  total_price: 34598,
  original_total_price: 69195,
  total_discount: 34597,
  cart_level_discount_applications: [],
  token: "PRIVATE_TOKEN",
  note: "PRIVATE_NOTE",
  attributes: { email: "PRIVATE_EMAIL" },
  items: [
    {
      key: "123:shutter",
      title: "Configured shutter",
      quantity: 1,
      variant_id: 123,
      original_line_price: 69195,
      final_line_price: 34598,
      line_level_discount_allocations: [
        {
          amount: 34597,
          discount_application: {
            title: "50 off test",
            value_type: "percentage",
            value: "50.0",
            total_allocated_amount: 34597,
            customer: "PRIVATE_CUSTOMER",
          },
        },
      ],
      properties: { room: "PRIVATE_ROOM" },
    },
  ],
};

test("Ajax shutter discount retains exact half-penny rounding and public named saving", () => {
  assert.deepEqual(summarizeCart(validateStoreCart(cart)), {
    currency: "GBP",
    itemCount: 1,
    totalPriceMinorUnits: 34598,
    originalTotalPriceMinorUnits: 69195,
    totalDiscountMinorUnits: 34597,
    cartDiscounts: [],
    items: [
      {
        lineKey: "123:shutter",
        title: "Configured shutter",
        variantId: 123,
        quantity: 1,
        linePriceMinorUnits: 34598,
        originalLinePriceMinorUnits: 69195,
        lineDiscounts: [
          { title: "50 off test", amountMinorUnits: 34597, percentage: 50 },
        ],
      },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(summarizeCart(cart)),
    /PRIVATE|token|customer|properties|attributes/,
  );
});

test("line allocations retain each line amount rather than the application's whole-cart amount", () => {
  const line = cart.items[0];
  const sharedApplication = {
    title: "Shared promotion",
    value_type: "percentage",
    value: 10,
    total_allocated_amount: 300,
  };
  const raw = {
    ...cart,
    item_count: 3,
    original_total_price: 3000,
    total_price: 2700,
    total_discount: 300,
    items: [
      {
        ...line,
        key: "123:first",
        quantity: 2,
        original_line_price: 2000,
        final_line_price: 1800,
        line_level_discount_allocations: [
          { amount: 200, discount_application: sharedApplication },
        ],
      },
      {
        ...line,
        key: "123:second",
        quantity: 1,
        original_line_price: 1000,
        final_line_price: 900,
        line_level_discount_allocations: [
          { amount: 100, discount_application: sharedApplication },
        ],
      },
    ],
  };
  const result = summarizeCart(raw);
  assert.deepEqual(
    result.items.map((item) => item.lineDiscounts[0].amountMinorUnits),
    [200, 100],
  );
  assert.deepEqual(
    result.items.map((item) => item.linePriceMinorUnits),
    [1800, 900],
  );
  assert.equal(result.totalDiscountMinorUnits, 300);
});

test("combined line and cart discounts use distinct allocations and never repeat legacy totals", () => {
  const raw = {
    ...cart,
    original_total_price: 2499,
    total_price: 2025,
    total_discount: 474,
    cart_level_discount_applications: [
      {
        title: "Cart offer",
        value_type: "percentage",
        value: "10.0",
        total_allocated_amount: 224,
      },
    ],
    items: [
      {
        ...cart.items[0],
        original_line_price: 2499,
        final_line_price: 2249,
        line_price: 2025,
        total_discount: 474,
        discounts: [
          { title: "Line offer", amount: 250 },
          { title: "Cart offer", amount: 224 },
        ],
        line_level_discount_allocations: [
          {
            amount: 250,
            discount_application: {
              title: "Line offer",
              value_type: "fixed_amount",
              value: "2.5",
              total_allocated_amount: 250,
            },
          },
        ],
      },
    ],
  };
  const result = summarizeCart(raw);
  assert.equal(result.totalPriceMinorUnits, 2025);
  assert.equal(result.totalDiscountMinorUnits, 474);
  assert.equal(result.items[0].linePriceMinorUnits, 2249);
  assert.deepEqual(result.cartDiscounts, [
    { title: "Cart offer", amountMinorUnits: 224, percentage: 10 },
  ]);
  assert.deepEqual(result.items[0].lineDiscounts, [
    { title: "Line offer", amountMinorUnits: 250 },
  ]);
});

test("missing metadata remains unknown while explicit zeros and empty allocations survive", () => {
  const raw = { currency: "GBP", item_count: 0, total_price: 0, items: [] };
  const unknown = summarizeCart(raw);
  assert.equal(Object.hasOwn(unknown, "totalDiscountMinorUnits"), false);
  assert.equal(Object.hasOwn(unknown, "cartDiscounts"), false);
  const none = summarizeCart({
    ...raw,
    original_total_price: 0,
    total_discount: 0,
    cart_level_discount_applications: [],
  });
  assert.equal(none.totalDiscountMinorUnits, 0);
  assert.deepEqual(none.cartDiscounts, []);
  const withoutPercentage = structuredClone(cart);
  delete withoutPercentage.items[0].line_level_discount_allocations[0]
    .discount_application.value_type;
  assert.equal(
    Object.hasOwn(
      summarizeCart(withoutPercentage).items[0].lineDiscounts[0],
      "percentage",
    ),
    false,
  );
});

test("malformed raw monetary metadata fails without exposing source contents or claiming no savings", () => {
  for (const metadata of [
    null,
    {},
    [null],
    [{ amount: 20 }],
    Array(51).fill({}),
  ]) {
    assert.throws(() =>
      summarizeCart({ ...cart, cart_level_discount_applications: metadata }),
    );
    assert.throws(() =>
      summarizeCart({
        ...cart,
        items: [
          { ...cart.items[0], line_level_discount_allocations: metadata },
        ],
      }),
    );
  }
  for (const value of [
    null,
    "",
    "PRIVATE_SECRET",
    "0x32",
    "5e1",
    -1,
    101,
    Infinity,
  ]) {
    const raw = structuredClone(cart);
    raw.items[0].line_level_discount_allocations[0].discount_application.value =
      value;
    assert.throws(
      () => summarizeCart(raw),
      (error) => {
        assert.doesNotMatch(error.message, /PRIVATE_SECRET/);
        return true;
      },
    );
  }
  for (const value of [
    -1,
    0.5,
    "69195",
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() =>
      summarizeCart({ ...cart, original_total_price: value }),
    );
    assert.throws(() => summarizeCart({ ...cart, total_discount: value }));
  }
});
