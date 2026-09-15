import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  entryPoints: ["frontend/src/main.tsx"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanAssistant",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".svg": "dataurl", ".css": "text", ".woff2": "dataurl" },
});

async function until(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(message);
}

async function setup(t, shop = "hd-dev-multi.myshopify.com") {
  const dom = new JSDOM(
    `<!doctype html><html data-roman-preview="true"><head><title>Store</title></head>
    <body><app-provider><main id="main">Store content</main></app-provider>
    <roman-ai-assistant data-shop="${shop}" data-logo-url="/roman-logo.svg"></roman-ai-assistant></body></html>`,
    {
      url: `https://${shop}/`,
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;
  const requests = [];
  const errors = [];
  window.performance.now = () => 1600;
  window.Shopify = { routes: { root: "/en-gb/" } };
  window.console.error = (...args) => errors.push(args);
  window.fetch = (url, options) =>
    new Promise((resolve) => {
      requests.push({ url: String(url), options, resolve });
    });
  window.eval(
    `${bundle.outputFiles[0].text}\nwindow.RomanAssistant = RomanAssistant;`,
  );
  const host = window.document.querySelector("roman-ai-assistant");
  const container = window.document.createElement("div");
  host.attachShadow({ mode: "open" }).append(container);
  const runtime = window.RomanAssistant.mountAssistant(host, container, 0);
  t.after(() => {
    runtime.dispose();
    window.close();
  });
  let ready = false;
  let failure;
  runtime.ready.then(
    () => {
      ready = true;
    },
    (error) => {
      failure = error;
    },
  );
  await until(
    () => ready || failure,
    "the actual React runtime did not finish mounting",
  );
  if (failure) throw failure;
  return { window, host, container, runtime, requests, errors };
}

function controlByLabel(container, text) {
  const label = [...container.querySelectorAll("label")].find(
    (element) => element.textContent.trim() === text,
  );
  assert.ok(label, `Missing ${text} label`);
  const control = container.querySelector(`[id="${label.htmlFor}"]`);
  assert.ok(control, `Missing ${text} control`);
  return control;
}

async function selectTool(window, container, name = "get_cart", args = {}) {
  const development = container.querySelector(".roman-development");
  if (!development.open) development.querySelector("summary").click();
  const drawer = development.querySelector(".roman-tools");
  if (!drawer.open) drawer.querySelector("summary").click();
  const select = controlByLabel(drawer, "Tool");
  select.value = name;
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await until(
    () =>
      controlByLabel(drawer, "Arguments (JSON)").value ===
      JSON.stringify(args, null, 2),
    `choosing ${name} did not populate its arguments`,
  );
  return drawer;
}

function cartResponse(options = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({
      currency: "GBP",
      item_count: 1,
      total_price: 12300,
      token: "CART_TOKEN_SECRET",
      items: [
        {
          title: "Roman blind",
          quantity: 1,
          variant_id: 123,
          key: "123:configured-line",
          final_line_price: 12300,
        },
      ],
    }),
    ...options,
  };
}

test("the real runtime exposes manual tools only on development shops and makes no eager tool requests", async (t) => {
  for (const [shop, visible] of [
    ["hd-dev-multi.myshopify.com", true],
    ["hd-dev-single.myshopify.com", true],
    ["select-blinds-us.myshopify.com", false],
    ["blinds-2go.myshopify.com", false],
    ["blinds2go-ireland.myshopify.com", false],
  ]) {
    await t.test(shop, async (t) => {
      const { container, requests } = await setup(t, shop);
      assert.equal(
        Boolean(container.querySelector('nav[aria-label="Browse store"]')),
        visible,
      );
      const drawer = container.querySelector(".roman-development");
      assert.equal(Boolean(drawer), visible);
      if (drawer) {
        assert.equal(drawer.open, false);
        drawer.querySelector("summary").click();
        await delay(0);
      }
      assert.deepEqual(requests, []);
    });
  }
});

test("manual cart actions use the real executor, prevent duplicate submission and show results or errors", async (t) => {
  const { window, container, requests, errors } = await setup(t);
  const drawer = await selectTool(window, container);
  assert.equal(requests.length, 0);
  const submit = drawer.querySelector('button[type="submit"]');
  submit.click();
  submit.click(); // Same-turn repeats must also be guarded before React rerenders.
  await until(
    () => submit.disabled,
    "the pending cart action did not disable submission",
  );
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://hd-dev-multi.myshopify.com/en-gb/cart.js",
  );
  assert.equal(requests[0].options.credentials, "same-origin");
  assert.equal(drawer.querySelector("form").getAttribute("aria-busy"), "true");
  assert.equal(controlByLabel(drawer, "Tool").disabled, true);
  requests[0].resolve(cartResponse());
  await until(
    () => drawer.querySelector('[aria-label="Tool result"]'),
    "the cart result was not displayed",
  );
  const result = drawer.querySelector('[aria-label="Tool result"]').value;
  assert.deepEqual(JSON.parse(result), {
    currency: "GBP",
    itemCount: 1,
    totalPriceMinorUnits: 12300,
    items: [
      {
        title: "Roman blind",
        variantId: 123,
        lineKey: "123:configured-line",
        quantity: 1,
        linePriceMinorUnits: 12300,
      },
    ],
  });
  assert.doesNotMatch(result, /CART_TOKEN_SECRET|token/);
  assert.equal(submit.disabled, false);
  assert.equal(drawer.querySelector("form").getAttribute("aria-busy"), "false");

  submit.click();
  await until(
    () => requests.length === 2,
    "a completed action did not allow another request",
  );
  requests[1].resolve(cartResponse({ ok: false, status: 503 }));
  await until(
    () => drawer.querySelector('[role="alert"]'),
    "the failed cart request was not surfaced",
  );
  assert.match(
    drawer.querySelector('[role="alert"]').textContent,
    /Shopify cart request failed \(503\)/,
  );
  assert.equal(drawer.querySelector('[aria-label="Tool result"]'), null);
  assert.equal(submit.disabled, false);
  assert.deepEqual(errors, []);
});

