import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  entryPoints: ["frontend/src/tools/cart-actions.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanCartActions",
  platform: "browser",
});

const line = (key, quantity = 1, extra = {}) => ({
  key,
  title: `Configured blind ${key}`,
  variant_id: 123,
  quantity,
  final_line_price: quantity * 1000,
  ...extra,
});
const cart = (items) => ({
  currency: "GBP",
  item_count: items.reduce((sum, item) => sum + item.quantity, 0),
  total_price: items.reduce((sum, item) => sum + item.final_line_price, 0),
  items,
  token: "private-cart-token",
  note: "private-note",
  attributes: { private: true },
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(
  t,
  { initialized = true, items = [line("123:a"), line("123:b", 2)] } = {},
) {
  const dom = new JSDOM(
    `<!doctype html><body><app-provider><main id="main"><cart-sections section-id="cart">
      <form id="cart" data-cart-form>
        <cart-remove-toggle key="123:a"><span><button>Remove first</button></span></cart-remove-toggle>
        <quantity-input key="123:a"><input type="number" min="1" max="10" step="1" value="1"></quantity-input>
        <cart-remove-toggle key="123:b"><button type="button">Remove second</button></cart-remove-toggle>
        <quantity-input key="123:b"><input type="number" min="1" max="10" step="1" value="2"></quantity-input>
      </form>
    </cart-sections></main></app-provider></body>`,
    {
      url: "https://hd-dev-single.myshopify.com/cart",
      runScripts: "outside-only",
    },
  );
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  const calls = [];
  let initial = cart(items);
  let requests = 0;
  let nativeSubmissions = 0;
  let clearPromise;
  document.querySelector("form").addEventListener("submit", (event) => {
    nativeSubmissions++;
    event.preventDefault();
  });
  if (initialized) {
    window.customElements.define(
      "app-provider",
      class extends window.HTMLElement {},
    );
    window.customElements.define(
      "cart-sections",
      class extends window.HTMLElement {
        clearCart() {
          calls.push({ kind: "clear", owner: this });
          return clearPromise ?? Promise.resolve();
        }
      },
    );
    window.customElements.define(
      "cart-remove-toggle",
      class extends window.HTMLElement {
        get key() {
          return this.getAttribute("key");
        }
        connectedCallback() {
          this.attachShadow({ mode: "open" }).innerHTML = "<slot></slot>";
          this.shadowRoot
            .querySelector("slot")
            .addEventListener("click", (event) => {
              assert.equal(
                event.defaultPrevented,
                true,
                "native navigation is blocked before theme delegation",
              );
              // The theme owns any insurance/warranty decisions from this context.
              calls.push({
                kind: "remove",
                owner: this,
                key: this.key,
                cart: this.cart,
              });
            });
        }
      },
    );
    window.customElements.define(
      "quantity-input",
      class extends window.HTMLElement {
        get lineItemKey() {
          return this.getAttribute("key");
        }
        connectedCallback() {
          this.addEventListener("change", (event) => {
            assert.equal(event.target, this.querySelector("input"));
            calls.push({
              kind: "quantity",
              owner: this,
              key: this.lineItemKey,
              quantity: Number(event.target.value),
              cart: this.cart,
            });
          });
        }
      },
    );
  }
  const owners = [
    ...document.querySelectorAll(
      "cart-sections, cart-remove-toggle, quantity-input",
    ),
  ];
  const listeners = new Set();
  owners.forEach((owner, index) => {
    owner.cart = structuredClone(initial);
    const add = owner.addEventListener.bind(owner);
    const remove = owner.removeEventListener.bind(owner);
    owner.addEventListener = (name, ...args) => {
      if (name.startsWith("cart:")) listeners.add(`${index}:${name}`);
      return add(name, ...args);
    };
    owner.removeEventListener = (name, ...args) => {
      if (name.startsWith("cart:")) listeners.delete(`${index}:${name}`);
      return remove(name, ...args);
    };
  });
  window.fetch = async (url, options) => {
    requests++;
    assert.equal(String(url), "https://hd-dev-single.myshopify.com/cart.js");
    assert.equal(
      options.method,
      undefined,
      "Roman never constructs a cart mutation",
    );
    assert.equal(options.credentials, "same-origin");
    return { ok: true, json: async () => structuredClone(initial) };
  };
  let deadline;
  window.setTimeout = (callback, delay) => {
    assert.equal(delay, 15000);
    deadline = callback;
    return 1;
  };
  window.clearTimeout = () => {
    deadline = undefined;
  };
  window.eval(
    `${bundle.outputFiles[0].text}\nwindow.RomanCartActions = RomanCartActions;`,
  );
  const controller = new window.AbortController();
  t.after(() => controller.abort());
  return {
    window,
    document,
    calls,
    controller,
    listeners,
    actions: window.RomanCartActions,
    owner: (tag, key = "123:a") =>
      [...document.querySelectorAll(tag)].find(
        (element) =>
          tag === "cart-sections" || element.getAttribute("key") === key,
      ),
    update: (owner, value) =>
      owner.dispatchEvent(
        new window.CustomEvent("cart:updated", {
          bubbles: true,
          composed: true,
          detail: value,
        }),
      ),
    timeout: () => deadline(),
    hasDeadline: () => deadline !== undefined,
    requests: () => requests,
    nativeSubmissions: () => nativeSubmissions,
    setInitial: (value) => {
      initial = value;
    },
    setClearPromise: (value) => {
      clearPromise = value;
    },
  };
}

test("removal delegates to the matching theme control and confirms the exact configured line", async (t) => {
  const linked = line("insurance:1", 1, {
    product_type: "Insurance",
    properties: { _insurance_group: "group-a" },
  });
  const env = setup(t, { items: [line("123:a"), line("123:b", 2), linked] });
  const action = env.actions.removeFromCart("123:a", env.controller.signal);
  await flush();
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].kind, "remove");
  assert.equal(env.calls[0].owner, env.owner("cart-remove-toggle"));
  assert.deepEqual(
    env.calls[0].cart.items.at(-1).properties,
    linked.properties,
  );
  assert.equal(env.nativeSubmissions(), 0);
  assert.equal(env.requests(), 1);
  env.update(env.calls[0].owner, cart([line("123:b", 2)]));
  const result = await action;
  assert.equal(result.status, "updated");
  assert.equal(result.cart.items[0].lineKey, "123:b");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes("properties"), false);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.hasDeadline(), false);
});

