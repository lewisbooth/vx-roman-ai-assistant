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
    <main id="main"><h1>Kitchen shade</h1><cart-add-sample><form><button type="submit">Add sample</button></form></cart-add-sample>
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
  assert.deepEqual(JSON.parse(JSON.stringify(result.addedProduct)), {
    productPath: "/products/test",
    title: "Kitchen shade",
  });
  assert.equal(env.listeners.size, 0);
  assert.equal(env.hasDeadline(), false);
});

function measurements(env, unit = "mm") {
  const component = env.document.createElement("dynamic-pricing-measurements");
  component.innerHTML = `<select name="_product_measurement_type" data-measurement-select><option value="${unit}">${unit}</option></select>
    <div data-active-input-measurement data-input-measurement-group="${unit}">
      ${
        unit === "inches"
          ? `
        <select name="_width" data-width-input><option value="40">40</option></select>
        <select name="_width_inches" data-width-inches-input><option value="0.125">1/8</option></select>
        <select name="_drop" data-drop-input><option value="60">60</option></select>
        <select name="_drop_inches" data-drop-inches-input><option value="0.75">3/4</option></select>
      `
          : `
        <input name="_width" type="number" data-width-input value="123.5" step="any">
        <input name="_drop" type="number" data-drop-input value="234.25" step="any">
      `
      }
    </div>
    <div data-input-measurement-group="inactive"><input type="number" data-width-input value="999"><input type="number" data-drop-input value="999"></div>`;
  env.form.prepend(component);
  return component;
}

test("confirmed adds report the submitted active width, drop and unit, including exact inch fractions", async (t) => {
  for (const unit of ["mm", "cm", "inches"]) {
    await t.test(unit, async (t) => {
      const env = setup(t, { url: "/en-gb/products/test/" });
      measurements(env, unit);
      const action = env.run();
      env.update([{ variant_id: 123, quantity: 3 }]);
      const result = await action;
      assert.deepEqual(JSON.parse(JSON.stringify(result.addedProduct)), {
        productPath: "/en-gb/products/test",
        title: "Kitchen shade",
        measurements:
          unit === "inches"
            ? { width: 40.125, height: 60.75, unit: "in" }
            : { width: 123.5, height: 234.25, unit },
      });
    });
  }
});

test("add metadata captures the actual submit event, not earlier fields or later theme changes", async (t) => {
  const env = setup(t);
  const component = measurements(env);
  const width = component.querySelector(
    "[data-active-input-measurement] [data-width-input]",
  );
  env.button.addEventListener("click", () => {
    width.value = "345";
  });
  env.product.shadowRoot
    .querySelector("slot")
    .addEventListener("submit", () => {
      width.value = "999";
      env.document.querySelector("h1").textContent = "A later title";
    });
  const action = env.run();
  env.update([{ variant_id: 123, quantity: 3 }]);
  const result = await action;
  assert.equal(result.addedProduct.title, "Kitchen shade");
  assert.equal(result.addedProduct.measurements.width, 345);
});

test("a cart event before the actual submit cannot confirm this add", async (t) => {
  const env = setup(t);
  env.button.addEventListener("click", () => {
    env.update([{ variant_id: 123, quantity: 50 }]);
  });
  let settled = false;
  const action = env.run().then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(env.submissions(), 1);
  env.update([{ variant_id: 123, quantity: 3 }]);
  assert.equal((await action).quantityAdded, 2);
});

test("a synchronous theme confirmation after submit capture retains the submitted product", async (t) => {
  const env = setup(t);
  measurements(env);
  env.product.shadowRoot
    .querySelector("slot")
    .addEventListener("submit", () => {
      env.update([{ variant_id: 123, quantity: 3 }]);
    });
  const result = await env.run();
  assert.equal(result.status, "added");
  assert.equal(result.addedProduct.measurements.width, 123.5);
});

test("unknown or ambiguous measurement controls omit dimensions instead of inventing them", async (t) => {
  for (const change of [
    "missing",
    "unit",
    "ambiguous",
    "fraction",
    "disabled",
  ]) {
    await t.test(change, async (t) => {
      const env = setup(t);
      const component = measurements(
        env,
        change === "fraction" ? "inches" : "mm",
      );
      if (change === "missing")
        component
          .querySelector("[data-active-input-measurement] [data-drop-input]")
          .remove();
      if (change === "unit")
        component
          .querySelector("[data-active-input-measurement]")
          .setAttribute("data-input-measurement-group", "cm");
      if (change === "ambiguous")
        component
          .querySelector('[data-input-measurement-group="inactive"]')
          .setAttribute("data-active-input-measurement", "");
      if (change === "fraction")
        component.querySelector("[data-width-inches-input]").remove();
      if (change === "disabled")
        component.querySelector(
          "[data-active-input-measurement] [data-width-input]",
        ).disabled = true;
      const action = env.run();
      env.update([{ variant_id: 123, quantity: 3 }]);
      const result = await action;
      assert.equal(result.status, "added");
      assert.equal("measurements" in result.addedProduct, false);
    });
  }
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
  const result = await action;
  assert.equal(result.status, "handed_off");
  assert.equal("addedProduct" in result, false);
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
