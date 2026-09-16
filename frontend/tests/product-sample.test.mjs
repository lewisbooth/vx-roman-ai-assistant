import assert from "node:assert/strict";
import { test } from "node:test";
import { cwd } from "node:process";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents:
      "export * from './frontend/src/tools/product-sample'; export { createProductConfigurationTools } from './frontend/src/tools/product-configuration'; export { createStorefrontExecutor } from './frontend/src/session/storefront-executor';",
    resolveDir: cwd(),
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanSample",
  platform: "browser",
});
const contractBundle = await build({
  entryPoints: ["shared/cart-tools.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const contractModule = { exports: {} };
new Function("module", "exports", contractBundle.outputFiles[0].text)(
  contractModule,
  contractModule.exports,
);
const { parseCartResult } = contractModule.exports;

// The captured HD theme binds a direct click listener to addToCartButton,
// renders it in add-sample-btn, and emits cart:updated/error on its component.
// This fixture models that contract without executing theme network code.
function setup(t, { initialized = true, url = "/products/test" } = {}) {
  const dom = new JSDOM(
    `<!doctype html><body class="template-product"><app-provider><main id="main">
      <h1>  Kitchen\n shade </h1>
      <dynamic-pricing><form data-dynamic-pricing-form>
        <button type="submit" data-price-box-atc data-atc-button>Add full blind</button>
      </form></dynamic-pricing>
      <dynamic-pricing-sample-option data-sample-id="456">
        <button type="button" data-sample-btn data-sample-variant-id="456"
          data-main-product-url="/products/test" data-main-product-variant="123"
          slot="add-sample-btn">Order a sample</button>
        <button type="button" slot="remove-sample-btn">Remove sample</button>
      </dynamic-pricing-sample-option>
      <cart-add-sample><button type="button">Unrelated sample control</button></cart-add-sample>
    </main></app-provider></body>`,
    {
      url: `https://hd-dev-single.myshopify.com${url}`,
      runScripts: "outside-only",
    },
  );
  const { window } = dom;
  const { document } = window;
  t.after(() => window.close());
  let clicks = 0;
  let fullSubmissions = 0;
  let unrelatedClicks = 0;
  if (initialized)
    window.customElements.define(
      "dynamic-pricing-sample-option",
      class extends window.HTMLElement {
        connectedCallback() {
          this.attachShadow({ mode: "open" }).innerHTML =
            '<slot></slot><slot name="add-sample-btn"></slot>';
          this.addToCartButton = this.querySelector("[data-sample-variant-id]");
          this.addToCartButton.addEventListener("click", () => {
            clicks++;
            this.addToCartButton.setAttribute("aria-busy", "true");
          });
        }
      },
    );
  const component = document.querySelector("dynamic-pricing-sample-option");
  const button = component.querySelector("[data-sample-btn]");
  const form = document.querySelector("[data-dynamic-pricing-form]");
  component.cart = { items: [{ id: 123, variant_id: 123, quantity: 2 }] };
  // JSDOM has no layout. Model rendered/offscreen geometry explicitly.
  button.getClientRects = () =>
    window.getComputedStyle(button).display === "none"
      ? []
      : [{ x: 0, y: 2000, width: 120, height: 44 }];
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    fullSubmissions++;
  });
  document
    .querySelector("cart-add-sample button")
    .addEventListener("click", () => {
      unrelatedClicks++;
    });
  window.fetch = () => assert.fail("Roman must not write its own cart request");
  const controller = new window.AbortController();
  t.after(() => controller.abort());
  const tracked = new Map();
  for (const target of [component, document, window, controller.signal]) {
    const listeners = new Set();
    tracked.set(target, listeners);
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (name, ...args) => {
      if (
        [
          "cart:updated",
          "cart:error",
          "roman:navigation",
          "pagehide",
          "abort",
        ].includes(name)
      )
        listeners.add(name);
      return add(name, ...args);
    };
    target.removeEventListener = (name, ...args) => {
      listeners.delete(name);
      return remove(name, ...args);
    };
  }
  let deadline;
  window.setTimeout = (callback, ms) => {
    assert.equal(ms, 15000);
    deadline = callback;
    return 1;
  };
  window.clearTimeout = () => {
    deadline = undefined;
  };
  window.eval(
    `${bundle.outputFiles[0].text}\nwindow.RomanSample = RomanSample;`,
  );
  const configuration = window.RomanSample.createProductConfigurationTools();
  const executor = window.RomanSample.createStorefrontExecutor({
    execute: async () => ({
      status: "navigated",
      url: window.location.href,
      pending: false,
    }),
  });
  t.after(() => {
    configuration.dispose();
    executor.dispose();
  });
  return {
    window,
    document,
    component,
    button,
    form,
    controller,
    run: (path = "/products/test") =>
      window.RomanSample.addProductSample(path, controller.signal),
    inspect: (path = "/products/test") =>
      window.RomanSample.inspectSampleProduct(path),
    available: (path = "/products/test") =>
      window.RomanSample.isSampleAvailable(path),
    readConfiguration: () =>
      configuration.getProductConfiguration(
        "/products/test",
        controller.signal,
      ),
    navigate: () => executor.execute("navigate", { path: "/products/test" }),
    counts: () => ({ clicks, fullSubmissions, unrelatedClicks }),
    update: (detail, target = component) =>
      target.dispatchEvent(
        new window.CustomEvent("cart:updated", { bubbles: true, detail }),
      ),
    error: (target = component) =>
      target.dispatchEvent(
        new window.CustomEvent("cart:error", {
          bubbles: true,
          detail: { message: "private raw theme payload" },
        }),
      ),
    timeout: () => deadline(),
    assertClean: () => {
      assert.equal(deadline, undefined);
      for (const listeners of tracked.values()) assert.equal(listeners.size, 0);
    },
  };
}

test("sample add clicks only the theme's exact sample control and confirms its variant", async (t) => {
  const env = setup(t, { url: "/products/test?variant=123" });
  assert.equal(env.available(), true);
  const action = env.run();
  assert.equal(
    env.available(),
    false,
    "an in-flight sample cannot be offered again",
  );
  assert.deepEqual(env.counts(), {
    clicks: 1,
    fullSubmissions: 0,
    unrelatedClicks: 0,
  });
  env.update({
    token: "never exposed",
    attributes: { private: true },
    items: [
      { id: 123, variant_id: 123, quantity: 2 },
      { id: 456, variant_id: 456, quantity: 1 },
    ],
  });
  const result = await action;
  const expected = {
    status: "added",
    addedSample: { productPath: "/products/test", title: "Kitchen shade" },
    message: "The storefront confirmed the sample was added to your cart.",
  };
  assert.deepEqual(JSON.parse(JSON.stringify(result)), expected);
  assert.deepEqual(
    parseCartResult("add_sample_to_cart", result),
    expected,
    "the real browser outcome must survive the shared server/client validator",
  );
  env.assertClean();
});

test("sample confirmation ignores full-product, child, document and malformed cart events", async (t) => {
  const env = setup(t);
  let settled = false;
  const action = env.run().then((result) => {
    settled = true;
    return result;
  });
  env.update({ items: [{ variant_id: 456, quantity: 1 }] }, env.button);
  env.update({ items: [{ variant_id: 456, quantity: 1 }] }, env.document);
  for (const detail of [
    null,
    {},
    { items: null },
    { items: [null] },
    { items: [{ variant_id: 456, quantity: "1" }] },
    { items: [{ variant_id: 456, quantity: -1 }] },
    { items: [{ variant_id: 456, quantity: 0.5 }] },
    { items: [{ variant_id: "456", quantity: 1 }] },
    { items: [{ variant_id: 456, quantity: 1 }, { quantity: 2 }] },
    {
      items: [
        { variant_id: 456, quantity: 1 },
        { variant_id: 0, quantity: 2 },
      ],
    },
    {
      items: [
        { variant_id: 456, quantity: 1 },
        { variant_id: 123.5, quantity: 2 },
      ],
    },
    {
      items: [
        { variant_id: 456, quantity: 1 },
        { variant_id: 123, quantity: "2" },
      ],
    },
    { items: [{ variant_id: 123, quantity: 50 }] },
    { items: [] },
  ])
    env.update(detail);
  env.error(env.button);
  await Promise.resolve();
  assert.equal(settled, false);
  env.update({
    items: [
      { variant_id: 456, quantity: 1 },
      { variant_id: 456, quantity: 2 },
    ],
  });
  const result = await action;
  assert.equal(result.status, "added");
  assert.equal(
    "quantityAdded" in result,
    false,
    "sample outcomes do not borrow the full-product quantity field",
  );
  assert.equal(parseCartResult("add_sample_to_cart", result).status, "added");
  env.assertClean();
});

test("already present samples do not click or wait for an event, including the theme's removed add slot", async (t) => {
  const env = setup(t);
  env.component.cart = { items: [{ id: 456, variant_id: 456, quantity: 1 }] };
  env.component.shadowRoot.innerHTML =
    '<slot></slot><slot name="remove-sample-btn"></slot>';
  assert.equal(env.button.assignedSlot, null);
  assert.equal(env.available(), false);
  const result = await env.run();
  assert.equal(result.status, "already_in_cart");
  assert.equal("addedSample" in result, false);
  assert.deepEqual(env.counts(), {
    clicks: 0,
    fullSubmissions: 0,
    unrelatedClicks: 0,
  });
  env.assertClean();
});

test("uninitialized or differently owned sample controls never receive a click", async (t) => {
  for (const mode of ["unregistered", "listener missing", "different button"])
    await t.test(mode, async (t) => {
      const env = setup(t, { initialized: mode !== "unregistered" });
      if (mode === "listener missing") env.component.addToCartButton = null;
      if (mode === "different button")
        env.component.addToCartButton = env.document.querySelector(
          "cart-add-sample button",
        );
      assert.equal(env.available(), false);
      await assert.rejects(env.run(), /initializing/);
      assert.equal(env.counts().clicks, 0);
      env.assertClean();
    });
});

test("sample controls must match the verified page, main variant and component sample identity", async (t) => {
  for (const mode of [
    "wrong page",
    "non-product",
    "cart edit",
    "main URL",
    "main variant",
    "invalid main ID",
    "sample mismatch",
    "invalid sample ID",
    "missing title",
  ])
    await t.test(mode, async (t) => {
      const env = setup(t, {
        url:
          mode === "cart edit"
            ? "/products/test?line=2"
            : mode === "main variant"
              ? "/products/test?variant=999"
              : "/products/test",
      });
      if (mode === "non-product")
        env.document.body.classList.remove("template-product");
      if (mode === "main URL")
        env.button.dataset.mainProductUrl = "/products/other";
      if (mode === "invalid main ID")
        env.button.dataset.mainProductVariant = "not-an-id";
      if (mode === "sample mismatch") env.component.dataset.sampleId = "789";
      if (mode === "invalid sample ID") {
        env.button.dataset.sampleVariantId = "bad";
        env.component.dataset.sampleId = "bad";
      }
      if (mode === "missing title")
        env.document.querySelector("h1").textContent = " ";
      assert.equal(
        env.available(
          mode === "wrong page" ? "/products/other" : "/products/test",
        ),
        false,
      );
      await assert.rejects(
        env.run(mode === "wrong page" ? "/products/other" : "/products/test"),
        /product|cart item/i,
      );
      assert.equal(env.counts().clicks, 0);
      env.assertClean();
    });
});

test("missing or ambiguous sample controls fail without falling back to full-product submission", async (t) => {
  for (const mode of [
    "missing component",
    "multiple components",
    "missing button",
    "multiple buttons",
  ])
    await t.test(mode, async (t) => {
      const env = setup(t);
      if (mode === "missing component") env.component.remove();
      if (mode === "multiple components")
        env.component.after(env.component.cloneNode(true));
      if (mode === "missing button") env.button.remove();
      if (mode === "multiple buttons")
        env.button.after(env.button.cloneNode(true));
      assert.equal(env.available(), false);
      await assert.rejects(env.run(), /sample|ambiguous/i);
      assert.deepEqual(env.counts(), {
        clicks: 0,
        fullSubmissions: 0,
        unrelatedClicks: 0,
      });
      env.assertClean();
    });
});

test("unrendered, hidden, disabled, busy and wrongly slotted controls cannot add samples", async (t) => {
  for (const mode of [
    "no slot",
    "default slot",
    "hidden",
    "inert",
    "aria hidden",
    "hidden class",
    "display none",
    "visibility hidden",
    "disabled",
    "aria disabled",
    "aria busy",
    "loading cart",
    "adding full product",
    "adding sample",
  ])
    await t.test(mode, async (t) => {
      const env = setup(t);
      if (mode === "no slot") env.component.shadowRoot.innerHTML = "";
      if (mode === "default slot") env.button.slot = "";
      if (mode === "hidden") env.component.hidden = true;
      if (mode === "inert") env.component.setAttribute("inert", "");
      if (mode === "aria hidden")
        env.component.setAttribute("aria-hidden", "true");
      if (mode === "hidden class") env.component.classList.add("hidden");
      if (mode === "display none") env.button.style.display = "none";
      if (mode === "visibility hidden") env.button.style.visibility = "hidden";
      if (mode === "disabled") env.button.disabled = true;
      if (mode === "aria disabled")
        env.button.setAttribute("aria-disabled", "true");
      if (mode === "aria busy") env.button.setAttribute("aria-busy", "true");
      if (mode === "loading cart") env.component.shopifyCartLoading = true;
      if (mode === "adding full product") env.form.classList.add("adding");
      if (mode === "adding sample") env.form.classList.add("adding-sample");
      assert.equal(env.available(), false);
      assert.equal((await env.run()).status, "needs_configuration");
      assert.equal(env.counts().clicks, 0);
      env.assertClean();
    });
});

test("unknown and malformed cart baselines cannot authorize a sample click", async (t) => {
  for (const cart of [
    undefined,
    null,
    {},
    { items: [null] },
    { items: [{ variant_id: 456, quantity: "1" }] },
    { items: [{ quantity: 1 }] },
    { items: [{ variant_id: "456", quantity: 1 }] },
  ]) {
    const env = setup(t);
    env.component.cart = cart;
    assert.equal(env.available(), false);
    await assert.rejects(env.run(), /cart data is still loading/);
    assert.equal(env.counts().clicks, 0);
    env.assertClean();
  }
});

test("sample availability is read-only and survives an unsupported product configuration form", (t) => {
  const env = setup(t);
  assert.equal(env.available(), true);
  const configuration = env.readConfiguration();
  assert.equal(
    configuration.status,
    "unavailable",
    "the sample component is independent of the pricing form",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(configuration.actions)), {
    sampleAvailable: true,
  });
  env.window.customElements.define(
    "dynamic-pricing",
    class extends env.window.HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: "open" }).innerHTML = "<slot></slot>";
      }
    },
  );
  const supported = env.readConfiguration();
  assert.equal(supported.status, "available");
  assert.equal(supported.actions.sampleAvailable, true);
  assert.deepEqual(env.counts(), {
    clicks: 0,
    fullSubmissions: 0,
    unrelatedClicks: 0,
  });
  env.assertClean();
});