test("quantity uses the configured line's change workflow with the full linked-item context", async (t) => {
  const warranty = line("warranty:1", 2, {
    product_type: "Warranty",
    properties: { _warranty_group: "group-b" },
  });
  const env = setup(t, { items: [line("123:a"), line("123:b", 2), warranty] });
  const action = env.actions.setCartQuantity("123:b", 4, env.controller.signal);
  await flush();
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].kind, "quantity");
  assert.equal(env.calls[0].key, "123:b");
  assert.equal(env.calls[0].quantity, 4);
  assert.equal(env.calls[0].cart.items[2].key, warranty.key);
  const owner = env.calls[0].owner;
  let settled = false;
  action.then(() => {
    settled = true;
  });
  env.update(owner, cart([line("123:a", 4), line("123:b", 2), warranty]));
  env.update(
    owner.querySelector("input"),
    cart([line("123:a"), line("123:b", 4)]),
  );
  env.update(
    env.document.querySelector("app-provider"),
    cart([line("123:a"), line("123:b", 4)]),
  );
  env.update(owner, { items: [{ key: "123:b", quantity: 4 }] });
  await flush();
  assert.equal(
    settled,
    false,
    "different configured lines, event origins and invalid data cannot confirm success",
  );
  env.update(
    owner,
    cart([line("123:a"), line("123:b", 4), { ...warranty, quantity: 4 }]),
  );
  assert.equal((await action).status, "updated");
  assert.equal(env.listeners.size, 0);
});

test("clear invokes the public theme method once and requires a confirmed empty cart", async (t) => {
  const env = setup(t);
  const action = env.actions.clearCart(env.controller.signal);
  await flush();
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].kind, "clear");
  const owner = env.calls[0].owner;
  env.update(owner, cart([line("123:a")]));
  assert.equal(env.hasDeadline(), true);
  env.update(owner, cart([]));
  const result = await action;
  assert.equal(result.status, "updated");
  assert.equal(result.cart.itemCount, 0);
  assert.equal(env.hasDeadline(), false);
});