test("selecting a cart mutation labels its explicit action without running it", async (t) => {
  const { window, container, requests } = await setup(t);
  for (const [name, args, label] of [
    ["remove_from_cart", { lineKey: "" }, "Remove item from cart"],
    ["set_cart_quantity", { lineKey: "", quantity: 2 }, "Change cart quantity"],
    ["clear_cart", {}, "Clear entire cart"],
  ]) {
    const drawer = await selectTool(window, container, name, args);
    assert.equal(
      drawer.querySelector('button[type="submit"]').textContent,
      label,
    );
    assert.equal(drawer.querySelector('[aria-label="Tool result"]'), null);
    assert.deepEqual(requests, []);
  }
});

test("the explicit clear-cart button invokes one theme action and displays only the confirmed safe result", async (t) => {
  const { window, container, requests, errors } = await setup(t);
  window.customElements.define(
    "app-provider",
    class extends window.HTMLElement {},
  );
  window.customElements.define(
    "cart-sections",
    class extends window.HTMLElement {},
  );
  const owner = window.document.createElement("cart-sections");
  owner.cart = await cartResponse().json();
  window.document.querySelector("main").append(owner);
  let submissions = 0;
  let finishTheme;
  owner.clearCart = () => {
    submissions++;
    return new Promise((resolve) => {
      finishTheme = resolve;
    });
  };
  const drawer = await selectTool(window, container, "clear_cart");
  const submit = drawer.querySelector('button[type="submit"]');
  assert.equal(submit.textContent, "Clear entire cart");
  assert.equal(requests.length, 0);
  assert.equal(submissions, 0);

  // Voice belongs to the same drawer, but changing it must never submit or
  // retarget the selected cart mutation.
  const voice = controlByLabel(drawer, "Voice");
  voice.value = "gleam";
  voice.dispatchEvent(new window.Event("change", { bubbles: true }));
  await until(
    () => window.sessionStorage.getItem("roman:voice") === "gleam",
    "the voice preference did not change",
  );
  assert.equal(controlByLabel(drawer, "Tool").value, "clear_cart");
  assert.equal(controlByLabel(drawer, "Arguments (JSON)").value, "{}");
  assert.equal(submit.textContent, "Clear entire cart");
  assert.equal(requests.length, 0);
  assert.equal(submissions, 0);

  submit.click();
  submit.click();
  await until(
    () => requests.length === 1 && submit.disabled,
    "the explicit clear action did not begin reading the current cart",
  );
  assert.equal(
    submissions,
    0,
    "the theme mutation must wait for the current cart check",
  );
  assert.equal(requests[0].options.method ?? "GET", "GET");
  requests[0].resolve(cartResponse());
  await until(
    () => submissions === 1,
    "the ready theme cart was not asked to clear",
  );
  assert.equal(drawer.querySelector('[aria-label="Tool result"]'), null);
  assert.equal(submit.disabled, true);

  const emptyCart = {
    currency: "GBP",
    item_count: 0,
    total_price: 0,
    items: [],
    token: "RAW_CART_SECRET",
    note: "RAW_NOTE_SECRET",
    attributes: { customer: "RAW_CUSTOMER_SECRET" },
  };
  owner.cart = emptyCart;
  owner.dispatchEvent(
    new window.CustomEvent("cart:updated", {
      bubbles: true,
      detail: emptyCart,
    }),
  );
  finishTheme();
  await until(
    () => drawer.querySelector('[aria-label="Tool result"]'),
    "the confirmed clear-cart result was not displayed",
  );
  const output = drawer.querySelector('[aria-label="Tool result"]').value;
  const result = JSON.parse(output);
  assert.equal(result.status, "updated");
  assert.deepEqual(result.cart, {
    currency: "GBP",
    itemCount: 0,
    totalPriceMinorUnits: 0,
    items: [],
  });
  assert.doesNotMatch(output, /SECRET|token|attributes|customer|note/);
  assert.equal(submissions, 1);
  assert.equal(
    requests.length,
    1,
    "Roman submits through the theme rather than adding its own Ajax mutation",
  );
  assert.equal(submit.disabled, false);
  assert.deepEqual(errors, []);
});

test("disposing the mounted runtime aborts a pending tool and ignores its late response", async (t) => {
  const { window, host, container, runtime, requests, errors } = await setup(t);
  const drawer = await selectTool(window, container);
  drawer.querySelector('button[type="submit"]').click();
  await until(() => requests.length === 1, "the cart request did not start");
  runtime.dispose();
  host.remove();
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(container.childNodes.length, 0);
  const updates = [];
  const observer = new window.MutationObserver((records) =>
    updates.push(...records),
  );
  observer.observe(container, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  observer.observe(drawer, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  t.after(() => observer.disconnect());
  requests[0].resolve(cartResponse());
  await delay(10);
  assert.deepEqual(updates, []);
  assert.equal(container.childNodes.length, 0);
  assert.equal(drawer.querySelector('[aria-label="Tool result"]'), null);
  assert.equal(drawer.querySelector('[role="alert"]'), null);
  assert.deepEqual(errors, []);
});