test("navigation and configuration share current sample readiness rather than structural control presence", async (t) => {
  const env = setup(t);
  assert.equal((await env.navigate()).actions.sampleAvailable, true);
  env.button.disabled = true;
  assert.equal((await env.navigate()).actions.sampleAvailable, false);
  assert.equal(env.readConfiguration().actions.sampleAvailable, false);
  env.button.disabled = false;
  env.component.cart = { items: [{ id: 456, variant_id: 456, quantity: 1 }] };
  assert.equal((await env.navigate()).actions.sampleAvailable, false);
  assert.equal(env.readConfiguration().actions.sampleAvailable, false);
  assert.deepEqual(env.counts(), {
    clicks: 0,
    fullSubmissions: 0,
    unrelatedClicks: 0,
  });
  env.assertClean();
});

test("theme failures expose a safe error and release every owned observer", async (t) => {
  const env = setup(t);
  const action = env.run();
  env.error();
  await assert.rejects(
    action,
    (error) =>
      /Check its message and cart/.test(error.message) &&
      !error.message.includes("private"),
  );
  env.assertClean();
  assert.equal(env.counts().clicks, 1);
});

test("abort, page exit, navigation and timeout preserve uncertainty without replaying the sample click", async (t) => {
  for (const reason of [
    "abort",
    "pagehide",
    "navigation",
    "timeout",
    "click throws",
  ])
    await t.test(reason, async (t) => {
      const env = setup(t);
      if (reason === "click throws") {
        const click = env.button.click.bind(env.button);
        env.button.click = () => {
          click();
          throw new Error("Unknown after dispatch");
        };
      }
      const action = env.run();
      if (reason !== "click throws")
        await assert.rejects(env.run(), /already being submitted/);
      if (reason === "abort") env.controller.abort();
      if (reason === "pagehide")
        env.window.dispatchEvent(new env.window.Event("pagehide"));
      if (reason === "navigation") {
        env.component.remove();
        env.document.dispatchEvent(new env.window.Event("roman:navigation"));
      }
      if (reason === "timeout") env.timeout();
      const result = await action;
      assert.equal(result.status, "handed_off");
      assert.equal("addedSample" in result, false);
      assert.match(result.message, /Check the cart before trying again/);
      env.update({ items: [{ variant_id: 456, quantity: 1 }] });
      env.error();
      assert.equal(env.counts().clicks, 1);
      assert.equal(result.status, "handed_off");
      env.assertClean();
    });
});

test("a disconnected old component cannot confirm the new page's sample", async (t) => {
  const env = setup(t);
  const action = env.run();
  env.component.remove();
  env.update({ items: [{ variant_id: 456, quantity: 1 }] });
  env.timeout();
  assert.equal((await action).status, "handed_off");
  env.assertClean();
});

test("an already-aborted or synchronously cancelled preparation never clicks a sample", async (t) => {
  for (const when of ["before", "during inspection"])
    await t.test(when, async (t) => {
      const env = setup(t);
      if (when === "before") env.controller.abort();
      else
        Object.defineProperty(env.component, "cart", {
          get() {
            env.controller.abort();
            return { items: [] };
          },
        });
      await assert.rejects(env.run(), { name: "AbortError" });
      assert.equal(env.counts().clicks, 0);
      env.assertClean();
    });
});