test("absent, uninitialized, inert, disabled and stale controls make no mutation", async (t) => {
  for (const state of [
    "missing",
    "uninitialized",
    "inert",
    "disabled",
    "disabled-fieldset",
    "stale",
  ]) {
    await t.test(state, async (t) => {
      const env = setup(t, { initialized: state !== "uninitialized" });
      const owner = env.owner("quantity-input");
      const input = owner.querySelector("input");
      if (state === "missing") owner.remove();
      if (state === "inert") owner.setAttribute("inert", "");
      if (state === "disabled") input.disabled = true;
      if (state === "disabled-fieldset") {
        const fieldset = env.document.createElement("fieldset");
        fieldset.disabled = true;
        input.replaceWith(fieldset);
        fieldset.append(input);
      }
      if (state === "stale") owner.cart.items.pop();
      const result = await env.actions.setCartQuantity(
        "123:a",
        3,
        env.controller.signal,
      );
      assert.equal(result.status, "needs_cart_page");
      assert.equal(env.calls.length, 0);
      assert.equal(input.value, "1");
      assert.equal(env.listeners.size, 0);
    });
  }
});

test("theme quantity constraints are checked without changing the live input", async (t) => {
  for (const state of ["min", "max", "step", "theme-min", "theme-max"]) {
    await t.test(state, async (t) => {
      const env = setup(t);
      const owner = env.owner("quantity-input");
      const input = owner.querySelector("input");
      if (state === "min") input.min = "5";
      if (state === "max") input.max = "2";
      if (state === "step") {
        input.min = "2";
        input.step = "2";
      }
      if (state === "theme-min") owner.min = 5;
      if (state === "theme-max") owner.max = 2;
      await assert.rejects(
        env.actions.setCartQuantity("123:a", 3, env.controller.signal),
        /allowed range/,
      );
      assert.equal(input.value, "1");
      assert.equal(env.calls.length, 0);
    });
  }
});

test("theme loading and concurrent actions prevent another submission", async (t) => {
  const env = setup(t);
  env.owner("quantity-input").shopifyCartLoading = true;
  await assert.rejects(
    env.actions.setCartQuantity("123:a", 3, env.controller.signal),
    /current cart update/,
  );
  env.owner("quantity-input").shopifyCartLoading = false;
  const action = env.actions.removeFromCart("123:a", env.controller.signal);
  await assert.rejects(
    env.actions.clearCart(env.controller.signal),
    /Another cart action/,
  );
  await flush();
  env.timeout();
  assert.equal((await action).status, "handed_off");
  assert.equal(env.calls.length, 1);
  assert.equal(env.listeners.size, 0);
});

test("clearing respects inert cart owners and removal respects disabled native controls", async (t) => {
  const env = setup(t);
  const owner = env.owner("cart-sections");
  owner.setAttribute("inert", "");
  assert.equal(
    (await env.actions.clearCart(env.controller.signal)).status,
    "needs_cart_page",
  );
  owner.removeAttribute("inert");
  env.owner("cart-remove-toggle").querySelector("button").disabled = true;
  assert.equal(
    (await env.actions.removeFromCart("123:a", env.controller.signal)).status,
    "needs_cart_page",
  );
  assert.equal(env.calls.length, 0);
  assert.equal(env.nativeSubmissions(), 0);
});

test("pre-action cancellation or a failed cart read cannot mutate the cart", async (t) => {
  const env = setup(t);
  env.controller.abort();
  await assert.rejects(env.actions.clearCart(env.controller.signal), {
    name: "AbortError",
  });
  assert.equal(env.requests(), 0);
  assert.equal(env.calls.length, 0);
  const fresh = setup(t);
  fresh.window.fetch = async () => {
    throw new Error("private transport failure");
  };
  await assert.rejects(
    fresh.actions.clearCart(fresh.controller.signal),
    /could not be completed/,
  );
  assert.equal(fresh.calls.length, 0);
});

test("cancellation while reading the baseline preserves the live quantity", async (t) => {
  const env = setup(t);
  let resolveRead;
  env.window.fetch = () =>
    new Promise((resolve) => {
      resolveRead = resolve;
    });
  const action = env.actions.setCartQuantity("123:a", 3, env.controller.signal);
  env.controller.abort();
  resolveRead({
    ok: true,
    json: async () => cart([line("123:a"), line("123:b", 2)]),
  });
  await assert.rejects(action, { name: "AbortError" });
  assert.equal(env.owner("quantity-input").querySelector("input").value, "1");
  assert.equal(env.calls.length, 0);
});

