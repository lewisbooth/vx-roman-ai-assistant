import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  entryPoints: ["frontend/src/tools/product.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanProduct",
  platform: "browser",
});

function setup(
  t,
  { initialized = true, handleSubmit = true, url = "/products/test" } = {},
) {
  const dom = new JSDOM(
    `<!doctype html><body class="template-product"><app-provider>
    <main id="main"><cart-add-sample><form><button type="submit">Add sample</button></form></cart-add-sample>
    <dynamic-pricing><form data-dynamic-pricing-form>
      <input name="_width" value="100" required>
      <input name="_drop" value="150" required>
      <input name="quantity" value="2">
      <button type="submit" data-instant-price-button>Calculate price</button>
      <button type="submit" name="add" data-atc-button data-price-box-atc>Add</button>
    </form></dynamic-pricing></main></app-provider></body>`,
    {
      url: `https://hd-dev-single.myshopify.com${url}`,
      runScripts: "outside-only",
    },
  );
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  let submissions = 0;
  if (initialized) {
    window.customElements.define(
      "dynamic-pricing",
      class extends window.HTMLElement {
        connectedCallback() {
          this.attachShadow({ mode: "open" }).innerHTML = "<slot></slot>";
          if (handleSubmit)
            this.shadowRoot
              .querySelector("slot")
              .addEventListener("submit", (event) => {
                event.preventDefault();
                assert.equal(
                  event.submitter,
                  this.querySelector("[data-price-box-atc]"),
                );
                submissions++;
              });
        }
      },
    );
  }
  const product = document.querySelector("dynamic-pricing");
  product.variantId = "123";
  product.cart = { items: [{ variant_id: 123, quantity: 1 }] };
  const form = product.querySelector("form");
  const button = form.querySelector("[data-price-box-atc]");
  window.fetch = () =>
    assert.fail("Roman must not construct its own cart mutation");
  const listeners = new Set();
  const add = product.addEventListener.bind(product);
  const remove = product.removeEventListener.bind(product);
  product.addEventListener = (name, ...args) => {
    listeners.add(name);
    return add(name, ...args);
  };
  product.removeEventListener = (name, ...args) => {
    listeners.delete(name);
    return remove(name, ...args);
  };
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
    `${bundle.outputFiles[0].text}\nwindow.RomanProduct = RomanProduct;`,
  );
  const controller = new window.AbortController();
  t.after(() => controller.abort());
  return {
    window,
    document,
    product,
    form,
    button,
    controller,
    listeners,
    run: () => window.RomanProduct.addConfiguredProduct(controller.signal),
    submissions: () => submissions,
    timeout: () => deadline(),
    hasDeadline: () => deadline !== undefined,
    update: (items, target = product) =>
      target.dispatchEvent(
        new window.CustomEvent("cart:updated", {
          bubbles: true,
          detail: { items },
        }),
      ),
  };
}

test("configured-product add uses the actual submitter and waits for a scoped cart quantity increase", async (t) => {
  const env = setup(t);
  let settled = false;
  const action = env.run().then((result) => {
    settled = true;
    return result;
  });
  assert.equal(env.submissions(), 1);
  assert.equal(env.form.elements.namedItem("_width").value, "100");
  assert.equal(env.form.elements.namedItem("_drop").value, "150");
  env.update([{ variant_id: 123, quantity: 5 }], env.button);
  env.update([
    { variant_id: 999, quantity: 5 },
    { variant_id: 123, quantity: 1 },
  ]);
  await Promise.resolve();
  assert.equal(settled, false, "unrelated cart events do not claim success");
  env.update([{ variant_id: 123, quantity: 3 }]);
  const result = await action;
  assert.equal(result.status, "added");
  assert.equal(result.quantityAdded, 2);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.hasDeadline(), false);
});

test("disabled, hidden, invalid and pricing-pending forms remain theme-owned", async (t) => {
  for (const state of [
    "disabled",
    "hidden",
    "invalid",
    "loading",
    "blocking",
    "variant-loading",
  ]) {
    await t.test(state, async (t) => {
      const env = setup(t);
      if (state === "disabled") env.button.disabled = true;
      else if (state === "hidden") env.button.hidden = true;
      else if (state === "invalid")
        env.form.elements.namedItem("_width").value = "";
      else env.form.classList.add(state);
      assert.equal((await env.run()).status, "needs_configuration");
      assert.equal(env.submissions(), 0);
      assert.equal(env.listeners.size, 0);
    });
  }
});

test("uninitialized product components and cart-edit pages cannot submit", async (t) => {
  const uninitialized = setup(t, { initialized: false });
  await assert.rejects(uninitialized.run(), /initializing/);
  const editing = setup(t, { url: "/products/test?line=2" });
  await assert.rejects(editing.run(), /editing an existing cart item/);
  assert.equal(editing.submissions(), 0);
});

test("an unhandled theme form cannot fall through to native form navigation", async (t) => {
  const env = setup(t, { handleSubmit: false });
  assert.equal((await env.run()).status, "needs_configuration");
  assert.equal(env.listeners.size, 0);
});

test("theme cart errors are failures without exposing their raw payload", async (t) => {
  const env = setup(t);
  const action = env.run();
  env.product.dispatchEvent(
    new env.window.CustomEvent("cart:error", {
      detail: { message: "private server response" },
    }),
  );
  await assert.rejects(
    action,
    (error) =>
      /could not add/.test(error.message) && !error.message.includes("private"),
  );
  assert.equal(env.listeners.size, 0);
  assert.equal(env.hasDeadline(), false);
});

test("a missing confirmation times out as handed off and never retries", async (t) => {
  const env = setup(t);
  const action = env.run();
  await assert.rejects(env.run(), /already being submitted/);
  env.timeout();
  assert.equal((await action).status, "handed_off");
  assert.equal(env.submissions(), 1);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.hasDeadline(), false);
});

test("cancellation after submission stops observation without claiming to undo the cart request", async (t) => {
  const env = setup(t);
  const action = env.run();
  env.controller.abort();
  assert.equal((await action).status, "handed_off");
  assert.equal(env.submissions(), 1);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.hasDeadline(), false);
  await assert.rejects(env.run(), { name: "AbortError" });
  assert.equal(env.submissions(), 1);
});

test("page replacement stops listening to an outgoing product", async (t) => {
  const env = setup(t);
  const action = env.run();
  env.product.remove();
  env.document.dispatchEvent(new env.window.CustomEvent("roman:navigation"));
  assert.equal((await action).status, "handed_off");
  assert.equal(env.listeners.size, 0);
});

test("missing cart baseline cannot turn an unrelated existing item into add confirmation", async (t) => {
  const env = setup(t);
  env.product.cart = undefined;
  const action = env.run();
  env.update([{ variant_id: 123, quantity: 8 }]);
  env.timeout();
  assert.equal((await action).status, "handed_off");
});
