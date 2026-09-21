import assert from "node:assert/strict";
import { cwd } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { useSyncExternalStore } from 'react';
      import { CartStage } from './frontend/src/chat/CartStage';
      import { useCart } from './frontend/src/chat/useCart';
      function Cart({navigation, session}) {
        const page = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot);
        const cart = useCart(navigation, session);
        return page.cartVisible ? <CartStage {...cart} /> : null;
      }
      export function mount(container, navigation, session) {
        const root = createRoot(container);
        flushSync(() => root.render(<Cart navigation={navigation} session={session} />));
        return () => flushSync(() => root.unmount());
      }
    `,
    resolveDir: cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "CartStageTest",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

const exampleCart = {
  currency: "GBP",
  item_count: 1,
  total_price: 4500,
  token: "private cart token",
  note: "Private note",
  items: [
    {
      key: "line-1",
      title: "Linen blind",
      quantity: 1,
      variant_id: 12345,
      final_line_price: 4500,
    },
  ],
};

async function until(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(message);
}

function setup(t, view = "chat", open = true) {
  const dom = new JSDOM(
    "<!doctype html><roman-ai-assistant></roman-ai-assistant>",
    {
      url: "https://shop.example/products/linen",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom,
    errors = [],
    calls = [];
  if (open) window.document.documentElement.setAttribute("data-roman-open", "");
  window.console.error = (...args) => errors.push(args);
  window.fetch = (url, options) =>
    new Promise((resolve, reject) =>
      calls.push({
        url: String(url),
        options,
        resolve,
        reject,
        complete(cart = exampleCart) {
          resolve({
            ok: true,
            status: 200,
            json: async () => cart,
            headers: new Map(),
          });
        },
      }),
    );
  const navigationListeners = new Set(),
    sessionListeners = new Set();
  let page = {
    url: window.location.href,
    pending: false,
    error: null,
    cartVisible: view === "cart",
  };
  let state = { conversation: { messages: [], tools: [] } };
  const navigation = {
    getSnapshot: () => page,
    subscribe: (fn) => {
      navigationListeners.add(fn);
      return () => navigationListeners.delete(fn);
    },
  };
  const session = {
    getSnapshot: () => state,
    subscribe: (fn) => {
      sessionListeners.add(fn);
      return () => sessionListeners.delete(fn);
    },
  };
  window.eval(
    `${bundle.outputFiles[0].text};window.CartStageTest=CartStageTest;`,
  );
  const container = window.document
    .querySelector("roman-ai-assistant")
    .attachShadow({ mode: "open" });
  const unmount = window.CartStageTest.mount(container, navigation, session);
  let disposed = false;
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      unmount();
    }
  };
  t.after(() => {
    dispose();
    window.close();
    assert.deepEqual(errors, []);
  });
  return {
    window,
    container,
    calls,
    dispose,
    navigationListeners,
    sessionListeners,
    open(value) {
      window.document.documentElement.toggleAttribute("data-roman-open", value);
    },
    show(view) {
      page = { ...page, cartVisible: view === "cart" };
      navigationListeners.forEach((fn) => fn());
    },
    update(conversation) {
      state = {
        ...state,
        conversation: { ...state.conversation, ...conversation },
      };
      sessionListeners.forEach((fn) => fn());
    },
  };
}

test("cart display and navigation share one initial read; additions never open the cart view", async (t) => {
  const ctx = setup(t);
  ctx.update({
    messages: [
      { id: "added", parts: [{ type: "cart_addition", title: "Linen blind" }] },
    ],
  });
  await until(
    () => ctx.calls.length === 1,
    "Opening Roman reads its cart once",
  );
  assert.equal(ctx.container.textContent, "");
  ctx.show("cart");
  await until(() => ctx.calls.length === 1, "Requested cart should read once");
  assert.equal(ctx.calls[0].url, "https://shop.example/cart.js");
  assert.equal(ctx.calls[0].options.credentials, "same-origin");
  ctx.calls[0].complete();
  await until(
    () => ctx.container.textContent.includes("Linen blind"),
    "Validated cart should render",
  );
  assert.match(ctx.container.textContent, /45\.00/);
  assert.doesNotMatch(ctx.container.textContent, /private|Private/);
  assert.equal(
    ctx.container
      .querySelector("a")
      .getAttribute("data-roman-native-navigation"),
    "true",
  );
});

test("streaming prose does not repeatedly reload an unchanged cart", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Initial cart read");
  ctx.calls[0].complete();
  await until(
    () => ctx.container.textContent.includes("Linen blind"),
    "Initial cart rendered",
  );
  for (const text of ["Hello", "Hello again", "Hello again, how can I help?"]) {
    ctx.update({
      messages: [
        { id: "reply", status: "pending", parts: [{ type: "text", text }] },
      ],
    });
    await delay(10);
  }
  assert.equal(
    ctx.calls.length,
    1,
    "Only actual cart activity should trigger another display read",
  );
});

test("cart rows show their own image, title, quantity and line price from one cart read", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Initial cart read");
  const cart = {
    ...exampleCart,
    item_count: 3,
    total_price: 9700,
    items: [
      {
        ...exampleCart.items[0],
        quantity: 2,
        final_line_price: 9000,
        featured_image: { url: "//cdn.shopify.com/s/files/1/2/linen.jpg?v=2" },
        image: "https://cdn.shopify.com/s/files/1/2/other.jpg",
      },
      {
        ...exampleCart.items[0],
        key: "line-2",
        title: "Matching sample",
        final_line_price: 700,
        image: "/cdn/shop/files/sample.jpg?v=1",
      },
    ],
  };
  const original = structuredClone(cart);
  ctx.calls[0].complete(cart);
  await until(
    () => ctx.container.querySelectorAll(".roman-cart-items li").length === 2,
    "Cart rows rendered",
  );
  const rows = ctx.container.querySelectorAll(".roman-cart-items li");
  assert.equal(
    rows[0].querySelector("img").src,
    "https://cdn.shopify.com/s/files/1/2/linen.jpg?v=2",
  );
  assert.equal(
    rows[1].querySelector("img").src,
    "https://shop.example/cdn/shop/files/sample.jpg?v=1",
  );
  assert.equal(rows[0].querySelector("h3").textContent, "Linen blind");
  assert.match(
    rows[0].querySelector(".roman-cart-item-details").textContent,
    /Quantity 2.*90\.00/,
  );
  assert.match(
    rows[1].querySelector(".roman-cart-item-details").textContent,
    /Quantity 1.*7\.00/,
  );
  assert.match(
    ctx.container.querySelector(".roman-cart-total").textContent,
    /97\.00/,
  );
  assert.equal(rows[0].querySelector("img").getAttribute("loading"), "lazy");
  assert.equal(rows[0].querySelector("img").alt, "");
  assert.equal(
    ctx.calls.length,
    1,
    "Images use the cart payload, without product/catalog requests",
  );
  assert.deepEqual(
    cart,
    original,
    "Display projection does not mutate the Shopify payload",
  );
  assert.doesNotMatch(
    ctx.container.innerHTML,
    /private cart token|Private note/,
  );
});

test("unsafe and missing images fall back without hiding cart contents", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Initial cart read");
  const images = [
    undefined,
    "javascript:alert(1)",
    "http://cdn.shopify.com/s/files/unsafe.jpg",
    "https://external.example/tracker.jpg",
    "https://secret@cdn.shopify.com/s/files/private.jpg",
    "https://shop.example/account",
    "https://cdn.shopify.com/s/files/image.jpg#fragment",
  ];
  ctx.calls[0].complete({
    ...exampleCart,
    item_count: images.length,
    total_price: images.length * 4500,
    items: images.map((image, index) => ({
      ...exampleCart.items[0],
      key: `line-${index}`,
      image,
    })),
  });
  await until(
    () =>
      ctx.container.querySelectorAll(".roman-cart-items li").length ===
      images.length,
    "Every valid cart line rendered",
  );
  assert.equal(ctx.container.querySelectorAll("img").length, 0);
  assert.equal(
    ctx.container.querySelectorAll(".roman-cart-image span").length,
    images.length,
  );
  assert.equal(ctx.container.querySelector('[role="alert"]'), null);
});

test("each cart row shows its own public dimensions and configuration without using the current product or private metadata", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Initial cart read");
  const cart = {
    ...exampleCart,
    item_count: 2,
    total_price: 9000,
    items: [
      {
        ...exampleCart.items[0],
        options_with_values: [
          { name: "Title", value: "Default Title" },
          { name: "Colour", value: "Linen" },
        ],
        properties: {
          Width: "400 mm",
          Drop: "500 mm",
          "Fitting option": "Exact",
          "Measurement type": "Bracket to bracket",
          Motor: "Electric Smartview",
          "Remote control": "14 Channel",
          Colour: "Linen",
          _configuration_id: "private configuration id",
          " _insurance_group": "private insurance grouping",
          Empty: "",
          Missing: null,
          Structured: { nested: "internal value" },
        },
      },
      {
        ...exampleCart.items[0],
        key: "line-2",
        options_with_values: [{ name: "Colour", value: "Green" }],
        properties: { Width: "80 cm", Drop: "120 cm", Fitting: "Recess" },
      },
    ],
  };
  const original = structuredClone(cart);
  ctx.calls[0].complete(cart);
  await until(
    () =>
      ctx.container.querySelectorAll(".roman-cart-configuration").length === 2,
    "Configuration is rendered for each line",
  );
  const details = [
    ...ctx.container.querySelectorAll(".roman-cart-configuration"),
  ].map((list) =>
    [...list.querySelectorAll("div")].map((row) => [
      row.querySelector("dt").textContent,
      row.querySelector("dd").textContent,
    ]),
  );
  assert.deepEqual(details[0], [
    ["Colour", "Linen"],
    ["Width", "400 mm"],
    ["Drop", "500 mm"],
    ["Fitting option", "Exact"],
    ["Measurement type", "Bracket to bracket"],
    ["Motor", "Electric Smartview"],
    ["Remote control", "14 Channel"],
  ]);
  assert.deepEqual(details[1], [
    ["Colour", "Green"],
    ["Width", "80 cm"],
    ["Drop", "120 cm"],
    ["Fitting", "Recess"],
  ]);
  assert.doesNotMatch(
    ctx.container.textContent,
    /private|internal value|Default Title|Structured|Missing|Empty/,
  );
  assert.equal(
    ctx.calls.length,
    1,
    "Cart configuration needs no PDP or catalog fetch",
  );
  assert.deepEqual(cart, original);
});

test("cart configuration remains literal text and malformed optional details cannot hide a valid line", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Initial cart read");
  ctx.calls[0].complete({
    ...exampleCart,
    properties: { "Cart attribute": "not a line option" },
    items: [
      {
        ...exampleCart.items[0],
        options_with_values: [
          null,
          [],
          "unexpected",
          { name: "Bad", value: {} },
        ],
        properties: {
          "<img src=x onerror=alert(1)>": "<script>alert(1)</script>",
          Spacing: 0,
          Selection: false,
          Excessive: "x".repeat(1001),
        },
      },
    ],
  });
  await until(
    () => ctx.container.querySelector(".roman-cart-configuration"),
    "Literal options render",
  );
  const details = ctx.container.querySelector(".roman-cart-configuration");
  assert.equal(details.querySelector("img,script,a"), null);
  assert.match(details.textContent, /<script>alert\(1\)<\/script>/);
  assert.match(details.textContent, /Spacing0Selectionfalse/);
  assert.doesNotMatch(details.textContent, /Excessive|not a line option/);
  assert.match(ctx.container.textContent, /Linen blind/);
  assert.equal(ctx.container.querySelector('[role="alert"]'), null);
});

test("HD cart dimensions and nested options use saved display fields without leaking serialized private configuration", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Initial cart read");
  const properties = {
    _user_unit: "cm",
    _user_unit_width: "30",
    _user_unit_drop: "66",
    _width: "300",
    _drop: "660",
    _unit: "mm",
    _selected_features_data: JSON.stringify([
      {
        feature_id: "1",
        feature_label: "Fitting",
        feature_option_label: "Exact",
        feature_option_id: "2",
      },
      {
        feature_id: "82",
        feature_label: "Control",
        feature_option_label: "Electric Smartview",
        feature_option_id: "204",
      },
      {
        feature_id: "6917",
        feature_label: "Remote control",
        feature_option_label: "14 Channel Remote Control",
        feature_option_id: "11434",
        feature_option_price: "19.95",
      },
      {
        feature_label: "Measurement Placeholder",
        feature_option_label: "internal placeholder",
      },
    ]),
    _insurance_group: "private group",
    _custom_price: "private price",
    _sku: "private SKU",
  };
  ctx.calls[0].complete({
    ...exampleCart,
    item_count: 2,
    total_price: 9000,
    items: [
      { ...exampleCart.items[0], properties },
      {
        ...exampleCart.items[0],
        key: "line-2",
        properties: {
          _user_unit: "inches",
          _user_unit_width: "20",
          _user_unit_width_inches: "0.125",
          _user_unit_drop: "30",
          _user_unit_drop_inches: "0.5",
          _width: "511.175",
          _drop: "774.7",
          _unit: "mm",
        },
      },
    ],
  });
  await until(
    () =>
      ctx.container.querySelectorAll(".roman-cart-configuration").length === 2,
    "Saved HD selections render",
  );
  const lists = [
    ...ctx.container.querySelectorAll(".roman-cart-configuration"),
  ];
  assert.deepEqual(
    [...lists[0].querySelectorAll("div")].map((row) => [
      row.querySelector("dt").textContent,
      row.querySelector("dd").textContent,
    ]),
    [
      ["Width", "30 cm"],
      ["Drop", "66 cm"],
      ["Fitting", "Exact"],
      ["Control", "Electric Smartview"],
      ["Remote control", "14 Channel Remote Control"],
    ],
  );
  assert.match(lists[1].textContent, /Width20\.125 inDrop30\.5 in/);
  assert.doesNotMatch(
    ctx.container.textContent,
    /private|_user_unit|feature_option_id|11434|19\.95|internal placeholder|300 mm/,
  );
  assert.equal(ctx.calls.length, 1);
});

test("malformed HD details do not hide valid cart lines or invent dimensions or feature labels", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Initial cart read");
  ctx.calls[0].complete({
    ...exampleCart,
    item_count: 3,
    total_price: 13500,
    items: [
      {
        ...exampleCart.items[0],
        properties: {
          _user_unit: "unknown",
          _user_unit_width: "100",
          _user_unit_drop: "200",
          _width: "600",
          _drop: "900",
          _unit: "mm",
          _selected_features_data: "{bad json",
        },
      },
      {
        ...exampleCart.items[0],
        key: "line-2",
        properties: {
          _user_unit: "inches",
          _user_unit_width: "20",
          _user_unit_width_inches: "wrong",
          _user_unit_drop: "0",
          _selected_features_data: JSON.stringify([
            null,
            "bad",
            { feature_label: "Broken", feature_option_label: {} },
          ]),
        },
      },
      {
        ...exampleCart.items[0],
        key: "line-3",
        properties: {
          _preset_size_name: "Small",
          _selected_features_data: JSON.stringify({ token: "private value" }),
        },
      },
    ],
  });
  await until(
    () => ctx.container.querySelectorAll(".roman-cart-items li").length === 3,
    "All valid cart lines render",
  );
  const rows = ctx.container.querySelectorAll(".roman-cart-items li");
  assert.match(rows[0].textContent, /Width600 mmDrop900 mm/);
  assert.equal(rows[1].querySelector(".roman-cart-configuration"), null);
  assert.equal(
    rows[2].querySelector(".roman-cart-configuration").textContent,
    "SizeSmall",
  );
  assert.doesNotMatch(
    ctx.container.textContent,
    /wrong|bad json|Broken|private value|100 unknown|Drop0/,
  );
  assert.equal(ctx.container.querySelector('[role="alert"]'), null);
});

test("failed image loading has a quiet fallback and a refreshed source can load", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Initial cart read");
  const cart = {
    ...exampleCart,
    items: [
      {
        ...exampleCart.items[0],
        image: "https://cdn.shopify.com/s/files/image.jpg?v=1",
      },
    ],
  };
  ctx.calls[0].complete(cart);
  await until(
    () => ctx.container.querySelector("img"),
    "Initial image rendered",
  );
  ctx.container
    .querySelector("img")
    .dispatchEvent(new ctx.window.Event("error"));
  await until(
    () => ctx.container.querySelector(".roman-cart-image span"),
    "Failed image falls back",
  );
  assert.match(ctx.container.textContent, /Linen blind/);
  ctx.window.document.dispatchEvent(new ctx.window.CustomEvent("cart:updated"));
  await until(() => ctx.calls.length === 2, "Refresh reads cart once");
  ctx.calls[1].complete({
    ...cart,
    items: [
      {
        ...cart.items[0],
        image: "https://cdn.shopify.com/s/files/image.jpg?v=2",
      },
    ],
  });
  await until(() => ctx.container.querySelector("img"), "New source rendered");
  assert.equal(
    ctx.container.querySelector("img").src,
    "https://cdn.shopify.com/s/files/image.jpg?v=2",
  );
});

test("native cart changes and completed cart tools refresh the display without racing a mutation", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Initial cart read");
  ctx.calls[0].complete();
  await until(
    () => ctx.container.textContent.includes("Linen blind"),
    "Initial cart rendered",
  );
  ctx.update({
    tools: [
      { id: "clear-1", name: "clear_cart", status: "running", arguments: {} },
    ],
  });
  await until(
    () => ctx.container.querySelector('[aria-busy="true"]'),
    "Running mutation marks display stale",
  );
  assert.equal(ctx.calls.length, 1);
  ctx.window.document.body.dispatchEvent(
    new ctx.window.CustomEvent("cart:updated"),
  );
  await delay(10);
  assert.equal(
    ctx.calls.length,
    1,
    "Native event cannot race the in-flight tool",
  );
  ctx.update({ tools: [] });
  await until(() => ctx.calls.length === 2, "Finished mutation refreshes cart");
  ctx.calls[1].complete({
    ...exampleCart,
    item_count: 0,
    total_price: 0,
    items: [],
  });
  await until(
    () => ctx.container.textContent.includes("Your cart is empty"),
    "Updated cart rendered",
  );
  ctx.window.document.body.dispatchEvent(
    new ctx.window.CustomEvent("cart:updated"),
  );
  await until(
    () => ctx.calls.length === 3,
    "Native changes also refresh without a model tool",
  );
  ctx.calls[2].complete();
  await until(
    () => ctx.container.textContent.includes("Linen blind"),
    "Native cart result rendered",
  );
});

test("closing Roman cancels its read and a late response cannot overwrite its reopened cart", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Initial request started");
  ctx.open(false);
  await until(
    () => ctx.calls[0].options.signal.aborted,
    "Obsolete read aborted",
  );
  ctx.calls[0].complete();
  await delay(10);
  assert.equal(ctx.container.textContent.includes("Linen blind"), false);
  ctx.open(true);
  await until(
    () => ctx.calls.length === 2,
    "Returning starts a fresh cart read",
  );
  ctx.calls[1].complete({
    ...exampleCart,
    item_count: 0,
    total_price: 0,
    items: [],
  });
  await until(
    () => ctx.container.textContent.includes("Your cart is empty"),
    "Fresh empty cart rendered",
  );
  assert.equal(ctx.container.querySelector(".roman-checkout"), null);
});

test("malformed currency becomes a retryable cart error, not a conversation render crash", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Initial request started");
  ctx.calls[0].complete({ ...exampleCart, currency: "not-a-currency" });
  await until(
    () => ctx.container.querySelector('[role="alert"]'),
    "Invalid cart is rejected before rendering",
  );
  ctx.container.querySelector("button").click();
  await until(() => ctx.calls.length === 2, "Retry starts a fresh read");
  ctx.calls[1].complete();
  await until(
    () => ctx.container.textContent.includes("Linen blind"),
    "Retry renders verified cart",
  );
});

test("unmount cancels pending cart work and removes store subscriptions", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Initial request started");
  ctx.dispose();
  assert.equal(ctx.calls[0].options.signal.aborted, true);
  assert.equal(ctx.navigationListeners.size, 0);
  assert.equal(ctx.sessionListeners.size, 0);
  ctx.calls[0].complete();
  await delay(10);
  assert.equal(ctx.container.textContent, "");
});

const discountedCart = {
  ...exampleCart,
  item_count: 2,
  original_total_price: 3399,
  total_discount: 474,
  total_price: 2925,
  cart_level_discount_applications: [
    {
      title: "WELCOME10",
      total_allocated_amount: 224,
      value_type: "percentage",
      value: "10",
    },
  ],
  items: [
    {
      ...exampleCart.items[0],
      title: "Discounted linen blind",
      original_line_price: 2499,
      final_line_price: 2249,
      line_level_discount_allocations: [
        {
          amount: 250,
          discount_application: {
            title: "Spring sale",
            value_type: "percentage",
            value: "10",
          },
        },
      ],
    },
    {
      ...exampleCart.items[0],
      key: "line-2",
      title: "Matching sample",
      original_line_price: 900,
      final_line_price: 900,
      line_level_discount_allocations: [],
    },
  ],
};

test("applied line and cart discounts keep final prices distinct without subtracting or summing allocations again", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Cart read");
  ctx.calls[0].complete(discountedCart);
  await until(
    () => ctx.container.querySelector('[aria-label="Applied cart discounts"]'),
    "Applied discount metadata rendered",
  );
  const rows = ctx.container.querySelectorAll(".roman-cart-items > li");
  assert.equal(rows.length, 2);
  assert.match(
    rows[0].querySelector(".roman-cart-price del").textContent,
    /24\.99/,
  );
  assert.match(
    rows[0].querySelector(".roman-cart-price strong").textContent,
    /22\.49/,
  );
  assert.match(
    rows[0].querySelector(".roman-cart-discounts").textContent,
    /Spring sale.*2\.50/,
  );
  assert.equal(
    rows[1].querySelector("del"),
    null,
    "An unchanged line price is not struck through",
  );
  assert.equal(
    rows[1].querySelector(".roman-cart-discounts"),
    null,
    "No line allocations remain unstated",
  );
  assert.doesNotMatch(
    ctx.container.querySelector(".roman-cart-items").textContent,
    /WELCOME10|2\.24|4\.74/,
  );
  const summary = ctx.container.querySelector(".roman-cart-summary");
  assert.match(
    summary.querySelector(".roman-cart-total del").textContent,
    /33\.99/,
  );
  assert.match(
    summary.querySelector(".roman-cart-total strong").textContent,
    /29\.25/,
  );
  assert.match(
    summary.querySelector(".roman-cart-discounts").textContent,
    /WELCOME10.*2\.24/,
  );
  assert.doesNotMatch(
    summary.querySelector(".roman-cart-discounts").textContent,
    /Spring sale/,
  );
  assert.match(
    summary.querySelector(".roman-cart-savings").textContent,
    /Total savings.*4\.74/,
  );
  assert.equal(
    ctx.calls.length,
    1,
    "Discount display uses the shared cart read",
  );
});

test("missing or zero discount metadata produces no invented discount, savings or percentage", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Cart read");
  ctx.calls[0].complete(exampleCart);
  await until(
    () => ctx.container.querySelector(".roman-cart-price"),
    "Prices rendered",
  );
  assert.equal(
    ctx.container.querySelector(
      "del, .roman-cart-discounts, .roman-cart-savings",
    ),
    null,
  );
  assert.doesNotMatch(ctx.container.textContent, /discount|savings|%/i);
  ctx.window.document.dispatchEvent(new ctx.window.CustomEvent("cart:updated"));
  await until(() => ctx.calls.length === 2, "Cart refresh");
  ctx.calls[1].complete({
    ...exampleCart,
    original_total_price: 4500,
    total_discount: 0,
    cart_level_discount_applications: [],
    items: [
      {
        ...exampleCart.items[0],
        original_line_price: 4500,
        line_level_discount_allocations: [],
      },
    ],
  });
  await until(
    () => !ctx.container.querySelector('[role="status"]'),
    "Zero-discount cart rendered",
  );
  assert.equal(
    ctx.container.querySelector(
      "del, .roman-cart-discounts, .roman-cart-savings",
    ),
    null,
  );
});

test("original prices do not invent named discount allocations or total savings and later carts remove old metadata", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Cart read");
  ctx.calls[0].complete({
    ...exampleCart,
    original_total_price: 5000,
    items: [{ ...exampleCart.items[0], original_line_price: 5000 }],
  });
  await until(
    () => ctx.container.querySelectorAll("del").length === 2,
    "Verified original prices rendered",
  );
  assert.equal(
    ctx.container.querySelector(".roman-cart-discounts, .roman-cart-savings"),
    null,
  );
  ctx.window.document.dispatchEvent(new ctx.window.CustomEvent("cart:updated"));
  await until(() => ctx.calls.length === 2, "Cart refresh");
  ctx.calls[1].complete(exampleCart);
  await until(
    () => !ctx.container.querySelector('[role="status"]'),
    "Refreshed cart rendered",
  );
  assert.equal(
    ctx.container.querySelector(
      "del, .roman-cart-discounts, .roman-cart-savings",
    ),
    null,
  );
});