test("navigation during the cart read prevents a delayed theme action", async (t) => {
  const env = setup(t);
  let resolveRead;
  env.window.fetch = () =>
    new Promise((resolve) => {
      resolveRead = resolve;
    });
  const action = env.actions.clearCart(env.controller.signal);
  env.document.dispatchEvent(new env.window.Event("roman:navigation"));
  resolveRead({
    ok: true,
    json: async () => cart([line("123:a"), line("123:b", 2)]),
  });
  assert.equal((await action).status, "needs_cart_page");
  assert.equal(env.calls.length, 0);
});

test("abort, navigation and pagehide after submission stop observation without undoing or retrying", async (t) => {
  for (const reason of ["abort", "navigation", "pagehide"]) {
    await t.test(reason, async (t) => {
      const env = setup(t);
      let rejectTheme;
      env.setClearPromise(
        new Promise((_, reject) => {
          rejectTheme = reject;
        }),
      );
      const action = env.actions.clearCart(env.controller.signal);
      await flush();
      if (reason === "abort") env.controller.abort();
      if (reason === "navigation")
        env.document.dispatchEvent(new env.window.Event("roman:navigation"));
      if (reason === "pagehide")
        env.window.dispatchEvent(new env.window.Event("pagehide"));
      const result = await action;
      assert.equal(result.status, "handed_off");
      assert.match(result.message, /cannot undo/);
      assert.equal(env.calls.length, 1);
      assert.equal(env.listeners.size, 0);
      assert.equal(env.hasDeadline(), false);
      rejectTheme(new Error("late private theme error"));
      await flush();
    });
  }
});

test("theme failure events and rejected clear promises expose no raw response", async (t) => {
  for (const reason of ["event", "promise"]) {
    await t.test(reason, async (t) => {
      const env = setup(t);
      let rejectTheme;
      env.setClearPromise(
        new Promise((_, reject) => {
          rejectTheme = reject;
        }),
      );
      const action = env.actions.clearCart(env.controller.signal);
      const rejected = assert.rejects(
        action,
        (error) =>
          /could not confirm/.test(error.message) &&
          !error.message.includes("private"),
      );
      await flush();
      if (reason === "event")
        env.owner("cart-sections").dispatchEvent(
          new env.window.CustomEvent("cart:error", {
            detail: "private response",
          }),
        );
      else rejectTheme(new Error("private response"));
      await rejected;
      assert.equal(env.listeners.size, 0);
      assert.equal(env.hasDeadline(), false);
    });
  }
});

test("discount-related key changes are not guessed by variant ID", async (t) => {
  const env = setup(t);
  const action = env.actions.setCartQuantity("123:a", 3, env.controller.signal);
  await flush();
  env.update(
    env.owner("quantity-input"),
    cart([line("123:changed", 3), line("123:b", 2)]),
  );
  env.timeout();
  assert.equal((await action).status, "handed_off");
});

test("already satisfied quantities and empty carts need no theme submission", async (t) => {
  const env = setup(t);
  assert.equal(
    (await env.actions.setCartQuantity("123:a", 1, env.controller.signal))
      .status,
    "updated",
  );
  env.setInitial(cart([]));
  assert.equal(
    (await env.actions.clearCart(env.controller.signal)).status,
    "updated",
  );
  assert.equal(env.calls.length, 0);
});

test("invalid quantities and stale line keys are rejected before mutation", async (t) => {
  const env = setup(t);
  for (const quantity of [0, -1, 1.5, Infinity])
    await assert.rejects(
      env.actions.setCartQuantity("123:a", quantity, env.controller.signal),
      /positive whole-number/,
    );
  await assert.rejects(
    env.actions.removeFromCart("", env.controller.signal),
    /current lineKey/,
  );
  assert.equal(env.requests(), 0);
  await assert.rejects(
    env.actions.removeFromCart("123:missing", env.controller.signal),
    /no longer exists/,
  );
  assert.equal(env.calls.length, 0);
});
